import type { CanonicalAuthEmail } from "../src/cloud/authCredentials";
import { isCanonicalAuthEmail } from "../src/cloud/authCredentials";
import {
  hasExactKeys,
  isOpaqueIdentifier,
  isRecord,
  snapshotForeignJson,
} from "../src/cloud/contracts";
import type { InteractionKind } from "../src/domain/interactions";
import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
  requireOompaAttentionResendApiKey,
} from "./resendApiKey";

/*
 * Body versions 1 and 2 retain their HRA-era and oompa.dev wire vocabulary;
 * version 3 uses oompa.app. Each version binds its sender, subject, review line
 * and session URL so an effect-started outbox row retries byte-identically.
 */
export const attentionEmailFromV1 = "HRA attention <notifications@news.hraness.com>" as const;
export const attentionEmailSubjectV1 = "HRA needs your attention" as const;
export const oompaAttentionEmailFrom =
  "Oompa attention <notifications@news.hraness.com>" as const;
export const oompaAttentionEmailSubject = "Oompa needs your attention" as const;
export const oompaAttentionEmailEndpoint = "https://api.resend.com/emails" as const;
export const oompaAttentionEmailUserAgent = "oompa-attention-email/1" as const;
export const oompaAttentionEmailDeliveryTimeoutMs = 8_000;

const attentionEmailBodyV1Version = 1 as const;
const attentionEmailBodyV2Version = 2 as const;
const attentionEmailBodyV3Version = 3 as const;
export type AttentionEmailBodyVersion = typeof attentionEmailBodyV1Version | typeof attentionEmailBodyV2Version
  | typeof attentionEmailBodyV3Version;
const attentionEmailBodyV1MaximumBodyBytes = 8 * 1_024;
const attentionEmailBodyV1MaximumItems = 8;
const attentionEmailBodyV1SubjectLine = attentionEmailSubjectV1;

export const oompaAttentionEmailMaximumBodyBytes = attentionEmailBodyV1MaximumBodyBytes;
export const oompaAttentionEmailMaximumItems = attentionEmailBodyV1MaximumItems;
export const oompaAttentionEmailBodyVersion = attentionEmailBodyV3Version;

const maximumProviderResponseBytes = 4 * 1_024;
const maximumProviderMessageIdCharacters = 256;
const maximumProviderErrorMessageCharacters = 4_096;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const providerMessageIdPattern = /^[A-Za-z0-9_-]+$/u;
const idempotencyKeyPattern = /^[!-~]+$/u;

/*
 * This is the immutable v1 wire-body vocabulary. A later presentation change
 * must add a body version rather than changing these strings, because an
 * effect-started outbox row must remain byte-identical across every retry.
 */
const attentionEmailBodyV1InteractionKindLabels = Object.freeze({
  command_approval: "Command approval",
  file_change_approval: "File change approval",
  mcp_elicitation: "MCP elicitation",
  permission_approval: "Permission approval",
  user_input: "User input",
} satisfies Readonly<Record<InteractionKind, string>>);
const attentionEmailBodyV1ReviewLine = "Open HRA to review:" as const;
const attentionEmailBodyV1SessionUrl = "https://app.hra.sh/#/session/" as const;

type AttentionEmailBodyGrammar = Readonly<{
  from: typeof attentionEmailFromV1 | typeof oompaAttentionEmailFrom;
  reviewLine: string;
  sessionUrl: string;
  subject: typeof attentionEmailSubjectV1 | typeof oompaAttentionEmailSubject;
  subjectLine: string;
}>;

const attentionEmailBodyGrammars: Readonly<Record<AttentionEmailBodyVersion, AttentionEmailBodyGrammar>> =
  Object.freeze({
    [attentionEmailBodyV1Version]: Object.freeze({
      from: attentionEmailFromV1,
      reviewLine: attentionEmailBodyV1ReviewLine,
      sessionUrl: attentionEmailBodyV1SessionUrl,
      subject: attentionEmailSubjectV1,
      subjectLine: attentionEmailBodyV1SubjectLine,
    }),
    [attentionEmailBodyV2Version]: Object.freeze({
      from: oompaAttentionEmailFrom,
      reviewLine: "Open Oompa to review:",
      sessionUrl: "https://app.oompa.dev/#/session/",
      subject: oompaAttentionEmailSubject,
      subjectLine: oompaAttentionEmailSubject,
    }),
    [attentionEmailBodyV3Version]: Object.freeze({
      from: oompaAttentionEmailFrom,
      reviewLine: "Open Oompa to review:",
      sessionUrl: "https://app.oompa.app/#/session/",
      subject: oompaAttentionEmailSubject,
      subjectLine: oompaAttentionEmailSubject,
    }),
  });

function isAttentionEmailBodyVersion(value: unknown): value is AttentionEmailBodyVersion {
  return value === attentionEmailBodyV1Version || value === attentionEmailBodyV2Version
    || value === attentionEmailBodyV3Version;
}

const interactionKinds = new Set<InteractionKind>(
  Object.keys(attentionEmailBodyV1InteractionKindLabels) as InteractionKind[],
);
const interactionKindLabelV1Values = new Set<string>(
  Object.values(attentionEmailBodyV1InteractionKindLabels),
);

export type OompaAttentionEmailRefusalType =
  | "invalid_access"
  | "invalid_api_key"
  | "invalid_attachment"
  | "invalid_from_address"
  | "invalid_idempotency_key"
  | "invalid_parameter"
  | "invalid_region"
  | "method_not_allowed"
  | "missing_api_key"
  | "missing_required_field"
  | "not_found"
  | "restricted_api_key"
  | "validation_error";

const documentedNoEffectPairs = new Map<number, ReadonlySet<OompaAttentionEmailRefusalType>>([
  [400, new Set(["invalid_idempotency_key", "validation_error"])],
  [401, new Set(["missing_api_key", "restricted_api_key"])],
  [403, new Set([
    "invalid_api_key",
    "validation_error",
  ])],
  [404, new Set(["not_found"])],
  [405, new Set(["method_not_allowed"])],
  [422, new Set([
    "invalid_access",
    "invalid_attachment",
    "invalid_from_address",
    "invalid_parameter",
    "invalid_region",
    "missing_required_field",
  ])],
]);

export type OompaAttentionEmailItem = Readonly<{
  interactionKind: InteractionKind;
  sessionPublicId: string;
}>;

export type OompaAttentionEmailBody = Readonly<{
  text: string;
  version: AttentionEmailBodyVersion;
}>;

export type OompaAttentionEmailPayload = Readonly<{
  from: AttentionEmailBodyGrammar["from"];
  subject: AttentionEmailBodyGrammar["subject"];
  text: string;
  to: readonly [CanonicalAuthEmail];
}>;

export type OompaAttentionEmailResult =
  | Readonly<{
      kind: "accepted";
      providerMessageId: string;
    }>
  | Readonly<{
      kind: "refused";
      providerErrorType: OompaAttentionEmailRefusalType;
      status: number;
    }>
  | Readonly<{
      kind: "ambiguous";
      providerErrorType: "invalid_idempotent_request";
      safetyFault: true;
      status: 409;
    }>
  | Readonly<{
      kind: "retryable";
      reason:
        | "concurrent_idempotency"
        | "malformed_success"
        | "network"
        | "timeout"
        | "transient_http"
        | "unknown_or_incoherent_response";
    }>;

export type OompaAttentionEmailFetch = (
  resource: string,
  init: RequestInit,
) => Promise<Response>;

const retryable = (
  reason: Extract<OompaAttentionEmailResult, { kind: "retryable" }>["reason"],
): OompaAttentionEmailResult => Object.freeze({ kind: "retryable", reason });

function requireAttentionEmailItem(value: unknown): OompaAttentionEmailItem {
  const snapshot = snapshotForeignJson(value);
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !hasExactKeys(snapshot.value, ["interactionKind", "sessionPublicId"])
    || typeof snapshot.value.interactionKind !== "string"
    || !interactionKinds.has(snapshot.value.interactionKind as InteractionKind)
    || !isOpaqueIdentifier(snapshot.value.sessionPublicId)
  ) throw new Error("Attention email delivery is unavailable.");
  return {
    interactionKind: snapshot.value.interactionKind as InteractionKind,
    sessionPublicId: snapshot.value.sessionPublicId,
  };
}

function requireAttentionEmailIdempotencyKey(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > 256
    || !idempotencyKeyPattern.test(value)
  ) throw new Error("Attention email delivery is unavailable.");
  return value;
}

export function buildOompaAttentionEmailBody(
  input: readonly OompaAttentionEmailItem[],
  version: AttentionEmailBodyVersion = oompaAttentionEmailBodyVersion,
): OompaAttentionEmailBody {
  if (
    !Array.isArray(input)
    || input.length < 1
    || input.length > attentionEmailBodyV1MaximumItems
  ) throw new Error("Attention email delivery is unavailable.");

  if (!isAttentionEmailBodyVersion(version)) throw new Error("Attention email delivery is unavailable.");
  const grammar = attentionEmailBodyGrammars[version];
  const items = input.map(requireAttentionEmailItem);
  const text = [
    grammar.subjectLine,
    "",
    grammar.reviewLine,
    ...items.map((item) =>
      `- ${attentionEmailBodyV1InteractionKindLabels[item.interactionKind]}: ${grammar.sessionUrl}${item.sessionPublicId}`),
  ].join("\n");
  if (utf8Encoder.encode(text).byteLength > attentionEmailBodyV1MaximumBodyBytes) {
    throw new Error("Attention email delivery is unavailable.");
  }

  return Object.freeze({ text, version });
}

function isAttentionEmailBodyText(text: string, version: AttentionEmailBodyVersion): boolean {
  const grammar = attentionEmailBodyGrammars[version];
  if (utf8Encoder.encode(text).byteLength > attentionEmailBodyV1MaximumBodyBytes) return false;
  const lines = text.split("\n");
  if (
    lines.length < 4
    || lines.length > 3 + attentionEmailBodyV1MaximumItems
    || lines[0] !== grammar.subjectLine
    || lines[1] !== ""
    || lines[2] !== grammar.reviewLine
  ) return false;

  return lines.slice(3).every((line) => {
    if (!line.startsWith("- ")) return false;
    const marker = `: ${grammar.sessionUrl}`;
    const markerIndex = line.indexOf(marker, 2);
    if (markerIndex < 3 || line.indexOf(marker, markerIndex + marker.length) !== -1) return false;
    const label = line.slice(2, markerIndex);
    const sessionId = line.slice(markerIndex + marker.length);
    return interactionKindLabelV1Values.has(label) && isOpaqueIdentifier(sessionId);
  });
}

/**
 * Revalidates the versioned body stored by the hosted claim. Every version is
 * a fixed grammar so a later template version cannot rewrite an in-flight effect.
 */
export function parseOompaAttentionEmailBody(value: unknown): OompaAttentionEmailBody | null {
  const snapshot = snapshotForeignJson(value);
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !hasExactKeys(snapshot.value, ["text", "version"])
    || !isAttentionEmailBodyVersion(snapshot.value.version)
    || typeof snapshot.value.text !== "string"
    || !isAttentionEmailBodyText(snapshot.value.text, snapshot.value.version)
  ) return null;
  return Object.freeze({
    text: snapshot.value.text,
    version: snapshot.value.version,
  });
}

export function buildOompaAttentionEmailPayload(input: Readonly<{
  body: OompaAttentionEmailBody;
  recipient: CanonicalAuthEmail;
}>): OompaAttentionEmailPayload {
  const body = parseOompaAttentionEmailBody(input.body);
  if (body === null || !isCanonicalAuthEmail(input.recipient)) {
    throw new Error("Attention email delivery is unavailable.");
  }

  const grammar = attentionEmailBodyGrammars[body.version];
  return Object.freeze({
    from: grammar.from,
    subject: grammar.subject,
    text: body.text,
    to: Object.freeze([input.recipient] as const),
  });
}

function strictProviderError(
  body: unknown,
  status: number,
): Readonly<{ name: string }> | null {
  const snapshot = snapshotForeignJson(body);
  if (
    !snapshot.ok
    || !isRecord(snapshot.value)
    || !hasExactKeys(snapshot.value, ["message", "name", "statusCode"])
    || typeof snapshot.value.name !== "string"
    || snapshot.value.name.length < 1
    || snapshot.value.name.length > 128
    || !/^[a-z][a-z0-9_]*$/u.test(snapshot.value.name)
    || typeof snapshot.value.message !== "string"
    || snapshot.value.message.length < 1
    || snapshot.value.message.length > maximumProviderErrorMessageCharacters
    || snapshot.value.statusCode !== status
  ) return null;
  return { name: snapshot.value.name };
}

export function isOompaAttentionEmailDocumentedRefusal(
  status: number,
  name: string,
): name is OompaAttentionEmailRefusalType {
  return documentedNoEffectPairs.get(status)?.has(name as OompaAttentionEmailRefusalType) === true;
}

export function classifyOompaAttentionEmailResponse(input: Readonly<{
  body: unknown;
  status: number;
}>): OompaAttentionEmailResult {
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599) {
    return retryable("unknown_or_incoherent_response");
  }

  if (input.status >= 200 && input.status < 300) {
    const snapshot = snapshotForeignJson(input.body);
    if (
      snapshot.ok
      && isRecord(snapshot.value)
      && hasExactKeys(snapshot.value, ["id"])
      && typeof snapshot.value.id === "string"
      && snapshot.value.id.length >= 1
      && snapshot.value.id.length <= maximumProviderMessageIdCharacters
      && providerMessageIdPattern.test(snapshot.value.id)
    ) {
      return Object.freeze({
        kind: "accepted",
        providerMessageId: snapshot.value.id,
      });
    }
    return retryable("malformed_success");
  }

  if (
    input.status === 408
    || input.status === 429
    || input.status >= 500
  ) return retryable("transient_http");

  const error = strictProviderError(input.body, input.status);
  if (input.status === 409 && error?.name === "invalid_idempotent_request") {
    return Object.freeze({
      kind: "ambiguous",
      providerErrorType: "invalid_idempotent_request",
      safetyFault: true,
      status: 409,
    });
  }
  if (input.status === 409 && error?.name === "concurrent_idempotent_requests") {
    return retryable("concurrent_idempotency");
  }
  if (error !== null && isOompaAttentionEmailDocumentedRefusal(input.status, error.name)) {
    return Object.freeze({
      kind: "refused",
      providerErrorType: error.name,
      status: input.status,
    });
  }
  return retryable("unknown_or_incoherent_response");
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type");
  if (
    contentType === null
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const declared = response.headers.get("content-length");
  if (
    declared !== null
    && (!/^[0-9]{1,15}$/u.test(declared) || Number(declared) > maximumProviderResponseBytes)
  ) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumProviderResponseBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(utf8Decoder.decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

type OompaAttentionEmailInput = Readonly<{
  body: OompaAttentionEmailBody;
  idempotencyKey: string;
  recipient: CanonicalAuthEmail;
}>;

type OompaAttentionEmailOptions = Readonly<{
  environment?: Readonly<Record<string, string | undefined>>;
  fetch?: OompaAttentionEmailFetch;
}>;

/** Validate and retain one credential snapshot before a drain claims an effect. */
export function createOompaAttentionEmailSender(
  options: OompaAttentionEmailOptions = {},
): (input: OompaAttentionEmailInput) => Promise<OompaAttentionEmailResult> {
  const source = options.environment ?? process.env;
  const environment = Object.freeze({
    [oompaAttentionResendApiKeyEnvironmentName]: source[oompaAttentionResendApiKeyEnvironmentName],
    [oompaResendApiKeyEnvironmentName]: source[oompaResendApiKeyEnvironmentName],
  });
  requireOompaAttentionResendApiKey(environment);
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return async (input) => await sendOompaAttentionEmail(input, {
    environment,
    fetch: fetchImplementation,
  });
}

export async function sendOompaAttentionEmail(
  input: OompaAttentionEmailInput,
  options: OompaAttentionEmailOptions = {},
): Promise<OompaAttentionEmailResult> {
  const payload = buildOompaAttentionEmailPayload(input);
  const idempotencyKey = requireAttentionEmailIdempotencyKey(input.idempotencyKey);
  const apiKey = requireOompaAttentionResendApiKey(options.environment);
  const fetchImplementation: OompaAttentionEmailFetch = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutError = new Error("Attention email delivery timed out.");
  let rejectDeadline!: (error: Error) => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });
  const timeout = setTimeout(() => {
    rejectDeadline(timeoutError);
    controller.abort(timeoutError);
  }, oompaAttentionEmailDeliveryTimeoutMs);

  try {
    const request = fetchImplementation(oompaAttentionEmailEndpoint, {
      body: JSON.stringify(payload),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "User-Agent": oompaAttentionEmailUserAgent,
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    }).then(async (response) => classifyOompaAttentionEmailResponse({
      body: await readBoundedJson(response),
      status: response.status,
    }));
    return await Promise.race([request, deadline]);
  } catch (error: unknown) {
    return retryable(error === timeoutError ? "timeout" : "network");
  } finally {
    clearTimeout(timeout);
  }
}
