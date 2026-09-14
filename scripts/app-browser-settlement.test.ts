import { expect, test } from "bun:test";
import * as fc from "fast-check";
import {
  advanceStylesheetSettlement, initialStylesheetSettlement, parseStylesheetSample,
  readRestoredStyleFramePair, settleExactStylesheet, StylesheetSettlementError,
  type StylesheetSettlementClock, type StylesheetSettlementOperations,
} from "./app-browser-settlement.ts";

const expected = { display: "block", height: "auto", padding: "0px", border: "0px", font: "38.4px" };
const disabled = { ...expected, font: "24px" };
const pair = (frame: number, first: unknown = expected, second: unknown = first) => [
  { frame, sample: first }, { frame: frame + 1, sample: second },
];
function fixture() {
  let now = 100;
  let alarm: (() => void) | undefined;
  let disarmed = false;
  let budget = 0;
  const signal = new AbortController();
  const clock: StylesheetSettlementClock = {
    now: () => now,
    deadline: (callback, milliseconds) => {
      alarm = callback; budget = milliseconds;
      return () => { disarmed = true; alarm = undefined; };
    },
  };
  let checks = 0, reads = 0;
  const signals: AbortSignal[] = [];
  const operations: StylesheetSettlementOperations = {
    assertIdentity: (value) => { checks += 1; signals.push(value); return Promise.resolve(); },
    readPair: (value) => { reads += 1; signals.push(value); now += 10; return Promise.resolve(pair(reads * 10)); },
  };
  return {
    options: { expected, foundation: false, signal: signal.signal, profileDeadline: 120_100, clock, operations },
    operations, signal, signals,
    advance: (milliseconds: number) => { now += milliseconds; },
    expire: () => { if (alarm === undefined) throw new Error("No fixture deadline"); now += budget; alarm(); },
    evidence: () => ({ checks, reads, disarmed, budget }),
  };
}
async function failure(operation: Promise<unknown>): Promise<StylesheetSettlementError> {
  try { await operation; } catch (error) {
    if (error instanceof StylesheetSettlementError) return error;
    throw error instanceof Error ? error : new Error("Unexpected settlement rejection", { cause: error });
  }
  throw new Error("Expected bounded settlement failure");
}

test("closed sample parser retains every exact byte and rejects omitted, extra, oversized and foreign fields", () => {
  expect(parseStylesheetSample(expected, false)).toEqual(expected);
  const foundation = { ...expected, boxSizing: "border-box", fontFamily: '"Nebula Sans", sans-serif', lineHeight: "24.8px", backgroundToken: "#141310" };
  expect(parseStylesheetSample(foundation, true)).toEqual(foundation);
  for (const value of [null, [], { ...expected, extra: "ignored" }, { ...expected, font: undefined },
    { ...expected, font: 24 }, { ...expected, font: "a".repeat(1025) }, { ...expected, font: "a\nb" }, Object.create(expected) as unknown]) {
    expect(() => parseStylesheetSample(value, false)).toThrow();
  }
  expect(() => parseStylesheetSample(foundation, false)).toThrow();
  expect(() => parseStylesheetSample(expected, true)).toThrow();
  expect(Object.isFrozen(parseStylesheetSample(expected, false))).toBe(true);
});

test("sample parser has bounded roundtrip and exact-field rejection laws", () => {
  const text = fc.array(fc.integer({ min: 32, max: 126 }), { maxLength: 80 }).map((codes) => String.fromCharCode(...codes));
  fc.assert(fc.property(fc.tuple(text, text, text, text, text), (values) => {
    const sample = { display: values[0], height: values[1], padding: values[2], border: values[3], font: values[4] };
    const parsed = parseStylesheetSample(sample, false);
    const roundtrip: unknown = JSON.parse(JSON.stringify(parsed));
    expect(parseStylesheetSample(roundtrip, false)).toEqual(sample);
    expect(() => parseStylesheetSample({ ...sample, unreviewed: "field" }, false)).toThrow();
  }), { numRuns: 80 });
});

test("two exact consecutive samples are required and a lone match never carries across protocol pairs", () => {
  let state = initialStylesheetSettlement();
  state = advanceStylesheetSettlement(state, pair(1, disabled, expected), expected, false);
  expect(state.phase).toBe("waiting"); expect(state.matchingFrames).toBe(1);
  state = advanceStylesheetSettlement(state, pair(3, expected, disabled), expected, false);
  expect(state.phase).toBe("waiting"); expect(state.matchingFrames).toBe(0);
  state = advanceStylesheetSettlement(state, pair(5), expected, false);
  expect(state.phase).toBe("settled"); expect(state.matchingFrames).toBe(2);
  expect(state.first).toEqual(disabled); expect(state.last).toEqual(expected);
  expect(Object.isFrozen(state)).toBe(true);
  expect(() => advanceStylesheetSettlement(state, pair(7), expected, false)).toThrow("terminal");
});

test("reducer settlement is equivalent to equality of both complete samples in the latest adjacent pair", () => {
  fc.assert(fc.property(fc.array(fc.tuple(fc.boolean(), fc.boolean()), { minLength: 1, maxLength: 50 }), (values) => {
    let state = initialStylesheetSettlement();
    for (const [index, [a, b]] of values.entries()) {
      state = advanceStylesheetSettlement(state, pair(index * 2, a ? expected : disabled, b ? expected : disabled), expected, false);
      expect(state.phase === "settled").toBe(a && b);
      if (state.phase === "settled") break;
    }
  }), { numRuns: 80 });
});

test("frame identity cannot repeat, regress, be nonfinite or omit one consecutive sample", () => {
  const state = advanceStylesheetSettlement(initialStylesheetSettlement(), pair(1, disabled), expected, false);
  for (const value of [pair(1), pair(2), pair(-1), pair(Number.NaN), pair(Number.POSITIVE_INFINITY), [],
    [{ frame: 3, sample: expected }], [{ frame: 3, sample: expected }, { frame: 3, sample: expected }],
    [{ frame: 3, sample: expected, ignored: true }, { frame: 4, sample: expected }]]) {
    expect(() => advanceStylesheetSettlement(state, value, expected, false)).toThrow();
  }
  expect(() => advanceStylesheetSettlement(initialStylesheetSettlement(),
    [{ frame: 7, sample: expected }, { frame: 7, sample: expected }], expected, false))
    .toThrow("previous=null, pair=[7,7]");
});

test("delayed exact restoration succeeds without changing CSS and disarms all controller resources", async () => {
  const testCase = fixture();
  let reads = 0;
  testCase.operations.readPair = (signal, remaining) => {
    expect(signal.aborted).toBe(false); expect(remaining).toBeLessThanOrEqual(15_000);
    reads += 1; testCase.advance(16);
    return Promise.resolve(pair(reads * 2, reads === 1 ? disabled : expected));
  };
  const result = await settleExactStylesheet(testCase.options);
  expect(result).toEqual({ pairs: 2, matchingFrames: 2, elapsedMs: 32, expected, first: disabled, last: expected });
  expect(testCase.evidence()).toEqual({ checks: 4, reads: 0, disarmed: true, budget: 15_000 });
  expect(testCase.signals.every((signal) => signal.aborted)).toBe(true);
  expect(Object.isFrozen(result)).toBe(true);
});

test("persistent wrong styles remain red with bounded first/last diagnostics under the original total budget", async () => {
  const testCase = fixture();
  let reads = 0;
  testCase.operations.readPair = () => {
    reads += 1;
    if (reads === 3) testCase.expire();
    return Promise.resolve(pair(reads * 2, disabled));
  };
  const error = await failure(settleExactStylesheet(testCase.options));
  expect(error.reason).toBe("deadline"); expect(error.name).toBe("TimeoutError");
  expect(error.diagnostics).toEqual({ pairs: 2, matchingFrames: 0, elapsedMs: 15_000, expected, first: disabled, last: disabled });
  expect(testCase.evidence().disarmed).toBe(true);
});

test("remaining profile time caps the operation without resetting the 120s profile deadline", async () => {
  const testCase = fixture();
  testCase.options.profileDeadline = 107;
  testCase.operations.readPair = (_signal, remaining) => {
    expect(remaining).toBe(7); testCase.expire(); return Promise.resolve(pair(1));
  };
  const error = await failure(settleExactStylesheet(testCase.options));
  expect(error.reason).toBe("deadline"); expect(error.diagnostics.elapsedMs).toBe(7);
  expect(testCase.evidence().budget).toBe(7);
});

test("cancellation is terminal before dispatch and after every awaited identity/read success", async () => {
  for (const boundary of ["before", "first-identity", "read", "final-identity"] as const) {
    const testCase = fixture();
    let checks = 0, reads = 0;
    if (boundary === "before") testCase.signal.abort();
    testCase.operations.assertIdentity = () => {
      checks += 1;
      if ((boundary === "first-identity" && checks === 1) || (boundary === "final-identity" && checks === 2)) testCase.signal.abort();
      return Promise.resolve();
    };
    testCase.operations.readPair = () => { reads += 1; if (boundary === "read") testCase.signal.abort(); return Promise.resolve(pair(1)); };
    const error = await failure(settleExactStylesheet(testCase.options));
    expect(error.reason).toBe("cancelled"); expect(error.name).toBe("AbortError");
    expect(reads).toBe(boundary === "before" || boundary === "first-identity" ? 0 : 1);
    if (boundary === "before") expect(checks).toBe(0);
  }
});

test("a pending read cannot promote success after cancellation and has no follow-up identity work", async () => {
  const testCase = fixture();
  let complete: (value: unknown) => void = () => { throw new Error("Missing pending read"); };
  let entered: () => void = () => { throw new Error("Missing entry observer"); };
  const entry = new Promise<void>((resolve) => { entered = resolve; });
  testCase.operations.readPair = (signal) => {
    testCase.signals.push(signal); entered(); return new Promise((resolve) => { complete = resolve; });
  };
  const run = settleExactStylesheet(testCase.options);
  await entry; testCase.signal.abort();
  const error = await failure(run);
  expect(error.reason).toBe("cancelled"); expect(testCase.evidence().checks).toBe(1);
  complete(pair(1)); await Promise.resolve();
  expect(testCase.evidence().checks).toBe(1);
  expect(testCase.signals.every((signal) => signal.aborted)).toBe(true);
});

test("identity and foreign sampling failures preserve their cause without accepting matching samples", async () => {
  for (const boundary of ["first-identity", "read", "final-identity"] as const) {
    const testCase = fixture();
    const cause = new Error("exact stylesheet identity drift");
    let checks = 0;
    testCase.operations.assertIdentity = () => {
      checks += 1;
      return (boundary === "first-identity" && checks === 1) || (boundary === "final-identity" && checks === 2)
        ? Promise.reject(cause) : Promise.resolve();
    };
    testCase.operations.readPair = () => boundary === "read" ? Promise.reject(cause) : Promise.resolve(pair(1));
    const error = await failure(settleExactStylesheet(testCase.options));
    expect(error.reason).toBe("operation"); expect(error.cause).toBe(cause);
  }
});

test("exhausted profile budgets and regressing clocks fail closed", async () => {
  const expired = fixture(); expired.options.profileDeadline = 100;
  expect((await failure(settleExactStylesheet(expired.options))).reason).toBe("deadline");
  expect(expired.evidence().checks).toBe(0);
  const regressed = fixture();
  regressed.operations.readPair = () => { regressed.advance(-1); return Promise.resolve(pair(1)); };
  expect((await failure(settleExactStylesheet(regressed.options))).reason).toBe("operation");
});

test("the independent frame bound refuses an endless mismatch even with a stationary injected clock", async () => {
  const testCase = fixture();
  let reads = 0;
  testCase.operations.readPair = () => { reads += 1; return Promise.resolve(pair(reads * 2, disabled)); };
  const error = await failure(settleExactStylesheet(testCase.options));
  expect(error.reason).toBe("frame-limit"); expect(error.diagnostics.pairs).toBe(2048);
  expect(reads).toBe(2048); expect(error.diagnostics.last).toEqual(disabled);
  expect(testCase.evidence().disarmed).toBe(true);
});

test("only the exact settlement error class adds bounded sample evidence to the failure receipt", async () => {
  const { browserFailureDetails } = await import("./app-browser.ts");
  const evidence = { pairs: 1, matchingFrames: 0, elapsedMs: 15_000, expected, first: disabled, last: disabled };
  const error = new StylesheetSettlementError("deadline", Object.freeze(evidence));
  expect(browserFailureDetails(error).settlement).toEqual(evidence);
  expect(browserFailureDetails(Object.assign(new Error("ordinary failure"), { diagnostics: evidence })).settlement).toBeUndefined();
  expect(() => new StylesheetSettlementError("deadline", { ...evidence, pairs: 2049 })).toThrow();
  expect(() => new StylesheetSettlementError("deadline", { ...evidence, first: { ...disabled, privateField: "unreviewed" } })).toThrow();
  expect(() => new StylesheetSettlementError("deadline", { ...evidence, last: { ...disabled, font: "a".repeat(1025) } })).toThrow();
});

test("the browser probe samples adjacent RAF callbacks and cleans timers without mutating styles", async () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  const callbacks: FrameRequestCallback[] = [];
  let cleared = 0, cancelled = 0, checks = 0, layouts = 0;
  const document = {};
  const element = { isConnected: true, ownerDocument: document, getBoundingClientRect: () => { layouts += 1; } };
  const view = {
    setTimeout: () => 1, clearTimeout: () => { cleared += 1; }, cancelAnimationFrame: () => { cancelled += 1; },
    requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; },
    getComputedStyle: () => ({ display: "block", minHeight: "auto", paddingLeft: "0px", borderTopWidth: "0px", fontSize: "38.4px" }),
  };
  Object.assign(document, { defaultView: view, fonts: { ready: Promise.resolve() } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  try {
    const result = readRestoredStyleFramePair({ assertRestored: () => { checks += 1; }, sampleTarget: element as unknown as Element }, { foundation: false, remainingMs: 50 });
    await Promise.resolve();
    const first = callbacks[0]; if (first === undefined) throw new Error("Missing first frame"); first(1);
    const second = callbacks[1]; if (second === undefined) throw new Error("Missing adjacent frame"); second(2);
    expect(await result).toEqual(pair(1));
    expect({ checks, layouts, cleared, cancelled, callbacks: callbacks.length }).toEqual({ checks: 4, layouts: 2, cleared: 1, cancelled: 1, callbacks: 2 });
  } finally {
    if (prior === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", prior);
  }
});

async function browserFrameProbe(timestamps: readonly number[], samples: readonly typeof expected[] = [], expire = false) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
  const callbacks: FrameRequestCallback[] = [];
  let timeout: () => void = () => { throw new Error("Missing frame-probe deadline"); };
  let cleared = 0, cancelled = 0, checks = 0, layouts = 0, delivered = 0;
  let sample = expected;
  const document = {};
  const target = { isConnected: true, ownerDocument: document, getBoundingClientRect: () => { layouts += 1; } };
  const view = {
    setTimeout: (callback: () => void) => { timeout = callback; return 1; },
    clearTimeout: () => { cleared += 1; }, cancelAnimationFrame: () => { cancelled += 1; },
    requestAnimationFrame: (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length; },
    getComputedStyle: () => ({ display: sample.display, minHeight: sample.height, paddingLeft: sample.padding,
      borderTopWidth: sample.border, fontSize: sample.font }),
  };
  Object.assign(document, { defaultView: view, fonts: { ready: Promise.resolve() } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: document });
  try {
    const pending = readRestoredStyleFramePair({ assertRestored: () => { checks += 1; }, sampleTarget: target as unknown as Element },
      { foundation: false, remainingMs: 50 });
    await Promise.resolve();
    for (const [index, timestamp] of timestamps.entries()) {
      const callback = callbacks[index];
      if (callback === undefined) break;
      sample = samples[index] ?? expected;
      delivered += 1; callback(timestamp);
    }
    if (expire) timeout();
    let value: unknown, error: Error | undefined;
    try { value = await pending; } catch (cause) {
      if (!(cause instanceof Error)) throw new Error("Unexpected frame-probe rejection", { cause });
      error = cause;
    }
    return { value, error, cleared, cancelled, checks, layouts, delivered, scheduled: callbacks.length };
  } finally {
    if (prior === undefined) Reflect.deleteProperty(globalThis, "document");
    else Object.defineProperty(globalThis, "document", prior);
  }
}

test("repeated browser timestamps discard the old sample and require a fresh adjacent increasing pair", async () => {
  const probe = await browserFrameProbe([7, 7, 8], [expected, disabled, expected]);
  expect(probe.error).toBeUndefined();
  expect(probe.value).toEqual(pair(7, disabled, expected));
  expect(advanceStylesheetSettlement(initialStylesheetSettlement(), probe.value, expected, false).phase).toBe("waiting");
  expect({ delivered: probe.delivered, scheduled: probe.scheduled, checks: probe.checks, layouts: probe.layouts,
    cleared: probe.cleared, cancelled: probe.cancelled }).toEqual({ delivered: 3, scheduled: 3, checks: 6, layouts: 3, cleared: 1, cancelled: 1 });
});

test("bounded repeated timestamp prefixes never invent increasing evidence or carry discarded styles", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 1, max: 16 }),
    fc.boolean(), fc.boolean(), async (timestamp, repeats, firstMatches, secondMatches) => {
      const first = firstMatches ? expected : disabled, second = secondMatches ? expected : disabled;
      const probe = await browserFrameProbe([...Array<number>(repeats).fill(timestamp), timestamp + 1],
        [...Array<typeof expected>(repeats - 1).fill(expected), first, second]);
      expect(probe.error).toBeUndefined(); expect(probe.value).toEqual(pair(timestamp, first, second));
      expect(probe.delivered).toBe(repeats + 1);
      expect(advanceStylesheetSettlement(initialStylesheetSettlement(), probe.value, expected, false).phase === "settled")
        .toBe(firstMatches && secondMatches);
      expect(probe.cleared).toBe(1); expect(probe.cancelled).toBe(1);
    }), { seed: 0x51f7, numRuns: 80 });
});

test("invalid or regressing callback times remain failures and repeated times retain deadline and callback limits", async () => {
  for (const timestamp of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const probe = await browserFrameProbe([timestamp]);
    expect(probe.error?.message).toBe("Invalid stylesheet callback timestamp: nonfinite or negative");
    expect(probe.value).toBeUndefined(); expect(probe.cleared).toBe(1); expect(probe.cancelled).toBe(1);
  }
  const regressed = await browserFrameProbe([7, 6]);
  expect(regressed.error?.message).toBe("Stylesheet callback timestamp regressed: previous=7, current=6");
  expect(regressed.value).toBeUndefined(); expect(regressed.scheduled).toBe(2);
  const expired = await browserFrameProbe([7, 7], [], true);
  expect(expired.error?.message).toBe("Stylesheet frame probe exceeded its remaining deadline");
  expect(expired.value).toBeUndefined(); expect(expired.cleared).toBe(1); expect(expired.cancelled).toBe(1);
  const exhausted = await browserFrameProbe(Array<number>(4097).fill(7));
  expect(exhausted.error?.message).toBe("Stylesheet frame probe exhausted its callback bound");
  expect(exhausted.value).toBeUndefined(); expect(exhausted.delivered).toBe(4097); expect(exhausted.scheduled).toBe(4097);
  expect(exhausted.layouts).toBe(4096); expect(exhausted.cleared).toBe(1); expect(exhausted.cancelled).toBe(1);
});

test("browser probe expiry, font rejection and target drift stop their own RAF/timer work", async () => {
  for (const boundary of ["fonts-pending", "font-rejection", "target-drift", "identity-drift"] as const) {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
    const frames: FrameRequestCallback[] = [];
    let timeout: () => void = () => { throw new Error("Missing browser probe timer"); };
    let releaseFont: () => void = () => { throw new Error("Missing font observer"); };
    let rejectFont: (reason: Error) => void = () => { throw new Error("Missing font failure observer"); };
    const fonts = new Promise<void>((resolve, reject) => { releaseFont = resolve; rejectFont = reject; });
    const document = {};
    const target = { isConnected: true, ownerDocument: document, getBoundingClientRect: () => {} };
    let clears = 0, cancels = 0;
    const view = {
      setTimeout: (callback: () => void) => { timeout = callback; return 1; },
      clearTimeout: () => { clears += 1; }, cancelAnimationFrame: () => { cancels += 1; },
      requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; },
      getComputedStyle: () => ({ display: "block", minHeight: "auto", paddingLeft: "0px", borderTopWidth: "0px", fontSize: "38.4px" }),
    };
    Object.assign(document, { defaultView: view, fonts: { ready: fonts } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: document });
    try {
      const result = readRestoredStyleFramePair({
        sampleTarget: target as unknown as Element,
        assertRestored: () => { if (boundary === "identity-drift") throw new Error("Exact identity changed"); },
      }, { foundation: false, remainingMs: 20 });
      if (boundary === "fonts-pending") timeout();
      else if (boundary === "font-rejection") rejectFont(new Error("Fonts did not become ready"));
      else {
        releaseFont(); await Promise.resolve();
        if (boundary === "target-drift") target.isConnected = false;
        const callback = frames[0]; if (callback === undefined) throw new Error("Missing sample frame"); callback(1);
      }
      await expect(result).rejects.toBeInstanceOf(Error);
      expect(clears).toBe(1);
      expect(cancels).toBe(boundary === "fonts-pending" || boundary === "font-rejection" ? 0 : 1);
      releaseFont(); await Promise.resolve();
      expect(frames.length).toBe(boundary === "fonts-pending" || boundary === "font-rejection" ? 0 : 1);
    } finally {
      if (prior === undefined) Reflect.deleteProperty(globalThis, "document");
      else Object.defineProperty(globalThis, "document", prior);
    }
  }
});
