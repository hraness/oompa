import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BoundedProcessCleanupUnprovenError,
  BoundedProcessContainmentUnavailableError,
  BoundedProcessRecoveryJournalError,
} from "./bounded-process";
import {
  buildVercelEnvironment,
  DomainCutoverError,
  executeCutoverPlan,
  executeDomainCutover as executeRetiredDomainCutover,
  executeHistoricalDomainCutoverWithExplicitCapability as executeDomainCutover,
  parseArguments,
  parseCutoverPlan,
  preflightCutoverPlan,
  VercelCutoverProvider,
  type AliasReadback,
  type CutoverEndpoint,
  type CutoverPlan,
  type CutoverProvider,
  type DeploymentReadback,
  type ManagedAlias,
  type ProjectReadback,
  type VercelCommandRequest,
  type VercelCommandRunner,
} from "./domain-cutover";

const oldProjectId = "prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr";
const newProjectId = "prj_8ciIt9t9foE3utG45frRN7cxckjS";
const oldRepositoryId = 1_334_876_494;
const newRepositoryId = 1_343_008_607;
const teamId = "team_UAd1iD2XogJlbFg4h14mRaPM";
const canonicalAlias = "oompa.dev";
const fallbackAlias = "oompa-weld.vercel.app";
const newStagingAlias = "hra.vercel.app";

const oldEndpoint: CutoverEndpoint = {
  deploymentId: "dpl_ArchiveAccepted1234567890",
  deploymentUrl: "oompa-v0-accepted-hraness.vercel.app",
  generation: 1,
  projectId: oldProjectId,
  repositoryId: oldRepositoryId,
  sourceCommit: "443448b79e9016e00d52501f047fce3a408de092",
  version: "0.1.15",
};

const newEndpoint: CutoverEndpoint = {
  deploymentId: "dpl_NewAccepted1234567890123",
  deploymentUrl: "oompa-new-accepted-hraness.vercel.app",
  generation: 1,
  projectId: newProjectId,
  repositoryId: newRepositoryId,
  sourceCommit: "2222222222222222222222222222222222222222",
  version: "0.1.0",
};

const forwardPlan: CutoverPlan = {
  direction: "forward",
  mode: "domain",
  schemaVersion: 1,
  source: oldEndpoint,
  target: newEndpoint,
};

const reversePlan: CutoverPlan = {
  direction: "reverse",
  mode: "domain",
  schemaVersion: 1,
  source: newEndpoint,
  target: oldEndpoint,
};

const baselineEndpoint: CutoverEndpoint = {
  ...oldEndpoint,
  deploymentId: "dpl_BaselineAccepted123456789",
  deploymentUrl: "oompa-baseline-hraness.vercel.app",
  generation: null,
  sourceCommit: "6221f79b745f154882080936b961ff431569f33e",
};

const archivePlan: CutoverPlan = {
  direction: "archive",
  mode: "traffic-only",
  schemaVersion: 1,
  source: baselineEndpoint,
  target: oldEndpoint,
};

const deploymentFor = (endpoint: CutoverEndpoint): DeploymentReadback => ({
  gitSource: {
    ref: "main",
    repoId: endpoint.repositoryId,
    sha: endpoint.sourceCommit,
    type: "github",
  },
  id: endpoint.deploymentId,
  projectId: endpoint.projectId,
  readyState: "READY",
  url: endpoint.deploymentUrl,
});

const aliasFor = (
  endpoint: CutoverEndpoint,
  aliasName: ManagedAlias = canonicalAlias,
): AliasReadback => ({
  alias: aliasName,
  deployment: { id: endpoint.deploymentId, url: endpoint.deploymentUrl },
  deploymentId: endpoint.deploymentId,
  projectId: endpoint.projectId,
});

const projectFor = (
  projectId: typeof oldProjectId | typeof newProjectId,
): ProjectReadback => ({
  accountId: teamId,
  autoAssignCustomDomains: false,
  id: projectId,
});

const markerFor = (endpoint: CutoverEndpoint): unknown => {
  const shared = {
    generation: endpoint.generation,
    product: "Oompa",
    repository: {
      id: endpoint.repositoryId,
      path: endpoint.projectId === oldProjectId ? "hraness/hra-v0" : "hraness/oompa",
    },
    schemaVersion: 2,
    source: { commit: endpoint.sourceCommit },
  };
  return endpoint.projectId === oldProjectId
    ? {
        ...shared,
        publication: {
          build: 16,
          dmgSha256: "120b600d7cc11df260836198601cba91db33efc7b600dd2b601bde686c9ea028",
          publicationCommit: "d96173c3556799cb203a4d659f29856180838029",
          releaseId: 376_100_700,
          sourceCommit: "0c7764da0dea0a71bbccca817539a02d8e4284d0",
          tag: `v${endpoint.version}`,
          tagObject: "e5bcf5c919e8a7ffcdccc337b8940b60a70f0489",
          version: endpoint.version,
        },
      }
    : { ...shared, version: endpoint.version };
};

const domainPage = (
  names: readonly string[],
  next: number | null = null,
  prev: number | null = null,
): unknown => ({
  domains: names.map((name) => ({ name })),
  pagination: { count: names.length, next, prev },
});

type MoveBehavior = "ambiguous" | "commit" | "commit-and-throw" | "move-and-source-alias" | "noop";

class FakeCutoverProvider implements CutoverProvider {
  readonly aliasEndpoints: Record<ManagedAlias, CutoverEndpoint>;
  driftAfterAliasRead: Readonly<{
    aliasName: ManagedAlias;
    endpoint: CutoverEndpoint;
    remainingMatches?: number;
    triggerAlias: ManagedAlias;
    triggerEndpoint: CutoverEndpoint;
  }> | undefined;
  driftAfterMarkerRead: Readonly<{
    aliasName: ManagedAlias;
    endpoint: CutoverEndpoint;
    remainingMatches?: number;
    triggerAlias: ManagedAlias;
    triggerEndpoint: CutoverEndpoint;
  }> | undefined;
  readonly markerBrokenAliases = new Set<ManagedAlias>();
  markerBrokenForTargetAlias: ManagedAlias | undefined;
  markerOverrideForTargetAlias: Readonly<{ alias: ManagedAlias; value: unknown }> | undefined;
  moveBehavior: MoveBehavior = "commit";
  owner: "ambiguous" | "source" | "target" = "source";
  ownerReadOverride: "ambiguous" | "source" | "target" | undefined;
  ownerReadOverrideDomainReads = 0;
  readonly ownerReadOverrides: Array<"ambiguous" | "source" | "target"> = [];
  ownerAfterTargetAliasSet: Readonly<{
    alias: ManagedAlias;
    owner: "ambiguous" | "source" | "target";
  }> | undefined;
  reverseMoveAliasPerturbation: Readonly<{
    aliasName: ManagedAlias;
    endpoint: CutoverEndpoint;
  }> | undefined;
  reverseMoveCommitAndThrow = false;
  reverseMoveStaleDomainReads = 0;
  sourceAliasSetFailure: ManagedAlias | undefined;
  staleOwnerDomainReads = 0;
  targetAliasSetFailure: ManagedAlias | undefined;
  readonly operations: string[] = [];
  readonly plan: CutoverPlan;
  readonly projectReadbacks: Record<string, unknown> = {
    [newProjectId]: projectFor(newProjectId),
    [oldProjectId]: projectFor(oldProjectId),
  };

  constructor(plan: CutoverPlan) {
    this.plan = plan;
    const acceptedArchive = plan.direction === "forward" ? plan.source : plan.target;
    const acceptedNew = plan.direction === "forward" ? plan.target : plan.source;
    this.aliasEndpoints = {
      [canonicalAlias]: plan.source,
      [fallbackAlias]: plan.direction === "archive" ? plan.source : acceptedArchive,
      [newStagingAlias]: plan.direction === "archive" ? plan.target : acceptedNew,
    };
  }

  get aliasEndpoint(): CutoverEndpoint {
    return this.aliasEndpoints[canonicalAlias];
  }

  get fallbackAliasEndpoint(): CutoverEndpoint {
    return this.aliasEndpoints[fallbackAlias];
  }

  async readAlias(aliasName: ManagedAlias): Promise<AliasReadback> {
    const endpoint = this.aliasEndpoints[aliasName];
    this.operations.push(`read-alias:${aliasName}:${endpoint.deploymentId}`);
    const value = aliasFor(endpoint, aliasName);
    const drift = this.driftAfterAliasRead;
    if (
      drift !== undefined
      && drift.triggerAlias === aliasName
      && drift.triggerEndpoint === endpoint
    ) {
      const remainingMatches = drift.remainingMatches ?? 1;
      if (remainingMatches === 1) {
        this.driftAfterAliasRead = undefined;
        this.aliasEndpoints[drift.aliasName] = drift.endpoint;
        this.operations.push(
          `drift-alias:${drift.aliasName}:${drift.endpoint.deploymentUrl}`,
        );
      } else {
        this.driftAfterAliasRead = { ...drift, remainingMatches: remainingMatches - 1 };
      }
    }
    return value;
  }

  async readDeployment(deploymentId: string): Promise<DeploymentReadback> {
    this.operations.push(`read-deployment:${deploymentId}`);
    const endpoint = [this.plan.source, this.plan.target]
      .find((candidate) => candidate.deploymentId === deploymentId);
    if (endpoint === undefined) throw new Error("unknown deployment");
    return deploymentFor(endpoint);
  }

  async readDomainNames(projectId: string): Promise<readonly string[]> {
    this.operations.push(`read-domains:${projectId}`);
    if (this.ownerReadOverrideDomainReads === 0 && this.ownerReadOverrides.length > 0) {
      this.ownerReadOverride = this.ownerReadOverrides.shift();
      this.ownerReadOverrideDomainReads = 2;
    }
    const owner = this.ownerReadOverride
      ?? (this.staleOwnerDomainReads > 0 ? "target" : this.owner);
    if (this.ownerReadOverrideDomainReads > 0) {
      this.ownerReadOverrideDomainReads -= 1;
      if (this.ownerReadOverrideDomainReads === 0) this.ownerReadOverride = undefined;
    } else if (this.staleOwnerDomainReads > 0) this.staleOwnerDomainReads -= 1;
    if (owner === "ambiguous") return ["oompa.dev"];
    const sourceProjectId = this.plan.direction === "archive"
      ? oldProjectId
      : this.plan.source.projectId;
    const targetProjectId = this.plan.direction === "archive"
      ? newProjectId
      : this.plan.target.projectId;
    if (owner === "source") {
      return projectId === sourceProjectId ? ["oompa.dev"] : [];
    }
    return projectId === targetProjectId ? ["oompa.dev"] : [];
  }

  async readMarker(aliasName: ManagedAlias): Promise<unknown> {
    const endpoint = this.aliasEndpoints[aliasName];
    this.operations.push(`read-marker:${aliasName}:${endpoint.deploymentId}`);
    let value: unknown;
    if (
      this.markerOverrideForTargetAlias?.alias === aliasName
      && endpoint === this.plan.target
    ) value = this.markerOverrideForTargetAlias.value;
    else if (
      this.markerBrokenAliases.has(aliasName)
      || (this.markerBrokenForTargetAlias === aliasName && endpoint === this.plan.target)
    ) {
      value = { ...markerFor(endpoint) as object, source: { commit: "0".repeat(40) } };
    } else value = markerFor(endpoint);
    const drift = this.driftAfterMarkerRead;
    if (
      drift !== undefined
      && drift.triggerAlias === aliasName
      && drift.triggerEndpoint === endpoint
    ) {
      const remainingMatches = drift.remainingMatches ?? 1;
      if (remainingMatches === 1) {
        this.driftAfterMarkerRead = undefined;
        this.aliasEndpoints[drift.aliasName] = drift.endpoint;
        this.operations.push(
          `drift-alias:${drift.aliasName}:${drift.endpoint.deploymentUrl}`,
        );
      } else {
        this.driftAfterMarkerRead = { ...drift, remainingMatches: remainingMatches - 1 };
      }
    }
    return value;
  }

  async readProject(projectId: string): Promise<ProjectReadback> {
    this.operations.push(`read-project:${projectId}`);
    const value = this.projectReadbacks[projectId];
    if (value === undefined) throw new Error("unknown project");
    return value as ProjectReadback;
  }

  async setAlias(deploymentUrl: string, aliasName: ManagedAlias): Promise<void> {
    this.operations.push(`set-alias:${aliasName}:${deploymentUrl}`);
    const endpoint = [this.plan.source, this.plan.target]
      .find((candidate) => candidate.deploymentUrl === deploymentUrl);
    if (endpoint === undefined) throw new Error("unknown alias target");
    if (this.sourceAliasSetFailure === aliasName && endpoint === this.plan.source) {
      throw new Error("alias restoration failed");
    }
    if (this.targetAliasSetFailure === aliasName && endpoint === this.plan.target) {
      this.targetAliasSetFailure = undefined;
      this.aliasEndpoints[aliasName] = endpoint;
      throw new Error("ambiguous alias mutation");
    }
    this.aliasEndpoints[aliasName] = endpoint;
    if (
      endpoint === this.plan.target
      && this.ownerAfterTargetAliasSet?.alias === aliasName
    ) this.owner = this.ownerAfterTargetAliasSet.owner;
  }

  async moveDomain(sourceProjectId: string, targetProjectId: string): Promise<void> {
    this.operations.push(`move:${sourceProjectId}->${targetProjectId}`);
    if (
      sourceProjectId === this.plan.target.projectId
      && targetProjectId === this.plan.source.projectId
    ) {
      this.owner = "source";
      this.staleOwnerDomainReads = this.reverseMoveStaleDomainReads;
      const perturbation = this.reverseMoveAliasPerturbation;
      if (perturbation !== undefined) {
        this.aliasEndpoints[perturbation.aliasName] = perturbation.endpoint;
        this.operations.push(
          `perturb-alias:${perturbation.aliasName}:${perturbation.endpoint.deploymentUrl}`,
        );
      }
      if (this.reverseMoveCommitAndThrow) throw new Error("lost reverse move response");
      return;
    }
    if (this.moveBehavior === "commit" || this.moveBehavior === "commit-and-throw") {
      this.owner = "target";
    }
    if (this.moveBehavior === "ambiguous") this.owner = "ambiguous";
    if (this.moveBehavior === "move-and-source-alias") {
      this.owner = "target";
      this.aliasEndpoints[canonicalAlias] = this.plan.source;
    }
    if (this.moveBehavior === "commit-and-throw") throw new Error("lost move response");
  }
}

const placeAtTarget = (provider: FakeCutoverProvider): void => {
  provider.aliasEndpoints[canonicalAlias] = provider.plan.target;
  if (provider.plan.direction === "archive") {
    provider.aliasEndpoints[fallbackAlias] = provider.plan.target;
    provider.owner = "source";
  } else {
    provider.owner = "target";
  }
};

const immediateClock = () => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (milliseconds: number) => {
      now += milliseconds;
    },
  };
};

describe("domain cutover runbook", () => {
  test("bounds production-only scripts and preserves page-specific controllers", async () => {
    const runbook = await readFile(
      join(import.meta.dir, "..", "docs", "domain-cutover.md"),
      "utf8",
    );
    expect(runbook).toContain("without a client challenge script");
    expect(runbook).toContain("Validate exactly the markup emitted by the pinned `@hraness/site-footer`");
    expect(runbook).toContain("one occurrence on each navigable page and none on `/preview/`");
    expect(runbook).toContain("do not exempt arbitrary third-party scripts");
    expect(runbook).toContain("Preserve exact owned stylesheet and script references");
    expect(runbook).toContain("homepage and six documentation pages load `/site.js`");
    expect(runbook).toContain("`/privacy/` uses `/appearance.js` without `/site.js`");
    expect(runbook).toContain("`/preview/` remains inert");
  });

  test("pins current provider authority and retired identities as one-way tombstones", async () => {
    const runbook = await readFile(
      join(import.meta.dir, "..", "docs", "domain-cutover.md"),
      "utf8",
    );

    expect(runbook).toContain("Oompa v0 status: retired on 2026-08-27.");
    expect(runbook).toContain("current-project-only");
    expect(runbook).toContain("1343008607");
    expect(runbook).toContain("prj_8ciIt9t9foE3utG45frRN7cxckjS");
    expect(runbook).toContain("2854545");
    expect(runbook).toContain("5089017");
    expect(runbook).toContain("safety tombstones");
    expect(runbook).toContain("1334876494");
    expect(runbook).toContain("prj_eRfUBHdHkEbvIaB8x7dyyZhBc3wr");
    expect(runbook).toContain("2680173");
    expect(runbook).toContain("4677913");
    expect(runbook).toContain("Do not invoke or import it for provider work.");
  });

  test("exposes only the checked current-project alias procedure", async () => {
    const runbook = await readFile(
      join(import.meta.dir, "..", "docs", "domain-cutover.md"),
      "utf8",
    );
    const commands = runbook.split("\n").filter((line) => line.startsWith("vercel "));

    expect(commands).toEqual([]);
    expect(runbook).not.toContain("hosted:domain-cutover preflight");
    expect(runbook).toContain("bun ./scripts/current-project-alias-release.ts preflight");
    expect(runbook).toContain("bun ./scripts/current-project-alias-release.ts --execute");
    expect(runbook).toContain("bun ./scripts/current-project-alias-release.ts recover-source");
    const aliasCommands = [...runbook.matchAll(
      /```sh\n(bun \.\/scripts\/current-project-alias-release\.ts [\s\S]*?)\n```/g,
    )].map((match) => match[1]!);
    expect(aliasCommands).toHaveLength(4);
    for (const command of aliasCommands) {
      expect(command).toContain("--vercel-auth-file /absolute/path/to/reviewed-vercel-auth.json");
      expect(command).toContain("--plan-file /absolute/path/to/");
      expect(command).not.toMatch(/--(?:vercel-auth|plan|recovery-evidence)-fd\b/);
    }
    expect(aliasCommands.filter((command) => command.includes("--recovery-evidence-file")))
      .toHaveLength(1);
    expect(aliasCommands[3]).toContain(
      "--recovery-evidence-file /absolute/path/to/reviewed-compound-phase-evidence.json",
    );
    expect(runbook).not.toContain("bun run release:canonical-alias");
    expect(runbook).toContain("--confirm-exact");
    expect(runbook).toContain("standing authorization for task-owned Hraness delivery");
    expect(runbook).toContain("Do not ask for a second conversational confirmation");
    expect(runbook).toContain("fresh plan and passing preflight narrow existing task authority");
    expect(runbook).toContain("No person needs to see, copy, reproduce, or separately approve");
    expect(runbook).toContain(
      "designated custodian passes the exact `requiredConfirmation` value",
    );
    expect(runbook).toContain(
      '`nextAction: "execute_with_machine_token_under_standing_task_authority"`',
    );
    expect(runbook).toContain("Its result uses `schemaVersion: 3`");
    expect(runbook).not.toContain("obtain_conversational_plan_approval_then_execute_with_machine_token");
    expect(runbook).not.toContain("in a separate conversational turn");
    expect(runbook).not.toContain("confirm_exact_record_then_execute");
    expect(runbook).toContain("automatic restoration");
    expect(runbook).toContain("compensation_failed");
    expect(runbook).toContain("self-digested target phase record");
    expect(runbook).toContain("self-digested source-recovery intent");
    expect(runbook).toContain("never dispatches the target assignment");
    expect(runbook).toContain("exact original machine confirmation");
    expect(runbook).toContain("provider `aliases-assigned` Activity event");
    expect(runbook).toContain("it is not represented as an `oldDeploymentId` response");
    expect(runbook).toContain("The only admitted target-authority defect is `marker_mismatch`");
    expect(runbook).toContain("recovery refuses rather than undoing a proved release");
    expect(runbook).toContain("Two consecutive full source-authority samples");
    expect(runbook).toContain('status: "recovered_source"');
    expect(runbook).toContain("target_phase_write_failed");
    expect(runbook).toContain("source_recovery_write_failed");
    expect(runbook).toContain("recovery_evidence_invalid");
    expect(runbook).toContain("recovery_not_permitted");
    expect(runbook).toContain("unresolved_source_recovery");
    expect(runbook).toContain("8,193 persistent-entry bound");
    expect(runbook).toContain("transient 8,194th hardlink");
    expect(runbook).toContain("standing task authority may continue to cover it");
    expect(runbook).toContain("Oompa v0 is never a fallback");
    expect(runbook).not.toContain("/move");
  });

  test("keeps the active plan aligned with phase-aware source recovery", async () => {
    const plan = await readFile(
      join(import.meta.dir, "..", "kb", "plans", "oompa-v1.md"),
      "utf8",
    );

    expect(plan).toContain("self-digested target phase record");
    expect(plan).toContain("self-digested source-recovery intent");
    expect(plan).toContain("The explicit `recover-source` operation never redispatches target");
    expect(plan).toContain("It never treats an Activity record as a substitute for `oldDeploymentId`");
    expect(plan).toContain("persistent bound of 8,193 entries");
    expect(plan).toContain("Fresh forward transitions retain plan-bound machine-token enforcement without a duplicate conversational approval");
  });
});

describe("domain cutover operator", () => {
  test("the retired entry point refuses before any supplied provider capability", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let runnerCalls = 0;

    expect(await executeRetiredDomainCutover({
      arguments: ["--execute", "--vercel-cli", "/safe/vercel"],
      inputDocument: JSON.stringify(forwardPlan),
      runner: async () => {
        runnerCalls += 1;
        throw new Error("retired operator reached provider capability");
      },
      stderr: {
        write(chunk: string | Uint8Array): boolean {
          stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return true;
        },
      },
      stdout: {
        write(chunk: string | Uint8Array): boolean {
          stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return true;
        },
      },
    })).toBe(1);
    expect(runnerCalls).toBe(0);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "operator_retired",
      schemaVersion: 1,
      status: "refused",
    });
  });

  test("the retired executable refuses without parsing input or invoking a provider", async () => {
    const child = Bun.spawn([
      process.execPath,
      join(import.meta.dir, "domain-cutover.ts"),
      "--execute",
      "--vercel-cli",
      "/provider/must-not-run",
    ], {
      cwd: join(import.meta.dir, ".."),
      env: {},
      stderr: "pipe",
      stdin: "ignore",
      stdout: "pipe",
    });
    const [exitCode, stderr, stdout] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(JSON.parse(stderr)).toEqual({
      code: "operator_retired",
      schemaVersion: 1,
      status: "refused",
    });
  });

  test("the historical provider refuses without an explicitly supplied capability", () => {
    expect(() => new VercelCutoverProvider({
      vercelCli: "/safe/vercel",
    })).toThrow(new DomainCutoverError("operator_retired"));
  });

  test("refuses an unavailable authority backend without turning it into a provider read failure", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: VercelCommandRequest[] = [];
    expect(await executeDomainCutover({
      arguments: ["preflight", "--vercel-cli", "/safe/vercel"],
      inputDocument: JSON.stringify(forwardPlan),
      runner: async (request) => {
        requests.push(request);
        if (request.arguments[0] === "--version") {
          return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
        }
        throw new BoundedProcessContainmentUnavailableError(
          "authority_backend_unavailable",
        );
      },
      stderr: {
        write(chunk: string | Uint8Array): boolean {
          stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return true;
        },
      },
      stdout: {
        write(chunk: string | Uint8Array): boolean {
          stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
          return true;
        },
      },
    })).toBe(1);
    expect(requests[0]?.arguments).toEqual(["--version"]);
    expect(requests.some((request) => request.arguments[0] !== "--version")).toBe(true);
    expect(stdout).toEqual([]);
    expect(JSON.parse(stderr.join(""))).toEqual({
      code: "authority_containment_unavailable",
      reason: "authority_backend_unavailable",
      schemaVersion: 1,
      status: "refused",
    });
    expect(stderr.join("")).not.toContain("process_cleanup_unproven");
  });

  test("terminalizes cleanup and journal custody before later provider calls", async () => {
    const cleanupPath = "/private/operator/process-recovery/local-cutover.json";
    const journalPath = "/private/operator/process-recovery/authority-cutover.json";
    const cases = [
      {
        error: new BoundedProcessCleanupUnprovenError(
          42_435,
          "vercel-project-read",
        ).retainRecoveryPath(cleanupPath),
        expected: {
          code: "process_cleanup_unproven",
          phase: "vercel-project-read",
          processGroupId: 42_435,
          processes: [{
            phase: "vercel-project-read",
            recoveryIdentity: { containment: "local", processGroupId: 42_435 },
          }],
          recoveryPaths: [cleanupPath],
          schemaVersion: 1,
          status: "recovery_required",
        },
      },
      {
        error: new BoundedProcessRecoveryJournalError(
          [journalPath],
          "authority_recovery_required",
        ),
        expected: {
          code: "process_recovery_journal_blocked",
          reason: "authority_recovery_required",
          recoveryPaths: [journalPath],
          schemaVersion: 1,
          status: "recovery_required",
        },
      },
    ] as const;
    for (const scenario of cases) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const requests: VercelCommandRequest[] = [];
      let fetchCalls = 0;
      expect(await executeDomainCutover({
        arguments: ["preflight", "--vercel-cli", "/safe/vercel"],
        fetcher: async () => {
          fetchCalls += 1;
          throw new Error("unexpected marker read");
        },
        inputDocument: JSON.stringify(forwardPlan),
        runner: async (request) => {
          requests.push(request);
          if (request.arguments[0] === "--version") {
            return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
          }
          throw scenario.error;
        },
        stderr: {
          write(chunk: string | Uint8Array): boolean {
            stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return true;
          },
        },
        stdout: {
          write(chunk: string | Uint8Array): boolean {
            stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
            return true;
          },
        },
      })).toBe(75);
      expect(requests.map((request) => request.phase)).toEqual([
        "vercel-version-read",
        "vercel-project-read",
      ]);
      expect(fetchCalls).toBe(0);
      expect(stdout).toEqual([]);
      expect(JSON.parse(stderr.join(""))).toEqual(scenario.expected);
    }
  });

  test("surfaces a durable cutover reservation on terminal provider custody", async () => {
    const cleanupPath = "/private/operator/process-recovery/local-cutover-reserved.json";
    const journalPath = "/private/operator/process-recovery/authority-cutover-reserved.json";
    const cases = [
      {
        error: new BoundedProcessCleanupUnprovenError(
          42_454,
          "vercel-project-read",
        ).retainRecoveryPath(cleanupPath),
        terminalPath: cleanupPath,
        type: "cleanup" as const,
      },
      {
        error: new BoundedProcessRecoveryJournalError(
          [journalPath],
          "authority_recovery_required",
        ),
        terminalPath: journalPath,
        type: "journal" as const,
      },
    ];
    for (const scenario of cases) {
      const evidenceDirectory = await realpath(
        await mkdtemp(join(tmpdir(), "oompa-domain-terminal-evidence-")),
      );
      try {
        await chmod(evidenceDirectory, 0o700);
        const evidencePath = join(evidenceDirectory, "forward.json");
        const reservationPath = `${evidencePath}.reservation`;
        const stdout: string[] = [];
        const stderr: string[] = [];
        const requests: VercelCommandRequest[] = [];
        let fetchCalls = 0;

        expect(await executeDomainCutover({
          arguments: [
            "--execute",
            "--vercel-cli",
            "/safe/vercel",
            "--sequence",
            "1",
            "--evidence-path",
            evidencePath,
          ],
          fetcher: async () => {
            fetchCalls += 1;
            throw new Error("unexpected marker read");
          },
          inputDocument: JSON.stringify(forwardPlan),
          runner: async (request) => {
            requests.push(request);
            if (request.arguments[0] === "--version") {
              return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
            }
            throw scenario.error;
          },
          stderr: {
            write(chunk: string | Uint8Array): boolean {
              stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
              return true;
            },
          },
          stdout: {
            write(chunk: string | Uint8Array): boolean {
              stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
              return true;
            },
          },
        })).toBe(75);

        expect(requests.map((request) => request.phase)).toEqual([
          "vercel-version-read",
          "vercel-project-read",
        ]);
        expect(fetchCalls).toBe(0);
        expect(stdout).toEqual([]);
        expect(JSON.parse(stderr.join(""))).toEqual(scenario.type === "cleanup"
          ? {
              code: "process_cleanup_unproven",
              phase: "vercel-project-read",
              processGroupId: 42_454,
              processes: [{
                phase: "vercel-project-read",
                recoveryIdentity: { containment: "local", processGroupId: 42_454 },
              }],
              recoveryPaths: [evidencePath, reservationPath, scenario.terminalPath].sort(),
              schemaVersion: 1,
              status: "recovery_required",
            }
          : {
              code: "process_recovery_journal_blocked",
              reason: "authority_recovery_required",
              recoveryPaths: [evidencePath, reservationPath, scenario.terminalPath].sort(),
              schemaVersion: 1,
              status: "recovery_required",
            });
        expect(await readFile(reservationPath, "utf8")).toEndWith("\n");
      } finally {
        await rm(evidenceDirectory, { force: true, recursive: true });
      }
    }
  });

  test("requires both fixed projects to disable automatic domains before switching traffic", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    const outcome = await executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });

    expect(outcome).toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("target");
    const aliasMutation = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    const domainMutation = provider.operations.indexOf(`move:${oldProjectId}->${newProjectId}`);
    expect(aliasMutation).toBeGreaterThan(-1);
    expect(domainMutation).toBeGreaterThan(aliasMutation);
    expect(provider.operations.indexOf(
      `read-marker:${newStagingAlias}:${newEndpoint.deploymentId}`,
    )).toBeLessThan(aliasMutation);
    expect(provider.operations.slice(0, 2)).toEqual([
      `read-project:${oldProjectId}`,
      `read-project:${newProjectId}`,
    ]);
    expect(provider.operations.slice(2, 4).sort()).toEqual([
      `read-deployment:${newEndpoint.deploymentId}`,
      `read-deployment:${oldEndpoint.deploymentId}`,
    ].sort());
    expect(provider.operations.filter((operation) => operation === (
      `read-marker:${newStagingAlias}:${newEndpoint.deploymentId}`
    ))).toHaveLength(2);
    expect(provider.operations.at(-1)).toBe(`read-domains:${newProjectId}`);
  });

  for (const scenario of [
    { description: "archive", plan: archivePlan },
    { description: "forward", plan: forwardPlan },
    { description: "reverse", plan: reversePlan },
  ] as const) {
    test(`preflights exact ${scenario.description} source and target states without mutation`, async () => {
      const provider = new FakeCutoverProvider(scenario.plan);
      const source = await preflightCutoverPlan(scenario.plan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      });

      expect(source).toEqual({
        nextAction: "execute_plan",
        observedOwner: "source",
        observedState: "source",
        observedTraffic: "source",
        reason: "exact_source",
        status: "ready",
      });
      expect(provider.operations.some((operation) => (
        operation.startsWith("set-alias:") || operation.startsWith("move:")
      ))).toBe(false);
      expect(provider.operations).toContain(`read-project:${oldProjectId}`);
      expect(provider.operations).toContain(`read-project:${newProjectId}`);
      expect(provider.operations).toContain(
        `read-deployment:${scenario.plan.source.deploymentId}`,
      );
      expect(provider.operations).toContain(
        `read-deployment:${scenario.plan.target.deploymentId}`,
      );

      placeAtTarget(provider);
      const target = await preflightCutoverPlan(scenario.plan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      });
      expect(target).toEqual({
        nextAction: "replay_plan_for_receipt",
        observedOwner: scenario.plan.direction === "archive" ? "source" : "target",
        observedState: "target",
        observedTraffic: "target",
        reason: "exact_target",
        status: "already_committed",
      });
      expect(provider.operations.some((operation) => (
        operation.startsWith("set-alias:") || operation.startsWith("move:")
      ))).toBe(false);
    });
  }

  test("preflight blocks partial, ambiguous, and non-authoritative states without repair", async () => {
    const cases = [
      {
        expectedReason: "partial_state",
        prepare(provider: FakeCutoverProvider) {
          provider.aliasEndpoints[canonicalAlias] = newEndpoint;
        },
      },
      {
        expectedReason: "ambiguous_state",
        prepare(provider: FakeCutoverProvider) {
          provider.owner = "ambiguous";
        },
      },
      {
        expectedReason: "source_not_authoritative",
        prepare(provider: FakeCutoverProvider) {
          provider.markerBrokenAliases.add(fallbackAlias);
        },
      },
      {
        expectedReason: "target_not_authoritative",
        prepare(provider: FakeCutoverProvider) {
          placeAtTarget(provider);
          provider.markerBrokenAliases.add(canonicalAlias);
        },
      },
    ] as const;

    for (const scenario of cases) {
      const provider = new FakeCutoverProvider(forwardPlan);
      scenario.prepare(provider);
      const before = {
        aliases: { ...provider.aliasEndpoints },
        owner: provider.owner,
      };
      const outcome = await preflightCutoverPlan(forwardPlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      });

      expect(outcome).toMatchObject({
        nextAction: "stop_and_investigate",
        reason: scenario.expectedReason,
        status: "blocked",
      });
      expect(provider.aliasEndpoints).toEqual(before.aliases);
      expect(provider.owner).toBe(before.owner);
      expect(provider.operations.some((operation) => (
        operation.startsWith("set-alias:") || operation.startsWith("move:")
      ))).toBe(false);
    }
  });

  for (const failure of [
    {
      code: "alias_readback_invalid",
      description: "canonical alias",
      path: `/v4/aliases/${canonicalAlias}`,
      type: "provider" as const,
    },
    {
      code: "alias_readback_invalid",
      description: "archive fallback alias",
      path: `/v4/aliases/${fallbackAlias}`,
      type: "provider" as const,
    },
    {
      code: "alias_readback_invalid",
      description: "new staging alias",
      path: `/v4/aliases/${newStagingAlias}`,
      type: "provider" as const,
    },
    {
      code: "command_output_invalid",
      description: "archive project domain list",
      path: `/v9/projects/${oldProjectId}/domains?limit=20`,
      type: "provider" as const,
    },
    {
      code: "command_output_invalid",
      description: "new project domain list",
      path: `/v9/projects/${newProjectId}/domains?limit=20`,
      type: "provider" as const,
    },
    {
      aliasName: canonicalAlias,
      code: "command_output_invalid",
      description: "canonical marker",
      type: "marker" as const,
    },
    {
      aliasName: fallbackAlias,
      code: "command_output_invalid",
      description: "archive fallback marker",
      type: "marker" as const,
    },
    {
      aliasName: newStagingAlias,
      code: "command_output_invalid",
      description: "new staging marker",
      type: "marker" as const,
    },
  ] as const) {
    test(`preflight refuses an exception from the ${failure.description} without mutation`, async () => {
      const requests: VercelCommandRequest[] = [];
      let mutationCalls = 0;
      const aliases: Record<ManagedAlias, CutoverEndpoint> = {
        [canonicalAlias]: oldEndpoint,
        [fallbackAlias]: oldEndpoint,
        [newStagingAlias]: newEndpoint,
      };
      const runner: VercelCommandRunner = async (request) => {
        requests.push(request);
        const [command, path] = request.arguments;
        if (command === "--version") {
          return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
        }
        if (
          command === "alias"
          || (command === "api" && path?.endsWith(`/domains/${canonicalAlias}/move`))
        ) {
          mutationCalls += 1;
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (failure.type === "provider" && path === failure.path) {
          throw new Error("injected provider read failure");
        }
        if (path === `/v9/projects/${oldProjectId}`) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(projectFor(oldProjectId)) };
        }
        if (path === `/v9/projects/${newProjectId}`) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(projectFor(newProjectId)) };
        }
        if (path === `/v13/deployments/${oldEndpoint.deploymentId}`) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(deploymentFor(oldEndpoint)) };
        }
        if (path === `/v13/deployments/${newEndpoint.deploymentId}`) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(deploymentFor(newEndpoint)) };
        }
        if (path === `/v9/projects/${oldProjectId}/domains?limit=20`) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(domainPage([canonicalAlias])) };
        }
        if (path === `/v9/projects/${newProjectId}/domains?limit=20`) {
          return { exitCode: 0, stderr: "", stdout: JSON.stringify(domainPage([])) };
        }
        for (const aliasName of [canonicalAlias, fallbackAlias, newStagingAlias] as const) {
          if (path === `/v4/aliases/${aliasName}`) {
            return {
              exitCode: 0,
              stderr: "",
              stdout: JSON.stringify(aliasFor(aliases[aliasName], aliasName)),
            };
          }
        }
        return { exitCode: 1, stderr: "", stdout: "" };
      };
      const fetcher = async (input: string | URL | Request): Promise<Response> => {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        if (failure.type === "marker" && url.hostname === failure.aliasName) {
          throw new Error("injected marker read failure");
        }
        return new Response(
          JSON.stringify(markerFor(aliases[url.hostname as ManagedAlias])),
          { status: 200 },
        );
      };
      const stdout: string[] = [];
      const stderr: string[] = [];
      const output = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
        write: ((chunk: string | Uint8Array) => {
          chunks.push(String(chunk));
          return true;
        }) as NodeJS.WriteStream["write"],
      });

      expect(await executeDomainCutover({
        arguments: ["preflight", "--vercel-cli", "/safe/vercel"],
        environment: { HOME: "/safe/home", PATH: "/safe/bin" },
        fetcher,
        inputDocument: JSON.stringify(forwardPlan),
        runner,
        stderr: output(stderr),
        stdout: output(stdout),
      })).toBe(1);
      expect(stdout).toEqual([]);
      expect(stderr).toEqual([
        `${JSON.stringify({
          code: failure.code,
          schemaVersion: 1,
          status: "refused",
        })}\n`,
      ]);
      expect(mutationCalls).toBe(0);
      expect(requests.every((request) => request.containment === "authority")).toBe(true);
      expect(requests.some((request) => request.arguments[0] === "alias")).toBe(false);
      expect(requests.some((request) => request.arguments[1]?.endsWith(
        `/domains/${canonicalAlias}/move`,
      ))).toBe(false);
    });
  }

  for (const scenario of [
    { description: "archive", plan: archivePlan },
    { description: "forward", plan: forwardPlan },
    { description: "reverse", plan: reversePlan },
  ] as const) {
    test(`accepts an already-committed ${scenario.description} plan without mutations`, async () => {
      const provider = new FakeCutoverProvider(scenario.plan);
      placeAtTarget(provider);

      const outcome = await executeCutoverPlan(scenario.plan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      });

      expect(outcome).toEqual({ changed: false, replayed: true });
      expect(provider.operations.some((operation) => (
        operation.startsWith("set-alias:") || operation.startsWith("move:")
      ))).toBe(false);
      expect(provider.operations).toContain(`read-domains:${oldProjectId}`);
      expect(provider.operations).toContain(`read-domains:${newProjectId}`);
      expect(provider.operations).toContain(
        `read-marker:${canonicalAlias}:${scenario.plan.target.deploymentId}`,
      );
      if (scenario.plan.mode === "domain") {
        expect(provider.operations).toContain(
          `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
        );
        expect(provider.operations).toContain(
          `read-marker:${newStagingAlias}:${newEndpoint.deploymentId}`,
        );
      } else {
        expect(provider.operations).toContain(
          `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
        );
      }
    });
  }

  for (const scenario of [
    {
      canonical: baselineEndpoint,
      description: "fallback changed first",
      fallback: oldEndpoint,
    },
    {
      canonical: oldEndpoint,
      description: "canonical changed without fallback",
      fallback: baselineEndpoint,
    },
  ] as const) {
    test(`restores an archive mutation-boundary partial state when ${scenario.description}`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.aliasEndpoints[canonicalAlias] = scenario.canonical;
      provider.aliasEndpoints[fallbackAlias] = scenario.fallback;

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_reverted" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.owner).toBe("source");
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  for (const owner of ["target", "ambiguous"] as const) {
    test(`refuses an archive source state when domain ownership is ${owner}`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.owner = owner;

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_ambiguous" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.operations.some((operation) => (
        operation.startsWith("set-alias:") || operation.startsWith("move:")
      ))).toBe(false);
    });

    test(`restores archive target traffic but escalates ${owner} domain ownership`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      placeAtTarget(provider);
      provider.owner = owner;

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_ambiguous" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  for (const owner of ["target", "ambiguous"] as const) {
    test(`stops archive before canonical mutation when ownership becomes ${owner}`, async () => {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.ownerAfterTargetAliasSet = { alias: fallbackAlias, owner };

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_ambiguous" });

      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.operations).not.toContain(
        `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
      );
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  for (const plan of [forwardPlan, reversePlan] as const) {
    test(`classifies ${plan.direction} target traffic with every ownership state`, async () => {
      for (const owner of ["source", "target", "ambiguous"] as const) {
        const provider = new FakeCutoverProvider(plan);
        provider.aliasEndpoints[canonicalAlias] = plan.target;
        provider.owner = owner;

        if (owner === "target") {
          await expect(executeCutoverPlan(plan, provider, {
            clock: immediateClock(),
            convergenceTimeoutMs: 2,
          })).resolves.toEqual({ changed: false, replayed: true });
          expect(provider.aliasEndpoint).toBe(plan.target);
          expect(provider.operations.some((operation) => (
            operation.startsWith("set-alias:") || operation.startsWith("move:")
          ))).toBe(false);
        } else {
          await expect(executeCutoverPlan(plan, provider, {
            clock: immediateClock(),
            convergenceTimeoutMs: 2,
          })).rejects.toMatchObject({
            code: owner === "source" ? "cutover_reverted" : "cutover_ambiguous",
          });
          expect(provider.aliasEndpoint).toBe(plan.source);
          expect(provider.owner).toBe(owner);
        }
      }
    });
  }

  for (const aliasName of [fallbackAlias, newStagingAlias] as const) {
    test(`never accepts target replay with a broken ${aliasName} marker`, async () => {
      const provider = new FakeCutoverProvider(forwardPlan);
      placeAtTarget(provider);
      provider.markerBrokenAliases.add(aliasName);

      await expect(executeCutoverPlan(forwardPlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "compensation_failed" });

      expect(provider.aliasEndpoint).toBe(oldEndpoint);
      expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
      expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
      expect(provider.owner).toBe("target");
      expect(provider.operations).toContain(
        `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
      );
      expect(provider.operations).toContain(
        `set-alias:${newStagingAlias}:${newEndpoint.deploymentUrl}`,
      );
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  test("recovers a lost domain-move response and makes the next retry read-only", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "commit-and-throw";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).resolves.toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("target");

    provider.operations.length = 0;
    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).resolves.toEqual({ changed: false, replayed: true });
    expect(provider.operations.some((operation) => (
      operation.startsWith("set-alias:") || operation.startsWith("move:")
    ))).toBe(false);
  });

  test("restores a lost canonical-alias response and lets the retry start from exact source", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.targetAliasSetFailure = canonicalAlias;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.owner).toBe("source");

    provider.operations.length = 0;
    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).resolves.toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("target");
  });

  const unsafeProjectReadbacks = [
    {
      description: "old project reports true",
      projectId: oldProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: true, id: oldProjectId },
    },
    {
      description: "new project reports true",
      projectId: newProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: true, id: newProjectId },
    },
    {
      description: "old project omits autoAssignCustomDomains",
      projectId: oldProjectId,
      value: { accountId: teamId, id: oldProjectId },
    },
    {
      description: "new project omits autoAssignCustomDomains",
      projectId: newProjectId,
      value: { accountId: teamId, id: newProjectId },
    },
    {
      description: "old-project query returns the new project identity",
      projectId: oldProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: false, id: newProjectId },
    },
    {
      description: "new-project query returns the old project identity",
      projectId: newProjectId,
      value: { accountId: teamId, autoAssignCustomDomains: false, id: oldProjectId },
    },
    {
      description: "old project omits the numeric team identity",
      projectId: oldProjectId,
      value: { autoAssignCustomDomains: false, id: oldProjectId },
    },
    {
      description: "new project omits the numeric team identity",
      projectId: newProjectId,
      value: { autoAssignCustomDomains: false, id: newProjectId },
    },
    {
      description: "old project reports another numeric team identity",
      projectId: oldProjectId,
      value: {
        accountId: "team_AAAAAAAAAAAAAAAAAAAAAAAA",
        autoAssignCustomDomains: false,
        id: oldProjectId,
      },
    },
    {
      description: "new project reports another numeric team identity",
      projectId: newProjectId,
      value: {
        accountId: "team_AAAAAAAAAAAAAAAAAAAAAAAA",
        autoAssignCustomDomains: false,
        id: newProjectId,
      },
    },
  ] as const;

  for (const scenario of unsafeProjectReadbacks) {
    test(`refuses before deployment or traffic reads when ${scenario.description}`, async () => {
      const provider = new FakeCutoverProvider(forwardPlan);
      provider.projectReadbacks[scenario.projectId] = scenario.value;

      await expect(executeCutoverPlan(forwardPlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "automatic_domain_assignment_unsafe" });
      expect(provider.operations).toEqual([
        `read-project:${oldProjectId}`,
        `read-project:${newProjectId}`,
      ]);
    });
  }

  test("automatically restores the proven source when target marker does not converge", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.markerBrokenForTargetAlias = canonicalAlias;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
    expect(provider.operations).not.toContain(`move:${oldProjectId}->${newProjectId}`);
    expect(provider.operations).toContain(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
  });

  for (const scenario of [
    {
      aliasName: fallbackAlias,
      description: "Q fallback points at the N project",
      initial: newEndpoint,
      restored: oldEndpoint,
    },
    {
      aliasName: newStagingAlias,
      description: "N staging points at the Q project",
      initial: oldEndpoint,
      restored: newEndpoint,
    },
    {
      aliasName: fallbackAlias,
      description: "Q fallback points at an unknown old-project deployment",
      initial: {
        ...oldEndpoint,
        deploymentId: "dpl_UnknownAccepted1234567890",
        deploymentUrl: "oompa-unknown-hraness.vercel.app",
      },
      restored: oldEndpoint,
    },
  ] as const) {
    test(`repairs and refuses a partial source when ${scenario.description}`, async () => {
      const provider = new FakeCutoverProvider(forwardPlan);
      provider.aliasEndpoints[scenario.aliasName] = scenario.initial;

      await expect(executeCutoverPlan(forwardPlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_reverted" });

      expect(provider.aliasEndpoint).toBe(oldEndpoint);
      expect(provider.aliasEndpoints[scenario.aliasName]).toBe(scenario.restored);
      expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
      expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
      expect(provider.owner).toBe("source");
      expect(provider.operations).toContain(
        `set-alias:${scenario.aliasName}:${scenario.restored.deploymentUrl}`,
      );
      expect(provider.operations).not.toContain(
        `set-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
      );
      expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    });
  }

  test("restores traffic when the domain move remains on its source", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "noop";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
  });

  test("reverses exact target metadata if traffic has already returned to source", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "move-and-source-alias";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
    expect(provider.operations).toContain(`move:${newProjectId}->${oldProjectId}`);
  });

  test("restores traffic then stops on duplicate or missing ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.moveBehavior = "ambiguous";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_ambiguous" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("ambiguous");
  });

  test("restores every alias before escalating partial traffic with ambiguous ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.aliasEndpoints[newStagingAlias] = oldEndpoint;
    provider.owner = "ambiguous";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_ambiguous" });

    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.operations).toContain(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(provider.operations).toContain(
      `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(provider.operations).toContain(
      `set-alias:${newStagingAlias}:${newEndpoint.deploymentUrl}`,
    );
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
  });

  test("restores and proves exact source traffic before reporting ambiguous ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.owner = "ambiguous";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_ambiguous" });

    for (const [aliasName, endpoint] of [
      [canonicalAlias, oldEndpoint],
      [fallbackAlias, oldEndpoint],
      [newStagingAlias, newEndpoint],
    ] as const) {
      const mutation = `set-alias:${aliasName}:${endpoint.deploymentUrl}`;
      const proof = `read-marker:${aliasName}:${endpoint.deploymentId}`;
      expect(provider.operations).toContain(mutation);
      expect(provider.operations.lastIndexOf(proof)).toBeGreaterThan(
        provider.operations.indexOf(mutation),
      );
    }
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
  });

  test("refuses ownership reversal if restored traffic drifts after an early proof", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.driftAfterMarkerRead = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
      triggerAlias: canonicalAlias,
      triggerEndpoint: oldEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "compensation_failed" });

    expect(provider.operations).toContain(
      `drift-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
    expect(provider.owner).toBe("target");
  });

  test("restores traffic again when it drifts after the aggregate pre-move proof", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.driftAfterMarkerRead = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
      remainingMatches: 2,
      triggerAlias: canonicalAlias,
      triggerEndpoint: oldEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const drift = provider.operations.indexOf(
      `drift-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    const finalRestore = provider.operations.lastIndexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(drift).toBeGreaterThan(-1);
    expect(reverseMove).toBeGreaterThan(drift);
    expect(finalRestore).toBeGreaterThan(reverseMove);
    for (const [aliasName, endpoint] of [
      [canonicalAlias, oldEndpoint],
      [fallbackAlias, oldEndpoint],
      [newStagingAlias, newEndpoint],
    ] as const) {
      const proof = `read-marker:${aliasName}:${endpoint.deploymentId}`;
      expect(provider.operations.slice(reverseMove + 1).filter((operation) => (
        operation === proof
      ))).toHaveLength(3);
    }
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("reconciles a delayed domain alias write during the final full-state proof", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.driftAfterAliasRead = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
      remainingMatches: 4,
      triggerAlias: canonicalAlias,
      triggerEndpoint: oldEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    const drift = provider.operations.indexOf(
      `drift-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
      reverseMove,
    );
    const repair = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
      drift,
    );
    expect(reverseMove).toBeGreaterThan(-1);
    expect(drift).toBeGreaterThan(reverseMove);
    expect(repair).toBeGreaterThan(drift);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("reconciles a delayed archive alias write during the final full-state proof", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.aliasEndpoints[canonicalAlias] = oldEndpoint;
    provider.driftAfterAliasRead = {
      aliasName: canonicalAlias,
      endpoint: oldEndpoint,
      remainingMatches: 2,
      triggerAlias: canonicalAlias,
      triggerEndpoint: baselineEndpoint,
    };

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const drift = provider.operations.indexOf(
      `drift-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    const repair = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${baselineEndpoint.deploymentUrl}`,
      drift,
    );
    expect(drift).toBeGreaterThan(-1);
    expect(repair).toBeGreaterThan(drift);
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
    expect(provider.owner).toBe("source");
  });

  test("repairs alias perturbation caused by the reverse ownership move", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.reverseMoveAliasPerturbation = {
      aliasName: canonicalAlias,
      endpoint: newEndpoint,
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    const perturbation = provider.operations.indexOf(
      `perturb-alias:${canonicalAlias}:${newEndpoint.deploymentUrl}`,
    );
    const finalRestore = provider.operations.lastIndexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(perturbation).toBeGreaterThan(reverseMove);
    expect(finalRestore).toBeGreaterThan(perturbation);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("converges after a lost reverse-move response and stale ownership readback", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.reverseMoveCommitAndThrow = true;
    provider.reverseMoveStaleDomainReads = 2;

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    expect(provider.operations.filter((operation) => (
      operation === `move:${newProjectId}->${oldProjectId}`
    ))).toHaveLength(1);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("gives stale post-move ownership a fresh window after pre-move convergence", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.owner = "target";
    provider.ownerReadOverrides.push("target", "ambiguous", "target");
    provider.reverseMoveCommitAndThrow = true;
    provider.reverseMoveStaleDomainReads = 2;
    const clock = immediateClock();

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock,
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    expect(provider.operations.filter((operation) => (
      operation === `move:${newProjectId}->${oldProjectId}`
    ))).toHaveLength(1);
    expect(clock.now()).toBe(4);
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("proves canonical, Q, and N restoration before reversing exact target ownership", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    provider.aliasEndpoints[canonicalAlias] = newEndpoint;
    provider.aliasEndpoints[fallbackAlias] = newEndpoint;
    provider.aliasEndpoints[newStagingAlias] = oldEndpoint;
    provider.owner = "target";

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });

    const reverseMove = provider.operations.indexOf(`move:${newProjectId}->${oldProjectId}`);
    expect(reverseMove).toBeGreaterThan(-1);
    for (const mutation of [
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
      `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
      `set-alias:${newStagingAlias}:${newEndpoint.deploymentUrl}`,
    ]) {
      expect(provider.operations.indexOf(mutation)).toBeLessThan(reverseMove);
    }
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.owner as "ambiguous" | "source" | "target").toBe("source");
  });

  test("reverses N to Q while preserving both fixed staging aliases", async () => {
    const provider = new FakeCutoverProvider(reversePlan);

    const outcome = await executeCutoverPlan(reversePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });
    expect(outcome).toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("target");
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.operations).toContain(`move:${newProjectId}->${oldProjectId}`);
  });

  test("compensates an ambiguous reverse move back to N and new-project ownership", async () => {
    const provider = new FakeCutoverProvider(reversePlan);
    provider.moveBehavior = "move-and-source-alias";

    await expect(executeCutoverPlan(reversePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(newEndpoint);
    expect(provider.owner).toBe("source");
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    expect(provider.aliasEndpoints[newStagingAlias]).toBe(newEndpoint);
    expect(provider.operations).toContain(`move:${oldProjectId}->${newProjectId}`);
  });

  test("updates the archive deployment without moving project ownership", async () => {
    const provider = new FakeCutoverProvider(archivePlan);

    const outcome = await executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    });
    expect(outcome).toEqual({ changed: true, replayed: false });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
    const fallbackMutation = provider.operations.indexOf(
      `set-alias:${fallbackAlias}:${oldEndpoint.deploymentUrl}`,
    );
    const canonicalMutation = provider.operations.indexOf(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
    expect(fallbackMutation).toBeGreaterThan(-1);
    expect(canonicalMutation).toBeGreaterThan(fallbackMutation);
    expect(provider.operations.slice(fallbackMutation, canonicalMutation)).toContain(
      `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
    );
    expect(provider.operations.some((operation) => operation.startsWith("move:"))).toBe(false);
  });

  test("restores both aliases to P if the fallback Q marker is not exact", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.markerBrokenForTargetAlias = fallbackAlias;

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.operations).not.toContain(
      `set-alias:${canonicalAlias}:${oldEndpoint.deploymentUrl}`,
    );
  });

  test("refuses Oompa v0 markers with a wrong schema or top-level-only version", async () => {
    for (const value of [
      { ...markerFor(oldEndpoint) as object, schemaVersion: 1 },
      {
        generation: 1,
        product: "Oompa",
        repository: {
          id: oldEndpoint.repositoryId,
          path: "hraness/hra-v0",
        },
        schemaVersion: 2,
        source: { commit: oldEndpoint.sourceCommit },
        version: oldEndpoint.version,
      },
      {
        ...markerFor(oldEndpoint) as object,
        repository: { id: newRepositoryId, path: "hraness/oompa" },
      },
      {
        ...markerFor(oldEndpoint) as object,
        repository: { id: oldRepositoryId, path: "hraness/oompa" },
      },
    ]) {
      const provider = new FakeCutoverProvider(archivePlan);
      provider.markerOverrideForTargetAlias = { alias: fallbackAlias, value };

      await expect(executeCutoverPlan(archivePlan, provider, {
        clock: immediateClock(),
        convergenceTimeoutMs: 2,
      })).rejects.toMatchObject({ code: "cutover_reverted" });
      expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
      expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    }
  });

  test("refuses a generation-one marker whose version exists only under publication", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    const marker = markerFor(newEndpoint) as Record<string, unknown>;
    const { version, ...withoutVersion } = marker;
    provider.markerOverrideForTargetAlias = {
      alias: canonicalAlias,
      value: { ...withoutVersion, publication: { version } },
    };

    await expect(executeCutoverPlan(forwardPlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.aliasEndpoint).toBe(oldEndpoint);
    expect(provider.owner).toBe("source");
  });

  test("restores both aliases to P if oompa.dev fails after fallback Q is proven", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.targetAliasSetFailure = canonicalAlias;

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "cutover_reverted" });
    expect(provider.fallbackAliasEndpoint).toBe(baselineEndpoint);
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.operations).toContain(
      `read-marker:${fallbackAlias}:${oldEndpoint.deploymentId}`,
    );
  });

  test("reports compensation failure if either exact P alias cannot be restored", async () => {
    const provider = new FakeCutoverProvider(archivePlan);
    provider.markerBrokenForTargetAlias = fallbackAlias;
    provider.sourceAliasSetFailure = fallbackAlias;

    await expect(executeCutoverPlan(archivePlan, provider, {
      clock: immediateClock(),
      convergenceTimeoutMs: 2,
    })).rejects.toMatchObject({ code: "compensation_failed" });
    expect(provider.aliasEndpoint).toBe(baselineEndpoint);
    expect(provider.fallbackAliasEndpoint).toBe(oldEndpoint);
  });

  test("parses only the three fixed numeric identity transitions and bare URLs", () => {
    expect(parseCutoverPlan(JSON.stringify(forwardPlan))).toEqual(forwardPlan);
    expect(() => parseCutoverPlan(JSON.stringify({
      ...forwardPlan,
      target: { ...newEndpoint, projectId: oldProjectId },
    }))).toThrow("input_invalid");
    expect(() => parseCutoverPlan(JSON.stringify({
      ...forwardPlan,
      target: { ...newEndpoint, deploymentUrl: `https://${newEndpoint.deploymentUrl}` },
    }))).toThrow("input_invalid");
    expect(() => parseCutoverPlan(JSON.stringify({
      ...forwardPlan,
      target: { ...newEndpoint, deploymentUrl: `${newEndpoint.deploymentUrl}.vercel.app` },
    }))).toThrow("input_invalid");
    expect(() => parseArguments(["--vercel-cli", "/safe/vercel"])).toThrow("usage_invalid");
    expect(parseArguments([
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
      "--plan-fd",
      "3",
    ])).toEqual({ operation: "execute", planFd: 3, vercelCli: "/safe/vercel" });
    expect(parseArguments([
      "preflight",
      "--vercel-cli",
      "/safe/vercel",
      "--plan-fd",
      "3",
    ])).toEqual({ operation: "preflight", planFd: 3, vercelCli: "/safe/vercel" });
    expect(parseArguments([
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
      "--sequence",
      "1",
      "--evidence-path",
      "/safe/forward.json",
    ])).toEqual({
      evidencePath: "/safe/forward.json",
      operation: "execute",
      planFd: 0,
      sequence: 1,
      vercelCli: "/safe/vercel",
    });
    expect(parseArguments([
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
      "--sequence",
      "2",
      "--evidence-path",
      "/safe/reverse.json",
      "--previous-evidence",
      "/safe/forward.json",
    ])).toEqual({
      evidencePath: "/safe/reverse.json",
      operation: "execute",
      planFd: 0,
      previousEvidencePath: "/safe/forward.json",
      sequence: 2,
      vercelCli: "/safe/vercel",
    });
    expect(() => parseArguments([
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
      "--sequence",
      "2",
      "--evidence-path",
      "/safe/reverse.json",
    ])).toThrow("usage_invalid");
    expect(() => parseArguments([
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
      "--sequence",
      "1",
      "--evidence-path",
      "/safe/forward.json",
      "--previous-evidence",
      "/safe/older.json",
    ])).toThrow("usage_invalid");
    expect(() => parseArguments([
      "preflight",
      "--vercel-cli",
      "/safe/vercel",
      "--sequence",
      "1",
      "--evidence-path",
      "/safe/forward.json",
    ])).toThrow("usage_invalid");
    expect(() => parseArguments([
      "preflight",
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
    ])).toThrow("usage_invalid");
  });

  test("refuses an invalid reserved evidence destination before provider authority reads", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-domain-evidence-test-")));
    await chmod(root, 0o700);
    try {
      const evidencePath = join(root, "forward.json");
      await writeFile(evidencePath, "{}\n", { mode: 0o644 });
      await chmod(evidencePath, 0o644);
      const requests: VercelCommandRequest[] = [];
      const runner: VercelCommandRunner = async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: "",
          stdout: request.arguments[0] === "--version" ? "54.18.0\n" : "",
        };
      };
      const output = (): Pick<NodeJS.WriteStream, "write"> => ({
        write: (() => true) as NodeJS.WriteStream["write"],
      });
      expect(await executeDomainCutover({
        arguments: [
          "--execute",
          "--vercel-cli",
          "/safe/vercel",
          "--sequence",
          "1",
          "--evidence-path",
          evidencePath,
        ],
        inputDocument: JSON.stringify(forwardPlan),
        runner,
        stderr: output(),
        stdout: output(),
      })).toBe(1);
      expect(requests.map((request) => request.arguments)).toEqual([["--version"]]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("emits changed and replayed outcomes for a fresh archive and its exact retry", async () => {
    const aliases: Record<ManagedAlias, CutoverEndpoint> = {
      [canonicalAlias]: baselineEndpoint,
      [fallbackAlias]: baselineEndpoint,
      [newStagingAlias]: newEndpoint,
    };
    let mutationCalls = 0;
    const runner: VercelCommandRunner = async (request) => {
      const [command, path] = request.arguments;
      if (command === "--version") {
        return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
      }
      if (command === "alias" && path === "set") {
        mutationCalls += 1;
        const deploymentUrl = request.arguments[2];
        const aliasName = request.arguments[3] as ManagedAlias;
        const endpoint = [baselineEndpoint, oldEndpoint, newEndpoint]
          .find((candidate) => candidate.deploymentUrl === deploymentUrl);
        if (endpoint === undefined) return { exitCode: 1, stderr: "", stdout: "" };
        aliases[aliasName] = endpoint;
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (command !== "api") return { exitCode: 1, stderr: "", stdout: "" };
      if (path === `/v9/projects/${oldProjectId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(projectFor(oldProjectId)),
        };
      }
      if (path === `/v9/projects/${newProjectId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(projectFor(newProjectId)),
        };
      }
      if (path === `/v13/deployments/${baselineEndpoint.deploymentId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(deploymentFor(baselineEndpoint)),
        };
      }
      if (path === `/v13/deployments/${oldEndpoint.deploymentId}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(deploymentFor(oldEndpoint)),
        };
      }
      if (path === `/v9/projects/${oldProjectId}/domains?limit=20`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage([canonicalAlias])),
        };
      }
      if (path === `/v9/projects/${newProjectId}/domains?limit=20`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(domainPage([])) };
      }
      for (const aliasName of [canonicalAlias, fallbackAlias, newStagingAlias] as const) {
        if (path === `/v4/aliases/${aliasName}`) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify(aliasFor(aliases[aliasName], aliasName)),
          };
        }
      }
      return { exitCode: 1, stderr: "", stdout: "" };
    };
    const fetcher = async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      );
      return new Response(JSON.stringify(markerFor(aliases[url.hostname as ManagedAlias])), {
        status: 200,
      });
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const output = (chunks: string[]): Pick<NodeJS.WriteStream, "write"> => ({
      write: ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      }) as NodeJS.WriteStream["write"],
    });
    const run = async (arguments_: readonly string[]): Promise<number> =>
      await executeDomainCutover({
        arguments: arguments_,
        environment: { HOME: "/safe/home", PATH: "/safe/bin" },
        fetcher,
        inputDocument: JSON.stringify(archivePlan),
        runner,
        stderr: output(stderr),
        stdout: output(stdout),
      });
    const execute = async (): Promise<number> => await run([
      "--execute",
      "--vercel-cli",
      "/safe/vercel",
    ]);
    const preflight = async (): Promise<number> => await run([
      "preflight",
      "--vercel-cli",
      "/safe/vercel",
    ]);

    expect(await preflight()).toBe(0);
    expect(stderr).toEqual([]);
    expect(mutationCalls).toBe(0);
    expect(JSON.parse(stdout.at(-1) ?? "null")).toEqual({
      direction: "archive",
      mode: "traffic-only",
      nextAction: "execute_plan",
      observedOwner: "source",
      observedState: "source",
      observedTraffic: "source",
      reason: "exact_source",
      schemaVersion: 1,
      sourceDeploymentId: baselineEndpoint.deploymentId,
      sourceProjectId: oldProjectId,
      status: "ready",
      targetDeploymentId: oldEndpoint.deploymentId,
      targetProjectId: oldProjectId,
    });

    aliases[fallbackAlias] = oldEndpoint;
    expect(await preflight()).toBe(1);
    expect(stderr).toEqual([]);
    expect(mutationCalls).toBe(0);
    expect(JSON.parse(stdout.at(-1) ?? "null")).toEqual({
      direction: "archive",
      mode: "traffic-only",
      nextAction: "stop_and_investigate",
      observedOwner: "source",
      observedState: "partial",
      observedTraffic: "partial",
      reason: "partial_state",
      schemaVersion: 1,
      sourceDeploymentId: baselineEndpoint.deploymentId,
      sourceProjectId: oldProjectId,
      status: "blocked",
      targetDeploymentId: oldEndpoint.deploymentId,
      targetProjectId: oldProjectId,
    });
    aliases[fallbackAlias] = baselineEndpoint;

    expect(await execute()).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.at(-1) ?? "null")).toEqual({
      changed: true,
      direction: "archive",
      replayed: false,
      schemaVersion: 1,
      status: "committed",
      targetDeploymentId: oldEndpoint.deploymentId,
      targetProjectId: oldProjectId,
    });

    expect(await execute()).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(stdout.at(-1) ?? "null")).toEqual({
      changed: false,
      direction: "archive",
      replayed: true,
      schemaVersion: 1,
      status: "committed",
      targetDeploymentId: oldEndpoint.deploymentId,
      targetProjectId: oldProjectId,
    });
  });

  test("uses exact Vercel API paths, pinned CLI version, and sanitized environment", async () => {
    const requests: VercelCommandRequest[] = [];
    const markerRequests: string[] = [];
    const runner: VercelCommandRunner = async (request) => {
      requests.push(request);
      const path = request.arguments[1];
      if (request.arguments[0] === "--version") {
        return { exitCode: 0, stderr: "", stdout: "54.18.0\n" };
      }
      if (path === "/v4/aliases/oompa.dev") {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(aliasFor(oldEndpoint)) };
      }
      if (path === `/v4/aliases/${fallbackAlias}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(aliasFor(oldEndpoint, fallbackAlias)),
        };
      }
      if (path === `/v4/aliases/${newStagingAlias}`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(aliasFor(newEndpoint, newStagingAlias)),
        };
      }
      if (path === `/v13/deployments/${oldEndpoint.deploymentId}`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(deploymentFor(oldEndpoint)) };
      }
      if (path === `/v9/projects/${oldProjectId}`) {
        return { exitCode: 0, stderr: "", stdout: JSON.stringify(projectFor(oldProjectId)) };
      }
      if (path === `/v9/projects/${oldProjectId}/domains?limit=20`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage(["other.example"], 1_612_264_332_000)),
        };
      }
      if (path === `/v9/projects/${oldProjectId}/domains?limit=20&until=1612264332000`) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage([canonicalAlias], null, 1_612_264_332_001)),
        };
      }
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const provider = new VercelCutoverProvider({
      environment: {
        HOME: "/safe/home",
        PATH: "/safe/bin",
        VERCEL_TOKEN: "must-not-propagate",
      },
      fetcher: async (input) => {
        markerRequests.push(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        return new Response(JSON.stringify(markerFor(oldEndpoint)), { status: 200 });
      },
      runner,
      vercelCli: "/safe/vercel",
    });

    await provider.verifyVersion();
    expect(await provider.readAlias(canonicalAlias)).toEqual(aliasFor(oldEndpoint));
    expect(await provider.readAlias(fallbackAlias)).toEqual(aliasFor(oldEndpoint, fallbackAlias));
    expect(await provider.readAlias(newStagingAlias)).toEqual(
      aliasFor(newEndpoint, newStagingAlias),
    );
    expect(await provider.readDeployment(oldEndpoint.deploymentId)).toEqual(
      deploymentFor(oldEndpoint),
    );
    expect(await provider.readProject(oldProjectId)).toEqual(projectFor(oldProjectId));
    expect(await provider.readDomainNames(oldProjectId)).toEqual(["other.example", "oompa.dev"]);
    expect(await provider.readMarker(canonicalAlias)).toEqual(markerFor(oldEndpoint));
    expect(await provider.readMarker(fallbackAlias)).toEqual(markerFor(oldEndpoint));
    await provider.setAlias(oldEndpoint.deploymentUrl, canonicalAlias);
    await provider.setAlias(oldEndpoint.deploymentUrl, fallbackAlias);
    await provider.moveDomain(oldProjectId, newProjectId);
    await expect(provider.readAlias("other.vercel.app" as ManagedAlias)).rejects.toMatchObject({
      code: "alias_readback_invalid",
    });
    await expect(
      provider.setAlias(oldEndpoint.deploymentUrl, "other.vercel.app" as ManagedAlias),
    ).rejects.toMatchObject({ code: "usage_invalid" });

    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      "/v4/aliases/oompa.dev",
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v4/aliases/${newStagingAlias}`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "alias",
      "set",
      oldEndpoint.deploymentUrl,
      fallbackAlias,
      "--scope",
      "hraness",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v9/projects/${oldProjectId}`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v9/projects/${oldProjectId}/domains?limit=20`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v9/projects/${oldProjectId}/domains?limit=20&until=1612264332000`,
      "--scope",
      "hraness",
      "--raw",
    ]);
    expect(requests.map((request) => request.arguments)).toContainEqual([
      "api",
      `/v1/projects/${oldProjectId}/domains/oompa.dev/move`,
      "--scope",
      "hraness",
      "-X",
      "POST",
      "-F",
      `projectId=${newProjectId}`,
      "--silent",
    ]);
    expect(requests.every((request) => request.environment.VERCEL_TOKEN === undefined)).toBe(true);
    expect(markerRequests.some((request) => request.startsWith(
      `https://${fallbackAlias}/.well-known/hra.json?cutover=`,
    ))).toBe(true);
    expect(buildVercelEnvironment({ HOME: "/safe/home", VERCEL_TOKEN: "no" }))
      .toEqual({ HOME: "/safe/home", NO_COLOR: "1", TERM: "dumb" });
  });

  test("refuses a domain page that omits terminal pagination proof", async () => {
    const provider = new VercelCutoverProvider({
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({ domains: [{ name: canonicalAlias }] }),
      }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("refuses a repeated domain cursor instead of accepting an incomplete list", async () => {
    const requests: VercelCommandRequest[] = [];
    const provider = new VercelCutoverProvider({
      runner: async (request) => {
        requests.push(request);
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage(["not-hra.example"], 42)),
        };
      },
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
    expect(requests.map((request) => request.arguments[1])).toEqual([
      `/v9/projects/${oldProjectId}/domains?limit=20`,
      `/v9/projects/${oldProjectId}/domains?limit=20&until=42`,
    ]);
  });

  test("refuses a domain page whose item count does not match pagination", async () => {
    const provider = new VercelCutoverProvider({
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          domains: [{ name: canonicalAlias }],
          pagination: { count: 0, next: null, prev: null },
        }),
      }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("refuses an empty nonterminal domain page", async () => {
    const provider = new VercelCutoverProvider({
      runner: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify(domainPage([], 42)),
      }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("refuses ownership evidence that exceeds the bounded domain-page cap", async () => {
    let pages = 0;
    const provider = new VercelCutoverProvider({
      runner: async () => {
        pages += 1;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify(domainPage([`domain-${pages}.example`], pages)),
        };
      },
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readDomainNames(oldProjectId)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
    expect(pages).toBe(64);
  });

  test("caps a chunked marker body even when content-length is absent", async () => {
    const provider = new VercelCutoverProvider({
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(20 * 1_024));
          controller.enqueue(new Uint8Array(20 * 1_024));
          controller.close();
        },
      }), { status: 200 }),
      runner: async () => ({ exitCode: 0, stderr: "", stdout: "54.18.0\n" }),
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readMarker(canonicalAlias)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
  });

  test("treats provider cleanup uncertainty as terminal across later operations", async () => {
    const cleanup = new BoundedProcessCleanupUnprovenError(43_223, "vercel-alias-read");
    let calls = 0;
    const provider = new VercelCutoverProvider({
      runner: async () => {
        calls += 1;
        throw cleanup;
      },
      vercelCli: "/safe/vercel",
    });

    await expect(provider.readAlias(canonicalAlias)).rejects.toBe(cleanup);
    await expect(provider.readProject(oldProjectId)).rejects.toBe(cleanup);
    expect(calls).toBe(1);
  });

  test("gives a recovery journal precedence over an ordinary concurrent read failure", async () => {
    const provider = new FakeCutoverProvider(forwardPlan);
    const journal = new BoundedProcessRecoveryJournalError(
      ["/private/operator/process-recovery/authority-cutover.json"],
      "authority_recovery_required",
    );
    provider.readProject = async (projectId) => {
      if (projectId === oldProjectId) throw new Error("ordinary_failure");
      throw journal;
    };
    await expect(preflightCutoverPlan(forwardPlan, provider)).rejects.toBe(journal);
  });

  test("bounds and cancels a marker body that stalls after its response headers", async () => {
    let cancelled = false;
    const provider = new VercelCutoverProvider({
      fetcher: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
        pull(): Promise<void> {
          return new Promise(() => undefined);
        },
      }), { status: 200 }),
      markerTimeoutMs: 10,
      runner: async () => ({ exitCode: 0, stderr: "", stdout: "54.18.0\n" }),
      vercelCli: "/safe/vercel",
    });
    const startedAt = performance.now();

    await expect(provider.readMarker(canonicalAlias)).rejects.toMatchObject({
      code: "command_output_invalid",
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(cancelled).toBe(true);
  });

  test("surfaces stable refusal codes", () => {
    expect(new DomainCutoverError("compensation_failed")).toMatchObject({
      code: "compensation_failed",
      message: "compensation_failed",
    });
  });
});
