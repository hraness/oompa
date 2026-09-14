import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NativeHostContext, NativePrepared } from "../domain/native-process-identity.ts";
import type { ProviderProcessInvocation } from "../domain/provider-process-custody.ts";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths.ts";
import { StateStore } from "../storage/state-store.ts";
import { DaemonLock } from "./daemon-lock.ts";
import { recoverNativeProviderProcessPass } from "./native-process-recovery.ts";

type ObservationPort = NonNullable<Parameters<typeof recoverNativeProviderProcessPass>[0]["observations"]>;
const context: NativeHostContext = { host: { platform: "darwin", digest: "b".repeat(64) },
  boot: { platform: "darwin", id: "12345678-1234-1234-1234-123456789012" } };
const identity = (pid: number) => ({ pid, birth: { kind: "darwin-start-time", seconds: "123", micros: 0 } } as const);
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });
async function fixture(now?: () => number) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-native-recovery-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const lock = await DaemonLock.acquire(paths);
  const store = new StateStore(paths, now === undefined ? {} : { now });
  disposals.push(async () => { store.close(); await lock.release(); await rm(home, { recursive: true, force: true }); });
  const daemon = { daemonGeneration: store.nextDaemonGeneration(`boot_${"a".repeat(32)}`), bootId: `boot_${"a".repeat(32)}` };
  let ordinal = 0;
  function reserve(stage: "reserved" | "prepared" | "running" = "reserved"): ProviderProcessInvocation {
    ordinal += 1;
    const profile = store.createProfile(`Synthetic native recovery ${String(ordinal)}`);
    const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
    if (providerAuthority.provider !== "codex") throw new Error("Synthetic fixture requires Codex authority.");
    let row = store.reserveProviderProcessInvocation({ nonce: ordinal.toString(16).padStart(32, "0"),
      providerAuthority, profileGeneration: profile.processGeneration,
      runtimeScope: "managed", daemon, artifactDigest: "c".repeat(64), runtimeDigest: "d".repeat(64),
      launchContext: { ...context, localFiles: { authority: lock.nativeFileIdentity(), state: store.nativeFileIdentity() } } });
    if (stage !== "reserved") {
      const prepared: NativePrepared = { version: 1, nonce: row.nonce, scope: "posix-process-group",
        boot: context.boot, groupId: 102, supervisor: identity(101), anchor: identity(102) };
      row = store.prepareProviderProcessInvocation({ nonce: row.nonce, expectedRevision: row.revision, daemon, prepared });
      if (stage === "running") row = store.markProviderProcessInvocationRunning({ nonce: row.nonce,
        expectedRevision: row.revision, daemon, ready: { ...prepared, pid: 103, root: identity(103) } });
    }
    return row;
  }
  return { store, lock, reserve, daemon };
}

/** Only the native observation port is simulated. Lock authority, persistence,
 * compare-and-swap and generation barriers use the real product owners. */
function observations(options: { host?: NativeHostContext; unknown?: string; duringHost?: () => void; duringScopes?: () => void } = {}) {
  const batches: number[] = [];
  const port: ObservationPort = {
    host: async () => { options.duringHost?.(); return { version: 1, requestId: "e".repeat(32), context: options.host ?? context }; },
    scopes: async input => {
      options.duringScopes?.(); batches.push(input.targets.length);
      return { version: 1, requestId: "f".repeat(32), context, relation: "same-boot",
        targets: input.targets.map(target => ({ nonce: target.nonce, bindingDigest: target.bindingDigest,
          expectedRevision: target.expectedRevision, supervisor: target.nonce === options.unknown ? "unknown" : "original-absent",
          anchor: "original-absent", root: target.ready === null ? null : "original-absent", group: "absent" })) };
    },
  };
  return { port, batches };
}

test("startup recovery retains exact logical and native evidence before advancing generations", async () => {
  const f = await fixture(); const reserved = f.reserve(); const prepared = f.reserve("prepared"); const running = f.reserve("running");
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const native = observations();
  expect(() => f.store.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toThrow("PROVIDER_PROCESS_CUSTODY_BLOCKED");
  expect(await recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted", observations: native.port }))
    .toEqual({ released: 3, remaining: 0 });
  expect(f.store.readProviderProcessInvocation(reserved.nonce)?.releaseEvidence?.kind).toBe("activation-never-admitted");
  expect(f.store.readProviderProcessInvocation(prepared.nonce)?.releaseEvidence?.kind).toBe("scope-absent");
  expect(f.store.readProviderProcessInvocation(running.nonce)?.releaseEvidence?.kind).toBe("scope-absent");
  expect(native.batches).toEqual([2]);
  expect(f.store.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toBe(2);
  await expect(authority.assertCurrent()).rejects.toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
});

test("unknown supervisor keeps its writer barrier while proven independent scopes recover", async () => {
  const f = await fixture(); const first = f.reserve("prepared"); const second = f.reserve("running");
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const native = observations({ unknown: second.nonce });
  expect(await recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted", observations: native.port }))
    .toEqual({ released: 1, remaining: 1 });
  expect(f.store.readProviderProcessInvocation(first.nonce)?.state).toBe("released");
  expect(f.store.readProviderProcessInvocation(second.nonce)).toEqual(second);
  expect(() => f.store.nextDaemonGeneration(`boot_${"e".repeat(32)}`)).toThrow("PROVIDER_PROCESS_CUSTODY_BLOCKED");
});

test("same-host OS reboot releases reserved and prepared prefixes without old-PID probes", async () => {
  const f = await fixture(); const first = f.reserve(); const second = f.reserve("prepared");
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const native = observations({ host: { ...context, boot: { ...context.boot, id: "00000000-0000-0000-0000-000000000000" } } });
  expect(await recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted", observations: native.port }))
    .toEqual({ released: 2, remaining: 0 });
  expect(native.batches).toEqual([]);
  for (const row of [first, second]) expect(f.store.readProviderProcessInvocation(row.nonce)?.releaseEvidence?.kind).toBe("boot-ended");
});

test("foreign host does not turn a different OS boot into local recovery proof", async () => {
  const f = await fixture(); const row = f.reserve("running");
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const native = observations({ host: { host: { platform: "darwin", digest: "f".repeat(64) },
    boot: { ...context.boot, id: "00000000-0000-0000-0000-000000000000" } } });
  expect(await recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted", observations: native.port }))
    .toEqual({ released: 0, remaining: 1 });
  expect(f.store.readProviderProcessInvocation(row.nonce)).toEqual(row); expect(native.batches).toEqual([]);
});

test("wall-clock rollback cannot strand otherwise proven startup recovery", async () => {
  let wall = Date.now() + 60_000;
  const f = await fixture(() => wall); const reserved = f.reserve(); const prepared = f.reserve("prepared");
  wall = Date.now();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const native = observations();
  expect(await recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted", observations: native.port }))
    .toEqual({ released: 2, remaining: 0 });
  for (const row of [reserved, prepared]) {
    const recovered = f.store.readProviderProcessInvocation(row.nonce);
    expect(recovered?.state).toBe("released");
    expect(recovered?.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
    expect(recovered?.releaseEvidence?.observedAt).toBeLessThan(row.createdAt);
  }
});

test("a row changed during observation cannot be released using the earlier snapshot", async () => {
  const f = await fixture(); const row = f.reserve("running");
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const native = observations({ duringScopes: () => { f.store.beginProviderProcessInvocationRelease({ nonce: row.nonce,
    expectedRevision: row.revision, daemon: f.daemon }); } });
  await expect(recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted", observations: native.port }))
    .rejects.toThrow("custody remains unproved");
  expect(f.store.readProviderProcessInvocation(row.nonce)?.state).toBe("releasing");
});

test("observation batches stay bounded at16 and cancellation commits no late recovery", async () => {
  const f = await fixture();
  for (let index = 0; index < 17; index += 1) f.reserve("prepared");
  const authority = await f.lock.createRecoveryAuthority(f.store); const controller = new AbortController();
  const cancelled = observations({ duringHost: () => { controller.abort(); } });
  await expect(recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted",
    signal: controller.signal, observations: cancelled.port })).rejects.toThrow("custody remains unproved");
  expect(f.store.listUnreleasedProviderProcessInvocations({ limit: 256 })).toHaveLength(17);
  const native = observations();
  expect(await recoverNativeProviderProcessPass({ store: f.store, authority, helperExecutable: () => "/synthetic-admitted", observations: native.port }))
    .toEqual({ released: 17, remaining: 0 });
  expect(native.batches).toEqual([16, 1]);
});
