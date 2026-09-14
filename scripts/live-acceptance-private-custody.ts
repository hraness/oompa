import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type PrivateDirectoryIdentity = Readonly<{
  device: number;
  inode: number;
  mode: 0o700;
  owner: number;
  path: string;
}>;

export type PrivateFileIdentity = Readonly<{
  device: number;
  inode: number;
  sha256: string;
  parent: Readonly<{ device: number; inode: number; mode: number; owner: number }>;
}>;

export type AtomicPrivateJsonPolicy<T> = Readonly<{
  assertRuntime(value: T): Promise<void>;
  createdIdentityMatches(current: T, next: T): boolean;
  invalid(): Error;
  maximumBytes: number;
  parse(value: unknown): T;
  path(value: T): string;
}>;

const currentOwner = (invalid: () => Error): number => {
  const owner = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (owner === undefined) throw invalid();
  return owner;
};

const normalizedAbsolute = (value: string, invalid: () => Error): string => {
  if (!isAbsolute(value) || resolve(value) !== value) throw invalid();
  return value;
};

export const privatePathsOverlap = (leftInput: string, rightInput: string): boolean => {
  const left = resolve(leftInput);
  const right = resolve(rightInput);
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  const contained = (relation: string): boolean => relation !== ".."
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation);
  return left === right
    || contained(leftToRight)
    || contained(rightToLeft);
};

export const isPrivateDirectChild = (parent: string, child: string): boolean => {
  const relation = relative(parent, child);
  return relation !== ""
    && !relation.startsWith("..")
    && !isAbsolute(relation)
    && !relation.includes("/")
    && !relation.includes("\\");
};

export async function observePrivateDirectory(
  pathInput: string,
  invalid: () => Error,
): Promise<PrivateDirectoryIdentity> {
  const path = normalizedAbsolute(pathInput, invalid);
  const metadata = await lstat(path);
  if (
    !metadata.isDirectory()
    || metadata.isSymbolicLink()
    || metadata.uid !== currentOwner(invalid)
    || (metadata.mode & 0o7777) !== 0o700
  ) throw invalid();
  if (await realpath(path) !== path) throw invalid();
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: 0o700,
    owner: metadata.uid,
    path,
  };
}

export async function assertPrivateDirectoryIdentity(
  identity: PrivateDirectoryIdentity,
  invalid: () => Error,
): Promise<void> {
  const current = await observePrivateDirectory(identity.path, invalid);
  if (
    current.device !== identity.device
    || current.inode !== identity.inode
    || current.owner !== identity.owner
  ) throw invalid();
}

export async function createPrivateTemporaryDirectory(
  prefix: string,
  invalid: () => Error,
): Promise<PrivateDirectoryIdentity> {
  const path = await mkdtemp(prefix);
  await chmod(path, 0o700);
  return await observePrivateDirectory(path, invalid);
}

export async function privatePathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export const syncPrivateDirectory = syncDirectory;

const assertSafeFileMetadata = (
  metadata: Stats,
  maximumBytes: number,
  invalid: () => Error,
): void => {
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || metadata.nlink !== 1
    || metadata.uid !== currentOwner(invalid)
    || (metadata.mode & 0o7777) !== 0o600
    || metadata.size > maximumBytes
  ) throw invalid();
};

async function observeReceiptParent(
  path: string,
  invalid: () => Error,
): Promise<PrivateFileIdentity["parent"]> {
  const parent = dirname(path);
  const metadata = await lstat(parent);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(parent) !== parent) {
    throw invalid();
  }
  // The existing Codex receipt may live directly in the shared canonical temp
  // directory. Its policy owns location admission; continuity also binds this
  // parent, without pretending that every valid parent is user-only mode 0700.
  return {
    device: metadata.dev,
    inode: metadata.ino,
    mode: metadata.mode,
    owner: metadata.uid,
  };
}

const sameReceiptParent = (
  left: PrivateFileIdentity["parent"],
  right: PrivateFileIdentity["parent"],
): boolean => left.device === right.device && left.inode === right.inode
  && left.mode === right.mode && left.owner === right.owner;

/** Read-only synchronous join to an already verified receipt; no raw bytes or identity escape. */
function assertVerifiedPrivateFile(
  pathInput: string,
  maximumBytes: number,
  identity: PrivateFileIdentity,
  invalid: () => Error,
): void {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024) throw invalid();
  const path = normalizedAbsolute(pathInput, invalid);
  const parent = (): PrivateFileIdentity["parent"] => {
    const directory = dirname(path);
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(directory) !== directory) throw invalid();
    return { device: metadata.dev, inode: metadata.ino, mode: metadata.mode, owner: metadata.uid };
  };
  if (!sameReceiptParent(parent(), identity.parent)) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer | undefined;
  try {
    const before = fstatSync(fd);
    assertSafeFileMetadata(before, maximumBytes, invalid);
    if (before.dev !== identity.device || before.ino !== identity.inode) throw invalid();
    bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.byteLength) {
      const count = readSync(fd, bytes, length, bytes.byteLength - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length !== before.size || length > maximumBytes) throw invalid();
    const sha256 = createHash("sha256").update(bytes.subarray(0, length)).digest("hex");
    const after = fstatSync(fd);
    const named = lstatSync(path);
    for (const metadata of [after, named]) {
      assertSafeFileMetadata(metadata, maximumBytes, invalid);
      if (metadata.dev !== before.dev || metadata.ino !== before.ino || metadata.size !== before.size
        || metadata.mtimeMs !== before.mtimeMs || metadata.ctimeMs !== before.ctimeMs) throw invalid();
    }
    if (sha256 !== identity.sha256 || !sameReceiptParent(parent(), identity.parent)) throw invalid();
  } finally {
    bytes?.fill(0);
    closeSync(fd);
  }
}

async function readPrivateJson<T>(
  pathInput: string,
  maximumBytes: number,
  parse: (value: unknown) => T,
  invalid: () => Error,
): Promise<Readonly<{ identity: PrivateFileIdentity; value: T }>> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1024 * 1024) {
    throw invalid();
  }
  const path = normalizedAbsolute(pathInput, invalid);
  const parent = await observeReceiptParent(path, invalid);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const bytes = Buffer.alloc(maximumBytes + 1);
  try {
    const before = await handle.stat();
    assertSafeFileMetadata(before, maximumBytes, invalid);
    let length = 0;
    while (length < bytes.byteLength) {
      const result = await handle.read(bytes, length, bytes.byteLength - length, length);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length !== before.size || length > maximumBytes) throw invalid();
    const contents = bytes.subarray(0, length);
    const value = parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents)) as unknown);
    const after = await handle.stat();
    const named = await lstat(path);
    for (const metadata of [after, named]) {
      assertSafeFileMetadata(metadata, maximumBytes, invalid);
      if (
        metadata.dev !== before.dev
        || metadata.ino !== before.ino
        || metadata.size !== before.size
        || metadata.mtimeMs !== before.mtimeMs
        || metadata.ctimeMs !== before.ctimeMs
      ) throw invalid();
    }
    if (!sameReceiptParent(parent, await observeReceiptParent(path, invalid))) throw invalid();
    if (length !== after.size || length > maximumBytes) throw invalid();
    return {
      identity: {
        device: after.dev,
        inode: after.ino,
        parent,
        sha256: createHash("sha256").update(contents).digest("hex"),
      },
      value,
    };
  } finally {
    bytes.fill(0);
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Atomic mode-0600 JSON custody with inode continuity and caller-supplied
 * semantic validation. The policy remains specific to each closed receipt;
 * this class exposes no arbitrary filesystem mutation surface. The mutation
 * guard covers this instance; callers need exclusive run ownership across
 * processes. Atomic rename is not a cross-process compare-and-swap.
 */
export class AtomicPrivateJsonReceipt<T> {
  #identity: PrivateFileIdentity;
  readonly #policy: AtomicPrivateJsonPolicy<T>;
  #value: T;
  #mutating = false;
  #removed = false;

  private constructor(
    value: T,
    identity: PrivateFileIdentity,
    policy: AtomicPrivateJsonPolicy<T>,
  ) {
    this.#value = value;
    this.#identity = identity;
    this.#policy = policy;
  }

  static async create<T>(
    valueInput: T,
    policy: AtomicPrivateJsonPolicy<T>,
  ): Promise<AtomicPrivateJsonReceipt<T>> {
    const value = policy.parse(structuredClone(valueInput));
    await policy.assertRuntime(value);
    const path = normalizedAbsolute(policy.path(value), policy.invalid);
    const parent = dirname(path);
    const parentIdentity = await observeReceiptParent(path, policy.invalid);
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > policy.maximumBytes) {
      throw policy.invalid();
    }
    const handle = await open(
      path,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(parent);
    const { identity } = await readPrivateJson(path, policy.maximumBytes, policy.parse, policy.invalid);
    if (
      identity.sha256 !== createHash("sha256").update(serialized).digest("hex")
      || !sameReceiptParent(parentIdentity, identity.parent)
    ) {
      throw policy.invalid();
    }
    return new AtomicPrivateJsonReceipt(value, identity, policy);
  }

  static async open<T>(
    locatorInput: T,
    policy: AtomicPrivateJsonPolicy<T>,
  ): Promise<AtomicPrivateJsonReceipt<T>> {
    const locator = policy.parse(structuredClone(locatorInput));
    await policy.assertRuntime(locator);
    const path = normalizedAbsolute(policy.path(locator), policy.invalid);
    const { value, identity } = await readPrivateJson(
      path, policy.maximumBytes, policy.parse, policy.invalid,
    );
    if (!policy.createdIdentityMatches(locator, value)) throw policy.invalid();
    await policy.assertRuntime(value);
    const receipt = new AtomicPrivateJsonReceipt(value, identity, policy);
    await receipt.#assertCurrent();
    return receipt;
  }

  get value(): T {
    return structuredClone(this.#value);
  }

  /**
   * Assert the retained verified inode, content digest and parent synchronously.
   * This does not refresh the baseline, invoke policy effects, or grant ownership.
   */
  assertVerifiedIdentity(): void {
    this.#assertInspectable();
    const identity = this.#identity;
    try {
      assertVerifiedPrivateFile(this.#policy.path(this.#value), this.#policy.maximumBytes, identity, this.#policy.invalid);
      this.#assertInspectable();
      if (this.#identity !== identity) throw this.#policy.invalid();
    } catch { throw this.#policy.invalid(); }
  }

  #assertInspectable(): void {
    if (this.#mutating || this.#removed) throw this.#policy.invalid();
  }

  async update(transform: (current: T) => T): Promise<T> {
    this.#beginMutation();
    try {
      return await this.#update(transform);
    } finally {
      this.#mutating = false;
    }
  }

  async #update(transform: (current: T) => T): Promise<T> {
    const next = this.#policy.parse(structuredClone(transform(this.value)));
    if (!this.#policy.createdIdentityMatches(this.#value, next)) {
      throw this.#policy.invalid();
    }
    await this.#policy.assertRuntime(next);
    await this.#assertCurrent();
    const path = this.#policy.path(next);
    const parent = dirname(path);
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized, "utf8") > this.#policy.maximumBytes) {
      throw this.#policy.invalid();
    }
    const temporary = resolve(parent, `.${basename(path)}.${randomUUID()}.tmp`);
    if (dirname(temporary) !== parent) throw this.#policy.invalid();
    const handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    let temporaryIdentity: Readonly<{ device: number; inode: number }>;
    try {
      await handle.chmod(0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      const metadata = await handle.stat();
      assertSafeFileMetadata(metadata, this.#policy.maximumBytes, this.#policy.invalid);
      temporaryIdentity = { device: metadata.dev, inode: metadata.ino };
    } finally {
      await handle.close();
    }
    const serializedDigest = createHash("sha256").update(serialized).digest("hex");
    const assertOwnedTemporary = async (): Promise<void> => {
      const { identity } = await readPrivateJson(
        temporary, this.#policy.maximumBytes, this.#policy.parse, this.#policy.invalid,
      );
      if (identity.device !== temporaryIdentity.device || identity.inode !== temporaryIdentity.inode
        || identity.sha256 !== serializedDigest
        || !sameReceiptParent(identity.parent, this.#identity.parent)) throw this.#policy.invalid();
    };
    let renamed = false;
    try {
      await this.#assertCurrent();
      await assertOwnedTemporary();
      await rename(temporary, path);
      renamed = true;
      await syncDirectory(parent);
    } catch (error: unknown) {
      if (!renamed) {
        // An uncertain or substituted temporary belongs to neither this update
        // nor its cleanup. Preserve it instead of unlinking by name alone.
        try {
          await assertOwnedTemporary();
          await unlink(temporary);
          await syncDirectory(parent);
        } catch { throw this.#policy.invalid(); }
      }
      throw error;
    }
    const { identity } = await readPrivateJson(
      path,
      this.#policy.maximumBytes,
      this.#policy.parse,
      this.#policy.invalid,
    );
    if (
      identity.sha256 !== createHash("sha256").update(serialized).digest("hex")
      || !sameReceiptParent(this.#identity.parent, identity.parent)
    ) {
      throw this.#policy.invalid();
    }
    this.#identity = identity;
    this.#value = next;
    return this.value;
  }

  async remove(): Promise<void> {
    this.#beginMutation();
    try {
      await this.#policy.assertRuntime(this.value);
      await this.#assertCurrent();
      const path = this.#policy.path(this.#value);
      await unlink(path);
      this.#removed = true;
      await syncDirectory(dirname(path));
    } finally {
      this.#mutating = false;
    }
  }

  #beginMutation(): void {
    if (this.#mutating || this.#removed) throw this.#policy.invalid();
    this.#mutating = true;
  }

  async #assertCurrent(): Promise<void> {
    const { identity: current } = await readPrivateJson(
      this.#policy.path(this.#value),
      this.#policy.maximumBytes,
      this.#policy.parse,
      this.#policy.invalid,
    );
    if (
      current.device !== this.#identity.device
      || current.inode !== this.#identity.inode
      || current.sha256 !== this.#identity.sha256
      || !sameReceiptParent(current.parent, this.#identity.parent)
    ) throw this.#policy.invalid();
  }
}
