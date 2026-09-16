import { createHash } from "node:crypto";

import {
  attachmentFencedText,
  type PreparedAttachment,
} from "../domain/attachments.ts";
import { isRecord, snapshotForeignJson } from "../domain/guards.ts";
import type { InteractionDisplay, InteractionKind } from "../domain/interactions.ts";
import { redactAbsolutePaths } from "../domain/text-safety.ts";
import { redactCompleteSensitiveText } from "../sensitive-text.ts";
import { ClaudeError } from "./errors.ts";
import {
  CLAUDE_PIN,
  CLAUDE_PIN_EFFORT,
  CLAUDE_PIN_MODEL,
  CLAUDE_PIN_REFUSED_EFFORTS,
  PINNED_CLAUDE_MATRIX_DIGESTS,
} from "./pin.ts";

/**
 * SHA-256 of the pinned version, a newline, then each reviewed matrix entry as
 * `event:disposition` joined by newlines. Identical in spirit to
 * `codexMatrixDigest`: a silent edit to the admitted surface fails the pin.
 */
export const claudeMatrixDigest = (
  version: string,
  matrix: Readonly<Record<string, string>>,
): string => {
  const signature = `${version}\n${Object.entries(matrix)
    .map(([event, disposition]) => `${event}:${disposition}`)
    .join("\n")}`;
  return createHash("sha256").update(signature).digest("hex");
};

export type ClaudeDisposition = "routed" | "reduced" | "ignored";

/**
 * Every `type` (or `type/subtype`) the pinned build emits on the stream-json
 * stdout stream. `routed` becomes a closed Oompa fact, `reduced` keeps only
 * bounded reviewed metadata, `ignored` is discarded after its envelope is
 * validated. Anything absent here is a drift notice, never a silent accept.
 */
export const PINNED_CLAUDE_STREAM_MATRIX = Object.freeze({
  assistant: "routed",
  control_cancel_request: "reduced",
  control_request: "routed",
  control_response: "ignored",
  rate_limit_event: "reduced",
  result: "routed",
  stream_event: "routed",
  "system/compact_boundary": "routed",
  "system/compact_result": "routed",
  "system/hook_response": "ignored",
  "system/hook_started": "ignored",
  "system/init": "routed",
  "system/status": "routed",
  "system/task_notification": "routed",
  "system/task_progress": "routed",
  "system/task_started": "routed",
  "system/task_updated": "routed",
  user: "ignored",
} as const satisfies Readonly<Record<string, ClaudeDisposition>>);

/** Every `control_request.request.subtype` the pinned build sends to Oompa. */
export const PINNED_CLAUDE_CONTROL_REQUEST_MATRIX = Object.freeze({
  can_use_tool: "routed",
  hook_callback: "ignored",
  initialize: "ignored",
  mcp_message: "ignored",
  set_permission_mode: "ignored",
} as const satisfies Readonly<Record<string, ClaudeDisposition>>);

export function assertPinnedClaudeMatrices(): void {
  if (
    claudeMatrixDigest(CLAUDE_PIN, PINNED_CLAUDE_STREAM_MATRIX)
      !== PINNED_CLAUDE_MATRIX_DIGESTS.streamEvent
    || claudeMatrixDigest(CLAUDE_PIN, PINNED_CLAUDE_CONTROL_REQUEST_MATRIX)
      !== PINNED_CLAUDE_MATRIX_DIGESTS.controlRequest
  ) {
    throw new ClaudeError(
      "RUNTIME_MISMATCH",
      "The pinned Claude stream-json matrix does not match its reviewed digest",
    );
  }
}

/** Refuses any Claude Code build other than the reviewed pin. */
export function assertPinnedClaudeVersion(version: string): void {
  if (version !== CLAUDE_PIN) {
    throw new ClaudeError(
      "RUNTIME_MISMATCH",
      `Oompa requires Claude Code ${CLAUDE_PIN}`,
    );
  }
}

export function assertPinnedClaudeModel(model: string, effort: string): void {
  if (model !== CLAUDE_PIN_MODEL) {
    throw new ClaudeError(
      "RUNTIME_MISMATCH",
      `Oompa requires the pinned Claude model ${CLAUDE_PIN_MODEL}`,
    );
  }
  if ((CLAUDE_PIN_REFUSED_EFFORTS as readonly string[]).includes(effort)) {
    throw new ClaudeError(
      "UNSUPPORTED_CAPABILITY",
      `Oompa never requests the \`${effort}\` reasoning effort`,
    );
  }
  if (effort !== CLAUDE_PIN_EFFORT) {
    throw new ClaudeError(
      "UNSUPPORTED_CAPABILITY",
      `The fable-max preset requires the ${CLAUDE_PIN_EFFORT} reasoning effort`,
    );
  }
}

// ---------------------------------------------------------------------------
// Bounded parsing from `unknown`.
// ---------------------------------------------------------------------------

type UnknownRecord = Record<string, unknown>;

const protocol = (message: string): ClaudeError => new ClaudeError("PROTOCOL_ERROR", message);
const protocolLimit = (message: string): ClaudeError => new ClaudeError("PROTOCOL_LIMIT", message);

const record = (value: unknown, label: string): UnknownRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocol(`${label} must be an object`);
  }
  return value as UnknownRecord;
};

const optionalRecord = (value: unknown, label: string): UnknownRecord | undefined =>
  value === undefined || value === null ? undefined : record(value, label);

const string = (value: unknown, label: string, max = 16_384): string => {
  if (typeof value !== "string" || value.length > max) {
    throw protocol(`${label} must be a bounded string`);
  }
  return value;
};

const optionalString = (value: unknown, label: string, max = 16_384): string | undefined =>
  value === undefined || value === null ? undefined : string(value, label, max);

const safeInteger = (value: unknown, label: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw protocol(`${label} must be a safe integer`);
  }
  return value;
};

const optionalSafeInteger = (value: unknown, label: string): number | undefined =>
  value === undefined || value === null ? undefined : safeInteger(value, label);

const nonnegativeSafeInteger = (value: unknown, label: string): number => {
  const parsed = safeInteger(value, label);
  if (parsed < 0) throw protocol(`${label} must be nonnegative`);
  return parsed;
};

const optionalNonnegativeSafeInteger = (
  value: unknown,
  label: string,
): number | undefined => value === undefined || value === null
  ? undefined
  : nonnegativeSafeInteger(value, label);

const finiteNonnegativeNumber = (value: unknown, label: string): number => {
  if (
    typeof value !== "number"
    || !Number.isFinite(value)
    || value < 0
    || value > Number.MAX_SAFE_INTEGER
  ) throw protocol(`${label} must be a bounded nonnegative number`);
  return value;
};

const optionalFiniteNonnegativeNumber = (
  value: unknown,
  label: string,
): number | undefined => value === undefined || value === null
  ? undefined
  : finiteNonnegativeNumber(value, label);

const providerCode = (value: unknown, label: string, max = 128): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw protocol(`${label} must be a nonempty provider code`);
  }
  if (!/^[A-Za-z0-9_.:+/-]+$/u.test(value)) {
    throw protocol(`${label} contains unsupported provider-code characters`);
  }
  if (new TextEncoder().encode(value).byteLength > max) {
    throw protocol(`${label} must be at most ${max} UTF-8 bytes`);
  }
  return value;
};

const optionalProviderCode = (
  value: unknown,
  label: string,
  max = 128,
): string | undefined => value === undefined || value === null
  ? undefined
  : providerCode(value, label, max);

/** Stable ASCII/code-unit ordering for provider identifiers used in digests. */
const compareProviderCodes = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

const eventId = (value: unknown, label: string): string => {
  const parsed = string(value, label, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(parsed)) {
    throw protocol(`${label} must be a UUID`);
  }
  return parsed.toLowerCase();
};

/**
 * The pinned provider reports reset instants as Unix seconds. A 12/13-digit
 * millisecond-shaped value is ambiguous and therefore cannot enter usage
 * authority.
 */
const providerResetTimestampMilliseconds = (value: unknown, label: string): number => {
  const seconds = nonnegativeSafeInteger(value, label);
  if (seconds >= 100_000_000_000) {
    throw protocol(`${label} must be Unix seconds`);
  }
  const milliseconds = seconds * 1_000;
  if (!Number.isSafeInteger(milliseconds)) {
    throw protocol(`${label} is outside the supported timestamp range`);
  }
  return milliseconds;
};

const optionalProviderResetTimestampMilliseconds = (
  value: unknown,
  label: string,
): number | null => value === undefined || value === null
  ? null
  : providerResetTimestampMilliseconds(value, label);

const optionalBoolean = (value: unknown, label: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw protocol(`${label} must be a boolean`);
  return value;
};

const array = (value: unknown, label: string, max: number): readonly unknown[] => {
  if (!Array.isArray(value) || value.length > max) {
    throw protocol(`${label} must be a bounded array`);
  }
  return value;
};

const unsafeTerminalScalar = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const sensitiveProviderTextHint =
  /(?:auth|cookie|token|key|pass|secret|otp|invite|code|Bearer|Basic|sk[_-]|re[_-]|gh[pousr]|github_pat|xox|AKIA|eyJ|PRIVATE KEY|[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{M}])/iu;
const uncPathHint = /\\\\[^\\/\s]/u;

/**
 * The one sanitizer every Claude-derived display string passes through:
 * absolute paths reduced, credential-shaped runs replaced, and every unsafe
 * terminal scalar folded to the replacement character.
 */
export const sanitizeClaudeText = (input: string, preserveLineFeeds = false): string => {
  const pathReduced = input.includes("/") || input.includes(":\\") || uncPathHint.test(input)
    ? redactAbsolutePaths(input)
    : input;
  const protectedInput = sensitiveProviderTextHint.test(pathReduced)
    ? redactCompleteSensitiveText(pathReduced, "[protected]")
    : pathReduced;
  let output = "";
  for (const scalar of protectedInput) {
    output += scalar === "\n" && preserveLineFeeds
      ? scalar
      : unsafeTerminalScalar.test(scalar)
        ? "�"
        : scalar;
  }
  return output;
};

/** Truncates at Unicode scalar boundaries so a bound never splits a scalar. */
export const boundClaudeText = (input: string, maxUtf8Bytes: number): string => {
  const encoder = new TextEncoder();
  if (encoder.encode(input).byteLength <= maxUtf8Bytes) return input;
  let output = "";
  let used = 0;
  for (const scalar of input) {
    const bytes = encoder.encode(scalar).byteLength;
    if (used + bytes > maxUtf8Bytes) break;
    output += scalar;
    used += bytes;
  }
  return output;
};

const SUMMARY_BYTES = 2_048;
const displayText = (input: string): string =>
  boundClaudeText(sanitizeClaudeText(input), SUMMARY_BYTES);

const displayTextResult = (input: string): Readonly<{ exact: boolean; text: string }> => {
  const text = displayText(input);
  return { exact: text === input, text };
};

// ---------------------------------------------------------------------------
// The closed stream-event union.
// ---------------------------------------------------------------------------

export interface ClaudeCanUseTool {
  readonly subtype: "can_use_tool";
  readonly toolName: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly toolUseId: string;
  readonly requiresUserInteraction: boolean;
  readonly blockedPath: string | null;
  readonly decisionReasonType: string | null;
  readonly permissionSuggestionCount: number;
  /** Kept only in process memory; echoed verbatim on an allow response. */
  readonly input: UnknownRecord;
  /** Present only for an `AskUserQuestion` call. */
  readonly questions: readonly ClaudeQuestion[] | null;
}

export interface ClaudeQuestion {
  readonly question: string;
  readonly header: string;
  readonly multiSelect: boolean;
  readonly options: readonly { readonly label: string; readonly description: string }[];
}

export interface ClaudeUsage {
  readonly inputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningOutputTokens: number | null;
  readonly totalTokens: number | null;
  readonly modelContextWindow: number | null;
}

export const CLAUDE_RATE_LIMIT_WINDOW_LIMIT = 16;
export const CLAUDE_RESULT_MODEL_LIMIT = 32;

export type ClaudeKnownRateLimitStatus =
  | "allowed"
  | "warning"
  | "blocked"
  | "denied"
  | "rejected";

export type ClaudeRateLimitStatus =
  | Readonly<{ readonly state: "known"; readonly value: ClaudeKnownRateLimitStatus }>
  | Readonly<{ readonly state: "unknown"; readonly value: string }>;

export type ClaudeRateLimitWindow = Readonly<{
  /** Pinned Claude window name. Current evidence establishes account scope only. */
  id: string;
  usedPercent: number;
  resetsAtMs: number;
}>;

/** Sanitized quota-only projection of one pinned `rate_limit_event`. */
export type ClaudeRateLimitObservation = Readonly<{
  status: ClaudeRateLimitStatus;
  rateLimitType: string | null;
  resetsAtMs: number | null;
  overageStatus: string | null;
  overageDisabledReason: string | null;
  isUsingOverage: boolean | null;
  windows: readonly ClaudeRateLimitWindow[];
}>;

export type ClaudeTokenAccounting = Readonly<{
  inputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
}>;

export type ClaudeModelAccounting = ClaudeTokenAccounting & Readonly<{
  model: string;
  costUsd: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}>;

/** Sanitized accounting-only projection of one terminal `result`. */
export type ClaudeResultAccounting = Readonly<{
  totalCostUsd: number | null;
  tokens: ClaudeTokenAccounting;
  models: readonly ClaudeModelAccounting[];
}>;

export type ClaudeStreamEvent =
  | {
      readonly type: "session_init";
      readonly sessionId: string;
      readonly model: string;
      readonly permissionMode: string;
      readonly claudeVersion: string;
      readonly toolCount: number;
    }
  | {
      readonly type: "assistant_message";
      readonly sessionId: string;
      readonly messageId: string;
      readonly model: string;
      readonly text: string;
      readonly thinking: string;
      readonly parentToolUseId: string | null;
    }
  | {
      readonly type: "content_delta";
      readonly sessionId: string;
      readonly block: "text" | "thinking";
      readonly blockIndex: number;
      readonly text: string;
      readonly parentToolUseId: string | null;
    }
  | {
      readonly type: "task_started";
      readonly taskId: string;
      readonly toolUseId: string;
      readonly description: string;
      readonly subagentType: string;
      readonly spawnDepth: number;
      readonly backgrounded: boolean;
    }
  | {
      readonly type: "task_progress";
      readonly taskId: string;
      readonly toolUseId: string;
      readonly description: string | null;
      readonly subagentType: string | null;
      readonly lastToolName: string | null;
      readonly totalTokens: number | null;
      readonly toolUses: number | null;
    }
  | {
      readonly type: "task_updated";
      readonly taskId: string;
      readonly status: string | null;
    }
  | {
      readonly type: "task_notification";
      readonly taskId: string;
      readonly toolUseId: string;
      readonly status: string;
      readonly summary: string | null;
    }
  | {
      readonly type: "result";
      readonly eventId: string | null;
      readonly sourceEventDigest: string | null;
      readonly sessionId: string;
      readonly isError: boolean;
      readonly stopReason: string | null;
      readonly terminalReason: string | null;
      readonly resultText: string;
      readonly numTurns: number;
      readonly durationMs: number;
      readonly usage: ClaudeUsage;
      readonly accounting: ClaudeResultAccounting | null;
      readonly model: string | null;
    }
  | {
      readonly type: "control_request";
      readonly requestId: string;
      readonly request: ClaudeCanUseTool;
    }
  | {
      readonly type: "rate_limit";
      readonly eventId: string;
      readonly sourceEventDigest: string;
      readonly sessionId: string;
      readonly quota: ClaudeRateLimitObservation;
    }
  | {
      /**
       * A `system/status` line. The pinned runtime reports `status:
       * "compacting"` while a compaction runs and clears it with `status:
       * null`; the same envelope can carry the `compact_result` /
       * `compact_error` outcome fields (verified on 2.1.270).
       */
      readonly type: "status";
      readonly sessionId: string | null;
      readonly status: string | null;
      readonly compactResult: string | null;
      readonly compactError: string | null;
    }
  | {
      /** A dedicated `system/compact_result` line, the other spelling 2.1.x emits. */
      readonly type: "compact_result";
      readonly sessionId: string | null;
      readonly compactResult: string;
      readonly compactError: string | null;
    }
  | {
      /**
       * A `system/compact_boundary` line: the transcript boundary a completed
       * compaction wrote. Token and trigger metadata is advisory; the event
       * itself is the completion signal.
       */
      readonly type: "compact_boundary";
      readonly sessionId: string | null;
      readonly trigger: string | null;
      readonly preTokens: number | null;
      readonly postTokens: number | null;
    }
  | { readonly type: "control_cancel_request"; readonly requestId: string }
  | { readonly type: "ignored"; readonly event: string }
  | { readonly type: "protocol_notice"; readonly event: string };

const dispositionOf = (event: string): ClaudeDisposition | undefined =>
  (PINNED_CLAUDE_STREAM_MATRIX as Readonly<Record<string, ClaudeDisposition>>)[event];

const messageText = (content: readonly unknown[], kind: "text" | "thinking"): string => {
  let text = "";
  for (const block of content) {
    const parsed = record(block, "Claude content block");
    if (parsed.type !== kind) continue;
    text += string(parsed[kind === "text" ? "text" : "thinking"], "Claude content block text");
  }
  return text;
};

const parseQuestions = (input: UnknownRecord): readonly ClaudeQuestion[] | null => {
  if (input.questions === undefined) return null;
  return array(input.questions, "Claude question list", 3).map((entry) => {
    const question = record(entry, "Claude question");
    return {
      header: string(question.header, "Claude question header", 256),
      multiSelect: optionalBoolean(question.multiSelect, "Claude question multiSelect") ?? false,
      options: array(question.options ?? [], "Claude question options", 20).map((option) => {
        const parsed = record(option, "Claude question option");
        return {
          description: optionalString(parsed.description, "Claude option description", 2_048) ?? "",
          label: string(parsed.label, "Claude option label", 512),
        };
      }),
      question: string(question.question, "Claude question text", 4_096),
    };
  });
};

const normalizedSourceDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const parseTokenAccounting = (value: unknown, label: string): ClaudeTokenAccounting => {
  const usage = optionalRecord(value, label) ?? {};
  const details = optionalRecord(usage.output_tokens_details, `${label} output token details`) ?? {};
  return {
    cacheCreationInputTokens:
      optionalNonnegativeSafeInteger(
        usage.cache_creation_input_tokens,
        `${label} cache creation input tokens`,
      ) ?? null,
    cacheReadInputTokens:
      optionalNonnegativeSafeInteger(
        usage.cache_read_input_tokens,
        `${label} cache read input tokens`,
      ) ?? null,
    inputTokens:
      optionalNonnegativeSafeInteger(usage.input_tokens, `${label} input tokens`) ?? null,
    outputTokens:
      optionalNonnegativeSafeInteger(usage.output_tokens, `${label} output tokens`) ?? null,
    thinkingTokens:
      optionalNonnegativeSafeInteger(details.thinking_tokens, `${label} thinking tokens`) ?? null,
  };
};

const parseModelAccounting = (value: unknown): readonly ClaudeModelAccounting[] => {
  const modelUsage = optionalRecord(value, "Claude model usage") ?? {};
  const entries = Object.entries(modelUsage);
  if (entries.length > CLAUDE_RESULT_MODEL_LIMIT) {
    throw protocolLimit(
      `Claude model usage exceeds the ${CLAUDE_RESULT_MODEL_LIMIT}-model limit`,
    );
  }
  return entries
    .map(([key, rawModel]): ClaudeModelAccounting => {
      const model = providerCode(key, "Claude model usage key");
      const parsed = record(rawModel, `Claude model usage ${model}`);
      const canonicalModel = providerCode(
        parsed.canonicalModel,
        `Claude model usage ${model} canonical model`,
      );
      if (canonicalModel !== model) {
        throw protocol(`Claude model usage ${model} must match its canonical model`);
      }
      return {
        cacheCreationInputTokens: optionalNonnegativeSafeInteger(
          parsed.cacheCreationInputTokens,
          `Claude model usage ${model} cache creation input tokens`,
        ) ?? null,
        cacheReadInputTokens: optionalNonnegativeSafeInteger(
          parsed.cacheReadInputTokens,
          `Claude model usage ${model} cache read input tokens`,
        ) ?? null,
        contextWindow: optionalNonnegativeSafeInteger(
          parsed.contextWindow,
          `Claude model usage ${model} context window`,
        ) ?? null,
        costUsd: optionalFiniteNonnegativeNumber(
          parsed.costUSD,
          `Claude model usage ${model} cost`,
        ) ?? null,
        inputTokens: optionalNonnegativeSafeInteger(
          parsed.inputTokens,
          `Claude model usage ${model} input tokens`,
        ) ?? null,
        maxOutputTokens: optionalNonnegativeSafeInteger(
          parsed.maxOutputTokens,
          `Claude model usage ${model} max output tokens`,
        ) ?? null,
        model,
        outputTokens: optionalNonnegativeSafeInteger(
          parsed.outputTokens,
          `Claude model usage ${model} output tokens`,
        ) ?? null,
        thinkingTokens: optionalNonnegativeSafeInteger(
          parsed.thinkingTokens,
          `Claude model usage ${model} thinking tokens`,
        ) ?? null,
      };
    })
    .sort((left, right) => compareProviderCodes(left.model, right.model));
};

const parseResultAccounting = (line: UnknownRecord): ClaudeResultAccounting => ({
  models: parseModelAccounting(line.modelUsage),
  tokens: parseTokenAccounting(line.usage, "Claude usage"),
  totalCostUsd:
    optionalFiniteNonnegativeNumber(line.total_cost_usd, "Claude total cost") ?? null,
});

/** The pre-v2 neutral token timeline remains byte-for-byte semantically stable. */
const parseUsage = (value: unknown): ClaudeUsage => {
  const usage = optionalRecord(value, "Claude usage") ?? {};
  const details = optionalRecord(usage.output_tokens_details, "Claude output token details") ?? {};
  const inputTokens = optionalSafeInteger(usage.input_tokens, "Claude input tokens") ?? null;
  const cachedInputTokens =
    (optionalSafeInteger(usage.cache_read_input_tokens, "Claude cache read tokens") ?? 0)
    + (optionalSafeInteger(usage.cache_creation_input_tokens, "Claude cache creation tokens") ?? 0);
  const outputTokens = optionalSafeInteger(usage.output_tokens, "Claude output tokens") ?? null;
  const reasoningOutputTokens =
    optionalSafeInteger(details.thinking_tokens, "Claude thinking tokens") ?? null;
  return {
    cachedInputTokens,
    inputTokens,
    modelContextWindow: null,
    outputTokens,
    reasoningOutputTokens,
    totalTokens:
      inputTokens === null && outputTokens === null
        ? null
        : (inputTokens ?? 0) + cachedInputTokens + (outputTokens ?? 0),
  };
};

const parseResultModel = (value: unknown): string | null => {
  try {
    const modelUsage = optionalRecord(value, "Claude model usage") ?? {};
    const entries = Object.entries(modelUsage);
    if (entries.length !== 1) return null;
    const [key, rawModel] = entries[0] as [string, unknown];
    const model = providerCode(key, "Claude model usage key");
    const parsed = record(rawModel, `Claude model usage ${model}`);
    return providerCode(
      parsed.canonicalModel,
      `Claude model usage ${model} canonical model`,
    ) === model
      ? model
      : null;
  } catch (error) {
    if (error instanceof ClaudeError) return null;
    throw error;
  }
};

const KNOWN_RATE_LIMIT_STATUSES = new Set<ClaudeKnownRateLimitStatus>([
  "allowed",
  "warning",
  "blocked",
  "denied",
  "rejected",
]);

const parseRateLimitStatus = (value: unknown): ClaudeRateLimitStatus => {
  const parsed = providerCode(value, "Claude rate limit status");
  return KNOWN_RATE_LIMIT_STATUSES.has(parsed as ClaudeKnownRateLimitStatus)
    ? { state: "known", value: parsed as ClaudeKnownRateLimitStatus }
    : { state: "unknown", value: parsed };
};

const parseRateLimitObservation = (value: unknown): ClaudeRateLimitObservation => {
  const info = record(value, "Claude rate limit info");
  const rawWindows = optionalRecord(
    info.unifiedWindows,
    "Claude unified rate limit windows",
  ) ?? {};
  const entries = Object.entries(rawWindows);
  if (entries.length > CLAUDE_RATE_LIMIT_WINDOW_LIMIT) {
    throw protocolLimit(
      `Claude rate limit windows exceed the ${CLAUDE_RATE_LIMIT_WINDOW_LIMIT}-window limit`,
    );
  }
  const windows = entries
    .map(([key, rawWindow]): ClaudeRateLimitWindow => {
      const id = providerCode(key, "Claude rate limit window id", 128);
      const window = record(rawWindow, `Claude rate limit window ${id}`);
      const utilization = finiteNonnegativeNumber(
        window.utilization,
        `Claude rate limit window ${id} utilization`,
      );
      if (utilization > 1) {
        throw protocol(`Claude rate limit window ${id} utilization must be between zero and one`);
      }
      return {
        id,
        resetsAtMs: providerResetTimestampMilliseconds(
          window.resetsAt,
          `Claude rate limit window ${id} reset`,
        ),
        usedPercent: utilization * 100,
      };
    })
    .sort((left, right) => compareProviderCodes(left.id, right.id));
  return {
    isUsingOverage:
      optionalBoolean(info.isUsingOverage, "Claude overage use flag") ?? null,
    overageDisabledReason:
      optionalProviderCode(
        info.overageDisabledReason,
        "Claude overage disabled reason",
      ) ?? null,
    overageStatus:
      optionalProviderCode(info.overageStatus, "Claude overage status") ?? null,
    rateLimitType:
      optionalProviderCode(info.rateLimitType, "Claude rate limit type") ?? null,
    resetsAtMs: optionalProviderResetTimestampMilliseconds(
      info.resetsAt,
      "Claude rate limit reset",
    ),
    status: parseRateLimitStatus(info.status),
    windows,
  };
};

const parseControlRequest = (value: UnknownRecord): ClaudeStreamEvent => {
  const requestId = string(value.request_id, "Claude control request id", 512);
  const request = record(value.request, "Claude control request body");
  const subtype = string(request.subtype, "Claude control request subtype", 128);
  const disposition = (
    PINNED_CLAUDE_CONTROL_REQUEST_MATRIX as Readonly<Record<string, ClaudeDisposition>>
  )[subtype];
  if (disposition === undefined) return { event: `control_request/${subtype}`, type: "protocol_notice" };
  if (disposition !== "routed") return { event: `control_request/${subtype}`, type: "ignored" };
  const input = record(request.input, "Claude tool input");
  const toolName = string(request.tool_name, "Claude tool name", 256);
  return {
    request: {
      blockedPath: optionalString(request.blocked_path, "Claude blocked path", 4_096) ?? null,
      decisionReasonType:
        optionalString(request.decision_reason_type, "Claude decision reason", 128) ?? null,
      description: optionalString(request.description, "Claude tool description", 4_096) ?? null,
      displayName: optionalString(request.display_name, "Claude tool display name", 256) ?? toolName,
      input,
      permissionSuggestionCount: array(
        request.permission_suggestions ?? [],
        "Claude permission suggestions",
        64,
      ).length,
      questions: toolName === "AskUserQuestion" ? parseQuestions(input) : null,
      requiresUserInteraction:
        optionalBoolean(request.requires_user_interaction, "Claude interaction flag") ?? false,
      subtype: "can_use_tool",
      toolName,
      toolUseId: string(request.tool_use_id, "Claude tool use id", 512),
    },
    requestId,
    type: "control_request",
  };
};

const parseSystemEvent = (value: UnknownRecord, subtype: string): ClaudeStreamEvent => {
  switch (subtype) {
    case "init":
      return {
        claudeVersion: string(value.claude_code_version, "Claude version", 64),
        model: string(value.model, "Claude model", 200),
        permissionMode: string(value.permissionMode, "Claude permission mode", 64),
        sessionId: string(value.session_id, "Claude session id", 128),
        toolCount: array(value.tools ?? [], "Claude tool list", 512).length,
        type: "session_init",
      };
    case "task_started":
      return {
        backgrounded: optionalBoolean(value.is_backgrounded, "Claude backgrounded flag") ?? false,
        description: optionalString(value.description, "Claude task description", 4_096) ?? "",
        spawnDepth: optionalSafeInteger(value.spawn_depth, "Claude spawn depth") ?? 0,
        subagentType: optionalString(value.subagent_type, "Claude subagent type", 256) ?? "",
        taskId: string(value.task_id, "Claude task id", 128),
        toolUseId: string(value.tool_use_id, "Claude tool use id", 512),
        type: "task_started",
      };
    case "task_progress": {
      const usage = optionalRecord(value.usage, "Claude task usage") ?? {};
      return {
        description: optionalString(value.description, "Claude task description", 4_096) ?? null,
        lastToolName: optionalString(value.last_tool_name, "Claude last tool name", 256) ?? null,
        subagentType: optionalString(value.subagent_type, "Claude subagent type", 256) ?? null,
        taskId: string(value.task_id, "Claude task id", 128),
        toolUses: optionalSafeInteger(usage.tool_uses, "Claude task tool uses") ?? null,
        toolUseId: string(value.tool_use_id, "Claude tool use id", 512),
        totalTokens: optionalSafeInteger(usage.total_tokens, "Claude task tokens") ?? null,
        type: "task_progress",
      };
    }
    case "task_updated": {
      const patch = optionalRecord(value.patch, "Claude task patch") ?? {};
      return {
        status: optionalString(patch.status, "Claude task status", 64) ?? null,
        taskId: string(value.task_id, "Claude task id", 128),
        type: "task_updated",
      };
    }
    case "task_notification":
      return {
        status: string(value.status, "Claude task status", 64),
        summary: optionalString(value.summary, "Claude task summary", 4_096) ?? null,
        taskId: string(value.task_id, "Claude task id", 128),
        toolUseId: string(value.tool_use_id, "Claude tool use id", 512),
        type: "task_notification",
      };
    // The compaction signals below degrade to a bounded notice rather than a
    // thrown fault: a malformed advisory on a live session must never take
    // the stream down.
    case "status": {
      try {
        return {
          compactError:
            optionalString(value.compact_error, "Claude compact error", 2_048) ?? null,
          compactResult:
            optionalProviderCode(value.compact_result, "Claude compact result", 64) ?? null,
          sessionId: optionalString(value.session_id, "Claude session id", 128) ?? null,
          status: optionalProviderCode(value.status, "Claude status", 128) ?? null,
          type: "status",
        };
      } catch (error) {
        if (error instanceof ClaudeError) {
          return { event: "system/status/invalid", type: "protocol_notice" };
        }
        throw error;
      }
    }
    case "compact_result": {
      try {
        return {
          compactError:
            optionalString(value.compact_error, "Claude compact error", 2_048) ?? null,
          compactResult: providerCode(value.compact_result, "Claude compact result", 64),
          sessionId: optionalString(value.session_id, "Claude session id", 128) ?? null,
          type: "compact_result",
        };
      } catch (error) {
        if (error instanceof ClaudeError) {
          return { event: "system/compact_result/invalid", type: "protocol_notice" };
        }
        throw error;
      }
    }
    case "compact_boundary": {
      try {
        // Transcript records spell this `compactMetadata`; stream-json output
        // has also been captured with `compact_metadata`, and the token
        // fields themselves appear in both casings across 2.1.x builds.
        const metadata =
          optionalRecord(value.compactMetadata, "Claude compact metadata")
          ?? optionalRecord(value.compact_metadata, "Claude compact metadata")
          ?? {};
        return {
          postTokens: optionalNonnegativeSafeInteger(
            metadata.postTokens ?? metadata.post_tokens,
            "Claude post-compaction tokens",
          ) ?? null,
          preTokens: optionalNonnegativeSafeInteger(
            metadata.preTokens ?? metadata.pre_tokens,
            "Claude pre-compaction tokens",
          ) ?? null,
          sessionId: optionalString(
            value.session_id ?? value.sessionId,
            "Claude session id",
            128,
          ) ?? null,
          trigger: optionalProviderCode(metadata.trigger, "Claude compact trigger", 64) ?? null,
          type: "compact_boundary",
        };
      } catch (error) {
        if (error instanceof ClaudeError) {
          return { event: "system/compact_boundary/invalid", type: "protocol_notice" };
        }
        throw error;
      }
    }
    default:
      return { event: `system/${subtype}`, type: "protocol_notice" };
  }
};

const parseStreamEvent = (value: UnknownRecord): ClaudeStreamEvent => {
  const event = record(value.event, "Claude raw stream event");
  const eventType = string(event.type, "Claude raw stream event type", 128);
  const parentToolUseId =
    optionalString(value.parent_tool_use_id, "Claude parent tool use id", 512) ?? null;
  const sessionId = optionalString(value.session_id, "Claude session id", 128) ?? "";
  if (eventType !== "content_block_delta") return { event: `stream_event/${eventType}`, type: "ignored" };
  const delta = record(event.delta, "Claude content block delta");
  const deltaType = string(delta.type, "Claude content block delta type", 128);
  const block = deltaType === "text_delta"
    ? "text"
    : deltaType === "thinking_delta"
      ? "thinking"
      : null;
  if (block === null) return { event: `stream_event/content_block_delta/${deltaType}`, type: "ignored" };
  return {
    block,
    blockIndex: optionalSafeInteger(event.index, "Claude content block index") ?? 0,
    parentToolUseId,
    sessionId,
    text: string(delta[block === "text" ? "text" : "thinking"], "Claude delta text", 262_144),
    type: "content_delta",
  };
};

/**
 * Parses one stream-json line. An unrecognised `type` becomes a bounded
 * protocol notice rather than a thrown error, so one unknown line from a
 * drifted build cannot take a live session down; the version pin is what
 * fails closed.
 */
export function parseClaudeStreamLine(value: unknown): ClaudeStreamEvent {
  const line = record(value, "Claude stream line");
  const type = string(line.type, "Claude stream line type", 128);
  const subtype = optionalString(line.subtype, "Claude stream line subtype", 128);
  const key = type === "system" && subtype !== undefined ? `${type}/${subtype}` : type;
  const disposition = dispositionOf(key);
  if (disposition === undefined) return { event: key, type: "protocol_notice" };
  if (disposition === "ignored") return { event: key, type: "ignored" };
  switch (type) {
    case "system":
      return parseSystemEvent(line, subtype ?? "");
    case "assistant": {
      const message = record(line.message, "Claude assistant message");
      const content = array(message.content ?? [], "Claude assistant content", 512);
      return {
        messageId: string(message.id, "Claude message id", 256),
        model: optionalString(message.model, "Claude model", 200) ?? "",
        parentToolUseId:
          optionalString(line.parent_tool_use_id, "Claude parent tool use id", 512) ?? null,
        sessionId: optionalString(line.session_id, "Claude session id", 128) ?? "",
        text: messageText(content, "text"),
        thinking: messageText(content, "thinking"),
        type: "assistant_message",
      };
    }
    case "stream_event":
      return parseStreamEvent(line);
    case "control_request":
      return parseControlRequest(line);
    case "control_cancel_request":
      return {
        requestId: string(line.request_id, "Claude control request id", 512),
        type: "control_cancel_request",
      };
    case "rate_limit_event": {
      try {
        const parsedEventId = eventId(line.uuid, "Claude rate limit event id");
        const quota = parseRateLimitObservation(line.rate_limit_info);
        const sessionId = string(line.session_id, "Claude session id", 128);
        return {
          eventId: parsedEventId,
          quota,
          sessionId,
          sourceEventDigest: normalizedSourceDigest({
            eventId: parsedEventId,
            quota,
            sessionId,
            type: "rate_limit_event",
          }),
          type: "rate_limit",
        };
      } catch (error) {
        if (error instanceof ClaudeError) {
          return { event: "rate_limit_event/invalid", type: "protocol_notice" };
        }
        throw error;
      }
    }
    case "result": {
      const sessionId = string(line.session_id, "Claude session id", 128);
      const usage = parseUsage(line.usage);
      let accounting: ClaudeResultAccounting | null = null;
      let parsedEventId: string | null = null;
      let sourceEventDigest: string | null = null;
      try {
        const parsedAccounting = parseResultAccounting(line);
        const candidateEventId = eventId(line.uuid, "Claude result event id");
        const candidateSourceEventDigest = normalizedSourceDigest({
          accounting: parsedAccounting,
          eventId: candidateEventId,
          sessionId,
          type: "result",
        });
        accounting = parsedAccounting;
        parsedEventId = candidateEventId;
        sourceEventDigest = candidateSourceEventDigest;
      } catch (error) {
        if (!(error instanceof ClaudeError)) throw error;
      }
      return {
        accounting,
        durationMs: optionalSafeInteger(line.duration_ms, "Claude duration") ?? 0,
        eventId: parsedEventId,
        isError: optionalBoolean(line.is_error, "Claude error flag") ?? false,
        model: parseResultModel(line.modelUsage),
        numTurns: optionalSafeInteger(line.num_turns, "Claude turn count") ?? 0,
        resultText: optionalString(line.result, "Claude result text", 262_144) ?? "",
        sessionId,
        sourceEventDigest,
        stopReason: optionalString(line.stop_reason, "Claude stop reason", 128) ?? null,
        terminalReason: optionalString(line.terminal_reason, "Claude terminal reason", 128) ?? null,
        type: "result",
        usage,
      };
    }
    default:
      return { event: key, type: "protocol_notice" };
  }
}

// ---------------------------------------------------------------------------
// can_use_tool -> Oompa interaction.
// ---------------------------------------------------------------------------

export const CLAUDE_COMMAND_TOOLS: ReadonlySet<string> = new Set(["Bash"]);
export const CLAUDE_FILE_CHANGE_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "NotebookEdit",
  "Write",
]);
export const CLAUDE_USER_INPUT_TOOLS: ReadonlySet<string> = new Set(["AskUserQuestion"]);

/**
 * The plan's mapping, in its stated precedence: a question (or any request the
 * runtime marks as needing a person) is `user_input`; `Bash` is a command
 * approval; the three editing tools are file-change approvals; everything else
 * is a permission approval. Claude has no MCP elicitation envelope, so
 * `mcp_elicitation` is never produced by this provider.
 */
export const claudeInteractionKind = (request: ClaudeCanUseTool): InteractionKind => {
  if (CLAUDE_USER_INPUT_TOOLS.has(request.toolName) || request.requiresUserInteraction) {
    return "user_input";
  }
  if (CLAUDE_COMMAND_TOOLS.has(request.toolName)) return "command_approval";
  if (CLAUDE_FILE_CHANGE_TOOLS.has(request.toolName)) return "file_change_approval";
  return "permission_approval";
};

/**
 * A bounded, sanitized command class. Claude's `Bash` input carries the whole
 * command line, which is never projected verbatim.
 */
export const claudeCommandClass = (command: string): string => {
  const head = command.trim().split(/\s+/u)[0] ?? "";
  const leaf = head.split("/").at(-1) ?? head;
  return /^[A-Za-z0-9_.+-]{1,64}$/u.test(leaf) ? leaf : "command";
};

const commandOf = (request: ClaudeCanUseTool): string =>
  typeof request.input.command === "string" ? request.input.command : "";

const filePathOf = (request: ClaudeCanUseTool): string =>
  typeof request.input.file_path === "string"
    ? request.input.file_path
    : typeof request.input.notebook_path === "string"
      ? request.input.notebook_path
      : "";

/**
 * Builds the durable, projectable display for one `can_use_tool` request.
 * File-change approvals carry no diff, exactly as the Codex path does not.
 */
export const claudeInteractionDisplay = (request: ClaudeCanUseTool): InteractionDisplay => {
  const kind = claudeInteractionKind(request);
  const reason = request.description === null ? null : displayText(request.description);
  switch (kind) {
    case "command_approval":
      return {
        availableDecisions: ["once", "decline"],
        commandClass: claudeCommandClass(commandOf(request)),
        kind: "command_approval",
        reason,
        summary: displayText(`${request.displayName}: ${commandOf(request)}`),
        workingDirectory: null,
      };
    case "file_change_approval":
      return {
        availableDecisions: ["once", "decline"],
        grantRoot: null,
        kind: "file_change_approval",
        reason,
        summary: displayText(`${request.displayName} ${filePathOf(request)}`),
      };
    case "user_input": {
      const questions = request.questions ?? [];
      const exactRemoteAnswerMap = questions.every((question) => !question.multiSelect)
        && new Set(questions.map((question) => question.question)).size === questions.length;
      return {
        blocking: true,
        kind: "user_input",
        questions: questions.map((question, index) => {
          const header = displayTextResult(question.header);
          const prompt = displayTextResult(question.question);
          const renderedOptions = question.options.map((option) => {
            const description = displayTextResult(option.description);
            const label = displayTextResult(option.label);
            return {
              exact: description.exact && label.exact,
              option: { description: description.text, label: label.text },
            };
          });
          const remoteAnswerable = exactRemoteAnswerMap
            && header.exact
            && prompt.exact
            && renderedOptions.every(({ exact }) => exact);
          return {
            allowsOther: false,
            header: header.text,
            id: `q${String(index)}`,
            options: renderedOptions.map(({ option }) => option),
            question: prompt.text,
            // Claude's question tool has no secret-answer mode; Oompa still marks
            // every projected answer field as non-secret explicitly.
            secret: false,
            ...(remoteAnswerable ? { remoteAnswerable: true as const } : {}),
          };
        }),
        summary: displayText(request.questions?.[0]?.question ?? request.displayName),
      };
    }
    case "permission_approval":
      return {
        allowsSessionScope: false,
        kind: "permission_approval",
        reason,
        requested: [{ name: boundClaudeText(sanitizeClaudeText(request.toolName), 256) }],
        summary: displayText(
          request.blockedPath === null
            ? request.displayName
            : `${request.displayName} (${request.blockedPath})`,
        ),
      };
    case "mcp_elicitation":
      throw new ClaudeError("PROTOCOL_ERROR", "Claude never raises an MCP elicitation");
  }
};

/**
 * Claude's `AskUserQuestion` answers are keyed by the literal question text.
 * Oompa projects opaque `q<index>` ids instead, so this rebuilds the wire map
 * from the request Oompa still holds in memory.
 */
export const claudeAnswerMap = (
  request: ClaudeCanUseTool,
  answers: Readonly<Record<string, string>>,
): Record<string, string> => {
  const questions = request.questions ?? [];
  if (
    questions.some((question) => question.multiSelect)
    || new Set(questions.map((question) => question.question)).size !== questions.length
  ) throw new ClaudeError("UNSUPPORTED_CAPABILITY", "Claude question answers are not exact");
  const snapshot = snapshotForeignJson(answers);
  if (!snapshot.ok || !isRecord(snapshot.value)) {
    throw new ClaudeError("INVALID_INPUT", "Claude answers must be plain data");
  }
  const answerData = snapshot.value;
  const expectedKeys = questions.map((_, index) => `q${String(index)}`);
  const answerKeys = Reflect.ownKeys(answerData);
  if (
    answerKeys.length !== expectedKeys.length
    || answerKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) throw new ClaudeError("INVALID_INPUT", "Every Claude question must be answered exactly once");
  const entries: Array<readonly [string, string]> = [];
  questions.forEach((question, index) => {
    const key = `q${String(index)}`;
    const descriptor = Reflect.getOwnPropertyDescriptor(answerData, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
    ) throw new ClaudeError("INVALID_INPUT", "Claude answers must be plain data");
    const answer = descriptor.value;
    const labels = question.options.map((option) => option.label);
    if (labels.length > 0 && !labels.includes(answer)) {
      throw new ClaudeError("INVALID_INPUT", "An answer must be one of the question's options");
    }
    entries.push([question.question, answer]);
  });
  return Object.fromEntries(entries);
};

export type ClaudeControlResponse =
  | Readonly<{ behavior: "allow"; toolUseID: string; updatedInput: UnknownRecord }>
  | Readonly<{ behavior: "deny"; toolUseID: string; message: string }>;

/**
 * Builds the `control_response` body. An allow echoes the request's own input
 * verbatim (plus the answer map for a question) and never adds a
 * `permission_suggestions` rule, so Oompa can only ever grant `once` scope.
 */
export const claudeControlResponse = (
  request: ClaudeCanUseTool,
  decision:
    | Readonly<{ kind: "allow" }>
    | Readonly<{ kind: "answer"; answers: Readonly<Record<string, string>> }>
    | Readonly<{ kind: "deny"; message: string }>,
): ClaudeControlResponse => {
  if (decision.kind === "deny") {
    return {
      behavior: "deny",
      message: boundClaudeText(sanitizeClaudeText(decision.message), 512),
      toolUseID: request.toolUseId,
    };
  }
  const updatedInput: UnknownRecord = { ...request.input };
  if (decision.kind === "answer") {
    updatedInput.answers = claudeAnswerMap(request, decision.answers);
  }
  return { behavior: "allow", toolUseID: request.toolUseId, updatedInput };
};

export const claudeControlResponseLine = (
  requestId: string,
  response: ClaudeControlResponse,
): string =>
  `${JSON.stringify({
    response: { request_id: requestId, response, subtype: "success" },
    type: "control_response",
  })}\n`;

/*
 * Steering and sending are the same wire shape: another `user` line.
 *
 * Claude Code speaks Anthropic content blocks, so an image attachment is an
 * `image` block carrying its own base64 bytes and a text-ish attachment is a
 * further `text` block with a header naming the file. The message text is
 * always the first block, and with no attachment the emitted line is byte for
 * byte what Oompa sent before attachments existed.
 */
export const claudeUserLine = (
  text: string,
  attachments: readonly PreparedAttachment[] = [],
): string =>
  `${JSON.stringify({
    message: {
      content: [
        { text, type: "text" },
        ...attachments.map((attachment) => attachment.kind === "image"
          ? {
              source: {
                data: attachment.base64,
                media_type: attachment.mediaType,
                type: "base64",
              },
              type: "image",
            }
          : { text: attachmentFencedText(attachment), type: "text" }),
      ],
      role: "user",
    },
    type: "user",
  })}\n`;

export const claudeInterruptLine = (requestId: string): string =>
  `${JSON.stringify({
    request: { subtype: "interrupt" },
    request_id: requestId,
    type: "control_request",
  })}\n`;

export const claudeRequestDigest = (requestId: string, request: ClaudeCanUseTool): string =>
  createHash("sha256")
    .update("hra:claude-control-request:v1\0", "utf8")
    .update(
      JSON.stringify({
        requestId,
        toolName: request.toolName,
        toolUseId: request.toolUseId,
      }),
      "utf8",
    )
    .digest("hex");

export const claudeResponseDigest = (response: ClaudeControlResponse): string =>
  createHash("sha256")
    .update("hra:claude-control-response:v1\0", "utf8")
    .update(JSON.stringify(response), "utf8")
    .digest("hex");
