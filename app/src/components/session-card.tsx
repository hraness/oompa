import * as stylex from "@stylexjs/stylex";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
} from "react";

import { ComposerAttachmentChips } from "./attachment-chips";
import { ComposerTextarea } from "./composer-textarea";
import { ConversationPanel } from "./conversation-panel";
import { AttachIcon, DragHandleIcon, KebabIcon, StopIcon } from "./icons";
import { InteractionPanel } from "./interaction-panel";
import { ScheduledTasksBadge } from "./scheduled-tasks-badge";
import { StateIndicator } from "./state-indicator";
import { SubagentChips } from "./subagent-chips";
import { Button } from "./ui/button";
import { Card } from "./ui/card";
import { Dialog, DialogFooter, DialogTitle } from "./ui/dialog";
import { DropdownMenu, type DropdownMenuItem } from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Sheet } from "./ui/sheet";
import { useCommandState, useSubmitCommand } from "../data/commands";
import { useComposerAttachments } from "../data/composer-attachments";
import { holdSentAttachment } from "../data/sent-attachments";
import { useSessionModel, type SessionHistoryMode } from "../data/session-model-hook";
import type { SessionHead } from "../data/wire";
import type { RemoteCommandPayload } from "../oompa/cloud";
import {
  attachmentAcceptAttribute,
  attachmentSendSupported,
  buildSendPayload,
  defaultMessageForAttachments,
} from "../model/attachments";
import {
  buildDefaultSetProviderPayload,
  providerSwitchDisabledReason,
  providerSwitchNote,
  providerSwitchNotice,
  providerSwitchOptions,
  providerSwitchSupported,
  type SessionProvider,
} from "../model/provider-switch";
import {
  interactionCommandPublicId,
  interactionInstanceKey,
  shortSessionLabel,
  type SessionCardSummary,
} from "../model/session-view";
import { deriveTranscript } from "../model/transcript";
import { sessionCardStyles } from "./session-card.stylex";

/**
 * What the grid tells one card about the reader's arrangement.
 *
 * The card owns no ordering state. It reports a drag gesture and a keyboard
 * step upward, and it renders whatever the grid says about the arrangement in
 * progress, so the whole arrangement stays in one reducer.
 */
export type SessionCardOrdering = Readonly<{
  /** Whether the reader has arranged anything, so the reset item is offered. */
  arranged: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  /** This card is the one under the pointer, so it shows where the drop lands. */
  dropTarget: boolean;
  /** This card is the one being dragged. */
  dragging: boolean;
  onDragStart: (sessionPublicId: string, event: PointerEvent<HTMLElement>) => void;
  onMove: (sessionPublicId: string, direction: "left" | "right") => void;
  onReset: () => void;
}>;

export type SessionCardProps = Readonly<{
  head: SessionHead;
  onSummary: (summary: SessionCardSummary) => void;
  ordering: SessionCardOrdering;
}>;

type ApprovalMode = "auto:all" | "auto:workspace" | "manual";

const approvalOptions: readonly (readonly [ApprovalMode, string])[] = [
  ["auto:all", "Auto (all)"],
  ["auto:workspace", "Auto (workspace)"],
  ["manual", "Manual"],
];

function failureMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : "The command was not accepted.";
}

function ChoiceRow({
  disabled = false,
  label,
  onSelect,
  selected,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onSelect: () => void;
  selected: boolean;
}>): ReactNode {
  return (
    <button
      aria-pressed={selected}
      {...stylex.props(
        sessionCardStyles.choice,
        selected ? sessionCardStyles.choiceSelected : sessionCardStyles.choiceIdle,
      )}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      {label}
      {selected ? <span aria-hidden="true">✓</span> : null}
    </button>
  );
}

/**
 * One grid card, holding its whole conversation.
 *
 * The card owns its own subscriptions, because a session's state lives in its
 * encrypted streams and not on the head the grid paginates. It starts on the
 * bounded compact tail and walks the full history only when the reader asks
 * for earlier turns, so a grid of many sessions never decrypts everything at
 * once. It reports the facts the grid needs for ordering back up through
 * `onSummary`: whether it wants a human, whether it is working, and when it
 * last moved.
 *
 * Every decision the reader takes here goes out as a durable command bound to
 * the session's execution device. Nothing in a card executes anything; the
 * daemon is the only authority.
 */
export function SessionCard({
  head,
  onSummary,
  ordering,
}: SessionCardProps): ReactNode {
  const [history, setHistory] = useState<SessionHistoryMode>("tail");
  const { compactEvents, historyLoading, liveModel, metadata, model } = useSessionModel(
    head,
    { history },
  );
  const submit = useSubmitCommand();

  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [showId, setShowId] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode | null>(null);
  const [provider, setProvider] = useState<SessionProvider | null>(null);
  const [providerCommandId, setProviderCommandId] = useState<string | null>(null);
  const [decisionCommand, setDecisionCommand] = useState<Readonly<{
    interactionKey: string;
    publicId: string;
  }> | null>(null);
  const attach = useComposerAttachments();
  const pickerRef = useRef<HTMLInputElement>(null);

  const publicId = head.publicId;
  const title = model.title ?? shortSessionLabel(publicId);
  const lastActivityAt = Math.max(model.lastActivityAt, head.updatedAt);
  const archived = metadata.archived;
  const retired = metadata.retiredProvider === "devin";

  const summary = useMemo<SessionCardSummary>(() => ({
    archived,
    ...(retired ? { retiredProvider: "devin" as const } : {}),
    attention: model.attention,
    lastActivityAt,
    metadataRevision: head.metadataRevision,
    publicId,
    state: model.state,
    title,
  }), [
    archived,
    head.metadataRevision,
    lastActivityAt,
    model.attention,
    model.state,
    publicId,
    title,
    retired,
  ]);

  useEffect(() => { onSummary(summary); }, [onSummary, summary]);

  const entries = useMemo(
    () => deriveTranscript(compactEvents, {
      streamingText: liveModel.streamingText,
      turnId: liveModel.turnId,
    }),
    [compactEvents, liveModel.streamingText, liveModel.turnId],
  );
  // A blocking interaction is holding the turn, so it is the one to answer
  // first; otherwise the most recent one is on top.
  const interaction = model.pendingInteractions.find((entry) => entry.blocking)
    ?? model.pendingInteractions.at(-1)
    ?? null;
  const currentInteractionKey = interaction === null
    ? null
    : interactionInstanceKey(interaction);
  const decisionCommandId = interactionCommandPublicId(decisionCommand, interaction);

  const run = useCallback((
    payload: RemoteCommandPayload,
    pending: string,
  ) => {
    if (retired) return;
    setBusy(true);
    setNotice(pending);
    void submit({
      executionDevicePublicId: head.executionDevicePublicId,
      payload,
      sessionPublicId: publicId,
    })
      .then(() => { setNotice(null); })
      .catch((failure: unknown) => { setNotice(failureMessage(failure)); })
      .finally(() => { setBusy(false); });
  }, [head.executionDevicePublicId, publicId, retired, submit]);

  const send = useCallback(async (payload: RemoteCommandPayload): Promise<string | null> => {
    if (retired) return null;
    setSending(true);
    setNotice(null);
    try {
      return await submit({
        executionDevicePublicId: head.executionDevicePublicId,
        payload,
        sessionPublicId: publicId,
      });
    } catch (failure: unknown) {
      setNotice(failureMessage(failure));
      return null;
    } finally {
      setSending(false);
    }
  }, [head.executionDevicePublicId, publicId, retired, submit]);

  const copyId = useCallback(() => {
    // `clipboard-write` is not denied by the app's permissions policy, but a
    // browser may still refuse it outside a secure context or a user gesture it
    // recognises. The dialog is the fallback, never a silent failure.
    void navigator.clipboard.writeText(publicId)
      .then(() => { setNotice("Session id copied."); })
      .catch(() => { setShowId(true); });
  }, [publicId]);

  const providerCommand = useCommandState(providerCommandId);
  const providerDisabledReason = retired
    ? "Devin support is retired; this session is read-only."
    : providerSwitchDisabledReason({
        sending,
        supported: providerSwitchSupported(),
        turnActive: model.turnActive,
      });
  const providerNotice = providerSwitchNotice(providerCommand, provider);

  const attachments = attach.attachments;
  const typed = message.trim();
  // Attachments alone are a message: with nothing typed, the file names are the
  // text, which is factual rather than a sentence invented on the reader's
  // behalf. The daemon refuses an empty message, so something has to be there.
  const outgoing = typed.length > 0 ? typed : defaultMessageForAttachments(attachments);
  const canSend = !retired && !sending && !attach.busy && outgoing.length > 0;

  const sendMessage = () => {
    if (!canSend) return;
    if (attach.sendRefusal !== null) {
      setNotice(attach.sendRefusal);
      return;
    }
    if (attachments.length > 0 && !attachmentSendSupported()) {
      setNotice(
        "This build does not carry attachments to the machine yet. "
        + "Send the message without them, or update the machine.",
      );
      return;
    }
    void send(buildSendPayload({ attachments, message: outgoing }))
      .then((commandPublicId) => {
        if (commandPublicId === null) return;
        // Only this tab can show these bytes again, and only until it reloads.
        for (const item of attachments) {
          if (item.kind !== "image") continue;
          holdSentAttachment({
            bytes: item.bytes,
            digest: item.digest,
            mediaType: item.mediaType,
          });
        }
        setMessage("");
        attach.clear();
      });
  };

  const menuItems: readonly DropdownMenuItem[] = [
    {
      disabled: !ordering.canMoveLeft,
      id: "move-left",
      label: "Move left",
      onSelect: () => { ordering.onMove(publicId, "left"); },
    },
    {
      disabled: !ordering.canMoveRight,
      id: "move-right",
      label: "Move right",
      onSelect: () => { ordering.onMove(publicId, "right"); },
    },
    {
      disabled: retired,
      id: "settings",
      label: "Approvals and provider",
      onSelect: () => { setSettingsOpen(true); },
    },
    {
      disabled: busy || retired,
      id: "rename",
      label: "Rename",
      onSelect: () => {
        setRenameValue(model.title ?? "");
        setRenaming(true);
      },
    },
    {
      disabled: busy || retired,
      id: "archive",
      label: "Archive",
      onSelect: () => { run({ archived: true, kind: "archive_session" }, "Archiving."); },
    },
    { id: "copy", label: "Copy id", onSelect: copyId },
    ...(ordering.arranged
      ? [{ id: "reset-order", label: "Reset card order", onSelect: ordering.onReset }]
      : []),
  ];

  return (
    <Card
      data-session-id={publicId}
      xstyle={[
        sessionCardStyles.card,
        model.attention ? sessionCardStyles.attention : null,
        ordering.dragging ? sessionCardStyles.dragging : null,
        ordering.dropTarget ? sessionCardStyles.dropTarget : null,
      ]}
    >
      <div {...stylex.props(sessionCardStyles.header)}>
        {/*
          The handle is the only place a drag starts. `touch-none` hands the
          gesture to the pointer handlers instead of the scroller.
        */}
        <button
          aria-label={`Reorder ${title}. Use the arrow keys, or the card menu.`}
          {...stylex.props(sessionCardStyles.dragHandle)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            ordering.onMove(publicId, event.key === "ArrowLeft" ? "left" : "right");
          }}
          onPointerDown={(event) => { ordering.onDragStart(publicId, event); }}
          type="button"
        >
          <DragHandleIcon />
        </button>
        <div {...stylex.props(sessionCardStyles.titleBlock)}>
          <h2 {...stylex.props(sessionCardStyles.title)}>{title}</h2>
          <StateIndicator state={model.state} />
        </div>
        <div {...stylex.props(sessionCardStyles.menu)}>
          <DropdownMenu
            items={menuItems}
            label={`Session actions for ${title}`}
            trigger={<KebabIcon />}
          />
        </div>
      </div>

      {retired ? (
        <p {...stylex.props(sessionCardStyles.quiet)}>Devin retired · read-only</p>
      ) : null}
      <SubagentChips sessionTitle={title} subagents={model.subagents} />
      <ScheduledTasksBadge sessionPublicId={publicId} />

      <ConversationPanel
        canLoadEarlier={history === "tail" && entries.length > 0}
        entries={entries}
        historyLoading={historyLoading}
        label={`Conversation of ${title}`}
        onLoadEarlier={() => { setHistory("full"); }}
        thinkingText={liveModel.thinkingText}
      />

      <div {...stylex.props(sessionCardStyles.composer)}>
        {interaction === null || retired ? null : (
          <InteractionPanel
            commandPublicId={decisionCommandId}
            interaction={interaction}
            key={interactionInstanceKey(interaction)}
            onResolve={async (payload) => {
              const commandPublicId = await send(payload);
              if (commandPublicId !== null && currentInteractionKey !== null) {
                setDecisionCommand({
                  interactionKey: currentInteractionKey,
                  publicId: commandPublicId,
                });
              }
              return commandPublicId;
            }}
            submitting={sending}
          />
        )}
        {notice === null ? null : (
          <p {...stylex.props(sessionCardStyles.notice)} role="status">{notice}</p>
        )}
        {attach.notice === null ? null : (
          <p {...stylex.props(sessionCardStyles.danger)} role="status">{attach.notice}</p>
        )}
        <ComposerAttachmentChips attachments={attachments} onRemove={attach.remove} />
        {attach.busy ? (
          <p {...stylex.props(sessionCardStyles.quiet)} role="status">Preparing the attachments.</p>
        ) : null}
        <form
          {...stylex.props(sessionCardStyles.form, attach.dragging && sessionCardStyles.dragActive)}
          onDragLeave={attach.onDragLeave}
          onDragOver={attach.onDragOver}
          onDrop={attach.onDrop}
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <input
            accept={attachmentAcceptAttribute}
            aria-hidden="true"
            {...stylex.props(sessionCardStyles.fileInput)}
            multiple
            onChange={attach.onPick}
            ref={pickerRef}
            tabIndex={-1}
            type="file"
          />
          <Button
            aria-label="Attach a file"
            disabled={retired}
            onClick={() => { pickerRef.current?.click(); }}
            size="icon"
            variant="ghost"
            xstyle={sessionCardStyles.composerIcon}
          >
            <AttachIcon />
          </Button>
          <ComposerTextarea
            aria-label="Message this session"
            disabled={retired}
            onChange={setMessage}
            onPaste={attach.onPaste}
            onSubmit={sendMessage}
            placeholder="Send or steer. Shift+Enter for a new line."
            value={message}
          />
          {model.turnActive ? (
            <Button
              aria-label="Stop the turn"
              disabled={sending || retired}
              onClick={() => { void send({ kind: "stop" }); }}
              size="icon"
              variant="secondary"
              xstyle={sessionCardStyles.composerIcon}
            >
              <StopIcon />
            </Button>
          ) : null}
          <Button disabled={!canSend} size="small" type="submit">
            Send
          </Button>
        </form>
      </div>

      <Sheet
        label={`Settings for ${title}`}
        onClose={() => { setSettingsOpen(false); }}
        open={settingsOpen}
      >
        <h2 {...stylex.props(sessionCardStyles.heading)}>Approvals</h2>
        <p {...stylex.props(sessionCardStyles.menuDescription)}>
          Applies to this session. The daemon holds the current value, so nothing
          is highlighted until you set one from here.
        </p>
        <div {...stylex.props(sessionCardStyles.menuOptions)}>
          {approvalOptions.map(([value, label]) => (
            <ChoiceRow
              disabled={retired}
              key={value}
              label={label}
              onSelect={() => {
                setApprovalMode(value);
                setSettingsOpen(false);
                void send({ kind: "set_approval_mode", mode: value, scope: "session" });
              }}
              selected={approvalMode === value}
            />
          ))}
        </div>

        <h2 {...stylex.props(sessionCardStyles.heading, sessionCardStyles.headingSpaced)}>Provider</h2>
        <p {...stylex.props(sessionCardStyles.menuDescription)}>{providerSwitchNote}</p>
        <div {...stylex.props(sessionCardStyles.menuOptions)}>
          {providerSwitchOptions.map((option) => (
            <ChoiceRow
              disabled={providerDisabledReason !== null}
              key={option.provider}
              label={option.label}
              onSelect={() => {
                setProvider(option.provider);
                void send(buildDefaultSetProviderPayload(option.provider))
                  .then((commandPublicId) => { setProviderCommandId(commandPublicId); });
              }}
              selected={provider === option.provider}
            />
          ))}
        </div>
        {providerDisabledReason === null ? null : (
          <p {...stylex.props(sessionCardStyles.quiet, sessionCardStyles.status)}>{providerDisabledReason}</p>
        )}
        {providerNotice === null ? null : (
          <p {...stylex.props(sessionCardStyles.quiet, sessionCardStyles.status)} role="status">{providerNotice.text}</p>
        )}
      </Sheet>

      <Dialog
        label="Rename session"
        onClose={() => { setRenaming(false); }}
        open={renaming}
      >
        <DialogTitle>Rename session</DialogTitle>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const next = renameValue.trim();
            setRenaming(false);
            run(
              { kind: "rename_session", name: next.length === 0 ? null : next },
              "Renaming.",
            );
          }}
        >
          <Input
            aria-label="Session name"
            xstyle={sessionCardStyles.dialogInput}
            maxLength={200}
            onChange={(event) => { setRenameValue(event.target.value); }}
            placeholder="Leave empty to clear the name"
            value={renameValue}
          />
          <DialogFooter>
            <Button onClick={() => { setRenaming(false); }} variant="secondary">Cancel</Button>
            <Button type="submit">Rename</Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog label="Session id" onClose={() => { setShowId(false); }} open={showId}>
        <DialogTitle>Session id</DialogTitle>
        <p {...stylex.props(sessionCardStyles.dialogValue)}>{publicId}</p>
        <DialogFooter>
          <Button onClick={() => { setShowId(false); }} variant="secondary">Close</Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}
