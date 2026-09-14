import { createHash } from "node:crypto";
import type { NativeLaunch, NativeRootExit, NativeWriteResult } from "../native-process/protocol.ts";
import { CodexError } from "./errors.ts";
import { allowlistedEnvironment, type CodexProcess } from "./process.ts";
import type { PinnedCodexRuntime } from "./runtime.ts";

/** Trusted application owner. Codex consumes its committed readiness and
 * closure; it cannot access or mutate the application's custody journal. */
export interface NativeCodexProcessOwner {
  readonly ready: Promise<unknown>;
  readonly rootExited: Promise<NativeRootExit>;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): Promise<NativeWriteResult>;
  requestStop(): void;
  forceStop(): void;
  releaseCustody(): Promise<void>;
  stopAndRelease(): Promise<void>;
}

/** Product runtime contract identity, distinct from the shared executable's
 * complete byte digest. Official package installation retains responsibility
 * for admitting Codex and its platform dependency. No credential/path enters
 * the durable binding and this does not claim to hash Codex's linked binary. */
export function nativeCodexRuntimeContractDigest(runtime: PinnedCodexRuntime): string {
  return createHash("sha256").update(JSON.stringify({ version: 1, provider: "codex",
    package: "@openai/codex", packageVersion: runtime.packageVersion,
    platform: process.platform, architecture: process.arch, launcherArguments: runtime.launcherArgv.slice(2),
  })).digest("hex");
}

/** The factory retains every pre-Ready failure. A Codex client only receives a
 * process after native root identity was committed; NotStarted never needs a
 * fabricated root exit to discharge its correctly proven writer barrier. */
export async function readyNativeCodexProcess(owner: NativeCodexProcessOwner): Promise<CodexProcess> {
  try { await owner.ready; }
  catch (error) {
    try { await owner.stopAndRelease(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Native Codex launch failed and process custody remains unproved.");
    }
    throw error;
  }
  const exited = owner.rootExited.then(observation => {
    if (observation.code !== null) return observation.code;
    if (observation.signal === null) throw new CodexError("PROCESS_EXITED", "Native Codex root exit is unproved");
    return 128 + observation.signal;
  });
  void exited.catch(() => {});
  return {
    stdout: owner.stdout, stderr: owner.stderr, exited,
    joinCustody: () => owner.releaseCustody(),
    write: async bytes => {
      const expected = bytes.byteLength;
      const result = await owner.write(bytes);
      if (result.outcome !== "accepted-full" || result.acceptedBytes !== expected) {
        throw new CodexError("PROCESS_EXITED", "Native Codex stdin did not acknowledge the complete frame");
      }
    },
    terminate: () => { owner.requestStop(); },
    forceTerminate: () => { owner.forceStop(); },
  };
}

export async function spawnNativeCodexProcess(options: Readonly<{
  launchProcess: (launch: Omit<NativeLaunch, "nonce" | "scope"> & { scope: "posix-process-group" }) => Promise<NativeCodexProcessOwner>;
  runtime: PinnedCodexRuntime; codexHome: string; cwd: string;
  environment?: Readonly<Record<string, string | undefined>>;
  termGraceMs?: number; settlementMs?: number; writeTimeoutMs?: number;
}>): Promise<CodexProcess> {
  const environment = allowlistedEnvironment(options.environment ?? process.env);
  environment.CODEX_HOME = options.codexHome;
  environment.NO_COLOR = "1";
  const owner = await options.launchProcess({
    version: 1, scope: "posix-process-group", argv: [...options.runtime.launcherArgv],
    cwd: options.cwd, environment, termGraceMs: options.termGraceMs ?? 2000,
    settlementMs: options.settlementMs ?? 1000, writeTimeoutMs: options.writeTimeoutMs ?? 30_000,
  });
  return await readyNativeCodexProcess(owner);
}
