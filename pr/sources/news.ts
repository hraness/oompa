import { classifyText, signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { parseFeed } from "../parse.ts";
import type { PulseSource, PulseSourceContext } from "../source.ts";

const CRISIS_TERMS = /\b(?:apag[oó]n|apagones|aver[ií]a|luma\b|acueducto|aaa\b|agua|interrupci[oó]n|terremoto|temblor|sismo|tsunami|maremoto|hurac[aá]n|tormenta|onda tropical|inundaci[oó]n|riada|crecida|deslizamiento|incendio forestal|ola de calor|calor extrem|dengue|epidemia|salud|ferry|lancha|aeropuerto|puerto|gasolina|combustible|escasez|desabastecimiento|nmead|emergencia|evacuaci[oó]n|refugio|fema|sargazo|sargassum|polvo del sahara|generaci[oó]n|subestaci[oó]n|sin servicio|guardacostas|coast guard|rescate|interdic|migrante|meteorolog|snm\b|alerta|aviso|vigilancia|condici[oó]n|sequ[ií]a|embalse|racionamiento|power|outage|earthquake|hurricane|flood|storm|water)\w*/iu;

interface NewsFeed {
  readonly id: string;
  readonly name: string;
  readonly url: string;
}

export const LOCAL_FEEDS: readonly NewsFeed[] = [
  { id: "el-nuevo-dia", name: "El Nuevo Día", url: "https://www.elnuevodia.com/arc/outboundfeeds/rss/?outputType=xml" },
  { id: "primera-hora", name: "Primera Hora", url: "https://www.primerahora.com/arc/outboundfeeds/rss/?outputType=xml" },
  { id: "noticel", name: "NotiCel", url: "https://noticel.com/feed/" },
  { id: "teleonce", name: "TeleOnce", url: "https://www.teleonce.com/feed/" },
  { id: "cpi", name: "Centro de Periodismo Investigativo", url: "https://periodismoinvestigativo.com/feed/" },
  { id: "el-vocero", name: "El Vocero", url: "https://www.elvocero.com/arc/outboundfeeds/rss/?outputType=xml" },
];

const collectLocalFeed = (feed: NewsFeed) => async (ctx: PulseSourceContext): Promise<readonly PrSignal[]> => {
  const xml = await ctx.fetchText(feed.url, {
    accept: "application/rss+xml, application/atom+xml, */*",
    label: new URL(feed.url).hostname,
  });
  const items = parseFeed(xml, 50);
  const cutoff = ctx.now.getTime() - 4 * 86_400_000;
  const signals: PrSignal[] = [];
  for (const item of items) {
    if (item.title.length < 8) continue;
    if (item.publishedAt !== undefined && Date.parse(item.publishedAt) < cutoff) continue;
    const text = `${item.title} ${item.summary}`;
    if (!CRISIS_TERMS.test(text)) continue;
    const classified = classifyText(item.title, item.summary);
    signals.push({
      id: signalId(feed.id, [item.guid ?? item.link, item.title.slice(0, 60)]),
      source: `news-${feed.id}`,
      sourceName: feed.name,
      category: classified.category ?? "news",
      severity: classified.severity,
      title: item.title.slice(0, 300),
      summary: item.summary.slice(0, 1200) || undefined,
      url: item.link === "" ? feed.url : item.link,
      regions: classified.regions.length > 0 ? [...classified.regions] : ["islandwide"],
      lang: "es",
      issuedAt: item.publishedAt,
      expiresAt: undefined,
      metrics: undefined,
    });
    if (signals.length >= 15) break;
  }
  return signals;
};

export const localNewsSources: readonly PulseSource[] = LOCAL_FEEDS.map((feed) => ({
  id: `news-${feed.id}`,
  name: `${feed.name} (local news)`,
  category: "news" as const,
  homepage: new URL(feed.url).origin,
  collect: collectLocalFeed(feed),
}));

interface NewsQuery {
  readonly id: string;
  readonly query: string;
}

const GOOGLE_NEWS_QUERIES: readonly NewsQuery[] = [
  { id: "apagon", query: 'apagón OR avería OR luma "puerto rico"' },
  { id: "agua", query: '(interrupción OR acueducto OR AAA OR racionamiento) agua "puerto rico"' },
  { id: "sismo", query: '(terremoto OR temblor OR sismo) "puerto rico"' },
  { id: "tiempo", query: '(huracán OR tormenta OR "onda tropical" OR inundación) "puerto rico"' },
  { id: "ferry", query: '(ferry OR lancha) (vieques OR culebra OR ceiba)' },
  { id: "combustible", query: '(gasolina OR combustible OR diesel OR "planta de gas") "puerto rico"' },
  { id: "salud", query: '(dengue OR epidemia OR salud OR hantavirus OR leptospirosis) "puerto rico"' },
  { id: "emergencias", query: '(NMEAD OR "negociado de emergencias" OR "estado de emergencia") "puerto rico"' },
  { id: "clima", query: '(sequía OR embalse OR sargazo OR "polvo del sahara") "puerto rico"' },
  { id: "guardacostas", query: '(guardacostas OR "coast guard") (san juan OR "puerto rico" OR "mona passage")' },
  { id: "telecom", query: '(internet OR celular OR telecomunicaciones OR fibra) "puerto rico" (caído OR avería OR outage OR falla)' },
];

export const googleNewsSource: PulseSource = {
  id: "google-news-queries",
  name: "Google News crisis queries",
  category: "news",
  homepage: "https://news.google.com/",
  collect: async (ctx) => {
    const signals: PrSignal[] = [];
    for (const entry of GOOGLE_NEWS_QUERIES) {
      const url = `https://news.google.com/rss/search?q=${encodeURIComponent(entry.query)}&hl=es-419&gl=PR&ceid=PR:es-419`;
      const xml = await ctx.fetchText(url, {
        accept: "application/rss+xml, */*",
        headers: { "user-agent": "Mozilla/5.0 (compatible; hraness-pr-pulse/1.0)" },
        label: "news.google.com",
      });
      const items = parseFeed(xml, 12);
      const cutoff = ctx.now.getTime() - 3 * 86_400_000;
      for (const item of items.slice(0, 6)) {
        if (item.title.length < 8) continue;
        if (item.publishedAt !== undefined && Date.parse(item.publishedAt) < cutoff) continue;
        const classified = classifyText(item.title, item.summary);
        signals.push({
          id: signalId("gnews", [entry.id, item.guid ?? item.link, item.title.slice(0, 60)]),
          source: `gnews-${entry.id}`,
          sourceName: `Google News — ${entry.id}`,
          category: classified.category ?? "news",
          severity: classified.severity,
          title: item.title.slice(0, 300),
          summary: item.summary.slice(0, 1000) || undefined,
          url: item.link === "" ? "https://news.google.com/" : item.link,
          regions: classified.regions.length > 0 ? [...classified.regions] : ["islandwide"],
          lang: "es",
          issuedAt: item.publishedAt,
          expiresAt: undefined,
          metrics: undefined,
          clusterKey: `gnews-${entry.id}`,
        });
      }
    }
    return signals;
  },
};
