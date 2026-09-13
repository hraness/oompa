import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  capabilityPlatformSupported,
  hostAccessRequiredCode,
  hostCommandDigest,
  hostAccessRequiredExitCode,
  inheritedLeaseCovers,
  parseHostRunArguments,
  parseInheritedLease,
  permissionBoundaryDenied,
  permitCapacity,
  permitsForMode,
  resolveSlopcameraHostResourceModule,
  resolveSlopcameraRuntimeRoot,
  resolveCapabilityStateRoot,
  resolveHostResourceStateRoot,
  runHostCommand,
} from "./host-run";
import { slopcameraRuntimeDirectory } from "./runtime-pin";
import { commandDigest } from "./telemetry";
import { queueRegistryRoot, readQueueSnapshot, requestQueueHandoff } from "./queue-observer";

describe("host-wide resource wrapper", () => {
  test("uses the established 1/2/all weighted model", () => {
    expect(permitCapacity(18)).toBe(4);
    expect(permitsForMode("shared", 18)).toBe(1);
    expect(permitsForMode("heavy", 18)).toBe(2);
    expect(permitsForMode("exclusive", 18)).toBe(4);
    expect(permitsForMode("exclusive", 2)).toBe(1);
  });

  test("parses argv without invoking a shell", () => {
    expect(parseHostRunArguments([
      "--mode=heavy",
      "--label=repo-check",
      "--",
      "bun",
      "run",
      "check",
    ])).toEqual({
      command: ["bun", "run", "check"],
      label: "repo-check",
      lane: "compute",
      mode: "heavy",
    });
  });

  test("rejects malformed modes and missing command delimiters", () => {
    expect(() => parseHostRunArguments(["--mode=wide", "--", "true"]))
      .toThrow("invalid resource mode");
    expect(() => parseHostRunArguments(["true"]))
      .toThrow("requires --");
    expect(() => parseHostRunArguments(["--label=contains spaces", "--", "true"]))
      .toThrow("ASCII identifier");
    expect(() => parseHostRunArguments(["--lane=cloud", "--", "true"]))
      .toThrow("invalid capability lane");
  });

  test("parses capability lanes independently from compute weight", () => {
    expect(parseHostRunArguments([
      "--mode=exclusive",
      "--lane=browser-auth",
      "--label=browser-test",
      "--",
      "true",
    ])).toEqual({
      command: ["true"],
      label: "browser-test",
      lane: "browser-auth",
      mode: "exclusive",
    });
  });

  test("shares a task UUID only when explicitly supplied", () => {
    const taskId = "00000000-0000-4000-8000-000000000001";
    expect(parseHostRunArguments([`--task-id=${taskId}`, "--", "true"]).taskId).toBe(taskId);
    expect(parseHostRunArguments(["--", "true"]).taskId).toBeUndefined();
    expect(() => parseHostRunArguments([`--task-id=${taskId}`, `--task-id=${taskId}`, "--", "true"])).toThrow("only once");
    for (const value of ["", "private-title", "/private/task", "line\nbreak"]) {
      expect(() => parseHostRunArguments([`--task-id=${value}`, "--", "true"])).toThrow("explicit UUID");
    }
  });

  test("cancellation while holding capability and awaiting CPU refuses handoff throughout release", async () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-queue-cancel-"));
    const stateRoot = join(root, "state");
    const modulePath = join(root, "runtime.js");
    const waiting = join(root, "waiting");
    const releasing = join(root, "releasing");
    const finish = join(root, "finish");
    writeFileSync(modulePath, `
      import { closeSync, existsSync, openSync, writeFileSync } from "node:fs";
      export function createHostResourceCoordinator(options) {
        return { async withLease(_claims, callback, leaseOptions) {
          if (!options.profile.id.includes("capabilities")) {
            writeFileSync(${JSON.stringify(waiting)}, "waiting");
            await new Promise((_resolve, reject) => {
              const abort = () => reject(new Error("canceled"));
              if (leaseOptions.signal.aborted) abort();
              else leaseOptions.signal.addEventListener("abort", abort, { once: true });
            });
          }
          const fd = openSync("/dev/null", "r");
          try { return await callback({ inheritedFileDescriptor: fd }); }
          finally {
            writeFileSync(${JSON.stringify(releasing)}, "releasing");
            const deadline = performance.now() + 5000;
            while (!existsSync(${JSON.stringify(finish)}) && performance.now() < deadline) await Bun.sleep(10);
            closeSync(fd);
          }
        } };
      }
    `);
    const environment: NodeJS.ProcessEnv = { ...process.env, OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: stateRoot,
      OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath, OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off", OOMPA_LOCAL_EFFICIENCY_QUEUE: "on" };
    delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
    delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
    const wrapper = Bun.spawn([process.execPath, join(import.meta.dir, "host-run.ts"), "--lane=browser-auth", "--label=cancel-cpu", "--", "/synthetic/must-not-start"],
      { cwd: root, env: environment, stdout: "ignore", stderr: "pipe" });
    const output = new Response(wrapper.stderr).text();
    const until = async (path: string) => {
      for (let attempt = 0; attempt < 400 && !existsSync(path); attempt += 1) await Bun.sleep(10);
      expect(existsSync(path)).toBeTrue();
    };
    try {
      await until(waiting);
      const owner = (await readQueueSnapshot(stateRoot)).owners[0];
      expect(owner).toMatchObject({ stage: "waiting-compute", capability: "reported-held" });
      wrapper.kill("SIGTERM");
      await until(releasing);
      expect((await readQueueSnapshot(stateRoot)).owners[0]).toMatchObject({ stage: "settling", capability: "reported-held" });
      expect((await requestQueueHandoff(stateRoot, { version: 1, operation: "request-handoff", runId: owner!.runId,
        requestId: "cancel-release", requesterLabel: "waiter" })).result).toBe("not-holder");
      writeFileSync(finish, "finish");
      expect(await wrapper.exited).toBe(143);
      expect(await output).not.toContain("handoff requested by");
    } finally {
      writeFileSync(finish, "finish");
      if (wrapper.exitCode === null) wrapper.kill("SIGTERM");
      await wrapper.exited;
      await output;
      rmSync(queueRegistryRoot(stateRoot), { force: true, recursive: true });
      rmSync(root, { force: true, recursive: true });
    }
  }, 10_000);

  test("uses one machine-wide state root across isolated Codex profiles", () => {
    const first = resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/one" },
      "/opt/tester",
    );
    const second = resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/two" },
      "/opt/tester",
    );
    expect(first).toBe("/opt/tester/.local/state/oompa-local-efficiency/host-resources-v1");
    expect(second).toBe(first);
    expect(resolveCapabilityStateRoot(first))
      .toBe("/opt/tester/.local/state/oompa-local-efficiency/capabilities-v1");
    expect(resolveHostResourceStateRoot(
      { CODEX_HOME: "/profiles/three", XDG_STATE_HOME: "/state" },
      "/opt/tester",
    )).toBe("/state/oompa-local-efficiency/host-resources-v1");
    expect(resolveSlopcameraRuntimeRoot(
      { CODEX_HOME: "/profiles/one" },
      "/opt/tester",
    )).toBe(`/opt/tester/.local/share/oompa-local-efficiency/runtime/${slopcameraRuntimeDirectory}`);
    expect(resolveSlopcameraRuntimeRoot(
      { CODEX_HOME: "/profiles/two" },
      "/opt/tester",
    )).toBe(resolveSlopcameraRuntimeRoot({}, "/opt/tester"));
  });

  test("TTY child signal ownership is an explicit closed non-inherited command option", () => {
    expect(parseHostRunArguments(["--tty-signal-owner=child", "--", "bun", "fixture.ts"]).ttySignalOwner).toBe("child");
    expect(parseHostRunArguments(["--tty-signal-owner=parent", "--", "bun"]).ttySignalOwner).toBe("parent");
    expect(parseHostRunArguments(["--", "bun"]).ttySignalOwner).toBeUndefined();
    for (const value of ["", "auto", "none", "CHILD", "child\0", "child,parent"]) {
      expect(() => parseHostRunArguments([`--tty-signal-owner=${value}`, "--", "bun"])).toThrow("invalid TTY signal owner");
    }
    expect(() => parseHostRunArguments(["--tty-signal-owner=child", "--tty-signal-owner=parent", "--", "bun"])).toThrow("only once");
    expect(parseHostRunArguments(["--", "bun", "--tty-signal-owner=child"]).command).toEqual(["bun", "--tty-signal-owner=child"]);
  });

  test("child ownership refuses before module, lease or subprocess when any standard descriptor is not a TTY", async () => {
    // The ordinary compute test has no controlling terminal; actual three-TTY
    // success and each missing descriptor are separate explicit native fixtures.
    if (process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY) return;
    await expect(runHostCommand({ command: ["/synthetic/must-not-start"], cwd: import.meta.dir, label: "tty-refusal", lane: "compute", mode: "shared",
      ttySignalOwner: "child", environment: { OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: "/synthetic/must-not-load" } })).rejects.toThrow("requires POSIX terminal descriptors");
    const foreign = { command: ["/synthetic/must-not-start"], cwd: import.meta.dir, label: "tty-refusal", lane: "compute" as const, mode: "shared" as const };
    Reflect.set(foreign, "ttySignalOwner", "unknown");
    await expect(runHostCommand(foreign)).rejects.toThrow("invalid TTY signal owner");
  });

  test("generated TTY options preserve opaque child argv and refuse every other prefix value", () => {
    fc.assert(fc.property(fc.constantFrom("parent", "child"), fc.array(fc.string({ maxLength: 40 }), { maxLength: 8 }), (owner, arguments_) => {
      const parsed = parseHostRunArguments([`--tty-signal-owner=${owner}`, "--", "bun", ...arguments_]);
      expect(parsed.ttySignalOwner).toBe(owner);
      expect(parsed.command).toEqual(["bun", ...arguments_]);
    }), { numRuns: 128 });
    fc.assert(fc.property(fc.string({ maxLength: 64 }).filter((value) => value !== "parent" && value !== "child"), (value) => {
      expect(() => parseHostRunArguments([`--tty-signal-owner=${value}`, "--", "bun"])).toThrow("invalid TTY signal owner");
    }), { numRuns: 128 });
  });

  test("child signal ownership cannot reuse the default command digest", () => {
    const argv = ["bun", "owner.ts"]; const scope = "synthetic-scope";
    expect(hostCommandDigest(argv, scope)).toBe(commandDigest(argv, scope));
    expect(hostCommandDigest(argv, scope, "parent")).toBe(commandDigest(argv, scope));
    expect(hostCommandDigest(argv, scope, "child")).not.toBe(commandDigest(argv, scope));
    expect(hostCommandDigest(argv, scope, "child")).not.toBe(hostCommandDigest(["bun", "other.ts"], scope, "child"));
  });

  test("requires macOS for the mac-native lane", () => {
    expect(capabilityPlatformSupported("mac-native", "darwin")).toBe(true);
    expect(capabilityPlatformSupported("mac-native", "linux")).toBe(false);
    expect(capabilityPlatformSupported("browser-auth", "linux")).toBe(true);
  });

  test("validates inherited lease metadata and rejects mode or capability escalation", () => {
    expect(inheritedLeaseCovers(parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "legacy",
      mode: "exclusive",
      permits: 4,
      version: 1,
    })), {
      lane: "compute",
      mode: "exclusive",
    })).toBe(true);
    const sharedBrowser = parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "browser",
      lane: "browser-auth",
      mode: "shared",
      permits: 1,
      version: 2,
    }));
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "compute", mode: "shared" })).toBe(true);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "browser-auth", mode: "shared" })).toBe(true);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "browser-auth", mode: "heavy" })).toBe(false);
    expect(inheritedLeaseCovers(sharedBrowser, { lane: "mac-native", mode: "shared" })).toBe(false);
    expect(() => parseInheritedLease('{"version":1}')).toThrow("malformed");
    expect(() => parseInheritedLease(JSON.stringify({
      capacity: 4,
      label: "changed",
      lane: "compute",
      mode: "exclusive",
      permits: 1,
      version: 2,
    }))).toThrow("malformed");
    expect(() => parseInheritedLease("not-json")).toThrow("malformed");
  });

  test("accepts an explicit Slopcamera module path for isolated installations", () => {
    const modulePath = resolveSlopcameraHostResourceModule(
      { OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: import.meta.path },
      "/nonexistent-home",
    );
    expect(modulePath).toBe(import.meta.path);
  });

  test("classifies only bounded permission-denial cause chains", () => {
    expect(permissionBoundaryDenied({ code: "EPERM" })).toBe(true);
    expect(permissionBoundaryDenied({ code: "UNSAFE_STATE", cause: { code: "EACCES" } }))
      .toBe(true);
    expect(permissionBoundaryDenied({ code: "UNSAFE_STATE" })).toBe(false);
    expect(permissionBoundaryDenied({ code: "WAIT_TIMEOUT", cause: { code: "ETIMEDOUT" } }))
      .toBe(false);

    const cycle: { cause?: unknown; code: string } = { code: "UNSAFE_STATE" };
    cycle.cause = cycle;
    expect(permissionBoundaryDenied(cycle)).toBe(false);
    expect(permissionBoundaryDenied({
      code: "UNSAFE_STATE",
      cause: {
        code: "UNSAFE_STATE",
        cause: {
          code: "UNSAFE_STATE",
          cause: { code: "UNSAFE_STATE", cause: { code: "EPERM" } },
        },
      },
    })).toBe(false);
  });

  test("a caller-forged inherited lease cannot bypass host-resource acquisition", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-forged-inherited-lease-"));
    const childMarker = join(root, "child-ran");
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=exclusive",
        "--label=nested-test",
        "--",
        process.execPath,
        "-e",
        `await Bun.write(${JSON.stringify(childMarker)}, "ran")`,
      ],
      cwd: root,
      env: {
        ...process.env,
        OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: "/missing/slopcamera-module.js",
        OOMPA_LOCAL_EFFICIENCY_LEASE: JSON.stringify({
          capacity: permitCapacity(),
          label: "forged",
          lane: "compute",
          mode: "exclusive",
          permits: permitCapacity(),
          version: 2,
        }),
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain("lease descriptor");
      expect(existsSync(childMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a nested wrapper accepts only the inherited live lease descriptor", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-live-inherited-lease-"));
    try {
      const modulePath = join(root, "host-resources.js");
      const markerPath = join(root, "lease.lock");
      writeFileSync(modulePath, `
        import { createHash } from "node:crypto";
        import { chmodSync, closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
        const markerPath = ${JSON.stringify(markerPath)};
        export function createHostResourceCoordinator(options) {
          return {
            async withLease(claims, callback) {
              const document = {
                version: 1,
                owner: "a".repeat(32),
                profileSha256: createHash("sha256").update(JSON.stringify(options.profile)).digest("hex"),
                ticket: "1",
                phase: "A",
                claims,
              };
              writeFileSync(markerPath, JSON.stringify(document), { mode: 0o600 });
              chmodSync(markerPath, 0o600);
              const descriptor = openSync(markerPath, "r+");
              try {
                return await callback({ inheritedFileDescriptor: descriptor });
              } finally {
                closeSync(descriptor);
                unlinkSync(markerPath);
              }
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=outer-live",
          "--",
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=nested-live",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
          OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("exports the identical lease under both the current and legacy names", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-dual-lease-env-"));
    try {
      const modulePath = join(root, "host-resources.js");
      const leasePath = join(root, "lease-environment.json");
      const markerPath = join(root, "lease.lock");
      writeFileSync(modulePath, `
        import { closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
        const markerPath = ${JSON.stringify(markerPath)};
        export function createHostResourceCoordinator() {
          return {
            async withLease(claims, callback) {
              writeFileSync(markerPath, "{}", { mode: 0o600 });
              const descriptor = openSync(markerPath, "r+");
              try {
                return await callback({ inheritedFileDescriptor: descriptor });
              } finally {
                closeSync(descriptor);
                unlinkSync(markerPath);
              }
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=heavy",
          "--label=dual-lease",
          "--",
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(leasePath)}, JSON.stringify([
            process.env.OOMPA_LOCAL_EFFICIENCY_LEASE ?? null,
            process.env.HRA_LOCAL_EFFICIENCY_LEASE ?? null,
          ]))`,
        ],
        cwd: root,
        env: {
          ...environment,
          OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
          OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const [current, legacy] = JSON.parse(readFileSync(leasePath, "utf8")) as [string | null, string | null];
      expect(typeof current).toBe("string");
      expect(legacy).toBe(current);
      expect(JSON.parse(current as string)).toMatchObject({ label: "dual-lease", version: 2 });
      expect(parseInheritedLease(current as string)).toEqual({
        capacity: permitCapacity(),
        lane: "compute",
        mode: "heavy",
        permits: permitsForMode("heavy"),
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("a nested wrapper accepts a live lease issued under the legacy profile id only", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-legacy-profile-lease-"));
    try {
      const nested = (profileIdPrefix: string): { exitCode: number; stderr: string } => {
        const modulePath = join(root, `host-resources-${profileIdPrefix.replaceAll(".", "-")}.js`);
        const markerPath = join(root, `lease-${profileIdPrefix.replaceAll(".", "-")}.lock`);
        writeFileSync(modulePath, `
          import { createHash } from "node:crypto";
          import { chmodSync, closeSync, openSync, unlinkSync, writeFileSync } from "node:fs";
          const markerPath = ${JSON.stringify(markerPath)};
          export function createHostResourceCoordinator(options) {
            const profile = {
              id: options.profile.id.replace(/^oompa\\.local-efficiency/u, ${JSON.stringify(profileIdPrefix)}),
              capacities: options.profile.capacities,
            };
            return {
              async withLease(claims, callback) {
                const document = {
                  version: 1,
                  owner: "a".repeat(32),
                  profileSha256: createHash("sha256").update(JSON.stringify(profile)).digest("hex"),
                  ticket: "1",
                  phase: "A",
                  claims,
                };
                writeFileSync(markerPath, JSON.stringify(document), { mode: 0o600 });
                chmodSync(markerPath, 0o600);
                const descriptor = openSync(markerPath, "r+");
                try {
                  return await callback({ inheritedFileDescriptor: descriptor });
                } finally {
                  closeSync(descriptor);
                  unlinkSync(markerPath);
                }
              },
            };
          }
        `);
        const environment = { ...process.env };
        delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
        delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
        const result = Bun.spawnSync({
          cmd: [
            process.execPath,
            join(import.meta.dir, "host-run.ts"),
            "--mode=shared",
            "--label=outer-legacy",
            "--",
            process.execPath,
            join(import.meta.dir, "host-run.ts"),
            "--mode=shared",
            "--label=nested-legacy",
            "--",
            process.execPath,
            "-e",
            "process.exit(0)",
          ],
          cwd: root,
          env: {
            ...environment,
            OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
            OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
            OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off",
          },
          stderr: "pipe",
          stdout: "pipe",
        });
        return { exitCode: result.exitCode, stderr: result.stderr.toString() };
      };
      const legacy = nested("hra.local-efficiency");
      expect(legacy.exitCode, legacy.stderr).toBe(0);
      const foreign = nested("other.local-efficiency");
      expect(foreign.exitCode).not.toBe(0);
      expect(foreign.stderr).toContain("does not cover this request");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("records a canceled attempt before CPU admission", async () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-pre-admission-cancel-"));
    const ready = join(root, "ready");
    try {
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        import { writeFileSync } from "node:fs";
        const ready = ${JSON.stringify(ready)};
        export function createHostResourceCoordinator() {
          return {
            async withLease(_claims, _callback, options) {
              writeFileSync(ready, "ready");
              return await new Promise((_resolve, reject) => {
                const abort = () => {
                  const error = new Error("wait canceled");
                  error.code = "WAIT_ABORTED";
                  reject(error);
                };
                if (options.signal.aborted) abort();
                else options.signal.addEventListener("abort", abort, { once: true });
              });
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const wrapper = Bun.spawn({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=exclusive",
          "--label=cancel-before-admission",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
          OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      wrapper.kill("SIGTERM");
      expect(await wrapper.exited).toBe(143);
      const telemetryRoot = join(root, "state", "telemetry-v1");
      const files = readdirSync(telemetryRoot);
      expect(files).toHaveLength(1);
      const lines = readFileSync(join(telemetryRoot, files[0] ?? ""), "utf8")
        .trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        admittedAt: null,
        exitCode: 143,
        outcome: "canceled",
        runMilliseconds: null,
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("acquires the scarce browser capability before weighted CPU permits", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-browser-capability-order-"));
    try {
      const log = join(root, "order.log");
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        import { appendFileSync, closeSync, openSync } from "node:fs";
        const log = ${JSON.stringify(log)};
        export function createHostResourceCoordinator(options) {
          const id = options.profile.id.includes("capabilities") ? "capability" : "cpu";
          return {
            async withLease(_claims, callback) {
              appendFileSync(log, id + ":start\\n");
              const descriptor = openSync("/dev/null", "r");
              try {
                return await callback({ inheritedFileDescriptor: descriptor });
              } finally {
                closeSync(descriptor);
                appendFileSync(log, id + ":end\\n");
              }
            },
          };
        }
      `);
      const environment = { ...process.env };
      delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--lane=browser-auth",
          "--label=browser-order",
          "--",
          process.execPath,
          "-e",
          "process.exit(0)",
        ],
        cwd: root,
        env: {
          ...environment,
          OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
          OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
          OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(readFileSync(log, "utf8").trim().split("\n")).toEqual([
        "capability:start",
        "cpu:start",
        "cpu:end",
        "capability:end",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("forwards interruption to the complete child process group", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "oompa-process-group-custody-"));
    const modulePath = join(root, "host-resources.js");
    const ready = join(root, "ready");
    const orphanMarker = join(root, "orphan-ran");
    writeFileSync(modulePath, `
      import { closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator() {
        return {
          async withLease(_claims, callback) {
            const descriptor = openSync("/dev/null", "r");
            try {
              return await callback({ inheritedFileDescriptor: descriptor });
            } finally {
              closeSync(descriptor);
            }
          },
        };
      }
    `);
    const leaderSource = `
      Bun.spawn({
        cmd: [process.execPath, "-e", ${JSON.stringify(`await Bun.sleep(800); await Bun.write(${JSON.stringify(orphanMarker)}, "ran")`)}],
        stderr: "ignore",
        stdout: "ignore",
      });
      await Bun.write(${JSON.stringify(ready)}, "ready");
      await Bun.sleep(10_000);
    `;
    const environment = { ...process.env };
    delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
    delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
    const wrapper = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=shared",
        "--label=process-group",
        "--",
        process.execPath,
        "-e",
        leaderSource,
      ],
      cwd: root,
      env: {
        ...environment,
        OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
        OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      wrapper.kill("SIGTERM");
      await wrapper.exited;
      await Bun.sleep(1_000);
      expect(existsSync(orphanMarker)).toBe(false);
    } finally {
      wrapper.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("force-cleans a residual descendant after its command leader exits", async () => {
    if (process.platform === "win32") return;
    const root = mkdtempSync(join(tmpdir(), "oompa-residual-process-group-"));
    const modulePath = join(root, "host-resources.js");
    const ready = join(root, "ready");
    const residualMarker = join(root, "residual-ran");
    writeFileSync(modulePath, `
      import { closeSync, openSync } from "node:fs";
      export function createHostResourceCoordinator() {
        return {
          async withLease(_claims, callback) {
            const descriptor = openSync("/dev/null", "r");
            try {
              return await callback({ inheritedFileDescriptor: descriptor });
            } finally {
              closeSync(descriptor);
            }
          },
        };
      }
    `);
    const descendantSource = `
      process.on("SIGTERM", () => {});
      await Bun.sleep(800);
      await Bun.write(${JSON.stringify(residualMarker)}, "ran");
    `;
    const leaderSource = `
      const { spawn } = await import("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}], {
        stdio: "ignore",
      });
      child.unref();
      await Bun.write(${JSON.stringify(ready)}, "ready");
    `;
    const environment = { ...process.env };
    delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
    delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
    const wrapper = Bun.spawn({
      cmd: [
        process.execPath,
        join(import.meta.dir, "host-run.ts"),
        "--mode=shared",
        "--label=residual-process-group",
        "--",
        process.execPath,
        "-e",
        leaderSource,
      ],
      cwd: root,
      env: {
        ...environment,
        OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
        OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state", "host-resources-v1"),
        OOMPA_LOCAL_EFFICIENCY_TELEMETRY: "off",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      for (let attempts = 0; attempts < 100 && !existsSync(ready); attempts += 1) {
        await Bun.sleep(10);
      }
      expect(existsSync(ready)).toBe(true);
      expect(await wrapper.exited).toBe(0);
      await Bun.sleep(1_000);
      expect(existsSync(residualMarker)).toBe(false);
    } finally {
      wrapper.kill("SIGKILL");
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("reports a stable reviewed-host-access boundary before child execution", () => {
    const root = mkdtempSync(join(tmpdir(), "oompa-host-access-boundary-"));
    try {
      const modulePath = join(root, "host-resources.js");
      writeFileSync(modulePath, `
        export function createHostResourceCoordinator() {
          return {
            async withLease() {
              const cause = new Error("private scheduler path");
              cause.code = "EPERM";
              const error = new Error("unsafe state", { cause });
              error.code = "UNSAFE_STATE";
              throw error;
            },
          };
        }
      `);
      const childMarker = join(root, "child-ran");
      const environment = { ...process.env };
      delete environment.OOMPA_LOCAL_EFFICIENCY_LEASE;
      delete environment.HRA_LOCAL_EFFICIENCY_LEASE;
      const result = Bun.spawnSync({
        cmd: [
          process.execPath,
          join(import.meta.dir, "host-run.ts"),
          "--mode=shared",
          "--label=boundary-test",
          "--",
          process.execPath,
          "-e",
          `await Bun.write(${JSON.stringify(childMarker)}, "ran")`,
        ],
        cwd: root,
        env: {
          ...environment,
          OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE: modulePath,
          OOMPA_LOCAL_EFFICIENCY_STATE_ROOT: join(root, "state"),
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode).toBe(hostAccessRequiredExitCode);
      expect(result.stderr.toString()).toContain(hostAccessRequiredCode);
      expect(result.stderr.toString()).toContain("identical oompa-host-run invocation");
      expect(result.stderr.toString()).not.toContain("private scheduler path");
      expect(existsSync(childMarker)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
