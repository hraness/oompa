import { AppearanceButton } from "../components/appearance";
import * as stylex from "@stylexjs/stylex";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { ComposerTextarea } from "../components/composer-textarea";
import { SettingsIcon } from "../components/icons";
import { SessionCard } from "../components/session-card";
import { Button } from "../components/ui/button";
import { UsageMeter } from "../components/usage-meter";
import { useCardOrder } from "../data/card-order";
import { useAutomaticEffort } from "../data/automatic-effort";
import { browserStartDecision, browserStartEffortHint } from "../model/automatic-effort";
import {
  deviceCommandCommittedRowUnavailableMessage,
  DeviceCommandResponseInvalidError,
  useDeviceCommandTracker,
  useSubmitDeviceCommand,
} from "../data/device-commands";
import { useDeviceRegistries } from "../data/registry";
import { useSessionHeads } from "../data/session-heads";
import { navigate } from "../routing/router";
import { settingsRoute } from "../routing/route";
import {
  deviceCommandNotice,
  sessionStartCommand,
  sessionStartTargetHint,
  sessionStartTargetLabel,
  sessionStartTargets,
} from "../model/device-commands";
import { orderSessionCards, type SessionCardSummary } from "../model/session-view";
import { gridScreenStyles } from "./grid-screen.stylex";

function sameSummary(left: SessionCardSummary, right: SessionCardSummary): boolean {
  return left.archived === right.archived
    && left.retiredProvider === right.retiredProvider
    && left.attention === right.attention
    && left.lastActivityAt === right.lastActivityAt
    && left.metadataRevision === right.metadataRevision
    && left.state === right.state
    && left.title === right.title;
}

/** The card under the pointer during a drag, resolved from the DOM. */
function cardUnderPointer(clientX: number, clientY: number): string | null {
  const element = document.elementFromPoint(clientX, clientY);
  const host = element?.closest("[data-session-id]") ?? null;
  return host?.getAttribute("data-session-id") ?? null;
}

/**
 * The grid.
 *
 * Cards report their folded state upward, the ladder in `orderSessionCards`
 * decides the order, and the cards themselves stay mounted across a reorder
 * because they are keyed by session id: a card that floats to the front keeps
 * its subscription and its scroll position rather than remounting.
 *
 * Ordering is manual once the reader drags a card. There is no grid layout
 * library: `react-grid-layout` positions with style attributes and
 * `style-src 'self'` refuses them, so the drag is Pointer Events over the
 * ordinary CSS grid — the same code path for mouse, pen, and touch — and the
 * arrangement is a sequence of session ids, not a set of coordinates. Every
 * visual state of the drag is a class.
 *
 * The composer at the top only starts sessions: each card carries its own
 * conversation and follow-up box. A start is a device command carrying a
 * prompt and addressed to a machine; the account, preset and project are the
 * machine's defaults, resolved by `sessionStartTargets`, never by a path. The
 * browser may choose Max effort once for a conservatively bounded start. There is
 * no field for a file, so attachments belong to the card composer only.
 */
export function GridScreen(): ReactNode {
  const { heads, isLoading, loadMore, status } = useSessionHeads();
  const submitDeviceCommand = useSubmitDeviceCommand();
  const registries = useDeviceRegistries();
  const cardOrder = useCardOrder();
  const automaticEffort = useAutomaticEffort();

  const [summaries, setSummaries] = useState<Readonly<Record<string, SessionCardSummary>>>({});
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [targetKey, setTargetKey] = useState<string | null>(null);

  const handleUnavailable = useCallback(() => {
    setNotice(deviceCommandCommittedRowUnavailableMessage);
  }, []);
  const {
    observation: startObservation,
    setHandle: setStartCommandHandle,
  } = useDeviceCommandTracker(handleUnavailable);
  const startCommand = startObservation.record;
  const startNotice = deviceCommandNotice(startCommand);

  const reportSummary = useCallback((summary: SessionCardSummary) => {
    setSummaries((current) => {
      const previous = current[summary.publicId];
      if (previous !== undefined && sameSummary(previous, summary)) return current;
      return { ...current, [summary.publicId]: summary };
    });
  }, []);

  const headById = useMemo(
    () => new Map(heads.map((head) => [head.publicId, head])),
    [heads],
  );

  // Only sessions the current page actually carries take part in the ordering,
  // so a head that left the page cannot keep a stale card in the ladder.
  const known = useMemo(
    () => heads
      .map((head) => {
        const summary = summaries[head.publicId];
        return summary?.metadataRevision === head.metadataRevision ? summary : undefined;
      })
      .filter((summary): summary is SessionCardSummary => summary !== undefined),
    [heads, summaries],
  );

  const ordered = useMemo(
    () => orderSessionCards(known, cardOrder.order),
    [cardOrder.order, known],
  );

  const targets = useMemo(() => sessionStartTargets(registries.machines), [registries.machines]);
  // The picker follows the registry: a machine that disappears between renders
  // is replaced rather than left addressing something gone.
  const startTarget = useMemo(
    () => targets.find((entry) => entry.targetDevicePublicId === targetKey)
      ?? targets[0]
      ?? null,
    [targetKey, targets],
  );

  // Once the started session shows up in the grid, the command notice has done
  // its job and the composer goes quiet again.
  useEffect(() => {
    if (startCommand?.state === "applied" && heads.length > 0) {
      const timer = setTimeout(() => { setStartCommandHandle(null); }, 15_000);
      return () => { clearTimeout(timer); };
    }
    return undefined;
  }, [heads.length, startCommand?.state]);

  const canSubmit = message.trim().length > 0 && !sending && startTarget !== null;
  const startDecision = useMemo(() => startTarget === null ? null : browserStartDecision({
    automatic: automaticEffort.enabled, provider: startTarget.provider, prompt: message.trim(),
  }), [automaticEffort.enabled, startTarget, message]);

  const start = () => {
    const text = message.trim();
    if (!canSubmit || startDecision === null) return;
    // Capture one exact decision with this prompt and command. Uncertain
    // outcomes remain tracked by their original command id; never reroute them.
    const decision = startDecision;
    setSending(true);
    setNotice(null);
    void submitDeviceCommand({
      payload: sessionStartCommand({
        accountPublicId: startTarget.accountPublicId,
        preset: decision.preset,
        projectPublicId: startTarget.projectPublicId,
        prompt: text,
        provider: startTarget.provider,
      }),
      targetDevicePublicId: startTarget.targetDevicePublicId,
    })
      .then((commandPublicId) => {
        setStartCommandHandle({ publicId: commandPublicId, responseValidated: true });
        setMessage("");
      })
      .catch((failure: unknown) => {
        if (failure instanceof DeviceCommandResponseInvalidError) {
          // The mutation resolved, so the generated command may already run
          // even though its response violated the client protocol. Track that
          // committed identity and clear the prompt rather than offering an
          // accidental duplicate submission.
          setStartCommandHandle({
            publicId: failure.commandPublicId,
            responseValidated: false,
          });
          setMessage("");
          return;
        }
        setNotice(failure instanceof Error ? failure.message : "The command was not accepted.");
      })
      .finally(() => { setSending(false); });
  };

  const rendered = useMemo(() => {
    const visible = ordered
      .map((summary) => headById.get(summary.publicId))
      .filter((head): head is NonNullable<typeof head> => head !== undefined);
    // A head whose card has not reported yet is still rendered, otherwise
    // nothing would ever mount to report.
    const reported = new Set(known.map((summary) => summary.publicId));
    return [...visible, ...heads.filter((head) => !reported.has(head.publicId))];
  }, [headById, heads, known, ordered]);

  // The sequence the reader is actually looking at. Every reorder is expressed
  // against it, so a drop lands where the card appeared to be dropped even
  // while the automatic ladder is still moving cards that were never arranged.
  const displayed = useMemo(() => rendered.map((head) => head.publicId), [rendered]);
  const displayedRef = useRef(displayed);
  displayedRef.current = displayed;

  const [drag, setDrag] = useState<Readonly<{ activeId: string; overId: string | null }> | null>(
    null,
  );
  const dragRef = useRef<
    Readonly<{ activeId: string; overId: string | null; pointerId: number }> | null
  >(null);
  const dragging = drag !== null;
  const { move: moveCard, nudge } = cardOrder;

  /** The keyboard path, from the card menu or the handle's arrow keys. */
  const moveInDisplayedOrder = useCallback((
    sessionPublicId: string,
    direction: "left" | "right",
  ) => {
    nudge(displayedRef.current, sessionPublicId, direction);
  }, [nudge]);

  const beginDrag = useCallback((
    sessionPublicId: string,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    // A secondary mouse button opens a context menu; it does not drag.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // The default action would start a text selection and a scroll. Suppressing
    // it also suppresses the focus that follows a press, so the handle takes
    // focus explicitly and its arrow keys keep working after a drag.
    event.preventDefault();
    event.currentTarget.focus();
    dragRef.current = {
      activeId: sessionPublicId,
      overId: sessionPublicId,
      pointerId: event.pointerId,
    };
    setDrag({ activeId: sessionPublicId, overId: sessionPublicId });
  }, []);

  // The gesture is followed on the document rather than on the card, so a
  // finger that leaves the card, or a pointer that is cancelled by the browser,
  // still ends the drag exactly once.
  useEffect(() => {
    if (!dragging) return;
    const onPointerMove = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      event.preventDefault();
      const overId = cardUnderPointer(event.clientX, event.clientY);
      if (overId === current.overId) return;
      dragRef.current = { ...current, overId };
      setDrag({ activeId: current.activeId, overId });
    };
    const onPointerUp = (event: PointerEvent) => {
      const current = dragRef.current;
      if (current === null || event.pointerId !== current.pointerId) return;
      dragRef.current = null;
      setDrag(null);
      const overId = cardUnderPointer(event.clientX, event.clientY) ?? current.overId;
      if (overId !== null) moveCard(displayedRef.current, current.activeId, overId);
    };
    const onPointerCancel = () => {
      dragRef.current = null;
      setDrag(null);
    };
    document.addEventListener("pointermove", onPointerMove, { passive: false });
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("pointercancel", onPointerCancel);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [dragging, moveCard]);

  const hint = startTarget === null
    ? "No machine here can start a session yet. Sign an account in on a machine, run `oompa init --yes`, and leave `oompa remote allow device-commands` set."
    : `${sessionStartTargetHint({ ...startTarget, preset: startDecision?.preset ?? startTarget.preset })} ${startDecision === null ? "" : browserStartEffortHint(startDecision)}`;

  return (
    <div {...stylex.props(gridScreenStyles.root)}>
      <header
        {...stylex.props(gridScreenStyles.header)}
      >
        <div {...stylex.props(gridScreenStyles.headerRow)}>
          <Button
            aria-label="Settings"
            onClick={() => { navigate(settingsRoute); }}
            size="icon"
            variant="ghost"
          >
            <SettingsIcon />
          </Button>
          <form
            {...stylex.props(gridScreenStyles.form)}
            onSubmit={(event) => {
              event.preventDefault();
              start();
            }}
          >
            <ComposerTextarea
              aria-label="Start a new session"
              disabled={startTarget === null}
              onChange={setMessage}
              onSubmit={start}
              placeholder="Start a new session. Shift+Enter for a new line."
              value={message}
            />
            <Button disabled={!canSubmit} type="submit">
              Start
            </Button>
          </form>
          <AppearanceButton />
        </div>
        <div {...stylex.props(gridScreenStyles.controls)}>
          {targets.length > 0 ? (
            <label {...stylex.props(gridScreenStyles.label)}>
              <span>Machine</span>
              <select
                {...stylex.props(gridScreenStyles.select)}
                onChange={(event) => { setTargetKey(event.target.value); }}
                value={startTarget?.targetDevicePublicId ?? ""}
              >
                {targets.map((entry) => (
                  <option key={entry.targetDevicePublicId} value={entry.targetDevicePublicId}>
                    {sessionStartTargetLabel(entry)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p {...stylex.props(gridScreenStyles.quiet)}>{hint}</p>
        </div>
        <UsageMeter />
        {startNotice === null ? null : (
          <p
            {...stylex.props(startNotice.tone === "error" ? gridScreenStyles.danger : gridScreenStyles.quiet)}
            role="status"
          >
            {startNotice.text}
          </p>
        )}
        {startObservation.protocolWarning === null ? null : (
          <p {...stylex.props(gridScreenStyles.danger)} role="status">
            {startObservation.protocolWarning}
          </p>
        )}
        {notice === null ? null : (
          <p {...stylex.props(gridScreenStyles.quiet)} role="status">{notice}</p>
        )}
      </header>

      <main {...stylex.props(gridScreenStyles.main)}>
        {isLoading && heads.length === 0 ? (
          <p {...stylex.props(gridScreenStyles.quietBody)} role="status">Loading sessions.</p>
        ) : null}
        {!isLoading && heads.length === 0 ? (
          <p {...stylex.props(gridScreenStyles.quietBody)}>
            {startTarget === null
              ? "No sessions yet. Check your machines and accounts in Settings before starting a session."
              : "No sessions yet. Type a prompt above to start one on a machine."}
          </p>
        ) : null}
        <div {...stylex.props(gridScreenStyles.cardGrid)}>
          {rendered.map((head) => (
            <SessionCard
              head={head}
              key={head.publicId}
              onSummary={reportSummary}
              ordering={{
                arranged: cardOrder.arranged,
                canMoveLeft: cardOrder.canMove(displayed, head.publicId, "left"),
                canMoveRight: cardOrder.canMove(displayed, head.publicId, "right"),
                dragging: drag?.activeId === head.publicId,
                dropTarget: drag !== null
                  && drag.overId === head.publicId
                  && drag.activeId !== head.publicId,
                onDragStart: beginDrag,
                onMove: moveInDisplayedOrder,
                onReset: cardOrder.reset,
              }}
            />
          ))}
        </div>
        {status === "CanLoadMore" ? (
          <div {...stylex.props(gridScreenStyles.loadMore)}>
            <Button onClick={() => { loadMore(24); }} variant="secondary">Load more</Button>
          </div>
        ) : null}
      </main>
    </div>
  );
}
