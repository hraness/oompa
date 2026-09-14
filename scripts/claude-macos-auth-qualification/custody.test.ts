import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, spyOn, test } from "bun:test";

import { assertPrivateDirectoryIdentity, AtomicPrivateJsonReceipt, observePrivateDirectory, type AtomicPrivateJsonPolicy } from "../live-acceptance-private-custody.ts";
import { QualificationCustody, type QualificationCustodySource, type QualificationDispatchScope } from "./custody.ts";
import { qualificationTag } from "./identity.ts";
import { encodeNativeQualificationCheckpoint, encodeQualificationCheckpoint } from "./receipt.ts";
import { createNativeQualification, createQualification, observeQualification, publicQualificationReceipt, QUALIFICATION_CLEANUP_ROOTS,
  type QualificationResult, type QualificationState } from "./state.ts";

const enabled = process.env.OOMPA_CLAUDE_MACOS_AUTH_CUSTODY_NATIVE === "1";
const nativeTest = test.skipIf(!enabled);
const source: QualificationCustodySource = { sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), executable: { path: "/synthetic/immutable-claude", device: 1, inode: 2 } };
const owners: { value: QualificationCustody; released: boolean }[] = [];
const roots = new Map<string, QualificationState["binding"]["runRoot"]>();
const keep = (value: QualificationCustody): QualificationCustody => {
  owners.push({ value, released: false }); roots.set(value.recoveryRoot, value.state.binding.runRoot); return value;
};
const fresh = async (): Promise<QualificationCustody> => keep(await QualificationCustody.create(source));
const freshNative = async (): Promise<QualificationCustody> => keep(await QualificationCustody.createNative(source));
const release = async (value: QualificationCustody): Promise<void> => {
  await value.releasePreserving();
  const owner = owners.find((entry) => entry.value === value); if (owner !== undefined) owner.released = true;
};
const reopen = async (value: QualificationCustody): Promise<QualificationCustody> => keep(await QualificationCustody.restore({ runId: value.runId, runRoot: value.recoveryRoot, source }));
const reopenNative = async (value: QualificationCustody): Promise<QualificationCustody> => keep(await QualificationCustody.restoreNative({ runId: value.runId, runRoot: value.recoveryRoot, source }));
const encodeFor = (value: QualificationCustody, state: QualificationState, key: Uint8Array): Uint8Array => value.mode === "native_qualification"
  ? encodeNativeQualificationCheckpoint(state, key) : encodeQualificationCheckpoint(state, key);
const scopeFor = (value: QualificationCustody, profile: "A" | "B" = "A"): QualificationDispatchScope => ({
  runId: value.runId, attemptId: value.state.pending?.attemptId ?? randomUUID(), profile, probeId: randomUUID(),
});
const validation = (state: QualificationState) => ({ bindingTag: state.bindingTag, sourceAndExecutableRevalidated: true, privateCustodyRevalidated: true, environmentRevalidated: true });
const joined = { childJoined: true, stdoutJoined: true, stderrJoined: true } as const;
const detached = { setsidChecked: true, newSession: true, controllingTty: false, stdinClosed: true } as const;
const probes: Readonly<Record<number, readonly (readonly ["A" | "B", boolean])[]>> = {
  0: [["A", false], ["B", false]], 2: [["A", true]], 3: [["B", false]], 5: [["B", true]],
  6: [["A", true]], 7: [["B", true]], 8: [["A", true]], 9: [["A", true], ["B", true]],
  10: [["A", true], ["B", true]], 12: [["A", false], ["B", true]], 14: [["A", false], ["B", true]],
  16: [["A", true]], 18: [["A", true], ["B", false]], 20: [["A", false], ["B", false]],
};
function result(state: QualificationState, key: Uint8Array, attemptId: string): QualificationResult {
  const step = state.step;
  if (step === 1 || step === 4 || step === 13 || step === 15) return { kind: "login", ...joined, transcriptsRetained: false,
    ownerObservation: step === 1 ? "signed_in_A" : step === 4 ? "signed_in_B_distinct" : step === 13 ? "interrupted_before_browser_completion" : "recovered_A" };
  if (step === 11 || step === 17 || step === 19) return { kind: "logout", ...joined, nativeLogoutExitZero: true };
  if (step === 21) return { kind: "cleanup", ...joined, profileAndTemporaryRootsRemoved: true, protectedEvidenceRetained: true, custodyRevalidated: true,
    rootDeletions: [
      { root: "profileA", intentPersisted: true, removalReconciled: true }, { root: "profileB", intentPersisted: true, removalReconciled: true },
      { root: "temporaryA", intentPersisted: true, removalReconciled: true }, { root: "temporaryB", intentPersisted: true, removalReconciled: true },
    ] };
  const expected = probes[step]; if (expected === undefined) throw new Error("synthetic_step_missing");
  const observations = expected.map(([profile, signedIn]) => ({ detached: step >= 6 ? detached : null, identity: {
    runId: state.binding.runId, attemptId, probeId: randomUUID(), profile, profileTag: state.profileTags[profile], signedIn,
    accountTag: signedIn ? qualificationTag(key, state.binding.runId, "account", profile) : null,
    emailTag: signedIn ? qualificationTag(key, state.binding.runId, "email", `${profile}@example.invalid`) : null,
    organizationTag: signedIn ? qualificationTag(key, state.binding.runId, "organization", "synthetic") : null, evidence: "reported_identity_only" as const,
  } }));
  if (step === 0) return { kind: "preflight", ...joined, probes: observations, freshEmptyRoots: true, keyPrivate: true, ownerHeld: true,
    exactVersionBoth: true, loginHelpBoth: true, logoutHelpBoth: true, signatureRevalidated: true, realHomePreserved: true, environmentAllowlisted: true };
  return { kind: "probe", ...joined, probes: observations, concurrentOverlapObserved: step === 9, ownerObservedNoGraphicalPrompt: true };
}
const save = async (value: QualificationCustody, state: QualificationState): Promise<void> => {
  expect(state.failure).toBeNull();
  await value.withProofKey(async (key) => { await value.persist(encodeFor(value, state, key)); });
};
async function prepareDispatch(value: QualificationCustody): Promise<void> {
  let state = value.state; const attemptId = randomUUID();
  state = observeQualification(state, { type: "intent", step: state.step, attemptId }); await save(value, state);
  state = observeQualification(state, { type: "persisted", attemptId }); await save(value, state);
  state = observeQualification(state, { type: "dispatch", attemptId, ...validation(state) }); await save(value, state);
}
async function prepareCleanup(value: QualificationCustody): Promise<void> {
  await value.withProofKey(async (key) => {
    let state = value.state;
    for (let step = 0; step <= 21; step += 1) {
      const attemptId = randomUUID();
      state = observeQualification(state, { type: "intent", attemptId, step });
      state = observeQualification(state, { type: "persisted", attemptId });
      state = observeQualification(state, { type: "dispatch", attemptId, ...validation(state) });
      if (step < 21) state = observeQualification(state, { type: "settled", attemptId, result: result(state, key, attemptId) });
      expect(state.failure).toBeNull();
    }
    // No provider effect is involved: this is an explicitly synthetic history.
    await value.persist(encodeFor(value, state, key));
  });
}
async function resume(value: QualificationCustody): Promise<void> {
  const state = value.state;
  await save(value, observeQualification(state, { type: "resume", ownerEpoch: value.ownerEpoch, ...validation(state) }));
}
async function intent(value: QualificationCustody, root: typeof QUALIFICATION_CLEANUP_ROOTS[number]): Promise<void> {
  const state = value.state;
  await save(value, observeQualification(state, { type: "cleanup_root_intent", attemptId: state.pending?.attemptId, root }));
}
async function removed(value: QualificationCustody, root: typeof QUALIFICATION_CLEANUP_ROOTS[number]): Promise<void> {
  const state = value.state;
  await save(value, observeQualification(state, { type: "cleanup_root_removed", attemptId: state.pending?.attemptId, root }));
}

nativeTest("fresh custody creates only private fixed roots and keeps its noncredential key private", async () => {
  const value = await fresh(); const state = value.state;
  expect(state.binding.realHome).toBe(homedir());
  for (const name of QUALIFICATION_CLEANUP_ROOTS) {
    expect((await lstat(state.binding[name].path)).mode & 0o7777).toBe(0o700);
    expect(await readdir(state.binding[name].path)).toEqual([]);
  }
  const key = await lstat(state.binding.proofKey.path);
  expect([key.size, key.mode & 0o7777, key.nlink]).toEqual([32, 0o600, 1]);
  expect((await lstat(value.receiptPath)).mode & 0o7777).toBe(0o600);
  let copied: Uint8Array | undefined;
  await value.withProofKey(async (bytes) => { copied = bytes; expect(bytes.byteLength).toBe(32); });
  expect(copied?.every((byte) => byte === 0)).toBe(true);
  await expect(reopen(value)).rejects.toThrow("concurrent_owner");
  expect(publicQualificationReceipt(state)).toMatchObject({ liveQualificationProven: false, activationAuthorized: false });
});

nativeTest("root removal refuses without the full logout/both-out sequence and durable exact intent", async () => {
  const initial = await fresh(); const root = initial.state.binding.profileA.path;
  await expect(initial.removeRoot("profileA")).rejects.toThrow("recovery_required");
  expect((await lstat(root)).isDirectory()).toBe(true);
  const value = await fresh(); await prepareCleanup(value);
  await expect(value.removeRoot("profileA")).rejects.toThrow("recovery_required");
  expect((await lstat(value.recoveryRoot)).isDirectory()).toBe(true);
});

nativeTest("interrupted quarantine and completed removal reconcile without recreating a profile", async () => {
  const first = await fresh(); await prepareCleanup(first); await intent(first, "profileA");
  const profile = first.state.binding.profileA.path;
  await rename(profile, join(first.recoveryRoot, ".quarantine-profileA"));
  await release(first);
  const second = await reopen(first); expect(second.state.needsRecovery).toBe(true); await resume(second);
  expect(await second.removeRoot("profileA")).toEqual({ root: "profileA", removalReconciled: true });
  await release(second); // Deliberately omit the removal checkpoint to model a lost response.
  const third = await reopen(second); await resume(third);
  expect(await third.removeRoot("profileA")).toEqual({ root: "profileA", removalReconciled: true });
  await removed(third, "profileA");
  await expect(lstat(profile)).rejects.toThrow();
  expect(third.state.cleanupRoots).toEqual([{ root: "profileA", stage: "removed" }]);
});

nativeTest("restored suspension cannot be erased by an old checkpoint or an unrelated owner epoch", async () => {
  for (const stale of [true, false]) {
    const initial = await fresh(); await prepareCleanup(initial); await intent(initial, "profileA");
    const profile = initial.state.binding.profileA.path;
    const old = await initial.withProofKey(async (key) => encodeQualificationCheckpoint(initial.state, key));
    await release(initial);
    const recovered = await reopen(initial);
    expect(recovered.state.needsRecovery).toBe(true);
    if (stale) await expect(recovered.persist(old)).rejects.toThrow("recovery_required");
    else {
      const state = recovered.state;
      const unrelated = observeQualification(state, { type: "resume", ownerEpoch: randomUUID(), ...validation(state) });
      await expect(save(recovered, unrelated)).rejects.toThrow("recovery_required");
    }
    expect((await lstat(profile)).isDirectory()).toBe(true);
    await expect(recovered.removeRoot("profileA")).rejects.toThrow("recovery_required");
    await release(recovered);
    const current = await reopen(recovered); await resume(current);
    expect(current.state.ownerEpoch).toBe(current.ownerEpoch);
    expect(await current.removeRoot("profileA")).toEqual({ root: "profileA", removalReconciled: true });
  }
});

nativeTest("restore refuses an unrelated private temporary root before creating a lock", async () => {
  const value = await fresh();
  const path = join(dirname(value.recoveryRoot), `unrelated-custody-fixture-${randomUUID()}`);
  await mkdir(path, { mode: 0o700 });
  roots.set(path, await observePrivateDirectory(path, () => new Error("synthetic_root_refused")));
  await expect(QualificationCustody.restore({ runId: value.runId, runRoot: path, source })).rejects.toThrow("custody_refused");
  expect(await readdir(path)).toEqual([]);
});

nativeTest("both-present and substituted quarantine identities refuse without deleting either path", async () => {
  for (const recreateOriginal of [true, false]) {
    const value = await fresh(); await prepareCleanup(value); await intent(value, "profileA");
    const profile = value.state.binding.profileA.path; const quarantine = join(value.recoveryRoot, ".quarantine-profileA");
    await rename(profile, quarantine);
    if (recreateOriginal) await mkdir(profile, { mode: 0o700 });
    else { await rename(quarantine, join(value.recoveryRoot, "retained-original")); await mkdir(quarantine, { mode: 0o700 }); }
    await expect(value.removeRoot("profileA")).rejects.toThrow("recovery_required");
    expect((await lstat(quarantine)).isDirectory()).toBe(true);
    if (recreateOriginal) expect((await lstat(profile)).isDirectory()).toBe(true);
  }
});

nativeTest("key symlink, hardlink, mode, size and incarnation changes refuse current custody", async () => {
  for (const mode of ["symlink", "hardlink", "permissions", "size", "replacement"]) {
    const value = await fresh(); const keyPath = value.state.binding.proofKey.path;
    if (mode === "permissions") await chmod(keyPath, 0o644);
    else if (mode === "size") await writeFile(keyPath, Buffer.alloc(31));
    else if (mode === "hardlink") await link(keyPath, join(value.recoveryRoot, "key-link"));
    else {
      const old = join(value.recoveryRoot, "retained-key"); await rename(keyPath, old);
      if (mode === "symlink") await symlink(old, keyPath);
      else await writeFile(keyPath, await readFile(old), { mode: 0o600 });
    }
    await expect(value.assertCurrent()).rejects.toThrow("recovery_required");
  }
});

nativeTest("tampered receipts and mismatched source cannot restore effect authority", async () => {
  for (const mode of ["truncated", "mac", "source"]) {
    const value = await fresh(); await release(value);
    if (mode === "truncated") await writeFile(value.receiptPath, "{");
    if (mode === "mac") {
      const record = JSON.parse(await readFile(value.receiptPath, "utf8")) as { checkpoint: string };
      const checkpoint = JSON.parse(Buffer.from(record.checkpoint, "base64").toString("utf8")) as { mac: string };
      checkpoint.mac = "0".repeat(64); record.checkpoint = Buffer.from(JSON.stringify(checkpoint)).toString("base64");
      await writeFile(value.receiptPath, JSON.stringify(record));
    }
    await expect(QualificationCustody.restore({ runId: value.runId, runRoot: value.recoveryRoot,
      source: mode === "source" ? { ...source, sourceSha: "c".repeat(40) } : source })).rejects.toThrow("recovery_required");
    expect((await lstat(value.recoveryRoot)).isDirectory()).toBe(true);
  }
});

nativeTest("uncertain checkpoint acknowledgement poisons the owner and retains recoverable evidence", async () => {
  const value = await fresh(); const previous = value.state;
  const next = observeQualification(previous, { type: "intent", attemptId: randomUUID(), step: 0 });
  // The explicit .call below preserves the real receipt receiver before losing its acknowledgement.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AtomicPrivateJsonReceipt.prototype.update;
  const spy = spyOn(AtomicPrivateJsonReceipt.prototype, "update").mockImplementationOnce(async function (this: AtomicPrivateJsonReceipt<unknown>, transform) {
    await original.call(this, transform); throw new Error("synthetic lost persistence acknowledgement");
  });
  try { await expect(save(value, next)).rejects.toThrow("recovery_required"); }
  finally { spy.mockRestore(); }
  await expect(value.assertCurrent()).rejects.toThrow("recovery_required");
  await release(value);
  const restored = await reopen(value);
  expect(restored.state.needsRecovery).toBe(true);
  expect(restored.state.pending?.attemptId).toBe(next.pending?.attemptId);
});

nativeTest("a persisted malformed-input failure cannot be erased by an unchanged event journal", async () => {
  const value = await fresh();
  await value.withProofKey(async (key) => {
    const failed = observeQualification(value.state, { type: "invalid_synthetic_event" });
    expect(failed.failure).toBe("invalid_input");
    await value.persist(encodeQualificationCheckpoint(failed, key));
    await expect(value.persist(encodeQualificationCheckpoint({ ...failed, failure: null }, key))).rejects.toThrow("recovery_required");
  });
});

nativeTest("an in-flight checkpoint keeps the native owner until its write has settled", async () => {
  const value = await fresh();
  let entered!: () => void; let resumeWrite!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const continueWrite = new Promise<void>((resolve) => { resumeWrite = resolve; });
  // The controlled write still executes with its exact original receipt receiver.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AtomicPrivateJsonReceipt.prototype.update;
  const spy = spyOn(AtomicPrivateJsonReceipt.prototype, "update").mockImplementationOnce(async function (this: AtomicPrivateJsonReceipt<unknown>, transform) {
    entered(); await continueWrite;
    const saved: unknown = await original.call(this, transform); return saved;
  });
  const next = observeQualification(value.state, { type: "intent", attemptId: randomUUID(), step: 0 });
  const pending = save(value, next);
  try {
    await Promise.race([writing, Bun.sleep(2000).then(() => { throw new Error("synthetic_write_barrier_unreached"); })]);
    await expect(value.releasePreserving()).rejects.toThrow("custody_refused");
    await expect(reopen(value)).rejects.toThrow("concurrent_owner");
  } finally { resumeWrite(); await pending; spy.mockRestore(); }
  await value.assertCurrent();
});

nativeTest("terminal restore verifies retained evidence while all deleted roots remain historical", async () => {
  const value = await fresh(); await prepareCleanup(value);
  for (const root of QUALIFICATION_CLEANUP_ROOTS) {
    await intent(value, root); await value.removeRoot(root); await removed(value, root);
  }
  await value.withProofKey(async (key) => {
    const current = value.state; const attemptId = current.pending?.attemptId;
    if (attemptId === undefined) throw new Error("synthetic_pending_missing");
    const completed = observeQualification(current, { type: "settled", attemptId, result: result(current, key, attemptId) });
    await value.persist(encodeQualificationCheckpoint(completed, key));
  });
  const binding = value.state.binding; await release(value);
  const restored = await reopen(value);
  expect(publicQualificationReceipt(restored.state)).toMatchObject({ syntheticSequenceComplete: true, liveQualificationProven: false, activationAuthorized: false, recoveryRequired: false });
  for (const root of QUALIFICATION_CLEANUP_ROOTS) await expect(lstat(binding[root].path)).rejects.toThrow();
  expect((await lstat(binding.proofKey.path)).size).toBe(32);
  await restored.withProofKey(async (key) => { await expect(restored.persist(encodeQualificationCheckpoint(restored.state, key))).rejects.toThrow("custody_refused"); });
  await restored.assertCurrent();
});

nativeTest("native custody creates a distinct authenticated mode and both cross-mode restores refuse", async () => {
  const fixture = await fresh(); const native = await freshNative();
  expect(fixture.mode).toBe("credential_free_fixture");
  expect(native.mode).toBe("native_qualification");
  expect(native.state.binding).toMatchObject({ version: 2, mode: "native_qualification" });
  await release(fixture); await release(native);
  await expect(reopenNative(fixture)).rejects.toThrow("recovery_required");
  await expect(reopen(native)).rejects.toThrow("recovery_required");
  const restoredFixture = await reopen(fixture); const restoredNative = await reopenNative(native);
  expect(restoredFixture.mode).toBe("credential_free_fixture");
  expect(restoredNative.mode).toBe("native_qualification");
  expect(publicQualificationReceipt(restoredNative.state)).toMatchObject({ syntheticSequenceComplete: false, liveQualificationProven: false, activationAuthorized: false });
});

nativeTest("a same-key same-run foreign-mode checkpoint cannot change held custody provenance", async () => {
  for (const native of [false, true]) {
    const value = native ? await freshNative() : await fresh();
    await value.withProofKey(async (key) => {
      const state = value.state;
      let changed: QualificationState;
      if (state.binding.version === 2) {
        const { mode: discarded, ...base } = state.binding; void discarded;
        changed = createQualification({ ...base, version: 1 }, key, state.initialOwnerEpoch);
      } else changed = createNativeQualification({ ...state.binding, version: 2, mode: "native_qualification" }, key, state.initialOwnerEpoch);
      const foreign = native ? encodeQualificationCheckpoint(changed, key) : encodeNativeQualificationCheckpoint(changed, key);
      await expect(value.persist(foreign)).rejects.toThrow("recovery_required");
    });
    await release(value);
    const restored = native ? await reopenNative(value) : await reopen(value);
    expect(restored.mode).toBe(native ? "native_qualification" : "credential_free_fixture");
  }
});

nativeTest("launch tickets require native mode and an actually persisted dispatched attempt", async () => {
  const fixture = await fresh(); await prepareDispatch(fixture);
  await expect(fixture.prepareDispatchAuthority(scopeFor(fixture))).rejects.toThrow("custody_refused");
  const value = await freshNative();
  await expect(value.prepareDispatchAuthority(scopeFor(value))).rejects.toThrow("custody_refused");
  const attemptId = randomUUID();
  let state = observeQualification(value.state, { type: "intent", attemptId, step: 0 }); await save(value, state);
  await expect(value.prepareDispatchAuthority(scopeFor(value))).rejects.toThrow("custody_refused");
  state = observeQualification(state, { type: "persisted", attemptId }); await save(value, state);
  await expect(value.prepareDispatchAuthority(scopeFor(value))).rejects.toThrow("custody_refused");
  state = observeQualification(state, { type: "dispatch", attemptId, ...validation(state) });
  await expect(value.prepareDispatchAuthority(scopeFor(value))).rejects.toThrow("custody_refused");
  await save(value, state);
  const scope = scopeFor(value); const authority = await value.prepareDispatchAuthority(scope);
  expect(() => authority.assertCurrent(scope)).not.toThrow();
});

nativeTest("both pair tickets prepare before use, keep exact captured scopes and cannot replay", async () => {
  const value = await freshNative(); await prepareDispatch(value);
  const a = scopeFor(value); const b = scopeFor(value, "B");
  const [first, second] = await Promise.all([value.prepareDispatchAuthority(a), value.prepareDispatchAuthority(b)]);
  expect(() => first.assertCurrent(a)).not.toThrow();
  expect(() => second.assertCurrent(b)).not.toThrow();
  expect(() => first.assertCurrent(a)).toThrow("custody_refused");
  await expect(value.prepareDispatchAuthority(a)).rejects.toThrow("custody_refused");
  const original = scopeFor(value); const mutable = { ...original };
  const preparing = value.prepareDispatchAuthority(mutable); mutable.profile = "B";
  const captured = await preparing;
  expect(() => captured.assertCurrent(original)).not.toThrow();
  const wrong = scopeFor(value); const single = await value.prepareDispatchAuthority(wrong);
  expect(() => single.assertCurrent({ ...wrong, profile: "B" })).toThrow("custody_refused");
  expect(() => single.assertCurrent(wrong)).toThrow("custody_refused");
});

nativeTest("ticket preparation rejects stale or malformed scope, including unknown authority flags", async () => {
  const value = await freshNative(); await prepareDispatch(value); const scope = scopeFor(value);
  for (const patch of [{ runId: randomUUID() }, { attemptId: randomUUID() }, { probeId: "invalid" }, { profile: "C" }, { sourceChecked: true }]) {
    await expect(value.prepareDispatchAuthority({ ...scope, ...patch } as QualificationDispatchScope)).rejects.toThrow("custody_refused");
  }
  const ticket = await value.prepareDispatchAuthority(scope);
  expect(() => ticket.assertCurrent({ ...scope, sourceChecked: true } as QualificationDispatchScope)).toThrow("custody_refused");
  expect(() => ticket.assertCurrent(scope)).toThrow("custody_refused");
});

nativeTest("checkpoint replacement invalidates every prepared ticket without consuming its sibling", async () => {
  const value = await freshNative(); await prepareDispatch(value);
  const a = scopeFor(value); const b = scopeFor(value, "B");
  const first = await value.prepareDispatchAuthority(a); const second = await value.prepareDispatchAuthority(b);
  await save(value, value.state);
  expect(() => first.assertCurrent(a)).toThrow("custody_refused");
  expect(() => second.assertCurrent(b)).toThrow("custody_refused");
  const scope = scopeFor(value); const current = await value.prepareDispatchAuthority(scope);
  expect(() => current.assertCurrent(scope)).not.toThrow();
});

nativeTest("synchronous ticket checks detect replaced receipts, lost lock incarnation and release", async () => {
  for (const changed of ["receipt", "owner", "release"] as const) {
    const value = await freshNative(); await prepareDispatch(value);
    const scope = scopeFor(value); const ticket = await value.prepareDispatchAuthority(scope);
    if (changed === "release") {
      await release(value); expect(() => ticket.assertCurrent(scope)).toThrow("closed");
    } else if (changed === "receipt") {
      const original = join(value.recoveryRoot, "retained-ticket-receipt");
      await rename(value.receiptPath, original);
      await writeFile(value.receiptPath, await readFile(original), { mode: 0o600 });
      expect(() => ticket.assertCurrent(scope)).toThrow("recovery_required");
    } else {
      const lock = join(value.recoveryRoot, `.oompa-macos-auth-qualification-${value.runId}.lock`);
      const held = join(value.recoveryRoot, "retained-ticket-lock");
      await rename(lock, held);
      try {
        await writeFile(lock, "", { mode: 0o600 });
        expect(() => ticket.assertCurrent(scope)).toThrow("recovery_required");
        await expect(value.prepareDispatchAuthority({ ...scope, probeId: randomUUID() })).rejects.toThrow("recovery_required");
      } finally { await rm(lock); await rename(held, lock); }
    }
  }
});

nativeTest("native creation refuses a receipt replaced after the atomic helper verified it", async () => {
  let retained: Readonly<{ runId: string; runRoot: string }> | undefined;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AtomicPrivateJsonReceipt.create;
  const spy = spyOn(AtomicPrivateJsonReceipt, "create").mockImplementationOnce(async function<T>(input: T, policy: AtomicPrivateJsonPolicy<T>): Promise<AtomicPrivateJsonReceipt<T>> {
    const receipt = await original(input, policy);
    const path = policy.path(receipt.value); const runRoot = dirname(path);
    const value = receipt.value as { runId: string };
    retained = { runId: value.runId, runRoot };
    roots.set(runRoot, await observePrivateDirectory(runRoot, () => new Error("synthetic_root_refused")));
    const kept = join(runRoot, "retained-postcreate-receipt");
    await rename(path, kept); await writeFile(path, await readFile(kept), { mode: 0o600 });
    return receipt;
  });
  try { await expect(freshNative()).rejects.toThrow("recovery_required"); }
  finally { spy.mockRestore(); }
  const readRetained = () => retained;
  const scope = readRetained(); if (scope === undefined) throw new Error("synthetic_retained_root_missing");
  // Fresh native ownership positively establishes release of the refused creation's lock.
  const restored = keep(await QualificationCustody.restoreNative({ ...scope, source }));
  expect(restored.state.needsRecovery).toBe(true);
});

nativeTest("native restore refuses a same-byte replacement after the atomic open verified it", async () => {
  const value = await freshNative(); await release(value);
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AtomicPrivateJsonReceipt.open;
  const spy = spyOn(AtomicPrivateJsonReceipt, "open").mockImplementationOnce(async function<T>(input: T, policy: AtomicPrivateJsonPolicy<T>): Promise<AtomicPrivateJsonReceipt<T>> {
    const receipt = await original(input, policy);
    const path = policy.path(receipt.value); const kept = join(value.recoveryRoot, "retained-postopen-receipt");
    await rename(path, kept); await writeFile(path, await readFile(kept), { mode: 0o600 });
    return receipt;
  });
  try { await expect(reopenNative(value)).rejects.toThrow("recovery_required"); }
  finally { spy.mockRestore(); }
  const restored = await reopenNative(value);
  expect(restored.state.needsRecovery).toBe(true);
});

nativeTest("post-update inode or content replacement cannot become a new ticket baseline", async () => {
  for (const substitution of ["same_bytes_new_inode", "same_inode_changed_encoding"] as const) {
    const value = await freshNative(); await prepareDispatch(value);
    const scope = scopeFor(value); const ticket = await value.prepareDispatchAuthority(scope);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = AtomicPrivateJsonReceipt.prototype.update;
    const spy = spyOn(AtomicPrivateJsonReceipt.prototype, "update").mockImplementationOnce(async function (this: AtomicPrivateJsonReceipt<unknown>, transform) {
      const saved: unknown = await original.call(this, transform);
      const contents = await readFile(value.receiptPath);
      if (substitution === "same_bytes_new_inode") await rename(value.receiptPath, join(value.recoveryRoot, "retained-postupdate-receipt"));
      const changed = substitution === "same_bytes_new_inode" ? contents : Buffer.concat([contents, Buffer.from("\n")]);
      await writeFile(value.receiptPath, changed, { mode: 0o600 });
      return saved;
    });
    try { await expect(save(value, value.state)).rejects.toThrow("recovery_required"); }
    finally { spy.mockRestore(); }
    expect(() => ticket.assertCurrent(scope)).toThrow("recovery_required");
    await expect(value.prepareDispatchAuthority({ ...scope, probeId: randomUUID() })).rejects.toThrow("recovery_required");
    await release(value);
    const restored = await reopenNative(value);
    expect(restored.state.pending?.stage).toBe("dispatched");
    await expect(restored.prepareDispatchAuthority({ ...scope, probeId: randomUUID() })).rejects.toThrow("custody_refused");
  }
});

nativeTest("uncertain persistence before or after publication invalidates already prepared authority", async () => {
  for (const publish of [false, true]) {
    const value = await freshNative(); await prepareDispatch(value);
    const scope = scopeFor(value); const ticket = await value.prepareDispatchAuthority(scope);
    const previous = value.state;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const original = AtomicPrivateJsonReceipt.prototype.update;
    const spy = spyOn(AtomicPrivateJsonReceipt.prototype, "update").mockImplementationOnce(async function (this: AtomicPrivateJsonReceipt<unknown>, transform) {
      if (publish) await original.call(this, transform);
      throw new Error("synthetic native checkpoint uncertainty");
    });
    try { await expect(save(value, previous)).rejects.toThrow("recovery_required"); }
    finally { spy.mockRestore(); }
    expect(() => ticket.assertCurrent(scope)).toThrow("recovery_required");
    await release(value);
    const restored = await reopenNative(value);
    expect(restored.state.needsRecovery).toBe(true);
    expect(restored.state.pending).toEqual(previous.pending);
    await expect(restored.prepareDispatchAuthority({ ...scope, probeId: randomUUID() })).rejects.toThrow("custody_refused");
  }
});

nativeTest("an in-flight native checkpoint closes ticket admission until publication settles", async () => {
  const value = await freshNative(); await prepareDispatch(value);
  const scope = scopeFor(value); const ticket = await value.prepareDispatchAuthority(scope);
  const nextScope = scopeFor(value);
  let entered!: () => void; let resumeWrite!: () => void;
  const writing = new Promise<void>((resolve) => { entered = resolve; });
  const continueWrite = new Promise<void>((resolve) => { resumeWrite = resolve; });
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = AtomicPrivateJsonReceipt.prototype.update;
  const spy = spyOn(AtomicPrivateJsonReceipt.prototype, "update").mockImplementationOnce(async function (this: AtomicPrivateJsonReceipt<unknown>, transform) {
    entered(); await continueWrite;
    const saved: unknown = await original.call(this, transform); return saved;
  });
  const pending = save(value, value.state);
  try {
    await Promise.race([writing, Bun.sleep(2000).then(() => { throw new Error("synthetic_write_barrier_unreached"); })]);
    expect(() => ticket.assertCurrent(scope)).toThrow("custody_refused");
    await expect(value.prepareDispatchAuthority(nextScope)).rejects.toThrow("custody_refused");
    await expect(value.releasePreserving()).rejects.toThrow("custody_refused");
  } finally { resumeWrite(); try { await pending; } finally { spy.mockRestore(); } }
  const current = await value.prepareDispatchAuthority(nextScope);
  expect(() => current.assertCurrent(nextScope)).not.toThrow();
});

nativeTest("native restored-pending custody cannot regain launch authority through reducer reconciliation", async () => {
  const value = await freshNative(); await prepareDispatch(value); await release(value);
  const restored = await reopenNative(value); await resume(restored);
  await restored.withProofKey(async (key) => {
    const state = restored.state; const attemptId = state.pending?.attemptId;
    if (attemptId === undefined) throw new Error("synthetic_pending_missing");
    // This tests the boundary against supplied reducer facts; it is not native reconciliation.
    const next = observeQualification(state, { type: "reconciled", attemptId, result: result(state, key, attemptId) });
    await expect(restored.persist(encodeNativeQualificationCheckpoint(next, key))).rejects.toThrow("recovery_required");
  });
  await release(restored);
  const again = await reopenNative(restored);
  expect(again.state.needsRecovery).toBe(true);
  expect(again.state.pending?.stage).toBe("dispatched");
  await expect(again.prepareDispatchAuthority(scopeFor(again))).rejects.toThrow("custody_refused");
});

nativeTest("native restore at a durably settled boundary can resume only with its fresh owner epoch", async () => {
  const value = await freshNative(); await prepareDispatch(value);
  await value.withProofKey(async (key) => {
    const state = value.state; const attemptId = state.pending?.attemptId;
    if (attemptId === undefined) throw new Error("synthetic_pending_missing");
    await value.persist(encodeNativeQualificationCheckpoint(observeQualification(state, { type: "settled", attemptId, result: result(state, key, attemptId) }), key));
  });
  const oldEpoch = value.ownerEpoch; await release(value);
  const restored = await reopenNative(value);
  expect(restored.state.pending).toBeNull(); expect(restored.state.needsRecovery).toBe(true);
  expect(restored.ownerEpoch).not.toBe(oldEpoch);
  await expect(restored.prepareDispatchAuthority(scopeFor(restored))).rejects.toThrow("custody_refused");
  await resume(restored); await prepareDispatch(restored);
  const scope = scopeFor(restored); const ticket = await restored.prepareDispatchAuthority(scope);
  expect(() => ticket.assertCurrent(scope)).not.toThrow();
});

nativeTest("native terminal restore retains its mode and cannot authorize more effects or root recreation", async () => {
  const value = await freshNative(); await prepareCleanup(value);
  for (const root of QUALIFICATION_CLEANUP_ROOTS) { await intent(value, root); await value.removeRoot(root); await removed(value, root); }
  await value.withProofKey(async (key) => {
    const state = value.state; const attemptId = state.pending?.attemptId;
    if (attemptId === undefined) throw new Error("synthetic_pending_missing");
    await value.persist(encodeNativeQualificationCheckpoint(observeQualification(state, { type: "settled", attemptId, result: result(state, key, attemptId) }), key));
  });
  const binding = value.state.binding; await release(value);
  const restored = await reopenNative(value);
  expect(restored.state.step).toBe(22); expect(restored.mode).toBe("native_qualification");
  expect(publicQualificationReceipt(restored.state)).toMatchObject({ syntheticSequenceComplete: false, liveQualificationProven: false, activationAuthorized: false });
  await expect(restored.prepareDispatchAuthority(scopeFor(restored))).rejects.toThrow("custody_refused");
  for (const root of QUALIFICATION_CLEANUP_ROOTS) await expect(lstat(binding[root].path)).rejects.toThrow();
  await restored.withProofKey(async (key) => { await expect(restored.persist(encodeNativeQualificationCheckpoint(restored.state, key))).rejects.toThrow("custody_refused"); });
  await restored.assertCurrent();
});

afterAll(async () => {
  if (!enabled) return;
  let unproven = false;
  for (const owner of owners) {
    if (owner.released) continue;
    try { await release(owner.value); } catch { unproven = true; }
  }
  if (unproven) throw new Error("synthetic_custody_owner_release_unproven");
  for (const [path, identity] of roots) {
    await assertPrivateDirectoryIdentity({ ...identity, owner: process.getuid?.() ?? -1 }, () => new Error("synthetic_root_changed"));
    await rm(path, { recursive: true });
    try { await lstat(path); throw new Error("synthetic_root_removal_unproven"); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  console.info(JSON.stringify({ evidence: "macos_auth_custody_fixture_cleanup", ownersReleased: owners.length, exactSyntheticRootsRemoved: roots.size, providerOperations: 0 }));
}, 30000);
