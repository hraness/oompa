import { createHmac, randomBytes } from "node:crypto";

import { z } from "zod";

import {
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
} from "./domain/text-safety";
import {
  redactCompleteSensitiveText,
} from "./sensitive-text";

const rawProviderIdentifierSchema = z.string().min(1).max(512);
const publicProviderIdentifierPattern = /^opaque_v2_[a-f0-9]{64}$/u;
const publicProviderIdentifierDigestDomain = "hra:public-provider-identifier:v2\0";
const publicProviderIdentifierKeyBytes = 32;

export const PUBLIC_MCP_FORM_SUMMARY = "Codex requests MCP form input";

export const isPublicProviderIdentifier = (value: string): boolean =>
  publicProviderIdentifierPattern.test(value)
  && !containsAbsolutePath(value)
  && !containsUnsafeTerminalScalar(value)
  && redactCompleteSensitiveText(value, "[protected]") === value;

export const publicProviderIdentifierSchema = z.string()
  .length(74)
  .refine(isPublicProviderIdentifier, {
    message: "Provider identifier is not safe for a public boundary",
  });

export type PublicProviderIdentifier = z.infer<
  typeof publicProviderIdentifierSchema
>;

export type PublicProviderIdentifierProjector = (
  value: string,
) => PublicProviderIdentifier;

const losslessUtf16 = (value: string): Buffer => {
  const encoded = Buffer.allocUnsafe(4 + value.length * 2);
  encoded.writeUInt32BE(value.length, 0);
  for (let index = 0; index < value.length; index += 1) {
    encoded.writeUInt16BE(value.charCodeAt(index), 4 + index * 2);
  }
  return encoded;
};

export const createEphemeralPublicProviderIdentifierProjector = (
): PublicProviderIdentifierProjector => {
  const key = randomBytes(publicProviderIdentifierKeyBytes);
  return (value) => projectPublicProviderIdentifier(value, key);
};

/**
 * Replace every valid raw identifier with a secret-keyed, domain-separated
 * opaque value. Hashing every raw value keeps the public namespace disjoint
 * from provider-controlled input. UTF-16 code units are encoded losslessly so
 * distinct JavaScript strings cannot collapse through UTF-8 replacement.
 */
export const projectPublicProviderIdentifier = (
  value: string,
  key: Uint8Array,
): PublicProviderIdentifier => {
  const raw = rawProviderIdentifierSchema.parse(value);
  const secret = Buffer.from(key);
  if (secret.byteLength !== publicProviderIdentifierKeyBytes) {
    throw new Error("Public provider identifier key must be exactly 32 bytes.");
  }
  return publicProviderIdentifierSchema.parse(
    `opaque_v2_${createHmac("sha256", secret)
      .update(publicProviderIdentifierDigestDomain, "utf8")
      .update(losslessUtf16(raw))
      .digest("hex")}`,
  );
};

/**
 * Upgrade a stored or newly reduced event body at the public boundary. The
 * final event schema remains authoritative for every other field.
 */
export const projectPublicSessionEventBody = (
  value: unknown,
  projector: PublicProviderIdentifierProjector,
): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const body = value as Readonly<Record<string, unknown>>;
  const project = (key: "activeTurnId" | "agentId" | "callId" | "itemId" | "turnId") => {
    const candidate = body[key];
    return candidate === null
      ? null
      : projector(rawProviderIdentifierSchema.parse(candidate));
  };
  /** An absent optional identifier stays absent rather than becoming null. */
  const projectOptional = (key: "callId") =>
    body[key] === undefined ? {} : { [key]: project(key) };
  switch (body.type) {
    case "session_status": return { ...body, activeTurnId: project("activeTurnId") };
    case "turn_started":
    case "turn_completed":
    case "plan_updated":
    case "diff_updated": return { ...body, turnId: project("turnId") };
    case "item_started":
    case "item_completed": return {
      ...body,
      turnId: project("turnId"),
      itemId: project("itemId"),
      ...projectOptional("callId"),
    };
    case "user_message": return { ...body, turnId: project("turnId") };
    case "assistant_delta":
    case "reasoning_summary_delta":
    case "tool_progress":
    case "file_change": return {
      ...body,
      turnId: project("turnId"),
      itemId: project("itemId"),
    };
    case "subagent_activity": return {
      ...body,
      turnId: project("turnId"),
      agentId: project("agentId"),
    };
    case "token_usage": return { ...body, turnId: project("turnId") };
    case "compaction": return { ...body, turnId: project("turnId") };
    case "interaction_requested": return body.interactionKind === "mcp_elicitation"
      ? { ...body, summary: PUBLIC_MCP_FORM_SUMMARY }
      : body;
    default: return body;
  }
};
