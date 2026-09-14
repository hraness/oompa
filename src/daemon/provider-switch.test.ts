import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonical39SwitchDatabaseBytes,
  canonical39SwitchFixtures,
  type Canonical39SwitchScenario,
} from "../../scripts/fixtures/canonical39-switch";
import { provisionMigratedStateTemplate } from "../../scripts/fixtures/migrated-state-template";
import { CLAUDE_PIN, CLAUDE_PIN_MODEL } from "../claude/pin";
import { IndeterminateCodexEffectError, type OompaHostToolCall } from "../codex";
import { OOMPA_SESSION_PREAMBLE } from "../domain/oompa-preamble";
import {
  activePresetBinding,
  currentPresetContract,
  legacyPresetContract,
  providerSwitchRequiresPresetContract,
  sharedActiveCodexPresetContract,
  type Preset,
  type PresetContract,
} from "../domain/presets";
import { ClaudeError, IndeterminateClaudeEffectError } from "../claude/errors";
import { presetRequirementForContract, type PresetRequirement } from "../domain/presets";
import type {
  EffectiveClaudeRuntimeProfile,
  EffectiveRuntimeProfile,
} from "../domain/runtime-profile";
import {
  renderTranscriptSeed,
  digestTranscriptSeed,
  sessionTranscriptSchema,
  TRANSCRIPT_SEED_HEADER,
  type SessionTranscript,
} from "../domain/transcript";
import {
  oompaTrajectoryExportContextSchema,
  transcriptToTrajectory,
  trajectoryRecordSchema,
} from "../domain/trajectory";
import { initializeStatePaths, resolveStatePaths } from "../storage/paths";
import { SessionSwitchStoreError, sessionProviderSwitchMutationRequest, sessionStartMutationRequest, StateStore } from "../storage/state-store";
import {
  ClaudeProcessExitUnprovenError,
  ClaudeSessionObservationError,
  CodexSessionObservationError,
  UnavailableCloudControl,
  type ClaudeProcessIdentity,
  type ClaudeRuntimePort,
  type ClaudeAccountReadinessProjection,
  type ClaudeRuntimeStartReview,
  type CodexAccountProjection,
  type CodexLoginOutcome,
  type CodexRuntimePort,
  type CodexSessionObservation,
  type CodexSessionProjection,
  type CompactProjectionRecoveryBlocker,
  type ProfileAuthority,
  type RuntimeStartReview,
} from "./ports";
import { DaemonAuthoritySafetyError, type DaemonAuthorityFence } from "./daemon-lock";
import type {
  OompaFactsMemoryLifecyclePort,
  OompaFactsMemoryLifecycleReceipt,
} from "./facts-memory-lifecycle";
import { CommandFailure, OompaService } from "./service";

const signal = new AbortController().signal;

const codexProfile = (
  authority: ProfileAuthority,
  preset: Preset,
  requirement?: PresetRequirement,
): EffectiveRuntimeProfile => {
  if (requirement?.effort === "provider-default") {
    throw new Error("A Codex fixture cannot use Devin's provider-default effort.");
  }
  return {
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset,
  model: requirement?.model ?? (preset === "low" ? "gpt-5.6-luna" : "gpt-6-astra"),
  reasoningEffort: requirement?.effort ?? (preset === "ultra" ? "ultra" : "max"),
  serviceTier: null,
  fast: false,
  approvalPolicy: "on-request",
  reviewMode: "auto_review",
  permissionProfile: ":workspace",
  computerUse: true,
  pluginCapability: true,
  enabledApps: [],
  };
};

const claudeProfile = (authority: ProfileAuthority): EffectiveClaudeRuntimeProfile => ({
  profileId: authority.id,
  processGeneration: authority.generation,
  observedAt: 2_000,
  preset: "fable-max",
  model: CLAUDE_PIN_MODEL,
  reasoningEffort: "max",
  claudeVersion: CLAUDE_PIN,
  permissionMode: "default",
  isolatedConfigDir: true,
  outputFormat: "stream-json",
  inputFormat: "stream-json",
});

/** A Codex seam that starts sessions and turns and records every call. */
class SwitchFakeCodex implements CodexRuntimePort {
  readonly provider = "codex" as const;
  discardRuntimeReview(): void {}
  readonly calls: string[] = [];
  readonly endedThreads: string[] = [];
  loginCalls = 0;
  beforeLogoutReturn?: () => Promise<void> | void;
  sessionStartRequirement?: Parameters<CodexRuntimePort["reviewSessionStart"]>[0]["requirement"];
  endSessionError?: Error;
  readAccountCalls = 0;
  turnStatus: "completed" | "inProgress" = "completed";
  endSessionErrorOnce?: Error;
  beforeEndSessionReturn?: (
    input: Parameters<CodexRuntimePort["endSession"]>[0],
  ) => Promise<void> | void;
  accountProjection: CodexAccountProjection = {
    signedIn: true,
    email: "person@example.com",
  };
  #turns = 0;
  projection: CodexSessionProjection = {
    providerThreadId: "codex-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 10,
  };

  async login(): Promise<CodexLoginOutcome> {
    this.loginCalls += 1;
    return { status: "signed_in", account: { signedIn: true, email: "person@example.com" } };
  }
  async readAccount(): Promise<CodexAccountProjection> {
    this.readAccountCalls += 1;
    return this.accountProjection;
  }
  async releaseOwnedAuthority(): Promise<void> {}
  async logout(): Promise<void> {
    this.calls.push("logout");
    await this.beforeLogoutReturn?.();
  }
  async close(): Promise<void> {}
  async reviewSessionStart(
    input: Parameters<CodexRuntimePort["reviewSessionStart"]>[0],
  ): Promise<RuntimeStartReview> {
    this.calls.push("review-session");
    this.sessionStartRequirement = input.requirement;
    return {
      reviewId: crypto.randomUUID(),
      kind: "session_start",
      effectiveRuntimeProfile: codexProfile(input.authority, input.preset, input.requirement),
    };
  }
  async startSession(
    input: Parameters<CodexRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    this.calls.push("start-session");
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async observeSession(
    input: Parameters<CodexRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    return {
      connectionId: "30000000-0000-4000-8000-000000000001",
      projection: { ...this.projection, providerThreadId: input.providerThreadId },
      resumed: false,
    };
  }
  async readSession(): Promise<CodexSessionProjection> {
    this.calls.push("read");
    return this.projection;
  }
  async endSession(input: Parameters<CodexRuntimePort["endSession"]>[0]): Promise<void> {
    this.calls.push("end-session");
    if (this.endSessionError !== undefined) throw this.endSessionError;
    this.endedThreads.push(input.providerThreadId);
    await this.beforeEndSessionReturn?.(input);
    const error = this.endSessionErrorOnce;
    delete this.endSessionErrorOnce;
    if (error !== undefined) throw error;
  }
  async reviewTurnStart(
    input: Parameters<CodexRuntimePort["reviewTurnStart"]>[0],
  ): Promise<RuntimeStartReview> {
    this.calls.push("review-turn");
    return {
      reviewId: crypto.randomUUID(),
      kind: "turn_start",
      effectiveRuntimeProfile: codexProfile(input.authority, input.preset, input.requirement),
    };
  }
  async startTurn(
    input: Parameters<CodexRuntimePort["startTurn"]>[0],
  ): Promise<{
    turnId: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    effectiveRuntimeProfile: EffectiveRuntimeProfile;
  }> {
    this.calls.push("start-turn");
    this.#turns += 1;
    const turnId = `codex-turn-${String(this.#turns)}`;
    const status = this.turnStatus;
    this.projection = {
      ...this.projection,
      status: status === "inProgress" ? "active" : "idle",
      ...(status === "inProgress" ? { activeTurnId: turnId } : {}),
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 10) + 1,
    };
    if (status !== "inProgress") {
      delete (this.projection as { activeTurnId?: string }).activeTurnId;
    }
    return {
      turnId,
      status,
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }
  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> { this.calls.push("interrupt"); }
  #unsupported(): never { throw new Error("This fixture does not drive that Codex capability."); }
  cancelLogin(): Promise<never> { return Promise.reject(this.#unsupported()); }
  readUsage(): Promise<never> { return Promise.reject(this.#unsupported()); }
  consumeRateLimitReset(): Promise<never> { return Promise.reject(this.#unsupported()); }
  listPlugins(): Promise<never> { return Promise.reject(this.#unsupported()); }
  async listSessions(): ReturnType<CodexRuntimePort["listSessions"]> {
    this.calls.push("list");
    return { sessions: [], nextCursor: null };
  }
  rename(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectTurn(): Promise<never> { return Promise.reject(this.#unsupported()); }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unsupported()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

/** A Claude seam that accepts a switched-in session and its seeded turn. */
class SwitchFakeClaude implements ClaudeRuntimePort {
  readonly provider = "claude" as const;
  readonly pendingReviewIds = new Set<string>();
  discardRuntimeReview(review: ClaudeRuntimeStartReview): void {
    this.pendingReviewIds.delete(review.reviewId);
  }
  readonly calls: string[] = [];
  readonly claimRequests: Array<Parameters<ClaudeRuntimePort["claimSession"]>[0]> = [];
  readonly endRequests: Array<Parameters<ClaudeRuntimePort["endSession"]>[0]> = [];
  readonly endedProcessIdentities: ClaudeProcessIdentity[] = [];
  readonly identityRequests: Array<
    Parameters<ClaudeRuntimePort["readSessionProcessIdentity"]>[0]
  > = [];
  readonly observeRequests: Array<Parameters<ClaudeRuntimePort["observeSession"]>[0]> = [];
  readonly startSessionRequests: Array<Parameters<ClaudeRuntimePort["startSession"]>[0]> = [];
  readonly seededMessages: string[] = [];
  interactionAuthorityCalls = 0;
  readiness?: "signed_in" | "signed_out" | "unverified";
  beforeStartSessionAdmission?: (
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
  ) => Promise<void> | void;
  connectionId = "30000000-0000-4000-8000-000000000002";
  connectionIdOnClaim?: string;
  controllerLive = true;
  liveHostToolCall: OompaHostToolCall | null = null;
  disconnectOnObserveRequest?: number;
  processIdentity: ClaudeProcessIdentity = {
    pid: 64_001,
    pidDomain: "darwin",
    procStart: "switch-claude-initial",
  };
  processIdentityOnClaim?: ClaudeProcessIdentity;
  readonly endedThreads: string[] = [];
  readonly readSessionDetails: boolean[] = [];
  sessionStartRequirement?: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0]["requirement"];
  accountSignedIn = true;
  accountIdentityReadCalls = 0;
  readonly accountSignedInResults: boolean[] = [];
  beforeReadAccountReturn?: () => Promise<void>;
  beforeClaimSessionReturn?: () => Promise<void> | void;
  readAccountError?: Error;
  activateError?: Error;
  observeError?: Error;
  endSessionError?: Error;
  reviewProfileGenerationOffset = 0;
  omitProcessIdentityOnClaim = false;
  observationThreadIdOverride?: string;
  onActivate?: (
    input: Parameters<NonNullable<ClaudeRuntimePort["activateSessionHostTools"]>>[0],
  ) => void | Promise<void>;
  startSessionError?: Error;
  startTurnError?: Error;
  endSessionErrorOnce?: Error;
  beforeStartSessionReturn?: (
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
    projection: CodexSessionProjection,
  ) => Promise<void> | void;
  beforeReviewSessionReturn?: (
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ) => Promise<void> | void;
  beforeStartTurnReturn?: (
    input: Parameters<ClaudeRuntimePort["startTurn"]>[0],
  ) => Promise<void> | void;
  beforeReviewTurnReturn?: (
    input: Parameters<ClaudeRuntimePort["reviewTurnStart"]>[0],
  ) => Promise<void> | void;
  turnStatus: "completed" | "inProgress" = "completed";
  #turns = 0;
  readonly #writers = new Map<string, ClaudeProcessIdentity>();
  #nextPid = 64_002;

  #writerKey(authority: ProfileAuthority, providerThreadId: string): string {
    return JSON.stringify([authority.id, authority.providerAccountId,
      authority.bindingGeneration, authority.generation, providerThreadId]);
  }
  projection: CodexSessionProjection = {
    providerThreadId: "claude-thread-1",
    title: "New session",
    status: "idle",
    providerUpdatedAt: 20,
  };

  pinnedVersion(): string { return CLAUDE_PIN; }
  rebindProfileAuthority(): void {
    throw new Error("Unexpected fake Claude authority rebind.");
  }
  async readAccount(): Promise<ClaudeAccountReadinessProjection> {
    this.calls.push("read-account");
    await this.beforeReadAccountReturn?.();
    if (this.readAccountError !== undefined) throw this.readAccountError;
    const signedIn = this.accountSignedInResults.shift() ?? this.accountSignedIn;
    return { readiness: this.readiness ?? (signedIn ? "signed_in" : "signed_out"), observedAt: 2_000 };
  }
  async readProviderAccountIdentity(): Promise<CodexAccountProjection> {
    this.accountIdentityReadCalls += 1;
    if (this.readAccountError !== undefined) throw this.readAccountError;
    return this.accountSignedIn
      ? { signedIn: true, accountId: "claude-account", organizationId: "claude-organization", email: "person@example.com" }
      : { signedIn: false };
  }
  async close(): Promise<void> {
    this.endedProcessIdentities.push(...this.#writers.values());
    this.#writers.clear();
    this.controllerLive = false;
  }
  async reviewSessionStart(
    input: Parameters<ClaudeRuntimePort["reviewSessionStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-session");
    await this.beforeReviewSessionReturn?.(input);
    this.sessionStartRequirement = input.requirement;
    const review = {
      reviewId: crypto.randomUUID(),
      kind: "session_start" as const,
      effectiveRuntimeProfile: {
        ...claudeProfile(input.authority),
        processGeneration: input.authority.generation + this.reviewProfileGenerationOffset,
      },
    };
    this.pendingReviewIds.add(review.reviewId);
    return review;
  }
  async startSession(
    input: Parameters<ClaudeRuntimePort["startSession"]>[0],
  ): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile }> {
    this.calls.push("start-session");
    this.startSessionRequests.push(input);
    this.pendingReviewIds.delete(input.review.reviewId);
    if (this.startSessionError !== undefined) throw this.startSessionError;
    if (input.providerThreadId !== undefined) {
      this.projection = { ...this.projection, providerThreadId: input.providerThreadId };
    }
    if ([...this.#writers.values()].some((identity) => identity.pid === this.processIdentity.pid)) {
      this.processIdentity = {
        pid: this.#nextPid++, pidDomain: "darwin",
        procStart: `switch-claude-child-${String(this.#nextPid)}`,
      };
    }
    await this.beforeStartSessionAdmission?.(input);
    await input.admitProcessIdentity?.(this.processIdentity);
    this.#writers.set(this.#writerKey(input.authority, this.projection.providerThreadId), this.processIdentity);
    await this.beforeStartSessionReturn?.(input, this.projection);
    this.controllerLive = true;
    return { ...this.projection, effectiveRuntimeProfile: input.review.effectiveRuntimeProfile };
  }
  async claimSession(
    input: Parameters<ClaudeRuntimePort["claimSession"]>[0],
  ): ReturnType<ClaudeRuntimePort["claimSession"]> {
    this.calls.push("claim-session");
    this.claimRequests.push(input);
    this.controllerLive = true;
    if (this.processIdentityOnClaim !== undefined) {
      this.processIdentity = this.processIdentityOnClaim;
      delete this.processIdentityOnClaim;
    }
    if (this.connectionIdOnClaim !== undefined) {
      this.connectionId = this.connectionIdOnClaim;
      delete this.connectionIdOnClaim;
    }
    if (!this.omitProcessIdentityOnClaim) {
      await input.admitProcessIdentity?.(this.processIdentity);
      this.#writers.set(this.#writerKey(input.authority, input.providerThreadId), this.processIdentity);
    }
    await this.beforeClaimSessionReturn?.();
    this.projection = {
      ...this.projection,
      providerThreadId: input.providerThreadId,
      projectRoot: input.projectRoot,
      status: "idle",
      title: input.title,
    };
    delete (this.projection as { activeTurnId?: string }).activeTurnId;
    return {
      ...this.projection,
      effectiveRuntimeProfile: claudeProfile(input.authority),
    };
  }
  async readSessionProcessIdentity(
    input: Parameters<ClaudeRuntimePort["readSessionProcessIdentity"]>[0],
  ): ReturnType<ClaudeRuntimePort["readSessionProcessIdentity"]> {
    this.calls.push("read-identity");
    this.identityRequests.push(input);
    const identity = this.#writers.get(this.#writerKey(input.authority, input.providerThreadId));
    if (identity === undefined) throw new Error("No exact fake Claude writer is owned.");
    return identity;
  }
  async activateSessionHostTools(
    input: Parameters<NonNullable<ClaudeRuntimePort["activateSessionHostTools"]>>[0],
  ): Promise<void> {
    this.calls.push("activate-host-tools");
    await this.onActivate?.(input);
    if (this.activateError !== undefined) throw this.activateError;
  }
  hasLiveHostToolCall(
    input: Parameters<NonNullable<ClaudeRuntimePort["hasLiveHostToolCall"]>>[0],
  ): boolean {
    const call = this.liveHostToolCall;
    return this.controllerLive
      && call !== null
      && this.projection.providerThreadId === input.providerThreadId
      && this.projection.activeTurnId === input.turnId
      && this.connectionId === input.connectionId
      && call.authority.profileId === input.authority.id
      && call.authority.processGeneration === input.authority.generation
      && call.threadId === input.providerThreadId
      && call.turnId === input.turnId
      && call.connectionId === input.connectionId
      && call.callId === input.callId
      && call.requestDigest === input.requestDigest;
  }
  async observeSession(
    input: Parameters<ClaudeRuntimePort["observeSession"]>[0],
  ): Promise<CodexSessionObservation> {
    this.calls.push("observe");
    this.observeRequests.push(input);
    if (this.observeError !== undefined) throw this.observeError;
    if (this.disconnectOnObserveRequest === this.observeRequests.length) {
      this.controllerLive = false;
      throw new ClaudeSessionObservationError();
    }
    if (!this.controllerLive) throw new ClaudeSessionObservationError();
    return {
      connectionId: this.connectionId,
      projection: {
        ...this.projection,
        providerThreadId: this.observationThreadIdOverride ?? input.providerThreadId,
      },
      resumed: false,
    };
  }
  async readSession(
    input: Parameters<ClaudeRuntimePort["readSession"]>[0],
  ): Promise<CodexSessionProjection> {
    this.calls.push("read");
    this.readSessionDetails.push(input.detail);
    if (input.detail) return this.projection;
    return {
      providerThreadId: this.projection.providerThreadId,
      title: this.projection.title,
      status: this.projection.status,
      ...(this.projection.providerUpdatedAt === undefined
        ? {}
        : { providerUpdatedAt: this.projection.providerUpdatedAt }),
      ...(this.projection.activeTurnId === undefined
        ? {}
        : { activeTurnId: this.projection.activeTurnId }),
    };
  }
  async endSession(
    input: Parameters<ClaudeRuntimePort["endSession"]>[0],
  ): Promise<void> {
    this.calls.push("end-session");
    if (this.endSessionError !== undefined) throw this.endSessionError;
    this.endRequests.push(input);
    this.endedThreads.push(input.providerThreadId);
    const error = this.endSessionErrorOnce;
    delete this.endSessionErrorOnce;
    if (error !== undefined) throw error;
    const writerKey = this.#writerKey(input.authority, input.providerThreadId);
    const identity = this.#writers.get(writerKey);
    if (identity !== undefined) this.endedProcessIdentities.push(identity);
    this.#writers.delete(writerKey);
    this.controllerLive = this.#writers.size > 0;
  }
  async reviewTurnStart(
    input: Parameters<ClaudeRuntimePort["reviewTurnStart"]>[0],
  ): Promise<ClaudeRuntimeStartReview> {
    this.calls.push("review-turn");
    await this.beforeReviewTurnReturn?.(input);
    const review = {
      reviewId: crypto.randomUUID(),
      kind: "turn_start" as const,
      effectiveRuntimeProfile: claudeProfile(input.authority),
    };
    this.pendingReviewIds.add(review.reviewId);
    return review;
  }
  async startTurn(
    input: Parameters<ClaudeRuntimePort["startTurn"]>[0],
  ): Promise<{
    turnId: string;
    status: "completed" | "interrupted" | "failed" | "inProgress";
    effectiveRuntimeProfile: EffectiveClaudeRuntimeProfile;
  }> {
    this.calls.push("start-turn");
    this.pendingReviewIds.delete(input.review.reviewId);
    if (this.startTurnError instanceof ClaudeError
      && !(this.startTurnError instanceof IndeterminateClaudeEffectError)) throw this.startTurnError;
    this.seededMessages.push(input.message);
    if (this.startTurnError !== undefined) throw this.startTurnError;
    this.#turns += 1;
    const turnId = `claude-turn-${String(this.#turns)}`;
    this.projection = {
      ...this.projection,
      status: this.turnStatus === "inProgress" ? "active" : "idle",
      ...(this.turnStatus === "inProgress" ? { activeTurnId: turnId } : {}),
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 20) + 1,
    };
    if (this.turnStatus !== "inProgress") {
      delete (this.projection as { activeTurnId?: string }).activeTurnId;
    }
    await this.beforeStartTurnReturn?.(input);
    return {
      turnId,
      status: this.turnStatus,
      effectiveRuntimeProfile: input.review.effectiveRuntimeProfile,
    };
  }
  async steer(): Promise<void> { this.calls.push("steer"); }
  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
    this.projection = {
      ...this.projection,
      status: "idle",
      providerUpdatedAt: (this.projection.providerUpdatedAt ?? 20) + 1,
    };
    delete (this.projection as { activeTurnId?: string }).activeTurnId;
  }
  #unsupported(): never { throw new Error("This fixture does not drive that Claude capability."); }
  interactionAuthority(): never {
    this.interactionAuthorityCalls += 1;
    return this.#unsupported();
  }
  inspectInteractionAuthority(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionResolution(): Promise<never> { return Promise.reject(this.#unsupported()); }
  resolveInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
  validateInteractionTimeout(): Promise<never> { return Promise.reject(this.#unsupported()); }
  timeoutInteraction(): Promise<never> { return Promise.reject(this.#unsupported()); }
}

class OfflineCloud extends UnavailableCloudControl {
  constructor() {
    super({
      isCompactProjectionRecoveryUnsettled: async () => false,
      isCompactProjectionRecoveryUnsettledForProfile: async () => false,
      supersedeCompactProjectionRecoveryForProviderDeletion: async () => ({ superseded: false }),
      supersedeTerminalCompactProjectionRecoveries: async () => ({ superseded: 0 }),
    } satisfies CompactProjectionRecoveryBlocker as CompactProjectionRecoveryBlocker);
  }
}

class SwitchDaemonAuthority {
  beforeAssertReturn?: () => Promise<void> | void;

  constructor(readonly delegate?: Pick<DaemonAuthorityFence, "assertCurrent" | "close">) {}

  async assertCurrent(): Promise<void> {
    if (this.delegate !== undefined) await this.delegate.assertCurrent();
    const hook = this.beforeAssertReturn;
    delete this.beforeAssertReturn;
    await hook?.();
  }

  close(): void { this.delegate?.close(); }
}

class SwitchFactsMemory implements OompaFactsMemoryLifecyclePort {
  readonly ensures: Array<Parameters<OompaFactsMemoryLifecyclePort["ensureSession"]>[0]> = [];
  readonly cleanups: Array<Parameters<OompaFactsMemoryLifecyclePort["cleanupSession"]>[0]> = [];
  readonly transfers: Array<Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0]> = [];
  readonly transferSourceStates: Array<"active" | "purged" | undefined> = [];
  readonly expiries = new Map<string, number>();
  readonly owners = new Map<string, string>();
  readonly states = new Map<string, "active" | "purged">();
  simulateExpiry = false;
  beforeTransferReturn?: (
    input: Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0],
  ) => Promise<void> | void;
  transferErrorOnce?: Error;

  #receipt(sessionId: string, state: "active" | "purged" = "active"):
    OompaFactsMemoryLifecycleReceipt {
    return {
      bindingDigest: "a".repeat(64),
      epoch: 1,
      handleHash: state === "active" ? "b".repeat(64) : null,
      head: state === "active"
        ? { digest: "c".repeat(64), operationSha256: null, sequence: 0 }
        : null,
      sessionId,
      ownerId: this.owners.get(sessionId) ?? "missing",
      state,
    };
  }

  async cleanupSession(input: Parameters<OompaFactsMemoryLifecyclePort["cleanupSession"]>[0]) {
    this.cleanups.push(input);
    if (this.owners.get(input.sessionId) !== input.ownerId) {
      throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    }
    this.states.set(input.sessionId, "purged");
    return this.#receipt(input.sessionId, "purged");
  }

  async ensureSession(input: Parameters<OompaFactsMemoryLifecyclePort["ensureSession"]>[0]) {
    const owner = this.owners.get(input.sessionId);
    if (owner !== undefined && owner !== input.ownerId) throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    this.ensures.push(input);
    this.owners.set(input.sessionId, input.ownerId);
    this.states.set(input.sessionId, "active");
    this.expiries.set(
      input.sessionId,
      Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
    );
    return this.#receipt(input.sessionId);
  }

  readSession(sessionId: string): OompaFactsMemoryLifecycleReceipt | null {
    return this.owners.has(sessionId) ? this.#receipt(sessionId, this.states.get(sessionId)) : null;
  }

  async transferSessionOwner(
    input: Parameters<OompaFactsMemoryLifecyclePort["transferSessionOwner"]>[0],
  ) {
    this.transfers.push(input);
    this.transferSourceStates.push(this.states.get(input.sessionId));
    const error = this.transferErrorOnce;
    delete this.transferErrorOnce;
    if (error !== undefined) throw error;
    const owner = this.owners.get(input.sessionId);
    if (owner !== undefined && owner !== input.fromOwnerId && owner !== input.toOwnerId) {
      throw new Error("FACTS_MEMORY_AUTHORITY_MISMATCH");
    }
    this.owners.set(input.sessionId, input.toOwnerId);
    this.states.set(input.sessionId, "active");
    this.expiries.set(
      input.sessionId,
      Math.max(this.expiries.get(input.sessionId) ?? 0, input.expiresAt),
    );
    const hook = this.beforeTransferReturn;
    delete this.beforeTransferReturn;
    await hook?.(input);
    return this.#receipt(input.sessionId);
  }

  async forkSession(input: Parameters<OompaFactsMemoryLifecyclePort["forkSession"]>[0]) {
    this.owners.set(input.childSessionId, input.ownerId);
    return this.#receipt(input.childSessionId);
  }

  async resumeSession(input: Parameters<OompaFactsMemoryLifecyclePort["resumeSession"]>[0]) {
    return this.#receipt(input.sessionId);
  }

  async sweepExpired(now: number) {
    let purged = 0;
    if (this.simulateExpiry) {
      for (const [sessionId, expiresAt] of this.expiries) {
        if (this.states.get(sessionId) === "active" && expiresAt <= now) {
          this.states.set(sessionId, "purged");
          purged += 1;
        }
      }
    }
    return { attempted: purged, failed: 0, purged };
  }
}

const stores: StateStore[] = [];
const roots: string[] = [];
const services: OompaService[] = [];
const ownedSwitchCaseTeardowns: Array<() => Promise<void>> = [];

type SwitchCaseResources = {
  roots: string[];
  stores: Array<Pick<StateStore, "close">>;
  services: Array<Pick<OompaService, "close">>;
};

function createOwnedSwitchCase(teardowns = ownedSwitchCaseTeardowns) {
  const resources: SwitchCaseResources = { roots: [], stores: [], services: [] };
  const controller = new AbortController();
  const cancellation = new Error("Owned switch case is closing.");
  const tasks: Array<Promise<{ status: "fulfilled" } | { status: "rejected"; reason: unknown }>> = [];
  let closing: Promise<void> | undefined;
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    controller.signal.throwIfAborted();
    const result = await operation();
    controller.signal.throwIfAborted();
    return result;
  };
  const run = (operation: () => Promise<void>): Promise<void> => {
    // Register and observe the raw hook/test task before it can open resources.
    // Return this exact promise to Bun so a deadline cannot detach its work.
    const task = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted();
      await operation();
      controller.signal.throwIfAborted();
    });
    tasks.push(task.then(
      () => ({ status: "fulfilled" } as const),
      (reason: unknown) => ({ status: "rejected", reason } as const),
    ));
    return task;
  };
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    controller.abort(cancellation);
    closing = (async () => {
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
      if (serviceCloseFailed) throw new AggregateError(failures, "Switch service close failed; owned storage was retained.");
      let storeCloseFailed = false;
      for (const store of resources.stores.splice(0)) {
        try { store.close(); } catch (error: unknown) {
          storeCloseFailed = true;
          failures.push(error);
        }
      }
      if (storeCloseFailed) throw new AggregateError(failures, "Switch store close failed; owned roots were retained.");
      for (const root of resources.roots.splice(0)) {
        try { await rm(root, { force: true, recursive: true }); } catch (error: unknown) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, "Owned switch teardown failed.");
    })();
    return closing;
  };
  teardowns.push(close);
  return { close, request, resources, run, signal: controller.signal };
}

afterEach(async () => {
  // Capture this case's resources before awaiting; late teardown must never
  // consume the next case's fixtures from the shared compatibility arrays.
  const caseTeardowns = ownedSwitchCaseTeardowns.splice(0);
  const caseServices = services.splice(0);
  const caseStores = stores.splice(0);
  const caseRoots = roots.splice(0);
  await Promise.all(caseTeardowns.map((close) => close()));
  await Promise.all(caseServices.map(async (service) => { await service.close(); }));
  for (const store of caseStores) store.close();
  await Promise.all(caseRoots.map(async (root) => rm(root, { force: true, recursive: true })));
});

describe("owned switch case lifecycle", () => {
  test("cancels before deferred setup can open resources", async () => {
    const owner = createOwnedSwitchCase([]);
    let opened = false;
    const task = owner.run(async () => { opened = true; });
    const closing = owner.close();
    expect(owner.close()).toBe(closing);
    await closing;
    await expect(task).rejects.toBe(owner.signal.reason);
    expect(opened).toBe(false);
  });

  test("checks cancellation in the microtask gap before prepared-state publication", async () => {
    const owner = createOwnedSwitchCase([]);
    const holder: { value?: string } = {};
    let closing: Promise<void> | undefined;
    const setup = owner.run(async () => {
      const finalRequest = owner.request(async () => "prepared");
      // Registered before the await continuation: request() has completed its
      // own cancellation check, but publication has not happened yet.
      void finalRequest.then(() => {
        closing = owner.close();
        void closing.catch(() => undefined);
      }, () => undefined);
      const value = await finalRequest;
      owner.signal.throwIfAborted();
      holder.value = value;
    });
    const failure = await setup.catch((error: unknown) => error);
    expect(failure).toBe(owner.signal.reason);
    expect(owner.signal.aborted).toBe(true);
    await closing;
    expect(holder.value).toBeUndefined();
  });

  test.each(["setup", "proof"] as const)("drains paused %s and late resources without closing the next case", async (phase) => {
    const owner = createOwnedSwitchCase([]);
    const nextOwner = createOwnedSwitchCase([]);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const events: string[] = [];
    if (phase === "proof") await owner.run(async () => undefined);
    owner.resources.services.push({ close: async () => { events.push("close-service"); } });
    owner.resources.stores.push({ close: () => { events.push("close-store"); } });
    nextOwner.resources.stores.push({ close: () => { events.push("close-next-store"); } });
    let observed: Promise<void> | undefined;
    const hook = () => {
      observed = owner.run(async () => {
        entered.resolve(undefined);
        await release.promise;
        owner.resources.services.push({ close: async () => { events.push("close-late-service"); } });
        owner.resources.stores.push({ close: () => { events.push("close-late-store"); } });
        events.push("raw-settled");
      });
      return observed;
    };
    const task = hook();
    expect<Promise<void> | undefined>(task).toBe(observed);
    await entered.promise;
    const closing = owner.close();
    await Promise.resolve();
    expect(events).toEqual([]);
    release.resolve(undefined);
    await closing;
    await expect(task).rejects.toBe(owner.signal.reason);
    expect(events).toEqual(["raw-settled", "close-service", "close-late-service", "close-store", "close-late-store"]);
    await nextOwner.close();
    expect(events.at(-1)).toBe("close-next-store");
  });

  test("preserves late failures and attempts every service close while retaining storage on close failure", async () => {
    const owner = createOwnedSwitchCase([]);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const lateFailure = new Error("late proof failure");
    const closeFailure = new Error("service close failure");
    const events: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "hra-switch-owner-"));
    roots.push(root);
    owner.resources.roots.push(root);
    owner.resources.services.push(
      { close: async () => { events.push("close-failed-service"); throw closeFailure; } },
      { close: async () => { events.push("close-other-service"); } },
    );
    owner.resources.stores.push({ close: () => { events.push("close-store"); } });
    const task = owner.run(async () => {
      entered.resolve(undefined);
      await release.promise;
      throw lateFailure;
    });
    await entered.promise;
    const closing = owner.close().catch((error: unknown) => error);
    release.resolve(undefined);
    const error = await closing;
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected late failure and close failure.");
    expect(error.errors).toEqual([lateFailure, closeFailure]);
    await expect(task).rejects.toBe(lateFailure);
    expect(events).toEqual(["close-failed-service", "close-other-service"]);
    expect(owner.resources.stores).toHaveLength(1);
    expect(owner.resources.roots).toEqual([root]);
  });

  test("attempts every store close but retains roots if any store cannot close", async () => {
    const owner = createOwnedSwitchCase([]);
    const closeFailure = new Error("store close failure");
    const events: string[] = [];
    const root = await mkdtemp(join(tmpdir(), "hra-switch-owner-"));
    roots.push(root);
    owner.resources.roots.push(root);
    owner.resources.stores.push(
      { close: () => { events.push("close-failed-store"); throw closeFailure; } },
      { close: () => { events.push("close-other-store"); } },
    );
    const error = await owner.close().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    if (!(error instanceof AggregateError)) throw new Error("Expected the store close failure.");
    expect(error.errors).toEqual([closeFailure]);
    expect(events).toEqual(["close-failed-store", "close-other-store"]);
    expect(owner.resources.roots).toEqual([root]);
  });
});

type Fixture = Readonly<{
  claude: SwitchFakeClaude;
  codex: SwitchFakeCodex;
  daemonAuthority: SwitchDaemonAuthority;
  documents: string;
  factsMemory: SwitchFactsMemory;
  factsMemoryEnabled: boolean;
  historicalSwitchRows: ReturnType<typeof readCanonical39SwitchRows> | undefined;
  daemonGeneration: number;
  daemonBootId: string;
  paths: ReturnType<typeof resolveStatePaths>;
  service: OompaService;
  store: StateStore;
}>;

async function fixturePaths(historical?: Canonical39SwitchScenario, resources: SwitchCaseResources = { roots, stores, services }) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "oompa-switch-")));
  resources.roots.push(home);
  const paths = resolveStatePaths({ homeDirectory: home, platform: "darwin" });
  const documents = join(home, "Documents");
  await mkdir(documents, { recursive: true });
  await initializeStatePaths(paths);
  // Import the exact archived image before any current StateStore constructor.
  if (historical !== undefined) {
    await Bun.write(paths.database, canonical39SwitchDatabaseBytes(historical));
    await chmod(paths.database, 0o600);
  }
  const historicalSwitchRows = historical === undefined ? undefined
    : readCanonical39SwitchRows(paths.database, canonical39SwitchFixtures[historical].retained.mutation.id);
  return { paths, documents, historicalSwitchRows };
}

async function fixture(
  nowOrAuthority: (() => number) | Pick<DaemonAuthorityFence, "assertCurrent" | "close"> = Date.now,
  cloud: OfflineCloud = new OfflineCloud(),
  factsMemoryEnabled = true,
  historical?: Canonical39SwitchScenario,
  resources: SwitchCaseResources = { roots, stores, services },
  provision: "migrate" | "template" = "migrate",
): Promise<Fixture> {
  const now = typeof nowOrAuthority === "function" ? nowOrAuthority : Date.now;
  const { paths, documents, historicalSwitchRows } = await fixturePaths(historical, resources);
  if (provision === "template") await provisionMigratedStateTemplate(paths);
  const store = new StateStore(paths);
  resources.stores.push(store);
  const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(daemonBootId);
  store.setDefaultApprovalMode("manual");
  const codex = new SwitchFakeCodex();
  const claude = new SwitchFakeClaude();
  const daemonAuthority = new SwitchDaemonAuthority(
    typeof nowOrAuthority === "function" ? undefined : nowOrAuthority,
  );
  const factsMemory = new SwitchFactsMemory();
  const service = new OompaService({
    claude,
    claudeProcessLiveness: (identity) => Promise.resolve(claude.endedProcessIdentities.some((ended) =>
      ended.pid === identity.pid && ended.pidDomain === identity.pidDomain
      && ended.procStart === identity.procStart) ? "not_live" : "unknown"),
    cloud,
    codex,
    daemonAuthority,
    ...(factsMemoryEnabled ? { factsMemory } : {}),
    now,
    daemonGeneration,
    daemonBootId,
    paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
  });
  resources.services.push(service);
  return { claude, codex, daemonAuthority, daemonGeneration, daemonBootId, documents, factsMemory, factsMemoryEnabled, historicalSwitchRows, paths, service, store };
}

function liveAuthorityFor(
  store: StateStore,
  profileSelector: string,
  provider: "codex" | "claude" = "codex",
): ProfileAuthority {
  const profile = store.requireProfile(profileSelector);
  const authority = store.requireProviderAccountAuthority(profile.id, provider);
  return {
    id: authority.profileId,
    generation: authority.processGeneration,
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
    codexHome: "unused",
    desktopUserData: "unused",
  };
}

function capturedAuthorityForSession(
  store: StateStore,
  sessionId: string,
): ProfileAuthority {
  const authority = store.requireCapturedSessionProviderAuthority(sessionId as `sess_${string}`);
  return {
    id: authority.profileId,
    generation: authority.processGeneration,
    provider: authority.provider,
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
    codexHome: "unused",
    desktopUserData: "unused",
  };
}

async function reopenFixture(value: Fixture): Promise<Fixture> {
  await value.service.close();
  const storeIndex = stores.indexOf(value.store);
  if (storeIndex < 0) throw new Error("Expected the provider-switch store to be tracked.");
  value.store.close();
  stores.splice(storeIndex, 1);

  const store = new StateStore(value.paths);
  stores.push(store);
  const daemonBootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;
  const daemonGeneration = store.nextDaemonGeneration(daemonBootId);
  const codex = new SwitchFakeCodex();
  const claude = new SwitchFakeClaude();
  const daemonAuthority = new SwitchDaemonAuthority();
  const factsMemory = value.factsMemory;
  const service = new OompaService({
    claude,
    claudeProcessLiveness: (identity) => Promise.resolve(claude.endedProcessIdentities.some((ended) =>
      ended.pid === identity.pid && ended.pidDomain === identity.pidDomain
      && ended.procStart === identity.procStart) ? "not_live" : "unknown"),
    cloud: new OfflineCloud(),
    codex,
    daemonAuthority,
    ...(value.factsMemoryEnabled ? { factsMemory } : {}),
    daemonGeneration,
    daemonBootId,
    paths: value.paths,
    platform: "linux",
    requestStop: () => undefined,
    store,
  });
  services.push(service);
  await service.recover();
  return {
    claude,
    codex,
    daemonAuthority,
    daemonGeneration,
    daemonBootId,
    factsMemory,
    factsMemoryEnabled: value.factsMemoryEnabled,
    historicalSwitchRows: value.historicalSwitchRows,
    documents: value.documents,
    paths: value.paths,
    service,
    store,
  };
}

async function codexSession(value: Fixture, requestSignal = signal): Promise<Readonly<{
  accountId: `acct_${string}`;
  sessionId: `sess_${string}`;
}>> {
  requestSignal.throwIfAborted();
  const added = await value.service.execute(
    { kind: "account.add", label: "Work" },
    { signal: requestSignal },
  ) as { account: { id: `acct_${string}` } };
  requestSignal.throwIfAborted();
  await value.service.execute(
    { account: added.account.id, deviceCode: false, kind: "account.login" },
    { signal: requestSignal },
  );
  requestSignal.throwIfAborted();
  await value.service.execute(
    { kind: "project.add", label: "Work docs", path: value.documents },
    { signal: requestSignal },
  );
  requestSignal.throwIfAborted();
  const started = await value.service.execute(
    { account: added.account.id, fast: false, kind: "session.start", preset: "high", presetContract: 2 },
    { signal: requestSignal },
  ) as { session: { id: `sess_${string}` } };
  requestSignal.throwIfAborted();
  return { accountId: added.account.id, sessionId: started.session.id };
}

async function claudeSession(value: Fixture): Promise<Readonly<{
  accountId: `acct_${string}`;
  sessionId: `sess_${string}`;
}>> {
  const added = await value.service.execute(
    { kind: "account.add", label: "Claude work" },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { kind: "project.add", label: "Claude work docs", path: value.documents },
    { signal },
  );
  const started = await value.service.execute(
    {
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    },
    { signal },
  ) as { session: { id: `sess_${string}` } };
  return { accountId: added.account.id, sessionId: started.session.id };
}

async function signedInCodexAccount(
  value: Fixture,
  label: string,
): Promise<`acct_${string}`> {
  const added = await value.service.execute(
    { kind: "account.add", label },
    { signal },
  ) as { account: { id: `acct_${string}` } };
  await value.service.execute(
    { account: added.account.id, deviceCode: false, kind: "account.login" },
    { signal },
  );
  return added.account.id;
}

const transcriptOf = async (
  value: Fixture,
  sessionId: string,
): Promise<SessionTranscript> => sessionTranscriptSchema.parse(await value.service.execute(
  { kind: "session.transcript", limit: 500, session: sessionId },
  { signal },
));

/**
 * Writes the released seed-before-release protocol explicitly, under current
 * exact account fences. This isolates its retained recovery algorithm from new
 * dispatch; schema-38 migration evidence is covered by storage upgrade tests.
 */
async function recordHistoricalSwitchProgress(
  value: Fixture,
  input: Readonly<{
    account?: `acct_${string}`;
    idempotencyKey: string;
    provider: "codex" | "claude";
    preset?: "low" | "high" | "fable-max";
    providerThreadId?: string;
    session: `sess_${string}`;
    stage: "target_started" | "seed_intended" | "seed_settled" | "source_released";
    unsettledState?: "effect_started" | "ambiguous";
  }>,
): Promise<void> {
  const session = value.store.requireSession(input.session);
  if (session.providerThreadId === undefined) throw new Error("Expected historical source thread.");
  const source = value.store.requireProfileById(session.profileId);
  const target = value.store.requireProfileById(input.account ?? source.id);
  if (input.provider === "claude") {
    const before = value.store.requireProviderAccountAuthority(target.id, "claude");
    if (before.processGeneration === 0) {
      value.store.advanceProviderAccountProcessGeneration({
        expectedProcessGeneration: 0,
        profileId: target.id,
        provider: "claude",
      });
    }
    value.store.observeProviderAccountReadiness({
      expectedBindingGeneration: before.bindingGeneration,
      observedAt: 2_000,
      profileId: target.id,
      provider: "claude",
      readiness: "signed_in",
    });
  }
  const sourceAuthority = value.store.requireProviderAccountAuthority(source.id, session.provider);
  const targetAuthority = value.store.requireProviderAccountAuthority(target.id, input.provider);
  const targetPreset = input.preset ?? (input.provider === "claude" ? "fable-max" : "high");
  const presetContract = providerSwitchRequiresPresetContract(input.provider, input.preset)
    ? sharedActiveCodexPresetContract() : undefined;
  const historicalTarget = liveAuthorityFor(value.store, target.id, input.provider);
  const runtimeProfile = input.provider === "claude"
    ? claudeProfile(historicalTarget)
    : codexProfile(historicalTarget, targetPreset, activePresetBinding(targetPreset).requirement);
  const transcript = await transcriptOf(value, session.id);
  const seed = renderTranscriptSeed({
    fromProvider: session.provider,
    toProvider: input.provider,
    transcript,
  });
  const targetProviderAccountKey = input.provider === "claude"
    ? `v1:claude:${createHash("sha256").update("claude-account\0claude-organization").digest("hex")}`
    : `v1:codex:${createHash("sha256").update(target.providerEmail ?? "person@example.com").digest("hex")}`;
  const attempt = value.store.prepareMutation({
    authorityGeneration: targetAuthority.processGeneration,
    authorityId: session.id,
    idempotencyKey: input.idempotencyKey,
    kind: "session.switch",
    providerAuthorities: [
      { authority: sourceAuthority, role: "source", provenance: "legacy_switch_source" },
      { authority: targetAuthority, role: "target", provenance: "legacy_switch_target" },
    ],
    request: sessionProviderSwitchMutationRequest({
      provider: input.provider,
      preset: targetPreset,
      presetContract,
      targetProfileId: target.id,
      seedDigest: seed.digest,
    }),
  });
  value.store.beginSessionProviderSwitchEffect({
    attemptId: attempt.id,
    sessionId: session.id,
    ...(input.provider === "claude" ? {
      providerAuthentication: {
        profileId: target.id,
        processGeneration: targetAuthority.processGeneration,
        provider: "claude" as const,
        signedIn: true as const,
      },
    } : {}),
    evidence: {
      kind: "session.switch",
      daemonGeneration: value.daemonGeneration,
      requestedAccountId: input.account ?? null,
      requestedPreset: input.preset ?? null,
      sourceProfileId: source.id,
      sourceProcessGeneration: sourceAuthority.processGeneration,
      sourceProvider: session.provider,
      sourceProviderThreadId: session.providerThreadId,
      sourcePreset: session.preset,
      targetProfileId: target.id,
      targetProcessGeneration: targetAuthority.processGeneration,
      targetProvider: input.provider,
      targetProviderAccountKey,
      targetHostCapabilities: {
        manifestDigest: OOMPA_SESSION_PREAMBLE.manifestDigest,
        manifestVersion: OOMPA_SESSION_PREAMBLE.manifestVersion,
        preambleDigest: OOMPA_SESSION_PREAMBLE.digest,
        preambleVersion: OOMPA_SESSION_PREAMBLE.version,
      },
      ...(presetContract === undefined ? {} : { presetContract }),
      targetPreset,
      transcriptDigest: transcript.digest,
      seedDigest: seed.digest,
      seedIncludedRecords: seed.includedRecords,
      seedOmittedRecords: seed.omittedRecords,
      runtimeProfile,
    },
  });
  const providerThreadId = input.providerThreadId ?? (input.provider === "claude" ? crypto.randomUUID() : "codex-thread-1");
  if (input.provider === "claude") {
    const intent = value.store.stageClaudeProcessLaunchIntent({
      profileId: target.id, profileGeneration: target.processGeneration,
      providerAuthority: targetAuthority, providerThreadId,
      providerAccountKey: targetProviderAccountKey, runtimeScope: "managed", sessionId: session.id,
    });
    const review = await value.claude.reviewSessionStart({
      authority: historicalTarget, preset: targetPreset, fast: false, signal,
      requirement: presetRequirementForContract(targetPreset, 2),
    });
    await value.claude.startSession({
      authority: historicalTarget, providerThreadId, review, signal,
      admitProcessIdentity: async (identity) => {
        value.store.recordClaimedClaudeProcessAuthority({
          profileId: target.id, profileGeneration: target.processGeneration,
          providerAuthority: targetAuthority, providerThreadId, runtimeScope: "managed",
          sessionId: session.id, identity, expectedLaunchIntentId: intent.intentId,
          expectedLaunchIntentRevision: intent.revision,
        });
      },
    });
  }
  const shared = { attemptId: attempt.id, sessionId: session.id, providerThreadId };
  value.store.recordSessionProviderSwitchTarget(shared);
  if (input.stage !== "target_started") {
    value.store.recordSessionProviderSwitchSeedIntent({ ...shared, seedText: seed.text, runtimeProfile });
  }
  if (input.stage === "seed_settled" || input.stage === "source_released") {
    value.store.recordSessionProviderSwitchSeedResult({
      ...shared,
      runtimeProfile,
      turnId: input.provider === "claude" ? "claude-turn-1" : "codex-turn-1",
      turnStatus: "completed",
    });
  }
  if (input.stage === "source_released") {
    if (session.provider === "claude") {
      const key = { profileId: source.id, providerThreadId: session.providerThreadId, runtimeScope: "managed" as const };
      const process = value.store.readClaudeProcessAuthority(key);
      if (process === null) throw new Error("Expected original source Claude process custody.");
      const releasing = value.store.beginClaudeProcessAuthorityRelease({ ...key,
        expectedRevision: process.revision, identity: process.identity });
      await value.claude.endSession({ authority: capturedAuthorityForSession(value.store, session.id),
        providerThreadId: session.providerThreadId, signal });
      value.store.completeClaudeProcessAuthorityRelease({ ...key,
        expectedRevision: releasing.revision, identity: releasing.identity });
    }
    value.store.recordSessionProviderSwitchSourceReleased(shared);
    const current = value.store.requireSession(session.id);
    value.store.bindSessionProviderSwitchRecoveryTarget({
      attemptId: attempt.id,
      sessionId: session.id,
      expectedSessionRevision: current.revision,
      providerAccountKey: targetProviderAccountKey,
      title: current.title,
      providerUpdatedAt: input.provider === "claude" ? 20 : 10,
    });
  }
  if (input.unsettledState !== "effect_started") {
    expect(value.store.transitionMutation(attempt.id, "effect_started", "ambiguous", {
      code: "RECOVERY_REQUIRED",
    })).toBe(true);
    value.store.quarantineSession(session.id);
  }
}
const sessionsListHostToolCall = (input: Readonly<{
  authority: ProfileAuthority;
  callId: string;
  connectionId: string;
  providerThreadId: string;
  turnId: string;
}>): OompaHostToolCall => {
  if (input.authority.provider === "devin") throw new Error("Retired provider cannot call a host tool.");
  return {
  authority: {
    provider: input.authority.provider,
    providerAccountId: input.authority.providerAccountId,
    bindingGeneration: input.authority.bindingGeneration,
    processGeneration: input.authority.generation,
    profileId: input.authority.id,
  },
  callId: input.callId,
  connectionId: input.connectionId,
  input: {},
  requestDigest: createHash("sha256").update(input.callId, "utf8").digest("hex"),
  requestId: { type: "string", value: input.callId },
  threadId: input.providerThreadId,
  tool: "sessions_list",
  turnId: input.turnId,
  };
};

const leaveUnseededTargetUnsettled = async (
  value: Fixture,
  sessionId: `sess_${string}`,
  idempotencyKey: string,
): Promise<void> => {
  await recordHistoricalSwitchProgress(value, {
    idempotencyKey, provider: "claude", session: sessionId, stage: "target_started",
  });
};

const leaveFinalSwitchCommitUnsettled = async (
  value: Fixture,
  command: Readonly<{
    account?: `acct_${string}`;
    idempotencyKey: string;
    presetContract?: PresetContract;
    provider: "claude" | "codex";
    session: `sess_${string}`;
  }>,
): Promise<void> => {
  await recordHistoricalSwitchProgress(value, { ...command, stage: "source_released" });
};

const LEGACY_CLAUDE_SWITCH_TARGET_THREAD_ID =
  "00000000-0000-4000-8000-000000000401";

const createLegacyProviderSwitch = async (
  value: Fixture,
  input: Readonly<{
    bindTarget?: boolean;
    idempotencyKey: string;
    seedIntent?: boolean;
    seedResult?: boolean;
    sessionId: `sess_${string}`;
    sourceReleased?: boolean;
    targetProfileId?: `acct_${string}`;
    targetProvider: "claude" | "codex";
    targetRecorded?: boolean;
  }>,
): Promise<void> => {
  const session = value.store.requireSession(input.sessionId);
  if (session.providerThreadId === undefined) throw new Error("Expected a bound source session.");
  const sourceProfile = value.store.requireProfileById(session.profileId);
  const targetProfile = value.store.requireProfileById(input.targetProfileId ?? session.profileId);
  if (input.targetProvider === "claude") {
    const before = value.store.requireProviderAccountAuthority(targetProfile.id, "claude");
    if (before.processGeneration === 0) {
      value.store.advanceProviderAccountProcessGeneration({
        profileId: targetProfile.id, provider: "claude", expectedProcessGeneration: 0,
      });
    }
    value.store.observeProviderAccountReadiness({
      profileId: targetProfile.id, provider: "claude", expectedBindingGeneration: before.bindingGeneration,
      readiness: "signed_in", observedAt: 2_000,
    });
  }
  const targetAuthority = value.store.requireProviderAccountAuthority(targetProfile.id, input.targetProvider);
  const sourceAuthority = value.store.requireProviderAccountAuthority(sourceProfile.id, session.provider);
  const targetPreset: Preset = input.targetProvider === "claude" ? "fable-max" : "high";
  const targetThreadId = input.targetProvider === "claude"
    ? LEGACY_CLAUDE_SWITCH_TARGET_THREAD_ID
    : value.codex.projection.providerThreadId;
  const targetProviderAccountKey = input.targetProvider === "claude"
    ? `v1:claude:${createHash("sha256")
        .update("claude-account\0claude-organization", "utf8")
        .digest("hex")}`
    : `v1:codex:${createHash("sha256")
        .update((value.codex.accountProjection.email ?? targetProfile.providerEmail ?? "").trim().toLowerCase(), "utf8")
        .digest("hex")}`;
  const runtimeProfile = input.targetProvider === "claude"
    ? claudeProfile(liveAuthorityFor(value.store, targetProfile.id, "claude"))
    : codexProfile(liveAuthorityFor(value.store, targetProfile.id, "codex"), targetPreset,
      presetRequirementForContract(targetPreset, sharedActiveCodexPresetContract()));
  const seedText = "[Oompa provider handoff]\nlegacy recovery fixture";
  const presetContract = input.targetProvider === "codex"
    ? sharedActiveCodexPresetContract()
    : undefined;
  const attempt = value.store.prepareMutation({
    authorityGeneration: targetAuthority.processGeneration,
    authorityId: session.id,
    idempotencyKey: input.idempotencyKey,
    kind: "session.switch",
    providerAuthorities: [
      { authority: sourceAuthority, role: "source", provenance: "legacy_switch_source" },
      { authority: targetAuthority, role: "target", provenance: "legacy_switch_target" },
    ],
    request: {
      provider: input.targetProvider,
      preset: targetPreset,
      ...(presetContract === undefined ? {} : { presetContract }),
      targetProfileId: targetProfile.id,
      seedDigest: digestTranscriptSeed(seedText),
    },
  });
  value.store.beginSessionProviderSwitchEffect({
    attemptId: attempt.id,
    sessionId: session.id,
    providerAuthentication: {
      profileId: targetProfile.id,
      processGeneration: targetAuthority.processGeneration,
      provider: input.targetProvider,
      signedIn: true,
    },
    evidence: {
      kind: "session.switch",
      daemonGeneration: value.daemonGeneration,
      requestedAccountId: input.targetProfileId ?? null,
      requestedPreset: null,
      ...(presetContract === undefined ? {} : { presetContract }),
      sourceProfileId: sourceProfile.id,
      sourceProcessGeneration: sourceAuthority.processGeneration,
      sourceProvider: session.provider,
      sourceProviderThreadId: session.providerThreadId,
      sourcePreset: session.preset,
      targetProfileId: targetProfile.id,
      targetProcessGeneration: targetAuthority.processGeneration,
      targetProvider: input.targetProvider,
      targetProviderAccountKey,
      targetHostCapabilities: {
        manifestDigest: OOMPA_SESSION_PREAMBLE.manifestDigest,
        manifestVersion: OOMPA_SESSION_PREAMBLE.manifestVersion,
        preambleDigest: OOMPA_SESSION_PREAMBLE.digest,
        preambleVersion: OOMPA_SESSION_PREAMBLE.version,
      },
      targetPreset,
      transcriptDigest: "a".repeat(64),
      seedDigest: digestTranscriptSeed(seedText),
      seedIncludedRecords: 0,
      seedOmittedRecords: 0,
      runtimeProfile,
    },
  });
  if (input.targetRecorded && input.targetProvider === "claude") {
    value.claude.projection = {
      ...value.claude.projection,
      providerThreadId: targetThreadId,
    };
    const launchIntent = value.store.stageClaudeProcessLaunchIntent({
      providerThreadId: targetThreadId,
      profileId: targetProfile.id,
      profileGeneration: targetProfile.processGeneration,
      providerAuthority: targetAuthority,
      runtimeScope: "managed",
      providerAccountKey: targetProviderAccountKey,
      sessionId: session.id,
    });
    value.store.recordClaimedClaudeProcessAuthority({
      providerThreadId: targetThreadId,
      profileId: targetProfile.id,
      profileGeneration: targetProfile.processGeneration,
      providerAuthority: targetAuthority,
      runtimeScope: "managed",
      sessionId: session.id,
      identity: value.claude.processIdentity,
      expectedLaunchIntentId: launchIntent.intentId,
      expectedLaunchIntentRevision: launchIntent.revision,
    });
  }
  if (input.targetRecorded) {
    value.store.recordSessionProviderSwitchTarget({
      attemptId: attempt.id,
      sessionId: session.id,
      providerThreadId: targetThreadId,
    });
  }
  if (input.seedIntent || input.seedResult || input.sourceReleased) {
    value.store.recordSessionProviderSwitchSeedIntent({
      attemptId: attempt.id,
      sessionId: session.id,
      providerThreadId: targetThreadId,
      seedText,
      runtimeProfile,
    });
  }
  if (input.seedResult || input.sourceReleased) {
    value.store.recordSessionProviderSwitchSeedResult({
      attemptId: attempt.id,
      sessionId: session.id,
      providerThreadId: targetThreadId,
      runtimeProfile,
      turnId: input.targetProvider === "claude" ? "claude-turn-1" : "codex-turn-1",
      turnStatus: "completed",
    });
  }
  if (input.sourceReleased) {
    if (session.provider === "claude") {
      const sourceProcess = value.store.readSessionClaudeProcessAuthority(session.id);
      if (sourceProcess === null) {
        throw new Error("Expected exact Claude source process authority.");
      }
      const releasing = value.store.beginClaudeProcessAuthorityRelease({
        providerThreadId: sourceProcess.providerThreadId,
        profileId: sourceProcess.profileId,
        runtimeScope: sourceProcess.runtimeScope,
        expectedRevision: sourceProcess.revision,
        identity: sourceProcess.identity,
      });
      value.store.completeClaudeProcessAuthorityRelease({
        providerThreadId: releasing.providerThreadId,
        profileId: releasing.profileId,
        runtimeScope: releasing.runtimeScope,
        expectedRevision: releasing.revision,
        identity: releasing.identity,
      });
    }
    value.store.recordSessionProviderSwitchSourceReleased({
      attemptId: attempt.id,
      sessionId: session.id,
    });
  }
  const quarantined = value.store.quarantineSession(session.id);
  if (input.bindTarget) {
    value.store.bindSessionProviderSwitchRecoveryTarget({
      attemptId: attempt.id,
      sessionId: session.id,
      expectedSessionRevision: quarantined.revision,
      providerAccountKey: targetProviderAccountKey,
      title: "Recovered target",
      providerUpdatedAt: input.targetProvider === "claude" ? 20 : 10,
    });
  }
  if (!value.store.transitionMutation(attempt.id, "effect_started", "ambiguous")) {
    throw new Error("Expected to mark the legacy switch ambiguous.");
  }
};

const expectHistoricalValue = (actual: unknown, expected: unknown): void => {
  expect(actual).toEqual(expected);
};

const readCanonical39SwitchRows = (path: string, attemptId: string) => {
  const database = new Database(path, { create: false, strict: true });
  database.exec("PRAGMA query_only=ON");
  try {
    return database.transaction(() => [
      "SELECT id,idempotency_key,kind,authority_id,authority_generation,request_digest,state,result_json,created_at,updated_at FROM mutation_attempts WHERE id=?",
      "SELECT attempt_id,evidence_json,evidence_digest,recorded_at FROM mutation_effect_evidence WHERE attempt_id=?",
      "SELECT attempt_id,provider_thread_id,recorded_at FROM session_provider_switch_targets WHERE attempt_id=?",
      "SELECT attempt_id,client_message_id,seed_text,runtime_profile_json,recorded_at FROM session_provider_switch_seed_intents WHERE attempt_id=?",
      "SELECT attempt_id,turn_id,turn_status,recorded_at FROM session_provider_switch_seed_results WHERE attempt_id=?",
      "SELECT attempt_id,recorded_at FROM session_provider_switch_source_releases WHERE attempt_id=?",
      "SELECT attempt_id,recorded_at FROM session_provider_switch_target_releases WHERE attempt_id=?",
      "SELECT session_id,revision,source_kind,source_id,profile_id,process_generation,observed_at,profile_json,recorded_at FROM session_runtime_profiles WHERE source_id=?",
    ].map((sql) => database.query(`${sql} LIMIT 2`).all(attemptId))).deferred();
  } finally { database.close(); }
};

const expectCanonical39SwitchRetained = (
  value: Fixture,
  scenario: Canonical39SwitchScenario,
): void => {
  const original = canonical39SwitchFixtures[scenario].retained;
  const attempt = value.store.readMutation(original.idempotencyKey);
  if (attempt?.evidence?.evidence.kind !== "session.switch") {
    throw new Error("Expected the archived provider-switch evidence.");
  }
  expectHistoricalValue(attempt.evidence, original.effect);
  expect(attempt.evidence.evidence.targetProviderAccountKey).toBeUndefined();
  if (scenario === "codex-aliased-target") {
    // The old API admitted this row; retaining it does not make its target
    // usable by the current typed reader. Check raw bytes below in either case.
    expect(() => value.store.readSessionProviderSwitchProgress(attempt.id))
      .toThrow("SESSION_PROVIDER_SWITCH_TARGET_ALIASES_SOURCE");
  } else {
    expectHistoricalValue(value.store.readSessionProviderSwitchProgress(attempt.id), original.progress);
  }
  const historicalSwitchRows = value.historicalSwitchRows;
  if (historicalSwitchRows === undefined) {
    throw new Error("Expected the archived provider-switch rows.");
  }
  expect(readCanonical39SwitchRows(value.paths.database, attempt.id)).toEqual(historicalSwitchRows);
  const direct = new Database(value.store.paths.database, { create: false, strict: true });
  direct.exec("PRAGMA query_only=ON");
  try {
    expect(direct.query("SELECT evidence_json,evidence_digest,recorded_at FROM mutation_effect_evidence WHERE attempt_id=?")
      .get(attempt.id)).toEqual({ evidence_json: JSON.stringify(original.effect.evidence),
      evidence_digest: original.effect.digest, recorded_at: original.effect.recordedAt });
  } finally {
    direct.close();
  }
};

const switchDatabaseSnapshot = (path: string) => {
  const database = new Database(path, { create: false, strict: true });
  database.exec("PRAGMA query_only=ON");
  try {
    return database.transaction(() => {
      const tables = database.query("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name LIMIT 513")
        .all() as { name: string }[];
      expect(tables.length).toBeLessThanOrEqual(512);
      return {
        version: database.query("PRAGMA user_version").get(),
        schema: database.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
        rows: tables.map(({ name }) => {
          expect(name).toMatch(/^[A-Za-z0-9_]+$/);
          const rows = database.query(`SELECT * FROM "${name}" LIMIT 4097`).all();
          expect(rows.length).toBeLessThanOrEqual(4096);
          return { name, rows: rows.map((row) => JSON.stringify(row)).sort() };
        }),
      };
    }).deferred();
  } finally { database.close(); }
};

const expectCanonical39IdentityRefusal = async (
  value: Fixture,
  scenario: Canonical39SwitchScenario,
) => {
  const original = canonical39SwitchFixtures[scenario].retained;
  const sessionId = original.session.id;
  expectCanonical39SwitchRetained(value, scenario);
  expect(value.store.requireProfile(original.session.profileId).state).toBe("signed_in");
  expect(value.store.readSessionProviderAccountAuthority(sessionId)).toBeNull();
  expect(value.store.sessionAccountAuthorityMatches(sessionId, original.session.profileId)).toBe(false);
  const before = switchDatabaseSnapshot(value.paths.database);
  for (const kind of ["session.recover", "session.abandon"] as const) {
    await expect(value.service.execute({ kind, session: sessionId }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: expect.stringContaining("unprovable provider account identity") });
    expect(switchDatabaseSnapshot(value.paths.database)).toEqual(before);
  }
  expect(value.codex.calls).toEqual([]);
  expect(value.codex.readAccountCalls).toBe(0);
  expect(value.codex.endedThreads).toEqual([]);
  expect(value.claude.calls).toEqual([]);
  expect(value.claude.accountIdentityReadCalls).toBe(0);
  expect(value.store.readMutation(original.idempotencyKey)).toMatchObject({ state: "ambiguous" });
  expectCanonical39SwitchRetained(value, scenario);
};

const expectCurrentSwitchSuccessors = (
  value: Fixture,
  idempotencyKey: string,
): void => {
  const attempt = value.store.readMutation(idempotencyKey);
  if (attempt?.evidence?.evidence.kind !== "session.switch") {
    throw new Error("Expected immutable provider-switch evidence.");
  }
  const evidence = attempt.evidence.evidence;
  if (evidence.daemonGeneration === undefined) {
    throw new Error("Expected the provider switch to name its daemon generation.");
  }
  expect(evidence.daemonGeneration).toBeLessThan(value.daemonGeneration);
  for (const authority of [
    {
      originGeneration: evidence.sourceProcessGeneration,
      profileId: evidence.sourceProfileId,
      provider: evidence.sourceProvider,
    },
    {
      originGeneration: evidence.targetProcessGeneration,
      profileId: evidence.targetProfileId,
      provider: evidence.targetProvider,
    },
  ] as const) {
    const current = value.store.requireProviderAccountForProfile(authority.profileId, authority.provider);
    expect(current.processGeneration).toBeGreaterThan(authority.originGeneration);
    if (authority.provider === "codex") {
      const raw = new Database(value.paths.database, { readonly: true });
      try {
        expect({
          current: value.store.isSessionMutationProviderAuthorityCurrent({
            attemptId: attempt.id,
            ...authority,
          }),
          currentAccount: current,
          frozen: value.store.readMutationProviderAuthorities(attempt.id),
          successors: raw.query(
            "SELECT provider,from_generation,to_generation FROM session_mutation_authority_rebinds WHERE attempt_id=? AND profile_id=?",
          ).all(attempt.id, authority.profileId),
          mutationState: attempt.state,
        }).toMatchObject({ current: true });
      } finally { raw.close(); }
    } else {
      const raw = new Database(value.paths.database, { readonly: true });
      try {
        expect(raw.query(
          "SELECT 1 FROM session_mutation_authority_rebinds WHERE attempt_id=? AND provider='claude' LIMIT 1",
        ).get(attempt.id)).toBeNull();
      } finally { raw.close(); }
    }
  }
};

describe("provider portability", () => {
  test("drops a stale Claude callback before translator state or runtime authority lookup", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Stale Claude callback" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Claude docs", path: value.documents },
      { signal },
    );
    const started = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const providerThreadId = value.store.requireSession(started.session.id).providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected one bound Claude thread.");
    const staleAuthority = liveAuthorityFor(value.store, added.account.id, "claude");
    const current = value.store.requireProviderAccountAuthority(added.account.id, "claude");
    value.store.advanceProviderAccountProcessGeneration({
      expectedProcessGeneration: current.processGeneration,
      profileId: current.profileId,
      provider: "claude",
    });
    const before = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events.length;

    await value.service.observeClaudeFact(staleAuthority, {
      blocking: true,
      connectionId: "30000000-0000-4000-8000-000000000002",
      display: {
        availableDecisions: ["once", "decline"],
        commandClass: "shell",
        kind: "command_approval",
        reason: null,
        summary: "Run a command",
        workingDirectory: null,
      },
      itemId: "same-item",
      kind: "command_approval",
      providerThreadId,
      request: {
        blockedPath: null,
        decisionReasonType: null,
        description: null,
        displayName: "Shell",
        input: { command: "true" },
        permissionSuggestionCount: 0,
        questions: null,
        requiresUserInteraction: false,
        subtype: "can_use_tool",
        toolName: "Shell",
        toolUseId: "same-item",
      },
      requestId: "same-request",
      turnId: "same-turn",
      type: "interactionRequested",
    });
    await value.service.observeClaudeFact(staleAuthority, {
      connectionId: "30000000-0000-4000-8000-000000000002",
      providerThreadId,
      requestId: "same-request",
      type: "interactionCanceled",
    });

    expect(value.claude.interactionAuthorityCalls).toBe(0);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: started.session.id,
    }).events).toHaveLength(before);
  });

  test("does not route a provider notice into another provider session with the same profile generation", async () => {
    const value = await fixture();
    const { accountId } = await codexSession(value);
    const claude = await value.service.execute({
      account: accountId,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const before = value.store.listSessionEvents({
      sessionId: claude.session.id,
      afterSequence: 0,
    }).events.length;

    await value.service.observeCodexFact(liveAuthorityFor(value.store, accountId, "codex"), {
      connectionId: "30000000-0000-4000-8000-000000000002",
      method: "provider/unknown-notification",
      type: "protocolNotice",
    });

    const after = value.store.listSessionEvents({
      sessionId: claude.session.id,
      afterSequence: 0,
    }).events;
    expect(after).toHaveLength(before);
    expect(after.some((event) => event.body.type === "protocol_incompatible")).toBe(false);
  });

  test("keeps Claude readiness independent and binds a new session to the observed generation", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude only" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Claude docs", path: value.documents },
      { signal },
    );

    value.claude.readiness = "unverified";
    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(value.claude.calls).toEqual(["read-account"]);
    expect(value.store.listSessions()).toHaveLength(0);
    expect(value.store.requireProviderAccountForProfile(added.account.id, "codex"))
      .toMatchObject({ bindingGeneration: 1, readiness: "signed_out" });
    expect(value.store.requireProviderAccountForProfile(added.account.id, "claude"))
      .toMatchObject({ bindingGeneration: 1, readiness: "unverified" });

    value.claude.readiness = "signed_in";
    value.claude.projection = {
      ...value.claude.projection,
      providerThreadId: "claude-thread-2",
      providerUpdatedAt: 21,
    };
    const started = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const observed = value.store.requireProviderAccountForProfile(
      added.account.id,
      "claude",
    );
    expect(observed).toMatchObject({ bindingGeneration: 2, readiness: "signed_in" });
    expect(value.store.requireSessionProviderAuthority(started.session.id)).toMatchObject({
      bindingGeneration: 2,
      processGeneration: 1,
      provider: "claude",
      providerAccountId: observed.id,
      routingProvenance: "explicit",
      appliedPointerRevision: null,
    });
  });

  test("starts and operates a Claude session while the profile's Codex account remains signed out", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Work" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Work docs", path: value.documents },
      { signal },
    );

    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
    const started = await value.service.execute(
      {
        account: added.account.id,
        fast: false,
        kind: "session.start",
        preset: "fable-max",
        provider: "claude",
      },
      { signal },
    ) as { session: { id: `sess_${string}` } };

    const review = value.claude.calls.indexOf("review-session");
    const start = value.claude.calls.indexOf("start-session");
    expect(review).toBeGreaterThan(value.claude.calls.indexOf("read-account"));
    expect(start).toBeGreaterThan(review);
    expect(value.claude.calls.filter((call) => call === "read-account")).toHaveLength(1);
    expect(value.claude.accountIdentityReadCalls).toBeGreaterThanOrEqual(2);
    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
    await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.send",
        message: "continue in Claude",
        session: started.session.id,
      },
      { signal },
    );
    expect(value.claude.seededMessages.at(-1)).toBe("continue in Claude");
    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
  });

  test("releases an idle Claude session before granting login for an expired account", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await claudeSession(value);
    const providerThreadId = value.store.requireSession(sessionId).providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected a bound Claude session.");
    value.claude.accountSignedIn = false;
    const loginKey = crypto.randomUUID();

    const granted = await value.service.execute({
      account: accountId,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal });
    expect(granted).toMatchObject({
      authentication: { provider: "claude", signedIn: false },
      login: { status: "launch_granted" },
    });

    expect(value.store.requireProfileById(accountId).state).toBe("signed_out");
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "terminal",
    });
    expect(value.claude.endedThreads).toEqual([providerThreadId]);
    expect(value.store.readMutation(loginKey)).toMatchObject({
      authorityId: accountId,
      kind: "account.claude-login",
      state: "effect_started",
    });
    const bodies = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId,
    }).events.map((event) => event.body);
    expect(bodies).toContainEqual({
      reason: "Claude account login",
      state: "disconnected",
      type: "connection",
    });
    expect(bodies).toContainEqual({
      activeTurnId: null,
      status: "terminal",
      type: "session_status",
    });
  });

  test("does not touch an idle Claude session with queued authority when login is requested", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await claudeSession(value);
    const queued = value.store.enqueue(sessionId, "send after this finishes");
    value.claude.accountSignedIn = false;
    const loginKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: accountId,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      details: { provider: "claude", retryable: true },
    });

    expect(value.claude.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "idle" });
    expect(value.store.requireQueue(queued.id)).toMatchObject({ state: "pending" });
    expect(value.store.readMutation(loginKey)).toBeNull();
  });

  test("reports an ordinary Claude observation failure as bounded unavailable", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    value.claude.observeError = new CodexSessionObservationError("resume_unavailable");

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      providerObservation: {
        basis: "provider_read",
        code: "resume_unavailable",
        state: "unavailable",
      },
      session: { id: sessionId },
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "idle",
    });
  });

  test("reports Claude host-tool activation failure as runtime resume unavailable", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const activationsBefore = value.claude.calls.filter(
      (call) => call === "activate-host-tools",
    ).length;
    const observationsBefore = value.claude.calls.filter((call) => call === "observe").length;
    value.claude.activateError = new Error("Claude process-local session is not retained");

    await expect(value.service.execute({
      kind: "session.status",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "claude_host_tools_inactive", sessionId },
    });
    expect(value.claude.calls.filter((call) => call === "activate-host-tools"))
      .toHaveLength(activationsBefore + 1);
    expect(value.claude.calls.filter((call) => call === "observe"))
      .toHaveLength(observationsBefore + 1);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "idle",
    });
  });

  test("requests detailed Claude history to recover an ambiguous sent message", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(session.profileId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound Claude session.");
    const { providerAccountId, profileId, provider, bindingGeneration, processGeneration } =
      value.store.requireSessionProviderAuthority(session.id);
    const providerAuthority = { providerAccountId, profileId, provider, bindingGeneration, processGeneration };
    const message = "Recover this exact Claude send.";
    const idempotencyKey = crypto.randomUUID();
    const { attempt } = value.store.prepareSessionInputMutation({
      sessionId: session.id,
      providerAuthority,
      message,
      attachments: [],
      daemonGeneration: value.daemonGeneration,
      bootId: value.daemonBootId,
      idempotencyKey,
      kind: "session.send",
    });
    value.store.beginSessionMutationEffect({
      attemptId: attempt.id,
      providerAuthority,
      evidence: {
        baseline: {
          activeTurnId: null,
          providerUpdatedAt: session.providerUpdatedAt ?? null,
          status: "idle",
        },
        clientMessageId: attempt.id,
        kind: "session.send",
        messageDigest: createHash("sha256").update(message).digest("hex"),
        providerThreadId: session.providerThreadId,
        runtimeProfile: claudeProfile(capturedAuthorityForSession(value.store, session.id)),
      },
      message,
      profileGeneration: providerAuthority.processGeneration,
      sessionId: session.id,
      attachments: [],
      daemonGeneration: value.daemonGeneration,
      bootId: value.daemonBootId,
      transcript: {
        accountId: profile.id,
        actor: "human",
        message,
        providerConnectionId: value.claude.connectionId,
        providerGeneration: providerAuthority.processGeneration,
      },
    });
    expect(value.store.transitionMutation(attempt.id, "effect_started", "ambiguous"))
      .toBe(true);
    value.store.quarantineSession(session.id);
    value.claude.projection = {
      activeTurnId: "claude-recovered-turn",
      messages: [{
        clientId: attempt.id,
        role: "user",
        text: message,
        turnId: "claude-recovered-turn",
      }],
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
      providerThreadId: session.providerThreadId,
      providerUpdatedAt: (session.providerUpdatedAt ?? 20) + 1,
      status: "active",
      title: session.title,
      turnSummaries: [{
        actions: [],
        files: [],
        id: "claude-recovered-turn",
        omittedActions: 0,
        omittedFiles: 0,
        status: "inProgress",
      }],
    };
    const detailReadsBefore = value.claude.readSessionDetails.length;

    await expect(value.service.execute({
      kind: "session.recover",
      session: session.id,
    }, { signal })).resolves.toMatchObject({
      recovery: { resolution: "proven_applied" },
      session: { activeTurnId: "claude-recovered-turn", state: "active" },
    });
    expect(value.claude.readSessionDetails.slice(detailReadsBefore)).toEqual([true]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "proven_applied" },
      state: "reconciled",
    });
  });

  test("refuses a new Claude session when Claude reports the profile signed out", async () => {
    const value = await fixture();
    value.claude.accountSignedIn = false;
    const added = await value.service.execute(
      { kind: "account.add", label: "Work" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Work docs", path: value.documents },
      { signal },
    );

    const idempotencyKey = crypto.randomUUID();
    const refusal = await value.service.execute(
      {
        account: added.account.id,
        fast: false,
        idempotencyKey,
        kind: "session.start",
        preset: "fable-max",
        provider: "claude",
      },
      { signal },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("INTERACTION_REQUIRED");
    expect((refusal as CommandFailure).details).toEqual({
      accountSelector: added.account.id,
      accountState: "signed_out",
      readiness: "signed_out",
      nextCommand: `oompa account login ${added.account.id} --provider claude`,
      provider: "claude",
    });
    expect(value.claude.calls).toEqual(["read-account"]);
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.store.readMutation(idempotencyKey)).toBeNull();
    expect(value.store.requireProfileById(added.account.id).state).toBe("signed_out");
  });

  test("leaves no session-start authority when Claude status cannot be read", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Status failure" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Status failure docs", path: value.documents },
      { signal },
    );
    value.claude.readAccountError = new Error("Claude status failed");
    const idempotencyKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      idempotencyKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toThrow("Claude status failed");
    expect(value.store.readMutation(idempotencyKey)).toBeNull();
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.claude.calls).toEqual(["read-account"]);
  });

  test("keeps a pre-effect start replayable and releases its review when validation fails", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Review cleanup" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Review cleanup docs", path: value.documents },
      { signal },
    );
    value.claude.reviewProfileGenerationOffset = 1;
    const idempotencyKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      idempotencyKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toThrow("MUTATION_EFFECT_RUNTIME_PROFILE_MISMATCH");
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });
    expect(value.store.listUnsettledMutations({ authorityId: added.account.id })).toEqual([]);
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.claude.calls.filter((call) => call === "review-session")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "read-account")).toHaveLength(1);
    expect(value.claude.accountIdentityReadCalls).toBeGreaterThanOrEqual(1);

    value.claude.reviewProfileGenerationOffset = 0;
    await expect(value.service.execute({
      account: added.account.id,
      fast: false,
      idempotencyKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).resolves.toMatchObject({ session: { provider: "claude" } });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(value.claude.pendingReviewIds.size).toBe(0);
  });

  test("blocks a new Claude provider effect while foreground login is unsettled", async () => {
    const value = await fixture();
    const added = await value.service.execute(
      { kind: "account.add", label: "Foreground owner" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { kind: "project.add", label: "Foreground owner docs", path: value.documents },
      { signal },
    );
    const profile = value.store.requireProfileById(added.account.id);
    const providerAuthority = value.store.requireProviderAccountAuthority(profile.id, "claude");
    const loginKey = crypto.randomUUID();
    const attempt = value.store.prepareMutation({
      authorityGeneration: providerAuthority.processGeneration,
      authorityId: profile.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login",
      providerAuthorities: [{ role: "primary", authority: providerAuthority, provenance: "account_claude_login" }],
      request: { provider: "claude" },
    });
    value.store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baselineSignedIn: false,
        kind: "account.claude-login",
        provider: "claude",
      },
      profileGeneration: providerAuthority.processGeneration,
      profileId: profile.id,
    });
    const startKey = crypto.randomUUID();

    await expect(value.service.execute({
      account: profile.id,
      fast: false,
      idempotencyKey: startKey,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readMutation(startKey)).toBeNull();
    expect(value.claude.pendingReviewIds.size).toBe(0);
    expect(value.claude.calls).toEqual([]);
  });

  test("refuses a switch when the target Claude account is signed out", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.accountSignedIn = false;

    const refusal = await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      },
      { signal },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("INTERACTION_REQUIRED");
    expect((refusal as CommandFailure).message).toContain(
      "oompa account login",
    );
    expect((refusal as CommandFailure).details).toMatchObject({
      accountState: "signed_out",
      nextCommand: expect.stringContaining("--provider claude"),
      provider: "claude",
    });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.calls).toEqual(["read-account"]);
  });

  test("rejects a target-provider preset mismatch before authentication or durable admission", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.accountSignedIn = false;
    const idempotencyKey = crypto.randomUUID();

    const refusal = await value.service.execute(
      {
        idempotencyKey,
        kind: "session.switch",
        preset: "high",
        provider: "claude",
        session: sessionId,
      },
      { signal },
    ).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("INVALID_INPUT");
    expect((refusal as CommandFailure).message).toContain(
      "does not support the `high` model preset",
    );
    expect(value.claude.calls).toEqual([]);
    expect(value.store.readMutation(idempotencyKey)).toBeNull();
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
  });

  test("rejects a changed prepared switch request before target authentication", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    value.claude.accountSignedIn = false;
    const profile = value.store.requireProfileById(accountId);
    const idempotencyKey = crypto.randomUUID();
    value.store.prepareMutation({
      authorityGeneration: profile.processGeneration,
      authorityId: sessionId,
      idempotencyKey,
      kind: "session.switch",
      request: sessionProviderSwitchMutationRequest({
        provider: "claude",
        preset: "fable-max",
        seedDigest: "0".repeat(64),
        targetProfileId: profile.id,
      }),
    });

    const refusal = await value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("CONFLICT");
    expect(value.claude.calls).toEqual([]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "prepared" });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
  });

  test.each(["prepared", "target_starting"] as const)(
    "historical inactive switch metadata at %s never authorizes a fresh launch",
    async (phase) => {
      const value = await fixture();
      const { accountId, sessionId } = await claudeSession(value);
      await value.service.execute({ kind: "account.login", account: accountId, deviceCode: false }, { signal });
      const idempotencyKey = crypto.randomUUID();
      const begin = value.store.beginSessionSwitchTargetStart.bind(value.store);
      value.store.beginSessionSwitchTargetStart = () => { throw new Error("pause before target intent"); };
      try {
        await expect(value.service.execute({
          kind: "session.switch", provider: "codex", presetContract: currentPresetContract,
          session: sessionId, idempotencyKey,
        }, { signal })).rejects.toThrow("pause before target intent");
      } finally {
        value.store.beginSessionSwitchTargetStart = begin;
      }
      const prepared = value.store.readSessionSwitchByIdempotencyKey(idempotencyKey);
      if (prepared === null || prepared.phase !== "prepared") throw new Error("Expected a prepared switch.");
      if (phase === "target_starting") {
        begin({
          attemptId: prepared.attemptId, requestDigest: prepared.requestDigest,
          sourceAuthority: prepared.sourceAuthority, targetAuthority: prepared.targetAuthority,
          originalSessionRevision: prepared.originalSessionRevision,
          originalAuthorityRevision: prepared.originalAuthorityRevision,
        });
      }
      const before = value.store.readSessionSwitchByIdempotencyKey(idempotencyKey);
      const sessionBefore = value.store.requireSession(sessionId);
      const calls = { codex: [...value.codex.calls], claude: [...value.claude.calls] };
      const requireSwitch = value.store.requireSessionSwitch.bind(value.store);
      // This is a service-branch oracle, not an archived database capture:
      // substitute a retained V1 decoded view without changing stored bytes.
      value.store.requireSessionSwitch = (attemptId) => {
        const record = requireSwitch(attemptId);
        if (attemptId !== prepared.attemptId) return record;
        const { targetHostCapabilities, ...historical } = record;
        expect(targetHostCapabilities).toBeDefined();
        return {
          ...historical,
          // The injected historical row carries the inactive contract.
          targetPresetContract: legacyPresetContract,
          rawRequest: {
            session: record.rawRequest.session, provider: record.rawRequest.provider,
            account: record.rawRequest.account, preset: record.rawRequest.preset,
          },
          transcript: { ...record.transcript, rendererVersion: 1 },
        };
      };
      try {
        if (phase === "prepared") {
          await expect(value.service.execute({ kind: "session.recover", session: sessionId }, { signal }))
            .rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("inactive provider-switch preset contract") });
          expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toEqual(before);
          expect(value.store.requireSession(sessionId)).toEqual(sessionBefore);
        } else {
          await expect(value.service.execute({ kind: "session.recover", session: sessionId }, { signal }))
            .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
          expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
            phase: "reconciliation_required", diagnosticCode: "RECOVERY_TARGET_START_POSSIBLY_SENT",
          });
        }
        expect(value.codex.calls).toEqual(calls.codex);
        expect(value.claude.calls).toEqual(calls.claude);
        expect(value.codex.calls.filter((call) => call === "start-session")).toEqual([]);
      } finally {
        value.store.requireSessionSwitch = requireSwitch;
      }
    },
  );

  test("refuses a switch while the target account has an unsettled Claude login", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const profile = value.store.requireProfileById(accountId);
    const providerAuthority = value.store.requireProviderAccountAuthority(profile.id, "claude");
    const loginKey = crypto.randomUUID();
    const attempt = value.store.prepareMutation({
      authorityGeneration: providerAuthority.processGeneration,
      authorityId: profile.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login",
      providerAuthorities: [{ role: "primary", authority: providerAuthority, provenance: "account_claude_login" }],
      request: { provider: "claude" },
    });
    value.store.beginClaudeLoginMutationEffect({
      attemptId: attempt.id,
      evidence: {
        baselineSignedIn: false,
        kind: "account.claude-login",
        provider: "claude",
      },
      profileGeneration: providerAuthority.processGeneration,
      profileId: profile.id,
    });

    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.calls).toEqual([]);
    expect(value.claude.pendingReviewIds.size).toBe(0);
  });

  test("owns the transcript: a sent message and a tool call are Oompa's own records", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );
    const profile = value.store.requireProfileById(accountId);
    const authority = liveAuthorityFor(value.store, profile.id);
    const threadId = value.store.requireSession(sessionId).providerThreadId;
    if (threadId === undefined) throw new Error("Expected a bound session.");
    const turnId = "codex-turn-1";
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-1",
      itemKind: "commandExecution",
      commandClass: "git commit",
      type: "itemStarted",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-1",
      itemKind: "commandExecution",
      commandClass: "git commit",
      status: "completed",
      type: "itemCompleted",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-2",
      itemKind: "agentMessage",
      type: "itemStarted",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-2",
      text: "Released.",
      type: "assistantDelta",
    });
    await value.service.observeCodexFact(authority, {
      connectionId: "30000000-0000-4000-8000-000000000001",
      threadId,
      turnId,
      itemId: "item-2",
      itemKind: "agentMessage",
      status: "completed",
      type: "itemCompleted",
    });
    await value.service.settled();

    const transcript = await transcriptOf(value, sessionId);
    const kinds = transcript.records.map((record) => record.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("tool_call");
    expect(kinds).toContain("tool_result");
    expect(kinds).toContain("assistant");
    const user = transcript.records.find((record) => record.kind === "user");
    expect(user).toMatchObject({ actor: "human", text: "ship the release" });
    const call = transcript.records.find((record) => record.kind === "tool_call");
    const result = transcript.records.find((record) => record.kind === "tool_result");
    if (call?.kind !== "tool_call" || result?.kind !== "tool_result") {
      throw new Error("Expected one tool call and one tool result.");
    }
    // A result is linked to its call by the same opaque call id, and the
    // summary is the classified label, never the command itself.
    expect(result.callId).toBe(call.callId);
    expect(call.summary).toBe("commandExecution: git commit");
    expect(result.ok).toBe(true);
    // An agent-message item is conversation, not a tool call.
    expect(transcript.records.filter((record) => record.kind === "tool_call")).toHaveLength(1);
    expect(transcript.digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  test("switches a live session from Codex to Claude and seeds the handoff", async () => {
    const value = await fixture();
    const factsMemory = value.factsMemory;
    const { sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );

    const switchKey = crypto.randomUUID();
    value.claude.onActivate = async (input) => {
      const current = value.store.requireSession(sessionId);
      expect(current.provider).toBe("claude");
      const attempt = value.store.readSessionSwitchByIdempotencyKey(switchKey);
      if (attempt === null) throw new Error("Expected a durable dedicated switch.");
      expect(["rebound", "seed_dispatching", "seed_settled"]).toContain(attempt.phase);
      expect(attempt.rawRequest.version).toBe(2);
      expect(value.store.readSessionHostCapabilityBinding(sessionId)).toMatchObject({
        preambleDigest: OOMPA_SESSION_PREAMBLE.digest,
        manifestDigest: OOMPA_SESSION_PREAMBLE.manifestDigest,
      });
      expect(value.store.readSessionClaudeProcessAuthority(sessionId)).toMatchObject({
        providerThreadId: input.providerThreadId,
        state: "bound",
      });
      if (attempt.phase !== "rebound") return;
      expect(value.claude.seededMessages).toEqual([]);
      await expect(value.service.handleOompaHostToolCall(
        input.authority,
        sessionsListHostToolCall({
          authority: input.authority,
          callId: "switch-seed-before-turn",
          connectionId: value.claude.connectionId,
          providerThreadId: input.providerThreadId,
          turnId: "claude-seed-not-yet-authoritative",
        }),
        { provider: "claude", source: "managed" },
      )).resolves.toEqual({ version: 1, ok: false, code: "PEER_SESSION_ACTOR_TURN_REFUSED" });
    };
    const switched = await value.service.execute(
      { idempotencyKey: switchKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    ) as {
      from: { preset: string; provider: string };
      seed: { digest: string; includedRecords: number; omittedRecords: number };
      to: { preset: string; provider: string };
    };

    expect(switched.from).toMatchObject({ preset: "high", provider: "codex" });
    expect(switched.to).toMatchObject({ preset: "fable-max", provider: "claude" });
    expect(switched.seed.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(value.claude.sessionStartRequirement).toEqual({
      model: CLAUDE_PIN_MODEL,
      effort: "max",
    });

    value.claude.turnStatus = "inProgress";
    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "Use the now-bound host runtime.",
      session: sessionId,
    }, { signal });
    const active = value.store.requireSession(sessionId);
    if (active.providerThreadId === undefined || active.activeTurnId === undefined) {
      throw new Error("Expected one active bound Claude turn.");
    }
    const admittedCall = sessionsListHostToolCall({
      authority: capturedAuthorityForSession(value.store, active.id),
      callId: "switch-after-binding",
      connectionId: value.claude.connectionId,
      providerThreadId: active.providerThreadId,
      turnId: active.activeTurnId,
    });
    const targetAuthority = capturedAuthorityForSession(value.store, active.id);
    await expect(value.service.handleOompaHostToolCall(
      targetAuthority,
      admittedCall,
      { provider: "claude", source: "managed" },
    )).rejects.toThrow("OOMPA_HOST_TOOL_RUNTIME_AUTHORITY_STALE");
    value.claude.liveHostToolCall = admittedCall;
    await expect(value.service.handleOompaHostToolCall(
      targetAuthority,
      admittedCall,
      { provider: "claude", source: "managed" },
    )).resolves.toBeDefined();
    await expect(value.service.handleOompaHostToolCall(
      targetAuthority,
      admittedCall,
      { provider: "codex", source: "managed" },
    )).rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");
    await expect(value.service.handleOompaHostToolCall(
      targetAuthority,
      admittedCall,
      { provider: "claude", source: "personal" },
    )).rejects.toThrow("OOMPA_HOST_TOOL_AUTHORITY_STALE");

    const session = value.store.requireSession(sessionId);
    expect(session.provider).toBe("claude");
    expect(session.preset).toBe("fable-max");
    expect(session.providerThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(factsMemory.readSession(sessionId)).toMatchObject({
      ownerId: session.profileId,
      state: "active",
    });
    expect(factsMemory.ensures.every((entry) => entry.ownerId === session.profileId)).toBe(true);
    // The outgoing provider was released, and its thread was not deleted.
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.claude.calls.indexOf("activate-host-tools"))
      .toBeGreaterThan(value.claude.calls.indexOf("start-session"));
    expect(value.claude.calls.indexOf("observe"))
      .toBeGreaterThan(value.claude.calls.indexOf("activate-host-tools"));

    // The seed reached the new provider as its first user message, marked as a
    // handoff, carrying its own omission count.
    const seeded = value.claude.seededMessages[0] ?? "";
    expect(seeded).toContain("[Oompa provider handoff]");
    expect(seeded).toContain("This conversation ran on codex and now runs on claude.");
    expect(seeded).toContain("records were omitted");
    expect(seeded).toContain("ship the release");

    const transcript = await transcriptOf(value, sessionId);
    const boundary = transcript.records.find((record) => record.kind === "provider_switch");
    expect(boundary).toMatchObject({
      accountChanged: false,
      fromPreset: "high",
      fromProvider: "codex",
      seedDigest: switched.seed.digest,
      toPreset: "fable-max",
      toProvider: "claude",
    });
    const handoff = transcript.records.find(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    );
    expect(handoff).toBeDefined();

    // An exact replay returns the original durable terminal result. It does
    // not start another target, release the source again, resend the seed, or
    // duplicate either transcript record.
    await expect(value.service.execute(
      { idempotencyKey: switchKey, kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).resolves.toEqual(switched);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.claude.seededMessages).toEqual([
      seeded,
      "Use the now-bound host runtime.",
    ]);
    const replayedTranscript = await transcriptOf(value, sessionId);
    expect(replayedTranscript.records.filter((record) => record.kind === "provider_switch"))
      .toHaveLength(1);
    expect(replayedTranscript.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(1);

    // The next ordinary turn runs on Claude.
    await value.service.execute({ kind: "session.stop", session: sessionId }, { signal });
    value.claude.turnStatus = "completed";
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "carry on", session: sessionId },
      { signal },
    );
    expect(value.claude.seededMessages.at(-1)).toBe("carry on");
  }, 30_000);


  test("drops only the switching session's source protocol notice during target start", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const sourceAuthority = liveAuthorityFor(value.store, accountId, "codex");
    value.claude.beforeStartSessionReturn = async () => {
      await value.service.observeCodexFact(sourceAuthority, {
        connectionId: "30000000-0000-4000-8000-000000000001",
        method: "provider/switch-race-notice",
        type: "protocolNotice",
      });
    };

    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-0000000007b1",
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({ seed: { delivered: true } });
    const notices = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId,
    }).events.filter((event) => event.body.type === "protocol_incompatible");
    expect(notices).toEqual([]);
  });

  test("does not swallow a shared Codex disconnect during source release", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    value.codex.projection = {
      providerThreadId: "codex-thread-2",
      providerUpdatedAt: 12,
      status: "idle",
      title: "Unrelated source session",
    };
    const unrelated = await value.service.execute({
      account: source.accountId,
      fast: false,
      presetContract: currentPresetContract, kind: "session.start",
      preset: "high",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const authority = liveAuthorityFor(value.store, source.accountId, "codex");
    const generationBefore = value.store.requireProfileById(source.accountId)
      .processGeneration;
    value.codex.beforeEndSessionReturn = async () => {
      await value.service.observeCodexFact(authority, {
        connectionId: "30000000-0000-4000-8000-000000000001",
        reason: "process_exit",
        type: "providerDisconnected",
      });
    };

    await expect(value.service.execute({
      idempotencyKey: "00000000-0000-4000-8000-0000000007b3",
      kind: "session.switch",
      provider: "claude",
      session: source.sessionId,
    }, { signal })).resolves.toMatchObject({ seed: { delivered: true } });
    await value.service.settled();

    const unrelatedEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: unrelated.session.id,
    }).events;
    expect(unrelatedEvents.some((event) => event.body.type === "connection"
      && event.body.state === "disconnected")).toBe(true);
    expect(unrelatedEvents.some((event) => event.body.type === "gap"
      && event.body.reason === "provider_disconnect")).toBe(true);
    expect(value.store.requireProfileById(source.accountId).processGeneration)
      .toBe(generationBefore + 1);
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: source.accountId,
      provider: "claude",
    });
  });

  test("reconciles before seed when an exact target error arrives during source release", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    let targetCallbackDelivered = false;
    value.codex.beforeEndSessionReturn = async () => {
      targetCallbackDelivered = true;
      const targetAuthority = liveAuthorityFor(value.store, accountId, "claude");
      await value.service.observeClaudeFact(targetAuthority, {
        code: "TARGET_FAILED_DURING_SOURCE_RELEASE",
        connectionId: "30000000-0000-4000-8000-000000000002",
        message: "target callback while the source provider was releasing",
        providerThreadId: value.claude.projection.providerThreadId,
        terminal: true,
        turnId: null,
        type: "providerError",
      });
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007bc",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(targetCallbackDelivered).toBe(true);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_BEFORE_SEED",
        phase: "reconciliation_required",
      });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("replays the immutable settled switch receipt before current-state no-op checks", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const sourceSession = value.store.requireSession(sessionId);
    const sourceAuthority = value.store.requireSessionProviderAuthority(sessionId);
    if (sourceSession.providerThreadId === undefined) throw new Error("Expected a source thread.");
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a1";
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    const first = await value.service.execute(command, { signal });
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await expect(value.service.execute(command, { signal })).resolves.toEqual(first);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);

    await expect(value.service.executeRemote(command, {
      sessionId,
      profileId: sourceAuthority.profileId,
      processGeneration: sourceAuthority.processGeneration + 1,
      provider: sourceAuthority.provider,
      providerAccountId: sourceAuthority.providerAccountId,
      bindingGeneration: sourceAuthority.bindingGeneration,
      providerThreadId: sourceSession.providerThreadId,
    }, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);

    const conflict = await value.service.execute({
      ...command,
      provider: "codex",
    }, { signal }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(CommandFailure);
    expect((conflict as CommandFailure).code).toBe("CONFLICT");
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("keeps the settled receipt stable when a deferred target fact is lost", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const appendEvent = value.store.appendPublicSessionEvent.bind(value.store);
    let rejectDeferredFact = true;
    Object.defineProperty(value.store, "appendPublicSessionEvent", {
      configurable: true,
      value: (input: Parameters<StateStore["appendPublicSessionEvent"]>[0]) => {
        if (rejectDeferredFact && input.body.type === "error"
          && input.body.code === "DEFERRED_TARGET_NOTICE") {
          rejectDeferredFact = false;
          throw new Error("forced deferred-fact persistence loss");
        }
        return appendEvent(input);
      },
    });
    value.claude.beforeStartTurnReturn = async (input) => {
      await value.service.observeClaudeFact(input.authority, {
        connectionId: "30000000-0000-4000-8000-000000000002",
        code: "DEFERRED_TARGET_NOTICE",
        message: "deferred target notice",
        providerThreadId: input.providerThreadId,
        terminal: false,
        turnId: null,
        type: "providerError",
      });
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b0",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    const first = await value.service.execute(command, { signal });
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    expect(rejectDeferredFact).toBe(false);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "seed_settled" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "recovery_required",
    });
    await expect(value.service.execute(command, { signal })).resolves.toEqual(first);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test.each(["unchanged", "thread", "connection"] as const)("keeps deferred target facts scoped when a shared-connection fact is mutated: %s", async (mutated) => {
    const value = await fixture();
    const source = await codexSession(value);
    const sibling = await value.service.execute({ account: source.accountId,
      kind: "session.start", provider: "claude", preset: "fable-max", fast: false }, { signal }) as {
      session: { id: `sess_${string}`; providerThreadId: string };
    };
    const siblingBefore = value.store.requireSession(sibling.session.id);
    const siblingAuthority = value.store.requireCapturedSessionProviderAuthority(sibling.session.id);
    const siblingEvents = value.store.listSessionEvents({ sessionId: sibling.session.id, afterSequence: 0 }).events;
    const siblingProcess = value.store.readClaudeProcessAuthority({ profileId: source.accountId,
      providerThreadId: sibling.session.providerThreadId, runtimeScope: "managed" });
    let delivered = false;
    value.claude.beforeStartTurnReturn = async (input) => {
      const fact = { type: "providerError" as const, code: "EXACT_DEFERRED_TARGET_NOTICE",
        message: "scoped deferred target notice", terminal: false, turnId: null,
        connectionId: value.claude.connectionId, providerThreadId: input.providerThreadId };
      await value.service.observeClaudeFact(input.authority, fact);
      delivered = true;
      // The caller retains its original object after callback admission. The
      // drain must preserve the original target routing across later mutations.
      if (mutated === "thread") fact.providerThreadId = sibling.session.providerThreadId;
      if (mutated === "connection") fact.connectionId = crypto.randomUUID();
    };
    const command = { kind: "session.switch" as const, provider: "claude" as const,
      session: source.sessionId, idempotencyKey: crypto.randomUUID() };
    const result = await value.service.execute(command, { signal });
    expect(delivered).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "seed_settled" });
    expect(value.store.requireSession(source.sessionId).state).toBe("idle");
    expect(value.store.requireSession(sibling.session.id)).toEqual(siblingBefore);
    expect(value.store.requireCapturedSessionProviderAuthority(sibling.session.id)).toEqual(siblingAuthority);
    expect(value.store.readClaudeProcessAuthority({ profileId: source.accountId,
      providerThreadId: sibling.session.providerThreadId, runtimeScope: "managed" })).toEqual(siblingProcess);
    expect(value.store.listSessionEvents({ sessionId: sibling.session.id, afterSequence: 0 }).events)
      .toEqual(siblingEvents);
    const notices = value.store.listSessionEvents({ sessionId: source.sessionId, afterSequence: 0 }).events
      .filter((event) => event.body.type === "error" && event.body.code === "EXACT_DEFERRED_TARGET_NOTICE");
    expect(notices).toHaveLength(1);
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).resolves.toEqual(result);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.seededMessages).toHaveLength(1);
  });

  test("reconciles before startTurn when one target error arrives during seed review", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    let targetCallbackDelivered = false;
    value.claude.beforeReviewTurnReturn = async (input) => {
      targetCallbackDelivered = true;
      await value.service.observeClaudeFact(input.authority, {
        code: "TARGET_FAILED_DURING_SEED_REVIEW",
        connectionId: "30000000-0000-4000-8000-000000000002",
        message: "target callback while seed review was pending",
        providerThreadId: input.providerThreadId,
        terminal: true,
        turnId: null,
        type: "providerError",
      });
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007bd",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(targetCallbackDelivered).toBe(true);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_BEFORE_SEED_EFFECT",
        phase: "reconciliation_required",
      });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("reconciles without sending the seed when target facts overflow during review", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.beforeReviewTurnReturn = async (input) => {
      // Fill the exact target-thread buffer, then deliver one more fact while
      // reviewTurnStart still owns the provider-neutral pre-effect boundary.
      for (let index = 0; index <= 256; index += 1) {
        await value.service.observeClaudeFact(input.authority, {
          connectionId: "30000000-0000-4000-8000-000000000002",
          code: `DEFERRED_OVERFLOW_${String(index)}`,
          message: "bounded target callback",
          providerThreadId: input.providerThreadId,
          terminal: false,
          turnId: null,
          type: "providerError",
        });
      }
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b4",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "reconciliation_required" });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("rechecks target fact custody after the daemon fence and before seed effect", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    let reviewPostFenceArmedStartFence = false;
    let startPreFenceOverflowed = false;
    value.claude.beforeReviewTurnReturn = (input) => {
      // The review effect's post-operation fence consumes this first hook.
      // It arms a second hook that only the next effect's pre-operation fence
      // can consume, after the service's outer overflow guard has run.
      value.daemonAuthority.beforeAssertReturn = () => {
        reviewPostFenceArmedStartFence = true;
        value.daemonAuthority.beforeAssertReturn = async () => {
          startPreFenceOverflowed = true;
          for (let index = 0; index <= 256; index += 1) {
            await value.service.observeClaudeFact(input.authority, {
              connectionId: "30000000-0000-4000-8000-000000000002",
              code: `FENCE_OVERFLOW_${String(index)}`,
              message: "bounded target callback at the effect fence",
              providerThreadId: input.providerThreadId,
              terminal: false,
              turnId: null,
              type: "providerError",
            });
          }
        };
      };
    };
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b5",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
    expect(reviewPostFenceArmedStartFence).toBe(true);
    expect(startPreFenceOverflowed).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "SEED_FACT_OVERFLOW",
        phase: "reconciliation_required",
      });
  });

  test("retries only the exact idempotent source release under one open journal", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a2";
    value.codex.endSessionErrorOnce = new Error("lost exact release response");
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "source_releasing",
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);

    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      seed: { delivered: true },
      to: { provider: "claude" },
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(2);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "seed_settled",
      sourceRelease: { status: "already_released" },
    });
  });

  test("does not replay provider effects when a source-releasing journal loses target proof", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007c8";
    value.codex.endSessionErrorOnce = new Error("hold source-releasing for corruption");
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "source_releasing",
      targetStart: { providerThreadId: value.claude.startSessionRequests[0]?.providerThreadId },
    });
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    const database = new Database(value.store.paths.database, { create: false, strict: true });
    const deleteGuard = database.query<{ sql: string }, []>(
      "SELECT sql FROM sqlite_master WHERE name='session_switch_target_start_receipts_immutable_delete'",
    ).get();
    if (deleteGuard === null) throw new Error("Expected target receipt immutable guard.");
    try {
      database.exec(`
        PRAGMA foreign_keys=OFF;
        DROP TRIGGER session_switch_target_start_receipts_immutable_delete;
      `);
      database.query(
        `DELETE FROM session_switch_target_start_receipts
         WHERE attempt_id=(
           SELECT id FROM mutation_attempts WHERE idempotency_key=?
         )`,
      ).run(idempotencyKey);
    } finally {
      database.exec(deleteGuard.sql);
      database.exec("PRAGMA foreign_keys=ON");
      database.close(false);
    }

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "SESSION_SWITCH_RECOVERY_CORRUPT" },
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("maps malformed switch replay to bounded recovery and absorbs its late target callback", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007c9";
    value.codex.endSessionErrorOnce = new Error("hold effect-started switch for quarantine");
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const open = value.store.readSessionSwitchByIdempotencyKey(idempotencyKey);
    if (open?.targetStart === null || open === null) {
      throw new Error("Expected an effect-started switch with exact target evidence.");
    }
    const targetAuthority = liveAuthorityFor(value.store, source.accountId, "claude");
    const targetProviderAuthority = value.store.requireProviderAccountAuthority(
      source.accountId,
      "claude",
    );
    const oversizedAttemptId = `attempt_${"f".repeat(4096)}`;
    const database = new Database(value.store.paths.database, { create: false, strict: true });
    const schemaBeforeCorruption = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
    const guards = database.query<{ name: string; sql: string }, []>(
      `SELECT name,sql FROM sqlite_master WHERE name IN
        ('session_switch_attempt_id_repair_guard','session_switch_adoption_parent_update',
         'session_switch_execution_parent_advance')`,
    ).all();
    expect(guards).toHaveLength(3);
    try {
      // Explicit corruption of a current journal, not an archived writer.
      // Restore every exact guard before exercising bounded recovery.
      database.exec(`
        PRAGMA foreign_keys=OFF;
        PRAGMA ignore_check_constraints=ON;
      `);
      for (const guard of guards) database.exec(`DROP TRIGGER ${guard.name}`);
      database.query(
        "UPDATE session_switch_attempts SET attempt_id=? WHERE attempt_id=?",
      ).run(oversizedAttemptId, open.attemptId);
    } finally {
      for (const guard of guards) database.exec(guard.sql);
      database.exec("PRAGMA ignore_check_constraints=OFF; PRAGMA foreign_keys=ON;");
      expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schemaBeforeCorruption);
      database.close(false);
    }
    for (const read of [
      () => value.store.readSessionSwitchByIdempotencyKey(idempotencyKey),
      () => value.store.readSessionSwitchForRecovery(source.sessionId),
    ]) {
      try {
        read();
        throw new Error("Expected malformed switch recovery to fail closed.");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(SessionSwitchStoreError);
        expect((error as Error).message).toBe("SESSION_SWITCH_RECOVERY_CORRUPT");
        expect((error as Error).message).not.toContain(oversizedAttemptId);
      }
    }
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: open.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toEqual({ blocked: true, attemptId: null, role: "target" });
    const beforeQuarantineCalls = {
      claude: [...value.claude.calls],
      codex: [...value.codex.calls],
    };
    const beforeQuarantineSession = value.store.requireSession(source.sessionId);
    const beforeQuarantineEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events;
    await value.service.observeClaudeFact(targetAuthority, {
      code: "LATE_UNDISPOSED_MALFORMED_SWITCH_TARGET_FACT",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "must remain inert before row-local quarantine",
      providerThreadId: open.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });
    expect(value.store.requireSession(source.sessionId)).toEqual(beforeQuarantineSession);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events).toEqual(beforeQuarantineEvents);
    expect(value.claude.calls).toEqual(beforeQuarantineCalls.claude);
    expect(value.codex.calls).toEqual(beforeQuarantineCalls.codex);

    expect(value.store.recoverSessionSwitchesPage()).toMatchObject({
      malformedAttemptIds: [expect.stringMatching(/^attempt_[0-9a-f]{32}$/)],
      switches: [],
    });
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: open.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toEqual({ blocked: true, attemptId: null, role: "target" });

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    const beforeSession = value.store.requireSession(source.sessionId);
    const beforeEvents = value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events;
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "SESSION_SWITCH_RECOVERY_CORRUPT" },
    });
    const loginCalls = value.codex.loginCalls;
    await expect(value.service.execute({
      account: source.accountId,
      deviceCode: false,
      idempotencyKey,
      kind: "account.login",
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { reason: "SESSION_SWITCH_RECOVERY_CORRUPT" },
    });
    expect(value.codex.loginCalls).toBe(loginCalls);
    await value.service.observeClaudeFact(targetAuthority, {
      code: "LATE_MALFORMED_SWITCH_TARGET_FACT",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "must remain inert behind the malformed journal fence",
      providerThreadId: open.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });
    expect(value.store.requireSession(source.sessionId)).toEqual(beforeSession);
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events).toEqual(beforeEvents);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("repeats idempotent source release when its durable receipt transaction fails", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const complete = value.store.completeSessionSwitchSourceRelease.bind(value.store);
    let rejectReceipt = true;
    Object.defineProperty(value.store, "completeSessionSwitchSourceRelease", {
      configurable: true,
      value: (input: Parameters<StateStore["completeSessionSwitchSourceRelease"]>[0]) => {
        if (rejectReceipt) {
          rejectReceipt = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return complete(input);
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ac";
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey))
      .toMatchObject({ phase: "source_releasing", sourceRelease: null });
    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      seed: { delivered: true },
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(2);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "seed_settled",
      sourceRelease: { status: "already_released" },
    });
  });

  describe("coupled seed outcomes", () => {
    type PreparedSeedCase = {
      rejected: Fixture;
      rejectedSession: Awaited<ReturnType<typeof codexSession>>;
      ambiguous: Fixture;
      ambiguousSession: Awaited<ReturnType<typeof codexSession>>;
      ambiguousTarget: { account: { id: `acct_${string}` } };
      ambiguousSourceAuthority: ProfileAuthority;
    };
    let prepared: {
      owner: ReturnType<typeof createOwnedSwitchCase>;
      rejected?: Pick<PreparedSeedCase, "rejected" | "rejectedSession">;
      value?: PreparedSeedCase;
    } | undefined;

    // Prepare the independent fixtures in separate bounded hooks: the first
    // template use also builds its migrated image. Both phases share one owner
    // so cancellation joins setup before closing either fixture. Every coupled
    // seed/replay/abandon assertion retains the separate 5s proof deadline.
    beforeEach(() => {
      const holder: NonNullable<typeof prepared> = { owner: createOwnedSwitchCase() };
      prepared = holder;
      const { owner } = holder;
      return owner.run(async () => {
        const rejected = await owner.request(() => fixture(undefined, undefined, true, undefined, owner.resources, "template"));
        const rejectedSession = await owner.request(() => codexSession(rejected, owner.signal));
        owner.signal.throwIfAborted();
        holder.rejected = { rejected, rejectedSession };
      });
    }, 5_000);

    beforeEach(() => {
      const holder = prepared;
      if (holder?.rejected === undefined) throw new Error("The rejected seed fixture was not prepared.");
      const { owner, rejected: { rejected, rejectedSession } } = holder;
      return owner.run(async () => {
        const ambiguous = await owner.request(() => fixture(undefined, undefined, true, undefined, owner.resources, "template"));
        const ambiguousSession = await owner.request(() => codexSession(ambiguous, owner.signal));
        const ambiguousTarget = await owner.request(() => ambiguous.service.execute(
          { kind: "account.add", label: "Ambiguous target" },
          { signal: owner.signal },
        )) as { account: { id: `acct_${string}` } };
        const ambiguousSourceAuthority = liveAuthorityFor(ambiguous.store, ambiguousSession.accountId, "codex");
        // The request's check precedes the await continuation. Check again at
        // publication and only populate this captured holder, never a later case.
        owner.signal.throwIfAborted();
        holder.value = { rejected, rejectedSession, ambiguous, ambiguousSession, ambiguousTarget, ambiguousSourceAuthority };
      });
    }, 5_000);

    test.each(["raw", "typed"] as const)("settles a proved seed rejection but never replays an ambiguous seed (%s)", (failure) => {
      const current = prepared;
      if (current?.value === undefined) throw new Error("The coupled seed case was not prepared.");
      const { rejected, rejectedSession, ambiguous, ambiguousSession, ambiguousTarget, ambiguousSourceAuthority } = current.value;
      const { request, signal } = current.owner;
      return current.owner.run(async () => {
        rejected.claude.startTurnError = new ClaudeError("INVALID_INPUT", "seed rejected");
        const rejectedKey = "00000000-0000-4000-8000-0000000007a3";
        await request(async () => expect(rejected.service.execute({
          idempotencyKey: rejectedKey,
          kind: "session.switch",
          provider: "claude",
          session: rejectedSession.sessionId,
        }, { signal })).resolves.toMatchObject({
          seed: { delivered: false, failureCode: "SEED_INVALID_INPUT" },
          turnId: null,
        }));
        expect(rejected.claude.seededMessages).toEqual([]);

        const cause = new Error("transport ended after write");
        ambiguous.claude.startTurnError = failure === "raw"
          ? cause
          : new IndeterminateClaudeEffectError("turn/start", cause);
        const ambiguousKey = "00000000-0000-4000-8000-0000000007a4";
        const ambiguousCommand = {
          idempotencyKey: ambiguousKey,
          kind: "session.switch" as const,
          provider: "claude" as const,
          account: ambiguousTarget.account.id,
          session: ambiguousSession.sessionId,
        };
        await request(async () => expect(ambiguous.service.execute(ambiguousCommand, { signal })).rejects.toMatchObject({
          code: "RECOVERY_REQUIRED",
        }));
        const calls = [...ambiguous.claude.calls];
        expect(ambiguous.store.readSessionSwitchByIdempotencyKey(ambiguousKey)).toMatchObject({
          phase: "reconciliation_required",
        });
        await request(async () => expect(ambiguous.service.execute(ambiguousCommand, { signal })).rejects.toMatchObject({
          code: "RECOVERY_REQUIRED",
        }));
        expect(ambiguous.claude.calls).toEqual(calls);
        expect(ambiguous.claude.seededMessages).toHaveLength(1);

        const beforeLateFacts = ambiguous.store.requireSession(ambiguousSession.sessionId);
        const beforeLateEvents = ambiguous.store.listSessionEvents({
          afterSequence: 0,
          sessionId: ambiguousSession.sessionId,
        }).events;
        await request(() => ambiguous.service.observeCodexFact(ambiguousSourceAuthority, {
          threadId: "codex-thread-1",
          type: "threadDeleted",
        }));
        await request(() => ambiguous.service.observeClaudeFact(
          liveAuthorityFor(ambiguous.store, ambiguousTarget.account.id, "claude"),
          {
            connectionId: "30000000-0000-4000-8000-000000000002",
            providerThreadId: "claude-thread-1",
            reason: "eof",
            type: "providerDisconnected",
          },
        ));
        const interactionCount = ambiguous.store.listInteractions({
          limit: 10,
          pendingOnly: false,
          sessionId: ambiguousSession.sessionId,
        }).length;
        await request(() => ambiguous.service.observeCodexFact(ambiguousSourceAuthority, {
          blocking: true,
          connectionId: "30000000-0000-4000-8000-000000000001",
          display: {
            availableDecisions: ["once", "decline", "cancel"],
            commandClass: "test",
            kind: "command_approval",
            reason: null,
            summary: "Must remain fenced",
            workingDirectory: null,
          },
          kind: "command_approval",
          provider: {
            approvalId: null,
            bindingGeneration: ambiguousSourceAuthority.bindingGeneration,
            connectionId: "30000000-0000-4000-8000-000000000001",
            itemId: "late-switch-item",
            method: "item/commandExecution/requestApproval",
            processGeneration: ambiguousSourceAuthority.generation,
            profileId: ambiguousSourceAuthority.id,
            provider: ambiguousSourceAuthority.provider,
            providerAccountId: ambiguousSourceAuthority.providerAccountId,
            requestDigest: "d".repeat(64),
            requestId: { type: "string", value: "late-switch-request" },
            threadId: "codex-thread-1",
            turnId: "late-switch-turn",
          },
          type: "interactionRequested",
        }));
        expect(ambiguous.store.requireSession(ambiguousSession.sessionId)).toEqual(beforeLateFacts);
        expect(ambiguous.store.listSessionEvents({
          afterSequence: 0,
          sessionId: ambiguousSession.sessionId,
        }).events).toEqual(beforeLateEvents);
        expect(ambiguous.store.listInteractions({
          limit: 10,
          pendingOnly: false,
          sessionId: ambiguousSession.sessionId,
        })).toHaveLength(interactionCount);

        const providerCallsBeforeAbandon = {
          claude: [...ambiguous.claude.calls],
          codex: [...ambiguous.codex.calls],
        };
        ambiguous.factsMemory.transferErrorOnce = new Error("abandon transfer unavailable");
        await request(async () => expect(ambiguous.service.execute({
          kind: "session.abandon",
          session: ambiguousSession.sessionId,
        }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" }));
        expect(ambiguous.store.readSessionSwitchByIdempotencyKey(ambiguousKey))
          .toMatchObject({ phase: "reconciliation_required" });
        expect(ambiguous.factsMemory.cleanups).toHaveLength(0);
        await request(async () => expect(ambiguous.service.execute({
          kind: "session.abandon",
          session: ambiguousSession.sessionId,
        }, { signal })).resolves.toMatchObject({
          idempotencyKey: ambiguousKey,
          recovery: {
            providerEffectRetried: false,
            providerStateDeleted: false,
            resolution: "abandoned",
            resolved: true,
          },
          session: { profileId: ambiguousTarget.account.id, state: "terminal" },
        }));
        expect(ambiguous.store.readSessionSwitchByIdempotencyKey(ambiguousKey))
          .toMatchObject({ phase: "abandoned" });
        expect(ambiguous.factsMemory.cleanups.at(-1)).toMatchObject({
          ownerId: ambiguousTarget.account.id,
          reason: "abandon",
          sessionId: ambiguousSession.sessionId,
        });
        expect(ambiguous.factsMemory.transfers.at(-1)?.operationKey)
          .toBe(ambiguous.factsMemory.transfers.at(-2)?.operationKey);
        await request(async () => expect(ambiguous.service.execute(ambiguousCommand, { signal })).rejects.toMatchObject({
          code: "CONFLICT",
        }));
        expect(ambiguous.claude.calls).toEqual(providerCallsBeforeAbandon.claude);
        expect(ambiguous.codex.calls).toEqual(providerCallsBeforeAbandon.codex);
      });
    }, 5_000);
  });

  test("does not release the source after a target Claude disconnects before receipt admission", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.beforeStartSessionReturn = async (input, projection) => {
      await value.service.observeClaudeFact(input.authority, {
        connectionId: "30000000-0000-4000-8000-000000000002",
        providerThreadId: projection.providerThreadId,
        reason: "eof",
        type: "providerDisconnected",
      });
    };
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a5";
    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      diagnosticCode: "TARGET_DISCONNECTED_BEFORE_RECEIPT_ADMISSION",
    });
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({ provider: "codex" });
  });

  test("does not release the source when the target-start receipt cannot commit", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "completeSessionSwitchTargetStart", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ad";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      targetStart: null,
    });
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.calls).not.toContain("start-turn");
  });

  test("reconciles a target-started switch when source-release intent admission fails", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "beginSessionSwitchSourceRelease", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_SESSION_REVISION_STALE");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ab";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      diagnosticCode: "SOURCE_RELEASE_INTENT_SESSION_SWITCH_SESSION_REVISION_STALE",
      phase: "reconciliation_required",
      targetStart: { providerThreadId: value.claude.startSessionRequests[0]?.providerThreadId },
    });
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
  });

  test("surfaces interactions terminalized by dedicated switch abandonment", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const interactionId = "30000000-0000-4000-8000-0000000007b5";
    value.claude.beforeStartSessionReturn = (input, projection) => {
      value.store.admitInteraction({
        authority: {
          approvalId: null,
          bindingGeneration: input.authority.bindingGeneration,
          connectionId: "30000000-0000-4000-8000-000000000002",
          itemId: "switch-target-item",
          method: "claude/control_request/can_use_tool",
          processGeneration: input.authority.generation,
          profileId: input.authority.id,
          provider: input.authority.provider,
          providerAccountId: input.authority.providerAccountId,
          requestDigest: "e".repeat(64),
          requestId: { type: "string", value: "switch-target-request" },
          threadId: projection.providerThreadId,
          turnId: "switch-target-turn",
        },
        blocking: true,
        display: {
          availableDecisions: ["once", "decline"],
          commandClass: "test",
          kind: "command_approval",
          reason: null,
          summary: "Target interaction before receipt",
          workingDirectory: null,
        },
        kind: "command_approval",
        publicId: interactionId,
        sessionId: null,
      });
    };
    const idempotencyKey = "00000000-0000-4000-8000-0000000007b5";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
    });
    expect(value.store.listInteractions({ limit: 200, pendingOnly: true })
      .find((interaction) => interaction.publicId === interactionId))
      .toMatchObject({ state: "pending" });

    await expect(value.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      recovery: { resolution: "abandoned", resolved: true },
    });
    expect(value.store.listInteractions({ limit: 200 })
      .find((interaction) => interaction.publicId === interactionId))
      .toMatchObject({ state: "expired" });
  });

  test("reconciles after release when exact rebind cannot commit", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "rebindSessionSwitch", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_SESSION_REVISION_STALE");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007ae";

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      rebind: null,
      sourceRelease: { status: "released" },
    });
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.claude.calls).not.toContain("start-turn");
  });

  test("never replays an accepted seed whose durable receipt cannot commit", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    Object.defineProperty(value.store, "completeSessionSwitchSeed", {
      configurable: true,
      value: () => {
        throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
      },
    });
    const idempotencyKey = "00000000-0000-4000-8000-0000000007af";
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const calls = [...value.claude.calls];
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "reconciliation_required",
      seed: null,
      seedAuthority: { provenance: "rebound" },
    });
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls);
  });

  test("moves a session between accounts on the same provider", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Second Codex account" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-thread-2",
      providerUpdatedAt: 40,
      status: "idle",
      title: "Moved session",
    };

    const switched = await value.service.execute({
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007a6",
      presetContract: currentPresetContract, kind: "session.switch",
      preset: "high",
      provider: "codex",
      session: source.sessionId,
    }, { signal });
    expect(switched).toMatchObject({
      from: { account: source.accountId, provider: "codex" },
      to: { account: target.account.id, provider: "codex" },
    });
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "codex",
      providerThreadId: "codex-thread-2",
    });
    expect(value.factsMemory.transfers).toHaveLength(1);
    expect(value.factsMemory.transfers[0]).toMatchObject({
      fromOwnerId: source.accountId,
      sessionId: source.sessionId,
      toOwnerId: target.account.id,
    });
    expect(value.factsMemory.transfers[0]?.operationKey).toMatch(
      /^session-switch-owner:[a-f0-9]{64}$/u,
    );
    expect(new TextEncoder().encode(
      value.factsMemory.transfers[0]?.operationKey ?? "",
    ).byteLength).toBeLessThanOrEqual(200);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
  });

  test("retries exact facts-memory custody before rebind without repeating provider effects", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-custody-target",
      providerUpdatedAt: 41,
      status: "idle",
      title: "Custody target",
    };
    value.factsMemory.transferErrorOnce = new Error("lost transfer response");
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007a7",
      kind: "session.switch" as const,
      presetContract: sharedActiveCodexPresetContract(),
      preset: "high" as const,
      provider: "codex" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey)).toMatchObject({
      phase: "source_released",
    });
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: source.accountId,
      providerThreadId: "codex-thread-1",
    });
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);

    const retried = await value.service.execute(command, { signal });
    expect(retried).toMatchObject({
      to: { account: target.account.id, provider: "codex" },
    });
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
    expect(value.factsMemory.transfers).toHaveLength(2);
    expect(value.factsMemory.transfers[1]?.operationKey)
      .toBe(value.factsMemory.transfers[0]?.operationKey);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
  });

  test("cancels a prepared switch before applying a source fact without an in-memory owner", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
    let rejectTargetIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
        if (rejectTargetIntent) {
          rejectTargetIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginTarget(input);
      },
    });
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b8",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const prepared = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(prepared).toMatchObject({ phase: "prepared" });
    if (prepared === null) throw new Error("Expected prepared switch.");
    const sourceAuthority = liveAuthorityFor(value.store, source.accountId, "codex");
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: "codex-thread-1",
      providerAuthority: {
        providerAccountId: sourceAuthority.providerAccountId,
        profileId: sourceAuthority.id,
        provider: sourceAuthority.provider,
        bindingGeneration: sourceAuthority.bindingGeneration,
        processGeneration: sourceAuthority.generation,
      },
    })).toMatchObject({ attemptId: prepared.attemptId, blocked: true, role: "source" });
    await value.service.observeCodexFact(
      sourceAuthority,
      {
        code: "PREPARED_SOURCE_CALLBACK",
        message: "source callback between exact retries",
        threadId: "codex-thread-1",
        type: "providerWarning",
      },
    );

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "cancelled" });
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events.some((event) => event.body.type === "warning"
      && event.body.code === "PREPARED_SOURCE_CALLBACK")).toBe(true);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(0);

    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test.each(["codex", "claude"] as const)("refuses a conflicting host binding at the inner target-start fence before any %s effect", async (provider) => {
    const value = await fixture();
    const source = await codexSession(value);
    const database = new Database(value.paths.database, { create: false, strict: true });
    const originalBinding = value.store.requireSessionHostCapabilityBinding(source.sessionId);
    const conflictingDigest = originalBinding.manifestDigest === "c".repeat(64)
      ? "d".repeat(64) : "c".repeat(64);
    const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
    let crossedInnerFence = false;
    let sourceBeforeFence: ReturnType<StateStore["requireSession"]> | undefined;
    let authorityBeforeFence: ReturnType<StateStore["requireCapturedSessionProviderAuthority"]> | undefined;
    Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
        const record = beginTarget(input);
        expect(record.phase).toBe("target_starting");
        sourceBeforeFence = value.store.requireSession(source.sessionId);
        authorityBeforeFence = value.store.requireCapturedSessionProviderAuthority(source.sessionId);
        // Arm only after the real durable intent. The next daemon assertion
        // is the awaited pre-effect fence, after any Claude launch is staged.
        value.daemonAuthority.beforeAssertReturn = () => {
          crossedInnerFence = true;
          expect(value.store.requireSessionSwitch(record.attemptId).phase).toBe("target_starting");
          expect(database.query("SELECT session_id FROM session_claude_process_launch_intents").all())
            .toEqual(provider === "claude" ? [{ session_id: source.sessionId }] : []);
          const schema = database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
          const guard = database.query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='session_host_capability_binding_immutable'",
          ).get();
          if (guard === null) throw new Error("Expected the immutable host-capability guard.");
          // Explicit adversarial corruption, not an admissible writer: the
          // source start already installed this immutable binding. Restore
          // its exact guard before the service resumes from the await.
          database.transaction(() => {
            database.exec("DROP TRIGGER session_host_capability_binding_immutable");
            expect(database.query("UPDATE session_host_capability_bindings SET manifest_digest=? WHERE session_id=?")
              .run(conflictingDigest, source.sessionId).changes).toBe(1);
            database.exec(guard.sql);
          }).immediate();
          expect(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).toEqual(schema);
          expect(value.store.requireSessionHostCapabilityBinding(source.sessionId))
            .toEqual({ ...originalBinding, manifestDigest: conflictingDigest });
        };
        return record;
      },
    });
    const command = {
      idempotencyKey: crypto.randomUUID(), kind: "session.switch" as const,
      provider, preset: provider === "codex" ? "low" as const : "fable-max" as const,
      session: source.sessionId,
    };
    const before = {
      codexStarts: value.codex.calls.filter((call) => call === "start-session").length,
      codexTurns: value.codex.calls.filter((call) => call === "start-turn").length,
    };
    try {
      await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
      expect(crossedInnerFence).toBe(true);
      if (sourceBeforeFence === undefined || authorityBeforeFence === undefined) {
        throw new Error("Expected source snapshots before the target-start fence.");
      }
      expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(before.codexStarts);
      expect(value.codex.calls.filter((call) => call === "start-turn")).toHaveLength(before.codexTurns);
      expect(value.claude.startSessionRequests).toEqual([]);
      expect(value.claude.calls.filter((call) => call === "start-turn")).toEqual([]);
      expect(value.claude.seededMessages).toEqual([]);
      expect(value.codex.endedThreads).toEqual([]);
      expect(value.claude.endedThreads).toEqual([]);
      expect(value.store.requireSession(source.sessionId)).toEqual(sourceBeforeFence);
      expect(value.store.requireCapturedSessionProviderAuthority(source.sessionId)).toEqual(authorityBeforeFence);
      const attempt = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
      if (attempt === null) throw new Error("Expected the retained no-effect switch journal.");
      expect(attempt).toMatchObject({ phase: "failed", targetStart: null, sourceRelease: null,
        diagnosticCode: "TARGET_START_SESSION_SWITCH_REQUEST_CONFLICT" });
      expect(value.store.readMutation(command.idempotencyKey)).toMatchObject({ state: "failed" });
      expect(database.query("SELECT effect,diagnostic_code FROM session_switch_no_effect_receipts WHERE attempt_id=?")
        .all(attempt.attemptId)).toEqual([{ effect: "target_start", diagnostic_code: "TARGET_START_SESSION_SWITCH_REQUEST_CONFLICT" }]);
      expect(database.query("SELECT * FROM session_claude_process_launch_intents").all()).toEqual([]);
      expect(database.query("SELECT * FROM session_claude_process_authorities").all()).toEqual([]);
      expect(value.claude.pendingReviewIds.size).toBe(0);
      const calls = { codex: [...value.codex.calls], claude: [...value.claude.calls] };
      await expect(value.service.execute(command, { signal })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(value.codex.calls).toEqual(calls.codex);
      expect(value.claude.calls).toEqual(calls.claude);
    } finally { database.close(false); }
  });

  test("proves no target effect when a prepared replay receives a source fact at the inner fence", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
    let rejectTargetIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
        if (rejectTargetIntent) {
          rejectTargetIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginTarget(input);
      },
    });
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007b9",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const sourceAuthority = liveAuthorityFor(value.store, source.accountId, "codex");
    let reviewPostFenceArmedTargetFence = false;
    let targetPreFenceDeliveredSourceFact = false;
    value.claude.beforeReviewSessionReturn = () => {
      value.daemonAuthority.beforeAssertReturn = () => {
        reviewPostFenceArmedTargetFence = true;
        value.daemonAuthority.beforeAssertReturn = async () => {
          targetPreFenceDeliveredSourceFact = true;
          await value.service.observeCodexFact(sourceAuthority, {
            code: "TARGET_FENCE_SOURCE_CALLBACK",
            message: "source callback at target pre-effect fence",
            threadId: "codex-thread-1",
            type: "providerWarning",
          });
        };
      };
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(reviewPostFenceArmedTargetFence).toBe(true);
    expect(targetPreFenceDeliveredSourceFact).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "SOURCE_FACT_BEFORE_TARGET_EFFECT",
        phase: "failed",
      });
    expect(value.store.listSessionEvents({
      afterSequence: 0,
      sessionId: source.sessionId,
    }).events.some((event) => event.body.type === "warning"
      && event.body.code === "TARGET_FENCE_SOURCE_CALLBACK")).toBe(true);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(0);
  });

  test("releases target custody when a post-start source read throws", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007bf",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };
    const beginSourceRelease = value.store.beginSessionSwitchSourceRelease.bind(value.store);
    let sourceReleaseIntentCommitted = false;
    Object.defineProperty(value.store, "beginSessionSwitchSourceRelease", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSourceRelease"]>[0]) => {
        const record = beginSourceRelease(input);
        sourceReleaseIntentCommitted = true;
        return record;
      },
    });
    const requireSession = value.store.requireSession.bind(value.store);
    let rejectPostTargetRead = true;
    Object.defineProperty(value.store, "requireSession", {
      configurable: true,
      value: (selector: Parameters<StateStore["requireSession"]>[0]) => {
        if (sourceReleaseIntentCommitted && rejectPostTargetRead) {
          rejectPostTargetRead = false;
          throw new Error("forced post-target source session read failure");
        }
        return requireSession(selector);
      },
    });

    await expect(value.service.execute(command, { signal }))
      .rejects.toThrow("forced post-target source session read failure");
    const sourceReleasing = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(sourceReleasing).toMatchObject({ phase: "source_releasing" });
    if (sourceReleasing?.targetStart === null || sourceReleasing === null) {
      throw new Error("Expected a source-releasing switch with a target receipt.");
    }
    const targetAuthority = liveAuthorityFor(value.store, source.accountId, "claude");
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await value.service.observeClaudeFact(targetAuthority, {
      code: "TARGET_CALLBACK_AFTER_POST_START_READ_FAILURE",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "target callback after the failed post-start source read",
      providerThreadId: sourceReleasing.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "FACT_WITHOUT_IN_MEMORY_CUSTODY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("resumes source-released custody after the retry sweep expires its source", async () => {
    const now = Date.now();
    const value = await fixture(() => now);
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Expired custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-expired-custody-target",
      providerUpdatedAt: 42,
      status: "idle",
      title: "Expired custody target",
    };
    if (!value.factsMemory.expiries.has(source.sessionId)) {
      throw new Error("Expected source facts-memory expiry.");
    }
    value.factsMemory.transferErrorOnce = new Error("lost expired-source transfer response");
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007b6",
      kind: "session.switch" as const,
      presetContract: sharedActiveCodexPresetContract(),
      preset: "high" as const,
      provider: "codex" as const,
      session: source.sessionId,
    };

    const firstFailure = await value.service.execute(command, { signal })
      .catch((error: unknown) => error);
    expect(firstFailure).toMatchObject({ code: "RECOVERY_REQUIRED" });
    const openSwitch = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    if (openSwitch === null) throw firstFailure;
    expect(openSwitch).toMatchObject({ phase: "source_released" });
    expect(value.factsMemory.transferSourceStates).toEqual(["active"]);
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);

    value.factsMemory.simulateExpiry = true;
    value.factsMemory.expiries.set(source.sessionId, now);
    const settled = await value.service.execute(command, { signal });
    expect(settled).toMatchObject({
      to: { account: target.account.id, provider: "codex" },
    });
    expect(value.factsMemory.transferSourceStates).toEqual(["active", "purged"]);
    expect(value.factsMemory.transfers[1]?.operationKey)
      .toBe(value.factsMemory.transfers[0]?.operationKey);
    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(2);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "seed_settled" });

    const calls = [...value.codex.calls];
    await expect(value.service.execute(command, { signal })).resolves.toEqual(settled);
    expect(value.factsMemory.transfers).toHaveLength(2);
    expect(value.codex.calls).toEqual(calls);
  });

  test("reconciles before seed when a target error arrives during rebound custody replay", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Rebound custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const beginSeed = value.store.beginSessionSwitchSeedDispatch.bind(value.store);
    let rejectSeedIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchSeedDispatch", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSeedDispatch"]>[0]) => {
        if (rejectSeedIntent) {
          rejectSeedIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginSeed(input);
      },
    });
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007b2",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound", sourceRelease: { status: "released" } });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    const firstOperationKey = value.factsMemory.transfers.at(-1)?.operationKey;
    value.factsMemory.owners.set(source.sessionId, source.accountId);
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const targetProviderAuthority = {
      providerAccountId: targetAuthority.providerAccountId,
      profileId: targetAuthority.id,
      provider: targetAuthority.provider,
      bindingGeneration: targetAuthority.bindingGeneration,
      processGeneration: targetAuthority.generation,
    };
    expect(targetProviderAuthority).toEqual(rebound.targetAuthority);
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: rebound.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toMatchObject({ attemptId: rebound.attemptId, blocked: true, role: "target" });
    let custodyCallbackDelivered = false;
    value.factsMemory.beforeTransferReturn = async () => {
      custodyCallbackDelivered = true;
      await value.service.observeClaudeFact(targetAuthority, {
        code: "CUSTODY_REPLAY_CALLBACK",
        connectionId: "30000000-0000-4000-8000-000000000002",
        message: "callback delivered while facts-memory custody was replaying",
        providerThreadId: rebound.targetStart?.providerThreadId ?? "missing-target-thread",
        terminal: true,
        turnId: null,
        type: "providerError",
      });
    };
    const targetStarts = value.claude.calls.filter((call) => call === "start-session").length;
    const sourceReleases = value.codex.calls.filter((call) => call === "end-session").length;

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.factsMemory.transfers.at(-1)?.operationKey).toBe(firstOperationKey);
    expect(value.factsMemory.owners.get(source.sessionId)).toBe(target.account.id);
    expect(custodyCallbackDelivered).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_DURING_CUSTODY_REPLAY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls.filter((call) => call === "start-session"))
      .toHaveLength(targetStarts);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.codex.calls.filter((call) => call === "end-session"))
      .toHaveLength(sourceReleases);
  });

  test("reconciles an exact target fact delivered between rebound retries", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const beginSeed = value.store.beginSessionSwitchSeedDispatch.bind(value.store);
    let rejectSeedIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchSeedDispatch", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSeedDispatch"]>[0]) => {
        if (rejectSeedIntent) {
          rejectSeedIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginSeed(input);
      },
    });
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007be",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound" });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await value.service.observeClaudeFact(targetAuthority, {
      code: "TARGET_FAILED_BETWEEN_RETRIES",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "exact target callback while no replay owner was live",
      providerThreadId: rebound.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "FACT_WITHOUT_IN_MEMORY_CUSTODY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("releases rebound custody when captured seed authority cannot be read", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-0000000007c0",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };
    const requireCaptured = value.store.requireCapturedSessionProviderAuthority.bind(value.store);
    const rebind = value.store.rebindSessionSwitch.bind(value.store);
    let rebindCommitted = false;
    Object.defineProperty(value.store, "rebindSessionSwitch", {
      configurable: true,
      value: (input: Parameters<StateStore["rebindSessionSwitch"]>[0]) => {
        const result = rebind(input);
        rebindCommitted = true;
        return result;
      },
    });
    let rejectReboundAuthorityRead = true;
    Object.defineProperty(value.store, "requireCapturedSessionProviderAuthority", {
      configurable: true,
      value: (
        sessionId: Parameters<StateStore["requireCapturedSessionProviderAuthority"]>[0],
      ) => {
        if (rejectReboundAuthorityRead && rebindCommitted && sessionId === source.sessionId) {
          rejectReboundAuthorityRead = false;
          throw new Error("forced captured seed authority read failure");
        }
        return requireCaptured(sessionId);
      },
    });

    await expect(value.service.execute(command, { signal }))
      .rejects.toThrow("forced captured seed authority read failure");
    expect(rebindCommitted).toBe(true);
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound" });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const calls = { claude: [...value.claude.calls], codex: [...value.codex.calls] };

    await value.service.observeClaudeFact(targetAuthority, {
      code: "TARGET_CALLBACK_AFTER_SEED_AUTHORITY_READ_FAILURE",
      connectionId: "30000000-0000-4000-8000-000000000002",
      message: "target callback after the failed seed authority read",
      providerThreadId: rebound.targetStart.providerThreadId,
      terminal: true,
      turnId: null,
      type: "providerError",
    });

    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "FACT_WITHOUT_IN_MEMORY_CUSTODY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.codex.calls).toEqual(calls.codex);
  });

  test("reconciles before seed when target facts overflow during rebound custody replay", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Rebound overflow target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const beginSeed = value.store.beginSessionSwitchSeedDispatch.bind(value.store);
    let rejectSeedIntent = true;
    Object.defineProperty(value.store, "beginSessionSwitchSeedDispatch", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchSeedDispatch"]>[0]) => {
        if (rejectSeedIntent) {
          rejectSeedIntent = false;
          throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED");
        }
        return beginSeed(input);
      },
    });
    const command = {
      account: target.account.id,
      idempotencyKey: "00000000-0000-4000-8000-0000000007b7",
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: source.sessionId,
    };

    await expect(value.service.execute(command, { signal })).rejects.toBeDefined();
    const rebound = value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey);
    expect(rebound).toMatchObject({ phase: "rebound" });
    if (rebound?.targetStart === null || rebound === null) {
      throw new Error("Expected a rebound switch with a target receipt.");
    }
    value.factsMemory.owners.set(source.sessionId, source.accountId);
    const targetAuthority = capturedAuthorityForSession(value.store, source.sessionId);
    const targetProviderAuthority = {
      providerAccountId: targetAuthority.providerAccountId,
      profileId: targetAuthority.id,
      provider: targetAuthority.provider,
      bindingGeneration: targetAuthority.bindingGeneration,
      processGeneration: targetAuthority.generation,
    };
    expect(targetProviderAuthority).toEqual(rebound.targetAuthority);
    expect(value.store.sessionSwitchAdmissionBlocked({
      sessionId: null,
      providerThreadId: rebound.targetStart.providerThreadId,
      providerAuthority: targetProviderAuthority,
    })).toMatchObject({ attemptId: rebound.attemptId, blocked: true, role: "target" });
    let callbackCount = 0;
    value.factsMemory.beforeTransferReturn = async () => {
      for (let index = 0; index <= 256; index += 1) {
        callbackCount += 1;
        await value.service.observeClaudeFact(targetAuthority, {
          code: `CUSTODY_OVERFLOW_${String(index)}`,
          connectionId: "30000000-0000-4000-8000-000000000002",
          message: "bounded custody replay callback",
          providerThreadId: rebound.targetStart?.providerThreadId ?? "missing-target-thread",
          terminal: false,
          turnId: null,
          type: "providerError",
        });
      }
    };

    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
    });
    expect(callbackCount).toBe(257);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({
        diagnosticCode: "TARGET_FACT_OVERFLOW_DURING_CUSTODY_REPLAY",
        phase: "reconciliation_required",
      });
    expect(value.claude.calls.filter((call) => call === "review-turn")).toHaveLength(0);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(0);
    expect(value.claude.seededMessages).toEqual([]);
  });

  test("abandons source-released recovery only after exact target custody cleanup", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Abandon custody target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    value.codex.projection = {
      providerThreadId: "codex-abandon-custody-target",
      providerUpdatedAt: 43,
      status: "idle",
      title: "Abandon custody target",
    };
    value.factsMemory.transferErrorOnce = new Error("transfer unavailable");
    const idempotencyKey = "00000000-0000-4000-8000-0000000007aa";
    await expect(value.service.execute({
      account: target.account.id,
      idempotencyKey,
      presetContract: currentPresetContract, kind: "session.switch",
      preset: "high",
      provider: "codex",
      session: source.sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      phase: "source_released",
      rebind: null,
      sourceRelease: { status: "released" },
    });
    const callsBeforeAbandon = [...value.codex.calls];

    await expect(value.service.execute({
      kind: "session.abandon",
      session: source.sessionId,
    }, { signal })).resolves.toMatchObject({
      idempotencyKey,
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        resolution: "abandoned",
      },
      session: { profileId: source.accountId, state: "terminal" },
    });
    expect(value.codex.calls).toEqual(callsBeforeAbandon);
    expect(value.factsMemory.transfers).toHaveLength(2);
    expect(value.factsMemory.transfers[1]?.operationKey)
      .toBe(value.factsMemory.transfers[0]?.operationKey);
    expect(value.factsMemory.cleanups.at(-1)).toMatchObject({
      ownerId: target.account.id,
      reason: "abandon",
      sessionId: source.sessionId,
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey))
      .toMatchObject({ phase: "abandoned" });
  });

  test("contains a target thread collision before releasing the source", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Collision target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute({ account: target.account.id, kind: "account.login", deviceCode: false }, { signal });
    // Codex allocates its own native ID and can return an already-bound thread.
    // Claude must instead honor the new Oompa-reserved UUID before PID admission.
    value.codex.projection = {
      providerThreadId: "codex-collision-thread",
      providerUpdatedAt: 42,
      status: "idle",
      title: "Existing target",
    };
    const collision = await value.service.execute({
      account: target.account.id,
      fast: false,
      presetContract: currentPresetContract, kind: "session.start",
      preset: "high",
      provider: "codex",
    }, { signal }) as { session: { id: `sess_${string}` } };
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a8";

    await expect(value.service.execute({
      account: target.account.id,
      idempotencyKey,
      presetContract: currentPresetContract, kind: "session.switch",
      provider: "codex",
      session: source.sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      diagnosticCode: "TARGET_THREAD_ALREADY_BOUND",
      phase: "reconciliation_required",
      targetStart: { providerThreadId: "codex-collision-thread" },
    });
    expect(value.store.requireSession(collision.session.id).providerThreadId)
      .toBe("codex-collision-thread");
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      profileId: source.accountId,
      provider: "codex",
      providerThreadId: "codex-thread-1",
    });
    expect(value.codex.endedThreads).toEqual([]);

    const callsBeforeAbandon = {
      claude: [...value.claude.calls],
      codex: [...value.codex.calls],
    };
    await expect(value.service.execute({
      kind: "session.abandon",
      session: source.sessionId,
    }, { signal })).resolves.toMatchObject({
      recovery: { resolution: "abandoned" },
      session: { state: "terminal" },
    });
    expect(value.factsMemory.cleanups.at(-1)).toMatchObject({
      ownerId: source.accountId,
      reason: "abandon",
      sessionId: source.sessionId,
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey))
      .toMatchObject({ phase: "abandoned" });
    expect(value.store.requireSession(collision.session.id)).toMatchObject({
      profileId: target.account.id,
      providerThreadId: "codex-collision-thread",
      state: "idle",
    });
    expect(value.claude.calls).toEqual(callsBeforeAbandon.claude);
    expect(value.codex.calls).toEqual(callsBeforeAbandon.codex);
  });

  test("contains a same-session target thread collision before releasing the source", async () => {
    const value = await fixture();
    const source = await codexSession(value);
    const idempotencyKey = "00000000-0000-4000-8000-0000000007a9";

    await expect(value.service.execute({
      account: source.accountId,
      idempotencyKey,
      presetContract: currentPresetContract, kind: "session.switch",
      preset: "ultra",
      provider: "codex",
      session: source.sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({
      diagnosticCode: "TARGET_THREAD_ALREADY_BOUND",
      phase: "reconciliation_required",
      targetStart: { providerThreadId: "codex-thread-1" },
    });
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      preset: "high",
      provider: "codex",
      providerThreadId: "codex-thread-1",
    });
    expect(value.codex.endedThreads).toEqual([]);
  });

  test("releases a Claude session under its captured generation when the Codex mirror diverges", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    );
    const claudeAuthority = value.store.requireSessionProviderAuthority(sessionId);
    const codexBefore = value.store.requireProviderAccountAuthority(accountId, "codex");
    value.store.advanceProfileGeneration(accountId, codexBefore.processGeneration);
    const codexAfter = value.store.requireProviderAccountAuthority(accountId, "codex");
    expect(codexAfter.processGeneration).not.toBe(claudeAuthority.processGeneration);
    value.codex.projection = {
      providerThreadId: "codex-thread-2",
      title: "Returned session",
      status: "idle",
      providerUpdatedAt: 30,
    };

    await expect(value.service.execute(
      { idempotencyKey: crypto.randomUUID(), presetContract: currentPresetContract, kind: "session.switch", provider: "codex", session: sessionId },
      { signal },
    )).resolves.toMatchObject({
      from: { provider: "claude" },
      to: { provider: "codex" },
    });
    expect(value.claude.calls).toContain("end-session");
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-2",
    });
  });

  test("holds the destination account lock through a cross-account provider switch", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    await value.service.execute(
      { account: target.account.id, deviceCode: false, kind: "account.login" },
      { signal },
    );
    const targetGeneration = value.store
      .requireProfileById(target.account.id).processGeneration;

    const events: string[] = [];
    let targetStartEntered!: () => void;
    const targetStarted = new Promise<void>((resolve) => { targetStartEntered = resolve; });
    let releaseTargetStart!: () => void;
    const targetStartGate = new Promise<void>((resolve) => { releaseTargetStart = resolve; });
    value.claude.beforeStartSessionReturn = async () => {
      events.push("target-start");
      targetStartEntered();
      await targetStartGate;
    };
    value.codex.beforeEndSessionReturn = () => { events.push("source-release"); };
    value.claude.beforeStartTurnReturn = () => { events.push("seed"); };
    value.codex.beforeLogoutReturn = () => { events.push("logout"); };

    let switching: Promise<unknown> | undefined;
    let logout: Promise<unknown> | undefined;
    try {
      switching = value.service.execute({
        account: target.account.id,
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      }, { signal });
      await targetStarted;

      let logoutSettled = false;
      logout = value.service.execute({
        account: target.account.id,
        idempotencyKey: crypto.randomUUID(),
        kind: "account.logout",
      }, { signal }).finally(() => { logoutSettled = true; });
      await Bun.sleep(0);

      expect(logoutSettled).toBe(false);
      expect(value.codex.calls.filter((call) => call === "logout")).toHaveLength(0);
      expect(value.store.requireProfileById(target.account.id)).toMatchObject({
        processGeneration: targetGeneration,
        state: "signed_in",
      });

      releaseTargetStart();
      const switched = await switching as {
        to: { account: `acct_${string}`; preset: string; provider: string };
      };
      await logout;

      expect(switched.to).toEqual({
        account: target.account.id,
        preset: "fable-max",
        provider: "claude",
      });
      expect(events).toEqual(["target-start", "source-release", "seed", "logout"]);
      expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
      const switchedSession = value.store.requireSession(sessionId);
      expect(switchedSession).toMatchObject({
        profileId: target.account.id,
        provider: "claude",
      });
      expect(switchedSession.providerThreadId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(value.store.latestSessionRuntimeProfile(sessionId)?.profile).toMatchObject({
        processGeneration: value.store.requireSessionProviderAuthority(sessionId).processGeneration,
        profileId: target.account.id,
      });
    } finally {
      releaseTargetStart();
      await Promise.allSettled([
        ...(switching === undefined ? [] : [switching]),
        ...(logout === undefined ? [] : [logout]),
      ]);
    }
  });

  test("releases and resumes a switched-in Claude child lost after seeding", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.send",
        message: "preserve this context",
        session: sessionId,
      },
      { signal },
    );
    const initialIdentity = value.claude.processIdentity;
    const replacementIdentity: ClaudeProcessIdentity = {
      pid: 64_002,
      pidDomain: "darwin",
      procStart: "switch-claude-replacement",
    };
    const replacementConnectionId = "30000000-0000-4000-8000-000000000003";
    value.claude.disconnectOnObserveRequest = 1;
    value.claude.processIdentityOnClaim = replacementIdentity;
    value.claude.connectionIdOnClaim = replacementConnectionId;

    const switched = await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      },
      { signal },
    ) as { seed: { delivered: boolean } };

    const switchedSession = value.store.requireSession(sessionId);
    const claudeThreadId = switchedSession.providerThreadId;
    if (claudeThreadId === undefined) throw new Error("Expected a bound Claude session.");
    expect(claudeThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(switched.seed.delivered).toBe(true);
    expect(value.claude.endRequests).toHaveLength(1);
    expect(value.claude.endRequests[0]?.providerThreadId).toBe(claudeThreadId);
    expect(value.claude.endedProcessIdentities).toEqual([initialIdentity]);
    expect(value.claude.claimRequests).toHaveLength(1);
    expect(value.claude.claimRequests[0]).toMatchObject({
      providerThreadId: claudeThreadId,
      sourceLiveness: "not_live",
      title: "New session",
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: claudeThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity: replacementIdentity,
      sessionId,
      state: "bound",
    });

    const seedDelivery = value.claude.calls.indexOf("start-turn");
    const firstObservation = value.claude.calls.indexOf("observe", seedDelivery + 1);
    const release = value.claude.calls.indexOf("end-session", firstObservation + 1);
    const claim = value.claude.calls.indexOf("claim-session", release + 1);
    const replacementObservation = value.claude.calls.indexOf("observe", claim + 1);
    expect(seedDelivery).toBeGreaterThanOrEqual(0);
    expect(firstObservation).toBeGreaterThanOrEqual(0);
    expect(firstObservation).toBeGreaterThan(seedDelivery);
    expect(release).toBeGreaterThan(firstObservation);
    expect(claim).toBeGreaterThan(release);
    expect(replacementObservation).toBeGreaterThan(claim);
    expect(value.claude.seededMessages).toHaveLength(1);
    expect(value.claude.seededMessages[0]).toContain("[Oompa provider handoff]");
  });

  test("replays a committed provider switch after response loss without repeating provider effects", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "preserve this", session: sessionId },
      { signal },
    );
    const idempotencyKey = crypto.randomUUID();
    const complete = value.store.completeSessionSwitchSeed.bind(value.store);
    Object.defineProperty(value.store, "completeSessionSwitchSeed", {
      configurable: true,
      value: (input: Parameters<StateStore["completeSessionSwitchSeed"]>[0]) => {
        complete(input);
        throw new Error("simulated response loss after durable commit");
      },
    });

    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    await expect(value.service.execute(command, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      details: { idempotencyKey },
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey)).toMatchObject({ phase: "seed_settled" });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    const callsAfterCommit = {
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
      seedStarts: value.claude.calls.filter((call) => call === "start-turn").length,
    };

    const replayed = await value.service.execute(command, { signal }) as {
      idempotencyKey: string;
      seed: { delivered: boolean };
      session: { id: string };
    };
    expect(replayed).toMatchObject({
      idempotencyKey,
      seed: { delivered: true },
      session: { id: sessionId },
    });
    expect({
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
    }).toEqual({
      sourceEnds: callsAfterCommit.sourceEnds,
      targetStarts: callsAfterCommit.targetStarts,
    });
    // A lost settlement response returns bounded recovery. The exact caller
    // replay reads the committed receipt without repeating its seed, target
    // start or source release.
    expect(callsAfterCommit.seedStarts).toBe(1);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
    const transcript = await transcriptOf(value, sessionId);
    expect(transcript.records.filter((record) => record.kind === "provider_switch")).toHaveLength(1);
    expect(transcript.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(1);
  });

  test("refuses an inactive Codex switch source before authentication or durable admission", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const idempotencyKey = crypto.randomUUID();
    let authenticationReads = 0;
    const readAccount = value.codex.readAccount.bind(value.codex);
    Object.defineProperty(value.codex, "readAccount", {
      configurable: true,
      value: async () => {
        authenticationReads += 1;
        return await readAccount();
      },
    });
    const callsBefore = [...value.codex.calls];

    await expect(value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      presetContract: legacyPresetContract,
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("inactive provider-switch preset contract"),
    });

    expect(authenticationReads).toBe(0);
    expect(value.codex.calls).toEqual(callsBefore);
    expect(value.store.readMutation(idempotencyKey)).toBeNull();
  });

  test("binds a Codex switch replay to its caller-authored source contract", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await claudeSession(value);
    await value.service.execute(
      { account: accountId, deviceCode: false, kind: "account.login" },
      { signal },
    );
    const idempotencyKey = crypto.randomUUID();
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      presetContract: currentPresetContract,
      provider: "codex" as const,
      session: sessionId,
    };

    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      idempotencyKey,
      session: { id: sessionId, preset: "ultra", provider: "codex" },
    });
    const effectsAfterCommit = {
      codexCalls: [...value.codex.calls],
      claudeCalls: [...value.claude.calls],
    };
    await expect(value.service.execute(command, { signal })).resolves.toMatchObject({
      idempotencyKey,
      session: { id: sessionId, preset: "ultra", provider: "codex" },
    });
    expect(value.codex.calls).toEqual(effectsAfterCommit.codexCalls);
    expect(value.claude.calls).toEqual(effectsAfterCommit.claudeCalls);

    await expect(value.service.execute({
      ...command,
      presetContract: legacyPresetContract,
    }, { signal })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("preset contract"),
    });
    expect(value.codex.calls).toEqual(effectsAfterCommit.codexCalls);
    expect(value.claude.calls).toEqual(effectsAfterCommit.claudeCalls);
  });

  test("replays the durable destination snapshot after a later reverse switch", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const firstKey = crypto.randomUUID();
    const firstCommand = {
      idempotencyKey: firstKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    const first = await value.service.execute(firstCommand, { signal }) as {
      session: { provider: string; providerThreadId: string; revision: number };
    };
    const firstProviderThreadId = first.session.providerThreadId;
    expect(first.session).toMatchObject({
      provider: "claude",
      providerThreadId: firstProviderThreadId,
    });
    expect(firstProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);

    await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      presetContract: currentPresetContract,
      provider: "codex",
      session: sessionId,
    }, { signal });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    const effectsAfterReverse = {
      codexEnds: value.codex.endedThreads.length,
      codexStarts: value.codex.calls.filter((call) => call === "start-session").length,
      codexTurns: value.codex.calls.filter((call) => call === "start-turn").length,
      claudeEnds: value.claude.endedThreads.length,
      claudeStarts: value.claude.calls.filter((call) => call === "start-session").length,
      claudeTurns: value.claude.calls.filter((call) => call === "start-turn").length,
    };
    const transcriptAfterReverse = await transcriptOf(value, sessionId);

    const replayed = await value.service.execute(firstCommand, { signal }) as {
      session: { provider: string; providerThreadId: string; revision: number };
    };
    expect(replayed.session).toMatchObject({
      provider: "claude",
      providerThreadId: firstProviderThreadId,
      revision: first.session.revision,
    });
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
    expect({
      codexEnds: value.codex.endedThreads.length,
      codexStarts: value.codex.calls.filter((call) => call === "start-session").length,
      codexTurns: value.codex.calls.filter((call) => call === "start-turn").length,
      claudeEnds: value.claude.endedThreads.length,
      claudeStarts: value.claude.calls.filter((call) => call === "start-session").length,
      claudeTurns: value.claude.calls.filter((call) => call === "start-turn").length,
    }).toEqual(effectsAfterReverse);
    const transcriptAfterReplay = await transcriptOf(value, sessionId);
    expect(transcriptAfterReplay.records).toEqual(transcriptAfterReverse.records);
    expect(transcriptAfterReplay.records.filter((record) => record.kind === "provider_switch"))
      .toHaveLength(2);
    expect(transcriptAfterReplay.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(2);
  });

  test("legacy canonical journal: keeps a durably seeded target when source release does not settle", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await createLegacyProviderSwitch(value, {
      idempotencyKey,
      sessionId,
      targetProvider: "claude",
      seedResult: true,
      targetRecorded: true,
    });

    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({
      kind: "session.switch",
      state: "ambiguous",
    });
    const seededProgress = value.store.readSessionProviderSwitchProgress(
      value.store.readMutation(idempotencyKey)!.id,
    );
    expect(seededProgress).toMatchObject({
      seedTurnId: "claude-turn-1",
      sourceReleased: false,
      targetReleased: false,
    });
    expect(seededProgress.targetProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    // The fixture reconstructs a persisted legacy seed receipt, not a new
    // provider invocation. Recovery must preserve it without replaying it.
    expect(value.claude.seededMessages).toHaveLength(0);
    expect(value.claude.endedThreads).toEqual([]);

    const providerThreadId = seededProgress.targetProviderThreadId;
    if (providerThreadId === undefined) throw new Error("Expected retained Claude target thread.");
    const key = { profileId: value.store.requireSession(sessionId).profileId,
      providerThreadId, runtimeScope: "managed" as const };
    const process = value.store.readClaudeProcessAuthority(key);
    if (process === null) throw new Error("Expected retained historical process custody.");
    await expect(value.claude.readSessionProcessIdentity({
      authority: liveAuthorityFor(value.store, key.profileId, "claude"), providerThreadId, signal,
    })).rejects.toThrow("No exact fake Claude writer is owned.");
    expect(value.claude.endedProcessIdentities).not.toContainEqual(process.identity);
    // This reconstructed process was never owned by the current fake manager.
    // Model its later exact PID/start exit only after the recovery assertions;
    // closing zero owned writers is not itself evidence that history is gone.
    value.claude.endedProcessIdentities.push({ ...process.identity });
    await value.service.close();
    expect(value.store.readClaudeProcessAuthority(key)?.state).toBe("released");
    expect(value.store.readSessionProviderSwitchProgress(value.store.readMutation(idempotencyKey)!.id))
      .toEqual(seededProgress);
    expect(value.claude.seededMessages).toHaveLength(0);
    expect(value.claude.endedThreads).toEqual([]);
  });

  test("legacy journal: does not replay or inspect an unseeded Claude target after daemon restart", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    const progressBeforeRestart = value.store.readSessionProviderSwitchProgress(
      attemptBeforeRestart.id,
    );
    expect(progressBeforeRestart.seed).toBeUndefined();
    expect(progressBeforeRestart).toMatchObject({
      sourceReleased: false,
      targetReleased: false,
    });
    expect(progressBeforeRestart.targetProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    expect(restarted.store.requireSession(sessionId).state).toBe("recovery_required");
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    await expect(restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("Claude sessions are process-local"),
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        providerStateUnknown: true,
        resolution: "abandoned",
        sourceReleased: false,
        sourceObserved: true,
        sourceStateUnknown: false,
        targetAddressable: true,
        targetReleased: false,
        targetStateUnknown: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual(["read"]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      originalState: "ambiguous",
      resolution: {
        evidence: {
          providerStateDeleted: false,
          providerStateUnknown: true,
          source: "claude_process_local_restart_boundary",
        },
        kind: "abandoned",
      },
      state: "reconciled",
    });
  });

  test("legacy journal: does not claim a seeded Claude target applied after daemon restart", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveFinalSwitchCommitUnsettled(value, {
      idempotencyKey,
      provider: "claude",
      session: sessionId,
    });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    const progressBeforeRestart = value.store.readSessionProviderSwitchProgress(
      attemptBeforeRestart.id,
    );
    const targetProviderThreadId = progressBeforeRestart.targetProviderThreadId;
    if (targetProviderThreadId === undefined) throw new Error("Expected a Claude target receipt.");
    expect(progressBeforeRestart).toMatchObject({
      seedTurnId: "claude-turn-1",
      sourceReleased: true,
      targetReleased: false,
    });
    expect(targetProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    expect(restarted.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      providerThreadId: targetProviderThreadId,
      state: "recovery_required",
    });
    await expect(restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("No provider effect was replayed"),
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        providerStateUnknown: true,
        sourceReleased: true,
        sourceStateUnknown: false,
        targetReleased: false,
        targetStateUnknown: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "abandoned" },
      state: "reconciled",
    });
  });

  test("legacy journal: cleans a Codex target but keeps Claude source state unknown after restart", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Codex target");
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      account: targetAccountId, idempotencyKey, provider: "codex",
      session: sessionId, stage: "seed_settled",
    });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attemptBeforeRestart.id)).toMatchObject({
      seedTurnId: "codex-turn-1",
      sourceReleased: false,
      targetProviderThreadId: "codex-thread-1",
      targetReleased: false,
    });

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    await expect(restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("Claude sessions are process-local"),
    });
    expect(restarted.codex.calls).toEqual([]);
    expect(restarted.claude.calls).toEqual([]);

    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        providerStateUnknown: true,
        sourceReleased: false,
        sourceStateUnknown: true,
        targetReleased: true,
        targetStateUnknown: false,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual(["end-session"]);
    expect(restarted.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "abandoned" },
      state: "reconciled",
    });
  });

  test("canonical39: abandons a quarantined Claude-source switch locally without provider access", async () => {
    const original = canonical39SwitchFixtures["claude-seeded-target"].retained;
    const sessionId = original.session.id;
    const idempotencyKey = original.idempotencyKey;
    const restarted = await fixture(Date.now, new OfflineCloud(), false, "claude-seeded-target");
    await restarted.service.recover();
    expectCanonical39SwitchRetained(restarted, "claude-seeded-target");
    expect(restarted.store.hasUnsettledLegacyProviderAuthorityQuarantineForSession(sessionId)).toBe(true);
    const codexCallsBefore = [...restarted.codex.calls];
    const codexAccountReadsBefore = restarted.codex.readAccountCalls;
    const claudeCallsBefore = [...restarted.claude.calls];
    expect(codexCallsBefore).toEqual([]);
    expect(codexAccountReadsBefore).toBe(0);
    expect(claudeCallsBefore).toEqual([]);
    await expect(restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    await expect(restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      recovery: {
        providerEffectRetried: false,
        providerStateDeleted: false,
        resolution: "abandoned",
        resolved: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).toEqual(codexCallsBefore);
    expect(restarted.codex.readAccountCalls).toBe(codexAccountReadsBefore);
    expect(restarted.codex.endedThreads).toEqual([]);
    expect(restarted.claude.calls).toEqual(claudeCallsBefore);
    expect(restarted.claude.accountIdentityReadCalls).toBe(0);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: {
        evidence: { authority: "legacy_provider_authority_quarantined", providerStateDeleted: false, providerEffectRetried: false },
        kind: "abandoned",
      },
      state: "reconciled",
    });
    expectCanonical39SwitchRetained(restarted, "claude-seeded-target");
  });

  test("legacy journal: does not target a replacement Codex account while abandoning a recovered switch", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Replaced Codex target");
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      account: targetAccountId, idempotencyKey, provider: "codex", session: sessionId, stage: "seed_settled",
    });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart?.evidence?.evidence.kind !== "session.switch") {
      throw new Error("Expected an unsettled provider switch.");
    }
    expect(attemptBeforeRestart.evidence.evidence.targetProviderAccountKey).toBeString();

    const restarted = await reopenFixture(value);
    restarted.codex.accountProjection = {
      signedIn: true,
      email: "replacement@example.com",
    };
    expect(await restarted.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        providerStateUnknown: true,
        sourceReleased: false,
        sourceStateUnknown: true,
        targetReleased: false,
        targetStateUnknown: true,
      },
      session: { state: "terminal" },
    });
    expect(restarted.codex.calls).not.toContain("end-session");
    expect(restarted.codex.endedThreads).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: {
        evidence: {
          providerStateDeleted: false,
          providerStateUnknown: true,
          targetReleased: false,
          targetStateUnknown: true,
        },
        kind: "abandoned",
      },
      state: "reconciled",
    });
  });

  test("keeps a lost target start ambiguous when the target account changes before the response", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Lost-response Codex target");
    const idempotencyKey = crypto.randomUUID();
    const startTarget = value.codex.startSession.bind(value.codex);
    Object.defineProperty(value.codex, "startSession", {
      configurable: true,
      value: async (input: Parameters<CodexRuntimePort["startSession"]>[0]) => {
        await startTarget(input);
        value.codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
        };
        throw new IndeterminateCodexEffectError("thread/start", 71);
      },
    });

    await expect(value.service.execute({
      account: targetAccountId,
      idempotencyKey,
      kind: "session.switch",
      presetContract: currentPresetContract,
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.codex.calls.filter((call) => call === "start-session")).toHaveLength(1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(0);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "recovery_required",
    });
    await value.service.settled();
    await expect(value.service.close()).resolves.toBeUndefined();
  });

  test("legacy journal: runs the forced target-account proof after a failed recovery read", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Read-race Codex target");
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      account: targetAccountId, idempotencyKey, provider: "codex", session: sessionId, stage: "seed_intended",
    });
    const readsBefore = value.codex.calls.filter((call) => call === "read").length;
    const endsBefore = value.codex.calls.filter((call) => call === "end-session").length;
    Object.defineProperty(value.codex, "readSession", {
      configurable: true,
      value: async () => {
        value.codex.calls.push("read");
        value.codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
        };
        throw new Error("simulated target read failure");
      },
    });

    const failure = await value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "IndeterminateLocalCommitError" });
    expect(value.codex.calls.filter((call) => call === "read")).toHaveLength(readsBefore + 1);
    expect(value.codex.calls.filter((call) => call === "end-session")).toHaveLength(endsBefore);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
  });

  test("runs the forced target-account proof when post-switch observation fails", async () => {
    const value = await fixture();
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Observation-race Codex target");
    const idempotencyKey = crypto.randomUUID();
    Object.defineProperty(value.codex, "observeSession", {
      configurable: true,
      value: async () => {
        value.codex.calls.push("observe");
        value.codex.accountProjection = {
          signedIn: true,
          email: "replacement@example.com",
        };
        throw new CodexSessionObservationError("resume_unavailable");
      },
    });

    const settled = await value.service.execute({
      account: targetAccountId,
      idempotencyKey,
      kind: "session.switch",
      presetContract: currentPresetContract,
      provider: "codex",
      session: sessionId,
    }, { signal });

    expect(settled).toMatchObject({ seed: { delivered: true }, to: { provider: "codex" } });
    expect(value.codex.calls.filter((call) => call === "observe")).toHaveLength(1);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: targetAccountId,
      provider: "codex",
      state: "recovery_required",
    });
  });

  test("retains a launch fence and never target-ends a resumed Claude controller without PID custody", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.claude.disconnectOnObserveRequest = 1;
    value.claude.omitProcessIdentityOnClaim = true;
    value.claude.beforeClaimSessionReturn = () => {
      value.claude.accountSignedIn = false;
    };

    const settled = await value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal });

    expect(settled).toMatchObject({ seed: { delivered: true }, to: { provider: "claude" } });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "applied" });
    expect(value.claude.claimRequests).toHaveLength(1);
    // The first end releases the exact process that failed observation. The
    // replacement claim omitted PID/start custody, so it must never receive a
    // thread-targeted end even though its account changed during the call.
    expect(value.claude.endedThreads).toHaveLength(1);
    const providerThreadId = value.claude.claimRequests[0]?.providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected the resumed Claude target id.");
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      profileId: accountId,
      providerAccountKey: expect.any(String),
      sessionId,
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      state: "recovery_required",
    });
    await expect(value.service.close()).rejects.toThrow(
      "An unresolved Claude launch still requires exact process recovery.",
    );
    const tracked = services.indexOf(value.service);
    if (tracked >= 0) services.splice(tracked, 1);
  });

  test("does not record target release when cleanup fails across an account change", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const endTarget = value.claude.endSession.bind(value.claude);
    const targetEndsBefore = value.claude.endedThreads.length;
    Object.defineProperty(value.claude, "endSession", {
      configurable: true,
      value: async (input: Parameters<ClaudeRuntimePort["endSession"]>[0]) => {
        await endTarget(input);
        value.claude.accountSignedIn = false;
        throw new Error("simulated cleanup response loss");
      },
    });

    const result = await value.service.execute({
      kind: "session.abandon",
      session: sessionId,
    }, { signal }) as { session: { state: string } };
    expect(result.session.state).toBe("terminal");
    expect(value.claude.endedThreads).toHaveLength(targetEndsBefore + 1);
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected the ambiguous provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).targetReleased).toBe(false);
    expect(attempt).toMatchObject({
      resolution: { kind: "abandoned" },
      state: "reconciled",
    });
  });

  test("canonical39: retains an aliased target under unproved account identity without provider access", async () => {
    const original = canonical39SwitchFixtures["codex-aliased-target"].retained;
    expect(original.progress.targetProviderThreadId).toBe(original.sourceSession.providerThreadId);
    expect(Object.hasOwn(original.effect.evidence, "targetProviderAccountKey")).toBe(false);
    const value = await fixture(Date.now, new OfflineCloud(), false, "codex-aliased-target");
    await value.service.recover();
    // The archived API admitted the alias. Migration retains it under
    // quarantine; the earlier account-identity fence refuses both operations.
    await expectCanonical39IdentityRefusal(value, "codex-aliased-target");
  });

  test("canonical39: retains a distinct target under unproved account identity without provider access", async () => {
    const original = canonical39SwitchFixtures["codex-distinct-target"].retained;
    expect(original.progress.targetProviderThreadId).not.toBe(original.sourceSession.providerThreadId);
    const value = await fixture(Date.now, new OfflineCloud(), false, "codex-distinct-target");
    await value.service.recover();
    await expectCanonical39IdentityRefusal(value, "codex-distinct-target");
  });

  test("canonical39: retains the bound target runtime without inventing subscription identity", async () => {
    // Schema39 has no facts-memory authority; this control supplies no port.
    const original = canonical39SwitchFixtures["claude-bound-target"].retained;
    const sessionId = original.session.id;
    const targetAccountId = original.targetProfile.id;
    const restarted = await fixture(Date.now, new OfflineCloud(), false, "claude-bound-target");
    await restarted.service.recover();
    expectCanonical39SwitchRetained(restarted, "claude-bound-target");
    expect(restarted.store.requireSession(sessionId)).toMatchObject({
      profileId: targetAccountId,
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    expect(restarted.store.requireCapturedSessionProviderAuthority(sessionId)).toMatchObject({
      profileId: targetAccountId, providerAccountId: targetAccountId,
      provider: "codex", bindingGeneration: 1,
      processGeneration: restarted.store.requireProviderAccountAuthority(targetAccountId, "codex").processGeneration,
    });
    await expectCanonical39IdentityRefusal(restarted, "claude-bound-target");
    expect(restarted.factsMemory.owners.size).toBe(0);
    expect(restarted.factsMemory.cleanups).toEqual([]);
    expect(restarted.factsMemory.transfers).toEqual([]);
    expectCanonical39SwitchRetained(restarted, "claude-bound-target");
  });

  test("canonical39: retains post-migration synthetic memory at the earlier account identity refusal", async () => {
    const original = canonical39SwitchFixtures["claude-bound-target"].retained;
    const sessionId = original.session.id;
    const sourceAccountId = original.sourceProfile.id;
    const targetAccountId = original.targetProfile.id;
    const idempotencyKey = original.idempotencyKey;
    const restarted = await fixture(Date.now, new OfflineCloud(), true, "claude-bound-target");
    await restarted.service.recover();
    expectCanonical39SwitchRetained(restarted, "claude-bound-target");
    // The archived image has no memory. This is a new synthetic port owner,
    // introduced after migration, not historical memory or a transfer receipt.
    await restarted.factsMemory.ensureSession({
      sessionId, ownerId: sourceAccountId, expiresAt: Date.now() + 60_000,
    });
    const attempt = restarted.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected the original switch authority.");
    const progress = restarted.store.readSessionProviderSwitchProgress(attempt.id);
    const session = restarted.store.requireSession(sessionId);
    const authority = restarted.store.requireCapturedSessionProviderAuthority(sessionId);
    const codexCalls = [...restarted.codex.calls];
    const codexAccountReads = restarted.codex.readAccountCalls;
    const claudeCalls = [...restarted.claude.calls];
    expect(restarted.factsMemory.owners.get(sessionId)).toBe(sourceAccountId);
    expect(restarted.factsMemory.states.get(sessionId)).toBe("active");
    expect(restarted.factsMemory.transfers).toEqual([]);
    expect(session).toMatchObject({ profileId: targetAccountId, state: "recovery_required" });

    await expect(restarted.service.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED", message: expect.stringContaining("unprovable provider account identity") });

    expect(restarted.store.readMutation(idempotencyKey)).toEqual(attempt);
    expect(restarted.store.readSessionProviderSwitchProgress(attempt.id)).toEqual(progress);
    expect(restarted.store.requireSession(sessionId)).toEqual(session);
    expect(restarted.store.requireCapturedSessionProviderAuthority(sessionId)).toEqual(authority);
    expect(restarted.factsMemory.owners.get(sessionId)).toBe(sourceAccountId);
    expect(restarted.factsMemory.states.get(sessionId)).toBe("active");
    expect(restarted.factsMemory.transfers).toEqual([]);
    expect(restarted.factsMemory.cleanups).toEqual([]);
    expect(restarted.codex.calls).toEqual(codexCalls);
    expect(restarted.codex.readAccountCalls).toBe(codexAccountReads);
    expect(restarted.claude.calls).toEqual(claudeCalls);
    expectCanonical39SwitchRetained(restarted, "claude-bound-target");
    await expectCanonical39IdentityRefusal(restarted, "claude-bound-target");
  });

  test("legacy journal: recovers a seeded Codex target when the Claude source release receipt survived restart", async () => {
    // The retained protocol predates the optional facts-memory transfer port.
    // This case proves provider recovery, not authority to move a memory owner.
    const value = await fixture(Date.now, new OfflineCloud(), false);
    const { sessionId } = await claudeSession(value);
    const targetAccountId = await signedInCodexAccount(value, "Recoverable Codex target");
    const idempotencyKey = crypto.randomUUID();
    await leaveFinalSwitchCommitUnsettled(value, {
      account: targetAccountId,
      idempotencyKey,
      presetContract: currentPresetContract,
      provider: "codex",
      session: sessionId,
    });
    const attemptBeforeRestart = value.store.readMutation(idempotencyKey);
    if (attemptBeforeRestart === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attemptBeforeRestart.id)).toMatchObject({
      seedTurnId: "codex-turn-1",
      sourceReleased: true,
      targetProviderThreadId: "codex-thread-1",
      targetReleased: false,
    });

    const restarted = await reopenFixture(value);
    expectCurrentSwitchSuccessors(restarted, idempotencyKey);
    expect(await restarted.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerEffectRetried: false,
        resolution: "proven_applied",
      },
      session: {
        profileId: targetAccountId,
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(restarted.codex.calls).toEqual(["read", "read"]);
    expect(restarted.claude.calls).toEqual([]);
    expect(restarted.store.readMutation(idempotencyKey)).toMatchObject({
      resolution: { kind: "proven_applied" },
      state: "reconciled",
    });
    const transcript = await transcriptOf(restarted, sessionId);
    expect(transcript.records.filter((record) => record.kind === "provider_switch"))
      .toHaveLength(1);
    expect(transcript.records.filter(
      (record) => record.kind === "user" && record.actor === "provider_switch",
    )).toHaveLength(1);
  });

  test("legacy journal: does not accept one visible seed match from an incomplete recovery projection", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      idempotencyKey, provider: "claude", session: sessionId, stage: "seed_intended",
    });
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    const targetProviderThreadId = value.store
      .readSessionProviderSwitchProgress(attempt.id).targetProviderThreadId;
    if (targetProviderThreadId === undefined) throw new Error("Expected a Claude target receipt.");
    value.claude.projection = {
      ...value.claude.projection,
      messages: [{
        clientId: attempt.id,
        role: "user",
        text: "[Oompa provider handoff]\nlegacy recovery fixture",
        turnId: "claude-turn-1",
      }],
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 1,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
      turnSummaries: [{
        actions: [],
        files: [],
        id: "claude-turn-1",
        omittedActions: 0,
        omittedFiles: 0,
        status: "completed",
      }],
    };

    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("cannot prove that the seed match is unique"),
    });
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).seedTurnId).toBeUndefined();
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.endedThreads).toEqual([]);

    value.claude.projection = {
      ...value.claude.projection,
      messages: [
        {
          clientId: attempt.id,
          role: "user",
          text: "[Oompa provider handoff]\nlegacy recovery fixture",
          turnId: "claude-turn-1",
        },
        {
          clientId: attempt.id,
          role: "user",
          text: "same client id, different message",
        },
      ],
      omission: {
        hasMoreOlderTurns: false,
        incompleteTurnIds: [],
        omittedMessages: 0,
        returnedTurns: 1,
        truncatedMessages: 0,
        turnLimit: 20,
        unreadItemTurnIds: [],
      },
      turnSummaries: [],
    };
    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("multiple messages"),
    });
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).seedTurnId).toBeUndefined();
    expect(value.claude.endedThreads).toEqual([]);

    value.claude.projection = {
      ...value.claude.projection,
      messages: [{
        clientId: attempt.id,
        role: "user",
        text: "same client id, different message",
        turnId: "claude-turn-1",
      }],
    };
    await expect(value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({
      code: "RECOVERY_REQUIRED",
      message: expect.stringContaining("does not exactly match"),
    });
    expect(value.claude.endedThreads).toEqual([]);

    value.claude.projection = {
      ...value.claude.projection,
      messages: [],
    };
    expect(await value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        resolution: "abandoned",
      },
      session: {
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(value.claude.endedThreads).toEqual([targetProviderThreadId]);
    expect(value.codex.endedThreads).toEqual([]);
  });

  test("legacy journal: reports retained source state after cleaning an unseeded target", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    const targetProviderThreadId = value.store
      .readSessionProviderSwitchProgress(attempt.id).targetProviderThreadId;
    if (targetProviderThreadId === undefined) {
      throw new Error("Expected an exact provider-switch target receipt.");
    }

    expect(await value.service.execute({
      kind: "session.recover",
      session: sessionId,
    }, { signal })).toMatchObject({
      recovery: {
        providerStateDeleted: false,
        resolution: "abandoned",
      },
      session: {
        provider: "codex",
        providerThreadId: "codex-thread-1",
        state: "idle",
      },
    });
    expect(value.claude.endedThreads).toEqual([targetProviderThreadId]);
    expect(value.codex.endedThreads).toEqual([]);
  });

  test("legacy journal: does not resolve abandonment after losing daemon authority during target cleanup", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const endTarget = value.claude.endSession.bind(value.claude);
    Object.defineProperty(value.claude, "endSession", {
      configurable: true,
      value: async (input: Parameters<ClaudeRuntimePort["endSession"]>[0]) => {
        await endTarget(input);
        stale = true;
      },
    });
    try {
      await expect(value.service.execute({
        kind: "session.abandon",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.claude, "endSession", {
        configurable: true,
        value: endTarget,
      });
    }

    expect(value.store.requireSession(sessionId).state).toBe("recovery_required");
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).targetReleased).toBe(false);
  });

  test("legacy journal: does not resolve abandonment after losing daemon authority during source read", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await leaveUnseededTargetUnsettled(value, sessionId, idempotencyKey);
    const readSource = value.codex.readSession.bind(value.codex);
    Object.defineProperty(value.codex, "readSession", {
      configurable: true,
      value: async () => {
        const projection = await readSource();
        stale = true;
        return projection;
      },
    });
    try {
      await expect(value.service.execute({
        kind: "session.abandon",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.codex, "readSession", {
        configurable: true,
        value: readSource,
      });
    }

    expect(value.store.requireSession(sessionId).state).toBe("recovery_required");
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    const attempt = value.store.readMutation(idempotencyKey);
    if (attempt === null) throw new Error("Expected an unsettled provider switch.");
    expect(value.store.readSessionProviderSwitchProgress(attempt.id).targetReleased).toBe(true);
  });

  test("leaves the switch effect unsettled after daemon authority is lost during target cleanup", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    await recordHistoricalSwitchProgress(value, {
      idempotencyKey, provider: "claude", session: sessionId,
      stage: "target_started", unsettledState: "effect_started",
    });
    value.store.quarantineSession(sessionId);
    const endTarget = value.claude.endSession.bind(value.claude);
    Object.defineProperty(value.claude, "endSession", {
      configurable: true,
      value: async (input: Parameters<ClaudeRuntimePort["endSession"]>[0]) => {
        await endTarget(input);
        stale = true;
      },
    });
    try {
      await expect(value.service.execute({
        kind: "session.abandon",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.claude, "endSession", {
        configurable: true,
        value: endTarget,
      });
    }

    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
  });

  test("does not settle a source release after its forced account proof loses daemon authority", async () => {
    let stale = false;
    const value = await fixture({
      assertCurrent: async () => {
        if (stale) throw new DaemonAuthoritySafetyError("simulated stale daemon authority");
      },
      close: () => {},
    });
    const { sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    const readAccount = value.codex.readAccount.bind(value.codex);
    Object.defineProperty(value.codex, "readAccount", {
      configurable: true,
      value: async () => {
        const account = await readAccount();
        if (value.codex.calls.includes("end-session")) stale = true;
        return account;
      },
    });
    try {
      await expect(value.service.execute({
        idempotencyKey,
        kind: "session.switch",
        provider: "claude",
        session: sessionId,
      }, { signal })).rejects.toBeInstanceOf(DaemonAuthoritySafetyError);
    } finally {
      stale = false;
      Object.defineProperty(value.codex, "readAccount", {
        configurable: true,
        value: readAccount,
      });
    }

    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "effect_started" });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "idle",
    });
  });

  test("serializes a local cross-account switch before target Claude login admission", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Local target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    let entered!: () => void;
    let release!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    value.claude.beforeReadAccountReturn = async () => {
      entered();
      await holdRead;
    };

    const switching = value.service.execute({
      account: target.account.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal });
    await enteredRead;
    const loginKey = crypto.randomUUID();
    let loginSettled = false;
    const login = value.service.execute({
      account: target.account.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal }).then(
      (result) => ({ result, status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    ).finally(() => { loginSettled = true; });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(loginSettled).toBe(false);

    release();
    await expect(switching).resolves.toMatchObject({
      session: { id: sessionId, profileId: target.account.id, provider: "claude" },
    });
    const loginOutcome = await login;
    expect(loginOutcome).toMatchObject({
      result: {
        authentication: { provider: "claude", signedIn: true },
        login: { status: "signed_in" },
      },
      status: "fulfilled",
    });
    expect(value.store.readMutation(loginKey)).toBeNull();
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "claude",
      state: "idle",
    });
    expect(value.claude.endedThreads).toEqual([]);
  });

  test("refuses an owner send captured before a cross-account switch wins", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Owner-send target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    let entered!: () => void;
    let release!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    value.claude.accountSignedInResults.push(true);
    value.claude.beforeReadAccountReturn = async () => {
      entered();
      await holdRead;
    };

    const switching = value.service.execute({
      account: target.account.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal });
    await enteredRead;
    let sendSettled = false;
    const sending = value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.send",
      message: "This stale account authority must not dispatch.",
      session: sessionId,
    }, { signal }).then(
      (result) => ({ result, status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    ).finally(() => { sendSettled = true; });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(sendSettled).toBe(false);

    release();
    await expect(switching).resolves.toMatchObject({
      session: { id: sessionId, profileId: target.account.id, provider: "claude" },
    });
    const sendOutcome = await sending;
    expect(sendOutcome.status).toBe("rejected");
    expect(sendOutcome.status === "rejected" ? sendOutcome.error : undefined)
      .toMatchObject({ code: "CONFLICT", name: "CommandFailure" });
    expect(value.codex.calls.filter((call) => call === "start-turn")).toEqual([]);
    expect(value.claude.calls.filter((call) => call === "start-turn")).toHaveLength(1);
  });

  test("serializes a remote cross-account switch before target Claude login admission", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const target = await value.service.execute(
      { kind: "account.add", label: "Remote target" },
      { signal },
    ) as { account: { id: `acct_${string}` } };
    const session = value.store.requireSession(sessionId);
    const profile = value.store.requireProfileById(accountId);
    if (session.providerThreadId === undefined) throw new Error("Expected a bound session.");
    let entered!: () => void;
    let release!: () => void;
    const enteredRead = new Promise<void>((resolve) => { entered = resolve; });
    const holdRead = new Promise<void>((resolve) => { release = resolve; });
    value.claude.beforeReadAccountReturn = async () => {
      entered();
      await holdRead;
    };

    const switching = value.service.executeRemote({
      account: target.account.id,
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, {
      ...value.store.requireProviderAccountAuthority(profile.id, "codex"),
      providerThreadId: session.providerThreadId,
      sessionId,
    }, { signal });
    await enteredRead;
    const loginKey = crypto.randomUUID();
    let loginSettled = false;
    const login = value.service.execute({
      account: target.account.id,
      idempotencyKey: loginKey,
      kind: "account.claude-login.prepare",
    }, { signal }).then(
      (result) => ({ result, status: "fulfilled" as const }),
      (error: unknown) => ({ error, status: "rejected" as const }),
    ).finally(() => { loginSettled = true; });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(loginSettled).toBe(false);

    release();
    await expect(switching).resolves.toMatchObject({
      session: { id: sessionId, profileId: target.account.id, provider: "claude" },
    });
    expect(await login).toMatchObject({
      result: {
        authentication: { provider: "claude", signedIn: true },
        login: { status: "signed_in" },
      },
      status: "fulfilled",
    });
    expect(value.store.readMutation(loginKey)).toBeNull();
    expect(value.store.requireSession(sessionId)).toMatchObject({
      profileId: target.account.id,
      provider: "claude",
      state: "idle",
    });
    expect(value.claude.endedThreads).toEqual([]);
  });

  test("replays a remote provider switch after its original authority changed", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const sourceSession = value.store.requireSession(sessionId);
    const sourceProfile = value.store.requireProfileById(accountId);
    if (sourceSession.providerThreadId === undefined) throw new Error("Expected a bound session.");
    const idempotencyKey = crypto.randomUUID();
    const command = {
      idempotencyKey,
      kind: "session.switch" as const,
      provider: "claude" as const,
      session: sessionId,
    };
    const expectedAuthority = {
      ...value.store.requireProviderAccountAuthority(sourceProfile.id, "codex"),
      providerThreadId: sourceSession.providerThreadId,
      sessionId,
    };
    await expect(value.service.executeRemote(command, expectedAuthority, { signal }))
      .resolves.toMatchObject({ session: { id: sessionId, provider: "claude" } });
    const callsAfterCommit = {
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
      seedStarts: value.claude.calls.filter((call) => call === "start-turn").length,
    };
    await expect(value.service.executeRemote(command, expectedAuthority, { signal }))
      .resolves.toMatchObject({ idempotencyKey, session: { id: sessionId, provider: "claude" } });
    expect({
      sourceEnds: value.codex.endedThreads.length,
      targetStarts: value.claude.calls.filter((call) => call === "start-session").length,
      seedStarts: value.claude.calls.filter((call) => call === "start-turn").length,
    }).toEqual(callsAfterCommit);
  });

  test("refuses a switch during an active turn and a preset the target cannot run", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    await expect(value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", preset: "low", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toThrow(/does not support the `low` model preset/u);

    value.codex.turnStatus = "inProgress";
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "long job", session: sessionId },
      { signal },
    );
    const refusal = await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("CONFLICT");
    expect((refusal as CommandFailure).message).toContain("active turn");
    expect(value.store.requireSession(sessionId).provider).toBe("codex");
  });

  test("leaves the source provider intact when target review refuses before any launch", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    value.claude.beforeReviewSessionReturn = () => {
      throw new ClaudeError("INVALID_INPUT", "Claude Code refused the session.");
    };
    await expect(value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    )).rejects.toThrow("Claude Code refused the session.");
    const session = value.store.requireSession(sessionId);
    expect(session.provider).toBe("codex");
    expect(session.preset).toBe("high");
    expect(session.providerThreadId).toBe("codex-thread-1");
    // The outgoing provider is released only after the target accepted, so a
    // refused target never strands a session on a released thread.
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.claude.startSessionRequests).toEqual([]);

    // A later switch still works.
    delete value.claude.beforeReviewSessionReturn;
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    );
    expect(value.store.requireSession(sessionId).provider).toBe("claude");
    expect(value.codex.endedThreads).toEqual(["codex-thread-1"]);
  });

  test.each(["target_starting", "rebound"] as const)("restart attention repair preserves a %s switch quarantine without provider replay", async (phase) => {
    const value = await fixture();
    const source = await codexSession(value);
    const unrelated = value.store.upsertProviderSession({
      providerAuthority: value.store.requireProviderAccountAuthority(source.accountId, "codex"),
      profileId: source.accountId,
      provider: "codex",
      preset: "high",
      fastEnabled: false,
      providerAccountKey: `v1:codex:${createHash("sha256").update("person@example.com").digest("hex")}`,
      providerThreadId: "unrelated-restart-attention-thread",
      title: "Unrelated restart attention",
      state: "idle",
    });
    const attention = value.store.upsertSessionState({
      sessionId: source.sessionId,
      state: "needs_approval",
      attention: true,
      reason: "autorespond_protected_authority_required",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 1_000,
      revision: (value.store.readSessionState(source.sessionId)?.revision ?? 0) + 1,
    });
    if (phase === "target_starting") {
      const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
      Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
        configurable: true,
        value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
          beginTarget(input);
          throw new Error("crash after target-start intent");
        },
      });
    } else {
      Object.defineProperty(value.store, "beginSessionSwitchSeedDispatch", {
        configurable: true,
        value: () => { throw new SessionSwitchStoreError("SESSION_SWITCH_STORAGE_FENCED"); },
      });
    }
    const key = crypto.randomUUID();
    await expect(value.service.execute({
      idempotencyKey: key,
      kind: "session.switch",
      provider: "claude",
      session: source.sessionId,
    }, { signal })).rejects.toBeDefined();
    const prepared = value.store.readSessionSwitchByIdempotencyKey(key);
    expect(prepared).toMatchObject({ phase });
    if (prepared === null) throw new Error("Expected the dedicated switch journal.");
    expect(value.store.readSessionState(source.sessionId)).toEqual(attention);
    const originalAuthorities = value.store.readMutationProviderAuthorities(prepared.attemptId);
    const calls = { codex: [...value.codex.calls], claude: [...value.claude.calls] };
    const targetProcess = prepared.targetStart === null ? null : value.store.readClaudeProcessAuthority({
      profileId: prepared.targetAuthority.profileId,
      providerThreadId: prepared.targetStart.providerThreadId, runtimeScope: "managed",
    });
    const bootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;

    const daemonGeneration = value.store.nextDaemonGeneration(bootId);

    expect(value.store.readSessionSwitchByIdempotencyKey(key)).toMatchObject({
      phase: "reconciliation_required",
      diagnosticCode: "DAEMON_RESTART_AUTHORITY_RETIRED",
    });
    expect(value.store.requireSession(source.sessionId).state).toBe("recovery_required");
    expect(value.store.readSessionState(source.sessionId)).toEqual(attention);
    expect(value.store.readMutationProviderAuthorities(prepared.attemptId)).toEqual(originalAuthorities);
    expect(value.store.requireSessionProviderAuthority(unrelated.id).processGeneration)
      .toBeGreaterThan(prepared.sourceAuthority.processGeneration);
    const restarted = new OompaService({
      claude: value.claude,
      cloud: new OfflineCloud(),
      codex: value.codex,
      daemonAuthority: new SwitchDaemonAuthority(),
      daemonGeneration,
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    services.push(restarted);
    await restarted.recover();
    // This fixture deliberately reuses the old manager. Boot may join exactly
    // that still-owned old PID, but it cannot inspect/resume or seed the thread.
    expect(value.claude.calls).toEqual(phase === "rebound"
      ? [...calls.claude, "read-identity", "end-session"] : calls.claude);
    if (phase === "rebound") {
      if (targetProcess === null) throw new Error("Expected frozen rebound target process.");
      expect(value.claude.endedProcessIdentities).toEqual([targetProcess.identity]);
      expect(value.store.readClaudeProcessAuthority({
        profileId: targetProcess.profileId, providerThreadId: targetProcess.providerThreadId,
        runtimeScope: "managed",
      })).toMatchObject({ state: "released", identity: targetProcess.identity,
        providerAuthority: targetProcess.providerAuthority, sessionId: targetProcess.sessionId });
    }
    const afterCleanupCalls = [...value.claude.calls];
    await expect(restarted.execute({ kind: "session.recover", session: source.sessionId }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls).toEqual(afterCleanupCalls);
    expect(value.store.nextDaemonGeneration(bootId)).toBe(daemonGeneration);
    expect(value.store.readSessionState(source.sessionId)).toEqual(attention);
  });

  test.each(["codex", "claude"] as const)("restart attention repair reflects the final active %s session disposition", async (provider) => {
    const value = await fixture();
    const active = {
      providerThreadId: `${provider}-active-attention-thread`,
      title: "Active restart attention",
      status: "active" as const,
      activeTurnId: `${provider}-active-attention-turn`,
      providerUpdatedAt: 50,
    };
    if (provider === "codex") value.codex.projection = active;
    else value.claude.projection = active;
    const source = await (provider === "codex" ? codexSession(value) : claudeSession(value));
    const captured = value.store.requireCapturedSessionProviderAuthority(source.sessionId);
    if (provider === "claude") {
      expect(captured.processGeneration).not.toBe(value.store.requireProfileById(source.accountId).processGeneration);
    }
    expect(value.store.requireSession(source.sessionId)).toMatchObject({
      state: "active", activeTurnId: active.activeTurnId,
    });
    const attention = value.store.upsertSessionState({
      sessionId: source.sessionId,
      state: "needs_approval",
      attention: true,
      reason: "autorespond_resolution_refused",
      verbatimRequired: false,
      verbatimLiteral: undefined,
      lastActivityAt: 1_000,
      revision: (value.store.readSessionState(source.sessionId)?.revision ?? 0) + 1,
    });
    const calls = { codex: [...value.codex.calls], claude: [...value.claude.calls] };
    const bootId = `boot_${crypto.randomUUID().replaceAll("-", "")}`;

    const generation = value.store.nextDaemonGeneration(bootId);

    expect(value.store.requireSession(source.sessionId).state).toBe(provider === "codex" ? "active" : "recovery_required");
    const repaired = value.store.readSessionState(source.sessionId);
    expect(repaired).toMatchObject({
      state: provider === "codex" ? "working" : "aborted",
      attention: false,
      revision: attention.revision + 1,
    });
    const events = value.store.listSessionEvents({ sessionId: source.sessionId, afterSequence: 0 }).events;
    const repairedEvents = events.filter((event) => event.body.type === "session_state" && event.body.revision === attention.revision + 1);
    expect(repairedEvents).toMatchObject([{
        accountId: captured.profileId,
        providerGeneration: captured.processGeneration,
        body: { state: provider === "codex" ? "working" : "aborted", attention: false },
      }]);
    const repairedEvent = repairedEvents[0];
    if (repairedEvent === undefined) throw new Error("Expected the exact repaired state event.");
    const inspector = new Database(value.paths.database, { readonly: true, strict: true });
    try {
      expect(inspector.query(`SELECT provider_account_id,profile_id,provider,binding_generation,process_generation
        FROM session_event_provider_authorities WHERE session_id=? AND sequence=?`).get(source.sessionId, repairedEvent.sequence))
        .toEqual({
          provider_account_id: captured.providerAccountId,
          profile_id: captured.profileId,
          provider: captured.provider,
          binding_generation: captured.bindingGeneration,
          process_generation: captured.processGeneration,
        });
    } finally { inspector.close(false); }
    expect(value.codex.calls).toEqual(calls.codex);
    expect(value.claude.calls).toEqual(calls.claude);
    expect(value.store.nextDaemonGeneration(bootId)).toBe(generation);
    expect(value.store.readSessionState(source.sessionId)).toEqual(repaired);
  });

  test("quarantines a crash-adjacent provider switch and permits only exact local abandon", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const key = "00000000-0000-4000-8000-0000000006c1";
    const beginTarget = value.store.beginSessionSwitchTargetStart.bind(value.store);
    Object.defineProperty(value.store, "beginSessionSwitchTargetStart", {
      configurable: true,
      value: (input: Parameters<StateStore["beginSessionSwitchTargetStart"]>[0]) => {
        // Lose control immediately after durable effect intent, before any
        // target receipt exists. A restarted daemon cannot infer no effect.
        beginTarget(input);
        throw new Error("simulated crash after durable target-start intent");
      },
    });
    await expect(value.service.execute({
      idempotencyKey: key,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).rejects.toThrow("simulated crash after durable target-start intent");
    const attempt = value.store.readSessionSwitchByIdempotencyKey(key);
    if (attempt === null) throw new Error("Expected the dedicated switch journal.");
    expect(attempt).toMatchObject({ phase: "target_starting", targetStart: null });
    const captured = value.store.readMutationProviderAuthorities(attempt.attemptId);
    const callsBeforeRestart = {
      claude: [...value.claude.calls],
      codex: [...value.codex.calls],
    };

    const daemonGeneration = value.store.nextDaemonGeneration(`boot_${"a".repeat(32)}`);
    const restarted = new OompaService({
      claude: value.claude,
      cloud: new OfflineCloud(),
      codex: value.codex,
      daemonAuthority: { assertCurrent: async () => {}, close: () => {} },
      daemonGeneration,
      paths: value.paths,
      requestStop: () => undefined,
      store: value.store,
    });
    services.push(restarted);
    await restarted.recover();
    expect(value.store.requireSession(sessionId)).toMatchObject({ state: "recovery_required" });
    expect(value.store.readMutation(key)).toMatchObject({
      state: "ambiguous",
      result: { code: "DAEMON_RESTART_AUTHORITY_RETIRED" },
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(key)).toMatchObject({
      phase: "reconciliation_required",
      diagnosticCode: "DAEMON_RESTART_AUTHORITY_RETIRED",
      targetStart: null,
    });
    expect(value.store.readMutationProviderAuthorities(attempt.attemptId)).toEqual(captured);
    await expect(restarted.execute({ kind: "session.recover", session: sessionId }, { signal }))
      .rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
    expect(value.claude.calls).toEqual(callsBeforeRestart.claude);
    expect(value.codex.calls).toEqual(callsBeforeRestart.codex);

    await expect(restarted.execute({ kind: "session.abandon", session: sessionId }, { signal }))
      .resolves.toMatchObject({
        idempotencyKey: key,
        session: { state: "terminal" },
        recovery: {
          resolved: true,
          resolution: "abandoned",
          providerEffectRetried: false,
          providerStateDeleted: false,
        },
      });
    expect(value.store.readMutation(key)).toMatchObject({
      state: "reconciled",
      originalState: "ambiguous",
      resolution: {
        kind: "abandoned",
        evidence: {
          source: "session_switch_abandon",
          providerEffectRetried: false,
          providerStateDeleted: false,
        },
      },
    });
    expect(value.store.readSessionSwitchByIdempotencyKey(key))
      .toMatchObject({ phase: "abandoned" });
    expect(value.store.readMutationProviderAuthorities(attempt.attemptId)).toEqual(captured);
    expect(value.claude.calls).toEqual(callsBeforeRestart.claude);
    expect(value.codex.calls).toEqual(callsBeforeRestart.codex);
  });

  test.each(["linux", "darwin"] as const)("retains active idle and unbound Claude ambiguity on daemon loss without provider replay (%s)", async (platform) => {
    const value = await fixture();
    const unrelated = await codexSession(value);
    const added = await value.service.execute(
      { kind: "account.add", label: "Claude restart authority" },
      { signal },
    ) as { account: { id: `acct_${string}` } };

    value.claude.projection = {
      providerThreadId: "claude-idle-restart",
      title: "Claude idle restart",
      status: "idle",
      providerUpdatedAt: 30,
    };
    const idle = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
    value.claude.projection = {
      providerThreadId: "claude-active-restart",
      title: "Claude active restart",
      status: "active",
      activeTurnId: "claude-active-turn",
      providerUpdatedAt: 31,
    };
    const active = await value.service.execute({
      account: added.account.id,
      fast: false,
      kind: "session.start",
      preset: "fable-max",
      provider: "claude",
    }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };

    const project = value.store.listProjects()[0];
    if (project === undefined) throw new Error("Expected the fixture project.");
    const claudeAuthority = value.store.requireProviderAccountAuthority(added.account.id, "claude");
    const reviewed = claudeProfile(liveAuthorityFor(value.store, added.account.id, "claude"));
    const startKey = "00000000-0000-4000-8000-0000000006d1";
    const startAttempt = value.store.prepareMutation({
      kind: "session.start",
      authorityId: added.account.id,
      authorityGeneration: claudeAuthority.processGeneration,
      request: sessionStartMutationRequest({ projectId: project.id, provider: "claude", preset: "fable-max", fast: false }),
      idempotencyKey: startKey,
      providerAuthorities: [{
        role: "primary",
        authority: claudeAuthority,
        provenance: "session_start",
      }],
    });
    const unbound = value.store.beginSessionStartEffect({
      attemptId: startAttempt.id,
      profileId: added.account.id,
      profileGeneration: claudeAuthority.processGeneration,
      projectId: project.id,
      provider: "claude",
      preset: "fable-max",
      fastEnabled: false,
      providerAuthority: claudeAuthority,
      providerAccountKey: `v1:claude:${createHash("sha256").update("claude-account\0claude-organization").digest("hex")}`,
      providerAuthentication: {
        profileId: claudeAuthority.profileId,
        processGeneration: claudeAuthority.processGeneration,
        provider: "claude",
        signedIn: true,
      },
      evidence: {
        kind: "session.start",
        projectId: project.id,
        clientMessageId: null,
        messageDigest: null,
        runtimeProfile: reviewed,
      },
    });

    const idleSession = value.store.requireSession(idle.session.id);
    const idleAuthority = value.store.requireSessionProviderAuthority(idle.session.id);
    const idleProviderAuthority = {
      providerAccountId: idleAuthority.providerAccountId,
      profileId: idleAuthority.profileId,
      provider: idleAuthority.provider,
      bindingGeneration: idleAuthority.bindingGeneration,
      processGeneration: idleAuthority.processGeneration,
    } as const;
    const sendKey = "00000000-0000-4000-8000-0000000006d2";
    // Admit the pending queue before arranging the independently unsettled
    // send; sealed queue admission cannot bypass an existing mutation fence.
    const dispatching = value.store.enqueue(idle.session.id, "uncertain Claude queue");
    const { attempt: sendAttempt } = value.store.prepareSessionInputMutation({
      kind: "session.send",
      sessionId: idle.session.id,
      providerAuthority: idleProviderAuthority,
      message: "uncertain Claude send",
      attachments: [],
      idempotencyKey: sendKey,
      daemonGeneration: value.daemonGeneration,
      bootId: value.daemonBootId,
    });
    value.store.beginSessionMutationEffect({
      attemptId: sendAttempt.id,
      message: "uncertain Claude send",
      transcript: {
        accountId: idleProviderAuthority.profileId,
        providerGeneration: idleProviderAuthority.processGeneration,
        providerConnectionId: value.claude.connectionId,
        actor: "human",
        message: "uncertain Claude send",
      },
      sessionId: idle.session.id,
      profileGeneration: idleAuthority.processGeneration,
      providerAuthority: idleProviderAuthority,
      attachments: [],
      daemonGeneration: value.daemonGeneration,
      bootId: value.daemonBootId,
      evidence: {
        kind: "session.send",
        providerThreadId: idleSession.providerThreadId as string,
        baseline: { providerUpdatedAt: 30, status: "idle", activeTurnId: null },
        clientMessageId: sendAttempt.id,
        messageDigest: createHash("sha256").update("uncertain Claude send").digest("hex"),
        runtimeProfile: reviewed,
      },
    });
    value.store.beginQueueEffect({
      queueId: dispatching.id,
      providerConnectionId: value.claude.connectionId,
      sessionId: idle.session.id,
      profileGeneration: idleAuthority.processGeneration,
      providerAuthority: idleProviderAuthority,
      evidence: {
        kind: "queue.dispatch",
        queueId: dispatching.id,
        sessionId: idle.session.id,
        providerThreadId: idleSession.providerThreadId as string,
        profileGeneration: idleAuthority.processGeneration,
        baseline: { providerUpdatedAt: 30, status: "idle", activeTurnId: null },
        clientMessageId: dispatching.id,
        messageDigest: createHash("sha256").update("uncertain Claude queue").digest("hex"),
        runtimeProfile: reviewed,
      },
    });
    const pending = value.store.enqueue(active.session.id, "pending Claude queue");
    const captured = {
      dispatching: value.store.readQueueProviderAuthority(dispatching.id),
      send: value.store.readMutationProviderAuthorities(sendAttempt.id),
      start: value.store.readMutationProviderAuthorities(startAttempt.id),
      sendEvidence: value.store.readMutation(sendKey)?.evidence,
      startEvidence: value.store.readMutation(startKey)?.evidence,
      queueEvidence: value.store.readQueueEffect(dispatching.id)?.evidence,
      processes: [idle.session, active.session].map((session) => {
        const process = value.store.readClaudeProcessAuthority({ profileId: added.account.id,
          providerThreadId: session.providerThreadId, runtimeScope: "managed" });
        if (process === null) throw new Error("Expected an actually admitted Claude child.");
        return process;
      }),
    };
    const claudeCallsBeforeRestart = [...value.claude.calls];

    const daemonGeneration = value.store.nextDaemonGeneration(`boot_${"b".repeat(32)}`);
    for (const sessionId of [idle.session.id, active.session.id, unbound.id]) {
      expect(value.store.requireSession(sessionId)).toMatchObject({ state: "recovery_required" });
      expect(() => value.store.requireSessionProviderAuthority(sessionId))
        .toThrow("SESSION_PROVIDER_AUTHORITY_STALE");
      const restartEvents = value.store.listSessionEvents({ sessionId, afterSequence: 0 }).events;
      expect(restartEvents.filter((event) =>
        event.body.type === "connection"
          && event.body.state === "disconnected"
          && event.body.reason === "daemon_restart"))
        .toHaveLength(1);
      expect(restartEvents.filter((event) =>
        event.body.type === "gap" && event.body.reason === "provider_restart"))
        .toHaveLength(1);
      const terminal = restartEvents.filter((event) =>
        event.body.type === "session_status" && event.body.status === "terminal");
      expect(terminal).toEqual([]);
      expect(restartEvents.filter((event) => event.body.type === "gap")
        .map((event) => ({ accountId: event.accountId, providerGeneration: event.providerGeneration })))
        .toContainEqual({ accountId: added.account.id,
          providerGeneration: claudeAuthority.processGeneration });
      expect(value.store.listUnsettledMutations({ sessionId }))
        .toHaveLength(sessionId === active.session.id ? 0 : 1);
      expect(value.store.listUnsettledQueueEffects(sessionId))
        .toHaveLength(sessionId === idle.session.id ? 1 : 0);
    }
    expect(value.store.readMutation(sendKey)).toMatchObject({
      state: "ambiguous", evidence: captured.sendEvidence,
    });
    expect(value.store.readMutation(startKey)).toMatchObject({
      state: "ambiguous", evidence: captured.startEvidence,
    });
    expect(value.store.readMutation(sendKey)?.resolution).toBeUndefined();
    expect(value.store.readMutation(startKey)?.resolution).toBeUndefined();
    expect(value.store.readQueueEffect(dispatching.id)?.resolution).toBeUndefined();
    expect(value.store.readQueueEffect(dispatching.id)?.evidence).toEqual(captured.queueEvidence);
    expect(value.store.requireQueue(dispatching.id)).toMatchObject({ state: "ambiguous" });
    expect(value.store.requireQueue(pending.id)).toMatchObject({ state: "pending", message: "pending Claude queue" });
    expect(value.store.readMutationProviderAuthorities(sendAttempt.id)).toEqual(captured.send);
    expect(value.store.readMutationProviderAuthorities(startAttempt.id)).toEqual(captured.start);
    expect(value.store.readQueueProviderAuthority(dispatching.id)).toEqual(captured.dispatching);

    const restarted = new OompaService({
      claude: value.claude,
      cloud: new OfflineCloud(),
      codex: value.codex,
      daemonAuthority: { assertCurrent: async () => {}, close: () => {} },
      daemonGeneration,
      paths: value.paths,
      platform,
      requestStop: () => undefined,
      store: value.store,
    });
    services.push(restarted);
    await restarted.recover();
    // Reusing the old manager permits exact PID cleanup, not conversation
    // continuation. Both uncertain effects remain owned after those joins.
    expect(value.claude.calls).toEqual([...claudeCallsBeforeRestart,
      "read-identity", "end-session", "read-identity", "end-session"]);
    expect(value.claude.endedProcessIdentities).toHaveLength(2);
    for (const process of captured.processes) {
      expect(value.claude.endedProcessIdentities).toContainEqual(process.identity);
      expect(value.store.readClaudeProcessAuthority({ profileId: process.profileId,
        providerThreadId: process.providerThreadId, runtimeScope: "managed" }))
        .toMatchObject({ state: "released", identity: process.identity,
          providerAuthority: process.providerAuthority, sessionId: process.sessionId });
    }
    expect(value.store.readMutation(sendKey)).toMatchObject({ state: "ambiguous", evidence: captured.sendEvidence });
    expect(value.store.readMutation(sendKey)?.resolution).toBeUndefined();
    expect(value.store.readQueueEffect(dispatching.id)?.resolution).toBeUndefined();
    const callsAfterCleanup = [...value.claude.calls];
    for (const sessionId of [idle.session.id, active.session.id, unbound.id]) {
      await expect(restarted.execute({ kind: "session.status", session: sessionId }, { signal }))
        .resolves.toMatchObject({
          session: { execution: "recovery_required" },
          advisory: { execution: "recovery_required", attention: "recovery_required" },
          providerObservation: sessionId === unbound.id
            ? { state: "not_applicable", reason: "unbound" }
            : { state: "recovery_required", code: "session_quarantined" },
        });
      for (const detail of [false, true]) {
        const shown = await restarted.execute({ kind: "session.show", session: sessionId, detail }, { signal });
        expect(shown).toMatchObject({
          session: { state: "recovery_required" },
          ...(sessionId === unbound.id ? {} : {
            providerObservation: { state: "recovery_required", code: "session_quarantined" },
            recovery: { required: true, cleared: false },
          }),
        });
        expect(shown).not.toHaveProperty("projection");
      }
    }
    expect(value.claude.calls).toEqual(callsAfterCleanup);
    await expect(restarted.execute({ kind: "session.status", session: unrelated.sessionId }, { signal }))
      .resolves.toMatchObject({ providerObservation: { state: "live" } });
    expect(value.claude.calls).toEqual(callsAfterCleanup);
  });

  test("stages target Claude launch authority before admission and binds it atomically", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    let stagedProviderThreadId: string | undefined;
    let stagedIntentId: string | undefined;
    value.claude.beforeStartSessionAdmission = (input) => {
      stagedProviderThreadId = input.providerThreadId;
      if (stagedProviderThreadId === undefined) {
        throw new Error("Expected Oompa to reserve the Claude provider identity before launch.");
      }
      const intent = value.store.readClaudeProcessLaunchIntent({
        providerThreadId: stagedProviderThreadId,
        profileId: accountId,
        runtimeScope: "managed",
      });
      if (intent === null) throw new Error("Expected durable pre-admission launch authority.");
      stagedIntentId = intent.intentId;
      expect(intent).toMatchObject({
        profileId: accountId,
        runtimeScope: "managed",
        sessionId,
      });
      expect(value.store.readClaudeProcessAuthority({
        providerThreadId: stagedProviderThreadId,
        profileId: accountId,
        runtimeScope: "managed",
      })).toBeNull();
    };

    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal })).resolves.toMatchObject({
      to: { provider: "claude" },
    });

    if (stagedProviderThreadId === undefined || stagedIntentId === undefined) {
      throw new Error("Expected the Claude launch-intent callback to run.");
    }
    expect(stagedProviderThreadId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId: stagedProviderThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toBeNull();
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId: stagedProviderThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      identity: value.claude.processIdentity,
      sessionId,
      state: "bound",
    });
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "claude",
      providerThreadId: stagedProviderThreadId,
    });
  });

  test("preserves the source session when a Claude child exit is unproven and never respawns it", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    const idempotencyKey = crypto.randomUUID();
    value.claude.startSessionError = new ClaudeProcessExitUnprovenError();

    const first = await value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(CommandFailure);
    expect((first as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.claude.startSessionRequests).toHaveLength(1);
    const providerThreadId = value.claude.startSessionRequests[0]?.providerThreadId;
    if (providerThreadId === undefined) throw new Error("Expected a reserved Claude identity.");
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toMatchObject({
      profileId: accountId,
      runtimeScope: "managed",
      sessionId,
    });
    expect(value.store.readClaudeProcessAuthority({
      providerThreadId,
      profileId: accountId,
      runtimeScope: "managed",
    })).toBeNull();
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    expect(value.store.readMutation(idempotencyKey)).toMatchObject({ state: "ambiguous" });
    expect(value.store.readSessionSwitchByIdempotencyKey(idempotencyKey))
      .toMatchObject({ phase: "reconciliation_required", targetStart: null });

    const replay = await value.service.execute({
      idempotencyKey,
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(replay).toBeInstanceOf(CommandFailure);
    expect((replay as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    const freshAttempt = await value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      provider: "claude",
      session: sessionId,
    }, { signal }).catch((error: unknown) => error);
    expect(freshAttempt).toBeInstanceOf(CommandFailure);
    expect((freshAttempt as CommandFailure).code).toBe("RECOVERY_REQUIRED");
    expect(value.claude.startSessionRequests).toHaveLength(1);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
    // No native PID was admitted, so a generic runtime close is not proof of
    // this launched identity's exit. Retain the exact durable launch fence.
    await expect(value.service.close()).rejects.toThrow(
      "An unresolved Claude launch still requires exact process recovery.",
    );
    const tracked = services.indexOf(value.service);
    if (tracked >= 0) services.splice(tracked, 1);
    expect(value.store.readClaudeProcessLaunchIntent({
      providerThreadId, profileId: accountId, runtimeScope: "managed",
    })).not.toBeNull();
  });

  test("refuses a switch to the provider the session already runs", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const refusal = await value.service.execute(
      {
        idempotencyKey: crypto.randomUUID(),
        kind: "session.switch",
        presetContract: currentPresetContract,
        provider: "codex",
        session: sessionId,
      },
      { signal },
    ).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CommandFailure);
    expect((refusal as CommandFailure).code).toBe("INVALID_INPUT");
  });

  test("quarantines a same-provider preset switch when its target aliases the source thread", async () => {
    const value = await fixture();
    const { sessionId } = await codexSession(value);
    const startsBefore = value.codex.calls.filter((call) => call === "start-session").length;
    const turnsBefore = value.codex.calls.filter((call) => call === "start-turn").length;

    await expect(value.service.execute({
      idempotencyKey: crypto.randomUUID(),
      kind: "session.switch",
      preset: "low",
      provider: "codex",
      session: sessionId,
    }, { signal })).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });

    expect(value.codex.calls.filter((call) => call === "start-session"))
      .toHaveLength(startsBefore + 1);
    expect(value.codex.calls.filter((call) => call === "start-turn"))
      .toHaveLength(turnsBefore);
    expect(value.codex.endedThreads).toEqual([]);
    expect(value.store.requireSession(sessionId)).toMatchObject({
      provider: "codex",
      providerThreadId: "codex-thread-1",
      state: "recovery_required",
    });
  });

  test("exports the neutral transcript as a letta-ai trajectory v1 document", async () => {
    const value = await fixture();
    const { accountId, sessionId } = await codexSession(value);
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.send", message: "ship the release", session: sessionId },
      { signal },
    );
    const profile = value.store.requireProfileById(accountId);
    const threadId = value.store.requireSession(sessionId).providerThreadId;
    if (threadId === undefined) throw new Error("Expected a bound session.");
    for (const type of ["itemStarted", "itemCompleted"] as const) {
      await value.service.observeCodexFact(liveAuthorityFor(value.store, profile.id), {
        connectionId: "30000000-0000-4000-8000-000000000001",
        threadId,
        turnId: "codex-turn-1",
        itemId: "item-1",
        itemKind: "mcpToolCall",
        server: "github",
        tool: "create_issue",
        ...(type === "itemCompleted" ? { status: "completed" } : {}),
        type,
      });
    }
    await value.service.execute(
      { idempotencyKey: crypto.randomUUID(), kind: "session.switch", provider: "claude", session: sessionId },
      { signal },
    );
    const transcript = await transcriptOf(value, sessionId);
    const trajectory = transcriptToTrajectory({
      transcript,
      provider: "claude",
      createdAt: 1_700_000_000_000,
    });
    for (const record of trajectory) trajectoryRecordSchema.parse(record);
    expect(trajectory[0]).toEqual({ role: "meta", source: "oompa" });
    const context = trajectory[1];
    if (context?.role !== "observation") throw new Error("Expected the Oompa export context observation.");
    expect(oompaTrajectoryExportContextSchema.parse(JSON.parse(context.content))).toMatchObject({
      omitted_records: 0,
      provider: "claude",
      session_id: sessionId,
      transcript_digest: transcript.digest,
    });
    const roles = trajectory.map((record) => record.role);
    expect(roles).toContain("user");
    expect(roles).toContain("observation");
    const callRecord = trajectory.find((record) =>
      record.role === "assistant" && "tool_calls" in record);
    const tool = trajectory.find((record) => record.role === "tool");
    if (callRecord?.role !== "assistant" || !("tool_calls" in callRecord) || tool?.role !== "tool") {
      throw new Error("Expected one trajectory tool call and one tool record.");
    }
    const call = callRecord.tool_calls[0];
    if (call === undefined) throw new Error("Expected one trajectory tool call.");
    // The tool record links to its call, and neither carries a raw argument or
    // raw output: Oompa never stored either.
    expect(tool.tool_call_id).toBe(call.id);
    expect(tool.ok).toBe(true);
    expect(call.name).toBe("github/create_issue");
    expect(JSON.parse(call.args)).toMatchObject({ hra_arguments_retained: false });
    expect(tool.content).toContain("never retained");
    // The handoff seed keeps exactly one explicit label.
    const handoff = trajectory.filter((record) =>
      record.role === "user" && record.content.includes("Oompa provider handoff"));
    expect(handoff).toHaveLength(1);
    expect(handoff[0]?.role === "user" && handoff[0].content.startsWith(TRANSCRIPT_SEED_HEADER))
      .toBe(true);
  });
});

async function codexDrainFixture(cloud = new OfflineCloud()) {
  const value = await fixture(Date.now, cloud);
  const source = await codexSession(value);
  const sourceProjection = { ...value.codex.projection };
  value.codex.projection = { ...sourceProjection, providerThreadId: "codex-drain-sibling" };
  const sibling = await value.service.execute({
    account: source.accountId, presetContract: currentPresetContract, kind: "session.start", preset: "high", fast: false,
  }, { signal }) as { session: { id: `sess_${string}`; providerThreadId: string } };
  value.codex.projection = sourceProjection;
  const startSession = value.codex.startSession.bind(value.codex);
  Object.defineProperty(value.codex, "startSession", {
    configurable: true,
    value: async (input: Parameters<CodexRuntimePort["startSession"]>[0]) => {
      value.codex.projection = { ...sourceProjection, providerThreadId: "codex-drain-target" };
      return await startSession(input);
    },
  });
  return { value, source, sibling: sibling.session };
}

describe("dedicated switch fact drain isolation", () => {
  test("keeps a queued Codex fact on its original thread across the cloud await", async () => {
    let onProjectionCheck: (() => void) | undefined;
    class DrainCloud extends OfflineCloud {
      override async isCompactProjectionRecoveryUnsettled(): Promise<boolean> {
        onProjectionCheck?.();
        return false;
      }
    }
    const { value, source, sibling } = await codexDrainFixture(new DrainCloud());
    const siblingBefore = value.store.requireSession(sibling.id);
    const siblingEvents = value.store.listSessionEvents({ sessionId: sibling.id, afterSequence: 0 }).events;
    const command = { kind: "session.switch" as const, provider: "codex" as const,
      preset: "low" as const, session: source.sessionId, idempotencyKey: crypto.randomUUID() };
    let mutatedDuringDrain = false;
    const startTurn = value.codex.startTurn.bind(value.codex);
    Object.defineProperty(value.codex, "startTurn", {
      configurable: true,
      value: async (input: Parameters<CodexRuntimePort["startTurn"]>[0]) => {
        const result = await startTurn(input);
        const fact = { type: "threadStatusChanged" as const, threadId: input.providerThreadId,
          connectionId: "30000000-0000-4000-8000-000000000001", status: { type: "systemError" as const } };
        await value.service.observeCodexFact(input.authority, fact);
        onProjectionCheck = () => {
          if (value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey)?.phase !== "seed_settled") return;
          onProjectionCheck = undefined;
          fact.threadId = sibling.providerThreadId;
          mutatedDuringDrain = true;
        };
        return result;
      },
    });

    const result = await value.service.execute(command, { signal });
    expect(mutatedDuringDrain).toBe(true);
    expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
      .toMatchObject({ phase: "seed_settled" });
    expect(value.store.requireSession(sibling.id)).toEqual(siblingBefore);
    expect(value.store.listSessionEvents({ sessionId: sibling.id, afterSequence: 0 }).events).toEqual(siblingEvents);
    expect(value.store.requireSession(source.sessionId).state).toBe("recovery_required");
    expect(value.store.listSessionEvents({ sessionId: source.sessionId, afterSequence: 0 }).events
      .filter((event) => event.body.type === "session_status" && event.body.status === "system_error"))
      .toHaveLength(1);
    const starts = value.codex.calls.filter((call) => call === "start-turn");
    await expect(value.service.execute(command, { signal })).resolves.toEqual(result);
    expect(value.codex.calls.filter((call) => call === "start-turn")).toEqual(starts);
  });

  test.each(["protocolNotice", "providerDisconnected"] as const)(
    "isolates a deferred Claude %s from a sibling sharing the connection identifier",
    async (type) => {
      const value = await fixture();
      const source = await codexSession(value);
      const sibling = await value.service.execute({ account: source.accountId,
        kind: "session.start", provider: "claude", preset: "fable-max", fast: false }, { signal }) as {
        session: { id: `sess_${string}`; providerThreadId: string };
      };
      const siblingBefore = value.store.requireSession(sibling.session.id);
      const siblingEvents = value.store.listSessionEvents({ sessionId: sibling.session.id, afterSequence: 0 }).events;
      const siblingProcess = value.store.readClaudeProcessAuthority({ profileId: source.accountId,
        providerThreadId: sibling.session.providerThreadId, runtimeScope: "managed" });
      value.claude.beforeStartTurnReturn = async (input) => {
        const routing = { connectionId: value.claude.connectionId, providerThreadId: input.providerThreadId };
        await value.service.observeClaudeFact(input.authority, type === "protocolNotice"
          ? { ...routing, type, event: "deferred/exact-target" }
          : { ...routing, type, reason: "eof" });
      };
      const command = { kind: "session.switch" as const, provider: "claude" as const,
        session: source.sessionId, idempotencyKey: crypto.randomUUID() };

      await value.service.execute(command, { signal });
      expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
        .toMatchObject({ phase: "seed_settled" });
      expect(value.store.requireSession(sibling.session.id)).toEqual(siblingBefore);
      expect(value.store.listSessionEvents({ sessionId: sibling.session.id, afterSequence: 0 }).events).toEqual(siblingEvents);
      expect(value.store.readClaudeProcessAuthority({ profileId: source.accountId,
        providerThreadId: sibling.session.providerThreadId, runtimeScope: "managed" })).toEqual(siblingProcess);
      const targetEvents = value.store.listSessionEvents({ sessionId: source.sessionId, afterSequence: 0 }).events;
      expect(targetEvents.filter((event) => type === "protocolNotice"
        ? event.body.type === "protocol_incompatible" && event.body.method === "deferred/exact-target"
        : event.body.type === "connection" && event.body.state === "disconnected" && event.body.reason === "eof"))
        .toHaveLength(1);
      expect(value.claude.seededMessages).toHaveLength(1);
    },
  );

  test("quarantines a deferred resolution when inspection acquires the interaction during the ordering await", async () => {
    const { value, source, sibling } = await codexDrainFixture();
    const siblingBefore = value.store.requireSession(sibling.id);
    let enterInspection: () => void = () => { throw new Error("Inspection entry gate was not initialized."); };
    const inspectionEntered = new Promise<void>((resolve) => { enterInspection = resolve; });
    let rejectInspection: (error: Error) => void = () => { throw new Error("Inspection exit gate was not initialized."); };
    const inspectionBlocked = new Promise<never>((_resolve, reject) => { rejectInspection = reject; });
    const inspection: { task?: Promise<unknown> } = {};
    let inspectionCalls = 0;
    Object.defineProperty(value.codex, "inspectInteractionAuthority", {
      configurable: true,
      value: () => {
        inspectionCalls += 1;
        enterInspection();
        return inspectionBlocked;
      },
    });
    let interceptedResolution = false;
    const findInteraction = value.store.findInteractionByAuthority.bind(value.store);
    Object.defineProperty(value.store, "findInteractionByAuthority", {
      configurable: true,
      value: (authority: Parameters<StateStore["findInteractionByAuthority"]>[0]) => {
        const current = findInteraction(authority);
        if (!interceptedResolution && current?.state === "pending"
          && authority.requestId.value === "drain-busy-request") {
          interceptedResolution = true;
          // The initial busy check has not acquired the interaction. The next
          // ordered-helper await admits an ordinary interaction-only inspector.
          value.daemonAuthority.beforeAssertReturn = async () => {
            inspection.task = value.service.execute({ kind: "interaction.inspect",
              interaction: current.publicId, expectedRevision: current.revision }, { signal })
              .catch((error: unknown) => error);
            await Promise.race([
              inspectionEntered,
              inspection.task.then(() => { throw new Error("Inspection refused before reaching its held runtime boundary."); }),
            ]);
          };
        }
        return current;
      },
    });
    const startTurn = value.codex.startTurn.bind(value.codex);
    Object.defineProperty(value.codex, "startTurn", {
      configurable: true,
      value: async (input: Parameters<CodexRuntimePort["startTurn"]>[0]) => {
        const result = await startTurn(input);
        const provider = { approvalId: null, bindingGeneration: input.authority.bindingGeneration,
          connectionId: "30000000-0000-4000-8000-000000000001", itemId: "drain-busy-item",
          method: "item/commandExecution/requestApproval" as const,
          processGeneration: input.authority.generation, profileId: input.authority.id,
          provider: input.authority.provider, providerAccountId: input.authority.providerAccountId,
          requestDigest: "d".repeat(64), requestId: { type: "string" as const, value: "drain-busy-request" },
          threadId: input.providerThreadId, turnId: result.turnId };
        await value.service.observeCodexFact(input.authority, { type: "interactionRequested",
          kind: "command_approval", blocking: true, connectionId: provider.connectionId, provider,
          display: { kind: "command_approval", availableDecisions: ["once", "decline", "cancel"],
            commandClass: "test", reason: null, summary: "Deferred approval", workingDirectory: null } });
        await value.service.observeCodexFact(input.authority, { type: "interactionResolved",
          kind: "command_approval", connectionId: provider.connectionId, provider });
        return result;
      },
    });
    const command = { kind: "session.switch" as const, provider: "codex" as const,
      preset: "low" as const, session: source.sessionId, idempotencyKey: crypto.randomUUID() };
    try {
      const result = await value.service.execute(command, { signal });
      expect(interceptedResolution).toBe(true);
      expect(inspectionCalls).toBe(1);
      expect(value.store.readSessionSwitchByIdempotencyKey(command.idempotencyKey))
        .toMatchObject({ phase: "seed_settled" });
      expect(value.store.requireSession(source.sessionId).state).toBe("recovery_required");
      expect(value.store.requireSession(sibling.id)).toEqual(siblingBefore);
      expect(value.store.listInteractions({ sessionId: source.sessionId, pendingOnly: false, limit: 10 }))
        .toMatchObject([{ state: "pending" }]);
      const starts = value.codex.calls.filter((call) => call === "start-turn");
      await expect(value.service.execute(command, { signal })).resolves.toEqual(result);
      expect(value.codex.calls.filter((call) => call === "start-turn")).toEqual(starts);
    } finally {
      rejectInspection(new Error("Test inspector released its joined callback."));
      await inspection.task;
    }
  });
});
