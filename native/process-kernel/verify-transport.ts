import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NativeProcessTransport } from "../../packages/native-process/src/transport.ts";
import type { nativePreparedOfReady } from "../../packages/native-process/src/identity.ts";
import type { observeNativeHost, observeNativeScopes } from "../../packages/native-process/src/observer.ts";
import type { nativeScopeIsAbsent } from "../../packages/native-process/src/observation-protocol.ts";

type VerifierHandle = Pick<NativeProcessTransport, "ready" | "rootExited" | "joined" | "transportCompleted"
  | "stdout" | "stderr" | "write" | "closeInput" | "requestStop">;
export type NativeTransportVerificationPort = Readonly<{
  create: (options: ConstructorParameters<typeof NativeProcessTransport>[0]) => VerifierHandle;
  host: typeof observeNativeHost;
  scopes: typeof observeNativeScopes;
  preparedOfReady: typeof nativePreparedOfReady;
  scopeIsAbsent: typeof nativeScopeIsAbsent;
}>;

/** Invoke with installed package exports to qualify the released host code.
 * The fixture owns its complete output and physical join after every case. */
export async function verifyNativeTransport(input: Readonly<{
  helperExecutable: () => string; fixtureExecutable: string; cwd: string;
  port: NativeTransportVerificationPort;
}>): Promise<Readonly<{ status: "passed"; platform: string; cases: readonly string[]; helperSha256: string; fixtureSha256: string }>> {
const helper = input.helperExecutable();
const fixture = input.fixtureExecutable;
const directory = input.cwd;
const digest = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const before = [digest(helper), digest(fixture)] as const;
const results: string[] = [];
const collect = async (stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> => {
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.byteLength;
    assert(bytes <= 4 * 1024 * 1024, "Fixture output exceeded its bound.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};
function launch(mode: string, refusePrepare = false): VerifierHandle {
  let prepared = false;
  return input.port.create({ helperExecutable: input.helperExecutable(),
    launch: { version: 1, nonce: randomBytes(16).toString("hex"), scope: "posix-process-group",
      argv: [fixture, mode], cwd: directory, environment: {}, termGraceMs: 50, settlementMs: 2000, writeTimeoutMs: 2000 },
    onPrepared: async () => {
      if (refusePrepare) throw new Error("Fixture rejects pre-execution admission.");
      prepared = true;
    },
    beforeActivate: () => { assert(prepared); },
    onReady: async () => { assert(prepared); },
  });
}
async function verify(mode: string, check: (handle: VerifierHandle) => Promise<void>, refusePrepare = false): Promise<void> {
  const handle = launch(mode, refusePrepare);
  try { await check(handle); results.push(mode + (refusePrepare ? "-prepare-refused" : "")); }
  finally {
    // Keep the exact owner until the native terminal and helper collection are
    // observed. Do not signal serialized PIDs or mistake a timer for cleanup.
    handle.requestStop();
    await handle.joined;
  }
}
await verify("echo", async handle => {
  const output = collect(handle.stdout);
  const diagnostics = collect(handle.stderr);
  void output.catch(() => {}); void diagnostics.catch(() => {});
  await handle.ready;
  const bytes = Uint8Array.from({ length: 200_003 }, (_, index) => index % 251);
  assert.deepEqual(await handle.write(bytes), { id: 1, outcome: "accepted-full", acceptedBytes: bytes.length });
  await handle.closeInput();
  assert.deepEqual(new Uint8Array(await output), bytes);
  assert.equal((await diagnostics).length, 0);
  assert.equal((await handle.rootExited).code, 0);
  assert.equal((await handle.joined).kind, "joined");
  await handle.transportCompleted;
});
await verify("pressure", async handle => {
  const output = collect(handle.stdout);
  const diagnostics = collect(handle.stderr);
  void output.catch(() => {}); void diagnostics.catch(() => {});
  const [stdout, stderr] = await Promise.all([output, diagnostics]);
  assert.equal(stdout.length, 2 * 1024 * 1024);
  assert.equal(stderr.length, 2 * 1024 * 1024);
  assert(stdout.every(byte => byte === 0x83));
  assert(stderr.every(byte => byte === 0x91));
  assert.equal((await handle.joined).kind, "joined");
  await handle.transportCompleted;
});
await verify("block-input", async handle => {
  await handle.ready;
  const write = handle.write(new Uint8Array(4 * 1024 * 1024).fill(7));
  const stop = setTimeout(() => { handle.requestStop(); }, 20);
  try {
    const result = await write;
    assert.notEqual(result.outcome, "accepted-full");
    assert(result.acceptedBytes < 4 * 1024 * 1024);
    assert.equal((await handle.joined).kind, "joined");
    await assert.rejects(handle.transportCompleted);
  } finally { clearTimeout(stop); }
});
await verify("echo", async handle => {
  await assert.rejects(handle.ready, /admission-failed/u);
  const settlement = await handle.joined;
  assert.equal(settlement.kind, "not-started");
  assert.notEqual(settlement.prepared, null);
  assert.equal(settlement.ready, null);
}, true);
const observedHost = await input.port.host({ helperExecutable: input.helperExecutable() });
assert.deepEqual((await input.port.host({ helperExecutable: input.helperExecutable() })).context, observedHost.context);
const observedProcess = launch("echo");
try {
  const ready = await observedProcess.ready;
  assert.deepEqual(ready.boot, observedHost.context.boot);
  const targets = [{ nonce: ready.nonce, bindingDigest: "a".repeat(64), expectedRevision: 4,
    prepared: input.port.preparedOfReady(ready), ready }];
  const live = await input.port.scopes({ context: observedHost.context, targets }, { helperExecutable: input.helperExecutable() });
  assert.equal(live.relation, "same-boot");
  const liveTarget = live.targets[0];
  assert(liveTarget !== undefined);
  assert.equal(liveTarget.supervisor, "same-process-present");
  assert.equal(liveTarget.anchor, "same-process-present");
  assert.equal(liveTarget.root, "same-process-present");
  assert.equal(liveTarget.group, "present");
  assert.equal(input.port.scopeIsAbsent(live, 0), false);
  const foreign = await input.port.scopes({ context: { ...observedHost.context,
    host: { ...observedHost.context.host, digest: "0".repeat(64) } }, targets }, { helperExecutable: input.helperExecutable() });
  assert.equal(foreign.relation, "foreign-host");
  const foreignTarget = foreign.targets[0];
  assert(foreignTarget !== undefined);
  assert.equal(foreignTarget.supervisor, "unknown");
  assert.equal(foreignTarget.group, "unknown");
  observedProcess.requestStop();
  await observedProcess.joined;
  const retired = await input.port.scopes({ context: observedHost.context, targets }, { helperExecutable: input.helperExecutable() });
  assert(input.port.scopeIsAbsent(retired, 0));
  results.push("observe-live-foreign-and-joined");
} finally { observedProcess.requestStop(); await observedProcess.joined; }
assert.deepEqual([digest(helper), digest(fixture)], before);
return { status: "passed", platform: process.platform, cases: results, helperSha256: before[0], fixtureSha256: before[1] };
}
