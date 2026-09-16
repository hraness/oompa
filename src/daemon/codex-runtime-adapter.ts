import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";

// eslint-disable-next-line @typescript-eslint/no-restricted-imports -- D4 extracts the provider port; this file is the Codex adapter and loads the pinned runtime.
import {
  CodexError,
  CodexRemoteError,
  IndeterminateCodexEffectError,
  launchPinnedCodexAppServer,
  type CodexAppServerClient,
  type CodexAuthority,
  type CodexFact,
  type OompaHostToolCall,
  type CodexThread,
  type CodexThreadItem,
  type CodexTurn,
  type CodexPluginCatalog,
  type FencedCodexValue,
  type DynamicToolPublicResult,
  type ResolvedPreset,
  type ThreadStartResult,
} from "../codex/index";
import {
  PROTECTED_PROVIDER_TEXT_MARKER,
  replaceCodexDesktopHeartbeatEnvelope,
  replaceCodexDesktopHeartbeatTitle,
} from "../domain/codex-heartbeat-envelope";
import type { PreparedAttachment } from "../domain/attachments";
import { codexProviderAccountIdSchema } from "../domain/provider-accounts";
import { OOMPA_SESSION_PREAMBLE_TEXT } from "../domain/oompa-preamble";
import {
  assertPresetSupportedByProvider,
  type Preset,
  type PresetRequirement,
} from "../domain/presets";
import { redactAbsolutePaths } from "../domain/text-safety";
import type { EffectiveRuntimeProfile } from "../domain/runtime-profile";
import { redactCompleteSensitiveText } from "../sensitive-text";
import type {
  InteractionKind,
  InteractionResolution,
  LiveInteractionApprovalAuthority,
  ProviderInteractionAuthority,
} from "../domain/interactions";
import {
  CodexClaimReleaseUnprovenError,
  CodexSessionObservationError,
  type CodexAccountProjection,
  type CodexLoginOutcome,
  type CodexProjectedMessage,
  type CodexRuntimePort,
  type CodexSessionObservation,
  type CodexSessionPage,
  type CodexSessionProjection,
  type CodexTurnSummary,
  type ProfileAuthority,
  type ProjectionTextOmission,
  type RuntimeStartReview,
} from "./ports";
import { compileEffectiveRuntimeProfile } from "./recommended-capabilities";

type RunningClient = {
  authority: ProfileAuthority;
  client: CodexAppServerClient;
  threadItemsListSupport: Map<string, "supported" | "unsupported">;
  sessionObservationFactSequence: number;
  sessionObservationFactByThread: Map<string, number>;
};
type SessionObservationProof =
  | {
      readonly projection: CodexSessionProjection;
      readonly resumed: false;
    }
  | {
      readonly resumed: false;
    }
  | {
      readonly resumed: true;
    };
type SessionObservationEntry = {
  readonly connectionId: string;
  readonly generation: number;
  readonly profileId: string;
  readonly providerThreadId: string;
  readonly startProjection?: CodexSessionProjection;
  readonly task: Promise<SessionObservationProof>;
};
class ResumedThreadMismatchObservationError extends CodexSessionObservationError {
  readonly resumedThreadId: string;

  constructor(resumedThreadId: string) {
    super("thread_mismatch");
    this.resumedThreadId = resumedThreadId;
  }
}
type PendingRuntimeReview = {
  readonly review: RuntimeStartReview;
  readonly running: RunningClient;
  readonly projectRoot: string;
  readonly providerThreadId?: string;
  readonly preset: ResolvedPreset;
  readonly createdAt: number;
};
type DeterministicallyDisconnectedClient = {
  readonly connectionId: string;
  readonly generation: number;
  readonly running: RunningClient;
};
type AccountAuthorityBarrier = {
  readonly authority: ProfileAuthority;
  readonly task: Promise<void>;
  readonly settled: boolean;
};

const sameProfileAuthority = (
  left: ProfileAuthority,
  right: ProfileAuthority,
): boolean => left.id === right.id
  && left.generation === right.generation
  && left.provider === right.provider
  && left.providerAccountId === right.providerAccountId
  && left.bindingGeneration === right.bindingGeneration;

const codexAuthorityOf = (authority: ProfileAuthority): CodexAuthority => {
  if (
    authority.provider !== "codex"
    || !codexProviderAccountIdSchema.safeParse(authority.providerAccountId).success
    || !Number.isSafeInteger(authority.bindingGeneration)
    || authority.bindingGeneration < 1
    || !Number.isSafeInteger(authority.generation)
    || authority.generation < 1
  ) {
    throw new CodexError(
      "AUTHORITY_STALE",
      "The live Codex provider-account authority is invalid.",
    );
  }
  return {
    profileId: authority.id,
    processGeneration: authority.generation,
    provider: "codex",
    providerAccountId: authority.providerAccountId,
    bindingGeneration: authority.bindingGeneration,
  };
};

const sameCodexAuthority = (
  left: Omit<CodexAuthority, "provider"> & { readonly provider: unknown },
  right: CodexAuthority,
): boolean =>
  left.profileId === right.profileId
  && left.processGeneration === right.processGeneration
  && left.provider === right.provider
  && left.providerAccountId === right.providerAccountId
  && left.bindingGeneration === right.bindingGeneration;

const profileAuthorityTombstoneKey = (authority: ProfileAuthority): string =>
  JSON.stringify([
    authority.id,
    authority.generation,
    authority.provider,
    authority.providerAccountId,
    authority.bindingGeneration,
  ]);

const interactionMatchesProfileAuthority = (
  provider: ProviderInteractionAuthority,
  authority: ProfileAuthority,
): boolean => provider.profileId === authority.id
  && provider.processGeneration === authority.generation
  && provider.provider === authority.provider
  && provider.providerAccountId === authority.providerAccountId
  && provider.bindingGeneration === authority.bindingGeneration;

const assertReviewedThreadRuntime = (
  value: ThreadStartResult,
  profile: EffectiveRuntimeProfile,
  projectRoot: string,
): void => {
  const sandbox = value.sandbox;
  const profileMatches = value.activePermissionProfile?.id === profile.permissionProfile;
  const sandboxMatches = sandbox.type === "workspaceWrite"
    && (sandbox.writableRoots.length === 0
      || (sandbox.writableRoots.length === 1 && sandbox.writableRoots[0] === projectRoot));
  const rootsMatch = value.runtimeWorkspaceRoots.length === 1
    && value.runtimeWorkspaceRoots[0] === projectRoot;
  const serviceTierMatches = profile.serviceTier === null
    ? value.serviceTier === null || value.serviceTier === "default"
    : value.serviceTier === profile.serviceTier;
  if (
    value.cwd !== projectRoot
    || value.model !== profile.model
    || value.reasoningEffort !== profile.reasoningEffort
    || !serviceTierMatches
    || value.approvalPolicy !== profile.approvalPolicy
    || value.approvalsReviewer !== profile.reviewMode
    || !profileMatches
    || !sandboxMatches
    || !rootsMatch
    || value.thread.ephemeral
    || value.thread.historyMode !== "paginated"
  ) {
    throw new CodexError(
      "PROTOCOL_ERROR",
      "Codex did not apply the reviewed model, permissions, or workspace policy to the thread.",
    );
  }
};

export type CodexRuntimeObserver = {
  account(authority: ProfileAuthority, account: CodexAccountProjection): void | Promise<void>;
  oompaHostTool?(
    authority: ProfileAuthority,
    call: OompaHostToolCall,
  ): DynamicToolPublicResult | Promise<DynamicToolPublicResult>;
  oompaHostToolResponseWritten?(
    authority: ProfileAuthority,
    call: OompaHostToolCall,
  ): void | Promise<void>;
  fact(authority: ProfileAuthority, fact: CodexFact): void | Promise<void>;
};

const accountProjection = (value: Awaited<ReturnType<CodexAppServerClient["accountRead"]>>["value"]): CodexAccountProjection => {
  if (value.account === null) return { signedIn: false };
  if (value.account.type === "chatgpt") return { signedIn: true, ...(value.account.email === null ? {} : { email: value.account.email }), plan: value.account.planType };
  return { signedIn: true, plan: value.account.type };
};

const threadStatus = (thread: CodexThread): "active" | "idle" | "terminal" =>
  thread.status.type === "active" ? "active" : thread.status.type === "systemError" ? "terminal" : "idle";

const activeTurn = (thread: CodexThread): string | undefined =>
  [...thread.turns].reverse().find((turn) => turn.status === "inProgress")?.id;

const textEncoder = new TextEncoder();
const unsafeTerminalScalar = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const sensitiveProviderTextHint = /(?:auth|cookie|token|key|pass|secret|otp|invite|code|Bearer|Basic|sk[_-]|re[_-]|gh[pousr]|github_pat|xox|AKIA|eyJ|PRIVATE KEY|[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\p{M}])/iu;
const uncPathHint = /\\\\[^\\/\s]/u;

const sanitizeProviderText = (input: string, preserveLineFeeds: boolean): string => {
  const pathReduced = input.includes("/")
    || input.includes(":\\")
    || uncPathHint.test(input)
    ? redactAbsolutePaths(input)
    : input;
  const protectedInput = sensitiveProviderTextHint.test(pathReduced)
    ? redactCompleteSensitiveText(pathReduced, PROTECTED_PROVIDER_TEXT_MARKER)
    : pathReduced;
  let output = "";
  for (const scalar of protectedInput) {
    output += scalar === "\n" && preserveLineFeeds
      ? scalar
      : unsafeTerminalScalar.test(scalar)
        ? "�"
        : scalar;
  }
  return output;
};

const projectTranscriptText = (
  input: string,
  preserveLineFeeds: boolean,
): string => sanitizeProviderText(
  replaceCodexDesktopHeartbeatEnvelope(input),
  preserveLineFeeds,
);

const binaryCompare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const projectPluginCatalog = (catalog: CodexPluginCatalog): CodexPluginCatalog => {
  const safe = (value: string): string => sanitizeProviderText(value, false);
  return assertTransportSafeProjection({
    marketplaces: catalog.marketplaces.map((marketplace) => ({
      name: safe(marketplace.name),
      displayName: marketplace.displayName === null ? null : safe(marketplace.displayName),
      plugins: marketplace.plugins.map((plugin) => ({
        ...plugin,
        id: safe(plugin.id),
        name: safe(plugin.name),
        displayName: plugin.displayName === null ? null : safe(plugin.displayName),
        shortDescription: plugin.shortDescription === null
          ? null
          : sanitizeProviderText(plugin.shortDescription, true),
        developerName: plugin.developerName === null ? null : safe(plugin.developerName),
        category: plugin.category === null ? null : safe(plugin.category),
        capabilities: plugin.capabilities.map(safe).toSorted(binaryCompare),
        keywords: plugin.keywords.map(safe).toSorted(binaryCompare),
        eligiblePlanTypes: plugin.eligiblePlanTypes === null
          ? null
          : plugin.eligiblePlanTypes.map(safe).toSorted(binaryCompare),
        version: plugin.version === null ? null : safe(plugin.version),
        localVersion: plugin.localVersion === null ? null : safe(plugin.localVersion),
      })).toSorted((left, right) => binaryCompare(left.id, right.id)),
    })).toSorted((left, right) => binaryCompare(left.name, right.name)),
    featuredPluginIds: catalog.featuredPluginIds.map(safe).toSorted(binaryCompare),
    marketplaceLoadErrorCount: catalog.marketplaceLoadErrorCount,
    lifecycle: catalog.lifecycle,
  });
};

const RECENT_TURN_LIMIT = 24;
const COMPACT_MESSAGES_PER_TURN = 2;
const MESSAGE_LIMIT = RECENT_TURN_LIMIT * COMPACT_MESSAGES_PER_TURN;
const MESSAGE_TEXT_BYTES = 24 * 1024;
const DETAIL_TEXT_BYTES = 8 * 1024;
const SESSION_DETAIL_ITEM_LIMIT = 8;
const INSPECT_ITEM_LIMIT = 64;
const RECENT_TURN_ITEM_PAGE_LIMIT = 8;
const RECENT_TURN_ITEM_AGGREGATE_PAGE_LIMIT = RECENT_TURN_LIMIT * 2;
const RECENT_TURN_ITEM_TAIL_PAGE_LIMIT = RECENT_TURN_LIMIT;
const RECENT_TURN_ITEM_AGGREGATE_LIMIT = (
  RECENT_TURN_ITEM_AGGREGATE_PAGE_LIMIT + RECENT_TURN_ITEM_TAIL_PAGE_LIMIT
) * INSPECT_ITEM_LIMIT;
const RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT = 12 * 1024 * 1024;
const RECENT_TURN_TAIL_ITEM_JSON_BYTE_RESERVE = 8 * 1024 * 1024;
const RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT = (
  RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT - RECENT_TURN_TAIL_ITEM_JSON_BYTE_RESERVE
);
const TURN_SEARCH_PAGE_SIZE = 128;
const TURN_SEARCH_PAGE_LIMIT = 80;
const SUMMARY_FILE_LIMIT = 128;
const SUMMARY_ACTION_LIMIT = 64;
const PROJECTION_JSON_BYTE_LIMIT = 3 * 1024 * 1024;
const SESSION_MESSAGE_JSON_BYTE_BUDGET = 1_250_000;
const TURN_MESSAGE_JSON_BYTE_BUDGET = Math.floor(
  SESSION_MESSAGE_JSON_BYTE_BUDGET / RECENT_TURN_LIMIT,
);
const SESSION_SUMMARY_STRING_JSON_BYTE_BUDGET = 256 * 1024;
const TURN_SUMMARY_STRING_JSON_BYTE_BUDGET = Math.floor(
  SESSION_SUMMARY_STRING_JSON_BYTE_BUDGET / RECENT_TURN_LIMIT,
);
const SESSION_DETAIL_ITEM_JSON_BYTE_BUDGET = 900 * 1024;
const INSPECT_ITEM_JSON_BYTE_BUDGET = 2_500_000;
type ProjectedText = {
  readonly text: string;
  readonly omission?: ProjectionTextOmission;
};

type JsonByteBudget = { remaining: number };

const jsonUtf8Bytes = (value: unknown): number => textEncoder.encode(JSON.stringify(value)).byteLength;

const consumeJsonBudget = (budget: JsonByteBudget, value: unknown): boolean => {
  const bytes = jsonUtf8Bytes(value) + 1;
  if (bytes > budget.remaining) return false;
  budget.remaining -= bytes;
  return true;
};

const assertTransportSafeProjection = <T>(value: T): T => {
  if (jsonUtf8Bytes(value) > PROJECTION_JSON_BYTE_LIMIT) {
    throw new CodexError("PROTOCOL_LIMIT", "The closed Codex projection exceeded its transport-safe byte limit.");
  }
  return value;
};

/** Truncate at Unicode scalar boundaries and report exact UTF-8 byte loss. */
export const projectUtf8Text = (input: string, maxUtf8Bytes: number): ProjectedText => {
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 0) {
    throw new CodexError("INVALID_INPUT", "projection text limit must be a nonnegative integer");
  }
  let text = "";
  let originalUtf8Bytes = 0;
  let returnedUtf8Bytes = 0;
  let accepting = true;
  for (const scalar of input) {
    const safeScalar = scalar.length === 1
      && (scalar.charCodeAt(0) >= 0xD800 && scalar.charCodeAt(0) <= 0xDFFF)
      ? "�"
      : scalar;
    const bytes = textEncoder.encode(safeScalar).byteLength;
    originalUtf8Bytes += bytes;
    if (accepting && returnedUtf8Bytes + bytes <= maxUtf8Bytes) {
      text += safeScalar;
      returnedUtf8Bytes += bytes;
    } else {
      accepting = false;
    }
  }
  if (originalUtf8Bytes === returnedUtf8Bytes) return { text };
  return {
    text,
    omission: {
      originalUtf8Bytes,
      returnedUtf8Bytes,
      omittedUtf8Bytes: originalUtf8Bytes - returnedUtf8Bytes,
    },
  };
};

export const normalizeProviderTitle = (input: string): string => {
  const source = sanitizeProviderText(input, false).trim() || "Untitled session";
  let output = "";
  let bytes = 0;
  for (const scalar of source) {
    const safeScalar = scalar.length === 1
      && (scalar.charCodeAt(0) >= 0xD800 && scalar.charCodeAt(0) <= 0xDFFF)
      ? "�"
      : scalar;
    const size = textEncoder.encode(safeScalar).byteLength;
    if (bytes + size > 320) break;
    output += safeScalar;
    bytes += size;
  }
  return output || "Untitled session";
};

const gitActions = new Set(["add", "branch", "checkout", "cherry-pick", "clone", "commit", "diff", "fetch", "log", "merge", "pull", "push", "rebase", "reset", "restore", "revert", "show", "status", "switch", "tag", "worktree"]);
const bunActions = new Set(["build", "install", "run", "test", "x"]);

export const classifyCommand = (command: string): string => {
  const tokens = command.trim().split(/\s+/u).slice(0, 32);
  const gitIndex = tokens.findIndex((token) => token === "git" || token.endsWith("/git"));
  if (gitIndex >= 0) {
    const action = tokens.slice(gitIndex + 1).find((token) => gitActions.has(token));
    return action === undefined ? "git" : `git ${action}`;
  }
  const bunIndex = tokens.findIndex((token) => token === "bun" || token.endsWith("/bun"));
  if (bunIndex >= 0) {
    const action = tokens.slice(bunIndex + 1).find((token) => bunActions.has(token));
    return action === undefined ? "bun" : `bun ${action}`;
  }
  return "command";
};

const safeRelative = (root: string, path: string): string | null => {
  const value = relative(root, path);
  return value === ""
    ? "."
    : value === ".." || value.startsWith("../") || isAbsolute(value)
      ? null
      : value;
};

const projectItem = (item: CodexThreadItem, root: string): unknown => {
  if (item.type === "userMessage") {
    const content = item.text.slice(0, 16).map((text) =>
      projectUtf8Text(projectTranscriptText(text, true), DETAIL_TEXT_BYTES));
    return {
      type: item.type,
      id: item.id,
      clientId: item.clientId,
      content,
      omittedContent: Math.max(0, item.text.length - content.length),
    };
  }
  if (item.type === "agentMessage") {
    return {
      type: item.type,
      id: item.id,
      ...projectUtf8Text(projectTranscriptText(item.text, true), DETAIL_TEXT_BYTES),
    };
  }
  if (item.type === "reasoning") {
    const summary = item.summary.slice(0, 16).map((text) =>
      projectUtf8Text(projectTranscriptText(text, true), DETAIL_TEXT_BYTES));
    return {
      type: item.type,
      id: item.id,
      summary,
      omittedSummary: Math.max(0, item.summary.length - summary.length),
    };
  }
  if (item.type === "fileChange") {
    const relativePaths = item.changedPaths
      .map((path) => safeRelative(root, path))
      .filter((path): path is string => path !== null);
    return {
      type: item.type,
      id: item.id,
      status: item.status,
      paths: relativePaths.slice(0, SUMMARY_FILE_LIMIT).map((path) => sanitizeProviderText(path, false)),
      omittedPaths: Math.max(0, relativePaths.length - SUMMARY_FILE_LIMIT),
    };
  }
  if (item.type === "commandExecution") {
    const cwd = safeRelative(root, item.cwd);
    return { type: item.type, id: item.id, status: item.status, exitCode: item.exitCode, durationMs: item.durationMs, ...(cwd === null ? {} : { cwd: sanitizeProviderText(cwd, false) }), commandClass: classifyCommand(item.command) };
  }
  if (item.type === "mcpToolCall") return { type: item.type, id: item.id, server: sanitizeProviderText(item.server, false), tool: sanitizeProviderText(item.tool, false), status: item.status, durationMs: item.durationMs };
  // The agent definition path the provider carries on this item is never
  // projected; only the activity kind is inspectable.
  if (item.type === "subAgentActivity") return { type: item.type, id: item.id, kind: item.kind };
  return { type: "unsupported", id: item.id, providerType: sanitizeProviderText(item.providerType, false) };
};

const projectTurn = (
  turn: CodexTurn,
  root: string,
  itemLimit: number,
  providerHasMoreItems = false,
  itemBudget: JsonByteBudget = { remaining: INSPECT_ITEM_JSON_BYTE_BUDGET },
): unknown => {
  const items: unknown[] = [];
  for (const item of turn.items.slice(0, itemLimit)) {
    if (itemBudget.remaining === 0) break;
    const projected = projectItem(item, root);
    if (!consumeJsonBudget(itemBudget, projected)) {
      itemBudget.remaining = 0;
      break;
    }
    items.push(projected);
  }
  return {
    id: turn.id,
    status: turn.status,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    runtimeMs: turn.durationMs,
    items,
    omission: {
      hasMoreItems: providerHasMoreItems,
      omittedLoadedItems: Math.max(0, turn.items.length - items.length),
    },
  };
};

type TurnSummaryMetadata = Pick<
  CodexTurnSummary,
  "files" | "actions" | "omittedFiles" | "omittedActions"
>;

type TurnCompactEssentials = Readonly<{
  firstUser?: CodexProjectedMessage;
  finalAssistant?: CodexProjectedMessage;
}>;

type RecentTurnsHydration = Readonly<{
  turns: readonly CodexTurn[];
  unreadItemTurnIds: ReadonlySet<string>;
  incompleteTurnIds: ReadonlySet<string>;
  summaryMetadataByTurn: ReadonlyMap<string, TurnSummaryMetadata>;
  compactEssentialsByTurn: ReadonlyMap<string, TurnCompactEssentials>;
}>;

type TurnSummaryAccumulator = {
  readonly files: string[];
  readonly actions: string[];
  readonly stringBudget: JsonByteBudget;
  omittedFiles: number;
  omittedActions: number;
  acceptingFiles: boolean;
  acceptingActions: boolean;
};

const createTurnSummaryAccumulator = (): TurnSummaryAccumulator => ({
  files: [],
  actions: [],
  stringBudget: { remaining: TURN_SUMMARY_STRING_JSON_BYTE_BUDGET },
  omittedFiles: 0,
  omittedActions: 0,
  acceptingFiles: true,
  acceptingActions: true,
});

const accumulateTurnSummaryItem = (
  summary: TurnSummaryAccumulator,
  item: CodexThreadItem,
  root: string,
): void => {
    if (item.type === "fileChange") {
      for (const path of item.changedPaths) {
        const projected = safeRelative(root, path);
        if (projected === null) continue;
        const safePath = sanitizeProviderText(projected, false);
        if (
          summary.acceptingFiles
          && summary.files.length < SUMMARY_FILE_LIMIT
          && consumeJsonBudget(summary.stringBudget, safePath)
        ) {
          summary.files.push(safePath);
        } else {
          summary.acceptingFiles = false;
          summary.omittedFiles += 1;
        }
      }
    }
    if (item.type === "commandExecution") {
      const action = classifyCommand(item.command);
      if (
        summary.acceptingActions
        && summary.actions.length < SUMMARY_ACTION_LIMIT
        && consumeJsonBudget(summary.stringBudget, action)
      ) {
        summary.actions.push(action);
      } else {
        summary.acceptingActions = false;
        summary.omittedActions += 1;
      }
    }
};

const finishTurnSummary = (summary: TurnSummaryAccumulator): TurnSummaryMetadata => ({
  files: [...summary.files],
  actions: [...summary.actions],
  omittedFiles: summary.omittedFiles,
  omittedActions: summary.omittedActions,
});

const summarizeTurnItems = (
  items: readonly CodexThreadItem[],
  root: string,
): TurnSummaryMetadata => {
  const summary = createTurnSummaryAccumulator();
  for (const item of items) {
    accumulateTurnSummaryItem(summary, item, root);
  }
  return finishTurnSummary(summary);
};

const projectTurnSummary = (
  turn: CodexTurn,
  root: string,
  metadata: TurnSummaryMetadata = summarizeTurnItems(turn.items, root),
): CodexTurnSummary => {
  return {
    id: turn.id,
    status: turn.status,
    ...(turn.startedAt === null ? {} : { startedAt: turn.startedAt }),
    ...(turn.completedAt === null ? {} : { completedAt: turn.completedAt }),
    ...(turn.durationMs === null ? {} : { runtimeMs: turn.durationMs }),
    ...metadata,
  };
};

const fingerprintThreadItem = (item: CodexThreadItem): string =>
  createHash("sha256").update(JSON.stringify(item)).digest("hex");

const messageWithTextPrefix = (
  message: CodexProjectedMessage,
  text: string,
  originalUtf8Bytes: number,
): CodexProjectedMessage => {
  const returnedUtf8Bytes = textEncoder.encode(text).byteLength;
  return {
    role: message.role,
    text,
    ...(message.turnId === undefined ? {} : { turnId: message.turnId }),
    ...(message.clientId === undefined ? {} : { clientId: message.clientId }),
    ...(returnedUtf8Bytes === originalUtf8Bytes
      ? {}
      : {
          omission: {
            originalUtf8Bytes,
            returnedUtf8Bytes,
            omittedUtf8Bytes: originalUtf8Bytes - returnedUtf8Bytes,
          },
        }),
  };
};

const projectCompactMessage = (
  role: "user" | "assistant",
  text: string,
  turnId: string,
  clientId?: string,
): CodexProjectedMessage => {
  const projected = projectUtf8Text(projectTranscriptText(text, true), MESSAGE_TEXT_BYTES);
  return {
    role,
    text: projected.text,
    turnId,
    ...(clientId === undefined ? {} : { clientId }),
    ...(projected.omission === undefined ? {} : { omission: projected.omission }),
  };
};

const fitMessageToJsonByteLimit = (
  message: CodexProjectedMessage,
  maximumJsonBytes: number,
): CodexProjectedMessage => {
  if (jsonUtf8Bytes(message) + 1 <= maximumJsonBytes) return message;
  const originalUtf8Bytes = message.omission?.originalUtf8Bytes
    ?? textEncoder.encode(message.text).byteLength;
  const scalars = Array.from(message.text);
  const empty = messageWithTextPrefix(message, "", originalUtf8Bytes);
  if (jsonUtf8Bytes(empty) + 1 > maximumJsonBytes) {
    throw new CodexError("PROTOCOL_LIMIT", "compact turn message metadata exceeded its deterministic JSON byte limit");
  }
  let lower = 0;
  let upper = scalars.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const candidate = messageWithTextPrefix(
      message,
      scalars.slice(0, middle).join(""),
      originalUtf8Bytes,
    );
    if (jsonUtf8Bytes(candidate) + 1 <= maximumJsonBytes) lower = middle;
    else upper = middle - 1;
  }
  return messageWithTextPrefix(
    message,
    scalars.slice(0, lower).join(""),
    originalUtf8Bytes,
  );
};

export const projectBoundedThread = (
  thread: CodexThread,
  includeDetail: boolean,
  hasMoreOlderTurns = false,
  turnsWithMoreItems: ReadonlySet<string> = new Set<string>(),
  compactIncompleteTurnIds: ReadonlySet<string> = new Set<string>(),
  stableSummaryMetadataByTurn: ReadonlyMap<string, TurnSummaryMetadata> = new Map(),
  stableCompactEssentialsByTurn: ReadonlyMap<string, TurnCompactEssentials> = new Map(),
): CodexSessionProjection => {
  const turns = thread.turns.slice(-RECENT_TURN_LIMIT);
  const olderTurnsOmitted = hasMoreOlderTurns || turns.length !== thread.turns.length;
  const incompleteTurnIds = new Set(
    turns
      .filter((turn) => compactIncompleteTurnIds.has(turn.id))
      .map((turn) => turn.id),
  );
  const unreadItemTurnIds = new Set(
    turns
      .filter((turn) => turnsWithMoreItems.has(turn.id))
      .map((turn) => turn.id),
  );
  type MessageCandidate = { readonly message: CodexProjectedMessage; readonly sequence: number };
  const firstUserByTurn = new Map<string, MessageCandidate>();
  const finalAssistantByTurn = new Map<string, MessageCandidate>();
  const messages: CodexProjectedMessage[] = [];
  const messageBudget: JsonByteBudget = { remaining: SESSION_MESSAGE_JSON_BYTE_BUDGET };
  const detailItemBudget: JsonByteBudget = { remaining: SESSION_DETAIL_ITEM_JSON_BYTE_BUDGET };
  let totalMessageCandidates = 0;
  let truncatedMessages = 0;
  const addMessage = (role: "user" | "assistant", text: string, turnId: string, clientId?: string): void => {
    const message = projectCompactMessage(role, text, turnId, clientId);
    const candidate = { message, sequence: totalMessageCandidates };
    totalMessageCandidates += 1;
    if (role === "user" && !firstUserByTurn.has(turnId)) firstUserByTurn.set(turnId, candidate);
    if (role === "assistant") finalAssistantByTurn.set(turnId, candidate);
  };
  for (const turn of turns) {
    for (const item of turn.items) {
      if (item.type === "userMessage") {
        for (const text of item.text) {
          addMessage("user", text, turn.id, item.clientId ?? undefined);
        }
      }
      if (item.type === "agentMessage") addMessage("assistant", item.text, turn.id);
    }
  }
  const selectedMessages = turns.flatMap((turn) => {
    // A hydrated proof entry is authoritative even when one side is absent.
    // Falling back to retained tail items could turn a later steer into the
    // turn's first user message after the shared detail budget closes.
    if (stableCompactEssentialsByTurn.has(turn.id)) {
      const stable = stableCompactEssentialsByTurn.get(turn.id);
      if (stable === undefined) {
        throw new CodexError("PROTOCOL_ERROR", "compact turn essentials lost a recent turn");
      }
      return [stable.firstUser, stable.finalAssistant]
        .filter((message): message is CodexProjectedMessage => message !== undefined)
        .map((message, sequence) => ({ message, sequence }));
    }
    return [firstUserByTurn.get(turn.id), finalAssistantByTurn.get(turn.id)]
      .filter((candidate): candidate is MessageCandidate => candidate !== undefined);
  });
  if (selectedMessages.length > MESSAGE_LIMIT) {
    throw new CodexError("PROTOCOL_LIMIT", "essential compact messages exceeded their exact bound");
  }
  const omittedMessages = Math.max(0, totalMessageCandidates - selectedMessages.length);
  for (const turn of turns) {
    const selectedForTurn = selectedMessages.filter((candidate) => candidate.message.turnId === turn.id);
    const turnBudget: JsonByteBudget = { remaining: TURN_MESSAGE_JSON_BYTE_BUDGET };
    for (const [index, candidate] of selectedForTurn.entries()) {
      const following = selectedForTurn[index + 1];
      const reservedForFollowing = following === undefined
        ? 0
        : Math.min(
            jsonUtf8Bytes(following.message) + 1,
            Math.floor(TURN_MESSAGE_JSON_BYTE_BUDGET / COMPACT_MESSAGES_PER_TURN),
          );
      const projected = fitMessageToJsonByteLimit(
        candidate.message,
        turnBudget.remaining - reservedForFollowing,
      );
      if (!consumeJsonBudget(turnBudget, projected) || !consumeJsonBudget(messageBudget, projected)) {
        throw new CodexError("PROTOCOL_LIMIT", "compact turn messages exceeded their deterministic JSON byte budget");
      }
      if (projected.omission !== undefined) truncatedMessages += 1;
      messages.push(projected);
    }
  }
  const summariesByTurn = new Map(turns.map((turn) => [
    turn.id,
    projectTurnSummary(turn, thread.cwd, stableSummaryMetadataByTurn.get(turn.id)),
  ]));
  const turnId = activeTurn(thread);
  return assertTransportSafeProjection({
    providerThreadId: thread.id,
    title: normalizeProviderTitle(
      replaceCodexDesktopHeartbeatTitle(thread.name ?? thread.preview),
    ),
    status: threadStatus(thread),
    projectRoot: thread.cwd,
    providerUpdatedAt: thread.updatedAt,
    ...(thread.providerTimestampUnit === "unix_milliseconds_v1"
      && Number.isSafeInteger(thread.updatedAt) && thread.updatedAt >= 0
      ? { providerTimestampUnit: thread.providerTimestampUnit } : {}),
    ...(turnId === undefined ? {} : { activeTurnId: turnId }),
    messages,
    turnSummaries: turns.map((turn) => {
      const summary = summariesByTurn.get(turn.id);
      if (summary === undefined) throw new CodexError("PROTOCOL_ERROR", "turn summary projection lost a recent turn");
      return summary;
    }),
    omission: {
      hasMoreOlderTurns: olderTurnsOmitted,
      returnedTurns: turns.length,
      turnLimit: RECENT_TURN_LIMIT,
      omittedMessages,
      truncatedMessages,
      unreadItemTurnIds: [...unreadItemTurnIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
      incompleteTurnIds: [...incompleteTurnIds].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
    },
    ...(includeDetail
      ? {
          turns: turns.map((turn) =>
            projectTurn(turn, thread.cwd, SESSION_DETAIL_ITEM_LIMIT, turnsWithMoreItems.has(turn.id), detailItemBudget),
          ),
        }
      : {}),
  });
};

export class PinnedCodexRuntimeManager implements CodexRuntimePort {
  readonly provider = "codex" as const;
  readonly #clients = new Map<string, RunningClient>();
  readonly #lifecycleTails = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #accountRefreshes = new Map<string, AccountAuthorityBarrier>();
  readonly #accountRefreshDirty = new Set<string>();
  readonly #endedAuthorityTombstones = new Set<string>();
  readonly #authorityCloseClients = new Map<string, Readonly<{
    profileId: string;
    client: CodexAppServerClient;
  }>>();
  readonly #authorityCloseTasks = new Map<string, Promise<void>>();
  readonly #deterministicallyDisconnectedByProfile = new Map<
    string,
    DeterministicallyDisconnectedClient
  >();
  readonly #runtimeReviews = new Map<string, PendingRuntimeReview>();
  readonly #sessionObservations = new Map<string, SessionObservationEntry>();
  readonly #operations = new Set<Promise<void>>();
  readonly #isCurrent: (authority: ProfileAuthority) => boolean;
  readonly #observer: CodexRuntimeObserver;
  readonly #launchClient: typeof launchPinnedCodexAppServer;
  readonly #prepareCodexHome: ((codexHome: string) => Promise<void>) | undefined;
  readonly #codexEnvironment: ((
    codexHome: string,
  ) => Promise<Readonly<Record<string, string | undefined>> | undefined>) | undefined;
  readonly #credentialStorePreflight: Readonly<{
    readonly cliAuth: "file";
    readonly cwd: string;
    readonly mcpOauth: "file";
  }>;
  readonly #allowSameGenerationRelaunchAfterProviderDisconnect: boolean;
  readonly #now: () => number;
  #usageRevision = Date.now();
  #state: "open" | "closing" | "closed" = "open";
  #closeTask: Promise<void> | undefined;

  constructor(input: {
    isCurrent: (authority: ProfileAuthority) => boolean;
    observer: CodexRuntimeObserver;
    launchClient?: typeof launchPinnedCodexAppServer;
    prepareCodexHome?: (codexHome: string) => Promise<void>;
    codexEnvironment?: (
      codexHome: string,
    ) => Promise<Readonly<Record<string, string | undefined>> | undefined>;
    credentialStorePreflight: Readonly<{
      readonly cliAuth: "file";
      readonly cwd: string;
      readonly mcpOauth: "file";
    }>;
    allowSameGenerationRelaunchAfterProviderDisconnect?: boolean;
    now?: () => number;
  }) {
    this.#isCurrent = input.isCurrent;
    this.#observer = input.observer;
    this.#launchClient = input.launchClient ?? launchPinnedCodexAppServer;
    this.#prepareCodexHome = input.prepareCodexHome;
    this.#codexEnvironment = input.codexEnvironment;
    this.#credentialStorePreflight = input.credentialStorePreflight;
    this.#allowSameGenerationRelaunchAfterProviderDisconnect =
      input.allowSameGenerationRelaunchAfterProviderDisconnect ?? false;
    this.#now = input.now ?? Date.now;
  }

  async login(input: { authority: ProfileAuthority; method: "browser" | "device_code"; signal: AbortSignal }): Promise<CodexLoginOutcome> {
    return await this.#admit(async () => {
      input.signal.throwIfAborted();
      const client = await this.#client(input.authority);
      input.signal.throwIfAborted();
      const before = accountProjection((await client.accountRead(false, input.signal)).value);
      input.signal.throwIfAborted();
      if (before.signedIn) return { status: "signed_in", account: { ...before, signedIn: true } };
      // Caller cancellation fences admission only. Once login is dispatched,
      // retain its exact result or uncertainty for the durable mutation owner.
      const login = (await client.startManagedLogin(input.method === "device_code" ? "device-code" : "browser")).value;
      return login.type === "chatgptDeviceCode"
        ? { status: "pending", loginId: login.loginId, verificationUrl: login.verificationUrl, userCode: login.userCode }
        : { status: "pending", loginId: login.loginId, verificationUrl: login.authUrl };
    });
  }

  async cancelLogin(input: { authority: ProfileAuthority; loginId: string; signal: AbortSignal }): Promise<{ status: "canceled" | "not_found" }> {
    return await this.#admit(async () => {
      input.signal.throwIfAborted();
      const client = await this.#client(input.authority);
      input.signal.throwIfAborted();
      const result = (await client.cancelManagedLogin(input.loginId)).value;
      return { status: result.status === "notFound" ? "not_found" : "canceled" };
    });
  }

  async logout(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      input.signal.throwIfAborted();
      const client = await this.#client(input.authority);
      input.signal.throwIfAborted();
      await client.logout();
    });
  }

  async releaseOwnedAuthority(input: {
    authority: ProfileAuthority;
    signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    await this.#serializeLifecycle(input.authority.id, async () => {
      input.signal.throwIfAborted();
      // Serializing the nonlaunching lookup closes a client whose first launch
      // was already in flight when revocation began. This path deliberately
      // never calls #running/#client and never consults provider threads.
      const close = this.#retireExactClient(input.authority)
        ?? this.#retryExactClientClose(input.authority);
      if (close !== undefined) await close;
    });
    input.signal.throwIfAborted();
  }

  async readAccount(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<CodexAccountProjection> {
    return await this.#admit(async () => {
      input.signal.throwIfAborted();
      const client = await this.#client(input.authority);
      input.signal.throwIfAborted();
      return accountProjection((await client.accountRead(false, input.signal)).value);
    });
  }

  async readUsage(input: { authority: ProfileAuthority; signal: AbortSignal }): Promise<{ revision: number; observedAt: number; payload: unknown }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const client = await this.#client(input.authority);
      const [usage, limits] = await Promise.all([client.accountUsage(), client.accountRateLimits()]);
      const observedAt = Date.now();
      this.#usageRevision = Math.max(this.#usageRevision + 1, observedAt);
      return { revision: this.#usageRevision, observedAt, payload: { usage: usage.value, rateLimits: limits.value } };
    });
  }

  async consumeRateLimitReset(input: {
    authority: ProfileAuthority;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<"reset" | "alreadyRedeemed" | "nothingToReset" | "noCredit"> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const client = await this.#client(input.authority);
      input.signal.throwIfAborted();
      return (await client.consumeRateLimitResetCredit(input.idempotencyKey)).value.outcome;
    });
  }

  async listPlugins(input: {
    authority: ProfileAuthority;
    projectRoot?: string;
    forceRefetch: boolean;
    signal: AbortSignal;
  }): Promise<CodexPluginCatalog> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const client = await this.#client(input.authority);
      await client.assertCredentialStores(
        input.projectRoot ?? this.#credentialStorePreflight.cwd,
      );
      const catalog = await client.listPlugins({
        ...(input.projectRoot === undefined ? {} : { cwd: input.projectRoot }),
        forceRefetch: input.forceRefetch,
      });
      return projectPluginCatalog(catalog.value);
    });
  }

  async listSessions(input: {
    authority: ProfileAuthority;
    limit: number;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<CodexSessionPage> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const page = await (await this.#client(input.authority)).listThreads({
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });
      return {
        sessions: page.value.data.map((thread) => projectBoundedThread(thread, false)),
        nextCursor: page.value.nextCursor,
      };
    });
  }

  async readSessionMetadata(
    authority: ProfileAuthority,
    providerThreadId: string,
    signal: AbortSignal,
  ): Promise<CodexSessionProjection> {
    return await this.#admit(async () => {
      signal.throwIfAborted();
      const running = await this.#running(authority);
      signal.throwIfAborted();
      const metadata = await running.client.readThread(providerThreadId, false);
      signal.throwIfAborted();
      this.#assertObservedClientCurrent(running);
      if (metadata.value.id !== providerThreadId) {
        throw new CodexError(
          "PROTOCOL_ERROR",
          "thread/read returned metadata for a different Codex thread",
        );
      }
      return projectBoundedThread(metadata.value, false);
    });
  }

  async reviewSessionStart(input: { authority: ProfileAuthority; projectRoot?: string; preset: Preset; requirement: PresetRequirement; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReview> {
    return await this.#admit(async () => {
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a session.");
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      input.signal.throwIfAborted();
      const reviewed = await this.#reviewedPreset(
        running,
        input.preset,
        input.requirement,
        input.fast,
        input.projectRoot,
        undefined,
        input.signal,
      );
      return this.#rememberReview({ kind: "session_start", running, projectRoot: input.projectRoot, ...reviewed });
    });
  }

  discardRuntimeReview(review: RuntimeStartReview): void {
    const pending = this.#runtimeReviews.get(review.reviewId);
    if (pending?.review === review) this.#runtimeReviews.delete(review.reviewId);
  }

  async startSession(input: { authority: ProfileAuthority; hostCapabilities?: "current" | "historical_v1"; projectRoot?: string; review: RuntimeStartReview; signal: AbortSignal }): Promise<CodexSessionProjection & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    return await this.#admit(async () => {
      const hostCapabilityInput: { readonly hostCapabilities?: unknown } = input;
      if (hostCapabilityInput.hostCapabilities !== undefined && hostCapabilityInput.hostCapabilities !== "current" && hostCapabilityInput.hostCapabilities !== "historical_v1") {
        throw new CodexError("INVALID_INPUT", "The session host-capability mode is invalid");
      }
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a session.");
      if (input.signal.aborted) throw input.signal.reason;
      const reviewed = this.#consumeReview(input.review, {
        kind: "session_start",
        authority: input.authority,
        projectRoot: input.projectRoot,
      });
      const running = reviewed.running;
      const preset = reviewed.preset;
      const observationFactSequence = running.sessionObservationFactSequence;
      const started = (await running.client.startThread({
        cwd: input.projectRoot,
        ...(input.hostCapabilities === "historical_v1"
          ? { hostCapabilities: "historical_v1" as const }
          : { developerInstructions: OOMPA_SESSION_PREAMBLE_TEXT }),
        preset,
        policy: this.#policy(input.projectRoot),
      })).value;
      try {
        assertReviewedThreadRuntime(started, reviewed.review.effectiveRuntimeProfile, input.projectRoot);
        const contextual = await this.#reviewedPreset(
          running,
          preset.alias,
          {
            model: reviewed.review.effectiveRuntimeProfile.model,
            effort: reviewed.review.effectiveRuntimeProfile.reasoningEffort,
          },
          preset.fast,
          input.projectRoot,
          started.thread.id,
          input.signal,
        );
        const normalizedContextualProfile: EffectiveRuntimeProfile = {
          ...contextual.profile,
          observedAt: reviewed.review.effectiveRuntimeProfile.observedAt,
        };
        if (
          JSON.stringify(contextual.preset) !== JSON.stringify(preset)
          || JSON.stringify(normalizedContextualProfile) !== JSON.stringify(reviewed.review.effectiveRuntimeProfile)
        ) {
          throw new CodexError(
            "PROTOCOL_ERROR",
            "The new thread's exact capability context differs from its reviewed runtime profile.",
          );
        }
        const projection = projectBoundedThread(started.thread, false);
        this.#assertObservedClientCurrent(running);
        if (
          (running.sessionObservationFactByThread.get(projection.providerThreadId) ?? 0)
          > observationFactSequence
        ) {
          throw new Error("THREAD_START_PROJECTION_INVALIDATED_BY_CONCURRENT_FACT");
        }
        this.#rememberSessionObservation(running, projection, false);
        return { ...projection, effectiveRuntimeProfile: reviewed.review.effectiveRuntimeProfile };
      } catch (error: unknown) {
        throw new IndeterminateCodexEffectError("thread/start", 0, error);
      }
    });
  }

  async observeSession(input: { authority: ProfileAuthority; providerThreadId: string; developerInstructions?: string; signal: AbortSignal }): Promise<CodexSessionObservation> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      const proof = await this.#ensureSessionObserved(
        running,
        input.providerThreadId,
        input.developerInstructions === undefined
          ? {}
          : { developerInstructions: input.developerInstructions },
      );
      const observation = await this.#readSessionObservation(running, input.providerThreadId, proof);
      input.signal.throwIfAborted();
      this.#assertObservedClientCurrent(running);
      return observation;
    });
  }

  hasLiveHostToolCall(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    connectionId: string;
    turnId: string;
    callId: string;
    requestDigest: string;
  }): boolean {
    const running = this.#clients.get(input.authority.id);
    return this.#state === "open"
      && running !== undefined
      && sameProfileAuthority(running.authority, input.authority)
      && running.client.state === "ready"
      && running.client.connectionId === input.connectionId
      && this.#isCurrent(input.authority)
      && running.client.hasLiveOompaHostToolCall({
        authority: codexAuthorityOf(input.authority),
        callId: input.callId,
        connectionId: input.connectionId,
        requestDigest: input.requestDigest,
        threadId: input.providerThreadId,
        turnId: input.turnId,
      });
  }

  async claimSession(input: {
    authority: ProfileAuthority;
    providerThreadId: string;
    projectRoot: string;
    preset: Preset;
    requirement: PresetRequirement;
    fast: boolean;
    signal: AbortSignal;
  }): Promise<CodexSessionObservation & { effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      input.signal.throwIfAborted();
      const reviewed = await this.#reviewedPreset(
        running,
        input.preset,
        input.requirement,
        input.fast,
        input.projectRoot,
        input.providerThreadId,
        input.signal,
      );
      // Claiming is deliberately non-mutating. Oompa applies its reviewed
      // approval and permission policy on every turn after the durable
      // adoption commit, so a failed commit cannot leave provider policy
      // changed on a thread Oompa does not own.
      let resumedThreadId: string | undefined;
      try {
        await this.#invalidateRetainedResumeUnavailable(running, input.providerThreadId);
        input.signal.throwIfAborted();
        const proof = await this.#ensureSessionObserved(
          running,
          input.providerThreadId,
          { onResumed: (threadId) => { resumedThreadId = threadId; } },
        );
        if (proof.resumed) resumedThreadId ??= input.providerThreadId;
        const observation = await this.#readSessionObservation(
          running,
          input.providerThreadId,
          proof,
        );
        input.signal.throwIfAborted();
        this.#assertObservedClientCurrent(running);
        if (observation.projection.providerThreadId !== input.providerThreadId) {
          throw new CodexSessionObservationError("thread_mismatch");
        }
        if (observation.connectionId !== running.client.connectionId) {
          throw new CodexError(
            "AUTHORITY_STALE",
            "The claimed Codex thread belongs to another provider connection.",
          );
        }
        return { ...observation, effectiveRuntimeProfile: reviewed.profile };
      } catch (error: unknown) {
        if (resumedThreadId === undefined && error instanceof ResumedThreadMismatchObservationError) {
          resumedThreadId = error.resumedThreadId;
        }
        if (resumedThreadId !== undefined) {
          await this.#releaseFailedSessionClaim(
            running,
            input.providerThreadId,
            resumedThreadId,
            error,
          );
        }
        throw error;
      }
    });
  }

  async endSession(input: { authority: ProfileAuthority; providerThreadId: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      await this.#settleSessionObservationForRelease(running, input.providerThreadId);
      if (this.#clients.get(running.authority.id) !== running) return;
      input.signal.throwIfAborted();
      try {
        await running.client.unsubscribeThread(input.providerThreadId);
        this.#assertObservedClientCurrent(running);
      } finally {
        // No observation proof survives a release attempt. A lost response is
        // ambiguous, so any later operation must establish custody afresh.
        this.#clearSessionObservation(running, input.providerThreadId);
      }
    });
  }

  async readSession(input: { authority: ProfileAuthority; providerThreadId: string; developerInstructions?: string; detail: boolean; signal: AbortSignal }): Promise<CodexSessionProjection> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      const proof = await this.#ensureSessionObserved(
        running,
        input.providerThreadId,
        input.developerInstructions === undefined
          ? {}
          : { developerInstructions: input.developerInstructions },
      );
      if (!proof.resumed && "projection" in proof) {
        input.signal.throwIfAborted();
        this.#assertObservedClientCurrent(running);
        return input.detail
          ? { ...proof.projection, turns: [] }
          : proof.projection;
      }
      const client = running.client;
      const metadata = await client.readThread(input.providerThreadId, false);
      if (metadata.value.historyMode === "legacy") {
        running.threadItemsListSupport.set(input.providerThreadId, "unsupported");
      }
      let turns: Awaited<ReturnType<CodexAppServerClient["listThreadTurns"]>>;
      let hydrated: RecentTurnsHydration;
      if (running.threadItemsListSupport.get(input.providerThreadId) === "unsupported") {
        turns = await client.listThreadTurns({
          threadId: input.providerThreadId,
          limit: RECENT_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "summary",
        });
        input.signal.throwIfAborted();
        hydrated = this.#projectLegacyRecentTurns(turns.value, metadata.value.cwd);
      } else {
        turns = await client.listThreadTurns({
          threadId: input.providerThreadId,
          limit: RECENT_TURN_LIMIT,
          sortDirection: "desc",
          itemsView: "notLoaded",
        });
        try {
          hydrated = await this.#hydrateRecentTurns(
            client,
            input.providerThreadId,
            [...turns.value.data].reverse(),
            metadata.value.cwd,
            input.signal,
          );
          running.threadItemsListSupport.set(input.providerThreadId, "supported");
        } catch (error: unknown) {
          if (!(error instanceof CodexRemoteError) || error.remoteCode !== -32_601) throw error;
          running.threadItemsListSupport.set(input.providerThreadId, "unsupported");
          turns = await client.listThreadTurns({
            threadId: input.providerThreadId,
            limit: RECENT_TURN_LIMIT,
            sortDirection: "desc",
            itemsView: "summary",
          });
          input.signal.throwIfAborted();
          hydrated = this.#projectLegacyRecentTurns(turns.value, metadata.value.cwd);
        }
      }
      const thread: CodexThread = {
        ...metadata.value,
        turns: hydrated.turns,
      };
      return projectBoundedThread(
        thread,
        input.detail,
        turns.value.nextCursor !== null,
        hydrated.unreadItemTurnIds,
        hydrated.incompleteTurnIds,
        hydrated.summaryMetadataByTurn,
        hydrated.compactEssentialsByTurn,
      );
    });
  }

  async reviewTurnStart(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; preset: Preset; requirement: PresetRequirement; fast: boolean; signal: AbortSignal }): Promise<RuntimeStartReview> {
    return await this.#admit(async () => {
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a turn.");
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      await this.#ensureSessionObserved(running, input.providerThreadId);
      input.signal.throwIfAborted();
      const reviewed = await this.#reviewedPreset(
        running,
        input.preset,
        input.requirement,
        input.fast,
        input.projectRoot,
        input.providerThreadId,
        input.signal,
      );
      return this.#rememberReview({ kind: "turn_start", running, projectRoot: input.projectRoot, providerThreadId: input.providerThreadId, ...reviewed });
    });
  }

  async startTurn(input: { authority: ProfileAuthority; providerThreadId: string; projectRoot?: string; review: RuntimeStartReview; message: string; attachments?: readonly PreparedAttachment[]; clientMessageId: string; signal: AbortSignal }): Promise<{ turnId: string; status: CodexTurn["status"]; effectiveRuntimeProfile: EffectiveRuntimeProfile }> {
    return await this.#admit(async () => {
      if (input.projectRoot === undefined) throw new Error("A project directory is required before starting a turn.");
      if (input.signal.aborted) throw input.signal.reason;
      const reviewed = this.#consumeReview(input.review, {
        kind: "turn_start",
        authority: input.authority,
        projectRoot: input.projectRoot,
        providerThreadId: input.providerThreadId,
      });
      const running = reviewed.running;
      await this.#ensureSessionObserved(running, input.providerThreadId);
      const preset = reviewed.preset;
      this.#invalidateRememberedStartProjection(
        running,
        input.providerThreadId,
      );
      const attachments = input.attachments ?? [];
      const value = await running.client.startTurn({ threadId: input.providerThreadId, clientMessageId: input.clientMessageId, text: input.message, ...(attachments.length === 0 ? {} : { attachments }), preset, cwd: input.projectRoot, policy: this.#policy(input.projectRoot) });
      return { turnId: value.value.turn.id, status: value.value.turn.status, effectiveRuntimeProfile: reviewed.review.effectiveRuntimeProfile };
    });
  }

  async steer(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; message: string; attachments?: readonly PreparedAttachment[]; clientMessageId: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      await this.#ensureSessionObserved(running, input.providerThreadId);
      const attachments = input.attachments ?? [];
      await running.client.steerTurn({ threadId: input.providerThreadId, expectedTurnId: input.activeTurnId, clientMessageId: input.clientMessageId, text: input.message, ...(attachments.length === 0 ? {} : { attachments }) });
    });
  }

  async interrupt(input: { authority: ProfileAuthority; providerThreadId: string; activeTurnId: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      await this.#ensureSessionObserved(running, input.providerThreadId);
      await running.client.interruptTurn(input.providerThreadId, input.activeTurnId);
    });
  }

  async compact(input: { authority: ProfileAuthority; providerThreadId: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      await this.#ensureSessionObserved(running, input.providerThreadId);
      // The request resolves on provider acceptance; the applied outcome
      // arrives separately as a `thread/compacted` notification or a
      // `contextCompaction` item completion.
      await running.client.compactThread(input.providerThreadId);
    });
  }

  async rename(input: { authority: ProfileAuthority; providerThreadId: string; name: string; signal: AbortSignal }): Promise<void> {
    await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      await this.#ensureSessionObserved(running, input.providerThreadId);
      this.#invalidateRememberedStartProjection(
        running,
        input.providerThreadId,
      );
      await running.client.renameThread(input.providerThreadId, input.name);
    });
  }

  async inspectTurn(input: { authority: ProfileAuthority; providerThreadId: string; turnId: string; signal: AbortSignal }): Promise<unknown> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      const running = await this.#running(input.authority);
      await this.#ensureSessionObserved(running, input.providerThreadId);
      const client = running.client;
      const [metadata, found] = await Promise.all([
        client.readThread(input.providerThreadId, false),
        this.#findTurn(client, input.providerThreadId, input.turnId, input.signal),
      ]);
      if (metadata.value.historyMode === "legacy") {
        running.threadItemsListSupport.set(input.providerThreadId, "unsupported");
      }
      let turn = found.turn;
      let hasMoreItems = false;
      if (running.threadItemsListSupport.get(input.providerThreadId) === "unsupported") {
        turn = await this.#readLegacyFullTurn(
          client,
          input.providerThreadId,
          input.turnId,
          found,
          input.signal,
        );
      } else {
        try {
          const itemPage = await client.listThreadItems({
            threadId: input.providerThreadId,
            turnId: input.turnId,
            limit: INSPECT_ITEM_LIMIT,
            sortDirection: "asc",
          });
          running.threadItemsListSupport.set(input.providerThreadId, "supported");
          const items = itemPage.value.data.map((entry) => {
            if (entry.turnId !== input.turnId) {
              throw new CodexError(
                "PROTOCOL_ERROR",
                "thread/items/list returned an item for a different turn",
              );
            }
            return entry.item;
          });
          turn = { ...turn, items };
          hasMoreItems = itemPage.value.nextCursor !== null;
        } catch (error: unknown) {
          if (!(error instanceof CodexRemoteError) || error.remoteCode !== -32_601) throw error;
          running.threadItemsListSupport.set(input.providerThreadId, "unsupported");
          turn = await this.#readLegacyFullTurn(
            client,
            input.providerThreadId,
            input.turnId,
            found,
            input.signal,
          );
        }
      }
      return assertTransportSafeProjection(projectTurn(
        turn,
        metadata.value.cwd,
        INSPECT_ITEM_LIMIT,
        hasMoreItems,
        { remaining: INSPECT_ITEM_JSON_BYTE_BUDGET },
      ));
    });
  }

  async resolveInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    deadlineAt: number;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0) {
        throw new CodexError("INVALID_INPUT", "The interaction deadline is invalid.");
      }
      if (this.#now() >= input.deadlineAt) {
        throw new CodexError(
          "DEADLINE_EXPIRED",
          "The interaction deadline elapsed before runtime dispatch.",
        );
      }
      if (!interactionMatchesProfileAuthority(input.provider, input.authority)
        || !this.#isCurrent(input.authority)) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction belongs to another account process generation.",
        );
      }
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || !sameProfileAuthority(running.authority, input.authority)
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction's exact provider connection is no longer live.",
        );
      }
      return await running.client.resolveInteraction({
        provider: input.provider,
        kind: input.kind,
        resolution: input.resolution,
        deadlineAt: input.deadlineAt,
      });
    });
  }

  async validateInteractionResolution(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    resolution: InteractionResolution;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (!interactionMatchesProfileAuthority(input.provider, input.authority)
        || !this.#isCurrent(input.authority)) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction belongs to another account process generation.",
        );
      }
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || !sameProfileAuthority(running.authority, input.authority)
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction's exact provider connection is no longer live.",
        );
      }
      return await running.client.validateInteractionResolution({
        provider: input.provider,
        kind: input.kind,
        resolution: input.resolution,
      });
    });
  }

  async inspectInteractionAuthority(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    kind: InteractionKind;
    signal: AbortSignal;
  }): Promise<LiveInteractionApprovalAuthority> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (!interactionMatchesProfileAuthority(input.provider, input.authority)
        || !this.#isCurrent(input.authority)) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction belongs to another account process generation.",
        );
      }
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || !this.#interactionInspectionIsCurrent(
          input.authority,
          input.provider,
          input.signal,
          running,
        )
      ) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction's exact provider connection is no longer live.",
        );
      }
      const approvalAuthority = await running.client.inspectInteractionAuthority({
        provider: input.provider,
        kind: input.kind,
      });
      if (!this.#interactionInspectionIsCurrent(
        input.authority,
        input.provider,
        input.signal,
        running,
      )) {
        throw new CodexError(
          "AUTHORITY_STALE",
          "The interaction's exact provider connection changed during inspection.",
        );
      }
      return approvalAuthority;
    });
  }

  #interactionInspectionIsCurrent(
    authority: ProfileAuthority,
    provider: ProviderInteractionAuthority,
    signal: AbortSignal,
    running: RunningClient,
  ): boolean {
    return !signal.aborted
      && this.#isCurrent(authority)
      && this.#clients.get(authority.id) === running
      && sameProfileAuthority(running.authority, authority)
      && running.client.state === "ready"
      && running.client.connectionId === provider.connectionId;
  }

  async validateInteractionTimeout(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseDigest: string }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (!interactionMatchesProfileAuthority(input.provider, input.authority)
        || !this.#isCurrent(input.authority)) throw new CodexError("AUTHORITY_STALE", "The interaction belongs to another account process generation.");
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || !sameProfileAuthority(running.authority, input.authority)
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) throw new CodexError("AUTHORITY_STALE", "The interaction's exact provider connection is no longer live.");
      return await running.client.validateInteractionTimeout({ provider: input.provider });
    });
  }

  async timeoutInteraction(input: {
    authority: ProfileAuthority;
    provider: ProviderInteractionAuthority;
    signal: AbortSignal;
  }): Promise<{ responseWritten: true }> {
    return await this.#admit(async () => {
      if (input.signal.aborted) throw input.signal.reason;
      if (!interactionMatchesProfileAuthority(input.provider, input.authority)
        || !this.#isCurrent(input.authority)) throw new CodexError("AUTHORITY_STALE", "The interaction belongs to another account process generation.");
      const running = this.#clients.get(input.authority.id);
      if (
        running === undefined
        || !sameProfileAuthority(running.authority, input.authority)
        || running.client.state !== "ready"
        || running.client.connectionId !== input.provider.connectionId
      ) throw new CodexError("AUTHORITY_STALE", "The interaction's exact provider connection is no longer live.");
      return await running.client.timeoutInteraction({ provider: input.provider });
    });
  }

  close(): Promise<void> {
    if (this.#closeTask !== undefined) return this.#closeTask;
    this.#state = "closing";
    this.#runtimeReviews.clear();
    this.#sessionObservations.clear();
    this.#accountRefreshDirty.clear();
    this.#deterministicallyDisconnectedByProfile.clear();
    const task = this.#closeOwnedRuntime();
    this.#closeTask = task;
    void task.catch(() => {
      // Failed process-exit proof retains exact custody. Let the same manager
      // retry shutdown instead of caching a falsely complete close forever.
      if (this.#closeTask === task) this.#closeTask = undefined;
    });
    return task;
  }

  async #closeOwnedRuntime(): Promise<void> {
    await this.#drainOwnedWork();
    const closes = [...this.#clients.values()].map((running) =>
      this.#retireExactClient(running.authority, running));
    for (const key of this.#authorityCloseClients.keys()) {
      const existing = this.#authorityCloseTasks.get(key);
      if (existing !== undefined && closes.includes(existing)) continue;
      const retained = this.#authorityCloseClients.get(key);
      if (retained === undefined) continue;
      closes.push(this.#closeRetiredClient(key, retained.client));
    }
    const outcomes = await Promise.allSettled(closes.filter(
      (close): close is Promise<void> => close !== undefined,
    ));
    await this.#drainOwnedWork();
    const failures = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason as unknown] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Multiple Codex processes failed exact shutdown.");
    }
    this.#accountRefreshes.clear();
    this.#accountRefreshDirty.clear();
    this.#authorityCloseClients.clear();
    this.#authorityCloseTasks.clear();
    this.#runtimeReviews.clear();
    this.#sessionObservations.clear();
    this.#deterministicallyDisconnectedByProfile.clear();
    this.#state = "closed";
  }

  async #drainOwnedWork(): Promise<void> {
    for (;;) {
      const owned = [
        ...this.#operations,
        ...this.#lifecycleTails.values(),
        ...this.#background,
      ];
      if (owned.length === 0) return;
      await Promise.allSettled(owned);
      await Promise.resolve();
    }
  }

  async #admit<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#acceptingOperations()) {
      throw new CodexError("AUTHORITY_STALE", "The Codex runtime is closing and no longer accepts operations.");
    }
    const task = this.#afterAccountAuthorityBarriers(operation);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.#operations.add(settled);
    try {
      return await task;
    } finally {
      this.#operations.delete(settled);
    }
  }

  #acceptingOperations(): boolean {
    return this.#state === "open";
  }

  #afterAccountAuthorityBarriers<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.#acceptingOperations()) {
      return Promise.reject(new CodexError(
        "AUTHORITY_STALE",
        "The Codex runtime is closing and no longer accepts operations.",
      ));
    }
    const barriers = [...this.#accountRefreshes.values()].map((entry) => entry.task);
    // Calling the operation directly when admission is open is important: it
    // leaves no await boundary in which an account signal can be raised after
    // this check but before the provider operation begins.
    if (barriers.length === 0) return operation();
    return Promise.all(barriers).then(() => this.#afterAccountAuthorityBarriers(operation));
  }

  #accountAuthorityKey(authority: ProfileAuthority): string {
    return profileAuthorityTombstoneKey(authority);
  }

  #retryExactClientClose(authority: ProfileAuthority): Promise<void> | undefined {
    const key = this.#accountAuthorityKey(authority);
    const active = this.#authorityCloseTasks.get(key);
    if (active !== undefined) return active;
    const retained = this.#authorityCloseClients.get(key);
    return retained === undefined ? undefined : this.#closeRetiredClient(key, retained.client);
  }

  #retainClientClose(authority: ProfileAuthority, client: CodexAppServerClient): Promise<void> {
    const key = this.#accountAuthorityKey(authority);
    const retained = this.#authorityCloseClients.get(key);
    if (retained !== undefined && retained.client !== client) {
      throw new CodexError(
        "AUTHORITY_STALE",
        "Another Codex process still retains this exact account authority.",
      );
    }
    this.#authorityCloseClients.set(key, { profileId: authority.id, client });
    return this.#closeRetiredClient(key, client);
  }

  #closeRetiredClient(key: string, client: CodexAppServerClient): Promise<void> {
    const active = this.#authorityCloseTasks.get(key);
    if (active !== undefined) return active;
    let close: Promise<void>;
    try {
      // `close()` fences client admission synchronously before its first await.
      close = client.close();
    } catch (error: unknown) {
      close = Promise.reject(error);
    }
    this.#authorityCloseTasks.set(key, close);
    const tracked = close.then(
      () => { if (this.#authorityCloseClients.get(key)?.client === client) this.#authorityCloseClients.delete(key); },
      () => undefined,
    );
    this.#background.add(tracked);
    void tracked.then(() => {
      if (this.#authorityCloseTasks.get(key) === close) this.#authorityCloseTasks.delete(key);
      this.#background.delete(tracked);
    });
    return close;
  }

  #retireExactClient(
    authority: ProfileAuthority,
    expected?: RunningClient,
  ): Promise<void> | undefined {
    const running = this.#clients.get(authority.id);
    if (
      running === undefined
      || !sameProfileAuthority(running.authority, authority)
      || (expected !== undefined && running !== expected)
    ) return undefined;

    // Removal and the ended-generation fence are one run-to-completion
    // commit. Nothing can rediscover or relaunch this account generation
    // while close drains the client's fact and request tails.
    this.#clients.delete(authority.id);
    this.#clearSessionObservations(running);
    this.#endedAuthorityTombstones.add(profileAuthorityTombstoneKey(authority));
    const disconnected = this.#deterministicallyDisconnectedByProfile.get(authority.id);
    if (disconnected?.running === running) {
      this.#deterministicallyDisconnectedByProfile.delete(authority.id);
    }
    for (const [reviewId, review] of this.#runtimeReviews) {
      if (review.running === running) this.#runtimeReviews.delete(reviewId);
    }

    // Do not await on the account barrier: client close drains the fact tail,
    // whose triggering account fact is itself waiting for that barrier.
    return this.#retainClientClose(authority, running.client);
  }

  async #client(authority: ProfileAuthority): Promise<CodexAppServerClient> { return (await this.#running(authority)).client; }

  #observationKey(running: RunningClient, providerThreadId: string): string {
    return JSON.stringify([
      running.authority.id,
      running.authority.generation,
      running.authority.provider,
      running.authority.providerAccountId,
      running.authority.bindingGeneration,
      running.client.connectionId,
      providerThreadId,
    ]);
  }

  #rememberSessionObservation(
    running: RunningClient,
    projection: CodexSessionProjection,
    resumed: boolean,
  ): SessionObservationProof {
    this.#assertObservedClientCurrent(running);
    const proof: SessionObservationProof = resumed
      ? { resumed: true }
      : { projection, resumed: false };
    const task = Promise.resolve(proof);
    this.#sessionObservations.set(this.#observationKey(running, projection.providerThreadId), {
      connectionId: running.client.connectionId,
      generation: running.authority.generation,
      profileId: running.authority.id,
      providerThreadId: projection.providerThreadId,
      ...(resumed ? {} : { startProjection: projection }),
      task,
    });
    return proof;
  }

  #invalidateRememberedStartProjection(
    running: RunningClient,
    providerThreadId: string,
  ): void {
    const key = this.#observationKey(running, providerThreadId);
    const existing = this.#sessionObservations.get(key);
    if (existing?.startProjection === undefined) return;
    const replacement: SessionObservationEntry = {
      connectionId: existing.connectionId,
      generation: existing.generation,
      profileId: existing.profileId,
      providerThreadId: existing.providerThreadId,
      task: Promise.resolve({ resumed: false }),
    };
    this.#sessionObservations.set(key, replacement);
  }

  #rotateSessionObservation(
    running: RunningClient,
    providerThreadId: string,
  ): void {
    const key = this.#observationKey(running, providerThreadId);
    const existing = this.#sessionObservations.get(key);
    if (existing === undefined) return;
    this.#sessionObservations.set(key, {
      connectionId: existing.connectionId,
      generation: existing.generation,
      profileId: existing.profileId,
      providerThreadId: existing.providerThreadId,
      task: Promise.resolve({ resumed: false }),
    });
  }

  #clearSessionObservation(
    running: RunningClient,
    providerThreadId: string,
  ): void {
    this.#sessionObservations.delete(this.#observationKey(running, providerThreadId));
  }

  async #invalidateRetainedResumeUnavailable(
    running: RunningClient,
    providerThreadId: string,
  ): Promise<void> {
    const key = this.#observationKey(running, providerThreadId);
    const existing = this.#sessionObservations.get(key);
    if (existing === undefined) return;
    try {
      await existing.task;
    } catch (error: unknown) {
      if (this.#sessionObservations.get(key) !== existing) {
        if (this.#clients.get(running.authority.id) !== running) throw error;
        return;
      }
      this.#assertObservedClientCurrent(running);
      if (
        !(error instanceof CodexSessionObservationError)
        || error.reason !== "resume_unavailable"
      ) throw error;
      // One explicit adoption poll gets one fresh, deadline-bounded resume.
      // Ordinary observation retains the refusal and therefore cannot hammer
      // a thread still held by another client.
      this.#sessionObservations.delete(key);
    }
  }

  async #settleSessionObservationForRelease(
    running: RunningClient,
    providerThreadId: string,
  ): Promise<void> {
    const key = this.#observationKey(running, providerThreadId);
    for (;;) {
      const existing = this.#sessionObservations.get(key);
      if (existing === undefined) return;
      try {
        await existing.task;
      } catch (error: unknown) {
        // An indeterminate resume retires and closes this whole connection,
        // which itself releases every subscription it held.
        if (this.#clients.get(running.authority.id) !== running) return;
        if (this.#sessionObservations.get(key) !== existing) continue;
        if (
          error instanceof CodexSessionObservationError
          && error.reason === "resume_unavailable"
        ) return;
        throw error;
      }
      this.#assertObservedClientCurrent(running);
      if (this.#sessionObservations.get(key) === existing) return;
    }
  }

  async #releaseFailedSessionClaim(
    running: RunningClient,
    observationThreadId: string,
    resumedThreadId: string,
    claimError: unknown,
  ): Promise<void> {
    // A successful policy-neutral resume is already a provider subscription.
    // If a later claim check fails, remove that controller before returning the
    // original failure to the adoption service. Ordinary failures unsubscribe
    // the exact resumed id; an identity mismatch retires the connection because
    // the subscribed thread is no longer provable.
    this.#clearSessionObservation(running, observationThreadId);
    if (
      claimError instanceof CodexSessionObservationError
      && claimError.reason === "thread_mismatch"
    ) {
      // A mismatched response leaves even the subscribed thread identity in
      // doubt. Only closing the exact connection proves that neither possible
      // subscription remains controlled by this failed claim.
      try {
        await this.#closeFailedSessionClaimConnection(running);
      } catch (closeError: unknown) {
        throw new CodexClaimReleaseUnprovenError({
          cause: new AggregateError(
            [claimError, closeError],
            "Codex claim mismatch and connection retirement both failed.",
          ),
        });
      }
      return;
    }
    try {
      await running.client.unsubscribeThread(resumedThreadId);
      return;
    } catch (unsubscribeError: unknown) {
      // A rejected or lost unsubscribe response cannot prove release. Retiring
      // the exact connection releases all of its subscriptions. A completed
      // close restores certainty, so the caller can still receive its original
      // claim error; a failed close replaces it with the cleanup failure below.
      try {
        await this.#closeFailedSessionClaimConnection(running);
      } catch (closeError: unknown) {
        throw new CodexClaimReleaseUnprovenError({
          cause: new AggregateError(
            [claimError, unsubscribeError, closeError],
            "Codex claim, unsubscribe, and connection retirement all failed.",
          ),
        });
      }
    }
  }

  async #closeFailedSessionClaimConnection(running: RunningClient): Promise<void> {
    const close = this.#retireExactClient(running.authority, running)
      ?? this.#retryExactClientClose(running.authority)
      ?? running.client.close();
    await close;
  }

  async #ensureSessionObserved(
    running: RunningClient,
    providerThreadId: string,
    options: Readonly<{
      developerInstructions?: string;
      onResumed?: (providerThreadId: string) => void;
    }> = {},
  ): Promise<SessionObservationProof> {
    const key = this.#observationKey(running, providerThreadId);
    for (;;) {
      this.#assertObservedClientCurrent(running);
      const existing = this.#sessionObservations.get(key);
      if (existing !== undefined) {
        const proof = await existing.task;
        this.#assertObservedClientCurrent(running);
        if (this.#sessionObservations.get(key) !== existing) continue;
        return proof;
      }
      const task = (async (): Promise<SessionObservationProof> => {
        try {
          const resumedThread: CodexThread = (
            await running.client.resumeThread(
              providerThreadId,
              options.developerInstructions,
            )
          ).value;
          options.onResumed?.(resumedThread.id);
          if (resumedThread.id !== providerThreadId) {
            throw new ResumedThreadMismatchObservationError(resumedThread.id);
          }
          this.#assertObservedClientCurrent(running);
          return { resumed: true };
        } catch (error: unknown) {
          if (error instanceof CodexSessionObservationError) throw error;
          if (error instanceof IndeterminateCodexEffectError) {
            try {
              await this.#retireIndeterminateObservation(running);
            } catch (closeError: unknown) {
              throw new CodexClaimReleaseUnprovenError({
                cause: new AggregateError(
                  [error, closeError],
                  "Indeterminate Codex resume and connection retirement both failed.",
                ),
              });
            }
            throw new CodexSessionObservationError("resume_unavailable", { cause: error });
          }
          if (error instanceof CodexError) {
            throw new CodexSessionObservationError("resume_unavailable", { cause: error });
          }
          throw error;
        }
      })();
      const entry: SessionObservationEntry = {
        connectionId: running.client.connectionId,
        generation: running.authority.generation,
        profileId: running.authority.id,
        providerThreadId,
        task,
      };
      this.#sessionObservations.set(key, entry);
      try {
        const proof = await task;
        this.#assertObservedClientCurrent(running);
        if (this.#sessionObservations.get(key) !== entry) continue;
        return proof;
      } catch (error: unknown) {
        if (this.#sessionObservations.get(key) !== entry) {
          if (this.#clients.get(running.authority.id) !== running) throw error;
          continue;
        }
        const deterministicUnavailable = error instanceof CodexSessionObservationError
          && error.reason === "resume_unavailable"
          && this.#clients.get(running.authority.id) === running;
        if (!deterministicUnavailable) {
          this.#sessionObservations.delete(key);
        }
        throw error;
      }
    }
  }

  async #readSessionObservation(
    running: RunningClient,
    providerThreadId: string,
    proof: SessionObservationProof,
  ): Promise<CodexSessionObservation> {
    if (!proof.resumed && "projection" in proof) {
      if (proof.projection.providerThreadId !== providerThreadId) {
        throw new CodexSessionObservationError("thread_mismatch");
      }
      this.#assertObservedClientCurrent(running);
      return {
        connectionId: running.client.connectionId,
        projection: proof.projection,
        resumed: false,
      };
    }
    const metadata = (await running.client.readThread(providerThreadId, false)).value;
    if (metadata.id !== providerThreadId) {
      throw new CodexSessionObservationError("thread_mismatch");
    }
    const recentTurns = metadata.status.type === "active"
      ? (await running.client.listThreadTurns({
          threadId: providerThreadId,
          limit: 1,
          sortDirection: "desc",
          itemsView: "notLoaded",
        })).value.data
      : [];
    this.#assertObservedClientCurrent(running);
    return {
      connectionId: running.client.connectionId,
      projection: projectBoundedThread({ ...metadata, turns: recentTurns }, false),
      resumed: proof.resumed,
    };
  }

  #assertObservedClientCurrent(running: RunningClient): void {
    const current = this.#clients.get(running.authority.id);
    if (
      current !== running
      || !sameProfileAuthority(current.authority, running.authority)
      || current.client.connectionId !== running.client.connectionId
      || current.client.state !== "ready"
      || !this.#isCurrent(running.authority)
    ) {
      throw new CodexError("AUTHORITY_STALE", "The exact Codex observation authority is no longer current.");
    }
  }

  #clearSessionObservations(running: RunningClient): void {
    for (const [key, entry] of this.#sessionObservations) {
      if (
        entry.profileId === running.authority.id
        && entry.generation === running.authority.generation
        && entry.connectionId === running.client.connectionId
      ) this.#sessionObservations.delete(key);
    }
  }

  async #retireIndeterminateObservation(running: RunningClient): Promise<void> {
    await this.#serializeLifecycle(running.authority.id, async () => {
      const close = this.#retireExactClient(running.authority, running)
        ?? this.#retryExactClientClose(running.authority);
      if (close !== undefined) await close;
    });
  }

  async #hydrateRecentTurns(
    client: CodexAppServerClient,
    threadId: string,
    turns: readonly CodexTurn[],
    root: string,
    signal: AbortSignal,
  ): Promise<RecentTurnsHydration> {
    type HydrationState = {
      readonly turn: CodexTurn;
      readonly items: CodexThreadItem[];
      readonly seenCursors: Set<string>;
      readonly seenItemsById: Map<string, CodexThreadItem>;
      readonly summary: TurnSummaryAccumulator;
      readonly summarySeenItemFingerprints: Map<string, string>;
      firstUser?: CodexProjectedMessage;
      finalAssistant?: CodexProjectedMessage;
      nextCursor: string | null;
      pageCount: number;
      providerItemsUnread: boolean;
      summaryTailRequired: boolean;
    };
    const states: HydrationState[] = turns.map((turn) => ({
      turn,
      items: [],
      seenCursors: new Set<string>(),
      seenItemsById: new Map<string, CodexThreadItem>(),
      summary: createTurnSummaryAccumulator(),
      summarySeenItemFingerprints: new Map<string, string>(),
      nextCursor: null,
      pageCount: 0,
      providerItemsUnread: false,
      summaryTailRequired: false,
    }));
    let remainingPages = RECENT_TURN_ITEM_AGGREGATE_PAGE_LIMIT;
    let remainingTailPages = RECENT_TURN_ITEM_TAIL_PAGE_LIMIT;
    let loadedItems = 0;
    let retainedItemJsonBytes = 0;
    let forwardAdmissionOpen = true;
    let tailAdmissionOpen = true;
    const admitPageItems = (count: number): void => {
      if (count > INSPECT_ITEM_LIMIT) {
        throw new CodexError("PROTOCOL_LIMIT", "thread/items/list exceeded its requested recent-turn page limit");
      }
      loadedItems += count;
      if (loadedItems > RECENT_TURN_ITEM_AGGREGATE_LIMIT) {
        throw new CodexError("PROTOCOL_LIMIT", "recent-turn hydration exceeded its aggregate item limit");
      }
    };
    const admitRetainedItem = (item: CodexThreadItem, phase: "forward" | "tail"): boolean => {
      const bytes = jsonUtf8Bytes(item) + 1;
      const limit = phase === "forward"
        ? RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT
        : RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT;
      if (bytes > limit - retainedItemJsonBytes) return false;
      retainedItemJsonBytes += bytes;
      return true;
    };
    const admitCompactEssential = (message: CodexProjectedMessage): boolean => {
      const bytes = jsonUtf8Bytes(message) + 1;
      if (bytes > RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT - retainedItemJsonBytes) return false;
      retainedItemJsonBytes += bytes;
      return true;
    };
    const captureStableFirstUser = (
      state: HydrationState,
      entries: readonly { readonly turnId: string; readonly item: CodexThreadItem }[],
    ): void => {
      // Only the ascending head can establish the first user. Do not scan a
      // later page or reverse tail when this bounded proof is absent.
      const firstUser = entries.find((entry) => entry.item.type === "userMessage");
      if (firstUser === undefined || firstUser.item.type !== "userMessage") return;
      const text = firstUser.item.text[0];
      if (text === undefined) return;
      const message = projectCompactMessage(
        "user",
        text,
        state.turn.id,
        firstUser.item.clientId ?? undefined,
      );
      if (!admitCompactEssential(message)) {
        state.providerItemsUnread = true;
        return;
      }
      state.firstUser = message;
    };
    const captureStableFinalAssistant = (
      state: HydrationState,
      entries: readonly { readonly turnId: string; readonly item: CodexThreadItem }[],
      order: "chronological" | "newest-first",
    ): void => {
      if (state.finalAssistant !== undefined) return;
      // A complete ascending page or the newest-first tail establishes the
      // last assistant without retaining the unread middle.
      const ordered = order === "chronological" ? [...entries].reverse() : entries;
      const finalAssistant = ordered.find((entry) => entry.item.type === "agentMessage");
      if (finalAssistant === undefined || finalAssistant.item.type !== "agentMessage") return;
      const message = projectCompactMessage(
        "assistant",
        finalAssistant.item.text,
        state.turn.id,
      );
      if (!admitCompactEssential(message)) {
        state.providerItemsUnread = true;
        return;
      }
      state.finalAssistant = message;
    };
    const captureStableSummaryPage = (
      state: HydrationState,
      entries: readonly { readonly turnId: string; readonly item: CodexThreadItem }[],
      phase: "head" | "tail",
    ): void => {
      const pageItemIds = new Set<string>();
      const summaryItems: CodexThreadItem[] = [];
      for (const entry of entries) {
        if (entry.turnId !== state.turn.id) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list returned a summary item for a different recent turn");
        }
        if (pageItemIds.has(entry.item.id)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent-turn summary page");
        }
        pageItemIds.add(entry.item.id);
        const fingerprint = fingerprintThreadItem(entry.item);
        const existing = state.summarySeenItemFingerprints.get(entry.item.id);
        if (existing !== undefined) {
          if (existing !== fingerprint) {
            throw new CodexError("PROTOCOL_ERROR", "thread/items/list changed an overlapping recent-turn summary item");
          }
          if (phase === "head") {
            throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent-turn head");
          }
          continue;
        }
        state.summarySeenItemFingerprints.set(entry.item.id, fingerprint);
        summaryItems.push(entry.item);
      }
      const chronologicalItems = phase === "tail" ? summaryItems.reverse() : summaryItems;
      for (const item of chronologicalItems) {
        accumulateTurnSummaryItem(state.summary, item, root);
      }
    };
    const readNextPage = async (state: HydrationState): Promise<boolean> => {
      if (signal.aborted) throw signal.reason;
      const requiredHead = state.pageCount === 0;
      if (
        remainingPages <= 0
        || state.pageCount >= RECENT_TURN_ITEM_PAGE_LIMIT
        || (!requiredHead && (
          !forwardAdmissionOpen
          || retainedItemJsonBytes >= RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT
        ))
      ) {
        state.providerItemsUnread = true;
        forwardAdmissionOpen = false;
        return false;
      }
      const cursor = state.nextCursor;
      const page = await client.listThreadItems({
        threadId,
        turnId: state.turn.id,
        ...(state.pageCount === 0 ? {} : { cursor }),
        limit: INSPECT_ITEM_LIMIT,
        sortDirection: "asc",
      });
      remainingPages -= 1;
      state.pageCount += 1;
      admitPageItems(page.value.data.length);
      if (requiredHead) captureStableSummaryPage(state, page.value.data, "head");
      state.nextCursor = page.value.nextCursor;
      if (requiredHead) {
        captureStableFirstUser(state, page.value.data);
        state.summaryTailRequired = state.nextCursor !== null;
        if (state.nextCursor === null) {
          captureStableFinalAssistant(state, page.value.data, "chronological");
        }
      }
      if (state.nextCursor !== null) {
        if (state.seenCursors.has(state.nextCursor)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated a cursor in one recent turn");
        }
        state.seenCursors.add(state.nextCursor);
      }
      if (!forwardAdmissionOpen || retainedItemJsonBytes >= RECENT_TURN_FORWARD_ITEM_JSON_BYTE_LIMIT) {
        state.providerItemsUnread = page.value.data.length > 0 || state.nextCursor !== null;
        forwardAdmissionOpen = false;
        return false;
      }
      for (const entry of page.value.data) {
        if (entry.turnId !== state.turn.id) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list returned an item for a different recent turn");
        }
        if (state.seenItemsById.has(entry.item.id)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent turn");
        }
        if (!admitRetainedItem(entry.item, "forward")) {
          state.providerItemsUnread = true;
          forwardAdmissionOpen = false;
          break;
        }
        state.seenItemsById.set(entry.item.id, entry.item);
        state.items.push(entry.item);
      }
      return forwardAdmissionOpen;
    };

    // Admit newest heads first, then give their forward continuations the
    // remaining non-tail budget.
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state !== undefined) await readNextPage(state);
    }
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state === undefined) continue;
      while (
        state.nextCursor !== null
        && state.pageCount < RECENT_TURN_ITEM_PAGE_LIMIT
        && remainingPages > 0
      ) {
        if (!await readNextPage(state)) break;
      }
    }
    // An adversarially long completed turn can exhaust the forward window
    // before its final model response. One bounded reverse page preserves that
    // tail for the compact projection. The unread middle remains explicit, but
    // is safe to omit when the final assistant response is established.
    for (let index = states.length - 1; index >= 0; index -= 1) {
      const state = states[index];
      if (state === undefined) continue;
      if (!state.summaryTailRequired && state.nextCursor === null && !state.providerItemsUnread) continue;
      if (remainingTailPages <= 0) {
        state.providerItemsUnread = true;
        continue;
      }
      if (signal.aborted) throw signal.reason;
      const tail = await client.listThreadItems({
        threadId,
        turnId: state.turn.id,
        limit: INSPECT_ITEM_LIMIT,
        sortDirection: "desc",
      });
      remainingTailPages -= 1;
      admitPageItems(tail.value.data.length);
      captureStableSummaryPage(state, tail.value.data, "tail");
      captureStableFinalAssistant(state, tail.value.data, "newest-first");
      const tailItemIds = new Set<string>();
      const newestFirstTail: CodexThreadItem[] = [];
      let tailFullyAdmitted = true;
      if (!tailAdmissionOpen || retainedItemJsonBytes >= RECENT_TURN_RETAINED_ITEM_JSON_BYTE_LIMIT) {
        state.providerItemsUnread = true;
        tailAdmissionOpen = false;
        tailFullyAdmitted = false;
      }
      for (const entry of tail.value.data) {
        if (entry.turnId !== state.turn.id) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list returned a tail item for a different recent turn");
        }
        if (tailItemIds.has(entry.item.id)) {
          throw new CodexError("PROTOCOL_ERROR", "thread/items/list repeated an item in one recent-turn tail");
        }
        tailItemIds.add(entry.item.id);
        if (!tailFullyAdmitted) continue;
        const existing = state.seenItemsById.get(entry.item.id);
        if (existing !== undefined) {
          if (JSON.stringify(existing) !== JSON.stringify(entry.item)) {
            throw new CodexError("PROTOCOL_ERROR", "thread/items/list changed an overlapping recent-turn tail item");
          }
          continue;
        }
        if (!admitRetainedItem(entry.item, "tail")) {
          state.providerItemsUnread = true;
          tailAdmissionOpen = false;
          tailFullyAdmitted = false;
          break;
        }
        state.seenItemsById.set(entry.item.id, entry.item);
        newestFirstTail.push(entry.item);
      }
      state.items.push(...newestFirstTail.reverse());
      if (
        tailFullyAdmitted
        && tail.value.nextCursor === null
        && state.nextCursor === null
      ) {
        state.providerItemsUnread = false;
      }
    }
    const unreadItemTurnIds = new Set(
      states
        .filter((state) => state.providerItemsUnread || state.nextCursor !== null)
        .map((state) => state.turn.id),
    );
    const incompleteTurnIds = new Set(
      states
        .filter((state) =>
          state.turn.status === "completed"
          && (state.firstUser === undefined || state.finalAssistant === undefined))
        .map((state) => state.turn.id),
    );
    return {
      turns: states.map((state) => ({ ...state.turn, items: state.items })),
      unreadItemTurnIds,
      incompleteTurnIds,
      summaryMetadataByTurn: new Map(
        states.map((state) => [state.turn.id, finishTurnSummary(state.summary)]),
      ),
      compactEssentialsByTurn: new Map(
        states.map((state) => [state.turn.id, {
          ...(state.firstUser === undefined ? {} : { firstUser: state.firstUser }),
          ...(state.finalAssistant === undefined ? {} : { finalAssistant: state.finalAssistant }),
        }]),
      ),
    };
  }

  #projectLegacyRecentTurns(
    page: Awaited<ReturnType<CodexAppServerClient["listThreadTurns"]>>["value"],
    root: string,
  ): RecentTurnsHydration {
    const turns = [...page.data].reverse();
    const incompleteTurnIds = new Set(
      turns
        .filter((turn) => turn.status === "completed" && (
          !turn.items.some((item) => item.type === "userMessage" && item.text.length > 0)
          || !turn.items.some((item) => item.type === "agentMessage")
        ))
        .map((turn) => turn.id),
    );
    return {
      turns,
      unreadItemTurnIds: new Set(turns.map((turn) => turn.id)),
      incompleteTurnIds,
      summaryMetadataByTurn: new Map(
        turns.map((turn) => [turn.id, summarizeTurnItems(turn.items, root)]),
      ),
      compactEssentialsByTurn: new Map(),
    };
  }

  async #findTurn(
    client: CodexAppServerClient,
    threadId: string,
    turnId: string,
    signal: AbortSignal,
  ): Promise<Readonly<{
    turn: CodexTurn;
    pageCursor: string | null;
    pageBackwardsCursor: string | null;
    pageIndex: number;
    pageTurnIds: readonly string[];
  }>> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    for (let pageIndex = 0; pageIndex < TURN_SEARCH_PAGE_LIMIT; pageIndex += 1) {
      if (signal.aborted) throw signal.reason;
      const page = await client.listThreadTurns({
        threadId,
        cursor,
        limit: TURN_SEARCH_PAGE_SIZE,
        sortDirection: "desc",
        itemsView: "notLoaded",
      });
      const pageIndex = page.value.data.findIndex((candidate) => candidate.id === turnId);
      const match = pageIndex < 0 ? undefined : page.value.data[pageIndex];
      if (match !== undefined) {
        return {
          turn: match,
          pageCursor: cursor,
          pageBackwardsCursor: page.value.backwardsCursor,
          pageIndex,
          pageTurnIds: page.value.data.map((candidate) => candidate.id),
        };
      }
      cursor = page.value.nextCursor;
      if (cursor === null) throw new Error("Turn was not found.");
      if (seenCursors.has(cursor)) {
        throw new CodexError("PROTOCOL_ERROR", "thread/turns/list repeated a cursor");
      }
      seenCursors.add(cursor);
    }
    throw new CodexError(
      "PROTOCOL_LIMIT",
      "Turn is outside the bounded inspection history window",
    );
  }

  async #readLegacyFullTurn(
    client: CodexAppServerClient,
    threadId: string,
    turnId: string,
    found: Readonly<{
      pageCursor: string | null;
      pageBackwardsCursor: string | null;
      pageIndex: number;
      pageTurnIds: readonly string[];
    }>,
    signal: AbortSignal,
  ): Promise<CodexTurn> {
    if (signal.aborted) throw signal.reason;
    let targetCursor: string;
    if (found.pageIndex === 0) {
      if (found.pageBackwardsCursor === null) {
        throw new CodexError(
          "PROTOCOL_ERROR",
          "thread/turns/list omitted the target turn compatibility cursor",
        );
      }
      targetCursor = found.pageBackwardsCursor;
    } else {
      const prefix = (await client.listThreadTurns({
        threadId,
        cursor: found.pageCursor,
        limit: found.pageIndex,
        sortDirection: "desc",
        itemsView: "notLoaded",
      })).value;
      signal.throwIfAborted();
      const expectedPrefix = found.pageTurnIds.slice(0, found.pageIndex);
      const actualPrefix = prefix.data.map((turn) => turn.id);
      if (
        JSON.stringify(actualPrefix) !== JSON.stringify(expectedPrefix)
        || prefix.nextCursor === null
      ) {
        throw new CodexError(
          "PROTOCOL_ERROR",
          "thread/turns/list changed while selecting the pinned turn compatibility cursor",
        );
      }
      targetCursor = prefix.nextCursor;
    }
    const page = (await client.listThreadTurns({
      threadId,
      cursor: targetCursor,
      limit: 1,
      sortDirection: "desc",
      itemsView: "full",
    })).value;
    signal.throwIfAborted();
    const actualIds = page.data.map((turn) => turn.id);
    const turn = page.data[0];
    if (
      actualIds.length !== 1
      || turn?.id !== turnId
    ) {
      throw new CodexError(
        "PROTOCOL_ERROR",
        "thread/turns/list changed while selecting the pinned turn compatibility view",
      );
    }
    return turn;
  }

  async #running(authority: ProfileAuthority): Promise<RunningClient> {
    return await this.#serializeLifecycle(authority.id, async () => this.#runningLocked(authority));
  }

  async #runningLocked(authority: ProfileAuthority): Promise<RunningClient> {
    codexAuthorityOf(authority);
    if (!this.#isCurrent(authority)) throw new Error("Codex account generation is stale.");
    const existing = this.#clients.get(authority.id);
    const ended = this.#endedAuthorityTombstones.has(profileAuthorityTombstoneKey(authority));
    const disconnected = this.#deterministicallyDisconnectedByProfile.get(authority.id);
    const mayRelaunchDisconnectedClient =
      this.#allowSameGenerationRelaunchAfterProviderDisconnect
      && ended
      && existing !== undefined
      && sameProfileAuthority(existing.authority, authority)
      && existing.client.state !== "ready"
      && disconnected?.running === existing
      && disconnected.generation === authority.generation
      && disconnected.connectionId === existing.client.connectionId;
    if (ended && !mayRelaunchDisconnectedClient) {
      throw new CodexError(
        "AUTHORITY_STALE",
        "The exact Codex authority ended and cannot be relaunched.",
      );
    }
    if (existing !== undefined && sameProfileAuthority(existing.authority, authority) && existing.client.state === "ready") return existing;
    if (existing !== undefined && sameProfileAuthority(existing.authority, authority)) {
      if (mayRelaunchDisconnectedClient) return await this.#launch(authority, existing);
      throw new CodexError(
        "AUTHORITY_STALE",
        "The Codex process generation is no longer ready and cannot be reused.",
      );
    }
    return await this.#launch(authority);
  }

  async #serializeLifecycle<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#lifecycleTails.get(profileId) ?? Promise.resolve();
    const task = previous.then(operation, operation);
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    this.#lifecycleTails.set(profileId, settled);
    try {
      return await task;
    } finally {
      if (this.#lifecycleTails.get(profileId) === settled) this.#lifecycleTails.delete(profileId);
    }
  }

  async #launch(
    authority: ProfileAuthority,
    disconnectedClient?: RunningClient,
  ): Promise<RunningClient> {
    const clientAuthority = codexAuthorityOf(authority);
    if ([...this.#authorityCloseClients.values()].some((retained) =>
      retained.profileId === authority.id)) {
      throw new CodexError("AUTHORITY_STALE", "A prior Codex process for this account is still unjoined.");
    }
    const existing = this.#clients.get(authority.id);
    const replacingDeterministicDisconnect = disconnectedClient !== undefined
      && existing === disconnectedClient
      && sameProfileAuthority(existing.authority, authority);
    const previousConnectionId = replacingDeterministicDisconnect
      ? disconnectedClient.client.connectionId
      : undefined;
    // A disconnect proof authorizes exactly one cleanup-and-launch attempt.
    // Consuming it up front leaves a failed cleanup or launch fenced.
    this.#deterministicallyDisconnectedByProfile.delete(authority.id);
    if (existing !== undefined) {
      this.#clients.delete(authority.id);
      this.#clearSessionObservations(existing);
      if (!replacingDeterministicDisconnect) {
        this.#endedAuthorityTombstones.add(profileAuthorityTombstoneKey(existing.authority));
      }
      await this.#retainClientClose(existing.authority, existing.client);
    }
    if (this.#prepareCodexHome !== undefined) {
      await this.#prepareCodexHome(authority.codexHome);
    }
    const environment = this.#codexEnvironment === undefined
      ? undefined
      : await this.#codexEnvironment(authority.codexHome);
    const launchedClient: { current: CodexAppServerClient | undefined } = {
      current: undefined,
    };
    let publishRunning!: (running: RunningClient | null) => void;
    const runningReady = new Promise<RunningClient | null>((resolveRunning) => {
      publishRunning = resolveRunning;
    });
    let client: CodexAppServerClient;
    try {
      client = await this.#launchClient({
        authority: clientAuthority,
        expectedCodexHome: authority.codexHome,
        ...(environment === undefined ? {} : { environment }),
        credentialStorePreflight: this.#credentialStorePreflight,
        experimentalApi: true,
        isAuthorityCurrent: (candidate) =>
          sameCodexAuthority(candidate, clientAuthority) && this.#isCurrent(authority),
        now: this.#now,
        onAccountAuthoritySignal: (signaled) => {
          if (
            !sameCodexAuthority(signaled, clientAuthority)
          ) return;
          const published = this.#clients.get(authority.id);
          if (
            launchedClient.current !== undefined
            && published?.client !== launchedClient.current
          ) return;
          if (!this.#isCurrent(authority) || !this.#acceptingOperations()) {
            if (published !== undefined) {
              void this.#retireExactClient(authority, published);
            }
            return Promise.reject(new CodexError(
              "AUTHORITY_STALE",
              "The Codex runtime authority changed before the account could be refreshed.",
            ));
          }
          return this.#scheduleAccountRefresh(authority, runningReady);
        },
        onOompaHostToolCall: async (call) => await this.#admit(async () => {
          const current = this.#clients.get(authority.id);
          if (
            !sameCodexAuthority(call.authority, clientAuthority)
            || !this.#isCurrent(authority)
            || launchedClient.current === undefined
            || current?.client !== launchedClient.current
            || launchedClient.current.state !== "ready"
            || launchedClient.current.connectionId !== call.connectionId
          ) {
            throw new CodexError(
              "AUTHORITY_STALE",
              "The Oompa host-tool call belongs to a stale Codex account generation",
            );
          }
          if (this.#observer.oompaHostTool === undefined) {
            throw new CodexError(
              "UNSUPPORTED_CAPABILITY",
              "The Oompa host-tool service is unavailable",
            );
          }
          return await this.#observer.oompaHostTool(authority, call);
        }),
        onOompaHostToolResponseWritten: (call) => {
          const current = this.#clients.get(authority.id);
          if (
            !sameCodexAuthority(call.authority, clientAuthority)
            || !this.#isCurrent(authority)
            || launchedClient.current === undefined
            || current?.client !== launchedClient.current
            || launchedClient.current.state !== "ready"
            || launchedClient.current.connectionId !== call.connectionId
          ) return;
          return this.#observer.oompaHostToolResponseWritten?.(authority, call);
        },
        onFact: async (value: FencedCodexValue<CodexFact>) => {
          if (!sameCodexAuthority(value.authority, clientAuthority)) return;
          if (!this.#acceptingOperations()) return;
          try {
            await this.#admit(async () => {
              const owned = await runningReady;
              const exactClient = this.#clients.get(authority.id);
              if (
                owned === null
                || launchedClient.current === undefined
                || owned.client !== launchedClient.current
                || exactClient !== owned
                || !sameProfileAuthority(exactClient.authority, authority)
              ) return;
              const factUnloadsThread = value.value.type === "threadDeleted"
                || (
                  value.value.type === "threadStatusChanged"
                  && value.value.status.type === "notLoaded"
                );
              const factInvalidatesStartProjection = value.value.type === "turnStarted"
                || value.value.type === "turnCompleted"
                || value.value.type === "threadNameUpdated"
                || (
                  value.value.type === "threadCompaction"
                  && value.value.outcome === "completed"
                )
                || (
                  value.value.type === "threadStatusChanged"
                  && value.value.status.type !== "idle"
                  && value.value.status.type !== "notLoaded"
                );
              if ((factUnloadsThread || factInvalidatesStartProjection) && "threadId" in value.value) {
                const observed = this.#clients.get(authority.id);
                if (
                  observed !== undefined
                  && sameProfileAuthority(observed.authority, authority)
                  && observed.client.connectionId === value.value.connectionId
                ) {
                  observed.sessionObservationFactSequence += 1;
                  observed.sessionObservationFactByThread.set(
                    value.value.threadId,
                    observed.sessionObservationFactSequence,
                  );
                  if (factUnloadsThread) {
                    this.#clearSessionObservation(observed, value.value.threadId);
                    if (value.value.type === "threadDeleted") {
                      observed.threadItemsListSupport.delete(value.value.threadId);
                    }
                  } else {
                    this.#rotateSessionObservation(observed, value.value.threadId);
                  }
                }
              }
              if (value.value.type === "providerDisconnected") {
                const disconnected = this.#clients.get(authority.id);
                const exactDisconnectedClient =
                  disconnected !== undefined
                  && sameProfileAuthority(disconnected.authority, authority)
                  && disconnected.client.connectionId === value.value.connectionId
                  && disconnected.client.state !== "ready"
                    ? disconnected
                    : undefined;
                if (exactDisconnectedClient !== undefined) {
                  this.#clearSessionObservations(exactDisconnectedClient);
                  this.#endedAuthorityTombstones.add(profileAuthorityTombstoneKey(authority));
                  if (this.#allowSameGenerationRelaunchAfterProviderDisconnect) {
                    this.#deterministicallyDisconnectedByProfile.set(authority.id, {
                      connectionId: value.value.connectionId,
                      generation: authority.generation,
                      running: exactDisconnectedClient,
                    });
                  }
                }
              }
              if (!this.#isCurrent(authority)) return;
              const fact = value.value.type === "threadNameUpdated"
                ? {
                    ...value.value,
                    name: value.value.name === null
                      ? null
                      : normalizeProviderTitle(
                          replaceCodexDesktopHeartbeatTitle(value.value.name),
                        ),
                  }
                : value.value;
              await this.#observer.fact(authority, fact);
            });
          } catch (error: unknown) {
            if (!this.#acceptingOperations()) return;
            throw error;
          }
        },
      });
    } catch (error: unknown) {
      publishRunning(null);
      throw error;
    }
    if (previousConnectionId !== undefined && client.connectionId === previousConnectionId) {
      publishRunning(null);
      await this.#retainClientClose(authority, client);
      throw new CodexError(
        "PROTOCOL_ERROR",
        "The replacement Codex process reused the disconnected connection identity.",
      );
    }
    launchedClient.current = client;
    if (!this.#isCurrent(authority)) {
      publishRunning(null);
      await this.#retainClientClose(authority, client);
      throw new Error("Codex account generation changed during launch.");
    }
    if (replacingDeterministicDisconnect) this.#endedAuthorityTombstones.delete(profileAuthorityTombstoneKey(authority));
    const running: RunningClient = {
      authority,
      client,
      threadItemsListSupport: new Map(),
      sessionObservationFactSequence: 0,
      sessionObservationFactByThread: new Map(),
    };
    this.#clients.set(authority.id, running);
    publishRunning(running);
    return running;
  }

  #scheduleAccountRefresh(
    authority: ProfileAuthority,
    runningReady: Promise<RunningClient | null>,
  ): Promise<void> | undefined {
    if (!this.#acceptingOperations()) return undefined;
    const key = this.#accountAuthorityKey(authority);
    const existing = this.#accountRefreshes.get(key);
    if (existing !== undefined && !existing.settled) {
      this.#accountRefreshDirty.add(key);
      return existing.task;
    }
    const barrierState = { settled: false };
    const task = Promise.resolve().then(async () => {
      let running: RunningClient | null = null;
      try {
        running = await runningReady;
        if (running === null || !this.#acceptingOperations()) return;
        for (;;) {
          this.#accountRefreshDirty.delete(key);
          this.#assertAccountRefreshCurrent(authority, running);
          const account = accountProjection(
            (await running.client.refreshAccountAuthority()).value,
          );
          this.#assertAccountRefreshCurrent(authority, running);
          await this.#observer.account(authority, account);
          this.#assertAccountRefreshCurrent(authority, running);
          if (!this.#accountRefreshDirty.has(key)) return;
        }
      } catch (error: unknown) {
        // Retire synchronously, then let client close drain in the background.
        // Awaiting close here deadlocks because the triggering account fact is
        // itself queued behind this admission barrier.
        if (running !== null) void this.#retireExactClient(authority, running);
        throw error;
      } finally {
        // A signal cannot interleave between this synchronous flag write and
        // task settlement. A later signal therefore observes `settled` and
        // replaces this barrier instead of being lost during map cleanup.
        barrierState.settled = true;
      }
    });
    const barrier: AccountAuthorityBarrier = {
      authority,
      get settled() { return barrierState.settled; },
      task,
    };
    const tracked = task.then(
      () => undefined,
      () => undefined,
    );
    // Publishing the barrier happens synchronously inside the client's signal
    // callback, before the triggering fact enters its asynchronous tail.
    this.#accountRefreshes.set(key, barrier);
    this.#background.add(tracked);
    void tracked.then(() => {
      if (this.#accountRefreshes.get(key) === barrier) {
        this.#accountRefreshes.delete(key);
        this.#accountRefreshDirty.delete(key);
      }
      this.#background.delete(tracked);
    });
    return task;
  }

  #assertAccountRefreshCurrent(
    authority: ProfileAuthority,
    running: RunningClient,
  ): void {
    if (
      !this.#acceptingOperations()
      || !this.#isCurrent(authority)
      || this.#clients.get(authority.id) !== running
      || !sameProfileAuthority(running.authority, authority)
      || running.client.state !== "ready"
    ) {
      throw new CodexError(
        "AUTHORITY_STALE",
        "The Codex account changed while its runtime authority was being refreshed.",
      );
    }
  }

  async #reviewedPreset(
    running: RunningClient,
    alias: Preset,
    requirement: PresetRequirement,
    fast: boolean,
    cwd: string,
    threadId: string | undefined,
    signal: AbortSignal,
  ): Promise<{
    preset: ResolvedPreset;
    profile: EffectiveRuntimeProfile;
  }> {
    signal.throwIfAborted();
    // A preset that names another provider's model is refused here, never
    // silently coerced into a Codex model.
    assertPresetSupportedByProvider("codex", alias);
    await running.client.assertCredentialStores(cwd, signal);
    signal.throwIfAborted();
    const capabilities = await running.client.discoverCapabilities({
      cwd,
      ...(threadId === undefined ? {} : { threadId }),
      includeExperimental: true,
      signal,
    });
    signal.throwIfAborted();
    const preset = running.client.resolvePreset(capabilities, alias, requirement, fast);
    const profile = compileEffectiveRuntimeProfile({
      authority: running.authority,
      capabilities: capabilities.value,
      preset,
      observedAt: this.#now(),
    });
    return {
      preset,
      profile,
    };
  }

  #rememberReview(input: {
    kind: RuntimeStartReview["kind"];
    running: RunningClient;
    projectRoot: string;
    providerThreadId?: string;
    preset: ResolvedPreset;
    profile: EffectiveRuntimeProfile;
  }): RuntimeStartReview {
    const createdAt = input.profile.observedAt;
    for (const [id, pending] of this.#runtimeReviews) {
      if (createdAt - pending.createdAt > 5_000) this.#runtimeReviews.delete(id);
    }
    if (this.#runtimeReviews.size >= 64) {
      throw new CodexError("PROTOCOL_LIMIT", "Too many unconsumed runtime reviews are pending.");
    }
    const review: RuntimeStartReview = {
      reviewId: crypto.randomUUID(),
      kind: input.kind,
      effectiveRuntimeProfile: input.profile,
    };
    this.#runtimeReviews.set(review.reviewId, {
      review,
      running: input.running,
      projectRoot: input.projectRoot,
      ...(input.providerThreadId === undefined ? {} : { providerThreadId: input.providerThreadId }),
      preset: input.preset,
      createdAt,
    });
    return review;
  }

  #consumeReview(
    review: RuntimeStartReview,
    expected: {
      kind: RuntimeStartReview["kind"];
      authority: ProfileAuthority;
      projectRoot: string;
      providerThreadId?: string;
    },
  ): PendingRuntimeReview {
    const pending = this.#runtimeReviews.get(review.reviewId);
    this.#runtimeReviews.delete(review.reviewId);
    if (
      pending === undefined
      || pending.review !== review
      || pending.review.kind !== expected.kind
      || !sameProfileAuthority(pending.running.authority, expected.authority)
      || pending.projectRoot !== expected.projectRoot
      || pending.providerThreadId !== expected.providerThreadId
      || this.#clients.get(expected.authority.id) !== pending.running
      || !this.#isCurrent(expected.authority)
      || this.#now() - pending.createdAt > 5_000
    ) {
      throw new CodexError("AUTHORITY_STALE", "The reviewed runtime profile is stale or belongs to another effect authority.");
    }
    return pending;
  }

  #policy(projectRoot: string) {
    return { review: "auto_review" as const, permissionProfile: ":workspace" as const, writableRoots: [projectRoot] };
  }
}
