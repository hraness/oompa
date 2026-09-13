import { createHash, randomUUID } from "node:crypto";
import { dlopen, ptr, read, toBuffer, type Pointer } from "bun:ffi";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  writeSync,
  type Stats,
} from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

export const OOMPA_INSTALL_BUN_VERSION = "1.3.14";
export const OOMPA_INSTALL_PACKAGE_NAME = "@hraness/oompa";
const OOMPA_LEGACY_INSTALL_PACKAGE_NAME = "hra";
export const OOMPA_INSTALL_PACKAGE_VERSION = "0.8.1";
export const OOMPA_INSTALL_CLI_SHA256 = "6f62b55d89cd60df91e2d4f6e0ec321ba44ffd6e0011d350d91326a73835f432";
export const OOMPA_INSTALL_NORMALIZER_SHA256 = "fb91f7047cd0fe5b04930eeab5ca863291879851f081efa783157a8e16c6b70a";
export const OOMPA_INSTALL_ARCHIVE_URL = "https://github.com/hraness/oompa/releases/download/v0.8.1/hraness-oompa-0.8.1.tgz";
export const OOMPA_INSTALL_ARCHIVE_NAME = "hraness-oompa-0.8.1.tgz";
export const OOMPA_INSTALL_RELEASE_API_URL = "https://api.github.com/repos/hraness/oompa/releases/tags/v0.8.1";
export const OOMPA_INSTALL_RELEASE_TAG = "v0.8.1";
export const OOMPA_INSTALL_REPOSITORY_API_URL = "https://api.github.com/repos/hraness/oompa";
export const OOMPA_INSTALL_REPOSITORY_ID = 1_343_008_607;
export const OOMPA_INSTALL_SUCCESS = "hra-install-safe";
export const OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES = [
  "BUN_OPTIONS",
  "NODE_OPTIONS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_ORIGIN_PATH",
  "LD_PRELOAD",
  "DYLD_FALLBACK_FRAMEWORK_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_IMAGE_SUFFIX",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_ROOT_PATH",
  "DYLD_VERSIONED_FRAMEWORK_PATH",
  "DYLD_VERSIONED_LIBRARY_PATH",
] as const;

export const sanitizeOompaInstallChildEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (
      value !== undefined
      && !OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES.includes(
        name as (typeof OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES)[number],
      )
    ) sanitized[name] = value;
  }
  return sanitized;
};

const authorityDocumentMaximumBytes = 64 * 1024;
const archiveMaximumBytes = 64 * 1024 * 1024;
const releaseRecordMaximumBytes = 256 * 1024;
const releaseAssetMaximumCount = 256;
const releaseRecordDeadlineMilliseconds = 30 * 1000;
const releaseAssetDeadlineMilliseconds = 5 * 60 * 1000;
const installTreeByteMaximum = 2 * 1024 * 1024 * 1024;
const installTreeEntryMaximum = 100_000;
const darwinAclTypeExtended = 0x00000100;
const darwinAclExtendedAllow = 1;
const darwinAclEntryMaximum = 169;
const darwinDangerousMutationPermissions = [
  1 << 2,
  1 << 4,
  1 << 5,
  1 << 6,
  1 << 8,
  1 << 10,
  1 << 12,
  1 << 13,
] as const;
const lifecycleScriptNames = new Set([
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "prepublish",
  "prepublishOnly",
  "preprepare",
  "prepare",
  "postprepare",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
  "predependencies",
  "dependencies",
  "postdependencies",
  "preversion",
  "version",
  "postversion",
]);

type ArchiveIdentityBase = Readonly<{
  archiveBytes: number;
  archiveSha256: string;
}>;

type OfficialArchiveIdentity = ArchiveIdentityBase & Readonly<{
  archiveAssetId: number;
  archiveReleaseId: number;
  archiveReleaseTag: string;
  archiveRepositoryId: number;
  archiveSource: "official";
}>;

type LocalArchiveIdentity = ArchiveIdentityBase & Readonly<{
  archiveAssetId: null;
  archiveReleaseId: null;
  archiveReleaseTag: null;
  archiveRepositoryId: null;
  archiveSource: "local";
}>;

export type OompaInstallArchiveIdentity = OfficialArchiveIdentity | LocalArchiveIdentity;

type VersionIdentity = OompaInstallArchiveIdentity & Readonly<{
  cliSha256: string;
  normalizerSha256: string;
  packageVersion: string;
}>;

type ReleaseIdentity = VersionIdentity & Readonly<{
  packageName: typeof OOMPA_INSTALL_PACKAGE_NAME;
}>;

type InstallPackageName = typeof OOMPA_INSTALL_PACKAGE_NAME | typeof OOMPA_LEGACY_INSTALL_PACKAGE_NAME;

type InstallFetch = (input: string, init: RequestInit) => Promise<Response>;

const releaseIdentity = (archive: OompaInstallArchiveIdentity): ReleaseIdentity => ({
  ...archive,
  cliSha256: OOMPA_INSTALL_CLI_SHA256,
  normalizerSha256: OOMPA_INSTALL_NORMALIZER_SHA256,
  packageName: OOMPA_INSTALL_PACKAGE_NAME,
  packageVersion: OOMPA_INSTALL_PACKAGE_VERSION,
});

const versionNameForIdentity = (identity: VersionIdentity): string => [
  `v${identity.packageVersion}`,
  identity.archiveSource,
  identity.archiveSha256,
  identity.normalizerSha256,
  identity.cliSha256,
].join("-");

const versionNameForArchive = (archive: OompaInstallArchiveIdentity): string =>
  versionNameForIdentity(releaseIdentity(archive));

class InstallPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallPreflightError";
  }
}

type DarwinAclLibrary = Readonly<{
  close: () => void;
  symbols: Readonly<{
    __error: () => Pointer | null;
    acl_free: (value: Pointer) => number;
    acl_get_entry: (acl: Pointer, index: number, entry: Uint8Array) => number;
    acl_get_fd_np: (descriptor: number, type: number) => Pointer | null;
    acl_get_flagset_np: (entry: Pointer, flags: Uint8Array) => number;
    acl_get_perm_np: (permissions: Pointer, permission: number) => number;
    acl_get_permset: (entry: Pointer, permissions: Uint8Array) => number;
    acl_get_qualifier: (entry: Pointer) => Pointer | null;
    acl_get_tag_type: (entry: Pointer, tag: Int32Array) => number;
    acl_valid: (acl: Pointer) => number;
    mbr_uid_to_uuid: (uid: number, uuid: Uint8Array) => number;
  }>;
}>;

const openDarwinAclLibrary = (): DarwinAclLibrary => dlopen(
  "/usr/lib/libSystem.B.dylib",
  {
    __error: { args: [], returns: "ptr" },
    acl_free: { args: ["ptr"], returns: "i32" },
    acl_get_entry: { args: ["ptr", "i32", "ptr"], returns: "i32" },
    acl_get_fd_np: { args: ["i32", "i32"], returns: "ptr" },
    acl_get_flagset_np: { args: ["ptr", "ptr"], returns: "i32" },
    acl_get_perm_np: { args: ["ptr", "i32"], returns: "i32" },
    acl_get_permset: { args: ["ptr", "ptr"], returns: "i32" },
    acl_get_qualifier: { args: ["ptr"], returns: "ptr" },
    acl_get_tag_type: { args: ["ptr", "ptr"], returns: "i32" },
    acl_valid: { args: ["ptr"], returns: "i32" },
    mbr_uid_to_uuid: { args: ["u32", "ptr"], returns: "i32" },
  },
);

let processDarwinAclLibrary: DarwinAclLibrary | null | undefined;
const outPointer = (storage: Uint8Array): Pointer => read.ptr(ptr(storage)) as Pointer;

export const assertSafeDarwinInstallAcl = (
  descriptor: number,
  uid: number,
  label: string,
): void => {
  if (process.platform !== "darwin") return;
  if (processDarwinAclLibrary === undefined) {
    try {
      processDarwinAclLibrary = openDarwinAclLibrary();
    } catch {
      processDarwinAclLibrary = null;
    }
  }
  const library = processDarwinAclLibrary;
  if (library === null) {
    throw new InstallPreflightError(`The Oompa installer could not inspect the Darwin ACL on ${label}.`);
  }
  const currentUserUuid = new Uint8Array(16);
  if (library.symbols.mbr_uid_to_uuid(uid, currentUserUuid) !== 0) {
    currentUserUuid.fill(0);
    throw new InstallPreflightError(`The Oompa installer could not resolve its ACL identity for ${label}.`);
  }
  const acl = library.symbols.acl_get_fd_np(descriptor, darwinAclTypeExtended);
  if (acl === null) {
    const errnoPointer = library.symbols.__error();
    const errno = errnoPointer === null ? null : read.i32(errnoPointer);
    currentUserUuid.fill(0);
    if (errno === 2) return;
    throw new InstallPreflightError(
      `The Oompa installer could not retrieve the Darwin ACL on ${label} (errno ${errno === null ? "unavailable" : String(errno)}).`,
    );
  }
  if (library.symbols.acl_valid(acl) !== 0) {
    currentUserUuid.fill(0);
    const errors: Error[] = [new InstallPreflightError(`The Oompa installer retrieved an invalid Darwin ACL on ${label}.`)];
    if (library.symbols.acl_free(acl) !== 0) {
      errors.push(new InstallPreflightError(`The Oompa installer could not settle the invalid Darwin ACL on ${label}.`));
    }
    if (errors.length > 1) throw new AggregateError(errors, `The Oompa installer could not validate and settle the Darwin ACL on ${label}.`);
    const [primaryError] = errors;
    if (primaryError === undefined) {
      throw new InstallPreflightError(`The Oompa installer could not validate the Darwin ACL on ${label}.`);
    }
    throw primaryError;
  }
  let aclOperationError: unknown;
  try {
    for (let index = 0; index <= darwinAclEntryMaximum; index += 1) {
      const entryStorage = new Uint8Array(8);
      const entryResult = library.symbols.acl_get_entry(acl, index, entryStorage);
      if (entryResult === -1) break;
      if (entryResult !== 0 || index === darwinAclEntryMaximum) {
        throw new InstallPreflightError(`The Oompa installer could not bound the Darwin ACL on ${label}.`);
      }
      const entry = outPointer(entryStorage);
      const tag = new Int32Array(1);
      const permissionStorage = new Uint8Array(8);
      const flagStorage = new Uint8Array(8);
      if (
        library.symbols.acl_get_tag_type(entry, tag) !== 0
        || library.symbols.acl_get_permset(entry, permissionStorage) !== 0
        || library.symbols.acl_get_flagset_np(entry, flagStorage) !== 0
      ) throw new InstallPreflightError(`The Oompa installer could not inspect an ACL entry on ${label}.`);
      if (tag[0] !== darwinAclExtendedAllow) continue;
      const qualifier = library.symbols.acl_get_qualifier(entry);
      if (qualifier === null) {
        throw new InstallPreflightError(`The Oompa installer could not identify an ACL principal on ${label}.`);
      }
      let currentPrincipal = false;
      let qualifierOperationError: unknown;
      try {
        currentPrincipal = toBuffer(qualifier, 0, currentUserUuid.byteLength).equals(currentUserUuid);
      } catch (error: unknown) {
        qualifierOperationError = error;
      }
      const qualifierErrors: Error[] = [];
      if (qualifierOperationError !== undefined) {
        qualifierErrors.push(qualifierOperationError instanceof Error
          ? qualifierOperationError
          : new InstallPreflightError(`The Oompa installer could not read an ACL principal on ${label}.`));
      }
      if (library.symbols.acl_free(qualifier) !== 0) {
        qualifierErrors.push(new InstallPreflightError(`The Oompa installer could not settle an ACL principal on ${label}.`));
      }
      if (qualifierErrors.length > 1) {
        throw new AggregateError(qualifierErrors, `The Oompa installer could not settle an ACL principal on ${label}.`);
      }
      if (qualifierErrors[0] !== undefined) {
        throw qualifierErrors[0];
      }
      if (currentPrincipal) continue;
      const permissions = outPointer(permissionStorage);
      for (const permission of darwinDangerousMutationPermissions) {
        const result = library.symbols.acl_get_perm_np(permissions, permission);
        if (result === -1) {
          throw new InstallPreflightError(`The Oompa installer could not inspect ACL mutation rights on ${label}.`);
        }
        if (result === 1) {
          throw new InstallPreflightError(
            `The Oompa install path has a dangerous non-owner Darwin ALLOW ACL on ${label}; remove that ALLOW entry and retry.`,
          );
        }
      }
    }
  } catch (error: unknown) {
    aclOperationError = error;
  }
  currentUserUuid.fill(0);
  const aclErrors: Error[] = [];
  if (aclOperationError !== undefined) {
    aclErrors.push(aclOperationError instanceof Error
      ? aclOperationError
      : new InstallPreflightError(`The Oompa installer could not inspect the Darwin ACL on ${label}.`));
  }
  if (library.symbols.acl_free(acl) !== 0) {
    aclErrors.push(new InstallPreflightError(`The Oompa installer could not settle the Darwin ACL on ${label}.`));
  }
  if (aclErrors.length > 1) {
    throw new AggregateError(aclErrors, `The Oompa installer could not inspect and settle the Darwin ACL on ${label}.`);
  }
  if (aclErrors[0] !== undefined) {
    throw aclErrors[0];
  }
};

type FlockLibrary = Readonly<{
  close: () => void;
  symbols: Readonly<{ flock: (descriptor: number, operation: number) => number }>;
}>;

const openFlockLibrary = (): FlockLibrary => {
  const linuxCandidates = process.arch === "x64"
    ? [
      "/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/lib64/libc.so.6",
      "/usr/lib64/libc.so.6",
      "/lib/libc.musl-x86_64.so.1",
      "/usr/lib/libc.musl-x86_64.so.1",
      "/lib/ld-musl-x86_64.so.1",
      "/usr/lib/ld-musl-x86_64.so.1",
    ]
    : process.arch === "arm64"
      ? [
        "/lib/aarch64-linux-gnu/libc.so.6",
        "/usr/lib/aarch64-linux-gnu/libc.so.6",
        "/lib64/libc.so.6",
        "/usr/lib64/libc.so.6",
        "/lib/libc.musl-aarch64.so.1",
        "/usr/lib/libc.musl-aarch64.so.1",
        "/lib/ld-musl-aarch64.so.1",
        "/usr/lib/ld-musl-aarch64.so.1",
      ]
      : [];
  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : linuxCandidates;
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return dlopen(candidate, { flock: { args: ["i32", "i32"], returns: "i32" } });
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new InstallPreflightError(
    `The Oompa installer could not load its local process-lock primitive: ${lastError instanceof Error ? lastError.message : "unknown loader failure"}`,
  );
};

let processFlockLibrary: FlockLibrary | undefined;
const flock = (descriptor: number, operation: number): number => {
  processFlockLibrary ??= openFlockLibrary();
  return processFlockLibrary.symbols.flock(descriptor, operation);
};
const flockExclusive = 2;
const flockNonblocking = 4;
const flockUnlock = 8;

type NativeDirectoryOperations = Readonly<{
  openAt: (directoryDescriptor: number, name: Uint8Array, flags: number, mode: number) => number;
  renameAt: (
    sourceDirectoryDescriptor: number,
    sourceName: Uint8Array,
    targetDirectoryDescriptor: number,
    targetName: Uint8Array,
  ) => number;
  unlinkAt: (directoryDescriptor: number, name: Uint8Array, flags: number) => number;
}>;

const nativeDirectoryLibraryCandidates = (): readonly string[] => {
  if (process.platform === "darwin") return ["/usr/lib/libSystem.B.dylib"];
  if (process.platform !== "linux") return [];
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

const loadNativeDirectoryOperations = (): NativeDirectoryOperations => {
  let lastError: unknown;
  for (const candidate of nativeDirectoryLibraryCandidates()) {
    try {
      if (process.platform === "darwin") {
        const library = dlopen(candidate, {
          __error: { args: [], returns: "ptr" },
          openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
          renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
          unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
        });
        const errno = (): number => {
          const pointer = library.symbols.__error();
          if (pointer === null) throw new InstallPreflightError("Native directory error state is unavailable.");
          return read.i32(pointer);
        };
        return {
          openAt: (directoryDescriptor, name, flags, mode) => {
            const descriptor = library.symbols.openat(directoryDescriptor, name, flags, mode);
            return descriptor >= 0 ? descriptor : -errno();
          },
          renameAt: (sourceDirectoryDescriptor, sourceName, targetDirectoryDescriptor, targetName) =>
            library.symbols.renameat(
              sourceDirectoryDescriptor,
              sourceName,
              targetDirectoryDescriptor,
              targetName,
            ) === 0 ? 0 : errno(),
          unlinkAt: (directoryDescriptor, name, flags) =>
            library.symbols.unlinkat(directoryDescriptor, name, flags) === 0 ? 0 : errno(),
        };
      }
      const library = dlopen(candidate, {
        __errno_location: { args: [], returns: "ptr" },
        openat: { args: ["i32", "cstring", "i32", "u32"], returns: "i32" },
        renameat: { args: ["i32", "cstring", "i32", "cstring"], returns: "i32" },
        unlinkat: { args: ["i32", "cstring", "i32"], returns: "i32" },
      });
      const errno = (): number => {
        const pointer = library.symbols.__errno_location();
        if (pointer === null) throw new InstallPreflightError("Native directory error state is unavailable.");
        return read.i32(pointer);
      };
      return {
        openAt: (directoryDescriptor, name, flags, mode) => {
          const descriptor = library.symbols.openat(directoryDescriptor, name, flags, mode);
          return descriptor >= 0 ? descriptor : -errno();
        },
        renameAt: (sourceDirectoryDescriptor, sourceName, targetDirectoryDescriptor, targetName) =>
          library.symbols.renameat(
            sourceDirectoryDescriptor,
            sourceName,
            targetDirectoryDescriptor,
            targetName,
          ) === 0 ? 0 : errno(),
        unlinkAt: (directoryDescriptor, name, flags) =>
          library.symbols.unlinkat(directoryDescriptor, name, flags) === 0 ? 0 : errno(),
      };
    } catch (error: unknown) {
      lastError = error;
    }
  }
  throw new InstallPreflightError(
    `The Oompa installer could not load descriptor-relative filesystem primitives: ${lastError instanceof Error ? lastError.message : "unknown loader failure"}`,
  );
};

let processNativeDirectoryOperations: NativeDirectoryOperations | undefined;
const nativeDirectoryOperations = (): NativeDirectoryOperations => {
  processNativeDirectoryOperations ??= loadNativeDirectoryOperations();
  return processNativeDirectoryOperations;
};

const nativeName = (name: string): Buffer => {
  if (basename(name) !== name || name === "." || name === ".." || name.includes("\0")) {
    throw new InstallPreflightError("A descriptor-relative Oompa install name is invalid.");
  }
  return Buffer.from(`${name}\0`, "utf8");
};

const closeOnExecFlag = process.platform === "darwin" ? 0x01000000 : 0x00080000;
const atRemoveDirectory = process.platform === "darwin" ? 0x80 : 0x200;
const noEntryErrno = 2;
const installStageDeadlineMilliseconds = 10 * 60 * 1000;
const installStageDeadlineMaximumMilliseconds = 30 * 60 * 1000;
const installStageReadinessDeadlineMilliseconds = 15 * 1000;
const installStageTerminationGraceMilliseconds = 2 * 1000;
const installStageReapDeadlineMilliseconds = 5 * 1000;

const installStageWorkerSource = String.raw`
const { createHash, randomUUID } = await import("node:crypto");
const { constants } = await import("node:fs");
const { lstat, open } = await import("node:fs/promises");
const { dlopen } = await import("bun:ffi");
const runtimeInjectionEnvironmentNames = ${JSON.stringify(OOMPA_INSTALL_RUNTIME_INJECTION_ENVIRONMENT_NAMES)};

const [
  busyPath,
  expectedUidText,
  archive,
  expectedArchiveBytesText,
  expectedArchiveSha256,
  deadlineText,
  testMode = "normal",
] = process.argv.slice(1);
const expectedUid = Number.parseInt(expectedUidText ?? "", 10);
const expectedArchiveBytes = Number.parseInt(expectedArchiveBytesText ?? "", 10);
const deadlineMilliseconds = Number.parseInt(deadlineText ?? "", 10);
if (
  busyPath === undefined
  || archive === undefined
  || !Number.isSafeInteger(expectedUid)
  || !Number.isSafeInteger(expectedArchiveBytes)
  || expectedArchiveBytes < 1
  || expectedArchiveBytes > ${String(archiveMaximumBytes)}
  || !/^[0-9a-f]{64}$/.test(expectedArchiveSha256 ?? "")
  || !Number.isSafeInteger(deadlineMilliseconds)
  || deadlineMilliseconds < 100
  || deadlineMilliseconds > ${String(installStageDeadlineMaximumMilliseconds)}
  || !["normal", "stall-before-ready", "stall-after-ready"].includes(testMode)
) {
  throw new Error("The Oompa stage-lock worker received invalid authority arguments.");
}
const handle = await open(busyPath, constants.O_RDWR | constants.O_NOFOLLOW);
const metadata = await handle.stat();
if (!metadata.isFile() || metadata.uid !== expectedUid || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
  throw new Error("The Oompa stage-lock worker refused an unsafe lock file.");
}
const candidates = process.platform === "darwin"
  ? ["/usr/lib/libSystem.B.dylib"]
  : process.arch === "x64"
    ? [
      "/lib/x86_64-linux-gnu/libc.so.6",
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
      "/lib64/libc.so.6",
      "/usr/lib64/libc.so.6",
      "/lib/libc.musl-x86_64.so.1",
      "/usr/lib/libc.musl-x86_64.so.1",
      "/lib/ld-musl-x86_64.so.1",
      "/usr/lib/ld-musl-x86_64.so.1",
    ]
    : process.arch === "arm64"
      ? [
        "/lib/aarch64-linux-gnu/libc.so.6",
        "/usr/lib/aarch64-linux-gnu/libc.so.6",
        "/lib64/libc.so.6",
        "/usr/lib64/libc.so.6",
        "/lib/libc.musl-aarch64.so.1",
        "/usr/lib/libc.musl-aarch64.so.1",
        "/lib/ld-musl-aarch64.so.1",
        "/usr/lib/ld-musl-aarch64.so.1",
      ]
      : [];
let library;
let loadError;
for (const candidate of candidates) {
  try {
    library = dlopen(candidate, {
      flock: { args: ["i32", "i32"], returns: "i32" },
    });
    break;
  } catch (error) {
    loadError = error;
  }
}
if (library === undefined) throw loadError ?? new Error("The Oompa stage-lock worker could not load libc.");
if (library.symbols.flock(handle.fd, 2 | 4) !== 0) {
  throw new Error("The Oompa stage-lock worker could not acquire exclusive custody.");
}
const stageStartedAt = Date.now();
const stageDeadlineAt = stageStartedAt + deadlineMilliseconds;
let terminationPending = false;
let settleStageOutcome;
const requestTermination = () => {
  terminationPending = true;
  settleStageOutcome?.({ kind: "termination" });
};
process.once("SIGINT", requestTermination);
process.once("SIGTERM", requestTermination);

const archiveIdentity = (metadata) => ({
  ctimeMs: metadata.ctimeMs,
  dev: metadata.dev,
  ino: metadata.ino,
  mtimeMs: metadata.mtimeMs,
  size: metadata.size,
});
const sameArchiveIdentity = (left, right) =>
  left.dev === right.dev
  && left.ino === right.ino
  && left.size === right.size
  && left.ctimeMs === right.ctimeMs
  && left.mtimeMs === right.mtimeMs;
const readVerifiedArchiveDescriptor = async (archiveHandle, priorIdentity, retainSnapshot) => {
  const [pathMetadata, before] = await Promise.all([lstat(archive), archiveHandle.stat()]);
  const beforeIdentity = archiveIdentity(before);
  if (
    !before.isFile()
    || before.uid !== expectedUid
    || before.nlink !== 1
    || (before.mode & 0o777) !== 0o600
    || before.size !== expectedArchiveBytes
    || !sameArchiveIdentity(archiveIdentity(pathMetadata), beforeIdentity)
    || (priorIdentity !== undefined && !sameArchiveIdentity(priorIdentity, beforeIdentity))
  ) throw new Error("The Oompa stage-lock worker refused a changed private archive descriptor.");
  const hasher = createHash("sha256");
  const bytes = retainSnapshot ? Buffer.allocUnsafe(before.size) : Buffer.alloc(64 * 1024);
  const tail = Buffer.alloc(1);
  try {
    let offset = 0;
    while (offset < before.size) {
      const readLength = Math.min(bytes.byteLength - (retainSnapshot ? offset : 0), before.size - offset);
      const readOffset = retainSnapshot ? offset : 0;
      const result = await archiveHandle.read(bytes, readOffset, readLength, offset);
      if (result.bytesRead < 1) throw new Error("The private Oompa archive ended during worker verification.");
      hasher.update(bytes.subarray(readOffset, readOffset + result.bytesRead));
      offset += result.bytesRead;
    }
    const tailRead = await archiveHandle.read(tail, 0, 1, before.size);
    const [finalPathMetadata, after] = await Promise.all([lstat(archive), archiveHandle.stat()]);
    if (
      tailRead.bytesRead !== 0
      || !sameArchiveIdentity(beforeIdentity, archiveIdentity(after))
      || !sameArchiveIdentity(beforeIdentity, archiveIdentity(finalPathMetadata))
      || hasher.digest("hex") !== expectedArchiveSha256
    ) throw new Error("The private Oompa archive failed its exact worker SHA-256 identity.");
    return { identity: beforeIdentity, snapshot: retainSnapshot ? bytes : undefined };
  } catch (error) {
    bytes.fill(0);
    throw error;
  } finally {
    if (!retainSnapshot) bytes.fill(0);
    tail.fill(0);
  }
};

let archiveHandle;
let archiveServer;
let archiveSnapshot;
let heldArchiveIdentity;
let archiveUrl = archive;
if (testMode === "normal") {
  try {
    archiveHandle = await open(archive, constants.O_RDONLY | constants.O_NOFOLLOW);
    const verifiedArchive = await readVerifiedArchiveDescriptor(archiveHandle, undefined, true);
    heldArchiveIdentity = verifiedArchive.identity;
    archiveSnapshot = verifiedArchive.snapshot;
    if (archiveSnapshot === undefined) throw new Error("The private Oompa archive snapshot is unavailable.");
    const route = "/" + randomUUID() + "/" + ${JSON.stringify(OOMPA_INSTALL_ARCHIVE_NAME)};
    let requests = 0;
    archiveServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        const requestUrl = new URL(request.url);
        if (
          request.method !== "GET"
          || requestUrl.pathname !== route
          || requestUrl.search !== ""
        ) return new Response(null, { status: 404 });
        requests += 1;
        if (requests > 8) return new Response(null, { status: 429 });
        return new Response(archiveSnapshot, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Length": String(expectedArchiveBytes),
            "Content-Type": "application/octet-stream",
          },
          status: 200,
        });
      },
    });
    archiveUrl = "http://127.0.0.1:" + String(archiveServer.port) + route;
  } catch (error) {
    try {
      archiveServer?.stop(true);
    } finally {
      archiveSnapshot?.fill(0);
      await archiveHandle?.close();
    }
    throw error;
  }
}

const stagingArguments = testMode === "normal"
  ? [
    process.execPath,
    "--no-env-file",
    "--config=/dev/null",
    "add",
    "--global",
    "--backend=copyfile",
    "--ignore-scripts",
    archiveUrl,
  ]
  : [
    process.execPath,
    "--no-env-file",
    "--config=/dev/null",
    "-e",
    "await new Promise(() => {});",
  ];
const inheritedNoProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
const forcedNoProxy = "127.0.0.1,localhost,::1"
  + (inheritedNoProxy.length > 0 && inheritedNoProxy.length <= 4096 ? "," + inheritedNoProxy : "");
const stagingEnvironment = { ...process.env };
for (const name of runtimeInjectionEnvironmentNames) delete stagingEnvironment[name];
const staging = Bun.spawn(stagingArguments, {
  detached: true,
  env: {
    ...stagingEnvironment,
    NO_PROXY: forcedNoProxy,
    no_proxy: forcedNoProxy,
  },
  stderr: "ignore",
  stdin: "ignore",
  stdout: "ignore",
});
staging.ref();
const stagingExited = staging.exited;
let exitCode = 1;
let stageError;
let stagingAuthoritySettled = false;

const remainingStageMilliseconds = () => Math.max(0, stageDeadlineAt - Date.now());
const writeFrame = async (frame) => {
  let timer;
  try {
    await Promise.race([
      new Promise((resolveWrite, rejectWrite) => {
        process.stdout.write(frame, (error) => {
          if (error) rejectWrite(error);
          else resolveWrite();
        });
      }),
      new Promise((_, rejectDeadline) => {
        timer = setTimeout(
          () => rejectDeadline(new Error("The Oompa stage-lock worker could not publish readiness before its deadline.")),
          Math.max(1, remainingStageMilliseconds()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
const signalStagingGroup = (signal) => {
  try {
    process.kill(-staging.pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};
const stagingGroupExists = () => {
  try {
    process.kill(-staging.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
};
const awaitStagingExitFor = async (milliseconds) => {
  let timer;
  try {
    return await Promise.race([
      stagingExited.then((code) => ({ done: true, code })),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ done: false }), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};
const terminateAndReapStagingGroup = async () => {
  signalStagingGroup("SIGTERM");
  signalStagingGroup("SIGCONT");
  let result = await awaitStagingExitFor(${String(installStageTerminationGraceMilliseconds)});
  if (!result.done) {
    signalStagingGroup("SIGKILL");
    result = await awaitStagingExitFor(${String(installStageReapDeadlineMilliseconds)});
  }
  if (!result.done) {
    throw new Error("The Oompa stage-lock worker could not reap its staging process before the settlement deadline.");
  }
  if (stagingGroupExists()) {
    signalStagingGroup("SIGKILL");
    await Bun.sleep(10);
    if (stagingGroupExists()) {
      throw new Error("The Oompa stage-lock worker found a surviving process in the staging process group.");
    }
  }
  stagingAuthoritySettled = true;
  return result.code;
};
try {
  if (library.symbols.flock(handle.fd, 2 | 4) !== 0) {
    throw new Error("The Oompa stage-lock worker lost custody while spawning Bun.");
  }
  await writeFrame("OOMPA_INSTALL_STAGE_STARTED " + String(process.pid) + " " + String(staging.pid) + "\n");
  if (testMode !== "stall-before-ready") {
    await writeFrame("OOMPA_INSTALL_STAGE_READY " + String(process.pid) + " " + String(staging.pid) + "\n");
  }
  let deadlineTimer;
  const outcome = await new Promise((resolveOutcome) => {
    let settled = false;
    settleStageOutcome = (value) => {
      if (settled) return;
      settled = true;
      resolveOutcome(value);
    };
    stagingExited.then((code) => settleStageOutcome?.({ kind: "exit", code }));
    deadlineTimer = setTimeout(
      () => settleStageOutcome?.({ kind: "deadline" }),
      Math.max(1, remainingStageMilliseconds()),
    );
    if (terminationPending) settleStageOutcome({ kind: "termination" });
  });
  if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
  settleStageOutcome = undefined;
  process.removeListener("SIGINT", requestTermination);
  process.removeListener("SIGTERM", requestTermination);
  if (outcome.kind === "exit") {
    exitCode = outcome.code;
    if (stagingGroupExists()) {
      signalStagingGroup("SIGKILL");
      await Bun.sleep(10);
      if (stagingGroupExists()) {
        throw new Error("The Oompa stage-lock worker found a surviving process after Bun exited.");
      }
    }
    stagingAuthoritySettled = true;
    if (exitCode === 0 && archiveHandle !== undefined) {
      await readVerifiedArchiveDescriptor(archiveHandle, heldArchiveIdentity, false);
    }
  } else {
    await terminateAndReapStagingGroup();
    exitCode = outcome.kind === "deadline" ? 124 : 125;
  }
} catch (error) {
  stageError = error;
  if (!stagingAuthoritySettled) {
    try {
      await terminateAndReapStagingGroup();
    } catch (cleanupError) {
      stageError = new AggregateError([error, cleanupError], "The Oompa stage-lock worker failed and could not settle staging.");
    }
  }
}
settleStageOutcome = undefined;
process.removeListener("SIGINT", requestTermination);
process.removeListener("SIGTERM", requestTermination);
const settlementErrors = [];
try {
  archiveServer?.stop(true);
} catch (error) {
  settlementErrors.push(error);
}
archiveSnapshot?.fill(0);
try {
  await archiveHandle?.close();
} catch (error) {
  settlementErrors.push(error);
}
try {
  await handle.close();
} catch (error) {
  settlementErrors.push(error);
}
try {
  library.close();
} catch (error) {
  settlementErrors.push(error);
}
if (stageError !== undefined && settlementErrors.length > 0) {
  throw new AggregateError([stageError, ...settlementErrors], "The Oompa stage-lock worker and its custody settlement failed.");
}
if (stageError !== undefined) throw stageError;
if (settlementErrors.length > 0) {
  throw new AggregateError(settlementErrors, "The Oompa stage-lock worker could not settle its custody handles.");
}
process.exitCode = exitCode;
`;

type DirectoryIdentity = Readonly<{ dev: number; ino: number }>;
type FileIdentity = Readonly<{ dev: number; ino: number; size: number }>;
type ArchiveFileIdentity = FileIdentity & Readonly<{ ctimeMs: number; mtimeMs: number }>;
type HeldDirectory = Readonly<{
  handle: FileHandle;
  identity: DirectoryIdentity;
  path: string;
  private: boolean;
}>;

const directoryIdentity = (metadata: Stats): DirectoryIdentity => ({ dev: metadata.dev, ino: metadata.ino });
const fileIdentity = (metadata: Stats): FileIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
  size: metadata.size,
});
const archiveFileIdentity = (metadata: Stats): ArchiveFileIdentity => ({
  ...fileIdentity(metadata),
  ctimeMs: metadata.ctimeMs,
  mtimeMs: metadata.mtimeMs,
});
const sameDirectoryIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;
const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size;
const sameArchiveFileIdentity = (left: ArchiveFileIdentity, right: ArchiveFileIdentity): boolean =>
  sameFileIdentity(left, right)
  && left.ctimeMs === right.ctimeMs
  && left.mtimeMs === right.mtimeMs;

const pathWithin = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
};

const directoryPathsThrough = (path: string): readonly string[] => {
  const root = parse(path).root;
  if (root.length === 0 || !path.startsWith(root)) {
    throw new InstallPreflightError("The Oompa install path is not absolute.");
  }
  const paths = [root];
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter((value) => value.length > 0)) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
};

const assertDirectoryMetadata = (
  metadata: Stats,
  path: string,
  uid: number,
  privateDirectory: boolean,
): void => {
  const mode = metadata.mode & 0o777;
  const rootOwnedStickyBoundary = metadata.uid === 0
    && (metadata.mode & 0o1000) !== 0
    && (mode & 0o022) !== 0;
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.uid !== uid && metadata.uid !== 0)
    || (mode & 0o100) === 0
    || ((mode & 0o022) !== 0 && !rootOwnedStickyBoundary)
    || (privateDirectory && (metadata.uid !== uid || mode !== 0o700))
  ) {
    throw new InstallPreflightError(`The Oompa install path has an unsafe directory component: ${path}`);
  }
};

class DirectoryCustody {
  readonly #directories = new Map<string, HeldDirectory>();

  constructor(private readonly uid: number) {}

  async holdThrough(path: string, options: Readonly<{
    createMissing?: boolean;
    privateRoot?: string;
  }> = {}): Promise<void> {
    let currentUserBoundarySeen = false;
    for (const directoryPath of directoryPathsThrough(path)) {
      const privateDirectory = options.privateRoot !== undefined
        && pathWithin(options.privateRoot, directoryPath);
      const existing = this.#directories.get(directoryPath);
      if (existing !== undefined) {
        if (privateDirectory && !existing.private) {
          throw new InstallPreflightError("An Oompa install directory changed its required custody class.");
        }
        await this.#assertHeld(existing);
        if ((await existing.handle.stat()).uid === this.uid) currentUserBoundarySeen = true;
        continue;
      }
      let pathMetadata: Stats;
      try {
        pathMetadata = await lstat(directoryPath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || options.createMissing !== true) throw error;
        await this.assertAll();
        await mkdir(directoryPath, { mode: 0o700 });
        await chmod(directoryPath, 0o700);
        pathMetadata = await lstat(directoryPath);
      }
      assertDirectoryMetadata(pathMetadata, directoryPath, this.uid, privateDirectory);
      if (pathMetadata.uid === this.uid) currentUserBoundarySeen = true;
      if (currentUserBoundarySeen && pathMetadata.uid !== this.uid) {
        throw new InstallPreflightError(`The Oompa install path leaves current-user ownership below ${directoryPath}.`);
      }
      const handle = await open(
        directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const descriptorMetadata = await handle.stat();
        assertDirectoryMetadata(descriptorMetadata, directoryPath, this.uid, privateDirectory);
        assertSafeDarwinInstallAcl(handle.fd, this.uid, directoryPath);
        if (currentUserBoundarySeen && descriptorMetadata.uid !== this.uid) {
          throw new InstallPreflightError(`The Oompa install descriptor leaves current-user ownership at ${directoryPath}.`);
        }
        const identity = directoryIdentity(pathMetadata);
        if (!sameDirectoryIdentity(identity, directoryIdentity(descriptorMetadata))) {
          throw new InstallPreflightError("An Oompa install directory changed while its descriptor was opened.");
        }
        this.#directories.set(directoryPath, {
          handle,
          identity,
          path: directoryPath,
          private: privateDirectory,
        });
      } catch (error: unknown) {
        await handle.close();
        throw error;
      }
    }
  }

  async assertAll(): Promise<void> {
    for (const held of this.#directories.values()) await this.#assertHeld(held);
  }

  async descriptorFor(path: string): Promise<number> {
    const held = this.#directories.get(resolve(path));
    if (held === undefined) {
      throw new InstallPreflightError("The Oompa installer requested a directory descriptor outside held custody.");
    }
    await this.#assertHeld(held);
    return held.handle.fd;
  }

  async identityFor(path: string): Promise<DirectoryIdentity> {
    const held = this.#directories.get(resolve(path));
    if (held === undefined) {
      throw new InstallPreflightError("The Oompa installer requested a directory identity outside held custody.");
    }
    await this.#assertHeld(held);
    return held.identity;
  }

  async rebindTreeAfterRename(previousRoot: string, nextRoot: string): Promise<void> {
    const previous = resolve(previousRoot);
    const next = resolve(nextRoot);
    if (previous === next || !this.#directories.has(previous)) {
      throw new InstallPreflightError("The Oompa install rename does not have exact held source custody.");
    }
    const rebound: Array<Readonly<{ held: HeldDirectory; nextPath: string; previousPath: string }>> = [];
    for (const [previousPath, held] of this.#directories) {
      const relativePath = relative(previous, previousPath);
      const belowPrevious = relativePath === ""
        || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
      if (!belowPrevious) {
        await this.#assertHeld(held);
        continue;
      }
      const nextPath = relativePath === "" ? next : join(next, relativePath);
      if (this.#directories.has(nextPath)) {
        throw new InstallPreflightError("The Oompa install rename collides with existing directory custody.");
      }
      const [pathMetadata, descriptorMetadata] = await Promise.all([
        lstat(nextPath),
        held.handle.stat(),
      ]);
      assertDirectoryMetadata(pathMetadata, nextPath, this.uid, held.private);
      assertDirectoryMetadata(descriptorMetadata, nextPath, this.uid, held.private);
      assertSafeDarwinInstallAcl(held.handle.fd, this.uid, nextPath);
      if (
        !sameDirectoryIdentity(held.identity, directoryIdentity(pathMetadata))
        || !sameDirectoryIdentity(held.identity, directoryIdentity(descriptorMetadata))
      ) {
        throw new InstallPreflightError("The renamed Oompa install path does not name its held directory descriptor.");
      }
      rebound.push({ held, nextPath, previousPath });
    }
    for (const { held, nextPath, previousPath } of rebound) {
      this.#directories.delete(previousPath);
      this.#directories.set(nextPath, { ...held, path: nextPath });
    }
  }

  async releaseTree(root: string): Promise<void> {
    const resolvedRoot = resolve(root);
    const released = [...this.#directories.entries()]
      .filter(([path]) => pathWithin(resolvedRoot, path))
      .reverse();
    if (!released.some(([path]) => path === resolvedRoot)) {
      throw new InstallPreflightError("The Oompa installer cannot release a directory tree it does not hold.");
    }
    for (const [path] of released) this.#directories.delete(path);
    const results = await Promise.allSettled(released.map(async ([, { handle }]) => { await handle.close(); }));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Oompa install subtree custody did not settle.");
    }
  }

  async close(): Promise<void> {
    const held = [...this.#directories.values()].reverse();
    this.#directories.clear();
    const results = await Promise.allSettled(held.map(async ({ handle }) => { await handle.close(); }));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (failures.length > 0) throw new AggregateError(failures, "Oompa install directory custody did not settle.");
  }

  async #assertHeld(held: HeldDirectory): Promise<void> {
    const [pathMetadata, descriptorMetadata] = await Promise.all([lstat(held.path), held.handle.stat()]);
    assertDirectoryMetadata(pathMetadata, held.path, this.uid, held.private);
    assertDirectoryMetadata(descriptorMetadata, held.path, this.uid, held.private);
    assertSafeDarwinInstallAcl(held.handle.fd, this.uid, held.path);
    if (
      !sameDirectoryIdentity(held.identity, directoryIdentity(pathMetadata))
      || !sameDirectoryIdentity(held.identity, directoryIdentity(descriptorMetadata))
    ) throw new InstallPreflightError("An Oompa install path no longer names its held directory descriptor.");
  }
}

const unlinkHeldChild = async (
  custody: DirectoryCustody,
  directory: string,
  name: string,
  options: Readonly<{ directory?: boolean; missing?: boolean }> = {},
): Promise<void> => {
  await custody.holdThrough(directory);
  await custody.assertAll();
  const directoryDescriptor = await custody.descriptorFor(directory);
  const encodedName = nativeName(name);
  try {
    const errno = nativeDirectoryOperations().unlinkAt(
      directoryDescriptor,
      encodedName,
      options.directory === true ? atRemoveDirectory : 0,
    );
    if (errno !== 0 && !(options.missing === true && errno === noEntryErrno)) {
      throw new InstallPreflightError(`Descriptor-relative Oompa install removal failed with errno ${String(errno)}.`);
    }
    fsyncSync(directoryDescriptor);
    await custody.assertAll();
  } finally {
    encodedName.fill(0);
  }
};

const renameHeldChild = async (
  custody: DirectoryCustody,
  directory: string,
  sourceName: string,
  targetName: string,
): Promise<void> => {
  await custody.holdThrough(directory);
  await custody.assertAll();
  const directoryDescriptor = await custody.descriptorFor(directory);
  const encodedSource = nativeName(sourceName);
  const encodedTarget = nativeName(targetName);
  try {
    const errno = nativeDirectoryOperations().renameAt(
      directoryDescriptor,
      encodedSource,
      directoryDescriptor,
      encodedTarget,
    );
    if (errno !== 0) {
      throw new InstallPreflightError(`Descriptor-relative Oompa install rename failed with errno ${String(errno)}.`);
    }
    fsyncSync(directoryDescriptor);
  } finally {
    encodedSource.fill(0);
    encodedTarget.fill(0);
  }
};

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length
    && keys.every((key, index) => key === expectedKeys[index]);
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sha256Pattern = /^[0-9a-f]{64}$/u;
const semverCorePattern = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const semverIdentifierPattern = /^[0-9A-Za-z-]+$/u;
const semverNumericIdentifierPattern = /^[0-9]+$/u;
const validSemverIdentifiers = (value: string, allowNumericLeadingZeroes: boolean): boolean =>
  value.split(".").every((identifier) => semverIdentifierPattern.test(identifier)
    && (allowNumericLeadingZeroes
      || identifier.length === 1
      || !identifier.startsWith("0")
      || !semverNumericIdentifierPattern.test(identifier)));

// Keep each identifier independent: overlapping alphabetic matches inside a
// repeated prerelease group can backtrack exponentially, even below 128 chars.
// These delimiter splits and unambiguous character scans are linear in input.
export const isOompaInstallReceiptVersion = (value: string): boolean => {
  if (value.length > 128) return false;
  const buildSeparator = value.indexOf("+");
  const withoutBuild = buildSeparator === -1 ? value : value.slice(0, buildSeparator);
  if (buildSeparator !== -1 && !validSemverIdentifiers(value.slice(buildSeparator + 1), true)) {
    return false;
  }
  const prereleaseSeparator = withoutBuild.indexOf("-");
  const core = prereleaseSeparator === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseSeparator);
  return semverCorePattern.test(core)
    && (prereleaseSeparator === -1
      || validSemverIdentifiers(withoutBuild.slice(prereleaseSeparator + 1), false));
};
const positiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const withNetworkDeadline = async <Value>(
  milliseconds: number,
  operation: (signal: AbortSignal) => Promise<Value>,
  failure: string,
): Promise<Value> => {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new InstallPreflightError(failure)),
    milliseconds,
  );
  timer.unref();
  try {
    return await operation(controller.signal);
  } catch (error: unknown) {
    controller.abort();
    if (error instanceof InstallPreflightError) throw error;
    throw new InstallPreflightError(failure);
  } finally {
    clearTimeout(timer);
  }
};

const readBoundedResponse = async (
  response: Response,
  maximumBytes: number,
  label: string,
): Promise<Buffer> => {
  const contentEncoding = response.headers.get("content-encoding");
  if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
    throw new InstallPreflightError(`The Oompa ${label} response used an unrequested content encoding.`);
  }
  const contentLength = response.headers.get("content-length");
  let expectedBytes: number | undefined;
  if (contentLength !== null) {
    if (!/^[1-9][0-9]{0,15}$/u.test(contentLength)) {
      throw new InstallPreflightError(`The Oompa ${label} response has an invalid byte length.`);
    }
    const parsed = Number.parseInt(contentLength, 10);
    if (!Number.isSafeInteger(parsed) || parsed > maximumBytes) {
      throw new InstallPreflightError(`The Oompa ${label} response exceeds its byte bound.`);
    }
    expectedBytes = parsed;
  }
  if (response.body === null) {
    throw new InstallPreflightError(`The Oompa ${label} response has no bounded body.`);
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength < 1) {
        throw new InstallPreflightError(`The Oompa ${label} response body is invalid.`);
      }
      bytes += result.value.byteLength;
      if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new InstallPreflightError(`The Oompa ${label} response exceeds its byte bound.`);
      }
      chunks.push(Buffer.from(result.value));
    }
    if (bytes < 1) throw new InstallPreflightError(`The Oompa ${label} response is empty.`);
    if (expectedBytes !== undefined && bytes !== expectedBytes) {
      throw new InstallPreflightError(`The Oompa ${label} response ended outside its declared byte length.`);
    }
    return Buffer.concat(chunks, bytes);
  } finally {
    reader.releaseLock();
  }
};

export const parseOfficialOompaReleaseRecord = (value: unknown): OfficialArchiveIdentity => {
  if (
    !isRecord(value)
    || !positiveSafeInteger(value.id)
    || value.tag_name !== `v${OOMPA_INSTALL_PACKAGE_VERSION}`
    || value.draft !== false
    || value.immutable !== true
    || !Array.isArray(value.assets)
    || value.assets.length < 1
    || value.assets.length > releaseAssetMaximumCount
  ) throw new InstallPreflightError("The Oompa GitHub release record is not an immutable published release.");
  const candidates = value.assets.filter((asset: unknown): asset is Record<string, unknown> =>
    isRecord(asset)
    && (asset.name === OOMPA_INSTALL_ARCHIVE_NAME
      || asset.browser_download_url === OOMPA_INSTALL_ARCHIVE_URL));
  if (candidates.length !== 1) {
    throw new InstallPreflightError("The Oompa GitHub release does not contain one exact archive asset.");
  }
  const asset = candidates[0];
  if (
    !isRecord(asset)
    || !positiveSafeInteger(asset.id)
    || asset.name !== OOMPA_INSTALL_ARCHIVE_NAME
    || asset.browser_download_url !== OOMPA_INSTALL_ARCHIVE_URL
    || asset.state !== "uploaded"
    || !positiveSafeInteger(asset.size)
    || asset.size > archiveMaximumBytes
    || typeof asset.digest !== "string"
  ) throw new InstallPreflightError("The Oompa GitHub release archive asset is invalid.");
  const digest = /^sha256:([0-9a-f]{64})$/u.exec(asset.digest)?.[1];
  if (digest === undefined) {
    throw new InstallPreflightError("The Oompa GitHub release archive has no exact SHA-256 digest.");
  }
  return {
    archiveAssetId: asset.id,
    archiveBytes: asset.size,
    archiveReleaseId: value.id,
    archiveReleaseTag: OOMPA_INSTALL_RELEASE_TAG,
    archiveRepositoryId: OOMPA_INSTALL_REPOSITORY_ID,
    archiveSha256: digest,
    archiveSource: "official",
  };
};

export const parseOfficialOompaRepositoryRecord = (value: unknown): void => {
  if (
    !isRecord(value)
    || value.id !== OOMPA_INSTALL_REPOSITORY_ID
    || value.full_name !== "hraness/oompa"
    || value.private !== false
    || value.archived !== false
    || value.disabled !== false
  ) throw new InstallPreflightError("The Oompa GitHub repository identity is invalid.");
};

const fetchBoundedJson = async (
  fetcher: InstallFetch,
  url: string,
  signal: AbortSignal,
  label: string,
): Promise<unknown> => {
  const response = await fetcher(url, {
    cache: "no-store",
    credentials: "omit",
    headers: {
      Accept: "application/vnd.github+json",
      "Accept-Encoding": "identity",
      "User-Agent": `oompa-installer/${OOMPA_INSTALL_PACKAGE_VERSION}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    redirect: "error",
    signal,
  });
  if (response.status !== 200) {
    throw new InstallPreflightError(`The Oompa GitHub ${label} record is unavailable.`);
  }
  const bytes = await readBoundedResponse(response, releaseRecordMaximumBytes, `${label}-record`);
  try {
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    } catch {
      throw new InstallPreflightError(`The Oompa GitHub ${label} record is invalid JSON.`);
    }
  } finally {
    bytes.fill(0);
  }
};

export const resolveOfficialOompaArchiveIdentity = async (
  fetcher: InstallFetch = fetch,
): Promise<OfficialArchiveIdentity> => await withNetworkDeadline(
  releaseRecordDeadlineMilliseconds,
  async (signal) => {
    const [repository, release] = await Promise.all([
      fetchBoundedJson(fetcher, OOMPA_INSTALL_REPOSITORY_API_URL, signal, "repository"),
      fetchBoundedJson(fetcher, OOMPA_INSTALL_RELEASE_API_URL, signal, "release"),
    ]);
    parseOfficialOompaRepositoryRecord(repository);
    return parseOfficialOompaReleaseRecord(release);
  },
  "The Oompa GitHub release authority exceeded its network deadline.",
);

const readExactFile = async (
  path: string,
  uid: number,
  maximumBytes: number,
  modes: readonly number[],
): Promise<Buffer> => {
  const pathMetadata = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat();
    if (
      !before.isFile()
      || before.uid !== uid
      || before.nlink !== 1
      || !modes.includes(before.mode & 0o777)
      || !Number.isSafeInteger(before.size)
      || before.size < 1
      || before.size > maximumBytes
      || !sameFileIdentity(fileIdentity(pathMetadata), fileIdentity(before))
    ) throw new InstallPreflightError(`The Oompa installer could not trust ${path}.`);
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead < 1) throw new InstallPreflightError(`The Oompa install file ended early: ${path}`);
      offset += result.bytesRead;
    }
    const tail = Buffer.alloc(1);
    try {
      if ((await handle.read(tail, 0, 1, bytes.byteLength)).bytesRead !== 0) {
        throw new InstallPreflightError(`The Oompa install file grew during verification: ${path}`);
      }
    } finally {
      tail.fill(0);
    }
    const after = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(after))) {
      throw new InstallPreflightError(`The Oompa install file changed during verification: ${path}`);
    }
    return bytes;
  } catch (error: unknown) {
    bytes?.fill(0);
    throw error;
  } finally {
    await handle.close();
  }
};

const fsyncDirectory = async (path: string): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
};

const writeAtomicJson = async (
  path: string,
  value: unknown,
  uid: number,
  custody: DirectoryCustody,
): Promise<void> => {
  const directory = dirname(path);
  await custody.holdThrough(directory);
  await custody.assertAll();
  const directoryDescriptor = await custody.descriptorFor(directory);
  const temporaryName = `.oompa-install-document-${randomUUID()}`;
  const targetName = basename(path);
  const encodedTemporaryName = nativeName(temporaryName);
  const encodedTargetName = nativeName(targetName);
  const descriptor = nativeDirectoryOperations().openAt(
    directoryDescriptor,
    encodedTemporaryName,
    constants.O_CREAT
      | constants.O_EXCL
      | constants.O_RDWR
      | constants.O_NOFOLLOW
      | closeOnExecFlag,
    0o600,
  );
  if (descriptor < 0) {
    encodedTemporaryName.fill(0);
    encodedTargetName.fill(0);
    throw new InstallPreflightError(
      `Descriptor-relative Oompa authority creation failed with errno ${String(-descriptor)}.`,
    );
  }
  fchmodSync(descriptor, 0o600);
  let published = false;
  let operationError: unknown;
  try {
    const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
        if (written < 1) throw new InstallPreflightError("The Oompa authority document stopped during descriptor-relative write.");
        offset += written;
      }
      fsyncSync(descriptor);
    } finally {
      bytes.fill(0);
    }
    const metadata = fstatSync(descriptor);
    assertSafeDarwinInstallAcl(descriptor, uid, join(directory, temporaryName));
    if (
      !metadata.isFile()
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
    ) throw new InstallPreflightError("A fresh Oompa install authority document is not private.");
    await custody.assertAll();
    const renameErrno = nativeDirectoryOperations().renameAt(
      directoryDescriptor,
      encodedTemporaryName,
      directoryDescriptor,
      encodedTargetName,
    );
    if (renameErrno !== 0) {
      throw new InstallPreflightError(
        `Descriptor-relative Oompa authority publication failed with errno ${String(renameErrno)}.`,
      );
    }
    published = true;
    fsyncSync(directoryDescriptor);
    await custody.assertAll();
  } catch (error: unknown) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    closeSync(descriptor);
    if (!published) {
      const cleanupErrno = nativeDirectoryOperations().unlinkAt(
        directoryDescriptor,
        encodedTemporaryName,
        0,
      );
      if (cleanupErrno !== 0 && cleanupErrno !== noEntryErrno) {
        throw new InstallPreflightError(
          `Descriptor-relative Oompa authority cleanup failed with errno ${String(cleanupErrno)}.`,
        );
      }
    }
  } catch (error: unknown) {
    cleanupError = error;
  } finally {
    encodedTemporaryName.fill(0);
    encodedTargetName.fill(0);
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Oompa authority publication and descriptor-relative cleanup both failed.",
    );
  }
  if (operationError instanceof Error) throw operationError;
  if (operationError !== undefined) throw new InstallPreflightError("Oompa authority publication failed with a non-Error value.");
  if (cleanupError instanceof Error) throw cleanupError;
  if (cleanupError !== undefined) throw new InstallPreflightError("Oompa authority cleanup failed with a non-Error value.");
};

const readSmallJson = async (path: string, uid: number): Promise<unknown> => {
  const bytes = await readExactFile(path, uid, authorityDocumentMaximumBytes, [0o600]);
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new InstallPreflightError(`The Oompa install authority document is invalid: ${path}`);
  } finally {
    bytes.fill(0);
  }
};

type InstallPhase = "prepared" | "installing" | "installed" | "normalized" | "published";
type InstallIntent = OompaInstallArchiveIdentity & Readonly<{
  archive: string;
  createdAt: number;
  id: string;
  normalizerSha256: string;
  phase: InstallPhase;
  previousActiveTarget: string | null;
  stagingRoot: string;
  version: 2;
  versionRoot: string;
}>;
type CompleteReceipt = OompaInstallArchiveIdentity & Readonly<{
  cliSha256: string;
  completedAt: number;
  dependencyProvenance: "bun-registry-exact-versions";
  entryCount: number;
  id: string;
  normalizerSha256: string;
  packageName: InstallPackageName;
  packageVersion: string;
  totalBytes: number;
  treeSha256: string;
  version: 2;
}>;

const intentKeys = [
  "archive",
  "archiveAssetId",
  "archiveBytes",
  "archiveReleaseId",
  "archiveReleaseTag",
  "archiveRepositoryId",
  "archiveSha256",
  "archiveSource",
  "createdAt",
  "id",
  "normalizerSha256",
  "phase",
  "previousActiveTarget",
  "stagingRoot",
  "version",
  "versionRoot",
] as const;
const receiptKeys = [
  "archiveAssetId",
  "archiveBytes",
  "archiveReleaseId",
  "archiveReleaseTag",
  "archiveRepositoryId",
  "archiveSha256",
  "archiveSource",
  "cliSha256",
  "completedAt",
  "dependencyProvenance",
  "entryCount",
  "id",
  "normalizerSha256",
  "packageName",
  "packageVersion",
  "totalBytes",
  "treeSha256",
  "version",
] as const;

const parseArchiveIdentityFields = (
  value: Record<string, unknown>,
  label: string,
  expectedOfficialTag = OOMPA_INSTALL_RELEASE_TAG,
): OompaInstallArchiveIdentity => {
  if (
    !positiveSafeInteger(value.archiveBytes)
    || value.archiveBytes > archiveMaximumBytes
    || typeof value.archiveSha256 !== "string"
    || !sha256Pattern.test(value.archiveSha256)
    || (value.archiveSource !== "official" && value.archiveSource !== "local")
  ) throw new InstallPreflightError(`The ${label} archive identity is invalid.`);
  if (value.archiveSource === "official") {
    if (
      !positiveSafeInteger(value.archiveAssetId)
      || !positiveSafeInteger(value.archiveReleaseId)
      || value.archiveReleaseTag !== expectedOfficialTag
      || value.archiveRepositoryId !== OOMPA_INSTALL_REPOSITORY_ID
    ) {
      throw new InstallPreflightError(`The ${label} official archive authority is invalid.`);
    }
    return {
      archiveAssetId: value.archiveAssetId,
      archiveBytes: value.archiveBytes,
      archiveReleaseId: value.archiveReleaseId,
      archiveReleaseTag: expectedOfficialTag,
      archiveRepositoryId: OOMPA_INSTALL_REPOSITORY_ID,
      archiveSha256: value.archiveSha256,
      archiveSource: "official",
    };
  }
  if (
    value.archiveAssetId !== null
    || value.archiveReleaseId !== null
    || value.archiveReleaseTag !== null
    || value.archiveRepositoryId !== null
  ) {
    throw new InstallPreflightError(`The ${label} local archive authority is invalid.`);
  }
  return {
    archiveAssetId: null,
    archiveBytes: value.archiveBytes,
    archiveReleaseId: null,
    archiveReleaseTag: null,
    archiveRepositoryId: null,
    archiveSha256: value.archiveSha256,
    archiveSource: "local",
  };
};

const parseIntent = (value: unknown): InstallIntent => {
  const recoveryMessage = "The durable Oompa install intent is invalid or belongs to another release. Do not edit or delete it; rerun the exact originating release installer or stop for manual review.";
  if (
    !isRecord(value)
    || !hasExactKeys(value, intentKeys)
    || typeof value.archive !== "string"
    || value.archive.length < 1
    || value.archive.length > 4_096
    || typeof value.createdAt !== "number"
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || typeof value.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.id)
    || value.normalizerSha256 !== OOMPA_INSTALL_NORMALIZER_SHA256
    || (value.phase !== "prepared"
      && value.phase !== "installing"
      && value.phase !== "installed"
      && value.phase !== "normalized"
      && value.phase !== "published")
    || (value.previousActiveTarget !== null && typeof value.previousActiveTarget !== "string")
    || typeof value.stagingRoot !== "string"
    || typeof value.versionRoot !== "string"
    || value.version !== 2
  ) {
    throw new InstallPreflightError(recoveryMessage);
  }
  let archiveIdentity: OompaInstallArchiveIdentity;
  try {
    archiveIdentity = parseArchiveIdentityFields(value, "durable Oompa install intent");
    if (
      (archiveIdentity.archiveSource === "official" && value.archive !== OOMPA_INSTALL_ARCHIVE_URL)
      || (
        archiveIdentity.archiveSource === "local"
        && (!isAbsolute(value.archive) || resolve(value.archive) !== value.archive)
      )
    ) throw new InstallPreflightError(recoveryMessage);
  } catch {
    throw new InstallPreflightError(recoveryMessage);
  }
  return {
    archive: value.archive,
    ...archiveIdentity,
    createdAt: value.createdAt,
    id: value.id,
    normalizerSha256: OOMPA_INSTALL_NORMALIZER_SHA256,
    phase: value.phase,
    previousActiveTarget: value.previousActiveTarget,
    stagingRoot: value.stagingRoot,
    version: 2,
    versionRoot: value.versionRoot,
  };
};

const parseReceipt = (value: unknown): CompleteReceipt => {
  if (
    !isRecord(value)
    || !hasExactKeys(value, receiptKeys)
    || typeof value.cliSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.cliSha256)
    || typeof value.completedAt !== "number"
    || !Number.isSafeInteger(value.completedAt)
    || value.completedAt < 0
    || value.dependencyProvenance !== "bun-registry-exact-versions"
    || typeof value.entryCount !== "number"
    || !Number.isSafeInteger(value.entryCount)
    || value.entryCount < 1
    || value.entryCount > installTreeEntryMaximum
    || typeof value.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.id)
    || typeof value.normalizerSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.normalizerSha256)
    || (value.packageName !== OOMPA_INSTALL_PACKAGE_NAME
      && value.packageName !== OOMPA_LEGACY_INSTALL_PACKAGE_NAME)
    || typeof value.packageVersion !== "string"
    || value.packageVersion.length > 128
    || !isOompaInstallReceiptVersion(value.packageVersion)
    || typeof value.totalBytes !== "number"
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes < 1
    || value.totalBytes > installTreeByteMaximum
    || typeof value.treeSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.treeSha256)
    || value.version !== 2
  ) throw new InstallPreflightError("The complete Oompa version receipt is invalid.");
  const archiveIdentity = parseArchiveIdentityFields(
    value,
    "complete Oompa version receipt",
    `v${value.packageVersion}`,
  );
  if (
    value.packageName === OOMPA_LEGACY_INSTALL_PACKAGE_NAME
    && value.packageVersion !== "0.1.0"
  ) throw new InstallPreflightError("The legacy Oompa version receipt is invalid.");
  return {
    ...(value as Omit<CompleteReceipt, keyof OompaInstallArchiveIdentity>),
    ...archiveIdentity,
  };
};

const assertManifest = async (
  packageRoot: string,
  uid: number,
  expectedName: InstallPackageName,
  expectedVersion: string,
): Promise<void> => {
  const bytes = await readExactFile(join(packageRoot, "package.json"), uid, authorityDocumentMaximumBytes, [0o600]);
  try {
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new InstallPreflightError("The installed Oompa package manifest is not valid JSON.");
    }
    if (!isRecord(value) || value.name !== expectedName || value.version !== expectedVersion) {
      throw new InstallPreflightError("The installed Oompa package identity is not exact.");
    }
    if (
      !isRecord(value.bin)
      || !hasExactKeys(value.bin, ["oompa"])
      || value.bin.oompa !== "./src/cli.ts"
      || !isRecord(value.scripts)
      || Object.keys(value.scripts).some((name) => lifecycleScriptNames.has(name))
    ) throw new InstallPreflightError("The installed Oompa package violates its executable or zero-lifecycle contract.");
  } finally {
    bytes.fill(0);
  }
};

type VerifiedVersion = Readonly<{
  cliPath: string;
  receipt: CompleteReceipt;
}>;

type InstallPackageLayout = Readonly<{
  cliSuffix: readonly string[];
  packageName: InstallPackageName;
  packageRootSuffix: readonly string[];
}>;

const installPackageLayouts: readonly InstallPackageLayout[] = [
  {
    cliSuffix: ["install", "global", "node_modules", "@hraness", "oompa", "src", "cli.ts"],
    packageName: OOMPA_INSTALL_PACKAGE_NAME,
    packageRootSuffix: ["install", "global", "node_modules", "@hraness", "oompa"],
  },
  {
    cliSuffix: ["install", "global", "node_modules", "hra", "src", "cli.ts"],
    packageName: OOMPA_LEGACY_INSTALL_PACKAGE_NAME,
    packageRootSuffix: ["install", "global", "node_modules", "hra"],
  },
] as const;

const requireInstallPackageLayout = (packageName: InstallPackageName): InstallPackageLayout => {
  const layout = installPackageLayouts.find((candidate) => candidate.packageName === packageName);
  if (layout === undefined) throw new InstallPreflightError("The installed Oompa package layout is unsupported.");
  return layout;
};

const locateActiveVersion = (
  target: string,
  authorityRoot: string,
): Readonly<{ layout: InstallPackageLayout; versionRoot: string }> => {
  const versionsRoot = join(authorityRoot, "versions");
  const targetRelative = relative(versionsRoot, target);
  if (!pathWithin(versionsRoot, target) || isAbsolute(targetRelative)) {
    throw new InstallPreflightError("The active oompa command is outside its protected version authority.");
  }
  const components = targetRelative.split(sep);
  for (const layout of installPackageLayouts) {
    if (
      components.length === layout.cliSuffix.length + 1
      && layout.cliSuffix.every((component, index) => components[index + 1] === component)
    ) return { layout, versionRoot: join(versionsRoot, components[0] as string) };
  }
  throw new InstallPreflightError("The active oompa command does not use a supported exact package layout.");
};

const verifyCompleteVersion = async (
  versionRoot: string,
  authorityRoot: string,
  uid: number,
  expectedRelease?: ReleaseIdentity,
): Promise<VerifiedVersion> => {
  const versionName = relative(join(authorityRoot, "versions"), versionRoot);
  if (
    !pathWithin(join(authorityRoot, "versions"), versionRoot)
    || dirname(versionRoot) !== join(authorityRoot, "versions")
    || !/^v[0-9A-Za-z.+-]+-(?:official|local)-[0-9a-f]{64}-[0-9a-f]{64}-[0-9a-f]{64}$/u.test(versionName)
  ) {
    throw new InstallPreflightError("The Oompa version is outside its protected authority root.");
  }
  if (await realpath(versionRoot) !== versionRoot) {
    throw new InstallPreflightError("The Oompa version root is not canonical.");
  }
  const receipt = parseReceipt(await readSmallJson(join(versionRoot, ".hra-install-complete.json"), uid));
  if (versionName !== versionNameForIdentity(receipt)) {
    throw new InstallPreflightError("The complete Oompa version namespace does not match its archive identity.");
  }
  if (
    expectedRelease !== undefined
    && (
      receipt.cliSha256 !== expectedRelease.cliSha256
      || receipt.normalizerSha256 !== expectedRelease.normalizerSha256
      || receipt.packageName !== expectedRelease.packageName
      || receipt.packageVersion !== expectedRelease.packageVersion
      || receipt.archiveSource !== expectedRelease.archiveSource
      || receipt.archiveSha256 !== expectedRelease.archiveSha256
      || receipt.archiveBytes !== expectedRelease.archiveBytes
      || receipt.archiveReleaseId !== expectedRelease.archiveReleaseId
      || receipt.archiveAssetId !== expectedRelease.archiveAssetId
      || receipt.archiveReleaseTag !== expectedRelease.archiveReleaseTag
      || receipt.archiveRepositoryId !== expectedRelease.archiveRepositoryId
    )
  ) throw new InstallPreflightError("The complete Oompa version does not match the requested release identity.");
  let entryCount = 0;
  let totalBytes = 0;
  const treeHasher = createHash("sha256");
  const record = (value: readonly (number | string)[]): void => {
    treeHasher.update(`${JSON.stringify(value)}\n`, "utf8");
  };
  const packageLayout = requireInstallPackageLayout(receipt.packageName);
  const packageRoot = join(versionRoot, ...packageLayout.packageRootSuffix);
  const cliPath = join(versionRoot, ...packageLayout.cliSuffix);
  const normalizerPath = join(dirname(cliPath), "install-normalizer.ts");
  const alternatePackageRoot = join(
    versionRoot,
    ...requireInstallPackageLayout(
      receipt.packageName === OOMPA_INSTALL_PACKAGE_NAME
        ? OOMPA_LEGACY_INSTALL_PACKAGE_NAME
        : OOMPA_INSTALL_PACKAGE_NAME,
    ).packageRootSuffix,
  );
  try {
    await lstat(alternatePackageRoot);
    throw new InstallPreflightError("A complete Oompa version contains a package layout that conflicts with its receipt.");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const visit = async (directory: string): Promise<void> => {
    const directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const metadata = await directoryHandle.stat();
      assertSafeDarwinInstallAcl(directoryHandle.fd, uid, directory);
      if (!metadata.isDirectory() || metadata.uid !== uid || (metadata.mode & 0o777) !== 0o700) {
        throw new InstallPreflightError("A complete Oompa version contains a non-private directory.");
      }
      record(["directory", relative(versionRoot, directory).replaceAll("\\", "/"), 0o700]);
    } finally {
      await directoryHandle.close();
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const metadata = await lstat(path);
      if (metadata.uid !== uid) throw new InstallPreflightError("A complete Oompa version left current-user custody.");
      if (entry.isDirectory()) {
        entryCount += 1;
        await visit(path);
        continue;
      }
      if (path === join(versionRoot, ".hra-install-complete.json")) continue;
      entryCount += 1;
      if (entryCount > installTreeEntryMaximum) {
        throw new InstallPreflightError("A complete Oompa version exceeds its entry-count bound.");
      }
      if (entry.isSymbolicLink()) {
        if (metadata.nlink !== 1) throw new InstallPreflightError("A complete Oompa version contains a multiply linked symlink.");
        const target = await readlink(path);
        if (target.length < 1 || target.length > 4_096 || target.includes("\0") || isAbsolute(target)) {
          throw new InstallPreflightError("A complete Oompa version contains an invalid symlink target.");
        }
        if (!pathWithin(versionRoot, resolve(dirname(path), target))) {
          throw new InstallPreflightError("A complete Oompa version contains a lexically escaping symlink.");
        }
        if (!pathWithin(versionRoot, await realpath(path))) {
          throw new InstallPreflightError("A complete Oompa version contains an escaping symlink.");
        }
        record(["symlink", relative(versionRoot, path).replaceAll("\\", "/"), target]);
        continue;
      }
      if (!entry.isFile() || !metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
        throw new InstallPreflightError("A complete Oompa version contains a non-runtime entry.");
      }
      const mode = metadata.mode & 0o777;
      if (mode !== 0o600 && mode !== 0o700 && mode !== 0o755) {
        throw new InstallPreflightError("A complete Oompa version contains a file with an unnormalized mode.");
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const held = await handle.stat();
        assertSafeDarwinInstallAcl(handle.fd, uid, path);
        if (
          !held.isFile()
          || held.uid !== uid
          || held.nlink !== 1
          || !sameFileIdentity(fileIdentity(metadata), fileIdentity(held))
        ) throw new InstallPreflightError("A complete Oompa version file changed during verification.");
        const fileHasher = createHash("sha256");
        const chunk = Buffer.alloc(64 * 1024);
        try {
          let offset = 0;
          while (offset < held.size) {
            const result = await handle.read(
              chunk,
              0,
              Math.min(chunk.byteLength, held.size - offset),
              offset,
            );
            if (result.bytesRead < 1) {
              throw new InstallPreflightError("A complete Oompa version file ended during tree verification.");
            }
            fileHasher.update(chunk.subarray(0, result.bytesRead));
            offset += result.bytesRead;
          }
        } finally {
          chunk.fill(0);
        }
        const after = await handle.stat();
        assertSafeDarwinInstallAcl(handle.fd, uid, path);
        if (!sameFileIdentity(fileIdentity(held), fileIdentity(after))) {
          throw new InstallPreflightError("A complete Oompa version file changed during its tree digest.");
        }
        record([
          "file",
          relative(versionRoot, path).replaceAll("\\", "/"),
          mode,
          held.size,
          fileHasher.digest("hex"),
        ]);
      } finally {
        await handle.close();
      }
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > installTreeByteMaximum) {
        throw new InstallPreflightError("A complete Oompa version exceeds its byte bound.");
      }
    }
  };
  await visit(versionRoot);
  if (
    entryCount !== receipt.entryCount
    || totalBytes !== receipt.totalBytes
    || treeHasher.digest("hex") !== receipt.treeSha256
  ) {
    throw new InstallPreflightError("A complete Oompa version does not match its durable tree receipt.");
  }
  if (await realpath(cliPath) !== cliPath) {
    throw new InstallPreflightError("The complete Oompa entry point is not canonical.");
  }
  await assertManifest(packageRoot, uid, receipt.packageName, receipt.packageVersion);
  const cliBytes = await readExactFile(cliPath, uid, 512 * 1024, [0o755]);
  try {
    if (sha256(cliBytes) !== receipt.cliSha256) throw new InstallPreflightError("The complete Oompa CLI digest is invalid.");
  } finally {
    cliBytes.fill(0);
  }
  const normalizerBytes = await readExactFile(normalizerPath, uid, 2 * 1024 * 1024, [0o600]);
  try {
    if (sha256(normalizerBytes) !== receipt.normalizerSha256) {
      throw new InstallPreflightError("The complete Oompa normalizer digest is invalid.");
    }
  } finally {
    normalizerBytes.fill(0);
  }
  return { cliPath, receipt };
};

const activeTarget = async (activePath: string): Promise<string | null> => {
  try {
    const metadata = await lstat(activePath);
    if (!metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1) {
      throw new InstallPreflightError("The existing oompa command is not a trusted current-user symbolic link.");
    }
    return await readlink(activePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

const verifyActiveTarget = async (
  activePath: string,
  rawTarget: string,
  authorityRoot: string,
  uid: number,
  expectedRelease?: ReleaseIdentity,
): Promise<VerifiedVersion> => {
  if (!isAbsolute(rawTarget) || resolve(rawTarget) !== rawTarget) {
    throw new InstallPreflightError("The active oompa command target is not canonical and absolute.");
  }
  const located = locateActiveVersion(rawTarget, authorityRoot);
  let verified: VerifiedVersion;
  try {
    verified = await verifyCompleteVersion(located.versionRoot, authorityRoot, uid, expectedRelease);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InstallPreflightError("The active oompa command names a missing complete version.");
    }
    throw error;
  }
  if (
    verified.receipt.packageName !== located.layout.packageName
    || verified.cliPath !== rawTarget
    || await realpath(activePath) !== rawTarget
  ) {
    throw new InstallPreflightError("The active oompa command does not resolve to its verified version entry point.");
  }
  return verified;
};

const anchoredDirectoryEmptySource = String.raw`
const { constants } = await import("node:fs");
const { open, readdir, rm } = await import("node:fs/promises");
const [uidText, devText, inoText] = process.argv.slice(1);
const uid = Number.parseInt(uidText ?? "", 10);
const expectedDev = Number.parseInt(devText ?? "", 10);
const expectedIno = Number.parseInt(inoText ?? "", 10);
if (![uid, expectedDev, expectedIno].every(Number.isSafeInteger)) {
  throw new Error("The Oompa quarantine worker received an invalid directory identity.");
}
const handle = await open(".", constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
try {
  const metadata = await handle.stat();
  if (
    !metadata.isDirectory()
    || metadata.uid !== uid
    || metadata.dev !== expectedDev
    || metadata.ino !== expectedIno
    || ((metadata.mode & 0o777) & 0o022) !== 0
  ) throw new Error("The Oompa quarantine worker did not start inside its exact held directory.");
  for (const entry of await readdir(".")) {
    if (entry.length < 1 || entry === "." || entry === ".." || entry.includes("/")) {
      throw new Error("The Oompa quarantine worker found an invalid child name.");
    }
    await rm(entry, { force: true, maxRetries: 0, recursive: true });
  }
  if ((await readdir(".")).length !== 0) {
    throw new Error("The Oompa quarantine worker did not empty its exact directory.");
  }
  await handle.sync();
} finally {
  await handle.close();
}
`;

const emptyHeldQuarantine = async (
  path: string,
  identity: DirectoryIdentity,
  uid: number,
): Promise<void> => {
  const child = Bun.spawn([
    process.execPath,
    "--no-env-file",
    "--config=/dev/null",
    "-e",
    anchoredDirectoryEmptySource,
    "--",
    String(uid),
    String(identity.dev),
    String(identity.ino),
  ], {
    cwd: path,
    env: {},
    stderr: "ignore",
    stdin: "ignore",
    stdout: "ignore",
  });
  const cleanupDeadlineMilliseconds = 5 * 60 * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), cleanupDeadlineMilliseconds);
    timer.unref();
  });
  const result = await Promise.race([
    child.exited.then((exitCode) => ({ exitCode } as const)),
    timeout,
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (result === "timeout") {
    child.kill("SIGKILL");
    await child.exited;
    throw new InstallPreflightError("Descriptor-anchored Oompa quarantine cleanup exceeded its deadline.");
  }
  if (result.exitCode !== 0) {
    throw new InstallPreflightError("Descriptor-anchored Oompa quarantine cleanup was refused.");
  }
};

const assertSafeRemovableTree = async (root: string, uid: number): Promise<void> => {
  let entryCount = 0;
  let totalBytes = 0;
  const visit = async (path: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.uid !== uid) throw new InstallPreflightError("An interrupted Oompa install left current-user custody.");
    entryCount += 1;
    totalBytes += metadata.isFile() ? metadata.size : 0;
    if (
      entryCount > installTreeEntryMaximum
      || !Number.isSafeInteger(totalBytes)
      || totalBytes > installTreeByteMaximum
    ) throw new InstallPreflightError("An interrupted Oompa install exceeds its bounded cleanup authority.");
    if (metadata.isSymbolicLink()) {
      if (metadata.nlink !== 1) throw new InstallPreflightError("An interrupted Oompa install contains a multiply linked symlink.");
      return;
    }
    if (metadata.isDirectory()) {
      const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        assertSafeDarwinInstallAcl(handle.fd, uid, path);
      } finally {
        await handle.close();
      }
      for (const entry of await readdir(path)) await visit(join(path, entry));
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) {
      throw new InstallPreflightError("An interrupted Oompa install contains an unsafe filesystem object.");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      assertSafeDarwinInstallAcl(handle.fd, uid, path);
    } finally {
      await handle.close();
    }
  };
  await visit(root);
};

const safelyRemoveOwnedTree = async (
  root: string,
  uid: number,
  existingCustody?: DirectoryCustody,
): Promise<void> => {
  const resolvedRoot = resolve(root);
  const parent = dirname(resolvedRoot);
  const rootName = basename(resolvedRoot);
  const ownsCustody = existingCustody === undefined;
  const custody = existingCustody ?? new DirectoryCustody(uid);
  let operationError: unknown;
  let missing = false;
  if (ownsCustody) {
    try {
      await custody.holdThrough(resolvedRoot);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
      else operationError = error;
    }
  } else {
    try {
      await custody.identityFor(resolvedRoot);
    } catch (error: unknown) {
      operationError = error;
    }
  }
  if (!missing && operationError === undefined) {
    try {
      await custody.assertAll();
      await assertSafeRemovableTree(resolvedRoot, uid);
      const rootIdentity = await custody.identityFor(resolvedRoot);
      const quarantineName = `.oompa-remove-${randomUUID()}`;
      const quarantineRoot = join(parent, quarantineName);
      await renameHeldChild(custody, parent, rootName, quarantineName);
      await custody.rebindTreeAfterRename(resolvedRoot, quarantineRoot);
      await custody.assertAll();
      await emptyHeldQuarantine(quarantineRoot, rootIdentity, uid);
      await custody.assertAll();
      const parentDescriptor = await custody.descriptorFor(parent);
      const encodedQuarantineName = nativeName(quarantineName);
      try {
        const errno = nativeDirectoryOperations().unlinkAt(
          parentDescriptor,
          encodedQuarantineName,
          atRemoveDirectory,
        );
        if (errno !== 0) {
          throw new InstallPreflightError(
            `Descriptor-relative Oompa quarantine removal failed with errno ${String(errno)}.`,
          );
        }
        fsyncSync(parentDescriptor);
      } finally {
        encodedQuarantineName.fill(0);
      }
      await custody.releaseTree(quarantineRoot);
      await custody.assertAll();
    } catch (error: unknown) {
      operationError = error;
    }
  }
  let custodyError: unknown;
  if (ownsCustody) {
    try {
      await custody.close();
    } catch (error: unknown) {
      custodyError = error;
    }
  }
  if (missing && operationError === undefined && custodyError === undefined) return;
  if (operationError !== undefined && custodyError !== undefined) {
    throw new AggregateError([operationError, custodyError], "Oompa tree quarantine and custody settlement both failed.");
  }
  if (operationError instanceof Error) throw operationError;
  if (operationError !== undefined) throw new InstallPreflightError("Oompa tree quarantine failed with a non-Error value.");
  if (custodyError instanceof Error) throw custodyError;
  if (custodyError !== undefined) throw new InstallPreflightError("Oompa tree quarantine custody failed with a non-Error value.");
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

const acquireLock = async (
  path: string,
  uid: number,
  custody: DirectoryCustody,
): Promise<FileHandle> => {
  await custody.assertAll();
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    const metadata = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (!metadata.isFile() || metadata.uid !== uid || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
      throw new InstallPreflightError("The Oompa install process lock is not private.");
    }
    if (flock(handle.fd, flockExclusive | flockNonblocking) !== 0) {
      throw new InstallPreflightError("Another Oompa installation or recovery is still running.");
    }
    return handle;
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
};

const releaseLock = async (handle: FileHandle): Promise<void> => {
  const errors: unknown[] = [];
  if (flock(handle.fd, flockUnlock) !== 0) errors.push(new InstallPreflightError("The Oompa install process lock did not unlock."));
  try {
    await handle.close();
  } catch (error: unknown) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, "The Oompa install process lock did not settle.");
};

const lockIsAvailable = async (path: string, uid: number): Promise<boolean> => {
  const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (!metadata.isFile() || metadata.uid !== uid || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600) {
      throw new InstallPreflightError("The interrupted Oompa stage lock is not private.");
    }
    const acquired = flock(handle.fd, flockExclusive | flockNonblocking) === 0;
    if (acquired && flock(handle.fd, flockUnlock) !== 0) {
      throw new InstallPreflightError("The interrupted Oompa stage lock did not unlock.");
    }
    return acquired;
  } finally {
    await handle.close();
  }
};

const copyLocalArchive = async (
  archive: string,
  destination: string,
  uid: number,
  expected: OompaInstallArchiveIdentity,
): Promise<void> => {
  const sourcePath = resolve(archive);
  const sourceCustody = new DirectoryCustody(uid);
  await sourceCustody.holdThrough(dirname(sourcePath));
  await sourceCustody.assertAll();
  const pathMetadata = await lstat(sourcePath);
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle: FileHandle | undefined;
  const chunk = Buffer.alloc(64 * 1024);
  let operationError: unknown;
  try {
    const metadata = await source.stat();
    assertSafeDarwinInstallAcl(source.fd, uid, sourcePath);
    if (
      !metadata.isFile()
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || (metadata.mode & 0o022) !== 0
      || !Number.isSafeInteger(metadata.size)
      || metadata.size < 1
      || metadata.size > archiveMaximumBytes
      || !sameFileIdentity(fileIdentity(pathMetadata), fileIdentity(metadata))
    ) throw new InstallPreflightError("The local Oompa archive is not a trusted current-user regular file.");
    destinationHandle = await open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const hasher = createHash("sha256");
    let offset = 0;
    while (offset < metadata.size) {
      const result = await source.read(chunk, 0, Math.min(chunk.byteLength, metadata.size - offset), offset);
      if (result.bytesRead < 1) throw new InstallPreflightError("The local Oompa archive ended during its custody copy.");
      hasher.update(chunk.subarray(0, result.bytesRead));
      let written = 0;
      while (written < result.bytesRead) {
        const write = await destinationHandle.write(
          chunk,
          written,
          result.bytesRead - written,
          offset + written,
        );
        if (write.bytesWritten < 1) throw new InstallPreflightError("The private Oompa archive copy ended early.");
        written += write.bytesWritten;
      }
      offset += result.bytesRead;
    }
    const tail = await source.read(chunk, 0, 1, metadata.size);
    const after = await source.stat();
    const finalPathMetadata = await lstat(sourcePath);
    await sourceCustody.assertAll();
    if (
      tail.bytesRead !== 0
      || !sameArchiveFileIdentity(archiveFileIdentity(metadata), archiveFileIdentity(after))
      || !sameArchiveFileIdentity(archiveFileIdentity(metadata), archiveFileIdentity(finalPathMetadata))
      || expected.archiveSource !== "local"
      || metadata.size !== expected.archiveBytes
      || hasher.digest("hex") !== expected.archiveSha256
    ) throw new InstallPreflightError("The local Oompa archive changed after its identity was recorded.");
    await destinationHandle.sync();
    const destinationMetadata = await destinationHandle.stat();
    assertSafeDarwinInstallAcl(destinationHandle.fd, uid, destination);
    if (
      !destinationMetadata.isFile()
      || destinationMetadata.uid !== uid
      || destinationMetadata.nlink !== 1
      || (destinationMetadata.mode & 0o777) !== 0o600
      || destinationMetadata.size !== metadata.size
    ) throw new InstallPreflightError("The private Oompa archive copy did not retain its exact custody.");
  } catch (error: unknown) {
    operationError = error;
  }
  chunk.fill(0);
  const settlements = await Promise.allSettled([
    source.close(),
    destinationHandle?.close() ?? Promise.resolve(),
    sourceCustody.close(),
  ]);
  const failures = settlements
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (operationError !== undefined && failures.length > 0) {
    throw new AggregateError([operationError, ...failures], "The local Oompa archive copy and custody settlement both failed.");
  }
  if (operationError instanceof Error) throw operationError;
  if (operationError !== undefined) throw new InstallPreflightError("The local Oompa archive copy failed with a non-Error value.");
  if (failures.length > 0) throw new AggregateError(failures, "The local Oompa archive custody did not settle.");
};

const inspectLocalArchive = async (
  archive: string,
  uid: number,
): Promise<OompaInstallArchiveIdentity> => {
  const sourcePath = resolve(archive);
  const custody = new DirectoryCustody(uid);
  let source: FileHandle | undefined;
  const chunk = Buffer.alloc(64 * 1024);
  let identity: OompaInstallArchiveIdentity | undefined;
  let operationError: unknown;
  try {
    await custody.holdThrough(dirname(sourcePath));
    await custody.assertAll();
    const pathMetadata = await lstat(sourcePath);
    source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await source.stat();
    assertSafeDarwinInstallAcl(source.fd, uid, sourcePath);
    if (
      !before.isFile()
      || before.uid !== uid
      || before.nlink !== 1
      || (before.mode & 0o022) !== 0
      || !Number.isSafeInteger(before.size)
      || before.size < 1
      || before.size > archiveMaximumBytes
      || !sameFileIdentity(fileIdentity(pathMetadata), fileIdentity(before))
    ) throw new InstallPreflightError("The local Oompa archive is not a trusted current-user regular file.");
    const hasher = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      const result = await source.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset);
      if (result.bytesRead < 1) throw new InstallPreflightError("The local Oompa archive ended during identity verification.");
      hasher.update(chunk.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const tail = await source.read(chunk, 0, 1, before.size);
    const after = await source.stat();
    const finalPathMetadata = await lstat(sourcePath);
    await custody.assertAll();
    if (
      tail.bytesRead !== 0
      || !sameArchiveFileIdentity(archiveFileIdentity(before), archiveFileIdentity(after))
      || !sameArchiveFileIdentity(archiveFileIdentity(before), archiveFileIdentity(finalPathMetadata))
    ) throw new InstallPreflightError("The local Oompa archive changed during identity verification.");
    identity = {
      archiveAssetId: null,
      archiveBytes: before.size,
      archiveReleaseId: null,
      archiveReleaseTag: null,
      archiveRepositoryId: null,
      archiveSha256: hasher.digest("hex"),
      archiveSource: "local",
    };
  } catch (error: unknown) {
    operationError = error;
  }
  chunk.fill(0);
  const settlements = await Promise.allSettled([
    source?.close() ?? Promise.resolve(),
    custody.close(),
  ]);
  const failures = settlements
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (operationError !== undefined && failures.length > 0) {
    throw new AggregateError(
      [operationError, ...failures],
      "The local Oompa archive identity and custody settlement both failed.",
    );
  }
  if (operationError instanceof Error) throw operationError;
  if (operationError !== undefined) {
    throw new InstallPreflightError("The local Oompa archive identity failed with a non-Error value.");
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "The local Oompa archive identity custody did not settle.");
  }
  if (identity === undefined) throw new InstallPreflightError("The local Oompa archive identity is unavailable.");
  return identity;
};

const verifyPrivateArchiveCopy = async (
  path: string,
  uid: number,
  expected: OompaInstallArchiveIdentity,
): Promise<void> => {
  const pathMetadata = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunk = Buffer.alloc(64 * 1024);
  try {
    const before = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      !before.isFile()
      || before.uid !== uid
      || before.nlink !== 1
      || (before.mode & 0o777) !== 0o600
      || before.size !== expected.archiveBytes
      || !sameArchiveFileIdentity(archiveFileIdentity(pathMetadata), archiveFileIdentity(before))
    ) throw new InstallPreflightError("The private Oompa archive copy has invalid custody.");
    const hasher = createHash("sha256");
    let offset = 0;
    while (offset < before.size) {
      const result = await handle.read(chunk, 0, Math.min(chunk.byteLength, before.size - offset), offset);
      if (result.bytesRead < 1) throw new InstallPreflightError("The private Oompa archive copy ended during verification.");
      hasher.update(chunk.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const tail = await handle.read(chunk, 0, 1, before.size);
    const after = await handle.stat();
    const finalPathMetadata = await lstat(path);
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      tail.bytesRead !== 0
      || !sameArchiveFileIdentity(archiveFileIdentity(before), archiveFileIdentity(after))
      || !sameArchiveFileIdentity(archiveFileIdentity(before), archiveFileIdentity(finalPathMetadata))
      || hasher.digest("hex") !== expected.archiveSha256
    ) throw new InstallPreflightError("The private Oompa archive copy changed or failed its exact SHA-256 identity.");
  } finally {
    chunk.fill(0);
    await handle.close();
  }
};

const officialRedirectHost = (hostname: string): boolean =>
  hostname === "release-assets.githubusercontent.com"
  || hostname === "objects.githubusercontent.com";

const downloadOfficialArchive = async (
  destination: string,
  uid: number,
  expected: OfficialArchiveIdentity,
  fetcher: InstallFetch,
  beforeReadback?: () => Promise<void> | void,
): Promise<void> => await withNetworkDeadline(
  releaseAssetDeadlineMilliseconds,
  async (signal) => {
    let currentUrl = OOMPA_INSTALL_ARCHIVE_URL;
    let response: Response | undefined;
    for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
      response = await fetcher(currentUrl, {
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/octet-stream",
          "Accept-Encoding": "identity",
          "User-Agent": `oompa-installer/${OOMPA_INSTALL_PACKAGE_VERSION}`,
        },
        redirect: "manual",
        signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get("location");
      if (location === null || redirectCount === 3) {
        throw new InstallPreflightError("The Oompa release archive redirect is invalid.");
      }
      const next = new URL(location, currentUrl);
      if (
        next.protocol !== "https:"
        || next.username !== ""
        || next.password !== ""
        || (next.port !== "" && next.port !== "443")
        || !officialRedirectHost(next.hostname)
      ) {
        throw new InstallPreflightError("The Oompa release archive left its GitHub download authority.");
      }
      await response.body?.cancel().catch(() => undefined);
      currentUrl = next.href;
    }
    if (response?.status !== 200 || response.body === null) {
      throw new InstallPreflightError("The exact Oompa release archive is unavailable.");
    }
    const contentEncoding = response.headers.get("content-encoding");
    if (contentEncoding !== null && contentEncoding.toLowerCase() !== "identity") {
      throw new InstallPreflightError("The Oompa release archive used an unrequested content encoding.");
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && contentLength !== String(expected.archiveBytes)) {
      throw new InstallPreflightError("The Oompa release archive byte length differs from immutable metadata.");
    }
    const destinationHandle = await open(
      destination,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    const reader = response.body.getReader();
    const hasher = createHash("sha256");
    let bytes = 0;
    let operationError: unknown;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        if (!(result.value instanceof Uint8Array) || result.value.byteLength < 1) {
          throw new InstallPreflightError("The Oompa release archive response body is invalid.");
        }
        bytes += result.value.byteLength;
        if (bytes > expected.archiveBytes || bytes > archiveMaximumBytes) {
          throw new InstallPreflightError("The Oompa release archive exceeds its immutable byte length.");
        }
        hasher.update(result.value);
        const chunkStart = bytes - result.value.byteLength;
        let written = 0;
        while (written < result.value.byteLength) {
          const write = await destinationHandle.write(
            result.value,
            written,
            result.value.byteLength - written,
            chunkStart + written,
          );
          if (write.bytesWritten < 1) {
            throw new InstallPreflightError("The downloaded Oompa archive ended during its durable write.");
          }
          written += write.bytesWritten;
        }
      }
      if (bytes !== expected.archiveBytes || hasher.digest("hex") !== expected.archiveSha256) {
        throw new InstallPreflightError("The Oompa release archive does not match its immutable SHA-256 identity.");
      }
      await destinationHandle.sync();
      const metadata = await destinationHandle.stat();
      assertSafeDarwinInstallAcl(destinationHandle.fd, uid, destination);
      if (
        !metadata.isFile()
        || metadata.uid !== uid
        || metadata.nlink !== 1
        || (metadata.mode & 0o777) !== 0o600
        || metadata.size !== expected.archiveBytes
      ) throw new InstallPreflightError("The downloaded Oompa archive did not retain private custody.");
    } catch (error: unknown) {
      operationError = error;
    }
    const readerSettlement = reader.cancel();
    reader.releaseLock();
    const settlements = await Promise.allSettled([readerSettlement, destinationHandle.close()]);
    const failures = settlements
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (operationError !== undefined && failures.length > 0) {
      throw new AggregateError(
        [operationError, ...failures],
        "The Oompa archive download and private custody settlement both failed.",
      );
    }
    if (operationError instanceof Error) throw operationError;
    if (operationError !== undefined) {
      throw new InstallPreflightError("The Oompa archive download failed with a non-Error value.");
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "The Oompa archive download custody did not settle.");
    }
    await beforeReadback?.();
    await verifyPrivateArchiveCopy(destination, uid, expected);
  },
  "The Oompa release archive exceeded its network deadline.",
);

const exactOfficialArchiveIdentity = (
  identity: OompaInstallArchiveIdentity,
): OfficialArchiveIdentity => {
  if (identity.archiveSource !== "official") {
    throw new InstallPreflightError("The official Oompa archive identity is incomplete.");
  }
  return identity;
};

const materializePrivateArchive = async (input: Readonly<{
  archive: string;
  destination: string;
  expected: OompaInstallArchiveIdentity;
  fetcher: InstallFetch;
  hooks?: InstallPreflightTestHooks | undefined;
  uid: number;
}>): Promise<void> => {
  try {
    await lstat(input.destination);
    await verifyPrivateArchiveCopy(input.destination, input.uid, input.expected);
    return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (input.expected.archiveSource === "official") {
    if (input.archive !== OOMPA_INSTALL_ARCHIVE_URL) {
      throw new InstallPreflightError("The official Oompa archive identity has a noncanonical download URL.");
    }
    await downloadOfficialArchive(
      input.destination,
      input.uid,
      exactOfficialArchiveIdentity(input.expected),
      input.fetcher,
      input.hooks?.beforePrivateArchiveReadback,
    );
    return;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(input.archive)) {
    throw new InstallPreflightError("The Oompa installer accepts only its exact release URL or a local archive path.");
  }
  await copyLocalArchive(input.archive, input.destination, input.uid, input.expected);
  await verifyPrivateArchiveCopy(input.destination, input.uid, input.expected);
};

const updateIntentPhase = async (
  intentPath: string,
  intent: InstallIntent,
  phase: InstallPhase,
  uid: number,
  custody: DirectoryCustody,
): Promise<InstallIntent> => {
  const updated = { ...intent, phase } satisfies InstallIntent;
  await writeAtomicJson(intentPath, updated, uid, custody);
  return updated;
};

type InstallPreflightTestHooks = Readonly<{
  afterArchiveIdentityResolved?: (identity: OompaInstallArchiveIdentity) => Promise<void> | void;
  afterNormalized?: () => Promise<void> | void;
  afterPublishRename?: () => Promise<void> | void;
  afterStageCleanupCustody?: () => Promise<void> | void;
  afterStageWorkerExit?: () => Promise<void> | void;
  afterStageWorkerReady?: (bunPid: number, lockPid: number) => Promise<void> | void;
  afterStageWorkerStarted?: (bunPid: number, lockPid: number) => Promise<void> | void;
  afterVersionRebind?: () => Promise<void> | void;
  afterVersionRename?: () => Promise<void> | void;
  beforePublish?: () => Promise<void> | void;
  beforeCacheQuarantine?: () => Promise<void> | void;
  beforeNormalizerImport?: () => Promise<void> | void;
  beforePrivateArchiveReadback?: () => Promise<void> | void;
  beforeStageWorkerSpawn?: (privateArchivePath: string) => Promise<void> | void;
  beforeVersionRename?: () => Promise<void> | void;
  fetcher?: InstallFetch;
  stageDeadlineMilliseconds?: number;
  stageWorkerTestMode?: "stall-after-ready" | "stall-before-ready";
}>;

const completeStagedVersion = async (
  intent: InstallIntent,
  authorityRoot: string,
  intentPath: string,
  uid: number,
  hooks?: InstallPreflightTestHooks,
): Promise<string> => {
  await materializePrivateArchive({
    archive: intent.archive,
    destination: join(intent.stagingRoot, ".oompa-release-archive.tgz"),
    expected: intent,
    fetcher: hooks?.fetcher ?? fetch,
    hooks,
    uid,
  });
  const packageRoot = join(intent.stagingRoot, "install", "global", "node_modules", "@hraness", "oompa");
  const normalizerPath = join(packageRoot, "src", "install-normalizer.ts");
  const normalizerBytes = await readExactFile(normalizerPath, uid, 2 * 1024 * 1024, [0o600, 0o644]);
  let imported: unknown;
  try {
    if (sha256(normalizerBytes) !== OOMPA_INSTALL_NORMALIZER_SHA256) {
      throw new InstallPreflightError("The staged Oompa normalizer does not match its trusted tagged identity.");
    }
    await hooks?.beforeNormalizerImport?.();
    const javascript = new Bun.Transpiler({ loader: "ts", target: "bun" }).transformSync(normalizerBytes);
    const moduleUrl = URL.createObjectURL(new Blob([javascript], { type: "text/javascript" }));
    try {
      imported = await import(moduleUrl) as unknown;
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }
  } finally {
    normalizerBytes.fill(0);
  }
  if (
    !isRecord(imported)
    || typeof imported.completeOompaStagedInstall !== "function"
  ) throw new InstallPreflightError("The trusted Oompa normalizer does not expose its staged completion boundary.");
  const complete = imported.completeOompaStagedInstall as (input: OompaInstallArchiveIdentity & Readonly<{
    afterVersionRebind?: (() => Promise<void> | void) | undefined;
    afterVersionRename?: (() => Promise<void> | void) | undefined;
    authorityRoot: string;
    beforeVersionRename?: (() => Promise<void> | void) | undefined;
    completedAt: number;
    intentId: string;
    intentPath: string;
    normalizerPath: string;
    normalizerSha256: string;
    packageRoot: string;
    stagingRoot: string;
    versionRoot: string;
  }>) => Promise<Readonly<{ versionRoot: string }>>;
  const archiveIdentity: OompaInstallArchiveIdentity = intent;
  const result = await complete({
    ...archiveIdentity,
    afterVersionRebind: hooks?.afterVersionRebind,
    afterVersionRename: hooks?.afterVersionRename,
    authorityRoot,
    beforeVersionRename: hooks?.beforeVersionRename,
    completedAt: Date.now(),
    intentId: intent.id,
    intentPath,
    normalizerPath,
    normalizerSha256: OOMPA_INSTALL_NORMALIZER_SHA256,
    packageRoot,
    stagingRoot: intent.stagingRoot,
    versionRoot: intent.versionRoot,
  });
  if (resolve(result.versionRoot) !== intent.versionRoot) {
    throw new InstallPreflightError("The trusted Oompa normalizer returned a different version authority path.");
  }
  return intent.versionRoot;
};

const publishVersion = async (input: Readonly<{
  activePath: string;
  authorityRoot: string;
  custody: DirectoryCustody;
  expectedActiveTarget: string | null;
  expectedRelease: ReleaseIdentity;
  hooks?: InstallPreflightTestHooks | undefined;
  uid: number;
  versionRoot: string;
}>): Promise<void> => {
  const verified = await verifyCompleteVersion(
    input.versionRoot,
    input.authorityRoot,
    input.uid,
    input.expectedRelease,
  );
  const current = await activeTarget(input.activePath);
  if (current !== input.expectedActiveTarget) {
    throw new InstallPreflightError("The active oompa command changed during installation; no replacement was published.");
  }
  if (current !== null) await verifyActiveTarget(input.activePath, current, input.authorityRoot, input.uid);
  await input.hooks?.beforePublish?.();
  await input.custody.assertAll();
  if (await activeTarget(input.activePath) !== input.expectedActiveTarget) {
    throw new InstallPreflightError("The active oompa command changed immediately before publication.");
  }
  await verifyCompleteVersion(
    input.versionRoot,
    input.authorityRoot,
    input.uid,
    input.expectedRelease,
  );
  const temporaryPath = join(dirname(input.activePath), `.oompa-command-${randomUUID()}`);
  let published = false;
  try {
    await symlink(verified.cliPath, temporaryPath);
    const temporaryMetadata = await lstat(temporaryPath);
    if (!temporaryMetadata.isSymbolicLink() || temporaryMetadata.uid !== input.uid || temporaryMetadata.nlink !== 1) {
      throw new InstallPreflightError("The fresh oompa command link is not current-user-owned.");
    }
    if (await realpath(temporaryPath) !== verified.cliPath) {
      throw new InstallPreflightError("The fresh oompa command link does not resolve to its verified version.");
    }
    await input.custody.assertAll();
    await rename(temporaryPath, input.activePath);
    published = true;
    await input.hooks?.afterPublishRename?.();
    await fsyncDirectory(dirname(input.activePath));
    await input.custody.assertAll();
    if (await activeTarget(input.activePath) !== verified.cliPath) {
      throw new InstallPreflightError("The published oompa command link changed after atomic publication.");
    }
    await verifyActiveTarget(
      input.activePath,
      verified.cliPath,
      input.authorityRoot,
      input.uid,
      input.expectedRelease,
    );
  } finally {
    if (!published) await rm(temporaryPath, { force: true });
  }
};

const intentPathsAreExact = (
  intent: InstallIntent,
  authorityRoot: string,
  versionRoot: string,
): boolean =>
  dirname(intent.stagingRoot) === authorityRoot
  && /^\.staging-[0-9a-f-]{36}$/u.test(relative(authorityRoot, intent.stagingRoot))
  && intent.versionRoot === versionRoot;

const cleanupOrRefuseBusyStage = async (stageRoot: string, uid: number): Promise<void> => {
  try {
    const busyPath = join(stageRoot, ".oompa-install-busy");
    if (!await lockIsAvailable(busyPath, uid)) {
      throw new InstallPreflightError("A prior Oompa Bun staging process is still running; retry after it exits.");
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await safelyRemoveOwnedTree(stageRoot, uid);
};

const recoverInterruptedInstall = async (input: Readonly<{
  activePath: string;
  authorityRoot: string;
  custody: DirectoryCustody;
  hooks?: InstallPreflightTestHooks | undefined;
  intentPath: string;
  requestedRelease: ReleaseIdentity;
  requestedArchive: string;
  uid: number;
  versionRoot: string;
}>): Promise<boolean> => {
  let intent: InstallIntent;
  try {
    intent = parseIntent(await readSmallJson(input.intentPath, input.uid));
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!intentPathsAreExact(intent, input.authorityRoot, input.versionRoot)) {
    throw new InstallPreflightError("The interrupted Oompa install intent contains paths outside its exact authority.");
  }
  if (intent.archive !== input.requestedArchive) {
    throw new InstallPreflightError("An interrupted Oompa install was created for a different release archive.");
  }
  if (
    intent.archiveSource !== input.requestedRelease.archiveSource
    || intent.archiveSha256 !== input.requestedRelease.archiveSha256
    || intent.archiveBytes !== input.requestedRelease.archiveBytes
    || intent.archiveReleaseId !== input.requestedRelease.archiveReleaseId
    || intent.archiveAssetId !== input.requestedRelease.archiveAssetId
    || intent.archiveReleaseTag !== input.requestedRelease.archiveReleaseTag
    || intent.archiveRepositoryId !== input.requestedRelease.archiveRepositoryId
  ) throw new InstallPreflightError("An interrupted Oompa install has a different archive identity.");
  const current = await activeTarget(input.activePath);
  const intendedCli = join(
    intent.versionRoot,
    "install",
    "global",
    "node_modules",
    "@hraness",
    "oompa",
    "src",
    "cli.ts",
  );
  if (current !== intent.previousActiveTarget && current !== intendedCli) {
    throw new InstallPreflightError("The active oompa command drifted while an interrupted install awaited recovery.");
  }
  if (current !== null) {
    await verifyActiveTarget(
      input.activePath,
      current,
      input.authorityRoot,
      input.uid,
      current === intendedCli ? input.requestedRelease : undefined,
    );
  }
  let versionComplete = false;
  try {
    await verifyCompleteVersion(
      intent.versionRoot,
      input.authorityRoot,
      input.uid,
      input.requestedRelease,
    );
    versionComplete = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      const receiptExists = await Bun.file(join(intent.versionRoot, ".hra-install-complete.json")).exists();
      if (receiptExists) throw error;
    }
  }
  if (!versionComplete && (intent.phase === "installed" || intent.phase === "normalized")) {
    const stageExists = await pathExists(intent.stagingRoot);
    if (stageExists) {
      const busyPath = join(intent.stagingRoot, ".oompa-install-busy");
      try {
        if (!await lockIsAvailable(busyPath, input.uid)) {
          throw new InstallPreflightError("A prior Oompa Bun staging process is still running; retry after it exits.");
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (await pathExists(join(intent.stagingRoot, ".hra-install-complete.json"))) {
        await completeStagedVersion(intent, input.authorityRoot, input.intentPath, input.uid, input.hooks);
        versionComplete = true;
      }
    }
  }
  const alreadyPublished = versionComplete && current === intendedCli;
  if (current === intendedCli && !alreadyPublished) {
    throw new InstallPreflightError("The active oompa command drifted while an interrupted install awaited recovery.");
  }
  if (versionComplete) {
    await input.hooks?.afterNormalized?.();
    if (!alreadyPublished) {
      await publishVersion({
        activePath: input.activePath,
        authorityRoot: input.authorityRoot,
        custody: input.custody,
        expectedActiveTarget: intent.previousActiveTarget,
        expectedRelease: input.requestedRelease,
        hooks: input.hooks,
        uid: input.uid,
        versionRoot: intent.versionRoot,
      });
    }
    intent = await updateIntentPhase(input.intentPath, intent, "published", input.uid, input.custody);
    if (await pathExists(intent.stagingRoot)) await cleanupOrRefuseBusyStage(intent.stagingRoot, input.uid);
    await unlinkHeldChild(input.custody, input.authorityRoot, basename(input.intentPath));
    return true;
  }
  if (intent.phase === "published") {
    throw new InstallPreflightError("The published Oompa install intent has no complete version to recover.");
  }
  await cleanupOrRefuseBusyStage(intent.stagingRoot, input.uid);
  await unlinkHeldChild(input.custody, input.authorityRoot, basename(input.intentPath));
  return false;
};

const removeOrphanStages = async (authorityRoot: string, uid: number): Promise<void> => {
  let count = 0;
  for (const entry of await readdir(authorityRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(".staging-")) continue;
    count += 1;
    if (count > 128 || !/^\.staging-[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(entry.name)) {
      throw new InstallPreflightError("The Oompa install authority contains an unbounded or malformed staging entry.");
    }
    if (!entry.isDirectory()) throw new InstallPreflightError("An Oompa staging authority path is not a directory.");
    await cleanupOrRefuseBusyStage(join(authorityRoot, entry.name), uid);
  }
};

type InstallStageIdentity = Readonly<{ bunPid: number; workerPid: number }>;

const deadlineRace = async <Value>(
  promise: Promise<Value>,
  deadlineAt: number,
  message: string,
): Promise<Value> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new InstallPreflightError(message)),
          Math.max(1, deadlineAt - Date.now()),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const installStageGroupExists = (pid: number): boolean => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const signalInstallStageGroup = (pid: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const waitForInstallStageExit = async (
  exited: Promise<number>,
  milliseconds: number,
): Promise<Readonly<{ done: false }> | Readonly<{ done: true; exitCode: number }>> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exited.then((exitCode) => ({ done: true as const, exitCode })),
      new Promise<Readonly<{ done: false }>>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout({ done: false }), Math.max(1, milliseconds));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const terminateInstallStageAuthority = async (input: Readonly<{
  exited: Promise<number>;
  identity?: InstallStageIdentity | undefined;
  workerPid: number;
}>): Promise<void> => {
  try {
    process.kill(input.workerPid, "SIGTERM");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  let workerExit = await waitForInstallStageExit(
    input.exited,
    installStageTerminationGraceMilliseconds + installStageReapDeadlineMilliseconds + 500,
  );
  if (!workerExit.done) {
    if (input.identity !== undefined) signalInstallStageGroup(input.identity.bunPid, "SIGKILL");
    try {
      process.kill(-input.workerPid, "SIGKILL");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    workerExit = await waitForInstallStageExit(input.exited, installStageReapDeadlineMilliseconds);
  }
  if (!workerExit.done) {
    throw new InstallPreflightError("The detached Oompa stage-lock worker did not settle before its cleanup deadline.");
  }
  if (input.identity !== undefined && installStageGroupExists(input.identity.bunPid)) {
    signalInstallStageGroup(input.identity.bunPid, "SIGKILL");
    const groupDeadline = Date.now() + installStageReapDeadlineMilliseconds;
    while (installStageGroupExists(input.identity.bunPid) && Date.now() < groupDeadline) await Bun.sleep(10);
    if (installStageGroupExists(input.identity.bunPid)) {
      throw new InstallPreflightError("The detached Oompa staging process group survived forced cleanup.");
    }
  }
};

const parseInstallStageIdentity = (
  frame: string,
  phase: "READY" | "STARTED",
  expectedWorkerPid: number,
): InstallStageIdentity => {
  const match = new RegExp(`^OOMPA_INSTALL_STAGE_${phase} ([1-9][0-9]*) ([1-9][0-9]*)$`, "u").exec(frame);
  const workerPid = Number.parseInt(match?.[1] ?? "", 10);
  const bunPid = Number.parseInt(match?.[2] ?? "", 10);
  if (
    workerPid !== expectedWorkerPid
    || !Number.isSafeInteger(bunPid)
    || bunPid < 2
    || bunPid === workerPid
  ) {
    throw new InstallPreflightError(`The Bun staging process emitted an invalid ${phase.toLowerCase()} identity.`);
  }
  return { bunPid, workerPid };
};

const readInstallStageReadiness = async (input: Readonly<{
  deadlineAt: number;
  expectedWorkerPid: number;
  onStarted?: ((identity: InstallStageIdentity) => Promise<void> | void) | undefined;
  stream: ReadableStream<Uint8Array>;
}>): Promise<InstallStageIdentity> => {
  const reader = input.stream.getReader();
  let bytes = Buffer.alloc(0);
  let started: InstallStageIdentity | undefined;
  try {
    for (;;) {
      const result = await deadlineRace(
        reader.read(),
        input.deadlineAt,
        "The Bun staging process did not publish lock readiness before its deadline.",
      );
      if (result.done) {
        throw new InstallPreflightError("The Bun staging process ended before publishing complete lock readiness.");
      }
      bytes = Buffer.concat([bytes, Buffer.from(result.value)]);
      if (bytes.byteLength > 256) {
        throw new InstallPreflightError("The Bun staging process emitted an oversized lock readiness frame.");
      }
      for (;;) {
        const newline = bytes.indexOf(0x0a);
        if (newline === -1) break;
        const frame = bytes.subarray(0, newline).toString("utf8");
        bytes = bytes.subarray(newline + 1);
        if (started === undefined) {
          started = parseInstallStageIdentity(frame, "STARTED", input.expectedWorkerPid);
          await deadlineRace(
            Promise.resolve(input.onStarted?.(started)),
            input.deadlineAt,
            "The Oompa stage-start observer did not settle before the readiness deadline.",
          );
          continue;
        }
        const ready = parseInstallStageIdentity(frame, "READY", input.expectedWorkerPid);
        if (ready.workerPid !== started.workerPid || ready.bunPid !== started.bunPid || bytes.byteLength !== 0) {
          throw new InstallPreflightError("The Bun staging process changed identity during lock readiness.");
        }
        return ready;
      }
    }
  } finally {
    try {
      await deadlineRace(
        reader.cancel(),
        Date.now() + 1_000,
        "The Bun staging readiness stream did not cancel before its settlement deadline.",
      );
    } catch {
      // Process cleanup below remains authoritative when the pipe cannot settle itself.
    }
    reader.releaseLock();
  }
};

const installIntoStage = async (input: Readonly<{
  archive: string;
  custody: DirectoryCustody;
  hooks?: InstallPreflightTestHooks | undefined;
  intent: InstallIntent;
  intentPath: string;
  uid: number;
}>): Promise<void> => {
  await input.custody.assertAll();
  await mkdir(input.intent.stagingRoot, { mode: 0o700 });
  await chmod(input.intent.stagingRoot, 0o700);
  const stageCustody = new DirectoryCustody(input.uid);
  await stageCustody.holdThrough(input.intent.stagingRoot, { privateRoot: input.intent.stagingRoot });
  await stageCustody.assertAll();
  const busyPath = join(input.intent.stagingRoot, ".oompa-install-busy");
  const preparedBusyLock = await acquireLock(busyPath, input.uid, stageCustody);
  await releaseLock(preparedBusyLock);
  const privateArchivePath = join(input.intent.stagingRoot, ".oompa-release-archive.tgz");
  let stagingError: unknown;
  try {
    await materializePrivateArchive({
      archive: input.archive,
      destination: privateArchivePath,
      expected: input.intent,
      fetcher: input.hooks?.fetcher ?? fetch,
      hooks: input.hooks,
      uid: input.uid,
    });
    await input.hooks?.beforeStageWorkerSpawn?.(privateArchivePath);
    await updateIntentPhase(input.intentPath, input.intent, "installing", input.uid, input.custody);
    const stageDeadlineMilliseconds = input.hooks?.stageDeadlineMilliseconds ?? installStageDeadlineMilliseconds;
    if (
      !Number.isSafeInteger(stageDeadlineMilliseconds)
      || stageDeadlineMilliseconds < 100
      || stageDeadlineMilliseconds > installStageDeadlineMaximumMilliseconds
    ) {
      throw new InstallPreflightError("The Oompa staging deadline is outside its bounded authority interval.");
    }
    const workerStartedAt = Date.now();
    const workerSettlementDeadlineAt = workerStartedAt
      + stageDeadlineMilliseconds
      + installStageTerminationGraceMilliseconds
      + installStageReapDeadlineMilliseconds
      + 2_000;
    const child = Bun.spawn([
      process.execPath,
      "--no-env-file",
      "--config=/dev/null",
      "-e",
      installStageWorkerSource,
      "--",
      busyPath,
      String(input.uid),
      privateArchivePath,
      String(input.intent.archiveBytes),
      input.intent.archiveSha256,
      String(stageDeadlineMilliseconds),
      input.hooks?.stageWorkerTestMode ?? "normal",
    ], {
      cwd: input.intent.stagingRoot,
      detached: true,
      env: {
        ...sanitizeOompaInstallChildEnvironment(process.env),
        BUN_INSTALL: input.intent.stagingRoot,
        BUN_INSTALL_BIN: join(input.intent.stagingRoot, "bin"),
        BUN_INSTALL_GLOBAL_DIR: join(input.intent.stagingRoot, "install", "global"),
      },
      stdio: ["ignore", "pipe", "ignore"],
    });
    const exited = child.exited;
    let stageIdentity: InstallStageIdentity | undefined;
    try {
      const readinessDeadlineAt = workerStartedAt + Math.min(
        installStageReadinessDeadlineMilliseconds,
        stageDeadlineMilliseconds
          + installStageTerminationGraceMilliseconds
          + installStageReapDeadlineMilliseconds
          + 1_000,
      );
      stageIdentity = await readInstallStageReadiness({
        deadlineAt: readinessDeadlineAt,
        expectedWorkerPid: child.pid,
        onStarted: async (identity) => {
          stageIdentity = identity;
          await input.hooks?.afterStageWorkerStarted?.(identity.bunPid, identity.workerPid);
        },
        stream: child.stdout,
      });
      await deadlineRace(
        Promise.resolve(input.hooks?.afterStageWorkerReady?.(stageIdentity.bunPid, stageIdentity.workerPid)),
        workerSettlementDeadlineAt,
        "The Oompa stage-ready observer did not settle before the staging deadline.",
      );
    } catch (error: unknown) {
      try {
        await terminateInstallStageAuthority({
          exited,
          identity: stageIdentity,
          workerPid: child.pid,
        });
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "The Oompa stage readiness failed and its detached authority did not settle cleanly.",
        );
      }
      throw error;
    }
    const { workerPid } = stageIdentity;
    const workerExit = await waitForInstallStageExit(
      exited,
      Math.max(1, workerSettlementDeadlineAt - Date.now()),
    );
    if (!workerExit.done) {
      await terminateInstallStageAuthority({ exited, identity: stageIdentity, workerPid });
      throw new InstallPreflightError("Bun staging exceeded its parent settlement deadline.");
    }
    if (workerExit.exitCode === 124) {
      throw new InstallPreflightError("Bun staging exceeded its hard detached-authority deadline.");
    }
    if (workerExit.exitCode !== 0) {
      throw new InstallPreflightError(`Bun could not stage the exact Oompa archive (exit ${String(workerExit.exitCode)}).`);
    }
    // The exact direct worker exits zero only after its owned Bun handle has
    // settled and it has proved the staging process group absent. Never probe
    // or signal the numeric Bun PGID after that exit; the kernel may reuse it.
    if (input.hooks?.afterStageWorkerExit !== undefined) {
      const stagedLink = join(input.intent.stagingRoot, "bin", "oompa");
      const stagedLinkMetadata = await lstat(stagedLink);
      if (!stagedLinkMetadata.isSymbolicLink()) {
        throw new InstallPreflightError("Bun staging did not publish its exact oompa command link.");
      }
      await deadlineRace(
        Promise.resolve(input.hooks.afterStageWorkerExit()),
        workerSettlementDeadlineAt,
        "The post-stage observer did not settle before the staging deadline.",
      );
    }
    const globalInstallRoot = join(input.intent.stagingRoot, "install", "global");
    const cacheRoot = join(input.intent.stagingRoot, "install", "cache");
    await stageCustody.holdThrough(globalInstallRoot);
    const cacheExists = await pathExists(cacheRoot);
    if (cacheExists) await stageCustody.holdThrough(cacheRoot);
    await stageCustody.assertAll();
    await input.hooks?.afterStageCleanupCustody?.();
    await stageCustody.assertAll();
    const globalManifestPath = join(globalInstallRoot, "package.json");
    const globalManifestBytes = await readExactFile(
      globalManifestPath,
      input.uid,
      authorityDocumentMaximumBytes,
      [0o600, 0o644],
    );
    let globalManifest: unknown;
    try {
      globalManifest = JSON.parse(globalManifestBytes.toString("utf8")) as unknown;
    } catch {
      throw new InstallPreflightError("Bun staging wrote an invalid isolated global manifest.");
    } finally {
      globalManifestBytes.fill(0);
    }
    if (!isRecord(globalManifest) || !hasExactKeys(globalManifest, ["dependencies"])) {
      throw new InstallPreflightError("Bun staging changed its isolated global manifest shape.");
    }
    const globalDependencies = globalManifest.dependencies;
    if (
      !isRecord(globalDependencies)
      || !hasExactKeys(globalDependencies, [OOMPA_INSTALL_PACKAGE_NAME])
      || typeof globalDependencies[OOMPA_INSTALL_PACKAGE_NAME] !== "string"
    ) throw new InstallPreflightError("Bun staging did not record one exact isolated Oompa dependency.");
    let stagedArchiveUrl: URL;
    try {
      stagedArchiveUrl = new URL(globalDependencies[OOMPA_INSTALL_PACKAGE_NAME]);
    } catch {
      throw new InstallPreflightError("Bun staging recorded an invalid isolated Oompa archive URL.");
    }
    const stagedArchivePort = Number.parseInt(stagedArchiveUrl.port, 10);
    const stagedArchivePath = /^\/(?<nonce>[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(?<name>[^/]+)$/u
      .exec(stagedArchiveUrl.pathname);
    if (
      stagedArchiveUrl.protocol !== "http:"
      || stagedArchiveUrl.hostname !== "127.0.0.1"
      || stagedArchiveUrl.username !== ""
      || stagedArchiveUrl.password !== ""
      || !Number.isSafeInteger(stagedArchivePort)
      || stagedArchivePort < 1
      || stagedArchivePort > 65_535
      || stagedArchiveUrl.search !== ""
      || stagedArchiveUrl.hash !== ""
      || stagedArchivePath?.groups?.nonce === undefined
      || stagedArchivePath.groups.name !== OOMPA_INSTALL_ARCHIVE_NAME
    ) throw new InstallPreflightError("Bun staging left its descriptor-bound loopback archive authority.");
    await unlinkHeldChild(stageCustody, globalInstallRoot, "bun.lock", { missing: true });
    await stageCustody.assertAll();
    await writeAtomicJson(
      globalManifestPath,
      { dependencies: { [OOMPA_INSTALL_PACKAGE_NAME]: OOMPA_INSTALL_PACKAGE_VERSION } },
      input.uid,
      stageCustody,
    );
    await stageCustody.assertAll();
    const globalEntries = (await readdir(globalInstallRoot)).sort();
    if (
      globalEntries.length !== 2
      || globalEntries[0] !== "node_modules"
      || globalEntries[1] !== "package.json"
    ) {
      throw new InstallPreflightError("Bun staging left unexpected global authority metadata.");
    }
    await stageCustody.assertAll();
    await fsyncDirectory(globalInstallRoot);
    if (cacheExists) {
      await input.hooks?.beforeCacheQuarantine?.();
      await safelyRemoveOwnedTree(cacheRoot, input.uid, stageCustody);
    }
    await stageCustody.assertAll();
    await fsyncDirectory(input.intent.stagingRoot);
  } catch (error: unknown) {
    stagingError = error;
  }
  const failures: unknown[] = [];
  try {
    await stageCustody.assertAll();
    await unlinkHeldChild(stageCustody, input.intent.stagingRoot, basename(busyPath), { missing: true });
  } catch (error: unknown) {
    failures.push(error);
  }
  const results = await Promise.allSettled([stageCustody.close()]);
  failures.push(...results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown));
  if (stagingError !== undefined && failures.length > 0) {
    throw new AggregateError([stagingError, ...failures], "Oompa Bun staging and custody settlement both failed.");
  }
  if (stagingError instanceof Error) throw stagingError;
  if (stagingError !== undefined) throw new InstallPreflightError("Oompa Bun staging failed with a non-Error value.");
  if (failures.length > 0) throw new AggregateError(failures, "The Oompa Bun staging custody did not settle.");
};

export async function installOompaRelease(
  requestedArchive: string,
  hooks?: InstallPreflightTestHooks,
): Promise<void> {
  if (Bun.version !== OOMPA_INSTALL_BUN_VERSION) {
    throw new InstallPreflightError(`Oompa installation requires Bun ${OOMPA_INSTALL_BUN_VERSION} exactly.`);
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new InstallPreflightError("Oompa installation supports only macOS and Linux.");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new InstallPreflightError("Oompa installation requires a current-user identity.");
  const officialArchive = requestedArchive === OOMPA_INSTALL_ARCHIVE_URL;
  if (!officialArchive && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(requestedArchive)) {
    throw new InstallPreflightError("The Oompa installer accepts only its exact release URL or a local archive path.");
  }
  const archive = officialArchive ? requestedArchive : resolve(requestedArchive);
  const archiveIdentity = officialArchive
    ? await resolveOfficialOompaArchiveIdentity(hooks?.fetcher ?? fetch)
    : await inspectLocalArchive(archive, uid);
  await hooks?.afterArchiveIdentityResolved?.(archiveIdentity);
  const requestedRelease = releaseIdentity(archiveIdentity);
  const configuredBunRoot = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
  if (!isAbsolute(configuredBunRoot)) throw new InstallPreflightError("BUN_INSTALL must be an absolute path.");
  const bunRoot = resolve(configuredBunRoot);
  const binRoot = join(bunRoot, "bin");
  const authorityRoot = join(bunRoot, "install", "oompa");
  const versionsRoot = join(authorityRoot, "versions");
  const versionName = versionNameForArchive(archiveIdentity);
  const versionRoot = join(versionsRoot, versionName);
  const activePath = join(binRoot, "oompa");
  const intentPath = join(authorityRoot, "install-intent.json");
  const custody = new DirectoryCustody(uid);
  let installLock: FileHandle | undefined;
  let operationError: unknown;
  try {
    await custody.holdThrough(binRoot, { createMissing: true });
    await custody.holdThrough(versionsRoot, {
      createMissing: true,
      privateRoot: authorityRoot,
    });
    await custody.assertAll();
    installLock = await acquireLock(join(authorityRoot, "install.lock"), uid, custody);
    const recovered = await recoverInterruptedInstall({
      activePath,
      authorityRoot,
      custody,
      hooks,
      intentPath,
      requestedArchive: archive,
      requestedRelease,
      uid,
      versionRoot,
    });
    if (!recovered) {
      await removeOrphanStages(authorityRoot, uid);
      let activatedExistingVersion = false;
      try {
        const verified = await verifyCompleteVersion(
          versionRoot,
          authorityRoot,
          uid,
          requestedRelease,
        );
        const previous = await activeTarget(activePath);
        if (previous !== null) await verifyActiveTarget(activePath, previous, authorityRoot, uid);
        await publishVersion({
          activePath,
          authorityRoot,
          custody,
          expectedActiveTarget: previous,
          expectedRelease: requestedRelease,
          hooks,
          uid,
          versionRoot,
        });
        if (await realpath(activePath) !== verified.cliPath) {
          throw new InstallPreflightError("The existing complete Oompa version did not become active.");
        }
        activatedExistingVersion = true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (await pathExists(versionRoot)) await safelyRemoveOwnedTree(versionRoot, uid);
      }
      if (!activatedExistingVersion) {
        const previousActiveTarget = await activeTarget(activePath);
        if (previousActiveTarget !== null) {
          await verifyActiveTarget(activePath, previousActiveTarget, authorityRoot, uid);
        }
        const intent: InstallIntent = {
          archive,
          ...archiveIdentity,
          createdAt: Date.now(),
          id: randomUUID(),
          normalizerSha256: OOMPA_INSTALL_NORMALIZER_SHA256,
          phase: "prepared",
          previousActiveTarget,
          stagingRoot: join(authorityRoot, `.staging-${randomUUID()}`),
          version: 2,
          versionRoot,
        };
        await writeAtomicJson(intentPath, intent, uid, custody);
        await installIntoStage({ archive, custody, hooks, intent, intentPath, uid });
        await updateIntentPhase(intentPath, intent, "installed", uid, custody);
        await completeStagedVersion({ ...intent, phase: "installed" }, authorityRoot, intentPath, uid, hooks);
        await hooks?.afterNormalized?.();
        await publishVersion({
          activePath,
          authorityRoot,
          custody,
          expectedActiveTarget: previousActiveTarget,
          expectedRelease: requestedRelease,
          hooks,
          uid,
          versionRoot,
        });
        await updateIntentPhase(intentPath, intent, "published", uid, custody);
        await unlinkHeldChild(custody, authorityRoot, basename(intentPath));
      }
    }
  } catch (error: unknown) {
    operationError = error;
  }
  const cleanupErrors: unknown[] = [];
  if (installLock !== undefined) {
    try {
      await releaseLock(installLock);
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
  }
  try {
    await custody.close();
  } catch (error: unknown) {
    cleanupErrors.push(error);
  }
  if (operationError !== undefined && cleanupErrors.length > 0) {
    throw new AggregateError([operationError, ...cleanupErrors], "Oompa installation and local custody settlement both failed.");
  }
  if (operationError instanceof Error) throw operationError;
  if (operationError !== undefined) throw new InstallPreflightError("Oompa installation failed with a non-Error value.");
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Oompa install custody settlement failed.");
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3 || typeof process.argv[2] !== "string") {
      throw new InstallPreflightError("The Oompa installer requires exactly one immutable archive URL or local archive path.");
    }
    await installOompaRelease(process.argv[2]);
    process.stdout.write(`${OOMPA_INSTALL_SUCCESS}\n`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "The Oompa installation was refused.";
    process.stderr.write(`oompa install: ${message}\n`);
    process.exitCode = 1;
  }
}
