import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- This is the daemon's narrow adapter to the pinned Devin provider boundary.
import {
  DEVIN_ACP_PROTOCOL_VERSION,
  DEVIN_MODEL,
  DEVIN_PIN,
  DevinAcpClient,
  DevinError,
  boundedDevinPrompt,
  devinAcpArgv,
  readDevinAuthStatus,
  resolvePinnedDevinRuntime,
  sanitizeDevinText,
  spawnBunDevinAcpProcess,
  type DevinAcpProcess,
  type DevinDirectories,
  type DevinFact,
  type DevinPermissionOutcome,
  type DevinStopReason,
  type PinnedDevinRuntime,
  type ResolvePinnedDevinRuntimeOptions,
} from "../devin/index.ts";
import type { PreparedAttachment } from "../domain/attachments.ts";
import type {
  InteractionKind,
  InteractionResolution,
  LiveInteractionApprovalAuthority,
  ProviderInteractionAuthority,
} from "../domain/interactions.ts";
import {
  assertPresetSupportedByProvider,
  currentPresetContract,
  presetRequirementForContract,
  type Preset,
  type PresetRequirement,
} from "../domain/presets.ts";
import { devinProviderAccountIdSchema } from "../domain/provider-accounts.ts";
import {
  effectiveDevinRuntimeProfileV2Schema,
  type EffectiveDevinRuntimeProfileV2,
} from "../domain/runtime-profile.ts";
import type { CodexFact, CodexTurnStatus } from "../codex/protocol.ts";
import {
  CodexSessionObservationError,
  type CodexProjectedMessage,
  type CodexSessionObservation,
  type CodexSessionProjection,
  type CodexTurnSummary,
  type DevinAccountReadinessProjection,
  type DevinRuntimePort,
  type DevinRuntimeStartReview,
  type ProfileAuthority,
} from "./ports.ts";

type EffectiveDevinRuntimeProfile = EffectiveDevinRuntimeProfileV2;
const effectiveDevinRuntimeProfileSchema = effectiveDevinRuntimeProfileV2Schema;

const PROJECTED_MESSAGE_LIMIT = 256;
const PROJECTED_TURN_LIMIT = 128;
const PROJECTED_MESSAGE_BYTES = 16 * 1024;
const PROJECTED_TITLE_BYTES = 120;
const PROJECTED_ACTION_LIMIT = 64;
const CLOSED_SESSION_PROOF_LIMIT = 1_024;
const DEFERRED_PERMISSION_LIMIT = 16;
const PREBIND_FACT_LIMIT = 128;
const PENDING_PERMISSION_LIMIT = 16;
const OPEN_ITEM_LIMIT = 256;
const ASSISTANT_ITEM_LIMIT = 128;
const DEFAULT_DIRECT_JOIN_GRACE_MS = 500;
const DEFAULT_DIRECT_FORCE_JOIN_MS = 1_000;
const PERMISSION_METHOD = "devin/session/request_permission";
const INTENTIONALLY_UNPROJECTED_UPDATES = new Set([
  "session/update:agent_thought_chunk",
  "session/update:user_message_chunk",
  "session/update:plan_update",
  "session/update:plan_removed",
  "session/update:available_commands_update",
  "session/update:current_mode_update",
  "session/update:config_option_update",
  "session/update:session_info_update",
  "session/update:compaction_update",
  "session/update:compaction_summary_chunk",
]);

const encoder = new TextEncoder();

const boundedDuration = (value: number | undefined, label: string): number | undefined => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > 30_000)) {
    throw new DevinError("INVALID_INPUT", `${label} must be between 1 and 30000 milliseconds`);
  }
  return value;
};

const wait = (milliseconds: number): Promise<false> => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), milliseconds);
  timer.unref();
});

const canonicalProjectRoot = (value: string | undefined): string => {
  if (value === undefined || !isAbsolute(value) || normalize(value) !== value) {
    throw new DevinError("INVALID_INPUT", "A Devin session requires an absolute normalized project directory.");
  }
  return value;
};

const truncateUtf8 = (value: string, maximumBytes: number): string => {
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  for (let end = maximumBytes; end > 0; end -= 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, end));
    } catch {
      // Back up to the preceding complete scalar.
    }
  }
  return "";
};

const projectedText = (value: string): Pick<CodexProjectedMessage, "text" | "omission"> => {
  const safe = sanitizeDevinText(value, true);
  const originalUtf8Bytes = encoder.encode(safe).byteLength;
  const text = truncateUtf8(safe, PROJECTED_MESSAGE_BYTES);
  const returnedUtf8Bytes = encoder.encode(text).byteLength;
  return originalUtf8Bytes === returnedUtf8Bytes
    ? { text }
    : {
        omission: {
          omittedUtf8Bytes: originalUtf8Bytes - returnedUtf8Bytes,
          originalUtf8Bytes,
          returnedUtf8Bytes,
        },
        text,
      };
};

const authorityMatches = (left: ProfileAuthority, right: ProfileAuthority): boolean =>
  left.id === right.id
  && left.generation === right.generation
  && left.provider === right.provider
  && left.providerAccountId === right.providerAccountId
  && left.bindingGeneration === right.bindingGeneration;

const permissionName = (fact: Extract<DevinFact, { type: "permissionRequested" }>): string => {
  switch (fact.toolCall.kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
    case "search":
    case "execute":
      return `workspace:${fact.toolCall.kind}`;
    case "fetch":
      return "network:fetch";
    case "think":
    case "switch_mode":
    case "other":
    case null:
      return `devin:${fact.toolCall.kind ?? "other"}`;
  }
};

const permissionRequestDigest = (
  fact: Extract<DevinFact, { type: "permissionRequested" }>,
): string => createHash("sha256")
  .update("oompa:devin-interaction-authority:v2\0", "utf8")
  .update(JSON.stringify({
    options: fact.options.map((option) => ({ kind: option.kind, optionId: option.optionId })),
    requestId: fact.requestId,
    sessionId: fact.sessionId,
    toolCallId: fact.toolCall.toolCallId,
  }), "utf8")
  .digest("hex");

const permissionResponseDigest = (outcome: DevinPermissionOutcome): string => createHash("sha256")
  .update("oompa:devin-interaction-response:v2\0", "utf8")
  .update(JSON.stringify(outcome), "utf8")
  .digest("hex");

const statusForStopReason = (reason: DevinStopReason): CodexTurnStatus => {
  switch (reason) {
    case "end_turn": return "completed";
    case "cancelled": return "interrupted";
    case "max_tokens":
    case "max_turn_requests":
    case "refusal":
      return "failed";
  }
};

type ProcessCustody = {
  readonly process: DevinAcpProcess;
  exit: Promise<number>;
  exitState: "pending" | "fulfilled" | "rejected";
};

type PendingPermission = {
  readonly fact: Extract<DevinFact, { type: "permissionRequested" }>;
  readonly authority: ProviderInteractionAuthority;
};

type RunningSession = {
  authority: ProfileAuthority;
  readonly client: DevinAcpClient;
  closeState: "open" | "closing" | "failed";
  readonly connectionId: string;
  readonly custody: ProcessCustody;
  emitFacts: boolean;
  providerThreadId: string | null;
  readonly profile: EffectiveDevinRuntimeProfile;
  readonly projectRoot: string;
  readonly resumed: boolean;
  status: "active" | "idle" | "terminal";
  activeTurnId: string | undefined;
  activeTurnStartedAt: number | undefined;
  activeTurnActions: string[];
  omittedActiveTurnActions: number;
  title: string;
  updatedAt: number;
  readonly messages: CodexProjectedMessage[];
  readonly turnSummaries: CodexTurnSummary[];
  readonly assistantItems: Map<string, number>;
  bindingFacts: DevinFact[] | null;
  readonly openItems: Map<string, string>;
  readonly permissions: Map<string, PendingPermission>;
  readonly deferredPermissions: Array<Extract<DevinFact, { type: "permissionRequested" }>>;
  droppedMessages: number;
  droppedTurns: number;
  truncatedMessages: number;
  promptTask: Promise<void> | undefined;
  promptErrorObserved: boolean;
};

const sessionWriterIsOpen = (session: RunningSession): boolean => session.closeState === "open";

type PendingReview = {
  authority: ProfileAuthority;
  readonly directories: DevinDirectories;
  readonly projectRoot: string;
  readonly providerThreadId?: string;
  readonly review: DevinRuntimeStartReview;
  readonly runtime: PinnedDevinRuntime;
};

export type DevinRuntimeObserver = {
  fact(authority: ProfileAuthority, fact: CodexFact): void | Promise<void>;
};

export type DevinProcessFactory = (input: Readonly<{
  runtime: PinnedDevinRuntime;
  directories: DevinDirectories;
  projectRoot: string;
}>) => DevinAcpProcess;

export type DevinProjectRootResolver = (input: Readonly<{
  authority: ProfileAuthority;
  providerThreadId: string;
}>) => string | undefined | Promise<string | undefined>;

/**
 * Owns one exact pinned `devin acp` process per admitted session. Raw ACP
 * values stop in `src/devin`; this class emits only the existing neutral
 * Codex fact vocabulary consumed by the daemon timeline.
 */
export class PinnedDevinRuntimeManager implements DevinRuntimePort {
  readonly provider = "devin" as const;
  readonly #isCurrent: (authority: ProfileAuthority) => boolean;
  readonly #observer: DevinRuntimeObserver;
  readonly #directoriesFor: (authority: ProfileAuthority) => DevinDirectories | Promise<DevinDirectories>;
  readonly #projectRootFor: DevinProjectRootResolver | undefined;
  readonly #readAuthStatus: typeof readDevinAuthStatus;
  readonly #resolveRuntime: typeof resolvePinnedDevinRuntime;
  readonly #processFactory: DevinProcessFactory;
  readonly #now: () => number;
  readonly #clientShutdownGraceMs: number | undefined;
  readonly #clientShutdownForceJoinMs: number | undefined;
  readonly #directJoinGraceMs: number;
  readonly #directForceJoinMs: number;
  readonly #sessions = new Map<string, RunningSession>();
  readonly #loads = new Map<string, Promise<RunningSession>>();
  readonly #unbound = new Set<RunningSession>();
  readonly #closedSessionProofs = new Map<string, ProfileAuthority>();
  readonly #reviews = new Map<string, PendingReview>();
  #resolvedRuntime: PinnedDevinRuntime | undefined;
  #state: "open" | "closed" = "open";

  constructor(input: {
    isCurrent: (authority: ProfileAuthority) => boolean;
    observer: DevinRuntimeObserver;
    directoriesFor: (authority: ProfileAuthority) => DevinDirectories | Promise<DevinDirectories>;
    projectRootFor?: DevinProjectRootResolver;
    readAuthStatus?: typeof readDevinAuthStatus;
    resolveRuntime?: typeof resolvePinnedDevinRuntime;
    processFactory?: DevinProcessFactory;
    clientShutdownGraceMs?: number;
    clientShutdownForceJoinMs?: number;
    directJoinGraceMs?: number;
    directForceJoinMs?: number;
    now?: () => number;
  }) {
    this.#isCurrent = input.isCurrent;
    this.#observer = input.observer;
    this.#directoriesFor = input.directoriesFor;
    this.#projectRootFor = input.projectRootFor;
    this.#readAuthStatus = input.readAuthStatus ?? readDevinAuthStatus;
    this.#resolveRuntime = input.resolveRuntime ?? resolvePinnedDevinRuntime;
    this.#processFactory = input.processFactory ?? ((launch) => spawnBunDevinAcpProcess({
      argv: devinAcpArgv(launch.runtime),
      directories: launch.directories,
      projectRoot: launch.projectRoot,
    }));
    this.#clientShutdownGraceMs = boundedDuration(
      input.clientShutdownGraceMs,
      "Devin client shutdown grace",
    );
    this.#clientShutdownForceJoinMs = boundedDuration(
      input.clientShutdownForceJoinMs,
      "Devin client forced join deadline",
    );
    this.#directJoinGraceMs = boundedDuration(
      input.directJoinGraceMs ?? DEFAULT_DIRECT_JOIN_GRACE_MS,
      "Devin direct process join grace",
    ) ?? DEFAULT_DIRECT_JOIN_GRACE_MS;
    this.#directForceJoinMs = boundedDuration(
      input.directForceJoinMs ?? DEFAULT_DIRECT_FORCE_JOIN_MS,
      "Devin direct forced join deadline",
    ) ?? DEFAULT_DIRECT_FORCE_JOIN_MS;
    this.#now = input.now ?? Date.now;
  }

  pinnedVersion(): string {
    if (this.#resolvedRuntime === undefined) {
      throw new DevinError("RUNTIME_MISMATCH", "No Devin CLI runtime has been admitted yet.");
    }
    return this.#resolvedRuntime.version;
  }

  rebindProfileAuthority(input: {
    expectedAuthority: ProfileAuthority;
    nextAuthority: ProfileAuthority;
  }): void {
    this.#assertOpen();
    const { expectedAuthority, nextAuthority } = input;
    if (
      expectedAuthority.provider !== "devin"
      || !Number.isSafeInteger(expectedAuthority.generation)
      || expectedAuthority.generation < 1
      || !Number.isSafeInteger(nextAuthority.generation)
      || nextAuthority.generation !== expectedAuthority.generation + 1
      || !authorityMatches({ ...expectedAuthority, generation: nextAuthority.generation }, nextAuthority)
    ) {
      throw new DevinError(
        "INVALID_INPUT",
        "A Devin authority rebind must advance exactly one safe generation.",
      );
    }
    this.#assertCurrent(nextAuthority);
    const sessions = [...this.#sessions.values()]
      .filter((session) => session.authority.id === expectedAuthority.id);
    const reviews = [...this.#reviews.values()]
      .filter((review) => review.authority.id === expectedAuthority.id);
    const unbound = [...this.#unbound]
      .filter((session) => session.authority.id === expectedAuthority.id);
    for (const session of sessions) {
      if (
        !authorityMatches(session.authority, expectedAuthority)
        && !authorityMatches(session.authority, nextAuthority)
      ) {
        throw new DevinError(
          "AUTHORITY_STALE",
          "A live Devin process belongs to an unexpected account generation.",
        );
      }
      if (session.activeTurnId !== undefined || session.status === "active") {
        throw new DevinError(
          "AUTHORITY_STALE",
          "An active Devin turn cannot be rebound to another account generation.",
        );
      }
      if (session.closeState !== "open") {
        throw new DevinError(
          "AUTHORITY_STALE",
          "Devin session cleanup is unresolved during account generation rotation.",
        );
      }
    }
    for (const review of reviews) {
      if (
        !authorityMatches(review.authority, expectedAuthority)
        && !authorityMatches(review.authority, nextAuthority)
      ) {
        throw new DevinError(
          "AUTHORITY_STALE",
          "A Devin runtime review belongs to an unexpected account generation.",
        );
      }
    }
    if (unbound.length > 0) {
      throw new DevinError(
        "AUTHORITY_STALE",
        "An unadmitted Devin child cannot cross an account generation rotation.",
      );
    }
    for (const session of sessions) session.authority = { ...nextAuthority };
    for (const review of reviews) review.authority = { ...nextAuthority };
  }

  hasLiveSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean {
    const session = this.#sessions.get(input.providerThreadId);
    return this.#state === "open"
      && session !== undefined
      && session.closeState === "open"
      && authorityMatches(session.authority, input.authority)
      && session.status !== "terminal"
      && this.#isCurrent(input.authority);
  }

  async readAccount(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<DevinAccountReadinessProjection> {
    this.#assertAccountReadAuthority(input.authority, input.signal);
    // Directory custody is not an account observation: failures here must stay
    // actionable instead of being flattened into unknown authentication.
    const directories = await this.#directoriesFor(input.authority);
    this.#assertAccountReadAuthority(input.authority, input.signal);
    let readiness: DevinAccountReadinessProjection["readiness"];
    try {
      const runtime = await this.#admitRuntime(input.signal);
      this.#assertAccountReadAuthority(input.authority, input.signal);
      const account = await this.#readAuthStatus({
        directories,
        runtime,
        signal: input.signal,
      });
      readiness = account.signedIn ? "signed_in" : "signed_out";
    } catch (error: unknown) {
      this.#assertAccountReadAuthority(input.authority, input.signal);
      if (!(error instanceof DevinError)
        || !["RUNTIME_MISMATCH", "PROTOCOL_ERROR", "PROTOCOL_LIMIT"].includes(error.code)) {
        throw error;
      }
      readiness = "unverified";
    }
    this.#assertAccountReadAuthority(input.authority, input.signal);
    return { observedAt: this.#now(), readiness };
  }

  async reviewSessionStart(input: {
    authority: ProfileAuthority;
    projectRoot?: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<DevinRuntimeStartReview> {
    return await this.#review({ ...input, kind: "session_start" });
  }

  async reviewTurnStart(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot?: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<DevinRuntimeStartReview> {
    return await this.#review({ ...input, kind: "turn_start" });
  }

  discardRuntimeReview(review: DevinRuntimeStartReview): void {
    const pending = this.#reviews.get(review.reviewId);
    if (pending?.review === review) this.#reviews.delete(review.reviewId);
  }

  async startSession(input: {
    authority: ProfileAuthority;
    projectRoot?: string;
    review: DevinRuntimeStartReview;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveDevinRuntimeProfile }> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    this.#assertNoUnboundChild();
    const pending = this.#consumeReview(input.authority, input.review, "session_start");
    if (input.projectRoot !== undefined && input.projectRoot !== pending.projectRoot) {
      throw new DevinError("AUTHORITY_STALE", "The reviewed Devin project directory changed.");
    }
    const session = await this.#launch(pending, null, false, input.signal);
    try {
      const providerThreadId = await this.#awaitLaunchCall(
        session,
        input.signal,
        session.client.newSession({ cwd: pending.projectRoot, signal: input.signal }),
      );
      await this.#bindNewSession(session, providerThreadId);
      this.#assertLaunchAuthority(input.authority, input.signal);
      if (session.custody.exitState !== "pending") {
        throw new DevinError("PROCESS_EXITED", "Devin exited before its new session was admitted.");
      }
      if (this.#sessions.has(providerThreadId)) {
        throw new DevinError("PROTOCOL_ERROR", "Devin returned an already-owned session id.");
      }
      session.emitFacts = true;
      this.#sessions.set(providerThreadId, session);
      this.#unbound.delete(session);
      return {
        ...this.#projection(session, false),
        effectiveRuntimeProfile: session.profile,
      };
    } catch (error: unknown) {
      await this.#disposeUnbound(session, error);
      throw error;
    }
  }

  async observeSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<CodexSessionObservation> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const existing = this.#sessions.get(input.providerThreadId);
    if (existing !== undefined) {
      const session = this.#requireSession(input.authority, input.providerThreadId);
      return {
        connectionId: session.connectionId,
        projection: this.#projection(session),
        resumed: session.resumed,
      };
    }
    if (this.#projectRootFor === undefined) {
      throw new CodexSessionObservationError("resume_unavailable");
    }
    let task = this.#loads.get(input.providerThreadId);
    if (task === undefined) {
      task = this.#loadForObservation(input);
      this.#loads.set(input.providerThreadId, task);
      void task.finally(() => {
        if (this.#loads.get(input.providerThreadId) === task) this.#loads.delete(input.providerThreadId);
      }).catch(() => undefined);
    }
    let session: RunningSession;
    try {
      session = await task;
    } catch (error: unknown) {
      if (error instanceof CodexSessionObservationError) throw error;
      throw new CodexSessionObservationError("resume_unavailable", { cause: error });
    }
    this.#requireSession(input.authority, input.providerThreadId);
    return {
      connectionId: session.connectionId,
      projection: this.#projection(session),
      resumed: true,
    };
  }

  async readSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    detail: boolean;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection> {
    if (!this.#sessions.has(input.providerThreadId)) {
      await this.observeSession(input);
    }
    return this.#projection(
      this.#requireSession(input.authority, input.providerThreadId),
      input.detail,
    );
  }

  async endSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const session = this.#sessions.get(input.providerThreadId);
    if (session === undefined) {
      const proof = this.#closedSessionProofs.get(input.providerThreadId);
      if (proof !== undefined && authorityMatches(proof, input.authority)) return;
      throw new DevinError(
        "PROCESS_EXITED",
        "That Devin session is unknown on this daemon, so its process cleanup cannot be proven.",
      );
    }
    this.#requireSession(input.authority, input.providerThreadId);
    await this.#closeSession(input.providerThreadId, session);
  }

  async startTurn(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot?: string;
    review: DevinRuntimeStartReview;
    message: string;
    attachments?: readonly PreparedAttachment[];
    clientMessageId: string;
    signal: AbortSignal;
  }): Promise<{
    turnId: string;
    status: CodexTurnStatus;
    effectiveRuntimeProfile: EffectiveDevinRuntimeProfile;
  }> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const pending = this.#consumeReview(input.authority, input.review, "turn_start");
    if (pending.providerThreadId !== input.providerThreadId) {
      throw new DevinError("AUTHORITY_STALE", "The reviewed Devin session changed.");
    }
    if (input.projectRoot !== undefined && input.projectRoot !== pending.projectRoot) {
      throw new DevinError("AUTHORITY_STALE", "The reviewed Devin project directory changed.");
    }
    if ((input.attachments?.length ?? 0) > 0) {
      throw new DevinError(
        "UNSUPPORTED_CAPABILITY",
        "The pinned Devin ACP text adapter does not yet support attachments.",
      );
    }
    const message = boundedDevinPrompt(input.message);
    let session = this.#sessions.get(input.providerThreadId);
    if (session === undefined) {
      session = await this.#launchAndLoad(pending, input.providerThreadId, input.signal);
    }
    session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.projectRoot !== pending.projectRoot) {
      throw new DevinError("AUTHORITY_STALE", "The live Devin session uses another project directory.");
    }
    if (session.status === "terminal") {
      throw new DevinError("PROCESS_EXITED", "The Devin session requires a fresh session/load writer.");
    }
    // The ACP prompt is settled before #finishTurn clears activeTurnId. Its
    // observer may dispatch the next queued turn while the old promptTask is
    // still publishing completion, so that bookkeeping promise is not an
    // admission fence.
    if (session.activeTurnId !== undefined) {
      throw new DevinError("INVALID_INPUT", "The Devin session already has an active prompt.");
    }
    const turnId = randomUUID();
    session.activeTurnId = turnId;
    session.activeTurnStartedAt = this.#now();
    session.activeTurnActions = [];
    session.assistantItems.clear();
    session.omittedActiveTurnActions = 0;
    session.promptErrorObserved = false;
    session.status = "active";
    session.updatedAt = this.#now();
    this.#appendUserMessage(session, turnId, message, input.clientMessageId);
    try {
      await this.#emitNeutral(session, {
        threadId: input.providerThreadId,
        turn: {
          completedAt: null,
          durationMs: null,
          id: turnId,
          items: [],
          startedAt: session.activeTurnStartedAt,
          status: "inProgress",
        },
        type: "turnStarted",
      });
    } catch (error: unknown) {
      session.activeTurnId = undefined;
      session.activeTurnStartedAt = undefined;
      session.status = "idle";
      session.messages.pop();
      throw error;
    }
    const prompt = session.client.prompt({ sessionId: input.providerThreadId, text: message });
    const task = prompt.then(
      async (stopReason) => { await this.#finishTurn(session, turnId, statusForStopReason(stopReason)); },
      async (error: unknown) => { await this.#failPrompt(session, turnId, error); },
    ).finally(() => {
      if (session.promptTask === task) session.promptTask = undefined;
    });
    session.promptTask = task;
    void task.catch(() => undefined);
    return {
      effectiveRuntimeProfile: pending.review.effectiveRuntimeProfile,
      status: "inProgress",
      turnId,
    };
  }

  async steer(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    activeTurnId: string;
    message: string;
    attachments?: readonly PreparedAttachment[];
    clientMessageId: string;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) {
      throw new DevinError("INVALID_INPUT", "That Devin turn is no longer active.");
    }
    throw new DevinError(
      "UNSUPPORTED_CAPABILITY",
      "ACP v1 has no unambiguous in-turn steering; queue the message or interrupt first.",
    );
  }

  async interrupt(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    activeTurnId: string;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) return;
    const pending = [...session.permissions.values()];
    await session.client.cancel(input.providerThreadId);
    session.permissions.clear();
    for (const permission of pending) this.#reportInteractionSettled(session, permission);
  }

  async compact(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.status === "terminal") {
      throw new DevinError("PROCESS_EXITED", "The Devin session requires a fresh session/load writer.");
    }
    if (session.activeTurnId !== undefined || session.promptTask !== undefined) {
      throw new DevinError("INVALID_INPUT", "The Devin session has an active prompt; compaction is only admitted between turns.");
    }
    // ACP v1 has no dedicated compaction request: the pinned CLI advertises
    // `/compact` as a slash command, which arrives as an ordinary
    // session/prompt. The client's single-prompt guard is the mid-turn fence,
    // and its compaction updates stay intentionally unprojected.
    await session.client.prompt({
      sessionId: input.providerThreadId,
      signal: input.signal,
      text: "/compact",
    });
  }

  interactionAuthority(
    authority: ProfileAuthority,
    providerThreadId: string,
    requestId: string,
  ): ProviderInteractionAuthority {
    const session = this.#requireSession(authority, providerThreadId);
    const pending = session.permissions.get(requestId);
    if (pending === undefined) {
      throw new DevinError("PROTOCOL_ERROR", "That Devin permission request is no longer pending.");
    }
    return pending.authority;
  }

  async inspectInteractionAuthority(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    signal: AbortSignal;
  }): Promise<LiveInteractionApprovalAuthority> {
    input.signal.throwIfAborted();
    const { permission, session } = this.#requirePending(input.authority, input.provider);
    if (input.kind !== "permission_approval") {
      throw new DevinError(
        "UNSUPPORTED_CAPABILITY",
        "Devin ACP exposes a permission choice, not exact command or file-change authority.",
      );
    }
    return {
      environmentId: null,
      kind: "permission_approval",
      permissions: [permissionName(permission.fact)],
      reason: permission.fact.toolCall.title,
      workingDirectory: session.projectRoot,
    };
  }

  async validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    input.signal.throwIfAborted();
    const { permission } = this.#requirePending(input.authority, input.provider);
    const outcome = this.#permissionOutcome(input.kind, input.resolution, permission.fact);
    return { responseDigest: permissionResponseDigest(outcome) };
  }

  async resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    input.signal.throwIfAborted();
    const { permission, session } = this.#requirePending(input.authority, input.provider);
    if (this.#now() > input.deadlineAt) {
      throw new DevinError("DEADLINE_EXPIRED", "The Devin interaction deadline passed.");
    }
    const outcome = this.#permissionOutcome(input.kind, input.resolution, permission.fact);
    await session.client.resolvePermission({ requestId: permission.fact.requestId, outcome });
    session.permissions.delete(permission.fact.requestId);
    this.#reportInteractionSettled(session, permission);
    return { responseWritten: true };
  }

  async validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    input.signal.throwIfAborted();
    const { permission } = this.#requirePending(input.authority, input.provider);
    return { responseDigest: permissionResponseDigest(this.#timeoutOutcome(permission.fact)) };
  }

  async timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    input.signal.throwIfAborted();
    const { permission, session } = this.#requirePending(input.authority, input.provider);
    const outcome = this.#timeoutOutcome(permission.fact);
    await session.client.resolvePermission({ requestId: permission.fact.requestId, outcome });
    session.permissions.delete(permission.fact.requestId);
    this.#reportInteractionSettled(session, permission);
    return { responseWritten: true };
  }

  async close(): Promise<void> {
    this.#state = "closed";
    this.#reviews.clear();
    const settlements = await Promise.allSettled([
      ...[...this.#sessions.entries()].map(async ([id, session]) => {
        await this.#closeSession(id, session);
      }),
      ...[...this.#unbound].map(async (session) => {
        await this.#closeOwnedProcess(session);
        this.#unbound.delete(session);
      }),
    ]);
    const failures = settlements.flatMap((settlement) =>
      settlement.status === "rejected" ? [settlement.reason as unknown] : []);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Devin ACP child processes could not be joined during shutdown.",
      );
    }
  }

  async #review(input: {
    authority: ProfileAuthority;
    kind: "session_start" | "turn_start";
    projectRoot?: string;
    providerThreadId?: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<DevinRuntimeStartReview> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    if (input.kind === "session_start") this.#assertNoUnboundChild();
    assertPresetSupportedByProvider("devin", input.preset);
    const expectedRequirement = presetRequirementForContract(
      input.preset,
      currentPresetContract,
    );
    if (
      input.requirement.model !== expectedRequirement.model
      || input.requirement.effort !== expectedRequirement.effort
    ) {
      throw new DevinError(
        "INVALID_INPUT",
        "Devin requires Astra under the current preset contract.",
      );
    }
    if (input.fast) {
      throw new DevinError(
        "UNSUPPORTED_CAPABILITY",
        "Devin ACP has no Oompa fast service tier; start without `--fast`.",
      );
    }
    const projectRoot = canonicalProjectRoot(input.projectRoot);
    const directories = await this.#directoriesFor(input.authority);
    this.#assertLaunchAuthority(input.authority, input.signal);
    const runtime = await this.#admitRuntime(input.signal);
    this.#assertLaunchAuthority(input.authority, input.signal);
    const profile = effectiveDevinRuntimeProfileSchema.parse({
      devinVersion: runtime.version,
      isolatedHome: true,
      model: expectedRequirement.model,
      observedAt: this.#now(),
      preset: input.preset,
      processGeneration: input.authority.generation,
      profileId: input.authority.id,
      protocolVersion: DEVIN_ACP_PROTOCOL_VERSION,
      reasoningEffort: expectedRequirement.effort,
    });
    const review: DevinRuntimeStartReview = {
      effectiveRuntimeProfile: profile,
      kind: input.kind,
      reviewId: randomUUID(),
    };
    this.#reviews.set(review.reviewId, {
      authority: input.authority,
      directories,
      projectRoot,
      review,
      runtime,
      ...(input.providerThreadId === undefined ? {} : { providerThreadId: input.providerThreadId }),
    });
    return review;
  }

  async #admitRuntime(signal: AbortSignal): Promise<PinnedDevinRuntime> {
    let runtime: PinnedDevinRuntime;
    try {
      runtime = await this.#resolveRuntime({ signal } satisfies ResolvePinnedDevinRuntimeOptions);
    } catch (error: unknown) {
      const detail = error instanceof DevinError ? error.message : "it could not be admitted";
      throw new DevinError(
        "RUNTIME_MISMATCH",
        `Oompa cannot start Devin on this machine: ${detail}. Install Devin CLI ${DEVIN_PIN} exactly, `
        + "put `devin` on this daemon's PATH, then sign in inside the account's isolated Devin profile.",
        { cause: error },
      );
    }
    // The resolver already admitted the exact pin; the executable path is the
    // one remaining launch precondition an injected resolver could violate.
    if (!isAbsolute(runtime.executablePath)) {
      throw new DevinError(
        "RUNTIME_MISMATCH",
        `Oompa requires Devin CLI ${DEVIN_PIN} with model ${DEVIN_MODEL} at an absolute path.`,
      );
    }
    this.#resolvedRuntime = runtime;
    return runtime;
  }

  #consumeReview(
    authority: ProfileAuthority,
    review: DevinRuntimeStartReview,
    kind: "session_start" | "turn_start",
  ): PendingReview {
    const pending = this.#reviews.get(review.reviewId);
    this.#reviews.delete(review.reviewId);
    if (
      pending === undefined
      || pending.review.kind !== kind
      || !authorityMatches(pending.authority, authority)
    ) {
      throw new DevinError("AUTHORITY_STALE", "That Devin runtime review is no longer usable.");
    }
    if (
      JSON.stringify(pending.review.effectiveRuntimeProfile)
      !== JSON.stringify(review.effectiveRuntimeProfile)
    ) {
      throw new DevinError("AUTHORITY_STALE", "The Devin runtime review was modified.");
    }
    return pending;
  }

  async #loadForObservation(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<RunningSession> {
    try {
      const projectRoot = canonicalProjectRoot(await this.#projectRootFor?.(input));
      this.#assertLaunchAuthority(input.authority, input.signal);
      const directories = await this.#directoriesFor(input.authority);
      this.#assertLaunchAuthority(input.authority, input.signal);
      const runtime = await this.#admitRuntime(input.signal);
      const profile = effectiveDevinRuntimeProfileSchema.parse({
        devinVersion: runtime.version,
        isolatedHome: true,
        model: DEVIN_MODEL,
        observedAt: this.#now(),
        preset: "astra",
        processGeneration: input.authority.generation,
        profileId: input.authority.id,
        protocolVersion: DEVIN_ACP_PROTOCOL_VERSION,
        reasoningEffort: "provider-default",
      });
      return await this.#launchAndLoad({
        authority: input.authority,
        directories,
        projectRoot,
        providerThreadId: input.providerThreadId,
        review: {
          effectiveRuntimeProfile: profile,
          kind: "turn_start",
          reviewId: randomUUID(),
        },
        runtime,
      }, input.providerThreadId, input.signal);
    } catch (error: unknown) {
      throw new CodexSessionObservationError("resume_unavailable", { cause: error });
    }
  }

  async #launchAndLoad(
    pending: PendingReview,
    providerThreadId: string,
    signal: AbortSignal,
  ): Promise<RunningSession> {
    this.#assertLaunchAuthority(pending.authority, signal);
    const existing = this.#sessions.get(providerThreadId);
    if (existing !== undefined) return this.#requireSession(pending.authority, providerThreadId);
    const session = await this.#launch(pending, providerThreadId, true, signal);
    try {
      await this.#awaitLaunchCall(
        session,
        signal,
        session.client.loadSession({
          cwd: pending.projectRoot,
          sessionId: providerThreadId,
          signal,
        }),
      );
      this.#assertLaunchAuthority(pending.authority, signal);
      if (session.custody.exitState !== "pending") {
        throw new DevinError("PROCESS_EXITED", "Devin exited before its loaded session was admitted.");
      }
      if (this.#sessions.has(providerThreadId)) {
        throw new DevinError("PROTOCOL_ERROR", "That Devin session acquired two local writers.");
      }
      session.emitFacts = true;
      this.#sessions.set(providerThreadId, session);
      try {
        for (const permission of session.deferredPermissions.splice(0)) {
          await this.#applyPermission(session, permission);
        }
      } catch (error: unknown) {
        if (this.#sessions.get(providerThreadId) === session) this.#sessions.delete(providerThreadId);
        throw error;
      }
      this.#unbound.delete(session);
      return session;
    } catch (error: unknown) {
      await this.#disposeUnbound(session, error);
      throw error;
    }
  }

  async #launch(
    pending: PendingReview,
    providerThreadId: string | null,
    resumed: boolean,
    signal: AbortSignal,
  ): Promise<RunningSession> {
    this.#assertLaunchAuthority(pending.authority, signal);
    let process: DevinAcpProcess;
    try {
      process = this.#processFactory({
        directories: pending.directories,
        projectRoot: pending.projectRoot,
        runtime: pending.runtime,
      });
    } catch (error: unknown) {
      throw new DevinError("PROCESS_EXITED", "The Devin ACP process could not be started.", {
        cause: error,
      });
    }
    const custody: ProcessCustody = {
      exit: Promise.resolve(0),
      exitState: "pending",
      process,
    };
    const exit = process.exited.then(
      (code) => { custody.exitState = "fulfilled"; return code; },
      (error: unknown) => { custody.exitState = "rejected"; throw error; },
    );
    custody.exit = exit;
    const slot: { current?: RunningSession } = {};
    let client: DevinAcpClient;
    try {
      client = new DevinAcpClient({
        process,
        onFact: async (fact) => {
          if (slot.current === undefined) {
            throw new DevinError("PROTOCOL_ERROR", "Devin emitted a fact before client custody was bound.");
          }
          await this.#onFact(slot.current, fact);
        },
        ...(this.#clientShutdownGraceMs === undefined
          ? {}
          : { shutdownGraceMs: this.#clientShutdownGraceMs }),
        ...(this.#clientShutdownForceJoinMs === undefined
          ? {}
          : { shutdownForceJoinMs: this.#clientShutdownForceJoinMs }),
      });
    } catch (error: unknown) {
      await this.#stopBareProcess(custody).catch(() => undefined);
      throw error;
    }
    const session: RunningSession = {
      activeTurnActions: [],
      activeTurnId: undefined,
      activeTurnStartedAt: undefined,
      assistantItems: new Map(),
      authority: pending.authority,
      bindingFacts: providerThreadId === null ? [] : null,
      client,
      closeState: "open",
      connectionId: randomUUID(),
      custody,
      deferredPermissions: [],
      droppedMessages: 0,
      droppedTurns: 0,
      emitFacts: false,
      messages: [],
      omittedActiveTurnActions: 0,
      openItems: new Map(),
      permissions: new Map(),
      profile: pending.review.effectiveRuntimeProfile,
      projectRoot: pending.projectRoot,
      promptErrorObserved: false,
      promptTask: undefined,
      providerThreadId,
      resumed,
      status: "idle",
      title: "Untitled session",
      truncatedMessages: 0,
      turnSummaries: [],
      updatedAt: this.#now(),
    };
    slot.current = session;
    this.#unbound.add(session);
    void exit.then(
      () => { void this.#onProcessExit(session); },
      () => { void this.#onProcessExit(session); },
    );
    try {
      await this.#awaitLaunchCall(
        session,
        signal,
        client.initialize({ signal }),
      );
      return session;
    } catch (error: unknown) {
      await this.#disposeUnbound(session, error);
      throw error;
    }
  }

  async #awaitLaunchCall<Value>(
    session: RunningSession,
    signal: AbortSignal,
    operation: Promise<Value>,
  ): Promise<Value> {
    if (signal.aborted) {
      void session.client.close().catch(() => undefined);
      throw new DevinError("PROCESS_EXITED", "The Devin launch was canceled.");
    }
    let rejectAbort!: (error: DevinError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const onAbort = (): void => {
      void session.client.close().catch(() => undefined);
      rejectAbort(new DevinError("PROCESS_EXITED", "The Devin launch was canceled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #disposeUnbound(session: RunningSession, original: unknown): Promise<void> {
    try {
      await this.#closeOwnedProcess(session);
      this.#unbound.delete(session);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [original, cleanupError],
        "Devin launch failed and its ACP child cleanup was incomplete.",
        { cause: original },
      );
    }
  }

  async #closeSession(providerThreadId: string, session: RunningSession): Promise<void> {
    if (this.#sessions.get(providerThreadId) === session) session.closeState = "closing";
    try {
      await this.#closeOwnedProcess(session);
    } catch (error: unknown) {
      if (this.#sessions.get(providerThreadId) === session) session.closeState = "failed";
      throw error;
    }
    if (this.#sessions.get(providerThreadId) === session) {
      this.#rememberClosedSession(providerThreadId, session.authority);
      this.#sessions.delete(providerThreadId);
    }
  }

  async #closeOwnedProcess(session: RunningSession): Promise<void> {
    let closeError: unknown;
    try {
      await session.client.close();
    } catch (error: unknown) {
      closeError = error;
    }
    try {
      await this.#ensureProcessJoined(session.custody);
    } catch (joinError: unknown) {
      throw closeError === undefined
        ? joinError
        : new AggregateError([closeError, joinError], "The Devin ACP child could not be joined.");
    }
    if (closeError !== undefined) {
      throw closeError instanceof Error
        ? closeError
        : new DevinError("PROCESS_EXITED", "The Devin ACP client close failed.");
    }
  }

  async #stopBareProcess(custody: ProcessCustody): Promise<void> {
    if (custody.exitState === "pending") {
      try { custody.process.terminate(); } catch { /* Force remains authoritative. */ }
      await Promise.race([custody.exit.catch(() => -1), wait(this.#directJoinGraceMs)]);
    }
    await this.#ensureProcessJoined(custody);
  }

  async #ensureProcessJoined(custody: ProcessCustody): Promise<void> {
    if (custody.exitState !== "fulfilled") {
      try { custody.process.forceTerminate(); } catch { /* Bounded wait remains authoritative. */ }
      if (custody.exitState === "pending") {
        await Promise.race([custody.exit.catch(() => -1), wait(this.#directForceJoinMs)]);
      }
    }
    if (custody.exitState !== "fulfilled") {
      throw new DevinError(
        "PROCESS_EXITED",
        "The Devin ACP process could not be joined after forced termination.",
      );
    }
  }

  async #onProcessExit(session: RunningSession): Promise<void> {
    if (session.closeState !== "open" || session.providerThreadId === null) return;
    if (this.#sessions.get(session.providerThreadId) !== session) return;
    const providerThreadId = session.providerThreadId;
    session.status = "terminal";
    session.updatedAt = this.#now();

    // The client rejects an active prompt when it observes child exit. Let the
    // owned prompt task publish its terminal turn before retiring this writer.
    // Once the child and its pipes are joined, a later observation may safely
    // establish a fresh writer with session/load.
    await session.promptTask?.catch(() => undefined);
    if (this.#sessions.get(providerThreadId) !== session || !sessionWriterIsOpen(session)) return;
    session.closeState = "closing";
    try {
      await this.#closeOwnedProcess(session);
    } catch {
      if (this.#sessions.get(providerThreadId) === session) session.closeState = "failed";
      return;
    }
    if (this.#sessions.get(providerThreadId) !== session) return;
    this.#rememberClosedSession(providerThreadId, session.authority);
    this.#sessions.delete(providerThreadId);
    await this.#emitNeutral(session, {
      connectionId: session.connectionId,
      reason: "process_exit",
      type: "providerDisconnected",
    }).catch(() => undefined);
  }

  #requireSession(authority: ProfileAuthority, providerThreadId: string): RunningSession {
    const session = this.#sessions.get(providerThreadId);
    if (session === undefined) {
      throw new DevinError("PROTOCOL_ERROR", "That Devin session is not running on this daemon.");
    }
    if (!authorityMatches(session.authority, authority)) {
      throw new DevinError("AUTHORITY_STALE", "The Devin session belongs to another authority.");
    }
    this.#assertCurrent(authority);
    if (session.closeState !== "open") {
      throw new DevinError(
        "PROCESS_EXITED",
        "That Devin session's process cleanup is unresolved on this daemon.",
      );
    }
    return session;
  }

  #requirePending(
    authority: ProfileAuthority,
    provider: ProviderInteractionAuthority,
  ): Readonly<{ permission: PendingPermission; session: RunningSession }> {
    if (provider.method !== PERMISSION_METHOD || provider.requestId.type !== "string") {
      throw new DevinError("PROTOCOL_ERROR", "That authority does not name a Devin permission request.");
    }
    const session = this.#requireSession(authority, provider.threadId ?? "");
    if (session.connectionId !== provider.connectionId) {
      throw new DevinError("AUTHORITY_STALE", "The Devin provider connection was replaced.");
    }
    const permission = session.permissions.get(provider.requestId.value);
    if (permission === undefined) {
      throw new DevinError("PROTOCOL_ERROR", "That Devin permission request is no longer pending.");
    }
    if (permission.authority.requestDigest !== provider.requestDigest) {
      throw new DevinError("AUTHORITY_STALE", "The Devin permission request no longer matches.");
    }
    return { permission, session };
  }

  #permissionOutcome(
    kind: InteractionKind,
    resolution: InteractionResolution,
    fact: Extract<DevinFact, { type: "permissionRequested" }>,
  ): DevinPermissionOutcome {
    if (kind !== "permission_approval") {
      throw new DevinError("INVALID_INPUT", "A Devin ACP permission requires a permission decision.");
    }
    let desired: "allow_once" | "reject_once" | "cancelled";
    if (resolution.kind === "approval_decision") {
      switch (resolution.decision) {
        case "once": desired = "allow_once"; break;
        case "session": throw new DevinError(
          "UNSUPPORTED_CAPABILITY",
          "Devin's always-allow choice persists at provider scope, so Oompa cannot grant session scope.",
        );
        case "decline": desired = "reject_once"; break;
        case "cancel": desired = "cancelled"; break;
      }
    } else if (resolution.kind === "permission_grant") {
      const expected = permissionName(fact);
      if (resolution.permissions.length !== 1 || resolution.permissions[0] !== expected) {
        throw new DevinError("INVALID_INPUT", "The Devin permission grant changed the requested category.");
      }
      if (resolution.scope === "session") {
        throw new DevinError(
          "UNSUPPORTED_CAPABILITY",
          "Devin's always-allow choice persists at provider scope, so Oompa cannot grant session scope.",
        );
      }
      desired = "allow_once";
    } else {
      throw new DevinError("INVALID_INPUT", "Devin ACP accepts no answers or MCP submissions here.");
    }
    if (desired === "cancelled") return { outcome: "cancelled" };
    const option = fact.options.find((candidate) => candidate.kind === desired);
    // ACP's cancelled outcome denies only this pending request. Never widen a
    // one-time decline into the provider's persistent reject_always option.
    if (option === undefined && desired === "reject_once") return { outcome: "cancelled" };
    if (option === undefined) {
      throw new DevinError(
        "UNSUPPORTED_CAPABILITY",
        `Devin did not offer the requested ${desired.replaceAll("_", " ")} decision.`,
      );
    }
    return { optionId: option.optionId, outcome: "selected" };
  }

  #timeoutOutcome(
    fact: Extract<DevinFact, { type: "permissionRequested" }>,
  ): DevinPermissionOutcome {
    const reject = fact.options.find((option) => option.kind === "reject_once");
    return reject === undefined
      ? { outcome: "cancelled" }
      : { optionId: reject.optionId, outcome: "selected" };
  }

  async #bindNewSession(session: RunningSession, providerThreadId: string): Promise<void> {
    const facts = session.bindingFacts;
    if (session.providerThreadId !== null || facts === null) {
      throw new DevinError("PROTOCOL_ERROR", "Devin's new session was already bound.");
    }
    session.providerThreadId = providerThreadId;
    let consumed = 0;
    while (consumed < facts.length) {
      // Validate a stable batch before applying any of it. Facts arriving
      // while the batch is projected remain buffered for the next pass.
      const boundary = facts.length;
      for (let index = consumed; index < boundary; index += 1) {
        const fact = facts[index];
        if (fact !== undefined && fact.sessionId !== null && fact.sessionId !== providerThreadId) {
          throw new DevinError("PROTOCOL_ERROR", "Devin published a fact for another session.");
        }
      }
      while (consumed < boundary) {
        const fact = facts[consumed];
        consumed += 1;
        // Provider-global notices cannot establish facts about the newly
        // returned session, so they are deliberately not projected here.
        if (fact !== undefined && fact.sessionId === providerThreadId) {
          await this.#applyFact(session, fact);
        }
      }
    }
    facts.length = 0;
    session.bindingFacts = null;
  }

  async #onFact(session: RunningSession, fact: DevinFact): Promise<void> {
    if (session.bindingFacts !== null) {
      if (session.bindingFacts.length >= PREBIND_FACT_LIMIT) {
        throw new DevinError("PROTOCOL_LIMIT", "Devin emitted too many facts before binding its new session id.");
      }
      session.bindingFacts.push(fact);
      return;
    }
    await this.#applyFact(session, fact);
  }

  async #applyFact(session: RunningSession, fact: DevinFact): Promise<void> {
    session.updatedAt = this.#now();
    if (
      "sessionId" in fact
      && fact.sessionId !== null
      && session.providerThreadId !== null
      && fact.sessionId !== session.providerThreadId
    ) {
      throw new DevinError("PROTOCOL_ERROR", "Devin published a fact for another session.");
    }
    if (
      fact.type === "protocolNotice"
      && fact.disposition === "unprojected_update"
      && INTENTIONALLY_UNPROJECTED_UPDATES.has(fact.method)
    ) {
      // These known ACP updates are outside the bounded transcript adapter.
      // Their deliberate omission is not a protocol incompatibility. Preserve
      // only replay coverage accounting; raw thought content never arrives.
      if (!session.emitFacts && fact.method === "session/update:user_message_chunk") {
        session.droppedMessages += 1;
      }
      return;
    }
    if (fact.type === "permissionRequested" && !session.emitFacts) {
      if (session.deferredPermissions.length >= DEFERRED_PERMISSION_LIMIT) {
        throw new DevinError("PROTOCOL_LIMIT", "Devin replayed too many pending permission requests.");
      }
      session.deferredPermissions.push(fact);
      return;
    }
    if (fact.type === "assistantDelta") {
      this.#appendAssistantDelta(session, fact.messageId, fact.text);
      const turnId = session.activeTurnId;
      if (turnId === undefined) return;
      const itemId = this.#assistantItemId(session, fact.messageId, "agent");
      await this.#openAndEmitDelta(session, itemId, "agentMessage", {
        itemId,
        text: fact.text,
        threadId: fact.sessionId,
        turnId,
        type: "assistantDelta",
      });
      return;
    }
    if (fact.type === "toolCall" || fact.type === "toolCallUpdate") {
      await this.#applyToolFact(session, fact);
      return;
    }
    if (fact.type === "plan") {
      if (session.activeTurnId !== undefined) {
        await this.#emitNeutral(session, {
          steps: fact.entries.map((entry) => ({ status: entry.status, text: entry.content })),
          threadId: fact.sessionId,
          turnId: session.activeTurnId,
          type: "planUpdated",
        });
      }
      return;
    }
    if (fact.type === "permissionRequested") {
      await this.#applyPermission(session, fact);
      return;
    }
    if (fact.type === "usageUpdated") {
      if (session.activeTurnId !== undefined) {
        // ACP reports current context occupancy and capacity, not an account
        // allowance or a token-category breakdown. Preserve only those two
        // measured values; the unavailable components remain null.
        await this.#emitNeutral(session, {
          cachedInputTokens: null,
          inputTokens: null,
          modelContextWindow: fact.size === 0 ? null : fact.size,
          outputTokens: null,
          ...(fact.cost === null ? {} : { providerCost: fact.cost }),
          reasoningOutputTokens: null,
          threadId: fact.sessionId,
          totalTokens: fact.used,
          turnId: session.activeTurnId,
          type: "tokenUsageUpdated",
        });
      }
      return;
    }
    if (fact.type === "providerError") {
      session.promptErrorObserved = true;
      if (fact.terminal) session.status = "terminal";
      if (session.providerThreadId !== null) {
        await this.#emitNeutral(session, {
          code: `devin_rpc_${fact.code}`,
          message: fact.message,
          terminal: fact.terminal,
          threadId: session.providerThreadId,
          turnId: session.activeTurnId ?? "",
          type: "providerError",
        });
      }
      return;
    }
    if (fact.type === "turnStopped") {
      // `DevinAcpClient.prompt()` resolves only after its own active-prompt
      // guard has been released. The prompt task performs the neutral turn
      // completion then, preventing the queue from racing a still-active ACP
      // prompt.
      return;
    }
    await this.#emitNeutral(session, { method: fact.method, type: "protocolNotice" });
  }

  async #applyToolFact(
    session: RunningSession,
    fact: Extract<DevinFact, { type: "toolCall" | "toolCallUpdate" }>,
  ): Promise<void> {
    const turnId = session.activeTurnId;
    if (turnId === undefined || session.providerThreadId === null) return;
    const itemId = `devin-tool:${fact.toolCallId}`;
    const itemKind = `devinTool:${fact.kind ?? "other"}`;
    if (!session.openItems.has(itemId)) {
      this.#setOpenItem(session, itemId, itemKind);
      await this.#emitNeutral(session, {
        itemId,
        itemKind,
        ...(fact.status === null ? {} : { status: fact.status }),
        threadId: session.providerThreadId,
        turnId,
        type: "itemStarted",
      });
      if (fact.title !== null && session.activeTurnActions.length < PROJECTED_ACTION_LIMIT) {
        session.activeTurnActions.push(fact.title);
      } else if (fact.title !== null) {
        session.omittedActiveTurnActions += 1;
      }
    }
    await this.#emitNeutral(session, {
      itemId,
      ...(fact.status === null ? {} : { status: fact.status }),
      threadId: session.providerThreadId,
      toolKind: fact.kind ?? "other",
      turnId,
      type: "toolProgress",
    });
    if (fact.status === "completed" || fact.status === "failed") {
      session.openItems.delete(itemId);
      await this.#emitNeutral(session, {
        itemId,
        itemKind,
        status: fact.status,
        threadId: session.providerThreadId,
        turnId,
        type: "itemCompleted",
      });
    }
  }

  async #applyPermission(
    session: RunningSession,
    fact: Extract<DevinFact, { type: "permissionRequested" }>,
  ): Promise<void> {
    if (session.providerThreadId === null || fact.sessionId !== session.providerThreadId) {
      throw new DevinError("PROTOCOL_ERROR", "Devin requested permission for another session.");
    }
    const authority: ProviderInteractionAuthority = {
      approvalId: fact.toolCall.toolCallId,
      bindingGeneration: session.authority.bindingGeneration,
      connectionId: session.connectionId,
      itemId: fact.toolCall.toolCallId,
      method: PERMISSION_METHOD,
      processGeneration: session.authority.generation,
      profileId: session.authority.id,
      provider: session.authority.provider,
      providerAccountId: session.authority.providerAccountId,
      requestDigest: permissionRequestDigest(fact),
      requestId: { type: "string", value: fact.requestId },
      threadId: session.providerThreadId,
      turnId: session.activeTurnId ?? null,
    };
    if (session.permissions.has(fact.requestId)) {
      throw new DevinError("PROTOCOL_ERROR", "Devin reused a pending permission request id.");
    }
    if (session.permissions.size >= PENDING_PERMISSION_LIMIT) {
      throw new DevinError("PROTOCOL_LIMIT", "Devin emitted too many pending permission requests.");
    }
    const permission = { authority, fact };
    session.permissions.set(fact.requestId, permission);
    const requested = permissionName(fact);
    await this.#emitNeutral(session, {
      blocking: true,
      display: {
        // ACP allow_always persists in Devin itself; it is not bounded to this
        // Oompa session and therefore cannot be represented as session scope.
        allowsSessionScope: false,
        kind: "permission_approval",
        reason: fact.toolCall.title,
        requested: [{ name: requested }],
        summary: fact.toolCall.title ?? `Devin requests ${requested} permission`,
      },
      kind: "permission_approval",
      provider: authority,
      type: "interactionRequested",
    });
  }

  #assistantItemId(
    session: RunningSession,
    messageId: string | null,
    kind: "agent" | "thought",
  ): string {
    const key = `${kind}:${messageId ?? "current"}`;
    const existing = session.openItems.get(key);
    if (existing?.startsWith("id:")) return existing.slice(3);
    const itemId = messageId === null
      ? `devin-${kind}:${session.activeTurnId ?? randomUUID()}`
      : `devin-${kind}:${messageId}`;
    this.#setOpenItem(session, key, `id:${itemId}`);
    return itemId;
  }

  async #openAndEmitDelta(
    session: RunningSession,
    itemId: string,
    itemKind: string,
    fact: CodexFact,
  ): Promise<void> {
    if (!session.openItems.has(itemId)) {
      this.#setOpenItem(session, itemId, itemKind);
      await this.#emitNeutral(session, {
        itemId,
        itemKind,
        threadId: session.providerThreadId ?? "",
        turnId: session.activeTurnId ?? "",
        type: "itemStarted",
      });
    }
    await this.#emitNeutral(session, fact);
  }

  async #finishTurn(
    session: RunningSession,
    turnId: string,
    status: CodexTurnStatus,
  ): Promise<void> {
    if (
      session.closeState !== "open"
      || session.activeTurnId !== turnId
      || session.providerThreadId === null
    ) return;
    const completedAt = this.#now();
    for (const [itemId, itemKind] of [...session.openItems]) {
      if (itemKind.startsWith("id:")) continue;
      await this.#emitNeutral(session, {
        itemId,
        itemKind,
        status,
        threadId: session.providerThreadId,
        turnId,
        type: "itemCompleted",
      });
    }
    session.openItems.clear();
    session.assistantItems.clear();
    const startedAt = session.activeTurnStartedAt ?? completedAt;
    session.turnSummaries.push({
      actions: [...session.activeTurnActions],
      completedAt,
      files: [],
      id: turnId,
      omittedActions: session.omittedActiveTurnActions,
      omittedFiles: 0,
      runtimeMs: Math.max(0, completedAt - startedAt),
      startedAt,
      status,
    });
    while (session.turnSummaries.length > PROJECTED_TURN_LIMIT) {
      session.turnSummaries.shift();
      session.droppedTurns += 1;
    }
    session.activeTurnId = undefined;
    session.activeTurnStartedAt = undefined;
    session.activeTurnActions = [];
    session.omittedActiveTurnActions = 0;
    if (session.status !== "terminal") session.status = "idle";
    session.updatedAt = completedAt;
    await this.#emitNeutral(session, {
      threadId: session.providerThreadId,
      turn: {
        completedAt,
        durationMs: Math.max(0, completedAt - startedAt),
        id: turnId,
        items: [],
        startedAt,
        status,
      },
      type: "turnCompleted",
    });
  }

  async #failPrompt(session: RunningSession, turnId: string, error: unknown): Promise<void> {
    if (
      session.closeState !== "open"
      || session.activeTurnId !== turnId
      || session.providerThreadId === null
    ) return;
    const failure = error instanceof DevinError
      ? error
      : new DevinError("PROCESS_EXITED", "The Devin prompt failed.", { cause: error });
    const providerReported = session.promptErrorObserved;
    const terminal = failure.code === "PROCESS_EXITED"
      || failure.code === "PROTOCOL_LIMIT"
      || (failure.code === "PROTOCOL_ERROR" && !providerReported);
    if (!providerReported) {
      await this.#emitNeutral(session, {
        code: `devin_${failure.code.toLowerCase()}`,
        message: sanitizeDevinText(failure.message),
        terminal,
        threadId: session.providerThreadId,
        turnId,
        type: "providerError",
      });
    }
    if (terminal) session.status = "terminal";
    await this.#finishTurn(session, turnId, "failed");
  }

  #appendUserMessage(
    session: RunningSession,
    turnId: string,
    message: string,
    clientMessageId: string,
  ): void {
    if (session.messages.length === 0) {
      session.title = truncateUtf8(sanitizeDevinText(message), PROJECTED_TITLE_BYTES)
        || "Untitled session";
    }
    this.#pushMessage(session, {
      clientId: clientMessageId,
      role: "user",
      turnId,
      ...projectedText(message),
    });
  }

  #appendAssistantDelta(
    session: RunningSession,
    messageId: string | null,
    text: string,
  ): void {
    const key = messageId ?? "current";
    const index = session.assistantItems.get(key);
    const existing = index === undefined ? undefined : session.messages[index];
    if (existing === undefined || existing.role !== "assistant") {
      if (!session.assistantItems.has(key) && session.assistantItems.size >= ASSISTANT_ITEM_LIMIT) {
        throw new DevinError("PROTOCOL_LIMIT", "Devin emitted too many concurrent assistant messages.");
      }
      this.#pushMessage(session, {
        role: "assistant",
        ...(session.activeTurnId === undefined ? {} : { turnId: session.activeTurnId }),
        ...projectedText(text),
      });
      session.assistantItems.set(key, session.messages.length - 1);
      return;
    }
    const next = projectedText(`${existing.text}${text}`);
    const previouslyOmitted = existing.omission?.omittedUtf8Bytes ?? 0;
    const projected = previouslyOmitted === 0 ? next : {
      text: next.text,
      omission: {
        omittedUtf8Bytes: previouslyOmitted + (next.omission?.omittedUtf8Bytes ?? 0),
        originalUtf8Bytes: previouslyOmitted
          + (next.omission?.originalUtf8Bytes ?? encoder.encode(next.text).byteLength),
        returnedUtf8Bytes: encoder.encode(next.text).byteLength,
      },
    };
    if (projected.omission !== undefined && existing.omission === undefined) {
      session.truncatedMessages += 1;
    }
    if (index === undefined) {
      throw new DevinError("PROTOCOL_ERROR", "The Devin message projection lost its item index.");
    }
    session.messages[index] = {
      role: "assistant",
      ...(existing.turnId === undefined ? {} : { turnId: existing.turnId }),
      ...projected,
    };
  }

  #pushMessage(session: RunningSession, message: CodexProjectedMessage): void {
    if (message.omission !== undefined) session.truncatedMessages += 1;
    session.messages.push(message);
    while (session.messages.length > PROJECTED_MESSAGE_LIMIT) {
      session.messages.shift();
      session.droppedMessages += 1;
      for (const [itemId, index] of [...session.assistantItems]) {
        if (index === 0) session.assistantItems.delete(itemId);
        else session.assistantItems.set(itemId, index - 1);
      }
    }
  }

  #setOpenItem(session: RunningSession, key: string, value: string): void {
    if (!session.openItems.has(key) && session.openItems.size >= OPEN_ITEM_LIMIT) {
      throw new DevinError("PROTOCOL_LIMIT", "Devin emitted too many open turn items.");
    }
    session.openItems.set(key, value);
  }

  #projection(session: RunningSession, detail = true): CodexSessionProjection {
    if (session.providerThreadId === null) {
      throw new DevinError("PROTOCOL_ERROR", "An unbound Devin process has no session projection.");
    }
    const base: CodexSessionProjection = {
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: session.updatedAt,
      projectRoot: session.projectRoot,
      status: session.status,
      title: session.title,
      ...(session.activeTurnId === undefined ? {} : { activeTurnId: session.activeTurnId }),
    };
    if (!detail) return base;
    return {
      ...base,
      messages: [...session.messages],
      omission: {
        hasMoreOlderTurns: session.resumed || session.droppedTurns > 0,
        incompleteTurnIds: [],
        omittedMessages: session.droppedMessages,
        returnedTurns: session.turnSummaries.length,
        truncatedMessages: session.truncatedMessages,
        turnLimit: PROJECTED_TURN_LIMIT,
        unreadItemTurnIds: [],
      },
      turnSummaries: [...session.turnSummaries],
    };
  }

  async #emitNeutral(session: RunningSession, fact: CodexFact): Promise<void> {
    if (!session.emitFacts) return;
    await this.#observer.fact(session.authority, {
      ...fact,
      connectionId: session.connectionId,
    });
  }

  #reportInteractionSettled(session: RunningSession, permission: PendingPermission): void {
    const timer = setTimeout(() => {
      void Promise.resolve(this.#observer.fact(session.authority, {
        connectionId: session.connectionId,
        kind: "permission_approval",
        provider: permission.authority,
        type: "interactionResolved",
      })).catch(() => undefined);
    }, 0);
    timer.unref();
  }

  #rememberClosedSession(providerThreadId: string, authority: ProfileAuthority): void {
    this.#closedSessionProofs.delete(providerThreadId);
    this.#closedSessionProofs.set(providerThreadId, { ...authority });
    while (this.#closedSessionProofs.size > CLOSED_SESSION_PROOF_LIMIT) {
      const oldest = this.#closedSessionProofs.keys().next();
      if (oldest.done) return;
      this.#closedSessionProofs.delete(oldest.value);
    }
  }

  #assertLaunchAuthority(authority: ProfileAuthority, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.#assertOpen();
    this.#assertCurrent(authority);
  }

  #assertAccountReadAuthority(authority: ProfileAuthority, signal: AbortSignal): void {
    signal.throwIfAborted();
    this.#assertOpen();
    // A readiness observation may inspect a never-started account without
    // advancing its durable process fence. Session effects still require >0.
    this.#assertCurrent(authority, true);
  }

  #assertNoUnboundChild(): void {
    if (this.#unbound.size > 0) {
      throw new DevinError(
        "PROCESS_EXITED",
        "A prior Devin ACP child is still unjoined; no new session may launch.",
      );
    }
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new DevinError("PROCESS_EXITED", "The Devin runtime manager is closed.");
    }
  }

  #assertCurrent(authority: ProfileAuthority, allowInitialGeneration = false): void {
    if (authority.provider !== this.provider
      || !devinProviderAccountIdSchema.safeParse(authority.providerAccountId).success
      || !Number.isSafeInteger(authority.bindingGeneration)
      || authority.bindingGeneration < 1
      || !Number.isSafeInteger(authority.generation)
      || authority.generation < (allowInitialGeneration ? 0 : 1)
      || !this.#isCurrent(authority)) {
      throw new DevinError("AUTHORITY_STALE", "The Devin account authority changed.");
    }
  }
}
