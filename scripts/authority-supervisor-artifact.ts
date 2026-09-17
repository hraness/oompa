import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  readSync,
  writeSync,
} from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { dlopen } from "bun:ffi";

import type { Stats } from "node:fs";

export type AuthoritySupervisorArchitecture = "x64" | "arm64";
export type AuthoritySupervisorTarget = "x86_64-linux-musl" | "aarch64-linux-musl";

type PinnedFile = Readonly<{
  byteLength: number;
  maximumByteLength: number;
  mode: number;
  relativePath: string;
  sha256: string;
}>;

type PinnedArtifact = PinnedFile & Readonly<{
  elfMachine: number;
  target: AuthoritySupervisorTarget;
}>;

export type AuthoritySupervisorArtifactManifest = Readonly<{
  artifacts: Readonly<Record<AuthoritySupervisorArchitecture, PinnedArtifact>>;
  compiler: Readonly<{
    name: string;
    version: string;
  }>;
  schemaVersion: number;
  source: PinnedFile;
}>;

const sourceRelativePath = "scripts/authority-supervisor.rs";
const artifactRelativePaths = {
  arm64: "scripts/authority-supervisor-bin/authority-supervisor-linux-arm64-musl",
  x64: "scripts/authority-supervisor-bin/authority-supervisor-linux-x64-musl",
} as const satisfies Readonly<Record<AuthoritySupervisorArchitecture, string>>;

const freezeAuthoritySupervisorArtifactManifest = (
  manifest: AuthoritySupervisorArtifactManifest,
): AuthoritySupervisorArtifactManifest => Object.freeze({
  artifacts: Object.freeze({
    arm64: Object.freeze({ ...manifest.artifacts.arm64 }),
    x64: Object.freeze({ ...manifest.artifacts.x64 }),
  }),
  compiler: Object.freeze({ ...manifest.compiler }),
  schemaVersion: manifest.schemaVersion,
  source: Object.freeze({ ...manifest.source }),
});

export const authoritySupervisorArtifactManifest = freezeAuthoritySupervisorArtifactManifest({
  artifacts: {
    arm64: {
      byteLength: 434_472,
      elfMachine: 183,
      maximumByteLength: 8 * 1024 * 1024,
      mode: 0o755,
      relativePath: artifactRelativePaths.arm64,
      sha256: "ab13e9ca1b6a8961a9e72dfe73f4bd812720d27fc1a16c293ec47b2560151626",
      target: "aarch64-linux-musl",
    },
    x64: {
      byteLength: 478_888,
      elfMachine: 62,
      maximumByteLength: 8 * 1024 * 1024,
      mode: 0o755,
      relativePath: artifactRelativePaths.x64,
      sha256: "c0aac07998a26f43a7a1b2af98dab8600eab6a44340e358f2e6a3faffdc4bc40",
      target: "x86_64-linux-musl",
    },
  },
  compiler: {
    name: "rustc",
    version: "1.97.1",
  },
  schemaVersion: 1,
  source: {
    byteLength: 113_058,
    maximumByteLength: 2 * 1024 * 1024,
    mode: 0o644,
    relativePath: sourceRelativePath,
    sha256: "df7d44e034956b9032e3ba75428dfa3e9e20dbd3fdbdf99c544c42d4c1f324ee",
  },
} as const satisfies AuthoritySupervisorArtifactManifest);

export const authoritySupervisorArtifactRelativePaths = Object.freeze(
  Object.values(artifactRelativePaths),
);

export type AuthoritySupervisorArtifactErrorCode =
  | "authority_supervisor_architecture_unsupported"
  | "authority_supervisor_binary_elf_invalid"
  | "authority_supervisor_binary_hash_mismatch"
  | "authority_supervisor_binary_invalid"
  | "authority_supervisor_execution_path_unavailable"
  | "authority_supervisor_manifest_invalid"
  | "authority_supervisor_platform_unsupported"
  | "authority_supervisor_source_hash_mismatch"
  | "authority_supervisor_source_invalid";

export class AuthoritySupervisorArtifactError extends Error {
  constructor(readonly code: AuthoritySupervisorArtifactErrorCode) {
    super(`Authority supervisor artifact refused (${code}).`);
    this.name = "AuthoritySupervisorArtifactError";
  }
}

export const isAuthoritySupervisorArtifactError = (
  value: unknown,
): value is AuthoritySupervisorArtifactError => value instanceof AuthoritySupervisorArtifactError;

export type ResolvedAuthoritySupervisorArtifact = Readonly<{
  architecture: AuthoritySupervisorArchitecture;
  byteLength: number;
  sha256: string;
  target: AuthoritySupervisorTarget;
}>;

export type OpenAuthoritySupervisorArtifact = Readonly<{
  artifact: ResolvedAuthoritySupervisorArtifact;
  // Close only after the child reports a successful spawn. The parent proc-fd
  // path is intentionally unusable once this promise resolves.
  close: () => Promise<void>;
  // This is a sealed memfd path, never a checked-in artifact pathname.
  executionPath: string;
}>;

export type VerifiedAuthoritySupervisorArtifactForTesting =
  ResolvedAuthoritySupervisorArtifact & Readonly<{ path: string }>;

type PinnedFileKind = "source" | "binary";

type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  mode: number;
  nlink: number;
  size: number;
  uid: number;
}>;

const isPinnedSha256 = (value: string): boolean =>
  /^[0-9a-f]{64}$/u.test(value);

const sha256 = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const artifactError = (code: AuthoritySupervisorArtifactErrorCode): never => {
  throw new AuthoritySupervisorArtifactError(code);
};

const sourceErrorCode = (kind: PinnedFileKind): AuthoritySupervisorArtifactErrorCode =>
  kind === "source" ? "authority_supervisor_source_invalid" : "authority_supervisor_binary_invalid";

const sourceHashErrorCode = (kind: PinnedFileKind): AuthoritySupervisorArtifactErrorCode =>
  kind === "source"
    ? "authority_supervisor_source_hash_mismatch"
    : "authority_supervisor_binary_hash_mismatch";

const identityOf = (metadata: Stats): FileIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
  mode: metadata.mode & 0o7777,
  nlink: metadata.nlink,
  size: metadata.size,
  uid: metadata.uid,
});

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.mode === right.mode
  && left.nlink === right.nlink
  && left.size === right.size
  && left.uid === right.uid;

const expectedArchitecture = (architecture: string): AuthoritySupervisorArchitecture => {
  if (architecture === "x64" || architecture === "arm64") return architecture;
  return artifactError("authority_supervisor_architecture_unsupported");
};

const expectedUid = (): number | undefined =>
  typeof process.getuid === "function" ? process.getuid() : undefined;

const assertManifest = (manifest: AuthoritySupervisorArtifactManifest): void => {
  if (
    manifest.schemaVersion !== 1
    || manifest.compiler.name !== "rustc"
    || manifest.compiler.version !== "1.97.1"
    || manifest.source.relativePath !== sourceRelativePath
    || manifest.source.mode !== 0o644
    || manifest.artifacts.x64.relativePath !== artifactRelativePaths.x64
    || manifest.artifacts.x64.mode !== 0o755
    || manifest.artifacts.x64.target !== "x86_64-linux-musl"
    || manifest.artifacts.x64.elfMachine !== 62
    || manifest.artifacts.arm64.relativePath !== artifactRelativePaths.arm64
    || manifest.artifacts.arm64.mode !== 0o755
    || manifest.artifacts.arm64.target !== "aarch64-linux-musl"
    || manifest.artifacts.arm64.elfMachine !== 183
  ) artifactError("authority_supervisor_manifest_invalid");

  const pinnedFiles: readonly PinnedFile[] = [
    manifest.source,
    manifest.artifacts.x64,
    manifest.artifacts.arm64,
  ];
  if (
    pinnedFiles.some((file) =>
      !Number.isSafeInteger(file.byteLength)
      || file.byteLength <= 0
      || !Number.isSafeInteger(file.maximumByteLength)
      || file.maximumByteLength < file.byteLength
      || !isPinnedSha256(file.sha256))
  ) artifactError("authority_supervisor_manifest_invalid");
};

const canonicalRepositoryRoot = async (repositoryRoot: string): Promise<string> => {
  try {
    return await realpath(repositoryRoot);
  } catch {
    return artifactError("authority_supervisor_manifest_invalid");
  }
};

const canonicalPinnedPath = async (
  repositoryRoot: string,
  pinnedFile: PinnedFile,
  kind: PinnedFileKind,
): Promise<string> => {
  const path = resolve(repositoryRoot, pinnedFile.relativePath);
  const expectedRelativePath = pinnedFile.relativePath.split("/").join(sep);
  if (relative(repositoryRoot, path) !== expectedRelativePath) {
    return artifactError(sourceErrorCode(kind));
  }
  try {
    if (await realpath(path) !== path) return artifactError(sourceErrorCode(kind));
  } catch {
    return artifactError(sourceErrorCode(kind));
  }
  return path;
};

const assertPinnedMetadata = (
  metadata: Stats,
  pinnedFile: PinnedFile,
  owner: number | undefined,
  kind: PinnedFileKind,
): void => {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || owner === undefined
    || metadata.uid !== owner
    || (metadata.mode & 0o7777) !== pinnedFile.mode
    || metadata.size !== pinnedFile.byteLength
    || metadata.size > pinnedFile.maximumByteLength
  ) artifactError(sourceErrorCode(kind));
};

const byteAt = (bytes: Uint8Array, index: number): number => {
  const value = bytes[index];
  if (value === undefined) return artifactError("authority_supervisor_binary_elf_invalid");
  return value;
};

const assertExpectedElf = (bytes: Uint8Array, artifact: PinnedArtifact): void => {
  if (
    bytes.byteLength < 64
    || byteAt(bytes, 0) !== 0x7f
    || byteAt(bytes, 1) !== 0x45
    || byteAt(bytes, 2) !== 0x4c
    || byteAt(bytes, 3) !== 0x46
    || byteAt(bytes, 4) !== 2
    || byteAt(bytes, 5) !== 1
    || byteAt(bytes, 6) !== 1
    || (byteAt(bytes, 18) | byteAt(bytes, 19) << 8) !== artifact.elfMachine
  ) artifactError("authority_supervisor_binary_elf_invalid");
};

type OpenPinnedFile = Readonly<{
  bytes: Uint8Array;
  close: () => Promise<void>;
  path: string;
}>;

const openPinnedFile = async (
  repositoryRoot: string,
  pinnedFile: PinnedFile,
  kind: PinnedFileKind,
  owner: number | undefined,
): Promise<OpenPinnedFile> => {
  const path = await canonicalPinnedPath(repositoryRoot, pinnedFile, kind);
  let before: Stats;
  try {
    before = await lstat(path);
  } catch {
    return artifactError(sourceErrorCode(kind));
  }
  assertPinnedMetadata(before, pinnedFile, owner, kind);
  const beforeIdentity = identityOf(before);

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return artifactError(sourceErrorCode(kind));
  }
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= handle.close();
    return closePromise;
  };
  try {
    const throughHandle = await handle.stat().catch(() => artifactError(sourceErrorCode(kind)));
    assertPinnedMetadata(throughHandle, pinnedFile, owner, kind);
    if (!sameIdentity(beforeIdentity, identityOf(throughHandle))) {
      return artifactError(sourceErrorCode(kind));
    }
    const bytes = await handle.readFile().catch(() => artifactError(sourceErrorCode(kind)));
    if (
      bytes.byteLength !== pinnedFile.byteLength
      || bytes.byteLength > pinnedFile.maximumByteLength
      || sha256(bytes) !== pinnedFile.sha256
    ) return artifactError(sourceHashErrorCode(kind));
    const after = await lstat(path).catch(() => artifactError(sourceErrorCode(kind)));
    assertPinnedMetadata(after, pinnedFile, owner, kind);
    if (!sameIdentity(beforeIdentity, identityOf(after))) {
      return artifactError(sourceErrorCode(kind));
    }
    return {
      bytes,
      close,
      path,
    };
  } catch (error: unknown) {
    await close().catch(() => undefined);
    throw error;
  }
};

const artifactFor = (
  manifest: AuthoritySupervisorArtifactManifest,
  architecture: AuthoritySupervisorArchitecture,
): PinnedArtifact => manifest.artifacts[architecture];

type ResolverOptions = Readonly<{
  architecture: string;
  manifest: AuthoritySupervisorArtifactManifest;
  owner: number | undefined;
  platform: string;
  repositoryRoot: string;
}>;

const artifactIdentity = (
  architecture: AuthoritySupervisorArchitecture,
  artifact: PinnedArtifact,
): ResolvedAuthoritySupervisorArtifact => Object.freeze({
  architecture,
  byteLength: artifact.byteLength,
  sha256: artifact.sha256,
  target: artifact.target,
});

const memfdCloseOnExec = 0x0001;
const memfdAllowSealing = 0x0002;
// Linux 6.3 added MFD_EXEC. Older kernels reject it but permit execution for
// ordinary memfds, so materialization retries without it below.
const memfdExecutable = 0x0010;
const fAddSeals = 1033;
const fGetSeals = 1034;
const fSealSeal = 0x0001;
const fSealShrink = 0x0002;
const fSealGrow = 0x0004;
const fSealWrite = 0x0008;
const requiredMemfdSeals = fSealSeal | fSealShrink | fSealGrow | fSealWrite;
const sealedMemoryFileName = Buffer.from("hra-authority-supervisor\0", "utf8");

type LinuxMemfdLibrary = Readonly<{
  close: () => void;
  symbols: Readonly<{
    fcntl: (descriptor: number, command: number, argument: number) => number;
    memfd_create: (name: Uint8Array, flags: number) => number;
  }>;
}>;

const linuxLibcCandidates = (): readonly string[] => {
  if (process.arch === "x64") {
    return [
      "/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/lib64/libc.so.6",
      "/usr/lib64/libc.so.6",
      "/lib/libc.musl-x86_64.so.1",
      "/usr/lib/libc.musl-x86_64.so.1",
      "/lib/ld-musl-x86_64.so.1",
      "/usr/lib/ld-musl-x86_64.so.1",
    ];
  }
  if (process.arch === "arm64") {
    return [
      "/lib/aarch64-linux-gnu/libc.so.6",
      "/usr/lib/aarch64-linux-gnu/libc.so.6",
      "/lib64/libc.so.6",
      "/usr/lib64/libc.so.6",
      "/lib/libc.musl-aarch64.so.1",
      "/usr/lib/libc.musl-aarch64.so.1",
      "/lib/ld-musl-aarch64.so.1",
      "/usr/lib/ld-musl-aarch64.so.1",
    ];
  }
  return [];
};

let processLinuxMemfdLibrary: LinuxMemfdLibrary | undefined;

const linuxMemfdLibrary = (): LinuxMemfdLibrary => {
  if (processLinuxMemfdLibrary !== undefined) return processLinuxMemfdLibrary;
  for (const candidate of linuxLibcCandidates()) {
    try {
      const library: LinuxMemfdLibrary = dlopen(candidate, {
        fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
        memfd_create: { args: ["cstring", "u32"], returns: "i32" },
      } as const);
      processLinuxMemfdLibrary = library;
      return library;
    } catch {
      // The release image may use musl rather than glibc. Try its libc path.
    }
  }
  return artifactError("authority_supervisor_execution_path_unavailable");
};

const writeAll = (descriptor: number, bytes: Uint8Array): void => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null);
    if (!Number.isSafeInteger(written) || written <= 0) {
      return artifactError("authority_supervisor_execution_path_unavailable");
    }
    offset += written;
  }
};

const readAll = (descriptor: number, byteLength: number): Buffer => {
  const bytes = Buffer.alloc(byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
    if (!Number.isSafeInteger(read) || read <= 0) {
      return artifactError("authority_supervisor_execution_path_unavailable");
    }
    offset += read;
  }
  return bytes;
};

type SealedExecutionArtifact = Readonly<{
  close: () => Promise<void>;
  executionPath: string;
  identity: FileIdentity;
}>;

const materializeSealedExecutionArtifact = (
  bytes: Uint8Array,
  expectedSha256: string,
): SealedExecutionArtifact => {
  const library = linuxMemfdLibrary();
  let descriptor = library.symbols.memfd_create(
    sealedMemoryFileName,
    memfdCloseOnExec | memfdAllowSealing | memfdExecutable,
  );
  if (descriptor < 0) {
    descriptor = library.symbols.memfd_create(
      sealedMemoryFileName,
      memfdCloseOnExec | memfdAllowSealing,
    );
  }
  if (descriptor < 0) {
    return artifactError("authority_supervisor_execution_path_unavailable");
  }

  try {
    fchmodSync(descriptor, 0o755);
    writeAll(descriptor, bytes);
    const beforeSealing = fstatSync(descriptor);
    if (
      !beforeSealing.isFile()
      || beforeSealing.size !== bytes.byteLength
      || (beforeSealing.mode & 0o777) !== 0o755
    ) return artifactError("authority_supervisor_execution_path_unavailable");
    if (library.symbols.fcntl(descriptor, fAddSeals, requiredMemfdSeals) !== 0) {
      return artifactError("authority_supervisor_execution_path_unavailable");
    }
    const seals = library.symbols.fcntl(descriptor, fGetSeals, 0);
    if (seals !== requiredMemfdSeals) {
      return artifactError("authority_supervisor_execution_path_unavailable");
    }
    if (sha256(readAll(descriptor, bytes.byteLength)) !== expectedSha256) {
      return artifactError("authority_supervisor_execution_path_unavailable");
    }
    const executionPath = `/proc/${String(process.pid)}/fd/${String(descriptor)}`;
    const sealedMetadata = fstatSync(descriptor);
    if (
      !sealedMetadata.isFile()
      || sealedMetadata.size !== bytes.byteLength
      || (sealedMetadata.mode & 0o777) !== 0o755
    ) return artifactError("authority_supervisor_execution_path_unavailable");

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= Promise.resolve().then(() => {
        closeSync(descriptor);
      });
      return closePromise;
    };
    return Object.freeze({
      close,
      executionPath,
      identity: identityOf(sealedMetadata),
    });
  } catch {
    try {
      closeSync(descriptor);
    } catch {
      // A failed materialization is never returned to the caller.
    }
    return artifactError("authority_supervisor_execution_path_unavailable");
  }
};

const verifyAuthoritySupervisorArtifactWith = async (
  options: ResolverOptions,
): Promise<VerifiedAuthoritySupervisorArtifactForTesting> => {
  if (options.platform !== "linux") {
    return artifactError("authority_supervisor_platform_unsupported");
  }
  assertManifest(options.manifest);
  const architecture = expectedArchitecture(options.architecture);
  const root = await canonicalRepositoryRoot(options.repositoryRoot);
  const source = await openPinnedFile(root, options.manifest.source, "source", options.owner);
  try {
    const artifact = artifactFor(options.manifest, architecture);
    const binary = await openPinnedFile(root, artifact, "binary", options.owner);
    try {
      assertExpectedElf(binary.bytes, artifact);
      return Object.freeze({
        ...artifactIdentity(architecture, artifact),
        path: binary.path,
      });
    } finally {
      await binary.close().catch(() => undefined);
    }
  } finally {
    await source.close().catch(() => undefined);
  }
};

const openAuthoritySupervisorArtifactWith = async (
  options: ResolverOptions,
): Promise<OpenAuthoritySupervisorArtifact> => {
  if (options.platform !== "linux" || process.platform !== "linux") {
    return artifactError("authority_supervisor_platform_unsupported");
  }
  assertManifest(options.manifest);
  const architecture = expectedArchitecture(options.architecture);
  const root = await canonicalRepositoryRoot(options.repositoryRoot);
  const source = await openPinnedFile(root, options.manifest.source, "source", options.owner);
  try {
    const artifact = artifactFor(options.manifest, architecture);
    const binary = await openPinnedFile(root, artifact, "binary", options.owner);
    try {
      assertExpectedElf(binary.bytes, artifact);
      const sealed = materializeSealedExecutionArtifact(binary.bytes, artifact.sha256);
      try {
        const throughProc = await stat(sealed.executionPath).catch(() =>
        artifactError("authority_supervisor_execution_path_unavailable"));
        if (
          !throughProc.isFile()
          || throughProc.size !== artifact.byteLength
          || (throughProc.mode & 0o777) !== 0o755
          || !sameIdentity(sealed.identity, identityOf(throughProc))
        ) {
          return artifactError("authority_supervisor_execution_path_unavailable");
        }
        return Object.freeze({
          artifact: artifactIdentity(architecture, artifact),
          close: sealed.close,
          executionPath: sealed.executionPath,
        });
      } catch (error: unknown) {
        await sealed.close().catch(() => undefined);
        throw error;
      }
    } finally {
      await binary.close().catch(() => undefined);
    }
  } finally {
    await source.close().catch(() => undefined);
  }
};

export async function resolveAuthoritySupervisorArtifact(): Promise<ResolvedAuthoritySupervisorArtifact> {
  const verified = await verifyAuthoritySupervisorArtifactWith({
    architecture: process.arch,
    manifest: authoritySupervisorArtifactManifest,
    owner: expectedUid(),
    platform: process.platform,
    repositoryRoot: resolve(import.meta.dir, ".."),
  });
  return Object.freeze({
    architecture: verified.architecture,
    byteLength: verified.byteLength,
    sha256: verified.sha256,
    target: verified.target,
  });
}

export async function openAuthoritySupervisorArtifact(): Promise<OpenAuthoritySupervisorArtifact> {
  return openAuthoritySupervisorArtifactWith({
    architecture: process.arch,
    manifest: authoritySupervisorArtifactManifest,
    owner: expectedUid(),
    platform: process.platform,
    repositoryRoot: resolve(import.meta.dir, ".."),
  });
}

export type AuthoritySupervisorArtifactTestOptions = Readonly<{
  architecture?: string;
  manifest?: AuthoritySupervisorArtifactManifest;
  owner?: number | undefined;
  platform?: string;
  repositoryRoot: string;
}>;

// This returns a mutable pathname only for direct fixture tests. Production
// authority execution must use openAuthoritySupervisorArtifact instead.
export async function resolveAuthoritySupervisorArtifactForTesting(
  options: AuthoritySupervisorArtifactTestOptions,
): Promise<VerifiedAuthoritySupervisorArtifactForTesting> {
  return verifyAuthoritySupervisorArtifactWith({
    architecture: options.architecture ?? "x64",
    manifest: options.manifest ?? authoritySupervisorArtifactManifest,
    owner: options.owner ?? expectedUid(),
    platform: options.platform ?? "linux",
    repositoryRoot: options.repositoryRoot,
  });
}

export async function openAuthoritySupervisorArtifactForTesting(
  options: AuthoritySupervisorArtifactTestOptions,
): Promise<OpenAuthoritySupervisorArtifact> {
  return openAuthoritySupervisorArtifactWith({
    architecture: options.architecture ?? "x64",
    manifest: options.manifest ?? authoritySupervisorArtifactManifest,
    owner: options.owner ?? expectedUid(),
    platform: options.platform ?? process.platform,
    repositoryRoot: options.repositoryRoot,
  });
}

export const isAuthoritySupervisorArtifactRelativePath = (
  relativePath: string,
): relativePath is typeof authoritySupervisorArtifactRelativePaths[number] =>
  authoritySupervisorArtifactRelativePaths.some((candidate) => candidate === relativePath);

export async function assertAuthoritySupervisorArtifactPublicFile(
  repositoryRoot: string,
  relativePath: string,
): Promise<void> {
  if (!isAuthoritySupervisorArtifactRelativePath(relativePath)) {
    return artifactError("authority_supervisor_manifest_invalid");
  }
  assertManifest(authoritySupervisorArtifactManifest);
  const root = await canonicalRepositoryRoot(repositoryRoot);
  const source = await openPinnedFile(
    root,
    authoritySupervisorArtifactManifest.source,
    "source",
    expectedUid(),
  );
  await source.close().catch(() => undefined);
  const artifact = Object.values(authoritySupervisorArtifactManifest.artifacts)
    .find((candidate) => candidate.relativePath === relativePath);
  if (artifact === undefined) return artifactError("authority_supervisor_manifest_invalid");
  const binary = await openPinnedFile(root, artifact, "binary", expectedUid());
  try {
    assertExpectedElf(binary.bytes, artifact);
  } finally {
    await binary.close().catch(() => undefined);
  }
}
