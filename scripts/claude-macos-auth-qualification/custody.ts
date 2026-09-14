import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, lstatSync, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";

import { CLAUDE_PIN, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin.ts";
import { resolveStatePaths } from "../../src/storage/paths.ts";
import { acquireClaudeMacosAuthQualificationOwner, type ClaudeLiveAcceptanceOwner } from "../claude-live-acceptance-owner.ts";
import { assertPrivateDirectoryIdentity, AtomicPrivateJsonReceipt, createPrivateTemporaryDirectory, observePrivateDirectory,
  isPrivateDirectChild, privatePathExists, privatePathsOverlap, syncPrivateDirectory, type AtomicPrivateJsonPolicy, type PrivateDirectoryIdentity } from "../live-acceptance-private-custody.ts";
import { encodeNativeQualificationCheckpoint, encodeQualificationCheckpoint, restoreNativeQualificationCheckpoint, restoreQualificationCheckpoint,
  validateNativeQualificationCheckpoint, validateQualificationCheckpoint } from "./receipt.ts";
import { createNativeQualification, createQualification, QUALIFICATION_CLEANUP_ROOTS, qualificationBindingSchema,
  type QualificationCleanupRoot, type QualificationState } from "./state.ts";

const sourceSchema = qualificationBindingSchema.pick({ sourceSha: true, sourceTree: true, executable: true });
export type QualificationCustodySource = z.infer<typeof sourceSchema>;
const uuid = z.string().uuid();
const dispatchScopeSchema = z.strictObject({ runId: uuid, attemptId: uuid, profile: z.enum(["A", "B"]), probeId: uuid });
export type QualificationDispatchScope = Readonly<z.infer<typeof dispatchScopeSchema>>;
/** Held local custody only. The driver must separately assert its actual source/runtime authority. */
export type QualificationDispatchAuthority = Readonly<{ assertCurrent(scope: QualificationDispatchScope): void }>;
const restoreSchema = z.strictObject({ runId: uuid, runRoot: qualificationBindingSchema.shape.runRoot.shape.path, source: sourceSchema });
const runPrefix = (runId: string): string => `oompa-macos-auth-${runId}-`;
const locatorSchema = z.strictObject({ kind: z.literal("locator"), runId: uuid, receiptPath: z.string().max(4096) });
const recordSchema = z.strictObject({ kind: z.literal("checkpoint"), runId: uuid, receiptPath: z.string().max(4096), checkpoint: z.string().max(175_000) });
type CustodyRecord = z.infer<typeof locatorSchema> | z.infer<typeof recordSchema>;
const names = { profileA: "profile-A", profileB: "profile-B", temporaryA: "temporary-A", temporaryB: "temporary-B" } as const;
const sameNode = (a: Readonly<{ dev: number; ino: number; uid: number; mode: number }>, b: Readonly<{ dev: number; ino: number; uid: number; mode: number }>): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
const sameFile = (a: Stats, b: Stats): boolean => sameNode(a, b) && a.size === b.size && a.nlink === b.nlink
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
export class QualificationCustodyError extends Error {
  constructor(readonly code: "custody_refused" | "recovery_required" | "closed", readonly recoveryRoot?: string) {
    super(`CLAUDE_MACOS_QUALIFICATION_${code}`); this.name = "QualificationCustodyError";
  }
}
const invalid = (): Error => new QualificationCustodyError("custody_refused");
const privateFile = (value: Stats): boolean => value.isFile() && value.nlink === 1 && value.uid === process.getuid?.() && (value.mode & 0o7777) === 0o600;
const journalExtends = (before: QualificationState, after: QualificationState): boolean => before.bindingTag === after.bindingTag
  && before.initialOwnerEpoch === after.initialOwnerEpoch && before.events.length <= after.events.length
  && before.events.every((event, index) => JSON.stringify(event) === JSON.stringify(after.events[index]));
async function temporaryParent(): Promise<string> {
  const path = await realpath(tmpdir());
  if (privatePathsOverlap(path, homedir()) || privatePathsOverlap(path, resolveStatePaths().root)) throw invalid();
  return path;
}

/** This fixed key reader handles only the local, noncredential 32-byte proof key. */
async function readKey(path: string): Promise<Readonly<{ bytes: Buffer; identity: Stats }>> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const buffer = Buffer.alloc(33);
  let captured: Buffer | undefined;
  try {
    const before = await handle.stat();
    if (!privateFile(before) || before.size !== 32) throw invalid();
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(path);
    if (length !== 32 || !privateFile(after) || !privateFile(named) || !sameFile(before, after) || !sameFile(after, named)) throw invalid();
    captured = Buffer.from(buffer.subarray(0, 32));
    return { bytes: captured, identity: after };
  } finally {
    buffer.fill(0);
    await handle.close().catch((error: unknown) => { captured?.fill(0); return Promise.reject(error); });
  }
}

const checkpointBytes = (record: Extract<CustodyRecord, { kind: "checkpoint" }>): Buffer => {
  const value = Buffer.from(record.checkpoint, "base64");
  if (value.length > 128 * 1024 || value.toString("base64") !== record.checkpoint) throw invalid();
  return value;
};

/** Private local custody only. No provider operation, process join or live authority is implemented here. */
export class QualificationCustody {
  readonly runId: string;
  readonly ownerEpoch = randomUUID();
  readonly receiptPath: string;
  readonly #root: PrivateDirectoryIdentity;
  readonly #owner: ClaudeLiveAcceptanceOwner;
  readonly #source: QualificationCustodySource;
  readonly #key: Buffer;
  readonly #keyIdentity: Stats;
  readonly #native: boolean;
  #receipt: AtomicPrivateJsonReceipt<CustodyRecord> | undefined;
  #receiptIdentity: Stats | undefined;
  #state: QualificationState | undefined;
  #closed = false;
  #uncertain = false;
  #mutating = false;
  #generation = 0;
  #restoredPending = false;
  readonly #issuedProbeIds = new Set<string>();

  private constructor(runId: string, root: PrivateDirectoryIdentity, source: QualificationCustodySource,
    owner: ClaudeLiveAcceptanceOwner, key: Readonly<{ bytes: Buffer; identity: Stats }>, native: boolean) {
    this.runId = runId; this.#root = root; this.#source = source; this.#owner = owner;
    this.#key = key.bytes; this.#keyIdentity = key.identity;
    this.#native = native;
    this.receiptPath = join(root.path, `.oompa-macos-auth-qualification-${runId}.recovery.json`);
  }

  get state(): QualificationState {
    this.#usable();
    if (this.#state === undefined) throw invalid();
    return structuredClone(this.#state);
  }
  get recoveryRoot(): string { return this.#root.path; }
  get mode(): "credential_free_fixture" | "native_qualification" { return this.#native ? "native_qualification" : "credential_free_fixture"; }

  static async create(sourceInput: unknown): Promise<QualificationCustody> {
    return await QualificationCustody.#create(sourceInput, false);
  }

  /** Creates a fresh native-provenance run; no authentication or source fact is asserted. */
  static async createNative(sourceInput: unknown): Promise<QualificationCustody> {
    return await QualificationCustody.#create(sourceInput, true);
  }

  /** Fresh 22-step ceremony policy; other native receipt families remain unchanged. */
  static async createNativeManualBrowser(sourceInput: unknown): Promise<QualificationCustody> {
    return await QualificationCustody.#create(sourceInput, true, "owner_manual");
  }

  static async #create(sourceInput: unknown, native: boolean, browserMode?: "owner_manual"): Promise<QualificationCustody> {
    const source = sourceSchema.parse(sourceInput);
    if (process.platform !== "darwin") throw invalid();
    const runId = randomUUID();
    const root = await createPrivateTemporaryDirectory(join(await temporaryParent(), runPrefix(runId)), invalid);
    let owner: ClaudeLiveAcceptanceOwner | undefined;
    let key: Buffer | undefined;
    let observedKeyBytes: Buffer | undefined;
    let handedOff = false;
    try {
      owner = await acquireClaudeMacosAuthQualificationOwner({ runId, receiptPath: join(root.path, `.oompa-macos-auth-qualification-${runId}.recovery.json`) });
      owner.assertCurrent();
      const directories = {} as Record<QualificationCleanupRoot, PrivateDirectoryIdentity>;
      for (const name of QUALIFICATION_CLEANUP_ROOTS) {
        const path = join(root.path, names[name]);
        await mkdir(path, { mode: 0o700 }); directories[name] = await observePrivateDirectory(path, invalid);
        if ((await readdir(path)).length !== 0) throw invalid();
      }
      const keyPath = join(root.path, "proof-key");
      key = randomBytes(32);
      const handle = await open(keyPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.chmod(0o600); await handle.writeFile(key); await handle.sync(); }
      finally { await handle.close(); }
      await syncPrivateDirectory(root.path);
      const observedKey = await readKey(keyPath);
      observedKeyBytes = observedKey.bytes;
      if (!timingSafeEqual(key, observedKey.bytes)) { observedKey.bytes.fill(0); throw invalid(); }
      const custody = new QualificationCustody(runId, root, source, owner, observedKey, native);
      const toDirectory = ({ path, device, inode, mode }: PrivateDirectoryIdentity) => ({ path, device, inode, mode });
      const binding = { version: 1, runId, ...source, pin: CLAUDE_PIN, executableDigest: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable,
        ownerUid: root.owner, realHome: homedir(), forbiddenRoots: [resolveStatePaths().root], runRoot: toDirectory(root),
        ...Object.fromEntries(QUALIFICATION_CLEANUP_ROOTS.map((name) => [name, toDirectory(directories[name])])),
        proofKey: { path: keyPath, device: observedKey.identity.dev, inode: observedKey.identity.ino, mode: 0o600 } };
      custody.#state = native
        ? createNativeQualification({ ...binding, version: 2, mode: "native_qualification", ...(browserMode === undefined ? {} : { browserMode }) }, custody.#key, custody.ownerEpoch)
        : createQualification(binding, custody.#key, custody.ownerEpoch);
      const record = custody.#record(custody.#encode(custody.#state));
      custody.#receipt = await AtomicPrivateJsonReceipt.create(record, custody.#policy());
      custody.#receiptIdentity = custody.#captureVerifiedReceiptIdentity();
      await custody.assertCurrent();
      handedOff = true;
      return custody;
    } catch {
      try { await owner?.releasePreserving(); } catch { /* The exact scope stays retained. */ }
      throw new QualificationCustodyError("recovery_required", root.path);
    } finally { key?.fill(0); if (!handedOff) observedKeyBytes?.fill(0); }
  }

  static async restore(input: unknown): Promise<QualificationCustody> {
    return await QualificationCustody.#restore(input, false);
  }

  /** Native restoration never changes provenance or reconstructs a lost provider process. */
  static async restoreNative(input: unknown): Promise<QualificationCustody> {
    return await QualificationCustody.#restore(input, true);
  }

  static async #restore(input: unknown, native: boolean): Promise<QualificationCustody> {
    const parsed = restoreSchema.safeParse(input);
    if (!parsed.success) throw invalid();
    const { runId, runRoot, source } = parsed.data;
    const prefix = runPrefix(runId);
    if (!isPrivateDirectChild(await temporaryParent(), runRoot) || !basename(runRoot).startsWith(prefix) || basename(runRoot).length <= prefix.length) throw invalid();
    const root = await observePrivateDirectory(runRoot, invalid);
    const receiptPath = join(root.path, `.oompa-macos-auth-qualification-${runId}.recovery.json`);
    const owner = await acquireClaudeMacosAuthQualificationOwner({ runId, receiptPath });
    let key: Readonly<{ bytes: Buffer; identity: Stats }> | undefined;
    try {
      key = await readKey(join(root.path, "proof-key"));
      const custody = new QualificationCustody(runId, root, source, owner, key, native);
      custody.#receipt = await AtomicPrivateJsonReceipt.open({ kind: "locator", runId, receiptPath }, custody.#policy());
      const record = custody.#receipt.value;
      if (record.kind !== "checkpoint") throw invalid();
      const bytes = checkpointBytes(record);
      try {
        custody.#state = native ? restoreNativeQualificationCheckpoint(bytes, key.bytes) : restoreQualificationCheckpoint(bytes, key.bytes);
        // Replayed reducer observations cannot reconstruct the previous owner's retained child.
        custody.#restoredPending = native && custody.#state.pending !== null;
      }
      finally { bytes.fill(0); }
      custody.#receiptIdentity = custody.#captureVerifiedReceiptIdentity();
      await custody.assertCurrent();
      return custody;
    } catch {
      key?.bytes.fill(0);
      try { await owner.releasePreserving(); } catch { /* Retain the exact evidence scope. */ }
      throw new QualificationCustodyError("recovery_required", root.path);
    }
  }

  #usable(): void {
    if (this.#closed) throw new QualificationCustodyError("closed", this.#root.path);
    if (this.#uncertain) throw new QualificationCustodyError("recovery_required", this.#root.path);
  }
  #record(bytes: Uint8Array): CustodyRecord {
    if (bytes.byteLength > 128 * 1024) throw invalid();
    return { kind: "checkpoint", runId: this.runId, receiptPath: this.receiptPath, checkpoint: Buffer.from(bytes).toString("base64") };
  }
  #encode(state: QualificationState): Uint8Array {
    return this.#native ? encodeNativeQualificationCheckpoint(state, this.#key) : encodeQualificationCheckpoint(state, this.#key);
  }
  #decode(record: CustodyRecord): QualificationState {
    if (record.kind !== "checkpoint") throw invalid();
    const bytes = checkpointBytes(record);
    try { return this.#native ? validateNativeQualificationCheckpoint(bytes, this.#key) : validateQualificationCheckpoint(bytes, this.#key); }
    finally { bytes.fill(0); }
  }
  #captureVerifiedReceiptIdentity(): Stats {
    if (this.#receipt === undefined) throw invalid();
    const before = lstatSync(this.receiptPath);
    this.#receipt.assertVerifiedIdentity();
    const after = lstatSync(this.receiptPath);
    if (!privateFile(before) || !privateFile(after) || !sameFile(before, after)) throw invalid();
    return after;
  }
  #policy(): AtomicPrivateJsonPolicy<CustodyRecord> {
    return {
      invalid, maximumBytes: 192 * 1024, path: () => this.receiptPath,
      parse: (input: unknown) => {
        const record = z.union([locatorSchema, recordSchema]).parse(input);
        if (record.runId !== this.runId || record.receiptPath !== this.receiptPath) throw invalid();
        if (record.kind === "checkpoint") this.#decode(record);
        return record;
      },
      createdIdentityMatches: (before, after) => {
        if (after.kind !== "checkpoint" || before.runId !== after.runId || before.receiptPath !== after.receiptPath) return false;
        if (before.kind === "locator") return true;
        const old = this.#decode(before); const next = this.#decode(after);
        if (old.failure !== null && !["owner_lost", "uncertain_effect", "persistence_uncertain"].includes(old.failure)
          && next.failure !== old.failure) return false;
        return journalExtends(old, next);
      },
      assertRuntime: async (record) => {
        this.#owner.assertCurrent();
        await assertPrivateDirectoryIdentity(this.#root, invalid);
        const key = await readKey(join(this.#root.path, "proof-key"));
        try { if (!sameFile(key.identity, this.#keyIdentity) || !timingSafeEqual(key.bytes, this.#key)) throw invalid(); }
        finally { key.bytes.fill(0); }
        if (record.kind === "checkpoint") await this.#assertLayout(this.#decode(record));
        this.#owner.assertCurrent();
      },
    };
  }

  async #assertLayout(state: QualificationState): Promise<void> {
    const binding = state.binding;
    if (binding.runId !== this.runId || JSON.stringify({ sourceSha: binding.sourceSha, sourceTree: binding.sourceTree, executable: binding.executable }) !== JSON.stringify(this.#source)
      || binding.ownerUid !== this.#root.owner || binding.realHome !== homedir()
      || binding.runRoot.path !== this.#root.path || binding.runRoot.device !== this.#root.device || binding.runRoot.inode !== this.#root.inode
      || binding.proofKey.path !== join(this.#root.path, "proof-key") || binding.proofKey.device !== this.#keyIdentity.dev || binding.proofKey.inode !== this.#keyIdentity.ino) throw invalid();
    for (const name of QUALIFICATION_CLEANUP_ROOTS) {
      const identity = binding[name]; const quarantine = this.#quarantine(name);
      if (identity.path !== join(this.#root.path, names[name])) throw invalid();
      const originalExists = await privatePathExists(identity.path); const quarantineExists = await privatePathExists(quarantine);
      const progress = state.cleanupRoots.find((entry) => entry.root === name)?.stage;
      if (progress === "removed") { if (originalExists || quarantineExists) throw invalid(); continue; }
      if (progress === undefined) { if (!originalExists || quarantineExists) throw invalid(); }
      else if (originalExists && quarantineExists) throw invalid();
      if (originalExists || quarantineExists) await assertPrivateDirectoryIdentity({ ...identity, owner: binding.ownerUid, path: originalExists ? identity.path : quarantine }, invalid);
    }
  }
  #quarantine(root: QualificationCleanupRoot): string { return join(this.#root.path, `.quarantine-${root}`); }

  async assertCurrent(): Promise<void> {
    this.#usable();
    try {
      if (this.#receipt === undefined || this.#receiptIdentity === undefined) throw invalid();
      await this.#policy().assertRuntime(this.#receipt.value);
      const named = this.#captureVerifiedReceiptIdentity();
      if (!privateFile(named) || !sameFile(named, this.#receiptIdentity)) throw invalid();
      this.#owner.assertCurrent();
    } catch { this.#uncertain = true; throw new QualificationCustodyError("recovery_required", this.#root.path); }
  }

  async withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T> {
    await this.assertCurrent();
    const copy = Uint8Array.from(this.#key);
    try { return await observe(copy); }
    finally { copy.fill(0); }
  }

  #mutationPending(): boolean { return this.#mutating; }

  /**
   * Prepare before any pair rendezvous. This ticket supplies only local held-owner/attempt
   * custody, never source-content, executable, provider, or recovered-process authority.
   * The closed driver must compose its actual source assertion and exact process binding.
   */
  async prepareDispatchAuthority(scopeInput: QualificationDispatchScope): Promise<QualificationDispatchAuthority> {
    this.#usable();
    const parsed = dispatchScopeSchema.safeParse(scopeInput);
    if (!parsed.success || !this.#native || this.#restoredPending || this.#mutating) throw invalid();
    const scope = Object.freeze(parsed.data);
    const generation = this.#generation;
    await this.assertCurrent();
    const state = this.#state;
    const receiptIdentity = this.#receiptIdentity;
    if (this.#mutationPending() || generation !== this.#generation || state === undefined || receiptIdentity === undefined
      || state.failure !== null || state.needsRecovery || state.ownerEpoch !== this.ownerEpoch
      || state.pending?.stage !== "dispatched" || state.pending.attemptId !== scope.attemptId || scope.runId !== this.runId
      || state.probes.includes(scope.probeId) || this.#issuedProbeIds.has(scope.probeId) || this.#issuedProbeIds.size >= 256) throw invalid();
    this.#issuedProbeIds.add(scope.probeId);
    let used = false;
    return Object.freeze({ assertCurrent: (actualInput: QualificationDispatchScope): void => {
      if (used) throw invalid();
      used = true; // Even a refused use cannot be retried with another scope.
      const actual = dispatchScopeSchema.safeParse(actualInput);
      if (!actual.success || actual.data.runId !== scope.runId || actual.data.attemptId !== scope.attemptId
        || actual.data.profile !== scope.profile || actual.data.probeId !== scope.probeId) throw invalid();
      this.#usable();
      if (this.#mutating || this.#generation !== generation || this.#state !== state || this.#receiptIdentity !== receiptIdentity
        || this.#restoredPending || state.ownerEpoch !== this.ownerEpoch) throw invalid();
      try {
        this.#owner.assertCurrent();
        const named = this.#captureVerifiedReceiptIdentity();
        if (!privateFile(named) || !sameFile(named, receiptIdentity)) throw invalid();
        this.#owner.assertCurrent();
      } catch { this.#uncertain = true; throw new QualificationCustodyError("recovery_required", this.#root.path); }
    } });
  }

  async persist(checkpoint: Uint8Array): Promise<void> {
    this.#usable();
    if (this.#mutating || this.#state?.step === 22 || !(checkpoint instanceof Uint8Array) || checkpoint.byteLength > 128 * 1024) throw invalid();
    const captured = Uint8Array.from(checkpoint);
    this.#mutating = true;
    this.#generation += 1;
    try {
      await this.assertCurrent();
      const next = this.#record(captured);
      const state = this.#decode(next);
      if (this.#receipt === undefined || this.#state === undefined || !journalExtends(this.#state, state)
        || ((!state.needsRecovery || state.recoveryValidated) && state.ownerEpoch !== this.ownerEpoch)
        || (this.#restoredPending && (!state.needsRecovery || state.step !== this.#state.step
          || state.pending?.attemptId !== this.#state.pending?.attemptId || state.pending?.stage !== this.#state.pending?.stage))) throw invalid();
      await this.#receipt.update(() => next);
      this.#receiptIdentity = this.#captureVerifiedReceiptIdentity();
      this.#state = state;
      await this.assertCurrent();
    } catch { this.#uncertain = true; throw new QualificationCustodyError("recovery_required", this.#root.path); }
    finally { captured.fill(0); this.#mutating = false; }
  }

  /** Filesystem reconciliation only; the caller separately proves all provider children have joined. */
  async removeRoot(rootInput: unknown): Promise<Readonly<{ root: QualificationCleanupRoot; removalReconciled: true }>> {
    const root = z.enum(QUALIFICATION_CLEANUP_ROOTS).parse(rootInput);
    this.#usable();
    if (this.#mutating) throw invalid();
    this.#mutating = true;
    this.#generation += 1;
    try {
      await this.assertCurrent();
      const state = this.state;
      if (state.failure !== null || (state.needsRecovery && !state.recoveryValidated) || state.step !== 21
        || state.ownerEpoch !== this.ownerEpoch
        || state.pending?.stage !== "dispatched" || state.cleanupRoots.at(-1)?.root !== root || state.cleanupRoots.at(-1)?.stage !== "intent") throw invalid();
      const identity = state.binding[root]; const quarantine = this.#quarantine(root);
      if (await privatePathExists(identity.path)) {
        this.#owner.assertCurrent();
        await assertPrivateDirectoryIdentity({ ...identity, owner: state.binding.ownerUid }, invalid);
        if (await privatePathExists(quarantine)) throw invalid();
        this.#owner.assertCurrent();
        await rename(identity.path, quarantine); await syncPrivateDirectory(this.#root.path);
      }
      if (await privatePathExists(quarantine)) {
        await assertPrivateDirectoryIdentity({ ...identity, owner: state.binding.ownerUid, path: quarantine }, invalid);
        await assertPrivateDirectoryIdentity(this.#root, invalid); this.#owner.assertCurrent();
        await rm(quarantine, { recursive: true }); await syncPrivateDirectory(this.#root.path);
      }
      if (await privatePathExists(identity.path) || await privatePathExists(quarantine)) throw invalid();
      await this.assertCurrent();
      return { root, removalReconciled: true };
    } catch { this.#uncertain = true; throw new QualificationCustodyError("recovery_required", this.#root.path); }
    finally { this.#mutating = false; }
  }

  async releasePreserving(): Promise<void> {
    if (this.#closed) throw new QualificationCustodyError("closed", this.#root.path);
    if (this.#mutating) throw invalid();
    this.#closed = true;
    try { await this.#owner.releasePreserving(); }
    finally { this.#key.fill(0); }
  }
}
