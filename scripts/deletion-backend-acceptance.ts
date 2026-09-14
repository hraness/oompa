import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync,
  mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync,
  symlinkSync, writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { z } from "zod";

import { runBoundedProcess } from "./bounded-process";
import { canonicalDigest, withSelfDigest, writeProtectedJsonNoReplace } from "./release-evidence";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = join(repository, "scripts/deletion-backend-acceptance.ts");
const fixturePath = "scripts/deletion-backend-acceptance/fixture.ts";
export const backendPin = Object.freeze({
  release: "precompiled-2026-09-11-157eb19",
  platform: "darwin",
  architecture: "arm64",
  sha256: "8ec1d2cfc749400444bffe243cafb13578db898fd81f623e725962b88bbf5679",
  archiveSha256: "a61d352b0501ac6e0e56c25efc2a1e6a2a59a28076ef1168e042317946653641",
});
const maximumRunMs = 60 * 60 * 1_000;
const maximumOutputBytes = 8 * 1_024 * 1_024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const naturalSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const fileSchema = z.object({ path: z.string().min(1).max(512), bytes: naturalSchema,
  sha256: digestSchema }).strict();
const manifestSchema = z.array(fileSchema).min(1).max(10_000);
const absolutePathSchema = z.string().min(1).max(4_096).refine((path) =>
  isAbsolute(path) && resolve(path) === path && !path.split("").some((char) => (char.codePointAt(0) ?? 0) < 32 || (char.codePointAt(0) ?? 0) === 127));
const optionsSchema = z.object({ backendBinary: absolutePathSchema,
  backendSha256: z.literal(backendPin.sha256), evidencePath: absolutePathSchema }).strict();
export type DeletionBackendOptions = z.infer<typeof optionsSchema>;
const workerInputSchema = z.object({ schemaVersion: z.literal(1),
  root: z.string().regex(/^\/private\/tmp\/oompa-deletion-backend-[a-zA-Z0-9]{6}$/u),
  runId: z.string().uuid(), backendBinary: absolutePathSchema,
  backendSha256: z.literal(backendPin.sha256), production: manifestSchema,
  fixtureSha256: digestSchema, cliSha256: digestSchema,
}).strict();
type WorkerInput = z.infer<typeof workerInputSchema>;
const safeFailure = (): Error => new Error("DELETION_BACKEND_ACCEPTANCE_REFUSED");
type AdminAuthCapability = { setAdminAuth: (token: string, identity?: Readonly<Record<string, string>>) => void };
const hasAdminAuth = (value: unknown): value is AdminAuthCapability => typeof value === "object"
  && value !== null && "setAdminAuth" in value && typeof value.setAdminAuth === "function";
const setAdminAuth = (client: ConvexHttpClient, token: string, identity?: Readonly<Record<string, string>>): void => {
  if (!hasAdminAuth(client)) throw safeFailure();
  client.setAdminAuth(token, identity);
};

const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

export function parseDeletionBackendAdminKey(output: string, instanceName: string): string {
  if (!/^oompa-qualification-[a-f0-9]{16}$/u.test(instanceName)
    || output.length > 512 || !/^[\x21-\x7e]+(?:\r?\n)?$/u.test(output)) throw safeFailure();
  const key = output.trimEnd();
  const prefix = `${instanceName}|`;
  if (!key.startsWith(prefix) || !/^[a-f0-9]{32,256}$/u.test(key.slice(prefix.length))) throw safeFailure();
  return key;
}

export function parseDeletionBackendArguments(args: readonly string[]): DeletionBackendOptions {
  if (args.length !== 6) throw safeFailure();
  const entries = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (key === undefined || value === undefined || entries.has(key)
      || !["--backend-binary", "--backend-sha256", "--evidence-path"].includes(key)) throw safeFailure();
    entries.set(key, value);
  }
  const parsed = optionsSchema.parse({ backendBinary: entries.get("--backend-binary"),
    backendSha256: entries.get("--backend-sha256"), evidencePath: entries.get("--evidence-path") });
  if (basename(parsed.backendBinary) !== "convex-local-backend") throw safeFailure();
  return parsed;
}

/** Only imports in the scripts-only fixture change. Production bytes are copied verbatim. */
export function rewriteDeletionFixture(source: string): string {
  if (source.length > 512 * 1_024 || source.includes("deletionQualificationFixture")) throw safeFailure();
  const rewritten = source.replace(/(["'])\.\.\/\.\.\/convex\//gu, "$1./")
    .replace(/(["'])\.\.\/\.\.\/src\//gu, "$1../src/");
  if (rewritten === source || /["']\.\.\/\.\.\//u.test(rewritten)) throw safeFailure();
  return rewritten;
}

function readStable(path: string, maximumBytes = 8 * 1_024 * 1_024): Buffer {
  if (realpathSync(path) !== path) throw safeFailure();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maximumBytes || before.nlink !== 1) throw safeFailure();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) throw safeFailure();
      offset += count;
    }
    for (const after of [fstatSync(fd), lstatSync(path)]) {
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw safeFailure();
    }
    return bytes;
  } finally { closeSync(fd); }
}

export function captureDeletionProductionManifest(root: string, overlaySha256?: string): z.infer<typeof manifestSchema> {
  const paths = ["bun.lock", "package.json", "convex.json"];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (path === "convex/deletionQualificationFixture.ts" && overlaySha256 !== undefined) {
        if (hash(readStable(join(root, path))) !== overlaySha256) throw safeFailure();
        continue;
      }
      if (entry.isSymbolicLink()) throw safeFailure();
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && !entry.name.endsWith(".test.ts") && entry.name !== "AGENTS.md") paths.push(path);
      else if (!entry.isFile()) throw safeFailure();
      if (paths.length > 10_000) throw safeFailure();
    }
  };
  visit("convex");
  visit("src");
  if (paths.includes("convex/deletionQualificationFixture.ts")) throw safeFailure();
  let totalBytes = 0;
  return manifestSchema.parse(paths.sort().map((path) => {
    const bytes = readStable(join(root, path));
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1_024 * 1_024) throw safeFailure();
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  }));
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || !stat.isDirectory() || stat.uid !== process.getuid?.()
    || (stat.mode & 0o7777) !== 0o700) throw safeFailure();
}

export function deletionChildEnvironment(root: string): NodeJS.ProcessEnv {
  // No inherited provider, proxy, loader, shell startup or personal config variables.
  return { PATH: `${dirname(realpathSync(process.execPath))}:/usr/bin:/bin:/usr/sbin:/sbin`, TMPDIR: join(root, "tmp"), XDG_CONFIG_HOME: join(root, "home/.config"),
    XDG_CACHE_HOME: join(root, "home/.cache"), LANG: "en_US.UTF-8", CI: "1", CONVEX_OVERRIDE_ACCESS_TOKEN: `oompa-disposable-native-${randomBytes(16).toString("hex")}`,
    CONVEX_PROVISION_HOST: "http://127.0.0.1:9", DISABLE_BEACON: "1", RUST_LOG: "error", NO_COLOR: "1" };
}

const cliRelativePath = "node_modules/convex/dist/cli.bundle.cjs";
const progressSchema = z.object({ schemaVersion: z.literal(1),
  phase: z.enum(["starting", "keygen", "key-parsed", "starting-backend", "backend-ready", "verifying-listeners", "deploying", "initializing-quota", "seeding", "requesting", "checking-status", "seeded", "requested", "draining", "complete"]),
  poll: naturalSchema.max(120) }).strict();
const workerResultSchema = z.object({ schemaVersion: z.literal(1), runId: z.string().uuid(),
  nativeBackend: z.literal(true), productionCronUnchanged: z.literal(true),
  dedicatedComplete: z.literal(true), inlineComplete: z.literal(true),
  abandonedComplete: z.literal(true), witnessUnchanged: z.literal(true),
  serviceBalanced: z.literal(true), wrongCapabilityDenied: z.literal(true),
  disabledAuthorityDenied: z.literal(true), sameKeyReplay: z.literal(true),
  inlineIdentityRecords: z.literal(256), backfillAddedNonIdentityRecords: z.literal(5),
  exactBytesCharged: z.literal(true), subjectNonGrowing: z.literal(true),
  childrenCollected: z.literal(true), polls: naturalSchema.max(120),
  elapsedMs: naturalSchema.max(maximumRunMs),
}).strict();
export const deletionBackendReceiptSchema = z.object({ schemaVersion: z.literal(1),
  kind: z.literal("disposable-native-deletion-backend-acceptance"),
  selfDigest: digestSchema, runId: z.string().uuid(), productionDigest: digestSchema,
  production: manifestSchema, harnessDigest: digestSchema, fixtureSha256: digestSchema,
  cliSha256: digestSchema, backend: z.object({ release: z.literal(backendPin.release),
    platform: z.literal("darwin"), architecture: z.literal("arm64"),
    sha256: z.literal(backendPin.sha256), archiveSha256: z.literal(backendPin.archiveSha256) }).strict(),
  cronsSha256: digestSchema, startedAt: naturalSchema, completedAt: naturalSchema,
  processGroupCollected: z.literal(true), saasLoginQualified: z.literal(false), jwtQualified: z.literal(false),
  result: workerResultSchema,
}).strict().superRefine((value, context) => {
  if (canonicalDigest(value.production) !== value.productionDigest
    || value.production.find((file) => file.path === "convex/crons.ts")?.sha256 !== value.cronsSha256
    || value.runId !== value.result.runId || value.completedAt < value.startedAt) {
    context.addIssue({ code: "custom", message: "deletion_backend_receipt_binding_invalid" });
  }
});

/** Every child remains in the worker's group; only the outer bounded runner owns group recovery. */
function child(executable: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv,
  signal: AbortSignal, input = ""): Readonly<{ process: ChildProcessWithoutNullStreams;
    result: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }> }> {
  signal.throwIfAborted();
  const process = spawn(executable, [...args], { cwd, env, detached: false, shell: false,
    stdio: ["pipe", "pipe", "pipe"] });
  let size = 0;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let overflow = false;
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }>((fulfill, reject) => {
    const abort = (): void => { process.kill("SIGTERM"); };
    signal.addEventListener("abort", abort, { once: true });
    const data = (chunk: Buffer, keep: boolean): void => {
      size += chunk.length;
      if (size > maximumOutputBytes) { overflow = true; abort(); return; }
      if (keep) stdout.push(chunk);
      else stderr.push(chunk);
    };
    process.stdout.on("data", (chunk: Buffer) => data(chunk, true));
    process.stderr.on("data", (chunk: Buffer) => data(chunk, false));
    process.once("error", () => reject(safeFailure()));
    process.once("close", (code, closeSignal) => {
      signal.removeEventListener("abort", abort);
      if (overflow) reject(safeFailure());
      else fulfill({ code, signal: closeSignal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
  // Always observe rejection, including while the backend runs beside CLI setup.
  void result.catch(() => undefined);
  process.stdin.on("error", () => undefined);
  process.stdin.end(input);
  return { process, result };
}

async function withAbortSignal<T>(signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  return await operation(AbortSignal.any([signal, AbortSignal.timeout(30_000)]));
}

export function assertDeletionLoopbackRequest(input: string, origin: string): void {
  const url = new URL(input);
  const target = new URL(origin);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.port === ""
    || url.origin !== target.origin || url.username !== "" || url.password !== ""
    || !["/api/query", "/api/mutation", "/version", "/instance_name"].includes(url.pathname)
    || url.search !== "" || url.hash !== "") throw safeFailure();
}

function loopbackFetch(origin: string, signal: AbortSignal): typeof fetch {
  const guarded: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    assertDeletionLoopbackRequest(url, origin);
    return await withAbortSignal(signal, async (requestSignal) => {
      const response = await fetch(input, { ...init, signal: requestSignal, redirect: "error" });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      if (reader !== undefined) {
        try {
          for (;;) {
            const value = await reader.read();
            if (value.done) break;
            bytes += value.value.length;
            if (bytes > 1_024 * 1_024) throw safeFailure();
            chunks.push(value.value);
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    });
  }, { preconnect: fetch.preconnect });
  return guarded;
}

export function assertDeletionListeners(output: string, pid: number, ports: readonly number[]): void {
  const lines = output.trim().split("\n");
  // lsof's field format always includes a descriptor field for every file,
  // even when -F requests only p and n (see its OUTPUT FOR OTHER PROGRAMS contract).
  if (ports.length !== 2 || lines.length !== 5 || lines[0] !== `p${String(pid)}`
    || !/^f[0-9]{1,10}[rwu]?$/u.test(lines[1] ?? "")
    || !/^f[0-9]{1,10}[rwu]?$/u.test(lines[3] ?? "")
    || lines[1] === lines[3] || !lines[2]?.startsWith("n") || !lines[4]?.startsWith("n")) throw safeFailure();
  const names = [lines[2].slice(1), lines[4].slice(1)].sort();
  if (JSON.stringify(names) !== JSON.stringify(ports.map((port) => `127.0.0.1:${String(port)}`).sort())) throw safeFailure();
}

async function reservePort(): Promise<Readonly<{ port: number; release: () => Promise<void> }>> {
  const server = createServer();
  await new Promise<void>((fulfill, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", fulfill); });
  const address = server.address();
  if (address === null || typeof address === "string") throw safeFailure();
  return { port: address.port, release: async () => await new Promise<void>((fulfill, reject) =>
    server.close((error) => error === undefined ? fulfill() : reject(error))) };
}

async function requireDenied(operation: () => Promise<unknown>, message: string): Promise<void> {
  try { await operation(); } catch (error: unknown) {
    if (error instanceof Error && error.message.includes(message)) return;
    throw safeFailure();
  }
  throw safeFailure();
}

// Fixture result parsers are deliberately independent of the deployed fixture's validators.
const handleSchema = z.object({ kind: z.enum(["dedicated", "inline", "abandoned", "witness"]), authAccountId: z.string().min(1).max(96),
  emailDigest: digestSchema, userId: z.string().min(1).max(96), subjectId: z.string().min(1).max(96),
  authSessionId: z.string().min(1).max(96).nullable(), deviceId: z.string().min(1).max(96).nullable(),
  jobId: z.string().min(24).max(96), statusCapability: z.string().min(43).max(96),
  beforeSubjectBytes: naturalSchema, beforeIdentityRecords: naturalSchema,
  beforeIdentityBytes: naturalSchema, beforeJobBytes: naturalSchema }).strict();
const seedSchema = z.object({ schemaVersion: z.literal(1), dedicated: handleSchema, inline: handleSchema,
  witness: handleSchema, witnessDigest: digestSchema,
  abandoned: handleSchema,
  backfill: z.object({ identityRecordsBefore: z.literal(256), identityRecordsAfter: z.literal(256),
    addedNonIdentityRecords: z.literal(5), exactBytesCharged: z.literal(true), replayUnchanged: z.literal(true) }).strict(),
}).strict();
const observedOwnerSchema = z.object({ phase: z.enum(["active", "disabled", "complete"]),
  ownedRowsRemaining: naturalSchema, identityRecords: naturalSchema,
  paddingConsumed: z.boolean(), subjectNonGrowing: z.boolean(), capacityConsumed: z.boolean() }).strict();
const inspectionSchema = z.object({ schemaVersion: z.literal(1), dedicated: observedOwnerSchema,
  inline: observedOwnerSchema, abandoned: observedOwnerSchema, witnessUnchanged: z.boolean(),
  serviceBalanced: z.boolean(), allOwnedTablesCovered: z.literal(true), inspectedTables: naturalSchema.min(1).max(100),
  completionReceipts: naturalSchema.max(2) }).strict();
const statusSchema = z.object({ category: z.enum(["commands_and_leases", "chunks_and_epochs", "memory_history",
  "session_heads", "usage_and_bindings", "codex_accounts", "device_custody", "devices", "receipts_and_events",
  "auth_tokens_and_verifiers", "auth_sessions", "auth_challenges", "auth_accounts", "user_and_subject", "complete"]),
  createdAt: naturalSchema, updatedAt: naturalSchema, jobId: z.string().min(24).max(96),
  state: z.enum(["pending", "draining", "complete"]) }).strict();
const requestSchema = statusSchema.extend({ replay: z.boolean(), statusCapability: z.string().optional() }).strict();

async function qualificationWorker(input: WorkerInput): Promise<z.infer<typeof workerResultSchema>> {
  privateDirectory(input.root);
  const project = join(input.root, "project");
  const start = Date.now();
  if (hash(readStable(input.backendBinary, 512 * 1_024 * 1_024)) !== input.backendSha256
    || canonicalDigest(captureDeletionProductionManifest(project, input.fixtureSha256)) !== canonicalDigest(input.production)
    || hash(readStable(join(project, "convex/deletionQualificationFixture.ts"))) !== input.fixtureSha256
    || hash(readStable(join(repository, cliRelativePath))) !== input.cliSha256
    || existsSync(join(input.root, "backend.sqlite3"))) throw safeFailure();
  const control = new AbortController();
  const timeout = setTimeout(() => control.abort(), maximumRunMs - 60_000);
  const cancel = (): void => control.abort();
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  let lastPhase: z.infer<typeof progressSchema>["phase"] = "starting";
  let lastStderr: Buffer = Buffer.alloc(0);
  let failureMessage = "";
  let failed = false;
  let backendDiagnostic: { observed: boolean; code: number | null; signal: NodeJS.Signals | null; stderr: Uint8Array } = { observed: false, code: null, signal: null, stderr: Buffer.alloc(0) };
  const progress = (phase: z.infer<typeof progressSchema>["phase"], poll = 0): void => {
    lastPhase = phase;
    writeFileSync(join(input.root, "progress.json"), JSON.stringify(progressSchema.parse({ schemaVersion: 1, phase, poll })), { mode: 0o600 });
  };
  let backend: ReturnType<typeof child> | undefined;
  let activeChild: ReturnType<typeof child> | undefined;
  const env = deletionChildEnvironment(input.root);
  const cli = async (args: readonly string[], cliEnv: NodeJS.ProcessEnv, stdin = ""): Promise<void> => {
    activeChild = child(process.execPath, ["--no-env-file", "--config=/dev/null", join(repository, cliRelativePath), ...args],
      project, cliEnv, control.signal, stdin);
    const result = await activeChild.result;
    activeChild = undefined;
    lastStderr = result.stderr.subarray(0, 32 * 1_024);
    if (result.code !== 0 || result.signal !== null) throw safeFailure();
  };
  try {
    progress("starting");
    progress("keygen");
    const instanceName = `oompa-qualification-${randomBytes(8).toString("hex")}`;
    const instanceSecret = randomBytes(32).toString("hex");
    activeChild = child(input.backendBinary, ["keygen", "admin-key", "--instance-name", instanceName,
      "--instance-secret", instanceSecret], input.root, env, control.signal);
    const key = await activeChild.result;
    activeChild = undefined;
    lastStderr = key.stderr.subarray(0, 32 * 1_024);
    if (key.code !== 0 || key.signal !== null || key.stderr.length !== 0) throw safeFailure();
    const adminKey = parseDeletionBackendAdminKey(key.stdout.toString("utf8"), instanceName);
    progress("key-parsed");
    const apiPort = await reservePort();
    const sitePort = await reservePort();
    const origin = `http://127.0.0.1:${String(apiPort.port)}`;
    const site = `http://127.0.0.1:${String(sitePort.port)}`;
    await Promise.all([apiPort.release(), sitePort.release()]);
    progress("starting-backend");
    backend = child(input.backendBinary, ["--interface", "127.0.0.1", "--port", String(apiPort.port),
      "--site-proxy-port", String(sitePort.port), "--convex-origin", origin, "--convex-site", site,
      "--disable-beacon", "--instance-name", instanceName, "--instance-secret", instanceSecret,
      "--local-storage", join(input.root, "storage"), join(input.root, "backend.sqlite3")], input.root, env, control.signal);
    let backendClosed = false;
    const backendExited = (): boolean => backendClosed;
    void backend.result.then((result) => { backendDiagnostic = { observed: true, code: result.code, signal: result.signal, stderr: result.stderr.subarray(0, 32 * 1_024) }; })
      .finally(() => { backendClosed = true; }).catch(() => undefined);
    const localFetch = loopbackFetch(origin, control.signal);
    for (let attempt = 0; ; attempt += 1) {
      if (backendExited() || attempt >= 30) throw safeFailure();
      try { if ((await localFetch(`${origin}/version`)).ok) break; } catch { control.signal.throwIfAborted(); }
      await delay(1_000, undefined, { signal: control.signal });
    }
    progress("backend-ready");
    const verifyBackend = async (): Promise<void> => {
      const priorPhase = lastPhase;
      progress("verifying-listeners");
      if (backendExited() || backend?.process.pid === undefined) throw safeFailure();
      const response = await localFetch(`${origin}/instance_name`);
      if (!response.ok || await response.text() !== instanceName) throw safeFailure();
      activeChild = child("/usr/sbin/lsof", ["-nP", "-a", "-p", String(backend.process.pid),
        "-iTCP", "-sTCP:LISTEN", "-Fpn"], input.root, env, control.signal);
      const listeners = await activeChild.result;
      activeChild = undefined;
      assertDeletionListeners(listeners.stdout.toString("utf8"), backend.process.pid, [apiPort.port, sitePort.port]);
      if (listeners.code !== 0 || backendExited()) throw safeFailure();
      progress(priorPhase);
    };
    await verifyBackend();
    const cliEnv = { ...env, CONVEX_SELF_HOSTED_URL: origin, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      CONVEX_VERSION_API_ORIGIN: "http://127.0.0.1:9", CONVEX_SITE_URL: site };
    progress("deploying");
    await cli(["env", "set", "OOMPA_DELETION_BACKEND_QUALIFICATION"], cliEnv, "disposable-v1\n");
    await cli(["env", "set", "OOMPA_AUTH_HMAC_SECRET"], cliEnv, `${randomBytes(32).toString("hex")}\n`);
    await cli(["dev", "--once", "--typecheck", "disable", "--codegen", "disable", "--tail-logs", "disable"], cliEnv);
    const admin = new ConvexHttpClient(origin, { logger: false, fetch: localFetch });
    setAdminAuth(admin, adminKey);
    const mutation = (name: string, args: Record<string, Value>): Promise<unknown> => admin.mutation(makeFunctionReference<"mutation", Record<string, Value>, unknown>(name), args);
    const query = (name: string, args: Record<string, Value>): Promise<unknown> => admin.query(makeFunctionReference<"query", Record<string, Value>, unknown>(name), args);
    await verifyBackend();
    progress("initializing-quota");
    const genesis: unknown = await mutation("quota:genesisHardAuthority", {});
    z.object({ enforcement: z.literal("hard") }).strict().parse(genesis);
    await verifyBackend();
    progress("seeding");
    const seeded = seedSchema.parse(await mutation("deletionQualificationFixture:seed", {}));
    progress("seeded");
    const handles: Record<string, Value> = { seed: seeded };
    const inspect = async () => inspectionSchema.parse(await query("deletionQualificationFixture:inspect", handles));
    for (const owner of [seeded.dedicated, seeded.inline]) {
      if (owner.authSessionId === null) throw safeFailure();
      await verifyBackend();
      progress("requesting");
      const acting = new ConvexHttpClient(origin, { logger: false, fetch: localFetch });
      setAdminAuth(acting, adminKey, { subject: `${owner.userId}|${owner.authSessionId}`, issuer: site,
        tokenIdentifier: `${site}|${owner.userId}|${owner.authSessionId}` });
      await acting.query(makeFunctionReference<"query", Record<string, Value>, unknown>("account:current"), {});
      const args = { jobId: owner.jobId, statusCapability: owner.statusCapability };
      const request = makeFunctionReference<"mutation", typeof args, unknown>("accountDeletion:request");
      const first = requestSchema.parse(await acting.mutation(request, args));
      const replay = requestSchema.parse(await acting.mutation(request, args));
      if (first.replay || !replay.replay || first.jobId !== owner.jobId || replay.jobId !== owner.jobId) throw safeFailure();
      await requireDenied(async () => await query("accountDeletion:status", { ...args, statusCapability: randomBytes(32).toString("base64url") }), "Account deletion status is unavailable.");
      await requireDenied(async () => await acting.query(makeFunctionReference<"query", Record<string, Value>, unknown>("account:current"), {}), "Cloud authority is not current.");
    }
    const begun = await inspect();
    if (begun.dedicated.phase !== "disabled" || begun.inline.phase !== "disabled"
      || !begun.dedicated.capacityConsumed || !begun.inline.capacityConsumed || !begun.inline.paddingConsumed
      || !begun.inline.subjectNonGrowing || !begun.witnessUnchanged) throw safeFailure();
    progress("requested");
    let polls = 0;
    progress("checking-status");
    for (;;) {
      if (backendExited() || Date.now() - start >= maximumRunMs - 120_000 || polls >= 116) throw safeFailure();
      const statuses = await Promise.all([seeded.dedicated, seeded.inline].map(async (owner) => statusSchema.parse(
        await query("accountDeletion:status", { jobId: owner.jobId, statusCapability: owner.statusCapability }))));
      const observed = await inspect();
      if (!observed.witnessUnchanged || !observed.serviceBalanced) throw safeFailure();
      if (statuses.every((status) => status.state === "complete")
        && observed.dedicated.phase === "complete" && observed.inline.phase === "complete"
        && observed.dedicated.ownedRowsRemaining === 0 && observed.inline.ownedRowsRemaining === 0
        && observed.abandoned.phase === "complete" && observed.abandoned.ownedRowsRemaining === 0
        && observed.completionReceipts === 2) break;
      polls += 1;
      progress("draining", polls);
      await delay(30_000, undefined, { signal: control.signal });
    }
    // Capability receipt works with all identity and admin authentication cleared.
    const anonymous = new ConvexHttpClient(origin, { logger: false, fetch: localFetch });
    for (const owner of [seeded.dedicated, seeded.inline]) {
      const args = { jobId: owner.jobId, statusCapability: owner.statusCapability };
      const ref = makeFunctionReference<"query", typeof args, unknown>("accountDeletion:status");
      for (let repetition = 0; repetition < 2; repetition += 1) {
        const status = statusSchema.parse(await anonymous.query(ref, args));
        if (status.state !== "complete" || status.jobId !== owner.jobId) throw safeFailure();
      }
      await requireDenied(async () => await anonymous.query(ref, {
        ...args, statusCapability: randomBytes(32).toString("base64url"),
      }), "Account deletion status is unavailable.");
    }
    await verifyBackend();
    backend.process.kill("SIGTERM");
    await backend.result;
    backend = undefined;
    progress("complete", polls);
    return workerResultSchema.parse({ schemaVersion: 1, runId: input.runId,
      nativeBackend: true, productionCronUnchanged: true, dedicatedComplete: true, inlineComplete: true,
      abandonedComplete: true, witnessUnchanged: true, serviceBalanced: true, wrongCapabilityDenied: true,
      disabledAuthorityDenied: true, sameKeyReplay: true, inlineIdentityRecords: 256,
      backfillAddedNonIdentityRecords: 5, exactBytesCharged: true, subjectNonGrowing: true,
      childrenCollected: true, polls, elapsedMs: Date.now() - start });
  } catch (error: unknown) {
    failed = true;
    failureMessage = (error instanceof Error ? error.message : "unknown_failure").slice(0, 4_096);
    throw safeFailure();
  } finally {
    clearTimeout(timeout);
    control.abort();
    await Promise.allSettled([activeChild?.result, backend?.result]);
    if (failed) {
      try { writeFileSync(join(input.root, "worker-failure.json"), JSON.stringify({ schemaVersion: 1, phase: lastPhase, error: failureMessage,
        stderr: Buffer.from(lastStderr).toString("utf8").slice(0, 32 * 1_024),
        backend: { observed: backendDiagnostic.observed, code: backendDiagnostic.code, signal: backendDiagnostic.signal,
          stderr: Buffer.from(backendDiagnostic.stderr).toString("utf8").slice(0, 32 * 1_024) } }), { mode: 0o600, flag: "wx" }); }
      catch { /* retain root even if diagnostics cannot be written */ }
    }
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
  }
}

export async function runDeletionBackendAcceptance(options: DeletionBackendOptions): Promise<void> {
  optionsSchema.parse(options);
  if (process.platform !== backendPin.platform || process.arch !== backendPin.architecture
    || Bun.version !== "1.3.14" || existsSync(options.evidencePath)) throw safeFailure();
  const production = captureDeletionProductionManifest(repository);
  const fixture = rewriteDeletionFixture(readStable(join(repository, fixturePath)).toString("utf8"));
  if (hash(readStable(options.backendBinary, 512 * 1_024 * 1_024)) !== options.backendSha256) throw safeFailure();
  const root = mkdtempSync("/private/tmp/oompa-deletion-backend-");
  chmodSync(root, 0o700);
  const initial = lstatSync(root);
  const startedAt = Date.now();
  const project = join(root, "project");
  const runId = randomUUID();
  let success = false;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  try {
    for (const path of [project, join(root, "home"), join(root, "tmp")]) mkdirSync(path, { mode: 0o700 });
    for (const file of production) {
      const destination = join(project, file.path);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      copyFileSync(join(repository, file.path), destination, constants.COPYFILE_EXCL);
    }
    writeFileSync(join(project, "convex/deletionQualificationFixture.ts"), fixture, { mode: 0o600, flag: "wx" });
    symlinkSync(join(repository, "node_modules"), join(project, "node_modules"), "dir");
    const input = workerInputSchema.parse({ schemaVersion: 1, root, runId,
      backendBinary: options.backendBinary, backendSha256: options.backendSha256, production,
      fixtureSha256: hash(fixture), cliSha256: hash(readStable(join(repository, cliRelativePath))) });
    const harnessDigest = canonicalDigest([scriptPath, join(repository, fixturePath), join(repository, "scripts/bounded-process.ts")]
      .map((path) => ({ path: relative(repository, path), sha256: hash(readStable(path)) })));
    writeFileSync(join(root, "intent.json"), JSON.stringify({ schemaVersion: 1, runId, startedAt,
      productionDigest: canonicalDigest(production), harnessDigest }), { mode: 0o600, flag: "wx" });
    console.error(JSON.stringify({ kind: "deletion-backend-started", runId, recoveryRoot: root }));
    progressTimer = setInterval(() => {
      try { console.error(JSON.stringify(progressSchema.parse(JSON.parse(readStable(join(root, "progress.json"), 4_096).toString("utf8"))))); }
      catch { /* An absent or mid-write progress frame grants no evidence. */ }
    }, 30_000);
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    let result;
    try {
      result = await runBoundedProcess({ containment: "local", executable: realpathSync(process.execPath),
        arguments: ["--no-env-file", "--config=/dev/null", scriptPath, "--worker"], cwd: root,
        environment: deletionChildEnvironment(root), stdin: JSON.stringify(input), signal: controller.signal,
        outputMaximumBytes: 64 * 1_024, phase: "deletion-backend-acceptance", timeoutMs: maximumRunMs,
        terminationGraceMs: 15_000, killSettlementMs: 15_000, captureLocalDiagnostics: true });
    } finally { process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort); }
    if (result.cleanup !== "proven" || result.exitCode !== 0) {
      writeFileSync(join(root, "recovery.json"), JSON.stringify({ schemaVersion: 1, runId,
        cleanup: result.cleanup, ...(result.cleanup === "unproven" ? { recoveryPath: result.recoveryPath }
          : { exitCode: result.exitCode, diagnostics: result.localDiagnostics }) }), { mode: 0o600, flag: "wx" });
      throw safeFailure();
    }
    if (result.localDiagnostics?.closeGroup !== "absent") throw safeFailure();
    const workerResult = workerResultSchema.parse(JSON.parse(result.stdout.toString("utf8")));
    if (canonicalDigest(captureDeletionProductionManifest(repository)) !== canonicalDigest(production)) throw safeFailure();
    const crons = production.find((file) => file.path === "convex/crons.ts");
    if (crons === undefined) throw safeFailure();
    const receipt = deletionBackendReceiptSchema.parse(withSelfDigest({ schemaVersion: 1,
      kind: "disposable-native-deletion-backend-acceptance", runId, productionDigest: canonicalDigest(production),
      production, harnessDigest, fixtureSha256: input.fixtureSha256, cliSha256: input.cliSha256,
      backend: backendPin, cronsSha256: crons.sha256, startedAt, completedAt: Date.now(),
      processGroupCollected: true, saasLoginQualified: false, jwtQualified: false, result: workerResult }));
    clearInterval(progressTimer);
    progressTimer = undefined;
    privateDirectory(root);
    const final = lstatSync(root);
    if (initial.dev !== final.dev || initial.ino !== final.ino) throw safeFailure();
    writeFileSync(join(root, "completed.json"), JSON.stringify({ schemaVersion: 1, runId,
      evidenceDigest: receipt.selfDigest, processGroupCollected: true, scratchRetained: true }),
    { mode: 0o600, flag: "wx" });
    writeProtectedJsonNoReplace(options.evidencePath, receipt, deletionBackendReceiptSchema);
    success = true;
    console.log(JSON.stringify({ status: "passed", evidencePath: options.evidencePath,
      evidenceDigest: receipt.selfDigest, productionDigest: receipt.productionDigest,
      scratchRetained: true, recoveryRoot: root }));
  } finally {
    if (progressTimer !== undefined) clearInterval(progressTimer);
    if (!success) {
      try {
        privateDirectory(root);
        const retained = lstatSync(root);
        if (initial.dev === retained.dev && initial.ino === retained.ino
          && !existsSync(join(root, "recovery.json"))) {
          writeFileSync(join(root, "recovery.json"), JSON.stringify({ schemaVersion: 1, runId,
            cleanup: "not_admitted_or_uncertain", action: "inspect_retained_state_before_retry" }), { mode: 0o600, flag: "wx" });
        }
      } catch { /* A changed or unavailable root never authorizes another write. */ }
      console.error(JSON.stringify({ status: "retained", recoveryRoot: root }));
    }
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length === 3 && process.argv[2] === "--worker") {
      const raw = await Bun.stdin.text();
      if (raw.length > 2 * 1_024 * 1_024) throw safeFailure();
      console.log(JSON.stringify(await qualificationWorker(workerInputSchema.parse(JSON.parse(raw)))));
    } else await runDeletionBackendAcceptance(parseDeletionBackendArguments(process.argv.slice(2)));
  } catch {
    console.error("DELETION_BACKEND_ACCEPTANCE_REFUSED");
    process.exitCode = 1;
  }
}
