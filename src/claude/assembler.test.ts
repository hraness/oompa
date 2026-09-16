import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  CLAUDE_USAGE_EVENTS_PER_TURN_LIMIT,
  ClaudeDeltaAssembler,
  type ClaudeFact,
} from "./assembler";
import { ClaudeError } from "./errors";
import { parseClaudeStreamLine } from "./protocol";

const fixtureDirectory = join(import.meta.dir, "..", "..", "docs", "providers", "claude-fixtures");

const fixtureFacts = async (
  name: string,
  assembler: ClaudeDeltaAssembler,
): Promise<readonly ClaudeFact[]> => {
  const text = await Bun.file(join(fixtureDirectory, `${name}.jsonl.txt`)).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => [...assembler.apply(parseClaudeStreamLine(JSON.parse(line) as unknown))]);
};

const bootstrap = (assembler: ClaudeDeltaAssembler, sessionId = "s"): void => {
  assembler.apply(parseClaudeStreamLine({
    claude_code_version: "2.1.260",
    model: "claude-fable-5-1",
    permissionMode: "default",
    session_id: sessionId,
    subtype: "init",
    tools: [],
    type: "system",
  }));
};

describe("Claude delta assembler", () => {
  test("assembles the captured single turn into Oompa facts", async () => {
    const assembler = new ClaudeDeltaAssembler();
    const started = assembler.beginTurn("turn-1");
    expect(started).toEqual([{ turnId: "turn-1", type: "turnStarted" }]);
    expect(assembler.activeTurnId).toBe("turn-1");

    const facts = await fixtureFacts("stream-json-single-turn", assembler);
    expect(facts.map((fact) => fact.type)).toEqual([
      "sessionBootstrapped",
      "assistantDelta",
      "rateLimitObserved",
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
      "usageAccountingObserved",
    ]);
    expect(facts[0]).toMatchObject({
      model: "claude-fable-5-1",
      permissionMode: "default",
      type: "sessionBootstrapped",
    });
    expect(facts[1]).toMatchObject({ text: "ok", turnId: "turn-1", type: "assistantDelta" });
    expect(facts[2]).toMatchObject({
      observationRevision: 1,
      quota: { status: { state: "known", value: "allowed" } },
      sourceEventId: "bee4e95a-9a7d-4f23-a5d2-a50045b22dec",
      turnId: "turn-1",
      type: "rateLimitObserved",
    });
    expect(facts[6]).toMatchObject({
      accounting: { totalCostUsd: 0.22393074999999998 },
      observationRevision: 1,
      sourceEventId: "48c87f50-1645-4f71-a091-4949d337eb87",
      turnId: "turn-1",
      type: "usageAccountingObserved",
    });
    expect(facts[4]).toEqual({ status: "completed", turnId: "turn-1", type: "turnCompleted" });
    expect(facts[5]).toMatchObject({
      resultText: "ok",
      status: "completed",
      stopReason: "end_turn",
      terminalReason: "completed",
      turnId: "turn-1",
      type: "turnSummary",
    });
    // The `result` line is the turn boundary, so the turn is over.
    expect(assembler.activeTurnId).toBeNull();
    expect(assembler.providerSessionId).toBe("726b1b3d-ed97-4b55-9904-e58fa7d7eb45");
  });

  test("classifies an unauthenticated result as a failed turn with a bounded error", async () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    bootstrap(assembler, "3ab362ae-4119-4012-aee7-05f6e96682a2");
    const facts = await fixtureFacts("output-json-unauthenticated", assembler);
    expect(facts.map((fact) => fact.type)).toEqual([
      "tokenUsageUpdated",
      "providerError",
      "turnCompleted",
      "turnSummary",
      "usageAccountingObserved",
    ]);
    expect(facts[1]).toMatchObject({ code: "api_error", terminal: false, type: "providerError" });
    expect(facts[2]).toMatchObject({ status: "failed" });
  });

  test("marks an interrupted turn even when Claude reports success", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    bootstrap(assembler);
    assembler.markInterrupted();
    const facts = assembler.apply(parseClaudeStreamLine({
      duration_ms: 12,
      is_error: false,
      num_turns: 1,
      result: "stopped",
      session_id: "s",
      stop_reason: "end_turn",
      terminal_reason: "completed",
      type: "result",
      usage: {},
      uuid: "00000000-0000-4000-8000-000000000001",
    }));
    expect(facts.find((fact) => fact.type === "turnCompleted")).toEqual({
      status: "interrupted",
      turnId: "turn-1",
      type: "turnCompleted",
    });
  });

  test("projects subagent activity from the recorded task events", async () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    const facts = await fixtureFacts("bb-control-protocol-examples", assembler);
    const subagents = facts.filter((fact) => fact.type === "subagentActivity");
    expect(subagents.map((fact) => fact.activity)).toEqual([
      "started",
      "interacted",
      "interacted",
      "interacted",
    ]);
    expect(subagents[0]).toMatchObject({
      depth: 1,
      itemId: "toolu_01RNa8dUfBrdgn5ocMFVqkSN",
      nickname: "Read README first line",
      role: "Explore",
      taskId: "a5fb5e66c43a1adcd",
      turnId: "turn-1",
    });
    // Every recorded control request became an interaction with its mapped kind.
    expect(facts.filter((fact) => fact.type === "interactionRequested").map((fact) => fact.kind))
      .toEqual(["command_approval", "command_approval", "user_input"]);
  });

  test("routes a subagent's own message to activity, never the parent transcript", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    assembler.apply(parseClaudeStreamLine({
      description: "Read README first line",
      is_backgrounded: false,
      session_id: "s",
      spawn_depth: 1,
      subagent_type: "Explore",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_parent",
      type: "system",
    }));
    const facts = assembler.apply(parseClaudeStreamLine({
      message: {
        content: [{ text: "subagent said this", type: "text" }],
        id: "msg_1",
        model: "claude-fable-5-1",
        role: "assistant",
        type: "message",
      },
      parent_tool_use_id: "toolu_parent",
      session_id: "s",
      type: "assistant",
    }));
    expect(facts).toEqual([{
      activity: "interacted",
      depth: 1,
      itemId: "toolu_parent",
      nickname: "Read README first line",
      role: "Explore",
      taskId: "task-1",
      turnId: "turn-1",
      type: "subagentActivity",
    }]);
    expect(JSON.stringify(facts)).not.toContain("subagent said this");
  });

  test("marks a killed subagent as interrupted", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    assembler.apply(parseClaudeStreamLine({
      description: "d",
      session_id: "s",
      spawn_depth: 1,
      subagent_type: "Explore",
      subtype: "task_started",
      task_id: "task-1",
      tool_use_id: "toolu_parent",
      type: "system",
    }));
    const facts = assembler.apply(parseClaudeStreamLine({
      patch: { status: "killed" },
      session_id: "s",
      subtype: "task_updated",
      task_id: "task-1",
      type: "system",
    }));
    expect(facts[0]).toMatchObject({ activity: "interrupted", status: "killed" });
  });

  test("separates thinking from assistant text", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    const facts = assembler.apply(parseClaudeStreamLine({
      message: {
        content: [
          { thinking: "weighing options", type: "thinking" },
          { text: "done", type: "text" },
        ],
        id: "msg_1",
        model: "claude-fable-5-1",
        role: "assistant",
        type: "message",
      },
      parent_tool_use_id: null,
      session_id: "s",
      type: "assistant",
    }));
    expect(facts).toEqual([
      { itemId: "msg_1", summaryIndex: 0, text: "weighing options", turnId: "turn-1", type: "reasoningSummaryDelta" },
      { itemId: "msg_1", text: "done", turnId: "turn-1", type: "assistantDelta" },
    ]);
  });

  test("refuses a second in-flight turn and ends an abandoned one exactly once", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    expect(() => assembler.beginTurn("turn-2")).toThrow(ClaudeError);
    expect(assembler.abandonTurn("the Claude stream ended").map((fact) => fact.type))
      .toEqual(["providerError", "turnCompleted"]);
    expect(assembler.abandonTurn("again")).toEqual([]);
    expect(() => assembler.beginTurn("turn-2")).not.toThrow();
  });

  test("drops every event that arrives outside a turn", () => {
    const assembler = new ClaudeDeltaAssembler();
    expect(assembler.apply(parseClaudeStreamLine({
      message: { content: [{ text: "stray", type: "text" }], id: "m", role: "assistant", type: "message" },
      parent_tool_use_id: null,
      session_id: "s",
      type: "assistant",
    }))).toEqual([]);
    expect(assembler.apply(parseClaudeStreamLine({
      rate_limit_info: {
        status: "allowed",
        unifiedWindows: {},
      },
      session_id: "s",
      type: "rate_limit_event",
      uuid: "00000000-0000-4000-8000-000000000002",
    }))).toEqual([{
      event: "rate_limit_event/outside_turn",
      type: "protocolNotice",
    }]);
  });

  test("assigns quota revisions synchronously and replays an exact event idempotently", () => {
    let now = 100;
    const assembler = new ClaudeDeltaAssembler({ now: () => now++ });
    assembler.beginTurn("turn-1");
    bootstrap(assembler);
    const event = parseClaudeStreamLine({
      rate_limit_info: {
        status: "warning",
        unifiedWindows: {
          five_hour: { resetsAt: 1_788_499_800, utilization: 0.99 },
        },
      },
      session_id: "s",
      type: "rate_limit_event",
      uuid: "00000000-0000-4000-8000-000000000003",
    });
    const first = assembler.apply(event);
    const replay = assembler.apply(event);
    expect(first).toEqual(replay);
    expect(first[0]).toMatchObject({
      observationRevision: 1,
      observedAt: 100,
      quota: { status: { state: "known", value: "warning" } },
      receivedAt: 100,
      turnId: "turn-1",
      type: "rateLimitObserved",
    });

    const next = assembler.apply(parseClaudeStreamLine({
      rate_limit_info: { status: "blocked", unifiedWindows: {} },
      session_id: "s",
      type: "rate_limit_event",
      uuid: "00000000-0000-4000-8000-000000000004",
    }));
    expect(next[0]).toMatchObject({
      observationRevision: 2,
      observedAt: 101,
      receivedAt: 101,
      type: "rateLimitObserved",
    });

    assembler.abandonTurn("test boundary");
    assembler.beginTurn("turn-2");
    // The provider session remains pinned across turns.
    expect(assembler.apply(event)[0]).toMatchObject({
      observationRevision: 1,
      observedAt: 102,
      receivedAt: 102,
      turnId: "turn-2",
    });
  });

  test("drops a conflicting duplicate and bounds retained quota event identity", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    bootstrap(assembler);
    const firstLine = {
      rate_limit_info: { status: "allowed", unifiedWindows: {} },
      session_id: "s",
      type: "rate_limit_event",
      uuid: "00000000-0000-4000-8000-000000000005",
    };
    assembler.apply(parseClaudeStreamLine(firstLine));
    expect(assembler.apply(parseClaudeStreamLine({
      ...firstLine,
      rate_limit_info: { status: "denied", unifiedWindows: {} },
    }))).toEqual([{
      event: "rate_limit_event/conflicting_duplicate",
      type: "protocolNotice",
    }]);

    const bounded = new ClaudeDeltaAssembler();
    bounded.beginTurn("turn-bounded");
    bootstrap(bounded);
    let lastFacts: readonly ClaudeFact[] = [];
    for (let index = 0; index <= CLAUDE_USAGE_EVENTS_PER_TURN_LIMIT; index += 1) {
      lastFacts = bounded.apply(parseClaudeStreamLine({
        rate_limit_info: { status: "allowed", unifiedWindows: {} },
        session_id: "s",
        type: "rate_limit_event",
        uuid: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      }));
    }
    expect(lastFacts).toEqual([{
      event: "rate_limit_event/observation_limit",
      type: "protocolNotice",
    }]);
  });

  test("keeps a malformed accounting advisory from erasing turn completion", () => {
    const assembler = new ClaudeDeltaAssembler();
    assembler.beginTurn("turn-1");
    bootstrap(assembler);
    const facts = assembler.apply(parseClaudeStreamLine({
      duration_ms: 12,
      is_error: false,
      modelUsage: { model: { canonicalModel: "different" } },
      num_turns: 1,
      result: "ok",
      session_id: "s",
      total_cost_usd: Number.NaN,
      type: "result",
      usage: { input_tokens: 2, output_tokens: 4 },
      uuid: "not-a-uuid",
    }));
    expect(facts.map((fact) => fact.type)).toEqual([
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
      "protocolNotice",
    ]);
    expect(facts[3]).toEqual({ event: "result/accounting_invalid", type: "protocolNotice" });
    expect(facts[1]).toEqual({ status: "completed", turnId: "turn-1", type: "turnCompleted" });
    expect(assembler.activeTurnId).toBeNull();
  });

  test("does not correlate quota or results from a different provider session", () => {
    const assembler = new ClaudeDeltaAssembler({ now: () => 123 });
    assembler.beginTurn("turn-1");
    bootstrap(assembler, "session-one");
    const mismatchedRate = parseClaudeStreamLine({
      rate_limit_info: { status: "allowed", unifiedWindows: {} },
      session_id: "session-two",
      type: "rate_limit_event",
      uuid: "00000000-0000-4000-8000-000000000006",
    });
    expect(assembler.apply(mismatchedRate)).toEqual([{
      event: "rate_limit_event/session_mismatch",
      type: "protocolNotice",
    }]);
    expect(assembler.apply(parseClaudeStreamLine({
      rate_limit_info: { status: "allowed", unifiedWindows: {} },
      session_id: "session-one",
      type: "rate_limit_event",
      uuid: "00000000-0000-4000-8000-000000000007",
    }))[0]).toMatchObject({ observationRevision: 1, observedAt: 123 });

    const result = (sessionId: string, uuid: string) => parseClaudeStreamLine({
      duration_ms: 1,
      is_error: false,
      modelUsage: {},
      num_turns: 1,
      result: "ok",
      session_id: sessionId,
      type: "result",
      usage: {},
      uuid,
    });
    expect(assembler.apply(result(
      "session-two",
      "00000000-0000-4000-8000-000000000008",
    ))).toEqual([{ event: "result/session_mismatch", type: "protocolNotice" }]);
    expect(assembler.activeTurnId).toBe("turn-1");
    expect(assembler.apply(result(
      "session-one",
      "00000000-0000-4000-8000-000000000009",
    )).map((fact) => fact.type)).toEqual([
      "tokenUsageUpdated",
      "turnCompleted",
      "turnSummary",
      "usageAccountingObserved",
    ]);
  });
});

describe("Claude compaction facts", () => {
  const statusLine = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    session_id: "s",
    subtype: "status",
    type: "system",
    ...overrides,
  });

  test("assembles the captured compaction sequence, one fact per signal", async () => {
    const assembler = new ClaudeDeltaAssembler();
    const facts = await fixtureFacts("stream-json-compaction-2.1.270", assembler);
    expect(facts).toEqual([
      {
        claudeVersion: "2.1.270",
        model: "claude-fable-5-1",
        permissionMode: "default",
        providerSessionId: "5d0c2f2a-9a2b-4f6b-8d7c-1f2e3d4c5b6a",
        type: "sessionBootstrapped",
      },
      { outcome: "started", type: "compaction" },
      {
        outcome: "completed",
        postTokens: 2_091,
        preTokens: 25_920,
        trigger: "manual",
        type: "compaction",
      },
      // The post-compact init re-announces the same provider session.
      {
        claudeVersion: "2.1.270",
        model: "claude-fable-5-1",
        permissionMode: "default",
        providerSessionId: "5d0c2f2a-9a2b-4f6b-8d7c-1f2e3d4c5b6a",
        type: "sessionBootstrapped",
      },
      // A second, failed compaction is a fresh episode.
      { outcome: "started", type: "compaction" },
      {
        errorCode: "Not enough messages to compact.",
        outcome: "failed",
        type: "compaction",
      },
    ]);
  });

  test("emits a single started per episode and deduplicates terminal signals", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler);
    expect(assembler.apply(parseClaudeStreamLine(statusLine({ status: "compacting" }))))
      .toEqual([{ outcome: "started", type: "compaction" }]);
    // A refreshed compacting status is the same episode, not a new start.
    expect(assembler.apply(parseClaudeStreamLine(statusLine({ status: "compacting" }))))
      .toEqual([]);
    // A bare status clear carries no outcome.
    expect(assembler.apply(parseClaudeStreamLine(statusLine({ status: null })))).toEqual([]);
    // The provider verdict lands once, in either order relative to a boundary.
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_result: "success",
      status: null,
    })))).toEqual([{ outcome: "completed", type: "compaction" }]);
    expect(assembler.apply(parseClaudeStreamLine({
      compactMetadata: { preTokens: 40, trigger: "manual" },
      session_id: "s",
      subtype: "compact_boundary",
      type: "system",
    }))).toEqual([]);
  });

  test("records a failed verdict's reason only as a bounded error code", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler);
    assembler.apply(parseClaudeStreamLine(statusLine({ status: "compacting" })));
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_error: `Reason ${"x".repeat(600)}`,
      compact_result: "failed",
      status: null,
    })))).toEqual([{
      errorCode: `Reason ${"x".repeat(121)}`,
      outcome: "failed",
      type: "compaction",
    }]);
    // A repeated verdict adds nothing.
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_error: "again",
      compact_result: "failed",
      status: null,
    })))).toEqual([]);
  });

  test("reduces an unrecognized result code to a bounded failure", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler);
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_result: "partial",
      status: null,
    })))).toEqual([{ errorCode: "partial", outcome: "failed", type: "compaction" }]);
    // The same outcome word is still deduplicated within the episode.
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_error: "rolled back",
      compact_result: "failed",
      status: null,
    })))).toEqual([]);
  });

  test("surfaces a contradictory late verdict rather than hiding drift", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler);
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_result: "success",
      status: null,
    })))).toEqual([{ outcome: "completed", type: "compaction" }]);
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_error: "rolled back",
      compact_result: "failed",
      status: null,
    })))).toEqual([{ errorCode: "rolled back", outcome: "failed", type: "compaction" }]);
  });

  test("records a provider-initiated outcome even when no start was observed", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler);
    expect(assembler.apply(parseClaudeStreamLine({
      compact_result: "success",
      session_id: "s",
      subtype: "compact_result",
      type: "system",
    }))).toEqual([{ outcome: "completed", type: "compaction" }]);
  });

  test("admits compaction between turns and during a provider-driven mid-turn episode", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler);
    expect(assembler.activeTurnId).toBeNull();
    expect(assembler.apply(parseClaudeStreamLine(statusLine({ status: "compacting" }))))
      .toEqual([{ outcome: "started", type: "compaction" }]);
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_result: "success",
      status: null,
    })))).toEqual([{ outcome: "completed", type: "compaction" }]);
    // An auto-compaction can arrive while a turn is in flight.
    assembler.beginTurn("turn-1");
    expect(assembler.apply(parseClaudeStreamLine(statusLine({ status: "compacting" }))))
      .toEqual([{ outcome: "started", type: "compaction" }]);
    expect(assembler.apply(parseClaudeStreamLine(statusLine({
      compact_result: "success",
      status: null,
    })))).toEqual([{ outcome: "completed", type: "compaction" }]);
  });

  test("drops a dangling episode so the next compaction announces itself", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler);
    assembler.apply(parseClaudeStreamLine(statusLine({ status: "compacting" })));
    // No verdict arrived; a new turn abandons the dangling episode.
    assembler.beginTurn("turn-1");
    expect(assembler.apply(parseClaudeStreamLine(statusLine({ status: "compacting" }))))
      .toEqual([{ outcome: "started", type: "compaction" }]);
  });

  test("fences compaction signals to the provider session they name", () => {
    const assembler = new ClaudeDeltaAssembler();
    bootstrap(assembler, "session-one");
    expect(assembler.apply(parseClaudeStreamLine({
      session_id: "session-two",
      status: "compacting",
      subtype: "status",
      type: "system",
    }))).toEqual([{ event: "system/status/session_mismatch", type: "protocolNotice" }]);
    expect(assembler.apply(parseClaudeStreamLine({
      compact_result: "failed",
      session_id: "session-two",
      subtype: "compact_result",
      type: "system",
    }))).toEqual([{ event: "system/compact_result/session_mismatch", type: "protocolNotice" }]);
    expect(assembler.apply(parseClaudeStreamLine({
      compactMetadata: { trigger: "auto" },
      session_id: "session-two",
      subtype: "compact_boundary",
      type: "system",
    }))).toEqual([{ event: "system/compact_boundary/session_mismatch", type: "protocolNotice" }]);
    // No episode was opened by the mismatched signals.
    expect(assembler.apply(parseClaudeStreamLine({
      session_id: "session-one",
      status: "compacting",
      subtype: "status",
      type: "system",
    }))).toEqual([{ outcome: "started", type: "compaction" }]);
  });
});
