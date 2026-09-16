import { z } from "zod";

import { signalId } from "../classify.ts";
import { regionsForText, type PrRegion } from "../municipalities.ts";
import type { PrSignal } from "../model.ts";
import type { PulseSource } from "../source.ts";

const quakeSchema = z.object({
  id: z.string(),
  properties: z.object({
    mag: z.number().nullable(),
    place: z.string().nullable(),
    time: z.number(),
    updated: z.number().optional(),
    tsunami: z.number().optional(),
    type: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    felt: z.number().nullable().optional(),
    alert: z.string().nullable().optional(),
  }).passthrough(),
  geometry: z.object({ coordinates: z.array(z.number()).optional() }).passthrough().optional(),
}).passthrough();

const quakeFeedSchema = z.object({
  features: z.array(quakeSchema),
}).passthrough();

const quakeSeverity = (mag: number, tsunami: number | undefined, felt: number | undefined) => {
  if (tsunami === 1) return "warning" as const;
  if (mag >= 6) return "emergency" as const;
  if (mag >= 5) return "warning" as const;
  if (mag >= 4 || (felt ?? 0) >= 100) return "advisory" as const;
  return "info" as const;
};

export const usgsQuakesSource: PulseSource = {
  id: "usgs-quakes",
  name: "USGS earthquakes",
  category: "seismic",
  homepage: "https://earthquake.usgs.gov/earthquakes/map/?extent=15.5,-69.5&extent=20.5,-63",
  collect: async (ctx) => {
    const params = new URLSearchParams({
      format: "geojson",
      minlatitude: "16.5",
      maxlatitude: "20.5",
      minlongitude: "-69.5",
      maxlongitude: "-63.5",
      minmagnitude: "2.5",
      orderby: "time",
      limit: "60",
    });
    const parsed = quakeFeedSchema.parse(JSON.parse(await ctx.fetchText(
      `https://earthquake.usgs.gov/fdsnws/event/1/query?${params.toString()}`,
      { label: "earthquake.usgs.gov" },
    )));
    const signals: PrSignal[] = [];
    for (const feature of parsed.features.slice(0, 50)) {
      const mag = feature.properties.mag ?? 0;
      const place = feature.properties.place ?? "Puerto Rico region";
      const time = new Date(feature.properties.time);
      if (Number.isNaN(time.getTime())) continue;
      if (feature.properties.type !== undefined && feature.properties.type !== "earthquake") continue;
      const felt = feature.properties.felt ?? 0;
      signals.push({
        id: signalId("usgs", [feature.id]),
        source: "usgs-quakes",
        sourceName: "U.S. Geological Survey",
        category: "seismic",
        severity: quakeSeverity(mag, feature.properties.tsunami, feature.properties.felt ?? undefined),
        title: `M${mag.toFixed(1)} — ${place}`,
        summary: [
          `Depth ${((feature.geometry?.coordinates ?? [])[2] ?? 0).toFixed(1)} km.`,
          felt > 0 ? `${felt.toString()} felt reports.` : "",
          feature.properties.tsunami === 1 ? "USGS tsunami flag set for this event." : "",
          feature.properties.alert !== null && feature.properties.alert !== undefined
            ? `PAGER alert level: ${feature.properties.alert}.` : "",
        ].filter((part) => part.length > 0).join(" "),
        url: feature.properties.url ?? "https://earthquake.usgs.gov/",
        regions: regionsForText(place).length > 0 ? [...regionsForText(place)] : ["offshore"],
        lang: "en",
        issuedAt: time.toISOString(),
        expiresAt: undefined,
        metrics: { magnitude: mag, felt },
      });
    }
    return signals;
  },
};

const nwisValueSchema = z.object({
  name: z.string().optional(),
  value: z.object({
    siteName: z.string().optional(),
    value: z.string().optional(),
    dateTime: z.string().optional(),
  }).passthrough().optional(),
  sourceInfo: z.object({
    siteName: z.string().optional(),
    siteCode: z.array(z.object({ value: z.string().optional() }).passthrough()).optional(),
    geoLocation: z.object({
      geogLocation: z.object({ latitude: z.number().optional(), longitude: z.number().optional() }).passthrough().optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  values: z.array(z.object({ value: z.array(z.object({ value: z.string().optional(), dateTime: z.string().optional() }).passthrough()).optional() }).passthrough()).optional(),
}).passthrough();

const nwisResponseSchema = z.object({
  value: z.object({
    timeSeries: z.array(nwisValueSchema),
  }).passthrough(),
}).passthrough();

const FLOOD_WATCHED_RIVERS: Readonly<Record<string, PrRegion>> = {
  "RIO GRANDE DE LOIZA": "northeast",
  "RIO DE LA PLATA": "north",
  "RIO CAGUAS": "central-east",
  "RIO DE ANASCO": "west",
  "RIO PORTUGUES": "south",
  "RIO GUANAJIBO": "west",
  "RIO DE JUNCOS": "east",
  "RIO CAMUY": "northwest",
  "RIO COAMO": "south",
  "RIO JACAGUAS": "south",
};

export const usgsRiversSource: PulseSource = {
  id: "usgs-rivers",
  name: "USGS river gauges",
  category: "flood",
  homepage: "https://waterwatch.usgs.gov/?m=real&r=pr",
  collect: async (ctx) => {
    const parsed = nwisResponseSchema.parse(JSON.parse(await ctx.fetchText(
      "https://waterservices.usgs.gov/nwis/iv/?format=json&stateCd=pr&parameterCd=00065&siteStatus=active",
      { label: "waterservices.usgs.gov" },
    )));
    const series = parsed.value.timeSeries;
    const readings: { name: string; feet: number; region: PrRegion }[] = [];
    for (const entry of series.slice(0, 400)) {
      const siteName = entry.sourceInfo?.siteName ?? "";
      const valueText = entry.values?.[0]?.value?.[0]?.value;
      const feet = valueText === undefined ? Number.NaN : Number.parseFloat(valueText);
      if (!Number.isFinite(feet) || feet < 0) continue;
      const upper = siteName.toUpperCase();
      const region = Object.entries(FLOOD_WATCHED_RIVERS).find(([name]) => upper.includes(name))?.[1]
        ?? (regionsForText(siteName)[0] ?? "islandwide");
      readings.push({ name: siteName, feet, region });
    }
    readings.sort((a, b) => b.feet - a.feet);
    const top = readings.slice(0, 12);
    return [
      {
        id: signalId("usgs-rivers", ["gauges", readings.length.toString(), top.map((r) => `${r.name}:${r.feet.toFixed(1)}`).join(",")]),
        source: "usgs-rivers",
        sourceName: "USGS WaterWatch",
        category: "flood",
        severity: "info",
        title: `${readings.length.toString()} river gauges reporting across Puerto Rico`,
        summary: top.length === 0 ? "No gage-height readings returned." : `Highest current gage heights: ${top.slice(0, 6).map((r) => `${r.name} ${r.feet.toFixed(2)} ft`).join("; ")}.`,
        url: "https://waterwatch.usgs.gov/?m=real&r=pr",
        regions: ["islandwide"],
        lang: "en",
        issuedAt: ctx.now.toISOString(),
        expiresAt: undefined,
        metrics: { gaugesReporting: readings.length, highestGageFt: top[0]?.feet ?? 0 },
      },
      ...readings
        .filter((r) => r.feet >= 15)
        .slice(0, 8)
        .map((r): PrSignal => ({
          id: signalId("usgs-rivers", ["high", r.name, r.feet.toFixed(2)]),
          source: "usgs-rivers",
          sourceName: "USGS WaterWatch",
          category: "flood",
          severity: "advisory",
          title: `${r.name} at ${r.feet.toFixed(2)} ft gage height`,
          summary: "Elevated river level. Compare against NWS flood products for the same basin.",
          url: "https://waterwatch.usgs.gov/?m=real&r=pr",
          regions: [r.region],
          lang: "en",
          issuedAt: ctx.now.toISOString(),
          expiresAt: undefined,
          metrics: { gageFeet: r.feet },
        })),
    ];
  },
};
