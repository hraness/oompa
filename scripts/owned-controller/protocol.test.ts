import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  createOwnedControllerObservation, encodeOwnedControllerFrame, observeOwnedController,
  ownedControllerDirectChildProof, OwnedControllerDecoder, OWNED_CONTROLLER_MAX_FRAME_BYTES,
  parseOwnedControllerFrame, type OwnedControllerEvent, type OwnedControllerFrame,
  type OwnedControllerHelperFrame, type OwnedControllerObservation,
} from "./protocol.ts";

const binding = { nonce: "0123456789abcdef0123456789abcdef", generation: 7 };
const deadlines = { startupMs: 100, runMs: 1_000, shutdownMs: 50 };
const ready: OwnedControllerHelperFrame = { type: "ready", ...binding, childPid: 42 };
const terminal = (released = true): Extract<OwnedControllerHelperFrame, { type: "terminal" }> =>
  ({ type: "terminal", ...binding, childPid: 42, released, termination: "exit", status: 0 });
const initial = () => createOwnedControllerObservation(binding, deadlines, 0);
const frameEvent = (frame: OwnedControllerFrame): OwnedControllerEvent => ({ kind: "frame", frame });
const transition = (state: OwnedControllerObservation, event: OwnedControllerEvent, now = state.observedAt + 1) =>
  observeOwnedController(state, event, now);
const running = () => transition(transition(initial(), frameEvent(ready)), { kind: "go_sent" });
const joined = (released = true) => {
  let state = released ? running() : transition(initial(), frameEvent(ready));
  state = transition(state, frameEvent(terminal(released)));
  state = transition(state, { kind: "helper_exit", code: 0 });
  return transition(state, { kind: "control_eof" });
};
const bytes = (wire: string) => new TextEncoder().encode(wire);
const nonce = fc.array(fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "a", "b", "c", "d", "e", "f"), { minLength: 32, maxLength: 32 }).map((v) => v.join(""));
const identity = fc.record({ nonce, generation: fc.integer({ min: 1, max: 2_147_483_647 }) });
const pid = fc.integer({ min: 1, max: 2_147_483_647 });
const frames: fc.Arbitrary<OwnedControllerFrame> = fc.oneof(
  identity.map((id) => ({ ...id, type: "go" as const })),
  identity.map((id) => ({ ...id, type: "term" as const })),
  fc.tuple(identity, pid).map(([id, childPid]) => ({ ...id, childPid, type: "ready" as const })),
  fc.tuple(identity, pid, fc.boolean(), fc.integer({ min: 0, max: 255 })).map(([id, childPid, released, status]) =>
    ({ ...id, childPid, released, status, type: "terminal" as const, termination: "exit" as const })),
  fc.tuple(identity, pid, fc.boolean(), fc.integer({ min: 1, max: 127 })).map(([id, childPid, released, status]) =>
    ({ ...id, childPid, released, status, type: "terminal" as const, termination: "signal" as const })),
);

describe("owned controller closed wire codec", () => {
  test("uses one frozen language and represents only the owned direct-child result", () => {
    expect(encodeOwnedControllerFrame(ready)).toBe(`OOC1 READY ${binding.nonce} 7 42\n`);
    expect(encodeOwnedControllerFrame({ type: "go", ...binding })).toBe(`OOC1 GO ${binding.nonce} 7\n`);
    expect(encodeOwnedControllerFrame({ type: "term", ...binding })).toBe(`OOC1 TERM ${binding.nonce} 7\n`);
    expect(encodeOwnedControllerFrame(terminal())).toBe(`OOC1 TERMINAL ${binding.nonce} 7 42 1 exit 0\n`);
  });

  test("round trips every generated closed frame and stays within the native fixed buffer", () => {
    fc.assert(fc.property(frames, (frame) => {
      const wire = encodeOwnedControllerFrame(frame);
      expect(bytes(wire).length).toBeLessThanOrEqual(OWNED_CONTROLLER_MAX_FRAME_BYTES);
      expect(parseOwnedControllerFrame(wire)).toEqual(frame);
    }), { numRuns: 300 });
  });

  test("rejects unknown, future, noncanonical, extra-field and invalid outcome encodings", () => {
    const wire = encodeOwnedControllerFrame(ready);
    for (const value of [
      null, {}, 1, bytes(wire), "", "\n", wire.slice(0, -1), `${wire}\n`, `${wire}${wire}`,
      wire.replace("OOC1", "OOC2"), wire.replace("OOC1", "OOC01"), wire.replace("READY", "EXEC"),
      wire.replace(" READY ", "  READY "), ` ${wire}`, wire.replace("\n", " \n"),
      wire.replace("\n", "\r\n"), wire.replace(" ", "\t"), wire.replace("READY", "REA\0DY"),
      wire.replace("READY", "RÉADY"), wire.replace(binding.nonce, binding.nonce.toUpperCase()),
      wire.replace(binding.nonce, "a".repeat(31)), wire.replace(binding.nonce, "a".repeat(33)),
      wire.replace(" 7 ", " 0 "), wire.replace(" 7 ", " 07 "), wire.replace(" 7 ", " +7 "),
      wire.replace(" 7 ", " 7.0 "), wire.replace(" 7 ", " 7e0 "), wire.replace(" 7 ", " 2147483648 "),
      wire.replace(" 42\n", " 0\n"), wire.replace(" 42\n", " 42 extra\n"),
      encodeOwnedControllerFrame(terminal()).replace(" 1 exit 0", " true exit 0"),
      encodeOwnedControllerFrame(terminal()).replace("exit 0", "signal 0"),
      encodeOwnedControllerFrame(terminal()).replace("exit 0", "signal 128"),
      encodeOwnedControllerFrame(terminal()).replace("exit 0", "exit 256"),
      encodeOwnedControllerFrame(terminal()).replace("exit 0", "unknown 0"),
      "x".repeat(161),
    ]) expect(() => parseOwnedControllerFrame(value)).toThrow();
  });

  test("decodes arbitrary chunk boundaries without changing wire meaning", () => {
    fc.assert(fc.property(frames, fc.array(fc.integer({ min: 0, max: 200 }), { maxLength: 30 }), (frame, cuts) => {
      const wire = bytes(encodeOwnedControllerFrame(frame));
      const decoder = new OwnedControllerDecoder(frame.type === "go" || frame.type === "term" ? "host" : "helper");
      const offsets = [...new Set([0, wire.length, ...cuts.map((v) => Math.min(v, wire.length))])].sort((a, b) => a - b);
      const result: OwnedControllerFrame[] = [];
      for (let i = 1; i < offsets.length; i++) result.push(...decoder.push(wire.slice(offsets[i - 1], offsets[i])));
      decoder.finish();
      expect(result).toEqual([frame]);
      expect(() => decoder.push(new Uint8Array())).toThrow();
    }), { numRuns: 200 });
  });

  test("bounds a coalesced stream and rejects wrong directions before returning any of a failed chunk", () => {
    const decoder = new OwnedControllerDecoder("helper");
    expect(decoder.push(bytes(encodeOwnedControllerFrame(ready) + encodeOwnedControllerFrame(terminal())))).toEqual([ready, terminal()]);
    expect(() => decoder.push(bytes(encodeOwnedControllerFrame(ready)))).toThrow();
    expect(() => decoder.finish()).toThrow();
    for (const direction of ["host", "helper"] as const) {
      const wrong = new OwnedControllerDecoder(direction);
      expect(() => wrong.push(bytes(encodeOwnedControllerFrame(direction === "host" ? ready : { type: "go", ...binding })))).toThrow();
      expect(() => wrong.push(new Uint8Array())).toThrow();
    }
  });

  test("poisons on malformed bytes, oversized partials, truncated EOF and late bytes", () => {
    for (const chunk of [new Uint8Array(161).fill(65), new Uint8Array(321).fill(65), new Uint8Array([0]), new Uint8Array([128]), bytes("OOC2 READY x\n")]) {
      const decoder = new OwnedControllerDecoder("helper");
      expect(() => decoder.push(chunk)).toThrow();
      expect(() => decoder.push(bytes(encodeOwnedControllerFrame(ready)))).toThrow();
    }
    const partial = new OwnedControllerDecoder("helper");
    partial.push(bytes(encodeOwnedControllerFrame(ready).slice(0, -1)));
    expect(() => partial.finish()).toThrow();
    expect(() => partial.push(bytes("\n"))).toThrow();
    const empty = new OwnedControllerDecoder("helper");
    empty.finish();
    expect(() => empty.finish()).toThrow();
  });

  test("a good prefix cannot mask corrupt coalesced output or revive a poisoned stream", () => {
    const decoder = new OwnedControllerDecoder("helper");
    expect(() => decoder.push(bytes(`${encodeOwnedControllerFrame(ready)}OOC2 TERMINAL bad\n`))).toThrow();
    expect(() => decoder.push(bytes(encodeOwnedControllerFrame(terminal())))).toThrow();
    const prefix = new OwnedControllerDecoder("helper");
    expect(prefix.push(bytes(encodeOwnedControllerFrame(ready)))).toEqual([ready]);
    expect(() => prefix.push(bytes("bad\n"))).toThrow();
    expect(() => prefix.finish()).toThrow();
  });
});

describe("owned controller host observation admission", () => {
  test("requires terminal, successful helper join and clean EOF before admitting limited proof", () => {
    let state = running();
    state = transition(state, frameEvent(terminal()));
    expect(ownedControllerDirectChildProof(state)).toBeNull();
    state = transition(state, { kind: "control_eof" });
    expect(ownedControllerDirectChildProof(state)).toBeNull();
    state = transition(state, { kind: "helper_exit", code: 0 });
    expect(ownedControllerDirectChildProof(state)).toEqual({
      scope: "owned_direct_child_only", binding, childPid: 42, released: true,
      termination: "exit", status: 0, replacementWriterAuthorized: false,
    });
  });

  test("retains exit-before-buffered-terminal ordering without accepting EOF-before-terminal", () => {
    let state = transition(running(), { kind: "helper_exit", code: 0 });
    expect(ownedControllerDirectChildProof(state)).toBeNull();
    state = transition(state, frameEvent(terminal()));
    state = transition(state, { kind: "control_eof" });
    expect(state.phase).toBe("complete");
    const lost = transition(transition(running(), { kind: "helper_exit", code: 0 }), { kind: "control_eof" });
    expect(lost.uncertainty).toBe("missing_terminal");
    expect(transition(lost, frameEvent(terminal()))).toEqual(lost);
  });

  test("proves pre-GO child death or TERM only as an unreleased direct child", () => {
    expect(ownedControllerDirectChildProof(joined(false))?.released).toBe(false);
    let state = transition(transition(initial(), frameEvent(ready)), { kind: "term_sent" });
    expect(transition(state, { kind: "go_sent" }).phase).toBe("uncertain");
    state = transition(state, frameEvent({ ...terminal(false), termination: "signal", status: 9 }));
    state = transition(state, { kind: "helper_exit", code: 0 });
    state = transition(state, { kind: "control_eof" });
    expect(ownedControllerDirectChildProof(state)?.status).toBe(9);
  });

  test("an exec failure exit remains a released reaped child, never successful provider work", () => {
    let state = transition(running(), frameEvent({ ...terminal(), termination: "exit", status: 127 }));
    state = transition(state, { kind: "helper_exit", code: 0 });
    state = transition(state, { kind: "control_eof" });
    const proof = ownedControllerDirectChildProof(state);
    expect(proof?.released).toBe(true);
    expect(proof?.status).toBe(127);
    expect(proof?.replacementWriterAuthorized).toBe(false);
  });

  test("binds nonce, generation, ready PID and actual GO observation", () => {
    fc.assert(fc.property(identity, (changed) => {
      fc.pre(changed.nonce !== binding.nonce || changed.generation !== binding.generation);
      expect(transition(initial(), frameEvent({ ...ready, ...changed })).uncertainty).toBe("binding");
      expect(transition(running(), frameEvent({ ...terminal(), ...changed })).uncertainty).toBe("binding");
    }), { numRuns: 100 });
    expect(transition(running(), frameEvent({ ...terminal(), childPid: 43 })).phase).toBe("uncertain");
    expect(transition(running(), frameEvent(terminal(false))).phase).toBe("uncertain");
    expect(transition(transition(initial(), frameEvent(ready)), frameEvent(terminal())).phase).toBe("uncertain");
  });

  test("duplicate, out-of-order and host frames on the helper channel never produce proof", () => {
    const cases: readonly [OwnedControllerObservation, OwnedControllerEvent][] = [
      [initial(), { kind: "go_sent" }], [initial(), { kind: "term_sent" }], [initial(), frameEvent(terminal(false))],
      [running(), { kind: "go_sent" }], [running(), frameEvent(ready)],
      [transition(running(), { kind: "term_sent" }), { kind: "term_sent" }],
      [transition(running(), frameEvent(terminal())), frameEvent(terminal())],
      [transition(running(), { kind: "helper_exit", code: 0 }), { kind: "helper_exit", code: 0 }],
      [transition(transition(initial(), frameEvent(ready)), { kind: "helper_exit", code: 0 }), { kind: "go_sent" }],
      [initial(), frameEvent({ type: "go", ...binding })], [joined(), { kind: "control_eof" }],
    ];
    for (const [state, event] of cases) {
      const refused = transition(state, event);
      expect(refused.phase).toBe("uncertain");
      expect(ownedControllerDirectChildProof(refused)).toBeNull();
    }
  });

  test("failed helper, owner loss and malformed transport remain uncertain even after late good evidence", () => {
    for (const event of [{ kind: "helper_exit", code: null }, { kind: "helper_exit", code: 1 },
      { kind: "owner_lost" }, { kind: "protocol_failure" }] as const) {
      const failed = transition(running(), event);
      expect(failed.phase).toBe("uncertain");
      expect(transition(failed, frameEvent(terminal()))).toEqual(failed);
      expect(ownedControllerDirectChildProof(failed)).toBeNull();
    }
    expect(transition(joined(), { kind: "owner_lost" }).phase).toBe("uncertain");
    expect(transition(initial(), frameEvent({ ...ready, childPid: Number.NaN })).uncertainty).toBe("protocol");
    expect(transition(running(), frameEvent({ ...terminal(), status: -1 })).uncertainty).toBe("protocol");
  });

  test("bounds each clock phase and rejects regressing, nonfinite and fractional observations", () => {
    expect(observeOwnedController(initial(), frameEvent(ready), 100).uncertainty).toBe("deadline");
    expect(observeOwnedController(transition(initial(), frameEvent(ready)), { kind: "go_sent" }, 100).uncertainty).toBe("deadline");
    expect(observeOwnedController(running(), { kind: "tick" }, 1_002).uncertainty).toBe("deadline");
    const stopping = transition(running(), { kind: "term_sent" });
    expect(observeOwnedController(stopping, frameEvent(terminal()), 53).uncertainty).toBe("deadline");
    const finished = transition(running(), frameEvent(terminal()));
    expect(observeOwnedController(finished, { kind: "helper_exit", code: 0 }, 53).uncertainty).toBe("deadline");
    const exited = transition(running(), { kind: "helper_exit", code: 0 });
    expect(observeOwnedController(exited, frameEvent(terminal()), 53).uncertainty).toBe("deadline");
    expect(transition(exited, frameEvent(terminal())).deadlineAt).toBe(exited.deadlineAt);
    for (const now of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(observeOwnedController(running(), { kind: "tick" }, now).uncertainty).toBe("clock");
    }
  });

  test("invalid initial identities or unbounded deadlines never establish an observation", () => {
    for (const changed of [{ nonce: "bad" }, { generation: 0 }, { generation: 2_147_483_648 }]) {
      expect(() => createOwnedControllerObservation({ ...binding, ...changed }, deadlines, 0)).toThrow();
    }
    for (const changed of [{ startupMs: 0 }, { startupMs: 30_001 }, { runMs: 86_400_001 }, { shutdownMs: 30_001 }, { shutdownMs: 0.5 }]) {
      expect(() => createOwnedControllerObservation(binding, { ...deadlines, ...changed }, 0)).toThrow();
    }
  });

  test("arbitrary event permutations cannot join unless the exact READY/GO/terminal order exists", () => {
    const events: readonly OwnedControllerEvent[] = [frameEvent(ready), { kind: "go_sent" }, frameEvent(terminal()),
      { kind: "helper_exit", code: 0 }, { kind: "control_eof" }];
    fc.assert(fc.property(fc.shuffledSubarray([...events], { minLength: events.length, maxLength: events.length }), (order) => {
      let state = initial();
      for (const event of order) state = transition(state, event);
      const proof = ownedControllerDirectChildProof(state);
      if (proof !== null) {
        const readyAt = order.findIndex((e) => e.kind === "frame" && e.frame.type === "ready");
        const goAt = order.findIndex((e) => e.kind === "go_sent");
        const terminalAt = order.findIndex((e) => e.kind === "frame" && e.frame.type === "terminal");
        const exitAt = order.findIndex((e) => e.kind === "helper_exit");
        const eofAt = order.findIndex((e) => e.kind === "control_eof");
        expect(readyAt).toBeLessThan(goAt);
        expect(goAt).toBeLessThan(terminalAt);
        expect(goAt).toBeLessThan(exitAt);
        expect(terminalAt).toBeLessThan(eofAt);
      }
    }), { numRuns: 200 });
  });
});
