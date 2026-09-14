import type { AttachmentManifestEntry, PreparedAttachment } from "../domain/attachments";
import type { Preset, PresetRequirement, Provider } from "../domain/presets";
import type { ProviderAccountId } from "../domain/provider-accounts";
import type {
  EffectiveClaudeRuntimeProfile,
  EffectiveRuntimeProfile,
} from "../domain/runtime-profile";
import type { AccountRateLimitResetOutcome } from "../domain/usage-metrics";
import type { NotificationEmailHostedAuthority } from "../domain/contracts";
import type { CodexTurnStatus } from "../codex/protocol";
import type { CodexPluginCatalog } from "../codex/protocol";
import type {
  InteractionKind,
  InteractionResolution,
  LiveInteractionApprovalAuthority,
  ProviderInteractionAuthority,
} from "../domain/interactions";
import type { ProfileId, ProjectId, SessionId } from "../domain/values";
import type { ClaudeProcessIdentity } from "../claude/process";

export type { ClaudeProcessIdentity } from "../claude/process";

type ProfileAuthorityBase = {
  id: ProfileId;
  generation: number;
  codexHome: string;
  desktopUserData: string;
};

/** Exact provider-account authority required at every live runtime boundary. */
export type ProfileAuthority = ProfileAuthorityBase & {
  provider: Provider;
  providerAccountId: ProviderAccountId;
  bindingGeneration: number;
};

/**
 * The reviewed profile a provider proved before a session or turn may start.
 * It is parameterised only by the profile document each provider reviews;
 * every other field of the seam is provider-neutral.
 */
export type RuntimeStartReviewOf<Profile> = {
  readonly reviewId: string;
  readonly kind: "session_start" | "turn_start";
  readonly effectiveRuntimeProfile: Profile;
};

export type RuntimeStartReview = RuntimeStartReviewOf<EffectiveRuntimeProfile>;

export type ClaudeRuntimeStartReview = RuntimeStartReviewOf<EffectiveClaudeRuntimeProfile>;

export type CodexAccountProjection = {
  signedIn: boolean;
  /** Stable provider account identity when that provider exposes one. */
  accountId?: string;
  email?: string;
  /** Stable provider organization identity when account authority is org-scoped. */
  organizationId?: string;
  plan?: string;
};

/** Bounded Oompa observation; Claude exposes no admitted stable account identity. */
export type ClaudeAccountReadinessProjection = {
  readiness: "signed_in" | "signed_out" | "unverified";
  observedAt: number;
};

export type CodexLoginOutcome =
  | {
      status: "pending";
      loginId: string;
      verificationUrl?: string;
      userCode?: string;
    }
  | {
      status: "signed_in";
      account: CodexAccountProjection & { signedIn: true };
    };

export type ProjectionTextOmission = {
  originalUtf8Bytes: number;
  returnedUtf8Bytes: number;
  omittedUtf8Bytes: number;
};

export type CodexProjectedMessage = {
  role: "user" | "assistant";
  text: string;
  turnId?: string;
  clientId?: string;
  omission?: ProjectionTextOmission;
  /**
   * The bounded manifest of what the human attached to this message: name,
   * declared media type, length, and digest. Never bytes. Absent unless local
   * custody recorded attachments for this message`s client id, so a message
   * without attachments projects exactly as it did before.
   */
  attachments?: readonly AttachmentManifestEntry[];
};

export type CodexTurnSummary = {
  id: string;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  startedAt?: number;
  completedAt?: number;
  runtimeMs?: number;
  files: readonly string[];
  actions: readonly string[];
  omittedFiles: number;
  omittedActions: number;
};

export type CodexProjectionOmission = {
  hasMoreOlderTurns: boolean;
  returnedTurns: number;
  turnLimit: number;
  omittedMessages: number;
  truncatedMessages: number;
  /** Sorted unique recent-turn ids with unread provider items after bounded hydration. */
  unreadItemTurnIds: readonly string[];
  /** Sorted unique completed-turn ids missing exact first-user or final-assistant proof. */
  incompleteTurnIds: readonly string[];
};

export type CodexSessionProjection = {
  providerThreadId: string;
  title: string;
  status: "active" | "idle" | "terminal";
  projectRoot?: string;
  providerUpdatedAt?: number;
  providerTimestampUnit?: "unix_milliseconds_v1";
  activeTurnId?: string;
  messages?: readonly CodexProjectedMessage[];
  turnSummaries?: readonly CodexTurnSummary[];
  omission?: CodexProjectionOmission;
  turns?: readonly unknown[];
};

export type CodexSessionObservation = {
  readonly connectionId: string;
  readonly projection: CodexSessionProjection;
  /** False only when this exact client created the thread and is already subscribed. */
  readonly resumed: boolean;
};

export class CodexSessionObservationError extends Error {
  readonly reason: "resume_unavailable" | "thread_mismatch";

  constructor(reason: CodexSessionObservationError["reason"], options?: ErrorOptions) {
    super(
      reason === "thread_mismatch"
        ? "Codex resumed a different provider thread."
        : "Codex session observation is temporarily unavailable.",
      options,
    );
    this.name = "CodexSessionObservationError";
    this.reason = reason;
  }
}

/**
 * A Codex claim failed after it could have acquired a provider subscription,
 * and neither an exact unsubscribe nor retirement of that connection proved
 * the controller was released. Durable claiming authority must survive this
 * error; every other `claimSession` rejection proves that no controller from
 * the failed attempt remains.
 */
export class CodexClaimReleaseUnprovenError extends Error {
  constructor(options?: ErrorOptions) {
    super("A failed Codex session claim could not prove controller release.", options);
    this.name = "CodexClaimReleaseUnprovenError";
  }
}

export type ClaudeSessionClaimProof = "not_live";

/**
 * Closed signal that a durable Claude conversation has no process in this
 * runtime manager. The daemon may resume only when it independently holds one
 * of `ClaudeSessionClaimProof`'s fenced authorities.
 */
export class ClaudeSessionObservationError extends Error {
  readonly reason = "not_running" as const;

  constructor(options?: ErrorOptions) {
    super("Claude session observation requires a fenced runtime resume.", options);
    this.name = "ClaudeSessionObservationError";
  }
}

/**
 * A Claude admission failed and even force-termination did not prove the
 * spawned child exited. Durable launch intent must survive this error.
 */
export class ClaudeProcessExitUnprovenError extends Error {
  constructor(options?: ErrorOptions) {
    super("Claude session admission failed and child exit could not be proven.", options);
    this.name = "ClaudeProcessExitUnprovenError";
  }
}

export type CodexSessionPage = {
  readonly sessions: readonly CodexSessionProjection[];
  readonly nextCursor: string | null;
};

/**
 * The provider-neutral session seam. Everything a session needs to exist,
 * take turns, be steered, be stopped, and answer a brokered interaction lives
 * here; every provider-specific capability (Codex sign-in, plugins, thread
 * listing) stays on that provider's own port. `Profile` is the reviewed
 * runtime-profile document the provider proves before it runs.
 *
 * D4/W3 seam: Codex and Claude Code each implement this interface,
 * and the daemon selects one per session by the session's recorded provider.
 */
export interface SessionRuntimePort<Profile> {
  readonly provider: Provider;
  reviewSessionStart(input: { authority: ProfileAuthority; projectRoot?: string; preset: Preset; requirement: PresetRequirement; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReviewOf<Profile>>;
  /** Releases a review that never reached its matching start effect. */
  discardRuntimeReview(review: RuntimeStartReviewOf<Profile>): void;
  startSession(input: {
    authority: ProfileAuthority;
    /** Only retained V1 switch evidence selects the frozen launch contract. */
    hostCapabilities?: "current" | "historical_v1";
    /** Persists exact Claude child custody before that child is admitted. */
    admitProcessIdentity?: (identity: ClaudeProcessIdentity) => Promise<void>;
    projectRoot?: string;
    /**
     * An Oompa-reserved provider identity supplied before a Claude child is
     * launched, so crash recovery can recognize an indeterminate launch.
     * Codex allocates its own thread identity and therefore ignores this.
     */
    providerThreadId?: string;
    review: RuntimeStartReviewOf<Profile>;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: Profile }>;
  observeSession(input: { authority: ProfileAuthority; providerThreadId: string; developerInstructions?: string; signal: AbortSignal }): Promise<CodexSessionObservation>;
  readSession(input: { authority: ProfileAuthority; providerThreadId: string; developerInstructions?: string; detail: boolean; signal: AbortSignal }): Promise<CodexSessionProjection>;
  /**
   * Activates a provider-private host-tool channel that was provisioned at
   * launch and kept inert until the matching local session commit succeeded.
   * Providers without a split activation boundary omit this method.
   */
  activateSessionHostTools?(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<void>;
  /**
   * Synchronous post-serialization admission for a provider-originated host
   * call. Callers must treat an absent method or `false` as stale authority.
   * A `true` result is the runtime linearization point: revocation before it
   * is refused, while a call admitted before later revocation may finish.
   */
  hasLiveHostToolCall?(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    connectionId: string;
    turnId: string;
    callId: string;
    requestDigest: string;
  }): boolean;
  /**
   * Release this runtime's hold on one provider thread without deleting it.
   * `oompa session switch` calls it on the provider a session is leaving, so a
   * runtime that owns a per-session process stops that process instead of
   * leaking it. It never destroys the user's thread: a switched-away Codex
   * thread stays exactly where it is on the provider.
   */
  endSession(input: { authority: ProfileAuthority; providerThreadId: string; signal: AbortSignal }): Promise<void>;
  reviewTurnStart(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; preset: Preset; requirement: PresetRequirement; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReviewOf<Profile>>;
  // `attachments` is absent unless the message carried one, so every
  // existing text-only turn reaches the provider byte for byte as before.
  startTurn(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; review: RuntimeStartReviewOf<Profile>; message: string; attachments?: readonly PreparedAttachment[]; clientMessageId: string; signal: AbortSignal }): Promise<{ turnId: string; status: CodexTurnStatus; effectiveRuntimeProfile: Profile }>;
  steer(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; message: string; attachments?: readonly PreparedAttachment[]; clientMessageId: string; signal: AbortSignal }): Promise<void>;
  interrupt(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; signal: AbortSignal }): Promise<void>;
  inspectInteractionAuthority(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    signal: AbortSignal;
  }): Promise<LiveInteractionApprovalAuthority>;
  validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }>;
  resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }>;
  validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }>;
  timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }>;
  close(): Promise<void>;
}

/**
 * The Claude Code implementation of the neutral seam. It adds only what the
 * neutral seam cannot express: the pinned CLI version this machine admitted.
 */
export interface ClaudeRuntimePort extends SessionRuntimePort<EffectiveClaudeRuntimeProfile> {
  readonly provider: "claude";
  readAccount(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<ClaudeAccountReadinessProjection>;
  /** Optional exact identity proof; adoption refuses when the runtime cannot provide it. */
  readProviderAccountIdentity?(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<CodexAccountProjection>;
  /**
   * Reclaims an existing Claude conversation under this runtime's full stdin
   * and interaction authority. Callers may supply the closed liveness proof
   * only after the prior process is known not to be live.
   */
  claimSession(input: {
    authority: ProfileAuthority;
    /** Every reclaim explicitly proves whether its durable row admits Oompa tools. */
    hostTools: "required" | "disabled";
    /** Persists exact child custody before the resumed process is admitted. */
    admitProcessIdentity?: (identity: ClaudeProcessIdentity) => Promise<void>;
    providerThreadId: string;
    projectRoot: string;
    /** Durable display title retained across takeover and daemon restart. */
    title: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    sourceLiveness: ClaudeSessionClaimProof;
    signal: AbortSignal;
  }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }>;
  /** Exact live child authority retained for durable restart liveness fencing. */
  readSessionProcessIdentity(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    signal: AbortSignal;
  }): Promise<ClaudeProcessIdentity>;
  pinnedVersion(): string;
  /**
   * Rekeys idle live Claude sessions and their private host-tool bindings
   * after the durable provider-generation commit. Active or ambiguously
   * retained children are rejected rather than carried across authority.
   */
  rebindProfileAuthority(input: {
    expectedAuthority: ProfileAuthority;
    nextAuthority: ProfileAuthority;
  }): void;
  /** Current-daemon execution authority used before scheduled work becomes durable. */
  hasLiveSession?(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean;
  /**
   * The exact durable authority one pending Claude control request binds.
   * Codex publishes its own request authority on the notification; Claude's
   * control request carries only an id, so the daemon asks the port for it.
   */
  interactionAuthority(
    authority: ProfileAuthority,
    providerThreadId: string,
    requestId: string,
  ): ProviderInteractionAuthority;
}

export interface CodexRuntimePort extends SessionRuntimePort<EffectiveRuntimeProfile> {
  readonly provider: "codex";
  /**
   * Explicitly retries custody of a personal-home thread. Unlike ordinary
   * observation, one retained determinate resume refusal may be invalidated
   * so a later adoption poll can acquire a thread its prior controller freed.
   */
  claimSession?(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<CodexSessionObservation & { effectiveRuntimeProfile: EffectiveRuntimeProfile }>;
  login(input: { authority: ProfileAuthority; method: "browser" | "device_code"; signal: AbortSignal }): Promise<CodexLoginOutcome>;
  cancelLogin(input: { authority: ProfileAuthority; loginId: string; signal: AbortSignal }): Promise<{ status: "canceled" | "not_found" }>;
  logout(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<void>;
  /**
   * Retire an already-running exact account generation without discovering,
   * launching, resuming, or releasing any individual provider thread.
   */
  releaseOwnedAuthority?(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<void>;
  readAccount(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<CodexAccountProjection>;
  readUsage(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<{ revision: number; observedAt: number; payload: unknown }>;
  consumeRateLimitReset(input: {
    authority: ProfileAuthority;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<AccountRateLimitResetOutcome>;
  listPlugins(input: { authority: ProfileAuthority; projectRoot?: string; forceRefetch: boolean; signal: AbortSignal }): Promise<CodexPluginCatalog>;
  listSessions(input: {
    authority: ProfileAuthority;
    limit: number;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<CodexSessionPage>;
  /**
   * Reads one exact thread's bounded metadata without resuming, subscribing,
   * or creating session observation authority. Personal discovery uses this
   * only to reach scheduled-task targets outside recency-sorted list pages.
   */
  readSessionMetadata?(
    authority: ProfileAuthority,
    providerThreadId: string,
    signal: AbortSignal,
  ): Promise<CodexSessionProjection>;
  rename(input: { authority: ProfileAuthority; providerThreadId: string; name: string; signal: AbortSignal }): Promise<void>;
  inspectTurn(input: { authority: ProfileAuthority; providerThreadId: string; turnId: string; signal: AbortSignal }): Promise<unknown>;
  inspectInteractionAuthority(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    signal: AbortSignal;
  }): Promise<LiveInteractionApprovalAuthority>;
  validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }>;
  resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }>;
  validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }>;
  timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }>;
  close(): Promise<void>;
}

export interface CloudControlPort {
  status(signal: AbortSignal): Promise<unknown>;
  sync(signal: AbortSignal): Promise<unknown>;
  observeAttentionNotificationAuthority?(
    signal: AbortSignal,
  ): Promise<NotificationEmailHostedAuthority>;
  invalidateAttentionNotificationAuthority?(input: {
    localNotificationPolicyRevision: number;
    signal: AbortSignal;
  }): Promise<Extract<
    NotificationEmailHostedAuthority,
    { state: "acknowledged" | "not_observed" | "revocation_pending" }
  >>;
  isCompactProjectionRecoveryUnsettledForProfile(profileId: ProfileId): Promise<boolean>;
  isCompactProjectionRecoveryUnsettled(sessionPublicId: SessionId): Promise<boolean>;
  supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId: SessionId): Promise<{ superseded: boolean }>;
  supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }>;
  readCompactProjectionRecoveryReceipt?(input: {
    sessionPublicId: SessionId;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<
    | Readonly<{ status: "absent" | "conflict" }>
    | Readonly<{ status: "found"; result: unknown }>
  >;
  recoverCompactProjection(input: { sessionPublicId: SessionId; idempotencyKey: string; acknowledgeGap: true; signal: AbortSignal }): Promise<unknown>;
  auth(input: { email: string; code?: string; invite?: string; signal: AbortSignal }): Promise<unknown>;
  logout(signal: AbortSignal): Promise<void>;
  deleteAccount(input: { acknowledgeErasure: boolean; signal: AbortSignal }): Promise<unknown>;
  listDevices(signal: AbortSignal): Promise<unknown>;
  pairDevice(signal: AbortSignal): Promise<unknown>;
  acknowledgeNoAccountKeyHolders(signal: AbortSignal): Promise<unknown>;
  approveDevice(device: string, idempotencyKey: string, fingerprint: string, signal: AbortSignal): Promise<unknown>;
  revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown>;
}

export type CompactProjectionRecoveryBlocker = Pick<
  CloudControlPort,
  | "isCompactProjectionRecoveryUnsettled"
  | "isCompactProjectionRecoveryUnsettledForProfile"
  | "supersedeCompactProjectionRecoveryForProviderDeletion"
  | "supersedeTerminalCompactProjectionRecoveries"
> & Pick<CloudControlPort, "readCompactProjectionRecoveryReceipt">;

export class UnavailableCodexRuntime implements CodexRuntimePort {
  readonly provider = "codex" as const;
  #unavailable(): never { throw new Error("The Codex runtime is unavailable on this machine."); }
  login(): Promise<never> { return Promise.reject(this.#unavailable()); }
  cancelLogin(): Promise<never> { return Promise.reject(this.#unavailable()); }
  logout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  async releaseOwnedAuthority(): Promise<void> {}
  readAccount(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readUsage(): Promise<never> { return Promise.reject(this.#unavailable()); }
  consumeRateLimitReset(): Promise<never> { return Promise.reject(this.#unavailable()); }
  listPlugins(): Promise<never> { return Promise.reject(this.#unavailable()); }
  listSessions(): Promise<never> { return Promise.reject(this.#unavailable()); }
  claimSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  reviewSessionStart(): Promise<never> { return Promise.reject(this.#unavailable()); }
  discardRuntimeReview(): void {}
  startSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  observeSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  endSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  reviewTurnStart(): Promise<never> { return Promise.reject(this.#unavailable()); }
  startTurn(): Promise<never> { return Promise.reject(this.#unavailable()); }
  steer(): Promise<never> { return Promise.reject(this.#unavailable()); }
  interrupt(): Promise<never> { return Promise.reject(this.#unavailable()); }
  rename(): Promise<never> { return Promise.reject(this.#unavailable()); }
  inspectTurn(): Promise<never> { return Promise.reject(this.#unavailable()); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unavailable()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unavailable()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unavailable()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unavailable()); }
  async close(): Promise<void> {}
}

/**
 * A provider runtime this machine cannot run at all. It is distinct from a
 * transient provider fault: the daemon reports its message verbatim so the
 * operator is told exactly what to install.
 */
export class ProviderRuntimeUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderRuntimeUnavailableError";
  }
}

/**
 * The default Claude seam on a machine with no admitted `claude` binary. A
 * session that names the Claude provider is refused with one clear message
 * instead of silently falling back to another provider.
 */
export class UnavailableClaudeRuntime implements ClaudeRuntimePort {
  readonly provider = "claude" as const;
  readonly #pinnedVersion: string;

  /** `pinnedVersion` is the exact `CLAUDE_PIN` this build admits. */
  constructor(pinnedVersion: string) {
    this.#pinnedVersion = pinnedVersion;
  }

  #unavailable(): never {
    throw new ProviderRuntimeUnavailableError(
      `This daemon has no Claude Code runtime. Install Claude Code ${this.#pinnedVersion} exactly, `
      + "put `claude` on this daemon's PATH, restart the daemon with `oompa daemon restart`, then sign in "
      + "inside the account's isolated Claude profile.",
    );
  }
  interactionAuthority(): ProviderInteractionAuthority { return this.#unavailable(); }
  hasLiveSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean {
    void input;
    return false;
  }
  activateSessionHostTools(): Promise<never> { return Promise.reject(this.#unavailable()); }
  pinnedVersion(): string { return this.#unavailable(); }
  rebindProfileAuthority(input: {
    expectedAuthority: ProfileAuthority;
    nextAuthority: ProfileAuthority;
  }): void {
    void input;
  }
  claimSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readSessionProcessIdentity(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readAccount(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readProviderAccountIdentity(): Promise<never> { return Promise.reject(this.#unavailable()); }
  reviewSessionStart(): Promise<never> { return Promise.reject(this.#unavailable()); }
  discardRuntimeReview(): void {}
  startSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  observeSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  readSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  endSession(): Promise<never> { return Promise.reject(this.#unavailable()); }
  reviewTurnStart(): Promise<never> { return Promise.reject(this.#unavailable()); }
  startTurn(): Promise<never> { return Promise.reject(this.#unavailable()); }
  steer(): Promise<never> { return Promise.reject(this.#unavailable()); }
  interrupt(): Promise<never> { return Promise.reject(this.#unavailable()); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unavailable()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unavailable()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unavailable()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unavailable()); }
  async close(): Promise<void> {}
}

export class UnavailableCloudControl implements CloudControlPort {
  readonly #projectionRecoveryBlocker: CompactProjectionRecoveryBlocker;

  constructor(projectionRecoveryBlocker: CompactProjectionRecoveryBlocker) {
    this.#projectionRecoveryBlocker = projectionRecoveryBlocker;
  }

  #unavailable(): never { throw new Error("Cloud sync is not configured. Run `oompa auth login` first."); }
  status(): Promise<unknown> { return Promise.resolve({ configured: false, signedIn: false }); }
  sync(): Promise<never> { return Promise.reject(this.#unavailable()); }
  isCompactProjectionRecoveryUnsettledForProfile(profileId: ProfileId): Promise<boolean> {
    return this.#projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettledForProfile(profileId);
  }
  isCompactProjectionRecoveryUnsettled(sessionPublicId: SessionId): Promise<boolean> {
    return this.#projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettled(sessionPublicId);
  }
  supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: SessionId,
  ): Promise<{ superseded: boolean }> {
    return this.#projectionRecoveryBlocker
      .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
  }
  supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    return this.#projectionRecoveryBlocker.supersedeTerminalCompactProjectionRecoveries();
  }
  readCompactProjectionRecoveryReceipt(
    input: Parameters<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>>[0],
  ): ReturnType<NonNullable<CloudControlPort["readCompactProjectionRecoveryReceipt"]>> {
    return this.#projectionRecoveryBlocker.readCompactProjectionRecoveryReceipt?.(input)
      ?? Promise.resolve({ status: "absent" });
  }
  recoverCompactProjection(): Promise<never> { return Promise.reject(this.#unavailable()); }
  auth(): Promise<never> { return Promise.reject(this.#unavailable()); }
  logout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  deleteAccount(): Promise<never> { return Promise.reject(this.#unavailable()); }
  listDevices(): Promise<never> { return Promise.reject(this.#unavailable()); }
  pairDevice(): Promise<never> { return Promise.reject(this.#unavailable()); }
  acknowledgeNoAccountKeyHolders(): Promise<never> {
    return Promise.reject(this.#unavailable());
  }
  approveDevice(
    device: string,
    idempotencyKey: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<never> {
    void device;
    void idempotencyKey;
    void fingerprint;
    void signal;
    return Promise.reject(this.#unavailable());
  }
  revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<never> {
    void device;
    void idempotencyKey;
    void signal;
    return Promise.reject(this.#unavailable());
  }
}

export type SessionProjectUpdate = { sessionId: SessionId; projectId: ProjectId | null };
