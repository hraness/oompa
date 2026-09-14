import { z } from "zod";

import { nativePreparedSchema, nativeReadySchema } from "../domain/native-process-identity.ts";
import type { NativePrepared, NativeReady } from "../domain/native-process-identity.ts";
export type { NativeProcessIdentity, NativeBootIdentity, NativePrepared, NativeReady } from "../domain/native-process-identity.ts";

export const NATIVE_PROTOCOL_VERSION = 1;
export const MAX_NATIVE_WRITE_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_LAUNCH_BYTES = 256 * 1024;
export const MAX_NATIVE_OUTPUT_CHUNK_BYTES = 64 * 1024;
export const MAX_NATIVE_CONTROL_BYTES = 4096;
const MAX_DECODER_CHUNK_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export const NativeCommandKind = {
  launch: 1, write: 2, closeInput: 3, stop: 4, forceStop: 5, activate: 6,
} as const;
export const NativeEventKind = {
  ready: 129, stdout: 130, stderr: 131, writeResult: 132, rootExit: 133,
  joined: 134, failure: 135, streamEnd: 136, notStarted: 137, prepared: 138,
} as const;

export class NativeProtocolError extends Error {
  constructor() {
    super("Native process protocol validation failed.");
    this.name = "NativeProtocolError";
  }
}

const boundedString = z.string().refine(value =>
  !value.includes("\0") && encoder.encode(value).byteLength <= 32 * 1024);
const scopeSchema = z.enum(["posix-process-group", "windows-job"]);
const nonceSchema = z.string().regex(/^[0-9a-f]{32}$/u);
const unsignedId = z.number().int().min(1).max(0xffff_ffff);
const bindingShape = {
  version: z.literal(NATIVE_PROTOCOL_VERSION), nonce: nonceSchema, scope: scopeSchema,
};
const bindingSchema = z.object(bindingShape).strict();
const launchSchema = z.object({
  ...bindingShape,
  argv: z.array(boundedString).min(1).max(256),
  cwd: boundedString.min(1),
  environment: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).refine(key =>
    encoder.encode(key).byteLength <= 32 * 1024), boundedString)
    .refine(value => Object.keys(value).length <= 256),
  termGraceMs: z.number().int().min(1).max(30_000),
  settlementMs: z.number().int().min(1).max(30_000),
  writeTimeoutMs: z.number().int().min(1).max(60_000),
}).strict().refine(value => {
  const absolute = (path: string): boolean => value.scope === "windows-job"
    ? /^[a-z]:[\\/]/iu.test(path) || /^\\\\[^\\]+\\[^\\]+/u.test(path)
    : path.startsWith("/");
  return absolute(value.cwd) && absolute(value.argv[0] ?? "");
});
const writeResultSchema = z.object({
  id: unsignedId,
  outcome: z.enum(["accepted-full", "refused-before-write", "partial-known", "indeterminate"]),
  acceptedBytes: z.number().int().min(0).max(MAX_NATIVE_WRITE_BYTES),
}).strict().refine(value => value.outcome !== "refused-before-write" || value.acceptedBytes === 0)
  .refine(value => value.outcome !== "partial-known" || value.acceptedBytes > 0);
const rootExitSchema = z.object({
  code: z.number().int().min(0).max(255).nullable(),
  signal: z.number().int().min(1).max(127).nullable(),
}).strict().refine(value => (value.code === null) !== (value.signal === null));
const failureSchema = z.object({
  reason: z.enum(["invalid-launch", "invalid-frame", "unsupported-scope", "spawn-failed",
    "write-failed", "output-failed", "controller-lost", "deadline", "cleanup-unproven"]),
}).strict();

export type NativeLaunch = z.infer<typeof launchSchema>;
export type NativeBinding = z.infer<typeof bindingSchema>;
export type NativeWriteResult = z.infer<typeof writeResultSchema>;
export type NativeRootExit = z.infer<typeof rootExitSchema>;
export type NativeFailureReason = z.infer<typeof failureSchema>["reason"];
export type NativeFrame = Readonly<{ kind: number; payload: Uint8Array }>;
export type NativeEvent =
  | Readonly<{ kind: "prepared"; value: NativePrepared }>
  | Readonly<{ kind: "ready"; value: NativeReady }>
  | Readonly<{ kind: "stdout" | "stderr"; bytes: Uint8Array }>
  | Readonly<{ kind: "writeResult"; value: NativeWriteResult }>
  | Readonly<{ kind: "rootExit"; value: NativeRootExit }>
  | Readonly<{ kind: "joined" | "notStarted"; value: NativeBinding }>
  | Readonly<{ kind: "failure"; reason: NativeFailureReason }>
  | Readonly<{ kind: "streamEnd"; stream: "stdout" | "stderr" | "stdin" }>;

function assertLength(kind: number, length: number, direction: "commands" | "events"): void {
  let maximum: number;
  let minimum = 0;
  if (direction === "commands") {
    switch (kind) {
      case NativeCommandKind.launch: maximum = MAX_NATIVE_LAUNCH_BYTES; minimum = 1; break;
      case NativeCommandKind.write: maximum = MAX_NATIVE_WRITE_BYTES + 4; minimum = 4; break;
      case NativeCommandKind.closeInput:
      case NativeCommandKind.stop:
      case NativeCommandKind.forceStop:
      case NativeCommandKind.activate: maximum = 0; break;
      default: throw new NativeProtocolError();
    }
  } else {
    switch (kind) {
      case NativeEventKind.stdout:
      case NativeEventKind.stderr: maximum = MAX_NATIVE_OUTPUT_CHUNK_BYTES; minimum = 1; break;
      case NativeEventKind.streamEnd: maximum = 1; minimum = 1; break;
      case NativeEventKind.ready:
      case NativeEventKind.writeResult:
      case NativeEventKind.rootExit:
      case NativeEventKind.joined:
      case NativeEventKind.failure:
      case NativeEventKind.notStarted:
      case NativeEventKind.prepared: maximum = MAX_NATIVE_CONTROL_BYTES; minimum = 1; break;
      default: throw new NativeProtocolError();
    }
  }
  if (!Number.isInteger(length) || length < minimum || length > maximum) throw new NativeProtocolError();
}

export function encodeNativeFrame(kind: number, payload: Uint8Array, direction: "commands" | "events"): Uint8Array {
  assertLength(kind, payload.byteLength, direction);
  const bytes = new Uint8Array(5 + payload.byteLength);
  bytes[0] = kind;
  new DataView(bytes.buffer).setUint32(1, payload.byteLength, false);
  bytes.set(payload, 5);
  return bytes;
}

export function encodeNativeLaunch(input: unknown): Uint8Array {
  const parsed = launchSchema.safeParse(input);
  if (!parsed.success) throw new NativeProtocolError();
  return encodeNativeFrame(NativeCommandKind.launch, encoder.encode(JSON.stringify(parsed.data)), "commands");
}

export function encodeNativeWrite(id: number, input: Uint8Array): Uint8Array {
  if (!unsignedId.safeParse(id).success || input.byteLength > MAX_NATIVE_WRITE_BYTES) throw new NativeProtocolError();
  const payload = new Uint8Array(4 + input.byteLength);
  new DataView(payload.buffer).setUint32(0, id, false);
  payload.set(input, 4);
  return encodeNativeFrame(NativeCommandKind.write, payload, "commands");
}

/** An incremental bounded decoder. A rejected header never allocates its body. */
export class NativeFrameDecoder {
  readonly #direction: "commands" | "events";
  readonly #header = new Uint8Array(5);
  #headerBytes = 0;
  #payload: Uint8Array | null = null;
  #payloadBytes = 0;
  #failed = false;
  #finished = false;

  constructor(direction: "commands" | "events") { this.#direction = direction; }

  push(chunk: Uint8Array): readonly NativeFrame[] {
    if (this.#failed || this.#finished || chunk.byteLength > MAX_DECODER_CHUNK_BYTES) {
      this.#failed = true;
      throw new NativeProtocolError();
    }
    const frames: NativeFrame[] = [];
    let cursor = 0;
    try {
      while (cursor < chunk.byteLength) {
        if (this.#headerBytes < 5) {
          const count = Math.min(5 - this.#headerBytes, chunk.byteLength - cursor);
          this.#header.set(chunk.subarray(cursor, cursor + count), this.#headerBytes);
          this.#headerBytes += count;
          cursor += count;
          if (this.#headerBytes < 5) break;
          const kind = this.#header[0];
          if (kind === undefined) throw new NativeProtocolError();
          const length = new DataView(this.#header.buffer).getUint32(1, false);
          assertLength(kind, length, this.#direction);
          this.#payload = new Uint8Array(length);
          this.#payloadBytes = 0;
        }
        const payload = this.#payload;
        if (payload === null) throw new NativeProtocolError();
        const count = Math.min(payload.byteLength - this.#payloadBytes, chunk.byteLength - cursor);
        payload.set(chunk.subarray(cursor, cursor + count), this.#payloadBytes);
        this.#payloadBytes += count;
        cursor += count;
        if (this.#payloadBytes === payload.byteLength) {
          const kind = this.#header[0];
          if (kind === undefined) throw new NativeProtocolError();
          frames.push({ kind, payload });
          this.#headerBytes = 0;
          this.#payload = null;
          this.#payloadBytes = 0;
        }
      }
      return frames;
    } catch {
      this.#failed = true;
      this.#payload = null;
      throw new NativeProtocolError();
    }
  }

  finish(): void {
    if (this.#failed || this.#headerBytes !== 0 || this.#payload !== null) {
      this.#failed = true;
      throw new NativeProtocolError();
    }
    this.#finished = true;
  }
}

function parseControl<T>(payload: Uint8Array, schema: z.ZodType<T>): T {
  try {
    const value: unknown = JSON.parse(decoder.decode(payload));
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new NativeProtocolError();
    return parsed.data;
  } catch { throw new NativeProtocolError(); }
}

export function parseNativeEvent(frame: NativeFrame): NativeEvent {
  assertLength(frame.kind, frame.payload.byteLength, "events");
  switch (frame.kind) {
    case NativeEventKind.prepared: return { kind: "prepared", value: parseControl(frame.payload, nativePreparedSchema) };
    case NativeEventKind.ready: return { kind: "ready", value: parseControl(frame.payload, nativeReadySchema) };
    case NativeEventKind.stdout: return { kind: "stdout", bytes: frame.payload };
    case NativeEventKind.stderr: return { kind: "stderr", bytes: frame.payload };
    case NativeEventKind.writeResult: return { kind: "writeResult", value: parseControl(frame.payload, writeResultSchema) };
    case NativeEventKind.rootExit: return { kind: "rootExit", value: parseControl(frame.payload, rootExitSchema) };
    case NativeEventKind.joined: return { kind: "joined", value: parseControl(frame.payload, bindingSchema) };
    case NativeEventKind.notStarted: return { kind: "notStarted", value: parseControl(frame.payload, bindingSchema) };
    case NativeEventKind.failure: return { kind: "failure", reason: parseControl(frame.payload, failureSchema).reason };
    case NativeEventKind.streamEnd: {
      const stream = frame.payload[0] === 1 ? "stdout" : frame.payload[0] === 2 ? "stderr" : frame.payload[0] === 3 ? "stdin" : null;
      if (stream === null) throw new NativeProtocolError();
      return { kind: "streamEnd", stream };
    }
    default: throw new NativeProtocolError();
  }
}
