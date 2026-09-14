import { Deferred, Effect, Exit, FiberSet, Layer, Context, Clock, Stream, Option } from "effect";

import type { CodexError } from "./errors.ts";

export type CodexTaskFailure =
  | { readonly _tag: "CodexFailure"; readonly error: CodexError }
  | { readonly _tag: "ReadAborted"; readonly reason: unknown };

export type TaskGroup = "requests" | "facts" | "writes" | "dynamic" | "server" | "responses" | "stdout" | "stderr";

export class CodexConnectionWork extends Context.Tag("@hraness/oompa/CodexConnectionWork")<
  CodexConnectionWork,
  {
    readonly groups: Readonly<Record<TaskGroup, FiberSet.FiberSet<unknown, never>>>;
    readonly factOrder: Effect.Semaphore;
  }
>() {}

export const CodexConnectionWorkLive = Layer.scoped(CodexConnectionWork, Effect.gen(function* () {
  const requests = yield* FiberSet.make<unknown, never>();
  const facts = yield* FiberSet.make<unknown, never>();
  const writes = yield* FiberSet.make<unknown, never>();
  const dynamic = yield* FiberSet.make<unknown, never>();
  const server = yield* FiberSet.make<unknown, never>();
  const responses = yield* FiberSet.make<unknown, never>();
  const stdout = yield* FiberSet.make<unknown, never>();
  const stderr = yield* FiberSet.make<unknown, never>();
  const factOrder = yield* Effect.makeSemaphore(1);
  return { groups: { requests, facts, writes, dynamic, server, responses, stdout, stderr }, factOrder };
}));

export function completionBefore<A>(deferred: Deferred.Deferred<A, CodexTaskFailure>, expiresAt: number, expire: Effect.Effect<void>): Effect.Effect<A, CodexTaskFailure> {
  const deadline = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const remainingMs = expiresAt - now;
    if (remainingMs > 0) yield* Effect.sleep(remainingMs);
    yield* expire;
    return yield* Deferred.await(deferred);
  });
  return Effect.raceFirst(Deferred.await(deferred), deadline);
}

export function orderedFact(program: Effect.Effect<void, CodexTaskFailure>): Effect.Effect<void, CodexTaskFailure, CodexConnectionWork> {
  return Effect.gen(function* () {
    const work = yield* CodexConnectionWork;
    yield* work.factOrder.withPermits(1)(program);
  });
}

/** The adapter owns the foreign iterator. Scope interruption stops consumption,
 * not the native stream or a Promise that ignores cancellation. */
export function consumeValues<A>(next: Effect.Effect<IteratorResult<A>, CodexTaskFailure>, consume: (value: A) => Effect.Effect<void, CodexTaskFailure>): Effect.Effect<void, CodexTaskFailure> {
  const pull = next.pipe(
    Effect.mapError(Option.some),
    Effect.flatMap(result => result.done
      ? Effect.fail(Option.none<CodexTaskFailure>())
      : Effect.succeed(result.value)),
  );
  return Stream.repeatEffectOption(pull).pipe(Stream.runForEach(consume));
}

export interface ShutdownOperations {
  readonly terminate: Effect.Effect<void, CodexTaskFailure>;
  readonly forceTerminate: Effect.Effect<void, CodexTaskFailure>;
  readonly exited: Effect.Effect<unknown, CodexTaskFailure>;
  readonly custody: Effect.Effect<unknown, CodexTaskFailure>;
  readonly readSettled: Effect.Effect<unknown, CodexTaskFailure>;
  readonly diagnostic: (message: string) => Effect.Effect<void>;
  readonly termGraceMs: number;
  readonly settlementMs: number;
}

function settlesBefore(program: Effect.Effect<unknown, CodexTaskFailure>, timeoutMs: number, requireSuccess = false): Effect.Effect<boolean> {
  return Effect.exit(program).pipe(
    Effect.map(exit => !requireSuccess || Exit.isSuccess(exit)),
    Effect.timeoutOption(timeoutMs),
    Effect.map(result => Option.getOrElse(result, () => false)),
  );
}

export interface ShutdownReport {
  readonly exitSettled: boolean;
  readonly custodySettled: boolean;
  readonly readSettled: boolean;
  readonly factsSettled: boolean;
  readonly writesSettled: boolean;
  readonly inboundSettled: boolean;
  readonly serverRequestsSettled: boolean;
  readonly responsesSettled: boolean;
}

/** Join native custody separately from interruptible session consumers. A false
 * exit proof is returned to the domain owner, which must keep close retryable. */
export function settleConnection(operations: ShutdownOperations): Effect.Effect<ShutdownReport, never, CodexConnectionWork> {
  return Effect.gen(function* () {
    const work = yield* CodexConnectionWork;
    const terminated = yield* operations.terminate.pipe(
      Effect.flatMap(() => settlesBefore(operations.custody, operations.termGraceMs, true)),
      Effect.catchAllCause(() => Effect.as(operations.diagnostic("Codex TERM failed; forcing process termination"), false)),
    );
    if (!terminated) {
      yield* operations.forceTerminate.pipe(Effect.catchAllCause(() => operations.diagnostic("Codex force termination failed")));
    }
    return yield* Effect.all({
      exitSettled: settlesBefore(operations.exited, operations.settlementMs, true),
      custodySettled: settlesBefore(operations.custody, operations.settlementMs, true),
      readSettled: settlesBefore(operations.readSettled, operations.settlementMs),
      factsSettled: settlesBefore(FiberSet.awaitEmpty(work.groups.facts), operations.settlementMs),
      writesSettled: settlesBefore(FiberSet.awaitEmpty(work.groups.writes), operations.settlementMs),
      inboundSettled: settlesBefore(FiberSet.awaitEmpty(work.groups.dynamic), operations.settlementMs),
      serverRequestsSettled: settlesBefore(FiberSet.awaitEmpty(work.groups.server), operations.settlementMs),
      responsesSettled: settlesBefore(FiberSet.awaitEmpty(work.groups.responses), operations.settlementMs),
    }, { concurrency: "unbounded" });
  });
}
