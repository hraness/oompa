import { expect, test } from "bun:test";

import { NativeByteQueue } from "./byte-queue.ts";
import { MAX_NATIVE_OUTPUT_CHUNK_BYTES, NativeProtocolError } from "./protocol.ts";

test("a slow consumer backpressures one bounded native frame and preserves order", async () => {
  const queue = new NativeByteQueue(MAX_NATIVE_OUTPUT_CHUNK_BYTES, () => {});
  const first = new Uint8Array(MAX_NATIVE_OUTPUT_CHUNK_BYTES).fill(1);
  await queue.push(first);
  first.fill(99);
  let admitted = false;
  const pending = queue.push(new Uint8Array([2])).then(() => { admitted = true; });
  await Promise.resolve();
  expect(admitted).toBe(false);
  expect(queue.bufferedBytes).toBe(MAX_NATIVE_OUTPUT_CHUNK_BYTES);
  const reader = queue[Symbol.asyncIterator]();
  const firstResult = await reader.next();
  if (firstResult.done) throw new Error("Expected the buffered chunk.");
  expect(firstResult.value[0]).toBe(1);
  await pending;
  expect(admitted).toBe(true);
  expect((await reader.next()).value).toEqual(new Uint8Array([2]));
  queue.end();
  expect(await reader.next()).toEqual({ done: true, value: undefined });
});

test("returning after native EOF still reports discarded buffered output", async () => {
  let abandoned = 0;
  const queue = new NativeByteQueue(MAX_NATIVE_OUTPUT_CHUNK_BYTES, () => { abandoned += 1; });
  await queue.push(new Uint8Array([1]));
  queue.end();
  await queue[Symbol.asyncIterator]().return?.();
  expect(abandoned).toBe(1);
  expect(queue.nativeEofObserved).toBe(true);
  expect(queue.bufferedBytes).toBe(0);
});

test("consumer interruption unblocks native drainage without minting native EOF", async () => {
  let abandoned = 0;
  const queue = new NativeByteQueue(MAX_NATIVE_OUTPUT_CHUNK_BYTES, () => { abandoned += 1; });
  await queue.push(new Uint8Array(MAX_NATIVE_OUTPUT_CHUNK_BYTES));
  const pending = queue.push(new Uint8Array([2]));
  const reader = queue[Symbol.asyncIterator]();
  await reader.return?.();
  await pending;
  expect(queue.nativeEofObserved).toBe(false);
  expect(queue.bufferedBytes).toBe(0);
  expect(abandoned).toBe(1);
  await queue.push(new Uint8Array([3]));
  expect(queue.bufferedBytes).toBe(0);
  queue.end();
  expect(queue.nativeEofObserved).toBe(true);
  await reader.return?.();
  expect(abandoned).toBe(1);
});

test("failure releases backpressure and rejects consumers without a false EOF", async () => {
  const queue = new NativeByteQueue(MAX_NATIVE_OUTPUT_CHUNK_BYTES, () => {});
  await queue.push(new Uint8Array(MAX_NATIVE_OUTPUT_CHUNK_BYTES));
  const pending = queue.push(new Uint8Array([2]));
  const error = new Error("native transport failed");
  queue.fail(error);
  await pending;
  expect(queue.nativeEofObserved).toBe(false);
  await expect(queue[Symbol.asyncIterator]().next()).rejects.toBe(error);
  queue.end();
  expect(queue.nativeEofObserved).toBe(true);
});

test("duplicate consumers and concurrent native producers refuse", async () => {
  const queue = new NativeByteQueue(MAX_NATIVE_OUTPUT_CHUNK_BYTES, () => {});
  queue[Symbol.asyncIterator]();
  expect(() => queue[Symbol.asyncIterator]()).toThrow(NativeProtocolError);
  await queue.push(new Uint8Array(MAX_NATIVE_OUTPUT_CHUNK_BYTES));
  const pending = queue.push(new Uint8Array([2]));
  await expect(queue.push(new Uint8Array([3]))).rejects.toBeInstanceOf(NativeProtocolError);
  queue.fail(new NativeProtocolError());
  await pending;
});
