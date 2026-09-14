import { v } from "convex/values";

import { cloudEnvelopeLimits } from "../src/domain/cloud-envelope-contract";

export const authAttemptKind = v.union(v.literal("send"), v.literal("verify"));
export const authSubjectStatus = v.union(v.literal("active"), v.literal("disabled"));
export const authAdmissionState = v.union(v.literal("open"), v.literal("frozen"));
// Break-glass auth admission gates new OTP work, session issue/refresh, invite
// issue, and fresh device registration. Already-issued JWT/device authority is
// intentionally checked at its own boundary until that token expires.
// New-identity admission is the separate, narrower control that decides
// whether a first `authSubjects` row may be created without an invitation. An
// absent stored value always means `invite_only`.
export const newIdentityAdmissionState = v.union(
  v.literal("invite_only"),
  v.literal("open"),
);
// Only open admission is recorded on the subject. An invited subject keeps its
// `admissionInviteId` instead, and an absent marker never means "no invite
// required".
export const authSubjectAdmittedBy = v.literal("open");
export const challengeDeliveryState = v.union(
  v.literal("reserved"),
  v.literal("accepted"),
  v.literal("ambiguous"),
);
export const deviceStatus = v.union(
  v.literal("pending"),
  v.literal("active"),
  v.literal("revoked"),
);
// A device row written before browser enrollment carries no class. An absent
// field therefore means `daemon`, and `deviceClassOf` is the only reader.
export const deviceClass = v.union(v.literal("daemon"), v.literal("browser"));
export const sessionStatus = v.union(
  v.literal("active"),
  v.literal("idle"),
  v.literal("terminal"),
  v.literal("orphaned"),
);
export const syncStream = v.union(v.literal("compact"), v.literal("detail"));
export const commandKind = v.union(
  v.literal("send"),
  v.literal("queue"),
  v.literal("steer"),
  v.literal("stop"),
  v.literal("set_model"),
  v.literal("set_provider"),
  v.literal("set_fast"),
  v.literal("resolve_interaction"),
  v.literal("send_or_steer"),
  v.literal("set_approval_mode"),
  v.literal("set_show_thinking"),
  v.literal("set_default_preset"),
  v.literal("archive_session"),
  v.literal("rename_session"),
  v.literal("set_gateway_key"),
);
// Device commands are addressed to a device, not to a session, so they carry
// their own closed union. Nothing here may ever name a session: a command that
// needs one belongs in `commandKind` above.
export const deviceCommandKind = v.union(
  v.literal("session_start"),
  v.literal("account_login_start"),
  v.literal("account_login_status"),
  v.literal("usage_refresh"),
  v.literal("set_notification_hours"),
);
/*
 * A session command payload is one opaque encrypted envelope, so the hosted
 * side never sees a message, an attachment name, or an attachment byte. What
 * it does enforce is size: `commandPayloadCiphertextCharacters` is the exact
 * bound `commands:enqueue` applies to `payload.ciphertext`, and it is what
 * makes the client-side attachment bounds in `src/cloud/payloads.ts`
 * (`remoteAttachmentLimits`) fit inside one Convex document with room to
 * spare. Raising the client bounds without raising this one produces a
 * rejected command, not a truncated one.
 */
export const commandPayloadCiphertextCharacters = cloudEnvelopeLimits.ciphertextCharacters;

export const commandState = v.union(
  v.literal("pending"),
  v.literal("prepared"),
  v.literal("effect_started"),
  v.literal("applied"),
  v.literal("failed"),
  v.literal("ambiguous"),
  v.literal("cancelled"),
  v.literal("expired"),
);

// These strings are physical hosted capacity, not virtual counters. A fresh
// command reserves enough command-category bytes for its widest legal
// terminal shape, while a terminal command that has not yet been observed by
// its requester keeps a small inline receipt reserve until acknowledgement.
export const commandLifecycleCapacityCharacters = Object.freeze({
  device: 24 * 1_024,
  session: 352 * 1_024,
});
export const commandLifecycleCapacityVersion = 1 as const;
export const commandReceiptCapacityReservation = "0".repeat(256);
export const commandType = v.union(v.literal("session"), v.literal("device"));
export const runtimeReleaseAttestation = v.union(
  v.object({
    bound: v.literal(false),
    schemaIdentity: v.literal("hra-release-attestation-v1"),
    schemaVersion: v.literal(1),
  }),
  v.object({
    bound: v.literal(true),
    deployedAtMs: v.number(),
    previousDeployDigest: v.union(v.string(), v.null()),
    runtimeRevision: v.string(),
    runtimeSourceCommit: v.string(),
    schemaIdentity: v.literal("hra-release-attestation-v1"),
    schemaVersion: v.literal(1),
  }),
);
// This uncharged singleton field is the hosted half of the protected
// command-capacity receipt. Marker-2 work is executable only when the stored
// tuple still names the exact compiled release attestation.
export const commandCapacityReadinessState = v.object({
  activatedAt: v.number(),
  candidateDeployDigest: v.string(),
  evidenceDigest: v.string(),
  lifecycleCapacityVersion: v.literal(commandLifecycleCapacityVersion),
  runtimeAttestation: runtimeReleaseAttestation,
  schemaIdentity: v.literal("hra-command-capacity-readiness-v1"),
  schemaVersion: v.literal(1),
  targetDigest: v.string(),
});
// Eight maximal command/reservation pairs stay comfortably below Convex's
// transaction read/write byte ceilings, including quota and index overhead.
export const maximumCommandLifecycleBatch = 8;
// The memory quota upgrade adds authority metadata only; one transaction
// inspects at most eight complete per-user category/resource ledgers.
export const maximumUserQuotaUpgradeBatch = 8;
export const currentUserQuotaSchemaVersion = 2;
export const userQuotaUpgradePaginationOpts = v.object({
  cursor: v.union(v.string(), v.null()),
  numItems: v.number(),
});
// Account deletion and device revocation accept authority-changing work before
// their durable jobs advance through several differently sized states. Keep a
// physical byte obligation on each new job so every later state change (and,
// for account deletion, the completion receipt) remains possible at a hard
// quota ceiling. The resize helpers permit a little extra room when a shorter
// state re-expands back to the immutable initial charged size.
export const durableJobCapacityReservation = "0".repeat(256);
export const maximumDurableJobCapacityCharacters = 512;
// New identities and devices prepay the exact record slots and ample bytes
// required to disable/delete or revoke them later. These rows are charged to
// the same category as the artifact they replace; the authority-reducing
// mutation only performs a physically non-growing exchange.
export const authorityReductionCapacityVersion = 1 as const;
export const authorityReductionCapacityReservation = "0".repeat(2 * 1_024);
export const attentionNotificationState = v.union(
  v.literal("pending"),
  v.literal("effect_started"),
  v.literal("accepted"),
  v.literal("refused"),
  v.literal("ambiguous"),
  v.literal("cancelled"),
  v.literal("expired"),
);
export const attentionNotificationInteractionKind = v.union(
  v.literal("command_approval"),
  v.literal("file_change_approval"),
  v.literal("permission_approval"),
  v.literal("user_input"),
  v.literal("mcp_elicitation"),
);
export const attentionNotificationRemoteAction = v.union(
  v.literal("decline"),
  v.literal("answer"),
);
export const attentionNotificationOutcomeCode = v.union(
  v.literal("provider_accepted"),
  v.literal("provider_refused"),
  v.literal("retry_exhausted"),
  v.literal("delivery_deadline_elapsed"),
  v.literal("idempotency_mismatch"),
  v.literal("unsettled_effect"),
  v.literal("stored_delivery_corrupt"),
);
// Global notification delivery is disabled when this optional value is absent.
// A disabled deployment retains its separate generation so a later enablement
// can advance it instead of reviving rows from an earlier enabled interval.
export const attentionNotificationServiceState = v.literal("enabled");
export const attentionNotificationSuppressionReason = v.union(
  v.literal("source_reconciled"),
  v.literal("local_policy_changed"),
  v.literal("global_disabled"),
  v.literal("interaction_resolved"),
  v.literal("deadline_expired"),
  v.literal("account_deletion"),
  v.literal("device_revoked"),
  v.literal("consent_expired"),
  v.literal("execution_authority_changed"),
  v.literal("recipient_unavailable"),
  v.literal("service_fault"),
);
export const accountBindingState = v.union(v.literal("present"), v.literal("removed"));
export const usageAdmissionDisposition = v.union(
  v.literal("stored"),
  v.literal("coalesced"),
);
export const accountDeletionState = v.union(
  v.literal("pending"),
  v.literal("draining"),
  v.literal("complete"),
);
export const accountDeletionCategory = v.union(
  v.literal("commands_and_leases"),
  v.literal("chunks_and_epochs"),
  v.literal("memory_history"),
  v.literal("session_heads"),
  v.literal("usage_and_bindings"),
  v.literal("codex_accounts"),
  v.literal("device_custody"),
  v.literal("devices"),
  v.literal("receipts_and_events"),
  v.literal("auth_tokens_and_verifiers"),
  v.literal("auth_sessions"),
  v.literal("auth_challenges"),
  v.literal("auth_accounts"),
  v.literal("user_and_subject"),
  v.literal("complete"),
);
export const deviceRevocationState = v.union(
  v.literal("pending"),
  v.literal("draining"),
  v.literal("complete"),
);
export const deviceRevocationCategory = v.union(
  v.literal("sessions"),
  v.literal("leases"),
  v.literal("commands"),
  v.literal("notifications"),
  v.literal("bindings"),
  v.literal("custody"),
  v.literal("presence"),
  v.literal("complete"),
);
export const invitePurpose = v.union(v.literal("identity"), v.literal("device"));
export const inviteState = v.union(
  v.literal("issued"),
  v.literal("bound_to_email"),
  v.literal("consumed"),
  v.literal("revoked"),
);
export const quotaCategory = v.union(
  v.literal("identity"),
  v.literal("device"),
  v.literal("account"),
  v.literal("session"),
  v.literal("chunk"),
  v.literal("usage"),
  v.literal("command"),
  v.literal("custody"),
  v.literal("receipt"),
  v.literal("security"),
  v.literal("job"),
  v.literal("memory"),
);
export const quotaEnforcement = v.union(v.literal("shadow"), v.literal("hard"));
export const quotaUserResource = v.union(
  v.literal("device"),
  v.literal("codex_account"),
  v.literal("session_head"),
  v.literal("session_chunk"),
  v.literal("nonterminal_command"),
  v.literal("live_chunk"),
  v.literal("memory_space"),
);
export const quotaAccountResource = v.literal("usage_snapshot");
export const maintenanceCategory = v.union(
  v.literal("auth_attempts"),
  v.literal("otp_challenges"),
  v.literal("auth_invites"),
  v.literal("abandoned_identities"),
  v.literal("orphaned_auth_users"),
  v.literal("bind_challenges"),
  v.literal("device_presence"),
  v.literal("idempotency_receipts"),
  v.literal("pending_commands"),
  v.literal("terminal_commands"),
  v.literal("pending_device_commands"),
  v.literal("device_command_login_results"),
  v.literal("terminal_device_commands"),
  v.literal("pending_attention_notifications"),
  v.literal("started_attention_notifications"),
  v.literal("terminal_attention_notifications"),
  v.literal("attention_notification_faults"),
  v.literal("security_events"),
  v.literal("usage_snapshots"),
  v.literal("account_deletion_receipts"),
  v.literal("device_revocation_jobs"),
  v.literal("live_tail_chunks"),
);

export const encryptedEnvelope = v.object({
  algorithm: v.literal("A256GCM"),
  ciphertext: v.string(),
  keyVersion: v.number(),
  nonce: v.string(),
});

// Usage applies its tighter ciphertext-character bound in the mutation parser.
// The named validator keeps that distinct contract visible in the table schema.
export const usageEncryptedEnvelope = encryptedEnvelope;

export const usageAdmissionAuthority = v.object({
  cursor: v.object({
    digest: v.string(),
    disposition: usageAdmissionDisposition,
    observedAt: v.number(),
    sourceRevision: v.number(),
  }),
  lastAcceptedAt: v.number(),
});

export const wrappedKeyEnvelope = v.object({
  algorithm: v.literal("P256-HKDF-SHA256+A256GCM"),
  ciphertext: v.string(),
  ephemeralPublicKey: v.string(),
  keyVersion: v.number(),
  nonce: v.string(),
});

export const authorityTuple = v.object({
  bootGeneration: v.number(),
  bootId: v.string(),
  fence: v.number(),
});
