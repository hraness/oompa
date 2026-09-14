import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import { assertSafeDarwinInstallAcl } from "../src/install-normalizer.ts";
import { BoundedProcessInvocationGuard, recoverBoundedProcessJournal, requireBoundedProcessCleanup, runBoundedProcess } from "./bounded-process.ts";
import { readBoundedJsonResponse } from "./bounded-json-response.ts";
import { admitCommitCiRequiredJob, admitCommitCiRun } from "./check-commit-ci-run.ts";
import { assertActiveCiWorkflow, assertExactOriginUrls, assertMainRulesets, assertTransparentGitIndex } from "./release-tag-policy.ts";
import { nativeBuildInput, nativeInputHash, nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { fetchNativeProcessTagPolicy, nativeProcessTagPolicy, type NativeProcessTagPolicy } from "./native-process-release-authority.ts";
import { nativeReleaseTagObject } from "./native-process-release-evidence.ts";
import { NATIVE_PROCESS_RELEASE_TAG as tag } from "./native-process-release-policy.ts";

const api = "https://api.github.com/repos/hraness/oompa";
const sha = z.string().length(40).regex(/^[a-f0-9]{40}$/u), hash = z.string().length(64).regex(/^[a-f0-9]{64}$/u);
const sourceSchema = z.object({ commitSha: sha, nativeInputsSha256: hash, rootManifestSha256: hash, nativeManifestSha256: hash }).strict();
export type NativeTagSource = Readonly<z.infer<typeof sourceSchema>>;
const referenceSchema = z.object({ objectSha: sha, commitSha: sha }).strict();
export type NativeTagReference = Readonly<z.infer<typeof referenceSchema>>;
const journalSchema = z.object({ formatVersion: z.literal(1), repository: z.literal("hraness/oompa"), tag: z.literal(tag),
  nonce: z.uuid(), source: sourceSchema, root: z.string().min(1).max(4096), commonDirectory: z.string().min(1).max(4096),
}).strict();
type NativeTagJournal = z.infer<typeof journalSchema>;
const snapshotSchema = z.object({ cwd: z.string().max(4096), root: z.string().max(4096), branch: z.literal("main"), head: sha,
  remoteMain: sha, status: z.literal(""), replacementRefs: z.literal(""), index: z.string().max(4 * 1024 * 1024),
  fetchOrigin: z.string().max(1024), pushOrigin: z.string().max(1024), nativeInputsSha256: hash,
  rootManifest: z.string().max(1024 * 1024), committedRootManifest: z.string().max(1024 * 1024),
  nativeManifest: z.string().max(1024 * 1024), committedNativeManifest: z.string().max(1024 * 1024),
}).strict();
function refuse(): never { throw Error("NATIVE_PROCESS_TAG_REFUSED"); }
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function json(text: string): unknown { return JSON.parse(text) as unknown; }

export function nativeTagPushArguments(referenceValue: unknown): readonly string[] {
  const reference = referenceSchema.parse(referenceValue);
  return Object.freeze(["-c", "remote.origin.mirror=false", "push", "--porcelain", "--no-follow-tags",
    "--recurse-submodules=no", "origin", `${reference.objectSha}:refs/tags/${tag}`]);
}
export function admitNativeTagLocalReference(value: unknown): NativeTagReference | null {
  if (value === "") return null;
  const line = z.string().max(1024).parse(value);
  const fields = line.split(" ");
  if (fields.length !== 4 || fields[0] !== `refs/tags/${tag}` || fields[2] !== "tag") refuse();
  return referenceSchema.parse({ objectSha: fields[1], commitSha: fields[3] });
}
function tagMessage(nonce: string): string { return `Release ${tag}\n\nInvocation ${z.uuid().parse(nonce)}`; }
export function admitNativeCreatedTag(bytes: Uint8Array, referenceValue: unknown, source: NativeTagSource, nonce: string): NativeTagReference {
  const reference = exactReference(referenceValue, source);
  nativeReleaseTagObject(bytes, reference.objectSha, source.commitSha);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.slice(text.indexOf("\n\n") + 2) !== `${tagMessage(nonce)}\n`) refuse();
  return Object.freeze(reference);
}

/** Raw observations are parsed here, but only the private IO composition owns
 * command and owner-policy authority. This pure result cannot dispatch Git. */
export function admitNativeTagCheckout(value: unknown): NativeTagSource {
  try {
    const input = snapshotSchema.parse(value);
    if (input.cwd !== input.root || input.head !== input.remoteMain || input.rootManifest !== input.committedRootManifest
      || input.nativeManifest !== input.committedNativeManifest) refuse();
    z.object({ name: z.literal("@hraness/oompa"), version: z.string().min(1).max(32) }).parse(json(input.rootManifest));
    z.object({ name: z.literal("@hraness/native-process"), version: z.literal("0.1.0") }).parse(json(input.nativeManifest));
    assertExactOriginUrls(input.fetchOrigin, input.pushOrigin); assertTransparentGitIndex(input.index);
    return Object.freeze({ commitSha: input.head, nativeInputsSha256: input.nativeInputsSha256,
      rootManifestSha256: nativeInputHash(Buffer.from(input.rootManifest)), nativeManifestSha256: nativeInputHash(Buffer.from(input.nativeManifest)) });
  } catch { return refuse(); }
}

/** Closed product operations, not a caller-selected argv/HTTP interface. The
 * production composition is private below; tests substitute inert operations. */
export type NativeTagPorts = Readonly<{
  checkout(): Promise<NativeTagSource>;
  qualify(source: NativeTagSource): Promise<void>;
  local(): Promise<NativeTagReference | null>;
  remote(): Promise<NativeTagReference | null>;
  reserve(source: NativeTagSource): void;
  intent(kind: "local" | "push", source: NativeTagSource, reference?: NativeTagReference): void;
  localCreated(reference: NativeTagReference): void;
  refresh(source: NativeTagSource, reference: NativeTagReference | null): Promise<void>;
  create(source: NativeTagSource): Promise<NativeTagReference>;
  push(reference: NativeTagReference): Promise<void>;
  complete(reference: NativeTagReference): void;
}>;
function exactReference(value: unknown, source: NativeTagSource): NativeTagReference {
  const reference = referenceSchema.parse(value);
  if (reference.commitSha !== source.commitSha) refuse();
  return reference;
}
function receipt(source: NativeTagSource, reference: NativeTagReference, reconciled: boolean) {
  return Object.freeze({ formatVersion: 1 as const, repository: "hraness/oompa" as const, tag,
    sourceSha: source.commitSha, tagObjectSha: reference.objectSha, reconciled });
}
export async function runNativeTagCreation(ports: NativeTagPorts) {
  const source = sourceSchema.parse(await ports.checkout());
  if (await ports.local() !== null || await ports.remote() !== null) refuse();
  await ports.qualify(source);
  ports.reserve(source);
  ports.intent("local", source);
  await ports.refresh(source, null);
  const created = exactReference(await ports.create(source), source);
  const local = exactReference(await ports.local(), source);
  if (!same(created, local)) refuse();
  ports.localCreated(local);
  ports.intent("push", source, local);
  await ports.refresh(source, local);
  // Exactly one attempt. A thrown or nonzero result never causes replay or tag
  // deletion. Only a separate explicit reconciliation may inspect retained state.
  await ports.push(local);
  const remote = exactReference(await ports.remote(), source);
  if (!same(remote, local)) refuse();
  ports.complete(remote);
  return receipt(source, remote, false);
}
/** Reconciliation can finish an already-landed exact recorded object. It never
 * adopts an ambient tag or repairs missing local receipts or an absent remote. */
export async function reconcileNativeTagCreation(sourceValue: unknown, referenceValue: unknown, ports: Readonly<{
  local(): Promise<NativeTagReference | null>; remote(): Promise<NativeTagReference | null>;
  complete(reference: NativeTagReference): void;
}>) {
  const source = sourceSchema.parse(sourceValue), expected = exactReference(referenceValue, source);
  const local = exactReference(await ports.local(), source), remote = exactReference(await ports.remote(), source);
  if (!same(expected, local) || !same(expected, remote)) refuse();
  ports.complete(remote);
  return receipt(source, remote, true);
}

function privateDirectory(path: string) {
  const stat = lstatSync(path, { bigint: true });
  if (realpathSync(path) !== path || !stat.isDirectory() || process.getuid === undefined || stat.uid !== BigInt(process.getuid())
    || (stat.mode & 0o7777n) !== 0o700n) refuse();
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const held = fstatSync(descriptor, { bigint: true });
    if (held.dev !== stat.dev || held.ino !== stat.ino) refuse();
    assertSafeDarwinInstallAcl(descriptor, process.getuid(), "native tag journal directory");
  } finally { closeSync(descriptor); }
  return stat;
}
function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function durableFile(directory: string, name: string, value: unknown): void {
  privateDirectory(directory);
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > 16 * 1024 || !/^[a-z-]+\.json$/u.test(name)) refuse();
  const descriptor = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { writeFileSync(descriptor, bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  syncDirectory(directory);
}
function readJournal(directory: string, name: string): unknown {
  privateDirectory(directory);
  const path = join(directory, name), stat = lstatSync(path, { bigint: true });
  if (process.getuid === undefined || !stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid())
    || (stat.mode & 0o7777n) !== 0o400n) refuse();
  return json(new TextDecoder("utf-8", { fatal: true }).decode(nativeBuildInput(path, 16 * 1024)));
}

/** Owner-only standalone entrypoint. It never runs during imports or fixtures.
 * Owner policy and current-main facts are fresh preflight at command invocation,
 * not an atomic GitHub lease. Enforced split tag rules remain server authority. */
export async function createNativeProcessTag(mode: "create" | "reconcile" = "create") {
  if (Bun.version !== "1.3.14" || process.platform === "win32" || process.getuid === undefined
    || !["create", "reconcile"].includes(mode)) refuse();
  const root = realpathSync(process.cwd());
  if (root !== process.cwd() || root !== realpathSync(join(import.meta.dir, ".."))) refuse();
  const work = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "oompa-native-tag-"))), workIdentity = privateDirectory(work);
  const git = Bun.which("git"), gh = Bun.which("gh"); if (git === null) refuse();
  const guard = new BoundedProcessInvocationGuard();
  let recovery = join(work, "recovery");
  let journalDirectory: string | undefined, journalIdentity: ReturnType<typeof privateDirectory> | undefined;
  const assertOwned = () => {
    const current = privateDirectory(work);
    if (current.dev !== workIdentity.dev || current.ino !== workIdentity.ino) refuse();
    if (journalDirectory !== undefined && journalIdentity !== undefined) {
      const directory = privateDirectory(journalDirectory);
      if (directory.dev !== journalIdentity.dev || directory.ino !== journalIdentity.ino) refuse();
    }
  };
  const environment: Record<string, string> = { HOME: realpathSync(homedir()), PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8", LC_ALL: "C", GCM_INTERACTIVE: "never", GH_PROMPT_DISABLED: "1", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_TERMINAL_PROMPT: "0", SSH_ASKPASS_REQUIRE: "never" };
  if (process.env.SSH_AUTH_SOCK !== undefined) environment.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK;
  const command = async (executable: string, arguments_: readonly string[], phase: string) => guard.observe(async () => {
    assertOwned();
    const observed = await runBoundedProcess({ executable: realpathSync(executable), arguments: arguments_,
      cwd: root, environment, containment: "local", phase: `native-tag-${phase}`, timeoutMs: 30_000,
      terminationGraceMs: 500, outputMaximumBytes: 4 * 1024 * 1024,
    }, { recoveryDirectory: recovery });
    // Runner journals record process identity/phase, never stdout or environment.
    // A CLI token is held only in the returned in-memory buffer; scrub both
    // streams before throwing for an uncertain or failed command.
    observed.stderr.fill(0);
    if (observed.cleanup !== "proven") observed.stdout.fill(0);
    const result = requireBoundedProcessCleanup(observed);
    assertOwned();
    result.stderr.fill(0);
    if (result.exitCode !== 0) { result.stdout.fill(0); refuse(); }
    return result.stdout;
  });
  const gitText = async (args: readonly string[], phase: string) => new TextDecoder("utf-8", { fatal: true }).decode(await command(git, args, phase));
  const commonValue = (await gitText(["rev-parse", "--git-common-dir"], "common-directory")).trim();
  if (commonValue.length === 0 || commonValue.length > 4096 || /[\r\n\0]/u.test(commonValue)) refuse();
  const commonDirectory = realpathSync(resolve(root, commonValue));
  const common = lstatSync(commonDirectory, { bigint: true });
  if (!common.isDirectory() || common.uid !== BigInt(process.getuid()) || (common.mode & 0o022n) !== 0n) refuse();
  const parent = join(commonDirectory, "oompa-native-release");
  try { mkdirSync(parent, { mode: 0o700 }); } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  privateDirectory(parent);
  // Files and the journal itself are not durable until every newly created
  // ancestor entry is persisted too. Any failure here precedes tag effects.
  syncDirectory(commonDirectory);
  const targetJournal = join(parent, tag);
  let token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (token === undefined) {
    if (gh === null) refuse();
    const bytes = await command(gh, ["auth", "token", "--hostname", "github.com"], "owner-token");
    try { token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim(); } finally { bytes.fill(0); }
  }
  if (token.length < 1 || token.length > 8192 || /\s/u.test(token)) refuse();
  const ownerToken = token;
  const get = async (path: string, absent = false): Promise<unknown> => {
    guard.assertMayProceed(); assertOwned();
    const response = await fetch(`${api}${path}`, { method: "GET", redirect: "error", cache: "no-store",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${ownerToken}`, "Cache-Control": "no-cache",
        "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "oompa-native-owner-tag" }, signal: AbortSignal.timeout(15_000) });
    if (response.status === 404 && absent) { await response.body?.cancel(); return null; }
    if (response.status !== 200) { await response.body?.cancel(); refuse(); }
    return readBoundedJsonResponse(response, "Native owner tag", 512 * 1024);
  };
  const remoteMain = async () => {
    const value = z.object({ ref: z.literal("refs/heads/main"), object: z.object({ type: z.literal("commit"), sha }) }).parse(await get("/git/ref/heads/main"));
    return value.object.sha;
  };
  const remote = async (): Promise<NativeTagReference | null> => {
    const raw = await get(`/git/ref/tags/${tag}`, true); if (raw === null) return null;
    const ref = z.object({ ref: z.literal(`refs/tags/${tag}`), object: z.object({ type: z.literal("tag"), sha }) }).parse(raw);
    const object = z.object({ sha, tag: z.literal(tag), object: z.object({ type: z.literal("commit"), sha }) }).parse(await get(`/git/tags/${ref.object.sha}`));
    if (object.sha !== ref.object.sha) refuse();
    return { objectSha: object.sha, commitSha: object.object.sha };
  };
  const local = async (): Promise<NativeTagReference | null> => {
    const value = (await gitText(["for-each-ref", "--format=%(refname) %(objectname) %(objecttype) %(*objectname)", `refs/tags/${tag}`], "local-ref")).trim();
    return admitNativeTagLocalReference(value);
  };
  let journal: NativeTagJournal | undefined;
  const activateJournal = () => {
    journalDirectory = targetJournal; journalIdentity = privateDirectory(targetJournal);
    recovery = join(targetJournal, "recovery"); guard.retainRecoveryPath(recovery);
  };
  const completion = (reference: NativeTagReference) => {
    assertOwned();
    if (journal === undefined) refuse();
    const value = { source: journal.source, reference, nonce: journal.nonce };
    try { durableFile(targetJournal, "completed.json", value); } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST" || !same(readJournal(targetJournal, "completed.json"), value)) throw error;
    }
  };
  if (mode === "reconcile") {
    activateJournal();
    journal = journalSchema.parse(readJournal(targetJournal, "identity.json"));
    if (journal.root !== root || journal.commonDirectory !== commonDirectory) refuse();
    const retained = z.object({ nonce: z.uuid(), reference: referenceSchema }).strict().parse(readJournal(targetJournal, "local-created.json"));
    if (retained.nonce !== journal.nonce) refuse();
    await recoverBoundedProcessJournal({ recoveryDirectory: recovery });
    return reconcileNativeTagCreation(journal.source, retained.reference, { local, remote, complete: completion });
  }
  const checkout = async () => {
    const head = (await gitText(["rev-parse", "--verify", "HEAD^{commit}"], "head")).trim(); sha.parse(head);
    return admitNativeTagCheckout({ cwd: root, root: (await gitText(["rev-parse", "--show-toplevel"], "root")).trim(), head,
      branch: (await gitText(["branch", "--show-current"], "branch")).trim(), remoteMain: await remoteMain(),
      status: (await gitText(["status", "--porcelain=v1", "--untracked-files=all"], "status")).trim(),
      replacementRefs: (await gitText(["for-each-ref", "--format=%(refname)", "refs/replace"], "replacements")).trim(),
      index: await gitText(["ls-files", "-v", "-z"], "index"),
      fetchOrigin: (await gitText(["remote", "get-url", "--all", "origin"], "fetch-origin")).trim(),
      pushOrigin: (await gitText(["remote", "get-url", "--push", "--all", "origin"], "push-origin")).trim(),
      nativeInputsSha256: nativeInputHash(Buffer.from(JSON.stringify(nativeProcessSourceInventory(root)))),
      rootManifest: nativeBuildInput(join(root, "package.json"), 1024 * 1024).toString("utf8"),
      committedRootManifest: await gitText(["show", `${head}:package.json`], "root-manifest"),
      nativeManifest: nativeBuildInput(join(root, "packages/native-process/package.json"), 1024 * 1024).toString("utf8"),
      committedNativeManifest: await gitText(["show", `${head}:packages/native-process/package.json`], "native-manifest"),
    });
  };
  let policy: NativeProcessTagPolicy | undefined;
  const consumePolicy = () => { assertOwned(); guard.assertMayProceed(); if (policy === undefined) refuse(); const proof = policy; policy = undefined; nativeProcessTagPolicy(proof); };
  return runNativeTagCreation({ checkout, local, remote,
    qualify: async source => {
      const list = z.array(z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), name: z.string().max(128) })).max(99)
        .parse(await get("/rulesets?includes_parents=false&per_page=100&page=1"));
      const details = new Map<string, unknown>();
      for (const name of ["Immutable main", "Protect main"]) {
        const summaries = list.filter(item => item.name === name), summary = summaries[0];
        if (summaries.length !== 1 || summary === undefined) refuse();
        const value = await get(`/rulesets/${summary.id}?includes_parents=false`);
        const bound = z.object({ id: z.literal(summary.id), source_type: z.literal("Repository"), source: z.literal("hraness/oompa") }).safeParse(value);
        if (!bound.success) refuse(); details.set(name, value);
      }
      assertMainRulesets(list, details); assertActiveCiWorkflow(await get("/actions/workflows/ci.yml"));
      const identity = { repository: "hraness/oompa", defaultBranch: "main", sha: source.commitSha };
      const run = admitCommitCiRun(await get(`/actions/workflows/ci.yml/runs?branch=main&event=push&head_sha=${source.commitSha}&per_page=100`), identity);
      admitCommitCiRequiredJob(await get(`/actions/runs/${run.runId}/jobs?filter=latest&per_page=100`), run, identity);
    },
    reserve: source => {
      mkdirSync(targetJournal, { mode: 0o700 }); activateJournal();
      syncDirectory(parent);
      journal = { formatVersion: 1, repository: "hraness/oompa", tag, nonce: randomUUID(), source, root, commonDirectory };
      durableFile(targetJournal, "identity.json", journal);
    },
    intent: (kind, source, reference) => {
      assertOwned(); if (journal === undefined || !same(journal.source, source)) refuse();
      durableFile(targetJournal, `${kind}-intent.json`, { nonce: journal.nonce, source, ...(reference === undefined ? {} : { reference }) });
    },
    localCreated: reference => {
      if (journal === undefined) refuse(); durableFile(targetJournal, "local-created.json", { nonce: journal.nonce, reference });
    },
    refresh: async (source, reference) => {
      await recoverBoundedProcessJournal({ recoveryDirectory: recovery });
      if (!same(await checkout(), source) || !same(await local(), reference) || await remote() !== null) refuse();
      policy = await fetchNativeProcessTagPolicy({ token: ownerToken });
      if (await remoteMain() !== source.commitSha) refuse();
    },
    create: async source => {
      consumePolicy();
      if (journal === undefined) refuse();
      await gitText(["-c", "tag.gpgSign=false", "tag", "-a", tag, "-m", tagMessage(journal.nonce), source.commitSha], "create-local");
      const reference = exactReference(await local(), source), bytes = await command(git, ["cat-file", "tag", reference.objectSha], "local-object");
      return admitNativeCreatedTag(bytes, reference, source, journal.nonce);
    },
    push: async reference => {
      consumePolicy();
      // Push the captured annotated object, never a ref whose local target could
      // change between inspection and Git's transport. No force, deletion or retry.
      await gitText(nativeTagPushArguments(reference), "push");
    }, complete: completion,
  });
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== "--reconcile")) refuse();
    console.log(JSON.stringify(await createNativeProcessTag(args.length === 0 ? "create" : "reconcile")));
  } catch {
    console.error("Native tag operation refused; tags and private Git-common-directory records were retained. --reconcile can only finish an already-landed object with its exact saved local receipt; other outcomes require operator inspection.");
    process.exitCode = 1;
  }
}
