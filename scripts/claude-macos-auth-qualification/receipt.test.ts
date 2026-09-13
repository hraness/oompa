import { expect, test } from "bun:test";

import { CLAUDE_PIN, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin.ts";
import { qualificationTag } from "./identity.ts";
import { encodeNativeQualificationCheckpoint, encodeQualificationCheckpoint, restoreNativeQualificationCheckpoint,
  restoreQualificationCheckpoint, validateNativeQualificationCheckpoint, validateQualificationCheckpoint } from "./receipt.ts";
import { assertManualBrowserQualificationBinding, createNativeQualification, createQualification, observeQualification, publicQualificationReceipt, type QualificationState } from "./state.ts";

const key = new Uint8Array(32).fill(53);
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const directory = (name: string, inode: number) => ({ path: `/private/synthetic/native-receipt/${name}`, device: 1, inode, mode: 0o700 });
const binding = {
  version: 1, runId: id(1), sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), pin: CLAUDE_PIN,
  executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
  executable: { path: "/private/synthetic/immutable-claude", device: 1, inode: 100 }, ownerUid: 501,
  realHome: "/Users/synthetic", forbiddenRoots: ["/private/production"],
  runRoot: { path: "/private/synthetic/native-receipt", device: 1, inode: 2, mode: 0o700 },
  profileA: directory("A", 3), profileB: directory("B", 4), temporaryA: directory("tmp-A", 5), temporaryB: directory("tmp-B", 6),
  proofKey: { path: "/private/synthetic/native-receipt/proof-key", device: 1, inode: 7, mode: 0o600 },
};
const fixture = () => createQualification(binding, key, id(10));
const native = () => createNativeQualification({ ...binding, version: 2, mode: "native_qualification" }, key, id(10));
const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const record = (value: Uint8Array): Record<string, unknown> => JSON.parse(new TextDecoder().decode(value)) as Record<string, unknown>;
function dispatch(initial: QualificationState): QualificationState {
  const attemptId = id(20);
  let state = observeQualification(initial, { type: "intent", attemptId, step: 0 });
  state = observeQualification(state, { type: "persisted", attemptId });
  return observeQualification(state, { type: "dispatch", attemptId, bindingTag: state.bindingTag,
    sourceAndExecutableRevalidated: true, privateCustodyRevalidated: true, environmentRevalidated: true });
}

test("historical native v2 bytes remain unchanged but cannot admit a new manual-browser ceremony", () => {
  const state = native();
  const payload = JSON.stringify({ version: 2, mode: "native_qualification", binding: state.binding,
    initialOwnerEpoch: state.initialOwnerEpoch, events: state.events, failure: state.failure });
  const expected = bytes({ version: 2, payload, mac: qualificationTag(key, state.binding.runId, "native_receipt_v2", payload) });
  expect(encodeNativeQualificationCheckpoint(state, key)).toEqual(expected);
  const restored = validateNativeQualificationCheckpoint(expected, key);
  expect(restored).toEqual(state);
  expect(() => assertManualBrowserQualificationBinding(restored.binding)).toThrow("binding_invalid");
  expect(Object.hasOwn(restored.binding, "browserMode")).toBeFalse();
});

test("manual-browser mode is authenticated, closed, and cannot be added to an old receipt", () => {
  const initial = native();
  const state = createNativeQualification({ ...initial.binding, browserMode: "owner_manual" }, key, id(10));
  expect(() => assertManualBrowserQualificationBinding(state.binding)).not.toThrow();
  expect(state.bindingTag).not.toBe(initial.bindingTag);
  expect(validateNativeQualificationCheckpoint(encodeNativeQualificationCheckpoint(state, key), key)).toEqual(state);
  for (const mode of [undefined, "automatic", "/usr/bin/true", null, true]) {
    expect(() => assertManualBrowserQualificationBinding({ ...state.binding, browserMode: mode })).toThrow();
  }
  const original = record(encodeNativeQualificationCheckpoint(initial, key));
  const payload = JSON.parse(original.payload as string) as { binding: Record<string, unknown> };
  payload.binding.browserMode = "owner_manual";
  expect(() => validateNativeQualificationCheckpoint(bytes({ ...original, payload: JSON.stringify(payload) }), key)).toThrow();
});

test("fixture checkpoint bytes retain their original version, field order and HMAC domain", () => {
  for (const state of [fixture(), dispatch(fixture())]) {
    const payload = JSON.stringify({ version: 1, mode: "credential_free_fixture", binding: state.binding,
      initialOwnerEpoch: state.initialOwnerEpoch, events: state.events, failure: state.failure });
    const expected = bytes({ version: 1, payload, mac: qualificationTag(key, state.binding.runId, "receipt", payload) });
    expect(encodeQualificationCheckpoint(state, key)).toEqual(expected);
    expect(validateQualificationCheckpoint(expected, key)).toEqual(state);
    expect(restoreQualificationCheckpoint(expected, key).needsRecovery).toBe(true);
  }
});

test("native binding and checkpoint provenance cannot be read or encoded as fixtures", () => {
  const a = fixture(); const b = native();
  const aBytes = encodeQualificationCheckpoint(a, key); const bBytes = encodeNativeQualificationCheckpoint(b, key);
  expect(a.bindingTag).not.toBe(b.bindingTag);
  expect(validateNativeQualificationCheckpoint(bBytes, key)).toEqual(b);
  expect(() => createNativeQualification(binding, key, id(10))).toThrow("binding_invalid");
  expect(() => createQualification(b.binding, key, id(10))).toThrow("binding_invalid");
  expect(() => encodeNativeQualificationCheckpoint(a, key)).toThrow("invalid_input");
  expect(() => encodeQualificationCheckpoint(b, key)).toThrow();
  expect(() => validateNativeQualificationCheckpoint(aBytes, key)).toThrow("invalid_input");
  expect(() => restoreNativeQualificationCheckpoint(aBytes, key)).toThrow("invalid_input");
  expect(() => validateQualificationCheckpoint(bBytes, key)).toThrow("invalid_input");
  expect(() => restoreQualificationCheckpoint(bBytes, key)).toThrow("invalid_input");
  expect(() => encodeNativeQualificationCheckpoint({ ...a, binding: b.binding }, key)).toThrow("invalid_input");
  expect(publicQualificationReceipt(b)).toMatchObject({ syntheticSequenceComplete: false, liveQualificationProven: false, activationAuthorized: false });
});

test("native schema rejects wrong envelope, payload or binding mode even with a new valid MAC", () => {
  const state = native();
  const envelope = record(encodeNativeQualificationCheckpoint(state, key));
  if (typeof envelope.payload !== "string") throw new Error("synthetic_payload_missing");
  const payload = JSON.parse(envelope.payload) as Record<string, unknown>;
  const mutations: Record<string, unknown>[] = [
    { ...payload, version: 1 }, { ...payload, mode: "credential_free_fixture" }, { ...payload, mode: "native_process" },
    { ...payload, binding: binding }, { ...payload, binding: { ...state.binding, mode: "credential_free_fixture" } },
    { ...payload, binding: { ...state.binding, version: 1 } }, { ...payload, extra: true },
  ];
  for (const mutation of mutations) {
    const text = JSON.stringify(mutation);
    const resigned = bytes({ version: 2, payload: text, mac: qualificationTag(key, binding.runId, "native_receipt_v2", text) });
    expect(() => validateNativeQualificationCheckpoint(resigned, key)).toThrow("invalid_input");
  }
  for (const changed of [{ ...envelope, version: 1 }, { ...envelope, extra: true },
    { ...envelope, mac: qualificationTag(key, binding.runId, "receipt", envelope.payload) }]) {
    expect(() => validateNativeQualificationCheckpoint(bytes(changed), key)).toThrow("invalid_input");
  }
});

test("native restoration keeps its original attempt, mode and fresh-owner recovery requirement", () => {
  const state = dispatch(native());
  const checkpoint = encodeNativeQualificationCheckpoint(state, key);
  const restored = restoreNativeQualificationCheckpoint(checkpoint, key);
  expect(restored.binding).toEqual(state.binding);
  expect(restored.pending).toEqual(state.pending);
  expect(restored.events.slice(0, -1)).toEqual([...state.events]);
  expect(restored.events.at(-1)).toEqual({ type: "suspend", reason: "owner_lost" });
  expect(restored.needsRecovery).toBe(true);
  expect(restored.recoveryValidated).toBe(false);
  expect(publicQualificationReceipt(restored)).toMatchObject({ liveQualificationProven: false, activationAuthorized: false });
  expect(() => validateNativeQualificationCheckpoint(checkpoint, new Uint8Array(32).fill(54))).toThrow("invalid_input");
  const damaged = checkpoint.slice(); damaged[damaged.length - 5] = 0xff;
  for (const invalid of [damaged, new Uint8Array(131_073), new Uint8Array([0xff, 0xff]), bytes({ version: 2 })]) {
    expect(() => validateNativeQualificationCheckpoint(invalid, key)).toThrow("invalid_input");
  }
});

test("native journal failures cannot be hidden behind authenticated successful projections", () => {
  const initial = native();
  const failed = observeQualification(initial, { type: "settled", attemptId: id(20), result: {} });
  expect(failed.failure).toBe("invalid_input");
  expect(validateNativeQualificationCheckpoint(encodeNativeQualificationCheckpoint(failed, key), key).failure).toBe("invalid_input");
  const orderedFailure = observeQualification(initial, { type: "persisted", attemptId: id(20) });
  expect(orderedFailure.failure).toBe("order_invalid");
  expect(() => validateNativeQualificationCheckpoint(encodeNativeQualificationCheckpoint({ ...orderedFailure, failure: null }, key), key)).toThrow("invalid_input");
});
