import { expect, test } from "bun:test";
import fc from "fast-check";

import { inspectDarwinDetachedChild, parseDarwinLiveSnapshot, parseDarwinTerminalDevice } from "./detachment";
import { detachedAuthArguments, observeDarwinDetachedStatusOverlap, type DetachedAuthProcess } from "./process";

test("fixed qualification operations never accept arbitrary argv or operation names", () => {
  expect(detachedAuthArguments("/fixture", "status")).toEqual(["/fixture", "auth", "status", "--json"]);
  expect(detachedAuthArguments("/fixture", "version")).toEqual(["/fixture", "--version"]);
  expect(detachedAuthArguments("/fixture", "login_help")).toEqual(["/fixture", "auth", "login", "--help"]);
  expect(detachedAuthArguments("/fixture", "logout_help")).toEqual(["/fixture", "auth", "logout", "--help"]);
  expect(detachedAuthArguments("/fixture", "logout")).toEqual(["/fixture", "auth", "logout"]);
  for (const operation of ["login", "login --help", "login_help --claudeai", "constructor", "toString", "status --anything", [], null, { operation: "status" }]) {
    expect(() => detachedAuthArguments("/fixture", operation)).toThrow("operation_refused");
  }
  for (const executable of ["fixture", "/tmp/../fixture", "/fixture\0extra", `/${"x".repeat(4096)}`, null, 123]) {
    expect(() => detachedAuthArguments(executable, "status")).toThrow("operation_refused");
  }
});

test("Darwin tdev parser admits exactly one matching NODEV row", () => {
  expect(parseDarwinTerminalDevice("  123 Fri Sep 11 16:34:59 2026 ??\n")).toEqual({ pid: 123, procStart: "Fri Sep 11 16:34:59 2026" });
  expect(parseDarwinTerminalDevice("1 Fri Sep  4 06:04:09 2026 ??")).toEqual({ pid: 1, procStart: "Fri Sep  4 06:04:09 2026" });
  for (const value of ["", "123 Fri Sep 11 16:34:59 2026 16,1\n", "123 Fri Sep 11 16:34:59 2026 ttys000\n",
    "123 Fri Sep 11 16:34:59 2026 ??\n124 Fri Sep 11 16:34:59 2026 ??\n", "0 Fri Sep 11 16:34:59 2026 ??\n",
    "0123 Fri Sep 11 16:34:59 2026 ??\n", "2147483648 Fri Sep 11 16:34:59 2026 ??\n",
    "123 Fri Sep 11 29:34:59 2026 ??\n", "123 Fri Sep 11 16:34:59 2026 ??\r\n", "x".repeat(385), null, {}]) {
    expect(() => parseDarwinTerminalDevice(value)).toThrow("identity_refused");
  }
});

test("an already-exited child refuses before any native inspector is started", async () => {
  expect(await inspectDarwinDetachedChild(123, () => true)).toEqual({ witness: null, cleanup: "joined", inspectorsStarted: 0, inspectorsJoined: 0 });
});

test("Darwin identity rows preserve the exact start identity and reject foreign suffixes", () => {
  fc.assert(fc.property(fc.integer({ min: 1, max: 2_147_483_647 }), fc.integer({ min: 1, max: 28 }),
    fc.integer({ min: 0, max: 23 }), fc.integer({ min: 0, max: 59 }), fc.integer({ min: 0, max: 59 }),
    fc.constantFrom("\0", "\r", " extra", "\n1 Fri Sep 11 16:34:59 2026 ??"), (pid, day, hour, minute, second, suffix) => {
      const start = `Fri Sep ${String(day).padStart(2, " ")} ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")} 2026`;
      const row = `  ${String(pid)} ${start} ??`;
      expect(parseDarwinTerminalDevice(`${row}\n`)).toEqual({ pid, procStart: start });
      expect(() => parseDarwinTerminalDevice(`${row}${suffix}\n`)).toThrow("identity_refused");
    }), { numRuns: 100, seed: 20260911 });
});

test("arbitrary foreign operation strings cannot expand the fixed command set", () => {
  fc.assert(fc.property(fc.string().filter((value) => !["status", "version", "login_help", "logout_help", "logout"].includes(value)), (value) => {
    expect(() => detachedAuthArguments("/fixture", value)).toThrow("operation_refused");
  }), { numRuns: 100, seed: 20260911 });
});

test("overlap live-state rows exclude zombie, exiting, stopped and unknown states", () => {
  const prefix = "123 Fri Sep 11 16:34:59 2026 ??";
  for (const state of ["R", "Ss", "I", "U", "SNs", "R<s"]) {
    expect(parseDarwinLiveSnapshot(`${prefix} ${state}\n`)).toEqual({ pid: 123, procStart: "Fri Sep 11 16:34:59 2026" });
  }
  for (const state of ["Z", "Zs", "SEs", "SNEs", "T", "?", "", "Ss extra", "SS", "SNNs", "S+", "SXs"]) {
    expect(() => parseDarwinLiveSnapshot(`${prefix} ${state}\n`)).toThrow("lifetime_refused");
  }
  fc.assert(fc.property(fc.constantFrom("R", "S", "I", "U"), fc.constantFrom("Z", "E", "?", "\0", "\r", "\n"),
    fc.boolean(), (state, forbidden, prepend) => {
      const flags = prepend ? forbidden + state : state + forbidden;
      expect(() => parseDarwinLiveSnapshot(`${prefix} ${flags}\n`)).toThrow("lifetime_refused");
    }), { numRuns: 100, seed: 20260911 });
});

test("overlap cannot consume arbitrary PIDs, forged process facts or proxy instances", async () => {
  const facts = { settlement: Promise.resolve({ admitted: true, cleanup: "joined" }), pid: 123 };
  for (const first of [123, null, facts, new Proxy(facts, {})]) {
    await expect(observeDarwinDetachedStatusOverlap(first as unknown as DetachedAuthProcess, { ...facts } as unknown as DetachedAuthProcess,
      { signal: new AbortController().signal, deadlineMs: 1000 })).rejects.toThrow("overlap_pair_refused");
  }
});
