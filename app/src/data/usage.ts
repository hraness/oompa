/**
 * Provider usage, read from the hosted projection.
 *
 * Each daemon archives at most one encrypted projection per account every 24
 * hours. The server selects rows per account, so an account seen from
 * two machines is one row here. The account's label, email and plan ride in a
 * separately encrypted metadata envelope bound to the same private-JSON
 * authority the daemon used (`hra-control-plane-private-json:v1`). Both are
 * decrypted with the account key and never leave this tab.
 */
import { useQueries, useQuery } from "convex/react";
import { useEffect, useMemo, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { createCancellation } from "../lib/cancellation";
import {
  accountUsageSummary,
  providerUsageRollup,
  type AccountUsageSummary,
  type ProviderUsageRollup,
  type UsageObservation,
} from "../model/usage-meter";
import {
  cloudLimits,
  decryptBytes,
  decryptUsageProjection,
  isDigest,
  isFiniteTimestamp,
  isOpaqueIdentifier,
  isRecord,
  isSafeNonNegativeInteger,
  parseEncryptedEnvelope,
  parseUsageEncryptedEnvelope,
  snapshotForeignJson,
  type EncryptedEnvelope,
  type UsageProjection,
} from "../oompa/cloud";
import { useServerClock } from "./devices";
import { usageListAccounts, usageListSnapshots } from "./functions";

/** How many daily observations the history view reads per account. */
export const usageHistoryLimit = 24;

export type UsageAccountRow = Readonly<{
  encryptedMetadata: EncryptedEnvelope;
  publicId: string;
  updatedAt: number;
}>;

export type UsageAccountMetadata = Readonly<{
  email: string;
  label: string;
  plan: string | null;
}>;

export type UsageSnapshotRow = Readonly<{
  digest: string;
  envelope: EncryptedEnvelope;
  observedAt: number;
  sourceRevision: number;
}>;

export function parseUsageAccountRow(input: unknown): UsageAccountRow | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (
    !isRecord(value)
    || !isOpaqueIdentifier(value.publicId)
    || !isFiniteTimestamp(value.updatedAt)
  ) return null;
  const encryptedMetadata = parseEncryptedEnvelope(
    value.encryptedMetadata,
    cloudLimits.metadataCiphertextCharacters,
  );
  if (encryptedMetadata === null) return null;
  return { encryptedMetadata, publicId: value.publicId, updatedAt: value.updatedAt };
}

export function parseUsageAccountPage(input: unknown): Readonly<{
  complete: boolean;
  rows: readonly UsageAccountRow[];
}> {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok || !Array.isArray(snapshot.value) || snapshot.value.length > cloudLimits.pageSize) {
    return { complete: false, rows: [] };
  }
  const rows = snapshot.value.map(parseUsageAccountRow);
  if (rows.some((row) => row === null)) return { complete: false, rows: [] };
  const parsed = rows as readonly UsageAccountRow[];
  if (new Set(parsed.map((row) => row.publicId)).size !== parsed.length) return { complete: false, rows: [] };
  // This endpoint has no continuation cursor. A full page cannot prove coverage.
  return { complete: parsed.length < cloudLimits.pageSize, rows: parsed };
}

export function parseUsageAccountRows(input: unknown): readonly UsageAccountRow[] {
  return parseUsageAccountPage(input).rows;
}

export function parseUsageAccountMetadata(input: unknown): UsageAccountMetadata | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok || !isRecord(snapshot.value)) return null;
  const value = snapshot.value;
  if (
    typeof value.label !== "string" || value.label.length > 160
    || typeof value.email !== "string" || value.email.length > 320
    || (value.plan !== null && (typeof value.plan !== "string" || value.plan.length > 160))
  ) return null;
  return { email: value.email, label: value.label, plan: value.plan };
}

export function parseUsageSnapshotRow(input: unknown): UsageSnapshotRow | null {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok) return null;
  const value = snapshot.value;
  if (
    !isRecord(value)
    || !isDigest(value.digest)
    || !isFiniteTimestamp(value.observedAt)
    || !isSafeNonNegativeInteger(value.sourceRevision)
  ) return null;
  const envelope = parseUsageEncryptedEnvelope(value.envelope);
  if (envelope === null) return null;
  return {
    digest: value.digest,
    envelope,
    observedAt: value.observedAt,
    sourceRevision: value.sourceRevision,
  };
}

export function parseUsageSnapshotRows(input: unknown): readonly UsageSnapshotRow[] {
  const snapshot = snapshotForeignJson(input);
  if (!snapshot.ok || !Array.isArray(snapshot.value) || snapshot.value.length > usageHistoryLimit) return [];
  const rows = snapshot.value.map(parseUsageSnapshotRow);
  // Dropping an invalid newest row would make an older report look current.
  return rows.some((row) => row === null) ? [] : rows as readonly UsageSnapshotRow[];
}

/** The daemon's private-JSON authority for an account's metadata envelope. */
export function usageAccountMetadataAad(input: Readonly<{
  accountPublicId: string;
  keyVersion: number;
  userPublicId: string;
}>): Uint8Array {
  return new TextEncoder().encode([
    "hra-control-plane-private-json:v1",
    "account_metadata",
    input.userPublicId,
    input.accountPublicId,
    String(input.keyVersion),
  ].join("\n"));
}

export type UsageAccountView = Readonly<{
  history: readonly UsageObservation[];
  metadata: UsageAccountMetadata | null;
  publicId: string;
  summary: AccountUsageSummary | null;
}>;

export type UsageOverview = Readonly<{
  complete: boolean;
  accounts: readonly UsageAccountView[];
  /** Codex rollup; the only provider with a hosted usage projection today. */
  codex: ProviderUsageRollup;
  loading: boolean;
  now: number;
  /** False until hosted time is anchored; ages and resets are not comparable before. */
  ready: boolean;
}>;

type DecryptedAccount = Readonly<{
  history: readonly UsageObservation[];
  metadata: UsageAccountMetadata | null;
}>;

/**
 * Every usage account on the hosted account with its recent observations.
 *
 * Decryption happens in one effect keyed on the account key and the rows, so
 * a key that is dropped mid-decrypt cancels the work and wipes its copy. An
 * unreadable snapshot stays unknown in its chronological position; failed metadata
 * leaves the account identified by its public id.
 */
export function useUsageOverview(): UsageOverview {
  const custody = useCustody();
  const serverClock = useServerClock();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const keyVersion = unlocked?.identity.keyVersion ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;

  const accountsValue = useQuery(usageListAccounts, { limit: cloudLimits.pageSize });
  const accountPage = useMemo(() => parseUsageAccountPage(accountsValue), [accountsValue]);
  const accountRows = accountPage.rows;
  const snapshotQueries = useMemo(
    () => Object.fromEntries(accountRows.map((row) => [
      row.publicId,
      { args: { accountPublicId: row.publicId, limit: usageHistoryLimit }, query: usageListSnapshots },
    ])),
    [accountRows],
  );
  const snapshotValues = useQueries(snapshotQueries);
  const snapshotRows = useMemo(
    () => new Map(accountRows.map((row) => {
      const value: unknown = snapshotValues[row.publicId];
      return [row.publicId, value === undefined || value instanceof Error ? null : parseUsageSnapshotRows(value)];
    })),
    [accountRows, snapshotValues],
  );

  const [decrypted, setDecrypted] = useState<Readonly<{
    key: Uint8Array;
    keyVersion: number;
    userPublicId: string;
    snapshotRows: typeof snapshotRows;
    accounts: ReadonlyMap<string, DecryptedAccount>;
  }> | null>(null);

  useEffect(() => {
    for (const value of Object.values(snapshotValues)) {
      if (value instanceof Error) report(value);
    }
  }, [report, snapshotValues]);

  useEffect(() => {
    if (key === null || keyVersion === null || userPublicId === null) {
      setDecrypted(null);
      return;
    }
    const run = createCancellation();
    const keyBytes = new Uint8Array(key);
    void (async () => {
      const next = new Map<string, DecryptedAccount>();
      for (const row of accountRows) {
        if (!run.live()) return;
        let metadata: UsageAccountMetadata | null = null;
        if (row.encryptedMetadata.keyVersion === keyVersion) {
          try {
            const plaintext = await decryptBytes(row.encryptedMetadata, keyBytes, usageAccountMetadataAad({
              accountPublicId: row.publicId,
              keyVersion,
              userPublicId,
            }));
            try {
              metadata = parseUsageAccountMetadata(JSON.parse(new TextDecoder().decode(plaintext)));
            } finally {
              plaintext.fill(0);
            }
          } catch (failure: unknown) {
            if (!run.live()) return;
            report(failure);
          }
        }
        const history: UsageObservation[] = [];
        for (const snapshot of snapshotRows.get(row.publicId) ?? []) {
          if (!run.live()) return;
          if (snapshot.envelope.keyVersion !== keyVersion) {
            history.push({ observedAt: snapshot.observedAt, projection: null });
            continue;
          }
          try {
            const projection: UsageProjection = await decryptUsageProjection(snapshot.envelope, keyBytes, {
              entityPublicId: row.publicId,
              keyVersion,
              kind: "usage",
              userPublicId,
            });
            history.push({ observedAt: snapshot.observedAt, projection });
          } catch (failure: unknown) {
            if (!run.live()) return;
            report(failure);
            history.push({ observedAt: snapshot.observedAt, projection: null });
          }
        }
        next.set(row.publicId, { history, metadata });
      }
      if (!run.live()) return;
      setDecrypted({ accounts: next, key, keyVersion, snapshotRows, userPublicId });
    })();
    return () => {
      run.cancel();
      keyBytes.fill(0);
    };
  }, [accountRows, key, keyVersion, report, snapshotRows, userPublicId]);

  const decryptedReady = decrypted !== null && decrypted.key === key
    && decrypted.keyVersion === keyVersion && decrypted.userPublicId === userPublicId
    && decrypted.snapshotRows === snapshotRows;
  const loading = accountsValue === undefined || !decryptedReady
    || Object.values(snapshotValues).some((value: unknown) => value === undefined);

  const accounts = useMemo<readonly UsageAccountView[]>(
    () => accountRows.map((row) => {
      const entry = decryptedReady ? decrypted.accounts.get(row.publicId) : undefined;
      const history = entry?.history ?? [];
      return {
        history,
        metadata: entry?.metadata ?? null,
        publicId: row.publicId,
        summary: serverClock.ready ? accountUsageSummary(history, serverClock.now) : null,
      };
    }),
    [accountRows, decrypted, decryptedReady, serverClock.now, serverClock.ready],
  );

  return {
    accounts,
    complete: accountPage.complete,
    codex: useMemo(() => providerUsageRollup(accounts.map((account) => account.summary), accountPage.complete), [accountPage.complete, accounts]),
    loading,
    now: serverClock.now,
    ready: serverClock.ready,
  };
}
