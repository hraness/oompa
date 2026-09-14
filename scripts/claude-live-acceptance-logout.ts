import { lstat, mkdir, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { z } from "zod";

import {
  allowlistedEnvironment,
  CLAUDE_PIN,
  parseClaudeAuthStatus,
  resolvePinnedClaudeRuntime,
  type PinnedClaudeRuntime,
  type ResolvePinnedClaudeRuntimeOptions,
} from "../src/claude/index";
import { profileIdSchema, type ProfileId } from "../src/domain/values";
import { profilePaths } from "../src/storage/paths";
import { OOMPA_VERSION } from "../src/version";
import { isBoundedProcessCleanupUnprovenError } from "./bounded-process";
import { parseClaudeAuthLogoutHelp } from "./claude-auth-help";
import type { CommandRunner } from "./configure-hosted-sync";
import {
  parseClaudeLiveAcceptancePrivateReceipt,
  type ClaudeLiveAcceptancePrivateReceipt,
} from "./claude-live-acceptance-proof";
import {
  acceptanceInstallationDescriptorSchema,
  createAcceptanceInstallation,
  type AcceptanceInstallationDescriptor,
} from "./live-acceptance-installation";
import { runLiveAcceptanceAuthorityCommand } from "./live-acceptance-authority-process";
import { canonicalDigest } from "./release-evidence";

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const positiveIntegerSchema = z.number().int().positive().safe();
const normalizedAbsolutePathSchema = z.string().min(1).max(4_096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const stoppedOracleSchema = z.object({
  version: z.literal(1),
  phase: z.literal("stopped"),
  source: z.literal("independent_private_readback"),
  snapshotDigest: digestSchema,
  nativeStart: z.literal(true),
  directSend: z.literal(true),
  soleRemember: z.literal(true),
  workingPage: z.literal(true),
  managedClaudeSignedIn: z.literal(true),
  processBound: z.literal(true),
  hostBinding: z.literal(true),
  pinnedProcessArgv: z.literal(true),
  processArgvDigest: digestSchema,
  proofBindingDigest: digestSchema,
  processReleased: z.literal(true),
  processNotLive: z.literal(true),
  privateArtifactsAbsent: z.literal(true),
  lifecycleInvalidated: z.literal(true),
}).strict();

export type ClaudeLiveAcceptanceStoppedOracle = z.infer<typeof stoppedOracleSchema>;

const directoryIdentitySchema = z.object({
  device: z.number().int().nonnegative().safe(),
  inode: z.number().int().positive().safe(),
  mode: z.literal(0o700),
  owner: z.number().int().nonnegative().safe(),
  path: normalizedAbsolutePathSchema,
}).strict();

const preflightReceiptBaseSchema = z.object({
  version: z.literal(1),
  phase: z.literal("preflight_complete"),
  candidate: z.object({
    cloudTargetDigest: digestSchema,
    packageVersion: z.literal(OOMPA_VERSION),
    sourceRevision: z.string().regex(/^[0-9a-f]{40}$/u),
  }).strict(),
  runId: z.string().uuid(),
  profileId: profileIdSchema,
  configDirectory: directoryIdentitySchema,
  temporaryDirectory: directoryIdentitySchema,
  helpSha256: digestSchema,
  runtimeVersion: z.literal(CLAUDE_PIN),
}).strict();

const preflightReceiptSchema = z.object({
  ...preflightReceiptBaseSchema.shape,
  bindingDigest: digestSchema,
}).strict();

export type ClaudeLiveAcceptanceLogoutPreflightReceipt = Readonly<
  z.infer<typeof preflightReceiptSchema>
>;

const attemptMarkerSchema = z.object({
  version: z.literal(1),
  phase: z.literal("logout_attempted"),
  preflightBindingDigest: digestSchema,
  markerDigest: digestSchema,
}).strict();

export type ClaudeLiveAcceptanceLogoutAttemptMarker = Readonly<
  z.infer<typeof attemptMarkerSchema>
>;

const cleanupStoppedCustodyBaseSchema = z.object({
  version: z.literal(1),
  phase: z.literal("stopped"),
  source: z.literal("worker_shutdown_private"),
  candidateBindingDigest: digestSchema,
  runId: z.string().uuid(),
  profileId: profileIdSchema,
  preflightBindingDigest: digestSchema,
  workerPid: positiveIntegerSchema,
  daemonJoined: z.literal(true),
  workerNotLive: z.literal(true),
  daemonAuthorityReleased: z.literal(true),
  daemonPrivateArtifactsAbsent: z.literal(true),
  retainedSessionProcess: z.enum(["absent", "released_not_live"]),
  unreleasedProcessesAbsent: z.literal(true),
}).strict();

const cleanupStoppedCustodySchema = z.object({
  ...cleanupStoppedCustodyBaseSchema.shape,
  privateCustodyDigest: digestSchema,
}).strict();

export type ClaudeLiveAcceptanceCleanupStoppedCustody = Readonly<
  z.infer<typeof cleanupStoppedCustodySchema>
>;

export type ClaudeLiveAcceptanceLogoutEvidence = Readonly<{
  helpSha256: string;
  logoutDispatched: boolean;
  recovered: boolean;
  signedOut: true;
  version: typeof CLAUDE_PIN;
}>;

export type ClaudeLiveAcceptanceLogoutCleanupEvidence = Readonly<{
  logoutDispatched: boolean;
  preflightBindingDigest: string;
  recovered: boolean;
  signedOut: true;
  source: "cleanup_only";
  version: typeof CLAUDE_PIN;
}>;

export type ClaudeLiveAcceptanceLogoutFailureCode =
  | "aborted"
  | "authority_changed"
  | "capability_refused"
  | "concurrent_operation"
  | "directory_refused"
  | "logout_failed"
  | "preflight_required"
  | "recovery_required"
  | "scope_refused"
  | "status_refused";

export class ClaudeLiveAcceptanceLogoutError extends Error {
  constructor(readonly code: ClaudeLiveAcceptanceLogoutFailureCode) {
    super(`claude_live_acceptance_logout_${code}`);
    this.name = "ClaudeLiveAcceptanceLogoutError";
  }
}

type DirectoryIdentity = Readonly<{
  device: number;
  inode: number;
  mode: 0o700;
  owner: number;
  path: string;
}>;

type Phase =
  | "new"
  | "preflighting"
  | "ready"
  | "logging_out"
  | "recovery_required"
  | "complete"
  | "closed"
  | "failed";

type RuntimeResolver = (
  options: ResolvePinnedClaudeRuntimeOptions,
) => Promise<PinnedClaudeRuntime>;

const preflightBindingDigest = (
  input: z.infer<typeof preflightReceiptBaseSchema>,
): string => canonicalDigest({
  ...input,
  domain: "hra-live-acceptance-claude-logout-preflight-v1",
});

export const parseClaudeLiveAcceptanceLogoutPreflightReceipt = (
  value: unknown,
): ClaudeLiveAcceptanceLogoutPreflightReceipt => {
  const receipt = preflightReceiptSchema.parse(value);
  const { bindingDigest, ...baseInput } = receipt;
  if (preflightBindingDigest(preflightReceiptBaseSchema.parse(baseInput)) !== bindingDigest) {
    throw new ClaudeLiveAcceptanceLogoutError("scope_refused");
  }
  return Object.freeze({
    ...receipt,
    candidate: Object.freeze({ ...receipt.candidate }),
    configDirectory: Object.freeze({ ...receipt.configDirectory }),
    temporaryDirectory: Object.freeze({ ...receipt.temporaryDirectory }),
  });
};

const makeAttemptMarker = (
  receipt: Readonly<{ bindingDigest: string }>,
): ClaudeLiveAcceptanceLogoutAttemptMarker => {
  const base = {
    phase: "logout_attempted" as const,
    preflightBindingDigest: receipt.bindingDigest,
    version: 1 as const,
  };
  return Object.freeze({
    ...base,
    markerDigest: canonicalDigest({
      ...base,
      domain: "hra-live-acceptance-claude-logout-attempt-v1",
    }),
  });
};

export const parseClaudeLiveAcceptanceLogoutAttemptMarker = (
  value: unknown,
): ClaudeLiveAcceptanceLogoutAttemptMarker => {
  const marker = attemptMarkerSchema.parse(value);
  const expected = makeAttemptMarker({ bindingDigest: marker.preflightBindingDigest });
  if (marker.markerDigest !== expected.markerDigest) {
    throw new ClaudeLiveAcceptanceLogoutError("scope_refused");
  }
  return Object.freeze({ ...marker });
};

export const parseClaudeLiveAcceptanceCleanupStoppedCustody = (
  value: unknown,
): ClaudeLiveAcceptanceCleanupStoppedCustody => {
  const custody = cleanupStoppedCustodySchema.parse(value);
  const { privateCustodyDigest, ...baseInput } = custody;
  const base = cleanupStoppedCustodyBaseSchema.parse(baseInput);
  if (canonicalDigest({
    ...base,
    domain: "hra-live-acceptance-claude-logout-stopped-custody-v1",
  }) !== privateCustodyDigest) {
    throw new ClaudeLiveAcceptanceLogoutError("scope_refused");
  }
  return Object.freeze({ ...custody });
};

export const createClaudeLiveAcceptanceCleanupStoppedCustody = (
  value: z.input<typeof cleanupStoppedCustodyBaseSchema>,
): ClaudeLiveAcceptanceCleanupStoppedCustody => {
  const base = cleanupStoppedCustodyBaseSchema.parse(value);
  return parseClaudeLiveAcceptanceCleanupStoppedCustody({
    ...base,
    privateCustodyDigest: canonicalDigest({
      ...base,
      domain: "hra-live-acceptance-claude-logout-stopped-custody-v1",
    }),
  });
};

const requireSignal = (signal: AbortSignal): void => {
  if (signal.aborted) throw new ClaudeLiveAcceptanceLogoutError("aborted");
};

const inspectPrivateDirectory = async (
  path: string,
  expected?: DirectoryIdentity,
): Promise<DirectoryIdentity> => {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new ClaudeLiveAcceptanceLogoutError("directory_refused");
  }
  const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
  const owner = process.getuid?.();
  if (
    owner === undefined
    || !Number.isSafeInteger(owner)
    || owner < 0
    ||
    canonical !== path
    || !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.nlink < 1
    || (metadata.mode & 0o777) !== 0o700
    || metadata.uid !== owner
    || (expected !== undefined && (
      metadata.dev !== expected.device
      || metadata.ino !== expected.inode
      || metadata.uid !== expected.owner
      || path !== expected.path
    ))
  ) throw new ClaudeLiveAcceptanceLogoutError("directory_refused");
  return Object.freeze({
    device: metadata.dev,
    inode: metadata.ino,
    mode: 0o700,
    owner: metadata.uid,
    path,
  });
};

const requireEmptyDirectory = async (identity: DirectoryIdentity): Promise<void> => {
  await inspectPrivateDirectory(identity.path, identity);
  const directory = await opendir(identity.path);
  try {
    if (await directory.read() !== null) {
      throw new ClaudeLiveAcceptanceLogoutError("directory_refused");
    }
  } finally {
    await directory.close();
  }
  await inspectPrivateDirectory(identity.path, identity);
};

const parseLogoutHelp = (input: Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>): string => {
  try { return parseClaudeAuthLogoutHelp({ exitCode: input.exitCode, stderr: input.stderr, stdout: input.stdout }); }
  catch { throw new ClaudeLiveAcceptanceLogoutError("capability_refused"); }
};

const parseStatus = (input: Readonly<{
  configDir: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}>): Readonly<{ signedIn: boolean }> => {
  if (input.stderr !== "" || input.stdout.length > 16 * 1024) {
    throw new ClaudeLiveAcceptanceLogoutError("status_refused");
  }
  try {
    return parseClaudeAuthStatus({
      configDir: input.configDir,
      exitCode: input.exitCode,
      stdout: new TextEncoder().encode(input.stdout),
    });
  } catch {
    throw new ClaudeLiveAcceptanceLogoutError("status_refused");
  }
};

const stoppedOracle = (value: unknown): ClaudeLiveAcceptanceStoppedOracle =>
  stoppedOracleSchema.parse(value);

export interface ClaudeLiveAcceptanceLogoutController {
  preflightBeforeLogin(signal: AbortSignal): Promise<Readonly<{
    helpSha256: string;
    receipt: ClaudeLiveAcceptanceLogoutPreflightReceipt;
    version: typeof CLAUDE_PIN;
  }>>;
  logoutAfterStoppedOracle(input: Readonly<{
    receipt: ClaudeLiveAcceptancePrivateReceipt;
    signal: AbortSignal;
    stoppedOracle: ClaudeLiveAcceptanceStoppedOracle;
  }>): Promise<ClaudeLiveAcceptanceLogoutEvidence>;
  recoverUncertainLogout(input: Readonly<{
    cleanupRecovered: true;
    receipt: ClaudeLiveAcceptancePrivateReceipt;
    signal: AbortSignal;
    stoppedOracle: ClaudeLiveAcceptanceStoppedOracle;
  }>): Promise<ClaudeLiveAcceptanceLogoutEvidence>;
  resumeCleanupAfterStoppedCustody(input: Readonly<{
    attemptMarker?: ClaudeLiveAcceptanceLogoutAttemptMarker;
    preflightReceipt: ClaudeLiveAcceptanceLogoutPreflightReceipt;
    signal: AbortSignal;
    stoppedCustody: ClaudeLiveAcceptanceCleanupStoppedCustody;
  }>): Promise<ClaudeLiveAcceptanceLogoutCleanupEvidence>;
  close(): void;
}

/** Acceptance-only, one-shot native logout with no personal-profile fallback. */
export function createClaudeLiveAcceptanceLogout(options: Readonly<{
  descriptor: AcceptanceInstallationDescriptor;
  environment?: Readonly<Record<string, string | undefined>>;
  profileId: ProfileId;
  persistAttempt: (
    marker: ClaudeLiveAcceptanceLogoutAttemptMarker,
  ) => Promise<void>;
  resolveRuntime?: RuntimeResolver;
  run?: CommandRunner;
}>): ClaudeLiveAcceptanceLogoutController {
  const descriptor = acceptanceInstallationDescriptorSchema.parse(options.descriptor);
  const profileId = profileIdSchema.parse(options.profileId);
  const candidate = descriptor.candidate;
  if (candidate === undefined || candidate.packageVersion !== OOMPA_VERSION) {
    throw new ClaudeLiveAcceptanceLogoutError("scope_refused");
  }
  const paths = createAcceptanceInstallation(descriptor).paths;
  const profile = profilePaths(paths, profileId);
  const configDir = profile.claudeConfigDir;
  const temporaryDirectory = join(profile.root, "claude-logout-tmp");
  const environment = options.environment ?? process.env;
  if (environment.HOME !== descriptor.expectedHomeDirectory) {
    throw new ClaudeLiveAcceptanceLogoutError("scope_refused");
  }
  const childEnvironment = allowlistedEnvironment(environment);
  childEnvironment.HOME = descriptor.expectedHomeDirectory;
  childEnvironment.LANG = "C";
  childEnvironment.LC_ALL = "C";
  childEnvironment.CLAUDE_CONFIG_DIR = configDir;
  childEnvironment.TMPDIR = temporaryDirectory;
  childEnvironment.NO_COLOR = "1";
  const run = options.run ?? runLiveAcceptanceAuthorityCommand;
  const resolveRuntime = options.resolveRuntime ?? resolvePinnedClaudeRuntime;
  const persistAttempt = options.persistAttempt;
  let phase: Phase = "new";
  let lifecycleClosed = false;
  let epoch = 0;
  let configIdentity: DirectoryIdentity | null = null;
  let temporaryIdentity: DirectoryIdentity | null = null;
  let runtime: PinnedClaudeRuntime | null = null;
  let helpSha256: string | null = null;
  let preflightReceipt: ClaudeLiveAcceptanceLogoutPreflightReceipt | null = null;
  let attemptMarker: ClaudeLiveAcceptanceLogoutAttemptMarker | null = null;
  let proofBindingDigest: string | null = null;
  let failure: ClaudeLiveAcceptanceLogoutError | null = null;

  const fail = (code: ClaudeLiveAcceptanceLogoutFailureCode): never => {
    failure ??= new ClaudeLiveAcceptanceLogoutError(code);
    phase = lifecycleClosed
      ? "closed"
      : code === "recovery_required" ? "recovery_required" : "failed";
    epoch += 1;
    throw failure;
  };
  const requireCurrent = (token: number, expected: Phase, signal: AbortSignal): void => {
    requireSignal(signal);
    if (failure !== null || epoch !== token || phase !== expected) {
      throw failure ?? new ClaudeLiveAcceptanceLogoutError("authority_changed");
    }
  };
  const identities = (): readonly [DirectoryIdentity, DirectoryIdentity] => {
    if (configIdentity === null || temporaryIdentity === null) {
      throw new ClaudeLiveAcceptanceLogoutError("preflight_required");
    }
    return [configIdentity, temporaryIdentity];
  };
  const runCommand = async (
    arguments_: readonly string[],
    phaseName: string,
    admit: () => void,
    executable = runtime?.executablePath,
  ) => {
    if (executable === undefined || !isAbsolute(executable)) {
      throw new ClaudeLiveAcceptanceLogoutError("capability_refused");
    }
    const [config, temporary] = identities();
    await inspectPrivateDirectory(config.path, config);
    await inspectPrivateDirectory(temporary.path, temporary);
    try {
      // This is the effect's linearization point. No filesystem await may sit
      // between the lifecycle check and the synchronous runner admission.
      admit();
      const result = await run({
        arguments: arguments_,
        containment: "authority",
        cwd: config.path,
        environment: childEnvironment,
        executable,
        outputMaximumBytes: 16 * 1024,
        phase: phaseName,
        stdin: "",
        timeoutMs: 5_000,
      });
      await inspectPrivateDirectory(config.path, config);
      await inspectPrivateDirectory(temporary.path, temporary);
      return result;
    } catch (error: unknown) {
      if (isBoundedProcessCleanupUnprovenError(error)) {
        await Promise.allSettled([
          inspectPrivateDirectory(config.path, config),
          inspectPrivateDirectory(temporary.path, temporary),
        ]);
        throw error;
      }
      await inspectPrivateDirectory(config.path, config);
      await inspectPrivateDirectory(temporary.path, temporary);
      throw error;
    }
  };
  const status = async (
    admit: () => void,
  ): Promise<Readonly<{ signedIn: boolean }>> => {
    if (runtime === null) throw new ClaudeLiveAcceptanceLogoutError("preflight_required");
    const result = await runCommand(
      ["auth", "status", "--json"],
      "claude-live-acceptance-auth-status",
      admit,
    );
    return parseStatus({ configDir, ...result });
  };
  const validateReceipt = (
    receiptInput: ClaudeLiveAcceptancePrivateReceipt,
    oracleInput: ClaudeLiveAcceptanceStoppedOracle,
  ): ClaudeLiveAcceptancePrivateReceipt => {
    const receipt = parseClaudeLiveAcceptancePrivateReceipt(receiptInput);
    const oracle = stoppedOracle(oracleInput);
    if (
      receipt.candidate.packageVersion !== candidate.packageVersion
      || canonicalDigest(receipt.candidate) !== canonicalDigest(candidate)
      || receipt.runId !== descriptor.runId
      || receipt.profileId !== profileId
      || oracle.proofBindingDigest !== receipt.candidateBindingDigest
    ) throw new ClaudeLiveAcceptanceLogoutError("scope_refused");
    return receipt;
  };
  const validatePreflightReceipt = async (
    value: ClaudeLiveAcceptanceLogoutPreflightReceipt,
  ): Promise<ClaudeLiveAcceptanceLogoutPreflightReceipt> => {
    const receipt = parseClaudeLiveAcceptanceLogoutPreflightReceipt(value);
    if (
      canonicalDigest(receipt.candidate) !== canonicalDigest(candidate)
      || receipt.runId !== descriptor.runId
      || receipt.profileId !== profileId
      || receipt.configDirectory.path !== configDir
      || receipt.temporaryDirectory.path !== temporaryDirectory
    ) throw new ClaudeLiveAcceptanceLogoutError("scope_refused");
    configIdentity = await inspectPrivateDirectory(configDir, receipt.configDirectory);
    temporaryIdentity = await inspectPrivateDirectory(
      temporaryDirectory,
      receipt.temporaryDirectory,
    );
    return receipt;
  };
  const persistAttemptBeforeEffect = async (
    token: number,
    signal: AbortSignal,
  ): Promise<ClaudeLiveAcceptanceLogoutAttemptMarker> => {
    if (preflightReceipt === null || attemptMarker !== null) {
      return fail("authority_changed");
    }
    const marker = makeAttemptMarker(preflightReceipt);
    await persistAttempt(marker);
    requireCurrent(token, "logging_out", signal);
    attemptMarker = marker;
    return marker;
  };
  const uncertain = (error: unknown): never => {
    if (isBoundedProcessCleanupUnprovenError(error)) {
      failure = new ClaudeLiveAcceptanceLogoutError("recovery_required");
      phase = lifecycleClosed ? "closed" : "recovery_required";
      epoch += 1;
      throw error;
    }
    if (error instanceof ClaudeLiveAcceptanceLogoutError) {
      failure ??= error;
      phase = lifecycleClosed ? "closed" : "failed";
      epoch += 1;
      throw failure;
    }
    return fail("logout_failed");
  };
  const complete = (input: Readonly<{
    logoutDispatched: boolean;
    recovered: boolean;
  }>): ClaudeLiveAcceptanceLogoutEvidence => {
    if (helpSha256 === null) return fail("preflight_required");
    phase = "complete";
    return Object.freeze({
      helpSha256,
      logoutDispatched: input.logoutDispatched,
      recovered: input.recovered,
      signedOut: true,
      version: CLAUDE_PIN,
    });
  };
  const completeCleanup = (input: Readonly<{
    logoutDispatched: boolean;
    recovered: boolean;
  }>): ClaudeLiveAcceptanceLogoutCleanupEvidence => {
    if (preflightReceipt === null) return fail("preflight_required");
    phase = "complete";
    return Object.freeze({
      logoutDispatched: input.logoutDispatched,
      preflightBindingDigest: preflightReceipt.bindingDigest,
      recovered: input.recovered,
      signedOut: true,
      source: "cleanup_only",
      version: CLAUDE_PIN,
    });
  };

  const controller: ClaudeLiveAcceptanceLogoutController = {
    async preflightBeforeLogin(signal: AbortSignal) {
      if (phase !== "new") return fail("concurrent_operation");
      phase = "preflighting";
      const token = ++epoch;
      try {
        requireSignal(signal);
        configIdentity = await inspectPrivateDirectory(configDir);
        requireCurrent(token, "preflighting", signal);
        await requireEmptyDirectory(configIdentity);
        requireCurrent(token, "preflighting", signal);
        await mkdir(temporaryDirectory, { mode: 0o700 }).catch(() => {
          throw new ClaudeLiveAcceptanceLogoutError("directory_refused");
        });
        temporaryIdentity = await inspectPrivateDirectory(temporaryDirectory);
        requireCurrent(token, "preflighting", signal);
        await requireEmptyDirectory(temporaryIdentity);
        requireCurrent(token, "preflighting", signal);
        runtime = await resolveRuntime({
          configDir,
          environment: childEnvironment,
          probeVersion: async (input) => {
            const result = await runCommand(
              ["--version"],
              "claude-live-acceptance-version",
              () => requireCurrent(token, "preflighting", signal),
              input.executablePath,
            );
            if (result.exitCode !== 0 || result.stderr !== "") {
              throw new ClaudeLiveAcceptanceLogoutError("capability_refused");
            }
            return result.stdout;
          },
          signal,
          versionProbeDeadlineMs: 5_000,
        });
        requireCurrent(token, "preflighting", signal);
        const help = await runCommand(
          ["auth", "logout", "--help"],
          "claude-live-acceptance-logout-help",
          () => requireCurrent(token, "preflighting", signal),
        );
        requireCurrent(token, "preflighting", signal);
        helpSha256 = parseLogoutHelp(help);
        const authentication = await status(
          () => requireCurrent(token, "preflighting", signal),
        );
        requireCurrent(token, "preflighting", signal);
        if (authentication.signedIn) return fail("scope_refused");
        await requireEmptyDirectory(configIdentity);
        requireCurrent(token, "preflighting", signal);
        await requireEmptyDirectory(temporaryIdentity);
        requireCurrent(token, "preflighting", signal);
        const receiptBase = preflightReceiptBaseSchema.parse({
          candidate,
          configDirectory: configIdentity,
          helpSha256,
          phase: "preflight_complete",
          profileId,
          runId: descriptor.runId,
          runtimeVersion: CLAUDE_PIN,
          temporaryDirectory: temporaryIdentity,
          version: 1,
        });
        preflightReceipt = parseClaudeLiveAcceptanceLogoutPreflightReceipt({
          ...receiptBase,
          bindingDigest: preflightBindingDigest(receiptBase),
        });
        phase = "ready";
        return Object.freeze({ helpSha256, receipt: preflightReceipt, version: CLAUDE_PIN });
      } catch (error: unknown) {
        if (isBoundedProcessCleanupUnprovenError(error)) {
          failure = new ClaudeLiveAcceptanceLogoutError("recovery_required");
          phase = lifecycleClosed ? "closed" : "recovery_required";
          epoch += 1;
          throw error;
        }
        if (error instanceof ClaudeLiveAcceptanceLogoutError) {
          if (failure !== null) throw failure;
          failure = error;
          phase = lifecycleClosed ? "closed" : "failed";
          epoch += 1;
          throw error;
        }
        return fail("capability_refused");
      }
    },
    async logoutAfterStoppedOracle(input) {
      if (phase === "recovery_required") {
        throw failure ?? new ClaudeLiveAcceptanceLogoutError("recovery_required");
      }
      if (phase !== "ready") return fail("preflight_required");
      phase = "logging_out";
      const token = ++epoch;
      try {
        requireCurrent(token, "logging_out", input.signal);
        const receipt = validateReceipt(input.receipt, input.stoppedOracle);
        proofBindingDigest = receipt.candidateBindingDigest;
        const before = await status(
          () => requireCurrent(token, "logging_out", input.signal),
        );
        requireCurrent(token, "logging_out", input.signal);
        if (!before.signedIn) return complete({ logoutDispatched: false, recovered: false });
        if (proofBindingDigest !== receipt.candidateBindingDigest) return fail("authority_changed");
        await persistAttemptBeforeEffect(token, input.signal);
        const result = await runCommand(
          ["auth", "logout"],
          "claude-live-acceptance-logout",
          () => requireCurrent(token, "logging_out", input.signal),
        );
        requireCurrent(token, "logging_out", input.signal);
        if (result.exitCode !== 0) return fail("logout_failed");
        const after = await status(
          () => requireCurrent(token, "logging_out", input.signal),
        );
        requireCurrent(token, "logging_out", input.signal);
        if (after.signedIn) return fail("logout_failed");
        return complete({ logoutDispatched: true, recovered: false });
      } catch (error: unknown) {
        return uncertain(error);
      }
    },
    async recoverUncertainLogout(input) {
      if (
        !z.object({ cleanupRecovered: z.literal(true) }).passthrough().safeParse(input).success
        ||
        phase !== "recovery_required"
        || runtime === null
        || preflightReceipt === null
        || attemptMarker === null
        || proofBindingDigest === null
      ) {
        return fail("recovery_required");
      }
      failure = null;
      phase = "logging_out";
      const token = ++epoch;
      try {
        requireCurrent(token, "logging_out", input.signal);
        const receipt = validateReceipt(input.receipt, input.stoppedOracle);
        if (proofBindingDigest !== receipt.candidateBindingDigest) {
          return fail("authority_changed");
        }
        const authentication = await status(
          () => requireCurrent(token, "logging_out", input.signal),
        );
        requireCurrent(token, "logging_out", input.signal);
        if (authentication.signedIn) return fail("recovery_required");
        return complete({ logoutDispatched: false, recovered: true });
      } catch (error: unknown) {
        return uncertain(error);
      }
    },
    async resumeCleanupAfterStoppedCustody(input) {
      if (phase !== "new") return fail("concurrent_operation");
      phase = "preflighting";
      const token = ++epoch;
      try {
        requireCurrent(token, "preflighting", input.signal);
        preflightReceipt = await validatePreflightReceipt(input.preflightReceipt);
        requireCurrent(token, "preflighting", input.signal);
        const custody = parseClaudeLiveAcceptanceCleanupStoppedCustody(input.stoppedCustody);
        if (
          custody.candidateBindingDigest !== canonicalDigest(candidate)
          || custody.runId !== descriptor.runId
          || custody.profileId !== profileId
          || custody.preflightBindingDigest !== preflightReceipt.bindingDigest
        ) return fail("scope_refused");
        if (input.attemptMarker !== undefined) {
          attemptMarker = parseClaudeLiveAcceptanceLogoutAttemptMarker(input.attemptMarker);
          if (attemptMarker.preflightBindingDigest !== preflightReceipt.bindingDigest) {
            return fail("scope_refused");
          }
        }
        runtime = await resolveRuntime({
          configDir,
          environment: childEnvironment,
          probeVersion: async (versionInput) => {
            const result = await runCommand(
              ["--version"],
              "claude-live-acceptance-version",
              () => requireCurrent(token, "preflighting", input.signal),
              versionInput.executablePath,
            );
            if (result.exitCode !== 0 || result.stderr !== "") {
              throw new ClaudeLiveAcceptanceLogoutError("capability_refused");
            }
            return result.stdout;
          },
          signal: input.signal,
          versionProbeDeadlineMs: 5_000,
        });
        requireCurrent(token, "preflighting", input.signal);
        const help = await runCommand(
          ["auth", "logout", "--help"],
          "claude-live-acceptance-logout-help",
          () => requireCurrent(token, "preflighting", input.signal),
        );
        if (parseLogoutHelp(help) !== preflightReceipt.helpSha256) {
          return fail("capability_refused");
        }
        requireCurrent(token, "preflighting", input.signal);
        phase = "logging_out";
        const logoutToken = ++epoch;
        const before = await status(
          () => requireCurrent(logoutToken, "logging_out", input.signal),
        );
        requireCurrent(logoutToken, "logging_out", input.signal);
        if (!before.signedIn) {
          return completeCleanup({ logoutDispatched: false, recovered: true });
        }
        if (attemptMarker !== null) return fail("recovery_required");
        await persistAttemptBeforeEffect(logoutToken, input.signal);
        const result = await runCommand(
          ["auth", "logout"],
          "claude-live-acceptance-logout",
          () => requireCurrent(logoutToken, "logging_out", input.signal),
        );
        requireCurrent(logoutToken, "logging_out", input.signal);
        if (result.exitCode !== 0) return fail("logout_failed");
        const after = await status(
          () => requireCurrent(logoutToken, "logging_out", input.signal),
        );
        requireCurrent(logoutToken, "logging_out", input.signal);
        if (after.signedIn) return fail("logout_failed");
        return completeCleanup({ logoutDispatched: true, recovered: true });
      } catch (error: unknown) {
        return uncertain(error);
      }
    },
    close() {
      if (lifecycleClosed) return;
      lifecycleClosed = true;
      phase = "closed";
      epoch += 1;
    },
  };
  return Object.freeze(controller);
}
