/*
 * Live projection batching.
 *
 * The daemon streams the current turn to the hosted `detail` stream so a
 * browser can render text while it is produced. This module holds the pure
 * parts: coalescing local delta events into bounded detail events, redacting
 * text before it is encrypted with a carry-over window so a secret or a path
 * split across two batches cannot pass both checks, and deciding when a batch
 * must flush. The bridge owns transport, leases, and head cursors.
 */

import { redactAbsolutePaths } from "../domain/text-safety";
import type { SessionEvent } from "../domain/session-events";
import { redactCompleteSensitiveText } from "../sensitive-text";

import type { DetailSessionEvent } from "./projection";

export const LIVE_BATCH_INTERVAL_MS = 1_000;
export const LIVE_BATCH_MAX_BYTES = 8 * 1024;
export const LIVE_TEXT_MAX_CHARACTERS = 32_000;
export const LIVE_REDACTION_CARRY_BYTES = 256;

const utf8 = new TextEncoder();

const forbiddenLiveTokenPattern =
  /(?:-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|\b(?:sk|re)_[A-Za-z0-9_-]{8,}|\bsk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9_-]{8,}|\bAKIA[A-Z0-9]{12,}|\bBearer\s+[A-Za-z0-9._~-]{8,})/gu;

export function redactLiveText(text: string): string {
  return redactCompleteSensitiveText(redactAbsolutePaths(text))
    .replace(forbiddenLiveTokenPattern, "[redacted]");
}

/*
 * A redaction window per open text stream. Text is appended raw; `take`
 * returns everything that is safe to release now: the redacted prefix minus a
 * trailing carry of up to 256 bytes that stays back until more text arrives
 * or the stream closes. Redaction always runs over carry plus new text, so a
 * token that straddles two batches is seen whole at least once.
 */
export class LiveRedactionWindow {
  #pending = "";

  append(text: string): void {
    this.#pending += text;
  }

  take(close: boolean): string {
    if (this.#pending.length === 0) return "";
    const redacted = redactLiveText(this.#pending);
    if (close) {
      this.#pending = "";
      return redacted;
    }
    const carryStart = carryBoundary(this.#pending, LIVE_REDACTION_CARRY_BYTES);
    if (carryStart <= 0) return "";
    const released = this.#pending.slice(0, carryStart);
    this.#pending = this.#pending.slice(carryStart);
    const redactedReleased = redactLiveText(released);
    // If redaction changed the text across the carry boundary, keep the whole
    // thing back; it will be released whole on close or once more text lands.
    if (!redacted.startsWith(redactedReleased)) {
      this.#pending = released + this.#pending;
      return "";
    }
    return redactedReleased;
  }

  get pendingCharacters(): number {
    return this.#pending.length;
  }
}

function carryBoundary(text: string, carryBytes: number): number {
  let bytes = 0;
  let index = text.length;
  while (index > 0 && bytes < carryBytes) {
    const previous = index - 1;
    const code = text.charCodeAt(previous);
    const start = code >= 0xdc00 && code <= 0xdfff && previous > 0 ? previous - 1 : previous;
    bytes += utf8.encode(text.slice(start, index)).byteLength;
    index = start;
  }
  return index;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type LiveDetailBody = DistributiveOmit<DetailSessionEvent, "sequence">;

type LiveTextBody = Extract<LiveDetailBody, { type: "assistant_delta" | "reasoning_summary_delta" }>;

export type LiveBatch = Readonly<{
  bodies: readonly LiveDetailBody[];
  /** True when a turn completed inside the batch and everything must ship now. */
  flush: boolean;
  /** Local ledger sequence consumed through, for the caller's cursor. */
  throughLocalSequence: number;
}>;

type StreamKey = `${string}:${"assistant_delta" | "reasoning_summary_delta"}`;

/*
 * Per-session live batcher. Feed local session events in ledger order; it
 * coalesces contiguous delta text per turn and kind, keeps open streams behind
 * the redaction window, and surfaces turn boundaries and state changes as
 * detail bodies. `drain` returns what is ready to upload.
 */
export class LiveBatcher {
  readonly #windows = new Map<StreamKey, LiveRedactionWindow>();
  readonly #includeThinking: boolean;
  #queued: LiveDetailBody[] = [];
  #flush = false;
  #throughLocalSequence = 0;

  constructor(options: Readonly<{ includeThinking: boolean }>) {
    this.#includeThinking = options.includeThinking;
  }

  observe(event: SessionEvent): void {
    this.#throughLocalSequence = Math.max(this.#throughLocalSequence, event.sequence);
    const body = event.body;
    switch (body.type) {
      case "turn_started": {
        this.#closeAllStreams();
        this.#queued.push({ at: event.recordedAt, turnId: body.turnId, type: "turn_started" });
        return;
      }
      case "assistant_delta":
      case "reasoning_summary_delta": {
        if (body.type === "reasoning_summary_delta" && !this.#includeThinking) return;
        if (body.text.length === 0) return;
        this.#window(`${body.turnId}:${body.type}`).append(body.text);
        return;
      }
      case "turn_completed": {
        this.#closeAllStreams();
        this.#flush = true;
        return;
      }
      case "subagent_activity": {
        this.#queued.push({
          agentId: body.agentId,
          ...(body.depth === undefined ? {} : { depth: body.depth }),
          kind: body.kind,
          ...(body.nickname === undefined ? {} : { nickname: body.nickname }),
          ...(body.role === undefined ? {} : { role: body.role }),
          turnId: body.turnId,
          type: "subagent_activity",
        });
        return;
      }
      case "session_state": {
        this.#queued.push({
          attention: body.attention,
          lastActivityAt: body.lastActivityAt,
          reason: body.reason,
          revision: body.revision,
          state: body.state,
          type: "session_state",
          verbatimRequired: body.verbatimRequired,
        });
        this.#flush = true;
        return;
      }
      // The neutral transcript records (`user_message`, `provider_switched`)
      // are durable local history, not live detail: the hosted compact lane
      // already carries the user message it projects from the provider.
      case "user_message":
      case "provider_switched":
      case "connection":
      case "gap":
      case "session_status":
      case "item_started":
      case "item_completed":
      case "tool_progress":
      case "file_change":
      case "plan_updated":
      case "diff_updated":
      case "token_usage":
      case "compaction":
      case "interaction_requested":
      case "interaction_state":
      case "warning":
      case "error":
      case "protocol_incompatible":
        return;
    }
  }

  get hasOpenStream(): boolean {
    for (const window of this.#windows.values()) {
      if (window.pendingCharacters > 0) return true;
    }
    return false;
  }

  /*
   * Release everything that is ready. Open delta streams contribute their
   * redacted text minus the carry; closed streams were already queued.
   */
  drain(): LiveBatch {
    for (const [key, window] of this.#windows) {
      const text = window.take(false);
      if (text.length > 0) this.#pushText(key, text);
    }
    const bodies = this.#boundBodies(this.#queued);
    const batch: LiveBatch = {
      bodies,
      flush: this.#flush,
      throughLocalSequence: this.#throughLocalSequence,
    };
    this.#flush = this.#queued.length > 0 && this.#flush;
    return batch;
  }

  #window(key: StreamKey): LiveRedactionWindow {
    let window = this.#windows.get(key);
    if (window === undefined) {
      window = new LiveRedactionWindow();
      this.#windows.set(key, window);
    }
    return window;
  }

  #closeAllStreams(): void {
    for (const [key, window] of this.#windows) {
      const text = window.take(true);
      if (text.length > 0) this.#pushText(key, text);
    }
    this.#windows.clear();
  }

  #pushText(key: StreamKey, text: string): void {
    const separator = key.lastIndexOf(":");
    const turnId = key.slice(0, separator);
    const type = key.slice(separator + 1) as LiveTextBody["type"];
    const last = this.#queued.at(-1);
    if (
      last !== undefined
      && (last.type === "assistant_delta" || last.type === "reasoning_summary_delta")
      && last.type === type
      && last.turnId === turnId
      && last.text.length + text.length <= LIVE_TEXT_MAX_CHARACTERS
    ) {
      const merged: LiveTextBody = { text: last.text + text, turnId, type };
      this.#queued[this.#queued.length - 1] = merged;
      return;
    }
    for (let offset = 0; offset < text.length; offset += LIVE_TEXT_MAX_CHARACTERS) {
      const body: LiveTextBody = { text: text.slice(offset, offset + LIVE_TEXT_MAX_CHARACTERS), turnId, type };
      this.#queued.push(body);
    }
  }

  #boundBodies(bodies: readonly LiveDetailBody[]): readonly LiveDetailBody[] {
    const bounded: LiveDetailBody[] = [];
    let bytes = 0;
    for (const body of bodies) {
      const size = utf8.encode(JSON.stringify(body)).byteLength;
      if (bounded.length > 0 && bytes + size > LIVE_BATCH_MAX_BYTES) {
        // Keep the remainder queued for the next drain.
        this.#queued = bodies.slice(bounded.length);
        return bounded;
      }
      bounded.push(body);
      bytes += size;
    }
    this.#queued = [];
    return bounded;
  }
}

export function assignDetailSequences(
  bodies: readonly LiveDetailBody[],
  afterSequence: number,
): readonly DetailSessionEvent[] {
  return bodies.map((body, index) => ({ ...body, sequence: afterSequence + index + 1 }));
}
