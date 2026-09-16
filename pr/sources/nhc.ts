import { z } from "zod";

import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { parseFeed } from "../parse.ts";
import type { PulseSource } from "../source.ts";

const nhcStormSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  classification: z.string().optional(),
  intensity: z.string().optional(),
  latitudeNumeric: z.number().optional(),
  longitudeNumeric: z.number().optional(),
  movementDir: z.string().optional(),
  movementSpeed: z.number().optional(),
  pressure: z.number().optional(),
  lastUpdate: z.string().optional(),
  publicAdvisory: z.object({ url: z.string().optional() }).passthrough().optional(),
}).passthrough();

const nhcStormsSchema = z.object({
  activeStorms: z.array(nhcStormSchema).optional(),
}).passthrough();

const stormSeverity = (classification: string | undefined, intensity: number | undefined) => {
  const lower = (classification ?? "").toLowerCase();
  if (lower === "hu" && (intensity ?? 0) >= 3) return "emergency" as const;
  if (lower === "hu" || lower === "mh") return "warning" as const;
  if (lower === "ts" || lower === "ss") return "watch" as const;
  return "advisory" as const;
};

export const nhcStormsSource: PulseSource = {
  id: "nhc-storms",
  name: "National Hurricane Center",
  category: "weather",
  homepage: "https://www.nhc.noaa.gov/",
  collect: async (ctx) => {
    const parsed = nhcStormsSchema.parse(
      JSON.parse(await ctx.fetchText("https://www.nhc.noaa.gov/CurrentStorms.json", { label: "nhc.noaa.gov" })),
    );
    const storms = parsed.activeStorms ?? [];
    const signals: PrSignal[] = [];
    for (const storm of storms.slice(0, 24)) {
      const lat = storm.latitudeNumeric;
      const lon = storm.longitudeNumeric;
      const inTheater = lat !== undefined && lon !== undefined
        && lat >= 5 && lat <= 35 && lon >= -95 && lon <= -45;
      const name = storm.name ?? "Unnamed system";
      const kind = storm.classification === "TD" ? "Tropical Depression"
        : storm.classification === "TS" ? "Tropical Storm"
          : storm.classification === "HU" ? "Hurricane"
            : storm.classification === "MH" ? "Major Hurricane" : "Tropical system";
      const position = lat !== undefined && lon !== undefined
        ? ` at ${Math.abs(lat).toFixed(1)}°${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? "E" : "W"}`
        : "";
      const windsKt = storm.intensity === undefined ? undefined : Number.parseFloat(storm.intensity);
      signals.push({
        id: signalId("nhc", [storm.id ?? name]),
        source: "nhc-storms",
        sourceName: "National Hurricane Center",
        category: "weather",
        severity: inTheater ? stormSeverity(storm.classification, windsKt) : "info",
        title: `${kind} ${name}${position}`,
        summary: [
          windsKt !== undefined && Number.isFinite(windsKt) ? `Sustained winds ${windsKt.toString()} kt.` : "",
          storm.pressure !== undefined ? `Pressure ${storm.pressure.toString()} mb.` : "",
          storm.movementDir !== undefined && storm.movementSpeed !== undefined
            ? `Moving ${storm.movementDir} at ${storm.movementSpeed.toString()} kt.` : "",
          inTheater ? "Tracked inside the Atlantic-Caribbean theater relevant to Puerto Rico." : "Outside the Caribbean approach region; shown for awareness.",
        ].filter(Boolean).join(" "),
        url: storm.publicAdvisory?.url ?? "https://www.nhc.noaa.gov/",
        regions: inTheater ? ["atlantic", "caribbean"] : ["atlantic"],
        lang: "en",
        issuedAt: storm.lastUpdate,
        expiresAt: undefined,
        metrics: windsKt === undefined || !Number.isFinite(windsKt) ? undefined : { windsKt, pressureMb: storm.pressure ?? 0 },
      });
    }
    return signals;
  },
};

export const nhcOutlookSource: PulseSource = {
  id: "nhc-outlook",
  name: "NHC Atlantic outlook",
  category: "climate",
  homepage: "https://www.nhc.noaa.gov/gtwo.php",
  collect: async (ctx) => {
    const xml = await ctx.fetchText("https://www.nhc.noaa.gov/index-at.xml", {
      accept: "application/rss+xml, */*",
      label: "nhc.noaa.gov",
    });
    const items = parseFeed(xml, 8);
    return items
      .filter((item) => item.title.length > 0)
      .slice(0, 4)
      .map((item): PrSignal => ({
        id: signalId("nhc-two", [item.guid ?? item.link, item.publishedAt ?? ""]),
        source: "nhc-outlook",
        sourceName: "NHC Tropical Weather Outlook",
        category: "climate",
        severity: /\b(?:[5-9][0-9]|100)\s*percent/iu.test(item.summary) ? "watch" : "info",
        title: item.title.slice(0, 300),
        summary: item.summary.slice(0, 1200) || undefined,
        url: item.link === "" ? "https://www.nhc.noaa.gov/gtwo.php" : item.link,
        regions: ["atlantic", "caribbean"],
        lang: "en",
        issuedAt: item.publishedAt,
        expiresAt: undefined,
        metrics: undefined,
      }));
  },
};
