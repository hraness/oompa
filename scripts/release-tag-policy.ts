import { z } from "zod";

import { publicRepository } from "./release-distribution-policy";

const exactOriginPattern = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?:hraness\/oompa)(?:\.git)?$/u;

export const rulesetSummarySchema = z.array(z.object({ id: z.number().int().positive(), name: z.string() })).max(100);
export const rulesetSchema = z.object({
  bypass_actors: z.array(z.object({
    actor_id: z.number().int().positive(),
    actor_type: z.string(),
    bypass_mode: z.string(),
  })).max(10),
  conditions: z.object({
    ref_name: z.object({ exclude: z.array(z.string()), include: z.array(z.string()) }),
  }),
  enforcement: z.string(),
  name: z.string(),
  rules: z.array(z.object({ type: z.string() }).passthrough()).max(20),
  target: z.string(),
});
const workflowSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  path: z.string(),
  state: z.string(),
});
function exactBranchRuleset(value: unknown, name: string): ReturnType<typeof rulesetSchema.parse> {
  const parsed = rulesetSchema.parse(value);
  if (
    parsed.name !== name
    || parsed.target !== "branch"
    || parsed.enforcement !== "active"
    || parsed.bypass_actors.length !== 0
    || parsed.conditions.ref_name.exclude.length !== 0
    || parsed.conditions.ref_name.include.length !== 1
    || parsed.conditions.ref_name.include[0] !== "refs/heads/main"
  ) throw new Error(`${name} ruleset does not protect exact main without bypass.`);
  return parsed;
}

export function assertMainRulesets(listValue: unknown, detailValues: ReadonlyMap<string, unknown>): void {
  const list = rulesetSummarySchema.parse(listValue);
  const details = (name: string): unknown => {
    if (list.filter((item) => item.name === name).length !== 1) {
      throw new Error(`Expected exactly one active ${name} ruleset.`);
    }
    const detail = detailValues.get(name);
    if (detail === undefined) throw new Error(`Missing ${name} ruleset readback.`);
    return detail;
  };
  const immutable = exactBranchRuleset(details("Immutable main"), "Immutable main");
  if (JSON.stringify(immutable.rules.map((rule) => rule.type).sort()) !== JSON.stringify([
    "deletion", "non_fast_forward", "required_linear_history",
  ])) throw new Error("Immutable main ruleset has unexpected rules.");

  const protection = exactBranchRuleset(details("Protect main"), "Protect main");
  if (JSON.stringify(protection.rules.map((rule) => rule.type).sort()) !== JSON.stringify([
    "pull_request", "required_status_checks",
  ])) throw new Error("Protect main ruleset has unexpected rules.");
  const pullRequest = protection.rules.find((rule) => rule.type === "pull_request");
  const statusChecks = protection.rules.find((rule) => rule.type === "required_status_checks");
  const pullParameters = z.object({
    allowed_merge_methods: z.array(z.string()),
    require_extra_approval_for_unattributed_changes: z.literal(true),
    required_approving_review_count: z.literal(0),
    required_review_thread_resolution: z.literal(true),
  }).passthrough().parse(pullRequest?.parameters);
  if (JSON.stringify([...pullParameters.allowed_merge_methods].sort()) !== JSON.stringify(["rebase", "squash"])) {
    throw new Error("Protect main ruleset has unexpected merge methods.");
  }
  const statusParameters = z.object({
    do_not_enforce_on_create: z.literal(false),
    required_status_checks: z.array(z.object({
      context: z.literal("Required"),
      integration_id: z.literal(15_368),
    })).length(1),
    strict_required_status_checks_policy: z.literal(true),
  }).parse(statusChecks?.parameters);
  void statusParameters;
}

export function assertActiveCiWorkflow(value: unknown): void {
  const workflow = workflowSchema.parse(value);
  if (
    workflow.id !== 340_428_685
    || workflow.name !== "CI"
    || workflow.path !== ".github/workflows/ci.yml"
    || workflow.state !== "active"
  ) throw new Error("The required CI workflow is not the exact active repository workflow.");
}

export function assertExactOriginUrls(fetchOutput: string, pushOutput: string): void {
  const fetchOrigins = fetchOutput.split("\n");
  const pushOrigins = pushOutput.split("\n");
  if (
    fetchOrigins.length !== 1
    || pushOrigins.length !== 1
    || !exactOriginPattern.test(fetchOrigins[0] ?? "")
    || !exactOriginPattern.test(pushOrigins[0] ?? "")
  ) throw new Error(`Release tag creation requires ${publicRepository} as origin.`);
}

export function assertTransparentGitIndex(output: string): void {
  const entries = output.split("\0").filter(Boolean);
  if (entries.some((entry) => entry[0] === "S" || /^[a-z]$/u.test(entry[0] ?? ""))) {
    throw new Error("Release tag creation refuses skip-worktree or assume-unchanged Git index entries.");
  }
}

