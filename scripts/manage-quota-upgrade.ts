import { isAbsolute, resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import { emptyQuotaUpgradeCorruptionCounts, quotaUpgradeCorruptionReasons, QUOTA_CATEGORIES, USER_QUOTA_RESOURCES, SERVICE_TOTAL_QUOTA } from "../convex/quota";
import { createBoundedAuthorityFetch } from "./bounded-authority-fetch";
import {
  BoundedProcessInvocationGuard,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
} from "./bounded-process";
import { buildConvexChildEnvironment, runCommand, type CommandRunner } from "./configure-hosted-sync";
import { parseConvexTarget, parseConvexTargetArguments, verifyConvexDefaultTarget, type ConvexTarget } from "./convex-target";
import { HostedDeployFilesystemCleanupError, hostedOperationConvexCliPath, prepareHostedOperationSource, type HostedOperationSourceBinding } from "./deploy-hosted-sync";
import {
  canonicalDigest, convexTargetEvidenceSchema, parseDeployEvidenceFile, readProtectedJson,
  ReleaseEvidenceError, runtimeReleaseAttestationSchema, withSelfDigest, writeProtectedJsonNoReplace,
  type DeployEvidence, type RuntimeReleaseAttestation,
} from "./release-evidence";
import { assertHostedOperatorSource } from "./verify-app-source-launcher";

const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const commit = z.string().regex(/^[0-9a-f]{40}$/u);
const pageSize = 8;
const maximumPages = Math.ceil(SERVICE_TOTAL_QUOTA.identities / pageSize) + 1;
const count = z.number().int().min(0).max(pageSize);
const page = z.object({ schemaVersion: z.literal(2), continueCursor: z.string().max(4096), isDone: z.boolean(), scanned: count });

export const quotaUpgradeAuditPageSchema = page.extend({
  legacy: count, unmarkedCurrent: count, incompleteEmptyMemory: count, current: count, corrupt: count,
}).strict().superRefine((value, context) => {
  if (value.legacy + value.unmarkedCurrent + value.incompleteEmptyMemory + value.current + value.corrupt !== value.scanned) {
    context.addIssue({ code: "custom", message: "quota_upgrade_counts_invalid" });
  }
});

const missingShapeSchema = z.strictObject({
  marker: z.enum(["current", "unmarked"]),
  missingCategories: z.array(z.enum(QUOTA_CATEGORIES)).max(QUOTA_CATEGORIES.length),
  missingResources: z.array(z.enum(USER_QUOTA_RESOURCES)).max(USER_QUOTA_RESOURCES.length),
  memoryCategory: z.enum(["absent", "zero", "nonzero"]),
  memoryResource: z.enum(["absent", "zero", "nonzero"]),
}).superRefine((value, context) => {
  const orderedCategories = QUOTA_CATEGORIES.filter((category) => value.missingCategories.includes(category));
  const orderedResources = USER_QUOTA_RESOURCES.filter((resource) => value.missingResources.includes(resource));
  if (JSON.stringify(value.missingCategories) !== JSON.stringify(orderedCategories)
    || JSON.stringify(value.missingResources) !== JSON.stringify(orderedResources)
    || value.missingCategories.length + value.missingResources.length === 0
    || value.missingCategories.includes("identity")
    || (value.missingCategories.every((category) => category === "memory")
      && value.missingResources.every((resource) => resource === "memory_space")
      && value.memoryCategory !== "nonzero" && value.memoryResource !== "nonzero")
    || value.missingCategories.includes("memory") !== (value.memoryCategory === "absent")
    || value.missingResources.includes("memory_space") !== (value.memoryResource === "absent")) {
    context.addIssue({ code: "custom", message: "quota_upgrade_shape_invalid" });
  }
});
export const quotaUpgradeDiagnosticPageSchema = page.extend({
  legacy: count, unmarkedCurrent: count, incompleteEmptyMemory: count, current: count, corrupt: count,
  reasons: z.record(z.enum(quotaUpgradeCorruptionReasons), count),
  missingShapes: z.array(z.strictObject({ shape: missingShapeSchema, count: count.min(1) })).max(pageSize),
}).strict().superRefine((value, context) => {
  if (value.legacy + value.unmarkedCurrent + value.incompleteEmptyMemory + value.current + value.corrupt !== value.scanned
    || Object.values(value.reasons).reduce((total, amount) => total + amount, 0) !== value.corrupt
    || value.missingShapes.reduce((total, entry) => total + entry.count, 0) !== value.reasons.schema_shape
    || value.missingShapes.some((entry, index) => index > 0
      && JSON.stringify(value.missingShapes[index - 1]?.shape) >= JSON.stringify(entry.shape))) {
    context.addIssue({ code: "custom", message: "quota_upgrade_diagnostic_counts_invalid" });
  }
});

export const quotaUpgradeMutationPageSchema = page.extend({ current: count, changed: count, upgraded: count, marked: count, repairedMemory: count })
  .strict().superRefine((value, context) => {
    if (value.current + value.changed !== value.scanned
      || value.upgraded + value.repairedMemory > value.changed
      || value.marked > value.changed || value.marked < value.changed - value.repairedMemory) {
      context.addIssue({ code: "custom", message: "quota_upgrade_counts_invalid" });
    }
  });

const operationBinding = z.object({
  candidateDeployDigest: digest,
  predecessorDeployDigest: digest,
  runtimeAttestation: runtimeReleaseAttestationSchema,
  sourceCommit: commit,
  target: convexTargetEvidenceSchema,
  targetDigest: digest,
});
export const quotaUpgradeIntentSchema = operationBinding.extend({
  kind: z.literal("quota-schema-upgrade-intent"), schemaVersion: z.literal(2), repairPolicy: z.literal("empty-memory-authority-v1"), quotaSchemaVersion: z.literal(2), selfDigest: digest,
}).strict();
export const quotaUpgradeReceiptSchema = operationBinding.extend({
  kind: z.literal("quota-schema-upgrade-receipt"), schemaVersion: z.literal(2), repairPolicy: z.literal("empty-memory-authority-v1"), quotaSchemaVersion: z.literal(2),
  intentDigest: digest, selfDigest: digest, verificationPasses: z.literal(2), state: z.literal("complete"),
  activationAuthorized: z.literal(false),
}).strict();

type FailureCode = "usage_invalid" | "source_changed" | "candidate_invalid" | "binding_changed" | "provider_result_invalid"
  | "quota_upgrade_corrupt" | "quota_upgrade_debt_remaining" | "pagination_invalid" | "evidence_invalid";
export class QuotaUpgradeError extends Error {
  constructor(readonly code: FailureCode) { super(`Hosted quota upgrade refused (${code}).`); this.name = "QuotaUpgradeError"; }
}
const refuse = (code: FailureCode): never => { throw new QuotaUpgradeError(code); };
const same = (left: unknown, right: unknown): boolean => canonicalDigest(left) === canonicalDigest(right);
const absolute = (value: string | undefined): string => {
  if (value === undefined || value.length > 4096 || !isAbsolute(value) || resolve(value) !== value) return refuse("usage_invalid");
  return value;
};

export type QuotaUpgradeArguments = Readonly<{
  action: "status" | "diagnose" | "repair"; sourceCommit: string; deployEvidencePath: string;
  previousDeployEvidencePath: string; evidencePath?: string; target: ConvexTarget;
}>;

export function parseQuotaUpgradeArguments(args: readonly string[]): QuotaUpgradeArguments {
  let targetArgs: ReturnType<typeof parseConvexTargetArguments>;
  try { targetArgs = parseConvexTargetArguments(args); } catch { return refuse("usage_invalid"); }
  const [action, ...rest] = targetArgs.otherArguments;
  if (action !== "status" && action !== "diagnose" && action !== "repair") return refuse("usage_invalid");
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const names = ["--source-commit", "--deploy-evidence", "--previous-deploy-evidence", "--evidence-path"];
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (name === "--execute" || name === "--acknowledge-forward-only") {
      if (flags.has(name)) return refuse("usage_invalid");
      flags.add(name); continue;
    }
    if (name === undefined || !names.includes(name) || values.has(name)) return refuse("usage_invalid");
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) return refuse("usage_invalid");
    values.set(name, value);
  }
  const sourceCommit = commit.safeParse(values.get("--source-commit"));
  if (!sourceCommit.success) return refuse("usage_invalid");
  const deployEvidencePath = absolute(values.get("--deploy-evidence"));
  const previousDeployEvidencePath = absolute(values.get("--previous-deploy-evidence"));
  const evidencePath = values.has("--evidence-path") ? absolute(values.get("--evidence-path")) : undefined;
  if ((action !== "repair" && (flags.size !== 0 || evidencePath !== undefined))
    || (action === "repair" && (flags.size !== 2 || evidencePath === undefined))) return refuse("usage_invalid");
  const paths = [deployEvidencePath, previousDeployEvidencePath, ...(evidencePath === undefined ? [] : [evidencePath, `${evidencePath}.intent`])];
  if (paths.some((path) => path.length > 4096) || new Set(paths).size !== paths.length) return refuse("usage_invalid");
  return { action, sourceCommit: sourceCommit.data, deployEvidencePath, previousDeployEvidencePath,
    ...(evidencePath === undefined ? {} : { evidencePath }), target: targetArgs.target };
}

type Audit = Readonly<{ scanned: number; legacy: number; unmarkedCurrent: number; incompleteEmptyMemory: number; current: number; corrupt: number }>;
type Mutation = Readonly<{ scanned: number; current: number; changed: number; upgraded: number; marked: number; repairedMemory: number }>;
type PageArguments = Readonly<{
  expectedRuntimeAttestation: RuntimeReleaseAttestation;
  paginationOpts: Readonly<{ numItems: number; cursor: string | null }>;
}>;
type FunctionName = "quota:auditUserQuotaUpgradePage" | "quota:diagnoseUserQuotaUpgradePage" | "quota:upgradeUserQuotaPage";

export type QuotaUpgradeDependencies = Readonly<{
  assertSource: () => void | Promise<void>;
  readCandidate: (path: string) => DeployEvidence;
  verifyTarget: (target: ConvexTarget) => Promise<void>;
  readAttestation: (target: ConvexTarget) => Promise<RuntimeReleaseAttestation>;
  invoke: (name: FunctionName, args: PageArguments) => Promise<unknown>;
  readIntent: (path: string) => z.infer<typeof quotaUpgradeIntentSchema> | undefined;
  writeIntent: (path: string, value: z.infer<typeof quotaUpgradeIntentSchema>) => void;
  readReceipt: (path: string) => z.infer<typeof quotaUpgradeReceiptSchema> | undefined;
  writeReceipt: (path: string, value: z.infer<typeof quotaUpgradeReceiptSchema>) => void;
}>;

/** Closed migration orchestration; adapters own source, target, protected evidence and process custody. */
export async function manageQuotaUpgrade(options: QuotaUpgradeArguments, dependencies: QuotaUpgradeDependencies) {
  if (options.action === "diagnose" && options.evidencePath !== undefined) return refuse("usage_invalid");
  const target = parseConvexTarget(options.target);
  await dependencies.assertSource();
  const candidate = dependencies.readCandidate(options.deployEvidencePath);
  const predecessor = dependencies.readCandidate(options.previousDeployEvidencePath);
  if (candidate.phase !== "candidate" || candidate.sourceCommit !== options.sourceCommit || candidate.before === null
    || candidate.previousDeployDigest !== predecessor.selfDigest || !same(candidate.before, predecessor.after)
    || !same(candidate.target, target) || !same(predecessor.target, target)
    || candidate.targetDigest !== canonicalDigest(target) || predecessor.targetDigest !== candidate.targetDigest) return refuse("candidate_invalid");
  const binding = {
    candidateDeployDigest: candidate.selfDigest, predecessorDeployDigest: predecessor.selfDigest,
    runtimeAttestation: candidate.after, sourceCommit: options.sourceCommit, target, targetDigest: candidate.targetDigest,
  };
  const prove = async (): Promise<void> => {
    await dependencies.assertSource();
    if (!same(dependencies.readCandidate(options.deployEvidencePath), candidate)
      || !same(dependencies.readCandidate(options.previousDeployEvidencePath), predecessor)) refuse("binding_changed");
    await dependencies.verifyTarget(target);
    const runtime = await dependencies.readAttestation(target);
    await dependencies.verifyTarget(target);
    if (!same(runtime, candidate.after)) refuse("binding_changed");
    if (!same(dependencies.readCandidate(options.deployEvidencePath), candidate)
      || !same(dependencies.readCandidate(options.previousDeployEvidencePath), predecessor)) refuse("binding_changed");
    await dependencies.assertSource();
  };
  if (options.action === "diagnose") {
    let total: Audit = { scanned: 0, legacy: 0, unmarkedCurrent: 0, incompleteEmptyMemory: 0, current: 0, corrupt: 0 };
    const reasons = emptyQuotaUpgradeCorruptionCounts();
    const shapes = new Map<string, z.infer<typeof quotaUpgradeDiagnosticPageSchema>["missingShapes"][number]>();
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let index = 0; index < maximumPages; index += 1) {
      await prove();
      const parsed = quotaUpgradeDiagnosticPageSchema.safeParse(await dependencies.invoke("quota:diagnoseUserQuotaUpgradePage", {
        expectedRuntimeAttestation: candidate.after, paginationOpts: { numItems: pageSize, cursor },
      }));
      await prove();
      if (!parsed.success) return refuse("provider_result_invalid");
      const value = parsed.data;
      total = { scanned: total.scanned + value.scanned, legacy: total.legacy + value.legacy,
        unmarkedCurrent: total.unmarkedCurrent + value.unmarkedCurrent, incompleteEmptyMemory: total.incompleteEmptyMemory + value.incompleteEmptyMemory, current: total.current + value.current,
        corrupt: total.corrupt + value.corrupt };
      if (total.scanned > SERVICE_TOTAL_QUOTA.identities) return refuse("pagination_invalid");
      for (const reason of quotaUpgradeCorruptionReasons) reasons[reason] += value.reasons[reason];
      for (const entry of value.missingShapes) {
        const key = JSON.stringify(entry.shape);
        shapes.set(key, { shape: entry.shape, count: (shapes.get(key)?.count ?? 0) + entry.count });
      }
      if (value.isDone) return { schemaVersion: 2 as const, kind: "quota_upgrade_diagnostic" as const,
        state: "diagnostic_complete" as const, ...total, reasons,
        missingShapes: [...shapes.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, entry]) => entry), pages: index + 1,
        consistency: "per_page_only" as const, reasonSelection: "first_failure_per_identity" as const,
        repairAuthorized: false as const, activationAuthorized: false as const };
      if (value.scanned === 0 || value.continueCursor === "" || seen.has(value.continueCursor)) return refuse("pagination_invalid");
      cursor = value.continueCursor; seen.add(cursor);
    }
    return refuse("pagination_invalid");
  }
  const audit = async (): Promise<Audit> => {
    let total: Audit = { scanned: 0, legacy: 0, unmarkedCurrent: 0, incompleteEmptyMemory: 0, current: 0, corrupt: 0 };
    let cursor: string | null = null;
    const seen = new Set<string>();
    for (let index = 0; index < maximumPages; index += 1) {
      await prove();
      const parsed = quotaUpgradeAuditPageSchema.safeParse(await dependencies.invoke("quota:auditUserQuotaUpgradePage", {
        expectedRuntimeAttestation: candidate.after, paginationOpts: { numItems: pageSize, cursor },
      }));
      await prove();
      if (!parsed.success) return refuse("provider_result_invalid");
      const value = parsed.data;
      total = { scanned: total.scanned + value.scanned, legacy: total.legacy + value.legacy,
        unmarkedCurrent: total.unmarkedCurrent + value.unmarkedCurrent, incompleteEmptyMemory: total.incompleteEmptyMemory + value.incompleteEmptyMemory, current: total.current + value.current, corrupt: total.corrupt + value.corrupt };
      if (total.scanned > SERVICE_TOTAL_QUOTA.identities) return refuse("pagination_invalid");
      if (value.isDone) return total;
      if (value.scanned === 0 || value.continueCursor === "" || seen.has(value.continueCursor)) return refuse("pagination_invalid");
      cursor = value.continueCursor; seen.add(cursor);
    }
    return refuse("pagination_invalid");
  };
  const before = await audit();
  if (options.action === "status") return { schemaVersion: 2 as const, state: before.corrupt + before.legacy + before.unmarkedCurrent + before.incompleteEmptyMemory === 0 ? "ready" as const : "debt" as const,
    ...before, activationAuthorized: false as const };
  if (before.corrupt !== 0) return refuse("quota_upgrade_corrupt");
  if (options.evidencePath === undefined) return refuse("usage_invalid");
  const intentPath = `${options.evidencePath}.intent`;
  const intent = quotaUpgradeIntentSchema.parse(withSelfDigest({ ...binding, kind: "quota-schema-upgrade-intent" as const,
    schemaVersion: 2 as const, repairPolicy: "empty-memory-authority-v1" as const, quotaSchemaVersion: 2 as const }));
  const receipt = quotaUpgradeReceiptSchema.parse(withSelfDigest({ ...binding, kind: "quota-schema-upgrade-receipt" as const,
    schemaVersion: 2 as const, repairPolicy: "empty-memory-authority-v1" as const, quotaSchemaVersion: 2 as const, intentDigest: intent.selfDigest,
    verificationPasses: 2 as const, state: "complete" as const, activationAuthorized: false as const }));
  await prove();
  const existingIntent = dependencies.readIntent(intentPath);
  const existingReceipt = dependencies.readReceipt(options.evidencePath);
  if ((existingIntent !== undefined && !same(existingIntent, intent)) || (existingReceipt !== undefined
    && (existingIntent === undefined || !same(existingReceipt, receipt)))) return refuse("evidence_invalid");
  if (existingIntent === undefined) dependencies.writeIntent(intentPath, intent);
  const assertIntent = (): void => { if (!same(dependencies.readIntent(intentPath), intent)) refuse("evidence_invalid"); };
  assertIntent();
  let repaired: Mutation = { scanned: 0, current: 0, changed: 0, upgraded: 0, marked: 0, repairedMemory: 0 };
  if (existingReceipt !== undefined && before.legacy + before.unmarkedCurrent + before.incompleteEmptyMemory !== 0) return refuse("evidence_invalid");
  if (existingReceipt === undefined && before.legacy + before.unmarkedCurrent + before.incompleteEmptyMemory !== 0) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    let done = false;
    for (let index = 0; index < maximumPages; index += 1) {
      await prove(); assertIntent();
      const parsed = quotaUpgradeMutationPageSchema.safeParse(await dependencies.invoke("quota:upgradeUserQuotaPage", {
        expectedRuntimeAttestation: candidate.after, paginationOpts: { numItems: pageSize, cursor },
      }));
      await prove(); assertIntent();
      if (!parsed.success) return refuse("provider_result_invalid");
      const value = parsed.data;
      repaired = { scanned: repaired.scanned + value.scanned, current: repaired.current + value.current,
        changed: repaired.changed + value.changed, upgraded: repaired.upgraded + value.upgraded, marked: repaired.marked + value.marked, repairedMemory: repaired.repairedMemory + value.repairedMemory };
      if (repaired.scanned > SERVICE_TOTAL_QUOTA.identities) return refuse("pagination_invalid");
      if (value.isDone) { done = true; break; }
      if (value.scanned === 0 || value.continueCursor === "" || seen.has(value.continueCursor)) return refuse("pagination_invalid");
      cursor = value.continueCursor; seen.add(cursor);
    }
    if (!done) return refuse("pagination_invalid");
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const verified = await audit();
    if (verified.corrupt + verified.legacy + verified.unmarkedCurrent + verified.incompleteEmptyMemory !== 0) return refuse("quota_upgrade_debt_remaining");
  }
  await prove(); assertIntent();
  if (existingReceipt === undefined) dependencies.writeReceipt(options.evidencePath, receipt);
  if (!same(dependencies.readReceipt(options.evidencePath), receipt)) return refuse("evidence_invalid");
  await prove(); assertIntent();
  return { schemaVersion: 2 as const, state: "complete" as const, ...repaired, verificationPasses: 2 as const, activationAuthorized: false as const };
}

const readOptional = <T>(path: string, schema: z.ZodType<T>): T | undefined => {
  // Called only by repair, after source/target/runtime proof. The existing
  // protected-file reader may settle its own interrupted atomic publication.
  try { return readProtectedJson(path, schema, { recoverInterruptedPublication: true }); }
  catch (error: unknown) { if (error instanceof ReleaseEvidenceError && error.code === "evidence_not_found") return undefined; throw error; }
};

class QuotaUpgradeSourceCleanupError extends Error {
  readonly recoveryPaths: readonly string[];
  constructor(path: string) {
    super("quota_upgrade_source_cleanup_failed");
    this.name = "QuotaUpgradeSourceCleanupError";
    this.recoveryPaths = [path];
  }
}

/** Retain source custody when process collection or exact-root cleanup is uncertain. */
export async function finishQuotaUpgradeSource(
  guard: BoundedProcessInvocationGuard,
  source: HostedOperationSourceBinding | undefined,
): Promise<void> {
  guard.assertMayProceed();
  if (source === undefined) return;
  try { await source.cleanup(); }
  catch { throw new QuotaUpgradeSourceCleanupError(source.recoveryPath); }
}

export function quotaUpgradeFailureResult(error: unknown) {
  const processRecovery = isBoundedProcessCleanupUnprovenError(error) || isBoundedProcessRecoveryJournalError(error);
  const sourceRecovery = error instanceof QuotaUpgradeSourceCleanupError || error instanceof HostedDeployFilesystemCleanupError;
  const recovery = processRecovery || sourceRecovery;
  return {
    exitCode: recovery ? 75 as const : 1 as const,
    output: { schemaVersion: 1 as const, state: recovery ? "recovery_required" as const : "refused" as const,
      code: error instanceof QuotaUpgradeError ? error.code : processRecovery ? "process_recovery_required" as const
        : sourceRecovery ? "source_cleanup_failed" as const : "provider_result_invalid" as const,
      ...(recovery ? { recoveryPaths: error.recoveryPaths } : {}) },
  };
}

export async function runQuotaUpgrade(options: QuotaUpgradeArguments, runner: CommandRunner = runCommand) {
  if (Bun.version !== "1.3.14") return refuse("source_changed");
  const repositoryRoot = resolve(import.meta.dir, "..");
  const assertSource = (): void => assertHostedOperatorSource({ repositoryRoot, sourceCommit: options.sourceCommit });
  assertSource();
  const environment = buildConvexChildEnvironment(process.env, []);
  const guard = new BoundedProcessInvocationGuard();
  for (const path of [options.deployEvidencePath, options.previousDeployEvidencePath,
    ...(options.evidencePath === undefined ? [] : [options.evidencePath, `${options.evidencePath}.intent`])]) guard.retainRecoveryPath(path);
  let source: HostedOperationSourceBinding | undefined;
  try {
    source = await guard.observe(async () => await prepareHostedOperationSource({ environment, repositoryRoot, runner, sourceCommit: options.sourceCommit }));
    guard.retainRecoveryPath(source.recoveryPath);
    const providerSource = source;
    const target = parseConvexTarget(options.target);
    const client = new ConvexHttpClient(target.deploymentUrl, { logger: false,
      fetch: createBoundedAuthorityFetch(fetch, 30_000, "quota_upgrade_attestation_timeout") });
    return await manageQuotaUpgrade(options, {
      assertSource,
      readCandidate: (path) => parseDeployEvidenceFile(path),
      verifyTarget: async (value) => await guard.observe(async () => await verifyConvexDefaultTarget(value)),
      readAttestation: async () => await guard.observe(async () => runtimeReleaseAttestationSchema.parse(
        await client.query(makeFunctionReference<"query", Record<string, never>, unknown>("releaseAttestation:read"), {}))),
      invoke: async (name, args) => {
        await guard.observe(async () => await providerSource.revalidate());
        const result = await guard.observe(async () => await runner({
          executable: process.execPath, arguments: [hostedOperationConvexCliPath(providerSource.path), "run", name, JSON.stringify(args), "--deployment", target.deploymentName],
          containment: "authority", cwd: providerSource.path, environment, stdin: "", outputMaximumBytes: 64 * 1024,
          timeoutMs: 60_000, phase: "quota-upgrade-page",
        }));
        await guard.observe(async () => await providerSource.revalidate());
        if (result.exitCode !== 0 || Buffer.byteLength(result.stdout) > 64 * 1024 || result.stdout.trim() === "") return refuse("provider_result_invalid");
        try { return JSON.parse(result.stdout) as unknown; } catch { return refuse("provider_result_invalid"); }
      },
      readIntent: (path) => readOptional(path, quotaUpgradeIntentSchema),
      writeIntent: (path, value) => { writeProtectedJsonNoReplace(path, value, quotaUpgradeIntentSchema); },
      readReceipt: (path) => readOptional(path, quotaUpgradeReceiptSchema),
      writeReceipt: (path, value) => { writeProtectedJsonNoReplace(path, value, quotaUpgradeReceiptSchema); },
    });
  } finally {
    // A terminal process-custody failure retains the exact source and evidence
    // paths. Never erase the compiler/CLI recovery root in that state.
    await finishQuotaUpgradeSource(guard, source);
  }
}

if (import.meta.main) {
  try {
    const options = parseQuotaUpgradeArguments(process.argv.slice(2));
    await recoverBoundedProcessJournal();
    process.stdout.write(`${JSON.stringify(await runQuotaUpgrade(options))}\n`);
  } catch (error: unknown) {
    const failure = quotaUpgradeFailureResult(error);
    process.stderr.write(`${JSON.stringify(failure.output)}\n`);
    process.exitCode = failure.exitCode;
  }
}
