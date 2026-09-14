import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isatty } from "node:tty";

import { dlopen } from "bun:ffi";
import { z } from "zod";

import { assertSafeDarwinInstallAcl } from "../src/install-normalizer";
import { proveDescriptorAclAbsence } from "../src/storage/descriptor-security";
import { createBoundedAuthorityFetch } from "./bounded-authority-fetch";
import { aliasInputMaximumBytes, readAliasInputBuffer } from "./alias-input-buffer";
import {
  BoundedProcessInvocationGuard,
  boundedProcessRecoveryDirectory,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
  rethrowBoundedProcessTerminalError,
  requireBoundedProcessCleanup,
  runBoundedProcess,
  type BoundedProcessContainment,
} from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
  rethrowAuthorityContainmentUnavailable,
} from "./authority-containment";
import {
  OOMPA_CONVEX_PROJECT_ID,
  OOMPA_CONVEX_TEAM_ID,
  parseConvexTarget,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  canonicalDigest,
  ensureProtectedDirectory,
  OOMPA_RELEASE_VERSION,
  OOMPA_REPOSITORY,
  OOMPA_REPOSITORY_ID,
  OOMPA_VERCEL_PROJECT_ID,
  OOMPA_VERCEL_TEAM_ID,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
} from "./release-evidence";

const canonicalAlias = "oompa.app";
const supportedBunVersion = "1.3.14";
const supportedVercelVersion = "58.4.0";
export const currentAliasReleaseReviewedLegacyOperatorProvenance = Object.freeze({
  bunVersion: supportedBunVersion,
  entrypointSha256: "29651058110e887ddc500e298308c98b947d8a683941146593b29a57760b9777",
  gitCommit: "fbf49ca9c0ee0b5f04a009c3ae4c85b94ac9e8df",
  sourceBlobOid: "5c98c061fe06883de73d6f237031f5d6018d4a68",
});
const commandTimeoutMs = 30_000;
const commandTerminationGraceMs = 1_000;
const convergenceTimeoutMs = 60_000;
const outputMaximumBytes = 128 * 1024;
const inputMaximumBytes = aliasInputMaximumBytes;
const markerMaximumBytes = 16 * 1024;
const vercelAuthMaximumBytes = 8 * 1024;
const vercelCredentialMinimumLifetimeSeconds = 15 * 60;
const vercelRequestTimeoutMs = 15_000;
const vercelApiOrigin = "https://api.vercel.com";

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const idempotencyKeySchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]{20,80}$/u);
const deploymentUrlSchema = z.string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u)
  .refine((value) => value.indexOf(".vercel.app") === value.length - ".vercel.app".length);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const gitBlobOidSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const providerIdentitySchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/u);
const aliasUidSchema = z.string().min(32).max(256).regex(/^[A-Za-z0-9_-]+$/u);
const releaseVersionEvidenceSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u);

const endpointSchema = z.object({
  deploymentId: deploymentIdSchema,
  deploymentUrl: deploymentUrlSchema,
  sourceCommit: commitSchema,
}).strict();

const currentCliSourceProvenanceSchema = z.object({
  actor: z.literal("cursor-cli"),
  gitCommitRef: z.literal("HEAD"),
  gitRootDirectory: z.literal(""),
  kind: z.literal("vercel-cli-public-marker"),
}).strict();

export const currentProjectAliasReleasePlanSchema = z.object({
  alias: z.literal(canonicalAlias),
  convex: z.object({
    deploymentId: z.number().int().positive().safe(),
    deploymentName: z.string()
      .min(5)
      .max(160)
      .regex(/^[a-z][a-z0-9]*-[a-z][a-z0-9]*-[0-9]+$/u),
    deploymentUrl: z.string().url(),
    projectId: z.literal(OOMPA_CONVEX_PROJECT_ID),
    teamId: z.literal(OOMPA_CONVEX_TEAM_ID),
  }).strict(),
  idempotencyKey: idempotencyKeySchema,
  kind: z.literal("current-project-canonical-alias"),
  repository: z.object({
    id: z.literal(OOMPA_REPOSITORY_ID),
    name: z.literal(OOMPA_REPOSITORY),
  }).strict(),
  schemaVersion: z.literal(1),
  vercel: z.object({
    projectId: z.literal(OOMPA_VERCEL_PROJECT_ID),
    source: endpointSchema,
    sourceProvenance: currentCliSourceProvenanceSchema.optional(),
    target: endpointSchema,
    teamId: z.literal(OOMPA_VERCEL_TEAM_ID),
  }).strict(),
  version: z.literal(OOMPA_RELEASE_VERSION),
}).strict().superRefine((plan, context) => {
  try {
    parseConvexTarget(plan.convex);
  } catch {
    context.addIssue({ code: "custom", message: "convex_target_invalid" });
  }
  if (
    plan.vercel.source.deploymentId === plan.vercel.target.deploymentId
    || plan.vercel.source.deploymentUrl === plan.vercel.target.deploymentUrl
    || plan.vercel.source.sourceCommit === plan.vercel.target.sourceCommit
  ) context.addIssue({ code: "custom", message: "alias_transition_invalid" });
});

export type CurrentProjectAliasReleasePlan = z.infer<
  typeof currentProjectAliasReleasePlanSchema
>;
export type CurrentProjectAliasEndpoint = z.infer<typeof endpointSchema>;

const aliasReadbackSchema = z.object({
  alias: z.literal(canonicalAlias),
  deployment: z.object({
    id: deploymentIdSchema,
    url: deploymentUrlSchema,
  }),
  deploymentId: deploymentIdSchema,
  projectId: z.literal(OOMPA_VERCEL_PROJECT_ID),
});

const aliasMutationReadbackSchema = z.object({
  alias: z.literal(canonicalAlias),
  created: z.union([
    z.number().int().nonnegative().safe(),
    z.string().datetime({ offset: true }),
  ]),
  oldDeploymentId: deploymentIdSchema.nullable().optional(),
  uid: z.string().min(1).max(256),
});

const recoveryAliasReadbackSchema = aliasReadbackSchema.extend({
  createdAt: z.number().int().nonnegative().safe(),
  uid: aliasUidSchema,
  updatedAt: z.number().int().nonnegative().safe(),
});

const deploymentAliasListSchema = z.object({
  aliases: z.array(z.object({
    alias: z.string().min(1).max(253),
    uid: aliasUidSchema,
  })).max(1_000),
});

const activityEntitySchema = z.object({
  end: z.number().int().nonnegative().safe(),
  start: z.number().int().nonnegative().safe(),
  type: z.string().min(1).max(64),
});

const aliasActivityEventSchema = z.object({
  categories: z.array(z.string().min(1).max(64)).max(16),
  created: z.number().int().nonnegative().safe(),
  createdAt: z.number().int().nonnegative().safe(),
  entities: z.array(activityEntitySchema).max(64),
  id: z.string().regex(/^uev_[A-Za-z0-9]{20,80}$/u),
  principal: z.object({ uid: providerIdentitySchema }),
  principalId: providerIdentitySchema,
  text: z.string().min(1).max(4_096),
  type: z.literal("aliases-assigned"),
  user: z.object({ uid: providerIdentitySchema }),
  userId: providerIdentitySchema,
}).strict();

const aliasActivityEventsSchema = z.object({
  events: z.array(aliasActivityEventSchema).max(100),
}).strict();

const deploymentReadbackBaseSchema = z.object({
  id: deploymentIdSchema,
  projectId: z.literal(OOMPA_VERCEL_PROJECT_ID),
  readyState: z.literal("READY"),
  target: z.literal("production"),
  url: deploymentUrlSchema,
});

const githubDeploymentReadbackSchema = deploymentReadbackBaseSchema.extend({
  gitSource: z.object({
    ref: z.literal("main"),
    repoId: z.literal(OOMPA_REPOSITORY_ID),
    sha: commitSchema,
    type: z.literal("github"),
  }),
  source: z.literal("git"),
});

const currentCliDeploymentReadbackSchema = deploymentReadbackBaseSchema.extend({
  gitSource: z.preprocess(
    (value) => value === undefined ? null : value,
    z.null(),
  ),
  meta: z.object({
    actor: z.literal("cursor-cli"),
    gitCommitRef: z.literal("HEAD"),
    gitCommitSha: commitSchema,
    gitRootDirectory: z.literal(""),
  }),
  source: z.literal("cli"),
});

const deploymentReadbackSchema = z.union([
  githubDeploymentReadbackSchema,
  currentCliDeploymentReadbackSchema,
]);

const projectReadbackSchema = z.object({
  accountId: z.literal(OOMPA_VERCEL_TEAM_ID),
  autoAssignCustomDomains: z.literal(false),
  id: z.literal(OOMPA_VERCEL_PROJECT_ID),
});

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

const vercelAccessTokenSchema = z.string()
  .min(1)
  .max(4_096)
  .regex(/^[!-~]+$/u)
  .refine((value) => !hasControlCharacter(value));

const vercelAuthSchema = z.object({
  expiresAt: z.number().int().positive().safe().optional(),
  token: vercelAccessTokenSchema,
});

const markerSchema = z.object({
  generation: z.literal(1),
  product: z.literal("Oompa"),
  repository: z.object({
    id: z.literal(OOMPA_REPOSITORY_ID),
    path: z.literal(OOMPA_REPOSITORY),
  }).strict(),
  schemaVersion: z.literal(2),
  source: z.object({ commit: commitSchema }).strict(),
  version: z.literal(OOMPA_RELEASE_VERSION),
}).strict();

const recoveryTargetMarkerSchema = z.object({
  generation: z.literal(1),
  product: z.literal("Oompa"),
  repository: z.object({
    id: z.literal(OOMPA_REPOSITORY_ID),
    path: z.literal(OOMPA_REPOSITORY),
  }).strict(),
  schemaVersion: z.literal(2),
  source: z.object({ commit: commitSchema }).strict(),
  version: releaseVersionEvidenceSchema,
}).strict();

const currentAliasReleaseRollbackDiagnosticSchema = z.object({
  phase: z.enum(["target_probe", "target_authority"]),
  reason: z.enum([
    "alias_not_planned",
    "marker_mismatch",
    "provider_command_failed",
    "provider_readback_invalid",
    "stability_not_proven",
    "vercel_version_unsupported",
  ]),
}).strict();
const mutationKeyForIdentity = (
  idempotencyKey: string,
  planDigest: string,
  effect: "assign-target" | "restore-source",
): string => canonicalDigest({ effect, idempotencyKey, planDigest });
const normalizedAliasAuthoritySchema = z.object({
  alias: z.literal(canonicalAlias),
  convex: z.object({
    deploymentId: z.number().int().positive().safe(),
    deploymentName: z.string(),
    deploymentUrl: z.string().url(),
    projectId: z.literal(OOMPA_CONVEX_PROJECT_ID),
    teamId: z.literal(OOMPA_CONVEX_TEAM_ID),
  }).strict(),
  marker: z.object({ generation: z.literal(1), sourceCommit: commitSchema }).strict(),
  project: z.object({
    accountId: z.literal(OOMPA_VERCEL_TEAM_ID),
    autoAssignCustomDomains: z.literal(false),
    id: z.literal(OOMPA_VERCEL_PROJECT_ID),
  }).strict(),
  repository: z.object({
    id: z.literal(OOMPA_REPOSITORY_ID),
    name: z.literal(OOMPA_REPOSITORY),
  }).strict(),
  source: endpointSchema,
  sourceProvenance: currentCliSourceProvenanceSchema.optional(),
  target: endpointSchema,
  version: z.literal(OOMPA_RELEASE_VERSION),
}).strict();

export const currentAliasReleaseIntentSchema = z.object({
  confirmationDigest: digestSchema,
  idempotencyKey: idempotencyKeySchema,
  kind: z.literal("current-project-canonical-alias-intent"),
  planDigest: digestSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceAuthority: normalizedAliasAuthoritySchema,
  sourceAuthorityDigest: digestSchema,
  sourceRecoveryKey: digestSchema,
  targetAuthorityDigest: digestSchema,
  targetMutationKey: digestSchema,
}).strict().superRefine((value, context) => {
  const reconstructedPlan = {
    alias: value.sourceAuthority.alias,
    convex: value.sourceAuthority.convex,
    idempotencyKey: value.idempotencyKey,
    kind: "current-project-canonical-alias",
    repository: value.sourceAuthority.repository,
    schemaVersion: 1,
    vercel: {
      projectId: value.sourceAuthority.project.id,
      source: value.sourceAuthority.source,
      ...(value.sourceAuthority.sourceProvenance === undefined
        ? {}
        : { sourceProvenance: value.sourceAuthority.sourceProvenance }),
      target: value.sourceAuthority.target,
      teamId: value.sourceAuthority.project.accountId,
    },
    version: value.sourceAuthority.version,
  } as const;
  const reconstructedTargetAuthority = {
    ...value.sourceAuthority,
    marker: {
      generation: 1,
      sourceCommit: value.sourceAuthority.target.sourceCommit,
    },
  } as const;
  const reconstructedConfirmation = [
    "reassign",
    value.sourceAuthority.alias,
    "in",
    value.sourceAuthority.project.id,
    "from",
    `${value.sourceAuthority.source.deploymentId}@${value.sourceAuthority.source.deploymentUrl}`,
    "to",
    `${value.sourceAuthority.target.deploymentId}@${value.sourceAuthority.target.deploymentUrl}`,
    "using",
    "plan",
    value.idempotencyKey,
  ].join(" ");
  if (
    canonicalDigest(value.sourceAuthority) !== value.sourceAuthorityDigest
    || value.sourceAuthority.marker.sourceCommit
      !== value.sourceAuthority.source.sourceCommit
    || canonicalDigest(reconstructedPlan) !== value.planDigest
    || canonicalDigest(reconstructedTargetAuthority) !== value.targetAuthorityDigest
    || canonicalDigest(reconstructedConfirmation) !== value.confirmationDigest
    || mutationKeyForIdentity(
      value.idempotencyKey,
      value.planDigest,
      "assign-target",
    ) !== value.targetMutationKey
    || mutationKeyForIdentity(
      value.idempotencyKey,
      value.planDigest,
      "restore-source",
    ) !== value.sourceRecoveryKey
  ) {
    context.addIssue({ code: "custom", message: "source_authority_digest_invalid" });
  }
});

const targetMutationResponseEvidenceSchema = z.object({
  kind: z.literal("mutation-response"),
  response: aliasMutationReadbackSchema,
}).strict();

export const currentAliasReleaseProviderActivityEvidenceSchema = z.object({
  activity: z.object({
    createdAtMs: z.number().int().nonnegative().safe(),
    eventId: z.string().regex(/^uev_[A-Za-z0-9]{20,80}$/u),
    principalId: providerIdentitySchema,
    textSha256: digestSchema,
  }).strict(),
  alias: z.object({
    createdAtMs: z.number().int().nonnegative().safe(),
    uid: aliasUidSchema,
    updatedAtMs: z.number().int().nonnegative().safe(),
  }).strict(),
  custody: z.object({
    soleWriterConfirmed: z.literal(true),
  }).strict(),
  intentPublishedAtMs: z.number().nonnegative().finite(),
  kind: z.literal("provider-activity-and-operator-provenance"),
  observedTargetMarkerVersion: releaseVersionEvidenceSchema,
  operator: z.object({
    bunVersion: z.literal(supportedBunVersion),
    entrypointSha256: digestSchema,
    gitCommit: commitSchema,
    sourceBlobOid: gitBlobOidSchema,
  }).strict(),
  selfDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { selfDigest, ...unsigned } = value;
  const reviewedOperator = currentAliasReleaseReviewedLegacyOperatorProvenance;
  if (
    selfDigest !== canonicalDigest(unsigned)
    ||
    value.operator.entrypointSha256 !== reviewedOperator.entrypointSha256
    || value.operator.gitCommit !== reviewedOperator.gitCommit
    || value.operator.sourceBlobOid !== reviewedOperator.sourceBlobOid
    ||
    value.alias.updatedAtMs < value.intentPublishedAtMs
    || value.activity.createdAtMs < value.alias.updatedAtMs
    || value.activity.createdAtMs - value.alias.updatedAtMs > 1_000
    || value.activity.createdAtMs - value.intentPublishedAtMs > 5_000
    || value.observedTargetMarkerVersion === OOMPA_RELEASE_VERSION
  ) context.addIssue({ code: "custom", message: "provider_activity_timeline_invalid" });
});

const targetPhaseEvidenceSchema = z.union([
  targetMutationResponseEvidenceSchema,
  currentAliasReleaseProviderActivityEvidenceSchema,
]);

export const currentAliasReleaseTargetPhaseSchema = z.object({
  evidence: targetPhaseEvidenceSchema,
  idempotencyKey: idempotencyKeySchema,
  intentDigest: digestSchema,
  kind: z.literal("current-project-canonical-alias-target-phase"),
  planDigest: digestSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  targetMutationKey: digestSchema,
}).strict();

export const currentAliasReleaseSourceRecoverySchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  intentDigest: digestSchema,
  kind: z.literal("current-project-canonical-alias-source-recovery"),
  planDigest: digestSchema,
  rollbackDiagnostic: currentAliasReleaseRollbackDiagnosticSchema,
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceRecoveryKey: digestSchema,
  targetPhaseDigest: digestSchema,
}).strict();

export const currentAliasReleaseReceiptSchema = z.object({
  changed: z.boolean(),
  finalAuthority: normalizedAliasAuthoritySchema,
  finalAuthorityDigest: digestSchema,
  finalState: z.enum(["source", "target"]),
  idempotencyKey: idempotencyKeySchema,
  intentDigest: digestSchema,
  kind: z.literal("current-project-canonical-alias-receipt"),
  planDigest: digestSchema,
  rollbackDiagnostic: currentAliasReleaseRollbackDiagnosticSchema.optional(),
  schemaVersion: z.literal(1),
  selfDigest: digestSchema,
  sourceRecoveryDigest: digestSchema.optional(),
  targetPhaseDigest: digestSchema.optional(),
  targetDeploymentId: deploymentIdSchema,
  targetSourceCommit: commitSchema,
}).strict().superRefine((value, context) => {
  if (
    canonicalDigest(value.finalAuthority) !== value.finalAuthorityDigest
    || value.finalAuthority.marker.sourceCommit !== (
      value.finalState === "source"
        ? value.finalAuthority.source.sourceCommit
        : value.finalAuthority.target.sourceCommit
    )
    || (
      value.rollbackDiagnostic !== undefined
      && (value.finalState !== "source" || !value.changed)
    )
    || value.sourceRecoveryDigest !== undefined && (
      value.finalState !== "source"
      || value.targetPhaseDigest === undefined
    )
  ) context.addIssue({ code: "custom", message: "final_authority_digest_invalid" });
});

// The short-lived receipt-less reconciliation record from the hra.sh era is no
// longer readable here: this operator binds the oompa.app alias, so any such
// record fails closed as durable_state_invalid and stays untouched on disk.
const readableCurrentAliasReleaseReceiptSchema = currentAliasReleaseReceiptSchema;

export type CurrentAliasReadback = z.infer<typeof aliasReadbackSchema>;
export type CurrentAliasMutationReadback = z.infer<typeof aliasMutationReadbackSchema>;
export type CurrentDeploymentReadback = z.infer<typeof deploymentReadbackSchema>;
export type CurrentProjectReadback = z.infer<typeof projectReadbackSchema>;
export type CurrentAliasReleaseIntent = z.infer<typeof currentAliasReleaseIntentSchema>;
export type CurrentAliasReleaseTargetPhase = z.infer<
  typeof currentAliasReleaseTargetPhaseSchema
>;
export type CurrentAliasReleaseSourceRecovery = z.infer<
  typeof currentAliasReleaseSourceRecoverySchema
>;
export type CurrentAliasReleaseReceipt = z.infer<typeof currentAliasReleaseReceiptSchema>;
type ReadableCurrentAliasReleaseReceipt = z.infer<
  typeof readableCurrentAliasReleaseReceiptSchema
>;
export type ProviderActivityTargetEvidence = z.infer<
  typeof currentAliasReleaseProviderActivityEvidenceSchema
>;
type CurrentAliasReleaseRollbackDiagnostic = z.infer<
  typeof currentAliasReleaseRollbackDiagnosticSchema
>;

export const parseCurrentDeploymentReadback = (
  value: unknown,
): CurrentDeploymentReadback => {
  const parsed = deploymentReadbackSchema.safeParse(value);
  if (!parsed.success) throw new CurrentAliasReleaseError("provider_readback_invalid");
  return parsed.data;
};

type CurrentAliasReleaseFailureCode =
  | "alias_reverted"
  | "bun_version_unsupported"
  | "compensation_failed"
  | "confirmation_required"
  | "durable_state_capacity_exhausted"
  | "durable_state_invalid"
  | "execution_locked"
  | "input_invalid"
  | "input_not_protected"
  | "input_timed_out"
  | "input_too_large"
  | "intent_write_failed"
  | "provider_command_failed"
  | "provider_credentials_refused"
  | "provider_readback_invalid"
  | "receipt_authority_mismatch"
  | "receipt_write_failed"
  | "recovery_evidence_invalid"
  | "recovery_not_permitted"
  | "source_recovery_write_failed"
  | "source_not_authoritative"
  | "target_result_ambiguous"
  | "target_phase_write_failed"
  | "unresolved_current_intent"
  | "unresolved_prior_intent"
  | "unresolved_source_recovery"
  | "usage_invalid"
  | "vercel_version_unsupported";

type DurableFailureContext = Readonly<{
  idempotencyKey: string;
  intentPath: string;
  lockPath: string;
  receiptPath: string;
}>;

export class CurrentAliasReleaseError extends Error {
  constructor(
    readonly code: CurrentAliasReleaseFailureCode,
    readonly durableContext?: DurableFailureContext,
  ) {
    super(code);
    this.name = "CurrentAliasReleaseError";
  }
}

class CurrentAliasReleaseRevertedError extends CurrentAliasReleaseError {
  constructor(readonly rollbackDiagnostic: CurrentAliasReleaseRollbackDiagnostic) {
    super("alias_reverted");
    this.name = "CurrentAliasReleaseRevertedError";
  }
}

export const assertCurrentAliasReleaseBunVersion = (
  version: string = Bun.version,
): void => {
  if (version !== supportedBunVersion) {
    throw new CurrentAliasReleaseError("bun_version_unsupported");
  }
};

type FlockLibrary = Readonly<{
  close: () => void;
  symbols: Readonly<{ flock: (descriptor: number, operation: number) => number }>;
}>;

const openFlockLibrary = (): FlockLibrary => {
  const linuxCandidates = process.arch === "x64"
    ? [
        "/lib/x86_64-linux-gnu/libc.so.6",
        "/usr/lib/x86_64-linux-gnu/libc.so.6",
        "/lib64/libc.so.6",
        "/usr/lib64/libc.so.6",
        "/lib/libc.musl-x86_64.so.1",
        "/usr/lib/libc.musl-x86_64.so.1",
        "/lib/ld-musl-x86_64.so.1",
        "/usr/lib/ld-musl-x86_64.so.1",
      ]
    : process.arch === "arm64"
      ? [
          "/lib/aarch64-linux-gnu/libc.so.6",
          "/usr/lib/aarch64-linux-gnu/libc.so.6",
          "/lib64/libc.so.6",
          "/usr/lib64/libc.so.6",
          "/lib/libc.musl-aarch64.so.1",
          "/usr/lib/libc.musl-aarch64.so.1",
          "/lib/ld-musl-aarch64.so.1",
          "/usr/lib/ld-musl-aarch64.so.1",
        ]
      : [];
  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : linuxCandidates;
  for (const candidate of candidates) {
    try {
      return dlopen(candidate, {
        flock: { args: ["i32", "i32"], returns: "i32" },
      });
    } catch {
      // Try the next platform-specific libc name.
    }
  }
  throw new CurrentAliasReleaseError("durable_state_invalid");
};

let aliasReleaseFlockLibrary: FlockLibrary | undefined;
const flock = (descriptor: number, operation: number): number => {
  aliasReleaseFlockLibrary ??= openFlockLibrary();
  return aliasReleaseFlockLibrary.symbols.flock(descriptor, operation);
};

const flockExclusive = 2;
const flockNonblocking = 4;
const flockUnlock = 8;
const executionLockName = ".canonical-alias-release.lock";

const sameFileIdentity = (
  left: Stats,
  right: Stats,
): boolean => left.dev === right.dev
  && left.ino === right.ino
  && left.uid === right.uid
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size;

const assertExecutionLockIdentity = (descriptor: number, path: string): void => {
  const uid = process.getuid?.();
  if (uid === undefined) throw new CurrentAliasReleaseError("durable_state_invalid");
  let held;
  let current;
  try {
    held = fstatSync(descriptor);
    current = lstatSync(path);
    assertSafeDarwinInstallAcl(descriptor, uid, path);
  } catch {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  if (
    !held.isFile()
    || !current.isFile()
    || current.isSymbolicLink()
    || held.uid !== uid
    || held.nlink !== 1
    || (held.mode & 0o777) !== 0o600
    || held.size !== 0
    || !sameFileIdentity(held, current)
  ) throw new CurrentAliasReleaseError("durable_state_invalid");
};

export type CurrentAliasReleaseExecutionLock = Readonly<{
  assertHeld: () => void;
  path: string;
  release: () => void;
}>;

export const currentAliasReleaseStateDirectory = (): string => join(
  dirname(boundedProcessRecoveryDirectory()),
  "canonical-alias-release",
);

const acquireCurrentAliasReleaseExecutionLock = (
  stateDirectoryInput: string,
): CurrentAliasReleaseExecutionLock => {
  let directory: string;
  try {
    directory = ensureProtectedDirectory(stateDirectoryInput);
  } catch {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  const path = join(directory, executionLockName);
  let descriptor = -1;
  let directoryDescriptor = -1;
  let locked = false;
  try {
    directoryDescriptor = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    descriptor = openSync(
      path,
      constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    assertExecutionLockIdentity(descriptor, path);
    fsyncSync(descriptor);
    fsyncSync(directoryDescriptor);
    if (flock(descriptor, flockExclusive | flockNonblocking) !== 0) {
      throw new CurrentAliasReleaseError("execution_locked");
    }
    locked = true;
    assertExecutionLockIdentity(descriptor, path);
    let released = false;
    return {
      assertHeld: () => {
        if (released) throw new CurrentAliasReleaseError("execution_locked");
        assertExecutionLockIdentity(descriptor, path);
      },
      path,
      release: () => {
        if (released) return;
        released = true;
        let failed = false;
        try {
          assertExecutionLockIdentity(descriptor, path);
        } catch {
          failed = true;
        }
        if (flock(descriptor, flockUnlock) !== 0) failed = true;
        closeSync(descriptor);
        descriptor = -1;
        locked = false;
        if (failed) throw new CurrentAliasReleaseError("durable_state_invalid");
      },
    };
  } catch (error: unknown) {
    if (locked && descriptor >= 0) flock(descriptor, flockUnlock);
    if (descriptor >= 0) closeSync(descriptor);
    if (error instanceof CurrentAliasReleaseError) throw error;
    throw new CurrentAliasReleaseError("durable_state_invalid");
  } finally {
    if (directoryDescriptor >= 0) closeSync(directoryDescriptor);
  }
};

type AliasAuthorityState = "blocked" | "source" | "target";

type AliasAuthorityObservation = Readonly<{
  reason:
    | "alias_not_planned"
    | "exact_source"
    | "exact_target"
    | "marker_mismatch";
  state: AliasAuthorityState;
}>;

export interface CurrentProjectAliasReleaseProvider {
  readAlias(): Promise<CurrentAliasReadback>;
  readDeployment(deploymentId: string): Promise<CurrentDeploymentReadback>;
  readMarker(): Promise<unknown>;
  readProject(): Promise<CurrentProjectReadback>;
  setAlias(
    endpoint: CurrentProjectAliasEndpoint,
    idempotencyKey: string,
  ): Promise<CurrentAliasMutationReadback>;
  verifyTargetActivityEvidence(
    plan: CurrentProjectAliasReleasePlan,
    evidence: ProviderActivityTargetEvidence,
  ): Promise<void>;
  verifyConvexTarget(target: ConvexTarget): Promise<void>;
  verifyVercelVersion(): Promise<void>;
}

export const requiredAliasConfirmation = (
  plan: CurrentProjectAliasReleasePlan,
): string => [
  "reassign",
  plan.alias,
  "in",
  plan.vercel.projectId,
  "from",
  `${plan.vercel.source.deploymentId}@${plan.vercel.source.deploymentUrl}`,
  "to",
  `${plan.vercel.target.deploymentId}@${plan.vercel.target.deploymentUrl}`,
  "using",
  "plan",
  plan.idempotencyKey,
].join(" ");

export const currentAliasReleasePlanDigest = (
  plan: CurrentProjectAliasReleasePlan,
): string => canonicalDigest(plan);

export const currentAliasReleaseMutationKey = (
  plan: CurrentProjectAliasReleasePlan,
  effect: "assign-target" | "restore-source",
): string => mutationKeyForIdentity(
  plan.idempotencyKey,
  currentAliasReleasePlanDigest(plan),
  effect,
);

export const currentAliasReleaseApiArguments = (
  endpoint: CurrentProjectAliasEndpoint,
  idempotencyKey: string,
): readonly string[] => {
  const parsedEndpoint = endpointSchema.safeParse(endpoint);
  if (!parsedEndpoint.success || !digestSchema.safeParse(idempotencyKey).success) {
    throw new CurrentAliasReleaseError("usage_invalid");
  }
  return [
    "api",
    `/v2/deployments/${parsedEndpoint.data.deploymentId}/aliases`,
    "--method",
    "POST",
    "--raw-field",
    `alias=${canonicalAlias}`,
    "--header",
    `Idempotency-Key:${idempotencyKey}`,
    "--scope",
    OOMPA_VERCEL_TEAM_ID,
    "--raw",
  ];
};

export type CurrentAliasReleaseVercelApiRequest = Readonly<{
  body: string;
  headers: Readonly<Record<string, string>>;
  method: "POST";
  url: string;
}>;

export const currentAliasReleaseVercelApiRequest = (
  endpoint: CurrentProjectAliasEndpoint,
  idempotencyKey: string,
  accessToken: string,
): CurrentAliasReleaseVercelApiRequest => {
  const parsedEndpoint = endpointSchema.safeParse(endpoint);
  const parsedToken = vercelAccessTokenSchema.safeParse(accessToken);
  if (
    !parsedEndpoint.success
    || !digestSchema.safeParse(idempotencyKey).success
    || !parsedToken.success
  ) throw new CurrentAliasReleaseError("usage_invalid");
  const url = new URL(
    `/v2/deployments/${parsedEndpoint.data.deploymentId}/aliases`,
    vercelApiOrigin,
  );
  url.searchParams.set("teamId", OOMPA_VERCEL_TEAM_ID);
  return {
    body: JSON.stringify({ alias: canonicalAlias }),
    headers: {
      accept: "application/json",
      authorization: `Bearer ${parsedToken.data}`,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    method: "POST",
    url: url.href,
  };
};

const normalizedAliasAuthority = (
  plan: CurrentProjectAliasReleasePlan,
  state: "source" | "target",
): z.infer<typeof normalizedAliasAuthoritySchema> => ({
  alias: plan.alias,
  convex: plan.convex,
  marker: {
    generation: 1,
    sourceCommit: plan.vercel[state].sourceCommit,
  },
  project: {
    accountId: plan.vercel.teamId,
    autoAssignCustomDomains: false,
    id: plan.vercel.projectId,
  },
  repository: plan.repository,
  source: plan.vercel.source,
  ...(plan.vercel.sourceProvenance === undefined
    ? {}
    : { sourceProvenance: plan.vercel.sourceProvenance }),
  target: plan.vercel.target,
  version: plan.version,
});

const authorityDigest = (
  plan: CurrentProjectAliasReleasePlan,
  state: "source" | "target",
): string => canonicalDigest(normalizedAliasAuthority(plan, state));

export const currentAliasReleaseIntentFor = (
  plan: CurrentProjectAliasReleasePlan,
): CurrentAliasReleaseIntent => {
  const planDigest = currentAliasReleasePlanDigest(plan);
  const sourceAuthority = normalizedAliasAuthority(plan, "source");
  return currentAliasReleaseIntentSchema.parse(withSelfDigest({
    confirmationDigest: canonicalDigest(requiredAliasConfirmation(plan)),
    idempotencyKey: plan.idempotencyKey,
    kind: "current-project-canonical-alias-intent" as const,
    planDigest,
    schemaVersion: 1 as const,
    sourceAuthority,
    sourceAuthorityDigest: authorityDigest(plan, "source"),
    sourceRecoveryKey: currentAliasReleaseMutationKey(plan, "restore-source"),
    targetAuthorityDigest: authorityDigest(plan, "target"),
    targetMutationKey: currentAliasReleaseMutationKey(plan, "assign-target"),
  }));
};

export const currentAliasReleaseTargetPhaseForMutationResponse = (
  plan: CurrentProjectAliasReleasePlan,
  intent: CurrentAliasReleaseIntent,
  response: CurrentAliasMutationReadback,
): CurrentAliasReleaseTargetPhase => {
  if (
    intent.selfDigest !== currentAliasReleaseIntentFor(plan).selfDigest
    || response.oldDeploymentId !== plan.vercel.source.deploymentId
  ) throw new CurrentAliasReleaseError("provider_readback_invalid");
  return currentAliasReleaseTargetPhaseSchema.parse(withSelfDigest({
    evidence: {
      kind: "mutation-response" as const,
      response: aliasMutationReadbackSchema.parse(response),
    },
    idempotencyKey: intent.idempotencyKey,
    intentDigest: intent.selfDigest,
    kind: "current-project-canonical-alias-target-phase" as const,
    planDigest: intent.planDigest,
    schemaVersion: 1 as const,
    targetMutationKey: intent.targetMutationKey,
  }));
};

export const currentAliasReleaseTargetPhaseForProviderActivity = (
  plan: CurrentProjectAliasReleasePlan,
  intent: CurrentAliasReleaseIntent,
  evidence: ProviderActivityTargetEvidence,
): CurrentAliasReleaseTargetPhase => {
  if (intent.selfDigest !== currentAliasReleaseIntentFor(plan).selfDigest) {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  return currentAliasReleaseTargetPhaseSchema.parse(withSelfDigest({
    evidence: currentAliasReleaseProviderActivityEvidenceSchema.parse(evidence),
    idempotencyKey: intent.idempotencyKey,
    intentDigest: intent.selfDigest,
    kind: "current-project-canonical-alias-target-phase" as const,
    planDigest: intent.planDigest,
    schemaVersion: 1 as const,
    targetMutationKey: intent.targetMutationKey,
  }));
};

export const currentAliasReleaseSourceRecoveryFor = (
  intent: CurrentAliasReleaseIntent,
  targetPhase: CurrentAliasReleaseTargetPhase,
  rollbackDiagnostic: CurrentAliasReleaseRollbackDiagnostic,
): CurrentAliasReleaseSourceRecovery => currentAliasReleaseSourceRecoverySchema.parse(
  withSelfDigest({
    idempotencyKey: intent.idempotencyKey,
    intentDigest: intent.selfDigest,
    kind: "current-project-canonical-alias-source-recovery" as const,
    planDigest: intent.planDigest,
    rollbackDiagnostic,
    schemaVersion: 1 as const,
    sourceRecoveryKey: intent.sourceRecoveryKey,
    targetPhaseDigest: targetPhase.selfDigest,
  }),
);

export type CurrentAliasReleaseStatePaths = Readonly<{
  intent: string;
  receipt: string;
  sourceRecovery: string;
  targetPhase: string;
}>;

export const currentAliasReleaseStatePaths = (
  plan: CurrentProjectAliasReleasePlan,
  stateDirectoryInput: string,
): CurrentAliasReleaseStatePaths => {
  let stateDirectory: string;
  try {
    stateDirectory = ensureProtectedDirectory(stateDirectoryInput);
  } catch {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  if (resolve(stateDirectoryInput) !== stateDirectory) {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  const idempotencyKey = plan.idempotencyKey;
  return {
    intent: join(stateDirectory, `${idempotencyKey}.intent.json`),
    receipt: join(stateDirectory, `${idempotencyKey}.receipt.json`),
    sourceRecovery: join(stateDirectory, `${idempotencyKey}.source-recovery.json`),
    targetPhase: join(stateDirectory, `${idempotencyKey}.target-phase.json`),
  };
};

const reserveCurrentAliasReleaseIntent = (
  path: string,
  plan: CurrentProjectAliasReleasePlan,
  afterPublication?: (
    path: string,
    intent: CurrentAliasReleaseIntent,
  ) => void,
): CurrentAliasReleaseIntent => {
  const intent = currentAliasReleaseIntentFor(plan);
  try {
    writeProtectedJsonNoReplace(path, intent, currentAliasReleaseIntentSchema, {
      allowExactReplay: true,
    });
    afterPublication?.(path, intent);
    return readProtectedJson(path, currentAliasReleaseIntentSchema, {
      recoverInterruptedPublication: true,
    });
  } catch {
    throw new CurrentAliasReleaseError("intent_write_failed");
  }
};

const reserveCurrentAliasReleaseTargetPhase = (
  path: string,
  targetPhase: CurrentAliasReleaseTargetPhase,
): CurrentAliasReleaseTargetPhase => {
  try {
    writeProtectedJsonNoReplace(
      path,
      targetPhase,
      currentAliasReleaseTargetPhaseSchema,
      { allowExactReplay: true },
    );
    return readProtectedJson(path, currentAliasReleaseTargetPhaseSchema, {
      recoverInterruptedPublication: true,
    });
  } catch {
    throw new CurrentAliasReleaseError("target_phase_write_failed");
  }
};

const reserveCurrentAliasReleaseSourceRecovery = (
  path: string,
  sourceRecovery: CurrentAliasReleaseSourceRecovery,
): CurrentAliasReleaseSourceRecovery => {
  try {
    writeProtectedJsonNoReplace(
      path,
      sourceRecovery,
      currentAliasReleaseSourceRecoverySchema,
      { allowExactReplay: true },
    );
    return readProtectedJson(path, currentAliasReleaseSourceRecoverySchema, {
      recoverInterruptedPublication: true,
    });
  } catch {
    throw new CurrentAliasReleaseError("source_recovery_write_failed");
  }
};

const currentAliasReleaseReceiptFor = (
  plan: CurrentProjectAliasReleasePlan,
  intent: CurrentAliasReleaseIntent,
  changed: boolean,
  finalState: "source" | "target",
  evidence: Readonly<{
    rollbackDiagnostic?: CurrentAliasReleaseRollbackDiagnostic;
    sourceRecovery?: CurrentAliasReleaseSourceRecovery;
    targetPhase?: CurrentAliasReleaseTargetPhase;
  }> = {},
): CurrentAliasReleaseReceipt => currentAliasReleaseReceiptSchema.parse(withSelfDigest({
  changed,
  finalAuthority: normalizedAliasAuthority(plan, finalState),
  finalAuthorityDigest: authorityDigest(plan, finalState),
  finalState,
  idempotencyKey: intent.idempotencyKey,
  intentDigest: intent.selfDigest,
  kind: "current-project-canonical-alias-receipt" as const,
  planDigest: intent.planDigest,
  ...(evidence.rollbackDiagnostic === undefined
    ? {}
    : { rollbackDiagnostic: evidence.rollbackDiagnostic }),
  schemaVersion: 1 as const,
  ...(evidence.sourceRecovery === undefined
    ? {}
    : { sourceRecoveryDigest: evidence.sourceRecovery.selfDigest }),
  ...(evidence.targetPhase === undefined
    ? {}
    : { targetPhaseDigest: evidence.targetPhase.selfDigest }),
  targetDeploymentId: plan.vercel.target.deploymentId,
  targetSourceCommit: plan.vercel.target.sourceCommit,
}));

type CurrentAliasReleaseDurableState = Readonly<{
  intent: CurrentAliasReleaseIntent | null;
  receipt: ReadableCurrentAliasReleaseReceipt | null;
  sourceRecovery: CurrentAliasReleaseSourceRecovery | null;
  targetPhase: CurrentAliasReleaseTargetPhase | null;
}>;

const stateFilePattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(intent|receipt|source-recovery|target-phase)\.json$/u;
export const currentAliasReleaseStateEntryMaximum = 8_193;

export const assertCurrentAliasReleaseStateCapacity = (
  existingEntries: number,
  reservedEntries: number,
): void => {
  if (
    !Number.isSafeInteger(existingEntries)
    || existingEntries < 0
    || !Number.isSafeInteger(reservedEntries)
    || reservedEntries < 0
    || existingEntries + reservedEntries > currentAliasReleaseStateEntryMaximum
  ) throw new CurrentAliasReleaseError("durable_state_capacity_exhausted");
};

export const assertCurrentAliasReleaseScanCapacity = (entries: number): void => {
  if (
    !Number.isSafeInteger(entries)
    || entries < 0
    || entries > currentAliasReleaseStateEntryMaximum + 1
  ) throw new CurrentAliasReleaseError("durable_state_capacity_exhausted");
};

const inspectCurrentAliasReleaseDurableState = (
  plan: CurrentProjectAliasReleasePlan,
  stateDirectory: string,
): CurrentAliasReleaseDurableState => {
  let names: string[];
  try {
    names = readdirSync(stateDirectory);
  } catch {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  // One extra entry may be the hard-link publication artifact recovered while
  // reading the one record a prior process was publishing when it stopped.
  assertCurrentAliasReleaseScanCapacity(names.length);
  const intents = new Map<string, CurrentAliasReleaseIntent>();
  const receipts = new Map<string, ReadableCurrentAliasReleaseReceipt>();
  const sourceRecoveries = new Map<string, CurrentAliasReleaseSourceRecovery>();
  const targetPhases = new Map<string, CurrentAliasReleaseTargetPhase>();
  for (const name of names) {
    const match = stateFilePattern.exec(name);
    if (match === null) continue;
    const idempotencyKey = match[1];
    const kind = match[2];
    if (idempotencyKey === undefined || kind === undefined) {
      throw new CurrentAliasReleaseError("durable_state_invalid");
    }
    try {
      if (kind === "intent") {
        const intent = readProtectedJson(
          join(stateDirectory, name),
          currentAliasReleaseIntentSchema,
          { recoverInterruptedPublication: true },
        );
        if (intent.idempotencyKey !== idempotencyKey) {
          throw new CurrentAliasReleaseError("durable_state_invalid");
        }
        intents.set(idempotencyKey, intent);
      } else if (kind === "receipt") {
        const receipt = readProtectedJson(
          join(stateDirectory, name),
          readableCurrentAliasReleaseReceiptSchema,
          { recoverInterruptedPublication: true },
        );
        if (receipt.idempotencyKey !== idempotencyKey) {
          throw new CurrentAliasReleaseError("durable_state_invalid");
        }
        receipts.set(idempotencyKey, receipt);
      } else if (kind === "source-recovery") {
        const sourceRecovery = readProtectedJson(
          join(stateDirectory, name),
          currentAliasReleaseSourceRecoverySchema,
          { recoverInterruptedPublication: true },
        );
        if (sourceRecovery.idempotencyKey !== idempotencyKey) {
          throw new CurrentAliasReleaseError("durable_state_invalid");
        }
        sourceRecoveries.set(idempotencyKey, sourceRecovery);
      } else {
        const targetPhase = readProtectedJson(
          join(stateDirectory, name),
          currentAliasReleaseTargetPhaseSchema,
          { recoverInterruptedPublication: true },
        );
        if (targetPhase.idempotencyKey !== idempotencyKey) {
          throw new CurrentAliasReleaseError("durable_state_invalid");
        }
        targetPhases.set(idempotencyKey, targetPhase);
      }
    } catch (error: unknown) {
      if (error instanceof CurrentAliasReleaseError) throw error;
      throw new CurrentAliasReleaseError("durable_state_invalid");
    }
  }
  let remaining: string[];
  let stable: string[];
  try {
    remaining = readdirSync(stateDirectory);
    stable = readdirSync(stateDirectory);
  } catch {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  const expectedStable = [
    executionLockName,
    ...[...intents.keys()].map((key) => `${key}.intent.json`),
    ...[...receipts.keys()].map((key) => `${key}.receipt.json`),
    ...[...sourceRecoveries.keys()].map((key) => `${key}.source-recovery.json`),
    ...[...targetPhases.keys()].map((key) => `${key}.target-phase.json`),
  ];
  if (
    [...remaining].sort().join("\0") !== [...stable].sort().join("\0")
    || [...stable].sort().join("\0") !== expectedStable.sort().join("\0")
  ) {
    throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  for (const [idempotencyKey, receipt] of receipts) {
    const intent = intents.get(idempotencyKey);
    const sourceRecovery = sourceRecoveries.get(idempotencyKey);
    const targetPhase = targetPhases.get(idempotencyKey);
    if (
      intent === undefined
      || receipt.intentDigest !== intent.selfDigest
      || receipt.planDigest !== intent.planDigest
      || receipt.finalAuthorityDigest !== (
        receipt.finalState === "source"
          ? intent.sourceAuthorityDigest
          : intent.targetAuthorityDigest
      )
      || receipt.targetDeploymentId !== receipt.finalAuthority.target.deploymentId
      || receipt.targetSourceCommit !== receipt.finalAuthority.target.sourceCommit
      || receipt.targetPhaseDigest !== targetPhase?.selfDigest
      || receipt.sourceRecoveryDigest !== sourceRecovery?.selfDigest
    ) throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  for (const [idempotencyKey, targetPhase] of targetPhases) {
    const intent = intents.get(idempotencyKey);
    if (
      intent === undefined
      || targetPhase.idempotencyKey !== intent.idempotencyKey
      || targetPhase.intentDigest !== intent.selfDigest
      || targetPhase.planDigest !== intent.planDigest
      || targetPhase.targetMutationKey !== intent.targetMutationKey
      || targetPhase.evidence.kind === "mutation-response" && (
        targetPhase.evidence.response.oldDeploymentId
          !== intent.sourceAuthority.source.deploymentId
      )
    ) throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  for (const [idempotencyKey, sourceRecovery] of sourceRecoveries) {
    const intent = intents.get(idempotencyKey);
    const targetPhase = targetPhases.get(idempotencyKey);
    if (
      intent === undefined
      || targetPhase === undefined
      || sourceRecovery.intentDigest !== intent.selfDigest
      || sourceRecovery.planDigest !== intent.planDigest
      || sourceRecovery.sourceRecoveryKey !== intent.sourceRecoveryKey
      || sourceRecovery.targetPhaseDigest !== targetPhase.selfDigest
    ) throw new CurrentAliasReleaseError("durable_state_invalid");
  }
  for (const idempotencyKey of intents.keys()) {
    if (!receipts.has(idempotencyKey) && idempotencyKey !== plan.idempotencyKey) {
      throw new CurrentAliasReleaseError("unresolved_prior_intent", {
        idempotencyKey,
        intentPath: join(stateDirectory, `${idempotencyKey}.intent.json`),
        lockPath: join(stateDirectory, executionLockName),
        receiptPath: join(stateDirectory, `${idempotencyKey}.receipt.json`),
      });
    }
  }
  const intent = intents.get(plan.idempotencyKey) ?? null;
  const receipt = receipts.get(plan.idempotencyKey) ?? null;
  const sourceRecovery = sourceRecoveries.get(plan.idempotencyKey) ?? null;
  const targetPhase = targetPhases.get(plan.idempotencyKey) ?? null;
  assertCurrentAliasReleaseStateCapacity(
    stable.length,
    receipt !== null
      ? 0
      : intent === null
      ? 4
      : targetPhase === null
        ? 3
        : sourceRecovery === null
          ? 2
          : 1,
  );
  if (intent !== null) {
    const expected = currentAliasReleaseIntentFor(plan);
    if (intent.selfDigest !== expected.selfDigest) {
      throw new CurrentAliasReleaseError("durable_state_invalid");
    }
  }
  if (receipt !== null && intent !== null) {
    const currentReceipt = currentAliasReleaseReceiptSchema.safeParse(receipt);
    if (currentReceipt.success) {
      const expected = currentAliasReleaseReceiptFor(
        plan,
        intent,
        currentReceipt.data.changed,
        currentReceipt.data.finalState,
        {
          ...(currentReceipt.data.rollbackDiagnostic === undefined
            ? {}
            : { rollbackDiagnostic: currentReceipt.data.rollbackDiagnostic }),
          ...(sourceRecovery === null ? {} : { sourceRecovery }),
          ...(targetPhase === null ? {} : { targetPhase }),
        },
      );
      if (currentReceipt.data.selfDigest !== expected.selfDigest) {
        throw new CurrentAliasReleaseError("durable_state_invalid");
      }
    } else {
      throw new CurrentAliasReleaseError("durable_state_invalid");
    }
  }
  return { intent, receipt, sourceRecovery, targetPhase };
};

const aliasMatches = (
  value: CurrentAliasReadback,
  endpoint: CurrentProjectAliasEndpoint,
): boolean => value.deploymentId === endpoint.deploymentId
  && value.deployment.id === endpoint.deploymentId
  && value.deployment.url === endpoint.deploymentUrl;

const githubDeploymentMatches = (
  value: CurrentDeploymentReadback,
  endpoint: CurrentProjectAliasEndpoint,
): boolean => value.id === endpoint.deploymentId
  && value.url === endpoint.deploymentUrl
  && value.gitSource !== null
  && value.gitSource.sha === endpoint.sourceCommit;

const sourceDeploymentMatches = (
  value: CurrentDeploymentReadback,
  plan: CurrentProjectAliasReleasePlan,
): boolean => {
  if (plan.vercel.sourceProvenance === undefined) {
    return githubDeploymentMatches(value, plan.vercel.source);
  }
  return value.id === plan.vercel.source.deploymentId
    && value.url === plan.vercel.source.deploymentUrl
    && value.gitSource === null
    && value.meta.gitCommitSha === plan.vercel.source.sourceCommit;
};

const markerMatches = (
  value: unknown,
  endpoint: CurrentProjectAliasEndpoint,
): boolean => {
  const parsed = markerSchema.safeParse(value);
  return parsed.success && parsed.data.source.commit === endpoint.sourceCommit;
};

export const parseCurrentProjectAliasReleasePlan = (
  document: string,
): CurrentProjectAliasReleasePlan => {
  if (
    document.trim().length === 0
    || Buffer.byteLength(document, "utf8") > inputMaximumBytes
  ) throw new CurrentAliasReleaseError("input_invalid");
  try {
    return currentProjectAliasReleasePlanSchema.parse(JSON.parse(document) as unknown);
  } catch {
    throw new CurrentAliasReleaseError("input_invalid");
  }
};

export const observeCurrentAliasAuthority = async (
  plan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
): Promise<AliasAuthorityObservation> => {
  await provider.verifyVercelVersion();
  await provider.verifyConvexTarget(parseConvexTarget(plan.convex));
  await provider.readProject();
  const source = parseCurrentDeploymentReadback(
    await provider.readDeployment(plan.vercel.source.deploymentId),
  );
  if (!sourceDeploymentMatches(source, plan)) {
    throw new CurrentAliasReleaseError("provider_readback_invalid");
  }
  const target = parseCurrentDeploymentReadback(
    await provider.readDeployment(plan.vercel.target.deploymentId),
  );
  if (!githubDeploymentMatches(target, plan.vercel.target)) {
    throw new CurrentAliasReleaseError("provider_readback_invalid");
  }
  const alias = await provider.readAlias();
  const state = aliasMatches(alias, plan.vercel.source)
    ? "source"
    : aliasMatches(alias, plan.vercel.target)
      ? "target"
      : "blocked";
  if (state === "blocked") return { reason: "alias_not_planned", state };
  const marker = await provider.readMarker();
  if (!markerMatches(marker, plan.vercel[state])) {
    return { reason: "marker_mismatch", state: "blocked" };
  }
  if (
    state === "source"
    && plan.vercel.sourceProvenance !== undefined
    && !aliasMatches(await provider.readAlias(), plan.vercel.source)
  ) return { reason: "alias_not_planned", state: "blocked" };
  return {
    reason: state === "source" ? "exact_source" : "exact_target",
    state,
  };
};

type ReleaseClock = Readonly<{
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

const defaultClock: ReleaseClock = {
  now: () => performance.now(),
  sleep: async (milliseconds) => {
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
  },
};

const rethrowTerminalProviderError = (error: unknown): void => {
  rethrowAuthorityContainmentUnavailable(error);
  rethrowBoundedProcessTerminalError(error);
};

type AliasAuthorityProofDiagnostic = Readonly<{
  phase:
    | CurrentAliasReleaseRollbackDiagnostic["phase"]
    | "source_probe"
    | "source_authority";
  reason: CurrentAliasReleaseRollbackDiagnostic["reason"];
}>;

type AliasAuthorityProof =
  | Readonly<{ proved: true }>
  | Readonly<{ diagnostic: AliasAuthorityProofDiagnostic; proved: false }>;

const nonterminalAuthorityReason = (
  error: unknown,
): CurrentAliasReleaseRollbackDiagnostic["reason"] => {
  rethrowTerminalProviderError(error);
  if (error instanceof CurrentAliasReleaseError) {
    if (
      error.code === "provider_command_failed"
      || error.code === "provider_readback_invalid"
      || error.code === "vercel_version_unsupported"
    ) return error.code;
  }
  return "provider_readback_invalid";
};

const proveStableAliasAuthority = async (
  plan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  expectedState: "source" | "target",
  clock: ReleaseClock,
  deadline: number,
): Promise<AliasAuthorityProof> => {
  const expected = plan.vercel[expectedState];
  const probePhase = expectedState === "target" ? "target_probe" : "source_probe";
  const authorityPhase = expectedState === "target"
    ? "target_authority"
    : "source_authority";
  let consecutiveExactObservations = 0;
  let attempted = false;
  let lastDiagnostic: AliasAuthorityProofDiagnostic = {
    phase: probePhase,
    reason: "stability_not_proven",
  };
  for (;;) {
    if (attempted && clock.now() >= deadline) {
      return { diagnostic: lastDiagnostic, proved: false };
    }
    attempted = true;
    let probeReason: CurrentAliasReleaseRollbackDiagnostic["reason"] | undefined;
    try {
      const alias = await provider.readAlias();
      if (!aliasMatches(alias, expected)) probeReason = "alias_not_planned";
      else if (!markerMatches(await provider.readMarker(), expected)) {
        probeReason = "marker_mismatch";
      }
    } catch (error: unknown) {
      probeReason = nonterminalAuthorityReason(error);
    }
    if (probeReason === undefined) {
      if (clock.now() >= deadline) {
        return {
          diagnostic: { phase: authorityPhase, reason: "stability_not_proven" },
          proved: false,
        };
      }
      try {
        const observation = await observeCurrentAliasAuthority(plan, provider);
        if (observation.state === expectedState) {
          if (clock.now() >= deadline) {
            return {
              diagnostic: { phase: authorityPhase, reason: "stability_not_proven" },
              proved: false,
            };
          }
          consecutiveExactObservations += 1;
          if (consecutiveExactObservations >= 2) return { proved: true };
          lastDiagnostic = { phase: authorityPhase, reason: "stability_not_proven" };
          continue;
        }
        consecutiveExactObservations = 0;
        lastDiagnostic = {
          phase: authorityPhase,
          reason: observation.state === "blocked"
            ? observation.reason === "marker_mismatch"
              ? "marker_mismatch"
              : "alias_not_planned"
            : "alias_not_planned",
        };
      } catch (error: unknown) {
        consecutiveExactObservations = 0;
        lastDiagnostic = {
          phase: authorityPhase,
          reason: nonterminalAuthorityReason(error),
        };
      }
    } else {
      consecutiveExactObservations = 0;
      lastDiagnostic = { phase: probePhase, reason: probeReason };
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) return { diagnostic: lastDiagnostic, proved: false };
    await clock.sleep(Math.min(250, remaining));
  }
};

export type CurrentAliasReleaseOutcome = Readonly<{
  changed: boolean;
  replayed: boolean;
}>;

const restoreCurrentAliasReleaseSource = async (
  plan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  clock: ReleaseClock,
  timeoutMs: number,
  assertMutationAuthority: () => void,
  rollbackDiagnostic: CurrentAliasReleaseRollbackDiagnostic,
  recordSourceRecovery: (
    rollbackDiagnostic: CurrentAliasReleaseRollbackDiagnostic,
  ) => CurrentAliasReleaseSourceRecovery,
): Promise<never> => {
  assertMutationAuthority();
  recordSourceRecovery(rollbackDiagnostic);
  assertMutationAuthority();
  try {
    const response = await provider.setAlias(
      plan.vercel.source,
      currentAliasReleaseMutationKey(plan, "restore-source"),
    );
    if (response.oldDeploymentId !== plan.vercel.target.deploymentId) {
      throw new CurrentAliasReleaseError("compensation_failed");
    }
  } catch (error: unknown) {
    rethrowTerminalProviderError(error);
    throw new CurrentAliasReleaseError("compensation_failed");
  }
  const sourceRestored = await proveStableAliasAuthority(
    plan,
    provider,
    "source",
    clock,
    clock.now() + timeoutMs,
  );
  if (sourceRestored.proved) {
    throw new CurrentAliasReleaseRevertedError(rollbackDiagnostic);
  }
  throw new CurrentAliasReleaseError("compensation_failed");
};

const executeCurrentAliasReleasePlan = async (
  plan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  confirmation: string | undefined,
  clock: ReleaseClock = defaultClock,
  timeoutMs = convergenceTimeoutMs,
  assertMutationAuthority: () => void,
  recordTargetPhase: (
    response: CurrentAliasMutationReadback,
  ) => CurrentAliasReleaseTargetPhase,
  recordSourceRecovery: (
    rollbackDiagnostic: CurrentAliasReleaseRollbackDiagnostic,
  ) => CurrentAliasReleaseSourceRecovery,
): Promise<CurrentAliasReleaseOutcome> => {
  if (confirmation !== requiredAliasConfirmation(plan)) {
    throw new CurrentAliasReleaseError("confirmation_required");
  }
  const initial = await observeCurrentAliasAuthority(plan, provider);
  if (initial.state === "blocked") {
    throw new CurrentAliasReleaseError("source_not_authoritative");
  }
  if (initial.state === "target") {
    throw new CurrentAliasReleaseError("target_result_ambiguous");
  }

  assertMutationAuthority();
  let response: CurrentAliasMutationReadback;
  try {
    response = await provider.setAlias(
      plan.vercel.target,
      currentAliasReleaseMutationKey(plan, "assign-target"),
    );
  } catch (error: unknown) {
    rethrowTerminalProviderError(error);
    throw new CurrentAliasReleaseError("target_result_ambiguous");
  }
  if (response.oldDeploymentId !== plan.vercel.source.deploymentId) {
    throw new CurrentAliasReleaseError("provider_readback_invalid");
  }
  recordTargetPhase(response);

  const targetAuthority = await proveStableAliasAuthority(
    plan,
    provider,
    "target",
    clock,
    clock.now() + timeoutMs,
  );
  if (targetAuthority.proved) return { changed: true, replayed: false };

  return await restoreCurrentAliasReleaseSource(
    plan,
    provider,
    clock,
    timeoutMs,
    assertMutationAuthority,
    currentAliasReleaseRollbackDiagnosticSchema.parse(targetAuthority.diagnostic),
    recordSourceRecovery,
  );
};

const reconcileCurrentAliasReleaseIntent = async (
  plan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  clock: ReleaseClock,
  timeoutMs: number,
  assertMutationAuthority: () => void,
): Promise<CurrentAliasReleaseOutcome> => {
  void plan;
  void provider;
  void clock;
  void timeoutMs;
  void assertMutationAuthority;
  throw new CurrentAliasReleaseError("unresolved_current_intent");
};

const proveRecoveryTargetSample = async (
  plan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  expectedMarkerVersion?: string,
): Promise<string> => {
  try {
    await provider.verifyVercelVersion();
    await provider.verifyConvexTarget(parseConvexTarget(plan.convex));
    await provider.readProject();
    const source = parseCurrentDeploymentReadback(
      await provider.readDeployment(plan.vercel.source.deploymentId),
    );
    const target = parseCurrentDeploymentReadback(
      await provider.readDeployment(plan.vercel.target.deploymentId),
    );
    const alias = await provider.readAlias();
    const marker = recoveryTargetMarkerSchema.safeParse(await provider.readMarker());
    if (
      !sourceDeploymentMatches(source, plan)
      || !githubDeploymentMatches(target, plan.vercel.target)
      || !aliasMatches(alias, plan.vercel.target)
      || !marker.success
      || marker.data.source.commit !== plan.vercel.target.sourceCommit
      || expectedMarkerVersion !== undefined
        && marker.data.version !== expectedMarkerVersion
      || marker.data.version === OOMPA_RELEASE_VERSION
    ) throw new CurrentAliasReleaseError("recovery_not_permitted");
    return marker.data.version;
  } catch (error: unknown) {
    rethrowTerminalProviderError(error);
    if (error instanceof CurrentAliasReleaseError) throw error;
    throw new CurrentAliasReleaseError("recovery_not_permitted");
  }
};

const assertProviderActivityIntentPublication = (
  intentPath: string,
  evidence: ProviderActivityTargetEvidence,
): void => {
  try {
    const metadata = lstatSync(intentPath);
    if (
      !metadata.isFile()
      || metadata.isSymbolicLink()
      || metadata.uid !== process.getuid?.()
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || Math.abs(metadata.mtimeMs - evidence.intentPublishedAtMs) > 0.001
    ) throw new Error("intent publication changed");
  } catch {
    throw new CurrentAliasReleaseError("recovery_evidence_invalid");
  }
};

const recoverCurrentAliasReleaseSource = async (
  plan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  targetPhase: CurrentAliasReleaseTargetPhase,
  clock: ReleaseClock,
  timeoutMs: number,
  assertMutationAuthority: () => void,
  recordSourceRecovery: (
    rollbackDiagnostic: CurrentAliasReleaseRollbackDiagnostic,
  ) => CurrentAliasReleaseSourceRecovery,
): Promise<CurrentAliasReleaseRollbackDiagnostic> => {
  let observedMarkerVersion = targetPhase.evidence.kind === "mutation-response"
    ? undefined
    : targetPhase.evidence.observedTargetMarkerVersion;
  for (let sample = 0; sample < 2; sample += 1) {
    assertMutationAuthority();
    observedMarkerVersion = await proveRecoveryTargetSample(
      plan,
      provider,
      observedMarkerVersion,
    );
  }
  const rollbackDiagnostic = currentAliasReleaseRollbackDiagnosticSchema.parse({
    phase: "target_authority",
    reason: "marker_mismatch",
  });
  assertMutationAuthority();
  recordSourceRecovery(rollbackDiagnostic);
  assertMutationAuthority();
  let response: CurrentAliasMutationReadback;
  try {
    response = await provider.setAlias(
      plan.vercel.source,
      currentAliasReleaseMutationKey(plan, "restore-source"),
    );
  } catch (error: unknown) {
    rethrowTerminalProviderError(error);
    throw new CurrentAliasReleaseError("compensation_failed");
  }
  if (response.oldDeploymentId !== plan.vercel.target.deploymentId) {
    throw new CurrentAliasReleaseError("compensation_failed");
  }
  const sourceRestored = await proveStableAliasAuthority(
    plan,
    provider,
    "source",
    clock,
    clock.now() + timeoutMs,
  );
  if (!sourceRestored.proved) {
    throw new CurrentAliasReleaseError("compensation_failed");
  }
  return rollbackDiagnostic;
};

export type VercelCommandRequest = Readonly<{
  arguments: readonly string[];
  containment: BoundedProcessContainment;
  environment: Readonly<Record<string, string>>;
  executable: string;
  phase: string;
}>;

export type VercelCommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

export type VercelCommandRunner = (
  request: VercelCommandRequest,
) => Promise<VercelCommandResult>;

const runVercelCommand: VercelCommandRunner = async (request) => {
  const result = requireBoundedProcessCleanup(await runBoundedProcess({
    arguments: request.arguments,
    containment: request.containment,
    cwd: process.cwd(),
    environment: request.environment,
    executable: request.executable,
    outputMaximumBytes,
    phase: request.phase,
    terminationGraceMs: commandTerminationGraceMs,
    timeoutMs: commandTimeoutMs,
  }));
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString("utf8"),
    stdout: result.stdout.toString("utf8"),
  };
};

const childEnvironmentNames = [
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SystemRoot",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
] as const;

export const buildVercelEnvironment = (
  source: Readonly<NodeJS.ProcessEnv>,
): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = { NO_COLOR: "1", TERM: "dumb" };
  for (const name of childEnvironmentNames) {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
};

const readBoundedBody = async (
  response: Response,
  maximumBytes = markerMaximumBytes,
): Promise<string> => {
  if (response.status !== 200 || response.body === null || response.redirected) {
    await response.body?.cancel().catch(() => undefined);
    throw new CurrentAliasReleaseError("provider_readback_invalid");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    await response.body.cancel().catch(() => undefined);
    throw new CurrentAliasReleaseError("provider_readback_invalid");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        throw new CurrentAliasReleaseError("provider_readback_invalid");
      }
      chunks.push(result.value);
    }
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof CurrentAliasReleaseError) throw error;
    throw new CurrentAliasReleaseError("provider_readback_invalid");
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
};

const parseProviderJson = <Value>(document: string, schema: z.ZodType<Value>): Value => {
  if (
    document.trim().length === 0
    || Buffer.byteLength(document, "utf8") > outputMaximumBytes
  ) throw new CurrentAliasReleaseError("provider_readback_invalid");
  try {
    return schema.parse(JSON.parse(document) as unknown);
  } catch {
    throw new CurrentAliasReleaseError("provider_readback_invalid");
  }
};

const sameCredentialIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.uid === right.uid
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size
  && left.ctimeMs === right.ctimeMs
  && left.mtimeMs === right.mtimeMs;

const readCredentialDescriptor = (descriptor: number, size: number): Buffer =>
  readAliasInputBuffer(size, (document, offset) => readSync(
    descriptor, document, offset, document.byteLength - offset, offset,
  ));

const parseProtectedVercelSession = (document: string, nowSeconds: number): string => {
  const parsed = vercelAuthSchema.safeParse(JSON.parse(document) as unknown);
  if (
    !parsed.success
    || parsed.data.expiresAt !== undefined
      && parsed.data.expiresAt < nowSeconds + vercelCredentialMinimumLifetimeSeconds
  ) throw new CurrentAliasReleaseError("provider_credentials_refused");
  return parsed.data.token;
};

export const readProtectedVercelAccessToken = (
  descriptor: number,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string => {
  let first: Buffer | undefined;
  let second: Buffer | undefined;
  let accessToken: string | undefined;
  let refused = false;
  try {
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !Number.isSafeInteger(descriptor)
      || descriptor < 3
      || descriptor > 255
      || isatty(descriptor)
    ) throw new CurrentAliasReleaseError("provider_credentials_refused");
    const initial = fstatSync(descriptor);
    proveDescriptorAclAbsence(
      descriptor,
      {},
      "provider_credentials_refused",
    );
    if (
      !initial.isFile()
      || initial.uid !== uid
      || initial.nlink !== 1
      || (initial.mode & 0o777) !== 0o600
      || initial.size <= 0
      || initial.size > vercelAuthMaximumBytes
    ) throw new CurrentAliasReleaseError("provider_credentials_refused");

    first = readCredentialDescriptor(descriptor, initial.size);
    const afterFirstRead = fstatSync(descriptor);
    if (!sameCredentialIdentity(initial, afterFirstRead)) {
      throw new CurrentAliasReleaseError("provider_credentials_refused");
    }
    second = readCredentialDescriptor(descriptor, initial.size);
    const final = fstatSync(descriptor);
    proveDescriptorAclAbsence(
      descriptor,
      {},
      "provider_credentials_refused",
    );
    if (
      !sameCredentialIdentity(initial, final)
      || !first.subarray(0, initial.size).equals(second.subarray(0, initial.size))
    ) throw new CurrentAliasReleaseError("provider_credentials_refused");

    const document = new TextDecoder("utf-8", { fatal: true })
      .decode(first.subarray(0, initial.size));
    accessToken = parseProtectedVercelSession(document, nowSeconds);
  } catch {
    refused = true;
  } finally {
    first?.fill(0);
    second?.fill(0);
    try {
      closeSync(descriptor);
    } catch {
      refused = true;
    }
  }
  if (refused || accessToken === undefined) {
    throw new CurrentAliasReleaseError("provider_credentials_refused");
  }
  return accessToken;
};

export const readProtectedProviderActivityEvidence = (
  descriptor: number,
): ProviderActivityTargetEvidence => {
  let first: Buffer | undefined;
  let second: Buffer | undefined;
  let evidence: ProviderActivityTargetEvidence | undefined;
  let refused = false;
  try {
    const uid = process.getuid?.();
    if (
      uid === undefined
      || !Number.isSafeInteger(descriptor)
      || descriptor < 3
      || descriptor > 255
      || isatty(descriptor)
    ) throw new CurrentAliasReleaseError("recovery_evidence_invalid");
    const initial = fstatSync(descriptor);
    proveDescriptorAclAbsence(descriptor, {}, "recovery_evidence_invalid");
    if (
      !initial.isFile()
      || initial.uid !== uid
      || initial.nlink !== 1
      || (initial.mode & 0o777) !== 0o600
      || initial.size <= 0
      || initial.size > inputMaximumBytes
    ) throw new CurrentAliasReleaseError("recovery_evidence_invalid");
    first = readCredentialDescriptor(descriptor, initial.size);
    const afterFirstRead = fstatSync(descriptor);
    second = readCredentialDescriptor(descriptor, initial.size);
    const final = fstatSync(descriptor);
    proveDescriptorAclAbsence(descriptor, {}, "recovery_evidence_invalid");
    if (
      !sameCredentialIdentity(initial, afterFirstRead)
      || !sameCredentialIdentity(initial, final)
      || !first.subarray(0, initial.size).equals(second.subarray(0, initial.size))
    ) throw new CurrentAliasReleaseError("recovery_evidence_invalid");
    const document = new TextDecoder("utf-8", { fatal: true })
      .decode(first.subarray(0, initial.size));
    evidence = currentAliasReleaseProviderActivityEvidenceSchema.parse(
      JSON.parse(document) as unknown,
    );
  } catch {
    refused = true;
  } finally {
    first?.fill(0);
    second?.fill(0);
    try {
      closeSync(descriptor);
    } catch {
      refused = true;
    }
  }
  if (refused || evidence === undefined) {
    throw new CurrentAliasReleaseError("recovery_evidence_invalid");
  }
  return evidence;
};

type VercelCurrentProjectAliasProviderOptions = Readonly<{
  convexVerifier?: ConvexTargetVerifier;
  environment?: Readonly<NodeJS.ProcessEnv>;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  guard?: BoundedProcessInvocationGuard;
  runner?: VercelCommandRunner;
  vercelCli: string;
}>;

class VercelCurrentProjectAliasProvider
implements CurrentProjectAliasReleaseProvider {
  readonly #convexVerifier: ConvexTargetVerifier;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #guard: BoundedProcessInvocationGuard;
  readonly #runner: VercelCommandRunner;
  readonly #vercelCli: string;

  constructor(options: VercelCurrentProjectAliasProviderOptions) {
    if (!isAbsolute(options.vercelCli) || options.vercelCli.length > 4_096) {
      throw new CurrentAliasReleaseError("usage_invalid");
    }
    this.#convexVerifier = options.convexVerifier ?? verifyConvexDefaultTarget;
    this.#environment = buildVercelEnvironment(options.environment ?? process.env);
    this.#fetcher = createBoundedAuthorityFetch(
      options.fetcher ?? fetch,
      5_000,
      "vercel_marker_timeout",
    );
    this.#guard = options.guard ?? new BoundedProcessInvocationGuard();
    this.#runner = options.runner ?? runVercelCommand;
    this.#vercelCli = options.vercelCli;
  }

  async #invoke(arguments_: readonly string[], phase: string): Promise<string> {
    let result: VercelCommandResult;
    try {
      result = await this.#guard.observe(async () => await this.#runner({
        arguments: ["--non-interactive", ...arguments_],
        containment: "authority",
        environment: this.#environment,
        executable: this.#vercelCli,
        phase,
      }));
    } catch (error: unknown) {
      rethrowTerminalProviderError(error);
      if (error instanceof CurrentAliasReleaseError) throw error;
      throw new CurrentAliasReleaseError("provider_command_failed");
    }
    if (result.exitCode !== 0) {
      throw new CurrentAliasReleaseError("provider_command_failed");
    }
    return result.stdout;
  }

  async verifyVercelVersion(): Promise<void> {
    const version = (await this.#invoke(["--version"], "vercel-version-read")).trim();
    if (version !== supportedVercelVersion) {
      throw new CurrentAliasReleaseError("vercel_version_unsupported");
    }
  }

  async verifyConvexTarget(target: ConvexTarget): Promise<void> {
    try {
      await this.#convexVerifier(target);
    } catch (error: unknown) {
      rethrowTerminalProviderError(error);
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
  }

  async readProject(): Promise<CurrentProjectReadback> {
    return parseProviderJson(await this.#invoke([
      "api",
      `/v9/projects/${OOMPA_VERCEL_PROJECT_ID}`,
      "--scope",
      OOMPA_VERCEL_TEAM_ID,
      "--raw",
    ], "vercel-project-read"), projectReadbackSchema);
  }

  async readDeployment(deploymentId: string): Promise<CurrentDeploymentReadback> {
    if (!deploymentIdSchema.safeParse(deploymentId).success) {
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
    return parseProviderJson(await this.#invoke([
      "api",
      `/v13/deployments/${deploymentId}`,
      "--scope",
      OOMPA_VERCEL_TEAM_ID,
      "--raw",
    ], "vercel-deployment-read"), deploymentReadbackSchema);
  }

  async readAlias(): Promise<CurrentAliasReadback> {
    return parseProviderJson(await this.#invoke([
      "api",
      `/v4/aliases/${canonicalAlias}`,
      "--scope",
      OOMPA_VERCEL_TEAM_ID,
      "--raw",
    ], "vercel-alias-read"), aliasReadbackSchema);
  }

  async readMarker(): Promise<unknown> {
    try {
      this.#guard.assertMayProceed();
      const response = await this.#fetcher(
        `https://${canonicalAlias}/.well-known/hra.json?release=${randomUUID()}`,
        {
          cache: "no-store",
          headers: { accept: "application/json", "cache-control": "no-cache" },
          method: "GET",
          redirect: "error",
        },
      );
      const document = await readBoundedBody(response);
      return JSON.parse(document) as unknown;
    } catch (error: unknown) {
      rethrowTerminalProviderError(error);
      if (error instanceof CurrentAliasReleaseError) throw error;
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
  }

  async verifyTargetActivityEvidence(): Promise<void> {
    throw new CurrentAliasReleaseError("recovery_evidence_invalid");
  }

  async setAlias(
    endpoint: CurrentProjectAliasEndpoint,
    idempotencyKey: string,
  ): Promise<CurrentAliasMutationReadback> {
    return parseProviderJson(
      await this.#invoke(
        currentAliasReleaseApiArguments(endpoint, idempotencyKey),
        `vercel-alias-set-${idempotencyKey.slice(0, 32)}`,
      ),
      aliasMutationReadbackSchema,
    );
  }
}

type VercelCurrentProjectAliasApiProviderOptions = Readonly<{
  accessToken: string;
  convexVerifier?: ConvexTargetVerifier;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}>;

class VercelCurrentProjectAliasApiProvider
implements CurrentProjectAliasReleaseProvider {
  readonly #accessToken: string;
  readonly #convexVerifier: ConvexTargetVerifier;
  readonly #fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

  constructor(options: VercelCurrentProjectAliasApiProviderOptions) {
    const token = vercelAccessTokenSchema.safeParse(options.accessToken);
    if (!token.success) {
      throw new CurrentAliasReleaseError("provider_credentials_refused");
    }
    this.#accessToken = token.data;
    this.#convexVerifier = options.convexVerifier ?? verifyConvexDefaultTarget;
    this.#fetcher = createBoundedAuthorityFetch(
      options.fetcher ?? fetch,
      vercelRequestTimeoutMs,
      "vercel_api_timeout",
    );
  }

  #apiUrl(path: string): URL {
    const url = new URL(path, vercelApiOrigin);
    if (url.origin !== vercelApiOrigin || !url.pathname.startsWith("/v")) {
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
    url.searchParams.set("teamId", OOMPA_VERCEL_TEAM_ID);
    return url;
  }

  async #read<Value>(path: string, schema: z.ZodType<Value>): Promise<Value> {
    const url = this.#apiUrl(path);
    try {
      const response = await this.#fetcher(url, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.#accessToken}`,
          "cache-control": "no-cache",
        },
        method: "GET",
        redirect: "error",
      });
      if (response.url !== "" && response.url !== url.href) {
        await response.body?.cancel().catch(() => undefined);
        throw new CurrentAliasReleaseError("provider_readback_invalid");
      }
      return parseProviderJson(
        await readBoundedBody(response, outputMaximumBytes),
        schema,
      );
    } catch (error: unknown) {
      if (error instanceof CurrentAliasReleaseError) throw error;
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
  }

  async verifyVercelVersion(): Promise<void> {
    // The fixed REST endpoint versions and strict response schemas are this
    // transport's compatibility boundary. No Vercel executable is launched.
  }

  async verifyConvexTarget(target: ConvexTarget): Promise<void> {
    try {
      await this.#convexVerifier(target);
    } catch {
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
  }

  async readProject(): Promise<CurrentProjectReadback> {
    return await this.#read(
      `/v9/projects/${OOMPA_VERCEL_PROJECT_ID}`,
      projectReadbackSchema,
    );
  }

  async readDeployment(deploymentId: string): Promise<CurrentDeploymentReadback> {
    if (!deploymentIdSchema.safeParse(deploymentId).success) {
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
    return await this.#read(`/v13/deployments/${deploymentId}`, deploymentReadbackSchema);
  }

  async readAlias(): Promise<CurrentAliasReadback> {
    return await this.#read(`/v4/aliases/${canonicalAlias}`, aliasReadbackSchema);
  }

  async readMarker(): Promise<unknown> {
    try {
      const response = await this.#fetcher(
        `https://${canonicalAlias}/.well-known/hra.json?release=${randomUUID()}`,
        {
          cache: "no-store",
          headers: { accept: "application/json", "cache-control": "no-cache" },
          method: "GET",
          redirect: "error",
        },
      );
      return JSON.parse(await readBoundedBody(response)) as unknown;
    } catch (error: unknown) {
      if (error instanceof CurrentAliasReleaseError) throw error;
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
  }

  async verifyTargetActivityEvidence(
    plan: CurrentProjectAliasReleasePlan,
    evidence: ProviderActivityTargetEvidence,
  ): Promise<void> {
    const parsedEvidence = currentAliasReleaseProviderActivityEvidenceSchema.safeParse(evidence);
    if (!parsedEvidence.success) {
      throw new CurrentAliasReleaseError("recovery_evidence_invalid");
    }
    const expected = parsedEvidence.data;
    try {
      const alias = await this.#read(
        `/v4/aliases/${canonicalAlias}`,
        recoveryAliasReadbackSchema,
      );
      if (
        !aliasMatches(alias, plan.vercel.target)
        || alias.createdAt !== expected.alias.createdAtMs
        || alias.updatedAt !== expected.alias.updatedAtMs
        || alias.uid !== expected.alias.uid
      ) throw new CurrentAliasReleaseError("recovery_evidence_invalid");

      const targetAliases = await this.#read(
        `/v2/deployments/${plan.vercel.target.deploymentId}/aliases`,
        deploymentAliasListSchema,
      );
      const sourceAliases = await this.#read(
        `/v2/deployments/${plan.vercel.source.deploymentId}/aliases`,
        deploymentAliasListSchema,
      );
      const matchingTargetAliases = targetAliases.aliases.filter((item) =>
        item.alias === canonicalAlias || item.uid === expected.alias.uid
      );
      if (
        matchingTargetAliases.length !== 1
        || matchingTargetAliases[0]?.alias !== canonicalAlias
        || matchingTargetAliases[0].uid !== expected.alias.uid
        || sourceAliases.aliases.some((item) =>
          item.alias === canonicalAlias || item.uid === expected.alias.uid
        )
      ) throw new CurrentAliasReleaseError("recovery_evidence_invalid");

      const activityQuery = new URLSearchParams({
        limit: "100",
        since: new Date(expected.intentPublishedAtMs - 250).toISOString(),
        types: "aliases-assigned",
      });
      const activity = await this.#read(
        `/v3/events?${activityQuery.toString()}`,
        aliasActivityEventsSchema,
      );
      if (activity.events.length >= 100) {
        throw new CurrentAliasReleaseError("recovery_evidence_invalid");
      }
      const incidentWindow = activity.events.filter((item) =>
        item.createdAt >= expected.intentPublishedAtMs - 250
        && item.createdAt <= expected.activity.createdAtMs + 250
      );
      if (incidentWindow.length !== 1) {
        throw new CurrentAliasReleaseError("recovery_evidence_invalid");
      }
      const event = incidentWindow[0];
      if (event === undefined) {
        throw new CurrentAliasReleaseError("recovery_evidence_invalid");
      }
      const entityValues = (type: string): string[] => event.entities.flatMap((entity) => {
        if (
          entity.type !== type
          || entity.start > entity.end
          || entity.end > event.text.length
        ) return [];
        return [event.text.slice(entity.start, entity.end)];
      });
      if (
        event.id !== expected.activity.eventId
        || event.created !== event.createdAt
        || event.createdAt !== expected.activity.createdAtMs
        || event.principalId !== expected.activity.principalId
        || event.userId !== expected.activity.principalId
        || event.principal.uid !== expected.activity.principalId
        || event.user.uid !== expected.activity.principalId
        || [...event.categories].sort().join("\0") !== "domain\0project"
        || createHash("sha256").update(event.text).digest("hex")
          !== expected.activity.textSha256
        || entityValues("bold").length !== 1
        || entityValues("bold")[0] !== "an alias"
        || entityValues("deployment_host").length !== 1
        || entityValues("deployment_host")[0] !== plan.vercel.target.deploymentUrl
      ) throw new CurrentAliasReleaseError("recovery_evidence_invalid");
    } catch (error: unknown) {
      if (error instanceof CurrentAliasReleaseError) throw error;
      throw new CurrentAliasReleaseError("recovery_evidence_invalid");
    }
  }

  async setAlias(
    endpoint: CurrentProjectAliasEndpoint,
    idempotencyKey: string,
  ): Promise<CurrentAliasMutationReadback> {
    const request = currentAliasReleaseVercelApiRequest(
      endpoint,
      idempotencyKey,
      this.#accessToken,
    );
    try {
      const response = await this.#fetcher(request.url, {
        body: request.body,
        headers: request.headers,
        method: request.method,
        redirect: "error",
      });
      if (response.url !== "" && response.url !== request.url) {
        await response.body?.cancel().catch(() => undefined);
        throw new CurrentAliasReleaseError("provider_readback_invalid");
      }
      return parseProviderJson(
        await readBoundedBody(response, outputMaximumBytes),
        aliasMutationReadbackSchema,
      );
    } catch (error: unknown) {
      if (error instanceof CurrentAliasReleaseError) throw error;
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
  }
}

type ParsedArguments = Readonly<{
  confirmation?: string;
  operation: "execute" | "preflight" | "recover-source";
  planFd: number;
  planFile?: string;
  recoveryEvidenceFd?: number;
  recoveryEvidenceFile?: string;
  vercelAuthFd?: number;
  vercelAuthFile?: string;
  vercelCli?: string;
}>;

export const parseArguments = (arguments_: readonly string[]): ParsedArguments => {
  let confirmation: string | undefined;
  let operation: ParsedArguments["operation"] | undefined;
  let planFd = 0;
  let planFile: string | undefined;
  let recoveryEvidenceFd: number | undefined;
  let recoveryEvidenceFile: string | undefined;
  let vercelAuthFd: number | undefined;
  let vercelAuthFile: string | undefined;
  let vercelCli: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--plan-file" || argument === "--vercel-auth-file"
      || argument === "--recovery-evidence-file") {
      const value = arguments_[index + 1];
      if (!isExplicitAliasInputPath(value)) throw new CurrentAliasReleaseError("usage_invalid");
      if (argument === "--plan-file" && planFile === undefined) planFile = value;
      else if (argument === "--vercel-auth-file" && vercelAuthFile === undefined) vercelAuthFile = value;
      else if (argument === "--recovery-evidence-file" && recoveryEvidenceFile === undefined) recoveryEvidenceFile = value;
      else throw new CurrentAliasReleaseError("usage_invalid");
      index += 1;
      continue;
    }
    if (argument === "preflight" && operation === undefined) {
      operation = "preflight";
      continue;
    }
    if (argument === "--execute" && operation === undefined) {
      operation = "execute";
      continue;
    }
    if (argument === "recover-source" && operation === undefined) {
      operation = "recover-source";
      continue;
    }
    if (argument === "--confirm-exact" && confirmation === undefined) {
      const value = arguments_[index + 1];
      if (value === undefined || value.length > 2_048) {
        throw new CurrentAliasReleaseError("usage_invalid");
      }
      confirmation = value;
      index += 1;
      continue;
    }
    if (argument === "--plan-fd" && planFd === 0) {
      const value = arguments_[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw new CurrentAliasReleaseError("usage_invalid");
      }
      planFd = Number(value);
      if (!Number.isSafeInteger(planFd) || planFd < 3 || planFd > 255) {
        throw new CurrentAliasReleaseError("usage_invalid");
      }
      index += 1;
      continue;
    }
    if (argument === "--vercel-cli" && vercelCli === undefined) {
      const value = arguments_[index + 1];
      if (value === undefined || !isAbsolute(value) || value.length > 4_096) {
        throw new CurrentAliasReleaseError("usage_invalid");
      }
      vercelCli = value;
      index += 1;
      continue;
    }
    if (argument === "--vercel-auth-fd" && vercelAuthFd === undefined) {
      const value = arguments_[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw new CurrentAliasReleaseError("usage_invalid");
      }
      vercelAuthFd = Number(value);
      if (!Number.isSafeInteger(vercelAuthFd) || vercelAuthFd < 3 || vercelAuthFd > 255) {
        throw new CurrentAliasReleaseError("usage_invalid");
      }
      index += 1;
      continue;
    }
    if (argument === "--recovery-evidence-fd" && recoveryEvidenceFd === undefined) {
      const value = arguments_[index + 1];
      if (value === undefined || !/^[0-9]+$/u.test(value)) {
        throw new CurrentAliasReleaseError("usage_invalid");
      }
      recoveryEvidenceFd = Number(value);
      if (
        !Number.isSafeInteger(recoveryEvidenceFd)
        || recoveryEvidenceFd < 3
        || recoveryEvidenceFd > 255
      ) throw new CurrentAliasReleaseError("usage_invalid");
      index += 1;
      continue;
    }
    throw new CurrentAliasReleaseError("usage_invalid");
  }
  if (
    operation === undefined
    || [vercelCli, vercelAuthFd, vercelAuthFile].filter((value) => value !== undefined).length !== 1
    || planFile !== undefined && planFd !== 0
    || recoveryEvidenceFile !== undefined && recoveryEvidenceFd !== undefined
    || recoveryEvidenceFile !== undefined && operation !== "recover-source"
    || recoveryEvidenceFile !== undefined && vercelCli !== undefined
    || new Set([planFile, vercelAuthFile, recoveryEvidenceFile].filter((value) => value !== undefined)).size
      !== [planFile, vercelAuthFile, recoveryEvidenceFile].filter((value) => value !== undefined).length
    || vercelAuthFd !== undefined && planFd === vercelAuthFd
    || operation === "preflight" && confirmation !== undefined
    || operation !== "recover-source" && recoveryEvidenceFd !== undefined
    || recoveryEvidenceFd !== undefined && (
      recoveryEvidenceFd === planFd
      || recoveryEvidenceFd === vercelAuthFd
    )
  ) throw new CurrentAliasReleaseError("usage_invalid");
  return {
    ...(confirmation === undefined ? {} : { confirmation }),
    operation,
    planFd,
    ...(planFile === undefined ? {} : { planFile }),
    ...(recoveryEvidenceFd === undefined ? {} : { recoveryEvidenceFd }),
    ...(recoveryEvidenceFile === undefined ? {} : { recoveryEvidenceFile }),
    ...(vercelAuthFd === undefined ? {} : { vercelAuthFd }),
    ...(vercelAuthFile === undefined ? {} : { vercelAuthFile }),
    ...(vercelCli === undefined ? {} : { vercelCli }),
  };
};

const isExplicitAliasInputPath = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 4_096
  && !hasControlCharacter(value) && isAbsolute(value) && resolve(value) === value;

// Open only caller-selected files, after scheduler admission. No inherited
// descriptor is repurposed and importing this module discovers no input path.
const readProtectedAliasInputFile = (
  path: string,
  maximumBytes: number,
  code: "input_not_protected" | "provider_credentials_refused" | "recovery_evidence_invalid",
): string => {
  let descriptor: number | undefined;
  let first: Buffer | undefined;
  let second: Buffer | undefined;
  let document: string | undefined;
  let refused = false;
  try {
    if (!isExplicitAliasInputPath(path)) throw new CurrentAliasReleaseError(code);
    const uid = process.getuid?.();
    const initial = lstatSync(path);
    if (uid === undefined || !initial.isFile() || initial.uid !== uid
      || initial.nlink !== 1 || (initial.mode & 0o777) !== 0o600
      || initial.size <= 0 || initial.size > maximumBytes) throw new CurrentAliasReleaseError(code);
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!sameCredentialIdentity(initial, fstatSync(descriptor))) throw new CurrentAliasReleaseError(code);
    proveDescriptorAclAbsence(descriptor, {}, code);
    first = readCredentialDescriptor(descriptor, initial.size);
    const afterFirstRead = fstatSync(descriptor);
    second = readCredentialDescriptor(descriptor, initial.size);
    const final = fstatSync(descriptor);
    proveDescriptorAclAbsence(descriptor, {}, code);
    if (!sameCredentialIdentity(initial, afterFirstRead)
      || !sameCredentialIdentity(initial, final)
      || !sameCredentialIdentity(initial, lstatSync(path))
      || !first.equals(second)) throw new CurrentAliasReleaseError(code);
    document = new TextDecoder("utf-8", { fatal: true }).decode(first.subarray(0, initial.size));
  } catch {
    refused = true;
  } finally {
    first?.fill(0);
    second?.fill(0);
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { refused = true; }
    }
  }
  if (refused || document === undefined) throw new CurrentAliasReleaseError(code);
  return document;
};

export const readProtectedVercelAccessTokenFile = (
  path: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): string => {
  try {
    return parseProtectedVercelSession(
      readProtectedAliasInputFile(path, vercelAuthMaximumBytes, "provider_credentials_refused"),
      nowSeconds,
    );
  } catch { throw new CurrentAliasReleaseError("provider_credentials_refused"); }
};

export const readProtectedAliasPlanFile = (path: string): string => {
  const document = readProtectedAliasInputFile(path, inputMaximumBytes, "input_not_protected");
  parseCurrentProjectAliasReleasePlan(document);
  return document;
};

export const readProtectedProviderActivityEvidenceFile = (path: string): ProviderActivityTargetEvidence => {
  try {
    return currentAliasReleaseProviderActivityEvidenceSchema.parse(JSON.parse(
      readProtectedAliasInputFile(path, inputMaximumBytes, "recovery_evidence_invalid"),
    ) as unknown);
  } catch { throw new CurrentAliasReleaseError("recovery_evidence_invalid"); }
};

const directAliasAccessToken = (arguments_: ParsedArguments, accessToken: string | undefined): string => {
  if (accessToken !== undefined) return accessToken;
  if (arguments_.vercelAuthFile !== undefined) return readProtectedVercelAccessTokenFile(arguments_.vercelAuthFile);
  if (arguments_.vercelAuthFd !== undefined) return readProtectedVercelAccessToken(arguments_.vercelAuthFd);
  throw new CurrentAliasReleaseError("provider_credentials_refused");
};

export const readPlanInput = async (fd: number, timeoutMs = 15_000): Promise<string> => {
  if (isatty(fd)) throw new CurrentAliasReleaseError("input_not_protected");
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const stream = createReadStream("", { autoClose: fd !== 0, fd });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: CurrentAliasReleaseError): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      else rejectPromise(error);
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish(new CurrentAliasReleaseError("input_timed_out"));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > inputMaximumBytes) {
        stream.destroy();
        finish(new CurrentAliasReleaseError("input_too_large"));
      } else chunks.push(chunk);
    });
    stream.once("error", () => finish(new CurrentAliasReleaseError("input_invalid")));
    stream.once("end", () => finish());
  });
};

type ExecuteOptions = Readonly<{
  afterIntentPublication?: (
    path: string,
    intent: CurrentAliasReleaseIntent,
  ) => void;
  arguments: readonly string[];
  clock?: ReleaseClock;
  convexVerifier?: ConvexTargetVerifier;
  environment?: Readonly<NodeJS.ProcessEnv>;
  fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  inputDocument: string;
  provider?: CurrentProjectAliasReleaseProvider;
  providerActivityEvidence?: ProviderActivityTargetEvidence;
  receiptWriter?: (
    path: string,
    receipt: CurrentAliasReleaseReceipt,
  ) => void;
  runner?: VercelCommandRunner;
  stateDirectory?: string;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  timeoutMs?: number;
  vercelAccessToken?: string;
}>;

const renderFailure = (
  error: unknown,
  stderr: Pick<NodeJS.WriteStream, "write">,
  durableContext?: DurableFailureContext,
  unresolvedIntent = false,
): number => {
  const effectiveDurableContext = error instanceof CurrentAliasReleaseError
      && error.durableContext !== undefined
    ? error.durableContext
    : durableContext;
  const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
  if (authorityUnavailable !== undefined) {
    if (unresolvedIntent && isAuthorityContainmentUnavailable(error)) {
      stderr.write(`${JSON.stringify({
        code: "authority_containment_unavailable",
        ...(effectiveDurableContext === undefined ? {} : effectiveDurableContext),
        reason: error.reason,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    stderr.write(authorityUnavailable);
    return 1;
  }
  if (isBoundedProcessCleanupUnprovenError(error)) {
    stderr.write(`${JSON.stringify({
      code: "process_cleanup_unproven",
      phase: error.phase,
      processGroupId: error.processGroupId,
      processes: error.processes,
      recoveryPaths: error.recoveryPaths,
      ...(effectiveDurableContext === undefined ? {} : effectiveDurableContext),
      schemaVersion: 1,
      status: "recovery_required",
    })}\n`);
    return 75;
  }
  if (isBoundedProcessRecoveryJournalError(error)) {
    stderr.write(`${JSON.stringify({
      code: "process_recovery_journal_blocked",
      reason: error.reason,
      recoveryPaths: error.recoveryPaths,
      ...(effectiveDurableContext === undefined ? {} : effectiveDurableContext),
      schemaVersion: 1,
      status: "recovery_required",
    })}\n`);
    return 75;
  }
  const code = error instanceof CurrentAliasReleaseError
    ? error.code
    : "input_invalid";
  const recoveryRequired = unresolvedIntent
    || code === "compensation_failed"
    || code === "durable_state_capacity_exhausted"
    || code === "receipt_authority_mismatch"
    || code === "receipt_write_failed"
    || code === "intent_write_failed"
    || code === "source_recovery_write_failed"
    || code === "target_phase_write_failed"
    || code === "unresolved_prior_intent"
    || code === "unresolved_source_recovery"
    || code === "durable_state_invalid" && effectiveDurableContext !== undefined;
  const status = recoveryRequired
    ? "recovery_required"
    : code === "alias_reverted"
      ? "reverted"
      : "refused";
  stderr.write(`${JSON.stringify({
    code,
    ...(effectiveDurableContext === undefined ? {} : effectiveDurableContext),
    schemaVersion: 1,
    status,
  })}\n`);
  return recoveryRequired ? 75 : 1;
};

const writeCurrentAliasReleaseReceipt = (
  path: string,
  receipt: CurrentAliasReleaseReceipt,
): void => {
  try {
    writeProtectedJsonNoReplace(path, receipt, currentAliasReleaseReceiptSchema, {
      allowExactReplay: true,
    });
  } catch {
    throw new CurrentAliasReleaseError("receipt_write_failed");
  }
};

const executeCurrentProjectAliasRelease = async (
  options: ExecuteOptions,
): Promise<number> => {
  let durableContext: DurableFailureContext | undefined;
  let unresolvedIntent = false;
  try {
    assertCurrentAliasReleaseBunVersion();
    const arguments_ = parseArguments(options.arguments);
    const plan = parseCurrentProjectAliasReleasePlan(options.inputDocument);
    const stateDirectory = options.stateDirectory ?? currentAliasReleaseStateDirectory();
    const unverifiedStateDirectory = resolve(stateDirectory);
    const unverifiedPaths = {
      intent: join(unverifiedStateDirectory, `${plan.idempotencyKey}.intent.json`),
      receipt: join(unverifiedStateDirectory, `${plan.idempotencyKey}.receipt.json`),
    };
    durableContext = {
      idempotencyKey: plan.idempotencyKey,
      intentPath: unverifiedPaths.intent,
      lockPath: join(unverifiedStateDirectory, executionLockName),
      receiptPath: unverifiedPaths.receipt,
    };
    if (arguments_.operation === "preflight") {
      const lock = acquireCurrentAliasReleaseExecutionLock(stateDirectory);
      let preflightExitCode = 75;
      let preflightOutput = "";
      try {
        const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
        durableContext = {
          idempotencyKey: plan.idempotencyKey,
          intentPath: paths.intent,
          lockPath: lock.path,
          receiptPath: paths.receipt,
        };
        const durableState = inspectCurrentAliasReleaseDurableState(
          plan,
          dirname(paths.intent),
        );
        unresolvedIntent = durableState.intent !== null && durableState.receipt === null;
        if (unresolvedIntent) {
          throw new CurrentAliasReleaseError("unresolved_current_intent");
        }
        const guard = new BoundedProcessInvocationGuard();
        for (const path of [
          lock.path,
          paths.intent,
          paths.receipt,
          paths.sourceRecovery,
          paths.targetPhase,
        ]) {
          guard.retainRecoveryPath(path);
        }
        const provider = options.provider ?? (arguments_.vercelCli !== undefined
          ? new VercelCurrentProjectAliasProvider({
              ...(options.convexVerifier === undefined
                ? {}
                : { convexVerifier: options.convexVerifier }),
              ...(options.environment === undefined ? {} : { environment: options.environment }),
              ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
              guard,
              ...(options.runner === undefined ? {} : { runner: options.runner }),
              vercelCli: arguments_.vercelCli,
            })
          : new VercelCurrentProjectAliasApiProvider({
              accessToken: directAliasAccessToken(arguments_, options.vercelAccessToken),
              ...(options.convexVerifier === undefined
                ? {}
                : { convexVerifier: options.convexVerifier }),
              ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            }));
        const observation = await observeCurrentAliasAuthority(plan, provider);
        if (
          durableState.receipt !== null
          && durableState.receipt.finalState !== observation.state
        ) throw new CurrentAliasReleaseError("receipt_authority_mismatch");
        if (durableState.receipt?.finalState === "source") {
          throw new CurrentAliasReleaseError("alias_reverted");
        }
        const ready = observation.state === "source";
        const idempotencyKey = plan.idempotencyKey;
        preflightOutput = `${JSON.stringify({
          alias: plan.alias,
          idempotencyKey,
          nextAction: ready
            ? "execute_with_machine_token_under_standing_task_authority"
            : observation.state === "target"
              ? "none"
              : "stop_and_investigate",
          observedState: observation.state,
          reason: observation.reason,
          ...(ready ? { requiredConfirmation: requiredAliasConfirmation(plan) } : {}),
          schemaVersion: 3,
          sourceDeploymentId: plan.vercel.source.deploymentId,
          status: ready
            ? "ready"
            : observation.state === "target"
              ? "already_committed"
              : "blocked",
          targetDeploymentId: plan.vercel.target.deploymentId,
          targetProjectId: plan.vercel.projectId,
        })}\n`;
        preflightExitCode = observation.state === "blocked" ? 1 : 0;
      } finally {
        lock.release();
      }
      options.stdout.write(preflightOutput);
      return preflightExitCode;
    }
    if (arguments_.confirmation !== requiredAliasConfirmation(plan)) {
      throw new CurrentAliasReleaseError("confirmation_required");
    }
    const lock = acquireCurrentAliasReleaseExecutionLock(stateDirectory);
    let output: string;
    try {
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const idempotencyKey = plan.idempotencyKey;
      durableContext = {
        idempotencyKey,
        intentPath: paths.intent,
        lockPath: lock.path,
        receiptPath: paths.receipt,
      };
      const guard = new BoundedProcessInvocationGuard();
      for (const path of [
        lock.path,
        paths.intent,
        paths.receipt,
        paths.sourceRecovery,
        paths.targetPhase,
      ]) {
        guard.retainRecoveryPath(path);
      }
      const durableState = inspectCurrentAliasReleaseDurableState(
        plan,
        dirname(paths.intent),
      );
      unresolvedIntent = durableState.intent !== null && durableState.receipt === null;
      const provider = options.provider ?? (arguments_.vercelCli !== undefined
        ? new VercelCurrentProjectAliasProvider({
            ...(options.convexVerifier === undefined
              ? {}
              : { convexVerifier: options.convexVerifier }),
            ...(options.environment === undefined ? {} : { environment: options.environment }),
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            guard,
            ...(options.runner === undefined ? {} : { runner: options.runner }),
            vercelCli: arguments_.vercelCli,
          })
        : new VercelCurrentProjectAliasApiProvider({
            accessToken: directAliasAccessToken(arguments_, options.vercelAccessToken),
            ...(options.convexVerifier === undefined
              ? {}
              : { convexVerifier: options.convexVerifier }),
              ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            }));
      if (arguments_.operation === "recover-source") {
        const intent = durableState.intent;
        if (intent === null) {
          throw new CurrentAliasReleaseError("recovery_not_permitted");
        }
        if (durableState.receipt !== null) {
          const observation = await observeCurrentAliasAuthority(plan, provider);
          if (
            durableState.receipt.finalState !== "source"
            || observation.state !== "source"
          ) throw new CurrentAliasReleaseError("receipt_authority_mismatch");
          if (
            durableState.targetPhase === null
            || durableState.sourceRecovery === null
            || durableState.receipt.targetPhaseDigest !== durableState.targetPhase.selfDigest
            || durableState.receipt.sourceRecoveryDigest
              !== durableState.sourceRecovery.selfDigest
          ) throw new CurrentAliasReleaseError("alias_reverted");
          output = `${JSON.stringify({
            alias: plan.alias,
            changed: durableState.receipt.changed,
            idempotencyKey,
            intentDigest: intent.selfDigest,
            receiptDigest: durableState.receipt.selfDigest,
            replayed: true,
            schemaVersion: 1,
            sourceDeploymentId: plan.vercel.source.deploymentId,
            sourceDeploymentUrl: plan.vercel.source.deploymentUrl,
            status: "recovered_source",
          })}\n`;
          lock.assertHeld();
          lock.release();
          options.stdout.write(output);
          return 0;
        }
        if (durableState.sourceRecovery !== null) {
          throw new CurrentAliasReleaseError("unresolved_source_recovery");
        }
        const suppliedActivityEvidence = options.providerActivityEvidence
          ?? (arguments_.recoveryEvidenceFd === undefined
            ? undefined
            : readProtectedProviderActivityEvidence(arguments_.recoveryEvidenceFd));
        let targetPhase = durableState.targetPhase;
        if (targetPhase === null) {
          if (suppliedActivityEvidence === undefined) {
            throw new CurrentAliasReleaseError("recovery_evidence_invalid");
          }
          assertProviderActivityIntentPublication(paths.intent, suppliedActivityEvidence);
          await provider.verifyTargetActivityEvidence(plan, suppliedActivityEvidence);
          lock.assertHeld();
          const candidate = currentAliasReleaseTargetPhaseForProviderActivity(
            plan,
            intent,
            suppliedActivityEvidence,
          );
          targetPhase = reserveCurrentAliasReleaseTargetPhase(
            paths.targetPhase,
            candidate,
          );
          if (targetPhase.selfDigest !== candidate.selfDigest) {
            throw new CurrentAliasReleaseError("target_phase_write_failed");
          }
        } else if (suppliedActivityEvidence !== undefined) {
          if (
            targetPhase.evidence.kind !== "provider-activity-and-operator-provenance"
            || targetPhase.evidence.selfDigest !== suppliedActivityEvidence.selfDigest
          ) throw new CurrentAliasReleaseError("recovery_evidence_invalid");
        }
        if (targetPhase.evidence.kind === "provider-activity-and-operator-provenance") {
          assertProviderActivityIntentPublication(paths.intent, targetPhase.evidence);
          await provider.verifyTargetActivityEvidence(plan, targetPhase.evidence);
        }
        let sourceRecovery: CurrentAliasReleaseSourceRecovery | undefined;
        const rollbackDiagnostic = await recoverCurrentAliasReleaseSource(
          plan,
          provider,
          targetPhase,
          options.clock ?? defaultClock,
          options.timeoutMs ?? convergenceTimeoutMs,
          lock.assertHeld,
          (diagnostic) => {
            const candidate = currentAliasReleaseSourceRecoveryFor(
              intent,
              targetPhase,
              diagnostic,
            );
            sourceRecovery = reserveCurrentAliasReleaseSourceRecovery(
              paths.sourceRecovery,
              candidate,
            );
            if (sourceRecovery.selfDigest !== candidate.selfDigest) {
              throw new CurrentAliasReleaseError("source_recovery_write_failed");
            }
            return sourceRecovery;
          },
        );
        if (sourceRecovery === undefined) {
          throw new CurrentAliasReleaseError("source_recovery_write_failed");
        }
        lock.assertHeld();
        const candidate = currentAliasReleaseReceiptFor(
          plan,
          intent,
          true,
          "source",
          { rollbackDiagnostic, sourceRecovery, targetPhase },
        );
        try {
          (options.receiptWriter ?? writeCurrentAliasReleaseReceipt)(
            paths.receipt,
            candidate,
          );
          const receipt = readProtectedJson(
            paths.receipt,
            currentAliasReleaseReceiptSchema,
            { recoverInterruptedPublication: true },
          );
          if (receipt.selfDigest !== candidate.selfDigest) {
            throw new Error("receipt changed");
          }
          unresolvedIntent = false;
          output = `${JSON.stringify({
            alias: plan.alias,
            changed: true,
            idempotencyKey,
            intentDigest: intent.selfDigest,
            receiptDigest: receipt.selfDigest,
            replayed: false,
            schemaVersion: 1,
            sourceDeploymentId: plan.vercel.source.deploymentId,
            sourceDeploymentUrl: plan.vercel.source.deploymentUrl,
            sourceRecoveryDigest: sourceRecovery.selfDigest,
            status: "recovered_source",
            targetPhaseDigest: targetPhase.selfDigest,
          })}\n`;
        } catch {
          throw new CurrentAliasReleaseError("receipt_write_failed");
        }
        lock.assertHeld();
        lock.release();
        options.stdout.write(output);
        return 0;
      }
      let initial: AliasAuthorityObservation;
      try {
        initial = await observeCurrentAliasAuthority(plan, provider);
      } catch (error: unknown) {
        rethrowTerminalProviderError(error);
        if (durableState.receipt !== null) {
          throw new CurrentAliasReleaseError("receipt_authority_mismatch");
        }
        throw error;
      }
      let receipt: CurrentAliasReleaseReceipt;
      let replayed: boolean;
      let intent = durableState.intent;
      const intentWasPreexisting = intent !== null;
      if (durableState.receipt !== null) {
        if (initial.state !== durableState.receipt.finalState) {
          throw new CurrentAliasReleaseError("receipt_authority_mismatch");
        }
        if (durableState.receipt.finalState === "source") {
          throw new CurrentAliasReleaseError("alias_reverted");
        }
        receipt = durableState.receipt;
        replayed = true;
      } else {
        if (intent === null) {
          if (initial.state === "blocked") {
            throw new CurrentAliasReleaseError("source_not_authoritative");
          }
          if (initial.state === "target") {
            output = `${JSON.stringify({
              alias: plan.alias,
              changed: false,
              idempotencyKey,
              replayed: true,
              schemaVersion: 1,
              status: "already_committed",
              targetDeploymentId: plan.vercel.target.deploymentId,
              targetDeploymentUrl: plan.vercel.target.deploymentUrl,
              targetProjectId: plan.vercel.projectId,
              targetSourceCommit: plan.vercel.target.sourceCommit,
            })}\n`;
            lock.assertHeld();
            lock.release();
            options.stdout.write(output);
            return 0;
          }
          lock.assertHeld();
          unresolvedIntent = true;
          intent = reserveCurrentAliasReleaseIntent(
            paths.intent,
            plan,
            options.afterIntentPublication,
          );
        }
        let outcome: CurrentAliasReleaseOutcome;
        let targetPhase = durableState.targetPhase;
        let sourceRecovery = durableState.sourceRecovery;
        try {
          outcome = intentWasPreexisting
            ? await reconcileCurrentAliasReleaseIntent(
                plan,
                provider,
                options.clock ?? defaultClock,
                options.timeoutMs ?? convergenceTimeoutMs,
                lock.assertHeld,
              )
            : await executeCurrentAliasReleasePlan(
                plan,
                provider,
                arguments_.confirmation,
                options.clock ?? defaultClock,
                options.timeoutMs ?? convergenceTimeoutMs,
                lock.assertHeld,
                (response) => {
                  if (intent === null) {
                    throw new CurrentAliasReleaseError("durable_state_invalid");
                  }
                  const candidate = currentAliasReleaseTargetPhaseForMutationResponse(
                    plan,
                    intent,
                    response,
                  );
                  targetPhase = reserveCurrentAliasReleaseTargetPhase(
                    paths.targetPhase,
                    candidate,
                  );
                  if (targetPhase.selfDigest !== candidate.selfDigest) {
                    throw new CurrentAliasReleaseError("target_phase_write_failed");
                  }
                  return targetPhase;
                },
                (diagnostic) => {
                  if (intent === null || targetPhase === null) {
                    throw new CurrentAliasReleaseError("durable_state_invalid");
                  }
                  const candidate = currentAliasReleaseSourceRecoveryFor(
                    intent,
                    targetPhase,
                    diagnostic,
                  );
                  sourceRecovery = reserveCurrentAliasReleaseSourceRecovery(
                    paths.sourceRecovery,
                    candidate,
                  );
                  if (sourceRecovery.selfDigest !== candidate.selfDigest) {
                    throw new CurrentAliasReleaseError("source_recovery_write_failed");
                  }
                  return sourceRecovery;
                },
              );
        } catch (error: unknown) {
          if (!(error instanceof CurrentAliasReleaseRevertedError)) {
            throw error;
          }
          lock.assertHeld();
          const reverted = currentAliasReleaseReceiptFor(
            plan,
            intent,
            true,
            "source",
            {
              rollbackDiagnostic: error.rollbackDiagnostic,
              ...(sourceRecovery === null ? {} : { sourceRecovery }),
              ...(targetPhase === null ? {} : { targetPhase }),
            },
          );
          try {
            (options.receiptWriter ?? writeCurrentAliasReleaseReceipt)(
              paths.receipt,
              reverted,
            );
            receipt = readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema, {
              recoverInterruptedPublication: true,
            });
          } catch {
            throw new CurrentAliasReleaseError("receipt_write_failed");
          }
          if (receipt.selfDigest !== reverted.selfDigest) {
            throw new CurrentAliasReleaseError("receipt_write_failed");
          }
          unresolvedIntent = false;
          throw error;
        }
        lock.assertHeld();
        if (targetPhase === null) {
          throw new CurrentAliasReleaseError("target_phase_write_failed");
        }
        const candidate = currentAliasReleaseReceiptFor(
          plan,
          intent,
          outcome.changed,
          "target",
          { targetPhase },
        );
        try {
          (options.receiptWriter ?? writeCurrentAliasReleaseReceipt)(
            paths.receipt,
            candidate,
          );
          receipt = readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema, {
            recoverInterruptedPublication: true,
          });
        } catch {
          throw new CurrentAliasReleaseError("receipt_write_failed");
        }
        if (receipt.selfDigest !== candidate.selfDigest) {
          throw new CurrentAliasReleaseError("receipt_write_failed");
        }
        unresolvedIntent = false;
        replayed = outcome.replayed;
      }
      if (intent === null) throw new CurrentAliasReleaseError("durable_state_invalid");
      output = `${JSON.stringify({
        alias: plan.alias,
        changed: receipt.changed,
        idempotencyKey,
        intentDigest: intent.selfDigest,
        receiptDigest: receipt.selfDigest,
        replayed,
        schemaVersion: 1,
        status: "committed",
        targetDeploymentId: plan.vercel.target.deploymentId,
        targetDeploymentUrl: plan.vercel.target.deploymentUrl,
        targetProjectId: plan.vercel.projectId,
        targetSourceCommit: plan.vercel.target.sourceCommit,
      })}\n`;
    } finally {
      lock.release();
    }
    options.stdout.write(output);
    return 0;
  } catch (error: unknown) {
    return renderFailure(error, options.stderr, durableContext, unresolvedIntent);
  }
};

export type CurrentProjectAliasReleaseExplicitCapability = Readonly<{
  afterIntentPublication?: (
    path: string,
    intent: CurrentAliasReleaseIntent,
  ) => void;
  provider: CurrentProjectAliasReleaseProvider;
  providerActivityEvidence?: ProviderActivityTargetEvidence;
  receiptWriter?: (
    path: string,
    receipt: CurrentAliasReleaseReceipt,
  ) => void;
  stateDirectory: string;
}>;

export type CurrentProjectAliasReleaseExplicitRequest = Readonly<{
  arguments: readonly string[];
  clock?: ReleaseClock;
  inputDocument: string;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  timeoutMs?: number;
}>;

const isExplicitAliasReleaseProvider = (
  value: unknown,
): value is CurrentProjectAliasReleaseProvider => {
  if (typeof value !== "object" || value === null) return false;
  for (const method of [
    "readAlias",
    "readDeployment",
    "readMarker",
    "readProject",
    "setAlias",
    "verifyTargetActivityEvidence",
    "verifyConvexTarget",
    "verifyVercelVersion",
  ] as const) {
    if (typeof Reflect.get(value, method) !== "function") return false;
  }
  return true;
};

// This seam carries no ambient or built-in provider authority. A caller must supply the
// narrowly scoped provider capability and durable-state root explicitly, so importing the
// module cannot reach the authenticated Vercel session or bypass the executable's wrapper.
export const executeCurrentProjectAliasReleaseWithExplicitCapability = async (
  capability: CurrentProjectAliasReleaseExplicitCapability,
  request: CurrentProjectAliasReleaseExplicitRequest,
): Promise<number> => {
  assertCurrentAliasReleaseBunVersion();
  const runtimeCapability: unknown = capability;
  const capabilityObject = typeof runtimeCapability === "object" && runtimeCapability !== null
    ? runtimeCapability
    : undefined;
  const provider = capabilityObject === undefined
    ? undefined
    : Reflect.get(capabilityObject, "provider") as unknown;
  const stateDirectory = capabilityObject === undefined
    ? undefined
    : Reflect.get(capabilityObject, "stateDirectory") as unknown;
  if (
    capabilityObject === undefined
    || !isExplicitAliasReleaseProvider(provider)
    || typeof stateDirectory !== "string"
    || !isAbsolute(stateDirectory)
  ) {
    return renderFailure(
      new CurrentAliasReleaseError("usage_invalid"),
      request.stderr,
    );
  }
  return await executeCurrentProjectAliasRelease({
    ...(capability.afterIntentPublication === undefined
      ? {}
      : { afterIntentPublication: capability.afterIntentPublication }),
    arguments: request.arguments,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    inputDocument: request.inputDocument,
    provider,
    ...(capability.providerActivityEvidence === undefined
      ? {}
      : { providerActivityEvidence: capability.providerActivityEvidence }),
    ...(capability.receiptWriter === undefined
      ? {}
      : { receiptWriter: capability.receiptWriter }),
    stateDirectory,
    stderr: request.stderr,
    stdout: request.stdout,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
  });
};

export type CurrentProjectAliasReleaseExplicitApiCapability = Readonly<{
  accessToken: string;
  convexVerifier: ConvexTargetVerifier;
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  providerActivityEvidence?: ProviderActivityTargetEvidence;
  stateDirectory: string;
}>;

// This deterministic seam supplies every authority capability explicitly. It
// cannot discover a credential, fetch implementation, Convex session, or state
// root and it still traverses the complete lock/intent/confirmation/receipt
// state machine. Production invocation consumes the explicit protected inputs in
// the executable wrapper instead.
export const executeCurrentProjectAliasReleaseWithExplicitApiCapability = async (
  capability: CurrentProjectAliasReleaseExplicitApiCapability,
  request: CurrentProjectAliasReleaseExplicitRequest,
): Promise<number> => {
  assertCurrentAliasReleaseBunVersion();
  const runtimeCapability: unknown = capability;
  if (typeof runtimeCapability !== "object" || runtimeCapability === null) {
    return renderFailure(new CurrentAliasReleaseError("usage_invalid"), request.stderr);
  }
  const accessToken = Reflect.get(runtimeCapability, "accessToken") as unknown;
  const convexVerifier = Reflect.get(runtimeCapability, "convexVerifier") as unknown;
  const fetcher = Reflect.get(runtimeCapability, "fetcher") as unknown;
  const stateDirectory = Reflect.get(runtimeCapability, "stateDirectory") as unknown;
  let parsedArguments: ParsedArguments | undefined;
  try {
    parsedArguments = parseArguments(request.arguments);
  } catch {
    // Render the same closed usage result as the executable surface.
  }
  if (
    (parsedArguments?.vercelAuthFd === undefined && parsedArguments?.vercelAuthFile === undefined)
    ||
    !vercelAccessTokenSchema.safeParse(accessToken).success
    || typeof convexVerifier !== "function"
    || typeof fetcher !== "function"
    || typeof stateDirectory !== "string"
    || !isAbsolute(stateDirectory)
  ) return renderFailure(new CurrentAliasReleaseError("usage_invalid"), request.stderr);
  return await executeCurrentProjectAliasRelease({
    arguments: request.arguments,
    ...(request.clock === undefined ? {} : { clock: request.clock }),
    convexVerifier: convexVerifier as ConvexTargetVerifier,
    fetcher: fetcher as NonNullable<VercelCurrentProjectAliasApiProviderOptions["fetcher"]>,
    inputDocument: request.inputDocument,
    ...(capability.providerActivityEvidence === undefined
      ? {}
      : { providerActivityEvidence: capability.providerActivityEvidence }),
    stateDirectory,
    stderr: request.stderr,
    stdout: request.stdout,
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    vercelAccessToken: accessToken as string,
  });
};

if (import.meta.main) {
  let exitCode = 75;
  try {
    assertCurrentAliasReleaseBunVersion();
    const arguments_ = parseArguments(process.argv.slice(2));
    const vercelAccessToken = arguments_.vercelAuthFile !== undefined
      ? readProtectedVercelAccessTokenFile(arguments_.vercelAuthFile)
      : arguments_.vercelAuthFd === undefined ? undefined
        : readProtectedVercelAccessToken(arguments_.vercelAuthFd);
    const providerActivityEvidence = arguments_.recoveryEvidenceFile !== undefined
      ? readProtectedProviderActivityEvidenceFile(arguments_.recoveryEvidenceFile)
      : arguments_.recoveryEvidenceFd === undefined ? undefined
        : readProtectedProviderActivityEvidence(arguments_.recoveryEvidenceFd);
    const fileInputDocument = arguments_.planFile === undefined
      ? undefined : readProtectedAliasPlanFile(arguments_.planFile);
    await recoverBoundedProcessJournal();
    const inputDocument = fileInputDocument ?? await readPlanInput(arguments_.planFd);
    exitCode = await executeCurrentProjectAliasRelease({
      arguments: process.argv.slice(2),
      inputDocument,
      stderr: process.stderr,
      stdout: process.stdout,
      ...(vercelAccessToken === undefined ? {} : { vercelAccessToken }),
      ...(providerActivityEvidence === undefined
        ? {}
        : { providerActivityEvidence }),
    });
  } catch (error: unknown) {
    exitCode = renderFailure(error, process.stderr);
  }
  process.exitCode = exitCode;
}
