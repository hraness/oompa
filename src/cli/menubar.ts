import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { renderFailure, safeDiagnostic, safeJson, type Output } from "./render";

/*
 * `oompa menubar` launches the detached Rust status-item binary built from
 * `desktop/oompa-menubar`. The binary is a disposable client of the local
 * daemon socket; the daemon stays the sole authority. One status item exists
 * per user — a second launch exits quietly once the runtime lock is held, so
 * the CLI reports that as "already running" instead of an error.
 */

const STARTUP_SETTLE_MS = 400;

export function resolveMenubarBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.OOMPA_MENUBAR_PATH,
    resolve(dirname(process.execPath), "oompa-menubar"),
    resolve(import.meta.dir, "../../desktop/target/release/oompa-menubar"),
    resolve(import.meta.dir, "../../desktop/target/debug/oompa-menubar"),
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate;
  }
  return null;
}

export async function launchMenubar(json: boolean, output: Output): Promise<number> {
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
  child.unref();
  const settled = await Promise.race([
    child.exited.then((code: number) => code),
    Bun.sleep(STARTUP_SETTLE_MS).then(() => null),
  ]);
  if (settled !== null && settled !== 0) {
    const stderr = await new Response(child.stderr).text();
    return renderFailure({
      code: "INTERNAL",
      message: `The Oompa menu bar exited during startup (status ${settled}).${stderr.trim().length > 0 ? ` ${safeDiagnostic(stderr.trim())}` : ""}`,
    }, json, output);
  }
  const alreadyRunning = settled === 0;
  if (json) {
    output.writeStdout(`${safeJson({ ok: true, version: 1, data: { running: true, alreadyRunning } })}\n`);
  } else {
    output.writeStdout(alreadyRunning
      ? "Oompa menu bar is already running.\n"
      : "Oompa menu bar is running.\n");
  }
  return 0;
}
