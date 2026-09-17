/*
 * Wire contract of the hosted prose responder.
 *
 * `POST /v1/autorespond` on the hosted backend answers one prose approval on
 * behalf of a device that holds prepaid Hraness credits. The daemon sends the
 * same bounded prompt input it would hand the gateway itself, plus the credits
 * device token in a header; the backend places a hold, calls the gateway with
 * the operator's key, settles, and returns the bounded reply. A shortfall
 * answers 402 with the credits service's own payment payload, which the
 * daemon keeps as the reason autorespond is paused.
 *
 * Every shape is parsed from `unknown` with exact keys on both sides.
 */

import { z } from "zod";

import { SESSION_STATES } from "./session-state";
import {
  PROSE_RESPONDER_MAX_OUTPUT_TOKENS,
  PROSE_RESPONDER_MODEL,
  PROSE_RESPONDER_REPLY_MAX_CHARACTERS,
  PROSE_RESPONDER_TAIL_MAX_CHARACTERS,
} from "./prose-gateway";

/** Route on the hosted backend. */
export const HOSTED_AUTORESPOND_PATH = "/v1/autorespond";

/** The daemon forwards the stored credits device token in this header; the backend holds credits against it. */
export const CREDITS_SUBJECT_HEADER = "x-hraness-credits-subject";

/** Metered operation registered for Oompa on the credits service. */
export const ASSISTANT_REPLY_OPERATION = "assistant_reply";

/** Cost row operation reported at settlement. */
export const MODEL_TOKENS_OPERATION = "model_tokens";

/** Provider named on settlement cost rows. */
export const MODEL_COST_PROVIDER = "vercel-ai-gateway";

/** Request bodies above this are refused before parsing. */
export const HOSTED_AUTORESPOND_REQUEST_MAX_BYTES = 16 * 1024;

/** Response bodies above this are refused by the daemon. */
export const HOSTED_AUTORESPOND_RESPONSE_MAX_BYTES = 64 * 1024;

/** Highest hold the backend will place for one reply: fifty cents. */
export const HOSTED_REPLY_CEILING_MAX_MICRO_USD = 500_000;

/** Lowest hold: one credit, one cent. */
export const HOSTED_REPLY_CEILING_MIN_MICRO_USD = 10_000;

/** Uplift applied to the list-price estimate before it becomes a ceiling. */
export const HOSTED_REPLY_CEILING_UPLIFT = 1.25;

/** After a shortfall the daemon stops calling the hosted responder for this long, then tries once more. */
export const HOSTED_CREDITS_RETRY_MS = 15 * 60_000;

/** Deterministic attempt identity: the prose autorespond replay UUID for one session turn. */
const attemptSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

export const hostedAutorespondRequestSchema = z.object({
  version: z.literal(1),
  attempt: attemptSchema,
  assistantTail: z.string().min(1).max(PROSE_RESPONDER_TAIL_MAX_CHARACTERS),
  report: z.object({
    reason: z.string().max(256),
    state: z.enum(SESSION_STATES).nullable(),
    verbatimRequired: z.boolean(),
  }).strict(),
  verbatimLiteral: z.string().min(1).max(PROSE_RESPONDER_REPLY_MAX_CHARACTERS).optional(),
}).strict();

export type HostedAutorespondRequest = z.infer<typeof hostedAutorespondRequestSchema>;

const microUsdSchema = z.number().int().min(-1_000_000_000_000_000).max(1_000_000_000_000_000);
const usdStringSchema = z.string().regex(/^-?\d{1,10}\.\d{2}$/u);

export const creditsMoneySchema = z.object({
  microUsd: microUsdSchema,
  credits: z.number().int().optional(),
  usd: usdStringSchema,
}).strict();

export const creditsPackSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  usd: z.number().nonnegative().max(1_000_000),
  credits: z.number().int().nonnegative(),
  bonusCredits: z.number().int().nonnegative(),
  label: z.string().max(80).optional(),
}).strict();

export const hostedAutorespondReplySchema = z.object({
  version: z.literal(1),
  model: z.string().min(1).max(128),
  reply: z.string().min(1).max(PROSE_RESPONDER_REPLY_MAX_CHARACTERS),
  latencyMs: z.number().int().nonnegative(),
  /** Null when the hold could not be settled in this request; the hold then expires uncharged. */
  charged: creditsMoneySchema.nullable(),
  lowBalance: z.boolean().nullable(),
}).strict();

export type HostedAutorespondReply = z.infer<typeof hostedAutorespondReplySchema>;

export const hostedCreditsRequiredReasonSchema = z.enum([
  "insufficient_credits",
  "subject_missing",
  "subject_rejected",
]);

export type HostedCreditsRequiredReason = z.infer<typeof hostedCreditsRequiredReasonSchema>;

/** The backend's `402 credits_required` body: the service's payment payload when it has one, otherwise guidance only. */
export const hostedCreditsRequiredSchema = z.object({
  error: z.literal("credits_required"),
  message: z.string().min(1).max(2_000),
  operation: z.literal(ASSISTANT_REPLY_OPERATION),
  reason: hostedCreditsRequiredReasonSchema,
  required: creditsMoneySchema.optional(),
  balance: creditsMoneySchema.extend({ availableMicroUsd: microUsdSchema }).strict().optional(),
  topup: z.object({
    claimId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
    url: z.url().max(2_048),
    expiresAt: z.iso.datetime(),
    packs: z.array(creditsPackSchema).min(1).max(16),
    suggestedPackId: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/u),
  }).strict().optional(),
}).strict();

export type HostedCreditsRequired = z.infer<typeof hostedCreditsRequiredSchema>;

/** Any other failure the backend reports. */
export const hostedAutorespondErrorSchema = z.object({
  error: z.string().regex(/^[a-z][a-z_]{0,63}$/u),
  message: z.string().max(2_000).optional(),
}).strict();

/**
 * The hosted responder lives on the HTTP-actions host of the same Convex
 * deployment that serves hosted sync: `<name>.convex.cloud` serves functions,
 * `<name>.convex.site` serves HTTP routes. Nothing else is accepted.
 */
export function hostedAutorespondOrigin(deploymentUrl: string): string {
  let url: URL;
  try {
    url = new URL(deploymentUrl);
  } catch {
    throw new Error("The hosted autorespond origin needs a valid cloud deployment URL.");
  }
  const match = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.convex\.cloud$/u.exec(url.hostname);
  if (url.protocol !== "https:" || match === null || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    throw new Error("The hosted autorespond origin needs an https Convex cloud deployment URL.");
  }
  return `https://${match[1]}.convex.site`;
}

/** Published list prices in micro-USD per million tokens. The service prices the reply; these only size holds. */
export const PROSE_RESPONDER_LIST_PRICES: Readonly<Record<string, Readonly<{
  inputMicroUsdPerMillionTokens: number;
  outputMicroUsdPerMillionTokens: number;
}>>> = Object.freeze({
  [PROSE_RESPONDER_MODEL]: Object.freeze({
    inputMicroUsdPerMillionTokens: 50_000,
    outputMicroUsdPerMillionTokens: 400_000,
  }),
});

const FALLBACK_LIST_PRICE = Object.freeze({
  inputMicroUsdPerMillionTokens: 2_000_000,
  outputMicroUsdPerMillionTokens: 8_000_000,
});

/** Roughly three characters per token for English prose plus a fixed prompt allowance. */
const PROMPT_TOKEN_ALLOWANCE = 96;

function listPrice(model: string): Readonly<{ inputMicroUsdPerMillionTokens: number; outputMicroUsdPerMillionTokens: number }> {
  return Object.hasOwn(PROSE_RESPONDER_LIST_PRICES, model)
    ? PROSE_RESPONDER_LIST_PRICES[model] ?? FALLBACK_LIST_PRICE
    : FALLBACK_LIST_PRICE;
}

/** Integer micro-USD for a token count at a per-million price, rounded up. */
const priceTokens = (tokens: number, microUsdPerMillion: number): number =>
  Math.ceil((tokens * microUsdPerMillion) / 1_000_000);

/** List-price cost of one call from measured token counts. */
export function hostedReplyListPriceMicroUsd(
  usage: Readonly<{ promptTokens: number; completionTokens: number }>,
  model: string = PROSE_RESPONDER_MODEL,
): number {
  const price = listPrice(model);
  return priceTokens(usage.promptTokens, price.inputMicroUsdPerMillionTokens)
    + priceTokens(usage.completionTokens, price.outputMicroUsdPerMillionTokens);
}

/** List-price estimate of one call before it happens, from the prompt size and the output budget. */
export function hostedReplyEstimateMicroUsd(promptCharacters: number, model: string = PROSE_RESPONDER_MODEL): number {
  const promptTokens = Math.ceil(Math.max(0, promptCharacters) / 3) + PROMPT_TOKEN_ALLOWANCE;
  return hostedReplyListPriceMicroUsd({ completionTokens: PROSE_RESPONDER_MAX_OUTPUT_TOKENS, promptTokens }, model);
}

/**
 * The hold placed for one reply: the list-price estimate with a 1.25 uplift,
 * never below one credit and never above fifty cents.
 */
export function hostedReplyCeilingMicroUsd(promptCharacters: number, model: string = PROSE_RESPONDER_MODEL): number {
  const uplifted = Math.ceil(hostedReplyEstimateMicroUsd(promptCharacters, model) * HOSTED_REPLY_CEILING_UPLIFT);
  return Math.min(HOSTED_REPLY_CEILING_MAX_MICRO_USD, Math.max(HOSTED_REPLY_CEILING_MIN_MICRO_USD, uplifted));
}

/** Micro-USD from a dollar amount the gateway reported, rounded up to the next integer without binary drift. */
export function microUsdFromReportedUsd(usd: number): number {
  return Math.ceil(Number((usd * 1_000_000).toFixed(3)));
}
