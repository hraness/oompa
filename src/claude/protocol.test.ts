import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { ClaudeError } from "./errors";
import {
  CLAUDE_PIN,
  CLAUDE_PIN_MODEL,
  PINNED_CLAUDE_ARTIFACT_DIGESTS,
  PINNED_CLAUDE_EVIDENCE_DIGESTS,
  PINNED_CLAUDE_MATRIX_DIGESTS,
} from "./pin";
import {
  assertPinnedClaudeMatrices,
  assertPinnedClaudeModel,
  assertPinnedClaudeVersion,
  boundClaudeText,
  claudeAnswerMap,
  claudeCommandClass,
  claudeControlResponse,
  claudeControlResponseLine,
  claudeInteractionDisplay,
  claudeInteractionKind,
  claudeMatrixDigest,
  claudeUserLine,
  CLAUDE_RATE_LIMIT_WINDOW_LIMIT,
  CLAUDE_RESULT_MODEL_LIMIT,
  parseClaudeStreamLine,
  sanitizeClaudeText,
  PINNED_CLAUDE_CONTROL_REQUEST_MATRIX,
  PINNED_CLAUDE_STREAM_MATRIX,
  type ClaudeCanUseTool,
  type ClaudeStreamEvent,
} from "./protocol";

const fixtureDirectory = join(import.meta.dir, "..", "..", "docs", "providers", "claude-fixtures");

/**
 * Fixtures are stored as `.jsonl.txt` because the package policy admits only
 * reviewed text extensions. Each line is one captured stream-json object.
 */
const readFixture = async (name: string): Promise<readonly unknown[]> => {
  const text = await Bun.file(join(fixtureDirectory, `${name}.jsonl.txt`)).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
};

const parseFixture = async (name: string): Promise<readonly ClaudeStreamEvent[]> =>
  (await readFixture(name)).map(parseClaudeStreamLine);

const canUseTool = (event: ClaudeStreamEvent): ClaudeCanUseTool => {
  if (event.type !== "control_request") throw new Error("expected a control request");
  return event.request;
};

describe("Claude pin", () => {
  test("retains exact artifact evidence for the reviewed host-tool flags", async () => {
    const fixture = await Bun.file(join(fixtureDirectory, "cli-host-tools-2.1.260.txt")).text();
    expect(createHash("sha256").update(fixture).digest("hex"))
      .toBe(PINNED_CLAUDE_EVIDENCE_DIGESTS.hostToolHelp);
    expect(fixture).toContain(`Wrapper tarball SHA-256: ${PINNED_CLAUDE_ARTIFACT_DIGESTS.wrapperPackage}`);
    expect(fixture).toContain(`Native tarball SHA-256: ${PINNED_CLAUDE_ARTIFACT_DIGESTS.nativePackage}`);
    expect(fixture).toContain(`Native executable SHA-256: ${PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable}`);
    expect(fixture).toContain("--append-system-prompt <prompt>");
    expect(fixture).toContain("--mcp-config <configs...>");
    expect(fixture).toContain("--strict-mcp-config");
    expect(fixture).toContain("--system-prompt-snapshot <on|off>");
    expect(fixture).toContain("--append-system-prompt turns it off so");
    expect(fixture).toContain("is ignored until compaction");
  });

  test("admits only the reviewed version, model, and effort", () => {
    expect(() => { assertPinnedClaudeVersion(CLAUDE_PIN); }).not.toThrow();
    expect(() => { assertPinnedClaudeVersion("2.1.259"); }).toThrow(ClaudeError);
    expect(() => { assertPinnedClaudeModel(CLAUDE_PIN_MODEL, "max"); }).not.toThrow();
    expect(() => { assertPinnedClaudeModel("claude-fable-5", "max"); }).toThrow(ClaudeError);
    // "max without ultracode": ultracode is a real effort Oompa never requests.
    expect(() => { assertPinnedClaudeModel(CLAUDE_PIN_MODEL, "ultracode"); }).toThrow(
      "never requests the `ultracode` reasoning effort",
    );
    expect(() => { assertPinnedClaudeModel(CLAUDE_PIN_MODEL, "high"); }).toThrow(ClaudeError);
  });

  test("fails closed when the reviewed event matrix drifts", () => {
    expect(() => { assertPinnedClaudeMatrices(); }).not.toThrow();
    expect(claudeMatrixDigest(CLAUDE_PIN, PINNED_CLAUDE_STREAM_MATRIX))
      .toBe(PINNED_CLAUDE_MATRIX_DIGESTS.streamEvent);
    expect(claudeMatrixDigest(CLAUDE_PIN, PINNED_CLAUDE_CONTROL_REQUEST_MATRIX))
      .toBe(PINNED_CLAUDE_MATRIX_DIGESTS.controlRequest);
    expect(claudeMatrixDigest("2.1.259", PINNED_CLAUDE_STREAM_MATRIX))
      .not.toBe(PINNED_CLAUDE_MATRIX_DIGESTS.streamEvent);
    expect(claudeMatrixDigest(CLAUDE_PIN, { ...PINNED_CLAUDE_STREAM_MATRIX, assistant: "ignored" }))
      .not.toBe(PINNED_CLAUDE_MATRIX_DIGESTS.streamEvent);
  });
});

describe("Claude stream-json fixtures", () => {
  test("parses every line of the captured single turn", async () => {
    const events = await parseFixture("stream-json-single-turn");
    expect(events.map((event) => event.type)).toEqual([
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "ignored",
      "session_init",
      "assistant_message",
      "rate_limit",
      "result",
    ]);
    const init = events[6];
    if (init?.type !== "session_init") throw new Error("expected session_init");
    expect(init.model).toBe(CLAUDE_PIN_MODEL);
    expect(init.permissionMode).toBe("default");
    expect(init.claudeVersion).toMatch(/^\d+\.\d+\.\d+$/u);
    expect(init.sessionId).toBe("726b1b3d-ed97-4b55-9904-e58fa7d7eb45");

    const assistant = events[7];
    if (assistant?.type !== "assistant_message") throw new Error("expected assistant_message");
    expect(assistant.text).toBe("ok");
    expect(assistant.thinking).toBe("");
    expect(assistant.parentToolUseId).toBeNull();

    const rateLimit = events[8];
    if (rateLimit?.type !== "rate_limit") throw new Error("expected rate_limit");
    expect(rateLimit.eventId).toBe("bee4e95a-9a7d-4f23-a5d2-a50045b22dec");
    expect(rateLimit.quota).toEqual({
      isUsingOverage: false,
      overageDisabledReason: "org_level_disabled",
      overageStatus: "rejected",
      rateLimitType: "five_hour",
      resetsAtMs: 1_788_499_800_000,
      status: { state: "known", value: "allowed" },
      windows: [
        { id: "five_hour", resetsAtMs: 1_788_499_800_000, usedPercent: 50 },
        { id: "seven_day", resetsAtMs: 1_788_908_400_000, usedPercent: 30 },
        {
          id: "seven_day_overage_included",
          resetsAtMs: 1_788_908_400_000,
          usedPercent: 60,
        },
      ],
    });
    expect(rateLimit.sourceEventDigest).toMatch(/^[0-9a-f]{64}$/u);

    const result = events[9];
    if (result?.type !== "result") throw new Error("expected result");
    expect(result.isError).toBe(false);
    expect(result.stopReason).toBe("end_turn");
    expect(result.terminalReason).toBe("completed");
    expect(result.model).toBe("claude-fable-5-1");
    expect(result.usage.inputTokens).toBe(2);
    expect(result.usage.outputTokens).toBe(4);
    expect(result.usage.cachedInputTokens).toBe(11_059 + 10_123);
    expect(result.accounting).toEqual({
      models: [{
        cacheCreationInputTokens: 11_059,
        cacheReadInputTokens: 10_123,
        contextWindow: 1_000_000,
        costUsd: 0.22393074999999998,
        inputTokens: 2,
        maxOutputTokens: 64_000,
        model: "claude-fable-5-1",
        outputTokens: 4,
        thinkingTokens: 0,
      }],
      tokens: {
        cacheCreationInputTokens: 11_059,
        cacheReadInputTokens: 10_123,
        inputTokens: 2,
        outputTokens: 4,
        thinkingTokens: 0,
      },
      totalCostUsd: 0.22393074999999998,
    });
    expect(result.sourceEventDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("classifies the authenticated and unauthenticated result envelopes", async () => {
    const [authenticated] = await parseFixture("output-json-authenticated");
    if (authenticated?.type !== "result") throw new Error("expected result");
    expect(authenticated.isError).toBe(false);
    expect(authenticated.terminalReason).toBe("completed");
    expect(authenticated.resultText).toBe("ok");
    expect(authenticated.model).toBe("claude-fable-5-1");

    const [unauthenticated] = await parseFixture("output-json-unauthenticated");
    if (unauthenticated?.type !== "result") throw new Error("expected result");
    // The CLI's outer envelope still says `subtype: "success"`; only
    // `is_error` and `terminal_reason` classify the failure.
    expect(unauthenticated.isError).toBe(true);
    expect(unauthenticated.terminalReason).toBe("api_error");
    expect(unauthenticated.resultText).toContain("Not logged in");
    expect(unauthenticated.usage.outputTokens).toBe(0);
  });

  test("parses the recorded control protocol and subagent events", async () => {
    const events = await parseFixture("bb-control-protocol-examples");
    expect(events.map((event) => event.type)).toEqual([
      "control_request",
      "ignored",
      "control_request",
      "ignored",
      "control_request",
      "ignored",
      "task_started",
      "task_progress",
      "task_updated",
      "task_notification",
    ]);

    const bashAllow = canUseTool(events[0] as ClaudeStreamEvent);
    expect(bashAllow.toolName).toBe("Bash");
    expect(bashAllow.requiresUserInteraction).toBe(false);
    expect(bashAllow.permissionSuggestionCount).toBe(1);
    expect(bashAllow.blockedPath).toBeNull();

    const bashDeny = canUseTool(events[2] as ClaudeStreamEvent);
    expect(bashDeny.blockedPath).not.toBeNull();

    const question = canUseTool(events[4] as ClaudeStreamEvent);
    expect(question.toolName).toBe("AskUserQuestion");
    expect(question.requiresUserInteraction).toBe(true);
    expect(question.questions).toEqual([
      {
        header: "Indent",
        multiSelect: false,
        options: [
          { description: "Indent with tab characters", label: "tabs" },
          { description: "Indent with space characters", label: "spaces" },
        ],
        question: "Tabs or spaces?",
      },
    ]);

    const started = events[6];
    if (started?.type !== "task_started") throw new Error("expected task_started");
    expect(started.subagentType).toBe("Explore");
    expect(started.spawnDepth).toBe(1);
    expect(started.toolUseId).toBe("toolu_01RNa8dUfBrdgn5ocMFVqkSN");

    const progress = events[7];
    if (progress?.type !== "task_progress") throw new Error("expected task_progress");
    expect(progress.lastToolName).toBe("Bash");
    expect(progress.totalTokens).toBe(12_851);

    const updated = events[8];
    if (updated?.type !== "task_updated") throw new Error("expected task_updated");
    expect(updated.status).toBe("completed");

    const notification = events[9];
    if (notification?.type !== "task_notification") throw new Error("expected task_notification");
    expect(notification.status).toBe("completed");
  });

  test("parses the captured /compact steering sequence", async () => {
    const events = await parseFixture("stream-json-compaction-2.1.270");
    expect(events.map((event) => event.type)).toEqual([
      "session_init",
      "status",
      "compact_boundary",
      "status",
      "session_init",
      "status",
      "status",
    ]);
    const compacting = events[1];
    if (compacting?.type !== "status") throw new Error("expected status");
    expect(compacting).toEqual({
      compactError: null,
      compactResult: null,
      sessionId: "5d0c2f2a-9a2b-4f6b-8d7c-1f2e3d4c5b6a",
      status: "compacting",
      type: "status",
    });
    const boundary = events[2];
    if (boundary?.type !== "compact_boundary") throw new Error("expected compact_boundary");
    expect(boundary).toEqual({
      postTokens: 2_091,
      preTokens: 25_920,
      sessionId: "5d0c2f2a-9a2b-4f6b-8d7c-1f2e3d4c5b6a",
      trigger: "manual",
      type: "compact_boundary",
    });
    const succeeded = events[3];
    if (succeeded?.type !== "status") throw new Error("expected status");
    expect(succeeded.compactResult).toBe("success");
    expect(succeeded.status).toBeNull();
    const failed = events[6];
    if (failed?.type !== "status") throw new Error("expected status");
    expect(failed.compactResult).toBe("failed");
    expect(failed.compactError).toBe("Not enough messages to compact.");
  });
});

const rateLimitLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  rate_limit_info: {
    isUsingOverage: false,
    overageDisabledReason: "org_level_disabled",
    overageStatus: "rejected",
    rateLimitType: "five_hour",
    resetsAt: 1_788_499_800,
    status: "allowed",
    unifiedWindows: {
      five_hour: { resetsAt: 1_788_499_800, utilization: 0.5 },
    },
  },
  session_id: "726b1b3d-ed97-4b55-9904-e58fa7d7eb45",
  type: "rate_limit_event",
  uuid: "bee4e95a-9a7d-4f23-a5d2-a50045b22dec",
  ...overrides,
});

const resultLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  duration_ms: 25,
  is_error: false,
  modelUsage: {
    "claude-fable-5-1": {
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 5,
      canonicalModel: "claude-fable-5-1",
      contextWindow: 1_000_000,
      costUSD: 0.25,
      inputTokens: 2,
      maxOutputTokens: 64_000,
      outputTokens: 7,
      thinkingTokens: 1,
    },
  },
  num_turns: 1,
  result: "ok",
  session_id: "726b1b3d-ed97-4b55-9904-e58fa7d7eb45",
  total_cost_usd: 0.25,
  type: "result",
  usage: {
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 5,
    input_tokens: 2,
    output_tokens: 7,
    output_tokens_details: { thinking_tokens: 1 },
  },
  uuid: "48c87f50-1645-4f71-a091-4949d337eb87",
  ...overrides,
});

describe("Claude usage observation parsing", () => {
  test("keeps the closed status set distinct and preserves bounded unknown codes", () => {
    for (const status of ["allowed", "warning", "blocked", "denied", "rejected"] as const) {
      const event = parseClaudeStreamLine(rateLimitLine({
        rate_limit_info: { status },
      }));
      if (event.type !== "rate_limit") throw new Error("expected rate_limit");
      expect(event.quota.status).toEqual({ state: "known", value: status });
      expect(event.quota.windows).toEqual([]);
      expect(event.quota.resetsAtMs).toBeNull();
    }
    const unknown = parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: { status: "provider_future_state" },
    }));
    if (unknown.type !== "rate_limit") throw new Error("expected rate_limit");
    expect(unknown.quota.status).toEqual({
      state: "unknown",
      value: "provider_future_state",
    });
    const maximum = "X".repeat(128);
    const bounded = parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: { status: maximum },
    }));
    if (bounded.type !== "rate_limit") throw new Error("expected rate_limit");
    expect(bounded.quota.status).toEqual({ state: "unknown", value: maximum });
  });

  test("normalizes ordering before deriving an exact source digest", () => {
    const first = parseClaudeStreamLine(rateLimitLine({
      extra: "discarded",
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          seven_day: { resetsAt: 1_788_908_400, utilization: 0.3 },
          five_hour: { resetsAt: 1_788_499_800, utilization: 0.5 },
        },
      },
    }));
    const reordered = parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: {
        ignored: true,
        status: "allowed",
        unifiedWindows: {
          five_hour: { resetsAt: 1_788_499_800, utilization: 0.5 },
          seven_day: { resetsAt: 1_788_908_400, utilization: 0.3 },
        },
      },
    }));
    if (first.type !== "rate_limit" || reordered.type !== "rate_limit") {
      throw new Error("expected rate_limit");
    }
    expect(first.quota.windows.map(({ id }) => id)).toEqual(["five_hour", "seven_day"]);
    expect(first.sourceEventDigest).toBe(reordered.sourceEventDigest);

    const changed = parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {
          five_hour: { resetsAt: 1_788_499_800, utilization: 0.6 },
          seven_day: { resetsAt: 1_788_908_400, utilization: 0.3 },
        },
      },
    }));
    if (changed.type !== "rate_limit") throw new Error("expected rate_limit");
    expect(changed.sourceEventDigest).not.toBe(first.sourceEventDigest);
  });

  test("keeps missing optional accounting fields explicitly null", () => {
    const event = parseClaudeStreamLine(resultLine({
      modelUsage: undefined,
      total_cost_usd: undefined,
      usage: undefined,
    }));
    if (event.type !== "result") throw new Error("expected result");
    expect(event.accounting).toEqual({
      models: [],
      tokens: {
        cacheCreationInputTokens: null,
        cacheReadInputTokens: null,
        inputTokens: null,
        outputTokens: null,
        thinkingTokens: null,
      },
      totalCostUsd: null,
    });
    expect(event.usage).toEqual({
      cachedInputTokens: 0,
      inputTokens: null,
      modelContextWindow: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: null,
    });
  });

  test("reduces malformed, ambiguous, and unbounded quota data to a notice", () => {
    const rateInfo = (window: Record<string, unknown>): Record<string, unknown> => ({
      status: "allowed",
      unifiedWindows: { five_hour: window },
    });
    for (const utilization of [Number.NaN, Number.POSITIVE_INFINITY, -0.01, 1.01]) {
      expect(parseClaudeStreamLine(rateLimitLine({
        rate_limit_info: rateInfo({ resetsAt: 1_788_499_800, utilization }),
      }))).toEqual({ event: "rate_limit_event/invalid", type: "protocol_notice" });
    }
    expect(parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: rateInfo({ resetsAt: 1_788_499_800_000, utilization: 0.5 }),
    }))).toEqual({ event: "rate_limit_event/invalid", type: "protocol_notice" });
    expect(parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: Object.fromEntries(
          Array.from({ length: CLAUDE_RATE_LIMIT_WINDOW_LIMIT + 1 }, (_, index) => [
            `window_${index}`,
            { resetsAt: 1_788_499_800, utilization: 0.5 },
          ]),
        ),
      },
    }))).toEqual({ event: "rate_limit_event/invalid", type: "protocol_notice" });
    expect(parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: { status: "x".repeat(129) },
    }))).toEqual({ event: "rate_limit_event/invalid", type: "protocol_notice" });
    expect(parseClaudeStreamLine(rateLimitLine({
      rate_limit_info: { status: "é".repeat(65) },
    }))).toEqual({ event: "rate_limit_event/invalid", type: "protocol_notice" });
  });

  test("drops malformed result accounting without erasing the terminal timeline", () => {
    const expectAccountingDrop = (
      line: Record<string, unknown>,
      expectedNeutralTotal = 17,
    ): void => {
      const event = parseClaudeStreamLine(line);
      if (event.type !== "result") throw new Error("expected result");
      expect(event.accounting).toBeNull();
      expect(event.eventId).toBeNull();
      expect(event.sourceEventDigest).toBeNull();
      expect(event.resultText).toBe("ok");
      expect(event.usage.totalTokens).toBe(expectedNeutralTotal);
    };
    expectAccountingDrop(resultLine({ total_cost_usd: Number.NaN }));
    expectAccountingDrop(resultLine({ uuid: "not-a-uuid" }));
    expectAccountingDrop(resultLine({
      usage: { input_tokens: -1 },
    }), -1);
    expectAccountingDrop(resultLine({
      modelUsage: {
        alias: {
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          canonicalModel: "different",
          contextWindow: 1,
          costUSD: 0,
          inputTokens: 0,
          maxOutputTokens: 1,
          outputTokens: 0,
          thinkingTokens: 0,
        },
      },
    }));
    expectAccountingDrop(resultLine({
      modelUsage: Object.fromEntries(
        Array.from({ length: CLAUDE_RESULT_MODEL_LIMIT + 1 }, (_, index) => [
          `model-${index}`,
          {},
        ]),
      ),
    }));
    const oversizedModel = "x".repeat(129);
    expectAccountingDrop(resultLine({
      modelUsage: {
        [oversizedModel]: { canonicalModel: oversizedModel },
      },
    }));
    expectAccountingDrop(resultLine({
      modelUsage: {
        model: { canonicalModel: "model", costUSD: -0.01 },
      },
    }));
    expectAccountingDrop(resultLine({
      modelUsage: {
        model: {
          canonicalModel: "model",
          inputTokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
    }));
  });

  test("preserves the existing neutral result metadata parser outside usage accounting", () => {
    const event = parseClaudeStreamLine(resultLine({
      duration_ms: -7,
      num_turns: -1,
    }));
    if (event.type !== "result") throw new Error("expected result");
    expect(event.durationMs).toBe(-7);
    expect(event.numTurns).toBe(-1);
    expect(event.accounting).not.toBeNull();
  });

  test("keeps absent per-model advisory fields null rather than inventing zero", () => {
    const event = parseClaudeStreamLine(resultLine({
      modelUsage: {
        "Claude.Model/VNext": { canonicalModel: "Claude.Model/VNext" },
      },
    }));
    if (event.type !== "result") throw new Error("expected result");
    expect(event.model).toBe("Claude.Model/VNext");
    expect(event.accounting?.models).toEqual([{
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      contextWindow: null,
      costUsd: null,
      inputTokens: null,
      maxOutputTokens: null,
      model: "Claude.Model/VNext",
      outputTokens: null,
      thinkingTokens: null,
    }]);
  });
});

describe("Claude event admission", () => {
  test("keeps Claude's own plumbing out of the Oompa model", () => {
    for (const subtype of ["hook_callback", "mcp_message", "set_permission_mode", "initialize"]) {
      expect(parseClaudeStreamLine({
        request: { subtype },
        request_id: "r1",
        type: "control_request",
      })).toEqual({ event: `control_request/${subtype}`, type: "ignored" });
    }
    expect(parseClaudeStreamLine({
      message: { content: "hi", role: "user" },
      type: "user",
    })).toEqual({ event: "user", type: "ignored" });
  });

  test("reports an unrecognised event as a bounded notice, not a fault", () => {
    expect(parseClaudeStreamLine({ type: "brand_new_event" }))
      .toEqual({ event: "brand_new_event", type: "protocol_notice" });
    expect(parseClaudeStreamLine({ subtype: "brand_new", type: "system" }))
      .toEqual({ event: "system/brand_new", type: "protocol_notice" });
    expect(parseClaudeStreamLine({ request: { subtype: "brand_new" }, request_id: "r", type: "control_request" }))
      .toEqual({ event: "control_request/brand_new", type: "protocol_notice" });
  });

  test("refuses a malformed envelope from unknown", () => {
    expect(() => parseClaudeStreamLine(null)).toThrow(ClaudeError);
    expect(() => parseClaudeStreamLine([])).toThrow(ClaudeError);
    expect(() => parseClaudeStreamLine({ type: 7 })).toThrow(ClaudeError);
    expect(() => parseClaudeStreamLine({ subtype: "init", type: "system" })).toThrow(ClaudeError);
  });

  test("assembles text and thinking deltas from partial messages", () => {
    expect(parseClaudeStreamLine({
      event: {
        delta: { text: "he", type: "text_delta" },
        index: 0,
        type: "content_block_delta",
      },
      parent_tool_use_id: null,
      session_id: "s",
      type: "stream_event",
    })).toEqual({
      block: "text",
      blockIndex: 0,
      parentToolUseId: null,
      sessionId: "s",
      text: "he",
      type: "content_delta",
    });
    expect(parseClaudeStreamLine({
      event: {
        delta: { thinking: "hm", type: "thinking_delta" },
        index: 1,
        type: "content_block_delta",
      },
      parent_tool_use_id: null,
      session_id: "s",
      type: "stream_event",
    })).toMatchObject({ block: "thinking", blockIndex: 1, text: "hm" });
    expect(parseClaudeStreamLine({
      event: { index: 0, type: "content_block_start" },
      session_id: "s",
      type: "stream_event",
    })).toEqual({ event: "stream_event/content_block_start", type: "ignored" });
  });
});

describe("Claude compaction event admission", () => {
  const sessionId = "5d0c2f2a-9a2b-4f6b-8d7c-1f2e3d4c5b6a";

  test("parses the status envelope's outcome fields in either spelling", () => {
    // The 2.1.x failure verdict rides on the status-clearing line itself.
    expect(parseClaudeStreamLine({
      compact_error: "Not enough messages to compact.",
      compact_result: "failed",
      session_id: sessionId,
      status: null,
      subtype: "status",
      type: "system",
    })).toEqual({
      compactError: "Not enough messages to compact.",
      compactResult: "failed",
      sessionId,
      status: null,
      type: "status",
    });
    // The dedicated subtype spelling the pinned build also emits.
    expect(parseClaudeStreamLine({
      compact_result: "success",
      session_id: sessionId,
      subtype: "compact_result",
      type: "system",
    })).toEqual({
      compactError: null,
      compactResult: "success",
      sessionId,
      type: "compact_result",
    });
    // A status with no compaction fields is a valid, uninteresting envelope.
    expect(parseClaudeStreamLine({
      session_id: sessionId,
      status: null,
      subtype: "status",
      type: "system",
    })).toEqual({
      compactError: null,
      compactResult: null,
      sessionId,
      status: null,
      type: "status",
    });
  });

  test("parses compact_boundary metadata in both recorded casings", () => {
    expect(parseClaudeStreamLine({
      compact_metadata: { pre_tokens: 25_920, trigger: "auto" },
      sessionId,
      subtype: "compact_boundary",
      type: "system",
    })).toEqual({
      postTokens: null,
      preTokens: 25_920,
      sessionId,
      trigger: "auto",
      type: "compact_boundary",
    });
    // The boundary itself is the signal; absent metadata stays explicitly null.
    expect(parseClaudeStreamLine({
      subtype: "compact_boundary",
      type: "system",
    })).toEqual({
      postTokens: null,
      preTokens: null,
      sessionId: null,
      trigger: null,
      type: "compact_boundary",
    });
  });

  test("degrades malformed compaction envelopes to bounded notices, never a fault", () => {
    const notices: Array<readonly [unknown, string]> = [
      [{ status: "has spaces", subtype: "status", type: "system" }, "system/status/invalid"],
      [{ status: 7, subtype: "status", type: "system" }, "system/status/invalid"],
      [
        { compact_result: "not a code", subtype: "status", type: "system" },
        "system/status/invalid",
      ],
      [
        { compact_error: { text: "x" }, subtype: "status", type: "system" },
        "system/status/invalid",
      ],
      [
        { status: "ok", subtype: "compact_result", type: "system" },
        "system/compact_result/invalid",
      ],
      [
        { compact_result: ["failed"], subtype: "compact_result", type: "system" },
        "system/compact_result/invalid",
      ],
      [
        { compactMetadata: "nope", subtype: "compact_boundary", type: "system" },
        "system/compact_boundary/invalid",
      ],
      [
        { compactMetadata: { preTokens: -1 }, subtype: "compact_boundary", type: "system" },
        "system/compact_boundary/invalid",
      ],
      [
        { compactMetadata: { trigger: "bad trigger" }, subtype: "compact_boundary", type: "system" },
        "system/compact_boundary/invalid",
      ],
    ];
    for (const [line, event] of notices) {
      expect(parseClaudeStreamLine(line)).toEqual({ event, type: "protocol_notice" });
    }
  });
});

// Composed, never spelled: the package policy refuses a literal absolute
// user path anywhere in published source.
const absoluteFixture = ["", "home", "someone", "project", "notes.md"].join("/");

const request = (overrides: Partial<ClaudeCanUseTool> = {}): ClaudeCanUseTool => ({
  blockedPath: null,
  decisionReasonType: null,
  description: null,
  displayName: "Bash",
  input: { command: "/bin/echo hi" },
  permissionSuggestionCount: 0,
  questions: null,
  requiresUserInteraction: false,
  subtype: "can_use_tool",
  toolName: "Bash",
  toolUseId: "toolu_1",
  ...overrides,
});

describe("can_use_tool mapping", () => {
  test("maps every tool onto the plan's interaction kind", () => {
    expect(claudeInteractionKind(request())).toBe("command_approval");
    for (const toolName of ["Edit", "Write", "NotebookEdit"]) {
      expect(claudeInteractionKind(request({ toolName }))).toBe("file_change_approval");
    }
    for (const toolName of ["WebFetch", "Read", "Task", "mcp__server__tool"]) {
      expect(claudeInteractionKind(request({ toolName }))).toBe("permission_approval");
    }
    expect(claudeInteractionKind(request({
      input: { questions: [] },
      questions: [],
      requiresUserInteraction: true,
      toolName: "AskUserQuestion",
    }))).toBe("user_input");
    // A request the runtime marks as needing a person wins over its tool name.
    expect(claudeInteractionKind(request({ requiresUserInteraction: true }))).toBe("user_input");
  });

  test("builds a bounded, sanitized display for each kind", () => {
    const command = claudeInteractionDisplay(request({
      description: "Echo",
      input: { command: "/bin/echo hi" },
    }));
    expect(command).toEqual({
      availableDecisions: ["once", "decline"],
      // The command line itself is never projected verbatim: only its
      // bounded class survives, and its absolute path is reduced.
      commandClass: "echo",
      kind: "command_approval",
      reason: "Echo",
      summary: "Bash: [local-path] hi",
      workingDirectory: null,
    });

    const fileChange = claudeInteractionDisplay(request({
      displayName: "Edit",
      input: { file_path: absoluteFixture },
      toolName: "Edit",
    }));
    expect(fileChange.kind).toBe("file_change_approval");
    // Absolute paths never reach a projection verbatim.
    expect(fileChange.summary).not.toContain(absoluteFixture);

    const permission = claudeInteractionDisplay(request({
      blockedPath: "/etc/hosts",
      displayName: "WebFetch",
      toolName: "WebFetch",
    }));
    if (permission.kind !== "permission_approval") throw new Error("expected permission approval");
    expect(permission.requested).toEqual([{ name: "WebFetch" }]);
    expect(permission.allowsSessionScope).toBe(false);

    const question = claudeInteractionDisplay(request({
      displayName: "AskUserQuestion",
      input: {},
      questions: [{
        header: "Indent",
        multiSelect: false,
        options: [
          { description: "Tabs", label: "tabs" },
          { description: "Spaces", label: "spaces" },
        ],
        question: "Tabs or spaces?",
      }],
      requiresUserInteraction: true,
      toolName: "AskUserQuestion",
    }));
    if (question.kind !== "user_input") throw new Error("expected user input");
    expect(question.questions).toEqual([{
      allowsOther: false,
      header: "Indent",
      id: "q0",
      options: [
        { description: "Tabs", label: "tabs" },
        { description: "Spaces", label: "spaces" },
      ],
      question: "Tabs or spaces?",
      remoteAnswerable: true,
      secret: false,
    }]);
  });

  test("withholds remote answer evidence when provider question text is lossy", () => {
    const rawQuestion = "é".repeat(3_000);
    const display = claudeInteractionDisplay(request({
      displayName: "AskUserQuestion",
      input: {},
      questions: [{
        header: "Region",
        multiSelect: false,
        options: [{ description: "Europe", label: "eu" }],
        question: rawQuestion,
      }],
      requiresUserInteraction: true,
      toolName: "AskUserQuestion",
    }));
    if (display.kind !== "user_input") throw new Error("expected user input");
    expect(display.questions[0]?.question).not.toBe(rawQuestion);
    expect(display.questions[0]?.remoteAnswerable).toBeUndefined();
  });

  test("classifies commands without ever projecting the command line", () => {
    expect(claudeCommandClass("/usr/bin/git status")).toBe("git");
    expect(claudeCommandClass("curl -sI https://example.com | head -n 1")).toBe("curl");
    expect(claudeCommandClass("")).toBe("command");
    expect(claudeCommandClass("$(evil)")).toBe("command");
  });
});

describe("control responses", () => {
  test("an allow echoes only the request's own input", () => {
    const allow = claudeControlResponse(request(), { kind: "allow" });
    expect(allow).toEqual({
      behavior: "allow",
      toolUseID: "toolu_1",
      updatedInput: { command: "/bin/echo hi" },
    });
    // No `permission_suggestions` rule is ever echoed back, so Oompa can grant
    // nothing beyond this one tool use.
    expect(JSON.stringify(allow)).not.toContain("permission_suggestions");
  });

  test("a deny carries a bounded message and no updated input", () => {
    const deny = claudeControlResponse(request(), { kind: "deny", message: "Permission request denied" });
    expect(deny).toEqual({
      behavior: "deny",
      message: "Permission request denied",
      toolUseID: "toolu_1",
    });
  });

  test("an answer folds the answers map into updatedInput keyed by question text", () => {
    const asked = request({
      input: { questions: [{ header: "Indent", question: "Tabs or spaces?" }] },
      questions: [{
        header: "Indent",
        multiSelect: false,
        options: [{ description: "", label: "tabs" }, { description: "", label: "spaces" }],
        question: "Tabs or spaces?",
      }],
      requiresUserInteraction: true,
      toolName: "AskUserQuestion",
    });
    const answered = claudeControlResponse(asked, { answers: { q0: "spaces" }, kind: "answer" });
    if (answered.behavior !== "allow") throw new Error("expected allow");
    expect(answered.updatedInput.answers).toEqual({ "Tabs or spaces?": "spaces" });
    expect(claudeAnswerMap(asked, { q0: "tabs" })).toEqual({ "Tabs or spaces?": "tabs" });
    expect(() => claudeAnswerMap(asked, { q0: "not-an-option" })).toThrow(ClaudeError);
    expect(() => claudeAnswerMap(asked, {})).toThrow(ClaudeError);
    expect(() => claudeAnswerMap(asked, { extra: "tabs", q0: "tabs" })).toThrow(ClaudeError);
  });

  test("refuses structurally ambiguous answer maps and preserves prototype-shaped questions", () => {
    const baseQuestion = {
      header: "Choice",
      multiSelect: false,
      options: [{ description: "Safe", label: "yes" }],
      question: "Continue?",
    } as const;
    expect(() => claudeAnswerMap(request({
      questions: [baseQuestion, baseQuestion],
    }), { q0: "yes", q1: "yes" })).toThrow(ClaudeError);
    expect(() => claudeAnswerMap(request({
      questions: [{ ...baseQuestion, multiSelect: true }],
    }), { q0: "yes" })).toThrow(ClaudeError);

    const mapped = claudeAnswerMap(request({
      questions: [{ ...baseQuestion, question: "__proto__" }],
    }), { q0: "yes" });
    expect(Object.keys(mapped)).toEqual(["__proto__"]);
    expect(mapped.__proto__).toBe("yes");
  });

  test("writes exactly one newline-terminated JSON line", () => {
    const line = claudeControlResponseLine("req-1", claudeControlResponse(request(), { kind: "allow" }));
    expect(line.endsWith("\n")).toBe(true);
    expect(line.split("\n").filter((value) => value.length > 0)).toHaveLength(1);
    expect(JSON.parse(line) as unknown).toEqual({
      response: {
        request_id: "req-1",
        response: {
          behavior: "allow",
          toolUseID: "toolu_1",
          updatedInput: { command: "/bin/echo hi" },
        },
        subtype: "success",
      },
      type: "control_response",
    });
    expect(JSON.parse(claudeUserLine("go on")) as unknown).toEqual({
      message: { content: [{ text: "go on", type: "text" }], role: "user" },
      type: "user",
    });
  });
});

describe("provider text safety", () => {
  test("reduces paths, protects secrets, and folds unsafe scalars", () => {
    expect(sanitizeClaudeText(absoluteFixture)).not.toContain("someone");
    expect(sanitizeClaudeText("token: abcdefghijklmnop")).toContain("[protected]");
    expect(sanitizeClaudeText("ab")).toBe("a�b");
    expect(sanitizeClaudeText(
      `a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c`,
    )).toBe("a�b�c");
    expect(sanitizeClaudeText("line\nline", true)).toBe("line\nline");
  });

  test("bounds text on scalar boundaries", () => {
    expect(boundClaudeText("héllo", 3)).toBe("hé");
    expect(boundClaudeText("abc", 32)).toBe("abc");
  });
});
