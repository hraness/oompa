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
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const OOMPA_INSTALL_BUN_VERSION = "1.3.14";
export const OOMPA_INSTALL_CLI_SHA256 = "6f62b55d89cd60df91e2d4f6e0ec321ba44ffd6e0011d350d91326a73835f432";

const expectedPackageName = "@hraness/oompa";
const expectedPackageVersion = "0.8.2";
const expectedArchiveUrl = "https://github.com/hraness/oompa/releases/download/v0.8.2/hraness-oompa-0.8.2.tgz";
const cliRelativePath = join("src", "cli.ts");
const cliMaximumBytes = 512 * 1024;
const manifestMaximumBytes = 64 * 1024;
const archiveMaximumBytes = 64 * 1024 * 1024;
const archiveGzipInputSliceBytes = 64 * 1024;
const archiveGzipOutputChunkBytes = 16 * 1024;
const archivePackageDirectoryMaximumCount = 512;
const archivePackageFileMaximumBytes = 8 * 1024 * 1024;
const archivePackageFileMaximumCount = 512;
const archivePackagePathByteMaximum = 128 * 1024;
const archivePackagePathDepthMaximum = 16;
const archivePackagePathMaximumBytes = 512;
const archivePackageTarMaximumBytes = 80 * 1024 * 1024;
const archivePackageTotalMaximumBytes = 64 * 1024 * 1024;
const installTreeEntryMaximum = 100_000;
const installTreeByteMaximum = 2 * 1024 * 1024 * 1024;
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
    throw new InstallNormalizationError(
      `The Oompa install could not inspect the Darwin ACL on ${label}; installation stopped.`,
    );
  }
  const currentUserUuid = new Uint8Array(16);
  if (library.symbols.mbr_uid_to_uuid(uid, currentUserUuid) !== 0) {
    currentUserUuid.fill(0);
    throw new InstallNormalizationError(
      `The Oompa install could not resolve its current-user ACL identity for ${label}; installation stopped.`,
    );
  }
  const acl = library.symbols.acl_get_fd_np(descriptor, darwinAclTypeExtended);
  if (acl === null) {
    const errnoPointer = library.symbols.__error();
    const errno = errnoPointer === null ? null : read.i32(errnoPointer);
    currentUserUuid.fill(0);
    if (errno === 2) return;
    throw new InstallNormalizationError(
      `The Oompa install could not retrieve the Darwin ACL on ${label} (errno ${errno === null ? "unavailable" : String(errno)}); installation stopped.`,
    );
  }
  if (library.symbols.acl_valid(acl) !== 0) {
    currentUserUuid.fill(0);
    const errors: Error[] = [new InstallNormalizationError(
      `The Oompa install retrieved an invalid Darwin ACL on ${label}; installation stopped.`,
    )];
    if (library.symbols.acl_free(acl) !== 0) {
      errors.push(new InstallNormalizationError(
        `The Oompa install could not settle the invalid Darwin ACL on ${label}; installation stopped.`,
      ));
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `The Oompa install could not validate and settle the Darwin ACL on ${label}.`);
    }
    const [primaryError] = errors;
    if (primaryError === undefined) {
      throw new InstallNormalizationError(
        `The Oompa install could not validate the Darwin ACL on ${label}; installation stopped.`,
      );
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
        throw new InstallNormalizationError(
          `The Oompa install could not bound the Darwin ACL on ${label}; installation stopped.`,
        );
      }
      const entry = outPointer(entryStorage);
      const tag = new Int32Array(1);
      const permissionStorage = new Uint8Array(8);
      const flagStorage = new Uint8Array(8);
      if (
        library.symbols.acl_get_tag_type(entry, tag) !== 0
        || library.symbols.acl_get_permset(entry, permissionStorage) !== 0
        || library.symbols.acl_get_flagset_np(entry, flagStorage) !== 0
      ) {
        throw new InstallNormalizationError(
          `The Oompa install could not inspect one Darwin ACL entry on ${label}; installation stopped.`,
        );
      }
      if (tag[0] !== darwinAclExtendedAllow) continue;
      const qualifier = library.symbols.acl_get_qualifier(entry);
      if (qualifier === null) {
        throw new InstallNormalizationError(
          `The Oompa install could not identify one Darwin ACL principal on ${label}; installation stopped.`,
        );
      }
      let currentPrincipal = false;
      let qualifierOperationError: unknown;
      try {
        const qualifierBytes = toBuffer(qualifier, 0, currentUserUuid.byteLength);
        currentPrincipal = qualifierBytes.equals(currentUserUuid);
      } catch (error: unknown) {
        qualifierOperationError = error;
      }
      const qualifierErrors: Error[] = [];
      if (qualifierOperationError !== undefined) {
        qualifierErrors.push(qualifierOperationError instanceof Error
          ? qualifierOperationError
          : new InstallNormalizationError(`The Oompa install could not read one Darwin ACL principal on ${label}.`));
      }
      if (library.symbols.acl_free(qualifier) !== 0) {
        qualifierErrors.push(new InstallNormalizationError(
          `The Oompa install could not settle one Darwin ACL principal on ${label}; installation stopped.`,
        ));
      }
      if (qualifierErrors.length > 1) {
        throw new AggregateError(qualifierErrors, `The Oompa install could not settle one Darwin ACL principal on ${label}.`);
      }
      if (qualifierErrors[0] !== undefined) {
        throw qualifierErrors[0];
      }
      if (currentPrincipal) continue;
      const permissions = outPointer(permissionStorage);
      for (const permission of darwinDangerousMutationPermissions) {
        const result = library.symbols.acl_get_perm_np(permissions, permission);
        if (result === -1) {
          throw new InstallNormalizationError(
            `The Oompa install could not inspect Darwin ACL mutation rights on ${label}; installation stopped.`,
          );
        }
        if (result === 1) {
          throw new InstallNormalizationError(
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
      : new InstallNormalizationError(`The Oompa install could not inspect the Darwin ACL on ${label}.`));
  }
  if (library.symbols.acl_free(acl) !== 0) {
    aclErrors.push(new InstallNormalizationError(
      `The Oompa install could not settle the Darwin ACL on ${label}; installation stopped.`,
    ));
  }
  if (aclErrors.length > 1) {
    throw new AggregateError(aclErrors, `The Oompa install could not inspect and settle the Darwin ACL on ${label}.`);
  }
  if (aclErrors[0] !== undefined) {
    throw aclErrors[0];
  }
};

class InstallNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallNormalizationError";
  }
}

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
          if (pointer === null) throw new InstallNormalizationError("Native directory error state is unavailable.");
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
        if (pointer === null) throw new InstallNormalizationError("Native directory error state is unavailable.");
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
  throw new InstallNormalizationError(
    `The Oompa install normalizer could not load descriptor-relative filesystem primitives: ${lastError instanceof Error ? lastError.message : "unknown loader failure"}`,
  );
};

let processNativeDirectoryOperations: NativeDirectoryOperations | undefined;
const nativeDirectoryOperations = (): NativeDirectoryOperations => {
  processNativeDirectoryOperations ??= loadNativeDirectoryOperations();
  return processNativeDirectoryOperations;
};

const nativeName = (name: string): Buffer => {
  if (basename(name) !== name || name === "." || name === ".." || name.includes("\0")) {
    throw new InstallNormalizationError("A descriptor-relative Oompa install name is invalid.");
  }
  return Buffer.from(`${name}\0`, "utf8");
};

const closeOnExecFlag = process.platform === "darwin" ? 0x01000000 : 0x00080000;
const noEntryErrno = 2;

type FileIdentity = Readonly<{
  dev: number;
  ino: number;
  size: number;
}>;
type ArchiveFileIdentity = FileIdentity & Readonly<{
  ctimeMs: number;
  mtimeMs: number;
}>;

type DirectoryIdentity = Readonly<{
  dev: number;
  ino: number;
}>;

type HeldDirectory = Readonly<{
  handle: FileHandle;
  identity: DirectoryIdentity;
  path: string;
  requiresCurrentOwner: boolean;
}>;

type InstallNormalizerTestHooks = Readonly<{
  afterQuarantine?: () => Promise<void> | void;
  afterPublishRename?: () => Promise<void> | void;
  afterPublishValidation?: () => Promise<void> | void;
  beforePublishRename?: () => Promise<void> | void;
}>;

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

const directoryIdentity = (metadata: Stats): DirectoryIdentity => ({
  dev: metadata.dev,
  ino: metadata.ino,
});

const sameFileIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino && left.size === right.size;
const sameArchiveFileIdentity = (left: ArchiveFileIdentity, right: ArchiveFileIdentity): boolean =>
  sameFileIdentity(left, right)
  && left.ctimeMs === right.ctimeMs
  && left.mtimeMs === right.mtimeMs;

const sameDirectoryIdentity = (left: DirectoryIdentity, right: DirectoryIdentity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const assertDirectoryMetadata = (
  metadata: Stats,
  path: string,
  uid: number,
): void => {
  const permissions = metadata.mode & 0o777;
  const rootOwnedStickyBoundary = metadata.uid === 0
    && (metadata.mode & 0o1000) !== 0
    && (permissions & 0o022) !== 0;
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || (metadata.uid !== uid && metadata.uid !== 0)
    || (permissions & 0o100) === 0
    || ((permissions & 0o022) !== 0 && !rootOwnedStickyBoundary)
  ) {
    throw new InstallNormalizationError(
      `The Oompa install path has an unsafe owner, type, or group/world-writable directory component: ${path}`,
    );
  }
};

const directoryPathsThrough = (path: string): readonly string[] => {
  const root = parse(path).root;
  if (root.length === 0 || !path.startsWith(root)) {
    throw new InstallNormalizationError("The Oompa install path is not absolute.");
  }
  const paths = [root];
  let current = root;
  for (const component of path.slice(root.length).split(sep).filter((value) => value.length > 0)) {
    current = join(current, component);
    paths.push(current);
  }
  return paths;
};

class DirectoryCustody {
  readonly #directories = new Map<string, HeldDirectory>();

  constructor(
    private readonly uid: number,
  ) {}

  async holdThrough(path: string): Promise<void> {
    let currentUserBoundarySeen = false;
    for (const directoryPath of directoryPathsThrough(path)) {
      const existing = this.#directories.get(directoryPath);
      if (existing !== undefined) {
        await this.#assertHeld(existing);
        if (existing.requiresCurrentOwner) currentUserBoundarySeen = true;
        continue;
      }
      const pathMetadata = await lstat(directoryPath);
      assertDirectoryMetadata(pathMetadata, directoryPath, this.uid);
      if (pathMetadata.uid === this.uid) currentUserBoundarySeen = true;
      if (currentUserBoundarySeen && pathMetadata.uid !== this.uid) {
        throw new InstallNormalizationError(
          `The Oompa install path returns to a non-current-user-owned directory below its user-owned boundary: ${directoryPath}`,
        );
      }
      const handle = await open(
        directoryPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      try {
        const descriptorMetadata = await handle.stat();
        assertDirectoryMetadata(descriptorMetadata, directoryPath, this.uid);
        assertSafeDarwinInstallAcl(handle.fd, this.uid, directoryPath);
        if (currentUserBoundarySeen && descriptorMetadata.uid !== this.uid) {
          throw new InstallNormalizationError(
            `The Oompa install directory descriptor is not current-user-owned below its user-owned boundary: ${directoryPath}`,
          );
        }
        const expectedIdentity = directoryIdentity(pathMetadata);
        if (!sameDirectoryIdentity(expectedIdentity, directoryIdentity(descriptorMetadata))) {
          throw new InstallNormalizationError("An Oompa install directory changed while its custody descriptor was opened.");
        }
        this.#directories.set(directoryPath, {
          handle,
          identity: expectedIdentity,
          path: directoryPath,
          requiresCurrentOwner: currentUserBoundarySeen,
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
      throw new InstallNormalizationError("The Oompa normalizer requested a directory descriptor outside held custody.");
    }
    await this.#assertHeld(held);
    return held.handle.fd;
  }

  async rebindTreeAfterRename(previousRoot: string, nextRoot: string): Promise<void> {
    const previous = resolve(previousRoot);
    const next = resolve(nextRoot);
    if (previous === next || !this.#directories.has(previous)) {
      throw new InstallNormalizationError("The Oompa install rename does not have exact held source custody.");
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
        throw new InstallNormalizationError("The Oompa install rename collides with existing directory custody.");
      }
      const [pathMetadata, descriptorMetadata] = await Promise.all([
        lstat(nextPath),
        held.handle.stat(),
      ]);
      assertDirectoryMetadata(pathMetadata, nextPath, this.uid);
      assertDirectoryMetadata(descriptorMetadata, nextPath, this.uid);
      assertSafeDarwinInstallAcl(held.handle.fd, this.uid, nextPath);
      if (
        held.requiresCurrentOwner
        && (pathMetadata.uid !== this.uid || descriptorMetadata.uid !== this.uid)
      ) {
        throw new InstallNormalizationError(
          "The renamed Oompa install directory lost current-user ownership under held custody.",
        );
      }
      if (
        !sameDirectoryIdentity(held.identity, directoryIdentity(pathMetadata))
        || !sameDirectoryIdentity(held.identity, directoryIdentity(descriptorMetadata))
      ) {
        throw new InstallNormalizationError(
          "The complete Oompa version path does not name its held staging directory after rename.",
        );
      }
      rebound.push({ held, nextPath, previousPath });
    }
    if (!rebound.some(({ previousPath }) => previousPath === previous)) {
      throw new InstallNormalizationError("The Oompa install rename did not rebind its held staging root.");
    }
    for (const { held, nextPath, previousPath } of rebound) {
      this.#directories.delete(previousPath);
      this.#directories.set(nextPath, { ...held, path: nextPath });
    }
  }

  async close(): Promise<void> {
    const directories = [...this.#directories.values()].reverse();
    this.#directories.clear();
    await Promise.all(directories.map(async ({ handle }) => { await handle.close(); }));
  }

  async #assertHeld(held: HeldDirectory): Promise<void> {
    const [pathMetadata, descriptorMetadata] = await Promise.all([
      lstat(held.path),
      held.handle.stat(),
    ]);
    assertDirectoryMetadata(pathMetadata, held.path, this.uid);
    assertDirectoryMetadata(descriptorMetadata, held.path, this.uid);
    assertSafeDarwinInstallAcl(held.handle.fd, this.uid, held.path);
    if (
      held.requiresCurrentOwner
      && (pathMetadata.uid !== this.uid || descriptorMetadata.uid !== this.uid)
    ) {
      throw new InstallNormalizationError("An Oompa install directory lost current-user ownership below its user-owned boundary.");
    }
    if (
      !sameDirectoryIdentity(held.identity, directoryIdentity(pathMetadata))
      || !sameDirectoryIdentity(held.identity, directoryIdentity(descriptorMetadata))
    ) {
      throw new InstallNormalizationError("An Oompa install directory path no longer names its held custody descriptor.");
    }
  }
}

const unlinkHeldChild = async (
  custody: DirectoryCustody,
  directory: string,
  name: string,
  missing = false,
): Promise<void> => {
  await custody.holdThrough(directory);
  await custody.assertAll();
  const directoryDescriptor = await custody.descriptorFor(directory);
  const encodedName = nativeName(name);
  try {
    const errno = nativeDirectoryOperations().unlinkAt(directoryDescriptor, encodedName, 0);
    if (errno !== 0 && !(missing && errno === noEntryErrno)) {
      throw new InstallNormalizationError(
        `Descriptor-relative Oompa install removal failed with errno ${String(errno)}.`,
      );
    }
    fsyncSync(directoryDescriptor);
    await custody.assertAll();
  } finally {
    encodedName.fill(0);
  }
};

export const assertSupportedBunInstallerVersion = (version: unknown): void => {
  if (version !== OOMPA_INSTALL_BUN_VERSION) {
    throw new InstallNormalizationError("The Oompa install normalizer requires its exact supported Bun installer version.");
  }
};

const assertOwnedRegularFile = async (
  path: string,
  uid: number,
): Promise<void> => {
  const metadata = await lstat(path);
  const mode = metadata.mode & 0o777;
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.uid !== uid
    || metadata.nlink !== 1
    || (mode !== 0o600 && mode !== 0o644)
  ) {
    throw new InstallNormalizationError("The Oompa install normalizer or package manifest is not a trusted single-link mode-0600 or mode-0644 regular file.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const descriptorMetadata = await handle.stat();
    if (!sameFileIdentity(fileIdentity(metadata), fileIdentity(descriptorMetadata))) {
      throw new InstallNormalizationError("An Oompa install metadata file changed while its custody descriptor was opened.");
    }
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
  } finally {
    await handle.close();
  }
};

const readExactBytes = async (
  handle: FileHandle,
  expectedSize: number,
  maximumBytes: number,
): Promise<Buffer> => {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > maximumBytes) {
    throw new InstallNormalizationError("An installed Oompa package file has an invalid byte length.");
  }
  const bytes = Buffer.alloc(expectedSize);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesRead < 1) {
      bytes.fill(0);
      throw new InstallNormalizationError("An installed Oompa package file ended before its declared byte length.");
    }
    offset += result.bytesRead;
  }
  const tail = Buffer.alloc(1);
  try {
    const result = await handle.read(tail, 0, 1, bytes.byteLength);
    if (result.bytesRead !== 0) {
      bytes.fill(0);
      throw new InstallNormalizationError("An installed Oompa package file grew while it was being verified.");
    }
  } finally {
    tail.fill(0);
  }
  return bytes;
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expectedKeys[index]);
};

export const assertOompaInstallManifest = (value: unknown): void => {
  if (!isRecord(value) || value.name !== expectedPackageName || value.version !== expectedPackageVersion) {
    throw new InstallNormalizationError("The installed Oompa package identity does not match its install normalizer.");
  }
  const bin = value.bin;
  const scripts = value.scripts;
  if (
    !isRecord(bin)
    || !hasExactKeys(bin, ["oompa"])
    || bin.oompa !== "./src/cli.ts"
    || !isRecord(scripts)
    || Object.keys(scripts).some((name) => lifecycleScriptNames.has(name))
  ) {
    throw new InstallNormalizationError("The installed Oompa executable or zero-lifecycle contract does not match its install normalizer.");
  }
};

const readManifest = async (path: string, uid: number): Promise<void> => {
  await assertOwnedRegularFile(path, uid);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    bytes = await readExactBytes(handle, before.size, manifestMaximumBytes);
    const after = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(after))) {
      throw new InstallNormalizationError("The installed Oompa package manifest changed while it was being verified.");
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      throw new InstallNormalizationError("The installed Oompa package manifest is not valid JSON.");
    }
    assertOompaInstallManifest(value);
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
};

const assertSourceMetadata = (
  metadata: Stats,
  uid: number,
): void => {
  const mode = metadata.mode & 0o777;
  if (
    !metadata.isFile()
    || metadata.uid !== uid
    || metadata.nlink !== 1
    || (mode !== 0o755 && mode !== 0o777)
    || !Number.isSafeInteger(metadata.size)
    || metadata.size < 1
    || metadata.size > cliMaximumBytes
  ) {
    throw new InstallNormalizationError("The Bun-installed Oompa entry point is not an expected current-user-owned single-link 0755 or 0777 regular file.");
  }
};

const quarantineCli = async (
  path: string,
  uid: number,
): Promise<Readonly<{ handle: FileHandle; identity: FileIdentity }>> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      !before.isFile()
      || before.uid !== uid
      || !Number.isSafeInteger(before.size)
      || before.size < 1
      || before.size > cliMaximumBytes
    ) {
      throw new InstallNormalizationError("The Bun-installed Oompa entry point is not a quarantinable current-user-owned regular file.");
    }
    await handle.chmod(0o600);
    await handle.sync();
    const after = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      !sameFileIdentity(fileIdentity(before), fileIdentity(after))
      || after.uid !== uid
      || (after.mode & 0o777) !== 0o600
    ) {
      throw new InstallNormalizationError("The Oompa entry point could not be quarantined on its exact installed inode.");
    }
    assertSourceMetadata(before, uid);
    return { handle, identity: fileIdentity(after) };
  } catch (error: unknown) {
    await handle.close();
    throw error;
  }
};

const assertPathIdentity = async (
  path: string,
  expectedIdentity: FileIdentity,
): Promise<void> => {
  const metadata = await lstat(path);
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || !sameFileIdentity(fileIdentity(metadata), expectedIdentity)
  ) {
    throw new InstallNormalizationError("The Oompa entry point path no longer names its quarantined installed inode.");
  }
};

const readVerifiedCli = async (
  handle: FileHandle,
  expectedIdentity: FileIdentity,
  uid: number,
): Promise<Buffer> => {
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, "the quarantined Oompa entry point");
    if (!sameFileIdentity(fileIdentity(before), expectedIdentity) || (before.mode & 0o777) !== 0o600) {
      throw new InstallNormalizationError("The quarantined Oompa entry point changed before digest verification.");
    }
    bytes = await readExactBytes(handle, before.size, cliMaximumBytes);
    const after = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, "the quarantined Oompa entry point");
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(after)) || (after.mode & 0o777) !== 0o600) {
      throw new InstallNormalizationError("The quarantined Oompa entry point changed while it was being verified.");
    }
    if (sha256(bytes) !== OOMPA_INSTALL_CLI_SHA256) {
      throw new InstallNormalizationError("The Bun-installed Oompa entry point does not match the reviewed package digest.");
    }
    return bytes;
  } catch (error: unknown) {
    bytes?.fill(0);
    throw error;
  }
};

const writeAll = async (handle: FileHandle, bytes: Buffer): Promise<void> => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
    if (result.bytesWritten < 1) {
      throw new InstallNormalizationError("The Oompa install normalizer could not publish the complete reviewed entry point.");
    }
    offset += result.bytesWritten;
  }
};

const publishVerifiedCli = async (
  path: string,
  bytes: Buffer,
  uid: number,
  beforeRename: () => Promise<void>,
): Promise<FileIdentity> => {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.oompa-cli-install-${randomUUID()}`);
  const temporary = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600,
  );
  let published = false;
  try {
    await writeAll(temporary, bytes);
    await temporary.sync();
    await temporary.chmod(0o755);
    await temporary.sync();
    const metadata = await temporary.stat();
    assertSafeDarwinInstallAcl(temporary.fd, uid, temporaryPath);
    if (
      !metadata.isFile()
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o755
      || metadata.size !== bytes.byteLength
    ) {
      throw new InstallNormalizationError("The fresh Oompa entry point inode did not retain its exact ownership, links, mode, and byte length.");
    }
    const readback = await readExactBytes(temporary, metadata.size, cliMaximumBytes);
    try {
      if (sha256(readback) !== OOMPA_INSTALL_CLI_SHA256 || !readback.equals(bytes)) {
        throw new InstallNormalizationError("The fresh Oompa entry point inode did not retain the reviewed bytes.");
      }
    } finally {
      readback.fill(0);
    }
    await beforeRename();
    await rename(temporaryPath, path);
    published = true;
    return fileIdentity(metadata);
  } finally {
    await temporary.close();
    if (!published) await rm(temporaryPath, { force: true });
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

const binLinkCandidates = (packageRoot: string): readonly string[] => [
  resolve(packageRoot, "..", "..", ".bin", "oompa"),
  resolve(packageRoot, "..", "..", "..", "..", "..", "bin", "oompa"),
];

const disableCurrentUserPath = async (
  path: string,
  uid: number,
): Promise<void> => {
  let pathMetadata: Stats;
  try {
    pathMetadata = await lstat(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (pathMetadata.uid !== uid) {
    throw new InstallNormalizationError("An Oompa command path could not be disabled because it is not current-user-owned.");
  }
  if (pathMetadata.isSymbolicLink()) {
    await rm(path);
    return;
  }
  if (!pathMetadata.isFile()) {
    throw new InstallNormalizationError("An Oompa command path could not be disabled because it is neither a file nor a symbolic link.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      !before.isFile()
      || before.uid !== uid
      || before.dev !== pathMetadata.dev
      || before.ino !== pathMetadata.ino
    ) {
      throw new InstallNormalizationError("An Oompa command path changed before it could be disabled.");
    }
    await handle.chmod(0o600);
    await handle.sync();
    const after = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      !after.isFile()
      || after.uid !== uid
      || after.dev !== before.dev
      || after.ino !== before.ino
      || (after.mode & 0o111) !== 0
    ) {
      throw new InstallNormalizationError("An Oompa command inode could not be proved non-executable.");
    }
    const rebound = await lstat(path);
    if (
      !rebound.isFile()
      || rebound.isSymbolicLink()
      || rebound.uid !== uid
      || rebound.dev !== after.dev
      || rebound.ino !== after.ino
      || (rebound.mode & 0o111) !== 0
    ) {
      throw new InstallNormalizationError("An Oompa command path no longer names its disabled inode.");
    }
  } finally {
    await handle.close();
  }
};

const disableReachableOompaCommand = async (
  packageRoot: string,
  cliPath: string,
  uid: number,
  custody: DirectoryCustody,
): Promise<void> => {
  const failures: unknown[] = [];
  for (const path of [cliPath, ...binLinkCandidates(packageRoot)]) {
    let exists = true;
    try {
      await lstat(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") exists = false;
      else failures.push(error);
    }
    if (!exists) continue;
    const parent = dirname(path);
    try {
      const parentMetadata = await lstat(parent);
      if (!parentMetadata.isDirectory() || parentMetadata.uid !== uid) {
        throw new InstallNormalizationError("An existing Oompa command path is outside a current-user-owned mutation parent.");
      }
      await custody.holdThrough(parent);
      await custody.assertAll();
      await disableCurrentUserPath(path, uid);
      await fsyncDirectory(parent);
      await custody.assertAll();
      try {
        const disabled = await lstat(path);
        if (disabled.isSymbolicLink() || !disabled.isFile() || (disabled.mode & 0o111) !== 0) {
          throw new InstallNormalizationError("An Oompa command path remained reachable and executable after refusal.");
        }
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "The Oompa install normalizer could not prove that every command path was disabled.");
  }
};

const existingBinLink = async (packageRoot: string): Promise<string> => {
  const candidates: string[] = [];
  for (const path of binLinkCandidates(packageRoot)) {
    try {
      await lstat(path);
      candidates.push(path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  if (candidates.length !== 1) {
    throw new InstallNormalizationError("The Oompa install normalizer could not identify exactly one Bun-installed oompa command link.");
  }
  return candidates[0] as string;
};

const assertExactBinLink = async (
  path: string,
  cliPath: string,
  uid: number,
  expectedIdentity?: FileIdentity,
): Promise<FileIdentity> => {
  const metadata = await lstat(path);
  if (!metadata.isSymbolicLink() || metadata.uid !== uid || metadata.nlink !== 1) {
    throw new InstallNormalizationError("The Bun-installed oompa command is not an expected current-user-owned single-link symbolic link.");
  }
  const identity = fileIdentity(metadata);
  if (expectedIdentity !== undefined && !sameFileIdentity(identity, expectedIdentity)) {
    throw new InstallNormalizationError("The Bun-installed oompa command link changed during normalization.");
  }
  if (await realpath(path) !== cliPath) {
    throw new InstallNormalizationError("The Bun-installed oompa command does not resolve to its exact package entry point.");
  }
  return identity;
};

const assertPublishedCli = async (
  path: string,
  expectedIdentity: FileIdentity,
  bytes: Buffer,
  uid: number,
): Promise<void> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let readback: Buffer | undefined;
  try {
    const metadata = await handle.stat();
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      !metadata.isFile()
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o755
      || !sameFileIdentity(fileIdentity(metadata), expectedIdentity)
    ) {
      throw new InstallNormalizationError("The published Oompa entry point path does not retain the fresh reviewed inode.");
    }
    readback = await readExactBytes(handle, metadata.size, cliMaximumBytes);
    if (sha256(readback) !== OOMPA_INSTALL_CLI_SHA256 || !readback.equals(bytes)) {
      throw new InstallNormalizationError("The published Oompa entry point path does not retain the reviewed bytes.");
    }
  } finally {
    readback?.fill(0);
    await handle.close();
  }
};

type ArchiveIdentityBase = Readonly<{
  archiveBytes: number;
  archiveSha256: string;
}>;
type OfficialArchiveIdentity = ArchiveIdentityBase & Readonly<{
  archiveAssetId: number;
  archiveReleaseId: number;
  archiveReleaseTag: "v0.8.2";
  archiveRepositoryId: 1_343_008_607;
  archiveSource: "official";
}>;
type LocalArchiveIdentity = ArchiveIdentityBase & Readonly<{
  archiveAssetId: null;
  archiveReleaseId: null;
  archiveReleaseTag: null;
  archiveRepositoryId: null;
  archiveSource: "local";
}>;
type InstallArchiveIdentity = OfficialArchiveIdentity | LocalArchiveIdentity;

type InstallIntent = InstallArchiveIdentity & Readonly<{
  archive: string;
  createdAt: number;
  id: string;
  normalizerSha256: string;
  phase: "prepared" | "installing" | "installed" | "normalized" | "published";
  previousActiveTarget: string | null;
  stagingRoot: string;
  version: 2;
  versionRoot: string;
}>;

type InstallCompleteReceipt = InstallArchiveIdentity & Readonly<{
  cliSha256: string;
  completedAt: number;
  dependencyProvenance: "bun-registry-exact-versions";
  entryCount: number;
  id: string;
  normalizerSha256: string;
  packageName: "@hraness/oompa";
  packageVersion: "0.8.2";
  totalBytes: number;
  treeSha256: string;
  version: 2;
}>;

type AuthenticatedPackageFile = Readonly<{
  sha256: string;
  size: number;
}>;

type AuthenticatedPackageManifest = Readonly<{
  directories: ReadonlySet<string>;
  files: ReadonlyMap<string, AuthenticatedPackageFile>;
}>;

const installIntentKeys = [
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

const parseArchiveIdentity = (value: Record<string, unknown>): InstallArchiveIdentity => {
  if (
    typeof value.archiveBytes !== "number"
    || !Number.isSafeInteger(value.archiveBytes)
    || value.archiveBytes < 1
    || value.archiveBytes > archiveMaximumBytes
    || typeof value.archiveSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.archiveSha256)
    || (value.archiveSource !== "official" && value.archiveSource !== "local")
  ) throw new InstallNormalizationError("The durable Oompa install archive identity is invalid.");
  if (value.archiveSource === "official") {
    if (
      typeof value.archiveAssetId !== "number"
      || !Number.isSafeInteger(value.archiveAssetId)
      || value.archiveAssetId < 1
      || typeof value.archiveReleaseId !== "number"
      || !Number.isSafeInteger(value.archiveReleaseId)
      || value.archiveReleaseId < 1
      || value.archiveReleaseTag !== "v0.8.2"
      || value.archiveRepositoryId !== 1_343_008_607
    ) throw new InstallNormalizationError("The durable Oompa official archive identity is invalid.");
    return {
      archiveAssetId: value.archiveAssetId,
      archiveBytes: value.archiveBytes,
      archiveReleaseId: value.archiveReleaseId,
      archiveReleaseTag: "v0.8.2",
      archiveRepositoryId: 1_343_008_607,
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
    throw new InstallNormalizationError("The durable Oompa local archive identity is invalid.");
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

const archivePackagePath = (path: string): string => {
  const prefix = "package/";
  if (
    !path.startsWith(prefix)
    || path.length <= prefix.length
    || Buffer.byteLength(path, "utf8") > archivePackagePathMaximumBytes
    || !/^[A-Za-z0-9._/-]+$/u.test(path)
  ) throw new InstallNormalizationError("The authenticated Oompa archive contains an invalid package path.");
  const relativePath = path.slice(prefix.length);
  const components = relativePath.split("/");
  if (
    components.length > archivePackagePathDepthMaximum
    || components.some((component) => component.length < 1 || component === "." || component === "..")
    || relativePath.startsWith("/")
    || relativePath.endsWith("/")
  ) throw new InstallNormalizationError("The authenticated Oompa archive contains an ambiguous package path.");
  return relativePath;
};

const packageDirectoriesFor = (relativePath: string): readonly string[] => {
  const components = relativePath.split("/");
  components.pop();
  const directories = [""];
  let current = "";
  for (const component of components) {
    current = current.length === 0 ? component : `${current}/${component}`;
    directories.push(current);
  }
  return directories;
};

const tarHeaderText = (header: Buffer, offset: number, length: number): string => {
  const field = header.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  const bytes = terminator === -1 ? field : field.subarray(0, terminator);
  if (bytes.some((value) => value < 0x20 || value > 0x7e)) {
    throw new InstallNormalizationError("The authenticated Oompa archive contains non-ASCII tar metadata.");
  }
  return bytes.toString("ascii");
};

const tarHeaderOctal = (header: Buffer, offset: number, length: number): number => {
  const value = tarHeaderText(header, offset, length).trim();
  if (!/^[0-7]+$/u.test(value)) {
    throw new InstallNormalizationError("The authenticated Oompa archive contains an invalid tar integer.");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InstallNormalizationError("The authenticated Oompa archive tar integer exceeds its safe bound.");
  }
  return parsed;
};

const assertTarHeaderChecksum = (header: Buffer): void => {
  const expected = tarHeaderOctal(header, 148, 8);
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (actual !== expected) {
    throw new InstallNormalizationError("The authenticated Oompa archive contains an invalid tar checksum.");
  }
};

export const parseAuthenticatedOompaPackageArchive = async (
  archiveBytes: Buffer,
): Promise<AuthenticatedPackageManifest> => {
  if (
    !Buffer.isBuffer(archiveBytes)
    || archiveBytes.byteLength < 2
    || archiveBytes.byteLength > archiveMaximumBytes
    || archiveBytes[0] !== 0x1f
    || archiveBytes[1] !== 0x8b
  ) {
    throw new InstallNormalizationError("The authenticated Oompa archive is not an exact gzip tarball.");
  }
  const directories = new Set<string>();
  const files = new Map<string, AuthenticatedPackageFile>();
  const archiveBuffer = archiveBytes.buffer;
  if (!(archiveBuffer instanceof ArrayBuffer)) {
    throw new InstallNormalizationError("The authenticated Oompa archive does not have an isolated byte buffer.");
  }
  const compressedSlices = async function* (): AsyncGenerator<Buffer> {
    let offset = 0;
    while (offset < archiveBytes.byteLength) {
      const end = Math.min(offset + archiveGzipInputSliceBytes, archiveBytes.byteLength);
      yield archiveBytes.subarray(offset, end);
      offset = end;
    }
  };
  const compressedInput = Readable.from(compressedSlices(), {
    highWaterMark: archiveGzipInputSliceBytes,
    objectMode: false,
  });
  const decompressor = createGunzip({
    chunkSize: archiveGzipOutputChunkBytes,
  });
  const observeSettlement = async (stream: Readable): Promise<boolean> => {
    try {
      await finished(stream);
      return false;
    } catch {
      return true;
    }
  };
  const inputSettlement = observeSettlement(compressedInput);
  const outputSettlement = observeSettlement(decompressor);
  compressedInput.pipe(decompressor);
  const decompressed = decompressor[Symbol.asyncIterator]();
  let current: Uint8Array = new Uint8Array(0);
  let currentOffset = 0;
  let ended = false;
  let expandedBytes = 0;
  let packagePathBytes = 0;
  let totalBytes = 0;
  const nextChunk = async (): Promise<void> => {
    if (ended) return;
    const result = await decompressed.next();
    if (result.done) {
      ended = true;
      current = new Uint8Array(0);
      currentOffset = 0;
      return;
    }
    if (
      !(result.value instanceof Uint8Array)
      || result.value.byteLength < 1
      || result.value.byteLength > archiveGzipOutputChunkBytes
    ) {
      throw new InstallNormalizationError("The authenticated Oompa archive produced an invalid gzip chunk.");
    }
    expandedBytes += result.value.byteLength;
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > archivePackageTarMaximumBytes) {
      throw new InstallNormalizationError("The authenticated Oompa archive exceeds its expanded tar-byte bound.");
    }
    current = result.value;
    currentOffset = 0;
  };
  const consume = async (
    count: number,
    onChunk?: (chunk: Uint8Array) => void,
  ): Promise<void> => {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new InstallNormalizationError("The authenticated Oompa archive requested an invalid tar span.");
    }
    let remaining = count;
    while (remaining > 0) {
      if (currentOffset === current.byteLength) await nextChunk();
      if (ended) {
        throw new InstallNormalizationError("The authenticated Oompa archive ended inside a tar entry.");
      }
      const length = Math.min(remaining, current.byteLength - currentOffset);
      const chunk = current.subarray(currentOffset, currentOffset + length);
      onChunk?.(chunk);
      currentOffset += length;
      remaining -= length;
    }
  };
  const consumeZeros = async (count: number): Promise<void> => await consume(count, (chunk) => {
    if (chunk.some((value) => value !== 0)) {
      throw new InstallNormalizationError("The authenticated Oompa archive contains nonzero tar padding.");
    }
  });
  const drainZeros = async (): Promise<void> => {
    for (;;) {
      if (currentOffset === current.byteLength) await nextChunk();
      if (ended) return;
      if (current.subarray(currentOffset).some((value) => value !== 0)) {
        throw new InstallNormalizationError("The authenticated Oompa archive contains data after its tar terminator.");
      }
      currentOffset = current.byteLength;
    }
  };
  let operationError: unknown;
  try {
    for (;;) {
      const header = Buffer.alloc(512);
      let headerOffset = 0;
      try {
        await consume(header.byteLength, (chunk) => {
          header.set(chunk, headerOffset);
          headerOffset += chunk.byteLength;
        });
        if (header.every((value) => value === 0)) {
          await consumeZeros(512);
          await drainZeros();
          break;
        }
        assertTarHeaderChecksum(header);
        if (tarHeaderText(header, 257, 6) !== "ustar" || tarHeaderText(header, 263, 2) !== "00") {
          throw new InstallNormalizationError("The authenticated Oompa archive is not an exact ustar package.");
        }
        const type = header[156];
        if (type !== 0 && type !== 0x30) {
          throw new InstallNormalizationError("The authenticated Oompa archive contains a non-regular package entry.");
        }
        const name = tarHeaderText(header, 0, 100);
        const prefix = tarHeaderText(header, 345, 155);
        const path = prefix.length === 0 ? name : `${prefix}/${name}`;
        const size = tarHeaderOctal(header, 124, 12);
        if (size > archivePackageFileMaximumBytes) {
          throw new InstallNormalizationError("The authenticated Oompa archive contains an oversized package file.");
        }
        if (files.size >= archivePackageFileMaximumCount) {
          throw new InstallNormalizationError("The authenticated Oompa archive exceeds its package-file-count bound.");
        }
        totalBytes += size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > archivePackageTotalMaximumBytes) {
          throw new InstallNormalizationError("The authenticated Oompa archive exceeds its package-file-byte bound.");
        }
        packagePathBytes += Buffer.byteLength(path, "utf8");
        if (!Number.isSafeInteger(packagePathBytes) || packagePathBytes > archivePackagePathByteMaximum) {
          throw new InstallNormalizationError("The authenticated Oompa archive exceeds its package-path-byte bound.");
        }
        const relativePath = archivePackagePath(path);
        if (files.has(relativePath)) {
          throw new InstallNormalizationError("The authenticated Oompa archive contains a duplicate package path.");
        }
        const fileHasher = createHash("sha256");
        await consume(size, (chunk) => { fileHasher.update(chunk); });
        const padding = (512 - (size % 512)) % 512;
        await consumeZeros(padding);
        files.set(relativePath, { sha256: fileHasher.digest("hex"), size });
        for (const directory of packageDirectoriesFor(relativePath)) {
          directories.add(directory);
          if (directories.size > archivePackageDirectoryMaximumCount) {
            throw new InstallNormalizationError("The authenticated Oompa archive exceeds its package-directory-count bound.");
          }
        }
      } finally {
        header.fill(0);
      }
    }
    if (files.size < 1) {
      throw new InstallNormalizationError("The authenticated Oompa archive contains no package files.");
    }
  } catch (error: unknown) {
    operationError = error;
  }
  if (operationError !== undefined) {
    compressedInput.unpipe(decompressor);
    compressedInput.destroy();
    decompressor.destroy();
  }
  const [inputSettlementFailed, outputSettlementFailed] = await Promise.all([
    inputSettlement,
    outputSettlement,
  ]);
  if (operationError !== undefined) {
    if (operationError instanceof InstallNormalizationError) throw operationError;
    throw new InstallNormalizationError("The authenticated Oompa archive could not be parsed as a bounded package tarball.");
  }
  if (inputSettlementFailed || outputSettlementFailed) {
    throw new InstallNormalizationError("The authenticated Oompa archive could not be parsed as a bounded package tarball.");
  }
  for (const required of ["package.json", cliRelativePath.replaceAll("\\", "/"), "src/install-normalizer.ts"]) {
    if (!files.has(required)) {
      throw new InstallNormalizationError("The authenticated Oompa archive omits a required package file.");
    }
  }
  return { directories, files };
};

const verifyPrivateArchive = async (
  path: string,
  uid: number,
  expected: InstallArchiveIdentity,
): Promise<AuthenticatedPackageManifest> => {
  const pathMetadata = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
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
    ) throw new InstallNormalizationError("The private Oompa archive has invalid staged custody.");
    bytes = await readExactBytes(handle, before.size, archiveMaximumBytes);
    const after = await handle.stat();
    const finalPathMetadata = await lstat(path);
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    if (
      !sameArchiveFileIdentity(archiveFileIdentity(before), archiveFileIdentity(after))
      || !sameArchiveFileIdentity(archiveFileIdentity(before), archiveFileIdentity(finalPathMetadata))
      || sha256(bytes) !== expected.archiveSha256
    ) throw new InstallNormalizationError("The private Oompa archive changed or failed its receipt SHA-256 identity.");
    return await parseAuthenticatedOompaPackageArchive(bytes);
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
};

const parseInstallIntent = (value: unknown): InstallIntent => {
  if (
    !isRecord(value)
    || !hasExactKeys(value, installIntentKeys)
    || typeof value.archive !== "string"
    || value.archive.length < 1
    || value.archive.length > 4_096
    || typeof value.createdAt !== "number"
    || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < 0
    || typeof value.id !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.id)
    || typeof value.normalizerSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(value.normalizerSha256)
    || (value.phase !== "prepared"
      && value.phase !== "installing"
      && value.phase !== "installed"
      && value.phase !== "normalized"
      && value.phase !== "published")
    || (value.previousActiveTarget !== null && typeof value.previousActiveTarget !== "string")
    || typeof value.stagingRoot !== "string"
    || typeof value.versionRoot !== "string"
    || value.version !== 2
  ) throw new InstallNormalizationError("The durable Oompa install intent is invalid.");
  const archiveIdentity = parseArchiveIdentity(value);
  if (
    (archiveIdentity.archiveSource === "official" && value.archive !== expectedArchiveUrl)
    || (
      archiveIdentity.archiveSource === "local"
      && (!isAbsolute(value.archive) || resolve(value.archive) !== value.archive)
    )
  ) throw new InstallNormalizationError("The durable Oompa install archive path does not match its source class.");
  return {
    archive: value.archive,
    ...archiveIdentity,
    createdAt: value.createdAt,
    id: value.id,
    normalizerSha256: value.normalizerSha256,
    phase: value.phase,
    previousActiveTarget: value.previousActiveTarget,
    stagingRoot: value.stagingRoot,
    version: 2,
    versionRoot: value.versionRoot,
  };
};

const readSmallJson = async (
  path: string,
  uid: number,
  maximumBytes = manifestMaximumBytes,
): Promise<unknown> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile()
      || metadata.uid !== uid
      || metadata.nlink !== 1
      || ((metadata.mode & 0o777) !== 0o600 && (metadata.mode & 0o777) !== 0o644)
    ) throw new InstallNormalizationError("An Oompa install authority document is not a trusted regular file.");
    assertSafeDarwinInstallAcl(handle.fd, uid, path);
    bytes = await readExactBytes(handle, metadata.size, maximumBytes);
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error: unknown) {
    if (error instanceof InstallNormalizationError) throw error;
    throw new InstallNormalizationError("An Oompa install authority document is invalid.");
  } finally {
    bytes?.fill(0);
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
  const encodedTemporaryName = nativeName(temporaryName);
  const encodedTargetName = nativeName(basename(path));
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
    throw new InstallNormalizationError(
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
        if (written < 1) {
          throw new InstallNormalizationError("The Oompa authority document stopped during descriptor-relative write.");
        }
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
    ) throw new InstallNormalizationError("A fresh Oompa install authority document is not private.");
    await custody.assertAll();
    const renameErrno = nativeDirectoryOperations().renameAt(
      directoryDescriptor,
      encodedTemporaryName,
      directoryDescriptor,
      encodedTargetName,
    );
    if (renameErrno !== 0) {
      throw new InstallNormalizationError(
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
      const cleanupErrno = nativeDirectoryOperations().unlinkAt(directoryDescriptor, encodedTemporaryName, 0);
      if (cleanupErrno !== 0 && cleanupErrno !== noEntryErrno) {
        throw new InstallNormalizationError(
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
  if (operationError !== undefined) {
    throw new InstallNormalizationError("Oompa authority publication failed with a non-Error value.");
  }
  if (cleanupError instanceof Error) throw cleanupError;
  if (cleanupError !== undefined) {
    throw new InstallNormalizationError("Oompa authority cleanup failed with a non-Error value.");
  }
};

const pathWithin = (root: string, candidate: string): boolean => {
  const relativePath = relative(root, candidate);
  return relativePath === ""
    || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath));
};

const normalizeInstallTree = async (
  root: string,
  packageRoot: string,
  uid: number,
  custody: DirectoryCustody,
  authenticatedPackage: AuthenticatedPackageManifest,
): Promise<Readonly<{ entryCount: number; totalBytes: number; treeSha256: string }>> => {
  let entryCount = 0;
  let totalBytes = 0;
  const authenticatedDirectoriesSeen = new Set<string>();
  const authenticatedFilesSeen = new Set<string>();
  const treeHasher = createHash("sha256");
  const record = (value: readonly (number | string)[]): void => {
    treeHasher.update(`${JSON.stringify(value)}\n`, "utf8");
  };
  const cliPath = join(packageRoot, cliRelativePath);
  const privateArchivePath = join(root, ".oompa-release-archive.tgz");
  const visit = async (directory: string): Promise<void> => {
    await custody.holdThrough(directory);
    const directoryHandle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      const before = await directoryHandle.stat();
      if (!before.isDirectory() || before.uid !== uid) {
        throw new InstallNormalizationError("The staged Oompa install contains a directory outside current-user custody.");
      }
      assertSafeDarwinInstallAcl(directoryHandle.fd, uid, directory);
      await directoryHandle.chmod(0o700);
      await directoryHandle.sync();
      const after = await directoryHandle.stat();
      assertSafeDarwinInstallAcl(directoryHandle.fd, uid, directory);
      if (
        !sameDirectoryIdentity(directoryIdentity(before), directoryIdentity(after))
        || after.uid !== uid
        || (after.mode & 0o777) !== 0o700
      ) throw new InstallNormalizationError("A staged Oompa install directory did not retain its private mode and identity.");
      if (pathWithin(packageRoot, directory)) {
        const relativePackageDirectory = relative(packageRoot, directory).replaceAll("\\", "/");
        if (!authenticatedPackage.directories.has(relativePackageDirectory)) {
          throw new InstallNormalizationError(
            "The staged Oompa package contains a directory absent from its authenticated release archive.",
          );
        }
        authenticatedDirectoriesSeen.add(relativePackageDirectory);
      }
      record(["directory", relative(root, directory).replaceAll("\\", "/"), 0o700]);
    } finally {
      await directoryHandle.close();
    }
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (path === privateArchivePath) continue;
      entryCount += 1;
      if (entryCount > installTreeEntryMaximum) {
        throw new InstallNormalizationError("The staged Oompa install exceeds its entry-count bound.");
      }
      const metadata = await lstat(path);
      if (metadata.uid !== uid) {
        throw new InstallNormalizationError("The staged Oompa install contains an entry outside current-user custody.");
      }
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (pathWithin(packageRoot, path)) {
          throw new InstallNormalizationError(
            "The staged Oompa package contains a symbolic link absent from its authenticated release archive.",
          );
        }
        if (metadata.nlink !== 1) {
          throw new InstallNormalizationError("The staged Oompa install contains a multiply linked symbolic link.");
        }
        const target = await readlink(path);
        if (
          target.length < 1
          || target.length > 4_096
          || target.includes("\0")
          || isAbsolute(target)
        ) {
          throw new InstallNormalizationError("The staged Oompa install contains an invalid symbolic-link target.");
        }
        if (!pathWithin(root, resolve(dirname(path), target))) {
          throw new InstallNormalizationError("The staged Oompa install contains a lexically escaping symbolic link.");
        }
        const resolvedTarget = await realpath(path);
        if (!pathWithin(root, resolvedTarget)) {
          throw new InstallNormalizationError("The staged Oompa install contains a symbolic link outside its complete version tree.");
        }
        record(["symlink", relative(root, path).replaceAll("\\", "/"), target]);
        continue;
      }
      if (!entry.isFile() || !metadata.isFile() || metadata.isSymbolicLink()) {
        throw new InstallNormalizationError("The staged Oompa install contains a non-file runtime entry.");
      }
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) {
        throw new InstallNormalizationError("The staged Oompa install contains a file with an invalid byte length.");
      }
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > installTreeByteMaximum) {
        throw new InstallNormalizationError("The staged Oompa install exceeds its total-byte bound.");
      }
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (
          !before.isFile()
          || before.uid !== uid
          || before.nlink !== 1
          || !sameFileIdentity(fileIdentity(metadata), fileIdentity(before))
        ) throw new InstallNormalizationError("A staged Oompa install file changed while its descriptor was opened.");
        assertSafeDarwinInstallAcl(handle.fd, uid, path);
        const desiredMode = path === cliPath
          ? 0o755
          : (before.mode & 0o111) === 0
            ? 0o600
            : 0o700;
        await handle.chmod(desiredMode);
        await handle.sync();
        const fileHasher = createHash("sha256");
        const chunk = Buffer.alloc(64 * 1024);
        try {
          let offset = 0;
          while (offset < before.size) {
            const result = await handle.read(
              chunk,
              0,
              Math.min(chunk.byteLength, before.size - offset),
              offset,
            );
            if (result.bytesRead < 1) {
              throw new InstallNormalizationError("A staged Oompa install file ended during its tree digest.");
            }
            fileHasher.update(chunk.subarray(0, result.bytesRead));
            offset += result.bytesRead;
          }
        } finally {
          chunk.fill(0);
        }
        const after = await handle.stat();
        assertSafeDarwinInstallAcl(handle.fd, uid, path);
        if (
          !sameFileIdentity(fileIdentity(before), fileIdentity(after))
          || after.uid !== uid
          || after.nlink !== 1
          || (after.mode & 0o777) !== desiredMode
        ) throw new InstallNormalizationError("A staged Oompa install file did not retain its normalized identity and mode.");
        const fileSha256 = fileHasher.digest("hex");
        if (pathWithin(packageRoot, path)) {
          const relativePackageFile = relative(packageRoot, path).replaceAll("\\", "/");
          const authenticatedFile = authenticatedPackage.files.get(relativePackageFile);
          if (
            authenticatedFile === undefined
            || authenticatedFile.size !== before.size
            || authenticatedFile.sha256 !== fileSha256
          ) {
            throw new InstallNormalizationError(
              "The staged Oompa package file does not match its authenticated release archive.",
            );
          }
          authenticatedFilesSeen.add(relativePackageFile);
        }
        record([
          "file",
          relative(root, path).replaceAll("\\", "/"),
          desiredMode,
          before.size,
          fileSha256,
        ]);
      } finally {
        await handle.close();
      }
    }
    await fsyncDirectory(directory);
  };
  await visit(root);
  if (
    authenticatedDirectoriesSeen.size !== authenticatedPackage.directories.size
    || authenticatedFilesSeen.size !== authenticatedPackage.files.size
  ) {
    throw new InstallNormalizationError(
      "The staged Oompa package is incomplete relative to its authenticated release archive.",
    );
  }
  await custody.assertAll();
  return { entryCount, totalBytes, treeSha256: treeHasher.digest("hex") };
};

export async function completeOompaStagedInstall(input: InstallArchiveIdentity & Readonly<{
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
}>): Promise<Readonly<{ versionRoot: string }>> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new InstallNormalizationError("Oompa's staged installer supports only macOS and Linux.");
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new InstallNormalizationError("Oompa's staged installer requires a current-user identity.");
  }
  assertSupportedBunInstallerVersion(Bun.version);
  const authorityRoot = resolve(input.authorityRoot);
  const stagingRoot = resolve(input.stagingRoot);
  const versionRoot = resolve(input.versionRoot);
  const intentPath = resolve(input.intentPath);
  const packageRoot = resolve(input.packageRoot);
  const normalizerPath = resolve(input.normalizerPath);
  const archiveIdentity = parseArchiveIdentity(input);
  if (typeof input.normalizerSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(input.normalizerSha256)) {
    throw new InstallNormalizationError("The staged Oompa normalizer identity is invalid.");
  }
  const expectedVersionName = [
    "v0.8.2",
    archiveIdentity.archiveSource,
    archiveIdentity.archiveSha256,
    input.normalizerSha256,
    OOMPA_INSTALL_CLI_SHA256,
  ].join("-");
  if (
    dirname(stagingRoot) !== authorityRoot
    || dirname(versionRoot) !== join(authorityRoot, "versions")
    || relative(join(authorityRoot, "versions"), versionRoot) !== expectedVersionName
    || intentPath !== join(authorityRoot, "install-intent.json")
    || packageRoot !== join(stagingRoot, "install", "global", "node_modules", "@hraness", "oompa")
    || normalizerPath !== join(packageRoot, "src", "install-normalizer.ts")
  ) throw new InstallNormalizationError("The staged Oompa install paths do not match their exact authority layout.");
  const custody = new DirectoryCustody(uid);
  let custodyClosed = false;
  try {
    await custody.holdThrough(join(packageRoot, "src"));
    await custody.holdThrough(join(authorityRoot, "versions"));
    await custody.assertAll();
    const intent = parseInstallIntent(await readSmallJson(intentPath, uid));
    if (
      intent.id !== input.intentId
      || intent.normalizerSha256 !== input.normalizerSha256
      || intent.archiveSource !== archiveIdentity.archiveSource
      || intent.archiveSha256 !== archiveIdentity.archiveSha256
      || intent.archiveBytes !== archiveIdentity.archiveBytes
      || intent.archiveReleaseId !== archiveIdentity.archiveReleaseId
      || intent.archiveAssetId !== archiveIdentity.archiveAssetId
      || intent.archiveReleaseTag !== archiveIdentity.archiveReleaseTag
      || intent.archiveRepositoryId !== archiveIdentity.archiveRepositoryId
      || intent.phase !== "installed"
      || intent.stagingRoot !== stagingRoot
      || intent.versionRoot !== versionRoot
    ) throw new InstallNormalizationError("The staged Oompa install no longer matches its durable installed-phase authority.");
    const privateArchivePath = join(stagingRoot, ".oompa-release-archive.tgz");
    const authenticatedPackage = await verifyPrivateArchive(privateArchivePath, uid, archiveIdentity);
    const normalizerBytes = await readFile(normalizerPath);
    try {
      if (sha256(normalizerBytes) !== input.normalizerSha256) {
        throw new InstallNormalizationError("The staged Oompa normalizer changed after trusted-source verification.");
      }
    } finally {
      normalizerBytes.fill(0);
    }
    await unlinkHeldChild(custody, stagingRoot, ".hra-install-complete.json", true);
    await normalizeOompaBunInstall({ normalizerPath, packageRoot });
    const normalizedTree = await normalizeInstallTree(
      stagingRoot,
      packageRoot,
      uid,
      custody,
      authenticatedPackage,
    );
    const receipt: InstallCompleteReceipt = {
      ...archiveIdentity,
      cliSha256: OOMPA_INSTALL_CLI_SHA256,
      completedAt: input.completedAt,
      dependencyProvenance: "bun-registry-exact-versions",
      entryCount: normalizedTree.entryCount,
      id: input.intentId,
      normalizerSha256: input.normalizerSha256,
      packageName: "@hraness/oompa",
      packageVersion: "0.8.2",
      totalBytes: normalizedTree.totalBytes,
      treeSha256: normalizedTree.treeSha256,
      version: 2,
    };
    await writeAtomicJson(
      join(stagingRoot, ".hra-install-complete.json"),
      receipt,
      uid,
      custody,
    );
    await unlinkHeldChild(custody, stagingRoot, basename(privateArchivePath));
    await custody.assertAll();
    try {
      await lstat(versionRoot);
      throw new InstallNormalizationError("The complete Oompa version destination already exists.");
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await input.beforeVersionRename?.();
    await custody.assertAll();
    await rename(stagingRoot, versionRoot);
    await input.afterVersionRename?.();
    await custody.rebindTreeAfterRename(stagingRoot, versionRoot);
    await fsyncDirectory(dirname(versionRoot));
    await custody.assertAll();
    await input.afterVersionRebind?.();
    await writeAtomicJson(
      intentPath,
      { ...intent, phase: "normalized" },
      uid,
      custody,
    );
    await custody.assertAll();
    await custody.close();
    custodyClosed = true;
    return { versionRoot };
  } finally {
    if (!custodyClosed) await custody.close();
  }
}

export async function normalizeOompaBunInstall(input: Readonly<{
  normalizerPath: string;
  packageRoot: string;
  testHooks?: InstallNormalizerTestHooks;
}>): Promise<void> {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new InstallNormalizationError("Oompa's Bun install normalizer supports only macOS and Linux.");
  }
  const uid = process.getuid?.();
  if (uid === undefined) {
    throw new InstallNormalizationError("Oompa's Bun install normalizer requires a current-user identity.");
  }
  const requestedPackageRoot = resolve(input.packageRoot);
  const requestedNormalizerPath = resolve(input.normalizerPath);
  let packageRoot = requestedPackageRoot;
  let sourceDirectory = join(packageRoot, "src");
  let cliPath = join(packageRoot, cliRelativePath);
  const custody = new DirectoryCustody(uid);
  let quarantined: Readonly<{ handle: FileHandle; identity: FileIdentity }> | undefined;
  let bytes: Buffer | undefined;
  let operationError: unknown;
  try {
    packageRoot = await realpath(requestedPackageRoot);
    sourceDirectory = join(packageRoot, "src");
    cliPath = join(packageRoot, cliRelativePath);
    await custody.holdThrough(sourceDirectory);
    quarantined = await quarantineCli(cliPath, uid);
    await custody.assertAll();
    await assertPathIdentity(cliPath, quarantined.identity);

    assertSupportedBunInstallerVersion(Bun.version);
    const normalizerPath = await realpath(requestedNormalizerPath);
    if (packageRoot !== requestedPackageRoot || normalizerPath !== requestedNormalizerPath) {
      throw new InstallNormalizationError("The Oompa install normalizer refuses symlinked package or normalizer paths.");
    }
    const expectedNormalizerPath = join(packageRoot, "src", "install-normalizer.ts");
    if (normalizerPath !== expectedNormalizerPath) {
      throw new InstallNormalizationError("The Oompa install normalizer is not inside its exact package root.");
    }

    await input.testHooks?.afterQuarantine?.();
    await custody.assertAll();
    await assertPathIdentity(cliPath, quarantined.identity);

    const binLink = await existingBinLink(packageRoot);
    await custody.holdThrough(dirname(binLink));
    await custody.assertAll();
    const binLinkIdentity = await assertExactBinLink(binLink, cliPath, uid);
    await assertOwnedRegularFile(normalizerPath, uid);
    await readManifest(join(packageRoot, "package.json"), uid);
    bytes = await readVerifiedCli(quarantined.handle, quarantined.identity, uid);

    const quarantinedIdentity = quarantined.identity;
    const freshIdentity = await publishVerifiedCli(cliPath, bytes, uid, async () => {
      await input.testHooks?.beforePublishRename?.();
      await custody.assertAll();
      await assertPathIdentity(cliPath, quarantinedIdentity);
      await assertExactBinLink(binLink, cliPath, uid, binLinkIdentity);
    });
    await input.testHooks?.afterPublishRename?.();
    await fsyncDirectory(sourceDirectory);
    await custody.assertAll();
    await assertPublishedCli(cliPath, freshIdentity, bytes, uid);
    await assertExactBinLink(binLink, cliPath, uid, binLinkIdentity);
    await input.testHooks?.afterPublishValidation?.();
  } catch (error: unknown) {
    operationError = error;
  }

  if (operationError !== undefined) {
    let refusalError: unknown;
    try {
      await disableReachableOompaCommand(packageRoot, cliPath, uid, custody);
    } catch (error: unknown) {
      refusalError = error;
    }
    bytes?.fill(0);
    const cleanupResults = await Promise.allSettled([
      quarantined?.handle.close() ?? Promise.resolve(),
      custody.close(),
    ]);
    const cleanupErrors = cleanupResults
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (refusalError !== undefined || cleanupErrors.length > 0) {
      const primaryMessage = operationError instanceof Error
        ? operationError.message
        : "The Oompa install operation failed.";
      throw new AggregateError(
        [operationError, ...(refusalError === undefined ? [] : [refusalError]), ...cleanupErrors],
        `${primaryMessage} Complete command quarantine could not be proved.`,
      );
    }
    if (operationError instanceof Error) throw operationError;
    throw new InstallNormalizationError("The Oompa install operation failed with a non-Error refusal.");
  }

  bytes?.fill(0);
  const cleanupResults = await Promise.allSettled([
    quarantined?.handle.close() ?? Promise.resolve(),
    custody.close(),
  ]);
  const cleanupErrors = cleanupResults
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (cleanupErrors.length > 0) {
    let refusalError: unknown;
    try {
      const refusalCustody = new DirectoryCustody(uid);
      try {
        await disableReachableOompaCommand(packageRoot, cliPath, uid, refusalCustody);
      } finally {
        await refusalCustody.close();
      }
    } catch (error: unknown) {
      refusalError = error;
    }
    throw new AggregateError(
      [...cleanupErrors, ...(refusalError === undefined ? [] : [refusalError])],
      refusalError === undefined
        ? "The Oompa install failed during descriptor settlement after its command was disabled."
        : "The Oompa install failed during descriptor settlement and command quarantine could not be proved.",
    );
  }
}

if (import.meta.main) {
  try {
    await normalizeOompaBunInstall({
      normalizerPath: import.meta.path,
      packageRoot: resolve(import.meta.dir, ".."),
    });
  } catch {
    process.stderr.write("oompa install: the reviewed executable could not be normalized safely; installation stopped.\n");
    process.exitCode = 1;
  }
}
