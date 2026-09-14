/**
 * Archived sessions.
 *
 * `archived` lives in the encrypted session metadata alongside the name, so the
 * archived list is the decrypted metadata of the session heads the reader has
 * already paged in. The decrypt is cached by `publicId:metadataRevision`, so a
 * head that only moved its stream sequence is not decrypted again.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { decryptSessionMetadata, type SessionMetadataPayload } from "../oompa/cloud";
import { createCancellation } from "../lib/cancellation";
import { archivedSessionRows, type ArchivedSessionView } from "../model/settings-view";
import type { SessionHead } from "./wire";

export type SessionMetadataMap = ReadonlyMap<string, SessionMetadataPayload>;

function metadataKey(head: SessionHead): string {
  return `${head.publicId}:${head.metadataRevision}`;
}

/**
 * The decrypted metadata for a page of heads. Plaintext lives in this hook's
 * state and nowhere else: it is dropped with the account key, because the account
 * key going away re-runs the effect with a null key.
 */
export function useSessionMetadata(heads: readonly SessionHead[]): SessionMetadataMap {
  const custody = useCustody();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;
  const cache = useRef(new Map<string, SessionMetadataPayload>());
  const [metadata, setMetadata] = useState<SessionMetadataMap>(new Map());

  useEffect(() => {
    if (key === null || userPublicId === null) {
      cache.current = new Map();
      setMetadata(new Map());
      return;
    }
    const run = createCancellation();
    void (async () => {
      let changed = false;
      for (const head of heads) {
        const envelope = head.metadata;
        if (envelope === null) continue;
        const id = metadataKey(head);
        if (cache.current.has(id)) continue;
        try {
          cache.current.set(id, await decryptSessionMetadata(envelope, key, {
            entityPublicId: head.publicId,
            keyVersion: envelope.keyVersion,
            kind: "session_metadata",
            userPublicId,
          }));
          changed = true;
        } catch (failure: unknown) {
          report(failure);
        }
      }
      if (!changed || !run.live()) return;
      setMetadata(new Map(heads.flatMap((head) => {
        const payload = cache.current.get(metadataKey(head));
        return payload === undefined ? [] : [[head.publicId, payload] as const];
      })));
    })();
    return () => { run.cancel(); };
  }, [heads, key, report, userPublicId]);

  return metadata;
}

/** The archived rows of a page of heads, newest first, labelled by machine. */
export function useArchivedSessions(
  heads: readonly SessionHead[],
  machineLabels: ReadonlyMap<string, string>,
): readonly ArchivedSessionView[] {
  const metadata = useSessionMetadata(heads);
  return useMemo(() => archivedSessionRows(
    heads.map((head) => ({
      executionDevicePublicId: head.executionDevicePublicId,
      metadata: metadata.get(head.publicId) ?? null,
      publicId: head.publicId,
      updatedAt: head.updatedAt,
    })),
    machineLabels,
  ), [heads, machineLabels, metadata]);
}
