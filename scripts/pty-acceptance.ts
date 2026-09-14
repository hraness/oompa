import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PTY_BEGIN_MARKER = "__OOMPA_PTY_BEGIN__";
export const PTY_END_MARKER = "__OOMPA_PTY_END__";

const ptyOutputMaximumBytes = 1024 * 1024;
const ptyStepMaximumCount = 64;
const ptyAuthorityScanMaximumBytes = 16 * 1024;
const ptyInitialInterruptGraceMs = 150;
const ptyTerminationGraceMs = 400;
const ptyForcedTerminationGraceMs = 800;
const ptyHardSettlementMs = 1_600;
const ptyGroupPollMs = 20;

export type PseudoTerminalStep = Readonly<{
  expect: string;
  write?: string;
}>;

export type PseudoTerminalResult = Readonly<{
  exitCode: number;
  stderr: string;
  stdout: string;
}>;

type PseudoTerminalInput = Readonly<{
  command: readonly [string, ...string[]];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  steps?: readonly PseudoTerminalStep[];
  temporaryDirectory: string;
  timeoutMs?: number;
}>;

const wrapperSource = (authorityMarker: string): string => `#!/bin/sh
set -u
hra_pgid="$($OOMPA_PTY_PS -o pgid= -p "$$")" || exit 88
if [ "$hra_pgid" -ne "$$" ]; then exit 89; fi
initial_mode="$($OOMPA_PTY_STTY -g)" || exit 90
printf '\n${authorityMarker}\t%s\n' "$$"
printf '\n${PTY_BEGIN_MARKER}\n'
# The foreground child owns Ctrl-C; keep the harness alive to report its final status.
trap ':' 2
"$@"
command_status=$?
trap - 2
final_mode="$($OOMPA_PTY_STTY -g)" || exit 91
if [ "$initial_mode" != "$final_mode" ]; then
  printf '\n${PTY_END_MARKER}\t%s\tchanged\n' "$command_status"
  exit 92
fi
printf '\n${PTY_END_MARKER}\t%s\trestored\n' "$command_status"
exit "$command_status"
`;

const shellQuote = (value: string): string => {
  if (value.includes("\0")) throw new Error("Pseudo-terminal command arguments cannot contain NUL bytes.");
  return `'${value.replaceAll("'", "'\\''")}'`;
};

const expectHex = (value: string): string => Buffer.from(value, "utf8").toString("hex");

const expectDriverSource = (steps: readonly PseudoTerminalStep[], timeoutMs: number): string => {
  const timeoutSeconds = Math.max(1, Math.floor(Math.max(1, timeoutMs - 1_000) / 1_000));
  const interactions = steps.map((step) => [
    `expect_exact_or_fail ${expectHex(step.expect)}`,
    ...(step.write === undefined
      ? []
      : [`send -- [binary format H* ${expectHex(step.write)}]`]),
  ].join("\n")).join("\n");
  return `#!/usr/bin/expect -f
set timeout ${String(timeoutSeconds)}
match_max ${String(ptyOutputMaximumBytes)}
log_user 1
proc expect_exact_or_fail {encoded} {
  set expected [binary format H* $encoded]
  expect {
    -exact $expected { return }
    timeout { puts stderr "PTY expectation timed out."; exit 124 }
    eof { puts stderr "PTY command exited before an expectation."; exit 125 }
  }
}
spawn -noecho {*}$argv
${interactions}
expect {
  eof {}
  timeout { puts stderr "PTY command did not exit after its final interaction."; exit 124 }
}
set waited [wait]
if {[lindex $waited 2] != 0} { exit 126 }
exit [lindex $waited 3]
`;
};

export const pseudoTerminalScriptArguments = (
  platform: NodeJS.Platform,
  wrapperPath: string,
  command: readonly [string, ...string[]],
): readonly string[] => {
  if (platform === "darwin") {
    return ["-q", "-e", "/dev/null", "/bin/sh", wrapperPath, ...command];
  }
  if (platform === "linux") {
    const invocation = ["/bin/sh", wrapperPath, ...command].map(shellQuote).join(" ");
    return ["-q", "-e", "-c", invocation, "/dev/null"];
  }
  throw new Error(`Pseudo-terminal acceptance is unsupported on ${platform}.`);
};

const terminalStateExecutable = (platform: NodeJS.Platform): string => {
  if (platform === "darwin") return "/bin/stty";
  if (platform === "linux") return "/usr/bin/stty";
  throw new Error(`Pseudo-terminal acceptance is unsupported on ${platform}.`);
};

const processInspectionExecutable = (platform: NodeJS.Platform): string => {
  if (platform === "darwin" || platform === "linux") return "/bin/ps";
  throw new Error(`Pseudo-terminal acceptance is unsupported on ${platform}.`);
};

const boundedTranscript = (stdout: Buffer[], stderr: Buffer[]): string => {
  const combined = Buffer.concat([...stderr, ...stdout]);
  const bounded = combined.subarray(0, ptyOutputMaximumBytes).toString("utf8");
  return combined.byteLength > ptyOutputMaximumBytes
    ? `${bounded}\n[PTY transcript exceeded its ${String(ptyOutputMaximumBytes)}-byte bound.]`
    : bounded;
};

export const readPseudoTerminalAuthorityLine = (transcript: string, marker: string): number | undefined => {
  const prefix = `\n${marker}\t`;
  const start = transcript.indexOf(prefix);
  if (start < 0) return undefined;
  const valueStart = start + prefix.length;
  const end = transcript.indexOf("\n", valueStart);
  // A numeric prefix is not authority: stdout can split inside the PID.
  if (end < 0) return undefined;
  const line = transcript.slice(valueStart, end).replace(/\r$/u, "");
  if (!/^[1-9][0-9]*$/u.test(line)) return undefined;
  const value = Number(line);
  return Number.isSafeInteger(value) && value > 1 && value !== process.pid ? value : undefined;
};

export const observePseudoTerminalCleanup = (
  cleanup: Promise<void>,
): Promise<PromiseSettledResult<void>> => cleanup.then(
  () => ({ status: "fulfilled", value: undefined }),
  (reason: unknown) => ({ status: "rejected", reason }),
);

export const settlePseudoTerminalCleanup = async (input: Readonly<{
  termination: () => Promise<PromiseSettledResult<void>> | undefined;
  observeExit: () => Promise<boolean>;
  requestTermination: () => void;
  markLingering: () => void;
  finalize: () => void;
}>): Promise<Error | undefined> => {
  let cleanupError: Error | undefined;
  try {
    if (input.termination() === undefined) {
      try {
        if (!await input.observeExit()) {
          input.markLingering();
          input.requestTermination();
        }
      } catch (error: unknown) {
        cleanupError = error instanceof Error
          ? error
          : new Error("Pseudo-terminal group observation threw a non-Error value.");
        input.requestTermination();
      }
    }
    const termination = input.termination();
    if (termination !== undefined) {
      const cleanup = await termination;
      if (cleanup.status === "rejected") {
        cleanupError ??= cleanup.reason instanceof Error
          ? cleanup.reason
          : new Error("Pseudo-terminal cleanup threw a non-Error value.");
      }
    }
    return cleanupError;
  } finally {
    input.finalize();
  }
};

const groupExists = (groupId: number): boolean => {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const signalGroup = (groupId: number, signal: NodeJS.Signals): boolean => {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};

const sleep = async (milliseconds: number): Promise<void> => {
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));
};

export const createPseudoTerminalGroupCleanup = (input: Readonly<{
  groupIds: () => readonly number[];
  exists: (groupId: number) => boolean;
  signal: (groupId: number, signal: NodeJS.Signals) => boolean;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}>): Readonly<{
  signalOwnedGroups: (signal: NodeJS.Signals) => void;
  waitForGroupsGone: (maximumWaitMs: number) => Promise<boolean>;
  assertGroupsGone: () => void;
}> => {
  // Absence is final: never signal a reused numeric group after an ESRCH proof.
  const gone = new Set<number>();
  const denied = new Map<number, Error>();
  let unexpected: Error | undefined;
  const observe = (groupId: number, operation: () => boolean): boolean => {
    if (gone.has(groupId)) return true;
    try {
      if (!operation()) {
        gone.add(groupId);
        denied.delete(groupId);
        return true;
      }
    } catch (error: unknown) {
      const failure = error instanceof Error
        ? error
        : new Error("Pseudo-terminal group operation threw a non-Error value.");
      // Darwin can refuse a group during exit. Only later ESRCH resolves that uncertainty.
      if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
        denied.set(groupId, failure);
      } else {
        unexpected ??= failure;
      }
    }
    return false;
  };
  const probeOwnedGroups = (): boolean => {
    let allGone = true;
    for (const groupId of input.groupIds()) {
      if (!observe(groupId, () => input.exists(groupId))) allGone = false;
    }
    return allGone;
  };
  return {
    signalOwnedGroups: (signal) => {
      // A refused operation must not prevent collection of the other owned group.
      for (const groupId of input.groupIds()) observe(groupId, () => input.signal(groupId, signal));
    },
    waitForGroupsGone: async (maximumWaitMs) => {
      const deadline = input.now() + maximumWaitMs;
      do {
        if (probeOwnedGroups()) return true;
        await input.sleep(ptyGroupPollMs);
      } while (input.now() <= deadline);
      return probeOwnedGroups();
    },
    assertGroupsGone: () => {
      if (unexpected !== undefined) throw unexpected;
      const remaining = input.groupIds().filter((groupId) => !gone.has(groupId));
      if (remaining.length === 0) return;
      for (const groupId of remaining) {
        const failure = denied.get(groupId);
        if (failure !== undefined) throw failure;
      }
      throw new Error(`Pseudo-terminal cleanup could not prove exit of owned process groups ${remaining.join(", ")}.`);
    },
  };
};

export async function runInPseudoTerminal(input: PseudoTerminalInput): Promise<PseudoTerminalResult> {
  const steps = input.steps ?? [];
  if (steps.length > ptyStepMaximumCount) {
    throw new Error(`Pseudo-terminal acceptance permits at most ${String(ptyStepMaximumCount)} interaction steps.`);
  }
  for (const step of steps) {
    if (step.expect.length === 0) throw new Error("Pseudo-terminal expectations cannot be empty.");
    if (Buffer.byteLength(step.expect) > ptyOutputMaximumBytes) {
      throw new Error("A pseudo-terminal expectation exceeds the transcript bound.");
    }
    if (step.write !== undefined && Buffer.byteLength(step.write) > ptyOutputMaximumBytes) {
      throw new Error("A pseudo-terminal write exceeds the transcript bound.");
    }
  }

  const authorityMarker = `__OOMPA_PTY_AUTHORITY_${crypto.randomUUID()}__`;
  const wrapperPath = join(input.temporaryDirectory, `.oompa-pty-${crypto.randomUUID()}.sh`);
  const expectPath = join(input.temporaryDirectory, `.oompa-pty-${crypto.randomUUID()}.expect`);
  await writeFile(wrapperPath, wrapperSource(authorityMarker), { encoding: "utf8", flag: "wx", mode: 0o700 });
  const timeoutMs = input.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new Error("Pseudo-terminal acceptance requires a timeout from 1ms through 10 minutes.");
  }
  if (process.platform === "darwin") {
    await writeFile(expectPath, expectDriverSource(steps, timeoutMs), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o700,
    });
  }
  try {
    const scriptArguments = pseudoTerminalScriptArguments(process.platform, wrapperPath, input.command);
    const driverOwnsInteraction = process.platform === "darwin";
    const child = spawn(
      driverOwnsInteraction ? "/usr/bin/expect" : "/usr/bin/script",
      driverOwnsInteraction
        ? ["-f", expectPath, "/usr/bin/script", ...scriptArguments]
        : scriptArguments,
      {
        cwd: input.cwd,
        detached: true,
        env: {
          ...input.environment,
          OOMPA_PTY_PS: processInspectionExecutable(process.platform),
          OOMPA_PTY_STTY: terminalStateExecutable(process.platform),
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.stdin.on("error", () => undefined);
    const driverPid = child.pid;
    if (driverPid === undefined || driverPid <= 1 || driverPid === process.pid) {
      child.kill("SIGKILL");
      throw new Error("Pseudo-terminal driver started without a safe exact process-group identity.");
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let authorityScan = "";
    let authorityPid: number | undefined;
    const wrapperObservation = { began: false };
    let cursor = 0;
    let stepIndex = 0;
    const failureState = { lingering: false, overflowed: false, timedOut: false };
    let terminationPromise: Promise<PromiseSettledResult<void>> | undefined;
    let hardSettlementTimer: ReturnType<typeof setTimeout> | undefined;
    let settleWithoutClose: (() => void) | undefined;

    const groupIds = (): readonly number[] => authorityPid === undefined || authorityPid === driverPid
      ? [driverPid]
      : [driverPid, authorityPid];
    const groupCleanup = createPseudoTerminalGroupCleanup({
      groupIds,
      exists: groupExists,
      signal: signalGroup,
      now: Date.now,
      sleep,
    });

    const observeAuthority = (chunk: Buffer): void => {
      if (authorityPid !== undefined || authorityScan.length >= ptyAuthorityScanMaximumBytes) return;
      authorityScan += chunk.toString("utf8");
      if (Buffer.byteLength(authorityScan) > ptyAuthorityScanMaximumBytes) {
        authorityScan = authorityScan.slice(0, ptyAuthorityScanMaximumBytes);
      }
      const value = readPseudoTerminalAuthorityLine(authorityScan, authorityMarker);
      if (value !== undefined) {
        if (!Number.isSafeInteger(value) || value <= 1 || value === process.pid) {
          failureState.lingering = true;
          return;
        }
        authorityPid = value;
      }
      if (authorityScan.includes(PTY_BEGIN_MARKER)) wrapperObservation.began = true;
    };

    const requestBoundedTermination = (): void => {
      if (terminationPromise !== undefined) return;
      try { child.stdin.write("\x03"); } catch { /* The PTY may already be closed. */ }
      terminationPromise = observePseudoTerminalCleanup((async () => {
        await sleep(ptyInitialInterruptGraceMs);
        groupCleanup.signalOwnedGroups("SIGTERM");
        if (!await groupCleanup.waitForGroupsGone(ptyTerminationGraceMs)) {
          groupCleanup.signalOwnedGroups("SIGKILL");
          await groupCleanup.waitForGroupsGone(ptyForcedTerminationGraceMs);
        }
        groupCleanup.assertGroupsGone();
      })());
      hardSettlementTimer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        settleWithoutClose?.();
      }, ptyHardSettlementMs);
    };

    const advance = (): void => {
      if (driverOwnsInteraction) return;
      const transcript = Buffer.concat(stdout).toString("utf8");
      while (stepIndex < steps.length) {
        const step = steps[stepIndex];
        if (step === undefined) break;
        const found = transcript.indexOf(step.expect, cursor);
        if (found < 0) break;
        cursor = found + step.expect.length;
        stepIndex += 1;
        if (step.write !== undefined) child.stdin.write(step.write);
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      observeAuthority(chunk);
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > ptyOutputMaximumBytes) {
        failureState.overflowed = true;
        requestBoundedTermination();
        return;
      }
      stdout.push(chunk);
      advance();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > ptyOutputMaximumBytes) {
        failureState.overflowed = true;
        requestBoundedTermination();
        return;
      }
      stderr.push(chunk);
    });

    const resultPromise = new Promise<PseudoTerminalResult>((resolvePromise, reject) => {
      let settled = false;
      const settle = (result: PseudoTerminalResult): void => {
        if (settled) return;
        settled = true;
        resolvePromise(result);
      };
      settleWithoutClose = () => settle({
        exitCode: 1,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (exitCode) => {
        settle({
          exitCode: exitCode ?? 1,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
        });
      });
    });

    const timeout = setTimeout(() => {
      failureState.timedOut = true;
      requestBoundedTermination();
    }, timeoutMs);

    let result: PseudoTerminalResult;
    let processError: Error | undefined;
    try {
      result = await resultPromise;
    } catch (error: unknown) {
      processError = error instanceof Error
        ? error
        : new Error("Pseudo-terminal driver threw a non-Error value.");
      requestBoundedTermination();
      settleWithoutClose?.();
      result = await resultPromise.catch(() => ({ exitCode: 1, stderr: "", stdout: "" }));
    }

    let cleanupError = await settlePseudoTerminalCleanup({
      termination: () => terminationPromise,
      observeExit: async () => await groupCleanup.waitForGroupsGone(250),
      requestTermination: requestBoundedTermination,
      markLingering: () => { failureState.lingering = true; },
      finalize: () => {
        clearTimeout(timeout);
        if (hardSettlementTimer !== undefined) clearTimeout(hardSettlementTimer);
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      },
    });

    try {
      groupCleanup.assertGroupsGone();
    } catch (error: unknown) {
      cleanupError ??= error instanceof Error
        ? error
        : new Error("Pseudo-terminal cleanup threw a non-Error value.");
    }
    if (wrapperObservation.began && authorityPid === undefined) {
      cleanupError ??= new Error("Pseudo-terminal wrapper began without publishing its exact owned process group.");
    }
    if (cleanupError !== undefined) throw cleanupError;
    if (processError !== undefined) throw processError;
    if (failureState.timedOut) {
      throw new Error(`Pseudo-terminal journey exceeded its deadline:\n${boundedTranscript(stdout, stderr)}`);
    }
    if (failureState.overflowed) {
      throw new Error(`Pseudo-terminal journey exceeded its output bound:\n${boundedTranscript(stdout, stderr)}`);
    }
    if (failureState.lingering) {
      throw new Error(`Pseudo-terminal journey left an owned process group after driver exit:\n${boundedTranscript(stdout, stderr)}`);
    }
    if (authorityPid === undefined) {
      throw new Error("Pseudo-terminal wrapper did not publish its exact owned process group.");
    }
    if (driverOwnsInteraction && result.exitCode === 0) stepIndex = steps.length;
    if (stepIndex !== steps.length) {
      const missing = steps[stepIndex]?.expect ?? "an unknown terminal expectation";
      throw new Error(`Pseudo-terminal journey exited before ${JSON.stringify(missing)}:\n${boundedTranscript(stdout, stderr)}`);
    }
    return result;
  } finally {
    await Promise.all([
      rm(wrapperPath, { force: true }),
      rm(expectPath, { force: true }),
    ]);
  }
}

export function assertPseudoTerminalSuccess(result: PseudoTerminalResult): void {
  if (result.exitCode !== 0) {
    throw new Error(`Pseudo-terminal command failed with exit ${String(result.exitCode)}:\n${result.stderr}${result.stdout}`);
  }
  if (result.stderr !== "") {
    throw new Error(`Pseudo-terminal driver wrote diagnostics outside the PTY:\n${result.stderr}`);
  }
  const beginCount = result.stdout.split(PTY_BEGIN_MARKER).length - 1;
  const endCount = result.stdout.split(PTY_END_MARKER).length - 1;
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error("Pseudo-terminal wrapper markers were missing or repeated.");
  }
  if (!result.stdout.includes(`${PTY_END_MARKER}\t0\trestored`)) {
    throw new Error("The pseudo-terminal command did not restore its exact initial terminal mode.");
  }
}
