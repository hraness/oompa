import { resolve } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { z } from "zod";

import { oompaAttentionResendApiKeyEnvironmentName } from "../convex/resendApiKey";

import { createBoundedAuthorityFetch, type AuthorityFetcher } from "./bounded-authority-fetch";
import {
  BoundedProcessInvocationGuard,
  isBoundedProcessCleanupUnprovenError,
  isBoundedProcessRecoveryJournalError,
  recoverBoundedProcessJournal,
} from "./bounded-process";
import {
  isAuthorityContainmentUnavailable,
  renderAuthorityContainmentUnavailable,
} from "./authority-containment";
import {
  buildConvexChildEnvironment,
  HOSTED_ENVIRONMENT_NAMES,
  runCommand,
  type CommandResult,
  type CommandRunner,
} from "./configure-hosted-sync";
import {
  ConvexTargetError,
  parseConvexTarget,
  parseConvexTargetArguments,
  verifyConvexDefaultTarget,
  type ConvexTarget,
  type ConvexTargetVerifier,
} from "./convex-target";
import {
  runtimeReleaseAttestationSchema,
  unboundRuntimeReleaseAttestationSchema,
} from "./release-evidence";

const convexCli = resolve(import.meta.dir, "..", "node_modules", "convex", "bin", "main.js");
const repositoryRoot = resolve(import.meta.dir, "..");
const providerOutputMaximumBytes = 64 * 1024;
const convexTimeoutMs = 60_000;
const releaseAttestationTimeoutMs = 30_000;
const sourceCommitPattern = /^[0-9a-f]{40}$/u;
const maximumBootstrapTableCount = 64;

const boundedCountSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
const boundedOccupancySchema = z.union([z.literal(0), z.literal(1)]);

const bootstrapReadSchema = z.object({
  occupiedTableCount: z.number().int().min(0).max(maximumBootstrapTableCount),
  serviceControlCount: boundedCountSchema,
  state: z.enum(["accepted", "inconsistent", "ready", "uninitialized"]),
}).strict().superRefine((value, context) => {
  if (
    (value.state === "uninitialized" && (
      value.occupiedTableCount !== 0 || value.serviceControlCount !== 0
    ))
    || (value.state === "ready" && (
      value.occupiedTableCount !== 3 || value.serviceControlCount !== 1
    ))
    || (value.state === "accepted" && (
      value.occupiedTableCount < 2 || value.serviceControlCount !== 1
    ))
    || (value.state === "inconsistent" && value.occupiedTableCount === 0)
  ) context.addIssue({ code: "custom", message: "bootstrap_status_incoherent" });
});

// A deployment that predates the new-identity control reports no value, which
// means invite_only exactly as an absent stored value does.
const admissionSchema = z.object({
  generation: z.number().int().min(0).safe(),
  newIdentityAdmissions: z.enum(["invite_only", "open"]).optional(),
  state: z.enum(["frozen", "open"]),
  updatedAt: z.number().finite().nonnegative(),
}).strict();

export const attentionInactiveReadSchema = z.object({
  generation: z.number().int().min(0).safe(),
  globalState: z.enum(["absent", "disabled", "enabled"]),
  outboxOccupancy: boundedOccupancySchema,
  safetyFaultOccupancy: boundedOccupancySchema,
}).strict().superRefine((value, context) => {
  if (
    (value.globalState === "absent" && value.generation !== 0)
    || (value.globalState !== "absent" && value.generation === 0)
  ) context.addIssue({ code: "custom", message: "attention_status_incoherent" });
});

// This proves only that the runtime has valid, distinct credentials. Provider
// account identity, domain scope, consent, and sending enablement are separate.
export const attentionSendingReadSchema = z.object({
  dedicatedKeyReady: z.boolean(),
}).strict();

const releaseAttestationFunction = makeFunctionReference<"query", Record<string, never>, unknown>(
  "releaseAttestation:read",
);

type HostedStatusFailureCode =
  | "admission_status_invalid"
  | "attention_status_invalid"
  | "attention_sending_status_invalid"
  | "bootstrap_status_invalid"
  | "environment_status_invalid"
  | "release_attestation_invalid"
  | "usage_invalid";

class HostedStatusError extends Error {
  constructor(readonly code: HostedStatusFailureCode) {
    super(code);
    this.name = "HostedStatusError";
  }
}

type ReleaseAttestationRead = Readonly<
  | { runtimeSourceCommit: string; state: "bound" }
  | { state: "unbound" }
>;

type ReleaseAttestationState = Readonly<{ state: "current" | "other" | "unbound" }>;

export type HostedStatusResult = Readonly<{
  admission: Readonly<
    | { state: "inconsistent" | "uninitialized" }
    | {
        generation: number;
        newIdentityAdmissions: "invite_only" | "open";
        state: "frozen" | "open";
      }
  >;
  attentionNotifications?: Readonly<{
    generation: number;
    globalState: "absent" | "disabled" | "enabled";
    outboxOccupancy: 0 | 1;
    safetyFaultOccupancy: 0 | 1;
    state: "inactive" | "not_inactive";
  }>;
  attentionSending?: Readonly<z.infer<typeof attentionSendingReadSchema>>;
  bootstrap: Readonly<{
    occupiedTableCount: number;
    state: "accepted" | "inconsistent" | "ready" | "uninitialized";
  }>;
  environment: Readonly<{
    requiredNamesPresent: boolean;
    missingRequiredNames: readonly (typeof HOSTED_ENVIRONMENT_NAMES)[number][];
  }>;
  releaseAttestation: ReleaseAttestationState;
  nextAction: "bootstrap_hosted_sync" | "configure_hosted_sync" | "inspect_preflight"
    | "inspect_release_attestation" | "operate_hosted_sync" | "resume_admissions"
    | "run_live_acceptance";
  status: "live" | "preflight_incomplete" | "preflight_inconsistent" | "preflight_passed";
}>;

type HostedStatusArguments = Readonly<{
  requireAttentionInactive: boolean;
  requireAttentionKeyReady: boolean;
  requirePassed: boolean;
  sourceCommit: string;
  target: ConvexTarget;
}>;

export function parseHostedStatusArguments(arguments_: readonly string[]): HostedStatusArguments {
  let parsed: ReturnType<typeof parseConvexTargetArguments>;
  try {
    parsed = parseConvexTargetArguments(arguments_);
  } catch {
    throw new HostedStatusError("usage_invalid");
  }
  let sourceCommit: string | undefined;
  let requireAttentionInactive = false;
  let requireAttentionKeyReady = false;
  let requirePassed = false;
  for (let index = 0; index < parsed.otherArguments.length; index += 1) {
    const argument = parsed.otherArguments[index];
    if (argument === "--source-commit" && sourceCommit === undefined) {
      const value = parsed.otherArguments[index + 1];
      if (value === undefined || !sourceCommitPattern.test(value)) {
        throw new HostedStatusError("usage_invalid");
      }
      sourceCommit = value;
      index += 1;
      continue;
    }
    if (argument === "--require-passed" && !requirePassed) {
      requirePassed = true;
      continue;
    }
    if (argument === "--require-attention-inactive" && !requireAttentionInactive) {
      requireAttentionInactive = true;
      continue;
    }
    if (argument === "--require-attention-key-ready" && !requireAttentionKeyReady) {
      requireAttentionKeyReady = true;
      continue;
    }
    throw new HostedStatusError("usage_invalid");
  }
  if (sourceCommit === undefined) throw new HostedStatusError("usage_invalid");
  return {
    requireAttentionInactive,
    requireAttentionKeyReady,
    requirePassed,
    sourceCommit,
    target: parsed.target,
  };
}

const parseProviderJson = <T>(
  stdout: string,
  schema: z.ZodType<T>,
  code: HostedStatusFailureCode,
): T => {
  if (
    stdout.trim().length === 0
    || Buffer.byteLength(stdout, "utf8") > providerOutputMaximumBytes
  ) throw new HostedStatusError(code);
  try {
    return schema.parse(JSON.parse(stdout) as unknown);
  } catch {
    throw new HostedStatusError(code);
  }
};

const parseEnvironmentNames = (stdout: string): ReadonlySet<string> => {
  if (Buffer.byteLength(stdout, "utf8") > providerOutputMaximumBytes) {
    throw new HostedStatusError("environment_status_invalid");
  }
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/gu)) {
    if (line.length === 0) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(line) || names.has(line)) {
      throw new HostedStatusError("environment_status_invalid");
    }
    names.add(line);
    if (names.size > 1_024) throw new HostedStatusError("environment_status_invalid");
  }
  return names;
};

const environmentArguments = (deployment: string): readonly string[] => [
  "env",
  "list",
  "--names-only",
  "--deployment",
  deployment,
];

const admissionArguments = (deployment: string): readonly string[] => [
  "run",
  "admissionControl:status",
  "{}",
  "--deployment",
  deployment,
];

const bootstrapArguments = (deployment: string): readonly string[] => [
  "run",
  "quota:hostedBootstrapStatus",
  "{}",
  "--deployment",
  deployment,
];

const attentionInactiveArguments = (deployment: string): readonly string[] => [
  "run",
  "attentionNotificationControl:inactiveDeploymentStatus",
  "{}",
  "--deployment",
  deployment,
];

const attentionSendingArguments = (deployment: string): readonly string[] => [
  "run",
  "attentionNotificationControl:sendingKeyReadiness",
  "{}",
  "--deployment",
  deployment,
];

export const parseHostedReleaseAttestation = (value: unknown): ReleaseAttestationRead => {
  const bound = runtimeReleaseAttestationSchema.safeParse(value);
  if (bound.success) {
    return { runtimeSourceCommit: bound.data.runtimeSourceCommit, state: "bound" };
  }
  if (unboundRuntimeReleaseAttestationSchema.safeParse(value).success) {
    return { state: "unbound" };
  }
  throw new HostedStatusError("release_attestation_invalid");
};

const readReleaseAttestation = (
  fetcher: AuthorityFetcher,
): ((target: ConvexTarget) => Promise<ReleaseAttestationRead>) => async (target) => {
  const client = new ConvexHttpClient(target.deploymentUrl, {
    fetch: createBoundedAuthorityFetch(
      fetcher,
      releaseAttestationTimeoutMs,
      "convex_release_attestation_timeout",
    ),
    logger: false,
  });
  try {
    return parseHostedReleaseAttestation(await client.query(releaseAttestationFunction, {}));
  } catch (error: unknown) {
    if (error instanceof HostedStatusError) throw error;
    throw new HostedStatusError("release_attestation_invalid");
  }
};

type HostedStatusOptions = Readonly<{
  authorityFetch?: AuthorityFetcher;
  environment?: Readonly<NodeJS.ProcessEnv>;
  requireAttentionInactive?: boolean;
  requireAttentionKeyReady?: boolean;
  readAttestation?: (target: ConvexTarget) => Promise<ReleaseAttestationRead>;
  runner?: CommandRunner;
  sourceCommit: string;
  target: ConvexTarget;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function readHostedStatus(options: HostedStatusOptions): Promise<HostedStatusResult> {
  const target = parseConvexTarget(options.target);
  if (!sourceCommitPattern.test(options.sourceCommit)) {
    throw new HostedStatusError("usage_invalid");
  }
  const verify = options.verifyTarget ?? verifyConvexDefaultTarget;
  const runner = options.runner ?? runCommand;
  const environment = buildConvexChildEnvironment(options.environment ?? process.env, []);
  const guard = new BoundedProcessInvocationGuard();
  const invoke = async (
    arguments_: readonly string[],
    phase: string,
  ): Promise<CommandResult> => await guard.observe(async () => await runner({
    arguments: [convexCli, ...arguments_],
    containment: "authority",
    cwd: repositoryRoot,
    environment,
    executable: process.execPath,
    outputMaximumBytes: providerOutputMaximumBytes,
    phase,
    stdin: "",
    timeoutMs: convexTimeoutMs,
  }));
  const invokeWithTargetChecks = async (
    arguments_: readonly string[],
    phase: string,
  ): Promise<CommandResult> => {
    await guard.observe(async () => await verify(target));
    let authorityUnavailable = false;
    let custodyFailure = false;
    try {
      return await invoke(arguments_, phase);
    } catch (error: unknown) {
      authorityUnavailable = isAuthorityContainmentUnavailable(error);
      custodyFailure = isBoundedProcessCleanupUnprovenError(error)
        || isBoundedProcessRecoveryJournalError(error);
      throw error;
    } finally {
      if (!authorityUnavailable && !custodyFailure) {
        await guard.observe(async () => await verify(target));
      }
    }
  };

  await guard.observe(async () => await verify(target));
  const attestationReader = options.readAttestation
    ?? readReleaseAttestation(options.authorityFetch ?? fetch);
  let releaseAttestationRead: ReleaseAttestationRead;
  try {
    releaseAttestationRead = await attestationReader(target);
  } finally {
    await guard.observe(async () => await verify(target));
  }
  const releaseAttestation: ReleaseAttestationState = releaseAttestationRead.state === "unbound"
    ? { state: "unbound" }
    : {
        state: releaseAttestationRead.runtimeSourceCommit === options.sourceCommit
          ? "current"
          : "other",
      };

  const environmentResult = await invokeWithTargetChecks(
    environmentArguments(target.deploymentName),
    "hosted-status-environment-read",
  );
  if (environmentResult.exitCode !== 0) {
    throw new HostedStatusError("environment_status_invalid");
  }
  const environmentNames = parseEnvironmentNames(environmentResult.stdout);
  const missingRequiredNames = HOSTED_ENVIRONMENT_NAMES.filter((name) => !environmentNames.has(name));

  const bootstrapResult = await invokeWithTargetChecks(
    bootstrapArguments(target.deploymentName),
    "hosted-status-bootstrap-read",
  );
  if (bootstrapResult.exitCode !== 0) {
    throw new HostedStatusError("bootstrap_status_invalid");
  }
  const bootstrapRead = parseProviderJson(
    bootstrapResult.stdout,
    bootstrapReadSchema,
    "bootstrap_status_invalid",
  );

  let admission: HostedStatusResult["admission"];
  if (bootstrapRead.serviceControlCount === 0) {
    if (bootstrapRead.state !== "uninitialized") {
      admission = { state: "inconsistent" };
    } else {
      admission = { state: "uninitialized" };
    }
  } else if (bootstrapRead.serviceControlCount === 1) {
    const admissionResult = await invokeWithTargetChecks(
      admissionArguments(target.deploymentName),
      "hosted-status-admission-read",
    );
    if (admissionResult.exitCode !== 0) {
      throw new HostedStatusError("admission_status_invalid");
    }
    const parsedAdmission = parseProviderJson(
      admissionResult.stdout,
      admissionSchema,
      "admission_status_invalid",
    );
    admission = {
      generation: parsedAdmission.generation,
      newIdentityAdmissions: parsedAdmission.newIdentityAdmissions ?? "invite_only",
      state: parsedAdmission.state,
    };
  } else {
    admission = { state: "inconsistent" };
  }

  let attentionNotifications: HostedStatusResult["attentionNotifications"];
  if (options.requireAttentionInactive === true) {
    const attentionResult = await invokeWithTargetChecks(
      attentionInactiveArguments(target.deploymentName),
      "hosted-status-attention-inactive-read",
    );
    if (attentionResult.exitCode !== 0) {
      throw new HostedStatusError("attention_status_invalid");
    }
    const attentionRead = parseProviderJson(
      attentionResult.stdout,
      attentionInactiveReadSchema,
      "attention_status_invalid",
    );
    attentionNotifications = {
      ...attentionRead,
      state: attentionRead.globalState === "absent"
        && attentionRead.generation === 0
        && attentionRead.outboxOccupancy === 0
        && attentionRead.safetyFaultOccupancy === 0
        ? "inactive"
        : "not_inactive",
    };
  }

  let attentionSending: HostedStatusResult["attentionSending"];
  if (options.requireAttentionKeyReady === true) {
    const sendingResult = await invokeWithTargetChecks(
      attentionSendingArguments(target.deploymentName),
      "hosted-status-attention-key-read",
    );
    if (sendingResult.exitCode !== 0) {
      throw new HostedStatusError("attention_sending_status_invalid");
    }
    attentionSending = parseProviderJson(
      sendingResult.stdout,
      attentionSendingReadSchema,
      "attention_sending_status_invalid",
    );
  }

  // Keep the complete seven-name observation visible. Only this exact inactive
  // checkpoint can omit the sending key; an explicit key-readiness gate cannot.
  const inactiveAttentionKeyAbsent = options.requireAttentionKeyReady !== true
    && attentionNotifications?.state === "inactive"
    && missingRequiredNames.length === 1
    && missingRequiredNames[0] === oompaAttentionResendApiKeyEnvironmentName;
  const environmentReady = missingRequiredNames.length === 0 || inactiveAttentionKeyAbsent;
  const runtimeCurrent = releaseAttestation.state === "current" && environmentReady;
  const preflightPassed = runtimeCurrent
    && bootstrapRead.state === "ready"
    && admission.state === "open"
    && admission.generation === 0;
  const live = runtimeCurrent
    && bootstrapRead.state === "accepted"
    && admission.state === "open";
  const inconsistent = bootstrapRead.state === "inconsistent"
    || admission.state === "inconsistent"
    || (bootstrapRead.state === "ready" && (
      admission.state !== "open" || admission.generation !== 0
    ));
  const status = preflightPassed
    ? "preflight_passed"
    : live
      ? "live"
      : inconsistent
        ? "preflight_inconsistent"
        : "preflight_incomplete";
  const nextAction: HostedStatusResult["nextAction"] = status === "preflight_passed"
    ? "run_live_acceptance"
    : status === "live"
      ? "operate_hosted_sync"
      : status === "preflight_inconsistent"
        ? "inspect_preflight"
        : releaseAttestation.state !== "current"
          ? "inspect_release_attestation"
          : !environmentReady
            ? "configure_hosted_sync"
            : bootstrapRead.state === "uninitialized"
              ? "bootstrap_hosted_sync"
              : bootstrapRead.state === "accepted" && admission.state === "frozen"
                ? "resume_admissions"
                : "inspect_preflight";
  return {
    admission,
    ...(attentionNotifications === undefined ? {} : { attentionNotifications }),
    ...(attentionSending === undefined ? {} : { attentionSending }),
    bootstrap: {
      occupiedTableCount: bootstrapRead.occupiedTableCount,
      state: bootstrapRead.state,
    },
    environment: {
      requiredNamesPresent: missingRequiredNames.length === 0,
      missingRequiredNames,
    },
    releaseAttestation,
    nextAction,
    status,
  };
}

type ExecuteHostedStatusOptions = Readonly<{
  arguments: readonly string[];
  authorityFetch?: AuthorityFetcher;
  environment?: Readonly<NodeJS.ProcessEnv>;
  readAttestation?: (target: ConvexTarget) => Promise<ReleaseAttestationRead>;
  runner?: CommandRunner;
  stderr: Pick<NodeJS.WriteStream, "write">;
  stdout: Pick<NodeJS.WriteStream, "write">;
  verifyTarget?: ConvexTargetVerifier;
}>;

export async function executeHostedStatus(options: ExecuteHostedStatusOptions): Promise<number> {
  try {
    const parsed = parseHostedStatusArguments(options.arguments);
    const status = await readHostedStatus({
      ...(options.authorityFetch === undefined ? {} : { authorityFetch: options.authorityFetch }),
      ...(options.environment === undefined ? {} : { environment: options.environment }),
      ...(options.readAttestation === undefined ? {} : { readAttestation: options.readAttestation }),
      requireAttentionInactive: parsed.requireAttentionInactive,
      requireAttentionKeyReady: parsed.requireAttentionKeyReady,
      ...(options.runner === undefined ? {} : { runner: options.runner }),
      sourceCommit: parsed.sourceCommit,
      target: parsed.target,
      ...(options.verifyTarget === undefined ? {} : { verifyTarget: options.verifyTarget }),
    });
    options.stdout.write(`${JSON.stringify({ ...status, version: 1 })}\n`);
    const preflightRequiredButMissing = parsed.requirePassed
      && status.status !== "preflight_passed"
      && status.status !== "live";
    const inactiveRequiredButMissing = parsed.requireAttentionInactive
      && status.attentionNotifications?.state !== "inactive";
    const keyRequiredButMissing = parsed.requireAttentionKeyReady
      && status.attentionSending?.dedicatedKeyReady !== true;
    return preflightRequiredButMissing || inactiveRequiredButMissing || keyRequiredButMissing ? 1 : 0;
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
    const code = error instanceof HostedStatusError
      ? error.code
      : error instanceof ConvexTargetError
        ? "convex_target_refused"
        : "bootstrap_status_invalid";
    options.stderr.write(`${JSON.stringify({
      code,
      schemaVersion: 1,
      status: "refused",
    })}\n`);
    return 1;
  }
}

if (import.meta.main) {
  let exitCode = 75;
  try {
    await recoverBoundedProcessJournal();
    exitCode = await executeHostedStatus({
      arguments: process.argv.slice(2),
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
      process.stderr.write(`${JSON.stringify({
        code: "bootstrap_status_invalid",
        schemaVersion: 1,
        status: "refused",
      })}\n`);
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}
