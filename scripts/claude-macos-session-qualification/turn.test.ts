import { expect, test } from "bun:test";
import fc from "fast-check";

import type { ClaudeFact } from "../../src/claude/assembler";
import { claudeInteractionDisplay, type ClaudeCanUseTool } from "../../src/claude/protocol";
import { SessionTurnObservation, type SessionTurnScenario } from "./turn";

const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture(scenario: SessionTurnScenario = "stream", nonce = id(1)) {
  const observer = new SessionTurnObservation({ scenario, nonce, providerThreadId: id(2), connectionId: id(3) });
  const fact = (value: ClaudeFact) => observer.observe({ ...value, providerThreadId: id(2), connectionId: id(3) });
  const start = () => { fact({ type: "turnStarted", turnId: id(4) }); observer.bindReturnedTurn(id(4)); };
  const delta = (text = nonce) => fact({ type: "assistantDelta", turnId: id(4), itemId: id(5), text });
  const summary = (status: "completed" | "interrupted" | "failed" = "completed") => fact({ type: "turnSummary", turnId: id(4), status,
    runtimeMs: 1, stopReason: null, terminalReason: null, resultText: nonce });
  const tail = () => fact({ type: "protocolNotice", event: "result/accounting_invalid" });
  const terminal = (status: "completed" | "interrupted" | "failed" = "completed") => {
    fact({ type: "turnCompleted", turnId: id(4), status }); summary(status); tail();
  };
  const request = (input: Record<string, unknown> = { command: observer.command }, toolName = "Bash") => {
    const value: ClaudeCanUseTool = { subtype: "can_use_tool", toolName, displayName: toolName, description: null, toolUseId: id(6),
      requiresUserInteraction: true, blockedPath: null, decisionReasonType: null, permissionSuggestionCount: 0, input, questions: null };
    fact({ type: "interactionRequested", requestId: id(7), turnId: id(4), itemId: id(6), kind: "command_approval", blocking: true,
      display: claudeInteractionDisplay(value), request: value });
  };
  return { observer, fact, start, delta, terminal, summary, tail, request };
}

test("stream and resumed scenarios require exact bound live deltas, returned turn and terminal", () => {
  fc.assert(fc.property(fc.uuid(), fc.integer({ min: 1, max: 35 }), (nonce, split) => {
    for (const scenario of ["stream", "resumed"] as const) {
      const f = fixture(scenario, nonce); f.start(); f.delta(nonce.slice(0, split)); f.delta(nonce.slice(split)); f.terminal();
      expect(f.observer.finish()).toEqual({ deltaCount: 2, deltaBytes: 36, completed: true, decision: null, interrupted: false });
      f.observer.clear(); expect(() => f.observer.finish()).toThrow();
    }
  }), { numRuns: 40 });
});

test("an exact approval or denial is observed once and never inferred from a terminal", () => {
  for (const scenario of ["approve", "deny"] as const) {
    const f = fixture(scenario); f.start(); f.request(); expect(f.observer.takeRequest()).toBe(id(7));
    expect(() => f.observer.takeRequest()).toThrow(); f.delta(); f.terminal();
    expect(() => f.observer.finish()).toThrow(); f.observer.decisionWritten();
    f.fact({ type: "interactionCanceled", requestId: id(7) });
    expect(f.observer.finish().decision).toBe(scenario === "approve" ? "once" : "decline");
    expect(() => f.observer.decisionWritten()).toThrow();
  }
});

test("tool names, command bytes, extra input and repeated requests refuse before a decision", () => {
  for (const change of ["tool", "command", "extra", "repeat", "unrequested"] as const) {
    const f = fixture(change === "unrequested" ? "stream" : "approve"); f.start();
    expect(() => {
      if (change === "repeat") { f.request(); f.request(); }
      else f.request(change === "extra" ? { command: f.observer.command, cwd: "/elsewhere" }
        : { command: change === "command" ? "false" : f.observer.command }, change === "tool" ? "Write" : "Bash");
    }).toThrow();
    expect(() => f.observer.finish()).toThrow();
  }
});

test("interrupt requires an observed delta and acknowledged write plus interrupted terminal", () => {
  const f = fixture("interrupt"); f.start(); expect(() => f.observer.interruptWritten()).toThrow();
  f.delta("1\n"); f.terminal("interrupted"); expect(() => f.observer.finish()).toThrow();
  f.observer.interruptWritten(); expect(f.observer.finish().interrupted).toBeTrue();
  const completed = fixture("interrupt"); completed.start(); completed.delta("1\n"); completed.observer.interruptWritten(); completed.terminal();
  expect(() => completed.observer.finish()).toThrow();
});

test("wrong identity, terminal order, duplicate start, missing stream and failed provider facts cannot qualify", () => {
  for (const failure of ["scope", "turn", "duplicate", "missing", "failed", "late", "error", "cancel"] as const) {
    const f = fixture(); f.start();
    if (failure === "missing") f.terminal();
    else if (failure === "failed") { f.delta(); f.terminal("failed"); }
    else expect(() => {
      if (failure === "scope") f.observer.observe({ providerThreadId: id(9), connectionId: id(3), type: "turnCompleted", turnId: id(4), status: "completed" });
      if (failure === "turn") f.fact({ type: "assistantDelta", turnId: id(9), itemId: id(5), text: id(1) });
      if (failure === "duplicate") f.fact({ type: "turnStarted", turnId: id(4) });
      if (failure === "late") { f.terminal(); f.delta(); }
      if (failure === "error") f.fact({ type: "providerDisconnected", reason: "eof" });
      if (failure === "cancel") f.fact({ type: "interactionCanceled", requestId: id(7) });
    }).toThrow();
    expect(() => f.observer.finish()).toThrow();
  }
});

test("byte and fact limits are sticky and foreign constructor fields refuse", () => {
  const large = fixture(); large.start(); expect(() => large.delta("é".repeat(8193))).toThrow(); expect(() => large.delta()).toThrow();
  const many = fixture(); many.start(); for (let n = 0; n < 1023; n += 1) many.delta("");
  expect(() => many.delta()).toThrow();
  expect(() => new SessionTurnObservation({ scenario: "stream", nonce: id(1), providerThreadId: id(2), connectionId: id(3), admitted: true })).toThrow();
});

test("wait observes real events, abort and deadline without leaving a second effect path", async () => {
  const f = fixture(); f.start(); const controller = new AbortController();
  const waiting = f.observer.wait("delta", controller.signal, Date.now() + 500); f.delta(); await waiting;
  const terminal = f.observer.wait("terminal", controller.signal, Date.now() + 500); f.terminal(); await terminal;
  const aborted = fixture(); aborted.start(); const abort = new AbortController();
  const pending = aborted.observer.wait("terminal", abort.signal, Date.now() + 500); abort.abort(); await expect(pending).rejects.toThrow("aborted");
  await expect(fixture().observer.wait("request", new AbortController().signal, Date.now() - 1)).rejects.toThrow("deadline");
  await expect(f.observer.wait("terminal", new AbortController().signal, Date.now() - 1)).rejects.toThrow("deadline");
});


test("turnCompleted and summary cannot settle before the same result batch's closed tail", async () => {
  const f = fixture(); f.start(); f.delta(); f.fact({ type: "turnCompleted", turnId: id(4), status: "completed" });
  expect(() => f.observer.finish()).toThrow();
  let settled = false;
  const pending = f.observer.wait("terminal", new AbortController().signal, Date.now() + 500).then(() => { settled = true; });
  await Promise.resolve(); expect(settled).toBeFalse(); f.summary(); await Promise.resolve();
  expect(settled).toBeFalse(); expect(() => f.observer.finish()).toThrow(); f.tail(); await pending;
  expect(f.observer.finish().completed).toBeTrue();
  for (const failure of ["early", "status", "turn", "unknown", "duplicate"] as const) {
    const broken = fixture(); broken.start(); broken.delta();
    expect(() => {
      if (failure === "early") broken.tail();
      else {
        broken.fact({ type: "turnCompleted", turnId: id(4), status: "completed" });
        if (failure === "status") broken.summary("interrupted");
        else if (failure === "turn") broken.fact({ type: "turnSummary", turnId: id(9), status: "completed", runtimeMs: 1,
          stopReason: null, terminalReason: null, resultText: "" });
        else { broken.summary(); broken.fact({ type: "protocolNotice", event: failure === "unknown" ? "unobserved" : "result/accounting_invalid" });
          if (failure === "duplicate") broken.tail(); }
      }
    }).toThrow();
    expect(() => broken.observer.finish()).toThrow();
  }
});


test("the valid accounting tail joins only its exact turn, and empty deltas do not arm interruption", () => {
  const accounting: Extract<ClaudeFact, { type: "usageAccountingObserved" }> = { type: "usageAccountingObserved", turnId: id(4), observationRevision: 1,
    observedAt: 1, receivedAt: 1, sourceEventId: id(8), sourceEventDigest: "a".repeat(64),
    accounting: { totalCostUsd: null, models: [], tokens: { inputTokens: null, outputTokens: null, thinkingTokens: null,
      cacheCreationInputTokens: null, cacheReadInputTokens: null } } };
  for (const matching of [true, false]) {
    const f = fixture(); f.start(); f.delta(); f.fact({ type: "turnCompleted", turnId: id(4), status: "completed" }); f.summary();
    if (matching) { f.fact(accounting); expect(f.observer.finish().completed).toBeTrue(); }
    else { expect(() => f.fact({ ...accounting, turnId: id(9) })).toThrow(); expect(() => f.observer.finish()).toThrow(); }
  }
  const empty = fixture("interrupt"); empty.start(); empty.delta(""); expect(empty.observer.hasDelta).toBeFalse();
  expect(() => empty.observer.interruptWritten()).toThrow();
});
