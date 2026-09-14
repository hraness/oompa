import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { NativeCommandKind, NativeEventKind, encodeNativeFrame, type NativeReady, type NativePrepared } from "./protocol.ts";
import { NativeProcessTransport, type NativeProcessOptions } from "./transport.ts";

// A pure pipe/child model for hostile or delayed native evidence. Actual OS
// containment is exercised separately by the native suite and real adapter tests.
class Child extends EventEmitter {
  readonly pid = 11;
  readonly commands: Uint8Array[] = [];
  readonly stdin = new Writable({ write: (chunk: Uint8Array, _encoding, done) => {
    this.commands.push(new Uint8Array(chunk)); done();
  } });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  event(kind: number, value: unknown): void { this.raw(kind, new TextEncoder().encode(JSON.stringify(value))); }
  raw(kind: number, bytes: Uint8Array): void { this.stdout.write(encodeNativeFrame(kind, bytes, "events")); }
  closed(code = 0): void {
    this.emit("exit", code, null);
    this.stdout.end(); this.stderr.end();
    this.emit("close", code, null);
  }
  joined(): void {
    this.event(NativeEventKind.rootExit, { code: 0, signal: null });
    for (const stream of [1, 2, 3]) this.raw(NativeEventKind.streamEnd, new Uint8Array([stream]));
    this.event(NativeEventKind.joined, binding);
    this.closed();
  }
}
const binding = { version: 1, nonce: "0123456789abcdef0123456789abcdef", scope: "posix-process-group" } as const;
const identity = (pid: number) => ({ pid, birth: { kind: "darwin-start-time", seconds: "1", micros: 1 } } as const);
const prepared: NativePrepared = { ...binding, groupId: 12,
  boot: { platform: "darwin", id: "12345678-1234-1234-1234-123456789012" }, supervisor: identity(11), anchor: identity(12) };
const ready: NativeReady = { ...prepared, pid: 13, root: identity(13) };
const tick = async (): Promise<void> => { await new Promise<void>(resolve => { setImmediate(resolve); }); };
const mocks: Array<{ mockRestore: () => void }> = [];
const handles: Array<{ child: Child; handle: NativeProcessTransport }> = [];
afterEach(async () => {
  for (const { child, handle } of handles.splice(0)) { handle.forceStop(); child.closed(1); }
  await tick();
  for (const mock of mocks.splice(0)) mock.mockRestore();
});
function start(overrides: Partial<NativeProcessOptions> = {}): { child: Child; handle: NativeProcessTransport } {
  const child = new Child();
  const spawn = (() => child) as unknown as typeof childProcess.spawn;
  mocks.push(spyOn(childProcess, "spawn").mockImplementation(spawn));
  const handle = new NativeProcessTransport({
    helperExecutable: "/fixture-helper",
    launch: { ...binding, argv: ["/fixture"], cwd: "/fixture-root", environment: {}, termGraceMs: 1, settlementMs: 1, writeTimeoutMs: 1 },
    onPrepared: async () => {}, beforeActivate: () => {}, onReady: async () => {}, ...overrides,
  });
  handles.push({ child, handle });
  return { child, handle };
}
async function started(overrides: Partial<NativeProcessOptions> = {}): Promise<ReturnType<typeof start>> {
  const pair = start(overrides);
  pair.child.event(NativeEventKind.prepared, prepared); await tick();
  pair.child.event(NativeEventKind.ready, ready); await pair.handle.ready;
  return pair;
}

test("prepared identity commits before Activate and Ready commits before writes", async () => {
  let persistPrepared: () => void = () => {};
  let persistReady: () => void = () => {};
  let authorityChecks = 0;
  const { child, handle } = start({
    onPrepared: () => new Promise(resolve => { persistPrepared = resolve; }),
    beforeActivate: () => { authorityChecks += 1; },
    onReady: () => new Promise(resolve => { persistReady = resolve; }),
  });
  child.event(NativeEventKind.prepared, prepared); await tick();
  expect(child.commands.map(frame => frame[0])).toEqual([NativeCommandKind.launch]);
  await expect(handle.write(new Uint8Array([1]))).rejects.toThrow("not-ready");
  persistPrepared(); await tick();
  expect(authorityChecks).toBe(1);
  expect(child.commands.map(frame => frame[0])).toEqual([NativeCommandKind.launch, NativeCommandKind.activate]);
  child.event(NativeEventKind.ready, ready); await tick();
  await expect(handle.write(new Uint8Array([1]))).rejects.toThrow("not-writable");
  persistReady(); await handle.ready;
  const written = handle.write(new Uint8Array([2]));
  child.event(NativeEventKind.writeResult, { id: 1, outcome: "accepted-full", acceptedBytes: 1 });
  expect((await written).outcome).toBe("accepted-full");
  child.joined();
  expect((await handle.joined).kind).toBe("joined");
});

test("operation failure remains observable after independently proven join", async () => {
  const { child, handle } = await started();
  const stdout = handle.stdout[Symbol.asyncIterator]().next();
  const stderr = handle.stderr[Symbol.asyncIterator]().next();
  void stdout.catch(() => {});
  void stderr.catch(() => {});
  child.event(NativeEventKind.failure, { reason: "output-failed" }); child.joined();
  await expect(stdout).rejects.toThrow("output-failed");
  await expect(stderr).rejects.toThrow("output-failed");
  await expect(handle.transportCompleted).rejects.toThrow("output-failed");
  expect((await handle.joined).kind).toBe("joined");
});

test("helper exit bounds a pump blocked behind an unconsumed stream", async () => {
  const { child, handle } = await started();
  for (let index = 0; index < 17; index += 1) child.raw(NativeEventKind.stdout, new Uint8Array(65_536));
  child.joined();
  await expect(handle.joined).rejects.toThrow("cleanup-unproven");
  await expect(handle.transportCompleted).rejects.toThrow();
});

test("host write deadline reports unknown acceptance while a helper is unresponsive", async () => {
  const { child, handle } = await started();
  expect(await handle.write(new Uint8Array([7]))).toEqual({ id: 1, outcome: "indeterminate", acceptedBytes: 0 });
  expect(child.stdin.destroyed).toBe(true);
  await expect(handle.write(new Uint8Array([7]))).rejects.toThrow("not-writable");
  child.event(NativeEventKind.writeResult, { id: 1, outcome: "accepted-full", acceptedBytes: 1 });
  child.joined();
  expect((await handle.joined).kind).toBe("joined");
  await expect(handle.transportCompleted).rejects.toThrow("deadline");
});

test("no-start refuses any provider output or stream evidence", async () => {
  for (const kind of [NativeEventKind.stdout, NativeEventKind.streamEnd]) {
    const { child, handle } = start();
    child.event(NativeEventKind.prepared, prepared); await tick();
    child.raw(kind, new Uint8Array([1]));
    child.event(NativeEventKind.notStarted, binding); child.closed();
    await expect(handle.joined).rejects.toThrow("cleanup-unproven");
  }
});

test("native EOF settles an unacknowledged write as unknown while preserving physical join", async () => {
  const { child, handle } = await started();
  const result = handle.write(new Uint8Array([1, 2, 3]));
  handle.requestStop();
  child.joined();
  expect(await result).toEqual({ id: 1, outcome: "indeterminate", acceptedBytes: 0 });
  expect((await handle.joined).kind).toBe("joined");
  await expect(handle.transportCompleted).rejects.toThrow();
});

test("a forged supervisor pid cannot activate or release an invocation", async () => {
  const { child, handle } = start();
  child.event(NativeEventKind.prepared, { ...prepared, supervisor: identity(99) });
  child.event(NativeEventKind.notStarted, binding); child.closed();
  await expect(handle.joined).rejects.toThrow("cleanup-unproven");
  expect(child.commands.map(frame => frame[0])).toEqual([NativeCommandKind.launch]);
});

test("a no-start terminal still requires bounded helper completion", async () => {
  const { child, handle } = start();
  child.event(NativeEventKind.notStarted, binding);
  await expect(handle.joined).rejects.toThrow("cleanup-unproven");
  expect(child.stdin.destroyed).toBe(true);
});

test("slow persistence cannot hide helper exit or activate a retired scope", async () => {
  let persist: () => void = () => {};
  const { child, handle } = start({ onPrepared: () => new Promise(resolve => { persist = resolve; }) });
  child.event(NativeEventKind.prepared, prepared); await tick();
  child.event(NativeEventKind.notStarted, binding); child.closed();
  expect((await handle.joined).kind).toBe("not-started");
  persist(); await tick();
  expect(child.commands.map(frame => frame[0])).toEqual([NativeCommandKind.launch]);
});

test("a Ready commit that completes after root exit cannot reopen writes", async () => {
  let persist: () => void = () => {};
  const { child, handle } = start({ onReady: () => new Promise(resolve => { persist = resolve; }) });
  child.event(NativeEventKind.prepared, prepared); await tick();
  child.event(NativeEventKind.ready, ready); await tick();
  child.event(NativeEventKind.rootExit, { code: 0, signal: null }); await tick();
  persist();
  await expect(handle.ready).rejects.toThrow("not-writable");
  await expect(handle.write(new Uint8Array([7]))).rejects.toThrow("not-writable");
});

test("a failed authority commit still allows independent no-start cleanup proof", async () => {
  const { child, handle } = start({ onPrepared: async () => { throw new Error("private database detail"); } });
  child.event(NativeEventKind.prepared, prepared); await tick();
  child.event(NativeEventKind.notStarted, binding); child.closed();
  await expect(handle.ready).rejects.toThrow("admission-failed");
  expect((await handle.joined).kind).toBe("not-started");
  expect(child.commands.map(frame => frame[0])).toEqual([NativeCommandKind.launch]);
});

test("join during unresolved Ready persistence cannot report operation success", async () => {
  let reject: (error: unknown) => void = () => {};
  const { child, handle } = start({ onReady: () => new Promise((_resolve, refuse) => { reject = refuse; }) });
  child.event(NativeEventKind.prepared, prepared); await tick();
  child.event(NativeEventKind.ready, ready); await tick();
  child.joined();
  expect((await handle.joined).kind).toBe("joined");
  await expect(handle.transportCompleted).rejects.toThrow("admission-failed");
  reject(new Error("private persistence failure")); await tick();
  await expect(handle.ready).rejects.toThrow("admission-failed");
});

test("physical join does not claim delivery of output still buffered for a consumer", async () => {
  const { child, handle } = await started();
  child.raw(NativeEventKind.stdout, new Uint8Array([1])); child.joined();
  await handle.joined;
  let complete = false;
  void handle.transportCompleted.then(() => { complete = true; }, () => {});
  await tick(); expect(complete).toBe(false);
  await handle.stdout[Symbol.asyncIterator]().return?.();
  await expect(handle.transportCompleted).rejects.toThrow();
});
