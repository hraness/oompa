import { resolve } from "node:path";

import { runDaemon } from "../../src/cli";
import type { OompaInstallation } from "../../src/installation";
import { personalProviderPaths, resolveStatePaths } from "../../src/storage/paths";
import { FileSecretBackend, GenerationalSecretCustody } from "../../src/storage/secret-custody";
import { assertHardenedAppSourceProofStageZero } from "../verify-app-source-launcher";
import {
  daemonQualificationChildResultSchema, daemonQualificationDescriptorSchema, daemonQualificationPaths,
  type DaemonQualificationDescriptor,
} from "./contract";
import { createPersonalClaudeDaemonProof } from "./process-observer";

const invalid = (): Error => new Error("DARWIN_DAEMON_CHILD_REFUSED");

/** One private descriptor; the parent retains the same writer until shutdown.
 * EOF or any extra byte synchronously withdraws this child's daemon lifetime. */
async function receiveDescriptor(controller: AbortController): Promise<Readonly<{
  descriptor: DaemonQualificationDescriptor; close(): void;
}>> {
  let joined = false;
  const chunks: Buffer[] = [];
  let total = 0;
  let received = false;
  let settle!: (value: DaemonQualificationDescriptor) => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<DaemonQualificationDescriptor>((resolvePromise, reject) => { settle = resolvePromise; fail = reject; });
  const stop = () => { controller.abort(invalid()); if (!received) fail(invalid()); };
  const onData = (chunk: Buffer) => {
    try {
      if (received || !(chunk instanceof Uint8Array) || chunk.byteLength > 16384 - total) throw invalid();
      chunks.push(Buffer.from(chunk)); total += chunk.byteLength;
      const bytes = Buffer.concat(chunks);
      try {
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        if (newline !== bytes.byteLength - 1) throw invalid();
        const parsed = daemonQualificationDescriptorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown);
        received = true; settle(parsed);
      } finally { bytes.fill(0); }
    } catch { stop(); }
    finally { if (received || controller.signal.aborted) for (const chunk of chunks.splice(0)) chunk.fill(0); }
  };
  const deadline = setTimeout(stop, 5000);
  process.stdin.on("data", onData); process.stdin.once("end", stop); process.stdin.once("error", stop);
  process.stdin.resume();
  const close = () => {
    if (joined) return; joined = true;
    clearTimeout(deadline);
    process.stdin.off("data", onData); process.stdin.off("end", stop); process.stdin.off("error", stop);
    process.stdin.destroy(); for (const chunk of chunks.splice(0)) chunk.fill(0);
  };
  try { const descriptor = await promise; clearTimeout(deadline); return Object.freeze({ descriptor, close }); }
  catch (error: unknown) { close(); throw error; }
}

async function writeResult(value: unknown): Promise<void> {
  const parsed = daemonQualificationChildResultSchema.parse(value);
  const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`);
  if (bytes.byteLength > 4096) throw invalid();
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(invalid()), 1000);
      process.stdout.write(bytes, (error) => { clearTimeout(timer); if (error) reject(invalid()); else resolvePromise(); });
    });
  } finally { bytes.fill(0); }
}

async function main(): Promise<number> {
  assertHardenedAppSourceProofStageZero(process.execArgv, process.env);
  if (process.platform !== "darwin" || process.arch !== "arm64" || Bun.version !== "1.3.14" || process.argv.length !== 2) return 64;
  const controller = new AbortController();
  const input = await receiveDescriptor(controller);
  try {
    const descriptor = input.descriptor;
    if (descriptor.repositoryRoot !== resolve(import.meta.dir, "../..") || process.env.HOME !== descriptor.ownerHome
      || process.env.PATH !== "/usr/bin:/bin:/usr/sbin:/sbin" || process.env.TMPDIR !== "/private/tmp"
      || process.env.LANG !== "C" || process.env.LC_ALL !== "C") throw invalid();
    const proof = await createPersonalClaudeDaemonProof(descriptor);
    if (controller.signal.aborted) throw invalid();
    const layout = daemonQualificationPaths(descriptor.runRoot);
    const paths = resolveStatePaths({ rootDirectory: layout.state });
    const unusedPersonal = personalProviderPaths(resolve(layout.state, "unused-personal"));
    const installation: OompaInstallation = {
      kind: "live_acceptance", expectedHomeDirectory: descriptor.ownerHome,
      paths, documentsDirectory: layout.project, cloudEnvironment: { HRA_CONVEX_URL: "" },
      personalProviderHomes: { ...unusedPersonal, claudeConfigDir: layout.profile },
      createSecretCustody: () => new GenerationalSecretCustody(paths, new FileSecretBackend(resolve(layout.state, "secret-values"))),
      credentialStorePreflight: { cliAuth: "file", mcpOauth: "file", cwd: layout.project },
      codexEnvironment: async () => { throw invalid(); }, prepareCodexHome: async () => { throw invalid(); },
    };
    const deadline = new AbortController();
    const timer = setTimeout(() => { deadline.abort(invalid()); controller.abort(invalid()); }, 300_000);
    let outcome: "stopped" | "refused" = "refused";
    try {
      if (await runDaemon(installation, { stopSignal: controller.signal, liveAcceptancePersonalClaudeProof: proof.port }) === 0
        && !deadline.signal.aborted && proof.snapshot().collection === "joined" && !proof.snapshot().observationViolation) outcome = "stopped";
    } catch { /* Operation diagnostics and credentials do not cross this pipe. */ }
    finally { clearTimeout(timer); }
    await writeResult({ version: 1, purpose: "authenticated_personal_daemon_restart", runId: descriptor.runId,
      stage: descriptor.stage, outcome, process: proof.snapshot() });
    return outcome === "stopped" ? 0 : 70;
  } finally { input.close(); }
}

if (import.meta.main) process.exitCode = await main().catch(() => 70);
