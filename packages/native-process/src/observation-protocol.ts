import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import { nativeHostContextSchema, nativePreparedOfReady, nativePreparedSchema,
  nativeReadySchema } from "./identity.ts";
import { NativeProtocolError } from "./protocol.ts";

export const MAX_NATIVE_OBSERVATION_BYTES = 64 * 1024;
export const NativeObservationKind = {
  hostRequest: 7, scopeRequest: 8, hostResponse: 139, scopeResponse: 140,
} as const;
const nonce = z.string().regex(/^[0-9a-f]{32}$/u);
const bindingShape = { nonce, bindingDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  expectedRevision: z.number().int().min(1).max(5) };
const envelopeShape = { version: z.literal(1), requestId: nonce };
export const nativeHostRequestSchema = z.object(envelopeShape).strict();
const scopeTargetSchema = z.object({ ...bindingShape, prepared: nativePreparedSchema,
  ready: nativeReadySchema.nullable() }).strict().refine(value => value.nonce === value.prepared.nonce
    && (value.ready === null || isDeepStrictEqual(nativePreparedOfReady(value.ready), value.prepared)));
export const nativeScopeRequestSchema = z.object({ ...envelopeShape, context: nativeHostContextSchema,
  targets: z.array(scopeTargetSchema).min(1).max(16) }).strict().refine(value =>
  new Set(value.targets.map(target => target.nonce)).size === value.targets.length
  && value.targets.every(target => isDeepStrictEqual(target.prepared.boot, value.context.boot)));
const processStatus = z.enum(["same-process-present", "original-absent", "unknown"]);
const observationTargetSchema = z.object({ ...bindingShape,
  supervisor: processStatus, anchor: processStatus, root: processStatus.nullable(),
  group: z.enum(["present", "absent", "unknown"]),
}).strict();
const hostResponseSchema = z.object({ ...envelopeShape, context: nativeHostContextSchema }).strict();
const scopeResponseSchema = z.object({ ...envelopeShape, context: nativeHostContextSchema,
  relation: z.enum(["same-boot", "boot-ended", "foreign-host", "foreign-scope"]),
  targets: z.array(observationTargetSchema).min(1).max(16),
}).strict();
export type NativeHostRequest = z.infer<typeof nativeHostRequestSchema>;
export type NativeScopeRequest = z.infer<typeof nativeScopeRequestSchema>;
export type NativeHostObservation = z.infer<typeof hostResponseSchema>;
export type NativeScopeObservation = z.infer<typeof scopeResponseSchema>;

export function encodeNativeObservationRequest(kind: "host" | "scopes", value: unknown): Uint8Array {
  try {
    const request = kind === "host" ? nativeHostRequestSchema.parse(value) : nativeScopeRequestSchema.parse(value);
    const payload = new TextEncoder().encode(JSON.stringify(request));
    if (payload.byteLength > MAX_NATIVE_OBSERVATION_BYTES) throw new NativeProtocolError();
    const frame = new Uint8Array(payload.byteLength + 5);
    frame[0] = kind === "host" ? NativeObservationKind.hostRequest : NativeObservationKind.scopeRequest;
    new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
    frame.set(payload, 5);
    return frame;
  } catch { throw new NativeProtocolError(); }
}

/** Mode-specific, exactly-one-frame decoder. Launch and provider events cannot
 * enter this observation port, and a header is checked before body allocation. */
export class NativeObservationDecoder {
  readonly #kind: number;
  readonly #header = new Uint8Array(5);
  #headerLength = 0;
  #body: Uint8Array | null = null;
  #bodyLength = 0;
  #failed = false;
  #finished = false;
  constructor(mode: "host" | "scopes") {
    this.#kind = mode === "host" ? NativeObservationKind.hostResponse : NativeObservationKind.scopeResponse;
  }
  push(chunk: Uint8Array): void {
    if (this.#failed || this.#finished) throw new NativeProtocolError();
    try {
      let offset = 0;
      if (this.#headerLength < 5) {
        const count = Math.min(5 - this.#headerLength, chunk.byteLength);
        this.#header.set(chunk.subarray(0, count), this.#headerLength);
        this.#headerLength += count;
        offset = count;
        if (this.#headerLength === 5) {
          const length = new DataView(this.#header.buffer).getUint32(1, false);
          if (this.#header[0] !== this.#kind || length === 0 || length > MAX_NATIVE_OBSERVATION_BYTES) throw new NativeProtocolError();
          this.#body = new Uint8Array(length);
        }
      }
      if (this.#body !== null) {
        if (chunk.byteLength - offset > this.#body.byteLength - this.#bodyLength) throw new NativeProtocolError();
        this.#body.set(chunk.subarray(offset), this.#bodyLength);
        this.#bodyLength += chunk.byteLength - offset;
      }
    } catch { this.#failed = true; throw new NativeProtocolError(); }
  }
  finish(): unknown {
    if (this.#failed || this.#finished) throw new NativeProtocolError();
    this.#finished = true;
    try {
      if (this.#body === null || this.#bodyLength !== this.#body.byteLength) throw new NativeProtocolError();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#body)) as unknown;
    } catch { throw new NativeProtocolError(); }
  }
}

export function parseNativeHostObservation(value: unknown, request: NativeHostRequest): NativeHostObservation {
  try {
    const response = hostResponseSchema.parse(value);
    if (response.requestId !== request.requestId) throw new NativeProtocolError();
    return response;
  } catch { throw new NativeProtocolError(); }
}

export function parseNativeScopeObservation(value: unknown, request: NativeScopeRequest): NativeScopeObservation {
  try {
    const response = scopeResponseSchema.parse(value);
    const sameHost = isDeepStrictEqual(response.context.host, request.context.host);
    const sameBoot = isDeepStrictEqual(response.context.boot, request.context.boot);
    const relation = !sameHost ? "foreign-host" : response.context.boot.id !== request.context.boot.id
      ? "boot-ended" : sameBoot ? "same-boot" : "foreign-scope";
    if (response.requestId !== request.requestId || response.relation !== relation
      || response.targets.length !== request.targets.length) throw new NativeProtocolError();
    for (let index = 0; index < request.targets.length; index += 1) {
      const expected = request.targets[index];
      const actual = response.targets[index];
      if (expected === undefined || actual === undefined
        || actual.nonce !== expected.nonce || actual.bindingDigest !== expected.bindingDigest
        || actual.expectedRevision !== expected.expectedRevision || (actual.root === null) !== (expected.ready === null)) {
        throw new NativeProtocolError();
      }
      // Changed scope/boot requests do not authorize any old-PID inspection.
      if (relation !== "same-boot" && (actual.supervisor !== "unknown" || actual.anchor !== "unknown"
        || (actual.root !== null && actual.root !== "unknown") || actual.group !== "unknown")) throw new NativeProtocolError();
    }
    return response;
  } catch { throw new NativeProtocolError(); }
}

/** The product must additionally bind the current held lock/store identity and
 * exact durable row. This is only the native observation portion of recovery. */
export function nativeScopeIsAbsent(observation: NativeScopeObservation, index: number): boolean {
  const target = observation.targets[index];
  return observation.relation === "same-boot" && target !== undefined
    && target.supervisor === "original-absent" && target.anchor === "original-absent"
    && (target.root === null || target.root === "original-absent") && target.group === "absent";
}
