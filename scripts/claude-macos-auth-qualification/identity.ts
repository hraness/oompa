import { createHmac } from "node:crypto";
import { z } from "zod";
import type { ClaudeAccountMetadataIdentity } from "../../src/claude/account.ts";
import { parseClaudeAuthStatus } from "../../src/claude/auth.ts";

export class QualificationIdentityError extends Error {
  constructor(readonly code: "invalid_input" | "status_invalid" | "join_unproved" | "metadata_changed" | "identity_missing" | "identity_mismatch") {
    super(`CLAUDE_MACOS_QUALIFICATION_${code}`);
    this.name = "QualificationIdentityError";
  }
}

export type PrivateIdentityObservation = Readonly<{
  runId: string;
  attemptId: string;
  probeId: string;
  profile: "A" | "B";
  profileTag: string;
  signedIn: boolean;
  accountTag: string | null;
  emailTag: string | null;
  organizationTag: string | null;
  evidence: "reported_identity_only";
}>;
const encoder = new TextEncoder();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const invalid = (code: QualificationIdentityError["code"]): never => { throw new QualificationIdentityError(code); };
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const profile = (value: unknown): value is "A" | "B" => value === "A" || value === "B";
export function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

export function qualificationTag(key: Uint8Array, runId: string, purpose: string, value: string): string {
  if (key.byteLength !== 32 || !uuid.test(runId)) return invalid("invalid_input");
  return createHmac("sha256", key).update(JSON.stringify(["claude-macos-auth-v1", runId, purpose, value])).digest("hex");
}

// Normalize only active status scalars here. Metadata arrives already normalized
// through the protected account reader and must satisfy the closed tuple below.
function scalar(value: unknown, email: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return invalid("status_invalid");
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || encoder.encode(normalized).byteLength > 320
    || containsAsciiControl(normalized)
    || (email && !/^[^@\s]+@[^@\s]+$/u.test(normalized))) return invalid("status_invalid");
  return normalized;
}

function parseJson(bytes: Uint8Array, maximum: number): unknown {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 2 || bytes.byteLength > maximum) return invalid("status_invalid");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { return invalid("status_invalid"); }
}

const normalizedScalar = z.string().min(1).refine((value) => value.length <= 320 && value === value.trim().toLowerCase()
  && encoder.encode(value).byteLength <= 320 && !containsAsciiControl(value));
const metadataIdentity = z.strictObject({ accountUuid: normalizedScalar.nullable(),
  email: normalizedScalar.refine((value) => value.length <= 320 && /^[^@\s]+@[^@\s]+$/u.test(value)).nullable(), organizationUuid: normalizedScalar.nullable() }).nullable();

/** Validate and snapshot genuine normalized scalars, without reparsing a document. */
export function capturePrivateClaudeMetadataIdentity(value: unknown): ClaudeAccountMetadataIdentity | null {
  if (ArrayBuffer.isView(value)) return invalid("status_invalid");
  const parsed = metadataIdentity.safeParse(value);
  if (!parsed.success) return invalid("status_invalid");
  return parsed.data === null ? null : Object.freeze(parsed.data);
}

export type QualificationJoinedStatus = Readonly<{ stdout: Uint8Array; stderrBytes: number; exitCode: number;
  joined: boolean; stdoutEof: boolean; stderrEof: boolean; deadlineMs: number; elapsedMs: number }>;
const joinedStatus = z.strictObject({ stdout: z.instanceof(Uint8Array).refine((value) => value.byteLength >= 2 && value.byteLength <= 16 * 1_024),
  stderrBytes: z.number().int().min(0).max(4_096), exitCode: z.union([z.literal(0), z.literal(1)]),
  joined: z.boolean(), stdoutEof: z.boolean(), stderrEof: z.boolean(), deadlineMs: z.number().int().min(3_000).max(5_000), elapsedMs: z.number().int().nonnegative().safe() });

/** Capture only an already-joined bounded observation; this grants no process authority. */
export function captureQualificationJoinedStatus(value: unknown): QualificationJoinedStatus {
  const parsed = joinedStatus.safeParse(value);
  if (!parsed.success) return invalid("status_invalid");
  const status = parsed.data;
  if (!status.joined || !status.stdoutEof || !status.stderrEof || status.elapsedMs >= status.deadlineMs) return invalid("join_unproved");
  return Object.freeze({ ...status, stdout: Uint8Array.from(status.stdout) });
}

/** Consume two genuine normalized tuples around one bounded status; return tags only. */
export function projectPrivateClaudeIdentity(input: Readonly<{
  key: Uint8Array;
  runId: string;
  attemptId: string;
  probeId: string;
  profile: "A" | "B";
  configDir: string;
  before: ClaudeAccountMetadataIdentity | null;
  after: ClaudeAccountMetadataIdentity | null;
  status: QualificationJoinedStatus;
}>): PrivateIdentityObservation {
  if (!uuid.test(input.attemptId) || !uuid.test(input.probeId)
    || !profile(input.profile)) return invalid("invalid_input");
  const status = captureQualificationJoinedStatus(input.status);
  try {
    const document = parseJson(status.stdout, 16 * 1_024);
    let signedIn: boolean;
    try { signedIn = parseClaudeAuthStatus({ configDir: input.configDir, exitCode: status.exitCode, stdout: status.stdout }).signedIn; }
    catch { return invalid("status_invalid"); }
    const before = capturePrivateClaudeMetadataIdentity(input.before);
    const after = capturePrivateClaudeMetadataIdentity(input.after);
    if ((before === null) !== (after === null) || before?.accountUuid !== after?.accountUuid
      || before?.email !== after?.email || before?.organizationUuid !== after?.organizationUuid) return invalid("metadata_changed");
    const base = { runId: input.runId, attemptId: input.attemptId, probeId: input.probeId, profile: input.profile,
      profileTag: qualificationTag(input.key, input.runId, "profile", input.configDir), evidence: "reported_identity_only" as const };
    if (!signedIn) return { ...base, signedIn: false, accountTag: null, emailTag: null, organizationTag: null };
    if (!record(document) || document.authMethod !== "claude.ai" || before === null
      || before.accountUuid === null || before.email === null || before.organizationUuid === null) return invalid("identity_missing");
    const email = scalar(document.email, true);
    const organization = scalar(document.orgId, false);
    if (email === null || organization === null) return invalid("identity_missing");
    if (email !== before.email || organization !== before.organizationUuid) return invalid("identity_mismatch");
    return { ...base, signedIn: true,
      accountTag: qualificationTag(input.key, input.runId, "account", before.accountUuid),
      emailTag: qualificationTag(input.key, input.runId, "email", email),
      organizationTag: qualificationTag(input.key, input.runId, "organization", organization) };
  } finally {
    status.stdout.fill(0);
  }
}
