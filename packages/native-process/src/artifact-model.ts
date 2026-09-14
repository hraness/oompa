/** The release pipeline, not this parser, establishes authenticated provenance
 * and target qualification. The resolver requires its trusted manifest pin. */
export const NATIVE_PACKAGE_NAME = "@hraness/native-process";
export const NATIVE_PACKAGE_VERSION = "0.1.0";
export const NATIVE_QUALIFICATION_PROFILE = "native-process-v1-posix-custody";
export const NATIVE_QUALIFICATION_VERSION = 1;
export const MAX_NATIVE_MANIFEST_BYTES = 256 * 1024;
export const MAX_NATIVE_CLIENT_BYTES = 1024 * 1024;
export const MAX_NATIVE_ARTIFACT_BYTES = 32 * 1024 * 1024;
export const MAX_NATIVE_EVIDENCE_BYTES = 256 * 1024;
export const MAX_NATIVE_LICENSE_BYTES = 256 * 1024;
export const NATIVE_CLIENT_FILES = Object.freeze([
  "package.json", "src/artifact-model.ts", "src/artifact-resolver.ts", "src/byte-queue.ts",
  "src/identity.ts", "src/index.ts", "src/observation-protocol.ts", "src/observer.ts",
  "src/process-port.ts", "src/protocol.ts", "src/transport.ts",
] as const);
export const NATIVE_ARTIFACT_TARGETS = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin", "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl", "linux-x64": "x86_64-unknown-linux-musl",
} as const);
export type NativeArtifactTarget = keyof typeof NATIVE_ARTIFACT_TARGETS;
export type NativeClientFile = Readonly<{ path: typeof NATIVE_CLIENT_FILES[number]; bytes: number; sha256: string }>;
export type NativeArtifact = Readonly<{
  target: NativeArtifactTarget; rustTarget: typeof NATIVE_ARTIFACT_TARGETS[NativeArtifactTarget];
  scope: "posix-process-group"; bytes: number; sha256: string;
  qualificationProfile: typeof NATIVE_QUALIFICATION_PROFILE;
  qualificationVersion: typeof NATIVE_QUALIFICATION_VERSION; qualificationSha256: string;
}>;
export type NativeArtifactManifest = Readonly<{
  formatVersion: 1; package: typeof NATIVE_PACKAGE_NAME; version: typeof NATIVE_PACKAGE_VERSION;
  protocolVersion: 1; licensesSha256: string;
  source: Readonly<{
    commitSha: string; treeSha256: string; bunLockSha256: string; cargoLockSha256: string;
    toolchainSha256: string; rustVersion: "1.97.1"; bunVersion: "1.3.14"; profile: "release";
  }>;
  client: readonly NativeClientFile[]; artifacts: readonly NativeArtifact[];
}>;

export class NativeArtifactError extends Error {
  constructor(readonly reason: "invalid-manifest" | "invalid-executable" | "unsupported-target"
    | "admission-failed" | "image-changed" | "invalid-capability") {
    super(`Native artifact failed: ${reason}.`);
    this.name = "NativeArtifactError";
  }
}
export const isNativeSha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);

function invalid(): never { throw new NativeArtifactError("invalid-manifest"); }
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const properties = Reflect.ownKeys(value);
  if (properties.length !== keys.length) invalid();
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of properties) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !keys.includes(key) || property === undefined || !Object.hasOwn(property, "value")) invalid();
    result[key] = property.value;
  }
  return result;
}
function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, index): unknown => {
    const property = Object.getOwnPropertyDescriptor(value, index);
    if (property === undefined || !Object.hasOwn(property, "value")) invalid();
    return property.value;
  });
}
function count(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
}
function digest(value: unknown): string { if (!isNativeSha256(value)) invalid(); return value; }

export function parseNativeArtifactManifest(value: unknown): NativeArtifactManifest {
  try {
    const raw = record(value, ["formatVersion", "package", "version", "protocolVersion", "licensesSha256", "source", "client", "artifacts"]);
    if (raw.formatVersion !== 1 || raw.package !== NATIVE_PACKAGE_NAME || raw.version !== NATIVE_PACKAGE_VERSION
      || raw.protocolVersion !== 1) invalid();
    const source = record(raw.source, ["commitSha", "treeSha256", "bunLockSha256", "cargoLockSha256", "toolchainSha256",
      "rustVersion", "bunVersion", "profile"]);
    if (typeof source.commitSha !== "string" || !/^[a-f0-9]{40}$/u.test(source.commitSha)
      || source.rustVersion !== "1.97.1" || source.bunVersion !== "1.3.14" || source.profile !== "release") invalid();
    const clients = array(raw.client, NATIVE_CLIENT_FILES.length);
    if (clients.length !== NATIVE_CLIENT_FILES.length) invalid();
    let clientBytes = 0;
    const client = clients.map((entry, index): NativeClientFile => {
      const file = record(entry, ["path", "bytes", "sha256"]);
      const path = NATIVE_CLIENT_FILES[index];
      if (path === undefined || file.path !== path) invalid();
      const bytes = count(file.bytes, 1, MAX_NATIVE_CLIENT_BYTES);
      clientBytes += bytes;
      return Object.freeze({ path, bytes, sha256: digest(file.sha256) });
    });
    if (clientBytes > 4 * MAX_NATIVE_CLIENT_BYTES) invalid();
    const seen = new Set<NativeArtifactTarget>();
    const artifacts = array(raw.artifacts, 4).map((entry): NativeArtifact => {
      const file = record(entry, ["target", "rustTarget", "scope", "bytes", "sha256",
        "qualificationProfile", "qualificationVersion", "qualificationSha256"]);
      if (typeof file.target !== "string" || !Object.hasOwn(NATIVE_ARTIFACT_TARGETS, file.target)) invalid();
      const target = file.target as NativeArtifactTarget;
      if (seen.has(target) || file.rustTarget !== NATIVE_ARTIFACT_TARGETS[target] || file.scope !== "posix-process-group"
        || file.qualificationProfile !== NATIVE_QUALIFICATION_PROFILE || file.qualificationVersion !== NATIVE_QUALIFICATION_VERSION) invalid();
      seen.add(target);
      return Object.freeze({ target, rustTarget: NATIVE_ARTIFACT_TARGETS[target], scope: "posix-process-group",
        bytes: count(file.bytes, 64, MAX_NATIVE_ARTIFACT_BYTES), sha256: digest(file.sha256),
        qualificationProfile: NATIVE_QUALIFICATION_PROFILE, qualificationVersion: NATIVE_QUALIFICATION_VERSION,
        qualificationSha256: digest(file.qualificationSha256) });
    });
    return Object.freeze({ formatVersion: 1, package: NATIVE_PACKAGE_NAME, version: NATIVE_PACKAGE_VERSION,
      protocolVersion: 1, licensesSha256: digest(raw.licensesSha256), source: Object.freeze({ commitSha: source.commitSha, treeSha256: digest(source.treeSha256),
        bunLockSha256: digest(source.bunLockSha256), cargoLockSha256: digest(source.cargoLockSha256),
        toolchainSha256: digest(source.toolchainSha256), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" }),
      client: Object.freeze(client), artifacts: Object.freeze(artifacts) });
  } catch { throw new NativeArtifactError("invalid-manifest"); }
}

export type NativeLicenseFile = Readonly<{ path: string; bytes: number; sha256: string }>;
export type NativeLicenseManifest = Readonly<{ formatVersion: 1; crates: readonly Readonly<{
  name: string; version: string; license: string; files: readonly NativeLicenseFile[];
}>[] }>;

/** License paths are relative to native-artifacts/licenses. The pinned parent
 * manifest authenticates this index, which authenticates each listed text. */
export function parseNativeLicenseManifest(value: unknown): NativeLicenseManifest {
  try {
    const raw = record(value, ["formatVersion", "crates"]);
    if (raw.formatVersion !== 1) invalid();
    const names = new Set<string>(), paths = new Set<string>();
    let files = 0, bytes = 0;
    const crates = array(raw.crates, 128).map(entry => {
      const crate = record(entry, ["name", "version", "license", "files"]);
      if (typeof crate.name !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(crate.name)
        || typeof crate.version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(crate.version)
        || crate.version.length > 128 || typeof crate.license !== "string"
        || crate.license.length < 1 || crate.license.length > 256 || !/^[a-zA-Z0-9(). +:-]+$/u.test(crate.license)) invalid();
      const key = crate.name + "@" + crate.version;
      if (names.has(key)) invalid();
      names.add(key);
      const listed = array(crate.files, 256).map(item => {
        const file = record(item, ["path", "bytes", "sha256"]);
        if (typeof file.path !== "string" || file.path.length > 384 || file.path === "manifest.json"
          || !/^[a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+){0,3}$/u.test(file.path)
          || file.path.split("/").some(part => part === "." || part === "..")
          || paths.has(file.path)) invalid();
        paths.add(file.path);
        files += 1;
        const length = count(file.bytes, 1, MAX_NATIVE_LICENSE_BYTES);
        bytes += length;
        if (files > 256 || bytes > 4 * 1024 * 1024) invalid();
        return Object.freeze({ path: file.path, bytes: length, sha256: digest(file.sha256) });
      });
      if (listed.length === 0) invalid();
      return Object.freeze({ name: crate.name, version: crate.version, license: crate.license, files: Object.freeze(listed) });
    });
    if (crates.length === 0) invalid();
    return Object.freeze({ formatVersion: 1, crates: Object.freeze(crates) });
  } catch { throw new NativeArtifactError("invalid-manifest"); }
}

export function parseNativeArtifactAdmissionOptions(value: unknown): Readonly<{ imageRoot: string; manifestSha256: string }> {
  try {
    const raw = record(value, ["imageRoot", "manifestSha256"]);
    if (typeof raw.imageRoot !== "string" || raw.imageRoot.length < 1 || raw.imageRoot.length > 4096) invalid();
    return Object.freeze({ imageRoot: raw.imageRoot, manifestSha256: digest(raw.manifestSha256) });
  } catch { throw new NativeArtifactError("admission-failed"); }
}

export function nativeArtifactTarget(platform: string, architecture: string): NativeArtifactTarget | null {
  const target = `${platform}-${architecture}`;
  return Object.hasOwn(NATIVE_ARTIFACT_TARGETS, target) ? target as NativeArtifactTarget : null;
}

/** Header validation identifies the listed format and architecture. Executable
 * hashes and the release qualification profile provide independent requirements. */
export function assertNativeExecutableHeader(bytes: Uint8Array, artifact: NativeArtifact): void {
  const fail = (): never => { throw new NativeArtifactError("invalid-executable"); };
  if (bytes.byteLength !== artifact.bytes || bytes.byteLength < 64 || bytes.byteLength > MAX_NATIVE_ARTIFACT_BYTES) fail();
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (artifact.target.startsWith("darwin-")) {
    const arm64 = artifact.target === "darwin-arm64";
    if (data.getUint32(0, true) !== 0xfeedfacf || data.getUint32(4, true) !== (arm64 ? 0x0100000c : 0x01000007)
      || (data.getUint32(8, true) & 0x00ffffff) !== (arm64 ? 0 : 3) || data.getUint32(12, true) !== 2) fail();
    const commands = data.getUint32(16, true), commandBytes = data.getUint32(20, true);
    if (commands < 1 || commands > 512 || commandBytes > 1024 * 1024 || commandBytes > bytes.byteLength - 32) fail();
    let offset = 32;
    for (let index = 0; index < commands; index += 1) {
      if (offset + 8 > 32 + commandBytes) fail();
      const length = data.getUint32(offset + 4, true);
      if (length < 8 || length % 8 !== 0 || offset + length > 32 + commandBytes) fail();
      offset += length;
    }
    if (offset !== 32 + commandBytes) fail();
    return;
  }
  if (data.getUint32(0, false) !== 0x7f454c46 || data.getUint8(4) !== 2 || data.getUint8(5) !== 1
    || data.getUint8(6) !== 1 || ![0, 3].includes(data.getUint8(7)) || ![2, 3].includes(data.getUint16(16, true))
    || data.getUint16(18, true) !== (artifact.target === "linux-arm64" ? 183 : 62) || data.getUint32(20, true) !== 1
    || data.getUint16(52, true) !== 64 || data.getUint16(54, true) !== 56) fail();
  const programOffset = data.getBigUint64(32, true), programs = data.getUint16(56, true);
  if (programs < 1 || programs > 128 || programOffset < 64n || programOffset + BigInt(programs * 56) > BigInt(bytes.byteLength)) fail();
  // Static musl is the admitted Linux ABI. A dynamic interpreter must not add
  // an ambient loader dependency hidden behind a correctly named target.
  for (let index = 0; index < programs; index += 1) {
    if (data.getUint32(Number(programOffset) + index * 56, true) === 3) fail();
  }
}
