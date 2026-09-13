import { expect, test } from "bun:test";
import fc from "fast-check";

import { DaemonRestartObservation, type DaemonRestartEvent } from "./state";

const tag = (n: number): string => n.toString(16).padStart(64, "0");
const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { version: 1, sourceSha: "a".repeat(40), runId: uuid(1), threadTag: tag(1), commandTag: tag(2) } as const;
function events(firstGeneration = 10): DaemonRestartEvent[] {
  const base = (generationStage: "A" | "B" | "C", userWriteAttempts: number) => ({ ...scope, generationStage,
    daemonGeneration: firstGeneration + { A: 0, B: 2, C: 7 }[generationStage],
    daemonNonce: uuid({ A: 2, B: 3, C: 4 }[generationStage]), userWriteAttempts });
  const ready = (stage: "A" | "B" | "C"): DaemonRestartEvent => ({ ...base(stage, 0), type: "ready" });
  const normal = (stage: "A" | "B"): DaemonRestartEvent => ({ ...base(stage, 1), type: "normalTurn",
    turnTag: tag(stage === "A" ? 3 : 4), promptNonce: uuid(stage === "A" ? 5 : 6),
    resumed: stage === "B", acknowledged: true, completed: true, nonceMatched: true });
  const joined = (stage: "A" | "B" | "C", writes: number): DaemonRestartEvent => ({ ...base(stage, writes), type: "joined",
    daemonRootCollected: true, daemonStdoutEof: true, daemonStderrEof: true, providerRootsCollected: true,
    providerStdoutEof: true, providerStderrEof: true, runtimeObserversJoined: true,
    identityInspectorsJoined: true, daemonAuthorityReleased: true });
  const intent = { intentTag: tag(5), idempotencyTag: tag(6), originalDaemonGeneration: firstGeneration + 2,
    retainedIntentState: "ambiguous", dispatchCount: 1 } as const;
  return [ready("A"), normal("A"), joined("A", 1), ready("B"), normal("B"),
    { ...base("B", 2), ...intent, type: "acknowledgmentLost", localStdinAccepted: true,
      acknowledgmentWithheld: true, operation: "indeterminate", remoteAcknowledgment: "unestablished", remoteEffect: "unestablished" },
    joined("B", 2), ready("C"), { ...base("C", 0), ...intent, type: "retryAmbiguous", result: "ambiguous", newUserWriteAttempts: 0 },
    joined("C", 0)];
}
function assertRefused(input: readonly unknown[]): void {
  const observer = new DaemonRestartObservation(scope);
  expect(() => { for (const event of input) observer.observe(event); observer.finish(); }).toThrow();
}

test("three exact real-observation generations preserve ambiguity after physical collection", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 1_000_000 }), (generation) => {
    const observer = new DaemonRestartObservation(scope);
    for (const event of events(generation)) observer.observe(event);
    const receipt = observer.finish();
    expect(receipt.generations.map((value) => value.daemonGeneration)).toEqual([generation, generation + 2, generation + 7]);
    expect(receipt.operation).toBe("indeterminate"); expect(receipt.retryResult).toBe("ambiguous");
    expect(receipt.replayUserWriteAttempts).toBe(0); expect(receipt.evidenceOnly).toBe(true);
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.generations)).toBe(true);
    expect(receipt.generations.every(Object.isFrozen)).toBe(true);
  }), { numRuns: 30 });
});

test("every prefix remains incomplete, and no event may be skipped, repeated, reordered or appended", () => {
  const valid = events();
  for (let n = 0; n < valid.length; n += 1) {
    assertRefused(valid.slice(0, n));
    assertRefused(valid.filter((_, index) => index !== n));
    assertRefused([...valid.slice(0, n), valid[n], ...valid.slice(n)]);
    if (n + 1 < valid.length) {
      const swapped = [...valid]; const first = swapped[n]; const next = swapped[n + 1];
      if (first === undefined || next === undefined) throw new Error("Invalid test fixture.");
      [swapped[n], swapped[n + 1]] = [next, first];
      assertRefused(swapped);
    }
  }
  assertRefused([...valid, valid[0]]);
});

test("scope and exact daemon identity are immutable on every observation", () => {
  const wrong = { version: 2, sourceSha: "b".repeat(40), runId: uuid(99), threadTag: tag(99), commandTag: tag(99),
    daemonGeneration: 999, daemonNonce: uuid(99), generationStage: "C" };
  for (const [key, value] of Object.entries(wrong)) {
    for (let n = 0; n < events().length; n += 1) {
      // New ready generations legitimately choose their identity; mutations of
      // those identities are rejected by the later exact-generation events.
      const changed = events().map((event, index) => index === n ? { ...event, [key]: value } : event);
      if (key === "generationStage" && changed[n]?.generationStage === events()[n]?.generationStage) continue;
      assertRefused(changed);
    }
  }
});

test("new generations must increase and never reuse a prior daemon nonce", () => {
  for (const change of ["generation", "nonce"] as const) {
    assertRefused(events().map((event) => event.generationStage === "B"
      ? { ...event, ...(change === "generation" ? { daemonGeneration: 10 } : { daemonNonce: uuid(2) }) } : event));
  }
});

test("normal turns need distinct prompt nonces and tags and exactly one completed acknowledged write", () => {
  for (const [key, value] of Object.entries({ turnTag: tag(3), promptNonce: uuid(5), resumed: false,
    acknowledged: false, completed: false, nonceMatched: false, userWriteAttempts: 0 })) {
    assertRefused(events().map((event) => event.type === "normalTurn" && event.generationStage === "B" ? { ...event, [key]: value } : event));
  }
  assertRefused(events().map((event) => event.type === "normalTurn" ? { ...event, turnTag: scope.commandTag } : event));
});

test("lost acknowledgment requires actual accepted local input without claiming remote completion", () => {
  for (const [key, value] of Object.entries({ localStdinAccepted: false, acknowledgmentWithheld: false,
    operation: "failed", remoteAcknowledgment: "accepted", remoteEffect: "completed",
    originalDaemonGeneration: 10, retainedIntentState: "prepared", dispatchCount: 0, userWriteAttempts: 1 })) {
    assertRefused(events().map((event) => event.type === "acknowledgmentLost" ? { ...event, [key]: value } : event));
  }
});

test("retry requires the original durable intent, one dispatch and zero attempted replay", () => {
  for (const [key, value] of Object.entries({ intentTag: tag(99), idempotencyTag: tag(99), originalDaemonGeneration: 17,
    retainedIntentState: "applied", result: "accepted", dispatchCount: 2, userWriteAttempts: 1, newUserWriteAttempts: 1 })) {
    assertRefused(events().map((event) => event.type === "retryAmbiguous" ? { ...event, [key]: value } : event));
  }
  // A late replay after the retry observation also prevents a final receipt.
  assertRefused(events().map((event) => event.type === "joined" && event.generationStage === "C" ? { ...event, userWriteAttempts: 1 } : event));
});

test("root exit alone never substitutes for both stream, provider, observer and authority collection", () => {
  const required = ["daemonRootCollected", "daemonStdoutEof", "daemonStderrEof", "providerRootsCollected",
    "providerStdoutEof", "providerStderrEof", "runtimeObserversJoined", "identityInspectorsJoined", "daemonAuthorityReleased"];
  for (const key of required) for (const stage of ["A", "B", "C"]) {
    assertRefused(events().map((event) => event.type === "joined" && event.generationStage === stage ? { ...event, [key]: false } : event));
  }
});

test("foreign fields, unbounded identifiers and non-finite counters refuse", () => {
  for (const value of [null, [], {}, { ...scope, native: true }, { ...scope, runId: "x".repeat(8192) }]) {
    expect(() => new DaemonRestartObservation(value)).toThrow();
  }
  for (const value of [null, [], {}, { ...events()[0], native: true }, { ...events()[0], daemonGeneration: Infinity },
    { ...events()[0], daemonGeneration: Number.MAX_SAFE_INTEGER + 1 }, { ...events()[0], userWriteAttempts: -1 },
    { ...events()[0], threadTag: "x".repeat(8192) }]) assertRefused([value, ...events().slice(1)]);
});

test("invalid observation poisons the run, while input mutation cannot revise accepted evidence", () => {
  const observer = new DaemonRestartObservation(scope);
  expect(() => observer.observe({ ...events()[0], userWriteAttempts: 1 })).toThrow();
  expect(() => observer.observe(events()[0])).toThrow(); expect(() => observer.finish()).toThrow();
  const valid = new DaemonRestartObservation(scope);
  for (const event of events()) { const mutable = { ...event }; valid.observe(mutable); mutable.daemonNonce = uuid(99); }
  expect(valid.finish().generations[0]?.daemonNonce).toBe(uuid(2));
});
