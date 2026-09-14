import { Cause, Deferred, Effect, Exit, Fiber, FiberId, FiberSet, ManagedRuntime, Option, type Scope } from "effect";

import { CodexConnectionWork, CodexConnectionWorkLive, completionBefore, consumeValues, orderedFact, settleConnection, type CodexTaskFailure, type ShutdownReport, type TaskGroup } from "./session-program.ts";

import type { CodexProcess } from "./process.ts";

import { CodexError } from "./errors.ts";

function rejectTask(reason: unknown): Effect.Effect<never, CodexTaskFailure> {
  return reason instanceof CodexError
    ? Effect.fail({ _tag: "CodexFailure", error: reason })
    : Effect.die(reason);
}

/** Foreign Promise/callback boundary; unexpected exceptions remain defects. */
function callback<A>(run: () => A | Promise<A>): Effect.Effect<A, CodexTaskFailure> {
  return Effect.async<A, CodexTaskFailure>((resume) => {
    try {
      Promise.resolve(run()).then(
        value => resume(Effect.succeed(value)),
        (reason: unknown) => resume(rejectTask(reason)),
      );
    } catch (reason: unknown) {
      resume(rejectTask(reason));
    }
  });
}

function listenForAbort<A>(signal: AbortSignal, deferred: Deferred.Deferred<A, CodexTaskFailure>, onAbort: (reason: unknown) => boolean): Effect.Effect<void, never, Scope.Scope> {
  const abort = (): void => {
    const reason: unknown = signal.reason ?? new DOMException("The Codex read was aborted", "AbortError");
    // The pending table decides synchronously. Once a response removed that
    // reservation, even a response not yet parsed must beat a later abort.
    try {
      if (onAbort(reason)) Deferred.unsafeDone(deferred, Effect.fail({ _tag: "ReadAborted", reason }));
    } catch (error: unknown) {
      Deferred.unsafeDone(deferred, rejectTask(error));
    }
  };
  return Effect.acquireRelease(
    Effect.sync(() => { signal.addEventListener("abort", abort, { once: true }); }),
    () => Effect.sync(() => { signal.removeEventListener("abort", abort); }),
  ).pipe(Effect.tap(() => Effect.sync(() => { if (signal.aborted) abort(); })));
}

function unwrap<A>(exit: Exit.Exit<A, CodexTaskFailure>): A {
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.failureOption(exit.cause);
  if (Option.isSome(failure)) {
    switch (failure.value._tag) {
      case "CodexFailure": throw failure.value.error;
      case "ReadAborted": throw failure.value.reason;
    }
  }
  throw Cause.squash(exit.cause);
}

export interface CodexCompletion<A> {
  readonly start: () => Promise<A>;
  readonly succeed: (value: A) => void;
  readonly reject: (reason: unknown) => void;
}

/** One composition root for one provider connection, never a process-exit proof. */
export class CodexConnectionEffects {
  readonly #runtime = ManagedRuntime.make(CodexConnectionWorkLive);

  #run<A>(group: TaskGroup, program: Effect.Effect<A, CodexTaskFailure, CodexConnectionWork>): Promise<A> {
    // The runner receives a closed expected-error channel. Exit is deliberately
    // projected at the existing Promise API, preserving native exception identity.
    const run = this.#runtime.runSync(Effect.flatMap(CodexConnectionWork, work =>
      FiberSet.runtime(work.groups[group])<CodexConnectionWork>(),
    ));
    // Start synchronously so admission counts and ordered semaphore acquisition
    // preserve callback arrival order before another public call can overtake.
    const fiber = run(Effect.exit(program), { immediate: true });
    return this.#runtime.runPromise(Fiber.join(fiber)).then(unwrap);
  }

  completion<A>(group: "requests" | "writes", options?: {
    readonly deadlineMs: number;
    readonly signal?: AbortSignal;
    readonly onDeadline: () => void;
    readonly onAbort: (reason: unknown) => boolean;
  }): CodexCompletion<A> {
    // Reservation is synchronous: the domain table and pre-write fence must
    // exist before any provider callback can observe the allocated request id.
    const deferred = Deferred.unsafeMake<A, CodexTaskFailure>(FiberId.none);
    let program: Effect.Effect<A, CodexTaskFailure> = Deferred.await(deferred);
    if (options !== undefined) {
      program = completionBefore(deferred, Date.now() + options.deadlineMs, Effect.sync(options.onDeadline));
      if (options.signal !== undefined) {
        program = Effect.scoped(Effect.zipRight(listenForAbort(options.signal, deferred, options.onAbort), program));
      }
    }
    let result: Promise<A> | undefined;
    return {
      // The domain owner installs its reservation before arming cancellation
      // and deadlines. Activation is idempotent and starts the owned fiber now.
      start: () => {
        result ??= this.#run(group, program);
        return result;
      },
      succeed: value => Deferred.unsafeDone(deferred, Effect.succeed(value)),
      reject: reason => Deferred.unsafeDone(deferred, rejectTask(reason)),
    };
  }

  fact(run: () => void | Promise<void>, failed: (reason: unknown) => void): Promise<void> {
    const result = this.#run("facts", orderedFact(callback(run)));
    // This observer is the existing diagnostic boundary; callers still receive
    // the original rejection and it never poisons later ordered facts.
    void result.catch(failed);
    return result;
  }

  track(group: "dynamic" | "server" | "responses", run: () => Promise<void>, failed: (reason: unknown) => void): void {
    const program = callback(run).pipe(Effect.catchAllCause(cause => Effect.sync(() => {
      failed(Cause.squashWith(cause, failure =>
        failure._tag === "CodexFailure" ? failure.error : failure.reason,
      ));
    })));
    // Completion is owned by the group's FiberSet. The public callback has no
    // response value; its declared failure projection remains product-owned.
    void this.#run(group, program).catch(failed);
  }

  count(group: "dynamic" | "server"): number {
    return this.#runtime.runSync(Effect.flatMap(CodexConnectionWork, work => FiberSet.size(work.groups[group])));
  }

  drain(group: TaskGroup): Promise<void> {
    return this.#runtime.runPromise(Effect.flatMap(CodexConnectionWork, work => FiberSet.awaitEmpty(work.groups[group])));
  }

  read<A>(group: "stdout" | "stderr", source: AsyncIterable<A>, consume: (value: A) => Promise<void>, cleanupFailed: () => void): Promise<void> {
    const iterator = source[Symbol.asyncIterator]();
    // The process owns and closes its streams. Do not await iterator.return()
    // as an Effect finalizer: foreign next()/return() may never settle. Native
    // exit remains separately proven by the client before disposing this scope.
    return this.#run(group, consumeValues(callback(() => iterator.next()), value => callback(() => consume(value)))).finally(() => {
      // Attempt release on EOF, parse failure and interruption. Keep observing
      // foreign settlement without letting a stuck return() block native close.
      try {
        void Promise.resolve(iterator.return?.()).catch(cleanupFailed);
      } catch {
        cleanupFailed();
      }
    });
  }

  shutdown(process: CodexProcess, readTask: Promise<void> | null, options: {
    readonly termGraceMs: number;
    readonly settlementMs: number;
    readonly diagnostic: (message: string) => void;
  }): Promise<ShutdownReport> {
    const program = settleConnection({
      terminate: callback(() => { process.terminate(); }),
      forceTerminate: callback(() => { process.forceTerminate(); }),
      exited: callback(() => process.exited),
      custody: callback<unknown>(() => process.joinCustody === undefined ? process.exited : process.joinCustody()),
      readSettled: callback(() => readTask ?? undefined),
      diagnostic: message => Effect.sync(() => { options.diagnostic(message); }),
      termGraceMs: options.termGraceMs,
      settlementMs: options.settlementMs,
    });
    return this.#runtime.runPromise(Effect.exit(program)).then(unwrap);
  }

  close(): Promise<void> {
    return this.#runtime.dispose();
  }
}
