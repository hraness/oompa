import type { ClaudeProcess, ClaudeProcessIdentity } from "../claude/process";
import type { PinnedClaudeRuntime, ResolvePinnedClaudeRuntimeOptions } from "../claude/runtime";
import type { ClaudeProcessFactory } from "./claude-runtime-adapter";

export type PersonalClaudeAcceptanceLaunch = Parameters<ClaudeProcessFactory>[0];

/** Observes the actual process. It cannot replace its identity, output or exit. */
export type PersonalClaudeAcceptanceProcessObservation = Readonly<{
  identity(value: ClaudeProcessIdentity): void;
  identityFailed(): void;
  rootExited(code: number): void;
  streamEnded(channel: "stdout" | "stderr"): void;
  assertWrite(bytes: Uint8Array): void;
  /** The real local stdin write fulfilled. A test may deliberately withhold its acknowledgment. */
  writeAccepted(bytes: Uint8Array): void;
}>;

/** Only runDaemon's explicit live_acceptance composition may receive this port. */
export type LiveAcceptancePersonalClaudeProofPort = Readonly<{
  executablePath: string;
  environment: Readonly<Record<string, string>>;
  beginDaemonGeneration(generation: number): void;
  assertRuntimeRequest(input: ResolvePinnedClaudeRuntimeOptions): void;
  runtimeAdmitted(runtime: PinnedClaudeRuntime): void;
  runtimeFailed(): void;
  prepareLaunch(launch: PersonalClaudeAcceptanceLaunch): PersonalClaudeAcceptanceProcessObservation;
  observeWrites(): Readonly<{ userWriteAttempts: number; acceptedUserWrites: number; acknowledgmentWithheld: boolean }>;
  closeAdmission(): void;
  closeDaemonGeneration(generation: number | null): Promise<void>;
}>;

/** Internal observation adapter. Callers retain the original physical child. */
export function observePersonalClaudeAcceptanceProcess(
  child: ClaudeProcess,
  observation: PersonalClaudeAcceptanceProcessObservation,
): ClaudeProcess {
  const identity = child.identity.then((value) => {
    observation.identity(Object.freeze({ ...value }));
    return value;
  }, (error: unknown) => {
    observation.identityFailed();
    throw error;
  });
  const exited = child.exited.then((code) => {
    observation.rootExited(code);
    return code;
  });
  // The client also observes these promises. Early rejection must not become an
  // unrelated unhandled rejection before the client attaches its observers.
  void identity.catch(() => undefined);
  void exited.catch(() => undefined);
  const stream = (source: AsyncIterable<Uint8Array>, channel: "stdout" | "stderr"): AsyncIterable<Uint8Array> => ({
    async *[Symbol.asyncIterator]() {
      for await (const bytes of source) yield bytes;
      observation.streamEnded(channel);
    },
  });
  return {
    identity,
    exited,
    stdout: stream(child.stdout, "stdout"),
    stderr: stream(child.stderr, "stderr"),
    async write(bytes) {
      const snapshot = Uint8Array.from(bytes);
      try {
        const observeBytes = (observe: (value: Uint8Array) => void) => {
          const copy = Uint8Array.from(snapshot);
          try { observe(copy); } finally { copy.fill(0); }
        };
        // Observation is not a byte transformation port. A collector cannot
        // change what the original child receives or what the caller owns.
        observeBytes((value) => observation.assertWrite(value));
        await child.write(snapshot);
        observeBytes((value) => observation.writeAccepted(value));
      } finally { snapshot.fill(0); }
    },
    terminate: () => child.terminate(),
    forceTerminate: () => child.forceTerminate(),
  };
}

/** Closed read-only evidence; an absent hook does not add production fields. */
export function personalClaudeAcceptanceStatus(proof: Pick<LiveAcceptancePersonalClaudeProofPort, "observeWrites"> | undefined) {
  if (proof === undefined) return {};
  const value = proof.observeWrites();
  if (Object.keys(value).length !== 3 || !Number.isSafeInteger(value.userWriteAttempts)
    || value.userWriteAttempts < 0 || value.userWriteAttempts > 3
    || !Number.isSafeInteger(value.acceptedUserWrites) || value.acceptedUserWrites < 0
    || value.acceptedUserWrites > 2 || value.acceptedUserWrites > value.userWriteAttempts
    || typeof value.acknowledgmentWithheld !== "boolean") {
    throw new Error("Personal Claude acceptance status was refused.");
  }
  return { liveAcceptancePersonalClaude: Object.freeze({ userWriteAttempts: value.userWriteAttempts,
    acceptedUserWrites: value.acceptedUserWrites, acknowledgmentWithheld: value.acknowledgmentWithheld }) };
}
