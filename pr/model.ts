import { z } from "zod";

export const PR_CATEGORIES = [
  "power",
  "water",
  "weather",
  "seismic",
  "tsunami",
  "flood",
  "health",
  "transport",
  "comms",
  "fuel",
  "supply",
  "regional",
  "climate",
  "news",
  "official",
] as const;
export type PrCategory = (typeof PR_CATEGORIES)[number];
export const prCategorySchema = z.enum(PR_CATEGORIES);

export const PR_SEVERITIES = ["info", "advisory", "watch", "warning", "emergency"] as const;
export type PrSeverity = (typeof PR_SEVERITIES)[number];
export const prSeveritySchema = z.enum(PR_SEVERITIES);

export const severityRank = (severity: PrSeverity): number =>
  PR_SEVERITIES.indexOf(severity);

const isoTimestamp = z.string().min(4).max(64).regex(
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}/u,
  "timestamps must be ISO-8601",
);

const regionSlug = z.string().min(2).max(48).regex(/^[a-z0-9-]+$/u);

export const prSignalSchema = z.object({
  id: z.string().min(8).max(80),
  source: z.string().min(2).max(48),
  sourceName: z.string().min(1).max(160),
  category: prCategorySchema,
  severity: prSeveritySchema,
  title: z.string().min(1).max(500),
  titleEn: z.string().max(500).optional(),
  summary: z.string().max(4000).optional(),
  summaryEn: z.string().max(4000).optional(),
  url: z.string().url().max(2048).optional(),
  regions: z.array(regionSlug).max(40),
  lang: z.enum(["es", "en"]),
  issuedAt: isoTimestamp.optional(),
  expiresAt: isoTimestamp.optional(),
  metrics: z.record(z.string().max(48), z.number()).optional(),
  clusterKey: z.string().max(120).optional(),
}).strict();
export type PrSignal = z.infer<typeof prSignalSchema>;

export const sourceHealthSchema = z.object({
  id: z.string().min(2).max(48),
  name: z.string().min(1).max(160),
  homepage: z.string().url().max(2048),
  category: prCategorySchema,
  ok: z.boolean(),
  latencyMs: z.number().int().min(0).max(120_000),
  signalCount: z.number().int().min(0).max(10_000),
  error: z.string().max(300).optional(),
}).strict();
export type SourceHealth = z.infer<typeof sourceHealthSchema>;

export const prBriefSchema = z.object({
  text: z.string().min(1).max(4000),
  textEs: z.string().max(4000).optional(),
  provider: z.string().max(48),
  model: z.string().max(96),
  generatedAt: isoTimestamp,
}).strict();
export type PrBrief = z.infer<typeof prBriefSchema>;

export const prSnapshotSchema = z.object({
  schema: z.literal(1),
  generatedAt: isoTimestamp,
  contentHash: z.string().regex(/^[a-f0-9]{16}$/u),
  signals: z.array(prSignalSchema).max(2000),
  health: z.array(sourceHealthSchema).max(200),
  metrics: z.record(z.string().max(64), z.number()),
  brief: prBriefSchema.nullable(),
  aiStatus: z.enum(["disabled", "applied", "failed"]),
}).strict();
export type PrSnapshot = z.infer<typeof prSnapshotSchema>;

export const prHistoryPointSchema = z.object({
  ts: isoTimestamp,
  signals: z.number().int().min(0),
  emergency: z.number().int().min(0),
  warning: z.number().int().min(0),
  watch: z.number().int().min(0),
  customersOut: z.number().min(0).optional(),
  quakes24h: z.number().int().min(0).optional(),
  unhealthySources: z.number().int().min(0),
}).strict();
export type PrHistoryPoint = z.infer<typeof prHistoryPointSchema>;

export const prHistorySchema = z.object({
  schema: z.literal(1),
  points: z.array(prHistoryPointSchema).max(6000),
}).strict();
export type PrHistory = z.infer<typeof prHistorySchema>;

export const emptyPrSnapshot = (generatedAt: string): PrSnapshot => ({
  schema: 1,
  generatedAt,
  contentHash: "0000000000000000",
  signals: [],
  health: [],
  metrics: {},
  brief: null,
  aiStatus: "disabled",
});
