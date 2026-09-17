import { z } from "zod";

import { attachmentReferenceListSchema } from "./attachment-schemas";

import { publicProviderIdentifierSchema } from "../public-provider-identifier";
import { presetSchema, providerSchema } from "./presets";
import { profileIdSchema, sessionIdSchema, unixMillisecondsSchema } from "./values";

export const SESSION_EVENT_PAGE_LIMIT = 200;
export const SESSION_EVENT_PAGE_BYTES = 512 * 1024;
export const SESSION_EVENT_MAX_BYTES = 64 * 1024;
export const SESSION_EVENT_CURSOR_MAX_BYTES = 2_048;
// A legacy v1 row can contain two one-byte provider identifiers. Projecting
// both to the 74-byte opaque form adds at most 146 bytes to its public envelope.
export const SESSION_EVENT_PUBLIC_MAX_BYTES = SESSION_EVENT_MAX_BYTES + 146;
export const SESSION_EVENT_WAIT_MAX_MS = 30_000;
export const SESSION_EVENT_RETAIN_COUNT = 50_000;
export const SESSION_EVENT_RETAIN_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
export const SESSION_EVENT_RETAIN_BYTES = 64 * 1024 * 1024;

const boundedText = (maximum: number) => z.string().max(maximum);
const providerToolLabelMaximumUtf8Bytes = 256;
const utf8Encoder = new TextEncoder();
const providerToolLabelSchema = z.string()
  .min(1)
  .max(providerToolLabelMaximumUtf8Bytes)
  .refine(
    (value) => utf8Encoder.encode(value).byteLength <= providerToolLabelMaximumUtf8Bytes,
    { message: `Must be at most ${providerToolLabelMaximumUtf8Bytes} UTF-8 bytes` },
  );
const cursorSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const eventSequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const streamEpochSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const canonicalBase64Url = (value: string): boolean => {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const remainder = value.length % 4;
  if (remainder === 1) return false;
  if (remainder === 2) return /[AQgw]$/u.test(value);
  if (remainder === 3) return /[AEIMQUYcgkosw048]$/u.test(value);
  return true;
};

export const sessionEventCursorWireSchema = z.string()
  .max(SESSION_EVENT_CURSOR_MAX_BYTES)
  .refine((value) => {
    if (value.length > SESSION_EVENT_CURSOR_MAX_BYTES) return false;
    const match = /^hra1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/u.exec(value);
    return match !== null
      && canonicalBase64Url(match[1] ?? "")
      && canonicalBase64Url(match[2] ?? "");
  }, "Must be one canonical Oompa cursor envelope");

export const sessionEventCursorPayloadSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: cursorSequenceSchema,
}).strict();

export type SessionEventCursorPayload = z.infer<typeof sessionEventCursorPayloadSchema>;

export const sessionEventGapReasonSchema = z.enum([
  "provider_disconnect",
  "provider_restart",
  "stream_restored",
  "retention_count",
  "retention_age",
  "retention_bytes",
  "protocol_incompatible",
]);

export type SessionEventGapReason = z.infer<typeof sessionEventGapReasonSchema>;

const safePathSummarySchema = z.object({
  path: boundedText(1_024),
  kind: z.enum(["created", "modified", "deleted", "renamed", "unknown"]),
}).strict();

const planStepSchema = z.object({
  text: boundedText(1_024),
  status: z.enum(["pending", "in_progress", "completed"]),
}).strict();

/**
 * The most a single `user_message` event retains. A local message may be far
 * larger than one event's byte bound, so the retained prefix is capped here
 * and the remainder is stated as an exact omission count rather than dropped
 * silently.
 */
export const SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS = 16_384;

/** Who authored the message Oompa sent to the provider. */
export const sessionMessageActorSchema = z.enum([
  "human",
  "automation",
  "autorespond",
  "peer_session",
  "provider_switch",
]);

export type SessionMessageActor = z.infer<typeof sessionMessageActorSchema>;

/** Bounded one-line label for a tool call. Never a raw argument or output. */
const toolSummarySchema = boundedText(256);

export const sessionEventBodySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("connection"),
    state: z.enum(["connected", "resubscribed", "disconnected"]),
    reason: boundedText(1_024).optional(),
  }).strict(),
  z.object({
    type: z.literal("gap"),
    reason: sessionEventGapReasonSchema,
    fromSequence: eventSequenceSchema,
    throughSequence: eventSequenceSchema,
  }).strict(),
  z.object({
    type: z.literal("session_status"),
    status: z.enum(["active", "idle", "terminal", "system_error", "not_loaded"]),
    activeTurnId: publicProviderIdentifierSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("turn_started"),
    turnId: publicProviderIdentifierSchema,
  }).strict(),
  z.object({
    type: z.literal("turn_completed"),
    turnId: publicProviderIdentifierSchema,
    status: z.enum(["completed", "interrupted", "failed"]),
    errorCode: boundedText(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("item_started"),
    turnId: publicProviderIdentifierSchema,
    itemId: publicProviderIdentifierSchema,
    itemKind: boundedText(128),
    server: providerToolLabelSchema.optional(),
    tool: providerToolLabelSchema.optional(),
    liveAcceptanceCommandDigest: digestSchema.optional(),
    // Present only on a tool-shaped item. It is the stable identity a later
    // result binds back to this call, and it is the same opaque value on the
    // started and completed events of one call.
    callId: publicProviderIdentifierSchema.optional(),
    // A classified, bounded, redacted one-line label. Never a raw argument.
    summary: toolSummarySchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("item_completed"),
    turnId: publicProviderIdentifierSchema,
    itemId: publicProviderIdentifierSchema,
    itemKind: boundedText(128),
    server: providerToolLabelSchema.optional(),
    tool: providerToolLabelSchema.optional(),
    liveAcceptanceCommandDigest: digestSchema.optional(),
    status: boundedText(128).optional(),
    callId: publicProviderIdentifierSchema.optional(),
    summary: toolSummarySchema.optional(),
  }).strict(),
  /**
   * The text Oompa sent to the provider, its source class, and the optional
   * byte-free attachment manifest. Attachment contents remain in local blob
   * custody and are deliberately not embedded in an event.
   */
  z.object({
    type: z.literal("user_message"),
    // Null until the provider names the turn the message opened.
    turnId: publicProviderIdentifierSchema.nullable(),
    // Stable Oompa operation identity used to make transcript finalization
    // idempotent after a lost response or a post-provider storage failure.
    sourceId: boundedText(200).optional(),
    actor: sessionMessageActorSchema,
    text: boundedText(SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS),
    omittedCharacters: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    attachments: attachmentReferenceListSchema.optional(),
  }).strict(),
  /**
   * One session moved from one provider to another. The seed digest binds the
   * exact handoff summary the target provider was given as its first user
   * message; the transcript digest binds the neutral conversation that summary
   * was rendered from.
   */
  z.object({
    type: z.literal("provider_switched"),
    fromProvider: providerSchema,
    toProvider: providerSchema,
    fromPreset: presetSchema,
    toPreset: presetSchema,
    accountChanged: z.boolean(),
    transcriptDigest: digestSchema,
    seedDigest: digestSchema,
    seedOmittedRecords: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Earlier ledger history was unavailable when this seed was rendered. */
    seedRetentionGapReason: sessionEventGapReasonSchema.optional(),
  }).strict(),
  z.object({
    type: z.literal("assistant_delta"),
    turnId: publicProviderIdentifierSchema,
    itemId: publicProviderIdentifierSchema,
    text: boundedText(32_768),
  }).strict(),
  z.object({
    type: z.literal("reasoning_summary_delta"),
    turnId: publicProviderIdentifierSchema,
    itemId: publicProviderIdentifierSchema,
    summaryPart: z.number().int().nonnegative().max(10_000).optional(),
    text: boundedText(32_768),
  }).strict(),
  z.object({
    type: z.literal("tool_progress"),
    turnId: publicProviderIdentifierSchema,
    itemId: publicProviderIdentifierSchema,
    toolKind: boundedText(128),
    status: boundedText(128).optional(),
    outputBytesObserved: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    server: boundedText(256).optional(),
    tool: boundedText(256).optional(),
  }).strict(),
  z.object({
    type: z.literal("file_change"),
    turnId: publicProviderIdentifierSchema,
    itemId: publicProviderIdentifierSchema,
    status: boundedText(128),
    paths: z.array(safePathSummarySchema).max(100),
    omittedPaths: z.number().int().nonnegative().max(1_000_000),
  }).strict(),
  z.object({
    type: z.literal("plan_updated"),
    turnId: publicProviderIdentifierSchema,
    steps: z.array(planStepSchema).max(100),
    explanation: boundedText(4_096).optional(),
  }).strict(),
  z.object({
    type: z.literal("diff_updated"),
    turnId: publicProviderIdentifierSchema,
    changedFiles: z.number().int().nonnegative().max(1_000_000),
    patchBytesObserved: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    type: z.literal("token_usage"),
    turnId: publicProviderIdentifierSchema.nullable(),
    inputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    cachedInputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    outputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    reasoningOutputTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    totalTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    modelContextWindow: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    providerCost: z.object({
      amount: z.number().finite().nonnegative().max(1_000_000_000),
      currency: z.string().regex(/^[A-Z]{3}$/u),
    }).strict().optional(),
  }).strict(),
  /**
   * One provider-native context compaction observed on this session. Outcome
   * and trigger are closed enums, strategy is a bounded Oompa-owned label,
   * and token counts are exact nonnegative integers. The turn identifier is
   * null until the provider names the turn a request or failure belongs to.
   * No transcript text, reasoning, or provider payload is ever retained.
   */
  z.object({
    type: z.literal("compaction"),
    outcome: z.enum(["requested", "completed", "failed"]),
    trigger: z.enum(["manual", "policy", "provider"]),
    strategy: boundedText(64).optional(),
    preTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    postTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    turnId: publicProviderIdentifierSchema.nullable(),
  }).strict(),
  z.object({
    type: z.literal("interaction_requested"),
    interactionId: z.string().uuid(),
    interactionKind: z.enum([
      "command_approval",
      "file_change_approval",
      "permission_approval",
      "user_input",
      "mcp_elicitation",
    ]),
    revision: z.number().int().positive(),
    blocking: z.boolean(),
    summary: boundedText(2_048),
  }).strict(),
  z.object({
    type: z.literal("interaction_state"),
    interactionId: z.string().uuid(),
    state: z.enum([
      "pending",
      "response_prepared",
      "response_written",
      "resolved",
      "declined",
      "canceled",
      "expired",
      "resolution_unknown",
    ]),
    revision: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("subagent_activity"),
    turnId: publicProviderIdentifierSchema,
    agentId: publicProviderIdentifierSchema,
    kind: z.enum(["started", "interacted", "interrupted", "completed"]),
    depth: z.number().int().nonnegative().max(32).optional(),
    nickname: boundedText(120).optional(),
    role: boundedText(120).optional(),
  }).strict(),
  z.object({
    type: z.literal("session_state"),
    state: z.enum([
      "working",
      "needs_approval",
      "needs_answer",
      "needs_action",
      "done",
      "done_followups",
      "done_caveats",
      "aborted",
    ]),
    attention: z.boolean(),
    reason: boundedText(256),
    verbatimRequired: z.boolean(),
    lastActivityAt: unixMillisecondsSchema,
    revision: z.number().int().positive(),
  }).strict(),
  z.object({
    type: z.literal("warning"),
    code: boundedText(256),
    message: boundedText(2_048),
  }).strict(),
  z.object({
    type: z.literal("error"),
    code: boundedText(256),
    message: boundedText(2_048),
    terminal: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("protocol_incompatible"),
    method: boundedText(512),
    payloadDigest: digestSchema,
  }).strict(),
]);

export type SessionEventBody = z.infer<typeof sessionEventBodySchema>;

export const sessionEventSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  streamEpoch: streamEpochSchema,
  sequence: eventSequenceSchema,
  recordedAt: unixMillisecondsSchema,
  accountId: profileIdSchema,
  providerGeneration: z.number().int().nonnegative(),
  providerConnectionId: z.string().uuid().nullable(),
  body: sessionEventBodySchema,
}).strict().superRefine((event, context) => {
  if (
    utf8Encoder.encode(JSON.stringify(event)).byteLength
      > SESSION_EVENT_PUBLIC_MAX_BYTES
  ) {
    context.addIssue({
      code: "custom",
      message: "A session event exceeds its serialized UTF-8 byte bound.",
    });
  }
});

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export type SessionEventContinuity = Readonly<{
  accountId: string | null;
  expectedSequence: number | null;
  lastEvent: Readonly<{
    sequence: number;
    streamEpoch: string;
  }> | null;
  requiredEpochChangeFrom: string | null;
}>;

export const initialSessionEventContinuity = (): SessionEventContinuity => ({
  accountId: null,
  expectedSequence: null,
  lastEvent: null,
  requiredEpochChangeFrom: null,
});

export const sessionEventPageSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  requestedCursor: sessionEventCursorWireSchema.nullable(),
  retentionFloorCursor: sessionEventCursorWireSchema,
  observedThroughCursor: sessionEventCursorWireSchema,
  nextCursor: sessionEventCursorWireSchema,
  gap: z.object({
    reason: sessionEventGapReasonSchema,
    requestedSequence: cursorSequenceSchema.nullable(),
    retainedFromSequence: eventSequenceSchema,
  }).strict().nullable(),
  events: z.array(sessionEventSchema).max(SESSION_EVENT_PAGE_LIMIT),
}).strict().superRefine((page, context) => {
  const eventBytes = page.events.reduce(
    (total, event) => total + utf8Encoder.encode(JSON.stringify(event)).byteLength,
    0,
  );
  if (eventBytes > SESSION_EVENT_PAGE_BYTES) {
    context.addIssue({
      code: "custom",
      message: "A session event page exceeds its serialized event byte bound.",
      path: ["events"],
    });
  }
  let accountId: string | null = null;
  let streamEpoch: string | null = null;
  let priorSequence: number | null = null;
  for (const [index, event] of page.events.entries()) {
    if (event.sessionId !== page.sessionId) {
      context.addIssue({
        code: "custom",
        message: "Every event must bind the page session.",
        path: ["events", index, "sessionId"],
      });
    }
    if (streamEpoch === null) streamEpoch = event.streamEpoch;
    else if (event.streamEpoch !== streamEpoch) {
      context.addIssue({
        code: "custom",
        message: "One event page cannot mix stream epochs.",
        path: ["events", index, "streamEpoch"],
      });
    }
    if (accountId === null) accountId = event.accountId;
    else if (event.accountId !== accountId) {
      context.addIssue({
        code: "custom",
        message: "One event page cannot mix account identities.",
        path: ["events", index, "accountId"],
      });
    }
    if (priorSequence !== null && event.sequence !== priorSequence + 1) {
      context.addIssue({
        code: "custom",
        message: "Event sequences must be exactly contiguous within a page.",
        path: ["events", index, "sequence"],
      });
    }
    priorSequence = event.sequence;
  }
  if (
    page.gap !== null
    && page.events.length > 0
    && page.events[0]?.sequence !== page.gap.retainedFromSequence
  ) {
    context.addIssue({
      code: "custom",
      message: "The first retained event must start at the gap retention floor.",
      path: ["events", 0, "sequence"],
    });
  }
  if (
    (page.events.length > 0 || page.gap !== null)
    && page.nextCursor === page.requestedCursor
  ) {
    context.addIssue({
      code: "custom",
      message: "A nonempty or gap page must advance its checkpoint.",
      path: ["nextCursor"],
    });
  }
  if (
    page.events.length === 0
    && page.gap === null
    && page.requestedCursor !== null
    && page.nextCursor !== page.requestedCursor
  ) {
    context.addIssue({
      code: "custom",
      message: "An empty page without a gap cannot advance its checkpoint.",
      path: ["nextCursor"],
    });
  }
});

export type SessionEventPage = z.infer<typeof sessionEventPageSchema>;

export const advanceSessionEventContinuity = (
  prior: SessionEventContinuity,
  page: SessionEventPage,
): SessionEventContinuity => {
  let accountId = prior.accountId;
  let expectedSequence = prior.expectedSequence;
  let lastEvent = prior.lastEvent;
  let requiredEpochChangeFrom = prior.requiredEpochChangeFrom;

  if (page.gap?.reason === "stream_restored") {
    requiredEpochChangeFrom ??= lastEvent?.streamEpoch ?? null;
    expectedSequence = page.gap.retainedFromSequence;
  } else if (page.gap !== null) {
    if (
      expectedSequence !== null
      && page.gap.retainedFromSequence < expectedSequence
    ) {
      throw new Error("SESSION_EVENT_CONTINUITY_GAP_MOVED_BACKWARD");
    }
    expectedSequence = page.gap.retainedFromSequence;
  }

  for (const event of page.events) {
    // A session may legitimately change account: `oompa session switch` moves
    // one conversation to another provider, and the target provider may be a
    // different Oompa account. Continuity therefore follows the account rather
    // than pinning it; one page still never mixes two accounts.
    accountId = event.accountId;

    if (requiredEpochChangeFrom !== null) {
      if (event.streamEpoch === requiredEpochChangeFrom) {
        throw new Error("SESSION_EVENT_CONTINUITY_RESTORED_EPOCH_DID_NOT_CHANGE");
      }
      requiredEpochChangeFrom = null;
    } else if (lastEvent !== null && event.streamEpoch !== lastEvent.streamEpoch) {
      throw new Error("SESSION_EVENT_CONTINUITY_STREAM_CHANGED_WITHOUT_RESTORE");
    }

    if (expectedSequence !== null && event.sequence !== expectedSequence) {
      throw new Error("SESSION_EVENT_CONTINUITY_SEQUENCE_MISMATCH");
    }
    expectedSequence = event.sequence + 1;
    lastEvent = { sequence: event.sequence, streamEpoch: event.streamEpoch };
  }

  return {
    accountId,
    expectedSequence,
    lastEvent,
    requiredEpochChangeFrom,
  };
};
