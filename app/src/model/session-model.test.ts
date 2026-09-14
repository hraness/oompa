import { describe, expect, test } from "bun:test";

import type { CompactSessionEvent, DetailSessionEvent } from "../oompa/cloud";
import {
  derivedTitle,
  initialSessionModel,
  maximumStreamingCharacters,
  sessionModelReducer,
  type SessionModel,
} from "./session-model";

const turn = "turn_0000000000000001";
const nextTurn = "turn_0000000000000002";

function foldCompact(events: readonly CompactSessionEvent[], from = initialSessionModel()) {
  return sessionModelReducer(from, { events, type: "compact" });
}

function foldDetail(events: readonly DetailSessionEvent[], from = initialSessionModel()) {
  return sessionModelReducer(from, { events, type: "detail" });
}

function userMessage(sequence: number, text: string): CompactSessionEvent {
  return { kind: "user_message", sequence, text, turnId: turn };
}

function delta(sequence: number, text: string, turnId = turn): DetailSessionEvent {
  return { sequence, text, turnId, type: "assistant_delta" };
}

function sessionState(
  sequence: number,
  revision: number,
  overrides: Partial<Extract<DetailSessionEvent, { type: "session_state" }>> = {},
): DetailSessionEvent {
  return {
    attention: false,
    lastActivityAt: 1_000,
    reason: "test",
    revision,
    sequence,
    state: "working",
    type: "session_state",
    verbatimRequired: false,
    ...overrides,
  };
}

describe("sessionModelReducer", () => {
  test("starts empty and working", () => {
    const model = initialSessionModel();
    expect(model.streamingText).toBe("");
    expect(model.state).toBe("working");
    expect(model.turnActive).toBe(false);
    expect(model.pendingInteractions).toEqual([]);
  });

  test("takes the title from the first prompt and the last prompt from the newest", () => {
    const model = foldCompact([
      userMessage(1, "Fix the flaky test\nand explain why"),
      userMessage(2, "Now ship it"),
    ]);
    expect(model.title).toBe("Fix the flaky test");
    expect(model.lastPrompt).toBe("Now ship it");
  });

  test("an explicit session name overrides the derived title", () => {
    const withPrompt = foldCompact([userMessage(1, "Fix the flaky test")]);
    const named = sessionModelReducer(withPrompt, { name: "Flaky test hunt", type: "metadata" });
    expect(named.title).toBe("Flaky test hunt");
    const unnamed = sessionModelReducer(withPrompt, { name: null, type: "metadata" });
    expect(unnamed.title).toBe("Fix the flaky test");
  });

  test("assistant deltas accumulate within a turn", () => {
    const model = foldDetail([delta(1, "Hello"), delta(2, " world")]);
    expect(model.streamingText).toBe("Hello world");
    expect(model.turnActive).toBe(true);
    expect(model.turnId).toBe(turn);
  });

  test("a new turn clears the previous streaming and thinking text", () => {
    const first = foldDetail([
      delta(1, "old text"),
      { sequence: 2, text: "old thought", turnId: turn, type: "reasoning_summary_delta" },
    ]);
    const second = sessionModelReducer(first, {
      events: [{ at: 5_000, sequence: 3, turnId: nextTurn, type: "turn_started" }],
      type: "detail",
    });
    expect(second.streamingText).toBe("");
    expect(second.thinkingText).toBe("");
    expect(second.turnActive).toBe(true);
    expect(second.lastActivityAt).toBe(5_000);
  });

  test("a compact assistant message replaces the accumulated deltas", () => {
    const streamed = foldDetail([delta(1, "partial")]);
    const settled = sessionModelReducer(streamed, {
      events: [{ kind: "assistant_message", sequence: 1, text: "the whole answer", turnId: turn }],
      type: "compact",
    });
    expect(settled.streamingText).toBe("the whole answer");
  });

  test("streaming text is bounded and keeps the tail", () => {
    const model = foldDetail([
      delta(1, "a".repeat(maximumStreamingCharacters)),
      delta(2, "TAIL"),
    ]);
    expect(model.streamingText.length).toBe(maximumStreamingCharacters);
    expect(model.streamingText.endsWith("TAIL")).toBe(true);
  });

  test("a later session_state revision wins and a stale one is dropped", () => {
    const model = foldDetail([
      sessionState(1, 1, { state: "working" }),
      sessionState(2, 3, { attention: true, state: "needs_answer" }),
      sessionState(3, 2, { state: "done" }),
    ]);
    expect(model.state).toBe("needs_answer");
    expect(model.attention).toBe(true);
    expect(model.stateRevision).toBe(3);
  });

  test("a terminal session state ends the active turn", () => {
    const working = foldDetail([delta(1, "text")]);
    const done = sessionModelReducer(working, {
      events: [sessionState(2, 1, { state: "done" })],
      type: "detail",
    });
    expect(done.turnActive).toBe(false);
  });

  test("a turn summary ends the active turn", () => {
    const working = foldDetail([delta(1, "text")]);
    const summarised = sessionModelReducer(working, {
      events: [{
        filesTouched: [],
        gitActions: [],
        kind: "turn_summary",
        runtimeMs: 10,
        sequence: 2,
        turnId: turn,
      }],
      type: "compact",
    });
    expect(summarised.turnActive).toBe(false);
  });

  test("pending interactions are keyed by id and drop when resolved", () => {
    const pending = foldCompact([{
      blocking: true,
      interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      interactionKind: "command_approval",
      kind: "interaction_state",
      revision: 1,
      sequence: 1,
      state: "pending",
      summary: "run the build",
    }]);
    expect(pending.pendingInteractions).toHaveLength(1);

    const resolved = sessionModelReducer(pending, {
      events: [{
        blocking: true,
        interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        interactionKind: "command_approval",
        kind: "interaction_state",
        revision: 2,
        sequence: 2,
        state: "resolved",
        summary: "run the build",
      }],
      type: "compact",
    });
    expect(resolved.pendingInteractions).toEqual([]);
  });

  test("carries only the v2 remote policy as action authority", () => {
    const detailed = foldCompact([{
      blocking: true,
      detailMarkdown: "- Runs: git commit",
      detailVersion: 2,
      headline: "Allow git commit",
      interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3302",
      interactionKind: "command_approval",
      kind: "interaction_state",
      label: "Command approval",
      remotePolicy: {
        actions: ["decline"],
        deadlineAt: 30_000,
        questions: [],
        reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
        version: 2,
      },
      revision: 1,
      sequence: 1,
      state: "pending",
      summary: "Codex requests command approval",
    }]);
    expect(detailed.pendingInteractions[0]).toMatchObject({
      detailMarkdown: "- Runs: git commit",
      headline: "Allow git commit",
      label: "Command approval",
      remotePolicy: {
        actions: ["decline"],
        deadlineAt: 30_000,
      },
    });

    const legacy = foldCompact([{
      availableDecisions: ["once", "decline"],
      blocking: true,
      commandClass: "git commit",
      detailVersion: 1,
      interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3303",
      interactionKind: "command_approval",
      kind: "interaction_state",
      revision: 1,
      sequence: 1,
      state: "pending",
      summary: "run the build",
    }]);
    expect(legacy.pendingInteractions[0]).toMatchObject({
      detailMarkdown: null,
      headline: null,
      label: null,
      remotePolicy: null,
    });
  });

  test("response-prepared interactions leave the actionable pending set", () => {
    const pending = foldCompact([{
      blocking: true,
      interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3304",
      interactionKind: "user_input",
      kind: "interaction_state",
      revision: 1,
      sequence: 1,
      state: "pending",
      summary: "Codex needs an answer",
    }]);
    const prepared = foldCompact([{
      blocking: true,
      interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3304",
      interactionKind: "user_input",
      kind: "interaction_state",
      revision: 2,
      sequence: 2,
      state: "response_prepared",
      summary: "Codex needs an answer",
    }], pending);
    expect(prepared.pendingInteractions).toEqual([]);
    expect(prepared.interactionRevisions).toEqual({
      "3f2504e0-4f89-41d3-9a0c-0305e82c3304": 2,
    });
  });

  test("a stale interaction revision does not reopen a resolved interaction", () => {
    const resolved = foldCompact([
      {
        blocking: true,
        interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        interactionKind: "command_approval",
        kind: "interaction_state",
        revision: 4,
        sequence: 1,
        state: "resolved",
        summary: "run the build",
      },
      {
        blocking: true,
        interactionId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        interactionKind: "command_approval",
        kind: "interaction_state",
        revision: 2,
        sequence: 2,
        state: "pending",
        summary: "run the build",
      },
    ]);
    expect(resolved.pendingInteractions).toEqual([]);
  });

  test("subagents appear on start and leave on completion", () => {
    const started = foldDetail([{
      agentId: "agent_00000001",
      kind: "started",
      nickname: "scout",
      sequence: 1,
      turnId: turn,
      type: "subagent_activity",
    }]);
    expect(started.subagents).toEqual([
      { agentId: "agent_00000001", depth: null, nickname: "scout", role: null },
    ]);

    const finished = sessionModelReducer(started, {
      events: [{
        agentId: "agent_00000001",
        kind: "completed",
        sequence: 2,
        turnId: turn,
        type: "subagent_activity",
      }],
      type: "detail",
    });
    expect(finished.subagents).toEqual([]);
  });

  test("a later activity keeps the labels only the thread start carried", () => {
    const model = foldDetail([
      {
        agentId: "agent_00000001",
        depth: 2,
        kind: "started",
        nickname: "scout",
        role: "reviewer",
        sequence: 1,
        turnId: turn,
        type: "subagent_activity",
      },
      { agentId: "agent_00000001", kind: "interacted", sequence: 2, turnId: turn, type: "subagent_activity" },
    ]);
    expect(model.subagents).toEqual([
      { agentId: "agent_00000001", depth: 2, nickname: "scout", role: "reviewer" },
    ]);
  });

  test("folding is pure: the input model is never mutated", () => {
    const before = initialSessionModel();
    const snapshot: SessionModel = { ...before };
    foldDetail([delta(1, "text")], before);
    expect(before).toEqual(snapshot);
  });

  test("reset returns the initial model", () => {
    const model = foldDetail([delta(1, "text")]);
    expect(sessionModelReducer(model, { type: "reset" })).toEqual(initialSessionModel());
  });
});

describe("derivedTitle", () => {
  test("takes the first non-empty line", () => {
    expect(derivedTitle("\n\n  Ship the release  \nand tag it")).toBe("Ship the release");
  });

  test("bounds a long line", () => {
    const title = derivedTitle("x".repeat(200));
    expect(title.length).toBe(72);
    expect(title.endsWith("…")).toBe(true);
  });
});
