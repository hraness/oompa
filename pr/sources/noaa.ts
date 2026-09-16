import { z } from "zod";

import { signalId } from "../classify.ts";
import type { PrSignal } from "../model.ts";
import { htmlText } from "../parse.ts";
import type { PulseSource } from "../source.ts";

const coopsSchema = z.object({
  data: z.array(z.object({
    t: z.string().optional(),
    v: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const coopsPredictionsSchema = z.object({
  predictions: z.array(z.object({
    t: z.string().optional(),
    v: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

/** San Juan (La Puntilla) water level vs predicted astronomical tide. */
export const noaaCoopsSource: PulseSource = {
  id: "noaa-coops-sju",
  name: "NOAA tides — San Juan",
  category: "flood",
  homepage: "https://tidesandcurrents.noaa.gov/stationhome.html?id=9755371",
  collect: async (ctx) => {
    const [observedText, predictedText] = await Promise.all([
      ctx.fetchText(
        "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9755371&product=water_level&datum=MLLW&time_zone=gmt&units=metric&format=json&date=latest",
        { label: "tidesandcurrents.noaa.gov" },
      ),
      ctx.fetchText(
        "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=9755371&product=predictions&datum=MLLW&time_zone=gmt&units=metric&format=json&interval=h&date=latest",
        { label: "tidesandcurrents.noaa.gov" },
      ),
    ]);
    const observed = coopsSchema.parse(JSON.parse(observedText)).data ?? [];
    const predicted = coopsPredictionsSchema.parse(JSON.parse(predictedText)).predictions ?? [];
    const latest = observed.at(-1);
    const predictedRow = predicted.at(-1);
    if (latest === undefined || latest.v === undefined) return [];
    const level = Number.parseFloat(latest.v);
    const predictedValue = predictedRow?.v === undefined ? undefined : Number.parseFloat(predictedRow.v);
    if (!Number.isFinite(level)) return [];
    const residual = predictedValue !== undefined && Number.isFinite(predictedValue)
      ? level - predictedValue
      : undefined;
    const severity = residual !== undefined && residual > 0.6 ? "warning"
      : residual !== undefined && residual > 0.35 ? "advisory" : "info";
    return [{
      id: signalId("coops", ["9755371", latest.t ?? "", level.toFixed(3)]),
      source: "noaa-coops-sju",
      sourceName: "NOAA CO-OPS",
      category: "flood",
      severity,
      title: `San Juan water level ${level.toFixed(2)} m MLLW`,
      summary: residual === undefined
        ? "Latest observed water level at the San Juan (La Puntilla) station."
        : `Observed ${residual >= 0 ? "+" : ""}${residual.toFixed(2)} m above/below the astronomical prediction. Positive residuals during storms indicate surge.`,
      url: "https://tidesandcurrents.noaa.gov/stationhome.html?id=9755371",
      regions: ["san-juan-metro", "waters-north"],
      lang: "en",
      issuedAt: latest.t === undefined ? undefined : `${latest.t.replace(" ", "T")}:00Z`,
      expiresAt: undefined,
      metrics: residual === undefined ? { waterLevelM: level } : { waterLevelM: level, residualM: residual },
    }];
  },
};

const swpcAlertsSchema = z.array(z.object({
  product_id: z.string().optional(),
  issue_datetime: z.string().optional(),
  message: z.string().optional(),
}).passthrough());

export const swpcAlertsSource: PulseSource = {
  id: "swpc-alerts",
  name: "NOAA space weather",
  category: "climate",
  homepage: "https://www.swpc.noaa.gov/products/alerts-and-forecasts",
  collect: async (ctx) => {
    const alerts = swpcAlertsSchema.parse(JSON.parse(await ctx.fetchText(
      "https://services.swpc.noaa.gov/products/alerts.json",
      { label: "services.swpc.noaa.gov", maxBytes: 4 * 1024 * 1024 },
    )));
    const signals: PrSignal[] = [];
    for (const alert of alerts.slice(0, 60)) {
      const message = alert.message ?? "";
      const strong = /\b(?:G4|G5|S4|S5|R4|R5|X[2-9]|severe|extreme)\b/iu.test(message);
      if (!strong && !/\b(?:G3|R3|S3|warning)\b/iu.test(message)) continue;
      signals.push({
        id: signalId("swpc", [alert.product_id ?? "", alert.issue_datetime ?? ""]),
        source: "swpc-alerts",
        sourceName: "NOAA Space Weather Prediction Center",
        category: "climate",
        severity: strong ? "watch" : "advisory",
        title: `Space-weather ${strong ? "strong" : "elevated"} event (${alert.product_id ?? "SWPC"})`,
        summary: message.replaceAll(/\s+/gu, " ").slice(0, 1000),
        url: "https://www.swpc.noaa.gov/products/alerts-and-forecasts",
        regions: ["atlantic"],
        lang: "en",
        issuedAt: alert.issue_datetime,
        expiresAt: undefined,
        metrics: undefined,
      });
    }
    return signals.slice(0, 6);
  },
};

export const cpcEnsoSource: PulseSource = {
  id: "cpc-enso",
  name: "NOAA ENSO status",
  category: "climate",
  homepage: "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/",
  collect: async (ctx) => {
    const html = await ctx.fetchText(
      "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml",
      { label: "cpc.ncep.noaa.gov" },
    );
    const text = htmlText(html);
    const state = /El Niño Advisory/iu.test(text) ? "El Niño advisory in effect"
      : /La Niña Advisory/iu.test(text) ? "La Niña advisory in effect"
        : /El Niño Watch/iu.test(text) ? "El Niño watch"
          : /La Niña Watch/iu.test(text) ? "La Niña watch"
            : /El Niño Warning/iu.test(text) ? "El Niño warning"
              : /La Niña Warning/iu.test(text) ? "La Niña warning"
                : /ENSO-neutral/iu.test(text) ? "ENSO-neutral" : "ENSO status uncertain";
    const active = !state.startsWith("ENSO-neutral") && !state.endsWith("uncertain");
    const synoptic = text.match(/Synopsis[^.]{0,120}\.[^.]{0,400}\./u)?.[0]?.slice(0, 600);
    return [{
      id: signalId("cpc-enso", [state, (synoptic ?? "").slice(0, 80)]),
      source: "cpc-enso",
      sourceName: "NOAA Climate Prediction Center",
      category: "climate",
      severity: active ? "advisory" : "info",
      title: `ENSO: ${state}`,
      summary: synoptic ?? "Current ENSO status from the Climate Prediction Center diagnostic discussion.",
      url: "https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml",
      regions: ["atlantic", "caribbean", "islandwide"],
      lang: "en",
      issuedAt: ctx.now.toISOString(),
      expiresAt: undefined,
      metrics: undefined,
    }];
  },
};
