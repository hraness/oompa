#!/usr/bin/env bun

import { spawn } from "node:child_process";
import {
  existsSync,
  fstatSync,
  readSync,
} from "node:fs";
import { availableParallelism, constants as osConstants, homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { isatty } from "node:tty";

import { slopcameraRuntimeDirectory } from "./runtime-pin";
import { readQueueSnapshot, requireQueueTaskId, startQueueObserver, type QueueObserver } from "./queue-observer";

import {
  commandProgramLabel,
  containsControlCharacters,
  requireOperationLabel,
  sha256,
} from "./shared";
import {
  appendThroughputEvent,
  commandDigest,
  newThroughputEvent,
  scopeDigest,
  throughputTelemetryRoot,
} from "./telemetry";

export type ResourceMode = "shared" | "heavy" | "exclusive";
export type CapabilityLane = "compute" | "browser-auth" | "mac-native";
export type TtySignalOwner = "parent" | "child";

export const hostAccessRequiredCode = "OOMPA_HOST_ACCESS_REQUIRED";
export const hostAccessRequiredExitCode = 77;

export class HostAccessRequiredError extends Error {
  readonly code = hostAccessRequiredCode;

  constructor() {
    super(
      "the machine-wide scheduler state is outside the active permission boundary; "
      + "retry this identical oompa-host-run invocation through reviewed host access, "
      + "without running the child directly or removing scheduler state",
    );
    this.name = "HostAccessRequiredError";
  }
}

type HostResourceLease = {
  readonly inheritedFileDescriptor: number;
};

type HostResourceCoordinator = {
  withLease<T>(
    claims: readonly { readonly resource: string; readonly amount: number }[],
    callback: (lease: HostResourceLease) => T | Promise<T>,
    options?: {
      readonly signal?: AbortSignal;
      readonly waitTimeoutMilliseconds?: number;
    },
  ): Promise<T>;
};

type HostResourceModule = {
  createHostResourceCoordinator(options: {
    readonly profile: {
      readonly id: string;
      readonly capacities: readonly { readonly resource: string; readonly limit: number }[];
    };
    readonly stateRoot: string;
    readonly waitTimeoutMilliseconds: number;
  }): HostResourceCoordinator;
};

export type HostRunOptions = {
  readonly command: readonly string[];
  readonly cwd: string;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly label: string;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly stateRoot?: string;
  readonly taskId?: string;
  readonly ttySignalOwner?: TtySignalOwner;
};

export function permitCapacity(hostParallelism = availableParallelism()): number {
  if (hostParallelism >= 12) return 4;
  if (hostParallelism >= 6) return 3;
  if (hostParallelism >= 3) return 2;
  return 1;
}

export function permitsForMode(
  mode: ResourceMode,
  hostParallelism = availableParallelism(),
): number {
  const capacity = permitCapacity(hostParallelism);
  if (mode === "shared") return 1;
  if (mode === "heavy") return Math.min(2, capacity);
  return capacity;
}

export function parseHostRunArguments(arguments_: readonly string[]): {
  readonly command: readonly string[];
  readonly label: string;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly taskId?: string;
  readonly ttySignalOwner?: TtySignalOwner;
} {
  const delimiter = arguments_.indexOf("--");
  if (delimiter < 0) throw new Error("oompa-host-run requires -- before its command");
  let label: string | undefined;
  let lane: CapabilityLane = "compute";
  let laneSupplied = false;
  let mode: ResourceMode | undefined;
  let ttySignalOwner: TtySignalOwner | undefined;
  let taskId: string | undefined;
  for (const argument of arguments_.slice(0, delimiter)) {
    if (argument.startsWith("--mode=")) {
      if (mode !== undefined) throw new Error("--mode may appear only once");
      const value = argument.slice("--mode=".length);
      if (value !== "shared" && value !== "heavy" && value !== "exclusive") {
        throw new Error(`invalid resource mode: ${value}`);
      }
      mode = value;
      continue;
    }
    if (argument.startsWith("--label=")) {
      if (label !== undefined) throw new Error("--label may appear only once");
      label = requireOperationLabel(argument.slice("--label=".length), "--label");
      continue;
    }
    if (argument.startsWith("--lane=")) {
      if (laneSupplied) throw new Error("--lane may appear only once");
      const value = argument.slice("--lane=".length);
      if (value !== "compute" && value !== "browser-auth" && value !== "mac-native") {
        throw new Error(`invalid capability lane: ${value}`);
      }
      lane = value;
      laneSupplied = true;
      continue;
    }
    if (argument.startsWith("--tty-signal-owner=")) {
      if (ttySignalOwner !== undefined) throw new Error("--tty-signal-owner may appear only once");
      const value = argument.slice("--tty-signal-owner=".length);
      if (value !== "parent" && value !== "child") throw new Error(`invalid TTY signal owner: ${value}`);
      ttySignalOwner = value;
      continue;
    }
    if (argument.startsWith("--task-id=")) {
      if (taskId !== undefined) throw new Error("--task-id may appear only once");
      taskId = requireQueueTaskId(argument.slice("--task-id=".length));
      continue;
    }
    throw new Error(`unknown oompa-host-run argument: ${argument}`);
  }
  const command = arguments_.slice(delimiter + 1);
  if (command.length === 0 || command[0] === undefined || command[0] === "") {
    throw new Error("oompa-host-run requires a command");
  }
  if (containsControlCharacters(command[0])) {
    throw new Error("command program must contain no control characters");
  }
  return {
    command,
    label: label ?? commandProgramLabel(command[0]),
    lane,
    mode: mode ?? "shared",
    ...(taskId === undefined ? {} : { taskId }),
    ...(ttySignalOwner === undefined ? {} : { ttySignalOwner }),
  };
}

export function resolveHostResourceStateRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.OOMPA_LOCAL_EFFICIENCY_STATE_ROOT ?? environment.HRA_LOCAL_EFFICIENCY_STATE_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) {
      throw new Error("OOMPA_LOCAL_EFFICIENCY_STATE_ROOT must be absolute");
    }
    return resolve(configured);
  }
  const xdgState = environment.XDG_STATE_HOME;
  if (xdgState !== undefined && xdgState !== "") {
    if (!isAbsolute(xdgState)) throw new Error("XDG_STATE_HOME must be absolute");
    return join(resolve(xdgState), "oompa-local-efficiency", "host-resources-v1");
  }
  return join(resolve(userHome), ".local", "state", "oompa-local-efficiency", "host-resources-v1");
}

export function resolveCapabilityStateRoot(hostResourceStateRoot: string): string {
  return join(resolve(hostResourceStateRoot, ".."), "capabilities-v1");
}

export function resolveSlopcameraRuntimeRoot(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.OOMPA_LOCAL_EFFICIENCY_RUNTIME_ROOT ?? environment.HRA_LOCAL_EFFICIENCY_RUNTIME_ROOT;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("OOMPA_LOCAL_EFFICIENCY_RUNTIME_ROOT must be absolute");
    return resolve(configured);
  }
  const xdgData = environment.XDG_DATA_HOME;
  if (xdgData !== undefined && xdgData !== "") {
    if (!isAbsolute(xdgData)) throw new Error("XDG_DATA_HOME must be absolute");
    return join(resolve(xdgData), "oompa-local-efficiency", "runtime", slopcameraRuntimeDirectory);
  }
  return join(resolve(userHome), ".local", "share", "oompa-local-efficiency", "runtime", slopcameraRuntimeDirectory);
}

function slopcameraCandidates(
  environment: Readonly<NodeJS.ProcessEnv>,
  userHome = homedir(),
): string[] {
  const configured = environment.OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE;
  return [
    ...(configured === undefined || configured === "" ? [] : [configured]),
    join(resolveSlopcameraRuntimeRoot(environment, userHome), "host-resources.js"),
  ].map((candidate) => resolve(candidate));
}

export function resolveSlopcameraHostResourceModule(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const path = slopcameraCandidates(environment, userHome)
    .find((candidate) => existsSync(candidate));
  if (path === undefined) {
    throw new Error(
      "the private Slopcamera host-resource runtime is unavailable; run the oompa-local-efficiency bootstrap",
    );
  }
  return path;
}

async function hostResourceModule(
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<HostResourceModule> {
  const loaded: unknown = await import(pathToFileURL(resolveSlopcameraHostResourceModule(environment)).href);
  if (
    typeof loaded !== "object"
    || loaded === null
    || !("createHostResourceCoordinator" in loaded)
    || typeof loaded.createHostResourceCoordinator !== "function"
  ) {
    throw new Error("the installed Slopcamera host-resource module is incompatible");
  }
  return { createHostResourceCoordinator: loaded.createHostResourceCoordinator as HostResourceModule["createHostResourceCoordinator"] };
}

type ChildTtySignalScope = { active: boolean };

/** This is an actual descriptor guard, not a caller-supplied TTY observation. */
function assertChildTtySignalOwner(): void {
  if (process.platform === "win32" || ![0, 1, 2].every((descriptor) => isatty(descriptor))) {
    throw new Error("--tty-signal-owner=child requires POSIX terminal descriptors 0, 1 and 2");
  }
}

function spawnCommand(
  command: readonly string[],
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  inheritedLeaseDescriptors: readonly number[] = [],
  ttySignalScope?: ChildTtySignalScope,
): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const [program, ...arguments_] = command;
    if (program === undefined) return reject(new Error("command is empty"));
    if (ttySignalScope !== undefined) assertChildTtySignalOwner();
    const ownsProcessGroup = ttySignalScope === undefined
      && process.platform !== "win32" && !process.stdin.isTTY;
    const child = spawn(program, arguments_, {
      cwd,
      detached: ownsProcessGroup,
      env: { ...environment },
      stdio: inheritedLeaseDescriptors.length === 0
        ? "inherit"
        : ["inherit", "inherit", "inherit", ...inheritedLeaseDescriptors],
    });
    let forcedCleanup: ReturnType<typeof setTimeout> | undefined;
    const signalChildTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (ownsProcessGroup) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error: unknown) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        ) return;
        try {
          child.kill(signal);
        } catch {
          console.error("[oompa-host-run] could not forward signal to the complete child tree");
        }
      }
    };
    const processGroupExists = (): boolean => {
      if (!ownsProcessGroup || child.pid === undefined) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error: unknown) {
        if (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "ESRCH"
        ) return false;
        return true;
      }
    };
    const forward = (signal: NodeJS.Signals): void => {
      // An opted-in foreground child receives terminal SIGINT directly. Its
      // caller owns any local interruption ceremony; duplicate delivery is unsafe.
      // HUP/QUIT/TERM and default/non-TTY behavior keep their existing forwarding.
      if (signal === "SIGINT" && ttySignalScope?.active === true) return;
      signalChildTree(signal);
      if (ownsProcessGroup && forcedCleanup === undefined) {
        forcedCleanup = setTimeout(() => signalChildTree("SIGKILL"), 750);
      }
    };
    const forwardedSignals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
    for (const signal of forwardedSignals) process.on(signal, forward);
    // Lease admission alone is not child ownership. Before spawn succeeds, SIGINT
    // still cancels admission; the scope remains held until this exact child exits.
    if (ttySignalScope !== undefined) ttySignalScope.active = child.pid !== undefined;
    const removeSignalHandlers = (): void => {
      if (ttySignalScope !== undefined) ttySignalScope.active = false;
      for (const signal of forwardedSignals) process.off(signal, forward);
    };
    child.once("error", (error) => {
      removeSignalHandlers();
      if (forcedCleanup !== undefined) clearTimeout(forcedCleanup);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      removeSignalHandlers();
      if (forcedCleanup !== undefined) clearTimeout(forcedCleanup);
      void (async () => {
        if (processGroupExists()) {
          signalChildTree("SIGTERM");
          for (let attempt = 0; attempt < 10 && processGroupExists(); attempt += 1) {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
          }
          if (processGroupExists()) signalChildTree("SIGKILL");
        }
        resolveExit(code ?? (signal === null ? 1 : signalExitCode(signal)));
      })().catch(reject);
    });
  });
}

type InheritedLease = {
  readonly capacity: number;
  readonly lane: CapabilityLane;
  readonly mode: ResourceMode;
  readonly permits: number;
};

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parsedLeaseMode(value: unknown): ResourceMode | null {
  return value === "shared" || value === "heavy" || value === "exclusive" ? value : null;
}

function parsedLeaseCapacity(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 4
    ? Number(value)
    : null;
}

function expectedPermits(mode: ResourceMode, capacity: number): number {
  if (mode === "shared") return 1;
  if (mode === "heavy") return Math.min(2, capacity);
  return capacity;
}

export function parseInheritedLease(value: string): InheritedLease {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("inherited Oompa local-efficiency lease is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("inherited Oompa local-efficiency lease is malformed");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version === 1) {
    if (!hasExactKeys(record, ["capacity", "label", "mode", "permits", "version"])) {
      throw new Error("inherited Oompa local-efficiency lease is malformed");
    }
    const capacity = parsedLeaseCapacity(record.capacity);
    const mode = parsedLeaseMode(record.mode);
    if (
      capacity === null
      || mode === null
      || record.permits !== expectedPermits(mode, capacity)
      || typeof record.label !== "string"
    ) throw new Error("inherited Oompa local-efficiency lease is malformed");
    requireOperationLabel(record.label, "inherited lease label");
    return { capacity, lane: "compute", mode, permits: record.permits };
  }
  if (
    !hasExactKeys(record, ["capacity", "label", "lane", "mode", "permits", "version"])
    || record.version !== 2
    || (record.lane !== "compute" && record.lane !== "browser-auth" && record.lane !== "mac-native")
    || parsedLeaseMode(record.mode) === null
    || parsedLeaseCapacity(record.capacity) === null
    || typeof record.label !== "string"
  ) throw new Error("inherited Oompa local-efficiency lease is malformed");
  const capacity = parsedLeaseCapacity(record.capacity);
  const mode = parsedLeaseMode(record.mode);
  if (
    capacity === null
    || mode === null
    || record.permits !== expectedPermits(mode, capacity)
  ) throw new Error("inherited Oompa local-efficiency lease is malformed");
  requireOperationLabel(record.label, "inherited lease label");
  return { capacity, lane: record.lane, mode, permits: record.permits };
}

type InheritedMarker = {
  readonly claims: readonly { readonly amount: number; readonly resource: string }[];
  readonly owner: string;
  readonly phase: "A";
  readonly profileSha256: string;
  readonly ticket: string;
  readonly version: 1;
};

function inheritedMarker(descriptor: number): InheritedMarker {
  let metadata;
  try {
    metadata = fstatSync(descriptor);
  } catch {
    throw new Error("inherited Oompa local-efficiency lease descriptor is unavailable");
  }
  const owned = process.getuid === undefined || metadata.uid === process.getuid();
  if (
    !metadata.isFile()
    || metadata.nlink !== 1
    || !owned
    || (metadata.mode & 0o777) !== 0o600
    || metadata.size < 1
    || metadata.size > 4_096
  ) throw new Error("inherited Oompa local-efficiency lease descriptor is invalid");
  const bytes = Buffer.alloc(metadata.size);
  let offset = 0;
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  if (offset !== bytes.length) {
    throw new Error("inherited Oompa local-efficiency lease descriptor is incomplete");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  } catch {
    throw new Error("inherited Oompa local-efficiency lease descriptor is malformed");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("inherited Oompa local-efficiency lease descriptor is malformed");
  }
  const record = parsed as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["claims", "owner", "phase", "profileSha256", "ticket", "version"])
    || record.version !== 1
    || record.phase !== "A"
    || typeof record.owner !== "string"
    || !/^[0-9a-f]{32}$/u.test(record.owner)
    || typeof record.ticket !== "string"
    || !/^[1-9][0-9]{0,19}$/u.test(record.ticket)
    || typeof record.profileSha256 !== "string"
    || !/^[0-9a-f]{64}$/u.test(record.profileSha256)
    || !Array.isArray(record.claims)
  ) throw new Error("inherited Oompa local-efficiency lease descriptor is malformed");
  return parsed as InheritedMarker;
}

function expectedProfileDigest(profile: {
  readonly capacities: readonly { readonly limit: number; readonly resource: string }[];
  readonly id: string;
}): string {
  return sha256(JSON.stringify(profile));
}

// A lease inherited from a wrapper installed under the previous plugin
// identity carries the legacy profile id; both digests describe the same
// machine-wide scheduler and the same capacities.
const profileIdPrefixes = Object.freeze(["oompa.local-efficiency", "hra.local-efficiency"]);

function acceptedProfileDigests(profile: {
  readonly capacities: readonly { readonly limit: number; readonly resource: string }[];
  readonly id: string;
}): readonly string[] {
  return profileIdPrefixes.map((prefix) => expectedProfileDigest({
    id: `${prefix}/${profile.id}`,
    capacities: profile.capacities,
  }));
}

function assertMarker(
  descriptor: number,
  profileDigests: readonly string[],
  claims: readonly { readonly amount: number; readonly resource: string }[],
): void {
  const marker = inheritedMarker(descriptor);
  if (
    !profileDigests.includes(marker.profileSha256)
    || JSON.stringify(marker.claims) !== JSON.stringify(claims)
  ) throw new Error("inherited Oompa local-efficiency lease descriptor does not cover this request");
}

function assertInheritedLeaseDescriptors(inherited: InheritedLease): void {
  if (inherited.capacity !== permitCapacity()) {
    throw new Error("inherited Oompa local-efficiency lease capacity changed");
  }
  let descriptor = 3;
  if (inherited.lane !== "compute") {
    assertMarker(
      descriptor,
      acceptedProfileDigests({
        id: "capabilities-v1",
        capacities: [
          { resource: "browser-auth", limit: 1 },
          { resource: "mac-native", limit: 1 },
        ],
      }),
      [{ resource: inherited.lane, amount: 1 }],
    );
    descriptor += 1;
  }
  assertMarker(
    descriptor,
    acceptedProfileDigests({
      id: `v1-${inherited.capacity}`,
      capacities: [{ resource: "cpu", limit: inherited.capacity }],
    }),
    [{ resource: "cpu", amount: inherited.permits }],
  );
}

function signalExitCode(signal: NodeJS.Signals): number {
  return 128 + osConstants.signals[signal];
}

function modeRank(mode: ResourceMode): number {
  if (mode === "shared") return 1;
  if (mode === "heavy") return 2;
  return 3;
}

export function inheritedLeaseCovers(
  inherited: InheritedLease,
  requested: Pick<HostRunOptions, "lane" | "mode">,
): boolean {
  const capabilityCovered = requested.lane === "compute" || inherited.lane === requested.lane;
  return capabilityCovered && modeRank(inherited.mode) >= modeRank(requested.mode);
}

export function permissionBoundaryDenied(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    if (
      "code" in current
      && (current.code === "EACCES" || current.code === "EPERM")
    ) return true;
    try {
      current = "cause" in current ? current.cause : undefined;
    } catch {
      return false;
    }
  }
  return false;
}

/** Opt-in signal semantics must not reuse a default command's validation digest. */
export function hostCommandDigest(command: readonly string[], scope: string, owner: TtySignalOwner = "parent"): string {
  return owner === "child" ? sha256(JSON.stringify({ command, scope, ttySignalOwner: "child" })) : commandDigest(command, scope);
}

export function capabilityPlatformSupported(
  lane: CapabilityLane,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return lane !== "mac-native" || platform === "darwin";
}

function requireTtySignalOwner(value: unknown): TtySignalOwner | undefined {
  if (value === undefined || value === "parent" || value === "child") return value;
  throw new Error("invalid TTY signal owner");
}

export async function runHostCommand(options: HostRunOptions): Promise<number> {
  const environment = { ...(options.environment ?? process.env) };
  const ttySignalOwner = requireTtySignalOwner(options.ttySignalOwner);
  const ttySignalScope: ChildTtySignalScope | undefined = ttySignalOwner === "child" ? { active: false } : undefined;
  if (ttySignalScope !== undefined) assertChildTtySignalOwner();
  if (!capabilityPlatformSupported(options.lane)) {
    throw new Error("the mac-native capability lane requires macOS");
  }
  const inheritedValue = environment.OOMPA_LOCAL_EFFICIENCY_LEASE ?? environment.HRA_LOCAL_EFFICIENCY_LEASE;
  if (inheritedValue !== undefined) {
    const inherited = parseInheritedLease(inheritedValue);
    if (!inheritedLeaseCovers(inherited, options)) {
      throw new Error("nested oompa-host-run cannot escalate its outer mode or capability lane");
    }
    assertInheritedLeaseDescriptors(inherited);
    return spawnCommand(options.command, options.cwd, environment, [], ttySignalScope);
  }
  const capacity = permitCapacity();
  const permitCount = permitsForMode(options.mode);
  const stateRoot = options.stateRoot
    ?? resolveHostResourceStateRoot(environment);
  const queuedAtMonotonic = performance.now();
  const queuedAt = new Date();
  console.error(
    `[oompa-host-run] waiting for ${options.mode} ${options.lane} ${options.label}`
    + ` (${permitCount}/${capacity} permits)`,
  );
  const execution: { admittedAt: Date | null; recorded: boolean; runStartedAt: number | null } = {
    admittedAt: null,
    recorded: false,
    runStartedAt: null,
  };
  const scope = scopeDigest(options.cwd);
  const digest = hostCommandDigest(options.command, scope, ttySignalOwner);
  const telemetryRoot = throughputTelemetryRoot(stateRoot);
  const record = (
    outcome: "canceled" | "fail" | "pass" | "scheduler-error" | "spawn-error",
    exitCode: number | null,
  ): void => {
    if (execution.recorded) return;
    execution.recorded = true;
    if ((environment.OOMPA_LOCAL_EFFICIENCY_TELEMETRY ?? environment.HRA_LOCAL_EFFICIENCY_TELEMETRY) === "off") return;
    const finishedAt = new Date();
    try {
      appendThroughputEvent(telemetryRoot, newThroughputEvent({
        admittedAt: execution.admittedAt?.toISOString() ?? null,
        capacity,
        capability: options.lane,
        commandDigest: digest,
        exitCode,
        finishedAt: finishedAt.toISOString(),
        label: options.label,
        mode: options.mode,
        outcome,
        permits: permitCount,
        program: commandProgramLabel(options.command[0] ?? "command"),
        queueMilliseconds: Math.max(0, Math.round(
          (execution.runStartedAt ?? performance.now()) - queuedAtMonotonic,
        )),
        queuedAt: queuedAt.toISOString(),
        runMilliseconds: execution.runStartedAt === null
          ? null
          : Math.max(0, Math.round(performance.now() - execution.runStartedAt)),
        scopeDigest: scope,
      }));
    } catch {
      console.error("[oompa-host-run] throughput telemetry unavailable");
    }
  };
  const cancellation = new AbortController();
  const cancellationState: { signal: NodeJS.Signals | null } = { signal: null };
  let observer: QueueObserver | undefined;
  const cancel = (signal: NodeJS.Signals): void => {
    // During the admitted opted-in child, SIGINT belongs to its terminal policy.
    // Do not classify a successful local ceremony as canceled before it settles.
    if (signal === "SIGINT" && ttySignalScope?.active === true) return;
    if (cancellationState.signal !== null) return;
    cancellationState.signal = signal;
    observer?.settling();
    cancellation.abort();
    record("canceled", signalExitCode(signal));
  };
  const cancellationSignals = ["SIGHUP", "SIGINT", "SIGQUIT", "SIGTERM"] as const;
  for (const signal of cancellationSignals) process.on(signal, cancel);
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const isWaiting = (): boolean => !finished && execution.admittedAt === null && !cancellation.signal.aborted;
  const reportWait = async (): Promise<void> => {
    if (!isWaiting()) return;
    try {
      const snapshot = await readQueueSnapshot(stateRoot, options.lane);
      if (!isWaiting()) return;
      const holders = snapshot.owners.filter(owner => owner.capability === "reported-held");
      const details = holders.slice(0, 4).map(owner => `${owner.label} (${owner.stage}, held=${((owner.capabilityMilliseconds ?? 0) / 1000).toFixed(1)}s, run=${owner.runId}`
        + (owner.taskId === null ? "" : `, task=${owner.taskId}`) + ")");
      console.error(`[oompa-host-run] waiting ${((performance.now() - queuedAtMonotonic) / 1_000).toFixed(1)}s for ${options.label}; `
        + (details.length === 0 ? "holder unknown" : `reported holder: ${details.join(", ")}`)
        + "; partial observation, scheduler owns admission. Inspect: oompa-host-queue --lane=" + options.lane + " --json");
    } catch { /* Observation cannot fail admission. */ }
    if (isWaiting()) {
      progressTimer = setTimeout(() => { void reportWait(); }, 30_000);
      progressTimer.unref();
    }
  };
  try {
    const module = await hostResourceModule(environment);
    const cpuCoordinator = module.createHostResourceCoordinator({
      profile: {
        id: `oompa.local-efficiency/v1-${capacity}`,
        capacities: [{ resource: "cpu", limit: capacity }],
      },
      stateRoot,
      waitTimeoutMilliseconds: 24 * 60 * 60_000,
    });
    const capabilityCoordinator = options.lane === "compute"
      ? null
      : module.createHostResourceCoordinator({
        profile: {
          id: "oompa.local-efficiency/capabilities-v1",
          capacities: [
            { resource: "browser-auth", limit: 1 },
            { resource: "mac-native", limit: 1 },
          ],
        },
        stateRoot: resolveCapabilityStateRoot(stateRoot),
        waitTimeoutMilliseconds: 24 * 60 * 60_000,
      });
    if (cancellationState.signal !== null) return signalExitCode(cancellationState.signal);
    if (environment.OOMPA_LOCAL_EFFICIENCY_QUEUE !== "off") {
      try {
        observer = await startQueueObserver({ stateRoot, label: options.label, lane: options.lane, mode: options.mode,
          ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
          onHandoff(request) {
            console.error(`[oompa-host-run] handoff requested by ${request.requesterLabel} (request=${request.requestId}, run=${request.runId}). `
              + "Finish and collect this browser/native session before releasing its lane; do source editing and external waits after release. This notice does not interrupt the child.");
          } });
        console.error(`[oompa-host-run] queue run=${observer.runId}`);
        if (cancellation.signal.aborted) observer.settling();
      } catch {
        console.error("[oompa-host-run] queue visibility unavailable; scheduler admission unchanged");
      }
      progressTimer = setTimeout(() => { void reportWait(); }, 15_000);
      progressTimer.unref();
    }
    const runWithCpu = async (outerDescriptors: readonly number[]): Promise<number> => {
      return cpuCoordinator.withLease(
        [{ resource: "cpu", amount: permitCount }],
        async (lease) => {
          observer?.cpuAdmitted();
          if (progressTimer !== undefined) clearTimeout(progressTimer);
          execution.admittedAt = new Date();
          execution.runStartedAt = performance.now();
          const waitedSeconds = (execution.runStartedAt - queuedAtMonotonic) / 1_000;
          console.error(
            `[oompa-host-run] admitted ${options.label} after ${waitedSeconds.toFixed(1)}s`,
          );
          const leaseValue = JSON.stringify({
            capacity,
            label: options.label,
            lane: options.lane,
            mode: options.mode,
            permits: permitCount,
            version: 2,
          });
          // Nested wrappers installed under the previous plugin identity read
          // only the legacy name; both names carry the identical lease.
          const childEnvironment = {
            ...environment,
            HRA_LOCAL_EFFICIENCY_LEASE: leaseValue,
            OOMPA_LOCAL_EFFICIENCY_LEASE: leaseValue,
          };
          try {
            const exitCode = await spawnCommand(
              options.command,
              options.cwd,
              childEnvironment,
              [...outerDescriptors, lease.inheritedFileDescriptor],
              ttySignalScope,
            );
            record(exitCode === 0 ? "pass" : "fail", exitCode);
            return exitCode;
          } catch (error: unknown) {
            record("spawn-error", null);
            throw error;
          } finally {
            observer?.settling();
          }
        },
        {
          signal: cancellation.signal,
          waitTimeoutMilliseconds: 24 * 60 * 60_000,
        },
      );
    };
    if (capabilityCoordinator === null) return await runWithCpu([]);
    return await capabilityCoordinator.withLease(
      [{ resource: options.lane, amount: 1 }],
      async (lease) => {
        observer?.capabilityAdmitted();
        try { return await runWithCpu([lease.inheritedFileDescriptor]); }
        finally { observer?.settling(); }
      },
      {
        signal: cancellation.signal,
        waitTimeoutMilliseconds: 24 * 60 * 60_000,
      },
    );
  } catch (error: unknown) {
    if (cancellationState.signal !== null) return signalExitCode(cancellationState.signal);
    record("scheduler-error", null);
    if (execution.admittedAt === null && permissionBoundaryDenied(error)) {
      throw new HostAccessRequiredError();
    }
    throw error;
  } finally {
    finished = true;
    if (progressTimer !== undefined) clearTimeout(progressTimer);
    try { await observer?.close(); } catch { /* Observation cannot change the command outcome. */ }
    for (const signal of cancellationSignals) process.off(signal, cancel);
  }
}

function usage(): string {
  return "Usage: oompa-host-run --mode=shared|heavy|exclusive"
    + " [--lane=compute|browser-auth|mac-native] [--label=LABEL]"
    + " [--task-id=UUID]"
    + " [--tty-signal-owner=parent|child] -- COMMAND [ARGUMENT ...]";
}

if (import.meta.main) {
  try {
    const parsed = parseHostRunArguments(process.argv.slice(2));
    process.exitCode = await runHostCommand({ ...parsed, cwd: process.cwd() });
  } catch (error) {
    if (error instanceof HostAccessRequiredError) {
      console.error(`[oompa-host-run] ${error.code}: ${error.message}`);
      process.exitCode = hostAccessRequiredExitCode;
    } else {
      console.error(`[oompa-host-run] ${error instanceof Error ? error.message : String(error)}`);
      console.error(usage());
      process.exitCode = 1;
    }
  }
}
