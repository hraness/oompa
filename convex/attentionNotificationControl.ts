import { v } from "convex/values";
import type { GenericId as Id, Value } from "convex/values";

import {
  isDigest,
  isFiniteTimestamp,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
} from "../src/cloud/contracts";
import { sha256Hex } from "../src/cloud/crypto";
import { createCloudUuidV7 } from "../src/domain/uuid-v7";
import {
  buildOompaAttentionEmailBody,
  parseOompaAttentionEmailBody,
} from "./attentionEmail";
import { ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS } from "./lifecyclePolicy";
import {
  logicalDocumentBytes,
  releaseServiceQuotaForDelete,
  tryReserveServiceQuotaForInserts,
} from "./quota";
import {
  internalMutation,
  internalQuery,
  type MutationCtx,
  type QueryCtx,
} from "./server";
import { requireOompaAttentionResendApiKey } from "./resendApiKey";

type ControlContext = MutationCtx | QueryCtx;

export type AttentionNotificationSafetyFault = Readonly<{
  _creationTime: number;
  _id: Id<"attentionNotificationSafetyFaults">;
  anchorRowId: Id<"attentionNotificationOutbox">;
  capacityReservation?: string;
  cleanupRowId?: Id<"attentionNotificationOutbox">;
  createdAt: number;
  deliveryId: string;
  deliveryGeneration?: number;
  faultId?: string;
  observedAt?: number;
  quarantineCompletedAt?: number;
  quarantineState?: "complete" | "not_required" | "pending";
  reason?: "invalid_idempotent_request" | "stored_delivery_corrupt";
  resultDigest?: string;
  reviewedAt?: number;
  reviewMutationId?: string;
  slot: number;
  state: "latched" | "reserved" | "reviewed";
  terminalCleanupAfter?: number;
  updatedAt: number;
  userId: Id<"users">;
}>;

export type LatchedAttentionNotificationSafetyFault =
  AttentionNotificationSafetyFault & Readonly<{
    capacityReservation: string;
    faultId: string;
    observedAt: number;
    quarantineState: "complete" | "not_required" | "pending";
    reason: "invalid_idempotent_request" | "stored_delivery_corrupt";
    resultDigest: string;
    state: "latched";
  }>;

export const maximumAttentionNotificationNonterminalRows = 256;
export const maximumAttentionNotificationDeliveryAttempts = 3;
export const attentionNotificationFaultSlotsPerDelivery =
  maximumAttentionNotificationDeliveryAttempts + 1;
export const attentionNotificationFaultCapacityReservations = Object.freeze({
  armed: "0".repeat(3 * 1_024),
  latched: "0".repeat(2 * 1_024),
  reserved: "0".repeat(4 * 1_024),
});
const attentionNotificationFaultCapacityQuotaDeliveryId =
  "00000000-0000-7000-8000-000000000000";

type AttentionNotificationControl = Readonly<{
  _id: Id<"serviceControl">;
  attentionNotificationGeneration?: number;
  attentionNotificationLastMutationId?: string;
  attentionNotifications?: "enabled" | undefined;
  key: "global";
  updatedAt: number;
}>;

const corrupt = (): never => {
  throw new Error("ATTENTION_NOTIFICATION_CONTROL_CORRUPT");
};

const stale = (): never => {
  throw new Error("ATTENTION_NOTIFICATION_CONTROL_STALE");
};

const safetyFaultLatched = (): never => {
  throw new Error("ATTENTION_NOTIFICATION_SAFETY_FAULT_LATCHED");
};

export function validAttentionNotificationSafetyFault(
  value: unknown,
): value is AttentionNotificationSafetyFault {
  if (
    !isRecord(value)
    || !isUuidV7(value.deliveryId)
    || !isSafeNonNegativeInteger(value.slot)
    || value.slot >= attentionNotificationFaultSlotsPerDelivery
    || !isFiniteTimestamp(value.createdAt)
    || !isFiniteTimestamp(value.updatedAt)
    || value.updatedAt < value.createdAt
    || typeof value.anchorRowId !== "string"
    || typeof value.userId !== "string"
  ) return false;
  if (value.state === "reserved") {
    const initial = value.capacityReservation
      === attentionNotificationFaultCapacityReservations.reserved
      && value.terminalCleanupAfter === undefined;
    const armed = value.capacityReservation
      === attentionNotificationFaultCapacityReservations.armed
      && isFiniteTimestamp(value.terminalCleanupAfter)
      && value.terminalCleanupAfter
        === value.updatedAt + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS;
    return (initial || armed)
      && value.cleanupRowId === undefined
      && value.deliveryGeneration === undefined
      && value.faultId === undefined
      && value.observedAt === undefined
      && value.quarantineCompletedAt === undefined
      && value.quarantineState === undefined
      && value.reason === undefined
      && value.resultDigest === undefined
      && value.reviewedAt === undefined
      && value.reviewMutationId === undefined;
  }
  if (
    (value.state !== "latched" && value.state !== "reviewed")
    || !isUuidV7(value.faultId)
    || !isFiniteTimestamp(value.observedAt)
    || value.observedAt < value.createdAt
    || value.observedAt > value.updatedAt
    || (value.reason !== "invalid_idempotent_request"
      && value.reason !== "stored_delivery_corrupt")
    || (value.reason === "invalid_idempotent_request"
      ? !isSafePositiveInteger(value.deliveryGeneration)
      : value.deliveryGeneration !== 0)
    || !isDigest(value.resultDigest)
  ) return false;
  const validQuarantine = value.reason === "invalid_idempotent_request"
    ? value.quarantineState === "not_required"
      && value.cleanupRowId === undefined
      && value.quarantineCompletedAt === undefined
    : value.quarantineState === "pending"
      ? typeof value.cleanupRowId === "string"
        && value.cleanupRowId.length >= 1
        && value.cleanupRowId.length <= 128
        && value.quarantineCompletedAt === undefined
      : value.quarantineState === "complete"
        && value.cleanupRowId === undefined
        && isFiniteTimestamp(value.quarantineCompletedAt)
        && value.quarantineCompletedAt >= value.observedAt
        && value.quarantineCompletedAt <= value.updatedAt;
  if (!validQuarantine) return false;
  return value.state === "latched"
    ? value.capacityReservation === attentionNotificationFaultCapacityReservations.latched
      && value.reviewedAt === undefined
      && value.reviewMutationId === undefined
      && value.terminalCleanupAfter === undefined
    : value.capacityReservation === undefined
      && isFiniteTimestamp(value.reviewedAt)
      && value.reviewedAt >= value.observedAt
      && value.reviewedAt <= value.updatedAt
      && isUuidV7(value.reviewMutationId)
      && value.terminalCleanupAfter
        === value.reviewedAt + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS;
}

function requireValidFault(value: unknown): AttentionNotificationSafetyFault {
  return validAttentionNotificationSafetyFault(value) ? value : corrupt();
}

function requireLatchedFault(value: unknown): LatchedAttentionNotificationSafetyFault {
  const fault = requireValidFault(value);
  return fault.state === "latched"
    ? fault as LatchedAttentionNotificationSafetyFault
    : corrupt();
}

/**
 * A fault slot is charged at its initial maximum reserved shape for its whole
 * lifecycle. Legitimate transitions are physically non-growing, but keeping
 * the original charge makes erasure independent of mutable evidence fields.
 * The reconstructed shape uses only Convex system fields, schema-typed IDs and
 * numbers (all fixed-width for document sizing), and fixed literals.
 */
function faultCapacityQuotaDocument(row: AttentionNotificationSafetyFault) {
  return {
    _creationTime: row._creationTime,
    _id: row._id,
    anchorRowId: row.anchorRowId,
    capacityReservation: attentionNotificationFaultCapacityReservations.reserved,
    createdAt: row.createdAt,
    deliveryId: attentionNotificationFaultCapacityQuotaDeliveryId,
    slot: 0,
    state: "reserved" as const,
    updatedAt: row.createdAt,
    userId: row.userId,
  };
}

async function releaseFaultCapacityQuotaForDelete(
  ctx: MutationCtx,
  row: AttentionNotificationSafetyFault,
): Promise<void> {
  await releaseServiceQuotaForDelete(ctx, faultCapacityQuotaDocument(row));
}

export async function readAttentionNotificationControl(
  ctx: ControlContext,
): Promise<AttentionNotificationControl> {
  const rows = await ctx.db.query("serviceControl")
    .withIndex("by_key", (builder) => builder.eq("key", "global"))
    .take(2);
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) return corrupt();
  const untrusted = row as unknown as Readonly<Record<string, unknown>>;
  const generation = untrusted.attentionNotificationGeneration;
  const mutationId = untrusted.attentionNotificationLastMutationId;
  const state = untrusted.attentionNotifications;
  if (
    untrusted.key !== "global"
    || !isFiniteTimestamp(untrusted.updatedAt)
    || untrusted.attentionNotificationSafetyFault !== undefined
    || (state !== undefined && state !== "enabled")
    || (generation === undefined && (mutationId !== undefined || state !== undefined))
    || (generation !== undefined && (
      !isSafeNonNegativeInteger(generation)
      || generation < 1
      || !isUuidV7(mutationId)
    ))
  ) return corrupt();
  return row;
}

export async function readOldestLatchedAttentionNotificationSafetyFault(
  ctx: ControlContext,
): Promise<LatchedAttentionNotificationSafetyFault | null> {
  const row = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_state_and_observed_at", (builder) => builder.eq("state", "latched"))
    .first();
  return row === null ? null : requireLatchedFault(row);
}

export async function readAttentionNotificationSafetyFaultById(
  ctx: ControlContext,
  faultId: string,
): Promise<AttentionNotificationSafetyFault | null> {
  if (!isUuidV7(faultId)) return stale();
  const rows = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_fault_id", (builder) => builder.eq("faultId", faultId))
    .take(2);
  if (rows.length > 1) return corrupt();
  return rows[0] === undefined ? null : requireValidFault(rows[0]);
}

export async function readOldestPendingStoredAttentionNotificationSafetyFault(
  ctx: ControlContext,
): Promise<LatchedAttentionNotificationSafetyFault | null> {
  const row = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_reason_quarantine_state_and_observed_at", (builder) => builder
      .eq("reason", "stored_delivery_corrupt")
      .eq("quarantineState", "pending"))
    .first();
  return row === null ? null : requireLatchedFault(row);
}

function publicFault(fault: AttentionNotificationSafetyFault | null) {
  if (fault === null || fault.state === "reserved") return null;
  const faultId = fault.faultId ?? corrupt();
  const observedAt = fault.observedAt ?? corrupt();
  const reason = fault.reason ?? corrupt();
  const resultDigest = fault.resultDigest ?? corrupt();
  return {
    deliveryId: fault.deliveryId,
    faultId,
    observedAt,
    reason,
    resultDigest,
    state: fault.state,
    ...(fault.state === "reviewed" ? {
      reviewedAt: fault.reviewedAt ?? corrupt(),
      reviewMutationId: fault.reviewMutationId ?? corrupt(),
    } : {}),
  };
}

async function publicControl(
  ctx: ControlContext,
  control: AttentionNotificationControl,
  exactFault?: AttentionNotificationSafetyFault,
) {
  const fault = exactFault
    ?? await readOldestLatchedAttentionNotificationSafetyFault(ctx);
  return {
    enabled: control.attentionNotifications === "enabled",
    generation: control.attentionNotificationGeneration ?? 0,
    safetyFault: publicFault(fault),
    updatedAt: control.updatedAt,
  };
}

export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const control = await readAttentionNotificationControl(ctx);
    return await publicControl(ctx, control);
  },
});

/**
 * Bounded release readback for the inactive Phase 8B deployment. It exposes
 * only control provenance and one-bit table occupancy, never notification
 * candidates, recipients, delivery evidence, or execution authority.
 */
export const inactiveDeploymentStatus = internalQuery({
  args: {},
  handler: async (ctx) => {
    const control = await readAttentionNotificationControl(ctx);
    const [outbox, safetyFaults] = await Promise.all([
      ctx.db.query("attentionNotificationOutbox").take(1),
      ctx.db.query("attentionNotificationSafetyFaults").take(1),
    ]);
    const generation = control.attentionNotificationGeneration ?? 0;
    const globalState = control.attentionNotifications === "enabled"
      ? "enabled" as const
      : control.attentionNotificationGeneration === undefined
        && control.attentionNotificationLastMutationId === undefined
        ? "absent" as const
        : "disabled" as const;
    return {
      generation,
      globalState,
      outboxOccupancy: outbox.length,
      safetyFaultOccupancy: safetyFaults.length,
    };
  },
});

/** Format and credential-separation readiness only, never provider authority. */
export const sendingKeyReadiness = internalQuery({
  args: {},
  handler: () => {
    try {
      requireOompaAttentionResendApiKey();
      return { dedicatedKeyReady: true };
    } catch {
      return { dedicatedKeyReady: false };
    }
  },
});

export const transition = internalMutation({
  args: {
    enabled: v.boolean(),
    expectedGeneration: v.number(),
    mutationId: v.string(),
  },
  handler: async (ctx, args) => {
    if (!isSafeNonNegativeInteger(args.expectedGeneration) || !isUuidV7(args.mutationId)) {
      return stale();
    }
    const current = await readAttentionNotificationControl(ctx);
    const generation = current.attentionNotificationGeneration ?? 0;
    const enabled = current.attentionNotifications === "enabled";
    if (current.attentionNotificationLastMutationId === args.mutationId) {
      if (generation !== args.expectedGeneration + 1 || enabled !== args.enabled) return stale();
      return { ...await publicControl(ctx, current), changed: true, replay: true };
    }
    if (generation !== args.expectedGeneration || enabled === args.enabled) return stale();
    if (args.enabled && await readOldestLatchedAttentionNotificationSafetyFault(ctx) !== null) {
      return safetyFaultLatched();
    }
    if (generation >= Number.MAX_SAFE_INTEGER) return corrupt();
    const next = {
      attentionNotificationGeneration: generation + 1,
      attentionNotificationLastMutationId: args.mutationId,
      attentionNotifications: args.enabled ? "enabled" as const : undefined,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(current._id, next);
    return {
      ...await publicControl(ctx, { ...current, ...next }),
      changed: true,
      replay: false,
    };
  },
});

async function faultCapacityRows(
  ctx: ControlContext,
  userId: Id<"users">,
  anchorRowId: Id<"attentionNotificationOutbox">,
): Promise<AttentionNotificationSafetyFault[]> {
  const rows = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_anchor_and_slot", (builder) => builder.eq("anchorRowId", anchorRowId))
    .take(attentionNotificationFaultSlotsPerDelivery + 1);
  if (rows.length > attentionNotificationFaultSlotsPerDelivery) return corrupt();
  const valid = rows.map(requireValidFault);
  if (valid.some((row) => row.userId !== userId)) return corrupt();
  return valid;
}

export async function reserveAttentionNotificationFaultCapacity(
  ctx: MutationCtx,
  input: Readonly<{
    anchorRowId: Id<"attentionNotificationOutbox">;
    deliveryId: string;
    now: number;
    userId: Id<"users">;
  }>,
): Promise<boolean> {
  if (!isUuidV7(input.deliveryId) || !isFiniteTimestamp(input.now)) return corrupt();
  if ((await faultCapacityRows(ctx, input.userId, input.anchorRowId)).length !== 0) {
    return corrupt();
  }
  const documents = Array.from(
    { length: attentionNotificationFaultSlotsPerDelivery },
    (_, slot) => ({
      anchorRowId: input.anchorRowId,
      capacityReservation: attentionNotificationFaultCapacityReservations.reserved,
      createdAt: input.now,
      deliveryId: input.deliveryId,
      slot,
      state: "reserved" as const,
      updatedAt: input.now,
      userId: input.userId,
    }),
  );
  const inserted = [];
  for (const document of documents) {
    const id = await ctx.db.insert("attentionNotificationSafetyFaults", document);
    const stored = await ctx.db.get(id);
    if (stored === null) return corrupt();
    if (logicalDocumentBytes(stored) !== logicalDocumentBytes(faultCapacityQuotaDocument(stored))) {
      return corrupt();
    }
    inserted.push(stored);
  }
  if (!await tryReserveServiceQuotaForInserts(ctx, inserted)) {
    for (const row of inserted) await ctx.db.delete(row._id);
    return false;
  }
  return true;
}

export async function requireAttentionNotificationFaultCapacity(
  ctx: ControlContext,
  input: Readonly<{
    anchorRowId: Id<"attentionNotificationOutbox">;
    deliveryId: string;
    userId: Id<"users">;
  }>,
): Promise<AttentionNotificationSafetyFault[]> {
  const rows = await faultCapacityRows(ctx, input.userId, input.anchorRowId);
  if (
    rows.length !== attentionNotificationFaultSlotsPerDelivery
    || rows.some((row) => row.anchorRowId !== input.anchorRowId)
    || rows.some((row) => row.state === "reserved" && row.deliveryId !== input.deliveryId)
    || new Set(rows.map((row) => row.slot)).size !== attentionNotificationFaultSlotsPerDelivery
  ) return corrupt();
  return rows.sort((left, right) => left.slot - right.slot);
}

export async function faultCapacityDeliveryIdForAnchor(
  ctx: ControlContext,
  userId: Id<"users">,
  anchorRowId: Id<"attentionNotificationOutbox">,
): Promise<string | null> {
  const rows = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_anchor_and_slot", (builder) => builder.eq("anchorRowId", anchorRowId))
    .take(attentionNotificationFaultSlotsPerDelivery + 1);
  if (rows.length === 0) return null;
  if (rows.length > attentionNotificationFaultSlotsPerDelivery) return corrupt();
  const valid = rows.map(requireValidFault);
  if (
    valid.some((row) => row.userId !== userId || row.anchorRowId !== anchorRowId)
    || new Set(valid.map((row) => row.slot)).size !== valid.length
  ) return corrupt();
  const reserved = valid.find((row) => row.state === "reserved");
  if (reserved !== undefined) return reserved.deliveryId;
  const ids = new Set(valid.map((row) => row.deliveryId));
  return ids.size === 1 ? valid[0]?.deliveryId ?? null : null;
}

function requireNonGrowingServicePatch(
  row: AttentionNotificationSafetyFault,
  patch: Readonly<Record<string, Value | undefined>>,
): void {
  if (logicalDocumentBytes({ ...row, ...patch }) > logicalDocumentBytes(row)) {
    return corrupt();
  }
}

async function patchFaultNonGrowing(
  ctx: MutationCtx,
  row: AttentionNotificationSafetyFault,
  patch: Readonly<Record<string, Value | undefined>>,
): Promise<void> {
  requireNonGrowingServicePatch(row, patch);
  await ctx.db.patch(row._id, patch as never);
}

export async function releaseUnusedAttentionNotificationFaultCapacity(
  ctx: MutationCtx,
  input: Readonly<{
    anchorRowId: Id<"attentionNotificationOutbox">;
    deliveryId: string;
    userId: Id<"users">;
  }>,
): Promise<void> {
  const rows = await requireAttentionNotificationFaultCapacity(ctx, input);
  if (rows.some((row) => row.state !== "reserved")) return corrupt();
  for (const row of rows) {
    await releaseFaultCapacityQuotaForDelete(ctx, row);
    await ctx.db.delete(row._id);
  }
}

async function exactFaultForInput(
  ctx: ControlContext,
  input: Readonly<{
    cleanupRowId?: Id<"attentionNotificationOutbox">;
    deliveryId: string;
    deliveryGeneration: number;
    anchorRowId: Id<"attentionNotificationOutbox">;
    reason: "invalid_idempotent_request" | "stored_delivery_corrupt";
    resultDigest: string;
    userId: Id<"users">;
  }>,
): Promise<AttentionNotificationSafetyFault | null> {
  const rows = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_identity", (builder) => builder
      .eq("userId", input.userId)
      .eq("anchorRowId", input.anchorRowId)
      .eq("deliveryGeneration", input.deliveryGeneration)
      .eq("reason", input.reason)
      .eq("resultDigest", input.resultDigest))
    .take(2);
  if (rows.length > 1) return corrupt();
  return rows[0] === undefined ? null : requireValidFault(rows[0]);
}

export async function latchAttentionNotificationSafetyFault(
  ctx: MutationCtx,
  input: Readonly<{
    capacityDeliveryId: string;
    anchorRowId: Id<"attentionNotificationOutbox">;
    cleanupRowId?: Id<"attentionNotificationOutbox">;
    deliveryId: string;
    deliveryGeneration: number;
    expectedGeneration: number;
    reason: "invalid_idempotent_request" | "stored_delivery_corrupt";
    resultDigest: string;
    userId: Id<"users">;
  }>,
) {
  if (
    !isUuidV7(input.capacityDeliveryId)
    || !isUuidV7(input.deliveryId)
    || (input.reason === "invalid_idempotent_request"
      ? !isSafePositiveInteger(input.deliveryGeneration)
      : input.deliveryGeneration !== 0)
    || !isSafeNonNegativeInteger(input.expectedGeneration)
    || !isDigest(input.resultDigest)
    || (input.cleanupRowId !== undefined && (
      typeof input.cleanupRowId !== "string"
      || input.cleanupRowId.length < 1
      || input.cleanupRowId.length > 128
    ))
    || (input.reason === "stored_delivery_corrupt") !== (input.cleanupRowId !== undefined)
  ) return stale();
  const current = await readAttentionNotificationControl(ctx);
  const generation = current.attentionNotificationGeneration ?? 0;
  if (generation < input.expectedGeneration) return stale();
  const existing = await exactFaultForInput(ctx, input);
  if (existing !== null) {
    if (existing.state === "reserved") return corrupt();
    return {
      ...await publicControl(ctx, current, existing),
      changed: false,
      replay: true,
    };
  }
  const slots = await faultCapacityRows(ctx, input.userId, input.anchorRowId);
  if (slots.some((candidate) =>
    candidate.state === "reserved" && candidate.deliveryId !== input.capacityDeliveryId)) {
    return corrupt();
  }
  const slot = slots.find((candidate) => candidate.state === "reserved");
  if (slot === undefined) return corrupt();
  const now = Date.now();
  const faultId = createCloudUuidV7(now);
  const patch = {
    capacityReservation: attentionNotificationFaultCapacityReservations.latched,
    ...(input.cleanupRowId === undefined ? {} : { cleanupRowId: input.cleanupRowId }),
    deliveryId: input.deliveryId,
    deliveryGeneration: input.deliveryGeneration,
    faultId,
    observedAt: now,
    quarantineState: input.reason === "stored_delivery_corrupt"
      ? "pending" as const
      : "not_required" as const,
    reason: input.reason,
    resultDigest: input.resultDigest,
    state: "latched" as const,
    terminalCleanupAfter: undefined,
    updatedAt: now,
  };
  await patchFaultNonGrowing(ctx, slot, patch);
  for (const sibling of slots) {
    if (
      sibling._id === slot._id
      || sibling.state !== "reserved"
      || sibling.capacityReservation === attentionNotificationFaultCapacityReservations.armed
    ) continue;
    await patchFaultNonGrowing(ctx, sibling, {
      capacityReservation: attentionNotificationFaultCapacityReservations.armed,
      terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
      updatedAt: now,
    });
  }
  const latched = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_state_and_observed_at", (builder) => builder.eq("state", "latched"))
    .take(2);
  const priorFault = latched.find((candidate) => candidate.faultId !== faultId);
  let nextControl = current;
  const changed = true;
  if (priorFault === undefined) {
    if (generation >= Number.MAX_SAFE_INTEGER) return corrupt();
    const controlPatch = {
      attentionNotificationGeneration: generation + 1,
      attentionNotificationLastMutationId: faultId,
      attentionNotifications: undefined,
      updatedAt: now,
    };
    await ctx.db.patch(current._id, controlPatch);
    nextControl = { ...current, ...controlPatch };
  }
  const inserted = requireLatchedFault({ ...slot, ...patch });
  return {
    ...await publicControl(ctx, nextControl, inserted),
    changed,
    replay: false,
  };
}

export const reserveSafetyFaultCapacity = internalMutation({
  args: {
    anchorRowId: v.id("attentionNotificationOutbox"),
    deliveryId: v.string(),
    now: v.number(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    return await reserveAttentionNotificationFaultCapacity(ctx, args);
  },
});

export const latchSafetyFault = internalMutation({
  args: {
    capacityDeliveryId: v.string(),
    anchorRowId: v.id("attentionNotificationOutbox"),
    cleanupRowId: v.optional(v.id("attentionNotificationOutbox")),
    deliveryId: v.string(),
    deliveryGeneration: v.number(),
    expectedGeneration: v.number(),
    reason: v.union(
      v.literal("invalid_idempotent_request"),
      v.literal("stored_delivery_corrupt"),
    ),
    resultDigest: v.string(),
    userId: v.id("users"),
  },
  handler: async (ctx, args) => await latchAttentionNotificationSafetyFault(ctx, args),
});

async function safetyFaultEvidenceAllowsReview(
  ctx: MutationCtx,
  fault: LatchedAttentionNotificationSafetyFault,
): Promise<boolean> {
  if (fault.reason === "invalid_idempotent_request") {
    const faultGeneration = fault.deliveryGeneration;
    if (!isSafePositiveInteger(faultGeneration)) return false;
    const queried = await ctx.db.query("attentionNotificationOutbox")
      .withIndex("by_delivery_id", (builder) => builder.eq("delivery.id", fault.deliveryId))
      .take(9);
    if (queried.length === 0) {
      const anchored = await ctx.db.query("attentionNotificationOutbox")
        .withIndex("by_fault_capacity_anchor", (builder) => builder
          .eq("faultCapacityAnchor", fault.anchorRowId))
        .take(1);
      return anchored.length === 0;
    }
    if (queried.length > 8) return false;
    const rows = [...queried].sort((left, right) =>
      String(left._id).localeCompare(String(right._id)));
    const first = rows[0];
    const delivery = first?.delivery;
    if (first === undefined || delivery?.settledAt === undefined) return false;
    const settledAt = delivery.settledAt;
    const leader = rows.find((row) => row._id === delivery.leaderRowId);
    const body = leader?.delivery?.body;
    if (
      body === undefined
      || parseOompaAttentionEmailBody(body) === null
      || first.userId !== fault.userId
      || delivery.leaderRowId !== fault.anchorRowId
      || !isSafePositiveInteger(delivery.attemptCount)
      || delivery.attemptCount > 3
      || !isSafePositiveInteger(delivery.generation)
      || delivery.generation !== faultGeneration
      || !isDigest(delivery.bodyDigest)
      || !isDigest(delivery.idempotencyKey)
      || !isDigest(delivery.recipientDigest)
      || !isFiniteTimestamp(delivery.settledAt)
      || !rows.every((row) => {
        const candidate = row.delivery;
        return row.userId === first.userId
          && row.state === "ambiguous"
          && !row.nonterminal
          && row.claimCapacityReservation === undefined
          && row.faultCapacityAnchor === fault.anchorRowId
          && row.terminalCleanupAfter
            === settledAt + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS
          && candidate !== undefined
          && candidate.id === fault.deliveryId
          && candidate.id === delivery.id
          && candidate.attemptCount === delivery.attemptCount
          && candidate.bodyDigest === delivery.bodyDigest
          && candidate.claimedAt === delivery.claimedAt
          && candidate.deadline === delivery.deadline
          && candidate.effectStartedAt === delivery.effectStartedAt
          && candidate.firstAttemptAt === delivery.firstAttemptAt
          && candidate.generation === delivery.generation
          && candidate.idempotencyKey === delivery.idempotencyKey
          && candidate.lastAttemptAt === delivery.lastAttemptAt
          && candidate.leaderRowId === delivery.leaderRowId
          && candidate.recipientDigest === delivery.recipientDigest
          && (row._id === delivery.leaderRowId) === (candidate.body !== undefined)
          && candidate.outcomeCode === "idempotency_mismatch"
          && candidate.outcomeDigest === fault.resultDigest
          && candidate.outcomeDigest === delivery.outcomeDigest
          && candidate.settledAt === settledAt
          && candidate.nextAttemptAt === undefined;
      })
    ) return false;
    const rebuilt = buildOompaAttentionEmailBody(rows.map((row) => ({
      interactionKind: row.interactionKind,
      sessionPublicId: row.sessionPublicId,
    })), body.version);
    const bodyDigest = await sha256Hex(`hra-attention-body:v1\u0000${rebuilt.text}`);
    const idempotencyKey = await sha256Hex([
      "hra-attention-resend:v1",
      delivery.id,
      delivery.recipientDigest,
      delivery.bodyDigest,
    ].join("\u0000"));
    return body.text === rebuilt.text
      && delivery.bodyDigest === bodyDigest
      && delivery.idempotencyKey === idempotencyKey;
  }
  return fault.quarantineState === "complete"
    && fault.quarantineCompletedAt !== undefined;
}

export async function completeAttentionNotificationSafetyFaultQuarantine(
  ctx: MutationCtx,
  faultId: string,
  now: number,
): Promise<void> {
  if (!isUuidV7(faultId) || !isFiniteTimestamp(now)) return corrupt();
  const existing = await readAttentionNotificationSafetyFaultById(ctx, faultId);
  const fault = existing === null ? corrupt() : requireLatchedFault(existing);
  if (fault.reason !== "stored_delivery_corrupt") return corrupt();
  if (fault.quarantineState === "complete") return;
  if (fault.quarantineState !== "pending") return corrupt();
  await patchFaultNonGrowing(ctx, fault, {
    cleanupRowId: undefined,
    quarantineCompletedAt: now,
    quarantineState: "complete",
    updatedAt: now,
  });
}

export const acknowledgeSafetyFault = internalMutation({
  args: {
    expectedDeliveryId: v.string(),
    expectedFaultId: v.string(),
    expectedGeneration: v.number(),
    expectedResultDigest: v.string(),
    mutationId: v.string(),
  },
  handler: async (ctx, args) => {
    if (
      !isUuidV7(args.expectedDeliveryId)
      || !isUuidV7(args.expectedFaultId)
      || !isSafeNonNegativeInteger(args.expectedGeneration)
      || !isDigest(args.expectedResultDigest)
      || !isUuidV7(args.mutationId)
    ) return stale();
    const current = await readAttentionNotificationControl(ctx);
    const generation = current.attentionNotificationGeneration ?? 0;
    const existing = await readAttentionNotificationSafetyFaultById(ctx, args.expectedFaultId);
    if (
      existing === null
      || existing.deliveryId !== args.expectedDeliveryId
      || existing.resultDigest !== args.expectedResultDigest
      || generation !== args.expectedGeneration
      || current.attentionNotifications !== undefined
      || existing.state === "reserved"
    ) return stale();
    if (existing.state === "reviewed") {
      if (existing.reviewMutationId !== args.mutationId) return stale();
      return {
        ...await publicControl(ctx, current, existing),
        changed: false,
        replay: true,
      };
    }
    const fault = requireLatchedFault(existing);
    if (!await safetyFaultEvidenceAllowsReview(ctx, fault)) return safetyFaultLatched();
    const now = Date.now();
    const patch = {
      capacityReservation: undefined,
      reviewedAt: now,
      reviewMutationId: args.mutationId,
      state: "reviewed" as const,
      terminalCleanupAfter: now + ATTENTION_NOTIFICATION_TERMINAL_RETENTION_MS,
      updatedAt: now,
    };
    await patchFaultNonGrowing(ctx, fault, patch);
    return {
      ...await publicControl(ctx, current, requireValidFault({ ...fault, ...patch })),
      changed: true,
      replay: false,
    };
  },
});

export async function deleteExpiredAttentionNotificationSafetyFaults(
  ctx: MutationCtx,
  now: number,
  limit: number,
): Promise<number> {
  if (!isFiniteTimestamp(now) || !isSafePositiveInteger(limit)) return corrupt();
  let remaining = limit;
  for (const state of ["reserved", "reviewed"] as const) {
    if (remaining === 0) break;
    const rows = await ctx.db.query("attentionNotificationSafetyFaults")
      .withIndex("by_state_and_cleanup_after", (builder) => builder
        .eq("state", state)
        .gt("terminalCleanupAfter", 0)
        .lt("terminalCleanupAfter", now))
      .take(remaining);
    for (const row of rows) {
      requireValidFault(row);
      await releaseFaultCapacityQuotaForDelete(ctx, row);
      await ctx.db.delete(row._id);
    }
    remaining -= rows.length;
  }
  return limit - remaining;
}

export async function deleteAttentionNotificationSafetyFaultsForAccount(
  ctx: MutationCtx,
  userId: Id<"users">,
  limit: number,
): Promise<{ deleted: number; empty: boolean }> {
  if (!isSafePositiveInteger(limit)) return corrupt();
  const rows = await ctx.db.query("attentionNotificationSafetyFaults")
    .withIndex("by_user", (builder) => builder.eq("userId", userId))
    .take(limit);
  for (const row of rows) {
    // Account erasure is authorized by the exact user index. It must remove a
    // target-owned row even when its operational fault fields are corrupt;
    // quota release reconstructs the immutable initial reservation charge and
    // ignores mutable variable-length operational or evidence fields.
    await releaseFaultCapacityQuotaForDelete(ctx, row);
    await ctx.db.delete(row._id);
  }
  return { deleted: rows.length, empty: rows.length === 0 };
}
