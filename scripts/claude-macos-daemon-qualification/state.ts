import { z } from "zod";

const tag = z.string().regex(/^[a-f0-9]{64}$/u);
const generation = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const scopeFields = {
  version: z.literal(1), sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
  runId: z.string().uuid(), threadTag: tag, commandTag: tag,
};
const scopeSchema = z.strictObject(scopeFields);
const common = {
  ...scopeFields, generationStage: z.enum(["A", "B", "C"]),
  daemonGeneration: generation, daemonNonce: z.string().uuid(),
  // Count synchronous user-frame admission attempts, including refused attempts.
  // Provider initialization and read-only control frames are not user writes.
  userWriteAttempts: z.number().int().min(0).max(2),
};
const intentFields = {
  intentTag: tag, idempotencyTag: tag, originalDaemonGeneration: generation,
  retainedIntentState: z.literal("ambiguous"), dispatchCount: z.literal(1),
};
const eventSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...common, type: z.literal("ready") }),
  z.strictObject({ ...common, type: z.literal("normalTurn"), turnTag: tag, promptNonce: z.string().uuid(),
    resumed: z.boolean(), acknowledged: z.literal(true), completed: z.literal(true), nonceMatched: z.literal(true) }),
  z.strictObject({ ...common, ...intentFields, type: z.literal("acknowledgmentLost"),
    localStdinAccepted: z.literal(true), acknowledgmentWithheld: z.literal(true),
    operation: z.literal("indeterminate"), remoteAcknowledgment: z.literal("unestablished"),
    remoteEffect: z.literal("unestablished") }),
  z.strictObject({ ...common, ...intentFields, type: z.literal("retryAmbiguous"),
    result: z.literal("ambiguous"), newUserWriteAttempts: z.literal(0) }),
  z.strictObject({ ...common, type: z.literal("joined"),
    daemonRootCollected: z.literal(true), daemonStdoutEof: z.literal(true), daemonStderrEof: z.literal(true),
    providerRootsCollected: z.literal(true), providerStdoutEof: z.literal(true), providerStderrEof: z.literal(true),
    runtimeObserversJoined: z.literal(true), identityInspectorsJoined: z.literal(true),
    daemonAuthorityReleased: z.literal(true) }),
]);

export type DaemonRestartScope = Readonly<z.infer<typeof scopeSchema>>;
export type DaemonRestartEvent = Readonly<z.infer<typeof eventSchema>>;
export type DaemonRestartStage = DaemonRestartEvent["generationStage"];
export type DaemonRestartReceipt = Readonly<DaemonRestartScope & {
  evidenceOnly: true; completed: true; eventCount: 10;
  generations: readonly Readonly<{ generationStage: DaemonRestartStage; daemonGeneration: number; daemonNonce: string }>[];
  intentTag: string; idempotencyTag: string; originalDaemonGeneration: number;
  operation: "indeterminate"; retryResult: "ambiguous"; replayUserWriteAttempts: 0;
  physicalObservation: "daemon-provider-roots-streams-and-observers-joined";
}>;

export class DaemonRestartObservationError extends Error {
  constructor(readonly code: "scope_refused" | "observation_refused" | "sequence_refused" | "incomplete") {
    super(`DARWIN_DAEMON_RESTART_${code}`); this.name = "DaemonRestartObservationError";
  }
}

const sequence = [
  ["A", "ready", 0], ["A", "normalTurn", 1], ["A", "joined", 1],
  ["B", "ready", 0], ["B", "normalTurn", 1], ["B", "acknowledgmentLost", 2], ["B", "joined", 2],
  ["C", "ready", 0], ["C", "retryAmbiguous", 0], ["C", "joined", 0],
] as const;

/** Finite evidence reducer. No serialized observation grants launch, account,
 * provider, or native cleanup authority. Root collection is not a claim about
 * unobserved descendants. Operation ambiguity survives physical collection. */
export class DaemonRestartObservation {
  readonly #scope: DaemonRestartScope;
  readonly #generations: { generationStage: DaemonRestartStage; daemonGeneration: number; daemonNonce: string }[] = [];
  readonly #normalTurns: { turnTag: string; promptNonce: string }[] = [];
  #intent: Readonly<z.infer<typeof eventSchema> & { type: "acknowledgmentLost" }> | null = null;
  #eventCount = 0;
  #failure: DaemonRestartObservationError | null = null;

  constructor(input: unknown) {
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) throw new DaemonRestartObservationError("scope_refused");
    this.#scope = Object.freeze(parsed.data);
  }

  observe(input: unknown): void {
    if (this.#failure !== null) throw this.#failure;
    try {
      const parsed = eventSchema.safeParse(input);
      if (!parsed.success) throw new DaemonRestartObservationError("observation_refused");
      const event = parsed.data;
      for (const key of ["version", "sourceSha", "runId", "threadTag", "commandTag"] as const) {
        if (event[key] !== this.#scope[key]) throw new DaemonRestartObservationError("scope_refused");
      }
      const expected = sequence[this.#eventCount];
      if (expected === undefined || event.generationStage !== expected[0] || event.type !== expected[1]
        || event.userWriteAttempts !== expected[2]) throw new DaemonRestartObservationError("sequence_refused");
      const current = this.#generations.at(-1);
      if (event.type === "ready") {
        if ((current !== undefined && event.daemonGeneration <= current.daemonGeneration)
          || this.#generations.some((previous) => previous.daemonNonce === event.daemonNonce)) {
          throw new DaemonRestartObservationError("sequence_refused");
        }
      } else if (current === undefined || event.generationStage !== current.generationStage
        || event.daemonGeneration !== current.daemonGeneration || event.daemonNonce !== current.daemonNonce) {
        throw new DaemonRestartObservationError("scope_refused");
      }
      if (event.type === "normalTurn") {
        if (event.resumed !== (event.generationStage === "B") || event.turnTag === this.#scope.commandTag
          || this.#normalTurns.some((previous) => previous.turnTag === event.turnTag || previous.promptNonce === event.promptNonce)) {
          throw new DaemonRestartObservationError("sequence_refused");
        }
      } else if (event.type === "acknowledgmentLost") {
        if (event.originalDaemonGeneration !== event.daemonGeneration) throw new DaemonRestartObservationError("scope_refused");
      } else if (event.type === "retryAmbiguous") {
        if (this.#intent === null || event.intentTag !== this.#intent.intentTag
          || event.idempotencyTag !== this.#intent.idempotencyTag
          || event.originalDaemonGeneration !== this.#intent.originalDaemonGeneration) {
          throw new DaemonRestartObservationError("scope_refused");
        }
      }
      // Commit only after the entire observation passes. Invalid input poisons
      // this reducer; dropping a bad event cannot produce a successful receipt.
      if (event.type === "ready") this.#generations.push({ generationStage: event.generationStage,
        daemonGeneration: event.daemonGeneration, daemonNonce: event.daemonNonce });
      if (event.type === "normalTurn") this.#normalTurns.push({ turnTag: event.turnTag, promptNonce: event.promptNonce });
      if (event.type === "acknowledgmentLost") this.#intent = Object.freeze(event);
      this.#eventCount += 1;
    } catch (error: unknown) {
      this.#failure = error instanceof DaemonRestartObservationError ? error : new DaemonRestartObservationError("observation_refused");
      throw this.#failure;
    }
  }

  finish(): DaemonRestartReceipt {
    if (this.#failure !== null) throw this.#failure;
    if (this.#eventCount !== sequence.length || this.#intent === null) throw new DaemonRestartObservationError("incomplete");
    return Object.freeze({ ...this.#scope, evidenceOnly: true, completed: true, eventCount: 10,
      generations: Object.freeze(this.#generations.map((value) => Object.freeze({ ...value }))),
      intentTag: this.#intent.intentTag, idempotencyTag: this.#intent.idempotencyTag,
      originalDaemonGeneration: this.#intent.originalDaemonGeneration,
      operation: "indeterminate", retryResult: "ambiguous", replayUserWriteAttempts: 0,
      physicalObservation: "daemon-provider-roots-streams-and-observers-joined" });
  }
}
