import { afterAll, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";

import { initialize } from "../src/cli";
import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../src/claude/pin";
import { DaemonLock, readDaemonAuthorityReceipt } from "../src/daemon/daemon-lock";
import { daemonStatusIdentity, identityFromReceipt, sameDaemonIdentity,
  waitForDaemonReady, type DaemonIdentity } from "../src/daemon/daemon-startup";
import { callLocalDaemon } from "../src/daemon/local-transport";
import type { EffectiveClaudeRuntimeProfile } from "../src/domain/runtime-profile";
import { resolveStatePaths, type StatePaths } from "../src/storage/paths";
import { StateStore } from "../src/storage/state-store";
import { syncPrivateDirectory } from "./live-acceptance-private-custody";
import { assertRestartDescriptor, assertRestartDescriptorObservation,
  captureRestartDescriptor, createRestartEffectSentinel,
  RESTART_NATIVE_VARIABLE, RESTART_REPOSITORY, RESTART_SOURCE_FILES, restartChildResultSchema,
  restartDescriptorSchema, restartPaths, restartSourceDigest,
  type RestartDescriptor } from "./darwin-daemon-restart-fixture";

const enabled = process.env[RESTART_NATIVE_VARIABLE] === "1";
const nativeTest = test.skipIf(!enabled);
const fail = (): Error => new Error("DAEMON_RESTART_NATIVE_UNPROVEN");
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const owners: HeldDaemon[] = [];
const retainedRoots: string[] = [];

// Bun's test timeout does not cancel a suspended test callback. This fence is
// closed before cleanup snapshots owners, including a not-yet-started case.
class RestartSpawnFence {
  #closing = false;
  #deadlineAt: number | undefined;

  begin(deadlineAt: number): void {
    if (this.#closing || this.#deadlineAt !== undefined || !Number.isSafeInteger(deadlineAt)) throw fail();
    this.#deadlineAt = deadlineAt;
    this.assertCurrent();
  }

  close(): void { this.#closing = true; }

  assertCurrent(): void {
    if (this.#closing || this.#deadlineAt === undefined || Date.now() >= this.#deadlineAt) {
      this.close();
      throw fail();
    }
  }

  async afterCheckpoint<T>(persist: () => Promise<void>, startChild: () => T): Promise<T> {
    this.assertCurrent();
    await persist();
    this.assertCurrent();
    return startChild();
  }
}
const nativeSpawnFence = new RestartSpawnFence();

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(fail()), milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

function collect(stream: Readable, maximumBytes: number, retain: boolean) {
  let failed = false;
  let eof = false;
  let bytes = 0;
  const chunks: Buffer[] = [];
  const result = new Promise<{ eof: boolean; failed: boolean; bytes: number; text: string }>((resolvePromise) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const body = Buffer.concat(chunks);
      const text = body.toString("utf8");
      body.fill(0);
      for (const chunk of chunks) chunk.fill(0);
      resolvePromise({ eof, failed, bytes, text });
    };
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) failed = true;
      else if (retain) chunks.push(Buffer.from(chunk));
    });
    stream.on("error", () => { failed = true; });
    stream.once("end", () => { eof = true; });
    stream.once("close", () => { if (!eof) failed = true; finish(); });
  });
  return result;
}

async function assertAbsent(path: string): Promise<void> {
  try { await lstat(path); } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw fail();
}

async function databaseIdentity(paths: StatePaths) {
  if (await realpath(paths.database) !== paths.database) throw fail();
  const stat = await lstat(paths.database);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7777) !== 0o600) throw fail();
  return { device: stat.dev, inode: stat.ino, owner: stat.uid };
}

/** One-use immutable diagnostic files, never a restore or launch authority. */
async function checkpoint(descriptor: RestartDescriptor, name: "intent" | "joined", data: unknown) {
  assertRestartDescriptor(descriptor);
  const body = JSON.stringify({ version: 1, runId: descriptor.runId,
    source: "credential_free_fixture", sourceDigest: restartSourceDigest(descriptor),
    phase: descriptor.phase, data });
  if (Buffer.byteLength(body) > 16 * 1_024) throw fail();
  const handle = await open(join(descriptor.root, `${descriptor.phase}-${name}.json`),
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(body); await handle.sync(); }
  finally { await handle.close(); }
  await syncPrivateDirectory(descriptor.root);
  assertRestartDescriptor(descriptor);
}

// A single fixed child lifecycle for these tests. No exposed transport or
// arbitrary executable operation, no PID lookup, and no cleanup by name.
class HeldDaemon {
  readonly descriptor: RestartDescriptor;
  readonly paths: StatePaths;
  readonly child: ChildProcessWithoutNullStreams;
  readonly #stdout;
  readonly #stderr;
  readonly #closed;
  readonly #inputClosed;
  #inputFinished = false;
  #inputFailed = false;
  #spawnFailed = false;
  #identity: DaemonIdentity | undefined;
  #joined = false;

  constructor(descriptor: RestartDescriptor, fence: RestartSpawnFence) {
    this.descriptor = assertRestartDescriptor(descriptor);
    this.paths = resolveStatePaths({ rootDirectory: restartPaths(descriptor.root).state });
    fence.assertCurrent();
    this.child = spawn(descriptor.executable.path,
      ["--no-env-file", "--config=/dev/null", join(RESTART_REPOSITORY, "scripts/darwin-daemon-restart-fixture.ts")],
      { cwd: restartPaths(descriptor.root).project, stdio: ["pipe", "pipe", "pipe"],
        env: { HOME: descriptor.home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC",
          [RESTART_NATIVE_VARIABLE]: "1" } });
    owners.push(this);
    this.#stdout = collect(this.child.stdout, 8 * 1_024, true);
    this.#stderr = collect(this.child.stderr, 4 * 1_024, false);
    this.#inputClosed = new Promise<void>((resolvePromise) => {
      this.child.stdin.once("close", resolvePromise);
    });
    this.child.stdin.on("error", () => { this.#inputFailed = true; });
    this.child.once("error", () => { this.#spawnFailed = true; });
    this.#closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise) => {
      this.child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
  }

  get joined() { return this.#joined; }
  get identity(): DaemonIdentity { if (this.#identity === undefined) throw fail(); return this.#identity; }
  get #spawnErrorObserved(): boolean { return this.#spawnFailed; }

  async ready(): Promise<DaemonIdentity> {
    const body = `${JSON.stringify(this.descriptor)}\n`;
    if (Buffer.byteLength(body) > 32 * 1_024) throw fail();
    await bounded(new Promise<void>((resolvePromise, reject) => {
      this.child.stdin.once("finish", () => { this.#inputFinished = true; resolvePromise(); });
      this.child.stdin.once("error", reject);
      this.child.stdin.end(body);
    }), 5_000);
    this.child.stdin.destroy();
    await bounded(this.#inputClosed, 2_000);
    if (this.#inputFailed || this.#spawnFailed || !this.#inputFinished) throw fail();
    const identity = await waitForDaemonReady({
      paths: this.paths, deadlineMs: 30_000,
      queryStatus: async () => await callLocalDaemon({ paths: this.paths,
        command: { kind: "daemon.status" }, deadlineMs: 750 }),
      observeChild: () => ({ pid: this.child.pid ?? 0,
        exited: this.child.exitCode !== null || this.child.signalCode !== null,
        ...(this.child.exitCode === null ? {} : { exitCode: this.child.exitCode }) }),
    });
    if (identity.pid !== this.child.pid || this.#spawnErrorObserved
      || this.child.exitCode !== null || this.child.signalCode !== null) throw fail();
    this.#identity = identity;
    return identity;
  }

  async assertCurrent(): Promise<void> {
    assertRestartDescriptor(this.descriptor);
    const observed = daemonStatusIdentity(await callLocalDaemon({ paths: this.paths,
      command: { kind: "daemon.status" }, deadlineMs: 1_000 }));
    if (!sameDaemonIdentity(this.identity, observed) || this.child.exitCode !== null
      || this.child.signalCode !== null) throw fail();
  }

  async stop(): Promise<void> {
    await this.assertCurrent();
    const response = await callLocalDaemon({ paths: this.paths, deadlineMs: 5_000,
      command: { kind: "daemon.stop", expected: this.identity } });
    if (!response.ok) throw fail();
    const [exit, stdout, stderr] = await bounded(Promise.all([
      this.#closed, this.#stdout, this.#stderr, this.#inputClosed,
    ]), 10_000);
    if (exit.code !== 0 || exit.signal !== null || this.#spawnFailed
      || this.#inputFailed || !this.#inputFinished || !stdout.eof || stdout.failed
      || !stderr.eof || stderr.failed || stderr.bytes !== 0) throw fail();
    const result = restartChildResultSchema.parse(JSON.parse(stdout.text) as unknown);
    if (result.runId !== this.descriptor.runId || result.phase !== this.descriptor.phase
      || result.pid !== this.identity.pid || result.outcome !== "stopped"
      || result.externalAttempts !== 0 || result.sourceDigest !== restartSourceDigest(this.descriptor)) throw fail();
    const receipt = await readDaemonAuthorityReceipt(this.paths);
    const identity = receipt === null ? null : identityFromReceipt(receipt);
    if (receipt?.state !== "stopped" || identity === null
      || !sameDaemonIdentity(identity, this.identity) || await DaemonLock.isAuthorityHeld(this.paths)) throw fail();
    await Promise.all([this.paths.socket, this.paths.capability,
      join(this.paths.runtime, "claude-host-tools.sock")].map(assertAbsent));
    assertRestartDescriptor(this.descriptor);
    await checkpoint(this.descriptor, "joined", { daemon: this.identity, childExit: 0,
      inputClosed: true, stdoutEof: true, stderrEof: true,
      externalAttempts: result.externalAttempts, sentinelChecks: result.sentinelChecks });
    this.#joined = true;
  }

  async collectAfterFailure(): Promise<void> {
    if (this.#joined) return;
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGTERM");
    const term = await bounded(this.#closed, 3_000).then(() => true, () => false);
    if (!term) {
      this.child.kill("SIGKILL");
      await bounded(this.#closed, 3_000);
    }
    this.child.stdin.destroy();
    const [, stdout, stderr] = await bounded(Promise.all([this.#inputClosed, this.#stdout, this.#stderr]), 2_000);
    if (!stdout.eof || stdout.failed || !stderr.eof || stderr.failed) throw fail();
    const exit = await this.#closed;
    let result: unknown;
    try { result = JSON.parse(stdout.text) as unknown; } catch { /* No raw output is retained. */ }
    const parsed = restartChildResultSchema.safeParse(result);
    console.info(JSON.stringify({ evidence: "daemon_restart_child_collected_after_failure",
      phase: this.descriptor.phase, code: exit.code, signaled: exit.signal !== null,
      stdoutBytes: stdout.bytes, stderrBytes: stderr.bytes, streamsJoined: true,
      result: parsed.success ? parsed.data : null }));
    // Collection after failure does not manufacture an ordinary joined result.
  }
}

async function start(descriptor: RestartDescriptor, previous?: HeldDaemon) {
  if (descriptor.phase === "b" && (previous === undefined || !previous.joined
    || previous.descriptor.runId !== descriptor.runId || previous.descriptor.root !== descriptor.root
    || previous.descriptor.phase !== "a")) throw fail();
  const child = await nativeSpawnFence.afterCheckpoint(
    async () => await checkpoint(descriptor, "intent", { predecessor: previous?.identity ?? null }),
    () => new HeldDaemon(descriptor, nativeSpawnFence),
  );
  await child.ready();
  return child;
}

function seed(store: StateStore, daemon: DaemonIdentity) {
  const profile = store.createProfile("Credential-free restart fixture");
  store.advanceProviderAccountProcessGeneration({ profileId: profile.id, provider: "claude", expectedProcessGeneration: 0 });
  const authority = store.requireProviderAccountAuthority(profile.id, "claude");
  const project = store.listProjects()[0];
  if (project === undefined) throw fail();
  const session = store.upsertProviderSession({ profileId: profile.id, provider: "claude",
    providerAuthority: authority, projectId: project.id, title: "Synthetic restart evidence",
    providerThreadId: randomUUID(), preset: "fable-max", fastEnabled: false, state: "idle",
    providerUpdatedAt: 30, providerAccountKey: `v1:claude:${hash("credential-free-account")}` });
  const providerThreadId = session.providerThreadId;
  if (providerThreadId === undefined) throw fail();
  const runtimeProfile: EffectiveClaudeRuntimeProfile = {
    profileId: profile.id, processGeneration: authority.processGeneration, observedAt: 2_000,
    preset: "fable-max", model: CLAUDE_PIN_MODEL, reasoningEffort: "max", claudeVersion: CLAUDE_PIN,
    permissionMode: "default", isolatedConfigDir: true, outputFormat: "stream-json", inputFormat: "stream-json",
  };
  const nonce = randomUUID();
  const message = `credential-free send ${nonce}`;
  const queuedMessage = `credential-free dispatch ${nonce}`;
  const pendingMessage = `credential-free pending ${nonce}`;
  const dispatchKey = randomUUID();
  const pendingKey = randomUUID();
  const dispatching = store.enqueueIdempotent({ sessionId: session.id, message: queuedMessage,
    idempotencyKey: dispatchKey, providerAuthority: authority, profileGeneration: authority.processGeneration });
  const pending = store.enqueueIdempotent({ sessionId: session.id, message: pendingMessage,
    idempotencyKey: pendingKey, providerAuthority: authority, profileGeneration: authority.processGeneration });
  const key = randomUUID();
  const { attempt } = store.prepareSessionInputMutation({ kind: "session.send", sessionId: session.id,
    providerAuthority: authority, message, attachments: [], idempotencyKey: key,
    daemonGeneration: daemon.generation, bootId: daemon.bootId });
  const connection = randomUUID();
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  store.beginSessionMutationEffect({ attemptId: attempt.id, sessionId: session.id,
    profileGeneration: authority.processGeneration, providerAuthority: authority,
    message, attachments: [], daemonGeneration: daemon.generation, bootId: daemon.bootId,
    transcript: { accountId: profile.id, providerGeneration: authority.processGeneration,
      providerConnectionId: connection, actor: "human", message },
    evidence: { kind: "session.send", providerThreadId,
      baseline: { providerUpdatedAt: 30, status: "idle", activeTurnId: null },
      clientMessageId: attempt.id, messageDigest: sha(message), runtimeProfile } });
  const queueInput = { queueId: dispatching.id, sessionId: session.id,
    profileGeneration: authority.processGeneration, providerAuthority: authority,
    providerConnectionId: connection, evidence: { kind: "queue.dispatch" as const,
      queueId: dispatching.id, sessionId: session.id, providerThreadId,
      profileGeneration: authority.processGeneration,
      baseline: { providerUpdatedAt: 30, status: "idle" as const, activeTurnId: null },
      clientMessageId: dispatching.id, messageDigest: sha(queuedMessage), runtimeProfile } };
  // The negative control crosses the actual storage contract, before its write.
  expect(() => store.beginQueueEffect({ ...queueInput,
    evidence: { ...queueInput.evidence, messageDigest: "0".repeat(64) } })).toThrow();
  expect(store.requireQueue(dispatching.id).state).toBe("pending");
  store.beginQueueEffect(queueInput);
  return { session: session.id, profile: profile.id, key, attempt: attempt.id,
    dispatching: dispatching.id, pending: pending.id, dispatchKey, pendingKey,
    message, queuedMessage, pendingMessage };
}

type Seed = ReturnType<typeof seed>;
function snapshot(store: StateStore, input: Seed) {
  const mutation = store.readMutation(input.key);
  const queue = store.readQueueEffect(input.dispatching);
  if (mutation === null || queue === null) throw fail();
  expect(mutation.id).toBe(input.attempt);
  // nextDaemonGeneration retires this legacy Claude send before generic
  // recovery reads effect_started rows. Its diagnostic is not a provider ACK
  // or resolution; require the exact Claude authority-retirement result.
  if (mutation.state === "effect_started") expect(mutation.result).toBeUndefined();
  else if (mutation.state === "ambiguous") expect(mutation.result).toEqual({ code: "CLAUDE_DAEMON_RESTART_AUTHORITY_RETIRED" });
  else throw fail();
  expect(mutation.resolution).toBeUndefined();
  expect(queue.resolution).toBeUndefined();
  expect(store.readQueueEffect(input.pending)).toBeNull();
  expect(store.requireProfile(input.profile).state).toBe("signed_out");
  expect(store.listClaudeProcessLaunchIntents()).toEqual([]);
  expect(store.listUnreleasedClaudeProcessAuthorities()).toEqual([]);
  expect(store.listSessionAdoptionPolicies().filter((policy) => policy.enabled)).toEqual([]);
  const session = store.requireSession(input.session);
  const transcript = store.readSessionUserMessageSource(input.session, "mutation", input.key);
  expect(transcript).toMatchObject({ status: "pending", intent: { version: 1,
    accountId: input.profile, actor: "human", text: input.message, omittedCharacters: 0 } });
  const messageAttachments = store.messageAttachmentManifest(input.session, input.attempt);
  expect(messageAttachments).toEqual([]);
  expect(store.hasPendingSessionUserMessageFinalization(input.session)).toBe(true);
  const entries = store.listQueue(input.session);
  expect(entries.map((entry) => entry.id)).toEqual([input.dispatching, input.pending]);
  const queuedInputs = entries.map((entry) => {
    const key = entry.id === input.dispatching ? input.dispatchKey : input.pendingKey;
    const message = entry.id === input.dispatching ? input.queuedMessage : input.pendingMessage;
    const enqueue = store.readMutation(key);
    if (enqueue === null) throw fail();
    expect(enqueue).toMatchObject({ kind: "session.queue", authorityId: input.session,
      idempotencyKey: key, state: "applied", result: { queueId: entry.id } });
    expect(enqueue.resolution).toBeUndefined();
    expect(store.readQueueEnqueueReplay({ sessionId: input.session, message,
      idempotencyKey: key, attachments: [], actor: "human" }))
      .toEqual({ queued: entry, verification: "sealed" });
    expect(entry).toMatchObject({ sessionId: input.session, message, messageActor: "human" });
    expect(entry.peerActionId).toBeUndefined();
    const queuedTranscript = store.readSessionUserMessageSource(input.session, "queue", entry.id);
    expect(queuedTranscript).toMatchObject({ status: "pending", intent: { version: 1,
      accountId: input.profile, actor: "human", text: message, omittedCharacters: 0 } });
    const attachments = store.queueAttachmentManifest(entry.id);
    const dispatchedAttachments = store.messageAttachmentManifest(input.session, entry.id);
    expect(attachments).toEqual([]);
    expect(dispatchedAttachments).toEqual([]);
    return { id: entry.id, sessionId: entry.sessionId, message: entry.message,
      messageActor: entry.messageActor, peerActionId: entry.peerActionId ?? null,
      createdAt: entry.createdAt, enqueue,
      enqueueAuthority: store.readMutationProviderAuthorities(enqueue.id),
      providerAuthority: store.readQueueProviderAuthority(entry.id),
      transcript: queuedTranscript, attachments, dispatchedAttachments };
  });
  const events = store.listSessionEvents({ sessionId: input.session, afterSequence: 0 }).events;
  return { sessionState: session.state,
    mutationState: mutation.state, mutationResult: mutation.result,
    queueState: store.requireQueue(input.dispatching).state,
    pendingState: store.requireQueue(input.pending).state,
    immutable: hash({ session: { id: session.id, profileId: session.profileId,
      projectId: session.projectId, providerThreadId: session.providerThreadId,
      provider: session.provider, title: session.title, note: session.note,
      preset: session.preset, fastEnabled: session.fastEnabled, activeTurnId: session.activeTurnId,
      providerUpdatedAt: session.providerUpdatedAt, archivedAt: session.archivedAt, createdAt: session.createdAt },
      capturedAuthority: store.requireCapturedSessionProviderAuthority(input.session),
      providerAccountAuthority: store.readSessionProviderAccountAuthority(input.session),
      mutationId: mutation.id, idempotencyKey: mutation.idempotencyKey,
      kind: mutation.kind, authorityId: mutation.authorityId,
      authorityGeneration: mutation.authorityGeneration, requestDigest: mutation.requestDigest,
      mutationEvidence: mutation.evidence, queueEvidence: queue,
      sendAuthority: store.readMutationProviderAuthorities(input.attempt),
      transcript, messageAttachments, queuedInputs,
      userEvents: events.filter((event) => event.body.type === "user_message") }),
    replay: store.readSessionInputReplay({ kind: "session.send", sessionId: input.session,
      idempotencyKey: input.key, message: input.message, attachments: [] }) };
}

test("restart descriptor forbids root escapes, arbitrary source files and operations", () => {
  for (const root of ["/tmp/oompa-dr-abcdef", "/private/tmp/oompa-dr-../abc", "/private/tmp/oompa-dr-abcdef/child", homedir(), "relative"]) {
    expect(() => restartPaths(root)).toThrow();
  }
  expect(restartPaths("/private/tmp/oompa-dr-abcdef").runtime).toBe("/private/tmp/oompa-dr-abcdef/state/runtime");
  expect(restartDescriptorSchema.safeParse({ root: "/private/tmp/oompa-dr-abcdef", command: "login" }).success).toBe(false);
  fc.assert(fc.property(fc.string({ maxLength: 100 }).filter((value) => !/^[a-zA-Z0-9]{6}$/u.test(value)), (suffix) => {
    expect(() => restartPaths(`/private/tmp/oompa-dr-${suffix}`)).toThrow();
  }), { seed: 20260912, numRuns: 100 });
});

test("the original database identity cannot be replaced in B's descriptor observation", () => {
  const identity = { device: 1, inode: 2, owner: 3 };
  const file = { ...identity, bytes: 4, mode: 0o100600, modified: 5, changed: 6, sha256: "a".repeat(64) };
  const initial = restartDescriptorSchema.parse({ version: 1, source: "credential_free_fixture",
    runId: "00000000-0000-4000-8000-000000000001", phase: "a", root: "/private/tmp/oompa-dr-abcdef",
    home: "/synthetic-home", repository: RESTART_REPOSITORY,
    directories: { root: identity, state: identity, project: identity, runtime: identity },
    database: identity, executable: { path: "/synthetic-bun", identity: file },
    files: RESTART_SOURCE_FILES.map((path) => ({ path, identity: file })) });
  const b = restartDescriptorSchema.parse({ ...initial, phase: "b" });
  expect(assertRestartDescriptorObservation(b, structuredClone(b))).toEqual(b);
  for (const field of ["device", "inode", "owner"] as const) {
    expect(() => assertRestartDescriptorObservation(b,
      { ...b, database: { ...b.database, [field]: b.database[field] + 1 } })).toThrow();
  }
  expect(() => assertRestartDescriptorObservation(b, { ...b, database: undefined })).toThrow();
  // Mutable database bytes/timestamps cannot enter or replace this identity contract.
  expect(() => assertRestartDescriptorObservation(b,
    { ...b, database: { ...b.database, modified: 7 } })).toThrow();
});

test("cleanup fences a start suspended at its checkpoint and cannot be reopened", async () => {
  const fence = new RestartSpawnFence();
  fence.begin(Date.now() + 5_000);
  const checkpointWritten = Promise.withResolvers<undefined>();
  let dispatched = 0;
  const outcome = fence.afterCheckpoint(async () => await checkpointWritten.promise,
    () => { dispatched += 1; }).then(() => "started", () => "refused");
  fence.close();
  checkpointWritten.resolve(undefined);
  expect(await outcome).toBe("refused");
  expect(dispatched).toBe(0);
  expect(() => fence.begin(Date.now() + 5_000)).toThrow();
  expect(() => fence.assertCurrent()).toThrow();
  const beforeCase = new RestartSpawnFence();
  beforeCase.close();
  expect(() => beforeCase.begin(Date.now() + 5_000)).toThrow();
});

test("a live parent admits completion but a checkpoint at the deadline cannot dispatch", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1_000);
  try {
    const live = new RestartSpawnFence();
    live.begin(2_000);
    let dispatched = 0;
    await live.afterCheckpoint(async () => {}, () => { dispatched += 1; });
    expect(dispatched).toBe(1);
    live.close();
    const expired = new RestartSpawnFence();
    expired.begin(2_000);
    const checkpointWritten = Promise.withResolvers<undefined>();
    const outcome = expired.afterCheckpoint(async () => await checkpointWritten.promise,
      () => { dispatched += 1; }).then(() => "started", () => "refused");
    clock.mockReturnValue(2_000);
    checkpointWritten.resolve(undefined);
    expect(await outcome).toBe("refused");
    expect(dispatched).toBe(1);
    expect(() => expired.begin(3_000)).toThrow();
    expect(() => expired.assertCurrent()).toThrow();
  } finally { clock.mockRestore(); }
});

test("external-effect sentinel refuses every call without an effect result", () => {
  const sentinel = createRestartEffectSentinel();
  expect(sentinel.attempts).toBe(0);
  for (let count = 1; count <= 10; count += 1) {
    expect(() => sentinel.reject()).toThrow("DAEMON_RESTART_FIXTURE_REFUSED");
    expect(sentinel.attempts).toBe(count);
  }
});

test("pipe collection requires actual EOF and retains bounded output on overflow", async () => {
  const clean = new PassThrough();
  const cleanResult = collect(clean, 4, true);
  clean.end("ok");
  expect(await cleanResult).toEqual({ eof: true, failed: false, bytes: 2, text: "ok" });
  const lost = new PassThrough();
  const lostResult = collect(lost, 4, true);
  lost.destroy();
  expect(await lostResult).toEqual({ eof: false, failed: true, bytes: 0, text: "" });
  const overflow = new PassThrough();
  const overflowResult = collect(overflow, 4, true);
  overflow.write("1234");
  overflow.end("56");
  expect(await overflowResult).toEqual({ eof: true, failed: true, bytes: 6, text: "1234" });
  const errored = new PassThrough();
  const erroredResult = collect(errored, 4, false);
  errored.destroy(new Error("synthetic stream failure"));
  expect(await erroredResult).toEqual({ eof: false, failed: true, bytes: 0, text: "" });
});

test("fragmentation cannot turn over-budget child output into an admitted stream", async () => {
  await fc.assert(fc.asyncProperty(fc.uint8Array({ maxLength: 256 }),
    fc.integer({ min: 1, max: 17 }), async (bytes, width) => {
      const stream = new PassThrough();
      const result = collect(stream, 64, false);
      for (let offset = 0; offset < bytes.length; offset += width) {
        stream.write(bytes.subarray(offset, offset + width));
      }
      stream.end();
      expect(await result).toEqual({ eof: true, failed: bytes.length > 64, bytes: bytes.length, text: "" });
    }), { seed: 20260912, numRuns: 100 });
});

nativeTest("two actual Darwin daemon children reopen one store and retain ambiguous effects without replay", async () => {
  nativeSpawnFence.begin(Date.now() + 100_000);
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw fail();
  const home = homedir();
  if (process.env.HOME !== home || home === "/" || home === "/private"
    || home === "/private/tmp" || "/private/tmp".startsWith(`${home}/`)
    || await realpath("/private/tmp") !== "/private/tmp") throw fail();
  const created = await mkdtemp("/private/tmp/oompa-dr-");
  retainedRoots.push(created);
  const root = await realpath(created);
  if (root !== created) throw fail();
  await chmod(root, 0o700);
  const paths = restartPaths(root);
  await mkdir(paths.state, { mode: 0o700 });
  await mkdir(paths.project, { mode: 0o700 });
  const statePaths = resolveStatePaths({ rootDirectory: paths.state });
  expect(await initialize(true, false, { writeStdout: () => {}, writeStderr: () => {} },
    { paths: statePaths, documentsDirectory: paths.project })).toBe(0);
  const descriptor = captureRestartDescriptor({ root, runId: randomUUID(), phase: "a" });
  const database = descriptor.database;
  expect(await databaseIdentity(statePaths)).toEqual(database);
  const a = await start(descriptor);
  const stale = await callLocalDaemon({ paths: statePaths, deadlineMs: 1_000,
    command: { kind: "daemon.stop", expected: { ...a.identity, nonce: randomUUID() } } });
  expect(stale).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  await a.assertCurrent();
  const store = new StateStore(statePaths);
  let seeded: Seed;
  let before: ReturnType<typeof snapshot>;
  try {
    seeded = seed(store, a.identity);
    before = snapshot(store, seeded);
    expect(before).toMatchObject({ sessionState: "idle", mutationState: "effect_started",
      mutationResult: undefined, queueState: "dispatching", pendingState: "pending" });
  } finally { store.close(); }
  await a.assertCurrent();
  await a.stop();
  expect(await databaseIdentity(statePaths)).toEqual(database);
  const stopped = new StateStore(statePaths, { readonly: true });
  try { expect(snapshot(stopped, seeded)).toEqual(before); } finally { stopped.close(); }

  const bDescriptor = restartDescriptorSchema.parse({ ...descriptor, phase: "b" });
  const b = await start(bDescriptor, a);
  expect(b.identity.generation).toBe(a.identity.generation + 1);
  expect(b.identity.bootId).not.toBe(a.identity.bootId);
  expect(b.identity.nonce).not.toBe(a.identity.nonce);
  expect(await databaseIdentity(statePaths)).toEqual(database);
  const reopened = new StateStore(statePaths, { readonly: true });
  try {
    const after = snapshot(reopened, seeded);
    expect(after).toMatchObject({ sessionState: "recovery_required", mutationState: "ambiguous",
      mutationResult: { code: "CLAUDE_DAEMON_RESTART_AUTHORITY_RETIRED" },
      queueState: "ambiguous", pendingState: "pending", immutable: before.immutable,
      replay: { id: seeded.attempt, replay: true, state: "ambiguous" } });
    expect(await callLocalDaemon({ paths: statePaths, deadlineMs: 2_000,
      command: { kind: "session.status", session: seeded.session } })).toMatchObject({ ok: true,
      data: { version: 2, session: { id: seeded.session, accountId: seeded.profile, execution: "recovery_required" },
        advisory: { execution: "recovery_required", queueDepth: 1 },
        queue: { depth: 1, dispatchingCount: 0, ambiguousCount: 1, failedCount: 0 } } });
    expect(await callLocalDaemon({ paths: statePaths, deadlineMs: 2_000,
      command: { kind: "session.show", session: seeded.session, detail: false } })).toMatchObject({ ok: true,
      data: { session: { id: seeded.session, profileId: seeded.profile, provider: "claude", state: "recovery_required" },
        recovery: { required: true, cleared: false } } });
    await b.assertCurrent();
    expect(snapshot(reopened, seeded)).toEqual(after);
  } finally { reopened.close(); }
  await b.stop();
  expect(await databaseIdentity(statePaths)).toEqual(database);
  const final = new StateStore(statePaths, { readonly: true });
  try { expect(snapshot(final, seeded)).toMatchObject({ mutationState: "ambiguous",
    mutationResult: { code: "CLAUDE_DAEMON_RESTART_AUTHORITY_RETIRED" },
    queueState: "ambiguous", pendingState: "pending", immutable: before.immutable }); }
  finally { final.close(); }
  console.info(JSON.stringify({ evidence: "credential_free_actual_daemon_store_restart",
    sourceDigest: restartSourceDigest(descriptor), selectedSources: descriptor.files,
    executable: descriptor.executable, daemonA: a.identity, daemonB: b.identity,
    sameDatabase: database, bothChildrenJoined: a.joined && b.joined, retainedRoot: root,
    providerEffectsQualified: false, managedMacActivationAuthorized: false }));
}, 100_000);

afterAll(async () => {
  nativeSpawnFence.close();
  const outcomes = await Promise.allSettled(owners.map(async (owner) => await owner.collectAfterFailure()));
  if (outcomes.some((outcome) => outcome.status === "rejected")) throw fail();
  if (enabled) console.info(JSON.stringify({ evidence: "daemon_restart_fixture_cleanup",
    childrenCollected: owners.length, ordinaryJoined: owners.filter((owner) => owner.joined).length,
    rootsRetained: retainedRoots, privateRootsRemoved: false }));
}, 12_000);
