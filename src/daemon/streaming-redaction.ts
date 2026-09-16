import { redactAbsolutePaths } from "../domain/text-safety";
import {
  CODEX_DESKTOP_HEARTBEAT_ENVELOPE_PREFIX,
  isExactCodexDesktopHeartbeatEnvelope,
  replaceCodexDesktopHeartbeatEnvelope,
} from "../domain/codex-heartbeat-envelope";
import type { InteractionDisplay } from "../domain/interactions";
import type { ProviderAccountAuthority } from "../domain/provider-accounts";
import type { SessionEvent, SessionEventBody } from "../domain/session-events";
import {
  createEphemeralPublicProviderIdentifierProjector,
  PUBLIC_MCP_FORM_SUMMARY,
  type PublicProviderIdentifierProjector,
} from "../public-provider-identifier";
import { redactCompleteSensitiveText } from "../sensitive-text";
import { StreamingSensitiveRedactor } from "../streaming-sensitive-text";

type DeltaBody = Extract<
  SessionEventBody,
  { type: "assistant_delta" | "reasoning_summary_delta" }
>;

export type SessionEventWrite = Readonly<
  Pick<
    SessionEvent,
    | "accountId"
    | "providerConnectionId"
    | "providerGeneration"
    | "sessionId"
  > & {
    body: SessionEventBody;
    providerAuthority: ProviderAccountAuthority;
  }
>;

type StagedNode = {
  rawText: string;
  readyBody: SessionEventBody | null | undefined;
  write: SessionEventWrite;
};

type ActiveStream = {
  context: Omit<SessionEventWrite, "body">;
  heartbeatEnvelopeState: "candidate" | "prefix" | "rejected";
  pending: StagedNode[];
  proven: string;
  redactor: StreamingSensitiveRedactor;
  template: DeltaBody;
};

type ActiveItem = Readonly<{
  accountId: SessionEventWrite["accountId"];
  itemId: string;
  providerAuthority: ProviderAccountAuthority;
  providerConnectionId: SessionEventWrite["providerConnectionId"];
  providerGeneration: number;
  sessionId: SessionEventWrite["sessionId"];
  turnId: string;
}>;

const publicControlScalar = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const providerToolLabelMaximumUtf8Bytes = 256;
const textEncoder = new TextEncoder();

/**
 * Reduce provider prose before it can cross a public or durable boundary.
 * The replacement is explicit so callers never confuse an omission with an
 * empty provider value.
 */
export const sanitizeProviderProse = (
  value: string,
  preserveLineFeeds = true,
): string => {
  const redacted = redactCompleteSensitiveText(
    redactAbsolutePaths(value),
    "[protected]",
  );
  let output = "";
  for (const scalar of redacted) {
    output += scalar === "\n" && preserveLineFeeds
      ? scalar
      : publicControlScalar.test(scalar)
        ? "�"
        : scalar;
  }
  return output;
};

/** The projected subagent nickname and role bound in `session-events.ts`. */
const subagentLabelMaximumCharacters = 120;

const sanitizeSubagentLabel = (value: string): string =>
  sanitizeProviderProse(value, false).slice(0, subagentLabelMaximumCharacters);

/** The bounded one-line tool summary declared in `session-events.ts`. */
const toolSummaryMaximumCharacters = 256;

const sanitizeToolSummary = (value: string): string =>
  sanitizeProviderProse(value, false).slice(0, toolSummaryMaximumCharacters);

const sanitizeProviderToolLabel = (value: string): string => {
  const sanitized = sanitizeProviderProse(value, false);
  let output = "";
  let bytes = 0;
  for (const scalar of sanitized) {
    const scalarBytes = textEncoder.encode(scalar).byteLength;
    if (bytes + scalarBytes > providerToolLabelMaximumUtf8Bytes) break;
    output += scalar;
    bytes += scalarBytes;
  }
  return output;
};

export const sanitizeInteractionDisplay = (
  display: InteractionDisplay,
): InteractionDisplay => {
  const safe = (value: string): string => sanitizeProviderProse(value, false);
  const nullable = (value: string | null): string | null =>
    value === null ? null : safe(value);
  const exact = (value: string, label: string): string => {
    if (safe(value) !== value) {
      throw new Error(`UNSAFE_EXACT_INTERACTION_DISPLAY:${label}`);
    }
    return value;
  };
  const unique = (values: readonly string[], label: string): void => {
    if (new Set(values).size !== values.length) {
      throw new Error(`NON_UNIQUE_EXACT_INTERACTION_DISPLAY:${label}`);
    }
  };
  switch (display.kind) {
    case "command_approval": return {
      ...display,
      summary: safe(display.summary),
      reason: nullable(display.reason),
      commandClass: safe(display.commandClass),
      workingDirectory: nullable(display.workingDirectory),
    };
    case "file_change_approval": return {
      ...display,
      summary: safe(display.summary),
      reason: nullable(display.reason),
      grantRoot: nullable(display.grantRoot),
    };
    case "permission_approval": {
      const requested = display.requested.map((permission) => ({
        name: exact(permission.name, "permission_name"),
      }));
      unique(requested.map((permission) => permission.name), "permission_names");
      return {
        ...display,
        summary: safe(display.summary),
        reason: nullable(display.reason),
        requested,
      };
    }
    case "user_input": {
      const questions = display.questions.map((question) => {
        const options = question.options?.map((option) => ({
          label: exact(option.label, "question_option_label"),
          description: safe(option.description),
        })) ?? null;
        if (options !== null) {
          unique(options.map((option) => option.label), "question_option_labels");
        }
        return {
          ...question,
          id: exact(question.id, "question_id"),
          header: safe(question.header),
          question: safe(question.question),
          options,
        };
      });
      unique(questions.map((question) => question.id), "question_ids");
      return {
        ...display,
        summary: safe(display.summary),
        questions,
      };
    }
    case "mcp_elicitation": {
      const fields = display.fields?.map((field) => {
        const name = exact(field.name, "mcp_field_name");
        if (field.type !== "single_select" && field.type !== "multi_select") {
          return { ...field, name };
        }
        const choices = field.choices.map((choice) =>
          exact(choice, "mcp_choice"));
        unique(choices, "mcp_choices");
        return { ...field, name, choices };
      });
      if (fields !== undefined) {
        unique(fields.map((field) => field.name), "mcp_field_names");
      }
      return {
        ...display,
        summary: PUBLIC_MCP_FORM_SUMMARY,
        serverName: safe(display.serverName),
        ...(fields === undefined ? {} : { fields }),
      };
    }
  }
};

const sanitizeCompleteBody = (
  body: SessionEventBody,
  projectPublicProviderIdentifier: PublicProviderIdentifierProjector,
  protectCodexDesktopHeartbeatEnvelope: boolean,
): SessionEventBody => {
  const protect = (value: string): string => protectCodexDesktopHeartbeatEnvelope
    ? replaceCodexDesktopHeartbeatEnvelope(value)
    : value;
  const safe = (value: string): string => sanitizeProviderProse(protect(value));
  const safeInline = (value: string): string => sanitizeProviderProse(protect(value), false);
  const publicId = (value: string): string => projectPublicProviderIdentifier(value);
  switch (body.type) {
    case "plan_updated": return {
      ...body,
      turnId: publicId(body.turnId),
      steps: body.steps.map((step) => ({ ...step, text: safe(step.text) })),
      ...(body.explanation === undefined
        ? {}
        : { explanation: safe(body.explanation) }),
    };
    case "interaction_requested": return {
      ...body,
      summary: body.interactionKind === "mcp_elicitation"
        ? PUBLIC_MCP_FORM_SUMMARY
        : safe(body.summary),
    };
    case "warning": return {
      ...body,
      code: safeInline(body.code),
      message: safe(body.message),
    };
    case "error": return {
      ...body,
      code: safeInline(body.code),
      message: safe(body.message),
    };
    case "connection": return body.reason === undefined
      ? body
      : { ...body, reason: safe(body.reason) };
    case "item_started": return {
      ...body,
      turnId: publicId(body.turnId),
      itemId: publicId(body.itemId),
      itemKind: safeInline(body.itemKind),
      ...(body.server === undefined ? {} : { server: sanitizeProviderToolLabel(body.server) }),
      ...(body.tool === undefined ? {} : { tool: sanitizeProviderToolLabel(body.tool) }),
      ...(body.callId === undefined ? {} : { callId: publicId(body.callId) }),
      ...(body.summary === undefined ? {} : { summary: sanitizeToolSummary(body.summary) }),
    };
    case "item_completed": return {
      ...body,
      turnId: publicId(body.turnId),
      itemId: publicId(body.itemId),
      itemKind: safeInline(body.itemKind),
      ...(body.status === undefined ? {} : { status: safeInline(body.status) }),
      ...(body.server === undefined ? {} : { server: sanitizeProviderToolLabel(body.server) }),
      ...(body.tool === undefined ? {} : { tool: sanitizeProviderToolLabel(body.tool) }),
      ...(body.callId === undefined ? {} : { callId: publicId(body.callId) }),
      ...(body.summary === undefined ? {} : { summary: sanitizeToolSummary(body.summary) }),
    };
    case "user_message": return {
      ...body,
      turnId: body.turnId === null ? null : publicId(body.turnId),
      text: safe(body.text),
      ...(body.attachments === undefined
        ? {}
        : {
            attachments: body.attachments.map((attachment) => ({
              ...attachment,
              name: safeInline(attachment.name),
            })),
          }),
    };
    case "provider_switched": return body;
    case "tool_progress": return {
      ...body,
      turnId: publicId(body.turnId),
      itemId: publicId(body.itemId),
      toolKind: safeInline(body.toolKind),
      ...(body.status === undefined ? {} : { status: safeInline(body.status) }),
      ...(body.server === undefined ? {} : { server: sanitizeProviderToolLabel(body.server) }),
      ...(body.tool === undefined ? {} : { tool: sanitizeProviderToolLabel(body.tool) }),
    };
    case "file_change": return {
      ...body,
      turnId: publicId(body.turnId),
      itemId: publicId(body.itemId),
      status: safeInline(body.status),
      paths: body.paths.map((path) => ({
        ...path,
        path: safeInline(path.path),
      })),
    };
    case "protocol_incompatible": return {
      ...body,
      method: safeInline(body.method),
    };
    case "turn_completed": return {
      ...body,
      turnId: publicId(body.turnId),
      ...(body.errorCode === undefined
        ? {}
        : { errorCode: safeInline(body.errorCode) }),
    };
    case "assistant_delta":
    case "reasoning_summary_delta":
      throw new Error("STREAMING_SESSION_DELTA_REQUIRES_CUSTODY");
    case "diff_updated": return {
      ...body,
      turnId: publicId(body.turnId),
    };
    case "session_status": return {
      ...body,
      activeTurnId: body.activeTurnId === null ? null : publicId(body.activeTurnId),
    };
    case "token_usage": return {
      ...body,
      turnId: body.turnId === null ? null : publicId(body.turnId),
    };
    case "compaction": return {
      ...body,
      turnId: body.turnId === null ? null : publicId(body.turnId),
      ...(body.strategy === undefined
        ? {}
        : { strategy: safeInline(body.strategy) }),
    };
    case "turn_started": return {
      ...body,
      turnId: publicId(body.turnId),
    };
    case "gap":
    case "interaction_state":
      return body;
    case "subagent_activity": return {
      ...body,
      turnId: publicId(body.turnId),
      agentId: publicId(body.agentId),
      ...(body.nickname === undefined
        ? {}
        : { nickname: sanitizeSubagentLabel(body.nickname) }),
      ...(body.role === undefined
        ? {}
        : { role: sanitizeSubagentLabel(body.role) }),
    };
    case "session_state": return {
      ...body,
      reason: safe(body.reason),
    };
  }
};

const streamKey = (write: SessionEventWrite): string => {
  if (
    write.body.type !== "assistant_delta"
    && write.body.type !== "reasoning_summary_delta"
  ) throw new Error("SESSION_EVENT_STREAM_KEY_REQUIRES_DELTA");
  return JSON.stringify([
    write.accountId,
    write.providerAuthority.provider,
    write.providerAuthority.providerAccountId,
    write.providerAuthority.bindingGeneration,
    write.providerAuthority.processGeneration,
    write.providerGeneration,
    write.providerConnectionId,
    write.sessionId,
    write.body.turnId,
    write.body.itemId,
    write.body.type,
    write.body.type === "reasoning_summary_delta"
      ? write.body.summaryPart ?? null
      : null,
  ]);
};

const itemKey = (
  write: Omit<SessionEventWrite, "body">,
  turnId: string,
  itemId: string,
): string => JSON.stringify([
  write.accountId,
  write.providerAuthority.provider,
  write.providerAuthority.providerAccountId,
  write.providerAuthority.bindingGeneration,
  write.providerAuthority.processGeneration,
  write.providerGeneration,
  write.providerConnectionId,
  write.sessionId,
  turnId,
  itemId,
]);

const bodyFrom = (
  template: DeltaBody,
  text: string,
  projectPublicProviderIdentifier: PublicProviderIdentifierProjector,
): DeltaBody => ({
  ...template,
  turnId: projectPublicProviderIdentifier(template.turnId),
  itemId: projectPublicProviderIdentifier(template.itemId),
  text: sanitizeProviderProse(text),
});

const sameProviderAuthority = (
  left: ProviderAccountAuthority,
  right: ProviderAccountAuthority,
): boolean => left.profileId === right.profileId
  && left.provider === right.provider
  && left.providerAccountId === right.providerAccountId
  && left.bindingGeneration === right.bindingGeneration
  && left.processGeneration === right.processGeneration;

const sameProviderCustody = (
  left: Omit<SessionEventWrite, "body">,
  right: ActiveStream,
): boolean => left.accountId === right.context.accountId
  && left.sessionId === right.context.sessionId
  && sameProviderAuthority(
    left.providerAuthority,
    right.context.providerAuthority,
  )
  && left.providerGeneration === right.context.providerGeneration;

const sameAuthority = (left: SessionEventWrite, right: ActiveStream): boolean =>
  sameProviderCustody(left, right)
  && (
    left.providerConnectionId === null
    || left.providerConnectionId === right.context.providerConnectionId
  );

/**
 * Holds the bounded look-behind required to classify secrets split across
 * provider deltas. Nothing leaves this class until the shared stream reducer
 * has proved it safe or replaced it with an explicit marker.
 */
export class SessionEventStreamRedactor {
  readonly #streams = new Map<string, ActiveStream>();
  readonly #queues = new Map<string, StagedNode[]>();
  readonly #activeItems = new Map<string, ActiveItem>();
  readonly #quarantinedAuthorities = new Set<string>();
  readonly #maximumActiveStreams: number;
  readonly #maximumActiveStreamsPerSession: number;
  readonly #maximumStagedCodeUnits: number;
  readonly #maximumStagedNodes: number;
  readonly #isCodexSession: (write: SessionEventWrite) => boolean;
  readonly #projectPublicProviderIdentifier: PublicProviderIdentifierProjector;
  #stagedCodeUnits = 0;
  #stagedNodes = 0;

  constructor(input: Readonly<{
    maximumActiveStreams?: number;
    maximumActiveStreamsPerSession?: number;
    maximumStagedCodeUnits?: number;
    maximumStagedNodes?: number;
    isCodexSession?: (write: SessionEventWrite) => boolean;
    projectPublicProviderIdentifier?: PublicProviderIdentifierProjector;
  }> = {}) {
    const positive = (value: number | undefined, fallback: number): number => {
      const selected = value ?? fallback;
      if (!Number.isSafeInteger(selected) || selected < 1) {
        throw new Error("SESSION_EVENT_REDACTION_LIMIT_INVALID");
      }
      return selected;
    };
    this.#maximumActiveStreams = positive(input.maximumActiveStreams, 256);
    this.#maximumActiveStreamsPerSession = positive(
      input.maximumActiveStreamsPerSession,
      32,
    );
    this.#maximumStagedCodeUnits = positive(
      input.maximumStagedCodeUnits,
      2 * 1024 * 1024,
    );
    this.#maximumStagedNodes = positive(input.maximumStagedNodes, 4_096);
    this.#isCodexSession = input.isCodexSession ?? (() => false);
    this.#projectPublicProviderIdentifier = input.projectPublicProviderIdentifier
      ?? createEphemeralPublicProviderIdentifierProjector();
    if (this.#maximumActiveStreamsPerSession > this.#maximumActiveStreams) {
      throw new Error("SESSION_EVENT_REDACTION_SESSION_LIMIT_EXCEEDS_GLOBAL_LIMIT");
    }
  }

  accept(write: SessionEventWrite): readonly SessionEventWrite[] {
    this.#assertWriteAuthority(write);
    const custodyKey = this.#custodyKey(write);
    const body = write.body;
    if (body.type === "assistant_delta" || body.type === "reasoning_summary_delta") {
      if (body.text.length === 0) return [];
      if (
        this.#quarantinedAuthorities.has(custodyKey)
        || !this.#activeItems.has(itemKey(write, body.turnId, body.itemId))
      ) {
        const released = this.#ensureCapacity(write, 0, false);
        this.#enqueue({
          rawText: "",
          readyBody: bodyFrom(
            body,
            "[protected]",
            this.#projectPublicProviderIdentifier,
          ),
          write,
        });
        return [...released, ...this.#drainAuthority(write)];
      }
      const key = streamKey(write);
      const isNewStream = !this.#streams.has(key);
      const released = this.#ensureCapacity(write, body.text.length, isNewStream);
      if (this.#quarantinedAuthorities.has(custodyKey)) {
        this.#enqueue({
          rawText: "",
          readyBody: bodyFrom(
            body,
            "[protected]",
            this.#projectPublicProviderIdentifier,
          ),
          write,
        });
        return [...released, ...this.#drainAuthority(write)];
      }
      let stream = this.#streams.get(key);
      if (stream === undefined) {
        const protectCodexDesktopHeartbeatEnvelope = this.#isCodexSession(write);
        stream = {
          context: {
            accountId: write.accountId,
            providerAuthority: write.providerAuthority,
            providerConnectionId: write.providerConnectionId,
            providerGeneration: write.providerGeneration,
            sessionId: write.sessionId,
          },
          heartbeatEnvelopeState: protectCodexDesktopHeartbeatEnvelope
            ? "prefix"
            : "rejected",
          pending: [],
          proven: "",
          redactor: new StreamingSensitiveRedactor(),
          template: body,
        };
        this.#streams.set(key, stream);
      }
      const node: StagedNode = { rawText: body.text, readyBody: undefined, write };
      stream.pending.push(node);
      this.#enqueue(node);
      this.#applyStreamInput(stream, body.text);
      return [...released, ...this.#drainAuthority(write)];
    }

    const released = this.#ensureCapacity(write, 0, false);
    this.#flushForBoundary(write);
    this.#enqueue({
      rawText: "",
      readyBody: sanitizeCompleteBody(
        body,
        this.#projectPublicProviderIdentifier,
        this.#isCodexSession(write),
      ),
      write,
    });
    return [...released, ...this.#drainAuthority(write)];
  }

  interruptAll(): readonly SessionEventWrite[] {
    this.#finish(() => true, true);
    this.#activeItems.clear();
    this.#quarantinedAuthorities.clear();
    return this.#drainAll();
  }

  interruptSession(write: Omit<SessionEventWrite, "body">): readonly SessionEventWrite[] {
    this.#assertWriteAuthority(write);
    this.#finish((stream) => sameProviderCustody(write, stream), true);
    this.#clearActiveItems((item) =>
      item.accountId === write.accountId
      && item.sessionId === write.sessionId
      && sameProviderAuthority(item.providerAuthority, write.providerAuthority)
      && item.providerGeneration === write.providerGeneration);
    this.#quarantinedAuthorities.delete(this.#custodyKey(write));
    return this.#drainAuthority(write);
  }

  /**
   * Finish buffered text before a locally-authored message is appended outside
   * this reducer. Unlike an interruption boundary, this preserves active-item
   * custody so later provider deltas for the same item remain admissible.
   */
  flushSession(write: Omit<SessionEventWrite, "body">): readonly SessionEventWrite[] {
    this.#assertWriteAuthority(write);
    this.#finish((stream) => sameProviderCustody(write, stream), false);
    return this.#drainAuthority(write);
  }

  get activeStreamCount(): number {
    return this.#streams.size;
  }

  #ensureCapacity(
    write: SessionEventWrite,
    additionalCodeUnits: number,
    isNewStream: boolean,
  ): readonly SessionEventWrite[] {
    const sessionStreams = isNewStream
      ? Array.from(this.#streams.values()).filter((stream) =>
          stream.context.sessionId === write.sessionId).length
      : 0;
    if (
      this.#stagedNodes + 1 > this.#maximumStagedNodes
      || this.#stagedCodeUnits + additionalCodeUnits > this.#maximumStagedCodeUnits
      || (isNewStream && this.#streams.size + 1 > this.#maximumActiveStreams)
      || (
        isNewStream
        && sessionStreams + 1 > this.#maximumActiveStreamsPerSession
      )
    ) {
      this.#quarantineSession(write);
      return this.#drainAuthority(write);
    }
    return [];
  }

  #enqueue(node: StagedNode): void {
    const key = this.#custodyKey(node.write);
    const queue = this.#queues.get(key) ?? [];
    if (!this.#queues.has(key)) {
      this.#queues.set(key, queue);
    }
    queue.push(node);
    this.#stagedNodes += 1;
    this.#stagedCodeUnits += node.rawText.length;
  }

  #flushForBoundary(write: SessionEventWrite): void {
    const body = write.body;
    if (body.type === "item_completed") {
      this.#finish((stream) =>
        sameAuthority(write, stream)
        && stream.template.turnId === body.turnId
        && stream.template.itemId === body.itemId, false);
      this.#clearActiveItems((item) =>
        item.accountId === write.accountId
        && item.sessionId === write.sessionId
        && sameProviderAuthority(item.providerAuthority, write.providerAuthority)
        && item.providerGeneration === write.providerGeneration
        && (
          write.providerConnectionId === null
          || item.providerConnectionId === write.providerConnectionId
        )
        && item.turnId === body.turnId
        && item.itemId === body.itemId);
      this.#quarantinedAuthorities.delete(this.#custodyKey(write));
      return;
    }
    if (body.type === "turn_completed") {
      this.#finish((stream) =>
        sameAuthority(write, stream)
        && stream.template.turnId === body.turnId, false);
      this.#clearActiveItems((item) =>
        item.accountId === write.accountId
        && item.sessionId === write.sessionId
        && sameProviderAuthority(item.providerAuthority, write.providerAuthority)
        && item.providerGeneration === write.providerGeneration
        && (
          write.providerConnectionId === null
          || item.providerConnectionId === write.providerConnectionId
        )
        && item.turnId === body.turnId);
      this.#quarantinedAuthorities.delete(this.#custodyKey(write));
      return;
    }
    if (body.type === "item_started") {
      this.#finish((stream) =>
        sameAuthority(write, stream)
        && stream.template.turnId === body.turnId
        && stream.template.itemId === body.itemId, true);
      this.#clearActiveItems((item) =>
        item.accountId === write.accountId
        && item.sessionId === write.sessionId
        && sameProviderAuthority(item.providerAuthority, write.providerAuthority)
        && item.providerGeneration === write.providerGeneration
        && (
          write.providerConnectionId === null
          || item.providerConnectionId === write.providerConnectionId
        )
        && item.turnId === body.turnId
        && item.itemId === body.itemId);
      const sessionItems = Array.from(this.#activeItems.values()).filter((item) =>
        item.accountId === write.accountId
        && item.sessionId === write.sessionId
        && sameProviderAuthority(item.providerAuthority, write.providerAuthority)).length;
      if (
        this.#activeItems.size >= this.#maximumActiveStreams
        || sessionItems >= this.#maximumActiveStreamsPerSession
      ) {
        this.#quarantineSession(write);
        return;
      }
      this.#activeItems.set(itemKey(write, body.turnId, body.itemId), {
        accountId: write.accountId,
        providerAuthority: write.providerAuthority,
        providerConnectionId: write.providerConnectionId,
        providerGeneration: write.providerGeneration,
        sessionId: write.sessionId,
        turnId: body.turnId,
        itemId: body.itemId,
      });
      this.#quarantinedAuthorities.delete(this.#custodyKey(write));
      return;
    }
    if (body.type === "turn_started") {
      this.#finish((stream) => sameProviderCustody(write, stream), true);
      this.#clearActiveItems((item) =>
        item.accountId === write.accountId
        && item.sessionId === write.sessionId
        && sameProviderAuthority(item.providerAuthority, write.providerAuthority)
        && item.providerGeneration === write.providerGeneration);
      this.#quarantinedAuthorities.delete(this.#custodyKey(write));
      return;
    }
    if (
      body.type === "gap"
      || body.type === "connection"
      || (body.type === "session_status" && body.status !== "active")
    ) {
      this.#finish((stream) => sameProviderCustody(write, stream), true);
      this.#clearActiveItems((item) =>
        item.accountId === write.accountId
        && item.sessionId === write.sessionId
        && sameProviderAuthority(item.providerAuthority, write.providerAuthority)
        && item.providerGeneration === write.providerGeneration);
      this.#quarantinedAuthorities.delete(this.#custodyKey(write));
    }
  }

  #clearActiveItems(predicate: (item: ActiveItem) => boolean): void {
    for (const [key, item] of this.#activeItems) {
      if (predicate(item)) this.#activeItems.delete(key);
    }
  }

  #quarantineSession(write: SessionEventWrite): void {
    this.#quarantinedAuthorities.add(this.#custodyKey(write));
    this.#finish((stream) => sameProviderCustody(write, stream), true);
    this.#clearActiveItems((item) =>
      item.accountId === write.accountId
      && item.sessionId === write.sessionId
      && sameProviderAuthority(item.providerAuthority, write.providerAuthority)
      && item.providerGeneration === write.providerGeneration);
  }

  #finish(
    predicate: (stream: ActiveStream) => boolean,
    interrupted: boolean,
  ): void {
    for (const [key, stream] of this.#streams) {
      if (!predicate(stream)) continue;
      this.#streams.delete(key);
      if (interrupted) {
        this.#protectPending(stream);
        continue;
      }
      if (stream.heartbeatEnvelopeState === "rejected") {
        this.#applyProvenOutput(stream, stream.redactor.push("", true));
      } else {
        const raw = stream.pending.map((node) => node.rawText).join("");
        if (isExactCodexDesktopHeartbeatEnvelope(raw)) {
          this.#protectPending(stream);
          continue;
        }
        stream.heartbeatEnvelopeState = "rejected";
        this.#applyProvenOutput(stream, stream.redactor.push(raw, true));
      }
      if (stream.pending.length === 0) continue;
      const raw = stream.pending.map((node) => node.rawText).join("");
      if (stream.proven === raw) this.#releaseProvenNodes(stream);
      if (stream.pending.length > 0) this.#protectPending(stream);
    }
  }

  #applyStreamInput(stream: ActiveStream, value: string): void {
    if (stream.heartbeatEnvelopeState === "rejected") {
      this.#applyProvenOutput(stream, stream.redactor.push(value));
      return;
    }
    // Once the complete canonical prefix matches, only the item boundary can
    // prove or reject the exact whole-envelope grammar. Keep later chunks in
    // the existing bounded staging queue without repeatedly joining them.
    if (stream.heartbeatEnvelopeState === "candidate") return;
    const raw = stream.pending.map((node) => node.rawText).join("");
    if (raw.length < CODEX_DESKTOP_HEARTBEAT_ENVELOPE_PREFIX.length) {
      if (CODEX_DESKTOP_HEARTBEAT_ENVELOPE_PREFIX.startsWith(raw)) return;
    } else if (raw.startsWith(CODEX_DESKTOP_HEARTBEAT_ENVELOPE_PREFIX)) {
      stream.heartbeatEnvelopeState = "candidate";
      return;
    }
    stream.heartbeatEnvelopeState = "rejected";
    this.#applyProvenOutput(stream, stream.redactor.push(raw));
  }

  #applyProvenOutput(stream: ActiveStream, output: string): void {
    if (output.length === 0) return;
    const pendingRaw = stream.pending.map((node) => node.rawText).join("");
    const protectedIndex = output.indexOf("[protected]");
    const localPathIndex = output.indexOf("[local-path]");
    const markerIndexes = [protectedIndex, localPathIndex].filter((index) => index >= 0);
    const markerIndex = markerIndexes.length === 0 ? -1 : Math.min(...markerIndexes);
    if (markerIndex >= 0) {
      const safePrefix = stream.proven + output.slice(0, markerIndex);
      if (pendingRaw.startsWith(safePrefix)) {
        stream.proven = safePrefix;
        this.#releaseProvenNodes(stream, true);
      }
      this.#protectPending(stream);
      return;
    }
    const proven = stream.proven + output;
    if (!pendingRaw.startsWith(proven)) {
      if (
        stream.proven.length === 0
        && output.length > 0
        && output.length < pendingRaw.length
        && pendingRaw.endsWith(output)
        && this.#protectRawPrefix(stream, pendingRaw.length - output.length, output)
      ) return;
      this.#protectPending(stream);
      return;
    }
    stream.proven = proven;
    this.#releaseProvenNodes(stream, true);
  }

  #releaseProvenNodes(stream: ActiveStream, allowPartial = false): void {
    for (;;) {
      const node = stream.pending[0];
      if (node === undefined || stream.proven.length === 0) return;
      if (stream.proven.length < node.rawText.length) {
        if (
          allowPartial
          && node.rawText.startsWith(stream.proven)
          && this.#splitReadyPrefix(stream, node, stream.proven)
        ) stream.proven = "";
        return;
      }
      if (!stream.proven.startsWith(node.rawText)) {
        this.#protectPending(stream);
        return;
      }
      stream.pending.shift();
      stream.proven = stream.proven.slice(node.rawText.length);
      this.#markReady(node, bodyFrom(
        stream.template,
        node.rawText,
        this.#projectPublicProviderIdentifier,
      ));
    }
  }

  #splitReadyPrefix(
    stream: ActiveStream,
    node: StagedNode,
    prefix: string,
  ): boolean {
    if (
      prefix.length === 0
      || prefix.length >= node.rawText.length
      || this.#stagedNodes + 1 > this.#maximumStagedNodes
    ) return false;
    const split = this.#splitPendingNode(stream, node, prefix.length);
    this.#markReady(split.prefixNode, bodyFrom(
      stream.template,
      prefix,
      this.#projectPublicProviderIdentifier,
    ));
    return true;
  }

  #splitPendingNode(
    stream: ActiveStream,
    node: StagedNode,
    prefixLength: number,
  ): Readonly<{ prefixNode: StagedNode; residualNode: StagedNode }> {
    if (prefixLength <= 0 || prefixLength >= node.rawText.length) {
      throw new Error("SESSION_EVENT_STAGE_SPLIT_INVALID");
    }
    const queue = this.#queues.get(this.#custodyKey(node.write));
    const queueIndex = queue?.indexOf(node) ?? -1;
    if (queue === undefined || queueIndex < 0) {
      throw new Error("SESSION_EVENT_STAGE_NODE_MISSING");
    }
    const prefix = node.rawText.slice(0, prefixLength);
    const suffix = node.rawText.slice(prefixLength);
    const prefixNode: StagedNode = {
      rawText: prefix,
      readyBody: undefined,
      write: node.write,
    };
    const residualNode: StagedNode = {
      rawText: suffix,
      readyBody: undefined,
      write: node.write,
    };
    queue.splice(queueIndex, 1, prefixNode, residualNode);
    stream.pending[0] = residualNode;
    this.#stagedNodes += 1;
    return { prefixNode, residualNode };
  }

  #protectRawPrefix(
    stream: ActiveStream,
    prefixLength: number,
    safeSuffix: string,
  ): boolean {
    let remaining = prefixLength;
    let requiresSplit = false;
    for (const node of stream.pending) {
      if (remaining <= 0) break;
      if (remaining < node.rawText.length) {
        requiresSplit = true;
        break;
      }
      remaining -= node.rawText.length;
    }
    if (remaining < 0 || (requiresSplit && this.#stagedNodes + 1 > this.#maximumStagedNodes)) {
      return false;
    }
    remaining = prefixLength;
    let firstProtected: StagedNode | undefined;
    while (remaining > 0) {
      const node = stream.pending[0];
      if (node === undefined) return false;
      if (remaining < node.rawText.length) {
        const split = this.#splitPendingNode(stream, node, remaining);
        this.#markReady(split.prefixNode, null);
        firstProtected ??= split.prefixNode;
        remaining = 0;
        break;
      }
      stream.pending.shift();
      remaining -= node.rawText.length;
      this.#markReady(node, null);
      firstProtected ??= node;
    }
    if (firstProtected === undefined) return false;
    firstProtected.readyBody = bodyFrom(
      stream.template,
      "[protected]",
      this.#projectPublicProviderIdentifier,
    );
    stream.proven = safeSuffix;
    this.#releaseProvenNodes(stream, true);
    return stream.pending.length === 0 && stream.proven.length === 0;
  }

  #protectPending(stream: ActiveStream): void {
    const first = stream.pending[0];
    for (const node of stream.pending) this.#markReady(node, null);
    if (first !== undefined) {
      first.readyBody = bodyFrom(
        stream.template,
        "[protected]",
        this.#projectPublicProviderIdentifier,
      );
    }
    stream.pending.length = 0;
    stream.proven = "";
  }

  #markReady(node: StagedNode, body: SessionEventBody | null): void {
    if (node.readyBody !== undefined) throw new Error("SESSION_EVENT_STAGE_ALREADY_READY");
    this.#stagedCodeUnits -= node.rawText.length;
    node.rawText = "";
    node.readyBody = body;
  }

  #drainAuthority(write: Omit<SessionEventWrite, "body">): readonly SessionEventWrite[] {
    const key = this.#custodyKey(write);
    const queue = this.#queues.get(key);
    if (queue === undefined) return [];
    const writes: SessionEventWrite[] = [];
    while (queue.length > 0) {
      const node = queue[0];
      if (node === undefined || node.readyBody === undefined) break;
      queue.shift();
      this.#stagedNodes -= 1;
      if (node.readyBody !== null) {
        writes.push({ ...node.write, body: node.readyBody });
      }
    }
    if (queue.length === 0) this.#queues.delete(key);
    return writes;
  }

  #drainAll(): readonly SessionEventWrite[] {
    const writes: SessionEventWrite[] = [];
    for (const queue of this.#queues.values()) {
      const write = queue[0]?.write;
      if (write !== undefined) writes.push(...this.#drainAuthority(write));
    }
    return writes;
  }

  #assertWriteAuthority(write: Omit<SessionEventWrite, "body">): void {
    if (
      write.accountId !== write.providerAuthority.profileId
      || write.providerGeneration !== write.providerAuthority.processGeneration
    ) throw new Error("SESSION_EVENT_PROVIDER_AUTHORITY_MISMATCH");
  }

  #custodyKey(write: Omit<SessionEventWrite, "body">): string {
    return JSON.stringify([
      write.sessionId,
      write.providerAuthority.profileId,
      write.providerAuthority.provider,
      write.providerAuthority.providerAccountId,
      write.providerAuthority.bindingGeneration,
      write.providerAuthority.processGeneration,
    ]);
  }
}
