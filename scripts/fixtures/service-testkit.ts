import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { canonical40QueuesDatabaseBytes } from "./canonical40-queues";
import { canonical39DevinDatabaseBytes, canonical39DevinFixture } from "./canonical39-devin";
import { canonical39RetiredDatabaseBytes } from "./canonical39-retired-effects";
import { canonical39RetiredRecoveryDatabaseBytes, type Canonical39RetiredRecoveryScenario } from "./canonical39-retired-recovery";
import { canonical39RetiredTargetDatabaseBytes, type Canonical39RetiredTargetScenario } from "./canonical39-retired-targets";
import { canonical39AttachmentDatabaseBytes, type Canonical39AttachmentScenario } from "./canonical39-attachments";
import { canonicalSessionStartDatabaseBytes, type CanonicalSessionStartScenario } from "./canonical-session-start";
import type { CodexAutomationAuthorityRequest, CodexAutomationAuthorityScan, CodexFact, OompaHostToolCall, CodexPluginCatalog } from "../../src/codex";
import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../../src/claude/pin";
import { DEVIN_PIN } from "../../src/devin/pin";
import type { CloudProjectionRecoveryAdmissionError } from "../../src/cloud/contracts";
import type { AccountKeyLossPreconditionError } from "../../src/cloud/local-control";
import { renderSuccess } from "../../src/cli/render";
import type { LocalCommand, NotificationEmailHostedAuthority } from "../../src/domain/contracts";
import type { InteractionRecord, ProviderInteractionAuthority } from "../../src/domain/interactions";
import type { PreparedAttachment } from "../../src/domain/attachments";
import type { EffectiveClaudeRuntimeProfile, EffectiveRuntimeProfile } from "../../src/domain/runtime-profile";
import { initializeStatePaths, resolveStatePaths } from "../../src/storage/paths";
import type { GatewayKeyPort } from "../../src/storage/gateway-key-custody";
import { StateStore, type SecurityScrubCheckpointPolicy, type SessionRecord } from "../../src/storage/state-store";
import { provisionMigratedStateTemplate } from "./migrated-state-template";
import type { ProseResponder } from "../../src/daemon/prose-responder";
import { DaemonAuthoritySafetyError } from "../../src/daemon/daemon-lock";
import type { OompaFactsMemoryLifecyclePort, OompaFactsMemoryLifecycleReceipt } from "../../src/daemon/facts-memory-lifecycle";
import { ClaudeSessionObservationError, UnavailableClaudeRuntime, type ClaudeProcessIdentity, type ClaudeRuntimePort, type ClaudeRuntimeStartReview, type CloudControlPort, type CodexAccountProjection, type CodexLoginOutcome, type CodexRuntimePort, type CodexSessionObservation, type CodexSessionProjection, type CompactProjectionRecoveryBlocker, type DevinRuntimePort, type ProfileAuthority, type RuntimeStartReview } from "../../src/daemon/ports";
import type { ClaudeProcessLivenessProbe, DiscoveredPersonalSession, PersonalSessionDiscoveryPort } from "../../src/daemon/personal-session-discovery";
import type { OompaMemoryPort, OompaMemoryRefusalCode } from "../../src/daemon/memory-coordinator";
import { SessionEventCursorCodec } from "../../src/daemon/session-event-cursor";
import { OompaService } from "../../src/daemon/service";

export const privatePathRoot = ["", "Users", "private"].join("/");

export const codexProviderAccountKey = (email = "person@example.com"): string =>
  `v1:codex:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;

export const claudeProviderAccountKey = (identity = "claude-test-account"): string =>
  `v1:claude:${createHash("sha256").update(identity).digest("hex")}`;

export const MANAGED_CODEX_HOST_TOOL_PROVENANCE = {
  provider: "codex",
  source: "managed",
} as const;

export const runtimeProfile = (authority: ProfileAuthority): EffectiveRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset: "high",
  model: "gpt-6-astra",
  reasoningEffort: "max",
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request",
  reviewMode: "auto_review",
  permissionProfile: ":workspace",
  computerUse: true,
  pluginCapability: true,
  enabledApps: [{ id: "app.files", name: "Files", pluginDisplayNames: ["Files"] }],
});

export class FakeCodex implements CodexRuntimePort {
  readonly provider = "codex" as const;
  discardRuntimeReview(): void {}
  readonly calls: string[] = [];
  readonly releasedAuthorities: ProfileAuthority[] = [];
  readonly retiredAuthorityKeys = new Set<string>();
  readonly observedThreads: string[] = [];
  readonly freshThreads = new Set<string>();
  readonly turnEffectTrace: string[] = [];
  readonly startTurnAttachments: {
    attachments?: readonly PreparedAttachment[];
    clientMessageId: string;
  }[] = [];
  readonly steerAttachments: {
    attachments?: readonly PreparedAttachment[];
    clientMessageId: string;
  }[] = [];
  beforeObserveReturn?: () => Promise<void>;
  observeError?: Error;
  observeErrorOnce?: Error;
  observationConnectionId = "30000000-0000-4000-8000-000000000001";
  liveHostToolCall = true;
  readonly liveHostToolCallRequests: Array<Parameters<NonNullable<
    CodexRuntimePort["hasLiveHostToolCall"]
  >>[0]> = [];
  observationThreadIdOverride?: string;
  activeObservations = 0;
  maximumConcurrentObservations = 0;
  beforeStartTurnEffect?: () => Promise<void>;
  beforeStartTurnReturn?: () => Promise<void>;
  beforeReadSessionReturn?: () => Promise<void>;
  beforeReviewTurnStartReturn?: () => Promise<void>;
  readSessionErrorOnce?: Error;
  reviewTurnErrorOnce?: Error;
  beforeLogoutReturn?: () => Promise<void>;
  logoutError?: Error;
  beforeReleaseOwnedAuthorityReturn?: () => Promise<void>;
  startSessionError?: Error;
  startTurnError?: Error;
  startTurnErrorOnce?: Error;
  steerError?: Error;
  interruptError?: Error;
  renameError?: Error;
  beforeInterruptReturn?: () => Promise<void>;
  beforeRenameReturn?: () => Promise<void>;
  turnId = "turn-next";
  turnStatus: "completed" | "interrupted" | "failed" | "inProgress" = "inProgress";
  committedStartTurns = 0;
  activeStartTurns = 0;
  maximumConcurrentStartTurns = 0;
  runtimeProfileOverride?: EffectiveRuntimeProfile;
  claimRuntimeProfileOverride?: EffectiveRuntimeProfile;
  closeError?: Error;
  closeCalls = 0;
  resolveInteractionError?: Error;
  beforeResolveInteractionReturn?: () => Promise<void>;
  beforeTimeoutInteractionReturn?: () => Promise<void>;
  validateInteractionResolutionError?: Error;
  beforeValidateInteractionResolutionReturn?: () => Promise<void>;
  validateInteractionTimeoutError?: Error;
  timeoutInteractionError?: Error;
  readonly validatedInteractions: Array<Parameters<CodexRuntimePort["validateInteractionResolution"]>[0]> = [];
  readonly resolvedInteractions: Array<Parameters<NonNullable<CodexRuntimePort["resolveInteraction"]>>[0]> = [];
  readonly validatedInteractionTimeouts: Array<Parameters<CodexRuntimePort["validateInteractionTimeout"]>[0]> = [];
  readonly timedOutInteractions: Array<Parameters<CodexRuntimePort["timeoutInteraction"]>[0]> = [];
  readonly inspectedInteractions: Array<Parameters<CodexRuntimePort["inspectInteractionAuthority"]>[0]> = [];
  beforeInspectInteractionReturn?: () => Promise<void>;
  interactionAuthority: Awaited<ReturnType<CodexRuntimePort["inspectInteractionAuthority"]>> = {
    kind: "command_approval",
    command: "git status --short",
    reason: null,
    availableDecisions: ["accept", "decline", "cancel"],
    workingDirectory: "/workspace",
    environmentId: null,
    commandActions: null,
    networkApprovalContext: null,
    additionalPermissions: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  };
  accountProjection: CodexAccountProjection = { signedIn: true, email: "person@example.com", plan: "Plus" };
  usageResult: { revision: number; observedAt: number; payload: unknown } = { revision: 1, observedAt: 2_000, payload: { primary: { usedPercent: 25 } } };
  readonly usageResults: Array<{ revision: number; observedAt: number; payload: unknown }> = [];
  readonly readAccountAuthorities: ProfileAuthority[] = [];
  readonly readUsageAuthorities: ProfileAuthority[] = [];
  usageError: Error | undefined;
  beforeReadUsageReturn?: (input: Parameters<CodexRuntimePort["readUsage"]>[0]) => Promise<void>;
  resetOutcome: "reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit" = "reset";
  resetError: Error | undefined;
  beforeResetReturn?: () => Promise<void>;
  readonly resetIdempotencyKeys: string[] = [];
  readonly pluginRequests: Array<Parameters<CodexRuntimePort["listPlugins"]>[0]> = [];
  pluginCatalog: CodexPluginCatalog = {
    marketplaces: [{
      name: "official",
      displayName: "Official",
      plugins: [{
        id: "files@official",
        name: "files",
        displayName: "Files",
        shortDescription: "Search connected files",
        developerName: "OpenAI",
        category: "productivity",
        capabilities: ["search"],
        keywords: ["files"],
        version: "1.0.0",
        localVersion: null,
        sourceType: "remote",
        installed: false,
        enabled: false,
        installPolicy: "AVAILABLE",
        authPolicy: "ON_USE",
        availability: "AVAILABLE",
        disabledReason: null,
        eligiblePlanTypes: ["plus"],
      }],
    }],
    featuredPluginIds: ["files@official"],
    marketplaceLoadErrorCount: 0,
    lifecycle: {
      discovery: "available",
      install: "blocked_compound_upstream_effect",
      enablement: "no_separate_pinned_method",
      oauth: "separate_foreground_only",
    },
  };
  readProjection: CodexSessionProjection = {
    providerThreadId: "provider-thread",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 10,
    messages: [{ role: "user", text: "hello" }, { role: "assistant", text: "hi" }],
    omission: {
      hasMoreOlderTurns: false,
      incompleteTurnIds: [],
      omittedMessages: 0,
      returnedTurns: 1,
      truncatedMessages: 0,
      turnLimit: 20,
      unreadItemTurnIds: [],
    },
  };
  listedProjections: readonly CodexSessionProjection[] = [];
  listedNextCursor: string | null = null;
  readonly sessionListRequests: Array<Parameters<CodexRuntimePort["listSessions"]>[0]> = [];
  readonly metadataReadRequests: Array<Readonly<{
    authority: ProfileAuthority;
    providerThreadId: string;
  }>> = [];
  beforeListSessionsReturn?: () => Promise<void> | void;
  claimError?: Error;
  claimErrorForProviderThreadId?: (providerThreadId: string) => Error | undefined;
  readonly claimRequests: Array<
    Parameters<NonNullable<CodexRuntimePort["claimSession"]>>[0]
  > = [];
  beforeClaimSessionReturnOnce?: () => Promise<void>;
  readonly sessionReviewRequests: Array<Parameters<CodexRuntimePort["reviewSessionStart"]>[0]> = [];
  readonly turnReviewRequests: Array<Parameters<CodexRuntimePort["reviewTurnStart"]>[0]> = [];
  loginResult: CodexLoginOutcome = { status: "signed_in", account: { signedIn: true, email: "person@example.com", plan: "Plus" } };
  cancelLoginResult: { status: "canceled" | "not_found" } = { status: "canceled" };
  beforeLoginReturn?: (input: { authority: ProfileAuthority; method: "browser" | "device_code" }) => Promise<void>;
  beforeCancelLoginReturn: (() => Promise<void>) | undefined = undefined;
  beforeReadAccountReturn?: (input: Parameters<CodexRuntimePort["readAccount"]>[0]) => Promise<void>;
  #authorityKey(authority: ProfileAuthority): string {
    return `${authority.provider}:${authority.providerAccountId}:${authority.bindingGeneration}:${authority.id}:${String(authority.generation)}`;
  }
  retireAuthority(authority: ProfileAuthority): void {
    this.retiredAuthorityKeys.add(this.#authorityKey(authority));
  }
  async login(input: { authority: ProfileAuthority; method: "browser" | "device_code" }): Promise<CodexLoginOutcome> { this.calls.push(`login:${input.authority.id}:${input.authority.generation}:${input.method}`); await this.beforeLoginReturn?.(input); return this.loginResult; }
  async cancelLogin(input: { authority: ProfileAuthority; loginId: string }): Promise<{ status: "canceled" | "not_found" }> { this.calls.push(`login-cancel:${input.authority.id}:${input.authority.generation}:${input.loginId}`); await this.beforeCancelLoginReturn?.(); return this.cancelLoginResult; }
  async logout(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    this.calls.push("logout");
    if (this.retiredAuthorityKeys.has(this.#authorityKey(input.authority))) {
      throw new Error("AUTHORITY_STALE");
    }
    await this.beforeLogoutReturn?.();
    input.signal.throwIfAborted();
    if (this.logoutError !== undefined) throw this.logoutError;
  }
  async releaseOwnedAuthority(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    this.releasedAuthorities.push(input.authority);
    this.retireAuthority(input.authority);
    await this.beforeReleaseOwnedAuthorityReturn?.();
    input.signal.throwIfAborted();
  }
  async readAccount(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<CodexAccountProjection> {
    input.signal.throwIfAborted();
    this.calls.push("readAccount");
    if (this.retiredAuthorityKeys.has(this.#authorityKey(input.authority))) {
      throw new Error("AUTHORITY_STALE");
    }
    this.readAccountAuthorities.push(input.authority);
    const observed = this.accountProjection;
    await this.beforeReadAccountReturn?.(input);
    return observed;
  }
  async listPlugins(input: Parameters<CodexRuntimePort["listPlugins"]>[0]): Promise<CodexPluginCatalog> {
    this.calls.push("plugins");
    this.pluginRequests.push(input);
    return this.pluginCatalog;
  }
  async readUsage(input: Parameters<CodexRuntimePort["readUsage"]>[0]): Promise<{ revision: number; observedAt: number; payload: unknown }> {
    this.calls.push("usage");
    this.readUsageAuthorities.push(input.authority);
    await this.beforeReadUsageReturn?.(input);
    if (this.usageError !== undefined) throw this.usageError;
    return this.usageResults.shift() ?? this.usageResult;
  }
  async consumeRateLimitReset(
    input: Parameters<CodexRuntimePort["consumeRateLimitReset"]>[0],
  ): ReturnType<CodexRuntimePort["consumeRateLimitReset"]> {
    this.calls.push("reset");
    this.resetIdempotencyKeys.push(input.idempotencyKey);
    await this.beforeResetReturn?.();
    if (this.resetError !== undefined) throw this.resetError;
    return this.resetOutcome;
  }
  async listSessions(input: Parameters<CodexRuntimePort["listSessions"]>[0]): ReturnType<CodexRuntimePort["listSessions"]> {
    this.calls.push("list");
    this.sessionListRequests.push(input);
    await this.beforeListSessionsReturn?.();
    return { sessions: this.listedProjections, nextCursor: this.listedNextCursor };
  }
  async readSessionMetadata(
    authority: ProfileAuthority,
    providerThreadId: string,
    signal: AbortSignal,
  ): Promise<CodexSessionProjection> {
    signal.throwIfAborted();
    this.calls.push("metadata");
    this.metadataReadRequests.push({ authority, providerThreadId });
    return { ...this.readProjection, providerThreadId };
  }
  async claimSession(
    input: Parameters<NonNullable<CodexRuntimePort["claimSession"]>>[0],
  ): ReturnType<NonNullable<CodexRuntimePort["claimSession"]>> {
    this.calls.push("claim");
    this.claimRequests.push(input);
    const scopedClaimError = this.claimErrorForProviderThreadId?.(input.providerThreadId);
    if (scopedClaimError !== undefined) throw scopedClaimError;
    if (this.claimError !== undefined) throw this.claimError;
    const beforeReturn = this.beforeClaimSessionReturnOnce;
    delete this.beforeClaimSessionReturnOnce;
    await beforeReturn?.();
    if (input.requirement.effort === "provider-default") {
      throw new Error("not a Codex requirement");
    }
    const base = runtimeProfile(input.authority);
    const effectiveRuntimeProfile = this.claimRuntimeProfileOverride ?? {
      ...base,
      preset: input.preset,
      fast: input.fast,
      serviceTier: input.fast ? "priority" as const : null,
      model: input.requirement.model,
      reasoningEffort: input.requirement.effort,
    };
    return {
      connectionId: this.observationConnectionId,
      effectiveRuntimeProfile,
      projection: {
        ...this.readProjection,
        providerThreadId: input.providerThreadId,
      },
      resumed: true,
    };
  }
  hasLiveHostToolCall(
    input: Parameters<NonNullable<CodexRuntimePort["hasLiveHostToolCall"]>>[0],
  ): boolean {
    this.liveHostToolCallRequests.push(input);
    return this.liveHostToolCall
      && input.connectionId === this.observationConnectionId;
  }
  async reviewSessionStart(input: Parameters<CodexRuntimePort["reviewSessionStart"]>[0]): Promise<RuntimeStartReview> {
    this.calls.push("review-session");
    this.sessionReviewRequests.push(input);
    if (input.requirement.effort === "provider-default") throw new Error("not a Codex requirement");
    const base = runtimeProfile(input.authority);
    const effectiveRuntimeProfile = this.runtimeProfileOverride ?? {
      ...base,
      preset: input.preset,
      fast: input.fast,
      serviceTier: input.fast ? "priority" as const : null,
      model: input.requirement.model,
      reasoningEffort: input.requirement.effort,
    };
    return { reviewId: crypto.randomUUID(), kind: "session_start", effectiveRuntimeProfile };
  }
  async startSession(input: { review: RuntimeStartReview }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    this.calls.push(`start:${input.review.effectiveRuntimeProfile.preset}`);
    if (this.startSessionError !== undefined) throw this.startSessionError;
    this.readProjection = {
      providerThreadId: "provider-thread",
      title: "New session",
      status: "idle",
      providerUpdatedAt: 10,
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 0,
        truncatedMessages: 0,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
    };
    this.freshThreads.add(this.readProjection.providerThreadId);
    return { ...this.readProjection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async observeSession(input: Parameters<CodexRuntimePort["observeSession"]>[0]): ReturnType<CodexRuntimePort["observeSession"]> {
    this.calls.push("observe");
    this.observedThreads.push(input.providerThreadId);
    this.activeObservations += 1;
    this.maximumConcurrentObservations = Math.max(
      this.maximumConcurrentObservations,
      this.activeObservations,
    );
    const oneShotError = this.observeErrorOnce;
    delete this.observeErrorOnce;
    try {
      await this.beforeObserveReturn?.();
      if (oneShotError !== undefined) throw oneShotError;
      if (this.observeError !== undefined) throw this.observeError;
      return {
        connectionId: this.observationConnectionId,
        projection: {
          ...this.readProjection,
          providerThreadId: this.observationThreadIdOverride ?? input.providerThreadId,
        },
        resumed: !this.freshThreads.has(input.providerThreadId),
      };
    } finally {
      this.activeObservations -= 1;
    }
  }
  endSession(): Promise<void> {
    this.calls.push("end");
    return Promise.resolve();
  }
  async readSession(): Promise<CodexSessionProjection> {
    this.calls.push("read");
    this.turnEffectTrace.push("read");
    const error = this.readSessionErrorOnce;
    delete this.readSessionErrorOnce;
    if (error !== undefined) throw error;
    await this.beforeReadSessionReturn?.();
    return this.readProjection;
  }
  async reviewTurnStart(input: Parameters<CodexRuntimePort["reviewTurnStart"]>[0]): Promise<RuntimeStartReview> {
    this.calls.push("review-turn");
    this.turnEffectTrace.push("review");
    this.turnReviewRequests.push(input);
    const error = this.reviewTurnErrorOnce;
    delete this.reviewTurnErrorOnce;
    if (error !== undefined) throw error;
    if (input.requirement.effort === "provider-default") throw new Error("not a Codex requirement");
    const base = runtimeProfile(input.authority);
    const effectiveRuntimeProfile = this.runtimeProfileOverride ?? {
      ...base,
      preset: input.preset,
      fast: input.fast,
      serviceTier: input.fast ? "priority" as const : null,
      model: input.requirement.model,
      reasoningEffort: input.requirement.effort,
    };
    await this.beforeReviewTurnStartReturn?.();
    return { reviewId: crypto.randomUUID(), kind: "turn_start", effectiveRuntimeProfile };
  }
  async startTurn(input: { review: RuntimeStartReview; message: string; attachments?: readonly PreparedAttachment[]; clientMessageId: string }): Promise<{ turnId: string; status: "completed" | "interrupted" | "failed" | "inProgress"; effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    this.calls.push("send");
    this.startTurnAttachments.push({
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      clientMessageId: input.clientMessageId,
    });
    this.turnEffectTrace.push("start");
    this.activeStartTurns += 1;
    this.maximumConcurrentStartTurns = Math.max(this.maximumConcurrentStartTurns, this.activeStartTurns);
    const oneShotError = this.startTurnErrorOnce;
    delete this.startTurnErrorOnce;
    try {
      await this.beforeStartTurnEffect?.();
      if (oneShotError !== undefined) throw oneShotError;
      const turnId = this.committedStartTurns === 0
        ? this.turnId
        : `${this.turnId}-${String(this.committedStartTurns + 1)}`;
      this.committedStartTurns += 1;
      const turnStatus = this.turnStatus;
      const updatedAt = (this.readProjection.providerUpdatedAt ?? 10) + 1;
      this.readProjection = { ...this.readProjection, status: turnStatus === "inProgress" ? "active" : "idle", ...(turnStatus === "inProgress" ? { activeTurnId: turnId } : {}), providerUpdatedAt: updatedAt, messages: [...(this.readProjection.messages ?? []), { role: "user", text: input.message, turnId, clientId: input.clientMessageId }], turnSummaries: [...(this.readProjection.turnSummaries ?? []), { id: turnId, status: turnStatus, files: [], actions: [], omittedFiles: 0, omittedActions: 0 }] };
      if (turnStatus !== "inProgress") delete (this.readProjection as { activeTurnId?: string }).activeTurnId;
      await this.beforeStartTurnReturn?.();
      if (this.startTurnError !== undefined) throw this.startTurnError;
      return { turnId, status: turnStatus, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
    } finally {
      this.activeStartTurns -= 1;
    }
  }
  async steer(input: Parameters<CodexRuntimePort["steer"]>[0]): Promise<void> {
    this.calls.push("steer");
    this.steerAttachments.push({
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
      clientMessageId: input.clientMessageId,
    });
    this.readProjection = { ...this.readProjection, status: "active", activeTurnId: input.activeTurnId, providerUpdatedAt: (this.readProjection.providerUpdatedAt ?? 10) + 1, messages: [...(this.readProjection.messages ?? []), { role: "user", text: input.message, turnId: input.activeTurnId, clientId: input.clientMessageId }] };
    if (this.steerError !== undefined) throw this.steerError;
  }
  async interrupt(input: { activeTurnId: string }): Promise<void> {
    this.calls.push("stop");
    this.readProjection = { ...this.readProjection, status: "idle", providerUpdatedAt: (this.readProjection.providerUpdatedAt ?? 10) + 1, turnSummaries: (this.readProjection.turnSummaries ?? []).map((turn) => turn.id === input.activeTurnId ? { ...turn, status: "interrupted" } : turn) };
    delete (this.readProjection as { activeTurnId?: string }).activeTurnId;
    await this.beforeInterruptReturn?.();
    if (this.interruptError !== undefined) throw this.interruptError;
  }
  async rename(input: { name: string }): Promise<void> {
    this.calls.push("rename");
    this.readProjection = { ...this.readProjection, title: input.name, providerUpdatedAt: (this.readProjection.providerUpdatedAt ?? 10) + 1 };
    await this.beforeRenameReturn?.();
    if (this.renameError !== undefined) throw this.renameError;
  }
  async inspectTurn(): Promise<unknown> { return { id: "turn-next", runtimeMs: 123 }; }
  async inspectInteractionAuthority(
    input: Parameters<CodexRuntimePort["inspectInteractionAuthority"]>[0],
  ): ReturnType<CodexRuntimePort["inspectInteractionAuthority"]> {
    this.inspectedInteractions.push(input);
    await this.beforeInspectInteractionReturn?.();
    return this.interactionAuthority;
  }
  async resolveInteraction(
    input: Parameters<NonNullable<CodexRuntimePort["resolveInteraction"]>>[0],
  ): Promise<{ responseWritten: true }> {
    this.resolvedInteractions.push(input);
    await this.beforeResolveInteractionReturn?.();
    if (this.resolveInteractionError !== undefined) throw this.resolveInteractionError;
    return { responseWritten: true };
  }
  async validateInteractionResolution(
    input: Parameters<CodexRuntimePort["validateInteractionResolution"]>[0],
  ): Promise<{ responseDigest: string }> {
    this.validatedInteractions.push(input);
    if (this.validateInteractionResolutionError !== undefined) {
      throw this.validateInteractionResolutionError;
    }
    await this.beforeValidateInteractionResolutionReturn?.();
    return { responseDigest: createHash("sha256").update(JSON.stringify(input.resolution)).digest("hex") };
  }
  async validateInteractionTimeout(
    input: Parameters<CodexRuntimePort["validateInteractionTimeout"]>[0],
  ): Promise<{ responseDigest: string }> {
    this.validatedInteractionTimeouts.push(input);
    if (this.validateInteractionTimeoutError !== undefined) throw this.validateInteractionTimeoutError;
    return { responseDigest: "e".repeat(64) };
  }
  async timeoutInteraction(
    input: Parameters<CodexRuntimePort["timeoutInteraction"]>[0],
  ): Promise<{ responseWritten: true }> {
    this.timedOutInteractions.push(input);
    await this.beforeTimeoutInteractionReturn?.();
    if (this.timeoutInteractionError !== undefined) throw this.timeoutInteractionError;
    return { responseWritten: true };
  }
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }
}

export const claudeRuntimeProfile = (
  authority: ProfileAuthority,
  configHome: "isolated" | "personal",
): EffectiveClaudeRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: personalAdoptionNow,
  preset: "fable-max",
  model: CLAUDE_PIN_MODEL,
  reasoningEffort: "max",
  claudeVersion: CLAUDE_PIN,
  permissionMode: "default",
  configHome,
  outputFormat: "stream-json",
  inputFormat: "stream-json",
});

export class FakeClaude implements ClaudeRuntimePort {
  readonly provider = "claude" as const;
  discardRuntimeReview(): void {}
  readonly calls: string[] = [];
  readonly claimRequests: Array<Parameters<ClaudeRuntimePort["claimSession"]>[0]> = [];
  readonly endRequests: Array<Parameters<ClaudeRuntimePort["endSession"]>[0]> = [];
  readonly endedProcessIdentities: ClaudeProcessIdentity[] = [];
  readonly rebindings: Array<Parameters<ClaudeRuntimePort["rebindProfileAuthority"]>[0]> = [];
  readonly identityRequests: Array<
    Parameters<ClaudeRuntimePort["readSessionProcessIdentity"]>[0]
  > = [];
  readonly hostToolActivationRequests: Array<
    Parameters<NonNullable<ClaudeRuntimePort["activateSessionHostTools"]>>[0]
  > = [];
  readonly observeRequests: Array<Parameters<ClaudeRuntimePort["observeSession"]>[0]> = [];
  readonly startSessionRequests: Array<Parameters<ClaudeRuntimePort["startSession"]>[0]> = [];
  readonly resolvedInteractions: Array<
    Parameters<ClaudeRuntimePort["resolveInteraction"]>[0]
  > = [];
  readonly inspectedInteractions: Array<
    Parameters<ClaudeRuntimePort["inspectInteractionAuthority"]>[0]
  > = [];
  readonly turnRequests: Array<Parameters<ClaudeRuntimePort["startTurn"]>[0]> = [];
  readonly validatedInteractions: Array<
    Parameters<ClaudeRuntimePort["validateInteractionResolution"]>[0]
  > = [];
  beforeEndSessionReturn?: () => Promise<void>;
  beforeStartTurnReturn?: () => Promise<void>;
  beforeClaimSessionAdmission?: (
    input: Parameters<ClaudeRuntimePort["claimSession"]>[0],
  ) => Promise<void> | void;
  beforeStartSessionAdmission?: (
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
  ) => Promise<void> | void;
  closeError?: Error;
  closeCalls = 0;
  claimProjectionTitle?: string;
  claimRuntimeProfileOverride?: (
    authority: ProfileAuthority,
  ) => EffectiveClaudeRuntimeProfile;
  claimSessionError?: Error;
  disconnectOnObserveRequest?: number;
  observationConnectionId = "30000000-0000-4000-8000-0000000000c1";
  liveHostToolCall = true;
  readonly liveHostToolCallRequests: Array<Parameters<NonNullable<
    ClaudeRuntimePort["hasLiveHostToolCall"]
  >>[0]> = [];
  observationConnectionIdOnClaim?: string;
  observePause?: Promise<void>;
  observePauseStarted?: () => void;
  pauseOnObserveRequest?: number;
  observeErrorOnce?: Error;
  readIdentityErrorOnce?: Error;
  processIdentity: ClaudeProcessIdentity;
  processIdentityOnClaim?: ClaudeProcessIdentity;
  startSessionError?: Error;
  startTurnError?: Error;
  controllerLive = true;
  accountProjection: CodexAccountProjection = {
    signedIn: true,
    accountId: "claude-account",
    organizationId: "claude-organization",
    email: "claude@example.com",
  };
  interactionAuthorityProjection: Awaited<
    ReturnType<ClaudeRuntimePort["inspectInteractionAuthority"]>
  > = {
    kind: "command_approval",
    command: "bun test",
    reason: null,
    availableDecisions: ["accept", "decline", "cancel"],
    workingDirectory: "/workspace",
    environmentId: null,
    commandActions: null,
    networkApprovalContext: null,
    additionalPermissions: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
  };
  projection: CodexSessionProjection = {
    providerThreadId: "personal-claude-thread",
    title: "Personal Claude session",
    status: "idle",
    providerUpdatedAt: personalAdoptionNow - 1_000,
  };

  constructor(
    readonly configHome: "isolated" | "personal",
    identity: ClaudeProcessIdentity,
  ) {
    this.processIdentity = identity;
  }

  pinnedVersion(): string { return CLAUDE_PIN; }
  rebindProfileAuthority(
    input: Parameters<ClaudeRuntimePort["rebindProfileAuthority"]>[0],
  ): void {
    this.rebindings.push(input);
  }

  hasLiveSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean {
    void input.authority;
    return this.controllerLive && this.projection.providerThreadId === input.providerThreadId;
  }

  hasLiveHostToolCall(
    input: Parameters<NonNullable<ClaudeRuntimePort["hasLiveHostToolCall"]>>[0],
  ): boolean {
    this.liveHostToolCallRequests.push(input);
    return this.liveHostToolCall
      && this.controllerLive
      && input.connectionId === this.observationConnectionId;
  }

  async activateSessionHostTools(
    input: Parameters<NonNullable<ClaudeRuntimePort["activateSessionHostTools"]>>[0],
  ): Promise<void> {
    input.signal.throwIfAborted();
    if (!this.hasLiveSession(input)) {
      throw new ClaudeSessionObservationError();
    }
    this.hostToolActivationRequests.push(input);
  }

  async readAccount(): ReturnType<ClaudeRuntimePort["readAccount"]> {
    return { readiness: this.accountProjection.signedIn ? "signed_in" : "signed_out", observedAt: personalAdoptionNow };
  }

  async readProviderAccountIdentity(): Promise<CodexAccountProjection> {
    return this.accountProjection;
  }

  async claimSession(
    input: Parameters<ClaudeRuntimePort["claimSession"]>[0],
  ): ReturnType<ClaudeRuntimePort["claimSession"]> {
    this.calls.push("claim");
    this.claimRequests.push(input);
    this.controllerLive = true;
    if (this.processIdentityOnClaim !== undefined) {
      this.processIdentity = this.processIdentityOnClaim;
      delete this.processIdentityOnClaim;
    }
    if (this.observationConnectionIdOnClaim !== undefined) {
      this.observationConnectionId = this.observationConnectionIdOnClaim;
      delete this.observationConnectionIdOnClaim;
    }
    await this.beforeClaimSessionAdmission?.(input);
    if (this.claimSessionError !== undefined) throw this.claimSessionError;
    await input.admitProcessIdentity?.(this.processIdentity);
    this.projection = {
      ...this.projection,
      providerThreadId: input.providerThreadId,
      projectRoot: input.projectRoot,
      status: "idle",
      title: this.claimProjectionTitle ?? input.title,
    };
    delete (this.projection as { activeTurnId?: string }).activeTurnId;
    return {
      ...this.projection,
      effectiveRuntimeProfile: this.claimRuntimeProfileOverride?.(input.authority)
        ?? claudeRuntimeProfile(input.authority, this.configHome),
    };
  }

  async readSessionProcessIdentity(
    input: Parameters<ClaudeRuntimePort["readSessionProcessIdentity"]>[0],
  ): ReturnType<ClaudeRuntimePort["readSessionProcessIdentity"]> {
    this.calls.push("identity");
    this.identityRequests.push(input);
    const error = this.readIdentityErrorOnce;
    delete this.readIdentityErrorOnce;
    if (error !== undefined) throw error;
    return this.processIdentity;
  }

  async reviewSessionStart(
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-session");
    return {
      reviewId: crypto.randomUUID(),
      kind: "session_start",
      effectiveRuntimeProfile: claudeRuntimeProfile(input.authority, this.configHome),
    };
  }

  async startSession(
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }> {
    this.calls.push("start-session");
    this.startSessionRequests.push(input);
    this.controllerLive = true;
    if (input.providerThreadId !== undefined) {
      this.projection = { ...this.projection, providerThreadId: input.providerThreadId };
    }
    await this.beforeStartSessionAdmission?.(input);
    if (this.startSessionError !== undefined) throw this.startSessionError;
    await input.admitProcessIdentity?.(this.processIdentity);
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }

  async observeSession(
    input: Parameters<ClaudeRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    this.observeRequests.push(input);
    if (this.disconnectOnObserveRequest === this.observeRequests.length) {
      this.controllerLive = false;
      throw new ClaudeSessionObservationError();
    }
    if (!this.controllerLive) throw new ClaudeSessionObservationError();
    if (this.pauseOnObserveRequest === this.observeRequests.length) {
      this.observePauseStarted?.();
      if (this.observePause !== undefined) await this.observePause;
    }
    const error = this.observeErrorOnce;
    delete this.observeErrorOnce;
    if (error !== undefined) throw error;
    return {
      connectionId: this.observationConnectionId,
      projection: { ...this.projection, providerThreadId: input.providerThreadId },
      resumed: true,
    };
  }

  async readSession(
    input: Parameters<ClaudeRuntimePort["readSession"]>[0],
  ): Promise<CodexSessionProjection> {
    this.calls.push("read");
    return {
      ...this.projection,
      providerThreadId: input.providerThreadId,
      ...(input.detail ? {
        omission: {
          hasMoreOlderTurns: false,
          incompleteTurnIds: [],
          omittedMessages: 0,
          returnedTurns: this.turnRequests.length,
          truncatedMessages: 0,
          turnLimit: 20,
          unreadItemTurnIds: [],
        },
      } : {}),
    };
  }

  async endSession(
    input: Parameters<ClaudeRuntimePort["endSession"]>[0],
  ): Promise<void> {
    this.calls.push("end");
    this.endRequests.push(input);
    this.endedProcessIdentities.push(this.processIdentity);
    await this.beforeEndSessionReturn?.();
    this.controllerLive = false;
  }

  async reviewTurnStart(
    input: Parameters<ClaudeRuntimePort["reviewTurnStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-turn");
    return {
      reviewId: crypto.randomUUID(),
      kind: "turn_start",
      effectiveRuntimeProfile: claudeRuntimeProfile(input.authority, this.configHome),
    };
  }

  async startTurn(
    input: Parameters<ClaudeRuntimePort["startTurn"]>[0],
  ): Promise<{
    turnId: string;
    status: "completed";
    effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile;
  }> {
    this.calls.push("send");
    this.turnRequests.push(input);
    const turnId = `claude-turn-${String(this.turnRequests.length)}`;
    this.projection = {
      ...this.projection,
      status: "idle",
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 0) + 1,
      messages: [
        ...(this.projection.messages ?? []),
        {
          role: "user",
          text: input.message,
          turnId,
          clientId: input.clientMessageId,
        },
      ],
    };
    if (this.startTurnError !== undefined) throw this.startTurnError;
    if (this.beforeStartTurnReturn !== undefined) await this.beforeStartTurnReturn();
    return {
      turnId,
      status: "completed",
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }

  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> { this.calls.push("interrupt"); }
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError !== undefined) throw this.closeError;
  }

  #unsupported(): never {
    throw new Error("This fake does not drive that Claude capability.");
  }

  interactionAuthority(
    authority: ProfileAuthority,
    providerThreadId: string,
    requestId: string,
  ): ProviderInteractionAuthority {
    return {
      profileId: authority.id,
      processGeneration: authority.generation,
      provider: authority.provider,
      providerAccountId: authority.providerAccountId,
      bindingGeneration: authority.bindingGeneration,
      connectionId: this.observationConnectionId,
      requestId: { type: "string", value: requestId },
      method: "claude/control_request/can_use_tool",
      requestDigest: createHash("sha256").update(requestId).digest("hex"),
      threadId: providerThreadId,
      turnId: "claude-turn-approval",
      itemId: "claude-item-approval",
      approvalId: null,
    };
  }
  async inspectInteractionAuthority(
    input: Parameters<ClaudeRuntimePort["inspectInteractionAuthority"]>[0],
  ): ReturnType<ClaudeRuntimePort["inspectInteractionAuthority"]> {
    this.inspectedInteractions.push(input);
    return this.interactionAuthorityProjection;
  }
  async validateInteractionResolution(
    input: Parameters<ClaudeRuntimePort["validateInteractionResolution"]>[0],
  ): Promise<{ responseDigest: string }> {
    this.validatedInteractions.push(input);
    return {
      responseDigest: createHash("sha256")
        .update(JSON.stringify(input.resolution))
        .digest("hex"),
    };
  }
  async resolveInteraction(
    input: Parameters<ClaudeRuntimePort["resolveInteraction"]>[0],
  ): Promise<{ responseWritten: true }> {
    this.resolvedInteractions.push(input);
    return { responseWritten: true };
  }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

export class FakeDaemonAuthority {
  current = true;
  closeCalls = 0;
  beforeAssert?: () => Promise<void>;

  async assertCurrent(): Promise<void> {
    await this.beforeAssert?.();
    if (!this.current) throw new DaemonAuthoritySafetyError("The fake daemon authority is stale.");
  }

  close(): void {
    this.closeCalls += 1;
    this.current = false;
  }

  invalidate(): void {
    this.current = false;
  }
}

export class FakeCloud implements CloudControlPort {
  attentionObservation: NotificationEmailHostedAuthority = { state: "not_observed" };
  attentionInvalidation: Extract<
    NotificationEmailHostedAuthority,
    { state: "acknowledged" | "not_observed" | "revocation_pending" }
  > | null = null;
  beforeAttentionInvalidation?: (
    input: Parameters<NonNullable<CloudControlPort[
      "invalidateAttentionNotificationAuthority"
    ]>>[0],
  ) => Promise<void> | void;
  readonly projectionRecoveries: Array<{
    acknowledgeGap: true;
    idempotencyKey: string;
    sessionPublicId: `sess_${string}`;
    signal: AbortSignal;
  }> = [];
  beforeProjectionRecoveryReturn?: () => Promise<void>;
  beforeProjectionUnsettledSessionReturn?: (sessionPublicId: `sess_${string}`) => Promise<void>;
  beforeProjectionUnsettledProfileReturn?: (
    profileId: Parameters<CloudControlPort["isCompactProjectionRecoveryUnsettledForProfile"]>[0],
  ) => Promise<void>;
  projectionRecoveryResult: unknown = { phase: "applied", compactStreamEpoch: 1 };
  projectionRecoveryBlocker?: CompactProjectionRecoveryBlocker;
  readonly unsettledProjectionProfiles = new Set<string>();
  readonly unsettledProjectionSessions = new Set<string>();
  readonly providerDeletionSupersessions: string[] = [];
  readonly providerDeletionSupersededSessions = new Set<string>();
  projectionRecoveryError?: CloudProjectionRecoveryAdmissionError;
  authResult: unknown = { requested: true };
  deleteAccountResult: unknown = {
    daemonRestartRequired: true,
    deletion: { effectsDisabled: true, state: "pending", statusFresh: true },
  };
  deleteAccountCalls = 0;
  keyLossCalls = 0;
  keyLossError?: AccountKeyLossPreconditionError;
  readonly deviceApprovalFingerprints: string[] = [];
  readonly deviceMutations: Array<Readonly<{
    device: string;
    idempotencyKey: string;
    kind: "approve" | "revoke";
    signal: AbortSignal;
  }>> = [];
  readonly loseNextDeviceMutationResponses = new Set<"approve" | "revoke">();
  readonly #deviceMutationReceipts = new Map<string, Readonly<{
    device: string;
    kind: "approve" | "revoke";
    result: Readonly<{
      approved?: true;
      device: string;
      idempotencyKey: string;
      revoked?: true;
    }>;
  }>>();
  statusError?: unknown;
  statusResult: unknown = { configured: true };
  async status(): Promise<unknown> {
    if (this.statusError !== undefined) {
      throw this.statusError instanceof Error
        ? this.statusError
        : new Error("Fake cloud status failed.");
    }
    return this.statusResult;
  }
  async sync(): Promise<unknown> { return { synced: true }; }
  async observeAttentionNotificationAuthority(): Promise<NotificationEmailHostedAuthority> {
    return this.attentionObservation;
  }
  async invalidateAttentionNotificationAuthority(input: Parameters<NonNullable<
    CloudControlPort["invalidateAttentionNotificationAuthority"]
  >>[0]): Promise<Extract<
    NotificationEmailHostedAuthority,
    { state: "acknowledged" | "not_observed" | "revocation_pending" }
  >> {
    await this.beforeAttentionInvalidation?.(input);
    if (this.attentionInvalidation === null) {
      throw new Error("Fake hosted notification invalidation is unavailable.");
    }
    return this.attentionInvalidation;
  }
  async isCompactProjectionRecoveryUnsettled(sessionPublicId: `sess_${string}`): Promise<boolean> {
    await this.beforeProjectionUnsettledSessionReturn?.(sessionPublicId);
    return this.projectionRecoveryBlocker === undefined
      ? this.unsettledProjectionSessions.has(sessionPublicId)
      : await this.projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettled(sessionPublicId);
  }
  async isCompactProjectionRecoveryUnsettledForProfile(
    profileId: Parameters<CloudControlPort["isCompactProjectionRecoveryUnsettledForProfile"]>[0],
  ): Promise<boolean> {
    await this.beforeProjectionUnsettledProfileReturn?.(profileId);
    return this.projectionRecoveryBlocker === undefined
      ? this.unsettledProjectionProfiles.has(profileId)
      : await this.projectionRecoveryBlocker.isCompactProjectionRecoveryUnsettledForProfile(profileId);
  }
  async recoverCompactProjection(input: { sessionPublicId: `sess_${string}`; idempotencyKey: string; acknowledgeGap: true; signal: AbortSignal }): Promise<unknown> {
    if (this.projectionRecoveryError !== undefined) throw this.projectionRecoveryError;
    this.projectionRecoveries.push(input);
    await this.beforeProjectionRecoveryReturn?.();
    if (this.providerDeletionSupersededSessions.has(input.sessionPublicId)) {
      return {
        idempotencyKey: input.idempotencyKey,
        phase: "rejected",
        rejectionCode: "PROVIDER_THREAD_DELETED",
        sessionPublicId: input.sessionPublicId,
      };
    }
    return this.projectionRecoveryResult;
  }
  async supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: `sess_${string}`,
  ): Promise<{ superseded: boolean }> {
    this.providerDeletionSupersessions.push(sessionPublicId);
    this.providerDeletionSupersededSessions.add(sessionPublicId);
    this.unsettledProjectionSessions.delete(sessionPublicId);
    return this.projectionRecoveryBlocker === undefined
      ? { superseded: true }
      : await this.projectionRecoveryBlocker
        .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
  }
  async supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    return this.projectionRecoveryBlocker === undefined
      ? { superseded: 0 }
      : await this.projectionRecoveryBlocker.supersedeTerminalCompactProjectionRecoveries();
  }
  async auth(): Promise<unknown> { return this.authResult; }
  async logout(): Promise<void> {}
  async deleteAccount(): Promise<unknown> {
    this.deleteAccountCalls += 1;
    return this.deleteAccountResult;
  }
  async listDevices(): Promise<unknown> { return { devices: [] }; }
  async pairDevice(): Promise<unknown> { return { pending: true }; }
  async acknowledgeNoAccountKeyHolders(): Promise<unknown> {
    this.keyLossCalls += 1;
    if (this.keyLossError !== undefined) throw this.keyLossError;
    return { acknowledgedNoKeyHolders: true, localOnly: true };
  }
  async approveDevice(
    device: string,
    idempotencyKey: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.deviceApprovalFingerprints.push(fingerprint);
    return await this.#mutateDevice("approve", device, idempotencyKey, signal);
  }
  async revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<unknown> {
    return await this.#mutateDevice("revoke", device, idempotencyKey, signal);
  }

  async #mutateDevice(
    kind: "approve" | "revoke",
    device: string,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.deviceMutations.push({ device, idempotencyKey, kind, signal });
    const receipt = this.#deviceMutationReceipts.get(idempotencyKey);
    if (receipt !== undefined) {
      if (receipt.kind !== kind || receipt.device !== device) {
        throw new Error("Cloud device mutation idempotency key was reused for a different request.");
      }
      return { ...receipt.result, replay: true };
    }
    const result = kind === "approve"
      ? { approved: true as const, device, idempotencyKey }
      : { device, idempotencyKey, revoked: true as const };
    this.#deviceMutationReceipts.set(idempotencyKey, { device, kind, result });
    if (this.loseNextDeviceMutationResponses.delete(kind)) {
      throw new Error(`Lost local device ${kind} response.`);
    }
    return result;
  }
}

export class FakeFactsMemoryLifecycle implements OompaFactsMemoryLifecyclePort {
  readonly cleanups: Array<Parameters<OompaFactsMemoryLifecyclePort["cleanupSession"]>[0]> = [];
  readonly ensures: Array<Parameters<OompaFactsMemoryLifecyclePort["ensureSession"]>[0]> = [];
  readonly sweeps: number[] = [];
  readonly transfers: Array<Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0]> = [];
  readonly epochs = new Map<string, number>();
  readonly expiries = new Map<string, number>();
  readonly owners = new Map<string, string>();
  readonly states = new Map<string, "active" | "purged">();
  readonly cleanupErrors = new Set<string>();
  ensureErrorOnce: Error | undefined;
  transferErrorOnce: Error | undefined;
  simulateExpiry = false;

  #receipt(sessionId: string, state: OompaFactsMemoryLifecycleReceipt["state"] = "active"): OompaFactsMemoryLifecycleReceipt {
    return {
      bindingDigest: "a".repeat(64),
      epoch: this.epochs.get(sessionId) ?? 1,
      handleHash: state === "purged" ? null : "b".repeat(64),
      head: state === "purged" ? null : {
        digest: "c".repeat(64),
        operationSha256: null,
        sequence: 0,
      },
      ownerId: this.owners.get(sessionId) ?? "unknown-owner",
      sessionId,
      state,
    };
  }

  readSession(sessionId: string): OompaFactsMemoryLifecycleReceipt | null {
    const state = this.states.get(sessionId);
    return state === undefined ? null : this.#receipt(sessionId, state);
  }

  async cleanupSession(input: Parameters<OompaFactsMemoryLifecyclePort["cleanupSession"]>[0]) {
    this.cleanups.push(input);
    if (this.cleanupErrors.has(input.sessionId)) throw new Error("poisoned terminal cleanup");
    this.states.set(input.sessionId, "purged");
    return this.#receipt(input.sessionId, "purged");
  }

  async ensureSession(input: Parameters<OompaFactsMemoryLifecyclePort["ensureSession"]>[0]) {
    this.ensures.push(input);
    const error = this.ensureErrorOnce;
    this.ensureErrorOnce = undefined;
    if (error !== undefined) throw error;
    const owner = this.owners.get(input.sessionId);
    if (owner !== undefined && owner !== input.ownerId) throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    this.owners.set(input.sessionId, input.ownerId);
    if (this.states.get(input.sessionId) !== "active") {
      this.epochs.set(input.sessionId, (this.epochs.get(input.sessionId) ?? 0) + 1);
      this.states.set(input.sessionId, "active");
    }
    this.expiries.set(
      input.sessionId,
      Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
    );
    return this.#receipt(input.sessionId);
  }

  async transferSessionOwner(
    input: Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0],
  ) {
    this.transfers.push(input);
    const error = this.transferErrorOnce;
    this.transferErrorOnce = undefined;
    if (error !== undefined) throw error;
    const owner = this.owners.get(input.sessionId);
    if (owner !== undefined && owner !== input.fromOwnerId && owner !== input.toOwnerId) {
      throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    }
    if (owner === input.toOwnerId || input.fromOwnerId === input.toOwnerId) {
      this.owners.set(input.sessionId, input.toOwnerId);
      this.expiries.set(
        input.sessionId,
        Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
      );
      this.states.set(input.sessionId, "active");
      return this.#receipt(input.sessionId);
    }
    this.owners.set(input.sessionId, input.toOwnerId);
    this.expiries.set(
      input.sessionId,
      Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
    );
    this.states.set(input.sessionId, "active");
    this.epochs.set(input.sessionId, (this.epochs.get(input.sessionId) ?? 0) + 1);
    return this.#receipt(input.sessionId);
  }

  async forkSession(input: Parameters<OompaFactsMemoryLifecyclePort["forkSession"]>[0]) {
    return this.#receipt(input.childSessionId);
  }

  async resumeSession(input: Parameters<OompaFactsMemoryLifecyclePort["resumeSession"]>[0]) {
    return this.#receipt(input.sessionId);
  }

  async sweepExpired(
    now: number,
    policy?: Parameters<OompaFactsMemoryLifecyclePort["sweepExpired"]>[1],
  ) {
    this.sweeps.push(now);
    let purged = 0;
    if (this.simulateExpiry) {
      for (const [sessionId, expiresAt] of this.expiries) {
        if (this.states.get(sessionId) === "active" && expiresAt <= now) {
          if (policy !== undefined && !policy.canCleanupSession(sessionId)) continue;
          this.states.set(sessionId, "purged");
          purged += 1;
        }
      }
    }
    return { attempted: purged, failed: 0, purged };
  }
}

export class FakeMemory implements OompaMemoryPort {
  readonly statuses: Array<Parameters<OompaMemoryPort["status"]>[0]> = [];
  readonly remembers: Array<Parameters<OompaMemoryPort["remember"]>[0]> = [];
  readonly queries: Array<Parameters<OompaMemoryPort["query"]>[0]> = [];
  readonly explanations: Array<Parameters<OompaMemoryPort["explain"]>[0]> = [];
  readonly shares: Array<Parameters<OompaMemoryPort["share"]>[0]> = [];
  readonly forgottenSessions: string[] = [];
  queryError: Error | undefined;
  beforeRememberReturn: (() => Promise<void>) | undefined;
  closeCalls = 0;
  recoverCalls = 0;

  async status(input: Parameters<OompaMemoryPort["status"]>[0]) {
    this.statuses.push(input);
    return { version: 1, ok: true, kind: "status", sessionId: input.actorSessionId };
  }

  async remember(input: Parameters<OompaMemoryPort["remember"]>[0]) {
    this.remembers.push(input);
    await this.beforeRememberReturn?.();
    return { version: 1, ok: true, kind: "remember" };
  }

  async query(input: Parameters<OompaMemoryPort["query"]>[0]) {
    this.queries.push(input);
    if (this.queryError !== undefined) throw this.queryError;
    return { version: 1, ok: true, kind: "query" };
  }

  async explain(input: Parameters<OompaMemoryPort["explain"]>[0]) {
    this.explanations.push(input);
    return { version: 1, ok: true, kind: "explain" };
  }

  async share(input: Parameters<OompaMemoryPort["share"]>[0]) {
    this.shares.push(input);
    return { version: 1, ok: true, kind: "share" };
  }

  async recover(): Promise<void> {
    this.recoverCalls += 1;
  }

  forgetSession(actorSessionId: string): void {
    this.forgottenSessions.push(actorSessionId);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

export class FakeMemoryRefusalError extends Error {
  override readonly name = "OompaMemoryRefusalError";

  constructor(readonly code: OompaMemoryRefusalCode) {
    super(code);
  }
}

export class TrackingClaudeAuthority extends UnavailableClaudeRuntime {
  readonly rebindings: Parameters<ClaudeRuntimePort["rebindProfileAuthority"]>[0][] = [];
  readonly liveThreads = new Set<string>();
  rebindError: Error | undefined;

  constructor() {
    super(CLAUDE_PIN);
  }

  override hasLiveSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
  }): boolean {
    void input.authority;
    return this.liveThreads.has(input.providerThreadId);
  }

  override rebindProfileAuthority(
    input: Parameters<ClaudeRuntimePort["rebindProfileAuthority"]>[0],
  ): void {
    this.rebindings.push(input);
    if (this.rebindError !== undefined) throw this.rebindError;
  }
}

export const stores: StateStore[] = [];

export const serviceRoots: string[] = [];

export const ownedFixtureTeardowns: Array<() => Promise<void>> = [];

export type ServiceCaseResources = {
  stores: Array<Pick<StateStore, "close">>;
  roots: string[];
  services: Array<Pick<OompaService, "close">>;
};

export const ownedServiceCaseTeardowns: Array<() => Promise<void>> = [];

export type FixtureAdoptionOptions = Readonly<{
  canonical40Queues?: true;
  canonical39Devin?: true;
  canonical39Retired?: "queue_dispatch";
  canonical39RetiredRecovery?: Canonical39RetiredRecoveryScenario;
  canonical39RetiredTarget?: Canonical39RetiredTargetScenario;
  canonicalSessionStart?: CanonicalSessionStartScenario;
  canonical39Attachments?: Canonical39AttachmentScenario;
  managedClaude?: ClaudeRuntimePort;
  memory?: OompaMemoryPort;
  /**
   * `template`, this file's default for an empty store, copies the
   * process-wide migrated template before the open. `migrate` runs the real
   * migration chain from an empty file. Archived sources above always take
   * the real path.
   */
  provision?: "template" | "migrate";
  personalCodex?: CodexRuntimePort;
  personalClaude?: ClaudeRuntimePort;
  personalDiscovery?: PersonalSessionDiscoveryPort;
  daemonGeneration?: number;
  readPersonalCodexAutomations?: (
    request: CodexAutomationAuthorityRequest,
  ) => Promise<CodexAutomationAuthorityScan>;
  personalCodexHome?: string;
  claudeProcessLiveness?: ClaudeProcessLivenessProbe;
}>;

export const shortScrubCheckpoint: SecurityScrubCheckpointPolicy = {
  busyTimeoutMs: 50,
  attempts: 3,
  backoffMs: 10,
};

export const isOompaMemoryPort = (
  value: FixtureAdoptionOptions | OompaMemoryPort | NodeJS.Platform | undefined,
): value is OompaMemoryPort => typeof value === "object"
  && typeof (value as Partial<OompaMemoryPort>).status === "function"
  && typeof (value as Partial<OompaMemoryPort>).remember === "function";

export const expectHistoricalValue = (actual: unknown, expected: unknown): void => {
  expect(actual).toEqual(expected);
};

export const serviceFixtureDatabaseSnapshot = (path: string) => {
  const database = new Database(path, { strict: true });
  try {
    database.exec("PRAGMA query_only=ON");
    return database.transaction(() => ({
      schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
      tables: database.query<{ name: string }, []>("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
        .map(({ name }) => {
          if (!/^[A-Za-z0-9_]+$/u.test(name)) throw new Error("Unexpected service fixture table name.");
          const rows = database.query(`SELECT * FROM "${name}" LIMIT 4097`).all();
          if (rows.length > 4096) throw new Error("Service fixture exceeded its row bound.");
          return { name, rows: rows.map((row) => JSON.stringify(row)).sort() };
        }),
    })).deferred();
  } finally { database.close(false); }
};

export async function fixture(
  cloud = new FakeCloud(),
  requestStop: () => void = () => undefined,
  now: () => number = Date.now,
  factsMemory?: OompaFactsMemoryLifecyclePort,
  autorespond: Readonly<{
    beforeMemoryClose?: () => Promise<void>;
    claude?: ClaudeRuntimePort;
    devin?: DevinRuntimePort;
    gatewayKeys?: GatewayKeyPort;
    proseResponder?: ProseResponder;
    securityScrubCheckpoint?: SecurityScrubCheckpointPolicy;
  }> = {},
  adoptionOrMemoryOrPlatform: FixtureAdoptionOptions | OompaMemoryPort | NodeJS.Platform = {},
  platformOrClaude?: NodeJS.Platform | ClaudeRuntimePort,
  platformOverride: NodeJS.Platform = "linux",
  resources?: ServiceCaseResources,
): Promise<{ service: OompaService; store: StateStore; codex: FakeCodex; cloud: FakeCloud; daemonAuthority: FakeDaemonAuthority; daemonGeneration: number; daemonBootId: string; documents: string; eventCursors: SessionEventCursorCodec; paths: ReturnType<typeof resolveStatePaths> }> {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-service-")));
  (resources?.roots ?? serviceRoots).push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await initializeStatePaths(paths);
  const adoption: FixtureAdoptionOptions = typeof adoptionOrMemoryOrPlatform === "object"
    && !isOompaMemoryPort(adoptionOrMemoryOrPlatform)
    ? adoptionOrMemoryOrPlatform
    : {};
  if (adoption.canonical40Queues === true) {
    await writeFile(paths.database, canonical40QueuesDatabaseBytes(), { mode: 0o600 });
  }
  if (adoption.canonical39Devin === true) {
    if (adoption.canonical40Queues === true) throw new Error("Choose exactly one archived source.");
    // Preserve the actual released producer's sessions and login evidence. This
    // is synthetic control-plane history, not a native provider custody proof.
    await writeFile(paths.database, canonical39DevinDatabaseBytes(), { mode: 0o600 });
  }
  if (adoption.canonical39Retired !== undefined) {
    if (adoption.canonical40Queues === true || adoption.canonical39Devin === true) {
      throw new Error("Choose exactly one archived source.");
    }
    await writeFile(paths.database, canonical39RetiredDatabaseBytes(adoption.canonical39Retired), { mode: 0o600 });
  }
  if (adoption.canonical39RetiredRecovery !== undefined) {
    if (adoption.canonical40Queues === true || adoption.canonical39Devin === true
      || adoption.canonical39Retired !== undefined) throw new Error("Choose exactly one archived source.");
    await writeFile(paths.database, canonical39RetiredRecoveryDatabaseBytes(adoption.canonical39RetiredRecovery), { mode: 0o600 });
  }
  if (adoption.canonical39RetiredTarget !== undefined) {
    if (adoption.canonical40Queues === true || adoption.canonical39Devin === true
      || adoption.canonical39Retired !== undefined || adoption.canonical39RetiredRecovery !== undefined) {
      throw new Error("Choose exactly one archived source.");
    }
    await writeFile(paths.database, canonical39RetiredTargetDatabaseBytes(adoption.canonical39RetiredTarget), { mode: 0o600 });
  }
  if (adoption.canonicalSessionStart !== undefined) {
    if (adoption.canonical40Queues === true || adoption.canonical39Devin === true
      || adoption.canonical39Retired !== undefined || adoption.canonical39RetiredRecovery !== undefined
      || adoption.canonical39RetiredTarget !== undefined) throw new Error("Choose exactly one archived source.");
    await writeFile(paths.database, canonicalSessionStartDatabaseBytes(adoption.canonicalSessionStart), { mode: 0o600 });
  }
  if (adoption.canonical39Attachments !== undefined) {
    if (adoption.canonical40Queues === true || adoption.canonical39Devin === true
      || adoption.canonical39Retired !== undefined || adoption.canonical39RetiredRecovery !== undefined
      || adoption.canonical39RetiredTarget !== undefined || adoption.canonicalSessionStart !== undefined) {
      throw new Error("Choose exactly one archived source.");
    }
    await writeFile(paths.database, canonical39AttachmentDatabaseBytes(adoption.canonical39Attachments), { mode: 0o600 });
  }
  const archivedSource = adoption.canonical40Queues === true || adoption.canonical39Devin === true
    || adoption.canonical39Retired !== undefined || adoption.canonical39RetiredRecovery !== undefined
    || adoption.canonical39RetiredTarget !== undefined || adoption.canonicalSessionStart !== undefined
    || adoption.canonical39Attachments !== undefined;
  if (!archivedSource && adoption.provision !== "migrate") {
    await provisionMigratedStateTemplate(paths, { now });
  }
  const store = new StateStore(paths, {
    now,
    ...(autorespond.securityScrubCheckpoint === undefined
      ? {}
      : { securityScrubCheckpoint: autorespond.securityScrubCheckpoint }),
  });
  (resources?.stores ?? stores).push(store);
  // Exercise the same explicit persisted boot fence used by the real daemon;
  // generation zero is not attachment reservation or deletion authority.
  const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(daemonBootId);
  // The daemon defaults to answering approvals itself; these tests exercise
  // the manual paths and opt in to autorespond explicitly where needed.
  store.setDefaultApprovalMode("manual");
  const codex = new FakeCodex();
  const daemonAuthority = new FakeDaemonAuthority();
  const eventCursors = new SessionEventCursorCodec(SessionEventCursorCodec.generateKey());
  const memory = isOompaMemoryPort(adoptionOrMemoryOrPlatform)
    ? adoptionOrMemoryOrPlatform
    : adoption.memory;
  const explicitClaude = typeof platformOrClaude === "string"
    ? undefined
    : platformOrClaude;
  const platform = typeof adoptionOrMemoryOrPlatform === "string"
    ? adoptionOrMemoryOrPlatform
    : typeof platformOrClaude === "string"
      ? platformOrClaude
      : platformOverride;
  const managedClaude = adoption.managedClaude ?? explicitClaude ?? autorespond.claude;
  const service = new OompaService({
    store,
    paths,
    codex,
    cloud,
    daemonAuthority,
    daemonGeneration,
    daemonBootId,
    ...(managedClaude === undefined ? {} : { claude: managedClaude }),
    ...(autorespond.devin === undefined ? {} : { devin: autorespond.devin }),
    eventCursors,
    ...(factsMemory === undefined ? {} : { factsMemory }),
    ...(memory === undefined ? {} : { memory }),
    ...(autorespond.beforeMemoryClose === undefined
      ? {}
      : { beforeMemoryClose: autorespond.beforeMemoryClose }),
    ...(autorespond.gatewayKeys === undefined ? {} : { gatewayKeys: autorespond.gatewayKeys }),
    ...(autorespond.proseResponder === undefined ? {} : { proseResponder: autorespond.proseResponder }),
    ...(adoption.personalCodex === undefined ? {} : { personalCodex: adoption.personalCodex }),
    ...(adoption.personalClaude === undefined ? {} : { personalClaude: adoption.personalClaude }),
    ...(adoption.personalDiscovery === undefined ? {} : { personalDiscovery: adoption.personalDiscovery }),
    ...(adoption.readPersonalCodexAutomations === undefined
      ? {}
      : { readPersonalCodexAutomations: adoption.readPersonalCodexAutomations }),
    ...(adoption.personalCodexHome === undefined ? {} : { personalCodexHome: adoption.personalCodexHome }),
    ...(adoption.claudeProcessLiveness === undefined ? {} : { claudeProcessLiveness: adoption.claudeProcessLiveness }),
    ...(adoption.daemonGeneration === undefined
      ? {}
      : { daemonGeneration: adoption.daemonGeneration }),
    now,
    platform,
    requestStop,
  });
  resources?.services.push(service);
  return {
    service,
    store,
    codex,
    cloud,
    daemonAuthority,
    daemonGeneration,
    daemonBootId,
    documents,
    eventCursors,
    paths,
  };
}

export async function archivedDevinFixture(cloud = new FakeCloud(), options: Readonly<{
  factsMemory?: OompaFactsMemoryLifecyclePort;
  memory?: OompaMemoryPort;
}> = {}) {
  const value = await fixture(cloud, () => undefined, Date.now,
    options.factsMemory, {}, {
      canonical39Devin: true,
      ...(options.memory === undefined ? {} : { memory: options.memory }),
    });
  const captured = canonical39DevinFixture.cases[0];
  expect(value.store.requireSession(captured.session.id)).toEqual(captured.session);
  expect(value.store.readMutation(captured.idempotencyKey)).toMatchObject(captured.mutation);
  return { ...value, captured };
}

export async function abandonArchivedDevinLogin(value: Awaited<ReturnType<typeof archivedDevinFixture>>) {
  const { captured } = value;
  await value.service.execute({
    kind: "account.devin-login.abandon", account: captured.profile.id,
    attemptId: captured.mutation.id, idempotencyKey: captured.idempotencyKey,
    providerGeneration: captured.generation, acknowledgeChildExited: true,
  }, { signal });
}

export function ownedServiceFixture(...args: Parameters<typeof fixture>): Promise<Awaited<ReturnType<typeof fixture>> & {
  execute: (command: LocalCommand) => Promise<unknown>;
}> {
  return ownedServiceFixtureWithClose((value) => value.service.close(), ...args);
}

export function ownedServiceFixtureWithClose(
  close: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
  ...args: Parameters<typeof fixture>
): Promise<Awaited<ReturnType<typeof fixture>> & {
  execute: (command: LocalCommand) => Promise<unknown>;
}> {
  const controller = new AbortController();
  const requests = new Set<Promise<unknown>>();
  // Defer setup until its teardown is registered, including timeouts during
  // filesystem initialization before the service has been constructed.
  const setup = Promise.resolve().then(() => fixture(...args));
  ownedFixtureTeardowns.push(async () => {
    controller.abort(new Error("Owned service fixture is closing."));
    const [result] = await Promise.allSettled([setup]);
    await Promise.allSettled([...requests]);
    if (result.status === "fulfilled") await close(result.value);
  });
  return setup.then((value) => {
    controller.signal.throwIfAborted();
    return {
      ...value,
      execute: (command: LocalCommand): Promise<unknown> => {
        // Register before dispatch and never admit a continuation of an
        // already timed-out test, even if its previous request just settled.
        const request = Promise.resolve().then(async () => {
          controller.signal.throwIfAborted();
          const result = await value.service.execute(command, { signal: controller.signal });
          controller.signal.throwIfAborted();
          return result;
        });
        requests.add(request);
        void request.then(
          () => { requests.delete(request); },
          () => { requests.delete(request); },
        );
        return request;
      },
    };
  });
}

export type ServiceFixtureFactory = (...args: Parameters<typeof fixture>) => Promise<
  Awaited<ReturnType<typeof fixture>> & {
    execute?: (command: LocalCommand) => Promise<unknown>;
  }
>;

export type ServiceCaseContext = {
  createFixture: ServiceFixtureFactory;
  signal: AbortSignal;
  resources: ServiceCaseResources;
};

export function createOwnedServiceCase(
  teardowns = ownedServiceCaseTeardowns,
) {
  const resources: ServiceCaseResources = { roots: [], stores: [], services: [] };
  const controller = new AbortController();
  const cancellation = new Error("Owned service case is closing.");
  const tasks: Array<Promise<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }>> = [];
  const createFixture: ServiceFixtureFactory = async (
    cloud, requestStop, now, factsMemory, autorespond, adoption,
    platformOrClaude, platformOverride,
  ) => {
    controller.signal.throwIfAborted();
    const value = await fixture(cloud, requestStop, now, factsMemory,
      autorespond, adoption, platformOrClaude, platformOverride, resources);
    controller.signal.throwIfAborted();
    return {
      ...value,
      execute: async (command: LocalCommand): Promise<unknown> => {
        controller.signal.throwIfAborted();
        const result = await value.service.execute(command, { signal: controller.signal });
        controller.signal.throwIfAborted();
        return result;
      },
    };
  };
  const run = (runCase: (context: ServiceCaseContext) => Promise<void>): Promise<void> => {
    // Return this exact observed task to Bun, including from setup hooks. An
    // outer async hook would create a different, unowned timeout rejection.
    const task = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      await runCase({ createFixture, signal: controller.signal, resources });
      controller.signal.throwIfAborted();
    });
    tasks.push(task.then(
      () => ({ status: "fulfilled" } as const),
      (reason: unknown) => ({ status: "rejected", reason } as const),
    ));
    return task;
  };
  teardowns.push(async () => {
    controller.abort(cancellation);
    const failures: unknown[] = [];
    for (const result of await Promise.all(tasks)) {
      if (result.status === "rejected" && result.reason !== cancellation) failures.push(result.reason);
    }
    let serviceCloseFailed = false;
    for (const service of resources.services.splice(0)) {
      try { await service.close(); } catch (error: unknown) {
        serviceCloseFailed = true;
        failures.push(error);
      }
    }
    if (serviceCloseFailed) throw new AggregateError(failures, "Service close failed; owned storage was retained.");
    let storeCloseFailed = false;
    for (const store of resources.stores.splice(0)) {
      try { store.close(); } catch (error: unknown) {
        storeCloseFailed = true;
        failures.push(error);
      }
    }
    if (storeCloseFailed) throw new AggregateError(failures, "Store close failed; owned roots were retained.");
    for (const root of resources.roots.splice(0)) {
      try { await rm(root, { force: true, recursive: true }); } catch (error: unknown) { failures.push(error); }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Owned service teardown failed.");
  });
  return { run };
}

export function ownedServiceCase(
  runCase: (context: ServiceCaseContext) => Promise<void>,
  teardowns = ownedServiceCaseTeardowns,
): Promise<void> {
  return createOwnedServiceCase(teardowns).run(runCase);
}

export const claudeAuthorityFixtureTimeoutMs = 15_000;

export const personalAdoptionNow = 1_900_000_000_000;

export const personalCodexHome = join(privatePathRoot, "personal-codex-home");

export const personalCodexAutomationScan = (
  targets: readonly Readonly<{
    id?: string;
    kind?: string;
    status?: "active" | "paused";
    targetThreadId: string | null;
  }>[],
  request: CodexAutomationAuthorityRequest,
  complete = true,
): CodexAutomationAuthorityScan => {
  if (!complete) {
    return { complete: false, diagnostics: [], entries: [], nextCursor: null };
  }
  const entries = targets.map((target, index) => ({
    sourceDirectoryName: `automation-source-${String(index + 1).padStart(4, "0")}`,
    automation: {
      cadence: "FREQ=HOURLY;INTERVAL=1",
      id: target.id ?? `automation-${String(index + 1)}`,
      kind: target.kind ?? "heartbeat",
      label: `Automation ${String(index + 1)}`,
      status: target.status ?? "active",
      targetThreadId: target.targetThreadId,
      updatedAt: personalAdoptionNow - 1_000,
    },
  }));
  if (request.kind === "sources") {
    const requested = new Set(request.sourceDirectoryNames);
    return {
      complete: true,
      diagnostics: [],
      entries: entries.filter((entry) => requested.has(entry.sourceDirectoryName)),
      nextCursor: null,
    };
  }
  const limit = request.limit ?? 200;
  const page = entries
    .filter((entry) => request.after === undefined
      || request.after === null
      || entry.sourceDirectoryName > request.after)
    .slice(0, limit);
  const hasMore = entries.some((entry) =>
    entry.sourceDirectoryName > (page.at(-1)?.sourceDirectoryName ?? "")
    && !page.includes(entry));
  return {
    complete: !hasMore,
    diagnostics: [],
    entries: page,
    nextCursor: hasMore ? page.at(-1)?.sourceDirectoryName ?? null : null,
  };
};

export class FakePersonalSessionDiscovery implements PersonalSessionDiscoveryPort {
  candidates: readonly DiscoveredPersonalSession[] = [];
  readonly requests: Array<
    Parameters<PersonalSessionDiscoveryPort["discover"]>[0]
  > = [];

  discover(
    input: Parameters<PersonalSessionDiscoveryPort["discover"]>[0],
  ): Promise<readonly DiscoveredPersonalSession[]> {
    input.signal?.throwIfAborted();
    this.requests.push(input);
    return Promise.resolve(
      this.candidates
        .filter((candidate) => candidate.provider === input.provider)
        .slice(0, input.limit),
    );
  }
}

export async function adoptedCodexFixture(
  label: string,
  providerThreadId: string,
  factsMemory?: OompaFactsMemoryLifecyclePort,
  createFixture: ServiceFixtureFactory = fixture,
) {
  const personalCodex = new FakeCodex();
  const discovery = new FakePersonalSessionDiscovery();
  const value = await createFixture(new FakeCloud(),
    () => undefined,
    () => personalAdoptionNow,
    factsMemory,
    {},
    {
      personalCodex,
      personalCodexHome,
      personalDiscovery: discovery,
    },
  );
  const execute = value.execute ?? ((command: LocalCommand) => value.service.execute(command, { signal }));
  const added = await execute({ kind: "account.add", label }) as { account: { id: `acct_${string}` } };
  await execute({ kind: "account.login", account: added.account.id, deviceCode: false });
  await execute({ kind: "project.add", label: `${label} project`, path: value.documents });
  personalCodex.readProjection = {
    providerThreadId,
    title: `${label} personal thread`,
    status: "idle",
    projectRoot: value.documents,
    providerUpdatedAt: personalAdoptionNow - 11 * 60_000,
    messages: [{ role: "user", text: "Started outside Oompa" }],
  };
  discovery.candidates = [{
    provider: "codex",
    providerThreadId,
    title: `${label} personal thread`,
    projectRoot: value.documents,
    updatedAt: personalAdoptionNow - 11 * 60_000,
    liveness: "not_live",
  }];
  const enabled = await execute({
    kind: "session.adoption.set",
    provider: "codex",
    enabled: true,
    account: added.account.id,
  });
  const session = value.store.findSessionByProviderThread(
    added.account.id,
    providerThreadId,
  );
  if (session === null) throw new Error("Expected the personal Codex session to be adopted.");
  return {
    ...value,
    accountId: added.account.id,
    discovery,
    enabled,
    personalCodex,
    session,
  };
}

export async function preparedPersonalCodexCandidate(input: Readonly<{
  daemonGeneration?: number;
  label: string;
  providerThreadId: string;
  liveness: DiscoveredPersonalSession["liveness"];
  readPersonalCodexAutomations?: (
    request: CodexAutomationAuthorityRequest,
  ) => Promise<CodexAutomationAuthorityScan>;
  scheduledTaskTarget?: true;
  updatedAt?: number;
  now?: () => number;
}>) {
  const personalCodex = new FakeCodex();
  const discovery = new FakePersonalSessionDiscovery();
  const value = await fixture(new FakeCloud(),
    () => undefined,
    input.now ?? (() => personalAdoptionNow),
    undefined,
    {},
    {
      personalCodex,
      personalCodexHome,
      personalDiscovery: discovery,
      ...(input.daemonGeneration === undefined
        ? {}
        : { daemonGeneration: input.daemonGeneration }),
      ...(input.readPersonalCodexAutomations === undefined
        ? {}
        : { readPersonalCodexAutomations: input.readPersonalCodexAutomations }),
    },
  );
  const added = await value.service.execute(
    { kind: "account.add", label: input.label },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute({
    kind: "account.login",
    account: added.account.id,
    deviceCode: false,
  }, { signal });
  await value.service.execute({
    kind: "project.add",
    label: `${input.label} project`,
    path: value.documents,
  }, { signal });
  personalCodex.readProjection = {
    providerThreadId: input.providerThreadId,
    title: `${input.label} personal thread`,
    status: "idle",
    projectRoot: value.documents,
    ...(input.updatedAt === undefined ? {} : { providerUpdatedAt: input.updatedAt }),
  };
  discovery.candidates = [{
    provider: "codex",
    providerThreadId: input.providerThreadId,
    title: `${input.label} personal thread`,
    projectRoot: value.documents,
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    liveness: input.liveness,
    ...(input.scheduledTaskTarget === true ? { scheduledTaskTarget: true } : {}),
  }];
  return {
    ...value,
    accountId: added.account.id,
    discovery,
    personalCodex,
    enable: async (): Promise<unknown> => await value.service.execute({
      kind: "session.adoption.set",
      provider: "codex",
      enabled: true,
      account: added.account.id,
    }, { signal }),
  };
}

export async function adoptedClaudeFixture(
  label: string,
  providerThreadId: string,
  configure?: (runtime: FakeClaude) => void,
  title = `${label} personal thread`,
  platform: NodeJS.Platform = "linux",
  signInCodex = true,
  now: () => number = () => personalAdoptionNow,
  memory?: OompaMemoryPort,
  createFixture: ServiceFixtureFactory = fixture,
) {
  const personalIdentity: ClaudeProcessIdentity = {
    pid: 63_001,
    pidDomain: "darwin",
    procStart: "personal-claude-initial",
  };
  const managedClaude = new FakeClaude("isolated", {
    pid: 63_002,
    pidDomain: "darwin",
    procStart: "managed-claude",
  });
  const personalClaude = new FakeClaude("personal", personalIdentity);
  const discovery = new FakePersonalSessionDiscovery();
  const value = await createFixture(new FakeCloud(),
    () => undefined,
    now,
    undefined,
    {},
    {
      managedClaude,
      personalClaude,
      personalCodexHome,
      personalDiscovery: discovery,
      ...(memory === undefined ? {} : { memory }),
    },
    platform,
  );
  const execute = value.execute ?? ((command: LocalCommand) => value.service.execute(command, { signal }));
  const added = await execute({ kind: "account.add", label }) as { account: { id: `acct_${string}` } };
  if (signInCodex) {
    await execute({ kind: "account.login", account: added.account.id, deviceCode: false });
  }
  await execute({ kind: "project.add", label: `${label} project`, path: value.documents });
  personalClaude.projection = {
    providerThreadId,
    title,
    status: "idle",
    projectRoot: value.documents,
    providerUpdatedAt: personalAdoptionNow - 1_000,
  };
  configure?.(personalClaude);
  discovery.candidates = [{
    provider: "claude",
    providerThreadId,
    title,
    projectRoot: value.documents,
    updatedAt: personalAdoptionNow - 1_000,
    liveness: "not_live",
  }];
  const enabled = await execute({
    kind: "session.adoption.set",
    provider: "claude",
    enabled: true,
    account: added.account.id,
  });
  const session = value.store.findSessionByProviderThread(
    added.account.id,
    providerThreadId,
  );
  if (session === null) throw new Error("Expected the personal Claude session to be adopted.");
  return {
    ...value,
    accountId: added.account.id,
    discovery,
    enabled,
    managedClaude,
    personalClaude,
    personalIdentity,
    session,
  };
}

export async function nativeClaudeFixture(
  label: string,
  providerThreadId: string,
  identity: ClaudeProcessIdentity,
  loginIdempotencyKey?: string,
  signInCodex = true,
  createFixture: ServiceFixtureFactory = fixture,
) {
  const managedClaude = new FakeClaude("isolated", identity);
  const value = await createFixture(new FakeCloud(),
    () => undefined,
    () => personalAdoptionNow,
    undefined,
    {},
    { managedClaude },
  );
  const execute = value.execute ?? ((command: LocalCommand) =>
    value.service.execute(command, { signal }));
  const added = await execute(
    { kind: "account.add", label },
  ) as { account: { id: `acct_${string}` } };
  if (signInCodex) {
    await execute({
      kind: "account.login",
      account: added.account.id,
      deviceCode: false,
      ...(loginIdempotencyKey === undefined ? {} : { idempotencyKey: loginIdempotencyKey }),
    });
  }
  await execute({
    kind: "project.add",
    label: `${label} project`,
    path: value.documents,
  });
  managedClaude.projection = {
    providerThreadId,
    title: `${label} session`,
    status: "idle",
    projectRoot: value.documents,
    providerUpdatedAt: personalAdoptionNow - 1_000,
  };
  const started = await execute({
    kind: "session.start",
    account: added.account.id,
    provider: "claude",
    preset: "fable-max",
    fast: false,
  }) as { session: { id: `sess_${string}`; providerThreadId?: string } };
  const reservedProviderThreadId = started.session.providerThreadId;
  if (reservedProviderThreadId === undefined) {
    throw new Error("Expected the native Claude session to receive a reserved provider identity.");
  }
  return {
    ...value,
    accountId: added.account.id,
    execute,
    identity,
    managedClaude,
    providerThreadId: reservedProviderThreadId,
    session: value.store.requireSession(started.session.id),
  };
}

export async function claudeAccountFixture(
  initiallySignedIn = false,
  platform: NodeJS.Platform = "linux",
  createFixture: ServiceFixtureFactory = fixture,
) {
  let signedIn = initiallySignedIn;
  let readError: Error | undefined;
  let readCalls = 0;
  let readHook: ((authority: ProfileAuthority) => void | Promise<void>) | undefined;
  const readAuthorities: ProfileAuthority[] = [];
  const providerSessionCalls: string[] = [];
  const unexpectedInteraction = async (): Promise<never> => {
    throw new Error("No Claude session interaction expected.");
  };
  const claude: ClaudeRuntimePort = {
    provider: "claude" as const,
    rebindProfileAuthority: () => undefined,
    claimSession: async () => {
      providerSessionCalls.push("claim-session");
      throw new Error("Claude session claim was not expected.");
    },
    readSessionProcessIdentity: async () => {
      providerSessionCalls.push("read-session-process-identity");
      throw new Error("Claude session process identity was not expected.");
    },
    readAccount: async (input) => {
      readCalls += 1;
      readAuthorities.push({ ...input.authority });
      const hook = readHook;
      readHook = undefined;
      await hook?.(input.authority);
      if (readError !== undefined) throw readError;
      return { readiness: signedIn ? "signed_in" : "signed_out", observedAt: 2_000 };
    },
    observeSession: async () => {
      providerSessionCalls.push("observe-session");
      throw new Error("Claude session observation was not expected.");
    },
    readSession: async () => {
      providerSessionCalls.push("read-session");
      throw new Error("Claude session read was not expected.");
    },
    reviewSessionStart: async () => {
      providerSessionCalls.push("review-session-start");
      throw new Error("Claude session start review was not expected.");
    },
    reviewTurnStart: async () => {
      providerSessionCalls.push("review-turn-start");
      throw new Error("Claude turn review was not expected.");
    },
    startSession: async () => {
      providerSessionCalls.push("start-session");
      throw new Error("Claude session start was not expected.");
    },
    startTurn: async () => {
      providerSessionCalls.push("start-turn");
      throw new Error("Claude turn start was not expected.");
    },
    steer: async () => {
      providerSessionCalls.push("steer");
      throw new Error("Claude steer was not expected.");
    },
    interrupt: async () => {
      providerSessionCalls.push("interrupt");
      throw new Error("Claude interrupt was not expected.");
    },
    endSession: async () => {
      providerSessionCalls.push("end-session");
      throw new Error("Claude session end was not expected.");
    },
    interactionAuthority: () => { throw new Error("No Claude session interaction expected."); },
    discardRuntimeReview: () => undefined,
    inspectInteractionAuthority: unexpectedInteraction,
    validateInteractionResolution: unexpectedInteraction,
    resolveInteraction: unexpectedInteraction,
    validateInteractionTimeout: unexpectedInteraction,
    timeoutInteraction: unexpectedInteraction,
    pinnedVersion: () => CLAUDE_PIN,
    close: async () => undefined,
  };
  const value = await createFixture(new FakeCloud(),
    () => undefined,
    Date.now,
    undefined,
    { claude },
    undefined,
    undefined,
    platform,
  );
  return {
    ...value,
    claudeReadCalls: () => readCalls,
    providerReadCalls: () => readCalls,
    readAuthorities,
    setProviderReadHook: (hook: typeof readHook) => { readHook = hook; },
    setProviderSignedIn: (value: boolean) => { signedIn = value; },
    providerSessionCalls,
    setClaudeReadError: (value: Error | undefined) => { readError = value; },
    setClaudeSignedIn: (value: boolean) => { signedIn = value; },
  };
}

export async function isolatedLoginCompletionFixture(provider: "claude") {
  const value = await claudeAccountFixture();
  const profile = value.store.createProfile(`${provider} completion authority`);
  const key = crypto.randomUUID();
  const prepared = await value.service.execute({
    kind: "account.claude-login.prepare", account: profile.id, idempotencyKey: key,
  }, { signal }) as { login: { attemptId: `attempt_${string}`; providerGeneration: number } };
  const complete = {
    kind: "account.claude-login.complete",
    account: profile.id,
    attemptId: prepared.login.attemptId,
    idempotencyKey: key,
    providerGeneration: prepared.login.providerGeneration,
    outcome: { state: "joined" as const, exitCode: 0, interruptedBy: null },
  } satisfies LocalCommand;
  value.setProviderSignedIn(true);
  const corruptProviderProcess = () => {
    const original = value.store.requireProviderAccountAuthority(profile.id, provider);
    // The public retirement CAS refuses a live CLI-owned login grant. Model
    // external corruption directly to prove the service also rejects it.
    const database = new Database(value.paths.database, { create: false, strict: true });
    try {
      expect(database.query(`UPDATE provider_accounts
        SET process_generation=process_generation+1
        WHERE id=? AND profile_id=? AND provider=?
          AND binding_generation=? AND process_generation=?`).run(
        original.providerAccountId, original.profileId, original.provider,
        original.bindingGeneration, original.processGeneration,
      ).changes).toBe(1);
    } finally {
      database.close(false);
    }
  };
  return { ...value, profile, key, prepared, complete, corruptProviderProcess };
}

export async function devinAccountFixture(initiallySignedIn = false) {
  let signedIn = initiallySignedIn;
  let readError: Error | undefined;
  let readCalls = 0;
  const providerSessionCalls: string[] = [];
  const devin = {
    provider: "devin" as const,
    readAccount: async () => {
      readCalls += 1;
      if (readError !== undefined) throw readError;
      return { readiness: signedIn ? "signed_in" as const : "signed_out" as const, observedAt: 2_000 };
    },
    observeSession: async () => {
      providerSessionCalls.push("observe-session");
      throw new Error("Devin session observation was not expected.");
    },
    readSession: async () => {
      providerSessionCalls.push("read-session");
      throw new Error("Devin session read was not expected.");
    },
    reviewSessionStart: async () => {
      providerSessionCalls.push("review-session-start");
      throw new Error("Devin session start review was not expected.");
    },
    reviewTurnStart: async () => {
      providerSessionCalls.push("review-turn-start");
      throw new Error("Devin turn review was not expected.");
    },
    startSession: async () => {
      providerSessionCalls.push("start-session");
      throw new Error("Devin session start was not expected.");
    },
    startTurn: async () => {
      providerSessionCalls.push("start-turn");
      throw new Error("Devin turn start was not expected.");
    },
    steer: async () => {
      providerSessionCalls.push("steer");
      throw new Error("Devin steer was not expected.");
    },
    interrupt: async () => {
      providerSessionCalls.push("interrupt");
      throw new Error("Devin interrupt was not expected.");
    },
    endSession: async () => {
      providerSessionCalls.push("end-session");
      throw new Error("Devin session end was not expected.");
    },
    interactionAuthority: () => { throw new Error("No Devin session interaction expected."); },
    rebindProfileAuthority: () => undefined,
    pinnedVersion: () => DEVIN_PIN,
    close: async () => undefined,
  } as unknown as DevinRuntimePort;
  const value = await fixture(
    new FakeCloud(),
    () => undefined,
    Date.now,
    undefined,
    { devin },
  );
  return {
    ...value,
    devinReadCalls: () => readCalls,
    providerSessionCalls,
    setDevinReadError: (value: Error | undefined) => { readError = value; },
    setDevinSignedIn: (value: boolean) => { signedIn = value; },
  };
}

export async function createIdleSession(
  value: Awaited<ReturnType<typeof fixture>> & {
    execute?: (command: LocalCommand) => Promise<unknown>;
  },
  label: string,
): Promise<{ sessionId: `sess_${string}` }> {
  const execute = value.execute ?? ((command: LocalCommand) => value.service.execute(command, { signal }));
  const added = await execute({ kind: "account.add", label }) as { account: { id: string } };
  await execute({ kind: "account.login", account: added.account.id, deviceCode: false });
  await execute({ kind: "project.add", label: `${label} docs`, path: value.documents });
  const started = await execute({ kind: "session.start", account: added.account.id, preset: "high", presetContract: 2, fast: false }) as { session: { id: `sess_${string}` } };
  return { sessionId: started.session.id };
}

export function remoteAuthorityFor(
  store: StateStore,
  sessionId: string,
) {
  const session = store.requireSession(sessionId);
  if (session.providerThreadId === undefined) throw new Error("Expected provider binding.");
  const authority = store.requireSessionProviderAuthority(session.id);
  return {
    sessionId: session.id,
    profileId: authority.profileId,
    processGeneration: authority.processGeneration,
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
    providerThreadId: session.providerThreadId,
  };
}

export function liveAuthorityFor(
  store: StateStore,
  profileSelector: string,
  provider: "codex" | "claude" = "codex",
  paths: Readonly<{ codexHome?: string; desktopUserData?: string }> = {},
): ProfileAuthority {
  const profile = store.requireProfile(profileSelector);
  const authority = store.requireProviderAccountAuthority(profile.id, provider);
  return {
    id: authority.profileId,
    generation: authority.processGeneration,
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
    codexHome: paths.codexHome ?? "unused",
    desktopUserData: paths.desktopUserData ?? "unused",
  };
}

export function codexInteractionBinding(
  store: StateStore,
  profileSelector: string,
) {
  const profile = store.requireProfile(profileSelector);
  const authority = store.requireProviderAccountAuthority(profile.id, "codex");
  return {
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
  };
}

export function hostToolAuthorityFor(authority: ProfileAuthority): OompaHostToolCall["authority"] {
  if (authority.provider === "devin") throw new Error("A provider without host tools cannot originate a host-tool fixture.");
  return {
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
    profileId: authority.id,
    processGeneration: authority.generation,
  };
}

export function interactionAuthorityFor(
  authority: ProfileAuthority,
  value: Omit<ProviderInteractionAuthority,
    | "profileId"
    | "processGeneration"
    | "provider"
    | "providerAccountId"
    | "bindingGeneration">,
): ProviderInteractionAuthority {
  return {
    ...value,
    profileId: authority.id,
    processGeneration: authority.generation,
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
  };
}

export async function createPeerMessageBoundaryFixture(delivery: "send" | "steer") {
  const value = await fixture();
  const { sessionId: actorSessionId } = await createIdleSession(
    value,
    `Peer ${delivery} boundary actor`,
  );
  const idleActor = value.store.requireSession(actorSessionId);
  if (idleActor.projectId === undefined) throw new Error("Expected a project-bound actor.");
  const targetBase = value.store.createSession({
    profileId: idleActor.profileId,
    projectId: idleActor.projectId,
    title: "Peer boundary target",
    provider: "codex",
    preset: "high",
    fastEnabled: false,
  });
  value.store.bindSessionProviderAccountAuthority({
    sessionId: targetBase.id,
    provider: "codex",
    runtimeScope: "managed",
    accountKey: codexProviderAccountKey(),
  });
  const target = value.store.bindSession({
    sessionId: targetBase.id,
    expectedRevision: targetBase.revision,
    providerThreadId: "provider-peer-boundary-target",
    state: delivery === "send" ? "idle" : "active",
    ...(delivery === "steer" ? { activeTurnId: "turn-peer-boundary-target" } : {}),
    providerUpdatedAt: 11,
  });
  await value.service.execute({
    kind: "session.send",
    session: actorSessionId,
    message: "Start the independent peer boundary actor.",
  }, { signal });
  const actor = value.store.requireSession(actorSessionId);
  const profile = value.store.requireProfileById(actor.profileId);
  if (actor.providerThreadId === undefined || actor.activeTurnId === undefined) {
    throw new Error("Expected an active bound actor turn.");
  }
  const actorThreadId = actor.providerThreadId;
  const actorTurnId = actor.activeTurnId;
  value.codex.readProjection = {
    providerThreadId: "provider-peer-boundary-target",
    title: target.title,
    status: delivery === "send" ? "idle" : "active",
    ...(delivery === "steer" ? { activeTurnId: "turn-peer-boundary-target" } : {}),
    providerUpdatedAt: 11,
    omission: {
      hasMoreOlderTurns: false,
      incompleteTurnIds: [],
      omittedMessages: 0,
      returnedTurns: delivery === "send" ? 0 : 1,
      truncatedMessages: 0,
      turnLimit: 20,
      unreadItemTurnIds: [],
    },
  };
  const authority = liveAuthorityFor(value.store, profile.id);
  const callFor = (index: number): Extract<OompaHostToolCall, { tool: "session_message" }> => {
    const callId = `peer-boundary-${delivery}-${String(index)}`;
    const input = {
      sessionId: target.id,
      expectedRevision: value.store.requireSession(target.id).revision,
      delivery,
      message: `Peer boundary message ${String(index)}.`,
      reason: "Exercise exact peer effect settlement",
    };
    return {
      authority: hostToolAuthorityFor(authority),
      callId,
      connectionId: value.codex.observationConnectionId,
      input,
      requestDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      requestId: { type: "string", value: callId },
      threadId: actorThreadId,
      tool: "session_message",
      turnId: actorTurnId,
    };
  };
  return { value, actor, target, authority, callFor };
}

export function seedUnsettledInteractionStates(
  value: Awaited<ReturnType<typeof fixture>>,
  sessionId: `sess_${string}`,
  connectionId: string,
  prefix: string,
) {
  const session = value.store.requireSession(sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
  const providerThreadId = session.providerThreadId;
  const liveAuthority = liveAuthorityFor(value.store, profile.id);
  const admit = (state: "pending" | "prepared" | "written") => value.store.admitInteraction({
    publicId: crypto.randomUUID(),
    sessionId,
    authority: {
      profileId: profile.id,
      processGeneration: profile.processGeneration,
      provider: liveAuthority.provider,
      providerAccountId: liveAuthority.providerAccountId,
      bindingGeneration: liveAuthority.bindingGeneration,
      connectionId,
      requestId: { type: "string", value: `${prefix}-${state}` },
      method: "item/fileChange/requestApproval",
      requestDigest: createHash("sha256").update(`${prefix}-${state}`).digest("hex"),
      threadId: providerThreadId,
      turnId: `${prefix}-turn`,
      itemId: `${prefix}-${state}-item`,
      approvalId: null,
    },
    kind: "file_change_approval",
    blocking: true,
    display: {
      kind: "file_change_approval",
      summary: `Recover ${state} response state`,
      reason: null,
      grantRoot: null,
      availableDecisions: ["once" as const, "decline" as const, "cancel" as const],
    },
  }).record;
  const pending = admit("pending");
  const prepared = value.store.prepareInteractionResponse({
    id: admit("prepared").publicId,
    expectedRevision: 1,
    responseDigest: "a".repeat(64),
  });
  const preparedForWrite = value.store.prepareInteractionResponse({
    id: admit("written").publicId,
    expectedRevision: 1,
    responseDigest: "b".repeat(64),
  });
  const written = value.store.markInteractionResponseWritten({
    id: preparedForWrite.publicId,
    expectedRevision: preparedForWrite.revision,
    responseDigest: "b".repeat(64),
  });
  return { pending, prepared, written, profile, session };
}

export async function seedResolvableInteraction(
  value: Awaited<ReturnType<typeof fixture>> & Readonly<{ personalCodex?: FakeCodex }>,
  sessionId: SessionRecord["id"],
  requestId: string,
  timing?: Readonly<{ requestedAt: number; deadlineAt: number }>,
  source: "managed" | "personal" = "managed",
): Promise<Readonly<{
  authority: ProfileAuthority;
  interaction: InteractionRecord;
}>> {
  const session = value.store.requireSession(sessionId);
  const profile = value.store.requireProfileById(session.profileId);
  if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
  const personalCodex = source === "personal" ? value.personalCodex : undefined;
  const personalClaim = personalCodex?.claimRequests.findLast((request) =>
    request.providerThreadId === session.providerThreadId);
  if (source === "personal" && personalClaim === undefined) {
    throw new Error("Expected exact personal Codex claim authority.");
  }
  const connectionId = personalCodex?.observationConnectionId
    ?? value.codex.observationConnectionId;
  const authority: ProfileAuthority = personalClaim?.authority ?? liveAuthorityFor(value.store, profile.id);
  const fact: CodexFact = {
    type: "interactionRequested",
    connectionId,
    provider: interactionAuthorityFor(authority, {
      connectionId,
      requestId: { type: "string", value: requestId },
      method: "item/commandExecution/requestApproval",
      requestDigest: createHash("sha256").update(requestId).digest("hex"),
      threadId: session.providerThreadId,
      turnId: `turn-${requestId}`,
      itemId: `item-${requestId}`,
      approvalId: null,
    }),
    kind: "command_approval",
    blocking: true,
    display: {
      kind: "command_approval",
      summary: "Exercise the persistence boundary",
      reason: null,
      commandClass: "test",
      workingDirectory: null,
      availableDecisions: ["once", "decline", "cancel"],
    },
    ...(timing === undefined ? {} : timing),
  };
  if (source === "personal") {
    await value.service.observePersonalCodexFact(authority, fact);
  } else {
    await value.service.observeCodexFact(authority, fact);
  }
  const interaction = value.store.listInteractions({
    sessionId,
    pendingOnly: true,
    limit: 10,
  }).find((candidate) => candidate.authority.requestId.value === requestId);
  if (interaction === undefined) throw new Error("Expected a resolvable interaction.");
  return { authority, interaction };
}

export const providerMutationCalls = (codex: FakeCodex): readonly string[] => codex.calls.filter(
  (call) => call.startsWith("login:") || call.startsWith("start:") || call === "logout" || call === "send" || call === "steer" || call === "stop" || call === "rename",
);

export const signal = new AbortController().signal;

export const automaticResetWindowResetsAtSeconds = Math.floor(Date.now() / 1_000)
  + 3 * 24 * 60 * 60;

export const automaticResetWindowResetsAt = automaticResetWindowResetsAtSeconds * 1_000;

export const renderHuman = (command: LocalCommand, data: unknown): string => {
  let stdout = "";
  renderSuccess(command, data, false, {
    writeStdout: (value) => { stdout += value; },
    writeStderr: () => undefined,
  });
  return stdout;
};

export const renderJson = (command: LocalCommand, data: unknown): string => {
  let stdout = "";
  renderSuccess(command, data, true, {
    writeStdout: (value) => { stdout += value; },
    writeStderr: () => undefined,
  });
  return stdout;
};

export const prepareAbandonedPeerScenario = async (
  delivery: "send" | "steer" | "queue",
  { createFixture, signal }: ServiceCaseContext,
) => {
  const value = await createFixture();
  signal.throwIfAborted();
  const { sessionId: actorId } = await createIdleSession(value, `Abandoned peer ${delivery} actor`);
  await value.service.execute({
    kind: "session.send",
    session: actorId,
    message: "Keep the original actor turn active.",
  }, { signal });
  const actor = value.store.requireSession(actorId);
  const actorProjection = value.codex.readProjection;
  const actorTurnId = actor.activeTurnId;
  if (actorTurnId === undefined) throw new Error("Expected an active original actor turn.");

  // Both sessions obtain their host capability through real session.start.
  // Separate managed profiles keep the fake's fixed thread name unambiguous.
  const targetAccount = await value.service.execute({
    kind: "account.add", label: `Abandoned peer ${delivery} target`,
  }, { signal }) as { account: { id: string } };
  await value.service.execute({
    kind: "account.login", account: targetAccount.account.id, deviceCode: false,
  }, { signal });
  const targetStarted = await value.service.execute({
    kind: "session.start", account: targetAccount.account.id, preset: "high", presetContract: 2, fast: false,
  }, { signal }) as { session: { id: `sess_${string}` } };
  const targetId = targetStarted.session.id;
  if (delivery === "steer") {
    await value.service.execute({
      kind: "session.send",
      session: targetId,
      message: "Keep the receiving target turn active.",
    }, { signal });
  }
  const target = value.store.requireSession(targetId);
  return { value, actor, actorProjection, actorTurnId, target };
};

export async function terminalInputCustodyFixture(
  source: "provider_thread_deleted" | "provider_transport_lost" = "provider_thread_deleted",
  withInput = true,
) {
  const factsMemory = new FakeFactsMemoryLifecycle();
  const memory = new FakeMemory();
  const value = await fixture(new FakeCloud(), () => undefined,
    () => 1_800_000_000_000, factsMemory, {}, { memory });
  const { sessionId } = await createIdleSession(value, "Terminal local acknowledgment");
  const current = value.store.requireSession(sessionId);
  const authority = value.store.requireProviderAccountAuthority(current.profileId, "codex");
  const runtime = value.store.latestSessionRuntimeProfile(sessionId)?.profile;
  if (current.providerThreadId === undefined || runtime === undefined) throw new Error("Expected an exact current runtime.");
  const reference = { digest: "a".repeat(64), name: "retained.txt", byteLength: 4, mediaType: "text/plain" as const };
  let attemptId: ReturnType<StateStore["prepareSessionInputMutation"]>["attempt"]["id"] | undefined;
  let idempotencyKey: string | undefined;
  if (withInput) {
    idempotencyKey = crypto.randomUUID();
    const input = {
      kind: "session.send" as const, sessionId, providerAuthority: authority,
      idempotencyKey, message: "Retained terminal input", attachments: [reference],
      daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId,
    };
    const reservation = value.store.reserveAttachmentIngress(input);
    if (reservation.kind !== "reserved") throw new Error("Expected a current reservation.");
    const prepared = value.store.prepareSessionInputMutation({ ...input, reservation });
    if (prepared.custody.kind !== "mutation_owned") throw new Error("Expected current mutation custody.");
    attemptId = prepared.attempt.id;
    const stored = [{ ...reference, canonicalMediaType: reference.mediaType }];
    value.store.beginSessionMutationEffect({
      attemptId, sessionId, providerAuthority: authority, profileGeneration: authority.processGeneration,
      daemonGeneration: value.daemonGeneration, bootId: value.daemonBootId,
      message: input.message, attachments: stored,
      custody: { custodyId: prepared.custody.custodyId, custodyDigest: prepared.custody.custodyDigest },
      transcript: { accountId: current.profileId, providerGeneration: authority.processGeneration,
        providerConnectionId: crypto.randomUUID(), actor: "human", message: input.message,
        attachments: [reference], storedAttachments: stored },
      evidence: { kind: "session.send", providerThreadId: current.providerThreadId,
        baseline: { status: "idle", activeTurnId: null, providerUpdatedAt: current.providerUpdatedAt ?? null },
        clientMessageId: attemptId, messageDigest: createHash("sha256").update(input.message).digest("hex"),
        messageActor: "human", runtimeProfile: runtime },
    });
  }
  value.store.terminalizeSessionFromProviderDeletion({
    sessionId, accountId: current.profileId, providerGeneration: authority.processGeneration,
    providerAuthority: authority, providerConnectionId: null, source,
  });
  const terminal = value.store.requireSession(sessionId);
  expect(terminal.state).toBe("terminal");
  // Actual service-created memory is still active after the direct storage
  // terminalization. A newly composed service has a pending cleanup scan.
  const memoryReceipt = factsMemory.readSession(sessionId);
  expect(memoryReceipt).toMatchObject({ state: "active", ownerId: current.profileId });
  const daemonAuthority = new FakeDaemonAuthority();
  const afterResponse: Array<() => void> = [];
  let stopCalls = 0;
  const local = new OompaService({
    store: value.store, paths: value.paths, codex: value.codex, cloud: value.cloud,
    daemonAuthority, daemonGeneration: value.daemonGeneration, daemonBootId: value.daemonBootId,
    factsMemory, memory, now: () => 1_800_000_000_000, requestStop: () => { stopCalls++; },
  });
  const callsBefore = {
    provider: [...value.codex.calls], ensures: [...factsMemory.ensures],
    cleanups: [...factsMemory.cleanups], sweeps: [...factsMemory.sweeps],
    transfers: [...factsMemory.transfers], forgotten: [...memory.forgottenSessions],
  };
  const assertNoExternalWork = () => {
    expect(value.codex.calls).toEqual(callsBefore.provider);
    expect(factsMemory.ensures).toEqual(callsBefore.ensures);
    expect(factsMemory.cleanups).toEqual(callsBefore.cleanups);
    expect(factsMemory.sweeps).toEqual(callsBefore.sweeps);
    expect(factsMemory.transfers).toEqual(callsBefore.transfers);
    expect(memory.forgottenSessions).toEqual(callsBefore.forgotten);
    expect(factsMemory.readSession(sessionId)).toEqual(memoryReceipt);
  };
  value.cloud.beforeProjectionUnsettledSessionReturn = async () => { throw new Error("Local acknowledgment must not inspect cloud authority."); };
  value.cloud.beforeProjectionUnsettledProfileReturn = async () => { throw new Error("Local acknowledgment must not inspect cloud authority."); };
  return { ...value, local, terminal, reference, attemptId, idempotencyKey, factsMemory,
    daemonAuthority, afterResponse, stopCalls: () => stopCalls, assertNoExternalWork };
}
