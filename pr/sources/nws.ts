import { z } from "zod";

import { classifyText, signalId } from "../classify.ts";
import { regionsForText, regionsForUgc, type PrRegion } from "../municipalities.ts";
import type { PrCategory, PrSeverity, PrSignal } from "../model.ts";
import type { PulseSource } from "../source.ts";

const capSeverity: Readonly<Record<string, PrSeverity>> = {
  Extreme: "emergency",
  Severe: "warning",
  Moderate: "watch",
  Minor: "advisory",
  Unknown: "info",
};

const nwsAlertSchema = z.object({
  id: z.string(),
  properties: z.object({
    event: z.string(),
    severity: z.string().optional(),
    certainty: z.string().optional(),
    urgency: z.string().optional(),
    headline: z.string().optional(),
    description: z.string().optional(),
    areaDesc: z.string().optional(),
    onset: z.string().optional(),
    expires: z.string().optional(),
    ends: z.string().optional(),
    sent: z.string().optional(),
    senderName: z.string().optional(),
    geocode: z.object({ UGC: z.array(z.string()).optional() }).passthrough().optional(),
  }).passthrough(),
}).passthrough();

const nwsAlertsResponseSchema = z.object({
  features: z.array(nwsAlertSchema),
}).passthrough();

const eventCategory = (event: string): PrCategory => {
  const lower = event.toLowerCase();
  if (lower.includes("tsunami")) return "tsunami";
  if (lower.includes("flood") || lower.includes("hydrolog")) return "flood";
  return "weather";
};

const eventSeverity = (event: string, cap: string | undefined): PrSeverity => {
  const lower = event.toLowerCase();
  if (lower.includes("emergency")) return "emergency";
  if (lower.includes("warning")) return "warning";
  if (lower.includes("watch")) return "watch";
  if (lower.includes("advisory") || lower.includes("statement")) return "advisory";
  return capSeverity[cap ?? ""] ?? "info";
};

const alertRegions = (ugc: readonly string[] | undefined, areaDesc: string | undefined): PrRegion[] => {
  const fromCodes = regionsForUgc(ugc ?? []);
  const fromText = regionsForText(areaDesc ?? "");
  const merged = new Set<PrRegion>([...fromCodes, ...fromText]);
  if (merged.size === 0) merged.add("islandwide");
  return [...merged];
};

const MARINE_ZONES = [
  "AMZ711", "AMZ712", "AMZ716", "AMZ723", "AMZ726",
  "AMZ733", "AMZ735", "AMZ741", "AMZ742", "AMZ745",
] as const;

const alertsFor = async (
  ctx: Parameters<PulseSource["collect"]>[0],
  area: "PR" | "VI",
): Promise<readonly PrSignal[]> => {
  const text = await ctx.fetchText(
    `https://api.weather.gov/alerts/active?area=${area}`,
    { accept: "application/geo+json", label: "api.weather.gov" },
  );
  const parsed = nwsAlertsResponseSchema.parse(JSON.parse(text));
  return parsed.features.slice(0, 200).map((feature): PrSignal => {
    const { properties } = feature;
    const severity = eventSeverity(properties.event, properties.severity);
    const description = (properties.description ?? "").replaceAll(/\s+/gu, " ").slice(0, 1500);
    const classify = classifyText(`${properties.event} ${properties.headline ?? ""}`, description);
    return {
      id: signalId("nws", [feature.id]),
      source: `nws-alerts-${area.toLowerCase()}`,
      sourceName: `National Weather Service (${area === "PR" ? "San Juan" : "San Juan/USVI"})`,
      category: eventCategory(properties.event),
      severity: rankHigher(severity, classify.severity),
      title: properties.headline ?? properties.event,
      summary: description === "" ? undefined : description,
      url: `https://alerts.weather.gov/search?id=${encodeURIComponent(feature.id)}`,
      regions: alertRegions(properties.geocode?.UGC, properties.areaDesc),
      lang: "en",
      issuedAt: properties.onset ?? properties.sent,
      expiresAt: properties.expires ?? properties.ends,
      metrics: undefined,
    };
  });
};

const rankHigher = (a: PrSeverity, b: PrSeverity): PrSeverity => {
  const rank = { info: 0, advisory: 1, watch: 2, warning: 3, emergency: 4 } as const;
  return rank[b] > rank[a] ? b : a;
};

const marineAlerts = async (
  ctx: Parameters<PulseSource["collect"]>[0],
): Promise<readonly PrSignal[]> => {
  const text = await ctx.fetchText(
    `https://api.weather.gov/alerts/active?zone=${MARINE_ZONES.join(",")}`,
    { accept: "application/geo+json", label: "api.weather.gov" },
  );
  const parsed = nwsAlertsResponseSchema.parse(JSON.parse(text));
  return parsed.features.slice(0, 100).map((feature): PrSignal => {
    const { properties } = feature;
    return {
      id: signalId("nws", [feature.id]),
      source: "nws-alerts-marine",
      sourceName: "National Weather Service (marine)",
      category: eventCategory(properties.event),
      severity: eventSeverity(properties.event, properties.severity),
      title: properties.headline ?? properties.event,
      summary: (properties.description ?? "").replaceAll(/\s+/gu, " ").slice(0, 1500) || undefined,
      url: `https://alerts.weather.gov/search?id=${encodeURIComponent(feature.id)}`,
      regions: alertRegions(properties.geocode?.UGC, properties.areaDesc),
      lang: "en",
      issuedAt: properties.onset ?? properties.sent,
      expiresAt: properties.expires ?? properties.ends,
      metrics: undefined,
    };
  });
};

export const nwsPrAlertsSource: PulseSource = {
  id: "nws-alerts-pr",
  name: "NWS San Juan alerts",
  category: "weather",
  homepage: "https://www.weather.gov/sju/",
  collect: async (ctx) => alertsFor(ctx, "PR"),
};

export const nwsViAlertsSource: PulseSource = {
  id: "nws-alerts-vi",
  name: "NWS alerts (USVI)",
  category: "weather",
  homepage: "https://www.weather.gov/sju/",
  collect: async (ctx) => alertsFor(ctx, "VI"),
};

export const nwsMarineAlertsSource: PulseSource = {
  id: "nws-alerts-marine",
  name: "NWS marine alerts",
  category: "weather",
  homepage: "https://www.weather.gov/sju/marine",
  collect: marineAlerts,
};

const nwsProductListSchema = z.object({
  "@graph": z.array(z.object({
    id: z.string().optional(),
    "@id": z.string().optional(),
    issuanceTime: z.string().optional(),
    productCode: z.string().optional(),
    productName: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const nwsProductSchema = z.object({
  productText: z.string().optional(),
  issuanceTime: z.string().optional(),
  productName: z.string().optional(),
}).passthrough();

const NWS_PRODUCT_TYPES = [
  { code: "HWO", label: "Hazardous Weather Outlook" },
  { code: "AFD", label: "Area Forecast Discussion" },
  { code: "NOW", label: "Short-Term Forecast" },
] as const;

export const nwsSjuProductsSource: PulseSource = {
  id: "nws-sju-products",
  name: "NWS San Juan products",
  category: "weather",
  homepage: "https://www.weather.gov/sju/",
  collect: async (ctx) => {
    const signals: PrSignal[] = [];
    for (const product of NWS_PRODUCT_TYPES) {
      const listText = await ctx.fetchText(
        `https://api.weather.gov/products/types/${product.code}/locations/SJU`,
        { label: "api.weather.gov" },
      );
      const list = nwsProductListSchema.parse(JSON.parse(listText));
      const latest = list["@graph"]?.[0];
      const id = latest?.["@id"];
      if (latest === undefined || id === undefined) continue;
      const detail = nwsProductSchema.parse(JSON.parse(await ctx.fetchText(id, { label: "api.weather.gov" })));
      const text = (detail.productText ?? "").replaceAll(/\r\n|\r/gu, "\n").trim();
      if (text.length === 0) continue;
      const body = text.replaceAll(/\n{2,}/gu, "\n\n").slice(0, 1800);
      signals.push({
        id: signalId("nws-products", [id]),
        source: "nws-sju-products",
        sourceName: "National Weather Service (San Juan office)",
        category: "weather",
        severity: classifyText(`${product.label} Puerto Rico`, body).severity,
        title: `NWS San Juan ${product.label}`,
        summary: body,
        url: `https://forecast.weather.gov/product.php?site=SJU&issuedby=SJU&product=${product.code}&format=CI&version=1&glossary=0`,
        regions: ["islandwide"],
        lang: "en",
        issuedAt: detail.issuanceTime ?? latest.issuanceTime,
        expiresAt: undefined,
        metrics: undefined,
      });
    }
    return signals;
  },
};
