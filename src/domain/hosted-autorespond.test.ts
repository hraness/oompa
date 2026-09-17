import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  HOSTED_REPLY_CEILING_MAX_MICRO_USD,
  HOSTED_REPLY_CEILING_MIN_MICRO_USD,
  hostedAutorespondOrigin,
  hostedAutorespondReplySchema,
  hostedAutorespondRequestSchema,
  hostedCreditsRequiredSchema,
  hostedReplyCeilingMicroUsd,
  hostedReplyEstimateMicroUsd,
  hostedReplyListPriceMicroUsd,
  microUsdFromReportedUsd,
} from "./hosted-autorespond";
import { gatewayChatCompletionRequest, replyFromGatewayBody, usageFromGatewayBody } from "./prose-gateway";

describe("hostedAutorespondOrigin", () => {
  test("maps the functions host of a Convex deployment to its HTTP host and nothing else", () => {
    expect(hostedAutorespondOrigin("https://qualified-hummingbird-537.convex.cloud")).toBe("https://qualified-hummingbird-537.convex.site");
    for (const rejected of [
      "http://qualified-hummingbird-537.convex.cloud",
      "https://qualified-hummingbird-537.convex.site",
      "https://qualified-hummingbird-537.convex.cloud/path",
      "https://qualified-hummingbird-537.convex.cloud/?q=1",
      "https://evil.example/qualified-hummingbird-537.convex.cloud",
      "https://qualified-hummingbird-537.convex.cloud.evil.example",
      "not a url",
    ]) {
      expect(() => hostedAutorespondOrigin(rejected)).toThrow();
    }
  });
});

describe("hosted reply pricing laws", () => {
  test("the ceiling is monotonic in prompt size and always within its bounds", () => {
    fc.assert(fc.property(fc.nat({ max: 1_000_000 }), fc.nat({ max: 1_000_000 }), (a, b) => {
      const [small, large] = a <= b ? [a, b] : [b, a];
      const lower = hostedReplyCeilingMicroUsd(small);
      const upper = hostedReplyCeilingMicroUsd(large);
      return lower <= upper
        && lower >= HOSTED_REPLY_CEILING_MIN_MICRO_USD
        && upper <= HOSTED_REPLY_CEILING_MAX_MICRO_USD
        && Number.isSafeInteger(lower) && Number.isSafeInteger(upper);
    }));
  });

  test("the ceiling covers the uplifted estimate until the cap", () => {
    fc.assert(fc.property(fc.nat({ max: 200_000 }), (characters) => {
      const ceiling = hostedReplyCeilingMicroUsd(characters);
      const uplifted = Math.ceil(hostedReplyEstimateMicroUsd(characters) * 1.25);
      return ceiling === Math.min(HOSTED_REPLY_CEILING_MAX_MICRO_USD, Math.max(HOSTED_REPLY_CEILING_MIN_MICRO_USD, uplifted));
    }));
  });

  test("list price is additive in tokens and never zero for a non-empty call", () => {
    fc.assert(fc.property(fc.nat({ max: 10_000_000 }), fc.nat({ max: 10_000_000 }), (promptTokens, completionTokens) => {
      const total = hostedReplyListPriceMicroUsd({ completionTokens, promptTokens });
      const split = hostedReplyListPriceMicroUsd({ completionTokens: 0, promptTokens })
        + hostedReplyListPriceMicroUsd({ completionTokens, promptTokens: 0 });
      return total === split && Number.isSafeInteger(total) && (promptTokens + completionTokens === 0 || total > 0);
    }));
  });

  test("reported dollars convert to micro-USD without binary drift", () => {
    expect(microUsdFromReportedUsd(0.000123)).toBe(123);
    expect(microUsdFromReportedUsd(0.0011)).toBe(1_100);
    expect(microUsdFromReportedUsd(0)).toBe(0);
    fc.assert(fc.property(fc.nat({ max: 1_000_000_000 }), (micro) => microUsdFromReportedUsd(micro / 1_000_000) === micro));
  });
});

describe("hosted autorespond wire contract", () => {
  const request = {
    assistantTail: "Should I proceed?",
    attempt: "0f1e2d3c-4b5a-5697-8877-66554433221f",
    report: { reason: "should i proceed", state: "needs_approval", verbatimRequired: false },
    version: 1,
  };

  test("parses exact requests and rejects unknown keys, oversized tails, and malformed attempts", () => {
    expect(hostedAutorespondRequestSchema.safeParse(request).success).toBe(true);
    expect(hostedAutorespondRequestSchema.safeParse({ ...request, verbatimLiteral: "APPROVE" }).success).toBe(true);
    expect(hostedAutorespondRequestSchema.safeParse({ ...request, sessionId: "sess_1" }).success).toBe(false);
    expect(hostedAutorespondRequestSchema.safeParse({ ...request, assistantTail: "x".repeat(4_001) }).success).toBe(false);
    expect(hostedAutorespondRequestSchema.safeParse({ ...request, assistantTail: "" }).success).toBe(false);
    expect(hostedAutorespondRequestSchema.safeParse({ ...request, attempt: "turn-1" }).success).toBe(false);
    expect(hostedAutorespondRequestSchema.safeParse({ ...request, report: { ...request.report, state: "elsewhere" } }).success).toBe(false);
  });

  test("parses replies and credits-required payloads with the service's optional fields", () => {
    expect(hostedAutorespondReplySchema.safeParse({
      charged: null, latencyMs: 3, lowBalance: null, model: "openai/gpt-5-nano", reply: "ok", version: 1,
    }).success).toBe(true);
    expect(hostedAutorespondReplySchema.safeParse({
      charged: { microUsd: 1_100, usd: "0.00" }, latencyMs: 3, lowBalance: false, model: "m", reply: "x".repeat(2_001), version: 1,
    }).success).toBe(false);
    expect(hostedCreditsRequiredSchema.safeParse({
      error: "credits_required", message: "m", operation: "assistant_reply", reason: "subject_missing",
    }).success).toBe(true);
    expect(hostedCreditsRequiredSchema.safeParse({
      error: "credits_required", message: "m", operation: "model_tokens", reason: "subject_missing",
    }).success).toBe(false);
  });

  test("the shared gateway helpers bound the tail, read one reply, and report usage only when whole", () => {
    const body = gatewayChatCompletionRequest({ assistantTail: "y".repeat(9_000), report: { reason: "r", state: null } });
    expect(body.messages[1]?.content.length).toBeLessThan(4_200);
    expect(body).toMatchObject({ model: "openai/gpt-5-nano", reasoning_effort: "minimal", stream: false });
    expect(replyFromGatewayBody({ choices: [{ message: { content: " hi " } }] })).toBe("hi");
    expect(() => replyFromGatewayBody({ choices: [{ message: { content: "" } }] })).toThrow();
    expect(usageFromGatewayBody({ usage: { completion_tokens: 2, cost: 0.5, prompt_tokens: 1 } }))
      .toEqual({ completionTokens: 2, costUsd: 0.5, promptTokens: 1 });
    expect(usageFromGatewayBody({ usage: { completion_tokens: 2, cost: -1, prompt_tokens: 1 } }))
      .toEqual({ completionTokens: 2, promptTokens: 1 });
    expect(usageFromGatewayBody({ usage: { completion_tokens: "2", prompt_tokens: 1 } })).toBeNull();
    expect(usageFromGatewayBody({})).toBeNull();
  });
});
