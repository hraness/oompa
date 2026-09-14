import { expect, test } from "bun:test";
import type { NativeCodexProcessOwner } from "./codex/native-process.ts";
import type { NativeRootExit } from "./native-process/protocol.ts";
import { NativeObservationError } from "./native-process/observer.ts";
import { NativeProviderCompositionCleanupError, NativeProviderCompositionClosedError,
  NativeProviderProcessRegistry } from "./native-provider-composition.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
const empty: AsyncIterable<Uint8Array> = { async *[Symbol.asyncIterator]() {} };
function fakeOwner(options: Readonly<{ stop?: () => void; force?: () => void; release?: () => Promise<void> }> = {}) {
  const ready = deferred<unknown>(), root = deferred<NativeRootExit>(), released = deferred<undefined>();
  let stops = 0, forces = 0, releases = 0;
  const owner: NativeCodexProcessOwner = {
    ready: ready.promise, rootExited: root.promise, stdout: empty, stderr: empty,
    write: bytes => Promise.resolve({ outcome: "accepted-full", id: 1, acceptedBytes: bytes.byteLength }),
    requestStop: () => { stops++; options.stop?.(); },
    forceStop: () => { forces++; options.force?.(); },
    releaseCustody: () => { releases++; return options.release?.() ?? released.promise; },
    stopAndRelease: () => { owner.requestStop(); return owner.releaseCustody(); },
  };
  return { owner, ready, root, released, calls: () => ({ stops, forces, releases }) };
}
async function microtasks() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
const registry = () => new NativeProviderProcessRegistry({ termGraceMs: 10, settlementMs: 10 });

test("full launch is registered before synchronous reentrant close or exception", async () => {
  const owner = registry(), finish = deferred<string>();
  let closing: Promise<void> | undefined, closed = false, starts = 0;
  const launch = owner.runLaunch(() => {
    starts++;
    closing = owner.close();
    void closing.then(() => { closed = true; });
    return finish.promise;
  });
  await microtasks();
  expect(closed).toBe(false);
  await expect(owner.runLaunch(() => { starts++; })).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
  expect(starts).toBe(1);
  finish.resolve("client");
  await expect(launch).rejects.toBeInstanceOf(NativeProviderCompositionClosedError); await closing;
  expect(closed).toBe(true);

  const failed = registry(), original = Error("synchronous factory refusal");
  let synchronousClose: Promise<void> | undefined;
  await expect(failed.runLaunch(() => { synchronousClose = failed.close(); throw original; })).rejects.toBe(original);
  await synchronousClose;
});

test("root exit never retires custody, and client initialization remains pending", async () => {
  const owner = registry(), initializing = deferred<string>();
  const fake = fakeOwner({ force: () => { fake.released.resolve(undefined); initializing.resolve("finished client"); } });
  const launch = owner.runLaunch(async retain => { retain(fake.owner); await fake.ready.promise; return await initializing.promise; });
  fake.ready.resolve({ ready: true }); fake.root.resolve({ code: 0, signal: null });
  await microtasks();
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  await microtasks();
  expect(closed).toBe(false); expect(fake.calls().stops).toBeGreaterThan(0); expect(fake.calls().forces).toBe(0);
  await expect(launch).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
  await closing;
  expect(fake.calls().forces).toBe(1);
});

test("late construction during close is stopped before awaiting readiness", async () => {
  const owner = registry(), construction = deferred<undefined>(), stopped = deferred<undefined>();
  const launchError = Error("stopped before Ready");
  const fake = fakeOwner({ stop: () => { stopped.resolve(undefined); fake.ready.reject(launchError); },
    force: () => { fake.released.resolve(undefined); } });
  const launch = owner.runLaunch(async retain => {
    await construction.promise;
    retain(fake.owner);
    await fake.ready.promise;
  });
  const closing = owner.close();
  construction.resolve(undefined); await stopped.promise;
  await expect(launch).rejects.toBe(launchError);
  await closing;
  expect(fake.calls().forces).toBe(1);
});

test("close fences admission before invoking a reentrant stop callback", async () => {
  const owner = registry();
  let attempt: Promise<unknown> | undefined, unexpectedStarts = 0;
  const fake = fakeOwner({ stop: () => {
    attempt ??= owner.runLaunch(() => { unexpectedStarts++; });
    void attempt.catch(() => {});
    fake.released.resolve(undefined);
  } });
  await owner.runLaunch(retain => { retain(fake.owner); });
  owner.closeAdmission();
  await expect(attempt!).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
  await owner.close(); expect(unexpectedStarts).toBe(0);
});

test("failed release stays retained and exact close retry can commit without replay", async () => {
  const owner = registry();
  let writable = false, starts = 0;
  const fake = fakeOwner({ release: () => writable ? Promise.resolve() : Promise.reject(Error("commit unavailable")) });
  await owner.runLaunch(retain => { starts++; retain(fake.owner); });
  fake.root.resolve({ code: 0, signal: null });
  await microtasks();
  const failedClose = owner.close();
  expect(owner.close()).toBe(failedClose);
  await expect(failedClose).rejects.toBeInstanceOf(NativeProviderCompositionCleanupError);
  const prior = fake.calls();
  expect(prior.releases).toBeGreaterThan(1); expect(prior.forces).toBeGreaterThan(0);
  writable = true;
  await owner.close();
  expect(fake.calls().releases).toBeGreaterThan(prior.releases); expect(starts).toBe(1);
  await expect(owner.runLaunch(() => { starts++; })).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
  expect(starts).toBe(1);
});

test("timed-out pending launch remains owned and late handle receives force cleanup", async () => {
  const owner = registry(), constructed = deferred<undefined>();
  const fake = fakeOwner({ force: () => { fake.released.resolve(undefined); fake.ready.reject(Error("late shutdown")); } });
  const launch = owner.runLaunch(async retain => { await constructed.promise; retain(fake.owner); await fake.ready.promise; });
  await expect(owner.close()).rejects.toBeInstanceOf(NativeProviderCompositionCleanupError);
  constructed.resolve(undefined);
  await expect(launch).rejects.toThrow("late shutdown");
  await owner.close(); expect(fake.calls().forces).toBeGreaterThan(0);
});

test("factory failure stops its constructed owners and retains release failures", async () => {
  const owner = registry(), factoryError = Error("initialization failed"), stopped = deferred<undefined>();
  const fake = fakeOwner({ stop: () => { stopped.resolve(undefined); }, force: () => { fake.released.resolve(undefined); } });
  await expect(owner.runLaunch(retain => { retain(fake.owner); throw factoryError; })).rejects.toBe(factoryError);
  await stopped.promise;
  await owner.close(); expect(fake.calls().forces).toBe(1);
});

test("only successful durable release removes a handle, including before launch completion", async () => {
  const owner = registry(), finished = deferred<undefined>(), fake = fakeOwner();
  const launch = owner.runLaunch(async retain => { retain(fake.owner); await finished.promise; });
  fake.released.resolve(undefined); await microtasks();
  let closed = false;
  const closing = owner.close().then(() => { closed = true; });
  await microtasks(); expect(closed).toBe(false); expect(fake.calls().stops).toBe(0);
  finished.resolve(undefined);
  await expect(launch).rejects.toBeInstanceOf(NativeProviderCompositionClosedError); await closing;
  expect(fake.calls().stops).toBe(0); expect(fake.calls().releases).toBe(1);
});

test("one failing stop cannot skip other owners or substitute for release proof", async () => {
  const owner = registry();
  const first = fakeOwner({ stop: () => { throw Error("stop refused"); }, force: () => { first.released.resolve(undefined); } });
  const second = fakeOwner({ stop: () => { second.released.resolve(undefined); } });
  await owner.runLaunch(retain => { retain(first.owner); retain(second.owner); });
  await owner.close();
  expect(first.calls().forces).toBe(1); expect(second.calls().stops).toBeGreaterThan(0);
});

test("release callback reentrancy shares the same close and owner cannot be retained twice", async () => {
  const owner = registry();
  let nested: Promise<void> | undefined;
  const fake = fakeOwner({ release: () => { nested = owner.close(); return Promise.resolve(); } });
  await expect(owner.runLaunch(retain => { retain(fake.owner); })).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
  const closing = owner.close(); await closing;
  expect(nested).toBe(closing);

  const duplicate = registry(), twice = fakeOwner({ stop: () => { twice.released.resolve(undefined); } });
  await expect(duplicate.runLaunch(retain => { retain(twice.owner); retain(twice.owner); })).rejects.toThrow("ALREADY_RETAINED");
  await duplicate.close(); expect(twice.calls().releases).toBe(1);
});

test("modeled asynchronous runtime and host admission cannot dispatch after the fence", async () => {
  // Pure models of the two production assertions; these do not exercise a
  // runtime, artifact, observer, provider, or durable store.
  for (const phase of ["runtime", "host"] as const) {
    const owner = registry(), admitted = deferred<undefined>();
    let observers = 0, helpers = 0;
    const launch = owner.runLaunch(async () => {
      if (phase === "host") { owner.assertAdmission(); observers++; }
      await admitted.promise;
      owner.assertAdmission();
      helpers++;
      return "client";
    });
    const closing = owner.close();
    admitted.resolve(undefined);
    await expect(launch).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
    await closing;
    expect(helpers).toBe(0); expect(observers).toBe(phase === "host" ? 1 : 0);
  }
});

test("factory success queued behind shutdown is rejected and its exact result is closed", async () => {
  const owner = registry(), client = Object.freeze({ id: "late client" });
  let cleaned: typeof client | undefined;
  const produced = Promise.resolve().then(() => {
    queueMicrotask(() => { owner.closeAdmission(); });
    return client;
  });
  const launch = owner.runLaunch(() => produced, value => { cleaned = value; return Promise.resolve(); });
  await expect(launch).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
  await owner.close(); expect(cleaned).toBe(client);
});

test("late client cleanup remains part of the full launch after native release", async () => {
  const owner = registry(), result = deferred<string>(), cleaned = deferred<undefined>();
  const fake = fakeOwner();
  let cleanups = 0, closed = false;
  const launch = owner.runLaunch(retain => { retain(fake.owner); return result.promise; }, value => {
    expect(value).toBe("exact client"); cleanups++; return cleaned.promise;
  });
  fake.released.resolve(undefined); await microtasks();
  const closing = owner.close().then(() => { closed = true; });
  result.resolve("exact client"); await microtasks();
  expect(cleanups).toBe(1); expect(closed).toBe(false);
  cleaned.resolve(undefined);
  await expect(launch).rejects.toBeInstanceOf(NativeProviderCompositionClosedError);
  await closing; expect(fake.calls().stops).toBe(0);
});

test("failed late client cleanup permanently refuses close despite native release", async () => {
  const owner = registry(), result = deferred<string>(), fake = fakeOwner();
  const cleanupError = Error("client callbacks have not joined");
  let starts = 0, cleanups = 0;
  const launch = owner.runLaunch(retain => { starts++; retain(fake.owner); return result.promise; }, () => {
    cleanups++; return Promise.reject(cleanupError);
  });
  fake.released.resolve(undefined); await microtasks();
  const closing = owner.close();
  result.resolve("client");
  await expect(launch).rejects.toBeInstanceOf(AggregateError);
  await expect(closing).rejects.toBeInstanceOf(NativeProviderCompositionCleanupError);
  await expect(owner.close()).rejects.toBeInstanceOf(NativeProviderCompositionCleanupError);
  expect(starts).toBe(1); expect(cleanups).toBe(1); expect(fake.calls().releases).toBe(1);
});

test("unproved observer cleanup before a provider handle cannot become empty success", async () => {
  const owner = registry(), error = new NativeObservationError("cleanup-unproven");
  await expect(owner.runLaunch(() => Promise.reject(error))).rejects.toBe(error);
  expect(() => owner.assertAdmission()).toThrow(NativeProviderCompositionClosedError);
  await expect(owner.close()).rejects.toBeInstanceOf(NativeProviderCompositionCleanupError);
  await expect(owner.close()).rejects.toBeInstanceOf(NativeProviderCompositionCleanupError);
});

test("a failed observation with collected cleanup remains an ordinary launch error", async () => {
  const owner = registry(), error = new NativeObservationError("observation-unproved");
  await expect(owner.runLaunch(() => { throw error; })).rejects.toBe(error);
  owner.assertAdmission();
  await owner.close();
});

test("escaped late owners invalidate success across close settlement microtasks", async () => {
  for (let delay = 0; delay < 10; delay++) {
    const owner = registry();
    let escaped!: (value: NativeCodexProcessOwner) => void;
    await owner.runLaunch(retain => { escaped = retain; });
    await microtasks();
    const closing = owner.close();
    void closing.catch(() => {});
    const fake = fakeOwner({ stop: () => { fake.released.resolve(undefined); } });
    await new Promise<void>(resolve => {
      let remaining = delay;
      const inject = (): void => {
        if (remaining-- > 0) { queueMicrotask(inject); return; }
        expect(() => { escaped(fake.owner); }).toThrow("LAUNCH_ALREADY_SETTLED");
        resolve();
      };
      queueMicrotask(inject);
    });
    // An already committed close can precede a contract violation; no future
    // caller may receive that stale success after the late handle is retained.
    await closing.catch(() => {});
    await expect(owner.close()).rejects.toBeInstanceOf(NativeProviderCompositionCleanupError);
    expect(fake.calls().stops).toBeGreaterThan(0); expect(fake.calls().releases).toBe(1);
  }
});

test("shutdown limits are finite and independently validated", () => {
  for (const value of [0, -1, 0.5, Infinity, NaN, 30_001]) {
    expect(() => new NativeProviderProcessRegistry({ termGraceMs: value })).toThrow("LIMIT_INVALID");
    expect(() => new NativeProviderProcessRegistry({ settlementMs: value })).toThrow("LIMIT_INVALID");
  }
});
