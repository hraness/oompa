import { describe, expect, test } from "bun:test";

import {
  parseUsageAccountMetadata,
  parseUsageAccountPage,
  parseUsageAccountRow,
  parseUsageAccountRows,
  parseUsageSnapshotRow,
  parseUsageSnapshotRows,
  usageAccountMetadataAad,
} from "./usage";

const envelope = {
  algorithm: "A256GCM",
  ciphertext: "A".repeat(64),
  keyVersion: 1,
  nonce: "A".repeat(16),
} as const;

const account = {
  encryptedMetadata: envelope,
  publicId: "acct_00000000000000000000000000000001",
  updatedAt: 1_760_000_000_000,
} as const;

const snapshot = {
  digest: "a".repeat(64),
  envelope,
  observedAt: 1_760_000_000_000,
  receivedAt: 1_760_000_000_500,
  sourceRevision: 3,
} as const;

describe("usage account rows", () => {
  test("parses a bounded complete account page and rejects malformed pages", () => {
    expect(parseUsageAccountRow(account)).toEqual(account);
    expect(parseUsageAccountRow({ ...account, publicId: "/etc/passwd" })).toBeNull();
    expect(parseUsageAccountRow({ ...account, updatedAt: -1 })).toBeNull();
    expect(parseUsageAccountRow({ ...account, encryptedMetadata: { ...envelope, algorithm: "none" } })).toBeNull();
    expect(parseUsageAccountRows([account, { bogus: true }, null])).toEqual([]);
    expect(parseUsageAccountRows([account])).toEqual([account]);
    expect(parseUsageAccountRows("not a list")).toEqual([]);
  });

  test("a full account page cannot establish complete coverage", () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ ...account, encryptedMetadata: { ...envelope }, publicId: `acct_${String(index).padStart(32, "0")}` }));
    expect(parseUsageAccountPage(rows)).toMatchObject({ complete: false });
    expect(parseUsageAccountPage(rows).rows).toHaveLength(100);
    expect(parseUsageAccountPage(rows.slice(1)).complete).toBe(true);
    expect(parseUsageAccountPage([account, account]).complete).toBe(false);
  });

  test("bounds the decrypted metadata and keeps a null plan", () => {
    expect(parseUsageAccountMetadata({ email: "a@b.c", label: "Work", plan: null }))
      .toEqual({ email: "a@b.c", label: "Work", plan: null });
    expect(parseUsageAccountMetadata({ email: "a@b.c", label: "Work", plan: "plus" })?.plan).toBe("plus");
    expect(parseUsageAccountMetadata({ email: "a@b.c", label: "x".repeat(161), plan: null })).toBeNull();
    expect(parseUsageAccountMetadata({ email: "a@b.c", label: "Work" })).toBeNull();
    expect(parseUsageAccountMetadata({ email: 1, label: "Work", plan: null })).toBeNull();
  });

  test("binds the metadata authority exactly as the daemon writes it", () => {
    const aad = new TextDecoder().decode(usageAccountMetadataAad({
      accountPublicId: account.publicId,
      keyVersion: 2,
      userPublicId: "user_1",
    }));
    expect(aad).toBe(`hra-control-plane-private-json:v1\naccount_metadata\nuser_1\n${account.publicId}\n2`);
  });
});

describe("usage snapshot rows", () => {
  test("parses the winner rows and refuses an over-wide envelope", () => {
    expect(parseUsageSnapshotRow(snapshot)).toEqual({
      digest: snapshot.digest,
      envelope,
      observedAt: snapshot.observedAt,
      sourceRevision: snapshot.sourceRevision,
    });
    expect(parseUsageSnapshotRow({ ...snapshot, sourceRevision: -1 })).toBeNull();
    expect(parseUsageSnapshotRow({ ...snapshot, digest: "invalid" })).toBeNull();
    expect(parseUsageSnapshotRow({ ...snapshot, envelope: { ...envelope, ciphertext: "A".repeat(10_849) } })).toBeNull();
    expect(parseUsageSnapshotRows([snapshot, 42])).toHaveLength(0);
    expect(parseUsageSnapshotRows([snapshot])).toHaveLength(1);
    expect(parseUsageSnapshotRows(Array.from({ length: 25 }, () => snapshot))).toHaveLength(0);
  });
});
