import {
  cloudLimits,
  containsAbsolutePath,
  containsSecretShapedText,
  containsUnsafeTerminalScalar,
  hasExactKeys,
  isDigest,
  isOpaqueIdentifier,
  isRecord,
  isSafePositiveInteger,
  jsonValueFitsCloudEnvelope,
  parseEncryptedEnvelope,
  snapshotForeignJson,
  type CommandKind,
  type DeviceCommandKind,
  type EncryptedEnvelope,
} from "./contracts";
import {
  ATTACHMENT_MAX_BYTES,
  isAttachmentMediaType,
  isAttachmentName,
  type AttachmentMediaType,
} from "../domain/attachments";
import {
  remoteInteractionAnswerLimits,
  remoteInteractionJsonFitsProviderLimit,
  remoteInteractionPolicyLimits,
} from "../domain/remote-interaction-contract";
import { decryptBytes, encryptBytes, sha256Hex } from "./crypto";
import {
  decodeHistoricalPresetProfile,
  decodeHistoricalProfileKey,
  type CanonicalProfileKey,
} from "../domain/canonical-profile";
import {
  parseNotificationEmailPolicy,
  type NotificationEmailPolicy,
} from "../domain/notification-email-contract";
import {
  parseNotificationHoursPolicy,
  parseNotificationHoursUpdate,
  type NotificationHoursPolicy,
} from "../domain/notification-hours-contract";
import { isModelPreset, type ModelPreset } from "./projection";
import {
  activePresetBinding,
  presetProviders,
  providerSchema,
  sharedActiveCodexPresetContract,
  supportedPresetSchema,
  supportedProviderSchema,
  type AdoptableProvider,
  type PresetContract,
  type Provider,
  type SupportedPreset,
  type SupportedProvider,
} from "../domain/presets";
import {
  parseUsageEncryptedEnvelope,
  parseUsageProjection,
  type UsageProjection,
} from "./usage";

// The browser facade reaches the exact legacy usage decoder through this
// existing payload boundary; it gains no generic cloud-module import authority.
export {
  parseUsageEncryptedEnvelope,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
  type UsageLimit,
  type UsageProjection,
  type UsageReady,
  type UsageWindow,
} from "./usage";

// Interaction identifiers are provider-brokered UUIDs (see
// `src/domain/interactions.ts`, `z.string().uuid()`) that are not necessarily
// UUIDv7, so this checks the generic RFC 4122 shape rather than reusing the
// stricter `isUuidV7` idempotency-key check.
const uuidPattern =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

function isInteractionId(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

const isProvider = (value: unknown): value is Provider =>
  providerSchema.safeParse(value).success;

const isSupportedProvider = (value: unknown): value is SupportedProvider =>
  supportedProviderSchema.safeParse(value).success;
const isSupportedPreset = (value: unknown): value is SupportedPreset =>
  supportedPresetSchema.safeParse(value).success;

function isRemoteInteractionAnswerMap(
  value: unknown,
): value is Readonly<Record<string, Readonly<{ answers: readonly string[] }>>> {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  let keys: readonly (string | symbol)[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (
    entries.length < 1
    || entries.length > remoteInteractionPolicyLimits.questions
    || keys.length !== entries.length
    || keys.some((key) => typeof key !== "string")
  ) return false;
  return entries.every(([questionId, answer]) =>
    questionId.length >= 1
    && questionId.length <= remoteInteractionPolicyLimits.questionIdCharacters
    && isRecord(answer)
    && hasExactKeys(answer, ["answers"])
    && Array.isArray(answer.answers)
    && answer.answers.length === 1
    && answer.answers.every((entry) =>
      typeof entry === "string"
      && entry.length >= 1
      && entry.length <= remoteInteractionAnswerLimits.codeUnits
      && !containsAbsolutePath(entry)
      && !containsSecretShapedText(entry)
      && !containsUnsafeTerminalScalar(entry, true)))
    && remoteInteractionJsonFitsProviderLimit(value);
}

export type ResolveInteractionDecisionPayload = Readonly<{
  decision: "once" | "decline" | "cancel";
  interactionId: string;
  kind: "resolve_interaction";
  revision: number;
}>;

export type ResolveInteractionAnswersPayload = Readonly<{
  answers: Readonly<Record<string, Readonly<{ answers: readonly string[] }>>>;
  interactionId: string;
  kind: "resolve_interaction";
  revision: number;
}>;

/*
 * Hosted attachments.
 *
 * A remote message payload is versioned. Version 1 is the exact
 * `{kind, message}` shape that shipped before attachments existed and is
 * still what a message with no attachment serializes to, byte for byte.
 * Version 2 adds `attachments`: a bounded manifest, each entry optionally
 * carrying its own bytes as base64.
 *
 * The bounds exist because the whole command is one encrypted Convex
 * document. Convex caps a document at 1 MiB and `parseEncryptedEnvelope`
 * caps the ciphertext at `cloudLimits.ciphertextCharacters` (350,000
 * base64url characters, so about 262,000 plaintext bytes). A full 64,000
 * character message plus 96 KiB of inlined attachment bytes base64-encodes to
 * roughly 195,000 plaintext bytes and about 260,000 ciphertext characters,
 * which leaves real room under both caps.
 *
 * An attachment larger than `remoteAttachmentLimits.inlineBytes` is refused,
 * not truncated and not silently dropped. A caller that holds larger bytes
 * must attach the file from the custodian machine with
 * `oompa session send --attach`; a browser cannot push it through this lane.
 */
export const remoteAttachmentLimits = Object.freeze({
  count: 8,
  inlineBytes: 64 * 1024,
  nameCharacters: 255,
  totalInlineBytes: 96 * 1024,
} as const);

export type RemoteAttachment = Readonly<{
  byteLength: number;
  /** Base64 of the exact bytes. Absent means "the custodian already holds this digest". */
  data?: string;
  digest: string;
  mediaType: AttachmentMediaType;
  name: string;
}>;

export type RemoteMessagePayload = Readonly<{
  attachments: readonly RemoteAttachment[];
  kind: "send" | "queue" | "steer" | "send_or_steer";
  message: string;
  version: 2;
}>;

const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/u;

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function parseRemoteAttachments(value: unknown): readonly RemoteAttachment[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > remoteAttachmentLimits.count) {
    return null;
  }
  const parsed: RemoteAttachment[] = [];
  let inlineTotal = 0;
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const inline = Object.hasOwn(entry, "data");
    if (!hasExactKeys(
      entry,
      inline
        ? ["byteLength", "data", "digest", "mediaType", "name"]
        : ["byteLength", "digest", "mediaType", "name"],
    )) return null;
    if (
      typeof entry.digest !== "string"
      || !/^[0-9a-f]{64}$/u.test(entry.digest)
      || !isAttachmentMediaType(entry.mediaType)
      || typeof entry.name !== "string"
      || entry.name.length > remoteAttachmentLimits.nameCharacters
      || !isAttachmentName(entry.name)
      || containsAbsolutePath(entry.name)
      || containsUnsafeTerminalScalar(entry.name)
      || !Number.isSafeInteger(entry.byteLength)
      || (entry.byteLength as number) < 1
      || (entry.byteLength as number) > ATTACHMENT_MAX_BYTES
    ) return null;
    if (!inline) {
      parsed.push({
        byteLength: entry.byteLength as number,
        digest: entry.digest,
        mediaType: entry.mediaType,
        name: entry.name,
      });
      continue;
    }
    if (
      typeof entry.data !== "string"
      || entry.data.length < 4
      || entry.data.length % 4 !== 0
      || !base64Pattern.test(entry.data)
    ) return null;
    const bytes = base64ByteLength(entry.data);
    if (bytes !== entry.byteLength || bytes > remoteAttachmentLimits.inlineBytes) return null;
    inlineTotal += bytes;
    if (inlineTotal > remoteAttachmentLimits.totalInlineBytes) return null;
    parsed.push({
      byteLength: entry.byteLength,
      data: entry.data,
      digest: entry.digest,
      mediaType: entry.mediaType,
      name: entry.name,
    });
  }
  return parsed;
}

/**
 * Exact active interpretation of a preset alias at a remote write boundary.
 *
 * Browser, CLI, and daemon deployments do not roll atomically. Requiring this
 * frozen token for the rebound Codex aliases means an old client cannot
 * silently select their new meaning, while an old daemon rejects the additive
 * key before effects. Stable aliases retain their existing token-free shape.
 */
export type ActiveRemotePresetSelection = Readonly<{
  preset: "high" | "ultra";
  presetContract: PresetContract;
}> | Readonly<{
  preset: Exclude<SupportedPreset, "high" | "ultra">;
}>;

export function activeRemotePresetSelection(
  preset: SupportedPreset,
): ActiveRemotePresetSelection {
  return preset === "high" || preset === "ultra"
    ? { preset, presetContract: activePresetBinding(preset).contract }
    : { preset };
}

/**
 * Contract fence for a provider switch that lets the daemon derive a Codex
 * preset from the source tier. The client does not know whether that tier is
 * High or Ultra, so those mutable aliases must share one active contract.
 */
export type ActiveRemoteDerivedCodexSelection = Readonly<{
  presetContract: PresetContract;
  provider: "codex";
}>;

export function activeRemoteDerivedCodexSelection(): ActiveRemoteDerivedCodexSelection {
  return { presetContract: sharedActiveCodexPresetContract(), provider: "codex" };
}

function parseActiveRemotePresetSelection(
  value: Readonly<Record<string, unknown>>,
): ActiveRemotePresetSelection | null {
  if (!isSupportedPreset(value.preset)) return null;
  const selection = activeRemotePresetSelection(value.preset);
  return "presetContract" in selection
    && value.presetContract !== selection.presetContract
    ? null
    : selection;
}

export type RemoteCommandPayload =
  | Readonly<{ kind: "send" | "queue" | "steer" | "send_or_steer"; message: string }>
  | RemoteMessagePayload
  | Readonly<{ kind: "stop" }>
  | (Readonly<{ kind: "set_model" }> & ActiveRemotePresetSelection)
  /**
   * Move one session to another provider. The preset is optional: omitted, the
   * custodian keeps the session's tier when the target provider has one. The
   * account is deliberately absent — choosing an account is user-directed and
   * stays on the machine that holds the credentials.
   */
  | Readonly<{ kind: "set_provider"; provider: Exclude<SupportedProvider, "codex"> }>
  | (Readonly<{ kind: "set_provider" }> & ActiveRemoteDerivedCodexSelection)
  | (Readonly<{ kind: "set_provider"; provider: SupportedProvider }> & ActiveRemotePresetSelection)
  | Readonly<{ enabled: boolean; kind: "set_fast" }>
  | ResolveInteractionDecisionPayload
  | ResolveInteractionAnswersPayload
  | Readonly<{
      kind: "set_approval_mode";
      mode: "auto:all" | "auto:workspace" | "manual";
      scope: "session" | "default";
    }>
  | Readonly<{ enabled: boolean; kind: "set_show_thinking"; scope: "session" | "default" }>
  | (Readonly<{ kind: "set_default_preset" }> & ActiveRemotePresetSelection)
  | Readonly<{ archived: boolean; kind: "archive_session" }>
  | Readonly<{ kind: "rename_session"; name: string | null }>
  | Readonly<{ key: string; kind: "set_gateway_key" }>;

/**
 * Device command payloads. Addressing is by cloud public id only: a project is
 * named by the `publicId` the device registry already projects, never by a
 * filesystem path, and `containsAbsolutePath` refuses one anyway.
 *
 * Current `account_login_status` requests name the projected account whose
 * row exposed the action. The account-less shape remains parseable only for a
 * legacy browser, so a rolling deployment can still ask the older machine-wide
 * question without widening the current UI's authority.
 */
export type DeviceCommandPayload =
  | (Readonly<{
      accountPublicId: string;
      kind: "session_start";
      projectPublicId: string;
      prompt: string;
      provider: SupportedProvider;
    }> & ActiveRemotePresetSelection)
  | Readonly<{
      accountPublicId: string;
      /** Absent identifies a legacy requester that the current daemon refuses. */
      handoffVersion?: 2;
      kind: "account_login_start";
    }>
  | Readonly<{ accountPublicId: string; kind: "account_login_status" }>
  | Readonly<{ kind: "account_login_status" }>
  | Readonly<{ kind: "usage_refresh" }>
  | Readonly<{
      endMinute: number;
      expectedRevision: number;
      kind: "set_notification_hours";
      startMinute: number;
      timeZone: string;
      version: 1;
    }>;

export type DeviceCommandLoginStatus =
  | "idle"
  | "pending"
  | "relay_unavailable"
  | "signed_in"
  | "failed";

/**
 * What the daemon settles back to the requesting browser. `account_login_start`
 * returns the complete provider device-code handoff: it is encrypted under the
 * account key like every other payload, carries its own short expiry, and the
 * hosted row releases it exactly once (`deviceCommands:consumeResult`). The
 * browser replaces the encrypted machine-clock expiry with the hosted
 * settlement deadline returned by that one-time exchange.
 */
export type DeviceCommandResultPayload =
  | Readonly<{ kind: "session_start"; sessionPublicId: string }>
  | Readonly<{
      expiresAt: number;
      handoffVersion: 2;
      kind: "account_login_start";
      loginUrl: string;
      userCode: string;
    }>
  | Readonly<{
      expiresAt: number;
      kind: "account_login_start";
      loginUrl: string;
    }>
  | Readonly<{
      instruction: string;
      kind: "account_login_status";
      status: DeviceCommandLoginStatus;
    }>
  | Readonly<{ accountsRefreshed: number; kind: "usage_refresh" }>;

export const deviceCommandLimits = Object.freeze({
  instructionCharacters: 512,
  loginUserCodeCharacters: 38,
  promptCharacters: 16_000,
} as const);

/** Maximum time a hosted Codex login handoff may remain readable. */
export const deviceCommandLoginResultLifetimeMs = 5 * 60 * 1_000;

// Codex owns the device-code endpoint and currently returns this exact URL.
// An allowlist at the relay boundary prevents a compromised local response
// from turning the trusted web handoff into an arbitrary phishing link.
export function isRelayedLoginUrl(value: unknown): value is string {
  return value === "https://auth.openai.com/codex/device";
}

/** The same closed device-code grammar accepted by the protected CLI handoff. */
export function isRelayedLoginUserCode(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= deviceCommandLimits.loginUserCodeCharacters
    && /^[A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,2}$/u.test(value);
}

export function parseDeviceCommandPayload(value: unknown): DeviceCommandPayload | null {
  if (!isRecord(value)) return null;
  const presetSelection = parseActiveRemotePresetSelection(value);
  if (
    value.kind === "session_start"
    && presetSelection !== null
    && hasExactKeys(value, [
      "accountPublicId",
      "kind",
      ...Object.keys(presetSelection),
      "projectPublicId",
      "prompt",
      "provider",
    ])
    && isOpaqueIdentifier(value.accountPublicId)
    && isOpaqueIdentifier(value.projectPublicId)
    && isSupportedProvider(value.provider)
    && presetProviders[presetSelection.preset] === value.provider
    && typeof value.prompt === "string"
    && value.prompt.length >= 1
    && value.prompt.length <= deviceCommandLimits.promptCharacters
    && !containsAbsolutePath(value.prompt)
    && !containsUnsafeTerminalScalar(value.prompt, true)
  ) {
    return {
      accountPublicId: value.accountPublicId,
      kind: value.kind,
      ...presetSelection,
      projectPublicId: value.projectPublicId,
      prompt: value.prompt,
      provider: value.provider,
    };
  }
  if (
    value.kind === "account_login_start"
    && hasExactKeys(value, ["accountPublicId", "kind"])
    && isOpaqueIdentifier(value.accountPublicId)
  ) return { accountPublicId: value.accountPublicId, kind: value.kind };
  if (
    value.kind === "account_login_start"
    && hasExactKeys(value, ["accountPublicId", "handoffVersion", "kind"])
    && isOpaqueIdentifier(value.accountPublicId)
    && value.handoffVersion === 2
  ) {
    return {
      accountPublicId: value.accountPublicId,
      handoffVersion: value.handoffVersion,
      kind: value.kind,
    };
  }
  if (
    value.kind === "account_login_status"
    && hasExactKeys(value, ["accountPublicId", "kind"])
    && isOpaqueIdentifier(value.accountPublicId)
  ) {
    return { accountPublicId: value.accountPublicId, kind: value.kind };
  }
  if (
    value.kind === "account_login_status"
    && hasExactKeys(value, ["kind"])
  ) return { kind: "account_login_status" };
  if (
    value.kind === "usage_refresh"
    && hasExactKeys(value, ["kind"])
  ) return { kind: "usage_refresh" };
  if (value.kind === "set_notification_hours") {
    if (!hasExactKeys(value, [
      "endMinute",
      "expectedRevision",
      "kind",
      "startMinute",
      "timeZone",
      "version",
    ]) || !isSafePositiveInteger(value.expectedRevision)) return null;
    const parsed = parseNotificationHoursUpdate({
      endMinute: value.endMinute,
      startMinute: value.startMinute,
      timeZone: value.timeZone,
      version: value.version,
    });
    if (parsed === null) return null;
    return { ...parsed, expectedRevision: value.expectedRevision, kind: "set_notification_hours" };
  }
  return null;
}

export function deviceCommandPayloadKind(payload: DeviceCommandPayload): DeviceCommandKind {
  return payload.kind;
}

export function parseDeviceCommandResultPayload(
  value: unknown,
): DeviceCommandResultPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.kind === "session_start"
    && hasExactKeys(value, ["kind", "sessionPublicId"])
    && isOpaqueIdentifier(value.sessionPublicId)
  ) return { kind: value.kind, sessionPublicId: value.sessionPublicId };
  if (
    value.kind === "account_login_start"
    && hasExactKeys(value, ["expiresAt", "handoffVersion", "kind", "loginUrl", "userCode"])
    && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) > 0
    && value.handoffVersion === 2
    && isRelayedLoginUrl(value.loginUrl)
    && isRelayedLoginUserCode(value.userCode)
  ) {
    return {
      expiresAt: value.expiresAt as number,
      handoffVersion: value.handoffVersion,
      kind: value.kind,
      loginUrl: value.loginUrl,
      userCode: value.userCode,
    };
  }
  if (
    value.kind === "account_login_start"
    && hasExactKeys(value, ["expiresAt", "kind", "loginUrl"])
    && Number.isSafeInteger(value.expiresAt)
    && (value.expiresAt as number) > 0
    && isRelayedLoginUrl(value.loginUrl)
  ) {
    return {
      expiresAt: value.expiresAt as number,
      kind: value.kind,
      loginUrl: value.loginUrl,
    };
  }
  if (
    value.kind === "account_login_status"
    && hasExactKeys(value, ["instruction", "kind", "status"])
    && typeof value.instruction === "string"
    && value.instruction.length >= 1
    && value.instruction.length <= deviceCommandLimits.instructionCharacters
    && !containsAbsolutePath(value.instruction)
    && !containsUnsafeTerminalScalar(value.instruction)
    && (value.status === "idle"
      || value.status === "pending"
      || value.status === "relay_unavailable"
      || value.status === "signed_in"
      || value.status === "failed")
  ) {
    return { instruction: value.instruction, kind: value.kind, status: value.status };
  }
  if (
    value.kind === "usage_refresh"
    && hasExactKeys(value, ["accountsRefreshed", "kind"])
    && Number.isSafeInteger(value.accountsRefreshed)
    && (value.accountsRefreshed as number) >= 0
    && (value.accountsRefreshed as number) <= deviceRegistryLimits.accounts
  ) {
    return { accountsRefreshed: value.accountsRefreshed as number, kind: value.kind };
  }
  return null;
}

export type SessionMetadataPayload = Readonly<{
  archived?: boolean;
  retiredProvider?: "devin";
  name: string | null;
  note: string | null;
}>;

export type DeviceRegistryAccount = Readonly<{
  label: string;
  provider: Provider;
  publicId: string;
  status: "login_pending" | "recovery_required" | "signed_in" | "signed_out";
}>;

export type DeviceRegistryProject = Readonly<{ label: string; publicId: string }>;

export type DeviceRegistryScheduledTask = Readonly<{
  cadence: string;
  id: string;
  kind: "hra_conversation";
  label: string;
  nextRunAt: number | null;
  sessionPublicId: string | null;
}>;

/**
 * Provider-level personal-home adoption state. Candidate identity, content,
 * liveness, project paths, and runtime provenance remain local; only these
 * exact aggregates enter the encrypted device registry.
 */
export type DeviceRegistrySessionAdoptionStatus = Readonly<{
  adopted: number;
  enabled: boolean;
  fenced: number;
  pending: number;
}>;

export type DeviceRegistrySessionAdoption = Readonly<
  Record<AdoptableProvider, DeviceRegistrySessionAdoptionStatus>
>;

/**
 * One device's settings projection: what the web settings screen needs to
 * render machines, accounts, projects, scheduled tasks, and the daemon's
 * current defaults without decrypting any session. Every human-readable
 * field is a label; filesystem paths are refused by the parser, so a project
 * root or an automation working directory can never reach the projection.
 */
export type DeviceRegistryPayload = Readonly<{
  accounts: readonly DeviceRegistryAccount[];
  // Additive optional switches (W3 device commands). A registry written before
  // device commands existed carries neither key; absent means the conservative
  // reading, which is also the shipped default: the machine executes device
  // commands, and it will not relay an account login.
  accountLinkingAllowed?: boolean;
  daemonVersion: string;
  defaultApprovalMode: "auto:all" | "auto:workspace" | "manual";
  defaultPreset: ModelPreset;
  // Additive and optional: the project a start uses when the reader names
  // none. Absent on a registry from an older daemon, so a browser falls back
  // to the first listed project. Always one of `projects`.
  defaultProjectPublicId?: string;
  deviceCommandsAllowed?: boolean;
  heartbeatAt: number;
  machineLabel: string;
  projects: readonly DeviceRegistryProject[];
  proseAutorespondConfigured: boolean;
  scheduledTasks: readonly DeviceRegistryScheduledTask[];
  // Additive and optional so a registry published by an older daemon remains
  // readable. Absence means unsupported/unknown, never disabled.
  sessionAdoption?: DeviceRegistrySessionAdoption;
  showThinkingDefault: boolean;
  version: 1;
}>;

/**
 * The publishing daemon's configured Codex default, never a capability or a
 * claim about a running session. A separate envelope preserves registry v1.
 * Its revision and digest bind it to one exact encrypted registry publication.
 */
export type ProfileBindingPayload = Readonly<{
  version: 1;
  preset: "low" | "high" | "ultra";
  profileKey: CanonicalProfileKey;
  observedAt: number;
  registryRevision: number;
  registryEnvelopeDigest: string;
}>;

export type MemorySummaryHead = Readonly<{
  digest: string;
  operationSha256: string | null;
  sequence: number;
}>;

export type MemorySummaryRecentRecord = Readonly<{
  /** Memory pages are the only record kind admitted by the stable host facade. */
  kind: "memory_page";
  key: string;
  updatedAt: number;
}>;

export type MemorySummarySpace = Readonly<{
  bindingDigest: string;
  canonicalSpaceId: string;
  enrollment: "attached" | "detached" | "not_enrolled" | "unavailable";
  head: MemorySummaryHead;
  lastExchangeAt: number | null;
  projectLabel: string;
  recentRecords: readonly MemorySummaryRecentRecord[];
  /** Null means the exact canonical snapshot could not be verified locally. */
  recordCount: number | null;
  remoteHead: MemorySummaryHead | null;
  syncStatus: "conflict" | "error" | "local_only" | "settled" | "syncing";
}>;

export type MemorySummaryPeerIdentity = Readonly<{
  /** Device-scoped digest; never a local Oompa session id. */
  ref: string;
  label: string;
}>;

export type MemorySummaryPeerPolicy = Readonly<{
  mode: "coordinate" | "inspect" | "off";
  projectLabel: string;
  session: MemorySummaryPeerIdentity;
  updatedAt: number;
}>;

export type MemorySummaryPeerAction = Readonly<{
  actor: MemorySummaryPeerIdentity;
  createdAt: number;
  delivery: "queue" | "send" | "steer";
  state: "ambiguous" | "applied" | "cancelled" | "effect_started" | "failed" | "prepared" | "queued";
  target: MemorySummaryPeerIdentity;
  updatedAt: number;
}>;

export type MemorySummaryCoverage = Readonly<{
  /** `bounded` means a deterministic prefix hit its count or encrypted-envelope budget. */
  peerActions: "bounded" | "complete";
  peerPolicies: "bounded" | "complete";
  spaces: "bounded" | "complete";
}>;

/**
 * Read-only supervision for one publishing daemon. This payload has its own
 * AAD kind and envelope so the byte-strict DeviceRegistryPayload v1 contract
 * never acquires an optional memory field. It intentionally carries neither
 * page bodies nor raw local project/session identifiers.
 */
export type MemorySummaryPayload = Readonly<{
  coverage: MemorySummaryCoverage;
  observedAt: number;
  peerActions: readonly MemorySummaryPeerAction[];
  peerPolicies: readonly MemorySummaryPeerPolicy[];
  spaces: readonly MemorySummarySpace[];
  version: 1;
}>;

export const memorySummaryLimits = Object.freeze({
  peerActions: 50,
  peerPolicies: 200,
  recentRecordsPerSpace: 32,
  spaces: 100,
} as const);

export const deviceRegistryLimits = Object.freeze({
  accounts: 100,
  cadenceCharacters: 512,
  labelCharacters: 200,
  projects: 200,
  scheduledTaskIdCharacters: 200,
  scheduledTasks: 200,
  versionCharacters: 64,
} as const);

export type CloudPayloadAuthority = Readonly<{
  entityPublicId: string;
  keyVersion: number;
  kind:
    | "command"
    | "device_command"
    | "device_command_result"
    | "device_registry"
    | "memory_summary"
    | "notification_email"
    | "notification_hours"
    | "profile_binding"
    | "session_metadata"
    | "usage";
  userPublicId: string;
}>;

function parseRemoteCommandPayloadUnchecked(value: unknown): RemoteCommandPayload | null {
  if (!isRecord(value)) return null;
  const presetSelection = parseActiveRemotePresetSelection(value);
  if (
    (value.kind === "send" || value.kind === "queue" || value.kind === "steer"
      || value.kind === "send_or_steer")
    && typeof value.message === "string"
    && value.message.length >= 1
    && value.message.length <= 64_000
    && !containsAbsolutePath(value.message)
    && !containsUnsafeTerminalScalar(value.message, true)
  ) {
    // Version 1 stays exactly what it was: no version key, no attachments.
    if (hasExactKeys(value, ["kind", "message"])) {
      return { kind: value.kind, message: value.message };
    }
    if (hasExactKeys(value, ["attachments", "kind", "message", "version"]) && value.version === 2) {
      const attachments = parseRemoteAttachments(value.attachments);
      if (attachments !== null) {
        return { attachments, kind: value.kind, message: value.message, version: 2 };
      }
    }
    return null;
  }
  if (value.kind === "stop" && hasExactKeys(value, ["kind"])) return { kind: value.kind };
  if (
    value.kind === "set_model"
    && presetSelection !== null
    && hasExactKeys(value, ["kind", ...Object.keys(presetSelection)])
  ) return { kind: value.kind, ...presetSelection };
  if (
    value.kind === "set_provider"
    && isSupportedProvider(value.provider)
  ) {
    if (
      presetSelection !== null
      && hasExactKeys(value, ["kind", ...Object.keys(presetSelection), "provider"])
    ) {
      return presetProviders[presetSelection.preset] === value.provider
        ? {
            kind: value.kind,
            ...presetSelection,
             provider: value.provider,
           }
        : null;
    }
    if (value.provider === "codex") {
      const derivedSelection = activeRemoteDerivedCodexSelection();
      return hasExactKeys(value, ["kind", "presetContract", "provider"])
        && value.presetContract === derivedSelection.presetContract
        ? { kind: value.kind, ...derivedSelection }
        : null;
    }
    return hasExactKeys(value, ["kind", "provider"])
      ? { kind: value.kind, provider: value.provider }
      : null;
  }
  if (
    value.kind === "set_fast"
    && hasExactKeys(value, ["enabled", "kind"])
    && typeof value.enabled === "boolean"
  ) return { enabled: value.enabled, kind: value.kind };
  if (
    value.kind === "resolve_interaction"
    && isInteractionId(value.interactionId)
    && Number.isSafeInteger(value.revision)
    && (value.revision as number) > 0
  ) {
    if (
      hasExactKeys(value, ["decision", "interactionId", "kind", "revision"])
      && (value.decision === "once" || value.decision === "decline" || value.decision === "cancel")
    ) {
      return {
        decision: value.decision,
        interactionId: value.interactionId,
        kind: value.kind,
        revision: value.revision as number,
      };
    }
    if (
      hasExactKeys(value, ["answers", "interactionId", "kind", "revision"])
      && isRemoteInteractionAnswerMap(value.answers)
    ) {
      const answers = Object.fromEntries(Object.entries(value.answers).map(
        ([questionId, answer]) => [questionId, { answers: [...answer.answers] }],
      ));
      return {
        answers,
        interactionId: value.interactionId,
        kind: value.kind,
        revision: value.revision as number,
      };
    }
  }
  if (
    value.kind === "set_approval_mode"
    && hasExactKeys(value, ["kind", "mode", "scope"])
    && (value.mode === "auto:all" || value.mode === "auto:workspace" || value.mode === "manual")
    && (value.scope === "session" || value.scope === "default")
  ) return { kind: value.kind, mode: value.mode, scope: value.scope };
  if (
    value.kind === "set_show_thinking"
    && hasExactKeys(value, ["enabled", "kind", "scope"])
    && typeof value.enabled === "boolean"
    && (value.scope === "session" || value.scope === "default")
  ) return { enabled: value.enabled, kind: value.kind, scope: value.scope };
  if (
    value.kind === "set_default_preset"
    && presetSelection !== null
    && hasExactKeys(value, ["kind", ...Object.keys(presetSelection)])
  ) return { kind: value.kind, ...presetSelection };
  if (
    value.kind === "archive_session"
    && hasExactKeys(value, ["archived", "kind"])
    && typeof value.archived === "boolean"
  ) return { archived: value.archived, kind: value.kind };
  if (
    value.kind === "rename_session"
    && hasExactKeys(value, ["kind", "name"])
    && (value.name === null || isRemoteSessionName(value.name))
  ) return { kind: value.kind, name: value.name };
  // The gateway key itself never enters a journal entry, an evidence row, a
  // log line, or a result: only its shape is checked here, and the daemon
  // hands it straight to local secret custody.
  if (
    value.kind === "set_gateway_key"
    && hasExactKeys(value, ["key", "kind"])
    && isGatewayKeyShape(value.key)
  ) return { key: value.key, kind: value.kind };
  return null;
}

/** Parse an untrusted decrypted command without allowing exotic accessors to escape. */
export function parseRemoteCommandPayload(value: unknown): RemoteCommandPayload | null {
  const snapshot = snapshotForeignJson(value);
  if (!snapshot.ok || !jsonValueFitsCloudEnvelope(snapshot.value)) return null;
  const parsed = parseRemoteCommandPayloadUnchecked(snapshot.value);
  if (parsed === null) return null;
  // Returned command records retain null prototypes so optional fields cannot
  // be supplied later through ambient prototype pollution.
  const canonical = snapshotForeignJson(parsed);
  return canonical.ok ? canonical.value as RemoteCommandPayload : null;
}

/**
 * Reserve the largest UUID/revision wrapper around an answer map so the app
 * never offers submission for answers that cannot fit the hosted command.
 */
export function remoteInteractionAnswersFitCommandEnvelope(
  answers: Readonly<Record<string, Readonly<{ answers: readonly string[] }>>>,
): boolean {
  return jsonValueFitsCloudEnvelope({
    answers,
    interactionId: "00000000-0000-4000-8000-000000000000",
    kind: "resolve_interaction",
    revision: Number.MAX_SAFE_INTEGER,
  });
}

function isRemoteSessionName(value: unknown): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= 160
    && !containsAbsolutePath(value)
    && !containsUnsafeTerminalScalar(value);
}

const gatewayKeyPattern = /^[\x21-\x7e]{8,512}$/u;

function isGatewayKeyShape(value: unknown): value is string {
  return typeof value === "string" && gatewayKeyPattern.test(value);
}

export function commandPayloadKind(payload: RemoteCommandPayload): CommandKind {
  return payload.kind;
}

export function parseSessionMetadataPayload(value: unknown): SessionMetadataPayload | null {
  if (!isRecord(value)) return null;
  // `archived` is an additive optional key: a payload written before session
  // archive existed still parses, and an absent key means "not archived".
  const archived = Object.hasOwn(value, "archived");
  const retiredProvider = Object.hasOwn(value, "retiredProvider");
  if (
    !hasExactKeys(value, ["name", "note", ...(archived ? ["archived"] : []), ...(retiredProvider ? ["retiredProvider"] : [])])
    || (archived && typeof value.archived !== "boolean")
    || (retiredProvider && value.retiredProvider !== "devin")
  ) return null;
  if (
    value.name !== null
    && (typeof value.name !== "string"
      || value.name.length < 1
      || value.name.length > 160
      || containsAbsolutePath(value.name)
      || containsUnsafeTerminalScalar(value.name))
  ) return null;
  if (
    value.note !== null
    && (typeof value.note !== "string"
      || value.note.length > 8_000
      || containsAbsolutePath(value.note)
      || containsUnsafeTerminalScalar(value.note, true))
  ) return null;
  return {
    ...(archived ? { archived: value.archived as boolean } : {}),
    ...(retiredProvider ? { retiredProvider: "devin" as const } : {}),
    name: value.name,
    note: value.note,
  };
}

/**
 * A registry label is display text only. Absolute paths, `~/` prefixes, and
 * control scalars are refused rather than redacted, so a caller that tries to
 * project a project root or an automation working directory fails closed.
 */
function isRegistryLabel(
  value: unknown,
  maximum: number = deviceRegistryLimits.labelCharacters,
): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maximum
    && !containsAbsolutePath(value)
    && !containsUnsafeTerminalScalar(value);
}

function isRegistryTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRegistryCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseRegistryAccounts(value: unknown): readonly DeviceRegistryAccount[] | null {
  if (!Array.isArray(value) || value.length > deviceRegistryLimits.accounts) return null;
  const accounts: DeviceRegistryAccount[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["label", "provider", "publicId", "status"])
      || !isRegistryLabel(entry.label)
      || !isProvider(entry.provider)
      || !isOpaqueIdentifier(entry.publicId)
      || (entry.status !== "login_pending"
        && entry.status !== "recovery_required"
        && entry.status !== "signed_in"
        && entry.status !== "signed_out")
    ) return null;
    accounts.push({
      label: entry.label,
      provider: entry.provider,
      publicId: entry.publicId,
      status: entry.status,
    });
  }
  return accounts;
}

function parseRegistryProjects(value: unknown): readonly DeviceRegistryProject[] | null {
  if (!Array.isArray(value) || value.length > deviceRegistryLimits.projects) return null;
  const projects: DeviceRegistryProject[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["label", "publicId"])
      || !isRegistryLabel(entry.label)
      || !isOpaqueIdentifier(entry.publicId)
    ) return null;
    projects.push({ label: entry.label, publicId: entry.publicId });
  }
  return projects;
}

function parseRegistryScheduledTasks(
  value: unknown,
): readonly DeviceRegistryScheduledTask[] | null {
  if (!Array.isArray(value) || value.length > deviceRegistryLimits.scheduledTasks) return null;
  const tasks: DeviceRegistryScheduledTask[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["cadence", "id", "kind", "label", "nextRunAt", "sessionPublicId"])
    ) return null;
    // Old daemons could publish Codex Desktop automation rows. They are
    // private age-gate inputs, not public Oompa schedules, so readers discard
    // those legacy rows without retaining any of their metadata.
    if (entry.kind === "codex_automation") continue;
    if (
      !isRegistryLabel(entry.cadence, deviceRegistryLimits.cadenceCharacters)
      || !isRegistryLabel(entry.id, deviceRegistryLimits.scheduledTaskIdCharacters)
      || entry.kind !== "hra_conversation"
      || !isRegistryLabel(entry.label)
      || (entry.nextRunAt !== null && !isRegistryTimestamp(entry.nextRunAt))
      || (entry.sessionPublicId !== null && !isOpaqueIdentifier(entry.sessionPublicId))
    ) return null;
    tasks.push({
      cadence: entry.cadence,
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      nextRunAt: entry.nextRunAt,
      sessionPublicId: entry.sessionPublicId,
    });
  }
  return tasks;
}

function parseRegistrySessionAdoptionStatus(
  value: unknown,
): DeviceRegistrySessionAdoptionStatus | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["adopted", "enabled", "fenced", "pending"])
    || !isRegistryCount(value.adopted)
    || typeof value.enabled !== "boolean"
    || !isRegistryCount(value.fenced)
    || !isRegistryCount(value.pending)
  ) return null;
  return {
    adopted: value.adopted,
    enabled: value.enabled,
    fenced: value.fenced,
    pending: value.pending,
  };
}

function parseRegistrySessionAdoption(value: unknown): DeviceRegistrySessionAdoption | null {
  if (!isRecord(value) || !hasExactKeys(value, ["claude", "codex"])) return null;
  const claude = parseRegistrySessionAdoptionStatus(value.claude);
  const codex = parseRegistrySessionAdoptionStatus(value.codex);
  return claude === null || codex === null ? null : { claude, codex };
}

function parseDeviceRegistryPayloadUnchecked(value: unknown): DeviceRegistryPayload | null {
  if (!isRecord(value)) return null;
  const hasAccountLinking = Object.hasOwn(value, "accountLinkingAllowed");
  const hasDeviceCommands = Object.hasOwn(value, "deviceCommandsAllowed");
  const hasSessionAdoption = Object.hasOwn(value, "sessionAdoption");
  const hasDefaultProject = Object.hasOwn(value, "defaultProjectPublicId");
  const sessionAdoption = hasSessionAdoption
    ? parseRegistrySessionAdoption(value.sessionAdoption)
    : null;
  if (
    (hasDefaultProject && !isOpaqueIdentifier(value.defaultProjectPublicId))
    || (hasAccountLinking && typeof value.accountLinkingAllowed !== "boolean")
    || (hasDeviceCommands && typeof value.deviceCommandsAllowed !== "boolean")
    || (hasSessionAdoption && sessionAdoption === null)
  ) return null;
  if (
    !hasExactKeys(value, [
      ...(hasAccountLinking ? ["accountLinkingAllowed"] : []),
      ...(hasDeviceCommands ? ["deviceCommandsAllowed"] : []),
      "accounts",
      "daemonVersion",
      "defaultApprovalMode",
      "defaultPreset",
      ...(hasDefaultProject ? ["defaultProjectPublicId"] : []),
      "heartbeatAt",
      "machineLabel",
      "projects",
      "proseAutorespondConfigured",
      "scheduledTasks",
      ...(hasSessionAdoption ? ["sessionAdoption"] : []),
      "showThinkingDefault",
      "version",
    ])
    || value.version !== 1
    || !isRegistryLabel(value.machineLabel)
    || !isRegistryLabel(value.daemonVersion, deviceRegistryLimits.versionCharacters)
    || !isRegistryTimestamp(value.heartbeatAt)
    || (value.defaultApprovalMode !== "auto:all"
      && value.defaultApprovalMode !== "auto:workspace"
      && value.defaultApprovalMode !== "manual")
    || typeof value.showThinkingDefault !== "boolean"
    || !isModelPreset(value.defaultPreset)
    || typeof value.proseAutorespondConfigured !== "boolean"
  ) return null;
  const accounts = parseRegistryAccounts(value.accounts);
  const projects = parseRegistryProjects(value.projects);
  const scheduledTasks = parseRegistryScheduledTasks(value.scheduledTasks);
  if (accounts === null || projects === null || scheduledTasks === null) return null;
  const defaultProjectPublicId = hasDefaultProject ? value.defaultProjectPublicId as string : null;
  if (
    defaultProjectPublicId !== null
    && !projects.some((project) => project.publicId === defaultProjectPublicId)
  ) return null;
  return {
    accounts,
    ...(hasAccountLinking
      ? { accountLinkingAllowed: value.accountLinkingAllowed as boolean }
      : {}),
    daemonVersion: value.daemonVersion,
    defaultApprovalMode: value.defaultApprovalMode,
    defaultPreset: value.defaultPreset,
    ...(defaultProjectPublicId === null ? {} : { defaultProjectPublicId }),
    ...(hasDeviceCommands
      ? { deviceCommandsAllowed: value.deviceCommandsAllowed as boolean }
      : {}),
    heartbeatAt: value.heartbeatAt,
    machineLabel: value.machineLabel,
    projects,
    proseAutorespondConfigured: value.proseAutorespondConfigured,
    scheduledTasks,
    ...(hasSessionAdoption
      ? { sessionAdoption: sessionAdoption as DeviceRegistrySessionAdoption }
      : {}),
    showThinkingDefault: value.showThinkingDefault,
    version: 1,
  };
}

/** Parse one immutable accessor-free snapshot of an untrusted registry. */
export function parseDeviceRegistryPayload(value: unknown): DeviceRegistryPayload | null {
  const snapshot = snapshotForeignJson(value);
  return snapshot.ok ? parseDeviceRegistryPayloadUnchecked(snapshot.value) : null;
}

/** Decode a closed historical binding without consulting this reader's active map. */
export function parseProfileBindingPayload(input: unknown): ProfileBindingPayload | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok || !isRecord(snapshot.value)) return null;
  const value = snapshot.value;
  if (
    !hasExactKeys(value, ["version", "preset", "profileKey", "observedAt", "registryRevision", "registryEnvelopeDigest"])
    || value.version !== 1
    || (value.preset !== "low" && value.preset !== "high" && value.preset !== "ultra")
    || !isSafePositiveInteger(value.observedAt)
    || !isSafePositiveInteger(value.registryRevision)
    || !isDigest(value.registryEnvelopeDigest)
  ) return null;
  const profile = decodeHistoricalProfileKey(value.profileKey);
  if (profile === null || !([1, 2] as const).some((contract) =>
    decodeHistoricalPresetProfile({ provider: "codex", preset: value.preset, contract })?.key === profile.key)) {
    return null;
  }
  return {
    version: 1,
    preset: value.preset,
    profileKey: profile.key,
    observedAt: value.observedAt,
    registryRevision: value.registryRevision,
    registryEnvelopeDigest: value.registryEnvelopeDigest,
  };
}

/** Hash exact validated envelope fields, independent of caller property order. */
export async function profileBindingRegistryDigest(envelope: EncryptedEnvelope): Promise<string> {
  const snapshot = snapshotForeignJson(envelope);
  const parsed = snapshot.ok
    ? parseEncryptedEnvelope(snapshot.value, cloudLimits.registryCiphertextCharacters)
    : null;
  if (parsed === null) throw new Error("Invalid profile binding registry envelope.");
  return await sha256Hex("hra-profile-binding-registry-envelope:v1\n" + JSON.stringify(parsed));
}

const portableMemorySpacePattern = /^hra:project:space-[a-f0-9]{32}$/u;

function parseMemorySummaryHead(value: unknown): MemorySummaryHead | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["digest", "operationSha256", "sequence"])
    || typeof value.digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.digest)
    || (value.operationSha256 !== null
      && (typeof value.operationSha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(value.operationSha256)))
    || !Number.isSafeInteger(value.sequence)
    || (value.sequence as number) < 0
    || Object.is(value.sequence, -0)
    || ((value.sequence as number) === 0) !== (value.operationSha256 === null)
  ) return null;
  return {
    digest: value.digest,
    operationSha256: value.operationSha256,
    sequence: value.sequence as number,
  };
}

function parseMemorySummaryPeerIdentity(value: unknown): MemorySummaryPeerIdentity | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, ["label", "ref"])
    || !isRegistryLabel(value.label)
    || typeof value.ref !== "string"
    || !/^[a-f0-9]{64}$/u.test(value.ref)
  ) return null;
  return { label: value.label, ref: value.ref };
}

function parseMemorySummaryPayloadUnchecked(value: unknown): MemorySummaryPayload | null {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "coverage",
      "observedAt",
      "peerActions",
      "peerPolicies",
      "spaces",
      "version",
    ])
    || value.version !== 1
    || !isRegistryTimestamp(value.observedAt)
    || !isRecord(value.coverage)
    || !hasExactKeys(value.coverage, ["peerActions", "peerPolicies", "spaces"])
    || (value.coverage.peerActions !== "bounded" && value.coverage.peerActions !== "complete")
    || (value.coverage.peerPolicies !== "bounded" && value.coverage.peerPolicies !== "complete")
    || (value.coverage.spaces !== "bounded" && value.coverage.spaces !== "complete")
    || !Array.isArray(value.spaces)
    || value.spaces.length > memorySummaryLimits.spaces
    || !Array.isArray(value.peerPolicies)
    || value.peerPolicies.length > memorySummaryLimits.peerPolicies
    || !Array.isArray(value.peerActions)
    || value.peerActions.length > memorySummaryLimits.peerActions
  ) return null;

  const spaces: MemorySummarySpace[] = [];
  const spaceIds = new Set<string>();
  for (const entry of value.spaces) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, [
        "bindingDigest",
        "canonicalSpaceId",
        "enrollment",
        "head",
        "lastExchangeAt",
        "projectLabel",
        "recentRecords",
        "recordCount",
        "remoteHead",
        "syncStatus",
      ])
      || typeof entry.bindingDigest !== "string"
      || !/^[a-f0-9]{64}$/u.test(entry.bindingDigest)
      || typeof entry.canonicalSpaceId !== "string"
      || !portableMemorySpacePattern.test(entry.canonicalSpaceId)
      || (entry.enrollment !== "attached"
        && entry.enrollment !== "detached"
        && entry.enrollment !== "not_enrolled"
        && entry.enrollment !== "unavailable")
      || !isRegistryLabel(entry.projectLabel)
      || (entry.recordCount !== null && (
        !Number.isSafeInteger(entry.recordCount)
        || (entry.recordCount as number) < 0
        || Object.is(entry.recordCount, -0)
      ))
      || (entry.lastExchangeAt !== null && !isRegistryTimestamp(entry.lastExchangeAt))
      || (entry.lastExchangeAt !== null && entry.lastExchangeAt > value.observedAt)
      || (entry.syncStatus !== "conflict"
        && entry.syncStatus !== "error"
        && entry.syncStatus !== "local_only"
        && entry.syncStatus !== "settled"
        && entry.syncStatus !== "syncing")
      || !Array.isArray(entry.recentRecords)
      || entry.recentRecords.length > memorySummaryLimits.recentRecordsPerSpace
      || spaceIds.has(entry.canonicalSpaceId)
    ) return null;
    const head = parseMemorySummaryHead(entry.head);
    const remoteHead = entry.remoteHead === null ? null : parseMemorySummaryHead(entry.remoteHead);
    if (head === null || (entry.remoteHead !== null && remoteHead === null)) return null;
    if (
      entry.enrollment === "not_enrolled"
      && (entry.syncStatus !== "local_only" || remoteHead !== null || entry.lastExchangeAt !== null)
    ) return null;
    if (
      entry.syncStatus === "local_only"
      && entry.enrollment !== "not_enrolled"
      && entry.enrollment !== "detached"
    ) return null;
    if (entry.enrollment === "attached" && remoteHead === null) return null;
    if (
      entry.recordCount === null
      && (entry.enrollment !== "unavailable" || entry.recentRecords.length !== 0)
    ) return null;
    if (
      entry.syncStatus === "settled"
      && (remoteHead === null
        || remoteHead.sequence !== head.sequence
        || remoteHead.operationSha256 !== head.operationSha256
        || remoteHead.digest !== head.digest)
    ) return null;
    const recentRecords: MemorySummaryRecentRecord[] = [];
    const recordKeys = new Set<string>();
    for (const record of entry.recentRecords) {
      if (
        !isRecord(record)
        || !hasExactKeys(record, ["key", "kind", "updatedAt"])
        || record.kind !== "memory_page"
        || !isRegistryLabel(record.key, 512)
        || !isRegistryTimestamp(record.updatedAt)
        || record.updatedAt > value.observedAt
        || recordKeys.has(record.key)
      ) return null;
      recordKeys.add(record.key);
      recentRecords.push({ key: record.key, kind: record.kind, updatedAt: record.updatedAt });
    }
    if (entry.recordCount !== null && (entry.recordCount as number) < recentRecords.length) {
      return null;
    }
    spaceIds.add(entry.canonicalSpaceId);
    spaces.push({
      bindingDigest: entry.bindingDigest,
      canonicalSpaceId: entry.canonicalSpaceId,
      enrollment: entry.enrollment,
      head,
      lastExchangeAt: entry.lastExchangeAt,
      projectLabel: entry.projectLabel,
      recentRecords,
      recordCount: entry.recordCount as number | null,
      remoteHead,
      syncStatus: entry.syncStatus,
    });
  }

  const peerPolicies: MemorySummaryPeerPolicy[] = [];
  const policyRefs = new Set<string>();
  for (const entry of value.peerPolicies) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["mode", "projectLabel", "session", "updatedAt"])
      || (entry.mode !== "coordinate" && entry.mode !== "inspect" && entry.mode !== "off")
      || !isRegistryLabel(entry.projectLabel)
      || !isRegistryTimestamp(entry.updatedAt)
      || entry.updatedAt > value.observedAt
    ) return null;
    const session = parseMemorySummaryPeerIdentity(entry.session);
    if (session === null || policyRefs.has(session.ref)) return null;
    policyRefs.add(session.ref);
    peerPolicies.push({
      mode: entry.mode,
      projectLabel: entry.projectLabel,
      session,
      updatedAt: entry.updatedAt,
    });
  }

  const peerActions: MemorySummaryPeerAction[] = [];
  for (const entry of value.peerActions) {
    if (
      !isRecord(entry)
      || !hasExactKeys(entry, ["actor", "createdAt", "delivery", "state", "target", "updatedAt"])
      || (entry.delivery !== "queue" && entry.delivery !== "send" && entry.delivery !== "steer")
      || (entry.state !== "ambiguous"
        && entry.state !== "applied"
        && entry.state !== "cancelled"
        && entry.state !== "effect_started"
        && entry.state !== "failed"
        && entry.state !== "prepared"
        && entry.state !== "queued")
      || !isRegistryTimestamp(entry.createdAt)
      || !isRegistryTimestamp(entry.updatedAt)
      || entry.updatedAt < entry.createdAt
      || entry.updatedAt > value.observedAt
    ) return null;
    const actor = parseMemorySummaryPeerIdentity(entry.actor);
    const target = parseMemorySummaryPeerIdentity(entry.target);
    if (actor === null || target === null || actor.ref === target.ref) return null;
    peerActions.push({
      actor,
      createdAt: entry.createdAt,
      delivery: entry.delivery,
      state: entry.state,
      target,
      updatedAt: entry.updatedAt,
    });
  }

  return {
    coverage: {
      peerActions: value.coverage.peerActions,
      peerPolicies: value.coverage.peerPolicies,
      spaces: value.coverage.spaces,
    },
    observedAt: value.observedAt,
    peerActions,
    peerPolicies,
    spaces,
    version: 1,
  };
}

/** Parse one immutable accessor-free snapshot of an untrusted memory summary. */
export function parseMemorySummaryPayload(value: unknown): MemorySummaryPayload | null {
  const snapshot = snapshotForeignJson(value);
  return snapshot.ok ? parseMemorySummaryPayloadUnchecked(snapshot.value) : null;
}

/**
 * Preflight the separate summary before spending an account-key nonce. The
 * conservative plaintext bound is the same AES-GCM plus unpadded-base64
 * bound enforced after encryption.
 */
export function memorySummaryFitsEncryptedEnvelope(value: unknown): boolean {
  const parsed = parseMemorySummaryPayload(value);
  if (parsed === null) return false;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(parsed)).byteLength;
    return bytes <= Math.floor(cloudLimits.memorySummaryCiphertextCharacters * 3 / 4) - 16;
  } catch {
    return false;
  }
}

export function cloudPayloadAad(authority: CloudPayloadAuthority): Uint8Array {
  if (
    !isOpaqueIdentifier(authority.entityPublicId)
    || !isOpaqueIdentifier(authority.userPublicId)
    || !Number.isSafeInteger(authority.keyVersion)
    || authority.keyVersion < 1
  ) throw new Error("Invalid cloud payload authority.");
  return new TextEncoder().encode([
    "hra-control-plane-cloud-payload:v1",
    authority.kind,
    authority.userPublicId,
    authority.entityPublicId,
    String(authority.keyVersion),
  ].join("\n"));
}

async function encryptJson(
  value: unknown,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  return await encryptBytes(
    new TextEncoder().encode(JSON.stringify(value)),
    key,
    authority.keyVersion,
    cloudPayloadAad(authority),
  );
}

async function decryptJson(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<unknown> {
  if (envelope.keyVersion !== authority.keyVersion) throw new Error("Cloud payload key mismatch.");
  const plaintext = await decryptBytes(envelope, key, cloudPayloadAad(authority));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
}

export type AuthenticatedPayloadInspection<T> =
  | Readonly<{ kind: "invalid" }>
  | Readonly<{ kind: "valid"; payload: T }>;

async function inspectAuthenticatedJson<T>(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
  parse: (value: unknown) => T | null,
): Promise<AuthenticatedPayloadInspection<T>> {
  if (envelope.keyVersion !== authority.keyVersion) throw new Error("Cloud payload key mismatch.");
  // Authentication failures intentionally escape. Only bytes authenticated by
  // the account key may be classified as a deterministic semantic rejection.
  const plaintext = await decryptBytes(envelope, key, cloudPayloadAad(authority));
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as unknown;
  } catch {
    return { kind: "invalid" };
  }
  const parsed = parse(value);
  return parsed === null ? { kind: "invalid" } : { kind: "valid", payload: parsed };
}

export async function encryptRemoteCommand(
  payload: RemoteCommandPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  const parsed = parseRemoteCommandPayload(payload);
  if (authority.kind !== "command" || parsed === null) {
    throw new Error("Invalid remote command payload.");
  }
  return await encryptJson(parsed, key, authority);
}

export async function decryptRemoteCommand(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<RemoteCommandPayload> {
  const inspected = await inspectRemoteCommand(envelope, key, authority);
  if (inspected.kind === "invalid") throw new Error("Invalid remote command payload.");
  return inspected.payload;
}

export async function inspectRemoteCommand(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<AuthenticatedPayloadInspection<RemoteCommandPayload>> {
  if (authority.kind !== "command") throw new Error("Invalid remote command authority.");
  return await inspectAuthenticatedJson(envelope, key, authority, parseRemoteCommandPayload);
}

export async function encryptDeviceCommand(
  payload: DeviceCommandPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "device_command" || parseDeviceCommandPayload(payload) === null) {
    throw new Error("Invalid device command payload.");
  }
  return await encryptJson(payload, key, authority);
}

export async function decryptDeviceCommand(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<DeviceCommandPayload> {
  const inspected = await inspectDeviceCommand(envelope, key, authority);
  if (inspected.kind === "invalid") throw new Error("Invalid device command payload.");
  return inspected.payload;
}

export async function inspectDeviceCommand(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<AuthenticatedPayloadInspection<DeviceCommandPayload>> {
  if (authority.kind !== "device_command") throw new Error("Invalid device command authority.");
  return await inspectAuthenticatedJson(envelope, key, authority, parseDeviceCommandPayload);
}

export async function encryptDeviceCommandResult(
  payload: DeviceCommandResultPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (
    authority.kind !== "device_command_result"
    || parseDeviceCommandResultPayload(payload) === null
  ) throw new Error("Invalid device command result.");
  return await encryptJson(payload, key, authority);
}

export async function decryptDeviceCommandResult(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<DeviceCommandResultPayload> {
  if (authority.kind !== "device_command_result") {
    throw new Error("Invalid device command result authority.");
  }
  const parsed = parseDeviceCommandResultPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid device command result.");
  return parsed;
}

export async function encryptSessionMetadata(
  payload: SessionMetadataPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "session_metadata" || parseSessionMetadataPayload(payload) === null) {
    throw new Error("Invalid session metadata payload.");
  }
  return await encryptJson(payload, key, authority);
}

export async function decryptSessionMetadata(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<SessionMetadataPayload> {
  if (authority.kind !== "session_metadata") throw new Error("Invalid session metadata authority.");
  const parsed = parseSessionMetadataPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid session metadata payload.");
  return parsed;
}

export async function encryptDeviceRegistry(
  payload: DeviceRegistryPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  const parsed = parseDeviceRegistryPayload(payload);
  if (authority.kind !== "device_registry" || parsed === null) {
    throw new Error("Invalid device registry payload.");
  }
  const envelope = await encryptJson(parsed, key, authority);
  if (envelope.ciphertext.length > cloudLimits.registryCiphertextCharacters) {
    throw new Error("Encrypted device registry exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptDeviceRegistry(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<DeviceRegistryPayload> {
  if (authority.kind !== "device_registry") throw new Error("Invalid device registry authority.");
  const parsed = parseDeviceRegistryPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid device registry payload.");
  return parsed;
}

export async function encryptProfileBinding(
  payload: ProfileBindingPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  const parsed = parseProfileBindingPayload(payload);
  if (authority.kind !== "profile_binding" || parsed === null) {
    throw new Error("Invalid profile binding payload.");
  }
  const envelope = await encryptJson(parsed, key, authority);
  if (envelope.ciphertext.length > cloudLimits.profileBindingCiphertextCharacters) {
    throw new Error("Encrypted profile binding exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptProfileBinding(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<ProfileBindingPayload> {
  if (authority.kind !== "profile_binding") throw new Error("Invalid profile binding authority.");
  const snapshot = snapshotForeignJson(envelope);
  const parsedEnvelope = snapshot.ok
    ? parseEncryptedEnvelope(snapshot.value, cloudLimits.profileBindingCiphertextCharacters)
    : null;
  if (parsedEnvelope === null) throw new Error("Invalid profile binding envelope.");
  const parsed = parseProfileBindingPayload(await decryptJson(parsedEnvelope, key, authority));
  if (parsed === null) throw new Error("Invalid profile binding payload.");
  return parsed;
}

export async function encryptMemorySummary(
  payload: MemorySummaryPayload,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  const parsed = parseMemorySummaryPayload(payload);
  if (authority.kind !== "memory_summary" || parsed === null) {
    throw new Error("Invalid memory summary payload.");
  }
  if (!memorySummaryFitsEncryptedEnvelope(parsed)) {
    throw new Error("Encrypted memory summary exceeds its closed envelope bound.");
  }
  const envelope = await encryptJson(parsed, key, authority);
  if (envelope.ciphertext.length > cloudLimits.memorySummaryCiphertextCharacters) {
    throw new Error("Encrypted memory summary exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptMemorySummary(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<MemorySummaryPayload> {
  if (authority.kind !== "memory_summary") throw new Error("Invalid memory summary authority.");
  const parsed = parseMemorySummaryPayload(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid memory summary payload.");
  return parsed;
}

/** A separate envelope keeps notification hours out of the broad registry projection. */
export async function encryptNotificationHours(
  payload: NotificationHoursPolicy,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  const parsed = parseNotificationHoursPolicy(payload);
  if (authority.kind !== "notification_hours" || parsed === null) {
    throw new Error("Invalid notification hours payload.");
  }
  const envelope = await encryptJson(parsed, key, authority);
  if (envelope.ciphertext.length > cloudLimits.notificationHoursCiphertextCharacters) {
    throw new Error("Encrypted notification hours exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptNotificationHours(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<NotificationHoursPolicy> {
  if (authority.kind !== "notification_hours") throw new Error("Invalid notification hours authority.");
  const parsed = parseNotificationHoursPolicy(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid notification hours payload.");
  return parsed;
}

/** A separate envelope preserves byte compatibility for the broad v1 registry. */
export async function encryptNotificationEmail(
  payload: NotificationEmailPolicy,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  const parsed = parseNotificationEmailPolicy(payload);
  if (authority.kind !== "notification_email" || parsed === null) {
    throw new Error("Invalid notification email payload.");
  }
  const envelope = await encryptJson(parsed, key, authority);
  if (envelope.ciphertext.length > cloudLimits.notificationEmailCiphertextCharacters) {
    throw new Error("Encrypted notification email policy exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptNotificationEmail(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<NotificationEmailPolicy> {
  if (authority.kind !== "notification_email") {
    throw new Error("Invalid notification email authority.");
  }
  const parsed = parseNotificationEmailPolicy(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid notification email payload.");
  return parsed;
}

export async function encryptUsageProjection(
  payload: UsageProjection,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<EncryptedEnvelope> {
  if (authority.kind !== "usage" || parseUsageProjection(payload) === null) {
    throw new Error("Invalid usage projection.");
  }
  const envelope = await encryptJson(payload, key, authority);
  if (parseUsageEncryptedEnvelope(envelope) === null) {
    throw new Error("Encrypted usage projection exceeds its closed envelope bound.");
  }
  return envelope;
}

export async function decryptUsageProjection(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  authority: CloudPayloadAuthority,
): Promise<UsageProjection> {
  if (
    authority.kind !== "usage"
    || parseUsageEncryptedEnvelope(envelope) === null
  ) throw new Error("Invalid usage authority.");
  const parsed = parseUsageProjection(await decryptJson(envelope, key, authority));
  if (parsed === null) throw new Error("Invalid usage projection.");
  return parsed;
}
