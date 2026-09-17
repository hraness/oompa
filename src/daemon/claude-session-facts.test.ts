import { describe, expect, test } from "bun:test";

import type { ProviderInteractionAuthority } from "../domain/interactions";
import type { ProviderAccountAuthority } from "../domain/provider-accounts";
import {
  ClaudeSessionFactTranslator,
  type ClaudeSessionFact,
} from "./claude-session-facts";

const profileId = "acct_00000000000000000000000000000000" as const;
const firstAuthority = {
  bindingGeneration: 3,
  processGeneration: 7,
  profileId,
  provider: "claude",
  providerAccountId: "pact_00000000000000000000000000000001",
} as const satisfies ProviderAccountAuthority;
const replacementAuthority = {
  ...firstAuthority,
  bindingGeneration: 4,
  providerAccountId: "pact_00000000000000000000000000000002",
} as const satisfies ProviderAccountAuthority;
const providerThreadId = "same-thread";
const connectionId = "65000000-0000-4000-8000-000000000001";

const interactionAuthority = (
  authority: ProviderAccountAuthority,
  requestId: string,
): ProviderInteractionAuthority => ({
  approvalId: "same-item",
  bindingGeneration: authority.bindingGeneration,
  connectionId,
  itemId: "same-item",
  method: "claude/control_request/can_use_tool",
  processGeneration: authority.processGeneration,
  profileId: authority.profileId,
  provider: authority.provider,
  providerAccountId: authority.providerAccountId,
  requestDigest: "a".repeat(64),
  requestId: { type: "string", value: requestId },
  threadId: providerThreadId,
  turnId: "same-turn",
});

const translator = (): ClaudeSessionFactTranslator =>
  new ClaudeSessionFactTranslator({
    authorityFor: (authority, _threadId, requestId) =>
      interactionAuthority(authority, requestId),
    now: () => 1,
  });

const assistantDelta = (): ClaudeSessionFact => ({
  connectionId,
  itemId: "same-item",
  providerThreadId,
  text: "safe",
  turnId: "same-turn",
  type: "assistantDelta",
});

const interactionRequested = (requestId: string): ClaudeSessionFact => ({
  blocking: true,
  connectionId,
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
  requestId,
  turnId: "same-turn",
  type: "interactionRequested",
});

const quotaObserved = (): Extract<ClaudeSessionFact, { type: "rateLimitObserved" }> => ({
  connectionId,
  observationRevision: 2,
  observedAt: 10,
  providerThreadId,
  quota: {
    isUsingOverage: false,
    overageDisabledReason: null,
    overageStatus: "rejected",
    rateLimitType: "five_hour",
    resetsAtMs: 20_000,
    status: { state: "known", value: "warning" },
    windows: [{ id: "five_hour", resetsAtMs: 20_000, usedPercent: 99 }],
  },
  receivedAt: 10,
  sourceEventDigest: "a".repeat(64),
  sourceEventId: "00000000-0000-4000-8000-000000000001",
  turnId: "same-turn",
  type: "rateLimitObserved",
});

const accountingObserved = (): Extract<
  ClaudeSessionFact,
  { type: "usageAccountingObserved" }
> => ({
  accounting: {
    models: [],
    tokens: {
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 5,
      inputTokens: 2,
      outputTokens: 7,
      thinkingTokens: 1,
    },
    totalCostUsd: 0.25,
  },
  connectionId,
  observationRevision: 1,
  observedAt: 11,
  providerThreadId,
  receivedAt: 11,
  sourceEventDigest: "b".repeat(64),
  sourceEventId: "00000000-0000-4000-8000-000000000002",
  turnId: "same-turn",
  type: "usageAccountingObserved",
});

describe("ClaudeSessionFactTranslator provider authority", () => {
  test("keeps same-thread item lifecycle state isolated across replacement authorities", () => {
    const value = translator();

    expect(value.translate(firstAuthority, assistantDelta()).timelineFacts.map((fact) => fact.type))
      .toEqual(["itemStarted", "assistantDelta"]);
    expect(value.translate(replacementAuthority, assistantDelta()).timelineFacts.map((fact) => fact.type))
      .toEqual(["itemStarted", "assistantDelta"]);

    value.forgetSession(firstAuthority, providerThreadId);
    expect(value.translate(firstAuthority, assistantDelta()).timelineFacts.map((fact) => fact.type))
      .toEqual(["itemStarted", "assistantDelta"]);
    expect(value.translate(replacementAuthority, assistantDelta()).timelineFacts.map((fact) => fact.type))
      .toEqual(["assistantDelta"]);
  });

  test("does not consume a same-thread request remembered by another authority", () => {
    const value = translator();
    const requestId = "same-request";
    value.translate(firstAuthority, interactionRequested(requestId));
    value.translate(replacementAuthority, interactionRequested(requestId));

    const canceled = (authority: ProviderAccountAuthority) => value.translate(authority, {
      connectionId,
      providerThreadId,
      requestId,
      type: "interactionCanceled",
    });
    expect(canceled(firstAuthority).timelineFacts[0]).toMatchObject({
      provider: interactionAuthority(firstAuthority, requestId),
      type: "interactionResolved",
    });
    expect(canceled(replacementAuthority).timelineFacts[0]).toMatchObject({
      provider: interactionAuthority(replacementAuthority, requestId),
      type: "interactionResolved",
    });
  });

  test("maps a provider compaction episode onto the shared threadCompaction fact", () => {
    const value = translator();
    const completed = value.translate(firstAuthority, {
      connectionId,
      outcome: "completed",
      postTokens: 41_000,
      preTokens: 262_144,
      providerThreadId,
      type: "compaction",
    });
    expect(completed.timelineFacts).toEqual([{
      connectionId,
      outcome: "completed",
      postTokens: 41_000,
      preTokens: 262_144,
      threadId: providerThreadId,
      turnId: null,
      type: "threadCompaction",
    }]);
    expect(completed.usageObservations).toEqual([]);

    const failed = value.translate(firstAuthority, {
      connectionId,
      errorCode: "Not enough messages to compact",
      outcome: "failed",
      providerThreadId,
      type: "compaction",
    });
    expect(failed.timelineFacts).toEqual([{
      connectionId,
      outcome: "failed",
      threadId: providerThreadId,
      turnId: null,
      type: "threadCompaction",
    }]);
  });

  test("splits normalized usage from the neutral timeline with frozen exact authority", () => {
    const value = translator();
    const quota = value.translate(firstAuthority, quotaObserved());
    expect(quota.timelineFacts).toEqual([]);
    expect(quota.usageObservations).toEqual([{
      authority: firstAuthority,
      component: "quota",
      connectionId,
      observationRevision: 2,
      observedAt: 10,
      providerThreadId,
      quota: quotaObserved().quota,
      receivedAt: 10,
      sourceEventDigest: "a".repeat(64),
      sourceEventId: "00000000-0000-4000-8000-000000000001",
      turnId: "same-turn",
    }]);

    const accounting = value.translate(replacementAuthority, accountingObserved());
    expect(accounting.timelineFacts).toEqual([]);
    expect(accounting.usageObservations[0]).toMatchObject({
      authority: replacementAuthority,
      component: "accounting",
      observationRevision: 1,
      observedAt: 11,
      receivedAt: 11,
      sourceEventId: "00000000-0000-4000-8000-000000000002",
      turnId: "same-turn",
    });
    expect(accounting.usageObservations[0]?.authority).not.toEqual(firstAuthority);
  });
});
