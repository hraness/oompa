import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, realpath, rename, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DaemonAuthorityFence, DaemonLock, daemonAuthorityDatabasePath, readDaemonRecoveryAuthority, type DaemonRecoveryAuthority } from "../daemon/daemon-lock";
import type { NativeCustodySettlement } from "../native-process/transport";
import { nativeProcessIdentitySchema, type NativePrepared, type NativeReady } from "../domain/native-process-identity";
import { createProviderProcessReleaseProofIssuer, type ProviderProcessDaemon,
  type ProviderProcessInvocation, type ProviderProcessLaunchContext, type ProviderProcessReleaseProof } from "../domain/provider-process-custody";
import { assertProviderProcessCustodySchema } from "./provider-process-custody";
import { initializeStatePaths, resolveStatePaths } from "./paths";
import { StateStore } from "./state-store";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
const nonce = (ordinal: number): string => ordinal.toString(16).padStart(32, "0");
const daemon: ProviderProcessDaemon = { daemonGeneration: 1, bootId: `boot_${"a".repeat(32)}` };
const boot = { platform: "darwin" as const, id: "00000000-0000-0000-0000-000000000001" };
const identity = (pid: number) => ({ pid, birth: { kind: "darwin-start-time" as const, seconds: "1234", micros: pid } });
const preparedFor = (invocation: string): NativePrepared => ({ version: 1, nonce: invocation,
  scope: "posix-process-group", groupId: 402, boot: { ...boot }, supervisor: identity(401), anchor: identity(402) });
const readyFor = (prepared: NativePrepared): NativeReady => ({ ...prepared, pid: 403, root: identity(403) });
const transition = (record: ProviderProcessInvocation, owner = daemon) => ({
  nonce: record.nonce, expectedRevision: record.revision, daemon: owner,
});
const fixture = async (input: { now?: () => number } = {}) => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-provider-custody-")));
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  await initializeStatePaths(paths);
  const lock = await DaemonLock.acquire(paths);
  const store = new StateStore(paths, { now: input.now ?? (() => 10_000) });
  let closed = false;
  const close = () => { if (!closed) { store.close(); closed = true; } };
  cleanup.push(async () => { close(); await lock.release(); await rm(home, { recursive: true, force: true }); });
  expect(store.nextDaemonGeneration(daemon.bootId)).toBe(daemon.daemonGeneration);
  const profile = store.createProfile("Process custody");
  const launchContext: ProviderProcessLaunchContext = { host: { platform: "darwin", digest: "d".repeat(64) }, boot,
    localFiles: { authority: lock.nativeFileIdentity(), state: store.nativeFileIdentity() } };
  const providerAuthority = store.requireProviderAccountAuthority(profile.id, "codex");
  if (providerAuthority.provider !== "codex") throw new Error("Fixture requires Codex authority.");
  const reservation = { nonce: nonce(1), providerAuthority,
    profileGeneration: profile.processGeneration, runtimeScope: "managed" as const, daemon,
    artifactDigest: "a".repeat(64), runtimeDigest: "b".repeat(64), launchContext };
  const reserve = () => store.reserveProviderProcessInvocation(reservation);
  const prepare = (record: ProviderProcessInvocation) => store.prepareProviderProcessInvocation({
    ...transition(record), prepared: preparedFor(record.nonce),
  });
  const running = () => {
    const record = prepare(reserve());
    return store.markProviderProcessInvocationRunning({ ...transition(record), ready: readyFor(preparedFor(record.nonce)) });
  };
  // This fixture owns an injected fake observation boundary. These SQLite tests
  // do not assert that any native process has actually existed or exited.
  const issuer = createProviderProcessReleaseProofIssuer("live-process");
  const recoveryIssuer = createProviderProcessReleaseProofIssuer("recovery");
  return { store, lock, paths, profile, launchContext, reservation, reserve, prepare, running, issuer, recoveryIssuer, close };
};

test("native birth parsers reject malformed foreign integers without throwing", () => {
  for (const value of ["bad", "+1", "01", "-1", "18446744073709551616", "1".repeat(1000)]) {
    expect(nativeProcessIdentitySchema.safeParse({ pid: 2, birth: { kind: "linux-start-ticks", ticks: value } }).success).toBe(false);
  }
  expect(nativeProcessIdentitySchema.safeParse({ pid: 2,
    birth: { kind: "linux-start-ticks", ticks: "18446744073709551615" } }).success).toBe(true);
  expect(nativeProcessIdentitySchema.safeParse({ pid: 1, birth: { kind: "linux-start-ticks", ticks: "1" } }).success).toBe(false);
});

test("a provider launch is reserved before scope preparation and preserves exact custody across reopen", async () => {
  const f = await fixture();
  const reserved = f.reserve();
  expect(reserved.state).toBe("reserved");
  expect(reserved.prepared).toBeNull();
  const prepared = f.prepare(reserved);
  expect(prepared.state).toBe("prepared");
  expect(prepared.ready).toBeNull();
  const reader = new StateStore(f.paths, { readonly: true });
  try { expect(reader.readProviderProcessInvocation(reserved.nonce)).toEqual(prepared); }
  finally { reader.close(); }
  const running = f.store.markProviderProcessInvocationRunning({ ...transition(prepared), ready: readyFor(preparedFor(reserved.nonce)) });
  expect(running.state).toBe("running");
  expect(running.revision).toBe(3);
  expect(running.prepared).toEqual(prepared.prepared);
  expect(running.ready?.root.pid).toBe(403);
});

test("an unreleased account scope blocks a new invocation even after its process generation changes", async () => {
  const f = await fixture();
  f.reserve();
  const authority = f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id,
    provider: "codex", expectedProcessGeneration: f.reservation.providerAuthority.processGeneration });
  if (authority.provider !== "codex") throw new Error("Fixture requires Codex authority.");
  const profile = f.store.requireProfileById(f.profile.id);
  expect(() => f.store.reserveProviderProcessInvocation({ ...f.reservation, nonce: nonce(2),
    providerAuthority: authority, profileGeneration: profile.processGeneration })).toThrow("PROVIDER_PROCESS_CUSTODY_BLOCKED");
  expect(f.store.listUnreleasedProviderProcessInvocations()).toHaveLength(1);
});

test("preparation and readiness reject stale revisions, mismatched scopes and changed authority", async () => {
  const f = await fixture();
  const reserved = f.reserve();
  expect(() => f.store.prepareProviderProcessInvocation({ ...transition(reserved), prepared: preparedFor(nonce(2)) })).toThrow();
  const prepared = f.prepare(reserved);
  expect(() => f.prepare(reserved)).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  const changed = readyFor({ ...preparedFor(reserved.nonce), supervisor: identity(404) });
  expect(() => f.store.markProviderProcessInvocationRunning({ ...transition(prepared), ready: changed })).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id,
    provider: "codex", expectedProcessGeneration: f.reservation.providerAuthority.processGeneration });
  expect(() => f.store.markProviderProcessInvocationRunning({ ...transition(prepared),
    ready: readyFor(preparedFor(reserved.nonce)) })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");
  expect(f.store.readProviderProcessInvocation(reserved.nonce)).toEqual(prepared);
});

const liveEvidence = (record: ProviderProcessInvocation, observed?: Partial<Omit<NativeCustodySettlement, "binding">>) => ({
  kind: "native-settled" as const, nonce: record.nonce, bindingDigest: record.bindingDigest,
  expectedRevision: record.revision, observedAt: 10_000, actor: { kind: "live-daemon" as const, daemon },
  committedPrepared: record.prepared, committedReady: record.ready,
  observed: { kind: (record.prepared === null ? "not-started" : "joined") as "joined" | "not-started",
    binding: { version: 1 as const, nonce: record.nonce, scope: "posix-process-group" as const },
    prepared: record.prepared, ready: record.ready, ...observed },
});
const recoveryEvidence = (f: Awaited<ReturnType<typeof fixture>>, authority: DaemonRecoveryAuthority,
  record: ProviderProcessInvocation, kind: "scope-absent" | "boot-ended" = "scope-absent",
  observedContext = f.launchContext) => ({
  kind, nonce: record.nonce, bindingDigest: record.bindingDigest,
  expectedRevision: record.revision + Number(record.state !== "releasing"), observedAt: 10_000,
  actor: readDaemonRecoveryAuthority(authority, f.store).actor, observedContext,
  committedPrepared: record.prepared, committedReady: record.ready,
});
const recover = (f: Awaited<ReturnType<typeof fixture>>, authority: DaemonRecoveryAuthority,
  record: ProviderProcessInvocation, proof = f.recoveryIssuer.issue(recoveryEvidence(f, authority, record))) =>
  f.store.recoverObservedInvocation(authority, { nonce: record.nonce, expectedRevision: record.revision, proof });

// Explicit synthetic predecessor: the earlier stopped marker did not check
// native custody. Recovery must still admit that historical combination, while
// the current product method must never create it.
const historicalStoppedMarker = (f: Awaited<ReturnType<typeof fixture>>): void => {
  const database = new Database(f.paths.database, { strict: true });
  try {
    expect(database.query("UPDATE daemon_state SET stopped_at=10000 WHERE singleton=1 AND generation=? AND boot_id=?")
      .run(daemon.daemonGeneration, daemon.bootId).changes).toBe(1);
  } finally { database.close(); }
};

test.each(["reserved", "prepared", "running", "releasing"] as const)("unreleased %s custody prevents a stopped marker without changing daemon state", async state => {
  const f = await fixture();
  let row = state === "running" ? f.running() : f.reserve();
  if (state === "prepared") row = f.prepare(row);
  if (state === "releasing") row = f.store.beginProviderProcessInvocationRelease(transition(row));
  const before = f.store.providerProcessRecoverySnapshot();
  expect(() => f.store.markDaemonStopped(daemon.daemonGeneration, daemon.bootId)).toThrow("PROVIDER_PROCESS_CUSTODY_BLOCKED");
  expect(f.store.providerProcessRecoverySnapshot()).toEqual(before);
  expect(f.store.readProviderProcessInvocation(row.nonce)).toEqual(row);
  expect(f.store.markDaemonStopped(daemon.daemonGeneration + 1, daemon.bootId)).toBe(false);
  expect(f.store.markDaemonStopped(daemon.daemonGeneration, `boot_${"b".repeat(32)}`)).toBe(false);
  expect(f.store.providerProcessRecoverySnapshot()).toEqual(before);
});

test("a stopped marker requires all managed and personal custody released and retains release history", async () => {
  const f = await fixture();
  const managed = f.store.beginProviderProcessInvocationRelease(transition(f.running()));
  const personal = f.store.beginProviderProcessInvocationRelease(transition(f.store.reserveProviderProcessInvocation({
    ...f.reservation, nonce: nonce(2), runtimeScope: "personal",
  })));
  const releasedManaged = f.store.releaseProviderProcessInvocation({ ...transition(managed), proof: f.issuer.issue(liveEvidence(managed)) });
  expect(() => f.store.markDaemonStopped(daemon.daemonGeneration, daemon.bootId)).toThrow("PROVIDER_PROCESS_CUSTODY_BLOCKED");
  const releasedPersonal = f.store.releaseProviderProcessInvocation({ ...transition(personal), proof: f.issuer.issue(liveEvidence(personal)) });
  expect(f.store.markDaemonStopped(daemon.daemonGeneration, daemon.bootId)).toBe(true);
  expect(f.store.providerProcessRecoverySnapshot().previousDaemon.stoppedAt).toBe(10_000);
  expect(f.store.readProviderProcessInvocation(managed.nonce)).toEqual(releasedManaged);
  expect(f.store.readProviderProcessInvocation(personal.nonce)).toEqual(releasedPersonal);
  expect(() => f.store.reserveProviderProcessInvocation({ ...f.reservation, nonce: nonce(3) })).toThrow();
});

test("only the exact live host proof can release an invocation and admit its replacement", async () => {
  const f = await fixture();
  const releasing = f.store.beginProviderProcessInvocationRelease(transition(f.running()));
  const evidence = liveEvidence(releasing);
  const proof = f.issuer.issue(evidence);
  const copied = JSON.parse(JSON.stringify(proof)) as ProviderProcessReleaseProof;
  expect(() => f.store.releaseProviderProcessInvocation({ ...transition(releasing), proof: copied })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  expect(() => f.store.releaseProviderProcessInvocation({ ...transition(releasing),
    proof: f.issuer.issue({ ...evidence, bindingDigest: "c".repeat(64) }) })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  const released = f.store.releaseProviderProcessInvocation({ ...transition(releasing), proof });
  expect(released.state).toBe("released");
  expect(f.store.listUnreleasedProviderProcessInvocations()).toEqual([]);
  const next = f.store.reserveProviderProcessInvocation({ ...f.reservation, nonce: nonce(2) });
  const nextRelease = f.store.beginProviderProcessInvocationRelease(transition(next));
  expect(() => f.store.releaseProviderProcessInvocation({ ...transition(nextRelease), proof })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  expect(f.store.readProviderProcessInvocation(next.nonce)?.state).toBe("releasing");
});

test.each([false, true])("held pre-generation recovery handles an old daemon without advancing its authority (stopped=%s)", async stopped => {
  const f = await fixture();
  const prepared = f.prepare(f.reserve());
  if (stopped) historicalStoppedMarker(f);
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const before = f.store.providerProcessRecoverySnapshot();
  const nextBoot = `boot_${"b".repeat(32)}`;
  expect(() => f.store.nextDaemonGeneration(nextBoot)).toThrow("PROVIDER_PROCESS_CUSTODY_BLOCKED");
  expect(f.store.providerProcessRecoverySnapshot()).toEqual(before);
  const released = recover(f, authority, prepared);
  expect(released.releaseEvidence?.actor).toEqual(readDaemonRecoveryAuthority(authority, f.store).actor);
  expect(released.providerAuthority).toEqual(f.reservation.providerAuthority);
  f.store.assertAllProviderInvocationsReleasedBeforeGenerationAdvance(authority);
  expect(f.store.nextDaemonGeneration(nextBoot)).toBe(2);
  expect(() => readDaemonRecoveryAuthority(authority, f.store)).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
});

test.each([false, true])("live no-start settlement retains an observed prepared anchor independently of commit (committed=%s)", async committed => {
  const f = await fixture();
  const reserved = f.reserve();
  const current = committed ? f.prepare(reserved) : reserved;
  const releasing = f.store.beginProviderProcessInvocationRelease(transition(current));
  const evidence = liveEvidence(releasing, { kind: "not-started", prepared: preparedFor(reserved.nonce), ready: null });
  const released = f.store.releaseProviderProcessInvocation({ ...transition(releasing), proof: f.issuer.issue(evidence) });
  expect(released.prepared).toEqual(committed ? preparedFor(reserved.nonce) : null);
  expect(released.releaseEvidence).toEqual(evidence);
});

test.each([false, true])("live settlement preserves Ready observation after callback failure without inventing a commit (committed=%s)", async committed => {
  const f = await fixture();
  const prepared = f.prepare(f.reserve());
  const ready = readyFor(preparedFor(prepared.nonce));
  const current = committed ? f.store.markProviderProcessInvocationRunning({ ...transition(prepared), ready }) : prepared;
  const releasing = f.store.beginProviderProcessInvocationRelease(transition(current));
  expect(() => f.store.markProviderProcessInvocationRunning({ ...transition(prepared), ready })).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  const evidence = liveEvidence(releasing, { ready });
  const released = f.store.releaseProviderProcessInvocation({ ...transition(releasing), proof: f.issuer.issue(evidence) });
  expect(released.ready).toEqual(committed ? ready : null);
  expect(released.releaseEvidence).toEqual(evidence);
  const reader = new StateStore(f.paths, { readonly: true });
  try { expect(reader.readProviderProcessInvocation(released.nonce)).toEqual(released); }
  finally { reader.close(); }
});

test("a live join cannot invent Prepared admission and no-start cannot hide a committed or observed Ready", async () => {
  const f = await fixture();
  const reserved = f.store.beginProviderProcessInvocationRelease(transition(f.reserve()));
  expect(() => f.store.releaseProviderProcessInvocation({ ...transition(reserved), proof: f.issuer.issue(liveEvidence(reserved,
    { kind: "joined", prepared: preparedFor(reserved.nonce), ready: readyFor(preparedFor(reserved.nonce)) })) })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  const personal = f.store.reserveProviderProcessInvocation({ ...f.reservation, nonce: nonce(2), runtimeScope: "personal" });
  const running = f.store.markProviderProcessInvocationRunning({ ...transition(f.prepare(personal)), ready: readyFor(preparedFor(personal.nonce)) });
  const releasing = f.store.beginProviderProcessInvocationRelease(transition(running));
  expect(() => f.store.releaseProviderProcessInvocation({ ...transition(releasing), proof: f.issuer.issue(liveEvidence(releasing,
    { kind: "not-started" })) })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  expect(() => f.store.releaseProviderProcessInvocation({ ...transition(releasing), proof: f.issuer.issue(liveEvidence(releasing,
    { ready: null })) })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
});

test("live settlement rejects mismatched committed identity, binding and revision", async () => {
  const f = await fixture();
  const record = f.store.beginProviderProcessInvocationRelease(transition(f.prepare(f.reserve())));
  const evidence = liveEvidence(record);
  for (const changed of [
    { ...evidence, committedPrepared: null },
    { ...evidence, expectedRevision: record.revision - 1 },
    { ...evidence, observed: { ...evidence.observed, binding: { ...evidence.observed.binding, nonce: nonce(9) } } },
    { ...evidence, observed: { ...evidence.observed, prepared: preparedFor(nonce(9)) } },
  ]) {
    expect(() => f.store.releaseProviderProcessInvocation({ ...transition(record), proof: f.issuer.issue(changed) })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
    expect(f.store.readProviderProcessInvocation(record.nonce)).toEqual(record);
  }
});

test("transport and recovery issuers cannot mint each other's observation capabilities", async () => {
  const f = await fixture();
  const record = f.prepare(f.reserve());
  const authority = await f.lock.createRecoveryAuthority(f.store);
  expect(() => { Reflect.apply(f.issuer.issue, f.issuer, [recoveryEvidence(f, authority, record)]); }).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  const live = liveEvidence(f.store.beginProviderProcessInvocationRelease(transition(record)));
  expect(() => { Reflect.apply(f.recoveryIssuer.issue, f.recoveryIssuer, [live]); }).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
});

test.each([false, true])("same-host reboot releases captured authority without requiring old device numbering (prepared=%s)", async prepared => {
  const f = await fixture();
  const reserved = f.store.reserveProviderProcessInvocation({ ...f.reservation,
    launchContext: { ...f.launchContext, localFiles: { authority: { device: "0", inode: "0" }, state: { device: "0", inode: "0" } } } });
  const record = prepared ? f.prepare(reserved) : reserved;
  const authority = await f.lock.createRecoveryAuthority(f.store);
  expect(() => recover(f, authority, record, f.recoveryIssuer.issue(recoveryEvidence(f, authority, record, "boot-ended"))))
    .toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  const context = { ...f.launchContext, boot: { ...boot, id: "00000000-0000-0000-0000-000000000002" } };
  const released = recover(f, authority, record, f.recoveryIssuer.issue(recoveryEvidence(f, authority, record, "boot-ended", context)));
  expect(released.state).toBe("released");
  expect(released.prepared).toEqual(record.prepared);
});

test("unreleased enumeration is bounded and filters the independent managed and personal scopes", async () => {
  const f = await fixture();
  const first = f.reserve();
  const second = f.store.reserveProviderProcessInvocation({ ...f.reservation, nonce: nonce(2), runtimeScope: "personal" });
  expect(f.store.listUnreleasedProviderProcessInvocations({ limit: 1 })).toEqual([first]);
  expect(f.store.listUnreleasedProviderProcessInvocations({ afterNonce: first.nonce, limit: 1 })).toEqual([second]);
  expect(f.store.listUnreleasedProviderProcessInvocations({ runtimeScope: "personal" })).toEqual([second]);
  expect(() => f.store.listUnreleasedProviderProcessInvocations({ limit: 257 })).toThrow("PROVIDER_PROCESS_CUSTODY_INVALID");
});

test("SQLite itself forbids custody deletion and skipping release transitions", async () => {
  const f = await fixture();
  const record = f.reserve();
  const db = new Database(f.paths.database);
  try {
    expect(() => db.query("DELETE FROM provider_process_invocations WHERE nonce=?").run(record.nonce)).toThrow("PROVIDER_PROCESS_CUSTODY_RETAINED");
    expect(() => db.query("UPDATE provider_process_invocations SET state='released',revision=3 WHERE nonce=?").run(record.nonce)).toThrow("PROVIDER_PROCESS_CUSTODY_TRANSITION");
    expect(() => db.query("UPDATE provider_process_invocations SET runtime_scope='personal',revision=2,state='releasing' WHERE nonce=?").run(record.nonce)).toThrow("PROVIDER_PROCESS_CUSTODY_TRANSITION");
  } finally { db.close(); }
  expect(f.store.readProviderProcessInvocation(record.nonce)).toEqual(record);
});

test.each([false, true])("open audits live custody; retained history is validated on consumption (released=%s)", async released => {
  const f = await fixture();
  let record = f.reserve();
  if (released) {
    record = f.store.beginProviderProcessInvocationRelease(transition(record));
    record = f.store.releaseProviderProcessInvocation({ ...transition(record), proof: f.issuer.issue(liveEvidence(record)) });
  }
  f.close();
  const db = new Database(f.paths.database);
  try {
    // Simulate damaged stored data while restoring the exact schema guard.
    // Retained history is never needed to admit a replacement or status read.
    const guard = db.query<{ sql: string }, []>("SELECT sql FROM sqlite_master WHERE name='provider_process_invocations_transition'").get();
    if (guard === null) throw new Error("Missing fixture transition guard.");
    db.exec("DROP TRIGGER provider_process_invocations_transition");
    db.query("UPDATE provider_process_invocations SET reservation_json='{}' WHERE nonce=?").run(record.nonce);
    db.exec(guard.sql);
  } finally { db.close(); }
  if (!released) {
    expect(() => new StateStore(f.paths, { readonly: true })).toThrow("PROVIDER_PROCESS_CUSTODY_CORRUPT");
  } else {
    const reader = new StateStore(f.paths, { readonly: true });
    try {
      expect(reader.listUnreleasedProviderProcessInvocations()).toEqual([]);
      expect(() => reader.readProviderProcessInvocation(record.nonce)).toThrow("PROVIDER_PROCESS_CUSTODY_CORRUPT");
    } finally { reader.close(); }
  }
});

test("version61 migration preserves every existing version60 table row and schema object", async () => {
  const f = await fixture();
  f.close();
  const db = new Database(f.paths.database);
  const snapshot = () => {
    const objects = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name!='provider_process_invocations' ORDER BY name").all();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'provider_process_invocations*' AND name!='migrations' ORDER BY name")
      .all() as Array<{ name: string }>;
    return { objects, rows: tables.map(({ name }) => ({ name, rows: db.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all() })),
      migrations: db.query("SELECT * FROM migrations WHERE version<=60 ORDER BY version").all() };
  };
  try {
    db.exec("DROP TABLE provider_process_invocations");
    db.exec("DELETE FROM migrations WHERE version=61");
    db.exec("PRAGMA user_version=60");
    const before = snapshot();
    expect(() => new StateStore(f.paths, { readonly: true })).toThrow("STATE_SCHEMA_MIGRATION_REQUIRED:60:61");
    const migrated = new StateStore(f.paths, { now: () => 11_000 });
    try {
      expect(snapshot()).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 61 });
      expect(migrated.listUnreleasedProviderProcessInvocations()).toEqual([]);
      expect(() => assertProviderProcessCustodySchema(db)).not.toThrow();
    } finally { migrated.close(); }
  } finally { db.close(); }
});

test("a partial successor footprint is refused without repairing or changing the predecessor", async () => {
  const f = await fixture();
  f.close();
  const db = new Database(f.paths.database);
  try {
    db.exec("DELETE FROM migrations WHERE version=61");
    db.exec("PRAGMA user_version=60");
    const before = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all();
    expect(() => new StateStore(f.paths)).toThrow("PROVIDER_PROCESS_CUSTODY_CORRUPT");
    expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 60 });
    expect(db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before);
  } finally { db.close(); }
});

test("a missing current custody guard is refused on hot read and reopen", async () => {
  const f = await fixture();
  const record = f.reserve();
  const db = new Database(f.paths.database);
  try {
    db.exec("DROP TRIGGER provider_process_invocations_delete");
    expect(() => f.store.readProviderProcessInvocation(record.nonce)).toThrow("PROVIDER_PROCESS_CUSTODY_CORRUPT");
    expect(() => new StateStore(f.paths, { readonly: true })).toThrow("PROVIDER_PROCESS_CUSTODY_CORRUPT");
    expect(() => new StateStore(f.paths)).toThrow("PROVIDER_PROCESS_CUSTODY_CORRUPT");
  } finally { db.close(); }
});

test("an additional custody trigger cannot turn a denied update into apparent admission", async () => {
  const f = await fixture();
  const record = f.reserve();
  const db = new Database(f.paths.database);
  try {
    db.exec("CREATE TRIGGER unexpected_custody_ignore BEFORE UPDATE ON provider_process_invocations BEGIN SELECT RAISE(IGNORE); END");
    expect(() => f.prepare(record)).toThrow("PROVIDER_PROCESS_CUSTODY_CORRUPT");
    expect(db.query("SELECT state,revision FROM provider_process_invocations WHERE nonce=?").get(record.nonce))
      .toEqual({ state: "reserved", revision: 1 });
  } finally { db.close(); }
});

test.each([false, true])("reserved recovery records only an irrevocable no-activation fence and defeats a late Prepared commit (releasing=%s)", async releasing => {
  const f = await fixture();
  const reserved = f.reserve();
  const record = releasing ? f.store.beginProviderProcessInvocationRelease(transition(reserved)) : reserved;
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const released = f.store.recoverUnpreparedInvocation(authority, {
    nonce: record.nonce, expectedRevision: record.revision, currentContext: f.launchContext,
  });
  expect(released.state).toBe("released");
  expect(released.revision).toBe(3);
  expect(released.prepared).toBeNull();
  expect(released.ready).toBeNull();
  expect(released.releaseEvidence).toEqual({ kind: "activation-never-admitted",
    nonce: record.nonce, bindingDigest: record.bindingDigest, expectedRevision: 2, observedAt: 10_000,
    actor: readDaemonRecoveryAuthority(authority, f.store).actor, observedContext: f.launchContext });
  expect(JSON.stringify(released.releaseEvidence)).not.toContain("joined");
  expect(() => f.prepare(reserved)).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
});

test("a Prepared commit wins the no-activation race and requires physical observation even without Ready", async () => {
  const f = await fixture();
  const reserved = f.reserve();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const prepared = f.prepare(reserved);
  expect(() => f.store.recoverUnpreparedInvocation(authority, {
    nonce: reserved.nonce, expectedRevision: reserved.revision, currentContext: f.launchContext,
  })).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  expect(() => f.store.recoverUnpreparedInvocation(authority, {
    nonce: prepared.nonce, expectedRevision: prepared.revision, currentContext: f.launchContext,
  })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  expect(f.store.readProviderProcessInvocation(prepared.nonce)).toEqual(prepared);
  expect(recover(f, authority, prepared).releaseEvidence?.kind).toBe("scope-absent");
});

test.each(["host", "authority-file", "state-file", "namespace"] as const)("same-boot reserved recovery refuses a different %s without changing its durable prefix", async mismatch => {
  const f = await fixture();
  const record = f.reserve();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const currentContext: ProviderProcessLaunchContext = structuredClone(f.launchContext);
  if (mismatch === "host") currentContext.host.digest = "e".repeat(64);
  else if (mismatch === "authority-file") currentContext.localFiles.authority.inode = "0";
  else if (mismatch === "state-file") currentContext.localFiles.state.inode = "0";
  else {
    currentContext.host.platform = "linux";
    currentContext.boot = { platform: "linux", id: boot.id, pidNamespace: { device: "1", inode: "2" } };
  }
  expect(() => f.store.recoverUnpreparedInvocation(authority, {
    nonce: record.nonce, expectedRevision: record.revision, currentContext,
  })).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  expect(f.store.readProviderProcessInvocation(record.nonce)).toEqual(record);
});

test("scope observation proof is bound to the exact actor, prior prefix, local files and host", async () => {
  const f = await fixture();
  const record = f.prepare(f.reserve());
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const evidence = recoveryEvidence(f, authority, record);
  for (const changed of [
    { ...evidence, bindingDigest: "e".repeat(64) },
    { ...evidence, expectedRevision: evidence.expectedRevision - 1 },
    { ...evidence, committedPrepared: null },
    { ...evidence, actor: { ...evidence.actor, authorityNonce: "00000000-0000-4000-8000-000000000001" } },
    { ...evidence, observedContext: { ...evidence.observedContext, host: { ...evidence.observedContext.host, digest: "e".repeat(64) } } },
    { ...evidence, observedContext: { ...evidence.observedContext, localFiles: { ...evidence.observedContext.localFiles,
      state: { device: "0", inode: "0" } } } },
  ]) {
    expect(() => recover(f, authority, record, f.recoveryIssuer.issue(changed))).toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
    // A revision mismatch fails after entering releasing;
    // the immediate transaction restores the entire original prefix.
    expect(f.store.readProviderProcessInvocation(record.nonce)).toEqual(record);
  }
  const proof = f.recoveryIssuer.issue(evidence);
  expect(() => recover(f, authority, record, JSON.parse(JSON.stringify(proof)) as ProviderProcessReleaseProof))
    .toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  const releasing = f.store.beginProviderProcessInvocationRelease(transition(record));
  expect(() => recover(f, authority, record, proof)).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  expect(recover(f, authority, releasing).revision).toBe(4);
});

test("reboot evidence refuses a foreign host even when its boot differs", async () => {
  const f = await fixture();
  const record = f.reserve();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const context = { ...f.launchContext, host: { ...f.launchContext.host, digest: "e".repeat(64) },
    boot: { ...boot, id: "00000000-0000-0000-0000-000000000002" } };
  expect(() => recover(f, authority, record, f.recoveryIssuer.issue(recoveryEvidence(f, authority, record, "boot-ended", context))))
    .toThrow("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  expect(f.store.readProviderProcessInvocation(record.nonce)).toEqual(record);
});

test("startup recovery authority rejects copies, a second store instance, closed stores and lock release", async () => {
  const f = await fixture();
  const record = f.reserve();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const input = { nonce: record.nonce, expectedRevision: record.revision, currentContext: f.launchContext };
  expect(() => f.store.recoverUnpreparedInvocation({ ...authority }, input)).toThrow("Wrong daemon recovery authority");
  const second = new StateStore(f.paths);
  try { expect(() => second.recoverUnpreparedInvocation(authority, input)).toThrow("Wrong daemon recovery authority"); }
  finally { second.close(); }
  // release() fences synchronously before its receipt-publication awaits.
  const released = f.lock.release();
  expect(() => f.store.recoverUnpreparedInvocation(authority, input)).toThrow("transaction is not held");
  await released;
  expect(f.store.readProviderProcessInvocation(record.nonce)).toEqual(record);
  f.close();
  expect(() => readDaemonRecoveryAuthority(authority, f.store)).toThrow();
});

test.each(["authority", "state"] as const)("startup recovery authority refuses replacement of its exact %s file", async target => {
  const f = await fixture();
  const record = f.reserve();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const path = target === "authority" ? daemonAuthorityDatabasePath(f.paths) : f.paths.database;
  const moved = `${path}.held-fixture-original`;
  await rename(path, moved);
  try {
    await copyFile(moved, path);
    expect(() => f.store.recoverUnpreparedInvocation(authority, {
      nonce: record.nonce, expectedRevision: record.revision, currentContext: f.launchContext,
    })).toThrow();
    await expect(authority.assertCurrent()).rejects.toThrow();
  } finally {
    await unlink(path);
    await rename(moved, path);
  }
  expect(f.store.readProviderProcessInvocation(record.nonce)).toEqual(record);
});

test("prior stopped-state drift and authority publication close the nominal recovery capability", async () => {
  const f = await fixture();
  f.reserve();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  historicalStoppedMarker(f);
  expect(() => readDaemonRecoveryAuthority(authority, f.store)).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  const stoppedAuthority = await f.lock.createRecoveryAuthority(f.store);
  await f.lock.publish({ state: "ready", generation: 1, bootId: daemon.bootId });
  expect(() => readDaemonRecoveryAuthority(stoppedAuthority, f.store)).toThrow("Startup recovery admission is closed");
  await expect(f.lock.createRecoveryAuthority(f.store)).rejects.toThrow("Startup admission is not closed");
});

test("release timestamps retain observations across clock rollback and independent clock skew", async () => {
  let now = 10_000;
  const f = await fixture({ now: () => now });
  const reserved = f.reserve();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  now = 9_000;
  const released = f.store.recoverUnpreparedInvocation(authority, {
    nonce: reserved.nonce, expectedRevision: reserved.revision, currentContext: f.launchContext,
  });
  expect(released.createdAt).toBe(10_000);
  expect(released.updatedAt).toBe(10_000);
  expect(released.releasedAt).toBe(10_000);
  expect(released.releaseEvidence?.observedAt).toBe(9_000);
  const next = f.store.reserveProviderProcessInvocation({ ...f.reservation, nonce: nonce(2) });
  const releasing = f.store.beginProviderProcessInvocationRelease(transition(next));
  const evidence = { ...liveEvidence(releasing), observedAt: 20_000 };
  const settled = f.store.releaseProviderProcessInvocation({ ...transition(releasing), proof: f.issuer.issue(evidence) });
  expect(settled.updatedAt).toBe(9_000);
  expect(settled.releaseEvidence?.observedAt).toBe(20_000);
  const reader = new StateStore(f.paths, { readonly: true });
  try {
    expect(reader.readProviderProcessInvocation(released.nonce)).toEqual(released);
    expect(reader.readProviderProcessInvocation(settled.nonce)).toEqual(settled);
  } finally { reader.close(); }
});

test.each(["getter", "publish"] as const)("mutating a public %s receipt cannot reopen recovery admission", async source => {
  const f = await fixture();
  const authority = await f.lock.createRecoveryAuthority(f.store);
  const published = await f.lock.publish({ state: "ready", generation: daemon.daemonGeneration, bootId: daemon.bootId });
  const receipt = source === "getter" ? f.lock.receipt : published;
  receipt.state = "booting";
  delete receipt.generation;
  delete receipt.bootId;
  expect(f.lock.receipt).toMatchObject({ state: "ready", generation: daemon.daemonGeneration, bootId: daemon.bootId });
  expect(() => readDaemonRecoveryAuthority(authority, f.store)).toThrow("Startup recovery admission is closed");
  await expect(f.lock.createRecoveryAuthority(f.store)).rejects.toThrow("Startup admission is not closed");
});

test("the final synchronous invocation fence requires exact prepared/running state and current account authority", async () => {
  const f = await fixture();
  const prepared = f.prepare(f.reserve());
  expect(() => f.store.assertProviderProcessInvocationCurrent({ ...transition(prepared), state: "prepared" })).not.toThrow();
  expect(() => f.store.assertProviderProcessInvocationCurrent({ ...transition(prepared), state: "running" })).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  const running = f.store.markProviderProcessInvocationRunning({ ...transition(prepared), ready: readyFor(preparedFor(prepared.nonce)) });
  expect(() => f.store.assertProviderProcessInvocationCurrent({ ...transition(prepared), state: "prepared" })).toThrow("PROVIDER_PROCESS_CUSTODY_STALE");
  expect(() => f.store.assertProviderProcessInvocationCurrent({ ...transition(running), state: "running" })).not.toThrow();
  f.store.advanceProviderAccountProcessGeneration({ profileId: f.profile.id,
    provider: "codex", expectedProcessGeneration: f.reservation.providerAuthority.processGeneration });
  expect(() => f.store.assertProviderProcessInvocationCurrent({ ...transition(running), state: "running" })).toThrow("PROVIDER_ACCOUNT_AUTHORITY_STALE");
  expect(f.store.readProviderProcessInvocation(running.nonce)).toEqual(running);
});

test("the final synchronous daemon fence closes on lifetime close, generation publication and lock release", async () => {
  const f = await fixture();
  await f.lock.publish({ state: "ready", generation: daemon.daemonGeneration, bootId: daemon.bootId });
  const fence = new DaemonAuthorityFence(f.lock, { generation: daemon.daemonGeneration, bootId: daemon.bootId });
  expect(() => fence.assertCurrentSynchronously()).not.toThrow();
  fence.close();
  expect(() => fence.assertCurrentSynchronously()).toThrow("daemon effect authority is closed");
  const previous = new DaemonAuthorityFence(f.lock, { generation: daemon.daemonGeneration, bootId: daemon.bootId });
  await f.lock.publish({ state: "ready", generation: 2, bootId: `boot_${"b".repeat(32)}` });
  expect(() => previous.assertCurrentSynchronously()).toThrow("generation or boot ID changed");
  const current = new DaemonAuthorityFence(f.lock, { generation: 2, bootId: `boot_${"b".repeat(32)}` });
  const released = f.lock.release();
  expect(() => current.assertCurrentSynchronously()).toThrow("transaction is not held");
  await released;
});
