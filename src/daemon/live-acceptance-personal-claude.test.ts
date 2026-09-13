import { describe, expect, test } from "bun:test";
import type { ClaudeProcess, ClaudeProcessIdentity } from "../claude/process";
import {
  observePersonalClaudeAcceptanceProcess,
  personalClaudeAcceptanceStatus,
  type PersonalClaudeAcceptanceProcessObservation,
} from "./live-acceptance-personal-claude";

const IDENTITY: ClaudeProcessIdentity = Object.freeze({
  pid: 1234, pidDomain: "darwin", procStart: "Sun Sep 13 10:00:00 2026",
});
function fixture() {
  const events: string[] = [];
  const writes: Uint8Array[] = [];
  let exit!: (code: number) => void;
  const child: ClaudeProcess = {
    identity: Promise.resolve(IDENTITY),
    exited: new Promise<number>((resolve) => { exit = resolve; }),
    stdout: { async *[Symbol.asyncIterator]() { yield new Uint8Array([1, 2]); } },
    stderr: { async *[Symbol.asyncIterator]() { yield new Uint8Array([3]); } },
    async write(bytes) { writes.push(Uint8Array.from(bytes)); events.push("actual-write"); },
    terminate() { events.push("term"); },
    forceTerminate() { events.push("kill"); },
  };
  const observation: PersonalClaudeAcceptanceProcessObservation = {
    identity() { events.push("identity"); }, identityFailed() { events.push("identity-failed"); },
    rootExited() { events.push("root-exit"); },
    streamEnded(channel) { events.push(`${channel}-eof`); },
    assertWrite() { events.push("admit-write"); },
    writeAccepted() { events.push("local-write-accepted"); },
  };
  return { child, observation, events, writes, exit };
}
async function drain(source: AsyncIterable<Uint8Array>): Promise<number[]> {
  const values: number[] = [];
  for await (const bytes of source) values.push(...bytes);
  return values;
}

describe("personal Claude acceptance observation adapter", () => {
  test("root exit is independent from real stream EOF and preserves actual child identity", async () => {
    const f = fixture(); const process = observePersonalClaudeAcceptanceProcess(f.child, f.observation);
    expect(await process.identity).toBe(IDENTITY);
    f.exit(17); expect(await process.exited).toBe(17);
    expect(f.events).toEqual(["identity", "root-exit"]);
    expect(await drain(process.stdout)).toEqual([1, 2]);
    expect(f.events).toContain("stdout-eof"); expect(f.events).not.toContain("stderr-eof");
    expect(await drain(process.stderr)).toEqual([3]);
    expect(f.events).toContain("stderr-eof");
  });

  test("a stopped consumer or stream failure never synthesizes EOF", async () => {
    const f = fixture(); const process = observePersonalClaudeAcceptanceProcess(f.child, f.observation);
    for await (const bytes of process.stdout) { expect(bytes.byteLength).toBeGreaterThan(0); break; }
    expect(f.events).not.toContain("stdout-eof");
    const failed = observePersonalClaudeAcceptanceProcess({ ...f.child,
      stderr: { async *[Symbol.asyncIterator]() { yield new Uint8Array([4]); throw new Error("stream failed"); } },
    }, f.observation);
    await expect(drain(failed.stderr)).rejects.toThrow("stream failed");
    expect(f.events).not.toContain("stderr-eof");
  });

  test("fresh synchronous write admission precedes the original child write", async () => {
    const f = fixture(); let closed = false;
    const process = observePersonalClaudeAcceptanceProcess(f.child, {
      ...f.observation,
      assertWrite(bytes) { expect(bytes).toEqual(new Uint8Array([6, 7])); if (closed) throw new Error("closed"); f.events.push("admit-write"); },
    });
    const bytes = new Uint8Array([6, 7]);
    await process.write(bytes);
    expect(f.events.filter((entry) => entry.includes("write"))).toEqual(["admit-write", "actual-write", "local-write-accepted"]);
    expect(f.writes).toEqual([bytes]); expect(bytes).toEqual(new Uint8Array([6, 7]));
    closed = true;
    await expect(process.write(bytes)).rejects.toThrow("closed");
    expect(f.writes).toHaveLength(1);
  });

  test("only a fulfilled local write can produce the deliberately lost acknowledgment", async () => {
    const f = fixture(); let acknowledgments = 0; let acceptedSnapshot: Uint8Array | undefined;
    const observation: PersonalClaudeAcceptanceProcessObservation = { ...f.observation,
      writeAccepted(bytes) { acceptedSnapshot = bytes; acknowledgments++; throw new Error("indeterminate accepted write"); },
    };
    const failedWrite = observePersonalClaudeAcceptanceProcess({ ...f.child, async write() { throw new Error("write failed"); } }, observation);
    await expect(failedWrite.write(new Uint8Array([9]))).rejects.toThrow("write failed");
    expect(acknowledgments).toBe(0);
    const accepted = observePersonalClaudeAcceptanceProcess(f.child, observation);
    await expect(accepted.write(new Uint8Array([9]))).rejects.toThrow("indeterminate accepted write");
    expect(f.writes).toEqual([new Uint8Array([9])]); expect(acknowledgments).toBe(1);
    expect(acceptedSnapshot).toEqual(new Uint8Array([0]));
    f.exit(0);
    expect(await accepted.exited).toBe(0);
    await Promise.all([drain(accepted.stdout), drain(accepted.stderr)]);
    expect(f.events).toContain("root-exit"); expect(f.events).toContain("stdout-eof"); expect(f.events).toContain("stderr-eof");
  });

  test("an observer cannot transform the actual outbound frame", async () => {
    const f = fixture();
    const process = observePersonalClaudeAcceptanceProcess(f.child, { ...f.observation,
      assertWrite(bytes) { bytes.fill(99); },
      writeAccepted(bytes) { expect(bytes).toEqual(new Uint8Array([4, 5])); bytes.fill(99); },
    });
    const input = new Uint8Array([4, 5]);
    await process.write(input);
    expect(f.writes).toEqual([new Uint8Array([4, 5])]);
    expect(input).toEqual(new Uint8Array([4, 5]));
  });

  test("identity failure remains failure and both exact termination methods are delegated", async () => {
    const f = fixture(); const process = observePersonalClaudeAcceptanceProcess({
      ...f.child, identity: Promise.reject(new Error("identity unknown")),
    }, f.observation);
    await expect(process.identity).rejects.toThrow("identity unknown");
    expect(f.events).toEqual(["identity-failed"]);
    process.terminate(); process.forceTerminate();
    expect(f.events).toEqual(["identity-failed", "term", "kill"]);
  });
});

test("the live status field is absent by default and only copies bounded observations", () => {
  expect(personalClaudeAcceptanceStatus(undefined)).toEqual({});
  const value = { userWriteAttempts: 2, acceptedUserWrites: 2, acknowledgmentWithheld: true };
  const status = personalClaudeAcceptanceStatus({ observeWrites: () => value });
  value.userWriteAttempts = 3;
  expect(status).toEqual({ liveAcceptancePersonalClaude: { userWriteAttempts: 2, acceptedUserWrites: 2, acknowledgmentWithheld: true } });
  for (const invalid of [{ ...value, userWriteAttempts: 4 }, { ...value, acceptedUserWrites: 3 },
    { ...value, userWriteAttempts: 1 }, { ...value, userWriteAttempts: NaN }, { ...value, extra: "private" }]) {
    expect(() => personalClaudeAcceptanceStatus({ observeWrites: () => invalid })).toThrow("status was refused");
  }
});
