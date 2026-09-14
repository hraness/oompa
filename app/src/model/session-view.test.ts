import { describe, expect, test } from "bun:test";

import {
  remoteInteractionPolicyReasonCodeOrder,
  type CompactInteractionKind,
  type CompactRemoteInteractionPolicy,
  type SessionStateValue,
} from "../oompa/cloud";
import {
  formatDuration,
  interactionAffordance,
  interactionCommandPublicId,
  interactionInstanceKey,
  interactionKindLabel,
  interactionIsLocalOnly,
  interactionReasonCopy,
  isIdleSession,
  orderSessionCards,
  sessionStateLabel,
  sessionStateTone,
  shortSessionLabel,
  subagentChipCharacters,
  subagentChips,
  turnSummaryLine,
  type SessionCardSummary,
  type SubagentChipInput,
} from "./session-view";

const allStates: readonly SessionStateValue[] = [
  "working",
  "needs_approval",
  "needs_answer",
  "needs_action",
  "done",
  "done_followups",
  "done_caveats",
  "aborted",
];

const allInteractionKinds: readonly CompactInteractionKind[] = [
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
];

function card(
  publicId: string,
  overrides: Partial<SessionCardSummary> = {},
): SessionCardSummary {
  return {
    archived: false,
    attention: false,
    lastActivityAt: 0,
    metadataRevision: 1,
    publicId,
    state: "done",
    title: publicId,
    ...overrides,
  };
}

describe("state presentation", () => {
  test("every state has a label and a tone", () => {
    for (const state of allStates) {
      expect(sessionStateLabel[state].length).toBeGreaterThan(0);
      expect(sessionStateTone[state]).toBeDefined();
    }
  });

  test("the three attention states are toned as attention", () => {
    expect(sessionStateTone.needs_approval).toBe("attention");
    expect(sessionStateTone.needs_answer).toBe("attention");
    expect(sessionStateTone.needs_action).toBe("attention");
  });
});

describe("orderSessionCards", () => {
  test("attention first, then working, then the rest", () => {
    const ordered = orderSessionCards([
      card("done-old", { lastActivityAt: 10 }),
      card("working", { lastActivityAt: 20, state: "working" }),
      card("attention", { attention: true, lastActivityAt: 1, state: "needs_answer" }),
      card("done-new", { lastActivityAt: 30 }),
    ]);
    expect(ordered.map((entry) => entry.publicId))
      .toEqual(["attention", "working", "done-new", "done-old"]);
  });

  test("orders inside a group by last activity, newest first", () => {
    const ordered = orderSessionCards([
      card("a", { attention: true, lastActivityAt: 5, state: "needs_approval" }),
      card("b", { attention: true, lastActivityAt: 50, state: "needs_action" }),
      card("c", { attention: true, lastActivityAt: 25, state: "needs_answer" }),
    ]);
    expect(ordered.map((entry) => entry.publicId)).toEqual(["b", "c", "a"]);
  });

  test("breaks a timestamp tie on the public id so the order is stable", () => {
    const first = orderSessionCards([card("zeta"), card("alpha")]);
    const second = orderSessionCards([card("alpha"), card("zeta")]);
    expect(first.map((entry) => entry.publicId)).toEqual(["alpha", "zeta"]);
    expect(second.map((entry) => entry.publicId)).toEqual(["alpha", "zeta"]);
  });

  test("hides archived sessions", () => {
    const ordered = orderSessionCards([
      card("kept", { lastActivityAt: 1 }),
      card("gone", { archived: true, attention: true, lastActivityAt: 99 }),
    ]);
    expect(ordered.map((entry) => entry.publicId)).toEqual(["kept"]);
  });

  test("an attention card that is also working still sorts first", () => {
    const ordered = orderSessionCards([
      card("plain-working", { lastActivityAt: 99, state: "working" }),
      card("asking", { attention: true, lastActivityAt: 1, state: "needs_approval" }),
    ]);
    expect(ordered[0]?.publicId).toBe("asking");
  });

  test("leaves the input array untouched", () => {
    const input = [card("b", { lastActivityAt: 1 }), card("a", { lastActivityAt: 2 })];
    orderSessionCards(input);
    expect(input.map((entry) => entry.publicId)).toEqual(["b", "a"]);
  });
});

describe("orderSessionCards with a manual arrangement", () => {
  test("an empty arrangement orders exactly as the automatic ladder does", () => {
    const summaries = [
      card("done-old", { lastActivityAt: 10 }),
      card("working", { lastActivityAt: 20, state: "working" }),
      card("attention", { attention: true, lastActivityAt: 1, state: "needs_answer" }),
      card("done-new", { lastActivityAt: 30 }),
    ];
    expect(orderSessionCards(summaries, []).map((entry) => entry.publicId))
      .toEqual(orderSessionCards(summaries).map((entry) => entry.publicId));
  });

  test("the arrangement decides the order, not the activity", () => {
    const ordered = orderSessionCards(
      [
        card("a", { lastActivityAt: 1 }),
        card("b", { lastActivityAt: 100, state: "working" }),
        card("c", { lastActivityAt: 50 }),
      ],
      ["c", "a", "b"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["c", "a", "b"]);
  });

  test("an attention card still floats to the front of an arrangement", () => {
    const ordered = orderSessionCards(
      [
        card("first", { lastActivityAt: 9 }),
        card("second", { lastActivityAt: 8 }),
        card("asking", { attention: true, lastActivityAt: 1, state: "needs_approval" }),
      ],
      ["first", "second", "asking"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["asking", "first", "second"]);
  });

  test("an arranged card takes its place back when the question is answered", () => {
    const arrangement = ["first", "second", "third"];
    const asking = orderSessionCards(
      [
        card("first"),
        card("second", { attention: true, state: "needs_answer" }),
        card("third"),
      ],
      arrangement,
    );
    expect(asking.map((entry) => entry.publicId)).toEqual(["second", "first", "third"]);
    const answered = orderSessionCards(
      [card("first"), card("second"), card("third")],
      arrangement,
    );
    expect(answered.map((entry) => entry.publicId)).toEqual(arrangement);
  });

  test("a card the arrangement does not name falls in behind every card it does", () => {
    const ordered = orderSessionCards(
      [
        card("new", { lastActivityAt: 999, state: "working" }),
        card("placed", { lastActivityAt: 1 }),
      ],
      ["placed"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["placed", "new"]);
  });

  test("unnamed cards keep the automatic ladder among themselves", () => {
    const ordered = orderSessionCards(
      [
        card("idle-new", { lastActivityAt: 30 }),
        card("working-old", { lastActivityAt: 5, state: "working" }),
        card("placed", { lastActivityAt: 1 }),
      ],
      ["placed"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["placed", "working-old", "idle-new"]);
  });

  test("an arrangement naming sessions that are gone changes nothing for the rest", () => {
    const ordered = orderSessionCards(
      [card("a", { lastActivityAt: 1 }), card("b", { lastActivityAt: 2 })],
      ["ghost", "b", "a"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["b", "a"]);
  });

  test("an arranged archived session still leaves the grid", () => {
    const ordered = orderSessionCards(
      [card("kept"), card("gone", { archived: true })],
      ["gone", "kept"],
    );
    expect(ordered.map((entry) => entry.publicId)).toEqual(["kept"]);
  });
});

describe("subagentChips", () => {
  const agent = (
    agentId: string,
    overrides: Partial<SubagentChipInput> = {},
  ): SubagentChipInput => ({
    agentId,
    depth: 1,
    nickname: null,
    role: null,
    ...overrides,
  });

  test("a session with no subagents gets nothing", () => {
    expect(subagentChips([])).toEqual({ chips: [], overflow: 0 });
  });

  test("the face is the nickname, then the role, then an opaque short id", () => {
    const { chips } = subagentChips([
      agent("aaaaaaaaaaaa", { nickname: "Scout", role: "reviewer" }),
      agent("bbbbbbbbbbbb", { role: "reviewer" }),
      agent("cccccccccccc"),
    ]);
    expect(chips.map((chip) => chip.label)).toEqual(["Agent cccccc", "Scout", "reviewer"]);
  });

  test("the detail line carries the role and the depth", () => {
    const { chips } = subagentChips([agent("a", { depth: 2, role: "reviewer" })]);
    expect(chips[0]?.detail).toBe("reviewer · depth 2");
  });

  test("an unreported role or depth says so rather than inventing one", () => {
    const { chips } = subagentChips([agent("a", { depth: null })]);
    expect(chips[0]?.detail).toBe("No role reported · depth unknown");
  });

  test("shows three and counts the rest", () => {
    const set = subagentChips([
      agent("a", { nickname: "one" }),
      agent("b", { nickname: "two" }),
      agent("c", { nickname: "three" }),
      agent("d", { nickname: "four" }),
      agent("e", { nickname: "five" }),
    ]);
    expect(set.chips.length).toBe(3);
    expect(set.overflow).toBe(2);
  });

  test("orders shallowest first so a repainting card does not reshuffle", () => {
    const input = [
      agent("a", { depth: 3, nickname: "deep" }),
      agent("b", { depth: null, nickname: "unknown" }),
      agent("c", { depth: 1, nickname: "shallow" }),
    ];
    const first = subagentChips(input).chips.map((chip) => chip.label);
    const second = subagentChips([...input].reverse()).chips.map((chip) => chip.label);
    expect(first).toEqual(["shallow", "deep", "unknown"]);
    expect(second).toEqual(first);
  });

  test("a long face is clamped", () => {
    const { chips } = subagentChips([agent("a", { nickname: "n".repeat(80) })]);
    expect(chips[0]?.label.length).toBe(subagentChipCharacters);
    expect(chips[0]?.label.endsWith("…")).toBe(true);
  });

  test("leaves the input array untouched", () => {
    const input = [agent("b", { depth: 2 }), agent("a", { depth: 1 })];
    subagentChips(input);
    expect(input.map((entry) => entry.agentId)).toEqual(["b", "a"]);
  });
});

describe("isIdleSession", () => {
  test("the four terminal states are idle and the rest are not", () => {
    expect(allStates.filter(isIdleSession))
      .toEqual(["done", "done_followups", "done_caveats", "aborted"]);
  });
});

describe("interaction affordances", () => {
  const policy = (
    overrides: Partial<CompactRemoteInteractionPolicy> = {},
  ): CompactRemoteInteractionPolicy => ({
    actions: [],
    deadlineAt: 10_000,
    questions: [],
    reasonCodes: [],
    version: 2,
    ...overrides,
  });

  test("every interaction kind has a presentation label", () => {
    for (const interactionKind of allInteractionKinds) {
      expect(interactionKindLabel[interactionKind].length).toBeGreaterThan(0);
    }
  });

  test("old, absent, or unknown policies fail closed", () => {
    const affordance = interactionAffordance(null, 0);
    expect(affordance).toEqual({
      actions: [],
      questions: [],
      reachability: "machine_only",
      reasonCodes: ["REMOTE_POLICY_UNAVAILABLE"],
    });
    expect(interactionIsLocalOnly(affordance)).toBe(true);
  });

  test("consumes the projected action set without deriving from an interaction kind", () => {
    const affordance = interactionAffordance(policy({
      actions: ["decline"],
      reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
    }), 9_999);
    expect(affordance.actions).toEqual(["decline"]);
    expect(affordance.questions).toEqual([]);
    expect(affordance.reachability).toBe("remote_limited");
  });

  test("retains exact questions only while answer is projected", () => {
    const questions = [{
      allowsOther: false,
      header: "Region",
      id: "region",
      kind: "user_input" as const,
      options: [{ description: "Primary", label: "East" }],
      question: "Which region?",
    }] as const;
    const affordance = interactionAffordance(policy({
      actions: ["answer"],
      questions,
    }), 1);
    expect(affordance.actions).toEqual(["answer"]);
    expect(affordance.questions).toEqual(questions);
  });

  test("suppresses every control at and after the exact deadline", () => {
    const actionable = policy({ actions: ["decline"] });
    expect(interactionAffordance(actionable, 9_999).actions).toEqual(["decline"]);
    const atDeadline = interactionAffordance(actionable, 10_000);
    expect(atDeadline.actions).toEqual([]);
    expect(atDeadline.reasonCodes).toEqual(["INTERACTION_EXPIRED"]);
    expect(interactionAffordance(actionable, 10_001).actions).toEqual([]);
    expect(interactionIsLocalOnly(atDeadline)).toBe(true);
  });

  test("distinguishes partial remote reachability from machine-only requests", () => {
    const limited = interactionAffordance(policy({
      actions: ["decline"],
      reasonCodes: ["COMMAND_APPROVAL_LOCAL_ONLY"],
    }), 1);
    expect(limited.reachability).toBe("remote_limited");
    const machineOnly = interactionAffordance(policy({
      reasonCodes: ["MCP_ANSWER_LOCAL_ONLY"],
    }), 1);
    expect(machineOnly.reachability).toBe("machine_only");
    expect(interactionIsLocalOnly(machineOnly)).toBe(true);
  });

  test("has reader copy for every closed policy reason", () => {
    for (const reason of remoteInteractionPolicyReasonCodeOrder) {
      expect(interactionReasonCopy[reason].length).toBeGreaterThan(0);
    }
    expect(interactionReasonCopy.REMOTE_POLICY_UNAVAILABLE.length).toBeGreaterThan(0);
  });

  test("keys panel state by exact interaction id and revision", () => {
    expect(interactionInstanceKey({ interactionId: "interaction-a", revision: 7 }))
      .toBe("interaction-a:7");
    expect(interactionInstanceKey({ interactionId: "interaction-a", revision: 8 }))
      .toBe("interaction-a:8");
    expect(interactionInstanceKey({ interactionId: "interaction-b", revision: 7 }))
      .toBe("interaction-b:7");
  });

  test("does not carry a prior decision command into another panel revision", () => {
    const command = { interactionKey: "interaction-a:7", publicId: "command-1" };
    expect(interactionCommandPublicId(command, {
      interactionId: "interaction-a",
      revision: 7,
    })).toBe("command-1");
    expect(interactionCommandPublicId(command, {
      interactionId: "interaction-a",
      revision: 8,
    })).toBeNull();
    expect(interactionCommandPublicId(command, {
      interactionId: "interaction-b",
      revision: 7,
    })).toBeNull();
    expect(interactionCommandPublicId(null, null)).toBeNull();
  });
});

describe("turn summary line", () => {
  test("counts files, names git actions, and states the runtime", () => {
    expect(turnSummaryLine({ filesTouched: 3, gitActions: ["commit"], runtimeMs: 4_200 }))
      .toBe("3 files · commit · 4s");
  });

  test("uses the singular for one file and omits an empty git list", () => {
    expect(turnSummaryLine({ filesTouched: 1, gitActions: [], runtimeMs: 500 }))
      .toBe("1 file · 1s");
  });
});

describe("formatDuration", () => {
  test("scales from seconds to hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_000)).toBe("59s");
    expect(formatDuration(90_000)).toBe("1m 30s");
    expect(formatDuration(3_930_000)).toBe("1h 5m");
  });

  test("refuses a value that is not a duration", () => {
    expect(formatDuration(Number.NaN)).toBe("unknown");
    expect(formatDuration(-1)).toBe("unknown");
  });
});

describe("shortSessionLabel", () => {
  test("is bounded and derived from the public id", () => {
    expect(shortSessionLabel("0199aaaabbbbccccdddd")).toBe("Session 0199aaaa");
  });
});
