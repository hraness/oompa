import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  prHistorySchema,
  prSnapshotSchema,
  type PrHistory,
  type PrSnapshot,
} from "./model.ts";
import { collectSnapshot } from "./pipeline.ts";
import { PULSE_SOURCES } from "./sources/index.ts";

const DATA_DIRECTORY = join("pr", "data");
const SNAPSHOT_PATH = join(DATA_DIRECTORY, "snapshot.json");
const HISTORY_PATH = join(DATA_DIRECTORY, "history.json");
const HISTORY_LIMIT = 6000;
const REFRESH_AFTER_MS = 4 * 3_600_000;

const readSnapshot = async (repositoryRoot: string): Promise<PrSnapshot | undefined> => {
  try {
    return prSnapshotSchema.parse(JSON.parse(await readFile(join(repositoryRoot, SNAPSHOT_PATH), "utf8")));
  } catch {
    return undefined;
  }
};

const readHistory = async (repositoryRoot: string): Promise<PrHistory> => {
  try {
    return prHistorySchema.parse(JSON.parse(await readFile(join(repositoryRoot, HISTORY_PATH), "utf8")));
  } catch {
    return { schema: 1, points: [] };
  }
};

const historyPoint = (snapshot: PrSnapshot) => ({
  ts: snapshot.generatedAt,
  signals: snapshot.signals.length,
  emergency: snapshot.metrics["emergencySignals"] ?? 0,
  warning: snapshot.metrics["warningSignals"] ?? 0,
  watch: snapshot.metrics["watchSignals"] ?? 0,
  customersOut: snapshot.metrics["customersOut"],
  quakes24h: snapshot.metrics["quakes24h"],
  unhealthySources: snapshot.health.filter((source) => !source.ok).length,
});

interface PulseOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly repositoryRoot: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

export interface PulseResult {
  readonly written: boolean;
  readonly reason: string;
  readonly snapshot: PrSnapshot;
}

export const runPulse = async (options: PulseOptions): Promise<PulseResult> => {
  const diagnostics = (line: string) => {
    process.stderr.write(`pr-pulse: ${line}\n`);
  };
  const snapshot = await collectSnapshot({
    sources: PULSE_SOURCES,
    environment: options.environment,
    ai: "auto",
    onSource: (health) => {
      diagnostics(`${health.ok ? "ok  " : "FAIL"} ${health.id} (${health.latencyMs.toString()}ms, ${health.signalCount.toString()} signals${health.error === undefined ? "" : `, ${health.error}`})`);
    },
  });
  diagnostics(`collected ${snapshot.signals.length.toString()} signals from ${PULSE_SOURCES.length.toString()} sources; ai=${snapshot.aiStatus}`);

  if (options.dryRun) return { written: false, reason: "dry-run", snapshot };

  const existing = await readSnapshot(options.repositoryRoot);
  const unchanged = existing !== undefined
    && existing.contentHash === snapshot.contentHash
    && Date.now() - Date.parse(existing.generatedAt) < REFRESH_AFTER_MS;
  if (unchanged && !options.force) {
    return { written: false, reason: "unchanged", snapshot };
  }

  const history = await readHistory(options.repositoryRoot);
  const points = [...history.points, historyPoint(snapshot)];
  const bounded: PrHistory = {
    schema: 1,
    points: points.slice(Math.max(0, points.length - HISTORY_LIMIT)),
  };
  const directory = join(options.repositoryRoot, DATA_DIRECTORY);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "snapshot.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  await writeFile(join(directory, "history.json"), `${JSON.stringify(bounded, null, 2)}\n`, "utf8");
  return { written: true, reason: existing === undefined ? "initial" : unchanged ? "stale" : "changed", snapshot };
};

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const result = await runPulse({
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    repositoryRoot: resolve(import.meta.dir, ".."),
    environment: process.env,
  });
  const summary = {
    written: result.written,
    reason: result.reason,
    generatedAt: result.snapshot.generatedAt,
    contentHash: result.snapshot.contentHash,
    signals: result.snapshot.signals.length,
    sourcesOk: result.snapshot.health.filter((source) => source.ok).length,
    sourcesFailed: result.snapshot.health.filter((source) => !source.ok).length,
    aiStatus: result.snapshot.aiStatus,
    metrics: result.snapshot.metrics,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
