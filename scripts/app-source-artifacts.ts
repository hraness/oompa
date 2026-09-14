import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { parseAppPublication, parseAppSourceMarkerEvidence, readAppInventory, readAppOrdinary } from "./build-app";
import { APP_SOURCE_MARKER_PATH, createAppSourceMarker } from "./app-source-marker";
import { canonicalDigest } from "./release-evidence";
import type { AuthorityFetcher } from "./bounded-authority-fetch";
import appConfiguration from "../app/vercel.json";

const origin = "https://app.oompa.app";
const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const appArtifactMaximumFiles = 64;
export const appArtifactMaximumBytes = 8 * 1024 * 1024;
export const appArtifactMaximumTotalBytes = 32 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const version = z.string().max(64).regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u);
const securityHeaderNames = ["content-security-policy", "cross-origin-opener-policy", "permissions-policy", "referrer-policy", "x-content-type-options", "x-frame-options", "x-robots-tag"];
const securityHeaders = appConfiguration.headers.find((entry) => entry.source === "/(.*)")?.headers
  .map((header) => [header.key.toLowerCase(), header.value] as const) ?? [];
if (securityHeaders.length !== securityHeaderNames.length
  || securityHeaders.map(([name]) => name).sort().some((name, index) => name !== [...securityHeaderNames].sort()[index])) {
  throw new Error("app_source_header_contract_invalid");
}
export const appArtifactSecurityHeadersDigest = canonicalDigest(securityHeaders);
export const hasAppArtifactSecurityHeaders = (response: Response): boolean =>
  securityHeaders.every(([name, value]) => response.headers.get(name) === value);
const artifactPath = z.string().max(240).regex(/^(?:index\.html|stylex\.css|\.well-known\/oompa-app\.json|graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/u);
export const appSourceArtifactSchema = z.strictObject({ path: artifactPath,
  bytes: z.number().int().positive().max(appArtifactMaximumBytes), sha256: digest });
export const appSourceArtifactInventorySchema = z.array(appSourceArtifactSchema).min(6).max(appArtifactMaximumFiles)
  .superRefine((items, context) => {
    const paths = items.map((item) => item.path);
    if (new Set(paths).size !== paths.length || paths.some((path, index) => path !== [...paths].sort()[index])
      || items.reduce((total, item) => total + item.bytes, 0) > appArtifactMaximumTotalBytes
      || items.reduce((total, item) => total + item.bytes, 0) + (items.find((item) => item.path === "index.html")?.bytes ?? 0) > appArtifactMaximumTotalBytes
      || paths.filter((path) => path === "index.html").length !== 1
      || paths.filter((path) => path === "stylex.css").length !== 1
      || paths.filter((path) => path === APP_SOURCE_MARKER_PATH).length !== 1
      || paths.filter((path) => path.endsWith(".css")).length !== 2
      || paths.filter((path) => /^graphs\/client\/assets\/appearance-[A-Za-z0-9_-]+\.js$/u.test(path)).length !== 1
      || paths.filter((path) => path.endsWith(".js")).length < 2) {
      context.addIssue({ code: "custom", message: "app_artifact_inventory_invalid" });
    }
  });

export const appLocalArtifactProofSchema = z.strictObject({
  kind: z.literal("oompa-local-production-app-artifacts"), sourceCommit: commit, releaseVersion: version,
  runtimeVersion: z.literal("1.3.14"), packageSha256: digest, lockSha256: digest, publicationSha256: digest,
  artifacts: appSourceArtifactInventorySchema,
}).superRefine((value, context) => {
  const marker = Buffer.from(createAppSourceMarker({ version: value.releaseVersion }, { OOMPA_RELEASE_COMMIT: value.sourceCommit }));
  const expected = value.artifacts.find((item) => item.path === APP_SOURCE_MARKER_PATH);
  if (expected?.bytes !== marker.byteLength || expected.sha256 !== sha256(marker)) {
    context.addIssue({ code: "custom", message: "app_artifact_marker_invalid" });
  }
});
export type AppLocalArtifactProof = z.infer<typeof appLocalArtifactProofSchema>;
export type AppSourceArtifact = z.infer<typeof appSourceArtifactSchema>;
export const appPublicArtifactProofSchema = z.strictObject({
  local: appLocalArtifactProofSchema, artifactManifestDigest: digest, artifactCount: z.number().int().min(6).max(appArtifactMaximumFiles),
  artifactBytes: z.number().int().positive().max(appArtifactMaximumTotalBytes),
  observedPublicBytes: z.number().int().positive().max(appArtifactMaximumTotalBytes),
  canonicalEntryMatches: z.literal(true), completeLocalManifestMatches: z.literal(true),
  scope: z.literal("canonical-entry-and-complete-local-static-publication"),
  unlistedRemoteFilesObserved: z.literal(false),
  securityHeadersDigest: z.literal(appArtifactSecurityHeadersDigest),
}).superRefine((value, context) => {
  if (value.artifactManifestDigest !== canonicalDigest(value.local.artifacts)
    || value.artifactCount !== value.local.artifacts.length
    || value.artifactBytes !== value.local.artifacts.reduce((sum, item) => sum + item.bytes, 0)
    || value.observedPublicBytes !== value.artifactBytes + (value.local.artifacts.find((item) => item.path === "index.html")?.bytes ?? 0)) {
    context.addIssue({ code: "custom", message: "app_public_artifact_proof_invalid" });
  }
});
export type AppPublicArtifactProof = z.infer<typeof appPublicArtifactProofSchema>;
export class AppSourceArtifactError extends Error {
  constructor() { super("app_source_artifacts_invalid"); this.name = "AppSourceArtifactError"; }
}
const requireArtifact = (condition: boolean): void => { if (!condition) throw new AppSourceArtifactError(); };
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Fixed layout only. The hardened launcher owns the preceding fresh, joined
 * production build; this read joins its publication record to every named byte.
 * Reused local readers retain the builder's existing 4096-file/64MiB-file/
 * 256MiB census bounds. The smaller limits above constrain admitted manifests
 * and public response bodies, not a stronger local preallocation guarantee.
 * No caller-supplied directory, manifest, URL or build command enters this path. */
export async function readLocalAppArtifactProof(expected: Readonly<{ sourceCommit: string; releaseVersion: string }>): Promise<AppLocalArtifactProof> {
  try {
    const { sourceCommit, releaseVersion } = expected;
    requireArtifact(process.cwd() === repositoryRoot && await realpath(repositoryRoot) === repositoryRoot);
    const publicationPath = join(repositoryRoot, "tmp", "build-app", "current.json");
    const publicationMetadata = await lstat(publicationPath);
    requireArtifact(await realpath(publicationPath) === publicationPath && (publicationMetadata.mode & 0o777) === 0o600);
    const publicationBytes = await readAppOrdinary(publicationPath);
    const publication: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(publicationBytes));
    const artifacts = appSourceArtifactInventorySchema.parse(parseAppPublication(publication));
    const parsed = z.object({ sourceMarker: z.unknown() }).parse(publication);
    const marker = parseAppSourceMarkerEvidence(parsed.sourceMarker);
    requireArtifact(marker.marker.source.commit === sourceCommit && marker.marker.version === releaseVersion);
    requireArtifact(marker.environment.OOMPA_RELEASE_COMMIT === sourceCommit
      && marker.environment.VERCEL === null && marker.environment.VERCEL_GIT_COMMIT_SHA === null);
    const packageBytes = await readAppOrdinary(join(repositoryRoot, "package.json"));
    requireArtifact(marker.packageArtifact.bytes === packageBytes.byteLength && marker.packageArtifact.sha256 === sha256(packageBytes));
    const packageManifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packageBytes));
    requireArtifact(z.object({ version: z.literal(releaseVersion) }).safeParse(packageManifest).success);
    const inventory = appSourceArtifactInventorySchema.parse(await readAppInventory(join(repositoryRoot, "app", "dist")));
    requireArtifact(canonicalDigest(inventory) === canonicalDigest(artifacts));
    const lock = await readAppOrdinary(join(repositoryRoot, "bun.lock"));
    requireArtifact(sha256(await readAppOrdinary(publicationPath)) === sha256(publicationBytes));
    return appLocalArtifactProofSchema.parse({ kind: "oompa-local-production-app-artifacts", sourceCommit, releaseVersion,
      runtimeVersion: Bun.version, packageSha256: sha256(packageBytes), lockSha256: sha256(lock),
      publicationSha256: sha256(publicationBytes), artifacts });
  } catch { throw new AppSourceArtifactError(); }
}

const mimeFor = (path: string): string => path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "(?:text|application)/javascript";
async function readArtifact(fetcher: AuthorityFetcher, path: string, expected: AppSourceArtifact, nonce: string): Promise<void> {
  const url = new URL(path, origin);
  url.searchParams.set("proof", nonce);
  const response = await fetcher(url.href, { method: "GET", redirect: "error", cache: "no-store",
    headers: { "cache-control": "no-cache", accept: path === "/" || path.endsWith(".html") ? "text/html" : "*/*" } });
  const reader = response.body?.getReader();
  try {
    requireArtifact(response.status === 200 && response.url === url.href && !response.redirected && reader !== undefined);
    requireArtifact(new RegExp(`^${mimeFor(expected.path)}(?:\\s*;|$)`, "u").test(response.headers.get("content-type")?.toLowerCase() ?? ""));
    requireArtifact(hasAppArtifactSecurityHeaders(response));
    if (expected.path === "index.html") {
      requireArtifact(response.headers.get("cache-control")?.split(",").some((part) => part.trim().toLowerCase() === "no-store") === true);
    }
    let count = 0;
    const digest = createHash("sha256");
    while (reader !== undefined) {
      const value = await reader.read();
      if (value.done) break;
      requireArtifact(value.value instanceof Uint8Array && value.value.byteLength <= expected.bytes - count);
      count += value.value.byteLength;
      digest.update(value.value);
    }
    requireArtifact(count === expected.bytes && digest.digest("hex") === expected.sha256);
  } catch {
    await reader?.cancel().catch(() => undefined);
    throw new AppSourceArtifactError();
  } finally { reader?.releaseLock(); }
}

/** The existing marker request supplies its actual bounded byte digest; every
 * other manifest path and the canonical / entry are read here without auth. */
export async function observePublicAppArtifacts(input: Readonly<{
  local: AppLocalArtifactProof; marker: AppSourceArtifact; nonce: string; fetcher: AuthorityFetcher;
}>): Promise<AppPublicArtifactProof> {
  try {
    const local = appLocalArtifactProofSchema.parse(input.local);
    requireArtifact(z.string().uuid({ version: "v4" }).safeParse(input.nonce).success);
    const marker = appSourceArtifactSchema.parse(input.marker);
    const expectedMarker = local.artifacts.find((item) => item.path === APP_SOURCE_MARKER_PATH);
    requireArtifact(marker.path === APP_SOURCE_MARKER_PATH && canonicalDigest(marker) === canonicalDigest(expectedMarker));
    for (const item of local.artifacts) {
      if (item.path !== APP_SOURCE_MARKER_PATH) await readArtifact(input.fetcher, `/${item.path}`, item, input.nonce);
    }
    const entry = local.artifacts.find((item) => item.path === "index.html");
    requireArtifact(entry !== undefined);
    if (entry !== undefined) await readArtifact(input.fetcher, "/", entry, input.nonce);
    return appPublicArtifactProofSchema.parse({ local, artifactManifestDigest: canonicalDigest(local.artifacts),
      artifactCount: local.artifacts.length, artifactBytes: local.artifacts.reduce((sum, item) => sum + item.bytes, 0),
      observedPublicBytes: local.artifacts.reduce((sum, item) => sum + item.bytes, 0) + (entry?.bytes ?? 0),
      canonicalEntryMatches: true, completeLocalManifestMatches: true,
      securityHeadersDigest: appArtifactSecurityHeadersDigest,
      scope: "canonical-entry-and-complete-local-static-publication", unlistedRemoteFilesObserved: false });
  } catch { throw new AppSourceArtifactError(); }
}
