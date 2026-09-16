import { describe, expect, test } from "bun:test";

import { DevinError } from "./errors";
import {
  devinRequestKey,
  parseDevinInboundMessage,
  parseDevinInitializeResponse,
  parseDevinPermissionRequest,
  parseDevinPromptResponse,
  parseDevinSessionUpdate,
  sanitizeDevinText,
  validateDevinPermissionOutcome,
} from "./protocol";

describe("Devin ACP projection", () => {
  test("projects text, tools, plans, context usage, and cost while dropping raw thought", () => {
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: "message-1",
        content: { type: "text", text: "hello" },
      },
    })).toEqual([{
      type: "assistantDelta",
      sessionId: "session-1",
      messageId: "message-1",
      text: "hello",
    }]);
    const thought = Object.create(null) as Record<string, unknown>;
    thought.sessionUpdate = "agent_thought_chunk";
    Object.defineProperty(thought, "content", {
      get: () => { throw new Error("RAW_THOUGHT_MUST_NOT_BE_READ"); },
    });
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: thought,
    })).toEqual([{
      sessionId: "session-1",
      method: "session/update:agent_thought_chunk",
      disposition: "unprojected_update",
      type: "protocolNotice",
    }]);
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Read package.json",
        kind: "read",
        status: "pending",
      },
    })).toEqual([{
      type: "toolCall",
      sessionId: "session-1",
      toolCallId: "tool-1",
      title: "Read package.json",
      kind: "read",
      status: "pending",
    }]);
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
      },
    })).toEqual([{
      type: "toolCallUpdate",
      sessionId: "session-1",
      toolCallId: "tool-1",
      title: null,
      kind: null,
      status: "completed",
    }]);
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [{ content: "Implement transport", priority: "high", status: "in_progress" }],
      },
    })).toEqual([{
      type: "plan",
      sessionId: "session-1",
      entries: [{ content: "Implement transport", priority: "high", status: "in_progress" }],
    }]);
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "usage_update",
        used: 1_234,
        size: 64_000,
        cost: { amount: 0.42, currency: "USD" },
      },
    })).toEqual([{
      type: "usageUpdated",
      sessionId: "session-1",
      used: 1_234,
      size: 64_000,
      cost: { amount: 0.42, currency: "USD" },
    }]);
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: { sessionUpdate: "usage_update", used: 10, size: 0 },
    })).toEqual([{
      cost: null,
      sessionId: "session-1",
      size: 0,
      type: "usageUpdated",
      used: 10,
    }]);
  });

  test("projects permission requests without widening choices", () => {
    const fact = parseDevinPermissionRequest(7, {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Run tests", kind: "execute" },
      options: [
        { optionId: "once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    expect(fact.requestId).toBe("n:7");
    expect(validateDevinPermissionOutcome(
      { outcome: "selected", optionId: "once" },
      fact.options,
    )).toEqual({ outcome: "selected", optionId: "once" });
    expect(() => validateDevinPermissionOutcome(
      { outcome: "selected", optionId: "always-not-offered" },
      fact.options,
    )).toThrow("did not select an offered option");
    expect(devinRequestKey("7")).toBe("s:7");
  });

  test("accepts ACP v1 capability negotiation and closed stop reasons", () => {
    expect(parseDevinInitializeResponse({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
    })).toEqual({ protocolVersion: 1, loadSession: true });
    expect(parseDevinPromptResponse({ stopReason: "end_turn" })).toBe("end_turn");
    expect(() => parseDevinInitializeResponse({ protocolVersion: 2 }))
      .toThrow("required ACP v1");
    expect(() => parseDevinPromptResponse({ stopReason: "future_reason" }))
      .toThrow("unsupported");
  });

  test("tolerates unprojected update kinds but rejects malformed recognized values", () => {
    expect(parseDevinSessionUpdate({
      sessionId: "session-1",
      update: { sessionUpdate: "_cognition.ai/future", arbitrary: { secret: "discarded" } },
    })).toEqual([{
      type: "protocolNotice",
      sessionId: "session-1",
      method: "session/update:_cognition.ai/future",
      disposition: "unprojected_update",
    }]);
    for (const update of [
      { sessionUpdate: "agent_message_chunk", content: { type: "text" } },
      { sessionUpdate: "tool_call", toolCallId: "tool", title: 42 },
      { sessionUpdate: "plan", entries: new Array(129).fill({}) },
      { sessionUpdate: "usage_update", used: -1, size: 5 },
      { sessionUpdate: "usage_update", used: 1, size: 1.5 },
    ]) {
      expect(() => parseDevinSessionUpdate({ sessionId: "session-1", update }))
        .toThrow(DevinError);
    }
  });

  test("rejects batches and malformed JSON-RPC envelopes", () => {
    expect(() => parseDevinInboundMessage([])).toThrow("does not admit JSON-RPC batches");
    expect(() => parseDevinInboundMessage({ jsonrpc: "2.0", id: null, method: "x" }))
      .toThrow("cannot be null");
    expect(() => parseDevinInboundMessage({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: 1, message: "both" },
    })).toThrow("malformed");
  });

  test("sanitizes provider error messages and discards error data", () => {
    expect(parseDevinInboundMessage({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32_000, message: "token=super-secret-value", data: { private: true } },
    })).toEqual({
      kind: "errorResponse",
      id: 1,
      error: { code: -32_000, message: "[protected]" },
    });
  });

  test("redacts every canonical unlabelled credential family", () => {
    const credentials = [
      ["gl", "pat-"].join("") + "A".repeat(20),
      ["h", "f_"].join("") + "A".repeat(30),
      ["np", "m_"].join("") + "A".repeat(36),
      ["AI", "za"].join("") + "A".repeat(35),
      "Aa1" + "A".repeat(37),
    ];
    for (const credential of credentials) {
      expect(sanitizeDevinText(credential)).toBe("[protected]");
    }
  });

  test("redacts UNC paths without depending on slash style", () => {
    expect(sanitizeDevinText("Read \\\\server\\share\\private.txt for details"))
      .toBe("Read [local-path] for details");
  });
});
