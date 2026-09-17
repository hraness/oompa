import { generateObject } from "ai";
import { z } from "zod";

import { PR_REGIONS } from "./municipalities.ts";
import { PR_SEVERITIES, severityRank, type PrBrief, type PrSignal } from "./model.ts";

export interface PulseAiConfig {
  readonly provider: "anthropic" | "openai";
  readonly model: string;
}

const DEFAULT_MODELS: Readonly<Record<PulseAiConfig["provider"], string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5-mini",
};

/**
 * AI enrichment is strictly opt-in: no provider configured means a fully
 * deterministic snapshot. Keys are read from the environment, never logged,
 * and failures degrade to the deterministic baseline.
 */
export const resolvePulseAi = (
  environment: Readonly<Record<string, string | undefined>>,
): PulseAiConfig | null => {
  const requested = (environment.PR_PULSE_AI_PROVIDER ?? "auto").trim().toLowerCase();
  const model = environment.PR_PULSE_AI_MODEL?.trim();
  const anthropicKey = environment.ANTHROPIC_API_KEY?.trim();
  const openaiKey = environment.OPENAI_API_KEY?.trim();
  if (requested === "none") return null;
  if (requested === "anthropic" || (requested === "auto" && anthropicKey !== undefined && anthropicKey.length > 0)) {
    return anthropicKey === undefined || anthropicKey.length === 0
      ? null
      : { provider: "anthropic", model: model ?? DEFAULT_MODELS.anthropic };
  }
  if (requested === "openai" || (requested === "auto" && openaiKey !== undefined && openaiKey.length > 0)) {
    return openaiKey === undefined || openaiKey.length === 0
      ? null
      : { provider: "openai", model: model ?? DEFAULT_MODELS.openai };
  }
  return null;
};

const aiItemSchema = z.object({
  id: z.string(),
  severity: z.enum(PR_SEVERITIES).optional(),
  regions: z.array(z.string()).optional(),
  titleEn: z.string().optional(),
  summaryEn: z.string().optional(),
  clusterKey: z.string().optional(),
}).strict();

const aiResponseSchema = z.object({
  items: z.array(aiItemSchema).max(80),
  brief: z.string().max(3000),
  briefEs: z.string().max(3000).optional(),
}).strict();

const MAX_ENRICHED_SIGNALS = 64;

const compactSignals = (signals: readonly PrSignal[]) =>
  signals
    .slice(0, MAX_ENRICHED_SIGNALS)
    .map((signal) => ({
      id: signal.id,
      source: signal.sourceName,
      category: signal.category,
      severity: signal.severity,
      lang: signal.lang,
      title: signal.title.slice(0, 220),
      summary: (signal.summary ?? "").slice(0, 300),
      regions: signal.regions,
      issuedAt: signal.issuedAt,
    }));

const buildModel = async (config: PulseAiConfig) => {
  if (config.provider === "anthropic") {
    const { anthropic } = await import("@ai-sdk/anthropic");
    return anthropic(config.model);
  }
  const { openai } = await import("@ai-sdk/openai");
  return openai(config.model);
};

export interface AiEnrichmentResult {
  readonly signals: readonly PrSignal[];
  readonly brief: PrBrief | null;
}

/**
 * One bounded enrichment pass: translate Spanish headlines, refine regions and
 * severity, cluster duplicates, and write a short situation brief. Anything the
 * model returns is re-validated against the same zod schema as source data.
 */
export const enrichSignalsWithAi = async (
  inputSignals: readonly PrSignal[],
  config: PulseAiConfig,
  generatedAt: string,
): Promise<AiEnrichmentResult> => {
  const candidates = compactSignals(inputSignals);
  if (candidates.length === 0) return { signals: inputSignals, brief: null };
  const model = await buildModel(config);
  const { object } = await generateObject({
    model,
    schema: aiResponseSchema,
    schemaName: "pr_pulse_enrichment",
    schemaDescription:
      "Emergency-signal enrichment for a Puerto Rico situational-awareness dashboard.",
    maxOutputTokens: 6000,
    abortSignal: AbortSignal.timeout(120_000),
    prompt: [
      "You are an OSINT analyst maintaining a Puerto Rico emergency dashboard.",
      "Given JSON signal entries, return JSON with:",
      "- items[]: for each entry id, optionally refine `severity` (one of " + PR_SEVERITIES.join(", ") + "),",
      "  refine `regions` (only values from: " + PR_REGIONS.join(", ") + "),",
      "  translate `titleEn`/`summaryEn` into clear English when `lang` is \"es\",",
      "  and set a `clusterKey` like \"power-outage-arecibo\" that groups duplicate coverage of the same event.",
      "- brief: 2-4 sentences summarizing the island's current situation for a resident.",
      "- briefEs: the same brief in Spanish.",
      "Only include an id in items[] when you actually change or add a field.",
      "Signals JSON:",
      JSON.stringify(candidates),
    ].join("\n"),
  });
  const parsed = aiResponseSchema.parse(object);
  const byId = new Map(parsed.items.map((item) => [item.id, item]));
  const regionSet = new Set<string>(PR_REGIONS);
  const signals = inputSignals.map((signal): PrSignal => {
    const item = byId.get(signal.id);
    if (item === undefined) return signal;
    const regions = (item.regions ?? [])
      .filter((region) => regionSet.has(region))
      .slice(0, 40);
    return {
      ...signal,
      severity: item.severity !== undefined && severityRank(item.severity) >= severityRank(signal.severity)
        ? item.severity
        : signal.severity,
      ...(item.titleEn !== undefined && item.titleEn.trim().length > 0 ? { titleEn: item.titleEn.slice(0, 500) } : {}),
      ...(item.summaryEn !== undefined && item.summaryEn.trim().length > 0 ? { summaryEn: item.summaryEn.slice(0, 4000) } : {}),
      ...(regions.length > 0 ? { regions } : {}),
      ...(item.clusterKey !== undefined && item.clusterKey.trim().length > 0 ? { clusterKey: item.clusterKey.slice(0, 120) } : {}),
    };
  });
  const brief: PrBrief = {
    text: parsed.brief,
    ...(parsed.briefEs !== undefined && parsed.briefEs.trim().length > 0 ? { textEs: parsed.briefEs } : {}),
    provider: config.provider,
    model: config.model,
    generatedAt,
  };
  return { signals, brief };
};
