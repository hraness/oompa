import { z } from "zod";

import { signalId } from "../classify.ts";
import type { PrRegion } from "../municipalities.ts";
import type { PrSignal } from "../model.ts";
import { htmlDocument } from "../parse.ts";
import type { PulseSource } from "../source.ts";

const lumaRegionSchema = z.object({
  name: z.string(),
  totalClients: z.number().optional(),
  totalClientsWithoutService: z.number().optional(),
  totalClientsWithService: z.number().optional(),
  totalClientsAffectedByPlannedOutage: z.number().optional(),
  totalClientsAffectedByLoadShed: z.number().optional(),
  percentageClientsWithoutService: z.number().optional(),
  percentageClientsWithService: z.number().optional(),
}).passthrough();

const lumaRegionsResponseSchema = z.object({
  regions: z.array(lumaRegionSchema),
}).passthrough();

const LUMA_REGION_MAP: Readonly<Record<string, readonly PrRegion[]>> = {
  Arecibo: ["northwest"],
  Bayamon: ["san-juan-metro", "north"],
  Bayamón: ["san-juan-metro", "north"],
  Caguas: ["central-east", "east"],
  Carolina: ["san-juan-metro", "northeast"],
  Mayaguez: ["west", "southwest"],
  Mayagüez: ["west", "southwest"],
  Ponce: ["south", "southeast"],
  "San Juan": ["san-juan-metro"],
};

export const lumaOutagesSource: PulseSource = {
  id: "luma-outages",
  name: "LUMA Energy outages",
  category: "power",
  homepage: "https://miluma.lumapr.com/outages/outageMap",
  collect: async (ctx) => {
    const parsed = lumaRegionsResponseSchema.parse(JSON.parse(await ctx.fetchText(
      "https://api.miluma.lumapr.com/miluma-outage-api/outage/regionsWithoutService",
      { label: "api.miluma.lumapr.com" },
    )));
    const signals: PrSignal[] = [];
    let totalOut = 0;
    let totalClients = 0;
    for (const region of parsed.regions.slice(0, 20)) {
      const out = region.totalClientsWithoutService ?? 0;
      const clients = region.totalClients ?? 0;
      totalOut += out;
      totalClients += clients;
      if (out < 200 && clients > 0 && (region.percentageClientsWithoutService ?? 0) < 0.5) continue;
      const pct = region.percentageClientsWithoutService
        ?? (clients > 0 ? (out / clients) * 100 : 0);
      const loadShed = (region.totalClientsAffectedByLoadShed ?? 0) > 0;
      const severity: PrSignal["severity"] = pct >= 20 || loadShed ? "emergency"
        : pct >= 10 ? "warning" : pct >= 5 ? "watch" : "advisory";
      signals.push({
        id: signalId("luma", [region.name, out.toString(), clients.toString()]),
        source: "luma-outages",
        sourceName: "LUMA Energy",
        category: "power",
        severity,
        title: `${region.name}: ${out.toLocaleString("en-US")} customers without power (${pct.toFixed(1)}%)`,
        summary: `${clients.toLocaleString("en-US")} customers tracked in the ${region.name} service region.${loadShed ? " Load shedding reported." : ""}${(region.totalClientsAffectedByPlannedOutage ?? 0) > 0 ? ` ${region.totalClientsAffectedByPlannedOutage?.toLocaleString("en-US")} under planned outage.` : ""}`,
        url: "https://miluma.lumapr.com/outages/outageMap",
        regions: [...(LUMA_REGION_MAP[region.name] ?? ["islandwide"])],
        lang: "en",
        issuedAt: ctx.now.toISOString(),
        expiresAt: undefined,
        metrics: { customersOut: out, customersTotal: clients, percentOut: pct },
      });
    }
    signals.push({
      id: signalId("luma", ["island-total", totalOut.toString(), totalClients.toString()]),
      source: "luma-outages",
      sourceName: "LUMA Energy",
      category: "power",
      severity: totalClients > 0 && totalOut / totalClients >= 0.2 ? "emergency"
        : totalClients > 0 && totalOut / totalClients >= 0.1 ? "warning"
          : totalOut >= 10_000 ? "watch" : "info",
      title: `Island total: ${totalOut.toLocaleString("en-US")} customers without power`,
      summary: `Across ${parsed.regions.length.toString()} LUMA service regions, ${totalClients.toLocaleString("en-US")} customers tracked.`,
      url: "https://miluma.lumapr.com/outages/outageMap",
      regions: ["islandwide"],
      lang: "en",
      issuedAt: ctx.now.toISOString(),
      expiresAt: undefined,
      metrics: { customersOut: totalOut, customersTotal: totalClients },
    });
    return signals;
  },
};

export const lumaNotablesSource: PulseSource = {
  id: "luma-notables",
  name: "LUMA notable outages",
  category: "power",
  homepage: "https://lumapr.com/notable-outages/?lang=en",
  collect: async (ctx) => {
    const html = await ctx.fetchText("https://lumapr.com/notable-outages/?lang=en", {
      accept: "text/html",
      label: "lumapr.com",
    });
    const { document } = htmlDocument(html);
    const items = [...document.querySelectorAll(
      "article, .notable-outage, .entry-content li, .elementor-post",
    )];
    const signals: PrSignal[] = [];
    for (const item of items.slice(0, 30)) {
      const titleEl = item.querySelector("h1,h2,h3,h4,a,strong");
      const title = (titleEl?.textContent ?? item.textContent).replaceAll(/\s+/gu, " ").trim().slice(0, 300);
      if (title.length < 8) continue;
      const link = item.querySelector("a")?.getAttribute("href") ?? "";
      signals.push({
        id: signalId("luma-notes", [title]),
        source: "luma-notables",
        sourceName: "LUMA Energy",
        category: "power",
        severity: "advisory",
        title,
        summary: item.textContent.replaceAll(/\s+/gu, " ").trim().slice(0, 800) || undefined,
        url: link.startsWith("http") ? link : "https://lumapr.com/notable-outages/?lang=en",
        regions: ["islandwide"],
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
