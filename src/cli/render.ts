import { z } from "zod";

import { formatAttachmentSize } from "../domain/attachments";
import { attachmentReferenceListSchema } from "../domain/attachment-schemas";
import {
  autorespondAfterHoursCommandResultSchema,
  notificationEmailCommandResultSchema,
  notificationHoursCommandResultSchema,
  publicSessionListItemSchema,
  publicPeerSessionPolicySchema,
  publicSessionListPageSchema,
  signedOutSessionListMetadataSchema,
  type LocalCommand,
} from "../domain/contracts";
import { canonicalizeNotificationTimeZone } from "../domain/notification-hours";
import {
  parseAccountKeyStatus,
  parseCloudDeviceList,
  type AccountKeyStatus,
} from "../cloud/contracts";
import {
  type ProtectedInteractionDetailDocument,
  publicInteractionSchema,
  type PublicInteraction,
} from "../domain/interactions";
import {
  assertRootStatusBound,
  rootStatusSchema,
  sessionStatusSchema,
  type RecoveryIntent,
  type RootStatus,
  type RootStatusAttentionRecord,
} from "../domain/observation";
import {
  sessionEventCursorWireSchema,
  sessionEventPageSchema,
  type SessionEvent,
  type SessionEventPage,
} from "../domain/session-events";
import {
  projectPublicReviewedRuntimeProfile,
  publicReviewedRuntimeProfileSchema,
  reviewedRuntimeProfileSchema,
} from "../domain/runtime-profile";
import {
  accountUsageHistoryPageSchema,
  automaticRateLimitResetStatusSchema,
} from "../domain/usage-metrics";
import { sessionStateReportSchema } from "../domain/session-state";
import { automaticUsagePolicyCommandResultSchema } from "../domain/usage-policy-command";
import { providerAccountListResultSchema } from "../domain/provider-account-list";
import { profileIdSchema, projectIdSchema, sessionIdSchema } from "../domain/values";
import { publicProviderIdentifierSchema } from "../public-provider-identifier";
import {
  sessionTaskDeleteResultSchema,
  sessionTaskListSchema,
  sessionTaskRecordSchema,
  type SessionTaskRecord,
} from "../domain/session-tasks";
import {
  WORK_APPLY_REQUEST_LEGACY_VERSION,
  WORK_PROTOCOL,
  WORK_EVENT_PAGE_MAX_BYTES,
  WORK_POLL_MAX_BYTES,
  WORK_SNAPSHOT_MAX_BYTES,
  WORK_STREAM_FAILURE_MAX_BYTES,
  WORK_TASK_DETAIL_MAX_BYTES,
  WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT,
  WORK_TASK_HISTORY_PAGE_MAX_BYTES,
  workEventPageSchema,
  workOperationResultSchema,
  workPollSchema,
  workSnapshotSchema,
  workTaskDetailSchema,
  workTaskHistoryPageSchema,
  type WorkOperation,
  type WorkOperationResult,
  type WorkTaskSpec,
  type WorkTaskSummary,
} from "../domain/work";
import {
  workAgentProtocolResponseSchema,
  workProtocolDocumentSchema,
} from "../domain/work-protocol";
import {
  terminalSafeJson,
  workReadSuccessWireDocument,
} from "../domain/terminal-json";
import { CODEX_PIN } from "../codex/pin";
import { isSensitiveDiagnosticKey, redactCompleteSensitiveText } from "./sensitive-text";

export type Output = {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
  /** Dedicated sink whose caller proves it is the visible local terminal. */
  writeProtectedStderr?(value: string): void;
  writeStdoutAsync?(value: string, signal: AbortSignal): Promise<void>;
};

const unsafeTerminalScalar = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const safeJoinControl = /[\u200c\u200d]/u;

export const terminalSafe = (value: string, preserveLineFeeds = false): string => {
  let output = "";
  for (const scalar of value) {
    if (scalar === "\n" && preserveLineFeeds) {
      output += scalar;
    } else if (unsafeTerminalScalar.test(scalar) && !safeJoinControl.test(scalar)) {
      output += `\\u{${scalar.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}}`;
    } else {
      output += scalar;
    }
  }
  return output;
};

const protectedJsonLines = (label: string, value: unknown): readonly string[] =>
  value === null ? [] : [`${label}:`, safeJson(value, 2)];

export const renderProtectedInteractionDetail = (
  document: ProtectedInteractionDetailDocument,
): string => {
  const binding = document.binding;
  const lines = [
    "Protected live approval authority",
    `Interaction: ${terminalSafe(binding.interactionId)}`,
    `Revision: ${String(binding.revision)}`,
    `Kind: ${binding.kind}`,
    `Session: ${binding.sessionId === null ? "none" : terminalSafe(binding.sessionId)}`,
    `Profile: ${terminalSafe(binding.profileId)}`,
    `Provider generation: ${String(binding.processGeneration)}`,
    `Provider connection: ${terminalSafe(binding.connectionId)}`,
  ];
  if (document.authority.kind === "command_approval") {
    lines.push(
      "Exact command:",
      terminalSafe(document.authority.command, true),
      `Exact reason: ${document.authority.reason === null ? "none" : terminalSafe(document.authority.reason, true)}`,
      `Working directory: ${document.authority.workingDirectory === null ? "none" : terminalSafe(document.authority.workingDirectory)}`,
      `Environment: ${document.authority.environmentId === null ? "none" : terminalSafe(document.authority.environmentId)}`,
      ...protectedJsonLines("Exact available decisions", document.authority.availableDecisions),
      ...protectedJsonLines("Command actions", document.authority.commandActions),
      ...protectedJsonLines("Network approval context", document.authority.networkApprovalContext),
      ...protectedJsonLines("Additional permissions", document.authority.additionalPermissions),
      ...protectedJsonLines("Proposed exec-policy amendment", document.authority.proposedExecpolicyAmendment),
      ...protectedJsonLines("Proposed network-policy amendments", document.authority.proposedNetworkPolicyAmendments),
    );
  } else {
    lines.push(
      `Working directory: ${terminalSafe(document.authority.workingDirectory)}`,
      `Environment: ${document.authority.environmentId === null ? "none" : terminalSafe(document.authority.environmentId)}`,
      `Exact reason: ${document.authority.reason === null ? "none" : terminalSafe(document.authority.reason, true)}`,
      "Exact requested permissions:",
      safeJson(document.authority.permissions, 2),
    );
  }
  lines.push("");
  return lines.join("\n");
};

export const safeJson = terminalSafeJson;

const diagnosticMaximumBytes = 2_048;
const diagnosticMaximumDepth = 4;
const diagnosticMaximumEntries = 64;
const privateKeyDiagnostic = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu;
const unixAbsolutePathDiagnostic = /(^|[\s(=[{])\/(?:[^/\s)'"`]+\/)+[^/\s)'"`]*/gu;
const windowsAbsolutePathDiagnostic = /\b[A-Za-z]:\\(?:[^\\\s)'"`]+\\)*[^\\\s)'"`]*/gu;

const boundedDiagnostic = (value: string): string => {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= diagnosticMaximumBytes) return value;
  return `${new TextDecoder().decode(encoded.subarray(0, diagnosticMaximumBytes))}[truncated]`;
};

export const safeDiagnostic = (value: string, preserveAbsolutePaths = false): string => {
  if (privateKeyDiagnostic.test(value)) return "[redacted private key diagnostic]";
  const bounded = boundedDiagnostic(redactCompleteSensitiveText(value));
  const paths = preserveAbsolutePaths
    ? bounded
    : bounded
      .replace(unixAbsolutePathDiagnostic, (_match, prefix: string) => `${prefix}[local-path]`)
      .replace(windowsAbsolutePathDiagnostic, "[local-path]");
  return terminalSafe(paths);
};

const safeDiagnosticDetails = (value: unknown, depth = 0, trustedLocalPaths = false): unknown => {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return safeDiagnostic(value);
  if (depth >= diagnosticMaximumDepth) return "[detail omitted]";
  if (Array.isArray(value)) {
    return value.slice(0, diagnosticMaximumEntries).map((entry) => safeDiagnosticDetails(entry, depth + 1, trustedLocalPaths));
  }
  if (typeof value !== "object") return "[detail omitted]";
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, diagnosticMaximumEntries)
      .map(([key, entry]) => [
        safeDiagnostic(key),
        isSensitiveDiagnosticKey(key)
          ? "[redacted]"
          : trustedLocalPaths
          && (key === "path" || key === "nextCommand" || key === "sameKeyReplayCommand")
          && typeof entry === "string"
          ? safeDiagnostic(entry, true)
          : safeDiagnosticDetails(entry, depth + 1, trustedLocalPaths),
      ]),
  );
};

const line = (value: unknown): string => {
  if (value === undefined || value === null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return terminalSafe(String(value));
  if (typeof value === "object") return safeJson(value);
  if (typeof value === "symbol") return terminalSafe(value.description ?? "symbol");
  return "unsupported";
};

const table = (rows: readonly Record<string, unknown>[], columns: readonly string[]): string => {
  if (rows.length === 0) return "No results.";
  const widths = columns.map((column) => Math.max(column.length, ...rows.map((row) => line(row[column]).length)));
  const format = (row: Record<string, unknown>) => columns.map((column, index) => line(row[column]).padEnd(widths[index] ?? 0)).join("  ").trimEnd();
  return [format(Object.fromEntries(columns.map((column) => [column, column.toUpperCase()]))), ...rows.map(format)].join("\n");
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const duration = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return `${String(Math.round(value))}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${String(minutes)}m ${String(seconds)}s`;
};

const indented = (value: string): string =>
  terminalSafe(value, true).split("\n").map((part) => `  ${part}`).join("\n");

/*
 * The attachment manifest for one message: name, declared media type, and
 * size. Never the bytes, never a digest the human did not ask for, and never a
 * path — a renderer that could print bytes is a renderer that can leak them.
 */
const renderAttachments = (value: unknown): string => {
  if (!Array.isArray(value)) return "";
  const rows = value.flatMap((entry) => {
    const attachment = object(entry);
    if (
      attachment === null
      || typeof attachment.name !== "string"
      || typeof attachment.mediaType !== "string"
      || typeof attachment.byteLength !== "number"
    ) return [];
    return [`  attached: ${line(attachment.name)}  ${line(attachment.mediaType)}  ${formatAttachmentSize(attachment.byteLength)}`];
  });
  return rows.length === 0 ? "" : `\n${rows.join("\n")}`;
};

const renderMessage = (value: unknown): string | null => {
  const message = object(value);
  if (message === null) return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  if (typeof message.text !== "string") return null;
  const omission = object(message.omission);
  const omitted = omission === null || typeof omission.omittedUtf8Bytes !== "number"
    ? ""
    : `\n  … [${String(omission.omittedUtf8Bytes)} UTF-8 bytes omitted]`;
  const turn = typeof message.turnId === "string" ? `  ${line(message.turnId)}` : "";
  return `${message.role === "user" ? "You" : "Codex"}${turn}\n${indented(message.text)}${omitted}${renderAttachments(message.attachments)}`;
};

const stringArray = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const renderTurnSummary = (value: unknown): string | null => {
  const turn = object(value);
  if (turn === null || typeof turn.status !== "string") return null;
  const files = stringArray(turn.files);
  const actions = stringArray(turn.actions);
  const turnLabel = typeof turn.id === "string" ? line(turn.id) : "Turn";
  const rows = [`${turnLabel}  ${line(turn.status)}  ${duration(turn.runtimeMs)}`];
  if (files.length > 0) rows.push(`  files: ${files.map(line).join(", ")}`);
  if (actions.length > 0) rows.push(`  actions: ${actions.map(line).join(", ")}`);
  if (typeof turn.omittedFiles === "number" && turn.omittedFiles > 0) {
    rows.push(`  files omitted: ${String(turn.omittedFiles)}`);
  }
  if (typeof turn.omittedActions === "number" && turn.omittedActions > 0) {
    rows.push(`  actions omitted: ${String(turn.omittedActions)}`);
  }
  return rows.join("\n");
};

const renderEffectiveRuntimeProfile = (value: unknown): readonly string[] => {
  const profile = object(value);
  if (profile === null) return [];
  // The two providers review different documents. Claude Code owns its own
  // permission engine, so its public profile names the pinned CLI version and
  // interactive permission mode instead of Codex approval/review capability.
  // Private config-home provenance is intentionally never rendered.
  if (typeof profile.claudeVersion === "string") {
    return [
      "Runtime",
      `  account: ${line(profile.profileId)} generation ${line(profile.processGeneration)}`,
      `  provider: Claude Code ${line(profile.claudeVersion)}`,
      `  preset: ${line(profile.preset)}`,
      `  model: ${line(profile.model)}`,
      `  reasoning effort: ${line(profile.reasoningEffort)}`,
      `  permission mode: ${line(profile.permissionMode)}`,
      `  stream: ${line(profile.inputFormat)} in, ${line(profile.outputFormat)} out`,
      `  observed at: ${line(profile.observedAt)}`,
    ];
  }
  const apps = Array.isArray(profile.enabledApps)
    ? profile.enabledApps.map(object).filter((app): app is Record<string, unknown> => app !== null)
    : [];
  const appNames = apps.map((app) => {
    const name = typeof app.name === "string" ? line(app.name) : line(app.id);
    const plugins = stringArray(app.pluginDisplayNames);
    return plugins.length === 0 ? name : `${name} (${plugins.map(line).join(", ")})`;
  });
  return [
    "Runtime",
    `  account: ${line(profile.profileId)} generation ${line(profile.processGeneration)}`,
    `  preset: ${line(profile.preset)}`,
    `  model: ${line(profile.model)}`,
    `  reasoning effort: ${line(profile.reasoningEffort)}`,
    `  service tier: ${profile.serviceTier === null ? "default" : line(profile.serviceTier)}`,
    `  Fast: ${profile.fast === true ? "enabled" : "disabled"}`,
    `  review: ${line(profile.reviewMode)}`,
    `  permission profile: ${line(profile.permissionProfile)}`,
    `  computer use: ${profile.computerUse === true ? "enabled" : "unavailable"}`,
    `  plugin capability: ${profile.pluginCapability === true ? "enabled" : "unavailable"}`,
    `  enabled apps: ${appNames.length === 0 ? "none" : appNames.join(", ")}`,
    `  observed at: ${line(profile.observedAt)}`,
  ];
};

const renderSession = (data: unknown): string => {
  const root = object(data);
  const session = object(root?.session);
  const projection = object(root?.projection);
  const selected = projection ?? session;
  if (selected === null) return safeJson(data, 2);

  const title = typeof selected.title === "string" ? line(selected.title) : "Session";
  const status = typeof selected.status === "string"
    ? line(selected.status)
    : typeof selected.state === "string"
      ? line(selected.state)
      : "unknown";
  const rows = [title, `State: ${status}`];
  if (typeof selected.projectRoot === "string") rows.push(`Project: ${line(selected.projectRoot)}`);
  const runtimeRows = renderEffectiveRuntimeProfile(root?.effectiveRuntimeProfile);
  if (runtimeRows.length > 0) rows.push("", ...runtimeRows);

  const omission = object(selected.omission);
  if (omission?.hasMoreOlderTurns === true) {
    const returned = typeof omission.returnedTurns === "number"
      ? `showing ${String(omission.returnedTurns)} recent turns; `
      : "";
    rows.push(`History: ${returned}older turns omitted`);
  }
  if (typeof omission?.omittedMessages === "number" && omission.omittedMessages > 0) {
    rows.push(`History: ${String(omission.omittedMessages)} messages omitted`);
  }

  const messages = Array.isArray(selected.messages)
    ? selected.messages.map(renderMessage).filter((message): message is string => message !== null)
    : [];
  rows.push("", "Messages", messages.length === 0 ? "No messages in the recent window." : messages.join("\n\n"));

  const summaries = Array.isArray(selected.turnSummaries)
    ? selected.turnSummaries.map(renderTurnSummary).filter((turn): turn is string => turn !== null)
    : [];
  rows.push("", "Turns", summaries.length === 0 ? "No turns in the recent window." : summaries.join("\n\n"));
  return rows.join("\n");
};

export type CoalescedSessionEvent =
  | Readonly<{
    event: SessionEvent;
    itemId: string;
    kind: "assistant" | "reasoning";
    text: string;
    turnId: string;
  }>
  | Readonly<{ event: SessionEvent; kind: "event" }>;

export const coalesceSessionEvents = (events: readonly SessionEvent[]): readonly CoalescedSessionEvent[] => {
  const coalesced: CoalescedSessionEvent[] = [];
  for (const event of events) {
    const body = event.body;
    if (body.type === "assistant_delta" || body.type === "reasoning_summary_delta") {
      const kind = body.type === "assistant_delta" ? "assistant" : "reasoning";
      const previous = coalesced.at(-1);
      if (
        previous?.kind === kind
        && previous.itemId === body.itemId
        && previous.turnId === body.turnId
      ) {
        coalesced[coalesced.length - 1] = { ...previous, event, text: previous.text + body.text };
      } else {
        coalesced.push({ event, itemId: body.itemId, kind, text: body.text, turnId: body.turnId });
      }
      continue;
    }
    const previous = coalesced.at(-1);
    if (
      previous?.kind === "event"
      && previous.event.body.type === "tool_progress"
      && body.type === "tool_progress"
      && previous.event.body.itemId === body.itemId
      && previous.event.body.turnId === body.turnId
    ) {
      coalesced[coalesced.length - 1] = { event, kind: "event" };
      continue;
    }
    if (
      previous?.kind === "event"
      && previous.event.body.type === "token_usage"
      && body.type === "token_usage"
    ) {
      coalesced[coalesced.length - 1] = { event, kind: "event" };
      continue;
    }
    coalesced.push({ event, kind: "event" });
  }
  return coalesced;
};

const eventBytes = (value: number | undefined): string =>
  value === undefined ? "" : `, ${String(value)} bytes observed`;

const eventToolTarget = (
  server: string | undefined,
  tool: string | undefined,
  fallback: string,
): string => server === undefined && tool === undefined
  ? ""
  : ` ${line(server ?? "local")}/${line(tool ?? fallback)}`;

const renderSingleEvent = (event: SessionEvent): string => {
  const body = event.body;
  switch (body.type) {
    case "connection": return `Connection: ${line(body.state)}${body.reason === undefined ? "" : ` (${line(body.reason)})`}`;
    case "gap": return `Gap: ${line(body.reason)} from ${String(body.fromSequence)} through ${String(body.throughSequence)}`;
    case "session_status": return `Session: ${line(body.status)}${body.activeTurnId === null ? "" : `, active turn ${line(body.activeTurnId)}`}`;
    case "turn_started": return `Turn started: ${line(body.turnId)}`;
    case "turn_completed": return `Turn ${line(body.turnId)}: ${line(body.status)}${body.errorCode === undefined ? "" : ` (${line(body.errorCode)})`}`;
    case "session_state": return `State: ${line(body.state)}${body.attention ? ", needs you" : ""} (${line(body.reason)}), revision ${String(body.revision)}`;
    case "item_started": return `Item started: ${line(body.itemKind)}${eventToolTarget(body.server, body.tool, body.itemKind)} ${line(body.itemId)}`;
    case "item_completed": return `Item completed: ${line(body.itemKind)}${eventToolTarget(body.server, body.tool, body.itemKind)} ${line(body.itemId)}${body.status === undefined ? "" : ` (${line(body.status)})`}`;
    case "assistant_delta": return `Codex\n${indented(body.text)}`;
    case "reasoning_summary_delta": return `Reasoning summary\n${indented(body.text)}`;
    case "tool_progress": {
      const target = eventToolTarget(body.server, body.tool, body.toolKind);
      return `Tool: ${line(body.toolKind)}${target}${body.status === undefined ? "" : `, ${line(body.status)}`}${eventBytes(body.outputBytesObserved)}`;
    }
    case "file_change": {
      const paths = body.paths.map((path) => `${line(path.kind)} ${line(path.path)}`);
      if (body.omittedPaths > 0) paths.push(`${String(body.omittedPaths)} paths omitted`);
      return [`Files: ${line(body.status)}`, ...paths.map((path) => `  ${path}`)].join("\n");
    }
    case "plan_updated": return [
      "Plan updated",
      ...body.steps.map((step) => `  ${line(step.status)}  ${line(step.text)}`),
      ...(body.explanation === undefined ? [] : [`  ${line(body.explanation)}`]),
    ].join("\n");
    case "diff_updated": return `Diff: ${String(body.changedFiles)} files, ${String(body.patchBytesObserved)} bytes observed`;
    case "token_usage": return `Tokens: ${body.totalTokens === null ? "unknown" : String(body.totalTokens)} total${body.modelContextWindow === null ? "" : ` of ${String(body.modelContextWindow)}`}${body.providerCost === undefined ? "" : `; provider cost ${String(body.providerCost.amount)} ${body.providerCost.currency}`}`;
    case "interaction_requested": return [
      `Interaction required: ${line(body.interactionKind)} ${line(body.interactionId)}`,
      `  revision ${String(body.revision)}${body.blocking ? ", blocking" : ""}`,
      `  ${line(body.summary)}`,
    ].join("\n");
    case "interaction_state": return `Interaction ${line(body.interactionId)}: ${line(body.state)}, revision ${String(body.revision)}`;
    case "warning": return `Warning ${line(body.code)}: ${line(body.message)}`;
    case "error": return `Error ${line(body.code)}${body.terminal ? " (terminal)" : ""}: ${line(body.message)}`;
    case "protocol_incompatible": return `Protocol notice: unsupported ${line(body.method)} (${line(body.payloadDigest)})`;
    case "subagent_activity": return [
      `Subagent ${line(body.kind)}: ${line(body.agentId)}`,
      ...(body.nickname === undefined ? [] : [`  nickname ${line(body.nickname)}`]),
      ...(body.role === undefined ? [] : [`  role ${line(body.role)}`]),
      ...(body.depth === undefined ? [] : [`  depth ${String(body.depth)}`]),
    ].join("\n");
    case "user_message": return [
      body.actor === "human"
        ? "You"
        : body.actor === "autorespond"
          ? "Autorespond"
          : body.actor === "peer_session"
            ? "Peer session"
            : "Handoff",
      indented(body.text),
      ...(body.omittedCharacters === 0
        ? []
        : [`  ${String(body.omittedCharacters)} characters omitted`]),
    ].join("\n");
    case "provider_switched": return [
      `Provider switched: ${line(body.fromProvider)} to ${line(body.toProvider)}`,
      `  preset ${line(body.fromPreset)} to ${line(body.toPreset)}`,
      `  account ${body.accountChanged ? "changed" : "unchanged"}`,
      `  seed ${line(body.seedDigest)}, ${String(body.seedOmittedRecords)} records omitted`,
    ].join("\n");
  }
};

export const renderSessionEventPageHuman = (page: SessionEventPage): string => {
  const rows: string[] = [];
  if (page.gap !== null) {
    rows.push(
      `Event gap: ${line(page.gap.reason)}. Retained events begin at sequence ${String(page.gap.retainedFromSequence)}.`,
    );
  }
  for (const entry of coalesceSessionEvents(page.events)) {
    if (entry.kind === "assistant" || entry.kind === "reasoning") {
      rows.push(`${entry.kind === "assistant" ? "Codex" : "Reasoning summary"}\n${indented(entry.text)}`);
    } else {
      rows.push(renderSingleEvent(entry.event));
    }
  }
  return rows.length === 0 ? "No new events." : rows.join("\n\n");
};

const sessionEventPage = (data: unknown): SessionEventPage | null => {
  const direct = sessionEventPageSchema.safeParse(data);
  if (direct.success) return direct.data;
  const root = object(data);
  const nested = sessionEventPageSchema.safeParse(root?.page);
  return nested.success ? nested.data : null;
};

const interactionRecords = (data: unknown): readonly PublicInteraction[] => {
  const root = object(data);
  const source = Array.isArray(data)
    ? data
    : Array.isArray(root?.interactions)
      ? root.interactions
      : [];
  return source.flatMap((value) => {
    const parsed = publicInteractionSchema.safeParse(value);
    return parsed.success ? [parsed.data] : [];
  });
};

const interactionRecord = (data: unknown): PublicInteraction | null => {
  const direct = publicInteractionSchema.safeParse(data);
  if (direct.success) return direct.data;
  const root = object(data);
  const nested = publicInteractionSchema.safeParse(root?.interaction);
  if (nested.success) return nested.data;
  const recorded = publicInteractionSchema.safeParse(root?.record);
  return recorded.success ? recorded.data : null;
};

const boundedString = (value: unknown, maximum: number): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;

const opaqueCursor = (value: unknown): string | undefined => {
  const parsed = sessionEventCursorWireSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const usageHistoryCursor = (value: unknown): string | undefined =>
  typeof value === "string"
    && value.length <= 2_048
    && /^hrau1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value)
    ? value
    : undefined;

export const publicAccountLoginData = (data: unknown): unknown => {
  const root = object(data);
  const account = object(root?.account);
  const login = object(root?.login);
  if (root === null || account === null || login === null) {
    return { login: { status: "unavailable" } };
  }
  const publicAccount = {
    ...(boundedString(account.id, 200) === undefined ? {} : { id: boundedString(account.id, 200) }),
    ...(boundedString(account.label, 200) === undefined ? {} : { label: boundedString(account.label, 200) }),
    ...(boundedString(account.state, 64) === undefined ? {} : { state: boundedString(account.state, 64) }),
    ...(typeof account.processGeneration !== "number" ? {} : { processGeneration: account.processGeneration }),
    ...(boundedString(account.providerEmail, 320) === undefined ? {} : { providerEmail: boundedString(account.providerEmail, 320) }),
    ...(boundedString(account.providerPlan, 200) === undefined ? {} : { providerPlan: boundedString(account.providerPlan, 200) }),
    ...(typeof account.updatedAt !== "number" ? {} : { updatedAt: account.updatedAt }),
  };
  const handoff = object(login.handoff);
  const status = login.status === "pending"
    || login.status === "signed_in"
    || login.status === "settled"
    ? login.status
    : "unavailable";
  const publicHandoff = handoff === null
    ? undefined
    : handoff.status === "written"
      && boundedString(handoff.path, 4_096) !== undefined
      && handoff.documentVersion === 1
      && handoff.disposition === "preserved_caller_removes_after_login"
      ? {
          disposition: "preserved_caller_removes_after_login" as const,
          documentVersion: 1 as const,
          path: boundedString(handoff.path, 4_096),
          status: "written" as const,
        }
      : handoff.status === "shown_in_protected_terminal"
        ? { status: "shown_in_protected_terminal" as const }
        : handoff.status === "unavailable_on_replay"
          ? { status: "unavailable_on_replay" as const }
          : undefined;
  return {
    account: publicAccount,
    ...(boundedString(root.idempotencyKey, 64) === undefined
      ? {}
      : { idempotencyKey: boundedString(root.idempotencyKey, 64) }),
    login: {
      status,
      ...(publicHandoff === undefined ? {} : { handoff: publicHandoff }),
    },
  };
};

export class InvalidCommandResponseError extends Error {
  readonly command: LocalCommand["kind"];

  constructor(command: LocalCommand["kind"]) {
    super(`The Oompa daemon returned an invalid response for ${command}.`);
    this.name = "InvalidCommandResponseError";
    this.command = command;
  }
}

const invalidCommandResponse = (command: LocalCommand): never => {
  throw new InvalidCommandResponseError(command.kind);
};

const publicSessionCommandRecordSchema = publicSessionListItemSchema.extend({
  activeTurnId: publicProviderIdentifierSchema.optional(),
}).strict();

const publicProjectionTextOmissionSchema = z.object({
  originalUtf8Bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  returnedUtf8Bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  omittedUtf8Bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const publicProjectedMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  turnId: publicProviderIdentifierSchema.optional(),
  omission: publicProjectionTextOmissionSchema.optional(),
  attachments: attachmentReferenceListSchema.optional(),
}).strict();

const publicTurnSummarySchema = z.object({
  id: publicProviderIdentifierSchema.optional(),
  status: z.enum(["completed", "interrupted", "failed", "inProgress"]),
  startedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  completedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  runtimeMs: z.number().nonnegative().finite().optional(),
  files: z.array(z.string()).max(128),
  actions: z.array(z.string()).max(128),
  omittedFiles: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  omittedActions: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

const publicProjectionOmissionSchema = z.object({
  hasMoreOlderTurns: z.boolean(),
  returnedTurns: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  turnLimit: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  omittedMessages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  truncatedMessages: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  unreadItemTurnIds: z.array(publicProviderIdentifierSchema).max(100),
  incompleteTurnIds: z.array(publicProviderIdentifierSchema).max(100),
}).strict();

const publicSessionProjectionSchema = z.object({
  title: z.string(),
  status: z.enum(["active", "idle", "terminal"]),
  projectRoot: z.string().max(4_096).optional(),
  activeTurnId: publicProviderIdentifierSchema.optional(),
  messages: z.array(publicProjectedMessageSchema).max(100).optional(),
  turnSummaries: z.array(publicTurnSummarySchema).max(100).optional(),
  omission: publicProjectionOmissionSchema.optional(),
}).strict();

const publicSessionRecoverySchema = z.object({
  required: z.literal(true),
  cleared: z.literal(false),
}).strict();

const publicSessionShowResultSchema = z.object({
  session: publicSessionCommandRecordSchema,
  effectiveRuntimeProfile: publicReviewedRuntimeProfileSchema.nullable(),
  projection: publicSessionProjectionSchema.optional(),
  recovery: publicSessionRecoverySchema.optional(),
}).strict();

const publicSessionStartResultSchema = z.object({
  session: publicSessionCommandRecordSchema,
  effectiveRuntimeProfile: publicReviewedRuntimeProfileSchema.nullable(),
  idempotencyKey: z.string().uuid(),
}).strict();

const publicSessionSendResultSchema = z.object({
  session: publicSessionCommandRecordSchema,
  effectiveRuntimeProfile: publicReviewedRuntimeProfileSchema.nullable(),
  idempotencyKey: z.string().uuid(),
  turnId: publicProviderIdentifierSchema.optional(),
  attachments: attachmentReferenceListSchema.optional(),
}).strict();

type PublicSessionCommand = Extract<
  LocalCommand,
  { kind: "session.show" | "session.start" | "session.send" }
>;

const projectPublicProviderAlias = (value: unknown): string | undefined => {
  const parsed = publicProviderIdentifierSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const projectPublicSessionRecord = (
  value: unknown,
): z.infer<typeof publicSessionCommandRecordSchema> | null => {
  const parsed = publicSessionListItemSchema.safeParse(value);
  if (!parsed.success) return null;
  const record = object(value);
  const activeTurnId = projectPublicProviderAlias(record?.activeTurnId);
  const projected = publicSessionCommandRecordSchema.safeParse({
    ...parsed.data,
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
  });
  return projected.success ? projected.data : null;
};

const projectPublicMessage = (
  value: unknown,
): z.infer<typeof publicProjectedMessageSchema> | null => {
  const message = object(value);
  if (message === null) return null;
  const turnId = projectPublicProviderAlias(message.turnId);
  const projected = publicProjectedMessageSchema.safeParse({
    role: message.role,
    text: message.text,
    ...(turnId === undefined ? {} : { turnId }),
    ...(message.omission === undefined ? {} : { omission: message.omission }),
    ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
  });
  return projected.success ? projected.data : null;
};

const projectPublicTurnSummary = (
  value: unknown,
): z.infer<typeof publicTurnSummarySchema> | null => {
  const summary = object(value);
  if (summary === null) return null;
  const id = projectPublicProviderAlias(summary.id);
  const projected = publicTurnSummarySchema.safeParse({
    ...(id === undefined ? {} : { id }),
    status: summary.status,
    ...(summary.startedAt === undefined ? {} : { startedAt: summary.startedAt }),
    ...(summary.completedAt === undefined ? {} : { completedAt: summary.completedAt }),
    ...(summary.runtimeMs === undefined ? {} : { runtimeMs: summary.runtimeMs }),
    files: summary.files,
    actions: summary.actions,
    omittedFiles: summary.omittedFiles,
    omittedActions: summary.omittedActions,
  });
  return projected.success ? projected.data : null;
};

const projectPublicProviderAliases = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const alias = projectPublicProviderAlias(entry);
    return alias === undefined ? [] : [alias];
  });
};

const projectPublicSessionProjection = (
  value: unknown,
): z.infer<typeof publicSessionProjectionSchema> | null => {
  const projection = object(value);
  if (projection === null) return null;
  const messages = projection.messages === undefined
    ? undefined
    : Array.isArray(projection.messages)
      ? projection.messages.map(projectPublicMessage)
      : null;
  const turnSummaries = projection.turnSummaries === undefined
    ? undefined
    : Array.isArray(projection.turnSummaries)
      ? projection.turnSummaries.map(projectPublicTurnSummary)
      : null;
  if (messages === null || messages?.some((message) => message === null) === true) return null;
  if (turnSummaries === null || turnSummaries?.some((summary) => summary === null) === true) return null;
  const omission = projection.omission === undefined
    ? undefined
    : object(projection.omission);
  const unreadItemTurnIds = omission === undefined
    ? undefined
    : projectPublicProviderAliases(omission?.unreadItemTurnIds);
  const incompleteTurnIds = omission === undefined
    ? undefined
    : projectPublicProviderAliases(omission?.incompleteTurnIds);
  if (
    omission === null
    || unreadItemTurnIds === null
    || incompleteTurnIds === null
  ) return null;
  const activeTurnId = projectPublicProviderAlias(projection.activeTurnId);
  const projected = publicSessionProjectionSchema.safeParse({
    title: projection.title,
    status: projection.status,
    ...(projection.projectRoot === undefined ? {} : { projectRoot: projection.projectRoot }),
    ...(activeTurnId === undefined ? {} : { activeTurnId }),
    ...(messages === undefined ? {} : { messages }),
    ...(turnSummaries === undefined ? {} : { turnSummaries }),
    ...(omission === undefined
      ? {}
      : {
          omission: {
            hasMoreOlderTurns: omission.hasMoreOlderTurns,
            returnedTurns: omission.returnedTurns,
            turnLimit: omission.turnLimit,
            omittedMessages: omission.omittedMessages,
            truncatedMessages: omission.truncatedMessages,
            unreadItemTurnIds,
            incompleteTurnIds,
          },
        }),
  });
  return projected.success ? projected.data : null;
};

const projectPublicRuntimeProfile = (
  value: unknown,
): z.infer<typeof publicReviewedRuntimeProfileSchema> | null | undefined => {
  if (value === null) return null;
  // Service responses already omit private runtime custody. Accept that exact
  // public contract without requiring callers to restore the omitted fields.
  const publicProfile = publicReviewedRuntimeProfileSchema.safeParse(value);
  if (publicProfile.success) return publicProfile.data;
  const reviewed = reviewedRuntimeProfileSchema.safeParse(value);
  if (!reviewed.success) return undefined;
  const projected = publicReviewedRuntimeProfileSchema.safeParse(
    projectPublicReviewedRuntimeProfile(reviewed.data),
  );
  return projected.success ? projected.data : undefined;
};

const projectPublicSessionCommandData = (
  command: PublicSessionCommand,
  data: unknown,
): z.infer<typeof publicSessionShowResultSchema>
  | z.infer<typeof publicSessionStartResultSchema>
  | z.infer<typeof publicSessionSendResultSchema>
  | null => {
  const root = object(data);
  if (root === null) return null;
  const session = projectPublicSessionRecord(root.session);
  const effectiveRuntimeProfile = projectPublicRuntimeProfile(root.effectiveRuntimeProfile);
  if (session === null || effectiveRuntimeProfile === undefined) return null;
  if (command.kind === "session.show") {
    const requestedSession = sessionIdSchema.safeParse(command.session);
    if (requestedSession.success && session.id !== requestedSession.data) return null;
    const projection = root.projection === undefined
      ? undefined
      : projectPublicSessionProjection(root.projection);
    if (projection === null) return null;
    const recoveryRecord = root.recovery === undefined ? undefined : object(root.recovery);
    if (recoveryRecord === null) return null;
    const recovery = recoveryRecord === undefined
      ? undefined
      : publicSessionRecoverySchema.safeParse({
          required: recoveryRecord.required,
          cleared: recoveryRecord.cleared,
        });
    if (recovery !== undefined && !recovery.success) return null;
    const parsed = publicSessionShowResultSchema.safeParse({
      session,
      effectiveRuntimeProfile,
      ...(projection === undefined ? {} : { projection }),
      ...(recovery === undefined ? {} : { recovery: recovery.data }),
    });
    return parsed.success ? parsed.data : null;
  }
  if (command.kind === "session.start") {
    const requestedAccount = profileIdSchema.safeParse(command.account);
    const requestedProject = command.project === undefined
      ? null
      : projectIdSchema.safeParse(command.project);
    if (
      (requestedAccount.success && session.profileId !== requestedAccount.data)
      || (requestedProject?.success === true && session.projectId !== requestedProject.data)
      || session.provider !== (command.provider ?? "codex")
      || session.preset !== command.preset
      || session.fastEnabled !== command.fast
      || (command.idempotencyKey !== undefined && root.idempotencyKey !== command.idempotencyKey)
    ) return null;
    const parsed = publicSessionStartResultSchema.safeParse({
      session,
      effectiveRuntimeProfile,
      idempotencyKey: root.idempotencyKey,
    });
    return parsed.success ? parsed.data : null;
  }
  const requestedSession = sessionIdSchema.safeParse(command.session);
  if (
    (requestedSession.success && session.id !== requestedSession.data)
    || (command.idempotencyKey !== undefined && root.idempotencyKey !== command.idempotencyKey)
  ) return null;
  const turnId = projectPublicProviderAlias(root.turnId);
  const parsed = publicSessionSendResultSchema.safeParse({
    session,
    effectiveRuntimeProfile,
    idempotencyKey: root.idempotencyKey,
    ...(turnId === undefined ? {} : { turnId }),
    ...(root.attachments === undefined ? {} : { attachments: root.attachments }),
  });
  return parsed.success ? parsed.data : null;
};

const hasOnlyValidInteractions = (value: unknown): boolean =>
  Array.isArray(value)
  && value.every((entry) => publicInteractionSchema.safeParse(entry).success);

const hasOnlyInteractionsBoundToSession = (value: unknown, sessionId: string): boolean =>
  Array.isArray(value)
  && value.every((entry) => {
    const parsed = publicInteractionSchema.safeParse(entry);
    return parsed.success && parsed.data.sessionId === sessionId;
  });

const hasOpaqueCursorOrNull = (value: unknown): boolean =>
  value === null || opaqueCursor(value) !== undefined;

const workRouteMatches = (
  left: Readonly<{ accountId: string; projectId: string }>,
  right: Readonly<{ accountId: string; projectId: string }>,
): boolean => left.accountId === right.accountId && left.projectId === right.projectId;

const workTaskBatchMatches = (
  specs: readonly WorkTaskSpec[],
  tasks: readonly WorkTaskSummary[],
): boolean => specs.length === tasks.length && tasks.every((task) => {
  const spec = specs.find((candidate) => candidate.clientRef === task.clientRef);
  return spec !== undefined
    && workRouteMatches(spec.route, task.route)
    && spec.preset === task.preset
    && spec.fast === task.fast
    && spec.priority === task.priority;
});

const workExecutionRoutesMatch = (
  left: readonly Readonly<{ accountId: string; projectId: string; preset: string; fast: boolean }>[],
  right: readonly Readonly<{ accountId: string; projectId: string; preset: string; fast: boolean }>[],
): boolean => left.length === right.length && left.every((route) => right.some((candidate) =>
  candidate.accountId === route.accountId
  && candidate.projectId === route.projectId
  && candidate.preset === route.preset
  && candidate.fast === route.fast));

const workResultMatchesOperation = (
  operation: WorkOperation,
  result: WorkOperationResult,
): boolean => {
  switch (result.kind) {
    case "work.create":
      return operation.kind === result.kind
        && result.work.clientRef === operation.clientRef
        && result.work.coordinatorSessionId === operation.coordinatorSessionId
        && result.work.objective === operation.objective
        && workExecutionRoutesMatch(operation.routes, result.routes)
        && workTaskBatchMatches(operation.tasks, result.tasks);
    case "task.addBatch":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && workTaskBatchMatches(operation.tasks, result.tasks);
    case "work.join":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.actorSessionId === operation.actorSessionId;
    case "task.claim":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.task.id === operation.taskId
        && result.attempt.taskId === operation.taskId
        && result.attempt.actorSessionId === operation.actorSessionId;
    case "task.claimNext":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && (result.task === null
          ? result.attempt === null
          : result.attempt !== null
            && result.attempt.taskId === result.task.id
            && result.attempt.actorSessionId === operation.actorSessionId
            && workRouteMatches(result.task.route, operation.route));
    case "task.claimBatch":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.claims.length === operation.claims.length
        && result.claims.every((claim, index) => {
          const requested = operation.claims[index];
          return requested !== undefined
            && claim.task.id === requested.taskId
            && claim.attempt.taskId === requested.taskId
            && claim.attempt.actorSessionId === requested.actorSessionId;
        });
    case "attempt.renew":
    case "attempt.release":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.attempt.id === operation.attemptId
        && result.attempt.fence === operation.fence
        && result.attempt.actorSessionId === operation.actorSessionId;
    case "attempt.dispatch":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.attempt.id === operation.attemptId
        && result.attempt.fence === operation.fence
        && result.attempt.actorSessionId === operation.actorSessionId
        && result.effect.kind === "dispatch"
        && result.effect.idempotencyKey === operation.idempotencyKey
        && result.effect.subjectId === operation.attemptId
        && result.effect.targetSessionId === operation.targetSessionId
        && result.effect.instructionDigest.length > 0;
    case "attempt.report":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.attempt.id === operation.attemptId
        && result.attempt.fence === operation.fence
        && result.attempt.actorSessionId === operation.actorSessionId
        && (operation.report.kind === "submit"
          ? result.submission !== null
            && result.submission.attemptId === operation.attemptId
            && result.submission.taskId === result.attempt.taskId
          : result.submission === null);
    case "submission.review":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.submission.id === operation.submissionId
        && result.submission.contentDigest === operation.expectedContentDigest
        && result.review.submissionId === operation.submissionId
        && result.review.reviewerSessionId === operation.reviewerSessionId
        && result.review.decision === operation.review.decision;
    case "signal.send":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.signal.senderSessionId === operation.senderSessionId
        && result.signal.targetSessionId === operation.targetSessionId
        && result.signal.taskId === (operation.taskId ?? null)
        && result.signal.replyToSignalId === (operation.replyToSignalId ?? null)
        && result.signal.mode === operation.mode
        && result.signal.body === operation.body
        && result.effect.kind === "signal"
        && result.effect.idempotencyKey === operation.idempotencyKey
        && result.effect.subjectId === result.signal.id
        && result.effect.targetSessionId === operation.targetSessionId
        && result.effect.instructionDigest.length > 0;
    case "signal.ack":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.signal.id === operation.signalId
        && result.signal.targetSessionId === operation.actorSessionId;
    case "work.complete":
    case "work.fail":
    case "work.cancel":
      return operation.kind === result.kind && result.work.id === operation.workId;
    case "work.release":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.workRevision === operation.expectedWorkRevision
        && result.tombstone.workId === operation.workId
        && result.tombstone.coordinatorSessionId === operation.actorSessionId
        && result.tombstone.finalRevision === operation.expectedWorkRevision;
    case "attempt.reconcile":
      return operation.kind === result.kind
        && result.workId === operation.workId
        && result.attempt.id === operation.attemptId
        && result.attempt.fence === operation.fence
        && result.attempt.actorSessionId === operation.actorSessionId
        && (result.submission === null
          || (
            result.submission.attemptId === operation.attemptId
            && result.submission.taskId === result.attempt.taskId
          ));
  }
};

const assertCommandSuccessData = (command: LocalCommand, data: unknown): void => {
  if (
    command.kind === "autorespond-after-hours.status"
    || command.kind === "autorespond-after-hours.enable"
    || command.kind === "autorespond-after-hours.disable"
  ) {
    const parsed = autorespondAfterHoursCommandResultSchema.safeParse(data);
    if (!parsed.success) return invalidCommandResponse(command);
    if (
      command.kind !== "autorespond-after-hours.status"
      && (
        parsed.data.policy.revision !== command.expectedRevision + 1
        || parsed.data.policy.enabled !== (command.kind === "autorespond-after-hours.enable")
      )
    ) invalidCommandResponse(command);
    return;
  }
  if (
    command.kind === "notification-email.status"
    || command.kind === "notification-email.enable"
    || command.kind === "notification-email.disable"
  ) {
    const parsed = notificationEmailCommandResultSchema.safeParse(data);
    if (!parsed.success) return invalidCommandResponse(command);
    const authorityState = parsed.data.hostedAuthority.state;
    if (
      (command.kind === "notification-email.enable"
        && authorityState !== "not_observed"
        && authorityState !== "observed")
      || (command.kind === "notification-email.disable"
        && authorityState !== "not_observed"
        && authorityState !== "acknowledged"
        && authorityState !== "revocation_pending")
    ) return invalidCommandResponse(command);
    if (
      command.kind !== "notification-email.status"
      && (
        parsed.data.policy.revision !== command.expectedRevision + 1
        || parsed.data.policy.enabled !== (command.kind === "notification-email.enable")
      )
    ) invalidCommandResponse(command);
    return;
  }
  if (
    command.kind === "notification-hours.status"
    || command.kind === "notification-hours.set"
  ) {
    const parsed = notificationHoursCommandResultSchema.safeParse(data);
    if (!parsed.success) return invalidCommandResponse(command);
    if (command.kind === "notification-hours.set") {
      let expectedTimeZone: string;
      try {
        expectedTimeZone = canonicalizeNotificationTimeZone(command.timeZone);
      } catch {
        return invalidCommandResponse(command);
      }
      if (
        parsed.data.policy.revision !== command.expectedRevision + 1
        || parsed.data.policy.startMinute !== command.startMinute
        || parsed.data.policy.endMinute !== command.endMinute
        || parsed.data.policy.timeZone !== expectedTimeZone
      ) invalidCommandResponse(command);
    }
    return;
  }
  if (command.kind === "work.protocol") {
    const parsed = workProtocolDocumentSchema.safeParse(data);
    if (
      !parsed.success
      || JSON.stringify(parsed.data.query) !== JSON.stringify(command.query)
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "work.apply") {
    const parsed = workOperationResultSchema.safeParse(data);
    if (!parsed.success || !workResultMatchesOperation(command.operation, parsed.data)) {
      invalidCommandResponse(command);
    }
    return;
  }
  if (command.kind === "work.snapshot") {
    const parsed = workSnapshotSchema.safeParse(data);
    if (
      !parsed.success
      || parsed.data.work.id !== command.work
      || (
        command.actor !== undefined
        && !parsed.data.joinedSessionIds.includes(command.actor)
      )
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "work.task") {
    const historyMode = command.historyLimit !== undefined
      || command.historyCursor !== undefined;
    if (historyMode) {
      const parsed = workTaskHistoryPageSchema.safeParse(data);
      if (
        !parsed.success
        || parsed.data.taskId !== command.task
        || parsed.data.requestedCursor !== (command.historyCursor ?? null)
        || parsed.data.items.length > (
          command.historyLimit ?? WORK_TASK_HISTORY_DEFAULT_ITEM_LIMIT
        )
      ) invalidCommandResponse(command);
      return;
    }
    const parsed = workTaskDetailSchema.safeParse(data);
    if (!parsed.success || parsed.data.task.id !== command.task) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "work.poll") {
    const parsed = workPollSchema.safeParse(data);
    if (
      !parsed.success
      || parsed.data.workId !== command.work
      || parsed.data.actorSessionId !== (command.actor ?? null)
      || parsed.data.eventPage.requestedCursor !== (command.cursor ?? null)
      || parsed.data.requestedActionCursor !== (command.actionCursor ?? null)
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "work.events") {
    const parsed = workEventPageSchema.safeParse(data);
    if (
      !parsed.success
      || parsed.data.workId !== command.work
      || parsed.data.requestedCursor !== (command.cursor ?? null)
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "device.list") {
    if (parseCloudDeviceList(data) === null) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "account.usage-history") {
    const parsed = accountUsageHistoryPageSchema.safeParse(data);
    if (!parsed.success || (parsed.data.nextCursor !== null && usageHistoryCursor(parsed.data.nextCursor) === undefined)) {
      invalidCommandResponse(command);
    }
    return;
  }
  if (command.kind === "account.usage") {
    const root = object(data);
    if (
      root === null
      || !Array.isArray(root.usage)
      || !root.usage.every((entry) => {
        const record = object(entry);
        return record !== null
          && automaticRateLimitResetStatusSchema.safeParse(record.automaticReset).success;
      })
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "session.list") {
    const parsed = publicSessionListPageSchema.safeParse(data);
    const exactRequestedAccount = profileIdSchema.safeParse(command.account);
    if (
      !parsed.success
      || (command.account === undefined
        ? parsed.data.accountId !== null
        : parsed.data.accountId === null)
      || (
        exactRequestedAccount.success
        && parsed.data.accountId !== exactRequestedAccount.data
      )
      || !hasOpaqueCursorOrNull(parsed.data.nextCursor)
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "session.task.list") {
    const parsed = sessionTaskListSchema.safeParse(data);
    const exactSession = sessionIdSchema.safeParse(command.session);
    if (
      !parsed.success
      || (exactSession.success && parsed.data.sessionId !== exactSession.data)
      || parsed.data.tasks.some((task) => task.sessionId !== parsed.data.sessionId)
    ) invalidCommandResponse(command);
    return;
  }
  if (
    command.kind === "session.task.show"
    || command.kind === "session.task.create"
    || command.kind === "session.task.edit"
  ) {
    const parsed = sessionTaskRecordSchema.safeParse(data);
    const exactSession = sessionIdSchema.safeParse(command.session);
    if (
      !parsed.success
      || (exactSession.success && parsed.data.sessionId !== exactSession.data)
      || (
        (command.kind === "session.task.show" || command.kind === "session.task.edit")
        && parsed.data.id !== command.task
      )
      || (
        command.kind === "session.task.create"
        && (
          parsed.data.revision !== 1
          || parsed.data.name !== command.name
          || parsed.data.prompt !== command.prompt
          || parsed.data.schedule.minutes !== command.everyMinutes
          || parsed.data.status !== (command.paused ? "paused" : "active")
        )
      )
      || (
        command.kind === "session.task.edit"
        && (
          parsed.data.revision !== command.expectedRevision + 1
          || (command.name !== undefined && parsed.data.name !== command.name)
          || (command.prompt !== undefined && parsed.data.prompt !== command.prompt)
          || (
            command.everyMinutes !== undefined
            && parsed.data.schedule.minutes !== command.everyMinutes
          )
          || (command.status !== undefined && parsed.data.status !== command.status)
        )
      )
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "session.task.delete") {
    const parsed = sessionTaskDeleteResultSchema.safeParse(data);
    const exactSession = sessionIdSchema.safeParse(command.session);
    if (
      !parsed.success
      || parsed.data.taskId !== command.task
      || parsed.data.revision !== command.expectedRevision + 1
      || (exactSession.success && parsed.data.sessionId !== exactSession.data)
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "session.status") {
    const parsed = sessionStatusSchema.safeParse(data);
    const exactSession = sessionIdSchema.safeParse(command.session);
    if (
      !parsed.success
      || (exactSession.success && parsed.data.session.id !== exactSession.data)
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "session.state") {
    const parsed = sessionStateReportSchema.safeParse(data);
    const exactSession = sessionIdSchema.safeParse(command.session);
    if (
      !parsed.success
      || (exactSession.success && parsed.data.session !== exactSession.data)
    ) invalidCommandResponse(command);
    return;
  }
  if (
    command.kind === "session.peer-policy.get"
    || command.kind === "session.peer-policy.set"
  ) {
    const parsed = publicPeerSessionPolicySchema.safeParse(data);
    const exactSession = sessionIdSchema.safeParse(command.session);
    if (
      !parsed.success
      || (exactSession.success && parsed.data.sessionId !== exactSession.data)
      || (
        command.kind === "session.peer-policy.set"
        && (
          parsed.data.mode !== command.mode
          || parsed.data.revision !== command.expectedRevision + 1
        )
      )
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "session.events") {
    const page = sessionEventPage(data);
    const exactSession = sessionIdSchema.safeParse(command.session);
    if (
      page === null
      || (exactSession.success && page.sessionId !== exactSession.data)
      || page.requestedCursor !== (command.cursor ?? null)
    ) invalidCommandResponse(command);
    return;
  }
  if (command.kind === "interaction.show") {
    const interaction = interactionRecord(data);
    if (interaction === null || interaction.id !== command.interaction) {
      invalidCommandResponse(command);
    }
    return;
  }
  if (command.kind === "interaction.resolve") {
    const root = object(data);
    const interaction = interactionRecord(data);
    if (
      interaction === null
      || interaction.id !== command.interaction
      || typeof root?.responseWritten !== "boolean"
    ) {
      invalidCommandResponse(command);
    }
    return;
  }
  if (command.kind === "interaction.list" || command.kind === "session.interactions") {
    const root = object(data);
    const sessionId = sessionIdSchema.safeParse(root?.sessionId);
    const scoped = command.kind === "session.interactions" || command.session !== undefined;
    const requestedSession = command.kind === "session.interactions"
      ? command.session
      : command.session;
    const exactRequestedSession = sessionIdSchema.safeParse(requestedSession);
    if (
      root === null
      || (scoped ? !sessionId.success : root.sessionId !== null)
      || !hasOnlyValidInteractions(root.interactions)
      || (
        scoped
        && !hasOnlyInteractionsBoundToSession(
          root.interactions,
          sessionId.success ? sessionId.data : "",
        )
      )
      || (
        scoped
        && exactRequestedSession.success
        && (!sessionId.success || sessionId.data !== exactRequestedSession.data)
      )
      || !hasOpaqueCursorOrNull(root.nextCursor)
    ) invalidCommandResponse(command);
  }
};

const publicInteractionData = (command: LocalCommand, data: unknown): unknown => {
  if (command.kind === "account.list" && command.provider !== undefined) {
    const parsed = providerAccountListResultSchema.safeParse(data);
    if (!parsed.success || parsed.data.provider !== command.provider) return invalidCommandResponse(command);
    return parsed.data;
  }
  if (command.kind === "usage.auto.status" || command.kind === "usage.auto.set") {
    const parsed = automaticUsagePolicyCommandResultSchema.safeParse(data);
    if (!parsed.success) return invalidCommandResponse(command);
    const result = parsed.data;
    const providers = command.kind === "usage.auto.status" && command.provider !== undefined
      ? [command.provider] : ["codex", "claude"];
    if (result.effective.length !== providers.length
      || result.effective.some((entry, index) => entry.provider !== providers[index])) {
      return invalidCommandResponse(command);
    }
    if (command.kind === "usage.auto.set") {
      const change = command.change;
      if (result.configuration.automaticPolicyRevision !== command.expectedAutomaticPolicyRevision + 1
        || (change.kind === "set_default"
          ? result.configuration.defaultEnabled !== change.enabled
          : result.configuration.overrides[change.provider] !== change.override)) {
        return invalidCommandResponse(command);
      }
    }
    return result;
  }
  if (
    command.kind === "autorespond-after-hours.status"
    || command.kind === "autorespond-after-hours.enable"
    || command.kind === "autorespond-after-hours.disable"
  ) return autorespondAfterHoursCommandResultSchema.parse(data);
  if (
    command.kind === "notification-email.status"
    || command.kind === "notification-email.enable"
    || command.kind === "notification-email.disable"
  ) return notificationEmailCommandResultSchema.parse(data);
  if (
    command.kind === "notification-hours.status"
    || command.kind === "notification-hours.set"
  ) return notificationHoursCommandResultSchema.parse(data);
  if (command.kind === "work.protocol") return workProtocolDocumentSchema.parse(data);
  if (command.kind === "work.apply") return workOperationResultSchema.parse(data);
  if (command.kind === "work.snapshot") return workSnapshotSchema.parse(data);
  if (command.kind === "work.task") {
    return command.historyLimit !== undefined || command.historyCursor !== undefined
      ? workTaskHistoryPageSchema.parse(data)
      : workTaskDetailSchema.parse(data);
  }
  if (command.kind === "work.poll") return workPollSchema.parse(data);
  if (command.kind === "work.events") return workEventPageSchema.parse(data);
  if (command.kind === "account.login") return publicAccountLoginData(data);
  if (command.kind === "session.task.list") return sessionTaskListSchema.parse(data);
  if (
    command.kind === "session.task.show"
    || command.kind === "session.task.create"
    || command.kind === "session.task.edit"
  ) return sessionTaskRecordSchema.parse(data);
  if (command.kind === "session.task.delete") return sessionTaskDeleteResultSchema.parse(data);
  if (
    command.kind === "session.peer-policy.get"
    || command.kind === "session.peer-policy.set"
  ) return publicPeerSessionPolicySchema.parse(data);
  if (command.kind === "device.list") {
    const parsed = parseCloudDeviceList(data);
    return parsed ?? { currentDevicePublicId: null, devices: [] };
  }
  if (command.kind === "account.usage-history") {
    const parsed = accountUsageHistoryPageSchema.safeParse(data);
    return parsed.success
      ? parsed.data
      : { account: null, range: null, entries: [], nextCursor: null };
  }
  if (command.kind === "session.list") {
    const parsed = publicSessionListPageSchema.safeParse(data);
    if (!parsed.success) {
      return { accountId: null, sessions: [], nextCursor: null };
    }
    const nextCursor = opaqueCursor(parsed.data.nextCursor);
    return {
      ...parsed.data,
      nextCursor: parsed.data.nextCursor === null ? null : nextCursor ?? null,
    };
  }
  if (
    command.kind === "session.show"
    || command.kind === "session.start"
    || command.kind === "session.send"
  ) {
    return projectPublicSessionCommandData(command, data)
      ?? invalidCommandResponse(command);
  }
  if (command.kind === "interaction.show") {
    const record = interactionRecord(data);
    return { interaction: record };
  }
  if (command.kind === "interaction.inspect") {
    const root = object(data);
    const binding = object(root?.binding);
    const protectedOutput = object(root?.protectedOutput);
    const status = protectedOutput?.status === "written"
      && boundedString(protectedOutput.path, 4_096) !== undefined
      && protectedOutput.documentVersion === 1
      && protectedOutput.disposition === "preserved_caller_removes_after_decision"
      ? {
          disposition: "preserved_caller_removes_after_decision" as const,
          documentVersion: 1 as const,
          path: boundedString(protectedOutput.path, 4_096),
          status: "written" as const,
        }
      : protectedOutput?.status === "shown_in_protected_terminal"
        ? { status: "shown_in_protected_terminal" as const }
        : { status: "unavailable" as const };
    return {
      interactionId: boundedString(binding?.interactionId, 64) ?? command.interaction,
      revision: Number.isSafeInteger(binding?.revision) ? binding?.revision : command.expectedRevision,
      protectedOutput: status,
    };
  }
  if (command.kind === "interaction.resolve") {
    const root = object(data);
    return {
      interaction: interactionRecord(data),
      responseWritten: root?.responseWritten === true,
    };
  }
  if (command.kind === "interaction.list" || command.kind === "session.interactions") {
    const root = object(data);
    const sessionId = sessionIdSchema.safeParse(root?.sessionId);
    const nextCursor = opaqueCursor(root?.nextCursor);
    return {
      sessionId: sessionId.success ? sessionId.data : null,
      interactions: interactionRecords(data),
      nextCursor: root?.nextCursor === null ? null : nextCursor ?? null,
    };
  }
  if (command.kind === "session.status") {
    const parsed = sessionStatusSchema.safeParse(data);
    return parsed.success ? parsed.data : data;
  }
  if (command.kind === "session.events") return sessionEventPage(data);
  return data;
};

const renderInteractionTable = (data: unknown): string => {
  const records = interactionRecords(data);
  return table(records.map((record) => ({
    state: record.state,
    kind: record.kind,
    summary: record.display.summary,
    deadline: instant(record.deadlineAt),
    revision: record.revision,
    id: record.id,
  })), ["state", "kind", "summary", "deadline", "revision", "id"]);
};

const renderSessionList = (
  command: Extract<LocalCommand, { kind: "session.list" }>,
  data: unknown,
): string => {
  const root = object(data);
  const sessions = Array.isArray(root?.sessions)
    ? root.sessions.filter((value): value is Record<string, unknown> => object(value) !== null)
    : [];
  const accountId = profileIdSchema.safeParse(root?.accountId);
  const metadata = signedOutSessionListMetadataSchema.safeParse(root?.listing);
  const localHeader = metadata.success
    && accountId.success
    && metadata.data.accountSelector === accountId.data
    ? [
        `Codex scope: local-only cache for ${accountId.data}`,
        "Codex freshness: stale; Codex provider not contacted",
        `Codex completeness: ${metadata.data.localCompleteness === "complete" ? "complete local cache" : "partial local cache; more pages available"}; Codex provider completeness unknown`,
        `Sign in to refresh Codex: ${metadata.data.nextCommand}`,
      ]
    : [];
  const tableListing = table(sessions, ["title", "state", "preset", "fastEnabled", "id"]);
  const listing = localHeader.length === 0
    ? tableListing
    : `${localHeader.join("\n")}\n\n${tableListing}`;
  const nextCursor = opaqueCursor(root?.nextCursor);
  if (nextCursor === undefined || !accountId.success) return listing;
  const archived = command.archived ? " --archived" : "";
  return `${listing}\n\nContinue: oompa session list --account ${accountId.data}${archived} --limit ${String(command.limit)} --cursor ${nextCursor}`;
};

const renderSessionTaskList = (data: unknown): string => {
  const listing = sessionTaskListSchema.parse(data);
  const rows = listing.tasks.map((task) => ({
    name: task.name,
    status: task.status,
    every: `${String(task.schedule.minutes)}m`,
    nextDue: task.nextDueAt === null ? "paused" : instant(task.nextDueAt),
    revision: task.revision,
    id: task.id,
  }));
  return [
    `Conversation tasks for ${line(listing.sessionId)}`,
    table(rows, ["name", "status", "every", "nextDue", "revision", "id"]),
  ].join("\n\n");
};

const renderMemoryHead = (label: string, value: unknown): string => {
  const head = object(value);
  if (head === null) return `${label}: none`;
  return `${label}: sequence ${line(head.sequence)}, operation ${line(head.operationSha256)}, digest ${line(head.digest)}`;
};

const renderMemoryStatus = (data: unknown): string => {
  const root = object(data);
  const canonical = object(root?.canonical);
  const working = object(root?.working);
  const unsettled = object(root?.unsettledSubmission);
  if (root === null || canonical === null || working === null) {
    return "Memory status data is unavailable.";
  }
  const rows = [
    `Session: ${line(root.sessionId)}`,
    `Project: ${line(root.projectId)}`,
    `Canonical: ${canonical.initialized === true ? line(canonical.syncState) : "not initialized"}${canonical.frozen === true ? " (frozen)" : ""}`,
    `Canonical physical state: ${line(canonical.physicalState)}`,
    `Canonical identity contract: ${line(canonical.identityContract)}`,
    `Canonical authority: ${line(canonical.authorityDigest)}`,
    `Canonical binding: ${line(canonical.bindingDigest)}`,
    `Canonical revision: ${line(canonical.revision)}`,
    `Canonical diagnostic: ${line(canonical.diagnosticCode)}`,
    renderMemoryHead("Canonical expected head", canonical.expectedHead),
    `Canonical last exchange: ${line(canonical.lastExchangeAt)}`,
    renderMemoryHead("Canonical last exchange head", canonical.lastExchangeHead),
    `Working: ${line(working.state)}${working.epoch === null || working.epoch === undefined ? "" : `, epoch ${line(working.epoch)}`}`,
    `Working binding: ${line(working.bindingDigest)}`,
    `Working owner matches session: ${line(working.ownerMatchesSession)}`,
    renderMemoryHead("Working head", working.head),
  ];
  if (unsettled === null) {
    rows.push("Unsettled submission: none");
  } else {
    rows.push(
      `Unsettled submission: ${line(unsettled.id)} (${line(unsettled.kind)}, ${line(unsettled.state)})`,
      renderMemoryHead("Submission expected head", unsettled.expectedHead),
    );
  }
  return rows.join("\n");
};

const memoryRows = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.flatMap((entry) => {
        const row = object(entry);
        return row === null ? [] : [row];
      })
    : [];

const renderMemoryQuery = (command: Extract<LocalCommand, { kind: "memory.query" }>, data: unknown): string => {
  const root = object(data);
  if (root === null) return "Memory query data is unavailable.";
  const rows = memoryRows(root.rows);
  const output = [
    `Memory ${line(command.value.mode)}: ${String(rows.length)} row${rows.length === 1 ? "" : "s"}`,
    `Scope: ${root.scope === "working" ? "working only" : "working + canonical"}`,
    `Query: ${line(root.queryId)}`,
  ];
  if (command.value.mode === "get") {
    if (rows.length === 0) output.push("No results.");
    for (const row of rows) {
      const provenance = object(row.provenance);
      const chunkIndex = typeof row.chunkIndex === "number" && Number.isSafeInteger(row.chunkIndex)
        ? row.chunkIndex + 1
        : row.chunkIndex;
      output.push(
        "",
        `[${line(row.lane)}] ${line(row.key)} — ${line(row.title)}`,
        `Summary: ${line(row.summary)}`,
        `Provenance: ${line(provenance?.verification)}; record ${line(row.recordSha256)}`,
        `Body chunk ${line(chunkIndex)} of ${line(row.chunkCount)}:`,
        indented(typeof row.bodyChunk === "string" ? row.bodyChunk : ""),
      );
    }
  } else {
    output.push(table(rows.map((row) => ({
      row: row.row,
      lane: row.lane,
      key: row.key,
      title: row.title,
      summary: row.summary,
      verification: object(row.provenance)?.verification,
    })), ["row", "lane", "key", "title", "summary", "verification"]));
  }
  output.push(
    `Continuation: ${line(root.continuation)}`,
    root.scope === "working"
      ? `Canonical: excluded${object(root.canonical)?.frozen === true ? " (frozen)" : ""}`
      : renderMemoryHead("Canonical head", root.canonicalHead),
    renderMemoryHead("Working head", root.workingHead),
  );
  return output.join("\n");
};

const renderMemoryMutation = (
  command: Extract<LocalCommand, { kind: "memory.remember" | "memory.share" }>,
  data: unknown,
): string => {
  const root = object(data);
  const submission = object(root?.submission);
  if (root === null || submission === null) return "Memory mutation data is unavailable.";
  const noun = command.kind === "memory.remember" ? "Remember" : "Share";
  const rows = [
    `${noun}: ${root.ok === true ? "applied" : line(root.code)}${root.replay === true ? " (replay)" : ""}`,
    `Submission: ${line(submission.id)} (${line(submission.state)})`,
    `Idempotency key: ${line(command.idempotencyKey)}`,
    `Idempotency retained until: ${line(root.idempotencyRetainedUntil)}`,
  ];
  if (command.kind === "memory.remember") {
    const page = object(root.page);
    rows.push(
      `Page: ${line(page?.key)}, record ${line(page?.recordSha256)}`,
      renderMemoryHead("Working head", root.workingHead),
    );
  } else {
    const share = object(root.share);
    const conflict = object(root.conflict);
    if (share !== null) {
      rows.push(
        `Shared page: ${line(share.key)}, ${line(share.status)}, record ${line(share.recordSha256)}`,
        renderMemoryHead("Canonical head", root.canonicalHead),
      );
    }
    if (conflict !== null) {
      rows.push(
        `Conflict key: ${line(conflict.key)}`,
        `Canonical record: ${line(conflict.canonicalRecordSha256)}`,
        `Nominated record: ${line(conflict.nominatedRecordSha256)}`,
        renderMemoryHead("Expected canonical head", conflict.expectedHead),
        renderMemoryHead("Actual canonical head", conflict.actualHead),
      );
    }
  }
  if (root.receiptSha256 !== undefined) rows.push(`Receipt: ${line(root.receiptSha256)}`);
  return rows.join("\n");
};

const renderHostedMemory = (
  command: Extract<LocalCommand, { kind: `memory.hosted.${string}` }>,
  data: unknown,
): string => {
  const root = object(data);
  if (root === null) return "Hosted memory data is unavailable.";
  if (command.kind === "memory.hosted.list") {
    const spaces = memoryRows(root.spaces);
    return [
      `Hosted memory spaces: ${String(spaces.length)}`,
      table(spaces, [
        "hostedSpaceId",
        "canonicalSpaceId",
        "attachedProjectId",
        "keyVersion",
        "revision",
      ]),
    ].join("\n");
  }
  const attachment = object(root.attachment);
  if (command.kind === "memory.hosted.create") {
    return [
      `Hosted memory created: ${line(root.hostedSpaceId)}`,
      `Portable canonical space: ${line(root.canonicalSpaceId)}`,
      `Project: ${line(root.projectId)}`,
      `Attachment generation: ${line(attachment?.generation)}`,
      `Idempotency key: ${line(command.idempotencyKey)}`,
      `Replay: ${root.replay === true ? "yes" : "no"}`,
    ].join("\n");
  }
  if (command.kind === "memory.hosted.attach") {
    return [
      `Hosted memory attached: ${line(attachment?.remoteSpaceId)}`,
      `Project: ${line(attachment?.projectId ?? root.projectId)}`,
      `Attachment generation: ${line(attachment?.generation)}`,
    ].join("\n");
  }
  if (command.kind === "memory.hosted.detach") {
    return [
      `Hosted memory detached: ${line(attachment?.remoteSpaceId)}`,
      `Project: ${line(attachment?.projectId ?? root.projectId)}`,
      `Attachment generation: ${line(attachment?.generation)}`,
    ].join("\n");
  }
  return [
    `Hosted memory sync: ${line(root.state)}`,
    `Project: ${line(root.projectId)}`,
    `Operations: ${line(root.operations)}`,
    `Complete: ${root.complete === true ? "yes" : "no"}`,
  ].join("\n");
};

const renderSessionTask = (task: SessionTaskRecord): string => [
  line(task.name),
  "Scope: conversation",
  `Session: ${line(task.sessionId)}`,
  `ID: ${line(task.id)}`,
  `Status: ${task.status}`,
  `Every: ${String(task.schedule.minutes)} minutes`,
  `Revision: ${String(task.revision)}`,
  `Next due: ${task.nextDueAt === null ? "paused" : instant(task.nextDueAt)}`,
  `Created: ${instant(task.createdAt)}`,
  `Updated: ${instant(task.updatedAt)}`,
  "",
  "Prompt",
  indented(task.prompt),
].join("\n");

const notificationWallClock = (minute: number): string => {
  const hour = Math.floor(minute / 60).toString().padStart(2, "0");
  const minuteWithinHour = (minute % 60).toString().padStart(2, "0");
  return `${hour}:${minuteWithinHour}`;
};

const renderNotificationHours = (data: unknown): string => {
  const observation = notificationHoursCommandResultSchema.parse(data);
  return [
    "Notification hours",
    `Range: ${notificationWallClock(observation.policy.startMinute)}-${notificationWallClock(observation.policy.endMinute)}`,
    `Time zone: ${line(observation.policy.timeZone)}`,
    `Current: ${observation.withinHours ? "yes" : "no"}`,
    `Revision: ${String(observation.policy.revision)}`,
    `Observed: ${instant(observation.observedAt)}`,
  ].join("\n");
};

const renderAutorespondAfterHours = (data: unknown): string => {
  const { policy } = autorespondAfterHoursCommandResultSchema.parse(data);
  return [
    "After-hours automatic approval budgets",
    `Local consent: ${policy.enabled ? "enabled" : "disabled"}`,
    `Revision: ${String(policy.revision)}`,
    "Separate consent from notification email and notification hours.",
    "When enabled: eligible protocol approvals outside notification hours may use 6 consecutive, 20 per hour, and 80 per day with proven history.",
    "Otherwise: 3 consecutive, 10 per hour, and 40 per day. Prose always keeps 3/10/40.",
    "No approval categories are widened; session approval modes still apply.",
    "Policy changes never reset counters or refund reservations.",
  ].join("\n");
};

const renderNotificationEmail = (data: unknown): string => {
  const result = notificationEmailCommandResultSchema.parse(data);
  const authority = result.hostedAuthority;
  const deviceConsentCurrent = authority.state === "observed"
    && authority.deviceAuthority !== null
    && result.policy.enabled
    && authority.globalState === "enabled"
    && authority.deviceAuthority.localNotificationPolicyRevision === result.policy.revision
    && authority.deviceAuthority.globalNotificationGeneration
      === authority.globalNotificationGeneration
    && authority.deviceAuthority.consentLeaseUntil > authority.observedAt;
  const hostedLines = authority.state === "not_observed"
    ? [
        "Hosted authority: not observed",
        "No hosted acknowledgement is claimed.",
      ]
    : authority.state === "observed"
      ? [
          `Hosted authority: ${authority.globalState.replace("_", " ")}`,
          `Hosted generation: ${String(authority.globalNotificationGeneration)}`,
          `Hosted observed: ${instant(authority.observedAt)}`,
          ...(authority.deviceAuthority === null
            ? [
                "Device consent: none observed",
                "Device consent current: no",
              ]
            : [
                `Device consent revision: ${String(authority.deviceAuthority.localNotificationPolicyRevision)}`,
                `Device consent generation: ${String(authority.deviceAuthority.globalNotificationGeneration)}`,
                `Device consent current: ${deviceConsentCurrent ? "yes" : "no"}`,
                `Device consent expires: ${instant(authority.deviceAuthority.consentLeaseUntil)}`,
              ]),
        ]
      : authority.state === "acknowledged"
        ? [
            "Hosted invalidation: acknowledged",
            `Acknowledged: ${instant(authority.acknowledgedAt)}`,
            `Consent lease closed: ${instant(authority.consentLeaseUntil)}`,
            "This does not claim recall of any delivery already started.",
          ]
        : [
            "Hosted invalidation: pending",
            `Existing hosted consent expires no later than: ${instant(authority.expiresNoLaterThan)}`,
            "This does not claim recall of any delivery already started.",
          ];
  return [
    "Attention email notifications",
    `Local setting: ${result.policy.enabled ? "enabled" : "disabled"}`,
    `Revision: ${String(result.policy.revision)}`,
    ...hostedLines,
  ].join("\n");
};

const renderInteractionList = (
  command: Extract<LocalCommand, { kind: "interaction.list" | "session.interactions" }>,
  data: unknown,
): string => {
  const listing = renderInteractionTable(data);
  const root = object(data);
  const nextCursor = opaqueCursor(root?.nextCursor);
  if (nextCursor === undefined) return listing;
  const resolvedSession = sessionIdSchema.safeParse(root?.sessionId);
  if (command.kind === "session.interactions" && !resolvedSession.success) return listing;
  if (command.kind === "interaction.list" && command.session !== undefined && !resolvedSession.success) {
    return listing;
  }
  const invocation = command.kind === "session.interactions"
    ? ["oompa", "session", "interactions", resolvedSession.data]
    : [
        "oompa",
        "interaction",
        "list",
        ...(resolvedSession.success ? [resolvedSession.data] : []),
      ];
  if (command.pending) invocation.push("--pending");
  invocation.push("--limit", String(command.limit), "--cursor", nextCursor);
  return `${listing}\n\nContinue: ${invocation.join(" ")}`;
};

const renderInteraction = (record: PublicInteraction): string => {
  const rows = [
    `Interaction ${line(record.id)}`,
    `State: ${line(record.state)}`,
    `Type: ${line(record.kind)}`,
    `Revision: ${String(record.revision)}`,
    `Blocking: ${record.blocking ? "yes" : "no"}`,
    `Session: ${line(record.sessionId)}`,
    `Summary: ${line(record.display.summary)}`,
  ];
  if (record.state === "pending") {
    const remainingMs = record.deadlineAt - Date.now();
    rows.push(
      `Deadline: ${instant(record.deadlineAt)}`,
      remainingMs <= 0
        ? "Remaining: deadline reached; waiting for deterministic expiry"
        : `Remaining: ${duration(remainingMs)}`,
      );
  } else if (record.state === "response_prepared") {
    rows.push("A response is prepared. Do not resubmit it.");
  } else if (record.state === "response_written") {
    rows.push(
      "The response was sent and is awaiting provider acknowledgement. Do not resubmit it.",
    );
  } else {
    rows.push("This interaction is not pending. No response can be submitted.");
  }
  const display = record.display;
  switch (display.kind) {
    case "command_approval":
      rows.push(`Command class: ${line(display.commandClass)}`);
      if (display.reason !== null) rows.push(`Reason: ${line(display.reason)}`);
      if (display.workingDirectory !== null) rows.push(`Directory: ${line(display.workingDirectory)}`);
      if (record.state === "pending") {
        rows.push(`Available decisions: ${display.availableDecisions.join(", ")}`);
        rows.push(`Protected authority: oompa interaction inspect ${record.id} --revision ${String(record.revision)}`);
      }
      break;
    case "file_change_approval":
      if (display.reason !== null) rows.push(`Reason: ${line(display.reason)}`);
      if (display.grantRoot !== null) rows.push(`Grant root: ${line(display.grantRoot)}`);
      if (record.state === "pending") {
        rows.push(
          "Approval disabled: the pinned provider callback did not expose exact affected paths or change detail.",
          `Safe decisions: ${display.availableDecisions.filter((decision) => decision === "decline" || decision === "cancel").join(", ") || "wait for expiry"}`,
        );
      }
      break;
    case "permission_approval":
      if (display.reason !== null) rows.push(`Reason: ${line(display.reason)}`);
      rows.push(`Permissions: ${display.requested.length === 0 ? "none" : display.requested.map((permission) => line(permission.name)).join(", ")}`);
      if (record.state === "pending") {
        if (display.requested.length === 0) {
          rows.push("No permission category can be granted. Decline this interaction.");
        } else {
          rows.push(`Protected grant document: ${line(JSON.stringify({
            permissions: display.requested.map((permission) => permission.name),
          }))}`);
        }
        rows.push(`Protected authority: oompa interaction inspect ${record.id} --revision ${String(record.revision)}`);
      }
      break;
    case "user_input":
      for (const question of display.questions) {
        rows.push(
          "",
          `${line(question.header)}${question.secret ? " (protected input)" : ""}`,
          `  ID: ${line(question.id)}`,
          `  ${line(question.question)}`,
        );
        if (question.options !== null) {
          rows.push(...question.options.map((option) => `  ${line(option.label)}: ${line(option.description)}`));
        }
      }
      if (record.state === "pending") {
        rows.push("", `Protected answer document: ${line(JSON.stringify({
          answers: Object.fromEntries(display.questions.map((question) => [
            question.id,
            { answers: ["<answer>"] },
          ])),
        }))}`);
      }
      break;
    case "mcp_elicitation":
      rows.push(`Server: ${line(display.serverName)}`, `Mode: ${line(display.mode)}`);
      rows.push("Input: protected");
      if (display.mode === "form") {
        const fields = display.fields;
        if (fields === undefined) {
          rows.push("This MCP request cannot be resolved safely through Oompa.");
          break;
        }
        rows.push(`Fields: ${fields.length === 0 ? "none" : String(fields.length)}`);
        for (const field of fields) {
          const requirement = field.required ? "required" : "optional";
          if (field.type === "string") {
            const format = field.format === null ? "" : `, format ${line(field.format)}`;
            rows.push(`  ${line(field.name)}: string, ${requirement}, ${String(field.minLength)}..${String(field.maxLength)} characters${format}`);
          } else if (field.type === "number" || field.type === "integer") {
            const minimum = field.minimum === null ? "unbounded" : String(field.minimum);
            const maximum = field.maximum === null ? "unbounded" : String(field.maximum);
            rows.push(`  ${line(field.name)}: ${field.type}, ${requirement}, ${minimum}..${maximum}`);
          } else if (field.type === "boolean") {
            rows.push(`  ${line(field.name)}: boolean, ${requirement}`);
          } else if (field.type === "single_select") {
            rows.push(`  ${line(field.name)}: single select, ${requirement}, choices ${field.choices.map(line).join(", ")}`);
          } else {
            const multiSelect = field as Extract<typeof field, { readonly type: "multi_select" }>;
            rows.push(`  ${line(multiSelect.name)}: multi select, ${requirement}, ${String(multiSelect.minItems)}..${String(multiSelect.maxItems)} choices from ${multiSelect.choices.map(line).join(", ")}`);
          }
        }
        if (record.state === "pending") {
          rows.push("Submit one protected JSON document shaped as {\"content\":{...}}.");
        }
      }
      break;
  }
  return rows.join("\n");
};

const renderSessionStatus = (data: unknown): string => {
  const parsed = sessionStatusSchema.safeParse(data);
  if (!parsed.success) return safeJson(data, 2);
  const root = parsed.data;
  const session = root.session;
  const rows = [
    line(session.title),
    `Session: ${line(session.id)}`,
    `Execution: ${line(root.advisory.execution)}`,
    `Attention: ${line(root.advisory.attention)}`,
  ];
  rows.push(
    `Revision: ${String(session.revision)}`,
    `Local: ${root.localObservation.coverage}, ${root.localObservation.freshness}, observed ${instant(root.localObservation.observedAt)}`,
  );
  if (session.activeTurnId !== null) rows.push(`Active turn: ${line(session.activeTurnId)}`);
  const providerObservation = root.providerObservation;
  const providerDetail = providerObservation.state === "live"
    ? `${providerObservation.mode}, connection ${line(providerObservation.connectionId)}`
    : providerObservation.state === "not_applicable"
      ? providerObservation.reason
      : providerObservation.code;
  rows.push(
    `Provider: ${line(providerObservation.state)} (${line(providerDetail)}, basis ${providerObservation.basis}, coverage ${providerObservation.coverage}, freshness ${providerObservation.freshness}, generation ${String(providerObservation.profileGeneration)}, observed ${instant(providerObservation.observedAt)})`,
    `Queue: ${String(root.queue.depth)} pending, ${String(root.queue.dispatchingCount)} dispatching, ${String(root.queue.ambiguousCount)} ambiguous, ${String(root.queue.failedCount)} failed`,
    `Interactions: ${String(root.interactions.pendingCount)} pending, ${String(root.interactions.responseInFlightCount)} response in flight`,
    `Events: through ${String(root.eventStream.observedThroughSequence)}, retained from ${String(root.eventStream.floorSequence)}`,
  );
  if (
    root.advisory.execution === "terminal"
    && providerObservation.state === "not_applicable"
    && providerObservation.reason === "terminal"
  ) {
    rows.push("Next: start a new session; Oompa will not resume or replay this terminal provider thread.");
  }
  if (root.interactions.pending.length > 0) {
    rows.push(
      "",
      "Pending interactions",
      table(root.interactions.pending.map((interaction) => ({
        kind: interaction.kind,
        summary: interaction.summary,
        blocking: interaction.blocking,
        deadline: instant(interaction.deadlineAt),
        revision: interaction.revision,
        id: interaction.id,
      })), ["kind", "summary", "blocking", "deadline", "revision", "id"]),
    );
  }
  if (root.interactions.truncated) {
    rows.push(
      "",
      `More pending interactions: oompa session interactions ${session.id} --pending --limit 100`,
    );
  }
  return rows.join("\n");
};

const recoveryCommand = (intent: RecoveryIntent): string => {
  switch (intent.kind) {
    case "inspect_account": return `oompa account show ${intent.accountId}`;
    case "inspect_session": return `oompa session status ${intent.sessionId}`;
    case "inspect_interaction": return `oompa interaction inspect ${intent.interactionId} --revision ${String(intent.expectedRevision)}`;
    case "show_interaction": return `oompa interaction show ${intent.interactionId}`;
  }
};

const rootAttentionIdentity = (record: RootStatusAttentionRecord): string => {
  if ("interactionId" in record) return record.interactionId;
  if ("sessionId" in record) return record.sessionId;
  return record.accountId;
};

const rootAttentionState = (record: RootStatusAttentionRecord): string => {
  if (record.kind === "interaction_pending" || record.kind === "interaction_response_in_flight") {
    return record.interactionState;
  }
  return record.kind === "account_login_pending"
    ? "login_pending"
    : "recovery_required";
};

const renderRootStatusHuman = (status: RootStatus): string => {
  const counts = status.counts;
  const rows = [
    "Oompa local status",
    `Observed: ${instant(status.localObservation.observedAt)}`,
    `Coverage: local ${status.localObservation.coverage}; provider ${status.providerObservation.coverage}; cloud ${status.cloudObservation.coverage}`,
    `Accounts: ${String(counts.accounts.signedIn)} signed in, ${String(counts.accounts.signedOut)} signed out, ${String(counts.accounts.loginPending)} login pending, ${String(counts.accounts.recoveryRequired)} recovery required`,
    `Sessions: ${String(counts.sessions.active)} active, ${String(counts.sessions.idle)} idle, ${String(counts.sessions.starting)} starting, ${String(counts.sessions.terminal)} terminal, ${String(counts.sessions.recoveryRequired)} recovery required`,
    `Interactions: ${String(counts.interactions.pending)} pending, ${String(counts.interactions.responsePrepared + counts.interactions.responseWritten)} response in flight, ${String(counts.interactions.resolutionUnknown)} resolution unknown`,
    `Queue: ${String(counts.queue.pending)} pending, ${String(counts.queue.dispatching)} dispatching, ${String(counts.queue.ambiguous)} ambiguous, ${String(counts.queue.failed)} failed`,
    `Usage: ${String(counts.usage.observed)} observed, ${String(counts.usage.failed)} latest failures, ${String(counts.usage.missing)} missing`,
    `Devices: registered unknown, online unknown (cloud ${status.cloudObservation.coverage})`,
  ];
  if (status.attention.records.length > 0) {
    rows.push(
      "",
      `Attention (${String(status.attention.total)}${status.attention.truncated ? ", showing first 50" : ""})`,
      table(status.attention.records.map((record) => ({
        kind: record.kind,
        state: rootAttentionState(record),
        id: rootAttentionIdentity(record),
        next: recoveryCommand(record.intent),
      })), ["kind", "state", "id", "next"]),
    );
  } else {
    rows.push("Attention: none");
  }
  return rows.join("\n");
};

export function renderRootStatus(data: unknown, json: boolean, output: Output): void {
  const status = assertRootStatusBound(rootStatusSchema.parse(data));
  if (json) {
    output.writeStdout(`${safeJson({
      ok: true,
      version: 1,
      command: "status",
      data: status,
    })}\n`);
    return;
  }
  output.writeStdout(`${renderRootStatusHuman(status)}\n`);
}

const pluginLifecycleNotice =
  `Lifecycle: discovery only. Pinned Codex ${CODEX_PIN} combines install, enablement, and browser-capable OAuth, so Oompa blocks that compound effect.`;

const renderPluginList = (data: unknown): string => {
  const root = object(data);
  const catalog = object(root?.catalog);
  const marketplaces = Array.isArray(catalog?.marketplaces)
    ? catalog.marketplaces.map(object).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  const rows: Record<string, unknown>[] = [];
  for (const marketplace of marketplaces) {
    const plugins = Array.isArray(marketplace.plugins)
      ? marketplace.plugins.map(object).filter((entry): entry is Record<string, unknown> => entry !== null)
      : [];
    for (const plugin of plugins) {
      rows.push({
        enabled: plugin.enabled,
        installed: plugin.installed,
        auth: plugin.authPolicy,
        name: plugin.displayName ?? plugin.name,
        marketplace: marketplace.displayName ?? marketplace.name,
        id: plugin.id,
      });
    }
  }
  const errorCount = typeof catalog?.marketplaceLoadErrorCount === "number"
    ? catalog.marketplaceLoadErrorCount
    : 0;
  return [
    table(rows, ["enabled", "installed", "auth", "name", "marketplace", "id"]),
    ...(errorCount === 0 ? [] : [`Marketplace load errors: ${String(errorCount)} (details withheld because upstream diagnostics may contain local paths).`]),
    pluginLifecycleNotice,
  ].join("\n\n");
};

const renderPlugin = (data: unknown): string => {
  const root = object(data);
  const plugin = object(root?.plugin);
  const marketplace = object(root?.marketplace);
  if (plugin === null) return safeJson(data, 2);
  const rows = [
    line(plugin.displayName ?? plugin.name ?? plugin.id),
    `ID: ${line(plugin.id)}`,
    `Marketplace: ${line(marketplace?.displayName ?? marketplace?.name)}`,
    `Installed: ${plugin.installed === true ? "yes" : "no"}`,
    `Enabled: ${plugin.enabled === true ? "yes" : "no"}`,
    `Availability: ${line(plugin.availability)}`,
    `Install policy: ${line(plugin.installPolicy)}`,
    `Authorization policy: ${line(plugin.authPolicy)}`,
  ];
  if (typeof plugin.shortDescription === "string") {
    rows.push("", indented(plugin.shortDescription));
  }
  const capabilities = stringArray(plugin.capabilities);
  if (capabilities.length > 0) rows.push(`Capabilities: ${capabilities.map(line).join(", ")}`);
  if (plugin.disabledReason !== null && plugin.disabledReason !== undefined) {
    rows.push(`Unavailable because: ${line(plugin.disabledReason)}`);
  }
  rows.push("", pluginLifecycleNotice);
  return rows.join("\n");
};

const instant = (value: unknown): string => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "unknown time";
  try {
    return new Date(value).toISOString();
  } catch {
    return "unknown time";
  }
};

const maximumHumanDeviceRows = 100;

const deviceLabelBaseScalar = /[\p{L}\p{N}\p{P}\p{S}]/u;
const deviceLabelMarkScalar = /\p{M}/u;

const escapeTerminalScalar = (scalar: string): string =>
  `\\u{${scalar.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}}`;

const terminalSafeDeviceLabel = (value: string): string => {
  const scalars = Array.from(value);
  let hasVisibleBase = false;
  let output = "";
  for (const [index, scalar] of scalars.entries()) {
    if (safeJoinControl.test(scalar)) {
      const hasFollowingBase = scalars
        .slice(index + 1)
        .some((candidate) => deviceLabelBaseScalar.test(candidate));
      output += hasVisibleBase && hasFollowingBase ? scalar : escapeTerminalScalar(scalar);
      continue;
    }
    if (unsafeTerminalScalar.test(scalar)) {
      output += escapeTerminalScalar(scalar);
      continue;
    }
    if (deviceLabelMarkScalar.test(scalar)) {
      output += hasVisibleBase ? scalar : escapeTerminalScalar(scalar);
      continue;
    }
    output += scalar;
    if (deviceLabelBaseScalar.test(scalar)) hasVisibleBase = true;
  }
  return output;
};

const renderDeviceList = (data: unknown): string => {
  const parsed = parseCloudDeviceList(data);
  if (parsed === null) return "Device list data is unavailable.";
  const visible = parsed.devices.slice(0, maximumHumanDeviceRows);
  const hasFallback = visible.some((device) => device.labelSource === "fallback");
  const blocks = visible.map((device, index) => [
    `Device ${String(index + 1)}${device.current ? " (current)" : ""}`,
    `  Label: ${terminalSafeDeviceLabel(device.label)}${device.labelSource === "fallback" ? " [fallback]" : ""}`,
    `  ID: ${device.publicId}`,
    `  Class: ${device.deviceClass}`,
    `  Fingerprint: ${device.fingerprint}`,
    `  Status: ${device.status}`,
    `  Presence: ${device.online
      ? "online"
      : device.lastSeenAt === null
        ? "not seen"
        : `last seen ${instant(device.lastSeenAt)}`}`,
  ].join("\n"));
  const output = [
    `Devices: ${String(visible.length)}${parsed.devices.length > visible.length
      ? ` of ${String(parsed.devices.length)}`
      : ""}`,
    blocks.join("\n\n"),
  ];
  if (parsed.devices.length > visible.length) {
    output.push(
      `${String(parsed.devices.length - visible.length)} additional devices omitted from this bounded view; use --json for the complete list.`,
    );
  }
  if (hasFallback) {
    output.push(
      "Fallback labels use device state and opaque ID because the encrypted label was not authentic under this account key.",
    );
  }
  return output.join("\n\n");
};

const usageVelocity = (value: unknown): string => {
  const velocity = object(value);
  if (velocity?.available === true && typeof velocity.tokensPerMinute === "number") {
    const rate = velocity.tokensPerMinute;
    return `${rate.toLocaleString("en-US", { maximumFractionDigits: rate < 10 ? 2 : 1 })} tokens/min`;
  }
  return typeof velocity?.reason === "string"
    ? `unavailable (${line(velocity.reason)})`
    : "unavailable";
};

const usageLifetimeTokens = (payload: unknown): number | null => {
  const root = object(payload);
  const usage = object(root?.usage);
  const summary = object(usage?.summary);
  return typeof summary?.lifetimeTokens === "number" ? summary.lifetimeTokens : null;
};

const usagePercent = (payload: unknown): number | null => {
  const root = object(payload);
  const primary = object(root?.primary) ?? object(object(root?.rateLimits)?.primary);
  return typeof primary?.usedPercent === "number" ? primary.usedPercent : null;
};

const automaticResetRows = (value: unknown): readonly string[] => {
  const parsed = automaticRateLimitResetStatusSchema.safeParse(value);
  if (!parsed.success) return [];
  const root = parsed.data;
  const rows: string[] = [];
  const threshold = root.threshold;
  rows.push(
    `  automatic reset policy: ${threshold.usedPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}% used (${threshold.remainingPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}% remaining)`,
  );
  const reconciliation = root.policy;
  rows.push(
    reconciliation.state === "active"
      ? "  automatic reset reconciliation: active"
      : reconciliation.state === "reconciliation_required"
        ? "  automatic reset reconciliation: required before automatic resets"
        : `  automatic reset reconciliation: current weekly window suppressed through ${instant(reconciliation.weeklyWindowResetsAt)}`,
  );
  const observation = root.observation;
  if (
    observation.state === "available"
  ) {
    rows.push(
      `  weekly Codex limit: ${observation.usedPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}% used; ${observation.remainingPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}% remaining; resets ${instant(observation.weeklyWindowResetsAt)}`,
    );
    if (typeof observation.creditsAvailable === "number") {
      rows.push(`  reset credits available: ${observation.creditsAvailable.toLocaleString("en-US")}`);
    }
  } else {
    rows.push("  weekly Codex limit: unavailable");
  }
  const lastAttempt = root.lastAttempt;
  if (lastAttempt !== null) {
    const detail = "outcome" in lastAttempt
      ? lastAttempt.outcome
      : "reason" in lastAttempt
        ? lastAttempt.reason
        : lastAttempt.state;
    const label = lastAttempt.state === "settled"
      ? `settled (${detail})`
      : lastAttempt.state === "recovery_pending"
        ? "same-key recovery pending"
        : lastAttempt.state === "retry_pending"
          ? "same-key retry pending"
          : lastAttempt.state === "closed"
            ? `closed (${detail})`
            : lastAttempt.state.replaceAll("_", " ");
    rows.push(
      `  most recent automatic reset attempt: ${line(label)}; source window resets ${instant(lastAttempt.weeklyWindowResetsAt)}`,
    );
  }
  const refresh = root.refresh;
  if (refresh !== undefined) {
    const detail = "outcome" in refresh
      ? refresh.outcome
      : "reason" in refresh
        ? refresh.reason
        : refresh.state;
    const label = refresh.state === "settled"
      ? `settled (${detail})`
      : refresh.state === "recovery_pending"
        ? "same-key recovery pending"
        : refresh.state === "retry_pending"
          ? "same-key retry pending"
          : refresh.state === "suppressed" && refresh.reason === "automatic_policy_disabled"
            ? "suppressed (automatic management is off)"
          : `${refresh.state.replaceAll("_", " ")} (${detail})`;
    rows.push(`  automatic reset refresh: ${line(label)}`);
  }
  return rows;
};

const renderAccountUsageHistory = (
  command: Extract<LocalCommand, { kind: "account.usage-history" }>,
  data: unknown,
): string => {
  const parsed = accountUsageHistoryPageSchema.safeParse(data);
  if (!parsed.success) return "Account usage history data is unavailable.";
  const page = parsed.data;
  const rows = page.entries.map((entry): Record<string, unknown> => entry.state === "observed"
    ? {
        revision: entry.sourceRevision,
        observed: instant(entry.observedAt),
        state: entry.state,
        lifetimeTokens: entry.lifetimeTokens === null
          ? "unavailable"
          : entry.lifetimeTokens.toLocaleString("en-US"),
        gap: entry.gapBefore === null ? "unknown" : entry.gapBefore ? "yes" : "no",
      }
    : {
        revision: entry.sourceRevision,
        observed: instant(entry.observedAt),
        state: entry.state,
        lifetimeTokens: "unavailable",
        gap: entry.reasonCode,
      });
  const body = rows.length === 0
    ? "No usage observations in this range."
    : table(rows, ["revision", "observed", "state", "lifetimeTokens", "gap"]);
  const output = [
    `Usage history for ${line(page.account.label)} (${line(page.account.id)})`,
    `Range: ${instant(page.range.fromObservedAt)} through ${instant(page.range.throughObservedAt)}`,
    "Ordered by durable source revision; provider observation times may be nonmonotonic.",
    "",
    body,
  ];
  const cursor = usageHistoryCursor(page.nextCursor);
  if (cursor !== undefined) {
    output.push(
      "",
      `Continue: oompa account usage-history ${line(page.account.id)} --from ${instant(page.range.fromObservedAt)} --through ${instant(page.range.throughObservedAt)} --limit ${String(command.limit)} --cursor ${cursor}`,
    );
  }
  return output.join("\n");
};

const renderAccountUsage = (data: unknown): string => {
  const root = object(data);
  const usage = !Array.isArray(root?.usage) || root.usage.length === 0
    ? "No account usage observations."
    : root.usage.map((value): string => {
      const entry = object(value);
      const account = object(entry?.account);
      const poll = object(entry?.poll);
      const snapshot = object(entry?.snapshot);
      const velocity = object(entry?.velocity);
      const payload = snapshot?.payload;
      const label = typeof account?.label === "string"
        ? account.label
        : typeof account?.id === "string"
          ? account.id
          : "Unknown account";
      const rows = [line(label)];
      if (poll?.state === "failed") {
        rows.push(`  poll: failed at ${instant(poll.observedAt)} (${line(poll.reasonCode)})`);
      } else if (poll?.state === "observed") {
        rows.push(`  observed: ${instant(poll.observedAt)}`);
      } else {
        rows.push("  observed: never");
      }
      const lifetimeTokens = usageLifetimeTokens(payload);
      if (lifetimeTokens !== null) rows.push(`  lifetime tokens: ${lifetimeTokens.toLocaleString("en-US")}`);
      const resetRows = automaticResetRows(entry?.automaticReset);
      if (resetRows.length > 0) {
        rows.push(...resetRows);
      } else {
        const usedPercent = usagePercent(payload);
        if (usedPercent !== null) rows.push(`  primary limit used: ${usedPercent.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`);
      }
      rows.push(
        `  velocity: 1m ${usageVelocity(velocity?.["1m"])}; 5m ${usageVelocity(velocity?.["5m"])}; 15m ${usageVelocity(velocity?.["15m"])}`,
      );
      return rows.join("\n");
    }).join("\n\n");
  const refresh = object(root?.refresh);
  if (!Array.isArray(refresh?.outcomes)) return usage;
  const outcomes = refresh.outcomes.map((value): string => {
    const outcome = object(value);
    if (outcome === null) return "unknown account: failed (invalid response)";
    const accountId = line(outcome.accountId);
    if (outcome.state === "refreshed") return `${accountId}: refreshed`;
    if (outcome.state === "skipped") {
      return `${accountId}: skipped (${line(outcome.accountState)})`;
    }
    return `${accountId}: failed (${line(outcome.code)})`;
  });
  return [usage, "", "Refresh outcomes", ...outcomes.map((outcome) => `  ${outcome}`)].join("\n");
};

const humanState = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) return "unknown";
  return terminalSafe(value).replaceAll("_", " ");
};

const renderAccountHeader = (account: Record<string, unknown>): string[] => {
  const rows = [
    `Account: ${humanState(account.state)}`,
    `Label: ${line(account.label)}`,
    `ID: ${line(account.id)}`,
  ];
  if (typeof account.providerEmail === "string") rows.push(`Email: ${line(account.providerEmail)}`);
  if (typeof account.providerPlan === "string") rows.push(`Plan: ${line(account.providerPlan)}`);
  if (typeof account.processGeneration === "number") {
    rows.push(`Provider generation: ${line(account.processGeneration)}`);
  }
  if (typeof account.updatedAt === "number") rows.push(`Updated: ${instant(account.updatedAt)}`);
  return rows;
};

const exactAccountCommand = (
  account: Record<string, unknown>,
  action: "login" | "login-cancel",
): string | null => {
  const parsed = profileIdSchema.safeParse(account.id);
  return parsed.success ? `oompa account ${action} ${parsed.data}` : null;
};

const renderAccountAdd = (data: unknown): string => {
  const root = object(data);
  const account = object(root?.account);
  if (account === null) return "Account data is unavailable.";
  const rows = renderAccountHeader(account);
  const next = exactAccountCommand(account, "login");
  if (next !== null && root?.next === next) rows.push(`Next: ${next}`);
  return rows.join("\n");
};

const renderAccountShow = (data: unknown): string => {
  const root = object(data);
  const account = object(root?.account);
  if (account === null) return "Account data is unavailable.";
  if (root?.provider === "devin" && root.status === "retired") {
    const rows = [
      "Devin: retired (local history and login cleanup only)",
      `Label: ${line(account.label)}`,
      `ID: ${line(account.id)}`,
    ];
    if (typeof root.providerGeneration === "number") {
      rows.push(`Provider generation: ${line(root.providerGeneration)}`);
    }
    if (typeof root.diagnostic === "string") rows.push(safeDiagnostic(root.diagnostic));
    const recovery = object(root.recovery);
    if (recovery?.required === true) {
      rows.push("Recovery: required");
      if (typeof recovery.diagnostic === "string") rows.push(`  ${safeDiagnostic(recovery.diagnostic)}`);
      if (typeof recovery.statusCommand === "string") rows.push(`Next: ${line(recovery.statusCommand)}`);
      if (typeof recovery.abandonCommand === "string") {
        rows.push(`Only after confirming the original Devin child exited: ${line(recovery.abandonCommand)}`);
      }
    }
    return rows.join("\n");
  }
  const authentication = object(root?.authentication);
  if (
    authentication?.provider === "claude"
    && (typeof authentication.signedIn === "boolean" || authentication.signedIn === null)
  ) {
    const providerName = "Claude Code";
    const rows = [
      `${providerName}: ${authentication.signedIn === null
        ? "status unknown"
        : authentication.signedIn ? "signed in" : "signed out"}`,
      `Label: ${line(account.label)}`,
      `ID: ${line(account.id)}`,
    ];
    if (typeof root?.providerGeneration === "number") {
      rows.push(`Provider generation: ${line(root.providerGeneration)}`);
    }
    const recovery = object(root?.recovery);
    if (recovery?.required === true) {
      rows.push("Recovery: required");
      if (typeof recovery.diagnostic === "string") rows.push(`  ${safeDiagnostic(recovery.diagnostic)}`);
      if (typeof recovery.statusCommand === "string") rows.push(`Next: ${line(recovery.statusCommand)}`);
      if (typeof recovery.abandonCommand === "string") {
        rows.push(`Only after confirming the original ${providerName} child exited: ${line(recovery.abandonCommand)}`);
      }
    } else if (authentication.signedIn === false && typeof root?.nextCommand === "string") {
      rows.push(`Next: ${line(root.nextCommand)}`);
    }
    return rows.join("\n");
  }
  const rows = renderAccountHeader(account);
  const provider = object(root?.providerProjection);
  if (typeof provider?.signedIn === "boolean") {
    rows.push(`Provider: ${provider.signedIn ? "signed in" : "signed out"}`);
  }
  const recovery = object(root?.recovery);
  if (recovery?.required === true) {
    rows.push("Recovery: required");
    if (typeof recovery.diagnostic === "string") {
      rows.push(`  ${safeDiagnostic(recovery.diagnostic)}`);
    }
  } else if (recovery?.cleared === true) {
    rows.push(`Recovery: cleared${typeof recovery.resolution === "string" ? ` (${humanState(recovery.resolution)})` : ""}`);
  }
  const login = object(root?.login);
  if (login?.status === "pending") {
    rows.push("Login: pending");
    if (login.recoveryRequired === true) {
      rows.push("Login recovery: required");
      if (typeof login.diagnostic === "string") rows.push(`  ${safeDiagnostic(login.diagnostic)}`);
    } else {
      const cancel = exactAccountCommand(account, "login-cancel");
      if (cancel !== null && login.next === cancel) rows.push(`Next: ${cancel}`);
    }
  } else if (account.state === "signed_out" && recovery?.required !== true) {
    const next = exactAccountCommand(account, "login");
    if (next !== null) rows.push(`Next: ${next}`);
  }
  return rows.join("\n");
};

const renderLastSync = (value: unknown): string => {
  if (value === null) return "Last sync: never";
  const lastSync = object(value);
  if (lastSync === null) return "Last sync: unavailable";
  const counts = [
    typeof lastSync.accountCount === "number" ? `${line(lastSync.accountCount)} accounts` : null,
    typeof lastSync.sessionCount === "number" ? `${line(lastSync.sessionCount)} sessions` : null,
    typeof lastSync.usageSnapshotCount === "number"
      ? `${line(lastSync.usageSnapshotCount)} usage snapshots`
      : null,
  ].filter((entry): entry is string => entry !== null);
  return `Last sync: ${instant(lastSync.at)}${counts.length === 0 ? "" : ` (${counts.join(", ")})`}`;
};

const exactDevicePublicId = (value: unknown): string | null =>
  typeof value === "string" && /^device_[A-Za-z0-9_-]{24}$/u.test(value)
    ? value
    : null;

const renderCloudDevice = (root: Record<string, unknown>): string[] => {
  if (root.automaticRegistrationPending === true) return ["Device: registration pending"];
  const device = object(root.device);
  if (device === null) return root.device === null ? ["Device: none"] : [];
  const deviceId = exactDevicePublicId(device.publicId) ?? undefined;
  return [
    `Device: ${typeof device.status === "string" ? humanState(device.status) : "known locally"}${deviceId === undefined ? "" : ` (${line(deviceId)})`}`,
  ];
};

const authoritativeAccountKeyStatus = (
  root: Record<string, unknown>,
): AccountKeyStatus | null => parseAccountKeyStatus(root.accountKey);

const renderAccountKeyStatus = (root: Record<string, unknown>): string[] => {
  const accountKey = authoritativeAccountKeyStatus(root);
  if (accountKey === null) {
    return Object.hasOwn(root, "accountKey") && root.accountKey !== null
      ? ["Account key: invalid status"]
      : [];
  }
  if (accountKey.status === "ready") {
    return [`Account key: ready (version ${line(accountKey.keyVersion)})`];
  }
  if (accountKey.status === "pairing_required") {
    return [
      "Account key: pairing required",
      "Recovery: an existing account-key holder must pair this device.",
      "Local Codex data: unaffected.",
      "No existing key holder: oompa device key-loss --acknowledge-no-key-holders",
    ];
  }
  return [
    "Account key: unrecoverable (operator confirmed no key holders)",
    "Local Codex data: unaffected.",
    "Existing encrypted cloud content: cannot be decrypted.",
    "Recovery: search again for an existing account-key holder, then pair the real key.",
    "Fallback: erase and reinitialize the Oompa cloud account only after that renewed holder search is exhausted. The lost account key cannot be regenerated.",
  ];
};

const renderCloudNextAction = (root: Record<string, unknown>): string | null => {
  if (root.configured !== true) {
    return typeof root.diagnostic === "string" && root.unavailability !== "disabled"
      ? "oompa doctor"
      : null;
  }
  if (object(root.deletion) !== null) return null;
  if (root.signedIn !== true) return "oompa auth login --input-stdin";
  if (root.automaticRegistrationPending === true) return "oompa device pair";
  const device = object(root.device);
  if (device?.status === "pending") {
    const deviceId = exactDevicePublicId(device.publicId);
    return deviceId === null
      ? "oompa device list"
      : `on an active device, run oompa device approve ${deviceId}`;
  }
  const accountKey = authoritativeAccountKeyStatus(root);
  if (accountKey?.status === "unrecoverable") return "oompa device pair";
  if (accountKey?.status === "pairing_required") return "oompa device pair";
  if (Object.hasOwn(root, "accountKey") && root.accountKey !== null && accountKey === null) {
    return "oompa doctor";
  }
  if (
    device?.status === "revoked"
    || (!Object.hasOwn(root, "accountKey") && root.pairingRequired === true)
  ) return "oompa device pair";
  return null;
};

const renderDeletion = (deletion: Record<string, unknown>): string[] => {
  const rows = [`Hosted deletion: ${humanState(deletion.state)}`];
  if (typeof deletion.category === "string") rows.push(`Deletion stage: ${humanState(deletion.category)}`);
  if (typeof deletion.updatedAt === "number") rows.push(`Deletion updated: ${instant(deletion.updatedAt)}`);
  if (deletion.statusFresh === false) rows.push("Deletion status: last known state; refresh unavailable");
  return rows;
};

const renderAuthStatus = (data: unknown): string => {
  const root = object(data);
  if (root === null) return "Cloud account data is unavailable.";
  const deletion = object(root.deletion);
  const state = root.configured !== true
    ? "unavailable"
    : deletion !== null
      ? `deletion ${humanState(deletion.state)}`
      : root.signedIn === true
        ? "signed in"
        : "signed out";
  const rows = [`Cloud account: ${state}`];
  if (typeof root.email === "string") rows.push(`Email: ${line(root.email)}`);
  rows.push(...renderCloudDevice(root));
  if (root.signedIn === true) rows.push(...renderAccountKeyStatus(root));
  if (deletion !== null) rows.push(...renderDeletion(deletion));
  if (Object.hasOwn(root, "lastSync")) rows.push(renderLastSync(root.lastSync));
  if (typeof root.diagnostic === "string") rows.push(`Detail: ${safeDiagnostic(root.diagnostic)}`);
  const next = renderCloudNextAction(root);
  if (next !== null) rows.push(`Next: ${next}`);
  return rows.join("\n");
};

const renderAccountKeyLossAcknowledgement = (data: unknown): string => {
  const root = object(data);
  if (root === null) return "Account-key loss acknowledgement data is unavailable.";
  const accountKey = authoritativeAccountKeyStatus(root);
  if (accountKey?.status === "ready") {
    return [
      "Account-key loss acknowledgement: superseded by the real account key.",
      ...renderAccountKeyStatus(root),
    ].join("\n");
  }
  if (accountKey?.status !== "unrecoverable") {
    return "Account-key loss acknowledgement data is invalid.";
  }
  return [
    `Account-key loss acknowledgement: ${root.replay === true ? "already recorded locally" : "recorded locally"}.`,
    ...renderAccountKeyStatus(root),
    "No account key, device key, or ciphertext was minted, replaced, or deleted.",
    "Next: oompa device pair",
  ].join("\n");
};

const renderProjectionStatus = (root: Record<string, unknown>): string[] => {
  const cache = object(root.projectionCache);
  const rows: string[] = [];
  if (cache !== null) {
    rows.push(`Projection cache: ${humanState(cache.state)}${typeof cache.code === "string" ? ` (${line(cache.code)})` : ""}`);
    if (typeof cache.sessions === "number") rows.push(`Projection sessions needing recovery: ${line(cache.sessions)}`);
    const affectedSessions = Array.isArray(cache.affectedSessions)
      ? cache.affectedSessions
        .map((value) => sessionIdSchema.safeParse(value))
        .filter((result): result is { success: true; data: string } => result.success)
        .map((result) => result.data)
        .slice(0, 20)
      : [];
    for (const sessionId of affectedSessions) rows.push(`  Recover: ${sessionId}`);
    if (cache.affectedSessionsTruncated === true) {
      rows.push("  Additional recovery sessions are omitted from this bounded view.");
    }
    if (typeof cache.diagnostic === "string") rows.push(`Projection detail: ${safeDiagnostic(cache.diagnostic)}`);
  }
  const recovery = object(root.projectionRecovery);
  const recoveries = Array.isArray(recovery?.recoveries)
    ? recovery.recoveries.map(object).filter((entry): entry is Record<string, unknown> => entry !== null)
    : [];
  if (recoveries.length > 0) {
    const phases = new Map<string, number>();
    for (const entry of recoveries) {
      const phase = humanState(entry.phase);
      phases.set(phase, (phases.get(phase) ?? 0) + 1);
    }
    const totalRecoveries = typeof recovery?.totalRecoveries === "number"
      && Number.isSafeInteger(recovery.totalRecoveries)
      && recovery.totalRecoveries >= recoveries.length
      ? recovery.totalRecoveries
      : recoveries.length;
    const count = recovery?.recoveriesTruncated === true && totalRecoveries > recoveries.length
      ? `${String(recoveries.length)} of ${String(totalRecoveries)} shown`
      : String(recoveries.length);
    rows.push(`Projection recoveries: ${count} (${[...phases].map(([phase, phaseCount]) => `${phase} ${String(phaseCount)}`).join(", ")})`);
  }
  return rows;
};

const renderSyncCadence = (root: Record<string, unknown>): string[] => {
  const cadence = object(root.syncCadence);
  if (cadence === null) return [];
  const intervalMs = cadence.intervalMs;
  if (typeof intervalMs !== "number" || !Number.isSafeInteger(intervalMs) || intervalMs < 0) {
    return [];
  }
  const seconds = Math.round(intervalMs / 100) / 10;
  const wake = object(cadence.pushWake);
  const wakeState = wake === null ? "unavailable" : humanState(wake.state);
  return [`Sync cadence: every ${String(seconds)}s (${humanState(cadence.reason)}), push wake ${wakeState}`];
};

const projectionRecoveryIsUnsettled = (root: Record<string, unknown>): boolean => {
  const recovery = object(root.projectionRecovery);
  if (!Array.isArray(recovery?.recoveries)) return false;
  return recovery.recoveries.some((value) => {
    const entry = object(value);
    return entry?.phase === "prepared"
      || entry?.phase === "effect_started"
      || (entry?.phase === "applied" && entry.cacheActivated !== true);
  });
};

const firstProjectionRecoverySession = (root: Record<string, unknown>): string | null => {
  const cache = object(root.projectionCache);
  if (!Array.isArray(cache?.affectedSessions)) return null;
  for (const value of cache.affectedSessions.slice(0, 20)) {
    const parsed = sessionIdSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return null;
};

const canonicalUuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const unsettledProjectionRecoveryCommand = (root: Record<string, unknown>): string | null => {
  const recovery = object(root.projectionRecovery);
  if (!Array.isArray(recovery?.recoveries)) return null;
  for (const value of recovery.recoveries.slice(0, 128)) {
    const entry = object(value);
    if (entry === null) continue;
    const unsettled = entry.phase === "prepared"
      || entry.phase === "effect_started"
      || (entry.phase === "applied" && entry.cacheActivated !== true);
    if (!unsettled) continue;
    const session = sessionIdSchema.safeParse(entry.sessionPublicId);
    if (!session.success || typeof entry.idempotencyKey !== "string" || !canonicalUuidV7.test(entry.idempotencyKey)) {
      continue;
    }
    return `oompa sync projection recover ${session.data} --acknowledge-gap --idempotency-key ${entry.idempotencyKey}`;
  }
  return null;
};

const disabledCloudRestartAction = (root: Record<string, unknown>): string | null => {
  if (root.unavailability !== "disabled") return null;
  const reenable = object(root.reenable);
  if (reenable?.kind === "use_hosted_default") {
    return "unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon";
  }
  if (
    reenable?.kind === "restore_bound_deployment"
    && typeof reenable.deploymentUrl === "string"
  ) {
    try {
      const url = new URL(reenable.deploymentUrl);
      const localHttp = url.protocol === "http:"
        && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
      if (
        (url.protocol === "https:" || localHttp)
        && url.username === ""
        && url.password === ""
        && url.pathname === "/"
        && url.search === ""
        && url.hash === ""
        && url.origin === reenable.deploymentUrl
      ) return `set OOMPA_CONVEX_URL to ${safeDiagnostic(reenable.deploymentUrl)}, unset HRA_CONVEX_URL, and restart the daemon`;
    } catch {
      // Keep the static recovery instruction for malformed daemon output.
    }
  }
  return "restore this state root's bound cloud deployment selection and restart the daemon";
};

const renderDoctor = (data: unknown): string => {
  const root = object(data);
  if (root === null) return "Oompa checks returned an invalid local result.";
  const problemsShapeValid = Array.isArray(root.problems)
    && root.problems.every((value) => typeof value === "string");
  const problems = problemsShapeValid
    ? (root.problems as string[]).slice(0, 64)
    : [];
  if (!problemsShapeValid || typeof root.healthy !== "boolean") {
    return "Oompa checks returned an invalid local result.";
  }
  const cloud = object(root.cloud);
  const cloudRestart = cloud === null ? null : disabledCloudRestartAction(cloud);
  const disabledCloudBlock = cloudRestart === null
    ? null
    : `Cloud sync: disabled (optional)\nNext: ${cloudRestart}`;
  if (root.healthy && problems.length === 0) {
    return disabledCloudBlock === null
      ? "Oompa checks passed."
      : `Oompa checks passed.\n${disabledCloudBlock}`;
  }
  const summary = problems.length === 0
    ? "Oompa checks did not pass, but no safe diagnostic was available."
    : `Oompa checks found ${String(problems.length)} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((problem) => `- ${line(problem)}`).join("\n")}`;
  return disabledCloudBlock === null
    ? summary
    : `${summary}\n\n${disabledCloudBlock}`;
};

const renderSyncStatus = (data: unknown): string => {
  const root = object(data);
  if (root === null) return "Cloud sync data is unavailable.";
  const deletion = object(root.deletion);
  const device = object(root.device);
  const projectionCache = object(root.projectionCache);
  const projectionRecoveryUnsettled = projectionRecoveryIsUnsettled(root);
  const projectionRecoverySession = firstProjectionRecoverySession(root);
  const projectionRecoveryCommand = unsettledProjectionRecoveryCommand(root);
  const accountKey = authoritativeAccountKeyStatus(root);
  const state = root.configured !== true
    ? projectionRecoveryUnsettled
      ? "unavailable (projection recovery pending)"
      : "unavailable"
    : deletion !== null
      ? `blocked by account deletion (${humanState(deletion.state)})`
      : root.signedIn !== true
        ? "unavailable (signed out)"
        : root.automaticRegistrationPending === true
          ? "waiting for device registration"
          : device?.status === "pending"
            ? "waiting for device approval"
            : device?.status === "revoked"
              ? "unavailable (device revoked)"
              : accountKey?.status === "unrecoverable"
                ? "unrecoverable (account key)"
                : accountKey?.status === "pairing_required"
                ? "pairing required"
                : !Object.hasOwn(root, "accountKey") && root.pairingRequired === true
                  ? "pairing required"
                : projectionCache?.state === "unavailable"
                  ? "unavailable (projection cache)"
                  : projectionCache?.state === "degraded"
                    ? "degraded (projection cache)"
                    : projectionRecoveryUnsettled
                      ? "recovery required (projection)"
                      : "ready";
  const rows = [
    `Cloud sync: ${state}`,
    ...renderCloudDevice(root),
    ...(root.signedIn === true ? renderAccountKeyStatus(root) : []),
  ];
  if (deletion !== null) rows.push(...renderDeletion(deletion));
  if (Object.hasOwn(root, "lastSync")) rows.push(renderLastSync(root.lastSync));
  rows.push(...renderProjectionStatus(root));
  rows.push(...renderSyncCadence(root));
  if (typeof root.diagnostic === "string") rows.push(`Detail: ${safeDiagnostic(root.diagnostic)}`);
  const projectionNext = projectionRecoveryUnsettled
    ? projectionRecoveryCommand ?? "oompa doctor"
    : projectionCache?.state === "unavailable"
      ? "oompa doctor"
      : projectionCache?.state === "degraded" && projectionRecoverySession !== null
        ? `oompa sync projection recover ${projectionRecoverySession} --acknowledge-gap`
        : projectionCache?.state === "degraded"
          ? "oompa sync status --json"
          : null;
  const disabledRestart = disabledCloudRestartAction(root);
  if (disabledRestart !== null && projectionNext !== null) {
    rows.push(`Recovery prerequisite: ${disabledRestart}.`);
    rows.push(`Next after restart: ${projectionNext}`);
  } else if (disabledRestart !== null) {
    rows.push(`Next: ${disabledRestart}`);
  } else {
    const next = renderCloudNextAction(root)
      ?? projectionNext
      ?? (state === "ready" && root.lastSync === null ? "oompa sync now" : null);
    if (next !== null) rows.push(`Next: ${next}`);
  }
  return rows.join("\n");
};

export function renderSuccess(command: LocalCommand, data: unknown, json: boolean, output: Output): void {
  assertCommandSuccessData(command, data);
  // Both render modes consume this exact projection. JSON cannot bypass the
  // human renderer's privacy boundary, and human fallback output cannot dump
  // an internal daemon record that JSON would have stripped.
  const publicData = publicInteractionData(command, data);
  if (json) {
    if (command.kind === "work.apply") {
      output.writeStdout(`${safeJson(workAgentProtocolResponseSchema.parse({
        protocol: WORK_PROTOCOL,
        version: command.requestVersion ?? WORK_APPLY_REQUEST_LEGACY_VERSION,
        requestId: command.requestId,
        ok: true,
        result: publicData,
      }))}\n`);
      return;
    }
    if (
      command.kind === "work.snapshot"
      || command.kind === "work.task"
      || command.kind === "work.poll"
      || command.kind === "work.events"
    ) {
      const line = workReadSuccessWireDocument(command.kind, publicData);
      const maximum = command.kind === "work.snapshot"
        ? WORK_SNAPSHOT_MAX_BYTES
        : command.kind === "work.task"
          ? command.historyLimit !== undefined || command.historyCursor !== undefined
            ? WORK_TASK_HISTORY_PAGE_MAX_BYTES
            : WORK_TASK_DETAIL_MAX_BYTES
          : command.kind === "work.poll"
            ? WORK_POLL_MAX_BYTES
            : WORK_EVENT_PAGE_MAX_BYTES;
      if (Buffer.byteLength(line, "utf8") > maximum) invalidCommandResponse(command);
      output.writeStdout(line);
      return;
    }
    output.writeStdout(`${safeJson({
      ok: true,
      version: 1,
      command: command.kind,
      data: publicData,
    })}\n`);
    return;
  }
  const value = publicData as Record<string, unknown>;
  if (command.kind === "usage.auto.status" || command.kind === "usage.auto.set") {
    const result = automaticUsagePolicyCommandResultSchema.parse(publicData);
    const lines = [
      `Automatic usage policy ${command.kind === "usage.auto.set" ? "receipt" : "status"}, revision ${String(result.configuration.automaticPolicyRevision)}.`,
      `Inherited default: ${result.configuration.defaultEnabled ? "on" : "off"}. Provider overrides take precedence.`,
      ...result.effective.map((entry) => `${entry.provider}: ${entry.enabled ? "on" : "off"} (${entry.source === "default"
        ? "inherits default" : `override ${result.configuration.overrides[entry.provider]}`}).`),
    ];
    if (command.kind === "usage.auto.set") {
      lines.push("This is the saved receipt. Run `oompa usage auto status` for the current policy.");
    }
    output.writeStdout(`${lines.join("\n")}\n`);
  } else if (command.kind === "doctor") {
    output.writeStdout(`${renderDoctor(data)}\n`);
  } else if (command.kind === "account.login") {
    const login = object(value.login);
    const handoff = object(login?.handoff);
    if (login?.status === "signed_in") {
      output.writeStdout("The account is signed in.\n");
    } else if (login?.status === "settled") {
      output.writeStdout("This login is settled and the account is signed out. Start a fresh login if access is still needed.\n");
    } else if (handoff?.status === "written") {
      output.writeStdout(`Login instructions were written to ${line(handoff.path)}. The caller must remove the file after login.\n`);
    } else if (handoff?.status === "shown_in_protected_terminal") {
      output.writeStdout("Login instructions were shown in the protected foreground terminal.\n");
    } else if (handoff?.status === "unavailable_on_replay") {
      output.writeStdout("Login is pending, but one-time instructions are unavailable on same-key replay. Cancel this login before starting a fresh one.\n");
    } else {
      output.writeStdout("Login state is unavailable.\n");
    }
  } else if (command.kind === "account.list" && command.provider !== undefined) {
    const result = providerAccountListResultSchema.parse(publicData);
    const rows = result.accounts.map((account) => ({
      order: account.orderPosition,
      label: account.label,
      cachedReadiness: account.readiness,
      observedAt: account.readinessObservedAt === null ? "unknown" : instant(account.readinessObservedAt),
      active: account.active ? "yes" : "no",
      id: account.id,
      profileId: account.profileId,
    }));
    output.writeStdout(`${[
      `Provider accounts: ${result.provider} (cached).`,
      "Readiness is last observed state, not current usage or quota. No provider refresh was requested.",
      `Order revision: ${String(result.orderRevision)}. Pointer revision: ${String(result.pointerRevision)}.`,
      `Active provider account: ${result.activeProviderAccountId ?? "none"}.`,
      table(rows, ["order", "label", "cachedReadiness", "observedAt", "active", "id", "profileId"]),
    ].join("\n")}\n`);
  } else if (command.kind === "account.list" && Array.isArray(value.accounts)) {
    output.writeStdout(`${table(value.accounts as Record<string, unknown>[], ["label", "state", "providerPlan", "id"])}\n`);
  } else if (command.kind === "account.add") {
    output.writeStdout(`${renderAccountAdd(data)}\n`);
  } else if (command.kind === "account.show") {
    output.writeStdout(`${renderAccountShow(data)}\n`);
  } else if (command.kind === "project.list" && Array.isArray(value.projects)) {
    output.writeStdout(`${table(value.projects as Record<string, unknown>[], ["label", "rootPath", "default", "id"])}\n`);
  } else if (command.kind === "memory.status") {
    output.writeStdout(`${renderMemoryStatus(data)}\n`);
  } else if (command.kind.startsWith("memory.hosted.")) {
    output.writeStdout(`${renderHostedMemory(
      command as Extract<LocalCommand, { kind: `memory.hosted.${string}` }>,
      data,
    )}\n`);
  } else if (command.kind === "memory.query") {
    output.writeStdout(`${renderMemoryQuery(command, data)}\n`);
  } else if (command.kind === "memory.explain") {
    output.writeStdout(`Memory explanation for ${line(command.value.queryId)} row ${String(command.value.row)}:\n${safeJson(data, 2)}\n`);
  } else if (command.kind === "memory.remember" || command.kind === "memory.share") {
    output.writeStdout(`${renderMemoryMutation(command, data)}\n`);
  } else if (command.kind === "session.list" && Array.isArray(value.sessions)) {
    output.writeStdout(`${renderSessionList(command, publicData)}\n`);
  } else if (command.kind === "session.task.list") {
    output.writeStdout(`${renderSessionTaskList(publicData)}\n`);
  } else if (
    command.kind === "session.task.show"
    || command.kind === "session.task.create"
    || command.kind === "session.task.edit"
  ) {
    output.writeStdout(`${renderSessionTask(sessionTaskRecordSchema.parse(publicData))}\n`);
  } else if (command.kind === "session.task.delete") {
    const deleted = sessionTaskDeleteResultSchema.parse(publicData);
    output.writeStdout(
      `Deleted conversation task ${line(deleted.taskId)} from ${line(deleted.sessionId)} at ${instant(deleted.deletedAt)} (revision ${String(deleted.revision)}).\n`,
    );
  } else if (command.kind === "session.show") {
    output.writeStdout(`${renderSession(publicData)}\n`);
  } else if (command.kind === "session.status") {
    output.writeStdout(`${renderSessionStatus(data)}\n`);
  } else if (command.kind === "session.state") {
    const report = sessionStateReportSchema.parse(data);
    output.writeStdout(report.state === null
      ? "State: not classified yet.\n"
      : `State: ${line(report.state)}${report.attention ? " (needs you)" : ""}\nReason: ${line(report.reason)}\nRevision: ${String(report.revision)}\n`);
  } else if (
    command.kind === "session.peer-policy.get"
    || command.kind === "session.peer-policy.set"
  ) {
    const policy = publicPeerSessionPolicySchema.parse(publicData);
    output.writeStdout([
      `Peer policy: ${policy.mode}`,
      `Session: ${policy.sessionId}`,
      `Revision: ${String(policy.revision)}`,
      `Updated: ${instant(policy.updatedAt)}`,
    ].join("\n").concat("\n"));
  } else if (command.kind === "autorespond.status" || command.kind === "autorespond.set") {
    const report = value as {
      budgets?: { consecutive: number; lastDay: number; lastHour: number };
      budgetHistoryAvailableAt?: number | null;
      counts?: { accepted: number; refused: number; unknown?: number };
      gateway?: unknown;
      mode?: unknown;
      recent?: unknown[];
      source?: unknown;
    };
    const rows = [`Approval mode: ${line(report.mode)} (${line(report.source)})`];
    // Only the configured/not-configured fact is ever shown for the key.
    if (report.gateway !== undefined) rows.push(`Gateway: ${line(report.gateway)}`);
    if (report.counts !== undefined) {
      rows.push(`Autoresponses: ${String(report.counts.accepted)} accepted, ${String(report.counts.refused)} escalated, ${String(report.counts.unknown ?? 0)} unknown`);
    }
    if (report.budgets !== undefined) {
      rows.push(`Budgets: ${String(report.budgets.consecutive)} consecutive, ${String(report.budgets.lastHour)} this hour, ${String(report.budgets.lastDay)} today`);
    }
    if (typeof report.budgetHistoryAvailableAt === "number") {
      rows.push(`Automatic approvals paused until ${new Date(report.budgetHistoryAvailableAt).toISOString()}: previous budget history is incomplete.`);
    }
    if (Array.isArray(report.recent) && report.recent.length > 0) {
      rows.push(table(report.recent as Record<string, unknown>[], ["occurredAt", "path", "kind", "rule", "decision", "outcome", "model", "sessionId"]));
    }
    output.writeStdout(`${rows.join("\n")}\n`);
  } else if (
    command.kind === "autorespond-after-hours.status"
    || command.kind === "autorespond-after-hours.enable"
    || command.kind === "autorespond-after-hours.disable"
  ) {
    output.writeStdout(`${renderAutorespondAfterHours(data)}\n`);
  } else if (
    command.kind === "notification-email.status"
    || command.kind === "notification-email.enable"
    || command.kind === "notification-email.disable"
  ) {
    output.writeStdout(`${renderNotificationEmail(data)}\n`);
  } else if (
    command.kind === "notification-hours.status"
    || command.kind === "notification-hours.set"
  ) {
    output.writeStdout(`${renderNotificationHours(data)}\n`);
  } else if (
    command.kind === "remote.policy-set"
    || command.kind === "remote.policy-status"
  ) {
    const policy = value as {
      accountLinkingAllowed?: unknown;
      deviceCommandsAllowed?: unknown;
    };
    output.writeStdout([
      `Device commands: ${policy.deviceCommandsAllowed === true ? "allowed" : "denied"}`,
      `Account linking: ${policy.accountLinkingAllowed === true ? "allowed" : "denied"}`,
    ].join("\n").concat("\n"));
  } else if (command.kind === "autorespond.gateway-set") {
    output.writeStdout("Autorespond gateway key configured.\n");
  } else if (command.kind === "autorespond.gateway-clear") {
    output.writeStdout(value.cleared === true
      ? "Autorespond gateway key cleared.\n"
      : "No autorespond gateway key was configured.\n");
  } else if (command.kind === "session.events") {
    const page = sessionEventPage(data);
    output.writeStdout(`${page === null ? "Event page data is unavailable." : renderSessionEventPageHuman(page)}\n`);
  } else if (command.kind === "session.interactions" || command.kind === "interaction.list") {
    output.writeStdout(`${renderInteractionList(command, data)}\n`);
  } else if (command.kind === "interaction.show" || command.kind === "interaction.resolve") {
    const interaction = interactionRecord(data);
    output.writeStdout(`${interaction === null ? "Interaction data is unavailable." : renderInteraction(interaction)}\n`);
  } else if (command.kind === "interaction.inspect") {
    const projected = publicInteractionData(command, data) as {
      protectedOutput?: { path?: unknown; status?: unknown };
    };
    output.writeStdout(projected.protectedOutput?.status === "written"
      ? `Protected approval detail was written to ${line(projected.protectedOutput.path)}. The caller must remove the file after deciding.\n`
      : projected.protectedOutput?.status === "shown_in_protected_terminal"
        ? "Protected approval detail was shown in the foreground terminal.\n"
        : "Protected approval detail is unavailable.\n");
  } else if (command.kind === "session.switch") {
    const from = object(value.from);
    const to = object(value.to);
    const seed = object(value.seed);
    output.writeStdout([
      `Switched ${line(value.sessionId ?? object(value.session)?.id)} from ${line(from?.provider)} (${line(from?.preset)}) to ${line(to?.provider)} (${line(to?.preset)}).`,
      `Account: ${line(from?.account)} to ${line(to?.account)}.`,
      seed?.delivered === false
        ? `Handoff summary was NOT delivered (${line(seed.failureCode)}). Send it again with \`oompa session send\`.`
        : `Handoff summary: ${line(seed?.includedRecords)} records sent, ${line(seed?.omittedRecords)} omitted.`,
      "The new provider has Oompa's record of the conversation, not the old provider's thread or cached context.",
    ].join("\n").concat("\n"));
  } else if (command.kind === "session.note.get") {
    output.writeStdout(`${line(value.note)}\n`);
  } else if (command.kind === "daemon.status") {
    output.writeStdout(value.running === true ? `Oompa daemon is running (pid ${line(value.pid)}).\n` : "Oompa daemon is stopped.\n");
  } else if (command.kind === "daemon.stop") {
    output.writeStdout(value.released === true ? "Oompa daemon stopped.\n" : "Oompa daemon is already stopped.\n");
  } else if (command.kind === "account.claude-login.abandon") {
    output.writeStdout("Released the exact local Claude login fence. Oompa did not stop Claude or change or delete Claude credentials; use a fresh idempotency key for another login.\n");
  } else if (command.kind === "account.login-cancel") {
    if (value.status === "signed_in") {
      output.writeStdout("The account completed sign-in before cancellation.\n");
    } else if (value.status === "already_settled") {
      output.writeStdout("No login is pending for this account.\n");
    } else {
      output.writeStdout(`Canceled the pending login (${line(value.providerStatus)}). You can start a fresh login now.\n`);
    }
  } else if (command.kind === "account.usage-history") {
    output.writeStdout(`${renderAccountUsageHistory(command, data)}\n`);
  } else if (command.kind === "account.usage") {
    output.writeStdout(`${renderAccountUsage(data)}\n`);
  } else if (command.kind === "plugin.list") {
    output.writeStdout(`${renderPluginList(data)}\n`);
  } else if (command.kind === "plugin.show") {
    output.writeStdout(`${renderPlugin(data)}\n`);
  } else if (command.kind === "device.list") {
    output.writeStdout(`${renderDeviceList(data)}\n`);
  } else if (command.kind === "device.key-loss") {
    output.writeStdout(`${renderAccountKeyLossAcknowledgement(data)}\n`);
  } else if (command.kind === "auth.status") {
    output.writeStdout(`${renderAuthStatus(data)}\n`);
  } else if (command.kind === "sync.status") {
    output.writeStdout(`${renderSyncStatus(data)}\n`);
  } else {
    output.writeStdout(`${safeJson(publicData, 2)}\n`);
  }
}

const failureNextCommand = (details: unknown): string | null => {
  const value = object(details);
  if (
    Object.keys(value ?? {}).length === 1
    && (value?.nextCommand === "oompa daemon status --json"
      || value?.nextCommand === "oompa doctor --offline"
      || value?.nextCommand === "oompa init --yes"
      || value?.nextCommand === "oompa auth login --input-stdin"
      || value?.nextCommand === "oompa auth status"
      || value?.nextCommand === "oompa device pair"
      || value?.nextCommand === "oompa sync status --json")
  ) {
    return value.nextCommand;
  }
  if (
    value !== null
    && Object.keys(value).length === 3
    && Object.hasOwn(value, "nextCommand")
    && Object.hasOwn(value, "authorityPhase")
    && Object.hasOwn(value, "stopRequestState")
    && value.nextCommand === "oompa doctor --offline"
    && (((value.authorityPhase === "preflight_receipt" || value.authorityPhase === "preflight_inspection")
      && value.stopRequestState === "not_attempted")
    || (value.authorityPhase === "stop_request" && value.stopRequestState === "attempted")
    || (value.authorityPhase === "release_confirmation"
      && (value.stopRequestState === "attempted" || value.stopRequestState === "acknowledged")))
  ) {
    return "oompa doctor --offline";
  }
  if (
    value?.nextCommand === "oompa doctor"
    && value.repair === "repair_or_select_project"
    && Object.keys(value).length === 2
  ) {
    return "oompa doctor";
  }
  if (value?.accountState !== "signed_out" || typeof value.nextCommand !== "string") {
    return null;
  }
  const prefix = "oompa account login ";
  if (!value.nextCommand.startsWith(prefix)) return null;
  const claudeSuffix = " --provider claude";
  const claude = value.provider === "claude"
    && Object.keys(value).length === 4
    && value.nextCommand.endsWith(claudeSuffix);
  const selector = value.nextCommand.slice(
    prefix.length,
    claude ? -claudeSuffix.length : undefined,
  );
  const parsed = profileIdSchema.safeParse(selector);
  const expected = parsed.success
    ? `${prefix}${parsed.data}${claude ? claudeSuffix : ""}`
    : null;
  if (!parsed.success || value.nextCommand !== expected) return null;
  return value.accountSelector === parsed.data ? value.nextCommand : null;
};

export function renderFailure(error: { code: string; message: string; details?: unknown; trustedLocalPaths?: boolean }, json: boolean, output: Output): number {
  const safeError = {
    code: error.code,
    message: error.code === "INTERNAL"
      ? "Oompa could not complete the request safely."
      : safeDiagnostic(error.message),
    ...(error.code === "INTERNAL" || error.details === undefined
      ? {}
      : { details: safeDiagnosticDetails(error.details, 0, error.trustedLocalPaths === true) }),
  };
  if (json) {
    const document = (errorValue: typeof safeError): string =>
      `${safeJson({ ok: false, version: 1, error: errorValue })}\n`;
    let line = document(safeError);
    if (Buffer.byteLength(line, "utf8") > WORK_STREAM_FAILURE_MAX_BYTES) {
      line = document({ code: safeError.code, message: safeError.message });
    }
    if (Buffer.byteLength(line, "utf8") > WORK_STREAM_FAILURE_MAX_BYTES) {
      line = document({
        code: "INTERNAL",
        message: "Oompa could not serialize a bounded failure response safely.",
      });
    }
    output.writeStdout(line);
  } else {
    output.writeStderr(`oompa: ${safeError.message}\n`);
    if (safeError.details !== undefined) {
      const nextCommand = failureNextCommand(error.details);
      output.writeStderr(nextCommand === null
        ? `${safeJson(safeError.details, 2)}\n`
        : `Next: ${nextCommand}\n`);
    }
  }
  return error.code === "INVALID_INPUT" ? 2 : error.code === "NOT_FOUND" ? 4 : error.code === "INTERACTION_REQUIRED" ? 6 : error.code === "RECOVERY_REQUIRED" ? 7 : error.code === "UNAVAILABLE" ? 5 : 1;
}
