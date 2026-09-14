import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { renderFailure, safeDiagnostic, safeJson, type Output } from "./render";

/*
 * `oompa menubar` launches the Rust status-item binary built from
 * `desktop/oompa-menubar`. The binary is a disposable client of the local
 * daemon socket; the daemon stays the sole authority. One status item exists
 * per user — a second launch exits quietly once the runtime lock is held, so
 * the CLI reports that as "already running" instead of an error. Interactive
 * launches stay in the foreground; `--background` and the LaunchAgent are the
 * only detached paths.
 */

const STARTUP_SETTLE_MS = 400;
const INSTALL_RELATIVE_BINARY = "Library/Application Support/Oompa/bin/oompa-menubar";
const LAUNCH_AGENT_LABEL = "com.hraness.oompa.menubar";

function homeDirectory(env: NodeJS.ProcessEnv): string {
  return env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
}

export function installedMenubarBinary(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDirectory(env), INSTALL_RELATIVE_BINARY);
}

export function menubarLaunchAgentPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(homeDirectory(env), "Library/LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function buildCandidates(env: NodeJS.ProcessEnv): readonly string[] {
  return [
    env.OOMPA_MENUBAR_PATH,
    resolve(dirname(process.execPath), "oompa-menubar"),
    resolve(import.meta.dir, "../../desktop/target/release/oompa-menubar"),
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.length > 0);
}

export function resolveMenubarBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [installedMenubarBinary(env), ...buildCandidates(env)];
  for (const candidate of candidates) {
    if (candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveBuildBinary(env: NodeJS.ProcessEnv): string | null {
  const installed = installedMenubarBinary(env);
  for (const candidate of buildCandidates(env)) {
    if (candidate !== installed && existsSync(candidate)) return candidate;
  }
  return null;
}

function launchctlDomain(): string {
  return `gui/${typeof process.getuid === "function" ? process.getuid() : 0}`;
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function launchAgentContents(binary: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapePlist(binary)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>
`;
}

async function runLaunchctl(args: readonly string[]): Promise<number> {
  const child = Bun.spawn(["/bin/launchctl", ...args], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  return await child.exited;
}

function unsupportedPlatform(json: boolean, output: Output): number {
  return renderFailure({ code: "UNAVAILABLE", message: "The Oompa menu bar installer requires macOS." }, json, output);
}

export async function launchMenubar(json: boolean, output: Output, background = false): Promise<number> {
  const binary = resolveMenubarBinary();
  if (binary === null) {
    return renderFailure({
      code: "UNAVAILABLE",
      message: "The Oompa menu bar is not installed. Build it with `cargo build --release --manifest-path desktop/Cargo.toml` or set OOMPA_MENUBAR_PATH.",
    }, json, output);
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([binary], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
  } catch (error: unknown) {
    return renderFailure({
      code: "UNAVAILABLE",
      message: `The Oompa menu bar could not start: ${safeDiagnostic(error instanceof Error ? error.message : String(error))}`,
    }, json, output);
  }
  const settled = await Promise.race([
    child.exited.then((code: number) => code),
    Bun.sleep(STARTUP_SETTLE_MS).then(() => null),
  ]);
  if (settled !== null && settled !== 0) {
    const stderr = typeof child.stderr === "number" ? "" : await new Response(child.stderr).text();
    return renderFailure({
      code: "INTERNAL",
      message: `The Oompa menu bar exited during startup (status ${settled}).${stderr.trim().length > 0 ? ` ${safeDiagnostic(stderr.trim())}` : ""}`,
    }, json, output);
  }
  const alreadyRunning = settled === 0;
  if (settled === null && background) child.unref();
  if (json) {
    output.writeStdout(`${safeJson({ ok: true, version: 1, data: { running: true, alreadyRunning } })}\n`);
  } else {
    output.writeStdout(alreadyRunning
      ? "Oompa menu bar is already running.\n"
      : "Oompa menu bar is running.\n");
  }
  // Foreground is the default for an interactive launch. The LaunchAgent (or
  // explicit --background) owns detached startup; this process owns the menu
  // child until the user quits it.
  if (settled === null && !background) await child.exited;
  return 0;
}

export async function installMenubar(json: boolean, output: Output): Promise<number> {
  if (process.platform !== "darwin") return unsupportedPlatform(json, output);
  const source = resolveBuildBinary(process.env);
  if (source === null) {
    return renderFailure({
      code: "UNAVAILABLE",
      message: "A prebuilt release menu-bar binary is required. Run `cargo build --release --manifest-path desktop/Cargo.toml` first.",
    }, json, output);
  }
  const target = installedMenubarBinary();
  const plist = menubarLaunchAgentPath();
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await mkdir(dirname(plist), { recursive: true, mode: 0o700 });
    await copyFile(source, target);
    await chmod(target, 0o755);
    const temporary = `${plist}.${process.pid}.tmp`;
    await writeFile(temporary, launchAgentContents(target), { mode: 0o600 });
    await rename(temporary, plist);
    // Reinstalling is idempotent: remove the old registration before loading
    // the new RunAtLoad-only plist. A failure is tolerated when not loaded.
    await runLaunchctl(["bootout", launchctlDomain(), plist]);
    const status = await runLaunchctl(["bootstrap", launchctlDomain(), plist]);
    if (status !== 0) throw new Error(`launchctl bootstrap exited with status ${status}`);
  } catch (error: unknown) {
    return renderFailure({
      code: "INTERNAL",
      message: `The Oompa menu bar could not be installed: ${safeDiagnostic(error instanceof Error ? error.message : String(error))}`,
    }, json, output);
  }
  if (json) output.writeStdout(`${safeJson({ ok: true, version: 1, data: { installed: true, path: plist } })}\n`);
  else output.writeStdout(`Oompa menu bar installed at ${plist}.\n`);
  return 0;
}

export async function uninstallMenubar(json: boolean, output: Output): Promise<number> {
  if (process.platform !== "darwin") return unsupportedPlatform(json, output);
  const target = installedMenubarBinary();
  const plist = menubarLaunchAgentPath();
  try {
    await runLaunchctl(["bootout", launchctlDomain(), plist]);
    await unlink(plist).catch(() => undefined);
    await unlink(target).catch(() => undefined);
  } catch (error: unknown) {
    return renderFailure({
      code: "INTERNAL",
      message: `The Oompa menu bar could not be uninstalled: ${safeDiagnostic(error instanceof Error ? error.message : String(error))}`,
    }, json, output);
  }
  if (json) output.writeStdout(`${safeJson({ ok: true, version: 1, data: { installed: false } })}\n`);
  else output.writeStdout("Oompa menu bar uninstalled.\n");
  return 0;
}
