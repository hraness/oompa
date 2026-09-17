import { generateObject } from "ai";
import { z } from "zod";

import { PR_REGIONS } from "./municipalities.ts";
import { PR_SEVERITIES, severityRank, type PrBrief, type PrSignal } from "./model.ts";

export interface PulseAiConfig {
  readonly provider: "anthropic" | "openai" | "vercel-ai-gateway";
  readonly model: string;
  readonly apiKey?: string;
}

const DEFAULT_MODELS: Readonly<Record<PulseAiConfig["provider"], string>> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5-mini",
  "vercel-ai-gateway": "anthropic/claude-haiku-4-5",
};

const GATEWAY_BASE_URL = "https://ai-gateway.vercel.sh/v4/ai";

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
  const gatewayKey = environment.AI_GATEWAY_API_KEY?.trim();
  const anthropicKey = environment.ANTHROPIC_API_KEY?.trim();
  const openaiKey = environment.OPENAI_API_KEY?.trim();
  if (requested === "none") return null;
  if (
    requested === "gateway" || requested === "vercel-ai-gateway"
    || (requested === "auto" && gatewayKey !== undefined && gatewayKey.length > 0)
  ) {
    return gatewayKey === undefined || gatewayKey.length === 0
      ? null
      : { provider: "vercel-ai-gateway", model: model ?? DEFAULT_MODELS["vercel-ai-gateway"], apiKey: gatewayKey };
  }
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
  titleEs: z.string().optional(),
  summaryEs: z.string().optional(),
  clusterKey: z.string().optional(),
  relevance: z.enum(["relevant", "marginal", "noise"]).optional(),
}).strict();

const aiResponseSchema = z.object({
  items: z.array(aiItemSchema).max(96),
  brief: z.string().max(3000),
  briefEs: z.string().max(3000).optional(),
}).strict();

const MAX_ENRICHED_SIGNALS = 96;

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
  if (config.provider === "vercel-ai-gateway") {
    const { createGateway } = await import("@ai-sdk/gateway");
    if (config.apiKey === undefined) throw new Error("vercel-ai-gateway requires an api key");
    return createGateway({ apiKey: config.apiKey, baseURL: GATEWAY_BASE_URL })(config.model);
  }
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
    maxOutputTokens: 16000,
    abortSignal: AbortSignal.timeout(120_000),
    prompt: [
      "You are an OSINT analyst maintaining a Puerto Rico emergency dashboard.",
      "Given JSON signal entries, return JSON with:",
      "- items[]: exactly one entry for every input id.",
      "  When `lang` is \"en\": always set `titleEs`, and `summaryEs` when a summary exists,",
      "  in clear Puerto Rican Spanish. When `lang` is \"es\": always set `titleEn`, and",
      "  `summaryEn` when a summary exists, in clear English.",
      "  Set `relevance` to \"noise\" for stale, duplicate, off-topic, or trivial items a",
      "  resident does not need, \"marginal\" for borderline items; omit it otherwise.",
      "  Optionally refine `severity` (one of " + PR_SEVERITIES.join(", ") + ") and `regions`",
      "  (only values from: " + PR_REGIONS.join(", ") + "), and set a `clusterKey` like",
      "  \"power-outage-arecibo\" grouping duplicate coverage of the same event.",
      "- brief: 2-4 sentences summarizing the island's current situation for a resident.",
      "- briefEs: the same brief in Spanish.",
      "Translations stay factual: keep proper nouns, numbers, and place names exact; never add claims.",
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
    // Relevance can only demote, and never on warning-or-higher signals: the
    // board hides "noise", so an AI misclassification must not sink an alert.
    const nextSeverity = item.severity !== undefined && severityRank(item.severity) >= severityRank(signal.severity)
      ? item.severity
      : signal.severity;
    const relevance = item.relevance !== undefined && severityRank(nextSeverity) < severityRank("warning")
      ? item.relevance
      : undefined;
    return {
      ...signal,
      severity: nextSeverity,
      ...(item.titleEn !== undefined && item.titleEn.trim().length > 0 ? { titleEn: item.titleEn.slice(0, 500) } : {}),
      ...(item.summaryEn !== undefined && item.summaryEn.trim().length > 0 ? { summaryEn: item.summaryEn.slice(0, 4000) } : {}),
      ...(item.titleEs !== undefined && item.titleEs.trim().length > 0 ? { titleEs: item.titleEs.slice(0, 500) } : {}),
      ...(item.summaryEs !== undefined && item.summaryEs.trim().length > 0 ? { summaryEs: item.summaryEs.slice(0, 4000) } : {}),
      ...(regions.length > 0 ? { regions } : {}),
      ...(item.clusterKey !== undefined && item.clusterKey.trim().length > 0 ? { clusterKey: item.clusterKey.slice(0, 120) } : {}),
      ...(relevance !== undefined ? { relevance } : {}),
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
