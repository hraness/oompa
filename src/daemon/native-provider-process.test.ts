import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NativeHostContext, NativePrepared, NativeReady } from "../domain/native-process-identity.ts";
import type { NativeRootExit, NativeWriteResult } from "../native-process/protocol.ts";
import type { NativeCustodySettlement, NativeProcessOptions } from "../native-process/transport.ts";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths.ts";
import { StateStore } from "../storage/state-store.ts";
import { DaemonAuthorityFence, DaemonLock } from "./daemon-lock.ts";
import { NativeProviderProcess, type NativeProviderProcessOptions } from "./native-provider-process.ts";

const context: NativeHostContext = { host: { platform: "darwin", digest: "b".repeat(64) },
  boot: { platform: "darwin", id: "12345678-1234-1234-1234-123456789012" } };
const identity = (pid: number) => ({ pid, birth: { kind: "darwin-start-time", seconds: "123", micros: 0 } } as const);
const emptyBytes: AsyncIterable<Uint8Array> = {
  [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
};
function latch<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-native-live-composer-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const lock = await DaemonLock.acquire(paths); const store = new StateStore(paths);
  disposals.push(async () => { store.close(); await lock.release(); await rm(home, { recursive: true, force: true }); });
  const bootId = `boot_${"a".repeat(32)}`;
  const generation = store.nextDaemonGeneration(bootId);
  await lock.publish({ state: "ready", generation, bootId });
  const fence = new DaemonAuthorityFence(lock, { generation, bootId });
  const profile = store.createProfile("Synthetic native process");
  const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
  if (providerAuthority.provider !== "codex") throw Error("fixture requires Codex authority");
  const ready = latch<NativeReady>(); const root = latch<NativeRootExit>(); const joined = latch<NativeCustodySettlement>();
  let callbacks!: NativeProcessOptions;
  let writes = 0; let stops = 0; let forced = 0;
  const options: NativeProviderProcessOptions = { store, lock, fence, helperExecutable: () => "/synthetic-admitted",
    reservation: { providerAuthority, profileGeneration: profile.processGeneration, runtimeScope: "managed",
      artifactDigest: "c".repeat(64), runtimeDigest: "d".repeat(64) },
    launch: { version: 1, scope: "posix-process-group", argv: ["/synthetic-provider"], cwd: home,
      environment: {}, termGraceMs: 100, settlementMs: 100, writeTimeoutMs: 100 },
    observeHost: async () => ({ version: 1, requestId: "e".repeat(32), context }),
    transportFactory: input => {
      callbacks = input;
      expect(store.listUnreleasedProviderProcessInvocations()).toHaveLength(1);
      expect(store.listUnreleasedProviderProcessInvocations()[0]?.state).toBe("reserved");
      return { ready: ready.promise, rootExited: root.promise, joined: joined.promise,
        transportCompleted: Promise.resolve(undefined), stdout: emptyBytes, stderr: emptyBytes,
        write: async bytes => { writes += 1; return { id: writes, outcome: "accepted-full", acceptedBytes: bytes.byteLength } as NativeWriteResult; },
        closeInput: async () => {}, requestStop: () => { stops += 1; }, forceStop: () => { forced += 1; },
      };
    },
  };
  const process = await NativeProviderProcess.launch(options);
  const prepared: NativePrepared = { version: 1, nonce: callbacks.launch.nonce, scope: "posix-process-group",
    boot: context.boot, groupId: 102, supervisor: identity(101), anchor: identity(102) };
  const running: NativeReady = { ...prepared, pid: 103, root: identity(103) };
  const row = () => store.readProviderProcessInvocation(prepared.nonce)!;
  const prepare = async () => { await callbacks.onPrepared(prepared); };
  const activate = async () => { callbacks.beforeActivate(); await callbacks.onReady(running); ready.resolve(running); };
  const finish = (started: boolean) => {
    if (started) root.resolve({ code: 0, signal: null });
    joined.resolve({ kind: started ? "joined" : "not-started",
      binding: { version: 1, nonce: prepared.nonce, scope: "posix-process-group" }, prepared, ready: started ? running : null });
  };
  return { process, store, fence, row, prepare, activate, finish, callbacks,
    counts: () => ({ writes, stops, forced }) };
}

test("actual journal gates activation and writes, then keeps custody until native scope closure", async () => {
  const f = await fixture();
  expect(() => f.callbacks.beforeActivate()).toThrow("CUSTODY_STALE");
  await f.prepare(); expect(f.row().state).toBe("prepared");
  await f.activate(); expect(f.row().state).toBe("running");
  expect((await f.process.write(new Uint8Array([1, 2]))).outcome).toBe("accepted-full");
  const stopped = f.process.stopAndRelease();
  expect(f.row().state).toBe("running"); expect(f.counts().stops).toBe(1);
  f.finish(true); await stopped;
  expect(f.row().state).toBe("released"); expect(f.row().releaseEvidence?.kind).toBe("native-settled");
});

test("closing daemon authority refuses the next write and stops the owned scope without requiring authority to release", async () => {
  const f = await fixture(); await f.prepare(); await f.activate(); f.fence.close();
  await expect(f.process.write(new Uint8Array([1]))).rejects.toThrow("closed");
  expect(f.counts()).toEqual({ writes: 0, stops: 0, forced: 1 });
  f.finish(true); await f.process.releaseCustody(); expect(f.row().state).toBe("released");
});

for (const stage of ["prepareProviderProcessInvocation", "markProviderProcessInvocationRunning",
  "beginProviderProcessInvocationRelease", "releaseProviderProcessInvocation"] as const) {
  test(`cleanup reconciles ${stage} committing before its caller sees failure`, async () => {
    const f = await fixture(); const original = f.store[stage].bind(f.store);
    let once = true;
    // Each method retains its exact production implementation; the injected
    // fault only hides a successful return after SQLite committed it.
    const spy = spyOn(f.store, stage).mockImplementation((input: Parameters<StateStore[typeof stage]>[0]) => {
      const result = original(input as never);
      if (once) { once = false; throw Error("synthetic lost commit acknowledgement"); }
      return result;
    });
    try {
      if (stage === "prepareProviderProcessInvocation") {
        await expect(f.prepare()).rejects.toThrow("lost commit acknowledgement");
        f.finish(false); await f.process.releaseCustody();
      } else {
        await f.prepare();
        if (stage === "markProviderProcessInvocationRunning") {
          await expect(f.activate()).rejects.toThrow("lost commit acknowledgement");
          f.finish(true); await f.process.releaseCustody();
        } else {
          await f.activate(); f.finish(true);
          await expect(f.process.releaseCustody()).rejects.toThrow("lost commit acknowledgement");
          await f.process.releaseCustody();
        }
      }
      expect(f.row().state).toBe("released");
      expect(f.row().releaseEvidence?.kind).toBe("native-settled");
    } finally { spy.mockRestore(); }
  });
}
