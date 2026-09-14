import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_ARTIFACT_TARGETS, NATIVE_CLIENT_FILES, type NativeArtifactTarget } from "../packages/native-process/src/artifact-model.ts";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { nativeProcessDependency } from "./native-process-dependency.ts";
import { assembleNativeProcessPackage } from "./native-process-package.ts";
import { NATIVE_PROVENANCE_PREDICATE } from "./native-process-provenance-crypto.mjs";
import { NATIVE_TRANSPORT_CASES } from "./native-process-qualification-model.ts";
import { combineNativeProcessReleaseEvidence, nativeReleaseEvidenceEnvironment, nativeReleaseTagObject,
  prepareNativeProcessReleaseEvidence } from "./native-process-release-evidence.ts";
import { NATIVE_PROCESS_RELEASE_ARCHIVE, NATIVE_PROCESS_RELEASE_TAG, NATIVE_PROCESS_RELEASE_TARGETS,
  nativeProcessReleaseRun } from "./native-process-release-policy.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
const hash = (value: string) => nativeInputHash(Buffer.from(value));
const context = { repository: "hraness/oompa", repositoryId: "1343008607", repositoryOwnerId: "307125679", actorId: "894119",
  senderId: "894119", senderType: "User", eventName: "push", ref: "refs/tags/native-process-v0.1.0", refName: NATIVE_PROCESS_RELEASE_TAG,
  refType: "tag", workflowRef: "hraness/oompa/.github/workflows/native-process-release.yml@refs/tags/native-process-v0.1.0",
  runId: "123", runAttempt: 1, sourceSha: "a".repeat(40), workflowSha: "a".repeat(40) };
const tag = (commit = context.sourceSha) => Buffer.from(`object ${commit}\ntype commit\ntag ${NATIVE_PROCESS_RELEASE_TAG}\ntagger Fixture <fixture@example.invalid> 1 +0000\n\nSynthetic tag object.\n`);
const tagHash = (bytes: Uint8Array) => createHash("sha1").update(`tag ${bytes.byteLength}\0`).update(bytes).digest("hex");
function executable(target: NativeArtifactTarget): Buffer {
  // Header-only parser fixture. These bytes are never executed.
  const bytes = Buffer.alloc(128);
  if (target.startsWith("darwin-")) {
    bytes.writeUInt32LE(0xfeedfacf, 0); bytes.writeUInt32LE(target.endsWith("arm64") ? 0x0100000c : 0x01000007, 4);
    bytes.writeUInt32LE(target.endsWith("arm64") ? 0 : 3, 8); bytes.writeUInt32LE(2, 12);
    bytes.writeUInt32LE(1, 16); bytes.writeUInt32LE(8, 20); bytes.writeUInt32LE(8, 36);
  } else {
    bytes.writeUInt32BE(0x7f454c46, 0); bytes[4] = 2; bytes[5] = 1; bytes[6] = 1;
    bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(target.endsWith("arm64") ? 183 : 62, 18); bytes.writeUInt32LE(1, 20);
    bytes.writeBigUInt64LE(64n, 32); bytes.writeUInt16LE(64, 52); bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  }
  return bytes;
}
function fixture() {
  const currentSources = ["bun.lock", "native/process-kernel/Cargo.lock", "native/process-kernel/rust-toolchain.toml"]
    .map(path => ({ path, bytes: path.length, sha256: hash(path) }));
  const source = { commitSha: context.sourceSha, treeSha256: nativeInputHash(Buffer.from(JSON.stringify(currentSources))),
    bunLockSha256: currentSources[0]!.sha256, cargoLockSha256: currentSources[1]!.sha256, toolchainSha256: currentSources[2]!.sha256,
    rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" } as const;
  const notice = Buffer.from("Synthetic notice.\n");
  const licenseIndex = encode({ formatVersion: 1, crates: [{ name: "fixture", version: "1.0.0", license: "MIT",
    files: [{ path: "fixture-1.0.0/LICENSE", bytes: notice.length, sha256: nativeInputHash(notice) }] }] });
  const qualifications = NATIVE_PROCESS_RELEASE_TARGETS.map(target => ({ formatVersion: 1, phase: "prepack-native",
    profile: "native-process-v1-posix-custody", profileVersion: 1, source, target, rustTarget: NATIVE_ARTIFACT_TARGETS[target],
    artifact: { bytes: 128, sha256: nativeInputHash(executable(target)) }, licensesSha256: nativeInputHash(licenseIndex),
    harnesses: { unit: { bytes: 64, sha256: hash("unit" + target) }, native: { bytes: 64, sha256: hash("native" + target) },
      fixture: { bytes: 64, sha256: hash("fixture" + target) } },
    compiler: { rustcVerboseVersion: "rustc 1.97.1 (synthetic)", cargoVersion: "cargo 1.97.1 (synthetic)", bunVersion: "1.3.14",
      deploymentTarget: target.startsWith("darwin-") ? "11.0" : "static-musl", environmentPolicy: "native-process-build-env-v1",
      linker: { sha256: hash("linker"), version: "synthetic" }, sdk: target.startsWith("darwin-") ? { kind: "macos", version: "fixture", buildVersion: "fixture" }
        : { kind: "static-musl", target: NATIVE_ARTIFACT_TARGETS[target] }, host: { architecture: target.endsWith("arm64") ? "arm64" : "x64", osRelease: "fixture" } },
    checks: { clippy: "passed", unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 }, transport: [...NATIVE_TRANSPORT_CASES] },
  }));
  const bundles = qualifications.map(value => ({ executable: executable(value.target), qualification: encode(value) }));
  const built = assembleNativeProcessPackage({ source, bundles,
    licenses: [{ path: "manifest.json", bytes: licenseIndex }, { path: "fixture-1.0.0/LICENSE", bytes: notice }],
    client: [...NATIVE_CLIENT_FILES, "README.md", "LICENSE"].map(path => ({ path, bytes: path === "package.json"
      ? readFileSync(join(import.meta.dir, "../packages/native-process/package.json")) : Buffer.from("synthetic\n") })) });
  const receipts = Object.fromEntries(qualifications.map((value, index) => [value.target, encode({ formatVersion: 1, phase: "installed-native",
    profile: value.profile, profileVersion: 1, source, target: value.target, rustTarget: value.rustTarget, artifact: value.artifact,
    harnesses: value.harnesses, archiveSha256: built.archiveSha256, manifestSha256: built.manifestSha256,
    prepackSha256: nativeInputHash(bundles[index]!.qualification), verifierSha256: hash("verifier"), workerSha256: hash("worker"),
    dependency: { name: "zod", version: "4.4.3", integrity: nativeProcessDependency.integrity, archiveSha256: hash("dependency"), inventorySha256: hash("inventory") },
    bun: { version: "1.3.14", sha256: hash("bun" + value.target) },
    installation: { localLockSha256: hash("local-lock"), clientInventorySha256: nativeInputHash(Buffer.from(JSON.stringify(built.manifest.client))),
      image: { device: "1", inode: "2", uid: "3", gid: "4", mode: 0o500, ...value.artifact } },
    checks: { unit: value.checks.unit, native: value.checks.native, transport: [...NATIVE_TRANSPORT_CASES] },
  })])) as Record<NativeArtifactTarget, Buffer>;
  const expected = { archiveSha256: built.archiveSha256, manifestSha256: built.manifestSha256, tagObjectSha: tagHash(tag()),
    installedSha256: Object.fromEntries(NATIVE_PROCESS_RELEASE_TARGETS.map(target => [target, nativeInputHash(receipts[target])])) as Record<NativeArtifactTarget, string> };
  const input = { archive: built.archive, checksum: Buffer.from(`${built.archiveSha256}  ${NATIVE_PROCESS_RELEASE_ARCHIVE}\n`),
    tagObject: tag(), context, currentSources, receipts, expected };
  const prepared = prepareNativeProcessReleaseEvidence(input);
  const qualification: unknown = JSON.parse(prepared.predicateBytes.toString());
  const statement = { _type: "https://in-toto.io/Statement/v1", predicateType: NATIVE_PROVENANCE_PREDICATE, predicate: qualification,
    subject: [{ name: NATIVE_PROCESS_RELEASE_ARCHIVE, digest: { sha256: built.archiveSha256 } },
      { name: "SHA256SUMS", digest: { sha256: nativeInputHash(input.checksum) } }] };
  const bundle = (value: unknown = statement) => encode({ mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: {},
    dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(value)).toString("base64"), signatures: [{ keyid: "", sig: "unsigned" }] } });
  const combine = { archive: input.archive, checksum: input.checksum, predicate: prepared.predicateBytes, coordinate: prepared.coordinateBytes,
    bundle: bundle(), predicateSha256: prepared.predicateSha256, coordinateSha256: prepared.coordinateSha256, currentSources };
  return { input, prepared, combine, statement, bundle };
}

test("prepare joins all four admitted installed-file hashes and the real annotated tag object bytes", () => {
  const { input, prepared } = fixture();
  const predicate = JSON.parse(prepared.predicateBytes.toString()) as { targets: unknown; coordinate: { run: unknown } };
  expect(predicate.targets).toEqual(NATIVE_PROCESS_RELEASE_TARGETS);
  expect(predicate.coordinate.run).toEqual(nativeProcessReleaseRun(context));
  expect(nativeInputHash(prepared.coordinateBytes)).toBe(prepared.coordinateSha256);
  const badDigest = { ...input.expected, installedSha256: { ...input.expected.installedSha256, "darwin-arm64": hash("other") } };
  expect(() => prepareNativeProcessReleaseEvidence({ ...input, expected: badDigest })).toThrow();
  for (const target of NATIVE_PROCESS_RELEASE_TARGETS) {
    const receipts = Object.fromEntries(Object.entries(input.receipts).filter(([name]) => name !== target));
    expect(() => prepareNativeProcessReleaseEvidence({ ...input, receipts })).toThrow();
  }
  expect(() => prepareNativeProcessReleaseEvidence({ ...input, receipts: { ...input.receipts, extra: input.receipts["darwin-arm64"] } })).toThrow();
  const swapped = { ...input.receipts, "darwin-arm64": input.receipts["darwin-x64"] };
  expect(() => prepareNativeProcessReleaseEvidence({ ...input, receipts: swapped,
    expected: { ...input.expected, installedSha256: { ...input.expected.installedSha256, "darwin-arm64": nativeInputHash(swapped["darwin-arm64"]) } } })).toThrow();
});
test("changed source, receipt acceptance, manifest and exact checksum cannot enter the predicate", () => {
  const { input } = fixture();
  for (const change of [{ expected: { ...input.expected, archiveSha256: hash("other") } },
    { expected: { ...input.expected, manifestSha256: hash("other") } }, { checksum: Buffer.concat([input.checksum, Buffer.from("\n")]) },
    { currentSources: input.currentSources.slice(1) }, { currentSources: [...input.currentSources].reverse() },
    { context: { ...context, workflowSha: "f".repeat(40) } }, { context: { ...context, senderId: "307125679" } }]) {
    expect(() => prepareNativeProcessReleaseEvidence({ ...input, ...change })).toThrow();
  }
  const parsed = JSON.parse(input.receipts["darwin-arm64"].toString()) as { checks: { native: { passed: number } } };
  parsed.checks.native.passed = 19;
  const bytes = encode(parsed);
  expect(() => prepareNativeProcessReleaseEvidence({ ...input, receipts: { ...input.receipts, "darwin-arm64": bytes },
    expected: { ...input.expected, installedSha256: { ...input.expected.installedSha256, "darwin-arm64": nativeInputHash(bytes) } } })).toThrow();
});
test("tag admission rejects lightweight, foreign, nested and changed annotated tag objects", () => {
  expect(() => nativeReleaseTagObject(tag(), tagHash(tag()), context.sourceSha)).not.toThrow();
  for (const value of [tag("f".repeat(40)), Buffer.from(context.sourceSha), Buffer.from(tag().toString().replace("type commit", "type tag")),
    Buffer.from(tag().toString().replace(NATIVE_PROCESS_RELEASE_TAG, "v0.1.0")), Buffer.from(tag().toString().replace("\n\n", "\nextra header\n\n")),
    Buffer.concat([tag(), Buffer.from([0])])]) {
    expect(() => nativeReleaseTagObject(value, tagHash(value), context.sourceSha)).toThrow();
  }
  expect(() => nativeReleaseTagObject(tag(), "f".repeat(40), context.sourceSha)).toThrow();
});
test("workflow hash environment requires four fixed outputs and exact structured producer context", () => {
  const { input } = fixture();
  const environment = { NATIVE_PROCESS_RELEASE_CONTEXT: JSON.stringify(context), NATIVE_PROCESS_ARCHIVE_SHA256: input.expected.archiveSha256,
    NATIVE_PROCESS_MANIFEST_SHA256: input.expected.manifestSha256, NATIVE_PROCESS_TAG_OBJECT_SHA: input.expected.tagObjectSha,
    ...Object.fromEntries(NATIVE_PROCESS_RELEASE_TARGETS.map(target => ["NATIVE_PROCESS_INSTALLED_" + target.toUpperCase().replaceAll("-", "_") + "_SHA256", input.expected.installedSha256[target]])) };
  expect(nativeReleaseEvidenceEnvironment(environment)).toEqual({ context, expected: input.expected });
  for (const name of Object.keys(environment)) expect(() => nativeReleaseEvidenceEnvironment({ ...environment, [name]: undefined })).toThrow();
  expect(() => nativeReleaseEvidenceEnvironment({ ...environment, NATIVE_PROCESS_RELEASE_CONTEXT: JSON.stringify({ ...context, arbitrary: true }) })).toThrow();
});
test("combine preserves original archive and checksum and requires the exact prepared predicate and DSSE content", () => {
  const { combine, statement, bundle } = fixture(), archive = Buffer.from(combine.archive), checksum = Buffer.from(combine.checksum);
  const result = combineNativeProcessReleaseEvidence(combine);
  expect(nativeInputHash(result.provenanceBytes)).toBe(result.provenanceSha256);
  expect(combine.archive).toEqual(archive); expect(combine.checksum).toEqual(checksum);
  expect(() => combineNativeProcessReleaseEvidence({ ...combine, predicateSha256: hash("wrong") })).toThrow();
  expect(() => combineNativeProcessReleaseEvidence({ ...combine, coordinateSha256: hash("wrong") })).toThrow();
  for (const value of [{ ...statement, predicate: {} }, { ...statement, subject: statement.subject.slice(1) },
    { ...statement, predicateType: "https://slsa.dev/provenance/v1" }]) {
    expect(() => combineNativeProcessReleaseEvidence({ ...combine, bundle: bundle(value) })).toThrow();
  }
  const changed = JSON.parse(combine.coordinate.toString()) as { run: { attempt: number } }; changed.run.attempt = 2;
  const changedBytes = encode(changed);
  expect(() => combineNativeProcessReleaseEvidence({ ...combine, coordinate: changedBytes, coordinateSha256: nativeInputHash(changedBytes) })).toThrow();
});
