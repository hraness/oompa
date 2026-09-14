import { afterAll, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { z } from "zod";

const files = ["directory-security.h", "directory-security.c", "directory-security.fixture.c", "build-fixture.ps1"] as const;
const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const boundedCount = z.number().int().min(1).max(1_024);
const buildSchema = z.object({
  schema: z.literal(1), source: z.literal("credential_free_win32_build"),
  imageVersion: z.string().regex(/^[0-9.]{1,80}$/u),
  compilerVersion: z.string().regex(/^[0-9. ]{1,80}$/u), compilerSha256: sha,
  toolsVersion: z.string().regex(/^14\.[0-9.]{1,32}$/u),
  sdkVersion: z.string().regex(/^10\.0\.[0-9]+\.0$/u), sdkHeaderSha256: sha,
  executableSha256: sha,
  inputs: z.array(z.object({ path: z.enum(files), bytes: z.number().int().min(1).max(131_072), sha256: sha }).strict())
    .length(files.length).refine((items) => items.every((item, index) => item.path === files[index])),
  compilerExit: z.literal(0), compilerStdoutEof: z.literal(true), compilerStderrEof: z.literal(true),
  outputBytes: z.number().int().nonnegative().max(131_072),
}).strict();
const resultSchema = z.object({
  schema: z.literal(1), source: z.literal("credential_free_win32_fixture"),
  cases: z.literal(18), passed: z.literal(true), cleanup: z.literal("joined"),
  handlesOpened: boundedCount, handlesClosed: boundedCount,
  tokensOpened: boundedCount, tokensClosed: boundedCount, failureLine: z.literal(0),
}).strict().refine((value) => value.handlesOpened === value.handlesClosed && value.tokensOpened === value.tokensClosed);
const refusal = () => new Error("WINDOWS_DIRECTORY_FIXTURE_UNPROVEN");
function parseResult(input: unknown) {
  if (typeof input !== "string" || input.length > 2_048 || Buffer.byteLength(input) > 2_048
    || !input.endsWith("\n") || input.slice(0, -1).includes("\n")) throw refusal();
  return resultSchema.parse(JSON.parse(input) as unknown);
}
const diagnosticCount = z.number().int().nonnegative().max(1_024);
const failureSchema = z.object({
  schema: z.literal(1), source: z.literal("credential_free_win32_fixture"),
  cases: z.number().int().nonnegative().max(18), passed: z.literal(false),
  cleanup: z.enum(["joined", "uncertain"]),
  handlesOpened: diagnosticCount, handlesClosed: diagnosticCount,
  tokensOpened: diagnosticCount, tokensClosed: diagnosticCount,
  failureLine: z.number().int().nonnegative().max(5_000),
}).strict();
function parseFailure(input: unknown) {
  if (typeof input !== "string" || input.length > 2_048 || Buffer.byteLength(input) > 2_048
    || !input.endsWith("\n") || input.slice(0, -1).includes("\n")) return null;
  try {
    const parsed = failureSchema.safeParse(JSON.parse(input) as unknown);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}
type Collected = Readonly<{ eof: boolean; failed: boolean; text: string; bytes: number }>;
type Ended = Readonly<{ code: number | null; signal: NodeJS.Signals | null }>;
function projectFailure(ended: Ended, out: Collected, err: Collected,
    state: Readonly<{ spawnError: boolean; stopAttempted: boolean; deadlineExceeded: boolean }>) {
  const complete = !state.spawnError && !state.stopAttempted && !state.deadlineExceeded
    && ended.signal === null && out.eof && !out.failed && err.eof && !err.failed
    && out.bytes <= 2_048 && err.bytes <= 512 && err.text === "";
  return {
    evidence: "credential_free_windows_directory_failure",
    exitCode: ended.code !== null && Number.isInteger(ended.code) && ended.code >= -2_147_483_648
      && ended.code <= 2_147_483_647 ? ended.code : null,
    signaled: ended.signal !== null, spawnError: state.spawnError,
    stopAttempted: state.stopAttempted, deadlineExceeded: state.deadlineExceeded,
    stdoutEof: out.eof, stdoutFailed: out.failed, stdoutBytesCapped: out.bytes,
    stderrEof: err.eof, stderrFailed: err.failed, stderrBytesCapped: err.bytes,
    // Only the fixture's ordinary failure exit and positively collected streams
    // admit its closed diagnostic fields. This never feeds success admission.
    fixture: complete && ended.code === 70 ? parseFailure(out.text) : null,
    productWindowsQualified: false, providerEffectsQualified: false,
  };
}
async function readBounded(path: string, maximumBytes: number): Promise<Buffer> {
  if (await realpath(path) !== path) throw refusal();
  const handle = await open(path, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maximumBytes) throw refusal();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw refusal();
      offset += read.bytesRead;
    }
    for (const after of [await handle.stat(), await lstat(path)]) {
      if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
        || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw refusal();
    }
    return bytes;
  } finally { await handle.close(); }
}
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function collect(stream: Readable, maximum: number, cancel: () => void) {
  let bytes = 0; let eof = false; let failed = false;
  const chunks: Buffer[] = [];
  return new Promise<Collected>((done) => {
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maximum) { failed = true; cancel(); }
      else chunks.push(Buffer.from(chunk));
    });
    stream.once("error", () => { failed = true; cancel(); });
    stream.once("end", () => { eof = true; });
    stream.once("close", () => done({ eof, failed: failed || !eof,
      text: Buffer.concat(chunks).toString("utf8"), bytes: Math.min(bytes, maximum + 1) }));
  });
}
let closing = false;
function isClosing(): boolean { return closing; }
let owned: ChildProcess | undefined;
let joined: Promise<unknown> | undefined;
let stopAttempted = false;
function stopOwned(): void {
  if (owned === undefined || stopAttempted || owned.exitCode !== null || owned.signalCode !== null) return;
  stopAttempted = true;
  owned.kill(); // Retained fixed child; Windows maps this to process termination.
}
async function bound<T>(value: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([value, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { stopOwned(); reject(refusal()); }, milliseconds);
    })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

const positive = { schema: 1, source: "credential_free_win32_fixture", cases: 18,
  passed: true, cleanup: "joined", handlesOpened: 20, handlesClosed: 20,
  tokensOpened: 30, tokensClosed: 30, failureLine: 0 } as const;
test("Windows result admission requires every native case and exact cleanup counters", () => {
  expect(parseResult(`${JSON.stringify(positive)}\n`)).toEqual(positive);
  for (const changed of [{ cases: 17 }, { passed: false }, { cleanup: "uncertain" }, { failureLine: 1 },
    { handlesClosed: 19 }, { tokensClosed: 29 }, { sid: "synthetic-private-value" }]) {
    expect(() => parseResult(`${JSON.stringify({ ...positive, ...changed })}\n`)).toThrow();
  }
  for (const input of [null, {}, "", JSON.stringify(positive), `${JSON.stringify(positive)}\n\n`, "x".repeat(2_049)]) {
    expect(() => parseResult(input)).toThrow();
  }
});
test("counter mismatch and incomplete native case counts cannot pass by serialization", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 1_024 }).filter((n) => n !== 20), (handlesClosed) => {
    expect(() => parseResult(`${JSON.stringify({ ...positive, handlesClosed })}\n`)).toThrow();
  }), { seed: 20260912, numRuns: 100 });
  fc.assert(fc.property(fc.integer({ min: 0, max: 100 }).filter((n) => n !== 18), (cases) => {
    expect(() => parseResult(`${JSON.stringify({ ...positive, cases })}\n`)).toThrow();
  }), { seed: 20260912, numRuns: 100 });
});

const negative = { ...positive, passed: false, cases: 2, handlesOpened: 0, handlesClosed: 0,
  tokensOpened: 2, tokensClosed: 2, failureLine: 156 } as const;
test("closed fixture failure diagnostics retain counts without admitting success", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 18 }), fc.integer({ min: 0, max: 1_024 }), (cases, handlesClosed) => {
    const value = { ...negative, cases, handlesClosed };
    const text = `${JSON.stringify(value)}\n`;
    expect(parseFailure(text)).toEqual(value);
    expect(() => parseResult(text)).toThrow();
  }), { seed: 20260912, numRuns: 100 });
  const uncertain = { ...negative, cleanup: "uncertain", failureLine: 0 } as const;
  expect(parseFailure(`${JSON.stringify(uncertain)}\n`)).toEqual(uncertain);
});
test("failure diagnostics discard malformed, excess and foreign fields without forwarding text", () => {
  const text = `${JSON.stringify(negative)}\n`;
  for (const input of [null, {}, "", "{\n", text.trimEnd(), `${text}\n`, "x".repeat(2_049),
    `${JSON.stringify(positive)}\n`, `${JSON.stringify({ ...negative, note: "private diagnostic" })}\n`,
    ...[{ cases: -1 }, { cases: 19 }, { handlesOpened: 1_025 }, { tokensClosed: -1 },
      { failureLine: 5_001 }, { failureLine: 1.5 }, { source: "foreign" }, { cleanup: "unknown" }]
      .map((changed) => `${JSON.stringify({ ...negative, ...changed })}\n`)]) {
    expect(parseFailure(input)).toBeNull();
  }
});
test("uncertain child or stream outcomes retain unknown fixture diagnostics", () => {
  const text = `${JSON.stringify(negative)}\n`;
  const out = { eof: true, failed: false, text, bytes: Buffer.byteLength(text) };
  const err = { eof: true, failed: false, text: "", bytes: 0 };
  const ended = { code: 70, signal: null } as const;
  const state = { spawnError: false, stopAttempted: false, deadlineExceeded: false };
  expect(projectFailure(ended, out, err, state).fixture).toEqual(negative);
  for (const changed of [{ spawnError: true }, { stopAttempted: true }, { deadlineExceeded: true }]) {
    expect(projectFailure(ended, out, err, { ...state, ...changed }).fixture).toBeNull();
  }
  for (const changed of [{ eof: false }, { failed: true }, { bytes: 2_049 }]) {
    expect(projectFailure(ended, { ...out, ...changed }, err, state).fixture).toBeNull();
  }
  for (const changed of [{ eof: false }, { failed: true }, { bytes: 513 }, { text: "private stderr" }]) {
    const evidence = projectFailure(ended, out, { ...err, ...changed }, state);
    expect(evidence.fixture).toBeNull();
    expect(JSON.stringify(evidence)).not.toContain("private stderr");
  }
  for (const changed of [{ code: null }, { code: 0 }, { code: 71 }, { signal: "SIGTERM" as const }]) {
    expect(projectFailure({ ...ended, ...changed }, out, err, state).fixture).toBeNull();
  }
  const foreign = `${JSON.stringify({ ...negative, sid: "private identity" })}\n`;
  const evidence = projectFailure(ended, { ...out, text: foreign, bytes: Buffer.byteLength(foreign) }, err, state);
  expect(evidence.fixture).toBeNull();
  expect(JSON.stringify(evidence)).not.toContain("private identity");
  expect(evidence.productWindowsQualified).toBe(false);
  expect(evidence.providerEffectsQualified).toBe(false);
});

test.skipIf(process.env.OOMPA_WINDOWS_DIRECTORY_NATIVE !== "1")("actual Win32 directory handles enforce owner, DACL, reparse and lifetime policy", async () => {
  const deadline = Date.now() + 50_000;
  if (process.platform !== "win32" || process.arch !== "x64" || Bun.version !== "1.3.14"
    || process.env.CI !== "true" || isClosing()) throw refusal();
  const runnerTemp = process.env.RUNNER_TEMP;
  if (runnerTemp === undefined || runnerTemp.length > 180 || !/^[A-Za-z]:\\/u.test(runnerTemp)) throw refusal();
  const directory = join(runnerTemp, "oompa-windows-directory-build");
  const executable = join(directory, "directory-security.fixture.exe");
  const buildBytes = await readBounded(join(directory, "build.json"), 8_192);
  const build = buildSchema.parse(JSON.parse(buildBytes.toString("utf8")) as unknown);
  const before = await readBounded(executable, 8 * 1_024 * 1_024);
  if (digest(before) !== build.executableSha256 || process.env.ImageVersion !== build.imageVersion) throw refusal();
  for (const input of build.inputs) {
    const bytes = await readBounded(resolve(import.meta.dir, input.path), 131_072);
    if (bytes.length !== input.bytes || digest(bytes) !== input.sha256) throw refusal();
  }
  if (isClosing() || Date.now() >= deadline) throw refusal();
  const child = spawn(executable, [], { cwd: directory, stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true, env: { SystemRoot: process.env.SystemRoot, RUNNER_TEMP: runnerTemp,
      OOMPA_WINDOWS_DIRECTORY_NATIVE: "1" } });
  owned = child;
  let spawnError = false;
  const childState = { get spawnError(): boolean { return spawnError; } };
  child.once("error", () => { spawnError = true; });
  const stdout = collect(child.stdout, 2_048, stopOwned);
  const stderr = collect(child.stderr, 512, stopOwned);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) => {
    child.once("close", (code, signal) => done({ code, signal }));
  });
  joined = Promise.all([exit, stdout, stderr]);
  const [ended, out, err] = await bound(Promise.all([exit, stdout, stderr]), Math.min(25_000, deadline - Date.now()));
  if (childState.spawnError || stopAttempted || ended.code !== 0 || ended.signal !== null || !out.eof || out.failed
    || !err.eof || err.failed || err.text !== "" || Date.now() >= deadline) {
    console.info(JSON.stringify(projectFailure(ended, out, err, {
      spawnError: childState.spawnError, stopAttempted, deadlineExceeded: Date.now() >= deadline,
    })));
    throw refusal();
  }
  const result = parseResult(out.text);
  expect(digest(await readBounded(executable, 8 * 1_024 * 1_024))).toBe(build.executableSha256);
  expect(await readBounded(join(directory, "build.json"), 8_192)).toEqual(buildBytes);
  for (const input of build.inputs) {
    const bytes = await readBounded(resolve(import.meta.dir, input.path), 131_072);
    if (bytes.length !== input.bytes || digest(bytes) !== input.sha256) throw refusal();
  }
  if (isClosing() || Date.now() >= deadline) throw refusal();
  console.info(JSON.stringify({ evidence: "credential_free_windows_directory_security", build, result,
    productWindowsQualified: false, providerEffectsQualified: false }));
}, 60_000);

afterAll(async () => {
  closing = true;
  stopOwned();
  if (joined !== undefined) await bound(joined, 5_000);
});
