import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { qualificationTag } from "./identity.ts";
import { createNativeQualification, createQualification, nativeQualificationBindingSchema, observeQualification, qualificationBindingSchema, qualificationEventSchema, QualificationStateError, type QualificationState } from "./state.ts";

const failures = z.enum(["invalid_input", "binding_invalid", "order_invalid", "observation_invalid", "identity_crossover", "inherited_authentication", "joined_authenticated", "owner_lost", "uncertain_effect", "persistence_uncertain"]);
const payloadSchema = z.strictObject({ version: z.literal(1), mode: z.literal("credential_free_fixture"), binding: qualificationBindingSchema,
  initialOwnerEpoch: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
  events: z.array(qualificationEventSchema).max(160), failure: failures.nullable() });
const envelopeSchema = z.strictObject({ version: z.literal(1), payload: z.string().max(120 * 1_024), mac: z.string().regex(/^[0-9a-f]{64}$/u) });
const invalid = (): never => { throw new QualificationStateError("invalid_input"); };
const maxBytes = 128 * 1_024;
const nativePayloadSchema = payloadSchema.extend({ version: z.literal(2), mode: z.literal("native_qualification"), binding: nativeQualificationBindingSchema });
const nativeEnvelopeSchema = envelopeSchema.extend({ version: z.literal(2) });

/** Private checkpoint bytes only: no filesystem writes, credential values or native authority. */
export function encodeQualificationCheckpoint(state: QualificationState, key: Uint8Array): Uint8Array {
  const payload = JSON.stringify(payloadSchema.parse({ version: 1, mode: "credential_free_fixture", binding: state.binding,
    initialOwnerEpoch: state.initialOwnerEpoch, events: state.events, failure: state.failure }));
  const mac = qualificationTag(key, state.binding.runId, "receipt", payload);
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, payload, mac }));
  if (bytes.byteLength > maxBytes) return invalid();
  return bytes;
}

/** Authenticates stored evidence only. This does not acquire ownership or resume a run. */
export function validateQualificationCheckpoint(bytes: Uint8Array, key: Uint8Array): QualificationState {
  if (bytes.byteLength > maxBytes || bytes.byteLength < 2) return invalid();
  try {
    const envelope = envelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    const payload = payloadSchema.parse(JSON.parse(envelope.payload) as unknown);
    const expected = qualificationTag(key, payload.binding.runId, "receipt", envelope.payload);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(envelope.mac, "hex"))) return invalid();
    let state = createQualification(payload.binding, key, payload.initialOwnerEpoch);
    for (const event of payload.events) state = observeQualification(state, event);
    // A persisted failure may conservatively close a run after rejected malformed input,
    // which is deliberately absent from the private journal. It can never erase failure.
    if (state.failure !== null && state.failure !== payload.failure) return invalid();
    state = { ...state, failure: payload.failure };
    return state;
  } catch { return invalid(); }
}

/** A validated journal restores evidence; a new owner must still reconcile its pending attempt. */
export function restoreQualificationCheckpoint(bytes: Uint8Array, key: Uint8Array): QualificationState {
  const state = validateQualificationCheckpoint(bytes, key);
  return restoreState(state);
}

/** Native-mode evidence only. A fixture binding or its prior binding tag cannot be promoted. */
export function encodeNativeQualificationCheckpoint(state: QualificationState, key: Uint8Array): Uint8Array {
  try {
    const initial = createNativeQualification(state.binding, key, state.initialOwnerEpoch);
    if (initial.bindingTag !== state.bindingTag) return invalid();
    const payload = JSON.stringify(nativePayloadSchema.parse({ version: 2, mode: "native_qualification", binding: state.binding,
      initialOwnerEpoch: state.initialOwnerEpoch, events: state.events, failure: state.failure }));
    const mac = qualificationTag(key, state.binding.runId, "native_receipt_v2", payload);
    const bytes = new TextEncoder().encode(JSON.stringify({ version: 2, payload, mac }));
    if (bytes.byteLength > maxBytes) return invalid();
    return bytes;
  } catch { return invalid(); }
}

/** Authenticates native provenance and journal, without granting any launch or source authority. */
export function validateNativeQualificationCheckpoint(bytes: Uint8Array, key: Uint8Array): QualificationState {
  if (bytes.byteLength > maxBytes || bytes.byteLength < 2) return invalid();
  try {
    const envelope = nativeEnvelopeSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
    const payload = nativePayloadSchema.parse(JSON.parse(envelope.payload) as unknown);
    const expected = qualificationTag(key, payload.binding.runId, "native_receipt_v2", envelope.payload);
    if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(envelope.mac, "hex"))) return invalid();
    let state = createNativeQualification(payload.binding, key, payload.initialOwnerEpoch);
    for (const event of payload.events) state = observeQualification(state, event);
    if (state.failure !== null && state.failure !== payload.failure) return invalid();
    return { ...state, failure: payload.failure };
  } catch { return invalid(); }
}

/** Incomplete native evidence restores suspended; custody separately fences uncertain old attempts. */
export function restoreNativeQualificationCheckpoint(bytes: Uint8Array, key: Uint8Array): QualificationState {
  return restoreState(validateNativeQualificationCheckpoint(bytes, key));
}

function restoreState(state: QualificationState): QualificationState {
  if (state.failure !== null && !["owner_lost", "uncertain_effect", "persistence_uncertain"].includes(state.failure)) return { ...state, needsRecovery: true, recoveryValidated: false };
  if (state.step === 22) return state;
  return observeQualification(state, { type: "suspend", reason: "owner_lost" });
}
