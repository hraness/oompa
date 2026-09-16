import { z } from "zod";

import { publicProviderIdentifierSchema } from "../public-provider-identifier";
import { interactionKindSchema, interactionStateSchema } from "./interactions";
import { sessionEventCursorWireSchema } from "./session-events";
import {
  profileIdSchema,
  projectIdSchema,
  sessionIdSchema,
  titleSchema,
  unixMillisecondsSchema,
} from "./values";

export const SESSION_STATUS_PENDING_SUMMARY_LIMIT = 10;
export const ROOT_STATUS_ATTENTION_LIMIT = 50;
export const ROOT_STATUS_MAXIMUM_BYTES = 256 * 1024;

export const observationCoverageSchema = z.enum([
  "complete",
  "partial",
  "unavailable",
  "not_attempted",
]);

export type ObservationCoverage = z.infer<typeof observationCoverageSchema>;

export const observationFreshnessSchema = z.enum(["fresh", "stale", "unknown"]);

export type ObservationFreshness = z.infer<typeof observationFreshnessSchema>;

export const sessionExecutionSchema = z.enum([
  "starting",
  "active",
  "idle",
  "terminal",
  "recovery_required",
]);

export type SessionExecution = z.infer<typeof sessionExecutionSchema>;

export const sessionAttentionSchema = z.enum([
  "none",
  "human_action_required",
  "response_in_flight",
  "recovery_required",
  "unknown",
]);

export type SessionAttention = z.infer<typeof sessionAttentionSchema>;

export const recoveryIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("inspect_account"),
    accountId: profileIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("inspect_session"),
    sessionId: sessionIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("inspect_interaction"),
    interactionId: z.string().uuid(),
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    kind: z.literal("show_interaction"),
    interactionId: z.string().uuid(),
  }).strict(),
]);

export type RecoveryIntent = z.infer<typeof recoveryIntentSchema>;

export const sessionObservationSummarySchema = z.object({
  id: sessionIdSchema,
  accountId: profileIdSchema,
  projectId: projectIdSchema.nullable(),
  title: titleSchema,
  execution: sessionExecutionSchema,
  activeTurnId: publicProviderIdentifierSchema.nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
}).strict();

export type SessionObservationSummary = z.infer<typeof sessionObservationSummarySchema>;

export const sessionEventCutSchema = z.object({
  streamEpoch: z.string().uuid(),
  floorSequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  observedThroughSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict().superRefine((cut, context) => {
  if (cut.floorSequence > cut.observedThroughSequence + 1) {
    context.addIssue({
      code: "custom",
      message: "The event retention floor cannot exceed the observed cut by more than one.",
      path: ["floorSequence"],
    });
  }
});

export type SessionEventCut = z.infer<typeof sessionEventCutSchema>;

export const sessionPendingInteractionSummarySchema = z.object({
  id: z.string().uuid(),
  kind: interactionKindSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  blocking: z.boolean(),
  summary: z.string().max(512),
  requestedAt: unixMillisecondsSchema,
  deadlineAt: unixMillisecondsSchema,
}).strict();

export type SessionPendingInteractionSummary = z.infer<
  typeof sessionPendingInteractionSummarySchema
>;

export const sessionInteractionObservationSchema = z.object({
  pendingCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  responseInFlightCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  pending: z.array(sessionPendingInteractionSummarySchema)
    .max(SESSION_STATUS_PENDING_SUMMARY_LIMIT),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.pending.length > value.pendingCount) {
    context.addIssue({
      code: "custom",
      message: "A pending interaction summary cannot exceed its authoritative count.",
      path: ["pending"],
    });
  }
  if (value.truncated !== (value.pendingCount > value.pending.length)) {
    context.addIssue({
      code: "custom",
      message: "Pending interaction truncation must match the authoritative count.",
      path: ["truncated"],
    });
  }
});

export type SessionInteractionObservation = z.infer<
  typeof sessionInteractionObservationSchema
>;

export const sessionQueueObservationSchema = z.object({
  depth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  dispatchingCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ambiguousCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  failedCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export type SessionQueueObservation = z.infer<typeof sessionQueueObservationSchema>;

export const sessionLocalObservationSnapshotSchema = z.object({
  observedAt: unixMillisecondsSchema,
  session: sessionObservationSummarySchema,
  eventStream: sessionEventCutSchema,
  interactions: sessionInteractionObservationSchema,
  queue: sessionQueueObservationSchema,
}).strict();

export type SessionLocalObservationSnapshot = z.infer<
  typeof sessionLocalObservationSnapshotSchema
>;

const providerObservationBase = {
  // `codex_app_server` remains accepted for persisted/wire compatibility;
  // isolated providers identify the runtime boundary that produced the read.
  source: z.enum(["codex_app_server", "claude_runtime", "devin_acp"]),
  basis: z.enum(["local_state", "provider_read"]),
  profileGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observedAt: unixMillisecondsSchema,
};

export const providerObservationSchema = z.discriminatedUnion("state", [
  z.object({
    ...providerObservationBase,
    state: z.literal("live"),
    coverage: z.literal("complete"),
    freshness: z.literal("fresh"),
    connectionId: z.string().uuid(),
    mode: z.enum(["connected", "resubscribed"]),
  }).strict(),
  z.object({
    ...providerObservationBase,
    state: z.literal("unavailable"),
    coverage: z.literal("unavailable"),
    freshness: z.literal("fresh"),
    code: z.enum([
      "account_signed_out",
      "authority_retired",
      "provider_platform_unavailable",
      "resume_unavailable",
    ]),
  }).strict(),
  z.object({
    ...providerObservationBase,
    state: z.literal("recovery_required"),
    coverage: z.literal("partial"),
    freshness: z.literal("fresh"),
    code: z.enum(["session_quarantined", "thread_mismatch"]),
  }).strict(),
  z.object({
    ...providerObservationBase,
    state: z.literal("not_applicable"),
    coverage: z.literal("not_attempted"),
    freshness: z.literal("unknown"),
    reason: z.enum(["terminal", "unbound"]),
  }).strict(),
]).superRefine((value, context) => {
  const expectedBasis = value.state === "live"
    || (value.state === "unavailable" && value.code === "resume_unavailable")
    || (value.state === "recovery_required" && value.code === "thread_mismatch")
    ? "provider_read"
    : "local_state";
  if (value.basis !== expectedBasis) {
    context.addIssue({
      code: "custom",
      message: "Provider observation basis must report whether a provider read was attempted.",
      path: ["basis"],
    });
  }
});

export type ProviderObservation = z.infer<typeof providerObservationSchema>;

export const deriveSessionAttention = (input: Readonly<{
  execution: SessionExecution;
  localCoverage: ObservationCoverage;
  pendingInteractionCount: number;
  responseInFlightCount: number;
}>): SessionAttention => {
  if (input.localCoverage !== "complete") return "unknown";
  if (input.execution === "recovery_required") return "recovery_required";
  if (input.pendingInteractionCount > 0) return "human_action_required";
  if (input.responseInFlightCount > 0) return "response_in_flight";
  return "none";
};

export const sessionStatusSchema = z.object({
  version: z.literal(2),
  session: sessionObservationSummarySchema,
  advisory: z.object({
    execution: sessionExecutionSchema,
    attention: sessionAttentionSchema,
    queueDepth: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  localObservation: z.object({
    source: z.literal("sqlite"),
    coverage: z.literal("complete"),
    freshness: z.literal("fresh"),
    observedAt: unixMillisecondsSchema,
  }).strict(),
  providerObservation: providerObservationSchema,
  eventStream: sessionEventCutSchema.extend({
    cursor: sessionEventCursorWireSchema,
    retentionFloorCursor: sessionEventCursorWireSchema,
  }).strict(),
  interactions: sessionInteractionObservationSchema,
  queue: sessionQueueObservationSchema,
}).strict().superRefine((value, context) => {
  if (value.advisory.execution !== value.session.execution) {
    context.addIssue({
      code: "custom",
      message: "Advisory execution must reflect the authoritative session execution.",
      path: ["advisory", "execution"],
    });
  }
  if (value.advisory.queueDepth !== value.queue.depth) {
    context.addIssue({
      code: "custom",
      message: "Advisory queue depth must reflect the authoritative queue depth.",
      path: ["advisory", "queueDepth"],
    });
  }
  const expectedAttention = deriveSessionAttention({
    execution: value.session.execution,
    localCoverage: value.localObservation.coverage,
    pendingInteractionCount: value.interactions.pendingCount,
    responseInFlightCount: value.interactions.responseInFlightCount,
  });
  if (value.advisory.attention !== expectedAttention) {
    context.addIssue({
      code: "custom",
      message: "Advisory attention must reflect the authoritative observation axes.",
      path: ["advisory", "attention"],
    });
  }
});

export type SessionStatus = z.infer<typeof sessionStatusSchema>;

const accountCountSchema = z.object({
  signedOut: z.number().int().nonnegative(),
  loginPending: z.number().int().nonnegative(),
  signedIn: z.number().int().nonnegative(),
  recoveryRequired: z.number().int().nonnegative(),
}).strict();

const sessionCountSchema = z.object({
  starting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  idle: z.number().int().nonnegative(),
  terminal: z.number().int().nonnegative(),
  recoveryRequired: z.number().int().nonnegative(),
}).strict();

const interactionCountSchema = z.object({
  pending: z.number().int().nonnegative(),
  responsePrepared: z.number().int().nonnegative(),
  responseWritten: z.number().int().nonnegative(),
  resolved: z.number().int().nonnegative(),
  declined: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  expired: z.number().int().nonnegative(),
  resolutionUnknown: z.number().int().nonnegative(),
}).strict();

const queueCountSchema = z.object({
  pending: z.number().int().nonnegative(),
  dispatching: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  ambiguous: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
}).strict();

const usageCountSchema = z.object({
  observed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
}).strict();

export const rootStatusAttentionRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("account_login_pending"),
    accountId: profileIdSchema,
    accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observedAt: unixMillisecondsSchema,
    intent: recoveryIntentSchema,
  }).strict(),
  z.object({
    kind: z.literal("account_recovery_required"),
    accountId: profileIdSchema,
    accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    observedAt: unixMillisecondsSchema,
    intent: recoveryIntentSchema,
  }).strict(),
  z.object({
    kind: z.literal("session_recovery_required"),
    accountId: profileIdSchema,
    sessionId: sessionIdSchema,
    sessionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    observedAt: unixMillisecondsSchema,
    intent: recoveryIntentSchema,
  }).strict(),
  z.object({
    kind: z.enum(["interaction_pending", "interaction_response_in_flight"]),
    accountId: profileIdSchema,
    accountGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    sessionId: sessionIdSchema.nullable(),
    interactionId: z.string().uuid(),
    interactionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    interactionKind: interactionKindSchema,
    interactionState: interactionStateSchema,
    blocking: z.boolean(),
    deadlineAt: unixMillisecondsSchema,
    observedAt: unixMillisecondsSchema,
    intent: recoveryIntentSchema,
  }).strict(),
]).superRefine((record, context) => {
  const invalidIntent = (): void => context.addIssue({
    code: "custom",
    message: "The recovery intent must bind the exact actionable record.",
    path: ["intent"],
  });
  if (record.kind === "account_login_pending") {
    if (
      record.intent.kind !== "inspect_account"
      || record.intent.accountId !== record.accountId
    ) invalidIntent();
    return;
  }
  if (record.kind === "account_recovery_required") {
    if (
      record.intent.kind !== "inspect_account"
      || record.intent.accountId !== record.accountId
    ) invalidIntent();
    return;
  }
  if (record.kind === "session_recovery_required") {
    if (
      record.intent.kind !== "inspect_session"
      || record.intent.sessionId !== record.sessionId
    ) invalidIntent();
    return;
  }
  const requiresProtectedInspection = record.kind === "interaction_pending"
    && (
      record.interactionKind === "command_approval"
      || record.interactionKind === "permission_approval"
    );
  if (requiresProtectedInspection) {
    if (
      record.intent.kind !== "inspect_interaction"
      || record.intent.interactionId !== record.interactionId
      || record.intent.expectedRevision !== record.interactionRevision
    ) invalidIntent();
  } else if (
    record.intent.kind !== "show_interaction"
    || record.intent.interactionId !== record.interactionId
  ) invalidIntent();
  if (record.kind === "interaction_pending" && record.interactionState !== "pending") {
    context.addIssue({
      code: "custom",
      message: "Pending attention must name a pending interaction.",
      path: ["interactionState"],
    });
  }
  if (
    record.kind === "interaction_response_in_flight"
    && record.interactionState !== "response_prepared"
    && record.interactionState !== "response_written"
  ) {
    context.addIssue({
      code: "custom",
      message: "Response-in-flight attention must name a prepared or written response.",
      path: ["interactionState"],
    });
  }
});

export type RootStatusAttentionRecord = z.infer<typeof rootStatusAttentionRecordSchema>;

export const rootStatusSchema = z.object({
  version: z.literal(1),
  scope: z.literal("local_only"),
  localObservation: z.object({
    source: z.literal("sqlite"),
    coverage: z.literal("complete"),
    freshness: z.literal("fresh"),
    observedAt: unixMillisecondsSchema,
    tables: z.tuple([
      z.literal("profiles"),
      z.literal("sessions"),
      z.literal("provider_interactions"),
      z.literal("queue_entries"),
      z.literal("usage_snapshots"),
      z.literal("usage_poll_failures"),
    ]),
  }).strict(),
  providerObservation: z.object({
    source: z.literal("codex_app_server"),
    coverage: z.literal("not_attempted"),
    freshness: z.literal("unknown"),
    observedAt: z.null(),
  }).strict(),
  cloudObservation: z.object({
    source: z.literal("convex"),
    coverage: z.literal("not_attempted"),
    freshness: z.literal("unknown"),
    observedAt: z.null(),
    devices: z.object({
      registered: z.null(),
      online: z.null(),
    }).strict(),
  }).strict(),
  counts: z.object({
    accounts: accountCountSchema,
    sessions: sessionCountSchema,
    interactions: interactionCountSchema,
    queue: queueCountSchema,
    usage: usageCountSchema,
  }).strict(),
  attention: z.object({
    records: z.array(rootStatusAttentionRecordSchema).max(ROOT_STATUS_ATTENTION_LIMIT),
    total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    truncated: z.boolean(),
  }).strict().superRefine((value, context) => {
    if (value.records.length > value.total) {
      context.addIssue({
        code: "custom",
        message: "Root attention records cannot exceed their authoritative total.",
        path: ["records"],
      });
    }
    if (value.truncated !== (value.total > value.records.length)) {
      context.addIssue({
        code: "custom",
        message: "Root attention truncation must match the authoritative total.",
        path: ["truncated"],
      });
    }
  }),
}).strict();

export type RootStatus = z.infer<typeof rootStatusSchema>;

export const assertRootStatusBound = (status: RootStatus): RootStatus => {
  const bytes = new TextEncoder().encode(`${JSON.stringify({
    ok: true,
    version: 1,
    command: "status",
    data: status,
  })}\n`).byteLength;
  if (bytes > ROOT_STATUS_MAXIMUM_BYTES) throw new Error("ROOT_STATUS_EXCEEDS_BOUND");
  return status;
};
