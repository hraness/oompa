import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readlinkSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import {
  AUTHORITY_REDUCTION_QUOTA_CEILINGS,
  emptyAuthorityReductionQuotaCeilings,
  SERVICE_TOTAL_QUOTA,
} from "../convex/quota";
import {
  authorityReductionCapacityReservation,
  commandLifecycleCapacityVersion,
} from "../convex/validators";
import { isUuidV7 } from "../src/cloud/contracts";
import { createBoundedAuthorityFetch, type AuthorityFetcher } from "./bounded-authority-fetch";
import {
  BoundedProcessInvocationGuard,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
  retainBoundedProcessRecoveryPath,
} from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
} from "./authority-containment";
import {
  buildConvexChildEnvironment,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  hostedOperationConvexCliPath,
  prepareHostedOperationSource,
  type HostedOperationSourceBinding,
} from "./deploy-hosted-sync";
import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  canonicalDigest,
  convexTargetEvidenceSchema,
  parseDeployEvidenceFile,
  readProtectedJson,
  ReleaseEvidenceError,
  runtimeReleaseAttestationSchema,
  withSelfDigest,
  writeProtectedJsonNoReplace,
  type DeployEvidence,
  type RuntimeReleaseAttestation,
} from "./release-evidence";

const repositoryRoot = resolve(import.meta.dir, "..");
const supportedBunVersion = "1.3.14";
const providerOutputMaximumBytes = 64 * 1_024;
const providerTimeoutMs = 60_000;
const releaseAttestationTimeoutMs = 30_000;
const gitOutputMaximumBytes = 64 * 1_024;
const sourceManifestMaximumBytes = 2 * 1_024 * 1_024;
const sourceHashReadBytes = 64 * 1_024;
const pageSize = 8;
// A single table/state cannot exceed the service-wide record ceiling. Keep the
// loop bounded while making every quota-valid deployment exhaustible.
const maximumPagesPerScope = Math.ceil(SERVICE_TOTAL_QUOTA.records / pageSize);
const maximumHeadroomPages = Math.ceil(SERVICE_TOTAL_QUOTA.identities / pageSize) + 1;
const maximumRepairPasses = 4;
const maximumExplicitRetirements = 64;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

const commandType = z.enum(["session", "device"]);
const nonterminalState = z.enum(["pending", "prepared", "effect_started"]);
const terminalState = z.enum(["applied", "failed", "ambiguous", "cancelled", "expired"]);
const publicId = z.string().refine(isUuidV7);
const publicIds = z.array(publicId).max(pageSize).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "duplicate_public_id" });
  }
});
const pageBase = z.object({
  commandType,
  continueCursor: z.string().max(4_096),
  isDone: z.boolean(),
  scanned: z.number().int().min(0).max(pageSize),
  unreserved: publicIds,
});
const effectRetirementCandidate = z.object({
  commandPublicId: publicId,
  status: z.enum(["ambiguous", "eligible", "enqueue_missing"]),
}).strict();
const noEffectRetirementCandidate = z.object({
  commandPublicId: publicId,
  status: z.enum(["ambiguous", "deadline_pending", "eligible"]),
}).strict();
const lifecyclePage = pageBase.extend({
  effectRetirement: z.array(effectRetirementCandidate).max(pageSize),
  noEffectRetirement: z.array(noEffectRetirementCandidate).max(pageSize),
  state: nonterminalState,
}).strict();
const terminalPage = pageBase.extend({
  legacyRevoked: publicIds,
  operatorAbandoned: publicIds,
  state: terminalState,
  unsafeCleanup: publicIds,
}).strict();
const authorityReductionHeadroomPage = z.object({
  capacityMissing: z.number().int().min(0).max(pageSize),
  continueCursor: z.string().max(4_096),
  hardQuotaBlocked: z.number().int().min(0).max(pageSize),
  isDone: z.boolean(),
  mode: z.enum(["audit", "repair"]),
  orphanCleanupEligible: z.number().int().min(0).max(pageSize),
  orphanCleanupPending: z.number().int().min(0).max(pageSize),
  ready: z.number().int().min(0).max(pageSize),
  repaired: z.number().int().min(0).max(pageSize),
  scanned: z.number().int().min(0).max(pageSize),
  schemaVersion: z.literal(1),
  topologyBlocked: z.number().int().min(0).max(pageSize),
}).strict().superRefine((value, context) => {
  if (
    value.ready
    + value.capacityMissing
    + value.repaired
    + value.hardQuotaBlocked
    + value.orphanCleanupPending
    + value.orphanCleanupEligible
    + value.topologyBlocked
    !== value.scanned
    || (value.mode === "audit"
      && (value.repaired !== 0 || value.hardQuotaBlocked !== 0))
    || (value.mode === "repair" && value.capacityMissing !== 0)
  ) context.addIssue({ code: "custom", message: "authority_reduction_counts_invalid" });
});
const headroomCount = z.number().int().min(0).max(pageSize);
const quotaCeilingCounts = z.object({
  applicable: headroomCount,
  bytesBlockedByLowerBound: headroomCount,
  bytesUnknown: headroomCount,
  recordsBlocked: headroomCount,
}).strict().superRefine((value, context) => {
  if (
    value.recordsBlocked > value.applicable
    || value.bytesBlockedByLowerBound + value.bytesUnknown !== value.applicable
  ) context.addIssue({ code: "custom", message: "quota_ceiling_counts_invalid" });
});
export const authorityReductionQuotaDiagnosticPageSchema = z.object({
  activationAuthorized: z.literal(false),
  byteCost: z.literal("padding_lower_bound_only"),
  capacityMissing: headroomCount,
  ceilings: z.object({
    device: quotaCeilingCounts, identity: quotaCeilingCounts, job: quotaCeilingCounts,
    receipt: quotaCeilingCounts, security: quotaCeilingCounts,
    serviceTotal: quotaCeilingCounts, userTotal: quotaCeilingCounts,
  }).strict(),
  consistency: z.literal("page_snapshot"),
  continueCursor: z.string().max(4_096),
  demand: z.object({
    accountPairs: z.number().int().min(0).max(pageSize),
    deviceQuartets: z.number().int().min(0).max(16 * pageSize),
    paddingBytesLowerBound: z.number().int().min(0).max(66 * pageSize * 2_048),
    totalRecords: z.number().int().min(0).max(66 * pageSize),
  }).strict(),
  evaluated: headroomCount,
  isDone: z.boolean(),
  kind: z.literal("authority_reduction_quota_diagnostic"),
  orphanEligible: headroomCount,
  orphanPending: headroomCount,
  quotaAuthorityUnknown: headroomCount,
  ready: headroomCount,
  repairAuthorized: z.literal(false),
  scanned: headroomCount,
  schemaVersion: z.literal(1),
  topologyBlocked: headroomCount,
}).strict().superRefine((value, context) => {
  const { accountPairs, deviceQuartets, paddingBytesLowerBound, totalRecords } = value.demand;
  const { device, identity, job, receipt, security, serviceTotal, userTotal } = value.ceilings;
  if (
    value.ready + value.capacityMissing + value.topologyBlocked
      + value.orphanPending + value.orphanEligible !== value.scanned
    || value.evaluated + value.quotaAuthorityUnknown !== value.capacityMissing
    || accountPairs > value.capacityMissing
    || deviceQuartets > 16 * value.capacityMissing
    || accountPairs + deviceQuartets < value.capacityMissing
    || totalRecords !== 2 * accountPairs + 4 * deviceQuartets
    || paddingBytesLowerBound !== totalRecords * authorityReductionCapacityReservation.length
    || AUTHORITY_REDUCTION_QUOTA_CEILINGS.some((key) =>
      value.ceilings[key].applicable > value.evaluated)
    || job.applicable !== value.evaluated
    || userTotal.applicable !== value.evaluated || serviceTotal.applicable !== value.evaluated
    || identity.applicable > accountPairs
    || identity.applicable < accountPairs - value.quotaAuthorityUnknown
    || device.applicable > deviceQuartets
    || device.applicable * 16 + value.quotaAuthorityUnknown * 16 < deviceQuartets
    || device.applicable !== receipt.applicable || device.applicable !== security.applicable
    || identity.applicable + device.applicable < value.evaluated
    || accountPairs + deviceQuartets
      < identity.applicable + device.applicable + value.quotaAuthorityUnknown
  ) context.addIssue({ code: "custom", message: "quota_diagnostic_counts_invalid" });
});

type QuotaDiagnosticPage = z.infer<typeof authorityReductionQuotaDiagnosticPageSchema>;
export type CommandHeadroomDiagnosticResult = Readonly<
  Omit<QuotaDiagnosticPage, "consistency" | "continueCursor" | "isDone"> & {
    consistency: "per_page_only";
    pages: number;
    state: "diagnostic_complete";
  }
>;

const lifecycleRepair = z.object({
  state: z.enum(["absent", "terminal", "terminalized", "reserved", "exact"]),
}).strict();
const effectRetirement = z.object({ state: z.enum(["exact", "retired"]) }).strict();
const terminalNormalization = z.object({
  state: z.enum(["absent", "exact_no_cleanup", "normalized", "not_required"]),
}).strict();

const explicitRetirement = z.object({
  commandPublicId: publicId,
  commandType,
  retirementKind: z.enum(["effect_started", "no_effect_expired"]),
}).strict();
type ExplicitRetirement = Readonly<z.infer<typeof explicitRetirement>>;

const canonicalRetirements = (
  retirements: readonly ExplicitRetirement[],
): readonly ExplicitRetirement[] => [...retirements].sort((left, right) =>
  `${left.retirementKind}:${left.commandType}:${left.commandPublicId}`.localeCompare(
    `${right.retirementKind}:${right.commandType}:${right.commandPublicId}`,
  ));

const retirementDigest = (retirements: readonly ExplicitRetirement[]): string =>
  canonicalDigest(canonicalRetirements(retirements)
    .map((entry) =>
      `${entry.retirementKind}:${entry.commandType}:${entry.commandPublicId}`));

export const commandCapacityRetirementIntentSchema = z.object({
  candidateDeployDigest: z.string().regex(digestPattern),
  kind: z.literal("command-capacity-retirement-intent"),
  retirementEntries: z.array(explicitRetirement).min(1).max(maximumExplicitRetirements),
  retirementRequestDigest: z.string().regex(digestPattern),
  runtimeAttestation: runtimeReleaseAttestationSchema,
  schemaVersion: z.literal(1),
  selfDigest: z.string().regex(digestPattern),
  sourceCommit: z.string().regex(sourceCommitPattern),
  target: convexTargetEvidenceSchema,
  targetDigest: z.string().regex(digestPattern),
}).strict().superRefine((value, context) => {
  if (
    value.targetDigest !== canonicalDigest(value.target)
    || !sameCanonicalValue(value.retirementEntries, canonicalRetirements(value.retirementEntries))
    || new Set(value.retirementEntries.map((entry) =>
      `${entry.commandType}:${entry.commandPublicId}`))
      .size !== value.retirementEntries.length
    || value.retirementRequestDigest !== retirementDigest(value.retirementEntries)
  ) context.addIssue({ code: "custom", message: "retirement_intent_binding_invalid" });
});

export type CommandCapacityRetirementIntent = z.infer<
  typeof commandCapacityRetirementIntentSchema
>;

export const commandCapacityRetirementReceiptSchema = z.object({
  candidateDeployDigest: z.string().regex(digestPattern),
  completedAtMs: z.number().int().nonnegative().safe(),
  intentDigest: z.string().regex(digestPattern),
  kind: z.literal("command-capacity-retirement-receipt"),
  retirementEntries: z.array(explicitRetirement).min(1).max(maximumExplicitRetirements),
  retirementRequestDigest: z.string().regex(digestPattern),
  runtimeAttestation: runtimeReleaseAttestationSchema,
  schemaVersion: z.literal(1),
  selfDigest: z.string().regex(digestPattern),
  sourceCommit: z.string().regex(sourceCommitPattern),
  status: z.literal("completed"),
  target: convexTargetEvidenceSchema,
  targetDigest: z.string().regex(digestPattern),
}).strict().superRefine((value, context) => {
  if (
    value.targetDigest !== canonicalDigest(value.target)
    || !sameCanonicalValue(value.retirementEntries, canonicalRetirements(value.retirementEntries))
    || new Set(value.retirementEntries.map((entry) =>
      `${entry.commandType}:${entry.commandPublicId}`)).size !== value.retirementEntries.length
    || value.retirementRequestDigest !== retirementDigest(value.retirementEntries)
  ) context.addIssue({ code: "custom", message: "retirement_receipt_binding_invalid" });
});

export type CommandCapacityRetirementReceipt = z.infer<
  typeof commandCapacityRetirementReceiptSchema
>;

export const commandCapacityReadinessEvidenceSchema = z.object({
  authorityReductionServiceDebt: z.literal(0),
  authorityReductionUserCandidates: z.array(z.string().min(1).max(1_024)).max(
    pageSize,
  ),
  authorityReductionUserCandidatesTruncated: z.literal(false),
  authorityReductionUserDebt: z.literal(0),
  candidateDeployDigest: z.string().regex(digestPattern),
  completedAtMs: z.number().int().nonnegative().safe(),
  kind: z.literal("command-capacity-readiness"),
  legacyRevoked: z.number().int().nonnegative().safe(),
  lifecycleDebt: z.literal(0),
  operatorAbandoned: z.number().int().nonnegative().safe(),
  pendingPreparedDebt: z.literal(0),
  repairedLifecycle: z.number().int().nonnegative().safe(),
  repairedReceipts: z.number().int().nonnegative().safe(),
  retirementEntries: z.array(explicitRetirement).max(maximumExplicitRetirements),
  retirementIntentDigest: z.union([z.string().regex(digestPattern), z.null()]),
  retirementRequestDigest: z.string().regex(digestPattern),
  retirementRequests: z.number().int().min(0).max(maximumExplicitRetirements),
  retirementReceiptDigest: z.union([z.string().regex(digestPattern), z.null()]),
  runtimeRevision: z.string().uuid(),
  schemaVersion: z.literal(1),
  selfDigest: z.string().regex(digestPattern),
  sourceCommit: z.string().regex(sourceCommitPattern),
  status: z.literal("ready"),
  target: convexTargetEvidenceSchema,
  targetDigest: z.string().regex(digestPattern),
  terminalReceiptDebt: z.number().int().nonnegative().safe(),
  unsafeTerminalCleanupDebt: z.literal(0),
  verificationPasses: z.literal(2),
}).strict().superRefine((value, context) => {
  if (value.targetDigest !== canonicalDigest(value.target)) {
    context.addIssue({ code: "custom", message: "readiness_target_binding_invalid" });
  }
  if (
    value.retirementRequests !== value.retirementEntries.length
    || !sameCanonicalValue(value.retirementEntries, canonicalRetirements(value.retirementEntries))
    || new Set(value.retirementEntries.map((entry) =>
      `${entry.commandType}:${entry.commandPublicId}`))
      .size !== value.retirementEntries.length
    || value.retirementRequestDigest !== retirementDigest(value.retirementEntries)
    || (value.retirementEntries.length === 0) !== (value.retirementIntentDigest === null)
    || (value.retirementEntries.length === 0) !== (value.retirementReceiptDigest === null)
  ) {
    context.addIssue({ code: "custom", message: "readiness_retirement_binding_invalid" });
  }
});

export type CommandCapacityReadinessEvidence = z.infer<
  typeof commandCapacityReadinessEvidenceSchema
>;

const hostedCapacityReadinessSchema = z.object({
  activatedAt: z.number().int().nonnegative().safe(),
  candidateDeployDigest: z.string().regex(digestPattern),
  evidenceDigest: z.string().regex(digestPattern),
  lifecycleCapacityVersion: z.literal(commandLifecycleCapacityVersion),
  runtimeAttestation: runtimeReleaseAttestationSchema,
  schemaIdentity: z.literal("hra-command-capacity-readiness-v1"),
  schemaVersion: z.literal(1),
  targetDigest: z.string().regex(digestPattern),
}).strict();

const capacityActivationResultSchema = z.object({
  readiness: hostedCapacityReadinessSchema,
  replay: z.boolean(),
}).strict();

const capacityActivationReadbackSchema = z.object({
  readiness: hostedCapacityReadinessSchema,
}).strict();

export const commandCapacityActivationReceiptSchema = z.object({
  activatedAtMs: z.number().int().nonnegative().safe(),
  candidateDeployDigest: z.string().regex(digestPattern),
  capacityEvidenceDigest: z.string().regex(digestPattern),
  kind: z.literal("command-capacity-activation-receipt"),
  lifecycleCapacityVersion: z.literal(commandLifecycleCapacityVersion),
  runtimeAttestation: runtimeReleaseAttestationSchema,
  schemaVersion: z.literal(1),
  selfDigest: z.string().regex(digestPattern),
  sourceCommit: z.string().regex(sourceCommitPattern),
  status: z.literal("activated"),
  target: convexTargetEvidenceSchema,
  targetDigest: z.string().regex(digestPattern),
}).strict().superRefine((value, context) => {
  if (
    value.targetDigest !== canonicalDigest(value.target)
    || value.runtimeAttestation.runtimeSourceCommit !== value.sourceCommit
  ) context.addIssue({ code: "custom", message: "activation_receipt_binding_invalid" });
});

export type CommandCapacityActivationReceipt = z.infer<
  typeof commandCapacityActivationReceiptSchema
>;

type CapacityAction = "status" | "repair" | "diagnose-headroom";
type CapacityArguments = Readonly<{
  action: CapacityAction;
  deployEvidencePath: string;
  evidencePath?: string;
  explicitRetirements: readonly ExplicitRetirement[];
  retirementEvidencePath?: string;
  sourceCommit: string;
  target: ConvexTarget;
}>;
type CapacityFailureCode =
  | "authority_reduction_hard_quota"
  | "authority_reduction_orphan_cleanup_eligible"
  | "authority_reduction_orphan_cleanup_pending"
  | "authority_reduction_topology_blocked"
  | "headroom_diagnostic_incomplete"
  | "candidate_deploy_evidence_invalid"
  | "convex_target_refused"
  | "operation_binding_changed"
  | "provider_result_invalid"
  | "readiness_evidence_invalid"
  | "readiness_debt_remaining"
  | "release_attestation_invalid"
  | "source_changed"
  | "usage_invalid";

class CapacityOperatorError extends Error {
  constructor(readonly code: CapacityFailureCode) {
    super(code);
    this.name = "CapacityOperatorError";
  }
}

export type CommandCapacityResult = Readonly<{
  authorityReductionCapacityMissingDebt: number;
  authorityReductionHardQuotaBlockedThisRun: number;
  authorityReductionOrphanCleanupEligibleDebt: number;
  authorityReductionOrphanCleanupPendingDebt: number;
  authorityReductionRepairedThisRun: number;
  authorityReductionServiceDebt: number;
  authorityReductionTopologyBlockedDebt: number;
  authorityReductionUserCandidates: readonly string[];
  authorityReductionUserCandidatesTruncated: boolean;
  authorityReductionUserDebt: number;
  effectRetirementCandidates: readonly Readonly<{
    commandPublicId: string;
    commandType: z.infer<typeof commandType>;
    status: z.infer<typeof effectRetirementCandidate>["status"];
  }>[];
  effectRetirementCandidatesTruncated: boolean;
  evidenceDigest?: string;
  evidencePath?: string;
  activationReceiptDigest?: string;
  activationReceiptPath?: string;
  legacyRevoked: number;
  lifecycleDebt: number;
  noEffectRetirementCandidates: readonly Readonly<{
    commandPublicId: string;
    commandType: z.infer<typeof commandType>;
    state: "pending" | "prepared";
    status: z.infer<typeof noEffectRetirementCandidate>["status"];
  }>[];
  noEffectRetirementCandidatesTruncated: boolean;
  operatorAbandoned: number;
  pendingPreparedDebt: number;
  repairedLifecycle: number;
  repairedReceipts: number;
  replayed?: boolean;
  retirementIntentDigest?: string;
  retirementIntentPath?: string;
  retirementReceiptDigest?: string;
  retirementReceiptPath?: string;
  retirementRequests: number;
  state: "debt" | "ready";
  terminalReceiptDebt: number;
  unsafeTerminalCleanupDebt: number;
  verificationPasses: number;
}>;

const parseAbsolutePathArgument = (value: string | undefined): string => {
  if (value === undefined || !isAbsolute(value) || value.length > 4_096) {
    throw new CapacityOperatorError("usage_invalid");
  }
  return value;
};

const parseExplicitRetirement = (value: string | undefined): ExplicitRetirement => {
  if (value === undefined) throw new CapacityOperatorError("usage_invalid");
  const separator = value.indexOf(":");
  const type = commandType.safeParse(value.slice(0, separator));
  const commandPublicId = value.slice(separator + 1);
  if (separator < 1 || !type.success || !isUuidV7(commandPublicId)) {
    throw new CapacityOperatorError("usage_invalid");
  }
  return {
    commandPublicId,
    commandType: type.data,
    retirementKind: "effect_started",
  };
};

const parseExplicitNoEffectRetirement = (value: string | undefined): ExplicitRetirement => ({
  ...parseExplicitRetirement(value),
  retirementKind: "no_effect_expired",
});

export function parseCommandCapacityArguments(arguments_: readonly string[]): CapacityArguments {
  let parsed: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsed = parseConvexTargetArguments(arguments_);
  } catch {
    throw new CapacityOperatorError("usage_invalid");
  }
  const values = [...parsed.otherArguments];
  const action = values.shift();
  if (action !== "status" && action !== "repair" && action !== "diagnose-headroom") {
    throw new CapacityOperatorError("usage_invalid");
  }
  let acknowledge = false;
  let acknowledgeRetirement = false;
  let deployEvidencePath: string | undefined;
  let evidencePath: string | undefined;
  let retirementEvidencePath: string | undefined;
  let execute = false;
  const explicitRetirements: ExplicitRetirement[] = [];
  let sourceCommit: string | undefined;
  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    const value = values[index + 1];
    if (argument === "--source-commit" && sourceCommit === undefined) {
      if (value === undefined || !sourceCommitPattern.test(value)) {
        throw new CapacityOperatorError("usage_invalid");
      }
      sourceCommit = value;
      index += 1;
      continue;
    }
    if (argument === "--deploy-evidence" && deployEvidencePath === undefined) {
      deployEvidencePath = parseAbsolutePathArgument(value);
      index += 1;
      continue;
    }
    if (argument === "--evidence-path" && evidencePath === undefined) {
      evidencePath = parseAbsolutePathArgument(value);
      index += 1;
      continue;
    }
    if (
      argument === "--retirement-evidence-path"
      && retirementEvidencePath === undefined
    ) {
      retirementEvidencePath = parseAbsolutePathArgument(value);
      index += 1;
      continue;
    }
    if (argument === "--execute" && !execute) {
      execute = true;
      continue;
    }
    if (argument === "--acknowledge-forward-only" && !acknowledge) {
      acknowledge = true;
      continue;
    }
    if (
      argument === "--acknowledge-resultless-ambiguous-retirement"
      && !acknowledgeRetirement
    ) {
      acknowledgeRetirement = true;
      continue;
    }
    if (argument === "--retire-effect-started") {
      explicitRetirements.push(parseExplicitRetirement(value));
      if (explicitRetirements.length > maximumExplicitRetirements) {
        throw new CapacityOperatorError("usage_invalid");
      }
      index += 1;
      continue;
    }
    if (argument === "--retire-no-effect-expired") {
      explicitRetirements.push(parseExplicitNoEffectRetirement(value));
      if (explicitRetirements.length > maximumExplicitRetirements) {
        throw new CapacityOperatorError("usage_invalid");
      }
      index += 1;
      continue;
    }
    throw new CapacityOperatorError("usage_invalid");
  }
  const protectedPaths = [
    ...(deployEvidencePath === undefined ? [] : [deployEvidencePath]),
    ...(evidencePath === undefined ? [] : [evidencePath, `${evidencePath}.activated`]),
    ...(retirementEvidencePath === undefined
      ? []
      : [retirementEvidencePath, `${retirementEvidencePath}.intent`]),
  ];
  if (
    sourceCommit === undefined
    || deployEvidencePath === undefined
    || new Set(explicitRetirements.map((entry) =>
      `${entry.commandType}:${entry.commandPublicId}`))
      .size !== explicitRetirements.length
    || (action !== "repair" && (
      execute
      || acknowledge
      || acknowledgeRetirement
      || evidencePath !== undefined
      || retirementEvidencePath !== undefined
      || explicitRetirements.length !== 0
    ))
    || (action === "repair" && (!execute || !acknowledge || evidencePath === undefined))
    || (action === "repair"
      && acknowledgeRetirement !== (retirementEvidencePath !== undefined))
    || (explicitRetirements.length > 0 && retirementEvidencePath === undefined)
    || protectedPaths.some((path) => path.length > 4_096)
    || new Set(protectedPaths).size !== protectedPaths.length
  ) throw new CapacityOperatorError("usage_invalid");
  return {
    action,
    deployEvidencePath,
    ...(evidencePath === undefined ? {} : { evidencePath }),
    explicitRetirements,
    ...(retirementEvidencePath === undefined ? {} : { retirementEvidencePath }),
    sourceCommit,
    target: parsed.target,
  };
}

const parseProviderJson = <T>(stdout: string, schema: z.ZodType<T>): T => {
  if (
    stdout.trim().length === 0
    || Buffer.byteLength(stdout, "utf8") > providerOutputMaximumBytes
  ) throw new CapacityOperatorError("provider_result_invalid");
  try {
    return schema.parse(JSON.parse(stdout) as unknown);
  } catch {
    throw new CapacityOperatorError("provider_result_invalid");
  }
};

type ScanTotals = Readonly<{
  authorityReductionCapacityMissingDebt: number;
  authorityReductionHardQuotaBlockedThisRun: number;
  authorityReductionOrphanCleanupEligibleDebt: number;
  authorityReductionOrphanCleanupPendingDebt: number;
  authorityReductionRepairedThisRun: number;
  authorityReductionServiceDebt: number;
  authorityReductionTopologyBlockedDebt: number;
  authorityReductionUserCandidates: CommandCapacityResult[
    "authorityReductionUserCandidates"
  ];
  authorityReductionUserCandidatesTruncated: boolean;
  authorityReductionUserDebt: number;
  effectRetirementCandidates: CommandCapacityResult["effectRetirementCandidates"];
  effectRetirementCandidatesTruncated: boolean;
  legacyRevoked: number;
  lifecycleDebt: number;
  noEffectRetirementCandidates: CommandCapacityResult["noEffectRetirementCandidates"];
  noEffectRetirementCandidatesTruncated: boolean;
  operatorAbandoned: number;
  pendingPreparedDebt: number;
  repairedLifecycle: number;
  repairedReceipts: number;
  terminalReceiptDebt: number;
  unsafeTerminalCleanupDebt: number;
}>;

type ReleaseAttestationReader = (
  target: ConvexTarget,
) => Promise<RuntimeReleaseAttestation>;

const releaseAttestationFunction = makeFunctionReference<
  "query",
  Record<string, never>,
  unknown
>("releaseAttestation:read");

const readRuntimeReleaseAttestation = (
  fetcher: AuthorityFetcher,
): ReleaseAttestationReader => async (target) => {
  const client = new ConvexHttpClient(target.deploymentUrl, {
    fetch: createBoundedAuthorityFetch(
      fetcher,
      releaseAttestationTimeoutMs,
      "convex_release_attestation_timeout",
    ),
    logger: false,
  });
  try {
    return runtimeReleaseAttestationSchema.parse(
      await client.query(releaseAttestationFunction, {}),
    );
  } catch {
    throw new CapacityOperatorError("release_attestation_invalid");
  }
};

const sameCanonicalValue = (left: unknown, right: unknown): boolean =>
  canonicalDigest(left) === canonicalDigest(right);

const checkoutTransformConfigPattern =
  /^(?:filter\.|core\.(?:attributesfile|autocrlf|eol|symlinks)$)/u;

const assertNoCheckoutTransformConfig = (document: string): void => {
  for (const entry of document.split("\0")) {
    if (entry === "") continue;
    const separator = entry.indexOf("\n");
    if (separator <= 0) throw new CapacityOperatorError("source_changed");
    const name = entry.slice(0, separator).toLowerCase();
    const value = entry.slice(separator + 1);
    if (name === "core.attributesfile" && value === "/dev/null") continue;
    if (checkoutTransformConfigPattern.test(name)) {
      throw new CapacityOperatorError("source_changed");
    }
  }
};

const assertTransparentIndex = (document: string): void => {
  const entries = document.split("\0").filter(Boolean);
  if (entries.some((entry) => entry[0] === "S" || /^[a-z]$/u.test(entry[0] ?? ""))) {
    throw new CapacityOperatorError("source_changed");
  }
};

type TrackedBlob = Readonly<{
  mode: "100644" | "100755" | "120000";
  objectId: string;
  path: string;
}>;

const parseCommittedTree = (document: string): ReadonlyMap<string, TrackedBlob> => {
  const tracked = new Map<string, TrackedBlob>();
  for (const entry of document.split("\0")) {
    if (entry === "") continue;
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([\s\S]+)$/u.exec(entry);
    if (match === null) throw new CapacityOperatorError("source_changed");
    const mode = match[1] as TrackedBlob["mode"];
    const objectId = match[2] as string;
    const path = match[3] as string;
    if (tracked.has(path)) throw new CapacityOperatorError("source_changed");
    tracked.set(path, Object.freeze({ mode, objectId, path }));
  }
  if (tracked.size === 0) throw new CapacityOperatorError("source_changed");
  return tracked;
};

const parseIndexTree = (document: string): ReadonlyMap<string, TrackedBlob> => {
  const tracked = new Map<string, TrackedBlob>();
  for (const entry of document.split("\0")) {
    if (entry === "") continue;
    const match = /^(100644|100755|120000) ([0-9a-f]{40}) 0\t([\s\S]+)$/u.exec(entry);
    if (match === null) throw new CapacityOperatorError("source_changed");
    const mode = match[1] as TrackedBlob["mode"];
    const objectId = match[2] as string;
    const path = match[3] as string;
    if (tracked.has(path)) throw new CapacityOperatorError("source_changed");
    tracked.set(path, Object.freeze({ mode, objectId, path }));
  }
  return tracked;
};

const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size
  && left.ctimeMs === right.ctimeMs
  && left.mtimeMs === right.mtimeMs;

const gitBlobDigest = (
  size: number,
  update: (hash: ReturnType<typeof createHash>) => void,
): string => {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new CapacityOperatorError("source_changed");
  }
  const hash = createHash("sha1");
  hash.update(`blob ${String(size)}\0`, "utf8");
  update(hash);
  return hash.digest("hex");
};

const rawTrackedBlobDigest = (root: string, tracked: TrackedBlob): string => {
  if (tracked.path === "" || isAbsolute(tracked.path)) {
    throw new CapacityOperatorError("source_changed");
  }
  const path = resolve(root, tracked.path);
  if (
    path === root
    || !path.startsWith(`${root}${sep}`)
    || realpathSync(dirname(path)) !== dirname(path)
  ) throw new CapacityOperatorError("source_changed");
  const initial = lstatSync(path);
  if (tracked.mode === "120000") {
    if (!initial.isSymbolicLink()) throw new CapacityOperatorError("source_changed");
    const target = readlinkSync(path, { encoding: "buffer" });
    const final = lstatSync(path);
    if (target.byteLength !== initial.size || !sameFileIdentity(initial, final)) {
      throw new CapacityOperatorError("source_changed");
    }
    return gitBlobDigest(target.byteLength, (hash) => { hash.update(target); });
  }
  const executable = (initial.mode & 0o111) !== 0;
  if (
    !initial.isFile()
    || initial.isSymbolicLink()
    || executable !== (tracked.mode === "100755")
  ) throw new CapacityOperatorError("source_changed");
  let descriptor = -1;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const opened = fstatSync(descriptor);
    if (!sameFileIdentity(initial, opened) || !opened.isFile()) {
      throw new CapacityOperatorError("source_changed");
    }
    return gitBlobDigest(opened.size, (hash) => {
      const buffer = Buffer.allocUnsafe(sourceHashReadBytes);
      let remaining = opened.size;
      while (remaining > 0) {
        const count = readSync(
          descriptor,
          buffer,
          0,
          Math.min(buffer.byteLength, remaining),
          null,
        );
        if (count <= 0) throw new CapacityOperatorError("source_changed");
        hash.update(buffer.subarray(0, count));
        remaining -= count;
      }
      const final = fstatSync(descriptor);
      if (!sameFileIdentity(opened, final)) {
        throw new CapacityOperatorError("source_changed");
      }
    });
  } finally {
    if (descriptor >= 0) closeSync(descriptor);
  }
};

const assertRawTrackedSource = (
  root: string,
  committed: ReadonlyMap<string, TrackedBlob>,
  index: ReadonlyMap<string, TrackedBlob>,
): void => {
  if (committed.size !== index.size) throw new CapacityOperatorError("source_changed");
  for (const [path, tracked] of committed) {
    const indexed = index.get(path);
    if (
      indexed === undefined
      || indexed.mode !== tracked.mode
      || indexed.objectId !== tracked.objectId
      || rawTrackedBlobDigest(root, tracked) !== tracked.objectId
    ) throw new CapacityOperatorError("source_changed");
  }
};

type CapacityOptions = Readonly<{
  action: CapacityAction;
  authorityFetch?: AuthorityFetcher;
  deployEvidencePath: string;
  environment?: Readonly<NodeJS.ProcessEnv>;
  evidencePath?: string;
  explicitRetirements?: readonly ExplicitRetirement[];
  now?: () => number;
  prepareProviderSource?: (options: Readonly<{
    environment: Readonly<Record<string, string>>;
    repositoryRoot: string;
    runner: CommandRunner;
    sourceCommit: string;
  }>) => Promise<HostedOperationSourceBinding>;
  readAttestation?: ReleaseAttestationReader;
  repositoryRoot?: string;
  retirementEvidencePath?: string;
  runner?: CommandRunner;
  runtimeVersion?: string;
  sourceCommit: string;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

export function manageCommandLifecycleCapacity(
  options: CapacityOptions & Readonly<{ action: "diagnose-headroom" }>,
): Promise<CommandHeadroomDiagnosticResult>;
export function manageCommandLifecycleCapacity(
  options: CapacityOptions & Readonly<{ action: "repair" | "status" }>,
): Promise<CommandCapacityResult>;
export function manageCommandLifecycleCapacity(
  options: CapacityOptions,
): Promise<CommandCapacityResult | CommandHeadroomDiagnosticResult>;
export async function manageCommandLifecycleCapacity(
  options: CapacityOptions,
): Promise<CommandCapacityResult | CommandHeadroomDiagnosticResult> {
  const requestedRetirements = options.explicitRetirements ?? [];
  const protectedPaths = [
    options.deployEvidencePath,
    ...(options.evidencePath === undefined
      ? []
      : [options.evidencePath, `${options.evidencePath}.activated`]),
    ...(options.retirementEvidencePath === undefined
      ? []
      : [options.retirementEvidencePath, `${options.retirementEvidencePath}.intent`]),
  ];
  if (
    !["status", "repair", "diagnose-headroom"].includes(options.action)
    || !sourceCommitPattern.test(options.sourceCommit)
    || !isAbsolute(options.deployEvidencePath)
    || (options.action === "repair"
      && (options.evidencePath === undefined || !isAbsolute(options.evidencePath)))
    || (options.action !== "repair" && options.evidencePath !== undefined)
    || (options.action !== "repair" && options.retirementEvidencePath !== undefined)
    || (options.action !== "repair" && requestedRetirements.length !== 0)
    || (options.retirementEvidencePath !== undefined
      && !isAbsolute(options.retirementEvidencePath))
    || (requestedRetirements.length > 0 && options.retirementEvidencePath === undefined)
    || requestedRetirements.length > maximumExplicitRetirements
    || new Set(requestedRetirements.map((entry) =>
      `${entry.commandType}:${entry.commandPublicId}`)).size !== requestedRetirements.length
    || requestedRetirements.some((entry) =>
      !commandType.options.includes(entry.commandType)
      || !isUuidV7(entry.commandPublicId)
      || !["effect_started", "no_effect_expired"].includes(entry.retirementKind))
    || protectedPaths.some((path) => path.length > 4_096)
    || new Set(protectedPaths).size !== protectedPaths.length
  ) throw new CapacityOperatorError("usage_invalid");
  const target = parseConvexTarget(options.target);
  const runner = options.runner ?? runCommand;
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  const sourceRoot = options.repositoryRoot ?? repositoryRoot;
  const readAttestation = options.readAttestation
    ?? readRuntimeReleaseAttestation(options.authorityFetch ?? fetch);
  const environment = buildConvexChildEnvironment(options.environment ?? process.env, []);
  let explicitRetirements = canonicalRetirements(requestedRetirements);
  let retirementRequestDigest = retirementDigest(explicitRetirements);
  const guard = new BoundedProcessInvocationGuard();
  const invokeGit = async (
    arguments_: readonly string[],
    phase: string,
    outputMaximumBytes = gitOutputMaximumBytes,
  ): Promise<CommandResult> => await guard.observe(async () => await runner({
    arguments: ["--no-replace-objects", ...arguments_],
    containment: "local",
    cwd: sourceRoot,
    environment,
    executable: "/usr/bin/git",
    outputMaximumBytes,
    phase,
    stdin: "",
    timeoutMs: providerTimeoutMs,
  }));
  const requireGitOutput = async (
    arguments_: readonly string[],
    phase: string,
    outputMaximumBytes = gitOutputMaximumBytes,
  ): Promise<string> => {
    const result = await invokeGit(arguments_, phase, outputMaximumBytes);
    if (
      result.exitCode !== 0
      || result.stderr !== ""
      || Buffer.byteLength(result.stdout, "utf8") > outputMaximumBytes
    ) throw new CapacityOperatorError("source_changed");
    return result.stdout;
  };
  const requireExactSource = async (): Promise<void> => {
    try {
      if (realpathSync(sourceRoot) !== sourceRoot) {
        throw new CapacityOperatorError("source_changed");
      }
      if ((await requireGitOutput(
        ["rev-parse", "--show-toplevel"],
        "command-capacity-source-root",
      )).trim() !== sourceRoot) throw new CapacityOperatorError("source_changed");
      if ((await requireGitOutput(
        ["rev-parse", "--verify", "HEAD^{commit}"],
        "command-capacity-source-head",
      )).trim() !== options.sourceCommit) throw new CapacityOperatorError("source_changed");
      if ((await requireGitOutput(
        ["rev-parse", "--show-object-format"],
        "command-capacity-source-object-format",
      )).trim() !== "sha1") throw new CapacityOperatorError("source_changed");
      assertNoCheckoutTransformConfig(await requireGitOutput(
        ["config", "--null", "--list"],
        "command-capacity-source-config",
        sourceManifestMaximumBytes,
      ));
      if (await requireGitOutput(
        ["status", "--porcelain=v1", "--untracked-files=all"],
        "command-capacity-source-status",
      ) !== "") throw new CapacityOperatorError("source_changed");
      assertTransparentIndex(await requireGitOutput(
        ["ls-files", "-v", "-z"],
        "command-capacity-source-index-flags",
        sourceManifestMaximumBytes,
      ));
      const committed = parseCommittedTree(await requireGitOutput(
        ["ls-tree", "-r", "-z", "--full-tree", options.sourceCommit],
        "command-capacity-source-committed-tree",
        sourceManifestMaximumBytes,
      ));
      const index = parseIndexTree(await requireGitOutput(
        ["ls-files", "--stage", "-z"],
        "command-capacity-source-index-tree",
        sourceManifestMaximumBytes,
      ));
      assertRawTrackedSource(sourceRoot, committed, index);
    } catch (error: unknown) {
      if (error instanceof CapacityOperatorError && error.code === "source_changed") throw error;
      throw new CapacityOperatorError("source_changed");
    }
  };
  let candidate: DeployEvidence;
  try {
    candidate = parseDeployEvidenceFile(options.deployEvidencePath, {
      recoverInterruptedPublication: true,
    });
  } catch {
    throw new CapacityOperatorError("candidate_deploy_evidence_invalid");
  }
  const targetDigest = canonicalDigest(target);
  if (
    candidate.phase !== "candidate"
    || candidate.sourceCommit !== options.sourceCommit
    || candidate.targetDigest !== targetDigest
    || !sameCanonicalValue(candidate.target, target)
  ) throw new CapacityOperatorError("candidate_deploy_evidence_invalid");
  const candidateDeployDigest = candidate.selfDigest;
  const retirementReceiptPath = options.retirementEvidencePath;
  const retirementIntentPath = retirementReceiptPath === undefined
    ? undefined
    : `${retirementReceiptPath}.intent`;
  let existingIntent: CommandCapacityRetirementIntent | undefined;
  if (retirementIntentPath !== undefined) {
    try {
      existingIntent = readProtectedJson(
        retirementIntentPath,
        commandCapacityRetirementIntentSchema,
        { recoverInterruptedPublication: true },
      );
    } catch (error: unknown) {
      if (
        !(error instanceof ReleaseEvidenceError)
        || error.code !== "evidence_not_found"
      ) throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    if (existingIntent !== undefined) {
      if (requestedRetirements.length === 0) {
        explicitRetirements = existingIntent.retirementEntries;
        retirementRequestDigest = retirementDigest(explicitRetirements);
      }
      if (
        existingIntent.candidateDeployDigest !== candidateDeployDigest
        || existingIntent.sourceCommit !== options.sourceCommit
        || !sameCanonicalValue(existingIntent.runtimeAttestation, candidate.after)
        || existingIntent.retirementRequestDigest !== retirementRequestDigest
        || !sameCanonicalValue(existingIntent.retirementEntries, explicitRetirements)
        || existingIntent.targetDigest !== targetDigest
        || !sameCanonicalValue(existingIntent.target, target)
      ) throw new CapacityOperatorError("readiness_evidence_invalid");
    }
  }
  const retirementIntent = explicitRetirements.length === 0
    ? undefined
    : commandCapacityRetirementIntentSchema.parse(withSelfDigest({
        candidateDeployDigest,
        kind: "command-capacity-retirement-intent" as const,
        retirementEntries: explicitRetirements,
        retirementRequestDigest,
        runtimeAttestation: candidate.after,
        schemaVersion: 1 as const,
        sourceCommit: options.sourceCommit,
        target,
        targetDigest,
      }));
  if (
    existingIntent !== undefined
    && (retirementIntent === undefined || !sameCanonicalValue(existingIntent, retirementIntent))
  ) throw new CapacityOperatorError("readiness_evidence_invalid");
  if (
    retirementReceiptPath !== undefined
    && existingIntent === undefined
    && retirementIntent === undefined
  ) throw new CapacityOperatorError("usage_invalid");
  const retirementIntentDigest = retirementIntent?.selfDigest ?? null;
  let existingRetirementReceipt: CommandCapacityRetirementReceipt | undefined;
  if (retirementReceiptPath !== undefined) {
    try {
      existingRetirementReceipt = readProtectedJson(
        retirementReceiptPath,
        commandCapacityRetirementReceiptSchema,
        { recoverInterruptedPublication: true },
      );
    } catch (error: unknown) {
      if (
        !(error instanceof ReleaseEvidenceError)
        || error.code !== "evidence_not_found"
      ) throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    if (existingRetirementReceipt !== undefined && (
      retirementIntent === undefined
      || existingRetirementReceipt.candidateDeployDigest !== candidateDeployDigest
      || existingRetirementReceipt.intentDigest !== retirementIntent.selfDigest
      || existingRetirementReceipt.sourceCommit !== options.sourceCommit
      || !sameCanonicalValue(existingRetirementReceipt.runtimeAttestation, candidate.after)
      || existingRetirementReceipt.retirementRequestDigest !== retirementRequestDigest
      || !sameCanonicalValue(
        existingRetirementReceipt.retirementEntries,
        explicitRetirements,
      )
      || existingRetirementReceipt.targetDigest !== targetDigest
      || !sameCanonicalValue(existingRetirementReceipt.target, target)
    )) throw new CapacityOperatorError("readiness_evidence_invalid");
  }
  let retirementReceiptDigest = existingRetirementReceipt?.selfDigest;
  let existingEvidence: CommandCapacityReadinessEvidence | undefined;
  if (options.evidencePath !== undefined) {
    try {
      existingEvidence = readProtectedJson(
        options.evidencePath,
        commandCapacityReadinessEvidenceSchema,
        { recoverInterruptedPublication: true },
      );
    } catch (error: unknown) {
      if (
        !(error instanceof ReleaseEvidenceError)
        || error.code !== "evidence_not_found"
      ) throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    if (existingEvidence !== undefined) {
      if (requestedRetirements.length === 0 && existingIntent === undefined) {
        if (existingEvidence.retirementEntries.length !== 0) {
          throw new CapacityOperatorError("readiness_evidence_invalid");
        }
        explicitRetirements = existingEvidence.retirementEntries;
        retirementRequestDigest = retirementDigest(explicitRetirements);
      }
      if (
        existingEvidence.candidateDeployDigest !== candidateDeployDigest
        || existingEvidence.sourceCommit !== options.sourceCommit
        || existingEvidence.runtimeRevision !== candidate.after.runtimeRevision
        || existingEvidence.retirementRequestDigest !== retirementRequestDigest
        || existingEvidence.retirementRequests !== explicitRetirements.length
        || !sameCanonicalValue(existingEvidence.retirementEntries, explicitRetirements)
        || existingEvidence.retirementIntentDigest !== retirementIntentDigest
        || existingEvidence.retirementReceiptDigest !== (retirementReceiptDigest ?? null)
        || existingEvidence.targetDigest !== targetDigest
        || !sameCanonicalValue(existingEvidence.target, target)
      ) throw new CapacityOperatorError("readiness_evidence_invalid");
    }
  }
  const activationReceiptPath = options.evidencePath === undefined
    ? undefined
    : `${options.evidencePath}.activated`;
  let existingActivationReceipt: CommandCapacityActivationReceipt | undefined;
  if (activationReceiptPath !== undefined) {
    try {
      existingActivationReceipt = readProtectedJson(
        activationReceiptPath,
        commandCapacityActivationReceiptSchema,
        { recoverInterruptedPublication: true },
      );
    } catch (error: unknown) {
      if (
        !(error instanceof ReleaseEvidenceError)
        || error.code !== "evidence_not_found"
      ) throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    if (
      existingActivationReceipt !== undefined
      && (
        existingEvidence === undefined
        || existingActivationReceipt.candidateDeployDigest !== candidateDeployDigest
        || existingActivationReceipt.capacityEvidenceDigest !== existingEvidence.selfDigest
        || existingActivationReceipt.sourceCommit !== options.sourceCommit
        || !sameCanonicalValue(
          existingActivationReceipt.runtimeAttestation,
          candidate.after,
        )
        || existingActivationReceipt.targetDigest !== targetDigest
        || !sameCanonicalValue(existingActivationReceipt.target, target)
      )
    ) throw new CapacityOperatorError("readiness_evidence_invalid");
  }
  const requireExactCandidate = (): DeployEvidence => {
    let current: DeployEvidence;
    try {
      current = parseDeployEvidenceFile(options.deployEvidencePath, {
        recoverInterruptedPublication: true,
      });
    } catch {
      throw new CapacityOperatorError("candidate_deploy_evidence_invalid");
    }
    if (
      current.phase !== "candidate"
      || current.sourceCommit !== options.sourceCommit
      || current.selfDigest !== candidateDeployDigest
      || current.targetDigest !== targetDigest
      || !sameCanonicalValue(current.target, target)
      || !sameCanonicalValue(current.after, candidate.after)
    ) throw new CapacityOperatorError("operation_binding_changed");
    return current;
  };
  const proveBinding = async (): Promise<void> => {
    await requireExactSource();
    const current = requireExactCandidate();
    await guard.observe(async () => await verifyTarget(target));
    let runtime: RuntimeReleaseAttestation;
    try {
      runtime = await guard.observe(async () => await readAttestation(target));
    } catch (error: unknown) {
      if (error instanceof CapacityOperatorError) throw error;
      throw new CapacityOperatorError("release_attestation_invalid");
    } finally {
      await guard.observe(async () => await verifyTarget(target));
    }
    if (!sameCanonicalValue(runtime, current.after)) {
      throw new CapacityOperatorError("release_attestation_invalid");
    }
    requireExactCandidate();
    await requireExactSource();
  };
  if ((options.runtimeVersion ?? Bun.version) !== supportedBunVersion) {
    throw new CapacityOperatorError("source_changed");
  }
  let providerSource: HostedOperationSourceBinding;
  try {
    providerSource = await (
      options.prepareProviderSource ?? prepareHostedOperationSource
    )({
      environment,
      repositoryRoot: sourceRoot,
      runner,
      sourceCommit: options.sourceCommit,
    });
  } catch (error: unknown) {
    if (
      isBoundedProcessCleanupUnprovenError(error)
      || isBoundedProcessRecoveryJournalError(error)
    ) throw error;
    throw new CapacityOperatorError("source_changed");
  }
  guard.retainRecoveryPath(providerSource.recoveryPath);
  const requireProviderSourceExact = async (): Promise<void> => {
    try {
      await guard.observe(async () => await providerSource.revalidate());
    } catch (error: unknown) {
      if (
        isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error)
      ) throw error;
      throw new CapacityOperatorError("source_changed");
    }
  };
  try {
  const invoke = async (
    functionName: string,
    args: Readonly<Record<string, ValueForJson>>,
    phase: string,
  ): Promise<unknown> => {
    await guard.observe(async () => await verifyTarget(target));
    await requireProviderSourceExact();
    let authorityUnavailable = false;
    let custodyFailure = false;
    try {
      const result: CommandResult = await guard.observe(async () => await runner({
        arguments: [
          hostedOperationConvexCliPath(providerSource.path),
          "run",
          functionName,
          JSON.stringify(args),
          "--deployment",
          target.deploymentName,
        ],
        containment: "authority",
        cwd: providerSource.path,
        environment,
        executable: process.execPath,
        outputMaximumBytes: providerOutputMaximumBytes,
        phase,
        stdin: "",
        timeoutMs: providerTimeoutMs,
      }));
      if (result.exitCode !== 0) throw new CapacityOperatorError("provider_result_invalid");
      if (
        result.stdout.trim().length === 0
        || Buffer.byteLength(result.stdout, "utf8") > providerOutputMaximumBytes
      ) throw new CapacityOperatorError("provider_result_invalid");
      try {
        return JSON.parse(result.stdout) as unknown;
      } catch {
        throw new CapacityOperatorError("provider_result_invalid");
      }
    } catch (error: unknown) {
      authorityUnavailable = isAuthorityContainmentUnavailable(error);
      custodyFailure = isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error);
      throw error;
    } finally {
      if (!authorityUnavailable && !custodyFailure) {
        await requireProviderSourceExact();
      }
      if (!authorityUnavailable && !custodyFailure) {
        await guard.observe(async () => await verifyTarget(target));
      }
    }
  };

  const invokeParsed = async <T>(
    functionName: string,
    args: Readonly<Record<string, ValueForJson>>,
    phase: string,
    schema: z.ZodType<T>,
  ): Promise<T> => parseProviderJson(JSON.stringify(
    await invoke(functionName, args, phase),
  ), schema);

  const activateAndPublish = async (
    evidence: CommandCapacityReadinessEvidence,
  ): Promise<CommandCapacityActivationReceipt> => {
    const evidencePath = options.evidencePath;
    if (evidencePath === undefined || activationReceiptPath === undefined) {
      throw new CapacityOperatorError("usage_invalid");
    }
    const requireExactReadinessEvidence = (): void => {
      let current: CommandCapacityReadinessEvidence;
      try {
        current = readProtectedJson(
          evidencePath,
          commandCapacityReadinessEvidenceSchema,
          { recoverInterruptedPublication: true },
        );
      } catch {
        throw new CapacityOperatorError("readiness_evidence_invalid");
      }
      if (!sameCanonicalValue(current, evidence)) {
        throw new CapacityOperatorError("readiness_evidence_invalid");
      }
    };
    const activationArgs = {
      candidateDeployDigest,
      evidenceDigest: evidence.selfDigest,
      expectedRuntimeAttestation: candidate.after,
      lifecycleCapacityVersion: commandLifecycleCapacityVersion,
      targetDigest,
    } as const;
    guard.retainRecoveryPath(evidencePath);
    guard.retainRecoveryPath(activationReceiptPath);
    await proveBinding();
    requireExactReadinessEvidence();
    const activated = await invokeParsed(
      "commandLifecycle:activateCapacityReadiness",
      activationArgs,
      "command-capacity-activate",
      capacityActivationResultSchema,
    );
    await proveBinding();
    requireExactReadinessEvidence();
    const readback = await invokeParsed(
      "commandLifecycle:readCapacityReadiness",
      activationArgs,
      "command-capacity-activation-readback",
      capacityActivationReadbackSchema,
    );
    if (
      !sameCanonicalValue(activated.readiness, readback.readiness)
      || activated.readiness.candidateDeployDigest !== candidateDeployDigest
      || activated.readiness.evidenceDigest !== evidence.selfDigest
      || !sameCanonicalValue(activated.readiness.runtimeAttestation, candidate.after)
      || activated.readiness.targetDigest !== targetDigest
    ) throw new CapacityOperatorError("provider_result_invalid");
    await proveBinding();
    requireExactReadinessEvidence();
    const receipt = commandCapacityActivationReceiptSchema.parse(withSelfDigest({
      activatedAtMs: activated.readiness.activatedAt,
      candidateDeployDigest,
      capacityEvidenceDigest: evidence.selfDigest,
      kind: "command-capacity-activation-receipt" as const,
      lifecycleCapacityVersion: commandLifecycleCapacityVersion,
      runtimeAttestation: candidate.after,
      schemaVersion: 1 as const,
      sourceCommit: options.sourceCommit,
      status: "activated" as const,
      target,
      targetDigest,
    }));
    if (existingActivationReceipt === undefined) {
      writeProtectedJsonNoReplace(
        activationReceiptPath,
        receipt,
        commandCapacityActivationReceiptSchema,
        { allowExactReplay: false },
      );
    } else if (!sameCanonicalValue(existingActivationReceipt, receipt)) {
      throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    const currentReceipt = readProtectedJson(
      activationReceiptPath,
      commandCapacityActivationReceiptSchema,
      { recoverInterruptedPublication: true },
    );
    if (!sameCanonicalValue(currentReceipt, receipt)) {
      throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    await proveBinding();
    requireExactReadinessEvidence();
    return receipt;
  };

  const scanRows = async (repair: boolean): Promise<ScanTotals> => {
    let authorityReductionCapacityMissingDebt = 0;
    let authorityReductionHardQuotaBlockedThisRun = 0;
    let authorityReductionOrphanCleanupEligibleDebt = 0;
    let authorityReductionOrphanCleanupPendingDebt = 0;
    let authorityReductionRepairedThisRun = 0;
    let authorityReductionServiceDebt = 0;
    const authorityReductionUserCandidates: string[] = [];
    const authorityReductionUserCandidatesTruncated = false;
    let authorityReductionTopologyBlockedDebt = 0;
    let authorityReductionUserDebt = 0;
    const effectRetirementCandidates: Array<
      CommandCapacityResult["effectRetirementCandidates"][number]
    > = [];
    let effectRetirementCandidatesTruncated = false;
    const noEffectRetirementCandidates: Array<
      CommandCapacityResult["noEffectRetirementCandidates"][number]
    > = [];
    let noEffectRetirementCandidatesTruncated = false;
    let lifecycleDebt = 0;
    let pendingPreparedDebt = 0;
    let repairedLifecycle = 0;
    let repairedReceipts = 0;
    let terminalReceiptDebt = 0;
    let unsafeTerminalCleanupDebt = 0;
    let legacyRevoked = 0;
    let operatorAbandoned = 0;
    let headroomCursor: string | null = null;
    for (let pageNumber = 0; pageNumber < maximumPagesPerScope; pageNumber += 1) {
      const page: z.infer<typeof authorityReductionHeadroomPage> = await invokeParsed(
        "commandLifecycle:auditAuthorityReductionHeadroomPage",
        {
          expectedRuntimeAttestation: candidate.after,
          mode: repair ? "repair" : "audit",
          paginationOpts: { cursor: headroomCursor, numItems: pageSize },
        },
        "authority-reduction-headroom-audit",
        authorityReductionHeadroomPage,
      );
      if (page.mode !== (repair ? "repair" : "audit")) {
        throw new CapacityOperatorError("provider_result_invalid");
      }
      authorityReductionCapacityMissingDebt += page.capacityMissing;
      authorityReductionHardQuotaBlockedThisRun += page.hardQuotaBlocked;
      authorityReductionOrphanCleanupEligibleDebt += page.orphanCleanupEligible;
      authorityReductionOrphanCleanupPendingDebt += page.orphanCleanupPending;
      authorityReductionRepairedThisRun += page.repaired;
      authorityReductionTopologyBlockedDebt += page.topologyBlocked;
      const pageDebt = page.capacityMissing
        + page.hardQuotaBlocked
        + page.orphanCleanupEligible
        + page.orphanCleanupPending
        + page.topologyBlocked;
      authorityReductionUserDebt += pageDebt;
      if (pageDebt !== 0) authorityReductionServiceDebt = 1;
      if (page.isDone) break;
      if (page.continueCursor.length === 0 || page.continueCursor === headroomCursor) {
        throw new CapacityOperatorError("provider_result_invalid");
      }
      headroomCursor = page.continueCursor;
      if (pageNumber === maximumPagesPerScope - 1) {
        throw new CapacityOperatorError("provider_result_invalid");
      }
    }
    for (const type of commandType.options) {
      for (const state of nonterminalState.options) {
        let cursor: string | null = null;
        for (let pageNumber = 0; pageNumber < maximumPagesPerScope; pageNumber += 1) {
          const page: z.infer<typeof lifecyclePage> = await invokeParsed(
            "commandLifecycle:auditReservationPage",
            {
              commandType: type,
              expectedRuntimeAttestation: candidate.after,
              paginationOpts: { cursor, numItems: pageSize },
              state,
            },
            `command-capacity-audit-${type}-${state}`,
            lifecyclePage,
          );
          if (page.commandType !== type || page.state !== state) {
            throw new CapacityOperatorError("provider_result_invalid");
          }
          if (state === "effect_started") lifecycleDebt += page.unreserved.length;
          else pendingPreparedDebt += page.unreserved.length;
          for (const candidate of page.effectRetirement) {
            if (effectRetirementCandidates.length < pageSize) {
              effectRetirementCandidates.push({ ...candidate, commandType: type });
            } else {
              effectRetirementCandidatesTruncated = true;
            }
          }
          for (const candidate of page.noEffectRetirement) {
            if (state === "effect_started") {
              throw new CapacityOperatorError("provider_result_invalid");
            }
            if (noEffectRetirementCandidates.length < pageSize) {
              noEffectRetirementCandidates.push({
                ...candidate,
                commandType: type,
                state,
              });
            } else {
              noEffectRetirementCandidatesTruncated = true;
            }
          }
          if (repair) {
            for (const commandPublicId of page.unreserved) {
              const result = await invokeParsed(
                "commandLifecycle:reserveExisting",
                {
                  commandPublicId,
                  commandType: type,
                  expectedRuntimeAttestation: candidate.after,
                },
                `command-capacity-repair-${type}-${state}`,
                lifecycleRepair,
              );
              if (result.state === "reserved" || result.state === "terminalized") {
                repairedLifecycle += 1;
              }
            }
          }
          if (page.isDone) break;
          if (page.continueCursor.length === 0 || page.continueCursor === cursor) {
            throw new CapacityOperatorError("provider_result_invalid");
          }
          cursor = page.continueCursor;
          if (pageNumber === maximumPagesPerScope - 1) {
            throw new CapacityOperatorError("provider_result_invalid");
          }
        }
      }
      for (const state of terminalState.options) {
        let cursor: string | null = null;
        for (let pageNumber = 0; pageNumber < maximumPagesPerScope; pageNumber += 1) {
          const page: z.infer<typeof terminalPage> = await invokeParsed(
            "commandLifecycle:auditTerminalReceiptCapacityPage",
            {
              commandType: type,
              expectedRuntimeAttestation: candidate.after,
              paginationOpts: { cursor, numItems: pageSize },
              state,
            },
            `command-receipt-audit-${type}-${state}`,
            terminalPage,
          );
          if (page.commandType !== type || page.state !== state) {
            throw new CapacityOperatorError("provider_result_invalid");
          }
          terminalReceiptDebt += page.unreserved.length + page.unsafeCleanup.length;
          unsafeTerminalCleanupDebt += page.unsafeCleanup.length;
          legacyRevoked += page.legacyRevoked.length;
          operatorAbandoned += page.operatorAbandoned.length;
          if (repair) {
            for (const commandPublicId of page.unsafeCleanup) {
              const result = await invokeParsed(
                "commandLifecycle:normalizeLegacyTerminalReceipt",
                {
                  commandPublicId,
                  commandType: type,
                  expectedRuntimeAttestation: candidate.after,
                },
                `command-receipt-normalize-${type}-${state}`,
                terminalNormalization,
              );
              if (result.state === "normalized") repairedReceipts += 1;
            }
          }
          if (page.isDone) break;
          if (page.continueCursor.length === 0 || page.continueCursor === cursor) {
            throw new CapacityOperatorError("provider_result_invalid");
          }
          cursor = page.continueCursor;
          if (pageNumber === maximumPagesPerScope - 1) {
            throw new CapacityOperatorError("provider_result_invalid");
          }
        }
      }
    }
    return {
      authorityReductionCapacityMissingDebt,
      authorityReductionHardQuotaBlockedThisRun,
      authorityReductionOrphanCleanupEligibleDebt,
      authorityReductionOrphanCleanupPendingDebt,
      authorityReductionRepairedThisRun,
      authorityReductionServiceDebt,
      authorityReductionTopologyBlockedDebt,
      authorityReductionUserCandidates,
      authorityReductionUserCandidatesTruncated,
      authorityReductionUserDebt,
      effectRetirementCandidates,
      effectRetirementCandidatesTruncated,
      legacyRevoked,
      lifecycleDebt,
      noEffectRetirementCandidates,
      noEffectRetirementCandidatesTruncated,
      operatorAbandoned,
      pendingPreparedDebt,
      repairedLifecycle,
      repairedReceipts,
      terminalReceiptDebt,
      unsafeTerminalCleanupDebt,
    };
  };
  const scan = async (repair: boolean): Promise<ScanTotals> => {
    await proveBinding();
    try {
      return await scanRows(repair);
    } finally {
      await proveBinding();
    }
  };

  if (options.action === "diagnose-headroom") {
    await proveBinding();
    try {
      const totals = {
        capacityMissing: 0, evaluated: 0, orphanEligible: 0, orphanPending: 0,
        quotaAuthorityUnknown: 0, ready: 0, scanned: 0, topologyBlocked: 0,
      };
      const demand = { accountPairs: 0, deviceQuartets: 0, paddingBytesLowerBound: 0, totalRecords: 0 };
      const ceilings = emptyAuthorityReductionQuotaCeilings();
      const cursors = new Set<string>();
      let cursor: string | null = null;
      for (let pageIndex = 0; pageIndex < maximumHeadroomPages; pageIndex += 1) {
        const page: QuotaDiagnosticPage = await invokeParsed(
          "commandLifecycle:auditAuthorityReductionQuotaCeilingsPage",
          { expectedRuntimeAttestation: candidate.after, paginationOpts: { cursor, numItems: pageSize } },
          "command-capacity-headroom-diagnostic",
          authorityReductionQuotaDiagnosticPageSchema,
        );
        for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += page[key];
        if (totals.scanned > SERVICE_TOTAL_QUOTA.identities) {
          throw new CapacityOperatorError("headroom_diagnostic_incomplete");
        }
        for (const key of Object.keys(demand) as (keyof typeof demand)[]) demand[key] += page.demand[key];
        for (const key of AUTHORITY_REDUCTION_QUOTA_CEILINGS) {
          const target = ceilings[key];
          const source = page.ceilings[key];
          target.applicable += source.applicable;
          target.bytesBlockedByLowerBound += source.bytesBlockedByLowerBound;
          target.bytesUnknown += source.bytesUnknown;
          target.recordsBlocked += source.recordsBlocked;
        }
        if (page.isDone) {
          return {
            ...totals,
            activationAuthorized: false,
            byteCost: "padding_lower_bound_only",
            ceilings,
            consistency: "per_page_only",
            demand,
            kind: "authority_reduction_quota_diagnostic",
            pages: pageIndex + 1,
            repairAuthorized: false,
            schemaVersion: 1,
            state: "diagnostic_complete",
          };
        }
        if (page.continueCursor.length === 0 || cursors.has(page.continueCursor)) {
          throw new CapacityOperatorError("provider_result_invalid");
        }
        cursors.add(page.continueCursor);
        cursor = page.continueCursor;
      }
      throw new CapacityOperatorError("headroom_diagnostic_incomplete");
    } finally {
      // A poisoned owner must retain its original recovery error and archive;
      // a source recheck cannot replace uncertain collection with source drift.
      guard.assertMayProceed();
      await proveBinding();
    }
  }

  if (options.action === "status") {
    const observed = await scan(false);
    return {
      authorityReductionCapacityMissingDebt:
        observed.authorityReductionCapacityMissingDebt,
      authorityReductionHardQuotaBlockedThisRun:
        observed.authorityReductionHardQuotaBlockedThisRun,
      authorityReductionOrphanCleanupEligibleDebt:
        observed.authorityReductionOrphanCleanupEligibleDebt,
      authorityReductionOrphanCleanupPendingDebt:
        observed.authorityReductionOrphanCleanupPendingDebt,
      authorityReductionRepairedThisRun: 0,
      authorityReductionServiceDebt: observed.authorityReductionServiceDebt,
      authorityReductionTopologyBlockedDebt:
        observed.authorityReductionTopologyBlockedDebt,
      authorityReductionUserCandidates: observed.authorityReductionUserCandidates,
      authorityReductionUserCandidatesTruncated:
        observed.authorityReductionUserCandidatesTruncated,
      authorityReductionUserDebt: observed.authorityReductionUserDebt,
      effectRetirementCandidates: observed.effectRetirementCandidates,
      effectRetirementCandidatesTruncated: observed.effectRetirementCandidatesTruncated,
      legacyRevoked: observed.legacyRevoked,
      lifecycleDebt: observed.lifecycleDebt,
      noEffectRetirementCandidates: observed.noEffectRetirementCandidates,
      noEffectRetirementCandidatesTruncated:
        observed.noEffectRetirementCandidatesTruncated,
      operatorAbandoned: observed.operatorAbandoned,
      pendingPreparedDebt: observed.pendingPreparedDebt,
      repairedLifecycle: 0,
      repairedReceipts: 0,
      retirementRequests: 0,
      state: observed.authorityReductionServiceDebt === 0
        && observed.authorityReductionUserDebt === 0
        && observed.lifecycleDebt === 0
        && observed.pendingPreparedDebt === 0
        && observed.unsafeTerminalCleanupDebt === 0
        ? "ready"
        : "debt",
      terminalReceiptDebt: observed.terminalReceiptDebt,
      unsafeTerminalCleanupDebt: observed.unsafeTerminalCleanupDebt,
      verificationPasses: 1,
    };
  }

  if (existingEvidence !== undefined) {
    const first = await scan(false);
    const second = await scan(false);
    if (
      first.authorityReductionServiceDebt !== 0
      || first.authorityReductionUserDebt !== 0
      || first.lifecycleDebt !== 0
      || first.pendingPreparedDebt !== 0
      || first.unsafeTerminalCleanupDebt !== 0
      || second.authorityReductionServiceDebt !== 0
      || second.authorityReductionUserDebt !== 0
      || second.lifecycleDebt !== 0
      || second.pendingPreparedDebt !== 0
      || second.unsafeTerminalCleanupDebt !== 0
    ) throw new CapacityOperatorError("readiness_debt_remaining");
    await proveBinding();
    const evidencePath = options.evidencePath;
    if (evidencePath === undefined) throw new CapacityOperatorError("usage_invalid");
    let currentEvidence: CommandCapacityReadinessEvidence;
    try {
      currentEvidence = readProtectedJson(
        evidencePath,
        commandCapacityReadinessEvidenceSchema,
        { recoverInterruptedPublication: true },
      );
    } catch {
      throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    if (!sameCanonicalValue(currentEvidence, existingEvidence)) {
      throw new CapacityOperatorError("readiness_evidence_invalid");
    }
    const activationReceipt = await activateAndPublish(existingEvidence);
    return {
      activationReceiptDigest: activationReceipt.selfDigest,
      activationReceiptPath: `${evidencePath}.activated`,
      authorityReductionCapacityMissingDebt: 0,
      authorityReductionHardQuotaBlockedThisRun: 0,
      authorityReductionOrphanCleanupEligibleDebt: 0,
      authorityReductionOrphanCleanupPendingDebt: 0,
      authorityReductionRepairedThisRun: 0,
      authorityReductionServiceDebt: existingEvidence.authorityReductionServiceDebt,
      authorityReductionTopologyBlockedDebt: 0,
      authorityReductionUserCandidates:
        existingEvidence.authorityReductionUserCandidates,
      authorityReductionUserCandidatesTruncated:
        existingEvidence.authorityReductionUserCandidatesTruncated,
      authorityReductionUserDebt: existingEvidence.authorityReductionUserDebt,
      effectRetirementCandidates: second.effectRetirementCandidates,
      effectRetirementCandidatesTruncated: second.effectRetirementCandidatesTruncated,
      evidenceDigest: existingEvidence.selfDigest,
      evidencePath,
      legacyRevoked: existingEvidence.legacyRevoked,
      lifecycleDebt: 0,
      noEffectRetirementCandidates: second.noEffectRetirementCandidates,
      noEffectRetirementCandidatesTruncated:
        second.noEffectRetirementCandidatesTruncated,
      operatorAbandoned: existingEvidence.operatorAbandoned,
      pendingPreparedDebt: existingEvidence.pendingPreparedDebt,
      repairedLifecycle: existingEvidence.repairedLifecycle,
      repairedReceipts: existingEvidence.repairedReceipts,
      replayed: true,
      ...(retirementIntentDigest === null || retirementIntentPath === undefined
        ? {}
        : {
            retirementIntentDigest,
            retirementIntentPath,
          }),
      ...(retirementReceiptDigest === undefined || retirementReceiptPath === undefined
        ? {}
        : {
            retirementReceiptDigest,
            retirementReceiptPath,
          }),
      retirementRequests: existingEvidence.retirementRequests,
      state: "ready",
      terminalReceiptDebt: existingEvidence.terminalReceiptDebt,
      unsafeTerminalCleanupDebt: 0,
      verificationPasses: 2,
    };
  }

  if (retirementIntent !== undefined) {
    if (
      retirementIntentPath === undefined
      || retirementReceiptPath === undefined
      || options.evidencePath === undefined
    ) {
      throw new CapacityOperatorError("usage_invalid");
    }
    await proveBinding();
    if (existingIntent === undefined) {
      writeProtectedJsonNoReplace(
        retirementIntentPath,
        retirementIntent,
        commandCapacityRetirementIntentSchema,
        { allowExactReplay: false },
      );
    }
    guard.retainRecoveryPath(options.evidencePath);
    guard.retainRecoveryPath(retirementIntentPath);
    guard.retainRecoveryPath(retirementReceiptPath);
    const requireExactIntent = (): void => {
      let current: CommandCapacityRetirementIntent;
      try {
        current = readProtectedJson(
          retirementIntentPath,
          commandCapacityRetirementIntentSchema,
          { recoverInterruptedPublication: true },
        );
      } catch {
        throw new CapacityOperatorError("readiness_evidence_invalid");
      }
      if (!sameCanonicalValue(current, retirementIntent)) {
        throw new CapacityOperatorError("readiness_evidence_invalid");
      }
    };
    requireExactIntent();
    if (existingRetirementReceipt === undefined) {
      await proveBinding();
      for (const retirement of explicitRetirements) {
        requireExactIntent();
        await invokeParsed(
          retirement.retirementKind === "effect_started"
            ? "commandLifecycle:retireLegacyEffectStarted"
            : "commandLifecycle:retireLegacyNoEffectExpired",
          {
            acknowledgement: retirement.retirementKind === "effect_started"
              ? "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS"
              : "RETIRE_LEGACY_NO_EFFECT_AS_EXPIRED",
            commandPublicId: retirement.commandPublicId,
            commandType: retirement.commandType,
            expectedRuntimeAttestation: candidate.after,
          },
          `command-capacity-retire-${retirement.commandType}-${retirement.retirementKind}`,
          effectRetirement,
        );
      }
      await proveBinding();
      requireExactIntent();
      const receipt = commandCapacityRetirementReceiptSchema.parse(withSelfDigest({
        candidateDeployDigest,
        completedAtMs: (options.now ?? Date.now)(),
        intentDigest: retirementIntent.selfDigest,
        kind: "command-capacity-retirement-receipt" as const,
        retirementEntries: explicitRetirements,
        retirementRequestDigest,
        runtimeAttestation: candidate.after,
        schemaVersion: 1 as const,
        sourceCommit: options.sourceCommit,
        status: "completed" as const,
        target,
        targetDigest,
      }));
      writeProtectedJsonNoReplace(
        retirementReceiptPath,
        receipt,
        commandCapacityRetirementReceiptSchema,
        { allowExactReplay: false },
      );
      retirementReceiptDigest = receipt.selfDigest;
    } else {
      await proveBinding();
      requireExactIntent();
      const currentReceipt = readProtectedJson(
        retirementReceiptPath,
        commandCapacityRetirementReceiptSchema,
        { recoverInterruptedPublication: true },
      );
      if (!sameCanonicalValue(currentReceipt, existingRetirementReceipt)) {
        throw new CapacityOperatorError("readiness_evidence_invalid");
      }
    }
  }

  let repairedAuthorityReduction = 0;
  let repairedLifecycle = 0;
  let repairedReceipts = 0;
  for (let attempt = 0; attempt < maximumRepairPasses; attempt += 1) {
    const repaired = await scan(true);
    repairedAuthorityReduction += repaired.authorityReductionRepairedThisRun;
    repairedLifecycle += repaired.repairedLifecycle;
    repairedReceipts += repaired.repairedReceipts;
    if (repaired.authorityReductionHardQuotaBlockedThisRun !== 0) {
      throw new CapacityOperatorError("authority_reduction_hard_quota");
    }
    if (repaired.authorityReductionTopologyBlockedDebt !== 0) {
      throw new CapacityOperatorError("authority_reduction_topology_blocked");
    }
    if (repaired.authorityReductionOrphanCleanupEligibleDebt !== 0) {
      throw new CapacityOperatorError("authority_reduction_orphan_cleanup_eligible");
    }
    if (repaired.authorityReductionOrphanCleanupPendingDebt !== 0) {
      throw new CapacityOperatorError("authority_reduction_orphan_cleanup_pending");
    }
    const first = await scan(false);
    if (
      first.authorityReductionServiceDebt !== 0
      || first.authorityReductionUserDebt !== 0
      || first.lifecycleDebt !== 0
      || first.pendingPreparedDebt !== 0
      || first.unsafeTerminalCleanupDebt !== 0
    ) continue;
    const second = await scan(false);
    if (
      second.authorityReductionServiceDebt !== 0
      || second.authorityReductionUserDebt !== 0
      || second.lifecycleDebt !== 0
      || second.pendingPreparedDebt !== 0
      || second.unsafeTerminalCleanupDebt !== 0
    ) continue;
    await proveBinding();
    const evidencePath = options.evidencePath;
    if (evidencePath === undefined) throw new CapacityOperatorError("usage_invalid");
    const readinessEvidence = commandCapacityReadinessEvidenceSchema.parse(withSelfDigest({
      authorityReductionServiceDebt: 0 as const,
      authorityReductionUserCandidates: [],
      authorityReductionUserCandidatesTruncated: false as const,
      authorityReductionUserDebt: 0 as const,
      candidateDeployDigest,
      completedAtMs: (options.now ?? Date.now)(),
      kind: "command-capacity-readiness" as const,
      legacyRevoked: second.legacyRevoked,
      lifecycleDebt: 0 as const,
      operatorAbandoned: second.operatorAbandoned,
      pendingPreparedDebt: 0 as const,
      repairedLifecycle,
      repairedReceipts,
      retirementEntries: explicitRetirements,
      retirementIntentDigest,
      retirementRequestDigest,
      retirementRequests: explicitRetirements.length,
      retirementReceiptDigest: retirementReceiptDigest ?? null,
      runtimeRevision: candidate.after.runtimeRevision,
      schemaVersion: 1 as const,
      sourceCommit: options.sourceCommit,
      status: "ready" as const,
      target,
      targetDigest,
      terminalReceiptDebt: second.terminalReceiptDebt,
      unsafeTerminalCleanupDebt: 0 as const,
      verificationPasses: 2 as const,
    }));
    guard.retainRecoveryPath(evidencePath);
    writeProtectedJsonNoReplace(
      evidencePath,
      readinessEvidence,
      commandCapacityReadinessEvidenceSchema,
      { allowExactReplay: false },
    );
    const activationReceipt = await activateAndPublish(readinessEvidence);
    return {
      activationReceiptDigest: activationReceipt.selfDigest,
      activationReceiptPath: `${evidencePath}.activated`,
      authorityReductionCapacityMissingDebt: 0,
      authorityReductionHardQuotaBlockedThisRun: 0,
      authorityReductionOrphanCleanupEligibleDebt: 0,
      authorityReductionOrphanCleanupPendingDebt: 0,
      authorityReductionRepairedThisRun: repairedAuthorityReduction,
      authorityReductionServiceDebt: 0,
      authorityReductionTopologyBlockedDebt: 0,
      authorityReductionUserCandidates: [],
      authorityReductionUserCandidatesTruncated: false,
      authorityReductionUserDebt: 0,
      effectRetirementCandidates: second.effectRetirementCandidates,
      effectRetirementCandidatesTruncated: second.effectRetirementCandidatesTruncated,
      evidenceDigest: readinessEvidence.selfDigest,
      evidencePath,
      legacyRevoked: second.legacyRevoked,
      lifecycleDebt: 0,
      noEffectRetirementCandidates: second.noEffectRetirementCandidates,
      noEffectRetirementCandidatesTruncated:
        second.noEffectRetirementCandidatesTruncated,
      operatorAbandoned: second.operatorAbandoned,
      pendingPreparedDebt: second.pendingPreparedDebt,
      repairedLifecycle,
      repairedReceipts,
      replayed: false,
      ...(retirementIntentDigest === null || retirementIntentPath === undefined
        ? {}
        : {
            retirementIntentDigest,
            retirementIntentPath,
          }),
      ...(retirementReceiptDigest === undefined || retirementReceiptPath === undefined
        ? {}
        : {
            retirementReceiptDigest,
            retirementReceiptPath,
          }),
      retirementRequests: explicitRetirements.length,
      state: "ready",
      terminalReceiptDebt: second.terminalReceiptDebt,
      unsafeTerminalCleanupDebt: 0,
      verificationPasses: 2,
    };
  }
  throw new CapacityOperatorError("readiness_debt_remaining");
  } finally {
    if (options.action === "diagnose-headroom") guard.assertMayProceed();
    await providerSource.cleanup();
  }
}

type ValueForJson = null | boolean | number | string | readonly ValueForJson[] | {
  readonly [key: string]: ValueForJson;
};

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  authorityFetch?: AuthorityFetcher;
  environment?: Readonly<NodeJS.ProcessEnv>;
  now?: () => number;
  prepareProviderSource?: CapacityOptions["prepareProviderSource"];
  readAttestation?: ReleaseAttestationReader;
  repositoryRoot?: string;
  runner?: CommandRunner;
  runtimeVersion?: string;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeCommandLifecycleCapacity(options: ExecuteOptions): Promise<number> {
  try {
    const parsed = parseCommandCapacityArguments(options.arguments);
    const result = await manageCommandLifecycleCapacity({
      action: parsed.action,
      ...(options.authorityFetch === undefined
        ? {}
        : { authorityFetch: options.authorityFetch }),
      deployEvidencePath: parsed.deployEvidencePath,
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(parsed.evidencePath === undefined ? {} : { evidencePath: parsed.evidencePath }),
      explicitRetirements: parsed.explicitRetirements,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.prepareProviderSource === undefined
        ? {}
        : { prepareProviderSource: options.prepareProviderSource }),
      ...(options.readAttestation === undefined
        ? {}
        : { readAttestation: options.readAttestation }),
      ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
      ...(parsed.retirementEvidencePath === undefined
        ? {}
        : { retirementEvidencePath: parsed.retirementEvidencePath }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      ...(options.runtimeVersion === undefined ? {} : { runtimeVersion: options.runtimeVersion }),
      sourceCommit: parsed.sourceCommit,
      target: parsed.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(`${JSON.stringify({
      ...result,
      candidateDeployEvidence: parsed.deployEvidencePath,
      sourceCommit: parsed.sourceCommit,
      version: result.state === "diagnostic_complete" ? 1 : 2,
    })}\n`);
    return 0;
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      options.stderr.write(authorityUnavailable);
      return 1;
    }
    if (isBoundedProcessCleanupUnprovenError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_cleanup_unproven",
        phase: error.phase,
        processGroupId: error.processGroupId,
        processes: error.processes,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    if (isBoundedProcessRecoveryJournalError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_recovery_journal_blocked",
        reason: error.reason,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    const code = error instanceof CapacityOperatorError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : error instanceof ReleaseEvidenceError
          ? "readiness_evidence_invalid"
        : "provider_result_invalid";
    options.stderr.write(`Hosted command-capacity operation refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  const rawArguments = process.argv.slice(2);
  let recoveryPaths: readonly string[] = [];
  try {
    try {
      const parsed = parseCommandCapacityArguments(rawArguments);
      recoveryPaths = [
        ...(parsed.evidencePath === undefined
          ? []
          : [parsed.evidencePath, `${parsed.evidencePath}.activated`]),
        ...(parsed.retirementEvidencePath === undefined
          ? []
          : [parsed.retirementEvidencePath, `${parsed.retirementEvidencePath}.intent`]),
      ];
    } catch {
      // Argument validation remains authoritative after recovery completes.
    }
    try {
      await recoverBoundedProcessJournal();
    } catch (error: unknown) {
      let retained = error;
      for (const path of recoveryPaths) {
        retained = retainBoundedProcessRecoveryPath(retained, path);
      }
      throw retained;
    }
    exitCode = await executeCommandLifecycleCapacity({
      arguments: rawArguments,
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      process.stderr.write(authorityUnavailable);
      exitCode = 1;
    } else if (isBoundedProcessCleanupUnprovenError(error)) {
      process.stderr.write(`${JSON.stringify({
        code: "process_cleanup_unproven",
        phase: error.phase,
        processGroupId: error.processGroupId,
        processes: error.processes,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
    } else if (isBoundedProcessRecoveryJournalError(error)) {
      process.stderr.write(`${JSON.stringify({
        code: "process_recovery_journal_blocked",
        reason: error.reason,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
    } else {
      process.stderr.write("Hosted command-capacity operation refused (provider_result_invalid).\n");
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}
