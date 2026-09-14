/**
 * The transcript derivation.
 *
 * The session screen renders the compact history plus whatever the live tail has
 * accumulated for the turn in flight. Those two sources overlap: the daemon
 * flushes the compact `assistant_message` for a turn after the deltas that built
 * it, so a naive concatenation shows the same answer twice. The rule here is
 * that the compact stream is authoritative for any turn it has closed, and the
 * live text is appended only for a turn the compact stream has not reached.
 *
 * Nothing in this file touches React.
 */
import type {
  CompactMessageActor,
  CompactMessageActorKind,
  CompactSessionEvent,
  GitAction,
} from "../oompa/cloud";
import { parseAttachmentManifest, type AttachmentManifestEntry } from "./attachments";

export type TranscriptMessageActor = CompactMessageActor | CompactMessageActorKind;

export type TranscriptEntry =
  | Readonly<{
      actor: TranscriptMessageActor;
      /**
       * The bounded manifest a `user_message` may carry: name, media type,
       * size, and digest, never bytes. Null when the message had none.
       */
      attachments: readonly AttachmentManifestEntry[] | null;
      key: string;
      kind: "user";
      text: string;
    }>
  | Readonly<{ key: string; kind: "assistant"; streaming: boolean; text: string }>
  | Readonly<{
      filesTouched: number;
      gitActions: readonly string[];
      key: string;
      kind: "turn_summary";
      runtimeMs: number;
    }>;

/**
 * Merges two compact event lists by sequence.
 *
 * The screen walks the whole compact history once on mount and subscribes to the
 * tail of the same stream, so an event that arrives while the session is open
 * shows up without a remount. Sequences are unique per stream, so the sequence
 * is the identity and a duplicate is dropped rather than folded twice.
 */
export function mergeCompactEvents(
  ...lists: readonly (readonly CompactSessionEvent[])[]
): readonly CompactSessionEvent[] {
  const bySequence = new Map<number, CompactSessionEvent>();
  for (const list of lists) {
    for (const event of list) bySequence.set(event.sequence, event);
  }
  return [...bySequence.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, event]) => event);
}

function gitActionLabels(actions: readonly GitAction[]): readonly string[] {
  return actions.map((action) => action.label ?? action.kind);
}

/**
 * The attachment manifest on a compact `user_message`, parsed from `unknown`.
 *
 * The field is read off the event rather than off the type on purpose. The
 * daemon-side projection is being widened in parallel, and until it is,
 * `parseCompactSessionEvent` drops the key and this returns null: the transcript
 * renders exactly as it does today. When the projection starts carrying the
 * manifest, nothing here changes. `parseAttachmentManifest` bounds it and
 * refuses any entry that carries bytes, so a projection that started shipping
 * image data would render nothing rather than being trusted.
 */
function readAttachmentManifest(
  event: CompactSessionEvent,
): readonly AttachmentManifestEntry[] | null {
  const record = event as unknown as Readonly<Record<string, unknown>>;
  return parseAttachmentManifest(record.attachments);
}

export type LiveTurn = Readonly<{
  streamingText: string;
  turnId: string | null;
}>;

/**
 * Folds compact events into rendered entries and appends the live tail when the
 * compact stream has not yet closed that turn.
 */
export function deriveTranscript(
  events: readonly CompactSessionEvent[],
  live: LiveTurn,
): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const closedTurns = new Set<string>();

  for (const event of events) {
    switch (event.kind) {
      case "user_message":
        entries.push({
          actor: event.actorKind ?? event.actor ?? "human",
          attachments: readAttachmentManifest(event),
          key: `compact-${String(event.sequence)}`,
          kind: "user",
          text: event.text,
        });
        break;
      case "assistant_message":
        closedTurns.add(event.turnId);
        entries.push({
          key: `compact-${String(event.sequence)}`,
          kind: "assistant",
          streaming: false,
          text: event.text,
        });
        break;
      case "turn_summary":
        entries.push({
          filesTouched: event.filesTouched.length,
          gitActions: gitActionLabels(event.gitActions),
          key: `compact-${String(event.sequence)}`,
          kind: "turn_summary",
          runtimeMs: event.runtimeMs,
        });
        break;
      case "interaction_state":
        // Pending interactions are rendered by their own panel above the input,
        // where the reader can act on them, rather than inline in the scroll.
        break;
    }
  }

  if (
    live.turnId !== null
    && live.streamingText.length > 0
    && !closedTurns.has(live.turnId)
  ) {
    entries.push({
      key: `live-${live.turnId}`,
      kind: "assistant",
      streaming: true,
      text: live.streamingText,
    });
  }

  return entries;
}

/**
 * The key of the newest assistant entry, streaming or closed. Every other
 * assistant entry starts collapsed in a card, so a long history scrolls as a
 * list of one-line summaries rather than a wall of results.
 */
export function latestAssistantKey(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry !== undefined && entry.kind === "assistant") return entry.key;
  }
  return null;
}

export const summaryLineCharacters = 120;

/**
 * The one line a collapsed response shows: the first non-empty line with
 * Markdown heading, emphasis, quote and code markers stripped, bounded.
 */
export function summaryLine(text: string): string {
  const line = text
    .split("\n")
    .map((candidate) => candidate
      .replace(/^[\s>#*+-]+/u, "")
      .replace(/^\d+\.\s+/u, "")
      .replace(/[`*_~]/gu, "")
      .trim())
    .find((candidate) => candidate.length > 0) ?? "";
  if (line.length <= summaryLineCharacters) return line;
  return `${line.slice(0, summaryLineCharacters - 1).trimEnd()}\u2026`;
}
