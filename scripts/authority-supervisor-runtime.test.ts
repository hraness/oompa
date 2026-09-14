import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { closeSync, constants, fstatSync, openSync, opendirSync, readlinkSync, readSync, type Stats } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable } from "node:stream";

import { afterEach, expect, test } from "bun:test";

import { openAuthoritySupervisorArtifact } from "./authority-supervisor-artifact";
import { runBoundedProcess } from "./bounded-process";

const roots: string[] = [];
const ownedFixtureCleanups = new Map<string, () => Promise<boolean>>();
const pendingFixtureCleanups = new Set<() => Promise<boolean>>();

type RuntimeFixtureScope = Readonly<{
  assertActive(): void;
  own(cleanup: () => Promise<void>): void;
  acquire<T>(setup: () => Promise<T>, cleanup: (resource: T) => Promise<void>): Promise<T>;
}>;

const createOwnedRuntimeFixture = (
  operation: (scope: RuntimeFixtureScope) => Promise<void>,
  cleanupTimeoutMs = 2_000,
) => {
  const cleanups: (() => Promise<void>)[] = [];
  let stopping = false;
  let collection: Promise<boolean> | undefined;
  const assertActive = () => {
    if (stopping) throw new Error("authority_runtime_fixture_stopping");
  };
  const scope: RuntimeFixtureScope = {
    assertActive,
    own: (cleanup) => { assertActive(); cleanups.push(cleanup); },
    acquire: async (setup, cleanup) => {
      assertActive();
      const resource = await setup();
      // Capture a late acquisition even when teardown began during setup.
      cleanups.push(() => cleanup(resource));
      assertActive();
      return resource;
    },
  };
  const work = Promise.resolve().then(() => { assertActive(); return operation(scope); });
  const outcome = work.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  const collect = (): Promise<boolean> => {
    if (collection !== undefined) return collection;
    stopping = true;
    const cleanupDeadline = performance.now() + cleanupTimeoutMs;
    const joined = (async () => {
      const closeCaptured = async () => await Promise.all(cleanups.splice(0).reverse().map(async (cleanup) => {
        try { await cleanup(); return true; } catch { return false; }
      }));
      const initial = await closeCaptured();
      await outcome;
      const late = await closeCaptured();
      return [...initial, ...late].every((complete) => complete) && performance.now() < cleanupDeadline;
    })();
    // Timing out never authorizes deletion. The joined collector stays owned,
    // including late setup, while its root remains retained in the registry.
    collection = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([joined, new Promise<false>((resolvePromise) => {
          timer = setTimeout(() => resolvePromise(false), Math.max(0, cleanupDeadline - performance.now()));
        })]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    })();
    return collection;
  };
  const result = (async () => {
    const settled = await outcome;
    const complete = await collect();
    if (!settled.ok) throw settled.error;
    if (!complete) throw new Error("authority_runtime_fixture_cleanup_incomplete");
  })();
  void result.catch(() => undefined);
  return { result, collect };
};

const isSupportedLinux = (): boolean =>
  process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "oompa-authority-rt-"));
  await chmod(root, 0o700);
  roots.push(root);
  return root;
};

const observeMarkers = async (
  markers: Readonly<Record<string, string>>,
): Promise<Record<string, string>> => {
  const observed: Record<string, string> = {};
  await Promise.all(Object.entries(markers).map(async ([name, path]) => {
    observed[name] = await Bun.file(path).exists() ? await readFile(path, "utf8") : "missing";
  }));
  return observed;
};

afterEach(async () => {
  const pending = await Promise.all([...pendingFixtureCleanups].map(async (collect) => {
    const complete = await collect();
    if (complete) pendingFixtureCleanups.delete(collect);
    return complete;
  }));
  const removed = await Promise.all(roots.splice(0).map(async (root) => {
    const collect = ownedFixtureCleanups.get(root);
    if (collect !== undefined && !await collect()) {
      // Keep both the root and its collector owned; never delete under work
      // which outlived the test runner's independent outer timeout.
      return false;
    }
    await rm(root, { force: true, recursive: true });
    ownedFixtureCleanups.delete(root);
    return true;
  }));
  if (![...pending, ...removed].every((complete) => complete)) {
    throw new Error("authority_runtime_fixture_cleanup_incomplete_root_retained");
  }
});

test("owned runtime fixture joins cleanup without replacing its work failure", async () => {
  const failure = new Error("original work failure");
  const calls: string[] = [];
  let release: (() => void) | undefined;
  const closed = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const fixture = createOwnedRuntimeFixture(async (scope) => {
    scope.own(async () => { calls.push("closing"); await closed; calls.push("closed"); });
    throw failure;
  });
  await Promise.resolve();
  await Promise.resolve();
  const collected = fixture.collect();
  expect(calls).toEqual(["closing"]);
  release?.();
  await expect(fixture.result).rejects.toBe(failure);
  expect(await collected).toBe(true);
  expect(calls).toEqual(["closing", "closed"]);
  const failedCleanup = createOwnedRuntimeFixture(async (scope) => {
    scope.own(async () => { throw new Error("cleanup failure"); });
    throw failure;
  });
  await expect(failedCleanup.result).rejects.toBe(failure);
  expect(await failedCleanup.collect()).toBe(false);
});

test("owned runtime fixture cancels before pending setup can begin", async () => {
  let began = false;
  const fixture = createOwnedRuntimeFixture(async () => { began = true; });
  const collected = fixture.collect();
  await expect(fixture.result).rejects.toThrow("authority_runtime_fixture_stopping");
  expect(await collected).toBe(true);
  expect(began).toBe(false);
});

test("owned runtime fixture captures and joins setup completed after cancellation", async () => {
  const calls: string[] = [];
  let release: ((resource: string) => void) | undefined;
  const acquired = new Promise<string>((resolvePromise) => { release = resolvePromise; });
  const fixture = createOwnedRuntimeFixture(async (scope) => {
    await scope.acquire(() => acquired, async (resource) => { calls.push(resource); });
    calls.push("continued");
  });
  await Promise.resolve();
  const collected = fixture.collect();
  release?.("closed late resource");
  await expect(fixture.result).rejects.toThrow("authority_runtime_fixture_stopping");
  expect(await collected).toBe(true);
  expect(calls).toEqual(["closed late resource"]);
});

test("owned runtime fixture retains incomplete cleanup and cannot promote forced closure", async () => {
  let release: (() => void) | undefined;
  const closed = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const incomplete = createOwnedRuntimeFixture(async (scope) => { scope.own(() => closed); }, 1);
  await expect(incomplete.result).rejects.toThrow("authority_runtime_fixture_cleanup_incomplete");
  expect(await incomplete.collect()).toBe(false);
  release?.();
  // A later close cannot retroactively change a failed collection receipt.
  expect(await incomplete.collect()).toBe(false);

  let forceClose: (() => void) | undefined;
  const forcedClosed = new Promise<void>((resolvePromise) => { forceClose = resolvePromise; });
  const cancelled = createOwnedRuntimeFixture(async (scope) => {
    scope.own(async () => { forceClose?.(); });
    await forcedClosed;
    scope.assertActive();
  });
  await Promise.resolve();
  const collected = cancelled.collect();
  await expect(cancelled.result).rejects.toThrow("authority_runtime_fixture_stopping");
  expect(await collected).toBe(true);
});

type ChildClose = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;

const socketProbeMaximumEntries = 4_096;
const socketProbeDeadlineMs = 250;
type PrivateChildSockets = Readonly<{ stdout: string; stderr: string }>;
type SocketProbeDirectory = Readonly<{ read(): string | null; close(): void }>;
type SocketProbeIo = Readonly<{
  now(): number;
  openSelfDescriptors(): SocketProbeDirectory;
  readSelfDescriptor(descriptor: number): unknown;
}>;

const systemSocketProbeIo: SocketProbeIo = {
  now: () => performance.now(),
  openSelfDescriptors: () => {
    const directory = opendirSync("/proc/self/fd", { bufferSize: 32 });
    return { read: () => directory.readSync()?.name ?? null, close: () => directory.closeSync() };
  },
  readSelfDescriptor: (descriptor) => readlinkSync(`/proc/self/fd/${String(descriptor)}`),
};

const privatePositiveU64 = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value)
  && BigInt(value) <= 18_446_744_073_709_551_615n;

const privateSocketIdentity = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length > 29) return undefined;
  const match = /^socket:\[([1-9][0-9]{0,19})\]$/u.exec(value);
  return privatePositiveU64(match?.[1]) ? value : undefined;
};

const privateSocketMarker = (value: unknown): PrivateChildSockets | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, "stdout") || !Object.hasOwn(value, "stderr")) return undefined;
  const stdout = privateSocketIdentity((value as Record<string, unknown>).stdout);
  const stderr = privateSocketIdentity((value as Record<string, unknown>).stderr);
  return stdout === undefined || stderr === undefined ? undefined : Object.freeze({ stdout, stderr });
};

type SocketMarkerStat = Pick<Stats, "isFile" | "uid" | "mode" | "nlink" | "size" | "dev" | "ino" | "mtimeMs" | "ctimeMs">;
type SocketMarkerFile = Readonly<{ stat(): SocketMarkerStat; read(buffer: Buffer): number; close(): void }>;
type SocketMarkerIo = Readonly<{ open(path: string): SocketMarkerFile; now(): number; uid(): number | undefined }>;
const systemSocketMarkerIo: SocketMarkerIo = {
  now: () => performance.now(),
  uid: () => process.getuid?.(),
  open: (path) => {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return {
      stat: () => fstatSync(descriptor),
      read: (buffer) => readSync(descriptor, buffer, 0, buffer.byteLength, 0),
      close: () => closeSync(descriptor),
    };
  },
};

const readPrivateSocketMarker = (path: string, io: SocketMarkerIo = systemSocketMarkerIo): PrivateChildSockets | undefined => {
  let file: SocketMarkerFile | undefined;
  let result: PrivateChildSockets | undefined;
  let deadline = 0;
  try {
    deadline = io.now() + socketProbeDeadlineMs;
    file = io.open(path);
    const before = file.stat();
    if (before.isFile() && before.uid === io.uid() && (before.mode & 0o7777) === 0o600 && before.nlink === 1
      && Number.isInteger(before.size) && before.size >= 2 && before.size <= 128 && io.now() < deadline) {
      const buffer = Buffer.alloc(129);
      const bytes = file.read(buffer);
      const after = file.stat();
      if (bytes === before.size && after.dev === before.dev && after.ino === before.ino
        && after.size === before.size && after.mode === before.mode && after.uid === before.uid
        && after.nlink === before.nlink && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs
        && io.now() < deadline) {
        const text = buffer.toString("utf8", 0, bytes);
        const parsed = privateSocketMarker(JSON.parse(text) as unknown);
        if (parsed !== undefined && JSON.stringify(parsed) === text) result = parsed;
      }
    }
  } catch {
    result = undefined;
  } finally {
    try { file?.close(); } catch { result = undefined; }
    try { if (!(io.now() < deadline)) result = undefined; } catch { result = undefined; }
  }
  return result;
};

const socketMarkerFixture = (text = '{"stdout":"socket:[111]","stderr":"socket:[222]"}') => {
  const calls: string[] = [];
  const metadata: SocketMarkerStat = {
    isFile: () => true, uid: 501, mode: 0o100600, nlink: 1,
    size: Buffer.byteLength(text), dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4,
  };
  const file: SocketMarkerFile = {
    stat: () => { calls.push("stat"); return metadata; },
    read: (buffer) => { calls.push("read"); return buffer.write(text); },
    close: () => { calls.push("close"); },
  };
  const io: SocketMarkerIo = {
    now: () => 0, uid: () => 501,
    open: (path) => { calls.push(path); return file; },
  };
  return { calls, metadata, file, io };
};

const censusSelfSocketWriters = (
  sockets: PrivateChildSockets | undefined,
  io: SocketProbeIo = systemSocketProbeIo,
) => {
  const result = {
    childSocketsCaptured: sockets !== undefined,
    selfFdCensusComplete: false,
    selfFdEntriesScanned: 0,
    selfStdoutWriterMatches: 0,
    selfStderrWriterMatches: 0,
    selfFdCensusStopReason: "marker_unavailable" as "marker_unavailable" | "eof" | "entry_limit" | "deadline"
      | "open_failed" | "read_failed" | "clock_failed",
    selfFdCensusElapsedMs: null as number | null,
    selfFdDeadlineReached: false,
    selfFdInvalidNames: 0,
    selfFdInvalidTargets: 0,
    selfFdReadlinkFailures: 0,
    selfFdCloseFailed: false,
  };
  if (sockets === undefined) return Object.freeze(result);
  let directory: SocketProbeDirectory | undefined;
  let started: number | undefined;
  let deadline = 0;
  let phase: "open_failed" | "read_failed" | "clock_failed" = "clock_failed";
  const now = (): number => {
    const previousPhase = phase;
    phase = "clock_failed";
    const value = io.now();
    if (!Number.isFinite(value) || value < 0 || (started !== undefined && value < started)) {
      throw new Error("authority_socket_probe_clock_invalid");
    }
    phase = previousPhase;
    return value;
  };
  try {
    started = now();
    deadline = started + socketProbeDeadlineMs;
    phase = "open_failed";
    directory = io.openSelfDescriptors();
    for (;;) {
      if (result.selfFdEntriesScanned >= socketProbeMaximumEntries) {
        result.selfFdCensusStopReason = "entry_limit";
        break;
      }
      if (now() >= deadline) {
        result.selfFdCensusStopReason = "deadline";
        break;
      }
      phase = "read_failed";
      const name = directory.read();
      if (name === null) {
        result.selfFdCensusStopReason = "eof";
        break;
      }
      result.selfFdEntriesScanned += 1;
      if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(name) || Number(name) > 2_147_483_647) {
        result.selfFdInvalidNames += 1;
        continue;
      }
      if (now() >= deadline) {
        result.selfFdCensusStopReason = "deadline";
        break;
      }
      try {
        const target = io.readSelfDescriptor(Number(name));
        if (typeof target !== "string" || target.length > 4_096) result.selfFdInvalidTargets += 1;
        const identity = privateSocketIdentity(target);
        if (identity === sockets.stdout) result.selfStdoutWriterMatches += 1;
        if (identity === sockets.stderr) result.selfStderrWriterMatches += 1;
      } catch {
        // A concurrently closed descriptor makes this census incomplete.
        result.selfFdReadlinkFailures += 1;
      }
    }
  } catch {
    result.selfFdCensusStopReason = phase;
  } finally {
    try {
      directory?.close();
    } catch {
      result.selfFdCloseFailed = true;
    }
    if (started !== undefined) {
      try {
        const finished = now();
        result.selfFdCensusElapsedMs = Math.min(2_147_483_647, Math.floor(finished - started));
        result.selfFdDeadlineReached = finished >= deadline;
      } catch { result.selfFdCensusStopReason = "clock_failed"; }
    }
  }
  result.selfFdCensusComplete = result.selfFdCensusStopReason === "eof" && !result.selfFdDeadlineReached
    && result.selfFdInvalidNames === 0 && result.selfFdInvalidTargets === 0
    && result.selfFdReadlinkFailures === 0 && !result.selfFdCloseFailed;
  // These are self-process observations, never proof of global writer absence.
  // Local procfs calls are synchronous and joined; the time cap is checked
  // between calls, rather than abandoning an in-flight directory operation.
  return Object.freeze(result);
};

const socketProbeFixture = () => {
  const calls: string[] = [];
  const names = ["10", "11", "12", "13", "14"];
  const targets = ["socket:[111]", "socket:[222]", "socket:[111]", "private path", "pipe:[111]"];
  let next = 0;
  const io: SocketProbeIo = {
    now: () => 0,
    openSelfDescriptors: () => {
      calls.push("open");
      return {
        read: () => names[next++] ?? null,
        close: () => { calls.push("close"); },
      };
    },
    readSelfDescriptor: (descriptor) => targets[descriptor - 10],
  };
  return { calls, io };
};

test("socket diagnostic parses only two bounded private socket identities", () => {
  for (const invalid of [null, "pipe:[111]", "socket:[0]", "socket:[01]", "socket:[18446744073709551616]", "socket:[111]suffix"]) {
    expect(privateSocketIdentity(invalid)).toBeUndefined();
  }
  expect(privateSocketMarker({ stdout: "socket:[111]", stderr: "socket:[222]" }))
    .toEqual({ stdout: "socket:[111]", stderr: "socket:[222]" });
  for (const invalid of [
    null, [], { stdout: "socket:[111]" },
    { stdout: "socket:[111]", stderr: "socket:[222]", private: "detail" },
    { stdout: "private path", stderr: "socket:[222]" },
    Object.create({ stdout: "socket:[111]", stderr: "socket:[222]" }) as unknown,
  ]) {
    expect(privateSocketMarker(invalid)).toBeUndefined();
  }
});

test("socket diagnostic reads one private canonical marker and closes its own handle", () => {
  const value = socketMarkerFixture();
  const result = readPrivateSocketMarker("exact-owned-marker", value.io);
  expect(result).toEqual({ stdout: "socket:[111]", stderr: "socket:[222]" });
  expect(Object.isFrozen(result)).toBe(true);
  expect(value.calls).toEqual(["exact-owned-marker", "stat", "read", "stat", "close"]);
  for (const text of [
    "not JSON", "null", "[]", '{"stdout":"socket:[111]"}',
    '{"stdout":"socket:[111]","stderr":"socket:[222]","extra":true}',
    '{"stdout":"socket:[111]","stderr":"socket:[222]","stdout":"socket:[111]"}',
    '{"stderr":"socket:[222]","stdout":"socket:[111]"}',
    '{"stdout":"private path","stderr":"socket:[222]"}',
    '{"stdout":"socket:[111]","stderr":"socket:[222]"}\n',
  ]) {
    const invalid = socketMarkerFixture(text);
    expect(readPrivateSocketMarker("exact-owned-marker", invalid.io)).toBeUndefined();
    expect(invalid.calls.at(-1)).toBe("close");
  }
});

test.each(["type", "uid", "mode", "links", "small", "large", "fractional"] as const)(
  "socket diagnostic rejects marker %s metadata before reading",
  (failure) => {
    const value = socketMarkerFixture();
    const metadata = { ...value.metadata };
    if (failure === "type") metadata.isFile = () => false;
    if (failure === "uid") metadata.uid += 1;
    if (failure === "mode") metadata.mode = 0o100644;
    if (failure === "links") metadata.nlink = 2;
    if (failure === "small") metadata.size = 1;
    if (failure === "large") metadata.size = 129;
    if (failure === "fractional") metadata.size = 2.5;
    const io = { ...value.io, open: () => ({ ...value.file, stat: () => metadata }) };
    expect(readPrivateSocketMarker("exact-owned-marker", io)).toBeUndefined();
    expect(value.calls).toEqual(["close"]);
  },
);

test.each(["dev", "ino", "size", "mode", "uid", "nlink", "mtimeMs", "ctimeMs"] as const)(
  "socket diagnostic rejects marker %s changes across the bounded read",
  (field) => {
    const value = socketMarkerFixture();
    let stats = 0;
    const io = { ...value.io, open: () => ({ ...value.file,
      stat: () => ++stats === 1 ? value.metadata : { ...value.metadata, [field]: value.metadata[field] + 1 },
    }) };
    expect(readPrivateSocketMarker("exact-owned-marker", io)).toBeUndefined();
    expect(value.calls).toEqual(["read", "close"]);
  },
);

test.each(["open", "stat", "read", "close", "clock", "uid", "short", "long", "deadline", "close_deadline"] as const)(
  "socket diagnostic makes marker %s failure unavailable and joins any owned handle",
  (failure) => {
    const value = socketMarkerFixture();
    let closes = 0;
    let clock = 0;
    const io: SocketMarkerIo = {
      now: () => {
        if (failure === "clock") throw new Error("private clock detail");
        return failure === "deadline" ? (clock += 100) : clock;
      },
      uid: () => failure === "uid" ? undefined : 501,
      open: () => {
        if (failure === "open") throw new Error("private open detail");
        return {
          stat: () => {
            if (failure === "stat") throw new Error("private stat detail");
            return value.metadata;
          },
          read: (buffer) => {
            expect(buffer.byteLength).toBe(129);
            if (failure === "read") throw new Error("private read detail");
            const bytes = value.file.read(buffer);
            if (failure === "short") return bytes - 1;
            return failure === "long" ? bytes + 1 : bytes;
          },
          close: () => {
            closes += 1;
            if (failure === "close") throw new Error("private close detail");
            if (failure === "close_deadline") clock = socketProbeDeadlineMs;
          },
        };
      },
    };
    expect(readPrivateSocketMarker("exact-owned-marker", io)).toBeUndefined();
    expect(closes).toBe(failure === "open" || failure === "clock" ? 0 : 1);
  },
);

test("socket diagnostic reports only self counts and joins its exact directory", () => {
  const value = socketProbeFixture();
  const sockets = { stdout: "socket:[111]", stderr: "socket:[222]" };
  const result = censusSelfSocketWriters(sockets, value.io);
  expect(result).toEqual({ childSocketsCaptured: true, selfFdCensusComplete: true,
    selfFdEntriesScanned: 5, selfStdoutWriterMatches: 2, selfStderrWriterMatches: 1,
    selfFdCensusStopReason: "eof", selfFdCensusElapsedMs: 0, selfFdDeadlineReached: false,
    selfFdInvalidNames: 0, selfFdInvalidTargets: 0, selfFdReadlinkFailures: 0, selfFdCloseFailed: false });
  expect(value.calls.slice(-2)).toEqual(["open", "close"]);
  expect(Object.isFrozen(result)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/111|222|private|321|123456/u);
  const unavailable = socketProbeFixture();
  expect(censusSelfSocketWriters(undefined, unavailable.io)).toEqual({ childSocketsCaptured: false,
    selfFdCensusComplete: false, selfFdEntriesScanned: 0, selfStdoutWriterMatches: 0, selfStderrWriterMatches: 0,
    selfFdCensusStopReason: "marker_unavailable", selfFdCensusElapsedMs: null, selfFdDeadlineReached: false,
    selfFdInvalidNames: 0, selfFdInvalidTargets: 0, selfFdReadlinkFailures: 0, selfFdCloseFailed: false });
  expect(unavailable.calls).toEqual([]);
});

test.each(["open", "read", "link", "close", "name", "target", "clock", "clock_after_open",
  "clock_invalid", "deadline", "close_deadline", "entry_cap"] as const)(
  "socket diagnostic marks %s failure incomplete without escaping or abandoning an owned directory",
  (failure) => {
    const value = socketProbeFixture();
    let closed = 0;
    let reads = 0;
    let clock = 0;
    const io: SocketProbeIo = {
      ...value.io,
      now: () => {
        if (failure === "clock" || (failure === "clock_after_open" && clock++ > 0)) {
          throw new Error("private clock detail");
        }
        if (failure === "clock_invalid") return Number.NaN;
        return failure === "deadline" ? (clock += 100) : failure === "close_deadline" ? clock : 0;
      },
      openSelfDescriptors: () => {
        if (failure === "open") throw new Error("private open detail");
        return {
          read: () => {
            reads += 1;
            if (failure === "read") throw new Error("private read detail");
            if (failure === "entry_cap") return "10";
            return reads === 1 ? failure === "name" ? "../private" : "10" : null;
          },
          close: () => {
            closed += 1;
            if (failure === "close") throw new Error("private close detail");
            if (failure === "close_deadline") clock = socketProbeDeadlineMs;
          },
        };
      },
      readSelfDescriptor: () => {
        if (failure === "link") throw new Error("private link detail");
        return failure === "target" ? { private: "detail" } : "socket:[111]";
      },
    };
    const result = censusSelfSocketWriters({ stdout: "socket:[111]", stderr: "socket:[222]" }, io);
    expect(result.selfFdCensusComplete).toBe(false);
    expect(closed).toBe(failure === "open" || failure === "clock" || failure === "clock_invalid" ? 0 : 1);
    expect(reads).toBeLessThanOrEqual(socketProbeMaximumEntries);
    expect(result.selfFdEntriesScanned).toBeLessThanOrEqual(socketProbeMaximumEntries);
    expect(JSON.stringify(result)).not.toContain("private");
    const expectedReason = failure.startsWith("clock") ? "clock_failed"
      : failure === "open" ? "open_failed" : failure === "read" ? "read_failed"
      : failure === "entry_cap" ? "entry_limit" : failure === "deadline" ? "deadline" : "eof";
    expect(result.selfFdCensusStopReason).toBe(expectedReason);
    expect(result.selfFdInvalidNames).toBe(failure === "name" ? 1 : 0);
    expect(result.selfFdInvalidTargets).toBe(failure === "target" ? 1 : 0);
    expect(result.selfFdReadlinkFailures).toBe(failure === "link" ? 1 : 0);
    expect(result.selfFdCloseFailed).toBe(failure === "close");
    expect(result.selfFdDeadlineReached).toBe(failure === "deadline" || failure === "close_deadline");
    if (failure.startsWith("clock")) expect(result.selfFdCensusElapsedMs).toBeNull();
    else expect(result.selfFdCensusElapsedMs).toBe(failure === "deadline" ? 400 : failure === "close_deadline" ? 250 : 0);
    if (failure === "entry_cap") expect(reads).toBe(socketProbeMaximumEntries);
    if (failure === "deadline") expect(reads).toBe(1);
  },
);

type LifecycleEmitter = Pick<EventEmitter, "on" | "off">;
type LifecycleChild = LifecycleEmitter & Readonly<{
  stdout: LifecycleEmitter;
  stderr: LifecycleEmitter;
}>;

const childOutputMaximumBytes = 65_536;

const consumeOwnedChildOutput = (child: Pick<LifecycleChild, "stdout" | "stderr">) => {
  const state = { stdoutBytes: 0, stderrBytes: 0, overflow: false, invalidChunk: false };
  let disposed = false;
  const count = (channel: "stdoutBytes" | "stderrBytes", chunk: unknown): void => {
    if (disposed) return;
    if (!Buffer.isBuffer(chunk)) { state.invalidChunk = true; return; }
    const available = childOutputMaximumBytes - state.stdoutBytes - state.stderrBytes;
    state[channel] += Math.min(available, chunk.byteLength);
    if (chunk.byteLength > available) state.overflow = true;
  };
  const onStdout = (chunk: unknown): void => count("stdoutBytes", chunk);
  const onStderr = (chunk: unknown): void => count("stderrBytes", chunk);
  // Match the production runner's explicit data consumption. Keep only capped
  // counts: this fixture's target is silent and its output is never diagnostic.
  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  return {
    snapshot: () => Object.freeze({ ...state }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
    },
  };
};

const boundedStreamCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, childOutputMaximumBytes)
    : null;

const snapshotReadableState = (stream: Readable) => Object.freeze({
  readableFlowing: stream.readableFlowing,
  readableEnded: stream.readableEnded,
  readableLength: boundedStreamCount(stream.readableLength),
  readableLengthCapped: stream.readableLength > childOutputMaximumBytes,
  destroyed: stream.destroyed,
  closed: stream.closed,
  dataListeners: boundedStreamCount(stream.listenerCount("data")),
});

const snapshotChildStreamState = (
  child: Pick<ChildProcessWithoutNullStreams, "stdin" | "stdout" | "stderr"> | undefined,
) => child === undefined ? null : Object.freeze({
  stdin: Object.freeze({ writableEnded: child.stdin.writableEnded,
    writableFinished: child.stdin.writableFinished, destroyed: child.stdin.destroyed, closed: child.stdin.closed }),
  stdout: snapshotReadableState(child.stdout),
  stderr: snapshotReadableState(child.stderr),
});

test("owned child output consumer caps combined bytes without retaining output", () => {
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const output = consumeOwnedChildOutput(child);
  try {
    const initial = output.snapshot();
    child.stdout.emit("data", Buffer.from("private output"));
    child.stderr.emit("data", Buffer.alloc(childOutputMaximumBytes - 14));
    expect(output.snapshot()).toEqual({ stdoutBytes: 14, stderrBytes: childOutputMaximumBytes - 14,
      overflow: false, invalidChunk: false });
    child.stdout.emit("data", Buffer.alloc(0));
    expect(output.snapshot().overflow).toBe(false);
    child.stderr.emit("data", Buffer.alloc(1));
    child.stdout.emit("data", Buffer.alloc(childOutputMaximumBytes + 1));
    expect(output.snapshot()).toEqual({ stdoutBytes: 14, stderrBytes: childOutputMaximumBytes - 14,
      overflow: true, invalidChunk: false });
    expect(JSON.stringify(output.snapshot())).not.toContain("private output");
    expect(initial).toEqual({ stdoutBytes: 0, stderrBytes: 0, overflow: false, invalidChunk: false });
    expect(Object.isFrozen(output.snapshot())).toBe(true);
  } finally { output.dispose(); }
});

test("owned child output consumer removes only its listeners and rejects non-buffer chunks", () => {
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  const foreign = () => undefined;
  const events = ["data", "end", "close", "error"];
  for (const stream of [child.stdout, child.stderr]) {
    for (const event of events) stream.on(event, foreign);
  }
  const output = consumeOwnedChildOutput(child);
  try {
    for (const stream of [child.stdout, child.stderr]) {
      expect(stream.listenerCount("data")).toBe(2);
      expect(stream.eventNames()).toEqual(events);
      for (const event of events.slice(1)) expect(stream.listeners(event)).toEqual([foreign]);
    }
    for (const invalid of ["private output", null, undefined, new Uint8Array(2), { byteLength: 2 }]) {
      child.stdout.emit("data", invalid);
    }
    child.stderr.emit("data", Buffer.alloc(2));
    const before = output.snapshot();
    expect(before).toEqual({ stdoutBytes: 0, stderrBytes: 2, overflow: false, invalidChunk: true });
    output.dispose();
    output.dispose();
    for (const stream of [child.stdout, child.stderr]) {
      for (const event of events) expect(stream.listeners(event)).toEqual([foreign]);
      stream.emit("data", Buffer.alloc(3));
    }
    expect(output.snapshot()).toEqual(before);
  } finally {
    output.dispose();
    for (const stream of [child.stdout, child.stderr]) {
      for (const event of events) stream.off(event, foreign);
    }
  }
});

test("owned child output consumer ignores a callback already queued at disposal", () => {
  const child = { stdout: new EventEmitter(), stderr: new EventEmitter() };
  let dispose = () => undefined;
  const beforeOwnedListener = (): void => { dispose(); };
  child.stdout.on("data", beforeOwnedListener);
  const output = consumeOwnedChildOutput(child);
  dispose = () => { output.dispose(); };
  try {
    child.stdout.emit("data", Buffer.alloc(1));
    expect(output.snapshot()).toEqual({ stdoutBytes: 0, stderrBytes: 0, overflow: false, invalidChunk: false });
    expect(child.stdout.listeners("data")).toEqual([beforeOwnedListener]);
    expect(child.stderr.listenerCount("data")).toBe(0);
  } finally {
    output.dispose();
    child.stdout.off("data", beforeOwnedListener);
  }
});

test("child public stream snapshots are fixed, bounded, and detached from later state", () => {
  const child = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  const streams = [child.stdin, child.stdout, child.stderr];
  try {
    expect(snapshotChildStreamState(undefined)).toBeNull();
    for (const invalid of [null, "1", -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(boundedStreamCount(invalid)).toBeNull();
    }
    expect(boundedStreamCount(Number.MAX_SAFE_INTEGER)).toBe(childOutputMaximumBytes);
    child.stdout.push(Buffer.alloc(childOutputMaximumBytes + 1));
    const before = snapshotChildStreamState(child);
    expect(before).toEqual({
      stdin: { writableEnded: false, writableFinished: false, destroyed: false, closed: false },
      stdout: { readableFlowing: null, readableEnded: false, readableLength: childOutputMaximumBytes,
        readableLengthCapped: true, destroyed: false, closed: false, dataListeners: 0 },
      stderr: { readableFlowing: null, readableEnded: false, readableLength: 0,
        readableLengthCapped: false, destroyed: false, closed: false, dataListeners: 0 },
    });
    const output = consumeOwnedChildOutput(child);
    try {
      expect(snapshotChildStreamState(child)?.stdout).toMatchObject({ readableFlowing: true, dataListeners: 1 });
      expect(before?.stdout.dataListeners).toBe(0);
      expect(Object.isFrozen(before)).toBe(true);
      for (const snapshot of [before?.stdin, before?.stdout, before?.stderr]) expect(Object.isFrozen(snapshot)).toBe(true);
    } finally { output.dispose(); }
    expect(snapshotChildStreamState(child)?.stdout.dataListeners).toBe(0);
  } finally { for (const stream of streams) stream.destroy(); }
});

const createChildLifecycleRecorder = () => {
  const state = {
    childAttached: false,
    exitObserved: false,
    exitCode: null as number | null,
    exitSignalPresent: false,
    closeObserved: false,
    closeCode: null as number | null,
    closeSignalPresent: false,
    stdoutEnd: false,
    stdoutClose: false,
    stderrEnd: false,
    stderrClose: false,
    controlAttached: false,
    controlEnd: false,
    controlClose: false,
    controlError: false,
  };
  let child: LifecycleChild | undefined;
  let control: LifecycleEmitter | undefined;
  let disposed = false;
  const boundedCode = (code: unknown): number | null =>
    typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255
      ? code
      : null;
  const onExit = (code: unknown, signal: unknown): void => {
    state.exitObserved = true;
    state.exitCode = boundedCode(code);
    state.exitSignalPresent = signal !== null && signal !== undefined;
  };
  const onClose = (code: unknown, signal: unknown): void => {
    state.closeObserved = true;
    state.closeCode = boundedCode(code);
    state.closeSignalPresent = signal !== null && signal !== undefined;
  };
  const onStdoutEnd = (): void => { state.stdoutEnd = true; };
  const onStdoutClose = (): void => { state.stdoutClose = true; };
  const onStderrEnd = (): void => { state.stderrEnd = true; };
  const onStderrClose = (): void => { state.stderrClose = true; };
  const onControlEnd = (): void => { state.controlEnd = true; };
  const onControlClose = (): void => { state.controlClose = true; };
  return {
    attachChild(value: LifecycleChild): void {
      if (disposed) return;
      if (child !== undefined) throw new Error("authority_lifecycle_child_already_attached");
      child = value;
      state.childAttached = true;
      value.on("exit", onExit);
      value.on("close", onClose);
      value.stdout.on("end", onStdoutEnd);
      value.stdout.on("close", onStdoutClose);
      value.stderr.on("end", onStderrEnd);
      value.stderr.on("close", onStderrClose);
    },
    attachControl(value: LifecycleEmitter): void {
      if (disposed) return;
      if (control !== undefined) throw new Error("authority_lifecycle_control_already_attached");
      control = value;
      state.controlAttached = true;
      value.on("end", onControlEnd);
      value.on("close", onControlClose);
    },
    recordControlError(): void {
      // Called by the existing socket error owner: the recorder must not add
      // error handlers that would change unhandled-error behavior.
      if (!disposed) state.controlError = true;
    },
    snapshot: () => Object.freeze({ ...state }),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      child?.off("exit", onExit);
      child?.off("close", onClose);
      child?.stdout.off("end", onStdoutEnd);
      child?.stdout.off("close", onStdoutClose);
      child?.stderr.off("end", onStderrEnd);
      child?.stderr.off("close", onStderrClose);
      control?.off("end", onControlEnd);
      control?.off("close", onControlClose);
    },
  };
};

test("child lifecycle recorder distinguishes exit, pipe closure, and control FIN", () => {
  const recorder = createChildLifecycleRecorder();
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const control = new EventEmitter();
  const initial = recorder.snapshot();
  expect(initial).toEqual({
    childAttached: false, exitObserved: false, exitCode: null, exitSignalPresent: false,
    closeObserved: false, closeCode: null, closeSignalPresent: false,
    stdoutEnd: false, stdoutClose: false, stderrEnd: false, stderrClose: false,
    controlAttached: false, controlEnd: false, controlClose: false, controlError: false,
  });
  try {
    recorder.attachChild(child);
    recorder.attachControl(control);
    child.emit("exit", 0, null);
    const exited = recorder.snapshot();
    expect(exited).toEqual({ ...initial, childAttached: true, controlAttached: true,
      exitObserved: true, exitCode: 0 });
    control.emit("end");
    expect(recorder.snapshot()).toEqual({ ...exited, controlEnd: true });
    control.emit("close");
    recorder.recordControlError();
    child.stdout.emit("end");
    child.stderr.emit("end");
    expect(recorder.snapshot()).toEqual({ ...exited,
      controlEnd: true, controlClose: true, controlError: true, stdoutEnd: true, stderrEnd: true });
    child.stdout.emit("close");
    child.stderr.emit("close");
    child.emit("close", 0, null);
    expect(recorder.snapshot()).toEqual({ ...exited,
      controlEnd: true, controlClose: true, controlError: true,
      stdoutEnd: true, stdoutClose: true, stderrEnd: true, stderrClose: true,
      closeObserved: true, closeCode: 0 });
    expect(exited.closeObserved).toBe(false);
    expect(initial.childAttached).toBe(false);
    expect(Object.isFrozen(exited)).toBe(true);
  } finally {
    recorder.dispose();
  }
});

test("child lifecycle recorder bounds values and removes only its own listeners", () => {
  const recorder = createChildLifecycleRecorder();
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const control = new EventEmitter();
  const sources = [child, child.stdout, child.stderr, control];
  const foreign = () => undefined;
  for (const source of sources) source.on("close", foreign);
  try {
    recorder.attachChild(child);
    recorder.attachControl(control);
    expect(() => recorder.attachChild(child)).toThrow("authority_lifecycle_child_already_attached");
    expect(() => recorder.attachControl(control)).toThrow("authority_lifecycle_control_already_attached");
    for (const source of sources) expect(source.listenerCount("error")).toBe(0);
    child.stdout.emit("end");
    child.stdout.emit("close");
    expect(recorder.snapshot()).toMatchObject({ stdoutEnd: true, stdoutClose: true,
      exitObserved: false, closeObserved: false, stderrEnd: false, stderrClose: false });
    child.emit("exit", Number.MAX_SAFE_INTEGER, "not-retained");
    child.emit("close", null, "not-retained");
    expect(recorder.snapshot()).toMatchObject({ exitObserved: true, exitCode: null,
      exitSignalPresent: true, closeObserved: true, closeCode: null, closeSignalPresent: true });
    expect(JSON.stringify(recorder.snapshot())).not.toContain("not-retained");
    const beforeDisposal = recorder.snapshot();
    recorder.dispose();
    recorder.dispose();
    for (const source of sources) {
      expect(source.listeners("close")).toEqual([foreign]);
      expect(source.listenerCount("end")).toBe(0);
      expect(source.listenerCount("exit")).toBe(0);
    }
    recorder.attachChild(child);
    recorder.attachControl(control);
    recorder.recordControlError();
    child.emit("exit", 7, null);
    child.stderr.emit("end");
    control.emit("end");
    control.emit("close");
    expect(recorder.snapshot()).toEqual(beforeDisposal);
  } finally {
    recorder.dispose();
    for (const source of sources) source.off("close", foreign);
  }
});

const observeChildClose = async (
  child: ChildProcessWithoutNullStreams,
): Promise<ChildClose> => await new Promise((resolvePromise, rejectPromise) => {
  const onClose = (code: number | null, signal: NodeJS.Signals | null): void => settle(
    () => resolvePromise({ code, signal }),
  );
  const onError = (error: Error): void => settle(() => rejectPromise(error));
  const settle = (callback: () => void): void => {
    child.off("close", onClose);
    child.off("error", onError);
    callback();
  };
  child.once("close", onClose);
  child.once("error", onError);
});

const requireChildClose = async (
  observed: Promise<ChildClose>,
  timeoutMs = 8_000,
): Promise<ChildClose> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      observed,
      new Promise<never>((_resolve, rejectPromise) => {
        timer = setTimeout(
          () => rejectPromise(new Error("authority_child_close_timeout")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const waitForChildClose = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 8_000,
): Promise<ChildClose> => await requireChildClose(observeChildClose(child), timeoutMs);

const waitForChildSpawn = async (
  child: ChildProcessWithoutNullStreams,
  timeoutMs = 2_000,
): Promise<void> => await new Promise((resolvePromise, rejectPromise) => {
  let settled = false;
  const timer = setTimeout(
    () => settle(() => rejectPromise(new Error("authority_child_spawn_timeout"))),
    timeoutMs,
  );
  const settle = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.off("close", onClose);
    child.off("error", onError);
    child.off("spawn", onSpawn);
    callback();
  };
  const onSpawn = (): void => settle(resolvePromise);
  const onError = (): void => settle(() => rejectPromise(new Error("authority_child_spawn_error")));
  const onClose = (): void => settle(() => rejectPromise(new Error("authority_child_closed_before_spawn")));
  child.once("spawn", onSpawn);
  child.once("error", onError);
  child.once("close", onClose);
});

const readChildStream = async (
  stream: ChildProcessWithoutNullStreams["stderr"],
): Promise<string> => await new Promise((resolvePromise, rejectPromise) => {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  stream.once("end", () => resolvePromise(output));
  stream.once("error", rejectPromise);
});

class ControlServer {
  readonly #lines: string[] = [];
  readonly #server: Server;
  readonly path: string;
  readonly #lifecycle: ReturnType<typeof createChildLifecycleRecorder>;
  #socket: Socket | undefined;
  #closing = false;
  #waiter: Readonly<{ reject: (error: Error) => void; resolve: (line: string) => void }> | undefined;

  private constructor(
    server: Server,
    path: string,
    lifecycle: ReturnType<typeof createChildLifecycleRecorder>,
  ) {
    this.#server = server;
    this.path = path;
    this.#lifecycle = lifecycle;
  }

  static async start(
    root: string,
    lifecycle: ReturnType<typeof createChildLifecycleRecorder>,
    scope: RuntimeFixtureScope,
  ): Promise<ControlServer> {
    const path = join(root, `.authority-control-${"a".repeat(32)}.sock`);
    const server = createServer();
    const control = new ControlServer(server, path, lifecycle);
    scope.own(() => control.close());
    server.on("connection", (socket) => control.#accept(socket));
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once("error", rejectPromise);
      server.listen(path, () => {
        server.removeAllListeners("error");
        resolvePromise();
      });
    });
    scope.assertActive();
    await chmod(path, 0o600);
    scope.assertActive();
    return control;
  }

  #accept(socket: Socket): void {
    if (this.#closing || this.#socket !== undefined) {
      socket.destroy();
      return;
    }
    this.#socket = socket;
    this.#lifecycle.attachControl(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const waiter = this.#waiter;
        if (waiter === undefined) this.#lines.push(line);
        else {
          this.#waiter = undefined;
          waiter.resolve(line);
        }
      }
    });
    socket.once("error", () => {
      this.#lifecycle.recordControlError();
      this.#waiter?.reject(new Error("authority_control_socket_error"));
    });
    socket.once("close", () => this.#waiter?.reject(new Error("authority_control_socket_closed")));
  }

  async nextLine(timeoutMs = 5_000): Promise<string> {
    const line = this.#lines.shift();
    if (line !== undefined) return line;
    if (this.#waiter !== undefined) throw new Error("authority_control_concurrent_wait");
    return await new Promise<string>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.#waiter = undefined;
        rejectPromise(new Error("authority_control_line_timeout"));
      }, timeoutMs);
      this.#waiter = {
        reject: (error) => {
          clearTimeout(timer);
          rejectPromise(error);
        },
        resolve: (next) => {
          clearTimeout(timer);
          resolvePromise(next);
        },
      };
    });
  }

  write(line: string): void {
    if (this.#socket === undefined) throw new Error("authority_control_socket_missing");
    this.#socket.write(line, "utf8");
  }

  async close(): Promise<void> {
    this.#closing = true;
    this.#waiter?.reject(new Error("authority_control_socket_closed"));
    const socketClosed = this.#socket === undefined || this.#socket.closed
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => { this.#socket?.once("close", () => resolvePromise()); });
    this.#socket?.destroy();
    await new Promise<void>((resolvePromise, rejectPromise) => {
      this.#server.close((error?: Error) => error === undefined ? resolvePromise() : rejectPromise(error));
    });
    await socketClosed;
  }
}

const deadlineDriverSource = (artifactModuleUrl: string): string => `
const { spawn } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");

void (async () => {
  const root = process.env.OOMPA_DRIVER_ROOT;
  const mode = process.env.OOMPA_DRIVER_STOP_MODE;
  const startedMarker = process.env.OOMPA_DRIVER_STARTED_MARKER;
  const delayedMarker = process.env.OOMPA_DRIVER_DELAYED_MARKER;
  const goMarker = process.env.OOMPA_DRIVER_GO_MARKER;
  const resultMarker = process.env.OOMPA_DRIVER_RESULT_MARKER;
  if (!root || !mode || !startedMarker || !delayedMarker || !goMarker || !resultMarker) throw new Error("driver_environment_missing");
  const recovery = join(root, "process-recovery");
  mkdirSync(recovery, { mode: 0o700 });
  const socketPath = join(recovery, ".authority-control-" + "b".repeat(32) + ".sock");
  const server = createServer();
  let accepted;
  const connected = new Promise((resolve) => { server.once("connection", (socket) => { accepted = socket; resolve(); }); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  chmodSync(socketPath, 0o600);

  const opened = await import(${JSON.stringify(artifactModuleUrl)}).then((module) => module.openAuthoritySupervisorArtifact());
  const nonce = "2".repeat(32);
  const target = [
    "const { writeFileSync } = require('node:fs');",
    "writeFileSync(" + JSON.stringify(startedMarker) + ", 'started');",
    "setTimeout(() => writeFileSync(" + JSON.stringify(delayedMarker) + ", 'escaped'), 2500);",
  ].join(" ");
  const helper = spawn(opened.executionPath, ["--control-socket", socketPath, "--nonce", nonce, "--", process.execPath, "-e", target], {
    cwd: root,
    env: process.env,
    shell: false,
    stdio: ["pipe", "ignore", "ignore"],
  });
  const helperClosed = new Promise((resolve, reject) => {
    helper.once("error", reject);
    helper.once("close", (code, signal) => resolve({ code, signal }));
  });
  await connected;
  let buffered = "";
  const lines = [];
  let wake;
  accepted.setEncoding("utf8");
  accepted.on("data", (chunk) => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\\n");
      if (newline < 0) break;
      lines.push(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      if (wake) { const resolve = wake; wake = undefined; resolve(); }
    }
  });
  const nextLine = async () => {
    while (lines.length === 0) await new Promise((resolve) => { wake = resolve; });
    return lines.shift();
  };
  const ready = await nextLine();
  const readyMatch = ready.match(/ outer_pid=([1-9][0-9]*).* monotonic_ms=([1-9][0-9]*)$/u);
  if (!readyMatch) throw new Error("driver_ready_invalid:" + ready);
  const outerPid = Number(readyMatch[1]);
  const deadline = BigInt(readyMatch[2]) + 1500n;
  await new Promise((resolve, reject) => accepted.write(
    "HRA_AUTHORITY_SUPERVISOR/1 GO nonce=" + nonce + " deadline_monotonic_ms=" + deadline + "\\n",
    (error) => {
      if (error) { reject(error); return; }
      writeFileSync(goMarker, String(outerPid));
      if (mode === "parent") process.kill(process.pid, "SIGSTOP");
      else if (mode !== "outer") throw new Error("driver_stop_mode_invalid");
      resolve();
    },
  ));
  helper.stdin.end();
  if (mode === "outer") {
    for (let attempt = 0; attempt < 250 && !existsSync(startedMarker); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!existsSync(startedMarker)) throw new Error("driver_target_start_timeout");
    process.kill(outerPid, "SIGSTOP");
    setTimeout(() => process.kill(outerPid, "SIGCONT"), 3000);
  }
  const clean = await nextLine();
  const closed = await helperClosed;
  writeFileSync(resultMarker, JSON.stringify({ clean, closed }));
  accepted.destroy();
  await new Promise((resolve) => server.close(resolve));
  await opened.close();
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

const bindAliasDriverSource = (artifactModuleUrl: string): string => `
const { spawn, spawnSync } = require("node:child_process");
const { chmodSync, mkdirSync, readlinkSync, writeFileSync } = require("node:fs");
const { createServer } = require("node:net");
const { join } = require("node:path");

void (async () => {
  const root = process.env.OOMPA_BIND_ROOT;
  const marker = process.env.OOMPA_BIND_MARKER;
  const resultMarker = process.env.OOMPA_BIND_RESULT;
  const parentMountNamespace = process.env.OOMPA_BIND_PARENT_MNT_NS;
  if (!root || !marker || !resultMarker || !parentMountNamespace) throw new Error("bind_driver_environment_missing");
  if (readlinkSync("/proc/self/ns/mnt") === parentMountNamespace) throw new Error("bind_driver_mount_namespace_not_private");
  const recovery = join(root, "process-recovery");
  const alias = join(root, "recovery-bind-alias");
  mkdirSync(recovery, { mode: 0o700 });
  mkdirSync(alias, { mode: 0o700 });
  const mounted = spawnSync("/usr/bin/mount", ["--bind", recovery, alias], { encoding: "utf8" });
  if (mounted.status !== 0) throw new Error("bind_driver_mount_failed:" + mounted.stderr);

  try {
    const socketPath = join(recovery, ".authority-control-" + "c".repeat(32) + ".sock");
    const server = createServer();
    let accepted;
    const connected = new Promise((resolve) => { server.once("connection", (socket) => { accepted = socket; resolve(); }); });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    chmodSync(socketPath, 0o600);
    const opened = await import(${JSON.stringify(artifactModuleUrl)}).then((module) => module.openAuthoritySupervisorArtifact());
    const nonce = "3".repeat(32);
    const helper = spawn(opened.executionPath, [
      "--control-socket", socketPath, "--nonce", nonce, "--", process.execPath, "-e",
      "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran')",
    ], { cwd: root, env: process.env, shell: false, stdio: ["pipe", "ignore", "ignore"] });
    const helperClosed = new Promise((resolve, reject) => {
      helper.once("error", reject);
      helper.once("close", (code, signal) => resolve({ code, signal }));
    });
    await connected;
    let buffered = "";
    const firstLine = await new Promise((resolve, reject) => {
      accepted.setEncoding("utf8");
      accepted.on("data", (chunk) => {
        buffered += chunk;
        const newline = buffered.indexOf("\\n");
        if (newline >= 0) resolve(buffered.slice(0, newline));
      });
      accepted.once("error", reject);
      accepted.once("close", () => reject(new Error("bind_driver_control_closed")));
    });
    helper.stdin.end();
    const closed = await helperClosed;
    writeFileSync(resultMarker, JSON.stringify({ firstLine, closed }));
    accepted.destroy();
    await new Promise((resolve) => server.close(resolve));
    await opened.close();
  } finally {
    const unmounted = spawnSync("/usr/bin/umount", ["--", alias], { encoding: "utf8" });
    if (unmounted.status !== 0) throw new Error("bind_driver_unmount_failed:" + unmounted.stderr);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
`;

const waitForFile = async (path: string, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!await Bun.file(path).exists()) {
    if (Date.now() >= deadline) throw new Error(`authority_runtime_file_timeout:${path}`);
    await Bun.sleep(20);
  }
};

const spawnDeadlineDriver = (
  root: string,
  stopMode: "outer" | "parent",
  markers: Readonly<{
    delayed: string;
    go: string;
    result: string;
    started: string;
  }>,
): ChildProcessWithoutNullStreams => spawn(process.execPath, [
  "-e",
  deadlineDriverSource(new URL("./authority-supervisor-artifact.ts", import.meta.url).href),
], {
  cwd: root,
  env: {
    ...process.env,
    OOMPA_DRIVER_DELAYED_MARKER: markers.delayed,
    OOMPA_DRIVER_GO_MARKER: markers.go,
    OOMPA_DRIVER_RESULT_MARKER: markers.result,
    OOMPA_DRIVER_ROOT: root,
    OOMPA_DRIVER_STARTED_MARKER: markers.started,
    OOMPA_DRIVER_STOP_MODE: stopMode,
  },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

const spawnBindAliasDriver = async (
  root: string,
  marker: string,
  result: string,
): Promise<ChildProcessWithoutNullStreams> => spawn("/usr/bin/unshare", [
  "--user",
  "--map-root-user",
  "--mount",
  "--propagation",
  "private",
  "--fork",
  process.execPath,
  "-e",
  bindAliasDriverSource(new URL("./authority-supervisor-artifact.ts", import.meta.url).href),
], {
  cwd: root,
  env: {
    ...process.env,
    OOMPA_BIND_MARKER: marker,
    OOMPA_BIND_PARENT_MNT_NS: await readlink("/proc/self/ns/mnt"),
    OOMPA_BIND_RESULT: result,
    OOMPA_BIND_ROOT: root,
  },
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

test.each([false, true])("portable stdin-gated child naturally closes both output streams (writes=%s)", async (writes) => {
  if (process.platform === "win32") return;
  const child = spawn("/bin/sh", ["-c", writes
    ? "read -r gate; printf x; printf y >&2; exit 0"
    : "read -r gate; exit 0"], {
    env: { PATH: "/usr/bin:/bin" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lifecycle = createChildLifecycleRecorder();
  lifecycle.attachChild(child);
  const closed = observeChildClose(child);
  void closed.catch(() => undefined);
  let onCleanupClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  const cleanupClosed = new Promise<ChildClose>((resolvePromise) => {
    onCleanupClose = (code, signal) => resolvePromise({ code, signal });
    child.once("close", onCleanupClose);
  });
  try {
    await waitForChildSpawn(child);
    // Retain the resume-only comparison, without data listeners.
    child.stdout.resume();
    child.stderr.resume();
    child.stdin.end("GO\n");
    expect(await requireChildClose(closed, 15_000)).toEqual({ code: 0, signal: null });
    expect(lifecycle.snapshot()).toMatchObject({ exitObserved: true, closeObserved: true,
      stdoutEnd: true, stdoutClose: true, stderrEnd: true, stderrClose: true });
  } catch (error: unknown) {
    try {
      process.stderr.write(`authority_portable_child_lifecycle ${JSON.stringify({ writes, ...lifecycle.snapshot() })}\n`);
    } catch { /* Diagnostic output cannot replace the original failure. */ }
    lifecycle.dispose();
    // Only a failed natural proof allows forced cleanup of this exact child's
    // parent streams. Forced closure can never satisfy the assertion above.
    let cleanupFailed = false;
    try { child.kill("SIGKILL"); } catch { cleanupFailed = true; }
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      try { stream.destroy(); } catch { cleanupFailed = true; }
    }
    try { await requireChildClose(cleanupClosed, 2_000); } catch { cleanupFailed = true; }
    if (cleanupFailed) {
      try { process.stderr.write("authority_portable_child_cleanup {\"complete\":false}\n"); }
      catch { /* Preserve the original failure even if diagnostic output fails. */ }
    }
    throw error;
  } finally {
    lifecycle.dispose();
    if (onCleanupClose !== undefined) child.off("close", onCleanupClose);
  }
}, 20_000);

test("authority supervisor holds a target behind GO", async () => {
  if (!isSupportedLinux()) return;
  let socketMarker: string | undefined;
  const lifecycle = createChildLifecycleRecorder();
  let diagnosticChild: ChildProcessWithoutNullStreams | undefined;
  let output: ReturnType<typeof consumeOwnedChildOutput> | undefined;
  let streamsAtClean: ReturnType<typeof snapshotChildStreamState> = null;
  let outputAtClean: ReturnType<ReturnType<typeof consumeOwnedChildOutput>["snapshot"]> | null = null;
  const nonce = "1".repeat(32);
  let naturalCloseProven = false;
  let failureRecorded = false;
  const recordFailure = () => {
    if (failureRecorded) return;
    failureRecorded = true;
    // Snapshot before forced cleanup, including when the outer test timeout
    // delegates collection to afterEach. Never emit target bytes or identities.
    const snapshot = lifecycle.snapshot();
    try {
      const streamsAtFailure = snapshotChildStreamState(diagnosticChild);
      const outputAtFailure = output?.snapshot() ?? null;
      const selfWriters = censusSelfSocketWriters(socketMarker === undefined ? undefined : readPrivateSocketMarker(socketMarker));
      process.stderr.write(`authority_child_lifecycle ${JSON.stringify({ ...snapshot, ...selfWriters,
        streamsAtClean, streamsAtFailure, outputAtClean, outputAtFailure })}\n`);
    } catch { /* Diagnostic inability cannot replace the original failure. */ }
  };
  const fixture = createOwnedRuntimeFixture(async (scope) => {
    const root = await mkdtemp(join(tmpdir(), "oompa-authority-rt-"));
    // Register even a late root before any further await or cancellation check.
    roots.push(root);
    ownedFixtureCleanups.set(root, fixture.collect);
    scope.assertActive();
    await chmod(root, 0o700);
    scope.assertActive();
    const marker = join(root, "target-ran");
    socketMarker = join(root, "target-private-stdio-sockets");
    const controlRoot = join(root, "process-recovery");
    const parentPidNamespace = await readlink("/proc/self/ns/pid");
    scope.assertActive();
    await mkdir(controlRoot, { mode: 0o700 });
    scope.assertActive();
    const control = await ControlServer.start(controlRoot, lifecycle, scope);
    const opened = await scope.acquire(openAuthoritySupervisorArtifact, (artifact) => artifact.close());
    const child = spawn(opened.executionPath, [
      "--control-socket",
      control.path,
      "--nonce",
      nonce,
      "--",
      process.execPath,
      "-e",
      `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(marker)}, fs.readlinkSync('/proc/self/ns/pid'));
       try {
         const sockets = JSON.stringify({ stdout: fs.readlinkSync('/proc/self/fd/1'), stderr: fs.readlinkSync('/proc/self/fd/2') });
         if (Buffer.byteLength(sockets, 'utf8') <= 128) fs.writeFileSync(${JSON.stringify(socketMarker)}, sockets, { flag: 'wx', mode: 0o600 });
       } catch {}`,
    ], {
      cwd: root,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    diagnosticChild = child;
    lifecycle.attachChild(child);
    const closed = observeChildClose(child);
    void closed.catch(() => undefined);
    // Unlike the natural observer, this close-only observer survives an error
    // event and can prove subsequent forced collection without forging PASS.
    let onCleanupClose: ((code: number | null, signal: NodeJS.Signals | null) => void) | undefined;
    const cleanupClosed = new Promise<ChildClose>((resolvePromise) => {
      onCleanupClose = (code, signal) => resolvePromise({ code, signal });
      child.once("close", onCleanupClose);
    });
    scope.own(async () => {
      let cleanupFailed = false;
      if (!naturalCloseProven) {
        recordFailure();
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill("SIGKILL"); } catch { cleanupFailed = true; }
        }
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try { stream.destroy(); } catch { cleanupFailed = true; }
        }
      }
      try { await cleanupClosed; }
      finally {
        output?.dispose();
        if (onCleanupClose !== undefined) child.off("close", onCleanupClose);
      }
      if (cleanupFailed) throw new Error("authority_runtime_child_cleanup_failed");
    });
    await waitForChildSpawn(child);
    scope.assertActive();
    await opened.close();
    scope.assertActive();
    output = consumeOwnedChildOutput(child);
    const ready = await control.nextLine();
    expect(ready).toMatch(new RegExp(`^HRA_AUTHORITY_SUPERVISOR/1 READY nonce=${nonce} `));
    const monotonicMatch = ready.match(/ monotonic_ms=([1-9][0-9]*)$/u);
    const namespaceMatch = ready.match(/ init_pid_namespace_inode=([1-9][0-9]*) /u);
    expect(monotonicMatch).not.toBeNull();
    expect(namespaceMatch).not.toBeNull();
    await Bun.sleep(175);
    expect(await Bun.file(marker).exists()).toBeFalse();
    scope.assertActive();
    control.write(
      `HRA_AUTHORITY_SUPERVISOR/1 GO nonce=${nonce} deadline_monotonic_ms=${BigInt(monotonicMatch?.[1] ?? "0") + 5_000n}\n`,
    );
    child.stdin.end();
    const clean = await control.nextLine();
    scope.assertActive();
    expect(clean).toBe(`HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=${nonce} exit=0`);
    streamsAtClean = snapshotChildStreamState(child);
    outputAtClean = output.snapshot();
    // The close observer starts before READY; this 15-second deadline starts
    // after CLEAN. Require joined process and pipe closure even after CLEAN.
    try {
      // Bun 1.3.14 promise matchers can re-enter the event loop and lose
      // one-shot pipe events. Await natural closure before asserting it.
      const result = await requireChildClose(closed, 15_000);
      scope.assertActive();
      expect(result).toEqual({ code: 0, signal: null });
      expect(lifecycle.snapshot()).toMatchObject({ exitObserved: true, exitCode: 0, exitSignalPresent: false,
        closeObserved: true, closeCode: 0, closeSignalPresent: false,
        stdoutEnd: true, stdoutClose: true, stderrEnd: true, stderrClose: true });
      expect(output.snapshot()).toEqual({ stdoutBytes: 0, stderrBytes: 0, overflow: false, invalidChunk: false });
      naturalCloseProven = true;
    } catch (error: unknown) {
      recordFailure();
      throw error;
    }
    const targetPidNamespace = await readFile(marker, "utf8");
    expect(targetPidNamespace).toBe(`pid:[${namespaceMatch?.[1] ?? "missing"}]`);
    expect(targetPidNamespace).not.toBe(parentPidNamespace);
  });
  // Own pending mkdtemp too; the outer timeout must not start a late child.
  pendingFixtureCleanups.add(fixture.collect);
  try { await fixture.result; }
  finally { lifecycle.dispose(); }
}, 20_000);

test("native deadline kills custody while the Oompa parent is stopped after GO", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const markers = {
    delayed: join(root, "stopped-parent-delayed-marker"),
    go: join(root, "stopped-parent-go-marker"),
    result: join(root, "stopped-parent-result"),
    started: join(root, "stopped-parent-started-marker"),
  };
  const driver = spawnDeadlineDriver(root, "parent", markers);
  const closed = waitForChildClose(driver, 12_000);
  void closed.catch(() => undefined);
  const stderr = readChildStream(driver.stderr);
  driver.stdout.resume();
  try {
    await waitForFile(markers.go);
    await waitForFile(markers.started);
    if (driver.pid === undefined) throw new Error("authority_driver_pid_missing");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await readFile(`/proc/${driver.pid}/status`, "utf8");
      if (/^State:\s+T/mu.test(status)) break;
      if (attempt === 99) throw new Error("authority_driver_not_stopped");
      await Bun.sleep(20);
    }
    await Bun.sleep(3_500);
    expect(await Bun.file(markers.delayed).exists()).toBeFalse();
    driver.kill("SIGCONT");
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(JSON.parse(await readFile(markers.result, "utf8"))).toEqual({
      clean: `HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=${"2".repeat(32)} exit=124`,
      closed: { code: 124, signal: null },
    });
  } catch (error) {
    driver.kill("SIGCONT");
    driver.kill("SIGKILL");
    throw new Error(`${String(error)}\n${await stderr}`);
  } finally {
    driver.kill("SIGKILL");
  }
}, 15_000);

test("namespace PID 1 enforces the deadline while the outer supervisor is stopped", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const markers = {
    delayed: join(root, "stopped-outer-delayed-marker"),
    go: join(root, "stopped-outer-go-marker"),
    result: join(root, "stopped-outer-result"),
    started: join(root, "stopped-outer-started-marker"),
  };
  const driver = spawnDeadlineDriver(root, "outer", markers);
  const closed = waitForChildClose(driver, 12_000);
  void closed.catch(() => undefined);
  const stderr = readChildStream(driver.stderr);
  driver.stdout.resume();
  try {
    await waitForFile(markers.go);
    const outerPid = Number.parseInt(await readFile(markers.go, "utf8"), 10);
    expect(Number.isSafeInteger(outerPid)).toBeTrue();
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = await readFile(`/proc/${outerPid}/status`, "utf8");
      if (/^State:\s+T/mu.test(status)) break;
      if (attempt === 99) throw new Error("authority_outer_not_stopped");
      await Bun.sleep(20);
    }
    await waitForFile(markers.started);
    await Bun.sleep(3_500);
    expect(await Bun.file(markers.delayed).exists()).toBeFalse();
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(JSON.parse(await readFile(markers.result, "utf8"))).toEqual({
      clean: `HRA_AUTHORITY_SUPERVISOR/1 CLEAN nonce=${"2".repeat(32)} exit=124`,
      closed: { code: 124, signal: null },
    });
  } catch (error) {
    driver.kill("SIGKILL");
    throw new Error(`${String(error)}\n${await stderr}`);
  } finally {
    driver.kill("SIGKILL");
  }
}, 15_000);

test("authority supervisor rejects an inherited bind alias of its recovery directory", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const marker = join(root, "bind-alias-target-marker");
  const result = join(root, "bind-alias-result");
  const driver = await spawnBindAliasDriver(root, marker, result);
  const closed = waitForChildClose(driver, 10_000);
  void closed.catch(() => undefined);
  const stderr = readChildStream(driver.stderr);
  driver.stdout.resume();
  try {
    expect(await closed).toEqual({ code: 0, signal: null });
    expect(JSON.parse(await readFile(result, "utf8"))).toEqual({
      firstLine: `HRA_AUTHORITY_SUPERVISOR/1 FAIL nonce=${"3".repeat(32)} code=init_not_ready`,
      closed: { code: 1, signal: null },
    });
    expect(await Bun.file(marker).exists()).toBeFalse();
  } catch (error) {
    driver.kill("SIGKILL");
    throw new Error(`${String(error)}\n${await stderr}`);
  } finally {
    driver.kill("SIGKILL");
  }
}, 12_000);

test("authority runner preserves direct Bun stdin and stdout", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const target = [
    "let input = ''; process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => process.stdout.write(`received:${input}`));",
  ].join(" ");
  const result = await runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-direct-stdio",
    stdin: "hello\n",
    terminationGraceMs: 50,
    timeoutMs: 5_000,
  }, { recoveryDirectory });
  expect(result).toMatchObject({
    cleanup: "proven",
    exitCode: 0,
    stderr: Buffer.alloc(0),
    stdout: Buffer.from("received:hello\n"),
  });
}, 10_000);

test("authority runner supports a non-detached nested Bun spawn", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const markers = {
    before: join(root, "nested-before-marker"),
    child: join(root, "nested-child-marker"),
    close: join(root, "nested-close-marker"),
    error: join(root, "nested-error-marker"),
    returned: join(root, "nested-returned-marker"),
    spawn: join(root, "nested-spawn-marker"),
  } as const;
  const nested = [
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(markers.child)}, 'child');`,
  ].join(" ");
  const target = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(markers.before)}, 'before');`,
    "try {",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(nested)}], { detached: false, stdio: 'ignore' });`,
    `writeFileSync(${JSON.stringify(markers.returned)}, 'returned:' + String(child.pid));`,
    `child.once('spawn', () => writeFileSync(${JSON.stringify(markers.spawn)}, 'spawn:' + String(child.pid)));`,
    `child.once('error', (error) => { writeFileSync(${JSON.stringify(markers.error)}, 'error:' + String(error && error.code)); process.exitCode = 1; });`,
    `child.once('close', (code, signal) => { writeFileSync(${JSON.stringify(markers.close)}, 'close:' + String(code) + ':' + String(signal)); process.stdout.write('nested:' + String(code) + ':' + String(signal)); });`,
    `} catch (error) { writeFileSync(${JSON.stringify(markers.error)}, 'throw:' + String(error && error.code)); process.exitCode = 1; }`,
  ].join(" ");
  const result = await runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-nested-spawn",
    terminationGraceMs: 50,
    timeoutMs: 5_000,
  }, { recoveryDirectory });
  await Bun.sleep(50);
  const observedMarkers = await observeMarkers(markers);
  expect({ markers: observedMarkers, result }).toMatchObject({
    markers: {
      before: "before",
      child: "child",
      close: "close:0:null",
      error: "missing",
      returned: expect.stringMatching(/^returned:[1-9][0-9]*$/u),
      spawn: expect.stringMatching(/^spawn:[1-9][0-9]*$/u),
    },
    result: {
      cleanup: "proven",
      exitCode: 0,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("nested:0:null"),
    },
  });
}, 10_000);

test("authority runner kills detached descendants after normal completion", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const escapedMarker = join(root, "normal-escape-marker");
  const markers = {
    before: join(root, "detached-before-marker"),
    error: join(root, "detached-error-marker"),
    returned: join(root, "detached-returned-marker"),
    spawn: join(root, "detached-spawn-marker"),
    started: join(root, "detached-started-marker"),
  } as const;
  const escaped = [
    "const { writeFileSync } = require('node:fs');",
    "process.stdout.write('started');",
    `setTimeout(() => writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped'), 4_000);`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const target = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `writeFileSync(${JSON.stringify(markers.before)}, 'before');`,
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });`,
    `writeFileSync(${JSON.stringify(markers.returned)}, 'returned:' + String(child.pid));`,
    `child.once('spawn', () => writeFileSync(${JSON.stringify(markers.spawn)}, 'spawn:' + String(child.pid)));`,
    `child.once('error', (error) => writeFileSync(${JSON.stringify(markers.error)}, 'error:' + String(error && error.code)));`,
    "let childStarted = false; let inputEnded = false;",
    "let input = ''; process.stdin.setEncoding('utf8');",
    "const finish = () => { if (childStarted && inputEnded) process.stdout.write(`received:${input}`); };",
    `child.stdout.once('data', () => { childStarted = true; writeFileSync(${JSON.stringify(markers.started)}, 'started'); child.stdout.destroy(); child.unref(); finish(); });`,
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => { inputEnded = true; finish(); });",
  ].join(" ");
  const result = await runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-normal-custody",
    stdin: "hello\n",
    terminationGraceMs: 50,
    timeoutMs: 5_000,
  }, { recoveryDirectory });
  await Bun.sleep(50);
  const observedMarkers = await observeMarkers(markers);
  expect({ markers: observedMarkers, result }).toMatchObject({
    markers: {
      before: "before",
      error: "missing",
      returned: expect.stringMatching(/^returned:[1-9][0-9]*$/u),
      spawn: expect.stringMatching(/^spawn:[1-9][0-9]*$/u),
      started: "started",
    },
    result: {
      cleanup: "proven",
      exitCode: 0,
      stdout: Buffer.from("received:hello\n"),
    },
  });
  await Bun.sleep(4_250);
  expect(await Bun.file(escapedMarker).exists()).toBeFalse();
}, 15_000);

test("authority recovery kills post-GO custody after output overflow", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const escapedMarker = join(root, "overflow-escape-marker");
  const escaped = [
    "const { writeFileSync } = require('node:fs');",
    `setTimeout(() => writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped'), 4_000);`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const target = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], { detached: true, stdio: 'ignore' });`,
    "child.unref();",
    "process.stdout.write('x'.repeat(8_192));",
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const result = await runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 64,
    phase: "authority-overflow-custody",
    terminationGraceMs: 50,
    timeoutMs: 5_000,
  }, { recoveryDirectory });
  expect(result).toMatchObject({ cleanup: "proven", exitCode: 1 });
  await Bun.sleep(4_250);
  expect(await Bun.file(escapedMarker).exists()).toBeFalse();
}, 15_000);

test("authority target cannot replace the journal lock or erase custody", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const tamperResult = join(root, "tamper-result");
  const target = [
    "const fs = require('node:fs');",
    "let outcome;",
    `try { const names = fs.readdirSync(${JSON.stringify(recoveryDirectory)}); for (const name of names) { if (name === '.journal.lock' || name.endsWith('.json')) fs.unlinkSync(require('node:path').join(${JSON.stringify(recoveryDirectory)}, name)); } outcome = 'tampered'; } catch (error) { outcome = 'blocked:' + String(error && error.code); }`,
    `fs.writeFileSync(${JSON.stringify(tamperResult)}, outcome);`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const first = runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-journal-tamper",
    terminationGraceMs: 50,
    timeoutMs: 2_000,
  }, { recoveryDirectory });
  void first.catch(() => undefined);

  for (let attempt = 0; attempt < 100 && !await Bun.file(tamperResult).exists(); attempt += 1) {
    await Bun.sleep(20);
  }
  expect(await readFile(tamperResult, "utf8")).toBe("blocked:EACCES");
  await expect(runBoundedProcess({
    arguments: ["-e", "process.exit(0)"],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-concurrent-after-tamper",
    terminationGraceMs: 50,
    timeoutMs: 1_000,
  }, { recoveryDirectory })).rejects.toThrow(
    "bounded_process_recovery_journal_blocked:concurrent_invocation",
  );
  expect(await first).toMatchObject({ cleanup: "proven", exitCode: 124 });
}, 10_000);

test("authority runner refuses GO when the durable GO commit consumes the deadline", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const marker = join(root, "expired-go-must-not-run");
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  let committed = false;
  const result = await runBoundedProcess({
    arguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-expired-go",
    terminationGraceMs: 50,
    timeoutMs: 2_000,
  }, {
    afterAuthorityGoJournal: () => {
      committed = true;
      Atomics.wait(waitCell, 0, 0, 2_250);
    },
    recoveryDirectory,
  });
  expect(committed).toBeTrue();
  expect(result).toMatchObject({ cleanup: "proven", exitCode: 124 });
  await Bun.sleep(175);
  expect(await Bun.file(marker).exists()).toBeFalse();
}, 10_000);

test("authority runner recovers a timed-out detached descendant", async () => {
  if (!isSupportedLinux()) return;
  const root = await makeRoot();
  const recoveryDirectory = join(root, "process-recovery");
  const escapedMarker = join(root, "timeout-escape-marker");
  const recoveryFailures: string[] = [];
  const escaped = [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    `setTimeout(() => writeFileSync(${JSON.stringify(escapedMarker)}, 'escaped'), 4_000);`,
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const target = [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(escaped)}], { detached: true, stdio: 'ignore' });`,
    "child.unref();",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => undefined, 1_000);",
  ].join(" ");
  const result = await runBoundedProcess({
    arguments: ["-e", target],
    containment: "authority",
    cwd: root,
    environment: process.env,
    executable: process.execPath,
    outputMaximumBytes: 4_096,
    phase: "authority-timeout-custody",
    terminationGraceMs: 50,
    timeoutMs: 1_000,
  }, {
    afterAuthorityRecoveryFailure: (code) => recoveryFailures.push(code),
    recoveryDirectory,
  });
  expect({ recoveryFailures, result }).toMatchObject({
    recoveryFailures: [],
    result: { cleanup: "proven", exitCode: 124 },
  });
  await Bun.sleep(4_250);
  expect(await Bun.file(escapedMarker).exists()).toBeFalse();
}, 10_000);
