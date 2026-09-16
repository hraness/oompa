import { createHash, randomUUID } from "node:crypto";

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- D4 extracts the provider port; this file is the Claude adapter and loads the pinned runtime.
import {
  CLAUDE_PIN,
  CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT,
  ClaudeError,
  ClaudeStreamClient,
  IndeterminateClaudeEffectError,
  boundClaudeText,
  claudeSessionArgv,
  readClaudeAuthStatus,
  sanitizeClaudeText,
  spawnBunClaudeProcess,
  parseClaudeProcessIdentity,
  readClaudeAccountProjection,
  resolvePinnedClaudeRuntime,
  withClaudeHostToolRuntime,
  type ClaudeAuthStatusReader,
  type ClaudeCanUseTool,
  type ClaudeFact,
  type ClaudeHostToolBindingAuthority,
  type ClaudeHostToolBindingLease,
  type ClaudeHostToolCall,
  type ClaudeHostToolPublicResult,
  type ClaudeHostToolResponseWritten,
  type ClaudeInteractionDecision,
  type ClaudeProcess,
  type ClaudeProcessIdentity,
  type ClaudeStreamInitialization,
  type PinnedClaudeRuntime,
  type ResolvePinnedClaudeRuntimeOptions,
} from "../claude/index";
import type { OompaHostToolCall } from "../codex/protocol";
import type { PreparedAttachment } from "../domain/attachments";
import { claudeProviderAccountIdSchema } from "../domain/provider-accounts";
import type {
  InteractionKind,
  InteractionResolution,
  LiveInteractionApprovalAuthority,
  ProviderInteractionAuthority,
} from "../domain/interactions";
import {
  assertPresetSupportedByProvider,
  isAdmittedPresetRequirement,
  type Preset,
  type PresetRequirement,
} from "../domain/presets";
import {
  claudeConfigHomeSchema,
  effectiveClaudeRuntimeProfileSchema,
  type ClaudeConfigHome,
  type EffectiveClaudeRuntimeProfile,
} from "../domain/runtime-profile";
import type { ClaudeSessionFact } from "./claude-session-facts";
import {
  ClaudeProcessExitUnprovenError,
  ClaudeSessionObservationError,
} from "./ports";
import type {
  ClaudeRuntimePort,
  ClaudeRuntimeStartReview,
  ClaudeAccountReadinessProjection,
  ClaudeSessionClaimProof,
  CodexAccountProjection,
  CodexProjectedMessage,
  CodexSessionObservation,
  CodexSessionProjection,
  CodexTurnSummary,
  ProfileAuthority,
} from "./ports";

/** Bounds on the in-memory transcript one Claude session projects. */
const PROJECTED_MESSAGE_LIMIT = 256;
const PROJECTED_TURN_LIMIT = 128;
const PROJECTED_MESSAGE_BYTES = 16 * 1024;
const PROJECTED_TITLE_BYTES = 120;
const PROCESS_CONSTRUCTOR_FAILURE_SETTLEMENT_MS = 1_000;
const CLOSED_SESSION_PROOF_LIMIT = 1_024;
const HOST_TOOL_CALL_LIMIT = 256;

const encoder = new TextEncoder();

const processExitSettledWithin = async (
  process: ClaudeProcess,
  milliseconds: number,
): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.then(() => true, () => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** Validates and bounds the durable title supplied when resuming a conversation. */
const projectedTitle = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new ClaudeError("INVALID_INPUT", "A resumed Claude session requires a valid title.");
  }
  return boundClaudeText(
    sanitizeClaudeText(value),
    PROJECTED_TITLE_BYTES,
  ) || "Untitled session";
};

const optionalClientShutdownDuration = (
  value: number | undefined,
  label: string,
): number | undefined => {
  if (
    value !== undefined
    && (!Number.isSafeInteger(value) || value < 1 || value > 30_000)
  ) {
    throw new ClaudeError("INVALID_INPUT", `${label} must be between 1 and 30000 milliseconds`);
  }
  return value;
};

/** Sanitizes and bounds one provider string, reporting what it dropped. */
const projectedText = (value: string): Pick<CodexProjectedMessage, "text" | "omission"> => {
  const safe = sanitizeClaudeText(value, true);
  const originalUtf8Bytes = encoder.encode(safe).byteLength;
  const text = boundClaudeText(safe, PROJECTED_MESSAGE_BYTES);
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

/** One live Claude session: its process, its client, and its projection. */
type RunningSession = {
  authority: ProfileAuthority;
  readonly client: ClaudeStreamClient;
  closeState: "open" | "closing" | "failed";
  readonly connectionId: string;
  readonly providerThreadId: string;
  readonly profile: EffectiveClaudeRuntimeProfile;
  readonly processIdentity: ClaudeProcessIdentity;
  readonly projectRoot: string;
  readonly resumed: boolean;
  readonly hostToolBinding: ClaudeHostToolBindingLease | undefined;
  readonly hostToolCalls: Map<string, RetainedHostToolCall>;
  readonly hostToolCallTombstones: Map<string, string>;
  hostToolActivationTask: Promise<void> | undefined;
  hostToolRevocationTask: Promise<void> | undefined;
  hostToolState: "disabled" | "inactive" | "active" | "revoking" | "revoked";
  status: "active" | "idle" | "terminal";
  activeTurnId: string | undefined;
  title: string;
  updatedAt: number;
  /**
   * The bounded local transcript. Claude Code publishes no thread-read
   * method, so Oompa is the only record of what this session said: the
   * projection every reader sees (`oompa session show`, the compact cloud
   * projection, and the recovery baseline) is assembled here from the same
   * facts the event stream carries.
   */
  readonly messages: CodexProjectedMessage[];
  readonly turnSummaries: CodexTurnSummary[];
  /** Raw assistant text per open item id, flushed into `messages` on delta. */
  readonly assistantItems: Map<string, number>;
  droppedMessages: number;
  droppedTurns: number;
  truncatedMessages: number;
};

type RetainedHostToolCall = Readonly<{
  bindingId: string;
  call: OompaHostToolCall;
  requestDigest: string;
}>;

type UnboundHostToolBinding = Readonly<{
  authority: ProfileAuthority;
  lease: ClaudeHostToolBindingLease;
  providerThreadId: string;
}>;

export type { ClaudeSessionFact } from "./claude-session-facts";

export type ClaudeRuntimeObserver = {
  oompaHostTool?(
    authority: ProfileAuthority,
    call: OompaHostToolCall,
  ): ClaudeHostToolPublicResult | Promise<ClaudeHostToolPublicResult>;
  oompaHostToolResponseWritten?(
    authority: ProfileAuthority,
    call: OompaHostToolCall,
  ): void | Promise<void>;
  fact(authority: ProfileAuthority, fact: ClaudeSessionFact): void | Promise<void>;
};

export type ClaudeRuntimeHostToolConfiguration = Readonly<{
  bindingAuthority: Pick<
    ClaudeHostToolBindingAuthority,
    "activate" | "provision" | "rebind" | "revoke"
  >;
  callbackSocketPath: string;
  privateRoot: string;
}>;

type PendingClaudeReview = {
  readonly review: ClaudeRuntimeStartReview;
  readonly runtime: PinnedClaudeRuntime;
  authority: ProfileAuthority;
  readonly projectRoot: string;
  readonly providerThreadId?: string;
};

export type ClaudeProcessFactory = (input: {
  readonly runtime: PinnedClaudeRuntime;
  readonly argv: readonly [string, ...string[]];
  readonly configDir: string;
  readonly configHome: ClaudeConfigHome;
  readonly projectRoot: string;
  readonly launch: "create" | "resume";
}) => ClaudeProcess;

const METHOD = "claude/control_request/can_use_tool";
const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const INITIALIZATION_FACT_LIMIT = 16;

const requestDigestOf = (requestId: string, request: ClaudeCanUseTool): string =>
  createHash("sha256")
    .update("hra:claude-interaction-authority:v1\0", "utf8")
    .update(JSON.stringify({ requestId, toolUseId: request.toolUseId }), "utf8")
    .digest("hex");

const sameProfileAuthority = (left: ProfileAuthority, right: ProfileAuthority): boolean =>
  left.id === right.id
  && left.generation === right.generation
  && left.provider === right.provider
  && left.providerAccountId === right.providerAccountId
  && left.bindingGeneration === right.bindingGeneration;

const interactionMatchesProfileAuthority = (
  authority: ProfileAuthority,
  interaction: Pick<ProviderInteractionAuthority, "profileId" | "processGeneration" | "provider" | "providerAccountId" | "bindingGeneration">,
): boolean =>
  authority.id === interaction.profileId
  && authority.generation === interaction.processGeneration
  && authority.provider === interaction.provider
  && authority.providerAccountId === interaction.providerAccountId
  && authority.bindingGeneration === interaction.bindingGeneration;

const decisionFor = (
  kind: InteractionKind,
  resolution: InteractionResolution,
  request: ClaudeCanUseTool,
): ClaudeInteractionDecision => {
  if (resolution.kind === "approval_decision") {
    // Claude's control response can only ever grant this one tool use, so a
    // `session`-scoped approval is refused rather than silently narrowed.
    if (resolution.decision === "once") return { kind: "allow" };
    if (resolution.decision === "session") {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        "Claude approvals are granted for one tool use only; session scope is not available.",
      );
    }
    return { kind: "deny", message: "Permission request denied" };
  }
  if (resolution.kind === "user_answers") {
    if (kind !== "user_input") {
      throw new ClaudeError("INVALID_INPUT", "Only a Claude question accepts answers.");
    }
    const answers: Record<string, string> = {};
    for (const [id, value] of Object.entries(resolution.answers)) {
      const first = value.answers[0];
      if (value.answers.length !== 1 || first === undefined) {
        throw new ClaudeError("INVALID_INPUT", "A Claude question takes exactly one answer.");
      }
      answers[id] = first;
    }
    return { answers, kind: "answer" };
  }
  if (resolution.kind === "permission_grant") {
    if (resolution.scope !== null) {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        "Claude permissions are granted for one tool use only; persistent scope is not available.",
      );
    }
    void request;
    return { kind: "allow" };
  }
  throw new ClaudeError("INVALID_INPUT", "Claude has no MCP elicitation to submit.");
};

/**
 * The Claude Code implementation of the provider-neutral session seam. It
 * owns one pinned `claude` process per session under a reviewed configuration
 * home. Isolated mode exports `CLAUDE_CONFIG_DIR`; personal mode deliberately
 * uses Claude's default-home resolution. It translates only through
 * `src/claude`'s fact vocabulary: no Claude wire shape leaves this file.
 */
export class PinnedClaudeRuntimeManager implements ClaudeRuntimePort {
  readonly provider = "claude" as const;
  readonly #isCurrent: (authority: ProfileAuthority) => boolean;
  readonly #observer: ClaudeRuntimeObserver;
  readonly #configDirFor: (authority: ProfileAuthority) => string | Promise<string>;
  readonly #readAuthStatus: ClaudeAuthStatusReader;
  readonly #resolveRuntime: typeof resolvePinnedClaudeRuntime;
  readonly #processFactory: ClaudeProcessFactory;
  readonly #now: () => number;
  readonly #configHome: ClaudeConfigHome;
  readonly #initializationTimeoutMs: number;
  readonly #clientShutdownTermGraceMs: number | undefined;
  readonly #clientShutdownSettlementMs: number | undefined;
  readonly #hostTools: ClaudeRuntimeHostToolConfiguration;
  readonly #sessions = new Map<string, RunningSession>();
  /**
   * Children launched but never admitted as sessions. They are never exposed
   * for reuse, but remain owned until their exact clients prove process exit
   * and output drain. This closes the post-spawn authority-change boundary.
   */
  readonly #unboundClients = new Set<ClaudeStreamClient>();
  /** Provisioned capabilities not yet attached to an admitted live session. */
  readonly #unboundHostToolBindings = new Map<string, UnboundHostToolBinding>();
  /** Same-daemon idempotency only; a restart deliberately has no exit proof. */
  readonly #closedSessionProofs = new Map<string, ProfileAuthority>();
  readonly #reviews = new Map<string, PendingClaudeReview>();
  readonly #startingSessionIds = new Set<string>();
  readonly #initializingClients = new Map<ClaudeStreamClient, string>();
  #resolvedRuntime: PinnedClaudeRuntime | undefined;
  #state: "open" | "closed" = "open";

  constructor(input: {
    isCurrent: (authority: ProfileAuthority) => boolean;
    observer: ClaudeRuntimeObserver;
    /** The reviewed absolute home used by the selected configuration-home mode. */
    configDirFor: (authority: ProfileAuthority) => string | Promise<string>;
    readAuthStatus?: ClaudeAuthStatusReader;
    resolveRuntime?: typeof resolvePinnedClaudeRuntime;
    processFactory?: ClaudeProcessFactory;
    /** Testable bounds forwarded to the exact child client; production uses its defaults. */
    clientShutdownTermGraceMs?: number;
    clientShutdownSettlementMs?: number;
    now?: () => number;
    initializationTimeoutMs?: number;
    /** Truthful authority classification recorded in every runtime review. */
    configHome: ClaudeConfigHome;
    hostTools: ClaudeRuntimeHostToolConfiguration;
  }) {
    this.#isCurrent = input.isCurrent;
    this.#observer = input.observer;
    this.#configDirFor = input.configDirFor;
    this.#readAuthStatus = input.readAuthStatus ?? readClaudeAuthStatus;
    this.#resolveRuntime = input.resolveRuntime ?? resolvePinnedClaudeRuntime;
    this.#processFactory = input.processFactory
      ?? ((launch) => spawnBunClaudeProcess({
        argv: launch.argv,
        configDir: launch.configDir,
        configHome: launch.configHome,
        projectRoot: launch.projectRoot,
      }));
    this.#clientShutdownTermGraceMs = optionalClientShutdownDuration(
      input.clientShutdownTermGraceMs,
      "Claude TERM grace",
    );
    this.#clientShutdownSettlementMs = optionalClientShutdownDuration(
      input.clientShutdownSettlementMs,
      "Claude shutdown settlement",
    );
    this.#now = input.now ?? Date.now;
    this.#configHome = claudeConfigHomeSchema.parse(input.configHome);
    this.#initializationTimeoutMs = input.initializationTimeoutMs
      ?? DEFAULT_INITIALIZATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#initializationTimeoutMs)
      || this.#initializationTimeoutMs < 1
      || this.#initializationTimeoutMs > 60_000
    ) {
      throw new ClaudeError(
        "INVALID_INPUT",
        "Claude initialization timeout must be between 1 and 60000 milliseconds",
      );
    }
    this.#hostTools = input.hostTools;
  }

  pinnedVersion(): string {
    const runtime = this.#resolvedRuntime;
    if (runtime === undefined) {
      throw new ClaudeError("RUNTIME_MISMATCH", "No Claude Code runtime has been admitted yet.");
    }
    return runtime.version;
  }

  /**
   * Preserves an idle Claude process across its exact provider generation
   * rotation without carrying the prior host-tool authority across the CAS.
   * The binding identity moves first, making the intermediate state reject
   * both old- and new-generation callbacks; the session authority moves only
   * after that succeeds.
   */
  rebindProfileAuthority(input: {
    expectedAuthority: ProfileAuthority;
    nextAuthority: ProfileAuthority;
  }): void {
    this.#assertOpen();
    const { expectedAuthority, nextAuthority } = input;
    if (
      expectedAuthority.provider !== "claude"
      || !Number.isSafeInteger(expectedAuthority.generation)
      || expectedAuthority.generation < 1
      || !Number.isSafeInteger(nextAuthority.generation)
      || nextAuthority.generation !== expectedAuthority.generation + 1
      || !this.#sameAuthority({ ...expectedAuthority, generation: nextAuthority.generation }, nextAuthority)
    ) {
      throw new ClaudeError(
        "INVALID_INPUT",
        "A Claude authority rebind must advance exactly one safe generation.",
      );
    }
    this.#assertCurrent(nextAuthority);
    const sessions = [...this.#sessions.values()].filter(
      (session) => session.authority.id === expectedAuthority.id,
    );
    const reviews = [...this.#reviews.values()].filter(
      (review) => review.authority.id === expectedAuthority.id,
    );
    const unbound = [...this.#unboundHostToolBindings.values()].filter(
      (binding) => binding.authority.id === expectedAuthority.id,
    );
    for (const session of sessions) {
      if (
        !this.#sameAuthority(session.authority, expectedAuthority)
        && !this.#sameAuthority(session.authority, nextAuthority)
      ) {
        throw new ClaudeError(
          "AUTHORITY_STALE",
          "A live Claude process belongs to an unexpected account generation.",
        );
      }
      if (session.activeTurnId !== undefined || session.status === "active") {
        throw new ClaudeError(
          "AUTHORITY_STALE",
          "An active Claude turn cannot be rebound to another account generation.",
        );
      }
      if (
        session.closeState !== "open"
        || session.hostToolState === "revoking"
        || session.hostToolState === "revoked"
      ) {
        throw new ClaudeError(
          "AUTHORITY_STALE",
          "Claude session cleanup is unresolved during account generation rotation.",
        );
      }
    }
    for (const review of reviews) {
      if (
        !this.#sameAuthority(review.authority, expectedAuthority)
        && !this.#sameAuthority(review.authority, nextAuthority)
      ) {
        throw new ClaudeError(
          "AUTHORITY_STALE",
          "A Claude runtime review belongs to an unexpected account generation.",
        );
      }
    }
    if (unbound.length > 0) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        "An unadmitted Claude child cannot cross an account generation rotation.",
      );
    }
    for (const session of sessions) {
      if (this.#sameAuthority(session.authority, nextAuthority)) continue;
      if (session.hostToolBinding !== undefined) this.#hostTools.bindingAuthority.rebind(session.hostToolBinding.bindingId, {
        expectedIdentity: {
          processGeneration: session.authority.generation,
          profileId: session.authority.id,
          provider: "claude",
          providerThreadId: session.providerThreadId,
        },
        nextIdentity: {
          processGeneration: nextAuthority.generation,
          profileId: nextAuthority.id,
          provider: "claude",
          providerThreadId: session.providerThreadId,
        },
      });
      session.hostToolCalls.clear();
      session.hostToolCallTombstones.clear();
      session.authority = { ...nextAuthority };
    }
    for (const review of reviews) {
      if (this.#sameAuthority(review.authority, expectedAuthority)) {
        review.authority = { ...nextAuthority };
      }
    }
    const rebound = sessions[0]?.authority ?? reviews[0]?.authority;
    if (rebound !== undefined) this.#assertCurrent(rebound);
  }
  async readAccount(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<ClaudeAccountReadinessProjection> {
    this.#assertAccountReadAuthority(input.authority, input.signal);
    // Directory custody is not an account observation: failures here must stay
    // actionable instead of being flattened into unknown authentication.
    const configDir = await this.#configDirFor(input.authority);
    this.#assertAccountReadAuthority(input.authority, input.signal);
    let readiness: ClaudeAccountReadinessProjection["readiness"];
    try {
      const runtime = await this.#admitRuntime(configDir, input.signal);
      this.#assertAccountReadAuthority(input.authority, input.signal);
      this.#resolvedRuntime = runtime;
      // The pinned parser validates the exact isolated directory and complete
      // bounded status shape, then drops identity and subscription fields.
      const account = this.#configHome === "personal"
        ? await readClaudeAccountProjection({ configDir, configHome: this.#configHome, runtime, signal: input.signal })
        : await this.#readAuthStatus({ configDir, runtime, signal: input.signal });
      readiness = account.signedIn ? "signed_in" : "signed_out";
    } catch (error: unknown) {
      this.#assertAccountReadAuthority(input.authority, input.signal);
      if (!(error instanceof ClaudeError)
        || !["RUNTIME_MISMATCH", "PROTOCOL_ERROR", "PROTOCOL_LIMIT"].includes(error.code)) {
        throw error;
      }
      readiness = "unverified";
    }
    this.#assertAccountReadAuthority(input.authority, input.signal);
    return { observedAt: this.#now(), readiness };
  }

  async readProviderAccountIdentity(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<CodexAccountProjection> {
    this.#assertAccountReadAuthority(input.authority, input.signal);
    const configDir = await this.#configDirFor(input.authority);
    this.#assertAccountReadAuthority(input.authority, input.signal);
    const runtime = await this.#admitRuntime(configDir, input.signal);
    this.#assertAccountReadAuthority(input.authority, input.signal);
    this.#resolvedRuntime = runtime;
    const account = this.#configHome === "personal"
      ? await readClaudeAccountProjection({ configDir, configHome: this.#configHome, runtime, signal: input.signal })
      : await this.#readAuthStatus({ configDir, runtime, signal: input.signal });
    this.#assertAccountReadAuthority(input.authority, input.signal);
    return account;
  }

  async reviewSessionStart(input: {
    authority: ProfileAuthority;
    projectRoot?: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<ClaudeRuntimeStartReview> {
    return await this.#review({ ...input, kind: "session_start" });
  }

  discardRuntimeReview(review: ClaudeRuntimeStartReview): void {
    const pending = this.#reviews.get(review.reviewId);
    if (pending?.review === review) this.#reviews.delete(review.reviewId);
  }

  async reviewTurnStart(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot?: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<ClaudeRuntimeStartReview> {
    return await this.#review({ ...input, kind: "turn_start" });
  }

  async startSession(input: {
    authority: ProfileAuthority;
    hostCapabilities?: "current" | "historical_v1";
    admitProcessIdentity?: (identity: ClaudeProcessIdentity) => Promise<void>;
    projectRoot?: string;
    providerThreadId?: string;
    review: ClaudeRuntimeStartReview;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const hostCapabilityInput: { readonly hostCapabilities?: unknown } = input;
    if (hostCapabilityInput.hostCapabilities !== undefined
      && hostCapabilityInput.hostCapabilities !== "current"
      && hostCapabilityInput.hostCapabilities !== "historical_v1") {
      throw new ClaudeError("INVALID_INPUT", "The session host-capability mode is invalid");
    }
    this.#assertNoUnboundSessionChild();
    const pending = this.#consumeReview(input.review, "session_start", input.authority);
    if (!this.#sameAuthority(pending.authority, input.authority)) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude runtime review belongs to another authority.");
    }
    this.#assertLaunchAuthority(input.authority, input.signal);
    const providerThreadId = input.providerThreadId ?? randomUUID();
    const session = await this.#startPinnedSession({
      authority: input.authority,
      ...(input.admitProcessIdentity === undefined
        ? {}
        : { admitProcessIdentity: input.admitProcessIdentity }),
      launch: "create",
      ...(input.hostCapabilities === "historical_v1" ? { hostTools: "disabled" as const } : {}),
      profile: pending.review.effectiveRuntimeProfile,
      projectRoot: pending.projectRoot,
      providerThreadId,
      runtime: pending.runtime,
      signal: input.signal,
      title: "Untitled session",
    });
    return {
      effectiveRuntimeProfile: session.profile,
      providerThreadId,
      providerUpdatedAt: session.updatedAt,
      status: "idle",
      title: session.title,
      projectRoot: session.projectRoot,
    };
  }

  /**
   * Reclaims a durable Claude conversation only after its external process is
   * proven gone. The new pinned stream owns stdin and therefore has the same
   * interaction and autorespond authority as a session Oompa created itself.
   */
  async claimSession(input: {
    authority: ProfileAuthority;
    hostTools: "required" | "disabled";
    admitProcessIdentity?: (identity: ClaudeProcessIdentity) => Promise<void>;
    providerThreadId: string;
    projectRoot: string;
    title: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    sourceLiveness: ClaudeSessionClaimProof;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }> {
    this.#assertOpen();
    input.signal.throwIfAborted();
    const hostTools: unknown = input.hostTools;
    if (hostTools !== "required" && hostTools !== "disabled") {
      throw new ClaudeError("INVALID_INPUT", "Unknown Claude host-tool admission mode.");
    }
    const sourceLiveness: unknown = input.sourceLiveness;
    if (sourceLiveness !== "not_live") {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        "Claude session takeover requires proof that the source process is not live.",
      );
    }
    const title = projectedTitle(input.title);
    const review = await this.#review({
      authority: input.authority,
      fast: input.fast,
      kind: "session_start",
      preset: input.preset,
      requirement: input.requirement,
      projectRoot: input.projectRoot,
      signal: input.signal,
    });
    const pending = this.#consumeReview(review, "session_start", input.authority);
    const session = await this.#startPinnedSession({
      authority: input.authority,
      ...(input.admitProcessIdentity === undefined
        ? {}
        : { admitProcessIdentity: input.admitProcessIdentity }),
      launch: "resume",
      hostTools: input.hostTools,
      profile: pending.review.effectiveRuntimeProfile,
      projectRoot: pending.projectRoot,
      providerThreadId: input.providerThreadId,
      runtime: pending.runtime,
      signal: input.signal,
      title,
    });
    return {
      effectiveRuntimeProfile: session.profile,
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: session.updatedAt,
      projectRoot: session.projectRoot,
      status: "idle",
      title: session.title,
    };
  }

  async activateSessionHostTools(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.hostToolState === "active") return;
    const binding = session.hostToolBinding;
    if (session.hostToolState === "disabled" || binding === undefined) {
      throw new ClaudeError("AUTHORITY_STALE", "This legacy Claude session has no admitted host tools.");
    }
    if (session.hostToolState === "revoked" || session.hostToolState === "revoking") {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding was revoked.");
    }
    const existingTask = session.hostToolActivationTask;
    if (existingTask !== undefined) {
      await existingTask;
      this.#assertLaunchAuthority(input.authority, input.signal);
      return;
    }
    const task = (async () => {
      await this.#hostTools.bindingAuthority.activate(binding.bindingId);
      if (input.signal.aborted) {
        await this.#revokeSessionHostTools(session);
        input.signal.throwIfAborted();
      }
      if (
        session.closeState !== "open"
        || session.hostToolState !== "inactive"
        || this.#sessions.get(session.providerThreadId) !== session
        || !this.#isCurrent(session.authority)
      ) {
        await this.#revokeSessionHostTools(session);
        throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool binding activation became stale.");
      }
      session.hostToolState = "active";
    })();
    session.hostToolActivationTask = task;
    try {
      await task;
      this.#assertLaunchAuthority(input.authority, input.signal);
    } finally {
      if (session.hostToolActivationTask === task) session.hostToolActivationTask = undefined;
    }
  }

  async #withWriteWitness<T>(
    client: ClaudeStreamClient,
    operation: IndeterminateClaudeEffectError["operation"],
    effect: (onWriteStarted: () => void) => Promise<T>,
  ): Promise<T> {
    const witness = { started: false };
    try {
      return await effect(() => { witness.started = true; });
    } catch (cause: unknown) {
      if (!witness.started) throw cause;
      // The witness names this call's actual stdin boundary, not adapter
      // entry. It remains live through fact delivery and post-write checks.
      client.fenceWrites();
      throw new IndeterminateClaudeEffectError(operation, cause);
    }
  }

  async startTurn(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot?: string;
    review: ClaudeRuntimeStartReview;
    message: string;
    attachments?: readonly PreparedAttachment[];
    clientMessageId: string;
    signal: AbortSignal;
  }): Promise<{
    turnId: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile;
  }> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.hostToolState !== "active" && session.hostToolState !== "disabled") {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host tools are not active for this session.");
    }
    const pending = this.#consumeReview(
      input.review,
      "turn_start",
      input.authority,
      input.providerThreadId,
    );
    if (session.activeTurnId !== undefined) {
      throw new ClaudeError("INVALID_INPUT", "The Claude session already has an active turn.");
    }
    await this.#assertSessionConfig(session, input.signal);
    // Oompa mints the turn id: Claude's own `result` line is the only turn
    // boundary it publishes, and it carries no id of its own.
    const turnId = randomUUID();
    const startAttachments = input.attachments ?? [];
    return await this.#withWriteWitness(session.client, "turn/start", async (onWriteStarted) => {
      await session.client.startTurn({
        ...(startAttachments.length === 0 ? {} : { attachments: startAttachments }),
        message: input.message,
        onWriteStarted,
        turnId,
      });
      this.#appendUserMessage(session, turnId, input.message, input.clientMessageId);
      const activeTurnId = session.client.activeTurnId;
      const summary = session.turnSummaries.find((value) => value.id === turnId);
      if (activeTurnId !== null && activeTurnId !== turnId) {
        throw new ClaudeError("PROTOCOL_ERROR", "Claude turn admission observed another active turn.");
      }
      if (activeTurnId === null && summary === undefined) {
        throw new ClaudeError("PROTOCOL_ERROR", "Claude turn admission lost its exact terminal result.");
      }
      session.activeTurnId = activeTurnId ?? undefined;
      if (session.status !== "terminal") session.status = activeTurnId === null ? "idle" : "active";
      session.updatedAt = this.#now();
      input.signal.throwIfAborted();
      return {
        effectiveRuntimeProfile: pending.review.effectiveRuntimeProfile,
        status: summary?.status ?? "inProgress",
        turnId,
      };
    });
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
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) {
      throw new ClaudeError("INVALID_INPUT", "That Claude turn is no longer active.");
    }
    await this.#assertSessionConfig(session, input.signal);
    await this.#withWriteWitness(session.client, "turn/steer", async (onWriteStarted) => {
      await session.client.steer(input.message, input.attachments ?? [], onWriteStarted);
      this.#appendUserMessage(session, input.activeTurnId, input.message, input.clientMessageId);
      input.signal.throwIfAborted();
    });
  }

  async interrupt(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    activeTurnId: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== input.activeTurnId) return;
    await this.#assertSessionConfig(session, input.signal);
    await this.#withWriteWitness(session.client, "turn/interrupt", async (onWriteStarted) => {
      await session.client.interrupt(onWriteStarted);
      input.signal.throwIfAborted();
    });
  }

  async compact(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    const session = this.#requireSession(input.authority, input.providerThreadId);
    if (session.activeTurnId !== undefined) {
      throw new ClaudeError("INVALID_INPUT", "The Claude session has an active turn; compaction is only admitted between turns.");
    }
    await this.#assertSessionConfig(session, input.signal);
    // `/compact` resolves once the runtime accepted the write; the episode's
    // applied outcome arrives as the provider's own `compaction` fact.
    await this.#withWriteWitness(session.client, "session/compact", async (onWriteStarted) => {
      await session.client.compact(onWriteStarted);
      input.signal.throwIfAborted();
    });
  }

  async observeSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<CodexSessionObservation> {
    input.signal.throwIfAborted();
    const current = this.#sessions.get(input.providerThreadId);
    if (
      current === undefined
      || current.client.state !== "open"
      || current.closeState !== "open"
    ) {
      throw new ClaudeSessionObservationError();
    }
    const session = this.#requireSession(input.authority, input.providerThreadId);
    const observation = {
      connectionId: session.connectionId,
      projection: this.#projection(session),
      resumed: session.resumed,
    };
    input.signal.throwIfAborted();
    return observation;
  }

  async readSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    detail: boolean;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection> {
    input.signal.throwIfAborted();
    const projection = this.#projection(this.#requireSession(input.authority, input.providerThreadId));
    input.signal.throwIfAborted();
    return projection;
  }

  async readSessionProcessIdentity(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<ClaudeProcessIdentity> {
    input.signal.throwIfAborted();
    const session = this.#sessions.get(input.providerThreadId);
    if (session === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude session is not running on this daemon.");
    }
    if (!sameProfileAuthority(session.authority, input.authority)) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude session belongs to another authority.");
    }
    this.#assertCurrent(input.authority);
    // This is cleanup identity, not admission to the client. A failed retained
    // child must remain identifiable so its owner can join endSession before
    // launching a replacement; every execution path still uses #requireSession.
    return session.processIdentity;
  }

  /**
   * Stop the pinned Claude Code process that served one session and forget it.
   * A Claude session is one live process, so leaving a switched-away session
   * running would leak it. An unknown thread is not proof of release: this
   * manager may have restarted while an older foreground child survived.
   */
  async endSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    const session = this.#sessions.get(input.providerThreadId);
    if (session === undefined) {
      const proof = this.#closedSessionProofs.get(input.providerThreadId);
      if (proof !== undefined && this.#sameAuthority(proof, input.authority)) return;
      throw new ClaudeError(
        "PROCESS_EXITED",
        "That Claude session is unknown on this daemon, so its process cleanup cannot be proven.",
      );
    }
    if (!sameProfileAuthority(session.authority, input.authority)) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude session belongs to another authority.");
    }
    this.#assertCurrent(input.authority);
    await this.#closeSession(input.providerThreadId, session);
    input.signal.throwIfAborted();
  }

  /**
   * Synchronous routing probe for the shared callback transport. Callers must
   * require exactly one Claude manager to return true, then invoke only that
   * manager; an authority/protocol rejection is never permission to retry on
   * another manager.
   */
  ownsSessionHostToolBinding(
    call: ClaudeHostToolCall,
  ): boolean {
    const session = this.#sessions.get(call.providerThreadId);
    return this.#state === "open"
      && session !== undefined
      && session.closeState === "open"
      && session.hostToolState === "active"
      && session.hostToolBinding?.bindingId === call.bindingId
      && session.authority.id === call.profileId
      && session.authority.generation === call.processGeneration;
  }

  hasLiveHostToolCall(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    connectionId: string;
    turnId: string;
    callId: string;
    requestDigest: string;
  }): boolean {
    const session = this.#sessions.get(input.providerThreadId);
    const retained = session?.hostToolCalls.get(this.#hostToolCallKey(input.callId));
    return this.#state === "open"
      && session !== undefined
      && sameProfileAuthority(session.authority, input.authority)
      && session.connectionId === input.connectionId
      && session.activeTurnId === input.turnId
      && session.client.activeTurnId === input.turnId
      && session.closeState === "open"
      && session.client.state === "open"
      && session.hostToolState === "active"
      && this.#isCurrent(input.authority)
      && retained !== undefined
      && retained.bindingId === session.hostToolBinding?.bindingId
      && retained.requestDigest === input.requestDigest
      && interactionMatchesProfileAuthority(input.authority, retained.call.authority)
      && retained.call.connectionId === input.connectionId
      && retained.call.threadId === input.providerThreadId
      && retained.call.turnId === input.turnId
      && retained.call.callId === input.callId
      && retained.call.requestDigest === input.requestDigest;
  }

  async handleSessionHostToolCall(call: ClaudeHostToolCall): Promise<ClaudeHostToolPublicResult> {
    const session = await this.#requireHostToolSession(call);
    const key = this.#hostToolCallKey(call.callId);
    const existing = session.hostToolCalls.get(key);
    if (existing !== undefined) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        existing.requestDigest === call.requestDigest
          ? "Claude host-tool call is already pending."
          : "Claude host-tool call id was reused.",
      );
    }
    const completedDigest = session.hostToolCallTombstones.get(key);
    if (completedDigest !== undefined) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        completedDigest === call.requestDigest
          ? "Claude host-tool call was already completed."
          : "Claude host-tool call id was reused.",
      );
    }
    if (
      session.hostToolCalls.size + session.hostToolCallTombstones.size
      >= CLAUDE_HOST_TOOL_SESSION_HISTORY_LIMIT
    ) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool call history is exhausted.");
    }
    if (session.activeTurnId === undefined) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call has no active turn.");
    }
    if (session.hostToolCalls.size >= HOST_TOOL_CALL_LIMIT) {
      throw new ClaudeError("PROTOCOL_LIMIT", "Claude host-tool call retention exceeded its limit.");
    }
    const normalized = this.#normalizeHostToolCall(session, session.activeTurnId, call);
    session.hostToolCalls.set(key, {
      bindingId: call.bindingId,
      call: normalized,
      requestDigest: call.requestDigest,
    });
    try {
      if (this.#observer.oompaHostTool === undefined) {
        throw new ClaudeError("UNSUPPORTED_CAPABILITY", "The Oompa host-tool service is unavailable.");
      }
      return await this.#observer.oompaHostTool(session.authority, normalized);
    } catch (error: unknown) {
      session.hostToolCalls.delete(key);
      this.#rememberHostToolCall(session, key, call.requestDigest);
      throw error;
    }
  }

  async handleSessionHostToolResponseWritten(
    receipt: ClaudeHostToolResponseWritten,
  ): Promise<void> {
    const session = await this.#requireHostToolSession(receipt);
    const key = this.#hostToolCallKey(receipt.callId);
    const retained = session.hostToolCalls.get(key);
    if (
      retained === undefined
      || retained.bindingId !== receipt.bindingId
      || retained.requestDigest !== receipt.requestDigest
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool response receipt is stale.");
    }
    await this.#observer.oompaHostToolResponseWritten?.(session.authority, retained.call);
    session.hostToolCalls.delete(key);
    this.#rememberHostToolCall(session, key, receipt.requestDigest);
  }

  async #requireHostToolSession(call: ClaudeHostToolCall): Promise<RunningSession> {
    const session = this.#sessions.get(call.providerThreadId);
    if (!this.ownsSessionHostToolBinding(call) || session === undefined) {
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool call authority is stale.");
    }
    if (!this.#isCurrent(session.authority)) {
      await this.#closeSession(session.providerThreadId, session);
      throw new ClaudeError("AUTHORITY_STALE", "Claude host-tool account generation changed.");
    }
    return session;
  }

  #normalizeHostToolCall(
    session: RunningSession,
    turnId: string,
    call: ClaudeHostToolCall,
  ): OompaHostToolCall {
    const base = {
      authority: {
        processGeneration: session.authority.generation,
        profileId: session.authority.id,
        provider: "claude" as const,
        providerAccountId: session.authority.providerAccountId,
        bindingGeneration: session.authority.bindingGeneration,
      },
      callId: call.callId,
      connectionId: session.connectionId,
      requestDigest: call.requestDigest,
      requestId: { type: "string" as const, value: call.callId },
      threadId: session.providerThreadId,
      turnId,
    };
    return call.request.tool === "automation_update"
      ? {
          ...base,
          input: call.request.input,
          operation: call.request.input,
          tool: call.request.tool,
        }
      : { ...base, ...call.request };
  }

  #hostToolCallKey(callId: string): string {
    return createHash("sha256")
      .update("hra:claude-runtime-host-call:v1\0", "utf8")
      .update(callId, "utf8")
      .digest("hex");
  }

  #rememberHostToolCall(session: RunningSession, key: string, requestDigest: string): void {
    session.hostToolCallTombstones.set(key, requestDigest);
  }

  /** Widens the runtime-resolution failure into one actionable instruction. */
  async #admitRuntime(configDir: string, signal: AbortSignal): Promise<PinnedClaudeRuntime> {
    signal.throwIfAborted();
    try {
      const runtime = await this.#resolveRuntime({
        configDir,
        configHome: this.#configHome,
        signal,
      } satisfies ResolvePinnedClaudeRuntimeOptions);
      signal.throwIfAborted();
      return runtime;
    } catch (error: unknown) {
      signal.throwIfAborted();
      const detail = error instanceof ClaudeError ? error.message : "it could not be admitted";
      throw new ClaudeError(
        "RUNTIME_MISMATCH",
        `Oompa cannot start a Claude Code session on this machine: ${detail}. `
        + `Install Claude Code ${CLAUDE_PIN} exactly, put \`claude\` on this daemon's PATH, `
        + "then sign in inside the configured Claude profile and retry.",
        { cause: error },
      );
    }
  }

  async inspectInteractionAuthority(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    signal: AbortSignal;
  }): Promise<LiveInteractionApprovalAuthority> {
    input.signal.throwIfAborted();
    const { request } = this.#requirePending(input.authority, input.provider);
    if (input.kind === "command_approval") {
      return {
        additionalPermissions: null,
        availableDecisions: ["once", "decline"],
        command: typeof request.input.command === "string" ? request.input.command : "",
        commandActions: null,
        environmentId: null,
        kind: "command_approval",
        networkApprovalContext: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
        reason: request.description,
        workingDirectory: null,
      };
    }
    if (input.kind === "permission_approval") {
      const session = this.#requireSession(input.authority, input.provider.threadId ?? "");
      return {
        environmentId: null,
        kind: "permission_approval",
        permissions: [request.toolName],
        reason: request.description,
        workingDirectory: session.projectRoot,
      };
    }
    throw new ClaudeError(
      "UNSUPPORTED_CAPABILITY",
      "Only Claude command and permission approvals expose live approval authority.",
    );
  }

  async validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    input.signal.throwIfAborted();
    const { request, session, requestId } = this.#requirePending(input.authority, input.provider);
    const decision = decisionFor(input.kind, input.resolution, request);
    const response = {
      responseDigest: session.client.validateInteractionResolution(requestId, decision).responseDigest,
    };
    input.signal.throwIfAborted();
    return response;
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
    const { request, session, requestId } = this.#requirePending(input.authority, input.provider);
    if (this.#now() > input.deadlineAt) {
      throw new ClaudeError("DEADLINE_EXPIRED", "The Claude interaction deadline passed.");
    }
    await this.#assertSessionConfig(session, input.signal);
    return await this.#withWriteWitness(session.client, "interaction/resolve", async (onWriteStarted) => {
      await session.client.resolveInteraction(
        requestId, decisionFor(input.kind, input.resolution, request), onWriteStarted,
      );
      this.#reportInteractionSettled(session, requestId);
      input.signal.throwIfAborted();
      return { responseWritten: true };
    });
  }

  async validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    input.signal.throwIfAborted();
    const { session, requestId } = this.#requirePending(input.authority, input.provider);
    const response = {
      responseDigest: session.client.validateInteractionResolution(requestId, {
        kind: "deny",
        message: "Oompa did not receive a decision in time",
      }).responseDigest,
    };
    input.signal.throwIfAborted();
    return response;
  }

  async timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    input.signal.throwIfAborted();
    const { session, requestId } = this.#requirePending(input.authority, input.provider);
    await this.#assertSessionConfig(session, input.signal);
    return await this.#withWriteWitness(session.client, "interaction/resolve", async (onWriteStarted) => {
      await session.client.resolveInteraction(requestId, {
        kind: "deny",
        message: "Oompa did not receive a decision in time",
      }, onWriteStarted);
      this.#reportInteractionSettled(session, requestId);
      input.signal.throwIfAborted();
      return { responseWritten: true };
    });
  }

  /**
   * Claude publishes no resolution notification of its own: one control
   * response is the whole exchange. The bridge therefore reports the request
   * as no longer pending, which is the same fact a provider-side cancellation
   * produces, so the daemon can settle its durable interaction row.
   *
   * Codex delivers its equivalent on the notification stream, outside the
   * resolving call. This one is published the same way: the caller still
   * holds that interaction's serialization while it awaits the write, so the
   * fact is handed over after that call returns, never inside it.
   */
  #reportInteractionSettled(session: RunningSession, requestId: string): void {
    const timer = setTimeout(() => {
      void Promise.resolve(this.#onFact(
        session.authority,
        session.providerThreadId,
        session.connectionId,
        {
          requestId,
          type: "interactionCanceled",
        },
      )).catch(() => {
        // The daemon's own fact path records and escalates its failures; a
        // settle notice must never reject into the runtime as an unowned task.
      });
    }, 0);
    timer.unref();
  }

  async close(): Promise<void> {
    this.#state = "closed";
    this.#reviews.clear();
    const settlements = await Promise.allSettled(
      [
        ...[...this.#sessions.entries()].map(async ([providerThreadId, session]) => {
          await this.#closeSession(providerThreadId, session);
        }),
        ...[...this.#unboundClients].map(async (client) => {
          await client.close();
          this.#unboundClients.delete(client);
          const providerThreadId = this.#initializingClients.get(client);
          this.#initializingClients.delete(client);
          if (providerThreadId !== undefined) this.#startingSessionIds.delete(providerThreadId);
        }),
        ...[...this.#unboundHostToolBindings].map(async ([bindingId]) => {
          await this.#hostTools.bindingAuthority.revoke(bindingId);
          this.#unboundHostToolBindings.delete(bindingId);
        }),
      ],
    );
    const failures = settlements.flatMap((settlement) =>
      settlement.status === "rejected" ? [settlement.reason as unknown] : []);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "One or more Claude session children could not be joined, or host-tool binding cleanup remained unresolved during shutdown.",
      );
    }
  }

  /** True for a current owned process whose required tools are active, or explicitly absent on legacy resume. */
  hasLiveSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean {
    const session = this.#sessions.get(input.providerThreadId);
    return this.#state === "open"
      && session !== undefined
      && session.closeState === "open"
      && sameProfileAuthority(session.authority, input.authority)
      && session.status !== "terminal"
      && (session.hostToolState === "active" || session.hostToolState === "disabled")
      && this.#isCurrent(input.authority);
  }

  /** The provider authority one pending `can_use_tool` request binds. */
  interactionAuthority(
    authority: ProfileAuthority,
    providerThreadId: string,
    requestId: string,
  ): ProviderInteractionAuthority {
    const session = this.#requireSession(authority, providerThreadId);
    const pending = session.client.pendingInteraction(requestId);
    if (pending === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude control request is no longer pending.");
    }
    return {
      approvalId: pending.request.toolUseId,
      bindingGeneration: session.authority.bindingGeneration,
      connectionId: session.connectionId,
      itemId: pending.request.toolUseId,
      method: METHOD,
      processGeneration: session.authority.generation,
      provider: session.authority.provider,
      providerAccountId: session.authority.providerAccountId,
      profileId: session.authority.id,
      requestDigest: requestDigestOf(requestId, pending.request),
      requestId: { type: "string", value: requestId },
      threadId: session.providerThreadId,
      turnId: session.activeTurnId ?? null,
    };
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
  }): Promise<ClaudeRuntimeStartReview> {
    this.#assertLaunchAuthority(input.authority, input.signal);
    if (input.kind === "session_start") this.#assertNoUnboundSessionChild();
    // Refuse another provider's preset before touching the runtime at all.
    assertPresetSupportedByProvider("claude", input.preset);
    if (!isAdmittedPresetRequirement(input.preset, input.requirement)) {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        `${input.preset} requested an unadmitted exact Oompa model and reasoning tuple`,
      );
    }
    if (input.fast) {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        "Claude Code has no Oompa fast mode; start the session without `--fast`.",
      );
    }
    const projectRoot = input.projectRoot;
    if (projectRoot === undefined) {
      throw new ClaudeError("INVALID_INPUT", "A Claude session requires a project directory.");
    }
    const configDir = await this.#configDirFor(input.authority);
    this.#assertLaunchAuthority(input.authority, input.signal);
    if (input.kind === "session_start") this.#assertNoUnboundSessionChild();
    const runtime = await this.#admitRuntime(configDir, input.signal);
    this.#assertLaunchAuthority(input.authority, input.signal);
    if (input.kind === "session_start") this.#assertNoUnboundSessionChild();
    if (
      runtime.model !== input.requirement.model
      || runtime.effort !== input.requirement.effort
    ) {
      throw new ClaudeError(
        "UNSUPPORTED_CAPABILITY",
        `${input.preset} requires exactly ${input.requirement.model} with ${input.requirement.effort} reasoning for this account generation`,
      );
    }
    this.#resolvedRuntime = runtime;
    const profile = effectiveClaudeRuntimeProfileSchema.parse({
      claudeVersion: runtime.version,
      inputFormat: "stream-json",
      configHome: this.#configHome,
      model: runtime.model,
      nativeFallback: runtime.nativeFallback,
      observedAt: this.#now(),
      outputFormat: "stream-json",
      permissionMode: "default",
      preset: input.preset,
      processGeneration: input.authority.generation,
      profileId: input.authority.id,
      reasoningEffort: runtime.effort,
    });
    const review: ClaudeRuntimeStartReview = {
      effectiveRuntimeProfile: profile,
      kind: input.kind,
      reviewId: randomUUID(),
    };
    this.#reviews.set(review.reviewId, {
      authority: input.authority,
      projectRoot,
      review,
      runtime,
      ...(input.providerThreadId === undefined ? {} : { providerThreadId: input.providerThreadId }),
    });
    return review;
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

  async #assertSessionConfig(session: RunningSession, signal: AbortSignal): Promise<void> {
    this.#assertLaunchAuthority(session.authority, signal);
    const configDir = await this.#configDirFor(session.authority);
    this.#assertLaunchAuthority(session.authority, signal);
    if (configDir !== session.client.configDir) {
      throw new ClaudeError(
        "CONFIG_DIR_MISMATCH",
        "Claude's isolated config authority changed before provider use.",
      );
    }
  }

  #assertNoUnboundSessionChild(options: Readonly<{ allowBindingId?: string }> = {}): void {
    const unresolvedBinding = [...this.#unboundHostToolBindings.keys()].some(
      (bindingId) => bindingId !== options.allowBindingId,
    );
    if (this.#unboundClients.size > 0 || unresolvedBinding
      || [...this.#sessions.values()].some((session) =>
        session.closeState !== "open" || session.client.state !== "open")) {
      throw new ClaudeError(
        "PROCESS_EXITED",
        "A prior Claude session child is still unjoined or its host-tool binding is unresolved; no new session review or launch is allowed until shutdown joins it.",
      );
    }
  }

  #consumeReview(
    review: ClaudeRuntimeStartReview,
    kind: "session_start" | "turn_start",
    authority: ProfileAuthority,
    providerThreadId?: string,
  ): PendingClaudeReview {
    const pending = this.#reviews.get(review.reviewId);
    this.#reviews.delete(review.reviewId);
    if (pending === undefined || pending.review.kind !== kind) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude runtime review is no longer usable.");
    }
    if (!sameProfileAuthority(pending.authority, authority)
      || pending.providerThreadId !== providerThreadId) {
      throw new ClaudeError("AUTHORITY_STALE", "That Claude runtime review belongs to another authority.");
    }
    if (
      JSON.stringify(pending.review.effectiveRuntimeProfile)
      !== JSON.stringify(review.effectiveRuntimeProfile)
    ) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude runtime review was modified.");
    }
    return pending;
  }

  async #startPinnedSession(input: Readonly<{
    authority: ProfileAuthority;
    admitProcessIdentity?: (identity: ClaudeProcessIdentity) => Promise<void>;
    launch: "create" | "resume";
    hostTools?: "required" | "disabled";
    profile: EffectiveClaudeRuntimeProfile;
    projectRoot: string;
    providerThreadId: string;
    runtime: PinnedClaudeRuntime;
    signal: AbortSignal;
    title: string;
  }>): Promise<RunningSession> {
    this.#assertOpen();
    input.signal.throwIfAborted();
    this.#assertCurrent(input.authority);
    if (
      this.#sessions.has(input.providerThreadId)
      || this.#startingSessionIds.has(input.providerThreadId)
    ) {
      throw new ClaudeError(
        "AUTHORITY_STALE",
        "That Claude session already has a runtime owner on this daemon.",
      );
    }
    this.#startingSessionIds.add(input.providerThreadId);

    let ready = false;
    const initializationFacts: ClaudeFact[] = [];
    let binding: ClaudeHostToolBindingLease | undefined;
    let process: ClaudeProcess | undefined;
    let client: ClaudeStreamClient | undefined;
    let admitted = false;
    try {
      const connectionId = randomUUID();
      const configDir = await this.#configDirFor(input.authority);
      this.#assertLaunchAuthority(input.authority, input.signal);
      this.#assertNoUnboundSessionChild();
      if (input.hostTools !== "disabled") {
        binding = await this.#hostTools.bindingAuthority.provision({
          callbackSocketPath: this.#hostTools.callbackSocketPath,
          identity: {
            processGeneration: input.authority.generation,
            profileId: input.authority.id,
            provider: "claude",
            providerThreadId: input.providerThreadId,
          },
          privateRoot: this.#hostTools.privateRoot,
        });
        this.#unboundHostToolBindings.set(binding.bindingId, {
          authority: input.authority,
          lease: binding,
          providerThreadId: input.providerThreadId,
        });
      }
      this.#assertLaunchAuthority(input.authority, input.signal);
      this.#assertNoUnboundSessionChild(binding === undefined
        ? undefined
        : { allowBindingId: binding.bindingId });
      const hostToolRuntime = binding === undefined
        ? input.runtime
        : withClaudeHostToolRuntime(input.runtime, {
            mcpConfigPath: binding.mcpConfigPath,
          });
      process = this.#processFactory({
        argv: claudeSessionArgv(hostToolRuntime, {
          kind: input.launch,
          providerThreadId: input.providerThreadId,
        }),
        configDir,
        configHome: this.#configHome,
        launch: input.launch,
        projectRoot: input.projectRoot,
        runtime: hostToolRuntime,
      });
      client = new ClaudeStreamClient({
        configDir,
        onFact: (fact) => {
          if (ready) return this.#onFact(input.authority, input.providerThreadId, connectionId, fact);
          if (initializationFacts.length >= INITIALIZATION_FACT_LIMIT) {
            throw new ClaudeError(
              "PROTOCOL_LIMIT",
              "Claude published too many facts before initialization completed.",
            );
          }
          initializationFacts.push(fact);
        },
        process,
        now: this.#now,
        ...(this.#clientShutdownSettlementMs === undefined
          ? {}
          : { shutdownSettlementMs: this.#clientShutdownSettlementMs }),
        ...(this.#clientShutdownTermGraceMs === undefined
          ? {}
          : { shutdownTermGraceMs: this.#clientShutdownTermGraceMs }),
      });
      // Establish custody before any post-spawn await. Failed admission keeps
      // this exact client here until its process exit and output drains prove
      // clean, so another session cannot launch across an ambiguous child.
      this.#unboundClients.add(client);
      this.#initializingClients.set(client, input.providerThreadId);
      const [initialization, processIdentity] = await Promise.all([
        client.waitForInitialization({
          signal: input.signal,
          timeoutMs: this.#initializationTimeoutMs,
        }),
        process.identity.then((value) => parseClaudeProcessIdentity(value)),
      ]);
      this.#assertInitialization(input.providerThreadId, input.runtime, initialization);
      // Let an EOF already queued behind `system/init` fence this admission
      // before the session enters the live map. A later exit is handled by
      // the same client's provider-disconnect path and evicted immediately.
      await Promise.resolve();
      input.signal.throwIfAborted();
      this.#assertOpen();
      this.#assertCurrent(input.authority);
      if (client.state !== "open") {
        throw new ClaudeError(
          "PROCESS_EXITED",
          "Claude exited before its runtime authority could be admitted.",
        );
      }
      const unexpected = initializationFacts.find(
        (fact) => fact.type !== "sessionBootstrapped" && fact.type !== "protocolNotice",
      );
      if (unexpected !== undefined) {
        throw new ClaudeError(
          "PROTOCOL_ERROR",
          "Claude published session activity before its initialization identity was admitted.",
        );
      }
      if (this.#sessions.has(input.providerThreadId)) {
        throw new ClaudeError(
          "AUTHORITY_STALE",
          "That Claude session acquired another runtime owner during initialization.",
        );
      }
      // A caller that owns durable process custody commits the exact PID/start
      // identity before this child becomes addressable in the live session
      // map. If that commit fails, the catch path proves the child closed.
      await input.admitProcessIdentity?.(processIdentity);
      input.signal.throwIfAborted();
      this.#assertOpen();
      this.#assertCurrent(input.authority);
      if (!isClaudeClientOpen(client) || this.#sessions.has(input.providerThreadId)) {
        throw new ClaudeError(
          "AUTHORITY_STALE",
          "Claude authority changed while its exact process identity was admitted.",
        );
      }
      const session: RunningSession = {
        activeTurnId: undefined,
        assistantItems: new Map(),
        authority: input.authority,
        client,
        closeState: "open",
        connectionId,
        droppedMessages: 0,
        droppedTurns: 0,
        hostToolActivationTask: undefined,
        hostToolBinding: binding,
        hostToolCalls: new Map(),
        hostToolCallTombstones: new Map(),
        hostToolRevocationTask: undefined,
        hostToolState: binding === undefined ? "disabled" : "inactive",
        messages: [],
        profile: input.profile,
        processIdentity,
        projectRoot: input.projectRoot,
        providerThreadId: input.providerThreadId,
        resumed: input.launch === "resume",
        status: "idle",
        title: input.title,
        truncatedMessages: 0,
        turnSummaries: [],
        updatedAt: this.#now(),
      };
      this.#closedSessionProofs.delete(input.providerThreadId);
      this.#sessions.set(input.providerThreadId, session);
      if (binding !== undefined) this.#unboundHostToolBindings.delete(binding.bindingId);
      this.#unboundClients.delete(client);
      this.#initializingClients.delete(client);
      admitted = true;
      ready = true;
      return session;
    } catch (error: unknown) {
      const cleanupFailures: unknown[] = [];
      let processExitUnproven = false;
      if (client !== undefined) {
        try {
          await client.close();
          this.#unboundClients.delete(client);
          this.#initializingClients.delete(client);
        } catch (cause: unknown) {
          processExitUnproven = true;
          cleanupFailures.push(cause);
        }
      } else if (process !== undefined) {
        try {
          process.forceTerminate();
        } catch {
          // Settlement below is the authority result.
        }
        const settled = await processExitSettledWithin(
          process,
          this.#clientShutdownSettlementMs ?? PROCESS_CONSTRUCTOR_FAILURE_SETTLEMENT_MS,
        );
        if (!settled) processExitUnproven = true;
      }
      if (binding !== undefined) {
        try {
          await this.#hostTools.bindingAuthority.revoke(binding.bindingId);
          this.#unboundHostToolBindings.delete(binding.bindingId);
        } catch (cause: unknown) {
          cleanupFailures.push(cause);
        }
      }
      if (processExitUnproven) {
        throw new ClaudeProcessExitUnprovenError({
          cause: new AggregateError(
            [error, ...cleanupFailures],
            "Claude admission and cleanup both failed.",
          ),
        });
      }
      if (cleanupFailures.length > 0) {
        throw new AggregateError(
          [error, ...cleanupFailures],
          "Claude admission failed and its host-tool binding cleanup is unresolved.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (client === undefined || admitted || client.state === "closed") {
        this.#startingSessionIds.delete(input.providerThreadId);
        if (client !== undefined) this.#initializingClients.delete(client);
      }
    }
  }

  #assertInitialization(
    providerThreadId: string,
    runtime: PinnedClaudeRuntime,
    initialization: ClaudeStreamInitialization,
  ): void {
    if (initialization.providerSessionId !== providerThreadId) {
      throw new ClaudeError(
        "PROTOCOL_ERROR",
        "Claude initialized a different provider session than Oompa requested.",
      );
    }
    if (
      initialization.claudeVersion !== runtime.version
      || initialization.model !== runtime.model
      || initialization.permissionMode !== "default"
    ) {
      throw new ClaudeError(
        "RUNTIME_MISMATCH",
        "Claude initialized with a different version, model, or permission mode than Oompa reviewed.",
      );
    }
  }

  #requireSession(authority: ProfileAuthority, providerThreadId: string): RunningSession {
    const session = this.#sessions.get(providerThreadId);
    if (session === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude session is not running on this daemon.");
    }
    if (!sameProfileAuthority(session.authority, authority)) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude session belongs to another authority.");
    }
    this.#assertCurrent(authority);
    if (session.closeState !== "open") {
      throw new ClaudeError(
        "PROCESS_EXITED",
        "That Claude session's process cleanup is unresolved on this daemon.",
      );
    }
    if (session.client.state !== "open") {
      throw new ClaudeError("PROCESS_EXITED", "The Claude session process is no longer live.");
    }
    return session;
  }

  async #closeSession(providerThreadId: string, session: RunningSession): Promise<void> {
    if (this.#sessions.get(providerThreadId) === session) session.closeState = "closing";
    const [hostToolCleanup, processCleanup] = await Promise.allSettled([
      this.#revokeSessionHostTools(session),
      session.client.close(),
    ]);
    const settlements = [hostToolCleanup, processCleanup] as const;
    const failures = settlements.flatMap((settlement) =>
      settlement.status === "rejected" ? [settlement.reason as unknown] : []);
    if (failures.length > 0) {
      if (this.#sessions.get(providerThreadId) === session) session.closeState = "failed";
      const hostToolCleanupSucceeded = hostToolCleanup.status === "fulfilled";
      if (hostToolCleanupSucceeded && processCleanup.status === "rejected") {
        // Preserve the provider client's typed TIMEOUT/PROCESS_EXITED custody
        // error when host-tool cleanup added no second failure.
        throw processCleanup.reason;
      }
      throw new AggregateError(
        failures,
        "Claude session process or host-tool binding could not be joined; cleanup was incomplete.",
      );
    }
    // Delete only the exact entry whose process was just proven joined. A
    // concurrent close shares the client's close task, while an impossible id
    // replacement cannot be deleted by the stale closer.
    if (this.#sessions.get(providerThreadId) === session) {
      this.#rememberClosedSession(providerThreadId, session.authority);
      this.#sessions.delete(providerThreadId);
    }
  }

  async #revokeSessionHostTools(session: RunningSession): Promise<void> {
    if (session.hostToolState === "revoked") return;
    const existing = session.hostToolRevocationTask;
    if (existing !== undefined) {
      await existing;
      return;
    }
    session.hostToolState = "revoking";
    session.hostToolCalls.clear();
    session.hostToolCallTombstones.clear();
    const binding = session.hostToolBinding;
    if (binding === undefined) {
      session.hostToolState = "revoked";
      return;
    }
    const task = this.#hostTools.bindingAuthority.revoke(binding.bindingId);
    session.hostToolRevocationTask = task;
    try {
      await task;
      session.hostToolState = "revoked";
    } catch (error: unknown) {
      session.hostToolState = "revoking";
      throw error;
    } finally {
      if (session.hostToolRevocationTask === task) session.hostToolRevocationTask = undefined;
    }
  }

  #rememberClosedSession(providerThreadId: string, authority: ProfileAuthority): void {
    this.#closedSessionProofs.delete(providerThreadId);
    this.#closedSessionProofs.set(providerThreadId, { ...authority });
    while (this.#closedSessionProofs.size > CLOSED_SESSION_PROOF_LIMIT) {
      const oldest = this.#closedSessionProofs.keys().next();
      if (oldest.done === true) return;
      this.#closedSessionProofs.delete(oldest.value);
    }
  }

  #sameAuthority(left: ProfileAuthority, right: ProfileAuthority): boolean {
    return sameProfileAuthority(left, right)
      && left.codexHome === right.codexHome
      && left.desktopUserData === right.desktopUserData;
  }

  #requirePending(
    authority: ProfileAuthority,
    provider: ProviderInteractionAuthority,
  ): Readonly<{ request: ClaudeCanUseTool; requestId: string; session: RunningSession }> {
    if (provider.method !== METHOD || provider.requestId.type !== "string") {
      throw new ClaudeError("PROTOCOL_ERROR", "That authority does not name a Claude tool request.");
    }
    const session = this.#requireSession(authority, provider.threadId ?? "");
    if (!interactionMatchesProfileAuthority(session.authority, provider)) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude interaction authority changed.");
    }
    if (session.connectionId !== provider.connectionId) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude provider connection was replaced.");
    }
    const requestId = provider.requestId.value;
    const pending = session.client.pendingInteraction(requestId);
    if (pending === undefined) {
      throw new ClaudeError("PROTOCOL_ERROR", "That Claude control request is no longer pending.");
    }
    if (requestDigestOf(requestId, pending.request) !== provider.requestDigest) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude control request no longer matches.");
    }
    return { request: pending.request, requestId, session };
  }

  #projection(session: RunningSession, detail = true): CodexSessionProjection {
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
        hasMoreOlderTurns: session.droppedTurns > 0,
        // Every turn Oompa started is proven by its own `user` line and its
        // `result`, so nothing is ever unread or incomplete here.
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

  /** Records one human or steering line, and names the session on its first. */
  #appendUserMessage(
    session: RunningSession,
    turnId: string,
    message: string,
    clientMessageId: string,
  ): void {
    if (!session.resumed && session.messages.length === 0) {
      session.title = projectedTitle(message);
    }
    this.#pushMessage(session, {
      clientId: clientMessageId,
      role: "user",
      turnId,
      ...projectedText(message),
    });
  }

  /** Folds one assistant delta into that item's single projected message. */
  #appendAssistantDelta(
    session: RunningSession,
    turnId: string,
    itemId: string,
    text: string,
  ): void {
    const index = session.assistantItems.get(itemId);
    const existing = index === undefined ? undefined : session.messages[index];
    if (index === undefined || existing === undefined || existing.role !== "assistant") {
      this.#pushMessage(session, { role: "assistant", turnId, ...projectedText(text) });
      session.assistantItems.set(itemId, session.messages.length - 1);
      return;
    }
    const projected = projectedText(`${existing.text}${text}`);
    if (projected.omission !== undefined && existing.omission === undefined) {
      session.truncatedMessages += 1;
    }
    session.messages[index] = { role: "assistant", turnId, ...projected };
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

  #recordTurnSummary(
    session: RunningSession,
    summary: Extract<ClaudeFact, { type: "turnSummary" }>,
  ): void {
    const completedAt = this.#now();
    session.turnSummaries.push({
      actions: [],
      completedAt,
      files: [],
      id: summary.turnId,
      omittedActions: 0,
      omittedFiles: 0,
      runtimeMs: summary.runtimeMs,
      startedAt: Math.max(0, completedAt - summary.runtimeMs),
      status: summary.status,
    });
    while (session.turnSummaries.length > PROJECTED_TURN_LIMIT) {
      session.turnSummaries.shift();
      session.droppedTurns += 1;
    }
  }

  async #onFact(
    authority: ProfileAuthority,
    providerThreadId: string,
    connectionId: string,
    fact: ClaudeFact,
  ): Promise<void> {
    const session = this.#sessions.get(providerThreadId);
    if (
      session === undefined
      || session.connectionId !== connectionId
      || !sameProfileAuthority(session.authority, authority)
      || !this.#isCurrent(authority)
    ) return;
    if (fact.type === "providerDisconnected") {
      session.activeTurnId = undefined;
      session.status = "terminal";
      session.updatedAt = this.#now();
      // Retain the exact client until endSession/manager shutdown proves its
      // process joined and both output streams drained. The disconnect fact
      // fences effects, but is not itself complete release proof.
      session.closeState = "failed";
      // The synchronous state change above already fences callbacks. Revoke
      // the external capability too so a disconnected child cannot retain a
      // usable MCP route while process settlement awaits its owner.
      let revocationFailure: Error | undefined;
      try {
        await this.#revokeSessionHostTools(session);
      } catch (error: unknown) {
        revocationFailure = error instanceof Error
          ? error
          : new ClaudeError("PROTOCOL_ERROR", "Claude host-tool revocation failed");
      }
      await this.#observer.fact(session.authority, { ...fact, connectionId, providerThreadId });
      if (revocationFailure !== undefined) throw revocationFailure;
      return;
    }
    if (fact.type === "assistantDelta") {
      this.#appendAssistantDelta(session, fact.turnId, fact.itemId, fact.text);
    }
    if (fact.type === "turnSummary") this.#recordTurnSummary(session, fact);
    if (fact.type === "turnCompleted") {
      session.activeTurnId = undefined;
      if (session.status !== "terminal") session.status = "idle";
      session.assistantItems.clear();
    }
    if (fact.type === "providerError" && fact.terminal) {
      session.status = "terminal";
      await this.#revokeSessionHostTools(session);
    }
    session.updatedAt = this.#now();
    await this.#observer.fact(session.authority, { ...fact, connectionId, providerThreadId });
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new ClaudeError("PROCESS_EXITED", "The Claude runtime manager is closed.");
    }
  }

  #assertCurrent(authority: ProfileAuthority, allowInitialGeneration = false): void {
    if (authority.provider !== this.provider
      || !claudeProviderAccountIdSchema.safeParse(authority.providerAccountId).success
      || !Number.isSafeInteger(authority.bindingGeneration)
      || authority.bindingGeneration < 1
      || !Number.isSafeInteger(authority.generation)
      || authority.generation < (allowInitialGeneration ? 0 : 1)
      || !this.#isCurrent(authority)) {
      throw new ClaudeError("AUTHORITY_STALE", "The Claude account authority changed.");
    }
  }
}

// Claude's stream can close while an awaited durable-custody callback runs.
// Keep the state read behind a call boundary so TypeScript does not reuse its
// pre-await narrowing as though no asynchronous callback could have changed it.
function isClaudeClientOpen(client: ClaudeStreamClient): boolean {
  return client.state === "open";
}
