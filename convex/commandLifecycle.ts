import { makeFunctionReference, paginationOptsValidator } from "convex/server";
import { ConvexError, v } from "convex/values";
import type { GenericId as Id, Value } from "convex/values";

import {
  cloudLimits,
  isDigest,
  isSafePositiveInteger,
  isUuidV7,
  type CommandState,
} from "../src/cloud/contracts";
import {
  AUTHORITY_REDUCTION_QUOTA_CEILINGS,
  authorityReductionReservationDemand,
  emptyAuthorityReductionQuotaCeilings,
  inspectAuthorityReductionQuota,
  adjustCommandLifecycleQuotaForReplacement,
  adjustCommandQuotaForPatch,
  adjustQuotaForPatch,
  adjustTerminalSecurityQuotaForReplacement,
  logicalDocumentBytes,
  releaseQuotaForDelete,
  requireHardQuotaAuthority,
  reserveQuotaForInsert,
} from "./quota";
import {
  backfillAuthorityReductionCapacityForUser,
  classifyAuthorityReductionCapacityForUser,
  inspectAuthorityReductionCapacityForUser,
  type AuthorityReductionCapacityDisposition,
} from "./authorityReductionCapacity";
import { COMMAND_TERMINAL_RETENTION_MS } from "./lifecyclePolicy";
import {
  internalMutation,
  internalQuery,
  internalAction,
  type DataModel,
  type MutationCtx,
  type QueryCtx,
} from "./server";
import { RELEASE_ATTESTATION } from "./releaseAttestation";
import {
  commandLifecycleCapacityCharacters,
  commandLifecycleCapacityVersion,
  commandReceiptCapacityReservation,
  commandType as commandTypeValidator,
  maximumCommandLifecycleBatch,
  runtimeReleaseAttestation,
} from "./validators";

export type CommandType = "session" | "device";
type SessionCommand = DataModel["sessionCommands"]["document"];
type DeviceCommand = DataModel["deviceCommands"]["document"];
type CommandDocument = SessionCommand | DeviceCommand;
type CommandPatch = Readonly<Record<string, Value | undefined>>;
type CapacityCommandDocument = CommandPatch & Readonly<{
  createdAt: number;
  kind: string;
  lifecycleCapacityVersion?: 1;
  nonterminal: boolean;
  operatorAbandonedAt?: number;
  publicId: string;
  requesterAcknowledgedAt?: number;
  targetDeviceId: Id<"devices">;
  userId: Id<"users">;
}>;
type LifecycleReservation = DataModel["commandLifecycleReservations"]["document"];
type SecurityReservation = DataModel["commandTerminalSecurityReservations"]["document"];
type TerminalSecurityDocument = Readonly<{
  actorDeviceId: Id<"devices">;
  createdAt: number;
  entityId: string;
  event: "command_terminal";
  userId: Id<"users">;
}>;
type RuntimeFence = Readonly<{
  bound: false;
  schemaIdentity: "hra-release-attestation-v1";
  schemaVersion: 1;
}> | Readonly<{
  bound: true;
  deployedAtMs: number;
  previousDeployDigest: string | null;
  runtimeRevision: string;
  runtimeSourceCommit: string;
  schemaIdentity: "hra-release-attestation-v1";
  schemaVersion: 1;
}>;

const runtimeFenceValidator = runtimeReleaseAttestation;

const terminalStates: ReadonlySet<CommandState> = new Set([
  "applied",
  "failed",
  "ambiguous",
  "cancelled",
  "expired",
] as const);

const corrupt = (): never => {
  throw new Error("COMMAND_LIFECYCLE_RESERVATION_CORRUPT");
};

const runtimeFenceTuple = (value: unknown): readonly unknown[] => {
  if (typeof value !== "object" || value === null || !("bound" in value)) return corrupt();
  const candidate = value as Readonly<Record<string, unknown>>;
  if (candidate.bound === false) {
    if (
      candidate.schemaIdentity !== "hra-release-attestation-v1"
      || candidate.schemaVersion !== 1
      || Object.keys(candidate).length !== 3
    ) return corrupt();
    return [false, candidate.schemaIdentity, candidate.schemaVersion];
  }
  if (
    candidate.bound !== true
    || !Number.isSafeInteger(candidate.deployedAtMs)
    || (candidate.previousDeployDigest !== null
      && typeof candidate.previousDeployDigest !== "string")
    || typeof candidate.runtimeRevision !== "string"
    || typeof candidate.runtimeSourceCommit !== "string"
    || candidate.schemaIdentity !== "hra-release-attestation-v1"
    || candidate.schemaVersion !== 1
    || Object.keys(candidate).length !== 7
  ) return corrupt();
  return [
    true,
    candidate.deployedAtMs,
    candidate.previousDeployDigest,
    candidate.runtimeRevision,
    candidate.runtimeSourceCommit,
    candidate.schemaIdentity,
    candidate.schemaVersion,
  ];
};

const requireRuntimeFence = (expected: RuntimeFence): void => {
  if (JSON.stringify(runtimeFenceTuple(RELEASE_ATTESTATION)) !== JSON.stringify(
    runtimeFenceTuple(expected),
  )) throw new Error("COMMAND_LIFECYCLE_RUNTIME_CHANGED");
};

type CapacityReadiness = NonNullable<
  DataModel["serviceControl"]["document"]["commandCapacityReadiness"]
>;

type CapacityReadinessActivation = Readonly<{
  candidateDeployDigest: string;
  evidenceDigest: string;
  expectedRuntimeAttestation: RuntimeFence;
  lifecycleCapacityVersion: 1;
  targetDigest: string;
}>;

const readinessTuple = (value: unknown): readonly unknown[] => {
  if (typeof value !== "object" || value === null) return corrupt();
  const candidate = value as Readonly<Record<string, unknown>>;
  if (
    !Number.isSafeInteger(candidate.activatedAt)
    || (candidate.activatedAt as number) < 0
    || !isDigest(candidate.candidateDeployDigest)
    || !isDigest(candidate.evidenceDigest)
    || candidate.lifecycleCapacityVersion !== commandLifecycleCapacityVersion
    || candidate.schemaIdentity !== "hra-command-capacity-readiness-v1"
    || candidate.schemaVersion !== 1
    || !isDigest(candidate.targetDigest)
    || Object.keys(candidate).length !== 8
  ) return corrupt();
  return [
    candidate.activatedAt,
    candidate.candidateDeployDigest,
    candidate.evidenceDigest,
    candidate.lifecycleCapacityVersion,
    ...runtimeFenceTuple(candidate.runtimeAttestation),
    candidate.schemaIdentity,
    candidate.schemaVersion,
    candidate.targetDigest,
  ];
};

const readinessActivationTuple = (
  value: CapacityReadinessActivation,
): readonly unknown[] => [
  value.candidateDeployDigest,
  value.evidenceDigest,
  value.lifecycleCapacityVersion,
  ...runtimeFenceTuple(value.expectedRuntimeAttestation),
  value.targetDigest,
];

const storedReadinessActivationTuple = (
  value: CapacityReadiness,
): readonly unknown[] => [
  value.candidateDeployDigest,
  value.evidenceDigest,
  value.lifecycleCapacityVersion,
  ...runtimeFenceTuple(value.runtimeAttestation),
  value.targetDigest,
];

async function readCapacityControl(ctx: MutationCtx | QueryCtx) {
  const rows = await ctx.db.query("serviceControl")
    .withIndex("by_key", (builder) => builder.eq("key", "global"))
    .take(2);
  const control = rows[0];
  if (rows.length !== 1 || control === undefined) {
    return corrupt();
  }
  return control;
}

/**
 * Runtime gate for marker-2 work. Exact replay and cleanup callers decide
 * whether a transition is new before invoking this helper.
 */
export async function requireCommandCapacityReadiness(
  ctx: MutationCtx | QueryCtx,
  requestCommitmentVersion: 2 | undefined,
): Promise<void> {
  if (requestCommitmentVersion !== 2) return;
  const control = await readCapacityControl(ctx);
  const readiness = control.commandCapacityReadiness;
  if (readiness === undefined) throw new Error("COMMAND_CAPACITY_NOT_READY");
  try {
    readinessTuple(readiness);
    if (
      JSON.stringify(runtimeFenceTuple(readiness.runtimeAttestation))
      !== JSON.stringify(runtimeFenceTuple(RELEASE_ATTESTATION))
    ) throw new Error("COMMAND_CAPACITY_NOT_READY");
  } catch {
    throw new Error("COMMAND_CAPACITY_NOT_READY");
  }
}

/** Testable transaction body; the exported Convex mutation below binds it to
 * this deployment's immutable compiled attestation. */
export async function activateCommandCapacityReadinessForRuntime(
  ctx: MutationCtx,
  args: CapacityReadinessActivation,
  runtimeAttestation: RuntimeFence,
): Promise<Readonly<{ readiness: CapacityReadiness; replay: boolean }>> {
  requireRuntimeFenceAgainst(args.expectedRuntimeAttestation, runtimeAttestation);
  if (
    !isBoundRuntimeFence(args.expectedRuntimeAttestation)
    || !isDigest(args.candidateDeployDigest)
    || !isDigest(args.evidenceDigest)
    || !isDigest(args.targetDigest)
  ) throw new Error("COMMAND_CAPACITY_ACTIVATION_REFUSED");
  await requireHardQuotaAuthority(ctx);
  const control = await readCapacityControl(ctx);
  const existing = control.commandCapacityReadiness;
  if (existing !== undefined) {
    try {
      readinessTuple(existing);
      if (
        JSON.stringify(storedReadinessActivationTuple(existing))
        === JSON.stringify(readinessActivationTuple(args))
      ) return { readiness: existing, replay: true };
      if (
        JSON.stringify(runtimeFenceTuple(existing.runtimeAttestation))
        === JSON.stringify(runtimeFenceTuple(runtimeAttestation))
      ) throw new Error("COMMAND_CAPACITY_ACTIVATION_CONFLICT");
    } catch (error: unknown) {
      if (
        error instanceof Error
        && error.message === "COMMAND_CAPACITY_ACTIVATION_CONFLICT"
      ) throw error;
      return corrupt();
    }
  }
  const activatedAt = Math.max(Date.now(), control.updatedAt);
  const readiness = {
    activatedAt,
    candidateDeployDigest: args.candidateDeployDigest,
    evidenceDigest: args.evidenceDigest,
    lifecycleCapacityVersion: commandLifecycleCapacityVersion,
    runtimeAttestation,
    schemaIdentity: "hra-command-capacity-readiness-v1" as const,
    schemaVersion: 1 as const,
    targetDigest: args.targetDigest,
  } satisfies CapacityReadiness;
  readinessTuple(readiness);
  await ctx.db.patch(control._id, { commandCapacityReadiness: readiness, updatedAt: activatedAt });
  return { readiness, replay: false };
}

function isBoundRuntimeFence(value: RuntimeFence): boolean {
  return value.bound;
}

function requireRuntimeFenceAgainst(expected: RuntimeFence, actual: RuntimeFence): void {
  if (
    JSON.stringify(runtimeFenceTuple(actual))
    !== JSON.stringify(runtimeFenceTuple(expected))
  ) throw new Error("COMMAND_LIFECYCLE_RUNTIME_CHANGED");
}

const capacityReadinessActivationArgs = {
  candidateDeployDigest: v.string(),
  evidenceDigest: v.string(),
  expectedRuntimeAttestation: runtimeFenceValidator,
  lifecycleCapacityVersion: v.literal(commandLifecycleCapacityVersion),
  targetDigest: v.string(),
} as const;

export const activateCapacityReadiness = internalMutation({
  args: capacityReadinessActivationArgs,
  handler: async (ctx, args) => await activateCommandCapacityReadinessForRuntime(
    ctx,
    args,
    RELEASE_ATTESTATION,
  ),
});

export const readCapacityReadiness = internalQuery({
  args: capacityReadinessActivationArgs,
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    const control = await readCapacityControl(ctx);
    const readiness = control.commandCapacityReadiness;
    if (readiness === undefined) throw new Error("COMMAND_CAPACITY_NOT_READY");
    try {
      readinessTuple(readiness);
      if (
        JSON.stringify(storedReadinessActivationTuple(readiness))
        !== JSON.stringify(readinessActivationTuple(args))
      ) throw new Error("COMMAND_CAPACITY_NOT_READY");
    } catch {
      throw new Error("COMMAND_CAPACITY_NOT_READY");
    }
    return { readiness };
  },
});

function zeroCapacity(characters: number): string {
  if (!Number.isSafeInteger(characters) || characters < 0) return corrupt();
  return "0".repeat(characters);
}

function commandCapacityMaximum(commandType: CommandType): number {
  return commandLifecycleCapacityCharacters[commandType];
}

function validCapacity(value: string, commandType: CommandType): boolean {
  return value.length <= commandCapacityMaximum(commandType)
    && value.length > 0
    && /^0+$/u.test(value);
}

function maximumTerminalCommandGrowth(
  commandType: CommandType,
  command: CapacityCommandDocument,
): number {
  const terminal = {
    ...command,
    boundAuthority: {
      bootGeneration: Number.MAX_SAFE_INTEGER,
      bootId: "b".repeat(cloudLimits.identifierCharacters),
      fence: Number.MAX_SAFE_INTEGER,
    },
    lifecycleCapacityVersion: undefined,
    nonterminal: false,
    operatorAbandonedAt: undefined,
    receiptCapacityReservation: command.requesterAcknowledgedAt === undefined
      ? commandReceiptCapacityReservation
      : undefined,
    requesterReceiptAbandonedAt: undefined,
    result: {
      algorithm: "A256GCM" as const,
      ciphertext: "C".repeat(commandType === "session"
        ? cloudLimits.ciphertextCharacters
        : cloudLimits.metadataCiphertextCharacters),
      keyVersion: Number.MAX_SAFE_INTEGER,
      nonce: "B".repeat(16),
    },
    resultCode: "R".repeat(cloudLimits.resultCodeCharacters),
    resultDigest: "e".repeat(64),
    state: "ambiguous" as const,
    terminalCleanupAfter: command.requesterAcknowledgedAt === undefined
      ? undefined
      : Number.MAX_SAFE_INTEGER,
    updatedAt: Number.MAX_SAFE_INTEGER,
    ...(commandType === "device" && command.kind === "account_login_start"
      ? {
          resultConsumedAt: undefined,
          resultExpiresAt: Number.MAX_SAFE_INTEGER,
          resultSingleUse: true,
        }
      : {}),
  };
  const growth = logicalDocumentBytes(terminal) - logicalDocumentBytes(command);
  if (!Number.isSafeInteger(growth) || growth < 0) return corrupt();
  return growth;
}

async function reservationRows(
  ctx: MutationCtx | QueryCtx,
  commandType: CommandType,
  commandPublicId: string,
): Promise<Readonly<{
  lifecycle: LifecycleReservation | null;
  security: SecurityReservation | null;
}>> {
  const [lifecycleRows, securityRows] = await Promise.all([
    ctx.db.query("commandLifecycleReservations")
      .withIndex("by_command", (builder) => builder
        .eq("commandType", commandType)
        .eq("commandPublicId", commandPublicId))
      .take(2),
    ctx.db.query("commandTerminalSecurityReservations")
      .withIndex("by_command", (builder) => builder
        .eq("commandType", commandType)
        .eq("entityId", commandPublicId))
      .take(2),
  ]);
  if (lifecycleRows.length > 1 || securityRows.length > 1) return corrupt();
  return {
    lifecycle: lifecycleRows[0] ?? null,
    security: securityRows[0] ?? null,
  };
}

function requireReservationPair(
  commandType: CommandType,
  command: CapacityCommandDocument,
  rows: Readonly<{
    lifecycle: LifecycleReservation | null;
    security: SecurityReservation | null;
  }>,
): Readonly<{ lifecycle: LifecycleReservation; security: SecurityReservation }> {
  const { lifecycle, security } = rows;
  if (
    lifecycle === null
    || security === null
    || lifecycle.commandType !== commandType
    || lifecycle.commandPublicId !== command.publicId
    || lifecycle.userId !== command.userId
    || !validCapacity(lifecycle.capacityReservation, commandType)
    || logicalDocumentBytes(lifecycle) < maximumTerminalCommandGrowth(commandType, command)
    || security.actorDeviceId !== command.targetDeviceId
    || security.commandType !== commandType
    || security.entityId !== command.publicId
    || security.userId !== command.userId
  ) return corrupt();
  return { lifecycle, security };
}

async function insertAndChargeLifecycleReservation(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CapacityCommandDocument,
): Promise<Readonly<{ lifecycle: LifecycleReservation; security: SecurityReservation }>> {
  const lifecycleDocument = {
    capacityReservation: zeroCapacity(commandCapacityMaximum(commandType)),
    commandPublicId: command.publicId,
    commandType,
    createdAt: command.createdAt,
    userId: command.userId,
  } as const;
  const lifecycleId = await ctx.db.insert("commandLifecycleReservations", lifecycleDocument);

  // This is the exact future terminal event plus one fixed discriminator. Its
  // record and bytes are charged now, before any provider effect can begin.
  const securityDocument = {
    actorDeviceId: command.targetDeviceId,
    commandType,
    createdAt: command.createdAt,
    entityId: command.publicId,
    event: "command_terminal" as const,
    userId: command.userId,
  };
  const securityId = await ctx.db.insert(
    "commandTerminalSecurityReservations",
    securityDocument,
  );
  const [lifecycle, security] = await Promise.all([
    ctx.db.get(lifecycleId),
    ctx.db.get(securityId),
  ]);
  if (lifecycle === null || security === null) return corrupt();
  const exact = requireReservationPair(commandType, command, { lifecycle, security });
  await reserveQuotaForInsert(ctx, command.userId, "command", exact.lifecycle);
  await reserveQuotaForInsert(ctx, command.userId, "security", exact.security);
  return exact;
}

export async function reserveCommandLifecycleForInsert(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CapacityCommandDocument,
): Promise<void> {
  if (
    !command.nonterminal
    || command.lifecycleCapacityVersion !== commandLifecycleCapacityVersion
    || command.operatorAbandonedAt !== undefined
    || !isUuidV7(command.publicId)
  ) return corrupt();
  const rows = await reservationRows(ctx, commandType, command.publicId);
  if (rows.lifecycle !== null || rows.security !== null) return corrupt();
  await insertAndChargeLifecycleReservation(ctx, commandType, command);
}

async function requireOrReserveCommandLifecycle(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
): Promise<Readonly<{
  command: CommandDocument;
  lifecycle: LifecycleReservation;
  security: SecurityReservation;
}>> {
  if (
    !command.nonterminal
    || terminalStates.has(command.state)
    || command.operatorAbandonedAt !== undefined
  ) return corrupt();
  const rows = await reservationRows(ctx, commandType, command.publicId);
  if (command.lifecycleCapacityVersion === commandLifecycleCapacityVersion) {
    const reservations = requireReservationPair(commandType, command, rows);
    return { command, ...reservations };
  }
  const reservations = rows.lifecycle === null && rows.security === null
    ? await insertAndChargeLifecycleReservation(ctx, commandType, command)
    : requireReservationPair(commandType, command, rows);
  // The indexed command-side marker is what lets background maintenance and
  // revocation select only rows with physical authority. Retrofitting it is
  // part of the same aggregate reservation charge and cannot increase bytes.
  const markerPatch = { lifecycleCapacityVersion: commandLifecycleCapacityVersion } as const;
  const resized = resizedCapacity(commandType, command, markerPatch, reservations.lifecycle);
  const reservationPatch = { capacityReservation: resized.capacityReservation };
  await adjustCommandLifecycleQuotaForReplacement(
    ctx,
    command.userId,
    command,
    markerPatch,
    reservations.lifecycle,
    reservationPatch,
  );
  await ctx.db.patch(reservations.lifecycle._id, reservationPatch);
  await patchCommandDocument(ctx, commandType, command, markerPatch);
  return {
    command: { ...command, ...markerPatch },
    lifecycle: { ...reservations.lifecycle, ...reservationPatch },
    security: reservations.security,
  };
}

function resizedCapacity(
  commandType: CommandType,
  command: CommandDocument,
  commandPatch: CommandPatch,
  reservation: LifecycleReservation,
): Readonly<{ capacityReservation: string; commandDelta: number; reservationDelta: number }> {
  const nextCommand = { ...command, ...commandPatch };
  const commandDelta = logicalDocumentBytes(nextCommand) - logicalDocumentBytes(command);
  const targetCharacters = Math.min(
    commandCapacityMaximum(commandType),
    reservation.capacityReservation.length - commandDelta,
  );
  if (!Number.isSafeInteger(targetCharacters) || targetCharacters < 1) return corrupt();
  const capacityReservation = zeroCapacity(targetCharacters);
  const reservationDelta = logicalDocumentBytes({
    ...reservation,
    capacityReservation,
  }) - logicalDocumentBytes(reservation);
  if (commandDelta + reservationDelta > 0) return corrupt();
  return { capacityReservation, commandDelta, reservationDelta };
}

async function patchCommandDocument(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
  patch: CommandPatch,
): Promise<void> {
  if (commandType === "session") {
    await ctx.db.patch(command._id as Id<"sessionCommands">, patch);
    return;
  }
  await ctx.db.patch(command._id as Id<"deviceCommands">, patch);
}

async function patchNonterminalCommandWithCapacity(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
  patch: CommandPatch,
): Promise<void> {
  const next = { ...command, ...patch };
  if (!next.nonterminal || terminalStates.has(next.state)) return corrupt();
  const authority = await requireOrReserveCommandLifecycle(ctx, commandType, command);
  const current = authority.command;
  const { lifecycle } = authority;
  const resized = resizedCapacity(commandType, current, patch, lifecycle);
  const reservationPatch = { capacityReservation: resized.capacityReservation };
  await adjustCommandLifecycleQuotaForReplacement(
    ctx,
    current.userId,
    current,
    patch,
    lifecycle,
    reservationPatch,
  );
  await patchCommandDocument(ctx, commandType, current, patch);
  if (resized.reservationDelta !== 0) {
    await ctx.db.patch(lifecycle._id, reservationPatch);
  }
}

export async function patchSessionCommandWithLifecycleCapacity(
  ctx: MutationCtx,
  command: SessionCommand,
  patch: CommandPatch,
): Promise<void> {
  await patchNonterminalCommandWithCapacity(ctx, "session", command, patch);
}

export async function patchDeviceCommandWithLifecycleCapacity(
  ctx: MutationCtx,
  command: DeviceCommand,
  patch: CommandPatch,
): Promise<void> {
  await patchNonterminalCommandWithCapacity(ctx, "device", command, patch);
}

function terminalPatchWithReceiptCapacity(
  command: CommandDocument,
  patch: CommandPatch,
): CommandPatch {
  const next = { ...command, ...patch };
  if (
    next.nonterminal
    || !terminalStates.has(next.state)
    || command.operatorAbandonedAt !== undefined
    || next.operatorAbandonedAt !== undefined
  ) return corrupt();
  if (command.requesterAcknowledgedAt === undefined) {
    if (command.requesterReceiptAbandonedAt !== undefined) return corrupt();
    if (next.terminalCleanupAfter !== undefined) return corrupt();
    return {
      ...patch,
      lifecycleCapacityVersion: undefined,
      receiptCapacityReservation: commandReceiptCapacityReservation,
      terminalCleanupAfter: undefined,
    };
  }
  if (typeof next.terminalCleanupAfter !== "number") return corrupt();
  return {
    ...patch,
    lifecycleCapacityVersion: undefined,
    receiptCapacityReservation: undefined,
  };
}

async function consumeSecurityReservation(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
  reservation: SecurityReservation,
  securityDocument?: TerminalSecurityDocument,
): Promise<void> {
  if (securityDocument !== undefined && (
    securityDocument.actorDeviceId !== command.targetDeviceId
    || securityDocument.entityId !== command.publicId
    || securityDocument.userId !== command.userId
    || logicalDocumentBytes(securityDocument) > logicalDocumentBytes(reservation)
  )) return corrupt();
  if (securityDocument !== undefined) {
    await adjustTerminalSecurityQuotaForReplacement(
      ctx,
      command.userId,
      reservation,
      securityDocument,
    );
  } else {
    await releaseQuotaForDelete(ctx, command.userId, "security", reservation);
  }
  await ctx.db.delete(reservation._id);
  if (securityDocument !== undefined) {
    await ctx.db.insert("securityEvents", securityDocument);
  }
  void commandType;
}

async function insertLegacyTerminalSecurityEvent(
  ctx: MutationCtx,
  command: CommandDocument,
  securityDocument: TerminalSecurityDocument,
): Promise<void> {
  if (
    securityDocument.actorDeviceId !== command.targetDeviceId
    || securityDocument.entityId !== command.publicId
    || securityDocument.userId !== command.userId
  ) return corrupt();
  const existing = await ctx.db.query("securityEvents")
    .withIndex("by_user_entity_and_event", (builder) => builder
      .eq("userId", command.userId)
      .eq("entityId", command.publicId)
      .eq("event", "command_terminal"))
    .take(1);
  if (existing.length !== 0) return corrupt();
  await reserveQuotaForInsert(ctx, command.userId, "security", securityDocument);
  await ctx.db.insert("securityEvents", securityDocument);
}

async function terminalizeCommandWithCapacity(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
  patch: CommandPatch,
  securityDocument?: Parameters<typeof consumeSecurityReservation>[4],
): Promise<void> {
  const rows = await reservationRows(ctx, commandType, command.publicId);
  if (
    command.state === "effect_started"
    && command.nonterminal
    && command.lifecycleCapacityVersion === undefined
    && command.operatorAbandonedAt === undefined
    && rows.lifecycle === null
    && rows.security === null
  ) {
    // A pre-reservation daemon may already have crossed the durable effect
    // boundary when this additive release arrives. Charge only its actual
    // terminal patch and event so upgrading cannot introduce a new 352 KiB /
    // 24 KiB headroom requirement after the provider effect. If even the real
    // terminal shape does not fit, the source-bound operator has a separate,
    // explicitly acknowledged result-less abandonment primitive below.
    const terminalPatch = terminalPatchWithReceiptCapacity(command, patch);
    await adjustCommandQuotaForPatch(ctx, command.userId, command, terminalPatch);
    await patchCommandDocument(ctx, commandType, command, terminalPatch);
    if (securityDocument !== undefined) {
      await insertLegacyTerminalSecurityEvent(ctx, command, securityDocument);
    }
    return;
  }
  const reservations = await requireOrReserveCommandLifecycle(ctx, commandType, command);
  const current = reservations.command;
  const terminalPatch = terminalPatchWithReceiptCapacity(current, patch);
  const commandGrowth = logicalDocumentBytes({ ...current, ...terminalPatch })
    - logicalDocumentBytes(current);
  if (commandGrowth > logicalDocumentBytes(reservations.lifecycle)) return corrupt();

  // Every positive leg follows the physical release that admitted it. Convex
  // commits this whole mutation atomically, so an exception restores both
  // reservations and the prior command state.
  await adjustCommandLifecycleQuotaForReplacement(
    ctx,
    current.userId,
    current,
    terminalPatch,
    reservations.lifecycle,
    null,
  );
  await ctx.db.delete(reservations.lifecycle._id);
  await patchCommandDocument(ctx, commandType, current, terminalPatch);
  await consumeSecurityReservation(
    ctx,
    commandType,
    current,
    reservations.security,
    securityDocument,
  );
}

export async function terminalizeSessionCommandWithLifecycleCapacity(
  ctx: MutationCtx,
  command: SessionCommand,
  patch: CommandPatch,
  securityDocument?: Parameters<typeof consumeSecurityReservation>[4],
): Promise<void> {
  await terminalizeCommandWithCapacity(ctx, "session", command, patch, securityDocument);
}

export async function terminalizeDeviceCommandWithLifecycleCapacity(
  ctx: MutationCtx,
  command: DeviceCommand,
  patch: CommandPatch,
  securityDocument?: Parameters<typeof consumeSecurityReservation>[4],
): Promise<void> {
  await terminalizeCommandWithCapacity(ctx, "device", command, patch, securityDocument);
}

async function acknowledgeCommandReceipt(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
  patch: CommandPatch,
): Promise<void> {
  if (command.requesterAcknowledgedAt !== undefined) return corrupt();
  if (command.nonterminal) {
    await patchNonterminalCommandWithCapacity(ctx, commandType, command, patch);
    return;
  }
  if (!terminalStates.has(command.state)) return corrupt();
  if (command.requesterReceiptAbandonedAt !== undefined) return corrupt();
  if (command.receiptCapacityReservation !== commandReceiptCapacityReservation) {
    const next = { ...command, ...patch };
    const rows = await reservationRows(ctx, commandType, command.publicId);
    if (
      command.receiptCapacityReservation === undefined
      && command.lifecycleCapacityVersion === undefined
      && command.operatorAbandonedAt === undefined
      && command.terminalCleanupAfter === undefined
      && rows.lifecycle === null
      && rows.security === null
      && typeof next.requesterAcknowledgedAt === "number"
      && Number.isSafeInteger(next.requesterAcknowledgedAt)
      && typeof next.terminalCleanupAfter === "number"
      && Number.isSafeInteger(next.terminalCleanupAfter)
    ) {
      // Pre-reservation terminal receipts remain observable during the
      // additive rollout. Charge only the proof-bound acknowledgement's real
      // timestamp delta; it fails atomically at a hard ceiling and succeeds
      // once that small amount of headroom becomes available.
      await requireCommandRelationships(ctx, commandType, command);
      await adjustCommandQuotaForPatch(ctx, command.userId, command, patch);
      await patchCommandDocument(ctx, commandType, command, patch);
      return;
    }
    throw new Error("COMMAND_RECEIPT_CAPACITY_MISSING");
  }
  const terminalPatch = { ...patch, receiptCapacityReservation: undefined };
  await adjustCommandQuotaForPatch(ctx, command.userId, command, terminalPatch);
  await patchCommandDocument(ctx, commandType, command, terminalPatch);
}

export async function acknowledgeSessionCommandReceipt(
  ctx: MutationCtx,
  command: SessionCommand,
  patch: CommandPatch,
): Promise<void> {
  await acknowledgeCommandReceipt(ctx, "session", command, patch);
}

export async function acknowledgeDeviceCommandReceipt(
  ctx: MutationCtx,
  command: DeviceCommand,
  patch: CommandPatch,
): Promise<void> {
  await acknowledgeCommandReceipt(ctx, "device", command, patch);
}

async function abandonCommandReceipt(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
  abandonedAt: number,
  terminalCleanupAfter: number,
): Promise<void> {
  if (
    command.nonterminal
    || !terminalStates.has(command.state)
    || command.requesterAcknowledgedAt !== undefined
    || command.requesterReceiptAbandonedAt !== undefined
    || command.terminalCleanupAfter !== undefined
    || command.receiptCapacityReservation !== commandReceiptCapacityReservation
    || !Number.isSafeInteger(abandonedAt)
    || !Number.isSafeInteger(terminalCleanupAfter)
    || terminalCleanupAfter <= abandonedAt
  ) return corrupt();
  const patch = {
    receiptCapacityReservation: undefined,
    requesterReceiptAbandonedAt: abandonedAt,
    terminalCleanupAfter,
  } as const;
  if (logicalDocumentBytes({ ...command, ...patch }) > logicalDocumentBytes(command)) {
    return corrupt();
  }
  await adjustCommandQuotaForPatch(ctx, command.userId, command, patch);
  await patchCommandDocument(ctx, commandType, command, patch);
}

export async function abandonSessionCommandReceiptForRevokedRequester(
  ctx: MutationCtx,
  command: SessionCommand,
  abandonedAt: number,
  terminalCleanupAfter: number,
): Promise<void> {
  await abandonCommandReceipt(
    ctx,
    "session",
    command,
    abandonedAt,
    terminalCleanupAfter,
  );
}

export async function abandonDeviceCommandReceiptForRevokedRequester(
  ctx: MutationCtx,
  command: DeviceCommand,
  abandonedAt: number,
  terminalCleanupAfter: number,
): Promise<void> {
  await abandonCommandReceipt(
    ctx,
    "device",
    command,
    abandonedAt,
    terminalCleanupAfter,
  );
}

async function commandByType(
  ctx: MutationCtx,
  commandType: CommandType,
  publicId: string,
): Promise<CommandDocument | null> {
  if (commandType === "session") {
    const rows = await ctx.db.query("sessionCommands")
      .withIndex("by_public_id", (builder) => builder.eq("publicId", publicId))
      .take(2);
    if (rows.length > 1) return corrupt();
    return rows[0] ?? null;
  }
  const rows = await ctx.db.query("deviceCommands")
    .withIndex("by_public_id", (builder) => builder.eq("publicId", publicId))
    .take(2);
  if (rows.length > 1) return corrupt();
  return rows[0] ?? null;
}

async function commandRelationships(
  ctx: MutationCtx | QueryCtx,
  commandType: CommandType,
  command: CommandDocument,
) {
  const [requester, target] = await Promise.all([
    ctx.db.get(command.requestingDeviceId),
    ctx.db.get(command.targetDeviceId),
  ]);
  if (requester?.userId !== command.userId || target?.userId !== command.userId) return null;
  if (commandType === "session") {
    const sessionCommand = command as SessionCommand;
    const session = await ctx.db.get(sessionCommand.sessionId);
    if (
      session?.userId !== command.userId
      || session.executionDeviceId !== command.targetDeviceId
    ) return null;
  }
  return { requester, target } as const;
}

async function requireCommandRelationships(
  ctx: MutationCtx,
  commandType: CommandType,
  command: CommandDocument,
) {
  return await commandRelationships(ctx, commandType, command) ?? corrupt();
}

export function isOperatorAbandonedEffectTerminal(command: CommandDocument): boolean {
  const device = command as CommandDocument & Partial<DeviceCommand>;
  const abandonedAt = command.operatorAbandonedAt;
  return command.state === "ambiguous"
    && !command.nonterminal
    && command.boundAuthority === undefined
    && command.lifecycleCapacityVersion === undefined
    && typeof abandonedAt === "number"
    && Number.isSafeInteger(abandonedAt)
    && abandonedAt > 0
    && command.updatedAt === abandonedAt
    && command.terminalCleanupAfter === abandonedAt + COMMAND_TERMINAL_RETENTION_MS
    && command.receiptCapacityReservation === undefined
    && command.requesterReceiptAbandonedAt === undefined
    && command.result === undefined
    && command.resultCode === undefined
    && command.resultDigest === undefined
    && device.resultConsumedAt === undefined
    && device.resultExpiresAt === undefined
    && device.resultSingleUse === undefined;
}

export function isLegacyNoEffectExpiredTerminal(command: CommandDocument): boolean {
  const device = command as CommandDocument & Partial<DeviceCommand>;
  return command.state === "expired"
    && !command.nonterminal
    && command.boundAuthority === undefined
    && command.lifecycleCapacityVersion === undefined
    && command.operatorAbandonedAt === undefined
    && command.receiptCapacityReservation === undefined
    && command.requesterReceiptAbandonedAt === undefined
    && command.terminalCleanupAfter === undefined
    && command.result === undefined
    && command.resultCode === undefined
    && command.resultDigest === undefined
    && device.resultConsumedAt === undefined
    && device.resultExpiresAt === undefined
    && device.resultSingleUse === undefined;
}

async function securityEventsByCommandAndEvent(
  ctx: MutationCtx | QueryCtx,
  command: CommandDocument,
  event: "command_enqueued" | "command_terminal",
) {
  return await ctx.db.query("securityEvents")
    .withIndex("by_user_entity_and_event", (builder) => builder
      .eq("userId", command.userId)
      .eq("entityId", command.publicId)
      .eq("event", event))
    .take(3);
}

export async function requireOperatorAbandonedSecurityEvent(
  ctx: MutationCtx | QueryCtx,
  command: CommandDocument,
): Promise<void> {
  const [enqueueEvents, terminalEvents] = await Promise.all([
    securityEventsByCommandAndEvent(ctx, command, "command_enqueued"),
    securityEventsByCommandAndEvent(ctx, command, "command_terminal"),
  ]);
  const originalEnqueueEvents = enqueueEvents.filter((event) =>
    event.actorDeviceId === command.requestingDeviceId
    && event.createdAt === command.createdAt);
  const exactTerminalEvents = terminalEvents.filter((event) =>
    event.actorDeviceId === command.targetDeviceId
    && event.createdAt === command.operatorAbandonedAt);
  if (
    enqueueEvents.length > 1
    || originalEnqueueEvents.length !== 0
    || terminalEvents.length > 2
    || exactTerminalEvents.length !== 1
  ) return corrupt();
}

const operatorRetirementAcknowledgement =
  "RETIRE_LEGACY_EFFECT_AS_RESULTLESS_AMBIGUOUS" as const;
const operatorNoEffectRetirementAcknowledgement =
  "RETIRE_LEGACY_NO_EFFECT_AS_EXPIRED" as const;

// Break-glass migration for a pre-reservation effect that cannot afford even
// its actual result. It never publishes a claimed result or replays an effect.
// Dropping the bound authority funds an explicit operator-abandonment marker
// and cleanup deadline; the daemon must prove the exact shape before retiring
// its local effect journal. The original enqueue audit row becomes the one
// terminal audit row because both events cannot be retained at a hard ceiling.
export const retireLegacyEffectStarted = internalMutation({
  args: {
    acknowledgement: v.literal(operatorRetirementAcknowledgement),
    commandPublicId: v.string(),
    commandType: commandTypeValidator,
    expectedRuntimeAttestation: runtimeFenceValidator,
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    await requireHardQuotaAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) return corrupt();
    const command = await commandByType(ctx, args.commandType, args.commandPublicId);
    if (command === null) return corrupt();
    const crossTableCollision = args.commandType === "session"
      ? await ctx.db.query("deviceCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", command.publicId))
        .first()
      : await ctx.db.query("sessionCommands")
        .withIndex("by_public_id", (builder) => builder.eq("publicId", command.publicId))
        .first();
    if (crossTableCollision !== null) return corrupt();
    await requireCommandRelationships(ctx, args.commandType, command);
    const rows = await reservationRows(ctx, args.commandType, command.publicId);
    if (isOperatorAbandonedEffectTerminal(command)) {
      if (rows.lifecycle !== null || rows.security !== null) return corrupt();
      await requireOperatorAbandonedSecurityEvent(ctx, command);
      return { state: "exact" as const };
    }
    const device = command as CommandDocument & Partial<DeviceCommand>;
    if (
      command.state !== "effect_started"
      || !command.nonterminal
      || command.boundAuthority === undefined
      || command.lifecycleCapacityVersion !== undefined
      || command.operatorAbandonedAt !== undefined
      || command.receiptCapacityReservation !== undefined
      || command.requesterReceiptAbandonedAt !== undefined
      || command.terminalCleanupAfter !== undefined
      || command.result !== undefined
      || command.resultCode !== undefined
      || command.resultDigest !== undefined
      || device.resultConsumedAt !== undefined
      || device.resultExpiresAt !== undefined
      || device.resultSingleUse !== undefined
      || rows.lifecycle !== null
      || rows.security !== null
    ) return corrupt();
    const [enqueueEvents, terminalEvents] = await Promise.all([
      securityEventsByCommandAndEvent(ctx, command, "command_enqueued"),
      securityEventsByCommandAndEvent(ctx, command, "command_terminal"),
    ]);
    const enqueue = enqueueEvents[0];
    if (
      enqueueEvents.length !== 1
      || enqueue === undefined
      || terminalEvents.length !== 0
      || enqueue.actorDeviceId !== command.requestingDeviceId
      || enqueue.createdAt !== command.createdAt
    ) return corrupt();
    const abandonedAt = Date.now();
    const terminalCleanupAfter = abandonedAt + COMMAND_TERMINAL_RETENTION_MS;
    if (
      !Number.isSafeInteger(abandonedAt)
      || abandonedAt < 1
      || !Number.isSafeInteger(terminalCleanupAfter)
    ) return corrupt();
    const commandPatch = {
      boundAuthority: undefined,
      lifecycleCapacityVersion: undefined,
      nonterminal: false,
      operatorAbandonedAt: abandonedAt,
      receiptCapacityReservation: undefined,
      state: "ambiguous" as const,
      terminalCleanupAfter,
      updatedAt: abandonedAt,
    };
    const eventPatch = {
      actorDeviceId: command.targetDeviceId,
      createdAt: abandonedAt,
      event: "command_terminal" as const,
    };
    if (
      logicalDocumentBytes({ ...command, ...commandPatch }) > logicalDocumentBytes(command)
      || logicalDocumentBytes({ ...enqueue, ...eventPatch }) > logicalDocumentBytes(enqueue)
    ) throw new Error("COMMAND_LEGACY_EFFECT_RETIREMENT_NO_CAPACITY");
    await adjustQuotaForPatch(ctx, command.userId, "security", enqueue, eventPatch);
    await ctx.db.patch(enqueue._id, eventPatch);
    await adjustCommandQuotaForPatch(ctx, command.userId, command, commandPatch);
    await patchCommandDocument(ctx, args.commandType, command, commandPatch);
    return { state: "retired" as const };
  },
});

// Pre-reservation pending/prepared rows are known not to have crossed the
// provider-effect boundary. Once their authenticated deadline has elapsed,
// the operator may close them as result-less expired without allocating any
// new row or byte. Pending->expired is byte-neutral; prepared rows additionally
// drop their no-longer-live bound authority. Legacy enqueue-time
// acknowledgements are preserved without synthesizing a terminal observation;
// those exact rows remain as explicit retained compatibility evidence.
export const retireLegacyNoEffectExpired = internalMutation({
  args: {
    acknowledgement: v.literal(operatorNoEffectRetirementAcknowledgement),
    commandPublicId: v.string(),
    commandType: commandTypeValidator,
    expectedRuntimeAttestation: runtimeFenceValidator,
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    await requireHardQuotaAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) return corrupt();
    const command = await commandByType(ctx, args.commandType, args.commandPublicId);
    if (command === null) return corrupt();
    await requireCommandRelationships(ctx, args.commandType, command);
    const rows = await reservationRows(ctx, args.commandType, command.publicId);
    const device = command as CommandDocument & Partial<DeviceCommand>;
    if (
      isLegacyNoEffectExpiredTerminal(command)
      && rows.lifecycle === null
      && rows.security === null
    ) return { state: "exact" as const };
    const pending = command.state === "pending";
    const prepared = command.state === "prepared";
    if (
      !command.nonterminal
      || (!pending && !prepared)
      || (pending && command.boundAuthority !== undefined)
      || (prepared && command.boundAuthority === undefined)
      || command.deadline > Date.now()
      || command.lifecycleCapacityVersion !== undefined
      || command.operatorAbandonedAt !== undefined
      || command.receiptCapacityReservation !== undefined
      || command.requesterReceiptAbandonedAt !== undefined
      || command.terminalCleanupAfter !== undefined
      || command.result !== undefined
      || command.resultCode !== undefined
      || command.resultDigest !== undefined
      || device.resultConsumedAt !== undefined
      || device.resultExpiresAt !== undefined
      || device.resultSingleUse !== undefined
      || rows.lifecycle !== null
      || rows.security !== null
    ) return corrupt();
    const now = Date.now();
    const commandPatch = {
      ...(prepared ? { boundAuthority: undefined } : {}),
      nonterminal: false,
      state: "expired" as const,
      updatedAt: now,
    };
    if (logicalDocumentBytes({ ...command, ...commandPatch }) > logicalDocumentBytes(command)) {
      throw new Error("COMMAND_LEGACY_NO_EFFECT_RETIREMENT_NO_CAPACITY");
    }
    await adjustCommandQuotaForPatch(ctx, command.userId, command, commandPatch);
    await patchCommandDocument(ctx, args.commandType, command, commandPatch);
    return { state: "retired" as const };
  },
});

// Bounded migration primitive for additive deployment. It gives one
// already-nonterminal row the same physical capacity a fresh enqueue receives.
// If either related device is already revoked, it consumes that capacity in
// the same transaction to apply the ordinary cancelled/ambiguous disposition;
// it never authorizes execution.
export const reserveExisting = internalMutation({
  args: {
    commandPublicId: v.string(),
    commandType: commandTypeValidator,
    expectedRuntimeAttestation: runtimeFenceValidator,
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    await requireHardQuotaAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) return corrupt();
    const command = await commandByType(ctx, args.commandType, args.commandPublicId);
    if (command === null) return { state: "absent" as const };
    if (!command.nonterminal || terminalStates.has(command.state)) {
      return { state: "terminal" as const };
    }
    const relationships = await requireCommandRelationships(ctx, args.commandType, command);
    const before = await reservationRows(ctx, args.commandType, command.publicId);
    const authority = await requireOrReserveCommandLifecycle(ctx, args.commandType, command);
    if (
      relationships.requester.status === "revoked"
      || relationships.target.status === "revoked"
    ) {
      const now = Date.now();
      const commandPatch = {
        nonterminal: false,
        state: command.state === "effect_started" ? "ambiguous" as const : "cancelled" as const,
        ...(authority.command.requesterAcknowledgedAt === undefined
          ? {}
          : { terminalCleanupAfter: now + COMMAND_TERMINAL_RETENTION_MS }),
        updatedAt: now,
      };
      await terminalizeCommandWithCapacity(
        ctx,
        args.commandType,
        authority.command,
        commandPatch,
        command.state === "effect_started"
          ? {
              actorDeviceId: command.targetDeviceId,
              createdAt: now,
              entityId: command.publicId,
              event: "command_terminal",
              userId: command.userId,
            }
          : undefined,
      );
      if (
        relationships.requester.status === "revoked"
        && authority.command.requesterAcknowledgedAt === undefined
      ) {
        const terminal = await commandByType(ctx, args.commandType, command.publicId);
        if (terminal === null) return corrupt();
        await abandonCommandReceipt(
          ctx,
          args.commandType,
          terminal,
          now,
          now + COMMAND_TERMINAL_RETENTION_MS,
        );
      }
      return { state: "terminalized" as const };
    }
    return {
      state: before.lifecycle === null
        || command.lifecycleCapacityVersion !== commandLifecycleCapacityVersion
        ? "reserved" as const
        : "exact" as const,
    };
  },
});

export const reserveExistingTerminalReceipt = internalMutation({
  args: {
    commandPublicId: v.string(),
    commandType: commandTypeValidator,
    expectedRuntimeAttestation: runtimeFenceValidator,
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    await requireHardQuotaAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) return corrupt();
    const command = await commandByType(ctx, args.commandType, args.commandPublicId);
    if (command === null) return { state: "absent" as const };
    if (isOperatorAbandonedEffectTerminal(command)) {
      await requireOperatorAbandonedSecurityEvent(ctx, command);
      return { state: "not_required" as const };
    }
    if (command.operatorAbandonedAt !== undefined) return corrupt();
    if (
      command.nonterminal
      || !terminalStates.has(command.state)
      || command.requesterAcknowledgedAt !== undefined
      || command.requesterReceiptAbandonedAt !== undefined
    ) return { state: "not_required" as const };
    if (
      command.receiptCapacityReservation === commandReceiptCapacityReservation
      && command.terminalCleanupAfter === undefined
    ) {
      return { state: "exact" as const };
    }
    const requester = await ctx.db.get(command.requestingDeviceId);
    if (requester?.userId !== command.userId) return corrupt();
    if (requester.status === "revoked") {
      if (
        requester.revokedAt === undefined
        || !Number.isSafeInteger(requester.revokedAt)
        || requester.revokedAt < 1
      ) return corrupt();
      // A revocation job completed before this schema cannot be reopened. Its
      // legacy terminal receipts are instead retained from their existing
      // updatedAt and deleted by bounded maintenance after 30 days. Do not add
      // bytes merely to restate an already-durable revoked-device fact.
      return { state: "legacy_revoked" as const };
    }
    if (
      command.receiptCapacityReservation !== undefined
      && command.receiptCapacityReservation !== commandReceiptCapacityReservation
    ) return corrupt();
    const patch = {
      receiptCapacityReservation: commandReceiptCapacityReservation,
      terminalCleanupAfter: undefined,
    };
    await adjustCommandQuotaForPatch(ctx, command.userId, command, patch);
    await patchCommandDocument(ctx, args.commandType, command, patch);
    return { state: "reserved" as const };
  },
});

// An old writer could assign age-based cleanup before the requester observed
// the receipt. Clearing that unsafe deadline never needs quota headroom and is
// mandatory even when adding the newer 256-byte receipt reserve is impossible.
export const normalizeLegacyTerminalReceipt = internalMutation({
  args: {
    commandPublicId: v.string(),
    commandType: commandTypeValidator,
    expectedRuntimeAttestation: runtimeFenceValidator,
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    await requireHardQuotaAuthority(ctx);
    if (!isUuidV7(args.commandPublicId)) return corrupt();
    const command = await commandByType(ctx, args.commandType, args.commandPublicId);
    if (command === null) return { state: "absent" as const };
    await requireCommandRelationships(ctx, args.commandType, command);
    if (isOperatorAbandonedEffectTerminal(command)) {
      await requireOperatorAbandonedSecurityEvent(ctx, command);
      return { state: "not_required" as const };
    }
    const rows = await reservationRows(ctx, args.commandType, command.publicId);
    if (
      command.nonterminal
      || !terminalStates.has(command.state)
      || command.lifecycleCapacityVersion !== undefined
      || command.operatorAbandonedAt !== undefined
      || command.requesterAcknowledgedAt !== undefined
      || command.requesterReceiptAbandonedAt !== undefined
      || command.receiptCapacityReservation !== undefined
      || rows.lifecycle !== null
      || rows.security !== null
    ) return { state: "not_required" as const };
    if (command.terminalCleanupAfter === undefined) {
      return { state: "exact_no_cleanup" as const };
    }
    const patch = { terminalCleanupAfter: undefined };
    await adjustCommandQuotaForPatch(ctx, command.userId, command, patch);
    await patchCommandDocument(ctx, args.commandType, command, patch);
    return { state: "normalized" as const };
  },
});

async function classifyEffectRetirement(
  ctx: QueryCtx,
  commandType: CommandType,
  command: CommandDocument,
): Promise<"ambiguous" | "eligible" | "enqueue_missing"> {
  const device = command as CommandDocument & Partial<DeviceCommand>;
  if (
    command.state !== "effect_started"
    || !command.nonterminal
    || command.boundAuthority === undefined
    || command.lifecycleCapacityVersion !== undefined
    || command.operatorAbandonedAt !== undefined
    || command.receiptCapacityReservation !== undefined
    || command.requesterReceiptAbandonedAt !== undefined
    || command.terminalCleanupAfter !== undefined
    || command.result !== undefined
    || command.resultCode !== undefined
    || command.resultDigest !== undefined
    || device.resultConsumedAt !== undefined
    || device.resultExpiresAt !== undefined
    || device.resultSingleUse !== undefined
    || await commandRelationships(ctx, commandType, command) === null
  ) return "ambiguous";
  const [enqueueEvents, terminalEvents] = await Promise.all([
    securityEventsByCommandAndEvent(ctx, command, "command_enqueued"),
    securityEventsByCommandAndEvent(ctx, command, "command_terminal"),
  ]);
  if (enqueueEvents.length === 0 && terminalEvents.length === 0) return "enqueue_missing";
  const enqueue = enqueueEvents[0];
  return enqueueEvents.length === 1
    && enqueue !== undefined
    && terminalEvents.length === 0
    && enqueue.actorDeviceId === command.requestingDeviceId
    && enqueue.createdAt === command.createdAt
    ? "eligible"
    : "ambiguous";
}

async function classifyNoEffectRetirement(
  ctx: QueryCtx,
  commandType: CommandType,
  command: CommandDocument,
): Promise<"ambiguous" | "deadline_pending" | "eligible"> {
  const device = command as CommandDocument & Partial<DeviceCommand>;
  const pending = command.state === "pending";
  const prepared = command.state === "prepared";
  if (
    !command.nonterminal
    || (!pending && !prepared)
    || (pending && command.boundAuthority !== undefined)
    || (prepared && command.boundAuthority === undefined)
    || command.lifecycleCapacityVersion !== undefined
    || command.operatorAbandonedAt !== undefined
    || command.receiptCapacityReservation !== undefined
    || command.requesterReceiptAbandonedAt !== undefined
    || command.terminalCleanupAfter !== undefined
    || command.result !== undefined
    || command.resultCode !== undefined
    || command.resultDigest !== undefined
    || device.resultConsumedAt !== undefined
    || device.resultExpiresAt !== undefined
    || device.resultSingleUse !== undefined
    || await commandRelationships(ctx, commandType, command) === null
  ) return "ambiguous";
  return command.deadline <= Date.now() ? "eligible" : "deadline_pending";
}

async function auditRows(
  ctx: QueryCtx,
  commandType: CommandType,
  commands: readonly CommandDocument[],
) {
  const effectRetirement = [];
  const noEffectRetirement = [];
  const unreserved = [];
  for (const command of commands) {
    if (command.operatorAbandonedAt !== undefined) return corrupt();
    const rows = await reservationRows(ctx, commandType, command.publicId);
    if (rows.lifecycle === null && rows.security === null) {
      unreserved.push(command.publicId);
      if (command.state === "effect_started") {
        effectRetirement.push({
          commandPublicId: command.publicId,
          status: await classifyEffectRetirement(ctx, commandType, command),
        });
      } else {
        noEffectRetirement.push({
          commandPublicId: command.publicId,
          status: await classifyNoEffectRetirement(ctx, commandType, command),
        });
      }
      continue;
    }
    requireReservationPair(commandType, command, rows);
    if (command.lifecycleCapacityVersion !== commandLifecycleCapacityVersion) {
      unreserved.push(command.publicId);
    }
  }
  return { effectRetirement, noEffectRetirement, unreserved };
}

async function auditTerminalReceiptRows(
  ctx: QueryCtx,
  commandType: CommandType,
  commands: readonly CommandDocument[],
): Promise<Readonly<{
  legacyRevoked: string[];
  operatorAbandoned: string[];
  unsafeCleanup: string[];
  unreserved: string[];
}>> {
  const legacyRevoked = [];
  const operatorAbandoned = [];
  const unsafeCleanup = [];
  const unreserved = [];
  for (const command of commands) {
    const acknowledged = command.requesterAcknowledgedAt !== undefined;
    const abandoned = command.requesterReceiptAbandonedAt !== undefined;
    const reservations = await reservationRows(ctx, commandType, command.publicId);
    if (command.operatorAbandonedAt !== undefined) {
      if (
        !isOperatorAbandonedEffectTerminal(command)
        || reservations.lifecycle !== null
        || reservations.security !== null
      ) return corrupt();
      await requireOperatorAbandonedSecurityEvent(ctx, command);
      operatorAbandoned.push(command.publicId);
      continue;
    }
    if (
      command.nonterminal
      || command.lifecycleCapacityVersion !== undefined
      || !terminalStates.has(command.state)
      || (acknowledged && abandoned)
      || reservations.lifecycle !== null
      || reservations.security !== null
    ) {
      return corrupt();
    }
    if (acknowledged || abandoned) {
      if (
        acknowledged
        && !abandoned
        && isLegacyNoEffectExpiredTerminal(command)
        && await commandRelationships(ctx, commandType, command) !== null
      ) continue;
      if (
        command.terminalCleanupAfter === undefined
        || command.receiptCapacityReservation !== undefined
      ) return corrupt();
      continue;
    }
    // Additive-rollout debt is the only repairable terminal shape: no receipt
    // owner has acted, but the old writer omitted the physical inline reserve
    // (and may have assigned age-based cleanup). The migration mutation below
    // attaches the exact reserve and clears cleanup before new writers start.
    if (
      command.receiptCapacityReservation !== commandReceiptCapacityReservation
      || command.terminalCleanupAfter !== undefined
    ) {
      if (command.terminalCleanupAfter !== undefined) {
        unsafeCleanup.push(command.publicId);
        continue;
      }
      const requester = await ctx.db.get(command.requestingDeviceId);
      if (requester?.userId !== command.userId) return corrupt();
      if (requester.status === "revoked") {
        if (
          requester.revokedAt === undefined
          || !Number.isSafeInteger(requester.revokedAt)
          || requester.revokedAt < 1
        ) return corrupt();
        legacyRevoked.push(command.publicId);
      } else unreserved.push(command.publicId);
    }
  }
  return { legacyRevoked, operatorAbandoned, unsafeCleanup, unreserved };
}

// Exhaust both command types with state=effect_started after deploying the
// additive server. Because the new server cannot create another unreserved
// effect_started row, two completed zero-result scans form the writer-readiness
// gate documented in docs/hosted-sync.md.
export const auditReservationPage = internalQuery({
  args: {
    commandType: commandTypeValidator,
    expectedRuntimeAttestation: runtimeFenceValidator,
    paginationOpts: paginationOptsValidator,
    state: v.union(
      v.literal("pending"),
      v.literal("prepared"),
      v.literal("effect_started"),
    ),
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > maximumCommandLifecycleBatch
    ) return corrupt();
    if (args.commandType === "session") {
      const page = await ctx.db.query("sessionCommands")
        .withIndex("by_state_and_updated_at", (builder) => builder.eq("state", args.state))
        .paginate(args.paginationOpts);
      const audit = await auditRows(ctx, args.commandType, page.page);
      return {
        commandType: args.commandType,
        continueCursor: page.continueCursor,
        isDone: page.isDone,
        scanned: page.page.length,
        state: args.state,
        ...audit,
      };
    }
    const page = await ctx.db.query("deviceCommands")
      .withIndex("by_state_and_deadline", (builder) => builder.eq("state", args.state))
      .paginate(args.paginationOpts);
    const audit = await auditRows(ctx, args.commandType, page.page);
    return {
      commandType: args.commandType,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      state: args.state,
      ...audit,
    };
  },
});

// Every current identity and non-revoked device owns real, category-charged
// authority-reduction capacity. This source/runtime-fenced page is the
// rollout proof that predecessor users have been backfilled without partial
// reservation sets. A hard-full legacy user remains explicit debt until
// ordinary data is deleted or expires; the audit never invents headroom.
export const classifyAuthorityReductionHeadroomPage = internalQuery({
  args: {
    expectedRuntimeAttestation: runtimeFenceValidator,
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > maximumCommandLifecycleBatch
    ) return corrupt();
    const page = await ctx.db.query("users").paginate(args.paginationOpts);
    const now = Date.now();
    const classified: Array<Readonly<{
      disposition: AuthorityReductionCapacityDisposition;
      userId: Id<"users">;
    }>> = [];
    for (const user of page.page) {
      const result = await classifyAuthorityReductionCapacityForUser(
        ctx,
        user._id,
        now,
      );
      classified.push({ disposition: result.disposition, userId: user._id });
    }
    return {
      classified,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
    };
  },
});

// A page is one read-only observation, never a reservation or activation proof.
export const auditAuthorityReductionQuotaCeilingsPage = internalQuery({
  args: {
    expectedRuntimeAttestation: runtimeFenceValidator,
    paginationOpts: v.object({ cursor: v.union(v.string(), v.null()), numItems: v.number() }),
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > maximumCommandLifecycleBatch
      || (args.paginationOpts.cursor !== null && args.paginationOpts.cursor.length > 4_096)
    ) return corrupt();
    const page = await ctx.db.query("users").paginate({
      cursor: args.paginationOpts.cursor,
      maximumRowsRead: maximumCommandLifecycleBatch,
      numItems: args.paginationOpts.numItems,
    });
    if (
      page.page.length > maximumCommandLifecycleBatch
      || page.continueCursor.length > 4_096
    ) return corrupt();
    const counts = {
      capacityMissing: 0, evaluated: 0, orphanEligible: 0, orphanPending: 0,
      quotaAuthorityUnknown: 0, ready: 0, topologyBlocked: 0,
    };
    const demand = { accountPairs: 0, deviceQuartets: 0, paddingBytesLowerBound: 0, totalRecords: 0 };
    const ceilings = emptyAuthorityReductionQuotaCeilings();
    const now = Date.now();
    for (const user of page.page) {
      const inspected = await inspectAuthorityReductionCapacityForUser(ctx, user._id, now);
      switch (inspected.disposition) {
        case "ready": counts.ready += 1; break;
        case "topology_blocked": counts.topologyBlocked += 1; break;
        case "orphan_cleanup_pending": counts.orphanPending += 1; break;
        case "orphan_cleanup_eligible": counts.orphanEligible += 1; break;
        case "capacity_missing": {
          counts.capacityMissing += 1;
          const missing = authorityReductionReservationDemand(inspected.accountPairs, inspected.deviceQuartets);
          demand.accountPairs += missing.accountPairs;
          demand.deviceQuartets += missing.deviceQuartets;
          demand.totalRecords += missing.totalRecords;
          demand.paddingBytesLowerBound += missing.paddingBytesLowerBound;
          const observation = await inspectAuthorityReductionQuota(
            ctx, user._id, inspected.accountPairs, inspected.deviceQuartets,
          );
          if (observation.state === "authority_unknown") {
            counts.quotaAuthorityUnknown += 1;
            break;
          }
          counts.evaluated += 1;
          for (const ceiling of AUTHORITY_REDUCTION_QUOTA_CEILINGS) {
            const source = observation.ceilings[ceiling];
            const target = ceilings[ceiling];
            target.applicable += source.applicable;
            target.bytesBlockedByLowerBound += source.bytesBlockedByLowerBound;
            target.bytesUnknown += source.bytesUnknown;
            target.recordsBlocked += source.recordsBlocked;
          }
          break;
        }
      }
    }
    return {
      ...counts,
      activationAuthorized: false as const,
      byteCost: "padding_lower_bound_only" as const,
      ceilings,
      consistency: "page_snapshot" as const,
      continueCursor: page.continueCursor,
      demand,
      isDone: page.isDone,
      kind: "authority_reduction_quota_diagnostic" as const,
      repairAuthorized: false as const,
      scanned: page.page.length,
      schemaVersion: 1 as const,
    };
  },
});

export const reserveAuthorityReductionCapacity = internalMutation({
  args: {
    expectedRuntimeAttestation: runtimeFenceValidator,
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    if (await ctx.db.get(args.userId) === null) {
      return { reserved: 0, state: "absent" as const };
    }
    const classification = await classifyAuthorityReductionCapacityForUser(
      ctx,
      args.userId,
      Date.now(),
    );
    if (classification.disposition === "ready") {
      return { reserved: 0, state: "ready" as const };
    }
    if (classification.disposition !== "capacity_missing") {
      return {
        disposition: classification.disposition,
        reserved: 0,
        state: "reclassified" as const,
      };
    }
    try {
      await requireHardQuotaAuthority(ctx);
      const result = await backfillAuthorityReductionCapacityForUser(ctx, args.userId);
      return { ...result, state: "repaired" as const };
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "QUOTA_EXCEEDED") {
        throw new ConvexError({
          code: "authority_reduction_hard_quota",
          schemaVersion: 1,
        });
      }
      throw error;
    }
  },
});

type AuthorityReductionHeadroomPage = Readonly<{
  classified: readonly Readonly<{
    disposition: AuthorityReductionCapacityDisposition;
    userId: Id<"users">;
  }>[];
  continueCursor: string;
  isDone: boolean;
  scanned: number;
}>;

type AuthorityReductionHeadroomQueryArgs = Readonly<{
  expectedRuntimeAttestation: RuntimeFence;
  paginationOpts: Readonly<{ cursor: string | null; numItems: number }>;
}>;

type AuthorityReductionReservationResult = Readonly<{
  disposition?: AuthorityReductionCapacityDisposition;
  reserved: number;
  state: "absent" | "ready" | "reclassified" | "repaired";
}>;

type AuthorityReductionReservationArgs = Readonly<{
  expectedRuntimeAttestation: RuntimeFence;
  userId: Id<"users">;
}>;

const classifyAuthorityReductionHeadroomPageReference = makeFunctionReference<
  "query",
  AuthorityReductionHeadroomQueryArgs,
  AuthorityReductionHeadroomPage
>("commandLifecycle:classifyAuthorityReductionHeadroomPage");

const reserveAuthorityReductionCapacityReference = makeFunctionReference<
  "mutation",
  AuthorityReductionReservationArgs,
  AuthorityReductionReservationResult
>("commandLifecycle:reserveAuthorityReductionCapacity");

const isExactAuthorityReductionHardQuota = (error: unknown): boolean => {
  if (!(error instanceof ConvexError)) return false;
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) return false;
  const value = data as Readonly<Record<string, unknown>>;
  return Object.keys(value).length === 2
    && value.code === "authority_reduction_hard_quota"
    && value.schemaVersion === 1;
};

type AuthorityReductionHeadroomArgs = Readonly<{
  expectedRuntimeAttestation: RuntimeFence;
  mode: "audit" | "repair";
  paginationOpts: Readonly<{ cursor: string | null; numItems: number }>;
}>;

type AuthorityReductionHeadroomRunner = Readonly<{
  runMutation: (
    reference: typeof reserveAuthorityReductionCapacityReference,
    args: AuthorityReductionReservationArgs,
  ) => Promise<AuthorityReductionReservationResult>;
  runQuery: (
    reference: typeof classifyAuthorityReductionHeadroomPageReference,
    args: AuthorityReductionHeadroomQueryArgs,
  ) => Promise<AuthorityReductionHeadroomPage>;
}>;

export async function runAuthorityReductionHeadroomPage(
  ctx: AuthorityReductionHeadroomRunner,
  args: AuthorityReductionHeadroomArgs,
) {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > maximumCommandLifecycleBatch
    ) return corrupt();
    const page = await ctx.runQuery(classifyAuthorityReductionHeadroomPageReference, {
      expectedRuntimeAttestation: args.expectedRuntimeAttestation,
      paginationOpts: args.paginationOpts,
    });
    const counts = {
      capacityMissing: 0,
      hardQuotaBlocked: 0,
      orphanCleanupEligible: 0,
      orphanCleanupPending: 0,
      ready: 0,
      repaired: 0,
      topologyBlocked: 0,
    };
    const countDisposition = (disposition: AuthorityReductionCapacityDisposition): void => {
      switch (disposition) {
        case "ready": counts.ready += 1; break;
        case "capacity_missing": counts.capacityMissing += 1; break;
        case "orphan_cleanup_pending": counts.orphanCleanupPending += 1; break;
        case "orphan_cleanup_eligible": counts.orphanCleanupEligible += 1; break;
        case "topology_blocked": counts.topologyBlocked += 1; break;
      }
    };
    for (const entry of page.classified) {
      if (args.mode !== "repair" || entry.disposition !== "capacity_missing") {
        countDisposition(entry.disposition);
        continue;
      }
      try {
        const result = await ctx.runMutation(reserveAuthorityReductionCapacityReference, {
          expectedRuntimeAttestation: args.expectedRuntimeAttestation,
          userId: entry.userId,
        });
        if (
          result.state === "repaired"
          && isSafePositiveInteger(result.reserved)
          && result.reserved <= 17
          && result.disposition === undefined
        ) {
          counts.repaired += 1;
        } else if (
          (result.state === "absent" || result.state === "ready")
          && result.reserved === 0
          && result.disposition === undefined
        ) {
          counts.ready += 1;
        } else if (
          result.state === "reclassified"
          && result.reserved === 0
          && result.disposition !== undefined
          && result.disposition !== "ready"
          && result.disposition !== "capacity_missing"
        ) {
          countDisposition(result.disposition);
        } else {
          return corrupt();
        }
      } catch (error: unknown) {
        if (isExactAuthorityReductionHardQuota(error)) {
          counts.hardQuotaBlocked += 1;
          continue;
        }
        throw error;
      }
    }
    if (
      counts.ready
      + counts.capacityMissing
      + counts.repaired
      + counts.hardQuotaBlocked
      + counts.orphanCleanupPending
      + counts.orphanCleanupEligible
      + counts.topologyBlocked
      !== page.scanned
    ) return corrupt();
    return {
      ...counts,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      mode: args.mode,
      scanned: page.scanned,
      schemaVersion: 1 as const,
    };
}

export const auditAuthorityReductionHeadroomPage = internalAction({
  args: {
    expectedRuntimeAttestation: runtimeFenceValidator,
    mode: v.union(v.literal("audit"), v.literal("repair")),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => await runAuthorityReductionHeadroomPage(ctx, args),
});

export const auditTerminalReceiptCapacityPage = internalQuery({
  args: {
    commandType: commandTypeValidator,
    expectedRuntimeAttestation: runtimeFenceValidator,
    paginationOpts: paginationOptsValidator,
    state: v.union(
      v.literal("applied"),
      v.literal("failed"),
      v.literal("ambiguous"),
      v.literal("cancelled"),
      v.literal("expired"),
    ),
  },
  handler: async (ctx, args) => {
    requireRuntimeFence(args.expectedRuntimeAttestation);
    if (
      !isSafePositiveInteger(args.paginationOpts.numItems)
      || args.paginationOpts.numItems > maximumCommandLifecycleBatch
    ) return corrupt();
    if (args.commandType === "session") {
      const page = await ctx.db.query("sessionCommands")
        .withIndex("by_state_and_updated_at", (builder) => builder.eq("state", args.state))
        .paginate(args.paginationOpts);
      const audit = await auditTerminalReceiptRows(ctx, args.commandType, page.page);
      return {
        commandType: args.commandType,
        continueCursor: page.continueCursor,
        isDone: page.isDone,
        scanned: page.page.length,
        state: args.state,
        ...audit,
      };
    }
    const page = await ctx.db.query("deviceCommands")
      .withIndex("by_state_and_updated_at", (builder) => builder.eq("state", args.state))
      .paginate(args.paginationOpts);
    const audit = await auditTerminalReceiptRows(ctx, args.commandType, page.page);
    return {
      commandType: args.commandType,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      state: args.state,
      ...audit,
    };
  },
});
