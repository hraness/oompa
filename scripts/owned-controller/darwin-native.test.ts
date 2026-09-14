import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Readable, Writable } from "node:stream";

import { afterAll, beforeAll, expect, test } from "bun:test";

import { runBoundedProcess } from "../bounded-process";
import {
  createOwnedControllerObservation,
  encodeOwnedControllerFrame,
  observeOwnedController,
  OwnedControllerDecoder,
  ownedControllerDirectChildProof,
  type OwnedControllerBinding,
  type OwnedControllerDeadlines,
  type OwnedControllerEvent,
  type OwnedControllerFrame,
  type OwnedControllerObservation,
} from "./protocol";
import {
  createOwnedControllerTransport,
  observeOwnedControllerTransport,
  ownedControllerTransportProof,
  type OwnedControllerTransportEvent,
  type OwnedControllerTransportLimits,
  type OwnedControllerTransportObservation,
} from "./transport";

const enabled = process.env.OOMPA_OWNED_CONTROLLER_NATIVE === "1";
const nativeTest = test.skipIf(!enabled);
const repository = resolve(import.meta.dir, "../..");
const executeFile = promisify(execFile);
const clock = (): number => Math.floor(performance.now());
const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC" };
const sha256 = async (path: string): Promise<string> => createHash("sha256").update(await readFile(path)).digest("hex");
let root: string | undefined;
let helper: string;
let fixture: string;
let transportFixture: string;
let compilerCleanupUnproven = false;
const owners = new Set<NativeCase>();
const extraFixturePids = new Set<number>();
let joinedExtraDescriptors = 0;

const waitUntil = async (predicate: () => Promise<boolean>, milliseconds = 2_000): Promise<void> => {
  const deadline = performance.now() + milliseconds;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error("owned_controller_fixture_deadline");
    await Bun.sleep(10);
  }
};

const exists = async (path: string): Promise<boolean> => {
  try { return (await lstat(path)).isFile(); }
  catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

/** Observation only. This never signals a PID read from a fixture or a receipt. */
const processStart = async (pid: number): Promise<string | null> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("owned_controller_fixture_pid_invalid");
  try {
    const result = await executeFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      env: environment, timeout: 1_000, maxBuffer: 256,
    });
    const value = result.stdout.trim();
    if (value.length === 0 || value.length > 128) throw new Error("owned_controller_fixture_identity_invalid");
    return value;
  } catch (error: unknown) {
    const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown };
    if (failure.code === 1 && failure.stdout === "" && failure.stderr === "") return null;
    throw new Error("owned_controller_fixture_identity_unproven", { cause: error });
  }
};

const waitGone = async (pid: number, expectedStart: string | null): Promise<void> => {
  await waitUntil(async () => {
    const current = await processStart(pid);
    return current === null || (expectedStart !== null && current !== expectedStart);
  }, 3_000);
};

const compile = async (zig: string, source: string, output: string): Promise<void> => {
  if (root === undefined) throw new Error("owned_controller_build_root_missing");
  compilerCleanupUnproven = true;
  const result = await runBoundedProcess({
    arguments: ["build-exe", "-O", "ReleaseSafe", "-fstrip", "-lc",
      "--cache-dir", join(root, "cache"), "--global-cache-dir", join(root, "global-cache"),
      join(import.meta.dir, source), `-femit-bin=${output}`],
    containment: "local", cwd: repository, environment: { ...environment, XDG_CACHE_HOME: join(root, "user-cache") }, executable: zig,
    outputMaximumBytes: 1024 * 1024, phase: "owned-controller-fixture-build",
    terminationGraceMs: 1_000, killSettlementMs: 1_000, timeoutMs: 60_000,
  }, { recoveryDirectory: join(root, "compiler-recovery") });
  compilerCleanupUnproven = result.cleanup !== "proven";
  if (result.cleanup !== "proven" || result.exitCode !== 0) {
    throw new Error(`owned_controller_fixture_build_failed: ${result.stderr.toString("utf8").slice(0, 4_096)}`);
  }
};

beforeAll(async () => {
  if (!enabled) return;
  if (process.platform !== "darwin") throw new Error("owned_controller_native_requires_darwin");
  const requestedZig = process.env.OOMPA_OWNED_CONTROLLER_ZIG;
  if (requestedZig === undefined || !isAbsolute(requestedZig)) throw new Error("owned_controller_zig_path_required");
  const zig = await realpath(requestedZig);
  const version = await executeFile(zig, ["version"], { env: environment, timeout: 5_000, maxBuffer: 256 });
  if (version.stdout.trim() !== "0.16.0" || version.stderr !== "") throw new Error("owned_controller_zig_version_mismatch");
  root = await realpath(await mkdtemp(join(tmpdir(), "oompa-owned-controller-")));
  await chmod(root, 0o700);
  helper = join(root, "helper");
  fixture = join(root, "fixture");
  transportFixture = join(root, "transport-fixture");
  try {
    await compile(zig, "darwin-helper.zig", helper);
    await compile(zig, "darwin-fixture.zig", fixture);
    await compile(zig, "darwin-transport-fixture.zig", transportFixture);
  } catch (error: unknown) {
    if (!compilerCleanupUnproven) await rm(root, { recursive: true });
    throw new Error(`owned_controller_native_setup_failed; ${compilerCleanupUnproven ? "retained" : "removed"} ${root}`, { cause: error });
  }
  const sources = ["darwin-helper.zig", "darwin-fixture.zig", "darwin-transport-fixture.zig", "darwin-native.test.ts", "protocol.ts", "transport.ts"];
  const sourceHashes = Object.fromEntries(await Promise.all(sources.map(async (source) => [source, await sha256(join(import.meta.dir, source))])));
  console.info(JSON.stringify({
    evidence: "owned_controller_native_provenance", platform: process.platform, architecture: process.arch,
    kernelRelease: release(), bun: Bun.version, zig, zigVersion: version.stdout.trim(), zigSha256: await sha256(zig),
    sourceHashes, helperSha256: await sha256(helper), fixtureSha256: await sha256(fixture), transportFixtureSha256: await sha256(transportFixture), root,
    abi: "native Darwin libc; Zig ReleaseSafe; no provider process or credentials",
  }));
}, 120_000);

class NativeCase {
  readonly binding: OwnedControllerBinding = { nonce: randomBytes(16).toString("hex"), generation: 23 };
  readonly marker: string;
  readonly child: ChildProcessWithoutNullStreams;
  readonly frames: OwnedControllerFrame[] = [];
  readonly closed: Promise<void>;
  readonly #decoder = new OwnedControllerDecoder("helper");
  state: OwnedControllerObservation;
  transport: OwnedControllerTransportObservation | null = null;
  providerStdout = Buffer.alloc(0);
  providerStderr = Buffer.alloc(0);
  transportErrors = 0;
  childPid: number | undefined;
  childStart: string | null = null;
  exitCode: number | null = null;
  stderr = "";
  #failure: unknown;
  #closeSeen = false;
  #goAttempted = false;
  #helperExitSeen = false;
  #providerInputClose: Promise<void> | undefined;
  #cancelling: Promise<void> | undefined;
  readonly #providerOutputFinished = new Set<"stdout" | "stderr">();
  readonly #extraDescriptorClosed = new Set<number>();
  readonly #extraMarkers: readonly string[];

  constructor(name: string, mode: string, deadlines: Partial<OwnedControllerDeadlines> = {}, extraMarkers: readonly string[] = [], transport?: Partial<OwnedControllerTransportLimits>) {
    if (root === undefined) throw new Error("owned_controller_fixture_root_missing");
    this.marker = join(root, `${name}.started`);
    this.#extraMarkers = extraMarkers;
    const bounds = { startupMs: 2_000, runMs: 3_000, shutdownMs: 600, ...deadlines };
    this.state = createOwnedControllerObservation(this.binding, bounds, clock());
    if (transport !== undefined) this.transport = createOwnedControllerTransport(this.binding, bounds, {
      stdinBytes: 1_048_576, stdoutBytes: 1_048_576, stderrBytes: 1_048_576, pendingWrites: 1, pendingBytes: 65_536, ...transport,
    }, clock());
    this.child = spawn(helper, [...(transport === undefined ? [] : ["--transport=stdio-v1"]), "--nonce", this.binding.nonce, "--generation", String(this.binding.generation),
      "--startup-ms", String(bounds.startupMs), "--run-ms", String(bounds.runMs), "--shutdown-ms", String(bounds.shutdownMs),
      "--", transport === undefined ? fixture : transportFixture, mode, this.marker, ...extraMarkers], {
      env: environment, cwd: root, stdio: transport === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    owners.add(this);
    this.child.stdin.on("error", (error: unknown) => { this.fail(error); });
    this.child.stdout.on("error", (error: unknown) => { this.fail(error); });
    this.child.stderr.on("error", (error: unknown) => { this.fail(error); });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const frame of this.#decoder.push(chunk)) {
          this.frames.push(frame);
          this.observe({ kind: "frame", frame });
          if (frame.type === "ready") this.childPid = frame.childPid;
        }
      } catch (error: unknown) {
        this.fail(error);
        this.child.kill("SIGTERM");
      }
    });
    this.child.stdout.on("end", () => {
      try { this.#decoder.finish(); this.observe({ kind: "control_eof" }); }
      catch (error: unknown) { this.fail(error); }
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(0, 4_097);
      if (this.stderr.length > 4_096) {
        this.fail(new Error("owned_controller_fixture_output_overflow"));
        this.child.kill("SIGTERM");
      }
    });
    this.child.on("exit", (code) => { this.#helperExitSeen = true; this.exitCode = code; this.observe({ kind: "helper_exit", code }); });
    this.closed = new Promise((resolveClosed) => {
      this.child.on("error", (error: unknown) => { this.fail(error); });
      this.child.once("close", () => { this.#closeSeen = true; resolveClosed(); });
    });
    if (transport !== undefined) {
      for (const index of [3, 4, 5, 6]) {
        const descriptor = this.descriptor(index);
        if (!(descriptor instanceof Readable) && !(descriptor instanceof Writable)) throw new Error("owned_controller_fixture_descriptor_missing");
        descriptor.once("close", () => { this.#extraDescriptorClosed.add(index); });
      }
      this.providerInput.on("error", () => { this.transportErrors += 1; this.observeTransport({ kind: "input_error" }); });
      for (const channel of ["stdout", "stderr"] as const) {
        const stream = this.providerOutput(channel);
        stream.on("data", (chunk: Buffer) => {
          const maximum = this.transport?.limits[`${channel}Bytes`] ?? 0;
          this.observeTransport({ kind: "output", channel, bytes: chunk.byteLength });
          const current = channel === "stdout" ? this.providerStdout : this.providerStderr;
          // Retain only the configured bounded bytes, even after poisoning.
          if (current.byteLength + chunk.byteLength <= maximum) {
            const next = Buffer.concat([current, chunk]);
            if (channel === "stdout") this.providerStdout = next;
            else this.providerStderr = next;
          } else {
            this.transportErrors += 1;
            void this.cancelTransport().catch((error: unknown) => { this.fail(error); });
          }
        });
        stream.on("end", () => {
          this.#providerOutputFinished.add(channel);
          this.observeTransport({ kind: "output_eof", channel });
        });
        stream.on("error", () => { this.transportErrors += 1; this.observeTransport({ kind: "output_error", channel }); });
        stream.on("close", () => {
          if (!this.#providerOutputFinished.has(channel)) {
            this.transportErrors += 1;
            this.observeTransport({ kind: "output_error", channel });
            this.#providerOutputFinished.add(channel);
          }
        });
      }
      // A seventh caller descriptor verifies closeInherited; it is never a
      // target channel and cannot delay target output closure after helper exit.
      const incidental = this.descriptor(6);
      if (incidental instanceof Readable) incidental.resume();
    }
  }

  observe(event: OwnedControllerEvent): void {
    this.state = observeOwnedController(this.state, event, clock());
    this.observeTransport({ kind: "controller", event });
    if (this.transport !== null && (event.kind === "helper_exit" || event.kind === "frame" && event.frame.type === "terminal")) {
      void this.endProviderInput();
    }
  }

  observeTransport(event: OwnedControllerTransportEvent): void {
    if (this.transport !== null) this.transport = observeOwnedControllerTransport(this.transport, event, clock());
  }

  get providerInput(): Writable {
    const stream = this.descriptor(3);
    if (!(stream instanceof Writable)) throw new Error("owned_controller_fixture_input_missing");
    return stream;
  }

  providerOutput(channel: "stdout" | "stderr"): Readable {
    const stream = this.descriptor(channel === "stdout" ? 4 : 5);
    if (!(stream instanceof Readable)) throw new Error("owned_controller_fixture_output_missing");
    return stream;
  }

  descriptor(index: number): Readable | Writable | null | undefined {
    // Node's static tuple lists only five entries, while spawn accepts more.
    const descriptors: readonly (Readable | Writable | null | undefined)[] = this.child.stdio;
    return descriptors[index];
  }

  async writeProvider(bytes: Buffer): Promise<void> {
    const id = this.transport?.nextWriteId ?? 0;
    this.observeTransport({ kind: "write_started", id, bytes: bytes.byteLength });
    if (this.transport === null || this.transport.phase === "uncertain") throw new Error("owned_controller_fixture_input_refused");
    await new Promise<void>((resolveWrite, reject) => {
      const input = this.providerInput;
      let settled = false;
      const settle = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.off("error", failed);
        input.off("close", failed);
        if (error !== undefined && error !== null) {
          this.transportErrors += 1;
          this.observeTransport({ kind: "input_error" });
          reject(new Error("owned_controller_fixture_input_uncertain"));
        } else {
          this.observeTransport({ kind: "write_settled", id, bytes: bytes.byteLength });
          resolveWrite();
        }
      };
      const failed = (): void => { settle(new Error("owned_controller_fixture_input_unsettled")); };
      // Bun may leave an extra-descriptor write callback outstanding after the
      // peer exits. Expiry is ambiguity, never a fabricated successful write.
      const timer = setTimeout(failed, Math.max(1, this.state.deadlineAt + this.state.deadlines.shutdownMs - clock()));
      input.once("error", failed);
      input.once("close", failed);
      try { input.write(bytes, settle); }
      catch { failed(); }
    });
  }

  endProviderInput(): Promise<void> {
    if (this.#providerInputClose !== undefined) return this.#providerInputClose;
    this.observeTransport({ kind: "input_end" });
    this.#providerInputClose = new Promise<void>((resolveClose) => {
      const input = this.providerInput;
      let settled = false;
      let finished = false;
      const settle = (error?: Error | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.off("error", failed);
        input.off("close", closed);
        if (error !== undefined && error !== null) {
          this.transportErrors += 1;
          this.observeTransport({ kind: "input_error" });
        } else this.observeTransport({ kind: "input_closed" });
        resolveClose();
      };
      const failed = (): void => {
        settle(new Error("owned_controller_fixture_input_close_unsettled"));
        input.destroy();
      };
      const closed = (): void => {
        if (finished) settle();
        else failed();
      };
      const timer = setTimeout(failed, this.state.deadlines.shutdownMs);
      input.once("error", failed);
      input.once("close", closed);
      try {
        input.end((error?: Error | null) => {
          if (settled) return;
          if (error !== undefined && error !== null) { failed(); return; }
          // Writable finish only confirms the write side. Close this exact
          // owned wrapper and wait for its close event before input_closed.
          finished = true;
          input.destroy();
        });
      }
      catch { failed(); }
    });
    return this.#providerInputClose;
  }

  cancelTransport(): Promise<void> {
    if (this.#cancelling !== undefined) return this.#cancelling;
    this.observeTransport({ kind: "cancel" });
    const closing = this.endProviderInput();
    this.#cancelling = (async () => {
      if (!this.#helperExitSeen && this.state.terminal === null && !this.state.termSent) await this.send("term");
      await closing;
    })();
    return this.#cancelling;
  }

  async helperExited(): Promise<void> {
    await waitUntil(async () => { this.observeTransport({ kind: "tick" }); return this.#helperExitSeen; });
  }

  fail(error: unknown): void {
    this.#failure ??= new Error("owned_controller_fixture_stream_failure", { cause: error });
    this.observe({ kind: "protocol_failure" });
  }

  async ready(): Promise<void> {
    await waitUntil(async () => {
      if (this.#failure !== undefined) throw new Error("owned_controller_fixture_failed", { cause: this.#failure });
      if (this.#closeSeen && this.childPid === undefined) throw new Error("owned_controller_fixture_no_ready");
      return this.childPid !== undefined;
    });
    if (this.childPid === undefined) throw new Error("owned_controller_fixture_no_ready");
    this.childStart = await processStart(this.childPid);
    expect(this.childStart).not.toBeNull();
  }

  async send(type: "go" | "term"): Promise<void> {
    if (type === "go") this.#goAttempted = true;
    await this.write(encodeOwnedControllerFrame({ ...this.binding, type }));
    this.observe({ kind: type === "go" ? "go_sent" : "term_sent" });
  }

  async raw(value: string): Promise<void> {
    this.observe({ kind: "protocol_failure" });
    await this.write(value);
  }

  async write(value: string): Promise<void> {
    await new Promise<void>((resolveWrite, reject) => {
      this.child.stdin.write(value, (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          this.fail(error);
          reject(new Error("owned_controller_fixture_send_uncertain", { cause: error }));
        } else resolveWrite();
      });
    });
  }

  async finish(): Promise<void> {
    await waitUntil(async () => {
      this.observeTransport({ kind: "tick" });
      return this.#closeSeen && (this.transport === null || this.#providerOutputFinished.size === 2);
    }, 5_000);
    await this.closed;
    if (this.transport !== null) await this.endProviderInput();
    if (this.#failure !== undefined) throw new Error("owned_controller_fixture_failed", { cause: this.#failure });
    expect(this.stderr).toBe("");
    if (this.childPid !== undefined) await waitGone(this.childPid, this.childStart);
  }

  async collect(): Promise<void> {
    if (this.transport !== null) {
      void this.endProviderInput();
      this.providerOutput("stdout").resume();
      this.providerOutput("stderr").resume();
    }
    if (!this.#closeSeen) {
      this.child.stdin.end();
      if (!this.#helperExitSeen) this.child.kill("SIGTERM");
    }
    await waitUntil(async () => this.#closeSeen && (this.transport === null || this.#providerOutputFinished.size === 2), 5_000);
    if (this.transport !== null) await this.endProviderInput();
    if (this.childPid !== undefined) await waitGone(this.childPid, this.childStart);
    // Only the fixed escape fixture can create one additional child. It has
    // its own finite lifetime; retain the root if its absence is unproven.
    const pidMarker = this.#extraMarkers[0];
    if (pidMarker !== undefined && this.#goAttempted && !await exists(pidMarker)) {
      throw new Error("owned_controller_fixture_descendant_identity_unproven");
    }
    if (pidMarker !== undefined && await exists(pidMarker)) {
      const value = await readFile(pidMarker, "utf8");
      if (!/^[1-9][0-9]{0,9}\n$/u.test(value)) throw new Error("owned_controller_fixture_pid_marker_invalid");
      const pid = Number(value.trim());
      extraFixturePids.add(pid);
      await waitGone(pid, null);
      extraFixturePids.delete(pid);
    }
    if (this.transport !== null) {
      // ChildProcess close excludes extra descriptors on the pinned runtime.
      // Only after fixture absence, close and join each exact caller wrapper.
      for (const index of [3, 4, 5, 6]) this.descriptor(index)?.destroy();
      await waitUntil(async () => this.#extraDescriptorClosed.size === 4, this.state.deadlines.shutdownMs);
      joinedExtraDescriptors += this.#extraDescriptorClosed.size;
    }
    owners.delete(this);
  }
}

afterAll(async () => {
  let failed = false;
  for (const owner of owners) {
    try { await owner.collect(); } catch { failed = true; }
  }
  if (compilerCleanupUnproven || failed || owners.size !== 0 || extraFixturePids.size !== 0) {
    throw new Error(`owned_controller_fixture_cleanup_unproven; retained ${root ?? "uncreated"}`);
  }
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  if (enabled) console.info(JSON.stringify({ evidence: "owned_controller_native_cleanup", helperOwners: owners.size, additionalFixturePids: extraFixturePids.size, joinedExtraDescriptors, compilerCleanup: "proven", privateRootRemoved: root !== undefined }));
}, 30_000);

nativeTest("keeps the child pre-exec until GO and joins its exact normal exit", async () => {
  const value = new NativeCase("normal", "exit");
  await value.ready();
  await Bun.sleep(60);
  expect(await exists(value.marker)).toBeFalse();
  await value.send("go");
  await value.finish();
  expect(await readFile(value.marker, "utf8")).toBe("started\n");
  expect(ownedControllerDirectChildProof(value.state)).toMatchObject({
    scope: "owned_direct_child_only", released: true, termination: "exit", status: 7, replacementWriterAuthorized: false,
  });
});

nativeTest("valid TERM before GO reaps the gated child without executing the fixture", async () => {
  const value = new NativeCase("before-go", "exit");
  await value.ready(); await value.send("term"); await value.finish();
  expect(await exists(value.marker)).toBeFalse();
  expect(ownedControllerDirectChildProof(value.state)).toMatchObject({ released: false, replacementWriterAuthorized: false });
});

for (const [name, invalid] of [
  ["nonce", (binding: OwnedControllerBinding) => `OOC1 GO ${"0".repeat(32)} ${binding.generation}\n`],
  ["generation", (binding: OwnedControllerBinding) => `OOC1 GO ${binding.nonce} ${binding.generation + 1}\n`],
  ["malformed", (binding: OwnedControllerBinding) => `OOC1  GO ${binding.nonce} ${binding.generation}\n`],
  ["future-version", (binding: OwnedControllerBinding) => `OOC2 GO ${binding.nonce} ${binding.generation}\n`],
  ["oversized", () => `${"x".repeat(161)}\n`],
] as const) {
  nativeTest(`refuses ${name} control before effects and keeps the host uncertain`, async () => {
    const value = new NativeCase(name, "exit");
    await value.ready(); await value.raw(invalid(value.binding)); await value.finish();
    expect(value.exitCode).toBe(64);
    expect(await exists(value.marker)).toBeFalse();
    expect(ownedControllerDirectChildProof(value.state)).toBeNull();
    expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: false });
  });
}

nativeTest("duplicate GO closes admission and never starts a second fixture", async () => {
  const value = new NativeCase("duplicate", "hold");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  await value.raw(encodeOwnedControllerFrame({ ...value.binding, type: "go" })); await value.finish();
  expect(value.exitCode).toBe(64);
  expect(value.frames).toHaveLength(2);
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

for (const suffix of ["go", "term", "partial"] as const) {
  nativeTest(`refuses TERM with a buffered ${suffix} suffix`, async () => {
    const value = new NativeCase(`term-suffix-${suffix}`, "exit");
    await value.ready();
    const term = encodeOwnedControllerFrame({ ...value.binding, type: "term" });
    const tail = suffix === "partial" ? "OOC1" : encodeOwnedControllerFrame({ ...value.binding, type: suffix });
    await value.raw(term + tail);
    await value.finish();
    expect(value.exitCode).toBe(64);
    expect(await exists(value.marker)).toBeFalse();
    expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: false });
    expect(ownedControllerDirectChildProof(value.state)).toBeNull();
  });
}

nativeTest("explicit cancellation joins TERM-resistant child after KILL within one shutdown budget", async () => {
  const value = new NativeCase("cancel", "ignore-term");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  await value.send("term"); await value.finish();
  expect(value.exitCode).toBe(0);
  expect(ownedControllerDirectChildProof(value.state)).toMatchObject({ termination: "signal", status: 9, released: true });
});

nativeTest("startup timeout never opens the exec gate", async () => {
  const value = new NativeCase("startup-timeout", "exit", { startupMs: 150 });
  await value.ready(); await value.finish();
  expect(value.exitCode).toBe(124);
  expect(await exists(value.marker)).toBeFalse();
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("run timeout is enforced by the helper while host sends nothing", async () => {
  const value = new NativeCase("run-timeout", "ignore-term", { runMs: 100 });
  await value.ready(); await value.send("go"); await value.finish();
  expect(value.exitCode).toBe(124);
  expect(value.frames.at(-1)).toMatchObject({ type: "terminal", termination: "signal", status: 9 });
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("owner control EOF terminates and joins without admitting replacement authority", async () => {
  const value = new NativeCase("owner-eof", "hold");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  value.observe({ kind: "owner_lost" }); value.child.stdin.end(); await value.finish();
  expect(value.exitCode).toBe(70);
  expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: true });
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("helper death after GO retains uncertainty while finite fixture expires independently", async () => {
  const value = new NativeCase("helper-death", "self-expire");
  await value.ready(); await value.send("go"); await waitUntil(async () => await exists(value.marker));
  value.child.kill("SIGKILL"); await value.finish();
  expect(value.exitCode).toBeNull();
  expect(value.frames).toHaveLength(1);
  expect(ownedControllerDirectChildProof(value.state)).toBeNull();
});

nativeTest("an escaped finite descendant survives direct-child proof without a containment claim", async () => {
  if (root === undefined) throw new Error("owned_controller_fixture_root_missing");
  const pidMarker = join(root, "escape.pid");
  const finished = join(root, "escape.finished");
  const value = new NativeCase("escape", "escape", {}, [pidMarker, finished]);
  await value.ready(); await value.send("go"); await value.finish();
  const pid = Number((await readFile(pidMarker, "utf8")).trim());
  const start = await processStart(pid);
  expect(start).not.toBeNull();
  expect(await exists(finished)).toBeFalse();
  const proof = ownedControllerDirectChildProof(value.state);
  expect(proof).toMatchObject({ scope: "owned_direct_child_only", replacementWriterAuthorized: false });
  expect(proof).not.toHaveProperty("descendantsContained");
  await waitUntil(async () => await exists(finished));
  await waitGone(pid, start);
});

const transportProof = (value: NativeCase) => {
  if (value.transport === null) throw new Error("owned_controller_fixture_transport_missing");
  return ownedControllerTransportProof(value.transport);
};
const stdoutPrefix = Buffer.from([115, 116, 100, 111, 117, 116, 58, 0, 255, 10]);
const stderrPrefix = Buffer.from([115, 116, 100, 101, 114, 114, 58, 0, 128, 10]);

nativeTest("stdio-v1 separates exact provider bytes from OOC1 authority and waits for every channel", async () => {
  const value = new NativeCase("transport-echo", "echo", {}, [], {});
  await value.ready();
  await Bun.sleep(40);
  expect(await exists(value.marker)).toBeFalse();
  expect(value.providerStdout.byteLength).toBe(0);
  expect(value.providerStderr.byteLength).toBe(0);
  const payload = Buffer.concat([
    Buffer.from(encodeOwnedControllerFrame({ ...value.binding, type: "term" })),
    Buffer.from(Array.from({ length: 32_768 }, (_, index) => index % 256)),
  ]);
  await value.send("go");
  await value.writeProvider(payload.subarray(0, 19));
  await value.writeProvider(payload.subarray(19));
  await value.endProviderInput();
  await value.finish();
  expect(value.frames.map((frame) => frame.type)).toEqual(["ready", "terminal"]);
  expect(value.providerStdout).toEqual(Buffer.concat([stdoutPrefix, payload]));
  expect(value.providerStderr).toEqual(Buffer.concat([stderrPrefix, Buffer.from("input-eof\n")]));
  expect(transportProof(value)).toMatchObject({
    version: "stdio-v1", scope: "owned_direct_child_stdio_only", stdinAcceptedBytes: payload.byteLength,
    writesAccepted: 2, providerConsumptionProven: false, replacementWriterAuthorized: false,
    directChild: { termination: "exit", status: 7, released: true },
  });
});

nativeTest("stdio-v1 refuses provider input before GO without writing or opening the exec gate", async () => {
  const value = new NativeCase("transport-early-input", "echo", {}, [], {});
  await value.ready();
  await expect(value.writeProvider(Buffer.from("forbidden"))).rejects.toThrow("owned_controller_fixture_input_refused");
  await value.cancelTransport(); await value.finish();
  expect(await exists(value.marker)).toBeFalse();
  expect(value.providerStdout.byteLength).toBe(0);
  expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: false });
  expect(transportProof(value)).toBeNull();
});

nativeTest("stdio-v1 TERM before GO closes all target pipes without starting the fixture", async () => {
  const value = new NativeCase("transport-before-go", "echo", {}, [], {});
  await value.ready(); await value.cancelTransport(); await value.finish();
  expect(await exists(value.marker)).toBeFalse();
  expect(transportProof(value)).toMatchObject({ stdinAcceptedBytes: 0, stdoutBytes: 0, stderrBytes: 0, directChild: { released: false } });
});

nativeTest("stdio-v1 passes input EOF as provider data lifecycle rather than control-owner loss", async () => {
  const value = new NativeCase("transport-input-eof", "echo", {}, [], {});
  await value.ready(); await value.send("go"); await value.endProviderInput(); await value.finish();
  expect(value.exitCode).toBe(0);
  expect(value.providerStdout).toEqual(stdoutPrefix);
  expect(value.providerStderr).toEqual(Buffer.concat([stderrPrefix, Buffer.from("input-eof\n")]));
  expect(transportProof(value)).toMatchObject({ stdinAcceptedBytes: 0, writesAccepted: 0, directChild: { status: 7 } });
});

nativeTest("stdio-v1 provider output EOF cannot replace the helper terminal and process join", async () => {
  const value = new NativeCase("transport-early-eof", "close-output", {}, [], {});
  await value.ready(); await value.send("go"); await value.endProviderInput();
  await waitUntil(async () => value.transport?.stdoutEof === true && value.transport.stderrEof);
  expect(transportProof(value)).toBeNull();
  await value.finish();
  expect(transportProof(value)).toMatchObject({ directChild: { status: 7 }, stdoutBytes: 0, stderrBytes: 0 });
});

nativeTest("stdio-v1 native deadline still collects a child blocked by unread provider output", async () => {
  const value = new NativeCase("transport-backpressure", "flood-stdout", { runMs: 100 }, [], {});
  value.providerOutput("stdout").pause();
  await value.ready(); await value.send("go"); await value.endProviderInput();
  await value.helperExited();
  expect(value.exitCode).toBe(124);
  expect(transportProof(value)).toBeNull();
  value.providerOutput("stdout").resume();
  await value.finish();
  expect(await exists(value.marker)).toBeTrue();
  expect(value.frames.at(-1)).toMatchObject({ type: "terminal", released: true });
  expect(transportProof(value)).toBeNull();
});

nativeTest("stdio-v1 output overflow stops admission while retaining only bounded output", async () => {
  const value = new NativeCase("transport-overflow", "flood-stdout", {}, [], { stdoutBytes: 512 });
  await value.ready(); await value.send("go"); await value.endProviderInput(); await value.finish();
  expect(value.providerStdout.byteLength).toBeLessThanOrEqual(512);
  expect(value.transportErrors).toBeGreaterThan(0);
  expect(transportProof(value)).toBeNull();
});

nativeTest("stdio-v1 a pending input write interrupted by native timeout remains uncertain", async () => {
  const value = new NativeCase("transport-input-blocked", "block-input", { runMs: 100, shutdownMs: 200 }, [], {});
  await value.ready(); await value.send("go");
  await waitUntil(async () => await exists(value.marker));
  let refused = false;
  try {
    for (let index = 0; index < 16; index += 1) await value.writeProvider(Buffer.alloc(65_536, 42));
  } catch (error: unknown) {
    expect(error instanceof Error ? error.message : "unknown").toMatch(/^owned_controller_fixture_input_(?:refused|uncertain)$/u);
    refused = true;
  }
  expect(refused).toBeTrue();
  await value.finish();
  expect(value.exitCode).toBe(124);
  expect(transportProof(value)).toBeNull();
});

for (const late of [false, true]) {
  nativeTest(`stdio-v1 ${late ? "refuses expired" : "waits for delayed"} provider drains after a joined direct-child exit`, async () => {
    if (root === undefined) throw new Error("owned_controller_fixture_root_missing");
    const name = late ? "transport-late" : "transport-linger";
    const pidMarker = join(root, `${name}.pid`);
    const finished = join(root, `${name}.finished`);
    const value = new NativeCase(name, late ? "late-output" : "linger-output", { shutdownMs: late ? 200 : 1_000 }, [pidMarker, finished], {});
    await value.ready(); await value.send("go"); await value.endProviderInput();
    await waitUntil(async () => ownedControllerDirectChildProof(value.state) !== null);
    expect(transportProof(value)).toBeNull();
    const pid = Number((await readFile(pidMarker, "utf8")).trim());
    const start = await processStart(pid);
    expect(start).not.toBeNull();
    await value.finish();
    expect(value.providerStdout).toEqual(Buffer.from("tail-out\n"));
    expect(value.providerStderr).toEqual(Buffer.from("tail-err\n"));
    if (late) expect(transportProof(value)).toBeNull();
    else expect(transportProof(value)).toMatchObject({ stdoutBytes: 9, stderrBytes: 9, replacementWriterAuthorized: false });
    expect(await readFile(finished, "utf8")).toBe("finished\n");
    await waitGone(pid, start);
  });
}

nativeTest("stdio-v1 helper death stays uncertain even when target pipes later drain and close", async () => {
  const value = new NativeCase("transport-helper-death", "self-expire", {}, [], {});
  await value.ready(); await value.send("go");
  await waitUntil(async () => await exists(value.marker));
  value.child.kill("SIGKILL"); await value.finish();
  expect(value.exitCode).toBeNull();
  expect(value.frames).toHaveLength(1);
  expect(transportProof(value)).toBeNull();
});
