import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import { readClaudeAuthenticationObservation } from "./auth.ts";
import { ClaudeError } from "./errors.ts";
import type { PinnedClaudeRuntime } from "./runtime.ts";

export type ClaudeConfigurationHome = "isolated" | "personal";

export type ClaudeAccountProjection = Readonly<{
  signedIn: boolean;
  accountId?: string;
  email?: string;
  organizationId?: string;
}>;

export type ClaudeAccountMetadataReader = (path: string) => Promise<unknown>;

export type ClaudeAuthStatusProbe = (input: Readonly<{
  configDir: string;
  configHome: ClaudeConfigurationHome;
  runtime: PinnedClaudeRuntime;
  signal: AbortSignal;
}>) => Promise<unknown>;

const ACCOUNT_DOCUMENT_MAX_BYTES = 128 * 1_024;
const AUTH_STATUS_TIMEOUT_MS = 3_000;
const ACCOUNT_IDENTITY_MAX_BYTES = 320;
const encoder = new TextEncoder();

/** Cached scalar metadata only; this does not establish authentication. */
export type ClaudeAccountMetadataIdentity = Readonly<{
  accountUuid: string | null;
  email: string | null;
  organizationUuid: string | null;
}>;

/**
 * Claude's default home is asymmetric: sessions live in `~/.claude`, while
 * the non-secret account metadata document lives at `~/.claude.json`.
 * Explicit `CLAUDE_CONFIG_DIR` homes place that document inside the selected
 * directory. Keep this distinction closed and testable instead of guessing at
 * call sites.
 */
export function claudeAccountDocumentPath(
  configDir: string,
  configHome: ClaudeConfigurationHome,
): string {
  if (!isAbsolute(configDir)) {
    throw new ClaudeError("INVALID_INPUT", "The Claude configuration home must be absolute.");
  }
  return configHome === "personal"
    ? `${configDir}.json`
    : join(configDir, ".claude.json");
}

/**
 * Reads only normalized identity scalars through the existing bounded,
 * no-follow metadata reader. This is cached metadata, not a signed-in status
 * or credential-principal observation. The underlying document stays private.
 */
export async function readClaudeAccountMetadataIdentity(input: Readonly<{
  configDir: string;
  configHome: ClaudeConfigurationHome;
}>): Promise<ClaudeAccountMetadataIdentity | null> {
  return parseAccountIdentity(await readAccountMetadataDocument(
    claudeAccountDocumentPath(input.configDir, input.configHome),
  ));
}

/**
 * Proves a currently authenticated Claude account without reading a token.
 * `claude auth status --json` supplies current sign-in state; two no-follow
 * reads of the scalar-only account metadata fence an identity change across
 * that status probe. Other first-party authentication modes remain signed in
 * but carry no OAuth identity, so stale metadata cannot grant session authority.
 */
export async function readClaudeAccountProjection(input: Readonly<{
  configDir: string;
  configHome: ClaudeConfigurationHome;
  runtime: PinnedClaudeRuntime;
  signal: AbortSignal;
  readMetadata?: ClaudeAccountMetadataReader;
  probeAuthStatus?: ClaudeAuthStatusProbe;
}>): Promise<ClaudeAccountProjection> {
  input.signal.throwIfAborted();
  const metadataInput = Object.freeze({ configDir: input.configDir, configHome: input.configHome });
  const accountPath = claudeAccountDocumentPath(metadataInput.configDir, metadataInput.configHome);
  const readMetadata = input.readMetadata;
  const readIdentity = readMetadata === undefined
    ? () => readClaudeAccountMetadataIdentity(metadataInput)
    : async () => parseAccountIdentity(await readMetadata(accountPath));
  const probeAuthStatus = input.probeAuthStatus ?? spawnClaudeAuthStatusProbe;
  const before = await readIdentity();
  const status = parseAuthStatus(await probeAuthStatus({
    configDir: metadataInput.configDir,
    configHome: metadataInput.configHome,
    runtime: input.runtime,
    signal: input.signal,
  }));
  input.signal.throwIfAborted();
  const after = await readIdentity();
  if (!sameAccountIdentity(before, after)) {
    throw new ClaudeError(
      "AUTHORITY_STALE",
      "Claude account identity changed during its protected status read.",
    );
  }
  if (!status.signedIn) return Object.freeze({ signedIn: false });
  if (before === null || status.authentication !== "claude_ai") {
    return Object.freeze({ signedIn: true });
  }
  return Object.freeze({
    signedIn: true,
    ...(before.accountUuid === null ? {} : { accountId: before.accountUuid }),
    ...(before.email === null ? {} : { email: before.email }),
    ...(before.organizationUuid === null
      ? {}
      : { organizationId: before.organizationUuid }),
  });
}

export const spawnClaudeAuthStatusProbe: ClaudeAuthStatusProbe = async (input) => {
  const status = await readClaudeAuthenticationObservation({
    ...input,
    deadlineMs: AUTH_STATUS_TIMEOUT_MS,
  });
  return Object.freeze({
    loggedIn: status.signedIn,
    authentication: status.authentication,
  });
};

async function readAccountMetadataDocument(path: string): Promise<unknown> {
  let handle: FileHandle;
  try {
    // The personal-home path is user-controlled and can change between scans.
    // Open nonblocking so a FIFO swapped in before stat cannot stall daemon
    // admission, then keep every byte read beneath the reviewed bound even if
    // a regular file grows after the first descriptor check.
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error: unknown) {
    if (errorCode(error) === "ENOENT") return null;
    throw new ClaudeError("AUTHORITY_STALE", "Claude account metadata was unavailable.", {
      cause: error,
    });
  }
  try {
    const metadata = await handle.stat();
    const uid = process.getuid?.();
    if (
      !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.size < 2
      || metadata.size > ACCOUNT_DOCUMENT_MAX_BYTES
      || (metadata.mode & 0o077) !== 0
      || (uid !== undefined && metadata.uid !== uid)
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude account metadata failed its custody checks.");
    }
    const bytes = new Uint8Array(ACCOUNT_DOCUMENT_MAX_BYTES + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const read = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (read.bytesRead === 0) break;
      filled += read.bytesRead;
    }
    const settled = await handle.stat();
    if (filled > ACCOUNT_DOCUMENT_MAX_BYTES) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude account metadata exceeded its size bound.");
    }
    if (
      settled.dev !== metadata.dev
      || settled.ino !== metadata.ino
      || settled.size !== metadata.size
      || settled.mtimeMs !== metadata.mtimeMs
      || settled.ctimeMs !== metadata.ctimeMs
    ) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        "Claude account metadata changed during its bounded read.",
      );
    }
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, filled)),
      ) as unknown;
    } catch (cause: unknown) {
      throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata was invalid.", { cause });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

const authStatusProjectionSchema = z.object({
  loggedIn: z.boolean(),
  authentication: z.enum(["claude_ai", "other", "none"]),
}).strict().refine((value) => value.loggedIn === (value.authentication !== "none"));

function parseAuthStatus(value: unknown): Readonly<{
  signedIn: boolean;
  authentication: "claude_ai" | "other" | "none";
}> {
  const parsed = authStatusProjectionSchema.safeParse(value);
  if (!parsed.success) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account status omitted coherent authentication-mode evidence.");
  }
  return Object.freeze({
    signedIn: parsed.data.loggedIn,
    authentication: parsed.data.authentication,
  });
}

function parseAccountIdentity(value: unknown): ClaudeAccountMetadataIdentity | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata was not an object.");
  }
  if (value.oauthAccount === undefined) return null;
  if (!isRecord(value.oauthAccount)) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata contained an invalid identity.");
  }
  const email = optionalIdentityScalar(value.oauthAccount.emailAddress, true);
  const accountUuid = optionalIdentityScalar(value.oauthAccount.accountUuid, false);
  const organizationUuid = optionalIdentityScalar(value.oauthAccount.organizationUuid, false);
  return Object.freeze({ accountUuid, email, organizationUuid });
}

function optionalIdentityScalar(value: unknown, email: boolean): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata contained an invalid scalar.");
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0
    || encoder.encode(normalized).byteLength > ACCOUNT_IDENTITY_MAX_BYTES
    || hasAsciiControlCharacter(normalized)
    || (email && !/^[^@\s]+@[^@\s]+$/u.test(normalized))
  ) {
    throw new ClaudeError("PROTOCOL_ERROR", "Claude account metadata contained an invalid scalar.");
  }
  return normalized;
}

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function sameAccountIdentity(
  left: ClaudeAccountMetadataIdentity | null,
  right: ClaudeAccountMetadataIdentity | null,
): boolean {
  return left?.accountUuid === right?.accountUuid
    && left?.email === right?.email
    && left?.organizationUuid === right?.organizationUuid;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}
