import { z } from "zod";

import { classifyText, signalId } from "../classify.ts";
import type { PrCategory, PrSignal } from "../model.ts";
import type { PulseSource } from "../source.ts";

const gdeltResponseSchema = z.object({
  articles: z.array(z.object({
    url: z.string().optional(),
    title: z.string().optional(),
    seendate: z.string().optional(),
    socialimage: z.string().optional(),
    domain: z.string().optional(),
    language: z.string().optional(),
    sourcecountry: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

interface GdeltQuery {
  readonly id: string;
  readonly label: string;
  readonly query: string;
  readonly category: PrCategory;
  readonly regions: readonly string[];
}

const QUERIES: readonly GdeltQuery[] = [
  { id: "power", label: "grid", query: '"puerto rico" (apagon OR "power outage" OR blackout OR averia OR luma)', category: "power", regions: ["islandwide"] },
  { id: "water", label: "water", query: '"puerto rico" (acueducto OR "water service" OR sequia OR drought OR embalse OR racionamiento)', category: "water", regions: ["islandwide"] },
  { id: "seismic", label: "seismic", query: '"puerto rico" (terremoto OR temblor OR earthquake OR tsunami)', category: "seismic", regions: ["islandwide"] },
  { id: "fuel", label: "fuel", query: '"puerto rico" (gasolina OR combustible OR diesel OR "fuel shortage" OR desabastecimiento)', category: "fuel", regions: ["islandwide"] },
  { id: "supply", label: "supply", query: '"puerto rico" (port OR puerto OR shipping OR cargo OR "supply chain" OR importacion OR ferry)', category: "supply", regions: ["islandwide"] },
  { id: "cuba", label: "cuba grid", query: 'cuba (apagon OR blackout OR "electric grid" OR termoelectrica OR una OR "power deficit")', category: "regional", regions: ["caribbean"] },
  { id: "venezuela", label: "venezuela oil", query: 'venezuela (petroleo OR oil OR tanker OR sanctions OR sanciones OR pdvsa OR crude)', category: "regional", regions: ["caribbean"] },
  { id: "migration", label: "mona passage", query: '("mona passage" OR "pasaje de la mona" OR haiti OR "dominican republic") (migrant OR migrante OR interdict OR vessel OR yola)', category: "regional", regions: ["mona-passage", "caribbean"] },
  { id: "environment", label: "sargassum/dust", query: '(caribbean OR "puerto rico") (sargassum OR sargazo OR "saharan dust" OR "polvo del sahara")', category: "climate", regions: ["caribbean", "islandwide"] },
  { id: "health", label: "health", query: '"puerto rico" (dengue OR epidemic OR epidemia OR outbreak OR arboviral OR leptospirosis)', category: "health", regions: ["islandwide"] },
  { id: "telecom", label: "telecom", query: '"puerto rico" (internet OR celular OR telecom OR fibra OR "cell service" OR liberty OR claro)', category: "comms", regions: ["islandwide"] },
  { id: "storms", label: "caribbean storms", query: '(caribbean OR "puerto rico" OR "lesser antilles") (hurricane OR tormenta OR "tropical storm" OR flooding OR inundacion)', category: "weather", regions: ["caribbean", "islandwide"] },
];

const gdeltDate = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})?/u.exec(value.trim());
  if (match === null) return undefined;
  const [, year, month, day, hour, minute, second = "00"] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
};

/** GDELT DOC 2.0 artlist queries: regional and thematic news volume. */
export const gdeltSignalsSource: PulseSource = {
  id: "gdelt-queries",
  name: "GDELT news radar",
  category: "regional",
  homepage: "https://www.gdeltproject.org/",
  collect: async (ctx) => {
    // GDELT is slow and rate-limits; queries run in small batches and each
    // failure is tolerated so a partial radar still lands in the snapshot.
    const perQuery = await Promise.all(QUERIES.map(async (entry) => {
      try {
        const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(entry.query)}&mode=artlist&maxrecords=12&format=json&timespan=2d&sort=hybridrel`;
        const parsed = gdeltResponseSchema.parse(JSON.parse(await ctx.fetchText(url, {
          label: "api.gdeltproject.org",
          timeoutMs: 10_000,
        })));
        const signals: PrSignal[] = [];
        for (const article of (parsed.articles ?? []).slice(0, 8)) {
          if (article.title === undefined || article.url === undefined) continue;
          const classified = classifyText(article.title, "");
          signals.push({
            id: signalId("gdelt", [entry.id, article.url]),
            source: "gdelt-queries",
            sourceName: `GDELT — ${entry.label}`,
            category: entry.category,
            severity: classified.severity,
            title: article.title.slice(0, 300),
            summary: `Via ${article.domain ?? "unknown outlet"}${article.sourcecountry !== undefined ? ` (${article.sourcecountry})` : ""}.`,
            url: article.url.slice(0, 2048),
            regions: [...entry.regions],
            lang: (article.language ?? "").toLowerCase().startsWith("spanish") ? "es" : "en",
            issuedAt: gdeltDate(article.seendate),
            expiresAt: undefined,
            metrics: undefined,
            clusterKey: `gdelt-${entry.id}`,
          });
        }
        return signals;
      } catch {
        return [] as PrSignal[];
      }
    }));
    return perQuery.flat();
  },
};
