import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, fstatSync, lstatSync, openSync, closeSync, readSync, realpathSync, type Stats } from "node:fs";
import { mkdir, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ClaudeProcessIdentity } from "../../src/claude/process.ts";
import { resolveStatePaths } from "../../src/storage/paths.ts";
import type { QualificationCustodySource } from "../claude-macos-auth-qualification/custody.ts";
import { qualificationBindingSchema } from "../claude-macos-auth-qualification/state.ts";
import { acquireClaudeMacosDaemonQualificationOwner, acquireClaudeMacosSessionQualificationOwner, type ClaudeLiveAcceptanceOwner } from "../claude-live-acceptance-owner.ts";
import { AtomicPrivateJsonReceipt, createPrivateTemporaryDirectory, observePrivateDirectory, privatePathsOverlap,
  syncPrivateDirectory, type AtomicPrivateJsonPolicy, type PrivateDirectoryIdentity } from "../live-acceptance-private-custody.ts";

export const JOURNAL_OPERATIONS = ["version", "login_help", "logout_help", "initial_status", "login", "signed_in", "start", "stream_turn", "approve_turn", "deny_turn", "interrupt_turn", "close", "resume", "resumed_turn", "close_final", "logout", "signed_out"] as const;
export type JournalOperation = typeof JOURNAL_OPERATIONS[number];
export const DAEMON_SEED_OPERATIONS = ["version", "login_help", "logout_help", "initial_status", "login", "signed_in", "start", "stream_turn", "close"] as const;
const uuid = z.string().refine((value) => value.length === 36 && z.uuid().safeParse(value).success);
const tag = z.string().refine((s) => s.length === 64 && /^[0-9a-f]{64}$/u.test(s));
const sourceSchema = qualificationBindingSchema.pick({ sourceSha: true, sourceTree: true, executable: true });
const containsControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index); if (code < 32 || code === 127) return true;
  }
  return false;
};
const identitySchema = z.strictObject({ pidDomain: z.literal("darwin"), pid: z.number().int().positive().max(2147483647),
  procStart: z.string().refine((s) => s.length > 0 && s.length <= 256 && s.trim() === s
    && !containsControl(s)) });
const summarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("capability"), digest: tag }),
  z.strictObject({ kind: z.literal("status"), signedIn: z.boolean(), identityTag: tag.nullable() }),
  z.strictObject({ kind: z.literal("login"), childJoined: z.literal(true) }),
  z.strictObject({ kind: z.literal("session"), threadTag: tag, connectionTag: tag, processIdentity: identitySchema }),
  z.strictObject({ kind: z.literal("turn"), deltaCount: z.number().int().min(0).max(4096), deltaBytes: z.number().int().min(0).max(1048576),
    completed: z.literal(true), decision: z.enum(["once", "decline"]).nullable(), interrupted: z.boolean() }),
  z.strictObject({ kind: z.literal("close"), processIdentity: identitySchema, childJoined: z.literal(true), stdoutEof: z.literal(true), stderrEof: z.literal(true) }),
  z.strictObject({ kind: z.literal("logout"), childJoined: z.literal(true) }),
]);
export type SessionSummary = Readonly<z.infer<typeof summarySchema>>;
const reasonSchema = z.enum(["aborted", "custody_refused", "order_refused", "identity_mismatch", "effect_uncertain", "persistence_uncertain", "concurrent_operation", "native_refused"]);
export type SessionFailure = z.infer<typeof reasonSchema>;
const attemptSchema = z.strictObject({ runId: uuid, attemptId: uuid, operation: z.enum(JOURNAL_OPERATIONS), ordinal: z.number().int().min(0).max(16) });
/** Only the exact object returned by this owner's begin() can obtain a ticket. */
export type JournalAttempt = Readonly<z.infer<typeof attemptSchema>>;
const dispatchSchema = z.strictObject({ dispatchId: uuid, kind: z.enum(["process", "frame"]), frameTag: tag.nullable(), frameBytes: z.number().int().min(0).max(65536), acknowledged: z.boolean() });
const entrySchema = z.strictObject({ attempt: attemptSchema, phase: z.enum(["intent", "dispatched", "settled"]),
  dispatches: z.array(dispatchSchema).max(16), child: identitySchema.nullable(), summary: summarySchema.nullable() });
const stateSchema = z.strictObject({ version: z.literal(1), source: z.enum(["native_session_qualification", "credential_free_fixture", "native_daemon_seed_qualification", "credential_free_daemon_seed_fixture"]), runId: uuid,
  revision: z.number().int().min(0).max(512), attempts: z.array(entrySchema).max(17), failure: reasonSchema.nullable() });
type JournalState = z.infer<typeof stateSchema>;
const operationsFor = (state: JournalState): readonly JournalOperation[] =>
  state.source === "native_daemon_seed_qualification" || state.source === "credential_free_daemon_seed_fixture"
    ? DAEMON_SEED_OPERATIONS : JOURNAL_OPERATIONS;
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("intent"), operation: z.enum(JOURNAL_OPERATIONS), attemptId: uuid }),
  z.strictObject({ kind: z.literal("dispatched"), attemptId: uuid }),
  z.strictObject({ kind: z.literal("dispatch"), attemptId: uuid, dispatchId: uuid, dispatchKind: z.enum(["process", "frame"]), frameTag: tag.nullable(), frameBytes: z.number().int().min(0).max(65536) }),
  z.strictObject({ kind: z.literal("ack"), attemptId: uuid, dispatchId: uuid }),
  z.strictObject({ kind: z.literal("child"), attemptId: uuid, identity: identitySchema }),
  z.strictObject({ kind: z.literal("settled"), attemptId: uuid, summary: summarySchema }),
  z.strictObject({ kind: z.literal("failure"), reason: reasonSchema }),
]);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const processOperation = (op: JournalOperation): boolean => ["version", "login_help", "logout_help", "initial_status", "login", "signed_in", "start", "resume", "logout", "signed_out"].includes(op);
const frameOperation = (op: JournalOperation): boolean => ["start", "stream_turn", "approve_turn", "deny_turn", "interrupt_turn", "close", "resume", "resumed_turn", "close_final"].includes(op);
export class DarwinSessionCustodyError extends Error {
  constructor(readonly code: SessionFailure | "closed", readonly recoveryRoot?: string,
    readonly ownerRelease?: "not_attempted" | "released" | "uncertain") {
    super(`DARWIN_SESSION_${code}`); this.name = "DarwinSessionCustodyError";
  }
}
const invalid = (): Error => new DarwinSessionCustodyError("custody_refused");
function requireThat(value: boolean): asserts value { if (!value) throw new DarwinSessionCustodyError("order_refused"); }
function parseState(input: unknown): JournalState {
  if (typeof input !== "object" || input === null || !("attempts" in input) || !Array.isArray(input.attempts) || input.attempts.length > 17
    || !input.attempts.every((entry: unknown) => typeof entry === "object" && entry !== null && "dispatches" in entry && Array.isArray(entry.dispatches) && entry.dispatches.length <= 16)) throw invalid();
  return stateSchema.parse(input);
}
function reduce(input: JournalState, eventInput: unknown): JournalState {
  const state = parseState(input); const event = eventSchema.parse(eventInput);
  requireThat(state.failure === null && state.revision < 512);
  const current = state.attempts.at(-1);
  if (event.kind === "failure") state.failure = event.reason;
  else if (event.kind === "intent") {
    requireThat((current === undefined || current.phase === "settled") && operationsFor(state)[state.attempts.length] === event.operation
      && !state.attempts.some((entry) => entry.attempt.attemptId === event.attemptId));
    state.attempts.push({ attempt: { runId: state.runId, attemptId: event.attemptId, operation: event.operation, ordinal: state.attempts.length }, phase: "intent", dispatches: [], child: null, summary: null });
  } else {
    requireThat(current !== undefined && current.attempt.attemptId === event.attemptId && current.phase !== "settled");
    if (event.kind === "dispatched") { requireThat(current.phase === "intent"); current.phase = "dispatched"; }
    else {
      requireThat(current.phase === "dispatched");
      const op = current.attempt.operation;
      if (event.kind === "dispatch") {
        const all = state.attempts.flatMap((entry) => entry.dispatches);
        requireThat(all.length < 128 && current.dispatches.length < 16 && !all.some((d) => d.dispatchId === event.dispatchId));
        if (event.dispatchKind === "process") requireThat(processOperation(op) && !current.dispatches.some((d) => d.kind === "process") && event.frameTag === null && event.frameBytes === 0);
        else requireThat(frameOperation(op) && event.frameTag !== null && event.frameBytes > 0);
        current.dispatches.push({ dispatchId: event.dispatchId, kind: event.dispatchKind, frameTag: event.frameTag, frameBytes: event.frameBytes, acknowledged: false });
      } else if (event.kind === "ack") {
        const d = current.dispatches.find((item) => item.dispatchId === event.dispatchId);
        requireThat(d !== undefined && !d.acknowledged); d.acknowledged = true;
      } else if (event.kind === "child") {
        requireThat(current.child === null && current.dispatches.some((d) => d.kind === "process")); current.child = event.identity;
      } else {
        requireThat(current.dispatches.every((d) => d.acknowledged) && (!processOperation(op) || current.dispatches.some((d) => d.kind === "process")));
        const summary = event.summary;
        if (["version", "login_help", "logout_help"].includes(op)) requireThat(summary.kind === "capability");
        else if (["initial_status", "signed_in", "signed_out"].includes(op)) requireThat(summary.kind === "status" && summary.signedIn === (op === "signed_in") && (summary.identityTag !== null) === summary.signedIn);
        else if (op === "login") requireThat(summary.kind === "login");
        else if (op === "logout") requireThat(summary.kind === "logout");
        else if (op === "start" || op === "resume") {
          requireThat(summary.kind === "session" && current.child !== null && same(current.child, summary.processIdentity));
          if (op === "resume") {
            const previous = state.attempts.find((entry) => entry.attempt.operation === "start")?.summary;
            requireThat(previous?.kind === "session" && previous.threadTag === summary.threadTag && previous.connectionTag !== summary.connectionTag && !same(previous.processIdentity, summary.processIdentity));
          }
        } else if (op === "close" || op === "close_final") {
          const previous = state.attempts.find((entry) => entry.attempt.operation === (op === "close" ? "start" : "resume"))?.summary;
          requireThat(summary.kind === "close" && previous?.kind === "session" && same(previous.processIdentity, summary.processIdentity));
        } else {
          requireThat(summary.kind === "turn" && current.dispatches.length > 0 && summary.interrupted === (op === "interrupt_turn")
            && summary.decision === (op === "approve_turn" ? "once" : op === "deny_turn" ? "decline" : null));
        }
        current.summary = summary; current.phase = "settled";
      }
    }
  }
  state.revision += 1; return state;
}
/** Pure fixture observations cannot become native owner or dispatch authority. */
export function createCredentialFreeSessionJournal(runId: unknown): JournalState {
  return { version: 1, source: "credential_free_fixture", runId: uuid.parse(runId), revision: 0, attempts: [], failure: null };
}
export function observeCredentialFreeSessionJournal(state: unknown, event: unknown): JournalState {
  const parsed = parseState(state); requireThat(parsed.source === "credential_free_fixture"); return reduce(parsed, event);
}

/** Separate fixture provenance cannot be promoted into a daemon owner. */
export function createCredentialFreeDaemonSeedJournal(runId: unknown): JournalState {
  return { version: 1, source: "credential_free_daemon_seed_fixture", runId: uuid.parse(runId), revision: 0, attempts: [], failure: null };
}
export function observeCredentialFreeDaemonSeedJournal(state: unknown, event: unknown): JournalState {
  const parsed = parseState(state); requireThat(parsed.source === "credential_free_daemon_seed_fixture"); return reduce(parsed, event);
}

export type DarwinSessionScope = Readonly<{ runId: string; ownerEpoch: string; receiptPath: string; runRoot: string; profileRoot: string;
  temporaryRoot: string; projectRoot: string; runtimeRoot: string; profileId: string; providerAccountId: string; providerThreadId: string; generation: 1 }>;
export type SessionDispatchTicket = Readonly<{ dispatchId: string; assertCurrent(): void }>;
type RecordValue = { version: 1; payload: string; mac: string };
const rootNames = ["profileRoot", "temporaryRoot", "projectRoot", "runtimeRoot"] as const;
const rootBasenames = { profileRoot: "profile", temporaryRoot: "temporary", projectRoot: "project", runtimeRoot: "runtime" } as const;
const privateFile = (s: Stats): boolean => s.isFile() && !s.isSymbolicLink() && s.uid === process.getuid?.() && s.nlink === 1 && (s.mode & 0o7777) === 0o600;
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Fresh local custody only. There is deliberately no restore, replay, deletion or runtime-launch method. */
export class DarwinSessionCustody {
  readonly scope: DarwinSessionScope;
  readonly #owner: ClaudeLiveAcceptanceOwner;
  readonly #source: QualificationCustodySource;
  readonly #purpose: "session" | "daemon_seed";
  readonly #directories: readonly PrivateDirectoryIdentity[];
  readonly #key: Buffer;
  readonly #keyIdentity: Stats;
  #receipt: AtomicPrivateJsonReceipt<RecordValue> | undefined;
  #receiptIdentity: Stats | undefined;
  #state: JournalState;
  #attempt: JournalAttempt | null = null;
  #busy = false;
  #closed = false;
  #failure: SessionFailure | null = null;
  #generation = 0;
  readonly #consumed = new Set<string>();

  private constructor(scope: DarwinSessionScope, source: QualificationCustodySource, owner: ClaudeLiveAcceptanceOwner, directories: readonly PrivateDirectoryIdentity[], key: Buffer, keyIdentity: Stats, purpose: "session" | "daemon_seed") {
    this.scope = Object.freeze(scope); this.#source = source; this.#owner = owner; this.#directories = directories;
    this.#key = key; this.#keyIdentity = keyIdentity; this.#purpose = purpose;
    this.#state = { version: 1, source: purpose === "session" ? "native_session_qualification" : "native_daemon_seed_qualification", runId: scope.runId, revision: 0, attempts: [], failure: null };
  }
  get state() {
    const state = structuredClone(this.#state); const last = state.attempts.at(-1);
    return Object.freeze({ operation: last !== undefined && last.phase !== "settled" ? last.attempt.operation : operationsFor(state)[state.attempts.length] ?? null,
      pending: last?.phase === "settled" ? null : last ?? null, failure: this.#failure ?? state.failure,
      complete: this.#failure === null && state.failure === null && state.attempts.length === operationsFor(state).length && last?.phase === "settled", journal: state });
  }
  static async createNative(sourceInput: unknown): Promise<DarwinSessionCustody> {
    return await DarwinSessionCustody.#create(sourceInput, "session");
  }
  /** Internal fixed seed ceremony; the owner remains held through daemon phases. */
  static async createDaemonSeedNative(sourceInput: unknown): Promise<DarwinSessionCustody> {
    return await DarwinSessionCustody.#create(sourceInput, "daemon_seed");
  }
  static async #create(sourceInput: unknown, purpose: "session" | "daemon_seed"): Promise<DarwinSessionCustody> {
    const source = sourceSchema.parse(sourceInput);
    if (process.platform !== "darwin") throw invalid();
    const parent = await realpath("/private/tmp");
    if (parent !== "/private/tmp" || privatePathsOverlap(parent, homedir()) || privatePathsOverlap(parent, resolveStatePaths().root)) throw invalid();
    const runId = randomUUID();
    const root = await createPrivateTemporaryDirectory(join(parent, purpose === "session" ? "oompa-ms-" : "oompa-md-"), invalid);
    let owner: ClaudeLiveAcceptanceOwner | undefined; let key: Buffer | undefined;
    let ownerRelease: "not_attempted" | "released" | "uncertain" = "not_attempted";
    try {
      const family = purpose === "session" ? "session" : "daemon";
      const receiptPath = join(root.path, `.oompa-macos-${family}-qualification-${runId}.recovery.json`);
      ownerRelease = "uncertain";
      owner = await (purpose === "session" ? acquireClaudeMacosSessionQualificationOwner : acquireClaudeMacosDaemonQualificationOwner)({ runId, receiptPath }); owner.assertCurrent();
      const directories = [root]; const paths = {} as Record<typeof rootNames[number], string>;
      for (const name of rootNames) {
        const path = join(root.path, rootBasenames[name]); await mkdir(path, { mode: 0o700 });
        directories.push(await observePrivateDirectory(path, invalid)); paths[name] = path;
      }
      key = randomBytes(32); const keyPath = join(root.path, "proof-key");
      const handle = await open(keyPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
      await syncPrivateDirectory(root.path);
      const keyIdentity = lstatSync(keyPath);
      const scope = { runId, ownerEpoch: randomUUID(), receiptPath, runRoot: root.path, ...paths, profileId: `acct_${randomBytes(16).toString("hex")}`,
        providerAccountId: `pact_${randomBytes(16).toString("hex")}`, providerThreadId: randomUUID(), generation: 1 as const };
      const value = new DarwinSessionCustody(scope, source, owner, directories, key, keyIdentity, purpose);
      value.#assertLayout();
      value.#receipt = await AtomicPrivateJsonReceipt.create(value.#record(value.#state), value.#policy());
      value.#receiptIdentity = value.#captureReceipt(); value.#assertCurrent();
      key = undefined; return value;
    } catch {
      try { if (owner !== undefined) { await owner.releasePreserving(); ownerRelease = "released"; } }
      catch { ownerRelease = "uncertain"; }
      throw new DarwinSessionCustodyError("persistence_uncertain", root.path, ownerRelease);
    } finally { key?.fill(0); }
  }
  #usable(): void {
    if (this.#closed) throw new DarwinSessionCustodyError("closed", this.scope.runRoot);
    if (this.#failure !== null || this.#state.failure !== null) throw new DarwinSessionCustodyError(this.#failure ?? this.#state.failure ?? "custody_refused", this.scope.runRoot);
  }
  #assertLayout(): void {
    this.#owner.assertCurrent();
    for (const d of this.#directories) {
      const s = lstatSync(d.path);
      if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== d.device || s.ino !== d.inode || s.uid !== d.owner || (s.mode & 0o7777) !== 0o700 || realpathSync(d.path) !== d.path) throw invalid();
    }
    const path = join(this.scope.runRoot, "proof-key");
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const bytes = Buffer.alloc(33);
    try {
      const before = fstatSync(fd);
      if (!privateFile(before) || !sameFile(before, this.#keyIdentity) || before.size !== 32) throw invalid();
      let total = 0;
      while (total < bytes.byteLength) {
        const count = readSync(fd, bytes, total, bytes.byteLength - total, total);
        if (count === 0) break;
        total += count;
      }
      if (total !== 32
        || !timingSafeEqual(bytes.subarray(0, 32), this.#key) || !sameFile(before, fstatSync(fd)) || !sameFile(before, lstatSync(path))) throw invalid();
    } finally { bytes.fill(0); closeSync(fd); }
    this.#owner.assertCurrent();
  }
  #captureReceipt(): Stats {
    if (this.#receipt === undefined) throw invalid();
    const before = lstatSync(this.scope.receiptPath); this.#receipt.assertVerifiedIdentity(); const after = lstatSync(this.scope.receiptPath);
    if (!privateFile(before) || !sameFile(before, after)) throw invalid(); return after;
  }
  #assertCurrent(): void {
    this.#usable();
    try { this.#assertLayout(); if (this.#receiptIdentity === undefined || !sameFile(this.#captureReceipt(), this.#receiptIdentity)) throw invalid(); }
    catch { this.#failure = "custody_refused"; throw new DarwinSessionCustodyError("custody_refused", this.scope.runRoot); }
  }
  async assertCurrent(): Promise<void> { this.#assertCurrent(); }
  /** Synchronous final fence for the fixed daemon continuation after its seed. */
  assertDaemonOwnerCurrent(): void {
    if (this.#purpose !== "daemon_seed" || !this.state.complete) throw invalid();
    this.#assertCurrent();
  }
  #mac(value: string | Uint8Array): string { return createHmac("sha256", this.#key).update(this.#purpose === "session" ? "oompa-darwin-session-journal-v1\0" : "oompa-darwin-daemon-seed-journal-v1\0").update(value).digest("hex"); }
  #record(state: JournalState): RecordValue {
    const payload = JSON.stringify({ scope: this.scope, source: this.#source, directories: this.#directories, state });
    if (Buffer.byteLength(payload) > 60000) throw invalid(); return { version: 1, payload, mac: this.#mac(payload) };
  }
  #parseRecord(input: unknown): RecordValue {
    const record = z.strictObject({ version: z.literal(1), payload: z.string(), mac: tag }).parse(input);
    if (Buffer.byteLength(record.payload) > 60000 || !timingSafeEqual(Buffer.from(record.mac, "hex"), Buffer.from(this.#mac(record.payload), "hex"))) throw invalid();
    const parsed: unknown = JSON.parse(record.payload);
    if (typeof parsed !== "object" || parsed === null || !("scope" in parsed) || !("source" in parsed) || !("directories" in parsed) || !("state" in parsed)
      || Object.keys(parsed).length !== 4 || !same(parsed.scope, this.scope) || !same(parsed.source, this.#source) || !same(parsed.directories, this.#directories)) throw invalid();
    const state = parseState(parsed.state);
    if (state.source !== (this.#purpose === "session" ? "native_session_qualification" : "native_daemon_seed_qualification") || state.runId !== this.scope.runId) throw invalid();
    return record;
  }
  #policy(): AtomicPrivateJsonPolicy<RecordValue> {
    return { invalid, maximumBytes: 65536, path: () => this.scope.receiptPath, parse: (value) => this.#parseRecord(value),
      assertRuntime: async () => { this.#assertLayout(); }, createdIdentityMatches: (before, after) => {
        const a = JSON.parse(this.#parseRecord(before).payload) as { state: JournalState };
        const b = JSON.parse(this.#parseRecord(after).payload) as { state: JournalState };
        return a.state.revision + 1 === b.state.revision && a.state.failure === null;
      } };
  }
  async #persist(event: unknown): Promise<void> {
    this.#assertCurrent(); const next = reduce(this.#state, event);
    if (this.#receipt === undefined) throw invalid();
    await this.#receipt.update(() => this.#record(next));
    this.#receiptIdentity = this.#captureReceipt(); this.#state = next;
    this.#assertLayout();
    if (this.#failure !== null) throw invalid();
  }
  async #mutate<T>(action: () => Promise<T>): Promise<T> {
    this.#usable();
    if (this.#busy) { this.#failure = "concurrent_operation"; throw new DarwinSessionCustodyError("concurrent_operation", this.scope.runRoot); }
    this.#busy = true; this.#generation += 1;
    try { return await action(); }
    catch (error: unknown) { this.#failure ??= error instanceof DarwinSessionCustodyError ? error.code === "closed" ? "custody_refused" : error.code : "persistence_uncertain"; throw new DarwinSessionCustodyError(this.#failure, this.scope.runRoot); }
    finally { this.#busy = false; }
  }
  #checkAttempt(attempt: JournalAttempt): void { requireThat(this.#attempt === attempt && this.#state.attempts.at(-1)?.phase === "dispatched"); }
  async begin(operation: JournalOperation): Promise<JournalAttempt> {
    return await this.#mutate(async () => {
      const attemptId = randomUUID(); await this.#persist({ kind: "intent", operation, attemptId }); await this.#persist({ kind: "dispatched", attemptId });
      const current = this.#state.attempts.at(-1); if (current === undefined) throw invalid();
      this.#attempt = Object.freeze(structuredClone(current.attempt)); return this.#attempt;
    });
  }
  async prepareDispatch(attempt: JournalAttempt, input: Readonly<{ kind: "process" | "frame"; frame?: Uint8Array }>): Promise<SessionDispatchTicket> {
    const parsed = z.strictObject({ kind: z.enum(["process", "frame"]), frame: z.instanceof(Uint8Array).optional() }).parse(input);
    if (parsed.kind === "process" ? parsed.frame !== undefined : parsed.frame === undefined || parsed.frame.byteLength < 1 || parsed.frame.byteLength > 65536) throw invalid();
    const frame = parsed.frame === undefined ? undefined : Uint8Array.from(parsed.frame);
    try { return await this.#mutate(async () => {
      this.#checkAttempt(attempt); const dispatchId = randomUUID();
      const frameTag = frame === undefined ? null : createHmac("sha256", this.#key).update(JSON.stringify([this.#purpose === "session" ? "darwin-session-frame-v1" : "darwin-daemon-seed-frame-v1", this.scope.runId, this.scope.ownerEpoch, attempt.attemptId, dispatchId])).update(frame).digest("hex");
      await this.#persist({ kind: "dispatch", attemptId: attempt.attemptId, dispatchId, dispatchKind: parsed.kind, frameTag, frameBytes: frame?.byteLength ?? 0 });
      this.#assertCurrent(); const generation = this.#generation; const receipt = this.#receiptIdentity; let used = false;
      return Object.freeze({ dispatchId, assertCurrent: (): void => {
        try {
          if (used) throw invalid(); used = true;
          this.#usable(); requireThat(!this.#busy && this.#generation === generation && this.#receiptIdentity === receipt); this.#checkAttempt(attempt);
          this.#assertCurrent(); this.#consumed.add(dispatchId);
        } catch {
          this.#failure ??= "custody_refused";
          throw new DarwinSessionCustodyError(this.#failure, this.scope.runRoot);
        }
      } });
    }); } finally { frame?.fill(0); }
  }
  async acknowledgeDispatch(attempt: JournalAttempt, dispatchId: string): Promise<void> {
    await this.#mutate(async () => { this.#checkAttempt(attempt); requireThat(this.#consumed.has(dispatchId)); await this.#persist({ kind: "ack", attemptId: attempt.attemptId, dispatchId }); });
  }
  async recordChild(attempt: JournalAttempt, identity: ClaudeProcessIdentity): Promise<void> {
    await this.#mutate(async () => { this.#checkAttempt(attempt);
      requireThat(this.#state.attempts.at(-1)?.dispatches.some((d) => d.kind === "process" && this.#consumed.has(d.dispatchId)) === true);
      await this.#persist({ kind: "child", attemptId: attempt.attemptId, identity });
    });
  }
  async settle(attempt: JournalAttempt, summary: SessionSummary): Promise<void> {
    await this.#mutate(async () => { this.#checkAttempt(attempt); await this.#persist({ kind: "settled", attemptId: attempt.attemptId, summary }); this.#attempt = null; });
  }
  async fail(reason: SessionFailure): Promise<void> { await this.#mutate(async () => { await this.#persist({ kind: "failure", reason }); }); }
  async withProofKey<T>(observe: (key: Uint8Array) => Promise<T>): Promise<T> {
    this.#assertCurrent(); const copy = Uint8Array.from(this.#key);
    try { const result = await observe(copy); this.#assertCurrent(); return result; } finally { copy.fill(0); }
  }
  async releasePreserving(): Promise<void> {
    if (this.#closed) throw new DarwinSessionCustodyError("closed", this.scope.runRoot);
    if (this.#busy) { this.#failure = "concurrent_operation"; throw invalid(); }
    this.#closed = true; try { await this.#owner.releasePreserving(); } finally { this.#key.fill(0); }
  }
}
