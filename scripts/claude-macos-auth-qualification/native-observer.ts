import { timingSafeEqual } from "node:crypto";
import { posix } from "node:path";

import { z } from "zod";

import type { ClaudeQualificationBindingInput } from "../claude-macos-auth-process/binding";
import { parseDarwinTerminalDevice } from "../claude-macos-auth-process/detachment";
import { bindDarwinDetachedAuthProcess, observeDarwinDetachedStatusOverlap, type DetachedAuthProcess, type DetachedStatusOverlap } from "../claude-macos-auth-process/process";
import { containsAsciiControl, type PrivateIdentityObservation } from "./identity";
import { observePrivateClaudeIdentity, type PrivateIdentityProbeRequest, type QualificationMetadataIdentityReader } from "./observer";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const path = z.string().min(2).max(4096).refine((value) => value.startsWith("/") && posix.normalize(value) === value && !containsAsciiControl(value));
const requestSchema = z.strictObject({ key: z.instanceof(Uint8Array).refine((value) => value.byteLength === 32),
  runId: uuid, attemptId: uuid, probeId: uuid, profile: z.enum(["A", "B"]), configDir: path,
  deadlineMs: z.number().int().min(3000).max(5000), signal: z.instanceof(AbortSignal) });
const runtimeSchema = z.strictObject({ executablePath: path, executableSha256: z.string().regex(/^[0-9a-f]{64}$/u), configDir: path, temporaryDirectory: path,
  environment: z.record(z.string().min(1).max(128), z.string().max(4096).refine((value) => !value.includes("\0")).optional())
    .refine((value) => Object.keys(value).length <= 256) });
const detachmentSchema = z.strictObject({ identity: z.strictObject({ pid: z.number().int().positive().max(2_147_483_647), pidDomain: z.literal("darwin"), procStart: z.string().min(1).max(80) }),
  setsidChecked: z.literal(true), newSession: z.literal(true), controllingTty: z.literal(false), stdinClosed: z.literal(true) });
const settlementSchema = z.strictObject({ operation: z.literal("status"), cleanup: z.literal("joined"), admitted: z.literal(true), exitCode: z.union([z.literal(0), z.literal(1)]),
  childJoined: z.literal(true), stdoutEof: z.literal(true), stderrEof: z.literal(true), stdoutBytes: z.number().int().min(2).max(16_384), stderrBytes: z.number().int().min(0).max(4096),
  detachment: detachmentSchema, deadlineMs: z.number().int().min(3000).max(5000), elapsedMs: z.number().int().nonnegative().safe(),
  inspectionComplete: z.literal(true), inspectorsStarted: z.literal(2), inspectorsJoined: z.literal(2) });

export type NativeIdentityAuthorityScope = Readonly<Omit<PrivateIdentityProbeRequest, "key"> & { runtime: ClaudeQualificationBindingInput }>;
export type NativeIdentityLaunchAuthority = Readonly<{
  revalidate(scope: NativeIdentityAuthorityScope): Promise<Readonly<{ assertCurrent(scope: NativeIdentityAuthorityScope): void }>>;
}>;
export type NativeIdentityProbeInput = Readonly<{ request: PrivateIdentityProbeRequest; runtime: ClaudeQualificationBindingInput; authority: NativeIdentityLaunchAuthority }>;
type NativeObservation = Readonly<{
  runId: string; attemptId: string; probeId: string; profile: "A" | "B";
  detachment: Readonly<z.infer<typeof detachmentSchema>>;
  deadlineMs: number; elapsedMs: number; stdoutBytes: number; stderrBytes: number;
}>;
type IdentityProbe = Readonly<{ identity: PrivateIdentityObservation; native: NativeObservation }>;
type FixturePorts = Readonly<{
  readMetadataIdentity: QualificationMetadataIdentityReader;
  bindStatus(input: ClaudeQualificationBindingInput & Readonly<{ deadlineMs: number }>): Readonly<{ startStatus(): DetachedAuthProcess }>;
}>;
type Cleanup = "not_started" | "joined" | "uncertain";
export class NativeIdentityObserverError extends Error {
  constructor(readonly code: "invalid_input" | "aborted" | "scope_mismatch" | "authority_unavailable" | "native_unproved" | "observation_unproved", readonly cleanup: Cleanup) {
    super(`CLAUDE_MACOS_NATIVE_IDENTITY_${code}`); this.name = "NativeIdentityObserverError";
  }
}

async function collectBytes(source: AsyncIterable<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for await (const value of source) {
      try {
        if (!(value instanceof Uint8Array) || value.byteLength > maximum - length) throw new NativeIdentityObserverError("native_unproved", "uncertain");
        length += value.byteLength; chunks.push(Uint8Array.from(value));
      } finally { if (value instanceof Uint8Array) value.fill(0); }
    }
    const output = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
    return output;
  } finally { for (const chunk of chunks) chunk.fill(0); }
}

async function observe(input: NativeIdentityProbeInput, ports: Readonly<{
  bindStatus: FixturePorts["bindStatus"];
  readMetadataIdentity?: QualificationMetadataIdentityReader;
  rendezvous?: (start: () => DetachedAuthProcess) => Promise<void>;
}>): Promise<IdentityProbe> {
  const parsed = requestSchema.safeParse(input.request);
  const runtimeParsed = runtimeSchema.safeParse(input.runtime);
  if (!parsed.success || !runtimeParsed.success || typeof input.authority.revalidate !== "function") throw new NativeIdentityObserverError("invalid_input", "not_started");
  const request = Object.freeze({ ...parsed.data, key: Uint8Array.from(parsed.data.key) });
  const runtime = Object.freeze({ ...runtimeParsed.data, environment: Object.freeze({ ...runtimeParsed.data.environment }) });
  const revalidate = input.authority.revalidate.bind(input.authority);
  if (runtime.configDir !== request.configDir) { request.key.fill(0); throw new NativeIdentityObserverError("scope_mismatch", "not_started"); }
  const scope: NativeIdentityAuthorityScope = Object.freeze({ runId: request.runId, attemptId: request.attemptId, probeId: request.probeId,
    profile: request.profile, configDir: request.configDir, deadlineMs: request.deadlineMs, signal: request.signal, runtime });
  let child: DetachedAuthProcess | null = null;
  let attempted = false;
  let observedJoin = false;
  let native: NativeObservation | null = null;
  const readNative = (): NativeObservation | null => native;
  const raw: Uint8Array[] = [];
  const cleanup = (): Cleanup => observedJoin ? "joined" : attempted ? "uncertain" : "not_started";
  const checkAbort = (): void => { if (request.signal.aborted) throw new NativeIdentityObserverError("aborted", cleanup()); };
  const abort = (): void => { try { child?.terminate(); } catch { /* The actual joined settlement remains required. */ } };
  request.signal.addEventListener("abort", abort);
  try {
    checkAbort();
    const identity = await observePrivateClaudeIdentity(request, {
      ...(ports.readMetadataIdentity === undefined ? {} : { readMetadataIdentity: ports.readMetadataIdentity }),
      async probeJoinedStatus(actual) {
        if (actual.runId !== scope.runId || actual.attemptId !== scope.attemptId || actual.probeId !== scope.probeId || actual.profile !== scope.profile
          || actual.configDir !== scope.configDir || actual.deadlineMs !== scope.deadlineMs || actual.signal !== scope.signal || attempted) throw new NativeIdentityObserverError("scope_mismatch", cleanup());
        checkAbort();
        const current = await revalidate(scope);
        checkAbort();
        if (typeof current.assertCurrent !== "function") throw new NativeIdentityObserverError("authority_unavailable", "not_started");
        const binding = ports.bindStatus({ ...runtime, deadlineMs: request.deadlineMs });
        const start = (): DetachedAuthProcess => {
          if (attempted) throw new NativeIdentityObserverError("scope_mismatch", cleanup());
          current.assertCurrent(scope);
          checkAbort();
          attempted = true;
          child = binding.startStatus();
          if (request.signal.aborted) abort();
          return child;
        };
        // Only the private pair coordinator supplies this hook. The ordinary
        // single probe retains its synchronous assertion/start ordering.
        const rendezvous = ports.rendezvous;
        const owned = rendezvous === undefined ? start() : await (async () => {
          await rendezvous(start);
          const readChild = (): DetachedAuthProcess | null => child;
          const value = readChild();
          if (value === null) throw new NativeIdentityObserverError("native_unproved", cleanup());
          return value;
        })();
        const settled = await Promise.allSettled([collectBytes(owned.stdout, 16_384), collectBytes(owned.stderr, 4096), owned.exited, owned.settlement]);
        for (const captured of [settled[0], settled[1]]) if (captured.status === "fulfilled") raw.push(captured.value);
        const terminal = settled[3];
        observedJoin = terminal.status === "fulfilled" && terminal.value.cleanup === "joined" && terminal.value.childJoined
          && terminal.value.inspectionComplete && Number.isSafeInteger(terminal.value.inspectorsStarted) && terminal.value.inspectorsStarted >= 0
          && terminal.value.inspectorsStarted === terminal.value.inspectorsJoined;
        checkAbort();
        if (settled[0].status !== "fulfilled" || settled[1].status !== "fulfilled" || settled[2].status !== "fulfilled" || terminal.status !== "fulfilled") throw new NativeIdentityObserverError("native_unproved", cleanup());
        const accepted = settlementSchema.safeParse(terminal.value);
        if (!accepted.success) throw new NativeIdentityObserverError("native_unproved", cleanup());
        const value = accepted.data;
        const stdout = settled[0].value;
        const stderr = settled[1].value;
        const detached = value.detachment;
        parseDarwinTerminalDevice(`${String(detached.identity.pid)} ${detached.identity.procStart} ??\n`);
        if (value.deadlineMs !== request.deadlineMs || value.elapsedMs >= request.deadlineMs || value.exitCode !== settled[2].value
          || value.stdoutBytes !== stdout.byteLength || value.stderrBytes !== stderr.byteLength) throw new NativeIdentityObserverError("native_unproved", cleanup());
        native = Object.freeze({ runId: request.runId, attemptId: request.attemptId, probeId: request.probeId, profile: request.profile,
          detachment: Object.freeze({ ...detached, identity: Object.freeze({ ...detached.identity }) }),
          deadlineMs: value.deadlineMs, elapsedMs: value.elapsedMs, stdoutBytes: value.stdoutBytes, stderrBytes: value.stderrBytes });
        return { stdout, stderrBytes: stderr.byteLength, exitCode: value.exitCode, joined: true, stdoutEof: true, stderrEof: true,
          deadlineMs: value.deadlineMs, elapsedMs: value.elapsedMs };
      },
    });
    const observation = readNative();
    if (observation === null) throw new NativeIdentityObserverError("native_unproved", cleanup());
    return Object.freeze({ identity: Object.freeze(identity), native: observation });
  } catch (error: unknown) {
    if (error instanceof NativeIdentityObserverError) throw error;
    throw new NativeIdentityObserverError(request.signal.aborted ? "aborted" : "observation_unproved", cleanup());
  } finally {
    request.signal.removeEventListener("abort", abort);
    request.key.fill(0);
    for (const bytes of raw) bytes.fill(0);
  }
}

/** No native override and no CLI: the required owner closure supplies launch authority. */
export async function observeNativePrivateClaudeIdentity(input: NativeIdentityProbeInput): Promise<IdentityProbe & Readonly<{ source: "native_process" }>> {
  const value = await observe(input, { bindStatus(binding) {
    const process = bindDarwinDetachedAuthProcess(binding);
    return { startStatus: () => process.start("status") };
  } });
  return Object.freeze({ ...value, source: "native_process" });
}

/** Explicit fixture composition; its result can never be labeled native_process. */
export async function observeCredentialFreeNativeIdentity(input: NativeIdentityProbeInput, ports: FixturePorts): Promise<IdentityProbe & Readonly<{ source: "credential_free_fixture" }>> {
  if (typeof ports.readMetadataIdentity !== "function" || typeof ports.bindStatus !== "function") throw new NativeIdentityObserverError("invalid_input", "not_started");
  return Object.freeze({ ...await observe(input, ports), source: "credential_free_fixture" });
}

export type NativeIdentityPairInput = Readonly<{
  first: NativeIdentityProbeInput;
  second: NativeIdentityProbeInput;
  overlapDeadlineMs: number;
}>;
type IdentityPair = Readonly<{ first: IdentityProbe; second: IdentityProbe; overlap: DetachedStatusOverlap }>;
type PairFixturePorts = FixturePorts & Readonly<{
  observeOverlap(first: DetachedAuthProcess, second: DetachedAuthProcess, options: Readonly<{ signal: AbortSignal; deadlineMs: number }>): Promise<DetachedStatusOverlap>;
}>;
const authoritySchema = z.strictObject({ revalidate: z.custom<NativeIdentityLaunchAuthority["revalidate"]>((value) => typeof value === "function") });
const probeSchema = z.strictObject({ request: requestSchema, runtime: runtimeSchema, authority: authoritySchema });
const pairSchema = z.strictObject({ first: probeSchema, second: probeSchema, overlapDeadlineMs: z.number().int().min(100).max(1000) });
const rendezvousWaiter = () => {
  const state = Promise.withResolvers<undefined>();
  return { promise: state.promise, resolve: () => state.resolve(undefined), reject: state.reject };
};
const isOverlapOrder = (value: unknown): value is "A1_B_A2" => value === "A1_B_A2";

function capturePair(input: NativeIdentityPairInput): NativeIdentityPairInput {
  const parsed = pairSchema.safeParse(input);
  if (!parsed.success) throw new NativeIdentityObserverError("invalid_input", "not_started");
  const { first, second } = parsed.data;
  const a = first.request; const b = second.request;
  const roots = [a.configDir, b.configDir, first.runtime.temporaryDirectory, second.runtime.temporaryDirectory];
  if (a.profile !== "A" || b.profile !== "B" || a.runId !== b.runId || a.attemptId !== b.attemptId || a.probeId === b.probeId
    || !timingSafeEqual(a.key, b.key) || a.configDir !== first.runtime.configDir || b.configDir !== second.runtime.configDir
    || first.runtime.executablePath !== second.runtime.executablePath || first.runtime.executableSha256 !== second.runtime.executableSha256
    || roots.some((value, index) => roots.some((other, otherIndex) => index !== otherIndex && (value === other || value.startsWith(`${other}/`))))) {
    throw new NativeIdentityObserverError("scope_mismatch", "not_started");
  }
  const capture = (value: NativeIdentityProbeInput, original: NativeIdentityProbeInput): NativeIdentityProbeInput => Object.freeze({
    request: Object.freeze({ ...value.request, key: Uint8Array.from(value.request.key) }),
    runtime: Object.freeze({ ...value.runtime, environment: Object.freeze({ ...value.runtime.environment }) }),
    authority: Object.freeze({ revalidate: value.authority.revalidate.bind(original.authority) }),
  });
  return Object.freeze({ first: capture(first, input.first), second: capture(second, input.second), overlapDeadlineMs: parsed.data.overlapDeadlineMs });
}

/** All hooks here remain private, and the native entry supplies only real ports. */
async function observePair(input: NativeIdentityPairInput, ports: Readonly<{
  bindStatus: FixturePorts["bindStatus"];
  readMetadataIdentity?: QualificationMetadataIdentityReader;
  observeOverlap: PairFixturePorts["observeOverlap"];
}>): Promise<IdentityPair> {
  const pair = capturePair(input);
  const requests = [pair.first, pair.second] as const;
  const cancellation = new AbortController();
  const children: (DetachedAuthProcess | null)[] = [null, null];
  const starts: (() => DetachedAuthProcess)[] = [];
  const waiters = [rendezvousWaiter(), rendezvousWaiter()] as const;
  // A peer can fail before the other observer reaches its status callback.
  // Rejections are retained here even when no callback ever awaits that waiter.
  for (const waiter of waiters) void waiter.promise.catch(() => undefined);
  let failed = false;
  let overlap: PromiseSettledResult<DetachedStatusOverlap> | null = null;
  let overlapPending: Promise<void> | null = null;
  const readOverlap = () => overlap;
  const readPending = (): Promise<void> | null => overlapPending;
  const hasFailed = (): boolean => failed;
  const stop = (): void => {
    if (failed) return;
    failed = true;
    cancellation.abort();
    for (const child of children) { try { child?.terminate(); } catch { /* The original settlement still decides cleanup. */ } }
    for (const waiter of waiters) waiter.reject(new Error("private_pair_stopped"));
  };
  const aborted = (): boolean => requests.some((value) => value.request.signal.aborted);
  const rendezvous = (index: 0 | 1, start: () => DetachedAuthProcess): Promise<void> => {
    if (failed || aborted() || starts[index] !== undefined) {
      stop(); return Promise.reject(new NativeIdentityObserverError("observation_unproved", "not_started"));
    }
    starts[index] = start;
    if (starts[0] !== undefined && starts[1] !== undefined) {
      try {
        // No await occurs between final owner assertion and either fixed start,
        // or between the second start and native overlap inspection.
        children[0] = starts[0](); waiters[0].resolve();
        if (hasFailed() || aborted()) throw new Error("private_pair_stopped");
        children[1] = starts[1](); waiters[1].resolve();
        // Even a fixture port's synchronous throw cannot erase an attempted
        // inspector operation from the cleanup accounting.
        overlap = { status: "rejected", reason: new Error("private_overlap_unsettled") };
        overlapPending = Promise.resolve(ports.observeOverlap(children[0], children[1], { signal: cancellation.signal, deadlineMs: pair.overlapDeadlineMs }))
          .then((value) => { overlap = { status: "fulfilled", value }; if (!value.admitted || value.cleanup !== "joined") stop(); },
            (reason: unknown) => { overlap = { status: "rejected", reason }; stop(); });
      } catch { stop(); }
    }
    return waiters[index].promise;
  };
  for (const value of requests) value.request.signal.addEventListener("abort", stop);
  try {
    if (aborted()) stop();
    const observers = requests.map((value, index) => observe(value, { bindStatus: ports.bindStatus,
      ...(ports.readMetadataIdentity === undefined ? {} : { readMetadataIdentity: ports.readMetadataIdentity }),
      rendezvous: (start) => rendezvous(index === 0 ? 0 : 1, start),
    }).catch((error: unknown) => { stop(); throw error instanceof NativeIdentityObserverError ? error : new NativeIdentityObserverError("observation_unproved", "uncertain"); }));
    const results = await Promise.allSettled(observers);
    await readPending();
    const nativeOverlap = readOverlap();
    let cleanup: Cleanup = "not_started";
    for (const result of results) {
      const value = result.status === "fulfilled" ? "joined" : result.reason instanceof NativeIdentityObserverError ? result.reason.cleanup : "uncertain";
      if (value === "uncertain" || (value === "joined" && cleanup === "not_started")) cleanup = value;
    }
    if (nativeOverlap !== null && (nativeOverlap.status === "rejected" || nativeOverlap.value.cleanup !== "joined")) cleanup = "uncertain";
    const first = results[0]; const second = results[1];
    if (hasFailed() || aborted() || first?.status !== "fulfilled" || second?.status !== "fulfilled" || nativeOverlap?.status !== "fulfilled") {
      throw new NativeIdentityObserverError(aborted() ? "aborted" : "observation_unproved", cleanup);
    }
    const proof = nativeOverlap.value;
    const witness = proof.witness;
    const sameIdentity = (actual: NonNullable<DetachedStatusOverlap["witness"]>["first"], expected: NativeObservation["detachment"]["identity"]): boolean =>
      actual.pid === expected.pid && actual.pidDomain === expected.pidDomain && actual.procStart === expected.procStart;
    if (!proof.admitted || proof.cleanup !== "joined" || proof.reason !== "observed" || proof.observationDeadlineMs !== pair.overlapDeadlineMs
      || !Number.isSafeInteger(proof.observationElapsedMs) || proof.observationElapsedMs < 0 || proof.observationElapsedMs >= pair.overlapDeadlineMs
      || proof.inspectorsStarted !== 3 || proof.inspectorsJoined !== 3 || proof.targetsJoined !== 2 || witness === null || !isOverlapOrder(witness.order)
      || !sameIdentity(witness.first, first.value.native.detachment.identity) || !sameIdentity(witness.second, second.value.native.detachment.identity)) {
      throw new NativeIdentityObserverError("native_unproved", cleanup);
    }
    return Object.freeze({ first: first.value, second: second.value, overlap: Object.freeze({ ...proof,
      witness: Object.freeze({ ...witness, first: Object.freeze({ ...witness.first }), second: Object.freeze({ ...witness.second }) }) }) });
  } finally {
    for (const value of requests) { value.request.signal.removeEventListener("abort", stop); value.request.key.fill(0); }
  }
}

/** Fixed native pair only; the returned overlap comes from actual held instances. */
export async function observeNativePrivateClaudeIdentityPair(input: NativeIdentityPairInput): Promise<IdentityPair & Readonly<{ source: "native_process" }>> {
  const result = await observePair(input, { bindStatus(binding) {
    const process = bindDarwinDetachedAuthProcess(binding);
    return { startStatus: () => process.start("status") };
  }, observeOverlap: observeDarwinDetachedStatusOverlap });
  return Object.freeze({ ...result, source: "native_process" });
}

/** Synthetic composition cannot produce native_process authority. */
export async function observeCredentialFreeNativeIdentityPair(input: NativeIdentityPairInput, ports: PairFixturePorts): Promise<IdentityPair & Readonly<{ source: "credential_free_fixture" }>> {
  if (typeof ports.readMetadataIdentity !== "function" || typeof ports.bindStatus !== "function" || typeof ports.observeOverlap !== "function") {
    throw new NativeIdentityObserverError("invalid_input", "not_started");
  }
  return Object.freeze({ ...await observePair(input, ports), source: "credential_free_fixture" });
}
