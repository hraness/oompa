#!/usr/bin/env bun

import { dlopen } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { readSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  AttachmentIngestError,
  ingestAttachments,
} from "./daemon/attachment-ingest";
import { AttachmentBlobStore } from "./storage/attachment-store";
import type { AttachmentReference } from "./domain/attachments";
import {
  CliUsageError,
  accountLoginCancelCommand,
  accountLoginReplayCommand,
  claudeAccountLoginAbandonCommand,
  claudeAccountLoginCommand,
  completeProtectedAuthLogin,
  completeProtectedInteraction,
  deviceMutationReplayCommand,
  parseCli,
  projectionRecoveryReplayCommand,
  requestsJsonOutput,
  requestsJsonlOutput,
  requestsWorkApplyProtocol,
  resolveUsage,
  usageForGroup,
  type CliInvocation,
  type ProjectionRecoveryCliInvocation,
  type ProtectedInputSource,
  type RemoteCliCommand,
  type SessionExportCliInvocation,
} from "./cli/parser";
import {
  parseAccountLoginAuthorityList,
  parseAccountLoginResponse,
  parseProtectedInteractionDetailResponse,
  ProtectedOutputError,
  ProtectedOutputFile,
  type DeviceLoginDocument,
} from "./cli/protected-output";
import { InvalidCommandResponseError, renderFailure, renderProtectedInteractionDetail, renderRootStatus, renderSuccess, safeDiagnostic, safeJson, terminalSafe, type Output } from "./cli/render";
import { redactCompleteSensitiveText } from "./cli/sensitive-text";
import { compileShellLine, formatShellPrompt, shellHelp, type ShellSelection } from "./cli/shell";
import {
  enumerateUnsettledSessionInteractions,
  pendingInteractionStateKey,
  ShellLiveObserver,
  ShellLivePresenter,
  type PendingInteraction,
} from "./cli/shell-live";
import { discardReadableUntilEnd, ShellTerminalCoordinator } from "./cli/shell-terminal";
import { followSessionEvents } from "./cli/watch";
import { followWorkEvents } from "./cli/work-watch";
import { CloudDeploymentAliasConflictError, requireCloudDeploymentEnvironment } from "./domain/cloud-deployment-environment";
import {
  BridgedCloudControl,
  CloudDaemonJournalRecoveryBlocker,
  CustodyCloudDaemonJournal,
  StateBackedCloudDaemonAdapter,
  containsAbsolutePath,
  createCloudDaemonLifecycle,
  createCloudUuidV7,
  activeRemoteDerivedCodexSelection,
  activeRemotePresetSelection,
  cloudDeploymentAuthorityFromEnvironment,
  CloudDeploymentAuthorityError,
  createLocalCloudControlFromEnvironment,
  createLocalCloudDaemonBridgeFromEnvironment,
  DEFAULT_CLOUD_DEPLOYMENT_URL,
  DeploymentScopedCloudSecretCustody,
  IdentityScopedCloudSecretCustody,
  isRecord,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
  isUuidV7,
  hasExactKeys,
  projectionRecoveryStatusFromJournalState,
  readCloudDeploymentAuthority,
  redactAbsolutePaths,
  type CloudRemoteControlPort,
  type CloudRemoteSessionHead,
  type RemoteCommandPayload,
  type CloudDaemonLifecycle,
  type CloudDeploymentAuthority,
  type CloudProjectionRecoveryStatus,
  type CloudSecretCustodyPort,
  type CanonicalMemoryCloudAuthoritySource,
} from "./cloud/index";
import type { CanonicalMemoryTransport } from "./cloud/canonical-memory-transport";
import {
  allowlistedEnvironment,
  readCodexAutomationAuthority,
  resolvePinnedCodexRuntime,
  type CodexAutomationAuthorityRequest,
} from "./codex/index";
import {
  CLAUDE_PIN,
  ClaudeHostToolBindingAuthority,
  createClaudeLoginSignalCustody,
  resolvePinnedClaudeRuntime,
  runClaudeForegroundLogin,
  resolveClaudeLoginBrowserMode,
  spawnBunClaudeProcess,
  type ClaudeHostToolPublicResult,
  type ClaudeHostToolResponseWritten,
  type ClaudeForegroundLoginResult,
  type ClaudeLoginBrowserMode,
  type ClaudeLoginSignalCustody,
  type ClaudeLoginSignalSource,
  type PinnedClaudeRuntime,
  type ResolvePinnedClaudeRuntimeOptions,
} from "./claude/index";
import type { OompaHostToolCall } from "./codex/protocol";
import { localCommandSchema, type CommandResponse, type LocalCommand } from "./domain/contracts";
import { adoptableProviderSchema, type Provider } from "./domain/presets";
import {
  sessionTranscriptSchema,
  TRANSCRIPT_PAGE_LIMIT,
} from "./domain/transcript";
import { transcriptToTrajectory } from "./domain/trajectory";
import {
  PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES,
} from "./domain/interactions";
import { sessionStatusSchema } from "./domain/observation";
import {
  GATEWAY_KEY_MAX_BYTES,
  GATEWAY_KEY_MIN_BYTES,
  gatewayKeySchema,
  attemptIdSchema,
  profileIdSchema,
  selectByIdOrLabel,
  sessionIdSchema,
} from "./domain/values";
import {
  WORK_APPLY_REQUEST_LEGACY_VERSION,
  WORK_APPLY_REQUEST_VERSION,
  WORK_PROTOCOL_REQUEST_MAX_BYTES,
  WORK_PROTOCOL,
  workProtocolRequestSchema,
} from "./domain/work";
import {
  describeWorkProtocol,
  workAgentProtocolResponseSchema,
  type WorkAgentProtocolError,
} from "./domain/work-protocol";
import {
  LocalDaemonServer,
  LocalDaemonIndeterminateError,
  LocalDaemonShutdownTimeoutError,
  callLocalDaemon,
  callWithSafeAutostart,
  isLocalDaemonUnavailable,
} from "./daemon/local-transport";
import {
  DaemonAuthorityBusyError,
  DaemonAuthorityFence,
  DaemonAuthoritySafetyError,
  DaemonLock,
  inspectDaemonAuthority,
  readDaemonAuthorityReceipt,
  type DaemonAuthorityInspection,
  type DaemonAuthorityReceipt,
} from "./daemon/daemon-lock";
import {
  daemonStatusIdentity,
  identityFromReceipt,
  sameDaemonIdentity,
  terminateDaemonStartupChild,
  waitForDaemonAuthorityRelease,
  waitForDaemonReady,
  type DaemonIdentity,
} from "./daemon/daemon-startup";
import {
  ClaudeHostToolCallbackServer,
  claudeHostToolCallbackSocketPath,
} from "./daemon/claude-host-tool-transport";
import { PinnedClaudeRuntimeManager, type ClaudeProcessFactory } from "./daemon/claude-runtime-adapter";
import { observeClaudeProcess, type ClaudeProcessObservation } from "./claude/process-observation";
import { PinnedCodexRuntimeManager } from "./daemon/codex-runtime-adapter";
import {
  BoundedPersonalSessionDiscovery,
  createLocalClaudeProcessLivenessProbe,
  createPersonalClaudeDiscoveryAdapters,
  type ClaudeProcessLivenessProbe,
} from "./daemon/personal-session-discovery";
import { OompaFactsMemoryLifecycle } from "./daemon/facts-memory-lifecycle";
import {
  UnavailableCloudControl,
  type CloudControlPort,
  type CompactProjectionRecoveryBlocker,
  type ProfileAuthority,
} from "./daemon/ports";
import { SessionEventCursorCodec } from "./daemon/session-event-cursor";
import { CommandFailure, OompaService } from "./daemon/service";
import { AccountUsagePoller } from "./daemon/usage-poller";
import { UsageHistoryCursorCodec } from "./daemon/usage-history-cursor";
import {
  assertInstallationHome,
  createProductionInstallation,
  type OompaInstallation,
} from "./installation";
import {
  initializeStatePaths,
  initializeProfilePaths,
  ensurePrivateDirectory,
  profilePaths,
  resolveStatePaths,
  type StatePaths,
} from "./storage/paths";
import { FactsMemoryControlStore } from "./storage/facts-memory-control";
import { LocalFactsMemoryBroker } from "./storage/local-facts-memory-broker";
import { resolveUsableCanonicalProjectDirectory } from "./storage/project-directory";
import { CustodyGatewayKeyStore } from "./storage/gateway-key-custody";
import { AiGatewayProseResponder } from "./daemon/prose-responder";
import type { GenerationalSecretCustody } from "./storage/secret-custody";
import { StateStore } from "./storage/state-store";
import { WorkCapabilityCodec } from "./storage/work-capability";
import { OOMPA_VERSION } from "./version";
import { ClaudeLaunchIntentLivenessProbe } from "./claude/process";

const writeProcessStdoutAsync = (value: string, signal: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error === undefined || error === null) resolve();
      else reject(error);
    };
    const onAbort = (): void => finish(
      signal.reason ?? new DOMException("Session event output was aborted.", "AbortError"),
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      process.stdout.write(value, (error) => finish(error));
    } catch (error: unknown) {
      finish(error);
    }
  });

const processOutput: Output = {
  writeStdout: (value) => process.stdout.write(value),
  writeStdoutAsync: writeProcessStdoutAsync,
  writeStderr: (value) => process.stderr.write(value),
  writeProtectedStderr: (value) => process.stderr.write(value),
};

const protectedInputMaximumBytes = 64 * 1024;
export const HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES = 1 * 1024 * 1024;
const humanSessionWatchUtf8Encoder = new TextEncoder();
const sessionCursorCustodySlot = "session-cursor-key";

export const protectedTerminalInputQueueForPlatform = (
  platform: NodeJS.Platform,
): 0 | 1 | null => platform === "darwin" ? 1 : platform === "linux" ? 0 : null;

const terminalInputQueue = protectedTerminalInputQueueForPlatform(process.platform);

export const protectedTerminalControlLibrariesForPlatform = (
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): readonly string[] => {
  if (platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (platform !== "linux") return [];
  const muslArchitecture = architecture === "x64"
    ? "x86_64"
    : architecture === "arm64"
      ? "aarch64"
      : null;
  if (muslArchitecture === null) return ["libc.so.6"];
  const muslLibrary = `libc.musl-${muslArchitecture}.so.1`;
  return [
    "libc.so.6",
    muslLibrary,
    `/lib/${muslLibrary}`,
    `/usr/lib/${muslLibrary}`,
  ];
};

type NativeTerminalControlLibrary = Readonly<{
  symbols: Readonly<{
    tcflush: (fd: number, queue: number) => number;
  }>;
}>;

let nativeTerminalControlLibrary: NativeTerminalControlLibrary | null | undefined;

const loadNativeTerminalControlLibrary = (): NativeTerminalControlLibrary | null => {
  if (nativeTerminalControlLibrary !== undefined) return nativeTerminalControlLibrary;
  nativeTerminalControlLibrary = null;
  for (const library of protectedTerminalControlLibrariesForPlatform(process.platform, process.arch)) {
    try {
      nativeTerminalControlLibrary = dlopen(library, {
        tcflush: { args: ["i32", "i32"], returns: "i32" },
      });
      break;
    } catch {
      // Try the next platform libc name. Protected input fails closed if none load.
    }
  }
  return nativeTerminalControlLibrary;
};

const flushProtectedTerminalInput = (fd: number): void => {
  const library = loadNativeTerminalControlLibrary();
  if (library === null || terminalInputQueue === null) {
    throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
  }
  try {
    if (library.symbols.tcflush(fd, terminalInputQueue) === 0) return;
  } catch {
    // Preserve the same fail-closed, non-native diagnostic below.
  }
  throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
};

const decodeProtectedJson = (
  bytes: Buffer,
  maximumBytes = protectedInputMaximumBytes,
): unknown => {
  if (bytes.byteLength === 0) throw new CliUsageError("Protected input is empty.");
  if (bytes.byteLength > maximumBytes) {
    throw new CliUsageError(`Protected input exceeds ${String(maximumBytes)} UTF-8 bytes.`);
  }
  try {
    const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(source) as unknown;
  } catch {
    throw new CliUsageError("Protected input must be one valid UTF-8 JSON document.");
  } finally {
    bytes.fill(0);
  }
};

const readBoundedDescriptor = (
  fd: number,
  maximumBytes = protectedInputMaximumBytes,
): Buffer => {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, maximumBytes + 1 - total));
      const read = readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) {
        chunk.fill(0);
        break;
      }
      chunks.push(chunk.subarray(0, read));
      total += read;
      if (total > maximumBytes) {
        throw new CliUsageError(`Protected input exceeds ${String(maximumBytes)} UTF-8 bytes.`);
      }
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
  }
};

type RawTerminalLineResult =
  | Readonly<{ bytes: Buffer; kind: "line" }>
  | Readonly<{ kind: "cancelled" | "ended" | "overflow" | "quit" | "suspended" }>;

class ProtectedTerminalRawSignalRequest extends Error {
  readonly signal: "SIGQUIT" | "SIGTSTP";

  constructor(signal: "SIGQUIT" | "SIGTSTP") {
    super(signal === "SIGTSTP"
      ? "Protected terminal input was suspended."
      : "Protected terminal input was interrupted by SIGQUIT.");
    this.name = "ProtectedTerminalRawSignalRequest";
    this.signal = signal;
  }
}

const bestEffortStderr = (output: Output, value: string): boolean => {
  try {
    output.writeStderr(value);
    return true;
  } catch {
    // Protected-input custody must not depend on display availability.
    return false;
  }
};

const abortRequested = (signal?: AbortSignal): boolean => signal?.aborted ?? false;
const rawSignalTailQuietMilliseconds = 50;
const rawSignalTailMaximumMilliseconds = 500;

const discardReadableNow = (input: NodeJS.ReadableStream): number => {
  const readable = input as unknown as {
    read(size?: number): Buffer | string | null;
  };
  let discarded = 0;
  for (;;) {
    const value = readable.read();
    if (value === null) return discarded;
    discarded += 1;
    if (Buffer.isBuffer(value)) value.fill(0);
  }
};

const readBoundedRawTerminalLine = (
  input: NodeJS.ReadableStream,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<RawTerminalLineResult> => new Promise((resolve) => {
  const storage = Buffer.alloc(maximumBytes + 1);
  let length = 0;
  let settled = false;
  const finish = (result: RawTerminalLineResult): void => {
    if (settled) {
      if (result.kind === "line") result.bytes.fill(0);
      return;
    }
    settled = true;
    input.off("data", onData);
    input.off("end", onEnded);
    input.off("error", onEnded);
    input.off("close", onEnded);
    signal?.removeEventListener("abort", onAbort);
    input.pause();
    storage.fill(0);
    resolve(result);
  };
  const onEnded = (): void => finish({ kind: "ended" });
  const onAbort = (): void => finish({ kind: "cancelled" });
  const onData = (value: unknown): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    let result: RawTerminalLineResult | null = null;
    for (const byte of chunk) {
      if (byte === 0x03) {
        result = { kind: "cancelled" };
        break;
      }
      if (byte === 0x04) {
        result = { kind: "ended" };
        break;
      }
      if (byte === 0x1a) {
        result = { kind: "suspended" };
        break;
      }
      if (byte === 0x1c) {
        result = { kind: "quit" };
        break;
      }
      if (byte === 0x0a || byte === 0x0d) {
        result = { bytes: Buffer.from(storage.subarray(0, length)), kind: "line" };
        break;
      }
      if (byte === 0x08 || byte === 0x7f) {
        if (length > 0) {
          let removeFrom = length - 1;
          while (removeFrom > 0 && ((storage[removeFrom] ?? 0) & 0xc0) === 0x80) removeFrom -= 1;
          storage.fill(0, removeFrom, length);
          length = removeFrom;
        }
        continue;
      }
      if (length >= maximumBytes) {
        result = { kind: "overflow" };
        break;
      }
      storage[length] = byte;
      length += 1;
    }
    chunk.fill(0);
    if (result !== null) finish(result);
  };
  input.on("data", onData);
  input.once("end", onEnded);
  input.once("error", onEnded);
  input.once("close", onEnded);
  signal?.addEventListener("abort", onAbort, { once: true });
  const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
  if (signal?.aborted === true) {
    finish({ kind: "cancelled" });
    return;
  }
  if (state.destroyed === true || state.readableEnded === true) {
    finish({ kind: "ended" });
    return;
  }
  input.resume();
});

const drainRawTerminalUntilQuiet = (
  input: NodeJS.ReadableStream,
  quietMilliseconds = 20,
  maximumMilliseconds = 500,
  signal?: AbortSignal,
): Promise<"cancelled" | "continuous" | "ended" | "quiet" | "quit" | "suspended"> => new Promise((resolve) => {
  let settled = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const maximumTimer = setTimeout(() => finish("continuous"), maximumMilliseconds);
  const armQuietTimer = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => finish("quiet"), quietMilliseconds);
  };
  const finish = (result: "cancelled" | "continuous" | "ended" | "quiet" | "quit" | "suspended"): void => {
    if (settled) return;
    settled = true;
    if (quietTimer !== null) clearTimeout(quietTimer);
    clearTimeout(maximumTimer);
    input.off("data", onData);
    input.off("end", onEnded);
    input.off("error", onEnded);
    input.off("close", onEnded);
    signal?.removeEventListener("abort", onAbort);
    input.pause();
    resolve(result);
  };
  const onEnded = (): void => finish("ended");
  const onAbort = (): void => finish("cancelled");
  const onData = (value: unknown): void => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
    const cancelled = chunk.includes(0x03);
    const ended = chunk.includes(0x04);
    const suspended = chunk.includes(0x1a);
    const quit = chunk.includes(0x1c);
    chunk.fill(0);
    if (cancelled) {
      finish("cancelled");
      return;
    }
    if (suspended) {
      finish("suspended");
      return;
    }
    if (quit) {
      finish("quit");
      return;
    }
    if (ended) {
      finish("ended");
      return;
    }
    armQuietTimer();
  };
  input.on("data", onData);
  input.once("end", onEnded);
  input.once("error", onEnded);
  input.once("close", onEnded);
  signal?.addEventListener("abort", onAbort, { once: true });
  const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
  if (signal?.aborted === true) {
    finish("cancelled");
    return;
  }
  if (state.destroyed === true || state.readableEnded === true) {
    finish("ended");
    return;
  }
  armQuietTimer();
  input.resume();
});

const discardRawSignalTailUntilQuiet = (
  input: NodeJS.ReadableStream,
  quietMilliseconds = 20,
  maximumMilliseconds = 500,
  signal?: AbortSignal,
): Promise<"cancelled" | "continuous" | "ended" | "quiet"> => new Promise((resolve) => {
  let settled = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  const maximumTimer = setTimeout(() => finish("continuous"), maximumMilliseconds);
  const armQuietTimer = (): void => {
    if (quietTimer !== null) clearTimeout(quietTimer);
    quietTimer = setTimeout(() => finish("quiet"), quietMilliseconds);
  };
  const finish = (result: "cancelled" | "continuous" | "ended" | "quiet"): void => {
    if (settled) return;
    settled = true;
    if (quietTimer !== null) clearTimeout(quietTimer);
    clearTimeout(maximumTimer);
    input.off("data", onData);
    input.off("end", onEnded);
    input.off("error", onEnded);
    input.off("close", onEnded);
    signal?.removeEventListener("abort", onAbort);
    input.pause();
    resolve(result);
  };
  const onEnded = (): void => finish("ended");
  const onAbort = (): void => finish("cancelled");
  const onData = (value: unknown): void => {
    if (Buffer.isBuffer(value)) value.fill(0);
    armQuietTimer();
  };
  input.on("data", onData);
  input.once("end", onEnded);
  input.once("error", onEnded);
  input.once("close", onEnded);
  signal?.addEventListener("abort", onAbort, { once: true });
  const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
  if (signal?.aborted === true) {
    finish("cancelled");
    return;
  }
  if (state.destroyed === true || state.readableEnded === true) {
    finish("ended");
    return;
  }
  armQuietTimer();
  input.resume();
});

const discardRawTerminalUntilExit = (
  input: NodeJS.ReadableStream,
  signal?: AbortSignal,
): Promise<"continuous" | "exited" | "quit" | "suspended"> =>
  new Promise((resolve) => {
    let settled = false;
    let requestedSignal: "quit" | "suspended" | null = null;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;
    let maximumTimer: ReturnType<typeof setTimeout> | null = null;
    const armSignalQuietTimer = (): void => {
      if (quietTimer !== null) clearTimeout(quietTimer);
      quietTimer = setTimeout(
        () => finish(requestedSignal ?? "continuous"),
        rawSignalTailQuietMilliseconds,
      );
      maximumTimer ??= setTimeout(() => finish("continuous"), rawSignalTailMaximumMilliseconds);
    };
    const finish = (
      result: "continuous" | "exited" | "quit" | "suspended" = "exited",
    ): void => {
      if (settled) return;
      settled = true;
      if (quietTimer !== null) clearTimeout(quietTimer);
      if (maximumTimer !== null) clearTimeout(maximumTimer);
      input.off("data", onData);
      input.off("end", onEnded);
      input.off("error", onEnded);
      input.off("close", onEnded);
      signal?.removeEventListener("abort", onEnded);
      input.pause();
      resolve(result);
    };
    const onEnded = (): void => finish();
    const onData = (value: unknown): void => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
      const suspended = chunk.includes(0x1a);
      const quit = chunk.includes(0x1c);
      const exitRequested = chunk.includes(0x03) || chunk.includes(0x04);
      chunk.fill(0);
      if (requestedSignal !== null) {
        armSignalQuietTimer();
      } else if (suspended || quit) {
        requestedSignal = suspended ? "suspended" : "quit";
        armSignalQuietTimer();
      } else if (exitRequested) {
        finish();
      }
    };
    input.on("data", onData);
    input.once("end", onEnded);
    input.once("error", onEnded);
    input.once("close", onEnded);
    signal?.addEventListener("abort", onEnded, { once: true });
    const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
    if (signal?.aborted === true || state.destroyed === true || state.readableEnded === true) {
      finish();
      return;
    }
    input.resume();
  });

export const readHiddenProtectedLineFromTerminal = async (
  input: NodeJS.ReadableStream,
  output: Output,
  flushInput: () => void,
  signal?: AbortSignal,
): Promise<Buffer> => {
  if (signal?.aborted === true) {
    throw new CliUsageError("Protected terminal input is unavailable because the shell terminal closed.");
  }
  try {
    discardReadableNow(input);
    flushInput();
    discardReadableNow(input);
  } catch {
    const noticeVisible = bestEffortStderr(output,
      "Protected input cannot prove an empty terminal queue. Oompa will discard input until EOF; press Ctrl-D to return safely.\n",
    );
    if (!noticeVisible || await discardReadableUntilEnd(input, signal) === "aborted") {
      input.pause();
      discardReadableNow(input);
      (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
    throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
  }
  const tty = input as NodeJS.ReadableStream & {
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  if (typeof tty.setRawMode !== "function") {
    throw new CliUsageError("Protected terminal input cannot establish raw no-echo mode.");
  }
  const wasRaw = tty.isRaw === true;
  let rawModeActive = false;
  let promptWritten = false;
  const displayState = { requiredAvailable: true };
  let pendingAnswer: Buffer | null = null;
  let releaseAnswer = false;
  const writeRequiredPrompt = (value: string): void => {
    try {
      output.writeStderr(value);
    } catch {
      displayState.requiredAvailable = false;
      throw new CliUsageError("Protected terminal input closed because its prompt became unavailable.");
    }
  };
  const restoreRawMode = (): void => {
    if (!rawModeActive) return;
    let lastFailure: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        tty.setRawMode?.(wasRaw);
        if (tty.isRaw === wasRaw) {
          rawModeActive = false;
          return;
        }
      } catch (error: unknown) {
        lastFailure = error;
        if (tty.isRaw === wasRaw) {
          rawModeActive = false;
          return;
        }
      }
    }
    input.pause();
    discardReadableNow(input);
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    rawModeActive = false;
    throw new CliUsageError(
      lastFailure === null
        ? "Protected terminal input was closed because raw mode could not be restored."
        : "Protected terminal input was closed because raw mode restoration failed.",
    );
  };
  let rawActivationProved = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      tty.setRawMode(true);
      if (tty.isRaw === true) {
        rawActivationProved = true;
        break;
      }
    } catch {
      if (tty.isRaw === true) {
        rawActivationProved = true;
        break;
      }
    }
  }
  if (!rawActivationProved) {
    discardReadableNow(input);
    try {
      flushInput();
      discardReadableNow(input);
    } catch {
      // Fencing the stream below does not depend on a successful final flush.
    }
    bestEffortStderr(output,
      "Protected terminal input could not disable echo. Oompa closed this shell input before reading protected bytes.\n");
    input.pause();
    (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    throw new CliUsageError("Protected terminal input could not establish raw no-echo mode.");
  }
  rawModeActive = true;
  try {
    const beginPhrase = `BEGIN-${randomUUID().slice(0, 6).toUpperCase()}`;
    const beginPhraseBytes = Buffer.from(beginPhrase, "utf8");
    writeRequiredPrompt(
      `Protected input is hidden. Type ${beginPhrase} and press Enter to begin (input remains hidden): `,
    );
    promptWritten = true;
    let readinessAttempts = 0;
    let readinessBytes = 0;
    for (;;) {
      const readiness = await readBoundedRawTerminalLine(input, 4 * 1_024, signal);
      if (readiness.kind === "line") {
        readinessAttempts += 1;
        readinessBytes += readiness.bytes.byteLength;
        const accepted = readiness.bytes.equals(beginPhraseBytes);
        readiness.bytes.fill(0);
        if (accepted) break;
        if (readinessAttempts >= 8 || readinessBytes > 8 * 1_024) {
          beginPhraseBytes.fill(0);
          bestEffortStderr(output,
            "\nhra: Protected-input readiness could not prove a human handoff. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
          throw new CliUsageError("Protected terminal input could not establish a bounded readiness handoff.");
        }
        writeRequiredPrompt(`\nhra: Queued input was discarded. Type ${beginPhrase} and press Enter: `);
        continue;
      }
      if (readiness.kind === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
      if (readiness.kind === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
      if (readiness.kind === "cancelled") {
        throw new CliUsageError("Protected interaction input was cancelled.");
      }
      if (readiness.kind === "ended") {
        throw new CliUsageError("Protected terminal input ended before a document was received.");
      }
      bestEffortStderr(output,
        "\nhra: Protected-input readiness exceeded its bound. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
      throw new CliUsageError("Protected-input readiness exceeded its bounded line size.");
    }
    beginPhraseBytes.fill(0);
    const quiet = await drainRawTerminalUntilQuiet(input, 20, 500, signal);
    if (quiet === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
    if (quiet === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
    if (quiet === "cancelled") throw new CliUsageError("Protected interaction input was cancelled.");
    if (quiet === "ended") {
      throw new CliUsageError("Protected terminal input ended before a document was received.");
    }
    if (quiet === "continuous") {
      bestEffortStderr(output,
        "\nhra: Protected input did not become quiet. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
      throw new CliUsageError("Protected terminal input could not establish a quiet input boundary.");
    }
    discardReadableNow(input);
    try {
      flushInput();
      discardReadableNow(input);
    } catch {
      bestEffortStderr(output,
        "\nhra: Protected input cannot prove an empty terminal queue. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
      throw new CliUsageError("Protected terminal input could not establish an empty input queue.");
    }
    writeRequiredPrompt("\nProtected JSON input (hidden): ");
    const answer = await readBoundedRawTerminalLine(input, protectedInputMaximumBytes, signal);
    if (answer.kind === "line") {
      pendingAnswer = answer.bytes;
      const resumePhrase = `RESUME-${randomUUID().slice(0, 6).toUpperCase()}`;
      const resumePhraseBytes = Buffer.from(resumePhrase, "utf8");
      writeRequiredPrompt(
        `\nProtected input captured. Type ${resumePhrase} and press Enter to return to Oompa (input remains hidden): `,
      );
      let handoffAttempts = 0;
      let handoffBytes = 0;
      for (;;) {
        const handoff = await readBoundedRawTerminalLine(input, 128, signal);
        if (handoff.kind === "line") {
          handoffAttempts += 1;
          handoffBytes += handoff.bytes.byteLength;
          const accepted = handoff.bytes.equals(resumePhraseBytes);
          handoff.bytes.fill(0);
          if (accepted) break;
          if (handoffAttempts >= 8 || handoffBytes > 1_024) {
            resumePhraseBytes.fill(0);
            answer.bytes.fill(0);
            bestEffortStderr(output,
              "\nhra: Protected-input return could not prove a human handoff. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
            throw new CliUsageError("Protected terminal input could not establish a bounded return handoff.");
          }
          writeRequiredPrompt(`\nhra: Trailing input was discarded. Type ${resumePhrase} and press Enter: `);
          continue;
        }
        answer.bytes.fill(0);
        if (handoff.kind === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
        if (handoff.kind === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
        if (handoff.kind === "cancelled") {
          throw new CliUsageError("Protected interaction input was cancelled.");
        }
        if (handoff.kind === "ended") {
          throw new CliUsageError("Protected terminal input ended before custody was returned.");
        }
        bestEffortStderr(output,
          "\nhra: Protected-input handoff exceeded its bound. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
        throw new CliUsageError("Protected terminal input could not establish a bounded handoff.");
      }
      resumePhraseBytes.fill(0);
      const trailing = await drainRawTerminalUntilQuiet(input, 20, 500, signal);
      if (trailing === "suspended") {
        answer.bytes.fill(0);
        throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
      }
      if (trailing === "quit") {
        answer.bytes.fill(0);
        throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
      }
      if (trailing === "ended") {
        releaseAnswer = true;
        return answer.bytes;
      }
      if (trailing === "cancelled") {
        answer.bytes.fill(0);
        throw new CliUsageError("Protected interaction input was cancelled.");
      }
      if (trailing === "continuous") {
        answer.bytes.fill(0);
        bestEffortStderr(output,
          "\nhra: Protected input retained a continuing tail. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
        throw new CliUsageError("Protected terminal input could not establish a quiet trailing boundary.");
      }
      discardReadableNow(input);
      try {
        flushInput();
        discardReadableNow(input);
      } catch {
        answer.bytes.fill(0);
        bestEffortStderr(output,
          "\nhra: Protected input cannot prove an empty trailing queue. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
        throw new CliUsageError("Protected terminal input could not establish an empty trailing queue.");
      }
      releaseAnswer = true;
      return answer.bytes;
    }
    if (answer.kind === "suspended") throw new ProtectedTerminalRawSignalRequest("SIGTSTP");
    if (answer.kind === "quit") throw new ProtectedTerminalRawSignalRequest("SIGQUIT");
    if (answer.kind === "cancelled") {
      throw new CliUsageError("Protected interaction input was cancelled.");
    }
    if (answer.kind === "ended") {
      throw new CliUsageError("Protected terminal input ended before a document was received.");
    }
    bestEffortStderr(output,
      "\nhra: Protected input exceeded its bound. Oompa will discard input until EOF; press Ctrl-D to return safely.\n");
    throw new CliUsageError(`Protected input exceeds ${String(protectedInputMaximumBytes)} UTF-8 bytes.`);
  } catch (error: unknown) {
    const state = input as NodeJS.ReadableStream & { destroyed?: unknown; readableEnded?: unknown };
    let failure = error;
    if (error instanceof ProtectedTerminalRawSignalRequest) {
      const tail = state.destroyed === true || state.readableEnded === true
        ? "ended"
        : await discardRawSignalTailUntilQuiet(
            input,
            rawSignalTailQuietMilliseconds,
            rawSignalTailMaximumMilliseconds,
            signal,
          );
      let boundaryProved = tail === "ended" || tail === "quiet";
      discardReadableNow(input);
      if (boundaryProved) {
        try {
          flushInput();
          discardReadableNow(input);
        } catch {
          boundaryProved = false;
        }
      }
      if (!boundaryProved) {
        bestEffortStderr(output,
          "\nhra: Protected input could not prove a quiet signal boundary. Oompa closed this shell input without re-signalling.\n");
        failure = new CliUsageError(
          "Protected terminal input could not establish a quiet signal boundary.",
        );
      }
      restoreRawMode();
      if (state.destroyed !== true) {
        (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      }
    } else if (state.destroyed !== true && state.readableEnded !== true) {
      const immediateFence = !displayState.requiredAvailable || abortRequested(signal);
      if (!immediateFence) {
        bestEffortStderr(output,
          "\nhra: Protected input remains hidden while Oompa discards its tail. Press Ctrl-D or Ctrl-C; Oompa will then close this shell input safely.\n");
        const exit = await discardRawTerminalUntilExit(input, signal);
        if (exit === "suspended") {
          failure = new ProtectedTerminalRawSignalRequest("SIGTSTP");
        } else if (exit === "quit") {
          failure = new ProtectedTerminalRawSignalRequest("SIGQUIT");
        } else if (exit === "continuous") {
          failure = new CliUsageError(
            "Protected terminal input could not establish a quiet signal boundary.",
          );
        }
      }
      discardReadableNow(input);
      try {
        flushInput();
        discardReadableNow(input);
      } catch {
        if (failure instanceof ProtectedTerminalRawSignalRequest) {
          failure = new CliUsageError(
            "Protected terminal input could not establish an empty signal boundary.",
          );
        }
      }
      restoreRawMode();
      (input as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
    }
    throw failure;
  } finally {
    let rawRestored = false;
    try {
      restoreRawMode();
      rawRestored = true;
    } finally {
      if (!rawRestored || !releaseAnswer) pendingAnswer?.fill(0);
      input.pause();
      if (promptWritten) bestEffortStderr(output, "\n");
    }
  }
};

const readHiddenProtectedLine = async (output: Output, signal?: AbortSignal): Promise<Buffer> =>
  await readHiddenProtectedLineFromTerminal(
    process.stdin,
    output,
    () => flushProtectedTerminalInput(0),
    signal,
  );

const readProtectedDocument = async (
  source: ProtectedInputSource,
  output: Output,
  signal?: AbortSignal,
  maximumBytes = protectedInputMaximumBytes,
): Promise<unknown> => {
  const fd = source.kind === "stdin" ? 0 : source.fd;
  let bytes: Buffer;
  try {
    if (isatty(fd)) {
      if (fd !== 0) {
        throw new CliUsageError("Protected input from a terminal is supported only through stdin.");
      }
      bytes = await readHiddenProtectedLine(output, signal);
    } else {
      bytes = readBoundedDescriptor(fd, maximumBytes);
    }
  } catch (error: unknown) {
    if (error instanceof CliUsageError) throw error;
    throw new CliUsageError("Protected input could not be read from the selected descriptor.");
  }
  return decodeProtectedJson(bytes, maximumBytes);
};

export type ProtectedTerminalLifecycleHooks = Readonly<{
  onOutputFailure: (listener: () => void) => () => void;
  onSignal: (signal: NodeJS.Signals, listener: () => void) => () => void;
  resignal: (signal: NodeJS.Signals) => void;
}>;

const processProtectedTerminalLifecycleHooks: ProtectedTerminalLifecycleHooks = {
  onOutputFailure: (listener) => {
    process.stderr.once("error", listener);
    process.stderr.once("close", listener);
    const state = process.stderr as NodeJS.WritableStream & { destroyed?: unknown };
    if (state.destroyed === true) listener();
    return () => {
      process.stderr.off("error", listener);
      process.stderr.off("close", listener);
    };
  },
  onSignal: (signal, listener) => {
    process.once(signal, listener);
    return () => process.off(signal, listener);
  },
  resignal: (signal) => process.kill(process.pid, signal),
};

const protectedTerminalLifecycleSignals: readonly NodeJS.Signals[] = process.platform === "win32"
  ? ["SIGINT", "SIGTERM"]
  : ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGTSTP"];

export const withProtectedTerminalLifecycle = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal?: AbortSignal,
  hooks: ProtectedTerminalLifecycleHooks = processProtectedTerminalLifecycleHooks,
): Promise<T> => {
  const controller = new AbortController();
  const removers: (() => void)[] = [];
  const lifecycleState: { receivedSignal: NodeJS.Signals | null } = { receivedSignal: null };
  const abortForOutput = (): void => controller.abort(
    new CliUsageError("Protected terminal input closed because its prompt output became unavailable."),
  );
  const abortForParent = (): void => controller.abort(
    parentSignal?.reason ?? new CliUsageError("Protected terminal input lifecycle ended."),
  );
  try {
    removers.push(hooks.onOutputFailure(abortForOutput));
    for (const signal of protectedTerminalLifecycleSignals) {
      removers.push(hooks.onSignal(signal, () => {
        if (lifecycleState.receivedSignal === null) lifecycleState.receivedSignal = signal;
        controller.abort(new CliUsageError(`Protected terminal input interrupted by ${signal}.`));
      }));
    }
    if (parentSignal !== undefined) {
      parentSignal.addEventListener("abort", abortForParent, { once: true });
      removers.push(() => parentSignal.removeEventListener("abort", abortForParent));
      if (parentSignal.aborted) abortForParent();
    }
    try {
      return await operation(controller.signal);
    } catch (error: unknown) {
      if (error instanceof ProtectedTerminalRawSignalRequest && lifecycleState.receivedSignal === null) {
        lifecycleState.receivedSignal = error.signal;
      }
      throw error;
    }
  } finally {
    for (const remove of removers.reverse()) remove();
    if (lifecycleState.receivedSignal !== null) {
      try {
        hooks.resignal(lifecycleState.receivedSignal);
      } catch {
        // Raw mode has already been restored or fenced; signal delivery is best effort.
      }
    }
  }
};

class CursorAuthorityMissingError extends Error {
  constructor() {
    super(
      "Session event cursor authority is missing for existing Oompa state. Restore the original local secret before starting the daemon.",
    );
    this.name = "CursorAuthorityMissingError";
  }
}

async function resolveCursorAuthorityKey(
  custody: GenerationalSecretCustody,
  allowInitialization: boolean,
): Promise<string> {
  let observation = await custody.read(sessionCursorCustodySlot);
  if (observation === null) {
    if (!allowInitialization) {
      throw new CursorAuthorityMissingError();
    }
    observation = await custody.compareAndSwap(
      sessionCursorCustodySlot,
      null,
      SessionEventCursorCodec.generateKey(),
    );
    if (observation === null) observation = await custody.read(sessionCursorCustodySlot);
  }
  if (observation === null) throw new Error("Session event cursor authority could not be initialized.");
  return observation.value;
}

export async function resolveSessionEventCursorCodec(
  custody: GenerationalSecretCustody,
  options: Readonly<{ allowInitialization?: boolean }> = {},
): Promise<SessionEventCursorCodec> {
  return new SessionEventCursorCodec(await resolveCursorAuthorityKey(
    custody,
    options.allowInitialization ?? true,
  ));
}

export async function resolveUsageHistoryCursorCodec(
  custody: GenerationalSecretCustody,
  options: Readonly<{ allowInitialization?: boolean }> = {},
): Promise<UsageHistoryCursorCodec> {
  return new UsageHistoryCursorCodec(await resolveCursorAuthorityKey(
    custody,
    options.allowInitialization ?? true,
  ));
}

export async function resolveWorkCapabilityCodec(
  custody: GenerationalSecretCustody,
  options: Readonly<{ allowInitialization?: boolean }> = {},
): Promise<WorkCapabilityCodec> {
  const encoded = await resolveCursorAuthorityKey(
    custody,
    options.allowInitialization ?? true,
  );
  const key = Buffer.from(encoded, "base64url");
  if (key.toString("base64url") !== encoded) {
    throw new Error("Work capability authority is not canonical base64url.");
  }
  return new WorkCapabilityCodec(key);
}

const syncDiagnosticLimit = 16;
const syncDiagnosticMaximumBytes = 768;
const syncDiagnosticTruncationMarker = " [truncated]";
const privateKeyHeaderPattern = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/iu;
const secretLabelPattern = /(?:\bBearer\b|\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|authorization)\b|\b(?:sk|re)_|\beyJ)/iu;
const unsafeTerminalScalarPattern = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const underscoreAbsolutePathPattern = /(^|_)((?:file:\/\/+|~\/|[A-Za-z]:[\\/]|\\\\[^\\/\s"'`<>{}[\](),;]+[\\/]|\/(?!\/))[^\s"'`<>{}[\](),;_]*)/giu;

type SyncNowSummary = Readonly<{
  commandRequestVersion: 2 | null;
  online: boolean;
  commandsApplied: number;
  commandsUnsettled: number;
  sessionsUploaded: number;
  usageUploaded: number;
  errorCount: number;
  errors: readonly string[];
  errorsOmitted: number;
}>;

type ProjectionRecoverySummary =
  | Readonly<{
      boundaryHead: number;
      gapRemainsVisible: true;
      idempotencyKey: string;
      newEpoch: number;
      oldEpoch: number;
      phase: "applied";
      sameKeyReplay: Readonly<{
        command: string;
        supported: true;
      }>;
      session: string;
    }>
  | Readonly<{
      idempotencyKey: string;
      nextCommand: "oompa sync status --json";
      phase: "rejected";
      rejectionCode: string;
      sameKeyReplay: Readonly<{
        command: string;
        supported: true;
      }>;
      session: string;
    }>;

type DaemonStopCommand = Extract<LocalCommand, { kind: "daemon.stop" }>;
type BoundDaemonStopCommand = DaemonStopCommand & Readonly<{ expected: DaemonIdentity }>;
type DaemonStopResponseError = Extract<CommandResponse, { ok: false }>["error"];
type DaemonReleaseObservation = Awaited<ReturnType<typeof waitForDaemonAuthorityRelease>>;

export type DaemonStopDependencies = Readonly<{
  requestStop(input: Readonly<{
    paths: StatePaths;
    command: BoundDaemonStopCommand;
    deadlineMs: number;
  }>): Promise<CommandResponse>;
  observeReceipt(paths: StatePaths): Promise<DaemonAuthorityReceipt | null>;
  waitForRelease(input: Readonly<{
    paths: StatePaths;
    expected: DaemonIdentity;
  }>): Promise<DaemonReleaseObservation>;
  inspectAuthority(paths: StatePaths): Promise<DaemonAuthorityInspection>;
  authorityHeld(paths: StatePaths): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
}>;

export type DaemonStopResult =
  | Readonly<{ kind: "success"; data: Readonly<Record<string, unknown>> }>
  | Readonly<{ kind: "failure"; error: DaemonStopResponseError }>;

export type DaemonReadyStatus = Readonly<{
  running: true;
  pid: number;
  daemon: DaemonIdentity;
}>;

export type CliMainInput = Readonly<{
  installation?: OompaInstallation;
  startDaemon?: (installation: OompaInstallation) => Promise<DaemonReadyStatus>;
  statePaths?: StatePaths;
  callDaemon?: (command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>;
  daemonStopDependencies?: DaemonStopDependencies;
  getRemoteCommandStatus?: CloudRemoteControlPort["getRemoteCommandStatus"];
  interactive?: boolean;
  isTerminalDescriptor?: (fd: number) => boolean;
  readProtectedDocument?: (source: ProtectedInputSource) => Promise<unknown>;
  readShellLine?: (prompt: string) => Promise<string | null>;
  readRootStatus?: (paths: StatePaths) => unknown;
  offlineDoctorOwnerUid?: number;
  sessionObserverSignalMode?: "process" | "foreground_interrupt";
  /** Where a relative `--attach` path is resolved from. Defaults to the process cwd. */
  attachmentCwd?: string;
  attachmentBlobStore?: AttachmentBlobStore;
  /** Narrow test seam around Claude's foreground-only authentication command. */
  runClaudeForegroundLogin?: (input: Readonly<{
    browserMode: ClaudeLoginBrowserMode;
    configDir: string;
    signal: AbortSignal;
    signalCustody: ClaudeLoginSignalCustody;
    stdio: Readonly<{ stderr: number; stdin: number; stdout: number }>;
    runtime: PinnedClaudeRuntime;
  }>) => Promise<ClaudeForegroundLoginResult>;
  /** Test seam for grant-bound terminal-signal custody. */
  claudeLoginSignalSource?: ClaudeLoginSignalSource;
  resolveClaudeRuntime?: (options: ResolvePinnedClaudeRuntimeOptions) => Promise<PinnedClaudeRuntime>;
  onHumanSessionObserverBootstrap?: (bootstrap: Readonly<{
    interactions: readonly Readonly<{
      id: string;
      revision: number;
      state: PendingInteraction["state"];
    }>[];
    sessionId: string;
  }>) => void;
}>;

const daemonStopRequestDeadlineMs = 5_000;
const daemonReleaseSettleIntervalMs = 25;
const invalidDaemonAuthorityMessage = "The daemon authority database is invalid and requires manual recovery.";

const defaultDaemonStopDependencies: DaemonStopDependencies = {
  requestStop: async (input) => await callLocalDaemon(input),
  observeReceipt: async (paths) => await readDaemonAuthorityReceipt(paths),
  waitForRelease: async (input) => await waitForDaemonAuthorityRelease(input),
  inspectAuthority: async (paths) => await inspectDaemonAuthority(paths),
  authorityHeld: async (paths) => await DaemonLock.isAuthorityHeld(paths),
  sleep: async (milliseconds) => { await Bun.sleep(milliseconds); },
};

type DaemonReleaseProof =
  | Readonly<{ kind: "stopped"; reconciledAfterObservationError: boolean }>
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "replacement" }>
  | Readonly<{ kind: "unproven" }>;

const daemonStopRecovery = (
  kind: Exclude<DaemonReleaseProof["kind"], "stopped" | "absent">,
): Extract<DaemonStopResult, { kind: "failure" }> => {
  if (kind === "failed") {
    return {
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        message: "The daemon released authority in a failed state. Run `oompa doctor --offline` before restarting it.",
        details: { nextCommand: "oompa doctor --offline" },
      },
    };
  }
  if (kind === "replacement") {
    return {
      kind: "failure",
      error: {
        code: "RECOVERY_REQUIRED",
        message: "The daemon authority changed while Oompa was confirming shutdown. The replacement was not stopped; inspect `oompa daemon status --json` before retrying.",
        details: { nextCommand: "oompa daemon status --json" },
      },
    };
  }
  return {
    kind: "failure",
    error: {
      code: "RECOVERY_REQUIRED",
      message: "Oompa could not prove that the exact daemon authority stopped and released. Inspect `oompa daemon status --json` before retrying.",
      details: { nextCommand: "oompa daemon status --json" },
    },
  };
};

type DaemonStopProgress = {
  authorityPhase: "preflight_receipt" | "preflight_inspection" | "stop_request" | "release_confirmation";
  stopRequestState: "not_attempted" | "attempted" | "acknowledged";
};

const daemonStopAuthorityRecovery = (
  progress: Readonly<DaemonStopProgress>,
): Extract<DaemonStopResult, { kind: "failure" }> => ({
  kind: "failure",
  error: {
    code: "RECOVERY_REQUIRED",
    message: "The local daemon authority could not be safely verified. Run `oompa doctor --offline` before taking further action.",
    details: {
      nextCommand: "oompa doctor --offline",
      authorityPhase: progress.authorityPhase,
      stopRequestState: progress.stopRequestState,
    },
  },
});

const isImmediateDaemonAuthorityError = (error: unknown): boolean =>
  error instanceof DaemonAuthoritySafetyError
  || (error instanceof Error && error.message === invalidDaemonAuthorityMessage);

const daemonReceiptIsLive = (receipt: DaemonAuthorityReceipt): boolean =>
  receipt.state !== "stopped" && receipt.state !== "failed";

const receiptNamesIdentity = (
  receipt: DaemonAuthorityReceipt,
  identity: DaemonIdentity,
): boolean => receipt.pid === identity.pid
  && receipt.nonce === identity.nonce
  && (receipt.generation === undefined || receipt.generation === identity.generation)
  && (receipt.bootId === undefined || receipt.bootId === identity.bootId);

const releaseProofFromReceipt = (
  expected: DaemonIdentity,
  receipt: DaemonAuthorityReceipt | null,
): DaemonReleaseProof => {
  if (receipt === null) return { kind: "unproven" };
  if (!receiptNamesIdentity(receipt, expected)) return { kind: "replacement" };
  const identity = identityFromReceipt(receipt);
  if (identity === null) return { kind: "unproven" };
  if (!sameDaemonIdentity(identity, expected)) return { kind: "replacement" };
  if (receipt.state === "failed") return { kind: "failed" };
  return receipt.state === "stopped"
    ? { kind: "stopped", reconciledAfterObservationError: false }
    : { kind: "unproven" };
};

const reconcileTerminalDaemonRelease = async (
  paths: StatePaths,
  expected: DaemonIdentity,
  dependencies: DaemonStopDependencies,
): Promise<DaemonReleaseProof> => {
  let terminal: DaemonAuthorityReceipt | null;
  try {
    terminal = await dependencies.observeReceipt(paths);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return { kind: "unproven" };
  }
  const published = releaseProofFromReceipt(expected, terminal);
  if (published.kind !== "stopped" && published.kind !== "failed") return published;

  // DaemonLock.release publishes the terminal receipt before releasing SQLite.
  // Allow exactly one ordinary poll interval for that documented sequence.
  await dependencies.sleep(daemonReleaseSettleIntervalMs);
  let held: boolean;
  let finalReceipt: DaemonAuthorityReceipt | null;
  try {
    held = await dependencies.authorityHeld(paths);
    finalReceipt = await dependencies.observeReceipt(paths);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return { kind: "unproven" };
  }
  const finalProof = releaseProofFromReceipt(expected, finalReceipt);
  if (finalProof.kind !== "stopped" && finalProof.kind !== "failed") return finalProof;
  if (held) return { kind: "unproven" };
  return finalProof.kind === "failed"
    ? finalProof
    : { kind: "stopped", reconciledAfterObservationError: true };
};

const confirmExactDaemonRelease = async (
  paths: StatePaths,
  expected: DaemonIdentity,
  dependencies: DaemonStopDependencies,
): Promise<DaemonReleaseProof> => {
  try {
    const released = await dependencies.waitForRelease({ paths, expected });
    if (released.replacement !== null) return { kind: "replacement" };
    return releaseProofFromReceipt(expected, released.finalReceipt);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return await reconcileTerminalDaemonRelease(paths, expected, dependencies);
  }
};

const confirmNoDaemonAuthority = async (
  paths: StatePaths,
  dependencies: DaemonStopDependencies,
): Promise<DaemonReleaseProof> => {
  let inspection: DaemonAuthorityInspection;
  try {
    inspection = await dependencies.inspectAuthority(paths);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) throw error;
    return { kind: "unproven" };
  }
  if (
    inspection.state === "unsafe_receipt"
    || inspection.state === "unsafe_database"
    || inspection.state === "invalid_database"
    || inspection.state === "indeterminate"
  ) {
    throw new DaemonAuthoritySafetyError(
      "The local daemon authority requires offline recovery before stop can be proved.",
    );
  }
  if (inspection.state === "absent") return { kind: "absent" };
  if (
    inspection.database.custody === "safe"
    && inspection.database.authority === "released"
    && (inspection.state === "released" || inspection.state === "stale_recoverable")
  ) {
    if (inspection.receipt.custody === "safe" && inspection.receipt.state === "failed") {
      return { kind: "failed" };
    }
    return { kind: "absent" };
  }
  return { kind: "unproven" };
};

const completedDaemonStop = (
  expected: DaemonIdentity,
  proof: Extract<DaemonReleaseProof, { kind: "stopped" }>,
  acknowledgedData: unknown,
  requestWasAcknowledged: boolean,
): Extract<DaemonStopResult, { kind: "success" }> => ({
  kind: "success",
  data: {
    ...(typeof acknowledgedData === "object" && acknowledgedData !== null ? acknowledgedData : {}),
    stopping: false,
    running: false,
    daemon: expected,
    released: true,
    ...(!requestWasAcknowledged || proof.reconciledAfterObservationError ? { reconciled: true } : {}),
  },
});

async function stopDaemonWithExactAuthorityInner(
  paths: StatePaths,
  dependencies: DaemonStopDependencies,
  progress: DaemonStopProgress,
): Promise<DaemonStopResult> {
  const preStopReceipt = await dependencies.observeReceipt(paths);
  progress.authorityPhase = "preflight_inspection";
  const initialProof = await confirmNoDaemonAuthority(paths, dependencies);
  if (initialProof.kind === "failed") return daemonStopRecovery("failed");
  if (initialProof.kind === "absent") {
    return { kind: "success", data: { stopping: false, running: false, released: false } };
  }
  if (preStopReceipt === null || !daemonReceiptIsLive(preStopReceipt)) {
    return daemonStopRecovery(initialProof.kind === "stopped" ? "unproven" : initialProof.kind);
  }
  const capturedAuthority = identityFromReceipt(preStopReceipt);
  if (capturedAuthority === null) return daemonStopRecovery("unproven");

  const confirmRelease = async (): Promise<DaemonReleaseProof> => {
    progress.authorityPhase = "release_confirmation";
    return await confirmExactDaemonRelease(paths, capturedAuthority, dependencies);
  };
  let response: CommandResponse;
  try {
    // Attempted records the boundary call, not delivery or acknowledgement.
    progress.authorityPhase = "stop_request";
    progress.stopRequestState = "attempted";
    response = await dependencies.requestStop({
      paths,
      command: { kind: "daemon.stop", expected: capturedAuthority },
      deadlineMs: daemonStopRequestDeadlineMs,
    });
  } catch (error: unknown) {
    if (error instanceof LocalDaemonIndeterminateError) {
      const proof = await confirmRelease();
      return proof.kind === "stopped"
        ? completedDaemonStop(capturedAuthority, proof, undefined, false)
        : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
    }
    if (!isLocalDaemonUnavailable(error)) throw error;
    const proof = await confirmRelease();
    return proof.kind === "stopped"
      ? completedDaemonStop(capturedAuthority, proof, undefined, false)
      : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
  }

  if (!response.ok) return { kind: "failure", error: response.error };
  let acknowledgedAuthority: DaemonIdentity;
  try {
    acknowledgedAuthority = daemonStatusIdentity(response);
  } catch {
    const proof = await confirmRelease();
    return proof.kind === "stopped"
      ? completedDaemonStop(capturedAuthority, proof, undefined, false)
      : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
  }
  if (!sameDaemonIdentity(capturedAuthority, acknowledgedAuthority)) {
    return daemonStopRecovery("replacement");
  }
  progress.stopRequestState = "acknowledged";
  const proof = await confirmRelease();
  return proof.kind === "stopped"
    ? completedDaemonStop(capturedAuthority, proof, response.data, true)
    : daemonStopRecovery(proof.kind === "absent" ? "unproven" : proof.kind);
}

export async function stopDaemonWithExactAuthority(
  paths: StatePaths,
  dependencies: DaemonStopDependencies = defaultDaemonStopDependencies,
): Promise<DaemonStopResult> {
  const progress: DaemonStopProgress = {
    authorityPhase: "preflight_receipt",
    stopRequestState: "not_attempted",
  };
  try {
    return await stopDaemonWithExactAuthorityInner(paths, dependencies, progress);
  } catch (error: unknown) {
    if (isImmediateDaemonAuthorityError(error)) return daemonStopAuthorityRecovery(progress);
    throw error;
  }
}

export function selectDaemonCloudControl(
  configured: CloudControlPort | null,
  projectionRecoveryBlocker: CompactProjectionRecoveryBlocker,
  diagnostic?: string,
  unavailability: "disabled" | "recovery_required" = "recovery_required",
  projectionRecoveryStatus?: () => Promise<CloudProjectionRecoveryStatus>,
  reenable?: CloudReenableConfiguration,
): CloudControlPort {
  if (configured !== null) return configured;
  if (diagnostic === undefined) return new UnavailableCloudControl(projectionRecoveryBlocker);
  return new DiagnosedUnavailableCloudControl(
    projectionRecoveryBlocker,
    diagnostic,
    unavailability,
    projectionRecoveryStatus,
    reenable,
  );
}

class DiagnosedUnavailableCloudControl extends UnavailableCloudControl {
  readonly #diagnostic: string;
  readonly #projectionRecoveryStatus: (() => Promise<CloudProjectionRecoveryStatus>) | undefined;
  readonly #reenable: CloudReenableConfiguration | undefined;
  readonly #unavailability: "disabled" | "recovery_required";

  constructor(
    projectionRecoveryBlocker: CompactProjectionRecoveryBlocker,
    diagnostic: string,
    unavailability: "disabled" | "recovery_required",
    projectionRecoveryStatus?: () => Promise<CloudProjectionRecoveryStatus>,
    reenable?: CloudReenableConfiguration,
  ) {
    super(projectionRecoveryBlocker);
    this.#diagnostic = diagnostic;
    this.#projectionRecoveryStatus = projectionRecoveryStatus;
    this.#reenable = reenable;
    this.#unavailability = unavailability;
  }

  #unavailable(): never {
    throw new Error(this.#diagnostic);
  }

  override async status(): Promise<unknown> {
    const projectionRecovery = await this.#projectionRecoveryStatus?.();
    return {
      configured: false,
      diagnostic: this.#diagnostic,
      ...(projectionRecovery === undefined ? {} : { projectionRecovery }),
      ...(this.#reenable === undefined ? {} : { reenable: this.#reenable }),
      signedIn: false,
      unavailability: this.#unavailability,
    };
  }

  override sync(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override recoverCompactProjection(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override auth(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override logout(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override deleteAccount(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override listDevices(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override pairDevice(): Promise<never> { return Promise.reject(this.#unavailable()); }
  override approveDevice(
    device: string,
    idempotencyKey: string,
    fingerprint: string,
    signal: AbortSignal,
  ): Promise<never> {
    void device;
    void idempotencyKey;
    void fingerprint;
    void signal;
    return Promise.reject(this.#unavailable());
  }
  override revokeDevice(device: string, idempotencyKey: string, signal: AbortSignal): Promise<never> {
    void device;
    void idempotencyKey;
    void signal;
    return Promise.reject(this.#unavailable());
  }
}

function cloudBindingDiagnostic(error: unknown): string {
  if (error instanceof CloudDeploymentAliasConflictError) return error.message;
  if (!(error instanceof CloudDeploymentAuthorityError)) {
    return "Cloud sync is unavailable because local cloud custody requires recovery.";
  }
  switch (error.code) {
    case "invalid_configuration":
      return "Cloud sync is unavailable because OOMPA_CONVEX_URL or its legacy alias HRA_CONVEX_URL is invalid.";
    case "legacy_binding_required":
      return "Cloud sync is unavailable until OOMPA_CONVEX_URL (or legacy HRA_CONVEX_URL) explicitly selects the legacy deployment.";
    case "target_mismatch":
      return "Cloud sync is unavailable because this state root is bound to another deployment.";
    case "concurrent_change":
    case "corrupt_custody":
    case "stale_authority":
      return "Cloud sync is unavailable because deployment custody requires recovery.";
  }
}

type CloudReenableConfiguration =
  | Readonly<{ kind: "use_hosted_default" }>
  | Readonly<{
      deploymentUrl: string;
      kind: "restore_bound_deployment";
    }>;

const cloudReenableConfiguration = (
  authority: CloudDeploymentAuthority | null,
): CloudReenableConfiguration => authority === null
  || authority.deploymentUrl === DEFAULT_CLOUD_DEPLOYMENT_URL
  ? { kind: "use_hosted_default" }
  : {
      deploymentUrl: authority.deploymentUrl,
      kind: "restore_bound_deployment",
    };

const disabledCloudDiagnostic = (reenable: CloudReenableConfiguration): string =>
  reenable.kind === "use_hosted_default"
    ? "Cloud sync is disabled for this daemon. Unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon to use hosted sync."
    : "Cloud sync is disabled for this daemon. Restore this state root's bound deployment with OOMPA_CONVEX_URL, unset HRA_CONVEX_URL, and restart the daemon.";

type DaemonCloudStartup = Readonly<{
  deploymentAuthority: CloudDeploymentAuthority | null;
  identityNamespace: string | null;
  journal: CustodyCloudDaemonJournal | null;
  projectionRecoveryBlocker: CompactProjectionRecoveryBlocker;
  diagnostic?: string;
  reenable?: CloudReenableConfiguration;
  unavailability?: "disabled" | "recovery_required";
}>;

class FailClosedProjectionRecoveryBlocker implements CompactProjectionRecoveryBlocker {
  readonly #delegate: CompactProjectionRecoveryBlocker | null;

  constructor(delegate: CompactProjectionRecoveryBlocker | null) {
    this.#delegate = delegate;
  }

  async isCompactProjectionRecoveryUnsettled(
    sessionPublicId: Parameters<CompactProjectionRecoveryBlocker[
      "isCompactProjectionRecoveryUnsettled"
    ]>[0],
  ): Promise<boolean> {
    if (this.#delegate === null) return true;
    try {
      return await this.#delegate.isCompactProjectionRecoveryUnsettled(sessionPublicId);
    } catch {
      return true;
    }
  }

  async isCompactProjectionRecoveryUnsettledForProfile(
    profileId: Parameters<CompactProjectionRecoveryBlocker[
      "isCompactProjectionRecoveryUnsettledForProfile"
    ]>[0],
  ): Promise<boolean> {
    if (this.#delegate === null) return true;
    try {
      return await this.#delegate.isCompactProjectionRecoveryUnsettledForProfile(profileId);
    } catch {
      return true;
    }
  }

  readCompactProjectionRecoveryReceipt(
    input: Parameters<NonNullable<CompactProjectionRecoveryBlocker[
      "readCompactProjectionRecoveryReceipt"
    ]>>[0],
  ): ReturnType<NonNullable<CompactProjectionRecoveryBlocker[
    "readCompactProjectionRecoveryReceipt"
  ]>> {
    return this.#delegate?.readCompactProjectionRecoveryReceipt?.(input)
      ?? Promise.resolve({ status: "absent" });
  }

  async supersedeCompactProjectionRecoveryForProviderDeletion(
    sessionPublicId: Parameters<CompactProjectionRecoveryBlocker[
      "supersedeCompactProjectionRecoveryForProviderDeletion"
    ]>[0],
  ): Promise<{ superseded: boolean }> {
    if (this.#delegate !== null) {
      try {
        return await this.#delegate
          .supersedeCompactProjectionRecoveryForProviderDeletion(sessionPublicId);
      } catch {
        // Fall through to the static fail-closed diagnostic.
      }
    }
    throw new Error("Cloud projection recovery custody requires recovery.");
  }

  async supersedeTerminalCompactProjectionRecoveries(): Promise<{ superseded: number }> {
    if (this.#delegate === null) return { superseded: 0 };
    try {
      return await this.#delegate.supersedeTerminalCompactProjectionRecoveries();
    } catch {
      return { superseded: 0 };
    }
  }
}

function daemonCloudStartupResult(input: Readonly<{
  deploymentAuthority: CloudDeploymentAuthority | null;
  diagnostic?: string;
  reenable?: CloudReenableConfiguration;
  unavailability?: "disabled" | "recovery_required";
  identityNamespace: string | null;
  isSessionTerminal?: (sessionPublicId: string) => boolean | Promise<boolean>;
  journal: CustodyCloudDaemonJournal | null;
}>): DaemonCloudStartup {
  const delegate = input.journal === null
    ? null
    : new CloudDaemonJournalRecoveryBlocker(
        input.journal,
        input.isSessionTerminal === undefined
          ? {}
          : { isSessionTerminal: input.isSessionTerminal },
      );
  const result = {
    deploymentAuthority: input.deploymentAuthority,
    identityNamespace: input.identityNamespace,
    journal: input.journal,
    projectionRecoveryBlocker: new FailClosedProjectionRecoveryBlocker(delegate),
  };
  return input.diagnostic === undefined
    ? result
    : {
        ...result,
        diagnostic: input.diagnostic,
        ...(input.reenable === undefined ? {} : { reenable: input.reenable }),
        unavailability: input.unavailability ?? "recovery_required",
      };
}

export async function resolveDaemonCloudStartup(input: Readonly<{
  environment: Readonly<Record<string, string | undefined>>;
  isSessionTerminal?: (sessionPublicId: string) => boolean | Promise<boolean>;
  secretCustody: CloudSecretCustodyPort;
}>): Promise<DaemonCloudStartup> {
  // A contradictory target is not a custody-recovery condition. Refuse before
  // the recovery path can read or open any local cloud authority.
  const cloud = requireCloudDeploymentEnvironment(input.environment);
  let deploymentAuthority: CloudDeploymentAuthority | null = null;
  let diagnostic: string | undefined;
  let unavailability: "disabled" | "recovery_required" | undefined;
  try {
    deploymentAuthority = await cloudDeploymentAuthorityFromEnvironment(
      input.secretCustody,
      cloud.environment,
    );
    if (deploymentAuthority === null) {
      diagnostic = disabledCloudDiagnostic({ kind: "use_hosted_default" });
      unavailability = "disabled";
    }
  } catch (error: unknown) {
    diagnostic = cloudBindingDiagnostic(error);
    unavailability = "recovery_required";
  }

  let recoveryAuthority = deploymentAuthority;
  if (recoveryAuthority === null) {
    try {
      recoveryAuthority = await readCloudDeploymentAuthority(input.secretCustody);
    } catch (error: unknown) {
      return daemonCloudStartupResult({
        deploymentAuthority: null,
        diagnostic: cloudBindingDiagnostic(error),
        unavailability: "recovery_required",
        identityNamespace: null,
        ...(input.isSessionTerminal === undefined
          ? {}
          : { isSessionTerminal: input.isSessionTerminal }),
        journal: null,
      });
    }
  }

  const reenable = unavailability === "disabled"
    ? cloudReenableConfiguration(recoveryAuthority)
    : undefined;
  if (reenable !== undefined) diagnostic = disabledCloudDiagnostic(reenable);

  try {
    const deploymentCustody = recoveryAuthority === null
      ? input.secretCustody
      : new DeploymentScopedCloudSecretCustody(input.secretCustody, recoveryAuthority);
    const identityCustody = await IdentityScopedCloudSecretCustody.open(deploymentCustody);
    const journal = new CustodyCloudDaemonJournal(identityCustody);
    await journal.read();
    return daemonCloudStartupResult({
      deploymentAuthority,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(reenable === undefined ? {} : { reenable }),
      ...(unavailability === undefined ? {} : { unavailability }),
      identityNamespace: identityCustody.cacheNamespace,
      ...(input.isSessionTerminal === undefined
        ? {}
        : { isSessionTerminal: input.isSessionTerminal }),
      journal,
    });
  } catch (error: unknown) {
    return daemonCloudStartupResult({
      deploymentAuthority: null,
      diagnostic: cloudBindingDiagnostic(error),
      unavailability: "recovery_required",
      identityNamespace: null,
      ...(input.isSessionTerminal === undefined
        ? {}
        : { isSessionTerminal: input.isSessionTerminal }),
      journal: null,
    });
  }
}

function boundedUtf8Text(value: string, maximumBytes: number): string {
  const encoder = new TextEncoder();
  const retained: Array<Readonly<{ bytes: number; scalar: string }>> = [];
  let retainedBytes = 0;
  let truncated = false;
  for (const scalar of value) {
    const bytes = encoder.encode(scalar).byteLength;
    if (retainedBytes + bytes > maximumBytes) {
      truncated = true;
      break;
    }
    retained.push({ bytes, scalar });
    retainedBytes += bytes;
  }
  if (!truncated) return retained.map((entry) => entry.scalar).join("");

  const markerBytes = encoder.encode(syncDiagnosticTruncationMarker).byteLength;
  while (retained.length > 0 && retainedBytes + markerBytes > maximumBytes) {
    const removed = retained.pop();
    if (removed !== undefined) retainedBytes -= removed.bytes;
  }
  return `${retained.map((entry) => entry.scalar).join("")}${syncDiagnosticTruncationMarker}`;
}

function redactSyncSecrets(value: string): string {
  if (privateKeyHeaderPattern.test(value)) return "[redacted private key material]";
  if (unsafeTerminalScalarPattern.test(value) && secretLabelPattern.test(value)) {
    return "[redacted token-like diagnostic containing terminal controls]";
  }
  return redactCompleteSensitiveText(value, "[redacted-token]");
}

function redactSyncPaths(value: string): string {
  return redactAbsolutePaths(value).replace(
    underscoreAbsolutePathPattern,
    (_match, prefix: string) => `${prefix}[local-path]`,
  );
}

function sanitizeSyncDiagnostic(value: string): string {
  const redacted = redactSyncPaths(redactSyncSecrets(value));
  const bounded = boundedUtf8Text(redacted, syncDiagnosticMaximumBytes);
  const terminalSanitized = terminalSafe(bounded);
  const sanitized = redactSyncSecrets(redactSyncPaths(terminalSanitized));
  const pathSafe = containsAbsolutePath(sanitized)
    ? "[sync diagnostic omitted because it contained a local path]"
    : sanitized;
  const final = boundedUtf8Text(pathSafe, syncDiagnosticMaximumBytes).trim();
  return final.length === 0 ? "Sync failed without a diagnostic." : final;
}

function parseSyncNowSummary(value: unknown): SyncNowSummary | null {
  if (!isRecord(value) || !isRecord(value.daemon)) return null;
  const daemon = value.daemon;
  if (
    typeof daemon.online !== "boolean"
    || (daemon.commandRequestVersion !== undefined
      && daemon.commandRequestVersion !== 2
      && daemon.commandRequestVersion !== null)
    || !isSafeNonNegativeInteger(daemon.commandsApplied)
    || !isSafeNonNegativeInteger(daemon.commandsUnsettled)
    || !isSafeNonNegativeInteger(daemon.sessionsUploaded)
    || !isSafeNonNegativeInteger(daemon.usageUploaded)
    || !Array.isArray(daemon.errors)
  ) return null;

  const errors: string[] = [];
  const errorValues: readonly unknown[] = daemon.errors;
  const returnedErrors = Math.min(errorValues.length, syncDiagnosticLimit);
  for (let index = 0; index < returnedErrors; index += 1) {
    const diagnostic = errorValues[index];
    if (typeof diagnostic !== "string") return null;
    errors.push(sanitizeSyncDiagnostic(diagnostic));
  }
  return {
    commandRequestVersion: daemon.commandRequestVersion === 2 ? 2 : null,
    online: daemon.online,
    commandsApplied: daemon.commandsApplied,
    commandsUnsettled: daemon.commandsUnsettled,
    sessionsUploaded: daemon.sessionsUploaded,
    usageUploaded: daemon.usageUploaded,
    errorCount: errorValues.length,
    errors,
    errorsOmitted: errorValues.length - errors.length,
  };
}

function renderSyncNowSuccess(data: unknown, json: boolean, output: Output): number {
  const summary = parseSyncNowSummary(data);
  if (summary === null) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned an invalid sync summary.",
    }, json, output);
  }
  if (json) {
    output.writeStdout(`${safeJson({ ok: true, version: 1, command: "sync.now", data: summary })}\n`);
    return 0;
  }
  const rows = [
    `Cloud sync: ${summary.online ? "online" : "offline"}`,
    `Command request contract: ${summary.commandRequestVersion === 2 ? "version 2 published" : "not published"}`,
    `Uploaded: ${String(summary.sessionsUploaded)} sessions; ${String(summary.usageUploaded)} usage snapshots`,
    `Commands: ${String(summary.commandsApplied)} applied; ${String(summary.commandsUnsettled)} unsettled`,
  ];
  if (summary.errors.length === 0) {
    rows.push("Diagnostics: none");
  } else {
    rows.push("Diagnostics:", ...summary.errors.map((error) => `  - ${terminalSafe(error)}`));
    if (summary.errorsOmitted > 0) rows.push(`  - ${String(summary.errorsOmitted)} more omitted`);
  }
  output.writeStdout(`${rows.join("\n")}\n`);
  return 0;
}

function renderSyncNowFailure(
  error: Readonly<{ code: string; message: string }>,
  json: boolean,
  output: Output,
): number {
  return renderFailure({
    code: error.code,
    message: sanitizeSyncDiagnostic(error.message),
  }, json, output);
}

function parseProjectionRecoverySummary(
  value: unknown,
  invocation: ProjectionRecoveryCliInvocation,
): ProjectionRecoverySummary | null {
  if (!isRecord(value)) return null;
  const parsedSession = sessionIdSchema.safeParse(value.sessionPublicId);
  if (!parsedSession.success) return null;
  const sessionPublicId = parsedSession.data;
  const sameIdentity = value.idempotencyKey === invocation.command.idempotencyKey
    && sessionPublicId.length <= 96;
  if (!sameIdentity) return null;
  const sameKeyReplay = {
    command: projectionRecoveryReplayCommand(
      sessionPublicId,
      invocation.command.idempotencyKey,
      invocation.json,
    ),
    supported: true as const,
  };
  if (value.phase === "applied") {
    if (
      !hasExactKeys(value, [
        "boundaryHeadSequence",
        "compactHasRecoveryGap",
        "compactStreamEpoch",
        "idempotencyKey",
        "phase",
        "projectionRevision",
        "sessionPublicId",
      ])
      || value.compactHasRecoveryGap !== true
      || !isSafePositiveInteger(value.boundaryHeadSequence)
      || !isSafePositiveInteger(value.compactStreamEpoch)
      || !isSafePositiveInteger(value.projectionRevision)
    ) return null;
    return {
      boundaryHead: value.boundaryHeadSequence,
      gapRemainsVisible: true,
      idempotencyKey: invocation.command.idempotencyKey,
      newEpoch: value.compactStreamEpoch,
      oldEpoch: value.compactStreamEpoch - 1,
      phase: "applied",
      sameKeyReplay,
      session: sessionPublicId,
    };
  }
  if (
    value.phase !== "rejected"
    || !hasExactKeys(value, [
      "idempotencyKey",
      "phase",
      "rejectionCode",
      "sessionPublicId",
    ])
    || typeof value.rejectionCode !== "string"
  ) return null;
  return {
    idempotencyKey: invocation.command.idempotencyKey,
    nextCommand: "oompa sync status --json",
    phase: "rejected",
    rejectionCode: boundedUtf8Text(sanitizeSyncDiagnostic(value.rejectionCode), 128),
    sameKeyReplay,
    session: sessionPublicId,
  };
}

function renderProjectionRecoverySuccess(
  value: unknown,
  invocation: ProjectionRecoveryCliInvocation,
  output: Output,
): number {
  const summary = parseProjectionRecoverySummary(value, invocation);
  if (summary === null) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned an invalid projection-recovery summary.",
    }, invocation.json, output);
  }
  if (invocation.json) {
    output.writeStdout(`${safeJson({
      command: invocation.command.kind,
      data: summary,
      ok: true,
      version: 1,
    })}\n`);
    return 0;
  }
  if (summary.phase === "rejected") {
    output.writeStdout(`${[
      `Projection recovery rejected for ${terminalSafe(summary.session)}.`,
      `Reason: ${terminalSafe(summary.rejectionCode)}`,
      "Encrypted cloud history and provider/app state were unchanged.",
      `Same-key replay: ${terminalSafe(summary.sameKeyReplay.command)}`,
      `Next: ${summary.nextCommand}`,
    ].join("\n")}\n`);
    return 0;
  }
  output.writeStdout(`${[
    `Projection recovery applied for ${terminalSafe(summary.session)}.`,
    `Epoch: ${String(summary.oldEpoch)} -> ${String(summary.newEpoch)}`,
    `Boundary head: ${String(summary.boundaryHead)}`,
    "Gap remains visible: yes",
    "Encrypted cloud history was preserved; provider and app state were unchanged.",
    `Same-key replay: ${terminalSafe(summary.sameKeyReplay.command)}`,
  ].join("\n")}\n`);
  return 0;
}

function renderProjectionRecoveryFailure(
  error: Readonly<{ code: string; message: string; details?: unknown }>,
  invocation: ProjectionRecoveryCliInvocation,
  output: Output,
): number {
  const nextCommand = (() => {
    if (!isRecord(error.details)) return null;
    try {
      return error.details.nextCommand === "oompa sync status --json"
        ? "oompa sync status --json" as const
        : null;
    } catch {
      return null;
    }
  })();
  return renderFailure({
    code: error.code,
    message: sanitizeSyncDiagnostic(error.message),
    ...(nextCommand === null ? {} : { details: { nextCommand } }),
  }, invocation.json, output);
}

export const daemonRunProcessArguments = (
  bunExecutable: string,
  cliPath: string,
): string[] => [
  bunExecutable,
  "--no-env-file",
  cliPath,
  "daemon",
  "run",
];

// The detached daemon receives the Codex child allowlist plus the exact pair
// of compatible cloud-deployment inputs captured for this invocation.
export const DAEMON_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set(["HRA_CONVEX_URL", "OOMPA_CONVEX_URL"]);

export const daemonRunProcessOptions = (
  cwd: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  const env = allowlistedEnvironment(environment, DAEMON_ENVIRONMENT_KEYS);
  requireCloudDeploymentEnvironment(env);
  return {
    cwd,
    detached: true,
    env,
    stdin: "ignore" as const,
    stdout: "ignore" as const,
    stderr: "ignore" as const,
  };
};

async function startDaemonProcess(installation: OompaInstallation): Promise<DaemonReadyStatus> {
  assertInstallationHome(installation);
  if (installation.kind !== "production") {
    throw new Error("A live-acceptance daemon must be started by its source-only worker.");
  }
  const cloud = requireCloudDeploymentEnvironment(installation.cloudEnvironment);
  const processOptions = daemonRunProcessOptions(installation.paths.root, {
    ...allowlistedEnvironment(process.env),
    ...cloud.environment,
  });
  const cliPath = process.argv[1] ?? import.meta.path;
  const paths = installation.paths;
  await requireInitializedDaemonState(paths);
  await initializeStatePaths(paths);
  const child = Bun.spawn(
    daemonRunProcessArguments(process.execPath, cliPath),
    processOptions,
  );
  child.unref();
  let exited = false;
  let exitCode: number | undefined;
  void child.exited.then((code) => {
    exitCode = code;
    exited = true;
  });
  try {
    const daemon = await waitForDaemonReady({
      paths,
      queryStatus: async () => await callLocalDaemon({ paths, command: { kind: "daemon.status" }, deadlineMs: 750 }),
      observeChild: () => ({
        pid: child.pid,
        exited,
        ...(exitCode === undefined ? {} : { exitCode }),
      }),
    });
    return { running: true, pid: daemon.pid, daemon };
  } catch (error: unknown) {
    try {
      await terminateDaemonStartupChild(child);
    } catch (cleanupError: unknown) {
      throw new AggregateError(
        [error, cleanupError],
        "Daemon startup failed and exact child cleanup was incomplete.",
      );
    }
    throw error;
  }
}

const initializationRequired = (
  operation: "daemon" | "local_status" = "daemon",
): CommandFailure => new CommandFailure(
  "INTERACTION_REQUIRED",
  operation === "daemon"
    ? "Initialize Oompa before starting its daemon."
    : "Initialize Oompa before reading local status.",
  { nextCommand: "oompa init --yes" },
);

const unprovenLocalState = (operation: "daemon" | "local_status"): CommandFailure =>
  new CommandFailure(
    "RECOVERY_REQUIRED",
    operation === "daemon"
      ? "Oompa could not prove that local state is initialized. Inspect it before starting the daemon."
      : "Oompa could not prove that local state is initialized. Inspect it before reading local status.",
    { nextCommand: "oompa doctor --offline" },
  );

// A store opened read-only reports a schema difference instead of migrating it.
// Both directions are exact and diagnosable, so the CLI classifies them here
// rather than folding them into one opaque recovery boundary.
type StateSchemaMismatch = Readonly<{
  kind: "migration_required" | "newer";
  found: number;
  expected: number;
}>;

const stateSchemaMismatch = (error: unknown): StateSchemaMismatch | null => {
  if (!(error instanceof Error)) return null;
  const pending = /^STATE_SCHEMA_MIGRATION_REQUIRED:(\d+):(\d+)$/u.exec(error.message);
  if (pending !== null) {
    return { kind: "migration_required", found: Number(pending[1]), expected: Number(pending[2]) };
  }
  const newer = /^STATE_SCHEMA_NEWER:(\d+):(\d+)$/u.exec(error.message);
  if (newer !== null) {
    return { kind: "newer", found: Number(newer[1]), expected: Number(newer[2]) };
  }
  return null;
};

// The leading `STATE_...` token of a local state error. It names the failure
// without exposing a path, a stack, or any row content.
const stateErrorShortCode = (error: unknown): string | null => {
  if (!(error instanceof Error)) return null;
  const match = /^(STATE_[A-Z0-9_]+)(?::|$)/u.exec(error.message);
  return match === null ? null : match[1] ?? null;
};

const stateSchemaNewerFailure = (mismatch: StateSchemaMismatch): CommandFailure =>
  new CommandFailure(
    "RECOVERY_REQUIRED",
    `This Oompa build is older than the local state schema (${mismatch.found} vs ${mismatch.expected}); install the newer Oompa.`,
  );

const stateSchemaMigrationPending = (mismatch: StateSchemaMismatch): CommandFailure =>
  new CommandFailure(
    "RECOVERY_REQUIRED",
    `The local state schema needs a migration (${mismatch.found} to ${mismatch.expected}); start the daemon to migrate it.`,
    { nextCommand: "oompa daemon start" },
  );

// One read-only initialization proof. A schema difference is returned as data so
// the daemon path can migrate once and prove the state again; every other
// failure stays the opaque recovery boundary.
function proveInitializedStateOnce(
  paths: StatePaths,
  operation: "daemon" | "local_status",
): StateSchemaMismatch | null {
  let store: StateStore | undefined;
  let inspectionFailure: CommandFailure | undefined;
  let mismatch: StateSchemaMismatch | null = null;
  try {
    store = new StateStore(paths, { readonly: true });
    if (store.listProjects().length === 0) throw initializationRequired(operation);
  } catch (error: unknown) {
    if (error instanceof CommandFailure) inspectionFailure = error;
    else {
      mismatch = stateSchemaMismatch(error);
      if (mismatch === null) inspectionFailure = unprovenLocalState(operation);
    }
  }
  try {
    store?.close();
  } catch {
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      operation === "daemon"
        ? "Oompa could not close its initialization inspection safely. Inspect local state before starting the daemon."
        : "Oompa could not close its initialization inspection safely. Inspect local state before reading local status.",
      { nextCommand: "oompa doctor --offline" },
    );
  }
  if (inspectionFailure !== undefined) throw inspectionFailure;
  return mismatch;
}

// A writable open is the only place the store migrates itself, under its own
// locking and scrub rules. Nothing else in the product performs one, so an
// install that meets a newer schema version would otherwise deadlock here.
function migrateLocalStateSchema(paths: StatePaths): void {
  let store: StateStore | undefined;
  try {
    store = new StateStore(paths);
  } catch (error: unknown) {
    const mismatch = stateSchemaMismatch(error);
    if (mismatch !== null && mismatch.kind === "newer") throw stateSchemaNewerFailure(mismatch);
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      "Oompa could not migrate local state to the schema this build requires. Inspect it before starting the daemon.",
      { nextCommand: "oompa doctor --offline" },
    );
  }
  try {
    store.close();
  } catch {
    throw new CommandFailure(
      "RECOVERY_REQUIRED",
      "Oompa could not close its local state migration safely. Inspect local state before starting the daemon.",
      { nextCommand: "oompa doctor --offline" },
    );
  }
}

async function requireInitializedDaemonState(
  paths: StatePaths,
  operation: "daemon" | "local_status" = "daemon",
): Promise<void> {
  try {
    await lstat(paths.database);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw initializationRequired(operation);
    }
    throw unprovenLocalState(operation);
  }
  const mismatch = proveInitializedStateOnce(paths, operation);
  if (mismatch === null) return;
  if (mismatch.kind === "newer") throw stateSchemaNewerFailure(mismatch);
  // Only the daemon path migrates. A status read is a pure observation and must
  // never take the writer's authority over local state.
  if (operation !== "daemon") throw stateSchemaMigrationPending(mismatch);
  migrateLocalStateSchema(paths);
  const remaining = proveInitializedStateOnce(paths, operation);
  if (remaining === null) return;
  throw remaining.kind === "newer"
    ? stateSchemaNewerFailure(remaining)
    : stateSchemaMigrationPending(remaining);
}

async function callWithAutostart(
  installation: OompaInstallation,
  command: LocalCommand,
  signal?: AbortSignal,
  injectedStart?: (installation: OompaInstallation) => Promise<DaemonReadyStatus>,
): Promise<Awaited<ReturnType<typeof callLocalDaemon>>> {
  assertInstallationHome(installation);
  const paths = installation.paths;
  return await callWithSafeAutostart(
    async () => await callLocalDaemon({ paths, command, ...(signal === undefined ? {} : { signal }) }),
    async () => {
      const cloud = requireCloudDeploymentEnvironment(installation.cloudEnvironment);
      const selectedInstallation = { ...installation, cloudEnvironment: cloud.environment };
      if (injectedStart === undefined) {
        await startDaemonProcess(selectedInstallation);
        return;
      }
      await requireInitializedDaemonState(paths);
      await injectedStart(selectedInstallation);
    },
  );
}

export async function initialize(
  yes: boolean,
  json: boolean,
  output: Output,
  input: { paths?: StatePaths; documentsDirectory?: string } = {},
): Promise<number> {
  const paths = input.paths ?? resolveStatePaths();
  if (!yes) {
    return renderFailure({
      code: "INTERACTION_REQUIRED",
      message: "Confirm the default Documents project with `oompa init --yes`.",
    }, json, output);
  }
  await initializeStatePaths(paths);
  const authority = await DaemonLock.acquire(paths, { state: "maintenance" });
  let store: StateStore | undefined;
  try {
    const documents = input.documentsDirectory ?? join(homedir(), "Documents");
    const prepareDocuments = async (): Promise<number | null> => {
      try {
        await mkdir(documents, { mode: 0o700 });
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          return renderFailure({
            code: "UNAVAILABLE",
            message: "The default Documents project could not be created. Create a readable, writable, and traversable canonical Documents directory, then run `oompa init --yes` again.",
          }, json, output);
        }
      }
      if (await resolveUsableCanonicalProjectDirectory(documents) === null) {
        return renderFailure({
          code: "UNAVAILABLE",
          message: "The default Documents project is not a readable, writable, and traversable canonical directory. Repair it, then run `oompa init --yes` again.",
        }, json, output);
      }
      return null;
    };
    let databaseExists = true;
    try {
      await lstat(paths.database);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") databaseExists = false;
      else throw error;
    }
    let documentsReady = false;
    if (!databaseExists) {
      const failure = await prepareDocuments();
      if (failure !== null) return failure;
      documentsReady = true;
    }
    store = new StateStore(paths);
    let projectCreated = false;
    if (store.listProjects().length === 0) {
      if (!documentsReady) {
        const failure = await prepareDocuments();
        if (failure !== null) return failure;
      }
      await store.createProject("Documents", documents, true);
      projectCreated = true;
    }
    const data = { initialized: true, stateRoot: paths.root, defaultProjectCreated: projectCreated, next: "oompa account add Personal" };
    if (json) output.writeStdout(`${safeJson({ ok: true, version: 1, data })}\n`);
    else output.writeStdout(`Oompa is ready.\n\nNext: ${data.next}\n`);
    return 0;
  } finally {
    try { store?.close(); } finally { await authority.release(); }
  }
}

// A pending or newer state schema is an exact, actionable condition. Reporting
// it as the opaque line hid the one upgrade failure an operator can fix, so the
// doctor names both versions there and appends the short `STATE_...` code of
// any other named local state failure. It never prints a path or a stack.
const localDatabaseProblem = (error: unknown): string => {
  const mismatch = stateSchemaMismatch(error);
  if (mismatch !== null) {
    return mismatch.kind === "migration_required"
      ? `The local state schema needs a migration (${mismatch.found} to ${mismatch.expected}). Run \`oompa daemon start\` to migrate it.`
      : `This Oompa build is older than the local state schema (${mismatch.found} vs ${mismatch.expected}). Install the newer Oompa.`;
  }
  const code = stateErrorShortCode(error);
  return code === null
    ? "The local database check failed without exposing its runtime diagnostic."
    : `The local database check failed without exposing its runtime diagnostic (${code}).`;
};

async function offlineDoctor(
  json: boolean,
  output: Output,
  paths: StatePaths,
  ownerUid = process.getuid?.(),
): Promise<number> {
  let initialized = false;
  let databaseFileReady = false;
  let rootReady = false;
  const problems: string[] = [];
  let database: "not_initialized" | "ready" | "invalid" = "not_initialized";
  let projectCount = 0;
  let rootMetadata: Stats | undefined;
  try {
    rootMetadata = await lstat(paths.root);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (rootMetadata !== undefined) {
    try {
      const canonical = await realpath(paths.root);
      const after = await lstat(paths.root);
      rootReady = rootMetadata.isDirectory()
        && !rootMetadata.isSymbolicLink()
        && rootMetadata.nlink >= 1
        && (rootMetadata.mode & 0o777) === 0o700
        && (ownerUid === undefined || rootMetadata.uid === ownerUid)
        && canonical === resolve(paths.root)
        && after.dev === rootMetadata.dev
        && after.ino === rootMetadata.ino;
    } catch {
      rootReady = false;
    }
    if (!rootReady) problems.push("The state root is not a private canonical directory.");
  }
  let daemonAuthority: DaemonAuthorityInspection = rootMetadata === undefined
    ? {
        state: "absent",
        database: { custody: "absent" },
        receipt: { custody: "absent" },
      }
    : {
        state: "indeterminate",
        database: { custody: "indeterminate" },
        receipt: { custody: "indeterminate" },
      };
  if (rootReady) {
    daemonAuthority = await inspectDaemonAuthority(paths);
    switch (daemonAuthority.state) {
      case "unsafe_receipt":
        problems.push("The daemon authority receipt has unsafe file custody. Verify that no Oompa daemon is running, restore it as a current-user-owned single-link mode-0600 regular file, then rerun `oompa doctor --offline`.");
        break;
      case "unsafe_database":
        problems.push("The daemon authority database has unsafe file custody. Verify that no Oompa daemon is running, restore it as a current-user-owned single-link mode-0600 regular file, then rerun `oompa doctor --offline`.");
        break;
      case "invalid_database":
        problems.push("The daemon authority database is invalid. Stop every Oompa process, preserve the invalid authority file for recovery, then repair its SQLite state before restarting Oompa.");
        break;
      case "indeterminate":
        problems.push("The daemon authority changed or could not be proved safe during inspection. Do not change authority files; wait for any daemon transition to settle, then rerun `oompa doctor --offline`.");
        break;
      case "absent":
      case "held":
      case "releasing":
      case "released":
      case "stale_recoverable":
        break;
    }
  }
  if (rootReady) {
    try {
      const metadata = await lstat(paths.database);
      databaseFileReady = metadata.isFile()
        && !metadata.isSymbolicLink()
        && metadata.nlink === 1
        && (metadata.mode & 0o777) === 0o600
        && (ownerUid === undefined || metadata.uid === ownerUid);
      if (!databaseFileReady) throw new Error("Unsafe local database file.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        database = "invalid";
        problems.push(localDatabaseProblem(error));
      }
    }
  }
  let projectRoots: readonly string[] = [];
  if (databaseFileReady && database !== "invalid") {
    try {
      const store = new StateStore(paths, { readonly: true });
      try {
        const projects = store.listProjects();
        projectCount = projects.length;
        projectRoots = projects.map((project) => project.rootPath);
        database = "ready";
        initialized = projectCount > 0;
      } finally {
        store.close();
      }
    } catch (error: unknown) {
      database = "invalid";
      problems.push(localDatabaseProblem(error));
    }
  }
  if (database === "ready") {
    if (projectCount === 0) {
      problems.push(
        daemonAuthority.state === "held" || daemonAuthority.state === "releasing"
          ? "No project directory is configured. Stop the daemon with `oompa daemon stop`, then run `oompa init --yes`."
          : "No project directory is configured. Run `oompa init --yes`.",
      );
    }
    let unusableProjectRoots = 0;
    for (const projectRoot of projectRoots) {
      if (await resolveUsableCanonicalProjectDirectory(projectRoot) === null) {
        unusableProjectRoots += 1;
      }
    }
    if (unusableProjectRoots > 0) {
      problems.push("A configured project directory is missing or unsafe. Run `oompa project list`, then restore or repair every listed directory so it is readable, writable, traversable, and canonical.");
    }
  }
  let codexRuntime: { status: "ready"; version: string } | { status: "invalid"; diagnostic: string };
  try {
    const runtime = await resolvePinnedCodexRuntime();
    codexRuntime = { status: "ready", version: runtime.packageVersion };
  } catch {
    const diagnostic = "The pinned Codex runtime check failed without exposing its runtime diagnostic.";
    codexRuntime = { status: "invalid", diagnostic };
    problems.push(diagnostic);
  }
  const bunReady = Bun.version === "1.3.14";
  if (!bunReady) problems.push(`Oompa requires Bun 1.3.14, but ${Bun.version} is running.`);
  const data = {
    healthy: problems.length === 0,
    offline: true,
    runtime: { bun: Bun.version, requiredBun: "1.3.14", bunReady, codex: codexRuntime, platform: process.platform, architecture: process.arch },
    state: { initialized, database, projectCount, daemonAuthority },
    networkChecks: "skipped",
    problems,
  };
  if (json) {
    output.writeStdout(`${safeJson(data.healthy
      ? { ok: true, version: 1, data }
      : unhealthyDoctorEnvelope(data, doctorVerdict(data).message))}\n`);
  }
  else if (data.healthy) {
    const daemonAuthoritySummary = (() => {
      switch (daemonAuthority.state) {
        case "absent": return "not initialized";
        case "held": return "held by a running Oompa process";
        case "releasing": return "release in progress; wait before restarting";
        case "released":
          return daemonAuthority.receipt.custody === "safe"
            && daemonAuthority.receipt.state === "failed"
            ? "released after a failed daemon; safe to restart after these checks"
            : "released";
        case "stale_recoverable": return "released with recoverable stale evidence";
        case "unsafe_receipt": return "unsafe receipt";
        case "unsafe_database": return "unsafe database";
        case "invalid_database": return "invalid database";
        case "indeterminate": return "indeterminate";
      }
    })();
    output.writeStdout(`Oompa offline checks passed. Bun ${Bun.version}; Codex ${codexRuntime.status}; ${process.platform} ${process.arch}; state ${initialized ? database : "not initialized"}; daemon authority ${daemonAuthoritySummary}.\n`);
  }
  else output.writeStderr(`oompa: offline checks failed\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`);
  return data.healthy ? 0 : 1;
}

// An interactive editor needs its terminal description and its own editor
// selection on top of the Codex child allowlist. It gets nothing else.
export const EDITOR_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  "COLORTERM",
  "COLUMNS",
  "EDITOR",
  "LINES",
  "NO_COLOR",
  "TERM",
  "TERMINFO",
  "TERMINFO_DIRS",
  "VISUAL",
]);

async function editSessionNote(
  session: string,
  json: boolean,
  output: Output,
  callDaemon: (command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>,
): Promise<number> {
  if (json || !process.stdin.isTTY || !process.stdout.isTTY) {
    return renderFailure({ code: "INTERACTION_REQUIRED", message: "Note editing requires an interactive terminal. Use `session note set` for scripts." }, json, output);
  }
  const current = await callDaemon({ kind: "session.note.get", session });
  if (!current.ok) return renderFailure(current.error, false, output);
  const note = typeof current.data === "object" && current.data !== null && "note" in current.data && typeof current.data.note === "string" ? current.data.note : "";
  const directory = await mkdtemp(join(tmpdir(), "oompa-note-"));
  const file = join(directory, "note.md");
  try {
    await writeFile(file, note, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const editorName = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    const editor = Bun.which(editorName);
    if (editor === null) throw new Error(`Editor is unavailable: ${editorName}`);
    const child = Bun.spawn([editor, file], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: allowlistedEnvironment(process.env, EDITOR_ENVIRONMENT_KEYS),
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`Editor exited with status ${exitCode}.`);
    const edited = await readFile(file, "utf8");
    const response = await callDaemon({ kind: "session.note.set", session, note: edited });
    if (!response.ok) return renderFailure(response.error, false, output);
    renderSuccess({ kind: "session.note.set", session, note: edited }, response.data, false, output);
    return 0;
  } finally {
    await unlink(file).catch(() => undefined);
    await rmdir(directory).catch(() => undefined);
  }
}

/**
 * `oompa session export` reads the provider-neutral retained tail
 * and writes one document: the letta-ai trajectory v1 shape by default, or
 * Oompa's own neutral record shape with `--format json`.
 *
 * Everything written comes from Oompa's own storage. No provider is asked, so a
 * session whose provider thread is gone still exports.
 */
async function exportSessionTranscript(
  invocation: SessionExportCliInvocation,
  output: Output,
  callDaemon: (command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>,
): Promise<number> {
  const response = await callDaemon({
    kind: "session.transcript",
    session: invocation.session,
    limit: TRANSCRIPT_PAGE_LIMIT,
    tail: true,
  });
  if (!response.ok) return renderFailure(response.error, invocation.json, output);
  const parsed = sessionTranscriptSchema.safeParse(response.data);
  if (!parsed.success || parsed.data.provider === undefined) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned a transcript tail Oompa could not validate.",
    }, invocation.json, output);
  }
  const transcript = parsed.data;
  const provider = transcript.provider;
  if (provider === undefined) throw new Error("Transcript provider narrowing failed.");
  const document = invocation.format === "trajectory"
    ? transcriptToTrajectory({
      transcript,
      provider,
      createdAt: Date.now(),
    })
    : transcript;
  const serialized = `${safeJson(document, 2)}\n`;
  if (invocation.out === undefined) {
    output.writeStdout(serialized);
  } else {
    // Transcript text can be sensitive. Create one new private inode and
    // refuse every existing path (including a symlink) instead of truncating
    // or inheriting permissions from it.
    await writeFile(resolve(invocation.out), serialized, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    output.writeStderr(`Wrote ${String(transcript.records.length)} transcript records${
      transcript.omittedRecords > 0
        || (transcript.retentionGapReason !== undefined
          && transcript.retentionGapReason !== null)
        ? " (older history omitted)"
        : ""}.\n`);
  }
  return 0;
}

function remoteFailure(error: unknown, json: boolean, output: Output): number {
  const message = error instanceof Error ? error.message : "Cloud remote operation failed.";
  const code = /not found/iu.test(message)
    ? "NOT_FOUND"
    : /ambiguous/iu.test(message)
      ? "AMBIGUOUS"
      : /changed|conflict|recovered/iu.test(message)
        ? "CONFLICT"
        : /invalid|expired|too (?:long|large)/iu.test(message)
          ? "INVALID_INPUT"
          : /auth|configured|device|pair|unavailable/iu.test(message)
            ? "UNAVAILABLE"
            : "INTERNAL";
  const closedMessage = code === "NOT_FOUND"
    ? "The requested remote object was not found."
    : code === "AMBIGUOUS"
      ? "The remote selector is ambiguous."
      : code === "CONFLICT"
        ? "Remote authority changed before the operation could complete."
        : code === "INVALID_INPUT"
          ? "The remote request is invalid."
          : code === "UNAVAILABLE"
            ? "Remote control is unavailable."
            : "The remote operation failed before a safe diagnostic was available.";
  return renderFailure({ code, message: closedMessage }, json, output);
}

function remoteSessionName(head: CloudRemoteSessionHead): string {
  return terminalSafe(head.metadata?.name ?? head.publicId).replace(/[\r\n\t]+/gu, " ");
}

function remotePayload(command: RemoteCliCommand): RemoteCommandPayload | null {
  switch (command.kind) {
    case "remote.list":
    case "remote.show":
    case "remote.command": return null;
    case "remote.send": return command.orSteer === true
      ? { kind: "send_or_steer", message: command.message }
      : { kind: "send", message: command.message };
    case "remote.resolve": return {
      decision: command.decision,
      interactionId: command.interaction,
      kind: "resolve_interaction",
      revision: command.revision,
    };
    case "remote.queue": return { kind: "queue", message: command.message };
    case "remote.steer": return { kind: "steer", message: command.message };
    case "remote.stop": return { kind: "stop" };
    case "remote.preset": return {
      kind: "set_model",
      ...activeRemotePresetSelection(command.preset),
    };
    case "remote.provider": return {
      kind: "set_provider",
      ...(command.preset === undefined
        ? command.provider === "codex"
          ? activeRemoteDerivedCodexSelection()
          : { provider: command.provider }
        : {
            ...activeRemotePresetSelection(command.preset),
            provider: command.provider,
          }),
    };
    case "remote.fast": return { enabled: command.enabled, kind: "set_fast" };
  }
}

type RemoteSessionProjection = Awaited<ReturnType<CloudRemoteControlPort["pullRemoteSession"]>>;
type RemoteInteractionEvent = Extract<RemoteSessionProjection["events"][number], { kind: "interaction_state" }>;

const remoteInteractionSafetyRank: Readonly<Record<RemoteInteractionEvent["state"], number>> = {
  pending: 0,
  response_prepared: 1,
  response_written: 2,
  resolution_unknown: 3,
  resolved: 4,
  declined: 4,
  canceled: 4,
  expired: 4,
};

const laterRemoteInteraction = (
  candidate: RemoteInteractionEvent,
  current: RemoteInteractionEvent,
): boolean => {
  if (candidate.revision !== current.revision) return candidate.revision > current.revision;
  const candidateRank = remoteInteractionSafetyRank[candidate.state];
  const currentRank = remoteInteractionSafetyRank[current.state];
  if (candidateRank !== currentRank) return candidateRank > currentRank;
  if (candidate.sequence !== current.sequence) return candidate.sequence > current.sequence;
  const candidateTie = `${candidate.state}\u0000${candidate.interactionKind}\u0000${candidate.summary}`;
  const currentTie = `${current.state}\u0000${current.interactionKind}\u0000${current.summary}`;
  return candidateTie > currentTie;
};

const latestRemoteInteractions = (
  events: RemoteSessionProjection["events"],
): ReadonlyMap<string, RemoteInteractionEvent> => {
  const latest = new Map<string, RemoteInteractionEvent>();
  for (const event of events) {
    if (event.kind !== "interaction_state") continue;
    const current = latest.get(event.interactionId);
    if (current === undefined || laterRemoteInteraction(event, current)) {
      latest.set(event.interactionId, event);
    }
  }
  return latest;
};

const remoteInteractionGuidance = (
  event: RemoteInteractionEvent,
  now: number,
): readonly string[] => {
  const policy = event.remotePolicy;
  if (policy === undefined) {
    return ["  No remote action is available. Resolve this interaction on the execution device."];
  }
  if (now >= policy.deadlineAt) {
    return ["  The remote-action deadline has passed. Resolve this interaction on the execution device."];
  }

  const rows: string[] = [];
  if (policy.actions.includes("decline")) {
    rows.push(`  Decline remotely with \`oompa remote resolve <session> --interaction ${event.interactionId} --revision ${String(event.revision)} --decision decline\`, or resolve this interaction on the execution device.`);
  }
  if (policy.actions.includes("answer")) {
    rows.push("  Answer remotely in the Oompa app, or resolve this interaction on the execution device.");
  }
  if (rows.length === 0) {
    rows.push("  No remote action is available. Resolve this interaction on the execution device.");
  }
  return rows;
};

export function renderRemoteSuccess(
  command: RemoteCliCommand,
  data: unknown,
  json: boolean,
  output: Output,
): void {
  if (command.kind === "remote.command") {
    if (!isRecord(data)) throw new Error("Cloud remote command status was invalid.");
    const required = [
      data.commandPublicId,
      data.sessionPublicId,
      data.kind,
      data.state,
      data.targetDevicePublicId,
    ];
    if (!required.every((value) => typeof value === "string")
      || (data.resultCode !== undefined && typeof data.resultCode !== "string")) {
      throw new Error("Cloud remote command status was invalid.");
    }
    const summary = {
      commandPublicId: boundedUtf8Text(sanitizeSyncDiagnostic(data.commandPublicId as string), 160),
      sessionPublicId: boundedUtf8Text(sanitizeSyncDiagnostic(data.sessionPublicId as string), 160),
      kind: boundedUtf8Text(sanitizeSyncDiagnostic(data.kind as string), 64),
      state: boundedUtf8Text(sanitizeSyncDiagnostic(data.state as string), 64),
      ...(typeof data.resultCode === "string"
        ? { resultCode: boundedUtf8Text(sanitizeSyncDiagnostic(data.resultCode), 128) }
        : {}),
      targetDevicePublicId: boundedUtf8Text(sanitizeSyncDiagnostic(data.targetDevicePublicId as string), 160),
    };
    if (json) {
      output.writeStdout(`${safeJson({ ok: true, version: 1, command: command.kind, data: summary })}\n`);
      return;
    }
    output.writeStdout(`${[
      `Command ${terminalSafe(summary.commandPublicId)}`,
      `State: ${terminalSafe(summary.state)}`,
      `Result: ${terminalSafe(summary.resultCode ?? "not reported")}`,
      `Session: ${terminalSafe(summary.sessionPublicId)}`,
      `Kind: ${terminalSafe(summary.kind)}`,
      `Target: ${terminalSafe(summary.targetDevicePublicId)}`,
    ].join("\n")}\n`);
    return;
  }
  if (json) {
    output.writeStdout(`${safeJson({ ok: true, version: 1, command: command.kind, data })}\n`);
    return;
  }
  if (command.kind === "remote.list") {
    const sessions = (data as { sessions: readonly CloudRemoteSessionHead[] }).sessions;
    if (sessions.length === 0) {
      output.writeStdout("No cloud sessions.\n");
      return;
    }
    output.writeStdout(`${sessions.map((head) => [
      `${remoteSessionName(head)}  ${terminalSafe(head.state)}`,
      `  ${terminalSafe(head.publicId)}  device ${terminalSafe(head.executionDevicePublicId)}`,
    ].join("\n")).join("\n")}\n`);
    return;
  }
  if (command.kind === "remote.show") {
    const session = data as Awaited<ReturnType<CloudRemoteControlPort["pullRemoteSession"]>>;
    const rows = [
      remoteSessionName(session),
      `State: ${terminalSafe(session.state)}`,
      `Session: ${terminalSafe(session.publicId)}`,
      `Device: ${terminalSafe(session.executionDevicePublicId)}`,
      "",
    ];
    if (session.recoveryGap !== undefined) {
      rows.push(
        `Recovery gap: compact projection cache recovery at stream epoch ${String(session.recoveryGap.streamEpoch)}.`,
        "  Remote interaction state is incomplete while recovery settles. Do not act until a committed baseline is available.",
        "",
      );
    } else if (session.compactHasRecoveryGap) {
      rows.push(
        "Recovery gap: the compact projection reports an incomplete recovery boundary.",
        "",
      );
    }
    const currentInteractions = latestRemoteInteractions(session.events);
    const interactionGuidanceAvailable = session.recoveryGap === undefined
      && !session.compactHasRecoveryGap;
    const guidanceNow = Date.now();
    for (const event of session.events) {
      if (event.kind === "user_message" || event.kind === "assistant_message") {
        rows.push(`${event.kind === "user_message" ? "You" : "Codex"}  ${terminalSafe(event.turnId)}`);
        rows.push(...terminalSafe(event.text, true).split("\n").map((line) => `  ${line}`), "");
      } else if (event.kind === "interaction_state") {
        if (currentInteractions.get(event.interactionId) !== event) continue;
        const kind = event.interactionKind.replaceAll("_", " ");
        rows.push(`Interaction ${terminalSafe(event.interactionId)}  ${terminalSafe(kind)}`);
        rows.push(`  ${terminalSafe(event.state)}  revision ${String(event.revision)}  ${event.blocking ? "blocking" : "nonblocking"}`);
        rows.push(
          ...terminalSafe(event.summary, true).split("\n").map((line) => `  ${line}`),
        );
        if (!interactionGuidanceAvailable) {
          rows.push("  Interaction action guidance is suppressed while remote recovery settles.");
        } else if (event.state === "pending") {
          rows.push(...remoteInteractionGuidance(event, guidanceNow));
        } else if (event.state === "response_prepared") {
          rows.push("  A response is durably prepared on the execution device. Do not submit another response.");
        } else if (event.state === "response_written") {
          rows.push("  The provider response write began on the execution device. Do not submit another response.");
        } else if (event.state === "resolution_unknown") {
          rows.push("  Provider delivery is uncertain. Do not retry; recover on the execution device.");
        }
        rows.push("");
      } else {
        const runtimeProfile = event.model === undefined
          ? "model/Fast unknown"
          : `${event.model}${event.fast === true ? " fast" : ""}`;
        rows.push(`Turn ${terminalSafe(event.turnId)}  ${(event.runtimeMs / 1_000).toFixed(1)}s  ${terminalSafe(runtimeProfile)}`);
        if (event.filesTouched.length > 0) rows.push(`  files: ${event.filesTouched.map((file) => terminalSafe(file)).join(", ")}`);
        if (event.gitActions.length > 0) rows.push(`  git: ${event.gitActions.map((action) => terminalSafe(action.label ?? action.kind)).join(", ")}`);
        rows.push("");
      }
    }
    if (!session.complete) rows.push("Older cloud events were truncated.");
    output.writeStdout(`${rows.join("\n").trimEnd()}\n`);
    return;
  }
  const receipt = data as Readonly<{
    commandPublicId: string;
    kind: string;
    sessionPublicId: string;
    state: string;
  }>;
  output.writeStdout(`Queued ${terminalSafe(receipt.kind)} as ${terminalSafe(receipt.commandPublicId)} for ${terminalSafe(receipt.sessionPublicId)} (${terminalSafe(receipt.state)}).\n`);
}

async function executeRemoteInvocation(
  invocation: Extract<CliInvocation, { kind: "remote" }>,
  output: Output,
  input: Pick<CliMainInput, "getRemoteCommandStatus" | "installation"> = {},
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  assertInstallationHome(installation);
  const controller = new AbortController();
  const injectedStatus = invocation.command.kind === "remote.command"
    ? input.getRemoteCommandStatus
    : undefined;
  const abort = () => controller.abort(new Error("Cloud remote operation was interrupted."));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const environment = injectedStatus === undefined
      ? requireCloudDeploymentEnvironment(installation.cloudEnvironment).environment
      : installation.cloudEnvironment;
    const control = injectedStatus === undefined
      ? await createLocalCloudControlFromEnvironment({
          environment,
          lifetimeSignal: controller.signal,
          secretCustody: installation.createSecretCustody(),
        })
      : null;
    if (control === null && injectedStatus === undefined) {
      return renderFailure({
        code: "UNAVAILABLE",
        message: "Cloud sync is disabled. Unset both OOMPA_CONVEX_URL and HRA_CONVEX_URL to use hosted sync; for a custom deployment, set only OOMPA_CONVEX_URL. Then run `oompa auth login`.",
      }, invocation.json, output);
    }
    if (invocation.command.kind === "remote.list") {
      if (control === null) throw new Error("Cloud sync is not configured.");
      const data = await control.listRemoteSessionHeads({
        limit: invocation.command.limit,
        signal: controller.signal,
      });
      renderRemoteSuccess(invocation.command, data, invocation.json, output);
      return 0;
    }
    if (invocation.command.kind === "remote.command") {
      const getRemoteCommandStatus = injectedStatus ?? control?.getRemoteCommandStatus.bind(control);
      if (getRemoteCommandStatus === undefined) throw new Error("Cloud sync is not configured.");
      const data = await getRemoteCommandStatus({
        commandPublicId: invocation.command.commandPublicId,
        signal: controller.signal,
      });
      renderRemoteSuccess(invocation.command, data, invocation.json, output);
      return 0;
    }
    if (control === null) throw new Error("Cloud sync is not configured.");
    const selector = await control.resolveRemoteSession({
      selector: invocation.command.session,
      signal: controller.signal,
    });
    if (invocation.command.kind === "remote.show") {
      const data = await control.pullRemoteSession({ selector, signal: controller.signal });
      renderRemoteSuccess(invocation.command, data, invocation.json, output);
      return 0;
    }
    const payload = remotePayload(invocation.command);
    if (payload === null) throw new Error("Cloud remote command is invalid.");
    const now = Date.now();
    const idempotencyKey = invocation.idempotencyKey ?? createCloudUuidV7(now);
    if (!isUuidV7(idempotencyKey)) {
      throw new Error("Remote --idempotency-key must be a current UUIDv7.");
    }
    const shortLived = payload.kind === "steer" || payload.kind === "stop";
    const data = await control.enqueueRemoteCommand({
      commandPublicId: idempotencyKey,
      deadline: now + (shortLived ? 5 * 60 * 1_000 : 24 * 60 * 60 * 1_000),
      idempotencyKey,
      payload,
      selector,
      signal: controller.signal,
    });
    renderRemoteSuccess(invocation.command, data, invocation.json, output);
    return 0;
  } catch (error: unknown) {
    if (error instanceof CloudDeploymentAuthorityError || error instanceof CloudDeploymentAliasConflictError) {
      return renderFailure({
        code: "UNAVAILABLE",
        message: cloudBindingDiagnostic(error),
      }, invocation.json, output);
    }
    const diagnostic = invocation.command.kind === "remote.command" && error instanceof Error
      ? new Error(sanitizeSyncDiagnostic(error.message))
      : error;
    return remoteFailure(diagnostic, invocation.json, output);
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

class DaemonBootInterruptedError extends Error {
  constructor() {
    super("Daemon startup was interrupted before it published readiness.");
    this.name = "DaemonBootInterruptedError";
  }
}

class DaemonJoinDeadlineError extends Error {
  constructor(readonly operation: string, readonly deadlineMs: number) {
    super(`${operation} did not settle within ${deadlineMs}ms.`);
    this.name = "DaemonJoinDeadlineError";
  }
}

class DaemonAccountObservationJoinError extends DaemonJoinDeadlineError {
  constructor(cause: unknown) {
    super("Cloud account observation shutdown", 5_000);
    this.name = "DaemonAccountObservationJoinError";
    this.message = "Cloud account observation shutdown did not prove complete process cleanup.";
    this.cause = cause;
  }
}

function safeDaemonFailure(error: unknown): string {
  if (error instanceof CursorAuthorityMissingError) return error.message;
  if (error instanceof DaemonJoinDeadlineError || error instanceof LocalDaemonShutdownTimeoutError) {
    return `Forced recovery boundary: ${error.message}`;
  }
  if (error instanceof Error && /^STATE_SCHEMA_NEWER:\d+:\d+$/u.test(error.message)) {
    return error.message;
  }
  return "Daemon startup or shutdown failed before a safe readiness boundary.";
}

export function admitExactDaemonStop(input: Readonly<{
  command: DaemonStopCommand;
  receipt: DaemonAuthorityReceipt;
  afterResponse(callback: () => void): void;
  requestStop(): void;
}>): Readonly<{ stopping: true; running: true; daemon: DaemonIdentity }> {
  const daemon = identityFromReceipt(input.receipt);
  if (
    daemon === null
    || input.command.expected === undefined
    || !sameDaemonIdentity(daemon, input.command.expected)
  ) {
    throw new CommandFailure(
      "CONFLICT",
      "The daemon stop authority changed before dispatch. No daemon was stopped.",
      { nextCommand: "oompa daemon status --json" },
    );
  }
  input.afterResponse(input.requestStop);
  return { stopping: true, running: true, daemon };
}

async function joinBeforeDeadline<T>(operation: string, promise: Promise<T>, deadlineMs = 5_000): Promise<T> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new DaemonJoinDeadlineError(operation, deadlineMs)), deadlineMs);
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

/** Exact live provider authority predicate shared by all daemon runtime managers. */
export function isExactProviderRuntimeAuthorityCurrent(
  store: Pick<StateStore, "requireProfile" | "requireProviderAccountAuthority">,
  expectedProvider: Provider,
  authority: ProfileAuthority,
): boolean {
  try {
    if (authority.provider !== expectedProvider) return false;
    const profile = store.requireProfile(authority.id);
    if (profile.state === "removed") return false;
    if (expectedProvider === "codex" && profile.processGeneration !== authority.generation) {
      return false;
    }
    const providerAuthority = store.requireProviderAccountAuthority(
      profile.id,
      expectedProvider,
    );
    return providerAuthority.profileId === authority.id
      && providerAuthority.provider === expectedProvider
      && providerAuthority.providerAccountId === authority.providerAccountId
      && providerAuthority.bindingGeneration === authority.bindingGeneration
      && providerAuthority.processGeneration === authority.generation;
  } catch {
    return false;
  }
}

/**
 * Live acceptance redirects its synthetic "personal" provider home under the
 * fixture root. Claude must therefore select that directory explicitly even
 * though service authority still classifies the controller as personal.
 * Production preserves Claude's real default-home semantics.
 */
export function personalClaudeConfigHomeForInstallation(
  installation: Pick<OompaInstallation, "kind">,
): "isolated" | "personal" {
  return installation.kind === "live_acceptance" ? "isolated" : "personal";
}

export async function releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration(
  store: StateStore,
  options: Readonly<{
    probe?: ClaudeProcessLivenessProbe;
    launchIntentProbe?: Pick<ClaudeLaunchIntentLivenessProbe, "probe">;
    deadlineAt?: number;
    signal?: AbortSignal;
  }> = {},
): Promise<void> {
  const probe = options.probe ?? createLocalClaudeProcessLivenessProbe();
  const launchIntentProbe = options.launchIntentProbe
    ?? new ClaudeLaunchIntentLivenessProbe();
  const signal = options.signal ?? new AbortController().signal;
  const deadlineAt = options.deadlineAt ?? Date.now() + 3_000;
  for (;;) {
    const intents = store.listClaudeProcessLaunchIntents();
    if (intents.length === 0) break;
    for (const intent of intents) {
      const liveness = await launchIntentProbe.probe(intent.providerThreadId, {
        deadlineAt,
        signal,
      });
      if (liveness !== "not_live") {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "A prior Claude launch did not finish recording exact process custody. Exit any Claude process for that session, then retry `oompa daemon start`; Oompa will not advance account authority around it.",
        );
      }
      store.cancelClaudeProcessLaunchIntent({
        providerThreadId: intent.providerThreadId,
        profileId: intent.profileId,
        profileGeneration: intent.profileGeneration,
        runtimeScope: intent.runtimeScope,
        intentId: intent.intentId,
        expectedRevision: intent.revision,
      });
    }
  }
  for (;;) {
    const authorities = store.listUnreleasedClaudeProcessAuthorities();
    if (authorities.length === 0) return;
    for (const authority of authorities) {
      const liveness = await probe(authority.identity, { deadlineAt, signal });
      if (liveness !== "not_live") {
        throw new CommandFailure(
          "RECOVERY_REQUIRED",
          "A prior Oompa-owned Claude controller is still live or cannot be proven stopped. Exit it, then retry `oompa daemon start`; Oompa will not advance account authority around it.",
        );
      }
      const releasing = authority.state === "releasing"
        ? authority
        : store.beginClaudeProcessAuthorityRelease({
            providerThreadId: authority.providerThreadId,
            profileId: authority.profileId,
            runtimeScope: authority.runtimeScope,
            expectedRevision: authority.revision,
            identity: authority.identity,
          });
      store.completeClaudeProcessAuthorityRelease({
        providerThreadId: releasing.providerThreadId,
        profileId: releasing.profileId,
        runtimeScope: releasing.runtimeScope,
        expectedRevision: releasing.revision,
        identity: releasing.identity,
      });
    }
  }
}

type DaemonStopLatch = {
  deliver: (() => void) | undefined;
  requested: boolean;
};

export type RunDaemonOptions = Readonly<{
  liveAcceptanceCanonicalMemoryTransportDecorator?: (
    transport: CanonicalMemoryTransport,
  ) => CanonicalMemoryTransport;
  liveAcceptanceClaudeProof?: LiveAcceptanceClaudeProofPort;
  liveAcceptancePersonalClaudeProof?: LiveAcceptancePersonalClaudeProofPort;
  stopSignal?: AbortSignal;
}>;

/**
 * Acceptance-only custody for one managed-Claude host-tool proof. The concrete
 * collector lives under `scripts/`; production exposes no observer, flag, or
 * environment switch that can enable this seam.
 */
export type LiveAcceptanceClaudeProofPort = Readonly<{
  beginDaemonGeneration(generation: number): void;
  handleManagedHostToolCall(input: Readonly<{
    authority: ProfileAuthority;
    call: OompaHostToolCall;
    dispatch: () => Promise<ClaudeHostToolPublicResult>;
  }>): Promise<ClaudeHostToolPublicResult>;
  handleManagedHostToolResponseWritten(receipt: ClaudeHostToolResponseWritten): void;
  /** Invalidates this in-process hook; it is not provider or filesystem cleanup proof. */
  closeDaemonGeneration(generation: number | null): void;
}>;

/**
 * Structural observation only for the explicit live-acceptance installation.
 * The repository-only caller owns its status policy and effect observations;
 * the daemon retains runtime resolution, spawn, identity, bytes and collection.
 */
export type LiveAcceptancePersonalClaudeProofPort = Readonly<{
  executablePath: string;
  environment: Readonly<Record<string, string>>;
  beginDaemonGeneration(generation: number): void;
  assertRuntimeRequest(input: ResolvePinnedClaudeRuntimeOptions): void;
  runtimeAdmitted(runtime: PinnedClaudeRuntime): void;
  runtimeFailed(): void;
  prepareLaunch(launch: Parameters<ClaudeProcessFactory>[0]): ClaudeProcessObservation;
  observeWrites(): Readonly<{ userWriteAttempts: number; acceptedUserWrites: number; acknowledgmentWithheld: boolean }>;
  closeAdmission(): void;
  closeDaemonGeneration(generation: number | null): Promise<void>;
}>;

async function runDaemonLifecycle(
  installation: OompaInstallation,
  stopLatch: DaemonStopLatch,
  liveAcceptanceCanonicalMemoryTransportDecorator?: (
    transport: CanonicalMemoryTransport,
  ) => CanonicalMemoryTransport,
  liveAcceptanceClaudeProof?: LiveAcceptanceClaudeProofPort,
  liveAcceptancePersonalClaudeProof?: LiveAcceptancePersonalClaudeProofPort,
): Promise<number> {
  assertInstallationHome(installation);
  const paths = installation.paths;
  await requireInitializedDaemonState(paths);
  await initializeStatePaths(paths);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const daemonLock = await DaemonLock.acquire(paths);
  let store: StateStore | undefined;
  let factsMemoryControl: FactsMemoryControlStore | undefined;
  let codex: PinnedCodexRuntimeManager | undefined;
  let claude: PinnedClaudeRuntimeManager | undefined;
  let personalCodex: PinnedCodexRuntimeManager | undefined;
  let personalClaude: PinnedClaudeRuntimeManager | undefined;
  let claudeHostToolAuthority: ClaudeHostToolBindingAuthority | undefined;
  let claudeHostToolServer: ClaudeHostToolCallbackServer | undefined;
  let service: OompaService | undefined;
  let server: LocalDaemonServer | undefined;
  let cloudAdapter: StateBackedCloudDaemonAdapter | undefined;
  let cloudLifecycle: CloudDaemonLifecycle | undefined;
  let cloudLifecycleShutdown: Promise<void> | undefined;
  let canonicalMemoryAuthoritySource: CanonicalMemoryCloudAuthoritySource | undefined;
  let usagePoller: AccountUsagePoller | undefined;
  let usagePollerShutdown: Promise<void> | undefined;
  let adoptionPoller: AccountUsagePoller | undefined;
  let adoptionPollerShutdown: Promise<void> | undefined;
  let cloudRequestController: AbortController | undefined;
  let daemonAuthority: DaemonAuthorityFence | undefined;
  let serviceShutdown: Promise<void> | undefined;
  let generation: number | undefined;
  let bootId: string | undefined;
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => { resolveStop = resolve; });
  let stopRequested = false;
  let personalClaudeProofFailure: unknown;
  const closePersonalClaudeProofAdmission = () => {
    try { liveAcceptancePersonalClaudeProof?.closeAdmission(); } catch (error: unknown) {
      personalClaudeProofFailure ??= error;
    }
  };
  const closeCloudLifecycle = (): Promise<void> => {
    if (cloudLifecycle === undefined) return Promise.resolve();
    cloudLifecycleShutdown ??= cloudLifecycle.close();
    return cloudLifecycleShutdown;
  };
  const requestStop = () => {
    if (stopRequested) return;
    stopRequested = true;
    closePersonalClaudeProofAdmission();
    if (usagePoller !== undefined) usagePollerShutdown ??= usagePoller.close();
    if (adoptionPoller !== undefined) adoptionPollerShutdown ??= adoptionPoller.close();
    void closeCloudLifecycle().catch(() => undefined);
    if (service !== undefined) serviceShutdown = service.close();
    else daemonAuthority?.close();
    claudeHostToolServer?.beginShutdown();
    server?.beginShutdown(new Error("Daemon shutdown was requested."));
    resolveStop();
  };
  stopLatch.deliver = requestStop;
  if (stopLatch.requested) requestStop();
  const onSignal = () => requestStop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  // A rejection nobody awaited is a lost owned task. Stop through the normal
  // shutdown path and publish a closed failure receipt instead of letting the
  // runtime print the raw error and exit without one.
  let unhandledRejectionError: Error | undefined;
  let claudeHostToolTransportError: Error | undefined;
  const onUnhandledRejection = () => {
    unhandledRejectionError ??= new Error("The daemon stopped after an unhandled promise rejection in an owned background task.");
    requestStop();
  };
  process.on("unhandledRejection", onUnhandledRejection);
  const cleanupErrors: unknown[] = [];
  let runError: unknown;
  const checkpointBoot = () => {
    if (stopRequested) throw new DaemonBootInterruptedError();
  };
  try {
    checkpointBoot();
    store = new StateStore(paths);
    const activeStore = store;
    const secretCustody = installation.createSecretCustody();
    // Prose autorespond stays inert until a gateway key is put into local
    // secret custody; the responder reads the key per call and never holds it,
    // and the hosted `set_gateway_key` command writes into the same custody.
    const gatewayKeys = new CustodyGatewayKeyStore(secretCustody);
    const allowCursorAuthorityInitialization =
      activeStore.canInitializeDaemonCursorAuthority();
    const eventCursors = await resolveSessionEventCursorCodec(secretCustody, {
      allowInitialization: allowCursorAuthorityInitialization,
    });
    const usageHistoryCursors = await resolveUsageHistoryCursorCodec(secretCustody, {
      allowInitialization: allowCursorAuthorityInitialization,
    });
    const workCapabilities = await resolveWorkCapabilityCodec(secretCustody, {
      allowInitialization: allowCursorAuthorityInitialization,
    });
    activeStore.configurePublicProviderIdentifierProjector(
      (value) => eventCursors.projectPublicProviderIdentifier(value),
    );
    await releaseProvenDeadClaudeAuthoritiesBeforeDaemonGeneration(activeStore);
    bootId = `boot_${randomUUID().replaceAll("-", "")}`;
    generation = activeStore.nextDaemonGeneration(bootId);
    liveAcceptanceClaudeProof?.beginDaemonGeneration(generation);
    await daemonLock.publish({ state: "booting", generation, bootId });
    daemonAuthority = new DaemonAuthorityFence(daemonLock, { generation, bootId });
    const activeDaemonAuthority = daemonAuthority;
    checkpointBoot();
    liveAcceptancePersonalClaudeProof?.beginDaemonGeneration(generation);
    const serviceReference: { current?: OompaService } = {};
    claudeHostToolAuthority = new ClaudeHostToolBindingAuthority();
    const activeClaudeHostToolAuthority = claudeHostToolAuthority;
    claudeHostToolServer = await ClaudeHostToolCallbackServer.start({
      paths,
      authority: activeClaudeHostToolAuthority,
      onFatalError: () => {
        claudeHostToolTransportError ??= new Error(
          "The daemon stopped after the Claude host-tool callback transport failed.",
        );
        requestStop();
      },
      handler: {
        call: async (call) => {
          const owners = [claude, personalClaude].filter(
            (runtime): runtime is PinnedClaudeRuntimeManager =>
              runtime?.ownsSessionHostToolBinding(call) === true,
          );
          const owner = owners[0];
          if (owner === undefined || owners.length !== 1) {
            throw new Error("The Claude host-tool call has no unique runtime owner.");
          }
          return await owner.handleSessionHostToolCall(call);
        },
        responseWritten: async (receipt) => {
          const owners = [claude, personalClaude].filter(
            (runtime): runtime is PinnedClaudeRuntimeManager =>
              runtime?.ownsSessionHostToolBinding(receipt) === true,
          );
          const owner = owners[0];
          if (owner === undefined || owners.length !== 1) {
            throw new Error("The Claude host-tool receipt has no unique runtime owner.");
          }
          await owner.handleSessionHostToolResponseWritten(receipt);
          if (owner === claude) {
            liveAcceptanceClaudeProof?.handleManagedHostToolResponseWritten(receipt);
          }
        },
      },
    });
    const activeClaudeHostToolServer = claudeHostToolServer;
    codex = new PinnedCodexRuntimeManager({
      allowSameGenerationRelaunchAfterProviderDisconnect: true,
      ...(installation.kind === "live_acceptance"
        ? {
            codexEnvironment: installation.codexEnvironment,
            prepareCodexHome: installation.prepareCodexHome,
          }
        : {}),
      credentialStorePreflight: installation.credentialStorePreflight,
      isCurrent: (authority) =>
        isExactProviderRuntimeAuthorityCurrent(activeStore, "codex", authority),
      observer: {
        account: async (authority, account) => {
          await serviceReference.current?.observeCodexAccount(authority, account);
        },
        oompaHostTool: async (authority, call) => {
          const current = serviceReference.current;
          if (current === undefined) {
            throw new Error("The Oompa service is unavailable during host-tool execution.");
          }
          return await current.handleOompaHostToolCall(authority, call, {
            provider: "codex",
            source: "managed",
          });
        },
        oompaHostToolResponseWritten: (authority, call) => {
          serviceReference.current?.notifyOompaHostToolResponseWritten(
            authority,
            call,
            { provider: "codex", source: "managed" },
          );
        },
        fact: async (authority, fact) => { await serviceReference.current?.observeCodexFact(authority, fact); },
      },
    });
    // The Claude seam is composed unconditionally: it locates and admits the
    // pinned `claude` binary only when a session actually names the provider,
    // so a machine without it pays nothing and is refused with one exact,
    // actionable message at `session start --provider claude`.
    claude = new PinnedClaudeRuntimeManager({
      configHome: "isolated",
      configDirFor: async (authority) => await ensurePrivateDirectory(
        profilePaths(paths, authority.id).claudeConfigDir,
      ),
      isCurrent: (authority) =>
        isExactProviderRuntimeAuthorityCurrent(activeStore, "claude", authority),
      observer: {
        oompaHostTool: async (authority, call) => {
          const current = serviceReference.current;
          if (current === undefined) {
            throw new Error("The Oompa service is unavailable during host-tool execution.");
          }
          if (liveAcceptanceClaudeProof === undefined) {
            return await current.handleOompaHostToolCall(authority, call, {
              provider: "claude",
              source: "managed",
            });
          }
          return await liveAcceptanceClaudeProof.handleManagedHostToolCall({
            authority,
            call,
            dispatch: async () => await current.handleOompaHostToolCall(
              authority,
              call,
              { provider: "claude", source: "managed" },
            ),
          });
        },
        oompaHostToolResponseWritten: (authority, call) => {
          serviceReference.current?.notifyOompaHostToolResponseWritten(
            authority,
            call,
            { provider: "claude", source: "managed" },
          );
        },
        fact: async (authority, fact) => {
          await serviceReference.current?.observeClaudeFact(authority, fact);
        },
      },
      hostTools: {
        bindingAuthority: activeClaudeHostToolAuthority,
        callbackSocketPath: claudeHostToolCallbackSocketPath(paths),
        privateRoot: paths.runtime,
      },
    });
    const personalHomes = installation.personalProviderHomes;
    personalCodex = new PinnedCodexRuntimeManager({
      allowSameGenerationRelaunchAfterProviderDisconnect: true,
      ...(installation.kind === "live_acceptance"
        ? { codexEnvironment: installation.codexEnvironment }
        : {}),
      credentialStorePreflight: {
        ...installation.credentialStorePreflight,
        // Bootstrap against an Oompa-owned neutral directory. Project-scoped
        // operations perform their own effective-config preflight later.
        cwd: installation.paths.root,
      },
      isCurrent: (authority) =>
        isExactProviderRuntimeAuthorityCurrent(activeStore, "codex", authority),
      observer: {
        // Personal-home identity never mutates the selected isolated login;
        // the service compares it and durably revokes controllers on drift.
        account: async (authority, account) => {
          await serviceReference.current?.observePersonalCodexAccount(authority, account);
        },
        oompaHostTool: async (authority, call) => {
          const current = serviceReference.current;
          if (current === undefined) {
            throw new Error("The Oompa service is unavailable during host-tool execution.");
          }
          return await current.handleOompaHostToolCall(authority, call, {
            provider: "codex",
            source: "personal",
          });
        },
        oompaHostToolResponseWritten: (authority, call) => {
          serviceReference.current?.notifyOompaHostToolResponseWritten(
            authority,
            call,
            { provider: "codex", source: "personal" },
          );
        },
        fact: async (authority, fact) => {
          await serviceReference.current?.observePersonalCodexFact(authority, fact);
        },
      },
    });
    personalClaude = new PinnedClaudeRuntimeManager({
      ...(liveAcceptancePersonalClaudeProof === undefined ? {} : {
        resolveRuntime: async (input: ResolvePinnedClaudeRuntimeOptions) => {
          liveAcceptancePersonalClaudeProof.assertRuntimeRequest(input);
          let runtime: PinnedClaudeRuntime;
          try {
            runtime = await resolvePinnedClaudeRuntime({
              ...input,
              executablePath: liveAcceptancePersonalClaudeProof.executablePath,
              environment: liveAcceptancePersonalClaudeProof.environment,
            });
          } catch (error: unknown) {
            liveAcceptancePersonalClaudeProof.runtimeFailed();
            throw error;
          }
          liveAcceptancePersonalClaudeProof.runtimeAdmitted(runtime);
          return runtime;
        },
        processFactory: (launch: Parameters<ClaudeProcessFactory>[0]) => {
          const observation = liveAcceptancePersonalClaudeProof.prepareLaunch(launch);
          const child = spawnBunClaudeProcess({
            argv: launch.argv,
            configDir: launch.configDir,
            configHome: launch.configHome,
            projectRoot: launch.projectRoot,
            environment: liveAcceptancePersonalClaudeProof.environment,
          });
          return observeClaudeProcess(child, observation);
        },
      }),
      configHome: personalClaudeConfigHomeForInstallation(installation),
      configDirFor: () => personalHomes.claudeConfigDir,
      isCurrent: (authority) =>
        isExactProviderRuntimeAuthorityCurrent(activeStore, "claude", authority),
      observer: {
        oompaHostTool: async (authority, call) => {
          const current = serviceReference.current;
          if (current === undefined) {
            throw new Error("The Oompa service is unavailable during host-tool execution.");
          }
          return await current.handleOompaHostToolCall(authority, call, {
            provider: "claude",
            source: "personal",
          });
        },
        oompaHostToolResponseWritten: (authority, call) => {
          serviceReference.current?.notifyOompaHostToolResponseWritten(
            authority,
            call,
            { provider: "claude", source: "personal" },
          );
        },
        fact: async (authority, fact) => {
          await serviceReference.current?.observePersonalClaudeFact(authority, fact);
        },
      },
      hostTools: {
        bindingAuthority: activeClaudeHostToolAuthority,
        callbackSocketPath: claudeHostToolCallbackSocketPath(paths),
        privateRoot: paths.runtime,
      },
    });
    const activePersonalCodex = personalCodex;
    const personalCodexAutomationsDirectory = join(
      personalHomes.codexHome,
      "automations",
    );
    const readPersonalCodexAutomationAuthority = async (
      request: CodexAutomationAuthorityRequest,
    ) => await readCodexAutomationAuthority({
      ...request,
      automationsDirectory: personalCodexAutomationsDirectory,
    });
    const personalClaudeDiscovery = createPersonalClaudeDiscoveryAdapters({
      configDir: personalHomes.claudeConfigDir,
      pinnedVersion: CLAUDE_PIN,
    });
    const personalDiscovery = new BoundedPersonalSessionDiscovery({
      codexListPage: async ({ cursor, limit, signal }) => {
        const policy = activeStore.readSessionAdoptionPolicy("codex");
        if (policy === null || !policy.enabled || policy.profileId === null) {
          return { sessions: [], nextCursor: null };
        }
        const profile = activeStore.requireProfileById(policy.profileId);
        const providerAuthority = activeStore.requireProviderAccountAuthority(profile.id, "codex");
        const isolated = profilePaths(paths, profile.id);
        return await activePersonalCodex.listSessions({
          authority: {
            id: profile.id,
            generation: profile.processGeneration,
            provider: providerAuthority.provider,
            providerAccountId: providerAuthority.providerAccountId,
            bindingGeneration: providerAuthority.bindingGeneration,
            codexHome: personalHomes.codexHome,
            desktopUserData: isolated.desktopUserData,
          },
          limit,
          ...(cursor === undefined ? {} : { cursor }),
          signal,
        });
      },
      codexReadSession: async ({ providerThreadId, signal }) => {
        const policy = activeStore.readSessionAdoptionPolicy("codex");
        if (policy === null || !policy.enabled || policy.profileId === null) return null;
        const profile = activeStore.requireProfileById(policy.profileId);
        const providerAuthority = activeStore.requireProviderAccountAuthority(profile.id, "codex");
        const isolated = profilePaths(paths, profile.id);
        return await activePersonalCodex.readSessionMetadata(
          {
            id: profile.id,
            generation: profile.processGeneration,
            provider: providerAuthority.provider,
            providerAccountId: providerAuthority.providerAccountId,
            bindingGeneration: providerAuthority.bindingGeneration,
            codexHome: personalHomes.codexHome,
            desktopUserData: isolated.desktopUserData,
          },
          providerThreadId,
          signal,
        );
      },
      ...personalClaudeDiscovery,
    });
    if (activeClaudeHostToolServer.path !== claudeHostToolCallbackSocketPath(paths)) {
      throw new Error("Claude host-tool callback transport path changed during daemon startup.");
    }
    const cloudEnvironment = installation.cloudEnvironment;
    const cloudStartup = await resolveDaemonCloudStartup({
      environment: cloudEnvironment,
      isSessionTerminal: (sessionPublicId) => {
        try {
          return activeStore.requireSession(sessionPublicId).state === "terminal";
        } catch {
          return false;
        }
      },
      secretCustody,
    });
    const cloudDeploymentAuthority = cloudStartup.deploymentAuthority;
    const cloudIdentityNamespace = cloudStartup.identityNamespace;
    let cloudStartupDiagnostic = cloudStartup.diagnostic;
    let cloudStartupUnavailability = cloudStartup.unavailability;
    const cloudJournal = cloudStartup.journal;
    const projectionRecoveryBlocker = cloudStartup.projectionRecoveryBlocker;
    const unavailableProjectionRecoveryStatus = cloudJournal === null
      ? undefined
      : async (): Promise<CloudProjectionRecoveryStatus> =>
          projectionRecoveryStatusFromJournalState((await cloudJournal.read()).state);
    cloudRequestController = new AbortController();
    let cloud = selectDaemonCloudControl(
      null,
      projectionRecoveryBlocker,
      cloudStartupDiagnostic,
      cloudStartupUnavailability,
      unavailableProjectionRecoveryStatus,
      cloudStartup.reenable,
    );
    if (cloudDeploymentAuthority !== null && cloudJournal !== null) {
      let candidateAdapter: StateBackedCloudDaemonAdapter | undefined;
      let candidateBridge: Awaited<ReturnType<
        typeof createLocalCloudDaemonBridgeFromEnvironment
      >> | undefined;
      try {
        const localCloudControl = await createLocalCloudControlFromEnvironment({
          deploymentAuthority: cloudDeploymentAuthority,
          environment: cloudEnvironment,
          lifetimeSignal: cloudRequestController.signal,
          secretCustody,
        });
        if (localCloudControl === null) {
          throw new CloudDeploymentAuthorityError(
            "stale_authority",
            "Cloud deployment authority changed during daemon startup.",
          );
        }
        candidateAdapter = new StateBackedCloudDaemonAdapter({
          readSessionProjectionForCloud: async (sessionId, signal) => {
            const current = serviceReference.current;
            if (current === undefined) {
              throw new Error("The local command service is not ready for a cloud projection read.");
            }
            return await current.readSessionProjectionForCloud(sessionId, signal);
          },
          readProviderAccountProjectionForCloud: async (input) => {
            const current = serviceReference.current;
            if (current === undefined) {
              throw new Error("The local command service is not ready for a cloud account read.");
            }
            return await current.readProviderAccountProjectionForCloud(input);
          },
          // Device commands retain ordinary service admission, idempotency,
          // quarantine and authority checks. They do not receive the separate
          // authenticated-local composition capability.
          executeLocal: async (command, options) => {
            const current = serviceReference.current;
            if (current === undefined) throw new Error("The local command service is not ready.");
            return await current.execute(command, { signal: options.signal });
          },
          executeRemote: async (command, expected, options) => {
            const current = serviceReference.current;
            if (current === undefined) throw new Error("The local command service is not ready.");
            return await current.executeRemote(command, expected, { signal: options.signal });
          },
          gatewayKeyCustody: {
            hasKey: async () => await gatewayKeys.isConfigured(),
            setKey: async (key) => { await gatewayKeys.set(key); },
          },
          paths,
          platform: process.platform,
          store: activeStore,
          cloudIdentityNamespace,
        });
        candidateBridge = await createLocalCloudDaemonBridgeFromEnvironment({
          daemonAuthority: { bootGeneration: generation, bootId },
          daemonAuthorityFence: activeDaemonAuthority,
          deploymentAuthority: cloudDeploymentAuthority,
          environment: cloudEnvironment,
          deviceExecutor: candidateAdapter,
          executor: candidateAdapter,
          lifetimeSignal: cloudRequestController.signal,
          local: candidateAdapter,
          journal: cloudJournal,
          registration: localCloudControl,
          secretCustody,
        });
        if (candidateBridge === null) {
          throw new CloudDeploymentAuthorityError(
            "stale_authority",
            "Cloud deployment authority changed during daemon startup.",
          );
        }
        const cloudBridge = candidateBridge;
        const candidateLifecycle = createCloudDaemonLifecycle({ bridge: cloudBridge });
        const candidateCloud = new BridgedCloudControl(
          localCloudControl,
          cloudBridge,
          candidateAdapter,
          candidateLifecycle,
        );
        cloudAdapter = candidateAdapter;
        cloud = candidateCloud;
        cloudLifecycle = candidateLifecycle;
        canonicalMemoryAuthoritySource = liveAcceptanceCanonicalMemoryTransportDecorator === undefined
          ? localCloudControl
          : {
              snapshotCanonicalMemoryAuthority: async (signal) => {
                const authority = await localCloudControl.snapshotCanonicalMemoryAuthority(signal);
                try {
                  return Object.freeze({
                    ...authority,
                    transport: liveAcceptanceCanonicalMemoryTransportDecorator(
                      authority.transport,
                    ),
                  });
                } catch (error: unknown) {
                  authority.dispose();
                  throw error;
                }
              },
            };
        candidateAdapter = undefined;
        candidateBridge = undefined;
      } catch (error: unknown) {
        cloudRequestController.abort(new Error("Cloud initialization was fenced."));
        if (candidateBridge !== undefined && candidateBridge !== null) {
          try { await candidateBridge.close(); } catch (cleanupError: unknown) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (candidateAdapter !== undefined) {
          try {
            await joinBeforeDeadline("Interrupted cloud account observation shutdown", candidateAdapter.close());
          } catch (cleanupError: unknown) {
            throw cleanupError instanceof DaemonJoinDeadlineError
              ? cleanupError
              : new DaemonAccountObservationJoinError(cleanupError);
          }
        }
        cloudStartupDiagnostic = cloudBindingDiagnostic(error);
        cloudStartupUnavailability = "recovery_required";
        cloud = selectDaemonCloudControl(
          null,
          projectionRecoveryBlocker,
          cloudStartupDiagnostic,
          cloudStartupUnavailability,
          unavailableProjectionRecoveryStatus,
        );
      }
    }
    checkpointBoot();
    factsMemoryControl = new FactsMemoryControlStore(paths.factsMemoryControl);
    const [
      { OhSqliteFactsMemoryEngine },
      { OompaOhMemoryCoordinator },
      { OompaCanonicalMemorySynchronizer },
      { OompaMemorySummarySource },
      { ProjectMemorySerialExecutor },
    ] = await Promise.all([
      import("./storage/oh-facts-memory-engine"),
      import("./daemon/memory-coordinator"),
      import("./cloud/canonical-memory-sync"),
      import("./cloud/memory-summary-source"),
      import("./daemon/project-memory-serial"),
    ]);
    const memoryEngine = new OhSqliteFactsMemoryEngine({
      forkAttestations: activeStore,
    });
    const factsMemory = new OompaFactsMemoryLifecycle({
      attestations: activeStore,
      broker: new LocalFactsMemoryBroker({
        engine: memoryEngine,
        root: paths.factsMemorySessions,
      }),
      control: factsMemoryControl,
    });
    const projectMemorySerial = new ProjectMemorySerialExecutor();
    const canonicalMemorySync = canonicalMemoryAuthoritySource === undefined
      ? undefined
      : new OompaCanonicalMemorySynchronizer({
          authoritySource: canonicalMemoryAuthoritySource,
          engine: memoryEngine,
          onBackgroundFailure: () => {
            serviceReference.current?.recordBackgroundDiagnostic("canonical_memory_sync_failed");
          },
          paths,
          projectSerial: projectMemorySerial,
          store: activeStore,
        });
    const memory = new OompaOhMemoryCoordinator({
      engine: memoryEngine,
      factsMemory,
      paths,
      projectSerial: projectMemorySerial,
      store: activeStore,
      ...(canonicalMemorySync === undefined ? {} : { sync: canonicalMemorySync }),
    });
    // A configured daemon may legitimately start before its first cloud
    // identity is selected. Authentication requires a restart into the newly
    // bound identity, so keep this optional projection absent until that boot
    // instead of making cloud enrollment or local Oompa unavailable.
    if (cloudAdapter !== undefined && cloudIdentityNamespace !== null) {
      const memorySummary = new OompaMemorySummarySource({
        engine: memoryEngine,
        identityNamespace: cloudIdentityNamespace,
        paths,
        projectSerial: projectMemorySerial,
        store: activeStore,
      });
      cloudAdapter.bindMemorySummarySource(async ({ devicePublicId, signal }) =>
        await memorySummary.read({ devicePublicId, signal }));
    }
    const { service: activeService, executeAuthenticatedLocal } = OompaService.createLocalComposition({
      store: activeStore,
      paths,
      codex,
      claude,
      personalCodex,
      personalClaude,
      personalCodexHome: personalHomes.codexHome,
      readPersonalCodexAutomations: readPersonalCodexAutomationAuthority,
      personalDiscovery,
      claudeProcessLiveness: personalClaudeDiscovery.claudeProcessLiveness,
      cloud,
      daemonAuthority: activeDaemonAuthority,
      daemonGeneration: generation,
      daemonBootId: bootId,
      platform: process.platform,
      eventCursors,
      usageHistoryCursors,
      workCapabilities,
      factsMemory,
      memory,
      beforeMemoryClose: closeCloudLifecycle,
      ...(canonicalMemorySync === undefined ? {} : { canonicalMemorySync }),
      gatewayKeys,
      proseResponder: new AiGatewayProseResponder({
        readKey: async () => await gatewayKeys.read(),
      }),
      requestStop,
    });
    serviceReference.current = activeService;
    service = activeService;
    const recovery = activeService.recover();
    const recoveryOutcome = await Promise.race([
      recovery.then(() => "recovered" as const),
      stopped.then(() => "interrupted" as const),
    ]);
    if (recoveryOutcome === "interrupted") {
      await joinBeforeDeadline("Interrupted daemon recovery", recovery);
      throw new DaemonBootInterruptedError();
    }
    checkpointBoot();
    usagePoller = new AccountUsagePoller({
      listAccountIds: () => activeStore.listProfiles()
        .filter((profile) => profile.state === "signed_in" && profile.processGeneration > 0)
        .map((profile) => profile.id),
      poll: async (accountId, signal) => {
        await activeService.execute(
          { kind: "account.usage", account: accountId, refresh: true },
          { signal },
        );
      },
      onFailure: (_accountId, error) => {
        activeService.recordBackgroundDiagnostic("usage_poll_account_failed", error);
      },
      onTickFailure: (error) => {
        activeService.recordBackgroundDiagnostic("usage_poll_tick_failed", error);
      },
    });
    usagePoller.start();
    adoptionPoller = new AccountUsagePoller({
      listAccountIds: () => activeStore.listSessionAdoptionPolicies()
        .filter((policy) => policy.enabled)
        .map((policy) => policy.provider),
      poll: async (provider, signal) => {
        await activeService.discoverPersonalSessions(adoptableProviderSchema.parse(provider), signal);
      },
      onFailure: (_provider, error) => {
        activeService.recordBackgroundDiagnostic("session_adoption_failed", error);
      },
      onTickFailure: (error) => {
        activeService.recordBackgroundDiagnostic("session_adoption_failed", error);
      },
    });
    adoptionPoller.start();
    cloudLifecycle?.start();
    server = await LocalDaemonServer.start({
      paths,
      handler: async (command, context) => {
        await daemonLock.assertCurrent();
        if (command.kind === "daemon.stop") {
          return admitExactDaemonStop({
            command,
            receipt: daemonLock.receipt,
            afterResponse: (callback) => context.afterResponse(callback),
            requestStop,
          });
        }
        const data = await executeAuthenticatedLocal(command, { signal: context.signal, afterResponse: (callback) => context.afterResponse(callback) });
        if (command.kind !== "daemon.status") return data;
        const daemon = identityFromReceipt(daemonLock.receipt);
        if (daemon === null) throw new Error("Daemon authority identity is not published.");
        const acceptance = liveAcceptancePersonalClaudeProof?.observeWrites();
        return {
          ...(typeof data === "object" && data !== null ? data : {}),
          running: true,
          daemon,
          ...(acceptance === undefined ? {} : { liveAcceptancePersonalClaude: Object.freeze({
            userWriteAttempts: acceptance.userWriteAttempts,
            acceptedUserWrites: acceptance.acceptedUserWrites,
            acknowledgmentWithheld: acceptance.acknowledgmentWithheld,
          }) }),
        };
      },
    });
    checkpointBoot();
    await daemonLock.publish({ state: "ready", generation, bootId });
    await stopped;
    if (claudeHostToolTransportError !== undefined) {
      throw claudeHostToolTransportError;
    }
    await daemonLock.publish({ state: "stopping", generation, bootId });
  } catch (error: unknown) {
    if (!(error instanceof DaemonBootInterruptedError)) runError = error;
  } finally {
    if (stopLatch.deliver === requestStop) stopLatch.deliver = undefined;
    closePersonalClaudeProofAdmission();
    runError ??= unhandledRejectionError ?? personalClaudeProofFailure;
    if (usagePoller !== undefined) usagePollerShutdown ??= usagePoller.close();
    if (adoptionPoller !== undefined) adoptionPollerShutdown ??= adoptionPoller.close();
    if (service !== undefined) serviceShutdown ??= service.close();
    else daemonAuthority?.close();
    claudeHostToolServer?.beginShutdown();
    server?.beginShutdown(new Error("Daemon lifetime ended."));
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    process.off("unhandledRejection", onUnhandledRejection);

    const forceReason = runError instanceof DaemonJoinDeadlineError || runError instanceof LocalDaemonShutdownTimeoutError
      ? runError
      : undefined;
    if (forceReason === undefined && server !== undefined) {
      try { await server.close({ deadlineMs: 5_000 }); } catch (error: unknown) {
        if (error instanceof LocalDaemonShutdownTimeoutError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && usagePollerShutdown !== undefined) {
      try { await joinBeforeDeadline("Usage poller shutdown", usagePollerShutdown); } catch (error: unknown) {
        if (error instanceof DaemonJoinDeadlineError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && adoptionPollerShutdown !== undefined) {
      try { await joinBeforeDeadline("Session adoption poller shutdown", adoptionPollerShutdown); } catch (error: unknown) {
        if (error instanceof DaemonJoinDeadlineError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && cloudLifecycle !== undefined) {
      try { await joinBeforeDeadline("Cloud daemon shutdown", closeCloudLifecycle()); } catch (error: unknown) {
        if (error instanceof DaemonJoinDeadlineError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError)) {
      try {
        if (serviceShutdown !== undefined) await joinBeforeDeadline("Provider service shutdown", serviceShutdown);
        else {
          const runtimes: Readonly<{
            close: () => Promise<void>;
            provider: "codex" | "claude" | "personal_codex" | "personal_claude";
          }>[] = [];
          if (codex !== undefined) {
            const runtime = codex;
            runtimes.push({ close: async () => await runtime.close(), provider: "codex" });
          }
          if (claude !== undefined) {
            const runtime = claude;
            runtimes.push({ close: async () => await runtime.close(), provider: "claude" });
          }
          if (personalCodex !== undefined) {
            const runtime = personalCodex;
            runtimes.push({ close: async () => await runtime.close(), provider: "personal_codex" });
          }
          if (personalClaude !== undefined) {
            const runtime = personalClaude;
            runtimes.push({ close: async () => await runtime.close(), provider: "personal_claude" });
          }
          const closed = await joinBeforeDeadline(
            "Provider runtime shutdown",
            Promise.allSettled(runtimes.map(async (runtime) => await runtime.close())),
          );
          const failures = closed.flatMap((outcome, index) => outcome.status === "fulfilled"
            ? []
            : [new Error(`${runtimes[index]?.provider ?? "Unknown"} runtime shutdown failed.`, {
                cause: outcome.reason,
              })]);
          if (failures.length > 0) {
            cleanupErrors.push(
              new AggregateError(failures, "Provider runtime shutdown was incomplete."),
            );
          }
        }
      } catch (error: unknown) {
        if (error instanceof DaemonJoinDeadlineError) runError = error;
        else cleanupErrors.push(error);
      }
    }
    // The hosted-memory synchronizer is owned by the service/memory
    // coordinator but uses the cloud authority snapshot. Join it before
    // aborting or closing that transport so shutdown cannot strand an
    // indeterminate write or reopen an Oh database after local custody closes.
    cloudRequestController?.abort(new Error("Cloud daemon transport is closing."));
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && cloudAdapter !== undefined) {
      try { await joinBeforeDeadline("Cloud account observation shutdown", cloudAdapter.close()); } catch (error: unknown) {
        runError = error instanceof DaemonJoinDeadlineError
          ? error
          : new DaemonAccountObservationJoinError(error);
      }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && claudeHostToolServer !== undefined) {
      try { await claudeHostToolServer.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    if (!(runError instanceof DaemonJoinDeadlineError) && !(runError instanceof LocalDaemonShutdownTimeoutError) && claudeHostToolAuthority !== undefined) {
      try { await claudeHostToolAuthority.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    if (liveAcceptanceClaudeProof !== undefined) {
      try {
        liveAcceptanceClaudeProof.closeDaemonGeneration(generation ?? null);
      } catch (error: unknown) {
        cleanupErrors.push(error);
      }
    }

    if (liveAcceptancePersonalClaudeProof !== undefined) {
      try {
        await joinBeforeDeadline(
          "Personal Claude acceptance process collection",
          liveAcceptancePersonalClaudeProof.closeDaemonGeneration(generation ?? null),
        );
      } catch (error: unknown) {
        // This collector must prove every observed child and both actual native
        // streams joined. A rejection is custody uncertainty, not a benign
        // operation error; preserve the ordinary forced-recovery boundary.
        const failure = new DaemonJoinDeadlineError("Personal Claude acceptance process collection", 5_000);
        failure.cause = error;
        runError = failure;
      }
    }

    if (runError instanceof DaemonJoinDeadlineError || runError instanceof LocalDaemonShutdownTimeoutError) {
      const diagnostic = safeDaemonFailure(runError);
      await daemonLock.publish({
        state: "failed",
        ...(generation === undefined || bootId === undefined ? {} : { generation, bootId }),
        failure: diagnostic,
      }).catch(() => undefined);
      process.stderr.write(`oompa: ${diagnostic}\n`);
      process.exit(70);
    }

    if (factsMemoryControl !== undefined) {
      try { factsMemoryControl.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    if (store !== undefined) {
      if (generation !== undefined && bootId !== undefined) {
        try { store.markDaemonStopped(generation, bootId); } catch (error: unknown) { cleanupErrors.push(error); }
      }
      try { store.close(); } catch (error: unknown) { cleanupErrors.push(error); }
    }
    const normalizedRunError = runError === undefined
      ? undefined
      : unhandledRejectionError !== undefined && runError === unhandledRejectionError
        ? unhandledRejectionError.message
        : safeDaemonFailure(runError);
    await daemonLock.release(normalizedRunError === undefined
      ? { state: "stopped" }
      : { state: "failed", failure: normalizedRunError }).catch((error: unknown) => cleanupErrors.push(error));
  }
  if (runError !== undefined) {
    const normalized = runError instanceof Error ? runError : new Error("Oompa daemon failed with a non-Error value.");
    throw cleanupErrors.length === 0 ? normalized : new AggregateError([normalized, ...cleanupErrors], "Oompa daemon failed and cleanup was incomplete.");
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Oompa daemon cleanup failed.");
  return 0;
}

export async function runDaemon(
  installation: OompaInstallation = createProductionInstallation(),
  options: RunDaemonOptions = {},
): Promise<number> {
  const cloud = requireCloudDeploymentEnvironment(installation.cloudEnvironment);
  if (
    (
      options.liveAcceptanceCanonicalMemoryTransportDecorator !== undefined
      || options.liveAcceptanceClaudeProof !== undefined
      || options.liveAcceptancePersonalClaudeProof !== undefined
    )
    && installation.kind !== "live_acceptance"
  ) {
    throw new Error(
      "Daemon acceptance hooks are restricted to live acceptance.",
    );
  }
  const stopLatch: DaemonStopLatch = { deliver: undefined, requested: false };
  const requestLatchedStop = () => {
    if (stopLatch.requested) return;
    stopLatch.requested = true;
    stopLatch.deliver?.();
  };
  const stopSignal = options.stopSignal;
  stopSignal?.addEventListener("abort", requestLatchedStop, { once: true });
  // Adding an abort listener to an already-aborted signal does not dispatch an
  // event. Check after registration so no stop can be lost around this edge.
  if (stopSignal?.aborted === true) requestLatchedStop();
  try {
    return await runDaemonLifecycle(
      { ...installation, cloudEnvironment: cloud.environment },
      stopLatch,
      options.liveAcceptanceCanonicalMemoryTransportDecorator,
      options.liveAcceptanceClaudeProof,
      options.liveAcceptancePersonalClaudeProof,
    );
  } finally {
    stopLatch.deliver = undefined;
    stopSignal?.removeEventListener("abort", requestLatchedStop);
  }
}

const commandCaller = (
  input: CliMainInput,
): ((command: LocalCommand, signal?: AbortSignal) => Promise<CommandResponse>) => {
  if (input.callDaemon !== undefined) return input.callDaemon;
  const installation = input.installation ?? createProductionInstallation();
  return async (command, signal) => await callWithAutostart(
    installation,
    command,
    signal,
    input.startDaemon,
  );
};

const protectedInputDescriptor = (source: ProtectedInputSource): number =>
  source.kind === "stdin" ? 0 : source.fd;

const protectedInputReplayCommand = (
  invocation: Extract<CliInvocation, {
    kind: "auth.login-protected" | "interaction.resolve-protected";
  }>,
): string => {
  if (invocation.kind === "auth.login-protected") {
    return "oompa auth login --input-stdin --json < /path/to/protected.json";
  }
  const common = `${invocation.interaction} --revision ${String(invocation.expectedRevision)}`;
  if (invocation.resolution.kind === "user_answers") {
    return `oompa interaction answer ${common} --input-stdin --json < /path/to/protected.json`;
  }
  if (invocation.resolution.kind === "permission_grant") {
    const scope = invocation.resolution.scope === null
      ? ""
      : ` --scope ${invocation.resolution.scope}`;
    return `oompa interaction grant ${common}${scope} --input-stdin --json < /path/to/protected.json`;
  }
  return `oompa interaction submit ${common} --action accept --input-stdin --json < /path/to/protected.json`;
};

const rejectJsonTerminalProtectedInput = (
  invocation: Extract<CliInvocation, {
    kind: "auth.login-protected" | "interaction.resolve-protected";
  }>,
  output: Output,
  input: CliMainInput,
): number | null => {
  if (!invocation.json) return null;
  const fd = protectedInputDescriptor(invocation.input);
  const terminal = (input.isTerminalDescriptor ?? isatty)(fd);
  if (!terminal) return null;
  return renderFailure({
    code: "INTERACTION_REQUIRED",
    details: {
      nextCommand: protectedInputReplayCommand(invocation),
      protectedInput: "non_terminal_stdin_or_fd",
    },
    message: "JSON mode never prompts. Redirect one protected JSON document from a non-terminal stdin or file descriptor.",
  }, true, output);
};

const renderJsonlFailure = (
  error: { code: string; message: string; details?: unknown },
  output: Output,
): number => renderFailure(error, true, {
  writeStdout: (value) => output.writeStderr(value),
  writeStderr: (value) => output.writeStderr(value),
});

const isClosedStdout = (error: unknown): boolean => {
  const code = error !== null && typeof error === "object" && "code" in error
    ? String(error.code)
    : "";
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
};

const readInvocationProtectedDocument = async (
  source: ProtectedInputSource,
  output: Output,
  input: CliMainInput,
  maximumBytes = protectedInputMaximumBytes,
): Promise<unknown> => {
  if (input.readProtectedDocument !== undefined) return await input.readProtectedDocument(source);
  const fd = protectedInputDescriptor(source);
  const terminal = (input.isTerminalDescriptor ?? isatty)(fd);
  if (!terminal) return await readProtectedDocument(source, output, undefined, maximumBytes);
  if (!input.interactive || !process.stderr.isTTY) {
    throw new CliUsageError(
      "Terminal protected input requires an interactive stdin and a visible terminal on stderr. Redirect one protected JSON document from a non-terminal stdin or file descriptor instead.",
    );
  }
  return await withProtectedTerminalLifecycle(async (signal) =>
    await readProtectedDocument(source, output, signal, maximumBytes));
};

/*
 * The AI Gateway key is one line, not a JSON document, so it has its own
 * bounded reader. It is read from a descriptor the caller redirected (or typed
 * with echo off), handed to the daemon once, and zeroed here; it is never an
 * argument, never echoed, and never part of any rendered result.
 */
const gatewayKeyMaximumBytes = 1_024;

const readGatewayKeyValue = async (
  source: ProtectedInputSource,
  output: Output,
  input: CliMainInput,
): Promise<string> => {
  const fd = protectedInputDescriptor(source);
  const terminal = (input.isTerminalDescriptor ?? isatty)(fd);
  let bytes: Buffer;
  if (terminal) {
    if (fd !== 0) {
      throw new CliUsageError("A typed gateway key is supported only through stdin.");
    }
    if (!input.interactive || !process.stderr.isTTY) {
      throw new CliUsageError(
        "Typing the gateway key requires an interactive stdin and a visible terminal on stderr. Redirect it from a non-terminal stdin or file descriptor instead.",
      );
    }
    bytes = await withProtectedTerminalLifecycle(async (signal) =>
      await readHiddenProtectedLine(output, signal));
  } else {
    try {
      bytes = readBoundedDescriptor(fd, gatewayKeyMaximumBytes);
    } catch (error: unknown) {
      if (error instanceof CliUsageError) throw error;
      throw new CliUsageError("The gateway key could not be read from the selected descriptor.");
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new CliUsageError("The gateway key must be valid UTF-8 text.");
  } finally {
    bytes.fill(0);
  }
};

async function executeGatewayKeySet(
  invocation: Extract<CliInvocation, { kind: "autorespond.gateway-set" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const key = await readGatewayKeyValue(invocation.input, output, input);
  const parsed = gatewayKeySchema.safeParse(key);
  if (!parsed.success) {
    throw new CliUsageError(
      "The gateway key must be one line of printable ASCII between "
      + `${String(GATEWAY_KEY_MIN_BYTES)} and ${String(GATEWAY_KEY_MAX_BYTES)} characters.`,
    );
  }
  const command = { key: parsed.data, kind: "autorespond.gateway-set" } as const;
  const response = await commandCaller(input)(command);
  if (!response.ok) return renderFailure(response.error, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

async function executeProtectedInteraction(
  invocation: Extract<CliInvocation, { kind: "interaction.resolve-protected" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const terminalRefusal = rejectJsonTerminalProtectedInput(invocation, output, input);
  if (terminalRefusal !== null) return terminalRefusal;
  const document = await readInvocationProtectedDocument(invocation.input, output, input);
  const command = completeProtectedInteraction(invocation, document);
  const response = await commandCaller(input)(command);
  if (!response.ok) return renderFailure(response.error, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

async function executeProtectedAuthLogin(
  invocation: Extract<CliInvocation, { kind: "auth.login-protected" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const terminalRefusal = rejectJsonTerminalProtectedInput(invocation, output, input);
  if (terminalRefusal !== null) return terminalRefusal;
  const document = await readInvocationProtectedDocument(invocation.input, output, input);
  const command = completeProtectedAuthLogin(invocation, document);
  const response = await commandCaller(input)(command);
  if (!response.ok) return renderFailure(response.error, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

type WorkCommandError = Extract<CommandResponse, { ok: false }>["error"];

type WorkFailureMapping = Readonly<{
  commandCode: WorkCommandError["code"];
  protocolCode: WorkAgentProtocolError["code"];
  recovery: WorkAgentProtocolError["recovery"];
  retryable: boolean;
}>;

const workProtocolErrorMessages = {
  invalid_request: "The work request is invalid.",
  not_found: "A required work entity was not found.",
  conflict: "The work mutation conflicts with current durable state.",
  fence_mismatch: "The attempt fence no longer authorizes this mutation.",
  lease_expired: "The attempt lease expired before this mutation.",
  not_owner: "The actor does not own the selected attempt.",
  route_mismatch: "The selected session does not satisfy the durable task route.",
  invalid_state: "The work mutation is not valid in the current durable state.",
  limit_exceeded: "A durable work protocol limit prevents this operation.",
  effect_unknown: "The work effect is uncertain; replay the exact same request document.",
  internal: "The work mutation failed at an internal boundary.",
} as const satisfies Readonly<Record<WorkAgentProtocolError["code"], string>>;

const workFailureByReason = {
  ATTEMPT_EXHAUSTED: { commandCode: "CONFLICT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  ATTEMPT_NOT_OWNER: { commandCode: "CONFLICT", protocolCode: "not_owner", recovery: "refresh_state_then_new_request", retryable: false },
  ATTEMPT_NOT_CLAIMABLE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  ATTEMPT_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  ATTEMPT_RECOVERY_REQUIRED: { commandCode: "RECOVERY_REQUIRED", protocolCode: "effect_unknown", recovery: "replay_exact_request", retryable: true },
  BAD_CURSOR: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  BAD_IDEMPOTENCY_KEY: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  DEPENDENCY_CYCLE: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  DEPENDENCY_INCOMPLETE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  EVIDENCE_INVALID: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  FENCE_MISMATCH: { commandCode: "CONFLICT", protocolCode: "fence_mismatch", recovery: "refresh_state_then_new_request", retryable: false },
  IDEMPOTENCY_CONFLICT: { commandCode: "CONFLICT", protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  LEASE_EXPIRED: { commandCode: "CONFLICT", protocolCode: "lease_expired", recovery: "refresh_state_then_new_request", retryable: false },
  MEMBER_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  NO_READY_TASK: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  NOT_REVIEWABLE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  REVISION_CONFLICT: { commandCode: "CONFLICT", protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  ROUTE_MISMATCH: { commandCode: "CONFLICT", protocolCode: "route_mismatch", recovery: "refresh_state_then_new_request", retryable: false },
  SELF_REVIEW: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  SIGNAL_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  TASK_DEPTH_EXCEEDED: { commandCode: "INVALID_INPUT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  TASK_LIMIT_EXCEEDED: { commandCode: "INVALID_INPUT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  TASK_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  UNKNOWN_DEPENDENCY: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  UNKNOWN_PARENT: { commandCode: "INVALID_INPUT", protocolCode: "invalid_request", recovery: "none", retryable: false },
  WORK_CAPACITY_EXCEEDED: { commandCode: "CONFLICT", protocolCode: "limit_exceeded", recovery: "none", retryable: false },
  WORK_NOT_ACTIVE: { commandCode: "CONFLICT", protocolCode: "invalid_state", recovery: "refresh_state_then_new_request", retryable: false },
  WORK_NOT_FOUND: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  WORK_RELEASED: { commandCode: "NOT_FOUND", protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
} as const satisfies Readonly<Record<string, WorkFailureMapping>>;

type WorkFailureReason = keyof typeof workFailureByReason;

const workCommandExitCodes = {
  INVALID_INPUT: 2,
  NOT_FOUND: 4,
  AMBIGUOUS: 1,
  CONFLICT: 1,
  INTERACTION_REQUIRED: 6,
  UNAVAILABLE: 5,
  RECOVERY_REQUIRED: 7,
  INTERNAL: 1,
} as const satisfies Readonly<Record<WorkCommandError["code"], number>>;

const workFailureReason = (details: unknown): WorkFailureReason | null => {
  if (details === null || typeof details !== "object" || Array.isArray(details)) return null;
  const reason = (details as Readonly<Record<string, unknown>>).reason;
  return typeof reason === "string" && Object.hasOwn(workFailureByReason, reason)
    ? reason as WorkFailureReason
    : null;
};

const fallbackWorkFailure = {
  INVALID_INPUT: { protocolCode: "invalid_request", recovery: "none", retryable: false },
  NOT_FOUND: { protocolCode: "not_found", recovery: "refresh_state_then_new_request", retryable: false },
  AMBIGUOUS: { protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  CONFLICT: { protocolCode: "conflict", recovery: "refresh_state_then_new_request", retryable: false },
  INTERACTION_REQUIRED: { protocolCode: "invalid_state", recovery: "none", retryable: false },
  UNAVAILABLE: { protocolCode: "internal", recovery: "retry_same_request", retryable: true },
  RECOVERY_REQUIRED: { protocolCode: "effect_unknown", recovery: "replay_exact_request", retryable: true },
  INTERNAL: { protocolCode: "internal", recovery: "none", retryable: false },
} as const satisfies Readonly<Record<
  WorkCommandError["code"],
  Readonly<{ protocolCode: WorkAgentProtocolError["code"]; recovery: WorkAgentProtocolError["recovery"]; retryable: boolean }>
>>;

const mapWorkFailure = (failure: WorkCommandError): Readonly<{
  error: WorkAgentProtocolError;
  exitCode: number;
}> => {
  const reason = workFailureReason(failure.details);
  const exact = reason === null ? null : workFailureByReason[reason];
  const mapped = exact !== null && exact.commandCode === failure.code
    ? exact
    : fallbackWorkFailure[failure.code];
  return {
    error: {
      code: mapped.protocolCode,
      message: workProtocolErrorMessages[mapped.protocolCode],
      recovery: mapped.recovery,
      retryable: mapped.retryable,
      exitCode: workCommandExitCodes[failure.code],
    },
    exitCode: workCommandExitCodes[failure.code],
  };
};

const writeWorkProtocolFailure = (
  requestId: string | null,
  error: WorkAgentProtocolError,
  output: Output,
  version: typeof WORK_APPLY_REQUEST_LEGACY_VERSION | typeof WORK_APPLY_REQUEST_VERSION = WORK_APPLY_REQUEST_VERSION,
): void => {
  output.writeStdout(`${safeJson(workAgentProtocolResponseSchema.parse({
    protocol: WORK_PROTOCOL,
    version,
    requestId,
    ok: false,
    error,
  }))}\n`);
};

const admittedWorkRequestCorrelation = (document: unknown): Readonly<{
  requestId: string;
  version: typeof WORK_APPLY_REQUEST_LEGACY_VERSION | typeof WORK_APPLY_REQUEST_VERSION;
}> | null => {
  if (document === null || typeof document !== "object" || Array.isArray(document)) return null;
  const record = document as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  const version = record.version;
  if (
    version !== WORK_APPLY_REQUEST_LEGACY_VERSION
    && version !== WORK_APPLY_REQUEST_VERSION
  ) return null;
  const exactKeys = version === WORK_APPLY_REQUEST_LEGACY_VERSION
    ? ["operation", "protocol", "requestId", "version"]
    : record.presetContract === undefined
      ? ["operation", "protocol", "requestId", "version"]
      : ["operation", "presetContract", "protocol", "requestId", "version"];
  if (
    JSON.stringify(keys) !== JSON.stringify(exactKeys)
    || record.protocol !== WORK_PROTOCOL
    || typeof record.requestId !== "string"
  ) return null;
  const parsed = z.string().uuid().safeParse(record.requestId);
  return parsed.success ? { requestId: parsed.data, version } : null;
};

async function executeWorkApply(
  invocation: Extract<CliInvocation, { kind: "work.apply-input" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const descriptor = protectedInputDescriptor(invocation.input);
  if ((input.isTerminalDescriptor ?? isatty)(descriptor)) {
    writeWorkProtocolFailure(null, {
      code: "invalid_state",
      message: "Work operations require one bounded JSON document from non-terminal stdin or a file descriptor.",
      recovery: "none",
      retryable: false,
      exitCode: 6,
    }, output);
    return 6;
  }
  let document: unknown;
  try {
    document = await readInvocationProtectedDocument(
      invocation.input,
      output,
      input,
      WORK_PROTOCOL_REQUEST_MAX_BYTES,
    );
  } catch {
    writeWorkProtocolFailure(null, {
      code: "invalid_request",
      message: "The work request input is not one bounded JSON document.",
      recovery: "none",
      retryable: false,
      exitCode: 2,
    }, output);
    return 2;
  }
  const request = workProtocolRequestSchema.safeParse(document);
  if (!request.success) {
    const correlation = admittedWorkRequestCorrelation(document);
    writeWorkProtocolFailure(correlation?.requestId ?? null, {
      code: "invalid_request",
      message: "The work request document does not match the strict versioned Oompa work protocol.",
      recovery: "none",
      retryable: false,
      exitCode: 2,
    }, output, correlation?.version ?? WORK_APPLY_REQUEST_VERSION);
    return 2;
  }
  const command = localCommandSchema.parse({
    kind: "work.apply",
    requestId: request.data.requestId,
    ...(request.data.version === WORK_APPLY_REQUEST_VERSION
      ? {
          requestVersion: request.data.version,
          ...(request.data.presetContract === undefined
            ? {}
            : { presetContract: request.data.presetContract }),
        }
      : {}),
    operation: request.data.operation,
  });
  if (command.kind !== "work.apply") throw new CliUsageError("The work operation is invalid.");
  let response: CommandResponse;
  try {
    response = await commandCaller(input)(command);
  } catch (error: unknown) {
    if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
    writeWorkProtocolFailure(request.data.requestId, {
      code: "effect_unknown",
      message: "The local transport outcome is uncertain; replay the exact same request document.",
      recovery: "replay_exact_request",
      retryable: true,
      exitCode: 7,
    }, output, request.data.version);
    return 7;
  }
  if (!response.ok) {
    const failure = mapWorkFailure(response.error);
    writeWorkProtocolFailure(request.data.requestId, failure.error, output, request.data.version);
    return failure.exitCode;
  }
  try {
    renderSuccess(command, response.data, true, output);
  } catch (error: unknown) {
    if (!(error instanceof InvalidCommandResponseError)) throw error;
    writeWorkProtocolFailure(request.data.requestId, {
      code: "effect_unknown",
      message: "The daemon reported success without a valid bound result; replay the exact same request document.",
      recovery: "replay_exact_request",
      retryable: true,
      exitCode: 7,
    }, output, request.data.version);
    return 7;
  }
  return 0;
}

const accountLoginPublicData = (
  result: ReturnType<typeof parseAccountLoginResponse>,
  handoff:
    | Readonly<{
        disposition: "preserved_caller_removes_after_login";
        documentVersion: 1;
        path: string;
        status: "written";
      }>
    | Readonly<{ status: "shown_in_protected_terminal" | "unavailable_on_replay" }>
    | undefined,
): unknown => ({
  account: result.account,
  idempotencyKey: result.idempotencyKey,
  login: {
    status: result.kind === "signed_in"
      ? "signed_in"
      : result.kind === "settled"
        ? "settled"
        : "pending",
    ...(handoff === undefined ? {} : { handoff }),
  },
});

const renderProtectedForegroundLogin = (
  document: DeviceLoginDocument,
  output: Output,
): void => {
  output.writeStderr([
    `Complete Codex ${document.method === "device_code" ? "device-code " : ""}login for ${terminalSafe(document.accountLabel)}.`,
    `URL: ${terminalSafe(document.verificationUrl)}`,
    ...(document.userCode === undefined ? [] : [`Code: ${terminalSafe(document.userCode)}`]),
    `If needed, cancel with: ${terminalSafe(document.cancelCommand)}`,
    "",
  ].join("\n"));
};

const protectedInteractionInspectCommand = (
  invocation: Extract<CliInvocation, { kind: "interaction.inspect-protected" }>,
): string => `oompa interaction inspect ${invocation.command.interaction} --revision ${String(invocation.command.expectedRevision)} --handoff-file /absolute/path/to/empty-protected-approval.json${invocation.json ? " --json" : ""}`;

async function executeProtectedInteractionInspect(
  invocation: Extract<CliInvocation, { kind: "interaction.inspect-protected" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const interactive = input.interactive === true;
  const protectedTerminalWriter = output.writeProtectedStderr?.bind(output);
  const protectedTerminal = interactive
    && (input.isTerminalDescriptor ?? isatty)(2)
    && protectedTerminalWriter !== undefined;
  if (invocation.handoffFile === undefined && (invocation.json || !protectedTerminal)) {
    return renderFailure({
      code: "INTERACTION_REQUIRED",
      details: {
        nextCommand: protectedInteractionInspectCommand(invocation),
        protectedOutput: "absolute_canonical_owned_mode_0600_empty_file",
      },
      message: "Protected approval inspection requires a foreground terminal or a caller-owned protected output file.",
      trustedLocalPaths: true,
    }, invocation.json, output);
  }

  let protectedOutput: ProtectedOutputFile | undefined;
  const closeProtectedOutput = (): boolean => {
    const current = protectedOutput;
    protectedOutput = undefined;
    return current?.close() ?? true;
  };
  try {
    if (invocation.handoffFile !== undefined) {
      try {
        // Prove and hold the caller-owned empty file before asking for private authority.
        protectedOutput = new ProtectedOutputFile(invocation.handoffFile);
      } catch (error: unknown) {
        if (!(error instanceof ProtectedOutputError)) throw error;
        return renderFailure({
          code: "INVALID_INPUT",
          details: {
            requirement: "absolute_canonical_current_user_owned_mode_0700_parent_empty_single_link_mode_0600_regular_file",
          },
          message: "The approval-detail handoff file does not satisfy the protected output contract.",
        }, invocation.json, output);
      }
    }

    const response = await commandCaller(input)(invocation.command);
    if (!response.ok) return renderFailure(response.error, invocation.json, output);
    let document: ReturnType<typeof parseProtectedInteractionDetailResponse>;
    try {
      document = parseProtectedInteractionDetailResponse(response.data, {
        interactionId: invocation.command.interaction,
        revision: invocation.command.expectedRevision,
      });
    } catch (error: unknown) {
      if (!(error instanceof ProtectedOutputError)) throw error;
      return renderFailure({
        code: "INTERNAL",
        message: "The daemon returned an invalid protected approval-detail document.",
      }, invocation.json, output);
    }

    let terminalDocument: string | undefined;
    if (protectedOutput === undefined) {
      terminalDocument = renderProtectedInteractionDetail(document);
      const terminalBytes = new TextEncoder().encode(terminalDocument);
      const terminalSafeSize = terminalBytes.byteLength <= PROTECTED_INTERACTION_TERMINAL_MAXIMUM_BYTES;
      terminalBytes.fill(0);
      if (!terminalSafeSize) {
        return renderFailure({
          code: "INTERACTION_REQUIRED",
          details: {
            nextCommand: protectedInteractionInspectCommand(invocation),
            protectedOutput: "absolute_canonical_owned_mode_0600_empty_file",
          },
          message: "The complete approval authority is too large for safe terminal display. Use a caller-owned protected output file.",
          trustedLocalPaths: true,
        }, invocation.json, output);
      }
    }

    if (protectedOutput !== undefined) {
      try {
        const handoffPath = protectedOutput.path;
        protectedOutput.write(document);
        if (!closeProtectedOutput()) throw new ProtectedOutputError("write_unproven");
        renderSuccess(invocation.command, {
          binding: document.binding,
          protectedOutput: {
            disposition: "preserved_caller_removes_after_decision",
            documentVersion: document.version,
            path: handoffPath,
            status: "written",
          },
        }, invocation.json, output);
        return 0;
      } catch (error: unknown) {
        if (!(error instanceof ProtectedOutputError)) throw error;
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          message: "Protected approval detail may have reached the caller-owned file, but Oompa could not prove the completed write. Treat the file as private material and remove it before retrying.",
        }, invocation.json, output);
      }
    }

    if (protectedTerminalWriter === undefined || terminalDocument === undefined) {
      throw new Error("Protected terminal authority changed during interaction inspection.");
    }
    protectedTerminalWriter(terminalDocument);
    renderSuccess(invocation.command, {
      binding: document.binding,
      protectedOutput: { status: "shown_in_protected_terminal" },
    }, false, output);
    return 0;
  } finally {
    closeProtectedOutput();
  }
}

async function executeAccountLogin(
  invocation: Extract<CliInvocation, { kind: "account.login-handoff" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const interactive = input.interactive === true;
  if (invocation.handoffFile === undefined && (invocation.json || !interactive)) {
    return renderFailure({
      code: "INTERACTION_REQUIRED",
      details: {
        idempotencyKey: invocation.command.idempotencyKey,
        nextCommand: invocation.replayCommand,
        protectedOutput: "absolute_canonical_owned_mode_0600_empty_file",
      },
      message: "Account login requires a protected handoff file outside a foreground terminal. Create the file under a current-user-owned mode 0700 directory, set the empty file to mode 0600, then run the exact same-key command.",
      trustedLocalPaths: true,
    }, invocation.json, output);
  }

  let protectedOutput: ProtectedOutputFile | undefined;
  const closeProtectedOutput = (): boolean => {
    const current = protectedOutput;
    protectedOutput = undefined;
    return current?.close() ?? true;
  };
  try {
    if (invocation.handoffFile !== undefined) {
      try {
        protectedOutput = new ProtectedOutputFile(invocation.handoffFile);
      } catch (error: unknown) {
        if (!(error instanceof ProtectedOutputError)) throw error;
        return renderFailure({
          code: "INVALID_INPUT",
          details: {
            requirement: "absolute_canonical_current_user_owned_mode_0700_parent_empty_single_link_mode_0600_regular_file",
          },
          message: "The login handoff file does not satisfy the protected output contract.",
        }, invocation.json, output);
      }
    }

    const callDaemon = commandCaller(input);
    let listed: CommandResponse;
    try {
      listed = await callDaemon({ kind: "account.list" });
    } catch (error: unknown) {
      if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
      return renderFailure({
        code: "UNAVAILABLE",
        details: {
          idempotencyKey: invocation.command.idempotencyKey,
          nextCommand: invocation.replayCommand,
          providerEffectDispatched: false,
        },
        message: "Oompa could not resolve the exact account authority. No provider login was dispatched; retry the same command.",
        trustedLocalPaths: true,
      }, invocation.json, output);
    }
    if (!listed.ok) return renderFailure(listed.error, invocation.json, output);
    let authorities: ReturnType<typeof parseAccountLoginAuthorityList>;
    try {
      authorities = parseAccountLoginAuthorityList(listed.data);
    } catch (error: unknown) {
      if (!(error instanceof ProtectedOutputError)) throw error;
      return renderFailure({
        code: "INTERNAL",
        message: "The daemon returned an invalid account authority list.",
      }, invocation.json, output);
    }
    const selected = selectByIdOrLabel(authorities, invocation.command.account);
    if (selected.kind === "missing") {
      return renderFailure({
        code: "NOT_FOUND",
        message: "No account matches the requested login authority.",
      }, invocation.json, output);
    }
    if (selected.kind === "ambiguous") {
      return renderFailure({
        code: "AMBIGUOUS",
        details: {
          candidates: selected.values.map(({ id, label }) => ({ id, label })),
        },
        message: "The account selector is ambiguous. Use the exact account ID.",
      }, invocation.json, output);
    }
    const command = { ...invocation.command, account: selected.value.id };
    const replayCommand = accountLoginReplayCommand(
      command,
      invocation.handoffFile ?? "/absolute/path/to/empty-protected-login.json",
      invocation.json,
    );
    let response: CommandResponse;
    try {
      response = await callDaemon(command);
    } catch (error: unknown) {
      if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
      return renderFailure({
        code: "RECOVERY_REQUIRED",
        details: {
          cancelCommand: accountLoginCancelCommand(selected.value.id),
          idempotencyKey: command.idempotencyKey,
          sameKeyReplayCommand: replayCommand,
        },
        message: "The account login response is uncertain. Reuse only the exact same-key command to inspect the durable result; cancel the pending login before starting a fresh one.",
        trustedLocalPaths: true,
      }, invocation.json, output);
    }
    if (!response.ok) return renderFailure(response.error, invocation.json, output);

    let result: ReturnType<typeof parseAccountLoginResponse>;
    try {
      result = parseAccountLoginResponse(response.data, {
        accountId: selected.value.id,
        deviceCode: command.deviceCode,
        idempotencyKey: command.idempotencyKey,
      });
      if (result.kind === "handoff") {
        if (protectedOutput !== undefined) {
          const handoffPath = protectedOutput.path;
          protectedOutput.write(result.document);
          if (!closeProtectedOutput()) throw new ProtectedOutputError("write_unproven");
          renderSuccess(command, accountLoginPublicData(result, {
            disposition: "preserved_caller_removes_after_login",
            documentVersion: 1,
            path: handoffPath,
            status: "written",
          }), invocation.json, output);
        } else {
          renderProtectedForegroundLogin(result.document, output);
          renderSuccess(command, accountLoginPublicData(result, {
            status: "shown_in_protected_terminal",
          }), false, output);
        }
        return 0;
      }
      if (!closeProtectedOutput()) throw new ProtectedOutputError("write_unproven");
      renderSuccess(command, accountLoginPublicData(
        result,
        result.kind === "pending_replay"
          ? { status: "unavailable_on_replay" }
          : undefined,
      ), invocation.json, output);
      return 0;
    } catch (error: unknown) {
      if (!(error instanceof ProtectedOutputError)) throw error;
      return renderFailure({
        code: "RECOVERY_REQUIRED",
        details: {
          cancelCommand: accountLoginCancelCommand(selected.value.id),
          idempotencyKey: command.idempotencyKey,
          sameKeyReplayCommand: replayCommand,
        },
        message: "The provider login effect may be pending, but Oompa could not prove the protected handoff. Cancel the pending login before starting a fresh login; a same-key replay cannot recover one-time instructions.",
        trustedLocalPaths: true,
      }, invocation.json, output);
    }
  } finally {
    closeProtectedOutput();
  }
}

const claudeLoginAccountSchema = z.object({
  id: profileIdSchema,
  label: z.string().min(1).max(160),
}).strict();
const claudeAuthenticationSchema = z.object({
  provider: z.literal("claude"),
  signedIn: z.boolean(),
}).strict();
const claudeStatusAuthenticationSchema = z.object({
  provider: z.literal("claude"),
  signedIn: z.boolean().nullable(),
}).strict();
const claudeLoginRecoverySchema = z.object({
  required: z.literal(true),
  attemptId: attemptIdSchema,
  idempotencyKey: z.string().uuid(),
  providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  statusCommand: z.string().min(1).max(512),
  sameKeyReplayCommand: z.string().min(1).max(512),
  abandonCommand: z.string().min(1).max(1_024),
  diagnostic: z.string().min(1).max(2_048),
}).strict();
const claudeAccountStatusResponseSchema = z.object({
  account: claudeLoginAccountSchema,
  authentication: claudeStatusAuthenticationSchema,
  providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextCommand: z.string().optional(),
  recovery: claudeLoginRecoverySchema.optional(),
}).strict().superRefine((value, context) => {
  if (
    value.nextCommand !== undefined
    && value.nextCommand !== claudeAccountLoginCommand(value.account.id)
  ) context.addIssue({ code: "custom", path: ["nextCommand"], message: "Claude login next command is not exact." });
  // Null can also be the strict status parser's unverified observation. It
  // never implies signed-out state or permits the foreground launch path.
  if (value.recovery === undefined) return;
  if (value.recovery.statusCommand !== `oompa account show ${value.account.id} --provider claude`) {
    context.addIssue({ code: "custom", path: ["recovery", "statusCommand"], message: "Claude recovery status command is not exact." });
  }
  if (value.recovery.sameKeyReplayCommand !== claudeAccountLoginCommand(value.account.id, value.recovery.idempotencyKey)) {
    context.addIssue({ code: "custom", path: ["recovery", "sameKeyReplayCommand"], message: "Claude recovery replay command is not exact." });
  }
  if (value.recovery.abandonCommand !== claudeAccountLoginAbandonCommand(
    value.account.id,
    value.recovery.attemptId,
    value.recovery.idempotencyKey,
    value.recovery.providerGeneration,
  )) {
    context.addIssue({ code: "custom", path: ["recovery", "abandonCommand"], message: "Claude recovery abandon command is not exact." });
  }
});
const claudeLoginPrepareResponseSchema = z.object({
  account: claudeLoginAccountSchema,
  authentication: claudeAuthenticationSchema,
  login: z.discriminatedUnion("status", [
    z.object({ status: z.literal("signed_in") }).strict(),
    z.object({
      status: z.literal("launch_granted"),
      attemptId: attemptIdSchema,
      idempotencyKey: z.string().uuid(),
      providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    }).strict(),
  ]),
}).strict().superRefine((value, context) => {
  const expectedSignedIn = value.login.status === "signed_in";
  if (value.authentication.signedIn !== expectedSignedIn) {
    context.addIssue({
      code: "custom",
      path: ["authentication", "signedIn"],
      message: "Claude authentication state does not match the login preparation status.",
    });
  }
});
const claudeLoginCompleteResponseSchema = z.object({
  account: claudeLoginAccountSchema,
  authentication: claudeAuthenticationSchema,
  login: z.object({
    status: z.enum(["signed_in", "signed_out"]),
    attemptId: attemptIdSchema,
    idempotencyKey: z.string().uuid(),
    providerGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }).strict(),
}).strict().superRefine((value, context) => {
  const expectedSignedIn = value.login.status === "signed_in";
  if (value.authentication.signedIn !== expectedSignedIn) {
    context.addIssue({
      code: "custom",
      path: ["authentication", "signedIn"],
      message: "Claude authentication state does not match the login completion status.",
    });
  }
});

const renderClaudeLoginResult = (
  data: z.infer<typeof claudeLoginPrepareResponseSchema> | z.infer<typeof claudeLoginCompleteResponseSchema>,
  json: boolean,
  output: Output,
): void => {
  if (json) {
    output.writeStdout(`${safeJson({ command: "account.login", data, ok: true, version: 1 })}\n`);
    return;
  }
  output.writeStdout(data.authentication.signedIn
    ? `Claude Code is signed in for ${terminalSafe(data.account.label)}.\n`
    : `Claude Code is signed out for ${terminalSafe(data.account.label)}.\nNext: ${claudeAccountLoginCommand(data.account.id)}\n`);
};

const claudeLoginRecovery = (
  input: Readonly<{
    accountId?: string;
    attemptId?: string;
    idempotencyKey: string;
    providerGeneration?: number;
    replayCommand: string;
  }>,
  json: boolean,
  output: Output,
): number => renderFailure({
  code: "RECOVERY_REQUIRED",
  details: {
    ...(input.accountId === undefined ? {} : {
      accountSelector: input.accountId,
      statusCommand: `oompa account show ${input.accountId} --provider claude`,
    }),
    ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
    idempotencyKey: input.idempotencyKey,
    ...(input.providerGeneration === undefined ? {} : { providerGeneration: input.providerGeneration }),
    sameKeyReplayCommand: input.replayCommand,
    ...(
      input.accountId === undefined
      || input.attemptId === undefined
      || input.providerGeneration === undefined
        ? {}
        : {
            abandonCommand: claudeAccountLoginAbandonCommand(
              input.accountId,
              input.attemptId,
              input.idempotencyKey,
              input.providerGeneration,
            ),
          }
    ),
  },
  message: "Claude login may have started, but Oompa could not prove its terminal result. The same-key command identifies this attempt and will never relaunch Claude. If its Oompa parent is gone, confirm the Claude child exited before using the exact acknowledged local abandon command; abandon does not stop Claude or change or delete credentials.",
}, json, output);

async function executeClaudeAccountAuthentication(
  invocation: Extract<CliInvocation, { kind: "account.claude-login" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const browserMode = resolveClaudeLoginBrowserMode(invocation.browserMode);
  const isTerminalDescriptor = input.isTerminalDescriptor ?? isatty;
  if (
    invocation.json
    || input.interactive !== true
    || !isTerminalDescriptor(0)
    || !isTerminalDescriptor(1)
    || !isTerminalDescriptor(2)
  ) {
    return renderFailure({
      code: "INTERACTION_REQUIRED",
      details: { nextCommand: invocation.replayCommand },
      message: "Claude Code owns this login interaction. Run it in a foreground terminal without --json so its prompts and browser handoff stay between you and Claude Code.",
    }, invocation.json, output);
  }

  const callDaemon = commandCaller(input);
  let statusResponse: CommandResponse;
  try {
    statusResponse = await callDaemon({
      kind: "account.show",
      account: invocation.command.account,
      provider: "claude",
    });
  } catch (error: unknown) {
    if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
    return renderFailure({
      code: "UNAVAILABLE",
      message: "Oompa could not preflight the exact Claude account. No login launch was granted.",
    }, invocation.json, output);
  }
  if (!statusResponse.ok) return renderFailure(statusResponse.error, invocation.json, output);
  const status = claudeAccountStatusResponseSchema.safeParse(statusResponse.data);
  if (!status.success) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned an invalid Claude account preflight. No login launch was granted.",
    }, invocation.json, output);
  }
  if (status.data.recovery !== undefined) {
    return renderFailure({
      code: "RECOVERY_REQUIRED",
      details: {
        ...status.data.recovery,
        sameKeyReplayCommand: claudeAccountLoginCommand(
          status.data.account.id, status.data.recovery.idempotencyKey, browserMode,
        ),
      },
      message: status.data.recovery.diagnostic,
    }, invocation.json, output);
  }
  if (status.data.authentication.signedIn === null) {
    return renderFailure({
      code: "UNAVAILABLE",
      message: "Claude authentication status could not be verified. "
        + `Ensure Claude Code ${CLAUDE_PIN} is on this daemon's PATH and its isolated configuration is readable, `
        + `then retry \`oompa account show ${status.data.account.id} --provider claude\`. No login launch was granted.`,
    }, invocation.json, output);
  }
  const controller = new AbortController();
  // Preflight unconditionally: the provider can sign out between this passive
  // status read and serialized prepare, and prepare is then allowed to grant.
  const installation = input.installation ?? createProductionInstallation();
  await initializeStatePaths(installation.paths);
  const owned = await initializeProfilePaths(installation.paths, status.data.account.id);
  const resolveClaudeRuntime = input.resolveClaudeRuntime ?? resolvePinnedClaudeRuntime;
  const runtime = await resolveClaudeRuntime({
    configDir: owned.claudeConfigDir,
    signal: controller.signal,
  });
  const preflight = { configDir: owned.claudeConfigDir, runtime };
  // Prepare is the daemon boundary that can atomically return the launch
  // grant. Observe terminal signals before awaiting it so a signal delivered
  // in that response window cannot kill the parent after the grant commits.
  const signalCustody = createClaudeLoginSignalCustody({
    signal: controller.signal,
    ...(input.claudeLoginSignalSource === undefined
      ? {}
      : { signalSource: input.claudeLoginSignalSource }),
  });
  try {
    let preparedResponse: CommandResponse;
    try {
      preparedResponse = await callDaemon(invocation.command);
    } catch (error: unknown) {
      if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
      return claudeLoginRecovery({
        idempotencyKey: invocation.command.idempotencyKey,
        replayCommand: invocation.replayCommand,
      }, invocation.json, output);
    }
    if (!preparedResponse.ok) return renderFailure(preparedResponse.error, invocation.json, output);
    const prepared = claudeLoginPrepareResponseSchema.safeParse(preparedResponse.data);
    if (
      !prepared.success
      || prepared.data.account.id !== status.data.account.id
      || (
        prepared.data.login.status === "launch_granted"
        && prepared.data.login.idempotencyKey !== invocation.command.idempotencyKey
      )
    ) {
      return claudeLoginRecovery({
        idempotencyKey: invocation.command.idempotencyKey,
        replayCommand: invocation.replayCommand,
      }, invocation.json, output);
    }
    if (prepared.data.login.status === "signed_in") {
      renderClaudeLoginResult(prepared.data, invocation.json, output);
      return signalCustody.interruptedBy === "SIGINT"
        ? 130
        : signalCustody.interruptedBy === "SIGTERM"
          ? 143
          : 0;
    }
    const grant = Object.freeze({
      ...prepared.data.login,
      accountId: prepared.data.account.id,
      browserMode,
    });
    const exactReplayCommand = claudeAccountLoginCommand(grant.accountId, grant.idempotencyKey, grant.browserMode);
    // Retain prepare-bound custody through path revalidation, spawn, child join,
    // and the exact daemon completion RPC.
    let foreground: ClaudeForegroundLoginResult | undefined = signalCustody.interruptedBy === null
      ? undefined
      : {
          state: "not_started",
          reason: "interrupted_before_spawn",
          interruptedBy: signalCustody.interruptedBy,
        };
    try {
      if (foreground === undefined) await ensurePrivateDirectory(preflight.configDir);
    } catch {
      // The path changed after the no-effect preflight but before spawn. Consume
      // the grant with a typed no-effect completion instead of wedging it.
      foreground = signalCustody.interruptedBy === null
        ? { state: "not_started", reason: "preflight_stale" }
        : {
            state: "not_started",
            reason: "interrupted_before_spawn",
            interruptedBy: signalCustody.interruptedBy,
          };
    }
    if (foreground === undefined) {
      try {
        const revalidated = await resolveClaudeRuntime({
          configDir: preflight.configDir,
          executablePath: preflight.runtime.executablePath,
          signal: controller.signal,
        });
        if (
          revalidated.executablePath !== preflight.runtime.executablePath
          || JSON.stringify(revalidated.argv) !== JSON.stringify(preflight.runtime.argv)
        ) throw new Error("Claude runtime identity changed after launch grant.");
        preflight.runtime = revalidated;
      } catch {
        foreground = signalCustody.interruptedBy === null
          ? { state: "not_started", reason: "preflight_stale" }
          : {
              state: "not_started",
              reason: "interrupted_before_spawn",
              interruptedBy: signalCustody.interruptedBy,
            };
      }
    }
    if (foreground === undefined && signalCustody.interruptedBy !== null) {
      foreground = {
        state: "not_started",
        reason: "interrupted_before_spawn",
        interruptedBy: signalCustody.interruptedBy,
      };
    }
    if (foreground === undefined) {
      try {
        if (grant.browserMode === "owner_manual") {
          output.writeStderr(`Claude login for Oompa profile ${terminalSafe(prepared.data.account.label)}.\n`
            + "Close all prior private/incognito windows, then open one fresh private window; keep normal browser sessions unchanged.\n"
            + "Copy Claude's printed link unchanged into that window. Check the intended account before approving sign-in.\n");
        }
        foreground = await (input.runClaudeForegroundLogin ?? runClaudeForegroundLogin)({
          browserMode: grant.browserMode,
          configDir: preflight.configDir,
          runtime: preflight.runtime,
          signal: controller.signal,
          signalCustody,
          stdio: { stderr: 2, stdin: 0, stdout: 1 },
        });
      } catch {
        return claudeLoginRecovery({
          accountId: grant.accountId,
          attemptId: grant.attemptId,
          idempotencyKey: grant.idempotencyKey,
          providerGeneration: grant.providerGeneration,
          replayCommand: exactReplayCommand,
        }, invocation.json, output);
      }
    }
    const complete = localCommandSchema.parse({
      kind: "account.claude-login.complete",
      account: grant.accountId,
      attemptId: grant.attemptId,
      idempotencyKey: grant.idempotencyKey,
      providerGeneration: grant.providerGeneration,
      outcome: foreground,
    });
    let completedResponse: CommandResponse;
    try {
      completedResponse = await callDaemon(complete);
    } catch (error: unknown) {
      if (!(error instanceof LocalDaemonIndeterminateError)) throw error;
      return claudeLoginRecovery({
        accountId: grant.accountId,
        attemptId: grant.attemptId,
        idempotencyKey: grant.idempotencyKey,
        providerGeneration: grant.providerGeneration,
        replayCommand: exactReplayCommand,
      }, invocation.json, output);
    }
    if (!completedResponse.ok) {
      return claudeLoginRecovery({
        accountId: grant.accountId,
        attemptId: grant.attemptId,
        idempotencyKey: grant.idempotencyKey,
        providerGeneration: grant.providerGeneration,
        replayCommand: exactReplayCommand,
      }, invocation.json, output);
    }
    const completed = claudeLoginCompleteResponseSchema.safeParse(completedResponse.data);
    if (
      !completed.success
      || completed.data.account.id !== grant.accountId
      || completed.data.login.attemptId !== grant.attemptId
      || completed.data.login.idempotencyKey !== grant.idempotencyKey
      || completed.data.login.providerGeneration !== grant.providerGeneration
    ) {
      return claudeLoginRecovery({
        accountId: grant.accountId,
        attemptId: grant.attemptId,
        idempotencyKey: grant.idempotencyKey,
        providerGeneration: grant.providerGeneration,
        replayCommand: exactReplayCommand,
      }, invocation.json, output);
    }
    const interruptedBy = (foreground.state === "joined"
      ? foreground.interruptedBy
      : foreground.reason === "interrupted_before_spawn"
        ? foreground.interruptedBy
        : null) ?? signalCustody.interruptedBy;
    if (interruptedBy !== null) {
      output.writeStderr(completed.data.authentication.signedIn
        ? "oompa: Claude login was interrupted after authentication completed.\n"
        : "oompa: Claude login was canceled; the isolated profile remains signed out.\n");
      return interruptedBy === "SIGINT" ? 130 : 143;
    }
    if (!completed.data.authentication.signedIn) {
      return renderFailure({
        code: "INTERACTION_REQUIRED",
        details: {
          accountSelector: completed.data.account.id,
          accountState: "signed_out",
          nextCommand: claudeAccountLoginCommand(completed.data.account.id, undefined, grant.browserMode),
          provider: "claude",
        },
        message: "Claude Code finished without an authenticated session in this account's isolated profile.",
      }, invocation.json, output);
    }
    renderClaudeLoginResult(completed.data, invocation.json, output);
    return 0;
  } finally {
    signalCustody.close();
  }
}

async function executeSessionEventObserver(
  invocation: Extract<CliInvocation, {
    kind: "session.events.follow" | "session.events.watch";
  }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Session event observation stopped."));
  const human = invocation.kind === "session.events.watch" && !invocation.jsonl;
  let humanBootstrapComplete = !human;
  let humanBootstrapBytes = 0;
  const humanChunks: string[] = [];
  const presenter = human
    ? new ShellLivePresenter((value) => {
        if (!humanBootstrapComplete) {
          const nextBytes = humanSessionWatchUtf8Encoder.encode(value).byteLength;
          if (
            humanBootstrapBytes + nextBytes
              > HUMAN_SESSION_WATCH_BOOTSTRAP_MAXIMUM_BYTES
          ) {
            throw new CommandFailure(
              "UNAVAILABLE",
              "Pending interaction guidance exceeds the bounded human watch bootstrap. Inspect pending interactions in bounded pages, then restart watch.",
            );
          }
          humanBootstrapBytes += nextBytes;
        }
        humanChunks.push(value);
      }, 35, "cli")
    : null;
  const bootstrappedInteractions: Array<Readonly<{
    id: string;
    revision: number;
    state: PendingInteraction["state"];
  }>> = [];
  const callDaemon = commandCaller(input);
  const drainHumanChunks = async (signal: AbortSignal): Promise<void> => {
    if (humanChunks.length === 0) return;
    const value = humanChunks.splice(0).join("");
    if (output.writeStdoutAsync !== undefined) {
      await output.writeStdoutAsync(value, signal);
      return;
    }
    output.writeStdout(value);
  };
  const finalize = async (): Promise<void> => {
    presenter?.close();
    process.off("SIGINT", abort);
    if (input.sessionObserverSignalMode !== "foreground_interrupt") {
      process.off("SIGTERM", abort);
    }
    if (!humanBootstrapComplete) humanChunks.length = 0;
    if (humanChunks.length === 0) return;
    const finalOutputController = new AbortController();
    const finalOutputDeadline = setTimeout(
      () => finalOutputController.abort(new Error("Final human watch output exceeded its deadline.")),
      1_000,
    );
    finalOutputDeadline.unref();
    try {
      await drainHumanChunks(finalOutputController.signal);
    } catch (error: unknown) {
      if (!isClosedStdout(error) && !finalOutputController.signal.aborted) throw error;
    } finally {
      clearTimeout(finalOutputDeadline);
    }
  };
  process.once("SIGINT", abort);
  if (input.sessionObserverSignalMode !== "foreground_interrupt") {
    process.once("SIGTERM", abort);
  }
  try {
    let command = invocation.command;
    if (presenter !== null) {
      const exactRequestedSession = sessionIdSchema.safeParse(invocation.command.session);
      const { sessionId } = await enumerateUnsettledSessionInteractions({
        callDaemon,
        ...(exactRequestedSession.success
          ? { expectedSessionId: exactRequestedSession.data }
          : {}),
        onInteractions: (interactions) => {
          bootstrappedInteractions.push(...interactions.map((interaction) => ({
            id: interaction.id,
            revision: interaction.revision,
            state: interaction.state,
          })));
          presenter.showInitialInteractions(interactions);
        },
        session: invocation.command.session,
        signal: controller.signal,
      });
      humanBootstrapComplete = true;
      presenter.flush();
      await drainHumanChunks(controller.signal);
      input.onHumanSessionObserverBootstrap?.({
        interactions: bootstrappedInteractions,
        sessionId,
      });
      command = { ...command, session: sessionId };
    }
    await followSessionEvents({
      command,
      ...(human
        ? { expectedSessionId: command.session }
        : sessionIdSchema.safeParse(command.session).success
          ? { expectedSessionId: command.session }
          : {}),
      fetchPage: async (command, signal) => {
        const response = await callDaemon(command, signal);
        if (!response.ok) throw Object.assign(new Error(response.error.message), {
          commandError: response.error,
        });
        return response.data;
      },
      output,
      retryFetchError: async (error, consecutiveFailures, signal) => {
        const commandError = error !== null && typeof error === "object" && "commandError" in error
          ? (error as { commandError?: unknown }).commandError
          : undefined;
        const retryableCommand = commandError !== null
          && typeof commandError === "object"
          && "code" in commandError
          && commandError.code === "UNAVAILABLE";
        if (
          !(error instanceof LocalDaemonIndeterminateError)
          && !isLocalDaemonUnavailable(error)
          && !retryableCommand
        ) return false;
        const delayMs = Math.min(1_000, 25 * (2 ** Math.min(consecutiveFailures - 1, 5)));
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        return !signal.aborted;
      },
      signal: controller.signal,
      ...(presenter === null
        ? {}
        : {
            writePage: async (page, _pageOutput, signal) => {
              presenter.acceptPage(page);
              presenter.flush();
              await drainHumanChunks(signal);
            },
          }),
    });
    return 0;
  } catch (error: unknown) {
    if (controller.signal.aborted) return 0;
    if (isClosedStdout(error)) return 0;
    if (error instanceof CommandFailure) {
      const failure = {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      };
      return human
        ? renderFailure(failure, false, output)
        : renderJsonlFailure(failure, output);
    }
    const commandError = error !== null && typeof error === "object" && "commandError" in error
      ? (error as { commandError?: unknown }).commandError
      : undefined;
    if (
      commandError !== null
      && typeof commandError === "object"
      && "code" in commandError
      && typeof commandError.code === "string"
      && "message" in commandError
      && typeof commandError.message === "string"
    ) {
      return human
        ? renderFailure(commandError as { code: string; message: string; details?: unknown }, false, output)
        : renderJsonlFailure(commandError as { code: string; message: string; details?: unknown }, output);
    }
    const failure = {
      code: "INTERNAL",
      message: error instanceof Error ? error.message : "Session event observation failed.",
    };
    return human
      ? renderFailure(failure, false, output)
      : renderJsonlFailure(failure, output);
  } finally {
    await finalize();
  }
}

async function executeWorkEventObserver(
  invocation: Extract<CliInvocation, { kind: "work.events.follow" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Work event observation stopped."));
  const callDaemon = commandCaller(input);
  process.once("SIGINT", abort);
  if (input.sessionObserverSignalMode !== "foreground_interrupt") {
    process.once("SIGTERM", abort);
  }
  try {
    await followWorkEvents({
      command: invocation.command,
      fetchPage: async (command, signal) => {
        const response = await callDaemon(command, signal);
        if (!response.ok) {
          throw Object.assign(new Error(response.error.message), {
            commandError: response.error,
          });
        }
        return response.data;
      },
      output,
      retryFetchError: async (error, consecutiveFailures, signal) => {
        const commandError = error !== null && typeof error === "object" && "commandError" in error
          ? (error as { commandError?: unknown }).commandError
          : undefined;
        const retryableCommand = commandError !== null
          && typeof commandError === "object"
          && "code" in commandError
          && commandError.code === "UNAVAILABLE";
        if (
          !(error instanceof LocalDaemonIndeterminateError)
          && !isLocalDaemonUnavailable(error)
          && !retryableCommand
        ) return false;
        const delayMs = Math.min(1_000, 25 * (2 ** Math.min(consecutiveFailures - 1, 5)));
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          const onAbort = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, delayMs);
          signal.addEventListener("abort", onAbort, { once: true });
        });
        return !signal.aborted;
      },
      signal: controller.signal,
    });
    return 0;
  } catch (error: unknown) {
    if (controller.signal.aborted || isClosedStdout(error)) return 0;
    const commandError = error !== null && typeof error === "object" && "commandError" in error
      ? (error as { commandError?: unknown }).commandError
      : undefined;
    if (
      commandError !== null
      && typeof commandError === "object"
      && "code" in commandError
      && typeof commandError.code === "string"
      && "message" in commandError
      && typeof commandError.message === "string"
    ) {
      return renderJsonlFailure(
        commandError as { code: string; message: string; details?: unknown },
        output,
      );
    }
    return renderJsonlFailure({
      code: "INTERNAL",
      message: "Work event observation failed before a safe page was available.",
    }, output);
  } finally {
    process.off("SIGINT", abort);
    if (input.sessionObserverSignalMode !== "foreground_interrupt") {
      process.off("SIGTERM", abort);
    }
  }
}

async function executeRootStatus(
  invocation: Extract<CliInvocation, { kind: "status" }>,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  const data = input.readRootStatus === undefined
    ? await (async (): Promise<unknown> => {
        await requireInitializedDaemonState(installation.paths, "local_status");
        const store = new StateStore(installation.paths, { readonly: true });
        try {
          return store.readRootStatusSnapshot();
        } finally {
          store.close();
        }
      })()
    : input.readRootStatus(installation.paths);
  renderRootStatus(data, invocation.json, output);
  return 0;
}

const selectedId = (
  data: unknown,
  field: "account" | "session",
): string | null => {
  if (data === null || typeof data !== "object") return null;
  const value = (data as Record<string, unknown>)[field];
  if (value === null || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  const parsed = (field === "account" ? profileIdSchema : sessionIdSchema).safeParse(id);
  return parsed.success ? parsed.data : null;
};

const selectedShellSessionIdentity = (
  data: unknown,
):
  | Readonly<{ account: string; kind: "valid"; session: string }>
  | Readonly<{ kind: "invalid_account" | "invalid_session" }> => {
  const current = sessionStatusSchema.safeParse(data);
  if (current.success) {
    return {
      account: current.data.session.accountId,
      kind: "valid",
      session: current.data.session.id,
    };
  }
  const legacy = isRecord(data) && data.version === 1 ? data : null;
  if (legacy === null) return { kind: "invalid_session" };
  const session = selectedId(legacy, "session");
  if (session === null) return { kind: "invalid_session" };
  const legacySession = legacy.session;
  const account = profileIdSchema.safeParse(
    isRecord(legacySession) ? legacySession.profileId : undefined,
  );
  return account.success
    ? { account: account.data, kind: "valid", session }
    : { kind: "invalid_account" };
};

type ForegroundSessionBootstrap = Parameters<
  NonNullable<CliMainInput["onHumanSessionObserverBootstrap"]>
>[0];

const matchesSelectedSession = (
  observed: ForegroundSessionBootstrap | null,
  selected: string | undefined,
): observed is ForegroundSessionBootstrap =>
  observed !== null && observed.sessionId === selected;

export async function runPersistentShell(
  output: Output = processOutput,
  input: CliMainInput = {},
): Promise<number> {
  const terminal = input.readShellLine === undefined
    ? new ShellTerminalCoordinator({
        flushInput: () => flushProtectedTerminalInput(0),
        input: process.stdin,
        lifecycleHooks: {
          onSignal: (signal, listener) => {
            process.once(signal, listener);
            return () => process.off(signal, listener);
          },
          resignal: (signal) => process.kill(process.pid, signal),
        },
        output: process.stderr,
        terminal: true,
      })
    : null;
  const readLine = input.readShellLine ?? (async (prompt: string) =>
    terminal === null ? null : await terminal.question(prompt));
  const commandInput: CliMainInput = terminal === null || input.readProtectedDocument !== undefined
    ? input
    : {
        ...input,
        readProtectedDocument: async (source) => {
          if (source.kind === "stdin") {
            const discarded = await terminal.establishProtectedInputBoundary();
            if (discarded > 0) {
              throw new CliUsageError(
                "Protected input cannot consume pretyped shell lines. Oompa discarded the buffered lines; retry and enter the protected document only after its hidden prompt appears.",
              );
            }
          }
          return await terminal.withSignalHandlingSuspended(
            async () => await withProtectedTerminalLifecycle(
              async (signal) => await readProtectedDocument(source, output, signal),
              terminal.lifecycleSignal,
            ),
          );
        },
      };
  let foregroundBootstrap: ForegroundSessionBootstrap | null = null;
  const shellCommandInput: CliMainInput = {
    ...commandInput,
    ...(terminal === null ? {} : { sessionObserverSignalMode: "foreground_interrupt" as const }),
    onHumanSessionObserverBootstrap: (bootstrap) => {
      foregroundBootstrap = bootstrap;
      commandInput.onHumanSessionObserverBootstrap?.(bootstrap);
    },
  };
  const callDaemon = commandCaller(input);
  let live: ShellLiveObserver | null = null;
  let liveOutputEnabled = true;
  try {
    const status = await callDaemon({ kind: "daemon.status" });
    if (!status.ok) return renderFailure(status.error, false, output);
    daemonStatusIdentity(status);
    live = new ShellLiveObserver({
      callDaemon,
      write: (value) => {
        if (!liveOutputEnabled) return;
        if (terminal === null) output.writeStderr(value);
        else terminal.writeLive(value);
      },
    });
    let selection: ShellSelection = {};
    const stopSelectedSessionLive = async (): Promise<void> => {
      liveOutputEnabled = false;
      await live?.stop();
      terminal?.discardHeldLiveOutput();
    };
    const restartSelectedSessionLive = async (
      bootstrap: ForegroundSessionBootstrap | null,
    ): Promise<void> => {
      if (selection.session === undefined || selection.account === undefined) return;
      try {
        const response = await callDaemon({
          kind: "session.status",
          session: selection.session,
        });
        if (!response.ok) {
          output.writeStderr(
            "oompa: Live updates remain paused because Oompa could not refresh the exact selected session. Reselect it to resume.\n",
          );
          return;
        }
        const identity = selectedShellSessionIdentity(response.data);
        if (
          identity.kind !== "valid"
          || identity.session !== selection.session
          || identity.account !== selection.account
        ) {
          output.writeStderr(
            "oompa: Live updates remain paused because Oompa could not refresh the exact selected session. Reselect it to resume.\n",
          );
          return;
        }
        liveOutputEnabled = true;
        await live?.select({
          session: identity.session,
          statusData: response.data,
          ...(bootstrap === null
            ? {}
            : {
                suppressedInitialInteractionKeys: new Set(
                  bootstrap.interactions.map(pendingInteractionStateKey),
                ),
              }),
        });
      } catch {
        liveOutputEnabled = false;
        output.writeStderr(
          "oompa: Live updates remain paused because Oompa could not refresh the exact selected session. Reselect it to resume.\n",
        );
      }
    };
    output.writeStderr("Oompa shell. /help lists commands; /exit leaves the daemon running.\n");
    for (;;) {
      let line: string | null;
      try {
        line = await readLine(formatShellPrompt(selection));
      } catch {
        output.writeStderr("oompa: Shell input is unavailable.\n");
        return 1;
      }
      if (line === null) return 0;
      try {
        const intent = compileShellLine(line, selection);
        if (intent.kind === "noop") continue;
        if (intent.kind === "exit") return 0;
        if (intent.kind === "help") {
          output.writeStdout(`${shellHelp}\n`);
          continue;
        }
        if (intent.kind === "select-account") {
          const response = await callDaemon({ kind: "account.show", account: intent.selector });
          if (!response.ok) {
            renderFailure(response.error, false, output);
            continue;
          }
          const account = selectedId(response.data, "account");
          if (account === null) throw new Error("Selected account response is invalid.");
          const exactAccount = profileIdSchema.safeParse(intent.selector);
          if (exactAccount.success && account !== exactAccount.data) {
            throw new Error("Selected account response does not match the exact requested account.");
          }
          await stopSelectedSessionLive();
          selection = { account };
          output.writeStderr(`Selected account ${terminalSafe(account)}.\n`);
          continue;
        }
        if (intent.kind === "select-session") {
          const response = await callDaemon({ kind: "session.status", session: intent.selector });
          if (!response.ok) {
            renderFailure(response.error, false, output);
            continue;
          }
          const identity = selectedShellSessionIdentity(response.data);
          if (identity.kind !== "valid") {
            throw new Error(identity.kind === "invalid_account"
              ? "Selected session account response is invalid."
              : "Selected session response is invalid.");
          }
          const { account, session } = identity;
          const exactSession = sessionIdSchema.safeParse(intent.selector);
          if (exactSession.success && session !== exactSession.data) {
            throw new Error("Selected session response does not match the exact requested session.");
          }
          await stopSelectedSessionLive();
          selection = { account, session };
          output.writeStderr(`Selected session ${terminalSafe(session)}.\n`);
          liveOutputEnabled = true;
          await live.select({ session, statusData: response.data });
          continue;
        }
        const execute = async (): Promise<number> => await main(intent.argv, output, shellCommandInput);
        let parsedForeground: CliInvocation | null = null;
        try {
          parsedForeground = parseCli(intent.argv);
        } catch {
          // main owns diagnostics for malformed shell commands.
        }
        const foregroundObserver = parsedForeground?.kind === "session.events.follow"
          || parsedForeground?.kind === "session.events.watch";
        const foregroundEventRead = foregroundObserver
          || (
            parsedForeground?.kind === "command"
            && parsedForeground.command.kind === "session.events"
          );
        const ownsForegroundSignal = foregroundObserver
          || (
            parsedForeground?.kind === "command"
            && parsedForeground.command.kind === "session.events"
            && parsedForeground.command.waitMs > 0
        );
        const runForeground = async (): Promise<void> => {
          if (foregroundEventRead) await stopSelectedSessionLive();
          foregroundBootstrap = null;
          try {
            if (terminal !== null && ownsForegroundSignal) {
              await terminal.withInterruptHandlingSuspended(execute);
            } else {
              await execute();
            }
          } finally {
            if (foregroundEventRead) {
              await restartSelectedSessionLive(
                matchesSelectedSession(foregroundBootstrap, selection.session)
                  ? foregroundBootstrap
                  : null,
              );
            }
          }
        };
        if (terminal === null) await runForeground();
        else await terminal.withLiveOutputHeld(runForeground);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "Shell command failed.";
        output.writeStderr(`oompa: ${safeDiagnostic(message)}\n`);
      }
    }
  } catch (error: unknown) {
    if (error instanceof CommandFailure) {
      return renderFailure({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }, false, output);
    }
    bestEffortStderr(output, "oompa: Oompa could not start or continue the shell safely.\n");
    return 1;
  } finally {
    liveOutputEnabled = false;
    await live?.stop().catch(() => undefined);
    terminal?.close();
  }
}

const usageRefreshAllAccountLimit = 32;
const usageRefreshAllConcurrency = 4;

type UsageRefreshAccount = Readonly<{
  id: string;
  state: "signed_out" | "login_pending" | "signed_in" | "recovery_required" | "removed";
}>;

type UsageRefreshOutcome = Readonly<{
  accountId: string;
  state: "refreshed";
}> | Readonly<{
  accountId: string;
  accountState: UsageRefreshAccount["state"];
  reason: "not_signed_in";
  state: "skipped";
}> | Readonly<{
  accountId: string;
  code: "INVALID_INPUT" | "NOT_FOUND" | "AMBIGUOUS" | "CONFLICT" | "INTERACTION_REQUIRED" | "UNAVAILABLE" | "RECOVERY_REQUIRED" | "INTERNAL" | "INVALID_RESPONSE" | "TRANSPORT_FAILURE";
  state: "failed";
}>;

const orderedByAccountId = <T extends { accountId: string }>(left: T, right: T): number =>
  left.accountId < right.accountId ? -1 : left.accountId > right.accountId ? 1 : 0;

const refreshAllAccounts = (data: unknown): readonly UsageRefreshAccount[] | null => {
  if (!isRecord(data) || !Array.isArray(data.accounts)) return null;
  const accounts: UsageRefreshAccount[] = [];
  for (const value of data.accounts) {
    if (!isRecord(value)) return null;
    const id = profileIdSchema.safeParse(value.id);
    if (!id.success || !["signed_out", "login_pending", "signed_in", "recovery_required", "removed"].includes(String(value.state))) {
      return null;
    }
    accounts.push({ id: id.data, state: value.state as UsageRefreshAccount["state"] });
  }
  accounts.sort((left, right) => orderedByAccountId(
    { accountId: left.id },
    { accountId: right.id },
  ));
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) return null;
  return accounts;
};

const usageResponseContains = (data: unknown, accountId: string): boolean =>
  isRecord(data)
  && Array.isArray(data.usage)
  && data.usage.some((value) =>
    isRecord(value) && isRecord(value.account) && value.account.id === accountId);

const deterministicUsageData = (
  data: unknown,
  outcomes: readonly UsageRefreshOutcome[],
): Readonly<Record<string, unknown>> | null => {
  if (!isRecord(data) || !Array.isArray(data.usage)) return null;
  const rawUsage: readonly unknown[] = data.usage;
  const usage = [...rawUsage].sort((left, right) => {
    const leftId = isRecord(left) && isRecord(left.account) && typeof left.account.id === "string"
      ? left.account.id
      : "";
    const rightId = isRecord(right) && isRecord(right.account) && typeof right.account.id === "string"
      ? right.account.id
      : "";
    return orderedByAccountId({ accountId: leftId }, { accountId: rightId });
  });
  return {
    usage,
    refresh: {
      accountLimit: usageRefreshAllAccountLimit,
      concurrency: usageRefreshAllConcurrency,
      outcomes: [...outcomes].sort(orderedByAccountId),
    },
  };
};

const renderUsageRefreshAllPostEffectFailure = (
  outcomes: readonly UsageRefreshOutcome[],
  reasonCode: Extract<UsageRefreshOutcome, { state: "failed" }>["code"],
  json: boolean,
  output: Output,
): number => renderFailure({
  code: "UNAVAILABLE",
  details: {
    refresh: {
      accountLimit: usageRefreshAllAccountLimit,
      concurrency: usageRefreshAllConcurrency,
      outcomes: [...outcomes].sort(orderedByAccountId),
    },
    usageView: { reasonCode, state: "unavailable" },
  },
  message: "Refresh outcomes were recorded, but the final usage view is unavailable.",
}, json, output);

async function executeUsageRefreshAll(
  command: Extract<LocalCommand, { kind: "account.usage" }>,
  json: boolean,
  output: Output,
  input: CliMainInput,
): Promise<number> {
  const callDaemon = commandCaller(input);
  const listed = await callDaemon({ kind: "account.list" });
  if (!listed.ok) return renderFailure(listed.error, json, output);
  const accounts = refreshAllAccounts(listed.data);
  if (accounts === null) {
    return renderFailure({
      code: "INTERNAL",
      message: "The daemon returned an invalid account list.",
    }, json, output);
  }
  if (accounts.length > usageRefreshAllAccountLimit) {
    return renderFailure({
      code: "UNAVAILABLE",
      details: {
        accountCount: accounts.length,
        accountLimit: usageRefreshAllAccountLimit,
        nextCommand: "oompa account usage <account> --refresh",
      },
      message: "Refresh-all exceeds the bounded account limit. Refresh one explicit account instead.",
    }, json, output);
  }

  const outcomes: UsageRefreshOutcome[] = accounts.map((account) => account.state === "signed_in"
    ? { accountId: account.id, code: "TRANSPORT_FAILURE", state: "failed" }
    : {
        accountId: account.id,
        accountState: account.state,
        reason: "not_signed_in",
        state: "skipped",
      });
  const signedIn = accounts
    .map((account, index) => ({ account, index }))
    .filter((entry) => entry.account.state === "signed_in");
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const workIndex = next;
      next += 1;
      const entry = signedIn[workIndex];
      if (entry === undefined) return;
      try {
        const response = await callDaemon({
          kind: "account.usage",
          account: entry.account.id,
          refresh: true,
        });
        outcomes[entry.index] = response.ok
          ? usageResponseContains(response.data, entry.account.id)
            ? { accountId: entry.account.id, state: "refreshed" }
            : { accountId: entry.account.id, code: "INVALID_RESPONSE", state: "failed" }
          : { accountId: entry.account.id, code: response.error.code, state: "failed" };
      } catch {
        outcomes[entry.index] = {
          accountId: entry.account.id,
          code: "TRANSPORT_FAILURE",
          state: "failed",
        };
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(usageRefreshAllConcurrency, signedIn.length) },
    worker,
  ));

  let history: CommandResponse;
  try {
    history = await callDaemon({ kind: "account.usage", refresh: false });
  } catch {
    return renderUsageRefreshAllPostEffectFailure(
      outcomes,
      "TRANSPORT_FAILURE",
      json,
      output,
    );
  }
  if (!history.ok) {
    return renderUsageRefreshAllPostEffectFailure(
      outcomes,
      history.error.code,
      json,
      output,
    );
  }
  const data = deterministicUsageData(history.data, outcomes);
  if (data === null) {
    return renderUsageRefreshAllPostEffectFailure(
      outcomes,
      "INVALID_RESPONSE",
      json,
      output,
    );
  }
  renderSuccess(command, data, json, output);
  return 0;
}

function renderHelp(invocation: Extract<CliInvocation, { kind: "help" }>, output: Output): number {
  const resolved = resolveUsage(invocation.group, invocation.leaf);
  output.writeStdout(invocation.json
    ? `${safeJson({ ok: true, version: 1, command: "help", data: resolved })}\n`
    : `${resolved.usage}\n`);
  return 0;
}

function renderVersion(invocation: Extract<CliInvocation, { kind: "version" }>, output: Output): number {
  output.writeStdout(invocation.json
    ? `${safeJson({ ok: true, version: 1, command: "version", data: { version: OOMPA_VERSION } })}\n`
    : `oompa ${OOMPA_VERSION}\n`);
  return 0;
}

// One verdict decides both the doctor exit code and its JSON envelope. Any result that is
// not an exact healthy shape exits 1 and reports `UNHEALTHY`, so `ok` never disagrees with
// the exit code. The validated data stays beside the error for callers that read problems.
function doctorVerdict(data: unknown): Readonly<{ healthy: boolean; message: string }> {
  const doctor = isRecord(data) ? data : null;
  const problems = Array.isArray(doctor?.problems)
    && doctor.problems.every((value) => typeof value === "string")
    ? (doctor.problems as readonly string[])
    : null;
  if (doctor === null || typeof doctor.healthy !== "boolean" || problems === null) {
    return { healthy: false, message: "Oompa checks returned an invalid local result." };
  }
  if (doctor.healthy && problems.length === 0) return { healthy: true, message: "Oompa checks passed." };
  const count = problems.length;
  return {
    healthy: false,
    message: count === 0
      ? "Oompa checks did not pass, but no safe diagnostic was available."
      : `Oompa checks found ${String(count)} problem${count === 1 ? "" : "s"}.`,
  };
}

function unhealthyDoctorEnvelope(
  data: unknown,
  message: string,
  command?: "doctor",
): Readonly<Record<string, unknown>> {
  return {
    ok: false,
    version: 1,
    ...(command === undefined ? {} : { command }),
    data,
    error: { code: "UNHEALTHY", message },
  };
}

function renderDoctorOutcome(
  command: Extract<LocalCommand, { kind: "doctor" }>,
  data: unknown,
  json: boolean,
  output: Output,
): number {
  const verdict = doctorVerdict(data);
  if (verdict.healthy || !json) {
    renderSuccess(command, data, json, output);
    return verdict.healthy ? 0 : 1;
  }
  output.writeStdout(`${safeJson(unhealthyDoctorEnvelope(data, verdict.message, "doctor"))}\n`);
  return 1;
}

async function executeInvocation(
  invocation: CliInvocation,
  output: Output,
  input: CliMainInput = {},
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  assertInstallationHome(installation);
  if (invocation.kind === "help") return renderHelp(invocation, output);
  if (invocation.kind === "version") return renderVersion(invocation, output);
  if (invocation.kind === "command" && invocation.command.kind === "work.protocol") {
    // The protocol document is a pure function of the query, so it is served without
    // initialized state or a daemon. The daemon keeps the same operation for parity.
    renderSuccess(invocation.command, describeWorkProtocol(invocation.command.query), true, output);
    return 0;
  }
  const callDaemon = commandCaller({ ...input, installation });
  if (invocation.kind === "status") {
    return await executeRootStatus(invocation, output, { ...input, installation });
  }
  if (invocation.kind === "init") {
    return await initialize(invocation.yes, invocation.json, output, {
      documentsDirectory: installation.documentsDirectory,
      paths: installation.paths,
    });
  }
  if (invocation.kind === "daemon.run") return await runDaemon(installation);
  if (invocation.kind === "session.attach") {
    // The CLI, and only the CLI, turns a path into bytes. It admits each file
    // and writes it into local content-addressed custody, then reissues the
    // same command carrying digests. Nothing downstream ever sees a path.
    const blobs = input.attachmentBlobStore
      ?? AttachmentBlobStore.forStatePaths(installation.paths);
    let attachments: readonly AttachmentReference[];
    try {
      attachments = await ingestAttachments(
        blobs,
        invocation.attach,
        input.attachmentCwd ?? process.cwd(),
        { allowLegacyReplayName: invocation.legacyAttachmentReplay },
      );
    } catch (error: unknown) {
      if (error instanceof AttachmentIngestError) {
        return renderFailure(
          { code: "INVALID_INPUT", message: error.message },
          invocation.json,
          output,
        );
      }
      throw error;
    }
    return await executeInvocation(
      {
        command: { ...invocation.command, attachments: [...attachments] },
        json: invocation.json,
        kind: "command",
      },
      output,
      { ...input, installation },
    );
  }
  if (invocation.kind === "remote") {
    return await executeRemoteInvocation(invocation, output, { ...input, installation });
  }
  if (invocation.kind === "account.login-handoff") {
    return await executeAccountLogin(invocation, output, input);
  }
  if (invocation.kind === "account.claude-login") {
    return await executeClaudeAccountAuthentication(invocation, output, { ...input, installation });
  }
  if (invocation.kind === "auth.login-protected") {
    return await executeProtectedAuthLogin(invocation, output, input);
  }
  if (invocation.kind === "autorespond.gateway-set") {
    return await executeGatewayKeySet(invocation, output, input);
  }
  if (invocation.kind === "work.apply-input") {
    return await executeWorkApply(invocation, output, input);
  }
  if (invocation.kind === "interaction.resolve-protected") {
    return await executeProtectedInteraction(invocation, output, input);
  }
  if (invocation.kind === "interaction.inspect-protected") {
    return await executeProtectedInteractionInspect(invocation, output, input);
  }
  if (invocation.kind === "session.events.follow" || invocation.kind === "session.events.watch") {
    return await executeSessionEventObserver(invocation, output, input);
  }
  if (invocation.kind === "session.export") {
    return await exportSessionTranscript(invocation, output, callDaemon);
  }
  if (invocation.kind === "work.events.follow") {
    return await executeWorkEventObserver(invocation, output, input);
  }
  if (invocation.kind === "interaction-required") {
    return renderFailure(invocation.error, invocation.json, output);
  }
  if (invocation.kind === "sync.projection-recover") {
    const response = await callDaemon(invocation.command);
    if (!response.ok) {
      return renderProjectionRecoveryFailure(response.error, invocation, output);
    }
    return renderProjectionRecoverySuccess(response.data, invocation, output);
  }
  if (invocation.kind === "daemon.start") {
    try {
      const existing = await callLocalDaemon({ paths: installation.paths, command: { kind: "daemon.status" }, deadlineMs: 500 });
      if (existing.ok) {
        daemonStatusIdentity(existing);
        renderSuccess({ kind: "daemon.status" }, existing.data, invocation.json, output);
        return 0;
      }
    } catch (error: unknown) {
      if (!isLocalDaemonUnavailable(error)) throw error;
    }
    const cloud = requireCloudDeploymentEnvironment(installation.cloudEnvironment);
    await requireInitializedDaemonState(installation.paths);
    const ready = await (input.startDaemon ?? startDaemonProcess)({ ...installation, cloudEnvironment: cloud.environment });
    renderSuccess({ kind: "daemon.status" }, ready, invocation.json, output);
    return 0;
  }
  if (invocation.command.kind === "doctor" && invocation.command.offline) {
    return await offlineDoctor(
      invocation.json,
      output,
      input.statePaths ?? installation.paths,
      input.offlineDoctorOwnerUid,
    );
  }
  if (
    invocation.command.kind === "account.usage"
    && invocation.command.refresh
    && invocation.command.account === undefined
  ) {
    return await executeUsageRefreshAll(invocation.command, invocation.json, output, input);
  }
  if (invocation.command.kind === "session.note.edit") {
    return await editSessionNote(invocation.command.session, invocation.json, output, callDaemon);
  }
  if (invocation.command.kind === "daemon.status") {
    try {
      const paths = installation.paths;
      const response = await callLocalDaemon({ paths, command: invocation.command, deadlineMs: 500 });
      if (!response.ok) return renderFailure(response.error, invocation.json, output);
      daemonStatusIdentity(response);
      renderSuccess(invocation.command, response.data, invocation.json, output);
    } catch (error: unknown) {
      if (!isLocalDaemonUnavailable(error)) throw error;
      renderSuccess(invocation.command, { running: false }, invocation.json, output);
    }
    return 0;
  }
  if (invocation.command.kind === "daemon.stop") {
    const result = await stopDaemonWithExactAuthority(
      installation.paths,
      input.daemonStopDependencies ?? defaultDaemonStopDependencies,
    );
    if (result.kind === "failure") return renderFailure(result.error, invocation.json, output);
    renderSuccess(invocation.command, result.data, invocation.json, output);
    return 0;
  }
  let command = invocation.command;
  if (invocation.command.kind === "project.add") {
    let canonicalProjectRoot: string | null = null;
    try {
      const canonical = await realpath(invocation.command.path);
      canonicalProjectRoot = await resolveUsableCanonicalProjectDirectory(canonical);
    } catch {
      canonicalProjectRoot = null;
    }
    if (canonicalProjectRoot === null) {
      return renderFailure({
        code: "INVALID_INPUT",
        message: "The project directory does not exist or is not readable, writable, traversable, and canonical. Restore access or choose another directory, then retry.",
      }, invocation.json, output);
    }
    command = { ...invocation.command, path: canonicalProjectRoot };
  }
  let response: CommandResponse;
  if (
    command.kind === "session.events"
    && command.waitMs > 0
    && input.sessionObserverSignalMode === "foreground_interrupt"
  ) {
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Session event read interrupted."));
    process.once("SIGINT", abort);
    try {
      response = await callDaemon(command, controller.signal);
      if (controller.signal.aborted) return 0;
    } catch (error: unknown) {
      if (controller.signal.aborted) return 0;
      throw error;
    } finally {
      process.off("SIGINT", abort);
    }
  } else {
    response = await callDaemon(command);
  }
  if (!response.ok) {
    return command.kind === "sync.now"
      ? renderSyncNowFailure(response.error, invocation.json, output)
      : renderFailure(response.error, invocation.json, output);
  }
  if (command.kind === "sync.now") {
    return renderSyncNowSuccess(response.data, invocation.json, output);
  }
  if (command.kind === "doctor") return renderDoctorOutcome(command, response.data, invocation.json, output);
  renderSuccess(command, response.data, invocation.json, output);
  return 0;
}

export async function main(
  argv: readonly string[] = Bun.argv.slice(2),
  output: Output = processOutput,
  input: CliMainInput = {},
): Promise<number> {
  const installation = input.installation ?? createProductionInstallation();
  assertInstallationHome(installation);
  const resolvedInput = { ...input, installation };
  const interactive = resolvedInput.interactive
    ?? (process.stdin.isTTY && process.stderr.isTTY);
  if (argv.length === 0 && interactive) return await runPersistentShell(output, resolvedInput);
  const json = requestsJsonOutput(argv);
  const jsonl = requestsJsonlOutput(argv);
  let invocation: CliInvocation | undefined;
  try {
    invocation = parseCli(argv);
    return await executeInvocation(invocation, output, { ...resolvedInput, interactive });
  } catch (error: unknown) {
    const syncNow = invocation?.kind === "command" && invocation.command.kind === "sync.now";
    const projectionRecovery = invocation?.kind === "sync.projection-recover"
      ? invocation
      : undefined;
    const deviceMutation = invocation?.kind === "command"
      && (
        invocation.command.kind === "device.approve"
        || invocation.command.kind === "device.revoke"
      )
      ? invocation.command
      : undefined;
    const replayableLocalMutation = invocation?.kind === "command"
      && (
        invocation.command.kind === "account.logout"
        || invocation.command.kind === "usage.auto.set"
        || invocation.command.kind === "session.start"
        || invocation.command.kind === "session.send"
        || invocation.command.kind === "session.queue"
        || invocation.command.kind === "session.steer"
        || invocation.command.kind === "session.stop"
        || invocation.command.kind === "session.rename"
        || invocation.command.kind === "session.switch"
        || invocation.command.kind === "session.task.create"
        || invocation.command.kind === "session.task.edit"
        || invocation.command.kind === "session.task.delete"
        || invocation.command.kind === "memory.remember"
        || invocation.command.kind === "memory.share"
        || invocation.command.kind === "memory.hosted.create"
      )
      && typeof invocation.command.idempotencyKey === "string"
      ? invocation.command
      : undefined;
    const sanitizeDaemonDiagnostic = (message: string): string =>
      syncNow || projectionRecovery !== undefined
        ? sanitizeSyncDiagnostic(message)
        : message;
    if (error instanceof CliUsageError) {
      if (requestsWorkApplyProtocol(argv)) {
        writeWorkProtocolFailure(null, {
          code: "invalid_request",
          message: "The work apply invocation is invalid.",
          recovery: "none",
          retryable: false,
          exitCode: 2,
        }, output);
        return 2;
      }
      if (jsonl) return renderJsonlFailure({ code: "INVALID_INPUT", message: error.message }, output);
      if (json) return renderFailure({ code: "INVALID_INPUT", message: error.message }, true, output);
      output.writeStderr(`oompa: ${safeDiagnostic(error.message)}\n\n${usageForGroup(undefined)}\n`);
      return 2;
    }
    if (error instanceof InvalidCommandResponseError) {
      return renderFailure({
        code: "INVALID_RESPONSE",
        message: "The Oompa daemon returned an invalid response for this command.",
      }, json, output);
    }
    if (error instanceof LocalDaemonIndeterminateError) {
      if (projectionRecovery !== undefined) {
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: projectionRecovery.command.idempotencyKey,
            nextCommand: projectionRecovery.replayCommand,
            sameKeyReplay: true,
          },
          message: `${sanitizeSyncDiagnostic(error.message)} The response is uncertain. Reuse the exact same-key command; Oompa did not create a different recovery authority.`,
        }, json, output);
      }
      if (deviceMutation !== undefined) {
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: deviceMutation.idempotencyKey,
            nextCommand: deviceMutationReplayCommand(deviceMutation, json),
            sameKeyReplay: true,
          },
          message: "The device mutation response is uncertain. Reuse the exact same-key command; Oompa did not create a second device-mutation authority.",
        }, json, output);
      }
      if (replayableLocalMutation !== undefined) {
        const presetContractReplayArguments = (
          (replayableLocalMutation.kind === "session.start"
            || replayableLocalMutation.kind === "session.switch")
          && replayableLocalMutation.presetContract !== undefined
        )
          ? ["--preset-contract", String(replayableLocalMutation.presetContract)]
          : [];
        return renderFailure({
          code: "RECOVERY_REQUIRED",
          details: {
            idempotencyKey: replayableLocalMutation.idempotencyKey,
            replayArguments: [
              "--idempotency-key",
              replayableLocalMutation.idempotencyKey,
              ...presetContractReplayArguments,
            ],
            replayPlacement: "before_double_dash",
            sameKeyReplay: true,
          },
          message: "The mutation response is uncertain. Re-run the original command unchanged with the supplied same-key replay arguments before any double-dash delimiter. Oompa did not create a second mutation authority.",
        }, json, output);
      }
      return renderFailure({
        code: "RECOVERY_REQUIRED",
        message: `${sanitizeDaemonDiagnostic(error.message)} Oompa did not replay the command. Inspect its durable result before issuing another mutation.`,
      }, json, output);
    }
    if (error instanceof DaemonAuthorityBusyError) {
      return renderFailure({
        code: "UNAVAILABLE",
        message: sanitizeDaemonDiagnostic(error.message),
      }, json, output);
    }
    if (error instanceof CommandFailure) {
      return renderFailure({
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }, json, output);
    }
    if (error instanceof CloudDeploymentAliasConflictError) {
      return renderFailure({ code: "UNAVAILABLE", message: error.message }, json, output);
    }
    if (json) {
      return renderFailure({
        code: "INTERNAL",
        message: "Oompa failed before a safe command response was available.",
      }, true, output);
    }
    output.writeStderr("oompa: Oompa failed before a safe command response was available.\n");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main();
