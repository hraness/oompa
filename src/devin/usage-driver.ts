// Drives the pinned Devin CLI on a pseudo-terminal exactly far enough to render
// its `/usage` panel, then exits it. The driver types only `/usage`, Enter,
// `/exit` and Enter, so it can never submit a prompt or spend a model turn.

import { DevinError } from "./errors.ts";
import { devinEnvironment, type PinnedDevinRuntime } from "./runtime.ts";
import {
  DEVIN_USAGE_PANEL_MAX_BYTES,
  parseDevinUsagePanel,
  stripTerminalControls,
  type DevinUsageObservation,
} from "./usage-panel.ts";

export interface DevinTerminalProcess {
  /** Resolves with the exit code, or null when the child was killed by a signal. */
  readonly exited: Promise<number | null>;
  write(data: string): void;
  kill(): void;
}

export type DevinTerminalProcessFactory = (input: Readonly<{
  argv: readonly [string, ...string[]];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
  onData: (chunk: Uint8Array) => void;
}>) => DevinTerminalProcess;

export interface ReadDevinUsagePanelOptions {
  readonly runtime: PinnedDevinRuntime;
  /** An existing directory the CLI may treat as its workspace; workspace trust is bypassed for it. */
  readonly workingDirectory: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /** Deadline for the input prompt to appear after launch. */
  readonly promptDeadlineMs?: number;
  /** Deadline for the quota line after `/usage` is accepted. */
  readonly quotaDeadlineMs?: number;
  /** Deadline for a clean exit after `/exit` before the child is killed. */
  readonly exitDeadlineMs?: number;
  readonly maxBytes?: number;
  readonly terminalFactory?: DevinTerminalProcessFactory;
}

const PROMPT_DEADLINE_MS = 20_000;
const QUOTA_DEADLINE_MS = 20_000;
const EXIT_DEADLINE_MS = 5_000;
const POPUP_DEADLINE_MS = 3_000;
const KEY_SETTLE_MS = 150;
/** The prompt text renders before the TUI arms its input handler; typing earlier drops keys. */
const PROMPT_SETTLE_MS = 1_000;
const TERMINAL_COLS = 120;
const TERMINAL_ROWS = 40;

const INPUT_PROMPT = /Ask Devin to build/u;
const TRUST_PROMPT = /Trust .{1,512}\?/u;
const USAGE_POPUP = /Show session usage/u;
const QUOTA_LINE = /(?:Daily|Weekly)[ \t]+[\u2500-\u25FF#=\-·. \t]{1,64}?[ \t]+\d{1,3}% used[ \t]+·[ \t]+resets [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M \(UTC[+-]\d{1,2}(?::\d{2})?\)/u;

const defaultTerminalProcess: DevinTerminalProcessFactory = (input) => {
  const child = Bun.spawn([...input.argv], {
    cwd: input.cwd,
    env: input.environment,
    terminal: {
      cols: input.cols,
      rows: input.rows,
      data: (_terminal, data) => { input.onData(data); },
    },
  });
  return {
    exited: child.exited.then((code) => (child.signalCode === null ? code : null)),
    write: (data) => { child.terminal?.write(data); },
    kill: () => { child.kill("SIGKILL"); },
  };
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

function assertDeadline(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 120_000) {
    throw new DevinError("INVALID_INPUT", `Devin ${label} deadline is invalid`);
  }
}

/**
 * Reads one `/usage` observation from the pinned CLI. Runtime failures throw a
 * `DevinError`; an unrecognized panel returns an `unknown` observation.
 */
export async function readDevinUsagePanel(options: ReadDevinUsagePanelOptions): Promise<DevinUsageObservation> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const now = options.now ?? Date.now;
  const promptDeadlineMs = options.promptDeadlineMs ?? PROMPT_DEADLINE_MS;
  const quotaDeadlineMs = options.quotaDeadlineMs ?? QUOTA_DEADLINE_MS;
  const exitDeadlineMs = options.exitDeadlineMs ?? EXIT_DEADLINE_MS;
  const maxBytes = options.maxBytes ?? DEVIN_USAGE_PANEL_MAX_BYTES;
  assertDeadline(promptDeadlineMs, "prompt");
  assertDeadline(quotaDeadlineMs, "quota");
  assertDeadline(exitDeadlineMs, "exit");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEVIN_USAGE_PANEL_MAX_BYTES) {
    throw new DevinError("INVALID_INPUT", "Devin usage capture limit is invalid");
  }
  if (options.workingDirectory.length === 0 || !options.workingDirectory.startsWith("/")) {
    throw new DevinError("INVALID_INPUT", "the Devin working directory must be an absolute path");
  }

  const chunks: Uint8Array[] = [];
  // Mutated from the data callback, so the flags live on an object TypeScript cannot narrow.
  const capture = { total: 0, overflow: false, stripped: "", strippedThrough: 0 };
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const text = (): string => {
    if (capture.strippedThrough === chunks.length) return capture.stripped;
    const merged = new Uint8Array(capture.total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    capture.stripped = stripTerminalControls(decoder.decode(merged));
    capture.strippedThrough = chunks.length;
    return capture.stripped;
  };

  const environment = devinEnvironment(options.environment ?? process.env);
  environment.TERM = "xterm-256color";
  environment.NO_COLOR = "1";
  let child: DevinTerminalProcess;
  try {
    child = (options.terminalFactory ?? defaultTerminalProcess)({
      argv: [options.runtime.executablePath, "--respect-workspace-trust", "false"],
      cwd: options.workingDirectory,
      environment,
      cols: TERMINAL_COLS,
      rows: TERMINAL_ROWS,
      onData: (chunk) => {
        if (capture.overflow) return;
        if (capture.total + chunk.byteLength > maxBytes) { capture.overflow = true; return; }
        capture.total += chunk.byteLength;
        chunks.push(chunk);
      },
    });
  } catch (error: unknown) {
    throw new DevinError("PROCESS_EXITED", "the Devin CLI could not be started", { cause: error });
  }
  let exitedCode: number | null | undefined;
  const exited = child.exited.then((code) => { exitedCode = code; return code; }, () => { exitedCode = null; return null; });

  const waitFor = async (pattern: RegExp, deadlineMs: number, what: string): Promise<boolean> => {
    const end = now() + deadlineMs;
    for (;;) {
      signal.throwIfAborted();
      if (capture.overflow) throw new DevinError("PROTOCOL_LIMIT", "Devin usage output exceeded its byte limit.");
      const current = text();
      if (pattern.test(current)) return true;
      if (TRUST_PROMPT.test(current)) return false;
      if (exitedCode !== undefined) throw new DevinError("PROCESS_EXITED", `the Devin CLI exited before ${what}`);
      if (now() >= end) throw new DevinError("TIMEOUT", `the Devin CLI did not render ${what} within its deadline`);
      await sleep(50);
    }
  };

  const observedAt = now();
  try {
    const promptShown = await waitFor(INPUT_PROMPT, promptDeadlineMs, "its input prompt");
    if (promptShown) {
      await sleep(PROMPT_SETTLE_MS);
      signal.throwIfAborted();
      child.write("/usage");
      try {
        await waitFor(USAGE_POPUP, POPUP_DEADLINE_MS, "the usage command");
      } catch (error: unknown) {
        if (!(error instanceof DevinError) || error.code !== "TIMEOUT") throw error;
      }
      await sleep(KEY_SETTLE_MS);
      child.write("\r");
      try {
        await waitFor(QUOTA_LINE, quotaDeadlineMs, "its quota line");
      } catch (error: unknown) {
        if (!(error instanceof DevinError) || error.code !== "TIMEOUT") throw error;
      }
      await sleep(KEY_SETTLE_MS);
    }
    child.write("/exit");
    await sleep(KEY_SETTLE_MS);
    child.write("\r");
    const settled = await Promise.race([exited.then(() => "exited" as const), sleep(exitDeadlineMs).then(() => "timeout" as const)]);
    if (settled === "timeout") child.kill();
    await exited;
  } catch (error: unknown) {
    child.kill();
    await exited;
    throw error;
  }
  if (capture.overflow) throw new DevinError("PROTOCOL_LIMIT", "Devin usage output exceeded its byte limit.");
  return parseDevinUsagePanel({ text: text(), cliVersion: options.runtime.versionOutput, observedAt });
}
