import { expect, expectTypeOf, test } from "bun:test";
import fc from "fast-check";

import {
  providerProcessWriteResult, sameProviderProcessBinding, snapshotProviderProcessBinding,
  type ProviderProcessPort,
} from "./process-port.ts";
import type { NativeProcessTransport } from "./transport.ts";

test("native transport implements the neutral port without product authority types", () => {
  expectTypeOf<NativeProcessTransport>().toMatchTypeOf<ProviderProcessPort>();
});

test("binding snapshots remove foreign receipt fields and resist caller mutation", () => {
  const input = { version: 1, nonce: "a".repeat(32), scope: "posix-process-group", account: "private" };
  const binding = snapshotProviderProcessBinding(input);
  input.nonce = "b".repeat(32);
  expect(binding).toEqual({ version: 1, nonce: "a".repeat(32), scope: "posix-process-group" });
  expect(Object.isFrozen(binding)).toBe(true);
  expect(sameProviderProcessBinding(binding, snapshotProviderProcessBinding({ ...binding }))).toBe(true);
  expect(sameProviderProcessBinding(binding, snapshotProviderProcessBinding(input))).toBe(false);
  expect(sameProviderProcessBinding(binding, { ...binding, scope: "windows-job" })).toBe(false);
  for (const value of [null, [], { ...binding, version: 2 }, { ...binding, nonce: "A".repeat(32) },
    { ...binding, nonce: "a".repeat(31) }, { ...binding, scope: "unknown" }]) {
    expect(() => snapshotProviderProcessBinding(value)).toThrow("PROVIDER_PROCESS_BINDING_INVALID");
  }
});

test("write validation preserves every accepted byte prefix and never infers RPC success", () => {
  fc.assert(fc.property(fc.integer({ min: 2, max: 64 * 1024 * 1024 }), length => {
    for (const value of [
      { outcome: "accepted-full", acceptedBytes: length },
      { outcome: "refused-before-write", acceptedBytes: 0 },
      { outcome: "partial-known", acceptedBytes: length - 1 },
      { outcome: "indeterminate", acceptedBytes: 0 },
      { outcome: "indeterminate", acceptedBytes: length },
    ] as const) {
      const result = providerProcessWriteResult({ ...value, id: 7, receipt: "private" }, length);
      expect(result).toEqual(value);
      expect(Object.isFrozen(result)).toBe(true);
    }
    for (const value of [
      { outcome: "accepted-full", acceptedBytes: length - 1 },
      { outcome: "refused-before-write", acceptedBytes: 1 },
      { outcome: "partial-known", acceptedBytes: 0 },
      { outcome: "partial-known", acceptedBytes: length },
      { outcome: "indeterminate", acceptedBytes: length + 1 },
      { outcome: "indeterminate", acceptedBytes: -1 },
      { outcome: "indeterminate", acceptedBytes: 0.5 },
      { outcome: "rpc-succeeded", acceptedBytes: length },
    ]) expect(() => providerProcessWriteResult(value, length)).toThrow("PROVIDER_PROCESS_WRITE_RESULT_INVALID");
  }), { numRuns: 100 });
});

test("the provider adapter validator refuses empty and nonintegral write lengths", () => {
  for (const length of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => providerProcessWriteResult({ outcome: "accepted-full", acceptedBytes: length }, length)).toThrow();
  }
  for (const value of [null, [], {}, { outcome: "accepted-full" }, { acceptedBytes: 1 }]) {
    expect(() => providerProcessWriteResult(value, 1)).toThrow();
  }
});
