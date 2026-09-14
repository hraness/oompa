import { randomUUID } from "node:crypto";
import { constants, lstatSync, realpathSync, type Stats } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { Database, type SQLiteError } from "bun:sqlite";
import { z } from "zod";

import { LOCAL_DAEMON_PROTOCOL } from "../domain/contracts";
import { issueDaemonRecoveryAuthority, providerProcessFileIdentitySchema, type DaemonRecoveryAuthority, type ProviderProcessFileIdentity,
  type ProviderProcessLocalFiles, type ProviderProcessRecoveryActor,
  type ProviderProcessRecoverySnapshot, type ProviderProcessRecoveryStore } from "../domain/provider-process-custody";
import { ensurePrivateDirectory, type StatePaths } from "../storage/paths";
export { readDaemonRecoveryAuthority, type DaemonRecoveryAuthority } from "../domain/provider-process-custody";

export const DAEMON_PROTOCOL = LOCAL_DAEMON_PROTOCOL;

const receiptStateSchema = z.enum(["booting", "ready", "stopping", "stopped", "failed", "maintenance"]);

export const daemonAuthorityReceiptSchema = z.object({
  version: z.literal(2),
  protocol: z.literal(DAEMON_PROTOCOL),
  pid: z.number().int().positive(),
  nonce: z.string().uuid(),
  state: receiptStateSchema,
  acquiredAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  generation: z.number().int().positive().optional(),
  bootId: z.string().regex(/^boot_[a-f0-9]{32}$/u).optional(),
  failure: z.string().min(1).max(1_000).optional(),
}).strict().superRefine((receipt, context) => {
  if (receipt.updatedAt < receipt.acquiredAt) {
    context.addIssue({ code: "custom", message: "Daemon receipt time cannot precede authority acquisition." });
  }
  if ((receipt.generation === undefined) !== (receipt.bootId === undefined)) {
    context.addIssue({ code: "custom", message: "Daemon generation and boot ID must be published together." });
  }
  if (receipt.state === "ready" && receipt.generation === undefined) {
    context.addIssue({ code: "custom", message: "A ready daemon receipt requires an authority generation." });
  }
  if (receipt.state === "failed" && receipt.failure === undefined) {
    context.addIssue({ code: "custom", message: "A failed daemon receipt requires a bounded diagnostic." });
  }
});

export type DaemonAuthorityReceipt = z.infer<typeof daemonAuthorityReceiptSchema>;

export type DaemonAuthorityDatabaseInspection =
  | Readonly<{ custody: "absent" }>
  | Readonly<{ custody: "safe"; authority: "held" | "released" }>
  | Readonly<{ custody: "unsafe" }>
  | Readonly<{ custody: "invalid" }>
  | Readonly<{ custody: "indeterminate" }>;

export type DaemonAuthorityReceiptInspection =
  | Readonly<{ custody: "absent" }>
  | Readonly<{ custody: "safe"; state: DaemonAuthorityReceipt["state"] }>
  | Readonly<{ custody: "invalid" }>
  | Readonly<{ custody: "unsafe" }>
  | Readonly<{ custody: "indeterminate" }>;

export type DaemonAuthorityInspection = Readonly<{
  state:
    | "absent"
    | "held"
    | "releasing"
    | "released"
    | "stale_recoverable"
    | "unsafe_receipt"
    | "unsafe_database"
    | "invalid_database"
    | "indeterminate";
  database: DaemonAuthorityDatabaseInspection;
  receipt: DaemonAuthorityReceiptInspection;
}>;

export class DaemonAuthoritySafetyError extends Error {
  readonly code = "DAEMON_AUTHORITY_UNSAFE" as const;

  constructor(message: string) {
    super(message);
    this.name = "DaemonAuthoritySafetyError";
  }
}

class DaemonAuthorityObservationRaceError extends DaemonAuthoritySafetyError {
  constructor(message: string) {
    super(message);
    this.name = "DaemonAuthorityObservationRaceError";
  }
}

const currentUid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

export const daemonAuthorityDatabasePath = (paths: StatePaths): string => `${paths.daemonLock}.authority.sqlite`;

function validateOwnedRegularFileAttributes(
  path: string,
  metadata: Stats,
  maximumBytes?: number,
): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DaemonAuthoritySafetyError(`Unsafe daemon authority file: ${path}`);
  }
  const uid = currentUid();
  if (uid !== undefined && metadata.uid !== uid) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file is owned by another user: ${path}`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file has unsafe permissions: ${path}`);
  }
  if (maximumBytes !== undefined && metadata.size > maximumBytes) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file exceeds its byte limit: ${path}`);
  }
  if (resolve(dirname(path), basename(path)) !== path) {
    throw new DaemonAuthoritySafetyError(`Daemon authority file path is not canonical: ${path}`);
  }
}

async function validateOwnedRegularFile(path: string, maximumBytes?: number): Promise<Stats> {
  const metadata = await lstat(path);
  if (metadata.nlink !== 1) {
    throw new DaemonAuthoritySafetyError(`Unsafe daemon authority file: ${path}`);
  }
  validateOwnedRegularFileAttributes(path, metadata, maximumBytes);
  return metadata;
}

async function ensureAuthorityDatabaseFile(paths: StatePaths): Promise<{ path: string; metadata: Stats }> {
  await ensurePrivateDirectory(paths.runtime);
  const path = daemonAuthorityDatabasePath(paths);
  try {
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    await handle.close();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { path, metadata: await validateOwnedRegularFile(path) };
}

async function validateReplaceableReceipt(path: string): Promise<Stats | null> {
  try {
    return await validateOwnedRegularFile(path, 4_096);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

const sameFileIdentity = (left: Stats, right: Stats): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const sameReceipt = (left: DaemonAuthorityReceipt, right: DaemonAuthorityReceipt): boolean =>
  left.pid === right.pid
  && left.nonce === right.nonce
  && left.state === right.state
  && left.acquiredAt === right.acquiredAt
  && left.updatedAt === right.updatedAt
  && left.generation === right.generation
  && left.bootId === right.bootId
  && left.failure === right.failure;

type ExpectedReceiptPublication = Readonly<{
  receipt: DaemonAuthorityReceipt;
  device: number;
  inode: number;
}>;

async function writeReceipt(
  paths: StatePaths,
  receipt: DaemonAuthorityReceipt,
  expected?: ExpectedReceiptPublication,
): Promise<Stats> {
  const path = paths.daemonLock;
  const parsed = daemonAuthorityReceiptSchema.parse(receipt);
  const replaced = await validateReplaceableReceipt(path);
  if (
    expected !== undefined
    && (
      replaced === null
      || replaced.dev !== expected.device
      || replaced.ino !== expected.inode
    )
  ) {
    throw new DaemonAuthoritySafetyError(
      "The named daemon authority receipt changed before publication began.",
    );
  }
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let temporaryMetadata: Stats;
    try {
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
      temporaryMetadata = await handle.stat();
    } finally {
      await handle.close();
    }
    const uid = currentUid();
    if (
      !temporaryMetadata.isFile()
      || temporaryMetadata.isSymbolicLink()
      || temporaryMetadata.nlink !== 1
      || temporaryMetadata.size > 4_096
      || (temporaryMetadata.mode & 0o777) !== 0o600
      || (uid !== undefined && temporaryMetadata.uid !== uid)
    ) {
      throw new DaemonAuthoritySafetyError(
        "The prepared daemon authority receipt is unsafe for publication.",
      );
    }
    if (expected !== undefined) {
      const observed = await readDaemonAuthorityReceipt(paths);
      if (observed === null || !sameReceipt(observed, expected.receipt)) {
        throw new DaemonAuthoritySafetyError(
          "The daemon authority receipt contents changed before publication.",
        );
      }
    }
    const current = await validateReplaceableReceipt(path);
    if ((replaced === null) !== (current === null)
      || (replaced !== null && current !== null && !sameFileIdentity(replaced, current))) {
      throw new DaemonAuthoritySafetyError("Daemon authority receipt changed before atomic publication.");
    }

    // Portable Node/Bun filesystem APIs do not offer rename-if-the-target-still-
    // names-this-inode. The SQLite authority plus DaemonLock's publication queue
    // exclude legitimate concurrent writers; exact checks on both sides of this
    // single rename detect replacement outside the irreducible syscall gap.
    await rename(temporary, path);
    const published = await validateOwnedRegularFile(path, 4_096);
    if (!sameFileIdentity(published, temporaryMetadata)) {
      throw new DaemonAuthoritySafetyError(
        "The daemon authority receipt changed immediately after publication.",
      );
    }
    return published;
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function isSqliteBusy(error: unknown): error is SQLiteError {
  if (error instanceof DaemonAuthoritySafetyError) return false;
  if (!(error instanceof Error) || error.name !== "SQLiteError") return false;
  const sqlite = error as SQLiteError;
  return Number.isInteger(sqlite.errno)
    && (sqlite.errno & 0xff) === 5
    && typeof sqlite.code === "string"
    && (sqlite.code === "SQLITE_BUSY" || sqlite.code.startsWith("SQLITE_BUSY_"));
}

export class DaemonAuthorityBusyError extends Error {
  readonly code = "DAEMON_AUTHORITY_BUSY" as const;

  constructor(receipt: DaemonAuthorityReceipt | null) {
    super(receipt === null
      ? "A Oompa process already owns the local daemon authority."
      : `A Oompa process already owns the local daemon authority (pid ${receipt.pid}, ${receipt.state}).`);
    this.name = "DaemonAuthorityBusyError";
  }
}

export type DaemonEffectAuthority = Readonly<{
  generation: number;
  bootId: string;
}>;

/**
 * A closeable capability for one published daemon lifetime. Callers recheck it
 * immediately before every external effect and every local commit that follows
 * an await.
 */
export class DaemonAuthorityFence {
  readonly authority: DaemonEffectAuthority;
  readonly #lock: DaemonLock;
  #closed = false;

  constructor(lock: DaemonLock, authority: DaemonEffectAuthority) {
    const receipt = lock.receipt;
    if (receipt.generation !== authority.generation || receipt.bootId !== authority.bootId) {
      throw new DaemonAuthoritySafetyError("The requested daemon effect authority is not the published lock authority.");
    }
    this.#lock = lock;
    this.authority = Object.freeze({ ...authority });
  }

  close(): void {
    this.#closed = true;
  }

  #isClosed(): boolean {
    return this.#closed;
  }

  async assertCurrent(): Promise<void> {
    if (this.#isClosed()) {
      throw new DaemonAuthoritySafetyError("The daemon effect authority is closed.");
    }
    await this.#lock.assertCurrent();
    const receipt = this.#lock.receipt;
    if (
      this.#isClosed()
      || receipt.generation !== this.authority.generation
      || receipt.bootId !== this.authority.bootId
    ) {
      throw new DaemonAuthoritySafetyError("The daemon effect authority generation or boot ID changed.");
    }
  }

  /** Final admission prefix: no await between this check and the owned effect. */
  assertCurrentSynchronously(): void {
    if (this.#isClosed()) throw new DaemonAuthoritySafetyError("The daemon effect authority is closed.");
    this.#lock.nativeFileIdentity();
    const receipt = this.#lock.receipt;
    if (receipt.generation !== this.authority.generation || receipt.bootId !== this.authority.bootId) {
      throw new DaemonAuthoritySafetyError("The daemon effect authority generation or boot ID changed.");
    }
  }
}

type DaemonReceiptReadHooks = Readonly<{
  afterDescriptorRead?(): void | Promise<void>;
  afterNamedValidation?(): void | Promise<void>;
  afterDescriptorOpen?(): void | Promise<void>;
  readNamedMetadata?(path: string): Promise<Stats>;
}>;

export async function readDaemonAuthorityReceipt(
  paths: StatePaths,
  hooks: DaemonReceiptReadHooks = {},
): Promise<DaemonAuthorityReceipt | null> {
  const observation = await observeDaemonAuthorityReceipt(paths, hooks);
  return observation.kind === "valid" ? observation.receipt : null;
}

type DaemonAuthorityReceiptObservation =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "valid"; receipt: DaemonAuthorityReceipt }>
  | Readonly<{ kind: "invalid" }>;

async function observeDaemonAuthorityReceipt(
  paths: StatePaths,
  hooks: DaemonReceiptReadHooks = {},
): Promise<DaemonAuthorityReceiptObservation> {
  let namedReceiptObserved = false;
  const readNamedMetadata = async (): Promise<Stats> => {
    const metadata = await (hooks.readNamedMetadata ?? lstat)(paths.daemonLock);
    validateOwnedRegularFileAttributes(paths.daemonLock, metadata, 4_096);
    if (metadata.nlink !== 0 && metadata.nlink !== 1) {
      throw new DaemonAuthoritySafetyError(`Unsafe daemon authority file: ${paths.daemonLock}`);
    }
    return metadata;
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const before = await readNamedMetadata();
      namedReceiptObserved = true;
      // An atomic publication can unlink the inode after the kernel resolves
      // lstat's name but before it captures metadata. Zero links prove neither
      // the current name nor readable authority: start a fresh bounded attempt.
      // Database and writer validation continue to require exactly one link.
      if (before.nlink === 0) continue;
      await hooks.afterNamedValidation?.();
      const handle = await open(paths.daemonLock, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await hooks.afterDescriptorOpen?.();
        const metadata = await handle.stat();
        const uid = currentUid();
        if (
          !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.size > 4_096
          || (metadata.mode & 0o777) !== 0o600
          || (uid !== undefined && metadata.uid !== uid)
        ) {
          throw new DaemonAuthoritySafetyError("Daemon authority receipt became unsafe while it was opened.");
        }
        if (metadata.nlink !== 1) {
          if (metadata.nlink !== 0) {
            throw new DaemonAuthoritySafetyError("Daemon authority receipt became unsafe while it was opened.");
          }
          let current: Stats;
          try {
            current = await readNamedMetadata();
          } catch (error: unknown) {
            if (error instanceof DaemonAuthoritySafetyError) throw error;
            throw new DaemonAuthorityObservationRaceError(
              "The unlinked daemon authority receipt has no safe named replacement.",
            );
          }
          if (current.nlink === 0) continue;
          if (current.dev === metadata.dev && current.ino === metadata.ino) {
            throw new DaemonAuthoritySafetyError(
              "The unlinked daemon authority receipt still names its opened inode.",
            );
          }
          continue;
        }
        if (metadata.dev !== before.dev || metadata.ino !== before.ino) {
          continue;
        }
        const contents = await handle.readFile("utf8");
        await hooks.afterDescriptorRead?.();
        const afterRead = await handle.stat();
        let current: Stats;
        try {
          current = await readNamedMetadata();
        } catch (error: unknown) {
          if (error instanceof DaemonAuthoritySafetyError) throw error;
          throw new DaemonAuthorityObservationRaceError(
            "The opened daemon authority receipt has no safe named identity after reading.",
          );
        }
        if (current.nlink === 0) continue;
        if (current.dev !== afterRead.dev || current.ino !== afterRead.ino) {
          continue;
        }
        if (
          !afterRead.isFile()
          || afterRead.isSymbolicLink()
          || afterRead.nlink !== 1
          || afterRead.size > 4_096
          || Buffer.byteLength(contents, "utf8") > 4_096
          || (afterRead.mode & 0o777) !== 0o600
          || (uid !== undefined && afterRead.uid !== uid)
        ) {
          throw new DaemonAuthoritySafetyError(
            "Daemon authority receipt became unsafe while its contents were read.",
          );
        }
        const value = JSON.parse(contents) as unknown;
        const parsed = daemonAuthorityReceiptSchema.safeParse(value);
        return parsed.success
          ? { kind: "valid", receipt: parsed.data }
          : { kind: "invalid" };
      } finally {
        await handle.close();
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (!namedReceiptObserved) return { kind: "absent" };
        throw new DaemonAuthorityObservationRaceError(
          "The observed daemon authority receipt has no safe named replacement.",
        );
      }
      if (error instanceof SyntaxError) return { kind: "invalid" };
      throw error;
    }
  }
  throw new DaemonAuthorityObservationRaceError(
    "Daemon authority receipt changed repeatedly while it was opened.",
  );
}

async function inspectReceiptCustody(paths: StatePaths): Promise<Readonly<{
  public: DaemonAuthorityReceiptInspection;
  receipt?: DaemonAuthorityReceipt;
}>> {
  try {
    const observation = await observeDaemonAuthorityReceipt(paths);
    if (observation.kind === "valid") {
      return {
        public: Object.freeze({ custody: "safe", state: observation.receipt.state }),
        receipt: observation.receipt,
      };
    }
    return { public: Object.freeze({ custody: observation.kind }) };
  } catch (error: unknown) {
    if (error instanceof DaemonAuthorityObservationRaceError) {
      return { public: Object.freeze({ custody: "indeterminate" }) };
    }
    if (error instanceof DaemonAuthoritySafetyError) {
      return { public: Object.freeze({ custody: "unsafe" }) };
    }
    return { public: Object.freeze({ custody: "indeterminate" }) };
  }
}

async function inspectDatabaseCustody(paths: StatePaths): Promise<DaemonAuthorityDatabaseInspection> {
  const databasePath = daemonAuthorityDatabasePath(paths);
  let before: Stats;
  try {
    before = await validateOwnedRegularFile(databasePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return Object.freeze({ custody: "absent" });
    }
    if (error instanceof DaemonAuthoritySafetyError) {
      return Object.freeze({ custody: "unsafe" });
    }
    return Object.freeze({ custody: "indeterminate" });
  }

  let database: Database | undefined;
  let result: DaemonAuthorityDatabaseInspection = Object.freeze({ custody: "indeterminate" });
  try {
    database = new Database(databasePath, { readonly: true, create: false, strict: true });
    const opened = await validateOwnedRegularFile(databasePath);
    if (sameFileIdentity(opened, before)) {
      // A bounded wait prevents another short-lived read-only inspector from
      // being mistaken for the long-lived daemon owner.
      database.exec("PRAGMA busy_timeout = 10; BEGIN EXCLUSIVE");
      database.exec("SELECT rootpage FROM sqlite_schema LIMIT 1");
      database.exec("ROLLBACK");
      const final = await validateOwnedRegularFile(databasePath);
      result = sameFileIdentity(final, opened)
        ? Object.freeze({ custody: "safe", authority: "released" })
        : Object.freeze({ custody: "indeterminate" });
    }
  } catch (error: unknown) {
    if (error instanceof DaemonAuthoritySafetyError) {
      result = Object.freeze({ custody: "unsafe" });
    } else if (isSqliteBusy(error)) {
      try {
        const final = await validateOwnedRegularFile(databasePath);
        result = sameFileIdentity(final, before)
          ? Object.freeze({ custody: "safe", authority: "held" })
          : Object.freeze({ custody: "indeterminate" });
      } catch (validationError: unknown) {
        result = validationError instanceof DaemonAuthoritySafetyError
          ? Object.freeze({ custody: "unsafe" })
          : Object.freeze({ custody: "indeterminate" });
      }
    } else if (error instanceof Error && error.name === "SQLiteError") {
      try {
        const final = await validateOwnedRegularFile(databasePath);
        result = sameFileIdentity(final, before)
          ? Object.freeze({ custody: "invalid" })
          : Object.freeze({ custody: "indeterminate" });
      } catch (validationError: unknown) {
        result = validationError instanceof DaemonAuthoritySafetyError
          ? Object.freeze({ custody: "unsafe" })
          : Object.freeze({ custody: "indeterminate" });
      }
    }
  } finally {
    try {
      database?.close();
    } catch {
      result = Object.freeze({ custody: "indeterminate" });
    }
  }
  return result;
}

function sameReceiptObservation(
  left: Awaited<ReturnType<typeof inspectReceiptCustody>>,
  right: Awaited<ReturnType<typeof inspectReceiptCustody>>,
): boolean {
  if (left.public.custody !== right.public.custody) return false;
  if (left.receipt === undefined || right.receipt === undefined) {
    return left.receipt === right.receipt;
  }
  return sameReceipt(left.receipt, right.receipt);
}

const terminalReceiptStates = new Set<DaemonAuthorityReceipt["state"]>(["stopped", "failed"]);

function summarizeAuthorityInspection(
  database: DaemonAuthorityDatabaseInspection,
  receipt: DaemonAuthorityReceiptInspection,
): DaemonAuthorityInspection["state"] {
  if (database.custody === "unsafe") return "unsafe_database";
  if (database.custody === "invalid") return "invalid_database";
  if (database.custody === "indeterminate") return "indeterminate";
  if (receipt.custody === "unsafe") return "unsafe_receipt";
  if (receipt.custody === "indeterminate") return "indeterminate";

  if (database.custody === "absent") {
    return receipt.custody === "absent" ? "absent" : "indeterminate";
  }
  if (database.authority === "held") {
    if (receipt.custody !== "safe") return "indeterminate";
    return terminalReceiptStates.has(receipt.state) ? "releasing" : "held";
  }
  if (receipt.custody === "absent") return "released";
  if (receipt.custody === "invalid") return "stale_recoverable";
  return terminalReceiptStates.has(receipt.state) ? "released" : "stale_recoverable";
}

/**
 * Observes local daemon authority without creating, repairing, or writing any
 * state. SQLite lock ownership is authoritative; the receipt contributes only
 * bounded, path-free custody and lifecycle evidence.
 */
export async function inspectDaemonAuthority(paths: StatePaths): Promise<DaemonAuthorityInspection> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const receiptBefore = await inspectReceiptCustody(paths);
    const database = await inspectDatabaseCustody(paths);
    const receiptAfter = await inspectReceiptCustody(paths);
    if (!sameReceiptObservation(receiptBefore, receiptAfter)) continue;
    return Object.freeze({
      state: summarizeAuthorityInspection(database, receiptAfter.public),
      database,
      receipt: receiptAfter.public,
    });
  }
  return Object.freeze({
    state: "indeterminate",
    database: Object.freeze({ custody: "indeterminate" }),
    receipt: Object.freeze({ custody: "indeterminate" }),
  });
}

function nativeAuthorityFileIdentity(path: string, expected?: ProviderProcessFileIdentity): ProviderProcessFileIdentity {
  const metadata = lstatSync(path, { bigint: true });
  const uid = currentUid();
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n
    || (metadata.mode & 0o777n) !== 0o600n || (uid !== undefined && metadata.uid !== BigInt(uid))
    || realpathSync(path) !== path) throw new DaemonAuthoritySafetyError("Unsafe native daemon authority identity.");
  const identity = providerProcessFileIdentitySchema.parse({ device: metadata.dev.toString(), inode: metadata.ino.toString() });
  if (expected !== undefined && (identity.device !== expected.device || identity.inode !== expected.inode)) {
    throw new DaemonAuthoritySafetyError("The exact native daemon authority file changed.");
  }
  return identity;
}

export class DaemonLock {
  readonly #paths: StatePaths;
  readonly #database: Database;
  readonly #authorityPath: string;
  readonly #authorityDevice: number;
  readonly #authorityInode: number;
  readonly #nativeAuthorityIdentity: ProviderProcessFileIdentity;
  #receipt: DaemonAuthorityReceipt;
  #receiptDevice: number;
  #receiptInode: number;
  #publicationTail: Promise<void> = Promise.resolve();
  #released = false;

  private constructor(
    paths: StatePaths,
    database: Database,
    authority: { path: string; device: number; inode: number; nativeIdentity: ProviderProcessFileIdentity },
    receipt: { value: DaemonAuthorityReceipt; device: number; inode: number },
  ) {
    this.#paths = paths;
    this.#database = database;
    this.#authorityPath = authority.path;
    this.#authorityDevice = authority.device;
    this.#authorityInode = authority.inode;
    this.#nativeAuthorityIdentity = authority.nativeIdentity;
    this.#receipt = receipt.value;
    this.#receiptDevice = receipt.device;
    this.#receiptInode = receipt.inode;
  }

  get receipt(): DaemonAuthorityReceipt {
    return { ...this.#receipt };
  }

  #assertHeldSynchronously(): void {
    if (this.#released || !this.#database.inTransaction) {
      throw new DaemonAuthoritySafetyError("The exact daemon authority transaction is not held.");
    }
    this.#database.query("SELECT 1 AS authority_held").get();
    nativeAuthorityFileIdentity(this.#authorityPath, this.#nativeAuthorityIdentity);
  }

  nativeFileIdentity(): ProviderProcessFileIdentity {
    this.#assertHeldSynchronously();
    return { ...this.#nativeAuthorityIdentity };
  }

  /** Issued only before this lock publishes a generation; the old tuple is never impersonated. */
  async createRecoveryAuthority(store: ProviderProcessRecoveryStore): Promise<DaemonRecoveryAuthority> {
    await this.assertCurrent();
    if (this.#receipt.state !== "booting" || this.#receipt.generation !== undefined
      || store.paths.daemonLock !== this.#paths.daemonLock) {
      throw new DaemonAuthoritySafetyError("Startup admission is not closed for this exact store.");
    }
    const snapshot: ProviderProcessRecoverySnapshot = store.providerProcessRecoverySnapshot();
    const actor: ProviderProcessRecoveryActor = { kind: "startup-recovery", authorityNonce: this.#receipt.nonce,
      previousDaemon: snapshot.previousDaemon };
    const localFiles: ProviderProcessLocalFiles = { authority: this.nativeFileIdentity(), state: snapshot.state };
    const assertHeld = () => {
      this.#assertHeldSynchronously();
      if (this.#receipt.state !== "booting" || this.#receipt.generation !== undefined) {
        throw new DaemonAuthoritySafetyError("Startup recovery admission is closed.");
      }
      store.assertProviderProcessRecoverySnapshot(snapshot);
    };
    return issueDaemonRecoveryAuthority({ store, actor, localFiles, assertHeld,
      assertCurrent: () => this.assertCurrent() });
  }

  async #validateAuthorityName(): Promise<void> {
    const metadata = await validateOwnedRegularFile(this.#authorityPath);
    if (metadata.dev !== this.#authorityDevice || metadata.ino !== this.#authorityInode) {
      throw new DaemonAuthoritySafetyError("The named daemon authority database changed while authority was held.");
    }
  }

  async #serializePublication<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#publicationTail;
    let release!: () => void;
    this.#publicationTail = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async assertCurrent(
    hooks: Readonly<{ afterTransactionProbe?(): void | Promise<void> }> = {},
  ): Promise<void> {
    if (this.#released) throw new DaemonAuthoritySafetyError("The daemon authority has already been released.");
    await this.#validateAuthorityName();
    try {
      this.#database.query("SELECT 1 AS authority_held").get();
    } catch (error: unknown) {
      throw new DaemonAuthoritySafetyError(`The daemon authority transaction is unavailable${error instanceof Error ? ` (${error.name})` : ""}.`);
    }
    await hooks.afterTransactionProbe?.();
    await this.#validateAuthorityName();
    this.#assertHeldSynchronously();
  }

  static async acquire(
    paths: StatePaths,
    input: { pid?: number; nonce?: string; now?: number; state?: "booting" | "maintenance" } = {},
  ): Promise<DaemonLock> {
    const authority = await ensureAuthorityDatabaseFile(paths);
    const nativeIdentity = nativeAuthorityFileIdentity(authority.path);
    const database = new Database(authority.path, { create: false, strict: true });
    try {
      const opened = await validateOwnedRegularFile(authority.path);
      if (opened.dev !== authority.metadata.dev || opened.ino !== authority.metadata.ino) {
        throw new DaemonAuthoritySafetyError("The named daemon authority database changed while it was opened.");
      }
      database.exec("PRAGMA busy_timeout = 0; PRAGMA journal_mode = DELETE; BEGIN EXCLUSIVE");
    } catch (error: unknown) {
      database.close();
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      if (isSqliteBusy(error)) {
        const currentAuthority = await validateOwnedRegularFile(authority.path);
        if (!sameFileIdentity(currentAuthority, authority.metadata)) {
          throw new DaemonAuthoritySafetyError(
            "The named daemon authority database changed while busy authority was inspected.",
          );
        }
        throw new DaemonAuthorityBusyError(await readDaemonAuthorityReceipt(paths));
      }
      throw new Error("The daemon authority database is invalid and requires manual recovery.", { cause: error });
    }
    const now = input.now ?? Date.now();
    const receipt = daemonAuthorityReceiptSchema.parse({
      version: 2,
      protocol: DAEMON_PROTOCOL,
      pid: input.pid ?? process.pid,
      nonce: input.nonce ?? randomUUID(),
      state: input.state ?? "booting",
      acquiredAt: now,
      updatedAt: now,
    });
    try {
      const named = await validateOwnedRegularFile(authority.path);
      if (named.dev !== authority.metadata.dev || named.ino !== authority.metadata.ino) {
        throw new DaemonAuthoritySafetyError("The named daemon authority database changed during acquisition.");
      }
      const publishedReceipt = await writeReceipt(paths, receipt);
      const finalAuthority = await validateOwnedRegularFile(authority.path);
      if (!sameFileIdentity(finalAuthority, authority.metadata)) {
        throw new DaemonAuthoritySafetyError(
          "The named daemon authority database changed while its receipt was published.",
        );
      }
      return new DaemonLock(paths, database, {
        path: authority.path,
        device: authority.metadata.dev,
        inode: authority.metadata.ino,
        nativeIdentity: nativeAuthorityFileIdentity(authority.path, nativeIdentity),
      }, {
        value: receipt,
        device: publishedReceipt.dev,
        inode: publishedReceipt.ino,
      });
    } catch (error: unknown) {
      try { database.exec("ROLLBACK"); } catch { /* Closing still releases the OS lock. */ }
      database.close();
      throw error;
    }
  }

  static async isAuthorityHeld(
    paths: StatePaths,
    input: Readonly<{
      openDatabase?: (path: string) => Pick<Database, "close" | "exec">;
    }> = {},
  ): Promise<boolean> {
    const databasePath = daemonAuthorityDatabasePath(paths);
    let before: Stats;
    try {
      before = await validateOwnedRegularFile(databasePath);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    let database: Pick<Database, "close" | "exec"> | undefined;
    try {
      database = input.openDatabase?.(databasePath)
        ?? new Database(databasePath, { create: false, strict: true });
      const opened = await validateOwnedRegularFile(databasePath);
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new DaemonAuthoritySafetyError("The named daemon authority database changed while it was inspected.");
      }
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
      database.exec("ROLLBACK");
      const final = await validateOwnedRegularFile(databasePath);
      if (!sameFileIdentity(final, opened)) {
        throw new DaemonAuthoritySafetyError(
          "The named daemon authority database changed while its release was inspected.",
        );
      }
      return false;
    } catch (error: unknown) {
      if (error instanceof DaemonAuthoritySafetyError) throw error;
      if (isSqliteBusy(error)) {
        const final = await validateOwnedRegularFile(databasePath);
        if (!sameFileIdentity(final, before)) {
          throw new DaemonAuthoritySafetyError(
            "The named daemon authority database changed while busy authority was inspected.",
          );
        }
        return true;
      }
      throw new Error("The daemon authority database is invalid and requires manual recovery.", { cause: error });
    } finally {
      database?.close();
    }
  }

  async publish(input: {
    state: DaemonAuthorityReceipt["state"];
    generation?: number;
    bootId?: string;
    failure?: string;
    now?: number;
  }): Promise<DaemonAuthorityReceipt> {
    if (this.#released) throw new Error("The daemon authority has already been released.");
    return await this.#serializePublication(async () => {
      if (this.#released) throw new Error("The daemon authority has already been released.");
      await this.#validateAuthorityName();
      const previous = this.#receipt;
      const next = daemonAuthorityReceiptSchema.parse({
        ...previous,
        state: input.state,
        updatedAt: Math.max(input.now ?? Date.now(), previous.updatedAt),
        ...(input.generation === undefined ? {} : { generation: input.generation }),
        ...(input.bootId === undefined ? {} : { bootId: input.bootId }),
        ...(input.failure === undefined ? {} : { failure: input.failure.slice(0, 1_000) }),
      });
      const published = await writeReceipt(this.#paths, next, {
        receipt: previous,
        device: this.#receiptDevice,
        inode: this.#receiptInode,
      });
      await this.#validateAuthorityName();
      this.#receipt = next;
      this.#receiptDevice = published.dev;
      this.#receiptInode = published.ino;
      return { ...next };
    });
  }

  async release(input: { state?: "stopped" | "failed"; failure?: string; now?: number } = {}): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    await this.#serializePublication(async () => {
      const errors: unknown[] = [];
      try {
        await this.#validateAuthorityName();
        const previous = this.#receipt;
        const state = input.state ?? (previous.state === "failed" ? "failed" : "stopped");
        const failure = state === "failed"
          ? input.failure ?? previous.failure ?? "Daemon authority released after an unspecified failure."
          : undefined;
        const next = daemonAuthorityReceiptSchema.parse({
          ...previous,
          state,
          updatedAt: Math.max(input.now ?? Date.now(), previous.updatedAt),
          ...(failure === undefined ? {} : { failure: failure.slice(0, 1_000) }),
        });
        const published = await writeReceipt(this.#paths, next, {
          receipt: previous,
          device: this.#receiptDevice,
          inode: this.#receiptInode,
        });
        await this.#validateAuthorityName();
        this.#receipt = next;
        this.#receiptDevice = published.dev;
        this.#receiptInode = published.ino;
      } catch (error: unknown) {
        errors.push(error);
      }
      try { this.#database.exec("ROLLBACK"); } catch (error: unknown) { errors.push(error); }
      try { this.#database.close(); } catch (error: unknown) { errors.push(error); }
      if (errors.length > 0) throw new AggregateError(errors, "Daemon authority release was incomplete.");
    });
  }
}
