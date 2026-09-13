import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { z } from "zod";

import { createClaudeLoginSignalCustody, type ClaudeForegroundLoginProcess, type ClaudeLoginSignalCustody, type ClaudeLoginSignalSource } from "../../src/claude/auth";

export class OwnerTerminalError extends Error {
  constructor(readonly code: "owner_refused" | "aborted" | "authority_refused" | "order_refused", readonly cleanup?: "uncertain") {
    super(`CLAUDE_MACOS_OWNER_TERMINAL_${code}`); this.name = "OwnerTerminalError";
  }
}
const refused = (code: OwnerTerminalError["code"]): never => { throw new OwnerTerminalError(code); };
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const scopeSchema = z.strictObject({ runId: uuid, attemptId: uuid, step: z.number().int().min(0).max(21) });
export type OwnerTerminalScope = Readonly<z.infer<typeof scopeSchema>>;
function scope(value: unknown): OwnerTerminalScope {
  const parsed = scopeSchema.safeParse(value); if (!parsed.success) return refused("authority_refused");
  return Object.freeze(parsed.data);
}
const same = (a: OwnerTerminalScope, b: OwnerTerminalScope): boolean => a.runId === b.runId && a.attemptId === b.attemptId && a.step === b.step;

export type OwnerTerminalStreams = Readonly<{ input: Readable; output: Writable; assertCurrent(): void }>;
const retainedPromptWrites = new Set<Promise<void>>();
async function writeOwnerPrompt(output: Writable, message: string): Promise<void> {
  const completion = new Promise<void>((done, reject) => {
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return; finished = true;
      output.off("error", failed); output.off("close", closed);
      if (error === undefined) done(); else reject(new OwnerTerminalError("owner_refused"));
    };
    const failed = (): void => { finish(new Error("terminal_write_failed")); };
    const closed = (): void => { failed(); };
    output.once("error", failed); output.once("close", closed);
    // Writable emits its error after the failed write callback. Keep the owned
    // error/close listeners until that terminal event, rather than exposing it.
    try { output.write(message, (error) => { if (!error) finish(); }); } catch { failed(); }
  });
  retainedPromptWrites.add(completion);
  void completion.then(() => retainedPromptWrites.delete(completion), () => retainedPromptWrites.delete(completion));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([completion, new Promise<never>((_done, reject) => {
    timer = setTimeout(() => { reject(new OwnerTerminalError("owner_refused", "uncertain")); }, 1000);
  })]); } finally { clearTimeout(timer); }
}
/** This reader owns only its listeners and temporary bytes, never the owner's descriptors. */
async function promptOwner(streams: OwnerTerminalStreams, signal: AbortSignal, scope: OwnerTerminalScope, challenge: string, description: string, readiness = false): Promise<void> {
  const isAborted = (): boolean => signal.aborted;
  streams.assertCurrent(); if (isAborted()) return refused("aborted");
  const input = streams.input;
  let outputFailed = false; let rejectResponse: (() => void) | null = null;
  const unavailable = (): boolean => outputFailed || input.destroyed || input.readableEnded || streams.output.destroyed || streams.output.writableEnded;
  if (unavailable() || input.readableEncoding !== null || input.readableFlowing === true
    || input.readableLength !== 0 || input.listenerCount("data") !== 0 || input.listenerCount("readable") !== 0) return refused("owner_refused");
  const expected = Buffer.from(readiness ? "\n" : `${challenge} ${randomUUID()}\n`, "ascii");
  const message = readiness ? `${description}\nPress Enter when ready.\n`
    : `${description} For run ${scope.runId}, attempt ${scope.attemptId}, step ${scope.step}. Type exactly: ${expected.toString("ascii")}`;
  const outputFailure = (): void => { outputFailed = true; rejectResponse?.(); };
  streams.output.on("error", outputFailure); streams.output.on("close", outputFailure);
  try {
    await writeOwnerPrompt(streams.output, message);
    streams.assertCurrent(); if (isAborted()) return refused("aborted");
    if (unavailable()) return refused("owner_refused");
    await new Promise<void>((done, reject) => {
      const buffer = Buffer.alloc(128); let size = 0; let finished = false;
      const finish = (error?: OwnerTerminalError): void => {
        if (finished) return; finished = true;
        input.pause(); input.off("data", data); input.off("end", ended); input.off("error", failed); input.off("close", ended);
        rejectResponse = null;
        signal.removeEventListener("abort", aborted); process.off("SIGINT", interrupted); process.off("SIGTERM", interrupted);
        buffer.fill(0); if (error === undefined) done(); else reject(error);
      };
      const failed = (): void => { finish(new OwnerTerminalError("owner_refused")); };
      rejectResponse = failed;
      const ended = (): void => { failed(); };
      const aborted = (): void => { finish(new OwnerTerminalError("aborted")); };
      const interrupted = (): void => { aborted(); };
      const data = (value: unknown): void => {
        try {
          streams.assertCurrent();
          if (!(value instanceof Uint8Array) || value.byteLength > buffer.length - size || signal.aborted) { failed(); return; }
          buffer.set(value, size); size += value.byteLength;
          if (buffer.subarray(0, size).includes(10)) {
            if (!buffer.subarray(0, size).equals(expected)) { failed(); return; }
            streams.assertCurrent(); finish();
          }
        } catch { failed(); }
        finally { if (value instanceof Uint8Array) value.fill(0); }
      };
      input.on("data", data); input.once("end", ended); input.once("error", failed); input.once("close", ended);
      signal.addEventListener("abort", aborted, { once: true }); process.on("SIGINT", interrupted); process.on("SIGTERM", interrupted);
      if (isAborted()) aborted(); else if (unavailable()) failed(); else input.resume();
    });
  } finally { streams.output.off("error", outputFailure); streams.output.off("close", outputFailure); expected.fill(0); }
}


/** Shared input only. The caller still owns actual child/binder joins and native authority. */
export async function readOwnerTerminalResponse(streams: OwnerTerminalStreams, signal: AbortSignal, value: unknown): Promise<void> {
  const current = scope(value);
  const prompts = {
    1: ["signed-in-A", "Claude's A login child has joined. Confirm you signed in to your intended A account."],
    4: ["signed-in-B-distinct", "Claude's B login child has joined. Confirm you chose a different intended B account."],
    13: ["interrupted-before-browser-completion", "The interrupted A login child has joined. Confirm you pressed Ctrl-C before completing browser authentication."],
    15: ["recovered-A", "Claude's recovery A login child has joined. Confirm you chose the original intended A account."],
  } as const;
  if (current.step !== 1 && current.step !== 4 && current.step !== 13 && current.step !== 15) return refused("order_refused");
  const [challenge, description] = prompts[current.step];
  await promptOwner(streams, signal, current, challenge, description);
}

/** Readiness is an owner observation before launch, never successful authentication evidence. */
export async function prepareOwnerManualBrowserLogin(streams: OwnerTerminalStreams, signal: AbortSignal, value: unknown): Promise<void> {
  const current = scope(value);
  const prompts = {
    1: ["ready-A", "Next: sign in to your intended A account."],
    4: ["ready-B", "Next: sign in to your intended B account, different from A. Do not accept A if it appears."],
    13: ["ready-interrupt-A", "Next: interrupt A's login. After Claude prints its link, press Ctrl-C before opening the link or completing authentication."],
    15: ["ready-recover-A", "Next: sign in to the original intended A account again."],
  } as const;
  if (current.step !== 1 && current.step !== 4 && current.step !== 13 && current.step !== 15) return refused("order_refused");
  const [challenge, task] = prompts[current.step];
  await promptOwner(streams, signal, current, challenge, `${task} Claude has not started this login. Automatic browser opening is disabled.\nClose all prior private/incognito windows in the browser you will use, then open one fresh private window: multiple private windows can share cookies. Keep your normal windows and sessions unchanged.\n${current.step === 13 ? "For this interruption step, do not open the link." : "Copy that exact link from Claude's terminal into the fresh private window without changing it; do not click it into your normal browser. Check the intended account before approving sign-in."}`, true);
}

const armBrand = Symbol("qualification-interruption-owner-input");
export type OwnerInterruptionArm = Readonly<{ [armBrand]: true }>;
const interruptionArms = new WeakMap<OwnerInterruptionArm, OwnerTerminalScope>();
/** A fresh prelaunch response arms only its exact step-13 attempt; this is not human identity proof. */
export async function armOwnerTerminalInterruption(streams: OwnerTerminalStreams, signal: AbortSignal, value: unknown): Promise<OwnerInterruptionArm> {
  const current = scope(value); if (current.step !== 13) return refused("order_refused");
  await promptOwner(streams, signal, current, "interrupt-A", "The planned A login has not started. Prepare to press Ctrl-C before completing browser authentication.");
  streams.assertCurrent(); if (signal.aborted) return refused("aborted");
  const arm = Object.freeze({ [armBrand]: true as const }); interruptionArms.set(arm, current); return arm;
}

/** Arming precedes targets. Finishing must follow the caller's actual target, metadata and overlap joins. */
export async function armOwnerTerminalNoPromptWindow(streams: OwnerTerminalStreams, signal: AbortSignal, value: unknown): Promise<Readonly<{
  finish(value: unknown): Promise<void>; close(): void;
}>> {
  const current = scope(value); const isAborted = (): boolean => signal.aborted;
  if (![6, 7, 8, 9, 10, 12, 14, 16, 18, 20].includes(current.step)) return refused("order_refused");
  streams.assertCurrent(); if (isAborted()) return refused("aborted");
  if (streams.input.destroyed || streams.input.readableEnded || streams.output.destroyed || streams.output.writableEnded) return refused("owner_refused");
  let closed = false; let used = false; let outputFailed = false;
  const hasOutputFailed = (): boolean => outputFailed; const isClosed = (): boolean => closed;
  const responseAbort = new AbortController();
  const abortResponse = (): void => { responseAbort.abort(); };
  const failed = (): void => { outputFailed = true; };
  const close = (): void => {
    if (isClosed()) return; closed = true; abortResponse();
    signal.removeEventListener("abort", abortResponse);
    streams.output.off("error", failed); streams.output.off("close", failed);
  };
  signal.addEventListener("abort", abortResponse, { once: true }); if (isAborted()) abortResponse();
  streams.output.on("error", failed); streams.output.on("close", failed);
  try {
    await writeOwnerPrompt(streams.output, `For run ${current.runId}, attempt ${current.attemptId}, step ${current.step}, watch for graphical authentication prompts during the upcoming detached observation. Do not type a response until its joined completion prompt.\n`);
    streams.assertCurrent(); if (isAborted()) return refused("aborted"); if (hasOutputFailed()) return refused("owner_refused");
  } catch (error: unknown) { close(); throw error; }
  return Object.freeze({
    async finish(value: unknown) {
      if (used || isClosed()) return refused("order_refused"); used = true;
      try {
        if (!same(current, scope(value))) return refused("order_refused");
        if (hasOutputFailed()) return refused("owner_refused");
        await promptOwner(streams, responseAbort.signal, current, "no-graphical-prompt", "The detached observation obligations have joined. Confirm you observed no graphical authentication prompt during the armed window.");
        if (isClosed()) return refused("order_refused");
        streams.assertCurrent(); if (isAborted()) return refused("aborted"); if (hasOutputFailed()) return refused("owner_refused");
      } catch (error: unknown) { if (isClosed()) return refused("order_refused"); throw error; }
      finally { close(); }
    }, close,
  });
}

type LoginStep = 1 | 4 | 13 | 15;
type ActiveLogin = {
  scope: OwnerTerminalScope; custody: ClaudeLoginSignalCustody; underlying: ClaudeLoginSignalCustody;
  child: ClaudeForegroundLoginProcess | null; joined: Promise<number | null> | null; exited: boolean; collecting: boolean;
  wrappers: Map<() => void, Readonly<{ signal: "SIGINT" | "SIGTERM"; listener: () => void }>>;
};
const retainedSignalScopes = new Set<ActiveLogin>();
/** Signal policy only: injected process interfaces never establish native provenance. */
export function createQualificationTerminalSignals(external: AbortSignal, source: ClaudeLoginSignalSource): Readonly<{
  signal: AbortSignal;
  beginLogin(value: unknown, arm?: OwnerInterruptionArm): ClaudeLoginSignalCustody;
  finishLogin(custody: ClaudeLoginSignalCustody): Promise<void>;
  close(): "joined" | "uncertain";
}> {
  const stop = new AbortController(); const childAbort = new AbortController();
  const sequence: readonly LoginStep[] = [1, 4, 13, 15]; let index = 0; let runId: string | null = null;
  const attempts = new Set<string>(); let active: ActiveLogin | null = null; let closed = false;
  const isClosed = (): boolean => closed;
  const between = new Set<"SIGINT" | "SIGTERM">();
  const stopBetween = (): void => { stop.abort(); };
  const externalAbort = (): void => { stop.abort(); childAbort.abort(); };
  const installBetween = (): void => { for (const signal of ["SIGINT", "SIGTERM"] as const) if (!between.has(signal)) { source.add(signal, stopBetween); between.add(signal); } };
  const removeBetween = (): void => { for (const signal of between) source.remove(signal, stopBetween); between.clear(); };
  const closeActive = (current: ActiveLogin): void => {
    current.underlying.close();
    for (const entry of current.wrappers.values()) source.remove(entry.signal, entry.listener);
    current.wrappers.clear();
    retainedSignalScopes.delete(current);
  };
  try { installBetween(); external.addEventListener("abort", externalAbort, { once: true }); if (external.aborted) externalAbort(); }
  catch { removeBetween(); external.removeEventListener("abort", externalAbort); return refused("authority_refused"); }
  return Object.freeze({ signal: stop.signal,
    beginLogin(value: unknown, arm?: OwnerInterruptionArm) {
      const currentScope = scope(value);
      if (isClosed() || stop.signal.aborted) return refused("aborted");
      if (active !== null || currentScope.step !== sequence[index] || (runId !== null && currentScope.runId !== runId) || attempts.has(currentScope.attemptId)) return refused("order_refused");
      if (currentScope.step === 13) {
        const armed = arm === undefined ? undefined : interruptionArms.get(arm);
        if (armed === undefined || !same(currentScope, armed)) return refused("authority_refused");
        if (arm !== undefined) interruptionArms.delete(arm);
      } else if (arm !== undefined) return refused("authority_refused");
      runId = currentScope.runId; attempts.add(currentScope.attemptId);
      const wrappers: ActiveLogin["wrappers"] = new Map(); let holder: ActiveLogin | null = null;
      let underlying: ClaudeLoginSignalCustody;
      try {
        underlying = createClaudeLoginSignalCustody({ signal: childAbort.signal, signalGraceMs: 1000, signalSource: {
          add(signal, listener) {
            const wrapped = (): void => {
              listener();
              // A terminal signal already reached the child's foreground group.
              // Stopping the run must not forward a second TERM through childAbort.
              if (signal !== "SIGINT" || holder?.scope.step !== 13 || holder.child === null || holder.exited) stop.abort();
            };
            source.add(signal, wrapped); wrappers.set(listener, { signal, listener: wrapped });
          },
          remove(_signal, listener) { const entry = wrappers.get(listener); if (entry !== undefined) { source.remove(entry.signal, entry.listener); wrappers.delete(listener); } },
        } });
      } catch { for (const entry of wrappers.values()) source.remove(entry.signal, entry.listener); stop.abort(); return refused("authority_refused"); }
      const custody: ClaudeLoginSignalCustody = Object.freeze({
        get interruptedBy() { return underlying.interruptedBy; }, forceBoundary: underlying.forceBoundary,
        attachChild(child: ClaudeForegroundLoginProcess) {
          if (holder === null || holder.child !== null) return refused("order_refused");
          holder.child = child;
          holder.joined = Promise.resolve(child.exited).then((code) => {
            if (!Number.isSafeInteger(code)) return null;
            if (holder !== null) holder.exited = true;
            return code;
          }, () => null);
          if (isClosed()) {
            stop.abort(); try { child.forceTerminate(); } catch { /* No join is inferred. */ }
            retainedSignalScopes.add(holder); throw new OwnerTerminalError("authority_refused", "uncertain");
          }
          underlying.attachChild(child);
        },
        // The controller retains listeners until its bounded join and handoff.
        close() {},
      });
      holder = { scope: currentScope, custody, underlying, child: null, joined: null, exited: false, collecting: false, wrappers };
      active = holder; removeBetween(); return custody;
    },
    async finishLogin(custody: ClaudeLoginSignalCustody) {
      const current = active;
      if (isClosed() || current === null || current.custody !== custody || current.joined === null || current.collecting) { stop.abort(); return refused("order_refused"); }
      current.collecting = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let code: number | null;
      try { code = await Promise.race([current.joined, new Promise<null>((done) => { timer = setTimeout(() => { done(null); }, 1000); })]); }
      finally { clearTimeout(timer); }
      // close() may run after the child exit is observed but before this await
      // resumes. A closed/replaced scope may neither reinstall nor advance.
      if (isClosed() || active !== current) { stop.abort(); return refused("aborted"); }
      if (code === null) { stop.abort(); retainedSignalScopes.add(current); throw new OwnerTerminalError("authority_refused", "uncertain"); }
      const interruption = current.underlying.interruptedBy;
      const accepted = current.scope.step === 13 ? interruption === "SIGINT" : interruption === null && code === 0;
      if (!accepted || stop.signal.aborted) stop.abort();
      // The new owner is present before old foreground listeners disappear.
      try { installBetween(); closeActive(current); } catch { stop.abort(); retainedSignalScopes.add(current); throw new OwnerTerminalError("authority_refused", "uncertain"); }
      active = null; if (stop.signal.aborted) return refused("aborted"); index += 1;
    },
    close() {
      if (isClosed()) return active === null ? "joined" : "uncertain"; closed = true;
      external.removeEventListener("abort", externalAbort);
      removeBetween();
      const current = active;
      if (current === null) return "joined";
      if (current.child === null || current.exited) { closeActive(current); active = null; return "joined"; }
      stop.abort(); childAbort.abort(); retainedSignalScopes.add(current);
      // No stored-PID signal or claimed join. An unresolved child retains its
      // exact handle and signal timer until its own successful exit observation.
      void current.joined?.then((code) => { if (code !== null) { try { closeActive(current); active = null; } catch { retainedSignalScopes.add(current); } } });
      return "uncertain";
    },
  });
}
