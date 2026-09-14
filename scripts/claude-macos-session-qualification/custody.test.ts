import { afterAll, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { createHmac } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { AtomicPrivateJsonReceipt } from "../live-acceptance-private-custody.ts";
import { createCredentialFreeSessionJournal, observeCredentialFreeSessionJournal, DarwinSessionCustody,
  JOURNAL_OPERATIONS, DAEMON_SEED_OPERATIONS, createCredentialFreeDaemonSeedJournal, observeCredentialFreeDaemonSeedJournal, type JournalOperation, type SessionSummary } from "./custody.ts";

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = "a".repeat(64);
const firstChild = { pidDomain: "darwin", pid: 111, procStart: "Fri Sep 11 12:00:00 2026" } as const;
const resumedChild = { ...firstChild, pid: 112 };
const processOperations: readonly JournalOperation[] = ["version", "login_help", "logout_help", "initial_status", "login", "signed_in", "start", "resume", "logout", "signed_out"];
const turnOperations: readonly JournalOperation[] = ["stream_turn", "approve_turn", "deny_turn", "interrupt_turn", "resumed_turn"];
function summary(operation: JournalOperation): SessionSummary {
  if (operation === "version" || operation === "login_help" || operation === "logout_help") return { kind: "capability", digest };
  if (operation === "initial_status" || operation === "signed_in" || operation === "signed_out") return { kind: "status", signedIn: operation === "signed_in", identityTag: operation === "signed_in" ? digest : null };
  if (operation === "login") return { kind: "login", childJoined: true };
  if (operation === "logout") return { kind: "logout", childJoined: true };
  if (operation === "start" || operation === "resume") return { kind: "session", threadTag: digest, connectionTag: (operation === "start" ? "b" : "c").repeat(64), processIdentity: operation === "start" ? firstChild : resumedChild };
  if (operation === "close" || operation === "close_final") return { kind: "close", processIdentity: operation === "close" ? firstChild : resumedChild, childJoined: true, stdoutEof: true, stderrEof: true };
  return { kind: "turn", deltaCount: 2, deltaBytes: 12, completed: true, decision: operation === "approve_turn" ? "once" : operation === "deny_turn" ? "decline" : null, interrupted: operation === "interrupt_turn" };
}
function history(family: "session" | "daemon" = "session") {
  let state = family === "session" ? createCredentialFreeSessionJournal(id(1)) : createCredentialFreeDaemonSeedJournal(id(1)); let next = 2;
  const event = (input: unknown) => { state = (family === "session" ? observeCredentialFreeSessionJournal : observeCredentialFreeDaemonSeedJournal)(state, input); };
  const attempt = () => { const current = state.attempts.at(-1)?.attempt; if (current === undefined) throw new Error("fixture_attempt_missing"); return current; };
  const begin = (operation: JournalOperation) => { const attemptId = id(next++); event({ kind: "intent", operation, attemptId }); event({ kind: "dispatched", attemptId }); return attempt(); };
  const dispatch = (kind: "process" | "frame", acknowledge = true) => {
    const dispatchId = id(next++); const attemptId = attempt().attemptId;
    event({ kind: "dispatch", attemptId, dispatchId, dispatchKind: kind, frameTag: kind === "frame" ? digest : null, frameBytes: kind === "frame" ? 12 : 0 });
    if (acknowledge) event({ kind: "ack", attemptId, dispatchId });
    return dispatchId;
  };
  const prepare = (operation: JournalOperation) => {
    const current = begin(operation);
    if (processOperations.includes(operation)) dispatch("process");
    if (turnOperations.includes(operation)) dispatch("frame");
    if (operation === "start" || operation === "resume") event({ kind: "child", attemptId: current.attemptId, identity: operation === "start" ? firstChild : resumedChild });
    return current;
  };
  const settle = (value: unknown = summary(attempt().operation)) => event({ kind: "settled", attemptId: attempt().attemptId, summary: value });
  const advance = (count: number) => { for (const operation of (family === "session" ? JOURNAL_OPERATIONS : DAEMON_SEED_OPERATIONS).slice(state.attempts.length, count)) { prepare(operation); settle(); } };
  return { get state() { return state; }, event, begin, dispatch, prepare, settle, advance, attempt };
}

test("the fixed seventeen-operation journal ends signed out with distinct process generations and no replay", () => {
  const h = history(); h.advance(17);
  expect(h.state.attempts.map((entry) => entry.attempt.operation)).toEqual([...JOURNAL_OPERATIONS]);
  expect(h.state.attempts.every((entry) => entry.phase === "settled" && entry.dispatches.every((d) => d.acknowledged))).toBe(true);
  expect(h.state.attempts.at(-1)?.summary).toEqual({ kind: "status", signedIn: false, identityTag: null });
  expect(h.state.source).toBe("credential_free_fixture");
  expect(() => h.begin("version")).toThrow();
  expect("restore" in DarwinSessionCustody).toBe(false);
  expect("removeRoot" in DarwinSessionCustody.prototype).toBe(false);
});

test("operation order and intent/dispatched barriers cannot be skipped", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 16 }), fc.integer({ min: 0, max: 16 }), (position, supplied) => {
    const h = history(); h.advance(position);
    const operation = JOURNAL_OPERATIONS[supplied]; if (operation === undefined) throw new Error("fixture_operation_missing");
    if (position === supplied) expect(() => h.begin(operation)).not.toThrow();
    else expect(() => h.begin(operation)).toThrow();
  }), { numRuns: 128 });
  const h = history(); h.event({ kind: "intent", operation: "version", attemptId: id(900) });
  expect(() => h.dispatch("process")).toThrow();
  expect(() => h.settle({ kind: "capability", digest })).toThrow();
});

test("every dispatch has one exact acknowledgement before settlement", () => {
  const h = history(); const attempt = h.begin("version");
  const dispatchId = h.dispatch("process", false);
  expect(() => h.settle()).toThrow();
  expect(() => h.event({ kind: "ack", attemptId: attempt.attemptId, dispatchId: id(99) })).toThrow();
  expect(() => h.event({ kind: "ack", attemptId: id(99), dispatchId })).toThrow();
  h.event({ kind: "ack", attemptId: attempt.attemptId, dispatchId });
  expect(() => h.event({ kind: "ack", attemptId: attempt.attemptId, dispatchId })).toThrow();
  expect(() => h.dispatch("process")).toThrow();
  h.settle();
});

test("inherited authentication, unjoined login and unjoined logout do not advance", () => {
  for (const [operation, patch] of [["initial_status", { kind: "status", signedIn: true, identityTag: digest }],
    ["login", { kind: "login", childJoined: false }], ["logout", { kind: "logout", childJoined: false }]] as const) {
    const h = history(); h.advance(JOURNAL_OPERATIONS.indexOf(operation)); h.prepare(operation);
    expect(() => h.settle(patch)).toThrow(); expect(h.state.attempts.at(-1)?.phase).toBe("dispatched");
  }
});

test("resume requires the same thread, a new connection and a new exact child after joined close", () => {
  for (const patch of [{ threadTag: "d".repeat(64) }, { connectionTag: "b".repeat(64) }, { processIdentity: firstChild }]) {
    const h = history(); h.advance(12); h.prepare("resume");
    expect(() => h.settle({ ...summary("resume"), ...patch })).toThrow();
  }
  for (const patch of [{ stdoutEof: false }, { stderrEof: false }, { processIdentity: resumedChild }]) {
    const h = history(); h.advance(11); h.prepare("close"); expect(() => h.settle({ ...summary("close"), ...patch })).toThrow();
    expect(() => h.begin("resume")).toThrow();
  }
});

test("recorded Darwin identities reject every control byte and excessive or foreign shapes", () => {
  const h = history(); h.advance(6); const attempt = h.begin("start"); h.dispatch("process");
  for (const code of [...Array.from({ length: 32 }, (_, n) => n), 127]) {
    expect(() => h.event({ kind: "child", attemptId: attempt.attemptId, identity: { ...firstChild, procStart: `prefix${String.fromCharCode(code)}suffix` } })).toThrow();
  }
  for (const patch of [{ pidDomain: "linux" }, { pid: 0 }, { pid: 2147483648 }, { procStart: "x".repeat(257) }, { rawOutput: "refused" }]) {
    expect(() => h.event({ kind: "child", attemptId: attempt.attemptId, identity: { ...firstChild, ...patch } })).toThrow();
  }
  h.event({ kind: "child", attemptId: attempt.attemptId, identity: firstChild });
  h.settle();
});

test("turn decisions and deliberate interruption are fixed to their operations", () => {
  for (const operation of turnOperations) {
    const h = history(); h.advance(JOURNAL_OPERATIONS.indexOf(operation)); h.prepare(operation);
    const value = summary(operation); if (value.kind !== "turn") throw new Error("fixture_turn_missing");
    expect(() => h.settle({ ...value, interrupted: !value.interrupted })).toThrow();
    expect(() => h.settle({ ...value, decision: value.decision === null ? "once" : null })).toThrow();
    expect(() => h.settle({ ...value, deltaBytes: 1048577 })).toThrow();
    expect(() => h.settle({ ...value, raw: "unadmitted output" })).toThrow();
    h.settle(value);
  }
});

test("dispatch count bounds refuse excess work and never retain frame payloads", () => {
  const h = history(); h.advance(7); h.begin("stream_turn");
  for (let n = 0; n < 16; n++) h.dispatch("frame");
  expect(() => h.dispatch("frame")).toThrow();
  expect(h.state.attempts.at(-1)?.dispatches).toHaveLength(16);
  expect(JSON.stringify(h.state)).not.toContain("framePayload");
  const total = history();
  let saturated = false;
  for (const operation of JOURNAL_OPERATIONS) {
    total.prepare(operation);
    if (operation === "start" || operation === "resume" || turnOperations.includes(operation) || operation === "close" || operation === "close_final") {
      while ((total.state.attempts.at(-1)?.dispatches.length ?? 0) < 16) {
        if (total.state.attempts.flatMap((entry) => entry.dispatches).length === 128) { expect(() => total.dispatch("frame")).toThrow(); saturated = true; break; }
        total.dispatch("frame");
      }
    }
    if (saturated) break;
    total.settle();
  }
  expect(saturated).toBe(true);
});

test("unknown state, native provenance and malformed identifiers are rejected by the fixture seam", () => {
  const state = createCredentialFreeSessionJournal(id(1));
  for (const value of [null, [], { ...state, source: "native_session_qualification" }, { ...state, attempts: new Array(18).fill(null) }]) {
    expect(() => observeCredentialFreeSessionJournal(value, { kind: "failure", reason: "aborted" })).toThrow();
  }
  fc.assert(fc.property(fc.string({ maxLength: 128 }), (value) => {
    if (value.length !== 36) expect(() => createCredentialFreeSessionJournal(value)).toThrow();
  }), { numRuns: 128 });
});

test("sticky failure cannot clear, settle, dispatch or start another attempt", () => {
  const h = history(); h.prepare("version"); h.event({ kind: "failure", reason: "effect_uncertain" });
  for (const event of [{ kind: "failure", reason: null }, { kind: "failure", reason: "aborted" },
    { kind: "intent", operation: "login_help", attemptId: id(900) }, { kind: "settled", attemptId: h.attempt().attemptId, summary: summary("version") }]) {
    expect(() => h.event(event)).toThrow();
  }
  expect(h.state.failure).toBe("effect_uncertain");
});

// These cases exercise actual private files and native flock, but no provider or executable.
// They are opt-in so ordinary source sweeps never mint native session custody.
const nativeEnabled = process.env.OOMPA_CLAUDE_MACOS_SESSION_CUSTODY_NATIVE === "1";
const nativeTest = test.skipIf(!nativeEnabled);
const source = { sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), executable: { path: "/synthetic/immutable-runtime", device: 1, inode: 2 } };
const owners: { value: DarwinSessionCustody; ownerRelease: "held" | "released" | "uncertain" }[] = [];
const fresh = async () => { const value = await DarwinSessionCustody.createNative(source); owners.push({ value, ownerRelease: "held" }); return value; };
const release = async (value: DarwinSessionCustody) => {
  const entry = owners.find((item) => item.value === value); if (entry === undefined) throw new Error("fixture_owner_missing");
  entry.ownerRelease = "uncertain"; await value.releasePreserving(); entry.ownerRelease = "released";
};
afterAll(async () => {
  if (!nativeEnabled) return;
  for (const owner of owners) {
    if (owner.ownerRelease === "held") { try { await release(owner.value); } catch { /* Retained below, with no release claim or deletion. */ } }
  }
  process.stderr.write(`${JSON.stringify({ kind: "darwin_session_custody_fixture", rootsRemoved: false,
    owners: owners.map(({ value, ownerRelease }) => ({ runRoot: value.scope.runRoot, ownerRelease })) })}\n`);
  expect(owners.every((owner) => owner.ownerRelease === "released")).toBe(true);
});

nativeTest("fresh session custody uses distinct private roots, identities and a wiped proof-key loan", async () => {
  const value = await fresh(); const s = value.scope;
  expect(s.profileId).toMatch(/^acct_[0-9a-f]{32}$/u); expect(s.providerAccountId).toMatch(/^pact_[0-9a-f]{32}$/u);
  expect(s.generation).toBe(1); expect(basename(s.runtimeRoot)).toBe("runtime"); expect(value.state.operation).toBe("version");
  expect(s.runRoot).toMatch(/^\/private\/tmp\/oompa-ms-[A-Za-z0-9]{6}$/u);
  expect(Buffer.byteLength(join(s.runtimeRoot, "claude-host-tools.sock"))).toBeLessThan(104);
  for (const path of [s.profileRoot, s.temporaryRoot, s.projectRoot, s.runtimeRoot]) {
    expect((await lstat(path)).mode & 0o7777).toBe(0o700); expect(await readdir(path)).toEqual([]);
  }
  expect((await lstat(join(s.runRoot, "proof-key"))).size).toBe(32);
  expect((await lstat(s.receiptPath)).mode & 0o7777).toBe(0o600);
  let loan: Uint8Array | undefined;
  await value.withProofKey(async (bytes) => { loan = bytes; expect(bytes.byteLength).toBe(32); });
  const readLoan = () => loan; expect(readLoan()?.every((byte) => byte === 0)).toBe(true);
  await release(value); expect((await lstat(s.receiptPath)).isFile()).toBe(true);
  await expect(value.begin("version")).rejects.toThrow("closed");
});

nativeTest("native dispatch tickets require the exact attempt, one use and the current checkpoint", async () => {
  const value = await fresh(); const attempt = await value.begin("version");
  const ticket = await value.prepareDispatch(attempt, { kind: "process" }); ticket.assertCurrent();
  await value.acknowledgeDispatch(attempt, ticket.dispatchId); await value.settle(attempt, summary("version"));
  expect(value.state.operation).toBe("login_help");
  expect(() => ticket.assertCurrent()).toThrow(); expect(value.state.failure).not.toBeNull();
  const other = await fresh(); const otherAttempt = await other.begin("version");
  await expect(other.prepareDispatch({ ...otherAttempt }, { kind: "process" })).rejects.toThrow();
  expect(other.state.failure).not.toBeNull();
  const unconsumed = await fresh(); const pending = await unconsumed.begin("version");
  const unconsumedTicket = await unconsumed.prepareDispatch(pending, { kind: "process" });
  await expect(unconsumed.acknowledgeDispatch(pending, unconsumedTicket.dispatchId)).rejects.toThrow();
  expect(() => unconsumedTicket.assertCurrent()).toThrow();
});

nativeTest("frame dispatch persists only a run-and-dispatch HMAC of an owned byte snapshot", async () => {
  const value = await fresh();
  for (const operation of JOURNAL_OPERATIONS.slice(0, 6)) {
    const attempt = await value.begin(operation); const ticket = await value.prepareDispatch(attempt, { kind: "process" });
    ticket.assertCurrent(); await value.acknowledgeDispatch(attempt, ticket.dispatchId); await value.settle(attempt, summary(operation));
  }
  const attempt = await value.begin("start"); const processTicket = await value.prepareDispatch(attempt, { kind: "process" });
  processTicket.assertCurrent(); await value.recordChild(attempt, firstChild); await value.acknowledgeDispatch(attempt, processTicket.dispatchId);
  const original = Uint8Array.from(Buffer.from("synthetic-private-frame")); const caller = Uint8Array.from(original);
  const preparing = value.prepareDispatch(attempt, { kind: "frame", frame: caller }); caller.fill(0);
  const ticket = await preparing;
  const expected = await value.withProofKey(async (key) => createHmac("sha256", key)
    .update(JSON.stringify(["darwin-session-frame-v1", value.scope.runId, value.scope.ownerEpoch, attempt.attemptId, ticket.dispatchId])).update(original).digest("hex"));
  const dispatch = value.state.pending?.dispatches.at(-1);
  expect(dispatch).toMatchObject({ dispatchId: ticket.dispatchId, frameTag: expected, frameBytes: original.byteLength, acknowledged: false });
  expect(await readFile(value.scope.receiptPath, "utf8")).not.toContain("synthetic-private-frame");
  ticket.assertCurrent(); await value.acknowledgeDispatch(attempt, ticket.dispatchId); await value.settle(attempt, summary("start"));
  original.fill(0); await release(value);
});

nativeTest("owner, root, source checkpoint and key replacement refuse without deleting evidence", async () => {
  for (const kind of ["owner", "root", "receipt", "source", "key"] as const) {
    const value = await fresh(); const s = value.scope;
    const path = kind === "owner" ? s.receiptPath.replace(/\.recovery\.json$/u, ".lock") : kind === "root" ? s.profileRoot : kind === "key" ? join(s.runRoot, "proof-key") : s.receiptPath;
    const kept = `${path}.retained`;
    if (kind === "source") {
      const text = await readFile(path, "utf8");
      await writeFile(path, text.replace("a".repeat(40), "c".repeat(40)), { mode: 0o600 });
    } else {
      await rename(path, kept);
      if (kind === "root") await mkdir(path, { mode: 0o700 });
      else await writeFile(path, await readFile(kept), { mode: 0o600 });
    }
    await expect(value.assertCurrent()).rejects.toThrow("custody_refused");
    await expect(value.begin("version")).rejects.toThrow("custody_refused");
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    if (kind === "owner") {
      // Preserve both exact fixture files while returning the original name for a proved release.
      await rename(path, `${path}.replacement`); await rename(kept, path);
    }
    await release(value); expect((await lstat(s.runRoot)).isDirectory()).toBe(true);
  }
});

nativeTest("key permissions fail before any dispatch and the failed root stays present", async () => {
  const value = await fresh(); await chmod(join(value.scope.runRoot, "proof-key"), 0o644);
  await expect(value.begin("version")).rejects.toThrow("custody_refused");
  expect(value.state.journal.attempts).toHaveLength(0); await release(value);
  expect((await lstat(value.scope.runRoot)).isDirectory()).toBe(true);
});

nativeTest("persistence failure before or after publication closes admission without replay", async () => {
  for (const publish of [false, true]) {
    const value = await fresh();
    // Preserve the exact real receipt receiver while injecting a lost acknowledgement.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = AtomicPrivateJsonReceipt.prototype.update;
    const spy = spyOn(AtomicPrivateJsonReceipt.prototype, "update").mockImplementationOnce(async function (this: AtomicPrivateJsonReceipt<unknown>, transform) {
      if (publish) await original.call(this, transform); throw new Error("fixture_persistence_uncertain");
    });
    try { await expect(value.begin("version")).rejects.toThrow("persistence_uncertain"); } finally { spy.mockRestore(); }
    expect(value.state.failure).toBe("persistence_uncertain");
    await expect(value.begin("version")).rejects.toThrow("persistence_uncertain");
    const receipt = await readFile(value.scope.receiptPath, "utf8");
    expect(receipt.includes("intent")).toBe(publish); await release(value);
  }
});

nativeTest("concurrent mutation poisons both paths and retains ownership until the pending write settles", async () => {
  const value = await fresh(); const entered = Promise.withResolvers<undefined>(); const resume = Promise.withResolvers<undefined>();
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AtomicPrivateJsonReceipt.prototype.update;
  const spy = spyOn(AtomicPrivateJsonReceipt.prototype, "update").mockImplementationOnce(async function (this: AtomicPrivateJsonReceipt<unknown>, transform) {
    entered.resolve(undefined); await resume.promise; const saved: unknown = await original.call(this, transform); return saved;
  });
  const pending = value.begin("version"); const joined = Promise.allSettled([pending]);
  try {
    await Promise.race([entered.promise, Bun.sleep(1000).then(() => { throw new Error("fixture_write_barrier_missing"); })]);
    await expect(value.begin("version")).rejects.toThrow("concurrent_operation");
    await expect(value.releasePreserving()).rejects.toThrow();
  } finally { resume.resolve(undefined); await joined; spy.mockRestore(); }
  expect((await joined)[0].status).toBe("rejected"); expect(value.state.failure).toBe("concurrent_operation");
  await release(value); expect((await lstat(value.scope.receiptPath)).isFile()).toBe(true);
});

test("daemon seed custody has a fixed nine-operation family and cannot reuse session fixture provenance", () => {
  const h = history("daemon"); h.advance(9);
  expect(h.state.attempts.map((entry) => entry.attempt.operation)).toEqual([...DAEMON_SEED_OPERATIONS]);
  expect(h.state.attempts.at(-1)?.summary).toEqual(summary("close"));
  expect(h.state.source).toBe("credential_free_daemon_seed_fixture");
  expect(() => h.begin("logout")).toThrow();
  expect(() => h.begin("resume")).toThrow();
  expect(() => observeCredentialFreeSessionJournal(h.state, { kind: "failure", reason: "aborted" })).toThrow();
  const original = history(); original.advance(8);
  expect(() => observeCredentialFreeDaemonSeedJournal(original.state, { kind: "failure", reason: "aborted" })).toThrow();
  expect(() => observeCredentialFreeDaemonSeedJournal({ ...h.state, source: "native_daemon_seed_qualification" }, { kind: "failure", reason: "aborted" })).toThrow();
});

test("daemon seed custody retains the original close and uncertain-dispatch barriers", () => {
  const h = history("daemon"); h.advance(8); h.prepare("close");
  expect(() => h.settle({ ...summary("close"), stdoutEof: false })).toThrow();
  const initial = history("daemon"); initial.begin("version"); initial.dispatch("process", false);
  expect(() => initial.settle()).toThrow();
  expect(initial.state.attempts.at(-1)?.phase).toBe("dispatched");
});
