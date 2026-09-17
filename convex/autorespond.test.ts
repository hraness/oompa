import { describe, expect, test } from "bun:test";

import {
  handleHostedAutorespondRequest,
  hostedAutorespondConfiguration,
  settlementCost,
} from "./autorespond";
import {
  CREDITS_SUBJECT_HEADER,
  HOSTED_AUTORESPOND_PATH,
  HOSTED_REPLY_CEILING_MAX_MICRO_USD,
  HOSTED_REPLY_CEILING_MIN_MICRO_USD,
  hostedAutorespondReplySchema,
  hostedCreditsRequiredSchema,
  hostedReplyCeilingMicroUsd,
  hostedReplyEstimateMicroUsd,
  hostedReplyListPriceMicroUsd,
} from "../src/domain/hosted-autorespond";
import {
  AI_GATEWAY_CHAT_COMPLETIONS_URL,
  PROSE_APPROVAL_REPLY,
  PROSE_RESPONDER_MODEL,
  gatewayChatCompletionRequest,
} from "../src/domain/prose-gateway";

// Credentials are assembled from parts so no credential-shaped literal enters
// the repository. The shapes match the credits service's token grammars.
const productKey = ["cr_prod_", "p".repeat(43)].join("");
const deviceToken = ["cr_dev_", "d".repeat(43)].join("");
const gatewayKey = ["gw", "k".repeat(22)].join("");
const creditsOrigin = "https://credits.example.test";
const routeUrl = `https://deployment.convex.site${HOSTED_AUTORESPOND_PATH}`;
const attempt = "0f1e2d3c-4b5a-5697-8877-66554433221f";

const env = {
  AI_GATEWAY_API_KEY: gatewayKey,
  OOMPA_CREDITS_PRODUCT_KEY: productKey,
  OOMPA_CREDITS_SERVICE_ORIGIN: creditsOrigin,
};

type Seen = Readonly<{ body: unknown; headers: Headers; method: string; url: string }>;

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status });

const holdBody = {
  balance: { availableMicroUsd: 2_490_000, microUsd: 2_500_000 },
  ceilingMicroUsd: 10_000,
  expiresAt: "2026-09-17T13:00:00.000Z",
  holdId: "hold_1",
};
const settleBody = {
  balance: { availableMicroUsd: 2_498_900, microUsd: 2_498_900 },
  chargedMicroUsd: 1_100,
  holdId: "hold_1",
  lowBalance: false,
  state: "settled",
};
const releaseBody = { balance: { availableMicroUsd: 2_500_000, microUsd: 2_500_000 }, holdId: "hold_1", state: "released" };
const insufficientBody = {
  balance: { availableMicroUsd: 0, credits: 0, microUsd: 0, usd: "0.00" },
  error: "insufficient_credits",
  required: { credits: 1, microUsd: 10_000, usd: "0.01" },
  topup: {
    claimId: "clm_8f3k2q",
    expiresAt: "2026-09-18T12:00:00.000Z",
    packs: [
      { bonusCredits: 0, credits: 1000, id: "p10", label: "$10", usd: 10 },
      { bonusCredits: 150, credits: 2500, id: "p25", label: "$25", usd: 25 },
    ],
    suggestedPackId: "p25",
    url: "https://credits.hraness.com/t/clm_8f3k2q",
  },
};
const gatewayBody = (content: string, usage?: unknown) => ({
  choices: [{ message: { content } }],
  ...(usage === undefined ? {} : { usage }),
});

function stub(routes: Readonly<Record<string, (seen: Seen) => Response | Promise<Response>>>): Readonly<{
  fetch: typeof fetch;
  seen: Seen[];
}> {
  const seen: Seen[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    const body = typeof rawBody === "string" && rawBody.length > 0 ? JSON.parse(rawBody) as unknown : null;
    const record: Seen = { body, headers, method: init?.method ?? "GET", url };
    seen.push(record);
    const route = routes[url];
    if (route === undefined) throw new Error(`Unexpected request to ${url}`);
    return await route(record);
  }) as typeof fetch;
  return { fetch: fetcher, seen };
}

const request = (body: unknown, headers: Record<string, string> = {}): Request =>
  new Request(routeUrl, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", [CREDITS_SUBJECT_HEADER]: deviceToken, ...headers },
    method: "POST",
  });

const validBody = {
  assistantTail: "The refactor is staged. Should I proceed?",
  attempt,
  report: { reason: "should i proceed", state: "needs_approval", verbatimRequired: false },
  version: 1,
};

describe("hostedAutorespondConfiguration", () => {
  test("enables the route only when all three values are present and well formed", () => {
    expect(hostedAutorespondConfiguration(env)).toEqual({ gatewayKey, origin: creditsOrigin, productKey });
    expect(hostedAutorespondConfiguration({})).toBeNull();
    expect(hostedAutorespondConfiguration({ ...env, OOMPA_CREDITS_SERVICE_ORIGIN: "http://credits.example.test" })).toBeNull();
    expect(hostedAutorespondConfiguration({ ...env, OOMPA_CREDITS_PRODUCT_KEY: "not-a-key" })).toBeNull();
    expect(hostedAutorespondConfiguration({ ...env, AI_GATEWAY_API_KEY: "short" })).toBeNull();
  });
});

describe("hosted reply pricing", () => {
  test("holds the uplifted list-price estimate within one credit and fifty cents", () => {
    const estimate = hostedReplyEstimateMicroUsd(1_000);
    expect(estimate).toBeGreaterThan(0);
    const ceiling = hostedReplyCeilingMicroUsd(1_000);
    expect(ceiling).toBeGreaterThanOrEqual(HOSTED_REPLY_CEILING_MIN_MICRO_USD);
    expect(ceiling).toBeLessThanOrEqual(HOSTED_REPLY_CEILING_MAX_MICRO_USD);
    expect(ceiling).toBeGreaterThanOrEqual(Math.ceil(estimate * 1.25));
    expect(hostedReplyCeilingMicroUsd(4_000_000, "unknown/model")).toBe(HOSTED_REPLY_CEILING_MAX_MICRO_USD);
    expect(hostedReplyCeilingMicroUsd(0)).toBe(HOSTED_REPLY_CEILING_MIN_MICRO_USD);
  });

  test("prices measured usage from the published list price, rounded up", () => {
    expect(hostedReplyListPriceMicroUsd({ completionTokens: 1_000_000, promptTokens: 1_000_000 })).toBe(450_000);
    expect(hostedReplyListPriceMicroUsd({ completionTokens: 1, promptTokens: 1 })).toBe(2);
  });

  test("settles from the reported cost, else the list price, else the estimate", () => {
    expect(settlementCost({ completionTokens: 10, costUsd: 0.000123, promptTokens: 20 }, 500))
      .toEqual({ basis: "reported", microUsd: 123, operation: "model_tokens", provider: "vercel-ai-gateway" });
    expect(settlementCost({ completionTokens: 1_000, promptTokens: 2_000 }, 500))
      .toEqual({ basis: "contractual", microUsd: 500, operation: "model_tokens", provider: "vercel-ai-gateway" });
    expect(settlementCost(null, 500))
      .toEqual({ basis: "estimated", microUsd: hostedReplyEstimateMicroUsd(500), operation: "model_tokens", provider: "vercel-ai-gateway" });
  });
});

describe("POST /v1/autorespond", () => {
  test("holds, calls the gateway with the local request shape, settles with the reported cost, and returns the reply", async () => {
    const transport = stub({
      [`${creditsOrigin}/v1/holds`]: () => jsonResponse(holdBody, 201),
      [`${creditsOrigin}/v1/holds/hold_1/settle`]: () => jsonResponse(settleBody),
      [AI_GATEWAY_CHAT_COMPLETIONS_URL]: () => jsonResponse(gatewayBody(`  ${PROSE_APPROVAL_REPLY}  `, {
        completion_tokens: 12, cost: 0.0011, prompt_tokens: 240,
      })),
    });
    let clock = 1_000;
    const response = await handleHostedAutorespondRequest(request(validBody), {
      env, fetch: transport.fetch, now: () => { clock += 20; return clock; },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = hostedAutorespondReplySchema.parse(await response.json());
    expect(body).toEqual({
      charged: { credits: 0, microUsd: 1_100, usd: "0.00" },
      latencyMs: 20,
      lowBalance: false,
      model: PROSE_RESPONDER_MODEL,
      reply: PROSE_APPROVAL_REPLY,
      version: 1,
    });

    expect(transport.seen.map((call) => call.url)).toEqual([
      `${creditsOrigin}/v1/holds`,
      AI_GATEWAY_CHAT_COMPLETIONS_URL,
      `${creditsOrigin}/v1/holds/hold_1/settle`,
    ]);
    const [hold, gateway, settle] = transport.seen;
    expect(hold?.headers.get("authorization")).toBe(`Bearer ${productKey}`);
    expect(hold?.body).toMatchObject({
      context: { model: PROSE_RESPONDER_MODEL },
      idempotencyKey: `autorespond:${attempt}`,
      operation: "assistant_reply",
      subjectToken: deviceToken,
    });
    const ceiling = (hold?.body as { ceilingMicroUsd: number }).ceilingMicroUsd;
    expect(ceiling).toBeGreaterThanOrEqual(HOSTED_REPLY_CEILING_MIN_MICRO_USD);
    expect(ceiling).toBeLessThanOrEqual(HOSTED_REPLY_CEILING_MAX_MICRO_USD);
    // The gateway call is byte-for-byte the local responder's request shape.
    expect(gateway?.headers.get("authorization")).toBe(`Bearer ${gatewayKey}`);
    expect(gateway?.body).toEqual(gatewayChatCompletionRequest({
      assistantTail: validBody.assistantTail,
      report: { reason: validBody.report.reason, state: validBody.report.state },
    }));
    expect(settle?.body).toEqual({
      costs: [{ basis: "reported", microUsd: 1_100, operation: "model_tokens", provider: "vercel-ai-gateway" }],
    });
    // Neither credential nor prompt leaks into the other party's request.
    expect(JSON.stringify(hold?.body)).not.toContain(gatewayKey);
    expect(JSON.stringify(gateway?.body)).not.toContain(deviceToken);
    expect(JSON.stringify(gateway?.body)).not.toContain(productKey);
  });

  test("passes a verbatim literal through and settles at list price when the gateway reports tokens only", async () => {
    const transport = stub({
      [`${creditsOrigin}/v1/holds`]: () => jsonResponse(holdBody, 201),
      [`${creditsOrigin}/v1/holds/hold_1/settle`]: () => jsonResponse(settleBody),
      [AI_GATEWAY_CHAT_COMPLETIONS_URL]: () => jsonResponse(gatewayBody("APPROVE MIGRATION", { completion_tokens: 3, prompt_tokens: 300 })),
    });
    const response = await handleHostedAutorespondRequest(request({
      ...validBody,
      report: { ...validBody.report, verbatimRequired: true },
      verbatimLiteral: "APPROVE MIGRATION",
    }), { env, fetch: transport.fetch });
    expect(response.status).toBe(200);
    expect((await response.json() as { reply: string }).reply).toBe("APPROVE MIGRATION");
    const gateway = transport.seen[1]?.body as { messages: { content: string }[] };
    expect(gateway.messages[0]?.content).toContain("Answer with exactly this literal and nothing else: APPROVE MIGRATION");
    expect(transport.seen[2]?.body).toEqual({
      costs: [{ basis: "contractual", microUsd: hostedReplyListPriceMicroUsd({ completionTokens: 3, promptTokens: 300 }), operation: "model_tokens", provider: "vercel-ai-gateway" }],
    });
  });

  test("returns the reply with a null charge when the settlement is lost", async () => {
    const transport = stub({
      [`${creditsOrigin}/v1/holds`]: () => jsonResponse(holdBody, 201),
      [`${creditsOrigin}/v1/holds/hold_1/settle`]: () => { throw new Error("connection reset"); },
      [AI_GATEWAY_CHAT_COMPLETIONS_URL]: () => jsonResponse(gatewayBody(PROSE_APPROVAL_REPLY)),
    });
    const response = await handleHostedAutorespondRequest(request(validBody), { env, fetch: transport.fetch });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ charged: null, lowBalance: null, reply: PROSE_APPROVAL_REPLY });
  });

  test("releases the hold and reports responder_failed when the gateway refuses, without retrying", async () => {
    const transport = stub({
      [`${creditsOrigin}/v1/holds`]: () => jsonResponse(holdBody, 201),
      [`${creditsOrigin}/v1/holds/hold_1/release`]: () => jsonResponse(releaseBody),
      [AI_GATEWAY_CHAT_COMPLETIONS_URL]: () => jsonResponse({ error: "nope" }, 429),
    });
    const response = await handleHostedAutorespondRequest(request(validBody), { env, fetch: transport.fetch });
    expect(response.status).toBe(502);
    const body = await response.json() as { error: string; message: string };
    expect(body.error).toBe("responder_failed");
    expect(body.message).toContain("429");
    expect(body.message).not.toContain(gatewayKey);
    expect(transport.seen.map((call) => call.url)).toEqual([
      `${creditsOrigin}/v1/holds`,
      AI_GATEWAY_CHAT_COMPLETIONS_URL,
      `${creditsOrigin}/v1/holds/hold_1/release`,
    ]);
  });

  test("releases the hold when the gateway answers without usable reply text or beyond the byte bound", async () => {
    for (const answer of [
      () => jsonResponse({ choices: [] }),
      () => jsonResponse(gatewayBody("x".repeat(2_001))),
      () => new Response("{".repeat(70_000), { headers: { "content-type": "application/json" }, status: 200 }),
      () => jsonResponse(gatewayBody(PROSE_APPROVAL_REPLY), 200, { "content-length": "999999" }),
    ]) {
      const transport = stub({
        [`${creditsOrigin}/v1/holds`]: () => jsonResponse(holdBody, 201),
        [`${creditsOrigin}/v1/holds/hold_1/release`]: () => jsonResponse(releaseBody),
        [AI_GATEWAY_CHAT_COMPLETIONS_URL]: answer,
      });
      const response = await handleHostedAutorespondRequest(request(validBody), { env, fetch: transport.fetch });
      expect(response.status).toBe(502);
      expect(transport.seen.at(-1)?.url).toBe(`${creditsOrigin}/v1/holds/hold_1/release`);
    }
  });

  test("passes the service's insufficient_credits envelope through as credits_required and never calls the gateway", async () => {
    const transport = stub({
      [`${creditsOrigin}/v1/holds`]: () => jsonResponse(insufficientBody, 402),
    });
    const response = await handleHostedAutorespondRequest(request(validBody), { env, fetch: transport.fetch });
    expect(response.status).toBe(402);
    const body = hostedCreditsRequiredSchema.parse(await response.json());
    expect(body).toEqual({
      balance: { availableMicroUsd: 0, credits: 0, microUsd: 0, usd: "0.00" },
      error: "credits_required",
      message: "Oompa needs $0.01 in credits for one hosted autorespond reply; this device has $0.00 available. Add credits: https://credits.hraness.com/t/clm_8f3k2q",
      operation: "assistant_reply",
      reason: "insufficient_credits",
      required: { credits: 1, microUsd: 10_000, usd: "0.01" },
      topup: insufficientBody.topup,
    });
    expect(transport.seen.map((call) => call.url)).toEqual([`${creditsOrigin}/v1/holds`]);
  });

  test("answers credits_required without a payload for a missing, malformed, or unrecognised token", async () => {
    const missing = await handleHostedAutorespondRequest(
      new Request(routeUrl, { body: JSON.stringify(validBody), headers: { "content-type": "application/json" }, method: "POST" }),
      { env, fetch: stub({}).fetch },
    );
    expect(missing.status).toBe(402);
    expect(await missing.json()).toMatchObject({ error: "credits_required", reason: "subject_missing" });

    const malformed = await handleHostedAutorespondRequest(
      request(validBody, { [CREDITS_SUBJECT_HEADER]: "not-a-token" }),
      { env, fetch: stub({}).fetch },
    );
    expect(malformed.status).toBe(402);
    expect(await malformed.json()).toMatchObject({ error: "credits_required", reason: "subject_rejected" });

    const transport = stub({
      [`${creditsOrigin}/v1/holds`]: () => jsonResponse({ error: "not_found" }, 404),
    });
    const unknown = await handleHostedAutorespondRequest(request(validBody), { env, fetch: transport.fetch });
    expect(unknown.status).toBe(402);
    expect(await unknown.json()).toMatchObject({ error: "credits_required", reason: "subject_rejected" });
  });

  test("reports credits_unavailable when the service fails or cannot be reached", async () => {
    const failing = stub({ [`${creditsOrigin}/v1/holds`]: () => jsonResponse({ error: "product_disabled" }, 503) });
    expect((await handleHostedAutorespondRequest(request(validBody), { env, fetch: failing.fetch })).status).toBe(502);
    const unreachable = stub({ [`${creditsOrigin}/v1/holds`]: () => { throw new Error("dns"); } });
    const response = await handleHostedAutorespondRequest(request(validBody), { env, fetch: unreachable.fetch });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "credits_unavailable" });
  });

  test("bounds the request before any hold: method, media type, size, and contract", async () => {
    const transport = stub({});
    const get = await handleHostedAutorespondRequest(new Request(routeUrl, { method: "GET" }), { env, fetch: transport.fetch });
    expect(get.status).toBe(405);
    const text = await handleHostedAutorespondRequest(request(JSON.stringify(validBody), { "content-type": "text/plain" }), { env, fetch: transport.fetch });
    expect(text.status).toBe(415);
    const declared = await handleHostedAutorespondRequest(request(validBody, { "content-length": "20000" }), { env, fetch: transport.fetch });
    expect(declared.status).toBe(413);
    const oversized = await handleHostedAutorespondRequest(
      request({ ...validBody, assistantTail: "x".repeat(17_000) }),
      { env, fetch: transport.fetch },
    );
    expect(oversized.status).toBe(413);
    const longTail = await handleHostedAutorespondRequest(
      request({ ...validBody, assistantTail: "x".repeat(4_001) }),
      { env, fetch: transport.fetch },
    );
    expect(longTail.status).toBe(400);
    const extraKey = await handleHostedAutorespondRequest(
      request({ ...validBody, sessionId: "sess_1" }),
      { env, fetch: transport.fetch },
    );
    expect(extraKey.status).toBe(400);
    const notJson = await handleHostedAutorespondRequest(request("{not json"), { env, fetch: transport.fetch });
    expect(notJson.status).toBe(400);
    expect(transport.seen).toHaveLength(0);
  });

  test("stays inert without configuration", async () => {
    const transport = stub({});
    const response = await handleHostedAutorespondRequest(request(validBody), { env: {}, fetch: transport.fetch });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "hosted_autorespond_unavailable" });
    expect(transport.seen).toHaveLength(0);
  });
});
