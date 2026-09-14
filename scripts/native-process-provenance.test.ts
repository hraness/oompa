import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { assertNativeProvenanceStatement, nativeProvenanceDer, nativeProvenanceSigner,
  NATIVE_PROVENANCE_NODE, NATIVE_PROVENANCE_PREDICATE } from "./native-process-provenance-crypto.mjs";
import { nativeProvenanceEnvironment, nativeProvenanceVerification, type VerifiedNativeProvenance } from "./native-process-provenance.ts";

const workflowRef = "hraness/oompa/.github/workflows/native-process-release.yml@refs/tags/native-process-v0.1.0";
const run = { id: "123", attempt: 1, workflowRef, sourceSha: "a".repeat(40), workflowSha: "a".repeat(40) };
// These are deliberately unsigned content fixtures, not qualification evidence.
const qualification = { coordinate: { run }, detail: "Synthetic content fixture; no native or cryptographic proof." };
const subjects = [{ name: "hraness-native-process-0.1.0.tgz", digest: { sha256: "b".repeat(64) } },
  { name: "SHA256SUMS", digest: { sha256: "c".repeat(64) } }];
function statement() {
  return { _type: "https://in-toto.io/Statement/v1", predicateType: NATIVE_PROVENANCE_PREDICATE,
    predicate: structuredClone(qualification), subject: structuredClone(subjects) };
}
function bundle(value: unknown = statement()) {
  return { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json", verificationMaterial: {},
    dsseEnvelope: { payloadType: "application/vnd.in-toto+json", payload: Buffer.from(JSON.stringify(value)).toString("base64"),
      signatures: [{ keyid: "", sig: "unsigned-fixture" }] } };
}
const inspect = (value: unknown) => assertNativeProvenanceStatement(value, qualification, subjects);
const decode = (value: string) => Buffer.from(value).subarray(2).toString("utf8");

test("native signer policy binds modern Fulcio claims to the producing attempt and fixed release namespace", () => {
  const policy = nativeProvenanceSigner(run), oids = policy.options.certificateOIDs;
  expect(NATIVE_PROVENANCE_NODE).toBe("24.20.0");
  expect(policy.identity).toBe("https://github.com/hraness/oompa/.github/workflows/native-process-release.yml@refs/tags/native-process-v0.1.0");
  expect(new RegExp(policy.options.certificateIdentityURI).test(policy.identity)).toBe(true);
  for (const wrong of [policy.identity + "suffix", policy.identity.replace("oompa", "other"), policy.identity.replace("native-process-release", "release")]) {
    expect(new RegExp(policy.options.certificateIdentityURI).test(wrong)).toBe(false);
  }
  expect(decode(oids["1.3.6.1.4.1.57264.1.8"])).toBe("https://token.actions.githubusercontent.com");
  expect(decode(oids["1.3.6.1.4.1.57264.1.11"])).toBe("github-hosted");
  expect(decode(oids["1.3.6.1.4.1.57264.1.15"])).toBe("1343008607");
  expect(decode(oids["1.3.6.1.4.1.57264.1.17"])).toBe("307125679");
  expect(decode(oids["1.3.6.1.4.1.57264.1.19"])).toBe(run.workflowSha);
  expect(decode(oids["1.3.6.1.4.1.57264.1.20"])).toBe("push");
  expect(decode(oids["1.3.6.1.4.1.57264.1.21"])).toBe("https://github.com/hraness/oompa/actions/runs/123/attempts/1");
  expect(decode(oids["1.3.6.1.4.1.57264.1.22"])).toBe("public");
  expect(policy.options.tlogThreshold).toBe(1); expect(policy.options.ctLogThreshold).toBe(1);
  expect(Object.keys(oids)).not.toContain("1.3.6.1.4.1.57264.1.23");
  // A publication retry does not mutate or substitute the producing policy.
  expect(nativeProvenanceSigner({ ...run, attempt: 2 }).invocation).not.toBe(policy.invocation);
  expect(nativeProvenanceSigner(run)).toEqual(policy);
});
test("native signer policy refuses wrong workflows, refs, commits and unbounded run coordinates", () => {
  for (const change of [{ id: "0" }, { id: "01" }, { id: "1".repeat(21) }, { attempt: 0 }, { attempt: 1.5 },
    { attempt: Number.MAX_SAFE_INTEGER + 1 }, { sourceSha: "A".repeat(40) }, { sourceSha: "f".repeat(39) },
    { workflowSha: "f".repeat(40) }, { workflowRef: workflowRef.replace("refs/tags/native-process-v0.1.0", "refs/heads/main") },
    { workflowRef: workflowRef.replace("native-process-release", "release") }, { repositoryId: "1343008607" }]) {
    expect(() => nativeProvenanceSigner({ ...run, ...change })).toThrow();
  }
  expect(Buffer.from(nativeProvenanceDer("public"))).toEqual(Buffer.from([12, 6, 112, 117, 98, 108, 105, 99]));
  for (const value of ["", "a".repeat(128), "\0", "é", "\n"]) expect(() => nativeProvenanceDer(value)).toThrow();
});
test("signed statement content requires exact two named hashes and complete unchanged predicate", () => {
  expect(inspect(bundle())).toEqual(bundle());
  expect(inspect(bundle({ ...statement(), subject: [...subjects].reverse() }))).toBeDefined();
  for (const subject of [[], subjects.slice(1), [...subjects, subjects[0]], [subjects[0], subjects[0]],
    [{ ...subjects[0], name: "other.tgz" }, subjects[1]],
    [{ ...subjects[0], digest: { sha256: "d".repeat(64) } }, subjects[1]],
    [{ ...subjects[0], digest: { sha256: subjects[0]!.digest.sha256, sha512: "d".repeat(128) } }, subjects[1]],
    [{ ...subjects[0], arbitrary: true }, subjects[1]]]) {
    expect(() => inspect(bundle({ ...statement(), subject }))).toThrow();
  }
  for (const change of [{ predicateType: "https://slsa.dev/provenance/v1" }, { _type: "https://in-toto.io/Statement/v0.1" },
    { predicate: { ...qualification, coordinate: { run: { ...run, attempt: 2 } } } },
    { predicate: { coordinate: qualification.coordinate } }, { arbitrary: true }]) {
    expect(() => inspect(bundle({ ...statement(), ...change }))).toThrow();
  }
});
test("DSSE parser rejects alternate formats, unbounded encoding, invalid UTF-8 and ambiguous envelopes", () => {
  const good = bundle();
  for (const change of [{ mediaType: "application/vnd.dev.sigstore.bundle+json;version=0.2" },
    { messageSignature: {} }, { dsseEnvelope: { ...good.dsseEnvelope, payloadType: "text/plain" } },
    { dsseEnvelope: { ...good.dsseEnvelope, payload: good.dsseEnvelope.payload + "\n" } },
    { dsseEnvelope: { ...good.dsseEnvelope, payload: "A".repeat(350_004) } },
    { dsseEnvelope: { ...good.dsseEnvelope, payload: Buffer.from([255, 255, 255]).toString("base64") } },
    { dsseEnvelope: { ...good.dsseEnvelope, signatures: [] } },
    { dsseEnvelope: { ...good.dsseEnvelope, signatures: [...good.dsseEnvelope.signatures, ...good.dsseEnvelope.signatures] } },
    { dsseEnvelope: { ...good.dsseEnvelope, signatures: [{ sig: "value", keyid: "external-key" }] } },
    { dsseEnvelope: { ...good.dsseEnvelope, arbitrary: true } }]) expect(() => inspect({ ...good, ...change })).toThrow();
});
test("native verifier has an explicit private environment and serialized evidence cannot forge its capability", () => {
  expect(nativeProvenanceEnvironment("/private/owned", "/opt/node/bin/node")).toEqual({
    PATH: "/opt/node/bin:/usr/bin:/bin", HOME: "/private/owned/home", TMPDIR: "/private/owned/tmp", LANG: "C", LC_ALL: "C", TZ: "UTC",
  });
  expect(() => nativeProvenanceEnvironment("relative", "/opt/node/bin/node")).toThrow();
  expect(() => nativeProvenanceVerification({} as VerifiedNativeProvenance)).toThrow();
  expect(() => nativeProvenanceVerification(JSON.parse('{"verified":true}') as VerifiedNativeProvenance)).toThrow();
});
test("native source inventory includes the actual Node worker and changes when its bytes change", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "native-provenance-source-")));
  try {
    for (const path of ["scripts", "src", "native/process-kernel", "packages/native-process"]) mkdirSync(join(root, path), { recursive: true });
    for (const path of ["package.json", "bun.lock", ".bun-version", "LICENSE", "scripts/bounded-process.ts",
      "scripts/authority-supervisor-artifact.ts", "src/install-normalizer.ts", "scripts/release-repository-identity.ts",
      "scripts/bounded-json-response.ts", "scripts/release-distribution-policy.ts", "scripts/release-package-policy.ts"]) writeFileSync(join(root, path), "fixture");
    const path = "scripts/native-process-provenance-crypto.mjs";
    writeFileSync(join(root, path), "first");
    const first = nativeProcessSourceInventory(root).find(file => file.path === path);
    expect(first?.bytes).toBe(5);
    const releasePath = "scripts/release-package-policy.ts";
    const releaseFirst = nativeProcessSourceInventory(root).find(file => file.path === releasePath);
    expect(releaseFirst?.bytes).toBe(7);
    writeFileSync(join(root, releasePath), "changed release policy");
    expect(nativeProcessSourceInventory(root).find(file => file.path === releasePath)?.sha256).not.toBe(releaseFirst?.sha256);
    writeFileSync(join(root, path), "second");
    expect(nativeProcessSourceInventory(root).find(file => file.path === path)?.sha256).not.toBe(first?.sha256);
  } finally { rmSync(root, { recursive: true }); }
});
