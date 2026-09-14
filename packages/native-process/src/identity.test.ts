import { expect, test } from "bun:test";

import { nativeHostContextSchema, nativePreparedOfReady, nativePreparedSchema,
  nativeProcessIdentitySchema, nativeReadySchema } from "./identity.ts";

const boot = { platform: "linux", id: "12345678-1234-1234-1234-123456789012",
  pidNamespace: { device: "1", inode: "18446744073709551615" } } as const;
const identity = (pid: number) => ({ pid, birth: { kind: "linux-start-ticks", ticks: "18446744073709551615" } } as const);
const prepared = { version: 1, nonce: "a".repeat(32), scope: "posix-process-group",
  groupId: 12, boot, supervisor: identity(11), anchor: identity(12) } as const;

test("identity validation preserves full u64 birth and namespace values without numeric rounding", () => {
  const ready = nativeReadySchema.parse({ ...prepared, pid: 13, root: identity(13) });
  expect(nativePreparedOfReady(ready)).toEqual(prepared);
  expect(nativeHostContextSchema.parse({ host: { platform: "linux", digest: "b".repeat(64) }, boot }).boot).toEqual(boot);
  for (const ticks of ["18446744073709551616", "01", "-1", "1.0", "1e1", "", " 1", "0".repeat(100)]) {
    expect(nativeProcessIdentitySchema.safeParse({ pid: 2, birth: { kind: "linux-start-ticks", ticks } }).success).toBe(false);
  }
});

test("prepared and ready evidence refuse unsafe PID values, duplicate roles and mixed platforms", () => {
  for (const pid of [0, 1, -1, 0x8000_0000, 1.5]) {
    expect(nativeProcessIdentitySchema.safeParse(identity(pid)).success).toBe(false);
  }
  const darwin = { pid: 12, birth: { kind: "darwin-start-time", seconds: "1", micros: 0 } } as const;
  for (const value of [
    { ...prepared, groupId: 13 }, { ...prepared, supervisor: identity(12) },
    { ...prepared, anchor: darwin }, { ...prepared, extra: true },
  ]) expect(nativePreparedSchema.safeParse(value).success).toBe(false);
  for (const value of [
    { ...prepared, pid: 13, root: identity(14) }, { ...prepared, pid: 11, root: identity(11) },
    { ...prepared, pid: 12, root: identity(12) }, { ...prepared, pid: 13, root: { ...darwin, pid: 13 } },
  ]) expect(nativeReadySchema.safeParse(value).success).toBe(false);
});

test("Mac microseconds and host platform remain strict structural values", () => {
  for (const micros of [-1, 1_000_000, 0.5]) {
    expect(nativeProcessIdentitySchema.safeParse({ pid: 2,
      birth: { kind: "darwin-start-time", seconds: "1", micros } }).success).toBe(false);
  }
  expect(nativeHostContextSchema.safeParse({ host: { platform: "darwin", digest: "b".repeat(64) }, boot }).success).toBe(false);
  expect(nativeHostContextSchema.safeParse({ host: { platform: "linux", digest: "B".repeat(64) }, boot }).success).toBe(false);
});
