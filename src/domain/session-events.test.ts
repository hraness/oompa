import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fc from "fast-check";

import {
  projectPublicProviderIdentifier,
  publicProviderIdentifierSchema,
} from "../public-provider-identifier";
import { createProfileId, createSessionId } from "./values";
import {
  advanceSessionEventContinuity,
  initialSessionEventContinuity,
  SESSION_EVENT_MAX_BYTES,
  SESSION_EVENT_PAGE_BYTES,
  SESSION_EVENT_PUBLIC_MAX_BYTES,
  sessionEventBodySchema,
  sessionEventCursorPayloadSchema,
  sessionEventCursorWireSchema,
  sessionEventPageSchema,
  sessionEventSchema,
} from "./session-events";

const providerIdentifierKey = Buffer.alloc(32, 0x31);
const publicProviderId = (value: string) =>
  projectPublicProviderIdentifier(value, providerIdentifierKey);
const cursorWireSignature = "A".repeat(43);
const cursorWire = (label: string): string =>
  `hra1.${Buffer.from(`fixture:${label}`).toString("base64url")}.${cursorWireSignature}`;

describe("session events", () => {
  test("accepts only canonical event cursor payloads and signatures", () => {
    const valid = cursorWire("valid");
    const [, payload, signature] = valid.split(".");
    expect(sessionEventCursorWireSchema.parse(valid)).toBe(valid);
    expect(sessionEventCursorWireSchema.safeParse(
      `hra1.${payload}=.${signature}`,
    ).success).toBe(false);
    expect(sessionEventCursorWireSchema.safeParse(
      `hra1.Zh.${signature}`,
    ).success).toBe(false);
    expect(sessionEventCursorWireSchema.safeParse(
      `hra1.${payload}.${"A".repeat(42)}B`,
    ).success).toBe(false);
    expect(sessionEventCursorWireSchema.safeParse(
      `hra1.${payload}.${signature}=`,
    ).success).toBe(false);
  });

  test("projects every provider identifier with one keyed, lossless public namespace", () => {
    const key = providerIdentifierKey;
    const otherKey = Buffer.alloc(32, 0x32);
    const project = (value: string) => projectPublicProviderIdentifier(value, key);
    const safe = project("turn-safe_1:part.2");
    expect(safe).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);

    const privatePath = `${["", "Users", "private"].join("/")}/api_key=TURN-SECRET-1234`;
    const projectedPath = project(privatePath);
    const projectedLong = project("x".repeat(201));
    expect(projectedPath).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(project(privatePath)).toBe(projectedPath);
    expect(projectPublicProviderIdentifier(privatePath, otherKey)).not.toBe(projectedPath);
    expect(projectedLong).toMatch(/^opaque_v2_[a-f0-9]{64}$/u);
    expect(projectedLong).not.toBe(projectedPath);
    expect(project(projectedPath)).not.toBe(projectedPath);
    expect(project("\ud800")).not.toBe(project("\ud801"));
    expect(projectedPath).not.toContain(
      createHash("sha256").update(privatePath, "utf8").digest("hex"),
    );
    expect(publicProviderIdentifierSchema.parse(projectedPath)).toBe(projectedPath);
    expect(publicProviderIdentifierSchema.safeParse("turn-1").success).toBe(false);
    expect(publicProviderIdentifierSchema.safeParse("item_1").success).toBe(false);
    expect(() => sessionEventBodySchema.parse({
      type: "turn_started",
      turnId: privatePath,
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "turn_started",
      turnId: "x".repeat(201),
    })).toThrow();
  });

  test("keeps tool lifecycle identity optional, bounded, and backwards compatible", () => {
    const exactUtf8Boundary = `${"界".repeat(85)}a`;
    const overUtf8Boundary = `${exactUtf8Boundary}b`;
    expect(new TextEncoder().encode(exactUtf8Boundary).byteLength).toBe(256);
    expect(new TextEncoder().encode(overUtf8Boundary).byteLength).toBe(257);
    expect(sessionEventBodySchema.parse({
      type: "item_started",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-tool"),
      itemKind: "mcpToolCall",
      server: exactUtf8Boundary,
      tool: "create_issue",
    })).toMatchObject({ server: exactUtf8Boundary, tool: "create_issue" });
    expect(sessionEventBodySchema.parse({
      type: "item_completed",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-tool"),
      itemKind: "mcpToolCall",
      status: "completed",
    })).not.toHaveProperty("server");
    expect(() => sessionEventBodySchema.parse({
      type: "item_started",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-tool"),
      itemKind: "mcpToolCall",
      server: "s".repeat(257),
      tool: "create_issue",
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "item_completed",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-tool"),
      itemKind: "mcpToolCall",
      server: "github",
      tool: "",
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "item_completed",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-tool"),
      itemKind: "mcpToolCall",
      server: "github",
      tool: overUtf8Boundary,
    })).toThrow();
  });

  test("accepts provider-visible summary deltas and excludes raw reasoning or command output fields", () => {
    const safe = sessionEventBodySchema.parse({
      type: "reasoning_summary_delta",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-1"),
      text: "Checking the public contract.",
    });
    expect(safe.type).toBe("reasoning_summary_delta");
    expect(() => sessionEventBodySchema.parse({
      type: "reasoning_summary_delta",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-1"),
      text: "safe",
      rawReasoning: "hidden",
    })).toThrow();
    expect(sessionEventBodySchema.parse({
      type: "item_started",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-2"),
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: "a".repeat(64),
    })).toMatchObject({ liveAcceptanceCommandDigest: "a".repeat(64) });
    expect(() => sessionEventBodySchema.parse({
      type: "item_started",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-2"),
      itemKind: "commandExecution",
      liveAcceptanceCommandDigest: "not-a-digest",
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "tool_progress",
      turnId: publicProviderId("turn-1"),
      itemId: publicProviderId("item-2"),
      toolKind: "command",
      output: "secret output",
    })).toThrow();
  });

  test("preserves only bounded, provider-reported cost on token usage events", () => {
    const usage = sessionEventBodySchema.parse({
      type: "token_usage",
      turnId: publicProviderId("turn-usage"),
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      reasoningOutputTokens: null,
      totalTokens: 53_000,
      modelContextWindow: 200_000,
      providerCost: { amount: 0.01, currency: "USD" },
    });
    expect(usage).toMatchObject({ providerCost: { amount: 0.01, currency: "USD" } });
    expect(() => sessionEventBodySchema.parse({
      ...usage,
      providerCost: { amount: 0.01, currency: "usd" },
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      ...usage,
      providerCost: { amount: -0.01, currency: "USD" },
    })).toThrow();
  });

  test("bounds compaction events to closed enums, exact integers, and one nullable turn identifier", () => {
    const outcomes = ["requested", "completed", "failed"] as const;
    const triggers = ["manual", "policy", "provider"] as const;
    for (const outcome of outcomes) {
      for (const trigger of triggers) {
        expect(sessionEventBodySchema.parse({
          type: "compaction",
          outcome,
          trigger,
          turnId: null,
        })).toMatchObject({ type: "compaction", outcome, trigger, turnId: null });
      }
    }
    const completed = sessionEventBodySchema.parse({
      type: "compaction",
      outcome: "completed",
      trigger: "provider",
      strategy: "native",
      preTokens: 120_000,
      postTokens: 4_096,
      turnId: publicProviderId("turn-compacted"),
    });
    expect(completed).toMatchObject({ strategy: "native", preTokens: 120_000 });
    for (const malformed of [
      { outcome: "unknown" },
      { trigger: "automatic" },
      { strategy: "x".repeat(65) },
      { preTokens: -1 },
      { preTokens: 1.5 },
      { preTokens: Number.MAX_SAFE_INTEGER + 1 },
      { postTokens: -0.5 },
      { turnId: "turn-raw-provider-identifier" },
      { turnId: "x".repeat(201) },
      { error: "provider free text" },
      { payload: { arbitrary: "provider payload" } },
    ]) {
      expect(sessionEventBodySchema.safeParse({
        type: "compaction",
        outcome: "completed",
        trigger: "provider",
        turnId: null,
        ...malformed,
      }).success).toBe(false);
    }
  });

  test("accepts a revisioned session state and rejects an out-of-range or overlong reason", () => {
    const parsed = sessionEventBodySchema.parse({
      type: "session_state",
      state: "needs_approval",
      attention: true,
      reason: "Turn asked for a single approval.",
      verbatimRequired: false,
      lastActivityAt: Date.now(),
      revision: 1,
    });
    expect(parsed).toMatchObject({ type: "session_state", state: "needs_approval", revision: 1 });
    expect(() => sessionEventBodySchema.parse({
      type: "session_state",
      state: "invalid_state",
      attention: true,
      reason: "x",
      verbatimRequired: false,
      lastActivityAt: Date.now(),
      revision: 1,
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "session_state",
      state: "done",
      attention: false,
      reason: "x".repeat(257),
      verbatimRequired: false,
      lastActivityAt: Date.now(),
      revision: 1,
    })).toThrow();
    expect(() => sessionEventBodySchema.parse({
      type: "session_state",
      state: "done",
      attention: false,
      reason: "x",
      verbatimRequired: false,
      lastActivityAt: Date.now(),
      revision: 0,
    })).toThrow();
  });

  test("retains peer-session authorship without accepting caller-defined actors", () => {
    expect(sessionEventBodySchema.parse({
      type: "user_message",
      turnId: null,
      actor: "peer_session",
      text: "Untrusted coordination from another Oompa session.",
      omittedCharacters: 0,
    })).toMatchObject({ actor: "peer_session" });
    expect(() => sessionEventBodySchema.parse({
      type: "user_message",
      turnId: null,
      actor: "owner",
      text: "Forged authority.",
      omittedCharacters: 0,
    })).toThrow();
  });

  test("keeps all public envelopes bounded and session-account fenced", () => {
    const parsed = sessionEventSchema.parse({
      version: 1,
      sessionId: createSessionId(),
      streamEpoch: crypto.randomUUID(),
      sequence: 1,
      recordedAt: Date.now(),
      accountId: createProfileId(),
      providerGeneration: 2,
      providerConnectionId: crypto.randomUUID(),
      body: { type: "warning", code: "provider_warning", message: "A bounded warning." },
    });
    expect(parsed.sequence).toBe(1);
  });

  test("enforces exact serialized event and page UTF-8 byte bounds", () => {
    const sessionId = createSessionId();
    const accountId = createProfileId();
    const streamEpoch = crypto.randomUUID();
    const encoder = new TextEncoder();
    const sizedEvent = (sequence: number, targetBytes: number) => {
      const base = {
        version: 1 as const,
        sessionId,
        streamEpoch,
        sequence,
        recordedAt: 1_700_000_000_000,
        accountId,
        providerGeneration: 1,
        providerConnectionId: null,
        body: {
          type: "assistant_delta" as const,
          turnId: publicProviderId("turn-bounded"),
          itemId: publicProviderId("item-bounded"),
          text: "",
        },
      };
      const baseBytes = encoder.encode(JSON.stringify(base)).byteLength;
      if (targetBytes < baseBytes) throw new Error("Target event size is below its envelope.");
      const textBytes = targetBytes - baseBytes;
      const event = {
        ...base,
        body: {
          ...base.body,
          text: `${"界".repeat(Math.floor(textBytes / 3))}${"x".repeat(textBytes % 3)}`,
        },
      };
      expect(encoder.encode(JSON.stringify(event)).byteLength).toBe(targetBytes);
      return event;
    };

    expect(sessionEventSchema.safeParse(sizedEvent(1, SESSION_EVENT_MAX_BYTES)).success)
      .toBe(true);
    expect(sessionEventSchema.safeParse(sizedEvent(1, SESSION_EVENT_PUBLIC_MAX_BYTES)).success)
      .toBe(true);
    expect(sessionEventSchema.safeParse(sizedEvent(1, SESSION_EVENT_PUBLIC_MAX_BYTES + 1)).success)
      .toBe(false);

    const pageTargets = Array.from({ length: 8 }, () => 58_000);
    pageTargets.push(SESSION_EVENT_PAGE_BYTES - 58_000 * 8);
    const pageEvents = pageTargets.map((target, index) => sizedEvent(index + 1, target));
    const page = {
      version: 1 as const,
      sessionId,
      requestedCursor: null,
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire("observed"),
      nextCursor: cursorWire("next"),
      gap: null,
      events: pageEvents,
    };
    expect(sessionEventPageSchema.safeParse(page).success).toBe(true);
    const last = pageEvents.at(-1);
    if (last === undefined) {
      throw new Error("Expected the final bounded assistant event.");
    }
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [
        ...pageEvents.slice(0, -1),
        { ...last, body: { ...last.body, text: `${last.body.text}x` } },
      ],
    }).success).toBe(false);
  });

  test("reserves zero for cursors while requiring positive event and retention sequences", () => {
    const sessionId = createSessionId();
    const accountId = createProfileId();
    const streamEpoch = crypto.randomUUID();
    expect(sessionEventCursorPayloadSchema.safeParse({
      version: 1,
      sessionId,
      streamEpoch,
      sequence: 0,
    }).success).toBe(true);
    const zeroEvent = {
      version: 1 as const,
      sessionId,
      streamEpoch,
      sequence: 0,
      recordedAt: 1,
      accountId,
      providerGeneration: 1,
      providerConnectionId: null,
      body: { type: "warning" as const, code: "ZERO", message: "invalid" },
    };
    expect(sessionEventSchema.safeParse(zeroEvent).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      version: 1,
      sessionId,
      requestedCursor: cursorWire("cursor-0"),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire("observed"),
      nextCursor: cursorWire("next"),
      gap: { reason: "retention_count", requestedSequence: 0, retainedFromSequence: 0 },
      events: [],
    }).success).toBe(false);
  });

  test("rejects contradictory event pages before any one-shot or follower output", () => {
    const sessionId = createSessionId();
    const accountId = createProfileId();
    const firstEpoch = crypto.randomUUID();
    const event = (
      sequence: number,
      streamEpoch = firstEpoch,
      boundSession = sessionId,
      boundAccount = accountId,
    ) => ({
      version: 1 as const,
      sessionId: boundSession,
      streamEpoch,
      sequence,
      recordedAt: 1,
      accountId: boundAccount,
      providerGeneration: 1,
      providerConnectionId: null,
      body: { type: "turn_started" as const, turnId: publicProviderId("turn-1") },
    });
    const page = {
      version: 1 as const,
      sessionId,
      requestedCursor: cursorWire("cursor-0"),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire("cursor-2"),
      nextCursor: cursorWire("cursor-2"),
      gap: null,
      events: [event(1), event(2)],
    };
    expect(sessionEventPageSchema.safeParse(page).success).toBe(true);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [event(2), event(2)],
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [event(1), event(3)],
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [event(1), event(2, crypto.randomUUID())],
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [event(1, firstEpoch, createSessionId())],
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [event(1), event(2, firstEpoch, sessionId, createProfileId())],
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      gap: { reason: "retention_count", requestedSequence: 0, retainedFromSequence: 2 },
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      nextCursor: page.requestedCursor,
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [],
      nextCursor: page.requestedCursor,
    }).success).toBe(true);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      events: [],
      nextCursor: cursorWire("advanced-without-evidence"),
    }).success).toBe(false);
    expect(sessionEventPageSchema.safeParse({
      ...page,
      requestedCursor: null,
      events: [],
      nextCursor: cursorWire("initial-signed-checkpoint"),
    }).success).toBe(true);
  });

  test("tracks exact sequence, account, and restored epoch continuity across pages", () => {
    const sessionId = createSessionId();
    const accountId = createProfileId();
    const otherAccountId = createProfileId();
    const oldEpoch = crypto.randomUUID();
    const newEpoch = crypto.randomUUID();
    const event = (sequence: number, streamEpoch = oldEpoch, eventAccountId = accountId) => ({
      version: 1 as const,
      sessionId,
      streamEpoch,
      sequence,
      recordedAt: sequence,
      accountId: eventAccountId,
      providerGeneration: 1,
      providerConnectionId: null,
      body: { type: "warning" as const, code: "NOTICE", message: "bounded" },
    });
    const page = (input: Readonly<{
      events: ReturnType<typeof event>[];
      gap?: {
        reason: "stream_restored" | "retention_age";
        requestedSequence: number | null;
        retainedFromSequence: number;
      };
      nextCursor: string;
      requestedCursor: string | null;
    }>) => sessionEventPageSchema.parse({
      version: 1,
      sessionId,
      requestedCursor: input.requestedCursor === null
        ? null
        : cursorWire(input.requestedCursor),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire(input.nextCursor),
      nextCursor: cursorWire(input.nextCursor),
      gap: input.gap ?? null,
      events: input.events,
    });

    const first = advanceSessionEventContinuity(
      initialSessionEventContinuity(),
      page({ requestedCursor: null, nextCursor: "old-1", events: [event(1)] }),
    );
    expect(() => advanceSessionEventContinuity(first, page({
      requestedCursor: "old-1",
      nextCursor: "old-3",
      events: [event(3)],
    }))).toThrow("SESSION_EVENT_CONTINUITY_SEQUENCE_MISMATCH");
    // `oompa session switch` can move one conversation to another account, so a
    // page under a new account continues the same stream instead of failing.
    // Sequence and epoch continuity are still enforced across that boundary.
    const switched = advanceSessionEventContinuity(first, page({
      requestedCursor: "old-1",
      nextCursor: "old-2",
      events: [event(2, oldEpoch, otherAccountId)],
    }));
    expect(switched.accountId).toBe(otherAccountId);
    expect(switched.expectedSequence).toBe(3);
    expect(() => advanceSessionEventContinuity(switched, page({
      requestedCursor: "old-2",
      nextCursor: "old-4",
      events: [event(4, oldEpoch, otherAccountId)],
    }))).toThrow("SESSION_EVENT_CONTINUITY_SEQUENCE_MISMATCH");

    const awaitingRestoredEpoch = advanceSessionEventContinuity(first, page({
      requestedCursor: "old-1",
      nextCursor: "restored-0",
      gap: { reason: "stream_restored", requestedSequence: 1, retainedFromSequence: 1 },
      events: [],
    }));
    expect(() => advanceSessionEventContinuity(awaitingRestoredEpoch, page({
      requestedCursor: "restored-0",
      nextCursor: "restored-1",
      events: [event(1)],
    }))).toThrow("SESSION_EVENT_CONTINUITY_RESTORED_EPOCH_DID_NOT_CHANGE");
    // A restored stream under a switched account still has to change epoch.
    expect(advanceSessionEventContinuity(awaitingRestoredEpoch, page({
      requestedCursor: "restored-0",
      nextCursor: "restored-foreign-account",
      events: [event(1, newEpoch, otherAccountId)],
    })).accountId).toBe(otherAccountId);
    expect(() => advanceSessionEventContinuity(awaitingRestoredEpoch, page({
      requestedCursor: "restored-0",
      nextCursor: "restored-foreign-account",
      events: [event(1, oldEpoch, otherAccountId)],
    }))).toThrow("SESSION_EVENT_CONTINUITY_RESTORED_EPOCH_DID_NOT_CHANGE");

    const restored = advanceSessionEventContinuity(awaitingRestoredEpoch, page({
      requestedCursor: "restored-0",
      nextCursor: "restored-1",
      events: [event(1, newEpoch)],
    }));
    expect(restored).toMatchObject({
      accountId,
      expectedSequence: 2,
      lastEvent: { sequence: 1, streamEpoch: newEpoch },
      requiredEpochChangeFrom: null,
    });
    expect(() => advanceSessionEventContinuity(restored, page({
      requestedCursor: "restored-1",
      nextCursor: "gap-backward",
      gap: { reason: "retention_age", requestedSequence: 1, retainedFromSequence: 1 },
      events: [],
    }))).toThrow("SESSION_EVENT_CONTINUITY_GAP_MOVED_BACKWARD");
  });

  test("is total over arbitrary candidate bodies", () => {
    fc.assert(fc.property(fc.jsonValue(), (value) => {
      const result = sessionEventBodySchema.safeParse(value);
      expect(typeof result.success).toBe("boolean");
    }), { numRuns: 500 });
  });
});
