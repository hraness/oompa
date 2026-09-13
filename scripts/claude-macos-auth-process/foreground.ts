import { fstatSync } from "node:fs";
import { isatty } from "node:tty";

import { dlopen } from "bun:ffi";

import type { ClaudeForegroundLoginProcessFactory } from "../../src/claude/auth";
import { bindDarwinQualificationEnvironment, type ClaudeQualificationBindingInput } from "./binding";
import { detachedProcessError } from "./detachment";

const descriptors = Object.freeze({ stdin: 0, stdout: 1, stderr: 2 });
const loginArguments = ["auth", "login", "--claudeai"] as const;

/** Pure environment construction; this supplies no process or login authority. */
export function manualBrowserEnvironment(environment: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  if (Object.hasOwn(environment, "BROWSER")) throw detachedProcessError("foreground_request_refused");
  return Object.freeze({ ...environment, BROWSER: "/usr/bin/true" });
}

/** The only accepted factory request is the bound login and the owner's standard terminal. */
export function assertForegroundLoginRequest(
  expected: Readonly<{ executablePath: string; environment: Readonly<Record<string, string>> }>,
  actual: unknown,
): void {
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) throw detachedProcessError("foreground_request_refused");
  const value = actual as Record<string, unknown>;
  const argv = value.argv;
  if (Object.keys(value).length !== 5 || value.stdin !== 0 || value.stdout !== 1 || value.stderr !== 2
    || !Array.isArray(argv) || argv.length !== 4 || argv[0] !== expected.executablePath
    || loginArguments.some((argument, index) => argv[index + 1] !== argument)
    || typeof value.environment !== "object" || value.environment === null || Array.isArray(value.environment)) throw detachedProcessError("foreground_request_refused");
  const environment = value.environment as Record<string, unknown>;
  if (Object.keys(environment).length !== Object.keys(expected.environment).length
    || Object.entries(expected.environment).some(([key, content]) => environment[key] !== content)) throw detachedProcessError("foreground_request_refused");
}

type TerminalIdentity = Readonly<{ device: number; inode: number; owner: number; mode: number; terminalDevice: number }>;
type TerminalLibrary = Readonly<{ symbols: Readonly<{
  getpgrp(): number;
  getsid(pid: number): number;
  tcgetpgrp(fd: number): number;
}> }>;
let library: TerminalLibrary | undefined;
function terminalLibrary(): TerminalLibrary {
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw detachedProcessError("platform_refused");
  library ??= dlopen("/usr/lib/libSystem.B.dylib", {
    getpgrp: { args: [], returns: "i32" },
    getsid: { args: ["i32"], returns: "i32" },
    tcgetpgrp: { args: ["i32"], returns: "i32" },
  });
  return library;
}

function bindOwnerTerminal(): Readonly<{ assertCurrent(): void }> {
  const native = terminalLibrary().symbols;
  const group = native.getpgrp();
  const session = native.getsid(0);
  if (group < 1 || session < 1) throw detachedProcessError("owner_terminal_refused");
  const snapshot = (): readonly TerminalIdentity[] => Object.values(descriptors).map((fd) => {
    const metadata = fstatSync(fd);
    if (!isatty(fd) || !metadata.isCharacterDevice() || native.tcgetpgrp(fd) !== group) throw detachedProcessError("owner_terminal_refused");
    return Object.freeze({ device: metadata.dev, inode: metadata.ino, owner: metadata.uid, mode: metadata.mode, terminalDevice: metadata.rdev });
  });
  const identities = snapshot();
  if (identities.some((identity) => identity.terminalDevice !== identities[0]?.terminalDevice)) throw detachedProcessError("owner_terminal_refused");
  return Object.freeze({ assertCurrent() {
    if (native.getpgrp() !== group || native.getsid(0) !== session || JSON.stringify(snapshot()) !== JSON.stringify(identities)) throw detachedProcessError("owner_terminal_changed");
  } });
}

export type ForegroundQualificationSettlement = Readonly<{
  cleanup: "joined" | "uncertain";
  childJoined: boolean;
  exitCode: number | null;
  ownerTerminalVerified: true;
  stdin: 0;
  stdout: 1;
  stderr: 2;
  requestedSignals: Readonly<{ SIGINT: number; SIGTERM: number; SIGKILL: number }>;
  browserMode?: "owner_manual";
}>;

/** A single-attempt process factory; the existing auth runner owns login signal policy. */
export function bindDarwinForegroundLogin(input: ClaudeQualificationBindingInput): Readonly<{
  environment: Readonly<Record<string, string>>;
  stdio: typeof descriptors;
  processFactory: ClaudeForegroundLoginProcessFactory;
  assertOwnerTerminalCurrent(): void;
  settled(): Promise<ForegroundQualificationSettlement | null>;
}> {
  return bindForeground(input, false);
}

const manualBrowserBrand = Symbol("qualification-manual-browser");
/** Closed qualification operation. Ambient browser commands never enter this binding. */
export function bindDarwinManualBrowserForegroundLogin(input: ClaudeQualificationBindingInput) {
  return Object.freeze({ ...bindForeground(input, true), [manualBrowserBrand]: true as const, browserMode: "owner_manual" as const });
}

function bindForeground(input: ClaudeQualificationBindingInput, manualBrowser: boolean) {
  const binding = bindDarwinQualificationEnvironment(input);
  const childEnvironment = manualBrowser ? manualBrowserEnvironment(binding.environment) : binding.environment;
  const terminal = bindOwnerTerminal();
  let used = false;
  let settlement: Promise<ForegroundQualificationSettlement> | null = null;
  const processFactory: ClaudeForegroundLoginProcessFactory = (actual) => {
    assertForegroundLoginRequest(binding, actual);
    if (used) throw detachedProcessError("foreground_owner_used");
    used = true;
    binding.assertCurrent();
    terminal.assertCurrent();
    // All fallible admission is complete. After spawn, retain this exact child
    // and express any missing native join through its promises, never a new throw.
    const child = Bun.spawn([binding.executablePath, ...loginArguments], {
      cwd: binding.configDir, env: childEnvironment, detached: false,
      stdin: 0, stdout: 1, stderr: 2,
    });
    let joined = false;
    const requestedSignals = { SIGINT: 0, SIGTERM: 0, SIGKILL: 0 };
    const exited = child.exited.then((code) => { joined = true; return code; });
    const receipt = (exitCode: number | null): ForegroundQualificationSettlement => Object.freeze({
      cleanup: joined ? "joined" : "uncertain", childJoined: joined, exitCode, ownerTerminalVerified: true,
      stdin: 0, stdout: 1, stderr: 2, requestedSignals: Object.freeze({ ...requestedSignals }),
      ...(manualBrowser ? { browserMode: "owner_manual" as const } : {}),
    });
    settlement = exited.then(receipt, () => receipt(null));
    return Object.freeze({ exited,
      sendSignal(signal: unknown) {
        if (signal !== "SIGINT" && signal !== "SIGTERM") throw detachedProcessError("foreground_signal_refused");
        if (!joined) { requestedSignals[signal] += 1; child.kill(signal); }
      },
      forceTerminate() {
        if (!joined) { requestedSignals.SIGKILL += 1; child.kill("SIGKILL"); }
      },
    });
  };
  return Object.freeze({ environment: binding.environment, stdio: descriptors, processFactory, assertOwnerTerminalCurrent: terminal.assertCurrent,
    async settled() { return settlement === null ? null : await settlement; },
  });
}
