import {
  createOwnedControllerObservation, observeOwnedController, ownedControllerDirectChildProof,
  type OwnedControllerBinding, type OwnedControllerDeadlines, type OwnedControllerEvent,
  type OwnedControllerObservation,
} from "./protocol.ts";

export type OwnedControllerTransportLimits = Readonly<{
  stdinBytes: number;
  stdoutBytes: number;
  stderrBytes: number;
  pendingWrites: number;
  pendingBytes: number;
}>;
type Channel = "stdout" | "stderr";
type PendingWrite = Readonly<{ id: number; bytes: number }>;
type Uncertainty = "controller" | "clock" | "order" | "limit" | "input" | "output" | "deadline";
export type OwnedControllerTransportObservation = Readonly<{
  version: "stdio-v1";
  controller: OwnedControllerObservation;
  limits: OwnedControllerTransportLimits;
  observedAt: number;
  phase: "active" | "draining" | "complete" | "uncertain";
  uncertainty: Uncertainty | null;
  drainDeadlineAt: number | null;
  cancelled: boolean;
  inputFenced: boolean;
  inputEnding: boolean;
  inputClosed: boolean;
  nextWriteId: number;
  pending: readonly PendingWrite[];
  pendingBytes: number;
  stdinStartedBytes: number;
  stdinAcceptedBytes: number;
  writesAccepted: number;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutEof: boolean;
  stderrEof: boolean;
}>;

export type OwnedControllerTransportEvent =
  | Readonly<{ kind: "controller"; event: OwnedControllerEvent }>
  | Readonly<{ kind: "write_started" | "write_settled"; id: number; bytes: number }>
  | Readonly<{ kind: "output"; channel: Channel; bytes: number }>
  | Readonly<{ kind: "output_eof" | "output_error"; channel: Channel }>
  | Readonly<{ kind: "input_end" | "input_closed" | "input_error" | "cancel" | "tick" }>;

const integer = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const validChannel = (value: unknown): boolean => value === "stdout" || value === "stderr";

export function createOwnedControllerTransport(
  binding: OwnedControllerBinding,
  deadlines: OwnedControllerDeadlines,
  limits: OwnedControllerTransportLimits,
  now: number,
): OwnedControllerTransportObservation {
  if (!integer(limits.stdinBytes, 1, 1_048_576) || !integer(limits.stdoutBytes, 1, 1_048_576)
    || !integer(limits.stderrBytes, 1, 1_048_576) || !integer(limits.pendingWrites, 1, 16)
    || !integer(limits.pendingBytes, 1, 65_536)) throw new Error("OWNED_CONTROLLER_TRANSPORT_INVALID");
  return {
    version: "stdio-v1", controller: createOwnedControllerObservation(binding, deadlines, now),
    limits: { ...limits }, observedAt: now, phase: "active", uncertainty: null, drainDeadlineAt: null,
    cancelled: false, inputFenced: false, inputEnding: false, inputClosed: false, nextWriteId: 1,
    pending: [], pendingBytes: 0, stdinStartedBytes: 0, stdinAcceptedBytes: 0, writesAccepted: 0,
    stdoutBytes: 0, stderrBytes: 0, stdoutEof: false, stderrEof: false,
  };
}

const fail = (state: OwnedControllerTransportObservation, uncertainty: Uncertainty): OwnedControllerTransportObservation =>
  ({ ...state, phase: "uncertain", inputFenced: true, uncertainty });

function joined(state: OwnedControllerTransportObservation): OwnedControllerTransportObservation {
  return state.inputClosed && state.pending.length === 0 && state.stdoutEof && state.stderrEof
    && ownedControllerDirectChildProof(state.controller) !== null
    ? { ...state, phase: "complete" } : state;
}

/** This reducer records observations only. It performs no writes, closes, or process operations. */
export function observeOwnedControllerTransport(
  state: OwnedControllerTransportObservation,
  event: OwnedControllerTransportEvent,
  now: number,
): OwnedControllerTransportObservation {
  if (state.phase === "uncertain") return state;
  if (!integer(now, state.observedAt, Number.MAX_SAFE_INTEGER - 86_460_000)) return fail(state, "clock");
  let next: OwnedControllerTransportObservation = { ...state, observedAt: now };
  if (state.phase === "complete") return event.kind === "tick" ? next : fail(next, "order");
  // OOC1 stops checking deadlines once its own three-way join completes. The
  // independent drain remains finite until both provider pipes and input join.
  if (state.drainDeadlineAt !== null && now >= state.drainDeadlineAt) return fail(next, "deadline");
  if (event.kind === "controller" && event.event.kind === "go_sent" && state.cancelled) return fail(next, "order");
  const controller = observeOwnedController(state.controller,
    event.kind === "controller" ? event.event : { kind: "tick" }, now);
  next = { ...next, controller };
  if (controller.phase === "uncertain") return fail(next, "controller");
  if (controller.termSent || controller.terminal !== null || controller.helperExited || event.kind === "cancel") {
    const deadline = Math.min(controller.deadlineAt, now + controller.deadlines.shutdownMs);
    next = { ...next, inputFenced: true, phase: "draining",
      drainDeadlineAt: Math.min(state.drainDeadlineAt ?? deadline, deadline) };
  }
  switch (event.kind) {
    case "controller": return joined(next);
    case "tick": return joined(next);
    case "cancel":
      if (state.cancelled) return fail(next, "order");
      return joined({ ...next, cancelled: true });
    case "input_error": return fail(next, "input");
    case "output_error": return fail(next, "output");
    case "input_end":
      if (state.inputEnding || state.inputClosed) return fail(next, "order");
      return joined({ ...next, inputFenced: true, inputEnding: true });
    case "input_closed":
      if (!state.inputEnding || state.inputClosed) return fail(next, "order");
      return joined({ ...next, inputClosed: true });
    case "write_started": {
      if (!controller.goSent || controller.phase !== "running" || next.inputFenced
        || !integer(event.id, 1, 1_048_576) || event.id !== state.nextWriteId) return fail(next, "order");
      if (!integer(event.bytes, 1, state.limits.pendingBytes)
        || state.pending.length >= state.limits.pendingWrites
        || state.pendingBytes + event.bytes > state.limits.pendingBytes
        || state.stdinStartedBytes + event.bytes > state.limits.stdinBytes) return fail(next, "limit");
      return { ...next, nextWriteId: event.id + 1,
        pending: [...state.pending, { id: event.id, bytes: event.bytes }],
        pendingBytes: state.pendingBytes + event.bytes,
        stdinStartedBytes: state.stdinStartedBytes + event.bytes };
    }
    case "write_settled": {
      const write = state.pending.find((pending) => pending.id === event.id);
      if (write === undefined || !integer(event.bytes, 1, state.limits.pendingBytes) || event.bytes !== write.bytes) {
        return fail(next, "input");
      }
      return joined({ ...next, pending: state.pending.filter((pending) => pending.id !== event.id),
        pendingBytes: state.pendingBytes - write.bytes, stdinAcceptedBytes: state.stdinAcceptedBytes + write.bytes,
        writesAccepted: state.writesAccepted + 1 });
    }
    case "output": {
      if (!validChannel(event.channel) || !controller.goSent) return fail(next, "order");
      const closed = event.channel === "stdout" ? state.stdoutEof : state.stderrEof;
      if (closed) return fail(next, "order");
      const bytes = (event.channel === "stdout" ? state.stdoutBytes : state.stderrBytes) + event.bytes;
      if (!integer(event.bytes, 1, state.limits[`${event.channel}Bytes`])
        || bytes > state.limits[`${event.channel}Bytes`]) return fail(next, "limit");
      return event.channel === "stdout" ? { ...next, stdoutBytes: bytes } : { ...next, stderrBytes: bytes };
    }
    case "output_eof":
      if (!validChannel(event.channel)) return fail(next, "order");
      if (event.channel === "stdout") {
        if (state.stdoutEof) return fail(next, "order");
        return joined({ ...next, stdoutEof: true });
      }
      if (state.stderrEof) return fail(next, "order");
      return joined({ ...next, stderrEof: true });
  }
}

export function ownedControllerTransportProof(state: OwnedControllerTransportObservation) {
  const directChild = ownedControllerDirectChildProof(state.controller);
  if (state.phase !== "complete" || state.uncertainty !== null || directChild === null
    || !state.inputClosed || state.pending.length !== 0 || state.pendingBytes !== 0 || !state.stdoutEof || !state.stderrEof) return null;
  return {
    version: "stdio-v1" as const, scope: "owned_direct_child_stdio_only" as const, directChild,
    stdinAcceptedBytes: state.stdinAcceptedBytes, writesAccepted: state.writesAccepted,
    stdoutBytes: state.stdoutBytes, stderrBytes: state.stderrBytes,
    providerConsumptionProven: false as const, replacementWriterAuthorized: false as const,
  };
}
