import { createHash } from "node:crypto";

import { z } from "zod";

import { attachmentReferenceListSchema } from "./attachment-schemas";
import type { AttachmentReference } from "./attachments";
import { presetContractSchema, presetSchema, providerSchema } from "./presets";
import {
  sessionMessageActorSchema,
  sessionEventGapReasonSchema,
  type SessionEvent,
  type SessionEventGapReason,
  type SessionMessageActor,
  type SessionEventBody,
} from "./session-events";
import {
  noteSchema,
  profileIdSchema,
  projectIdSchema,
  sessionIdSchema,
  titleSchema,
  unixMillisecondsSchema,
  utf8Bytes,
} from "./values";

/**
 * The provider-neutral conversation Oompa owns.
 *
 * Every record here is rebuilt from Oompa's own durable session events, never
 * from a provider transcript read. That is the whole point: a session can be
 * moved from one provider to another, and a session whose provider is gone
 * still has a conversation. The records carry only what the event stream
 * already proved safe to retain — bounded, redacted, path-free text, closed
 * status vocabularies, and opaque provider identifiers. Raw tool arguments and
 * raw tool output are not in the event stream and are therefore not here.
 */

/** The most records one transcript page returns. */
export const TRANSCRIPT_PAGE_LIMIT = 500;
/** The most characters one transcript record's text retains. */
export const TRANSCRIPT_TEXT_MAX_CHARACTERS = 16_384;
/** The most characters one rendered handoff seed may occupy. */
export const TRANSCRIPT_SEED_MAX_CHARACTERS = 24_576;

/** Item kinds that are conversation, not a tool call. */
const NON_TOOL_ITEM_KINDS: ReadonlySet<string> = new Set([
  "agentMessage",
  "assistantMessage",
  "reasoning",
  "subAgentActivity",
  "userMessage",
]);

const transcriptTextSchema = z.string().max(TRANSCRIPT_TEXT_MAX_CHARACTERS);
const omittedCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sequenceSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const cursorSequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const sessionProviderSwitchReceiptSchema = z.object({
  from: z.object({
    account: profileIdSchema,
    preset: presetSchema,
    provider: providerSchema,
  }).strict(),
  providerThreadId: z.string().min(1).max(200),
  request: z.object({
    accountId: profileIdSchema.nullable(),
    preset: presetSchema.nullable(),
    presetContract: presetContractSchema.optional(),
    provider: providerSchema,
  }).strict(),
  seed: z.object({
    digest: digestSchema,
    includedRecords: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    omittedRecords: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Earlier ledger history is unavailable and its size cannot be counted. */
    retentionGapReason: sessionEventGapReasonSchema.optional(),
    status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  }).strict(),
  sessionId: sessionIdSchema,
  to: z.object({
    account: profileIdSchema,
    preset: presetSchema,
    provider: providerSchema,
  }).strict(),
  transcriptDigest: digestSchema,
  turnId: z.string().min(1).max(200),
}).strict();

/** The exact public session value returned by an idempotent switch replay. */
export const sessionProviderSwitchSnapshotSchema = z.object({
  activeTurnId: z.string().min(1).max(200).optional(),
  archivedAt: unixMillisecondsSchema.optional(),
  createdAt: unixMillisecondsSchema,
  fastEnabled: z.boolean(),
  id: sessionIdSchema,
  note: noteSchema,
  preset: presetSchema,
  profileId: profileIdSchema,
  projectId: projectIdSchema.optional(),
  provider: providerSchema,
  providerThreadId: z.string().min(1).max(200),
  providerUpdatedAt: unixMillisecondsSchema.optional(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  state: z.enum(["starting", "active", "idle", "terminal", "recovery_required"]),
  title: titleSchema,
  updatedAt: unixMillisecondsSchema,
}).strict();

/** A committed switch receipt, including the immutable response snapshot. */
export const sessionProviderSwitchDurableReceiptSchema = sessionProviderSwitchReceiptSchema.extend({
  session: sessionProviderSwitchSnapshotSchema,
}).strict();
const opaqueIdSchema = z.string().min(1).max(200);
const labelSchema = z.string().min(1).max(256);

const baseRecord = {
  /** The event sequence the record opened at. */
  sequence: sequenceSchema,
  /** The event sequence the record closed at; equal to `sequence` when whole. */
  throughSequence: sequenceSchema,
  recordedAt: unixMillisecondsSchema,
};

export const transcriptRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...baseRecord,
    kind: z.literal("user"),
    actor: sessionMessageActorSchema,
    turnId: opaqueIdSchema.nullable(),
    text: transcriptTextSchema,
    omittedCharacters: omittedCountSchema,
    attachments: attachmentReferenceListSchema.optional(),
  }).strict(),
  z.object({
    ...baseRecord,
    kind: z.literal("assistant"),
    turnId: opaqueIdSchema,
    itemId: opaqueIdSchema,
    text: transcriptTextSchema,
    omittedCharacters: omittedCountSchema,
  }).strict(),
  z.object({
    ...baseRecord,
    kind: z.literal("reasoning"),
    turnId: opaqueIdSchema,
    itemId: opaqueIdSchema,
    text: transcriptTextSchema,
    omittedCharacters: omittedCountSchema,
  }).strict(),
  z.object({
    ...baseRecord,
    kind: z.literal("tool_call"),
    turnId: opaqueIdSchema,
    callId: opaqueIdSchema,
    itemKind: labelSchema,
    server: labelSchema.optional(),
    tool: labelSchema.optional(),
    summary: labelSchema.optional(),
  }).strict(),
  z.object({
    ...baseRecord,
    kind: z.literal("tool_result"),
    turnId: opaqueIdSchema,
    callId: opaqueIdSchema,
    itemKind: labelSchema,
    status: labelSchema.optional(),
    summary: labelSchema.optional(),
    /** Null when the provider named no status Oompa can classify. */
    ok: z.boolean().nullable(),
  }).strict(),
  z.object({
    ...baseRecord,
    kind: z.literal("provider_switch"),
    fromProvider: providerSchema,
    toProvider: providerSchema,
    fromPreset: presetSchema,
    toPreset: presetSchema,
    accountChanged: z.boolean(),
    seedDigest: digestSchema,
  }).strict(),
]);

export type TranscriptRecord = z.infer<typeof transcriptRecordSchema>;

export const sessionTranscriptSchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  /** Current provider from local session authority; absent in pure builders. */
  provider: providerSchema.optional(),
  /** Prior ledger history was pruned for this reason; its record count is unknowable. */
  retentionGapReason: sessionEventGapReasonSchema.nullable().optional(),
  records: z.array(transcriptRecordSchema).max(TRANSCRIPT_PAGE_LIMIT),
  /** The last event sequence this page consumed; null for an empty page. */
  throughSequence: sequenceSchema.nullable(),
  /** The last consumed sequence to pass as `after` for the next page. */
  nextSequence: cursorSequenceSchema.nullable(),
  /** Records dropped because a page or serialized-response bound was reached. */
  omittedRecords: omittedCountSchema,
  /** Characters dropped from record text because a record hit its bound. */
  omittedCharacters: omittedCountSchema,
  /** SHA-256 over the canonical serialization of `records`. */
  digest: digestSchema,
}).strict();

export type SessionTranscript = z.infer<typeof sessionTranscriptSchema>;

const canonicalJson = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("TRANSCRIPT_DIGEST_NON_FINITE_NUMBER");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value !== "object") throw new Error("TRANSCRIPT_DIGEST_UNSUPPORTED_SCALAR");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
};

/** The stable digest of an ordered record list. */
export const digestTranscriptRecords = (
  records: readonly TranscriptRecord[],
): string => createHash("sha256")
  .update("hra:session-transcript:v1\0", "utf8")
  .update(canonicalJson(records), "utf8")
  .digest("hex");

const classifyToolStatus = (status: string | undefined): boolean | null => {
  if (status === undefined) return null;
  const normalized = status.trim().toLowerCase();
  if (["completed", "complete", "success", "succeeded", "ok"].includes(normalized)) return true;
  if (
    ["failed", "failure", "error", "aborted", "cancelled", "canceled", "denied", "rejected", "timeout", "timed_out"]
      .includes(normalized)
  ) return false;
  return null;
};

const isToolItem = (itemKind: string): boolean => !NON_TOOL_ITEM_KINDS.has(itemKind);

type OpenText = {
  itemId: string;
  kind: "assistant" | "reasoning";
  omittedCharacters: number;
  recordedAt: number;
  sequence: number;
  text: string;
  throughSequence: number;
  turnId: string;
};

const closeText = (open: OpenText): TranscriptRecord => ({
  kind: open.kind,
  sequence: open.sequence,
  throughSequence: open.throughSequence,
  recordedAt: open.recordedAt,
  turnId: open.turnId,
  itemId: open.itemId,
  text: open.text,
  omittedCharacters: open.omittedCharacters,
});

/**
 * Build the ordered neutral conversation from one contiguous run of stored
 * session events.
 *
 * The caller supplies the events in sequence order; this function coalesces
 * assistant and reasoning deltas per item, pairs tool calls with their
 * results by call id, and stops at exactly `limit` records, reporting how many
 * further records the same event run would have produced.
 */
export const buildSessionTranscript = (input: Readonly<{
  sessionId: string;
  events: readonly SessionEvent[];
  limit?: number;
  textLimit?: number;
  retain?: "head" | "tail";
}>): SessionTranscript => {
  const sessionId = sessionIdSchema.parse(input.sessionId);
  const limit = z.number().int().min(1).max(TRANSCRIPT_PAGE_LIMIT)
    .parse(input.limit ?? TRANSCRIPT_PAGE_LIMIT);
  const textLimit = z.number().int().min(64).max(TRANSCRIPT_TEXT_MAX_CHARACTERS)
    .parse(input.textLimit ?? TRANSCRIPT_TEXT_MAX_CHARACTERS);
  const retain = input.retain ?? "head";

  const records: TranscriptRecord[] = [];
  let open: OpenText | null = null;
  let omittedRecords = 0;
  let omittedCharacters = 0;
  let throughSequence: number | null = null;
  const cursor: { nextSequence: number | null } = { nextSequence: null };

  const push = (record: TranscriptRecord): void => {
    if (retain === "tail") {
      records.push(record);
      if (records.length > limit) {
        records.shift();
        omittedRecords += 1;
      }
      return;
    }
    if (records.length >= limit) {
      omittedRecords += 1;
      // `after` is exclusive. Point to the event immediately before the
      // first omitted record so a caller cannot skip that record on resume.
      cursor.nextSequence ??= record.sequence - 1;
      return;
    }
    records.push(record);
  };

  const flush = (): void => {
    if (open === null) return;
    const closed = open;
    open = null;
    push(closeText(closed));
  };

  for (const event of input.events) {
    const body: SessionEventBody = event.body;
    switch (body.type) {
      case "assistant_delta":
      case "reasoning_summary_delta": {
        const kind = body.type === "assistant_delta" ? "assistant" : "reasoning";
        if (
          open !== null
          && open.kind === kind
          && open.itemId === body.itemId
          && open.turnId === body.turnId
        ) {
          const room = Math.max(0, textLimit - open.text.length);
          const admitted = body.text.slice(0, room);
          open.text += admitted;
          open.omittedCharacters += body.text.length - admitted.length;
          omittedCharacters += body.text.length - admitted.length;
          open.throughSequence = event.sequence;
          break;
        }
        flush();
        const admitted = body.text.slice(0, textLimit);
        omittedCharacters += body.text.length - admitted.length;
        open = {
          itemId: body.itemId,
          kind,
          omittedCharacters: body.text.length - admitted.length,
          recordedAt: event.recordedAt,
          sequence: event.sequence,
          text: admitted,
          throughSequence: event.sequence,
          turnId: body.turnId,
        };
        break;
      }
      case "user_message": {
        flush();
        const admitted = body.text.slice(0, textLimit);
        omittedCharacters += body.omittedCharacters + (body.text.length - admitted.length);
        push({
          kind: "user",
          sequence: event.sequence,
          throughSequence: event.sequence,
          recordedAt: event.recordedAt,
          actor: body.actor,
          turnId: body.turnId,
          text: admitted,
          omittedCharacters: body.omittedCharacters + (body.text.length - admitted.length),
          ...(body.attachments === undefined ? {} : { attachments: body.attachments }),
        });
        break;
      }
      case "item_started": {
        if (!isToolItem(body.itemKind)) break;
        flush();
        push({
          kind: "tool_call",
          sequence: event.sequence,
          throughSequence: event.sequence,
          recordedAt: event.recordedAt,
          turnId: body.turnId,
          callId: body.callId ?? body.itemId,
          itemKind: body.itemKind,
          ...(body.server === undefined ? {} : { server: body.server }),
          ...(body.tool === undefined ? {} : { tool: body.tool }),
          ...(body.summary === undefined ? {} : { summary: body.summary }),
        });
        break;
      }
      case "item_completed": {
        if (!isToolItem(body.itemKind)) break;
        flush();
        push({
          kind: "tool_result",
          sequence: event.sequence,
          throughSequence: event.sequence,
          recordedAt: event.recordedAt,
          turnId: body.turnId,
          callId: body.callId ?? body.itemId,
          itemKind: body.itemKind,
          ...(body.status === undefined ? {} : { status: body.status }),
          ...(body.summary === undefined ? {} : { summary: body.summary }),
          ok: classifyToolStatus(body.status),
        });
        break;
      }
      case "provider_switched": {
        flush();
        push({
          kind: "provider_switch",
          sequence: event.sequence,
          throughSequence: event.sequence,
          recordedAt: event.recordedAt,
          fromProvider: body.fromProvider,
          toProvider: body.toProvider,
          fromPreset: body.fromPreset,
          toPreset: body.toPreset,
          accountChanged: body.accountChanged,
          seedDigest: body.seedDigest,
        });
        break;
      }
      // A turn boundary closes any open text stream but is not itself a
      // conversation record: the records already carry their turn id.
      case "turn_started":
      case "turn_completed":
      case "gap":
      case "connection":
        flush();
        break;
      // Operational events. They are part of the session's timeline but not
      // part of the conversation a second provider would need to continue it.
      case "session_status":
      case "session_state":
      case "tool_progress":
      case "file_change":
      case "plan_updated":
      case "diff_updated":
      case "token_usage":
      case "compaction":
      case "interaction_requested":
      case "interaction_state":
      case "subagent_activity":
      case "warning":
      case "error":
      case "protocol_incompatible":
        break;
    }
    throughSequence = event.sequence;
  }
  flush();
  const nextSequence = cursor.nextSequence;

  return sessionTranscriptSchema.parse({
    version: 1,
    sessionId,
    records,
    throughSequence: nextSequence === null
      ? throughSequence
      : nextSequence === 0 ? null : nextSequence,
    nextSequence,
    omittedRecords,
    omittedCharacters,
    digest: digestTranscriptRecords(records),
  });
};

/**
 * Fit a complete transcript result beneath an exact serialized UTF-8 bound.
 *
 * Page reads keep the oldest records and return an exclusive `after` cursor
 * immediately before the first byte-omitted record. Tail/export reads keep
 * the newest records. The digest is always recomputed over exactly what the
 * caller receives.
 */
export const boundSessionTranscriptSerializedBytes = (input: Readonly<{
  transcript: SessionTranscript;
  maximumBytes: number;
  retain: "head" | "tail";
}>): SessionTranscript => {
  const transcript = sessionTranscriptSchema.parse(input.transcript);
  const maximumBytes = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
    .parse(input.maximumBytes);
  if (utf8Bytes(JSON.stringify(transcript)) <= maximumBytes) return transcript;
  if (transcript.records.length === 0) {
    throw new Error("TRANSCRIPT_SERIALIZED_BYTE_LIMIT_TOO_SMALL");
  }

  const candidate = (removed: number): SessionTranscript => {
    const records = input.retain === "tail"
      ? transcript.records.slice(removed)
      : transcript.records.slice(0, transcript.records.length - removed);
    let throughSequence = transcript.throughSequence;
    let nextSequence = transcript.nextSequence;
    if (input.retain === "head") {
      const firstDropped = transcript.records[records.length];
      if (firstDropped === undefined) throw new Error("TRANSCRIPT_BYTE_BOUND_CURSOR_MISSING");
      const byteCursor = firstDropped.sequence - 1;
      nextSequence = nextSequence === null
        ? byteCursor
        : Math.min(nextSequence, byteCursor);
      throughSequence = nextSequence === 0 ? null : nextSequence;
    } else {
      nextSequence = null;
    }
    return sessionTranscriptSchema.parse({
      ...transcript,
      records,
      throughSequence,
      nextSequence,
      omittedRecords: transcript.omittedRecords + removed,
      digest: digestTranscriptRecords(records),
    });
  };

  // Serialized size is monotone as records are removed. Binary search keeps
  // the largest record set that fits without repeatedly serializing 500 full
  // pages.
  let lower = 1;
  let upper = transcript.records.length;
  let bounded: SessionTranscript | null = null;
  while (lower <= upper) {
    const removed = Math.floor((lower + upper) / 2);
    const next = candidate(removed);
    if (utf8Bytes(JSON.stringify(next)) <= maximumBytes) {
      bounded = next;
      upper = removed - 1;
    } else {
      lower = removed + 1;
    }
  }
  if (bounded === null) throw new Error("TRANSCRIPT_SERIALIZED_BYTE_LIMIT_TOO_SMALL");
  return bounded;
};

/** The first line of every rendered handoff seed. */
export const TRANSCRIPT_SEED_HEADER = "[Oompa provider handoff]";

const actorLabel = (actor: SessionMessageActor): string =>
  actor === "human"
    ? "User"
    : actor === "automation"
      ? "User (automation)"
      : actor === "autorespond"
        ? "User (autorespond)"
        : actor === "peer_session"
          ? "User (peer session)"
          : "User (handoff)";

const attachmentManifestSuffix = (
  attachments: readonly AttachmentReference[] | undefined,
): string => attachments === undefined
  ? ""
  : ` [attachments: ${attachments.map((attachment) =>
    `${attachment.name} (${attachment.mediaType}, ${String(attachment.byteLength)} bytes, sha256:${attachment.digest})`)
    .join("; ")}; contents not embedded]`;

/** Current manual handoff rendering, including retained attachment metadata. */
const seedLine = (record: TranscriptRecord): string => {
  switch (record.kind) {
    // A provider-switch message is itself a generated transcript seed. Carrying
    // that seed into the next seed recursively consumes the bounded handoff
    // budget with an older serialization of the same history. The durable
    // provider_switched record retains the boundary; this marker retains the
    // fact that a seed was sent without nesting its generated body.
    case "user": return record.actor === "provider_switch"
      ? "User (handoff): [prior Oompa handoff seed omitted]"
      : `${actorLabel(record.actor)}: ${record.text}${
      record.omittedCharacters > 0 ? ` [+${String(record.omittedCharacters)} characters omitted]` : ""}${
      attachmentManifestSuffix(record.attachments)}`;
    case "assistant": return `Assistant: ${record.text}${
      record.omittedCharacters > 0 ? ` [+${String(record.omittedCharacters)} characters omitted]` : ""}`;
    case "reasoning": return `Assistant (reasoning summary): ${record.text}${
      record.omittedCharacters > 0 ? ` [+${String(record.omittedCharacters)} characters omitted]` : ""}`;
    case "tool_call": return `Tool call ${record.itemKind}${
      record.tool === undefined ? "" : ` ${record.server === undefined ? "" : `${record.server}/`}${record.tool}`}${
      record.summary === undefined ? "" : `: ${record.summary}`}`;
    case "tool_result": return `Tool result ${record.itemKind}: ${
      record.ok === null ? record.status ?? "unknown" : record.ok ? "ok" : "failed"}`;
    case "provider_switch": return `Provider handoff: ${record.fromProvider} to ${record.toProvider}`;
  }
};

/** Frozen V1 managed-forward and historical manual record bytes. */
export const renderTranscriptRecord = (record: TranscriptRecord): string => {
  switch (record.kind) {
    case "user": return `${(record.actor === "human" ? "User" : record.actor === "autorespond" ? "User (autorespond)" : "User (handoff)")}: ${record.text}${
      record.omittedCharacters > 0 ? ` [+${String(record.omittedCharacters)} characters omitted]` : ""}`;
    case "assistant": return `Assistant: ${record.text}${
      record.omittedCharacters > 0 ? ` [+${String(record.omittedCharacters)} characters omitted]` : ""}`;
    case "reasoning": return `Assistant (reasoning summary): ${record.text}${
      record.omittedCharacters > 0 ? ` [+${String(record.omittedCharacters)} characters omitted]` : ""}`;
    case "tool_call": return `Tool call ${record.itemKind}${
      record.tool === undefined ? "" : ` ${record.server === undefined ? "" : `${record.server}/`}${record.tool}`}${
      record.summary === undefined ? "" : `: ${record.summary}`}`;
    case "tool_result": return `Tool result ${record.itemKind}: ${
      record.ok === null ? record.status ?? "unknown" : record.ok ? "ok" : "failed"}`;
    case "provider_switch": return `Provider handoff: ${record.fromProvider} to ${record.toProvider}`;
  }
};

export type TranscriptSeed = Readonly<{
  text: string;
  digest: string;
  omittedRecords: number;
  includedRecords: number;
  retentionGapReason?: SessionEventGapReason;
}>;

export const digestTranscriptSeed = (text: string): string => createHash("sha256")
  .update("hra:session-transcript-seed:v1\0", "utf8")
  .update(text, "utf8")
  .digest("hex");

/** Retained private48/combined49 rendererVersion=1, never a new-write default. */
export const renderTranscriptSeedV1 = (input: Readonly<{
  transcript: SessionTranscript;
  fromProvider: string;
  toProvider: string;
  maxCharacters?: number;
}>): TranscriptSeed => {
  const maxCharacters = z.number().int().min(256).max(24_576)
    .parse(input.maxCharacters ?? 24_576);
  const lines: string[] = [];
  let used = 0;
  let included = 0;
  for (let index = input.transcript.records.length - 1; index >= 0; index -= 1) {
    const record = input.transcript.records[index];
    if (record === undefined) continue;
    const line = renderTranscriptRecord(record);
    if (used + line.length + 1 > maxCharacters) break;
    lines.push(line);
    used += line.length + 1;
    included += 1;
  }
  lines.reverse();
  const omittedRecords = input.transcript.records.length - included
    + input.transcript.omittedRecords;
  const header = [
    "[Oompa provider handoff]",
    `This conversation ran on ${input.fromProvider} and now runs on ${input.toProvider}.`,
    "What follows is Oompa's own record of it, not the previous provider's transcript:"
    + " secrets, absolute paths, raw tool arguments, and raw tool output were never stored"
    + " and are not here.",
    omittedRecords > 0
      ? `${String(omittedRecords)} earlier records were omitted to fit this summary.`
      : "No records were omitted.",
    "Continue the work from here. Ask before assuming anything the summary does not state.",
    "",
  ].join("\n");
  const text = `${header}${lines.join("\n")}`;
  return {
    text,
    digest: createHash("sha256").update("hra:session-transcript-seed:v1\0", "utf8").update(text, "utf8").digest("hex"),
    omittedRecords,
    includedRecords: included,
  };
};

/**
 * Render the neutral transcript as the single user message the target
 * provider is seeded with.
 *
 * The rendering is explicitly labelled as a handoff summary, is built only
 * from records that already passed Oompa's redaction, is capped, and states its
 * own omission count. The most recent records are the ones kept: a handoff
 * needs the end of the conversation more than its beginning.
 */
export const renderTranscriptSeed = (input: Readonly<{
  transcript: SessionTranscript;
  fromProvider: string;
  toProvider: string;
  maxCharacters?: number;
}>): TranscriptSeed => {
  const maxCharacters = z.number().int().min(512).max(TRANSCRIPT_SEED_MAX_CHARACTERS)
    .parse(input.maxCharacters ?? TRANSCRIPT_SEED_MAX_CHARACTERS);
  const transcript = sessionTranscriptSchema.parse(input.transcript);
  const fromProvider = providerSchema.parse(input.fromProvider);
  const toProvider = providerSchema.parse(input.toProvider);
  const lines: string[] = [];
  let included = 0;
  const retentionGapReason = transcript.retentionGapReason ?? undefined;
  const verboseHeaderFor = (omittedRecords: number): string => [
    TRANSCRIPT_SEED_HEADER,
    `This conversation ran on ${fromProvider} and now runs on ${toProvider}.`,
    "What follows is Oompa's own record of it, not the previous provider's transcript:"
    + " secrets, absolute paths, raw tool arguments, raw tool output, and attachment contents"
    + " were never embedded and are not here.",
    ...(retentionGapReason === undefined
      ? [omittedRecords > 0
          ? `${String(omittedRecords)} earlier records were omitted to fit this summary.`
          : "No retained records were omitted."]
      : [
          `WARNING: Oompa pruned earlier ledger history (${retentionGapReason});`
          + " the number of unavailable records is unknown.",
          omittedRecords > 0
            ? `${String(omittedRecords)} additional retained records were omitted to fit this summary.`
            : "No additional retained records were omitted from this summary.",
        ]),
    "Continue the work from here. Ask before assuming anything the summary does not state.",
    "",
  ].join("\n");
  const compactHeaderFor = (omittedRecords: number): string => [
    TRANSCRIPT_SEED_HEADER,
    `${fromProvider} to ${toProvider}; Oompa's retained record, not the provider transcript.`,
    "Secrets, absolute paths, raw tool data, and attachment contents are excluded.",
    ...(retentionGapReason === undefined
      ? [omittedRecords > 0
          ? `${String(omittedRecords)} retained records omitted.`
          : "No retained records omitted."]
      : [
          `WARNING: earlier ledger history was pruned (${retentionGapReason}); its size is unknown.`,
          omittedRecords > 0
            ? `${String(omittedRecords)} additional retained records omitted.`
            : "No additional retained records omitted.",
        ]),
    "Continue from here. Ask before assuming omitted facts.",
    "",
  ].join("\n");
  const headerFor = (omittedRecords: number): string => {
    const verbose = verboseHeaderFor(omittedRecords);
    if (verbose.length <= maxCharacters) return verbose;
    const compact = compactHeaderFor(omittedRecords);
    if (compact.length <= maxCharacters) return compact;
    throw new Error("TRANSCRIPT_SEED_HEADER_EXCEEDS_LIMIT");
  };
  for (let index = transcript.records.length - 1; index >= 0; index -= 1) {
    const record = transcript.records[index];
    if (record === undefined) continue;
    const line = seedLine(record);
    const nextIncluded = included + 1;
    const nextOmitted = transcript.records.length - nextIncluded
      + transcript.omittedRecords;
    const candidateLines = [line, ...lines];
    const candidate = `${headerFor(nextOmitted)}${candidateLines.join("\n")}`;
    if (candidate.length > maxCharacters) break;
    lines.unshift(line);
    included = nextIncluded;
  }
  const omittedRecords = transcript.records.length - included
    + transcript.omittedRecords;
  const text = `${headerFor(omittedRecords)}${lines.join("\n")}`;
  return {
    text,
    digest: digestTranscriptSeed(text),
    omittedRecords,
    includedRecords: included,
    ...(retentionGapReason === undefined ? {} : { retentionGapReason }),
  };
};
