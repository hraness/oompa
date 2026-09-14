/** Closed synthetic roles for host-run-tty.native.test.ts. Never an owner ceremony. */
import { closeSync, existsSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dlopen } from "bun:ffi";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseHostRunArguments, permitCapacity, resolveSlopcameraHostResourceModule, runHostCommand } from "./host-run";

const modes = ["child", "parent", "between", "after_join", "cached_stdin", "queued", "term", "hup", "quit", "missing_0", "missing_1", "missing_2", "spawn_error"] as const;
type Mode = typeof modes[number];
const [role, modeValue] = process.argv.slice(2);
if (process.env.OOMPA_HOST_TTY_FIXTURE !== "1" || process.platform !== "darwin"
  || (role !== "wrapper" && role !== "target") || !modes.some((value) => value === modeValue)) throw new Error("TTY_FIXTURE_REFUSED");
const mode = modeValue as Mode;
const root = process.cwd();
const metadata = lstatSync(root);
if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw new Error("TTY_FIXTURE_ROOT_REFUSED");
const file = (name: string): string => join(root, name);
const write = (name: string, value: unknown): void => writeFileSync(file(name), JSON.stringify(value), { flag: "wx", mode: 0o600 });
const wait = async (condition: () => boolean): Promise<void> => {
  const deadline = performance.now() + 8000;
  while (!condition()) {
    if (performance.now() >= deadline) throw new Error("TTY_FIXTURE_DEADLINE");
    await Bun.sleep(10);
  }
};

if (role === "target") {
  let interrupts = 0;
  const finish = (code: number, signal: string | null): never => {
    write("target-result.json", { pid: process.pid, interrupts, code, signal });
    process.exit(code);
  };
  process.on("SIGINT", () => {
    interrupts += 1;
    write(`interrupt-${String(interrupts)}`, true);
    if (interrupts > 1) finish(130, "SIGINT");
  });
  for (const [signal, code] of [["SIGTERM", 143], ["SIGHUP", 129], ["SIGQUIT", 131]] as const) process.on(signal, () => finish(code, signal));
  write("target-started.json", { pid: process.pid });
  await wait(() => existsSync(file("finish-target")));
  finish(0, null);
} else {
  // This baseline observer does not replace signal delivery. For the first
  // physical Ctrl-C only, wait for the target's first real delivery before the
  // scheduler's existing handlers run, so standard-signal coalescing cannot hide
  // the default wrapper's second delivery. The barrier is bounded and test-only.
  let wrapperInterrupts = 0;
  const baselineInterrupt = (): void => {
    wrapperInterrupts += 1;
    if (wrapperInterrupts === 1 && existsSync(file("target-started.json")) && !existsSync(file("wrapper-returned"))) {
      const deadline = performance.now() + 1000;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      while (!existsSync(file("interrupt-1")) && performance.now() < deadline) Atomics.wait(pause, 0, 0, 5);
    }
    write(`wrapper-interrupt-${String(wrapperInterrupts)}`, true);
  };
  process.on("SIGINT", baselineInterrupt);
  const signals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
  const before = signals.map((signal) => process.listenerCount(signal));
  if (mode === "cached_stdin") Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  if (mode.startsWith("missing_")) {
    const descriptor = Number(mode.slice("missing_".length));
    // Do not assume the runtime's next open reuses a just-closed standard FD.
    // dup2 replaces exactly the selected descriptor and leaves the other TTYs.
    const system = dlopen("/usr/lib/libSystem.B.dylib", { dup2: { args: ["i32", "i32"], returns: "i32" } });
    let owned: number | null = null;
    try {
      owned = openSync("/dev/null", "r+");
      if (owned < 3 || system.symbols.dup2(owned, descriptor) !== descriptor) throw new Error("TTY_FIXTURE_DESCRIPTOR_REPLACEMENT");
    } catch {
      write("setup-refused.json", { phase: "descriptor_replacement", descriptor });
      throw new Error("TTY_FIXTURE_DESCRIPTOR_REPLACEMENT");
    } finally {
      if (owned !== null) closeSync(owned);
      system.close();
    }
  }
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TZ: "UTC", OOMPA_HOST_TTY_FIXTURE: "1" };
  const stateRoot = file("ledger");
  const release = Promise.withResolvers<undefined>();
  let blocker: Promise<unknown> | null = null;
  if (mode === "queued") {
    // The unchanged installed coordinator owns this separate fixture ledger.
    const module: unknown = await import(pathToFileURL(resolveSlopcameraHostResourceModule(environment)).href);
    if (typeof module !== "object" || module === null || !("createHostResourceCoordinator" in module) || typeof module.createHostResourceCoordinator !== "function") throw new Error("TTY_FIXTURE_RUNTIME_REFUSED");
    const create = module.createHostResourceCoordinator as (options: unknown) => {
      withLease(claims: unknown, callback: () => Promise<undefined>): Promise<unknown>;
    };
    const capacity = permitCapacity();
    const coordinator = create({ profile: { id: `oompa.local-efficiency/v1-${String(capacity)}`, capacities: [{ resource: "cpu", limit: capacity }] }, stateRoot, waitTimeoutMilliseconds: 8000 });
    blocker = coordinator.withLease([{ resource: "cpu", amount: capacity }], async () => {
      write("blocker-held", true);
      return await release.promise;
    });
    // Observe rejection immediately; retain and join the original promise below.
    void blocker.catch(() => { release.resolve(undefined); });
    await wait(() => existsSync(file("blocker-held")));
  }
  let code: number | null = null;
  let error: string | null = null;
  let readinessWritten = false;
  const observeReadiness = setInterval(() => {
    const expected = mode === "queued" ? 2 : 3; // baseline + cancel [+ forward]
    if (!readinessWritten && process.listenerCount("SIGINT") === expected
      && (mode === "queued" || existsSync(file("target-started.json")))) {
      write("wrapper-ready", true);
      readinessWritten = true;
    }
  }, 5);
  try {
    const parsed = parseHostRunArguments([
      "--mode=shared", "--lane=mac-native", `--label=tty-${mode.replaceAll("_", "-")}`,
      `--tty-signal-owner=${mode === "parent" ? "parent" : "child"}`, "--",
      ...(mode === "spawn_error" ? [file("must-not-exist")] : [process.execPath, "--no-env-file", "--config=/dev/null", import.meta.path, "target", mode]),
    ]);
    code = await runHostCommand({ ...parsed, cwd: root, environment, stateRoot });
  } catch (caught: unknown) {
    error = caught instanceof Error && caught.message.includes("requires POSIX terminal descriptors") ? "tty_required"
      : mode === "spawn_error" && caught instanceof Error && "code" in caught && caught.code === "ENOENT" ? "spawn_error" : "unexpected";
  } finally {
    clearInterval(observeReadiness);
    release.resolve(undefined);
    if (blocker !== null) await blocker;
  }
  const listenersRestored = signals.every((signal, index) => process.listenerCount(signal) === before[index]);
  write("wrapper-returned", true);
  if (mode === "after_join" || mode === "spawn_error") await wait(() => existsSync(file("wrapper-interrupt-1")));
  write("wrapper-result.json", { source: "credential_free_fixture", pid: process.pid, code, error, wrapperInterrupts, listenersRestored, blockerJoined: true });
  process.off("SIGINT", baselineInterrupt);
  // Read only our own closed marker to keep this role's complete result explicit.
  if (readFileSync(file("wrapper-result.json")).byteLength > 1024) throw new Error("TTY_FIXTURE_RESULT_BOUND");
}
