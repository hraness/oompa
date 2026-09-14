/**
 * The one seam between the browser app and the repository source.
 *
 * Only `src/cloud/{crypto,projection,payloads,contracts,client}` and
 * `src/domain/*` are browser safe. Every other `src/cloud` module reaches for
 * node built-ins, the local daemon, or on-disk secret custody and must never
 * enter this bundle. Keeping the deep relative paths in one file makes the
 * boundary reviewable and keeps the eslint layering rule enforceable.
 */
export { activePresetBinding, type PresetContract, type SupportedPreset, type SupportedProvider } from "../../../src/domain/presets";
export { classifyModelTaskShape, type ModelTaskShapeRule } from "../../../src/domain/model-task-shape";
export {
  decodeHistoricalProfileKey,
  type CanonicalProfile,
} from "../../../src/domain/canonical-profile";
export {
  canonicalDevicePublicKeyJson,
  decodeBase64Url,
  decryptBytes,
  deviceBindMessage,
  encodeBase64Url,
  encryptBytes,
  exportDevicePublicKey,
  generateDeviceSigningKeyPair,
  generateDeviceWrappingKeyPair,
  hmacSha256Hex,
  parseDevicePublicKeyJson,
  randomKeyBytes,
  sha256Hex,
  signDeviceBind,
  unwrapAccountDataKey,
  type DevicePublicKey,
} from "../../../src/cloud/crypto";

export {
  cloudLimits,
  COMMAND_KINDS,
  containsAbsolutePath,
  containsSecretShapedText,
  containsUnsafeTerminalScalar,
  DEVICE_COMMAND_KINDS,
  hasExactKeys,
  isBase64Url,
  isCommandKind,
  isDeviceCommandKind,
  isDigest,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  parseEncryptedEnvelope,
  parseWrappedKeyEnvelope,
  snapshotForeignJson,
  type AuthorityTuple,
  type CommandKind,
  type CommandState,
  type DeviceCommandKind,
  type EncryptedEnvelope,
  type SyncStream,
  type WrappedKeyEnvelope,
} from "../../../src/cloud/contracts";

export {
  compactInteractionDetailLimits,
  decryptCompactEvents,
  decryptDetailEvents,
  parseCompactSessionEvent,
  parseDetailSessionEvent,
  remoteInteractionPolicyReasonCodeOrder,
  sessionChunkAad,
  type CompactInteractionDecision,
  type CompactInteractionKind,
  type CompactInteractionQuestion,
  type CompactInteractionState,
  type CompactRemoteInteractionAction,
  type CompactRemoteInteractionPolicy,
  type CompactRemoteInteractionQuestion,
  type CompactRemoteInteractionReasonCode,
  type CompactMessageActor,
  type CompactMessageActorKind,
  type CompactSessionEvent,
  type DetailSessionEvent,
  type GitAction,
  type ModelPreset,
  type SessionChunkAuthority,
  type SessionStateValue,
} from "../../../src/cloud/projection";

export {
  activeRemoteDerivedCodexSelection,
  activeRemotePresetSelection,
  cloudPayloadAad,
  decryptDeviceCommandResult,
  decryptDeviceRegistry,
  decryptMemorySummary,
  decryptNotificationEmail,
  decryptNotificationHours,
  decryptProfileBinding,
  decryptSessionMetadata,
  decryptUsageProjection,
  deviceCommandLoginResultLifetimeMs,
  deviceCommandLimits,
  deviceRegistryLimits,
  memorySummaryLimits,
  encryptDeviceCommand,
  encryptRemoteCommand,
  encryptNotificationHours,
  parseDeviceCommandPayload,
  parseDeviceCommandResultPayload,
  parseDeviceRegistryPayload,
  parseMemorySummaryPayload,
  parseProfileBindingPayload,
  profileBindingRegistryDigest,
  parseRemoteCommandPayload,
  remoteInteractionAnswersFitCommandEnvelope,
  type CloudPayloadAuthority,
  type ActiveRemotePresetSelection,
  type DeviceCommandPayload,
  type DeviceCommandResultPayload,
  type DeviceRegistryAccount,
  type DeviceRegistryPayload,
  type DeviceRegistryProject,
  type DeviceRegistryScheduledTask,
  type DeviceRegistrySessionAdoption,
  type DeviceRegistrySessionAdoptionStatus,
  type MemorySummaryCoverage,
  type MemorySummaryHead,
  type MemorySummaryPayload,
  type MemorySummaryPeerAction,
  type MemorySummaryPeerIdentity,
  type MemorySummaryPeerPolicy,
  type MemorySummaryRecentRecord,
  type MemorySummarySpace,
  type ProfileBindingPayload,
  type RemoteCommandPayload,
  type SessionMetadataPayload,
} from "../../../src/cloud/payloads";

export type {
  NotificationEmailPolicy,
} from "../../../src/domain/notification-email-contract";

export type {
  NotificationHoursPolicy,
  NotificationHoursUpdate,
} from "../../../src/domain/notification-hours";

export type {
  CloudAction,
  CloudMutation,
  CloudQuery,
} from "../../../src/cloud/client";

export {
  createCloudUuidV7,
} from "../../../src/domain/uuid-v7";

export {
  remoteInteractionAnswerLimits,
  remoteInteractionJsonFitsProviderLimit,
} from "../../../src/domain/remote-interaction-contract";

export {
  parseUsageEncryptedEnvelope,
  USAGE_CLOUD_PROJECTION_MAX_LIMITS,
  type UsageLimit,
  type UsageProjection,
  type UsageReady,
  type UsageWindow,
} from "../../../src/cloud/payloads";
