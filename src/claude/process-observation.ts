import type { ClaudeProcess, ClaudeProcessIdentity } from "./process";

/** Observes the actual process. It cannot replace its identity, output or exit. */
export type ClaudeProcessObservation = Readonly<{
  identity(value: ClaudeProcessIdentity): void;
  identityFailed(): void;
  rootExited(code: number): void;
  streamEnded(channel: "stdout" | "stderr"): void;
  assertWrite(bytes: Uint8Array): void;
  /** The original local stdin write fulfilled. Observer failure does not undo its possible effect. */
  writeAccepted(bytes: Uint8Array): void;
}>;

/** Internal observation adapter. Callers retain the original physical child. */
export function observeClaudeProcess(
  child: ClaudeProcess,
  observation: ClaudeProcessObservation,
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
