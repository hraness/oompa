import { createHash } from "node:crypto";
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { inspectNativeProcessArchive } from "./native-process-archive.ts";
import { nativeBuildInput, nativeInputHash, nativeProcessSourceInventory, type NativeSourceInput } from "./native-process-build-inputs.ts";
import { nativeInstalledReceiptSchema } from "./native-process-installed-model.ts";
import { inspectQualifiedNativeProcessPackage } from "./native-process-package.ts";
import { assertNativeProvenanceStatement } from "./native-process-provenance-crypto.mjs";
import { admitNativeReleaseEvidence, nativeProcessReleaseIdentity, nativeProcessReleaseRun, nativeReleaseCoordinateSchema,
  NATIVE_PROCESS_RELEASE_ARCHIVE, NATIVE_PROCESS_RELEASE_PROVENANCE, NATIVE_PROCESS_RELEASE_TAG,
  NATIVE_PROCESS_RELEASE_TARGETS, type NativeReleaseCoordinate } from "./native-process-release-policy.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const expectedSchema = z.object({ archiveSha256: digest, manifestSha256: digest,
  tagObjectSha: z.string().regex(/^[a-f0-9]{40}$/u), installedSha256: z.object({
    "darwin-arm64": digest, "darwin-x64": digest, "linux-arm64": digest, "linux-x64": digest,
  }).strict(),
}).strict();
const receiptsSchema = z.object({ "darwin-arm64": z.instanceof(Uint8Array), "darwin-x64": z.instanceof(Uint8Array),
  "linux-arm64": z.instanceof(Uint8Array), "linux-x64": z.instanceof(Uint8Array) }).strict();
export const NATIVE_INSTALLED_RECEIPT_NAME = "installed-qualification.json";
const encoded = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
function refuse(): never { throw Error("NATIVE_PROCESS_RELEASE_EVIDENCE_INVALID"); }
function bounded(bytes: Uint8Array, maximum: number): Buffer {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > maximum) refuse();
  return Buffer.from(bytes);
}
function json(bytes: Uint8Array, maximum = 256 * 1024): unknown {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bounded(bytes, maximum))) as unknown;
}

/** Content-address the actual annotated Git tag bytes. The parent separately
 * proves the governed ref, reviewed checkout and authorized tag-push event. */
export function nativeReleaseTagObject(bytes: Uint8Array, expectedSha: string, commit: string): void {
  if (!/^[a-f0-9]{40}$/u.test(expectedSha) || !/^[a-f0-9]{40}$/u.test(commit)) refuse();
  const body = bounded(bytes, 64 * 1024), text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  if (text.includes("\0")) refuse();
  const end = text.indexOf("\n\n"), headers = text.slice(0, end).split("\n");
  if (end < 0 || headers.length !== 4 || headers[0] !== `object ${commit}` || headers[1] !== "type commit"
    || headers[2] !== `tag ${NATIVE_PROCESS_RELEASE_TAG}`
    || !/^tagger [^\p{Cc}\p{Cf}]{1,1024}$/u.test(headers[3] ?? "")) refuse();
  const hash = createHash("sha1").update(Buffer.from(`tag ${body.length}\0`)).update(body).digest("hex");
  if (hash !== expectedSha) refuse();
}
function assertSource(source: NativeReleaseCoordinate["source"], inputs: readonly NativeSourceInput[]): void {
  if (inputs.length < 3 || inputs.length > 256 || new Set(inputs.map(file => file.path)).size !== inputs.length
    || !isDeepStrictEqual(inputs.map(file => file.path), inputs.map(file => file.path).sort())
    || nativeInputHash(Buffer.from(JSON.stringify(inputs))) !== source.treeSha256) refuse();
  for (const [path, expected] of [["bun.lock", source.bunLockSha256], ["native/process-kernel/Cargo.lock", source.cargoLockSha256],
    ["native/process-kernel/rust-toolchain.toml", source.toolchainSha256]] as const) {
    if (inputs.find(file => file.path === path)?.sha256 !== expected) refuse();
  }
}
function archiveInputs(archive: Uint8Array, checksum: Uint8Array, expectedArchive: string, expectedManifest: string) {
  const bytes = bounded(archive, 64 * 1024 * 1024), sums = bounded(checksum, 4096);
  if (nativeInputHash(bytes) !== expectedArchive
    || sums.toString("utf8") !== `${expectedArchive}  ${NATIVE_PROCESS_RELEASE_ARCHIVE}\n`) refuse();
  const manifest = inspectQualifiedNativeProcessPackage(bytes);
  const members = new Map(inspectNativeProcessArchive(bytes).map(file => [file.path, file.bytes]));
  const manifestBytes = members.get("package/native-artifacts/manifest.json");
  if (manifestBytes === undefined || nativeInputHash(manifestBytes) !== expectedManifest) refuse();
  const prepackBytes = manifest.artifacts.map(artifact => {
    const receipt = members.get("package/native-artifacts/qualifications/" + artifact.rustTarget + ".json");
    if (receipt === undefined) refuse(); return receipt;
  });
  return { bytes, manifest, manifestBytes, prepackBytes };
}

/** Join exact authenticated workflow outputs. These pure shape/hash checks
 * neither authenticate job metadata nor manufacture native execution evidence. */
export function prepareNativeProcessReleaseEvidence(input: Readonly<{
  archive: Uint8Array; checksum: Uint8Array; tagObject: Uint8Array;
  receipts: unknown; expected: unknown; context: unknown;
  currentSources: readonly NativeSourceInput[];
}>) {
  const expected = expectedSchema.parse(input.expected), run = nativeProcessReleaseRun(input.context);
  nativeReleaseTagObject(input.tagObject, expected.tagObjectSha, run.sourceSha);
  const archive = archiveInputs(input.archive, input.checksum, expected.archiveSha256, expected.manifestSha256);
  assertSource(archive.manifest.source, input.currentSources);
  const receipts = receiptsSchema.parse(input.receipts);
  const installedReceipts = NATIVE_PROCESS_RELEASE_TARGETS.map(target => {
    const bytes = bounded(receipts[target], 256 * 1024);
    if (nativeInputHash(bytes) !== expected.installedSha256[target]) refuse();
    const receipt = nativeInstalledReceiptSchema.parse(json(bytes));
    if (receipt.target !== target) refuse();
    return receipt;
  });
  const coordinate = nativeReleaseCoordinateSchema.parse({ source: archive.manifest.source, tagObjectSha: expected.tagObjectSha,
    archive: { bytes: archive.bytes.length, sha256: expected.archiveSha256 }, manifestSha256: expected.manifestSha256, run });
  const qualification = admitNativeReleaseEvidence({ coordinate, manifestBytes: archive.manifestBytes,
    prepackBytes: archive.prepackBytes, installedReceipts });
  const predicateBytes = encoded(qualification), coordinateBytes = encoded(coordinate);
  if (predicateBytes.length > 256 * 1024 || coordinateBytes.length > 16 * 1024) refuse();
  return { predicateBytes, coordinateBytes, predicateSha256: nativeInputHash(predicateBytes), coordinateSha256: nativeInputHash(coordinateBytes) };
}

/** Wrap the exact predicate and bundle returned by actions/attest. Statement
 * inspection is structural only; the publisher must call the crypto verifier. */
export function combineNativeProcessReleaseEvidence(input: Readonly<{
  archive: Uint8Array; checksum: Uint8Array; predicate: Uint8Array; coordinate: Uint8Array; bundle: Uint8Array;
  predicateSha256: string; coordinateSha256: string; currentSources: readonly NativeSourceInput[];
}>) {
  digest.parse(input.predicateSha256); digest.parse(input.coordinateSha256);
  const predicate = bounded(input.predicate, 256 * 1024), coordinateBytes = bounded(input.coordinate, 16 * 1024);
  if (nativeInputHash(predicate) !== input.predicateSha256 || nativeInputHash(coordinateBytes) !== input.coordinateSha256) refuse();
  const coordinate = nativeReleaseCoordinateSchema.parse(json(coordinateBytes, 16 * 1024));
  assertSource(coordinate.source, input.currentSources);
  const qualification = json(predicate), bundle = json(input.bundle);
  const provenanceBytes = encoded({ formatVersion: 1, qualification, bundle });
  if (provenanceBytes.length > 256 * 1024) refuse();
  const identity = nativeProcessReleaseIdentity(coordinate, bounded(input.archive, 64 * 1024 * 1024), bounded(input.checksum, 4096), provenanceBytes);
  assertNativeProvenanceStatement(bundle, qualification,
    identity.assets.slice(0, 2).map(asset => ({ name: asset.name, digest: { sha256: asset.sha256 } })));
  return { provenanceBytes, provenanceSha256: nativeInputHash(provenanceBytes) };
}

export function nativeReleaseEvidenceEnvironment(environment: Readonly<Record<string, string | undefined>>) {
  const contextText = environment.NATIVE_PROCESS_RELEASE_CONTEXT;
  if (contextText === undefined || Buffer.byteLength(contextText) > 4096) refuse();
  const context = json(Buffer.from(contextText), 4096);
  nativeProcessReleaseRun(context);
  return { context, expected: expectedSchema.parse({ archiveSha256: environment.NATIVE_PROCESS_ARCHIVE_SHA256,
    manifestSha256: environment.NATIVE_PROCESS_MANIFEST_SHA256, tagObjectSha: environment.NATIVE_PROCESS_TAG_OBJECT_SHA,
    installedSha256: Object.fromEntries(NATIVE_PROCESS_RELEASE_TARGETS.map(target =>
      [target, environment["NATIVE_PROCESS_INSTALLED_" + target.toUpperCase().replaceAll("-", "_") + "_SHA256"]])),
  }) };
}
function privateOutput(path: string): void {
  if (resolve(path) !== path || realpathSync(dirname(path)) !== dirname(path)) refuse();
  const parent = lstatSync(dirname(path), { bigint: true });
  if (process.getuid === undefined || !parent.isDirectory() || parent.uid !== BigInt(process.getuid())
    || (parent.mode & 0o7777n) !== 0o700n) refuse();
  for (let ancestor = dirname(path);; ancestor = dirname(ancestor)) {
    const metadata = lstatSync(ancestor, { bigint: true });
    if (!metadata.isDirectory() || realpathSync(ancestor) !== ancestor || (metadata.uid !== 0n && metadata.uid !== BigInt(process.getuid()))
      || ((metadata.mode & 0o022n) !== 0n && !(metadata.uid === 0n && (metadata.mode & 0o1000n) !== 0n))) refuse();
    if (dirname(ancestor) === ancestor) break;
  }
  mkdirSync(path, { mode: 0o700 });
}
function writeOutput(directory: string, values: Readonly<Record<string, Uint8Array>>): void {
  privateOutput(directory);
  for (const [name, bytes] of Object.entries(values)) {
    const fd = openSync(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  }
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** No provider, Git child, native child, package install or network operations. */
export function runNativeReleaseEvidence(argv: readonly string[], environment: Readonly<Record<string, string | undefined>>) {
  if (Bun.version !== "1.3.14") refuse();
  const repository = realpathSync(join(import.meta.dir, "..")), sources = nativeProcessSourceInventory(repository);
  const beforeWrite = (output: string): void => {
    if (output === repository || output.startsWith(repository + "/") || !isDeepStrictEqual(nativeProcessSourceInventory(repository), sources)) refuse();
  };
  const mode = argv[0];
  if (mode === "prepare" && argv.length === 6) {
    const [, archive, checksum, receipts, tag, output] = argv;
    if (archive === undefined || checksum === undefined || receipts === undefined || tag === undefined || output === undefined) refuse();
    const inputs = nativeReleaseEvidenceEnvironment(environment);
    const result = prepareNativeProcessReleaseEvidence({ ...inputs, currentSources: sources,
      archive: nativeBuildInput(archive, 64 * 1024 * 1024), checksum: nativeBuildInput(checksum, 4096), tagObject: nativeBuildInput(tag, 64 * 1024),
      receipts: Object.fromEntries(NATIVE_PROCESS_RELEASE_TARGETS.map(target =>
        [target, nativeBuildInput(join(receipts, target, NATIVE_INSTALLED_RECEIPT_NAME), 256 * 1024)])),
    });
    beforeWrite(output); writeOutput(output, { "predicate.json": result.predicateBytes, "coordinate.json": result.coordinateBytes });
    return { predicateSha256: result.predicateSha256, coordinateSha256: result.coordinateSha256 };
  }
  if (mode === "combine" && argv.length === 7) {
    const [, archive, checksum, predicate, coordinate, bundle, output] = argv;
    if (archive === undefined || checksum === undefined || predicate === undefined || coordinate === undefined || bundle === undefined || output === undefined) refuse();
    const result = combineNativeProcessReleaseEvidence({ currentSources: sources,
      archive: nativeBuildInput(archive, 64 * 1024 * 1024), checksum: nativeBuildInput(checksum, 4096),
      predicate: nativeBuildInput(predicate, 256 * 1024), coordinate: nativeBuildInput(coordinate, 16 * 1024), bundle: nativeBuildInput(bundle, 256 * 1024),
      predicateSha256: digest.parse(environment.NATIVE_PROCESS_PREDICATE_SHA256), coordinateSha256: digest.parse(environment.NATIVE_PROCESS_COORDINATE_SHA256),
    });
    beforeWrite(output); writeOutput(output, { [NATIVE_PROCESS_RELEASE_PROVENANCE]: result.provenanceBytes });
    return { provenanceSha256: result.provenanceSha256 };
  }
  refuse();
}
if (import.meta.main) {
  try { console.log(JSON.stringify(runNativeReleaseEvidence(process.argv.slice(2), process.env))); }
  catch { console.error("Native process release evidence could not be admitted. Existing inputs and partial output were preserved."); process.exitCode = 1; }
}
