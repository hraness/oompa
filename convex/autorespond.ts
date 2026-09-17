/*
 * Hosted prose responder: `POST /v1/autorespond`.
 *
 * A daemon whose person has not supplied a gateway key may select the hosted
 * responder instead. It forwards the credits device token in
 * `x-hraness-credits-subject` and the same bounded prompt input it would send
 * the gateway itself. This route places a hold on the Hraness credits service
 * for one `assistant_reply`, calls the Vercel AI Gateway with the operator's
 * key, settles the hold from the cost the gateway reported (or the published
 * list price when it reported none), and returns the bounded reply the daemon
 * already knows how to consume. A failure after the hold releases it; a
 * shortfall answers 402 with the service's own payment payload so the daemon
 * can hand the person the link.
 *
 * The credits device token is the only authentication: a hold succeeds only
 * for a token the service recognises with enough credits, and nothing is sent
 * to the gateway before that. Neither the token, the operator's key, the
 * prompt, nor the reply is logged or echoed in an error.
 */

import { httpActionGeneric } from "convex/server";

import {
  creditsFromMicroUsd,
  formatUsd,
  isCreditsDeviceToken,
  isCreditsOrigin,
  isCreditsProductKey,
  type CreditsFetch,
} from "@hraness/credits-foundation";
import {
  createCreditsClient,
  type CreditsClient,
  type CreditsCost,
  type CreditsInsufficientError,
} from "@hraness/credits-foundation/server";

import {
  ASSISTANT_REPLY_OPERATION,
  CREDITS_SUBJECT_HEADER,
  HOSTED_AUTORESPOND_REQUEST_MAX_BYTES,
  MODEL_COST_PROVIDER,
  MODEL_TOKENS_OPERATION,
  hostedAutorespondRequestSchema,
  hostedReplyCeilingMicroUsd,
  hostedReplyEstimateMicroUsd,
  hostedReplyListPriceMicroUsd,
  microUsdFromReportedUsd,
  type HostedAutorespondReply,
  type HostedAutorespondRequest,
  type HostedCreditsRequired,
  type HostedCreditsRequiredReason,
} from "../src/domain/hosted-autorespond";
import {
  AI_GATEWAY_CHAT_COMPLETIONS_URL,
  GatewayReplyError,
  PROSE_RESPONDER_MODEL,
  PROSE_RESPONDER_RESPONSE_MAX_BYTES,
  PROSE_RESPONDER_TIMEOUT_MS,
  gatewayChatCompletionRequest,
  replyFromGatewayBody,
  usageFromGatewayBody,
} from "../src/domain/prose-gateway";

type Environment = Readonly<Record<string, string | undefined>>;

export type HostedAutorespondDependencies = Readonly<{
  env: Environment;
  /** Transport for the gateway call. Tests inject a stub; production uses the global fetch. */
  fetch: typeof fetch;
  /** Transport for the credits service. Defaults to `fetch`. */
  creditsFetch?: CreditsFetch;
  now?: () => number;
}>;

type Configuration = Readonly<{
  gatewayKey: string;
  origin: string;
  productKey: string;
}>;

const jsonHeaders = Object.freeze({
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
});

const json = (status: number, body: unknown): Response =>
  new Response(`${JSON.stringify(body)}\n`, { headers: jsonHeaders, status });

const failure = (status: number, error: string, message: string): Response =>
  json(status, { error, message });

/**
 * The credits transport asks for `AbortSignal.timeout`. The default Convex
 * runtime supplies `AbortController` and `setTimeout`; give it the static
 * helper only when the host lacks one.
 */
function ensureAbortSignalTimeout(): void {
  const signal = (globalThis as { AbortSignal?: { timeout?: unknown } }).AbortSignal;
  if (signal === undefined || typeof signal.timeout === "function") return;
  (signal as { timeout: (milliseconds: number) => AbortSignal }).timeout = (milliseconds) => {
    const controller = new AbortController();
    const timeout = new Error("The operation was aborted due to timeout.");
    timeout.name = "TimeoutError";
    setTimeout(() => controller.abort(timeout), milliseconds);
    return controller.signal;
  };
}

/** All three values set and valid enables the route; anything else keeps it inert. */
export function hostedAutorespondConfiguration(env: Environment): Configuration | null {
  const origin = env.OOMPA_CREDITS_SERVICE_ORIGIN;
  const productKey = env.OOMPA_CREDITS_PRODUCT_KEY;
  const gatewayKey = env.AI_GATEWAY_API_KEY;
  if (
    !isCreditsOrigin(origin)
    || !isCreditsProductKey(productKey)
    || typeof gatewayKey !== "string"
    || !/^[!-~]{16,512}$/u.test(gatewayKey)
  ) return null;
  return { gatewayKey, origin, productKey };
}

const money = (microUsd: number) => ({
  credits: creditsFromMicroUsd(microUsd),
  microUsd,
  usd: formatUsd(microUsd),
});

function creditsRequired(
  reason: HostedCreditsRequiredReason,
  message: string,
  insufficient?: CreditsInsufficientError,
): Response {
  const body: HostedCreditsRequired = {
    error: "credits_required",
    message,
    operation: ASSISTANT_REPLY_OPERATION,
    reason,
    ...(insufficient === undefined ? {} : {
      required: money(insufficient.required.microUsd),
      balance: { ...money(insufficient.balance.microUsd), availableMicroUsd: insufficient.balance.availableMicroUsd },
      topup: {
        claimId: insufficient.topup.claimId,
        url: insufficient.topup.url,
        expiresAt: insufficient.topup.expiresAt,
        packs: insufficient.topup.packs.map((pack) => ({
          id: pack.id,
          usd: pack.usd,
          credits: pack.credits,
          bonusCredits: pack.bonusCredits,
          ...(pack.label === undefined ? {} : { label: pack.label }),
        })),
        suggestedPackId: insufficient.topup.suggestedPackId,
      },
    }),
  };
  return json(402, body);
}

async function readBoundedRequest(request: Request): Promise<HostedAutorespondRequest | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/u.test(declared.trim()) || Number(declared) > HOSTED_AUTORESPOND_REQUEST_MAX_BYTES)) {
    return failure(413, "too_large", "The request body exceeds 16 KiB.");
  }
  const type = (request.headers.get("content-type") ?? "").trim();
  if (!/^application\/json(?:\s*;.*)?$/iu.test(type)) {
    return failure(415, "unsupported_media_type", "The request body must be JSON.");
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return failure(400, "invalid_request", "The request body could not be read.");
  }
  if (bytes.byteLength > HOSTED_AUTORESPOND_REQUEST_MAX_BYTES) {
    return failure(413, "too_large", "The request body exceeds 16 KiB.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return failure(400, "invalid_request", "The request body is not one UTF-8 JSON document.");
  }
  const parsed = hostedAutorespondRequestSchema.safeParse(decoded);
  return parsed.success ? parsed.data : failure(400, "invalid_request", "The request body does not match the autorespond contract.");
}

type GatewayOutcome =
  | Readonly<{ ok: true; reply: string; usage: ReturnType<typeof usageFromGatewayBody> }>
  | Readonly<{ ok: false; message: string }>;

async function callGateway(
  input: HostedAutorespondRequest,
  configuration: Configuration,
  fetcher: typeof fetch,
): Promise<GatewayOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROSE_RESPONDER_TIMEOUT_MS);
  try {
    const response = await fetcher(AI_GATEWAY_CHAT_COMPLETIONS_URL, {
      body: JSON.stringify(gatewayChatCompletionRequest(input, PROSE_RESPONDER_MODEL)),
      headers: {
        authorization: `Bearer ${configuration.gatewayKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      redirect: "error",
      signal: controller.signal,
    });
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d{1,9}$/u.test(declared.trim()) || Number(declared) > PROSE_RESPONDER_RESPONSE_MAX_BYTES)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, message: "The gateway response exceeded the accepted bound." };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > PROSE_RESPONDER_RESPONSE_MAX_BYTES) {
      return { ok: false, message: "The gateway response exceeded the accepted bound." };
    }
    if (!response.ok) {
      return { ok: false, message: `The gateway refused the responder call with status ${String(response.status)}.` };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      return { ok: false, message: "The gateway response is not one UTF-8 JSON document." };
    }
    return { ok: true, reply: replyFromGatewayBody(decoded), usage: usageFromGatewayBody(decoded) };
  } catch (error: unknown) {
    return { ok: false, message: error instanceof GatewayReplyError ? error.message : "The gateway responder call did not complete." };
  } finally {
    clearTimeout(timer);
  }
}

/** One settlement cost row: what the gateway reported, else the list price of its usage, else the estimate. */
export function settlementCost(
  usage: ReturnType<typeof usageFromGatewayBody>,
  promptCharacters: number,
  model: string = PROSE_RESPONDER_MODEL,
): CreditsCost {
  const base = { operation: MODEL_TOKENS_OPERATION, provider: MODEL_COST_PROVIDER } as const;
  if (usage?.costUsd !== undefined) {
    return { ...base, basis: "reported", microUsd: microUsdFromReportedUsd(usage.costUsd) };
  }
  if (usage !== null) {
    return { ...base, basis: "contractual", microUsd: hostedReplyListPriceMicroUsd(usage, model) };
  }
  return { ...base, basis: "estimated", microUsd: hostedReplyEstimateMicroUsd(promptCharacters, model) };
}

const promptCharactersOf = (input: HostedAutorespondRequest): number =>
  gatewayChatCompletionRequest(input, PROSE_RESPONDER_MODEL).messages
    .reduce((total, message) => total + message.content.length, 0);

/** The complete request handling, free of Convex context so tests can drive it with stubs. */
export async function handleHostedAutorespondRequest(
  request: Request,
  dependencies: HostedAutorespondDependencies,
): Promise<Response> {
  if (request.method !== "POST") return failure(405, "method_not_allowed", "Use POST.");
  const configuration = hostedAutorespondConfiguration(dependencies.env);
  if (configuration === null) {
    return failure(503, "hosted_autorespond_unavailable", "The hosted responder is not configured on this deployment.");
  }
  const subject = (request.headers.get(CREDITS_SUBJECT_HEADER) ?? "").trim();
  if (subject === "") {
    return creditsRequired("subject_missing", "Hosted autorespond needs Hraness credits on this device and none are set up.");
  }
  if (!isCreditsDeviceToken(subject)) {
    return creditsRequired("subject_rejected", "This device's credits token is not usable. Run `oompa credits signout`, then `oompa credits topup`.");
  }
  const parsed = await readBoundedRequest(request);
  if (parsed instanceof Response) return parsed;

  ensureAbortSignalTimeout();
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const credits: CreditsClient = createCreditsClient({
    origin: configuration.origin,
    productKey: configuration.productKey,
    fetch: dependencies.creditsFetch ?? (dependencies.fetch as unknown as CreditsFetch),
  });
  const promptCharacters = promptCharactersOf(parsed);
  const hold = await credits.hold({
    subjectToken: subject,
    operation: ASSISTANT_REPLY_OPERATION,
    ceilingMicroUsd: hostedReplyCeilingMicroUsd(promptCharacters, PROSE_RESPONDER_MODEL),
    idempotencyKey: `autorespond:${parsed.attempt}`,
    context: { model: PROSE_RESPONDER_MODEL },
  });
  if (!hold.ok) {
    const error = hold.error;
    if (error.code === "insufficient_credits" && error.status === 402) {
      const insufficient = error as CreditsInsufficientError;
      return creditsRequired(
        "insufficient_credits",
        `Oompa needs $${insufficient.required.usd} in credits for one hosted autorespond reply; this device has $${formatUsd(insufficient.balance.availableMicroUsd)} available. Add credits: ${insufficient.topup.url}`,
        insufficient,
      );
    }
    if (error.status === 401 || error.status === 403 || error.status === 404) {
      return creditsRequired("subject_rejected", "The credits service does not recognise this device's credits token. Run `oompa credits signout`, then `oompa credits topup`.");
    }
    return failure(error.status === 0 ? 503 : 502, "credits_unavailable", "The credits service could not reserve credits for this reply.");
  }

  const gateway = await callGateway(parsed, configuration, dependencies.fetch);
  if (!gateway.ok) {
    await credits.release(hold.value.holdId).catch(() => undefined);
    return failure(502, "responder_failed", gateway.message);
  }

  const settled = await credits.settle(hold.value.holdId, {
    costs: [settlementCost(gateway.usage, promptCharacters, PROSE_RESPONDER_MODEL)],
  }).catch(() => null);
  const body: HostedAutorespondReply = {
    version: 1,
    model: PROSE_RESPONDER_MODEL,
    reply: gateway.reply,
    latencyMs: Math.max(0, now() - startedAt),
    charged: settled?.ok === true ? money(settled.value.chargedMicroUsd) : null,
    lowBalance: settled?.ok === true ? settled.value.lowBalance : null,
  };
  return json(200, body);
}

export const hostedAutorespond = httpActionGeneric(async (_context, request) =>
  await handleHostedAutorespondRequest(request, { env: process.env, fetch: globalThis.fetch }));
