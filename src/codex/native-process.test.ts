import { expect, test } from "bun:test";
import type { NativeReady } from "../domain/native-process-identity.ts";
import type { NativeRootExit, NativeWriteResult } from "../native-process/protocol.ts";
import { readyNativeCodexProcess } from "./native-process.ts";

type Owner = Parameters<typeof readyNativeCodexProcess>[0];
const emptyBytes: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
};
function fakeOwner(ready: Promise<NativeReady>, overrides: Partial<Owner> = {}): Owner {
  void ready.catch(() => {});
  return { ready, rootExited: new Promise<NativeRootExit>(() => {}), stdout: emptyBytes, stderr: emptyBytes,
    write: async bytes => ({ id: 1, outcome: "accepted-full", acceptedBytes: bytes.byteLength }),
    requestStop: () => {}, forceStop: () => {}, releaseCustody: async () => {}, stopAndRelease: async () => {}, ...overrides,
  };
}

test("pre-Ready refusal releases exact custody without awaiting or inventing a root exit", async () => {
  const failure = Error("synthetic activation refused");
  const owner = fakeOwner(Promise.reject(failure)); let released = false;
  owner.stopAndRelease = async () => { released = true; };
  await expect(readyNativeCodexProcess(owner)).rejects.toBe(failure);
  expect(released).toBe(true);
});

test("pre-Ready failure keeps failed cleanup and original launch failure visible", async () => {
  const failure = Error("synthetic launch failure"); const cleanup = Error("synthetic unknown scope");
  const owner = fakeOwner(Promise.reject(failure)); owner.stopAndRelease = async () => { throw cleanup; };
  const error = await readyNativeCodexProcess(owner).catch((value: unknown) => value);
  expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual([failure, cleanup]);
});

test("ready adapter preserves root observation, explicit write outcomes and separate custody", async () => {
  const identity = (pid: number) => ({ pid, birth: { kind: "darwin-start-time", seconds: "123", micros: 0 } } as const);
  const owner = fakeOwner(Promise.resolve({ version: 1, nonce: "a".repeat(32), scope: "posix-process-group",
    boot: { platform: "darwin", id: "12345678-1234-1234-1234-123456789012" },
    supervisor: identity(101), anchor: identity(102), groupId: 102, pid: 103, root: identity(103) }),
  { rootExited: Promise.resolve({ code: null, signal: 15 }) });
  let outcome: NativeWriteResult["outcome"] = "accepted-full"; let joins = 0;
  owner.write = async bytes => ({ id: 1, outcome, acceptedBytes: outcome === "accepted-full" ? bytes.byteLength : 0 });
  owner.releaseCustody = async () => { joins += 1; };
  const child = await readyNativeCodexProcess(owner);
  expect(await child.exited).toBe(143); expect(joins).toBe(0);
  await child.write(new Uint8Array([1]));
  outcome = "indeterminate";
  await expect(child.write(new Uint8Array([1]))).rejects.toMatchObject({ code: "PROCESS_EXITED" });
  await child.joinCustody?.(); expect(joins).toBe(1);
});
