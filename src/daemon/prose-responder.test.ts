import { describe, expect, test } from "bun:test";

import {
  AI_GATEWAY_CHAT_COMPLETIONS_URL,
  AiGatewayProseResponder,
  DeterministicProseResponder,
  HostedProseResponder,
  PROSE_APPROVAL_REPLY,
  PROSE_RESPONDER_MODEL,
  ProseCreditsRequiredError,
  ProseResponderError,
  SelectingProseResponder,
  proseResponderSystemPrompt,
  proseResponderUserPrompt,
} from "./prose-responder";
import type { SessionStateReport } from "../domain/session-state";

// Twenty-four printable characters, assembled rather than written, so no
// credential-shaped literal enters the repository.
const testKey = ["gw", "k".repeat(22)].join("");

const report: SessionStateReport = {
  version: 1,
  session: `sess_${"1".repeat(32)}`,
  state: "needs_approval",
  attention: false,
  reason: "should i proceed",
  verbatimRequired: false,
  lastActivityAt: 1_000,
  revision: 2,
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

describe("prose responder prompts", () => {
  test("asks for the fixed sentence when no verbatim literal is required", () => {
    const prompt = proseResponderSystemPrompt(undefined);
    expect(prompt).toContain("The human has already reviewed the request and approved it.");
    expect(prompt).toContain(PROSE_APPROVAL_REPLY);
    expect(prompt).toContain("reply text only");
  });

  test("asks for exactly the literal when one is required", () => {
    const prompt = proseResponderSystemPrompt("APPROVE MIGRATION");
    expect(prompt).toContain("Answer with exactly this literal and nothing else: APPROVE MIGRATION");
    expect(prompt).not.toContain(PROSE_APPROVAL_REPLY);
  });

  test("bounds the assistant tail it forwards", () => {
    const prompt = proseResponderUserPrompt({
      assistantTail: "x".repeat(9_000),
      report,
    });
    expect(prompt.length).toBeLessThan(4_400);
    expect(prompt).toContain("Session state: needs_approval.");
  });
});

describe("AiGatewayProseResponder", () => {
  test("posts one bearer-authenticated minimal-effort call and returns the reply", async () => {
    const seen: Array<Readonly<{ body: string; headers: Readonly<Record<string, string>>; url: string }>> = [];
    let clock = 100;
    const responder = new AiGatewayProseResponder({
      fetch: (url, init) => {
        seen.push({ body: init.body, headers: init.headers, url });
        clock = 137;
        return Promise.resolve(jsonResponse({
          choices: [{ message: { content: "  The human has approved. Proceed accordingly.  " } }],
        }));
      },
      now: () => clock,
      readKey: () => Promise.resolve(testKey),
    });

    const result = await responder.respond(
      { assistantTail: "Should I proceed?", report },
      new AbortController().signal,
    );

    expect(result).toEqual({
      latencyMs: 37,
      model: PROSE_RESPONDER_MODEL,
      reply: PROSE_APPROVAL_REPLY,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(AI_GATEWAY_CHAT_COMPLETIONS_URL);
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${testKey}`);
    const request = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(request.model).toBe(PROSE_RESPONDER_MODEL);
    expect(request.reasoning_effort).toBe("minimal");
    expect(request.stream).toBe(false);
    // The key never appears in the URL or the request body.
    expect(seen[0]?.url).not.toContain(testKey);
    expect(seen[0]?.body).not.toContain(testKey);
  });

  test("refuses without a configured key and never calls the gateway", async () => {
    let calls = 0;
    const responder = new AiGatewayProseResponder({
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({}));
      },
      readKey: () => Promise.resolve(null),
    });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
    expect(calls).toBe(0);
  });

  test("does not retry a refused call and never leaks the key in the error", async () => {
    let calls = 0;
    const responder = new AiGatewayProseResponder({
      fetch: () => {
        calls += 1;
        return Promise.resolve(jsonResponse({ error: "nope" }, 429));
      },
      readKey: () => Promise.resolve(testKey),
    });
    const failure = await responder
      .respond({ assistantTail: "ask", report }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(ProseResponderError);
    expect((failure as Error).message).toContain("429");
    expect((failure as Error).message).not.toContain(testKey);
  });

  test("refuses a response without usable reply text", async () => {
    const responder = new AiGatewayProseResponder({
      fetch: () => Promise.resolve(jsonResponse({ choices: [] })),
      readKey: () => Promise.resolve(testKey),
    });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
  });

  test("aborts the call when its own deadline passes", async () => {
    const responder = new AiGatewayProseResponder({
      fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        }, { once: true });
      }),
      readKey: () => Promise.resolve(testKey),
      timeoutMs: 5,
    });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
  });
});

describe("DeterministicProseResponder", () => {
  test("answers with the fixed sentence and echoes a required literal", async () => {
    const responder = new DeterministicProseResponder();
    const signal = new AbortController().signal;
    expect((await responder.respond({ assistantTail: "ask", report }, signal)).reply)
      .toBe(PROSE_APPROVAL_REPLY);
    expect((await responder.respond(
      { assistantTail: "ask", report, verbatimLiteral: "APPROVE MIGRATION" },
      signal,
    )).reply).toBe("APPROVE MIGRATION");
    expect(responder.calls).toHaveLength(2);
  });

  test("rejects when configured to fail", async () => {
    const responder = new DeterministicProseResponder({ failure: "gateway unavailable" });
    await expect(responder.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);
  });
});

describe("HostedProseResponder", () => {
  // Token grammar from the credits service, assembled so no credential-shaped literal enters the repository.
  const testToken = ["cr_dev_", "t".repeat(43)].join("");
  const attempt = "0f1e2d3c-4b5a-5697-8877-66554433221f";
  const origin = "https://deployment.convex.site";
  const insufficient = {
    balance: { availableMicroUsd: 0, credits: 0, microUsd: 0, usd: "0.00" },
    error: "credits_required" as const,
    message: "Oompa needs $0.01 in credits for one hosted autorespond reply; this device has $0.00 available.",
    operation: "assistant_reply" as const,
    reason: "insufficient_credits" as const,
    required: { credits: 1, microUsd: 10_000, usd: "0.01" },
    topup: {
      claimId: "clm_8f3k2q",
      expiresAt: "2026-09-18T12:00:00.000Z",
      packs: [{ bonusCredits: 0, credits: 1000, id: "p10", usd: 10 }],
      suggestedPackId: "p10",
      url: "https://credits.hraness.com/t/clm_8f3k2q",
    },
  };

  test("posts the bounded prompt input with the credits token in a header only and returns the backend reply", async () => {
    const seen: Array<Readonly<{ body: string; headers: Readonly<Record<string, string>>; url: string }>> = [];
    let clock = 500;
    const responder = new HostedProseResponder({
      fetch: (url, init) => {
        seen.push({ body: init.body, headers: init.headers, url });
        clock = 541;
        return Promise.resolve(jsonResponse({
          charged: { credits: 0, microUsd: 1_100, usd: "0.00" },
          latencyMs: 30,
          lowBalance: false,
          model: PROSE_RESPONDER_MODEL,
          reply: PROSE_APPROVAL_REPLY,
          version: 1,
        }));
      },
      now: () => clock,
      origin,
      readToken: () => Promise.resolve(testToken),
    });
    const result = await responder.respond(
      { assistantTail: "x".repeat(5_000), attempt, report, verbatimLiteral: "APPROVE" },
      new AbortController().signal,
    );
    expect(result).toEqual({ latencyMs: 41, model: PROSE_RESPONDER_MODEL, reply: PROSE_APPROVAL_REPLY });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`${origin}/v1/autorespond`);
    expect(seen[0]?.headers["x-hraness-credits-subject"]).toBe(testToken);
    expect(seen[0]?.headers.authorization).toBeUndefined();
    const request = JSON.parse(seen[0]?.body ?? "{}") as Record<string, unknown>;
    expect(request).toEqual({
      assistantTail: "x".repeat(4_000),
      attempt,
      report: { reason: report.reason, state: report.state, verbatimRequired: report.verbatimRequired },
      verbatimLiteral: "APPROVE",
      version: 1,
    });
    expect(seen[0]?.body).not.toContain(testToken);
    expect(seen[0]?.url).not.toContain(testToken);
  });

  test("refuses with credits required and never calls the backend when this device holds no token", async () => {
    let calls = 0;
    const responder = new HostedProseResponder({
      fetch: () => { calls += 1; return Promise.resolve(jsonResponse({})); },
      origin,
      readToken: () => Promise.resolve(null),
    });
    const failure = await responder
      .respond({ assistantTail: "ask", attempt, report }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProseCreditsRequiredError);
    expect((failure as ProseCreditsRequiredError).payload.reason).toBe("subject_missing");
    expect(calls).toBe(0);
  });

  test("turns a 402 into credits required carrying the backend's payment payload", async () => {
    const responder = new HostedProseResponder({
      fetch: () => Promise.resolve(jsonResponse(insufficient, 402)),
      origin,
      readToken: () => Promise.resolve(testToken),
    });
    const failure = await responder
      .respond({ assistantTail: "ask", attempt, report }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProseCreditsRequiredError);
    expect((failure as ProseCreditsRequiredError).payload).toEqual(insufficient);
    expect((failure as Error).message).not.toContain(testToken);
  });

  test("keeps a 402 outside the contract as a generic shortfall", async () => {
    const responder = new HostedProseResponder({
      fetch: () => Promise.resolve(jsonResponse({ error: "credits_required", unexpected: true }, 402)),
      origin,
      readToken: () => Promise.resolve(testToken),
    });
    const failure = await responder
      .respond({ assistantTail: "ask", attempt, report }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProseCreditsRequiredError);
    expect((failure as ProseCreditsRequiredError).payload.reason).toBe("insufficient_credits");
    expect((failure as ProseCreditsRequiredError).payload.topup).toBeUndefined();
  });

  test("does not retry other refusals, rejects replies outside the contract, and needs the attempt identity", async () => {
    let calls = 0;
    const refused = new HostedProseResponder({
      fetch: () => { calls += 1; return Promise.resolve(jsonResponse({ error: "responder_failed" }, 502)); },
      origin,
      readToken: () => Promise.resolve(testToken),
    });
    const failure = await refused
      .respond({ assistantTail: "ask", attempt, report }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(calls).toBe(1);
    expect(failure).toBeInstanceOf(ProseResponderError);
    expect(failure).not.toBeInstanceOf(ProseCreditsRequiredError);
    expect((failure as Error).message).toContain("502");

    const malformed = new HostedProseResponder({
      fetch: () => Promise.resolve(jsonResponse({ reply: "x".repeat(2_001), version: 1 })),
      origin,
      readToken: () => Promise.resolve(testToken),
    });
    await expect(malformed.respond({ assistantTail: "ask", attempt, report }, new AbortController().signal))
      .rejects.toBeInstanceOf(ProseResponderError);

    const oversized = new HostedProseResponder({
      fetch: () => Promise.resolve(new Response("[".repeat(70_000), { headers: { "content-type": "application/json" } })),
      origin,
      readToken: () => Promise.resolve(testToken),
    });
    await expect(oversized.respond({ assistantTail: "ask", attempt, report }, new AbortController().signal))
      .rejects.toThrow("exceeded the accepted bound");

    let unattemptedCalls = 0;
    const unattempted = new HostedProseResponder({
      fetch: () => { unattemptedCalls += 1; return Promise.resolve(jsonResponse({})); },
      origin,
      readToken: () => Promise.resolve(testToken),
    });
    await expect(unattempted.respond({ assistantTail: "ask", report }, new AbortController().signal))
      .rejects.toThrow("attempt identity");
    expect(unattemptedCalls).toBe(0);
  });
});

describe("SelectingProseResponder", () => {
  test("routes each call by the mode custody reports and refuses when nothing is configured", async () => {
    const gateway = new DeterministicProseResponder({ model: "gateway" });
    const hosted = new DeterministicProseResponder({ model: "hosted" });
    let mode: "gateway-key" | "hosted" | null = "gateway-key";
    const responder = new SelectingProseResponder({ gateway, hosted, readMode: () => Promise.resolve(mode) });
    const signal = new AbortController().signal;
    expect((await responder.respond({ assistantTail: "ask", report }, signal)).model).toBe("gateway");
    mode = "hosted";
    expect((await responder.respond({ assistantTail: "ask", report }, signal)).model).toBe("hosted");
    mode = null;
    await expect(responder.respond({ assistantTail: "ask", report }, signal)).rejects.toBeInstanceOf(ProseResponderError);
    expect(gateway.calls).toHaveLength(1);
    expect(hosted.calls).toHaveLength(1);
  });
});
