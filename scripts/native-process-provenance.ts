import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync,
  writeFileSync, type BigIntStats } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { requireBoundedProcessCleanup, runBoundedProcess } from "./bounded-process.ts";
import { nativeBuildInput, nativeInputHash, nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { assertNativeProvenanceStatement, NATIVE_PROVENANCE_NODE, NATIVE_PROVENANCE_PREDICATE } from "./native-process-provenance-crypto.mjs";
import { nativeProcessReleaseIdentity, parseNativeReleaseProvenance, type NativeReleaseIdentity } from "./native-process-release-policy.ts";

export { NATIVE_PROVENANCE_PREDICATE };
declare const verifiedProvenance: unique symbol;
export type VerifiedNativeProvenance = Readonly<{ [verifiedProvenance]: true }>;
export type NativeProvenanceVerification = Readonly<{
  identity: NativeReleaseIdentity;
  predicateType: typeof NATIVE_PROVENANCE_PREDICATE;
  provenanceSha256: string; workerSha256: string; bunLockSha256: string;
  node: Readonly<{ version: typeof NATIVE_PROVENANCE_NODE; sha256: string }>;
  sigstore: Readonly<{ version: "4.1.1"; entrySha256: string; manifestSha256: string }>;
}>;
const verified = new WeakMap<VerifiedNativeProvenance, NativeProvenanceVerification>();
function refuse(): never { throw Error("NATIVE_PROCESS_PROVENANCE_VERIFICATION_FAILED"); }
function copyInput(value: Uint8Array, maximum: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) refuse();
  return Buffer.from(value);
}

/** Receipts can be serialized as evidence; only this process's issued token
 * can authorize the caller to use this exact verification result. */
export function nativeProvenanceVerification(token: VerifiedNativeProvenance): NativeProvenanceVerification {
  const value = verified.get(token);
  if (value === undefined) refuse();
  return structuredClone(value);
}

export function nativeProvenanceEnvironment(work: string, node: string): Readonly<Record<string, string>> {
  if (!work.startsWith("/") || resolve(work) !== work || !node.startsWith("/") || resolve(node) !== node) refuse();
  // No ambient NODE_OPTIONS, proxies, CA overrides, credentials, TUF roots or
  // personal HOME/cache enter the pinned verifier's child environment.
  return Object.freeze({ PATH: dirname(node) + ":/usr/bin:/bin", HOME: join(work, "home"),
    TMPDIR: join(work, "tmp"), LANG: "C", LC_ALL: "C", TZ: "UTC" });
}

function privateDirectory(path: string): BigIntStats {
  if (realpathSync(path) !== path || resolve(path) !== path) refuse();
  const value = lstatSync(path, { bigint: true });
  if (!value.isDirectory() || process.getuid === undefined || value.uid !== BigInt(process.getuid())
    || (value.mode & 0o7777n) !== 0o700n) refuse();
  return value;
}
function safeAncestors(path: string): void {
  for (let current = path;; current = dirname(current)) {
    const value = lstatSync(current, { bigint: true });
    if (process.getuid === undefined || !value.isDirectory() || realpathSync(current) !== current
      || (value.uid !== 0n && value.uid !== BigInt(process.getuid()))
      || ((value.mode & 0o022n) !== 0n && !(value.uid === 0n && (value.mode & 0o1000n) !== 0n))) refuse();
    if (dirname(current) === current) return;
  }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.gid === b.gid && a.mode === b.mode
    && a.size === b.size && a.nlink === b.nlink && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
}
function snapshot(path: string, maximum: number) {
  const metadata = lstatSync(path, { bigint: true });
  const bytes = nativeBuildInput(path, maximum);
  if (!sameFile(metadata, lstatSync(path, { bigint: true }))) refuse();
  const sha256 = nativeInputHash(bytes);
  return { bytes, sha256, check() {
    if (!sameFile(metadata, lstatSync(path, { bigint: true }))
      || nativeInputHash(nativeBuildInput(path, maximum)) !== sha256) refuse();
  } };
}
function writeSnapshot(path: string, bytes: Uint8Array): ReturnType<typeof snapshot> {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  return snapshot(path, 1024 * 1024);
}

/** Requires reviewed source and a frozen-lockfile installation before calling.
 * This gate verifies no provider and publishes nothing. Every child uses a new
 * private local-custody root; any failure retains it and all verification inputs.
 * Producing run/attempt comes exclusively from the immutable qualification,
 * never from the later publication execution's environment. */
export async function verifyNativeProcessProvenance(options: Readonly<{
  coordinate: unknown; archive: Uint8Array; checksum: Uint8Array; provenance: Uint8Array;
  /** Existing canonical private directory, outside the source repository. */
  workParent: string;
}>): Promise<VerifiedNativeProvenance> {
  // Snapshot caller-owned bytes before the first asynchronous boundary.
  const archive = copyInput(options.archive, 64 * 1024 * 1024), checksum = copyInput(options.checksum, 4096);
  const provenance = copyInput(options.provenance, 256 * 1024);
  const identity = nativeProcessReleaseIdentity(options.coordinate, archive, checksum, provenance);
  const parsed = parseNativeReleaseProvenance(provenance);
  const subjects = identity.assets.slice(0, 2).map(asset => ({ name: asset.name, digest: { sha256: asset.sha256 } }));
  assertNativeProvenanceStatement(parsed.bundle, parsed.qualification, subjects);
  if (Bun.version !== "1.3.14" || !["darwin", "linux"].includes(process.platform)) refuse();
  const repository = realpathSync(join(import.meta.dir, ".."));
  const parent = resolve(options.workParent);
  if (parent !== options.workParent || parent === repository || parent.startsWith(repository + "/")) refuse();
  safeAncestors(parent); privateDirectory(parent);
  const sources = nativeProcessSourceInventory(repository);
  if (nativeInputHash(Buffer.from(JSON.stringify(sources))) !== identity.coordinate.source.treeSha256) refuse();
  const lock = snapshot(join(repository, "bun.lock"), 4 * 1024 * 1024);
  if (lock.sha256 !== identity.coordinate.source.bunLockSha256) refuse();
  const nodeFound = Bun.which("node"); if (nodeFound === null) refuse();
  const nodePath = realpathSync(nodeFound), node = snapshot(nodePath, 512 * 1024 * 1024);
  const modulePath = realpathSync(fileURLToPath(import.meta.resolve("sigstore")));
  const module = snapshot(modulePath, 1024 * 1024);
  const manifest = snapshot(join(dirname(dirname(modulePath)), "package.json"), 64 * 1024);
  const moduleManifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes));
  if (moduleManifest === null || typeof moduleManifest !== "object" || Array.isArray(moduleManifest)
    || !("name" in moduleManifest) || moduleManifest.name !== "sigstore"
    || !("version" in moduleManifest) || moduleManifest.version !== "4.1.1") refuse();
  const workerSourcePath = join(repository, "scripts/native-process-provenance-crypto.mjs");
  const workerSource = snapshot(workerSourcePath, 1024 * 1024);
  const expectedWorker = sources.find(file => file.path === "scripts/native-process-provenance-crypto.mjs");
  if (expectedWorker?.sha256 !== workerSource.sha256 || expectedWorker.bytes !== workerSource.bytes.length) refuse();
  const work = realpathSync(mkdtempSync(join(parent, ".native-process-provenance-")));
  const workIdentity = privateDirectory(work), parentIdentity = privateDirectory(parent);
  for (const name of ["home", "tmp", "tuf"]) mkdirSync(join(work, name), { mode: 0o700 });
  const workerPath = join(work, "worker.mjs"), worker = writeSnapshot(workerPath, workerSource.bytes);
  const input = JSON.stringify({ bundle: parsed.bundle, qualification: parsed.qualification, subjects });
  if (Buffer.byteLength(input) > 1024 * 1024) refuse();
  const inputSnapshot = writeSnapshot(join(work, "input.json"), Buffer.from(input));
  const environment = nativeProvenanceEnvironment(work, nodePath);
  const assertCurrent = (): void => {
    const current = privateDirectory(work), currentParent = privateDirectory(parent);
    if (current.dev !== workIdentity.dev || current.ino !== workIdentity.ino
      || currentParent.dev !== parentIdentity.dev || currentParent.ino !== parentIdentity.ino) refuse();
    node.check(); worker.check(); workerSource.check(); inputSnapshot.check(); module.check(); manifest.check(); lock.check();
    if (!isDeepStrictEqual(nativeProcessSourceInventory(repository), sources)) refuse();
  };
  const command = async (arguments_: readonly string[], phase: string, stdin?: string): Promise<Buffer> => {
    assertCurrent();
    const result = requireBoundedProcessCleanup(await runBoundedProcess({ executable: nodePath, arguments: arguments_,
      containment: "local", cwd: work, environment, outputMaximumBytes: 8192,
      phase, timeoutMs: 60_000, terminationGraceMs: 500, ...(stdin === undefined ? {} : { stdin }),
    }, { recoveryDirectory: join(work, "recovery") }));
    assertCurrent();
    if (result.exitCode !== 0 || result.stderr.length !== 0) refuse();
    return result.stdout;
  };
  // Version output alone is not genuine-Node proof: the worker also checks
  // process.versions.node and refuses Bun before importing Sigstore.
  if ((await command(["--version"], "native-provenance-node")).toString("utf8") !== `v${NATIVE_PROVENANCE_NODE}\n`) refuse();
  const result = await command([workerPath, pathToFileURL(modulePath).href, join(work, "tuf")], "native-provenance-crypto", input);
  if (result.toString("utf8") !== "verified\n") refuse();
  assertCurrent();
  const receipt: NativeProvenanceVerification = { identity, predicateType: NATIVE_PROVENANCE_PREDICATE,
    provenanceSha256: nativeInputHash(provenance), workerSha256: worker.sha256, bunLockSha256: lock.sha256,
    node: { version: NATIVE_PROVENANCE_NODE, sha256: node.sha256 },
    sigstore: { version: "4.1.1", entrySha256: module.sha256, manifestSha256: manifest.sha256 } };
  // Clean only this exact successfully joined work root. Failed work is retained.
  rmSync(work, { recursive: true });
  const token = Object.freeze({}) as VerifiedNativeProvenance;
  verified.set(token, structuredClone(receipt));
  return token;
}
