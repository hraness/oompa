import * as stylex from "@stylexjs/stylex";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { TranscriptEntry } from "../model/transcript";
import { TranscriptView } from "./transcript-view";
import { Button } from "./ui/button";
import { conversationPanelStyles } from "./conversation-panel.stylex";

export type ConversationPanelProps = Readonly<{
  /** Whether the card is still on its bounded tail and could load the rest. */
  canLoadEarlier: boolean;
  entries: readonly TranscriptEntry[];
  historyLoading: boolean;
  label: string;
  onLoadEarlier: () => void;
  thinkingText: string;
}>;

/** How close to the bottom the reader must be for new output to keep following. */
const followThresholdPx = 48;

/**
 * The scrollable conversation inside a card.
 *
 * The region is bounded, scrolls on its own, and follows new output while the
 * reader is at the bottom. When earlier history is loaded above, the scroll
 * position is held on the entry the reader was looking at, which Safari does
 * not do on its own. Which responses are open is the reader's choice and
 * lives here, keyed by entry, so a re-render never folds a response back.
 */
export function ConversationPanel({
  canLoadEarlier,
  entries,
  historyLoading,
  label,
  onLoadEarlier,
  thinkingText,
}: ConversationPanelProps): ReactNode {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const anchor = useRef<Readonly<{ firstKey: string; scrollHeight: number }> | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    following.current = distance < followThresholdPx;
  }, []);

  const firstKey = entries[0]?.key ?? null;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const held = anchor.current;
    if (held !== null && held.firstKey !== firstKey) {
      // Content was prepended: keep the previously first entry where it was.
      element.scrollTop += element.scrollHeight - held.scrollHeight;
      anchor.current = null;
      return;
    }
    if (following.current) element.scrollTop = element.scrollHeight;
  }, [entries, firstKey]);

  const loadEarlier = () => {
    const element = scroller.current;
    if (element !== null && firstKey !== null) {
      anchor.current = { firstKey, scrollHeight: element.scrollHeight };
      following.current = false;
    }
    onLoadEarlier();
  };

  const expand = useCallback((key: string) => {
    following.current = false;
    setExpanded((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      return next;
    });
  }, []);

  return (
    <div
      aria-label={label}
      {...stylex.props(conversationPanelStyles.scroller)}
      onScroll={onScroll}
      ref={scroller}
      role="log"
    >
      {canLoadEarlier ? (
        <div {...stylex.props(conversationPanelStyles.earlier)}>
          <Button disabled={historyLoading} onClick={loadEarlier} size="small" variant="ghost">
            {historyLoading ? "Loading earlier turns" : "Earlier"}
          </Button>
        </div>
      ) : null}
      {entries.length === 0 && thinkingText.length === 0 ? (
        <p {...stylex.props(conversationPanelStyles.quiet)}>
          {historyLoading ? "Loading the conversation." : "No turns yet."}
        </p>
      ) : null}
      <TranscriptView
        entries={entries}
        expanded={expanded}
        onExpand={expand}
        thinkingText={thinkingText}
      />
    </div>
  );
}
