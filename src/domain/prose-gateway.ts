/*
 * Pure helpers shared by every prose-approval responder: the local bring-your-
 * own-key responder in the daemon and the hosted responder in the Convex
 * backend. Both send the same chat-completions request to the Vercel AI
 * Gateway and read the same bounded reply out of its answer, so the request
 * shape, the prompts, and the reply parser live here, in the leaf layer, with
 * no I/O and no credential.
 */

/** The only free-text reply the daemon ever sends for a non-verbatim approval. */
export const PROSE_APPROVAL_REPLY = "The human has approved. Proceed accordingly.";

/** OpenAI-compatible chat-completions endpoint of the Vercel AI Gateway. */
export const AI_GATEWAY_CHAT_COMPLETIONS_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Gateway model identifier used for prose autorespond. */
export const PROSE_RESPONDER_MODEL = "openai/gpt-5-nano";

/** One call, ten seconds, no retries. */
export const PROSE_RESPONDER_TIMEOUT_MS = 10_000;

/** Upper bound on the assistant tail handed to the responder. */
export const PROSE_RESPONDER_TAIL_MAX_CHARACTERS = 4_000;

/** Upper bound on an accepted reply, in characters. */
export const PROSE_RESPONDER_REPLY_MAX_CHARACTERS = 2_000;

/** Upper bound on the gateway response body, in bytes. */
export const PROSE_RESPONDER_RESPONSE_MAX_BYTES = 64 * 1024;

/**
 * Output tokens the responder is budgeted for. The reply is bounded at 2,000
 * characters and reasoning effort is minimal, so this is a generous ceiling
 * used only to price a hold before the call.
 */
export const PROSE_RESPONDER_MAX_OUTPUT_TOKENS = 2_048;

/** The prompt input every responder builds its request from. */
export type ProseGatewayPromptInput = Readonly<{
  assistantTail: string;
  report: Readonly<{ reason: string; state?: string | null }>;
  verbatimLiteral?: string | undefined;
}>;

export class GatewayReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayReplyError";
  }
}

/*
 * The system prompt states the decision that has already been made and asks
 * for reply text only. It forbids commentary so the daemon's verbatim check
 * has a chance of passing, and it never carries the session identifier, a
 * path, or any credential.
 */
export function proseResponderSystemPrompt(verbatimLiteral: string | undefined): string {
  const common = [
    "You write the human operator's reply to a coding agent that has paused to ask for approval.",
    "The human has already reviewed the request and approved it.",
    "Answer with the reply text only: no greeting, no quotation marks, no explanation, no code fences.",
  ];
  return verbatimLiteral === undefined
    ? [
        ...common,
        `Reply with exactly this sentence: ${PROSE_APPROVAL_REPLY}`,
      ].join("\n")
    : [
        ...common,
        "The agent asked for one exact string to be pasted back.",
        `Answer with exactly this literal and nothing else: ${verbatimLiteral}`,
      ].join("\n");
}

export function proseResponderUserPrompt(input: ProseGatewayPromptInput): string {
  const tail = input.assistantTail.length > PROSE_RESPONDER_TAIL_MAX_CHARACTERS
    ? input.assistantTail.slice(-PROSE_RESPONDER_TAIL_MAX_CHARACTERS)
    : input.assistantTail;
  return [
    `Session state: ${input.report.state ?? "unknown"}.`,
    `Approval cue: ${input.report.reason}.`,
    "The agent's closing message follows.",
    "---",
    tail,
  ].join("\n");
}

export type GatewayChatCompletionRequest = Readonly<{
  messages: readonly Readonly<{ content: string; role: "system" | "user" }>[];
  model: string;
  reasoning_effort: "minimal";
  stream: false;
}>;

/** The one request body both responders send; the key travels in a header only. */
export function gatewayChatCompletionRequest(
  input: ProseGatewayPromptInput,
  model: string = PROSE_RESPONDER_MODEL,
): GatewayChatCompletionRequest {
  return {
    messages: [
      { content: proseResponderSystemPrompt(input.verbatimLiteral), role: "system" },
      { content: proseResponderUserPrompt(input), role: "user" },
    ],
    model,
    reasoning_effort: "minimal",
    stream: false,
  };
}

const boundedReply = (value: unknown): string => {
  if (typeof value !== "string") {
    throw new GatewayReplyError("The gateway response did not contain reply text.");
  }
  const reply = value.trim();
  if (reply.length === 0 || reply.length > PROSE_RESPONDER_REPLY_MAX_CHARACTERS) {
    throw new GatewayReplyError("The gateway reply is empty or beyond the accepted bound.");
  }
  return reply;
};

const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Read the bounded reply text out of a decoded chat-completions body. */
export function replyFromGatewayBody(decoded: unknown): string {
  if (!record(decoded)) {
    throw new GatewayReplyError("The gateway response is not an object.");
  }
  const choices = decoded.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new GatewayReplyError("The gateway response carried no choice.");
  }
  const first = choices[0] as unknown;
  if (!record(first)) {
    throw new GatewayReplyError("The gateway response carried an invalid choice.");
  }
  const message = first.message;
  if (!record(message)) {
    throw new GatewayReplyError("The gateway response carried an invalid message.");
  }
  return boundedReply(message.content);
}

export type GatewayUsage = Readonly<{
  completionTokens: number;
  promptTokens: number;
  /** Dollars reported by the gateway for this call, when it reports one. */
  costUsd?: number;
}>;

const MAX_TOKENS = 10_000_000;

const tokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TOKENS ? value : null;

/**
 * Usage the gateway reports beside the reply. Absent or malformed usage is
 * reported as null rather than guessed, so a settlement can say what it knows.
 */
export function usageFromGatewayBody(decoded: unknown): GatewayUsage | null {
  if (!record(decoded) || !record(decoded.usage)) return null;
  const promptTokens = tokenCount(decoded.usage.prompt_tokens);
  const completionTokens = tokenCount(decoded.usage.completion_tokens);
  if (promptTokens === null || completionTokens === null) return null;
  const cost = decoded.usage.cost;
  const costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 && cost <= 1_000 ? cost : undefined;
  return { completionTokens, promptTokens, ...(costUsd === undefined ? {} : { costUsd }) };
}
