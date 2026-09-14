import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { NATIVE_PACKAGE_NAME, NATIVE_PACKAGE_VERSION, parseNativeArtifactManifest } from "../packages/native-process/src/artifact-model.ts";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { inspectNativeProcessArchive } from "./native-process-archive.ts";
import { inspectQualifiedNativeProcessPackage } from "./native-process-package.ts";
import { nativeInstalledReceiptSchema } from "./native-process-installed-model.ts";
import { nativeQualificationSchema, parseNativeQualification, qualifiedNativeArtifact } from "./native-process-qualification-model.ts";
import { assertLiveReleaseRepository } from "./release-repository-identity.ts";

export const NATIVE_PROCESS_RELEASE_REPOSITORY = "hraness/oompa";
export const NATIVE_PROCESS_RELEASE_TAG = `native-process-v${NATIVE_PACKAGE_VERSION}`;
export const NATIVE_PROCESS_RELEASE_ARCHIVE = `hraness-native-process-${NATIVE_PACKAGE_VERSION}.tgz`;
export const NATIVE_PROCESS_RELEASE_PROVENANCE = "native-process-provenance.json";
export const NATIVE_PROCESS_RELEASE_WORKFLOW = ".github/workflows/native-process-release.yml";
/** This is configured release policy, never a projection of successful jobs. */
export const NATIVE_PROCESS_RELEASE_TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const);
const repositoryId = "1343008607", repositoryOwnerId = "307125679", releaseActorId = "894119";
const workflowRef = `${NATIVE_PROCESS_RELEASE_REPOSITORY}/${NATIVE_PROCESS_RELEASE_WORKFLOW}@refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sha = z.string().regex(/^[a-f0-9]{40}$/u);
const id = z.string().regex(/^[1-9][0-9]{0,19}$/u);
const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const image = z.object({ bytes: positive.max(64 * 1024 * 1024), sha256: digest }).strict();
const runSchema = z.object({ id, attempt: positive, workflowRef: z.literal(workflowRef), sourceSha: sha, workflowSha: sha }).strict();
const contextSchema = z.object({
  repository: z.literal(NATIVE_PROCESS_RELEASE_REPOSITORY), repositoryId: z.literal(repositoryId),
  repositoryOwnerId: z.literal(repositoryOwnerId), actorId: z.literal(releaseActorId),
  senderId: z.literal(releaseActorId), senderType: z.literal("User"), eventName: z.literal("push"),
  ref: z.literal(`refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`), refName: z.literal(NATIVE_PROCESS_RELEASE_TAG), refType: z.literal("tag"),
  workflowRef: z.literal(workflowRef), runId: id, runAttempt: positive, sourceSha: sha, workflowSha: sha,
}).strict();
export type NativeProcessReleaseRun = z.infer<typeof runSchema>;
export function nativeProcessReleaseRun(value: unknown): NativeProcessReleaseRun {
  const context = contextSchema.parse(value);
  return { id: context.runId, attempt: context.runAttempt, workflowRef: context.workflowRef,
    sourceSha: context.sourceSha, workflowSha: context.workflowSha };
}
export const nativeReleaseCoordinateSchema = z.object({
  source: nativeQualificationSchema.shape.source, tagObjectSha: sha, archive: image, manifestSha256: digest, run: runSchema,
}).strict().superRefine((value, context) => {
  if (value.run.sourceSha !== value.source.commitSha || value.run.workflowSha !== value.source.commitSha) {
    context.addIssue({ code: "custom", message: "Native release workflow and source commits disagree." });
  }
});
export type NativeReleaseCoordinate = z.infer<typeof nativeReleaseCoordinateSchema>;
const bytesJson = (bytes: Uint8Array, maximum: number): unknown => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximum) refuse();
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
};
function refuse(): never { throw Error("NATIVE_PROCESS_RELEASE_POLICY_INVALID"); }
function exactTargets(targets: readonly string[]): void {
  if (!isDeepStrictEqual(targets, NATIVE_PROCESS_RELEASE_TARGETS)) refuse();
}

/** These checks join already authenticated job outputs. JSON agreement itself
 * supplies no GitHub workload, source-review, execution or publication authority. */
export function admitNativeReleaseEvidence(input: Readonly<{
  coordinate: unknown; manifestBytes: Uint8Array; prepackBytes: readonly Uint8Array[]; installedReceipts: readonly unknown[];
}>) {
  const coordinate = nativeReleaseCoordinateSchema.parse(input.coordinate);
  const manifest = parseNativeArtifactManifest(bytesJson(input.manifestBytes, 256 * 1024));
  if (nativeInputHash(input.manifestBytes) !== coordinate.manifestSha256
    || input.prepackBytes.length !== 4 || input.installedReceipts.length !== 4) refuse();
  if (!isDeepStrictEqual(manifest.source, coordinate.source)) refuse();
  exactTargets(manifest.artifacts.map(artifact => artifact.target));
  const prepack = input.prepackBytes.map(bytes => ({ bytes, value: parseNativeQualification(bytesJson(bytes, 256 * 1024), coordinate.source) }));
  const installed = input.installedReceipts.map(value => nativeInstalledReceiptSchema.parse(value));
  exactTargets(prepack.map(item => item.value.target).sort());
  exactTargets(installed.map(item => item.target).sort());
  const common = installed[0];
  if (common === undefined) refuse();
  const evidence = NATIVE_PROCESS_RELEASE_TARGETS.map(target => {
    const qualified = prepack.find(item => item.value.target === target);
    const accepted = installed.find(item => item.target === target);
    const artifact = manifest.artifacts.find(item => item.target === target);
    if (qualified === undefined || accepted === undefined || artifact === undefined) refuse();
    const prepackSha256 = nativeInputHash(qualified.bytes);
    if (!isDeepStrictEqual(qualifiedNativeArtifact(qualified.value, prepackSha256), artifact)
      || accepted.prepackSha256 !== prepackSha256 || accepted.archiveSha256 !== coordinate.archive.sha256
      || accepted.manifestSha256 !== coordinate.manifestSha256 || accepted.rustTarget !== artifact.rustTarget
      || !isDeepStrictEqual(accepted.source, coordinate.source)
      || !isDeepStrictEqual(accepted.artifact, qualified.value.artifact)
      || !isDeepStrictEqual(accepted.harnesses, qualified.value.harnesses)
      || accepted.installation.clientInventorySha256 !== nativeInputHash(Buffer.from(JSON.stringify(manifest.client)))
      || accepted.verifierSha256 !== common.verifierSha256 || accepted.workerSha256 !== common.workerSha256
      || !isDeepStrictEqual(accepted.dependency, common.dependency)) refuse();
    return { target, prepackSha256, installedSha256: nativeInputHash(Buffer.from(JSON.stringify(accepted))), installed: accepted };
  });
  return { formatVersion: 1 as const, package: NATIVE_PACKAGE_NAME, version: NATIVE_PACKAGE_VERSION,
    tag: NATIVE_PROCESS_RELEASE_TAG, coordinate, targets: NATIVE_PROCESS_RELEASE_TARGETS, evidence };
}
export type NativeReleaseEvidence = ReturnType<typeof admitNativeReleaseEvidence>;

const assetNames = [NATIVE_PROCESS_RELEASE_ARCHIVE, "SHA256SUMS", NATIVE_PROCESS_RELEASE_PROVENANCE] as const;
const assetSchema = z.object({ name: z.enum(assetNames), bytes: positive.max(64 * 1024 * 1024), sha256: digest }).strict();
const identitySchema = z.object({ coordinate: nativeReleaseCoordinateSchema, assets: z.array(assetSchema).length(3) }).strict()
  .superRefine((value, context) => {
    const [archive, checksum, provenance] = value.assets;
    if (archive === undefined || checksum === undefined || provenance === undefined
      || !isDeepStrictEqual(value.assets.map(asset => asset.name), assetNames)
      || archive.bytes !== value.coordinate.archive.bytes || archive.sha256 !== value.coordinate.archive.sha256
      || checksum.bytes > 4096 || provenance.bytes > 256 * 1024) {
      context.addIssue({ code: "custom", message: "Native release asset inventory mismatch." });
    }
  });
export type NativeReleaseIdentity = z.infer<typeof identitySchema>;
const evidenceSchema = z.object({ formatVersion: z.literal(1), package: z.literal(NATIVE_PACKAGE_NAME), version: z.literal(NATIVE_PACKAGE_VERSION),
  tag: z.literal(NATIVE_PROCESS_RELEASE_TAG), coordinate: nativeReleaseCoordinateSchema,
  targets: z.array(z.string().max(32)).length(4), evidence: z.array(z.object({ target: z.string().max(32), prepackSha256: digest,
    installedSha256: digest, installed: nativeInstalledReceiptSchema }).strict()).length(4),
}).strict();
/** Structural parsing only. The publisher must independently verify the opaque
 * Sigstore bundle's signature, certificate and exact qualification predicate
 * under this repository/workflow/tag/source/run/attempt before any mutation. */
export function parseNativeReleaseProvenance(bytes: Uint8Array) {
  return z.object({ formatVersion: z.literal(1), qualification: evidenceSchema,
    bundle: z.record(z.string(), z.unknown()),
  }).strict().parse(bytesJson(bytes, 256 * 1024));
}
export function nativeProcessReleaseIdentity(coordinate: unknown, archive: Uint8Array, checksum: Uint8Array, provenance: Uint8Array): NativeReleaseIdentity {
  const parsed = nativeReleaseCoordinateSchema.parse(coordinate);
  if (archive.byteLength !== parsed.archive.bytes || checksum.byteLength > 4096 || provenance.byteLength > 256 * 1024
    || nativeInputHash(archive) !== parsed.archive.sha256
    || new TextDecoder("utf-8", { fatal: true }).decode(checksum) !== `${parsed.archive.sha256}  ${NATIVE_PROCESS_RELEASE_ARCHIVE}\n`) refuse();
  // Re-admit the complete qualification; an adjacent bundle is not, by its
  // presence alone, authenticated provenance. Cryptographic admission is outer.
  const body = parseNativeReleaseProvenance(provenance).qualification;
  inspectQualifiedNativeProcessPackage(archive);
  const members = new Map(inspectNativeProcessArchive(archive).map(file => [file.path, file.bytes]));
  const manifestBytes = members.get("package/native-artifacts/manifest.json");
  if (manifestBytes === undefined) refuse();
  const checked = admitNativeReleaseEvidence({ coordinate: parsed, manifestBytes,
    prepackBytes: [...members].filter(([path]) => path.startsWith("package/native-artifacts/qualifications/")).map(([, bytes]) => bytes),
    installedReceipts: body.evidence.map(item => item.installed) });
  if (!isDeepStrictEqual(body, checked)) refuse();
  return identitySchema.parse({ coordinate: parsed, assets: [archive, checksum, provenance].map((bytes, index) =>
    ({ name: assetNames[index], bytes: bytes.byteLength, sha256: nativeInputHash(bytes) })) });
}

const prefix = "<!-- hraness-native-process-release:v1\n", suffix = "\n-->";
function executionRun(input: NativeReleaseIdentity, value: unknown): NativeProcessReleaseRun {
  const producing = input.coordinate.run;
  const execution = runSchema.parse(value === undefined ? producing : value);
  if (execution.id !== producing.id || execution.sourceSha !== producing.sourceSha || execution.workflowSha !== producing.workflowSha
    || execution.attempt < producing.attempt) refuse();
  return execution;
}
function body(input: NativeReleaseIdentity, createdAttempt: number, publishedAttempt: number | null): string {
  const { run, ...coordinate } = input.coordinate;
  return prefix + JSON.stringify({ formatVersion: 1, package: NATIVE_PACKAGE_NAME, version: NATIVE_PACKAGE_VERSION,
    repository: NATIVE_PROCESS_RELEASE_REPOSITORY, repositoryId, repositoryOwnerId, tag: NATIVE_PROCESS_RELEASE_TAG,
    ...coordinate, run: { id: run.id, workflowRef: run.workflowRef, sourceSha: run.sourceSha, workflowSha: run.workflowSha }, targets: NATIVE_PROCESS_RELEASE_TARGETS,
    assets: input.assets, producingAttempt: run.attempt, createdAttempt, publishedAttempt }) + suffix;
}
export function nativeReleaseBody(value: unknown, createdAttempt?: number, published = false, currentRun?: unknown): string {
  const input = identitySchema.parse(value), execution = executionRun(input, currentRun), created = createdAttempt ?? execution.attempt;
  if (!Number.isSafeInteger(created) || created < input.coordinate.run.attempt || created > execution.attempt) refuse();
  return body(input, created, published ? execution.attempt : null);
}
function parseBody(value: unknown, input: NativeReleaseIdentity, state: "draft" | "published", execution: NativeProcessReleaseRun) {
  if (typeof value !== "string" || Buffer.byteLength(value) > 16 * 1024 || !value.startsWith(prefix) || !value.endsWith(suffix)) refuse();
  const parsed = bytesJson(Buffer.from(value.slice(prefix.length, -suffix.length)), 16 * 1024);
  const attempts = z.object({ createdAttempt: positive, publishedAttempt: positive.nullable() }).parse(parsed);
  if (attempts.createdAttempt < input.coordinate.run.attempt || attempts.createdAttempt > execution.attempt
    || (state === "draft" ? attempts.publishedAttempt !== null : attempts.publishedAttempt === null
      || attempts.publishedAttempt < attempts.createdAttempt || attempts.publishedAttempt > execution.attempt)
    || value !== body(input, attempts.createdAttempt, attempts.publishedAttempt)) refuse();
  return attempts;
}
export function nativeReleaseDraftRequest(value: unknown, currentRun?: unknown) {
  const input = identitySchema.parse(value);
  return { tag_name: NATIVE_PROCESS_RELEASE_TAG, target_commitish: input.coordinate.source.commitSha, name: NATIVE_PROCESS_RELEASE_TAG,
    body: nativeReleaseBody(input, undefined, false, currentRun), draft: true as const, prerelease: false as const, make_latest: "false" as const };
}
export function nativeReleasePublishRequest(value: unknown, createdAttempt: number, currentRun?: unknown) {
  return { body: nativeReleaseBody(value, createdAttempt, true, currentRun), draft: false as const, prerelease: false as const, make_latest: "false" as const };
}

const releaseAssetSchema = z.object({ id: positive, name: z.string().min(1).max(128), state: z.literal("uploaded"),
  size: positive.max(64 * 1024 * 1024), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  browser_download_url: z.string().max(512), url: z.string().max(512),
});
const releaseSchema = z.object({ id: positive, tag_name: z.literal(NATIVE_PROCESS_RELEASE_TAG),
  name: z.literal(NATIVE_PROCESS_RELEASE_TAG), target_commitish: sha, draft: z.boolean(), prerelease: z.literal(false),
  author: z.object({ id: z.literal(41898282), type: z.literal("Bot") }),
  immutable: z.boolean(), body: z.string().max(16 * 1024), url: z.string().max(512), html_url: z.string().max(512),
  assets: z.array(releaseAssetSchema).max(3),
});
export type NativeReleaseReadback = Readonly<{ id: number; createdAttempt: number; publishedAttempt: number | null;
  assets: readonly Readonly<{ id: number; name: string; size: number; digest: string; browser_download_url: string; url: string }>[] }>;
/** Drafts can contain a strict subset while upload progresses. No caller may
 * replace a name or reinterpret an inexact existing release as an empty one. */
export function admitNativeReleaseReadback(repository: unknown, value: unknown, identity: unknown,
  state: "draft" | "published", previous?: NativeReleaseReadback, currentRun?: unknown): NativeReleaseReadback {
  assertLiveReleaseRepository(repository);
  const input = identitySchema.parse(identity), release = releaseSchema.parse(value), execution = executionRun(input, currentRun);
  const tagUrlPrefix = `https://github.com/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/tag/`;
  const admittedReleaseUrl = release.html_url === `${tagUrlPrefix}${NATIVE_PROCESS_RELEASE_TAG}`
    || (state === "draft" && release.html_url.startsWith(tagUrlPrefix)
      && /^untagged-[0-9a-f]{20}$/u.test(release.html_url.slice(tagUrlPrefix.length)));
  if (release.target_commitish !== input.coordinate.source.commitSha || release.draft !== (state === "draft")
    || release.immutable !== (state === "published") || release.url !== `https://api.github.com/repos/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/${release.id}`
    || !admittedReleaseUrl
    || (state === "published" && release.assets.length !== 3) || (previous !== undefined && previous.id !== release.id)) refuse();
  const attempts = parseBody(release.body, input, state, execution), names = new Set<string>(), ids = new Set<number>();
  if (previous !== undefined && (attempts.createdAttempt !== previous.createdAttempt
    || (previous.publishedAttempt !== null && attempts.publishedAttempt !== previous.publishedAttempt))) refuse();
  for (const asset of release.assets) {
    const expected = input.assets.find(item => item.name === asset.name);
    const downloadPrefix = `https://github.com/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/download/`;
    const temporary = asset.browser_download_url.startsWith(downloadPrefix)
      ? /^untagged-[0-9a-f]{20}\/([^/]+)$/u.exec(asset.browser_download_url.slice(downloadPrefix.length)) : null;
    const admittedDownload = asset.browser_download_url === `${downloadPrefix}${NATIVE_PROCESS_RELEASE_TAG}/${asset.name}`
      || (state === "draft" && temporary?.[1] === asset.name);
    if (expected === undefined || names.has(asset.name) || ids.has(asset.id) || asset.size !== expected.bytes
      || asset.digest !== `sha256:${expected.sha256}`
      || asset.url !== `https://api.github.com/repos/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/assets/${asset.id}`
      || !admittedDownload) refuse();
    names.add(asset.name); ids.add(asset.id);
  }
  for (const prior of previous?.assets ?? []) {
    const current = release.assets.find(asset => asset.name === prior.name);
    if (current === undefined || current.id !== prior.id || current.size !== prior.size || current.digest !== prior.digest) refuse();
  }
  return { id: release.id, ...attempts, assets: release.assets };
}
/** A legitimate concurrent CLI release may advance Latest. The package never
 * supplies a new Latest selection and must not appear there in readback. */
export function assertNativeReleaseNotLatest(value: unknown, release: NativeReleaseReadback): void {
  const latest = z.object({ id: positive, tag_name: z.string().regex(/^v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u).max(64),
    draft: z.literal(false), prerelease: z.literal(false), immutable: z.literal(true), html_url: z.string().max(512),
  }).parse(value);
  if (latest.id === release.id || latest.html_url !== `https://github.com/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/tag/${latest.tag_name}`) refuse();
}
