import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import fc from "fast-check";

import { INTERACTION_MAX_PENDING_MS } from "../domain/interactions.ts";
import {
  currentPresetContract,
  legacyPresetContract,
  presetRequirementForContract,
  presetRequirements,
} from "../domain/presets.ts";

import { CodexError } from "./errors.ts";
import { CODEX_PIN, PINNED_CODEX_MATRIX_DIGESTS, PINNED_CODEX_SCHEMA_DIGESTS } from "./pin.ts";
import { resolvePinnedCodexRuntime } from "./runtime.ts";
import {
  OOMPA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS,
  OOMPA_HOST_DYNAMIC_TOOLS,
  OPERATIONS,
  PINNED_CODEX_NOTIFICATION_MATRIX,
  PINNED_CODEX_NOTIFICATION_SCHEMA_DIGEST,
  PINNED_CODEX_SERVER_REQUEST_MATRIX,
  PINNED_CODEX_SERVER_REQUEST_SCHEMA_DIGEST,
  codexMatrixDigest,
  assertPinnedCodexNotificationMatrix,
  assertPinnedCodexServerRequestMatrix,
  codexNotificationDisposition,
  codexServerRequestDisposition,
  compileCodexInteractionResponse,
  parseAccountUsage,
  parseBrokeredCodexServerRequest,
  parseConversationAutomationToolCall,
  parseOompaHostToolCall,
  parseFact,
  parseModelPage,
  parseManagedLoginCancel,
  parsePluginCatalog,
  parseProviderRequestId,
  parseRateLimits,
  parseRateLimitResetCreditConsumption,
  parseThreadItemsPage,
  parseThreadMetadataRead,
  parseThreadPage,
  parseThreadUnsubscribe,
  parseThreadTurnsPage,
  resolvePreset,
  safeLiveAcceptanceCommandDigest,
  serializeDynamicToolPublicResult,
  validateAuthority,
  type BrokeredCodexServerRequestMethod,
  type CodexAuthority,
  type CodexCapabilitySnapshot,
} from "./protocol.ts";

const CODEX_PROVIDER_ACCOUNT_ID = "acct_00000000000000000000000000000000";
const codexAuthority = (processGeneration: number): CodexAuthority => ({
  profileId: "profile-a",
  processGeneration,
  provider: "codex",
  providerAccountId: CODEX_PROVIDER_ACCOUNT_ID,
  bindingGeneration: 1,
});

const permissionPrivatePath = ["", "Users", "alice", "private", "PERMISSION_VALUE_SENTINEL"].join("/");

const brokeredFixtures: Readonly<Record<BrokeredCodexServerRequestMethod, unknown>> = {
  "item/commandExecution/requestApproval": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-1", startedAtMs: 1,
    approvalId: null, environmentId: null, reason: "network", command: "git push origin main",
    commandActions: [{ type: "unknown", command: "git push origin main" }],
    networkApprovalContext: { host: "github.com", protocol: "https" },
    additionalPermissions: { network: { enabled: true } },
    cwd: "/workspace", availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
  },
  "item/fileChange/requestApproval": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-2", startedAtMs: 1,
    reason: "write files", grantRoot: "/workspace",
  },
  "item/permissions/requestApproval": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-3", environmentId: null,
    startedAtMs: 1, cwd: "/workspace", reason: "network",
    permissions: {
      network: { enabled: true },
      fileSystem: { read: [permissionPrivatePath] },
    },
  },
  "item/tool/requestUserInput": {
    threadId: "thread-1", turnId: "turn-1", itemId: "item-4", isBlocking: true,
    autoResolutionMs: null,
    questions: [{
      id: "choice", header: "Choice", question: "Which option?", isOther: true, isSecret: false,
      options: [{ label: "A", description: "First" }],
    }],
  },
  "mcpServer/elicitation/request": {
    threadId: "thread-1", turnId: "turn-1", serverName: "example", mode: "form",
    _meta: null, message: "Configure Example",
    requestedSchema: {
      type: "object",
      properties: {
        confirmed: { type: "boolean", title: "Confirm", default: true },
      },
      required: ["confirmed"],
    },
  },
};

const capabilities: CodexCapabilitySnapshot = {
  models: [
    {
      id: "gpt-5.6-luna",
      model: "gpt-5.6-luna",
      displayName: "GPT-5.6 Luna",
      hidden: false,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
      defaultServiceTier: null,
      isDefault: false,
    },
    {
      id: "gpt-5.6-sol",
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      hidden: false,
      supportedReasoningEfforts: ["low", "max", "ultra"],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
      defaultServiceTier: null,
      isDefault: false,
    },
    {
      id: "gpt-6-astra",
      model: "gpt-6-astra",
      displayName: "GPT-6 Astra",
      hidden: false,
      supportedReasoningEfforts: ["low", "max", "ultra"],
      defaultReasoningEffort: "low",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Faster" }],
      defaultServiceTier: null,
      isDefault: true,
    },
  ],
  features: [],
  permissionProfiles: null,
  apps: null,
  pluginLifecycle: "unsupported-under-development",
};

describe("pinned server requests and safe notifications", () => {
  test("requires the complete Codex provider-account tuple at every protocol boundary", () => {
    expect(validateAuthority(codexAuthority(3))).toEqual(codexAuthority(3));
    for (const candidate of [
      { profileId: "profile-a", processGeneration: 3 },
      { ...codexAuthority(3), providerAccountId: undefined },
      { ...codexAuthority(3), provider: "claude" },
      { ...codexAuthority(3), providerAccountId: "pact_00000000000000000000000000000000" },
      { ...codexAuthority(3), bindingGeneration: 0 },
    ]) {
      expect(() => validateAuthority(candidate as unknown as CodexAuthority)).toThrow(CodexError);
    }
  });

  test("matches schemas generated by the installed pinned experimental runtime", async () => {
    const runtime = await resolvePinnedCodexRuntime();
    const outputDirectory = await mkdtemp(join(tmpdir(), "oompa-codex-schema-"));
    try {
      const [bunExecutable, launcher] = runtime.launcherArgv;
      const generated = Bun.spawnSync({
        cmd: [
          bunExecutable,
          launcher,
          "app-server",
          "generate-ts",
          "--experimental",
          "--out",
          outputDirectory,
        ],
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(generated.exitCode).toBe(0);

      const notificationSource = await readFile(
        join(outputDirectory, "ServerNotification.ts"),
        "utf8",
      );
      const requestSource = await readFile(join(outputDirectory, "ServerRequest.ts"), "utf8");
      const clientRequestSource = await readFile(
        join(outputDirectory, "ClientRequest.ts"),
        "utf8",
      );
      const methods = (source: string): readonly string[] =>
        [...source.matchAll(/\{ "method": "([^"]+)"/gu)].map((match) => match[1]!);
      const digest = (source: string): string =>
        createHash("sha256").update(source).digest("hex");

      expect(methods(notificationSource)).toEqual(Object.keys(PINNED_CODEX_NOTIFICATION_MATRIX));
      expect(PINNED_CODEX_NOTIFICATION_SCHEMA_DIGEST).toBe(PINNED_CODEX_SCHEMA_DIGESTS["ServerNotification.ts"]);
      expect(methods(requestSource)).toEqual(Object.keys(PINNED_CODEX_SERVER_REQUEST_MATRIX));
      expect(PINNED_CODEX_SERVER_REQUEST_SCHEMA_DIGEST).toBe(PINNED_CODEX_SCHEMA_DIGESTS["ServerRequest.ts"]);
      expect(clientRequestSource).toContain(
        '{ "method": "account/rateLimitResetCredit/consume", id: RequestId, params: ConsumeAccountRateLimitResetCreditParams, }',
      );
      expect(Object.keys(PINNED_CODEX_SCHEMA_DIGESTS)).toHaveLength(15);
      for (const [relativePath, expected] of Object.entries(PINNED_CODEX_SCHEMA_DIGESTS)) {
        const source = await readFile(join(outputDirectory, relativePath), "utf8");
        expect({ relativePath, digest: digest(source) }).toEqual({ relativePath, digest: expected });
      }
      expect(codexMatrixDigest(CODEX_PIN, PINNED_CODEX_NOTIFICATION_MATRIX)).toBe(
        PINNED_CODEX_MATRIX_DIGESTS.notification,
      );
      expect(codexMatrixDigest(CODEX_PIN, PINNED_CODEX_SERVER_REQUEST_MATRIX)).toBe(
        PINNED_CODEX_MATRIX_DIGESTS.serverRequest,
      );
      expect(codexMatrixDigest("0.0.0", PINNED_CODEX_SERVER_REQUEST_MATRIX)).not.toBe(
        PINNED_CODEX_MATRIX_DIGESTS.serverRequest,
      );
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });

  test("parses only the pinned closed login-cancellation outcomes", () => {
    expect(parseManagedLoginCancel({ status: "canceled" })).toEqual({ status: "canceled" });
    expect(parseManagedLoginCancel({ status: "notFound" })).toEqual({ status: "notFound" });
    expect(() => parseManagedLoginCancel({ status: "completed" })).toThrow(CodexError);
  });

  test("declares the pinned reset-credit mutation with indeterminate-response reconciliation", () => {
    expect(OPERATIONS["account/rateLimitResetCredit/consume"]).toEqual({
      method: "account/rateLimitResetCredit/consume",
      effect: "account-mutation",
      deadlineMs: 15_000,
      lostResponse: "reconcile",
      experimental: false,
    });
  });

  test("declares and parses the closed pinned thread unsubscribe operation", () => {
    expect(OPERATIONS["thread/unsubscribe"]).toEqual({
      method: "thread/unsubscribe",
      effect: "thread-mutation",
      deadlineMs: 15_000,
      lostResponse: "reconcile",
      experimental: false,
    });
    for (const status of ["notLoaded", "notSubscribed", "unsubscribed"] as const) {
      expect(parseThreadUnsubscribe({ status })).toEqual({ status });
    }
    expect(() => parseThreadUnsubscribe({ status: "stillSubscribed" })).toThrow(CodexError);
    expect(() => parseThreadUnsubscribe({})).toThrow(CodexError);
  });

  test("projects only the safe reset-credit count from account rate limits", () => {
    const resetCreditId = "RESET_CREDIT_ID_SENTINEL";
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 99, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
        secondary: null,
        planType: "pro",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: {
        availableCount: 1,
        credits: [{
          id: resetCreditId,
          resetType: "codexRateLimits",
          status: "available",
          grantedAt: 1,
          expiresAt: null,
          title: null,
          description: null,
        }],
      },
    };
    const projected = parseRateLimits(rateLimits);
    expect(projected.resetCreditsAvailable).toBe(1);
    expect(JSON.stringify(projected)).not.toContain(resetCreditId);
    expect(parseRateLimits({
      ...rateLimits,
      rateLimitResetCredits: null,
    }).resetCreditsAvailable).toBe(0);
  });

  test("uses the authoritative reset-credit count when details are omitted or capped", () => {
    const base = {
      rateLimits: {
        limitId: null,
        limitName: "Codex",
        primary: { usedPercent: 99, windowDurationMins: 10_080, resetsAt: 2_000_000_000 },
        secondary: null,
        planType: "pro",
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
    };
    const exact = {
      id: "opaque-id",
      resetType: "codexRateLimits",
      status: "available",
      grantedAt: 1,
      expiresAt: null,
      title: null,
      description: null,
    };
    expect(parseRateLimits({
      ...base,
      rateLimitResetCredits: { availableCount: 1, credits: null },
    }).resetCreditsAvailable).toBe(1);
    expect(parseRateLimits({
      ...base,
      rateLimitResetCredits: { availableCount: 2, credits: [exact] },
    }).resetCreditsAvailable).toBe(2);
    expect(parseRateLimits({
      ...base,
      rateLimitResetCredits: {
        availableCount: 3,
        credits: [{ ...exact, resetType: "futureResetType", status: "futureStatus" }],
      },
    }).resetCreditsAvailable).toBe(3);
  });

  test("rejects malformed reset-credit counts and consumption outcomes", () => {
    const rateLimits = {
      rateLimits: {
        limitId: "codex",
        limitName: null,
        primary: null,
        secondary: null,
        planType: null,
        rateLimitReachedType: null,
      },
      rateLimitsByLimitId: null,
      rateLimitResetCredits: { availableCount: 1, credits: null },
    };
    for (const availableCount of [-1, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseRateLimits({
        ...rateLimits,
        rateLimitResetCredits: { availableCount, credits: null },
      })).toThrow(CodexError);
    }
    expect(() => parseRateLimits({
      rateLimits: rateLimits.rateLimits,
      rateLimitsByLimitId: null,
    })).toThrow(CodexError);

    for (const outcome of ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"] as const) {
      expect(parseRateLimitResetCreditConsumption({ outcome })).toEqual({ outcome });
    }
    for (const malformed of [
      {},
      { outcome: null },
      { outcome: "futureOutcome" },
      null,
    ]) {
      expect(() => parseRateLimitResetCreditConsumption(malformed)).toThrow(CodexError);
    }
  });

  test("covers the exact generated pinned ServerNotification union", () => {
    expect(Object.keys(PINNED_CODEX_NOTIFICATION_MATRIX)).toEqual([
      "error",
      "thread/started",
      "thread/status/changed",
      "thread/archived",
      "thread/deleted",
      "thread/unarchived",
      "thread/closed",
      "thread/reverted",
      "skills/changed",
      "thread/name/updated",
      "thread/goal/updated",
      "thread/goal/cleared",
      "thread/queue/changed",
      "project/changed",
      "thread/project/updated",
      "thread/environment/connected",
      "thread/environment/disconnected",
      "thread/settings/updated",
      "thread/tokenUsage/updated",
      "turn/started",
      "hook/started",
      "turn/completed",
      "hook/completed",
      "turn/diff/updated",
      "turn/plan/updated",
      "item/started",
      "item/autoApprovalReview/started",
      "item/autoApprovalReview/completed",
      "autoApprovalReview/strictReviewRequired",
      "item/completed",
      "rawResponseItem/completed",
      "rawResponse/completed",
      "item/agentMessage/delta",
      "item/plan/delta",
      "command/exec/outputDelta",
      "process/outputDelta",
      "process/exited",
      "item/commandExecution/outputDelta",
      "item/commandExecution/terminalInteraction",
      "item/fileChange/outputDelta",
      "item/fileChange/patchUpdated",
      "serverRequest/resolved",
      "item/mcpToolCall/progress",
      "mcpServer/oauthLogin/completed",
      "mcpServer/startupStatus/updated",
      "mcpServer/event/stream/notification",
      "account/updated",
      "account/rateLimits/updated",
      "app/list/updated",
      "remoteControl/status/changed",
      "externalAgentConfig/import/progress",
      "externalAgentConfig/import/completed",
      "fs/changed",
      "item/reasoning/summaryTextDelta",
      "item/reasoning/summaryPartAdded",
      "item/reasoning/textDelta",
      "thread/compacted",
      "model/rerouted",
      "model/verification",
      "modelProvider/authRecoveryStarted",
      "modelProvider/authRecoveryCompleted",
      "turn/moderationMetadata",
      "model/safetyBuffering/updated",
      "warning",
      "guardianWarning",
      "deprecationNotice",
      "configWarning",
      "fuzzyFileSearch/sessionUpdated",
      "fuzzyFileSearch/sessionCompleted",
      "thread/realtime/started",
      "thread/realtime/itemAdded",
      "thread/realtime/item/started",
      "thread/realtime/item/transcript/delta",
      "thread/realtime/item/completed",
      "thread/realtime/transcript/delta",
      "thread/realtime/transcript/done",
      "thread/realtime/outputAudio/delta",
      "thread/realtime/sdp",
      "thread/realtime/error",
      "thread/realtime/closed",
      "windows/worldWritableWarning",
      "windowsSandbox/setupCompleted",
      "account/login/completed",
    ]);
    expect(PINNED_CODEX_NOTIFICATION_SCHEMA_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertPinnedCodexNotificationMatrix()).not.toThrow();
    expect(codexNotificationDisposition("thread/deleted")).toBe("routed");
    expect(codexNotificationDisposition("account/rateLimits/updated")).toBe("routed");
    expect(codexNotificationDisposition("turn/diff/updated")).toBe("reduced");
    expect(codexNotificationDisposition("thread/realtime/outputAudio/delta")).toBe("ignored");
    expect(codexNotificationDisposition("future/notification")).toBeNull();
  });

  test("routes thread closure and deletion while explicitly discarding reviewed notifications", () => {
    expect(parseFact("thread/closed", { threadId: "thread-1" })).toEqual({
      type: "threadStatusChanged",
      threadId: "thread-1",
      status: { type: "notLoaded" },
    });
    expect(parseFact("thread/deleted", { threadId: "thread-1" })).toEqual({
      type: "threadDeleted",
      threadId: "thread-1",
    });
    expect(parseFact("account/rateLimits/updated", {
      rateLimits: { usedPercent: 99, private: "discarded" },
    })).toEqual({ type: "rateLimitsUpdated" });
    expect(parseFact("skills/changed", { private: "discarded" })).toEqual({
      type: "notificationIgnored",
      method: "skills/changed",
    });
    expect(parseFact("future/notification", { private: "discarded" })).toEqual({
      type: "protocolNotice",
      method: "future/notification",
    });
  });

  test("projects plugin discovery without local marketplace paths or load diagnostics", () => {
    const catalog = parsePluginCatalog({
      marketplaces: [{
        name: "official",
        path: "/workspace/.codex/plugins/marketplace.json",
        interface: { displayName: "Official" },
        plugins: [{
          id: "files@official",
          remotePluginId: null,
          version: "1.2.3",
          localVersion: null,
          name: "files",
          shareContext: null,
          source: { type: "local", path: "/private/plugin" },
          installed: false,
          installedAt: null,
          enabled: false,
          installPolicy: "AVAILABLE",
          installPolicySource: null,
          mustShowInstallationInterstitial: null,
          authPolicy: "ON_USE",
          availability: "AVAILABLE",
          disabledReason: null,
          eligiblePlanTypes: ["plus"],
          interface: {
            displayName: "Files",
            shortDescription: "Search files",
            longDescription: null,
            developerName: "OpenAI",
            category: "productivity",
            capabilities: ["search"],
            websiteUrl: null,
            privacyPolicyUrl: null,
            termsOfServiceUrl: null,
            defaultPrompt: null,
            brandColor: null,
            composerIcon: "/private/icon.png",
            composerIconUrl: null,
            logo: null,
            logoDark: null,
            logoUrl: null,
            logoUrlDark: null,
            screenshots: [],
            screenshotUrls: [],
          },
          keywords: ["files"],
        }],
      }],
      marketplaceLoadErrors: [{
        marketplacePath: "/workspace/private/marketplace.json",
        message: "failed at /workspace/private/marketplace.json",
      }],
      featuredPluginIds: ["files@official"],
    });
    expect(catalog).toMatchObject({
      marketplaces: [{
        name: "official",
        plugins: [{
          id: "files@official",
          displayName: "Files",
          sourceType: "local",
          installed: false,
          enabled: false,
        }],
      }],
      marketplaceLoadErrorCount: 1,
      lifecycle: { install: "blocked_compound_upstream_effect" },
    });
    expect(catalog.marketplaces[0]).not.toHaveProperty("path");
    expect(catalog.marketplaces[0]?.plugins[0]).not.toHaveProperty("source");
    expect(catalog).not.toHaveProperty("marketplaceLoadErrors");
    expect(JSON.stringify(catalog)).not.toContain("/workspace/private");
    expect(JSON.stringify(catalog)).not.toContain("/private/plugin");
    expect(JSON.stringify(catalog)).not.toContain("failed at");
  });

  test("covers the exact generated pinned ServerRequest union with a reviewed schema digest", () => {
    expect(Object.entries(PINNED_CODEX_SERVER_REQUEST_MATRIX)).toEqual([
      ["item/commandExecution/requestApproval", "brokered_interaction"],
      ["item/fileChange/requestApproval", "brokered_interaction"],
      ["item/tool/requestUserInput", "brokered_interaction"],
      ["mcpServer/elicitation/request", "brokered_interaction"],
      ["item/permissions/requestApproval", "brokered_interaction"],
      ["item/tool/call", "internal_host_service"],
      ["account/chatgptAuthTokens/refresh", "internal_host_service"],
      ["attestation/generate", "internal_host_service"],
      ["currentTime/read", "internal_host_service"],
      ["applyPatchApproval", "unsupported"],
      ["execCommandApproval", "unsupported"],
    ]);
    expect(PINNED_CODEX_SERVER_REQUEST_SCHEMA_DIGEST).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => assertPinnedCodexServerRequestMatrix()).not.toThrow();
    expect(codexServerRequestDisposition("future/request")).toBeNull();
  });

  test("defines one closed conversation-only dynamic tool schema", () => {
    expect(OOMPA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS).toHaveLength(1);
    expect(OOMPA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS[0]).toMatchObject({
      type: "namespace",
      name: "hra",
      tools: [{ type: "function", name: "automation_update" }],
    });
    const serialized = JSON.stringify(OOMPA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS);
    for (const forbidden of [
      "targetThreadId",
      "threadId",
      "sessionId",
      "destination",
      "executionEnvironment",
      "model",
      "cron",
      "rrule",
    ]) expect(serialized).not.toContain(forbidden);
    const inputSchema = JSON.parse(JSON.stringify(
      OOMPA_CONVERSATION_AUTOMATION_DYNAMIC_TOOLS[0].tools[0].inputSchema,
    )) as {
      oneOf: {
        additionalProperties?: boolean;
        properties: Record<string, { additionalProperties?: boolean }>;
      }[];
    };
    expect(inputSchema.oneOf).toHaveLength(5);
    expect(inputSchema.oneOf.every((branch) => branch.additionalProperties === false)).toBe(true);
    const schedules = inputSchema.oneOf.flatMap((branch) =>
      "schedule" in branch.properties ? [branch.properties.schedule] : []);
    expect(schedules).toHaveLength(2);
    expect(schedules.every((schedule) => schedule.additionalProperties === false)).toBe(true);
  });

  test("projects the complete domain host-tool manifest into Codex", () => {
    expect(OOMPA_HOST_DYNAMIC_TOOLS).toHaveLength(1);
    expect(OOMPA_HOST_DYNAMIC_TOOLS[0]).toMatchObject({
      type: "namespace",
      name: "hra",
    });
    expect(OOMPA_HOST_DYNAMIC_TOOLS[0].tools.map((tool) => tool.name)).toEqual([
      "automation_update",
      "sessions_list",
      "session_inspect",
      "session_message",
      "memory_remember",
      "memory_query",
      "memory_explain",
      "memory_share",
    ]);
    const parsed = parseOompaHostToolCall({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "number", value: 72 },
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-2",
        namespace: "hra",
        tool: "session_message",
        arguments: {
          sessionId: `sess_${"a".repeat(32)}`,
          expectedRevision: 3,
          delivery: "steer",
          message: "Please check the failed boundary.",
          reason: "Independent review",
        },
      },
    });
    expect(parsed).toMatchObject({
      tool: "session_message",
      input: {
        expectedRevision: 3,
        delivery: "steer",
      },
      threadId: "thread-1",
      turnId: "turn-1",
    });
    expect(() => parseConversationAutomationToolCall({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "number", value: 72 },
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-2",
        namespace: "hra",
        tool: "sessions_list",
        arguments: {},
      },
    })).toThrow(CodexError);
  });

  test("parses exact dynamic-tool authority and rejects standalone-field smuggling", () => {
    const common = {
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "number", value: 71 } as const,
    };
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      namespace: "hra",
      tool: "automation_update",
      arguments: {
        mode: "create",
        name: "Review",
        prompt: "Continue this conversation",
        schedule: { kind: "interval_minutes", minutes: 60 },
      },
    };
    const parsed = parseConversationAutomationToolCall({ ...common, params });
    expect(parsed).toMatchObject({
      authority: common.authority,
      connectionId: common.connectionId,
      requestId: common.requestId,
      threadId: "thread-1",
      turnId: "turn-1",
      callId: "call-1",
      operation: params.arguments,
    });
    expect(parsed.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
    const reordered = parseConversationAutomationToolCall({
      ...common,
      params: {
        arguments: {
          schedule: { minutes: 60, kind: "interval_minutes" },
          prompt: "Continue this conversation",
          name: "Review",
          mode: "create",
        },
        tool: "automation_update",
        namespace: "hra",
        callId: "call-1",
        turnId: "turn-1",
        threadId: "thread-1",
      },
    });
    expect(reordered.requestDigest).toBe(parsed.requestDigest);

    const taskId = `stask_${"a".repeat(32)}`;
    const supportedOperations = [
      { mode: "update", id: taskId, revision: 2, status: "paused" },
      { mode: "view", id: taskId },
      { mode: "list" },
      { mode: "delete", id: taskId, revision: 3 },
    ] as const;
    for (const operation of supportedOperations) {
      expect(parseConversationAutomationToolCall({
        ...common,
        params: { ...params, arguments: operation },
      }).operation).toEqual(operation);
    }

    const invalid = [
      { ...params, namespace: null },
      { ...params, namespace: "other" },
      { ...params, tool: "automation_create" },
      { ...params, destination: "standalone" },
      { ...params, arguments: { ...params.arguments, destination: "standalone" } },
      {
        ...params,
        arguments: {
          ...params.arguments,
          schedule: { ...params.arguments.schedule, cron: "0 9 * * *" },
        },
      },
      {
        ...params,
        arguments: {
          mode: "update",
          id: "task-1",
          revision: 1,
        },
      },
      {
        ...params,
        arguments: {
          mode: "delete",
          id: "task-1",
          revision: 0,
        },
      },
      {
        ...params,
        arguments: {
          ...params.arguments,
          schedule: { kind: "interval_minutes", minutes: 10 },
        },
      },
    ];
    for (const candidate of invalid) {
      expect(() => parseConversationAutomationToolCall({
        ...common,
        params: candidate,
      })).toThrow(CodexError);
    }
  });

  test("enforces UTF-8 task bounds and one bounded canonical text result", () => {
    const parseArguments = (argumentsValue: unknown) => parseConversationAutomationToolCall({
      authority: codexAuthority(1),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "string", value: "tool-1" },
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-1",
        namespace: "hra",
        tool: "automation_update",
        arguments: argumentsValue,
      },
    });
    expect(parseArguments({
      mode: "create",
      name: "é".repeat(80),
      prompt: "x".repeat(262_144),
      schedule: { kind: "interval_minutes", minutes: 10_080 },
    }).operation).toMatchObject({ mode: "create" });
    expect(() => parseArguments({
      mode: "create",
      name: "é".repeat(81),
      prompt: "continue",
      schedule: { kind: "interval_minutes", minutes: 15 },
    })).toThrow(CodexError);
    for (const separator of [String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)]) {
      expect(() => parseArguments({
        mode: "create",
        name: `Review${separator}forged`,
        prompt: "continue",
        schedule: { kind: "interval_minutes", minutes: 15 },
      })).toThrow(CodexError);
    }
    expect(() => parseArguments({
      mode: "create",
      name: "Review",
      prompt: "é".repeat(131_073),
      schedule: { kind: "interval_minutes", minutes: 15 },
    })).toThrow(CodexError);
    expect(serializeDynamicToolPublicResult({ z: 1, a: { d: 2, b: true } })).toBe(
      "{\"a\":{\"b\":true,\"d\":2},\"z\":1}",
    );
    const exactFourByteResult = "😀".repeat((64 * 1_024) / 4);
    expect(new TextEncoder().encode(serializeDynamicToolPublicResult(exactFourByteResult)))
      .toHaveLength(64 * 1_024);
    expect(() => serializeDynamicToolPublicResult(`${exactFourByteResult}x`))
      .toThrow(CodexError);
    expect(() => serializeDynamicToolPublicResult("")).toThrow(CodexError);
    expect(() => serializeDynamicToolPublicResult("é".repeat(32_769))).toThrow(CodexError);
    expect(() => serializeDynamicToolPublicResult([] as never)).toThrow(CodexError);
  });

  test("parses every brokered method into a bounded display and exact private authority", () => {
    for (const [method, params] of Object.entries(brokeredFixtures) as [BrokeredCodexServerRequestMethod, unknown][]) {
      const parsed = parseBrokeredCodexServerRequest({
        authority: codexAuthority(9),
        connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
        requestId: { type: "string", value: method },
        method,
        params,
      });
      expect(parsed.provider).toMatchObject({
        profileId: "profile-a",
        processGeneration: 9,
        method,
        requestId: { type: "string", value: method },
      });
      expect(parsed.provider.requestDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(JSON.stringify(parsed.display)).not.toContain("git push origin main");
    }

    const lineSeparated = parseBrokeredCodexServerRequest({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "string", value: "line-separated" },
      method: "item/commandExecution/requestApproval",
      params: {
        ...(brokeredFixtures["item/commandExecution/requestApproval"] as Record<string, unknown>),
        reason: `line${String.fromCodePoint(0x2028)}forged${String.fromCodePoint(0x2029)}paragraph`,
      },
    });
    expect(JSON.stringify(lineSeparated.display)).not.toContain(String.fromCodePoint(0x2028));
    expect(JSON.stringify(lineSeparated.display)).not.toContain(String.fromCodePoint(0x2029));

    const fileChange = parseBrokeredCodexServerRequest({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "string", value: "file" },
      method: "item/fileChange/requestApproval",
      params: {
        ...(brokeredFixtures["item/fileChange/requestApproval"] as Record<string, unknown>),
        // This field is absent from the pinned params contract. Even if a
        // malformed peer supplies it, it must not create an acceptance path.
        availableDecisions: ["accept", "acceptForSession"],
      },
    });
    expect(fileChange.display).toEqual({
      kind: "file_change_approval",
      summary: "Allow the proposed file changes",
      reason: "write files",
      grantRoot: "/workspace",
      availableDecisions: ["decline", "cancel"],
    });
    expect(fileChange.privateApprovalAuthority).toBeNull();
    for (const decision of ["decline", "cancel"] as const) {
      expect(compileCodexInteractionResponse({
        method: "item/fileChange/requestApproval",
        kind: fileChange.kind,
        privateParams: fileChange.privateParams,
        resolution: { kind: "approval_decision", decision },
      })).toEqual({ decision });
    }
    for (const decision of ["once", "session"] as const) {
      expect(() => compileCodexInteractionResponse({
        method: "item/fileChange/requestApproval",
        kind: fileChange.kind,
        privateParams: fileChange.privateParams,
        resolution: { kind: "approval_decision", decision },
      })).toThrow("does not offer");
    }

    const urlSecret = "URL_SECRET_SENTINEL";
    try {
      parseBrokeredCodexServerRequest({
        authority: codexAuthority(9),
        connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
        requestId: { type: "string", value: "url-elicitation" },
        method: "mcpServer/elicitation/request",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          serverName: "example",
          mode: "url",
          _meta: null,
          message: "Authorize Example",
          url: `https://example.com/oauth?access_token=${urlSecret}#${urlSecret}`,
          elicitationId: "elicit-url",
        },
      });
      throw new Error("Expected URL elicitation to be rejected.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(CodexError);
      expect((error as CodexError).code).toBe("UNSUPPORTED_CAPABILITY");
      expect((error as Error).message).not.toContain(urlSecret);
    }
    const secretCommand = parseBrokeredCodexServerRequest({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "number", value: 99 },
      method: "item/commandExecution/requestApproval",
      params: {
        ...(brokeredFixtures["item/commandExecution/requestApproval"] as Record<string, unknown>),
        command: "git -c credential.helper=SECRET push origin main",
      },
    });
    expect(secretCommand.display).toMatchObject({ commandClass: "git push" });
    expect(JSON.stringify(secretCommand.display)).not.toContain("SECRET");
    expect(secretCommand.privateApprovalAuthority).toMatchObject({
      kind: "command_approval",
      command: "git -c credential.helper=SECRET push origin main",
      reason: "network",
      availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      commandActions: [{ type: "unknown", command: "git push origin main" }],
      networkApprovalContext: { host: "github.com", protocol: "https" },
      additionalPermissions: { network: { enabled: true } },
    });

    const reset = (command: string) => parseBrokeredCodexServerRequest({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "string", value: command },
      method: "item/commandExecution/requestApproval",
      params: {
        ...(brokeredFixtures["item/commandExecution/requestApproval"] as Record<string, unknown>),
        command,
      },
    });
    const hard = reset("git reset --hard HEAD");
    const soft = reset("git reset --soft HEAD^");
    expect(hard.display).toEqual(soft.display);
    expect(hard.privateApprovalAuthority).not.toEqual(soft.privateApprovalAuthority);

    const permission = parseBrokeredCodexServerRequest({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "string", value: "permission" },
      method: "item/permissions/requestApproval",
      params: brokeredFixtures["item/permissions/requestApproval"],
    });
    expect(permission.privateApprovalAuthority).toEqual({
      kind: "permission_approval",
      permissions: {
        fileSystem: { read: [permissionPrivatePath] },
        network: { enabled: true },
      },
      reason: "network",
      workingDirectory: "/workspace",
      environmentId: null,
    });
    expect(JSON.stringify(permission.display)).not.toContain(permissionPrivatePath);
    for (const invalidCwd of [undefined, null, "relative/workspace"] as const) {
      const params: Record<string, unknown> = {
        ...(brokeredFixtures["item/permissions/requestApproval"] as Record<string, unknown>),
      };
      if (invalidCwd === undefined) delete params.cwd;
      else params.cwd = invalidCwd;
      expect(() => parseBrokeredCodexServerRequest({
        authority: codexAuthority(9),
        connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
        requestId: { type: "string", value: `permission-cwd-${String(invalidCwd)}` },
        method: "item/permissions/requestApproval",
        params,
      })).toThrow(CodexError);
    }

    expect(() => reset("   ")).toThrow(expect.objectContaining({
      code: "UNSUPPORTED_CAPABILITY",
    }));
  });

  test("preserves the exact representable command approval decisions and rejects unsupported contracts", () => {
    const parseCommand = (availableDecisions: unknown, includeDecisions = true) => {
      const params = {
        ...(brokeredFixtures["item/commandExecution/requestApproval"] as Record<string, unknown>),
        ...(includeDecisions ? { availableDecisions } : {}),
      };
      if (!includeDecisions) delete params.availableDecisions;
      return parseBrokeredCodexServerRequest({
        authority: codexAuthority(9),
        connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
        requestId: { type: "string", value: "command-decisions" },
        method: "item/commandExecution/requestApproval",
        params,
      });
    };
    const amendment = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: { safeOpaqueProviderValue: true },
      },
    };

    const acceptAndCancel = parseCommand(["accept", "cancel", "accept"]);
    expect(acceptAndCancel.display).toMatchObject({
      kind: "command_approval",
      availableDecisions: ["once", "cancel"],
    });
    expect(compileCodexInteractionResponse({
      method: "item/commandExecution/requestApproval",
      kind: acceptAndCancel.kind,
      privateParams: acceptAndCancel.privateParams,
      resolution: { kind: "approval_decision", decision: "once" },
    })).toEqual({ decision: "accept" });
    expect(compileCodexInteractionResponse({
      method: "item/commandExecution/requestApproval",
      kind: acceptAndCancel.kind,
      privateParams: acceptAndCancel.privateParams,
      resolution: { kind: "approval_decision", decision: "cancel" },
    })).toEqual({ decision: "cancel" });
    for (const unavailable of ["session", "decline"] as const) {
      expect(() => compileCodexInteractionResponse({
        method: "item/commandExecution/requestApproval",
        kind: acceptAndCancel.kind,
        privateParams: acceptAndCancel.privateParams,
        resolution: { kind: "approval_decision", decision: unavailable },
      })).toThrow("does not offer");
    }

    const rejectionOnly = parseCommand([amendment, "decline", "cancel"]);
    expect(rejectionOnly.display).toMatchObject({
      kind: "command_approval",
      availableDecisions: ["decline", "cancel"],
    });

    const full = parseCommand(["accept", "acceptForSession", "decline", "cancel"]);
    expect(full.display).toMatchObject({
      kind: "command_approval",
      availableDecisions: ["once", "session", "decline", "cancel"],
    });
    for (const [decision, providerDecision] of [
      ["once", "accept"],
      ["session", "acceptForSession"],
      ["decline", "decline"],
      ["cancel", "cancel"],
    ] as const) {
      expect(compileCodexInteractionResponse({
        method: "item/commandExecution/requestApproval",
        kind: full.kind,
        privateParams: full.privateParams,
        resolution: { kind: "approval_decision", decision },
      })).toEqual({ decision: providerDecision });
    }

    for (const [availableDecisions, includeDecisions] of [
      [undefined, false],
      [null, true],
      [[], true],
      [[amendment], true],
      [["futureDecision", "cancel"], true],
      [[{ unexpectedAmendment: {} }, "cancel"], true],
    ] as const) {
      try {
        parseCommand(availableDecisions, includeDecisions);
        throw new Error("Expected the command decision contract to be rejected.");
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(CodexError);
        expect((error as CodexError).code).toBe("UNSUPPORTED_CAPABILITY");
      }
    }
  });

  test("rejects ambiguous user-input question IDs and rendered option labels", () => {
    const parseQuestions = (questions: unknown) => parseBrokeredCodexServerRequest({
      authority: codexAuthority(9),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "string", value: "ambiguous-questions" },
      method: "item/tool/requestUserInput",
      params: {
        ...(brokeredFixtures["item/tool/requestUserInput"] as Record<string, unknown>),
        questions,
      },
    });
    const question = {
      id: "confirm",
      header: "Confirm",
      question: "Continue?",
      isOther: false,
      isSecret: false,
      options: [{ label: "Yes", description: "Continue" }],
    };
    expect(() => parseQuestions([
      question,
      { ...question, header: "Confirm again", question: "Really continue?" },
    ])).toThrow("question ids must be unique");
    expect(() => parseQuestions([{
      ...question,
      options: [
        { label: "same", description: "First meaning" },
        { label: "same", description: "Second meaning" },
      ],
    }])).toThrow("option labels must be unique");
    expect(() => parseQuestions([{
      ...question,
      options: [
        { label: "\u0001", description: "First control" },
        { label: "\u0002", description: "Second control" },
      ],
    }])).toThrow("option labels must be unique");

    const rawLabel = "😀".repeat(200);
    const lossy = parseQuestions([{
      ...question,
      options: [{ label: rawLabel, description: "A multibyte choice" }],
    }]);
    if (lossy.display.kind !== "user_input") throw new Error("expected user input");
    const projected = lossy.display.questions[0];
    const projectedLabel = projected?.options?.[0]?.label;
    expect(projectedLabel).toBeDefined();
    expect(projectedLabel).not.toBe(rawLabel);
    expect(projected?.remoteAnswerable).toBeUndefined();
    expect(() => compileCodexInteractionResponse({
      method: "item/tool/requestUserInput",
      kind: lossy.kind,
      privateParams: lossy.privateParams,
      resolution: {
        answers: { confirm: { answers: [projectedLabel ?? ""] } },
        kind: "user_answers",
      },
    })).toThrow("requested choices");

    const exact = parseQuestions([question]);
    if (exact.display.kind !== "user_input") throw new Error("expected user input");
    expect(exact.display.questions[0]?.remoteAnswerable).toBe(true);
    expect(compileCodexInteractionResponse({
      method: "item/tool/requestUserInput",
      kind: exact.kind,
      privateParams: exact.privateParams,
      resolution: {
        answers: { confirm: { answers: ["Yes"] } },
        kind: "user_answers",
      },
    })).toEqual({ answers: { confirm: { answers: ["Yes"] } } });
  });

  test("caps valid provider auto-resolution intervals and rejects malformed authority", () => {
    const parseTimeout = (autoResolutionMs: unknown): number =>
      parseBrokeredCodexServerRequest({
        authority: codexAuthority(1),
        connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
        requestId: { type: "string", value: `timeout-${String(autoResolutionMs)}` },
        method: "item/tool/requestUserInput",
        params: { ...(brokeredFixtures["item/tool/requestUserInput"] as Record<string, unknown>), autoResolutionMs },
      }).timeoutMs;
    expect(parseTimeout(null)).toBe(INTERACTION_MAX_PENDING_MS);
    expect(parseTimeout(0)).toBe(0);
    expect(parseTimeout(1)).toBe(1);
    expect(parseTimeout(INTERACTION_MAX_PENDING_MS)).toBe(INTERACTION_MAX_PENDING_MS);
    expect(parseTimeout(INTERACTION_MAX_PENDING_MS + 1)).toBe(INTERACTION_MAX_PENDING_MS);
    for (const malformed of [-1, 1.5, Number.NaN, "1000"]) {
      expect(() => parseTimeout(malformed)).toThrow(CodexError);
    }
  });

  test("keeps numeric and string request identities distinct and rejects permission escalation", () => {
    expect(parseProviderRequestId(1)).toEqual({ type: "number", value: 1 });
    expect(parseProviderRequestId("1")).toEqual({ type: "string", value: "1" });
    const parsed = parseBrokeredCodexServerRequest({
      authority: codexAuthority(1),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "number", value: 1 },
      method: "item/permissions/requestApproval",
      params: brokeredFixtures["item/permissions/requestApproval"],
    });
    expect(parsed.display).toMatchObject({
      kind: "permission_approval",
      requested: [{ name: "fileSystem" }, { name: "network" }],
    });
    expect(JSON.stringify(parsed.display)).not.toContain("PERMISSION_VALUE_SENTINEL");
    expect(JSON.stringify(parsed.display)).not.toContain(permissionPrivatePath);
    expect(() => compileCodexInteractionResponse({
      method: "item/permissions/requestApproval",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: {
        kind: "permission_grant",
        permissions: ["network", "notRequested"],
        scope: "session",
      },
    })).toThrow("exceed");
    expect(compileCodexInteractionResponse({
      method: "item/permissions/requestApproval",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: { kind: "approval_decision", decision: "decline" },
    })).toEqual({ permissions: {}, scope: "turn" });
    expect(() => compileCodexInteractionResponse({
      method: "item/permissions/requestApproval",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: { kind: "approval_decision", decision: "cancel" },
    })).toThrow("supports");
    expect(compileCodexInteractionResponse({
      method: "item/permissions/requestApproval",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: {
        kind: "permission_grant",
        permissions: ["network"],
        scope: "turn",
      },
    })).toEqual({ permissions: { network: { enabled: true } }, scope: "turn" });
    expect(compileCodexInteractionResponse({
      method: "item/permissions/requestApproval",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: {
        kind: "permission_grant",
        permissions: ["fileSystem"],
        scope: null,
      },
    })).toEqual({
      permissions: { fileSystem: { read: [permissionPrivatePath] } },
      scope: "turn",
    });
  });

  test("brokers the closed standard MCP form contract and validates the exact protected response", () => {
    const schemaOnlySentinel = "MCP_SCHEMA_PRIVATE_SENTINEL";
    const params = {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      mode: "form",
      _meta: null,
      message: "credential=TOPSECRET-9415",
      requestedSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          birthday: { type: "string", format: "date" },
          email: {
            type: "string",
            title: schemaOnlySentinel,
            description: schemaOnlySentinel,
            minLength: 3,
            maxLength: 320,
            format: "email",
            default: "default@example.com",
          },
          retries: { type: "integer", minimum: 1, maximum: 5, default: 2 },
          ratio: { type: "number", minimum: 0, maximum: 1 },
          confirmed: { type: "boolean", default: false },
          endpoint: { type: "string", format: "uri" },
          tier: {
            type: "string",
            oneOf: [
              { const: "free", title: schemaOnlySentinel },
              { const: "pro", title: schemaOnlySentinel },
            ],
            default: "free",
          },
          tags: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            items: {
              anyOf: [
                { const: "stable", title: schemaOnlySentinel },
                { const: "fast", title: schemaOnlySentinel },
              ],
            },
            default: ["stable"],
          },
          when: { type: "string", format: "date-time" },
        },
        required: ["email", "retries", "confirmed", "tier", "tags"],
      },
    };
    const parsed = parseBrokeredCodexServerRequest({
      authority: codexAuthority(1),
      connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
      requestId: { type: "string", value: "mcp-form" },
      method: "mcpServer/elicitation/request",
      params,
    });
    expect(parsed.display).toEqual({
      kind: "mcp_elicitation",
      summary: "Codex requests MCP form input",
      serverName: "example",
      mode: "form",
      url: null,
      mayContainSecrets: true,
      fields: [
        { name: "birthday", type: "string", required: false, minLength: 0, maxLength: 16_384, format: "date" },
        { name: "confirmed", type: "boolean", required: true },
        { name: "email", type: "string", required: true, minLength: 3, maxLength: 320, format: "email" },
        { name: "endpoint", type: "string", required: false, minLength: 0, maxLength: 16_384, format: "uri" },
        { name: "ratio", type: "number", required: false, minimum: 0, maximum: 1 },
        { name: "retries", type: "integer", required: true, minimum: 1, maximum: 5 },
        { name: "tags", type: "multi_select", required: true, choices: ["stable", "fast"], minItems: 1, maxItems: 2 },
        { name: "tier", type: "single_select", required: true, choices: ["free", "pro"] },
        { name: "when", type: "string", required: false, minLength: 0, maxLength: 16_384, format: "date-time" },
      ],
    });
    expect(JSON.stringify(parsed.display)).not.toContain("TOPSECRET-9415");
    expect(JSON.stringify(parsed.display)).not.toContain(schemaOnlySentinel);
    const content = {
      birthday: "2024-02-29",
      email: "person@example.com",
      endpoint: "https://example.com/configure",
      retries: 3,
      ratio: 0.5,
      confirmed: true,
      tier: "pro",
      tags: ["stable", "fast"],
      when: "2026-08-23T04:05:06Z",
    };
    expect(compileCodexInteractionResponse({
      method: "mcpServer/elicitation/request",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: { kind: "mcp_submission", action: "accept", content },
    })).toEqual({ action: "accept", content, _meta: null });
    expect(compileCodexInteractionResponse({
      method: "mcpServer/elicitation/request",
      kind: parsed.kind,
      privateParams: parsed.privateParams,
      resolution: { kind: "mcp_submission", action: "decline" },
    })).toEqual({ action: "decline", content: null, _meta: null });

    const submittedSentinel = "MCP_SUBMISSION_SECRET_SENTINEL";
    for (const invalid of [
      { ...content, email: submittedSentinel },
      { ...content, email: "a..b@example..com" },
      { ...content, birthday: "2025-02-29" },
      { ...content, endpoint: "/relative/path" },
      { ...content, when: "2026-08-23T25:05:06Z" },
      { ...content, retries: 2.5 },
      { ...content, retries: 6 },
      { ...content, tier: submittedSentinel },
      { ...content, tags: [submittedSentinel] },
      { ...content, additional: submittedSentinel },
      { retries: 3, confirmed: true, tier: "pro", tags: ["stable"] },
      null,
    ]) {
      const error = (() => {
        try {
          compileCodexInteractionResponse({
            method: "mcpServer/elicitation/request",
            kind: parsed.kind,
            privateParams: parsed.privateParams,
            resolution: { kind: "mcp_submission", action: "accept", content: invalid },
          });
          return null;
        } catch (caught: unknown) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(CodexError);
      expect((error as CodexError).code).toBe("INVALID_INPUT");
      expect((error as Error).message).not.toContain(submittedSentinel);
    }
  });

  test("fails closed on opaque, malformed, oversized, and lookalike MCP form schemas", () => {
    const schemaSentinel = "MCP_UNSUPPORTED_SCHEMA_SENTINEL";
    const base = {
      threadId: "thread-1",
      turnId: "turn-1",
      serverName: "example",
      _meta: null,
      message: "Configure Example",
    };
    const unsupported = [
      {
        ...base,
        mode: "form",
        requestedSchema: null,
      },
      {
        ...base,
        mode: "openai/form",
        requestedSchema: { type: "object", properties: { secret: { type: schemaSentinel } } },
      },
      {
        ...base,
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { token: { type: "string", pattern: schemaSentinel } },
        },
      },
      {
        ...base,
        mode: "form",
        _meta: {
          codex_approval_kind: "tool_suggestion",
          persist: "always",
          tool_type: "plugin",
          suggest_type: "install",
          install_url: `https://example.com/install?secret=${schemaSentinel}`,
        },
        requestedSchema: { type: "object", properties: {} },
      },
      {
        ...base,
        mode: "form",
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          codex_request_type: "approval_request",
          connector_name: schemaSentinel,
          tool_name: "delete_records",
          tool_params: { target: schemaSentinel },
          persist: "always",
        },
        requestedSchema: { type: "object", properties: {} },
      },
      {
        ...base,
        mode: "form",
        _meta: { codex_approval_kind: "future_side_effect", detail: schemaSentinel },
        requestedSchema: { type: "object", properties: {} },
      },
      {
        ...base,
        mode: "form",
        requestedSchema: { Type: "object", properties: {} },
      },
      {
        ...base,
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
            `field_${String(index)}`,
            { type: "boolean" },
          ])),
        },
      },
      {
        ...base,
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { choice: { type: "string", enum: ["x".repeat(129)] } },
        },
      },
    ];
    for (const [index, params] of unsupported.entries()) {
      const error = (() => {
        try {
          parseBrokeredCodexServerRequest({
            authority: codexAuthority(1),
            connectionId: "018f1f55-3f10-7c1a-8f7b-c6dc608bcd3b",
            requestId: { type: "string", value: `unsupported-${String(index)}` },
            method: "mcpServer/elicitation/request",
            params,
          });
          return null;
        } catch (caught: unknown) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(CodexError);
      expect((error as Error).message).not.toContain(schemaSentinel);
      expect(JSON.stringify(error)).not.toContain(schemaSentinel);
    }
  });

  test("projects visible deltas and metrics while excluding raw reasoning and tool payloads", () => {
    expect(parseFact("item/agentMessage/delta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-1", delta: "hello",
    })).toMatchObject({ type: "assistantDelta", text: "hello" });
    expect(parseFact("item/reasoning/summaryTextDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-2", summaryIndex: 0, delta: "summary",
    })).toMatchObject({ type: "reasoningSummaryDelta", text: "summary", summaryIndex: 0 });
    const hidden = parseFact("item/reasoning/textDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-2", contentIndex: 0,
      delta: "hidden chain of thought",
    });
    expect(hidden).toEqual({ type: "notificationIgnored", method: "item/reasoning/textDelta" });
    expect(JSON.stringify(hidden)).not.toContain("hidden chain of thought");

    const output = parseFact("item/commandExecution/outputDelta", {
      threadId: "thread-1", turnId: "turn-1", itemId: "item-3", delta: "SECRET OUTPUT",
    });
    expect(output).toMatchObject({ type: "toolProgress", toolKind: "command", outputBytesObserved: 13 });
    expect(JSON.stringify(output)).not.toContain("SECRET OUTPUT");

    const item = parseFact("item/completed", {
      threadId: "thread-1", turnId: "turn-1", completedAtMs: 2,
      item: {
        type: "mcpToolCall", id: "item-4", server: "github", tool: "create_issue",
        status: "completed", arguments: { token: "SECRET" }, result: { content: "SECRET RESULT" },
      },
    });
    expect(item).toMatchObject({ type: "itemCompleted", server: "github", tool: "create_issue", status: "completed" });
    expect(JSON.stringify(item)).not.toContain("SECRET");

    const diagnosticPath = ["", "Users", "alice", "private", "key"].join("/");
    const diagnosticSecret = `Bearer PROVIDER_DIAGNOSTIC_SECRET at ${diagnosticPath}`;
    const warning = parseFact("warning", { threadId: "thread-1", message: diagnosticSecret });
    const error = parseFact("error", {
      threadId: "thread-1",
      turnId: "turn-1",
      willRetry: false,
      error: { message: diagnosticSecret, codexErrorInfo: diagnosticSecret },
    });
    expect(warning).toMatchObject({ code: "provider_warning", message: "Codex reported a provider warning." });
    expect(error).toMatchObject({ code: "provider_error", message: "Codex reported a provider error." });
    expect(JSON.stringify([warning, error])).not.toContain("PROVIDER_DIAGNOSTIC_SECRET");
    expect(JSON.stringify([warning, error])).not.toContain(diagnosticPath);
  });

  test("reduces plan, diff, and token notifications without retaining patch text", () => {
    expect(parseFact("turn/plan/updated", {
      threadId: "thread-1", turnId: "turn-1", explanation: "Next", plan: [
        { step: "Inspect", status: "completed" },
        { step: "Fix", status: "inProgress" },
      ],
    })).toMatchObject({ type: "planUpdated", steps: [{ text: "Inspect", status: "completed" }, { text: "Fix", status: "in_progress" }] });
    const diff = parseFact("turn/diff/updated", {
      threadId: "thread-1", turnId: "turn-1", diff: "diff --git a/a b/a\n+SECRET\n",
    });
    expect(diff).toMatchObject({ type: "diffUpdated", changedFiles: 1 });
    expect(JSON.stringify(diff)).not.toContain("SECRET");
    expect(parseFact("thread/tokenUsage/updated", {
      threadId: "thread-1", turnId: "turn-1",
      tokenUsage: {
        total: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2 },
        last: { totalTokens: 15, inputTokens: 10, cachedInputTokens: 3, cacheWriteInputTokens: 0, outputTokens: 5, reasoningOutputTokens: 2 },
        modelContextWindow: 200_000,
      },
    })).toMatchObject({ type: "tokenUsageUpdated", totalTokens: 15, reasoningOutputTokens: 2, modelContextWindow: 200_000 });
  });

  test("projects an exact non-secret live command digest and no arbitrary command oracle", () => {
    const command = "/bin/echo oompa-live-tool-progress | /usr/bin/tee ./.oompa-live-command-proof-00000000-0000-4000-8000-000000000001.txt";
    const expectedDigest = createHash("sha256")
      .update("hra:live-acceptance-command:v1\0", "utf8")
      .update(command, "utf8")
      .digest("hex");
    expect(safeLiveAcceptanceCommandDigest(command)).toBe(expectedDigest);
    expect(parseFact("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command,
        cwd: "/workspace",
        status: "inProgress",
      },
    })).toMatchObject({
      type: "itemStarted",
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: expectedDigest,
    });
    expect(parseFact("item/completed", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-1",
        command,
        cwd: "/workspace",
        status: "completed",
      },
    })).toMatchObject({
      type: "itemCompleted",
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: expectedDigest,
    });

    const secret = "TOKEN=private /bin/sh -c 'do-sensitive-work'";
    const arbitrary = parseFact("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: {
        type: "commandExecution",
        id: "command-2",
        command: secret,
        cwd: "/workspace",
        status: "inProgress",
      },
    });
    expect(safeLiveAcceptanceCommandDigest(secret)).toBeUndefined();
    expect(arbitrary).not.toHaveProperty("liveAcceptanceCommandDigest");
    expect(JSON.stringify(arbitrary)).not.toContain("private");
    for (const lookalike of [
      `${command} `,
      command.replace("/bin/echo", "echo"),
      command.replace("oompa-live-tool-progress", "other"),
      command.replace(".oompa-live-command-proof-", ".other-"),
      command.replace("00000000-0000-4000-8000-000000000001", "NOT-A-UUID"),
    ]) expect(safeLiveAcceptanceCommandDigest(lookalike)).toBeUndefined();
  });

  test("reduces every subagent activity kind and never retains the agent definition path", () => {
    const agentPath = ["", "Users", "someone", ".codex", "agents", "reviewer.md"].join("/");
    for (const kind of ["started", "interacted", "interrupted", "completed"] as const) {
      const item = {
        type: "subAgentActivity",
        id: `activity-${kind}`,
        kind,
        agentThreadId: "thread-agent-1",
        agentPath,
      };
      for (const method of ["item/started", "item/completed"] as const) {
        const fact = parseFact(method, { threadId: "thread-1", turnId: "turn-1", item });
        expect(fact).toMatchObject({
          type: method === "item/started" ? "itemStarted" : "itemCompleted",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: `activity-${kind}`,
          itemKind: "subAgentActivity",
          subagent: { agentThreadId: "thread-agent-1", kind },
        });
        expect(JSON.stringify(fact)).not.toContain("agents");
        expect(JSON.stringify(fact)).not.toContain("someone");
      }
    }
    expect(() => parseFact("item/started", {
      threadId: "thread-1",
      turnId: "turn-1",
      item: { type: "subAgentActivity", id: "activity-x", kind: "futureKind", agentThreadId: "thread-agent-1" },
    })).toThrow(CodexError);
  });

  test("carries the same subagent activity through a thread item page", () => {
    expect(parseThreadItemsPage({
      data: [{
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "activity-1",
          kind: "interacted",
          agentThreadId: "thread-agent-1",
          agentPath: ["", "tmp", "agents", "reviewer.md"].join("/"),
        },
      }],
      nextCursor: null,
      backwardsCursor: null,
    })).toEqual({
      data: [{
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          id: "activity-1",
          kind: "interacted",
          agentThreadId: "thread-agent-1",
        },
      }],
      nextCursor: null,
      backwardsCursor: null,
    });
  });

  test("reduces a spawned subagent thread start to bounded labels keyed by its parent", () => {
    expect(parseFact("thread/started", {
      thread: {
        id: "thread-agent-1",
        parentThreadId: "thread-1",
        agentNickname: "quiet-otter",
        agentRole: "reviewer",
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 2 } } },
      },
    })).toEqual({
      type: "subagentThreadStarted",
      threadId: "thread-1",
      agentThreadId: "thread-agent-1",
      depth: 2,
      nickname: "quiet-otter",
      role: "reviewer",
    });
  });

  test("discards an ordinary thread start and every unsafe subagent label", () => {
    expect(parseFact("thread/started", {
      thread: { id: "thread-1", parentThreadId: null, agentNickname: null, agentRole: null },
    })).toEqual({ type: "notificationIgnored", method: "thread/started" });

    const reduced = parseFact("thread/started", {
      thread: {
        id: "thread-agent-2",
        parentThreadId: "thread-1",
        agentNickname: ["", "Users", "someone", "work"].join("/"),
        agentRole: `token=${"a".repeat(40)}`,
        source: { subAgent: { thread_spawn: { parent_thread_id: "thread-1", depth: 4_000 } } },
      },
    });
    expect(reduced).toMatchObject({ type: "subagentThreadStarted", agentThreadId: "thread-agent-2" });
    expect(reduced).not.toHaveProperty("depth");
    expect(JSON.stringify(reduced)).not.toContain("someone");
    expect(JSON.stringify(reduced)).not.toContain("a".repeat(40));

    const long = parseFact("thread/started", {
      thread: {
        id: "thread-agent-3",
        parentThreadId: "thread-1",
        agentNickname: "n".repeat(400),
        agentRole: "ops\u0007team\u200b",
      },
    }) as { nickname?: string; role?: string };
    expect(long.nickname?.length).toBe(120);
    expect(long.role).toBe("ops\uFFFDteam\uFFFD");
  });
});

describe("runtime capability resolution", () => {
  test("maps only the advertised reduced presets", () => {
    expect(resolvePreset(capabilities, "low", presetRequirements.low, false)).toMatchObject({
      model: "gpt-5.6-luna",
      effort: "max",
      serviceTier: null,
    });
    expect(resolvePreset(capabilities, "high", presetRequirements.high, true)).toMatchObject({
      model: "gpt-6-astra",
      effort: "max",
      serviceTier: "priority",
    });
    expect(resolvePreset(capabilities, "ultra", presetRequirements.ultra, false)).toMatchObject({
      model: "gpt-6-astra",
      effort: "ultra",
    });
  });

  test("resolves a historical exact tuple without reinterpreting its alias", () => {
    const legacyHigh = presetRequirementForContract("high", legacyPresetContract);
    expect(resolvePreset(capabilities, "high", legacyHigh, false)).toMatchObject({
      alias: "high",
      model: "gpt-5.6-sol",
      effort: "max",
    });
    const astraHigh = presetRequirementForContract("high", currentPresetContract);
    expect(resolvePreset(capabilities, "high", astraHigh, false)).toMatchObject({
      alias: "high",
      model: "gpt-6-astra",
      effort: "max",
    });
    expect(() => resolvePreset(capabilities, "high", {
      model: "gpt-5.6-luna",
      effort: "max",
    }, false)).toThrow("unadmitted exact Oompa model and reasoning tuple");
  });

  test("fails closed when Fast is not advertised", () => {
    const withoutFast: CodexCapabilitySnapshot = {
      ...capabilities,
      models: capabilities.models.map((model) => ({ ...model, serviceTiers: [] })),
    };
    expect(() => resolvePreset(withoutFast, "high", presetRequirements.high, true)).toThrow(CodexError);
  });

  test("never selects a prefixed or suffixed lookalike under catalog reordering", () => {
    const catalog = [
      { ...capabilities.models[0]!, id: "gpt-5.6-luna-mini", model: "gpt-5.6-luna-mini" },
      { ...capabilities.models[2]!, id: "legacy-gpt-6-astra", model: "legacy-gpt-6-astra" },
      ...capabilities.models,
    ];
    fc.assert(fc.property(fc.shuffledSubarray(catalog, { minLength: 5, maxLength: 5 }), (models) => {
      expect(resolvePreset({ ...capabilities, models }, "low", presetRequirements.low, false).model).toBe("gpt-5.6-luna");
      expect(resolvePreset({ ...capabilities, models }, "high", presetRequirements.high, false).model).toBe("gpt-6-astra");
    }));
    const lookalikesOnly = {
      ...capabilities,
      models: capabilities.models.map((model) => ({ ...model, model: `${model.model}-mini` })),
    };
    expect(() => resolvePreset(lookalikesOnly, "high", presetRequirements.high, false)).toThrow(CodexError);
  });

  test("rejects an unrecognized reasoning effort", () => {
    expect(() =>
      parseModelPage({
        data: [
          {
            id: "future",
            model: "future",
            displayName: "Future",
            hidden: false,
            supportedReasoningEfforts: [{ reasoningEffort: "unbounded" }],
            defaultReasoningEffort: "unbounded",
            serviceTiers: [],
            defaultServiceTier: null,
            isDefault: false,
          },
        ],
        nextCursor: null,
      }),
    ).toThrow(CodexError);
  });

  test("parses bounded usage without accepting lossy integers", () => {
    expect(
      parseAccountUsage({
        summary: {
          lifetimeTokens: 42,
          peakDailyTokens: 12,
          longestRunningTurnSec: null,
          currentStreakDays: 3,
          longestStreakDays: 5,
        },
        dailyUsageBuckets: [{ startDate: "2026-08-22", tokens: 9 }],
      }),
    ).toEqual({
      summary: {
        lifetimeTokens: 42,
        peakDailyTokens: 12,
        longestRunningTurnSec: null,
        currentStreakDays: 3,
        longestStreakDays: 5,
      },
      dailyUsageBuckets: [{ startDate: "2026-08-22", tokens: 9 }],
    });
    expect(() =>
      parseAccountUsage({
        summary: {
          lifetimeTokens: Number.MAX_SAFE_INTEGER + 1,
          peakDailyTokens: null,
          longestRunningTurnSec: null,
          currentStreakDays: null,
          longestStreakDays: null,
        },
        dailyUsageBuckets: null,
      }),
    ).toThrow(CodexError);
  });

  test("parses the pinned paginated turn and item response envelopes", () => {
    const turn = {
      id: "turn-1",
      items: [],
      status: "completed" as const,
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
    };
    expect(parseThreadTurnsPage({ data: [turn], nextCursor: "older", backwardsCursor: "newer" }))
      .toEqual({ data: [turn], nextCursor: "older", backwardsCursor: "newer" });
    expect(parseThreadItemsPage({
      data: [
        { turnId: "turn-1", item: { type: "userMessage", id: "item-user", clientId: "client-exact", content: [{ type: "text", text: "hello" }] } },
        { turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello" } },
      ],
      nextCursor: null,
      backwardsCursor: "back",
    })).toEqual({
      data: [
        { turnId: "turn-1", item: { type: "userMessage", id: "item-user", clientId: "client-exact", text: ["hello"] } },
        { turnId: "turn-1", item: { type: "agentMessage", id: "item-1", text: "hello" } },
      ],
      nextCursor: null,
      backwardsCursor: "back",
    });
  });

  test("normalizes pinned Codex thread epoch seconds to milliseconds", () => {
    const createdAtSeconds = 1_900_000_000;
    const updatedAtSeconds = 1_900_000_123;
    const providerThread = {
      id: "thread-1",
      sessionId: "thread-1",
      preview: "hello",
      ephemeral: false,
      historyMode: "paginated",
      modelProvider: "openai",
      createdAt: createdAtSeconds,
      updatedAt: updatedAtSeconds,
      status: { type: "idle" },
      cwd: "/workspace",
      name: null,
      turns: [],
    };
    const page = parseThreadPage({
      data: [providerThread],
      nextCursor: null,
      backwardsCursor: null,
    });

    expect(page.data[0]).toMatchObject({
      createdAt: createdAtSeconds * 1_000,
      updatedAt: updatedAtSeconds * 1_000,
      providerTimestampUnit: "unix_milliseconds_v1",
    });
    fc.assert(fc.property(fc.integer({ min: 0, max: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) }), (seconds) => {
      const parsed = parseThreadMetadataRead({ thread: { ...providerThread, updatedAt: seconds } });
      expect(parsed.providerTimestampUnit).toBe("unix_milliseconds_v1");
      expect(parsed.updatedAt).toBe(seconds * 1_000);
      expect(Number.isSafeInteger(parsed.updatedAt)).toBe(true);
    }));
    for (const invalidCreatedAt of [-1, 1.5, Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1]) {
      expect(() => parseThreadPage({
        data: [{ ...providerThread, createdAt: invalidCreatedAt }],
        nextCursor: null,
        backwardsCursor: null,
      })).toThrow(CodexError);
    }
  });

  test("rejects provider turns at the metadata-only thread boundary", () => {
    expect(() => parseThreadMetadataRead({ thread: { turns: [{}] } })).toThrow(CodexError);
  });
});
