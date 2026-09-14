import { expect, test } from "bun:test";
import fc from "fast-check";

import { nativeHostContextSchema } from "./identity.ts";
import {
  encodeNativeObservationRequest, MAX_NATIVE_OBSERVATION_BYTES, NativeObservationDecoder,
  nativeScopeIsAbsent, nativeScopeRequestSchema, parseNativeHostObservation, parseNativeScopeObservation,
  type NativeScopeObservation,
} from "./observation-protocol.ts";

const requestId = "a".repeat(32);
const context = { host: { platform: "darwin", digest: "b".repeat(64) },
  boot: { platform: "darwin", id: "12345678-1234-1234-1234-123456789012" } } as const;
const processIdentity = (pid: number) => ({ pid, birth: { kind: "darwin-start-time", seconds: "2", micros: 0 } } as const);
const prepared = { version: 1, nonce: "c".repeat(32), scope: "posix-process-group", groupId: 12,
  boot: context.boot, supervisor: processIdentity(11), anchor: processIdentity(12) } as const;
const request = nativeScopeRequestSchema.parse({ version: 1, requestId, context,
  targets: [{ nonce: prepared.nonce, bindingDigest: "d".repeat(64), expectedRevision: 3, prepared, ready: null }] });
const response: NativeScopeObservation = { version: 1, requestId, context, relation: "same-boot",
  targets: [{ nonce: prepared.nonce, bindingDigest: "d".repeat(64), expectedRevision: 3,
    supervisor: "original-absent", anchor: "original-absent", root: null, group: "absent" }] };
function frame(kind: number, value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  const result = new Uint8Array(payload.byteLength + 5);
  result[0] = kind; new DataView(result.buffer).setUint32(1, payload.byteLength, false);
  result.set(payload, 5); return result;
}

test("observation framing preserves arbitrary fragmentation and admits exactly one full response", () => {
  const wire = frame(140, response);
  fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 51 }), { minLength: 1, maxLength: 30 }), widths => {
    const decoder = new NativeObservationDecoder("scopes");
    let offset = 0;
    for (const width of widths) { decoder.push(wire.subarray(offset, offset + width)); offset = Math.min(wire.length, offset + width); }
    decoder.push(wire.subarray(offset));
    expect(decoder.finish()).toEqual(response);
    expect(() => decoder.finish()).toThrow();
    expect(() => decoder.push(new Uint8Array())).toThrow();
  }), { numRuns: 100 });
  for (let length = 0; length < wire.length; length += 1) {
    const decoder = new NativeObservationDecoder("scopes"); decoder.push(wire.subarray(0, length));
    expect(() => decoder.finish()).toThrow();
  }
});

test("observation parser refuses unknown modes, large headers, duplicate frames and invalid UTF8", () => {
  for (const [kind, length] of [[1, 1], [135, 1], [139, 1], [140, 0], [140, MAX_NATIVE_OBSERVATION_BYTES + 1]]) {
    const bytes = new Uint8Array(5); bytes[0] = kind!; new DataView(bytes.buffer).setUint32(1, length!, false);
    const decoder = new NativeObservationDecoder("scopes");
    expect(() => decoder.push(bytes)).toThrow(); expect(() => decoder.finish()).toThrow();
  }
  const decoder = new NativeObservationDecoder("scopes");
  decoder.push(frame(140, response));
  expect(() => decoder.push(frame(140, response))).toThrow(); expect(() => decoder.finish()).toThrow();
  const invalid = new NativeObservationDecoder("host");
  invalid.push(new Uint8Array([139, 0, 0, 0, 1, 255])); expect(() => invalid.finish()).toThrow();
});

test("strict bounded request rejects duplicate targets, foreign boots and mismatched Ready", () => {
  expect(encodeNativeObservationRequest("host", { version: 1, requestId })[0]).toBe(7);
  expect(encodeNativeObservationRequest("scopes", request)[0]).toBe(8);
  for (const value of [
    { ...request, argv: ["/forbidden"] }, { ...request, targets: [] },
    { ...request, targets: Array.from({ length: 17 }, () => request.targets[0]) },
    { ...request, targets: [...request.targets, ...request.targets] },
    { ...request, context: { ...context, boot: { ...context.boot, id: "00000000-0000-0000-0000-000000000000" } } },
    { ...request, targets: [{ ...request.targets[0], nonce: "e".repeat(32) }] },
    { ...request, targets: [{ ...request.targets[0], ready: { ...prepared, pid: 14, root: processIdentity(15) } }] },
  ]) expect(() => encodeNativeObservationRequest("scopes", value)).toThrow();
  expect(nativeHostContextSchema.safeParse({ ...context, host: { ...context.host, platform: "linux" } }).success).toBe(false);
});

test("host and scope responses bind the exact request, target sequence and boot relation", () => {
  expect(parseNativeHostObservation({ version: 1, requestId, context }, { version: 1, requestId }).context).toEqual(context);
  expect(parseNativeScopeObservation(response, request)).toEqual(response);
  for (const value of [
    { ...response, extra: true }, { ...response, requestId: "e".repeat(32) }, { ...response, targets: [] },
    { ...response, targets: [...response.targets, ...response.targets] },
    { ...response, targets: [{ ...response.targets[0], bindingDigest: "f".repeat(64) }] },
    { ...response, targets: [{ ...response.targets[0], expectedRevision: 2 }] },
    { ...response, targets: [{ ...response.targets[0], root: "original-absent" }] },
    { ...response, relation: "boot-ended" },
    { ...response, context: { ...context, host: { ...context.host, digest: "f".repeat(64) } } },
  ]) expect(() => parseNativeScopeObservation(value, request)).toThrow();
});

test("boot change is host-bound and never fabricates PID observations", () => {
  const changed = { ...response, relation: "boot-ended", context: { ...context,
    boot: { ...context.boot, id: "00000000-0000-0000-0000-000000000000" } }, targets: [{ ...response.targets[0],
    supervisor: "unknown", anchor: "unknown", root: null, group: "unknown" }] };
  expect(parseNativeScopeObservation(changed, request).relation).toBe("boot-ended");
  expect(() => parseNativeScopeObservation({ ...changed, targets: response.targets }, request)).toThrow();
  expect(() => parseNativeScopeObservation({ ...changed, context: { ...changed.context,
    host: { ...context.host, digest: "f".repeat(64) } } }, request)).toThrow();
});

test("scope absence requires every known process and group absent, including a dead supervisor", () => {
  expect(nativeScopeIsAbsent(response, 0)).toBe(true);
  expect(nativeScopeIsAbsent(response, 1)).toBe(false);
  for (const field of ["supervisor", "anchor", "root", "group"] as const) {
    expect(nativeScopeIsAbsent({ ...response, targets: [{ ...response.targets[0]!, [field]: "unknown" }] }, 0)).toBe(false);
  }
  expect(nativeScopeIsAbsent({ ...response, relation: "boot-ended" }, 0)).toBe(false);
});
