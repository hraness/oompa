import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  encodeNativeFrame, encodeNativeLaunch, encodeNativeWrite, MAX_NATIVE_CONTROL_BYTES,
  NativeCommandKind, NativeEventKind, NativeFrameDecoder, NativeProtocolError,
  parseNativeEvent, type NativeFrame,
} from "./protocol.ts";

const nonce = "0123456789abcdef0123456789abcdef";
const launch = {
  version: 1, nonce, scope: "posix-process-group", argv: ["/fixture", "λ"],
  cwd: "/fixture-root", environment: { LANG: "C.UTF-8" },
  termGraceMs: 100, settlementMs: 1000, writeTimeoutMs: 2000,
};
const control = (kind: number, value: unknown): NativeFrame => ({
  kind, payload: new TextEncoder().encode(JSON.stringify(value)),
});

describe("native byte-process framing", () => {
  test("fragmentation preserves arbitrary bytes and independent stream ordering", () => {
    fc.assert(fc.property(
      fc.array(fc.tuple(fc.boolean(), fc.uint8Array({ minLength: 1, maxLength: 1024 })), { minLength: 1, maxLength: 12 }),
      fc.integer({ min: 1, max: 131 }),
      (values, width) => {
        const expected = values.map(([errorStream, bytes]) => ({ kind: errorStream ? NativeEventKind.stderr : NativeEventKind.stdout, payload: bytes }));
        const wire = Buffer.concat(expected.map(frame => encodeNativeFrame(frame.kind, frame.payload, "events")));
        const parser = new NativeFrameDecoder("events");
        const actual: NativeFrame[] = [];
        for (let offset = 0; offset < wire.length; offset += width) actual.push(...parser.push(wire.subarray(offset, offset + width)));
        parser.finish();
        expect(actual).toEqual(expected);
      },
    ), { numRuns: 100 });
  });

  test("empty commands and a zero-byte write retain exact framing", () => {
    const parser = new NativeFrameDecoder("commands");
    const frames = parser.push(Buffer.concat([
      encodeNativeFrame(NativeCommandKind.stop, new Uint8Array(), "commands"),
      encodeNativeWrite(1, new Uint8Array()),
    ]));
    parser.finish();
    expect(frames).toEqual([
      { kind: NativeCommandKind.stop, payload: new Uint8Array() },
      { kind: NativeCommandKind.write, payload: new Uint8Array([0, 0, 0, 1]) },
    ]);
  });

  test("every incomplete nonempty prefix refuses EOF", () => {
    const wire = encodeNativeFrame(NativeEventKind.stdout, new Uint8Array([1, 2, 3, 4]), "events");
    for (let length = 1; length < wire.length; length += 1) {
      const parser = new NativeFrameDecoder("events");
      parser.push(wire.subarray(0, length));
      expect(() => parser.finish()).toThrow(NativeProtocolError);
      expect(() => parser.push(wire)).toThrow(NativeProtocolError);
    }
  });

  test("oversize and unknown headers reject before receiving or allocating their body", () => {
    for (const [kind, length] of [[NativeEventKind.ready, MAX_NATIVE_CONTROL_BYTES + 1], [NativeEventKind.stdout, 0xffff_ffff], [0, 1]]) {
      const header = new Uint8Array(5);
      header[0] = kind!;
      new DataView(header.buffer).setUint32(1, length!, false);
      const parser = new NativeFrameDecoder("events");
      expect(() => parser.push(header)).toThrow(NativeProtocolError);
      expect(() => parser.finish()).toThrow(NativeProtocolError);
    }
  });

  test("finished decoders cannot accept new observations", () => {
    const parser = new NativeFrameDecoder("events");
    parser.finish();
    expect(() => parser.push(new Uint8Array())).toThrow(NativeProtocolError);
  });
});

describe("native launch and observation boundaries", () => {
  test("launch is strict, byte bounded and platform-specific", () => {
    expect(encodeNativeLaunch(launch)[0]).toBe(NativeCommandKind.launch);
    for (const invalid of [
      { ...launch, unexpected: true }, { ...launch, argv: ["relative"] },
      { ...launch, cwd: "relative" }, { ...launch, nonce: nonce.toUpperCase() },
      { ...launch, environment: { "BAD=KEY": "x" } },
      { ...launch, environment: { "A-B": "x" } }, { ...launch, environment: { "1A": "x" } },
      { ...launch, environment: { KEY: "secret\0value" } },
      { ...launch, argv: ["/fixture", "λ".repeat(16_385)] },
      { ...launch, termGraceMs: 0 }, { ...launch, writeTimeoutMs: 60_001 },
      { ...launch, environment: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [String(index), "x"])) },
    ]) expect(() => encodeNativeLaunch(invalid)).toThrow(NativeProtocolError);
    expect(encodeNativeLaunch({ ...launch, scope: "windows-job", argv: ["C:\\fixture.exe"], cwd: "C:\\fixture-root" })[0]).toBe(NativeCommandKind.launch);
  });

  test("control observations reject unknown fields, invalid bytes and sensitive diagnostics", () => {
    const sensitive = "private-provider-value";
    for (const frame of [
      control(NativeEventKind.ready, { version: 1, nonce, scope: "posix-process-group", pid: 12, secret: sensitive }),
      control(NativeEventKind.failure, { reason: sensitive }),
      control(NativeEventKind.rootExit, { code: 0, signal: 9 }),
      control(NativeEventKind.rootExit, { code: null, signal: null }),
      { kind: NativeEventKind.ready, payload: new Uint8Array([0xff]) },
      { kind: NativeEventKind.streamEnd, payload: new Uint8Array([0]) },
    ]) {
      let error: unknown;
      try { parseNativeEvent(frame); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(NativeProtocolError);
      expect(String(error)).not.toContain(sensitive);
    }
  });

  test("operation failure and physical custody are separate events", () => {
    expect(parseNativeEvent(control(NativeEventKind.failure, { reason: "write-failed" })))
      .toEqual({ kind: "failure", reason: "write-failed" });
    expect(parseNativeEvent(control(NativeEventKind.joined, { version: 1, nonce, scope: "posix-process-group" })))
      .toEqual({ kind: "joined", value: { version: 1, nonce, scope: "posix-process-group" } });
    expect(parseNativeEvent(control(NativeEventKind.notStarted, { version: 1, nonce, scope: "posix-process-group" })).kind)
      .toBe("notStarted");
  });

  test("write receipts preserve unknown dispatch and reject contradictory byte counts", () => {
    expect(parseNativeEvent(control(NativeEventKind.writeResult, { id: 1, outcome: "indeterminate", acceptedBytes: 3 })))
      .toEqual({ kind: "writeResult", value: { id: 1, outcome: "indeterminate", acceptedBytes: 3 } });
    for (const invalid of [
      { id: 0, outcome: "accepted-full", acceptedBytes: 1 },
      { id: 1, outcome: "refused-before-write", acceptedBytes: 1 },
      { id: 1, outcome: "partial-known", acceptedBytes: 0 },
      { id: 1, outcome: "accepted-full", acceptedBytes: -1 },
    ]) expect(() => parseNativeEvent(control(NativeEventKind.writeResult, invalid))).toThrow(NativeProtocolError);
    for (const id of [0, -1, 0x1_0000_0000, 0.5]) expect(() => encodeNativeWrite(id, new Uint8Array())).toThrow(NativeProtocolError);
  });
});
