// A credential-free test child, not a product daemon launcher. There is no
// provider effect, restore, arbitrary command or production-root input here.
import { mock } from "bun:test";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

import type { OompaInstallation } from "../src/installation";

export const RESTART_NATIVE_VARIABLE = "OOMPA_DARWIN_DAEMON_RESTART_NATIVE";
export const RESTART_REPOSITORY = resolve(import.meta.dir, "..");
export const RESTART_SOURCE_FILES = [
  "scripts/darwin-daemon-restart-fixture.ts",
  "scripts/darwin-daemon-restart.native.test.ts",
  "src/cli.ts", "src/installation.ts", "src/storage/paths.ts",
  "src/storage/state-store.ts", "src/storage/secret-custody.ts",
  "src/daemon/service.ts", "src/daemon/daemon-lock.ts",
  "src/daemon/daemon-startup.ts", "src/daemon/local-transport.ts",
  "src/daemon/claude-host-tool-transport.ts", "bun.lock", "package.json",
] as const;
const maximumDescriptorBytes = 32 * 1_024;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const directorySchema = z.object({ device: natural, inode: natural, owner: natural }).strict();
const fileSchema = directorySchema.extend({
  bytes: natural, mode: natural, modified: z.number().finite(),
  changed: z.number().finite(), sha256: digest,
}).strict();
const sourceSchema = z.object({ path: z.enum(RESTART_SOURCE_FILES), identity: fileSchema }).strict();
export const restartDescriptorSchema = z.object({
  version: z.literal(1), source: z.literal("credential_free_fixture"),
  runId: z.string().uuid(), phase: z.enum(["a", "b"]),
  root: z.string().regex(/^\/private\/tmp\/oompa-dr-[a-zA-Z0-9]{6}$/u),
  home: z.string().min(1).max(4_096),
  repository: z.literal(RESTART_REPOSITORY),
  directories: z.object({ root: directorySchema, state: directorySchema,
    project: directorySchema, runtime: directorySchema }).strict(),
  database: directorySchema,
  executable: z.object({ path: z.string().min(1).max(4_096), identity: fileSchema }).strict(),
  files: z.array(sourceSchema).length(RESTART_SOURCE_FILES.length).refine((files) =>
    files.every((file, index) => file.path === RESTART_SOURCE_FILES[index])),
}).strict();
export type RestartDescriptor = z.infer<typeof restartDescriptorSchema>;

export const restartChildResultSchema = z.object({
  version: z.literal(1), source: z.literal("credential_free_fixture"),
  runId: z.string().uuid(), phase: z.enum(["a", "b"]), pid: natural.refine((pid) => pid > 0),
  outcome: z.enum(["stopped", "refused"]), externalAttempts: natural,
  sentinelChecks: z.literal(10), sourceDigest: digest,
}).strict();

const invalid = (): Error => new Error("DAEMON_RESTART_FIXTURE_REFUSED");
const sameMetadata = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino
  && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink
  && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function fingerprint(path: string, maximumBytes: number): z.infer<typeof fileSchema> {
  if (realpathSync(path) !== path) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximumBytes
      || before.uid !== process.getuid?.()) throw invalid();
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1_024);
    let bytes = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, bytes);
      if (count === 0) break;
      bytes += count;
      if (bytes > maximumBytes) throw invalid();
      hash.update(buffer.subarray(0, count));
    }
    if (bytes !== before.size || !sameMetadata(before, fstatSync(fd))
      || !sameMetadata(before, lstatSync(path))) throw invalid();
    return fileSchema.parse({ device: before.dev, inode: before.ino, owner: before.uid,
      bytes, mode: before.mode, modified: before.mtimeMs, changed: before.ctimeMs,
      sha256: hash.digest("hex") });
  } finally { closeSync(fd); }
}

function directory(path: string): z.infer<typeof directorySchema> {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o7777) !== 0o700
    || stat.uid !== process.getuid?.() || realpathSync(path) !== path) throw invalid();
  return { device: stat.dev, inode: stat.ino, owner: stat.uid };
}

function databaseIdentity(path: string): z.infer<typeof directorySchema> {
  if (realpathSync(path) !== path) throw invalid();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    // SQLite may change bytes and timestamps; its original file identity stays fixed.
    for (const stat of [before, fstatSync(fd), lstatSync(path)]) {
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
        || stat.uid !== process.getuid?.() || stat.dev !== before.dev
        || stat.ino !== before.ino || stat.uid !== before.uid) throw invalid();
    }
    if (realpathSync(path) !== path) throw invalid();
    return { device: before.dev, inode: before.ino, owner: before.uid };
  } finally { closeSync(fd); }
}

export function restartPaths(root: RestartDescriptor["root"]) {
  if (!restartDescriptorSchema.shape.root.safeParse(root).success) throw invalid();
  return Object.freeze({ root, state: join(root, "state"), project: join(root, "project"),
    runtime: join(root, "state", "runtime") });
}

/** Selected-file content provenance, not a replacement for the root's Git gate. */
export function captureRestartDescriptor(input: Readonly<{
  root: string; runId: string; phase: "a" | "b";
}>): RestartDescriptor {
  const paths = restartPaths(input.root);
  const home = homedir();
  if (process.env.HOME !== home || home === "/" || resolve(home) !== home
    || input.root === home || input.root.startsWith(`${home}/`)
    || home.startsWith(`${input.root}/`)) throw invalid();
  return restartDescriptorSchema.parse({
    version: 1, source: "credential_free_fixture", ...input, home,
    repository: RESTART_REPOSITORY,
    directories: Object.fromEntries(Object.entries(paths).map(([name, path]) => [name, directory(path)])),
    executable: { path: realpathSync(process.execPath),
      identity: fingerprint(realpathSync(process.execPath), 256 * 1_024 * 1_024) },
    files: RESTART_SOURCE_FILES.map((path) => ({ path,
      identity: fingerprint(join(RESTART_REPOSITORY, path), 8 * 1_024 * 1_024) })),
    database: databaseIdentity(join(paths.state, "control-plane.sqlite")),
  });
}

export function assertRestartDescriptor(input: unknown): RestartDescriptor {
  const value = restartDescriptorSchema.parse(input);
  return assertRestartDescriptorObservation(value, captureRestartDescriptor(value));
}

/** Pure descriptor join; the native caller supplies actual captured observations. */
export function assertRestartDescriptorObservation(expected: unknown, observed: unknown): RestartDescriptor {
  const value = restartDescriptorSchema.parse(expected);
  const actual = restartDescriptorSchema.parse(observed);
  if (JSON.stringify(actual) !== JSON.stringify(value)) throw invalid();
  return value;
}

export function restartSourceDigest(value: RestartDescriptor): string {
  return createHash("sha256").update(JSON.stringify({
    executable: value.executable, files: value.files, repository: value.repository,
  })).digest("hex");
}

/** Pure refusal fixture. Native installation below accepts no replacement ports. */
export function createRestartEffectSentinel() {
  let attempts = 0;
  return Object.freeze({
    reject(): never { attempts += 1; throw invalid(); },
    get attempts() { return attempts; },
  });
}

/** Fixed isolated-child denial guard. Never installs into the parent test process. */
export async function installRestartEffectSentinel() {
  if (Bun.version !== "1.3.14") throw invalid();
  const sentinel = createRestartEffectSentinel();
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const;
  const targets = [
    [Bun, "spawn"], [Bun, "spawnSync"], [globalThis, "fetch"],
    ...names.map((name): readonly [object, string] => [childProcess, name]),
  ] as const;
  for (const [target, name] of targets) {
    const before = Object.getOwnPropertyDescriptor(target, name);
    if (before === undefined || !("value" in before) || before.writable !== true
      || typeof before.value !== "function") throw invalid();
    // Bun 1.3.14 spawn methods are writable but nonconfigurable. Retain all
    // existing descriptor flags rather than trying to change configurability.
    Object.defineProperty(target, name, { value: sentinel.reject });
    const after = Object.getOwnPropertyDescriptor(target, name);
    if (after === undefined || after.value !== sentinel.reject
      || after.configurable !== before.configurable || after.enumerable !== before.enumerable
      || after.writable !== before.writable) throw invalid();
  }
  // Bun's syncBuiltinESMExports does not update these named exports. Its test
  // module mock updates the actual imports before any production module loads.
  const childModule = await import("node:child_process");
  const replacements = { ...childModule, default: childProcess,
    ...Object.fromEntries(names.map((name) => [name, sentinel.reject])) };
  await mock.module("node:child_process", () => replacements);
  await mock.module("child_process", () => replacements);
  for (const named of [await import("node:child_process"), await import("child_process")]) {
    for (const name of names) {
      if (Reflect.get(named, name) !== sentinel.reject
        || Reflect.get(named.default, name) !== sentinel.reject) throw invalid();
    }
  }
  // Exercise only the exact installed rejection wrapper, never an original API.
  for (const [target, name] of targets) {
    const before = sentinel.attempts;
    const installed: unknown = Reflect.get(target, name);
    if (installed !== sentinel.reject) throw invalid();
    try { sentinel.reject(); } catch { /* expected fixed synthetic refusal */ }
    if (sentinel.attempts !== before + 1) throw invalid();
  }
  const baseline = sentinel.attempts;
  if (baseline !== 10) throw invalid();
  return Object.freeze({ reject: sentinel.reject,
    get attempts() { return sentinel.attempts - baseline; } });
}

async function readDescriptor(): Promise<RestartDescriptor> {
  return await new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const deadlineAt = Date.now() + 5_000;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", onData).off("end", onEnd).off("error", onError).off("close", onClose);
      process.stdin.pause();
      try {
        if (error !== undefined) throw error;
        if (Date.now() >= deadlineAt) throw invalid();
        const body = Buffer.concat(chunks);
        try {
          if (body.at(-1) !== 10 || body.subarray(0, -1).includes(10)) throw invalid();
          resolvePromise(assertRestartDescriptor(JSON.parse(body.toString("utf8")) as unknown));
        } finally { body.fill(0); }
      } catch { reject(invalid()); }
      finally { for (const chunk of chunks) chunk.fill(0); }
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maximumDescriptorBytes) { finish(invalid()); process.stdin.destroy(); }
      else chunks.push(Buffer.from(chunk));
    };
    const onEnd = () => finish();
    const onError = () => finish(invalid());
    const onClose = () => { if (!process.stdin.readableEnded) finish(invalid()); };
    const timer = setTimeout(() => { finish(invalid()); process.stdin.destroy(); }, 5_000);
    process.stdin.on("data", onData).once("end", onEnd).once("error", onError).once("close", onClose);
    process.stdin.resume();
  });
}

async function writeResult(value: z.infer<typeof restartChildResultSchema>): Promise<void> {
  const body = `${JSON.stringify(restartChildResultSchema.parse(value))}\n`;
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(invalid()), 2_000);
    process.stdout.write(body, (error) => {
      clearTimeout(timer);
      if (error !== null && error !== undefined) reject(invalid()); else resolvePromise();
    });
  });
}

async function main(): Promise<number> {
  if (process.platform !== "darwin" || Bun.version !== "1.3.14"
    || process.env[RESTART_NATIVE_VARIABLE] !== "1" || Bun.argv.length !== 2) return 64;
  const descriptor = await readDescriptor();
  const sentinel = await installRestartEffectSentinel();
  const { runDaemon } = await import("../src/cli");
  const { personalProviderPaths, resolveStatePaths } = await import("../src/storage/paths");
  const { FileSecretBackend, GenerationalSecretCustody } = await import("../src/storage/secret-custody");
  const paths = resolveStatePaths({ rootDirectory: restartPaths(descriptor.root).state });
  if (Buffer.byteLength(join(paths.runtime, "claude-host-tools.sock")) >= 104) throw invalid();
  const installation: OompaInstallation = {
    kind: "live_acceptance", expectedHomeDirectory: descriptor.home,
    paths, documentsDirectory: restartPaths(descriptor.root).project,
    cloudEnvironment: { HRA_CONVEX_URL: "" },
    personalProviderHomes: personalProviderPaths(join(paths.root, "personal-home")),
    createSecretCustody: () => new GenerationalSecretCustody(paths, new FileSecretBackend(join(paths.root, "secret-values"))),
    credentialStorePreflight: { cliAuth: "file", mcpOauth: "file", cwd: restartPaths(descriptor.root).project },
    codexEnvironment: async () => sentinel.reject(),
    prepareCodexHome: async () => sentinel.reject(),
  };
  const controller = new AbortController();
  const deadlineAt = Date.now() + 60_000;
  const timer = setTimeout(() => controller.abort(invalid()), 60_000);
  let outcome: "stopped" | "refused" = "refused";
  try {
    assertRestartDescriptor(descriptor);
    const result = await runDaemon(installation, { stopSignal: controller.signal });
    assertRestartDescriptor(descriptor);
    if (result === 0 && sentinel.attempts === 0 && !controller.signal.aborted
      && Date.now() < deadlineAt) outcome = "stopped";
  } catch { /* Only the closed result crosses the fixture pipe. */ }
  finally { clearTimeout(timer); }
  await writeResult({ version: 1, source: "credential_free_fixture", runId: descriptor.runId,
    phase: descriptor.phase, pid: process.pid, outcome, externalAttempts: sentinel.attempts,
    sentinelChecks: 10, sourceDigest: restartSourceDigest(descriptor) });
  return outcome === "stopped" ? 0 : 70;
}

if (import.meta.main) {
  process.exitCode = await main().catch(() => 70);
}
