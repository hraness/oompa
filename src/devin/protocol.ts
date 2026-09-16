import { redactAbsolutePaths } from "../domain/text-safety.ts";
import { redactCompleteSensitiveText } from "../sensitive-text.ts";
import { DevinError } from "./errors.ts";
import { DEVIN_ACP_PROTOCOL_VERSION } from "./pin.ts";

type UnknownRecord = Record<string, unknown>;

export const DEVIN_ACP_MAX_FRAME_BYTES = 1024 * 1024;
export const DEVIN_ACP_MAX_PROMPT_BYTES = 256 * 1024;

export type DevinToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type DevinToolStatus = "pending" | "in_progress" | "completed" | "failed";
export type DevinStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";
export type DevinPlanPriority = "high" | "medium" | "low";
export type DevinPlanStatus = "pending" | "in_progress" | "completed";
export type DevinPermissionKind =
  | "allow_once"
  | "allow_always"
  | "reject_once"
  | "reject_always";

export interface DevinPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: DevinPermissionKind;
}

export type DevinPermissionOutcome =
  | Readonly<{ outcome: "cancelled" }>
  | Readonly<{ outcome: "selected"; optionId: string }>;

export type DevinFact =
  | Readonly<{
      type: "assistantDelta";
      sessionId: string;
      messageId: string | null;
      text: string;
    }>
  | Readonly<{
      type: "toolCall";
      sessionId: string;
      toolCallId: string;
      title: string;
      kind: DevinToolKind | null;
      status: DevinToolStatus | null;
    }>
  | Readonly<{
      type: "toolCallUpdate";
      sessionId: string;
      toolCallId: string;
      title: string | null;
      kind: DevinToolKind | null;
      status: DevinToolStatus | null;
    }>
  | Readonly<{
      type: "plan";
      sessionId: string;
      entries: readonly Readonly<{
        content: string;
        priority: DevinPlanPriority;
        status: DevinPlanStatus;
      }>[];
    }>
  | Readonly<{
      type: "permissionRequested";
      requestId: string;
      sessionId: string;
      toolCall: Readonly<{
        toolCallId: string;
        title: string | null;
        kind: DevinToolKind | null;
        status: DevinToolStatus | null;
      }>;
      options: readonly DevinPermissionOption[];
    }>
  | Readonly<{
      type: "usageUpdated";
      sessionId: string;
      /** Current context occupancy; never an account allowance or reset window. */
      used: number;
      size: number;
      /** Cumulative session cost when Devin supplies it. */
      cost: Readonly<{ amount: number; currency: string }> | null;
    }>
  | Readonly<{
      type: "providerError";
      sessionId: string | null;
      requestMethod: string;
      code: number;
      message: string;
      terminal: boolean;
    }>
  | Readonly<{
      type: "turnStopped";
      sessionId: string;
      stopReason: DevinStopReason;
    }>
  | Readonly<{
      type: "protocolNotice";
      sessionId: string | null;
      method: string;
      disposition: "unknown_notification" | "unprojected_update" | "unsupported_request";
    }>;

export interface DevinInitialization {
  readonly protocolVersion: typeof DEVIN_ACP_PROTOCOL_VERSION;
  readonly loadSession: boolean;
}

export type DevinInboundMessage =
  | Readonly<{
      kind: "request";
      id: string | number;
      method: string;
      params: unknown;
    }>
  | Readonly<{
      kind: "notification";
      method: string;
      params: unknown;
    }>
  | Readonly<{
      kind: "response";
      id: string | number;
      result: unknown;
    }>
  | Readonly<{
      kind: "errorResponse";
      id: string | number;
      error: Readonly<{ code: number; message: string }>;
    }>;

const protocol = (message: string): DevinError => new DevinError("PROTOCOL_ERROR", message);
const limit = (message: string): DevinError => new DevinError("PROTOCOL_LIMIT", message);

const record = (value: unknown, label: string): UnknownRecord => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw protocol(`${label} must be an object`);
  }
  return value as UnknownRecord;
};

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

const boundedString = (
  value: unknown,
  label: string,
  maximumBytes: number,
  minimumBytes = 0,
): string => {
  if (typeof value !== "string") throw protocol(`${label} must be a string`);
  const bytes = utf8Bytes(value);
  if (bytes < minimumBytes || bytes > maximumBytes) {
    throw limit(`${label} is outside its byte limit`);
  }
  return value;
};

const identifier = (value: unknown, label: string): string => {
  const result = boundedString(value, label, 256, 1);
  if (/\p{C}/u.test(result)) throw protocol(`${label} contains an unsafe scalar`);
  return result;
};

const optionalIdentifier = (value: unknown, label: string): string | null =>
  value === undefined || value === null ? null : identifier(value, label);

const array = (value: unknown, label: string, maximum: number): readonly unknown[] => {
  if (!Array.isArray(value)) throw protocol(`${label} must be an array`);
  if (value.length > maximum) throw limit(`${label} exceeded its item limit`);
  return value;
};

const finiteInteger = (
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number => {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw protocol(`${label} must be a bounded safe integer`);
  }
  return value;
};

const finiteNumber = (value: unknown, label: string, maximum: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw protocol(`${label} must be a bounded non-negative number`);
  }
  return value;
};

const unsafeScalar = /[\p{Cc}\p{Cf}\p{Cs}]/u;
export const sanitizeDevinText = (input: string, preserveLineFeeds = false): string => {
  const pathReduced = redactAbsolutePaths(input);
  const protectedInput = redactCompleteSensitiveText(pathReduced, "[protected]");
  let output = "";
  for (const scalar of protectedInput) {
    output += scalar === "\n" && preserveLineFeeds
      ? scalar
      : unsafeScalar.test(scalar)
        ? "�"
        : scalar;
  }
  return output;
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  if (utf8Bytes(value) <= maximumBytes) return value;
  let output = "";
  let used = 0;
  for (const scalar of value) {
    const bytes = utf8Bytes(scalar);
    if (used + bytes > maximumBytes) break;
    output += scalar;
    used += bytes;
  }
  return output;
};

const displayText = (
  value: unknown,
  label: string,
  maximumBytes = 16 * 1024,
  preserveLineFeeds = false,
): string => truncateUtf8(
  sanitizeDevinText(
    boundedString(value, label, maximumBytes),
    preserveLineFeeds,
  ),
  maximumBytes,
);

const oneOf = <const Values extends readonly string[]>(
  value: unknown,
  label: string,
  values: Values,
): Values[number] => {
  if (typeof value !== "string" || !values.includes(value)) {
    throw protocol(`${label} is unsupported`);
  }
  return value;
};

const TOOL_KINDS = [
  "read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other",
] as const;
const TOOL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;
const STOP_REASONS = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const;
const PLAN_PRIORITIES = ["high", "medium", "low"] as const;
const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
const PERMISSION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const;

const optionalToolKind = (value: unknown, label: string): DevinToolKind | null =>
  value === undefined || value === null ? null : oneOf(value, label, TOOL_KINDS);
const optionalToolStatus = (value: unknown, label: string): DevinToolStatus | null =>
  value === undefined || value === null ? null : oneOf(value, label, TOOL_STATUSES);

const validateOptionalCollection = (value: unknown, label: string): void => {
  if (value === undefined || value === null) return;
  for (const [index, entry] of array(value, label, 64).entries()) {
    const item = record(entry, `${label}[${index}]`);
    boundedString(item.type, `${label}[${index}].type`, 64, 1);
  }
};

const parseToolCallUpdate = (value: unknown, label: string): Readonly<{
  toolCallId: string;
  title: string | null;
  kind: DevinToolKind | null;
  status: DevinToolStatus | null;
}> => {
  const update = record(value, label);
  const title = update.title === undefined || update.title === null
    ? null
    : displayText(update.title, `${label}.title`, 4 * 1024);
  if (update.name !== undefined && update.name !== null) {
    boundedString(update.name, `${label}.name`, 256, 1);
  }
  validateOptionalCollection(update.content, `${label}.content`);
  if (update.locations !== undefined && update.locations !== null) {
    for (const [index, location] of array(update.locations, `${label}.locations`, 64).entries()) {
      const locationRecord = record(location, `${label}.locations[${index}]`);
      boundedString(locationRecord.path, `${label}.locations[${index}].path`, 4 * 1024, 1);
      if (locationRecord.line !== undefined && locationRecord.line !== null) {
        finiteInteger(locationRecord.line, `${label}.locations[${index}].line`, 1, 10_000_000);
      }
    }
  }
  return {
    kind: optionalToolKind(update.kind, `${label}.kind`),
    status: optionalToolStatus(update.status, `${label}.status`),
    title,
    toolCallId: identifier(update.toolCallId, `${label}.toolCallId`),
  };
};

export function devinRequestKey(id: string | number): string {
  if (typeof id === "number") {
    finiteInteger(id, "JSON-RPC request id", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    return `n:${id}`;
  }
  return `s:${identifier(id, "JSON-RPC request id")}`;
}

export function parseDevinInboundMessage(value: unknown): DevinInboundMessage {
  if (Array.isArray(value)) throw protocol("ACP v1 does not admit JSON-RPC batches");
  const message = record(value, "ACP frame");
  if (message.jsonrpc !== "2.0") throw protocol("ACP frame has an invalid JSON-RPC version");
  const hasMethod = Object.hasOwn(message, "method");
  const hasId = Object.hasOwn(message, "id");
  const hasResult = Object.hasOwn(message, "result");
  const hasError = Object.hasOwn(message, "error");
  if (hasMethod) {
    const method = identifier(message.method, "ACP method");
    if (hasResult || hasError) throw protocol("ACP call cannot contain a response payload");
    if (!hasId) return { kind: "notification", method, params: message.params };
    if (message.id === null) throw protocol("ACP request id cannot be null");
    const id = typeof message.id === "string"
      ? identifier(message.id, "ACP request id")
      : finiteInteger(message.id, "ACP request id", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
    return { id, kind: "request", method, params: message.params };
  }
  if (!hasId || hasResult === hasError || message.id === null) {
    throw protocol("ACP response envelope is malformed");
  }
  const id = typeof message.id === "string"
    ? identifier(message.id, "ACP response id")
    : finiteInteger(message.id, "ACP response id", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  if (hasResult) return { id, kind: "response", result: message.result };
  const error = record(message.error, "ACP error");
  const code = finiteInteger(error.code, "ACP error.code", -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  const errorMessage = displayText(error.message, "ACP error.message", 4 * 1024);
  return { error: { code, message: errorMessage }, id, kind: "errorResponse" };
}

export function parseDevinInitializeResponse(value: unknown): DevinInitialization {
  const response = record(value, "initialize result");
  if (response.protocolVersion !== DEVIN_ACP_PROTOCOL_VERSION) {
    throw new DevinError("RUNTIME_MISMATCH", "Devin does not support the required ACP v1 protocol");
  }
  let loadSession = false;
  if (response.agentCapabilities !== undefined) {
    const capabilities = record(response.agentCapabilities, "initialize.agentCapabilities");
    if (capabilities.loadSession !== undefined && typeof capabilities.loadSession !== "boolean") {
      throw protocol("initialize.agentCapabilities.loadSession must be a boolean");
    }
    loadSession = capabilities.loadSession === true;
  }
  if (response.authMethods !== undefined) {
    for (const [index, method] of array(response.authMethods, "initialize.authMethods", 16).entries()) {
      const methodRecord = record(method, `initialize.authMethods[${index}]`);
      identifier(methodRecord.id, `initialize.authMethods[${index}].id`);
      displayText(methodRecord.name, `initialize.authMethods[${index}].name`, 256);
    }
  }
  return { loadSession, protocolVersion: DEVIN_ACP_PROTOCOL_VERSION };
}

export function parseDevinNewSessionResponse(value: unknown): string {
  return identifier(record(value, "session/new result").sessionId, "session/new result.sessionId");
}

export function parseDevinLoadSessionResponse(value: unknown): void {
  record(value, "session/load result");
}

export function parseDevinPromptResponse(value: unknown): DevinStopReason {
  return oneOf(record(value, "session/prompt result").stopReason, "session/prompt stop reason", STOP_REASONS);
}

export function parseDevinSessionUpdate(value: unknown): readonly DevinFact[] {
  const params = record(value, "session/update params");
  const sessionId = identifier(params.sessionId, "session/update sessionId");
  const update = record(params.update, "session/update update");
  const updateType = identifier(update.sessionUpdate, "session/update type");
  if (updateType === "agent_thought_chunk") {
    // ACP does not identify thought chunks as disclosure-safe summaries. Keep
    // their existence observable without reading or projecting their content.
    return [{
      disposition: "unprojected_update",
      method: "session/update:agent_thought_chunk",
      sessionId,
      type: "protocolNotice",
    }];
  }
  if (updateType === "agent_message_chunk") {
    const content = record(update.content, "session/update agent_message_chunk.content");
    const contentType = identifier(content.type, "session/update agent_message_chunk.content.type");
    const messageId = optionalIdentifier(update.messageId, "session/update agent_message_chunk.messageId");
    if (contentType !== "text") {
      return [{
        disposition: "unprojected_update",
        method: `session/update:agent_message_chunk:${contentType}`,
        sessionId,
        type: "protocolNotice",
      }];
    }
    const text = displayText(
      content.text,
      "session/update agent_message_chunk.content.text",
      64 * 1024,
      true,
    );
    return [{
      messageId,
      sessionId,
      text,
      type: "assistantDelta",
    }];
  }
  if (updateType === "tool_call") {
    const parsed = parseToolCallUpdate(update, "session/update tool_call");
    if (parsed.title === null) throw protocol("session/update tool_call.title is required");
    return [{
      kind: parsed.kind,
      sessionId,
      status: parsed.status,
      title: parsed.title,
      toolCallId: parsed.toolCallId,
      type: "toolCall",
    }];
  }
  if (updateType === "tool_call_update") {
    const parsed = parseToolCallUpdate(update, "session/update tool_call_update");
    return [{ ...parsed, sessionId, type: "toolCallUpdate" }];
  }
  if (updateType === "plan") {
    const entries = array(update.entries, "session/update plan.entries", 128).map((entry, index) => {
      const item = record(entry, `session/update plan.entries[${index}]`);
      return {
        content: displayText(item.content, `session/update plan.entries[${index}].content`, 8 * 1024),
        priority: oneOf(item.priority, `session/update plan.entries[${index}].priority`, PLAN_PRIORITIES),
        status: oneOf(item.status, `session/update plan.entries[${index}].status`, PLAN_STATUSES),
      };
    });
    return [{ entries, sessionId, type: "plan" }];
  }
  if (updateType === "usage_update") {
    const used = finiteInteger(update.used, "session/update usage.used", 0, Number.MAX_SAFE_INTEGER);
    // ACP v1 defines both fields as independent uint64 values. In particular,
    // zero is valid and the schema does not require `used <= size`.
    const size = finiteInteger(update.size, "session/update usage.size", 0, Number.MAX_SAFE_INTEGER);
    let cost: Readonly<{ amount: number; currency: string }> | null = null;
    if (update.cost !== undefined && update.cost !== null) {
      const input = record(update.cost, "session/update usage.cost");
      const currency = boundedString(input.currency, "session/update usage.cost.currency", 3, 3);
      if (!/^[A-Z]{3}$/u.test(currency)) throw protocol("session/update cost currency is invalid");
      cost = {
        amount: finiteNumber(input.amount, "session/update usage.cost.amount", 1_000_000_000),
        currency,
      };
    }
    return [{ cost, sessionId, size, type: "usageUpdated", used }];
  }
  // ACP adds update variants compatibly. Keeping the bounded discriminator is
  // sufficient for a notice; no vendor body crosses the provider seam.
  return [{
    disposition: "unprojected_update",
    method: `session/update:${updateType}`,
    sessionId,
    type: "protocolNotice",
  }];
}

export function parseDevinPermissionRequest(
  requestId: string | number,
  value: unknown,
): Extract<DevinFact, { type: "permissionRequested" }> {
  const params = record(value, "session/request_permission params");
  const toolCall = parseToolCallUpdate(params.toolCall, "session/request_permission toolCall");
  const options = array(params.options, "session/request_permission options", 16).map((entry, index) => {
    const option = record(entry, `session/request_permission options[${index}]`);
    return {
      kind: oneOf(option.kind, `session/request_permission options[${index}].kind`, PERMISSION_KINDS),
      name: displayText(option.name, `session/request_permission options[${index}].name`, 256),
      optionId: identifier(option.optionId, `session/request_permission options[${index}].optionId`),
    };
  });
  if (options.length === 0) throw protocol("session/request_permission options must not be empty");
  if (new Set(options.map((option) => option.optionId)).size !== options.length) {
    throw protocol("session/request_permission option ids must be unique");
  }
  return {
    options,
    requestId: devinRequestKey(requestId),
    sessionId: identifier(params.sessionId, "session/request_permission sessionId"),
    toolCall,
    type: "permissionRequested",
  };
}

export function validateDevinPermissionOutcome(
  value: unknown,
  options: readonly DevinPermissionOption[],
): DevinPermissionOutcome {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DevinError("INVALID_INPUT", "permission outcome must be an object");
  }
  const outcome = value as UnknownRecord;
  if (outcome.outcome === "cancelled") return { outcome: "cancelled" };
  if (outcome.outcome !== "selected") {
    throw new DevinError("INVALID_INPUT", "permission outcome is unsupported");
  }
  let optionId: string;
  try {
    optionId = identifier(outcome.optionId, "permission outcome optionId");
  } catch {
    throw new DevinError("INVALID_INPUT", "permission outcome option id is invalid");
  }
  if (!options.some((option) => option.optionId === optionId)) {
    throw new DevinError("INVALID_INPUT", "permission outcome did not select an offered option");
  }
  return { optionId, outcome: "selected" };
}

export function boundedDevinPrompt(value: unknown): string {
  const bytes = typeof value === "string" ? utf8Bytes(value) : 0;
  if (typeof value !== "string" || bytes < 1 || bytes > DEVIN_ACP_MAX_PROMPT_BYTES) {
    throw new DevinError("INVALID_INPUT", "Devin prompt is outside its byte limit");
  }
  return value;
}

export function boundedDevinSessionId(value: unknown): string {
  if (
    typeof value !== "string"
    || utf8Bytes(value) < 1
    || utf8Bytes(value) > 256
    || /\p{C}/u.test(value)
  ) {
    throw new DevinError("INVALID_INPUT", "Devin session id is invalid");
  }
  return value;
}

export function boundedDevinRequestKey(value: unknown): string {
  if (
    typeof value !== "string"
    || utf8Bytes(value) < 1
    || utf8Bytes(value) > 260
    || /\p{C}/u.test(value)
  ) {
    throw new DevinError("INVALID_INPUT", "Devin permission request key is invalid");
  }
  return value;
}

export function boundedDevinCwd(value: unknown): string {
  if (
    typeof value !== "string"
    || utf8Bytes(value) < 1
    || utf8Bytes(value) > 4 * 1024
    || value.includes("\0")
  ) {
    throw new DevinError("INVALID_INPUT", "Devin session cwd is invalid");
  }
  return value;
}
