import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { parseDarwinTerminalDevice } from "../claude-macos-auth-process/detachment";
import { bindDarwinDetachedAuthProcess, type DetachedAuthProcess } from "../claude-macos-auth-process/process";
import { captureNativeClaudeMacosAdmission } from "./admission";
import { QualificationCustody, type QualificationDispatchAuthority, type QualificationDispatchScope } from "./custody";
import { containsAsciiControl } from "./identity";
import { nativeQualificationBindingSchema, qualificationBindingSchema } from "./state";

const deadlineMs = 5000;
const collectionDeadlineMs = 7000; // Includes the existing native adapter's bounded post-deadline collection.
const path = z.string().refine((value) => value.length >= 2 && value.length <= 4096 && isAbsolute(value)
  && resolve(value) === value && !containsAsciiControl(value));
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const uuid = z.string().uuid();
const environmentSchema = z.record(z.string().min(1).max(128), z.string().max(4096).refine((value) => !value.includes("\0")).optional())
  .refine((value) => Object.keys(value).length <= 256);
const commonSchema = z.strictObject({ repositoryRoot: path, sourceCommit: sha, executablePath: path,
  environment: environmentSchema, signal: z.instanceof(AbortSignal) });
const nativeSchema = commonSchema.extend({ custody: z.custom<QualificationCustody>((value) => value instanceof QualificationCustody) });
const fixtureSchema = commonSchema.extend({ collectionDeadlineMs: z.number().int().min(1).max(collectionDeadlineMs).optional() });
const stateSchema = z.object({ binding: z.union([qualificationBindingSchema, nativeQualificationBindingSchema]),
  step: z.union([z.literal(11), z.literal(17), z.literal(19)]), pending: z.strictObject({ attemptId: uuid, stage: z.literal("dispatched") }),
  failure: z.null(), needsRecovery: z.literal(false) });
const sourceSchema = qualificationBindingSchema.pick({ sourceSha: true, sourceTree: true, executable: true });
const detachmentSchema = z.strictObject({ identity: z.strictObject({ pid: z.number().int().positive().max(2_147_483_647),
  pidDomain: z.literal("darwin"), procStart: z.string().min(1).max(80) }), setsidChecked: z.literal(true), newSession: z.literal(true),
  controllingTty: z.literal(false), stdinClosed: z.literal(true) });
const cleanupSchema = z.object({ cleanup: z.literal("joined"), childJoined: z.literal(true), inspectionComplete: z.literal(true),
  inspectorsStarted: z.number().int().min(0).max(2), inspectorsJoined: z.number().int().min(0).max(2) })
  .refine((value) => value.inspectorsStarted === value.inspectorsJoined);
const settlementSchema = z.strictObject({ operation: z.literal("logout"), cleanup: z.literal("joined"), admitted: z.literal(true),
  exitCode: z.literal(0), childJoined: z.literal(true), stdoutEof: z.literal(true), stderrEof: z.literal(true),
  stdoutBytes: z.number().int().min(0).max(16_384), stderrBytes: z.number().int().min(0).max(4096),
  detachment: detachmentSchema, deadlineMs: z.literal(deadlineMs), elapsedMs: z.number().int().min(0).max(deadlineMs - 1),
  inspectionComplete: z.literal(true), inspectorsStarted: z.literal(2), inspectorsJoined: z.literal(2) });
type Cleanup = "not_started" | "joined" | "uncertain";
type Failure = "invalid_input" | "scope_refused" | "authority_refused" | "aborted" | "native_unproved" | "collection_uncertain";
export class ClaudeMacosLogoutError extends Error {
  constructor(readonly code: Failure, readonly cleanup: Cleanup) { super(`CLAUDE_MACOS_LOGOUT_${code}`); this.name = "ClaudeMacosLogoutError"; }
}
type CommonInput = Readonly<z.infer<typeof commonSchema>>;
type Admission = Readonly<{ source: unknown; assertCurrent(): void }>;
type ProcessBinding = Pick<ReturnType<typeof bindDarwinDetachedAuthProcess>, "start" | "settled">;
type Ports = Readonly<{ state(): unknown; capture(input: CommonInput): Admission;
  prepare(scope: QualificationDispatchScope): Promise<QualificationDispatchAuthority>;
  bind(input: Parameters<typeof bindDarwinDetachedAuthProcess>[0]): ProcessBinding }>;
export type CredentialFreeClaudeMacosLogoutPorts = Ports;
const portsSchema = z.strictObject({ state: z.custom<Ports["state"]>((value) => typeof value === "function"),
  capture: z.custom<Ports["capture"]>((value) => typeof value === "function"),
  prepare: z.custom<Ports["prepare"]>((value) => typeof value === "function"), bind: z.custom<Ports["bind"]>((value) => typeof value === "function") });
export type NativeClaudeMacosLogoutInput = z.infer<typeof nativeSchema>;
type Receipt = Readonly<{ kind: "logout_process_joined"; runId: string; attemptId: string; probeId: string; step: 11 | 17 | 19; profile: "A" | "B";
  operation: "logout"; nativeLogoutExitZero: true; childJoined: true; stdoutEof: true; stderrEof: true; cleanup: "joined";
  stdoutBytes: number; stderrBytes: number; stdoutSha256: string; stderrSha256: string; deadlineMs: 5000; elapsedMs: number;
  detachment: Readonly<z.infer<typeof detachmentSchema>>; inspectionComplete: true; inspectorsStarted: 2; inspectorsJoined: 2 }>;
// A missed collector deadline retains the actual operation's promises, not serialized PID authority.
const retainedCollections = new Set<Promise<unknown>>();
// A settled uncertainty is not positive child collection. Keep its actual handle
// even when no promise remains pending; no later call may turn it into a replay.
const retainedUncertainChildren = new Set<DetachedAuthProcess>();
const nativeClaims = new WeakMap<object, Set<string>>();
const fixtureClaims = new WeakMap<object, Set<string>>();
function claimsFor(map: WeakMap<object, Set<string>>, owner: object): Set<string> {
  const existing = map.get(owner);
  if (existing !== undefined) return existing;
  const claims = new Set<string>(); map.set(owner, claims); return claims;
}

async function collect(input: CommonInput, source: "native_process" | "credential_free_fixture", ports: Ports, collectionLimit: number, claims: Set<string>): Promise<Receipt> {
  const current = { child: null as DetachedAuthProcess | null };
  let attempted = false; let joined = false; let closed = false;
  let failure: Failure = "scope_refused";
  const buffers = new Set<Uint8Array>();
  const cleanup = (): Cleanup => !attempted ? "not_started" : joined ? "joined" : "uncertain";
  function refuse(code: Failure): never { throw new ClaudeMacosLogoutError(code, cleanup()); }
  const checkAbort = (): void => { if (input.signal.aborted) refuse("aborted"); };
  const terminate = (): void => { try { current.child?.terminate(); } catch { /* Only observed collection grants cleanup. */ } };
  const wipe = (): void => { for (const bytes of buffers) bytes.fill(0); buffers.clear(); };
  const capture = async (stream: AsyncIterable<Uint8Array>, maximum: number): Promise<Uint8Array> => {
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for await (const value of stream) {
        try {
          if (closed || !(value instanceof Uint8Array) || value.byteLength > maximum - size) throw new Error("logout_output_refused");
          const copy = Uint8Array.from(value); buffers.add(copy); parts.push(copy); size += copy.byteLength;
        } finally { if (value instanceof Uint8Array) value.fill(0); }
      }
      if (closed) throw new Error("logout_collection_closed");
      const output = new Uint8Array(size); buffers.add(output); let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.byteLength; }
      return output;
    } catch (error: unknown) { terminate(); throw error; }
    finally { for (const part of parts) { part.fill(0); buffers.delete(part); } }
  };
  input.signal.addEventListener("abort", terminate);
  try {
    checkAbort();
    const snapshot = stateSchema.safeParse(ports.state());
    if (!snapshot.success || !(source === "native_process" ? nativeQualificationBindingSchema : qualificationBindingSchema).safeParse(snapshot.data.binding).success) refuse("scope_refused");
    const state = snapshot.data;
    const binding = state.binding;
    if (binding.sourceSha !== input.sourceCommit || binding.executable.path !== input.executablePath) refuse("scope_refused");
    const profile = state.step === 17 ? "B" : "A";
    const scope = Object.freeze({ runId: binding.runId, attemptId: state.pending.attemptId, profile, probeId: randomUUID() });
    const environment = Object.freeze({ ...input.environment });
    failure = "authority_refused";
    const admission = ports.capture(input);
    const observedSource = sourceSchema.safeParse(admission.source);
    if (!observedSource.success || JSON.stringify(observedSource.data) !== JSON.stringify({ sourceSha: binding.sourceSha,
      sourceTree: binding.sourceTree, executable: binding.executable })) refuse("authority_refused");
    const assertSource = admission.assertCurrent.bind(admission);
    const ticket = await ports.prepare(scope);
    checkAbort();
    const bound = ports.bind({ executablePath: binding.executable.path, executableSha256: binding.executableDigest,
      configDir: (profile === "A" ? binding.profileA : binding.profileB).path,
      temporaryDirectory: (profile === "A" ? binding.temporaryA : binding.temporaryB).path, environment, deadlineMs });
    const finalState = stateSchema.safeParse(ports.state());
    if (!finalState.success || JSON.stringify(finalState.data) !== JSON.stringify(state)) refuse("authority_refused");
    assertSource(); ticket.assertCurrent(scope); checkAbort();
    // The fixed process binder revalidates executable/environment/roots itself at start.
    // No await separates source + exact current custody authority from this one effect.
    if (claims.has(scope.attemptId) || claims.size >= 3) refuse("authority_refused");
    claims.add(scope.attemptId); // Sticky even when start throws; an uncertain effect cannot be retried.
    failure = "native_unproved"; attempted = true;
    current.child = bound.start("logout");
    const owned = current.child;
    if (input.signal.aborted) terminate();
    const collection = Promise.allSettled([
      Promise.resolve().then(async () => await capture(owned.stdout, 16_384)),
      Promise.resolve().then(async () => await capture(owned.stderr, 4096)),
      Promise.resolve().then(async () => await owned.exited),
      Promise.resolve().then(async () => await bound.settled()),
    ]);
    retainedCollections.add(collection);
    void collection.then(() => { retainedCollections.delete(collection); if (closed) wipe(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let results: Awaited<typeof collection>;
    try {
      results = await Promise.race([collection, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          terminate(); try { owned.forceTerminate(); } catch { /* A signal attempt is not a join. */ }
          reject(new ClaudeMacosLogoutError("collection_uncertain", "uncertain"));
        }, collectionLimit);
      })]);
    } finally { clearTimeout(timer); }
    const terminal: unknown = results[3].status === "fulfilled" ? results[3].value : null;
    joined = cleanupSchema.safeParse(terminal).success;
    checkAbort();
    if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled" || results[2].status !== "fulfilled") refuse("native_unproved");
    const accepted = settlementSchema.safeParse(terminal);
    if (!accepted.success) refuse("native_unproved");
    const stdout = results[0].value; const stderr = results[1].value; const observed = accepted.data;
    if (observed.exitCode !== results[2].value || observed.stdoutBytes !== stdout.byteLength || observed.stderrBytes !== stderr.byteLength) refuse("native_unproved");
    parseDarwinTerminalDevice(`${String(observed.detachment.identity.pid)} ${observed.detachment.identity.procStart} ??\n`);
    return Object.freeze({ kind: "logout_process_joined", runId: scope.runId, attemptId: scope.attemptId, probeId: scope.probeId, step: state.step, profile,
      operation: "logout", nativeLogoutExitZero: true, childJoined: true, stdoutEof: true, stderrEof: true, cleanup: "joined",
      stdoutBytes: stdout.byteLength, stderrBytes: stderr.byteLength, stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
      stderrSha256: createHash("sha256").update(stderr).digest("hex"), deadlineMs, elapsedMs: observed.elapsedMs,
      detachment: Object.freeze({ ...observed.detachment, identity: Object.freeze({ ...observed.detachment.identity }) }),
      inspectionComplete: true, inspectorsStarted: 2, inspectorsJoined: 2 });
  } catch (error: unknown) {
    if (error instanceof ClaudeMacosLogoutError) throw error;
    throw new ClaudeMacosLogoutError(input.signal.aborted ? "aborted" : failure, cleanup());
  } finally {
    if (attempted && !joined && current.child !== null) retainedUncertainChildren.add(current.child);
    closed = true; wipe(); input.signal.removeEventListener("abort", terminate);
  }
}

/** Fixed current A/11, B/17 or A/19 logout only. This never settles a step or proves signed-out identity. */
export async function collectNativeClaudeMacosLogout(input: unknown): Promise<Receipt & Readonly<{ source: "native_process" }>> {
  const parsed = nativeSchema.safeParse(input);
  if (!parsed.success) throw new ClaudeMacosLogoutError("invalid_input", "not_started");
  const custody = parsed.data.custody;
  const state = (): unknown => Reflect.get(QualificationCustody.prototype, "state", custody);
  try { state(); } catch { throw new ClaudeMacosLogoutError("scope_refused", "not_started"); }
  const request = Object.freeze({ ...parsed.data, environment: Object.freeze({ ...parsed.data.environment }) });
  const value = await collect(request, "native_process", { state,
    capture(actual) { return captureNativeClaudeMacosAdmission({ repositoryRoot: actual.repositoryRoot,
      sourceCommit: actual.sourceCommit, executablePath: actual.executablePath }); },
    prepare: QualificationCustody.prototype.prepareDispatchAuthority.bind(custody), bind: bindDarwinDetachedAuthProcess,
  }, collectionDeadlineMs, claimsFor(nativeClaims, custody));
  return Object.freeze({ ...value, source: "native_process" });
}

/** Synthetic ports and deadline only; these bytes can never acquire native provenance. */
export async function collectCredentialFreeClaudeMacosLogout(input: unknown, portsInput: unknown): Promise<Receipt & Readonly<{ source: "credential_free_fixture" }>> {
  const parsed = fixtureSchema.safeParse(input); const ports = portsSchema.safeParse(portsInput);
  if (!parsed.success || !ports.success) throw new ClaudeMacosLogoutError("invalid_input", "not_started");
  const request = Object.freeze({ ...parsed.data, environment: Object.freeze({ ...parsed.data.environment }) });
  const value = await collect(request, "credential_free_fixture", Object.freeze({ ...ports.data }), parsed.data.collectionDeadlineMs ?? collectionDeadlineMs, claimsFor(fixtureClaims, portsInput as object));
  return Object.freeze({ ...value, source: "credential_free_fixture" });
}
