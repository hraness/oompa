/** Read-only rendering evidence. This module never enables, reloads or replaces CSS. */
export const stylesheetSettlementBudgetMs = 15_000;
const maximumPairs = 2048;
const baseKeys = ["display", "height", "padding", "border", "font"] as const;
const foundationKeys = ["boxSizing", "fontFamily", "lineHeight", "backgroundToken"] as const;
export type StylesheetSample = Readonly<Record<string, string>>;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new Error("Invalid stylesheet settlement record");
  }
  return value as Record<string, unknown>;
}

export function parseStylesheetSample(value: unknown, foundation: boolean): StylesheetSample {
  const input = object(value);
  const keys: readonly string[] = foundation ? [...baseKeys, ...foundationKeys] : baseKeys;
  if (Object.keys(input).length !== keys.length || Object.keys(input).some((key) => !keys.includes(key))) {
    throw new Error("Unexpected stylesheet sample fields");
  }
  const result: Record<string, string> = {};
  for (const key of keys) {
    const field = input[key];
    if (typeof field !== "string" || field.length > 1024
      || Array.from(field).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error("Invalid bounded stylesheet sample field");
    }
    result[key] = field;
  }
  return Object.freeze(result);
}

function sameSample(actual: StylesheetSample, expected: StylesheetSample): boolean {
  return Object.keys(actual).length === Object.keys(expected).length
    && Object.keys(expected).every((key) => actual[key] === expected[key]);
}

export type StylesheetSettlementState = Readonly<{
  phase: "waiting" | "settled";
  pairs: number;
  matchingFrames: number;
  frame: number | null;
  first: StylesheetSample | null;
  last: StylesheetSample | null;
}>;

export function initialStylesheetSettlement(): StylesheetSettlementState {
  return Object.freeze({ phase: "waiting", pairs: 0, matchingFrames: 0, frame: null, first: null, last: null });
}

/** Each pair comes from adjacent callbacks in ONE browser operation. Matches
 * never accumulate across separate protocol calls, which may skip frames. */
export function advanceStylesheetSettlement(
  state: StylesheetSettlementState, value: unknown, expected: StylesheetSample, foundation: boolean,
): StylesheetSettlementState {
  if (state.phase !== "waiting" || state.pairs >= maximumPairs) throw new Error("Stylesheet settlement is terminal or exhausted");
  if (!Array.isArray(value) || value.length !== 2) throw new Error("Expected one consecutive stylesheet frame pair");
  let frame = state.frame;
  let first = state.first;
  let last = state.last;
  let matchingFrames = 0;
  const frameIdentities = value.map((entry: unknown) => {
    const item = object(entry);
    return typeof item.frame !== "number" ? "nonnumeric"
      : Number.isFinite(item.frame) ? item.frame : "nonfinite";
  });
  for (const entry of value as unknown[]) {
    const item = object(entry);
    if (Object.keys(item).length !== 2 || !("frame" in item) || !("sample" in item)
      || typeof item.frame !== "number" || !Number.isFinite(item.frame) || item.frame < 0
      || (frame !== null && item.frame <= frame)) {
      throw new Error(`Invalid stylesheet frame identity: previous=${String(state.frame)}, pair=${JSON.stringify(frameIdentities)}`);
    }
    last = parseStylesheetSample(item.sample, foundation);
    first ??= last;
    frame = item.frame;
    matchingFrames = sameSample(last, expected) ? matchingFrames + 1 : 0;
  }
  return Object.freeze({ phase: matchingFrames === 2 ? "settled" : "waiting", pairs: state.pairs + 1, matchingFrames, frame, first, last });
}

export type StylesheetSettlementDiagnostics = Readonly<{
  pairs: number; matchingFrames: number; elapsedMs: number;
  expected: StylesheetSample; first: StylesheetSample | null; last: StylesheetSample | null;
}>;
type FailureReason = "cancelled" | "deadline" | "frame-limit" | "operation";
export class StylesheetSettlementError extends Error {
  readonly diagnostics: StylesheetSettlementDiagnostics;
  constructor(readonly reason: FailureReason, diagnostics: StylesheetSettlementDiagnostics, cause?: unknown) {
    super(reason === "deadline" ? "Browser stylesheet restoration exceeded its existing deadline"
      : reason === "cancelled" ? "Browser stylesheet restoration cancelled"
        : "Browser stylesheet restoration did not settle", { cause });
    this.name = reason === "cancelled" ? "AbortError" : reason === "deadline" ? "TimeoutError" : "StylesheetSettlementError";
    if (!Number.isInteger(diagnostics.pairs) || diagnostics.pairs < 0 || diagnostics.pairs > maximumPairs
      || !Number.isInteger(diagnostics.matchingFrames) || diagnostics.matchingFrames < 0 || diagnostics.matchingFrames > 2
      || !Number.isInteger(diagnostics.elapsedMs) || diagnostics.elapsedMs < 0 || diagnostics.elapsedMs > stylesheetSettlementBudgetMs
      || (diagnostics.pairs === 0 ? diagnostics.first !== null || diagnostics.last !== null || diagnostics.matchingFrames !== 0
        : diagnostics.first === null || diagnostics.last === null)) throw new Error("Invalid stylesheet settlement diagnostics");
    const foundation = Object.hasOwn(diagnostics.expected, "boxSizing");
    this.diagnostics = Object.freeze({
      pairs: diagnostics.pairs, matchingFrames: diagnostics.matchingFrames, elapsedMs: diagnostics.elapsedMs,
      expected: parseStylesheetSample(diagnostics.expected, foundation),
      first: diagnostics.first === null ? null : parseStylesheetSample(diagnostics.first, foundation),
      last: diagnostics.last === null ? null : parseStylesheetSample(diagnostics.last, foundation),
    });
  }
}

export interface StylesheetSettlementClock {
  now(): number;
  deadline(callback: () => void, milliseconds: number): () => void;
}
const nativeClock: StylesheetSettlementClock = {
  now: () => performance.now(),
  deadline: (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    return () => { clearTimeout(timer); };
  },
};
export interface StylesheetSettlementOperations {
  assertIdentity(signal: AbortSignal): Promise<void>;
  readPair(signal: AbortSignal, remainingMs: number): Promise<unknown>;
}

/** A single total operation budget, additionally capped by the unchanged
 * profile deadline. Cancellation fences every awaited result. An interrupted
 * read is read-only; the existing browser owner still collects its transport. */
export async function settleExactStylesheet(options: {
  expected: unknown; foundation: boolean; signal: AbortSignal; profileDeadline: number;
  operations: StylesheetSettlementOperations; clock?: StylesheetSettlementClock;
}): Promise<StylesheetSettlementDiagnostics> {
  const expected = parseStylesheetSample(options.expected, options.foundation);
  const clock = options.clock ?? nativeClock;
  const started = clock.now();
  if (!Number.isFinite(started) || started < 0 || !Number.isFinite(options.profileDeadline)) {
    throw new Error("Invalid stylesheet settlement deadline");
  }
  const deadline = Math.min(started + stylesheetSettlementBudgetMs, options.profileDeadline);
  let state = initialStylesheetSettlement();
  let observedTime = started;
  let stopped: StylesheetSettlementError | undefined;
  const internal = new AbortController();
  const diagnostics = (): StylesheetSettlementDiagnostics => Object.freeze({
    pairs: state.pairs, matchingFrames: state.matchingFrames,
    elapsedMs: Math.min(stylesheetSettlementBudgetMs, Math.max(0, Math.floor(observedTime - started))),
    expected, first: state.first, last: state.last,
  });
  let rejectStop: (error: Error) => void = () => { throw new Error("Missing settlement deadline observer"); };
  const terminal = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  // A pre-dispatch cancellation can reject before the first Promise.race.
  void terminal.catch(() => undefined);
  const stop = (reason: FailureReason, cause?: unknown) => {
    if (stopped !== undefined) return;
    stopped = new StylesheetSettlementError(reason, diagnostics(), cause);
    internal.abort();
    rejectStop(stopped);
  };
  const assertRunning = () => {
    if (stopped !== undefined) throw stopped;
  };
  const inspect = () => {
    assertRunning();
    const now = clock.now();
    if (!Number.isFinite(now) || now < observedTime) stop("operation", new Error("Stylesheet settlement clock regressed"));
    else observedTime = now;
    if (options.signal.aborted) stop("cancelled");
    if (observedTime >= deadline) stop("deadline");
    assertRunning();
  };
  const onAbort = () => { stop("cancelled"); };
  options.signal.addEventListener("abort", onAbort, { once: true });
  let disarm = () => {};
  try {
    inspect();
    disarm = clock.deadline(() => { observedTime = Math.max(observedTime, deadline); stop("deadline"); }, deadline - observedTime);
    const operation = async <T>(run: () => Promise<T>): Promise<T> => {
      inspect();
      const result = await Promise.race([run(), terminal]);
      inspect();
      return result;
    };
    while (state.phase === "waiting") {
      if (state.pairs >= maximumPairs) { stop("frame-limit"); inspect(); }
      await operation(() => options.operations.assertIdentity(internal.signal));
      const pair = await operation(() => options.operations.readPair(internal.signal, deadline - observedTime));
      state = advanceStylesheetSettlement(state, pair, expected, options.foundation);
      await operation(() => options.operations.assertIdentity(internal.signal));
    }
    inspect();
    return diagnostics();
  } catch (error) {
    if (stopped === undefined) stop("operation", error);
    throw stopped ?? new Error("Missing stylesheet settlement failure");
  } finally {
    disarm();
    options.signal.removeEventListener("abort", onAbort);
    internal.abort();
  }
}

/** Self-contained Playwright browser-realm function. Do not reference imported
 * helpers here: evaluate serializes this function without module scope. */
export function readRestoredStyleFramePair(
  control: { assertRestored(): void; sampleTarget: Element | null },
  input: { foundation: boolean; remainingMs: number },
): Promise<unknown> {
  if (typeof input.foundation !== "boolean" || !Number.isFinite(input.remainingMs)
    || input.remainingMs <= 0 || input.remainingMs > 15_000) throw new Error("Invalid stylesheet frame probe");
  const document = globalThis.document;
  const candidateView = document.defaultView;
  const candidateElement = control.sampleTarget;
  if (candidateView === null || candidateElement === null || !candidateElement.isConnected
    || candidateElement.ownerDocument !== document) throw new Error("Missing stylesheet sample target");
  const view = candidateView;
  const element = candidateElement;
  return new Promise((resolve, reject) => {
    let finished = false;
    let animationFrame: number | undefined;
    let callbacks = 0;
    let previousTimestamp: number | undefined;
    const frames: { frame: number; sample: Record<string, string> }[] = [];
    const timer = view.setTimeout(() => fail(new Error("Stylesheet frame probe exceeded its remaining deadline")), input.remainingMs);
    function release() {
      view.clearTimeout(timer);
      if (animationFrame !== undefined) view.cancelAnimationFrame(animationFrame);
    }
    function fail(error: unknown) {
      if (finished) return;
      finished = true; release();
      reject(error instanceof Error ? error : new Error("Stylesheet frame probe failed", { cause: error }));
    }
    function frame(timestamp: number) {
      if (finished) return;
      try {
        control.assertRestored();
        callbacks += 1;
        if (callbacks > 4096) throw new Error("Stylesheet frame probe exhausted its callback bound");
        if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error("Invalid stylesheet callback timestamp: nonfinite or negative");
        if (previousTimestamp !== undefined && timestamp < previousTimestamp) {
          throw new Error(`Stylesheet callback timestamp regressed: previous=${String(previousTimestamp)}, current=${String(timestamp)}`);
        }
        // A repeated browser timestamp is not another admissible frame. Forget
        // the earlier sample and require a fresh adjacent increasing pair.
        // The original timer, identity checks and strict reducer stay in force.
        if (timestamp === previousTimestamp) frames.length = 0;
        previousTimestamp = timestamp;
        if (!element.isConnected || element.ownerDocument !== document) {
          throw new Error("Stylesheet sample target changed");
        }
        element.getBoundingClientRect();
        const css = view.getComputedStyle(element);
        const sample = {
          display: css.display, height: css.minHeight, padding: css.paddingLeft, border: css.borderTopWidth, font: css.fontSize,
          ...(input.foundation ? { boxSizing: css.boxSizing, fontFamily: css.fontFamily, lineHeight: css.lineHeight,
            backgroundToken: css.getPropertyValue("--background") } : {}),
        };
        control.assertRestored();
        frames.push({ frame: timestamp, sample });
        if (frames.length === 2) { finished = true; release(); resolve(frames); }
        else animationFrame = view.requestAnimationFrame(frame);
      } catch (error) { fail(error); }
    }
    try {
      void document.fonts.ready.then(() => {
        if (!finished) {
          try { animationFrame = view.requestAnimationFrame(frame); } catch (error) { fail(error); }
        }
      }, fail);
    } catch (error) { fail(error); }
  });
}
