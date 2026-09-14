import { createReadStream } from "node:fs";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { isatty } from "node:tty";

import { z } from "zod";

import {
  isOompaOtpReplyTo,
  oompaOtpReplyToEnvironmentName,
} from "../convex/otpEmailConfig";
import {
  oompaAttentionResendApiKeyEnvironmentName,
  oompaResendApiKeyEnvironmentName,
  requireOompaAttentionResendApiKey,
} from "../convex/resendApiKey";

import {
  type BoundedProcessContainment,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
} from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
} from "./authority-containment";

import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";

export const HOSTED_ENVIRONMENT_NAMES = [
  "SITE_URL",
  "JWT_PRIVATE_KEY",
  "JWKS",
  "OOMPA_AUTH_HMAC_SECRET",
  "OOMPA_RESEND_API_KEY",
  oompaOtpReplyToEnvironmentName,
  oompaAttentionResendApiKeyEnvironmentName,
] as const;

export const OOMPA_SITE_URL = "https://oompa.app" as const;

const protectedInputMaximumBytes = 8 * 1024;
const convexOutputMaximumBytes = 64 * 1024;
const convexTimeoutMs = 60_000;
const commandOutputHardMaximumBytes = 1024 * 1024;
const commandTimeoutHardMaximumMs = 15 * 60 * 1_000;
const commandTerminationGraceMs = 1_000;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
};

const hostedInputSchema = z.object({
  attentionResendApiKey: z.string(),
  authEmailReplyTo: z.string()
    .refine(isOompaOtpReplyTo),
  resendApiKey: z.string()
    .min(8)
    .max(512)
    .regex(/^re_[A-Za-z0-9_-]+$/u),
  siteUrl: z.literal(OOMPA_SITE_URL),
}).strict().superRefine((input, context) => {
  try {
    requireOompaAttentionResendApiKey({
      [oompaAttentionResendApiKeyEnvironmentName]: input.attentionResendApiKey,
      [oompaResendApiKeyEnvironmentName]: input.resendApiKey,
    });
  } catch {
    context.addIssue({ code: "custom", message: "attention_resend_key_invalid" });
  }
});

export type HostedInput = z.infer<typeof hostedInputSchema>;

export type GeneratedHostedSecrets = Readonly<{
  hmacSecret: string;
  jwks: string;
  jwtPrivateKey: string;
}>;

export type CommandRequest = Readonly<{
  arguments: readonly string[];
  containment: BoundedProcessContainment;
  cwd: string;
  environment: Readonly<Record<string, string>>;
  executable: string;
  outputMaximumBytes?: number;
  phase: string;
  stdin: string;
  timeoutMs?: number;
}>;

export type CommandResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;

type HostedSetupFailureCode =
  | "convex_environment_ambiguous"
  | "convex_environment_query_failed"
  | "convex_environment_set_failed"
  | "convex_environment_verification_failed"
  | "convex_target_refused"
  | "input_invalid"
  | "input_not_protected"
  | "process_cleanup_unproven"
  | "input_timed_out"
  | "input_too_large"
  | "target_already_configured"
  | "usage_invalid";

class HostedSetupError extends Error {
  readonly code: HostedSetupFailureCode;

  constructor(code: HostedSetupFailureCode) {
    super(code);
    this.name = "HostedSetupError";
    this.code = code;
  }
}

type HostedArguments = Readonly<{
  inputFd: number;
  target: ConvexTarget;
}>;

const parseInteger = (value: string): number => {
  if (!/^[0-9]+$/u.test(value)) throw new HostedSetupError("usage_invalid");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 3 || parsed > 255) {
    throw new HostedSetupError("usage_invalid");
  }
  return parsed;
};

export function parseHostedArguments(arguments_: readonly string[]): HostedArguments {
  let parsedTarget: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsedTarget = parseConvexTargetArguments(arguments_);
  } catch {
    throw new HostedSetupError("usage_invalid");
  }
  let inputFd = 0;
  for (let index = 0; index < parsedTarget.otherArguments.length; index += 1) {
    const argument = parsedTarget.otherArguments[index];
    if (argument === "--input-fd" && inputFd === 0) {
      const value = parsedTarget.otherArguments[index + 1];
      if (value === undefined) throw new HostedSetupError("usage_invalid");
      inputFd = parseInteger(value);
      index += 1;
      continue;
    }
    throw new HostedSetupError("usage_invalid");
  }
  return { inputFd, target: parsedTarget.target };
}

export function parseHostedInput(document: string): HostedInput {
  if (Buffer.byteLength(document, "utf8") > protectedInputMaximumBytes) {
    throw new HostedSetupError("input_too_large");
  }
  try {
    return hostedInputSchema.parse(JSON.parse(document) as unknown);
  } catch {
    throw new HostedSetupError("input_invalid");
  }
}

const bytesToBase64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

const bytesToBase64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const privateKeyToPem = (key: ArrayBuffer): string => {
  const body = bytesToBase64(new Uint8Array(key)).match(/.{1,64}/gu)?.join("\n");
  if (body === undefined) throw new HostedSetupError("input_invalid");
  const begin = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
  const end = ["-----END", "PRIVATE", "KEY-----"].join(" ");
  return `${begin}\n${body}\n${end}`
    .replace(/\n/gu, " ");
};

export async function generateHostedSecrets(): Promise<GeneratedHostedSecrets> {
  const keys = await crypto.subtle.generateKey(
    {
      hash: "SHA-256",
      modulusLength: 2_048,
      name: "RSASSA-PKCS1-v1_5",
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  );
  const [privateKey, publicKey] = await Promise.all([
    crypto.subtle.exportKey("pkcs8", keys.privateKey),
    crypto.subtle.exportKey("jwk", keys.publicKey),
  ]);
  if (
    publicKey.kty !== "RSA"
    || publicKey.n === undefined
    || publicKey.e === undefined
  ) throw new HostedSetupError("input_invalid");
  const hmacBytes = crypto.getRandomValues(new Uint8Array(32));
  return {
    hmacSecret: bytesToBase64Url(hmacBytes),
    jwks: JSON.stringify({
      keys: [{
        alg: "RS256",
        e: publicKey.e,
        kty: "RSA",
        n: publicKey.n,
        use: "sig",
      }],
    }),
    jwtPrivateKey: privateKeyToPem(privateKey),
  };
}

const dotenvValue = (value: string): string => {
  if (hasControlCharacter(value) || value.includes("'")) {
    throw new HostedSetupError("input_invalid");
  }
  return `'${value}'`;
};

export function serializeHostedEnvironment(
  input: HostedInput,
  generated: GeneratedHostedSecrets,
): string {
  const parsed = parseHostedInput(JSON.stringify(input));
  const hmac = generated.hmacSecret;
  const resend = parsed.resendApiKey;
  const values: Record<(typeof HOSTED_ENVIRONMENT_NAMES)[number], string> = {
    OOMPA_ATTENTION_RESEND_API_KEY: parsed.attentionResendApiKey,
    OOMPA_AUTH_EMAIL_REPLY_TO: parsed.authEmailReplyTo,
    OOMPA_AUTH_HMAC_SECRET: hmac,
    OOMPA_RESEND_API_KEY: resend,
    JWKS: generated.jwks,
    JWT_PRIVATE_KEY: generated.jwtPrivateKey,
    SITE_URL: parsed.siteUrl,
  };
  return `${HOSTED_ENVIRONMENT_NAMES
    .map((name) => `${name}=${dotenvValue(values[name])}`)
    .join("\n")}\n`;
}

const secretValues = (
  input: HostedInput,
  generated: GeneratedHostedSecrets,
): readonly string[] => [
  input.attentionResendApiKey,
  input.resendApiKey,
  generated.hmacSecret,
  generated.jwks,
  generated.jwtPrivateKey,
];

const childEnvironmentNames = [
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "SystemRoot",
  "TMPDIR",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
] as const;

export function buildConvexChildEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  forbiddenValues: readonly string[],
): Readonly<Record<string, string>> {
  const environment: Record<string, string> = {
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const name of childEnvironmentNames) {
    const value = source[name];
    if (
      value !== undefined
      && !forbiddenValues.some((secret) => secret.length > 0 && value.includes(secret))
    ) environment[name] = value;
  }
  return environment;
}

const parseEnvironmentNames = (output: string): ReadonlySet<string> => {
  if (Buffer.byteLength(output, "utf8") > convexOutputMaximumBytes) {
    throw new HostedSetupError("convex_environment_ambiguous");
  }
  const names = new Set<string>();
  for (const line of output.split(/\r?\n/gu)) {
    if (line.length === 0) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(line) || names.has(line)) {
      throw new HostedSetupError("convex_environment_ambiguous");
    }
    names.add(line);
    if (names.size > 1_024) {
      throw new HostedSetupError("convex_environment_ambiguous");
    }
  }
  return names;
};

const listArguments = (deployment: string): readonly string[] => [
  "env",
  "list",
  "--names-only",
  "--deployment",
  deployment,
];

const setArguments = (deployment: string): readonly string[] => [
  "env",
  "set",
  "--deployment",
  deployment,
];

const convexCli = resolve(import.meta.dir, "..", "node_modules", "convex", "bin", "main.js");
const repositoryRoot = resolve(import.meta.dir, "..");

type ConfigureOptions = Readonly<{
  environment?: Readonly<NodeJS.ProcessEnv>;
  generate?: () => Promise<GeneratedHostedSecrets>;
  input: HostedInput;
  runner?: CommandRunner;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function configureHostedSync(options: ConfigureOptions): Promise<void> {
  const target = parseConvexTarget(options.target);
  const input = parseHostedInput(JSON.stringify(options.input));
  const verifyTarget = options.verifyTarget ?? verifyConvexDefaultTarget;
  await verifyTarget(target);
  const generated = await (options.generate ?? generateHostedSecrets)();
  const forbidden = secretValues(input, generated);
  const environment = buildConvexChildEnvironment(
    options.environment ?? process.env,
    forbidden,
  );
  const executable = process.execPath;
  const runner = options.runner ?? runCommand;
  const invoke = async (arguments_: readonly string[], stdin: string): Promise<CommandResult> =>
    await runner({
      arguments: [convexCli, ...arguments_],
      containment: "authority",
      cwd: repositoryRoot,
      environment,
      executable,
      phase: arguments_.includes("set") ? "convex-env-set" : "convex-env-read",
      stdin,
    });
  const invokeMutation = async (
    arguments_: readonly string[],
    stdin: string,
  ): Promise<CommandResult> => {
    let cleanupUnproven = false;
    let authorityUnavailable = false;
    let custodyFailure = false;
    try {
      return await invoke(arguments_, stdin);
    } catch (error: unknown) {
      cleanupUnproven = isBoundedProcessCleanupUnprovenError(error);
      authorityUnavailable = isAuthorityContainmentUnavailable(error);
      custodyFailure = cleanupUnproven || isBoundedProcessRecoveryJournalError(error);
      throw error;
    } finally {
      if (!authorityUnavailable && !custodyFailure) await verifyTarget(target);
    }
  };

  const before = await invoke(listArguments(target.deploymentName), "");
  if (before.exitCode !== 0) {
    throw new HostedSetupError("convex_environment_query_failed");
  }
  const existing = parseEnvironmentNames(before.stdout);
  if (HOSTED_ENVIRONMENT_NAMES.some((name) => existing.has(name))) {
    throw new HostedSetupError("target_already_configured");
  }

  const configured = await invokeMutation(
    setArguments(target.deploymentName),
    serializeHostedEnvironment(input, generated),
  );
  if (configured.exitCode !== 0) {
    throw new HostedSetupError("convex_environment_set_failed");
  }

  const after = await invoke(listArguments(target.deploymentName), "");
  if (after.exitCode !== 0) {
    throw new HostedSetupError("convex_environment_verification_failed");
  }
  const verified = parseEnvironmentNames(after.stdout);
  if (!HOSTED_ENVIRONMENT_NAMES.every((name) => verified.has(name))) {
    throw new HostedSetupError("convex_environment_verification_failed");
  }
  await verifyTarget(target);
}

export const runCommand: CommandRunner = async (request) => {
  const requestedOutputMaximum = request.outputMaximumBytes === undefined
    || !Number.isSafeInteger(request.outputMaximumBytes)
    || request.outputMaximumBytes <= 0
    ? convexOutputMaximumBytes
    : request.outputMaximumBytes;
  const requestedTimeout = request.timeoutMs === undefined
    || !Number.isSafeInteger(request.timeoutMs)
    || request.timeoutMs <= 0
    ? convexTimeoutMs
    : request.timeoutMs;
  // Hosted operations run the official Convex CLI as an ordinary bounded
  // child on any supported operating system. The Linux-only authority
  // supervisor was retired for hosted operations on 2026-09-03: a maintainer
  // deploying from their own machine gains nothing from descendant-lifetime
  // custody, and the requirement made every hosted step impossible on macOS.
  // Output, runtime, and the child environment stay bounded; the provider
  // identity guard and every readback proof are unchanged.
  const outputMaximumBytes = Math.min(requestedOutputMaximum, commandOutputHardMaximumBytes);
  const timeoutMs = Math.min(requestedTimeout, commandTimeoutHardMaximumMs);
  const child = Bun.spawn([request.executable, ...request.arguments], {
    cwd: request.cwd,
    env: request.environment,
    stderr: "pipe",
    stdin: new TextEncoder().encode(request.stdin),
    stdout: "pipe",
  });
  const state = { exceeded: false, timedOut: false };
  const readers = [child.stdout.getReader(), child.stderr.getReader()] as const;
  const cancellations: Promise<void>[] = [];
  let outputStopped = false;
  let commandFailure: Readonly<{ cause: unknown }> | undefined;
  let terminationTimer: ReturnType<typeof setTimeout> | undefined;
  const stopOutput = (): void => {
    if (outputStopped) return;
    outputStopped = true;
    for (const reader of readers) {
      // A descendant can retain its write end after the direct child exits.
      // Released readers may reject cancellation; cleanup must not replace
      // the timeout, overflow or read failure that already stopped output.
      cancellations.push(reader.cancel().catch(() => undefined));
    }
  };
  const signalChild = (signal: "SIGKILL" | "SIGTERM"): void => {
    if (child.exitCode !== null) return;
    try {
      child.kill(signal);
    } catch (cause: unknown) {
      commandFailure ??= { cause };
    }
  };
  const failCommand = (cause: unknown): void => {
    if (outputStopped) return;
    commandFailure = { cause };
    stopOutput();
    signalChild("SIGKILL");
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    stopOutput();
    signalChild("SIGTERM");
    if (child.exitCode === null) {
      terminationTimer = setTimeout(() => {
        signalChild("SIGKILL");
      }, commandTerminationGraceMs);
      terminationTimer.unref();
    }
  }, timeoutMs);
  // Cancel both readers on failure, not just the overflowing stream. This
  // bounds pipe waiting without claiming custody over descendants. Preserve
  // per-stream byte limits and timeout-before-overflow exit-code precedence.
  const collect = async (
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ): Promise<Buffer> => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || outputStopped) break;
        if (total + value.byteLength > outputMaximumBytes) {
          chunks.push(value.subarray(0, outputMaximumBytes - total));
          state.exceeded = true;
          stopOutput();
          signalChild("SIGKILL");
          break;
        }
        total += value.byteLength;
        chunks.push(value);
      }
    } catch (cause: unknown) {
      failCommand(cause);
    } finally {
      try {
        reader.releaseLock();
      } catch (cause: unknown) {
        failCommand(cause);
      }
    }
    return Buffer.concat(chunks);
  };
  const rejectCommand = (cause: unknown): never => {
    failCommand(cause);
    throw cause;
  };
  try {
    const [stdout, stderr, exitCode] = await Promise.allSettled([
      collect(readers[0]).catch(rejectCommand),
      collect(readers[1]).catch(rejectCommand),
      child.exited.catch(rejectCommand),
    ]);
    await Promise.all(cancellations);
    if (commandFailure !== undefined) throw commandFailure.cause;
    if (stdout.status === "rejected") throw stdout.reason;
    if (stderr.status === "rejected") throw stderr.reason;
    if (exitCode.status === "rejected") throw exitCode.reason;
    return {
      exitCode: state.timedOut ? 124 : state.exceeded ? 1 : exitCode.value,
      stderr: stderr.value.toString("utf8"),
      stdout: stdout.value.toString("utf8"),
    };
  } finally {
    clearTimeout(timer);
    if (terminationTimer !== undefined) clearTimeout(terminationTimer);
  }
};

export async function readProtectedInput(
  fd: number,
  timeoutMs = 15_000,
  dependencies: Readonly<{
    createStream?: (descriptor: number) => Pick<Readable, "destroy" | "on" | "once">;
    isTerminal?: (descriptor: number) => boolean;
  }> = {},
): Promise<string> {
  if ((dependencies.isTerminal ?? isatty)(fd)) {
    throw new HostedSetupError("input_not_protected");
  }
  return await new Promise<string>((resolvePromise, reject) => {
    const stream = dependencies.createStream?.(fd)
      ?? createReadStream("", { autoClose: fd !== 0, fd });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let finished = false;
    const finish = (error?: HostedSetupError): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error === undefined) resolvePromise(Buffer.concat(chunks).toString("utf8"));
      else reject(error);
    };
    const timer = setTimeout(() => {
      stream.destroy();
      finish(new HostedSetupError("input_timed_out"));
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > protectedInputMaximumBytes) {
        stream.destroy();
        finish(new HostedSetupError("input_too_large"));
      } else chunks.push(chunk);
    });
    stream.once("error", () => finish(new HostedSetupError("input_invalid")));
    stream.once("end", () => finish());
  });
}

type ExecuteOptions = Readonly<{
  arguments: readonly string[];
  environment?: Readonly<NodeJS.ProcessEnv>;
  generate?: () => Promise<GeneratedHostedSecrets>;
  inputDocument: string;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedSetup(options: ExecuteOptions): Promise<number> {
  try {
    const arguments_ = parseHostedArguments(options.arguments);
    const input = parseHostedInput(options.inputDocument);
    await configureHostedSync({
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.generate === undefined ? {} : { generate: options.generate }),
      input,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      target: arguments_.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(
      `Configured ${String(HOSTED_ENVIRONMENT_NAMES.length)} fresh hosted variables.\n`,
    );
    return 0;
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      options.stderr.write(authorityUnavailable);
      return 1;
    }
    if (isBoundedProcessCleanupUnprovenError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_cleanup_unproven",
        phase: error.phase,
        processGroupId: error.processGroupId,
        processes: error.processes,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    if (isBoundedProcessRecoveryJournalError(error)) {
      options.stderr.write(`${JSON.stringify({
        code: "process_recovery_journal_blocked",
        reason: error.reason,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
      return 75;
    }
    const code = error instanceof HostedSetupError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "input_invalid";
    options.stderr.write(`Hosted setup refused (${code}).\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  try {
    const parsedArguments = parseHostedArguments(process.argv.slice(2));
    await recoverBoundedProcessJournal();
    const inputDocument = await readProtectedInput(parsedArguments.inputFd);
    exitCode = await executeHostedSetup({
      arguments: process.argv.slice(2),
      inputDocument,
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } catch (error: unknown) {
    const authorityUnavailable = renderAuthorityContainmentUnavailable(error);
    if (authorityUnavailable !== undefined) {
      process.stderr.write(authorityUnavailable);
      exitCode = 1;
    } else if (isBoundedProcessCleanupUnprovenError(error)) {
      process.stderr.write(`${JSON.stringify({
        code: "process_cleanup_unproven",
        phase: error.phase,
        processGroupId: error.processGroupId,
        processes: error.processes,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
    } else if (isBoundedProcessRecoveryJournalError(error)) {
      process.stderr.write(`${JSON.stringify({
        code: "process_recovery_journal_blocked",
        reason: error.reason,
        recoveryPaths: error.recoveryPaths,
        schemaVersion: 1,
        status: "recovery_required",
      })}\n`);
    } else {
      const code = error instanceof HostedSetupError
        ? error.code
        : error instanceof ConvexTargetError
          ? "convex_target_refused"
          : "input_invalid";
      process.stderr.write(`Hosted setup refused (${code}).\n`);
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}
