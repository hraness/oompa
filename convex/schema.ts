import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

import {
  accountBindingState,
  accountDeletionCategory,
  accountDeletionState,
  authorityReductionCapacityReservation,
  authorityReductionCapacityVersion,
  attentionNotificationInteractionKind,
  attentionNotificationOutcomeCode,
  attentionNotificationRemoteAction,
  attentionNotificationServiceState,
  attentionNotificationState,
  attentionNotificationSuppressionReason,
  authAdmissionState,
  authAttemptKind,
  authSubjectAdmittedBy,
  authSubjectStatus,
  challengeDeliveryState,
  commandKind,
  commandCapacityReadinessState,
  commandLifecycleCapacityVersion,
  commandReceiptCapacityReservation,
  commandState,
  commandType,
  deviceClass,
  deviceCommandKind,
  deviceRevocationCategory,
  deviceRevocationState,
  deviceStatus,
  encryptedEnvelope,
  invitePurpose,
  inviteState,
  maintenanceCategory,
  newIdentityAdmissionState,
  quotaCategory,
  quotaAccountResource,
  quotaEnforcement,
  quotaUserResource,
  sessionStatus,
  syncStream,
  usageAdmissionAuthority,
  usageEncryptedEnvelope,
  wrappedKeyEnvelope,
} from "./validators";

export default defineSchema({
  ...authTables,
  authVerifiers: defineTable({
    sessionId: v.optional(v.id("authSessions")),
    signature: v.optional(v.string()),
  })
    .index("signature", ["signature"])
    .index("sessionId", ["sessionId"]),
  authSubjects: defineTable({
    admissionInviteId: v.optional(v.id("authInvites")),
    admittedBy: v.optional(authSubjectAdmittedBy),
    authEpoch: v.number(),
    createdAt: v.number(),
    emailDigest: v.string(),
    status: authSubjectStatus,
    // Lifetime count of code sends for an address that has never verified. It
    // stops here and is never reset while the subject stays unverified.
    unverifiedSendCount: v.optional(v.number()),
    updatedAt: v.number(),
    userId: v.optional(v.id("users")),
    verifiedAt: v.optional(v.number()),
  })
    .index("by_email_digest", ["emailDigest"])
    .index("by_unverified_status_and_updated_at", ["verifiedAt", "status", "updatedAt"])
    .index("by_user", ["userId"]),
  authEmailAttemptEvents: defineTable({
    authEpoch: v.number(),
    createdAt: v.number(),
    emailDigest: v.string(),
    expiresAt: v.number(),
    kind: authAttemptKind,
  })
    .index("by_email_kind_and_created_at", ["emailDigest", "kind", "createdAt"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_kind_and_created_at", ["kind", "createdAt"]),
  authOtpChallenges: defineTable({
    accountId: v.id("authAccounts"),
    authEpoch: v.number(),
    codeDigest: v.string(),
    createdAt: v.number(),
    deliveryState: challengeDeliveryState,
    emailDigest: v.string(),
    expiresAt: v.number(),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_email", ["emailDigest"])
    .index("by_expires_at", ["expiresAt"])
    .index("by_user", ["userId"])
    .index("by_user_and_expires_at", ["userId", "expiresAt"]),
  authInvites: defineTable({
    admissionExpiresAt: v.optional(v.number()),
    boundAt: v.optional(v.number()),
    boundEmailDigest: v.optional(v.string()),
    capabilityDigest: v.string(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
    issuedByUserId: v.optional(v.id("users")),
    publicId: v.string(),
    purpose: invitePurpose,
    requestedLifetimeMs: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    state: inviteState,
    updatedAt: v.number(),
  })
    .index("by_capability_digest", ["capabilityDigest"])
    .index("by_bound_email_digest", ["boundEmailDigest"])
    .index("by_expiry", ["expiresAt"])
    .index("by_issuer", ["issuedByUserId"])
    .index("by_public_id", ["publicId"]),
  devices: defineTable({
    activatedAt: v.optional(v.number()),
    attentionNotificationAuthority: v.optional(v.object({
      consentLeaseUntil: v.number(),
      globalNotificationGeneration: v.number(),
      localNotificationPolicyRevision: v.number(),
      reconciliationSequence: v.number(),
    })),
    authEpoch: v.number(),
    createdAt: v.number(),
    credentialGeneration: v.optional(v.number()),
    deviceClass: v.optional(deviceClass),
    encryptedLabel: encryptedEnvelope,
    keyVersion: v.number(),
    publicId: v.string(),
    registrationBootstrapKeyEnvelope: v.optional(wrappedKeyEnvelope),
    registrationIdempotencyKey: v.optional(v.string()),
    registrationRequestDigest: v.optional(v.string()),
    revision: v.number(),
    revokedAt: v.optional(v.number()),
    signingPublicKey: v.string(),
    status: deviceStatus,
    updatedAt: v.number(),
    userId: v.id("users"),
    wrappingPublicKey: v.string(),
  })
    .index("by_public_id", ["publicId"])
    .index("by_user_and_public_id", ["userId", "publicId"])
    .index("by_user_and_status", ["userId", "status"]),
  accountDeletionIdentityReservations: defineTable({
    capacityReservation: v.literal(authorityReductionCapacityReservation),
    capacityVersion: v.literal(authorityReductionCapacityVersion),
    category: v.literal("identity"),
    createdAt: v.number(),
    userId: v.id("users"),
  }).index("by_user", ["userId"]),
  accountDeletionJobReservations: defineTable({
    capacityReservation: v.literal(authorityReductionCapacityReservation),
    capacityVersion: v.literal(authorityReductionCapacityVersion),
    category: v.literal("job"),
    createdAt: v.number(),
    userId: v.id("users"),
  }).index("by_user", ["userId"]),
  deviceRevocationDeviceReservations: defineTable({
    capacityReservation: v.literal(authorityReductionCapacityReservation),
    capacityVersion: v.literal(authorityReductionCapacityVersion),
    category: v.literal("device"),
    createdAt: v.number(),
    deviceId: v.id("devices"),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  deviceRevocationJobReservations: defineTable({
    capacityReservation: v.literal(authorityReductionCapacityReservation),
    capacityVersion: v.literal(authorityReductionCapacityVersion),
    category: v.literal("job"),
    createdAt: v.number(),
    deviceId: v.id("devices"),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  deviceRevocationSecurityReservations: defineTable({
    capacityReservation: v.literal(authorityReductionCapacityReservation),
    capacityVersion: v.literal(authorityReductionCapacityVersion),
    category: v.literal("security"),
    createdAt: v.number(),
    deviceId: v.id("devices"),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  deviceRevocationReceiptReservations: defineTable({
    capacityReservation: v.literal(authorityReductionCapacityReservation),
    capacityVersion: v.literal(authorityReductionCapacityVersion),
    category: v.literal("receipt"),
    createdAt: v.number(),
    deviceId: v.id("devices"),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  deviceSessions: defineTable({
    authEpoch: v.number(),
    authSessionId: v.id("authSessions"),
    boundAt: v.number(),
    deviceId: v.id("devices"),
    revokedAt: v.optional(v.number()),
    userId: v.id("users"),
  })
    .index("by_auth_session", ["authSessionId"])
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  deviceBindChallenges: defineTable({
    authSessionId: v.id("authSessions"),
    challengeId: v.string(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
    deviceId: v.id("devices"),
    expiresAt: v.number(),
    nonce: v.string(),
    userId: v.id("users"),
  })
    .index("by_challenge", ["challengeId"])
    .index("by_device", ["deviceId"])
    .index("by_expiry", ["expiresAt"])
    .index("by_user", ["userId"]),
  deviceKeyEnvelopes: defineTable({
    createdAt: v.number(),
    deviceId: v.id("devices"),
    envelope: wrappedKeyEnvelope,
    userId: v.id("users"),
  })
    .index("by_device_and_version", ["deviceId", "envelope.keyVersion"])
    .index("by_user", ["userId"]),
  recoveryEnvelopes: defineTable({
    createdAt: v.number(),
    envelope: encryptedEnvelope,
    recoveryVerifierDigest: v.string(),
    retiredAt: v.optional(v.number()),
    userId: v.id("users"),
  })
    .index("by_user_and_version", ["userId", "envelope.keyVersion"])
    .index("by_user", ["userId"]),
  devicePresence: defineTable({
    authEpoch: v.number(),
    connectionId: v.string(),
    connectionSequence: v.number(),
    credentialGeneration: v.number(),
    deviceId: v.id("devices"),
    fingerprint: v.string(),
    observedAt: v.number(),
    presenceUntil: v.number(),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_presence_until", ["presenceUntil"])
    .index("by_user", ["userId"]),
  deviceRegistries: defineTable({
    commandRequestVersion: v.optional(v.literal(2)),
    createdAt: v.number(),
    deviceId: v.id("devices"),
    devicePublicId: v.string(),
    envelope: encryptedEnvelope,
    keyVersion: v.number(),
    memorySummaryEnvelope: v.optional(encryptedEnvelope),
    memorySummaryRevision: v.optional(v.number()),
    memorySummaryUpdatedAt: v.optional(v.number()),
    notificationEmailEnvelope: v.optional(encryptedEnvelope),
    notificationHoursEnvelope: v.optional(encryptedEnvelope),
    notificationPolicyRevision: v.optional(v.number()),
    profileBindingEnvelope: v.optional(encryptedEnvelope),
    revision: v.number(),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_user_and_device_public_id", ["userId", "devicePublicId"])
    .index("by_user", ["userId"]),
  memorySpaces: defineTable({
    bindingPolicy: v.literal("one_project_one_space"),
    createdAt: v.number(),
    encryptedDescriptor: encryptedEnvelope,
    genesisToken: v.string(),
    genesisHeadProof: encryptedEnvelope,
    identityContract: v.literal(2),
    keyVersion: v.number(),
    publicId: v.string(),
    revision: v.number(),
    updatedAt: v.number(),
    userId: v.id("users"),
    wrappedSpaceKey: encryptedEnvelope,
  })
    .index("by_user_and_public_id", ["userId", "publicId"])
    .index("by_user_and_updated_at", ["userId", "updatedAt"]),
  memoryOperations: defineTable({
    adoptionProof: v.union(v.null(), encryptedEnvelope),
    baseRevision: v.number(),
    createdAt: v.number(),
    genesisToken: v.string(),
    headToken: v.string(),
    keyVersion: v.number(),
    memorySpaceId: v.id("memorySpaces"),
    operation: encryptedEnvelope,
    priorToken: v.string(),
    sequence: v.number(),
    sourceDeviceId: v.id("devices"),
    terminalHeadProof: encryptedEnvelope,
    userId: v.id("users"),
  })
    .index("by_space_and_sequence", ["memorySpaceId", "sequence"])
    .index("by_space_and_head_token", ["memorySpaceId", "headToken"])
    .index("by_user", ["userId"]),
  sessionHeads: defineTable({
    compactHasRecoveryGap: v.optional(v.boolean()),
    compactHeadSequence: v.number(),
    compactStreamEpoch: v.optional(v.number()),
    compactTailDigest: v.optional(v.string()),
    createdAt: v.number(),
    detailHeadSequence: v.number(),
    // Bumped whenever the live_tail sweeper prunes detail chunks below the
    // digest chain's current tail. Mirrors compactStreamEpoch, but is only
    // ever advanced by the retention sweeper, never by a device.
    detailStreamEpoch: v.optional(v.number()),
    detailTailDigest: v.optional(v.string()),
    executionDeviceId: v.id("devices"),
    metadata: v.optional(encryptedEnvelope),
    metadataRevision: v.number(),
    projectionRevision: v.number(),
    publicId: v.string(),
    state: sessionStatus,
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_execution_device", ["executionDeviceId"])
    .index("by_execution_device_and_state", ["executionDeviceId", "state"])
    .index("by_public_id", ["publicId"])
    .index("by_user_and_public_id", ["userId", "publicId"])
    .index("by_user_and_updated_at", ["userId", "updatedAt"]),
  sessionChunks: defineTable({
    authority: v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    }),
    createdAt: v.number(),
    digest: v.string(),
    envelope: encryptedEnvelope,
    // Set only on detail-stream (live_tail) chunks; the sweeper in
    // convex/maintenance.ts deletes rows past this deadline. Absent on
    // compact-stream chunks, which never expire on their own.
    expiresAt: v.optional(v.number()),
    firstSequence: v.number(),
    lastSequence: v.number(),
    previousDigest: v.optional(v.string()),
    sessionId: v.id("sessionHeads"),
    sourceDeviceId: v.id("devices"),
    stream: syncStream,
    streamEpoch: v.optional(v.number()),
    userId: v.id("users"),
  })
    .index("by_session_stream_and_first", ["sessionId", "stream", "firstSequence"])
    .index("by_session_stream_and_last", ["sessionId", "stream", "lastSequence"])
    .index("by_stream_and_expires_at", ["stream", "expiresAt"])
    .index("by_user_and_stream", ["userId", "stream"])
    .index("by_user", ["userId"]),
  sessionStreamEpochs: defineTable({
    authority: v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    }),
    boundaryHeadSequence: v.number(),
    boundaryTailDigest: v.optional(v.string()),
    createdAt: v.number(),
    epoch: v.number(),
    idempotencyKey: v.string(),
    lineageCommitment: v.string(),
    predecessorEpoch: v.number(),
    projectionRevision: v.optional(v.number()),
    publicId: v.string(),
    // "projection_cache_recovery" is device-initiated (compact stream only,
    // see beginCompactEpoch). "live_tail_retention" is system-initiated by
    // the maintenance sweeper when it prunes expired detail chunks (see
    // convex/maintenance.ts); it never carries an idempotencyKey/
    // requestDigest a client can replay against.
    reason: v.union(
      v.literal("projection_cache_recovery"),
      v.literal("live_tail_retention"),
    ),
    requestDigest: v.string(),
    sessionId: v.id("sessionHeads"),
    sourceDeviceId: v.id("devices"),
    stream: syncStream,
    userId: v.id("users"),
  })
    .index("by_public_id", ["publicId"])
    .index("by_session_stream_and_epoch", ["sessionId", "stream", "epoch"])
    .index("by_user_session_stream_and_epoch", [
      "userId",
      "sessionId",
      "stream",
      "epoch",
    ])
    .index("by_user", ["userId"]),
  executionLeases: defineTable({
    bootGeneration: v.number(),
    bootId: v.string(),
    deviceId: v.id("devices"),
    fence: v.number(),
    heartbeatFingerprint: v.string(),
    heartbeatSequence: v.number(),
    leaseUntil: v.number(),
    sessionId: v.id("sessionHeads"),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_session", ["sessionId"])
    .index("by_device", ["deviceId"])
    .index("by_user", ["userId"]),
  sessionCommands: defineTable({
    boundAuthority: v.optional(v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    })),
    createdAt: v.number(),
    deadline: v.number(),
    idempotencyKey: v.string(),
    kind: commandKind,
    lifecycleCapacityVersion: v.optional(v.literal(commandLifecycleCapacityVersion)),
    nonterminal: v.boolean(),
    operatorAbandonedAt: v.optional(v.number()),
    payload: encryptedEnvelope,
    publicId: v.string(),
    requestCommitmentVersion: v.optional(v.literal(2)),
    requestDigest: v.string(),
    requestingDeviceId: v.id("devices"),
    requesterAcknowledgedAt: v.optional(v.number()),
    requesterReceiptAbandonedAt: v.optional(v.number()),
    receiptCapacityReservation: v.optional(v.literal(commandReceiptCapacityReservation)),
    result: v.optional(encryptedEnvelope),
    resultCode: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    sessionId: v.id("sessionHeads"),
    state: commandState,
    targetDeviceId: v.id("devices"),
    terminalCleanupAfter: v.optional(v.number()),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_public_id", ["publicId"])
    .index("by_session_and_created_at", ["sessionId", "createdAt"])
    .index("by_session_and_state", ["sessionId", "state"])
    .index("by_session_nonterminal_capacity_and_created_at", [
      "sessionId",
      "nonterminal",
      "lifecycleCapacityVersion",
      "createdAt",
    ])
    .index("by_target_state_and_created_at", ["targetDeviceId", "state", "createdAt"])
    .index("by_target_state_capacity_and_created_at", [
      "targetDeviceId",
      "state",
      "lifecycleCapacityVersion",
      "createdAt",
    ])
    .index("by_target_nonterminal_and_created_at", ["targetDeviceId", "nonterminal", "createdAt"])
    .index("by_target_nonterminal_capacity_and_created_at", [
      "targetDeviceId",
      "nonterminal",
      "lifecycleCapacityVersion",
      "createdAt",
    ])
    .index("by_requesting_device_and_nonterminal", ["requestingDeviceId", "nonterminal", "createdAt"])
    .index("by_requesting_device_nonterminal_capacity_and_created_at", [
      "requestingDeviceId",
      "nonterminal",
      "lifecycleCapacityVersion",
      "createdAt",
    ])
    .index("by_requesting_device_nonterminal_capacity_ack_and_created_at", [
      "requestingDeviceId",
      "nonterminal",
      "lifecycleCapacityVersion",
      "requesterAcknowledgedAt",
      "createdAt",
    ])
    .index("by_requesting_device_and_acknowledgement", [
      "requestingDeviceId",
      "requesterAcknowledgedAt",
      "createdAt",
    ])
    .index("by_requesting_device_acknowledgement_and_cleanup", [
      "requestingDeviceId",
      "requesterAcknowledgedAt",
      "terminalCleanupAfter",
      "createdAt",
    ])
    .index("by_requesting_device_ack_cleanup_capacity_and_created_at", [
      "requestingDeviceId",
      "requesterAcknowledgedAt",
      "terminalCleanupAfter",
      "lifecycleCapacityVersion",
      "receiptCapacityReservation",
      "createdAt",
    ])
    .index("by_requesting_device_nonterminal_acknowledgement_and_cleanup", [
      "requestingDeviceId",
      "nonterminal",
      "requesterAcknowledgedAt",
      "terminalCleanupAfter",
      "receiptCapacityReservation",
      "createdAt",
    ])
    .index("by_state_and_deadline", ["state", "deadline"])
    .index("by_state_capacity_and_deadline", [
      "state",
      "lifecycleCapacityVersion",
      "deadline",
    ])
    .index("by_state_and_updated_at", ["state", "updatedAt"])
    .index("by_acknowledged_no_effect_cleanup", [
      "state",
      "lifecycleCapacityVersion",
      "nonterminal",
      "terminalCleanupAfter",
      "receiptCapacityReservation",
      "requesterReceiptAbandonedAt",
      "operatorAbandonedAt",
      "resultCode",
      "resultDigest",
      "requesterAcknowledgedAt",
    ])
    .index("by_state_and_cleanup_after", ["state", "terminalCleanupAfter"])
    .index("by_state_unreserved_receipt_and_updated_at", [
      "state",
      "receiptCapacityReservation",
      "requesterAcknowledgedAt",
      "requesterReceiptAbandonedAt",
      "updatedAt",
    ])
    .index("by_idempotency", [
      "userId",
      "sessionId",
      "requestingDeviceId",
      "kind",
      "idempotencyKey",
    ])
    .index("by_user", ["userId"]),
  // Device commands are addressed to a device, never to a session. There is no
  // session id, no execution lease, and no per-session FIFO: the fence that
  // orders them is the target daemon's own boot authority, bound at prepare and
  // only ever replaced by a strictly greater fence (see convex/deviceCommands.ts).
  deviceCommands: defineTable({
    boundAuthority: v.optional(v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    })),
    createdAt: v.number(),
    deadline: v.number(),
    idempotencyKey: v.string(),
    kind: deviceCommandKind,
    lifecycleCapacityVersion: v.optional(v.literal(commandLifecycleCapacityVersion)),
    nonterminal: v.boolean(),
    operatorAbandonedAt: v.optional(v.number()),
    payload: encryptedEnvelope,
    publicId: v.string(),
    requestCommitmentVersion: v.optional(v.literal(2)),
    requestDigest: v.string(),
    requestingDeviceId: v.id("devices"),
    requesterAcknowledgedAt: v.optional(v.number()),
    requesterReceiptAbandonedAt: v.optional(v.number()),
    receiptCapacityReservation: v.optional(v.literal(commandReceiptCapacityReservation)),
    // Set when a settled result is a single-use account-linking handoff.
    // `deviceCommands:consumeResult` clears `result` on the first read and
    // stamps this, so a second read can prove the result is spent rather than
    // absent.
    resultConsumedAt: v.optional(v.number()),
    // Server-owned hosted deadline for an unread single-use login handoff.
    // Consumption or maintenance clears it together with `result`.
    resultExpiresAt: v.optional(v.number()),
    result: v.optional(encryptedEnvelope),
    resultCode: v.optional(v.string()),
    resultDigest: v.optional(v.string()),
    resultSingleUse: v.optional(v.boolean()),
    state: commandState,
    targetDeviceId: v.id("devices"),
    terminalCleanupAfter: v.optional(v.number()),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_public_id", ["publicId"])
    .index("by_target_and_created_at", ["targetDeviceId", "createdAt"])
    .index("by_target_state_and_created_at", ["targetDeviceId", "state", "createdAt"])
    .index("by_target_state_capacity_and_created_at", [
      "targetDeviceId",
      "state",
      "lifecycleCapacityVersion",
      "createdAt",
    ])
    .index("by_target_nonterminal_and_created_at", ["targetDeviceId", "nonterminal", "createdAt"])
    .index("by_target_nonterminal_capacity_and_created_at", [
      "targetDeviceId",
      "nonterminal",
      "lifecycleCapacityVersion",
      "createdAt",
    ])
    .index("by_requesting_device_and_nonterminal", ["requestingDeviceId", "nonterminal", "createdAt"])
    .index("by_requesting_device_nonterminal_capacity_and_created_at", [
      "requestingDeviceId",
      "nonterminal",
      "lifecycleCapacityVersion",
      "createdAt",
    ])
    .index("by_requesting_device_nonterminal_capacity_ack_and_created_at", [
      "requestingDeviceId",
      "nonterminal",
      "lifecycleCapacityVersion",
      "requesterAcknowledgedAt",
      "createdAt",
    ])
    .index("by_requesting_device_and_acknowledgement", [
      "requestingDeviceId",
      "requesterAcknowledgedAt",
      "createdAt",
    ])
    .index("by_requesting_device_acknowledgement_and_cleanup", [
      "requestingDeviceId",
      "requesterAcknowledgedAt",
      "terminalCleanupAfter",
      "createdAt",
    ])
    .index("by_requesting_device_ack_cleanup_capacity_and_created_at", [
      "requestingDeviceId",
      "requesterAcknowledgedAt",
      "terminalCleanupAfter",
      "lifecycleCapacityVersion",
      "receiptCapacityReservation",
      "createdAt",
    ])
    .index("by_requesting_device_nonterminal_acknowledgement_and_cleanup", [
      "requestingDeviceId",
      "nonterminal",
      "requesterAcknowledgedAt",
      "terminalCleanupAfter",
      "receiptCapacityReservation",
      "createdAt",
    ])
    .index("by_state_and_deadline", ["state", "deadline"])
    .index("by_state_capacity_and_deadline", [
      "state",
      "lifecycleCapacityVersion",
      "deadline",
    ])
    .index("by_state_and_updated_at", ["state", "updatedAt"])
    .index("by_acknowledged_no_effect_cleanup", [
      "state",
      "lifecycleCapacityVersion",
      "nonterminal",
      "terminalCleanupAfter",
      "receiptCapacityReservation",
      "requesterReceiptAbandonedAt",
      "operatorAbandonedAt",
      "resultCode",
      "resultDigest",
      "requesterAcknowledgedAt",
    ])
    .index("by_state_and_cleanup_after", ["state", "terminalCleanupAfter"])
    .index("by_state_unreserved_receipt_and_updated_at", [
      "state",
      "receiptCapacityReservation",
      "requesterAcknowledgedAt",
      "requesterReceiptAbandonedAt",
      "updatedAt",
    ])
    .index("by_single_use_result_expiry", [
      "resultSingleUse",
      "resultConsumedAt",
      "resultExpiresAt",
    ])
    .index("by_idempotency", [
      "userId",
      "targetDeviceId",
      "requestingDeviceId",
      "kind",
      "idempotencyKey",
    ])
    .index("by_user", ["userId"]),
  // Server-only physical capacity rows. Every admitted nonterminal command
  // owns one command-category reservation and one terminal security-event
  // reservation. Lifecycle mutations shrink or consume them before growing
  // the command or inserting its terminal event.
  commandLifecycleReservations: defineTable({
    capacityReservation: v.string(),
    commandPublicId: v.string(),
    commandType,
    createdAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_command", ["commandType", "commandPublicId"])
    .index("by_user", ["userId"]),
  commandTerminalSecurityReservations: defineTable({
    actorDeviceId: v.id("devices"),
    commandType,
    createdAt: v.number(),
    entityId: v.string(),
    event: v.literal("command_terminal"),
    userId: v.id("users"),
  })
    .index("by_command", ["commandType", "entityId"])
    .index("by_user", ["userId"]),
  attentionNotificationOutbox: defineTable({
    allowedWindowEnd: v.number(),
    claimCapacityReservation: v.optional(v.union(
      v.literal("0".repeat(16 * 1_024)),
      v.literal("0".repeat(4 * 1_024)),
      v.literal("0".repeat(3 * 1_024)),
    )),
    claimDeadline: v.number(),
    coalesceAfter: v.number(),
    consentLeaseUntil: v.number(),
    createdAt: v.number(),
    delivery: v.optional(v.object({
      attemptCount: v.number(),
      body: v.optional(v.object({
        text: v.string(),
        version: v.union(v.literal(1), v.literal(2), v.literal(3)),
      })),
      bodyDigest: v.string(),
      claimedAt: v.number(),
      deadline: v.number(),
      effectStartedAt: v.number(),
      firstAttemptAt: v.number(),
      generation: v.number(),
      id: v.string(),
      idempotencyKey: v.string(),
      lastAttemptAt: v.number(),
      leaderRowId: v.id("attentionNotificationOutbox"),
      nextAttemptAt: v.optional(v.number()),
      outcomeCode: v.optional(attentionNotificationOutcomeCode),
      outcomeDigest: v.optional(v.string()),
      recipientDigest: v.string(),
      settledAt: v.optional(v.number()),
    })),
    executionAuthority: v.object({
      bootGeneration: v.number(),
      bootId: v.string(),
      fence: v.number(),
    }),
    faultCapacityAnchor: v.optional(v.id("attentionNotificationOutbox")),
    globalNotificationGeneration: v.number(),
    interactionId: v.string(),
    interactionKind: attentionNotificationInteractionKind,
    interactionRevision: v.number(),
    interactionDeadline: v.number(),
    localNotificationPolicyRevision: v.number(),
    nonterminal: v.boolean(),
    reconciliationSequence: v.number(),
    remoteActions: v.array(attentionNotificationRemoteAction),
    retrySuppressedAt: v.optional(v.number()),
    retrySuppressionReason: v.optional(attentionNotificationSuppressionReason),
    revocationObservedAt: v.optional(v.number()),
    sessionId: v.id("sessionHeads"),
    sessionPublicId: v.string(),
    sourceDeviceId: v.id("devices"),
    state: attentionNotificationState,
    terminalCleanupAfter: v.optional(v.number()),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_user_source_session_and_interaction", [
      "userId",
      "sourceDeviceId",
      "sessionId",
      "interactionId",
    ])
    .index("by_user_and_interaction", ["userId", "interactionId"])
    .index("by_source_device_and_reconciliation", [
      "sourceDeviceId",
      "reconciliationSequence",
    ])
    .index("by_source_device_nonterminal_and_revocation", [
      "sourceDeviceId",
      "nonterminal",
      "revocationObservedAt",
    ])
    .index("by_state_and_coalesce_after", ["state", "coalesceAfter"])
    .index("by_state_and_claim_deadline", ["state", "claimDeadline"])
    .index("by_state_and_next_attempt_at", ["state", "delivery.nextAttemptAt"])
    .index("by_state_and_delivery_deadline", ["state", "delivery.deadline"])
    .index("by_state_and_cleanup_after", ["state", "terminalCleanupAfter"])
    .index("by_delivery_id", ["delivery.id"])
    .index("by_delivery_leader_row_id", ["delivery.leaderRowId"])
    .index("by_fault_capacity_anchor", ["faultCapacityAnchor"])
    .index("by_user_state_and_coalesce_after", [
      "userId",
      "state",
      "coalesceAfter",
    ])
    .index("by_user_and_claimed_at", ["userId", "delivery.claimedAt"])
    .index("by_source_device_and_claimed_at", [
      "sourceDeviceId",
      "delivery.claimedAt",
    ])
    .index("by_user", ["userId"]),
  attentionNotificationSafetyFaults: defineTable({
    anchorRowId: v.id("attentionNotificationOutbox"),
    capacityReservation: v.optional(v.union(
      v.literal("0".repeat(4 * 1_024)),
      v.literal("0".repeat(3 * 1_024)),
      v.literal("0".repeat(2 * 1_024)),
    )),
    cleanupRowId: v.optional(v.id("attentionNotificationOutbox")),
    createdAt: v.number(),
    deliveryId: v.string(),
    deliveryGeneration: v.optional(v.number()),
    faultId: v.optional(v.string()),
    observedAt: v.optional(v.number()),
    quarantineCompletedAt: v.optional(v.number()),
    quarantineState: v.optional(v.union(
      v.literal("not_required"),
      v.literal("pending"),
      v.literal("complete"),
    )),
    reason: v.optional(v.union(
      v.literal("invalid_idempotent_request"),
      v.literal("stored_delivery_corrupt"),
    )),
    resultDigest: v.optional(v.string()),
    reviewedAt: v.optional(v.number()),
    reviewMutationId: v.optional(v.string()),
    slot: v.number(),
    state: v.union(
      v.literal("reserved"),
      v.literal("latched"),
      v.literal("reviewed"),
    ),
    terminalCleanupAfter: v.optional(v.number()),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_identity", [
      "userId",
      "anchorRowId",
      "deliveryGeneration",
      "reason",
      "resultDigest",
    ])
    .index("by_fault_id", ["faultId"])
    .index("by_cleanup_row", ["cleanupRowId"])
    .index("by_state_and_observed_at", ["state", "observedAt"])
    .index("by_state_and_cleanup_after", ["state", "terminalCleanupAfter"])
    .index("by_delivery_and_state", ["deliveryId", "state", "slot"])
    .index("by_anchor_and_slot", ["anchorRowId", "slot"])
    .index("by_reason_quarantine_state_and_observed_at", [
      "reason",
      "quarantineState",
      "observedAt",
    ])
    .index("by_user", ["userId"]),
  codexAccounts: defineTable({
    createdAt: v.number(),
    encryptedMetadata: encryptedEnvelope,
    matchKey: v.string(),
    publicId: v.string(),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_user_and_match_key", ["userId", "matchKey"])
    .index("by_user_and_public_id", ["userId", "publicId"]),
  deviceAccountBindings: defineTable({
    accountId: v.id("codexAccounts"),
    deviceId: v.id("devices"),
    encryptedLocalReference: encryptedEnvelope,
    lastSeenAt: v.number(),
    sourceGeneration: v.number(),
    state: accountBindingState,
    updatedAt: v.number(),
    usageAdmission: v.optional(usageAdmissionAuthority),
    userId: v.id("users"),
  })
    .index("by_device_and_account", ["deviceId", "accountId"])
    .index("by_user_and_account", ["userId", "accountId"])
    .index("by_user", ["userId"]),
  accountUsageSnapshots: defineTable({
    accountId: v.id("codexAccounts"),
    createdAt: v.number(),
    digest: v.string(),
    envelope: usageEncryptedEnvelope,
    observedAt: v.number(),
    receivedAt: v.number(),
    sourceDeviceId: v.id("devices"),
    sourceDevicePublicId: v.string(),
    sourceRevision: v.number(),
    userId: v.id("users"),
  })
    .index("by_account_and_observed_at", ["accountId", "observedAt"])
    .index("by_account_and_received_at", ["accountId", "receivedAt"])
    .index("by_observed_at", ["observedAt"])
    .index("by_received_at", ["receivedAt"])
    .index("by_account_and_winner", [
      "accountId",
      "observedAt",
      "sourceDevicePublicId",
      "sourceRevision",
    ])
    .index("by_source_revision", ["accountId", "sourceDeviceId", "sourceRevision"])
    .index("by_user", ["userId"]),
  idempotencyReceipts: defineTable({
    createdAt: v.number(),
    deviceId: v.optional(v.id("devices")),
    expiresAt: v.number(),
    idempotencyKey: v.string(),
    operation: v.string(),
    requestDigest: v.string(),
    responseJson: v.string(),
    scopeId: v.string(),
    userId: v.id("users"),
  })
    .index("by_scope_and_key", [
      "userId",
      "deviceId",
      "operation",
      "scopeId",
      "idempotencyKey",
    ])
    .index("by_expiry", ["expiresAt"])
    .index("by_user", ["userId"]),
  securityEvents: defineTable({
    actorDeviceId: v.optional(v.id("devices")),
    createdAt: v.number(),
    entityId: v.string(),
    event: v.union(
      v.literal("device_registered"),
      v.literal("device_activated"),
      v.literal("device_bound"),
      v.literal("device_revoked"),
      v.literal("lease_acquired"),
      v.literal("command_enqueued"),
      v.literal("command_terminal"),
      v.literal("account_key_rotated"),
      v.literal("attention_notification_safety_fault"),
    ),
    userId: v.id("users"),
  })
    .index("by_created_at", ["createdAt"])
    .index("by_user_entity_and_event", ["userId", "entityId", "event"])
    .index("by_user_and_created_at", ["userId", "createdAt"]),
  accountDeletionJobs: defineTable({
    capacityReservation: v.optional(v.string()),
    category: accountDeletionCategory,
    createdAt: v.number(),
    publicId: v.string(),
    state: accountDeletionState,
    statusCapabilityDigest: v.string(),
    subjectId: v.id("authSubjects"),
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_public_id", ["publicId"])
    .index("by_state_and_updated_at", ["state", "updatedAt"])
    .index("by_user", ["userId"]),
  accountDeletionReceipts: defineTable({
    completedAt: v.number(),
    expiresAt: v.number(),
    publicId: v.string(),
    statusCapabilityDigest: v.string(),
  })
    .index("by_expiry", ["expiresAt"])
    .index("by_public_id", ["publicId"]),
  deviceRevocationJobs: defineTable({
    capacityReservation: v.optional(v.string()),
    category: deviceRevocationCategory,
    createdAt: v.number(),
    deviceId: v.id("devices"),
    publicId: v.string(),
    state: deviceRevocationState,
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_device", ["deviceId"])
    .index("by_public_id", ["publicId"])
    .index("by_state_and_updated_at", ["state", "updatedAt"])
    .index("by_user", ["userId"]),
  storageUsageByUser: defineTable({
    category: quotaCategory,
    logicalBytes: v.number(),
    // Only the identity category may carry this uncharged authority marker.
    // Keep stored numbers readable so runtime validation refuses future or
    // damaged authority instead of treating it as an unmarked predecessor.
    quotaSchemaVersion: v.optional(v.number()),
    records: v.number(),
    updatedAt: v.number(),
    userId: v.id("users"),
  }).index("by_user_and_category", ["userId", "category"]),
  storageUsageService: defineTable({
    enforcement: quotaEnforcement,
    identities: v.number(),
    key: v.literal("global"),
    logicalBytes: v.number(),
    records: v.number(),
    serviceLogicalBytes: v.number(),
    serviceRecords: v.number(),
    updatedAt: v.number(),
    userLogicalBytes: v.number(),
    userRecords: v.number(),
  }).index("by_key", ["key"]),
  serviceControl: defineTable({
    attentionNotificationGeneration: v.optional(v.number()),
    attentionNotificationLastMutationId: v.optional(v.string()),
    attentionNotifications: v.optional(attentionNotificationServiceState),
    authAdmissionGeneration: v.number(),
    authAdmissions: authAdmissionState,
    bootstrapAcceptedAt: v.optional(v.number()),
    bootstrapCompletedAt: v.optional(v.number()),
    bootstrapInviteCapabilityDigest: v.optional(v.string()),
    bootstrapInviteLifetimeMs: v.optional(v.number()),
    bootstrapInvitePublicId: v.optional(v.string()),
    commandCapacityReadiness: v.optional(commandCapacityReadinessState),
    key: v.literal("global"),
    lastMutationId: v.optional(v.string()),
    // Absent means invite_only. The rolling window counts identities admitted
    // in the last 24 hours through either the invite or the open path.
    newIdentityAdmissions: v.optional(newIdentityAdmissionState),
    newIdentityWindowCount: v.optional(v.number()),
    newIdentityWindowStartedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  storageResourceUsageByUser: defineTable({
    records: v.number(),
    resource: quotaUserResource,
    updatedAt: v.number(),
    userId: v.id("users"),
  }).index("by_user_and_resource", ["userId", "resource"]),
  storageResourceUsageByAccount: defineTable({
    accountId: v.id("codexAccounts"),
    records: v.number(),
    resource: quotaAccountResource,
    updatedAt: v.number(),
    userId: v.id("users"),
  })
    .index("by_account_and_resource", ["accountId", "resource"])
    .index("by_user", ["userId"]),
  maintenanceState: defineTable({
    deviceNoEffectCleanupCursor: v.optional(v.string()),
    key: v.literal("retention"),
    nextCategory: maintenanceCategory,
    orphanedAuthUserCursor: v.optional(v.string()),
    sessionNoEffectCleanupCursor: v.optional(v.string()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
});
