import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { parseFeed } from "../parse.ts";
import type { PulseSource } from "../source.ts";

export const uscgSectorSanJuanSource: PulseSource = {
  id: "uscg-san-juan",
  name: "U.S. Coast Guard Sector San Juan",
  category: "transport",
  homepage: "https://www.dvidshub.net/unit/PADETSanJuan",
  collect: async (ctx) => {
    const xml = await ctx.fetchText("https://www.dvidshub.net/rss/unit/PADETSanJuan", {
      accept: "application/rss+xml, */*",
      label: "dvidshub.net",
      maxBytes: 2 * 1024 * 1024,
    });
    const items = parseFeed(xml, 40);
    const cutoff = ctx.now.getTime() - 60 * 86_400_000;
    return items
      .filter((item) => item.publishedAt === undefined || Date.parse(item.publishedAt) >= cutoff)
      .slice(0, 20)
      .map((item): PrSignal => {
        const text = `${item.title} ${item.summary}`;
        const rescue = /\b(?:rescu|medevac|search|suspends|interdict|repatriat|grounding|collision|port condition|x-ray|yankee|zulu|whiskey)\w*/iu.test(text);
        return {
          id: signalId("uscg", [item.guid ?? item.link]),
          source: "uscg-san-juan",
          sourceName: "U.S. Coast Guard Sector San Juan",
          category: /\b(?:interdict|migrant|repatriat|migrante)\w*/iu.test(text) ? "regional" : "transport",
          severity: rescue ? "advisory" : "info",
          title: item.title.slice(0, 300),
          summary: item.summary.slice(0, 1200) || undefined,
          url: item.link === "" ? "https://www.dvidshub.net/unit/PADETSanJuan" : item.link,
          regions: ["mona-passage", "islandwide"],
          lang: "en",
          issuedAt: item.publishedAt,
          expiresAt: undefined,
          metrics: undefined,
        };
      });
  },
};
