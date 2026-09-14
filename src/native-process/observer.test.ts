import { afterEach, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { NativeObservationError, observeNativeHost, observeNativeScopes } from "./observer.ts";

const context = { host: { platform: "darwin", digest: "b".repeat(64) },
  boot: { platform: "darwin", id: "12345678-1234-1234-1234-123456789012" } } as const;
const tick = async (): Promise<void> => { await new Promise<void>(resolve => { setImmediate(resolve); }); };
class Child extends EventEmitter {
  readonly commands: Uint8Array[] = [];
  readonly kills: unknown[] = [];
  readonly stdin = new Writable({ write: (bytes: Uint8Array, _encoding, done) => {
    this.commands.push(new Uint8Array(bytes)); done();
  } });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  kill(signal: unknown): boolean { this.kills.push(signal); return true; }
  response(overrides: Record<string, unknown> = {}): void {
    const request = JSON.parse(new TextDecoder().decode(this.commands[0]!.subarray(5))) as Record<string, unknown>;
    const payload = new TextEncoder().encode(JSON.stringify({ version: 1, requestId: request.requestId, context, ...overrides }));
    const frame = new Uint8Array(payload.byteLength + 5);
    frame[0] = 139; new DataView(frame.buffer).setUint32(1, payload.byteLength, false); frame.set(payload, 5);
    this.stdout.write(frame);
  }
  async closed(code = 0): Promise<void> {
    this.emit("exit", code, null);
    this.stdout.end(); this.stderr.end();
    await tick(); this.emit("close", code, null);
  }
}
const restores: Array<{ mockRestore: () => void }> = [];
afterEach(() => { for (const mock of restores.splice(0)) mock.mockRestore(); });
function fixture(): { child: Child; calls: unknown[][] } {
  const child = new Child(); const calls: unknown[][] = [];
  restores.push(spyOn(childProcess, "spawn").mockImplementation(((...args: unknown[]) => {
    calls.push(args); return child;
  }) as unknown as typeof childProcess.spawn));
  return { child, calls };
}

test("observer launches only a fixed mode with empty environment and waits for exact child/pipe close", async () => {
  const { child, calls } = fixture();
  const result = observeNativeHost({ helperExecutable: "/admitted-native" });
  let settled = false; void result.then(() => { settled = true; });
  expect(calls).toEqual([["/admitted-native", ["--host-context"], {
    cwd: "/", env: {}, shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  }]]);
  expect(child.commands[0]![0]).toBe(7);
  expect(child.stdin.writableEnded).toBe(true);
  child.response(); child.emit("exit", 0, null); await tick();
  expect(settled).toBe(false);
  await child.closed();
  expect((await result).context).toEqual(context);
  expect(child.kills).toEqual([]);
});

test("pre-aborted, invalid-deadline and malformed requests spawn nothing", async () => {
  const { calls } = fixture();
  const signal = AbortSignal.abort();
  for (const options of [
    { helperExecutable: "/admitted-native", signal },
    { helperExecutable: "relative" }, { helperExecutable: "/admitted-native", deadlineMs: 0 },
    { helperExecutable: "/admitted-native", deadlineMs: 5001 },
  ]) await expect(observeNativeHost(options)).rejects.toThrow("invalid-request");
  await expect(observeNativeScopes({ context, targets: [] }, { helperExecutable: "/admitted-native" })).rejects.toThrow("invalid-request");
  expect(calls).toHaveLength(0);
});

test("abort kills only the owned observer and successful-looking later bytes cannot recover admission", async () => {
  const { child } = fixture(); const controller = new AbortController();
  const result = observeNativeHost({ helperExecutable: "/admitted-native", signal: controller.signal });
  void result.catch(() => {});
  controller.abort(); expect(child.kills).toEqual(["SIGKILL"]);
  child.response(); await child.closed();
  await expect(result).rejects.toThrow("observation-unproved");
});

test("malformed output and private diagnostics close admission without exposing data", async () => {
  const { child } = fixture();
  const result = observeNativeHost({ helperExecutable: "/admitted-native" }); void result.catch(() => {});
  child.stderr.write("private-secret-and-path"); child.response(); await child.closed();
  const failure: unknown = await result.catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(NativeObservationError);
  expect(String(failure)).not.toContain("private-secret");
  expect(child.kills).toEqual(["SIGKILL"]);
});

test("oversized observation header refuses without allocating its body", async () => {
  const { child } = fixture();
  const result = observeNativeHost({ helperExecutable: "/admitted-native" }); void result.catch(() => {});
  child.stdout.write(new Uint8Array([139, 255, 255, 255, 255]));
  expect(child.kills).toEqual(["SIGKILL"]); await child.closed();
  await expect(result).rejects.toThrow("observation-unproved");
});

test("nonzero exit invalidates a complete response", async () => {
  const { child } = fixture();
  const result = observeNativeHost({ helperExecutable: "/admitted-native" }); void result.catch(() => {});
  child.response(); await child.closed(1);
  await expect(result).rejects.toThrow("observation-unproved");
});

test("a missing close has an independent bound and never claims joined observation", async () => {
  const { child } = fixture();
  const result = observeNativeHost({ helperExecutable: "/admitted-native", deadlineMs: 1 });
  void result.catch(() => {});
  await expect(result).rejects.toThrow("cleanup-unproven");
  expect(child.kills).toEqual(["SIGKILL"]);
  await child.closed(1);
});
