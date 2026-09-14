import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { CodexAppServerClient, type CodexAppServerClientOptions } from "./client.ts";
import { CodexError } from "./errors.ts";
import { record, string } from "./parse.ts";
import { spawnBunCodexProcess, type CodexProcess } from "./process.ts";
import {
  PINNED_CODEX_VERSION,
  validateAuthority,
  type CodexAuthority,
} from "./protocol.ts";

export interface PinnedCodexRuntime {
  readonly packageRoot: string;
  readonly packageJsonPath: string;
  readonly packageVersion: typeof PINNED_CODEX_VERSION;
  readonly launcherArgv: readonly [
    string,
    string,
    "app-server",
    "--listen",
    "stdio://",
    "--config",
    'cli_auth_credentials_store="file"',
    "--config",
    'mcp_oauth_credentials_store="file"',
  ];
}

export interface ResolvePinnedCodexRuntimeOptions {
  readonly packageJsonPath?: string;
  readonly resolveFrom?: string;
  readonly bunExecutable?: string;
}

export async function resolvePinnedCodexRuntime(
  options: ResolvePinnedCodexRuntimeOptions = {},
): Promise<PinnedCodexRuntime> {
  const packageJsonPath = await locatePackageJson(options);
  const canonicalPackageJson = await realpath(packageJsonPath).catch((error: unknown) => {
    throw new CodexError("RUNTIME_MISMATCH", "the pinned Codex package is unavailable", {
      cause: error,
    });
  });
  const packageRoot = dirname(canonicalPackageJson);
  const text = await Bun.file(canonicalPackageJson).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new CodexError("RUNTIME_MISMATCH", "the Codex package manifest is invalid", {
      cause: error,
    });
  }
  const manifest = record(parsed, "Codex package manifest");
  const name = string(manifest.name, "Codex package name", { min: 1, max: 256 });
  const version = string(manifest.version, "Codex package version", { min: 1, max: 128 });
  if (name !== "@openai/codex" || version !== PINNED_CODEX_VERSION) {
    throw new CodexError(
      "RUNTIME_MISMATCH",
      `Oompa requires @openai/codex ${PINNED_CODEX_VERSION}`,
    );
  }

  const binValue = manifest.bin;
  let relativeBin: string;
  if (typeof binValue === "string") {
    relativeBin = binValue;
  } else {
    relativeBin = string(record(binValue, "Codex package bin").codex, "Codex bin path", {
      min: 1,
      max: 2_048,
    });
  }
  const binPath = resolve(packageRoot, relativeBin);
  const canonicalBin = await realpath(binPath).catch((error: unknown) => {
    throw new CodexError("RUNTIME_MISMATCH", "the pinned Codex launcher is unavailable", {
      cause: error,
    });
  });
  const contained = relative(packageRoot, canonicalBin);
  if (contained.startsWith("..") || isAbsolute(contained)) {
    throw new CodexError("RUNTIME_MISMATCH", "the Codex launcher escapes its package root");
  }
  const stat = await lstat(canonicalBin);
  if (!stat.isFile()) {
    throw new CodexError("RUNTIME_MISMATCH", "the Codex launcher is not a regular file");
  }

  const bunExecutable = options.bunExecutable ?? process.execPath;
  if (!isAbsolute(bunExecutable)) {
    throw new CodexError("RUNTIME_MISMATCH", "the Bun executable path must be absolute");
  }
  return {
    packageRoot,
    packageJsonPath: canonicalPackageJson,
    packageVersion: PINNED_CODEX_VERSION,
    launcherArgv: [
      bunExecutable,
      canonicalBin,
      "app-server",
      "--listen",
      "stdio://",
      "--config",
      'cli_auth_credentials_store="file"',
      "--config",
      'mcp_oauth_credentials_store="file"',
    ],
  };
}

export interface LaunchPinnedCodexOptions
  extends Omit<CodexAppServerClientOptions, "process">,
    ResolvePinnedCodexRuntimeOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly processFactory?: (input: {
    readonly runtime: PinnedCodexRuntime;
    readonly codexHome: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  }) => CodexProcess | Promise<CodexProcess>;
}

type ProcessExitObservation =
  | Readonly<{ state: "exited" }>
  | Readonly<{ error: unknown; state: "rejected" }>
  | Readonly<{ state: "pending" }>;

const cleanupDuration = (value: number | undefined, fallback: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 1 && value <= 30_000
    ? value
    : fallback;

const observeProcessExit = async (
  exited: Promise<unknown>,
  timeoutMs: number,
): Promise<ProcessExitObservation> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProcessExitObservation>((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout({ state: "pending" }), timeoutMs);
  });
  try {
    return await Promise.race([
      exited.then<ProcessExitObservation, ProcessExitObservation>(
        () => ({ state: "exited" }),
        (error: unknown) => ({ error, state: "rejected" }),
      ),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const closeSpawnedCodexProcess = async (
  process: CodexProcess,
  input: Readonly<{
    settlementMs: number;
    termGraceMs: number;
    terminationAlreadyRequested: boolean;
  }>,
): Promise<readonly unknown[]> => {
  const errors: unknown[] = [];
  if (!input.terminationAlreadyRequested) {
    try {
      process.terminate();
    } catch (error: unknown) {
      errors.push(error);
    }
  }

  const custody = async (): Promise<unknown> => await (process.joinCustody === undefined ? process.exited : process.joinCustody());
  const afterTerm = await observeProcessExit(custody(), input.termGraceMs);
  if (afterTerm.state === "exited") return errors;
  if (afterTerm.state === "rejected") {
    errors.push(new Error("Codex process exit observation failed during launch cleanup.", {
      cause: afterTerm.error,
    }));
  }

  try {
    process.forceTerminate();
  } catch (error: unknown) {
    errors.push(error);
  }
  const afterForce = await observeProcessExit(custody(), input.settlementMs);
  if (afterForce.state === "rejected") {
    errors.push(new Error("Codex process exit observation failed after forced launch cleanup.", {
      cause: afterForce.error,
    }));
  } else if (afterForce.state === "pending") {
    errors.push(new Error("Codex process did not exit within the bounded launch cleanup window."));
  }
  return errors;
};

export async function launchPinnedCodexAppServer(
  options: LaunchPinnedCodexOptions,
): Promise<CodexAppServerClient> {
  const runtime = await resolvePinnedCodexRuntime(options);
  const processFactory =
    options.processFactory ??
    ((input: {
      readonly runtime: PinnedCodexRuntime;
      readonly codexHome: string;
      readonly environment?: Readonly<Record<string, string | undefined>>;
    }) =>
      spawnBunCodexProcess({
        argv: input.runtime.launcherArgv,
        codexHome: input.codexHome,
        ...(input.environment === undefined ? {} : { environment: input.environment }),
      }));
  const process = await processFactory({
    runtime,
    codexHome: options.expectedCodexHome,
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  let client: CodexAppServerClient | undefined;
  try {
    client = new CodexAppServerClient({
      process,
      authority: options.authority,
      credentialStorePreflight: options.credentialStorePreflight,
      expectedCodexHome: options.expectedCodexHome,
      isAuthorityCurrent: options.isAuthorityCurrent,
      ...(options.experimentalApi === undefined
        ? {}
        : { experimentalApi: options.experimentalApi }),
      ...(options.onConversationAutomationToolCall === undefined
        ? {}
        : {
            onConversationAutomationToolCall:
              options.onConversationAutomationToolCall,
          }),
      ...(options.onConversationAutomationToolResponseWritten === undefined
        ? {}
        : {
            onConversationAutomationToolResponseWritten:
              options.onConversationAutomationToolResponseWritten,
          }),
      ...(options.onAccountAuthoritySignal === undefined
        ? {}
        : { onAccountAuthoritySignal: options.onAccountAuthoritySignal }),
      ...(options.onFact === undefined ? {} : { onFact: options.onFact }),
      ...(options.onSafeDiagnostic === undefined
        ? {}
        : { onSafeDiagnostic: options.onSafeDiagnostic }),
      ...(options.maxJsonLineBytes === undefined
        ? {}
        : { maxJsonLineBytes: options.maxJsonLineBytes }),
      ...(options.shutdownTermGraceMs === undefined
        ? {}
        : { shutdownTermGraceMs: options.shutdownTermGraceMs }),
      ...(options.shutdownSettlementMs === undefined
        ? {}
        : { shutdownSettlementMs: options.shutdownSettlementMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    await client.initialize();
    return client;
  } catch (error: unknown) {
    const cleanupErrors = await closeSpawnedCodexProcess(process, {
      settlementMs: cleanupDuration(options.shutdownSettlementMs, 1_000),
      termGraceMs: cleanupDuration(options.shutdownTermGraceMs, 2_000),
      terminationAlreadyRequested: client !== undefined,
    });
    if (cleanupErrors.length === 0) throw error;
    throw new AggregateError(
      [error, ...cleanupErrors],
      "Codex app-server launch failed and process cleanup was incomplete.",
      { cause: error },
    );
  }
}

async function locatePackageJson(options: ResolvePinnedCodexRuntimeOptions): Promise<string> {
  if (options.packageJsonPath !== undefined) {
    if (!isAbsolute(options.packageJsonPath)) {
      throw new CodexError("RUNTIME_MISMATCH", "Codex package manifest path must be absolute");
    }
    return options.packageJsonPath;
  }
  const resolveFrom = options.resolveFrom ?? import.meta.dir;
  try {
    return Bun.resolveSync("@openai/codex/package.json", resolveFrom);
  } catch {
    let entry: string;
    try {
      entry = Bun.resolveSync("@openai/codex", resolveFrom);
    } catch (error) {
      throw new CodexError("RUNTIME_MISMATCH", "the pinned Codex package is not installed", {
        cause: error,
      });
    }
    let cursor = dirname(entry);
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(cursor, "package.json");
      if (await Bun.file(candidate).exists()) return candidate;
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    throw new CodexError("RUNTIME_MISMATCH", "could not locate the Codex package manifest");
  }
}

export function codexAuthority(input: Readonly<{
  profileId: string;
  processGeneration: number;
  providerAccountId: string;
  bindingGeneration: number;
}>): CodexAuthority {
  return validateAuthority({
    profileId: input.profileId,
    processGeneration: input.processGeneration,
    provider: "codex",
    providerAccountId: input.providerAccountId,
    bindingGeneration: input.bindingGeneration,
  });
}
