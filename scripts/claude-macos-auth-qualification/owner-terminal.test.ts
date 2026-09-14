import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { expect, test } from "bun:test";

import { armOwnerTerminalInterruption, armOwnerTerminalNoPromptWindow, createQualificationTerminalSignals,
  prepareOwnerManualBrowserLogin, readOwnerTerminalResponse, type OwnerInterruptionArm } from "./owner-terminal";

const runId = randomUUID();
const scope = (step: number) => ({ runId, attemptId: randomUUID(), step });
function terminal(reply: "exact" | "wrong" | "none" = "exact") {
  const input = new PassThrough(); const messages: string[] = []; const buffers: Buffer[] = [];
  let checks = 0; let current = true;
  const output = new Writable({ write(chunk: Buffer, _encoding, done) {
    const text = chunk.toString("utf8"); messages.push(text); done();
    if (text.includes("Type exactly:") && reply !== "none") setTimeout(() => {
      const value = Buffer.from(reply === "exact" ? text.split("Type exactly: ")[1]! : "yes\n"); buffers.push(value); input.write(value);
    }, 0);
    if (text.includes("Press Enter when ready") && reply !== "none") setTimeout(() => {
      const value = Buffer.from(reply === "exact" ? "\n" : "yes\n"); buffers.push(value); input.write(value);
    }, 0);
  } });
  return { input, output, messages, buffers, assertCurrent() { checks += 1; if (!current) throw new Error("synthetic stale owner"); },
    checks: () => checks, stale() { current = false; } };
}

test("each manual-browser readiness challenge precedes authentication and explains separate private sessions", async () => {
  for (const step of [1, 4, 13, 15]) {
    const streams = terminal();
    await prepareOwnerManualBrowserLogin(streams, new AbortController().signal, scope(step));
    const message = streams.messages.join("");
    expect(message).toContain("Claude has not started this login");
    expect(message).toContain("Automatic browser opening is disabled");
    expect(message).toContain("Close all prior private/incognito windows");
    expect(message).toContain("multiple private windows can share cookies");
    if (step !== 13) expect(message).toContain("Copy that exact link");
    expect(message).toContain("Press Enter when ready");
    expect(message).not.toContain("Type exactly");
    expect(message).toContain("Keep your normal windows and sessions unchanged");
    expect(message).not.toContain("Confirm you signed in");
    if (step === 4) expect(message).toContain("different from A");
    if (step === 13) expect(message).toContain("do not open the link");
    if (step === 15) expect(message).toContain("original intended A account");
    expect(streams.input.listenerCount("data")).toBe(0);
    expect(streams.buffers.every((value) => value.every((byte) => byte === 0))).toBeTrue();
  }
});

test("wrong, stale and non-login readiness cannot become permission to begin a login", async () => {
  await expect(prepareOwnerManualBrowserLogin(terminal("wrong"), new AbortController().signal, scope(4))).rejects.toMatchObject({ code: "owner_refused" });
  const stale = terminal(); stale.stale();
  await expect(prepareOwnerManualBrowserLogin(stale, new AbortController().signal, scope(4))).rejects.toThrow();
  const cancelled = new AbortController(); cancelled.abort();
  await expect(prepareOwnerManualBrowserLogin(terminal(), cancelled.signal, scope(1))).rejects.toMatchObject({ code: "aborted" });
  await expect(prepareOwnerManualBrowserLogin(terminal(), new AbortController().signal, scope(2))).rejects.toMatchObject({ code: "order_refused" });
});
function signals() {
  const controller = new AbortController(); const events = new EventEmitter(); const counts: number[] = []; const unrelated = (): void => {};
  events.on("SIGINT", unrelated);
  const policy = createQualificationTerminalSignals(controller.signal, {
    add(signal, listener) { events.on(signal, listener); counts.push(events.listenerCount(signal) - (signal === "SIGINT" ? 1 : 0)); },
    remove(signal, listener) { events.off(signal, listener); counts.push(events.listenerCount(signal) - (signal === "SIGINT" ? 1 : 0)); },
  });
  return { controller, events, counts, policy, unrelated };
}
function child() {
  const exit = Promise.withResolvers<number>(); const sent: string[] = []; let forced = 0;
  return { exit, sent, forceCount: () => forced, process: { exited: exit.promise,
    sendSignal(signal: "SIGINT" | "SIGTERM") { sent.push(signal); }, forceTerminate() { forced += 1; } } };
}
async function normal(value: ReturnType<typeof signals>, step: 1 | 4 | 15) {
  const login = value.policy.beginLogin(scope(step)); const target = child(); login.attachChild(target.process);
  target.exit.resolve(0); await value.policy.finishLogin(login); return target;
}

test("fixed login observations keep exact fresh challenges, discard bytes and convey no native provenance", async () => {
  for (const [step, challenge] of [[1, "signed-in-A"], [4, "signed-in-B-distinct"], [13, "interrupted-before-browser-completion"], [15, "recovered-A"]] as const) {
    const streams = terminal(); const request = scope(step);
    expect(await readOwnerTerminalResponse(streams, new AbortController().signal, request)).toBeUndefined();
    expect(streams.messages[0]).toContain(request.runId); expect(streams.messages[0]).toContain(request.attemptId);
    expect(streams.messages[0]).toContain(`Type exactly: ${challenge} `); expect(streams.buffers.every((v) => v.every((b) => b === 0))).toBeTrue();
    expect(streams.checks()).toBeGreaterThanOrEqual(3); expect(streams.input.destroyed).toBeFalse(); expect(streams.output.destroyed).toBeFalse();
    expect(streams.input.listenerCount("data")).toBe(0); expect(streams.output.listenerCount("error")).toBe(0);
  }
  for (let step = 0; step < 22; step += 1) {
    if ([1, 4, 13, 15].includes(step)) continue;
    const streams = terminal(); await expect(readOwnerTerminalResponse(streams, new AbortController().signal, scope(step))).rejects.toMatchObject({ code: "order_refused" });
    expect(streams.messages).toEqual([]);
  }
});

test("old responses, forged scope fields and invalid owner observations never become acceptance", async () => {
  const streams = terminal("wrong"); await expect(readOwnerTerminalResponse(streams, new AbortController().signal, scope(4))).rejects.toMatchObject({ code: "owner_refused" });
  const extra = terminal(); await expect(readOwnerTerminalResponse(extra, new AbortController().signal, { ...scope(4), ownerAttested: true })).rejects.toMatchObject({ code: "authority_refused" });
  expect(extra.messages).toEqual([]);
  const old = terminal(); await readOwnerTerminalResponse(old, new AbortController().signal, scope(15));
  const input = new PassThrough(); const output = new Writable({ write(_chunk, _encoding, done) { done(); setTimeout(() => input.write(Buffer.from(old.messages[0]!.split("Type exactly: ")[1]!)), 0); } });
  await expect(readOwnerTerminalResponse({ input, output, assertCurrent() {} }, new AbortController().signal, scope(15))).rejects.toMatchObject({ code: "owner_refused" });
});

test("no-prompt window is announced before targets and cannot accept an early or cross-attempt answer", async () => {
  const streams = terminal(); const request = scope(9); const window = await armOwnerTerminalNoPromptWindow(streams, new AbortController().signal, request);
  expect(streams.messages).toHaveLength(1); expect(streams.messages[0]).not.toContain("Type exactly:"); expect(streams.input.listenerCount("data")).toBe(0);
  // The driver owns target/metadata/overlap joins. This unit has no boolean or native witness input.
  await window.finish(request); expect(streams.messages[1]).toContain("Type exactly: no-graphical-prompt ");
  await expect(window.finish(request)).rejects.toMatchObject({ code: "order_refused" }); expect(streams.output.listenerCount("error")).toBe(0);
  const early = terminal(); const second = await armOwnerTerminalNoPromptWindow(early, new AbortController().signal, scope(6));
  early.input.write("pretyped\n"); await expect(second.finish(scope(6))).rejects.toMatchObject({ code: "order_refused" });
  expect(early.output.listenerCount("error")).toBe(0); second.close();
  const buffered = terminal(); const sameScope = scope(6); const third = await armOwnerTerminalNoPromptWindow(buffered, new AbortController().signal, sameScope);
  buffered.input.write("pretyped\n"); await expect(third.finish(sameScope)).rejects.toMatchObject({ code: "owner_refused" });
});

test("armed observation window retains output failure, owner revalidation and one-time close", async () => {
  for (const kind of ["error", "close", "stale", "abort"] as const) {
    const streams = terminal(); const controller = new AbortController(); const request = scope(10);
    const window = await armOwnerTerminalNoPromptWindow(streams, controller.signal, request);
    if (kind === "error") streams.output.emit("error", new Error("synthetic output failure"));
    else if (kind === "close") streams.output.emit("close"); else if (kind === "stale") streams.stale(); else controller.abort();
    await expect(window.finish(request)).rejects.toBeInstanceOf(Error); window.close(); window.close();
    expect(streams.output.listenerCount("error")).toBe(0); expect(streams.input.destroyed).toBeFalse();
  }
});

test("four-login sequence consumes exact owner arm, keeps no-forward Ctrl-C and joins each child before handover", async () => {
  const value = signals(); await normal(value, 1); await normal(value, 4);
  const request = scope(13); const streams = terminal(); const arm = await armOwnerTerminalInterruption(streams, value.policy.signal, request);
  expect(streams.messages[0]).toContain("has not started");
  const login = value.policy.beginLogin(request, arm); const target = child(); login.attachChild(target.process);
  value.events.emit("SIGINT"); expect(value.policy.signal.aborted).toBeFalse(); expect(target.sent).toEqual([]); expect(login.interruptedBy).toBe("SIGINT");
  let finished = false; const joining = value.policy.finishLogin(login).then(() => { finished = true; });
  await Promise.resolve(); expect(finished).toBeFalse(); expect(() => value.policy.beginLogin(scope(15))).toThrow();
  target.exit.resolve(130); await joining;
  await readOwnerTerminalResponse(terminal(), value.policy.signal, request);
  await normal(value, 15); expect(value.policy.signal.aborted).toBeFalse(); expect(value.counts.every((n) => n > 0)).toBeTrue();
  expect(value.policy.close()).toBe("joined"); expect(value.events.listeners("SIGINT")).toEqual([value.unrelated]); expect(value.events.listenerCount("SIGTERM")).toBe(0);
});

test("owner arm cannot be forged, crossed, reused or attached to another login step", async () => {
  const value = signals(); const request = scope(13); const arm = await armOwnerTerminalInterruption(terminal(), value.policy.signal, request);
  expect(() => value.policy.beginLogin(scope(1), arm)).toThrow(); await normal(value, 1); await normal(value, 4);
  expect(() => value.policy.beginLogin(request, {} as OwnerInterruptionArm)).toThrow();
  expect(() => value.policy.beginLogin({ ...request, attemptId: randomUUID() }, arm)).toThrow();
  const login = value.policy.beginLogin(request, arm); const target = child(); login.attachChild(target.process); value.events.emit("SIGINT"); target.exit.resolve(130); await value.policy.finishLogin(login);
  expect(() => value.policy.beginLogin(request, arm)).toThrow(); expect(value.policy.close()).toBe("joined");
  await expect(armOwnerTerminalInterruption(terminal("wrong"), new AbortController().signal, request)).rejects.toMatchObject({ code: "owner_refused" });
});

test("unexpected terminal signals stop globally without forwarding duplicate TERM; external abort forwards exactly once", async () => {
  for (const kind of ["SIGINT", "SIGTERM", "external"] as const) {
    const value = signals(); const login = value.policy.beginLogin(scope(1)); const target = child(); login.attachChild(target.process);
    if (kind === "external") { value.controller.abort(); value.controller.abort(); } else value.events.emit(kind);
    expect(value.policy.signal.aborted).toBeTrue(); expect(target.sent).toEqual(kind === "external" ? ["SIGTERM"] : []);
    target.exit.resolve(130); await expect(value.policy.finishLogin(login)).rejects.toMatchObject({ code: "aborted" });
    expect(() => value.policy.beginLogin(scope(4))).toThrow(); expect(value.policy.close()).toBe("joined");
  }
});

test("step13 terminal SIGTERM and external cancellation cannot become a local planned interruption", async () => {
  for (const kind of ["SIGTERM", "external", "before_attach", "after_exit"] as const) {
    const value = signals(); await normal(value, 1); await normal(value, 4);
    const request = scope(13); const arm = await armOwnerTerminalInterruption(terminal(), value.policy.signal, request);
    const login = value.policy.beginLogin(request, arm); const target = child();
    if (kind === "before_attach") value.events.emit("SIGINT");
    login.attachChild(target.process);
    if (kind === "after_exit") { target.exit.resolve(0); await Promise.resolve(); value.events.emit("SIGINT"); }
    else if (kind === "external") value.controller.abort(); else if (kind === "SIGTERM") value.events.emit("SIGTERM");
    expect(value.policy.signal.aborted).toBeTrue(); expect(target.sent).toEqual(kind === "external" ? ["SIGTERM"] : []);
    target.exit.resolve(130); await expect(value.policy.finishLogin(login)).rejects.toMatchObject({ code: "aborted" }); value.policy.close();
  }
});

test("between-step cancellation and never-started login refuse sequence advancement", async () => {
  const value = signals(); await normal(value, 1); value.events.emit("SIGINT"); expect(value.policy.signal.aborted).toBeTrue(); expect(() => value.policy.beginLogin(scope(4))).toThrow(); value.policy.close();
  const missing = signals(); const login = missing.policy.beginLogin(scope(1)); await expect(missing.policy.finishLogin(login)).rejects.toMatchObject({ code: "order_refused" });
  expect(missing.policy.signal.aborted).toBeTrue(); expect(missing.policy.close()).toBe("joined");
});

test("bounded missing exit retains exact custody until later collection and cannot advance", async () => {
  const value = signals(); const login = value.policy.beginLogin(scope(1)); const target = child(); login.attachChild(target.process);
  await expect(value.policy.finishLogin(login)).rejects.toMatchObject({ cleanup: "uncertain" });
  expect(value.policy.close()).toBe("uncertain"); expect(target.sent).toEqual(["SIGTERM"]); expect(value.events.listenerCount("SIGTERM")).toBe(1);
  target.exit.resolve(143); await Promise.resolve(); await Promise.resolve(); expect(value.policy.close()).toBe("joined");
  expect(value.events.listeners("SIGINT")).toEqual([value.unrelated]); expect(value.events.listenerCount("SIGTERM")).toBe(0);
});

test("partial signal installation restores only owned listeners", () => {
  const events = new EventEmitter(); const unrelated = (): void => {}; events.on("SIGINT", unrelated);
  expect(() => createQualificationTerminalSignals(new AbortController().signal, {
    add(signal, listener) { if (signal === "SIGTERM") throw new Error("synthetic refusal"); events.on(signal, listener); },
    remove(signal, listener) { events.off(signal, listener); },
  })).toThrow(); expect(events.listeners("SIGINT")).toEqual([unrelated]);
});


test("closing after observed exit while finish is suspended cannot reinstall listeners or advance", async () => {
  const value = signals(); const login = value.policy.beginLogin(scope(1)); const target = child(); login.attachChild(target.process);
  const joining = value.policy.finishLogin(login); target.exit.resolve(0);
  // The child-observation continuation runs first; finish's Promise.race has
  // not resumed yet. close therefore sees a successful exit without an active wait.
  await Promise.resolve(); expect(value.policy.close()).toBe("joined");
  const changes = value.counts.length;
  await expect(joining).rejects.toMatchObject({ code: "aborted" });
  expect(value.counts).toHaveLength(changes); expect(value.events.listeners("SIGINT")).toEqual([value.unrelated]);
  expect(value.events.listenerCount("SIGTERM")).toBe(0); expect(() => value.policy.beginLogin(scope(4))).toThrow();
  expect(value.policy.close()).toBe("joined"); expect(target.sent).toEqual([]);
});


test("closing a window cancels its pending reader and a later exact response cannot revive it", async () => {
  const streams = terminal("none"); const controller = new AbortController(); const request = scope(9);
  const window = await armOwnerTerminalNoPromptWindow(streams, controller.signal, request);
  const ready = Promise.withResolvers<undefined>();
  const listenerAdded = (event: string | symbol): void => { if (event === "data") ready.resolve(undefined); };
  streams.input.on("newListener", listenerAdded);
  const reading = window.finish(request); const observed = reading.then(() => "accepted", () => "refused");
  let timer: ReturnType<typeof setTimeout> | undefined; let late: Buffer | null = null;
  try {
    // Writable completion can run on nextTick, so observe real reader admission
    // instead of assuming a fixed number of Promise microtasks reaches it.
    await Promise.race([ready.promise, new Promise<never>((_done, reject) => {
      timer = setTimeout(() => { reject(new Error("synthetic reader did not start")); }, 1000);
    })]);
    expect(streams.input.listenerCount("data")).toBe(1); expect(streams.messages).toHaveLength(2);
    late = Buffer.from(streams.messages[1]!.split("Type exactly: ")[1]!);
    window.close(); expect(await observed).toBe("refused"); expect(controller.signal.aborted).toBeFalse();
    expect(streams.input.listenerCount("data")).toBe(0); expect(streams.output.listenerCount("error")).toBe(0);
    streams.input.write(late); await expect(window.finish(request)).rejects.toMatchObject({ code: "order_refused" });
    expect(streams.input.destroyed).toBeFalse(); expect(streams.output.destroyed).toBeFalse();
  } finally {
    clearTimeout(timer); window.close(); streams.input.off("newListener", listenerAdded); late?.fill(0); await observed;
  }
});
