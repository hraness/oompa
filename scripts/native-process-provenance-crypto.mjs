import { Buffer } from "node:buffer";
import process from "node:process";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { pathToFileURL } from "node:url";

export const NATIVE_PROVENANCE_PREDICATE = "https://github.com/hraness/oompa/native-process/qualification/v1";
export const NATIVE_PROVENANCE_NODE = "24.20.0";
const REPOSITORY = "https://github.com/hraness/oompa";
const REF = "refs/tags/native-process-v0.1.0";
const WORKFLOW = `${REPOSITORY}/.github/workflows/native-process-release.yml@${REF}`;
const ISSUER = "https://token.actions.githubusercontent.com";
const INPUT_MAXIMUM = 1024 * 1024;

/** @returns {never} */
function refuse() { throw Error("NATIVE_PROCESS_PROVENANCE_INVALID"); }
/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  return /** @type {Record<string, unknown>} */ (value);
}
/** @param {Record<string, unknown>} value @param {readonly string[]} names */
function keys(value, names) {
  if (!isDeepStrictEqual(Object.keys(value).sort(), [...names].sort())) refuse();
}
/** Fulcio generic extensions 8 onward contain DER UTF8String bytes.
 * @param {string} value */
export function nativeProvenanceDer(value) {
  if (!/^[\x20-\x7e]{1,127}$/u.test(value)) refuse();
  return String.fromCharCode(0x0c, value.length) + value;
}
/** @param {unknown} value */
export function nativeProvenanceSigner(value) {
  const run = record(value);
  keys(run, ["id", "attempt", "workflowRef", "sourceSha", "workflowSha"]);
  if (typeof run.id !== "string" || !/^[1-9][0-9]{0,19}$/u.test(run.id)
    || typeof run.attempt !== "number" || !Number.isSafeInteger(run.attempt) || run.attempt < 1
    || typeof run.sourceSha !== "string" || !/^[a-f0-9]{40}$/u.test(run.sourceSha)
    || run.workflowSha !== run.sourceSha || `https://github.com/${String(run.workflowRef)}` !== WORKFLOW) refuse();
  const invocation = `${REPOSITORY}/actions/runs/${run.id}/attempts/${run.attempt}`;
  const der = nativeProvenanceDer;
  return Object.freeze({ identity: WORKFLOW, invocation, options: Object.freeze({
    certificateIdentityURI: "^" + WORKFLOW.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "$",
    certificateIssuer: ISSUER,
    certificateOIDs: Object.freeze({
      "1.3.6.1.4.1.57264.1.8": der(ISSUER),
      "1.3.6.1.4.1.57264.1.11": der("github-hosted"),
      "1.3.6.1.4.1.57264.1.12": der(REPOSITORY),
      "1.3.6.1.4.1.57264.1.13": der(run.sourceSha),
      "1.3.6.1.4.1.57264.1.14": der(REF),
      "1.3.6.1.4.1.57264.1.15": der("1343008607"),
      "1.3.6.1.4.1.57264.1.16": der("https://github.com/hraness"),
      "1.3.6.1.4.1.57264.1.17": der("307125679"),
      "1.3.6.1.4.1.57264.1.18": der(WORKFLOW),
      "1.3.6.1.4.1.57264.1.19": der(run.workflowSha),
      "1.3.6.1.4.1.57264.1.20": der("push"),
      "1.3.6.1.4.1.57264.1.21": der(invocation),
      "1.3.6.1.4.1.57264.1.22": der("public"),
    }),
    ctLogThreshold: 1, tlogThreshold: 1, retry: 0, timeout: 10_000,
  }) });
}

/** This inspects signed content, not its signature. Only verify() grants crypto evidence.
 * @param {unknown} bundleValue @param {unknown} qualification
 * @param {readonly {name: string, digest: {sha256: string}}[]} subjects */
export function assertNativeProvenanceStatement(bundleValue, qualification, subjects) {
  const bundle = record(bundleValue);
  keys(bundle, ["mediaType", "verificationMaterial", "dsseEnvelope"]);
  if (bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json") refuse();
  const envelope = record(bundle.dsseEnvelope);
  keys(envelope, ["payloadType", "payload", "signatures"]);
  if (envelope.payloadType !== "application/vnd.in-toto+json" || typeof envelope.payload !== "string"
    || envelope.payload.length < 4 || envelope.payload.length > 350_000
    || !Array.isArray(envelope.signatures) || envelope.signatures.length !== 1) refuse();
  const signature = record(envelope.signatures[0]);
  if (typeof signature.sig !== "string" || signature.sig.length < 1 || signature.sig.length > 4096
    || Object.keys(signature).some(key => key !== "sig" && key !== "keyid")
    || (signature.keyid !== undefined && signature.keyid !== "")) refuse();
  const payload = Buffer.from(envelope.payload, "base64");
  if (payload.byteLength < 1 || payload.byteLength > 256 * 1024 || payload.toString("base64") !== envelope.payload) refuse();
  const statement = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)));
  keys(statement, ["_type", "subject", "predicateType", "predicate"]);
  if (statement._type !== "https://in-toto.io/Statement/v1" || statement.predicateType !== NATIVE_PROVENANCE_PREDICATE
    || !isDeepStrictEqual(statement.predicate, qualification) || !Array.isArray(statement.subject)
    || statement.subject.length !== 2 || subjects.length !== 2) refuse();
  const expected = [...subjects].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (expected[0]?.name !== "SHA256SUMS" || expected[1]?.name !== "hraness-native-process-0.1.0.tgz") refuse();
  for (const subject of expected) if (!/^[a-f0-9]{64}$/u.test(subject.digest.sha256)) refuse();
  const observed = statement.subject.map(value => {
    const subject = record(value); keys(subject, ["name", "digest"]);
    const digest = record(subject.digest); keys(digest, ["sha256"]);
    if (typeof subject.name !== "string" || typeof digest.sha256 !== "string") refuse();
    return { name: subject.name, digest: { sha256: digest.sha256 } };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (!isDeepStrictEqual(observed, expected)) refuse();
  nativeProvenanceSigner(record(record(qualification).coordinate).run);
  return bundle;
}

async function main() {
  if (process.versions.node !== NATIVE_PROVENANCE_NODE || process.versions.bun !== undefined) refuse();
  const [moduleUrl, cachePath, ...extra] = process.argv.slice(2);
  if (extra.length !== 0 || moduleUrl === undefined || !moduleUrl.startsWith("file://")
    || cachePath === undefined || !cachePath.startsWith("/")) refuse();
  /** @type {Buffer[]} */ const chunks = [];
  let length = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value); length += chunk.length;
    if (length > INPUT_MAXIMUM) refuse(); chunks.push(chunk);
  }
  const input = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, length))));
  keys(input, ["bundle", "qualification", "subjects"]);
  if (!Array.isArray(input.subjects)) refuse();
  const subjects = input.subjects.map(value => {
    const subject = record(value), digest = record(subject.digest);
    keys(subject, ["name", "digest"]); keys(digest, ["sha256"]);
    if (typeof subject.name !== "string" || typeof digest.sha256 !== "string") refuse();
    return { name: subject.name, digest: { sha256: digest.sha256 } };
  });
  const bundle = assertNativeProvenanceStatement(input.bundle, input.qualification, subjects);
  const policy = nativeProvenanceSigner(record(record(input.qualification).coordinate).run);
  // The parent resolves this one locked Sigstore module. No provider token,
  // custom trust root, mirror, key selector or environment override is accepted.
  const { verify } = await import(moduleUrl);
  const signer = await verify(bundle, { ...policy.options, tufCachePath: cachePath, tufForceCache: true });
  if (signer.identity?.subjectAlternativeName !== policy.identity || signer.identity?.extensions?.issuer !== ISSUER) refuse();
  process.stdout.write("verified\n");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); }
  catch { process.stderr.write("Native process provenance verification failed.\n"); process.exitCode = 1; }
}
