import { useEffect, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { decryptSessionMetadata, type SessionMetadataPayload } from "../oompa/cloud";
import { createCancellation } from "../lib/cancellation";
import type { SessionHead } from "./wire";

export type SessionMetadata = Readonly<{
  archived: boolean;
  name: string | null;
  note: string | null;
}>;

export const emptySessionMetadata: SessionMetadata = Object.freeze({
  archived: false,
  name: null,
  note: null,
});

/**
 * Decrypted session metadata, cached for the life of the tab and nowhere else.
 *
 * The grid decrypts every head's metadata to learn its name and whether it is
 * archived, and the open session decrypts the same envelope again for its
 * header. The cache is keyed by the account, the key version, the session, and
 * the metadata revision, so a rename or an archive produces a new key rather
 * than a stale hit, and a sign-out under a different account can never serve the
 * previous one's plaintext. `clearSessionMetadataCache` runs whenever custody
 * locks.
 */
const cache = new Map<string, SessionMetadata>();

export function clearSessionMetadataCache(): void {
  cache.clear();
}

function cacheKey(input: Readonly<{
  keyVersion: number;
  metadataRevision: number;
  sessionPublicId: string;
  userPublicId: string;
}>): string {
  return [
    input.userPublicId,
    String(input.keyVersion),
    input.sessionPublicId,
    String(input.metadataRevision),
  ].join(":");
}

function toMetadata(payload: SessionMetadataPayload): SessionMetadata {
  return {
    archived: payload.archived ?? false,
    name: payload.name,
    note: payload.note,
  };
}

export function useSessionMetadata(head: SessionHead | null): SessionMetadata {
  const custody = useCustody();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const report = custody.reportAuthorityFailure;

  const envelope = head?.metadata ?? null;
  const publicId = head?.publicId ?? null;
  const metadataRevision = head?.metadataRevision ?? 0;

  const [metadata, setMetadata] = useState<SessionMetadata>(emptySessionMetadata);

  useEffect(() => {
    if (envelope === null || key === null || userPublicId === null || publicId === null) {
      setMetadata(emptySessionMetadata);
      return;
    }
    const id = cacheKey({
      keyVersion: envelope.keyVersion,
      metadataRevision,
      sessionPublicId: publicId,
      userPublicId,
    });
    const hit = cache.get(id);
    if (hit !== undefined) {
      setMetadata(hit);
      return;
    }
    const run = createCancellation();
    void decryptSessionMetadata(envelope, key, {
      entityPublicId: publicId,
      keyVersion: envelope.keyVersion,
      kind: "session_metadata",
      userPublicId,
    })
      .then((payload) => {
        const value = toMetadata(payload);
        cache.set(id, value);
        if (run.live()) setMetadata(value);
      })
      .catch((failure: unknown) => {
        report(failure);
        if (run.live()) setMetadata(emptySessionMetadata);
      });
    return () => { run.cancel(); };
  }, [envelope, key, metadataRevision, publicId, report, userPublicId]);

  return metadata;
}
