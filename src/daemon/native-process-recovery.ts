import { isDeepStrictEqual } from "node:util";

import { createProviderProcessReleaseProofIssuer, type ProviderProcessInvocation,
  type ProviderProcessLaunchContext } from "../domain/provider-process-custody.ts";
import { nativeScopeIsAbsent, type NativeScopeRequest } from "../native-process/observation-protocol.ts";
import { observeNativeHost, observeNativeScopes, type NativeObserverOptions } from "../native-process/observer.ts";
import type { StateStore } from "../storage/state-store.ts";
import { readDaemonRecoveryAuthority, type DaemonLock, type DaemonRecoveryAuthority } from "./daemon-lock.ts";

export class NativeProviderRecoveryError extends Error {
  constructor() { super("Native provider custody remains unproved; daemon admission is closed."); this.name = "NativeProviderRecoveryError"; }
}

type ObservationPort = Readonly<{ host: typeof observeNativeHost; scopes: typeof observeNativeScopes }>;
const nativeObservations: ObservationPort = { host: observeNativeHost, scopes: observeNativeScopes };
type RecoveryOptions = Readonly<{
  store: StateStore; authority: DaemonRecoveryAuthority;
  /** Exact immutable helper already admitted by the product artifact owner. */
  helperExecutable: () => string; signal?: AbortSignal;
  deadlineAt?: number;
  /** Trusted composition seam for deterministic tests, never an RPC input. */
  observations?: ObservationPort;
}>;

const releasingRevision = (row: ProviderProcessInvocation): number => row.revision + (row.state === "releasing" ? 0 : 1);
const sameSnapshot = (left: ProviderProcessInvocation | null, right: ProviderProcessInvocation): boolean =>
  left !== null && left.revision === right.revision && left.state === right.state && left.bindingDigest === right.bindingDigest;

/** One bounded recovery pass. The real exclusive lock stays held; no new
 * daemon/account generation is published until every writer barrier retires. */
export async function recoverNativeProviderProcessPass(options: RecoveryOptions): Promise<Readonly<{ released: number; remaining: number }>> {
  const { store, authority } = options;
  await authority.assertCurrent();
  const rows = store.listUnreleasedProviderProcessInvocations({ limit: 256 });
  if (rows.length === 0) {
    store.assertAllProviderInvocationsReleasedBeforeGenerationAdvance(authority);
    return { released: 0, remaining: 0 };
  }
  const observations = options.observations ?? nativeObservations;
  const assertOpen = (): void => {
    if (options.signal?.aborted === true
      || (options.deadlineAt !== undefined && performance.now() >= options.deadlineAt)) throw new NativeProviderRecoveryError();
  };
  const observerOptions = (): NativeObserverOptions => {
    assertOpen();
    const remaining = options.deadlineAt === undefined ? 3000 : Math.floor(options.deadlineAt - performance.now());
    if (remaining < 1) throw new NativeProviderRecoveryError();
    return { helperExecutable: options.helperExecutable(), deadlineMs: Math.min(3000, remaining),
      ...(options.signal === undefined ? {} : { signal: options.signal }) };
  };
  const host = await observations.host(observerOptions());
  await authority.assertCurrent();
  const held = readDaemonRecoveryAuthority(authority, store);
  const currentContext: ProviderProcessLaunchContext = { ...host.context, localFiles: held.localFiles };
  const issuer = createProviderProcessReleaseProofIssuer("recovery");
  let released = 0;
  const pending: ProviderProcessInvocation[] = [];

  const releaseObserved = (row: ProviderProcessInvocation, context: ProviderProcessLaunchContext,
    kind: "boot-ended" | "scope-absent"): void => {
    assertOpen();
    const current = store.readProviderProcessInvocation(row.nonce);
    if (!sameSnapshot(current, row)) throw new NativeProviderRecoveryError();
    const snapshot = readDaemonRecoveryAuthority(authority, store);
    const proof = issuer.issue({ kind, nonce: row.nonce, bindingDigest: row.bindingDigest,
      expectedRevision: releasingRevision(row), actor: snapshot.actor,
      observedAt: Date.now(), observedContext: { ...context, localFiles: snapshot.localFiles },
      committedPrepared: row.prepared, committedReady: row.ready });
    store.recoverObservedInvocation(authority, { nonce: row.nonce, expectedRevision: row.revision, proof });
    released += 1;
  };

  for (const row of rows) {
    assertOpen();
    if (!isDeepStrictEqual(row.launchContext.host, currentContext.host)) continue;
    if (row.launchContext.boot.id !== currentContext.boot.id) {
      // Same stable host, different actual OS boot: every old local process
      // ended. Old device numbering need not survive the reboot.
      releaseObserved(row, currentContext, "boot-ended");
      continue;
    }
    if (!isDeepStrictEqual(row.launchContext.boot, currentContext.boot)
      || !isDeepStrictEqual(row.launchContext.localFiles, currentContext.localFiles)) continue;
    if (row.prepared === null) {
      if (!sameSnapshot(store.readProviderProcessInvocation(row.nonce), row)) throw new NativeProviderRecoveryError();
      store.recoverUnpreparedInvocation(authority, { nonce: row.nonce, expectedRevision: row.revision, currentContext });
      released += 1;
    } else pending.push(row);
  }

  for (let offset = 0; offset < pending.length; offset += 16) {
    assertOpen();
    const batch = pending.slice(offset, offset + 16);
    const targets: NativeScopeRequest["targets"] = batch.map(row => {
      if (row.prepared === null) throw new NativeProviderRecoveryError();
      return { nonce: row.nonce, bindingDigest: row.bindingDigest, expectedRevision: releasingRevision(row),
        prepared: row.prepared, ready: row.ready };
    });
    const observation = await observations.scopes({ context: host.context, targets }, observerOptions());
    await authority.assertCurrent();
    for (let index = 0; index < batch.length; index += 1) {
      const row = batch[index];
      if (row === undefined || !nativeScopeIsAbsent(observation, index)) continue;
      // The observer has no store access. Bind its fresh native facts to this
      // same held lock/store and exact row immediately before the storage CAS.
      releaseObserved(row, { ...observation.context, localFiles: readDaemonRecoveryAuthority(authority, store).localFiles }, "scope-absent");
    }
  }
  await authority.assertCurrent();
  const remaining = store.listUnreleasedProviderProcessInvocations({ limit: 256 }).length;
  if (remaining === 0) store.assertAllProviderInvocationsReleasedBeforeGenerationAdvance(authority);
  return { released, remaining };
}

/** Startup retries observation, never provider execution or an uncertain write.
 * A deadline is refusal evidence only; the unreleased rows remain durable. */
export async function recoverNativeProviderProcesses(options: Readonly<{
  store: StateStore; lock: DaemonLock; helperExecutable: () => string; signal?: AbortSignal;
}>): Promise<void> {
  if (options.store.listUnreleasedProviderProcessInvocations({ limit: 1 }).length === 0) return;
  const authority = await options.lock.createRecoveryAuthority(options.store);
  const deadline = performance.now() + 30_000;
  do {
    const result = await recoverNativeProviderProcessPass({ ...options, authority, deadlineAt: deadline });
    if (result.remaining === 0) return;
    if (options.signal?.aborted === true) break;
    await new Promise<void>(resolve => { setTimeout(resolve, Math.min(250, Math.max(0, deadline - performance.now()))); });
  } while (performance.now() < deadline);
  throw new NativeProviderRecoveryError();
}
