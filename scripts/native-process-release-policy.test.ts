import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_ARTIFACT_TARGETS, NATIVE_CLIENT_FILES, type NativeArtifactTarget } from "../packages/native-process/src/artifact-model.ts";
import { inspectNativeProcessArchive } from "./native-process-archive.ts";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { nativeProcessDependency } from "./native-process-dependency.ts";
import { assembleNativeProcessPackage } from "./native-process-package.ts";
import { NATIVE_TRANSPORT_CASES } from "./native-process-qualification-model.ts";
import { NATIVE_PROCESS_RELEASE_ARCHIVE, NATIVE_PROCESS_RELEASE_REPOSITORY, NATIVE_PROCESS_RELEASE_TAG, NATIVE_PROCESS_RELEASE_TARGETS,
  NATIVE_PROCESS_RELEASE_WORKFLOW, admitNativeReleaseEvidence, admitNativeReleaseReadback, assertNativeReleaseNotLatest,
  nativeProcessReleaseIdentity, nativeProcessReleaseRun, nativeReleaseBody, nativeReleaseDraftRequest, nativeReleasePublishRequest } from "./native-process-release-policy.ts";

const encode = (value: unknown): Buffer => Buffer.from(JSON.stringify(value) + "\n");
const provenanceBytes = (qualification: unknown): Buffer => encode({ formatVersion: 1, qualification,
  bundle: { fixture: "Synthetic parser fixture; no signature or authenticated authority." } });
const hash = (value: string): string => nativeInputHash(Buffer.from(value));
const context = () => ({ repository: NATIVE_PROCESS_RELEASE_REPOSITORY, repositoryId: "1343008607", repositoryOwnerId: "307125679",
  actorId: "894119", senderId: "894119", senderType: "User", eventName: "push", ref: `refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`,
  refName: NATIVE_PROCESS_RELEASE_TAG, refType: "tag", workflowRef: `${NATIVE_PROCESS_RELEASE_REPOSITORY}/${NATIVE_PROCESS_RELEASE_WORKFLOW}@refs/tags/${NATIVE_PROCESS_RELEASE_TAG}`,
  runId: "123", runAttempt: 1, sourceSha: "a".repeat(40), workflowSha: "a".repeat(40) });
const repository = { id: 1343008607, full_name: NATIVE_PROCESS_RELEASE_REPOSITORY, default_branch: "main", owner: { id: 307125679 }, private: false, visibility: "public" };
function executable(target: NativeArtifactTarget): Buffer {
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
  const source = { commitSha: "a".repeat(40), treeSha256: hash("tree"), bunLockSha256: hash("bun"), cargoLockSha256: hash("cargo"),
    toolchainSha256: hash("toolchain"), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" } as const;
  const notice = Buffer.from("Synthetic fixture notice; no native executable runs.\n");
  const licenses = [{ path: "manifest.json", bytes: encode({ formatVersion: 1, crates: [{ name: "fixture", version: "1.0.0", license: "MIT",
    files: [{ path: "fixture-1.0.0/LICENSE", bytes: notice.length, sha256: nativeInputHash(notice) }] }] }) },
  { path: "fixture-1.0.0/LICENSE", bytes: notice }];
  const qualifications = NATIVE_PROCESS_RELEASE_TARGETS.map(target => ({ formatVersion: 1, phase: "prepack-native", profile: "native-process-v1-posix-custody", profileVersion: 1,
    source, target, rustTarget: NATIVE_ARTIFACT_TARGETS[target], artifact: { bytes: 128, sha256: nativeInputHash(executable(target)) },
    licensesSha256: nativeInputHash(licenses[0]!.bytes), harnesses: { unit: { bytes: 64, sha256: hash("unit" + target) },
      native: { bytes: 64, sha256: hash("native" + target) }, fixture: { bytes: 64, sha256: hash("fixture" + target) } },
    compiler: { rustcVerboseVersion: "rustc 1.97.1 (synthetic)", cargoVersion: "cargo 1.97.1 (synthetic)", bunVersion: "1.3.14",
      deploymentTarget: target.startsWith("darwin-") ? "11.0" : "static-musl", environmentPolicy: "native-process-build-env-v1",
      linker: { sha256: hash("linker"), version: "synthetic" }, sdk: target.startsWith("darwin-") ? { kind: "macos", version: "fixture", buildVersion: "fixture" }
        : { kind: "static-musl", target: NATIVE_ARTIFACT_TARGETS[target] }, host: { architecture: target.endsWith("arm64") ? "arm64" : "x64", osRelease: "fixture" } },
    checks: { clippy: "passed", unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 }, transport: [...NATIVE_TRANSPORT_CASES] },
  }));
  const prepackBytes = qualifications.map(encode);
  const built = assembleNativeProcessPackage({ source, licenses,
    bundles: qualifications.map((value, index) => ({ executable: executable(value.target), qualification: prepackBytes[index]! })),
    client: [...NATIVE_CLIENT_FILES, "README.md", "LICENSE"].map(path => ({ path, bytes: path === "package.json"
      ? readFileSync(join(import.meta.dir, "../packages/native-process/package.json")) : Buffer.from("synthetic\n") })) });
  const manifestBytes = inspectNativeProcessArchive(built.archive).find(file => file.path === "package/native-artifacts/manifest.json")!.bytes;
  const coordinate = { source, tagObjectSha: "b".repeat(40), archive: { bytes: built.archive.length, sha256: built.archiveSha256 },
    manifestSha256: built.manifestSha256, run: nativeProcessReleaseRun(context()) };
  const installedReceipts = qualifications.map((value, index) => ({ formatVersion: 1, phase: "installed-native", profile: value.profile, profileVersion: 1,
    source, target: value.target, rustTarget: value.rustTarget, artifact: value.artifact, harnesses: value.harnesses,
    archiveSha256: coordinate.archive.sha256, manifestSha256: coordinate.manifestSha256, prepackSha256: nativeInputHash(prepackBytes[index]!),
    verifierSha256: hash("verifier"), workerSha256: hash("worker"), dependency: { name: "zod", version: "4.4.3", integrity: nativeProcessDependency.integrity,
      archiveSha256: hash("dependency archive"), inventorySha256: hash("dependency inventory") }, bun: { version: "1.3.14", sha256: hash("bun" + value.target) },
    installation: { localLockSha256: hash("local lock"), clientInventorySha256: nativeInputHash(Buffer.from(JSON.stringify(built.manifest.client))),
      image: { device: "1", inode: "2", uid: "3", gid: "4", mode: 0o500, ...value.artifact } },
    checks: { unit: value.checks.unit, native: value.checks.native, transport: [...NATIVE_TRANSPORT_CASES] } }));
  const input = { coordinate, manifestBytes, prepackBytes, installedReceipts };
  const evidence = admitNativeReleaseEvidence(input), provenance = provenanceBytes(evidence);
  const checksum = Buffer.from(`${built.archiveSha256}  ${NATIVE_PROCESS_RELEASE_ARCHIVE}\n`);
  const identity = nativeProcessReleaseIdentity(coordinate, built.archive, checksum, provenance);
  return { input, evidence, identity, built, checksum, provenance };
}

test("native release context distinguishes repository owner and authorized push user and refuses other workflows", () => {
  expect(nativeProcessReleaseRun(context()).id).toBe("123");
  for (const change of [{ repositoryOwnerId: "894119" }, { actorId: "307125679" }, { senderType: "Bot" }, { senderId: "1" },
    { eventName: "workflow_dispatch" }, { ref: "refs/heads/main" }, { refName: "v0.1.0" }, { refType: "branch" },
    { workflowRef: "hraness/oompa/.github/workflows/release.yml@refs/tags/v0.1.0" }, { runId: "01" }, { runAttempt: 0 }, { arbitrary: true }]) {
    expect(() => nativeProcessReleaseRun({ ...context(), ...change })).toThrow();
  }
});
test("release admission requires all four exact prepack and installed targets even when every remaining item passes", () => {
  const { input } = fixture();
  expect(admitNativeReleaseEvidence(input).targets).toEqual(NATIVE_PROCESS_RELEASE_TARGETS);
  for (const change of [{ sourceSha: "f".repeat(40) }, { workflowSha: "f".repeat(40) }]) {
    expect(() => admitNativeReleaseEvidence({ ...input,
      coordinate: { ...input.coordinate, run: { ...input.coordinate.run, ...change } } })).toThrow();
  }
  for (const field of ["prepackBytes", "installedReceipts"] as const) {
    expect(() => admitNativeReleaseEvidence({ ...input, [field]: input[field].slice(1) })).toThrow();
    expect(() => admitNativeReleaseEvidence({ ...input, [field]: [...input[field].slice(1), input[field][1]!] })).toThrow();
  }
  for (const change of [{ archiveSha256: hash("other archive") }, { manifestSha256: hash("other manifest") },
    { prepackSha256: hash("other prepack") }, { verifierSha256: hash("other verifier") }, { workerSha256: hash("other worker") },
    { rustTarget: "x86_64-unknown-linux-musl" }, { source: { ...input.coordinate.source, commitSha: "c".repeat(40) } },
    { harnesses: { ...input.installedReceipts[0]!.harnesses, unit: { bytes: 65, sha256: hash("other unit") } } },
    { checks: { ...input.installedReceipts[0]!.checks, native: { passed: 19, failed: 0, ignored: 0 } } },
    { installation: { ...input.installedReceipts[0]!.installation, clientInventorySha256: hash("other client") } }]) {
    expect(() => admitNativeReleaseEvidence({ ...input, installedReceipts: [{ ...input.installedReceipts[0], ...change }, ...input.installedReceipts.slice(1)] })).toThrow();
  }
});
test("release identity binds the actual archive and its embedded evidence, exact checksum and complete provenance", () => {
  const value = fixture();
  expect(value.identity.assets.map(asset => asset.name)).toEqual([NATIVE_PROCESS_RELEASE_ARCHIVE, "SHA256SUMS", "native-process-provenance.json"]);
  for (const [archive, checksum, provenance] of [
    [Buffer.from("other"), value.checksum, value.provenance], [value.built.archive, Buffer.from("other"), value.provenance],
    [value.built.archive, value.checksum, provenanceBytes({ ...value.evidence, evidence: value.evidence.evidence.slice(1) })],
    [value.built.archive, value.checksum, provenanceBytes({ ...value.evidence, targets: [...NATIVE_PROCESS_RELEASE_TARGETS].reverse() })],
  ] as const) expect(() => nativeProcessReleaseIdentity(value.input.coordinate, archive, checksum, provenance)).toThrow();
});
function releaseFixture(value: ReturnType<typeof fixture>, published: boolean, count = 3) {
  return { id: 41, tag_name: NATIVE_PROCESS_RELEASE_TAG, name: NATIVE_PROCESS_RELEASE_TAG, target_commitish: value.identity.coordinate.source.commitSha,
    author: { id: 41898282, type: "Bot" },
    draft: !published, prerelease: false, immutable: published, body: nativeReleaseBody(value.identity, 1, published),
    url: `https://api.github.com/repos/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/41`,
    html_url: `https://github.com/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/tag/${NATIVE_PROCESS_RELEASE_TAG}`,
    assets: value.identity.assets.slice(0, count).map((asset, index) => ({ id: 101 + index, name: asset.name, state: "uploaded", size: asset.bytes,
      digest: `sha256:${asset.sha256}`, url: `https://api.github.com/repos/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/assets/${101 + index}`,
      browser_download_url: `https://github.com/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/download/${NATIVE_PROCESS_RELEASE_TAG}/${asset.name}` })) };
}
test("draft reconciliation retains numeric release and asset identity and publication requires complete immutable readback", () => {
  const value = fixture(), partial = releaseFixture(value, false, 1), complete = releaseFixture(value, true);
  const prior = admitNativeReleaseReadback(repository, partial, value.identity, "draft");
  expect(admitNativeReleaseReadback(repository, complete, value.identity, "published", prior).assets).toHaveLength(3);
  for (const changed of [{ ...complete, id: 42 }, { ...complete, immutable: false }, { ...complete, body: complete.body + "edited" },
    { ...complete, target_commitish: "f".repeat(40) }, { ...complete, assets: complete.assets.slice(1) },
    { ...complete, assets: [complete.assets[0], complete.assets[0], complete.assets[2]] },
    { ...complete, assets: complete.assets.map((asset, index) => index === 0 ? { ...asset, id: 999 } : asset) },
    { ...complete, assets: complete.assets.map((asset, index) => index === 0 ? { ...asset, digest: "sha256:" + hash("wrong") } : asset) }]) {
    expect(() => admitNativeReleaseReadback(repository, changed, value.identity, "published", prior)).toThrow();
  }
  expect(() => admitNativeReleaseReadback({ ...repository, owner: { id: 894119 } }, complete, value.identity, "published")).toThrow();
});
test("same-run retries preserve original creation and publication attempts without accepting a foreign run", () => {
  const value = fixture(), complete = releaseFixture(value, true);
  const later = { ...value.identity.coordinate.run, attempt: 2 };
  expect(admitNativeReleaseReadback(repository, complete, value.identity, "published", undefined, later).publishedAttempt).toBe(1);
  const prior = admitNativeReleaseReadback(repository, complete, value.identity, "published");
  expect(() => admitNativeReleaseReadback(repository, { ...complete, body: nativeReleaseBody(value.identity, 1, true, later) }, value.identity, "published", prior, later)).toThrow();
  expect(() => admitNativeReleaseReadback(repository, complete, value.identity, "published", undefined, { ...later, id: "999" })).toThrow();
  const partial = admitNativeReleaseReadback(repository, releaseFixture(value, false, 1), value.identity, "draft");
  const resumed = { ...complete, body: nativeReleasePublishRequest(value.identity, partial.createdAttempt, later).body };
  expect(admitNativeReleaseReadback(repository, resumed, value.identity, "published", partial, later).publishedAttempt).toBe(2);
  expect(value.identity.coordinate.run.attempt).toBe(1);
  expect(nativeReleaseDraftRequest(value.identity, later).body).toContain('"producingAttempt":1,"createdAttempt":2');
  expect(() => nativeReleaseDraftRequest(value.identity, { ...later, attempt: 0 })).toThrow();
  expect(() => nativeReleasePublishRequest(value.identity, 2)).toThrow();
});
test("draft readback admits only GitHub's exact temporary asset URLs and the workload author", () => {
  const value = fixture(), draft = releaseFixture(value, false);
  const temporary = { ...draft, html_url: `https://github.com/hraness/oompa/releases/tag/untagged-${"a".repeat(20)}`,
    assets: draft.assets.map(asset => ({ ...asset,
    browser_download_url: `https://github.com/hraness/oompa/releases/download/untagged-${"a".repeat(20)}/${asset.name}` })) };
  expect(admitNativeReleaseReadback(repository, temporary, value.identity, "draft").assets).toHaveLength(3);
  for (const author of [{ id: 894119, type: "User" }, { id: 41898282, type: "User" }, { id: 7, type: "Bot" }]) {
    expect(() => admitNativeReleaseReadback(repository, { ...draft, author }, value.identity, "draft")).toThrow();
  }
  const published = releaseFixture(value, true);
  expect(() => admitNativeReleaseReadback(repository, { ...published, html_url: temporary.html_url }, value.identity, "published")).toThrow();
  for (const html_url of [temporary.html_url + "?changed", temporary.html_url.replace("hraness/oompa", "foreign/oompa"),
    "https://github.com/hraness/oompa/releases/tag/untagged-a"]) {
    expect(() => admitNativeReleaseReadback(repository, { ...temporary, html_url }, value.identity, "draft")).toThrow();
  }
  expect(() => admitNativeReleaseReadback(repository, { ...published, assets: temporary.assets }, value.identity, "published")).toThrow();
  for (const url of ["https://github.com/foreign/oompa/releases/download/untagged-" + "a".repeat(20) + "/SHA256SUMS",
    "https://github.com/hraness/oompa/releases/download/untagged-a/SHA256SUMS",
    temporary.assets[0]!.browser_download_url + "?token=anything"]) {
    expect(() => admitNativeReleaseReadback(repository, { ...temporary,
      assets: [{ ...temporary.assets[0], browser_download_url: url }, ...temporary.assets.slice(1)] }, value.identity, "draft")).toThrow();
  }
});
test("native publication explicitly declines Latest while permitting a concurrent legitimate CLI release", () => {
  const value = fixture(), readback = admitNativeReleaseReadback(repository, releaseFixture(value, true), value.identity, "published");
  expect(nativeReleaseDraftRequest(value.identity).make_latest).toBe("false");
  expect(nativeReleasePublishRequest(value.identity, 1).make_latest).toBe("false");
  for (const tag of ["v0.1.0", "v2.3.4"]) expect(() => assertNativeReleaseNotLatest({ id: 500, tag_name: tag, draft: false, prerelease: false, immutable: true,
    html_url: `https://github.com/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/tag/${tag}` }, readback)).not.toThrow();
  expect(() => assertNativeReleaseNotLatest({ ...releaseFixture(value, true) }, readback)).toThrow();
  expect(() => assertNativeReleaseNotLatest({ id: readback.id, tag_name: "v2.3.4", draft: false, prerelease: false, immutable: true,
    html_url: `https://github.com/${NATIVE_PROCESS_RELEASE_REPOSITORY}/releases/tag/v2.3.4` }, readback)).toThrow();
});
