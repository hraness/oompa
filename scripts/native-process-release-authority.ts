import { performance } from "node:perf_hooks";
import { z } from "zod";

import { NATIVE_PACKAGE_VERSION } from "../packages/native-process/src/artifact-model.ts";
import { readBoundedJsonResponse } from "./bounded-json-response.ts";
import { publicRepository } from "./release-distribution-policy.ts";
import type { NativeProcessReleaseRun } from "./native-process-release-policy.ts";

const repositoryId = 1_343_008_607, ownerId = 307_125_679, actorId = 894_119;
const api = `https://api.github.com/repos/${publicRepository}`;
const workflow = ".github/workflows/native-process-release.yml";
const tag = `native-process-v${NATIVE_PACKAGE_VERSION}`;
const workflowRef = `${publicRepository}/${workflow}@refs/tags/${tag}`;
const freshnessMs = 30_000, requestMs = 15_000, maximumBytes = 512 * 1024;
const integer = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const sha = z.string().length(40).regex(/^[a-f0-9]{40}$/u);
const runSchema = z.object({ id: z.string().max(20).regex(/^[1-9][0-9]{0,19}$/u), attempt: integer,
  workflowRef: z.literal(workflowRef), sourceSha: sha, workflowSha: sha,
}).strict().refine(value => value.sourceSha === value.workflowSha);
const requestSchema = z.object({ run: runSchema, tagObjectSha: sha }).strict();
type AuthorityRequest = Readonly<{ run: NativeProcessReleaseRun; tagObjectSha: string }>;
const repositorySchema = z.object({ id: z.literal(repositoryId), full_name: z.literal(publicRepository),
  owner: z.object({ id: z.literal(ownerId) }), private: z.literal(false), visibility: z.literal("public"),
  default_branch: z.literal("main"), archived: z.literal(false), disabled: z.literal(false),
});
const runRepository = z.object({ id: z.literal(repositoryId), full_name: z.literal(publicRepository),
  owner: z.object({ id: z.literal(ownerId) }), private: z.literal(false),
});
const user = z.object({ id: z.literal(actorId), type: z.literal("User") });
const workflowSchema = z.object({ id: integer, path: z.literal(workflow), state: z.literal("active"), url: z.string().max(512) });
const workflowRunSchema = z.object({ id: integer, run_attempt: integer, workflow_id: integer,
  path: z.enum([workflow, `${workflow}@${tag}`, `${workflow}@refs/tags/${tag}`]),
  event: z.literal("push"), head_branch: z.string().max(256).nullable(), head_sha: sha,
  actor: user, triggering_actor: user, repository: runRepository, head_repository: runRepository,
  status: z.literal("in_progress"), conclusion: z.null(), url: z.string().max(512), workflow_url: z.string().max(512),
});
const referenceSchema = z.object({ ref: z.string().max(128), url: z.string().max(512),
  object: z.object({ type: z.enum(["tag", "commit"]), sha, url: z.string().max(512) }),
});
const tagObjectSchema = z.object({ sha, tag: z.literal(tag), url: z.string().max(512),
  object: z.object({ type: z.literal("commit"), sha, url: z.string().max(512) }),
});
const compareSchema = z.object({ status: z.enum(["ahead", "identical"]), behind_by: z.literal(0),
  ahead_by: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  base_commit: z.object({ sha }), merge_base_commit: z.object({ sha }), url: z.string().max(512),
});
const commitSchema = z.object({ sha, url: z.string().max(512), tree: z.object({ sha, url: z.string().max(512) }) });
const treeSchema = z.object({ sha, truncated: z.literal(false), tree: z.array(z.object({
  path: z.string().min(1).max(1024), mode: z.enum(["100644", "100755", "040000", "120000", "160000"]),
  type: z.enum(["blob", "tree", "commit"]), sha,
  size: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
})).max(20_000) });
// This is the complete explicit dependency list in nativeProcessSourceInventory;
// the paired test detects changes to that source inventory. Walk exclusions are
// identical. Workflow definitions are an additional API permission boundary.
export const nativeProcessExplicitReleaseControlFiles = Object.freeze(["package.json", "bun.lock", ".bun-version", "LICENSE",
  "scripts/bounded-process.ts", "scripts/authority-supervisor-artifact.ts", "src/install-normalizer.ts",
  "scripts/release-repository-identity.ts", "scripts/bounded-json-response.ts",
  "scripts/release-distribution-policy.ts", "scripts/release-package-policy.ts",
  "scripts/check-commit-ci-run.ts", "scripts/release-tag-policy.ts"]);
const controlDirectories = [".github/workflows", "native/process-kernel", "packages/native-process"] as const;
export function isNativeProcessReleaseControlPath(path: string): boolean {
  if (nativeProcessExplicitReleaseControlFiles.includes(path)) return true;
  if (/^scripts\/native-process-[^/]*\.(?:ts|mjs)$/u.test(path)) return true;
  if (path.startsWith(".github/workflows/")) return true;
  return ["native/process-kernel/", "packages/native-process/"].some(prefix => path.startsWith(prefix)
    && !path.slice(prefix.length).split("/").some(part => ["target", "node_modules", "native-artifacts"].includes(part)));
}
function controls(value: unknown, commitValue: unknown, commitSha: string) {
  const commit = commitSchema.parse(commitValue), tree = treeSchema.parse(value);
  if (commit.sha !== commitSha || commit.url !== `${api}/git/commits/${commitSha}` || tree.sha !== commit.tree.sha
    || commit.tree.url !== `${api}/git/trees/${tree.sha}`) refuse();
  const paths = new Map<string, typeof tree.tree[number]>();
  for (const entry of tree.tree) {
    const parts = entry.path.split("/");
    if (parts.length > 32 || parts.some(part => part === "" || part === "." || part === ".."
      || Array.from(part).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || character === "\\"))
      || paths.has(entry.path) || (entry.type === "tree" ? entry.mode !== "040000"
        : entry.type === "commit" ? entry.mode !== "160000" : !["100644", "100755", "120000"].includes(entry.mode))) refuse();
    paths.set(entry.path, entry);
  }
  for (const entry of tree.tree) {
    const parent = entry.path.slice(0, entry.path.lastIndexOf("/"));
    if (entry.path.includes("/") && paths.get(parent)?.type !== "tree") refuse();
  }
  for (const directory of controlDirectories) if (paths.get(directory)?.type !== "tree") refuse();
  const selected = tree.tree.filter(entry => isNativeProcessReleaseControlPath(entry.path) && entry.type !== "tree");
  for (const entry of selected) if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) refuse();
  const required = [...nativeProcessExplicitReleaseControlFiles, workflow, "native/process-kernel/Cargo.toml", "packages/native-process/package.json"];
  if (selected.length > 512 || required.some(path => !selected.some(entry => entry.path === path))) refuse();
  return selected.map(({ path, mode, sha }) => ({ path, mode, sha })).sort((a, b) => a.path.localeCompare(b.path));
}
const creationName = "Native process tag creation", immutableName = "Immutable native process tags";
const rulesetListSchema = z.array(z.object({ id: integer, name: z.string().min(1).max(128),
  source_type: z.literal("Repository"), source: z.literal(publicRepository),
})).max(99); // One per_page=100 response; a full page is conservatively incomplete.
const rulesetSchema = z.object({ id: integer, name: z.string().max(128), target: z.literal("tag"),
  source_type: z.literal("Repository"), source: z.literal(publicRepository), enforcement: z.literal("active"),
  conditions: z.object({ ref_name: z.object({ include: z.tuple([z.literal("refs/tags/native-process-v*")]),
    exclude: z.tuple([]) }).strict() }).strict(),
  bypass_actors: z.array(z.object({ actor_id: integer, actor_type: z.literal("User"), bypass_mode: z.literal("always") }).strict()).max(1),
  rules: z.array(z.union([
    z.object({ type: z.enum(["creation", "deletion"]) }).strict(),
    z.object({ type: z.literal("update"), parameters: z.object({ update_allows_fetch_and_merge: z.literal(false) }).strict().optional() }).strict(),
  ])).min(1).max(2),
});
const immutableReleasesSchema = z.object({ enabled: z.literal(true), enforced_by_owner: z.boolean() });
const observationsSchema = z.object({ repository: repositorySchema, currentRun: workflowRunSchema,
  currentAttempt: workflowRunSchema, workflow: workflowSchema, tagRef: referenceSchema, tagObject: tagObjectSchema,
  mainRef: referenceSchema, comparison: compareSchema,
  sourceCommit: commitSchema, mainCommit: commitSchema, sourceTree: treeSchema, mainTree: treeSchema,
}).strict();
const policySchema = z.object({ principal: user, repository: repositorySchema, rulesets: rulesetListSchema,
  creationRuleset: rulesetSchema, immutableRuleset: rulesetSchema, immutableReleases: immutableReleasesSchema,
}).strict();

function refuse(): never { throw Error("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID"); }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function request(value: unknown) { return requestSchema.parse(value); }

function assertReference(value: z.infer<typeof referenceSchema>, name: string, type: "tag" | "commit", expectedSha: string): void {
  if (value.ref !== `refs/${name}` || value.object.type !== type || value.object.sha !== expectedSha
    || value.url !== `${api}/git/refs/${name}` || value.object.url !== `${api}/git/${type}s/${expectedSha}`) refuse();
}
function requireRulesetSummaries(value: unknown) {
  const list = rulesetListSchema.parse(value);
  if (new Set(list.map(item => item.id)).size !== list.length) refuse();
  const exact = (name: string) => {
    const found = list.filter(item => item.name === name);
    if (found.length !== 1 || found[0] === undefined) refuse();
    return found[0];
  };
  return { creation: exact(creationName), immutable: exact(immutableName) };
}

/** Structural admission of supplied observations only. This result is neither
 * authenticated IO proof nor reusable release authority. */
export function admitNativeProcessReleaseAuthority(value: unknown, expected: AuthorityRequest) {
  try {
    const identity = request(expected), observed = observationsSchema.parse(value);
    const { run, tagObjectSha } = identity;
    if (observed.workflow.url !== `${api}/actions/workflows/${observed.workflow.id}`) refuse();
    for (const current of [observed.currentRun, observed.currentAttempt]) {
      if (String(current.id) !== run.id || current.run_attempt !== run.attempt || current.head_sha !== run.sourceSha
        || current.workflow_id !== observed.workflow.id || current.url !== `${api}/actions/runs/${run.id}`
        || current.workflow_url !== observed.workflow.url) refuse();
    }
    assertReference(observed.tagRef, `tags/${tag}`, "tag", tagObjectSha);
    const object = observed.tagObject;
    if (object.sha !== tagObjectSha || object.object.sha !== run.sourceSha || object.url !== `${api}/git/tags/${tagObjectSha}`
      || object.object.url !== `${api}/git/commits/${run.sourceSha}`) refuse();
    const mainSha = observed.mainRef.object.sha;
    assertReference(observed.mainRef, "heads/main", "commit", mainSha);
    const comparison = observed.comparison;
    if (comparison.base_commit.sha !== run.sourceSha || comparison.merge_base_commit.sha !== run.sourceSha
      || comparison.url !== `${api}/compare/${run.sourceSha}...${mainSha}`
      || (mainSha === run.sourceSha ? comparison.status !== "identical" || comparison.ahead_by !== 0
        : comparison.status !== "ahead" || comparison.ahead_by < 1)) refuse();
    const sourceControls = controls(observed.sourceTree, observed.sourceCommit, run.sourceSha);
    if (!same(sourceControls, controls(observed.mainTree, observed.mainCommit, mainSha))) refuse();
    // Only these bounded public fields escape. Never retain API response bodies,
    // actor display names, tokens, tag messages or commit metadata in a proof.
    return Object.freeze({ run: Object.freeze(run), tagObjectSha, mainSha,
      sourceTreeSha: observed.sourceTree.sha, mainTreeSha: observed.mainTree.sha,
      repository: Object.freeze({ ...observed.repository, owner: Object.freeze({ ...observed.repository.owner }) }),
    });
  } catch { return refuse(); }
}
export type NativeProcessReleaseAuthorityObservation = ReturnType<typeof admitNativeProcessReleaseAuthority>;

/** Owner tag-policy admission is separate from workload authority: ordinary
 * GITHUB_TOKEN cannot be presumed to see administration/bypass observations. */
export function admitNativeProcessTagPolicy(value: unknown) {
  try {
    const observed = policySchema.parse(value), summaries = requireRulesetSummaries(observed.rulesets);
    for (const [detail, summary, rules, bypass] of [
      [observed.creationRuleset, summaries.creation, ["creation"], [{ actor_id: actorId, actor_type: "User", bypass_mode: "always" }]],
      [observed.immutableRuleset, summaries.immutable, ["deletion", "update"], []],
    ] as const) {
      if (detail.id !== summary.id || detail.name !== summary.name
        || !same(detail.rules.map(rule => rule.type).sort(), rules) || !same(detail.bypass_actors, bypass)) refuse();
    }
    return Object.freeze({ namespace: "refs/tags/native-process-v*" as const,
      repository: Object.freeze({ ...observed.repository, owner: Object.freeze({ ...observed.repository.owner }) }),
      rulesets: Object.freeze({ creation: summaries.creation.id, immutable: summaries.immutable.id }),
      immutableReleases: Object.freeze(observed.immutableReleases),
    });
  } catch { return refuse(); }
}
export type NativeProcessTagPolicyObservation = ReturnType<typeof admitNativeProcessTagPolicy>;
declare const policyBrand: unique symbol;
export type NativeProcessTagPolicy = Readonly<{ readonly [policyBrand]: true }>;
const policies = new WeakMap<NativeProcessTagPolicy, Readonly<{ observed: NativeProcessTagPolicyObservation; expires: number }>>();
export function nativeProcessTagPolicy(proof: NativeProcessTagPolicy): NativeProcessTagPolicyObservation {
  const stored = policies.get(proof); policies.delete(proof);
  if (stored === undefined || performance.now() >= stored.expires) refuse();
  return stored.observed;
}
declare const authorityBrand: unique symbol;
export type NativeProcessReleaseAuthority = Readonly<{ readonly [authorityBrand]: true }>;
const authorities = new WeakMap<NativeProcessReleaseAuthority, Readonly<{
  observed: NativeProcessReleaseAuthorityObservation; expires: number;
}>>();

/** Consume once, synchronously immediately before the caller's exact request.
 * No await may intervene. A proof is an observation, not a GitHub-side lease;
 * the publisher still reconciles every ambiguous mutation without replay. */
export function nativeProcessReleaseAuthority(proof: NativeProcessReleaseAuthority, run: NativeProcessReleaseRun, tagObjectSha: string): NativeProcessReleaseAuthorityObservation {
  const stored = authorities.get(proof);
  authorities.delete(proof);
  if (stored === undefined || performance.now() >= stored.expires) refuse();
  try {
    const identity = request({ run, tagObjectSha });
    if (!same(identity.run, stored.observed.run) || identity.tagObjectSha !== stored.observed.tagObjectSha) refuse();
  } catch { return refuse(); }
  return stored.observed;
}

function boundedGithubReader(token: string) {
  if (typeof token !== "string" || token.length < 1 || token.length > 8192 || /[\r\n]/u.test(token)) refuse();
  const started = performance.now(), controller = new AbortController(), overall = AbortSignal.timeout(freshnessMs);
  const get = async (url: string, maximum = maximumBytes): Promise<unknown> => {
    const response = await fetch(url, { method: "GET", cache: "no-store", redirect: "error",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "Cache-Control": "no-cache",
        "User-Agent": "oompa-native-process-release-authority", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.any([overall, controller.signal, AbortSignal.timeout(requestMs)]),
    });
    if (response.status !== 200) refuse();
    return readBoundedJsonResponse(response, "Native release authority", maximum);
  };
  return { started, cancel: () => { controller.abort(); },
    repository: (path: string, maximum = maximumBytes) => get(`${api}${path}`, maximum),
    principal: () => get("https://api.github.com/user"),
  };
}

/** Separate owner pre-tag IO. It verifies immutable User 894119 and the complete
 * native namespace policy without minting workload publication authority.
 * These endpoints require owner administration/readback visibility:
 * https://docs.github.com/en/rest/repos/rules#get-a-repository-ruleset
 * https://docs.github.com/en/rest/repos/repos#check-if-immutable-releases-are-enabled-for-a-repository */
export async function fetchNativeProcessTagPolicy(input: Readonly<{ token: string }>): Promise<NativeProcessTagPolicy> {
  try {
    const reader = boundedGithubReader(input.token), get = reader.repository;
    try {
      const [principal, repository, rulesets, immutableReleases] = await Promise.all([
        reader.principal(), get(""), get("/rulesets?includes_parents=false&per_page=100&page=1"), get("/immutable-releases"),
      ]);
      const summaries = requireRulesetSummaries(rulesets);
      const [creationRuleset, immutableRuleset] = await Promise.all([
        get(`/rulesets/${summaries.creation.id}?includes_parents=false`),
        get(`/rulesets/${summaries.immutable.id}?includes_parents=false`),
      ]);
      const observed = admitNativeProcessTagPolicy({ principal, repository, rulesets, immutableReleases, creationRuleset, immutableRuleset });
      if (performance.now() >= reader.started + freshnessMs) refuse();
      const proof = Object.freeze({}) as NativeProcessTagPolicy;
      policies.set(proof, { observed, expires: reader.started + freshnessMs });
      return proof;
    } finally { reader.cancel(); }
  } catch { return refuse(); }
}

/** Fixed GitHub read-only authority boundary. There is no injectable client,
 * caller-selected URL, serialized-proof importer, redirect, retry or mutation.
 * Governance settings are admitted separately at the owner tag-creation gate.
 * https://docs.github.com/en/rest/actions/workflow-runs#get-a-workflow-run-attempt */
export async function fetchNativeProcessReleaseAuthority(input: Readonly<{
  token: string; run: NativeProcessReleaseRun; tagObjectSha: string;
}>): Promise<NativeProcessReleaseAuthority> {
  try {
    const identity = request({ run: input.run, tagObjectSha: input.tagObjectSha });
    const reader = boundedGithubReader(input.token), get = reader.repository, started = reader.started;
    try {
      const runPath = `/actions/runs/${identity.run.id}`, attemptPath = `${runPath}/attempts/${identity.run.attempt}`;
      const [repository, currentRun, currentAttempt, activeWorkflow, tagRef, tagObject, mainRef] = await Promise.all([
        get(""), get(runPath), get(attemptPath), get("/actions/workflows/native-process-release.yml"),
        get(`/git/ref/tags/${tag}`), get(`/git/tags/${identity.tagObjectSha}`), get("/git/ref/heads/main"),
      ]);
      const mainSha = referenceSchema.parse(mainRef).object.sha;
      const [comparison, sourceCommit, mainCommit] = await Promise.all([
        get(`/compare/${identity.run.sourceSha}...${mainSha}?per_page=1&page=1`, 2 * 1024 * 1024),
        get(`/git/commits/${identity.run.sourceSha}`), get(`/git/commits/${mainSha}`),
      ]);
      const [sourceTree, mainTree] = await Promise.all([
        get(`/git/trees/${commitSchema.parse(sourceCommit).tree.sha}?recursive=1`, 8 * 1024 * 1024),
        get(`/git/trees/${commitSchema.parse(mainCommit).tree.sha}?recursive=1`, 8 * 1024 * 1024),
      ]);
      const observed = admitNativeProcessReleaseAuthority({ repository, currentRun, currentAttempt, workflow: activeWorkflow,
        tagRef, tagObject, mainRef, comparison, sourceCommit, mainCommit, sourceTree, mainTree }, identity);
      // Recheck the execution generation and mutable repository/ref identities
      // after the dependent policy reads; a superseded attempt cannot publish.
      const [lastRepository, lastRun, lastAttempt, lastTagRef, lastMainRef] = await Promise.all([
        get(""), get(runPath), get(attemptPath), get(`/git/ref/tags/${tag}`), get("/git/ref/heads/main"),
      ]);
      const last = admitNativeProcessReleaseAuthority({ repository: lastRepository, currentRun: lastRun,
        currentAttempt: lastAttempt, workflow: activeWorkflow, tagRef: lastTagRef, tagObject, mainRef: lastMainRef,
        comparison, sourceCommit, mainCommit, sourceTree, mainTree }, identity);
      if (!same(observed, last) || performance.now() >= started + freshnessMs) refuse();
      const proof = Object.freeze({}) as NativeProcessReleaseAuthority;
      authorities.set(proof, { observed: last, expires: started + freshnessMs });
      return proof;
    } finally { reader.cancel(); }
  } catch { return refuse(); }
}
