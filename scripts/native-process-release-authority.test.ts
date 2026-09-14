import { expect, test } from "bun:test";

import { admitNativeProcessReleaseAuthority, admitNativeProcessTagPolicy, nativeProcessReleaseAuthority,
  isNativeProcessReleaseControlPath, nativeProcessTagPolicy, type NativeProcessTagPolicy,
  type NativeProcessReleaseAuthority } from "./native-process-release-authority.ts";
import { nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { NATIVE_PROCESS_RELEASE_TAG, NATIVE_PROCESS_RELEASE_WORKFLOW, type NativeProcessReleaseRun } from "./native-process-release-policy.ts";

const sourceSha = "a".repeat(40), tagObjectSha = "b".repeat(40), mainSha = "c".repeat(40);
const api = "https://api.github.com/repos/hraness/oompa";
const run: NativeProcessReleaseRun = { id: "12345", attempt: 2, sourceSha, workflowSha: sourceSha,
  workflowRef: `hraness/oompa/${NATIVE_PROCESS_RELEASE_WORKFLOW}@refs/tags/${NATIVE_PROCESS_RELEASE_TAG}` };
const expected = () => ({ run: { ...run }, tagObjectSha });
const sourceTreeSha = "d".repeat(40), mainTreeSha = "e".repeat(40), blobSha = "f".repeat(40);
const fixturePaths = ["package.json", "bun.lock", ".bun-version", "LICENSE",
  "scripts/bounded-process.ts", "scripts/authority-supervisor-artifact.ts", "src/install-normalizer.ts",
  "scripts/release-repository-identity.ts", "scripts/bounded-json-response.ts",
  "scripts/release-distribution-policy.ts", "scripts/release-package-policy.ts",
  "scripts/check-commit-ci-run.ts", "scripts/release-tag-policy.ts",
  NATIVE_PROCESS_RELEASE_WORKFLOW, "native/process-kernel/Cargo.toml", "packages/native-process/package.json",
  "scripts/native-process-release-authority.ts", "src/other-product.ts"];
function treeFixture(treeSha: string) {
  const entries = new Map<string, { path: string; sha: string; type: string; mode: string }>();
  for (const path of fixturePaths) {
    const parts = path.split("/");
    for (let end = 1; end < parts.length; end++) {
      const parent = parts.slice(0, end).join("/");
      entries.set(parent, { path: parent, sha: blobSha, type: "tree", mode: "040000" });
    }
    entries.set(path, { path, sha: blobSha, type: "blob", mode: "100644" });
  }
  return { sha: treeSha, truncated: false, tree: [...entries.values()] };
}
const commitFixture = (commitSha: string, treeSha: string) => ({ sha: commitSha, url: `${api}/git/commits/${commitSha}`,
  tree: { sha: treeSha, url: `${api}/git/trees/${treeSha}` } });
const repository = () => ({ id: 1_343_008_607, full_name: "hraness/oompa", owner: { id: 307_125_679 },
  private: false, visibility: "public", default_branch: "main", archived: false, disabled: false });
const current = () => ({ id: 12345, run_attempt: 2, workflow_id: 456, path: NATIVE_PROCESS_RELEASE_WORKFLOW,
  event: "push", head_branch: NATIVE_PROCESS_RELEASE_TAG as string | null, head_sha: sourceSha,
  actor: { id: 894119, type: "User" }, triggering_actor: { id: 894119, type: "User" },
  repository: repository(), head_repository: repository(), status: "in_progress", conclusion: null as string | null,
  url: `${api}/actions/runs/12345`, workflow_url: `${api}/actions/workflows/456` });
function fixture() {
  return { repository: repository(), currentRun: current(), currentAttempt: current(),
    workflow: { id: 456, path: NATIVE_PROCESS_RELEASE_WORKFLOW, state: "active", url: `${api}/actions/workflows/456` },
    tagRef: { ref: `refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`, url: `${api}/git/refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`,
      object: { type: "tag", sha: tagObjectSha, url: `${api}/git/tags/${tagObjectSha}` } },
    tagObject: { sha: tagObjectSha, tag: NATIVE_PROCESS_RELEASE_TAG, url: `${api}/git/tags/${tagObjectSha}`,
      object: { type: "commit", sha: sourceSha, url: `${api}/git/commits/${sourceSha}` } },
    mainRef: { ref: "refs/heads/main", url: `${api}/git/refs/heads/main`,
      object: { type: "commit", sha: mainSha, url: `${api}/git/commits/${mainSha}` } },
    comparison: { status: "ahead", behind_by: 0, ahead_by: 1, base_commit: { sha: sourceSha },
      merge_base_commit: { sha: sourceSha }, url: `${api}/compare/${sourceSha}...${mainSha}` },
    sourceCommit: commitFixture(sourceSha, sourceTreeSha), mainCommit: commitFixture(mainSha, mainTreeSha),
    sourceTree: treeFixture(sourceTreeSha), mainTree: treeFixture(mainTreeSha),
  };
}
type Fixture = ReturnType<typeof fixture>;

test("workload authority admits only copied public observations, without creating live IO proof", () => {
  const input = fixture(), coordinates = expected();
  const result = admitNativeProcessReleaseAuthority(input, coordinates);
  expect(result.run).toEqual(run);
  expect(result.mainSha).toBe(mainSha);
  expect(result.tagObjectSha).toBe(tagObjectSha);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.run)).toBe(true);
  expect(Object.isFrozen(result.repository.owner)).toBe(true);
  input.repository.owner.id = 5;
  coordinates.run.sourceSha = "d".repeat(40);
  expect(result.repository.owner.id).toBe(307125679);
  expect(result.run.sourceSha).toBe(sourceSha);
  for (const fabricated of [result, JSON.parse(JSON.stringify(result)) as unknown, {}, null]) {
    expect(() => nativeProcessReleaseAuthority(fabricated as NativeProcessReleaseAuthority, run, tagObjectSha))
      .toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
  }
});

const invalid: readonly (readonly [string, (input: Fixture) => void])[] = [
  ["foreign repository", input => { input.repository.id = 2; }],
  ["foreign owner", input => { input.repository.owner.id = 2; }],
  ["renamed repository", input => { input.repository.full_name = "hraness/hra"; }],
  ["private repository", input => { input.repository.private = true; }],
  ["repository visibility", input => { input.repository.visibility = "private"; }],
  ["archived repository", input => { input.repository.archived = true; }],
  ["disabled repository", input => { input.repository.disabled = true; }],
  ["foreign default branch", input => { input.repository.default_branch = "staging"; }],
  ["wrong run", input => { input.currentRun.id++; }],
  ["superseded attempt", input => { input.currentRun.run_attempt++; }],
  ["wrong attempt endpoint", input => { input.currentAttempt.run_attempt--; }],
  ["foreign attempt run", input => { input.currentAttempt.id++; }],
  ["run actor", input => { input.currentRun.actor.id++; }],
  ["run actor type", input => { input.currentRun.actor.type = "Bot"; }],
  ["rerun actor", input => { input.currentAttempt.triggering_actor.id++; }],
  ["rerun actor type", input => { input.currentAttempt.triggering_actor.type = "Bot"; }],
  ["run triggering actor", input => { input.currentRun.triggering_actor.id++; }],
  ["attempt original actor", input => { input.currentAttempt.actor.id++; }],
  ["run source", input => { input.currentRun.head_sha = mainSha; }],
  ["attempt source", input => { input.currentAttempt.head_sha = mainSha; }],
  ["branch workflow definition", input => { input.currentRun.path += "@main"; }],
  ["other workflow", input => { input.currentAttempt.path = ".github/workflows/release.yml"; }],
  ["workflow id", input => { input.currentRun.workflow_id++; }],
  ["inactive workflow", input => { input.workflow.state = "disabled_manually"; }],
  ["workflow path", input => { input.workflow.path = ".github/workflows/release.yml"; }],
  ["workflow URL", input => { input.workflow.url += "/other"; }],
  ["run URL", input => { input.currentAttempt.url += "/other"; }],
  ["workflow run URL", input => { input.currentAttempt.workflow_url += "/other"; }],
  ["run event", input => { input.currentAttempt.event = "workflow_dispatch"; }],
  ["completed run", input => { input.currentRun.status = "completed"; input.currentRun.conclusion = "success"; }],
  ["cancelled attempt", input => { input.currentAttempt.status = "completed"; input.currentAttempt.conclusion = "cancelled"; }],
  ["foreign head repository", input => { input.currentRun.head_repository.id++; }],
  ["foreign attempt repository", input => { input.currentAttempt.repository.id++; }],
  ["foreign head owner", input => { input.currentAttempt.head_repository.owner.id++; }],
  ["private run repository", input => { input.currentRun.repository.private = true; }],
  ["lightweight tag", input => { input.tagRef.object.type = "commit"; }],
  ["retagged ref", input => { input.tagRef.object.sha = mainSha; }],
  ["different tag ref", input => { input.tagRef.ref = "refs/tags/v0.1.0"; }],
  ["foreign ref URL", input => { input.tagRef.url = "https://example.com/ref"; }],
  ["foreign tag object URL", input => { input.tagRef.object.url = "https://example.com/object"; }],
  ["different tag object", input => { input.tagObject.sha = mainSha; }],
  ["different tag name", input => { input.tagObject.tag = "native-process-v0.2.0"; }],
  ["tag of another tag", input => { input.tagObject.object.type = "tag"; }],
  ["different peeled commit", input => { input.tagObject.object.sha = mainSha; }],
  ["tag object response URL", input => { input.tagObject.url += "/other"; }],
  ["peeled commit URL", input => { input.tagObject.object.url += "/other"; }],
  ["non-main ancestry", input => { input.mainRef.ref = "refs/heads/staging"; }],
  ["tag main ref", input => { input.mainRef.object.type = "tag"; }],
  ["comparison wrong base", input => { input.comparison.base_commit.sha = mainSha; }],
  ["diverged source", input => { input.comparison.merge_base_commit.sha = tagObjectSha; }],
  ["behind source", input => { input.comparison.behind_by = 1; }],
  ["diverged comparison", input => { input.comparison.status = "diverged"; }],
  ["different captured main", input => { input.comparison.url = `${api}/compare/${sourceSha}...${tagObjectSha}`; }],
  ["inconsistent ahead count", input => { input.comparison.ahead_by = 0; }],
];
for (const [name, change] of invalid) test(`workload authority refuses ${name}`, () => {
  const value = fixture(); change(value);
  expect(() => admitNativeProcessReleaseAuthority(value, expected())).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
});

test("branch display metadata supplies no tag authority, and only exact workflow path variants are accepted", () => {
  for (const branch of [null, "main", NATIVE_PROCESS_RELEASE_TAG]) {
    for (const path of [NATIVE_PROCESS_RELEASE_WORKFLOW, `${NATIVE_PROCESS_RELEASE_WORKFLOW}@${NATIVE_PROCESS_RELEASE_TAG}`,
      `${NATIVE_PROCESS_RELEASE_WORKFLOW}@refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`]) {
      const value = fixture(); value.currentRun.head_branch = branch; value.currentAttempt.head_branch = branch;
      value.currentRun.path = path; value.currentAttempt.path = path;
      expect(admitNativeProcessReleaseAuthority(value, expected()).tagObjectSha).toBe(tagObjectSha);
    }
  }
});

test("current main may be the exact tagged source, with a consistent identical comparison", () => {
  const value = fixture();
  value.mainRef.object.sha = sourceSha; value.mainRef.object.url = `${api}/git/commits/${sourceSha}`;
  value.comparison.status = "identical"; value.comparison.ahead_by = 0;
  value.comparison.url = `${api}/compare/${sourceSha}...${sourceSha}`;
  value.mainCommit = structuredClone(value.sourceCommit);
  value.mainTree = structuredClone(value.sourceTree);
  expect(admitNativeProcessReleaseAuthority(value, expected()).mainSha).toBe(sourceSha);
  value.comparison.ahead_by = 1;
  expect(() => admitNativeProcessReleaseAuthority(value, expected())).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
});

test("malformed expected coordinates are refused before being interpreted", () => {
  for (const [key, value] of [["id", "1\n"], ["id", "01"], ["id", "1/attempts/2"], ["attempt", 0],
    ["sourceSha", "A".repeat(40)], ["sourceSha", sourceSha + "\n"], ["workflowSha", mainSha],
    ["workflowRef", run.workflowRef.replace("refs/tags/", "refs/heads/")]] as const) {
    const coordinates = expected(); Object.assign(coordinates.run, { [key]: value });
    expect(() => admitNativeProcessReleaseAuthority(fixture(), coordinates)).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
  }
});

test("workflow and native control closure compare both complete trees while unrelated product changes remain possible", () => {
  const input = fixture();
  const unrelated = input.mainTree.tree.find(entry => entry.path === "src/other-product.ts")!;
  unrelated.sha = sourceSha;
  expect(admitNativeProcessReleaseAuthority(input, expected()).mainTreeSha).toBe(mainTreeSha);
  const controlled = input.mainTree.tree.find(entry => entry.path === "scripts/native-process-release-authority.ts")!;
  controlled.sha = sourceSha;
  expect(() => admitNativeProcessReleaseAuthority(input, expected())).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
});
const invalidTrees: readonly (readonly [string, (input: Fixture) => void])[] = [
  ["source tree truncated", input => { input.sourceTree.truncated = true; }],
  ["main tree truncated", input => { input.mainTree.truncated = true; }],
  ["unbound source tree", input => { input.sourceTree.sha = mainTreeSha; }],
  ["unbound current main tree", input => { input.mainTree.sha = sourceTreeSha; }],
  ["wrong source commit", input => { input.sourceCommit.sha = mainSha; }],
  ["wrong main commit", input => { input.mainCommit.sha = sourceSha; }],
  ["foreign commit URL", input => { input.mainCommit.url = "https://example.com/commit"; }],
  ["foreign tree URL", input => { input.sourceCommit.tree.url = "https://example.com/tree"; }],
  ["added workflow", input => { input.mainTree.tree.push({ path: ".github/workflows/new.yml", sha: blobSha, type: "blob", mode: "100644" }); }],
  ["removed workflow", input => { input.mainTree.tree = input.mainTree.tree.filter(entry => entry.path !== NATIVE_PROCESS_RELEASE_WORKFLOW); }],
  ["removed native file", input => { input.mainTree.tree = input.mainTree.tree.filter(entry => entry.path !== "scripts/native-process-release-authority.ts"); }],
  ["added native file", input => { input.mainTree.tree.push({ path: "scripts/native-process-new.ts", sha: blobSha, type: "blob", mode: "100644" }); }],
  ["native symlink", input => { input.mainTree.tree.find(entry => entry.path === "scripts/native-process-release-authority.ts")!.mode = "120000"; }],
  ["native submodule", input => { const entry = input.mainTree.tree.find(entry => entry.path === "native/process-kernel")!; entry.mode = "160000"; entry.type = "commit"; }],
  ["mode changed", input => { input.mainTree.tree.find(entry => entry.path === "scripts/native-process-release-authority.ts")!.mode = "100755"; }],
  ["source CI gate changed", input => { input.mainTree.tree.find(entry => entry.path === "scripts/check-commit-ci-run.ts")!.sha = sourceSha; }],
  ["shared owner tag policy changed", input => { input.mainTree.tree.find(entry => entry.path === "scripts/release-tag-policy.ts")!.sha = sourceSha; }],
  ["duplicate path", input => { input.mainTree.tree.push({ ...input.mainTree.tree[0]! }); }],
  ["traversing path", input => { input.mainTree.tree.push({ path: "src/../oops", sha: blobSha, type: "blob", mode: "100644" }); }],
  ["orphan path", input => { input.mainTree.tree.push({ path: "unknown/child", sha: blobSha, type: "blob", mode: "100644" }); }],
  ["blob/type disagreement", input => { input.mainTree.tree[0]!.type = "tree"; }],
  ["missing required dependency", input => {
    for (const tree of [input.sourceTree, input.mainTree]) tree.tree = tree.tree.filter(entry => entry.path !== "bun.lock");
  }],
  ["oversized census", input => { input.mainTree.tree = Array.from({ length: 20001 }, () => ({ ...input.mainTree.tree[0]! })); }],
];
for (const [name, change] of invalidTrees) test(`release control equality refuses ${name}`, () => {
  const input = fixture(); change(input);
  expect(() => admitNativeProcessReleaseAuthority(input, expected())).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
});

test("release-control selection covers every actual qualification input and exact walk exclusions", () => {
  for (const entry of nativeProcessSourceInventory(`${import.meta.dir}/..`)) expect(isNativeProcessReleaseControlPath(entry.path)).toBe(true);
  for (const path of [".github/workflows/ci.yml", ".github/workflows/new.yml", "native/process-kernel/src/new.rs",
    "packages/native-process/src/new.ts", "scripts/native-process-new.mjs"]) expect(isNativeProcessReleaseControlPath(path)).toBe(true);
  for (const path of ["src/other-product.ts", "scripts/not-native-process.ts", "scripts/native-process-directory/example.ts",
    "native/process-kernel/target/release/helper", "packages/native-process/node_modules/a.js",
    "packages/native-process/native-artifacts/manifest.json", "native/process-kernel/src/target/output"])
    expect(isNativeProcessReleaseControlPath(path)).toBe(false);
});

function policyFixture() {
  const summary = (id: number, name: string) => ({ id, name, source_type: "Repository", source: "hraness/oompa" });
  const creation = summary(111, "Native process tag creation"), immutable = summary(112, "Immutable native process tags");
  const detail = (item: ReturnType<typeof summary>, types: string[]) => ({ ...item, target: "tag", enforcement: "active",
    conditions: { ref_name: { include: ["refs/tags/native-process-v*"], exclude: [] as string[] } },
    bypass_actors: [] as { actor_id: number; actor_type: string; bypass_mode: string }[], rules: types.map(type => ({ type })) });
  const creationRuleset = detail(creation, ["creation"]);
  creationRuleset.bypass_actors = [{ actor_id: 894119, actor_type: "User", bypass_mode: "always" }];
  return { principal: { id: 894119, type: "User" }, repository: repository(), rulesets: [creation, immutable], creationRuleset,
    immutableRuleset: detail(immutable, ["update", "deletion"]), immutableReleases: { enabled: true, enforced_by_owner: false } };
}
type Policy = ReturnType<typeof policyFixture>;
test("owner policy admits the dedicated native namespace with creation-only owner bypass", () => {
  const fixture = policyFixture(), result = admitNativeProcessTagPolicy(fixture);
  expect(result.namespace).toBe("refs/tags/native-process-v*");
  expect(result.rulesets).toEqual({ creation: 111, immutable: 112 });
  fixture.immutableReleases.enabled = false;
  expect(result.immutableReleases.enabled).toBe(true);
  expect(Object.isFrozen(result.rulesets)).toBe(true);
  expect(() => nativeProcessTagPolicy(result as unknown as NativeProcessTagPolicy)).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
});
const invalidPolicy: readonly (readonly [string, (input: Policy) => void])[] = [
  ["wrong authenticated owner", input => { input.principal.id++; }],
  ["authenticated integration", input => { input.principal.type = "Bot"; }],
  ["CLI namespace", input => { input.creationRuleset.conditions.ref_name.include = ["refs/tags/v*"]; }],
  ["excluded native tag", input => { input.immutableRuleset.conditions.ref_name.exclude = [`refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`]; }],
  ["foreign creation owner", input => { input.creationRuleset.bypass_actors[0]!.actor_id++; }],
  ["workflow integration bypass", input => { input.creationRuleset.bypass_actors[0]!.actor_type = "Integration"; }],
  ["missing owner bypass", input => { input.creationRuleset.bypass_actors = []; }],
  ["mutable tag bypass", input => { input.immutableRuleset.bypass_actors = [...input.creationRuleset.bypass_actors]; }],
  ["creation/update combined", input => { input.creationRuleset.rules.push({ type: "update" }); }],
  ["missing deletion protection", input => { input.immutableRuleset.rules = [{ type: "update" }]; }],
  ["disabled protection", input => { input.immutableRuleset.enforcement = "disabled"; }],
  ["branch protection", input => { input.immutableRuleset.target = "branch"; }],
  ["organization protection", input => { input.creationRuleset.source_type = "Organization"; }],
  ["foreign ruleset", input => { input.creationRuleset.source = "foreign/oompa"; }],
  ["wrong detail ID", input => { input.creationRuleset.id++; }],
  ["wrong detail name", input => { input.immutableRuleset.name = "Immutable version tags"; }],
  ["duplicate native policy name", input => { input.rulesets.push({ ...input.rulesets[0]!, id: 200 }); }],
  ["duplicate policy ID", input => { input.rulesets.push({ ...input.rulesets[0]!, name: "Other" }); }],
  ["missing native policy", input => { input.rulesets = input.rulesets.slice(0, 1); }],
  ["full potentially truncated list", input => { input.rulesets.push(...Array.from({ length: 98 }, (_, i) =>
    ({ id: 500 + i, name: `Other ${i}`, source_type: "Repository", source: "hraness/oompa" }))); }],
  ["mutable release settings", input => { input.immutableReleases.enabled = false; }],
];
for (const [name, change] of invalidPolicy) test(`owner policy refuses ${name}`, () => {
  const input = policyFixture(); change(input);
  expect(() => admitNativeProcessTagPolicy(input)).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
});
test("missing privileged fields never become default approval", () => {
  const input = policyFixture();
  const detail: Record<string, unknown> = { ...input.immutableRuleset };
  delete detail.bypass_actors;
  expect(() => admitNativeProcessTagPolicy({ ...input, immutableRuleset: detail })).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
  const missing: Record<string, unknown> = { ...input };
  delete missing.immutableReleases;
  expect(() => admitNativeProcessTagPolicy(missing)).toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
});

test("documented update parameters must preserve complete tag immutability", () => {
  const value = policyFixture();
  for (const parameters of [undefined, { update_allows_fetch_and_merge: false }]) {
    const rules = [{ type: "deletion" }, { type: "update", ...(parameters === undefined ? {} : { parameters }) }];
    expect(admitNativeProcessTagPolicy({ ...value, immutableRuleset: { ...value.immutableRuleset, rules } }).rulesets.immutable).toBe(112);
  }
  for (const parameters of [{ update_allows_fetch_and_merge: true }, {}, { update_allows_fetch_and_merge: false, unknown: true }]) {
    const rules = [{ type: "deletion" }, { type: "update", parameters }];
    expect(() => admitNativeProcessTagPolicy({ ...value, immutableRuleset: { ...value.immutableRuleset, rules } }))
      .toThrow("NATIVE_PROCESS_RELEASE_AUTHORITY_INVALID");
  }
});
