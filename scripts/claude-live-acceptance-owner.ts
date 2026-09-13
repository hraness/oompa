import { dlopen } from "bun:ffi";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, unlinkSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { z } from "zod";

import { resolveStatePaths } from "../src/storage/paths";
import { privatePathsOverlap } from "./live-acceptance-private-custody";

export type ClaudeLiveAcceptanceOwner = Readonly<{
  /** Recheck the held path incarnation immediately before staging or native effects. */
  assertCurrent(): void;
  /** Terminal cleanup: the authoritative recovery receipt must already be absent. */
  removeAndRelease(): Promise<void>;
  /** Terminal failure/recovery handoff: leave the exact lock name in place. */
  releasePreserving(): Promise<void>;
}>;

export class ClaudeLiveAcceptanceOwnerError extends Error {
  constructor(readonly code: "scope_refused" | "custody_refused" | "concurrent_owner" |
  "primitive_unavailable" | "receipt_present" | "release_unproven" | "closed") {
    super(`claude_live_acceptance_owner_${code}`);
    this.name = "ClaudeLiveAcceptanceOwnerError";
  }
}

const inputSchema = z.object({ runId: z.string().uuid(), receiptPath: z.string().min(1).max(4096) }).strict();
const refused = (code: ClaudeLiveAcceptanceOwnerError["code"] = "custody_refused"): never => {
  throw new ClaudeLiveAcceptanceOwnerError(code);
};
const requireThat = (condition: boolean): void => { if (!condition) refused(); };
type FlockLibrary = Readonly<{ symbols: Readonly<{ flock(fd: number, operation: number): number }> }>;
let library: FlockLibrary | undefined;

const flock = (fd: number, operation: number): number => {
  if (library === undefined) {
    const architecture = process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : null;
    const candidates = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"]
      : process.platform === "linux" && architecture !== null ? [
        `/lib/${architecture}-linux-gnu/libc.so.6`, `/usr/lib/${architecture}-linux-gnu/libc.so.6`,
        "/lib64/libc.so.6", "/usr/lib64/libc.so.6",
        `/lib/libc.musl-${architecture}.so.1`, `/usr/lib/libc.musl-${architecture}.so.1`,
        `/lib/ld-musl-${architecture}.so.1`, `/usr/lib/ld-musl-${architecture}.so.1`,
      ] : [];
    for (const path of candidates) {
      try {
        library = dlopen(path, { flock: { args: ["i32", "i32"], returns: "i32" } });
        break;
      } catch { /* The fixed platform libc candidates are the complete fallback set. */ }
    }
  }
  if (library === undefined) return refused("primitive_unavailable");
  return library.symbols.flock(fd, operation);
};

const lockExclusiveNonblocking = 2 | 4;
const lockUnlock = 8;
const sameNode = (left: Stats, right: Stats): boolean => left.dev === right.dev
  && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode;
const privateLock = (value: Stats, uid: number): boolean => value.isFile()
  && !value.isSymbolicLink() && value.uid === uid && value.nlink === 1
  && (value.mode & 0o7777) === 0o600 && value.size === 0;
const receiptAbsent = (path: string): boolean => {
  try { lstatSync(path); return false; } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
};

/**
 * One native owner for one exact temporary acceptance receipt. All syscall
 * admission/release steps are synchronous; the held descriptors span awaits in
 * the runner. This is not a public or general-purpose locking API.
 */
export async function acquireClaudeLiveAcceptanceOwner(input: Readonly<{
  runId: string;
  receiptPath: string;
}>): Promise<ClaudeLiveAcceptanceOwner> {
  return acquireOwner(input, "session");
}

/** A distinct, closed receipt family for the Mac authentication experiment. */
export async function acquireClaudeMacosAuthQualificationOwner(input: Readonly<{
  runId: string;
  receiptPath: string;
}>): Promise<ClaudeLiveAcceptanceOwner> {
  if (process.platform !== "darwin") return refused("primitive_unavailable");
  return acquireOwner(input, "macos_auth");
}

/** Separate fresh Darwin-session receipts never acquire auth or Linux session ownership. */
export async function acquireClaudeMacosSessionQualificationOwner(input: Readonly<{
  runId: string;
  receiptPath: string;
}>): Promise<ClaudeLiveAcceptanceOwner> {
  if (process.platform !== "darwin") return refused("primitive_unavailable");
  return acquireOwner(input, "macos_session");
}

/** The daemon restart ceremony owns a distinct fresh private namespace. */
export async function acquireClaudeMacosDaemonQualificationOwner(input: Readonly<{
  runId: string;
  receiptPath: string;
}>): Promise<ClaudeLiveAcceptanceOwner> {
  if (process.platform !== "darwin") return refused("primitive_unavailable");
  return acquireOwner(input, "macos_daemon");
}

async function acquireOwner(input: Readonly<{
  runId: string;
  receiptPath: string;
}>, scope: "session" | "macos_auth" | "macos_session" | "macos_daemon"): Promise<ClaudeLiveAcceptanceOwner> {
  let parentFd: number | undefined;
  let lockFd: number | undefined;
  try {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) return refused("scope_refused");
    const { runId, receiptPath } = parsed.data;
    const prefix = scope === "session" ? ".oompa-live-claude-acceptance"
      : scope === "macos_auth" ? ".oompa-macos-auth-qualification"
      : scope === "macos_session" ? ".oompa-macos-session-qualification" : ".oompa-macos-daemon-qualification";
    const parent = dirname(receiptPath);
    const shortDarwinScope = scope === "macos_session" || scope === "macos_daemon";
    const temporaryRoot = shortDarwinScope ? "/private/tmp" : realpathSync(tmpdir());
    if (!isAbsolute(receiptPath) || resolve(receiptPath) !== receiptPath
      || basename(receiptPath) !== `${prefix}-${runId}.recovery.json`
      || (parent !== temporaryRoot && !parent.startsWith(`${temporaryRoot}${sep}`))
      || privatePathsOverlap(parent, homedir()) || privatePathsOverlap(parent, resolveStatePaths().root)
      || realpathSync(parent) !== parent) return refused("scope_refused");
    // A short fixed namespace keeps the Darwin callback socket within sockaddr_un.
    const parentPattern = scope === "macos_daemon" ? /^oompa-md-[A-Za-z0-9]{6}$/u : /^oompa-ms-[A-Za-z0-9]{6}$/u;
    if (shortDarwinScope && (realpathSync(temporaryRoot) !== temporaryRoot || dirname(parent) !== temporaryRoot
      || !parentPattern.test(basename(parent)))) return refused("scope_refused");
    const uid = process.getuid?.();
    if (uid === undefined) return refused("primitive_unavailable");
    const lockPath = join(parent, `${prefix}-${runId}.lock`);
    parentFd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | constants.O_DIRECTORY);
    const parentIdentity = fstatSync(parentFd);
    requireThat(parentIdentity.isDirectory() && parentIdentity.nlink > 0 && sameNode(parentIdentity, lstatSync(parent)));
    if (shortDarwinScope) requireThat(parentIdentity.uid === uid && (parentIdentity.mode & 0o7777) === 0o700);
    lockFd = openSync(lockPath, constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR | constants.O_NONBLOCK, 0o600);
    const identity = fstatSync(lockFd);
    requireThat(privateLock(identity, uid) && sameNode(identity, lstatSync(lockPath)));
    if (flock(lockFd, lockExclusiveNonblocking) !== 0) return refused("concurrent_owner");
    const heldParent = parentFd;
    const heldLock = lockFd;
    const assertHeld = (): void => {
      const directory = fstatSync(heldParent);
      const namedDirectory = lstatSync(parent);
      requireThat(directory.isDirectory() && directory.nlink > 0
        && namedDirectory.isDirectory() && !namedDirectory.isSymbolicLink()
        && sameNode(parentIdentity, directory) && sameNode(parentIdentity, namedDirectory)
        && realpathSync(parent) === parent);
      const current = fstatSync(heldLock);
      const named = lstatSync(lockPath);
      requireThat(privateLock(current, uid) && privateLock(named, uid)
        && sameNode(identity, current) && sameNode(identity, named));
    };
    // A contender that opened an old unlinked inode must never become owner.
    assertHeld();
    fsyncSync(heldLock);
    fsyncSync(heldParent);
    assertHeld();
    let closed = false;
    const finish = (remove: boolean): void => {
      if (closed) return refused("closed");
      closed = true;
      let failure: unknown;
      try {
        assertHeld();
        if (remove) {
          if (!receiptAbsent(receiptPath)) return refused("receipt_present");
          assertHeld();
          unlinkSync(lockPath);
          fsyncSync(heldParent);
        }
      } catch (error: unknown) { failure = error; }
      finally {
        try { if (flock(heldLock, lockUnlock) !== 0) failure ??= new ClaudeLiveAcceptanceOwnerError("release_unproven"); }
        catch { failure ??= new ClaudeLiveAcceptanceOwnerError("release_unproven"); }
        try { closeSync(heldLock); } catch { failure ??= new ClaudeLiveAcceptanceOwnerError("release_unproven"); }
        try { closeSync(heldParent); } catch { failure ??= new ClaudeLiveAcceptanceOwnerError("release_unproven"); }
      }
      if (failure instanceof ClaudeLiveAcceptanceOwnerError) throw failure;
      if (failure !== undefined) return refused();
    };
    // The controller now exclusively owns both descriptors.
    parentFd = undefined;
    lockFd = undefined;
    return Object.freeze({
      assertCurrent() {
        if (closed) return refused("closed");
        try { assertHeld(); } catch (error: unknown) {
          if (error instanceof ClaudeLiveAcceptanceOwnerError) throw error;
          return refused();
        }
      },
      async removeAndRelease() { finish(true); },
      async releasePreserving() { finish(false); },
    });
  } catch (error: unknown) {
    let cleanupFailed = false;
    if (lockFd !== undefined) try { closeSync(lockFd); } catch { cleanupFailed = true; }
    if (parentFd !== undefined) try { closeSync(parentFd); } catch { cleanupFailed = true; }
    if (cleanupFailed) return refused("release_unproven");
    if (error instanceof ClaudeLiveAcceptanceOwnerError) throw error;
    return refused();
  }
}
