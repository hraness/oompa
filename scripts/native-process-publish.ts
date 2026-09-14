import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { readBoundedJsonResponse } from "./bounded-json-response.ts";
import { nativeBuildInput, nativeInputHash, nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { nativeProvenanceVerification, verifyNativeProcessProvenance } from "./native-process-provenance.ts";
import { fetchNativeProcessReleaseAuthority, nativeProcessReleaseAuthority } from "./native-process-release-authority.ts";
import { proveNoPriorNativeReleaseCreation } from "./native-process-release-retry.ts";
import {
  NATIVE_PROCESS_RELEASE_ARCHIVE, NATIVE_PROCESS_RELEASE_PROVENANCE, NATIVE_PROCESS_RELEASE_REPOSITORY, NATIVE_PROCESS_RELEASE_TAG,
  admitNativeReleaseReadback, assertNativeReleaseNotLatest, nativeProcessReleaseRun, nativeReleaseDraftRequest,
  nativeReleasePublishRequest, parseNativeReleaseProvenance, type NativeProcessReleaseRun, type NativeReleaseIdentity,
  type NativeReleaseReadback,
} from "./native-process-release-policy.ts";

const prefix = `/repos/${NATIVE_PROCESS_RELEASE_REPOSITORY}`;
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const releaseHead = z.object({ id, tag_name: z.string().min(1).max(128), draft: z.boolean() });
function refuse(): never { throw Error("NATIVE_PROCESS_PUBLICATION_FAILED_RETAIN_STATE"); }
export type NativePublicationIntent = Readonly<{ operation: "create" | "upload" | "publish"; releaseId?: number; asset?: string }>;
/** Narrow effect ports let tests drive uncertain provider outcomes. This function
 * supplies no network or verification capability; the public entrypoint below
 * constructs the real ports only after cryptographic admission. */
export type NativePublicationPorts = Readonly<{
  authority: () => Promise<unknown>;
  list: (page: number) => Promise<unknown>;
  read: (releaseId: number) => Promise<unknown>;
  latest: () => Promise<unknown>;
  mayCreate: () => Promise<boolean>;
  verifyAssets: (release: NativeReleaseReadback) => Promise<void>;
  intent: (value: NativePublicationIntent) => void;
  create: (request: ReturnType<typeof nativeReleaseDraftRequest>) => Promise<void>;
  upload: (releaseId: number, asset: string) => Promise<void>;
  publish: (releaseId: number, request: ReturnType<typeof nativeReleasePublishRequest>) => Promise<void>;
}>;

async function discover(ports: NativePublicationPorts): Promise<unknown> {
  const seen = new Set<number>(); let found: number | undefined;
  for (let page = 1; page <= 6; page += 1) {
    const values = z.array(releaseHead).max(page === 6 ? 0 : 100).parse(await ports.list(page));
    for (const value of values) {
      if (seen.has(value.id)) refuse();
      seen.add(value.id);
      if (value.tag_name === NATIVE_PROCESS_RELEASE_TAG) {
        if (found !== undefined) refuse();
        found = value.id;
      }
    }
    if (values.length < 100) return found === undefined ? undefined : await ports.read(found);
  }
  return refuse();
}

/** No mutation is retried after an uncertain response. A fresh exact readback
 * can establish that it completed; otherwise preserve the draft and stop. */
export async function reconcileNativeReleasePublication(identity: NativeReleaseIdentity, executionRun: NativeProcessReleaseRun,
  ports: NativePublicationPorts): Promise<NativeReleaseReadback> {
  let repository = await ports.authority();
  let raw = await discover(ports);
  if (raw === undefined) {
    if (!await ports.mayCreate()) refuse();
    repository = await ports.authority();
    ports.intent({ operation: "create" });
    try { await ports.create(nativeReleaseDraftRequest(identity, executionRun)); }
    catch { /* A fresh inventory resolves an uncertain create without retry. */ }
    raw = await discover(ports);
    if (raw === undefined) refuse();
  }
  let head = releaseHead.parse(raw);
  let accepted = admitNativeReleaseReadback(repository, raw, identity, head.draft ? "draft" : "published", undefined, executionRun);
  if (head.draft) {
    for (const asset of identity.assets) {
      if (accepted.assets.some(current => current.name === asset.name)) continue;
      raw = await ports.read(accepted.id);
      repository = await ports.authority();
      accepted = admitNativeReleaseReadback(repository, raw, identity, "draft", accepted, executionRun);
      if (accepted.assets.some(current => current.name === asset.name)) continue;
      ports.intent({ operation: "upload", releaseId: accepted.id, asset: asset.name });
      try { await ports.upload(accepted.id, asset.name); }
      catch { /* Read the retained numeric release; never overwrite an asset. */ }
      raw = await ports.read(accepted.id);
      accepted = admitNativeReleaseReadback(repository, raw, identity, "draft", accepted, executionRun);
      if (!accepted.assets.some(current => current.name === asset.name)) refuse();
    }
    if (accepted.assets.length !== 3) refuse();
    await ports.verifyAssets(accepted);
    raw = await ports.read(accepted.id);
    assertNativeReleaseNotLatest(await ports.latest(), accepted);
    repository = await ports.authority();
    accepted = admitNativeReleaseReadback(repository, raw, identity, "draft", accepted, executionRun);
    ports.intent({ operation: "publish", releaseId: accepted.id });
    try { await ports.publish(accepted.id, nativeReleasePublishRequest(identity, accepted.createdAttempt, executionRun)); }
    catch { /* Publishing may have completed despite a missing response. */ }
    raw = await ports.read(accepted.id);
    head = releaseHead.parse(raw);
    if (head.draft) refuse();
    accepted = admitNativeReleaseReadback(repository, raw, identity, "published", accepted, executionRun);
  }
  await ports.verifyAssets(accepted);
  repository = await ports.authority();
  raw = await ports.read(accepted.id);
  accepted = admitNativeReleaseReadback(repository, raw, identity, "published", accepted, executionRun);
  assertNativeReleaseNotLatest(await ports.latest(), accepted);
  return accepted;
}

function headers(token: string, accept: string): Record<string, string> {
  if (token.length < 1 || token.length > 8192 || /[\r\n]/u.test(token)) refuse();
  return { Accept: accept, Authorization: `Bearer ${token}`, "Cache-Control": "no-cache",
    "User-Agent": "hraness-native-process-publication", "X-GitHub-Api-Version": "2022-11-28" };
}
async function jsonRequest(token: string, method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
  const response = await fetch(`https://api.github.com${prefix}${path}`, { method, cache: "no-store", redirect: "error",
    headers: { ...headers(token, "application/vnd.github+json"), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    signal: AbortSignal.timeout(15_000), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (response.status !== (method === "POST" ? 201 : 200)) { await response.body?.cancel(); refuse(); }
  return await readBoundedJsonResponse(response, "NATIVE_RELEASE_RESPONSE", 2 * 1024 * 1024);
}
async function responseBytes(response: Response, size: number): Promise<Buffer> {
  if (response.status !== 200) { await response.body?.cancel(); refuse(); }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^[1-9][0-9]*$/u.test(length) || Number(length) !== size)) refuse();
  const reader = response.body?.getReader(); if (reader === undefined) refuse();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; if (total > size) refuse();
      chunks.push(item.value);
    }
  } finally { try { await reader.cancel(); } catch { /* No further operation is admitted from this body. */ } reader.releaseLock(); }
  if (total !== size) refuse();
  return Buffer.concat(chunks);
}
async function download(token: string, assetId: number, size: number): Promise<Buffer> {
  id.parse(assetId);
  const signal = AbortSignal.timeout(120_000);
  const response = await fetch(`https://api.github.com${prefix}/releases/assets/${assetId}`, {
    headers: headers(token, "application/octet-stream"), redirect: "manual", cache: "no-store", signal });
  if (response.status === 200) return await responseBytes(response, size);
  const location = response.headers.get("location");
  await response.body?.cancel();
  if (response.status !== 302 || location === null || location.length > 8192) refuse();
  const target = new URL(location);
  if (target.origin !== "https://release-assets.githubusercontent.com" || target.username !== "" || target.password !== ""
    || target.hash !== "" || !target.pathname.startsWith("/github-production-release-asset/")) refuse();
  // GitHub's numeric endpoint chose this bounded asset URL. Never forward the
  // repository token to the asset host or follow another redirect.
  return await responseBytes(await fetch(target, { redirect: "error", cache: "no-store", signal }), size);
}

export async function publishNativeProcessRelease(options: Readonly<{
  archivePath: string; checksumPath: string; provenancePath: string; workParent: string; context: unknown; token: string;
}>) {
  const archive = nativeBuildInput(options.archivePath, 64 * 1024 * 1024), checksum = nativeBuildInput(options.checksumPath, 4096),
    provenance = nativeBuildInput(options.provenancePath, 256 * 1024);
  const producing = parseNativeReleaseProvenance(provenance).qualification.coordinate;
  const execution = nativeProcessReleaseRun(options.context);
  // The verifier re-admits all four target results and cryptographically binds
  // these exact bytes. A saved JSON receipt cannot replace this call.
  const verified = await verifyNativeProcessProvenance({ coordinate: producing, archive, checksum, provenance, workParent: options.workParent });
  const proof = nativeProvenanceVerification(verified), identity = proof.identity;
  nativeReleaseDraftRequest(identity, execution);
  const sourceRoot = resolve(import.meta.dir, "..");
  const parent = realpathSync(options.workParent), parentIdentity = lstatSync(parent, { bigint: true });
  if (parent !== options.workParent || !parentIdentity.isDirectory() || process.getuid === undefined
    || parentIdentity.uid !== BigInt(process.getuid()) || (parentIdentity.mode & 0o7777n) !== 0o700n) refuse();
  const payloads = new Map([[NATIVE_PROCESS_RELEASE_ARCHIVE, archive], ["SHA256SUMS", checksum], [NATIVE_PROCESS_RELEASE_PROVENANCE, provenance]]);
  const assertLocal = (): void => {
    const current = lstatSync(parent, { bigint: true });
    if (realpathSync(parent) !== parent || current.dev !== parentIdentity.dev || current.ino !== parentIdentity.ino
      || current.uid !== parentIdentity.uid || current.mode !== parentIdentity.mode
      || !isDeepStrictEqual(nativeProvenanceVerification(verified), proof)
      || nativeInputHash(Buffer.from(JSON.stringify(nativeProcessSourceInventory(sourceRoot)))) !== identity.coordinate.source.treeSha256) refuse();
  };
  let intentNumber = 0;
  let dispatchAuthority: Awaited<ReturnType<typeof fetchNativeProcessReleaseAuthority>> | undefined;
  const admitDispatch = (): void => {
    assertLocal();
    if (dispatchAuthority === undefined) refuse();
    const pending = dispatchAuthority; dispatchAuthority = undefined;
    nativeProcessReleaseAuthority(pending, execution, producing.tagObjectSha);
  };
  const ports: NativePublicationPorts = {
    authority: async () => {
      assertLocal();
      dispatchAuthority = await fetchNativeProcessReleaseAuthority({ token: options.token, run: execution, tagObjectSha: producing.tagObjectSha });
      assertLocal();
      // Structural readback uses this fixed identity. The one-use live proof
      // remains unconsumed until a mutation's final synchronous dispatch edge.
      return { id: 1343008607, full_name: NATIVE_PROCESS_RELEASE_REPOSITORY, default_branch: "main",
        owner: { id: 307125679 }, private: false, visibility: "public" };
    },
    list: async page => await jsonRequest(options.token, "GET", `/releases?per_page=100&page=${page}`),
    read: async releaseId => await jsonRequest(options.token, "GET", `/releases/${id.parse(releaseId)}`),
    latest: async () => await jsonRequest(options.token, "GET", "/releases/latest"),
    mayCreate: async () => await proveNoPriorNativeReleaseCreation({ token: options.token, run: execution }),
    verifyAssets: async release => {
      for (const asset of release.assets) {
        const expected = identity.assets.find(item => item.name === asset.name); if (expected === undefined) refuse();
        if (nativeInputHash(await download(options.token, asset.id, expected.bytes)) !== expected.sha256) refuse();
      }
    },
    intent: value => {
      assertLocal(); intentNumber += 1; if (intentNumber > 5) refuse();
      const fd = openSync(join(parent, `publication-intent-${intentNumber}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
      try { writeFileSync(fd, JSON.stringify({ formatVersion: 1, identity, execution, intent: value }) + "\n"); fsyncSync(fd); }
      finally { closeSync(fd); }
      const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
    },
    create: async request => { admitDispatch(); await jsonRequest(options.token, "POST", "/releases", request); },
    upload: async (releaseId, name) => {
      const bytes = payloads.get(name); if (bytes === undefined) refuse();
      const body = Uint8Array.from(bytes);
      admitDispatch();
      const response = await fetch(`https://uploads.github.com${prefix}/releases/${id.parse(releaseId)}/assets?name=${encodeURIComponent(name)}`, {
        method: "POST", headers: { ...headers(options.token, "application/vnd.github+json"), "Content-Type": "application/octet-stream" },
        body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(120_000) });
      if (response.status !== 201) { await response.body?.cancel(); refuse(); }
      await readBoundedJsonResponse(response, "NATIVE_RELEASE_UPLOAD_RESPONSE", 128 * 1024);
    },
    publish: async (releaseId, request) => { admitDispatch(); await jsonRequest(options.token, "PATCH", `/releases/${id.parse(releaseId)}`, request); },
  };
  const result = await reconcileNativeReleasePublication(identity, execution, ports);
  admitDispatch();
  return { formatVersion: 1 as const, identity, execution, release: result, provenance: proof };
}

if (import.meta.main) {
  const [archivePath, checksumPath, provenancePath, workParent, ...extra] = process.argv.slice(2);
  if (archivePath === undefined || checksumPath === undefined || provenancePath === undefined || workParent === undefined || extra.length !== 0) refuse();
  const result = await publishNativeProcessRelease({ archivePath: resolve(archivePath), checksumPath: resolve(checksumPath),
    provenancePath: resolve(provenancePath), workParent: resolve(workParent), token: process.env.GITHUB_TOKEN ?? "",
    context: JSON.parse(process.env.NATIVE_PROCESS_RELEASE_CONTEXT ?? "null") as unknown });
  process.stdout.write(JSON.stringify(result) + "\n");
}
