import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { chmod, link, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  assertCurrentAliasReleaseBunVersion,
  assertCurrentAliasReleaseScanCapacity,
  assertCurrentAliasReleaseStateCapacity,
  buildVercelEnvironment,
  currentAliasReleaseApiArguments,
  currentAliasReleaseProviderActivityEvidenceSchema,
  currentAliasReleaseReviewedLegacyOperatorProvenance,
  currentAliasReleaseVercelApiRequest,
  currentAliasReleaseIntentSchema,
  currentAliasReleaseIntentFor,
  currentAliasReleasePlanDigest,
  currentAliasReleaseMutationKey,
  currentAliasReleaseReceiptSchema,
  currentAliasReleaseSourceRecoveryFor,
  currentAliasReleaseSourceRecoverySchema,
  currentAliasReleaseStateEntryMaximum,
  currentAliasReleaseStatePaths,
  currentAliasReleaseTargetPhaseSchema,
  currentAliasReleaseTargetPhaseForMutationResponse,
  currentAliasReleaseTargetPhaseForProviderActivity,
  CurrentAliasReleaseError,
  executeCurrentProjectAliasReleaseWithExplicitApiCapability,
  executeCurrentProjectAliasReleaseWithExplicitCapability,
  observeCurrentAliasAuthority,
  parseArguments,
  parseCurrentDeploymentReadback,
  parseCurrentProjectAliasReleasePlan,
  readProtectedProviderActivityEvidenceFile,
  requiredAliasConfirmation,
  type CurrentAliasReadback,
  type CurrentDeploymentReadback,
  type CurrentProjectAliasEndpoint,
  type CurrentProjectAliasReleasePlan,
  type CurrentProjectAliasReleaseProvider,
  type CurrentProjectReadback,
  type ProviderActivityTargetEvidence,
} from "./current-project-alias-release";
import {
  OOMPA_CONVEX_PROJECT_ID,
  OOMPA_CONVEX_TEAM_ID,
  type ConvexTarget,
} from "./convex-target";
import {
  OOMPA_RELEASE_VERSION,
  OOMPA_REPOSITORY,
  OOMPA_REPOSITORY_ID,
  OOMPA_VERCEL_PROJECT_ID,
  OOMPA_VERCEL_TEAM_ID,
  readProtectedJson,
  withSelfDigest,
} from "./release-evidence";
import {
  assertPrivateDescriptorFixtureProvenance,
  parsePrivateDescriptorFixtureRequest,
  runPrivateDescriptorFixture,
  type PrivateDescriptorFixtureOperation,
} from "./private-descriptor-test-fixture";

const source: CurrentProjectAliasEndpoint = {
  deploymentId: "dpl_SourceCurrent1234567890123",
  deploymentUrl: "oompa-source-current-hraness.vercel.app",
  sourceCommit: "1".repeat(40),
};

const target: CurrentProjectAliasEndpoint = {
  deploymentId: "dpl_TargetCurrent1234567890123",
  deploymentUrl: "oompa-target-current-hraness.vercel.app",
  sourceCommit: "2".repeat(40),
};

const convex: ConvexTarget = {
  deploymentId: 5_089_017,
  deploymentName: "qualified-hummingbird-537",
  deploymentUrl: "https://qualified-hummingbird-537.convex.cloud",
  projectId: OOMPA_CONVEX_PROJECT_ID,
  teamId: OOMPA_CONVEX_TEAM_ID,
};

const plan: CurrentProjectAliasReleasePlan = {
  alias: "oompa.app",
  convex,
  idempotencyKey: "607f32a6-98a9-4597-b54e-32e72fe32b56",
  kind: "current-project-canonical-alias",
  repository: { id: OOMPA_REPOSITORY_ID, name: OOMPA_REPOSITORY },
  schemaVersion: 1,
  vercel: {
    projectId: OOMPA_VERCEL_PROJECT_ID,
    source,
    target,
    teamId: OOMPA_VERCEL_TEAM_ID,
  },
  version: OOMPA_RELEASE_VERSION,
};

const cliSourcePlan: CurrentProjectAliasReleasePlan = {
  ...plan,
  vercel: {
    ...plan.vercel,
    sourceProvenance: {
      actor: "cursor-cli",
      gitCommitRef: "HEAD",
      gitRootDirectory: "",
      kind: "vercel-cli-public-marker",
    },
  },
};

const withStateDirectory = async <Value>(
  operation: (directory: string) => Promise<Value>,
): Promise<Value> => {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "oompa-alias-release-state-")),
  );
  await chmod(directory, 0o700);
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
};

function consumePrivateFixtureDescriptor(
  descriptor: number,
  operation: PrivateDescriptorFixtureOperation,
  expected: Readonly<{ mode: number; nlink: 1 | 2 }>,
) {
  try {
    const metadata = fstatSync(descriptor);
    expect(metadata.mode & 0o777).toBe(expected.mode);
    expect(metadata.nlink).toBe(expected.nlink);
    const result = runPrivateDescriptorFixture(descriptor, operation);
    expect(result.descriptor).toBe(3);
    expect(result.closure).toBe("reader");
    expect(result.effects).toBe(0);
    return result;
  } finally {
    // The real reader closes the child's FD3; the parent owns its original FD.
    closeSync(descriptor);
  }
}

const deploymentFor = (
  endpoint: CurrentProjectAliasEndpoint,
): CurrentDeploymentReadback => ({
  gitSource: {
    ref: "main",
    repoId: OOMPA_REPOSITORY_ID,
    sha: endpoint.sourceCommit,
    type: "github",
  },
  id: endpoint.deploymentId,
  projectId: OOMPA_VERCEL_PROJECT_ID,
  readyState: "READY",
  source: "git",
  target: "production",
  url: endpoint.deploymentUrl,
});

const cliDeploymentFor = (
  endpoint: CurrentProjectAliasEndpoint,
): CurrentDeploymentReadback => ({
  gitSource: null,
  id: endpoint.deploymentId,
  meta: {
    actor: "cursor-cli",
    gitCommitRef: "HEAD",
    gitCommitSha: endpoint.sourceCommit,
    gitRootDirectory: "",
  },
  projectId: OOMPA_VERCEL_PROJECT_ID,
  readyState: "READY",
  source: "cli",
  target: "production",
  url: endpoint.deploymentUrl,
});

const cliDeploymentWithoutGitSourceFor = (
  endpoint: CurrentProjectAliasEndpoint,
): Readonly<Record<string, unknown>> => {
  const readback: Record<string, unknown> = { ...cliDeploymentFor(endpoint) };
  delete readback.gitSource;
  return readback;
};

const aliasFor = (endpoint: CurrentProjectAliasEndpoint): CurrentAliasReadback => ({
  alias: "oompa.app",
  deployment: { id: endpoint.deploymentId, url: endpoint.deploymentUrl },
  deploymentId: endpoint.deploymentId,
  projectId: OOMPA_VERCEL_PROJECT_ID,
});

const projectReadback: CurrentProjectReadback = {
  accountId: OOMPA_VERCEL_TEAM_ID,
  autoAssignCustomDomains: false,
  id: OOMPA_VERCEL_PROJECT_ID,
};

const markerFor = (endpoint: CurrentProjectAliasEndpoint): unknown => ({
  generation: 1,
  product: "Oompa",
  repository: { id: OOMPA_REPOSITORY_ID, path: OOMPA_REPOSITORY },
  schemaVersion: 2,
  source: { commit: endpoint.sourceCommit },
  version: OOMPA_RELEASE_VERSION,
});

const markerWithVersion = (
  endpoint: CurrentProjectAliasEndpoint,
  version: string,
): unknown => ({
  ...markerFor(endpoint) as object,
  version,
});

const providerActivityText = `Assigned an alias to ${target.deploymentUrl}`;

const providerActivityEvidenceFor = (
  intentPublishedAtMs: number,
): ProviderActivityTargetEvidence => {
  const updatedAtMs = Math.ceil(intentPublishedAtMs) + 1;
  const createdAtMs = updatedAtMs + 500;
  return currentAliasReleaseProviderActivityEvidenceSchema.parse(withSelfDigest({
    activity: {
      createdAtMs,
      eventId: `uev_${"a".repeat(24)}`,
      principalId: "operator_fixture",
      textSha256: createHash("sha256").update(providerActivityText).digest("hex"),
    },
    alias: {
      createdAtMs: Math.max(0, Math.floor(intentPublishedAtMs) - 1_000),
      uid: "alias_CurrentOompa12345678901234567890",
      updatedAtMs,
    },
    custody: { soleWriterConfirmed: true },
    intentPublishedAtMs,
    kind: "provider-activity-and-operator-provenance",
    observedTargetMarkerVersion: "0.1.99",
    operator: currentAliasReleaseReviewedLegacyOperatorProvenance,
  }));
};

const providerActivityEvidence = providerActivityEvidenceFor(1_787_961_600_000);

const seedLegacyIntent = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  stateDirectory: string,
): Promise<ReturnType<typeof currentAliasReleaseStatePaths>> => {
  const paths = currentAliasReleaseStatePaths(inputPlan, stateDirectory);
  await writeFile(
    paths.intent,
    `${JSON.stringify(currentAliasReleaseIntentFor(inputPlan))}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return paths;
};

const seedTargetPhase = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  stateDirectory: string,
): Promise<Readonly<{
  intent: ReturnType<typeof currentAliasReleaseIntentFor>;
  paths: ReturnType<typeof currentAliasReleaseStatePaths>;
  targetPhase: ReturnType<typeof currentAliasReleaseTargetPhaseForMutationResponse>;
}>> => {
  const paths = await seedLegacyIntent(inputPlan, stateDirectory);
  const intent = currentAliasReleaseIntentFor(inputPlan);
  const targetPhase = currentAliasReleaseTargetPhaseForMutationResponse(
    inputPlan,
    intent,
    {
      alias: "oompa.app",
      created: 1_787_961_600_000,
      oldDeploymentId: inputPlan.vercel.source.deploymentId,
      uid: "alias_CurrentOompa1234567890",
    },
  );
  await writeFile(paths.targetPhase, `${JSON.stringify(targetPhase)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { intent, paths, targetPhase };
};

type AliasState = "source" | "target" | "unknown";
type TargetSetBehavior = "commit" | "commit-and-throw" | "noop" | "throw";

class FakeProvider implements CurrentProjectAliasReleaseProvider {
  activePlan: CurrentProjectAliasReleasePlan = plan;
  activityEvidenceFailure = false;
  aliasState: AliasState = "source";
  afterReadMarker?: () => Promise<void> | void;
  beforeReadAlias?: () => Promise<void> | void;
  beforeSetAlias?: (endpoint: CurrentProjectAliasEndpoint) => Promise<void> | void;
  breakTargetDeployment = false;
  breakTargetMarker = false;
  failSourceSet = false;
  failVerifyVercelAt = 0;
  failVerifyVercelWhileTarget = false;
  mutationOldDeploymentIdOverride: string | undefined;
  readonly operations: string[] = [];
  sourceDeploymentOverride: CurrentDeploymentReadback | undefined;
  sourceVisibilityLagReads = 0;
  sourceSetCommitAndThrow = false;
  sourceMarkerOverride: unknown;
  targetMarkerOverride: unknown;
  targetDeploymentOverride: CurrentDeploymentReadback | undefined;
  #staleAliasState: AliasState | undefined;
  #staleReadsRemaining = 0;
  targetVisibilityLagReads = 0;
  targetSetBehavior: TargetSetBehavior = "commit";
  #verifyVercelReads = 0;

  async verifyVercelVersion(): Promise<void> {
    this.#verifyVercelReads += 1;
    this.operations.push("verify-vercel");
    if (
      this.#verifyVercelReads === this.failVerifyVercelAt
      || this.failVerifyVercelWhileTarget && this.aliasState === "target"
    ) {
      throw new CurrentAliasReleaseError("provider_command_failed");
    }
  }

  async verifyTargetActivityEvidence(
    inputPlan: CurrentProjectAliasReleasePlan,
    evidence: ProviderActivityTargetEvidence,
  ): Promise<void> {
    this.operations.push(`verify-target-activity:${evidence.activity.eventId}`);
    expect(inputPlan).toEqual(this.activePlan);
    if (this.activityEvidenceFailure) {
      throw new CurrentAliasReleaseError("provider_readback_invalid");
    }
  }

  async verifyConvexTarget(targetValue: ConvexTarget): Promise<void> {
    this.operations.push(`verify-convex:${String(targetValue.deploymentId)}`);
    expect(targetValue).toEqual(convex);
  }

  async readProject(): Promise<CurrentProjectReadback> {
    this.operations.push("read-project");
    return projectReadback;
  }

  async readDeployment(deploymentId: string): Promise<CurrentDeploymentReadback> {
    this.operations.push(`read-deployment:${deploymentId}`);
    if (deploymentId === source.deploymentId) {
      if (this.sourceDeploymentOverride !== undefined) {
        return this.sourceDeploymentOverride;
      }
      return this.activePlan.vercel.sourceProvenance === undefined
        ? deploymentFor(source)
        : cliDeploymentFor(source);
    }
    const readback = this.targetDeploymentOverride ?? deploymentFor(target);
    return this.breakTargetDeployment
      ? { ...readback, url: "oompa-wrong-current-hraness.vercel.app" }
      : readback;
  }

  async readAlias(): Promise<CurrentAliasReadback> {
    await this.beforeReadAlias?.();
    const observedState = this.#staleReadsRemaining > 0
      ? this.#staleAliasState ?? this.aliasState
      : this.aliasState;
    if (this.#staleReadsRemaining > 0) this.#staleReadsRemaining -= 1;
    this.operations.push(`read-alias:${observedState}`);
    if (observedState === "source") return aliasFor(source);
    if (observedState === "target") return aliasFor(target);
    return aliasFor({
      deploymentId: "dpl_UnknownCurrent12345678901",
      deploymentUrl: "oompa-unknown-current-hraness.vercel.app",
      sourceCommit: "3".repeat(40),
    });
  }

  async readMarker(): Promise<unknown> {
    this.operations.push(`read-marker:${this.aliasState}`);
    const marker = this.aliasState === "target"
      ? this.targetMarkerOverride
        ?? (this.breakTargetMarker ? markerFor(source) : markerFor(target))
      : this.sourceMarkerOverride ?? markerFor(source);
    await this.afterReadMarker?.();
    return marker;
  }

  async setAlias(
    endpoint: CurrentProjectAliasEndpoint,
    idempotencyKey: string,
  ): Promise<Readonly<{
    alias: "oompa.app";
    created: number;
    oldDeploymentId: string;
    uid: string;
  }>> {
    const deploymentUrl = endpoint.deploymentUrl;
    const oldDeploymentId = this.aliasState === "source"
      ? source.deploymentId
      : this.aliasState === "target"
        ? target.deploymentId
        : "dpl_UnknownCurrent12345678901";
    const response = {
      alias: "oompa.app" as const,
      created: 1_787_961_600_000,
      oldDeploymentId: this.mutationOldDeploymentIdOverride ?? oldDeploymentId,
      uid: "alias_CurrentOompa1234567890",
    };
    expect(idempotencyKey).toBe(currentAliasReleaseMutationKey(
      this.activePlan,
      deploymentUrl === source.deploymentUrl ? "restore-source" : "assign-target",
    ));
    await this.beforeSetAlias?.(endpoint);
    this.operations.push(`set-alias:${deploymentUrl}`);
    if (deploymentUrl === source.deploymentUrl) {
      if (this.failSourceSet) throw new Error("source restoration failed");
      this.#staleAliasState = this.aliasState;
      this.#staleReadsRemaining = this.sourceVisibilityLagReads;
      this.aliasState = "source";
      if (this.sourceSetCommitAndThrow) throw new Error("ambiguous source result");
      return response;
    }
    expect(deploymentUrl).toBe(target.deploymentUrl);
    if (this.targetSetBehavior === "commit" || this.targetSetBehavior === "commit-and-throw") {
      this.#staleAliasState = this.aliasState;
      this.#staleReadsRemaining = this.targetVisibilityLagReads;
      this.aliasState = "target";
    }
    if (this.targetSetBehavior === "commit-and-throw" || this.targetSetBehavior === "throw") {
      throw new Error("ambiguous provider result");
    }
    return response;
  }
}

type DirectTransportMode =
  | "ok"
  | "mutation-malformed"
  | "mutation-rejected"
  | "recover-source"
  | "target-unprovable-restore-rejected";

class FakeDirectVercelTransport {
  activityCreatedOffset = 0;
  activityEvidence: ProviderActivityTargetEvidence | undefined;
  activityEventCount = 1;
  aliasState: "source" | "target" = "source";
  mode: DirectTransportMode = "ok";
  readonly requests: Readonly<{ init: RequestInit; url: string }>[] = [];

  readonly fetch = async (
    input: string | URL | Request,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = input instanceof Request
      ? input.url
      : input instanceof URL
        ? input.href
        : input;
    this.requests.push({ init, url });
    const json = (value: unknown, status = 200): Response => new Response(
      JSON.stringify(value),
      { headers: { "content-type": "application/json" }, status },
    );
    if (url.startsWith("https://oompa.app/.well-known/hra.json?release=")) {
      const headers = new Headers(init.headers);
      expect(headers.has("authorization")).toBeFalse();
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      if (this.aliasState === "source") return json(markerFor(source));
      if (this.mode === "target-unprovable-restore-rejected") {
        return json(markerFor(source));
      }
      if (this.mode === "recover-source") {
        return json(markerWithVersion(
          target,
          this.activityEvidence?.observedTargetMarkerVersion ?? "0.1.99",
        ));
      }
      return json(markerFor(target));
    }

    const parsedUrl = new URL(url);
    expect(parsedUrl.origin).toBe("https://api.vercel.com");
    expect(parsedUrl.searchParams.get("teamId")).toBe(OOMPA_VERCEL_TEAM_ID);
    if (parsedUrl.pathname !== "/v3/events") {
      expect([...parsedUrl.searchParams.keys()]).toEqual(["teamId"]);
    }
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer fixture-vercel-token");
    expect(headers.get("accept")).toBe("application/json");
    expect(init.redirect).toBe("error");

    if (init.method === "POST") {
      const targetPath = `/v2/deployments/${target.deploymentId}/aliases`;
      const sourcePath = `/v2/deployments/${source.deploymentId}/aliases`;
      expect([sourcePath, targetPath]).toContain(parsedUrl.pathname);
      expect(init.body).toBe(JSON.stringify({ alias: "oompa.app" }));
      expect(headers.get("content-type")).toBe("application/json");
      const assigningTarget = parsedUrl.pathname === targetPath;
      expect(headers.get("idempotency-key")).toBe(currentAliasReleaseMutationKey(
        cliSourcePlan,
        assigningTarget ? "assign-target" : "restore-source",
      ));
      if (!assigningTarget) {
        if (this.mode === "target-unprovable-restore-rejected") {
          return json({ error: "restore refused" }, 500);
        }
        expect(this.mode).toBe("recover-source");
        this.aliasState = "source";
        return json({
          alias: "oompa.app",
          created: 1_787_961_603_000,
          oldDeploymentId: target.deploymentId,
          uid: "alias_CurrentOompa1234567890",
        });
      }
      if (this.mode === "mutation-rejected") return json({ error: "refused" }, 500);
      if (this.mode === "mutation-malformed") {
        this.aliasState = "target";
        return json({ alias: "oompa.app" });
      }
      this.aliasState = "target";
      return json({
        alias: "oompa.app",
        created: 1_787_961_600_000,
        oldDeploymentId: source.deploymentId,
        uid: "alias_CurrentOompa1234567890",
      });
    }

    expect(init.method).toBe("GET");
    if (parsedUrl.pathname === `/v9/projects/${OOMPA_VERCEL_PROJECT_ID}`) {
      return json(projectReadback);
    }
    if (parsedUrl.pathname === `/v13/deployments/${source.deploymentId}`) {
      return json(cliDeploymentWithoutGitSourceFor(source));
    }
    if (parsedUrl.pathname === `/v13/deployments/${target.deploymentId}`) {
      return json(deploymentFor(target));
    }
    if (parsedUrl.pathname === "/v4/aliases/oompa.app") {
      const alias = aliasFor(this.aliasState === "source" ? source : target);
      return json(this.activityEvidence === undefined
        ? alias
        : {
            ...alias,
            createdAt: this.activityEvidence.alias.createdAtMs,
            uid: this.activityEvidence.alias.uid,
            updatedAt: this.activityEvidence.alias.updatedAtMs,
          });
    }
    if (parsedUrl.pathname === `/v2/deployments/${target.deploymentId}/aliases`) {
      return json({
        aliases: this.activityEvidence === undefined
          ? []
          : [{ alias: "oompa.app", uid: this.activityEvidence.alias.uid }],
      });
    }
    if (parsedUrl.pathname === `/v2/deployments/${source.deploymentId}/aliases`) {
      return json({ aliases: [] });
    }
    if (parsedUrl.pathname === "/v3/events") {
      const evidence = this.activityEvidence;
      if (evidence === undefined) throw new Error("unexpected_activity_read");
      expect(parsedUrl.searchParams.get("limit")).toBe("100");
      expect(parsedUrl.searchParams.get("types")).toBe("aliases-assigned");
      expect(parsedUrl.searchParams.has("withPayload")).toBeFalse();
      expect(parsedUrl.searchParams.has("projectIds")).toBeFalse();
      expect(parsedUrl.searchParams.has("until")).toBeFalse();
      const boldStart = providerActivityText.indexOf("an alias");
      const deploymentStart = providerActivityText.indexOf(target.deploymentUrl);
      const event = (index: number) => ({
        categories: ["domain", "project"],
        created: evidence.activity.createdAtMs + index * 10_000
          + this.activityCreatedOffset,
        createdAt: evidence.activity.createdAtMs + index * 10_000,
        entities: [
          { end: boldStart + "an alias".length, start: boldStart, type: "bold" },
          {
            end: deploymentStart + target.deploymentUrl.length,
            start: deploymentStart,
            type: "deployment_host",
          },
        ],
        id: index === 0 ? evidence.activity.eventId : `uev_${String(index).padStart(24, "b")}`,
        principal: { uid: evidence.activity.principalId },
        principalId: evidence.activity.principalId,
        text: providerActivityText,
        type: "aliases-assigned" as const,
        user: { uid: evidence.activity.principalId },
        userId: evidence.activity.principalId,
      });
      return json({
        events: Array.from({ length: this.activityEventCount }, (_, index) => event(index)),
      });
    }
    throw new Error(`unexpected_request:${url}`);
  };
}

const immediateClock = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

const runConfirmedCli = async (
  operation: "execute" | "recover-source",
  inputPlan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  stateDirectory: string,
  options: Readonly<{
    afterIntentPublication?: () => void;
    clock?: ReturnType<typeof immediateClock>;
    providerActivityEvidence?: ProviderActivityTargetEvidence;
    receiptWriter?: () => void;
    timeoutMs?: number;
  }> = {},
): Promise<Readonly<{ exitCode: number; stderr: string[]; stdout: string[] }>> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
    {
      provider,
      ...(options.afterIntentPublication === undefined
        ? {}
        : { afterIntentPublication: options.afterIntentPublication }),
      ...(options.providerActivityEvidence === undefined
        ? {}
        : { providerActivityEvidence: options.providerActivityEvidence }),
      ...(options.receiptWriter === undefined
        ? {}
        : { receiptWriter: options.receiptWriter }),
      stateDirectory,
    },
    {
      arguments: [
        operation === "execute" ? "--execute" : "recover-source",
        "--vercel-auth-fd",
        "3",
        "--confirm-exact",
        requiredAliasConfirmation(inputPlan),
      ],
      clock: options.clock ?? immediateClock(),
      inputDocument: JSON.stringify(inputPlan),
      stderr: { write: (value) => {
        stderr.push(String(value));
        return true;
      } },
      stdout: { write: (value) => {
        stdout.push(String(value));
        return true;
      } },
      timeoutMs: options.timeoutMs ?? 1,
    },
  );
  return { exitCode, stderr, stdout };
};

const runExecuteCli = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  stateDirectory: string,
  options: Readonly<{
    afterIntentPublication?: () => void;
    clock?: ReturnType<typeof immediateClock>;
    providerActivityEvidence?: ProviderActivityTargetEvidence;
    receiptWriter?: () => void;
    timeoutMs?: number;
  }> = {},
): Promise<Readonly<{ exitCode: number; stderr: string[]; stdout: string[] }>> =>
  await runConfirmedCli("execute", inputPlan, provider, stateDirectory, options);

const runRecoverSourceCli = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  stateDirectory: string,
  options: Readonly<{
    afterIntentPublication?: () => void;
    clock?: ReturnType<typeof immediateClock>;
    providerActivityEvidence?: ProviderActivityTargetEvidence;
    receiptWriter?: () => void;
    timeoutMs?: number;
  }> = {},
): Promise<Readonly<{ exitCode: number; stderr: string[]; stdout: string[] }>> =>
  await runConfirmedCli("recover-source", inputPlan, provider, stateDirectory, options);

const runPreflightCli = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  provider: CurrentProjectAliasReleaseProvider,
  stateDirectory: string,
): Promise<Readonly<{ exitCode: number; stderr: string[]; stdout: string[] }>> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
    { provider, stateDirectory },
    {
      arguments: ["preflight", "--vercel-auth-fd", "3"],
      inputDocument: JSON.stringify(inputPlan),
      stderr: { write: (value) => {
        stderr.push(String(value));
        return true;
      } },
      stdout: { write: (value) => {
        stdout.push(String(value));
        return true;
      } },
    },
  );
  return { exitCode, stderr, stdout };
};

const runDirectApiCli = async (
  inputPlan: CurrentProjectAliasReleasePlan,
  transport: FakeDirectVercelTransport,
  stateDirectory: string,
  operation: "execute" | "preflight" | "recover-source",
  confirmation = requiredAliasConfirmation(inputPlan),
  providerActivityEvidence?: ProviderActivityTargetEvidence,
  inputMode: "descriptor" | "file" = "descriptor",
): Promise<Readonly<{
  convexCalls: number;
  exitCode: number;
  stderr: string[];
  stdout: string[];
}>> => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let convexCalls = 0;
  const inputArguments = inputMode === "descriptor"
    ? ["--vercel-auth-fd", "3"]
    : ["--vercel-auth-file", "/fixture/auth.json", "--plan-file", "/fixture/plan.json"];
  const exitCode = await executeCurrentProjectAliasReleaseWithExplicitApiCapability(
    {
      accessToken: "fixture-vercel-token",
      convexVerifier: async (targetValue) => {
        convexCalls += 1;
        expect(targetValue).toEqual(convex);
      },
      fetcher: transport.fetch,
      ...(providerActivityEvidence === undefined ? {} : { providerActivityEvidence }),
      stateDirectory,
    },
    {
      arguments: operation === "preflight"
        ? ["preflight", ...inputArguments]
        : [
            operation === "execute" ? "--execute" : "recover-source",
            ...inputArguments,
            "--confirm-exact",
            confirmation,
          ],
      clock: immediateClock(),
      inputDocument: JSON.stringify(inputPlan),
      stderr: { write: (value) => {
        stderr.push(String(value));
        return true;
      } },
      stdout: { write: (value) => {
        stdout.push(String(value));
        return true;
      } },
      timeoutMs: 1,
    },
  );
  return { convexCalls, exitCode, stderr, stdout };
};

describe("private descriptor fixture protocol", () => {
  const identity = { ctimeMs: 1, dev: 1, ino: 2, mode: 0o100600, mtimeMs: 1, nlink: 1, size: 16, uid: 501 };
  const provenance = { alias: "a".repeat(64), claude: "b".repeat(64), fixture: "c".repeat(64), runtime: identity };
  const request = { identity, operation: { kind: "provider-activity" }, provenance, version: 1 } as const;

  test("accepts only the finite descriptor protocol", () => {
    expect(parsePrivateDescriptorFixtureRequest(request)).toEqual(request);
    expect(() => parsePrivateDescriptorFixtureRequest({ ...request, operation: { kind: "shell" } })).toThrow();
    expect(() => parsePrivateDescriptorFixtureRequest({ ...request, path: "/foreign/credential" })).toThrow();
    expect(() => parsePrivateDescriptorFixtureRequest({ ...request, operation: { ...request.operation, path: "/foreign/credential" } })).toThrow();
    expect(() => parsePrivateDescriptorFixtureRequest({ ...request, provenance: { ...provenance, fixture: "invalid" } })).toThrow();
  });

  test("rejects changed source and runtime provenance", () => {
    expect(() => assertPrivateDescriptorFixtureProvenance(provenance, provenance)).not.toThrow();
    for (const field of ["alias", "claude", "fixture"] as const) {
      expect(() => assertPrivateDescriptorFixtureProvenance({ ...provenance, [field]: "d".repeat(64) }, provenance)).toThrow();
    }
    expect(() => assertPrivateDescriptorFixtureProvenance({ ...provenance, runtime: { ...identity, ino: 3 } }, provenance)).toThrow();
  });
});

describe("current-project alias plan", () => {
  test("preserves the historical editorial-image plan without admitting its retired alias", async () => {
    const document = await readFile(
      join(import.meta.dir, "..", "docs", "oompa-dev-80c20f7-plan.json"),
      "utf8",
    );
    expect(JSON.parse(document)).toMatchObject({
      alias: "oompa.dev",
      repository: { id: 1_343_008_607, name: "hraness/oompa" },
      vercel: {
        projectId: "prj_8ciIt9t9foE3utG45frRN7cxckjS",
        source: { deploymentId: "dpl_7pK5Y4G5G6rrNWzExGCYCjr6kMKN" },
        target: { deploymentId: "dpl_5um4zKKeN7WhLT58xoycxRkeoVKZ",
          sourceCommit: "80c20f7b1aa06aaec4a8bc03dbea249911de4717" },
      },
    });
    expect(() => parseCurrentProjectAliasReleasePlan(document)).toThrow("input_invalid");
    expect(parseCurrentProjectAliasReleasePlan(JSON.stringify(plan))).toEqual(plan);
  });

  test("rejects retired and name-only provider identities", () => {
    const retiredVercel = structuredClone(plan) as Record<string, unknown>;
    (retiredVercel.vercel as Record<string, unknown>).projectId =
      "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
    const retiredConvex = structuredClone(plan) as Record<string, unknown>;
    (retiredConvex.convex as Record<string, unknown>).projectId = 2_680_173;
    const retiredDeployment = structuredClone(plan) as Record<string, unknown>;
    (retiredDeployment.convex as Record<string, unknown>).deploymentId = 4_677_913;
    const retiredRepository = structuredClone(plan) as Record<string, unknown>;
    (retiredRepository.repository as Record<string, unknown>).id = 1_334_876_494;
    const uppercaseKey = { ...plan, idempotencyKey: plan.idempotencyKey.toUpperCase() };

    for (const value of [
      retiredVercel,
      retiredConvex,
      retiredDeployment,
      retiredRepository,
      uppercaseKey,
      { ...plan, alias: "oompa.dev" },
      { ...plan, extra: true },
      { ...plan, vercel: { ...plan.vercel, target: source } },
    ]) {
      expect(() => parseCurrentProjectAliasReleasePlan(JSON.stringify(value)))
        .toThrow("input_invalid");
    }
  });

  test("derives one exact record confirmation including project, IDs, and hostnames", () => {
    expect(requiredAliasConfirmation(plan)).toBe(
      `reassign oompa.app in ${OOMPA_VERCEL_PROJECT_ID} from ${source.deploymentId}@${source.deploymentUrl} to ${target.deploymentId}@${target.deploymentUrl} using plan ${plan.idempotencyKey}`,
    );
    expect(requiredAliasConfirmation({
      ...plan,
      idempotencyKey: "e34dc7a8-7df7-42d3-9e9f-6e95bcf2541d",
    })).not.toBe(requiredAliasConfirmation(plan));
  });

  test("binds one plan digest to distinct forward and recovery mutation keys", () => {
    const targetKey = currentAliasReleaseMutationKey(plan, "assign-target");
    const sourceKey = currentAliasReleaseMutationKey(plan, "restore-source");

    expect(currentAliasReleasePlanDigest(plan)).toMatch(/^[0-9a-f]{64}$/u);
    expect(targetKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(sourceKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(targetKey).not.toBe(sourceKey);
    const changedPlan: CurrentProjectAliasReleasePlan = {
      ...plan,
      vercel: {
        ...plan.vercel,
        target: { ...plan.vercel.target, sourceCommit: "3".repeat(40) },
      },
    };
    expect(currentAliasReleaseMutationKey(changedPlan, "assign-target")).not.toBe(targetKey);
    expect(currentAliasReleaseMutationKey(changedPlan, "restore-source")).not.toBe(sourceKey);
  });

  test("binds target acknowledgement and source recovery to the exact intent", () => {
    const intent = currentAliasReleaseIntentFor(plan);
    const targetPhase = currentAliasReleaseTargetPhaseForMutationResponse(
      plan,
      intent,
      {
        alias: "oompa.app",
        created: 1_787_961_600_000,
        oldDeploymentId: source.deploymentId,
        uid: "alias_CurrentOompa1234567890",
      },
    );
    const sourceRecovery = currentAliasReleaseSourceRecoveryFor(
      intent,
      targetPhase,
      { phase: "target_authority", reason: "marker_mismatch" },
    );

    expect(targetPhase).toMatchObject({
      evidence: {
        kind: "mutation-response",
        response: { oldDeploymentId: source.deploymentId },
      },
      intentDigest: intent.selfDigest,
      planDigest: intent.planDigest,
      targetMutationKey: intent.targetMutationKey,
    });
    expect(sourceRecovery).toMatchObject({
      intentDigest: intent.selfDigest,
      planDigest: intent.planDigest,
      sourceRecoveryKey: intent.sourceRecoveryKey,
      targetPhaseDigest: targetPhase.selfDigest,
    });
    expect(() => currentAliasReleaseTargetPhaseForMutationResponse(
      plan,
      intent,
      {
        alias: "oompa.app",
        created: 1_787_961_600_000,
        oldDeploymentId: "dpl_UnknownCurrent12345678901",
        uid: "alias_CurrentOompa1234567890",
      },
    )).toThrow("provider_readback_invalid");

    const activityPhase = currentAliasReleaseTargetPhaseForProviderActivity(
      plan,
      intent,
      providerActivityEvidence,
    );
    expect(activityPhase).toMatchObject({
      evidence: providerActivityEvidence,
      intentDigest: intent.selfDigest,
      targetMutationKey: intent.targetMutationKey,
    });
    expect(currentAliasReleaseProviderActivityEvidenceSchema.safeParse({
      ...providerActivityEvidence,
      selfDigest: "0".repeat(64),
    }).success).toBeFalse();
    for (const [field, value] of [
      ["bunVersion", "1.3.13"],
      ["entrypointSha256", "b".repeat(64)],
      ["gitCommit", "3".repeat(40)],
      ["sourceBlobOid", "4".repeat(40)],
    ] as const) {
      const { selfDigest: _selfDigest, ...unsigned } = providerActivityEvidence;
      void _selfDigest;
      expect(currentAliasReleaseProviderActivityEvidenceSchema.safeParse(withSelfDigest({
        ...unsigned,
        operator: {
          ...unsigned.operator,
          [field]: value,
        },
      })).success).toBeFalse();
    }
  });

  test("binds the narrow current CLI source provenance into the plan digest", () => {
    expect(parseCurrentProjectAliasReleasePlan(JSON.stringify(cliSourcePlan)))
      .toEqual(cliSourcePlan);
    expect(currentAliasReleasePlanDigest(cliSourcePlan))
      .not.toBe(currentAliasReleasePlanDigest(plan));

    for (const sourceProvenance of [
      { ...cliSourcePlan.vercel.sourceProvenance, actor: "vercel-cli" },
      { ...cliSourcePlan.vercel.sourceProvenance, gitCommitRef: "main" },
      { ...cliSourcePlan.vercel.sourceProvenance, gitRootDirectory: "site" },
      { ...cliSourcePlan.vercel.sourceProvenance, kind: "marker-only" },
      { ...cliSourcePlan.vercel.sourceProvenance, extra: true },
    ]) {
      expect(() => parseCurrentProjectAliasReleasePlan(JSON.stringify({
        ...cliSourcePlan,
        vercel: { ...cliSourcePlan.vercel, sourceProvenance },
      }))).toThrow("input_invalid");
    }
  });

  test("parses only complete immutable deployment provenance records", () => {
    expect(parseCurrentDeploymentReadback(deploymentFor(target)))
      .toEqual(deploymentFor(target));
    expect(parseCurrentDeploymentReadback(cliDeploymentFor(source)))
      .toEqual(cliDeploymentFor(source));
    expect(parseCurrentDeploymentReadback(cliDeploymentWithoutGitSourceFor(source)))
      .toEqual(cliDeploymentFor(source));
    expect(() => parseCurrentDeploymentReadback({
      ...deploymentFor(target),
      source: "cli",
    })).toThrow("provider_readback_invalid");

    const validCli = cliDeploymentFor(source) as Extract<
      CurrentDeploymentReadback,
      { gitSource: null }
    >;
    for (const invalid of [
      { ...validCli, source: "git" },
      { ...validCli, gitSource: { ref: "HEAD" } },
      { ...validCli, meta: { ...validCli.meta, actor: "vercel-cli" } },
      { ...validCli, meta: { ...validCli.meta, gitCommitRef: "main" } },
      { ...validCli, meta: { ...validCli.meta, gitCommitSha: "not-a-commit" } },
      { ...validCli, meta: { ...validCli.meta, gitRootDirectory: "site" } },
      { ...validCli, readyState: "BUILDING" },
      { ...validCli, target: null },
    ]) {
      expect(() => parseCurrentDeploymentReadback(invalid))
        .toThrow("provider_readback_invalid");
    }
  });

  test("requires the exact reviewed Bun runtime before any authority work", async () => {
    expect(() => assertCurrentAliasReleaseBunVersion("1.3.14")).not.toThrow();
    expect(() => assertCurrentAliasReleaseBunVersion("1.3.15"))
      .toThrow("bun_version_unsupported");
    const implementation = await readFile(
      join(import.meta.dir, "current-project-alias-release.ts"),
      "utf8",
    );
    const main = implementation.indexOf("if (import.meta.main)");
    const runtimeGuard = implementation.indexOf(
      "assertCurrentAliasReleaseBunVersion();",
      main,
    );
    const credentialConsumption = implementation.indexOf(
      "readProtectedVercelAccessToken(arguments_.vercelAuthFd)",
      main,
    );
    const journalRecovery = implementation.indexOf("recoverBoundedProcessJournal();", main);
    expect(main).toBeGreaterThanOrEqual(0);
    expect(runtimeGuard).toBeGreaterThan(main);
    expect(credentialConsumption).toBeGreaterThan(runtimeGuard);
    expect(journalRecovery).toBeGreaterThan(credentialConsumption);
    expect(journalRecovery).toBeGreaterThan(runtimeGuard);
    for (const read of [
      "readProtectedVercelAccessTokenFile(arguments_.vercelAuthFile)",
      "readProtectedProviderActivityEvidenceFile(arguments_.recoveryEvidenceFile)",
      "readProtectedAliasPlanFile(arguments_.planFile)",
    ]) {
      const consumption = implementation.indexOf(read, main);
      expect(consumption).toBeGreaterThan(runtimeGuard);
      expect(consumption).toBeLessThan(journalRecovery);
    }
    const execution = implementation.indexOf("executeCurrentProjectAliasRelease({", main);
    expect(execution).toBeGreaterThan(journalRecovery);
    expect(implementation).toContain("readAliasInputBuffer(size, (document, offset) => readSync(");
  });
});

describe("current-project alias authority", () => {
  test("preflight proves both deployments, current Convex, and exact source marker", async () => {
    const provider = new FakeProvider();

    expect(await observeCurrentAliasAuthority(plan, provider)).toEqual({
      reason: "exact_source",
      state: "source",
    });
    expect(provider.operations).toEqual([
      "verify-vercel",
      `verify-convex:${String(convex.deploymentId)}`,
      "read-project",
      `read-deployment:${source.deploymentId}`,
      `read-deployment:${target.deploymentId}`,
      "read-alias:source",
      "read-marker:source",
    ]);
    expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();
  });

  test("admits only the explicitly bound current CLI source and rechecks its alias", async () => {
    const provider = new FakeProvider();
    provider.activePlan = cliSourcePlan;

    expect(await observeCurrentAliasAuthority(cliSourcePlan, provider)).toEqual({
      reason: "exact_source",
      state: "source",
    });
    expect(provider.operations).toEqual([
      "verify-vercel",
      `verify-convex:${String(convex.deploymentId)}`,
      "read-project",
      `read-deployment:${source.deploymentId}`,
      `read-deployment:${target.deploymentId}`,
      "read-alias:source",
      "read-marker:source",
      "read-alias:source",
    ]);

    const unbound = new FakeProvider();
    unbound.sourceDeploymentOverride = cliDeploymentFor(source);
    await expect(observeCurrentAliasAuthority(plan, unbound))
      .rejects.toThrow("provider_readback_invalid");

    const wrongCommit = new FakeProvider();
    wrongCommit.activePlan = cliSourcePlan;
    const readback = cliDeploymentFor(source) as Extract<
      CurrentDeploymentReadback,
      { gitSource: null }
    >;
    wrongCommit.sourceDeploymentOverride = {
      ...readback,
      meta: { ...readback.meta, gitCommitSha: "4".repeat(40) },
    };
    await expect(observeCurrentAliasAuthority(cliSourcePlan, wrongCommit))
      .rejects.toThrow("provider_readback_invalid");

    const movedDuringMarkerRead = new FakeProvider();
    movedDuringMarkerRead.activePlan = cliSourcePlan;
    movedDuringMarkerRead.afterReadMarker = () => {
      movedDuringMarkerRead.aliasState = "target";
    };
    expect(await observeCurrentAliasAuthority(cliSourcePlan, movedDuringMarkerRead))
      .toEqual({ reason: "alias_not_planned", state: "blocked" });
  });

  test("keeps the target GitHub-main-only for a CLI-source plan", async () => {
    const provider = new FakeProvider();
    provider.activePlan = cliSourcePlan;
    provider.targetDeploymentOverride = cliDeploymentFor(target);

    await expect(observeCurrentAliasAuthority(cliSourcePlan, provider))
      .rejects.toThrow("provider_readback_invalid");
    expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();

    const hybrid = new FakeProvider();
    hybrid.activePlan = cliSourcePlan;
    hybrid.targetDeploymentOverride = {
      ...deploymentFor(target),
      source: "cli",
    } as unknown as CurrentDeploymentReadback;
    await expect(observeCurrentAliasAuthority(cliSourcePlan, hybrid))
      .rejects.toThrow("provider_readback_invalid");
    expect(hybrid.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();
  });

  test("moves from the proved CLI source to the exact GitHub target", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      const paths = currentAliasReleaseStatePaths(cliSourcePlan, stateDirectory);

      const result = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        changed: true,
        targetSourceCommit: target.sourceCommit,
      });
      expect(provider.aliasState).toBe("target");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
      expect(readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema))
        .toMatchObject({
          finalAuthority: {
            sourceProvenance: cliSourcePlan.vercel.sourceProvenance,
          },
          finalState: "target",
        });

      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));
      const replay = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout.join(""))).toMatchObject({
        replayed: true,
        status: "committed",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("restores and re-proves only the exact CLI source after target proof fails", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      provider.breakTargetMarker = true;

      const result = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      expect(provider.aliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
      expect(provider.operations.slice(-2)).toEqual([
        "read-marker:source",
        "read-alias:source",
      ]);
    });
  });

  test("does not receipt a CLI source restoration when its marker sandwich loses the alias", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      provider.breakTargetMarker = true;
      let restoredSourceMarkers = 0;
      provider.afterReadMarker = () => {
        if (
          provider.operations.includes(`set-alias:${source.deploymentUrl}`)
          && provider.operations.at(-1) === "read-marker:source"
        ) {
          restoredSourceMarkers += 1;
          if (restoredSourceMarkers === 2) provider.aliasState = "target";
        }
      };
      const paths = currentAliasReleaseStatePaths(cliSourcePlan, stateDirectory);

      const result = await runExecuteCli(cliSourcePlan, provider, stateDirectory);
      expect(result.exitCode).toBe(75);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const racedMarker = provider.operations.findIndex((operation, index, operations) =>
        operation === "read-marker:source" && operations[index + 1] === "read-alias:target");
      expect(racedMarker).toBeGreaterThanOrEqual(0);
    });
  });

  test("blocks an unknown alias and refuses target deployment drift before mutation", async () => {
    const unknown = new FakeProvider();
    unknown.aliasState = "unknown";
    expect(await observeCurrentAliasAuthority(plan, unknown)).toEqual({
      reason: "alias_not_planned",
      state: "blocked",
    });

    const drift = new FakeProvider();
    drift.breakTargetDeployment = true;
    await expect(observeCurrentAliasAuthority(plan, drift))
      .rejects.toThrow("provider_readback_invalid");
    expect(drift.operations.some((operation) => operation.startsWith("set-alias:")))
      .toBeFalse();
  });

  test("requires the exact plan-bound machine token before any alias write", async () => {
    await withStateDirectory(async (stateDirectory) => {
      for (const operation of ["--execute", "recover-source"] as const) {
        for (const confirmation of [
          undefined,
          "approve both",
          "confirmed do it",
          "reassign oompa.app",
        ] as const) {
          const provider = new FakeProvider();
          const stderr: string[] = [];
          const arguments_ = [operation, "--vercel-auth-fd", "3"];
          if (confirmation !== undefined) arguments_.push("--confirm-exact", confirmation);
          const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
            { provider, stateDirectory },
            {
              arguments: arguments_,
              inputDocument: JSON.stringify(plan),
              stderr: { write: (value) => {
                stderr.push(String(value));
                return true;
              } },
              stdout: { write: () => true },
            },
          );
          expect(exitCode).toBe(1);
          expect(JSON.parse(stderr.join(""))).toMatchObject({ code: "confirmation_required" });
          expect(provider.operations).toEqual([]);
        }
      }
    });
  });

  test("commits only the target alias and repeats every provider readback", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const result = await runExecuteCli(plan, provider, stateDirectory);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        changed: true,
        replayed: false,
      });
      expect(provider.aliasState).toBe("target");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
      expect(provider.operations.filter((operation) => operation === "verify-vercel"))
        .toHaveLength(4);
      expect(provider.operations.filter((operation) =>
        operation === `verify-convex:${String(convex.deploymentId)}`))
        .toHaveLength(4);
      expect(provider.operations.filter((operation) => operation === "read-marker:target"))
        .toHaveLength(4);
    });
  });

  test("resets stability after a transient target-authority failure without rolling back", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.failVerifyVercelAt = 4;

      const result = await runExecuteCli(plan, provider, stateDirectory, {
        timeoutMs: 1_000,
      });

      expect(result.exitCode).toBe(0);
      expect(provider.aliasState).toBe("target");
      expect(provider.operations.filter((operation) => operation === "verify-vercel"))
        .toHaveLength(6);
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
    });
  });

  test("shares one target deadline and receipts the persistent closed failure", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const clock = immediateClock();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      provider.targetVisibilityLagReads = 1;
      provider.failVerifyVercelWhileTarget = true;

      const result = await runExecuteCli(plan, provider, stateDirectory, {
        clock,
        timeoutMs: 750,
      });

      expect(result.exitCode).toBe(1);
      expect(clock.now()).toBe(750);
      expect(provider.aliasState).toBe("source");
      expect(readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema))
        .toMatchObject({
          finalState: "source",
          rollbackDiagnostic: {
            phase: "target_authority",
            reason: "provider_command_failed",
          },
        });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
    });
  });

  test("starts no complete target sample after the fast probe consumes its deadline", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const clock = immediateClock();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      provider.afterReadMarker = async () => {
        if (provider.aliasState === "target" && clock.now() === 0) {
          await clock.sleep(750);
        }
      };

      const result = await runExecuteCli(plan, provider, stateDirectory, {
        clock,
        timeoutMs: 750,
      });

      expect(result.exitCode).toBe(1);
      expect(clock.now()).toBe(750);
      expect(provider.aliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation === "verify-vercel"))
        .toHaveLength(4);
      expect(readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema))
        .toMatchObject({
          finalState: "source",
          rollbackDiagnostic: {
            phase: "target_authority",
            reason: "stability_not_proven",
          },
        });
    });
  });

  test("does not infer a commit or dispatch recovery from a lost target response", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.targetSetBehavior = "commit-and-throw";
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const ambiguous = await runExecuteCli(plan, provider, stateDirectory);
      expect(ambiguous.exitCode).toBe(75);
      expect(JSON.parse(ambiguous.stderr.join(""))).toMatchObject({
        code: "target_result_ambiguous",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      expect(await Bun.file(paths.targetPhase).exists()).toBeFalse();
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));

      const preflightProvider = new FakeProvider();
      preflightProvider.aliasState = "target";
      const preflight = await runPreflightCli(plan, preflightProvider, stateDirectory);
      expect(preflight.exitCode).toBe(75);
      expect(preflight.stdout).toEqual([]);
      expect(JSON.parse(preflight.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(preflightProvider.operations).toEqual([]);

      const replay = await runExecuteCli(plan, provider, stateDirectory);
      expect(replay.exitCode).toBe(75);
      expect(JSON.parse(replay.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("rejects a target response that replaced an unplanned deployment", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.mutationOldDeploymentIdOverride = "dpl_UnknownCurrent12345678901";
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const conflict = await runExecuteCli(plan, provider, stateDirectory);
      expect(conflict.exitCode).toBe(75);
      expect(JSON.parse(conflict.stderr.join(""))).toMatchObject({
        code: "provider_readback_invalid",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      expect(await Bun.file(paths.targetPhase).exists()).toBeFalse();
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toHaveLength(1);
    });
  });

  test("waits through stale source reads before committing the target", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.targetVisibilityLagReads = 2;

      expect((await runExecuteCli(plan, provider, stateDirectory, { timeoutMs: 1_000 })).exitCode)
        .toBe(0);
      expect(provider.operations.filter((operation) => operation === "read-alias:source").length)
        .toBeGreaterThanOrEqual(3);
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
    });
  });

  test("replays an exact target state under the same exact confirmation", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.aliasState = "target";

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.join(""))).toMatchObject({
        changed: false,
        replayed: true,
        status: "already_committed",
      });
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });

  test("restores only the exact same-project source when the target marker is wrong", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({ code: "alias_reverted" });
      expect(provider.aliasState).toBe("source");
      expect(readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema))
        .toMatchObject({
          finalState: "source",
          rollbackDiagnostic: {
            phase: "target_probe",
            reason: "marker_mismatch",
          },
        });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
    });
  });

  test("retries a transient complete source-authority failure after exact restoration", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.failVerifyVercelAt = 4;

      const result = await runExecuteCli(plan, provider, stateDirectory, {
        timeoutMs: 1_000,
      });

      expect(result.exitCode).toBe(1);
      expect(provider.aliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation === "verify-vercel"))
        .toHaveLength(6);
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
    });
  });

  test("waits through stale target reads while proving source restoration", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.sourceVisibilityLagReads = 2;

      const result = await runExecuteCli(plan, provider, stateDirectory, {
        timeoutMs: 1_000,
      });
      expect(result.exitCode).toBe(1);
      expect(provider.aliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([
          `set-alias:${target.deploymentUrl}`,
          `set-alias:${source.deploymentUrl}`,
        ]);
      expect(provider.operations.filter((operation) => operation === "read-alias:target").length)
        .toBeGreaterThan(2);
    });
  });

  test("reports recovery required when exact source restoration cannot be proved", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.failSourceSet = true;

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(75);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
      });
      expect(provider.aliasState).toBe("target");
    });
  });

  test("stops every provider call immediately when the writer fence is lost", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      let markerReads = 0;
      provider.afterReadMarker = async () => {
        markerReads += 1;
        if (markerReads === 2) {
          await chmod(join(stateDirectory, ".canonical-alias-release.lock"), 0o644);
        }
      };

      const result = await runExecuteCli(plan, provider, stateDirectory);
      expect(result.exitCode).toBe(75);
      expect(JSON.parse(result.stderr.join(""))).toMatchObject({
        code: "durable_state_invalid",
        status: "recovery_required",
      });
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });
});

describe("current-project Vercel provider", () => {
  test("keeps file-argument API dispatch behind the same authority and ledger gates", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const transport = new FakeDirectVercelTransport();
      const preflight = await runDirectApiCli(cliSourcePlan, transport, stateDirectory, "preflight",
        requiredAliasConfirmation(cliSourcePlan), undefined, "file");
      expect(preflight.exitCode).toBe(0);
      expect(preflight.stderr).toEqual([]);
      expect(JSON.parse(preflight.stdout.join(""))).toMatchObject({ status: "ready", observedState: "source" });
      expect(transport.requests.filter((request) => request.init.method === "POST")).toHaveLength(0);
      const refused = await runDirectApiCli(cliSourcePlan, transport, stateDirectory, "execute", "wrong", undefined, "file");
      expect(refused.exitCode).toBe(1);
      expect(transport.requests.filter((request) => request.init.method === "POST")).toHaveLength(0);
      const executed = await runDirectApiCli(cliSourcePlan, transport, stateDirectory, "execute",
        requiredAliasConfirmation(cliSourcePlan), undefined, "file");
      expect(executed.exitCode).toBe(0);
      expect(executed.stderr).toEqual([]);
      expect(JSON.parse(executed.stdout.join(""))).toMatchObject({ status: "committed" });
      expect(transport.requests.filter((request) => request.init.method === "POST")).toHaveLength(1);
      const replay = await runDirectApiCli(cliSourcePlan, transport, stateDirectory, "execute",
        requiredAliasConfirmation(cliSourcePlan), undefined, "file");
      expect(replay.exitCode).toBe(0);
      expect(transport.requests.filter((request) => request.init.method === "POST")).toHaveLength(1);
    });
  });
  test("constructs only the direct alias endpoint request with the plan-bound key", async () => {
    const key = currentAliasReleaseMutationKey(plan, "assign-target");
    expect(currentAliasReleaseApiArguments(target, key)).toEqual([
      "api",
      `/v2/deployments/${target.deploymentId}/aliases`,
      "--method",
      "POST",
      "--raw-field",
      "alias=oompa.app",
      "--header",
      `Idempotency-Key:${key}`,
      "--scope",
      OOMPA_VERCEL_TEAM_ID,
      "--raw",
    ]);
    const request = currentAliasReleaseVercelApiRequest(
      target,
      key,
      "fixture-vercel-token",
    );
    expect(request).toEqual({
      body: JSON.stringify({ alias: "oompa.app" }),
      headers: {
        accept: "application/json",
        authorization: "Bearer fixture-vercel-token",
        "content-type": "application/json",
        "idempotency-key": key,
      },
      method: "POST",
      url: `https://api.vercel.com/v2/deployments/${target.deploymentId}/aliases?teamId=${OOMPA_VERCEL_TEAM_ID}`,
    });

    const implementation = await readFile(
      join(import.meta.dir, "current-project-alias-release.ts"),
      "utf8",
    );
    const directProviderStart = implementation.indexOf(
      "class VercelCurrentProjectAliasApiProvider",
    );
    const directProviderEnd = implementation.indexOf("type ParsedArguments", directProviderStart);
    const directProvider = implementation.slice(directProviderStart, directProviderEnd);
    expect(directProviderStart).toBeGreaterThanOrEqual(0);
    expect(directProviderEnd).toBeGreaterThan(directProviderStart);
    expect(directProvider).not.toContain("runBoundedProcess");
    expect(directProvider).not.toContain("#invoke(");
    expect(directProvider).not.toContain("process.env");
    expect(implementation).not.toContain('"alias",\n      "set"');
    expect(implementation).not.toContain("/v4/domains");
    expect(implementation).not.toContain("certificates");
  });

  test("consumes only a stable private credential descriptor and closes it", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const path = join(stateDirectory, "vercel-auth.json");
      await writeFile(path, JSON.stringify({
        expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
        refreshToken: "must-not-be-retained",
        token: "fixture-vercel-token",
      }), { mode: 0o600 });
      await chmod(path, 0o600);
      const heldDescriptors: number[] = [];
      try {
        // Reproduce the full-suite allocation pressure independently of test order.
        for (let attempt = 0; attempt < 256 && (heldDescriptors.at(-1) ?? 0) <= 255; attempt += 1) {
          heldDescriptors.push(openSync("/dev/null", constants.O_RDONLY));
        }
        expect(heldDescriptors.at(-1)).toBeGreaterThan(255);
        const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const result = consumePrivateFixtureDescriptor(descriptor, {
          kind: "vercel-token", nowSeconds: Math.floor(Date.now() / 1_000),
        }, { mode: 0o600, nlink: 1 });
        expect(descriptor).toBeGreaterThan(255);
        expect(result.outcome).toBe("accepted");
        expect(result.sha256).toBe(createHash("sha256").update("fixture-vercel-token").digest("hex"));
        expect(() => fstatSync(descriptor)).toThrow();
      } finally {
        for (const descriptor of heldDescriptors) closeSync(descriptor);
      }
    });
  });

  test("refuses permissive, linked, expired, and malformed credential descriptors", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const cases = [
        { document: JSON.stringify({ token: "fixture-vercel-token" }), mode: 0o644 },
        { document: JSON.stringify({ expiresAt: 1, token: "fixture-vercel-token" }), mode: 0o600 },
        { document: JSON.stringify({ expiresAt: 901, token: "fixture-vercel-token" }), mode: 0o600 },
        { document: JSON.stringify({ token: "contains whitespace" }), mode: 0o600 },
        { document: "{", mode: 0o600 },
      ] as const;
      for (const [index, fixture] of cases.entries()) {
        const path = join(stateDirectory, `vercel-auth-${String(index)}.json`);
        await writeFile(path, fixture.document, { mode: fixture.mode });
        await chmod(path, fixture.mode);
        const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const result = consumePrivateFixtureDescriptor(descriptor, { kind: "vercel-token", nowSeconds: 2 }, { mode: fixture.mode, nlink: 1 });
        expect(result.outcome).toBe("refused");
        expect(result.sha256).toBeNull();
        expect(() => fstatSync(descriptor)).toThrow();
      }

      const path = join(stateDirectory, "vercel-auth-linked.json");
      const other = join(stateDirectory, "vercel-auth-linked-copy.json");
      await writeFile(path, JSON.stringify({ token: "fixture-vercel-token" }), { mode: 0o600 });
      await chmod(path, 0o600);
      await link(path, other);
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const result = consumePrivateFixtureDescriptor(descriptor, {
        kind: "vercel-token", nowSeconds: Math.floor(Date.now() / 1_000),
      }, { mode: 0o600, nlink: 2 });
      expect(result.outcome).toBe("refused");
      expect(result.sha256).toBeNull();
      expect(() => fstatSync(descriptor)).toThrow();
    });
  });

  test("consumes only a self-digested private recovery-evidence descriptor and closes it", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const validPath = join(stateDirectory, "recovery-evidence.json");
      await writeFile(validPath, JSON.stringify(providerActivityEvidence), { mode: 0o600 });
      await chmod(validPath, 0o600);
      expect(readProtectedProviderActivityEvidenceFile(validPath)).toEqual(providerActivityEvidence);
      const validDescriptor = openSync(
        validPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const validResult = consumePrivateFixtureDescriptor(validDescriptor, { kind: "provider-activity" }, { mode: 0o600, nlink: 1 });
      expect(validResult.outcome).toBe("accepted");
      expect(validResult.sha256).toBe(createHash("sha256").update(JSON.stringify(providerActivityEvidence)).digest("hex"));
      expect(() => fstatSync(validDescriptor)).toThrow();

      const invalidPath = join(stateDirectory, "recovery-evidence-invalid.json");
      await writeFile(invalidPath, JSON.stringify({
        ...providerActivityEvidence,
        observedTargetMarkerVersion: OOMPA_RELEASE_VERSION,
      }), { mode: 0o600 });
      await chmod(invalidPath, 0o600);
      expect(() => readProtectedProviderActivityEvidenceFile(invalidPath))
        .toThrow("recovery_evidence_invalid");
      const invalidDescriptor = openSync(
        invalidPath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const invalidResult = consumePrivateFixtureDescriptor(invalidDescriptor, { kind: "provider-activity" }, { mode: 0o600, nlink: 1 });
      expect(invalidResult.outcome).toBe("refused");
      expect(invalidResult.sha256).toBeNull();
      expect(() => fstatSync(invalidDescriptor)).toThrow();
    });
  });

  test("drives the exact CLI-source preflight and one target POST through direct REST", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const transport = new FakeDirectVercelTransport();
      const preflight = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "preflight",
      );
      expect(preflight.exitCode).toBe(0);
      expect(preflight.stderr).toEqual([]);
      expect(preflight.convexCalls).toBe(1);
      expect(JSON.parse(preflight.stdout.join(""))).toMatchObject({
        observedState: "source",
        status: "ready",
      });
      expect(transport.requests.map(({ url }) => new URL(url).pathname)).toEqual([
        `/v9/projects/${OOMPA_VERCEL_PROJECT_ID}`,
        `/v13/deployments/${source.deploymentId}`,
        `/v13/deployments/${target.deploymentId}`,
        "/v4/aliases/oompa.app",
        "/.well-known/hra.json",
        "/v4/aliases/oompa.app",
      ]);

      const executed = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "execute",
      );
      expect(executed.exitCode).toBe(0);
      expect(executed.stderr).toEqual([]);
      expect(executed.convexCalls).toBe(4);
      expect(transport.aliasState).toBe("target");
      const posts = transport.requests.filter(({ init }) => init.method === "POST");
      expect(posts).toHaveLength(1);
      expect(new URL(posts[0]!.url).pathname)
        .toBe(`/v2/deployments/${target.deploymentId}/aliases`);
      expect(JSON.parse(executed.stdout.join(""))).toMatchObject({
        changed: true,
        status: "committed",
      });
      const paths = currentAliasReleaseStatePaths(cliSourcePlan, stateDirectory);
      for (const document of [
        executed.stdout.join(""),
        await readFile(paths.intent, "utf8"),
        await readFile(paths.receipt, "utf8"),
      ]) {
        expect(document).not.toContain("fixture-vercel-token");
        expect(document).not.toContain("must-not-be-retained");
      }
    });
  });

  test("recovers source through direct REST without ever dispatching a target write", async () => {
    await withStateDirectory(async (stateDirectory) => {
      await seedTargetPhase(cliSourcePlan, stateDirectory);
      const transport = new FakeDirectVercelTransport();
      transport.aliasState = "target";
      transport.mode = "recover-source";

      const recovered = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "recover-source",
      );

      expect(recovered.stderr).toEqual([]);
      expect(recovered.exitCode).toBe(0);
      expect(transport.aliasState as AliasState).toBe("source");
      const posts = transport.requests.filter(({ init }) => init.method === "POST");
      expect(posts.map(({ url }) => new URL(url).pathname)).toEqual([
        `/v2/deployments/${source.deploymentId}/aliases`,
      ]);
      expect(JSON.parse(recovered.stdout.join(""))).toMatchObject({
        changed: true,
        status: "recovered_source",
      });
    });
  });

  test("revalidates legacy activity authority through direct REST before source recovery", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const paths = await seedLegacyIntent(cliSourcePlan, stateDirectory);
      const evidence = providerActivityEvidenceFor((await stat(paths.intent)).mtimeMs);
      const transport = new FakeDirectVercelTransport();
      transport.activityEvidence = evidence;
      transport.aliasState = "target";
      transport.mode = "recover-source";

      const recovered = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "recover-source",
        requiredAliasConfirmation(cliSourcePlan),
        evidence,
      );

      expect(recovered.stderr).toEqual([]);
      expect(recovered.exitCode).toBe(0);
      expect(transport.requests.filter(({ url }) =>
        new URL(url).pathname === "/v3/events")).toHaveLength(2);
      expect(transport.requests.filter(({ init }) => init.method === "POST")
        .map(({ url }) => new URL(url).pathname)).toEqual([
        `/v2/deployments/${source.deploymentId}/aliases`,
      ]);
      expect(readProtectedJson(paths.targetPhase, currentAliasReleaseTargetPhaseSchema))
        .toMatchObject({
          evidence: {
            kind: "provider-activity-and-operator-provenance",
            selfDigest: evidence.selfDigest,
          },
        });
    });
  });

  test("refuses a full Activity page because event uniqueness is not complete", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const paths = await seedLegacyIntent(cliSourcePlan, stateDirectory);
      const evidence = providerActivityEvidenceFor((await stat(paths.intent)).mtimeMs);
      const transport = new FakeDirectVercelTransport();
      transport.activityEvidence = evidence;
      transport.activityEventCount = 100;
      transport.aliasState = "target";
      transport.mode = "recover-source";

      const refused = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "recover-source",
        requiredAliasConfirmation(cliSourcePlan),
        evidence,
      );

      expect(refused.exitCode).toBe(75);
      expect(refused.stdout).toEqual([]);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "recovery_evidence_invalid",
        status: "recovery_required",
      });
      expect(transport.requests.filter(({ init }) => init.method === "POST"))
        .toHaveLength(0);
      expect(await Bun.file(paths.targetPhase).exists()).toBeFalse();
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("refuses an Activity event whose two provider timestamps disagree", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const paths = await seedLegacyIntent(cliSourcePlan, stateDirectory);
      const evidence = providerActivityEvidenceFor((await stat(paths.intent)).mtimeMs);
      const transport = new FakeDirectVercelTransport();
      transport.activityCreatedOffset = 1;
      transport.activityEvidence = evidence;
      transport.aliasState = "target";
      transport.mode = "recover-source";

      const refused = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "recover-source",
        requiredAliasConfirmation(cliSourcePlan),
        evidence,
      );

      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "recovery_evidence_invalid",
        status: "recovery_required",
      });
      expect(transport.requests.filter(({ init }) => init.method === "POST"))
        .toHaveLength(0);
      expect(await Bun.file(paths.targetPhase).exists()).toBeFalse();
    });
  });

  test("freezes one direct target POST ambiguity behind its durable intent", async () => {
    for (const [mode, expectedAliasState] of [
      ["mutation-rejected", "source"],
      ["mutation-malformed", "target"],
    ] as const) {
      await withStateDirectory(async (stateDirectory) => {
        const transport = new FakeDirectVercelTransport();
        transport.mode = mode;
        const failed = await runDirectApiCli(
          cliSourcePlan,
          transport,
          stateDirectory,
          "execute",
        );
        expect(failed.exitCode).toBe(75);
        expect(failed.stdout).toEqual([]);
        expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
          code: "target_result_ambiguous",
          status: "recovery_required",
        });
        expect(failed.stderr.join("")).not.toContain("fixture-vercel-token");
        expect(transport.requests.filter(({ init }) => init.method === "POST"))
          .toHaveLength(1);
        expect(transport.aliasState).toBe(expectedAliasState);
        const paths = currentAliasReleaseStatePaths(cliSourcePlan, stateDirectory);
        expect(await Bun.file(paths.intent).exists()).toBeTrue();
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      });
    }
  });

  test("rejects a wrong direct confirmation before lock, Convex, or fetch authority", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const transport = new FakeDirectVercelTransport();
      const failed = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "execute",
        "not-the-record",
      );
      expect(failed.exitCode).toBe(1);
      expect(failed.convexCalls).toBe(0);
      expect(transport.requests).toEqual([]);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "confirmation_required",
        status: "refused",
      });
      expect(await Bun.file(
        join(stateDirectory, ".canonical-alias-release.lock"),
      ).exists()).toBeFalse();
    });
  });

  test("normalizes a rejected direct restoration as compensation failure", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const transport = new FakeDirectVercelTransport();
      transport.mode = "target-unprovable-restore-rejected";
      const failed = await runDirectApiCli(
        cliSourcePlan,
        transport,
        stateDirectory,
        "execute",
      );
      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
        status: "recovery_required",
      });
      const posts = transport.requests.filter(({ init }) => init.method === "POST");
      expect(posts.map(({ url }) => new URL(url).pathname)).toEqual([
        `/v2/deployments/${target.deploymentId}/aliases`,
        `/v2/deployments/${source.deploymentId}/aliases`,
      ]);
      expect(transport.aliasState).toBe("target");
      const paths = currentAliasReleaseStatePaths(cliSourcePlan, stateDirectory);
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("keeps only the explicit non-secret child environment", () => {
    expect(buildVercelEnvironment({
      HOME: "/safe/home",
      PATH: "/safe/bin",
      VERCEL_TOKEN: "secret",
      VERCEL_ORG_ID: "wrong-authority",
      VERCEL_PROJECT_ID: "wrong-project",
    })).toEqual({
      HOME: "/safe/home",
      NO_COLOR: "1",
      PATH: "/safe/bin",
      TERM: "dumb",
    });
  });

  test("does not expose ambient provider or fence bypasses on normal import", async () => {
    const module = await import("./current-project-alias-release");
    for (const name of [
      "currentProjectAliasReleaseTestHarness",
      "VercelCurrentProjectAliasProvider",
      "VercelCurrentProjectAliasApiProvider",
      "runVercelCommand",
      "acquireCurrentAliasReleaseExecutionLock",
      "executeCurrentProjectAliasRelease",
      "executeCurrentAliasReleasePlan",
    ]) expect(name in module).toBeFalse();
    expect("executeCurrentProjectAliasReleaseWithExplicitCapability" in module).toBeTrue();
    expect("executeCurrentProjectAliasReleaseWithExplicitApiCapability" in module).toBeTrue();
  });

  test("rejects JavaScript-shaped missing capabilities without ambient fallback", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const invalidCapabilities: unknown[] = [
        { provider: undefined, stateDirectory },
        { provider: null, stateDirectory },
        { provider, stateDirectory: undefined },
        { provider, stateDirectory: null },
        { provider, stateDirectory: "relative/state" },
      ];

      for (const capability of invalidCapabilities) {
        const stdout: string[] = [];
        const stderr: string[] = [];
        const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
          capability as Parameters<
            typeof executeCurrentProjectAliasReleaseWithExplicitCapability
          >[0],
          {
            arguments: ["preflight", "--vercel-auth-fd", "3"],
            inputDocument: JSON.stringify(plan),
            stderr: { write: (value) => {
              stderr.push(String(value));
              return true;
            } },
            stdout: { write: (value) => {
              stdout.push(String(value));
              return true;
            } },
          },
        );

        expect(exitCode).toBe(1);
        expect(stdout).toEqual([]);
        expect(JSON.parse(stderr.join(""))).toEqual({
          code: "usage_invalid",
          schemaVersion: 1,
          status: "refused",
        });
      }
      expect(provider.operations).toEqual([]);
      expect(await Bun.file(
        join(stateDirectory, ".canonical-alias-release.lock"),
      ).exists()).toBeFalse();
    });
  });
});

describe("durable current-project alias execution", () => {
  test("reserves room for the complete phase and receipt quartet at the ledger edge", () => {
    expect(currentAliasReleaseStateEntryMaximum).toBe(8_193);
    expect(() => assertCurrentAliasReleaseStateCapacity(8_189, 4)).not.toThrow();
    expect(() => assertCurrentAliasReleaseStateCapacity(8_190, 4))
      .toThrow("durable_state_capacity_exhausted");
    expect(() => assertCurrentAliasReleaseStateCapacity(8_193, 0)).not.toThrow();
    expect(() => assertCurrentAliasReleaseStateCapacity(8_193, 1))
      .toThrow("durable_state_capacity_exhausted");
    expect(() => assertCurrentAliasReleaseScanCapacity(8_194)).not.toThrow();
    expect(() => assertCurrentAliasReleaseScanCapacity(8_195))
      .toThrow("durable_state_capacity_exhausted");
  });

  test("publishes the exact source intent before mutation and a target receipt after postflight", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      let targetPhaseObservedBeforePostflight = false;
      provider.beforeSetAlias = async (endpoint) => {
        if (endpoint.deploymentUrl !== target.deploymentUrl) return;
        const intent = readProtectedJson(paths.intent, currentAliasReleaseIntentSchema);
        expect(intent.idempotencyKey).toBe(plan.idempotencyKey);
        expect(intent.planDigest).toBe(currentAliasReleasePlanDigest(plan));
        expect(intent.sourceAuthority.marker.sourceCommit).toBe(source.sourceCommit);
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      };
      provider.beforeReadAlias = async () => {
        if (
          targetPhaseObservedBeforePostflight
          || provider.aliasState !== "target"
          || !provider.operations.includes(`set-alias:${target.deploymentUrl}`)
        ) return;
        const targetPhase = readProtectedJson(
          paths.targetPhase,
          currentAliasReleaseTargetPhaseSchema,
        );
        expect(targetPhase).toMatchObject({
          evidence: {
            kind: "mutation-response",
            response: { oldDeploymentId: source.deploymentId },
          },
          intentDigest: readProtectedJson(
            paths.intent,
            currentAliasReleaseIntentSchema,
          ).selfDigest,
          targetMutationKey: currentAliasReleaseMutationKey(plan, "assign-target"),
        });
        expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
        targetPhaseObservedBeforePostflight = true;
      };

      const first = await runExecuteCli(plan, provider, stateDirectory);
      expect(first.exitCode).toBe(0);
      expect(first.stderr).toEqual([]);
      expect(JSON.parse(first.stdout.join(""))).toMatchObject({
        changed: true,
        idempotencyKey: plan.idempotencyKey,
        replayed: false,
        status: "committed",
      });
      const intent = readProtectedJson(paths.intent, currentAliasReleaseIntentSchema);
      const targetPhase = readProtectedJson(
        paths.targetPhase,
        currentAliasReleaseTargetPhaseSchema,
      );
      const receipt = readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema);
      expect(targetPhaseObservedBeforePostflight).toBeTrue();
      expect(receipt).toMatchObject({
        finalState: "target",
        idempotencyKey: plan.idempotencyKey,
        intentDigest: intent.selfDigest,
        targetPhaseDigest: targetPhase.selfDigest,
      });
      expect((await stat(paths.intent)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.targetPhase)).mode & 0o777).toBe(0o600);
      expect((await stat(paths.receipt)).mode & 0o777).toBe(0o600);
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();

      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));
      const replay = await runExecuteCli(plan, provider, stateDirectory);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout.join(""))).toMatchObject({
        changed: true,
        replayed: true,
        status: "committed",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("explicitly recovers source from two exact version-mismatch target samples", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { intent, paths, targetPhase } = await seedTargetPhase(plan, stateDirectory);
      const provider = new FakeProvider();
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");
      let sourceRecoveryObservedBeforeMutation = false;
      provider.beforeSetAlias = async (endpoint) => {
        expect(endpoint).toEqual(source);
        const sourceRecovery = readProtectedJson(
          paths.sourceRecovery,
          currentAliasReleaseSourceRecoverySchema,
        );
        expect(sourceRecovery).toMatchObject({
          intentDigest: intent.selfDigest,
          rollbackDiagnostic: {
            phase: "target_authority",
            reason: "marker_mismatch",
          },
          sourceRecoveryKey: currentAliasReleaseMutationKey(plan, "restore-source"),
          targetPhaseDigest: targetPhase.selfDigest,
        });
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
        sourceRecoveryObservedBeforeMutation = true;
      };

      const recovered = await runRecoverSourceCli(plan, provider, stateDirectory);

      expect(recovered.exitCode).toBe(0);
      expect(recovered.stderr).toEqual([]);
      expect(sourceRecoveryObservedBeforeMutation).toBeTrue();
      expect(provider.aliasState as AliasState).toBe("source");
      expect(provider.operations.filter((operation) => operation === "read-marker:target"))
        .toHaveLength(2);
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${source.deploymentUrl}`]);
      const sourceRecovery = readProtectedJson(
        paths.sourceRecovery,
        currentAliasReleaseSourceRecoverySchema,
      );
      const receipt = readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema);
      expect(receipt).toMatchObject({
        changed: true,
        finalState: "source",
        intentDigest: intent.selfDigest,
        sourceRecoveryDigest: sourceRecovery.selfDigest,
        targetPhaseDigest: targetPhase.selfDigest,
      });
      expect(JSON.parse(recovered.stdout.join(""))).toMatchObject({
        changed: true,
        sourceRecoveryDigest: sourceRecovery.selfDigest,
        status: "recovered_source",
        targetPhaseDigest: targetPhase.selfDigest,
      });
      expect((await stat(paths.sourceRecovery)).mode & 0o777).toBe(0o600);

      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));
      const replay = await runRecoverSourceCli(plan, provider, stateDirectory);
      expect(replay.exitCode).toBe(0);
      expect(JSON.parse(replay.stdout.join(""))).toMatchObject({
        replayed: true,
        status: "recovered_source",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("requires durable target acknowledgment before explicit recovery", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const paths = await seedLegacyIntent(plan, stateDirectory);
      const provider = new FakeProvider();
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");

      const refused = await runRecoverSourceCli(plan, provider, stateDirectory);

      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "recovery_evidence_invalid",
        status: "recovery_required",
      });
      expect(provider.operations).toEqual([]);
      expect(await Bun.file(paths.targetPhase).exists()).toBeFalse();
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("revalidates legacy activity evidence and refuses it without durable mutation", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const paths = await seedLegacyIntent(plan, stateDirectory);
      const evidence = providerActivityEvidenceFor((await stat(paths.intent)).mtimeMs);
      const provider = new FakeProvider();
      provider.activityEvidenceFailure = true;
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");

      const refused = await runRecoverSourceCli(plan, provider, stateDirectory, {
        providerActivityEvidence: evidence,
      });

      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "provider_readback_invalid",
        status: "recovery_required",
      });
      expect(provider.operations).toEqual([
        `verify-target-activity:${evidence.activity.eventId}`,
      ]);
      expect(await Bun.file(paths.targetPhase).exists()).toBeFalse();
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("permits recovery only from the exact target with solely a marker-version mismatch", async () => {
    for (const configure of [
      (provider: FakeProvider) => {
        provider.aliasState = "source";
      },
      (provider: FakeProvider) => {
        provider.aliasState = "unknown";
      },
      (provider: FakeProvider) => {
        provider.aliasState = "target";
      },
      (provider: FakeProvider) => {
        provider.aliasState = "target";
        provider.breakTargetMarker = true;
      },
    ]) {
      await withStateDirectory(async (stateDirectory) => {
        const { paths } = await seedTargetPhase(plan, stateDirectory);
        const provider = new FakeProvider();
        configure(provider);

        const refused = await runRecoverSourceCli(plan, provider, stateDirectory);

        expect(refused.exitCode).toBe(75);
        expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
          code: "recovery_not_permitted",
          status: "recovery_required",
        });
        expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
          .toBeFalse();
        expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      });
    }
  });

  test("refuses target marker-version drift between recovery authority samples", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { paths } = await seedTargetPhase(plan, stateDirectory);
      const provider = new FakeProvider();
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");
      let markerReads = 0;
      provider.afterReadMarker = () => {
        markerReads += 1;
        if (markerReads === 1) {
          provider.targetMarkerOverride = markerWithVersion(target, "0.1.98");
        }
      };

      const refused = await runRecoverSourceCli(plan, provider, stateDirectory);

      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "recovery_not_permitted",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([]);
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("never retries an ambiguous or refused source recovery", async () => {
    for (const configure of [
      (provider: FakeProvider) => {
        provider.sourceSetCommitAndThrow = true;
      },
      (provider: FakeProvider) => {
        provider.failSourceSet = true;
      },
      (provider: FakeProvider) => {
        provider.mutationOldDeploymentIdOverride = source.deploymentId;
      },
    ]) {
      await withStateDirectory(async (stateDirectory) => {
        const { paths } = await seedTargetPhase(plan, stateDirectory);
        const provider = new FakeProvider();
        provider.aliasState = "target";
        provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");
        configure(provider);

        const failed = await runRecoverSourceCli(plan, provider, stateDirectory);

        expect(failed.exitCode).toBe(75);
        expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
          code: "compensation_failed",
          status: "recovery_required",
        });
        expect(await Bun.file(paths.sourceRecovery).exists()).toBeTrue();
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
        const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));
        expect(writes).toEqual([`set-alias:${source.deploymentUrl}`]);

        const retry = await runRecoverSourceCli(plan, provider, stateDirectory);
        expect(retry.exitCode).toBe(75);
        expect(JSON.parse(retry.stderr.join(""))).toMatchObject({
          code: "unresolved_source_recovery",
          status: "recovery_required",
        });
        expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
          .toEqual(writes);
      });
    }
  });

  test("does not receipt source authority that drifts during its proof", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { paths } = await seedTargetPhase(plan, stateDirectory);
      const provider = new FakeProvider();
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");
      let markerReads = 0;
      provider.afterReadMarker = () => {
        markerReads += 1;
        if (markerReads === 3) provider.aliasState = "target";
      };

      const drifted = await runRecoverSourceCli(plan, provider, stateDirectory);

      expect(drifted.exitCode).toBe(75);
      expect(JSON.parse(drifted.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${source.deploymentUrl}`]);
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("fails closed when target-phase publication fails after target mutation", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const provider = new FakeProvider();
      provider.beforeSetAlias = async (endpoint) => {
        if (endpoint.deploymentId === target.deploymentId) {
          await writeFile(paths.targetPhase, "{}\n", { flag: "wx", mode: 0o600 });
        }
      };

      const failed = await runExecuteCli(plan, provider, stateDirectory);

      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "target_phase_write_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual([`set-alias:${target.deploymentUrl}`]);
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("fails closed before source mutation when source-recovery publication fails", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { paths } = await seedTargetPhase(plan, stateDirectory);
      const provider = new FakeProvider();
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");
      let targetMarkerReads = 0;
      provider.afterReadMarker = async () => {
        if (provider.aliasState !== "target") return;
        targetMarkerReads += 1;
        if (targetMarkerReads === 2) {
          await writeFile(paths.sourceRecovery, "{}\n", { flag: "wx", mode: 0o600 });
        }
      };

      const failed = await runRecoverSourceCli(plan, provider, stateDirectory);

      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "source_recovery_write_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("never retries after source proof when its final receipt publication fails", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { paths } = await seedTargetPhase(plan, stateDirectory);
      const provider = new FakeProvider();
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");

      const failed = await runRecoverSourceCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("receipt unavailable");
        },
      });

      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "receipt_write_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState as AliasState).toBe("source");
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));

      const retry = await runRecoverSourceCli(plan, provider, stateDirectory);
      expect(retry.exitCode).toBe(75);
      expect(JSON.parse(retry.stderr.join(""))).toMatchObject({
        code: "unresolved_source_recovery",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("rejects tampered phase records before provider reads", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const { paths, targetPhase } = await seedTargetPhase(plan, stateDirectory);
      await writeFile(paths.targetPhase, `${JSON.stringify({
        ...targetPhase,
        targetMutationKey: "f".repeat(64),
      })}\n`, { mode: 0o600 });
      const provider = new FakeProvider();
      provider.aliasState = "target";
      provider.targetMarkerOverride = markerWithVersion(target, "0.1.99");

      const refused = await runRecoverSourceCli(plan, provider, stateDirectory);

      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "durable_state_invalid",
        status: "recovery_required",
      });
      expect(provider.operations).toEqual([]);
      expect(await Bun.file(paths.sourceRecovery).exists()).toBeFalse();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("renders a second authority-read failure after intent as recovery required", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.failVerifyVercelAt = 2;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const failed = await runExecuteCli(plan, provider, stateDirectory);
      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "provider_command_failed",
        idempotencyKey: plan.idempotencyKey,
        intentPath: paths.intent,
        receiptPath: paths.receipt,
        status: "recovery_required",
      });
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();

      const replayProvider = new FakeProvider();
      const replay = await runExecuteCli(plan, replayProvider, stateDirectory);
      expect(replay.exitCode).toBe(75);
      expect(JSON.parse(replay.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(replayProvider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });

  test("treats failure after intent publication as durable recovery", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);

      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        afterIntentPublication: () => {
          throw new Error("post-link readback failed");
        },
      });
      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "intent_write_failed",
        idempotencyKey: plan.idempotencyKey,
        intentPath: paths.intent,
        receiptPath: paths.receipt,
        status: "recovery_required",
      });
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });

  test("blocks mutation when a target receipt publication leaves only an intent", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("receipt unavailable");
        },
      });

      expect(failed.exitCode).toBe(75);
      expect(JSON.parse(failed.stderr.join(""))).toMatchObject({
        code: "receipt_write_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("target");
      expect(await Bun.file(paths.intent).exists()).toBeTrue();
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      expect(recovered.exitCode).toBe(75);
      expect(JSON.parse(recovered.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writesBeforeReplay);
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("recovers a crash-durable temporary hardlink before blocking replay", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("receipt unavailable");
        },
      });
      expect(failed.exitCode).toBe(75);
      const temporary = join(
        stateDirectory,
        `.${basename(paths.intent)}.${"a".repeat(32)}.tmp`,
      );
      await link(paths.intent, temporary);
      expect((await stat(paths.intent)).nlink).toBe(2);
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);

      expect(recovered.exitCode).toBe(75);
      expect(await Bun.file(temporary).exists()).toBeFalse();
      expect((await stat(paths.intent)).nlink).toBe(1);
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writesBeforeReplay);
    });
  });

  test("dispatches no mutation when a proved source receipt was lost", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const failed = await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("source receipt unavailable");
        },
      });
      expect(failed.exitCode).toBe(75);
      expect(provider.aliasState).toBe("source");
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      const replayWrites = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:")).slice(writesBeforeReplay.length);

      expect(recovered.exitCode).toBe(75);
      expect(JSON.parse(recovered.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(replayWrites).toEqual([]);
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("does not receipt a source restoration whose mutation response was ambiguous", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.sourceSetCommitAndThrow = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const ambiguous = await runExecuteCli(plan, provider, stateDirectory);
      expect(ambiguous.exitCode).toBe(75);
      expect(JSON.parse(ambiguous.stderr.join(""))).toMatchObject({
        code: "compensation_failed",
        status: "recovery_required",
      });
      expect(provider.aliasState).toBe("source");
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));

      provider.sourceSetCommitAndThrow = false;
      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      expect(recovered.exitCode).toBe(75);
      expect(JSON.parse(recovered.stderr.join(""))).toMatchObject({
        code: "unresolved_current_intent",
        status: "recovery_required",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("dispatches no mutation from a blocked unresolved intent", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      expect((await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("target receipt unavailable");
        },
      })).exitCode).toBe(75);
      expect(provider.aliasState).toBe("target");
      provider.breakTargetMarker = true;
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));

      const recovered = await runExecuteCli(plan, provider, stateDirectory);
      const replayWrites = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:")).slice(writesBeforeReplay.length);

      expect(recovered.exitCode).toBe(75);
      expect(provider.aliasState).toBe("target");
      expect(replayWrites).toEqual([]);
      expect(await Bun.file(paths.receipt).exists()).toBeFalse();
    });
  });

  test("records a proven source restoration and replays it without another write", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      let sourceRecoveryObservedBeforeMutation = false;
      provider.beforeSetAlias = async (endpoint) => {
        if (endpoint.deploymentId !== source.deploymentId) return;
        const intent = readProtectedJson(paths.intent, currentAliasReleaseIntentSchema);
        const targetPhase = readProtectedJson(
          paths.targetPhase,
          currentAliasReleaseTargetPhaseSchema,
        );
        const sourceRecovery = readProtectedJson(
          paths.sourceRecovery,
          currentAliasReleaseSourceRecoverySchema,
        );
        expect(sourceRecovery).toMatchObject({
          intentDigest: intent.selfDigest,
          rollbackDiagnostic: {
            phase: "target_probe",
            reason: "marker_mismatch",
          },
          sourceRecoveryKey: currentAliasReleaseMutationKey(plan, "restore-source"),
          targetPhaseDigest: targetPhase.selfDigest,
        });
        expect(await Bun.file(paths.receipt).exists()).toBeFalse();
        sourceRecoveryObservedBeforeMutation = true;
      };
      const reverted = await runExecuteCli(plan, provider, stateDirectory);

      expect(reverted.exitCode).toBe(1);
      expect(JSON.parse(reverted.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      const targetPhase = readProtectedJson(
        paths.targetPhase,
        currentAliasReleaseTargetPhaseSchema,
      );
      const sourceRecovery = readProtectedJson(
        paths.sourceRecovery,
        currentAliasReleaseSourceRecoverySchema,
      );
      expect(sourceRecoveryObservedBeforeMutation).toBeTrue();
      expect(readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema))
        .toMatchObject({
          finalState: "source",
          sourceRecoveryDigest: sourceRecovery.selfDigest,
          targetPhaseDigest: targetPhase.selfDigest,
        });
      const writes = provider.operations.filter((operation) => operation.startsWith("set-alias:"));

      const replay = await runExecuteCli(plan, provider, stateDirectory);
      expect(replay.exitCode).toBe(1);
      expect(JSON.parse(replay.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writes);
    });
  });

  test("continues to parse self-digested source receipts from before diagnostics", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      expect((await runExecuteCli(plan, provider, stateDirectory)).exitCode).toBe(1);
      const current = readProtectedJson(paths.receipt, currentAliasReleaseReceiptSchema);
      const {
        rollbackDiagnostic: omittedRollbackDiagnostic,
        selfDigest: omittedSelfDigest,
        sourceRecoveryDigest: omittedSourceRecoveryDigest,
        targetPhaseDigest: omittedTargetPhaseDigest,
        ...legacyFields
      } = current;
      void omittedRollbackDiagnostic;
      void omittedSelfDigest;
      void omittedSourceRecoveryDigest;
      void omittedTargetPhaseDigest;

      const legacy = currentAliasReleaseReceiptSchema.parse(withSelfDigest(legacyFields));
      await rm(paths.sourceRecovery);
      await rm(paths.targetPhase);
      await writeFile(paths.receipt, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });
      const writesBeforeReplay = provider.operations.filter((operation) =>
        operation.startsWith("set-alias:"));
      const replay = await runExecuteCli(plan, provider, stateDirectory);

      expect(legacy.finalState).toBe("source");
      expect(legacy.rollbackDiagnostic).toBeUndefined();
      expect(legacy.sourceRecoveryDigest).toBeUndefined();
      expect(legacy.targetPhaseDigest).toBeUndefined();
      expect(replay.exitCode).toBe(1);
      expect(JSON.parse(replay.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writesBeforeReplay);

      const recoveryReplay = await runRecoverSourceCli(plan, provider, stateDirectory);
      expect(recoveryReplay.exitCode).toBe(1);
      expect(recoveryReplay.stdout).toEqual([]);
      expect(JSON.parse(recoveryReplay.stderr.join(""))).toMatchObject({
        code: "alias_reverted",
        status: "reverted",
      });
      expect(provider.operations.filter((operation) => operation.startsWith("set-alias:")))
        .toEqual(writesBeforeReplay);
    });
  });

  test("serializes all plans behind one execution lock", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const firstProvider = new FakeProvider();
      let releaseFirst = (): void => undefined;
      let reportFirstHeld = (): void => undefined;
      const firstHeld = new Promise<void>((resolvePromise) => {
        reportFirstHeld = resolvePromise;
      });
      const firstMayContinue = new Promise<void>((resolvePromise) => {
        releaseFirst = resolvePromise;
      });
      firstProvider.beforeSetAlias = async (endpoint) => {
        if (endpoint.deploymentId !== target.deploymentId) return;
        reportFirstHeld();
        await firstMayContinue;
      };
      const first = runExecuteCli(plan, firstProvider, stateDirectory);
      await firstHeld;

      const secondProvider = new FakeProvider();
      const second = await runExecuteCli(plan, secondProvider, stateDirectory);
      expect(second.exitCode).toBe(1);
      expect(JSON.parse(second.stderr.join(""))).toMatchObject({
        code: "execution_locked",
        status: "refused",
      });
      expect(secondProvider.operations).toEqual([]);
      releaseFirst();
      expect((await first).exitCode).toBe(0);
    });
  });

  test("blocks a different plan behind an unresolved intent", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const failedProvider = new FakeProvider();
      failedProvider.breakTargetMarker = true;
      failedProvider.failSourceSet = true;
      expect((await runExecuteCli(plan, failedProvider, stateDirectory)).exitCode).toBe(75);

      const nextPlan = {
        ...plan,
        idempotencyKey: "e34dc7a8-7df7-42d3-9e9f-6e95bcf2541d",
      };
      const nextProvider = new FakeProvider();
      const blocked = await runExecuteCli(nextPlan, nextProvider, stateDirectory);
      const blockedResult = JSON.parse(blocked.stderr.join("")) as Record<string, unknown>;
      const priorPaths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const nextPaths = currentAliasReleaseStatePaths(nextPlan, stateDirectory);
      expect(blocked.exitCode).toBe(75);
      expect(blockedResult).toMatchObject({
        code: "unresolved_prior_intent",
        idempotencyKey: plan.idempotencyKey,
        intentPath: priorPaths.intent,
        receiptPath: priorPaths.receipt,
        status: "recovery_required",
      });
      expect(blockedResult.intentPath).not.toBe(nextPaths.intent);
      expect(blockedResult.receiptPath).not.toBe(nextPaths.receipt);
      expect(nextProvider.operations).toEqual([]);
    });
  });

  test("refuses changed reuse of an existing idempotency key before provider reads", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      expect((await runExecuteCli(plan, provider, stateDirectory, {
        receiptWriter: () => {
          throw new Error("receipt unavailable");
        },
      })).exitCode).toBe(75);

      const changedPlan: CurrentProjectAliasReleasePlan = {
        ...plan,
        vercel: {
          ...plan.vercel,
          target: { ...plan.vercel.target, sourceCommit: "3".repeat(40) },
        },
      };
      const changedProvider = new FakeProvider();
      const refused = await runExecuteCli(changedPlan, changedProvider, stateDirectory);
      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "durable_state_invalid",
        status: "recovery_required",
      });
      expect(changedProvider.operations).toEqual([]);
    });
  });

  test("refuses removing CLI source provenance from a completed plan before provider reads", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.activePlan = cliSourcePlan;
      expect((await runExecuteCli(cliSourcePlan, provider, stateDirectory)).exitCode).toBe(0);

      const changedProvider = new FakeProvider();
      const refused = await runExecuteCli(plan, changedProvider, stateDirectory);
      expect(refused.exitCode).toBe(75);
      expect(JSON.parse(refused.stderr.join(""))).toMatchObject({
        code: "durable_state_invalid",
        status: "recovery_required",
      });
      expect(changedProvider.operations).toEqual([]);
    });
  });

  test("does not publish a source intent for an unplanned provider state", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.aliasState = "unknown";
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const refused = await runExecuteCli(plan, provider, stateDirectory);

      expect(refused.exitCode).toBe(1);
      expect(await Bun.file(paths.intent).exists()).toBeFalse();
      expect(provider.operations.some((operation) => operation.startsWith("set-alias:")))
        .toBeFalse();
    });
  });
});

describe("current-project alias CLI", () => {
  test("emits a read-only ready result with the exact required confirmation", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      const stdout: string[] = [];
      const stderr: string[] = [];
      const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
        { provider, stateDirectory },
        {
          arguments: ["preflight", "--vercel-auth-fd", "3"],
          inputDocument: JSON.stringify(plan),
          stderr: { write: (value) => {
            stderr.push(String(value));
            return true;
          } },
          stdout: { write: (value) => {
            stdout.push(String(value));
            return true;
          } },
        },
      );

      expect(exitCode).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout.join(""))).toEqual({
        alias: "oompa.app",
        idempotencyKey: plan.idempotencyKey,
        nextAction: "execute_with_machine_token_under_standing_task_authority",
        observedState: "source",
        reason: "exact_source",
        requiredConfirmation: requiredAliasConfirmation(plan),
        schemaVersion: 3,
        sourceDeploymentId: source.deploymentId,
        status: "ready",
        targetDeploymentId: target.deploymentId,
        targetProjectId: OOMPA_VERCEL_PROJECT_ID,
      });
    });
  });

  test("renders failed compensation as terminal recovery instead of success", async () => {
    await withStateDirectory(async (stateDirectory) => {
      const provider = new FakeProvider();
      provider.breakTargetMarker = true;
      provider.failSourceSet = true;
      const stdout: string[] = [];
      const stderr: string[] = [];
      const paths = currentAliasReleaseStatePaths(plan, stateDirectory);
      const exitCode = await executeCurrentProjectAliasReleaseWithExplicitCapability(
        { provider, stateDirectory },
        {
          arguments: [
            "--execute",
            "--vercel-auth-fd",
            "3",
            "--confirm-exact",
            requiredAliasConfirmation(plan),
          ],
          clock: immediateClock(),
          inputDocument: JSON.stringify(plan),
          stderr: { write: (value) => {
            stderr.push(String(value));
            return true;
          } },
          stdout: { write: (value) => {
            stdout.push(String(value));
            return true;
          } },
          timeoutMs: 1,
        },
      );

      expect(exitCode).toBe(75);
      expect(stdout).toEqual([]);
      expect(JSON.parse(stderr.join(""))).toEqual({
        code: "compensation_failed",
        idempotencyKey: plan.idempotencyKey,
        intentPath: paths.intent,
        lockPath: join(stateDirectory, ".canonical-alias-release.lock"),
        receiptPath: paths.receipt,
        schemaVersion: 1,
        status: "recovery_required",
      });
    });
  });

  test("accepts only the closed preflight, execute, and source-recovery surfaces", () => {
    expect(parseArguments([
      "preflight",
      "--vercel-auth-fd",
      "3",
    ])).toEqual({ operation: "preflight", planFd: 0, vercelAuthFd: 3 });
    expect(parseArguments([
      "--execute",
      "--vercel-auth-fd",
      "4",
      "--confirm-exact",
      requiredAliasConfirmation(plan),
      "--plan-fd",
      "3",
    ])).toEqual({
      confirmation: requiredAliasConfirmation(plan),
      operation: "execute",
      planFd: 3,
      vercelAuthFd: 4,
    });
    expect(parseArguments([
      "preflight",
      "--vercel-cli",
      "/safe/bin/vercel",
    ])).toEqual({ operation: "preflight", planFd: 0, vercelCli: "/safe/bin/vercel" });
    expect(parseArguments([
      "recover-source",
      "--vercel-auth-fd",
      "4",
      "--confirm-exact",
      requiredAliasConfirmation(plan),
      "--plan-fd",
      "3",
      "--recovery-evidence-fd",
      "5",
    ])).toEqual({
      confirmation: requiredAliasConfirmation(plan),
      operation: "recover-source",
      planFd: 3,
      recoveryEvidenceFd: 5,
      vercelAuthFd: 4,
    });
    for (const arguments_ of [
      ["preflight", "--vercel-cli", "vercel"],
      ["preflight", "--vercel-auth-fd", "2"],
      ["preflight", "--vercel-auth-fd", "3", "--plan-fd", "3"],
      ["preflight", "--vercel-auth-fd", "3", "--vercel-cli", "/safe/bin/vercel"],
      ["preflight", "--vercel-auth-fd", "3", "--confirm-exact", "approve both"],
      ["--execute", "--vercel-auth-fd", "3", "--force"],
      ["--execute", "--vercel-auth-fd", "3", "--domain"],
      ["--execute", "--vercel-auth-fd", "3", "--dns"],
      ["--execute", "--vercel-auth-fd", "3", "--recovery-evidence-fd", "4"],
      ["preflight", "--vercel-auth-fd", "3", "--recovery-evidence-fd", "4"],
      ["recover-source", "--vercel-auth-fd", "3", "--recovery-evidence-fd", "2"],
      ["recover-source", "--vercel-auth-fd", "3", "--recovery-evidence-fd", "3"],
      [
        "recover-source",
        "--vercel-auth-fd",
        "4",
        "--plan-fd",
        "3",
        "--recovery-evidence-fd",
        "3",
      ],
      ["recover-source", "--vercel-auth-fd", "3", "--force"],
      ["recover-source", "--execute", "--vercel-auth-fd", "3"],
    ]) expect(() => parseArguments(arguments_)).toThrow("usage_invalid");
  });
});
