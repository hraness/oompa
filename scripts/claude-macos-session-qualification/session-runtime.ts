import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";

import { z } from "zod";

import { ClaudeHostToolBindingAuthority } from "../../src/claude/host-tool-bridge";
import { spawnBunClaudeProcess, type ClaudeProcess, type ClaudeProcessIdentity } from "../../src/claude/process";
import type { PinnedClaudeRuntime } from "../../src/claude/runtime";
import { claudeProviderAccountIdSchema } from "../../src/domain/provider-accounts";
import { profileIdSchema } from "../../src/domain/values";
import { presetRequirements } from "../../src/domain/presets";
import { PinnedClaudeRuntimeManager, type ClaudeProcessFactory } from "../../src/daemon/claude-runtime-adapter";
import { ClaudeHostToolCallbackServer, claudeHostToolCallbackSocketPath } from "../../src/daemon/claude-host-tool-transport";
import type { ProfileAuthority } from "../../src/daemon/ports";
import { resolveStatePaths } from "../../src/storage/paths";
import { bindDarwinQualificationEnvironment, type ClaudeQualificationBindingInput } from "../claude-macos-auth-process/binding";
import type { JournalAttempt, SessionSummary } from "./custody";
import type { QualificationSessionCustody } from "./custody-port";
import type { SessionAdmission } from "./authentication";
import { DarwinSessionQualificationError, SessionTurnObservation, type SessionTurnScenario } from "./turn";

function refuse(): never { throw new DarwinSessionQualificationError("recovery_required"); }
type TrackedProcess = { process: ClaudeProcess; identity: ClaudeProcessIdentity | null; childJoined: boolean; stdoutEof: boolean; stderrEof: boolean; bytes: number };
type Ticket = Awaited<ReturnType<QualificationSessionCustody["prepareDispatch"]>>;
const sameIdentity = (a: ClaudeProcessIdentity, b: ClaudeProcessIdentity): boolean => a.pid === b.pid && a.pidDomain === b.pidDomain && a.procStart === b.procStart;

/** Internal live adapter composition. No injected transport or authority reaches the native runner. */
export class DarwinQualificationSession {
  readonly #custody: QualificationSessionCustody;
  readonly #admission: SessionAdmission;
  readonly #binding: ClaudeQualificationBindingInput;
  readonly #runtime: PinnedClaudeRuntime;
  readonly #signal: AbortSignal;
  readonly #authority: ProfileAuthority;
  readonly #bindings = new ClaudeHostToolBindingAuthority();
  #server: ClaudeHostToolCallbackServer | null = null;
  #manager: PinnedClaudeRuntimeManager | null = null;
  #attempt: JournalAttempt | null = null;
  #launchTicket: Ticket | null = null;
  #child: TrackedProcess | null = null;
  #closedChild: TrackedProcess | null = null;
  #turn: SessionTurnObservation | null = null;
  #connectionId: string | null = null;
  #fatal = false;
  #closed = false;
  #callbacksJoined = false;
  #callbackSetupUncertain = false;
  #identityInspectionUncertain = false;
  #managerCloseUncertain = false;
  #acknowledgedFrames = 0;
  readonly #pendingSettlements = new Map<string, string>();

  constructor(custody: QualificationSessionCustody, admission: SessionAdmission, binding: ClaudeQualificationBindingInput,
    runtime: PinnedClaudeRuntime, signal: AbortSignal) {
    this.#custody = custody; this.#admission = admission; this.#binding = binding; this.#runtime = runtime; this.#signal = signal;
    this.#authority = Object.freeze({ provider: "claude", id: profileIdSchema.parse(custody.scope.profileId), providerAccountId: claudeProviderAccountIdSchema.parse(custody.scope.providerAccountId),
      generation: 1, bindingGeneration: 1, codexHome: join(custody.scope.runRoot, "unused-codex"), desktopUserData: join(custody.scope.runRoot, "unused-desktop") });
  }
  get cleanup(): "joined" | "uncertain" {
    return this.#closed && this.#callbacksJoined && !this.#callbackSetupUncertain && !this.#identityInspectionUncertain && !this.#managerCloseUncertain
      && (this.#child === null || this.#joined(this.#child)) ? "joined" : "uncertain";
  }
  #assert(): void {
    if (this.#fatal || this.#closed || this.#signal.aborted) return refuse();
    this.#admission.assertCurrent();
  }
  #currentAttempt(): JournalAttempt { return this.#attempt ?? refuse(); }
  #currentManager(): PinnedClaudeRuntimeManager { return this.#manager ?? refuse(); }
  #joined(child: TrackedProcess): boolean { return child.childJoined && child.stdoutEof && child.stderrEof; }
  async #tag(value: string): Promise<string> {
    return await this.#custody.withProofKey(async (key) => createHmac("sha256", key).update("oompa:darwin-session:v1\0").update(value).digest("hex"));
  }

  #spawn: ClaudeProcessFactory = (launch) => {
    const attempt = this.#currentAttempt(); const ticket = this.#launchTicket;
    if (ticket === null || this.#child !== null || launch.configHome !== "isolated" || launch.configDir !== this.#binding.configDir
      || launch.projectRoot !== this.#custody.scope.projectRoot || launch.runtime.executablePath !== this.#runtime.executablePath
      || !z.literal(this.#runtime.version).safeParse(launch.runtime.version).success || launch.argv.at(-1) !== this.#custody.scope.providerThreadId) return refuse();
    const bound = bindDarwinQualificationEnvironment(this.#binding);
    this.#assert(); ticket.assertCurrent(); this.#launchTicket = null;
    // The production inspector proves its ps join only on success. Any
    // rejected identity remains uncertain even if the provider later exits.
    this.#identityInspectionUncertain = true;
    const process = spawnBunClaudeProcess({ argv: launch.argv, configDir: launch.configDir, configHome: "isolated",
      projectRoot: launch.projectRoot, environment: bound.environment });
    const tracked: TrackedProcess = { process, identity: null, childJoined: false, stdoutEof: false, stderrEof: false, bytes: 0 };
    this.#child = tracked;
    const identity = process.identity.then(async (value) => {
      if (value.pidDomain !== "darwin") return refuse(); tracked.identity = value; this.#identityInspectionUncertain = false;
      await this.#custody.acknowledgeDispatch(attempt, ticket.dispatchId);
      return value;
    });
    const exited = process.exited.then((code) => { tracked.childJoined = true; return code; });
    const stream = (source: AsyncIterable<Uint8Array>, channel: "stdoutEof" | "stderrEof"): AsyncIterable<Uint8Array> => ({
      async *[Symbol.asyncIterator]() {
        for await (const bytes of source) {
          if (!(bytes instanceof Uint8Array) || bytes.byteLength > 2 * 1024 * 1024 - tracked.bytes) {
            process.forceTerminate(); throw new DarwinSessionQualificationError("limit_exceeded");
          }
          tracked.bytes += bytes.byteLength; yield bytes;
        }
        tracked[channel] = true;
      },
    });
    return { identity, exited, stdout: stream(process.stdout, "stdoutEof"), stderr: stream(process.stderr, "stderrEof"),
      write: async (bytes) => {
        if (bytes.byteLength > 65_536) return refuse();
        const snapshot = Uint8Array.from(bytes);
        try {
          const current = this.#currentAttempt();
          const dispatch = await this.#custody.prepareDispatch(current, { kind: "frame", frame: snapshot });
          bound.assertCurrent(); this.#assert(); dispatch.assertCurrent();
          await process.write(snapshot);
          await this.#custody.acknowledgeDispatch(current, dispatch.dispatchId); this.#acknowledgedFrames += 1;
        } finally { snapshot.fill(0); }
      }, terminate: () => process.terminate(), forceTerminate: () => process.forceTerminate() };
  };

  async #newManager(): Promise<PinnedClaudeRuntimeManager> {
    const paths = resolveStatePaths({ rootDirectory: this.#custody.scope.runRoot });
    if (paths.runtime !== this.#custody.scope.runtimeRoot) return refuse();
    if (this.#server === null) {
      // Current host capabilities stay real. Any unrequested Oompa host call
      // refuses the scenario; no fictional host-tool success is supplied.
      this.#callbackSetupUncertain = true;
      this.#server = await ClaudeHostToolCallbackServer.start({ paths, authority: this.#bindings,
        handler: { call: async () => { this.#fatal = true; return refuse(); }, responseWritten: async () => { this.#fatal = true; return refuse(); } },
        onFatalError: () => { this.#fatal = true; } });
      this.#callbackSetupUncertain = false;
    }
    return new PinnedClaudeRuntimeManager({ configHome: "isolated",
      configDirFor: async (authority) => { if (authority !== this.#authority) return refuse(); await this.#custody.assertCurrent(); this.#assert(); return this.#binding.configDir; },
      isCurrent: (authority) => !this.#closed && !this.#fatal && authority.id === this.#authority.id && authority.generation === 1
        && authority.provider === "claude" && authority.providerAccountId === this.#authority.providerAccountId && authority.bindingGeneration === 1,
      resolveRuntime: async (input) => {
        if (input.configDir !== this.#binding.configDir || input.configHome !== "isolated") return refuse();
        await this.#custody.assertCurrent(); bindDarwinQualificationEnvironment(this.#binding).assertCurrent(); this.#assert(); return this.#runtime;
      },
      readAuthStatus: async () => refuse(), // Authentication is independently observed by the native ceremony.
      processFactory: this.#spawn,
      hostTools: { bindingAuthority: this.#bindings, callbackSocketPath: claudeHostToolCallbackSocketPath(paths), privateRoot: this.#custody.scope.runtimeRoot },
      observer: { fact: (authority, fact) => {
        if (authority !== this.#authority || fact.providerThreadId !== this.#custody.scope.providerThreadId) return refuse();
        // The production manager defers its local resolution notice until
        // after the write returns. Join only the exact request/connection;
        // it may arrive after this scenario's terminal fact.
        if (fact.type === "interactionCanceled" && this.#pendingSettlements.get(fact.requestId) === fact.connectionId) {
          this.#pendingSettlements.delete(fact.requestId); return;
        }
        if (this.#turn !== null) this.#turn.observe(fact);
        else if (fact.type !== "sessionBootstrapped" && fact.type !== "protocolNotice" && fact.type !== "providerDisconnected") {
          this.#fatal = true; return refuse();
        }
      } },
    });
  }

  async start(attempt: JournalAttempt, resume: boolean): Promise<SessionSummary> {
    this.#attempt = attempt; this.#assert(); await this.#custody.assertCurrent();
    if (this.#manager !== null || this.#child !== null || (resume && (this.#closedChild === null || !this.#joined(this.#closedChild)))) return refuse();
    const manager = await this.#newManager(); this.#manager = manager;
    this.#launchTicket = await this.#custody.prepareDispatch(attempt, { kind: "process" });
    const common = { authority: this.#authority, projectRoot: this.#custody.scope.projectRoot, preset: "fable-max" as const,
      requirement: presetRequirements["fable-max"], fast: false, signal: this.#signal };
    const admitProcessIdentity = async (identity: ClaudeProcessIdentity): Promise<void> => {
      if (this.#child?.identity === null || this.#child?.identity === undefined || !sameIdentity(this.#child.identity, identity)) return refuse();
      await this.#custody.recordChild(attempt, identity);
    };
    const projection = resume
      ? await manager.claimSession({ ...common, providerThreadId: this.#custody.scope.providerThreadId, hostTools: "required",
          title: "Oompa Darwin qualification", sourceLiveness: "not_live", admitProcessIdentity })
      : await manager.startSession({ authority: this.#authority, review: await manager.reviewSessionStart(common), signal: this.#signal,
          providerThreadId: this.#custody.scope.providerThreadId, admitProcessIdentity });
    if (projection.providerThreadId !== this.#custody.scope.providerThreadId) return refuse();
    await manager.activateSessionHostTools({ authority: this.#authority, providerThreadId: projection.providerThreadId, signal: this.#signal });
    const observed = await manager.observeSession({ authority: this.#authority, providerThreadId: projection.providerThreadId, signal: this.#signal });
    const identity = await manager.readSessionProcessIdentity({ authority: this.#authority, providerThreadId: projection.providerThreadId, signal: this.#signal });
    if (observed.resumed !== resume || observed.projection.providerThreadId !== projection.providerThreadId || identity.pidDomain !== "darwin"
      || (resume && this.#connectionId === observed.connectionId)) return refuse();
    this.#connectionId = observed.connectionId;
    return { kind: "session", threadTag: await this.#tag(projection.providerThreadId), connectionTag: await this.#tag(observed.connectionId), processIdentity: { pidDomain: "darwin", pid: identity.pid, procStart: identity.procStart } };
  }

  async turn(attempt: JournalAttempt, scenario: SessionTurnScenario): Promise<SessionSummary> {
    this.#attempt = attempt; this.#assert();
    if (this.#connectionId === null || this.#turn !== null) return refuse();
    const observation = new SessionTurnObservation({ scenario, nonce: randomUUID(), providerThreadId: this.#custody.scope.providerThreadId, connectionId: this.#connectionId });
    this.#turn = observation;
    const controller = new AbortController(); const abort = (): void => controller.abort();
    this.#signal.addEventListener("abort", abort, { once: true }); if (this.#signal.aborted) abort();
    const deadlineAt = Date.now() + 90_000; const timer = setTimeout(abort, 90_000);
    const manager = this.#currentManager();
    const common = { authority: this.#authority, providerThreadId: this.#custody.scope.providerThreadId, signal: controller.signal };
    try {
      const review = await manager.reviewTurnStart({ ...common, projectRoot: this.#custody.scope.projectRoot,
        preset: "fable-max", requirement: presetRequirements["fable-max"], fast: false });
      const started = await manager.startTurn({ ...common, review, message: observation.prompt, clientMessageId: randomUUID() });
      observation.bindReturnedTurn(started.turnId);
      if (scenario === "approve" || scenario === "deny") {
        await observation.wait("request", controller.signal, deadlineAt);
        const requestId = observation.takeRequest();
        const provider = manager.interactionAuthority(this.#authority, common.providerThreadId, requestId);
        const resolution = { kind: "approval_decision" as const, decision: scenario === "approve" ? "once" as const : "decline" as const };
        await manager.validateInteractionResolution({ ...common, provider, kind: "command_approval", resolution });
        const result = await manager.resolveInteraction({ ...common, provider, kind: "command_approval", resolution, deadlineAt });
        if (!z.strictObject({ responseWritten: z.literal(true) }).safeParse(result).success || this.#pendingSettlements.size >= 2) return refuse();
        this.#pendingSettlements.set(requestId, this.#connectionId); observation.decisionWritten();
      } else if (scenario === "interrupt") {
        await observation.wait("delta", controller.signal, deadlineAt);
        if (observation.terminal) return refuse();
        const framesBeforeInterrupt = this.#acknowledgedFrames;
        await manager.interrupt({ ...common, activeTurnId: started.turnId });
        if (this.#acknowledgedFrames !== framesBeforeInterrupt + 1) return refuse();
        observation.interruptWritten();
      }
      await observation.wait("terminal", controller.signal, deadlineAt);
      return { kind: "turn", ...observation.finish() };
    } finally { clearTimeout(timer); this.#signal.removeEventListener("abort", abort); observation.clear(); this.#turn = null; }
  }

  async closeSession(attempt: JournalAttempt, final: boolean): Promise<SessionSummary> {
    this.#attempt = attempt;
    const manager = this.#currentManager(); const child = this.#child;
    if (child === null || child.identity === null) return refuse();
    const identity = await manager.readSessionProcessIdentity({ authority: this.#authority,
      providerThreadId: this.#custody.scope.providerThreadId, signal: this.#signal });
    if (identity.pidDomain !== "darwin" || !sameIdentity(identity, child.identity)) return refuse();
    await manager.endSession({ authority: this.#authority, providerThreadId: this.#custody.scope.providerThreadId, signal: this.#signal });
    try { await manager.close(); } catch (error: unknown) { this.#managerCloseUncertain = true; throw error; }
    if (!this.#joined(child)) return refuse();
    this.#closedChild = child; this.#child = null; this.#manager = null;
    if (final) await this.close();
    return { kind: "close", processIdentity: { pidDomain: "darwin", pid: identity.pid, procStart: identity.procStart }, childJoined: true, stdoutEof: true, stderrEof: true };
  }

  /** Only retained owned handles are closed here; this never opens another provider operation. */
  async close(): Promise<void> {
    this.#closed = true;
    const results = await Promise.allSettled([this.#manager?.close() ?? Promise.resolve()]);
    if (results.some((result) => result.status === "rejected")) this.#managerCloseUncertain = true;
    // Attempt every independent retained-resource join even after a failed
    // child join; a missing handle or inspector proof cannot become success.
    const resources = await Promise.allSettled([this.#bindings.close(), this.#server?.close(5000) ?? Promise.resolve()]);
    this.#callbacksJoined = resources.every((result) => result.status === "fulfilled") && !this.#callbackSetupUncertain;
    if (results.some((result) => result.status === "rejected") || this.cleanup !== "joined") return refuse();
  }
}
