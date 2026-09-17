import { z } from "zod";

import { redactAbsolutePaths } from "../domain/text-safety";
import type { CommandResponse, LocalCommand } from "../domain/contracts";
import { interactionDisplaySchema } from "../domain/interactions";
import {
  advanceSessionEventContinuity,
  initialSessionEventContinuity,
  sessionEventCursorWireSchema,
  sessionEventPageSchema,
  type SessionEvent,
  type SessionEventBody,
  type SessionEventPage,
} from "../domain/session-events";
import { sessionStatusSchema } from "../domain/observation";
import { sessionIdSchema } from "../domain/values";
import { StreamingSensitiveRedactor } from "../streaming-sensitive-text";
import { terminalSafe } from "./render";

export { StreamingSensitiveRedactor };

const liveRedactorStreamLimit = 32;
const liveTrustedItemLimit = 128;

const livePageLimit = 100;
const liveInteractionPageLimit = 100;
const liveInteractionPageCeiling = 128;
const liveInteractionItemCeiling = 10_000;
const liveWaitMs = 1_000;
const liveEmptyPageDelayMs = 25;
const liveCoalesceMs = 35;
const liveDeltaMaximumCharacters = 8 * 1_024;
const liveDiagnosticMaximumCharacters = 2_048;
const liveRetryLimit = 5;

const interactionKindSchema = z.enum([
  "command_approval",
  "file_change_approval",
  "permission_approval",
  "user_input",
  "mcp_elicitation",
]);

const pendingInteractionStateSchema = z.enum([
  "pending",
  "response_prepared",
  "response_written",
]);

const authoritativePendingInteractionSchema = z.object({
  id: z.string().uuid(),
  sessionId: sessionIdSchema,
  kind: interactionKindSchema,
  state: pendingInteractionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.boolean(),
  display: interactionDisplaySchema,
}).passthrough().superRefine((interaction, context) => {
  if (interaction.kind !== interaction.display.kind) {
    context.addIssue({
      code: "custom",
      message: "The interaction kind must match its complete public display.",
      path: ["display", "kind"],
    });
  }
}).transform((interaction) => ({
  ...interaction,
  guidance: "authoritative" as const,
}));

const summaryOnlyPendingInteractionSchema = z.object({
  id: z.string().uuid(),
  sessionId: sessionIdSchema,
  kind: interactionKindSchema,
  state: pendingInteractionStateSchema,
  revision: z.number().int().positive(),
  blocking: z.boolean(),
  display: z.object({
    summary: z.string().max(2_048),
  }).passthrough(),
}).passthrough().transform((interaction) => ({
  ...interaction,
  guidance: "show_only" as const,
}));

const pendingInteractionSchema = z.union([
  authoritativePendingInteractionSchema,
  summaryOnlyPendingInteractionSchema,
]);

const legacyProviderObservationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("live"),
    profileGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    connectionId: z.string().uuid(),
    mode: z.enum(["connected", "resubscribed"]),
  }).passthrough(),
  z.object({
    state: z.literal("unavailable"),
    profileGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    code: z.enum(["account_signed_out", "authority_retired", "resume_unavailable"]),
  }).passthrough(),
  z.object({
    state: z.literal("recovery_required"),
    profileGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    code: z.enum(["session_quarantined", "thread_mismatch"]),
  }).passthrough(),
  z.object({
    state: z.literal("not_applicable"),
    profileGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reason: z.enum(["terminal", "unbound"]),
  }).passthrough(),
]);

const legacyShellLiveStatusSchema = z.object({
  version: z.literal(1),
  session: z.object({ id: sessionIdSchema }).passthrough(),
  providerObservation: legacyProviderObservationSchema,
  eventStream: z.object({ cursor: sessionEventCursorWireSchema }).passthrough(),
  pendingInteractions: z.array(pendingInteractionSchema).max(100),
  pendingInteractionsNextCursor: z.string().min(1).max(2_048).nullable(),
}).passthrough();

const shellLiveInteractionPageSchema = z.object({
  sessionId: sessionIdSchema,
  interactions: z.array(pendingInteractionSchema).max(liveInteractionPageLimit),
  nextCursor: z.string().min(1).max(2_048).nullable(),
}).strict();

export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;
export const pendingInteractionStateKey = (
  interaction: Pick<PendingInteraction, "id" | "revision" | "state">,
): string => JSON.stringify([
  interaction.id,
  interaction.revision,
  interaction.state,
]);
type LiveCommandStyle = "cli" | "shell";

type PendingDelta = Readonly<{
  itemId: string;
  kind: "assistant" | "reasoning";
  summaryPart: number | null;
  text: string;
  truncated: boolean;
  turnId: string;
}>;

type ActiveDeltaStream = Readonly<{
  itemId: string;
  kind: PendingDelta["kind"];
  redactor: StreamingSensitiveRedactor;
  summaryPart: number | null;
  turnId: string;
}>;

type RaceResult<T> =
  | Readonly<{ kind: "aborted" }>
  | Readonly<{ error: unknown; kind: "error" }>
  | Readonly<{ kind: "value"; value: T }>;

export type ShellLiveDaemonCaller = (
  command: LocalCommand,
  signal?: AbortSignal,
) => Promise<CommandResponse>;

export type ShellLiveObserverInput = Readonly<{
  callDaemon: ShellLiveDaemonCaller;
  write: (value: string) => void;
  coalesceMs?: number;
  emptyPageDelayMs?: number;
  retryLimit?: number;
  startDelayMs?: number;
  waitMs?: number;
}>;

export type ShellLiveSelection = Readonly<{
  session: string;
  statusData: unknown;
  suppressedInitialInteractionKeys?: ReadonlySet<string>;
}>;

const boundedCharacters = (
  value: string,
  maximum: number,
): Readonly<{ text: string; truncated: boolean }> => {
  const scalars = Array.from(value);
  if (scalars.length <= maximum) return { text: value, truncated: false };
  return {
    text: `${scalars.slice(0, Math.max(0, maximum - 14)).join("")} [truncated]`,
    truncated: true,
  };
};

const sanitizeNonSecretLiveText = (value: string, preserveLineFeeds: boolean): string =>
  terminalSafe(redactAbsolutePaths(value), preserveLineFeeds);

const sanitizeCompleteLiveText = (value: string, preserveLineFeeds: boolean): string => {
  const redactor = new StreamingSensitiveRedactor();
  return sanitizeNonSecretLiveText(redactor.push(value, true), preserveLineFeeds);
};

const deltaItemKey = (turnId: string, itemId: string): string =>
  JSON.stringify([turnId, itemId]);

const safeLiveText = (
  value: string,
  maximum = liveDiagnosticMaximumCharacters,
  preserveLineFeeds = false,
): string => {
  const sanitized = sanitizeCompleteLiveText(value, preserveLineFeeds);
  return boundedCharacters(sanitized, maximum).text;
};

const indentedLiveText = (value: string): string =>
  value.split("\n")
    .map((line) => `  ${line}`)
    .join("\n");

const interactionLabel = (kind: PendingInteraction["kind"]): string => {
  switch (kind) {
    case "command_approval": return "command approval";
    case "file_change_approval": return "file change approval";
    case "permission_approval": return "permission approval";
    case "user_input": return "user input";
    case "mcp_elicitation": return "MCP form input";
  }
};

const pendingInteractionCommands = (
  interaction: PendingInteraction,
  commandStyle: LiveCommandStyle,
): readonly string[] => {
  const binding = `${interaction.id} --revision ${String(interaction.revision)}`;
  const show = commandStyle === "cli"
    ? `  Show: oompa interaction show ${interaction.id}`
    : `  Show: /interaction show ${interaction.id}`;
  if (interaction.guidance === "show_only") {
    return [
      show,
      "  Inspect the current interaction before resolving it; this event notice does not carry complete decision authority.",
    ];
  }

  const decisionCommands = (decisions: readonly ("once" | "session" | "decline" | "cancel")[]): readonly string[] =>
    decisions.map((decision) => {
      if (commandStyle === "cli") {
        return `  ${decision === "once" ? "Approve once" : decision === "session" ? "Approve for session" : decision === "decline" ? "Decline" : "Cancel"}: oompa interaction decide ${binding} --decision ${decision}`;
      }
      if (decision === "once") return `  Approve once: /approve ${binding}`;
      if (decision === "session") return `  Approve for session: /approve ${binding} --decision session`;
      if (decision === "decline") return `  Decline: /decline ${binding}`;
      return `  Cancel: /interaction decide ${binding} --decision cancel`;
    });

  if (commandStyle === "cli") {
    switch (interaction.display.kind) {
      case "command_approval":
        return [
          show,
          `  Inspect authority: oompa interaction inspect ${binding}`,
          ...decisionCommands(interaction.display.availableDecisions),
        ];
      case "file_change_approval":
        return [
          show,
          "  File-change approval is disabled because Oompa cannot display exact affected paths.",
          ...decisionCommands(interaction.display.availableDecisions.filter(
            (decision) => decision === "decline" || decision === "cancel",
          )),
        ];
      case "permission_approval":
        return [
          show,
          `  Inspect authority: oompa interaction inspect ${binding}`,
          ...(interaction.display.requested.length === 0
            ? []
            : [`  Grant selected permissions: oompa interaction grant ${binding} --input-stdin`]),
          `  Decline: oompa interaction decide ${binding} --decision decline`,
        ];
      case "user_input":
        return [show, `  Answer: oompa interaction answer ${binding} --input-stdin`];
      case "mcp_elicitation":
        if (interaction.display.mode !== "form" || interaction.display.fields === undefined) {
          return [show, "  This MCP request cannot be resolved safely through Oompa."];
        }
        return [
          show,
          `  Accept: oompa interaction submit ${binding} --action accept --input-stdin`,
          `  Decline: oompa interaction submit ${binding} --action decline`,
          `  Cancel: oompa interaction submit ${binding} --action cancel`,
        ];
    }
  }
  switch (interaction.display.kind) {
    case "command_approval":
      return [
        show,
        `  Inspect authority: /inspect ${binding}`,
        ...decisionCommands(interaction.display.availableDecisions),
      ];
    case "file_change_approval":
      return [
        show,
        "  File-change approval is disabled because Oompa cannot display exact affected paths.",
        ...decisionCommands(interaction.display.availableDecisions.filter(
          (decision) => decision === "decline" || decision === "cancel",
        )),
      ];
    case "permission_approval":
      return [
        show,
        `  Inspect authority: /inspect ${binding}`,
        ...(interaction.display.requested.length === 0
          ? []
          : [`  Grant selected permissions: /grant ${binding}`]),
        `  Decline: /decline ${binding}`,
      ];
    case "user_input":
      return [show, `  Answer: /answer ${binding}`];
    case "mcp_elicitation":
      if (interaction.display.mode !== "form" || interaction.display.fields === undefined) {
        return [show, "  This MCP request cannot be resolved safely through Oompa."];
      }
      return [
        show,
        `  Accept: /submit ${binding} --action accept`,
        `  Decline: /submit ${binding} --action decline`,
        `  Cancel: /submit ${binding} --action cancel`,
      ];
  }
};

const renderPendingInteraction = (
  interaction: PendingInteraction,
  commandStyle: LiveCommandStyle,
): string => {
  const detail = [
    `  revision ${String(interaction.revision)}${interaction.blocking ? ", blocking" : ""}`,
    `  ${safeLiveText(interaction.display.summary)}`,
  ];
  if (interaction.state === "pending") {
    return [
      `Interaction required: ${interactionLabel(interaction.kind)} ${interaction.id}`,
      ...detail,
      ...pendingInteractionCommands(interaction, commandStyle),
    ].join("\n");
  }
  return [
    `Interaction in progress: ${interactionLabel(interaction.kind)} ${interaction.id}`,
    ...detail,
    interaction.state === "response_prepared"
      ? "  A response is prepared. Do not resubmit it."
      : "  The response was sent and is awaiting provider acknowledgement. Do not resubmit it.",
  ].join("\n");
};

const interactionFromEvent = (
  sessionId: string,
  body: Extract<SessionEventBody, { type: "interaction_requested" }>,
): PendingInteraction => ({
  id: body.interactionId,
  sessionId: sessionIdSchema.parse(sessionId),
  kind: body.interactionKind,
  state: "pending",
  revision: body.revision,
  blocking: body.blocking,
  display: { summary: body.summary },
  guidance: "show_only",
});

const liveToolTarget = (
  server: string | undefined,
  tool: string | undefined,
  fallback: string,
): string => server === undefined && tool === undefined
  ? ""
  : ` ${safeLiveText(server ?? "local")}/${safeLiveText(tool ?? fallback)}`;

const liveMessageActor = (
  actor: "human" | "automation" | "autorespond" | "peer_session" | "provider_switch",
): string => actor === "human"
  ? "You"
  : actor === "automation"
    ? "Automation"
    : actor === "autorespond"
      ? "Autorespond"
      : actor === "peer_session"
        ? "Peer session"
        : "Handoff";

const renderNonDeltaEvent = (event: SessionEvent): string | null => {
  const body = event.body;
  switch (body.type) {
    case "assistant_delta":
    case "reasoning_summary_delta": return null;
    case "connection": return body.state === "disconnected"
      ? `Live connection: disconnected${body.reason === undefined ? "" : ` (${safeLiveText(body.reason)})`}`
      : null;
    case "gap": return `Live event gap: ${safeLiveText(body.reason)}.`;
    case "session_status": return `Session: ${safeLiveText(body.status)}.`;
    case "turn_started": return "Turn started.";
    case "turn_completed": return `Turn ${safeLiveText(body.status)}${body.errorCode === undefined ? "." : ` (${safeLiveText(body.errorCode)}).`}`;
    case "item_started": return `Item started: ${safeLiveText(body.itemKind)}${liveToolTarget(body.server, body.tool, body.itemKind)}.`;
    case "item_completed": return `Item completed: ${safeLiveText(body.itemKind)}${liveToolTarget(body.server, body.tool, body.itemKind)}${body.status === undefined ? "." : ` (${safeLiveText(body.status)}).`}`;
    case "tool_progress": return `Tool: ${safeLiveText(body.toolKind)}${liveToolTarget(body.server, body.tool, body.toolKind)}${body.status === undefined ? "." : `, ${safeLiveText(body.status)}.`}`;
    case "file_change": return `Files: ${safeLiveText(body.status)}, ${String(body.paths.length)} visible change${body.paths.length === 1 ? "" : "s"}${body.omittedPaths === 0 ? "." : `, ${String(body.omittedPaths)} omitted.`}`;
    case "plan_updated": return `Plan updated: ${String(body.steps.length)} step${body.steps.length === 1 ? "" : "s"}.`;
    case "diff_updated": return `Diff updated: ${String(body.changedFiles)} file${body.changedFiles === 1 ? "" : "s"}.`;
    case "token_usage": return null;
    case "compaction": return `Compaction ${safeLiveText(body.outcome)} (${safeLiveText(body.trigger)}).`;
    case "interaction_requested": return null;
    case "interaction_state": return `Interaction ${body.interactionId}: ${safeLiveText(body.state)}, revision ${String(body.revision)}.`;
    case "warning": return `Warning ${safeLiveText(body.code)}: ${safeLiveText(body.message)}`;
    case "error": return `Error ${safeLiveText(body.code)}${body.terminal ? " (terminal)" : ""}: ${safeLiveText(body.message)}`;
    case "protocol_incompatible": return `Protocol notice: unsupported ${safeLiveText(body.method)}.`;
    case "subagent_activity": return `Subagent ${safeLiveText(body.nickname ?? body.role ?? body.agentId)}: ${safeLiveText(body.kind)}.`;
    case "session_state": return `Session state: ${safeLiveText(body.state)}${body.attention ? " (needs attention)" : ""}.`;
    case "user_message": return `${liveMessageActor(body.actor)}: ${safeLiveText(body.text.slice(0, 200))}${
      body.text.length > 200 || body.omittedCharacters > 0 ? " ..." : ""}`;
    case "provider_switched": return `Provider switched: ${safeLiveText(body.fromProvider)} to ${
      safeLiveText(body.toProvider)} (${safeLiveText(body.toPreset)}).`;
  }
};

const waitFor = async (milliseconds: number, signal: AbortSignal): Promise<void> => {
  if (milliseconds <= 0 || signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
};

const raceWithAbort = async <T>(promise: Promise<T>, signal: AbortSignal): Promise<RaceResult<T>> => {
  if (signal.aborted) return { kind: "aborted" };
  return await new Promise<RaceResult<T>>((resolve) => {
    let settled = false;
    const finish = (result: RaceResult<T>): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => finish({ kind: "aborted" });
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => finish({ kind: "value", value }),
      (error: unknown) => finish({ error, kind: "error" }),
    );
  });
};

export const enumerateUnsettledSessionInteractions = async (input: Readonly<{
  callDaemon: ShellLiveDaemonCaller;
  cursor?: string | null;
  expectedSessionId?: string;
  initialInteractions?: readonly PendingInteraction[];
  onInteractions(interactions: readonly PendingInteraction[]): void;
  session: string;
  signal: AbortSignal;
}>): Promise<Readonly<{ sessionId: string }>> => {
  let cursor = input.cursor;
  let sessionId = input.expectedSessionId ?? null;
  const initial = input.initialInteractions ?? [];
  const seen = new Set<string>();
  const seenCursors = new Set<string>(typeof cursor === "string" ? [cursor] : []);
  let pageCount = 0;
  let itemCount = 0;
  const fail = (): never => {
    throw new Error("Oompa could not safely enumerate every pending interaction.");
  };
  for (const interaction of initial) {
    if (sessionId === null) sessionId = interaction.sessionId;
    if (interaction.sessionId !== sessionId) fail();
    if (seen.has(interaction.id)) fail();
    seen.add(interaction.id);
  }
  itemCount = initial.length;
  if (initial.length > 0) input.onInteractions(initial);
  if (cursor === null) {
    if (sessionId === null) return fail();
    return { sessionId };
  }
  while (!input.signal.aborted) {
    if (pageCount >= liveInteractionPageCeiling || itemCount >= liveInteractionItemCeiling) fail();
    const command: Extract<LocalCommand, { kind: "session.interactions" }> = {
      kind: "session.interactions",
      session: sessionId ?? input.session,
      pending: true,
      limit: liveInteractionPageLimit,
      ...(cursor === undefined ? {} : { cursor }),
    };
    const raced = await raceWithAbort(
      Promise.resolve().then(async () => await input.callDaemon(command, input.signal)),
      input.signal,
    );
    if (raced.kind === "aborted") {
      throw input.signal.reason ?? new DOMException("Session interaction observation stopped.", "AbortError");
    }
    if (raced.kind === "error") throw raced.error;
    if (!raced.value.ok) {
      throw Object.assign(new Error("Oompa could not enumerate current pending interactions."), {
        commandError: raced.value.error,
      });
    }
    const parsed = shellLiveInteractionPageSchema.safeParse(raced.value.data);
    if (!parsed.success) return fail();
    const data = parsed.data;
    if (sessionId === null) sessionId = data.sessionId;
    if (
      data.sessionId !== sessionId
      || data.interactions.some((interaction) => interaction.sessionId !== data.sessionId)
      || (data.nextCursor !== null && seenCursors.has(data.nextCursor))
      || (data.interactions.length === 0 && data.nextCursor !== null)
    ) return fail();
    for (const interaction of data.interactions) {
      if (seen.has(interaction.id)) fail();
      seen.add(interaction.id);
    }
    itemCount += data.interactions.length;
    if (itemCount > liveInteractionItemCeiling) fail();
    if (data.interactions.length > 0) input.onInteractions(data.interactions);
    pageCount += 1;
    cursor = data.nextCursor;
    if (cursor === null) return { sessionId };
    seenCursors.add(cursor);
  }
  throw input.signal.reason ?? new DOMException("Session interaction observation stopped.", "AbortError");
};

export class ShellLivePresenter {
  readonly #write: (value: string) => void;
  readonly #coalesceMs: number;
  readonly #commandStyle: LiveCommandStyle;
  readonly #deltaStreams = new Map<string, ActiveDeltaStream>();
  readonly #trustedDeltaItems = new Map<string, Readonly<{ itemId: string; turnId: string }>>();
  #deltaRedactionQuarantined = false;
  #unknownDeltaNoticeWritten = false;
  #pendingDelta: PendingDelta | null = null;
  #flushTimer: ReturnType<typeof setTimeout> | null = null;
  #lastRenderedEventIdentity: string | null = null;
  readonly #seenInteractionRevisions = new Map<string, number>();

  constructor(
    write: (value: string) => void,
    coalesceMs: number,
    commandStyle: LiveCommandStyle = "shell",
  ) {
    this.#write = write;
    this.#coalesceMs = coalesceMs;
    this.#commandStyle = commandStyle;
  }

  showInitialInteractions(interactions: readonly PendingInteraction[]): void {
    for (const interaction of interactions) this.#showInteraction(interaction);
  }

  acceptPage(page: SessionEventPage): void {
    if (page.gap !== null) {
      this.#discardDeltaStreams(
        "Live delta tail omitted at the event gap because its redaction boundary was incomplete.",
      );
      this.#trustedDeltaItems.clear();
      this.#deltaRedactionQuarantined = false;
      this.#unknownDeltaNoticeWritten = false;
      this.#emit(`Live event gap: ${safeLiveText(page.gap.reason)}. Updates resume at the retained boundary.`);
    }
    for (const event of page.events) this.#acceptEvent(event);
  }

  close(): void {
    this.#discardDeltaStreams(
      "Trailing live delta text omitted because observation ended before its redaction boundary completed.",
    );
    this.#trustedDeltaItems.clear();
  }

  flush(): void {
    this.#flushDelta();
  }

  #acceptEvent(event: SessionEvent): void {
    const body = event.body;
    if (body.type === "item_started") {
      this.#observeItemStart(body.turnId, body.itemId);
    }
    if (body.type === "assistant_delta" || body.type === "reasoning_summary_delta") {
      if (this.#deltaRedactionQuarantined) return;
      if (!this.#trustedDeltaItems.has(deltaItemKey(body.turnId, body.itemId))) {
        if (!this.#unknownDeltaNoticeWritten) {
          this.#unknownDeltaNoticeWritten = true;
          this.#emit(
            "Live delta text omitted until Oompa observes a trustworthy item-start boundary.",
          );
        }
        return;
      }
      const kind = body.type === "assistant_delta" ? "assistant" : "reasoning";
      const summaryPart = body.type === "reasoning_summary_delta"
        ? body.summaryPart ?? null
        : null;
      const key = JSON.stringify([body.turnId, body.itemId, kind, summaryPart]);
      let stream = this.#deltaStreams.get(key);
      if (stream === undefined) {
        if (this.#deltaStreams.size >= liveRedactorStreamLimit) {
          this.#quarantineDeltaRedaction();
          return;
        }
        stream = {
          itemId: body.itemId,
          kind,
          redactor: new StreamingSensitiveRedactor(),
          summaryPart,
          turnId: body.turnId,
        };
        this.#deltaStreams.set(key, stream);
      }
      const sanitized = sanitizeNonSecretLiveText(stream.redactor.push(body.text), true);
      this.#appendDelta(stream, sanitized);
      return;
    }

    if (body.type === "gap") {
      this.#discardDeltaStreams(
        "Live delta tail omitted at the event gap because its redaction boundary was incomplete.",
      );
      this.#trustedDeltaItems.clear();
      this.#deltaRedactionQuarantined = false;
      this.#unknownDeltaNoticeWritten = false;
    } else if (body.type === "item_completed") {
      this.#finalizeDeltaStreams((stream) =>
        stream.itemId === body.itemId && stream.turnId === body.turnId);
      this.#trustedDeltaItems.delete(deltaItemKey(body.turnId, body.itemId));
    } else if (body.type === "turn_completed") {
      this.#finalizeDeltaStreams((stream) => stream.turnId === body.turnId);
      for (const [key, item] of this.#trustedDeltaItems) {
        if (item.turnId === body.turnId) this.#trustedDeltaItems.delete(key);
      }
    } else {
      this.#flushDelta();
    }
    if (body.type === "interaction_requested") {
      this.#showInteraction(interactionFromEvent(event.sessionId, body));
      return;
    }
    if (body.type === "interaction_state") {
      if (!this.#observeInteractionRevision(body.interactionId, body.revision)) return;
    }
    const rendered = renderNonDeltaEvent(event);
    if (rendered === null) return;
    const identity = `${event.streamEpoch}:${String(event.sequence)}`;
    if (identity === this.#lastRenderedEventIdentity) return;
    this.#lastRenderedEventIdentity = identity;
    this.#emit(rendered);
  }

  #showInteraction(interaction: PendingInteraction): void {
    if (!this.#observeInteractionRevision(interaction.id, interaction.revision)) return;
    this.#emit(renderPendingInteraction(interaction, this.#commandStyle));
  }

  #observeInteractionRevision(id: string, revision: number): boolean {
    const observed = this.#seenInteractionRevisions.get(id);
    if (observed !== undefined && revision <= observed) return false;
    if (
      observed === undefined
      && this.#seenInteractionRevisions.size >= liveInteractionItemCeiling
    ) this.#seenInteractionRevisions.clear();
    this.#seenInteractionRevisions.set(id, revision);
    return true;
  }

  #scheduleDeltaFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flushDelta();
    }, this.#coalesceMs);
    this.#flushTimer.unref();
  }

  #appendDelta(stream: ActiveDeltaStream, value: string): void {
    if (value.length === 0) return;
    const pending = this.#pendingDelta;
    if (pending !== null) {
      if (
        pending.kind !== stream.kind
        || pending.itemId !== stream.itemId
        || pending.summaryPart !== stream.summaryPart
        || pending.turnId !== stream.turnId
      ) {
        this.#flushDelta();
        this.#appendDelta(stream, value);
        return;
      }
      if (!pending.truncated) {
        const combined = boundedCharacters(pending.text + value, liveDeltaMaximumCharacters);
        this.#pendingDelta = { ...pending, ...combined };
      }
    } else {
      const bounded = boundedCharacters(value, liveDeltaMaximumCharacters);
      this.#pendingDelta = {
        itemId: stream.itemId,
        kind: stream.kind,
        summaryPart: stream.summaryPart,
        ...bounded,
        turnId: stream.turnId,
      };
    }
    this.#scheduleDeltaFlush();
  }

  #finalizeDeltaStreams(predicate: (stream: ActiveDeltaStream) => boolean): void {
    for (const [key, stream] of this.#deltaStreams) {
      if (!predicate(stream)) continue;
      this.#deltaStreams.delete(key);
      const tail = sanitizeNonSecretLiveText(stream.redactor.push("", true), true);
      if (tail.trim().length > 0) this.#appendDelta(stream, tail);
    }
    this.#flushDelta();
  }

  #quarantineDeltaRedaction(): void {
    this.#flushDelta();
    this.#deltaStreams.clear();
    this.#trustedDeltaItems.clear();
    this.#deltaRedactionQuarantined = true;
    this.#emit(
      "Live delta text paused because the bounded redaction state was exhausted. Oompa will resume after a new item-start boundary or session reselection.",
    );
  }

  #observeItemStart(turnId: string, itemId: string): void {
    let discardedPriorState = false;
    for (const [key, stream] of this.#deltaStreams) {
      if (stream.turnId !== turnId || stream.itemId !== itemId) continue;
      this.#deltaStreams.delete(key);
      discardedPriorState = true;
    }
    if (discardedPriorState) {
      this.#flushDelta();
      this.#emit(
        "Live delta tail omitted because the provider repeated an item-start boundary.",
      );
    }
    if (this.#trustedDeltaItems.size >= liveTrustedItemLimit) this.#quarantineDeltaRedaction();
    this.#deltaRedactionQuarantined = false;
    this.#trustedDeltaItems.set(deltaItemKey(turnId, itemId), { itemId, turnId });
  }

  #discardDeltaStreams(notice: string): void {
    this.#flushDelta();
    if (this.#deltaStreams.size > 0) this.#emit(notice);
    this.#deltaStreams.clear();
  }

  #flushDelta(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const pending = this.#pendingDelta;
    this.#pendingDelta = null;
    if (pending === null) return;
    const label = pending.kind === "assistant" ? "Codex" : "Reasoning summary";
    this.#emit(`${label}\n${indentedLiveText(pending.text)}${pending.truncated ? "\n  [additional delta text omitted]" : ""}`);
  }

  #emit(value: string): void {
    this.#write(`\n${value}\n`);
  }
}

export class ShellLiveObserver {
  readonly #callDaemon: ShellLiveDaemonCaller;
  readonly #write: (value: string) => void;
  readonly #coalesceMs: number;
  readonly #emptyPageDelayMs: number;
  readonly #retryLimit: number;
  readonly #startDelayMs: number;
  readonly #waitMs: number;
  #controller: AbortController | null = null;
  #task: Promise<void> | null = null;

  constructor(input: ShellLiveObserverInput) {
    this.#callDaemon = input.callDaemon;
    this.#write = input.write;
    this.#coalesceMs = input.coalesceMs ?? liveCoalesceMs;
    this.#emptyPageDelayMs = input.emptyPageDelayMs ?? liveEmptyPageDelayMs;
    this.#retryLimit = input.retryLimit ?? liveRetryLimit;
    this.#startDelayMs = input.startDelayMs ?? 0;
    this.#waitMs = input.waitMs ?? liveWaitMs;
  }

  async select(selection: ShellLiveSelection): Promise<void> {
    await this.stop();
    const current = sessionStatusSchema.safeParse(selection.statusData);
    const legacy = legacyShellLiveStatusSchema.safeParse(selection.statusData);
    const sessionId = current.success
      ? current.data.session.id
      : legacy.success
        ? legacy.data.session.id
        : null;
    if (sessionId !== selection.session) {
      this.#safeWrite("\nLive updates unavailable: session status did not include a matching resumable event cursor.\n");
      return;
    }
    const controller = new AbortController();
    let displayFailed = false;
    const write = (value: string): void => {
      if (displayFailed) return;
      if (!this.#safeWrite(value)) {
        displayFailed = true;
        controller.abort(new Error("Shell live display is unavailable."));
      }
    };
    const presenter = new ShellLivePresenter(write, this.#coalesceMs);
    const pendingInteractions = current.success
      ? []
      : legacy.success ? legacy.data.pendingInteractions : [];
    const interactionCursor = current.success
      ? undefined
      : legacy.success ? legacy.data.pendingInteractionsNextCursor : null;
    const eventCursor = current.success
      ? current.data.eventStream.cursor
      : legacy.success ? legacy.data.eventStream.cursor : null;
    if (eventCursor === null) {
      this.#safeWrite("\nLive updates unavailable: session status did not include a matching resumable event cursor.\n");
      return;
    }
    this.#controller = controller;
    this.#task = this.#observe({
      controller,
      cursor: eventCursor,
      initialInteractions: pendingInteractions,
      interactionCursor,
      presenter,
      session: sessionId,
      ...(selection.suppressedInitialInteractionKeys === undefined
        ? {}
        : {
            suppressedInitialInteractionKeys:
              selection.suppressedInitialInteractionKeys,
          }),
    }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    const controller = this.#controller;
    const task = this.#task;
    this.#controller = null;
    this.#task = null;
    controller?.abort(new Error("Shell live observation stopped."));
    if (task !== null) {
      try {
        await task;
      } catch {
        // Live display is advisory and must never poison the foreground shell.
      }
    }
  }

  #safeWrite(value: string): boolean {
    try {
      this.#write(value);
      return true;
    } catch {
      return false;
    }
  }

  async #observe(input: Readonly<{
    controller: AbortController;
    cursor: string;
    initialInteractions: readonly PendingInteraction[];
    interactionCursor: string | null | undefined;
    presenter: ShellLivePresenter;
    session: string;
    suppressedInitialInteractionKeys?: ReadonlySet<string>;
  }>): Promise<void> {
    const signal = input.controller.signal;
    let cursor = input.cursor;
    let consecutiveFailures = 0;
    let failureNoticeWritten = false;
    let continuity = initialSessionEventContinuity();
    try {
      await waitFor(this.#startDelayMs, signal);
      try {
        await enumerateUnsettledSessionInteractions({
          callDaemon: this.#callDaemon,
          ...(input.interactionCursor === undefined ? {} : { cursor: input.interactionCursor }),
          expectedSessionId: input.session,
          initialInteractions: input.initialInteractions,
          onInteractions: (interactions) => input.presenter.showInitialInteractions(
            input.suppressedInitialInteractionKeys === undefined
              ? interactions
              : interactions.filter((interaction) =>
                  !input.suppressedInitialInteractionKeys?.has(
                    pendingInteractionStateKey(interaction),
                  )),
          ),
          session: input.session,
          signal,
        });
      } catch {
        if (!signal.aborted) {
          this.#write(
            "\nLive updates paused because Oompa could not safely enumerate every pending interaction. Reselect the session to resume.\n",
          );
        }
        return;
      }
      while (!signal.aborted) {
        const command: Extract<LocalCommand, { kind: "session.events" }> = {
          kind: "session.events",
          session: input.session,
          cursor,
          limit: livePageLimit,
          waitMs: this.#waitMs,
        };
        const raced = await raceWithAbort(
          Promise.resolve().then(async () => await this.#callDaemon(command, signal)),
          signal,
        );
        if (raced.kind === "aborted") break;
        if (raced.kind === "error" || !raced.value.ok) {
          consecutiveFailures += 1;
          if (!failureNoticeWritten) {
            this.#write("\nLive updates are temporarily unavailable; Oompa is retrying in the background.\n");
            failureNoticeWritten = true;
          }
          if (consecutiveFailures >= this.#retryLimit) {
            this.#write("\nLive updates paused after repeated failures. Reselect the session to resume.\n");
            break;
          }
          await waitFor(Math.min(1_000, 25 * (2 ** (consecutiveFailures - 1))), signal);
          continue;
        }

        let page: SessionEventPage;
        try {
          page = sessionEventPageSchema.parse(raced.value.data);
          if (page.sessionId !== input.session) throw new Error("session changed");
          if (page.requestedCursor !== cursor) throw new Error("cursor mismatch");
          if ((page.events.length > 0 || page.gap !== null) && page.nextCursor === cursor) {
            throw new Error("cursor did not advance");
          }
          continuity = advanceSessionEventContinuity(continuity, page);
        } catch {
          this.#write("\nLive updates paused because the daemon returned an invalid event page. Reselect the session to resume.\n");
          break;
        }

        consecutiveFailures = 0;
        failureNoticeWritten = false;
        input.presenter.acceptPage(page);
        const advanced = page.nextCursor !== cursor;
        cursor = page.nextCursor;
        if (!advanced && page.events.length === 0 && page.gap === null) {
          await waitFor(this.#emptyPageDelayMs, signal);
        }
      }
    } finally {
      input.presenter.close();
    }
  }

}
