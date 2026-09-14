import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";
import { AppSourceArtifactError, appLocalArtifactProofSchema, appPublicArtifactProofSchema, hasAppArtifactSecurityHeaders, observePublicAppArtifacts,
  readLocalAppArtifactProof, type AppSourceArtifact } from "./app-source-artifacts";

import { createBoundedAuthorityFetch, type AuthorityFetcher } from "./bounded-authority-fetch";
import { readProtectedVercelAccessToken } from "./current-project-alias-release";
import {
  appSourceProofChildEnvironment,
  appSourceProofGitCommand,
  hasExactAppSourceProofOriginConfig,
} from "./verify-app-source-launcher";
import {
  canonicalDigest,
  readProtectedJson,
  withSelfDigest,
  writeProtectedJsonNoReplace,
} from "./release-evidence";

const supportedBunVersion = "1.3.14";
const providerRequestTimeoutMs = 15_000;
const providerMaximumBytes = 128 * 1024;
const deploymentListPageLimit = 20;
const deploymentListMaximumPages = 10;
const markerMaximumBytes = 16 * 1024;
const outputMaximumBytes = 64 * 1024;
const sourceReadMaximumBytes = 64 * 1024;
const observationMaximumMs = 5 * 60 * 1_000;
const vercelApiOrigin = "https://api.vercel.com";
const publicRepositoryUrl = "https://github.com/hraness/oompa.git";

export const oompaAppAlias = "app.oompa.app";
export const oompaAppBranch = "main";
export const oompaAppProjectId = "prj_3olYDT29BrwKO9PLByVq9HlgRkdA";
export const oompaAppRepositoryId = 1_343_008_607;
export const oompaAppTeamId = "team_UAd1iD2XogJlbFg4h14mRaPM";

const oompaAppBuildSettings = Object.freeze({
  buildCommand: "cd .. && bun install --frozen-lockfile --ignore-scripts && bun run build:app",
  commandForIgnoringBuildStep: 'test "$VERCEL_ENV" != "production"',
  devCommand: null,
  framework: null,
  installCommand: "true",
  outputDirectory: "dist",
  rootDirectory: "app",
  sourceFilesOutsideRootDirectory: true,
} as const);
type BuildSettingsDigestInput = Readonly<{
  buildCommand: string;
  commandForIgnoringBuildStep: string | null;
  devCommand: string | null;
  framework: string | null;
  installCommand: string;
  outputDirectory: string;
  rootDirectory: string;
  sourceFilesOutsideRootDirectory: boolean;
}>;
const digestBuildSettings = (settings: BuildSettingsDigestInput): string =>
  createHash("sha256")
    .update(JSON.stringify([
      ["buildCommand", settings.buildCommand],
      ["commandForIgnoringBuildStep", settings.commandForIgnoringBuildStep],
      ["devCommand", settings.devCommand],
      ["framework", settings.framework],
      ["installCommand", settings.installCommand],
      ["outputDirectory", settings.outputDirectory],
      ["rootDirectory", settings.rootDirectory],
      ["sourceFilesOutsideRootDirectory", settings.sourceFilesOutsideRootDirectory],
    ]))
    .digest("hex");
export const oompaAppBuildSettingsDigest = digestBuildSettings(oompaAppBuildSettings);
const observedDeploymentSettings = (settings: Omit<BuildSettingsDigestInput, "rootDirectory" | "sourceFilesOutsideRootDirectory">) => ({
  buildCommand: settings.buildCommand, commandForIgnoringBuildStep: settings.commandForIgnoringBuildStep,
  devCommand: settings.devCommand, framework: settings.framework, installCommand: settings.installCommand,
  outputDirectory: settings.outputDirectory,
});
export const oompaAppDeploymentObservedSettingsDigest = canonicalDigest(observedDeploymentSettings(oompaAppBuildSettings));
const oompaAppProjectBuildSettingsDigests = new Set([
  oompaAppBuildSettingsDigest,
  digestBuildSettings({
    ...oompaAppBuildSettings,
    commandForIgnoringBuildStep: null,
  }),
]);

const commitSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]{20,80}$/u);
const deploymentUrlSchema = z.string()
  .max(253)
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.vercel\.app$/u)
  .refine((value) => value.endsWith(".vercel.app"));
const releaseVersionSchema = z.string()
  .min(1)
  .max(64)
  .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
const accessTokenSchema = z.string().min(1).max(4_096).regex(/^[!-~]+$/u);
const nonceSchema = z.string().uuid({ version: "v4" });
const evidencePathSchema = z.string().min(1).max(4_096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const deploymentBuildSettingsSchema = z.object({
  buildCommand: z.literal(oompaAppBuildSettings.buildCommand),
  commandForIgnoringBuildStep: z.literal(oompaAppBuildSettings.commandForIgnoringBuildStep),
  devCommand: z.null(),
  framework: z.null(),
  installCommand: z.literal(oompaAppBuildSettings.installCommand),
  outputDirectory: z.literal(oompaAppBuildSettings.outputDirectory),
});
const deploymentSnapshotBuildSettingsSchema = deploymentBuildSettingsSchema.extend({
  rootDirectory: z.literal(oompaAppBuildSettings.rootDirectory),
  sourceFilesOutsideRootDirectory: z.literal(true),
});

const projectReadbackSchema = deploymentSnapshotBuildSettingsSchema.extend({
  accountId: z.literal(oompaAppTeamId),
  // app/vercel.json supplies this exact effective deployment setting. The
  // dashboard value may therefore be either unset or the same exact command.
  commandForIgnoringBuildStep: z.union([
    z.null(),
    z.literal(oompaAppBuildSettings.commandForIgnoringBuildStep),
  ]),
  id: z.literal(oompaAppProjectId),
  link: z.object({
    org: z.literal("hraness"),
    productionBranch: z.literal(oompaAppBranch),
    repo: z.literal("oompa"),
    repoId: z.literal(oompaAppRepositoryId),
    type: z.literal("github"),
  }),
  name: z.literal("oompa-app"),
  skewProtectionBoundaryAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  skewProtectionMaxAge: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

const projectDomainReadbackSchema = z.object({
  apexName: z.literal("oompa.app"),
  customEnvironmentId: z.null().optional(),
  gitBranch: z.null().optional(),
  name: z.literal(oompaAppAlias),
  projectId: z.literal(oompaAppProjectId),
  redirect: z.null().optional(),
  redirectStatusCode: z.null().optional(),
  verified: z.literal(true),
});

const domainConfigReadbackSchema = z.object({
  configuredBy: z.enum(["A", "CNAME"]),
  misconfigured: z.literal(false),
});

const deploymentReadbackSchema = z.object({
  gitSource: z.object({
    ref: z.literal(oompaAppBranch),
    repoId: z.literal(oompaAppRepositoryId),
    sha: commitSchema,
    type: z.literal("github"),
  }),
  id: deploymentIdSchema,
  prebuilt: z.literal(false).optional(),
  projectId: z.literal(oompaAppProjectId),
  projectSettings: deploymentSnapshotBuildSettingsSchema.partial({ rootDirectory: true, sourceFilesOutsideRootDirectory: true }),
  readyState: z.literal("READY"),
  // Vercel documents this as a best-effort metrics field. It is retained only
  // as a conservative release refusal guard against manual CLI uploads; the
  // exact Git identity below comes from gitSource.
  source: z.literal("git"),
  target: z.literal("production"),
  url: deploymentUrlSchema,
});

const deploymentSnapshotReadbackSchema = z.object({
  prebuilt: z.literal(false).optional(),
  projectId: z.literal(oompaAppProjectId),
  // The documented list snapshot is sparse. Missing fields are not defaults;
  // any reported value must still match the expected configuration.
  projectSettings: deploymentSnapshotBuildSettingsSchema.partial().optional(),
  readyState: z.literal("READY"),
  source: z.literal("git"),
  target: z.literal("production"),
  uid: deploymentIdSchema,
  url: deploymentUrlSchema,
});
const deploymentListReadbackSchema = z.object({
  deployments: z.array(deploymentSnapshotReadbackSchema).max(deploymentListPageLimit),
  pagination: z.object({
    count: z.number().int().min(0).max(deploymentListPageLimit),
    next: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    prev: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }),
});

const rollingReleaseReadbackSchema = z.object({
  rollingRelease: z.union([
    z.null(),
    z.object({
      state: z.enum(["ABORTED", "ACTIVE", "COMPLETE"]),
    }),
  ]),
});

const routeVersionIdSchema = z.string().min(1).max(256);
const routeVersionSchema = z.object({
  id: routeVersionIdSchema,
  isLive: z.boolean().optional(),
});
const routeVersionsReadbackSchema = z.object({
  versions: z.array(routeVersionSchema).max(1_000),
});
const exactRoutesReadbackSchema = z.object({
  routes: z.array(z.unknown()).max(1_000),
  version: z.object({
    id: routeVersionIdSchema,
    isLive: z.literal(true),
  }),
});

const bulkRedirectVersionSchema = z.object({
  id: routeVersionIdSchema,
  isLive: z.literal(true),
  redirectCount: z.literal(0).optional(),
});
const bulkRedirectReadbackSchema = z.object({
  pagination: z.object({
    numPages: z.number().int().nonnegative(),
    page: z.literal(1),
    per_page: z.literal(10),
  }),
  redirects: z.array(z.unknown()).max(10),
  version: bulkRedirectVersionSchema.optional(),
});
const unconfiguredBulkRedirectsSchema = z.strictObject({
  redirects: z.array(z.unknown()).length(0),
  version: z.null(),
});
const noBulkRedirectVersionsSchema = z.strictObject({
  versions: z.array(z.unknown()).length(0),
});

const firewallActionSchema = z.enum([
  "allow",
  "bypass",
  "challenge",
  "deny",
  "log",
  "rate_limit",
  "redirect",
]);
const firewallMitigationSchema = z.object({ action: firewallActionSchema });
const firewallRuleSchema = z.object({
  action: z.object({
    mitigate: firewallMitigationSchema.optional(),
  }),
  active: z.boolean(),
  valid: z.boolean(),
});
const firewallRulesetSchema = z.object({
  action: z.object({
    mitigate: firewallMitigationSchema.optional(),
  }).optional(),
  active: z.boolean(),
});
const firewallRulesetRecordValueSchema = z.object({
  action: firewallActionSchema,
});
const firewallReadbackSchema = z.object({
  changes: z.array(z.unknown()).max(10_000),
  firewallEnabled: z.boolean(),
  id: z.string().min(1).max(256),
  ips: z.array(z.unknown()).max(10_000),
  ownerId: z.literal(oompaAppTeamId),
  projectKey: z.literal(oompaAppProjectId),
  rules: z.array(firewallRuleSchema).max(10_000),
  rulesets: z.union([
    z.array(firewallRulesetSchema).max(10_000),
    z.record(z.string().min(1).max(256), firewallRulesetRecordValueSchema),
  ]).optional(),
  updatedAt: z.string().min(1).max(128),
  version: z.number().int().nonnegative(),
});
const firewallConfigurationsReadbackSchema = z.strictObject({
  active: firewallReadbackSchema.nullable(),
  draft: z.record(z.string(), z.unknown()).nullable(),
  versions: z.array(z.record(z.string(), z.unknown())).max(1_000),
});

const aliasReadbackSchema = z.object({
  alias: z.literal(oompaAppAlias),
  deployment: z.object({
    id: deploymentIdSchema,
    url: deploymentUrlSchema,
  }),
  deploymentId: deploymentIdSchema,
  microfrontends: z.null().optional(),
  projectId: z.literal(oompaAppProjectId),
  redirect: z.null().optional(),
  redirectStatusCode: z.null().optional(),
  uid: z.string().min(1).max(256),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const markerSchema = z.object({
  generation: z.literal(1),
  product: z.literal("Oompa App"),
  repository: z.object({
    id: z.literal(oompaAppRepositoryId),
    path: z.literal("hraness/oompa"),
  }).strict(),
  schemaVersion: z.literal(1),
  source: z.object({ commit: commitSchema }).strict(),
  version: releaseVersionSchema,
}).strict();

const appSourceProofUnsignedSchema = z.object({
  alias: z.literal(oompaAppAlias),
  aliasUid: z.string().min(1).max(256),
  aliasUpdatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  branch: z.literal(oompaAppBranch),
  bulkRedirectVersionId: routeVersionIdSchema.nullable(),
  cacheControl: z.literal("no-store"),
  completedAt: z.string().datetime(),
  deploymentObservedSettingsDigest: digestSchema,
  deploymentRootSettingsAuthority: z.literal("not-attested"),
  publicArtifacts: appPublicArtifactProofSchema,
  deploymentId: deploymentIdSchema,
  deploymentUrl: deploymentUrlSchema,
  domainConfiguredBy: z.enum(["A", "CNAME"]),
  firewallConfigId: z.string().min(1).max(256).nullable(),
  firewallConfigVersion: z.number().int().nonnegative().nullable(),
  firewallEnabled: z.boolean().nullable(),
  kind: z.literal("hra-app-source-proof"),
  marker: markerSchema,
  observationBoundary: z.literal("sequential-readback-without-provider-lock"),
  projectBuildSettingsDigest: digestSchema,
  projectId: z.literal(oompaAppProjectId),
  projectRouteVersionId: routeVersionIdSchema.nullable(),
  readyState: z.literal("READY"),
  releaseVersion: releaseVersionSchema,
  repositoryId: z.literal(oompaAppRepositoryId),
  rollingReleaseState: z.enum(["ABORTED", "COMPLETE"]).nullable(),
  schemaVersion: z.literal(4),
  skewProtectionBoundaryAt: z.null(),
  skewProtectionMaxAge: z.union([z.null(), z.literal(0)]),
  sourceCommit: commitSchema,
  sourceRemoteMainCommit: commitSchema,
  startedAt: z.string().datetime(),
  target: z.literal("production"),
  teamId: z.literal(oompaAppTeamId),
  verifierIndexTransparent: z.literal(true),
  verifierSourceCommit: commitSchema,
  verifierTrackedAndUntrackedClean: z.literal(true),
}).strict();
export const appSourceProofEvidenceSchema = appSourceProofUnsignedSchema.extend({
  selfDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const { selfDigest, ...unsigned } = value;
  const started = Date.parse(value.startedAt);
  const completed = Date.parse(value.completedAt);
  if (
    selfDigest !== canonicalDigest(unsigned)
    || value.deploymentObservedSettingsDigest !== oompaAppDeploymentObservedSettingsDigest
    || value.publicArtifacts.local.sourceCommit !== value.sourceCommit
    || value.publicArtifacts.local.releaseVersion !== value.releaseVersion
    || !oompaAppProjectBuildSettingsDigests.has(value.projectBuildSettingsDigest)
    || value.marker.source.commit !== value.sourceCommit
    || value.marker.version !== value.releaseVersion
    || value.sourceRemoteMainCommit !== value.sourceCommit
    || value.verifierSourceCommit !== value.sourceCommit
    || (value.firewallConfigId === null) !== (value.firewallConfigVersion === null)
    || (value.firewallConfigId === null) !== (value.firewallEnabled === null)
    || !Number.isFinite(started)
    || !Number.isFinite(completed)
    || completed < started
    || completed - started > observationMaximumMs
  ) context.addIssue({ code: "custom", message: "app_source_proof_binding_invalid" });
});
export type AppSourceProofEvidence = z.infer<typeof appSourceProofEvidenceSchema>;

export const appSourceProofErrorCodes = [
  "usage_invalid",
  "bun_version_unsupported",
  "provider_credentials_refused",
  "verifier_source_invalid",
  "provider_readback_invalid",
  "marker_readback_invalid",
  "artifact_readback_invalid",
  "authority_changed_during_observation",
  "retained_proof_invalid",
  "proof_output_invalid",
] as const;

export type AppSourceProofErrorCode = (typeof appSourceProofErrorCodes)[number];

export class AppSourceProofError extends Error {
  readonly code: AppSourceProofErrorCode;

  constructor(code: AppSourceProofErrorCode) {
    super(`Oompa app source proof refused: ${code}`);
    this.name = "AppSourceProofError";
    this.code = code;
  }
}

export type AppSourceProofArguments = Readonly<{
  deploymentId: string;
  evidencePath: string;
  releaseVersion: string;
  sourceCommit: string;
  vercelAuthFd: number;
}>;

export type RetainedAppSourceProofArguments = Readonly<{
  evidencePath: string;
  releaseVersion: string;
  sourceCommit: string;
}>;

export type AppSourceState = Readonly<{
  commit: string;
  exactOrigin: boolean;
  indexTransparent: boolean;
  remoteMainCommit: string;
  rootExact: boolean;
  trackedAndUntrackedClean: boolean;
}>;

type OutputWriter = Readonly<{ write(document: string): unknown }>;

type ProviderSample = Readonly<{
  aliasUid: string;
  aliasUpdatedAt: number;
  bulkRedirectVersionId: string | null;
  deploymentObservedSettingsDigest: string;
  deploymentId: string;
  deploymentUrl: string;
  domainConfiguredBy: "A" | "CNAME";
  firewallConfigId: string | null;
  firewallConfigVersion: number | null;
  firewallEnabled: boolean | null;
  projectRouteVersionId: string | null;
  projectBuildSettingsDigest: string;
  projectId: string;
  rollingReleaseState: "ABORTED" | "COMPLETE" | null;
  skewProtectionBoundaryAt: number | null;
  skewProtectionMaxAge: number | null;
  sourceCommit: string;
  teamId: string;
}>;

export type ExecuteAppSourceProofOptions = Readonly<{
  accessToken: string;
  arguments: readonly string[];
  clock?: () => Date;
  fetcher?: AuthorityFetcher;
  artifactReader?: typeof readLocalAppArtifactProof;
  evidenceWriter?: (path: string, evidence: AppSourceProofEvidence) => unknown;
  monotonicClock?: () => number;
  nonce?: () => string;
  runtimeVersion?: string;
  sourceState?: () => AppSourceState;
  stderr: OutputWriter;
  stdout: OutputWriter;
}>;

export type ExecuteRetainedAppSourceProofOptions = Readonly<{
  arguments: readonly string[];
  proofReader?: (
    path: string,
    expected: RetainedAppSourceProofArguments,
  ) => AppSourceProofEvidence;
  runtimeVersion?: string;
  sourceState?: () => AppSourceState;
  stderr: OutputWriter;
  stdout: OutputWriter;
}>;

function fail(code: AppSourceProofErrorCode): never {
  throw new AppSourceProofError(code);
}

export const assertAppSourceProofBunVersion = (
  runtimeVersion = Bun.version,
): void => {
  if (runtimeVersion !== supportedBunVersion) fail("bun_version_unsupported");
};

export const parseAppSourceProofArguments = (
  arguments_: readonly string[],
): AppSourceProofArguments => {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--deployment-id",
    "--evidence-path",
    "--release-version",
    "--source-commit",
    "--vercel-auth-fd",
  ]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name === undefined
      || value === undefined
      || !allowed.has(name)
      || values.has(name)
      || value.startsWith("--")
    ) fail("usage_invalid");
    values.set(name, value);
  }
  if (values.size !== allowed.size) fail("usage_invalid");

  const deploymentId = values.get("--deployment-id");
  const evidencePath = values.get("--evidence-path");
  const releaseVersion = values.get("--release-version");
  const sourceCommit = values.get("--source-commit");
  const descriptorText = values.get("--vercel-auth-fd");
  if (
    deploymentId === undefined
    || evidencePath === undefined
    || releaseVersion === undefined
    || sourceCommit === undefined
    || descriptorText === undefined
    || !deploymentIdSchema.safeParse(deploymentId).success
    || !evidencePathSchema.safeParse(evidencePath).success
    || !releaseVersionSchema.safeParse(releaseVersion).success
    || !commitSchema.safeParse(sourceCommit).success
    || !/^(?:[3-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$/u.test(descriptorText)
  ) fail("usage_invalid");
  return Object.freeze({
    deploymentId,
    evidencePath,
    releaseVersion,
    sourceCommit,
    vercelAuthFd: Number(descriptorText),
  });
};

export const parseRetainedAppSourceProofArguments = (
  arguments_: readonly string[],
): RetainedAppSourceProofArguments => {
  const values = new Map<string, string>();
  const allowed = new Set(["--evidence-path", "--release-version", "--source-commit"]);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (
      name === undefined
      || value === undefined
      || !allowed.has(name)
      || values.has(name)
      || value.startsWith("--")
    ) fail("usage_invalid");
    values.set(name, value);
  }
  if (values.size !== allowed.size) fail("usage_invalid");
  const evidencePath = values.get("--evidence-path");
  const releaseVersion = values.get("--release-version");
  const sourceCommit = values.get("--source-commit");
  if (
    evidencePath === undefined
    || releaseVersion === undefined
    || sourceCommit === undefined
    || !evidencePathSchema.safeParse(evidencePath).success
    || !releaseVersionSchema.safeParse(releaseVersion).success
    || !commitSchema.safeParse(sourceCommit).success
  ) fail("usage_invalid");
  return Object.freeze({ evidencePath, releaseVersion, sourceCommit });
};

const readLocalSourceState = (): AppSourceState => {
  const cwd = resolve(import.meta.dir, "..");
  const run = (arguments_: readonly string[], commandCwd = cwd) => spawnSync(
    appSourceProofGitCommand(arguments_)[0] as string,
    appSourceProofGitCommand(arguments_).slice(1),
    {
      cwd: commandCwd,
      encoding: "utf8",
      env: appSourceProofChildEnvironment(),
      maxBuffer: sourceReadMaximumBytes,
      timeout: providerRequestTimeoutMs,
      windowsHide: true,
    },
  );
  const checked = (arguments_: readonly string[]): string => {
    const result = run(arguments_);
    if (
      result.status !== 0
      || result.signal !== null
      || result.stderr !== ""
      || Buffer.byteLength(result.stdout, "utf8") > sourceReadMaximumBytes
    ) fail("verifier_source_invalid");
    return result.stdout;
  };
  const root = checked(["rev-parse", "--show-toplevel"]).trim();
  const commit = checked(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const status = checked(["status", "--porcelain=v1", "--untracked-files=all"]);
  const index = checked(["ls-files", "-v", "-z"]);
  const config = checked(["config", "--null", "--list"]);
  const fetchOrigins = checked(["remote", "get-url", "--all", "origin"]).trim().split("\n");
  const pushOrigins = checked(["remote", "get-url", "--push", "--all", "origin"]).trim().split("\n");
  const remoteCommand = appSourceProofGitCommand([
    "ls-remote",
    "--heads",
    publicRepositoryUrl,
    `refs/heads/${oompaAppBranch}`,
  ]);
  const remoteResult = spawnSync(remoteCommand[0] as string, remoteCommand.slice(1), {
    cwd: "/",
    encoding: "utf8",
    env: appSourceProofChildEnvironment(),
    maxBuffer: sourceReadMaximumBytes,
    timeout: providerRequestTimeoutMs,
    windowsHide: true,
  });
  if (
    remoteResult.status !== 0
    || remoteResult.signal !== null
    || remoteResult.stderr !== ""
    || Buffer.byteLength(remoteResult.stdout, "utf8") > sourceReadMaximumBytes
  ) fail("verifier_source_invalid");
  const remote = remoteResult.stdout;
  if (!commitSchema.safeParse(commit).success) fail("verifier_source_invalid");
  const remoteMatch = /^([0-9a-f]{40})\trefs\/heads\/main\n?$/u.exec(remote);
  if (remoteMatch?.[1] === undefined) fail("verifier_source_invalid");
  const indexEntries = index.split("\0").filter(Boolean);
  return Object.freeze({
    commit,
    exactOrigin: hasExactAppSourceProofOriginConfig(config)
      && fetchOrigins.length === 1
      && pushOrigins.length === 1
      && fetchOrigins[0] === publicRepositoryUrl
      && pushOrigins[0] === publicRepositoryUrl,
    indexTransparent: !indexEntries.some(
      (entry) => entry[0] === "S" || /^[a-z]$/u.test(entry[0] ?? ""),
    ),
    remoteMainCommit: remoteMatch[1],
    rootExact: root === cwd,
    trackedAndUntrackedClean: status === "",
  });
};

const assertExactSourceState = (
  sourceState: AppSourceState,
  expectedCommit: string,
): void => {
  if (
    sourceState.commit !== expectedCommit
    || sourceState.remoteMainCommit !== expectedCommit
    || !sourceState.exactOrigin
    || !sourceState.indexTransparent
    || !sourceState.rootExact
    || !sourceState.trackedAndUntrackedClean
  ) fail("verifier_source_invalid");
};

const readBoundedJson = async (
  response: Response,
  expectedUrl: string,
  maximumBytes: number,
  errorCode: "provider_readback_invalid" | "marker_readback_invalid",
  observeBytes?: (bytes: Uint8Array) => void,
): Promise<unknown> => {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (
    response.status !== 200
    || response.body === null
    || response.redirected
    || response.url !== expectedUrl
    || contentType === undefined
    || !/^application\/json(?:\s*;|$)/u.test(contentType)
  ) {
    await response.body?.cancel().catch(() => undefined);
    fail(errorCode);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) fail(errorCode);
      chunks.push(result.value);
    }
    if (bytes === 0) fail(errorCode);
    const raw = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    observeBytes?.(raw);
    const document = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return JSON.parse(document) as unknown;
  } catch (error: unknown) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof AppSourceProofError) throw error;
    fail(errorCode);
  }
};

const providerUrl = (path: string): string => {
  const url = new URL(path, vercelApiOrigin);
  if (url.origin !== vercelApiOrigin || !url.pathname.startsWith("/v")) {
    fail("provider_readback_invalid");
  }
  url.searchParams.set("teamId", oompaAppTeamId);
  return url.href;
};

const readProviderJson = async (
  fetcher: AuthorityFetcher,
  accessToken: string,
  path: string,
): Promise<unknown> => {
  const url = providerUrl(path);
  try {
    const response = await fetcher(url, {
      cache: "no-store",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        "cache-control": "no-cache",
      },
      method: "GET",
      redirect: "error",
    });
    return await readBoundedJson(
      response,
      url,
      providerMaximumBytes,
      "provider_readback_invalid",
    );
  } catch (error: unknown) {
    if (error instanceof AppSourceProofError) throw error;
    fail("provider_readback_invalid");
  }
};

const readExactDeploymentSnapshot = async (
  fetcher: AuthorityFetcher,
  accessToken: string,
  expected: AppSourceProofArguments,
): Promise<z.infer<typeof deploymentSnapshotReadbackSchema>> => {
  let until: number | undefined;
  const observedCursors = new Set<number>();
  for (let page = 0; page < deploymentListMaximumPages; page += 1) {
    const cursor = until === undefined ? "" : `&until=${until}`;
    const document = await readProviderJson(
      fetcher,
      accessToken,
      `/v7/deployments?projectId=${oompaAppProjectId}`
        + `&target=production&state=READY&branch=${oompaAppBranch}`
        + `&sha=${expected.sourceCommit}&limit=${deploymentListPageLimit}${cursor}`,
    );
    const result = deploymentListReadbackSchema.safeParse(document);
    if (
      !result.success
      || result.data.pagination.count !== result.data.deployments.length
    ) fail("provider_readback_invalid");
    const matches = result.data.deployments.filter(
      (deployment) => deployment.uid === expected.deploymentId,
    );
    if (matches.length > 1) fail("provider_readback_invalid");
    const match = matches[0];
    if (match !== undefined) return match;
    const next = result.data.pagination.next;
    if (next === null || observedCursors.has(next)) {
      fail("provider_readback_invalid");
    }
    observedCursors.add(next);
    until = next;
  }
  fail("provider_readback_invalid");
};

const readProviderSample = async (
  fetcher: AuthorityFetcher,
  accessToken: string,
  expected: AppSourceProofArguments,
): Promise<ProviderSample> => {
  const projectDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v9/projects/${oompaAppProjectId}`,
  );
  const project = projectReadbackSchema.safeParse(projectDocument);
  if (!project.success) fail("provider_readback_invalid");
  const skewProtectionBoundaryAt = project.data.skewProtectionBoundaryAt ?? null;
  const skewProtectionMaxAge = project.data.skewProtectionMaxAge ?? null;
  if (
    skewProtectionBoundaryAt !== null
    || (skewProtectionMaxAge !== null && skewProtectionMaxAge > 0)
  ) fail("provider_readback_invalid");

  const projectDomainDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v9/projects/${oompaAppProjectId}/domains/${oompaAppAlias}`,
  );
  const projectDomain = projectDomainReadbackSchema.safeParse(
    projectDomainDocument,
  );
  if (!projectDomain.success) fail("provider_readback_invalid");

  const domainConfigDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v6/domains/${oompaAppAlias}/config?projectIdOrName=${oompaAppProjectId}`,
  );
  const domainConfig = domainConfigReadbackSchema.safeParse(domainConfigDocument);
  if (!domainConfig.success) fail("provider_readback_invalid");

  const rollingReleaseDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v1/projects/${oompaAppProjectId}/rolling-release`,
  );
  const rollingRelease = rollingReleaseReadbackSchema.safeParse(
    rollingReleaseDocument,
  );
  if (
    !rollingRelease.success
    || rollingRelease.data.rollingRelease?.state === "ACTIVE"
  ) fail("provider_readback_invalid");

  const bulkRedirectDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v1/bulk-redirects?projectId=${oompaAppProjectId}&page=1&per_page=10`,
  );
  const bulkRedirects = bulkRedirectReadbackSchema.safeParse(bulkRedirectDocument);
  let bulkRedirectVersionId: string | null;
  if (bulkRedirects.success) {
    if (bulkRedirects.data.redirects.length !== 0 || bulkRedirects.data.pagination.numPages !== 0) fail("provider_readback_invalid");
    bulkRedirectVersionId = bulkRedirects.data.version?.id ?? null;
  } else {
    // Fresh unconfigured projects omit pagination. Require both exact absence
    // documents under this authenticated sample; errors never imply emptiness.
    if (!unconfiguredBulkRedirectsSchema.safeParse(bulkRedirectDocument).success) fail("provider_readback_invalid");
    const versions = await readProviderJson(fetcher, accessToken,
      `/v1/bulk-redirects/versions?projectId=${oompaAppProjectId}`);
    if (!noBulkRedirectVersionsSchema.safeParse(versions).success) fail("provider_readback_invalid");
    bulkRedirectVersionId = null;
  }

  const firewallDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v1/security/firewall/config?projectId=${oompaAppProjectId}`,
  );
  const configurations = firewallConfigurationsReadbackSchema.safeParse(firewallDocument);
  if (!configurations.success) fail("provider_readback_invalid");
  const firewall = configurations.data.active;
  if (firewall === null && (configurations.data.draft !== null || configurations.data.versions.length !== 0)) fail("provider_readback_invalid");
  // The documented list includes the full active configuration, so the same
  // owner/project/rule guards need no second, potentially different active read.
  const customRedirect = firewall?.firewallEnabled === true
    && firewall.rules.some((rule) =>
      rule.active
      && rule.valid
      && rule.action.mitigate?.action === "redirect"
    );
  const rulesetRedirect = firewall?.firewallEnabled === true
    && firewall.rulesets !== undefined
    && (Array.isArray(firewall.rulesets)
      ? firewall.rulesets.some((ruleset) =>
        ruleset.active && ruleset.action?.mitigate?.action === "redirect"
      )
      : Object.values(firewall.rulesets).some(
        (ruleset) => ruleset.action === "redirect",
      ));
  if (customRedirect || rulesetRedirect) fail("provider_readback_invalid");

  const routeVersionsDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v1/projects/${oompaAppProjectId}/routes/versions`,
  );
  const routeVersions = routeVersionsReadbackSchema.safeParse(
    routeVersionsDocument,
  );
  if (!routeVersions.success) fail("provider_readback_invalid");
  const liveRouteVersions = routeVersions.data.versions.filter(
    (version) => version.isLive === true,
  );
  if (
    liveRouteVersions.length > 1
    || (routeVersions.data.versions.length > 0 && liveRouteVersions.length !== 1)
  ) fail("provider_readback_invalid");
  const liveRouteVersion = liveRouteVersions[0];
  if (liveRouteVersion !== undefined) {
    const exactRoutesDocument = await readProviderJson(
      fetcher,
      accessToken,
      `/v1/projects/${oompaAppProjectId}/routes?versionId=${encodeURIComponent(liveRouteVersion.id)}`,
    );
    const exactRoutes = exactRoutesReadbackSchema.safeParse(exactRoutesDocument);
    if (
      !exactRoutes.success
      || exactRoutes.data.version.id !== liveRouteVersion.id
      || exactRoutes.data.routes.length !== 0
    ) fail("provider_readback_invalid");
  }

  // The list corroborates exact deployment selection. Its optional settings
  // only refuse reported conflicts; complete served bytes supply the mandatory
  // source/output proof instead of inventing omitted historical root settings.
  const deploymentSnapshot = await readExactDeploymentSnapshot(
    fetcher,
    accessToken,
    expected,
  );

  const deploymentDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v13/deployments/${expected.deploymentId}?withGitRepoInfo=true`,
  );
  const deployment = deploymentReadbackSchema.safeParse(deploymentDocument);
  if (
    !deployment.success
    || deployment.data.id !== expected.deploymentId
    || deployment.data.gitSource.sha !== expected.sourceCommit
    || deployment.data.url !== deploymentSnapshot.url
  ) fail("provider_readback_invalid");

  const aliasDocument = await readProviderJson(
    fetcher,
    accessToken,
    `/v4/aliases/${oompaAppAlias}`,
  );
  const alias = aliasReadbackSchema.safeParse(aliasDocument);
  if (
    !alias.success
    || alias.data.deploymentId !== deployment.data.id
    || alias.data.deployment.id !== deployment.data.id
    || alias.data.deployment.url !== deployment.data.url
  ) fail("provider_readback_invalid");
  return Object.freeze({
    aliasUid: alias.data.uid,
    aliasUpdatedAt: alias.data.updatedAt,
    bulkRedirectVersionId,
    deploymentObservedSettingsDigest: canonicalDigest(observedDeploymentSettings(deployment.data.projectSettings)),
    deploymentId: deployment.data.id,
    deploymentUrl: deployment.data.url,
    domainConfiguredBy: domainConfig.data.configuredBy,
    firewallConfigId: firewall?.id ?? null,
    firewallConfigVersion: firewall?.version ?? null,
    firewallEnabled: firewall?.firewallEnabled ?? null,
    projectRouteVersionId: liveRouteVersion?.id ?? null,
    projectBuildSettingsDigest: digestBuildSettings({
      buildCommand: project.data.buildCommand,
      commandForIgnoringBuildStep: project.data.commandForIgnoringBuildStep,
      devCommand: project.data.devCommand,
      framework: project.data.framework,
      installCommand: project.data.installCommand,
      outputDirectory: project.data.outputDirectory,
      rootDirectory: project.data.rootDirectory,
      sourceFilesOutsideRootDirectory: project.data.sourceFilesOutsideRootDirectory,
    }),
    projectId: project.data.id,
    rollingReleaseState: rollingRelease.data.rollingRelease?.state ?? null,
    skewProtectionBoundaryAt,
    skewProtectionMaxAge,
    sourceCommit: deployment.data.gitSource.sha,
    teamId: project.data.accountId,
  });
};

const markerUrl = (nonce: string): string => {
  if (!nonceSchema.safeParse(nonce).success) fail("proof_output_invalid");
  const url = new URL(`https://${oompaAppAlias}/.well-known/oompa-app.json`);
  url.searchParams.set("proof", nonce);
  return url.href;
};

const readMarker = async (
  fetcher: AuthorityFetcher,
  expected: AppSourceProofArguments,
  nonce: string,
): Promise<Readonly<{ marker: z.infer<typeof markerSchema>; artifact: AppSourceArtifact }>> => {
  const url = markerUrl(nonce);
  try {
    const response = await fetcher(url, {
      cache: "no-store",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      method: "GET",
      redirect: "error",
    });
    const cacheControl = response.headers.get("cache-control");
    if (
      !hasAppArtifactSecurityHeaders(response)
      || cacheControl === null
      || !cacheControl.split(",").some((directive) => directive.trim().toLowerCase() === "no-store")
    ) {
      await response.body?.cancel().catch(() => undefined);
      fail("marker_readback_invalid");
    }
    let artifact: AppSourceArtifact | undefined;
    const parsed = markerSchema.safeParse(await readBoundedJson(
      response,
      url,
      markerMaximumBytes,
      "marker_readback_invalid",
      (bytes) => { artifact = { path: ".well-known/oompa-app.json", bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex") }; },
    ));
    if (
      !parsed.success
      || parsed.data.source.commit !== expected.sourceCommit
      || parsed.data.version !== expected.releaseVersion
    ) fail("marker_readback_invalid");
    if (artifact === undefined) fail("marker_readback_invalid");
    return { marker: parsed.data, artifact };
  } catch (error: unknown) {
    if (error instanceof AppSourceProofError) throw error;
    fail("marker_readback_invalid");
  }
};

const samplesEqual = (left: ProviderSample, right: ProviderSample): boolean =>
  left.aliasUid === right.aliasUid
  && left.aliasUpdatedAt === right.aliasUpdatedAt
  && left.bulkRedirectVersionId === right.bulkRedirectVersionId
  && left.deploymentObservedSettingsDigest === right.deploymentObservedSettingsDigest
  && left.deploymentId === right.deploymentId
  && left.deploymentUrl === right.deploymentUrl
  && left.domainConfiguredBy === right.domainConfiguredBy
  && left.firewallConfigId === right.firewallConfigId
  && left.firewallConfigVersion === right.firewallConfigVersion
  && left.firewallEnabled === right.firewallEnabled
  && left.projectRouteVersionId === right.projectRouteVersionId
  && left.projectBuildSettingsDigest === right.projectBuildSettingsDigest
  && left.projectId === right.projectId
  && left.rollingReleaseState === right.rollingReleaseState
  && left.skewProtectionBoundaryAt === right.skewProtectionBoundaryAt
  && left.skewProtectionMaxAge === right.skewProtectionMaxAge
  && left.sourceCommit === right.sourceCommit
  && left.teamId === right.teamId;

const renderFailure = (error: unknown, stderr: OutputWriter): number => {
  const code = error instanceof AppSourceProofError
    ? error.code
    : "proof_output_invalid";
  stderr.write(`${JSON.stringify({ code, schemaVersion: 1, status: "refused" })}\n`);
  return code === "usage_invalid" ? 64 : 1;
};

export const readRetainedAppSourceProof = (
  path: string,
  expected: RetainedAppSourceProofArguments,
): AppSourceProofEvidence => {
  try {
    const proof = readProtectedJson(path, appSourceProofEvidenceSchema, {
      recoverInterruptedPublication: true,
    });
    if (
      proof.sourceCommit !== expected.sourceCommit
      || proof.releaseVersion !== expected.releaseVersion
    ) fail("retained_proof_invalid");
    return proof;
  } catch (error: unknown) {
    if (error instanceof AppSourceProofError) throw error;
    fail("retained_proof_invalid");
  }
};

export const executeRetainedAppSourceProofVerification = (
  options: ExecuteRetainedAppSourceProofOptions,
): number => {
  try {
    assertAppSourceProofBunVersion(options.runtimeVersion);
    const expected = parseRetainedAppSourceProofArguments(options.arguments);
    const sourceReader = options.sourceState ?? readLocalSourceState;
    assertExactSourceState(
      sourceReader(),
      expected.sourceCommit,
    );
    const proof = (options.proofReader ?? readRetainedAppSourceProof)(
      expected.evidencePath,
      expected,
    );
    assertExactSourceState(sourceReader(), expected.sourceCommit);
    const output = `${JSON.stringify({
      evidenceDigest: proof.selfDigest,
      kind: "hra-app-source-proof-verification",
      releaseVersion: proof.releaseVersion,
      schemaVersion: 1,
      sourceCommit: proof.sourceCommit,
      status: "verified",
    })}\n`;
    if (Buffer.byteLength(output, "utf8") > outputMaximumBytes) {
      fail("retained_proof_invalid");
    }
    options.stdout.write(output);
    return 0;
  } catch (error: unknown) {
    const closed = error instanceof AppSourceProofError
      ? error
      : new AppSourceProofError("retained_proof_invalid");
    return renderFailure(closed, options.stderr);
  }
};

export const executeAppSourceProof = async (
  options: ExecuteAppSourceProofOptions,
): Promise<number> => {
  let observationTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    assertAppSourceProofBunVersion(options.runtimeVersion);
    const expected = parseAppSourceProofArguments(options.arguments);
    const sourceReader = options.sourceState ?? readLocalSourceState;
    const sourceBefore = sourceReader();
    assertExactSourceState(sourceBefore, expected.sourceCommit);
    const artifactReader = options.artifactReader ?? readLocalAppArtifactProof;
    const localArtifacts = appLocalArtifactProofSchema.parse(await artifactReader(expected));
    if (localArtifacts.sourceCommit !== expected.sourceCommit || localArtifacts.releaseVersion !== expected.releaseVersion) {
      fail("artifact_readback_invalid");
    }
    if (!accessTokenSchema.safeParse(options.accessToken).success) {
      fail("provider_credentials_refused");
    }
    const requestFetcher = createBoundedAuthorityFetch(
      options.fetcher ?? fetch,
      providerRequestTimeoutMs,
      "app_source_proof_timeout",
    );
    const deadline = new AbortController();
    let requests = 0;
    observationTimer = setTimeout(() => { deadline.abort(); }, observationMaximumMs);
    const fetcher: AuthorityFetcher = async (input, init) => {
      if (++requests > 128 || deadline.signal.aborted) fail("authority_changed_during_observation");
      return await requestFetcher(input, { ...init,
        signal: init?.signal == null ? deadline.signal : AbortSignal.any([init.signal, deadline.signal]) });
    };
    const clock = options.clock ?? (() => new Date());
    const monotonicClock = options.monotonicClock ?? (() => performance.now());
    const started = clock();
    const startedAt = started.toISOString();
    const startedMonotonic = monotonicClock();
    const nonce = (options.nonce ?? randomUUID)();
    if (!nonceSchema.safeParse(nonce).success) fail("proof_output_invalid");
    const before = await readProviderSample(fetcher, options.accessToken, expected);
    const observedMarker = await readMarker(fetcher, expected, nonce);
    const publicArtifacts = await observePublicAppArtifacts({ local: localArtifacts,
      marker: observedMarker.artifact, nonce, fetcher });
    const marker = observedMarker.marker;
    const after = await readProviderSample(fetcher, options.accessToken, expected);
    if (!samplesEqual(before, after)) fail("authority_changed_during_observation");
    const localArtifactsAfter = appLocalArtifactProofSchema.parse(await artifactReader(expected));
    if (canonicalDigest(localArtifactsAfter) !== canonicalDigest(localArtifacts)) fail("authority_changed_during_observation");
    const sourceAfter = sourceReader();
    assertExactSourceState(sourceAfter, expected.sourceCommit);

    const completed = clock();
    const completedMonotonic = monotonicClock();
    if (
      completed.getTime() < started.getTime()
      || completed.getTime() - started.getTime() > observationMaximumMs
      || !Number.isFinite(startedMonotonic)
      || !Number.isFinite(completedMonotonic)
      || completedMonotonic < startedMonotonic
      || completedMonotonic - startedMonotonic > observationMaximumMs
    ) fail("authority_changed_during_observation");
    const completedAt = completed.toISOString();
    const proof = appSourceProofEvidenceSchema.parse(withSelfDigest({
      alias: oompaAppAlias,
      aliasUid: after.aliasUid,
      aliasUpdatedAt: after.aliasUpdatedAt,
      branch: oompaAppBranch,
      bulkRedirectVersionId: after.bulkRedirectVersionId,
      cacheControl: "no-store",
      completedAt,
      deploymentObservedSettingsDigest: after.deploymentObservedSettingsDigest,
      deploymentRootSettingsAuthority: "not-attested",
      publicArtifacts,
      deploymentId: after.deploymentId,
      deploymentUrl: after.deploymentUrl,
      domainConfiguredBy: after.domainConfiguredBy,
      firewallConfigId: after.firewallConfigId,
      firewallConfigVersion: after.firewallConfigVersion,
      firewallEnabled: after.firewallEnabled,
      kind: "hra-app-source-proof",
      marker,
      observationBoundary: "sequential-readback-without-provider-lock",
      projectBuildSettingsDigest: after.projectBuildSettingsDigest,
      projectId: oompaAppProjectId,
      projectRouteVersionId: after.projectRouteVersionId,
      readyState: "READY",
      releaseVersion: expected.releaseVersion,
      repositoryId: oompaAppRepositoryId,
      rollingReleaseState: after.rollingReleaseState,
      schemaVersion: 4,
      skewProtectionBoundaryAt: after.skewProtectionBoundaryAt,
      skewProtectionMaxAge: after.skewProtectionMaxAge,
      sourceCommit: expected.sourceCommit,
      sourceRemoteMainCommit: sourceAfter.remoteMainCommit,
      startedAt,
      target: "production",
      teamId: oompaAppTeamId,
      verifierIndexTransparent: true,
      verifierSourceCommit: sourceAfter.commit,
      verifierTrackedAndUntrackedClean: true,
    } as const));
    const document = `${JSON.stringify(proof)}\n`;
    if (Buffer.byteLength(document, "utf8") > outputMaximumBytes) {
      fail("proof_output_invalid");
    }
    (options.evidenceWriter ?? ((path, evidence) => {
      writeProtectedJsonNoReplace(path, evidence, appSourceProofEvidenceSchema);
    }))(expected.evidencePath, proof);
    options.stdout.write(document);
    return 0;
  } catch (error: unknown) {
    return renderFailure(error instanceof AppSourceArtifactError
      ? new AppSourceProofError("artifact_readback_invalid") : error, options.stderr);
  } finally { if (observationTimer !== undefined) clearTimeout(observationTimer); }
};

if (import.meta.main) {
  let exitCode = 1;
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] === "--verify-retained") {
    exitCode = executeRetainedAppSourceProofVerification({
      arguments: arguments_.slice(1),
      stderr: process.stderr,
      stdout: process.stdout,
    });
  } else {
    try {
      assertAppSourceProofBunVersion();
      const expected = parseAppSourceProofArguments(arguments_);
      const initialSourceState = readLocalSourceState();
      assertExactSourceState(initialSourceState, expected.sourceCommit);
      const accessToken = readProtectedVercelAccessToken(expected.vercelAuthFd);
      let useInitialSourceState = true;
      exitCode = await executeAppSourceProof({
        accessToken,
        arguments: arguments_,
        sourceState: () => {
          if (useInitialSourceState) {
            useInitialSourceState = false;
            return initialSourceState;
          }
          return readLocalSourceState();
        },
        stderr: process.stderr,
        stdout: process.stdout,
      });
    } catch (error: unknown) {
      const closedError = error instanceof AppSourceProofError
        ? error
        : new AppSourceProofError("provider_credentials_refused");
      exitCode = renderFailure(closedError, process.stderr);
    }
  }
  process.exitCode = exitCode;
}
