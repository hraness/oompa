import { z } from "zod";

import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import type { PulseSource } from "../source.ts";

const iodaSeriesSchema = z.object({
  data: z.array(z.array(z.object({
    datasource: z.string().optional(),
    values: z.array(z.number().nullable()).optional(),
  }).passthrough())),
}).passthrough();

const IODA_SOURCES = ["bgp", "ping-slash24", "merit-nt"] as const;

/** Internet Outage Detection and Analysis (Georgia Tech) signals for PR. */
export const iodaPrSource: PulseSource = {
  id: "ioda-pr",
  name: "IODA connectivity",
  category: "comms",
  homepage: "https://ioda.inetintel.cc.gatech.edu/country/PR",
  collect: async (ctx) => {
    const until = Math.floor(ctx.now.getTime() / 1000);
    const from = until - 3 * 86_400;
    const signals: PrSignal[] = [];
    for (const datasource of IODA_SOURCES) {
      const parsed = iodaSeriesSchema.parse(JSON.parse(await ctx.fetchText(
        `https://api.ioda.inetintel.cc.gatech.edu/v2/signals/raw/country/PR?datasource=${datasource}&maxPoints=240&from=${from.toString()}&until=${until.toString()}`,
        { label: "api.ioda.inetintel.cc.gatech.edu" },
      )));
      const values = (parsed.data[0]?.[0]?.values ?? []).filter(
        (value): value is number => value !== null && Number.isFinite(value),
      );
      if (values.length < 12) continue;
      const recent = values.slice(-12);
      const baseline = values.slice(0, -24);
      if (baseline.length < 24) continue;
      const mean = baseline.reduce((sum, value) => sum + value, 0) / baseline.length;
      const current = recent.reduce((sum, value) => sum + value, 0) / recent.length;
      if (mean <= 0) continue;
      const drop = (mean - current) / mean;
      const severity = drop >= 0.5 ? "warning" : drop >= 0.25 ? "watch" : drop >= 0.1 ? "advisory" : "info";
      const label = datasource === "bgp" ? "BGP routing" : datasource === "ping-slash24" ? "active probing" : "network telescope";
      signals.push({
        id: signalId("ioda", [datasource, Math.round(drop * 1000).toString()]),
        source: "ioda-pr",
        sourceName: "Georgia Tech IODA",
        category: "comms",
        severity,
        title: `Internet ${label} signal ${drop >= 0 ? "down" : "up"} ${(Math.abs(drop) * 100).toFixed(0)}% vs 3-day baseline`,
        summary: `IODA ${datasource} telemetry for Puerto Rico. Large drops correlate with island-wide connectivity loss (power, fiber, or telecom failures).`,
        url: "https://ioda.inetintel.cc.gatech.edu/country/PR",
        regions: ["islandwide"],
        lang: "en",
        issuedAt: ctx.now.toISOString(),
        expiresAt: undefined,
        metrics: { dropPct: Math.round(drop * 1000) / 10, current, baseline: Math.round(mean) },
      });
    }
    return signals;
  },
};
