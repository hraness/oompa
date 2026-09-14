import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import { CLAUDE_PIN } from "../../src/claude/pin";
import { resolvePinnedClaudeRuntime, type ClaudeVersionProbeProcess, type PinnedClaudeRuntime } from "../../src/claude/runtime";
import { inspectClaudeAuthLoginHelp, parseClaudeAuthLoginHelp, parseClaudeAuthLogoutHelp } from "../claude-auth-help";
import { parseDarwinTerminalDevice } from "../claude-macos-auth-process/detachment";
import { bindDarwinDetachedAuthProcess, type DetachedAuthSettlement } from "../claude-macos-auth-process/process";
import { QualificationCustody, type QualificationDispatchAuthority, type QualificationDispatchScope } from "./custody";
import { nativeQualificationBindingSchema, qualificationBindingSchema } from "./state";

const deadlineMs = 5000;
const operations = ["version", "login_help", "logout_help"] as const;
type Operation = typeof operations[number];
type Cleanup = "not_started" | "joined" | "uncertain";
type Failure = "invalid_input" | "scope_refused" | "authority_refused" | "aborted" | "native_unproved" | "capability_refused" | "runtime_refused";
export class ClaudeMacosPreflightError extends Error {
  constructor(readonly code: Failure, readonly cleanup: Cleanup) {
    super(`CLAUDE_MACOS_PREFLIGHT_${code}`); this.name = "ClaudeMacosPreflightError";
  }
}

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const environmentSchema = z.record(z.string().min(1).max(128), z.string().max(4096).refine((value) => !value.includes("\0")).optional())
  .refine((value) => Object.keys(value).length <= 256);
const snapshotSchema = z.object({ binding: z.union([qualificationBindingSchema, nativeQualificationBindingSchema]), step: z.literal(0),
  pending: z.strictObject({ attemptId: uuid, stage: z.literal("dispatched") }), failure: z.null(), needsRecovery: z.literal(false) });
const detachmentSchema = z.strictObject({ identity: z.strictObject({ pid: z.number().int().positive().max(2_147_483_647), pidDomain: z.literal("darwin"), procStart: z.string().min(1).max(80) }),
  setsidChecked: z.literal(true), newSession: z.literal(true), controllingTty: z.literal(false), stdinClosed: z.literal(true) });
const settlementSchema = z.strictObject({ operation: z.enum(operations), cleanup: z.literal("joined"), admitted: z.literal(true), exitCode: z.literal(0),
  childJoined: z.literal(true), stdoutEof: z.literal(true), stderrEof: z.literal(true), stdoutBytes: z.number().int().positive().max(16_384), stderrBytes: z.literal(0),
  detachment: detachmentSchema, deadlineMs: z.literal(deadlineMs), elapsedMs: z.number().int().nonnegative().max(deadlineMs - 1),
  inspectionComplete: z.literal(true), inspectorsStarted: z.literal(2), inspectorsJoined: z.literal(2) });

export type ClaudeMacosPreflightScope = Readonly<QualificationDispatchScope & {
  operation: Operation; sourceSha: string; sourceTree: string;
  executablePath: string; executableSha256: string; executableDevice: number; executableInode: number; configDir: string; temporaryDirectory: string;
  environment: Readonly<Record<string, string | undefined>>; signal: AbortSignal; deadlineMs: number;
}>;
export type ClaudeMacosPreflightAuthority = Readonly<{
  revalidate(scope: ClaudeMacosPreflightScope): Promise<Readonly<{ assertCurrent(scope: ClaudeMacosPreflightScope): void }>>;
}>;
type CommonInput = Readonly<{ environment: Readonly<Record<string, string | undefined>>; signal: AbortSignal; authority: ClaudeMacosPreflightAuthority }>;
export type NativeClaudeMacosPreflightInput = CommonInput & Readonly<{ custody: QualificationCustody }>;
type NativeBinding = ReturnType<typeof bindDarwinDetachedAuthProcess>;
type FixturePorts = Readonly<{
  prepareDispatchAuthority(scope: QualificationDispatchScope): Promise<QualificationDispatchAuthority>;
  bindProcess(input: Parameters<typeof bindDarwinDetachedAuthProcess>[0]): NativeBinding;
  resolveRuntime: typeof resolvePinnedClaudeRuntime;
}>;
type Probe = Readonly<{
  runId: string; attemptId: string; probeId: string; profile: "A" | "B"; operation: Operation;
  stdoutSha256: string; stdoutBytes: number; stderrBytes: 0; deadlineMs: number; elapsedMs: number;
  detachment: Readonly<z.infer<typeof detachmentSchema>>;
  loginHelp: Readonly<Pick<ReturnType<typeof inspectClaudeAuthLoginHelp>, "optionRows" | "projectionComplete" | "diagnostics">> | null;
}>;
type Diagnostic = Readonly<{
  admitted: false; reason: "login_help_unverified"; runId: string; attemptId: string;
  exactVersionBoth: true; logoutHelpBoth: true; loginHelpBoth: false; probes: readonly Probe[];
}>;
export type ClaudeMacosCapabilities = Readonly<{
  kind: "capabilities_only"; runId: string; attemptId: string;
  exactVersionBoth: true; logoutHelpBoth: true; loginHelpBoth: true; probes: readonly Probe[];
  runtimes: Readonly<{ A: PinnedClaudeRuntime; B: PinnedClaudeRuntime }>;
}>;
const authoritySchema = z.strictObject({ revalidate: z.custom<ClaudeMacosPreflightAuthority["revalidate"]>((value) => typeof value === "function") });
const commonSchema = z.strictObject({ environment: environmentSchema, signal: z.instanceof(AbortSignal), authority: authoritySchema });
const nativeInputSchema = commonSchema.extend({ custody: z.custom<QualificationCustody>((value) => value instanceof QualificationCustody) });
const fixtureInputSchema = commonSchema.extend({ state: z.unknown() });
const resolvedRuntimeSchema = z.object({ executablePath: z.string().max(4096), version: z.literal(CLAUDE_PIN) });

async function collectBytes(source: AsyncIterable<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for await (const value of source) {
      try {
        if (!(value instanceof Uint8Array) || value.byteLength > maximum - size) throw new Error("bounded_output_refused");
        size += value.byteLength; chunks.push(Uint8Array.from(value));
      } finally { if (value instanceof Uint8Array) value.fill(0); }
    }
    const output = new Uint8Array(size); let offset = 0;
    for (const value of chunks) { output.set(value, offset); offset += value.byteLength; }
    return output;
  } finally { for (const value of chunks) value.fill(0); }
}
const sameEnvironment = (a: Readonly<Record<string, string | undefined>>, b: Readonly<Record<string, string | undefined>>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => Object.hasOwn(b, key) && a[key] === b[key]);

/** Private composition only; metadata/source authority must settle independently of native deadlines. */
async function collectPreflight(input: CommonInput, stateInput: unknown, source: "native_process" | "credential_free_fixture", ports: FixturePorts, mode: "diagnostic"): Promise<Diagnostic>;
async function collectPreflight(input: CommonInput, stateInput: unknown, source: "native_process" | "credential_free_fixture", ports: FixturePorts, mode: "strict"): Promise<ClaudeMacosCapabilities>;
async function collectPreflight(input: CommonInput, stateInput: unknown, source: "native_process" | "credential_free_fixture", ports: FixturePorts, mode: "diagnostic" | "strict"): Promise<Diagnostic | ClaudeMacosCapabilities> {
  const state = snapshotSchema.safeParse(stateInput);
  if (!state.success || (source === "native_process" ? !nativeQualificationBindingSchema.safeParse(state.data.binding).success
    : !qualificationBindingSchema.safeParse(state.data.binding).success)) throw new ClaudeMacosPreflightError("scope_refused", "not_started");
  const binding = state.data.binding; const attemptId = state.data.pending.attemptId;
  const environment = Object.freeze({ ...input.environment });
  const revalidate = input.authority.revalidate.bind(input.authority);
  const probes: Probe[] = []; const issued = new Set<string>();
  const runtimes = new Map<"A" | "B", PinnedClaudeRuntime>();
  let started = 0; let joined = 0; let active: ClaudeVersionProbeProcess | null = null;
  let failure: Failure = "authority_refused";
  const cleanup = (): Cleanup => started === 0 ? "not_started" : started === joined ? "joined" : "uncertain";
  const abort = (): void => { try { active?.terminate(); } catch { /* Only positive native collection changes cleanup. */ } };
  const checkAbort = (): void => { if (input.signal.aborted) throw new ClaudeMacosPreflightError("aborted", cleanup()); };
  input.signal.addEventListener("abort", abort);

  async function probe(scope: ClaudeMacosPreflightScope): Promise<string | null> {
    checkAbort(); failure = "authority_refused";
    const current = await revalidate(scope);
    checkAbort();
    if (typeof current.assertCurrent !== "function") throw new ClaudeMacosPreflightError("authority_refused", cleanup());
    const dispatch = Object.freeze({ runId: scope.runId, attemptId: scope.attemptId, profile: scope.profile, probeId: scope.probeId });
    const ticket = await ports.prepareDispatchAuthority(dispatch);
    checkAbort();
    if (typeof ticket.assertCurrent !== "function") throw new ClaudeMacosPreflightError("authority_refused", cleanup());
    const native = ports.bindProcess({ executablePath: scope.executablePath, executableSha256: scope.executableSha256,
      configDir: scope.configDir, temporaryDirectory: scope.temporaryDirectory, environment, deadlineMs });
    current.assertCurrent(scope);
    ticket.assertCurrent(dispatch);
    checkAbort();
    // No await separates the final source/custody assertions from the fixed start.
    failure = "native_unproved"; started += 1;
    active = scope.operation === "version" ? native.versionFactory({ argv: [scope.executablePath, "--version"], environment: native.environment }) : native.start(scope.operation);
    const owned = active;
    if (input.signal.aborted) abort();
    const raw: Uint8Array[] = [];
    const capture = (value: AsyncIterable<Uint8Array>, maximum: number): Promise<Uint8Array> => collectBytes(value, maximum).catch((error: unknown) => { abort(); throw error; });
    try {
      const results = await Promise.allSettled([capture(owned.stdout, scope.operation === "version" ? 512 : 16_384), capture(owned.stderr, 4096), owned.exited, native.settled()]);
      for (const value of [results[0], results[1]]) if (value.status === "fulfilled") raw.push(value.value);
      const terminal = results[3];
      const value: DetachedAuthSettlement | null = terminal.status === "fulfilled" ? terminal.value : null;
      if (value?.cleanup === "joined" && value.childJoined && value.inspectionComplete && Number.isSafeInteger(value.inspectorsStarted)
        && value.inspectorsStarted >= 0 && value.inspectorsStarted === value.inspectorsJoined) joined += 1;
      checkAbort();
      if (results[0].status !== "fulfilled" || results[1].status !== "fulfilled" || results[2].status !== "fulfilled") throw new ClaudeMacosPreflightError("native_unproved", cleanup());
      const accepted = settlementSchema.safeParse(value);
      if (!accepted.success) throw new ClaudeMacosPreflightError("native_unproved", cleanup());
      const observed = accepted.data; const stdout = results[0].value; const stderr = results[1].value;
      if (observed.operation !== scope.operation || observed.exitCode !== results[2].value || observed.stdoutBytes !== stdout.byteLength || observed.stderrBytes !== stderr.byteLength) {
        throw new ClaudeMacosPreflightError("native_unproved", cleanup());
      }
      const identity = observed.detachment.identity;
      parseDarwinTerminalDevice(`${String(identity.pid)} ${identity.procStart} ??\n`);
      failure = "capability_refused";
      // Preserve a leading BOM so help digests cover the original valid UTF-8 bytes
      // and the existing exact version parser sees, and can refuse, that scalar.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout);
      const loginHelp = scope.operation === "login_help" && mode === "diagnostic" ? inspectClaudeAuthLoginHelp({ exitCode: observed.exitCode, stdout: text, stderr: "" }) : null;
      const stdoutSha256 = scope.operation === "logout_help" ? parseClaudeAuthLogoutHelp({ exitCode: observed.exitCode, stdout: text, stderr: "" })
        : loginHelp !== null ? loginHelp.helpSha256
          : scope.operation === "login_help" ? parseClaudeAuthLoginHelp({ exitCode: observed.exitCode, stdout: text, stderr: "" })
          : createHash("sha256").update(stdout).digest("hex");
      probes.push(Object.freeze({ runId: scope.runId, attemptId, probeId: scope.probeId, profile: scope.profile, operation: scope.operation,
        stdoutSha256, stdoutBytes: stdout.byteLength, stderrBytes: 0, deadlineMs, elapsedMs: observed.elapsedMs,
        loginHelp: loginHelp === null ? null : Object.freeze({ optionRows: loginHelp.optionRows, projectionComplete: loginHelp.projectionComplete, diagnostics: loginHelp.diagnostics }),
        detachment: Object.freeze({ ...observed.detachment, identity: Object.freeze({ ...identity }) }) }));
      return scope.operation === "version" ? text : null;
    } finally { active = null; for (const bytes of raw) bytes.fill(0); }
  }

  try {
    checkAbort();
    for (const profile of ["A", "B"] as const) {
      const configDir = (profile === "A" ? binding.profileA : binding.profileB).path;
      const temporaryDirectory = (profile === "A" ? binding.temporaryA : binding.temporaryB).path;
      for (const operation of operations) {
        const probeId = randomUUID();
        if (issued.has(probeId)) throw new ClaudeMacosPreflightError("scope_refused", cleanup());
        issued.add(probeId);
        const scope: ClaudeMacosPreflightScope = Object.freeze({ runId: binding.runId, attemptId, probeId, profile, operation,
          sourceSha: binding.sourceSha, sourceTree: binding.sourceTree, executablePath: binding.executable.path, executableSha256: binding.executableDigest,
          executableDevice: binding.executable.device, executableInode: binding.executable.inode,
          configDir, temporaryDirectory, environment, signal: input.signal, deadlineMs });
        if (operation !== "version") { await probe(scope); continue; }
        let called = false;
        const wasCalled = (): boolean => called;
        failure = "runtime_refused";
        const runtime = await ports.resolveRuntime({ executablePath: binding.executable.path, configDir, configHome: "isolated", environment, signal: input.signal, versionProbeDeadlineMs: deadlineMs,
          async probeVersion(actual) {
            if (called || actual.executablePath !== scope.executablePath || actual.configDir !== scope.configDir || actual.configHome !== "isolated"
              || actual.signal !== input.signal || actual.deadlineMs !== deadlineMs || actual.processFactory !== undefined || !sameEnvironment(actual.environment, environment)) {
              throw new ClaudeMacosPreflightError("scope_refused", cleanup());
            }
            called = true;
            const text = await probe(scope);
            if (text === null) throw new ClaudeMacosPreflightError("runtime_refused", cleanup());
            failure = "runtime_refused";
            return text;
          } });
        checkAbort();
        const resolved = resolvedRuntimeSchema.safeParse(runtime);
        if (!wasCalled() || !resolved.success || resolved.data.executablePath !== binding.executable.path) throw new ClaudeMacosPreflightError("runtime_refused", cleanup());
        runtimes.set(profile, runtime);
      }
    }
    if (mode === "strict") {
      const A = runtimes.get("A"); const B = runtimes.get("B");
      if (A === undefined || B === undefined) throw new ClaudeMacosPreflightError("runtime_refused", cleanup());
      return Object.freeze({ kind: "capabilities_only", runId: binding.runId, attemptId,
        exactVersionBoth: true, logoutHelpBoth: true, loginHelpBoth: true, probes: Object.freeze(probes), runtimes: Object.freeze({ A, B }) });
    }
    return Object.freeze({ admitted: false, reason: "login_help_unverified", runId: binding.runId, attemptId,
      exactVersionBoth: true, logoutHelpBoth: true, loginHelpBoth: false, probes: Object.freeze(probes) });
  } catch (error: unknown) {
    if (error instanceof ClaudeMacosPreflightError) throw error;
    throw new ClaudeMacosPreflightError(input.signal.aborted ? "aborted" : failure, cleanup());
  } finally { input.signal.removeEventListener("abort", abort); }
}

/** No CLI, locator or caller-supplied process/parser port. Result is private evidence, not a settled preflight event. */
export async function collectNativeClaudeMacosPreflight(input: NativeClaudeMacosPreflightInput): Promise<Diagnostic & Readonly<{ source: "native_process" }>> {
  const parsed = nativeInputSchema.safeParse(input);
  if (!parsed.success) throw new ClaudeMacosPreflightError("invalid_input", "not_started");
  let state: unknown;
  try {
    // Invoke the original private-field getter and ticket method, not shadowable instance overrides.
    state = Reflect.get(QualificationCustody.prototype, "state", parsed.data.custody);
  } catch { throw new ClaudeMacosPreflightError("scope_refused", "not_started"); }
  const prepare = QualificationCustody.prototype.prepareDispatchAuthority.bind(parsed.data.custody);
  const result = await collectPreflight(parsed.data, state, "native_process", {
    prepareDispatchAuthority: prepare, bindProcess: bindDarwinDetachedAuthProcess, resolveRuntime: resolvePinnedClaudeRuntime,
  }, "diagnostic");
  return Object.freeze({ ...result, source: "native_process" });
}

/** Explicit credential-free composition. Injected observations cannot acquire native provenance. */
export async function collectCredentialFreeClaudeMacosPreflight(input: CommonInput & Readonly<{ state: unknown }>, ports: FixturePorts): Promise<Diagnostic & Readonly<{ source: "credential_free_fixture" }>> {
  const parsed = fixtureInputSchema.safeParse(input);
  if (!parsed.success || typeof ports.prepareDispatchAuthority !== "function" || typeof ports.bindProcess !== "function" || typeof ports.resolveRuntime !== "function") {
    throw new ClaudeMacosPreflightError("invalid_input", "not_started");
  }
  return Object.freeze({ ...await collectPreflight(parsed.data, parsed.data.state, "credential_free_fixture", ports, "diagnostic"), source: "credential_free_fixture" });
}

/** Fresh strict grammar and genuine runtime objects only; no authentication or step settlement. */
export async function collectNativeClaudeMacosCapabilities(input: NativeClaudeMacosPreflightInput): Promise<ClaudeMacosCapabilities & Readonly<{ source: "native_process" }>> {
  const parsed = nativeInputSchema.safeParse(input);
  if (!parsed.success) throw new ClaudeMacosPreflightError("invalid_input", "not_started");
  let state: unknown;
  try { state = Reflect.get(QualificationCustody.prototype, "state", parsed.data.custody); }
  catch { throw new ClaudeMacosPreflightError("scope_refused", "not_started"); }
  const result = await collectPreflight(parsed.data, state, "native_process", {
    prepareDispatchAuthority: QualificationCustody.prototype.prepareDispatchAuthority.bind(parsed.data.custody),
    bindProcess: bindDarwinDetachedAuthProcess, resolveRuntime: resolvePinnedClaudeRuntime,
  }, "strict");
  return Object.freeze({ ...result, source: "native_process" });
}

/** Strict synthetic collection cannot return native provenance or authorize login. */
export async function collectCredentialFreeClaudeMacosCapabilities(input: CommonInput & Readonly<{ state: unknown }>, ports: FixturePorts): Promise<ClaudeMacosCapabilities & Readonly<{ source: "credential_free_fixture" }>> {
  const parsed = fixtureInputSchema.safeParse(input);
  if (!parsed.success || typeof ports.prepareDispatchAuthority !== "function" || typeof ports.bindProcess !== "function" || typeof ports.resolveRuntime !== "function") {
    throw new ClaudeMacosPreflightError("invalid_input", "not_started");
  }
  return Object.freeze({ ...await collectPreflight(parsed.data, parsed.data.state, "credential_free_fixture", ports, "strict"), source: "credential_free_fixture" });
}
