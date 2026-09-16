import { createHash } from "node:crypto";

import { enrichSignalsWithAi, resolvePulseAi, type PulseAiConfig } from "./ai.ts";
import { classifyText } from "./classify.ts";
import { pulseFetchJson, pulseFetchText, type PulseFetch } from "./http.ts";
import {
  prSignalSchema,
  severityRank,
  type PrSignal,
  type PrSnapshot,
  type SourceHealth,
} from "./model.ts";
import type { PulseSource, PulseSourceContext } from "./source.ts";

const SOURCE_TIME_BUDGET_MS = 45_000;

export interface CollectOptions {
  readonly sources: readonly PulseSource[];
  readonly fetchText?: PulseFetch;
  readonly fetchJson?: PulseSourceContext["fetchJson"];
  readonly now?: Date;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly ai?: PulseAiConfig | null | "auto";
  readonly sourceBudgetMs?: number;
  readonly onSource?: (health: SourceHealth) => void;
}

const withSourceBudget = async (
  source: PulseSource,
  context: PulseSourceContext,
  budgetMs: number,
): Promise<readonly PrSignal[]> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<readonly PrSignal[]>([
      source.collect(context),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => { reject(new Error(`Source ${source.id} exceeded ${(budgetMs / 1000).toFixed(0)}s budget.`)); },
          budgetMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const safeMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message.replaceAll(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_.-]{10,}\.[A-Za-z0-9_-]{20,}/gu, "[token]")
      .slice(0, 280);
  }
  return "Unknown source failure.";
};

/** Fill gaps left by adapters: severity bumps, regions from text, dedupe. */
const normalizeSignals = (signals: readonly PrSignal[]): PrSignal[] => {
  const seen = new Set<string>();
  const output: PrSignal[] = [];
  for (const signal of signals) {
    const classified = classifyText(signal.title, signal.summary ?? "");
    const merged = {
      ...signal,
      severity: severityRank(classified.severity) > severityRank(signal.severity)
        ? classified.severity
        : signal.severity,
      regions: signal.regions.length === 0
        ? (classified.regions.length > 0 ? [...classified.regions] : ["islandwide"])
        : signal.regions,
    };
    const parsed = prSignalSchema.safeParse(merged);
    if (!parsed.success || seen.has(parsed.data.id)) continue;
    seen.add(parsed.data.id);
    output.push(parsed.data);
  }
  output.sort((a, b) => {
    const bySeverity = severityRank(b.severity) - severityRank(a.severity);
    if (bySeverity !== 0) return bySeverity;
    const aTime = a.issuedAt === undefined ? 0 : Date.parse(a.issuedAt);
    const bTime = b.issuedAt === undefined ? 0 : Date.parse(b.issuedAt);
    return bTime - aTime;
  });
  return output.slice(0, 800);
};

const contentHash = (signals: readonly PrSignal[], brief: string): string => {
  const material = [...signals]
    .map((signal) => `${signal.id}${signal.severity}${signal.title}${signal.regions.join(",")}`)
    .sort()
    .join("\n") + `\n---brief---\n${brief}`;
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
};

const deriveMetrics = (signals: readonly PrSignal[]): Readonly<Record<string, number>> => {
  const metrics: Record<string, number> = {
    signalsActive: signals.length,
    emergencySignals: signals.filter((s) => s.severity === "emergency").length,
    warningSignals: signals.filter((s) => s.severity === "warning").length,
    watchSignals: signals.filter((s) => s.severity === "watch").length,
  };
  const islandTotal = signals.find((signal) => signal.id.startsWith("luma-") && signal.title.startsWith("Island total:"));
  if (islandTotal?.metrics?.["customersOut"] !== undefined) {
    metrics["customersOut"] = islandTotal.metrics["customersOut"];
  }
  const dayAgo = Date.now() - 86_400_000;
  metrics["quakes24h"] = signals.filter(
    (signal) => signal.source === "usgs-quakes"
      && signal.issuedAt !== undefined
      && Date.parse(signal.issuedAt) >= dayAgo,
  ).length;
  const residual = signals.find((signal) => signal.source === "noaa-coops-sju");
  if (residual?.metrics?.["residualM"] !== undefined) {
    metrics["sjuSurgeResidualM"] = Math.round(residual.metrics["residualM"] * 100) / 100;
  }
  return metrics;
};

export const collectSnapshot = async (options: CollectOptions): Promise<PrSnapshot> => {
  const now = options.now ?? new Date();
  const context: PulseSourceContext = {
    fetchText: options.fetchText ?? pulseFetchText,
    fetchJson: options.fetchJson ?? pulseFetchJson,
    now,
  };
  const budget = options.sourceBudgetMs ?? SOURCE_TIME_BUDGET_MS;
  const health: SourceHealth[] = [];
  const collected: PrSignal[] = [];

  await Promise.all(options.sources.map(async (source) => {
    const started = Date.now();
    try {
      const signals = await withSourceBudget(source, context, budget);
      const entry: SourceHealth = {
        id: source.id,
        name: source.name,
        homepage: source.homepage,
        category: source.category,
        ok: true,
        latencyMs: Math.max(0, Date.now() - started),
        signalCount: signals.length,
      };
      health.push(entry);
      options.onSource?.(entry);
      collected.push(...signals);
    } catch (error) {
      const entry: SourceHealth = {
        id: source.id,
        name: source.name,
        homepage: source.homepage,
        category: source.category,
        ok: false,
        latencyMs: Math.max(0, Date.now() - started),
        signalCount: 0,
        error: safeMessage(error),
      };
      health.push(entry);
      options.onSource?.(entry);
    }
  }));
  health.sort((a, b) => a.id.localeCompare(b.id));

  let signals = normalizeSignals(collected);

  const environment = options.environment ?? {};
  const aiConfig = options.ai === "auto" || options.ai === undefined
    ? resolvePulseAi(environment)
    : options.ai;
  let brief: PrSnapshot["brief"] = null;
  let aiStatus: PrSnapshot["aiStatus"] = "disabled";
  if (aiConfig !== null) {
    try {
      const enrichment = await enrichSignalsWithAi(signals, aiConfig, now.toISOString());
      signals = [...enrichment.signals];
      brief = enrichment.brief;
      aiStatus = "applied";
    } catch {
      aiStatus = "failed";
    }
  }

  return {
    schema: 1,
    generatedAt: now.toISOString(),
    contentHash: contentHash(signals, brief?.text ?? ""),
    signals,
    health,
    metrics: deriveMetrics(signals),
    brief,
    aiStatus,
  };
};
