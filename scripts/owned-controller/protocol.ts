export const OWNED_CONTROLLER_PROTOCOL = "OOC1";
export const OWNED_CONTROLLER_MAX_FRAME_BYTES = 160;
export const OWNED_CONTROLLER_MAX_FRAMES = 2;
export const OWNED_CONTROLLER_MAX_ID = 2_147_483_647;

export type OwnedControllerBinding = Readonly<{ nonce: string; generation: number }>;
export type OwnedControllerHostFrame = OwnedControllerBinding & Readonly<{ type: "go" | "term" }>;
export type OwnedControllerHelperFrame = OwnedControllerBinding & (
  | Readonly<{ type: "ready"; childPid: number }>
  | Readonly<{ type: "terminal"; childPid: number; released: boolean; termination: "exit" | "signal"; status: number }>
);
export type OwnedControllerFrame = OwnedControllerHostFrame | OwnedControllerHelperFrame;

export class OwnedControllerProtocolError extends Error {
  constructor(readonly reason: "malformed" | "oversized" | "unsupported_version" | "direction" | "closed") {
    super(`Owned controller protocol refused: ${reason}.`);
    this.name = "OwnedControllerProtocolError";
  }
}

const invalid = (): never => { throw new OwnedControllerProtocolError("malformed"); };
const boundedInteger = (value: number, minimum: number, maximum: number): boolean =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const decimal = (value: string | undefined, minimum: number, maximum: number): number => {
  if (value === undefined || !/^(?:0|[1-9][0-9]{0,9})$/u.test(value)) return invalid();
  const number = Number(value);
  if (!boundedInteger(number, minimum, maximum)) return invalid();
  return number;
};
const assertBinding = (binding: OwnedControllerBinding): void => {
  if (!/^[0-9a-f]{32}$/u.test(binding.nonce) || !boundedInteger(binding.generation, 1, OWNED_CONTROLLER_MAX_ID)) invalid();
};

/** One complete ASCII frame, including its sole final LF; no permissive trimming. */
export function parseOwnedControllerFrame(value: unknown): OwnedControllerFrame {
  if (typeof value !== "string") return invalid();
  if (value.length > OWNED_CONTROLLER_MAX_FRAME_BYTES) throw new OwnedControllerProtocolError("oversized");
  if (value.indexOf("\n") !== value.length - 1 || !/^[\x20-\x7e]+\n$/u.test(value)) return invalid();
  const fields = value.slice(0, -1).split(" ");
  if (fields.some((field) => field.length === 0)) return invalid();
  if (fields[0] !== OWNED_CONTROLLER_PROTOCOL) {
    if (/^OOC[0-9]+$/u.test(fields[0] ?? "")) throw new OwnedControllerProtocolError("unsupported_version");
    return invalid();
  }
  const nonce = fields[2];
  if (nonce === undefined || !/^[0-9a-f]{32}$/u.test(nonce)) return invalid();
  const generation = decimal(fields[3], 1, OWNED_CONTROLLER_MAX_ID);
  switch (fields[1]) {
    case undefined: return invalid();
    case "GO":
    case "TERM":
      if (fields.length !== 4) return invalid();
      return { type: fields[1] === "GO" ? "go" : "term", nonce, generation };
    case "READY":
      if (fields.length !== 5) return invalid();
      return { type: "ready", nonce, generation, childPid: decimal(fields[4], 1, OWNED_CONTROLLER_MAX_ID) };
    case "TERMINAL": {
      if (fields.length !== 8 || (fields[5] !== "0" && fields[5] !== "1")) return invalid();
      const termination = fields[6];
      if (termination !== "exit" && termination !== "signal") return invalid();
      return {
        type: "terminal", nonce, generation,
        childPid: decimal(fields[4], 1, OWNED_CONTROLLER_MAX_ID), released: fields[5] === "1", termination,
        status: decimal(fields[7], termination === "exit" ? 0 : 1, termination === "exit" ? 255 : 127),
      };
    }
    default: return invalid();
  }
}

export function encodeOwnedControllerFrame(frame: OwnedControllerFrame): string {
  const prefix = `${OWNED_CONTROLLER_PROTOCOL} ${frame.type.toUpperCase()} ${frame.nonce} ${frame.generation}`;
  const wire = frame.type === "ready" ? `${prefix} ${frame.childPid}\n`
    : frame.type === "terminal" ? `${prefix} ${frame.childPid} ${frame.released ? 1 : 0} ${frame.termination} ${frame.status}\n`
      : `${prefix}\n`;
  parseOwnedControllerFrame(wire);
  return wire;
}

/** Bounded for a single handshake. Any rejected push permanently closes the decoder. */
export class OwnedControllerDecoder {
  #pending = "";
  #frames = 0;
  #bytes = 0;
  #closed = false;

  constructor(readonly direction: "host" | "helper") {}

  push(chunk: Uint8Array): readonly OwnedControllerFrame[] {
    if (this.#closed) throw new OwnedControllerProtocolError("closed");
    try {
      this.#bytes += chunk.byteLength;
      if (this.#bytes > OWNED_CONTROLLER_MAX_FRAME_BYTES * OWNED_CONTROLLER_MAX_FRAMES) {
        throw new OwnedControllerProtocolError("oversized");
      }
      const result: OwnedControllerFrame[] = [];
      for (const byte of chunk) {
        if (byte !== 10 && (byte < 32 || byte > 126)) invalid();
        this.#pending += String.fromCharCode(byte);
        if (this.#pending.length > OWNED_CONTROLLER_MAX_FRAME_BYTES) throw new OwnedControllerProtocolError("oversized");
        if (byte !== 10) continue;
        const frame = parseOwnedControllerFrame(this.#pending);
        this.#pending = "";
        if (++this.#frames > OWNED_CONTROLLER_MAX_FRAMES) throw new OwnedControllerProtocolError("oversized");
        const host = frame.type === "go" || frame.type === "term";
        if (host !== (this.direction === "host")) throw new OwnedControllerProtocolError("direction");
        result.push(frame);
      }
      return result;
    } catch (error: unknown) {
      this.#closed = true;
      this.#pending = "";
      throw error;
    }
  }

  finish(): void {
    if (this.#closed) throw new OwnedControllerProtocolError("closed");
    this.#closed = true;
    if (this.#pending.length !== 0) {
      this.#pending = "";
      invalid();
    }
  }
}

export type OwnedControllerDeadlines = Readonly<{ startupMs: number; runMs: number; shutdownMs: number }>;
export type OwnedControllerUncertainty = "protocol" | "binding" | "order" | "deadline" | "clock" | "owner_lost" | "helper_exit" | "missing_terminal";
export type OwnedControllerObservation = Readonly<{
  binding: OwnedControllerBinding;
  deadlines: OwnedControllerDeadlines;
  phase: "starting" | "ready" | "running" | "stopping" | "terminal" | "complete" | "uncertain";
  observedAt: number;
  deadlineAt: number;
  childPid: number | null;
  goSent: boolean;
  termSent: boolean;
  helperExited: boolean;
  controlEof: boolean;
  terminal: Extract<OwnedControllerHelperFrame, { type: "terminal" }> | null;
  uncertainty: OwnedControllerUncertainty | null;
}>;

export type OwnedControllerEvent =
  | Readonly<{ kind: "frame"; frame: OwnedControllerFrame }>
  | Readonly<{ kind: "helper_exit"; code: number | null }>
  | Readonly<{ kind: "go_sent" | "term_sent" | "control_eof" | "tick" | "owner_lost" | "protocol_failure" }>;

export function createOwnedControllerObservation(
  binding: OwnedControllerBinding,
  deadlines: OwnedControllerDeadlines,
  now: number,
): OwnedControllerObservation {
  assertBinding(binding);
  if (!boundedInteger(deadlines.startupMs, 1, 30_000) || !boundedInteger(deadlines.runMs, 1, 86_400_000)
    || !boundedInteger(deadlines.shutdownMs, 1, 30_000)
    || !boundedInteger(now, 0, Number.MAX_SAFE_INTEGER - 86_460_000)) return invalid();
  return {
    binding: { ...binding }, deadlines: { ...deadlines }, phase: "starting", observedAt: now,
    deadlineAt: now + deadlines.startupMs, childPid: null, goSent: false, termSent: false,
    helperExited: false, controlEof: false, terminal: null, uncertainty: null,
  };
}

const uncertain = (state: OwnedControllerObservation, reason: OwnedControllerUncertainty): OwnedControllerObservation =>
  ({ ...state, phase: "uncertain", uncertainty: reason });
const joined = (state: OwnedControllerObservation): OwnedControllerObservation =>
  state.terminal !== null && state.helperExited && state.controlEof ? { ...state, phase: "complete" } : state;

/** Observations cannot authorize an OS operation. The host adapter owns each send and native wait. */
export function observeOwnedController(
  state: OwnedControllerObservation,
  event: OwnedControllerEvent,
  now: number,
): OwnedControllerObservation {
  if (state.phase === "uncertain") return state;
  if (!boundedInteger(now, state.observedAt, Number.MAX_SAFE_INTEGER - 86_460_000)) return uncertain(state, "clock");
  let next: OwnedControllerObservation = { ...state, observedAt: now };
  if (event.kind === "owner_lost") return uncertain(next, "owner_lost");
  if (event.kind === "protocol_failure") return uncertain(next, "protocol");
  if (state.phase === "complete") return event.kind === "tick" ? next : uncertain(next, "order");
  if (now >= state.deadlineAt) return uncertain(next, "deadline");
  switch (event.kind) {
    case "tick": return next;
    case "go_sent":
      if (state.phase !== "ready" || state.goSent || state.termSent || state.helperExited) return uncertain(next, "order");
      return { ...next, phase: "running", goSent: true, deadlineAt: now + state.deadlines.runMs };
    case "term_sent":
      if ((state.phase !== "ready" && state.phase !== "running") || state.termSent || state.helperExited) return uncertain(next, "order");
      return { ...next, phase: "stopping", termSent: true, deadlineAt: now + state.deadlines.shutdownMs };
    case "helper_exit":
      if (state.helperExited || event.code !== 0) return uncertain(next, "helper_exit");
      return joined({ ...next, helperExited: true, deadlineAt: Math.min(state.deadlineAt, now + state.deadlines.shutdownMs) });
    case "control_eof":
      if (state.controlEof) return uncertain(next, "order");
      if (state.terminal === null) return uncertain(next, "missing_terminal");
      return joined({ ...next, controlEof: true });
    case "frame": {
      let frame: OwnedControllerFrame;
      try { frame = parseOwnedControllerFrame(encodeOwnedControllerFrame(event.frame)); }
      catch { return uncertain(next, "protocol"); }
      if (state.controlEof) return uncertain(next, "order");
      if (frame.nonce !== state.binding.nonce || frame.generation !== state.binding.generation) return uncertain(next, "binding");
      if (frame.type === "ready") {
        if (state.phase !== "starting") return uncertain(next, "order");
        return { ...next, phase: "ready", childPid: frame.childPid };
      }
      if (frame.type !== "terminal" || state.terminal !== null || state.childPid === null
        || frame.childPid !== state.childPid || frame.released !== state.goSent) return uncertain(next, "order");
      next = { ...next, phase: "terminal", terminal: frame, deadlineAt: Math.min(state.deadlineAt, now + state.deadlines.shutdownMs) };
      return joined(next);
    }
  }
}

export type OwnedControllerDirectChildProof = Readonly<{
  scope: "owned_direct_child_only";
  binding: OwnedControllerBinding;
  childPid: number;
  released: boolean;
  termination: "exit" | "signal";
  status: number;
  replacementWriterAuthorized: false;
}>;

export function ownedControllerDirectChildProof(state: OwnedControllerObservation): OwnedControllerDirectChildProof | null {
  if (state.phase !== "complete" || state.terminal === null || !state.helperExited || !state.controlEof || state.uncertainty !== null) return null;
  const terminal = state.terminal;
  return { scope: "owned_direct_child_only", binding: { ...state.binding }, childPid: terminal.childPid,
    released: terminal.released, termination: terminal.termination, status: terminal.status, replacementWriterAuthorized: false };
}
