import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { isatty } from "node:tty";
import { z } from "zod";

import { initialize } from "../../src/cli";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { sessionEventPageSchema } from "../../src/domain/session-events";
import { sessionIdSchema } from "../../src/domain/values";
import { resolveStatePaths } from "../../src/storage/paths";
import { StateStore } from "../../src/storage/state-store";
import { captureNativeClaudeMacosAdmission } from "../claude-macos-auth-qualification/admission";
import { createQualificationTerminalSignals } from "../claude-macos-auth-qualification/owner-terminal";
import { SessionAuthentication } from "../claude-macos-session-qualification/authentication";
import { DAEMON_SEED_OPERATIONS, DarwinSessionCustody, DarwinSessionCustodyError, type SessionSummary } from "../claude-macos-session-qualification/custody";
import { DarwinQualificationSession } from "../claude-macos-session-qualification/session-runtime";
import {
  daemonQualificationDescriptorSchema, daemonQualificationIdempotencyKey, daemonQualificationPaths,
  daemonQualificationPrompt, type DaemonQualificationDescriptor, type DaemonQualificationProcessSummary,
  type DaemonQualificationStage,
} from "./contract";
import { DaemonQualificationCustody, tagDaemonQualificationValue } from "./custody";
import { QualificationDaemonProcess } from "./daemon-process";
import type { DaemonRestartEvent, DaemonRestartReceipt, DaemonRestartScope } from "./state";

const path = z.string().min(2).max(4096).refine((value) => isAbsolute(value) && resolve(value) === value && !/[\r\n\0]/u.test(value));
const inputSchema = z.strictObject({ repositoryRoot: path, sourceCommit: z.string().regex(/^[0-9a-f]{40}$/u), executablePath: path,
  environment: z.strictObject({ HOME: path, PATH: z.literal("/usr/bin:/bin:/usr/sbin:/sbin"), LANG: z.literal("C"),
    LC_ALL: z.literal("C"), TMPDIR: z.literal("/private/tmp") }), signal: z.instanceof(AbortSignal) });
function refused(): never { throw new Error("DARWIN_DAEMON_QUALIFICATION_REFUSED"); }
let nativeActive = false;
export type DarwinDaemonQualificationOutcome = Readonly<{
  source: "native_process"; status: "complete_retained" | "recovery_required";
  personalContinuationRestartQualified: boolean; ambiguousInputNoReplayQualified: boolean;
  activationAuthorized: false; managedMacAdmission: false; privateRootsRemoved: false;
  processCleanup: "joined" | "uncertain"; ownerRelease: "released" | "uncertain";
  runRoot: string | null; receipt: DaemonRestartReceipt | null;
}>;

async function normalTurn(child: QualificationDaemonProcess, custody: DaemonQualificationCustody, stage: "A" | "B", sessionId: string, nonce: string, signal: AbortSignal) {
  const before = await child.command({ kind: "session.events", session: sessionId, limit: 100, waitMs: 0 }, signal);
  if (!before.ok) refused();
  const baseline = sessionEventPageSchema.parse(before.data);
  if (baseline.sessionId !== sessionId) refused();
  const command = await custody.commandIntent(stage === "A" ? "normal_A" : "normal_B", child.identity,
    { kind: "session.send", session: sessionId, message: daemonQualificationPrompt(nonce), idempotencyKey: nonce });
  const sent = await child.command(command, signal);
  if (!sent.ok) refused();
  const turn = z.object({ idempotencyKey: z.literal(nonce), session: z.object({ id: z.literal(sessionId) }),
    turnId: z.string().min(1).max(512) }).parse(sent.data);
  let cursor = baseline.observedThroughCursor;
  const deadline = Date.now() + 90_000;
  let text = ""; let sequence: number | null = null; let epoch: string | null = null;
  for (let pageCount = 0; pageCount < 120 && Date.now() < deadline; pageCount += 1) {
    signal.throwIfAborted();
    const response = await child.command({ kind: "session.events", session: sessionId, cursor, limit: 100, waitMs: 1000 }, signal, 5000);
    if (!response.ok) refused();
    const page = sessionEventPageSchema.parse(response.data);
    if (page.sessionId !== sessionId || page.gap !== null) refused();
    for (const event of page.events) {
      if ((epoch !== null && event.streamEpoch !== epoch) || (sequence !== null && event.sequence !== sequence + 1)) refused();
      epoch = event.streamEpoch; sequence = event.sequence;
      const body = event.body;
      if (body.type === "assistant_delta" && body.turnId === turn.turnId) {
        text += body.text; if (Buffer.byteLength(text) > 4096) refused();
      }
      if (body.type === "turn_completed" && body.turnId === turn.turnId) {
        if (body.status !== "completed" || text.trim() !== `OOMPA_DAEMON_${nonce}`) refused();
        return turn.turnId;
      }
      if (body.type === "gap" || body.type === "protocol_incompatible" || body.type === "error") refused();
    }
    cursor = page.nextCursor;
  }
  return refused();
}

function readExactRetainedMutation(descriptor: DaemonQualificationDescriptor, sessionId: string) {
  const store = new StateStore(resolveStatePaths({ rootDirectory: daemonQualificationPaths(descriptor.runRoot).state }), { readonly: true });
  try {
    const session = store.requireSession(sessionId);
    const mutation = store.readMutation(daemonQualificationIdempotencyKey(descriptor));
    if (session.provider !== "claude" || session.providerThreadId !== descriptor.providerThreadId
      || mutation === null || mutation.kind !== "session.send" || mutation.authorityId !== session.id
      || mutation.state !== "ambiguous") refused();
    return JSON.stringify({ sessionId: session.id, providerThreadId: session.providerThreadId, mutation });
  } finally { store.close(); }
}
function requireAmbiguousResponse(response: Awaited<ReturnType<QualificationDaemonProcess["command"]>>, key: string): void {
  if (response.ok || response.error.code !== "RECOVERY_REQUIRED") refused();
  z.object({ idempotencyKey: z.literal(key) }).parse(response.error.details);
}

/** The only native entry accepts source/executable coordinates, the owner
 * environment and cancellation. It accepts no effect, process or root override. */
export async function runNativeDarwinDaemonQualification(input: unknown): Promise<DarwinDaemonQualificationOutcome> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success || nativeActive || parsed.data.repositoryRoot !== resolve(import.meta.dir, "../..")
    || ![0, 1, 2].every((descriptor) => isatty(descriptor)) || realpathSync(tmpdir()) !== "/private/tmp") refused();
  nativeActive = true;
  const request = parsed.data;
  const signals = createQualificationTerminalSignals(request.signal, {
    add(signal, listener) { process.on(signal, listener); }, remove(signal, listener) { process.off(signal, listener); },
  });
  let seed: DarwinSessionCustody | null = null;
  let authentication: SessionAuthentication | null = null;
  let session: DarwinQualificationSession | null = null;
  const children: QualificationDaemonProcess[] = [];
  let receipt: DaemonRestartReceipt | null = null;
  let recoveryRoot: string | null = null;
  let complete = false; let ownerRelease: "released" | "uncertain" = "uncertain";
  let signalJoin: "joined" | "uncertain" = "uncertain";
  const stopChildren = () => { for (const child of children) child.closeAdmission(); };
  signals.signal.addEventListener("abort", stopChildren, { once: true });
  try {
    signals.signal.throwIfAborted();
    const admission = captureNativeClaudeMacosAdmission({ repositoryRoot: request.repositoryRoot,
      sourceCommit: request.sourceCommit, executablePath: request.executablePath });
    seed = await DarwinSessionCustody.createDaemonSeedNative(admission.source);
    authentication = new SessionAuthentication(seed, admission, signals, Object.freeze({ ...request.environment }));
    let runtime: PinnedClaudeRuntime | null = null;
    for (const operation of DAEMON_SEED_OPERATIONS) {
      signals.signal.throwIfAborted(); await seed.assertCurrent(); admission.assertCurrent();
      const attempt = await seed.begin(operation); let summary: SessionSummary;
      if (operation === "version" || operation === "login_help" || operation === "logout_help") {
        const result = await authentication.capability(attempt, operation);
        if (operation === "version") runtime = result.runtime;
        summary = { kind: "capability", digest: result.digest };
      } else if (operation === "initial_status" || operation === "signed_in") {
        const result = await authentication.status(attempt);
        if (result.signedIn !== (operation === "signed_in") || (result.identityTag !== null) !== result.signedIn) refused();
        summary = { kind: "status", ...result };
      } else if (operation === "login") {
        if (runtime === null) refused(); await authentication.login(attempt, runtime); summary = { kind: "login", childJoined: true };
      } else if (operation === "start") {
        if (runtime === null) refused();
        session = new DarwinQualificationSession(seed, admission, authentication.binding, runtime, signals.signal);
        summary = await session.start(attempt, false);
      } else if (operation === "stream_turn") {
        if (session === null) refused(); summary = await session.turn(attempt, "stream");
      } else {
        if (session === null) refused(); summary = await session.closeSession(attempt, true);
      }
      await seed.settle(attempt, summary);
    }
    if (authentication.cleanup !== "joined" || session?.cleanup !== "joined") refused();
    seed.assertDaemonOwnerCurrent(); admission.assertCurrent(); signals.signal.throwIfAborted();
    const layout = daemonQualificationPaths(seed.scope.runRoot);
    const paths = resolveStatePaths({ rootDirectory: layout.state });
    if (await initialize(true, false, { writeStdout: () => {}, writeStderr: () => {} },
      { paths, documentsDirectory: layout.project }) !== 0) refused();
    const store = new StateStore(paths);
    let accountId: string;
    try {
      const account = store.createProfile("Darwin restart qualification"); accountId = account.id;
      if (!store.listProjects().some((project) => project.rootPath === layout.project)) await store.createProject("Darwin restart project", layout.project);
    } finally { store.close(); }
    const directories = Object.fromEntries((["root", "profile", "temporary", "project", "state"] as const).map((name) => {
      const stat = lstatSync(layout[name]);
      if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o700 || realpathSync(layout[name]) !== layout[name]) refused();
      return [name, { device: stat.dev, inode: stat.ino, owner: stat.uid }];
    }));
    const base = daemonQualificationDescriptorSchema.parse({ version: 1, purpose: "authenticated_personal_daemon_restart",
      runId: seed.scope.runId, ownerEpoch: seed.scope.ownerEpoch, stage: "A", repositoryRoot: request.repositoryRoot,
      sourceCommit: admission.source.sourceSha, sourceTree: admission.source.sourceTree,
      executablePath: request.executablePath, executableSha256: admission.artifactProvenance.executableSha256, ownerHome: homedir(),
      runRoot: seed.scope.runRoot, directories, providerThreadId: seed.scope.providerThreadId,
      normalNonceA: randomUUID(), normalNonceB: randomUUID(), acknowledgmentLossNonce: randomUUID() });
    const scope: DaemonRestartScope = { version: 1, sourceSha: admission.source.sourceSha, runId: seed.scope.runId,
      threadTag: await tagDaemonQualificationValue(seed, "thread", base.providerThreadId),
      commandTag: await tagDaemonQualificationValue(seed, "command", JSON.stringify([base.providerThreadId,
        daemonQualificationPrompt(base.acknowledgmentLossNonce), daemonQualificationIdempotencyKey(base)])) };
    const custody = await DaemonQualificationCustody.create(seed, admission, scope);
    const common = (stage: DaemonQualificationStage, child: QualificationDaemonProcess, userWriteAttempts: number) => ({
      ...scope, generationStage: stage, daemonGeneration: child.identity.generation, daemonNonce: child.identity.nonce, userWriteAttempts });
    const observeJoined = async (stage: DaemonQualificationStage, child: QualificationDaemonProcess, collected: DaemonQualificationProcessSummary) => {
      if (!child.joined || collected.collection !== "joined" || !collected.providerRootCollected
        || !collected.providerStdoutEof || !collected.providerStderrEof || !collected.runtimeObserversJoined
        || !collected.identityInspectorsJoined || collected.observationViolation) refused();
      const event: DaemonRestartEvent = { ...common(stage, child, collected.userWriteAttempts), type: "joined",
        daemonRootCollected: true, daemonStdoutEof: true, daemonStderrEof: true,
        providerRootsCollected: true, providerStdoutEof: true, providerStderrEof: true,
        runtimeObserversJoined: true, identityInspectorsJoined: true, daemonAuthorityReleased: true };
      await custody.observe(event);
    };
    let sessionId: string | null = null; let retainedIntent: string | null = null;
    for (const stage of ["A", "B", "C"] as const) {
      const descriptor = { ...base, stage };
      const child = await QualificationDaemonProcess.start(descriptor, custody, signals.signal, (owner) => children.push(owner));
      const ready = await child.observeWrites();
      if (ready.userWriteAttempts !== 0 || ready.acceptedUserWrites !== 0 || ready.acknowledgmentWithheld) refused();
      await custody.observe({ ...common(stage, child, ready.userWriteAttempts), type: "ready" });
      if (stage === "A") {
        const adoption = await custody.commandIntent("adoption_A", child.identity,
          { kind: "session.adoption.set", provider: "claude", enabled: true, account: accountId });
        const adopted = await child.command(adoption, signals.signal);
        if (!adopted.ok) refused();
        const list = await custody.commandIntent("list_A", child.identity,
          { kind: "session.list", account: accountId, archived: false, limit: 2 });
        const listed = await child.command(list, signals.signal);
        if (!listed.ok) refused();
        const page = z.object({ sessions: z.array(z.object({ id: sessionIdSchema, provider: z.literal("claude") })).length(1), nextCursor: z.null() }).parse(listed.data);
        sessionId = page.sessions[0]?.id ?? refused();
      }
      if (sessionId === null) refused();
      if (stage !== "C") {
        const nonce = stage === "A" ? base.normalNonceA : base.normalNonceB;
        const turnId = await normalTurn(child, custody, stage, sessionId, nonce, signals.signal);
        const writes = await child.observeWrites();
        if (writes.userWriteAttempts !== 1 || writes.acceptedUserWrites !== 1 || writes.acknowledgmentWithheld) refused();
        await custody.observe({ ...common(stage, child, writes.userWriteAttempts), type: "normalTurn",
          turnTag: await custody.tag("turn", turnId), promptNonce: nonce, resumed: stage === "B", acknowledged: true, completed: true, nonceMatched: true });
      }
      if (stage === "A") {
        const collected = await child.stop(); await observeJoined(stage, child, collected);
        const store = new StateStore(paths, { readonly: true });
        try { if (store.requireSession(sessionId).providerThreadId !== base.providerThreadId) refused(); } finally { store.close(); }
      } else {
        const key = daemonQualificationIdempotencyKey(base);
        const command = await custody.commandIntent(stage === "B" ? "lost_B" : "retry_C", child.identity,
          { kind: "session.send", session: sessionId, message: daemonQualificationPrompt(base.acknowledgmentLossNonce), idempotencyKey: key });
        const response = await child.command(command, signals.signal);
        requireAmbiguousResponse(response, key);
        const observed = await child.observeWrites();
        if (stage === "B" ? observed.userWriteAttempts !== 2 || observed.acceptedUserWrites !== 2 || !observed.acknowledgmentWithheld
          : observed.userWriteAttempts !== 0 || observed.acceptedUserWrites !== 0 || observed.acknowledgmentWithheld) refused();
        const collected = await child.stop();
        const exact = readExactRetainedMutation(base, sessionId);
        if (stage === "B") retainedIntent = exact;
        else if (retainedIntent === null || exact !== retainedIntent) refused();
        const original = stage === "B" ? child.identity.generation : children[1]?.identity.generation ?? refused();
        const intent = { intentTag: await custody.tag("intent", exact), idempotencyTag: await custody.tag("idempotency", key),
          originalDaemonGeneration: original, retainedIntentState: "ambiguous" as const, dispatchCount: 1 as const };
        await custody.observe(stage === "B"
          ? { ...common(stage, child, observed.userWriteAttempts), ...intent, type: "acknowledgmentLost", localStdinAccepted: true,
              acknowledgmentWithheld: true, operation: "indeterminate", remoteAcknowledgment: "unestablished", remoteEffect: "unestablished" }
          : { ...common(stage, child, observed.userWriteAttempts), ...intent, type: "retryAmbiguous", result: "ambiguous", newUserWriteAttempts: 0 });
        await observeJoined(stage, child, collected);
      }
    }
    receipt = custody.finish(); complete = true;
  } catch (error: unknown) {
    // Custody creation may have retained a root before returning an owner.
    if (error instanceof DarwinSessionCustodyError && error.recoveryRoot !== undefined) {
      recoveryRoot = error.recoveryRoot;
      if (error.ownerRelease === "released") ownerRelease = "released";
    }
    // Raw provider output, credentials and internal exception text stay private.
  } finally {
    stopChildren();
    for (const child of children) { if (!child.joined) { try { await child.collectAfterFailure(); } catch { /* Exact unjoined custody remains retained. */ } } }
    if (session !== null && session.cleanup !== "joined") { try { await session.close(); } catch { /* Missing original joins remain unknown. */ } }
    signals.signal.removeEventListener("abort", stopChildren);
    try { signalJoin = signals.close(); } catch { /* Signal custody remains unknown. */ }
    if (seed !== null) { try { await seed.releasePreserving(); ownerRelease = "released"; } catch { /* No root removal or reacquisition. */ } }
  }
  const joined = signalJoin === "joined" && authentication?.cleanup === "joined" && session?.cleanup === "joined"
    && children.length === 3 && children.every((child) => child.joined);
  complete = complete && joined && ownerRelease === "released";
  if (complete) nativeActive = false;
  return Object.freeze({ source: "native_process", status: complete ? "complete_retained" : "recovery_required",
    personalContinuationRestartQualified: complete, ambiguousInputNoReplayQualified: complete,
    activationAuthorized: false, managedMacAdmission: false, privateRootsRemoved: false,
    processCleanup: joined ? "joined" : "uncertain", ownerRelease, runRoot: seed?.scope.runRoot ?? recoveryRoot,
    receipt: complete ? receipt : null });
}
