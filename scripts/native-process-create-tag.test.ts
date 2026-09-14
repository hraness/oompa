import { expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { admitNativeCreatedTag, admitNativeTagCheckout, admitNativeTagLocalReference, nativeTagPushArguments,
  reconcileNativeTagCreation, runNativeTagCreation, type NativeTagPorts, type NativeTagReference,
  type NativeTagSource } from "./native-process-create-tag.ts";
import * as shared from "./release-tag-policy.ts";
import * as cli from "./create-release-tag.ts";

const commitSha = "a".repeat(40), objectSha = "b".repeat(40), digest = "c".repeat(64);
const tag = "native-process-v0.1.0";
const reference = { objectSha, commitSha };
function checkout() {
  const rootManifest = JSON.stringify({ name: "@hraness/oompa", version: "0.8.0" }) + "\n";
  const nativeManifest = JSON.stringify({ name: "@hraness/native-process", version: "0.1.0" }) + "\n";
  return { cwd: "/fixture/oompa", root: "/fixture/oompa", branch: "main", head: commitSha, remoteMain: commitSha,
    status: "", replacementRefs: "", index: "H package.json\0H packages/native-process/package.json\0",
    fetchOrigin: "https://github.com/hraness/oompa.git", pushOrigin: "git@github.com:hraness/oompa.git",
    nativeInputsSha256: digest, rootManifest, committedRootManifest: rootManifest, nativeManifest, committedNativeManifest: nativeManifest };
}
const source = (): NativeTagSource => admitNativeTagCheckout(checkout());

test("CLI validators are the exact shared pure functions", () => {
  expect(cli.assertMainRulesets).toBe(shared.assertMainRulesets);
  expect(cli.assertActiveCiWorkflow).toBe(shared.assertActiveCiWorkflow);
  expect(cli.assertExactOriginUrls).toBe(shared.assertExactOriginUrls);
  expect(cli.assertTransparentGitIndex).toBe(shared.assertTransparentGitIndex);
});
test("checkout admission binds immutable source and committed manifest bytes", () => {
  const input = checkout(), result = admitNativeTagCheckout(input);
  expect(result.commitSha).toBe(commitSha);
  expect(result.nativeInputsSha256).toBe(digest);
  expect(result.rootManifestSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(result.nativeManifestSha256).not.toBe(result.rootManifestSha256);
  expect(Object.isFrozen(result)).toBe(true);
  input.head = "d".repeat(40);
  expect(result.commitSha).toBe(commitSha);
});
const invalid: readonly (readonly [string, (value: ReturnType<typeof checkout>) => void])[] = [
  ["subdirectory", value => { value.cwd += "/scripts"; }],
  ["feature branch", value => { value.branch = "feature"; }],
  ["main drift", value => { value.remoteMain = "d".repeat(40); }],
  ["dirty tracked file", value => { value.status = " M package.json"; }],
  ["untracked file", value => { value.status = "?? script.ts"; }],
  ["replacement ref", value => { value.replacementRefs = `refs/replace/${commitSha}`; }],
  ["assume unchanged", value => { value.index = "h package.json\0"; }],
  ["skip worktree", value => { value.index = "S package.json\0"; }],
  ["foreign origin", value => { value.fetchOrigin = "https://github.com/foreign/oompa.git"; }],
  ["multiple push origins", value => { value.pushOrigin += "\nhttps://github.com/hraness/oompa.git"; }],
  ["changed working manifest", value => { value.rootManifest += " "; }],
  ["changed native manifest", value => { value.nativeManifest += " "; }],
  ["wrong package identity", value => { value.nativeManifest = value.committedNativeManifest = '{"name":"other","version":"0.1.0"}'; }],
  ["wrong native version", value => { value.nativeManifest = value.committedNativeManifest = '{"name":"@hraness/native-process","version":"0.2.0"}'; }],
  ["malformed JSON", value => { value.rootManifest = value.committedRootManifest = "{"; }],
  ["invalid source digest", value => { value.nativeInputsSha256 = "bad"; }],
];
for (const [name, change] of invalid) test(`checkout refuses ${name}`, () => {
  const input = checkout(); change(input);
  expect(() => admitNativeTagCheckout(input)).toThrow("NATIVE_PROCESS_TAG_REFUSED");
});

test("push is one captured object and disables ambient mirror, follow-tags and submodule pushes", () => {
  const args = nativeTagPushArguments(reference);
  expect(args).toEqual(["-c", "remote.origin.mirror=false", "push", "--porcelain", "--no-follow-tags",
    "--recurse-submodules=no", "origin", `${objectSha}:refs/tags/${tag}`]);
  expect(Object.isFrozen(args)).toBe(true);
  expect(() => nativeTagPushArguments({ ...reference, objectSha: `+${objectSha}` })).toThrow();
});
test("local reference binds the exact full name and requires an annotated commit tag", () => {
  expect(admitNativeTagLocalReference("")).toBeNull();
  expect(admitNativeTagLocalReference(`refs/tags/${tag} ${objectSha} tag ${commitSha}`)).toEqual(reference);
  for (const raw of [
    `refs/tags/${tag}/child ${objectSha} tag ${commitSha}`,
    `refs/tags/${tag} ${commitSha} commit `,
    `refs/tags/${tag} ${objectSha} tag ${commitSha}\nrefs/tags/${tag}/child ${objectSha} tag ${commitSha}`,
    `refs/tags/${tag} ${objectSha} tag ${"z".repeat(40)}`, null,
  ]) expect(() => admitNativeTagLocalReference(raw)).toThrow();
});
test("created object is bound to this invocation's exact message as well as tag SHA and commit", () => {
  const nonce = "312fc5f1-ffda-4b43-a17b-e15807ce5147";
  const object = (message: string) => {
    const bytes = Buffer.from(`object ${commitSha}\ntype commit\ntag ${tag}\ntagger Owner <fixture@example.invalid> 1 +0000\n\n${message}`);
    const objectSha = createHash("sha1").update(Buffer.from(`tag ${bytes.length}\0`)).update(bytes).digest("hex");
    return { bytes, reference: { objectSha, commitSha } };
  };
  const valid = object(`Release ${tag}\n\nInvocation ${nonce}\n`);
  expect(admitNativeCreatedTag(valid.bytes, valid.reference, source(), nonce)).toEqual(valid.reference);
  for (const message of [`Release ${tag}\n`, `Release ${tag}\n\nInvocation 412fc5f1-ffda-4b43-a17b-e15807ce5147\n`,
    `Release ${tag}\n\nInvocation ${nonce}\nextra\n`]) {
    const foreign = object(message);
    expect(() => admitNativeCreatedTag(foreign.bytes, foreign.reference, source(), nonce)).toThrow("NATIVE_PROCESS_TAG_REFUSED");
  }
  expect(() => admitNativeCreatedTag(valid.bytes, reference, source(), nonce)).toThrow();
});

function fixture(fail?: string) {
  const calls: string[] = [];
  let local: NativeTagReference | null = null, remote: NativeTagReference | null = null;
  const step = (name: string) => { calls.push(name); if (name === fail) throw Error("inert failure"); };
  const ports: NativeTagPorts = {
    checkout: async () => { step("checkout"); return source(); },
    local: async () => { step("local"); return local; }, remote: async () => { step("remote"); return remote; },
    qualify: async value => { step("qualify"); expect(value).toEqual(source()); },
    reserve: value => { step("reserve"); expect(value).toEqual(source()); },
    intent: (kind, value, ref) => { step(`${kind}-intent`); expect(value).toEqual(source());
      expect(ref).toEqual(kind === "push" ? reference : undefined); },
    refresh: async (value, ref) => { step(ref === null ? "refresh-local" : "refresh-push");
      expect(value).toEqual(source()); expect(ref).toEqual(local); },
    create: async value => { step("create"); expect(value).toEqual(source()); local = { ...reference }; return { ...reference }; },
    localCreated: ref => { step("local-created"); expect(ref).toEqual(reference); },
    push: async ref => { step("push"); expect(ref).toEqual(reference); remote = { ...reference }; },
    complete: ref => { step("complete"); expect(ref).toEqual(reference); },
  };
  return { calls, ports, setLocal: (value: NativeTagReference | null) => { local = value; },
    setRemote: (value: NativeTagReference | null) => { remote = value; } };
}
const successOrder = ["checkout", "local", "remote", "qualify", "reserve", "local-intent", "refresh-local", "create",
  "local", "local-created", "push-intent", "refresh-push", "push", "remote", "complete"];
test("creation records durable intent, refreshes authority before both effects, then joins exact readback", async () => {
  const input = fixture(), result = await runNativeTagCreation(input.ports);
  expect(input.calls).toEqual(successOrder);
  expect(result).toEqual({ formatVersion: 1, repository: "hraness/oompa", tag, sourceSha: commitSha, tagObjectSha: objectSha, reconciled: false });
});
for (const phase of ["checkout", "qualify", "reserve", "local-intent", "refresh-local", "create", "local-created",
  "push-intent", "refresh-push", "push", "complete"]) test(`failure at ${phase} never retries or deletes any tag`, async () => {
  const input = fixture(phase);
  await expect(runNativeTagCreation(input.ports)).rejects.toThrow("inert failure");
  expect(input.calls).toEqual(successOrder.slice(0, successOrder.indexOf(phase) + 1));
  expect(input.calls.filter(item => item === "push").length).toBeLessThanOrEqual(1);
});
test("an uncertain push is retained even if it may have reached GitHub", async () => {
  const input = fixture();
  const ports = { ...input.ports, push: async () => { input.calls.push("push"); input.setRemote(reference); throw Error("unknown result"); } };
  await expect(runNativeTagCreation(ports)).rejects.toThrow("unknown result");
  expect(input.calls).toEqual(successOrder.slice(0, successOrder.indexOf("push") + 1));
  expect(input.calls).not.toContain("complete");
});
for (const location of ["local", "remote"] as const) test(`ambient ${location} tag is never adopted`, async () => {
  const input = fixture(); if (location === "local") input.setLocal(reference); else input.setRemote(reference);
  await expect(runNativeTagCreation(input.ports)).rejects.toThrow("NATIVE_PROCESS_TAG_REFUSED");
  expect(input.calls).not.toContain("reserve"); expect(input.calls).not.toContain("create");
});
test("wrong remote object after a successful push is not reported complete", async () => {
  const input = fixture();
  const ports = { ...input.ports, push: async () => { input.calls.push("push"); input.setRemote({ ...reference, objectSha: "e".repeat(40) }); } };
  await expect(runNativeTagCreation(ports)).rejects.toThrow("NATIVE_PROCESS_TAG_REFUSED");
  expect(input.calls).not.toContain("complete");
  expect(input.calls.filter(item => item === "push")).toHaveLength(1);
});
test("a local ref replacement after creation is never adopted even at the same source", async () => {
  const input = fixture();
  const ports = { ...input.ports, create: async () => {
    input.calls.push("create"); input.setLocal({ ...reference, objectSha: "e".repeat(40) }); return reference;
  } };
  await expect(runNativeTagCreation(ports)).rejects.toThrow("NATIVE_PROCESS_TAG_REFUSED");
  expect(input.calls).not.toContain("local-created"); expect(input.calls).not.toContain("push");
});
test("reconciliation only records completion for the exact already-landed saved object", async () => {
  const input = fixture(); input.setLocal(reference); input.setRemote(reference);
  const result = await reconcileNativeTagCreation(source(), reference, input.ports);
  expect(result.reconciled).toBe(true); expect(input.calls).toEqual(["local", "remote", "complete"]);
});
for (const [label, local, remote, saved] of [
  ["missing local receipt", reference, reference, null],
  ["absent local", null, reference, reference],
  ["absent remote", reference, null, reference],
  ["changed remote object", reference, { ...reference, objectSha: "e".repeat(40) }, reference],
  ["changed saved object", reference, reference, { ...reference, objectSha: "e".repeat(40) }],
  ["wrong source", { ...reference, commitSha: "e".repeat(40) }, reference, reference],
] as const) test(`reconciliation refuses ${label} without mutation or ambient adoption`, async () => {
  const input = fixture(); input.setLocal(local); input.setRemote(remote);
  await expect(reconcileNativeTagCreation(source(), saved, input.ports)).rejects.toThrow();
  expect(input.calls.every(item => item === "local" || item === "remote")).toBe(true);
});
