import { createHash } from "node:crypto";
import { z } from "zod";

import { providerAccountReadinessSchema } from "../domain/provider-accounts";
import {
  claudeAccountingUsageSchema, claudeQuotaUsageSchema, codexQuotaUsageSchema,
  providerUsageSourceSchema, providerUsageTurnProvenanceSchema, usageProviderAccountAuthoritySchema,
} from "../domain/provider-usage";
import { accountRateLimitResetOutcomeSchema } from "../domain/usage-metrics";
import { automaticUsagePolicyConfigurationSchema } from "../domain/usage-policy";
import { profileIdSchema } from "../domain/values";
import type { ProviderUsageSourceFacts } from "../storage/state-store";
import { hasExactKeys, isRecord, snapshotForeignJson } from "./contracts";
import { hmacSha256Hex } from "./crypto";
import { parseUsageComponentsV2, type UsageComponentsV2 } from "./usage-components-v2";
import { deriveUsageSourcePublicIdV2, parseUsageHeadContextV2 } from "./usage-context-v2";
import { type CodexUsageDisplayV2 } from "./usage-display-v2";
import { parseUsageHeadV2, type UsageHeadV2 } from "./usage-head-v2";
import { snapshotUsageAccountKeyV2 } from "./usage-key-v2";

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = counter.positive();
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const unavailable = <R extends string>(reason: R) => ({ state: "unavailable" as const, reason });
const missingSchema = z.object({ state: z.literal("unavailable"), reason: z.enum([
  "not_observed", "source_unavailable", "identity_unavailable", "authority_mismatch", "snapshot_conflict", "representation_limit",
]) }).strict();
const provenanceSchema = z.object({
  authority: usageProviderAccountAuthoritySchema, source: providerUsageSourceSchema,
  turn: providerUsageTurnProvenanceSchema.nullable(), observationRevision: counter,
  sourceEventDigest: digest, componentDigest: digest, observedAt: counter, receivedAt: counter,
}).strict();
const observedSchema = <T extends z.ZodType>(data: T) => z.object({
  state: z.literal("observed"), provenance: provenanceSchema, data,
}).strict();
const identitySchema = z.union([
  z.object({ state: z.literal("cached"), email: z.string().min(1).max(1_024)
    .refine((email) => email.trim().length > 0 && new TextEncoder().encode(email).byteLength <= 3_072
      && !/[\p{Cc}\p{Cs}]/u.test(email)) }).strict(),
  z.object({ state: z.literal("unavailable"), reason: z.enum([
    "identity_unavailable", "snapshot_conflict", "representation_limit",
  ]) }).strict(),
]);
const sourceSchema = z.union([
  usageProviderAccountAuthoritySchema.options[0].extend({ state: z.literal("cached"), identity: identitySchema,
    readiness: providerAccountReadinessSchema.exclude(["removed"]), readinessObservedAt: counter.nullable() }).strict(),
  usageProviderAccountAuthoritySchema.options[1].extend({ state: z.literal("cached"),
    identity: z.object({ state: z.literal("unavailable"), reason: z.literal("provider_unsupported") }).strict(),
    readiness: providerAccountReadinessSchema.exclude(["removed"]), readinessObservedAt: counter.nullable() }).strict(),
  z.object({ state: z.literal("unavailable"), reason: z.enum(["source_unavailable", "snapshot_conflict"]) }).strict(),
]);
const metadataSchema = z.object({
  source: sourceSchema,
  order: z.union([
    z.object({ state: z.literal("cached"), orderRevision: revision, pointerRevision: revision,
      accountCount: revision.max(10_000), orderPosition: revision, active: z.boolean() }).strict(),
    z.object({ state: z.literal("unavailable"), reason: z.enum(["snapshot_conflict", "representation_limit"]) }).strict(),
  ]),
  automaticPolicy: z.union([
    z.object({ state: z.literal("configured"), configuration: automaticUsagePolicyConfigurationSchema }).strict(),
    z.object({ state: z.literal("unavailable"), reason: z.literal("configuration_unavailable") }).strict(),
  ]),
}).strict();
const attemptSchema = z.object({
  attemptSequence: revision, idempotencyKey: z.string().uuid(), profileId: profileIdSchema,
  originProcessGeneration: counter, currentProcessGeneration: counter, accountFingerprint: digest,
  weeklyWindowResetsAt: counter, observedUsedPercent: z.number().min(0).max(100),
  state: z.enum(["prepared", "retryable", "effect_started", "ambiguous", "settled", "closed"]),
  outcome: accountRateLimitResetOutcomeSchema.nullable(),
  localResolution: z.enum(["weekly_window_changed", "account_identity_changed"]).nullable(),
  createdAt: counter, updatedAt: counter,
}).strict().refine((attempt) => attempt.currentProcessGeneration >= attempt.originProcessGeneration
  && attempt.updatedAt >= attempt.createdAt).refine((attempt) => attempt.state === "settled"
  ? attempt.outcome !== null && attempt.localResolution === null
  : attempt.state === "closed" ? attempt.outcome === null && attempt.localResolution !== null
    : attempt.outcome === null && attempt.localResolution === null);
const resetSchema = z.object({
  currentIdentity: z.union([missingSchema, z.object({ state: z.literal("known"), accountFingerprint: digest,
    policy: z.object({ profileId: profileIdSchema, state: z.enum([
      "active_unbound", "active_bound", "window_suppressed", "reconciliation_required",
    ]), accountFingerprint: digest.nullable(), weeklyWindowResetsAt: counter.nullable(),
    revision, createdAt: counter, updatedAt: counter }).strict().refine((policy) => policy.updatedAt >= policy.createdAt
      && (policy.state === "active_unbound" || policy.state === "reconciliation_required"
        ? policy.accountFingerprint === null && policy.weeklyWindowResetsAt === null
        : policy.accountFingerprint !== null && policy.weeklyWindowResetsAt !== null)),
    lastAttempt: attemptSchema.nullable(),
  }).strict()]),
  pending: z.union([missingSchema, z.object({ state: z.literal("none") }).strict(),
    z.object({ state: z.literal("retained"), attempt: attemptSchema,
      identityRelation: z.enum(["current", "different", "unavailable"]) }).strict()]),
}).strict();
// This native-only schema checks the private reader contract. It is never a
// wire schema, storage writer, evidence verifier or replacement for the reader.
const factsSchema: z.ZodType<ProviderUsageSourceFacts> = z.union([
  z.object({ state: z.literal("unavailable"), reason: z.literal("snapshot_conflict") }).strict(),
  z.object({ state: z.literal("cached"), provider: z.enum(["codex", "claude"]), metadata: metadataSchema,
    quota: z.union([missingSchema, observedSchema(z.union([
      codexQuotaUsageSchema.extend({ resetCreditsAvailable: counter.nullable() }), claudeQuotaUsageSchema,
    ]))]),
    accounting: z.union([missingSchema, observedSchema(claudeAccountingUsageSchema),
      z.object({ state: z.literal("unavailable"), reason: z.literal("not_projected") }).strict()]),
    reset: z.union([resetSchema,
      z.object({ state: z.literal("unavailable"), reason: z.literal("provider_unsupported") }).strict()]),
  }).strict(),
]);
type CachedFacts = Extract<ProviderUsageSourceFacts, { state: "cached" }>;
type ResetFacts = Exclude<CachedFacts["reset"], { state: "unavailable" }>;
type Attempt = z.infer<typeof attemptSchema>;

function ownData(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length > 16) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const descriptor = Reflect.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
    result[key] = descriptor.value;
  }
  return result;
}

function captureFacts(input: unknown): ProviderUsageSourceFacts | null {
  try {
    const root = ownData(input);
    if (root === null) return null;
    // The reader intentionally shares a current pending attempt with history.
    // Snapshot those two bounded branches independently, then apply the common
    // whole-value budget. Do not relax the public JSON codec's alias refusal.
    if (root.state === "cached") {
      const reset = ownData(root.reset);
      if (reset === null) return null;
      if (hasExactKeys(reset, ["currentIdentity", "pending"])) {
        const current = snapshotForeignJson(reset.currentIdentity);
        const pending = snapshotForeignJson(reset.pending);
        if (!current.ok || !pending.ok) return null;
        root.reset = { currentIdentity: current.value, pending: pending.value };
      }
    }
    const snapshot = snapshotForeignJson(root);
    if (!snapshot.ok) return null;
    const parsed = factsSchema.safeParse(snapshot.value);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

function missing(reason: z.infer<typeof missingSchema>["reason"]) {
  switch (reason) {
    case "authority_mismatch": case "snapshot_conflict": return unavailable("source_unavailable");
    case "not_observed": case "source_unavailable": case "identity_unavailable": case "representation_limit":
      return unavailable(reason);
  }
}

function coherentFacts(facts: CachedFacts, provider: "codex" | "claude", localId: string): boolean {
  if (facts.provider !== provider) return false;
  const source = facts.metadata.source;
  if (source.state === "cached" && (source.provider !== provider || source.providerAccountId !== localId
    || provider === "codex" && source.profileId !== localId)) return false;
  for (const [kind, component] of [["quota", facts.quota], ["accounting", facts.accounting]] as const) {
    if (component.state !== "observed") continue;
    if (source.state !== "cached") return false;
    const { authority, source: origin, turn, observationRevision } = component.provenance;
    if (authority.provider !== provider || authority.providerAccountId !== localId
      || authority.profileId !== source.profileId || authority.bindingGeneration !== source.bindingGeneration
      || authority.processGeneration !== source.processGeneration) return false;
    if (provider === "codex") {
      if (kind !== "quota" || component.data.format !== "codex_v1" || origin !== "codex_app_server"
        || turn !== null || source.provider !== "codex" || source.identity.state !== "cached") return false;
    } else if (component.data.format !== "claude_v1" || turn === null || observationRevision < 1
      || component.provenance.observedAt !== component.provenance.receivedAt
      || origin !== (kind === "quota" ? "claude_rate_limit_event" : "claude_result")) return false;
  }
  if (provider === "claude") return "state" in facts.reset
    && !(facts.accounting.state === "unavailable" && facts.accounting.reason === "not_projected");
  if ("state" in facts.reset || facts.accounting.state !== "unavailable" || facts.accounting.reason !== "not_projected") return false;
  const { currentIdentity, pending } = facts.reset;
  const fingerprint = source.state === "cached" && source.provider === "codex" && source.identity.state === "cached"
    ? createHash("sha256").update(source.identity.email.trim().toLowerCase()).digest("hex") : null;
  if (currentIdentity.state === "known") {
    if (currentIdentity.accountFingerprint !== fingerprint || currentIdentity.policy.profileId !== localId) return false;
    const last = currentIdentity.lastAttempt;
    if (last !== null && (last.profileId !== localId || last.accountFingerprint !== fingerprint)) return false;
  }
  if (pending.state === "retained") {
    const attempt = pending.attempt;
    if (attempt.profileId !== localId || attempt.state === "settled" || attempt.state === "closed"
      || pending.identityRelation !== (fingerprint === null ? "unavailable"
        : fingerprint === attempt.accountFingerprint ? "current" : "different")) return false;
  }
  return true;
}

function projectAttempt(attempt: Attempt) {
  const { state, weeklyWindowResetsAt } = attempt;
  return state === "settled" ? { state, weeklyWindowResetsAt, outcome: attempt.outcome }
    : state === "closed" ? { state, weeklyWindowResetsAt, reason: attempt.localResolution }
      : { state: state === "retryable" ? "retry_pending" : state === "prepared" ? "prepared" : "recovery_pending", weeklyWindowResetsAt };
}

function resetIdentityConflict(reset: ResetFacts): boolean {
  return reset.currentIdentity.state === "known" && reset.currentIdentity.policy.accountFingerprint !== null
    && reset.currentIdentity.policy.accountFingerprint !== reset.currentIdentity.accountFingerprint;
}

function projectReset(reset: ResetFacts) {
  const { currentIdentity, pending } = reset;
  const policy = currentIdentity.state === "known" ? currentIdentity.policy : null;
  return { state: "cached", currentIdentity: resetIdentityConflict(reset) ? unavailable("snapshot_conflict")
    : currentIdentity.state === "unavailable"
    ? unavailable(currentIdentity.reason === "identity_unavailable" ? "identity_unavailable" : "snapshot_conflict")
    : { state: "known", policy: policy?.state === "window_suppressed"
      ? { state: "window_suppressed", weeklyWindowResetsAt: policy.weeklyWindowResetsAt }
      : { state: policy?.state === "reconciliation_required" ? "reconciliation_required" : "active" },
    lastAttempt: currentIdentity.lastAttempt === null ? null : projectAttempt(currentIdentity.lastAttempt) },
  pending: pending.state === "unavailable" ? unavailable("snapshot_conflict") : pending.state === "none" ? { state: "none" }
    : { ...projectAttempt(pending.attempt),
      identityRelation: pending.identityRelation } };
}

function conflict(facts: CachedFacts): boolean {
  if (!("state" in facts.reset) && resetIdentityConflict(facts.reset)) return true;
  const blocks = [facts.quota, facts.accounting, facts.metadata.source, facts.metadata.order,
    ...("state" in facts.reset ? [] : [facts.reset.currentIdentity, facts.reset.pending])];
  return blocks.some((block) => block.state === "unavailable"
    && (block.reason === "snapshot_conflict" || block.reason === "authority_mismatch"));
}

function projectComponents(facts: CachedFacts): UsageComponentsV2 | null {
  const { source, automaticPolicy } = facts.metadata;
  const base = { provider: facts.provider, readiness: source.state === "cached"
    ? { state: "cached", value: source.readiness, observedAt: source.readinessObservedAt } : unavailable("source_unavailable"),
  automaticPolicy: automaticPolicy.state === "configured" ? { state: "configured",
    revision: automaticPolicy.configuration.automaticPolicyRevision,
    defaultEnabled: automaticPolicy.configuration.defaultEnabled, override: automaticPolicy.configuration.overrides[facts.provider] }
    : unavailable("configuration_unavailable") };
  const quota = facts.quota.state === "unavailable" ? missing(facts.quota.reason) : {
    state: "observed", source: facts.quota.provenance.source,
    observedAt: facts.quota.provenance.observedAt, receivedAt: facts.quota.provenance.receivedAt,
    data: facts.quota.data.format === "codex_v1" ? {
      // Retained native v1 cannot distinguish absent availability from zero.
      // Preserve that uncertainty even for a directly supplied private fact.
      resetCreditsAvailable: facts.quota.data.resetCreditsAvailable === 0 ? null : facts.quota.data.resetCreditsAvailable,
      limits: facts.quota.data.limits.map(({ id, rateLimitReachedType, primary, secondary }) => ({ id, rateLimitReachedType, primary, secondary })) }
      : { status: facts.quota.data.status, rateLimitType: facts.quota.data.rateLimitType, resetsAtMs: facts.quota.data.resetsAtMs,
        overageStatus: facts.quota.data.overageStatus, overageDisabledReason: facts.quota.data.overageDisabledReason,
        isUsingOverage: facts.quota.data.isUsingOverage, windows: facts.quota.data.windows },
  };
  const accounting = facts.accounting.state === "unavailable"
    ? facts.accounting.reason === "not_projected" ? unavailable("not_projected") : missing(facts.accounting.reason)
    : { state: "observed", source: facts.accounting.provenance.source,
      observedAt: facts.accounting.provenance.observedAt, receivedAt: facts.accounting.provenance.receivedAt,
      data: { totalCostUsd: facts.accounting.data.totalCostUsd, inputTokens: facts.accounting.data.inputTokens,
        cacheReadInputTokens: facts.accounting.data.cacheReadInputTokens, cacheCreationInputTokens: facts.accounting.data.cacheCreationInputTokens,
        outputTokens: facts.accounting.data.outputTokens, thinkingTokens: facts.accounting.data.thinkingTokens, models: facts.accounting.data.models } };
  // A locally valid code can exceed the public grammar. Refuse that complete
  // component, preserving independent facts; never truncate or sanitize a row.
  const parsedQuota = parseUsageComponentsV2({ ...base, quota,
    accounting: unavailable(facts.provider === "codex" ? "not_projected" : "not_observed") });
  const parsedAccounting = parseUsageComponentsV2({ ...base, quota: unavailable("not_observed"), accounting });
  return parseUsageComponentsV2({ ...base, quota: parsedQuota?.quota ?? unavailable("representation_limit"),
    accounting: parsedAccounting?.accounting ?? unavailable("representation_limit") });
}

/** Standalone cached projection. No read, refresh, evaluation, encryption,
 * publication or revision allocation. Context selection remains caller-owned. */
export async function projectUsageHeadV2(
  input: unknown, accountKey: Uint8Array, expectedContext: unknown, localProviderAccountId: unknown,
): Promise<UsageHeadV2 | null> {
  const key = snapshotUsageAccountKeyV2(accountKey);
  const facts = captureFacts(input);
  const context = parseUsageHeadContextV2(expectedContext);
  if (key === null || facts === null || context === null || typeof localProviderAccountId !== "string") return null;
  const localId = localProviderAccountId;
  if (facts.state === "cached" && !coherentFacts(facts, context.provider, localId)) return null;
  let sourcePublicId: string;
  try { sourcePublicId = await deriveUsageSourcePublicIdV2(key, {
    apiOrigin: context.apiOrigin, userPublicId: context.userPublicId, sourceDevicePublicId: context.sourceDevicePublicId,
    provider: context.provider, localProviderAccountId: localId, keyVersion: context.keyVersion,
  }); } catch { return null; }
  if (sourcePublicId !== context.sourcePublicId) return null;
  let codexAccountMatchPublicId: string | null = null;
  if (facts.state === "cached" && facts.metadata.source.state === "cached" && facts.metadata.source.provider === "codex"
    && facts.metadata.source.identity.state === "cached") {
    const email = facts.metadata.source.identity.email.normalize("NFKC").trim().toLocaleLowerCase("en-US");
    codexAccountMatchPublicId = `codex_${(await hmacSha256Hex(key, "codex-account-match", email)).slice(0, 48)}`;
  }
  const components = facts.state === "cached" ? projectComponents(facts) : {
    provider: context.provider, quota: unavailable("source_unavailable"),
    accounting: unavailable(context.provider === "codex" ? "not_projected" : "source_unavailable"),
    readiness: unavailable("source_unavailable"), automaticPolicy: unavailable("configuration_unavailable"),
  };
  let nextAction: CodexUsageDisplayV2["nextAction"] = unavailable("runtime_not_integrated");
  let reset: unknown = context.provider === "claude" ? unavailable("provider_unsupported") : unavailable("snapshot_conflict");
  if (facts.state === "unavailable") nextAction = unavailable("snapshot_conflict");
  else {
    if (conflict(facts)) nextAction = unavailable("snapshot_conflict");
    if (!("state" in facts.reset)) {
      reset = projectReset(facts.reset);
      if (facts.reset.currentIdentity.state === "unavailable" && facts.reset.currentIdentity.reason !== "identity_unavailable"
        || facts.reset.pending.state === "unavailable") nextAction = unavailable("snapshot_conflict");
      if (facts.reset.pending.state === "retained"
        && (facts.reset.pending.attempt.state === "effect_started" || facts.reset.pending.attempt.state === "ambiguous")) {
        nextAction = { state: "blocked", reason: "reset_outcome_unknown" };
      }
    }
  }
  return parseUsageHeadV2({ version: 2, userPublicId: context.userPublicId, sourceDevicePublicId: context.sourceDevicePublicId,
    sourcePublicId, sourceRevision: context.sourceRevision, keyVersion: context.keyVersion, provider: context.provider,
    codexAccountMatchPublicId, order: facts.state === "cached" ? facts.metadata.order : unavailable("snapshot_conflict"),
    components, display: { provider: context.provider, reset, nextAction } }, context);
}
