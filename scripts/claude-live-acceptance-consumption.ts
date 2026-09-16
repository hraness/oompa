import { createHash } from "node:crypto";

import { z } from "zod";

import { publicInteractionSchema, type PublicInteraction } from "../src/domain/interactions";
import { sessionEventPageSchema, type SessionEvent } from "../src/domain/session-events";
import { profileIdSchema, sessionIdSchema } from "../src/domain/values";

export type ClaudeLiveAcceptanceConsumptionInput = Readonly<{
  connectionId: string;
  interaction: PublicInteraction;
  nonce: string;
  profileGeneration: number;
  profileId: z.infer<typeof profileIdSchema>;
  prompt: string;
  readPage: (cursor: string | undefined) => Promise<unknown>;
  receiptSha256: string;
  sessionId: z.infer<typeof sessionIdSchema>;
  signal: AbortSignal;
  submissionId: string;
  written: PublicInteraction;
}>;

export type ClaudeLiveAcceptanceConsumptionEvidence = Readonly<{
  exactReceiptEcho: true;
  echoSha256: string;
}>;

const inputSchema = z.object({
  connectionId: z.string().uuid(),
  interaction: publicInteractionSchema,
  nonce: z.string().regex(/^claude-live-[0-9a-f]{32}$/u),
  profileGeneration: z.number().int().positive().safe(),
  profileId: profileIdSchema,
  prompt: z.string().min(1).max(16_384),
  readPage: z.custom<ClaudeLiveAcceptanceConsumptionInput["readPage"]>(
    (value) => typeof value === "function",
  ),
  receiptSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sessionId: sessionIdSchema,
  signal: z.instanceof(AbortSignal),
  submissionId: z.string().regex(/^memsub_[0-9a-f]{32}$/u),
  written: publicInteractionSchema,
}).strict();

export class ClaudeLiveAcceptanceConsumptionError extends Error {
  readonly code = "consumption_unproven";
  constructor() {
    super("claude_live_acceptance_consumption_unproven");
    this.name = "ClaudeLiveAcceptanceConsumptionError";
  }
}

const refuse = (): never => { throw new ClaudeLiveAcceptanceConsumptionError(); };
const requireThat = (condition: boolean): void => { if (!condition) refuse(); };
const maximumPages = 8;
const maximumEvents = 1_600;
const maximumBytes = 2 * 1024 * 1024;
const maximumEchoBytes = 4_096;
const readDeadlineMs = 10_000;

async function readBoundedPage(
  input: ClaudeLiveAcceptanceConsumptionInput,
  cursor: string | undefined,
): Promise<unknown> {
  requireThat(!input.signal.aborted);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = (): void => undefined;
  try {
    return await Promise.race([
      new Promise<never>((_resolvePromise, rejectPromise) => {
        abort = () => rejectPromise(new ClaudeLiveAcceptanceConsumptionError());
        input.signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(abort, readDeadlineMs);
      }),
      Promise.resolve().then(() => {
        requireThat(!input.signal.aborted);
        return input.readPage(cursor);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
  }
}

/**
 * One bounded public event snapshot, not a provider call or a polling loop.
 * Native turn authority remains with the independent collector/readback. This
 * joins its protected connection and exact permission to the sole public turn.
 * A valid drained prefix may be polled again by the runner; no partial snapshot
 * can produce passing evidence, and no identifier or text leaves this module.
 */
export async function verifyClaudeLiveAcceptanceConsumption(
  inputValue: ClaudeLiveAcceptanceConsumptionInput,
): Promise<ClaudeLiveAcceptanceConsumptionEvidence | null> {
  try {
    const input = inputSchema.parse(inputValue);
    const { interaction, written } = input;
    requireThat(!input.signal.aborted && interaction.sessionId === input.sessionId
      && interaction.kind === "permission_approval" && interaction.state === "pending"
      && interaction.blocking && !interaction.responseRecorded && interaction.terminalAt === null
      && interaction.context.turnId !== null && interaction.display.kind === "permission_approval"
      && !interaction.display.allowsSessionScope && interaction.display.requested.length === 1
      && interaction.display.requested[0]?.name === "mcp__hra__memory_remember"
      && written.id === interaction.id && written.sessionId === interaction.sessionId
      && written.kind === interaction.kind && written.state === "response_written"
      && written.context.turnId === interaction.context.turnId
      && written.context.itemId === interaction.context.itemId
      && written.revision === interaction.revision + 2
      && written.blocking && written.responseRecorded && written.terminalAt === null
      && input.prompt.includes(input.nonce)
      && !input.prompt.includes(input.submissionId) && !input.prompt.includes(input.receiptSha256));
    const echo = JSON.stringify({
      submissionId: input.submissionId, receiptSha256: input.receiptSha256, nonce: input.nonce,
    });
    const turnId = interaction.context.turnId;
    let cursor: string | undefined;
    let floor: string | undefined;
    let epoch: string | undefined;
    let sequence = 0;
    let bytes = 0;
    let userCount = 0;
    let starts = 0;
    let completions = 0;
    let requested = 0;
    let prepared = 0;
    let responseWritten = 0;
    let resolved = 0;
    let pending = 0;
    let assistant = "";
    let assistantItem: string | undefined;
    const cursors = new Set<string>();

    const inspect = (event: SessionEvent): void => {
      requireThat(event.sequence === sequence + 1 && event.sessionId === input.sessionId
        && event.accountId === input.profileId && event.providerGeneration === input.profileGeneration
        && (epoch === undefined || event.streamEpoch === epoch));
      sequence = event.sequence;
      epoch = event.streamEpoch;
      requireThat(sequence <= maximumEvents);
      const body = event.body;
      if ("turnId" in body && body.turnId !== null) requireThat(body.turnId === turnId
        && event.providerConnectionId === input.connectionId);
      switch (body.type) {
        case "gap": case "error": case "protocol_incompatible": case "provider_switched":
        case "subagent_activity": case "warning": case "compaction": return refuse();
        case "connection": requireThat(body.state === "connected"); break;
        case "session_status":
          requireThat(body.status === "active" || body.status === "idle");
          if (body.activeTurnId !== null) requireThat(body.activeTurnId === turnId
            && event.providerConnectionId === input.connectionId);
          break;
        case "session_state": requireThat(body.state !== "aborted"); break;
        case "user_message":
          requireThat(++userCount === 1 && body.actor === "human" && body.turnId === turnId
            && body.text === input.prompt && body.omittedCharacters === 0);
          break;
        case "turn_started": requireThat(++starts === 1 && completions === 0); break;
        case "turn_completed":
          requireThat(++completions === 1 && starts === 1 && body.status === "completed"
            && body.errorCode === undefined);
          break;
        case "assistant_delta":
          requireThat(completions === 0 && starts === 1
            && (assistantItem === undefined || assistantItem === body.itemId));
          assistantItem = body.itemId;
          requireThat(body.text.length <= maximumEchoBytes - assistant.length);
          assistant += body.text;
          requireThat(Buffer.byteLength(assistant, "utf8") <= maximumEchoBytes
            && (assistant.trimStart() === "" || assistant.trimStart().startsWith("{")));
          break;
        case "interaction_requested":
          requireThat(event.providerConnectionId === input.connectionId && ++requested === 1
            && body.interactionId === interaction.id && body.interactionKind === "permission_approval"
            && body.revision === interaction.revision && body.blocking && starts === 1
            && completions === 0);
          break;
        case "interaction_state":
          requireThat(event.providerConnectionId === input.connectionId
            && body.interactionId === interaction.id && requested === 1);
          if (body.state === "pending") requireThat(++pending === 1 && prepared === 0
            && body.revision === interaction.revision);
          else if (body.state === "response_prepared") requireThat(++prepared === 1
            && responseWritten === 0 && completions === 0 && body.revision === interaction.revision + 1);
          else if (body.state === "response_written") requireThat(++responseWritten === 1
            && prepared === 1 && completions === 0 && body.revision === written.revision);
          else if (body.state === "resolved") requireThat(++resolved === 1
            && responseWritten === 1 && body.revision === written.revision + 1);
          else refuse();
          break;
        case "item_started": case "item_completed": case "reasoning_summary_delta":
        case "tool_progress": case "file_change": case "plan_updated":
        case "diff_updated": case "token_usage": break;
      }
    };

    for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
      const page = sessionEventPageSchema.parse(await readBoundedPage(input, cursor));
      requireThat(!input.signal.aborted);
      bytes += Buffer.byteLength(JSON.stringify(page), "utf8");
      requireThat(bytes <= maximumBytes && page.sessionId === input.sessionId && page.gap === null
        && page.requestedCursor === (cursor ?? null)
        && (floor === undefined || floor === page.retentionFloorCursor));
      floor = page.retentionFloorCursor;
      for (const event of page.events) inspect(event);
      if (page.nextCursor === page.observedThroughCursor) {
        requireThat(!input.signal.aborted);
        if (completions === 0) return null;
        requireThat(userCount === 1 && starts === 1 && requested === 1 && prepared === 1
          && responseWritten === 1 && assistantItem !== undefined);
        z.object({ submissionId: z.literal(input.submissionId),
          receiptSha256: z.literal(input.receiptSha256), nonce: z.literal(input.nonce) })
          .strict().parse(JSON.parse(assistant) as unknown);
        // This admitted document is flat with three known string values. Count
        // member-name tokens too: JSON.parse alone silently accepts duplicates.
        const memberNames = [...assistant.matchAll(/"(?:\\.|[^"\\])*"\s*:/gu)]
          .map((match) => JSON.parse(match[0].slice(0, match[0].lastIndexOf(":"))) as unknown);
        requireThat(memberNames.length === 3 && new Set(memberNames).size === 3);
        return Object.freeze({ exactReceiptEcho: true as const,
          echoSha256: createHash("sha256").update(echo, "utf8").digest("hex") });
      }
      requireThat(page.events.length > 0 && !cursors.has(page.nextCursor));
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    return refuse();
  } catch {
    return refuse();
  }
}
