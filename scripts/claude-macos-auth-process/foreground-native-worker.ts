/** Explicit synthetic PTY worker. Never accepts a provider runtime or account. */
import { chmodSync, closeSync, constants, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dlopen } from "bun:ffi";

import { runClaudeForegroundLogin } from "../../src/claude/auth";
import { CLAUDE_PIN, CLAUDE_PIN_EFFORT, CLAUDE_PIN_MODEL, CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY } from "../../src/claude/pin";
import { buildPinnedClaudeRuntimeArgv, type PinnedClaudeRuntime } from "../../src/claude/runtime";
import { bindDarwinForegroundLogin, bindDarwinManualBrowserForegroundLogin } from "./foreground";

let phase = "input";
async function main(): Promise<void> {
  if (process.platform !== "darwin" || Bun.version !== "1.3.14" || process.env.OOMPA_CLAUDE_MACOS_FOREGROUND_WORKER !== "1") throw new Error("foreground_fixture_worker_disabled");
  const value: unknown = JSON.parse(readFileSync(join(process.cwd(), "input.json"), "utf8"));
  if (typeof value !== "object" || value === null) throw new Error("foreground_fixture_input_refused");
  const input = value as Record<string, unknown>;
  if (typeof input.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.sha256) || typeof input.mode !== "string"
    || !["normal", "manual_browser", "abort", "ctrl_c", "preabort", "binding_changed", "terminal_changed", "one_owner"].includes(input.mode)) throw new Error("foreground_fixture_input_refused");
  const configDir = join(process.cwd(), input.mode);
  const executablePath = join(process.cwd(), "fixture");
  const controller = new AbortController();
  process.on("message", (message: unknown) => {
    if (typeof message === "object" && message !== null && Object.keys(message).length === 1 && Reflect.get(message, "kind") === "abort") controller.abort();
  });
  phase = "binding";
  const bind = input.mode === "manual_browser" ? bindDarwinManualBrowserForegroundLogin : bindDarwinForegroundLogin;
  const binding = bind({ executablePath, executableSha256: input.sha256, configDir,
    temporaryDirectory: join(process.cwd(), "temporary"), environment: { PATH: "/usr/bin:/bin", HOME: homedir(), LANG: "C", LC_ALL: "C", TZ: "UTC", BROWSER: "/synthetic-must-not-launch", ANTHROPIC_API_KEY: "synthetic-must-not-cross", NODE_OPTIONS: "synthetic-must-not-cross" },
  });
  binding.assertOwnerTerminalCurrent();
  const runtime: PinnedClaudeRuntime = { executablePath, version: CLAUDE_PIN, model: CLAUDE_PIN_MODEL, effort: CLAUDE_PIN_EFFORT,
    nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY, argv: buildPinnedClaudeRuntimeArgv({ executablePath, nativeFallback: CLAUDE_PIN_NATIVE_FALLBACK_CAPABILITY }) };
  let secondRefused = false;
  if (input.mode === "preabort") controller.abort();
  if (input.mode === "binding_changed") chmodSync(executablePath, 0o500);
  let restoreTerminal: (() => void) | null = null;
  if (input.mode === "terminal_changed") {
    const native = dlopen("/usr/lib/libSystem.B.dylib", { dup: { args: ["i32"], returns: "i32" }, dup2: { args: ["i32", "i32"], returns: "i32" } });
    const held = native.symbols.dup(1);
    if (held < 0) { native.close(); throw new Error("foreground_fixture_terminal_copy_failed"); }
    const sink = openSync("/dev/null", constants.O_WRONLY);
    try {
      if (native.symbols.dup2(sink, 1) !== 1) throw new Error("foreground_fixture_terminal_replace_failed");
    } catch (error: unknown) { closeSync(held); native.close(); throw error; }
    finally { closeSync(sink); }
    restoreTerminal = () => {
      try { if (native.symbols.dup2(held, 1) !== 1) throw new Error("foreground_fixture_terminal_restore_failed"); }
      finally { closeSync(held); native.close(); }
    };
  }
  phase = "login";
  let result;
  try { result = await runClaudeForegroundLogin({ configDir, runtime, environment: binding.environment, stdio: binding.stdio,
    signal: controller.signal, signalGraceMs: 150, forceJoinDeadlineMs: 1000,
    processFactory(actual) {
      const child = binding.processFactory(actual);
      if (input.mode === "one_owner") {
        try { binding.processFactory(actual); } catch { secondRefused = true; }
      }
      return child;
    },
  }); } finally { restoreTerminal?.(); }
  phase = "collection";
  const settlement = await binding.settled();
  binding.assertOwnerTerminalCurrent();
  writeFileSync(join(process.cwd(), "result.json"), JSON.stringify({ result, settlement, secondRefused, ownerPid: process.pid }), { mode: 0o600, flag: "wx" });
  if (process.connected) process.disconnect?.();
}

if (import.meta.main) {
  try { await main(); }
  catch (error: unknown) {
    const code = error instanceof Error && /^claude_macos_auth_process_[a-z_]+$/u.test(error.message) ? error.message : "foreground_fixture_failure";
    try { writeFileSync(join(process.cwd(), "failure.json"), JSON.stringify({ phase, code }), { mode: 0o600, flag: "wx" }); } catch { /* An uncollected fixture always retains its root. */ }
    process.exitCode = 1; if (process.connected) process.disconnect?.();
  }
}
