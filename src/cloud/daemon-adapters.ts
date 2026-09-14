import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { parseAccountUsage, parseRateLimits, type RateLimitSnapshot } from "../codex/protocol";
import type {
  LocalCommand,
  NotificationEmailHostedAuthority,
} from "../domain/contracts";
import type {
  ProviderAccountAuthority,
  ProviderAccountId,
  ProviderAccountReadiness,
} from "../domain/provider-accounts";
import { activePresetBinding, type Provider } from "../domain/presets";
import { decodeHistoricalPresetProfile } from "../domain/canonical-profile";
import {
  classifyPermissionCategory,
  computeInteractionPresentation,
  type InteractionDisplay,
  type InteractionRecord,
} from "../domain/interactions";
import {
  deriveRemoteInteractionPolicy,
  remoteInteractionAnswerLimits,
  remoteInteractionJsonFitsProviderLimit,
  type RemoteInteractionAction,
  type RemoteInteractionPolicy,
} from "../domain/remote-interaction-policy";
import { containsSecretShapedText } from "../domain/text-safety";
import {
  deviceCommandLoginResultLifetimeMs,
  deviceRegistryLimits,
  isRelayedLoginUserCode,
  isRelayedLoginUrl,
  parseDeviceCommandPayload,
  parseRemoteCommandPayload,
  type DeviceCommandLoginStatus,
  type DeviceCommandPayload,
  type DeviceRegistryAccount,
  type DeviceRegistryPayload,
  type MemorySummaryPayload,
  type DeviceRegistryScheduledTask,
  type RemoteCommandPayload,
} from "./payloads";
import { isCodexRuntimeProfile } from "../domain/runtime-profile";
import type { NotificationHoursPolicy } from "../domain/notification-hours";
import { providerUsagePayload } from "../domain/usage-metrics";
import type { SessionEvent } from "../domain/session-events";
import { profileIdSchema, queueIdSchema, sessionIdSchema, type ProfileId } from "../domain/values";
import type {
  CodexSessionProjection,
  CloudControlPort,
} from "../daemon/ports";
import {
  isAttachmentImageMediaType,
  type AttachmentReference,
} from "../domain/attachments";
import { AttachmentBlobStore } from "../storage/attachment-store";
import type { StatePaths } from "../storage/paths";
import { OOMPA_VERSION } from "../version";
import type {
  InteractionListPosition,
  ProfileRecord,
  SessionProviderAuthority,
  SessionRecord,
  StateStore,
} from "../storage/state-store";
import {
  cloudLimits,
  containsAbsolutePath,
  containsUnsafeTerminalScalar,
  hasExactKeys,
  isDigest,
  isOpaqueIdentifier,
  isRecord,
  isUuidV7,
  redactAbsolutePaths,
  type AuthorityTuple,
} from "./contracts";
import type { CloudProjectionRecoveryBaselineInteraction } from "./daemon-journal";
import { deviceCommandGuardDecision } from "./device-command-policy";
import type {
  CloudCommandExecutionResult,
  CloudCommandExecutorPort,
  CloudDaemonBridge,
  CloudDeviceRegistryProjection,
  CloudDeviceCommandExecutionResult,
  CloudDeviceCommandExecutorPort,
  CloudDaemonLocalSourcePort,
  CloudLocalCommandAuthority,
  CloudLocalSessionHead,
  CloudLocalSessionPage,
  CloudLocalUsageSnapshot,
} from "./daemon-bridge";
import type { LocalAttentionNotificationSnapshot } from "./attention-notifications";
import type { CloudSyncCadenceStatus } from "./daemon-lifecycle";
import type {
  CloudRemoteCommandReceipt,
  CloudRemoteCommandStatus,
  CloudRemoteControlPort,
  CloudRemoteSessionHead,
  CloudRemoteSessionProjection,
  CloudRemoteSessionSelector,
} from "./local-control";
import {
  COMPACT_INTERACTION_DETAIL_VERSION,
  COMPACT_REMOTE_INTERACTION_POLICY_VERSION,
  compactInteractionDetailLimits,
  detailProjectionIsSafe,
  isCompactInteractionBaselineShape,
  compactInteractionDetailOf,
  isProjectRelativePath,
  parseCompactSessionEvent,
  parseCompactSessionEvents,
  type CompactInteractionDecision,
  type CompactInteractionQuestion,
  type CompactRemoteInteractionPolicy,
  type CompactAttachment,
  type CompactMessageActor,
  type CompactMessageActorKind,
  type CompactSessionEvent,
  type GitAction,
  type ModelPreset,
} from "./projection";
import {
  parseUsageProjection,
  USAGE_CLOUD_PROJECTION_MAX_DAILY_ROWS,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
  type UsageLimit,
  type UsageProjection,
  type UsageWindow,
} from "./usage";

const maximumCachedTurnBytes = 1_048_576;
const maximumProjectionReadBytes = cloudLimits.detailChunkBytes;
const projectionCacheFileName = "cloud-projection.sqlite";
const projectionSidecarSuffixes = ["", "-journal", "-shm", "-wal"] as const;
const maximumProjectionRecoveryBaselineInteractions = 200;
const maximumProjectionRecoveryStatusSessions = 20;
const scheduledTaskPromptProjectionMarker = "[scheduled task prompt omitted]";

type ProviderRemoteLocalCommand = Extract<LocalCommand, Readonly<{
  kind: "session.send" | "session.queue" | "session.steer" | "session.stop" | "session.rename" | "session.preset" | "session.switch" | "session.fast" | "interaction.resolve";
}>>;

/** Remote command kinds that only change local daemon settings. */
type SettingCommandPayload = Extract<RemoteCommandPayload, Readonly<{
  kind: "set_approval_mode" | "set_show_thinking" | "set_default_preset" | "archive_session" | "set_gateway_key";
}>>;

/** Device commands run ordinary local commands, so they need the full union. */
type DeviceEffectLocalCommand = Extract<LocalCommand, Readonly<{
  kind: "session.start" | "session.send" | "account.login" | "account.usage";
}>>;

type LocalExecuteCommand = (
  command: DeviceEffectLocalCommand,
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<unknown>;

type LocalExecuteRemote = (
  command: ProviderRemoteLocalCommand,
  expected: Readonly<{
    bindingGeneration: number;
    processGeneration: number;
    profileId: ProfileRecord["id"];
    provider: Provider;
    providerAccountId: ProviderAccountId;
    providerThreadId: string;
    sessionId: SessionRecord["id"];
  }>,
  options: Readonly<{ signal: AbortSignal }>,
) => Promise<unknown>;

type CompactSessionEventBody =
  | Readonly<{
      actor?: CompactMessageActor;
      actorKind?: CompactMessageActorKind;
      attachments?: readonly CompactAttachment[];
      kind: "user_message" | "assistant_message";
      text: string;
      turnId: string;
    }>
  | Readonly<{
      availableDecisions?: readonly CompactInteractionDecision[];
      blocking: boolean;
      commandClass?: string;
      detailMarkdown?: string;
      detailVersion?: number;
      headline?: string;
      interactionId: string;
      interactionKind: InteractionRecord["kind"];
      kind: "interaction_state";
      label?: string;
      questions?: readonly CompactInteractionQuestion[];
      remotePolicy?: CompactRemoteInteractionPolicy;
      revision: number;
      state: InteractionRecord["state"];
      summary: string;
    }>
  | Readonly<{
      fast?: boolean;
      filesTouched: readonly string[];
      gitActions: readonly GitAction[];
      kind: "turn_summary";
      model?: ModelPreset;
      runtimeMs: number;
      turnId: string;
    }>;

type ProjectionSequenceRow = Readonly<{
  interaction_discovery_cursor: string | null;
  interaction_scan_ceiling_sequence: number;
  interaction_scan_sequence: number;
  next_sequence: number;
  stream_epoch: number;
}>;

type ProjectionBaselineRow = Readonly<{
  digest: string;
}>;

type ProjectionStoredTurnRow = Readonly<{
  digest: string;
  event_count: number;
  events_json: string;
  start_sequence: number;
  turn_id: string;
}>;

type VerifiedProjectionTurnRow = ProjectionStoredTurnRow & Readonly<{
  events: readonly CompactSessionEvent[];
}>;

type ProjectionIndexedInteractionRow = ProjectionStoredTurnRow & Readonly<{
  interaction_id: string;
}>;

type ValidatedProjectionLedger = Readonly<{
  committedHead: number;
  interactionDiscoveryCursor: InteractionListPosition | null;
  interactionScanCeilingSequence: number;
  interactionScanSequence: number;
  localHead: number;
}>;

type ProjectionLedgerValidationMemo = Readonly<{
  firstSequence: number | null;
  localHead: number;
  streamEpoch: number;
}>;

type ProjectionCheckpointRow = Readonly<{
  head_sequence: number;
  pending_expected_head: number | null;
  pending_expected_tail: string | null;
  pending_head: number | null;
  pending_tail: string | null;
  stream_epoch: number;
  tail_digest: string | null;
}>;

type ProjectionFileIdentity = Readonly<{
  device: number;
  inode: number;
}>;

type CompactUploadCheckpoint = Readonly<{
  cacheId: string;
  digest: string;
  expectedHeadSequence: number;
  expectedStreamEpoch: number;
  expectedTailDigest?: string;
  headSequence: number;
  sessionPublicId: string;
}>;

function validProjectionRemoteHead(
  headSequence: number,
  tailDigest: string | undefined,
  streamEpoch: number,
): boolean {
  return Number.isSafeInteger(headSequence)
    && headSequence >= 0
    && Number.isSafeInteger(streamEpoch)
    && streamEpoch >= 0
    && (headSequence === 0 ? tailDigest === undefined : isDigest(tailDigest))
    && (streamEpoch === 0 || headSequence > 0);
}

function validCompactUploadCheckpoint(input: CompactUploadCheckpoint): boolean {
  return isOpaqueIdentifier(input.cacheId)
    && isOpaqueIdentifier(input.sessionPublicId)
    && validProjectionRemoteHead(
      input.expectedHeadSequence,
      input.expectedTailDigest,
      input.expectedStreamEpoch,
    )
    && Number.isSafeInteger(input.headSequence)
    && input.headSequence > input.expectedHeadSequence
    && isDigest(input.digest);
}

function encodeInteractionListPosition(value: InteractionListPosition): string {
  return JSON.stringify({ publicId: value.publicId, requestedAt: value.requestedAt });
}

function parseInteractionListPosition(
  value: string | null,
): InteractionListPosition | null {
  if (value === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new ProjectionStreamRecoveryError();
  }
  if (
    !isRecord(decoded)
    || !hasExactKeys(decoded, ["publicId", "requestedAt"])
    || typeof decoded.publicId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
      .test(decoded.publicId)
    || decoded.publicId !== decoded.publicId.toLowerCase()
    || !Number.isSafeInteger(decoded.requestedAt)
    || (decoded.requestedAt as number) < 0
  ) throw new ProjectionStreamRecoveryError();
  return {
    publicId: decoded.publicId,
    requestedAt: decoded.requestedAt as number,
  };
}

function sameInteractionListPosition(
  left: InteractionListPosition | null,
  right: InteractionListPosition | null,
): boolean {
  return left === null
    ? right === null
    : right !== null
      && left.requestedAt === right.requestedAt
      && left.publicId === right.publicId;
}

export type CompactProjectionBaseline = Readonly<{
  bodyDigest: string;
  turnId: string;
}>;

export type CompactProjectionLocalAuthority = Readonly<{
  bindingGeneration: number;
  processGeneration: number;
  profileId: string;
  provider: Provider;
  providerAccountId: ProviderAccountId;
  providerUpdatedAt: number | null;
  providerThreadId: string;
  sessionRevision: number;
}>;

export type CompactProjectionRecoveryPlan = Readonly<{
  baselineCompletedTurns: readonly CompactProjectionBaseline[];
  baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
  localAuthority: CompactProjectionLocalAuthority;
  sessionPublicId: string;
}>;

export type CompactProjectionRecoveryInstallation = CompactProjectionRecoveryPlan & Readonly<{
  boundaryHeadSequence: number;
  boundaryTailDigest: string;
  compactStreamEpoch: number;
  idempotencyKey: string;
  replacementCacheId: string;
}>;

class ProjectionStreamRecoveryError extends Error {
  constructor() {
    super("Cloud transcript upload is paused because the durable local projection ledger does not match the exact remote head and tail. Restoring this stream requires an explicit, potentially history-discarding reseed.");
    this.name = "ProjectionStreamRecoveryError";
  }
}

function assertSafeProjectionFile(path: string): ProjectionFileIdentity {
  const pathMetadata = lstatSync(path);
  if (pathMetadata.isSymbolicLink()) {
    throw new Error("The cloud projection cache cannot be a symbolic link.");
  }
  if (!pathMetadata.isFile()) {
    throw new Error("The cloud projection cache has unsafe filesystem authority.");
  }
  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (
      metadata.dev !== pathMetadata.dev
      || metadata.ino !== pathMetadata.ino
      || !metadata.isFile()
      || metadata.nlink !== 1
      || metadata.uid !== currentUid
      || (metadata.mode & 0o077) !== 0
    ) throw new Error("The cloud projection cache has unsafe filesystem authority.");
    return { device: metadata.dev, inode: metadata.ino };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function sameProjectionFileIdentity(
  left: ProjectionFileIdentity,
  right: ProjectionFileIdentity,
): boolean {
  return left.device === right.device && left.inode === right.inode;
}

function assertProjectionFileIdentity(
  path: string,
  expected: ProjectionFileIdentity,
): ProjectionFileIdentity {
  const current = assertSafeProjectionFile(path);
  if (!sameProjectionFileIdentity(current, expected)) {
    throw new Error("Cloud projection recovery cache pathname changed.");
  }
  return current;
}

function readProjectionBytes(
  descriptor: number,
  byteLength: number,
  position: number,
): Buffer {
  const value = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < byteLength) {
    const read = readSync(
      descriptor,
      value,
      offset,
      byteLength - offset,
      position + offset,
    );
    if (read === 0) throw new Error("The cloud projection cache is truncated.");
    offset += read;
  }
  return value;
}

function projectionPageSize(header: Buffer): number {
  const encoded = header.readUInt16BE(16);
  const pageSize = encoded === 1 ? 65_536 : encoded;
  if (
    pageSize < 512
    || pageSize > 65_536
    || (pageSize & (pageSize - 1)) !== 0
  ) throw new Error("The cloud projection cache header is invalid.");
  return pageSize;
}

function observeProjectionUserVersion(path: string): number {
  const identity = assertSafeProjectionFile(path);
  let descriptor: number | null = null;
  let pageSize = 0;
  let observedVersion = 0;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (metadata.size !== 0) {
      if (metadata.size < 100) throw new Error("The cloud projection cache header is invalid.");
      const header = readProjectionBytes(descriptor, 100, 0);
      if (!header.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))) {
        throw new Error("The cloud projection cache header is invalid.");
      }
      pageSize = projectionPageSize(header);
      observedVersion = header.readUInt32BE(60);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  assertProjectionFileIdentity(path, identity);

  const walPath = `${path}-wal`;
  if (!existsSync(walPath)) return observedVersion;
  const walIdentity = assertSafeProjectionFile(walPath);
  descriptor = null;
  try {
    descriptor = openSync(walPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (metadata.size !== 0) {
      if (metadata.size < 32 || pageSize === 0) {
        throw new Error("The cloud projection cache WAL is invalid.");
      }
      const header = readProjectionBytes(descriptor, 32, 0);
      const magic = header.readUInt32BE(0);
      if (
        (magic !== 0x377f0682 && magic !== 0x377f0683)
        || header.readUInt32BE(8) !== pageSize
      ) throw new Error("The cloud projection cache WAL is invalid.");
      const frameBytes = 24 + pageSize;
      const frameCount = Math.floor((metadata.size - 32) / frameBytes);
      if (frameCount > 8_192) {
        throw new Error("The cloud projection cache WAL exceeds the observation bound.");
      }
      for (let index = 0; index < frameCount; index += 1) {
        const frameOffset = 32 + index * frameBytes;
        const frameHeader = readProjectionBytes(descriptor, 4, frameOffset);
        if (frameHeader.readUInt32BE(0) !== 1) continue;
        const version = readProjectionBytes(descriptor, 4, frameOffset + 24 + 60)
          .readUInt32BE(0);
        if (version > observedVersion) observedVersion = version;
      }
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
  assertProjectionFileIdentity(path, identity);
  assertProjectionFileIdentity(walPath, walIdentity);
  return observedVersion;
}

function syncProjectionDirectory(path: string): void {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : metadata.uid;
    if (!metadata.isDirectory() || metadata.uid !== currentUid) {
      throw new Error("The cloud projection cache directory has unsafe filesystem authority.");
    }
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function recoveryCacheId(idempotencyKey: string): string {
  return `cache_${sha256(`projection-recovery:${idempotencyKey}`).slice(0, 48)}`;
}

function recoveryStagingPath(
  root: string,
  cacheFileName: string,
  idempotencyKey: string,
): string {
  return join(root, `${cacheFileName}.recovery-${idempotencyKey}`);
}

function recoveryQuarantinePath(
  root: string,
  cacheFileName: string,
  idempotencyKey: string,
): string {
  return join(root, `${cacheFileName}.quarantine-${idempotencyKey}`);
}

/*
 * Turning a hosted attachment manifest into local custody.
 *
 * An entry that carries `data` is admitted exactly the way the CLI admits a
 * file: the base64 is decoded, the bytes are sniffed against the declared
 * media type, and the store re-derives the digest. A hosted claim about the
 * digest is checked, never trusted. An entry with no `data` must already be
 * in custody on this machine, which is how a browser re-sends a file the
 * custodian already holds without paying for the bytes twice.
 */
export type RemoteAttachmentMaterialization =
  | Readonly<{ kind: "materialized"; values: readonly AttachmentReference[] }>
  | Readonly<{ code: string; kind: "refused" }>;

export async function materializeRemoteAttachments(
  blobs: AttachmentBlobStore,
  payload: RemoteCommandPayload,
): Promise<RemoteAttachmentMaterialization> {
  if (!("attachments" in payload)) return { kind: "materialized", values: [] };
  const values: AttachmentReference[] = [];
  for (const attachment of payload.attachments) {
    const canonical = isAttachmentImageMediaType(attachment.mediaType)
      ? attachment.mediaType
      : "text/plain";
    if (attachment.data === undefined) {
      if (!await blobs.has(attachment.digest, canonical)) {
        return { code: "ATTACHMENT_MISSING", kind: "refused" };
      }
      values.push({
        byteLength: attachment.byteLength,
        digest: attachment.digest,
        mediaType: attachment.mediaType,
        name: attachment.name,
      });
      continue;
    }
    const bytes = new Uint8Array(Buffer.from(attachment.data, "base64"));
    if (bytes.byteLength !== attachment.byteLength) {
      return { code: "ATTACHMENT_LENGTH_MISMATCH", kind: "refused" };
    }
    const stored = await blobs.put(attachment.mediaType, bytes);
    if (stored.kind === "refused") {
      return { code: `ATTACHMENT_${stored.reason}`, kind: "refused" };
    }
    if (stored.value.digest !== attachment.digest) {
      return { code: "ATTACHMENT_DIGEST_MISMATCH", kind: "refused" };
    }
    values.push({
      byteLength: stored.value.byteLength,
      digest: stored.value.digest,
      mediaType: attachment.mediaType,
      name: attachment.name,
    });
  }
  return { kind: "materialized", values };
}

function providerAccountAuthorityOf(
  authority: SessionProviderAuthority,
): ProviderAccountAuthority {
  return {
    bindingGeneration: authority.bindingGeneration,
    processGeneration: authority.processGeneration,
    profileId: authority.profileId,
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
  };
}

function providerAccountCanReadExistingSession(
  authority: SessionProviderAuthority,
  readiness: ProviderAccountReadiness,
): boolean {
  return readiness === "signed_in"
    || (
      authority.provider === "claude"
      && readiness === "unverified"
      && authority.routingProvenance === "explicit"
    );
}

export type DeviceRegistryAccountAddress = Readonly<{
  profileId: ProfileId;
  provider: Provider;
  publicId: string;
}>;

/**
 * The one reversible account-addressing boundary shared by registry writes and
 * device-command reads. Codex keeps its historical raw profile id because the
 * browser login flow already addresses it. Sibling provider identities are
 * qualified, so one isolated local profile can never collide across providers.
 * Both directions enforce the cloud protocol's bounded opaque-id grammar.
 */
export function deviceRegistryAccountAddress(input:
  | Readonly<{ kind: "local"; profileId: string; provider: Provider }>
  | Readonly<{ kind: "public"; publicId: string }>): DeviceRegistryAccountAddress | null {
  if (input.kind === "local") {
    if (input.provider === "devin") return null;
    const profileId = profileIdSchema.safeParse(input.profileId);
    if (!profileId.success) return null;
    const publicId = input.provider === "codex"
      ? profileId.data
      : `${input.provider}_${profileId.data}`;
    return isOpaqueIdentifier(publicId)
      ? { profileId: profileId.data, provider: input.provider, publicId }
      : null;
  }

  if (!isOpaqueIdentifier(input.publicId)) return null;
  const legacyCodex = profileIdSchema.safeParse(input.publicId);
  if (legacyCodex.success) {
    return { profileId: legacyCodex.data, provider: "codex", publicId: input.publicId };
  }
  for (const provider of ["claude", "devin"] as const) {
    const prefix = `${provider}_`;
    if (!input.publicId.startsWith(prefix)) continue;
    const profileId = profileIdSchema.safeParse(input.publicId.slice(prefix.length));
    if (profileId.success) {
      return { profileId: profileId.data, provider, publicId: input.publicId };
    }
  }
  return null;
}
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const accountFingerprint = (email: string): string =>
  sha256(email.trim().toLowerCase());

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function rethrowWhenAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function providerObservationCleanupFailed(error: unknown): boolean {
  // Provider probes currently use their ordinary timeout/process codes for
  // these closed custody failures. Admission wrappers preserve them as causes.
  // Inspect only a bounded cause chain and retain no provider diagnostic text.
  let current = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth += 1) {
    if (/could not be (?:joined|drained)/u.test(current.message)) return true;
    current = current.cause;
  }
  return false;
}

function boundedProjectionRecoveryError(error: unknown): Error {
  const message = boundedText(
    error instanceof Error ? error.message : "Cloud projection recovery failed.",
    512,
  );
  return new Error(message.length === 0
    ? "Cloud projection recovery failed at a bounded local boundary."
    : message);
}

function redactSecretShapes(value: string): string {
  return value
    .replace(/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/gu, "[cloud projection secret omitted]")
    .replace(/\b(?:sk|re)_[A-Za-z0-9_-]{8,}/gu, "[cloud projection secret omitted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{8,}/gu, "[cloud projection secret omitted]");
}

function boundedText(value: string, maximumCharacters: number): string {
  const bounded = value.length <= maximumCharacters
    ? value
    : `${value.slice(0, Math.max(0, maximumCharacters - 26))}\n[cloud projection truncated]`;
  const sanitized = redactAbsolutePaths(redactSecretShapes(bounded));
  return containsAbsolutePath(sanitized)
    ? "[cloud projection omitted text containing a local absolute path]"
    : containsUnsafeTerminalScalar(sanitized, true)
      ? Array.from(sanitized).map((scalar) => scalar === "\n" || !containsUnsafeTerminalScalar(scalar)
          ? scalar
          : `\\u{${scalar.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}}`).join("")
      : sanitized;
}

function boundedUtf8Text(value: string, maximumBytes: number): string {
  if (utf8Bytes(value) <= maximumBytes) return value;
  const marker = "\n[cloud projection truncated]";
  const markerBytes = utf8Bytes(marker);
  const characters: string[] = [];
  for (const scalar of value) characters.push(scalar);
  let lower = 0;
  let upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (utf8Bytes(characters.slice(0, middle).join("")) + markerBytes <= maximumBytes) {
      lower = middle;
    } else {
      upper = middle - 1;
    }
  }
  return `${characters.slice(0, lower).join("")}${marker}`;
}

function boundedNote(value: string): string | null {
  if (value.length === 0) return null;
  return boundedUtf8Text(boundedText(value, 8_000), 10_000);
}

const defaultSessionTitle = "Untitled session";

function boundedName(value: string): string {
  const name = boundedText(value, 160).trim();
  return name.length === 0 ? defaultSessionTitle : name;
}

/**
 * Registry labels are display text. A value that carries an absolute path or
 * a control scalar is replaced by the fallback rather than redacted in place:
 * the settings projection shows names, never anything derived from the
 * filesystem, and `parseDeviceRegistryPayload` refuses the rest.
 */
function registryLabel(
  value: string,
  fallback: string,
  maximum: number = deviceRegistryLimits.labelCharacters,
): string {
  const label = boundedText(value, maximum).trim();
  if (
    label.length === 0
    || containsAbsolutePath(label)
    || containsUnsafeTerminalScalar(label)
  ) return fallback;
  return label;
}

function compactInteractionSummary(kind: InteractionRecord["kind"]): string {
  switch (kind) {
    case "command_approval": return "Codex requests command approval";
    case "file_change_approval": return "Codex requests file-change approval";
    case "permission_approval": return "Codex requests additional permissions";
    case "user_input": return "Codex needs user input";
    case "mcp_elicitation": return "An MCP server requests protected form input";
  }
}

function boundedLine(value: string, maximum: number): string {
  // `boundedText` can introduce a line feed with its truncation marker, so the
  // collapse runs on both sides of it: every field below is a single line.
  return boundedText(value.replace(/\s+/gu, " ").trim(), maximum)
    .replace(/\s+/gu, " ")
    .trim();
}

function projectionLine(label: string, value: string, maximum = 240): string | null {
  const text = boundedLine(value, maximum);
  const name = boundedLine(label, 64);
  return text.length === 0 || name.length === 0 ? null : `- ${name}: ${text}`;
}

function interactionDetailMarkdown(
  display: InteractionDisplay,
  remotePolicy: RemoteInteractionPolicy,
): string {
  const lines: (string | null)[] = [];
  switch (display.kind) {
    case "command_approval":
      lines.push(projectionLine("Runs", display.commandClass, 128));
      if (isProjectRelativePath(display.workingDirectory)) {
        lines.push(projectionLine("Directory", display.workingDirectory));
      }
      if (display.reason !== null) lines.push(projectionLine("Reason", display.reason));
      break;
    case "file_change_approval":
      if (isProjectRelativePath(display.grantRoot)) {
        lines.push(projectionLine("Grant root", display.grantRoot));
      }
      if (display.reason !== null) lines.push(projectionLine("Reason", display.reason));
      lines.push("- Oompa cannot show the exact affected paths for this provider version.");
      break;
    case "permission_approval": {
      // Categories are classed for presentation only, never named. Exact
      // values remain local, and no category can grant remote authority.
      const classes = [...new Set(display.requested
        .map((permission) => classifyPermissionCategory(permission.name)))].sort();
      lines.push(projectionLine(
        display.requested.length === 1 ? "Requested category" : "Requested categories",
        classes.length === 0 ? "none" : classes.join(", "),
      ));
      if (display.reason !== null) lines.push(projectionLine("Reason", display.reason));
      break;
    }
    case "user_input":
      for (const question of display.questions) {
        lines.push(projectionLine(
          question.header,
          question.secret ? "answered on the machine" : question.question,
        ));
      }
      break;
    case "mcp_elicitation": {
      // An MCP form is declared as possibly carrying protected values, and its
      // server name and field names are provider text. Neither the server nor
      // an unanswerable field is named here; only the fields this device could
      // actually fill are named at all, and they are named by the policy's
      // `questions` list rather than by this prose. Reachability comes only
      // from the shared policy action set: optional unsupported fields and
      // policy bounds must never be reinterpreted by a presentation helper.
      lines.push("- This form may contain protected values.");
      const answerable = remotePolicy.questions.length;
      lines.push(remotePolicy.actions.includes("answer")
        ? `- ${String(answerable)} text value${answerable === 1 ? "" : "s"} can be answered from here.`
        : "- It is completed on the machine running the session.");
      break;
    }
  }
  return boundedText(
    lines.filter((line): line is string => line !== null).join("\n"),
    compactInteractionDetailLimits.detailMarkdownCharacters,
  );
}

type CompactInteractionDetailBody = Readonly<{
  detailMarkdown?: string;
  detailVersion?: number;
  headline?: string;
  label?: string;
  remotePolicy?: CompactRemoteInteractionPolicy;
}>;

/**
 * The projected detail block for one interaction.
 *
 * The stored display is already sanitised (`sanitizeInteractionDisplay` ran
 * before it became durable), so this function adds no new provider text; what
 * it does is decide which of that text a device that cannot see the exact
 * command, the exact affected paths, or the exact permission values is allowed
 * to be shown, and then re-check the result against the projection's own text
 * rules. Anything path shaped is dropped unless it is project relative, and
 * anything that still fails `detailProjectionIsSafe` or the compact parser
 * drops the whole detail block, which leaves the browser with the base event
 * and therefore with no buttons.
 */
function compactInteractionDetail(
  interaction: Pick<InteractionRecord, "deadlineAt" | "display" | "kind" | "state">,
  now: number,
): CompactInteractionDetailBody {
  const { display } = interaction;
  const presentation = computeInteractionPresentation(display);
  const policy = deriveRemoteInteractionPolicy({
    deadlineAt: interaction.deadlineAt,
    display,
    state: interaction.state,
  }, now);
  const remotePolicy: CompactRemoteInteractionPolicy = {
    actions: [...policy.actions],
    deadlineAt: policy.deadlineAt,
    questions: policy.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    reasonCodes: [...policy.reasonCodes],
    version: COMPACT_REMOTE_INTERACTION_POLICY_VERSION,
  };
  const candidate: CompactInteractionDetailBody = {
    detailMarkdown: interactionDetailMarkdown(display, policy),
    detailVersion: COMPACT_INTERACTION_DETAIL_VERSION,
    headline: boundedLine(
      presentation.headline,
      compactInteractionDetailLimits.headlineCharacters,
    ),
    label: boundedLine(presentation.label, compactInteractionDetailLimits.labelCharacters),
    remotePolicy,
  };
  if (!detailProjectionIsSafe(candidate)) return {};
  // Last gate: the wire parser itself. A detail block the compact parser would
  // reject is dropped here rather than failing the whole interaction event,
  // so an unexpected provider string can cost the browser its buttons but can
  // never stall the projection.
  const probe = parseCompactSessionEvent({
    blocking: true,
    interactionId: "00000000-0000-4000-8000-000000000000",
    interactionKind: interaction.kind,
    kind: "interaction_state",
    revision: 1,
    sequence: 1,
    state: interaction.state,
    summary: compactInteractionSummary(interaction.kind),
    ...candidate,
  });
  if (probe === null || probe.kind !== "interaction_state") return {};
  return compactInteractionDetailOf(probe);
}

function recoveryInteractionBody(
  interaction: CloudProjectionRecoveryBaselineInteraction,
): CompactSessionEventBody {
  // The baseline carries the detail the live path would have produced for the
  // same interaction revision, so a recovered row digests identically to the
  // row a later ordinary ingest of that revision writes.
  return {
    ...compactInteractionDetailOf({ ...interaction, kind: "interaction_state", sequence: 1 }),
    blocking: interaction.blocking,
    interactionId: interaction.interactionId,
    interactionKind: interaction.interactionKind,
    kind: "interaction_state",
    revision: interaction.revision,
    state: interaction.state,
    summary: interaction.summary,
  };
}

function recoveryInteractionTurnId(
  interaction: CloudProjectionRecoveryBaselineInteraction,
): string {
  return `hraix_${sha256(`${interaction.interactionId}:${String(interaction.revision)}`)}`;
}

function parseRecoveryBaselineInteractions(
  value: unknown,
): readonly CloudProjectionRecoveryBaselineInteraction[] {
  if (
    !Array.isArray(value)
    || value.length > maximumProjectionRecoveryBaselineInteractions
  ) throw new Error("Invalid cloud projection recovery interaction baseline.");
  const parsed = value.map((candidate) => {
    if (!isCompactInteractionBaselineShape(candidate)) {
      throw new Error("Invalid cloud projection recovery interaction baseline.");
    }
    const [event] = parseCompactSessionEvents([{
      ...candidate,
      kind: "interaction_state",
      sequence: 1,
    }]) ?? [];
    if (event?.kind !== "interaction_state") {
      throw new Error("Invalid cloud projection recovery interaction baseline.");
    }
    return {
      ...compactInteractionDetailOf(event),
      blocking: event.blocking,
      interactionId: event.interactionId,
      interactionKind: event.interactionKind,
      revision: event.revision,
      state: event.state,
      summary: event.summary,
    };
  });
  if (new Set(parsed.map((interaction) => interaction.interactionId)).size !== parsed.length) {
    throw new Error("Invalid cloud projection recovery interaction baseline.");
  }
  return parsed;
}

function parseRecoveryObservedInteractionIds(value: unknown): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > maximumProjectionRecoveryBaselineInteractions
  ) throw new Error("Cloud projection recovery input is invalid.");
  const candidates: readonly unknown[] = value;
  const parsed = candidates.map((candidate) => {
    if (typeof candidate !== "string") {
      throw new Error("Cloud projection recovery input is invalid.");
    }
    return candidate;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new Error("Cloud projection recovery input is invalid.");
  }
  return parsed;
}

function terminalSessionState(session: SessionRecord): "active" | "idle" | "terminal" | null {
  if (session.provider === "devin") return "terminal";
  if (session.state === "active") return "active";
  if (session.state === "idle") return "idle";
  if (session.state === "terminal") return "terminal";
  return null;
}

/**
 * Every provider session remains subordinate to its exact durable provider
 * account authority. Managed Claude sessions also use the accepted platform
 * boundary, while an adopted session can use its exact active personal-runtime
 * binding. Devin is retired and has no provider authority. A detaching or
 * detached binding never reopens provider authority.
 */
function profileAllowsEstablishedSession(
  store: StateStore,
  profile: ProfileRecord,
  session: SessionRecord,
  platform: NodeJS.Platform,
): boolean {
  if (profile.state === "removed") return false;
  const personalBinding = store.readSessionPersonalRuntimeBinding(session.id);
  const usesPersonalRuntime = personalBinding !== null
    && personalBinding.state === "active"
    && personalBinding.provider === session.provider
    && personalBinding.providerThreadId === session.providerThreadId;
  if (!store.sessionAccountAuthorityMatches(session.id, profile.id)) return false;
  switch (session.provider) {
    case "codex": return true;
    case "claude": return platform === "linux" || usesPersonalRuntime;
    case "devin": return false;
  }
}

function parseStoredEvents(value: string): readonly CompactSessionEvent[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("The cloud projection cache contains invalid JSON.");
  }
  const parsed = parseCompactSessionEvents(decoded);
  if (parsed === null) throw new Error("The cloud projection cache contains invalid events.");
  return parsed;
}

function compactSessionEventBody(event: CompactSessionEvent): CompactSessionEventBody {
  if (event.kind === "user_message" || event.kind === "assistant_message") {
    // Both optional keys are spread in place, so an event that carries
    // neither digests byte for byte as it did before either existed and a
    // cache written by an older build still verifies.
    return {
      ...(event.kind === "user_message" && event.actor !== undefined
        ? { actor: event.actor }
        : {}),
      ...(event.kind === "user_message" && event.actorKind !== undefined
        ? { actorKind: event.actorKind }
        : {}),
      ...(event.kind === "user_message" && event.attachments !== undefined
        ? { attachments: event.attachments }
        : {}),
      kind: event.kind,
      text: event.text,
      turnId: event.turnId,
    };
  }
  if (event.kind === "interaction_state") {
    // The optional detail keys are spread in place, so an event that carries
    // none of them digests byte for byte as it did before the detail existed
    // and a cache written by an older build still verifies.
    return {
      ...compactInteractionDetailOf(event),
      blocking: event.blocking,
      interactionId: event.interactionId,
      interactionKind: event.interactionKind,
      kind: event.kind,
      revision: event.revision,
      state: event.state,
      summary: event.summary,
    };
  }
  return {
    ...(event.fast === undefined ? {} : { fast: event.fast }),
    filesTouched: event.filesTouched,
    gitActions: event.gitActions,
    kind: event.kind,
    ...(event.model === undefined ? {} : { model: event.model }),
    runtimeMs: event.runtimeMs,
    turnId: event.turnId,
  };
}

function parseVerifiedStoredEvents(row: ProjectionStoredTurnRow): VerifiedProjectionTurnRow {
  const endSequence = row.start_sequence + row.event_count - 1;
  if (
    !isOpaqueIdentifier(row.turn_id)
    || !Number.isSafeInteger(row.start_sequence)
    || row.start_sequence < 1
    || !Number.isSafeInteger(row.event_count)
    || row.event_count < 1
    || !Number.isSafeInteger(endSequence)
    || !isDigest(row.digest)
    || typeof row.events_json !== "string"
    || utf8Bytes(row.events_json) > maximumCachedTurnBytes
  ) throw new ProjectionStreamRecoveryError();
  let events: readonly CompactSessionEvent[];
  try {
    events = parseStoredEvents(row.events_json);
  } catch {
    throw new ProjectionStreamRecoveryError();
  }
  const interaction = events.length === 1 && events[0]?.kind === "interaction_state"
    ? events[0]
    : null;
  const rowAuthorityMatches = interaction === null
    ? events.every((event) => event.kind !== "interaction_state" && event.turnId === row.turn_id)
    : row.turn_id === `hraix_${sha256(`${interaction.interactionId}:${String(interaction.revision)}`)}`;
  if (
    events.length !== row.event_count
    || events.some((event, index) => event.sequence !== row.start_sequence + index)
    || !rowAuthorityMatches
    || sha256(JSON.stringify(events.map(compactSessionEventBody))) !== row.digest
  ) throw new ProjectionStreamRecoveryError();
  return { ...row, events };
}

function verifiedInteractionEvent(
  row: VerifiedProjectionTurnRow,
): Extract<CompactSessionEvent, { kind: "interaction_state" }> | null {
  const event = row.events.length === 1 ? row.events[0] : undefined;
  return event?.kind === "interaction_state" ? event : null;
}

function rebuildProjectionInteractionIndex(database: Database): void {
  const latest = new Map<string, Readonly<{
    interactionId: string;
    revision: number;
    sessionId: string;
    startSequence: number;
  }>>();
  const rows = database.query(
    `SELECT turn_id,start_sequence,event_count,digest,events_json,session_id
     FROM projection_turns ORDER BY session_id,start_sequence`,
  ).all() as Array<ProjectionStoredTurnRow & { session_id: string }>;
  for (const storedRow of rows) {
    if (!isOpaqueIdentifier(storedRow.session_id)) {
      throw new ProjectionStreamRecoveryError();
    }
    const row = parseVerifiedStoredEvents(storedRow);
    const interaction = verifiedInteractionEvent(row);
    if (interaction !== null) {
      const key = `${storedRow.session_id}:${interaction.interactionId}`;
      const previous = latest.get(key);
      if (previous !== undefined && previous.revision >= interaction.revision) {
        throw new ProjectionStreamRecoveryError();
      }
      latest.set(key, {
        interactionId: interaction.interactionId,
        revision: interaction.revision,
        sessionId: storedRow.session_id,
        startSequence: row.start_sequence,
      });
    }
  }
  const insert = database.query(
    `INSERT INTO projection_interaction_index(
       session_id,interaction_id,start_sequence
     ) VALUES (?,?,?)`,
  );
  for (const value of latest.values()) {
    insert.run(value.sessionId, value.interactionId, value.startSequence);
  }
}

class CloudProjectionCache {
  readonly #database: Database;
  readonly #fileIdentity: ProjectionFileIdentity;
  readonly #validatedLedgers = new Map<string, ProjectionLedgerValidationMemo>();
  #observedDataVersion: number | null = null;

  constructor(path: string) {
    const existed = existsSync(path);
    if (existed) {
      assertSafeProjectionFile(path);
    } else {
      const descriptor = openSync(
        path,
        fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | fsConstants.O_RDWR
          | fsConstants.O_NOFOLLOW,
        0o600,
      );
      closeSync(descriptor);
      assertSafeProjectionFile(path);
    }
    const expectedIdentity = assertSafeProjectionFile(path);
    const observedVersion = observeProjectionUserVersion(path);
    assertProjectionFileIdentity(path, expectedIdentity);
    if (observedVersion > 5) {
      throw new Error("The cloud projection cache was created by a newer Oompa version.");
    }
    const database = new Database(path, { create: true, strict: true });
    try {
      assertProjectionFileIdentity(path, expectedIdentity);
      const version = database.query("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version !== observedVersion || version.user_version > 5) {
        throw new Error("The cloud projection cache version changed during open.");
      }
      chmodSync(path, 0o600);
      assertSafeProjectionFile(path);
      database.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
      let needsInteractionIndexBackfill = false;
      if (version.user_version === 0) {
        database.exec(`
          CREATE TABLE projection_sessions (
            session_id TEXT PRIMARY KEY,
            next_sequence INTEGER NOT NULL CHECK(next_sequence > 0),
            stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0),
            interaction_scan_sequence INTEGER NOT NULL DEFAULT 0
              CHECK(interaction_scan_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)}),
            interaction_scan_ceiling_sequence INTEGER NOT NULL DEFAULT 0
              CHECK(interaction_scan_ceiling_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)}),
            interaction_discovery_cursor TEXT
              CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128)
          ) STRICT;
          CREATE TABLE projection_turns (
            session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            event_count INTEGER NOT NULL CHECK(event_count > 0),
            digest TEXT NOT NULL CHECK(length(digest) = 64),
            events_json TEXT NOT NULL CHECK(length(CAST(events_json AS BLOB)) <= ${String(maximumCachedTurnBytes)}),
            PRIMARY KEY(session_id, turn_id),
            UNIQUE(session_id, start_sequence)
          ) STRICT;
          CREATE TABLE projection_baselines (
            session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            digest TEXT NOT NULL CHECK(length(digest) = 64),
            PRIMARY KEY(session_id, turn_id)
          ) STRICT;
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
          CREATE TABLE projection_ledger (
            singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
            cache_id TEXT NOT NULL CHECK(length(cache_id) BETWEEN 16 AND 128)
          ) STRICT;
          CREATE TABLE projection_remote_checkpoints (
            session_id TEXT PRIMARY KEY,
            head_sequence INTEGER NOT NULL CHECK(head_sequence >= 0),
            stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0),
            tail_digest TEXT CHECK(tail_digest IS NULL OR length(tail_digest) = 64),
            pending_expected_head INTEGER CHECK(pending_expected_head IS NULL OR pending_expected_head >= 0),
            pending_expected_tail TEXT CHECK(pending_expected_tail IS NULL OR length(pending_expected_tail) = 64),
            pending_head INTEGER CHECK(pending_head IS NULL OR pending_head > 0),
            pending_tail TEXT CHECK(pending_tail IS NULL OR length(pending_tail) = 64)
          ) STRICT;
          PRAGMA user_version=5;
        `);
      } else if (version.user_version === 1) {
        database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE projection_sessions ADD COLUMN stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0);
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_ceiling_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_ceiling_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_discovery_cursor TEXT
            CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128);
          ALTER TABLE projection_remote_checkpoints ADD COLUMN stream_epoch INTEGER NOT NULL DEFAULT 0 CHECK(stream_epoch >= 0);
          CREATE TABLE projection_baselines (
            session_id TEXT NOT NULL REFERENCES projection_sessions(session_id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL,
            digest TEXT NOT NULL CHECK(length(digest) = 64),
            PRIMARY KEY(session_id, turn_id)
          ) STRICT;
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      } else if (version.user_version === 2) {
        database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_scan_ceiling_sequence INTEGER NOT NULL DEFAULT 0
            CHECK(interaction_scan_ceiling_sequence BETWEEN 0 AND ${String(Number.MAX_SAFE_INTEGER)});
          ALTER TABLE projection_sessions ADD COLUMN interaction_discovery_cursor TEXT
            CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128);
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      } else if (version.user_version === 3) {
        database.exec(`
          BEGIN IMMEDIATE;
          ALTER TABLE projection_sessions ADD COLUMN interaction_discovery_cursor TEXT
            CHECK(interaction_discovery_cursor IS NULL OR length(CAST(interaction_discovery_cursor AS BLOB)) BETWEEN 50 AND 128);
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      } else if (version.user_version === 4) {
        database.exec(`
          BEGIN IMMEDIATE;
          CREATE TABLE projection_interaction_index (
            session_id TEXT NOT NULL,
            interaction_id TEXT NOT NULL CHECK(length(interaction_id) = 36),
            start_sequence INTEGER NOT NULL CHECK(start_sequence > 0),
            PRIMARY KEY(session_id, interaction_id),
            UNIQUE(session_id, start_sequence),
            FOREIGN KEY(session_id, start_sequence)
              REFERENCES projection_turns(session_id, start_sequence) ON DELETE CASCADE
          ) STRICT;
        `);
        needsInteractionIndexBackfill = true;
      }
      if (needsInteractionIndexBackfill) {
        rebuildProjectionInteractionIndex(database);
        database.exec("PRAGMA user_version=5; COMMIT;");
      }
      database.query("INSERT OR IGNORE INTO projection_ledger(singleton,cache_id) VALUES (1,?)")
        .run(randomUUID());
    } catch (error: unknown) {
      database.close(false);
      throw error;
    }
    this.#database = database;
    this.#fileIdentity = assertSafeProjectionFile(path);
  }

  close(): void {
    this.#database.close(false);
  }

  cacheId(): string {
    const row = this.#database.query(
      "SELECT cache_id FROM projection_ledger WHERE singleton=1",
    ).get() as { cache_id: string } | null;
    if (row === null || !isOpaqueIdentifier(row.cache_id)) {
      throw new Error("The cloud projection cache ledger is corrupt.");
    }
    return row.cache_id;
  }

  fileIdentity(): ProjectionFileIdentity {
    return this.#fileIdentity;
  }

  hasRecoveryInstallation(input: CompactProjectionRecoveryInstallation): boolean {
    if (this.cacheId() !== input.replacementCacheId) return false;
    const baselineInteractions = parseRecoveryBaselineInteractions(input.baselineInteractions);
    const session = this.#database.query(
      `SELECT next_sequence,stream_epoch,interaction_scan_sequence,
              interaction_scan_ceiling_sequence,interaction_discovery_cursor
       FROM projection_sessions WHERE session_id=?`,
    ).get(input.sessionPublicId) as ProjectionSequenceRow | null;
    const checkpoint = this.#remoteCheckpoint(input.sessionPublicId);
    if (
      session?.next_sequence !== input.boundaryHeadSequence + 1 + baselineInteractions.length
      || session.stream_epoch !== input.compactStreamEpoch
      || session.interaction_scan_sequence !== 0
      || session.interaction_scan_ceiling_sequence !== 0
      || session.interaction_discovery_cursor !== null
      || checkpoint?.head_sequence !== input.boundaryHeadSequence
      || checkpoint.stream_epoch !== input.compactStreamEpoch
      || checkpoint.tail_digest !== input.boundaryTailDigest
      || checkpoint.pending_expected_head !== null
      || checkpoint.pending_expected_tail !== null
      || checkpoint.pending_head !== null
      || checkpoint.pending_tail !== null
    ) return false;
    const rows = this.#database.query(
      "SELECT turn_id,digest FROM projection_baselines WHERE session_id=? ORDER BY turn_id",
    ).all(input.sessionPublicId) as Array<{ digest: string; turn_id: string }>;
    const expected = [...input.baselineCompletedTurns]
      .sort((left, right) => left.turnId < right.turnId ? -1 : left.turnId > right.turnId ? 1 : 0);
    if (!(rows.length === expected.length && rows.every((row, index) => {
      const value = expected[index];
      return value !== undefined && row.turn_id === value.turnId && row.digest === value.bodyDigest;
    }))) return false;
    const interactionRows = this.#database.query(
      "SELECT turn_id,start_sequence,event_count,digest,events_json FROM projection_turns WHERE session_id=? ORDER BY start_sequence",
    ).all(input.sessionPublicId) as ProjectionStoredTurnRow[];
    const indexedInteractions = this.#database.query(
      `SELECT interaction_id,start_sequence FROM projection_interaction_index
       WHERE session_id=? ORDER BY start_sequence`,
    ).all(input.sessionPublicId) as Array<{
      interaction_id: string;
      start_sequence: number;
    }>;
    return interactionRows.length === baselineInteractions.length
      && indexedInteractions.length === baselineInteractions.length
      && indexedInteractions.every((row, index) => {
        const interaction = baselineInteractions[index];
        return interaction !== undefined
          && row.interaction_id === interaction.interactionId
          && row.start_sequence === input.boundaryHeadSequence + 1 + index;
      })
      && interactionRows.every((row, index) => {
        const interaction = baselineInteractions[index];
        if (interaction === undefined) return false;
        const body = recoveryInteractionBody(interaction);
        const sequence = input.boundaryHeadSequence + 1 + index;
        const events = [{ ...body, sequence }];
        const verified = parseVerifiedStoredEvents(row);
        return row.turn_id === recoveryInteractionTurnId(interaction)
          && row.start_sequence === sequence
          && row.event_count === 1
          && row.digest === sha256(JSON.stringify([body]))
          && row.events_json === JSON.stringify(events)
          && verified.events[0]?.kind === "interaction_state";
      });
  }

  isEmptyRecoverySource(): boolean {
    const counts = this.#database.query(`
      SELECT
        (SELECT count(*) FROM projection_sessions) AS sessions,
        (SELECT count(*) FROM projection_turns) AS turns,
        (SELECT count(*) FROM projection_interaction_index) AS interactions,
        (SELECT count(*) FROM projection_baselines) AS baselines,
        (SELECT count(*) FROM projection_remote_checkpoints) AS checkpoints
    `).get() as {
      baselines: number;
      checkpoints: number;
      interactions: number;
      sessions: number;
      turns: number;
    };
    return counts.sessions === 0
      && counts.turns === 0
      && counts.interactions === 0
      && counts.baselines === 0
      && counts.checkpoints === 0;
  }

  initializeRecovery(input: CompactProjectionRecoveryInstallation): void {
    const baselineInteractions = parseRecoveryBaselineInteractions(input.baselineInteractions);
    if (
      !isOpaqueIdentifier(input.sessionPublicId)
      || !Number.isSafeInteger(input.boundaryHeadSequence)
      || input.boundaryHeadSequence < 1
      || !isDigest(input.boundaryTailDigest)
      || !Number.isSafeInteger(input.compactStreamEpoch)
      || input.compactStreamEpoch < 1
      || !isOpaqueIdentifier(input.replacementCacheId)
      || input.baselineCompletedTurns.length > 128
      || new Set(input.baselineCompletedTurns.map((turn) => turn.turnId)).size
        !== input.baselineCompletedTurns.length
      || input.baselineCompletedTurns.some((turn) =>
        !isOpaqueIdentifier(turn.turnId) || !isDigest(turn.bodyDigest))
      || !Number.isSafeInteger(
        input.boundaryHeadSequence + 1 + baselineInteractions.length,
      )
    ) throw new Error("Invalid cloud projection recovery installation.");
    if (this.hasRecoveryInstallation(input)) return;
    const install = this.#database.transaction(() => {
      this.#database.query("UPDATE projection_ledger SET cache_id=? WHERE singleton=1")
        .run(input.replacementCacheId);
      this.#database.query("DELETE FROM projection_remote_checkpoints WHERE session_id=?")
        .run(input.sessionPublicId);
      this.#database.query("DELETE FROM projection_sessions WHERE session_id=?")
        .run(input.sessionPublicId);
      this.#database.query(
        "INSERT INTO projection_sessions(session_id,next_sequence,stream_epoch) VALUES (?,?,?)",
      ).run(
        input.sessionPublicId,
        input.boundaryHeadSequence + 1 + baselineInteractions.length,
        input.compactStreamEpoch,
      );
      for (const baseline of input.baselineCompletedTurns) {
        this.#database.query(
          "INSERT INTO projection_baselines(session_id,turn_id,digest) VALUES (?,?,?)",
        ).run(input.sessionPublicId, baseline.turnId, baseline.bodyDigest);
      }
      for (const [index, interaction] of baselineInteractions.entries()) {
        const body = recoveryInteractionBody(interaction);
        const sequence = input.boundaryHeadSequence + 1 + index;
        this.#database.query(
          "INSERT INTO projection_turns(session_id,turn_id,start_sequence,event_count,digest,events_json) VALUES (?,?,?,?,?,?)",
        ).run(
          input.sessionPublicId,
          recoveryInteractionTurnId(interaction),
          sequence,
          1,
          sha256(JSON.stringify([body])),
          JSON.stringify([{ ...body, sequence }]),
        );
        this.#database.query(
          `INSERT INTO projection_interaction_index(
             session_id,interaction_id,start_sequence
           ) VALUES (?,?,?)`,
        ).run(input.sessionPublicId, interaction.interactionId, sequence);
      }
      this.#database.query(
        "INSERT INTO projection_remote_checkpoints(session_id,head_sequence,stream_epoch,tail_digest) VALUES (?,?,?,?)",
      ).run(
        input.sessionPublicId,
        input.boundaryHeadSequence,
        input.compactStreamEpoch,
        input.boundaryTailDigest,
      );
    });
    install.immediate();
    if (!this.hasRecoveryInstallation(input)) {
      throw new Error("Cloud projection recovery cache installation did not commit exactly.");
    }
  }

  ingestTurn(
    sessionPublicId: string,
    turnId: string,
    bodies: readonly CompactSessionEventBody[],
  ): void {
    if (
      !isOpaqueIdentifier(sessionPublicId)
      || !isOpaqueIdentifier(turnId)
      || bodies.length < 1
      || bodies.length > 256
    ) {
      throw new Error("Invalid local cloud projection turn.");
    }
    const digest = sha256(JSON.stringify(bodies));
    const baseline = this.#database
      .query("SELECT digest FROM projection_baselines WHERE session_id=? AND turn_id=?")
      .get(sessionPublicId, turnId) as ProjectionBaselineRow | null;
    if (baseline !== null) {
      if (!isDigest(baseline.digest)) throw new ProjectionStreamRecoveryError();
      if (baseline.digest !== digest) {
        throw new Error("A recovery-baselined turn changed after cloud projection.");
      }
      return;
    }
    const existing = this.#database
      .query(
        `SELECT turn_id,start_sequence,event_count,digest,events_json
         FROM projection_turns WHERE session_id=? AND turn_id=?`,
      )
      .get(sessionPublicId, turnId) as ProjectionStoredTurnRow | null;
    if (existing !== null) {
      const verified = parseVerifiedStoredEvents(existing);
      if (verified.digest !== digest) throw new Error("A completed turn changed after cloud projection.");
      return;
    }

    const insert = this.#database.transaction(() => {
      this.#database.query("INSERT OR IGNORE INTO projection_sessions(session_id,next_sequence) VALUES (?,1)")
        .run(sessionPublicId);
      this.#validateLocalLedger(sessionPublicId);
      const sequence = this.#database
        .query(
          `SELECT next_sequence,stream_epoch,interaction_scan_sequence,
                  interaction_scan_ceiling_sequence,interaction_discovery_cursor
           FROM projection_sessions WHERE session_id=?`,
        )
        .get(sessionPublicId) as ProjectionSequenceRow | null;
      if (sequence === null) throw new ProjectionStreamRecoveryError();
      const nextSequence = sequence.next_sequence;
      const followingSequence = nextSequence + bodies.length;
      if (
        !Number.isSafeInteger(nextSequence)
        || nextSequence < 1
        || !Number.isSafeInteger(followingSequence)
      ) throw new ProjectionStreamRecoveryError();
      const events = bodies.map((body, index) => ({ ...body, sequence: sequence.next_sequence + index }));
      const parsed = parseCompactSessionEvents(events);
      if (parsed === null) throw new Error("Invalid bounded local session projection.");
      const json = JSON.stringify(parsed);
      if (utf8Bytes(json) > maximumCachedTurnBytes) throw new Error("A projected turn exceeds the local cache bound.");
      this.#database.query(
        "INSERT INTO projection_turns(session_id,turn_id,start_sequence,event_count,digest,events_json) VALUES (?,?,?,?,?,?)",
      ).run(sessionPublicId, turnId, sequence.next_sequence, parsed.length, digest, json);
      const interaction = parsed.length === 1 && parsed[0]?.kind === "interaction_state"
        ? parsed[0]
        : null;
      if (interaction !== null) {
        const indexed = this.#database.query(
          `SELECT i.interaction_id,t.turn_id,t.start_sequence,t.event_count,
                  t.digest,t.events_json
           FROM projection_interaction_index i
           JOIN projection_turns t
             ON t.session_id=i.session_id AND t.start_sequence=i.start_sequence
           WHERE i.session_id=? AND i.interaction_id=?`,
        ).get(sessionPublicId, interaction.interactionId) as ProjectionIndexedInteractionRow | null;
        if (indexed !== null) {
          const current = verifiedInteractionEvent(parseVerifiedStoredEvents(indexed));
          if (
            current === null
            || current.interactionId !== indexed.interaction_id
            || current.revision >= interaction.revision
          ) throw new ProjectionStreamRecoveryError();
          const removed = this.#database.query(
            `DELETE FROM projection_interaction_index
             WHERE session_id=? AND interaction_id=? AND start_sequence=?`,
          ).run(sessionPublicId, interaction.interactionId, indexed.start_sequence);
          if (removed.changes !== 1) throw new ProjectionStreamRecoveryError();
        }
        this.#database.query(
          `INSERT INTO projection_interaction_index(
             session_id,interaction_id,start_sequence
           ) VALUES (?,?,?)`,
        ).run(sessionPublicId, interaction.interactionId, sequence.next_sequence);
      }
      const changed = this.#database.query(
        "UPDATE projection_sessions SET next_sequence=? WHERE session_id=? AND next_sequence=?",
      ).run(followingSequence, sessionPublicId, sequence.next_sequence);
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      // This connection's own commits do not advance PRAGMA data_version.
      // Extend the trusted prefix while the insertion is still protected by
      // the same immediate transaction.
      this.#validateLocalLedger(sessionPublicId);
    });
    insert.immediate();
  }

  interactionDiscoveryCursor(
    sessionPublicId: string,
  ): InteractionListPosition | null {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const inspect = this.#database.transaction(() =>
      this.#validateLocalLedger(sessionPublicId).interactionDiscoveryCursor);
    return inspect.immediate();
  }

  advanceInteractionDiscoveryCursor(
    sessionPublicId: string,
    expected: InteractionListPosition | null,
    next: InteractionListPosition | null,
  ): void {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const expectedJson = expected === null
      ? null
      : encodeInteractionListPosition(expected);
    const nextJson = next === null ? null : encodeInteractionListPosition(next);
    // Round-trip caller-owned scheduling state before it reaches SQLite.
    parseInteractionListPosition(expectedJson);
    parseInteractionListPosition(nextJson);
    const advance = this.#database.transaction(() => {
      const ledger = this.#validateLocalLedger(sessionPublicId);
      if (!sameInteractionListPosition(ledger.interactionDiscoveryCursor, expected)) {
        throw new ProjectionStreamRecoveryError();
      }
      const current = this.#database.query(
        "SELECT interaction_discovery_cursor FROM projection_sessions WHERE session_id=?",
      ).get(sessionPublicId) as { interaction_discovery_cursor: string | null } | null;
      if (current === null) {
        if (expected === null && next === null) return;
        throw new ProjectionStreamRecoveryError();
      }
      const changed = this.#database.query(
        `UPDATE projection_sessions SET interaction_discovery_cursor=?
         WHERE session_id=?
           AND ((interaction_discovery_cursor IS NULL AND ? IS NULL)
             OR interaction_discovery_cursor=?)`,
      ).run(nextJson, sessionPublicId, current.interaction_discovery_cursor, current.interaction_discovery_cursor);
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      this.#validateLocalLedger(sessionPublicId);
    });
    advance.immediate();
  }

  observedInteractionIds(sessionPublicId: string): readonly string[] {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const scan = this.#database.transaction((): readonly string[] => {
      const ledger = this.#validateLocalLedger(sessionPublicId);
      let cursor = ledger.interactionScanSequence;
      let ceiling = ledger.interactionScanCeilingSequence;
      if (cursor === 0 && ceiling === 0) ceiling = ledger.localHead;
      const fairPage = (afterSequence: number, throughSequence: number) =>
        this.#database.query(
          `SELECT i.interaction_id,t.turn_id,t.start_sequence,t.event_count,
                  t.digest,t.events_json
           FROM projection_interaction_index i
           JOIN projection_turns t
             ON t.session_id=i.session_id AND t.start_sequence=i.start_sequence
           WHERE i.session_id=? AND i.start_sequence>? AND i.start_sequence<=?
           ORDER BY i.start_sequence LIMIT 200`,
        ).all(
          sessionPublicId,
          afterSequence,
          throughSequence,
        ) as ProjectionIndexedInteractionRow[];
      let page = fairPage(cursor, ceiling);
      if (page.length === 0 && (cursor !== 0 || ceiling !== ledger.localHead)) {
        cursor = 0;
        ceiling = ledger.localHead;
        page = fairPage(0, ceiling);
      }
      const nextCursor = page.at(-1)?.start_sequence ?? 0;
      const nextCeiling = page.length === 0 ? 0 : ceiling;
      if (ledger.localHead > 0) {
        const changed = this.#database.query(
          `UPDATE projection_sessions
           SET interaction_scan_sequence=?,interaction_scan_ceiling_sequence=?
           WHERE session_id=? AND interaction_scan_sequence=?
             AND interaction_scan_ceiling_sequence=?`,
        ).run(
          nextCursor,
          nextCeiling,
          sessionPublicId,
          ledger.interactionScanSequence,
          ledger.interactionScanCeilingSequence,
        );
        if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      }
      const newest = this.#database.query(
        `SELECT i.interaction_id,t.turn_id,t.start_sequence,t.event_count,
                t.digest,t.events_json
         FROM projection_interaction_index i
         JOIN projection_turns t
           ON t.session_id=i.session_id AND t.start_sequence=i.start_sequence
         WHERE i.session_id=?
         ORDER BY i.start_sequence DESC LIMIT 200`,
      ).all(sessionPublicId) as ProjectionIndexedInteractionRow[];
      const interactionIds = new Set<string>();
      for (const indexed of [...page, ...newest]) {
        const interaction = verifiedInteractionEvent(parseVerifiedStoredEvents(indexed));
        if (
          interaction === null
          || interaction.interactionId !== indexed.interaction_id
          || indexed.start_sequence < 1
        ) throw new ProjectionStreamRecoveryError();
        interactionIds.add(interaction.interactionId);
      }
      return [...interactionIds];
    });
    return scan.immediate();
  }

  ingestInteraction(
    sessionPublicId: string,
    interaction: InteractionRecord,
    now: number,
  ): void {
    if (interaction.sessionId !== sessionPublicId) {
      throw new Error("The cloud projection interaction belongs to another session.");
    }
    const recordId = `hraix_${sha256(`${interaction.publicId}:${String(interaction.revision)}`)}`;
    const existing = this.#database.query(
      `SELECT turn_id,start_sequence,event_count,digest,events_json
       FROM projection_turns WHERE session_id=? AND turn_id=?`,
    ).get(sessionPublicId, recordId) as ProjectionStoredTurnRow | null;
    if (existing !== null) {
      const projected = verifiedInteractionEvent(parseVerifiedStoredEvents(existing));
      if (
        projected === null
        || projected.interactionId !== interaction.publicId
        || projected.revision !== interaction.revision
      ) throw new ProjectionStreamRecoveryError();
      // The first projection of a revision is immutable. This preserves an
      // already-journalled v1 body across upgrade and prevents an unchanged
      // revision from changing digest merely because its deadline passed.
      return;
    }
    this.ingestTurn(sessionPublicId, recordId, [{
      ...compactInteractionDetail(interaction, now),
      blocking: interaction.blocking,
      interactionId: interaction.publicId,
      interactionKind: interaction.kind,
      kind: "interaction_state",
      revision: interaction.revision,
      state: interaction.state,
      summary: compactInteractionSummary(interaction.kind),
    }]);
  }

  hasUncommittedEvents(sessionPublicId: string): boolean {
    if (!isOpaqueIdentifier(sessionPublicId)) {
      throw new Error("Invalid local cloud projection session.");
    }
    const inspect = this.#database.transaction(() => {
      const { committedHead, localHead } = this.#validateLocalLedger(sessionPublicId);
      return localHead > committedHead;
    });
    return inspect.immediate();
  }

  #remoteCheckpoint(sessionPublicId: string): ProjectionCheckpointRow | null {
    return this.#database.query(
      "SELECT head_sequence,stream_epoch,tail_digest,pending_expected_head,pending_expected_tail,pending_head,pending_tail FROM projection_remote_checkpoints WHERE session_id=?",
    ).get(sessionPublicId) as ProjectionCheckpointRow | null;
  }

  #validateLocalLedger(sessionPublicId: string): ValidatedProjectionLedger {
    const dataVersion = (this.#database.query("PRAGMA data_version").get() as {
      data_version: number;
    } | null)?.data_version;
    if (!Number.isSafeInteger(dataVersion) || (dataVersion as number) < 0) {
      throw new ProjectionStreamRecoveryError();
    }
    if (
      this.#observedDataVersion !== null
      && this.#observedDataVersion !== dataVersion
    ) this.#validatedLedgers.clear();
    this.#observedDataVersion = dataVersion as number;

    const session = this.#database.query(
      `SELECT next_sequence,stream_epoch,interaction_scan_sequence,
              interaction_scan_ceiling_sequence,interaction_discovery_cursor
       FROM projection_sessions WHERE session_id=?`,
    ).get(sessionPublicId) as ProjectionSequenceRow | null;
    const checkpoint = this.#remoteCheckpoint(sessionPublicId);
    const pendingValues = checkpoint === null
      ? []
      : [
          checkpoint.pending_expected_head,
          checkpoint.pending_expected_tail,
          checkpoint.pending_head,
          checkpoint.pending_tail,
        ];
    const hasNoPending = pendingValues.every((value) => value === null);
    const hasCompletePending = checkpoint !== null
      && checkpoint.pending_expected_head !== null
      && checkpoint.pending_head !== null
      && checkpoint.pending_tail !== null
      && Number.isSafeInteger(checkpoint.pending_expected_head)
      && checkpoint.pending_expected_head >= 0
      && Number.isSafeInteger(checkpoint.pending_head)
      && checkpoint.pending_head > 0
      && (checkpoint.pending_expected_head === 0
        ? checkpoint.pending_expected_tail === null
        : checkpoint.pending_expected_tail !== null
          && isDigest(checkpoint.pending_expected_tail));
    const checkpointTailValid = checkpoint === null
      || (
        Number.isSafeInteger(checkpoint.head_sequence)
        && checkpoint.head_sequence >= 0
        && Number.isSafeInteger(checkpoint.stream_epoch)
        && checkpoint.stream_epoch >= 0
        && (checkpoint.head_sequence === 0
          ? checkpoint.tail_digest === null
          : isDigest(checkpoint.tail_digest))
        && (checkpoint.stream_epoch === 0 || checkpoint.head_sequence > 0)
      );
    if (
      checkpoint !== null
      && (
        !checkpointTailValid
        || (!hasNoPending && !hasCompletePending)
        || (
          hasCompletePending
          && (
            checkpoint.pending_expected_head !== checkpoint.head_sequence
            || checkpoint.pending_expected_tail !== checkpoint.tail_digest
            || checkpoint.pending_head <= checkpoint.head_sequence
            || !isDigest(checkpoint.pending_tail)
          )
        )
      )
    ) throw new ProjectionStreamRecoveryError();
    if (session === null) {
      this.#validatedLedgers.delete(sessionPublicId);
      if (
        checkpoint === null
        || (
          checkpoint.head_sequence === 0
          && checkpoint.stream_epoch === 0
          && checkpoint.tail_digest === null
          && hasNoPending
        )
      ) return {
        committedHead: 0,
        interactionDiscoveryCursor: null,
        interactionScanCeilingSequence: 0,
        interactionScanSequence: 0,
        localHead: 0,
      };
      throw new ProjectionStreamRecoveryError();
    }
    if (
      !Number.isSafeInteger(session.next_sequence)
      || session.next_sequence < 1
      || !Number.isSafeInteger(session.stream_epoch)
      || session.stream_epoch < 0
      || !Number.isSafeInteger(session.interaction_scan_sequence)
      || session.interaction_scan_sequence < 0
      || !Number.isSafeInteger(session.interaction_scan_ceiling_sequence)
      || session.interaction_scan_ceiling_sequence < 0
    ) throw new ProjectionStreamRecoveryError();
    const interactionDiscoveryCursor = parseInteractionListPosition(
      session.interaction_discovery_cursor,
    );
    const localHead = session.next_sequence - 1;
    const scanIsInactive = session.interaction_scan_sequence === 0
      && session.interaction_scan_ceiling_sequence === 0;
    const scanIsActive = session.interaction_scan_sequence > 0
      && session.interaction_scan_ceiling_sequence > 0
      && session.interaction_scan_sequence <= session.interaction_scan_ceiling_sequence
      && session.interaction_scan_ceiling_sequence <= localHead;
    if (
      !Number.isSafeInteger(localHead)
      || (!scanIsInactive && !scanIsActive)
      || session.interaction_scan_sequence > localHead
      || session.interaction_scan_ceiling_sequence > localHead
      || (session.stream_epoch > 0 && (
        checkpoint === null
        || checkpoint.head_sequence < 1
        || !isDigest(checkpoint.tail_digest)
      ))
      || (
      checkpoint === null
        ? session.stream_epoch !== 0
        : checkpoint.stream_epoch !== session.stream_epoch
          || checkpoint.head_sequence > localHead
          || (checkpoint.pending_head !== null && checkpoint.pending_head > localHead)
      )
    ) throw new ProjectionStreamRecoveryError();

    const prior = this.#validatedLedgers.get(sessionPublicId);
    if (
      prior !== undefined
      && (
        prior.streamEpoch !== session.stream_epoch
        || prior.localHead > localHead
      )
    ) throw new ProjectionStreamRecoveryError();
    const storedRows = prior === undefined
      ? this.#database.query(
          `SELECT turn_id,start_sequence,event_count,digest,events_json
           FROM projection_turns WHERE session_id=? ORDER BY start_sequence`,
        ).all(sessionPublicId) as ProjectionStoredTurnRow[]
      : this.#database.query(
          `SELECT turn_id,start_sequence,event_count,digest,events_json
           FROM projection_turns
           WHERE session_id=? AND start_sequence>?
           ORDER BY start_sequence`,
        ).all(sessionPublicId, prior.localHead) as ProjectionStoredTurnRow[];
    const expectedInteractionIndex = prior === undefined
      ? new Map<string, Readonly<{ revision: number; startSequence: number }>>()
      : null;
    const appendedInteractionIndex: Array<Readonly<{
      interactionId: string;
      startSequence: number;
    }>> = [];
    let firstSequence = prior?.firstSequence ?? null;
    let validatedHead = prior?.localHead ?? 0;
    for (const storedRow of storedRows) {
      const row = parseVerifiedStoredEvents(storedRow);
      if (firstSequence === null) {
        firstSequence = row.start_sequence;
        if (prior === undefined) validatedHead = row.start_sequence - 1;
      }
      if (row.start_sequence !== validatedHead + 1) {
        throw new ProjectionStreamRecoveryError();
      }
      validatedHead = row.start_sequence + row.event_count - 1;
      const interaction = verifiedInteractionEvent(row);
      if (interaction !== null) {
        if (expectedInteractionIndex !== null) {
          const previous = expectedInteractionIndex.get(interaction.interactionId);
          if (previous !== undefined && previous.revision >= interaction.revision) {
            throw new ProjectionStreamRecoveryError();
          }
          expectedInteractionIndex.set(interaction.interactionId, {
            revision: interaction.revision,
            startSequence: row.start_sequence,
          });
        } else {
          appendedInteractionIndex.push({
            interactionId: interaction.interactionId,
            startSequence: row.start_sequence,
          });
        }
      }
    }
    const committedHead = checkpoint?.head_sequence ?? 0;
    if (firstSequence === null && prior === undefined && localHead === committedHead) {
      validatedHead = localHead;
    }
    let scanCursorMatchesInteraction = session.interaction_scan_sequence === 0;
    if (!scanCursorMatchesInteraction) {
      const cursorRow = this.#database.query(
        `SELECT turn_id,start_sequence,event_count,digest,events_json
         FROM projection_turns WHERE session_id=? AND start_sequence=?`,
      ).get(
        sessionPublicId,
        session.interaction_scan_sequence,
      ) as ProjectionStoredTurnRow | null;
      if (cursorRow !== null) {
        const verifiedCursor = parseVerifiedStoredEvents(cursorRow);
        scanCursorMatchesInteraction = verifiedCursor.events.length === 1
          && verifiedCursor.events[0]?.kind === "interaction_state";
      }
    }
    if (
      validatedHead !== localHead
      || !scanCursorMatchesInteraction
      || (firstSequence === null && (localHead !== committedHead || !scanIsInactive))
      || (session.stream_epoch === 0 && firstSequence !== null && firstSequence !== 1)
      || (
        session.stream_epoch > 0
        && firstSequence !== null
        && (
          checkpoint === null
          || firstSequence < 2
          || firstSequence > checkpoint.head_sequence + 1
        )
      )
    ) throw new ProjectionStreamRecoveryError();
    if (expectedInteractionIndex !== null) {
      const indexed = this.#database.query(
        `SELECT interaction_id,start_sequence
         FROM projection_interaction_index
         WHERE session_id=? ORDER BY interaction_id`,
      ).all(sessionPublicId) as Array<{
        interaction_id: string;
        start_sequence: number;
      }>;
      if (
        indexed.length !== expectedInteractionIndex.size
        || indexed.some((row) =>
          expectedInteractionIndex.get(row.interaction_id)?.startSequence !== row.start_sequence)
      ) throw new ProjectionStreamRecoveryError();
    } else {
      for (const expected of appendedInteractionIndex) {
        const indexed = this.#database.query(
          `SELECT start_sequence FROM projection_interaction_index
           WHERE session_id=? AND interaction_id=?`,
        ).get(sessionPublicId, expected.interactionId) as { start_sequence: number } | null;
        if (indexed?.start_sequence !== expected.startSequence) {
          throw new ProjectionStreamRecoveryError();
        }
      }
    }
    this.#validatedLedgers.set(sessionPublicId, {
      firstSequence,
      localHead,
      streamEpoch: session.stream_epoch,
    });
    return {
      committedHead,
      interactionDiscoveryCursor,
      interactionScanCeilingSequence: session.interaction_scan_ceiling_sequence,
      interactionScanSequence: session.interaction_scan_sequence,
      localHead,
    };
  }

  #assertRemoteHead(
    sessionPublicId: string,
    headSequence: number,
    tailDigest: string | undefined,
    streamEpoch: number,
  ): void {
    if (!validProjectionRemoteHead(headSequence, tailDigest, streamEpoch)) {
      throw new ProjectionStreamRecoveryError();
    }
    const current = this.#remoteCheckpoint(sessionPublicId);
    if (current === null) {
      if (headSequence !== 0 || tailDigest !== undefined || streamEpoch !== 0) {
        throw new ProjectionStreamRecoveryError();
      }
      this.#database.query(
        "INSERT INTO projection_remote_checkpoints(session_id,head_sequence,stream_epoch,tail_digest) VALUES (?,0,0,NULL)",
      ).run(sessionPublicId);
      return;
    }
    if (
      current.head_sequence === headSequence
      && current.stream_epoch === streamEpoch
      && (current.tail_digest ?? undefined) === tailDigest
    ) return;
    if (
      current.pending_head === headSequence
      && current.stream_epoch === streamEpoch
      && (current.pending_tail ?? undefined) === tailDigest
    ) {
      const changed = this.#database.query(`
        UPDATE projection_remote_checkpoints
        SET head_sequence=?,tail_digest=?,pending_expected_head=NULL,
            pending_expected_tail=NULL,pending_head=NULL,pending_tail=NULL
        WHERE session_id=? AND stream_epoch=? AND pending_head=? AND pending_tail=?
      `).run(
        headSequence,
        tailDigest ?? null,
        sessionPublicId,
        streamEpoch,
        headSequence,
        tailDigest ?? null,
      );
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
      return;
    }
    throw new ProjectionStreamRecoveryError();
  }

  recordUploadIntent(input: CompactUploadCheckpoint): void {
    if (input.cacheId !== this.cacheId()) throw new ProjectionStreamRecoveryError();
    if (!validCompactUploadCheckpoint(input)) {
      throw new Error("Invalid cloud projection upload checkpoint.");
    }
    const record = this.#database.transaction(() => {
      const { localHead } = this.#validateLocalLedger(input.sessionPublicId);
      this.#assertRemoteHead(
        input.sessionPublicId,
        input.expectedHeadSequence,
        input.expectedTailDigest,
        input.expectedStreamEpoch,
      );
      if (input.headSequence > localHead) {
        throw new Error("Invalid cloud projection upload checkpoint.");
      }
      const changed = this.#database.query(`
        UPDATE projection_remote_checkpoints
        SET pending_expected_head=?,pending_expected_tail=?,pending_head=?,pending_tail=?
        WHERE session_id=? AND head_sequence=? AND stream_epoch=?
          AND ((tail_digest IS NULL AND ? IS NULL) OR tail_digest=?)
      `).run(
        input.expectedHeadSequence,
        input.expectedTailDigest ?? null,
        input.headSequence,
        input.digest,
        input.sessionPublicId,
        input.expectedHeadSequence,
        input.expectedStreamEpoch,
        input.expectedTailDigest ?? null,
        input.expectedTailDigest ?? null,
      );
      if (changed.changes !== 1) throw new ProjectionStreamRecoveryError();
    });
    record.immediate();
  }

  acknowledgeUpload(input: CompactUploadCheckpoint): void {
    if (input.cacheId !== this.cacheId()) throw new ProjectionStreamRecoveryError();
    if (!validCompactUploadCheckpoint(input)) {
      throw new Error("Invalid cloud projection upload checkpoint.");
    }
    const acknowledge = this.#database.transaction(() => {
      const { localHead } = this.#validateLocalLedger(input.sessionPublicId);
      if (input.headSequence > localHead) {
        throw new Error("Invalid cloud projection upload checkpoint.");
      }
      const changed = this.#database.query(`
        UPDATE projection_remote_checkpoints
        SET head_sequence=?,tail_digest=?,pending_expected_head=NULL,
            pending_expected_tail=NULL,pending_head=NULL,pending_tail=NULL
        WHERE session_id=? AND head_sequence=? AND stream_epoch=?
          AND ((tail_digest IS NULL AND ? IS NULL) OR tail_digest=?)
          AND pending_expected_head=?
          AND ((pending_expected_tail IS NULL AND ? IS NULL) OR pending_expected_tail=?)
          AND pending_head=? AND pending_tail=?
      `).run(
        input.headSequence,
        input.digest,
        input.sessionPublicId,
        input.expectedHeadSequence,
        input.expectedStreamEpoch,
        input.expectedTailDigest ?? null,
        input.expectedTailDigest ?? null,
        input.expectedHeadSequence,
        input.expectedTailDigest ?? null,
        input.expectedTailDigest ?? null,
        input.headSequence,
        input.digest,
      );
      if (changed.changes !== 1) {
        const current = this.#remoteCheckpoint(input.sessionPublicId);
        if (
          current?.head_sequence === input.headSequence
          && current.stream_epoch === input.expectedStreamEpoch
          && current.tail_digest === input.digest
        ) return;
        throw new ProjectionStreamRecoveryError();
      }
    });
    acknowledge.immediate();
  }

  read(
    sessionPublicId: string,
    afterSequence: number,
    remoteTailDigest: string | undefined,
    remoteStreamEpoch: number,
    limit: number,
  ): Readonly<{
    complete: boolean;
    events: readonly CompactSessionEvent[];
  }> {
    const read = this.#database.transaction(() => {
      const ledger = this.#validateLocalLedger(sessionPublicId);
      this.#assertRemoteHead(sessionPublicId, afterSequence, remoteTailDigest, remoteStreamEpoch);
      const events: CompactSessionEvent[] = [];
      let reachedByteLimit = false;
      const storedRows = this.#database.query(
        `SELECT turn_id,start_sequence,event_count,digest,events_json
         FROM projection_turns
         WHERE session_id=? AND start_sequence+event_count-1>?
         ORDER BY start_sequence LIMIT ?`,
      ).all(sessionPublicId, afterSequence, limit) as ProjectionStoredTurnRow[];
      for (const storedRow of storedRows) {
        const row = parseVerifiedStoredEvents(storedRow);
        for (const event of row.events) {
          if (event.sequence <= afterSequence || events.length >= limit) continue;
          const candidate = [...events, event];
          if (utf8Bytes(JSON.stringify(candidate)) > maximumProjectionReadBytes) {
            if (events.length === 0) {
              throw new Error("A cached cloud projection event exceeds the transport byte bound.");
            }
            reachedByteLimit = true;
            break;
          }
          events.push(event);
        }
        if (reachedByteLimit || events.length >= limit) break;
      }
      const lastReturned = events.at(-1)?.sequence ?? afterSequence;
      return { complete: lastReturned >= ledger.localHead, events };
    });
    return read.immediate();
  }
}

function gitActions(actions: readonly string[]): readonly GitAction[] {
  const projected: GitAction[] = [];
  for (const action of actions) {
    const normalized = action.trim();
    let kind: GitAction["kind"] | undefined;
    if (/^git\s+status(?:\s|$)/u.test(normalized)) kind = "status";
    else if (/^git\s+diff(?:\s|$)/u.test(normalized)) kind = "diff";
    else if (/^git\s+branch(?:\s|$)/u.test(normalized)) kind = "branch";
    else if (/^git\s+commit(?:\s|$)/u.test(normalized)) kind = "commit";
    if (kind !== undefined) projected.push({ kind, label: boundedText(normalized, 120) });
    if (projected.length >= 32) break;
  }
  return projected;
}

function usageWindow(value: RateLimitSnapshot["primary"]): UsageWindow | null {
  if (
    value === null
    || value.resetsAt === null
    || value.windowDurationMins === null
    || !Number.isSafeInteger(value.windowDurationMins)
    || value.windowDurationMins <= 0
  ) return null;
  return {
    resetsAt: value.resetsAt < 100_000_000_000 ? value.resetsAt * 1_000 : value.resetsAt,
    usedPercent: Math.max(0, Math.min(100, value.usedPercent)),
    windowDurationMinutes: value.windowDurationMins,
  };
}

function limitId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.:-]/gu, "_").slice(0, 96);
  return sanitized.length === 0 ? "primary" : sanitized;
}

function usageLimit(snapshot: RateLimitSnapshot, fallbackId: string, individual: boolean): UsageLimit {
  const primary = usageWindow(snapshot.primary);
  const secondary = usageWindow(snapshot.secondary);
  const id = limitId(snapshot.limitId ?? fallbackId);
  const name = boundedText(snapshot.limitName ?? snapshot.planType ?? id, 96).trim();
  return {
    id,
    individual,
    name: name.length === 0 ? id : name,
    primary,
    reached: snapshot.rateLimitReachedType !== null,
    secondary,
    unlimited: primary === null && secondary === null,
  };
}

export function projectStoredUsage(payload: unknown): UsageProjection {
  payload = providerUsagePayload(payload);
  if (!isRecord(payload) || !isRecord(payload.rateLimits)) return { state: "failed" };
  try {
    const usage = parseAccountUsage(payload.usage);
    const rateLimits = parseRateLimits({
      rateLimits: payload.rateLimits.primary,
      rateLimitsByLimitId: payload.rateLimits.byLimitId,
      // Reset inventory is intentionally local-only and never enters the
      // encrypted usage projection or its compatibility parser.
      rateLimitResetCredits: null,
    });
    const limits: UsageLimit[] = [usageLimit(rateLimits.primary, "primary", false)];
    for (const [key, snapshot] of Object.entries(rateLimits.byLimitId ?? {})) {
      if (limits.length >= USAGE_CLOUD_PROJECTION_MAX_LIMITS) break;
      const projected = usageLimit(snapshot, key, true);
      if (!limits.some((current) => current.id === projected.id)) limits.push(projected);
    }
    const projection: UsageProjection = {
      state: "ready",
      data: {
        currentStreakDays: usage.summary.currentStreakDays ?? 0,
        daily: [...(usage.dailyUsageBuckets ?? [])]
          .slice(-USAGE_CLOUD_PROJECTION_MAX_DAILY_ROWS),
        lifetimeTokens: usage.summary.lifetimeTokens ?? 0,
        limits,
        longestRunningTurnSeconds: usage.summary.longestRunningTurnSec ?? 0,
        longestStreakDays: usage.summary.longestStreakDays ?? 0,
        peakDailyTokens: usage.summary.peakDailyTokens ?? 0,
      },
    };
    return parseUsageProjection(projection) ?? { state: "failed" };
  } catch {
    return { state: "failed" };
  }
}

function completedProjectionTurns(
  store: StateStore,
  session: SessionRecord,
  projection: CodexSessionProjection,
  requireIdle = false,
): readonly Readonly<{
  baseline: CompactProjectionBaseline;
  bodies: readonly CompactSessionEventBody[];
}>[] {
  if (
    requireIdle
    && projection.turnSummaries?.some((summary) => summary.status === "inProgress") === true
  ) {
    throw new Error("Cloud projection recovery requires an idle provider session.");
  }
  const messagesByTurn = new Map<string, CompactSessionEventBody[]>();
  const unsettledProfileTurnIds = new Set<string>();
  for (const message of projection.messages ?? []) {
    if (message.turnId === undefined || !isOpaqueIdentifier(message.turnId)) continue;
    if (
      message.role === "user"
      && message.clientId !== undefined
      && (message.clientId.startsWith("attempt_") || message.clientId.startsWith("queue_"))
      && store.runtimeProfileSourceRequiresSettlement(session.id, message.clientId)
    ) unsettledProfileTurnIds.add(message.turnId);
    const messages = messagesByTurn.get(message.turnId) ?? [];
    const queueSource = message.clientId === undefined
      ? null
      : queueIdSchema.safeParse(message.clientId);
    const scheduledTaskSource = message.role === "user" && (
      (queueSource?.success === true
        && store.isSessionTaskQueueSource(session.id, queueSource.data))
      || store.isSessionTaskTurnSource(session.id, message.turnId)
    );
    const text = scheduledTaskSource
      ? scheduledTaskPromptProjectionMarker
      : boundedText(message.text, 64_000);
    // Resolve authorship from the one storage-owned source classifier. The
    // legacy actor stays `autorespond` for every non-owner host message so the
    // released v0.5 reader accepts it. New readers refine the label through an
    // additive actorKind key that old readers ignore.
    const messageActor = message.role === "user" && message.clientId !== undefined
      ? store.sessionMessageActorForSource(session.id, message.clientId)
      : null;
    const actorKind = messageActor === "automation" || messageActor === "peer_session" || messageActor === "provider_switch"
      ? messageActor
      : null;
    // The manifest is local custody, keyed by the client message id the turn
    // was dispatched under. It names each file and its size; the bytes never
    // leave this machine.
    const manifest = message.role === "user" && message.clientId !== undefined
      ? store.messageAttachmentManifest(session.id, message.clientId)
      : [];
    messages.push({
      ...(messageActor === null || messageActor === "human" ? {} : { actor: "autorespond" }),
      ...(actorKind === null ? {} : { actorKind }),
      ...(manifest.length === 0 ? {} : { attachments: manifest }),
      kind: message.role === "user" ? "user_message" : "assistant_message",
      text,
      turnId: message.turnId,
    });
    messagesByTurn.set(message.turnId, messages);
  }
  const incompleteTurnIds = new Set(projection.omission?.incompleteTurnIds ?? []);
  const unreadItemTurnIds = new Set(projection.omission?.unreadItemTurnIds ?? []);
  const turns: Array<Readonly<{
    baseline: CompactProjectionBaseline;
    bodies: readonly CompactSessionEventBody[];
  }>> = [];
  const seen = new Set<string>();
  for (const summary of projection.turnSummaries ?? []) {
    if (
      summary.status === "inProgress"
      || (requireIdle && summary.status !== "completed")
      || !isOpaqueIdentifier(summary.id)
    ) continue;
    if (
      incompleteTurnIds.has(summary.id)
      || (requireIdle && unreadItemTurnIds.has(summary.id))
      || unsettledProfileTurnIds.has(summary.id)
    ) continue;
    if (seen.has(summary.id)) throw new Error("The Codex runtime repeated a completed turn identity.");
    seen.add(summary.id);
    const runtimeProfile = store.runtimeProfileForTurn(session.id, summary.id);
    const filesTouched = [...new Set(summary.files.filter(isProjectRelativePath))].slice(0, 128);
    const bodies = [...(messagesByTurn.get(summary.id) ?? [])];
    bodies.push({
      // `fast` and `model` travel together in the compact format, and only the
      // Codex document carries fast mode; a Claude turn is never fast.
      ...(runtimeProfile === null
        ? {}
        : { fast: isCodexRuntimeProfile(runtimeProfile) && runtimeProfile.fast }),
      filesTouched,
      gitActions: gitActions(summary.actions),
      kind: "turn_summary",
      ...(runtimeProfile === null ? {} : { model: runtimeProfile.preset }),
      runtimeMs: Math.max(
        0,
        Math.min(7 * 24 * 60 * 60 * 1_000, Math.trunc(summary.runtimeMs ?? 0)),
      ),
      turnId: summary.id,
    });
    const parsed = parseCompactSessionEvents(
      bodies.map((body, index) => ({ ...body, sequence: index + 1 })),
    );
    if (parsed === null) throw new Error("Invalid bounded local session projection.");
    turns.push({
      baseline: { bodyDigest: sha256(JSON.stringify(bodies)), turnId: summary.id },
      bodies,
    });
  }
  if (turns.length > 128) throw new Error("Cloud projection recovery baseline is too large.");
  return turns;
}

function currentProjectionInteractions(
  store: StateStore,
  cache: CloudProjectionCache,
  session: SessionRecord,
): Readonly<{
  discoveryExpected: InteractionListPosition | null;
  discoveryNext: InteractionListPosition | null;
  interactions: readonly InteractionRecord[];
}> {
  const current = new Map<string, InteractionRecord>();
  const discoveryExpected = cache.interactionDiscoveryCursor(session.id);
  const newest = store.listInteractionPage({
    limit: 200,
    sessionId: session.id,
  });
  const discovery = discoveryExpected === null
    ? newest
    : store.listInteractionPage({
        after: discoveryExpected,
        limit: 200,
        sessionId: session.id,
      });
  for (const interaction of newest.interactions) {
    current.set(interaction.publicId, interaction);
  }
  for (const interaction of discovery.interactions) {
    current.set(interaction.publicId, interaction);
  }
  for (const interaction of observedProjectionInteractions(store, cache, session)) {
    current.set(interaction.publicId, interaction);
  }
  return {
    discoveryExpected,
    discoveryNext: discovery.nextPosition,
    interactions: orderedProjectionInteractions(current.values()),
  };
}

function observedProjectionInteractions(
  store: StateStore,
  cache: CloudProjectionCache,
  session: SessionRecord,
): readonly InteractionRecord[] {
  const observed: InteractionRecord[] = [];
  for (const interactionId of cache.observedInteractionIds(session.id)) {
    const interaction = store.requireInteraction(interactionId);
    if (interaction.sessionId !== session.id) {
      throw new Error("The projected interaction changed session authority.");
    }
    observed.push(interaction);
  }
  return orderedProjectionInteractions(observed);
}

function orderedProjectionInteractions(
  interactions: Iterable<InteractionRecord>,
): readonly InteractionRecord[] {
  return [...interactions].sort((left, right) =>
    left.updatedAt - right.updatedAt
      || left.requestedAt - right.requestedAt
      || left.publicId.localeCompare(right.publicId));
}

/**
 * Local custody for the responder gateway key. Injected so the adapter never
 * needs a real state directory in a test, and so the prose-autorespond work
 * package can hand in its own custody without changing this file.
 */
export type CloudGatewayKeyCustody = Readonly<{
  hasKey(): Promise<boolean>;
  setKey(key: string): Promise<void>;
}>;

export type CloudProviderAccountProjectionReader = (
  input: Readonly<{
    authority: ProviderAccountAuthority;
    signal: AbortSignal;
  }>,
) => Promise<Readonly<{ signedIn: boolean | null }>>;

export type StateBackedCloudDaemonAdapterOptions = Readonly<{
  cloudIdentityNamespace?: string | null;
  /**
   * Service-owned exact session reader. It serializes against session/account
   * authority and performs the same fresh provider-account check before and
   * after every provider read. The cloud adapter deliberately owns no runtime
   * port, provider-home path, or account-key derivation.
   */
  readSessionProjectionForCloud(
    sessionPublicId: SessionRecord["id"],
    signal: AbortSignal,
  ): Promise<CodexSessionProjection>;
  /**
   * Service-owned provider account reader. It returns only a signed-in bit
   * after serializing and rechecking exact profile/provider authority; the
   * cloud adapter never receives a runtime port, provider home, or account key.
   */
  readProviderAccountProjectionForCloud?: CloudProviderAccountProjectionReader;
  /** Local custody for the responder gateway key (default: none; `set_gateway_key` is refused). */
  gatewayKeyCustody?: CloudGatewayKeyCustody;
  executeRemote: LocalExecuteRemote;
  /** Runs a local command through the daemon service (default: device commands are refused). */
  executeLocal?: LocalExecuteCommand;
  /** Local desktop notice on the first `session_start` from a device (default: a diagnostic). */
  notifyOperator?: (input: Readonly<{ body: string; title: string }>) => Promise<void>;
  /** Project reasoning summary deltas to the live stream (default off). */
  liveThinking?: boolean;
  /** Display name for this machine in the device registry (default: the host name). */
  machineLabel?: string;
  /** Optional at construction because memory is composed after cloud. */
  memorySummarySource?: (input: Readonly<{
    devicePublicId: string;
    signal: AbortSignal;
  }>) => Promise<MemorySummaryPayload>;
  now?: () => number;
  platform?: NodeJS.Platform;
  paths: StatePaths;
  store: StateStore;
}>;

export type CloudProjectionCacheStatus = Readonly<
  | { state: "ready" }
  | {
      affectedSessions: readonly string[];
      affectedSessionsTruncated: boolean;
      code: "STREAM_RECOVERY_REQUIRED";
      diagnostic: string;
      sessions: number;
      state: "degraded";
    }
  | {
      code: "CACHE_CORRUPT_OR_UNREADABLE" | "CACHE_NEWER_VERSION" | "CACHE_RECOVERY_IN_PROGRESS" | "CACHE_SYMLINK" | "CACHE_UNSAFE_AUTHORITY";
      diagnostic: string;
      state: "unavailable";
    }
>;

function projectionCacheFailure(error: unknown): Exclude<CloudProjectionCacheStatus, { state: "ready" }> {
  const message = error instanceof Error ? error.message : "";
  if (message === "The cloud projection cache cannot be a symbolic link.") {
    return { code: "CACHE_SYMLINK", diagnostic: message, state: "unavailable" };
  }
  if (message === "The cloud projection cache was created by a newer Oompa version.") {
    return { code: "CACHE_NEWER_VERSION", diagnostic: message, state: "unavailable" };
  }
  if (message === "The cloud projection cache has unsafe filesystem authority.") {
    return {
      code: "CACHE_UNSAFE_AUTHORITY",
      diagnostic: "The cloud projection cache has unsafe filesystem authority. Local daemon features remain available.",
      state: "unavailable",
    };
  }
  return {
    code: "CACHE_CORRUPT_OR_UNREADABLE",
    diagnostic: "The cloud projection cache is corrupt or unavailable. Local daemon features remain available.",
    state: "unavailable",
  };
}

export class StateBackedCloudDaemonAdapter
implements CloudDaemonLocalSourcePort, CloudCommandExecutorPort, CloudDeviceCommandExecutorPort {
  readonly #accountObservations = new Map<string, {
    authority: ProviderAccountAuthority;
    observedAt: number;
    signedIn: boolean | null;
  }>();
  readonly #accountObservationTasks = new Map<"claude", {
    controller: AbortController;
    key: string;
    task: Promise<void>;
  }>();
  readonly #accountObservationCursors = new Map<"claude", ProfileId>();
  readonly #accountObservationCleanupFailures = new Set<"claude">();
  #accountObservationsClosed = false;
  #closeTask: Promise<void> | null = null;
  #cache: CloudProjectionCache | null;
  readonly #cachePath: string;
  readonly #cacheFileName: string;
  #cacheStatus: CloudProjectionCacheStatus;
  readonly #readSessionProjectionForCloud: StateBackedCloudDaemonAdapterOptions[
    "readSessionProjectionForCloud"
  ];
  readonly #readProviderAccountProjectionForCloud: CloudProviderAccountProjectionReader | undefined;
  readonly #executeRemote: LocalExecuteRemote;
  readonly #executeLocal: LocalExecuteCommand;
  readonly #notifyOperator: (input: Readonly<{ body: string; title: string }>) => Promise<void>;
  readonly #paths: StatePaths;
  readonly #attachmentBlobStore: AttachmentBlobStore;
  readonly #projectionErrors = new Map<string, Error>();
  readonly #projectionRecoveryErrors = new Set<string>();
  readonly #store: StateStore;
  readonly #liveThinking: boolean;
  readonly #gatewayKeyCustody: CloudGatewayKeyCustody;
  readonly #machineLabel: string;
  readMemorySummary?: (
    input: Readonly<{
      devicePublicId: string;
      signal: AbortSignal;
    }>,
  ) => Promise<MemorySummaryPayload>;
  readonly #registryNow: () => number;
  readonly #platform: NodeJS.Platform;

  constructor(options: StateBackedCloudDaemonAdapterOptions) {
    this.#liveThinking = options.liveThinking ?? false;
    this.#platform = options.platform ?? process.platform;
    this.#registryNow = options.now ?? Date.now;
    this.#machineLabel = registryLabel(options.machineLabel ?? hostname(), "This machine");
    if (options.memorySummarySource !== undefined) {
      this.readMemorySummary = async (input) => {
        if (input.signal.aborted) throw input.signal.reason;
        const summary = await options.memorySummarySource?.(input);
        if (summary === undefined) throw new Error("Memory summary source is unavailable.");
        throwIfAborted(input.signal);
        return summary;
      };
    }
    // Without an injected custody the adapter reports no key and refuses to
    // store one: the CLI hands in the daemon's generational secret custody so
    // the key the hosted command stores is the key the responder reads.
    this.#gatewayKeyCustody = options.gatewayKeyCustody ?? {
      hasKey: async () => false,
      setKey: async () => { throw new Error("Gateway key custody is not available."); },
    };
    if (
      options.cloudIdentityNamespace !== undefined
      && options.cloudIdentityNamespace !== null
      && !/^[0-9a-f]{24}$/u.test(options.cloudIdentityNamespace)
    ) throw new Error("Cloud projection cache identity namespace is invalid.");
    this.#cacheFileName = options.cloudIdentityNamespace === undefined
      ? projectionCacheFileName
      : options.cloudIdentityNamespace === null
        ? "cloud-projection-unbound.sqlite"
        : `cloud-projection-${options.cloudIdentityNamespace}.sqlite`;
    this.#cachePath = join(options.paths.root, this.#cacheFileName);
    try {
      const recoveryStagingExists = !existsSync(this.#cachePath)
        && readdirSync(options.paths.root).some((name) =>
          name.startsWith(`${this.#cacheFileName}.recovery-`));
      if (recoveryStagingExists) {
        this.#cache = null;
        this.#cacheStatus = {
          code: "CACHE_RECOVERY_IN_PROGRESS",
          diagnostic: "Cloud transcript recovery is awaiting exact local cache activation. Local daemon features remain available.",
          state: "unavailable",
        };
      } else {
        this.#cache = new CloudProjectionCache(this.#cachePath);
        this.#cacheStatus = { state: "ready" };
      }
    } catch (error: unknown) {
      this.#cache = null;
      this.#cacheStatus = projectionCacheFailure(error);
    }
    this.#readSessionProjectionForCloud = options.readSessionProjectionForCloud;
    this.#readProviderAccountProjectionForCloud = options.readProviderAccountProjectionForCloud;
    this.#executeRemote = options.executeRemote;
    // Without an injected local executor no device command can reach the
    // provider, so the adapter refuses every one of them rather than pretending
    // a start happened.
    this.#executeLocal = options.executeLocal ?? (() => {
      throw new Error("The local command service is not available for device commands.");
    });
    // Oompa has no desktop notification facility today (nothing in `src/` shells
    // out to `osascript -e 'display notification'`, `terminal-notifier`, or
    // `notify-send`). The default notice is therefore a daemon diagnostic; the
    // CLI injects the real notifier when the daemon has one.
    this.#notifyOperator = options.notifyOperator ?? (() => Promise.resolve());
    this.#paths = options.paths;
    this.#store = options.store;
    this.#attachmentBlobStore = AttachmentBlobStore.forStatePaths(options.paths);
  }

  close(): Promise<void> {
    if (this.#closeTask !== null) return this.#closeTask;
    this.#accountObservationsClosed = true;
    for (const pending of this.#accountObservationTasks.values()) {
      pending.controller.abort(new Error("Provider account observations are closed."));
    }
    this.#accountObservations.clear();
    this.#cache?.close();
    const tasks = [...this.#accountObservationTasks.values()].map((pending) => pending.task);
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Provider account observations did not join after cancellation.")), 5_000);
      timer.unref();
    });
    this.#closeTask = Promise.race([Promise.all(tasks).then(() => {
      if (this.#accountObservationCleanupFailures.size > 0) {
        throw new Error("Provider account observation process cleanup could not be proven.");
      }
    }), deadline])
      .finally(() => clearTimeout(timer));
    void this.#closeTask.catch(() => undefined);
    return this.#closeTask;
  }

  projectionCacheStatus(): CloudProjectionCacheStatus {
    if (this.#cache === null) return this.#cacheStatus;
    if (this.#projectionRecoveryErrors.size > 0) {
      const affectedSessions = [...this.#projectionRecoveryErrors]
        .filter((sessionPublicId) => sessionIdSchema.safeParse(sessionPublicId).success)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, maximumProjectionRecoveryStatusSessions);
      return {
        affectedSessions,
        affectedSessionsTruncated: affectedSessions.length < this.#projectionRecoveryErrors.size,
        code: "STREAM_RECOVERY_REQUIRED",
        diagnostic: "Cloud transcript upload is paused for a mismatched stream. Local sessions, usage sync, remote reads, and remote commands remain available. Repair requires an explicit reseed that may discard cloud transcript history.",
        sessions: this.#projectionRecoveryErrors.size,
        state: "degraded",
      };
    }
    return this.#cacheStatus;
  }

  async planCompactProjectionRecovery(input: Readonly<{
    idempotencyKey: string;
    observedInteractionIds?: readonly string[];
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    baselineCompletedTurns: readonly CompactProjectionBaseline[];
    baselineInteractions: readonly CloudProjectionRecoveryBaselineInteraction[];
    localAuthority: CompactProjectionLocalAuthority;
    replacementCacheId: string;
    sessionPublicId: string;
    sourceCacheId: string | null;
  }>> {
    throwIfAborted(input.signal);
    const observedInteractionIds = parseRecoveryObservedInteractionIds(
      input.observedInteractionIds ?? [],
    );
    if (
      !isUuidV7(input.idempotencyKey)
      || !isOpaqueIdentifier(input.sessionPublicId)
    ) {
      throw new Error("Cloud projection recovery input is invalid.");
    }
    if (
      this.#cacheStatus.state === "unavailable"
      && (
        this.#cacheStatus.code === "CACHE_SYMLINK"
        || this.#cacheStatus.code === "CACHE_NEWER_VERSION"
        || this.#cacheStatus.code === "CACHE_UNSAFE_AUTHORITY"
      )
    ) throw new Error("Cloud projection recovery refuses unsafe cache authority.");
    const { profile, providerAuthority, session } = this.#requireRecoverySession(
      input.sessionPublicId,
    );
    if (
      this.#store.listUnsettledMutations({ sessionId: session.id }).length > 0
      || this.#store.listUnsettledQueueEffects(session.id).length > 0
      || this.#store.listQueue(session.id).some((entry) =>
        entry.state === "pending"
        || entry.state === "dispatching"
        || entry.state === "ambiguous")
    ) throw new Error("Cloud projection recovery requires settled local session effects.");
    const projection = await this.#readSessionProjectionForCloud(
      session.id,
      input.signal,
    );
    throwIfAborted(input.signal);
    const current = this.#requireRecoverySession(input.sessionPublicId, {
      bindingGeneration: providerAuthority.bindingGeneration,
      processGeneration: providerAuthority.processGeneration,
      profileId: profile.id,
      provider: providerAuthority.provider,
      providerAccountId: providerAuthority.providerAccountId,
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: projection.providerUpdatedAt ?? null,
      sessionRevision: session.revision,
    });
    if (
      projection.providerThreadId !== session.providerThreadId
      || projection.status !== "idle"
      || projection.activeTurnId !== undefined
      || current.session.revision !== session.revision
    ) throw new Error("Cloud projection recovery provider authority changed during baseline read.");
    const turns = completedProjectionTurns(this.#store, current.session, projection, true);
    const baselineInteractions = [...observedInteractionIds]
      .sort((left, right) => left.localeCompare(right))
      .map((interactionId): CloudProjectionRecoveryBaselineInteraction => {
        const interaction = this.#store.requireInteraction(interactionId);
        if (interaction.sessionId !== current.session.id) {
          throw new Error("Cloud projection recovery interaction authority changed.");
        }
        return {
          ...compactInteractionDetail(interaction, this.#registryNow()),
          blocking: interaction.blocking,
          interactionId: interaction.publicId,
          interactionKind: interaction.kind,
          revision: interaction.revision,
          state: interaction.state,
          summary: compactInteractionSummary(interaction.kind),
        };
      });
    return {
      baselineCompletedTurns: turns.map((turn) => turn.baseline),
      baselineInteractions: parseRecoveryBaselineInteractions(baselineInteractions),
      localAuthority: {
        bindingGeneration: providerAuthority.bindingGeneration,
        processGeneration: providerAuthority.processGeneration,
        profileId: profile.id,
        provider: providerAuthority.provider,
        providerAccountId: providerAuthority.providerAccountId,
        providerThreadId: session.providerThreadId,
        providerUpdatedAt: projection.providerUpdatedAt ?? null,
        sessionRevision: session.revision,
      },
      replacementCacheId: recoveryCacheId(input.idempotencyKey),
      sessionPublicId: session.id,
      sourceCacheId: this.#cache?.cacheId() ?? null,
    };
  }

  stageCompactProjectionRecovery(
    input: CompactProjectionRecoveryInstallation & Readonly<{
      signal: AbortSignal;
      sourceCacheId: string | null;
    }>,
  ): Promise<void> {
    throwIfAborted(input.signal);
    try {
      this.#requireRecoverySession(input.sessionPublicId, input.localAuthority);
      if (input.replacementCacheId !== recoveryCacheId(input.idempotencyKey)) {
        throw new Error("Cloud projection recovery cache identity changed.");
      }
      const stagingPath = recoveryStagingPath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      let expectedSourceIdentity: ProjectionFileIdentity | null = null;
      if (this.#cache !== null) {
        expectedSourceIdentity = this.#cache.fileIdentity();
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        if (this.#cache.cacheId() !== input.sourceCacheId) {
          throw new Error("Cloud projection recovery source cache changed.");
        }
        for (const suffix of projectionSidecarSuffixes.slice(1)) {
          if (existsSync(`${this.#cachePath}${suffix}`)) {
            throw new Error("Cloud projection cache has an unsettled sidecar.");
          }
        }
      }
      if (existsSync(stagingPath)) {
        assertSafeProjectionFile(stagingPath);
        for (const suffix of projectionSidecarSuffixes.slice(1)) {
          const sidecarPath = `${stagingPath}${suffix}`;
          if (existsSync(sidecarPath)) assertSafeProjectionFile(sidecarPath);
        }
        const priorStaging = new CloudProjectionCache(stagingPath);
        let isExactOrRecoverablePartial = false;
        try {
          isExactOrRecoverablePartial = priorStaging.hasRecoveryInstallation(input)
            || (input.sourceCacheId === null
              ? priorStaging.isEmptyRecoverySource()
              : priorStaging.cacheId() === input.sourceCacheId);
        } finally {
          priorStaging.close();
        }
        if (!isExactOrRecoverablePartial) {
          throw new Error("Cloud projection recovery staging cache changed.");
        }
        for (const suffix of projectionSidecarSuffixes.slice(1)) {
          if (existsSync(`${stagingPath}${suffix}`)) {
            throw new Error("Cloud projection recovery staging cache has an unsettled sidecar.");
          }
        }
        assertSafeProjectionFile(stagingPath);
        unlinkSync(stagingPath);
        syncProjectionDirectory(this.#paths.root);
      }
      if (this.#cache !== null && expectedSourceIdentity !== null) {
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        copyFileSync(this.#cachePath, stagingPath, fsConstants.COPYFILE_EXCL);
        chmodSync(stagingPath, 0o600);
        try {
          assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        } catch (error: unknown) {
          assertSafeProjectionFile(stagingPath);
          unlinkSync(stagingPath);
          syncProjectionDirectory(this.#paths.root);
          throw error;
        }
      } else {
        const staging = new CloudProjectionCache(stagingPath);
        staging.close();
      }
      assertSafeProjectionFile(stagingPath);
      const staging = new CloudProjectionCache(stagingPath);
      try {
        staging.initializeRecovery(input);
      } finally {
        staging.close();
      }
      syncProjectionDirectory(this.#paths.root);
      throwIfAborted(input.signal);
      return Promise.resolve();
    } catch (error: unknown) {
      if (input.signal.aborted) throw input.signal.reason;
      return Promise.reject(boundedProjectionRecoveryError(error));
    }
  }

  activateCompactProjectionRecovery(
    input: CompactProjectionRecoveryInstallation & Readonly<{
      signal: AbortSignal;
      sourceCacheId: string | null;
    }>,
  ): Promise<void> {
    throwIfAborted(input.signal);
    try {
      this.#requireRecoverySession(input.sessionPublicId, input.localAuthority);
      if (input.replacementCacheId !== recoveryCacheId(input.idempotencyKey)) {
        throw new Error("Cloud projection recovery cache identity changed.");
      }
      if (this.#cache !== null) {
        assertProjectionFileIdentity(this.#cachePath, this.#cache.fileIdentity());
      }
      if (this.#cache?.hasRecoveryInstallation(input) === true) {
        const currentCache = this.#cache;
        const expectedIdentity = currentCache.fileIdentity();
        assertProjectionFileIdentity(this.#cachePath, expectedIdentity);
        const reopened = new CloudProjectionCache(this.#cachePath);
        if (
          !sameProjectionFileIdentity(reopened.fileIdentity(), expectedIdentity)
          || !reopened.hasRecoveryInstallation(input)
        ) {
          reopened.close();
          throw new Error("Cloud projection recovery destination changed.");
        }
        assertProjectionFileIdentity(this.#cachePath, expectedIdentity);
        currentCache.close();
        this.#cache = reopened;
        syncProjectionDirectory(this.#paths.root);
        this.#projectionRecoveryErrors.delete(input.sessionPublicId);
        this.#projectionErrors.delete(input.sessionPublicId);
        this.#cacheStatus = { state: "ready" };
        return Promise.resolve();
      }
      if (this.#cache === null && existsSync(this.#cachePath)) {
        let installed: CloudProjectionCache | null = null;
        try {
          installed = new CloudProjectionCache(this.#cachePath);
        } catch (error: unknown) {
          const currentFailure = projectionCacheFailure(error);
          if (
            input.sourceCacheId !== null
            || this.#cacheStatus.state !== "unavailable"
            || this.#cacheStatus.code !== "CACHE_CORRUPT_OR_UNREADABLE"
            || currentFailure.code !== "CACHE_CORRUPT_OR_UNREADABLE"
          ) throw error;
          // The exact recovery was prepared from an unreadable original cache.
          // That same path is preserved until the verified staging ledger is
          // atomically installed below.
        }
        if (installed !== null) {
          if (installed.hasRecoveryInstallation(input)) {
            syncProjectionDirectory(this.#paths.root);
            this.#cache = installed;
            this.#projectionRecoveryErrors.delete(input.sessionPublicId);
            this.#projectionErrors.delete(input.sessionPublicId);
            this.#cacheStatus = { state: "ready" };
            return Promise.resolve();
          }
          installed.close();
          throw new Error("Cloud projection recovery destination changed.");
        }
      }
      const stagingPath = recoveryStagingPath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      if (!existsSync(stagingPath)) {
        throw new Error("Cloud projection recovery staging cache is unavailable.");
      }
      assertSafeProjectionFile(stagingPath);
      const staging = new CloudProjectionCache(stagingPath);
      try {
        if (!staging.hasRecoveryInstallation(input)) {
          throw new Error("Cloud projection recovery staging cache changed.");
        }
      } finally {
        staging.close();
      }
      let expectedSourceIdentity: ProjectionFileIdentity | null = null;
      if (this.#cache !== null) {
        if (this.#cache.cacheId() !== input.sourceCacheId) {
          throw new Error("Cloud projection recovery source cache changed.");
        }
        expectedSourceIdentity = this.#cache.fileIdentity();
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
        const currentSource = new CloudProjectionCache(this.#cachePath);
        try {
          if (
            !sameProjectionFileIdentity(currentSource.fileIdentity(), expectedSourceIdentity)
            || currentSource.cacheId() !== input.sourceCacheId
          ) throw new Error("Cloud projection recovery source cache changed.");
        } finally {
          currentSource.close();
        }
        assertProjectionFileIdentity(this.#cachePath, expectedSourceIdentity);
      }
      this.#cacheStatus = {
        code: "CACHE_RECOVERY_IN_PROGRESS",
        diagnostic: "Cloud transcript recovery is awaiting exact local cache activation. Local daemon features remain available.",
        state: "unavailable",
      };
      this.#cache?.close();
      this.#cache = null;
      const quarantinePath = recoveryQuarantinePath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      for (const suffix of projectionSidecarSuffixes) {
        const source = `${this.#cachePath}${suffix}`;
        const target = `${quarantinePath}${suffix}`;
        const sourceExists = existsSync(source);
        const targetExists = existsSync(target);
        if (sourceExists && targetExists) {
          throw new Error("Cloud projection recovery quarantine conflicts.");
        }
        if (sourceExists) {
          const sourceIdentity = assertSafeProjectionFile(source);
          if (
            suffix === ""
            && expectedSourceIdentity !== null
            && !sameProjectionFileIdentity(sourceIdentity, expectedSourceIdentity)
          ) throw new Error("Cloud projection recovery source cache changed.");
          renameSync(source, target);
          const quarantinedIdentity = assertSafeProjectionFile(target);
          if (
            suffix === ""
            && expectedSourceIdentity !== null
            && !sameProjectionFileIdentity(quarantinedIdentity, expectedSourceIdentity)
          ) throw new Error("Cloud projection recovery source cache changed during activation.");
        } else if (targetExists) {
          const quarantinedIdentity = assertSafeProjectionFile(target);
          if (
            suffix === ""
            && expectedSourceIdentity !== null
            && !sameProjectionFileIdentity(quarantinedIdentity, expectedSourceIdentity)
          ) throw new Error("Cloud projection recovery quarantine changed.");
        }
      }
      syncProjectionDirectory(this.#paths.root);
      if (existsSync(this.#cachePath)) {
        throw new Error("Cloud projection recovery destination changed.");
      }
      renameSync(stagingPath, this.#cachePath);
      chmodSync(this.#cachePath, 0o600);
      syncProjectionDirectory(this.#paths.root);
      const installed = new CloudProjectionCache(this.#cachePath);
      if (!installed.hasRecoveryInstallation(input)) {
        installed.close();
        throw new Error("Cloud projection recovery activation changed.");
      }
      this.#cache = installed;
      this.#cacheStatus = { state: "ready" };
      this.#projectionRecoveryErrors.delete(input.sessionPublicId);
      this.#projectionErrors.delete(input.sessionPublicId);
      throwIfAborted(input.signal);
      return Promise.resolve();
    } catch (error: unknown) {
      if (input.signal.aborted) throw input.signal.reason;
      return Promise.reject(boundedProjectionRecoveryError(error));
    }
  }

  discardCompactProjectionRecovery(input: Readonly<{
    idempotencyKey: string;
    sessionPublicId: string;
  }>): Promise<void> {
    if (!isUuidV7(input.idempotencyKey) || !isOpaqueIdentifier(input.sessionPublicId)) {
      return Promise.reject(new Error("Cloud projection recovery discard authority is invalid."));
    }
    try {
      const stagingPath = recoveryStagingPath(
        this.#paths.root,
        this.#cacheFileName,
        input.idempotencyKey,
      );
      let changed = false;
      for (const suffix of [...projectionSidecarSuffixes].reverse()) {
        const path = `${stagingPath}${suffix}`;
        if (!existsSync(path)) continue;
        assertSafeProjectionFile(path);
        unlinkSync(path);
        changed = true;
      }
      if (changed) syncProjectionDirectory(this.#paths.root);
      return Promise.resolve();
    } catch (error: unknown) {
      return Promise.reject(boundedProjectionRecoveryError(error));
    }
  }

  isSessionTerminal(sessionPublicId: string): boolean {
    if (!isOpaqueIdentifier(sessionPublicId)) return false;
    try {
      return this.#store.requireSession(sessionPublicId).state === "terminal";
    } catch {
      return false;
    }
  }

  #requireRecoverySession(
    sessionPublicId: string,
    expected?: CompactProjectionLocalAuthority,
  ): Readonly<{
    profile: ProfileRecord;
    providerAuthority: ProviderAccountAuthority;
    session: SessionRecord & { providerThreadId: string };
  }> {
    const session = this.#store.requireSession(sessionPublicId);
    const sessionAuthority = this.#store.requireSessionProviderAuthority(session.id);
    const providerAuthority = providerAccountAuthorityOf(sessionAuthority);
    const providerAccount = this.#store.assertProviderAccountAuthorityCurrent(providerAuthority);
    const profile = this.#store.requireProfileById(providerAuthority.profileId);
    if (
      session.id !== sessionPublicId
      || session.profileId !== providerAuthority.profileId
      || session.providerThreadId === undefined
      || session.state !== "idle"
      || !providerAccountCanReadExistingSession(sessionAuthority, providerAccount.readiness)
      || !profileAllowsEstablishedSession(this.#store, profile, session, this.#platform)
      || (expected !== undefined && (
        providerAuthority.bindingGeneration !== expected.bindingGeneration
        || profile.id !== expected.profileId
        || providerAuthority.processGeneration !== expected.processGeneration
        || providerAuthority.provider !== expected.provider
        || providerAuthority.providerAccountId !== expected.providerAccountId
        || session.providerThreadId !== expected.providerThreadId
        || session.providerUpdatedAt !== (expected.providerUpdatedAt ?? undefined)
        || session.revision !== expected.sessionRevision
      ))
    ) throw new Error("Cloud projection recovery local authority changed.");
    return {
      profile,
      providerAuthority,
      session: session as SessionRecord & { providerThreadId: string },
    };
  }

  hasActiveTurn(): boolean {
    return this.#store.hasSessionWithActiveTurn();
  }

  async listSessions(input: Readonly<{
    afterPublicId?: string | null;
    limit: number;
    signal: AbortSignal;
  }>): Promise<CloudLocalSessionPage> {
    if (input.signal.aborted) throw input.signal.reason;
    const cache = this.#cache;
    const page = this.#store.listCloudSessionPage({
      afterId: input.afterPublicId ?? null,
      limit: input.limit,
    });
    const heads: CloudLocalSessionHead[] = [];
    for (const session of page.sessions) {
      const state = terminalSessionState(session);
      if (state === null || session.providerThreadId === undefined) continue;
      const profile = this.#store.requireProfileById(session.profileId);
      if (profile.state === "removed") continue;
      const personalBinding = this.#store.readSessionPersonalRuntimeBinding(session.id, true);
      const detachedArchiveHead = session.archivedAt !== undefined
        && personalBinding?.state === "detached"
        && personalBinding.provider === session.provider
        && personalBinding.providerThreadId === session.providerThreadId;
      let providerAuthority: ProviderAccountAuthority | undefined;
      let canReadProvider = false;
      try {
        const sessionAuthority = this.#store.requireSessionProviderAuthority(session.id);
        const candidate = providerAccountAuthorityOf(sessionAuthority);
        const account = this.#store.assertProviderAccountAuthorityCurrent(candidate);
        if (
          candidate.profileId === session.profileId
          && providerAccountCanReadExistingSession(sessionAuthority, account.readiness)
          && profileAllowsEstablishedSession(this.#store, profile, session, this.#platform)
        ) {
          providerAuthority = candidate;
          canReadProvider = true;
        }
      } catch {
        // Provider-unbound legacy sessions remain locally readable from the
        // compact cache but cannot trigger a fresh provider read.
      }
      const retired = session.provider === "devin";
      // Detach retires provider authority before it archives the local row. The
      // archived head is the cloud tombstone for a session that was projected
      // before detach, so it must remain publishable without reopening that
      // retired provider authority.
      let includeHead = canReadProvider || detachedArchiveHead || retired;
      if (cache !== null) {
        if (!canReadProvider) {
          try {
            for (const interaction of observedProjectionInteractions(this.#store, cache, session)) {
              if (interaction.terminalAt !== null) {
                cache.ingestInteraction(session.id, interaction, this.#registryNow());
              }
            }
            this.#projectionErrors.delete(session.id);
            includeHead = includeHead || cache.hasUncommittedEvents(session.id);
          } catch (error: unknown) {
            if (error instanceof ProjectionStreamRecoveryError) {
              this.#projectionRecoveryErrors.add(session.id);
            }
            this.#projectionErrors.set(
              session.id,
              error instanceof Error ? error : new Error("Local cloud session projection failed."),
            );
          }
        } else {
          let projectionError: Error | undefined;
          try {
            if (providerAuthority === undefined) {
              throw new Error("The session has no current provider-account authority.");
            }
            const projection = await this.#readSessionProjectionForCloud(
              session.id,
              input.signal,
            );
            throwIfAborted(input.signal);
            const currentSession = this.#store.requireSession(session.id);
            const currentSessionAuthority = this.#store.requireSessionProviderAuthority(
              currentSession.id,
            );
            const currentProviderAuthority = providerAccountAuthorityOf(
              currentSessionAuthority,
            );
            const currentProviderAccount = this.#store.assertProviderAccountAuthorityCurrent(
              providerAuthority,
            );
            if (
              projection.providerThreadId !== session.providerThreadId
              || currentSession.revision !== session.revision
              || currentSession.profileId !== session.profileId
              || currentSession.providerThreadId !== session.providerThreadId
              || currentProviderAuthority.bindingGeneration
                !== providerAuthority.bindingGeneration
              || currentProviderAuthority.processGeneration
                !== providerAuthority.processGeneration
              || currentProviderAuthority.profileId !== providerAuthority.profileId
              || currentProviderAuthority.provider !== providerAuthority.provider
              || currentProviderAuthority.providerAccountId
                !== providerAuthority.providerAccountId
              || !providerAccountCanReadExistingSession(
                currentSessionAuthority,
                currentProviderAccount.readiness,
              )
            ) {
              throw new Error("The provider runtime returned a session under different authority.");
            }
            for (const turn of completedProjectionTurns(this.#store, session, projection)) {
              cache.ingestTurn(session.id, turn.baseline.turnId, turn.bodies);
            }
          } catch (error: unknown) {
            rethrowWhenAborted(input.signal, error);
            projectionError = error instanceof Error
              ? error
              : new Error("Local cloud session projection failed.");
          }
          try {
            const current = projectionError === undefined
              ? currentProjectionInteractions(this.#store, cache, session)
              : null;
            const interactions = current?.interactions
              ?? observedProjectionInteractions(this.#store, cache, session)
                .filter((interaction) => interaction.terminalAt !== null);
            for (const interaction of interactions) {
              cache.ingestInteraction(session.id, interaction, this.#registryNow());
            }
            if (current !== null) {
              cache.advanceInteractionDiscoveryCursor(
                session.id,
                current.discoveryExpected,
                current.discoveryNext,
              );
            }
          } catch (error: unknown) {
            projectionError ??= error instanceof Error
              ? error
              : new Error("Local cloud session projection failed.");
          }
          if (projectionError === undefined) {
            this.#projectionErrors.delete(session.id);
          } else {
            if (projectionError instanceof ProjectionStreamRecoveryError) {
              this.#projectionRecoveryErrors.add(session.id);
            }
            this.#projectionErrors.set(session.id, projectionError);
          }
        }
      }
      if (!includeHead) continue;
      heads.push({
        createdAt: session.createdAt,
        metadata: {
          // Additive: the key appears only for an archived session, so an
          // unarchived session's metadata keeps its pre-archive bytes and
          // does not force a metadata update on every existing session.
          ...(session.archivedAt === undefined ? {} : { archived: true }),
          ...(retired ? { retiredProvider: "devin" as const } : {}),
          name: boundedName(session.title),
          note: boundedNote(session.note),
        },
        publicId: session.id,
        state,
        updatedAt: session.updatedAt,
      });
    }
    return {
      continueAfterPublicId: page.continueAfterId,
      isDone: page.isDone,
      sessions: heads,
    };
  }

  readCompactEvents(input: Readonly<{
    afterSequence: number;
    limit: number;
    remoteStreamEpoch?: number;
    remoteTailDigest?: string;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    cacheId: string;
    complete: boolean;
    events: readonly CompactSessionEvent[];
  }>> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    const projectionError = this.#projectionErrors.get(input.sessionPublicId);
    if (projectionError !== undefined) {
      if (projectionError instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(projectionError);
    }
    if (this.#cache === null) {
      return Promise.reject(new Error(this.#cacheStatus.state === "unavailable"
        ? this.#cacheStatus.diagnostic
        : "The cloud projection cache is unavailable."));
    }
    try {
      const value = this.#cache.read(
        input.sessionPublicId,
        input.afterSequence,
        input.remoteTailDigest,
        input.remoteStreamEpoch ?? 0,
        input.limit,
      );
      return Promise.resolve({ cacheId: this.#cache.cacheId(), ...value });
    } catch (error: unknown) {
      if (error instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(error);
    }
  }

  /*
   * Live projection source: the session's public event ledger after a local
   * sequence, narrowed to the kinds the live batcher renders. The session
   * public id is the local session id.
   */
  readLiveEvents(input: Readonly<{
    afterLocalSequence: number | null;
    limit: number;
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<Readonly<{
    events: readonly SessionEvent[];
    includeThinking: boolean;
    observedThroughSequence: number;
  }>> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    try {
      const page = this.#store.listSessionEvents({
        sessionId: sessionIdSchema.parse(input.sessionPublicId),
        afterSequence: input.afterLocalSequence,
        limit: input.limit,
      });
      const events = page.events.filter((event) =>
        event.body.type === "turn_started"
        || event.body.type === "turn_completed"
        || event.body.type === "assistant_delta"
        || event.body.type === "reasoning_summary_delta"
        || event.body.type === "subagent_activity"
        || event.body.type === "session_state");
      // The stored per-session setting (falling back to the daemon default)
      // decides; the constructor flag is a startup override that can only
      // turn summaries on, never force them off for a session that asked.
      const stored = this.#store.readSessionShowThinking(sessionIdSchema.parse(input.sessionPublicId));
      return Promise.resolve({
        events,
        includeThinking: this.#liveThinking || stored.enabled,
        observedThroughSequence: page.observedThroughSequence,
      });
    } catch (error: unknown) {
      return Promise.reject(error instanceof Error ? error : new Error("Local live projection failed."));
    }
  }

  /**
   * The device settings projection: machine, daemon defaults, accounts,
   * projects, Oompa conversation tasks, and provider-level personal-session
   * adoption aggregates. Codex Desktop automation metadata is private input
   * to the adoption age gate and never enters this projection. Candidate
   * detail and runtime provenance stay private too.
   */
  #startAccountObservation(
    profile: ProfileRecord,
    provider: "claude",
    signal: AbortSignal,
  ): boolean {
    const readProjection = this.#readProviderAccountProjectionForCloud;
    if (
      readProjection === undefined
      || this.#accountObservationsClosed
      || this.#accountObservationTasks.has(provider)
      || this.#accountObservationCleanupFailures.has(provider)
    ) return false;
    const authority = this.#store.requireProviderAccountAuthority(profile.id, provider);
    const account = this.#store.assertProviderAccountAuthorityCurrent(authority);
    if (account.readiness === "login_pending" || account.readiness === "recovery_required") return false;
    const key = `${provider}_${profile.id}`;
    const observation = {
      authority,
      observedAt: this.#registryNow(),
      signedIn: null as boolean | null,
    };
    this.#accountObservations.set(key, observation);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Provider account observation was canceled."));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => {
      controller.abort(new Error("Provider account observation exceeded its deadline."));
    }, 10_000);
    timer.unref();
    const task = Promise.resolve().then(async () => {
      throwIfAborted(controller.signal);
      const projection = await readProjection({
        authority,
        signal: controller.signal,
      });
      const signedIn = typeof projection.signedIn === "boolean" ? projection.signedIn : null;
      if (this.#accountObservationsClosed || controller.signal.aborted) return;
      if (this.#accountObservations.get(key) !== observation) return;
      if (!this.#accountObservationIsCurrent(observation)) return;
      if (signedIn === null) return;
      observation.signedIn = signedIn;
      observation.observedAt = this.#registryNow();
    }).catch((error: unknown) => {
      if (providerObservationCleanupFailed(error)) {
        this.#accountObservationCleanupFailures.add(provider);
      }
      // Unknown is omitted. Keep the attempt timestamp as bounded backoff,
      // including failures, rather than respawning a CLI on each bridge tick.
    }).finally(() => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (this.#accountObservationTasks.get(provider)?.task === task) {
        this.#accountObservationTasks.delete(provider);
      }
    });
    this.#accountObservationTasks.set(provider, { controller, key, task });
    this.#accountObservationCursors.set(provider, profile.id);
    return true;
  }

  #accountObservationIsCurrent(observation: Readonly<{
    authority: ProviderAccountAuthority;
    observedAt: number;
  }>): boolean {
    const now = this.#registryNow();
    if (observation.observedAt > now || now - observation.observedAt >= 60_000) return false;
    try {
      const account = this.#store.assertProviderAccountAuthorityCurrent(observation.authority);
      return account.readiness !== "login_pending" && account.readiness !== "recovery_required";
    } catch {
      return false;
    }
  }

  #deviceRegistryAccounts(
    signal: AbortSignal,
    refresh = true,
  ): readonly DeviceRegistryAccount[] {
    throwIfAborted(signal);
    if (this.#accountObservationsClosed) throw new Error("The cloud adapter is closed.");
    const profiles = this.#store.listProfiles()
      .filter((profile) => profile.state !== "removed")
      .slice(0, deviceRegistryLimits.accounts);
    const accounts: DeviceRegistryAccount[] = [];
    const providers: readonly "claude"[] =
      this.#readProviderAccountProjectionForCloud === undefined
        ? []
        : ["claude"];
    const currentKeys = new Set(profiles.flatMap((profile) =>
      providers.map((provider) => `${provider}_${profile.id}`)));
    for (const key of this.#accountObservations.keys()) {
      if (!currentKeys.has(key)) this.#accountObservations.delete(key);
    }
    for (const pending of this.#accountObservationTasks.values()) {
      if (!currentKeys.has(pending.key)) {
        pending.controller.abort(new Error("The observed provider account was removed."));
      }
    }

    // Selection is an ordered prefix of complete profile groups. A selected
    // profile retains Codex's historical raw id and every sibling-provider row
    // whose runtime proves an auth state; the 100-row protocol cap never leaves
    // a selected profile with only Codex because an earlier provider tier filled
    // the array. At most one slot remains unused when the next complete group
    // would cross the bound.
    for (const profile of profiles) {
      if (profile.state === "removed") continue;
      if (accounts.length >= deviceRegistryLimits.accounts) break;
      const label = registryLabel(profile.label, "Account");
      const codexAddress = deviceRegistryAccountAddress({
        kind: "local",
        profileId: profile.id,
        provider: "codex",
      });
      if (codexAddress === null) continue;
      const profileAccounts: DeviceRegistryAccount[] = [{
        label,
        provider: codexAddress.provider,
        publicId: codexAddress.publicId,
        status: profile.state,
      }];
      for (const provider of providers) {
        const key = `${provider}_${profile.id}`;
        const observed = this.#accountObservations.get(key);
        if (
          observed === undefined
          || !this.#accountObservationIsCurrent(observed)
        ) {
          this.#accountObservations.delete(key);
          const pending = this.#accountObservationTasks.get(provider);
          if (pending?.key === key) {
            pending.controller.abort(new Error("The observed provider authority changed."));
          }
          continue;
        }
        if (observed.signedIn === null) continue;
        const address = deviceRegistryAccountAddress({
          kind: "local",
          profileId: profile.id,
          provider,
        });
        if (address === null) continue;
        profileAccounts.push({
          label,
          provider: address.provider,
          publicId: address.publicId,
          status: observed.signedIn ? "signed_in" : "signed_out",
        });
      }
      if (accounts.length + profileAccounts.length > deviceRegistryLimits.accounts) break;
      accounts.push(...profileAccounts);
    }
    if (refresh && profiles.length > 0) {
      for (const provider of providers) {
        if (this.#accountObservationTasks.has(provider)) continue;
        const cursor = this.#accountObservationCursors.get(provider);
        const start = (profiles.findIndex((profile) => profile.id === cursor) + 1) % profiles.length;
        // A bounded round robin gives later profiles a turn even when earlier
        // observations expire before the registry's next bridge cycle.
        for (let offset = 0; offset < profiles.length; offset += 1) {
          const profile = profiles[(start + offset) % profiles.length];
          if (profile === undefined) continue;
          const observed = this.#accountObservations.get(`${provider}_${profile.id}`);
          if (
            observed !== undefined
            && this.#accountObservationIsCurrent(observed)
          ) continue;
          if (this.#startAccountObservation(profile, provider, signal)) break;
        }
      }
    }
    return accounts;
  }

  async #buildDeviceRegistryProjection(
    input: Readonly<{ signal: AbortSignal }>,
  ): Promise<CloudDeviceRegistryProjection> {
    if (input.signal.aborted) throw input.signal.reason;
    const accounts = this.#deviceRegistryAccounts(input.signal);
    const listedProjects = this.#store.listProjects().slice(0, deviceRegistryLimits.projects);
    const projects = listedProjects.map((project) => ({
      label: registryLabel(project.label, "Project"),
      publicId: project.id,
    }));
    // The default is projected only when it is within the listed bound, so
    // the registry never names a project it does not list.
    const defaultProjectPublicId = listedProjects.find((project) => project.default)?.id;
    const scheduledTasks: DeviceRegistryScheduledTask[] = this.#store.createSessionTaskStore()
      .listAll(deviceRegistryLimits.scheduledTasks)
      .map((task) => ({
        cadence: `every ${task.schedule.minutes} minutes`,
        id: task.id,
        kind: "hra_conversation" as const,
        label: registryLabel(task.name, "Scheduled task"),
        nextRunAt: task.nextDueAt,
        sessionPublicId: task.sessionId,
      }));
    const proseAutorespondConfigured = await this.#gatewayKeyCustody.hasKey();
    throwIfAborted(input.signal);
    const deviceCommandPolicy = this.#store.readDeviceCommandPolicy();
    const codexAdoption = this.#store.readSessionAdoptionCounts("codex");
    const claudeAdoption = this.#store.readSessionAdoptionCounts("claude");
    const sessionAdoption = {
      claude: {
        ...claudeAdoption,
        enabled: this.#store.readSessionAdoptionPolicy("claude")?.enabled ?? false,
      },
      codex: {
        ...codexAdoption,
        enabled: this.#store.readSessionAdoptionPolicy("codex")?.enabled ?? false,
      },
    } as const;
    // These synchronous reads each validate the composite row, and there is no
    // await between them. Comparing the shared revision makes a commit by a
    // second local process between the reads fail closed instead of publishing
    // consent from one revision with hours from another.
    const notificationHours = this.#store.readNotificationHours();
    const notificationEmail = this.#store.readNotificationEmailPolicy();
    if (notificationHours.revision !== notificationEmail.revision) {
      throw new Error("NOTIFICATION_POLICY_REVISION_DIVERGED");
    }
    // Read the tier once. Its current Codex interpretation belongs to this
    // publishing binary, not to a browser build or any established session.
    const defaultPreset = this.#store.readDefaultPreset();
    if (defaultPreset !== "low" && defaultPreset !== "high" && defaultPreset !== "ultra") {
      throw new Error("DEFAULT_CODEX_PROFILE_INVALID");
    }
    const defaultProfile = decodeHistoricalPresetProfile({
      contract: activePresetBinding(defaultPreset).contract,
      preset: defaultPreset,
      provider: "codex",
    });
    if (defaultProfile === null) throw new Error("DEFAULT_CODEX_PROFILE_INVALID");
    const registry = {
      accountLinkingAllowed: deviceCommandPolicy.accountLinkingAllowed,
      accounts,
      daemonVersion: registryLabel(OOMPA_VERSION, "unknown", deviceRegistryLimits.versionCharacters),
      defaultApprovalMode: this.#store.readDefaultApprovalMode(),
      defaultPreset,
      ...(defaultProjectPublicId === undefined ? {} : { defaultProjectPublicId }),
      deviceCommandsAllowed: deviceCommandPolicy.deviceCommandsAllowed,
      heartbeatAt: this.#registryNow(),
      machineLabel: this.#machineLabel,
      projects,
      proseAutorespondConfigured,
      scheduledTasks,
      sessionAdoption,
      showThinkingDefault: this.#store.readDefaultShowThinking(),
      version: 1,
    } satisfies DeviceRegistryPayload;
    return {
      notificationEmail,
      notificationHours,
      notificationPolicyRevision: notificationEmail.revision,
      profileBinding: { preset: defaultPreset, profileKey: defaultProfile.key },
      registry,
    };
  }

  async readDeviceRegistry(input: Readonly<{ signal: AbortSignal }>): Promise<DeviceRegistryPayload> {
    return (await this.#buildDeviceRegistryProjection(input)).registry;
  }

  async readDeviceRegistryProjection(
    input: Readonly<{ signal: AbortSignal }>,
  ): Promise<CloudDeviceRegistryProjection> {
    return await this.#buildDeviceRegistryProjection(input);
  }

  /**
   * The CLI composes cloud before the Oh coordinator. Bind exactly once after
   * both exist; the bridge does not start cycling until daemon composition is
   * complete, so no partially initialized summary can be published.
   */
  bindMemorySummarySource(
    source: (input: Readonly<{
      devicePublicId: string;
      signal: AbortSignal;
    }>) => Promise<MemorySummaryPayload>,
  ): void {
    if (this.readMemorySummary !== undefined) {
      throw new Error("Memory summary source is already bound.");
    }
    this.readMemorySummary = async (input) => {
      if (input.signal.aborted) throw input.signal.reason;
      const summary = await source(input);
      throwIfAborted(input.signal);
      return summary;
    };
  }

  async readAttentionNotificationSnapshot(input: Readonly<{
    limit: number;
    now: number;
    signal: AbortSignal;
  }>): Promise<LocalAttentionNotificationSnapshot> {
    if (input.signal.aborted) throw input.signal.reason;
    const snapshot = this.#store.readAttentionNotificationSnapshot({
      limit: input.limit,
      now: input.now,
    });
    // The two rows share one transactional revision. There is no await
    // between these reads, and a cross-process commit between them is caught
    // by the exact comparison rather than producing torn consent authority.
    const notificationHours = this.#store.readNotificationHours();
    const notificationEmail = this.#store.readNotificationEmailPolicy();
    if (notificationHours.revision !== notificationEmail.revision) {
      throw new Error("NOTIFICATION_POLICY_REVISION_DIVERGED");
    }
    const candidates = snapshot.status === "overflow"
      ? []
      : snapshot.interactions.map((interaction) => {
          if (interaction.sessionId === null) {
            throw new Error("ATTENTION_NOTIFICATION_SESSION_AUTHORITY_MISSING");
          }
          const policy = deriveRemoteInteractionPolicy({
            deadlineAt: interaction.deadlineAt,
            display: interaction.display,
            state: interaction.state,
          }, input.now);
          return {
            interactionDeadline: interaction.deadlineAt,
            interactionId: interaction.publicId,
            interactionKind: interaction.kind,
            interactionRevision: interaction.revision,
            remoteActions: [...policy.actions],
            sessionPublicId: interaction.sessionId,
          };
        });
    throwIfAborted(input.signal);
    return {
      candidates,
      notificationEmail,
      notificationHours,
      notificationPolicyRevision: notificationEmail.revision,
      observedAt: snapshot.observedAt,
      status: snapshot.status,
    };
  }

  async readNotificationHours(input: Readonly<{ signal: AbortSignal }>): Promise<NotificationHoursPolicy> {
    if (input.signal.aborted) throw input.signal.reason;
    return this.#store.readNotificationHours();
  }

  recordCompactUploadIntent(input: CompactUploadCheckpoint): Promise<void> {
    if (this.#cache === null) return Promise.reject(new Error("The cloud projection cache is unavailable."));
    try {
      this.#cache.recordUploadIntent(input);
      return Promise.resolve();
    } catch (error: unknown) {
      if (error instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(error);
    }
  }

  acknowledgeCompactUpload(input: CompactUploadCheckpoint): Promise<void> {
    if (this.#cache === null) return Promise.reject(new Error("The cloud projection cache is unavailable."));
    try {
      this.#cache.acknowledgeUpload(input);
      return Promise.resolve();
    } catch (error: unknown) {
      if (error instanceof ProjectionStreamRecoveryError) {
        this.#projectionRecoveryErrors.add(input.sessionPublicId);
      }
      return Promise.reject(error);
    }
  }

  async listUsage(input: Readonly<{ limit: number; signal: AbortSignal }>): Promise<readonly CloudLocalUsageSnapshot[]> {
    if (input.signal.aborted) throw input.signal.reason;
    const snapshots: CloudLocalUsageSnapshot[] = [];
    const profiles = this.#store.listProfiles().filter((profile) =>
      profile.state === "signed_in"
      && profile.processGeneration > 0
      && profile.providerEmail !== undefined,
    );
    for (const profile of profiles.slice(0, input.limit)) {
      if (profile.providerEmail === undefined) continue;
      const latest = this.#store.latestUsageForAccount(
        profile.id,
        accountFingerprint(profile.providerEmail),
      );
      if (latest === null) continue;
      snapshots.push({
        localReference: profile.id,
        matchReference: profile.providerEmail,
        metadata: {
          label: boundedText(profile.label, 160),
          email: boundedText(profile.providerEmail, 320),
          plan: profile.providerPlan === undefined ? null : boundedText(profile.providerPlan, 160),
        },
        observedAt: latest.observedAt,
        projection: projectStoredUsage(latest.payload),
        sourceGeneration: profile.processGeneration,
        sourceRevision: latest.sourceRevision,
      });
    }
    return snapshots;
  }

  async listUsageHistory(input: Readonly<{
    afterSourceRevision: number;
    limit: number;
    localReference: string;
    signal: AbortSignal;
    sourceGeneration: number;
  }>): Promise<readonly CloudLocalUsageSnapshot[]> {
    if (input.signal.aborted) throw input.signal.reason;
    const profile = this.#store.requireProfileById(input.localReference);
    if (
      profile.state !== "signed_in"
      || profile.processGeneration !== input.sourceGeneration
      || profile.providerEmail === undefined
    ) return [];
    const providerEmail = profile.providerEmail;
    const providerAccountFingerprint = accountFingerprint(providerEmail);
    const metadata = {
      label: boundedText(profile.label, 160),
      email: boundedText(providerEmail, 320),
      plan: profile.providerPlan === undefined ? null : boundedText(profile.providerPlan, 160),
    } as const;
    return this.#store.usageAfterRevision({
      accountFingerprint: providerAccountFingerprint,
      afterSourceRevision: input.afterSourceRevision,
      limit: input.limit,
      profileId: profile.id,
    }).map((snapshot) => ({
      localReference: profile.id,
      matchReference: providerEmail,
      metadata,
      observedAt: snapshot.observedAt,
      projection: projectStoredUsage(snapshot.payload),
      sourceGeneration: profile.processGeneration,
      sourceRevision: snapshot.sourceRevision,
    }));
  }

  resolveCommandAuthority(input: Readonly<{
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudLocalCommandAuthority | null> {
    if (input.signal.aborted) return Promise.reject(input.signal.reason);
    try {
      const session = this.#store.requireSession(input.sessionPublicId);
      const sessionAuthority = this.#store.requireSessionProviderAuthority(session.id);
      const providerAuthority = providerAccountAuthorityOf(sessionAuthority);
      const providerAccount = this.#store.assertProviderAccountAuthorityCurrent(providerAuthority);
      const profile = this.#store.requireProfileById(providerAuthority.profileId);
      if (
        session.id !== input.sessionPublicId
        || session.profileId !== providerAuthority.profileId
        || session.providerThreadId === undefined
        || session.state === "starting"
        || session.state === "recovery_required"
        || !providerAccountCanReadExistingSession(sessionAuthority, providerAccount.readiness)
        || !profileAllowsEstablishedSession(this.#store, profile, session, this.#platform)
      ) return Promise.resolve(null);
      return Promise.resolve({
        bindingGeneration: providerAuthority.bindingGeneration,
        localSessionId: session.id,
        processGeneration: providerAuthority.processGeneration,
        profileId: profile.id,
        provider: providerAuthority.provider,
        providerAccountId: providerAuthority.providerAccountId,
        providerThreadId: session.providerThreadId,
      });
    } catch {
      return Promise.resolve(null);
    }
  }

  async execute(input: Readonly<{
    authority: CloudLocalCommandAuthority;
    idempotencyKey: string;
    leaseAuthority: AuthorityTuple;
    payload: Parameters<CloudCommandExecutorPort["execute"]>[0]["payload"];
    sessionPublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudCommandExecutionResult> {
    if (input.signal.aborted) throw input.signal.reason;
    // Reject stale provider selections even for an already-decoded command.
    // Other kinds retain their existing, more specific refusal codes below.
    if (
      (input.payload.kind === "set_provider" || input.payload.kind === "set_model"
        || input.payload.kind === "set_default_preset")
      && parseRemoteCommandPayload(input.payload) === null
    ) {
      return { code: "COMMAND_PAYLOAD_INVALID", state: "failed" };
    }
    try {
      if (this.#store.requireSession(input.sessionPublicId).provider === "devin") {
        return { code: "PROVIDER_RETIRED", state: "failed" };
      }
      const context = (() => {
        try {
          const session = this.#store.requireSession(input.sessionPublicId);
          const sessionAuthority = this.#store.requireSessionProviderAuthority(session.id);
          const providerAuthority = providerAccountAuthorityOf(sessionAuthority);
          const providerAccount = this.#store.assertProviderAccountAuthorityCurrent(
            providerAuthority,
          );
          const profile = this.#store.requireProfileById(providerAuthority.profileId);
          return { profile, providerAccount, providerAuthority, session, sessionAuthority };
        } catch {
          return null;
        }
      })();
      if (context === null) return { code: "LOCAL_AUTHORITY_CHANGED", state: "failed" };
      const { profile, providerAccount, providerAuthority, session, sessionAuthority } = context;
      if (
        session.id !== input.sessionPublicId
        || session.id !== input.authority.localSessionId
        || session.profileId !== providerAuthority.profileId
        || profile.id !== input.authority.profileId
        || providerAuthority.bindingGeneration !== input.authority.bindingGeneration
        || providerAuthority.provider !== input.authority.provider
        || providerAuthority.providerAccountId !== input.authority.providerAccountId
        || providerAuthority.processGeneration !== input.authority.processGeneration
        || session.providerThreadId === undefined
        || session.providerThreadId !== input.authority.providerThreadId
        || session.state === "starting"
        || session.state === "recovery_required"
        || !providerAccountCanReadExistingSession(sessionAuthority, providerAccount.readiness)
        || !profileAllowsEstablishedSession(this.#store, profile, session, this.#platform)
      ) return { code: "LOCAL_AUTHORITY_CHANGED", state: "failed" };

      // Hosted attachments are materialized into the same local
      // content-addressed custody the CLI writes, before any provider effect.
      // The command that follows carries digests only.
      const materialized = await materializeRemoteAttachments(
        this.#attachmentBlobs(),
        input.payload,
      );
      if (materialized.kind === "refused") {
        return { code: materialized.code, state: "failed" };
      }
      const attached = materialized.values.length === 0
        ? {}
        : { attachments: [...materialized.values] };

      let command: ProviderRemoteLocalCommand;
      switch (input.payload.kind) {
          // Settings commands change local daemon state only: they never
          // reach the provider, so they settle without an execution round
          // trip. They still run in the ordinary command lane.
          case "set_approval_mode":
          case "set_show_thinking":
          case "set_default_preset":
          case "archive_session":
          case "set_gateway_key":
            return await this.#applySettingCommand(session.id, input.payload);
          case "send":
            command = { kind: "session.send", session: session.id, message: input.payload.message, ...attached, idempotencyKey: input.idempotencyKey };
            break;
          case "queue":
            command = { kind: "session.queue", session: session.id, message: input.payload.message, ...attached, idempotencyKey: input.idempotencyKey };
            break;
          case "steer":
            command = { kind: "session.steer", session: session.id, message: input.payload.message, ...attached, idempotencyKey: input.idempotencyKey };
            break;
          case "stop":
            command = { kind: "session.stop", session: session.id, idempotencyKey: input.idempotencyKey };
            break;
          case "set_model":
            command = {
              kind: "session.preset",
              session: session.id,
              preset: input.payload.preset,
              idempotencyKey: input.idempotencyKey,
            };
            break;
          // A provider switch is a provider effect, not a setting: it ends one
          // provider thread and starts another. It therefore runs on the
          // ordinary execution path under the same lease as a turn.
          case "set_provider":
            command = {
              kind: "session.switch",
              session: session.id,
              provider: input.payload.provider,
              ...("preset" in input.payload ? { preset: input.payload.preset } : {}),
              ...("presetContract" in input.payload
                ? { presetContract: input.payload.presetContract }
                : {}),
              idempotencyKey: input.idempotencyKey,
            };
            break;
          case "set_fast":
            command = { kind: "session.fast", session: session.id, enabled: input.payload.enabled, idempotencyKey: input.idempotencyKey };
            break;
          case "send_or_steer":
            // Resolved at execution time: the requester's view of "turn
            // active" is stale by design, so the custodian decides.
            command = session.activeTurnId === undefined
              ? { kind: "session.send", session: session.id, message: input.payload.message, ...attached, idempotencyKey: input.idempotencyKey }
              : { kind: "session.steer", session: session.id, message: input.payload.message, ...attached, idempotencyKey: input.idempotencyKey };
            break;
          case "rename_session":
            // A cleared name is the default title, not an empty one: the
            // provider has no "no title" state, so `null` resets the session
            // to the same title a fresh session starts with.
            command = {
              kind: "session.rename",
              session: session.id,
              name: input.payload.name ?? defaultSessionTitle,
              idempotencyKey: input.idempotencyKey,
            };
            break;
          case "resolve_interaction": {
            const verified = verifyRemoteInteraction(
              this.#store,
              session.id,
              input.payload,
              this.#registryNow(),
            );
            if (verified.kind === "refused") return { code: verified.code, state: "failed" };
            command = {
              kind: "interaction.resolve",
              interaction: input.payload.interactionId,
              expectedRevision: input.payload.revision,
              resolution: verified.resolution,
            };
            break;
          }
      }
      await this.#executeRemote(command, {
        bindingGeneration: providerAuthority.bindingGeneration,
        processGeneration: providerAuthority.processGeneration,
        profileId: profile.id,
        provider: providerAuthority.provider,
        providerAccountId: providerAuthority.providerAccountId,
        providerThreadId: session.providerThreadId,
        sessionId: session.id,
      }, { signal: input.signal });
      return { code: "APPLIED", state: "applied" };
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
      if (code === "RECOVERY_REQUIRED" || code === "INTERNAL" || code === "UNKNOWN") {
        return { code: `LOCAL_${code}`.slice(0, 64), state: "ambiguous" };
      }
      return { code: `LOCAL_${code.replace(/[^A-Z0-9_]/gu, "_")}`.slice(0, 64), state: "failed" };
    }
  }

  /**
   * Apply a settings command against local state. `rename_session` is
   * deliberately not here: renaming is observable to the provider, so it
   * stays on the ordinary provider execution path.
   *
   * The gateway key is written straight into local secret custody. Nothing
   * about its value is returned, journalled, or logged; the caller only ever
   * learns that a key was set.
   */
  #attachmentBlobs(): AttachmentBlobStore {
    return this.#attachmentBlobStore;
  }

  async #applySettingCommand(
    sessionId: SessionRecord["id"],
    payload: SettingCommandPayload,
  ): Promise<CloudCommandExecutionResult> {
    switch (payload.kind) {
      case "set_approval_mode":
        if (payload.scope === "default") this.#store.setDefaultApprovalMode(payload.mode);
        else this.#store.setSessionApprovalMode(sessionId, payload.mode);
        return { code: "APPLIED", state: "applied" };
      case "set_show_thinking":
        if (payload.scope === "default") this.#store.setDefaultShowThinking(payload.enabled);
        else this.#store.setSessionShowThinking(sessionId, payload.enabled);
        return { code: "APPLIED", state: "applied" };
      case "set_default_preset":
        this.#store.setDefaultPreset(payload.preset);
        return { code: "APPLIED", state: "applied" };
      case "archive_session":
        this.#store.setSessionArchived(sessionId, payload.archived);
        return { code: "APPLIED", state: "applied" };
      case "set_gateway_key":
        await this.#gatewayKeyCustody.setKey(payload.key);
        return { code: "APPLIED", state: "applied" };
    }
  }

  /*
   * Device commands. Every guard is evaluated here, before any effect, from
   * purely local state: the two `oompa remote allow|deny` switches, the requesting
   * device's day bucket, and the account and project the registry projected.
   * Only after `deviceCommandGuardDecision` admits the request does anything
   * reach the provider.
   */
  async executeDeviceCommand(input: Readonly<{
    idempotencyKey: string;
    payload: DeviceCommandPayload;
    requestingDevicePublicId: string;
    signal: AbortSignal;
  }>): Promise<CloudDeviceCommandExecutionResult> {
    if (input.signal.aborted) throw input.signal.reason;
    const policy = this.#store.readDeviceCommandPolicy();
    if (!policy.deviceCommandsAllowed) {
      return { code: "DEVICE_COMMANDS_DENIED", state: "failed" };
    }
    if (parseDeviceCommandPayload(input.payload) === null) {
      return { code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", state: "failed" };
    }
    if (
      (input.payload.kind === "account_login_start"
        || input.payload.kind === "account_login_status")
      && !policy.accountLinkingAllowed
    ) return { code: "ACCOUNT_LINKING_DENIED", state: "failed" };
    const loginAccountAddress = (
      (input.payload.kind === "account_login_start" || input.payload.kind === "account_login_status")
      && "accountPublicId" in input.payload
    ) ? deviceRegistryAccountAddress({ kind: "public", publicId: input.payload.accountPublicId }) : null;
    if (loginAccountAddress !== null && loginAccountAddress.provider !== "codex") {
      return { code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", state: "failed" };
    }
    if (input.payload.kind === "session_start") {
      const address = deviceRegistryAccountAddress({ kind: "public", publicId: input.payload.accountPublicId });
      if (address !== null && address.provider !== input.payload.provider) {
        return { code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", state: "failed" };
      }
    }
    // Registry observations are auxiliary. Command admission never starts a
    // sweep: Codex uses durable local facts; optional-provider starts require
    // a fresh observed row and the service rechecks auth before its effect.
    const accounts = input.payload.kind === "session_start"
      || input.payload.kind === "account_login_start"
      || (input.payload.kind === "account_login_status" && "accountPublicId" in input.payload)
      ? this.#deviceRegistryAccounts(input.signal, false)
      : [];
    const decision = deviceCommandGuardDecision({
      accountLinkingAllowed: policy.accountLinkingAllowed,
      accounts,
      deviceCommandsAllowed: policy.deviceCommandsAllowed,
      ledger: this.#store.readDeviceCommandLedger(input.requestingDevicePublicId),
      now: this.#registryNow(),
      payload: input.payload,
      projectPublicIds: this.#store.listProjects().map((project) => project.id),
      requestingDeviceActive: true,
    });
    if (decision.kind === "refused") return { code: decision.code, state: "failed" };
    const sessionStartAccount = input.payload.kind === "session_start"
      ? deviceRegistryAccountAddress({ kind: "public", publicId: input.payload.accountPublicId })
      : null;
    if (
      input.payload.kind === "session_start"
      && (sessionStartAccount === null || sessionStartAccount.provider !== input.payload.provider)
    ) return { code: "DEVICE_COMMAND_PROVIDER_UNSUPPORTED", state: "failed" };
    this.#store.recordDeviceCommandAdmission({
      dayCount: decision.dayCount,
      dayKey: decision.dayKey,
      devicePublicId: input.requestingDevicePublicId,
      notifiedFirstSessionStart: decision.notifyFirstSessionStart,
    });
    if (decision.notifyFirstSessionStart) {
      await this.#notifyOperator({
        body: "A browser device started its first session on this machine. Run `oompa remote deny device-commands` to stop accepting them.",
        title: "Oompa: new device started a session",
      });
    }
    try {
      switch (input.payload.kind) {
        case "session_start":
          if (sessionStartAccount === null) {
            return { code: "DEVICE_COMMAND_ACCOUNT_UNKNOWN", state: "failed" };
          }
          return await this.#startSessionForDevice(
            input.payload,
            sessionStartAccount.profileId,
            input.idempotencyKey,
            input.signal,
          );
        case "account_login_start":
          return await this.#startAccountLoginRelay(
            input.payload,
            input.idempotencyKey,
            input.signal,
          );
        case "account_login_status":
          return this.#accountLoginStatus(input.payload);
        case "usage_refresh":
          return await this.#refreshUsageForDevice(input.signal);
        case "set_notification_hours":
          this.#store.updateNotificationHours({
            endMinute: input.payload.endMinute,
            expectedRevision: input.payload.expectedRevision,
            startMinute: input.payload.startMinute,
            timeZone: input.payload.timeZone,
            version: input.payload.version,
          });
          return { code: "APPLIED", state: "applied" };
      }
    } catch (error: unknown) {
      const message = error instanceof Error
        ? error.message
        : isRecord(error) && typeof error.message === "string"
        ? error.message
        : typeof error === "string"
        ? error
        : "";
      const code = isRecord(error) && typeof error.code === "string"
        ? error.code
        : message === "NOTIFICATION_HOURS_REVISION_CONFLICT"
        ? "NOTIFICATION_HOURS_REVISION_CONFLICT"
        : message === "NOTIFICATION_HOURS_REVISION_EXHAUSTED"
        ? "NOTIFICATION_HOURS_REVISION_EXHAUSTED"
        : "UNKNOWN";
      if (code === "RECOVERY_REQUIRED" || code === "INTERNAL" || code === "UNKNOWN") {
        return { code: `LOCAL_${code}`.slice(0, 64), state: "ambiguous" };
      }
      return { code: `LOCAL_${code.replace(/[^A-Z0-9_]/gu, "_")}`.slice(0, 64), state: "failed" };
    }
  }

  /*
   * Start-then-send under one idempotency key.
   *
   * The two effects are derived deterministically from the device command's own
   * public id, so a replay reaches the same two local mutations rather than a
   * second session. The quarantine rule is the important half: once the start
   * has committed, a failure in the send can never be reported as `failed`,
   * because a session does exist. It settles `ambiguous` carrying no result, and
   * the browser reconciles by looking for the new session rather than retrying.
   */
  async #startSessionForDevice(
    payload: Extract<DeviceCommandPayload, { kind: "session_start" }>,
    profileId: ProfileId,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<CloudDeviceCommandExecutionResult> {
    const startKey = deriveDeviceEffectKey(idempotencyKey, "session-start");
    const sendKey = deriveDeviceEffectKey(idempotencyKey, "session-send");
    let sessionPublicId: string;
    try {
      const started = await this.#executeLocal({
        account: profileId,
        fast: false,
        idempotencyKey: startKey,
        kind: "session.start",
        preset: payload.preset,
        ...("presetContract" in payload
          ? { presetContract: payload.presetContract }
          : {}),
        project: payload.projectPublicId,
        provider: payload.provider,
      }, { signal });
      sessionPublicId = requireStartedSessionId(started);
    } catch (error: unknown) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "UNKNOWN";
      // Nothing was sent, and the start path already quarantines its own
      // uncertain provider effect, so an uncertain start is ambiguous here too.
      return code === "RECOVERY_REQUIRED" || code === "INTERNAL" || code === "UNKNOWN"
        ? { code: "LOCAL_SESSION_START_INDETERMINATE", state: "ambiguous" }
        : { code: `LOCAL_${code.replace(/[^A-Z0-9_]/gu, "_")}`.slice(0, 64), state: "failed" };
    }
    // The session exists from here on. Inheriting the project's approval mode
    // happens before the prompt, so the first turn is already governed by it.
    this.#store.setSessionApprovalMode(
      sessionPublicId,
      this.#store.readProjectApprovalMode(payload.projectPublicId).mode,
    );
    try {
      await this.#executeLocal({
        idempotencyKey: sendKey,
        kind: "session.send",
        message: payload.prompt,
        session: sessionPublicId,
      }, { signal });
    } catch {
      // A started session whose prompt may or may not have been delivered is
      // exactly the ambiguous case: never retried, never reported as a clean
      // failure, and the session id is withheld so no client treats it as a
      // completed start.
      return { code: "LOCAL_SESSION_SEND_INDETERMINATE", state: "ambiguous" };
    }
    return {
      code: "APPLIED",
      result: { kind: "session_start", sessionPublicId },
      state: "applied",
    };
  }

  async #startAccountLoginRelay(
    payload: Extract<DeviceCommandPayload, { kind: "account_login_start" }>,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<CloudDeviceCommandExecutionResult> {
    // A legacy requester cannot carry Codex's device code. Refuse it before
    // starting the distinct browser flow, whose localhost callback cannot be
    // completed safely from another device.
    if (payload.handoffVersion !== 2) {
      return { code: "ACCOUNT_LOGIN_RELAY_UNAVAILABLE", state: "failed" };
    }
    const response = await this.#executeLocal({
      account: payload.accountPublicId,
      // A browser on another device cannot complete Codex's loopback browser
      // login. The web lane is therefore always the managed device-code flow.
      deviceCode: true,
      idempotencyKey: deriveDeviceEffectKey(idempotencyKey, "account-login"),
      kind: "account.login",
    }, { signal });
    const handoff = relayedLoginHandoffFrom(response);
    // Both values are required to complete Codex device authorization. Refuse
    // an incomplete or unsafe handoff rather than spending the single-use read
    // on a login the requesting browser cannot finish.
    if (handoff === null) return { code: "ACCOUNT_LOGIN_RELAY_UNAVAILABLE", state: "failed" };
    return {
      code: "APPLIED",
      result: {
        expiresAt: this.#registryNow() + deviceCommandLoginResultLifetimeMs,
        handoffVersion: 2,
        kind: "account_login_start",
        loginUrl: handoff.loginUrl,
        userCode: handoff.userCode,
      },
      singleUseResult: true,
      state: "applied",
    };
  }

  #accountLoginStatus(
    payload: Extract<DeviceCommandPayload, { kind: "account_login_status" }>,
  ): CloudDeviceCommandExecutionResult {
    if ("accountPublicId" in payload) {
      const profile = this.#store.requireProfile(payload.accountPublicId);
      const status: DeviceCommandLoginStatus = profile.state === "login_pending"
        ? "pending"
        : profile.state === "signed_in"
          ? "signed_in"
          : profile.state === "recovery_required"
            ? "failed"
            : "idle";
      const instruction = status === "pending"
        ? `A login is in progress for this account. Finish its existing browser or device-code handoff, or cancel it with \`oompa account login-cancel ${profile.id}\`.`
        : status === "signed_in"
          ? "This account is signed in on this machine."
          : status === "failed"
            ? `This account needs local recovery. Inspect it with \`oompa account show ${profile.id}\` before starting another login.`
            : `No login is in progress for this account. Start one on this machine with \`oompa account login ${profile.id}\`.`;
      return {
        code: "APPLIED",
        result: { instruction, kind: "account_login_status", status },
        state: "applied",
      };
    }

    // Compatibility for an account-less request from a legacy browser. The
    // current app never uses this machine-wide view because multiple profiles
    // may independently have a login in progress.
    const pending = this.#store.listProfiles()
      .some((profile) => profile.state === "login_pending");
    return {
      code: "APPLIED",
      result: {
        instruction: pending
          ? "A login is in progress on this machine. Finish it in the browser it opened, or cancel it with `oompa account login-cancel <account>`."
          : "No login is in progress. Start one on this machine with `oompa account login <account>`.",
        kind: "account_login_status",
        status: pending ? "pending" : "idle",
      },
      state: "applied",
    };
  }

  async #refreshUsageForDevice(signal: AbortSignal): Promise<CloudDeviceCommandExecutionResult> {
    let accountsRefreshed = 0;
    for (const profile of this.#store.listProfiles()) {
      if (profile.state !== "signed_in") continue;
      await this.#executeLocal({
        account: profile.id,
        kind: "account.usage",
        refresh: true,
      }, { signal });
      accountsRefreshed += 1;
    }
    return {
      code: "APPLIED",
      result: { accountsRefreshed, kind: "usage_refresh" },
      state: "applied",
    };
  }
}

/**
 * A second effect key derived from the device command's own public id. The
 * derivation is deterministic, so a replayed device command reaches the same
 * two local mutation authorities instead of starting a second session.
 */
export function deriveDeviceEffectKey(idempotencyKey: string, purpose: string): string {
  const digest = createHash("sha256")
    .update(`hra-control-plane-device-command-effect:v1\n${purpose}\n${idempotencyKey}`)
    .digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `${((Number.parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16)}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function requireStartedSessionId(value: unknown): string {
  if (
    !isRecord(value)
    || !isRecord(value.session)
    || typeof value.session.id !== "string"
    || value.session.id.length === 0
  ) throw new Error("Local session start did not return a session identity.");
  return value.session.id;
}

/**
 * The complete relayable provider device-code handoff, or null when the
 * daemon's login response is incomplete or unsafe for another device.
 */
function relayedLoginHandoffFrom(
  value: unknown,
): Readonly<{ loginUrl: string; userCode: string }> | null {
  if (!isRecord(value) || !isRecord(value.login)) return null;
  const loginUrl: unknown = value.login.verificationUrl;
  const userCode: unknown = value.login.userCode;
  return value.login.status === "pending"
    && isRelayedLoginUrl(loginUrl)
    && isRelayedLoginUserCode(userCode)
    ? { loginUrl, userCode }
    : null;
}

type RemoteInteractionVerification =
  | Readonly<{ kind: "refused"; code: string }>
  | Readonly<{ kind: "verified"; resolution: Extract<LocalCommand, { kind: "interaction.resolve" }>["resolution"] }>;

/*
 * The final custodian gate first binds the request to one live session,
 * interaction revision, pending state, and deadline. It then recomputes the
 * same pure policy the compact projection used. No mirrored kind matrix can
 * grant an action: the requested canonical action must be a member of that
 * exact live policy before its answer values are validated and translated to
 * the ordinary local resolution.
 */
function verifyRemoteInteraction(
  store: StateStore,
  sessionId: SessionRecord["id"],
  payload: Extract<RemoteCommandPayload, { kind: "resolve_interaction" }>,
  now: number,
): RemoteInteractionVerification {
  let interaction: InteractionRecord;
  try {
    interaction = store.requireInteraction(payload.interactionId);
  } catch {
    return { kind: "refused", code: "INTERACTION_NOT_FOUND" };
  }
  if (interaction.sessionId !== sessionId) return { kind: "refused", code: "INTERACTION_SESSION_MISMATCH" };
  if (interaction.state !== "pending") return { kind: "refused", code: "INTERACTION_ALREADY_RESOLVED" };
  if (interaction.revision !== payload.revision) return { kind: "refused", code: "INTERACTION_REVISION_STALE" };
  if (now >= interaction.deadlineAt) return { kind: "refused", code: "INTERACTION_EXPIRED" };
  if ("decision" in payload && payload.decision === "cancel") {
    return { kind: "refused", code: "INTERACTION_CANCEL_NOT_REMOTE" };
  }
  const requestedAction: RemoteInteractionAction | "approve_once" = "answers" in payload
    ? "answer"
    : payload.decision === "once"
      ? "approve_once"
      : "decline";
  const policy = deriveRemoteInteractionPolicy({
    deadlineAt: interaction.deadlineAt,
    display: interaction.display,
    state: interaction.state,
  }, now);
  if (requestedAction === "approve_once" || !policy.actions.includes(requestedAction)) {
    return {
      kind: "refused",
      code: unavailableRemoteInteractionCode(interaction.display, requestedAction, policy.reasonCodes),
    };
  }
  if (requestedAction === "answer" && "answers" in payload) {
    return verifyRemoteInteractionAnswers(policy.questions, payload.answers);
  }
  if (requestedAction === "decline") {
    return { kind: "verified", resolution: { kind: "approval_decision", decision: "decline" } };
  }
  return { kind: "refused", code: "INTERACTION_DECISION_UNAVAILABLE" };
}

function unavailableRemoteInteractionCode(
  display: InteractionDisplay,
  requestedAction: RemoteInteractionAction | "approve_once",
  reasonCodes: readonly string[],
): string {
  if (requestedAction === "answer") {
    if (
      display.kind === "user_input"
      && reasonCodes.includes("USER_INPUT_SECRET_QUESTION")
    ) return "INTERACTION_SECRET_ANSWER_REFUSED";
    return display.kind === "mcp_elicitation"
      ? "INTERACTION_ELICITATION_NOT_REMOTE"
      : "INTERACTION_ANSWERS_NOT_REMOTE";
  }
  if (display.kind === "user_input" || display.kind === "mcp_elicitation") {
    return "INTERACTION_DECISION_NOT_REMOTE";
  }
  if (display.kind === "file_change_approval" && requestedAction === "approve_once") {
    return "INTERACTION_FILE_CHANGE_ACCEPT_NOT_REMOTE";
  }
  if (display.kind === "permission_approval") {
    return "INTERACTION_PERMISSION_APPROVAL_LOCAL_ONLY";
  }
  if (display.kind === "command_approval" && requestedAction === "approve_once") {
    return "INTERACTION_COMMAND_APPROVAL_LOCAL_ONLY";
  }
  return "INTERACTION_DECISION_UNAVAILABLE";
}

function verifyRemoteInteractionAnswers(
  questions: ReturnType<typeof deriveRemoteInteractionPolicy>["questions"],
  submitted: Readonly<Record<string, Readonly<{ answers: readonly string[] }>>>,
): RemoteInteractionVerification {
  const known = new Map(questions.map((question) => [question.id, question]));
  const submittedAnswers = new Map(Object.entries(submitted));
  if ([...submittedAnswers.keys()].some((id) => !known.has(id))) {
    return { kind: "refused", code: "INTERACTION_ANSWER_CONSTRAINT_FAILED" };
  }
  if (questions.length === 0 || submittedAnswers.size !== questions.length) {
    return { kind: "refused", code: "INTERACTION_ANSWER_CONSTRAINT_FAILED" };
  }
  for (const question of questions) {
    const values = submittedAnswers.get(question.id)?.answers;
    if (
      question.options.length === 0
      || values === undefined
      || values.length !== 1
      || values[0]?.length === 0
      || values.some((value) =>
        value.length > remoteInteractionAnswerLimits.codeUnits
        || containsSecretShapedText(value)
        || !question.options.some((option) => option.label === value))
    ) {
      return { kind: "refused", code: "INTERACTION_ANSWER_CONSTRAINT_FAILED" };
    }
  }
  const answers = Object.fromEntries(questions.map((question) => [
    question.id,
    { answers: [...(submittedAnswers.get(question.id)?.answers ?? [])] },
  ]));
  if (!remoteInteractionJsonFitsProviderLimit(answers)) {
    return { kind: "refused", code: "INTERACTION_ANSWER_CONSTRAINT_FAILED" };
  }
  return { kind: "verified", resolution: { kind: "user_answers", answers } };
}

export class BridgedCloudControl implements CloudControlPort, CloudRemoteControlPort {
  readonly #bridge: CloudDaemonBridge;
  readonly #control: CloudControlPort & CloudRemoteControlPort;
  readonly #projectionStatus: (() => CloudProjectionCacheStatus) | undefined;
  readonly #syncCadence: (() => CloudSyncCadenceStatus) | undefined;

  constructor(
    control: CloudControlPort & CloudRemoteControlPort,
    bridge: CloudDaemonBridge,
    projectionDiagnostics?: Readonly<{ projectionCacheStatus(): CloudProjectionCacheStatus }>,
    cadenceDiagnostics?: Readonly<{ syncCadence(): CloudSyncCadenceStatus }>,
  ) {
    this.#control = control;
    this.#bridge = bridge;
    this.#projectionStatus = projectionDiagnostics === undefined
      ? undefined
      : () => projectionDiagnostics.projectionCacheStatus();
    this.#syncCadence = cadenceDiagnostics === undefined
      ? undefined
      : () => cadenceDiagnostics.syncCadence();
  }

  async status(signal: AbortSignal): Promise<unknown> {
    const status = await this.#control.status(signal);
    const projectionCache = this.#projectionStatus?.();
    const projectionRecovery = await this.#bridge.projectionRecoveryStatus?.();
    const syncCadence = this.#syncCadence?.();
    if (
      projectionCache === undefined
      && projectionRecovery === undefined
      && syncCadence === undefined
    ) return status;
    const additions = {
      ...(projectionCache === undefined ? {} : { projectionCache }),
      ...(projectionRecovery === undefined ? {} : { projectionRecovery }),
      ...(syncCadence === undefined ? {} : { syncCadence }),
    };
    return isRecord(status)
      ? { ...status, ...additions }
      : { control: status, ...additions };
  }
  async observeAttentionNotificationAuthority(
    signal: AbortSignal,
  ): Promise<NotificationEmailHostedAuthority> {
    if (this.#bridge.observeAttentionNotificationAuthority !== undefined) {
      return await this.#bridge.observeAttentionNotificationAuthority(signal);
    }
    if (this.#control.observeAttentionNotificationAuthority !== undefined) {
      return await this.#control.observeAttentionNotificationAuthority(signal);
    }
    return { state: "not_observed" };
  }
  async invalidateAttentionNotificationAuthority(input: {
    localNotificationPolicyRevision: number;
    signal: AbortSignal;
  }): Promise<Extract<
    NotificationEmailHostedAuthority,
    { state: "acknowledged" | "not_observed" | "revocation_pending" }
  >> {
    if (this.#bridge.invalidateAttentionNotificationAuthority !== undefined) {
      return await this.#bridge.invalidateAttentionNotificationAuthority(input);
    }
    if (this.#control.invalidateAttentionNotificationAuthority !== undefined) {
      return await this.#control.invalidateAttentionNotificationAuthority(input);
    }
    throw new Error("Hosted attention notification invalidation is unavailable.");
  }
  async auth(input: { email: string; code?: string; invite?: string; signal: AbortSignal }): Promise<unknown> {
    if (input.code !== undefined) {
      if (this.#bridge.close === undefined) {
        throw new Error("Cloud identity changes require a quiescent daemon bridge.");
      }
      await this.#bridge.close();
    }
    const value = await this.#control.auth(input);
    return input.code !== undefined && isRecord(value) && value.signedIn === true
      ? { ...value, daemonRestartRequired: true }
      : value;
  }
  logout(signal: AbortSignal): Promise<void> { return this.#control.logout(signal); }
  async deleteAccount(input: { acknowledgeErasure: boolean; signal: AbortSignal }): Promise<unknown> {
    if (this.#bridge.close === undefined) {
      throw new Error("Cloud account erasure requires a quiescent daemon bridge.");
    }
    await this.#bridge.close();
    const value = await this.#control.deleteAccount(input);
    return isRecord(value)
      ? { ...value, daemonRestartRequired: true }
      : { daemonRestartRequired: true };
  }
  listDevices(signal: AbortSignal): Promise<unknown> { return this.#control.listDevices(signal); }
  pairDevice(signal: AbortSignal): Promise<unknown> { return this.#control.pairDevice(signal); }
  acknowledgeNoAccountKeyHolders(signal: AbortSignal): Promise<unknown> {
    return this.#control.acknowledgeNoAccountKeyHolders(signal);
  }
  approveDevice(
    device: string,
    idempotencyKey: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    return this.#control.approveDevice(device, idempotencyKey, fingerprint, signal);
  }
  revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    return this.#control.revokeDevice(device, idempotencyKey, signal);
  }
  listRemoteSessionHeads(input: Readonly<{ limit: number; signal: AbortSignal }>): Promise<Readonly<{
    sessions: readonly CloudRemoteSessionHead[];
    truncated: boolean;
  }>> { return this.#control.listRemoteSessionHeads(input); }
  resolveRemoteSession(input: Parameters<CloudRemoteControlPort["resolveRemoteSession"]>[0]): Promise<CloudRemoteSessionSelector> {
    return this.#control.resolveRemoteSession(input);
  }
  pullRemoteSession(input: Readonly<{
    selector: CloudRemoteSessionSelector;
    signal: AbortSignal;
  }>): Promise<CloudRemoteSessionProjection> { return this.#control.pullRemoteSession(input); }
  getRemoteCommandStatus(input: Parameters<CloudRemoteControlPort["getRemoteCommandStatus"]>[0]): Promise<CloudRemoteCommandStatus> {
    return this.#control.getRemoteCommandStatus(input);
  }
  enqueueRemoteCommand(input: Parameters<CloudRemoteControlPort["enqueueRemoteCommand"]>[0]): Promise<CloudRemoteCommandReceipt> {
    return this.#control.enqueueRemoteCommand(input);
  }
  isCompactProjectionRecoveryUnsettled(
    sessionPublicId: Parameters<CloudControlPort[
      "isCompactProjectionRecoveryUnsettled"
    ]>[0],
  ): Promise<boolean> {
    if (this.#bridge.isCompactProjectionRecoveryUnsettled === undefined) {
      return Promise.resolve(true);
    }
    return this.#bridge.isCompactProjectionRecoveryUnsettled(sessionPublicId);
  }
  isCompactProjectionRecoveryUnsettledForProfile(
    profileId: Parameters<CloudControlPort[
      "isCompactProjectionRecoveryUnsettledForProfile"
    ]>[0],
  ): Promise<boolean> {
    if (this.#bridge.isCompactProjectionRecoveryUnsettledForProfile === undefined) {
      return Promise.resolve(true);
    }
    return this.#bridge.isCompactProjectionRecoveryUnsettledForProfile(profileId);
  }
  supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: Parameters<CloudControlPort[
      "supersedeCompactProjectionRecoveryForProviderDeletion"
    ]>[0],
  ): Promise<{ superseded: boolean }> {
    if (this.#bridge.supersedeCompactProjectionRecoveryForProviderDeletion === undefined) {
      return Promise.reject(new Error("Cloud projection recovery supersession is unavailable."));
    }
    return this.#bridge
      .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
  }
  supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    if (this.#bridge.supersedeTerminalCompactProjectionRecoveries === undefined) {
      return Promise.reject(new Error("Cloud projection recovery supersession is unavailable."));
    }
    return this.#bridge.supersedeTerminalCompactProjectionRecoveries();
  }
  readCompactProjectionRecoveryReceipt(
    input: Parameters<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>>[0],
  ): ReturnType<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>> {
    if (this.#bridge.readCompactProjectionRecoveryReceipt === undefined) {
      return Promise.resolve({ status: "absent" });
    }
    return this.#bridge.readCompactProjectionRecoveryReceipt(input);
  }
  recoverCompactProjection(
    input: Parameters<CloudControlPort["recoverCompactProjection"]>[0],
  ): Promise<unknown> {
    if (this.#bridge.recoverCompactProjection === undefined) {
      return Promise.reject(new Error("Cloud projection recovery is unavailable."));
    }
    return this.#bridge.recoverCompactProjection(input);
  }

  async sync(signal: AbortSignal): Promise<unknown> {
    const daemon = await this.#bridge.cycle(signal, {
      forceDeviceRegistryPublication: true,
    });
    const value = await this.#control.sync(signal);
    if (
      !isRecord(value)
      || !Number.isSafeInteger(value.accountCount)
      || (value.accountCount as number) < 0
      || !Number.isSafeInteger(value.sessionCount)
      || (value.sessionCount as number) < 0
      || value.synced !== true
      || typeof value.syncedAt !== "number"
      || !Number.isFinite(value.syncedAt)
      || typeof value.truncated !== "boolean"
      || !Number.isSafeInteger(value.usageSnapshotCount)
      || (value.usageSnapshotCount as number) < 0
    ) throw new Error("Cloud sync summary is invalid.");
    const control = {
      accountCount: value.accountCount,
      sessionCount: value.sessionCount,
      synced: true,
      syncedAt: value.syncedAt,
      truncated: value.truncated,
      usageSnapshotCount: value.usageSnapshotCount,
    };
    return {
      control,
      daemon: {
        commandRequestVersion: daemon.commandRequestVersion,
        commandsApplied: daemon.commandsApplied,
        commandsUnsettled: daemon.commandsUnsettled,
        errors: daemon.errors.slice(0, 32),
        online: daemon.online,
        remoteSessionCount: daemon.remoteSessions.length,
        sessionsUploaded: daemon.sessionsUploaded,
        usageUploaded: daemon.usageUploaded,
      },
    };
  }
}
