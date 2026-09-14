import { isAbsolute, normalize } from "node:path";

import { z } from "zod";

import {
  attachmentReferenceListSchema,
  legacyAttachmentReferenceListSchema,
} from "./attachment-schemas";
import { isAttachmentName } from "./attachments";
import { autorespondAfterHoursPolicySchema } from "./autorespond-after-hours";
import {
  oompaMemoryExplainInputSchema,
  oompaMemoryQueryInputSchema,
  oompaMemoryRememberInputSchema,
  oompaMemoryShareInputSchema,
} from "./host-tools";
import {
  activePresetBinding,
  adoptableProviderSchema,
  isReboundCodexPreset,
  presetContractSchema,
  presetSchema,
  providerSwitchRequiresPresetContract,
  providerSchema,
  sharedActiveCodexPresetContract,
  supportedPresetSchema,
  supportedProviderSchema,
  type PresetContract,
} from "./presets";
import { interactionResolutionSchema } from "./interactions";
import { notificationEmailPolicySchema } from "./notification-email";
import {
  isWithinNotificationHours,
  notificationHoursPolicySchema,
  notificationHoursUpdateSchema,
} from "./notification-hours";
import {
  SESSION_EVENT_PAGE_LIMIT,
  SESSION_EVENT_WAIT_MAX_MS,
  sessionEventCursorWireSchema,
} from "./session-events";
import { TRANSCRIPT_PAGE_LIMIT } from "./transcript";
import { ACCOUNT_USAGE_HISTORY_PAGE_LIMIT } from "./usage-metrics";
import { usageProviderSchema } from "./provider-usage";
import { automaticUsagePolicyConfigurationUpdateSchema } from "./usage-policy";
import {
  sessionTaskIntervalMinutesSchema,
  sessionTaskNameSchema,
  sessionTaskPromptSchema,
  sessionTaskStatusSchema,
} from "./session-tasks";
import {
  WORK_APPLY_REQUEST_VERSION,
  WORK_EVENT_PAGE_LIMIT,
  WORK_TASK_HISTORY_ITEM_LIMIT,
  WORK_WAIT_MAX_MS,
  workEventCursorWireSchema,
  workIdSchema,
  workOperationSchema,
  workOperationRequiresPresetContract,
  workTaskIdSchema,
} from "./work";
import { workProtocolQuerySchema } from "./work-protocol";
import {
  attemptIdSchema,
  gatewayKeySchema,
  labelSchema,
  messageSchema,
  noteSchema,
  profileIdSchema,
  projectIdSchema,
  sessionIdSchema,
  sessionTaskIdSchema,
  titleSchema,
  unixMillisecondsSchema,
  utf8Bytes,
  positiveRevisionSchema,
} from "./values";

export const selectorSchema = z.string().trim().min(1).max(200).refine(
  (value) => !/\p{Cc}/u.test(value),
  "Selector contains control characters.",
);
const idempotencyKeySchema = z.string().uuid().optional();
const requiredIdempotencyKeySchema = z.string().uuid();
const requiredUuidV7IdempotencyKeySchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  "Idempotency key must be a UUIDv7.",
);
const deviceKeyFingerprintSchema = z.string().regex(
  /^[0-9a-f]{4}(?:-[0-9a-f]{4}){7}$/u,
  "Device fingerprint must be eight lower-case hex groups of four separated by hyphens.",
);
const projectPathSchema = z.string().min(1).max(4096).refine(
  (value) => isAbsolute(value) && normalize(value) === value,
  "Project path must be absolute and normalized.",
);
export const LOCAL_DAEMON_PROTOCOL = "hra-control-plane-local-v2" as const;
export const LOCAL_COMMAND_REQUEST_VERSION = 2 as const;
export const LOCAL_COMMAND_REQUEST_MAX_BYTES = 4 * 1024 * 1024;
export const LOCAL_COMMAND_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;

const daemonStopAuthoritySchema = z.object({
  protocol: z.literal(LOCAL_DAEMON_PROTOCOL),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  generation: z.number().int().positive(),
  bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u),
}).strict();

export const signedOutSessionListMetadataSchema = z.object({
  accountSelector: profileIdSchema,
  accountState: z.literal("signed_out"),
  provider: z.literal("codex"),
  scope: z.literal("local_only"),
  freshness: z.literal("stale"),
  localCompleteness: z.enum(["partial", "complete"]),
  providerAccess: z.literal("not_attempted"),
  providerCompleteness: z.literal("unknown"),
  nextCommand: z.string().min(1).max(256),
}).strict().superRefine((value, context) => {
  if (value.nextCommand !== `oompa account login ${value.accountSelector}`) {
    context.addIssue({
      code: "custom",
      path: ["nextCommand"],
      message: "Signed-out session-list recovery must bind the exact account selector.",
    });
  }
});

export type SignedOutSessionListMetadata = z.infer<typeof signedOutSessionListMetadataSchema>;

export const publicSessionListItemSchema = z.object({
  id: sessionIdSchema,
  profileId: profileIdSchema,
  projectId: projectIdSchema.optional(),
  title: titleSchema,
  state: z.enum(["starting", "active", "idle", "terminal", "recovery_required"]),
  provider: providerSchema,
  preset: presetSchema,
  fastEnabled: z.boolean(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  createdAt: unixMillisecondsSchema,
  updatedAt: unixMillisecondsSchema,
});

export const publicSessionListPageSchema = z.object({
  accountId: profileIdSchema.nullable(),
  sessions: z.array(publicSessionListItemSchema).max(100),
  nextCursor: z.string().min(1).max(2_048).nullable(),
  listing: signedOutSessionListMetadataSchema.optional(),
  recovery: z.object({
    required: z.literal(true),
    diagnostic: z.literal(
      "Provider reconciliation is paused while compact-projection recovery preserves exact local authority.",
    ),
  }).strict().optional(),
}).superRefine((value, context) => {
  if (value.accountId === null) {
    if (value.nextCursor !== null) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "An unscoped session listing cannot continue.",
      });
    }
    if (value.listing !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["listing"],
        message: "Signed-out listing metadata requires an exact account.",
      });
    }
  } else {
    for (const [index, session] of value.sessions.entries()) {
      if (session.profileId !== value.accountId) {
        context.addIssue({
          code: "custom",
          path: ["sessions", index, "profileId"],
          message: "Every scoped session must belong to the resolved account.",
        });
      }
    }
    if (
      value.listing !== undefined
      && value.listing.accountSelector !== value.accountId
    ) {
      context.addIssue({
        code: "custom",
        path: ["listing", "accountSelector"],
        message: "Signed-out listing metadata must bind the resolved account.",
      });
    }
  }
});

export type PublicSessionListPage = z.infer<typeof publicSessionListPageSchema>;

export const notificationHoursCommandResultSchema = z.object({
  policy: notificationHoursPolicySchema,
  observedAt: unixMillisecondsSchema,
  withinHours: z.boolean(),
}).strict().superRefine((value, context) => {
  let withinHours: boolean;
  try {
    withinHours = isWithinNotificationHours(value.policy, value.observedAt);
  } catch {
    context.addIssue({
      code: "custom",
      path: ["observedAt"],
      message: "Notification-hours observation instant is outside the supported date range.",
    });
    return;
  }
  if (withinHours === value.withinHours) return;
  context.addIssue({
    code: "custom",
    path: ["withinHours"],
    message: "Notification-hours status must match its policy and observation instant.",
  });
});

export type NotificationHoursCommandResult = z.infer<
  typeof notificationHoursCommandResultSchema
>;

const hostedNotificationDeviceAuthoritySchema = z.object({
  consentLeaseUntil: unixMillisecondsSchema,
  globalNotificationGeneration: z.number().int().nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  localNotificationPolicyRevision: positiveRevisionSchema,
}).strict();

const observedNotificationHostedAuthoritySchema = z.object({
  deviceAuthority: hostedNotificationDeviceAuthoritySchema.nullable(),
  globalNotificationGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  globalState: z.enum(["disabled", "enabled", "safety_latched"]),
  observedAt: unixMillisecondsSchema,
  state: z.literal("observed"),
}).strict().superRefine((value, context) => {
  if (value.globalState === "enabled" && value.globalNotificationGeneration < 1) {
    context.addIssue({
      code: "custom",
      message: "Enabled hosted notification authority requires a positive global generation.",
      path: ["globalNotificationGeneration"],
    });
  }
  if (
    value.deviceAuthority !== null
    && value.deviceAuthority.consentLeaseUntil - value.observedAt > 2 * 60 * 1_000
  ) {
    context.addIssue({
      code: "custom",
      message: "Hosted device consent cannot exceed the two-minute server lease.",
      path: ["deviceAuthority", "consentLeaseUntil"],
    });
  }
});

const acknowledgedNotificationHostedAuthoritySchema = z.object({
  acknowledgedAt: unixMillisecondsSchema,
  consentLeaseUntil: unixMillisecondsSchema,
  state: z.literal("acknowledged"),
}).strict().superRefine((value, context) => {
  if (value.consentLeaseUntil === value.acknowledgedAt) return;
  context.addIssue({
    code: "custom",
    message: "Acknowledged invalidation must close hosted consent at its acknowledgement instant.",
    path: ["consentLeaseUntil"],
  });
});

export const notificationEmailHostedAuthoritySchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_observed") }).strict(),
  z.object({
    expiresNoLaterThan: unixMillisecondsSchema,
    state: z.literal("revocation_pending"),
  }).strict(),
  observedNotificationHostedAuthoritySchema,
  acknowledgedNotificationHostedAuthoritySchema,
]);

export type NotificationEmailHostedAuthority = z.infer<
  typeof notificationEmailHostedAuthoritySchema
>;

export const notificationEmailCommandResultSchema = z.object({
  policy: notificationEmailPolicySchema,
  hostedAuthority: notificationEmailHostedAuthoritySchema,
}).strict();

export type NotificationEmailCommandResult = z.infer<
  typeof notificationEmailCommandResultSchema
>;

export const autorespondAfterHoursCommandResultSchema = z.object({
  policy: autorespondAfterHoursPolicySchema,
}).strict();

export type AutorespondAfterHoursCommandResult = z.infer<
  typeof autorespondAfterHoursCommandResultSchema
>;

const notificationHoursSetCommandSchema = z.object({
  kind: z.literal("notification-hours.set"),
  expectedRevision: positiveRevisionSchema,
  version: z.literal(1),
  startMinute: z.number().int().min(0).max(1_439),
  endMinute: z.number().int().min(0).max(1_439),
  timeZone: z.string().min(1).max(255),
}).strict().superRefine((value, context) => {
  const update = notificationHoursUpdateSchema.safeParse({
    version: value.version,
    startMinute: value.startMinute,
    endMinute: value.endMinute,
    timeZone: value.timeZone,
  });
  if (update.success) return;
  for (const issue of update.error.issues) {
    context.addIssue({
      code: "custom",
      path: issue.path,
      message: issue.message,
    });
  }
});

export const peerSessionPolicyModeSchema = z.enum(["off", "inspect", "coordinate"]);

export const publicPeerSessionPolicySchema = z.object({
  version: z.literal(1),
  sessionId: sessionIdSchema,
  mode: peerSessionPolicyModeSchema,
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  updatedAt: unixMillisecondsSchema,
}).strict();

export type PublicPeerSessionPolicy = z.infer<typeof publicPeerSessionPolicySchema>;

export const localCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doctor"), offline: z.boolean() }).strict(),
  z.object({ kind: z.literal("daemon.status") }).strict(),
  // The parser emits an unbound stop request. The CLI must bind it to the
  // observed daemon authority before it crosses the local transport boundary.
  z.object({ kind: z.literal("daemon.stop"), expected: daemonStopAuthoritySchema.optional() }).strict(),
  z.object({ kind: z.literal("account.list"), provider: usageProviderSchema.optional() }).strict(),
  z.object({ kind: z.literal("account.add"), label: labelSchema }).strict(),
  z.object({ kind: z.literal("account.show"), account: selectorSchema, provider: providerSchema.optional() }).strict(),
  z.object({ kind: z.literal("account.login"), account: selectorSchema, deviceCode: z.boolean(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({
    kind: z.literal("account.claude-login.prepare"),
    account: selectorSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
  }).strict(),
  z.object({
    kind: z.literal("account.claude-login.complete"),
    account: selectorSchema,
    attemptId: attemptIdSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
    providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    outcome: z.union([
      z.object({
        state: z.literal("joined"),
        exitCode: z.number().int().nonnegative().max(255),
        interruptedBy: z.enum(["SIGINT", "SIGTERM"]).nullable(),
      }).strict(),
      z.object({ state: z.literal("not_started"), reason: z.literal("spawn_failed") }).strict(),
      z.object({ state: z.literal("not_started"), reason: z.literal("preflight_stale") }).strict(),
      z.object({
        state: z.literal("not_started"),
        reason: z.literal("interrupted_before_spawn"),
        interruptedBy: z.enum(["SIGINT", "SIGTERM"]),
      }).strict(),
    ]),
  }).strict(),
  z.object({
    kind: z.literal("account.claude-login.abandon"),
    account: selectorSchema,
    attemptId: attemptIdSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
    providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    acknowledgeChildExited: z.literal(true),
  }).strict(),
  // Cleanup-only authority for a historical foreground grant. No launch or
  // authentication completion is admitted for the retired provider.
  z.object({
    kind: z.literal("account.devin-login.abandon"),
    account: selectorSchema,
    attemptId: attemptIdSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
    providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    acknowledgeChildExited: z.literal(true),
  }).strict(),
  z.object({ kind: z.literal("account.login-cancel"), account: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.logout"), account: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("account.usage"), account: selectorSchema.optional(), refresh: z.boolean() }).strict(),
  z.object({ kind: z.literal("usage.auto.status"), provider: usageProviderSchema.optional() }).strict(),
  z.object({
    kind: z.literal("usage.auto.set"),
    ...automaticUsagePolicyConfigurationUpdateSchema.shape,
  }).strict(),
  z.object({
    kind: z.literal("account.usage-history"),
    account: selectorSchema,
    fromObservedAt: unixMillisecondsSchema.optional(),
    throughObservedAt: unixMillisecondsSchema.optional(),
    limit: z.number().int().min(1).max(ACCOUNT_USAGE_HISTORY_PAGE_LIMIT),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({
    kind: z.literal("plugin.list"),
    account: selectorSchema,
    project: selectorSchema.optional(),
    refresh: z.boolean(),
  }).strict(),
  z.object({
    kind: z.literal("plugin.show"),
    account: selectorSchema,
    plugin: selectorSchema,
    project: selectorSchema.optional(),
    refresh: z.boolean(),
  }).strict(),
  z.object({ kind: z.literal("project.list") }).strict(),
  z.object({ kind: z.literal("project.add"), label: labelSchema, path: projectPathSchema }).strict(),
  z.object({ kind: z.literal("project.use"), project: selectorSchema }).strict(),
  z.object({ kind: z.literal("memory.status"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("memory.hosted.list") }).strict(),
  z.object({
    kind: z.literal("memory.hosted.create"),
    project: selectorSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
  }).strict(),
  z.object({
    kind: z.literal("memory.hosted.attach"),
    project: selectorSchema,
    hostedSpaceId: z.string().regex(/^memory_[A-Za-z0-9_-]{32}$/u),
  }).strict(),
  z.object({
    kind: z.literal("memory.hosted.detach"),
    project: selectorSchema,
    expectedGeneration: positiveRevisionSchema,
  }).strict(),
  z.object({
    kind: z.literal("memory.hosted.sync"),
    project: selectorSchema,
  }).strict(),
  z.object({
    kind: z.literal("memory.query"),
    session: selectorSchema,
    value: oompaMemoryQueryInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("memory.explain"),
    session: selectorSchema,
    value: oompaMemoryExplainInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("memory.remember"),
    session: selectorSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
    value: oompaMemoryRememberInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("memory.share"),
    session: selectorSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
    value: oompaMemoryShareInputSchema,
  }).strict(),
  z.object({
    kind: z.literal("session.list"),
    account: selectorSchema.optional(),
    /** Include archived sessions; the default listing hides them. */
    archived: z.boolean(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ kind: z.literal("session.show"), session: selectorSchema, detail: z.boolean() }).strict(),
  z.object({ kind: z.literal("session.status"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.state"), session: selectorSchema }).strict(),
  z.object({
    kind: z.literal("session.peer-policy.get"),
    session: selectorSchema,
  }).strict(),
  z.object({
    kind: z.literal("session.peer-policy.set"),
    session: selectorSchema,
    mode: peerSessionPolicyModeSchema,
    expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({
    kind: z.literal("session.events"),
    session: selectorSchema,
    cursor: sessionEventCursorWireSchema.optional(),
    limit: z.number().int().min(1).max(SESSION_EVENT_PAGE_LIMIT),
    waitMs: z.number().int().min(0).max(SESSION_EVENT_WAIT_MAX_MS),
  }).strict(),
  z.object({
    kind: z.literal("session.interactions"),
    session: selectorSchema,
    pending: z.boolean(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({
    kind: z.literal("session.start"),
    account: selectorSchema,
    project: selectorSchema.optional(),
    provider: supportedProviderSchema.optional(),
    preset: supportedPresetSchema,
    fast: z.boolean(),
    idempotencyKey: idempotencyKeySchema,
    presetContract: presetContractSchema.optional(),
  }).strict(),
  // `attachments` is optional and absent by default, so a message with no
  // attachment serializes exactly as it did before attachments existed. The
  // references name digests in local custody; no path ever crosses this
  // boundary.
  z.object({ kind: z.literal("session.send"), session: selectorSchema, message: messageSchema, attachments: legacyAttachmentReferenceListSchema.optional(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.queue"), session: selectorSchema, message: messageSchema, attachments: attachmentReferenceListSchema.optional(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.steer"), session: selectorSchema, message: messageSchema, attachments: legacyAttachmentReferenceListSchema.optional(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.stop"), session: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.rename"), session: selectorSchema, name: titleSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.archive"), session: selectorSchema, archived: z.boolean() }).strict(),
  z.object({
    kind: z.literal("session.adoption.status"),
    provider: adoptableProviderSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("session.adoption.set"),
    provider: adoptableProviderSchema,
    enabled: z.boolean(),
    account: selectorSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("session.adoption.discover"),
    provider: adoptableProviderSchema.optional(),
  }).strict(),
  z.object({ kind: z.literal("session.recover"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.abandon"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.note.get"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.note.edit"), session: selectorSchema }).strict(),
  z.object({ kind: z.literal("session.note.set"), session: selectorSchema, note: noteSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.note.clear"), session: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.preset"), session: selectorSchema, preset: supportedPresetSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  /**
   * Move one live conversation to another provider. `preset` and `account`
   * are optional: an omitted preset keeps the session's tier when the target
   * supports it, and an omitted account keeps the session's account, whose
   * profile directory already isolates both providers' credentials.
   */
  z.object({
    kind: z.literal("session.switch"),
    session: selectorSchema,
    provider: supportedProviderSchema,
    preset: supportedPresetSchema.optional(),
    presetContract: presetContractSchema.optional(),
    account: selectorSchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  }).strict(),
  /**
   * One bounded page of the provider-neutral conversation Oompa rebuilt from its
   * own session events. `after` is an event sequence, not a record index.
   */
  z.object({
    kind: z.literal("session.transcript"),
    session: selectorSchema,
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(TRANSCRIPT_PAGE_LIMIT),
    tail: z.boolean().optional(),
  }).strict(),
  z.object({ kind: z.literal("session.fast"), session: selectorSchema, enabled: z.boolean(), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("session.project"), session: selectorSchema, project: selectorSchema, idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({
    kind: z.literal("session.task.list"),
    session: selectorSchema,
  }).strict(),
  z.object({
    kind: z.literal("session.task.show"),
    session: selectorSchema,
    task: sessionTaskIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("session.task.create"),
    session: selectorSchema,
    name: sessionTaskNameSchema,
    everyMinutes: sessionTaskIntervalMinutesSchema,
    paused: z.boolean(),
    prompt: sessionTaskPromptSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
  }).strict(),
  z.object({
    kind: z.literal("session.task.edit"),
    session: selectorSchema,
    task: sessionTaskIdSchema,
    expectedRevision: positiveRevisionSchema,
    name: sessionTaskNameSchema.optional(),
    everyMinutes: sessionTaskIntervalMinutesSchema.optional(),
    prompt: sessionTaskPromptSchema.optional(),
    status: sessionTaskStatusSchema.optional(),
    idempotencyKey: requiredIdempotencyKeySchema,
  }).strict().superRefine((value, context) => {
    if (
      value.name === undefined
      && value.everyMinutes === undefined
      && value.prompt === undefined
      && value.status === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Session task edit requires at least one changed field.",
      });
    }
  }),
  z.object({
    kind: z.literal("session.task.delete"),
    session: selectorSchema,
    task: sessionTaskIdSchema,
    expectedRevision: positiveRevisionSchema,
    idempotencyKey: requiredIdempotencyKeySchema,
  }).strict(),
  z.object({ kind: z.literal("turn.inspect"), session: selectorSchema, turn: selectorSchema }).strict(),
  z.object({
    kind: z.literal("autorespond.status"),
    session: selectorSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("autorespond.set"),
    session: selectorSchema.optional(),
    mode: z.enum(["auto:all", "auto:workspace", "manual"]).nullable(),
  }).strict(),
  // The gateway key reaches the daemon only through this command, only from a
  // descriptor the caller redirected, and never from argv. Command kinds are
  // the only part of a command that any renderer or log ever reproduces.
  z.object({
    kind: z.literal("autorespond.gateway-set"),
    key: gatewayKeySchema,
  }).strict(),
  z.object({ kind: z.literal("autorespond.gateway-clear") }).strict(),
  // Separate local consent. Hosted and browser command unions do not admit it.
  z.object({ kind: z.literal("autorespond-after-hours.status") }).strict(),
  z.object({
    kind: z.enum(["autorespond-after-hours.enable", "autorespond-after-hours.disable"]),
    expectedRevision: positiveRevisionSchema.max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({ kind: z.literal("notification-hours.status") }).strict(),
  notificationHoursSetCommandSchema,
  z.object({ kind: z.literal("notification-email.status") }).strict(),
  z.object({
    kind: z.enum(["notification-email.enable", "notification-email.disable"]),
    expectedRevision: positiveRevisionSchema,
  }).strict(),
  // The two local device-command switches. They are set here and nowhere else:
  // no hosted command and no browser can reach them, which is what makes the
  // kill switch and the account-linking opt-in meaningful.
  z.object({
    kind: z.literal("remote.policy-set"),
    allowed: z.boolean(),
    switch: z.enum(["device-commands", "account-linking"]),
  }).strict(),
  z.object({ kind: z.literal("remote.policy-status") }).strict(),
  z.object({
    kind: z.literal("interaction.list"),
    session: selectorSchema.optional(),
    pending: z.boolean(),
    limit: z.number().int().min(1).max(100),
    cursor: z.string().min(1).max(2_048).optional(),
  }).strict(),
  z.object({ kind: z.literal("interaction.show"), interaction: z.string().uuid() }).strict(),
  z.object({
    kind: z.literal("interaction.inspect"),
    interaction: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("interaction.resolve"),
    interaction: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    resolution: interactionResolutionSchema,
  }).strict(),
  z.object({
    kind: z.literal("auth.login"),
    email: z.string().email().max(254),
    code: z.string().regex(/^\d{8}$/u).optional(),
    invite: z.string().regex(/^hra_invite_identity_v1_[A-Za-z0-9_-]{43}$/u).optional(),
  }).strict(),
  z.object({ kind: z.literal("auth.status") }).strict(),
  z.object({ kind: z.literal("auth.logout"), idempotencyKey: idempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("auth.delete"), acknowledgeErasure: z.literal(true) }).strict(),
  z.object({ kind: z.literal("device.list") }).strict(),
  z.object({ kind: z.literal("device.pair") }).strict(),
  z.object({
    acknowledgeNoKeyHolders: z.literal(true),
    kind: z.literal("device.key-loss"),
  }).strict(),
  z.object({ kind: z.literal("device.approve"), device: selectorSchema, fingerprint: deviceKeyFingerprintSchema, idempotencyKey: requiredUuidV7IdempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("device.revoke"), device: selectorSchema, idempotencyKey: requiredUuidV7IdempotencyKeySchema }).strict(),
  z.object({ kind: z.literal("sync.status") }).strict(),
  z.object({ kind: z.literal("sync.now") }).strict(),
  z.object({ kind: z.literal("sync.projection-recover"), session: selectorSchema, idempotencyKey: requiredIdempotencyKeySchema, acknowledgeGap: z.literal(true) }).strict(),
  z.object({ kind: z.literal("work.protocol"), query: workProtocolQuerySchema }).strict(),
  z.object({
    kind: z.literal("work.apply"),
    requestId: z.string().uuid(),
    requestVersion: z.literal(WORK_APPLY_REQUEST_VERSION).optional(),
    presetContract: presetContractSchema.optional(),
    operation: workOperationSchema,
  }).strict(),
  z.object({ kind: z.literal("work.snapshot"), work: workIdSchema, actor: sessionIdSchema.optional() }).strict(),
  z.object({
    kind: z.literal("work.task"),
    task: workTaskIdSchema,
    historyLimit: z.number().int().min(1).max(WORK_TASK_HISTORY_ITEM_LIMIT).optional(),
    historyCursor: workEventCursorWireSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal("work.poll"),
    work: workIdSchema,
    actor: sessionIdSchema.optional(),
    cursor: workEventCursorWireSchema.optional(),
    actionCursor: workEventCursorWireSchema.optional(),
    limit: z.number().int().min(1).max(50),
    waitMs: z.number().int().min(0).max(WORK_WAIT_MAX_MS),
  }).strict().superRefine((value, context) => {
    if (value.actionCursor !== undefined && value.waitMs !== 0) {
      context.addIssue({
        code: "custom",
        path: ["waitMs"],
        message: "A continued work action page cannot long-poll; waitMs must be zero.",
      });
    }
  }),
  z.object({
    kind: z.literal("work.events"),
    work: workIdSchema,
    cursor: workEventCursorWireSchema.optional(),
    limit: z.number().int().min(1).max(WORK_EVENT_PAGE_LIMIT),
    waitMs: z.number().int().min(0).max(WORK_WAIT_MAX_MS),
  }).strict(),
]).superRefine((command, context) => {
  if (
    (command.kind === "session.send" || command.kind === "session.steer")
    && command.attachments?.some((attachment) => !isAttachmentName(attachment.name)) === true
    && command.idempotencyKey === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["attachments"],
      message: "A predecessor attachment name is accepted only for an explicit idempotent send or steer replay.",
    });
  }
  if (
    command.kind === "session.start"
    && !isReboundCodexPreset(command.preset)
    && command.presetContract !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["presetContract"],
      message: "Only a Codex High or Ultra session start may carry a source preset contract.",
    });
  }
  if (
    command.kind === "session.switch"
    && !providerSwitchRequiresPresetContract(command.provider, command.preset)
    && command.presetContract !== undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["presetContract"],
      message: "Only a source-sensitive Codex provider switch may carry a source preset contract.",
    });
  }
  if (command.kind !== "work.apply") return;
  if (command.requestVersion === undefined) {
    if (command.presetContract !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["presetContract"],
        message: "A legacy Work apply command must preserve its exact token-free shape.",
      });
    }
    return;
  }
  const requiresPresetContract = workOperationRequiresPresetContract(command.operation);
  if (requiresPresetContract && command.presetContract === undefined) {
    context.addIssue({
      code: "custom",
      path: ["presetContract"],
      message: "A v2 High/Ultra Work apply command requires its authored preset contract.",
    });
  } else if (!requiresPresetContract && command.presetContract !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["presetContract"],
      message: "A stable v2 Work apply command must not carry a preset contract.",
    });
  }
});

export type LocalCommand = z.infer<typeof localCommandSchema>;

/**
 * The contract marker required at the local transport boundary for commands
 * whose meaning can change when the active Codex High/Ultra binding changes.
 * This build-authored envelope marker is independent from the optional
 * caller-authored source marker on session.start, session.switch, or Work
 * apply. That separation lets a current daemon recognize a stale replay
 * without letting it pass the live
 * rollout fence, while strict older daemons reject either additive key.
 */
export const localCommandPresetContract = (command: LocalCommand): PresetContract | undefined => {
  if (command.kind === "session.start" || command.kind === "session.preset") {
    return isReboundCodexPreset(command.preset)
      ? activePresetBinding(command.preset).contract
      : undefined;
  }
  if (command.kind === "session.switch") {
    return providerSwitchRequiresPresetContract(command.provider, command.preset)
      ? sharedActiveCodexPresetContract()
      : undefined;
  }
  if (command.kind !== "work.apply") return undefined;
  // Routes are immutable and later task additions must reuse an exact
  // declared route. Fence a new declaration that admits a rebound Codex tier
  // and a batch that actively adds a task on such a route.
  return workOperationRequiresPresetContract(command.operation)
    ? sharedActiveCodexPresetContract()
    : undefined;
};

export const commandEnvelopeSchema = z
  .object({
    version: z.literal(LOCAL_COMMAND_REQUEST_VERSION),
    capability: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    requestId: z.string().uuid(),
    presetContract: presetContractSchema.optional(),
    command: localCommandSchema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      ((request.command.kind === "session.start"
        && isReboundCodexPreset(request.command.preset))
        || (request.command.kind === "session.switch"
          && providerSwitchRequiresPresetContract(
            request.command.provider,
            request.command.preset,
          )))
      && request.command.presetContract === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["command", "presetContract"],
        message: "Source-sensitive Codex session commands require an authored source preset contract.",
      });
    }
    const expectedPresetContract = localCommandPresetContract(request.command);
    if (expectedPresetContract === undefined && request.presetContract !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["presetContract"],
        message: "This local command must not carry a preset contract marker.",
      });
    } else if (
      expectedPresetContract !== undefined
      && request.presetContract !== expectedPresetContract
    ) {
      context.addIssue({
        code: "custom",
        path: ["presetContract"],
        message: "This local command requires this build's exact active preset contract.",
      });
    }
    if (utf8Bytes(JSON.stringify(request)) > LOCAL_COMMAND_REQUEST_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        message: "The local command envelope exceeds its serialized UTF-8 byte bound.",
      });
    }
  });

// This validates only the transport envelope. Successful data stays unknown
// until the caller validates it against the command that produced it.
export const commandResponseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), version: z.literal(1), requestId: z.string().uuid(), data: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), version: z.literal(1), requestId: z.string().uuid(), error: z.object({ code: z.enum(["INVALID_INPUT", "NOT_FOUND", "AMBIGUOUS", "CONFLICT", "INTERACTION_REQUIRED", "UNAVAILABLE", "RECOVERY_REQUIRED", "INTERNAL"]), message: z.string().min(1).max(1000), details: z.unknown().optional() }).strict() }).strict(),
]);

export type CommandResponse = z.infer<typeof commandResponseSchema>;
