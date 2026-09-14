import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { ownedControllerDirectChildProof, type OwnedControllerEvent } from "./protocol.ts";
import {
  createOwnedControllerTransport, observeOwnedControllerTransport, ownedControllerTransportProof,
  type OwnedControllerTransportEvent, type OwnedControllerTransportObservation,
} from "./transport.ts";

const binding = { nonce: "0123456789abcdef0123456789abcdef", generation: 7 };
const deadlines = { startupMs: 100, runMs: 1_000, shutdownMs: 50 };
const limits = { stdinBytes: 128, stdoutBytes: 128, stderrBytes: 32, pendingWrites: 2, pendingBytes: 8 };
const initial = () => createOwnedControllerTransport(binding, deadlines, limits, 0);
const control = (event: OwnedControllerEvent): OwnedControllerTransportEvent => ({ kind: "controller", event });
const ready = control({ kind: "frame", frame: { type: "ready", ...binding, childPid: 42 } });
const terminal = (released = true) => control({ kind: "frame", frame: {
  type: "terminal", ...binding, childPid: 42, released, termination: "exit", status: 0,
} });
const step = (state: OwnedControllerTransportObservation, event: OwnedControllerTransportEvent, now = state.observedAt + 1) =>
  observeOwnedControllerTransport(state, event, now);
const running = () => step(step(initial(), ready), control({ kind: "go_sent" }));
const finishInput = (state: OwnedControllerTransportObservation) =>
  step(step(state, { kind: "input_end" }), { kind: "input_closed" });
const outputEofs = (state: OwnedControllerTransportObservation) =>
  step(step(state, { kind: "output_eof", channel: "stdout" }), { kind: "output_eof", channel: "stderr" });
const finishControl = (state: OwnedControllerTransportObservation, released = true) =>
  step(step(step(state, terminal(released)), control({ kind: "helper_exit", code: 0 })), control({ kind: "control_eof" }));
const complete = () => finishControl(outputEofs(finishInput(running())));

describe("owned direct-child stdio observation", () => {
  test("joins exact child and all three streams while retaining counts only", () => {
    let state = step(running(), { kind: "write_started", id: 1, bytes: 4 });
    state = step(state, { kind: "write_settled", id: 1, bytes: 4 });
    state = step(state, { kind: "output", channel: "stdout", bytes: 8 });
    state = step(state, { kind: "output", channel: "stderr", bytes: 3 });
    state = finishControl(outputEofs(finishInput(state)));
    expect(ownedControllerTransportProof(state)).toMatchObject({ version: "stdio-v1",
      scope: "owned_direct_child_stdio_only", stdinAcceptedBytes: 4, writesAccepted: 1,
      stdoutBytes: 8, stderrBytes: 3, providerConsumptionProven: false, replacementWriterAuthorized: false,
      directChild: { childPid: 42, scope: "owned_direct_child_only", replacementWriterAuthorized: false } });
    expect(state.pending).toEqual([]);
    expect(state).not.toHaveProperty("stdoutData");
    expect(state).not.toHaveProperty("stderrData");
  });

  test("requires observed READY and GO for data, but permits early provider EOF", () => {
    for (const state of [initial(), step(initial(), ready)]) {
      expect(step(state, { kind: "write_started", id: 1, bytes: 1 }).phase).toBe("uncertain");
      expect(step(state, { kind: "output", channel: "stdout", bytes: 1 }).phase).toBe("uncertain");
      expect(step(state, { kind: "output", channel: "stderr", bytes: 1 }).phase).toBe("uncertain");
    }
    let state = outputEofs(initial());
    state = step(state, ready);
    state = step(state, control({ kind: "term_sent" }));
    state = finishControl(finishInput(state), false);
    expect(ownedControllerTransportProof(state)?.directChild.released).toBe(false);
    expect(state.stdinAcceptedBytes).toBe(0);
  });

  test("an OOC1 proof alone cannot establish transport completion", () => {
    const state = finishControl(running());
    expect(ownedControllerDirectChildProof(state.controller)).not.toBeNull();
    expect(ownedControllerTransportProof(state)).toBeNull();
    expect(ownedControllerTransportProof(outputEofs(state))).toBeNull();
    expect(ownedControllerTransportProof(finishInput(state))).toBeNull();
    expect(ownedControllerTransportProof(outputEofs(finishInput(state)))).not.toBeNull();
  });

  test("settles outstanding accepted writes after terminal fencing and actual input close", () => {
    let state = step(running(), { kind: "write_started", id: 1, bytes: 4 });
    state = finishControl(outputEofs(finishInput(state)));
    expect(state.inputFenced).toBe(true);
    expect(ownedControllerTransportProof(state)).toBeNull();
    expect(step(state, { kind: "write_started", id: 2, bytes: 1 }).phase).toBe("uncertain");
    state = step(state, { kind: "write_settled", id: 1, bytes: 4 });
    expect(ownedControllerTransportProof(state)?.stdinAcceptedBytes).toBe(4);
  });

  test("fences close intent immediately and records successful close separately", () => {
    const state = step(running(), { kind: "input_end" });
    expect(state.inputFenced).toBe(true);
    expect(state.inputClosed).toBe(false);
    expect(step(state, { kind: "input_end" }).phase).toBe("uncertain");
    expect(step(state, { kind: "write_started", id: 1, bytes: 1 }).phase).toBe("uncertain");
    expect(step(running(), { kind: "input_closed" }).phase).toBe("uncertain");
    const closed = step(state, { kind: "input_closed" });
    expect(step(closed, { kind: "input_closed" }).phase).toBe("uncertain");
  });

  test("enforces total bytes and independently bounded pending count and bytes", () => {
    let state = running();
    for (let id = 1; id <= 16; id += 1) {
      state = step(state, { kind: "write_started", id, bytes: 8 });
      state = step(state, { kind: "write_settled", id, bytes: 8 });
    }
    expect(state.stdinAcceptedBytes).toBe(128);
    expect(step(state, { kind: "write_started", id: 17, bytes: 1 }).uncertainty).toBe("limit");
    const pending = step(step(running(), { kind: "write_started", id: 1, bytes: 3 }), { kind: "write_started", id: 2, bytes: 3 });
    expect(step(pending, { kind: "write_started", id: 3, bytes: 1 }).uncertainty).toBe("limit");
    expect(step(step(running(), { kind: "write_started", id: 1, bytes: 5 }), { kind: "write_started", id: 2, bytes: 4 }).uncertainty).toBe("limit");
    for (const channel of ["stdout", "stderr"] as const) {
      const bytes = channel === "stdout" ? limits.stdoutBytes : limits.stderrBytes;
      const full = step(running(), { kind: "output", channel, bytes });
      expect(full.phase).toBe("active");
      expect(step(full, { kind: "output", channel, bytes: 1 }).uncertainty).toBe("limit");
    }
  });

  test("requires unique sequential write starts and exact successful local acceptance", () => {
    expect(step(running(), { kind: "write_started", id: 2, bytes: 1 }).phase).toBe("uncertain");
    const pending = step(running(), { kind: "write_started", id: 1, bytes: 4 });
    expect(step(pending, { kind: "write_started", id: 1, bytes: 1 }).phase).toBe("uncertain");
    for (const bytes of [0, 3, 5, NaN, Infinity, 1.5]) {
      expect(step(pending, { kind: "write_settled", id: 1, bytes }).uncertainty).toBe("input");
    }
    expect(step(pending, { kind: "write_settled", id: 2, bytes: 4 }).uncertainty).toBe("input");
    const settled = step(pending, { kind: "write_settled", id: 1, bytes: 4 });
    expect(step(settled, { kind: "write_settled", id: 1, bytes: 4 }).uncertainty).toBe("input");
  });

  test("stream errors, ambiguity and controller uncertainty remain sticky", () => {
    const events: readonly OwnedControllerTransportEvent[] = [
      { kind: "input_error" }, { kind: "output_error", channel: "stdout" }, { kind: "output_error", channel: "stderr" },
      control({ kind: "owner_lost" }), control({ kind: "protocol_failure" }), control({ kind: "helper_exit", code: null }),
    ];
    for (const event of events) {
      const failed = step(running(), event);
      expect(failed.phase).toBe("uncertain");
      expect(failed.inputFenced).toBe(true);
      expect(finishControl(outputEofs(finishInput(failed)))).toEqual(failed);
      expect(ownedControllerTransportProof(failed)).toBeNull();
    }
  });

  test("cancellation fences input and retains one shutdown budget without implying owner loss", () => {
    let state = step(running(), { kind: "cancel" }, 10);
    expect(state.drainDeadlineAt).toBe(60);
    expect(step(state, { kind: "write_started", id: 1, bytes: 1 }).phase).toBe("uncertain");
    expect(step(state, { kind: "cancel" }).phase).toBe("uncertain");
    state = step(state, control({ kind: "term_sent" }), 20);
    expect(state.drainDeadlineAt).toBe(60);
    state = finishControl(outputEofs(finishInput(state)));
    expect(ownedControllerTransportProof(state)).not.toBeNull();
    const early = step(step(initial(), { kind: "cancel" }), ready);
    expect(step(early, control({ kind: "go_sent" })).phase).toBe("uncertain");
  });

  test("provider drain stays finite after the OOC1 reducer has completed", () => {
    let state = finishControl(finishInput(running()));
    state = step(state, { kind: "output_eof", channel: "stdout" });
    expect(state.controller.phase).toBe("complete");
    const deadline = state.drainDeadlineAt;
    if (deadline === null) throw new Error("missing drain deadline");
    expect(step(state, { kind: "tick" }, deadline).uncertainty).toBe("deadline");
    expect(step(state, { kind: "output_eof", channel: "stderr" }, deadline).uncertainty).toBe("deadline");
    const joined = step(state, { kind: "output_eof", channel: "stderr" }, deadline - 1);
    expect(ownedControllerTransportProof(joined)).not.toBeNull();
    expect(step(joined, { kind: "tick" }, deadline + 100).phase).toBe("complete");
  });

  test("closed outputs and final proof reject contradictory late observations", () => {
    const eof = step(running(), { kind: "output_eof", channel: "stdout" });
    expect(step(eof, { kind: "output_eof", channel: "stdout" }).phase).toBe("uncertain");
    expect(step(eof, { kind: "output", channel: "stdout", bytes: 1 }).phase).toBe("uncertain");
    const state = complete();
    for (const event of [{ kind: "input_error" }, { kind: "output_eof", channel: "stderr" },
      { kind: "write_settled", id: 1, bytes: 1 }] as const) {
      expect(ownedControllerTransportProof(step(state, event))).toBeNull();
    }
  });

  test("invalid limits, byte counts and clocks cannot establish proof", () => {
    for (const invalid of [{ ...limits, stdinBytes: 0 }, { ...limits, stdoutBytes: Infinity },
      { ...limits, stderrBytes: 1_048_577 }, { ...limits, pendingBytes: 65_537 },
      { ...limits, pendingWrites: 17 }, { ...limits, pendingWrites: 1.5 }]) {
      expect(() => createOwnedControllerTransport(binding, deadlines, invalid, 0)).toThrow();
    }
    for (const bytes of [0, -1, 0.5, NaN, Infinity]) {
      expect(step(running(), { kind: "write_started", id: 1, bytes }).phase).toBe("uncertain");
      expect(step(running(), { kind: "output", channel: "stdout", bytes }).phase).toBe("uncertain");
    }
    for (const now of [-1, 1, 2.5, Infinity, NaN]) {
      expect(step(running(), { kind: "tick" }, now).uncertainty).toBe("clock");
    }
    expect(step(initial(), { kind: "tick" }, 100).phase).toBe("uncertain");
  });

  test("generated finite fragments preserve exact accepted-byte counts", () => {
    fc.assert(fc.property(fc.array(fc.integer({ min: 1, max: 8 }), { maxLength: 16 }), (chunks) => {
      let state = running();
      chunks.forEach((bytes, index) => {
        state = step(state, { kind: "write_started", id: index + 1, bytes });
        state = step(state, { kind: "write_settled", id: index + 1, bytes });
        state = step(state, { kind: "output", channel: "stdout", bytes });
      });
      state = finishControl(outputEofs(finishInput(state)));
      const total = chunks.reduce((sum, bytes) => sum + bytes, 0);
      expect(ownedControllerTransportProof(state)).toMatchObject({ stdinAcceptedBytes: total,
        writesAccepted: chunks.length, stdoutBytes: total });
    }), { numRuns: 100 });
  });

  test("independent descriptor completion order never bypasses OOC1 terminal ordering", () => {
    const terminalEvent = terminal();
    const eofEvent = control({ kind: "control_eof" });
    const events: OwnedControllerTransportEvent[] = [terminalEvent, control({ kind: "helper_exit", code: 0 }),
      eofEvent, { kind: "output_eof", channel: "stdout" }, { kind: "output_eof", channel: "stderr" }];
    fc.assert(fc.property(fc.shuffledSubarray(events, { minLength: 5, maxLength: 5 }), (order) => {
      let state = finishInput(running());
      for (const event of order) state = step(state, event);
      const terminalIndex = order.indexOf(terminalEvent);
      const eofIndex = order.indexOf(eofEvent);
      expect(ownedControllerTransportProof(state) !== null).toBe(terminalIndex < eofIndex);
    }), { numRuns: 100 });
  });
});
