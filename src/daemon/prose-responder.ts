/*
 * Prose-approval responder port.
 *
 * When an assistant turn ends by asking only for consent, the daemon has
 * already decided (positive gate, budgets, cues) that a reply may be sent on
 * the human's behalf. The responder produces the reply text and the evidence
 * fields, model and latency, for that attempt. It is a narrow port: one
 * bounded call, one bounded string back, no tools, no streaming, no retries.
 *
 * Three implementations ship: a Vercel AI Gateway call over the OpenAI-
 * compatible chat-completions endpoint with a key the person supplied, a
 * hosted call to Oompa's backend metered by prepaid Hraness credits, and a
 * deterministic fake used by tests. A selecting responder picks between the
 * first two from local custody on every call.
 *
 * The responder is never trusted. The daemon decides what is actually sent: a
 * verbatim ask must come back as a byte-exact substring of the assistant's own
 * message, and every other approval is answered with one fixed sentence. The
 * gateway key and the credits token are passed in request headers only; they
 * are never logged, never put in a URL, and never included in an error message.
 */

import type { SessionStateReport } from "../domain/session-state";
import {
  AI_GATEWAY_CHAT_COMPLETIONS_URL,
  GatewayReplyError,
  PROSE_APPROVAL_REPLY,
  PROSE_RESPONDER_MODEL,
  PROSE_RESPONDER_REPLY_MAX_CHARACTERS,
  PROSE_RESPONDER_RESPONSE_MAX_BYTES,
  PROSE_RESPONDER_TAIL_MAX_CHARACTERS,
  PROSE_RESPONDER_TIMEOUT_MS,
  gatewayChatCompletionRequest,
  proseResponderSystemPrompt,
  proseResponderUserPrompt,
  replyFromGatewayBody,
} from "../domain/prose-gateway";
import {
  ASSISTANT_REPLY_OPERATION,
  CREDITS_SUBJECT_HEADER,
  HOSTED_AUTORESPOND_PATH,
  HOSTED_AUTORESPOND_RESPONSE_MAX_BYTES,
  hostedAutorespondReplySchema,
  hostedCreditsRequiredSchema,
  type HostedCreditsRequired,
} from "../domain/hosted-autorespond";

export {
  AI_GATEWAY_CHAT_COMPLETIONS_URL,
  PROSE_APPROVAL_REPLY,
  PROSE_RESPONDER_MODEL,
  PROSE_RESPONDER_REPLY_MAX_CHARACTERS,
  PROSE_RESPONDER_RESPONSE_MAX_BYTES,
  PROSE_RESPONDER_TAIL_MAX_CHARACTERS,
  PROSE_RESPONDER_TIMEOUT_MS,
  proseResponderSystemPrompt,
  proseResponderUserPrompt,
};

export type ProseResponderInput = Readonly<{
  assistantTail: string;
  report: SessionStateReport;
  verbatimLiteral?: string;
  /**
   * Deterministic replay identity of this session turn. The hosted responder
   * keys its credits hold on it so a retried request never reserves twice.
   */
  attempt?: string;
}>;

export type ProseResponderResult = Readonly<{
  latencyMs: number;
  model: string;
  reply: string;
}>;

export interface ProseResponder {
  respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult>;
}

export class ProseResponderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProseResponderError";
  }
}

/**
 * The hosted responder could not proceed because this device holds no usable
 * credits. The payload is the backend's `402 credits_required` body, which the
 * daemon keeps as the reason autorespond is paused and which
 * `oompa autorespond status` turns into the shared payment handoff.
 */
export class ProseCreditsRequiredError extends ProseResponderError {
  constructor(readonly payload: HostedCreditsRequired) {
    super(payload.message);
    this.name = "ProseCreditsRequiredError";
  }
}

/** Which responder local custody currently selects. */
export type ProseResponderMode = "gateway-key" | "hosted";

type GatewayFetch = (
  url: string,
  init: Readonly<{
    body: string;
    headers: Readonly<Record<string, string>>;
    method: "POST";
    signal: AbortSignal;
  }>,
) => Promise<Response>;

/*
 * One bounded POST under the caller's abort signal and an own deadline. Both
 * network responders share it so a failed or slow call escalates the turn to
 * the human instead of being tried again on the human's behalf.
 */
async function boundedPost(input: Readonly<{
  body: string;
  fetch: GatewayFetch;
  headers: Readonly<Record<string, string>>;
  maxBytes: number;
  signal: AbortSignal;
  timeoutMs: number;
  url: string;
}>): Promise<Readonly<{ decoded: unknown; status: number }>> {
  const deadline = new AbortController();
  const abort = (): void => deadline.abort(new Error("Prose responder aborted."));
  if (input.signal.aborted) abort();
  input.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => deadline.abort(new Error("Prose responder timed out.")),
    input.timeoutMs,
  );
  try {
    const response = await input.fetch(input.url, {
      body: input.body,
      headers: input.headers,
      method: "POST",
      signal: deadline.signal,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > input.maxBytes) {
      throw new ProseResponderError("The responder response exceeded the accepted bound.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new ProseResponderError("The responder response is not one UTF-8 JSON document.");
    }
    return { decoded, status: response.status };
  } catch (error: unknown) {
    if (error instanceof ProseResponderError) throw error;
    throw new ProseResponderError("The responder call did not complete.");
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
  }
}

/*
 * Vercel AI Gateway responder. One POST, a ten-second deadline, no retries.
 */
export class AiGatewayProseResponder implements ProseResponder {
  readonly #fetch: GatewayFetch;
  readonly #model: string;
  readonly #now: () => number;
  readonly #readKey: () => Promise<string | null>;
  readonly #timeoutMs: number;
  readonly #url: string;

  constructor(input: Readonly<{
    readKey: () => Promise<string | null>;
    fetch?: GatewayFetch;
    model?: string;
    now?: () => number;
    timeoutMs?: number;
    url?: string;
  }>) {
    this.#readKey = input.readKey;
    this.#fetch = input.fetch ?? ((url, init) => fetch(url, init));
    this.#model = input.model ?? PROSE_RESPONDER_MODEL;
    this.#now = input.now ?? Date.now;
    this.#timeoutMs = input.timeoutMs ?? PROSE_RESPONDER_TIMEOUT_MS;
    this.#url = input.url ?? AI_GATEWAY_CHAT_COMPLETIONS_URL;
  }

  async respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult> {
    const key = await this.#readKey();
    if (key === null) throw new ProseResponderError("No gateway key is configured.");
    const startedAt = this.#now();
    const { decoded, status } = await boundedPost({
      body: JSON.stringify(gatewayChatCompletionRequest(input, this.#model)),
      fetch: this.#fetch,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      maxBytes: PROSE_RESPONDER_RESPONSE_MAX_BYTES,
      signal,
      timeoutMs: this.#timeoutMs,
      url: this.#url,
    });
    if (status < 200 || status >= 300) {
      throw new ProseResponderError(
        `The gateway refused the responder call with status ${String(status)}.`,
      );
    }
    let reply: string;
    try {
      reply = replyFromGatewayBody(decoded);
    } catch (error: unknown) {
      throw new ProseResponderError(
        error instanceof GatewayReplyError ? error.message : "The gateway reply could not be read.",
      );
    }
    return {
      latencyMs: Math.max(0, this.#now() - startedAt),
      model: this.#model,
      reply,
    };
  }
}

/*
 * Hosted responder. The daemon forwards the stored credits device token and
 * the same bounded prompt input; the backend meters the reply against prepaid
 * credits and calls the gateway with the operator's key. A 402 becomes
 * `ProseCreditsRequiredError`; nothing is retried.
 */
export class HostedProseResponder implements ProseResponder {
  readonly #fetch: GatewayFetch;
  readonly #now: () => number;
  readonly #origin: string;
  readonly #readToken: () => Promise<string | null>;
  readonly #timeoutMs: number;

  constructor(input: Readonly<{
    origin: string;
    readToken: () => Promise<string | null>;
    fetch?: GatewayFetch;
    now?: () => number;
    timeoutMs?: number;
  }>) {
    this.#origin = input.origin;
    this.#readToken = input.readToken;
    this.#fetch = input.fetch ?? ((url, init) => fetch(url, init));
    this.#now = input.now ?? Date.now;
    // The backend spends up to the gateway deadline itself; leave room for transit.
    this.#timeoutMs = input.timeoutMs ?? PROSE_RESPONDER_TIMEOUT_MS + 5_000;
  }

  async respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult> {
    const token = await this.#readToken();
    if (token === null) {
      throw new ProseCreditsRequiredError({
        error: "credits_required",
        message: "Hosted autorespond needs Hraness credits on this device and none are set up.",
        operation: ASSISTANT_REPLY_OPERATION,
        reason: "subject_missing",
      });
    }
    if (input.attempt === undefined) {
      throw new ProseResponderError("The hosted responder needs the attempt identity of the turn.");
    }
    const startedAt = this.#now();
    const tail = input.assistantTail.length > PROSE_RESPONDER_TAIL_MAX_CHARACTERS
      ? input.assistantTail.slice(-PROSE_RESPONDER_TAIL_MAX_CHARACTERS)
      : input.assistantTail;
    const { decoded, status } = await boundedPost({
      body: JSON.stringify({
        version: 1,
        attempt: input.attempt,
        assistantTail: tail,
        report: {
          reason: input.report.reason,
          state: input.report.state,
          verbatimRequired: input.report.verbatimRequired,
        },
        ...(input.verbatimLiteral === undefined ? {} : { verbatimLiteral: input.verbatimLiteral }),
      }),
      fetch: this.#fetch,
      headers: {
        "content-type": "application/json",
        [CREDITS_SUBJECT_HEADER]: token,
      },
      maxBytes: HOSTED_AUTORESPOND_RESPONSE_MAX_BYTES,
      signal,
      timeoutMs: this.#timeoutMs,
      url: `${this.#origin}${HOSTED_AUTORESPOND_PATH}`,
    });
    if (status === 402) {
      const parsed = hostedCreditsRequiredSchema.safeParse(decoded);
      throw new ProseCreditsRequiredError(parsed.success ? parsed.data : {
        error: "credits_required",
        message: "Hosted autorespond needs more Hraness credits on this device.",
        operation: ASSISTANT_REPLY_OPERATION,
        reason: "insufficient_credits",
      });
    }
    if (status !== 200) {
      throw new ProseResponderError(
        `The hosted responder refused the call with status ${String(status)}.`,
      );
    }
    const parsed = hostedAutorespondReplySchema.safeParse(decoded);
    if (!parsed.success) {
      throw new ProseResponderError("The hosted responder answered outside its contract.");
    }
    return {
      latencyMs: Math.max(0, this.#now() - startedAt),
      model: parsed.data.model,
      reply: parsed.data.reply,
    };
  }
}

/*
 * Chooses the responder per call from the mode local custody reports, so a
 * `gateway set` or `gateway clear` between two turns takes effect without a
 * daemon restart and the gateway-key path keeps its exact behavior.
 */
export class SelectingProseResponder implements ProseResponder {
  readonly #gateway: ProseResponder;
  readonly #hosted: ProseResponder;
  readonly #readMode: () => Promise<ProseResponderMode | null>;

  constructor(input: Readonly<{
    gateway: ProseResponder;
    hosted: ProseResponder;
    readMode: () => Promise<ProseResponderMode | null>;
  }>) {
    this.#gateway = input.gateway;
    this.#hosted = input.hosted;
    this.#readMode = input.readMode;
  }

  async respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult> {
    const mode = await this.#readMode();
    if (mode === null) throw new ProseResponderError("No prose responder is configured.");
    return await (mode === "hosted" ? this.#hosted : this.#gateway).respond(input, signal);
  }
}

/*
 * Deterministic responder for tests and offline runs: it answers with the
 * verbatim literal when one is required and with the fixed approval sentence
 * otherwise. A caller may override the reply or force a failure to exercise
 * the daemon's mismatch and failure paths.
 */
export class DeterministicProseResponder implements ProseResponder {
  readonly calls: ProseResponderInput[] = [];
  readonly #failure: string | ProseResponderError | null;
  readonly #latencyMs: number;
  readonly #model: string;
  readonly #reply: ((input: ProseResponderInput) => string) | null;

  constructor(options: Readonly<{
    failure?: string | ProseResponderError;
    latencyMs?: number;
    model?: string;
    reply?: (input: ProseResponderInput) => string;
  }> = {}) {
    this.#failure = options.failure ?? null;
    this.#latencyMs = options.latencyMs ?? 7;
    this.#model = options.model ?? PROSE_RESPONDER_MODEL;
    this.#reply = options.reply ?? null;
  }

  respond(input: ProseResponderInput, signal: AbortSignal): Promise<ProseResponderResult> {
    this.calls.push(input);
    if (signal.aborted) {
      return Promise.reject(new ProseResponderError("The responder call was aborted."));
    }
    if (this.#failure !== null) {
      return Promise.reject(typeof this.#failure === "string" ? new ProseResponderError(this.#failure) : this.#failure);
    }
    const reply = this.#reply === null
      ? input.verbatimLiteral ?? PROSE_APPROVAL_REPLY
      : this.#reply(input);
    return Promise.resolve({
      latencyMs: this.#latencyMs,
      model: this.#model,
      reply,
    });
  }
}
