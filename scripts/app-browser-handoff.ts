import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, linkSync, openSync, realpathSync, writeFileSync, type Stats } from "node:fs";
import { link, lstat, open, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const BROWSER_NODE_VERSION = "24.18.1";
export const BROWSER_BUN_VERSION = "1.3.14";
export const browserDigest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export type BrowserFile = Readonly<{ path: string; bytes: number; sha256: string; identity: readonly number[] }>;
export type BrowserExecutable = Readonly<{ path: string; sha256: string }>;
export type BrowserRequest = Readonly<{
  schemaVersion: 1; kind: "hra-browser-preparation-request"; root: string; run: string;
  node: BrowserExecutable; bun: BrowserExecutable; chromium: BrowserExecutable;
  sources: readonly BrowserFile[]; app: readonly BrowserFile[]; site: readonly BrowserFile[];
}>;
export type BrowserPrepared = Readonly<{
  schemaVersion: 1; kind: "hra-browser-prepared"; requestSha256: string;
  buildRuntime: Readonly<{ name: "bun"; version: "1.3.14"; executable: BrowserExecutable }>;
  driver: BrowserFile; fixture: readonly BrowserFile[];
}>;
export type BrowserHandoff = Readonly<{ request: BrowserRequest; prepared: BrowserPrepared }>;
export type BrowserExecutionEvidence = Readonly<{
  schemaVersion: 1; kind: "oompa-browser-execution-admission"; root: string; run: string;
  requestSha256: string; preparedSha256: string; producerDriver: BrowserFile; executionDriver: BrowserFile;
}>;
/** This in-memory capability belongs to the Node bootstrap. A serialized copy
 * is evidence only: it cannot authorize execution or establish a new baseline. */
export type BrowserExecutionAdmission = Readonly<{
  evidence: BrowserExecutionEvidence;
  verify: (this: BrowserExecutionAdmission, admission: BrowserExecutionAdmission, root: string, run: string) => Promise<BrowserHandoff>;
}>;

const fileIdentity = (value: Stats): readonly number[] => [value.dev, value.ino, value.mode, value.nlink, value.size, value.mtimeMs, value.ctimeMs];
const namePattern = /^[A-Za-z0-9_.[\]-]+$/u;
function object(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "Invalid browser handoff object");
  assert.ok(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected browser handoff fields");
}
function sha(value: unknown): string { assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)); return value; }
function physical(value: unknown): string {
  assert.ok(typeof value === "string" && value.length <= 4096 && isAbsolute(value) && resolve(value) === value);
  assert.ok(!Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
  return value;
}
export function browserLogicalPath(value: unknown): string {
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 1024);
  assert.ok(value.split("/").length <= 14 && value.split("/").every((part) => namePattern.test(part) && part !== "." && part !== ".."));
  return value;
}
function executable(value: unknown): BrowserExecutable {
  const item = object(value); keys(item, ["path", "sha256"]);
  return { path: physical(item.path), sha256: sha(item.sha256) };
}
function file(value: unknown): BrowserFile {
  const item = object(value); keys(item, ["path", "bytes", "sha256", "identity"]);
  assert.ok(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 64 * 1024 * 1024);
  assert.ok(Array.isArray(item.identity) && item.identity.length === 7 && item.identity.every((part: unknown) => typeof part === "number" && Number.isFinite(part) && part >= 0));
  return { path: browserLogicalPath(item.path), bytes: item.bytes, sha256: sha(item.sha256), identity: item.identity as number[] };
}
function files(value: unknown): readonly BrowserFile[] {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= 4096);
  const result = value.map(file);
  assert.deepEqual(result.map(({ path }) => path), [...new Set(result.map(({ path }) => path))].sort());
  assert.ok(result.reduce((sum, row) => sum + row.bytes, 0) <= 256 * 1024 * 1024);
  return result;
}
export function parseBrowserRequest(value: unknown): BrowserRequest {
  const item = object(value); keys(item, ["schemaVersion", "kind", "root", "run", "node", "bun", "chromium", "sources", "app", "site"]);
  assert.equal(item.schemaVersion, 1); assert.equal(item.kind, "hra-browser-preparation-request");
  const root = physical(item.root), run = physical(item.run);
  assert.equal(dirname(run), join(root, "tmp"));
  assert.match(run.slice(dirname(run).length + 1), /^app-browser-[A-Za-z0-9]+$/u);
  return { schemaVersion: 1, kind: "hra-browser-preparation-request", root, run, node: executable(item.node), bun: executable(item.bun),
    chromium: executable(item.chromium), sources: files(item.sources), app: files(item.app), site: files(item.site) };
}
export function parseBrowserPrepared(value: unknown): BrowserPrepared {
  const item = object(value); keys(item, ["schemaVersion", "kind", "requestSha256", "buildRuntime", "driver", "fixture"]);
  assert.equal(item.schemaVersion, 1); assert.equal(item.kind, "hra-browser-prepared");
  const runtime = object(item.buildRuntime); keys(runtime, ["name", "version", "executable"]);
  assert.equal(runtime.name, "bun"); assert.equal(runtime.version, BROWSER_BUN_VERSION);
  const driver = file(item.driver); assert.equal(driver.path, "driver.mjs");
  return { schemaVersion: 1, kind: "hra-browser-prepared", requestSha256: sha(item.requestSha256),
    buildRuntime: { name: "bun", version: "1.3.14", executable: executable(runtime.executable) }, driver, fixture: files(item.fixture) };
}

/** Exact-size sentinel read; no-follow/nonblocking admission precedes allocation. */
export async function readBrowserFile(path: string, cap = 64 * 1024 * 1024): Promise<Buffer> {
  // A regular leaf may have several hardlink names. Canonicalize its parent;
  // no-follow admission and exact identities below guard the selected leaf.
  const parent = dirname(path);
  assert.equal(await realpath(parent), resolve(parent), "Browser handoff input parent must be physical");
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= cap, "Unsafe browser handoff input");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.deepEqual(fileIdentity(await handle.stat()), fileIdentity(before));
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    assert.equal(offset, before.size, "Browser handoff input changed size");
    assert.deepEqual(fileIdentity(await handle.stat()), fileIdentity(before));
    assert.deepEqual(fileIdentity(await lstat(path)), fileIdentity(before));
    assert.equal(await realpath(parent), resolve(parent));
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}
export async function browserFile(root: string, path: string): Promise<BrowserFile> {
  browserLogicalPath(path);
  const absolute = join(root, path), before = await lstat(absolute), bytes = await readBrowserFile(absolute);
  assert.deepEqual(fileIdentity(await lstat(absolute)), fileIdentity(before));
  return { path, bytes: bytes.length, sha256: browserDigest(bytes), identity: fileIdentity(before) };
}
export async function browserInventory(directory: string): Promise<readonly BrowserFile[]> {
  const result: BrowserFile[] = []; let total = 0, entries = 0;
  async function walk(path: string, prefix: string): Promise<void> {
    assert.equal(await realpath(path), resolve(path));
    const before = await lstat(path); assert.ok(before.isDirectory() && !before.isSymbolicLink());
    for (const entry of await readdir(path, { withFileTypes: true })) {
      assert.ok(++entries <= 8192 && !entry.isSymbolicLink());
      const key = browserLogicalPath(prefix === "" ? entry.name : `${prefix}/${entry.name}`);
      if (entry.isDirectory()) await walk(join(path, entry.name), key);
      else { const row = await browserFile(directory, key); result.push(row); total += row.bytes; assert.ok(result.length <= 4096 && total <= 256 * 1024 * 1024); }
    }
    assert.deepEqual(fileIdentity(await lstat(path)), fileIdentity(before));
  }
  await walk(directory, "");
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
export const browserPublicArtifacts = (rows: readonly BrowserFile[]) => rows.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
export async function verifyBrowserInventory(directory: string, expected: readonly BrowserFile[]): Promise<void> {
  assert.deepEqual(await browserInventory(directory), expected, "Browser handoff artifact identity changed");
}
export async function browserExecutable(path: string): Promise<BrowserExecutable> {
  const physicalPath = await realpath(physical(path));
  const before = await lstat(physicalPath);
  assert.ok(before.isFile() && (before.mode & 0o111) !== 0 && before.size > 0 && before.size <= 1024 * 1024 * 1024);
  const handle = await open(physicalPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.deepEqual(fileIdentity(await handle.stat()), fileIdentity(before));
    const buffer = Buffer.alloc(1024 * 1024), hash = createHash("sha256"); let position = 0;
    for (;;) {
      const next = await handle.read(buffer, 0, Math.min(buffer.length, before.size - position + 1), position);
      if (next.bytesRead === 0) break;
      position += next.bytesRead; assert.ok(position <= before.size); hash.update(buffer.subarray(0, next.bytesRead));
    }
    assert.equal(position, before.size);
    assert.deepEqual(fileIdentity(await handle.stat()), fileIdentity(before));
    assert.deepEqual(fileIdentity(await lstat(physicalPath)), fileIdentity(before));
    assert.equal(await realpath(path), physicalPath);
    return { path: physicalPath, sha256: hash.digest("hex") };
  } finally { await handle.close(); }
}

/** Publish complete durable bytes under a write-once final name. The staging
 * alias stays retained: removing it would change nlink/ctime under readers. */
export async function publishBrowserJson(path: string, value: unknown): Promise<void> {
  const parent = dirname(path); assert.equal(await realpath(parent), parent);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  assert.ok(bytes.length <= 16 * 1024 * 1024);
  const staged = join(parent, `.browser-record-${randomUUID()}`);
  const handle = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await link(staged, path);
  const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await directory.sync(); } finally { await directory.close(); }
}

/** Terminal publication has no asynchronous gap between the final cancellation
 * decision and durable publication. Call only after every owned task drained. */
export function publishBrowserTerminalJson(path: string, value: unknown): void {
  const parent = dirname(path); assert.equal(realpathSync(parent), parent);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); assert.ok(bytes.length <= 16 * 1024 * 1024);
  const staged = join(parent, `.browser-record-${randomUUID()}`);
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  linkSync(staged, path);
  const directory = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

const sourceFiles = [
  "package.json", "bun.lock", "app/index.html", "app/vercel.json", "app/vite.config.ts", "vercel.json",
  "site/product-scenes.ts",
  "scripts/build-app.ts", "scripts/build-appearance.ts", "scripts/app-source-marker.ts", "src/install-normalizer.ts",
  "scripts/app-browser.ts", "scripts/app-browser-server.ts", "scripts/app-browser-handoff.ts", "scripts/app-browser-settlement.ts",
  "scripts/site-css-resources.ts", "scripts/marketing-preset.ts",
  "scripts/app-browser-runner.ts", "scripts/app-browser-runner.mjs", "scripts/prepare-app-browser.ts",
] as const;
export async function browserSources(root: string): Promise<readonly BrowserFile[]> {
  const result = await Promise.all(sourceFiles.map((path) => browserFile(root, path)));
  for (const prefix of ["app/src", "app/fixtures/browser", "app/fixtures/product", "site/vendor/marketing-preset", "site/vendor/lantern-material"]) {
    for (const row of await browserInventory(join(root, prefix))) result.push({ ...row, path: `${prefix}/${row.path}` });
  }
  return files(result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
export async function verifyBrowserRequest(request: BrowserRequest): Promise<void> {
  assert.equal(await realpath(request.root), request.root); assert.equal(await realpath(request.run), request.run);
  assert.deepEqual(await browserSources(request.root), request.sources, "Browser source or lock inputs changed");
  await verifyBrowserInventory(join(request.root, "app/dist"), request.app);
  await verifyBrowserInventory(join(request.root, "dist/site"), request.site);
  for (const identity of [request.node, request.bun, request.chromium]) assert.deepEqual(await browserExecutable(identity.path), identity, "Browser toolchain identity changed");
}
export function assertBrowserNode(versions: Readonly<{ node: string; bun?: string }>): void {
  assert.equal(versions.bun, undefined, "Browser driver requires genuine Node");
  assert.equal(versions.node, BROWSER_NODE_VERSION, "Browser driver requires the pinned Node version");
}
async function readBrowserPreparedInputs(root: string, run: string): Promise<BrowserHandoff> {
  const bytes = await readBrowserFile(join(run, "request.json"), 16 * 1024 * 1024);
  const request = parseBrowserRequest(JSON.parse(bytes.toString("utf8")) as unknown);
  assert.equal(request.root, root); assert.equal(request.run, run);
  const prepared = parseBrowserPrepared(JSON.parse((await readBrowserFile(join(run, "prepared.json"), 16 * 1024 * 1024)).toString("utf8")) as unknown);
  assert.equal(prepared.requestSha256, browserDigest(bytes)); assert.deepEqual(prepared.buildRuntime.executable, request.bun);
  await verifyBrowserRequest(request);
  await verifyBrowserInventory(join(run, "fixture/oompa-app"), prepared.fixture);
  return { request, prepared };
}
/** Producer-bound reads retain their original strict seven-field contract. */
export async function readBrowserPrepared(root: string, run: string): Promise<BrowserHandoff> {
  const handoff = await readBrowserPreparedInputs(root, run);
  assert.deepEqual(await browserFile(run, "driver.mjs"), handoff.prepared.driver);
  return handoff;
}

/** The sole phase transition is from a collected compiler output to Node's
 * first execution observation. Content and all non-ctime identity fields must
 * match; a change during that observation is still rejected by browserFile. */
export function assertBrowserDriverAdmission(producer: BrowserFile, observed: BrowserFile): void {
  for (const value of [producer, observed]) {
    file(value);
    assert.equal(value.path, "driver.mjs");
    assert.ok(value.bytes > 0 && value.bytes <= 4 * 1024 * 1024);
    assert.equal(value.identity[4], value.bytes);
  }
  assert.deepEqual({ ...observed, identity: observed.identity.slice(0, 6) },
    { ...producer, identity: producer.identity.slice(0, 6) }, "Browser driver changed before execution admission");
}

function freezeBrowserSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeBrowserSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

type BrowserAdmissionOperations = Readonly<{
  readHandoff: () => Promise<BrowserHandoff>;
  readDriver: () => Promise<BrowserFile>;
}>;

/** One controller per fresh bootstrap run. The operations seam permits pure
 * phase tests; production uses the same bounded descriptor reads throughout.
 * The verifier closes over this module instance so the separately bundled
 * driver cannot deserialize, copy or accidentally re-admit its authority. */
export function createBrowserAdmissionController(root: string, run: string, signal: AbortSignal,
  operations: BrowserAdmissionOperations = {
    readHandoff: () => readBrowserPreparedInputs(root, run),
    readDriver: () => browserFile(run, "driver.mjs"),
  }): Readonly<{
    admit: (preparationCollected: boolean) => Promise<BrowserExecutionAdmission>;
    claim: (admission: BrowserExecutionAdmission) => void;
  }> {
  physical(root); physical(run);
  let phase: "waiting" | "admitting" | "admitted" | "claimed" | "failed" = "waiting";
  let admission: BrowserExecutionAdmission | undefined;
  let snapshot: BrowserHandoff | undefined;
  let verifying = false;
  const assertAuthority = (candidate: BrowserExecutionAdmission) => {
    assert.ok(admission !== undefined && candidate === admission, "Foreign browser execution admission");
    assert.ok(Object.isFrozen(candidate) && Object.isFrozen(candidate.evidence), "Mutable browser execution admission");
  };
  const assertReady = () => assert.ok(!signal.aborted, "Browser acceptance cancelled before driver admission");
  return Object.freeze({
    admit: async (preparationCollected: boolean) => {
      assert.equal(phase, "waiting", "Browser execution admission was already attempted");
      phase = "admitting";
      try {
        assertReady(); assert.equal(preparationCollected, true, "Browser preparation has not been collected");
        const observed = await operations.readHandoff();
        snapshot = freezeBrowserSnapshot(structuredClone({ request: parseBrowserRequest(observed.request), prepared: parseBrowserPrepared(observed.prepared) }));
        assert.equal(snapshot.request.root, root); assert.equal(snapshot.request.run, run);
        assert.deepEqual(snapshot.prepared.buildRuntime.executable, snapshot.request.bun);
        assertReady();
        const executionDriver = freezeBrowserSnapshot(structuredClone(await operations.readDriver()));
        assertBrowserDriverAdmission(snapshot.prepared.driver, executionDriver);
        // Never recapture after the first Node observation. These full checks
        // also close cancellation and input-change gaps before returning it.
        assert.deepEqual(await operations.readHandoff(), snapshot, "Browser preparation changed during execution admission");
        assert.deepEqual(await operations.readDriver(), executionDriver, "Browser driver changed during execution admission");
        assertReady();
        const evidence: BrowserExecutionEvidence = freezeBrowserSnapshot({
          schemaVersion: 1, kind: "oompa-browser-execution-admission", root, run,
          requestSha256: snapshot.prepared.requestSha256, preparedSha256: browserDigest(JSON.stringify(snapshot.prepared)),
          producerDriver: snapshot.prepared.driver, executionDriver,
        });
        admission = Object.freeze({
          evidence,
          verify: async function (this: BrowserExecutionAdmission, candidate: BrowserExecutionAdmission, expectedRoot: string, expectedRun: string) {
            assertAuthority(this); assertAuthority(candidate);
            assert.equal(expectedRoot, root); assert.equal(expectedRun, run);
            assert.equal(phase, "claimed", "Browser execution admission is not claimed");
            assert.equal(verifying, false, "Concurrent browser execution verification");
            verifying = true;
            try {
              assert.deepEqual(await operations.readHandoff(), snapshot, "Browser preparation changed after execution admission");
              assert.deepEqual(await operations.readDriver(), executionDriver, "Browser driver changed after execution admission");
              assert.ok(snapshot !== undefined);
              return snapshot;
            } catch (error) { phase = "failed"; throw error; }
            finally { verifying = false; }
          },
        });
        phase = "admitted";
        return admission;
      } catch (error) { phase = "failed"; throw error; }
    },
    claim: (candidate: BrowserExecutionAdmission) => {
      assertAuthority(candidate); assertReady();
      assert.equal(phase, "admitted", "Browser execution admission was already claimed or failed");
      phase = "claimed";
    },
  });
}
