import { useConvex } from "convex/react";
import { useEffect, useState } from "react";

import { useCustody } from "../custody/custody-context";
import { pageSize } from "../env";
import { decryptCompactEvents, type CompactSessionEvent } from "../oompa/cloud";
import { createCancellation } from "../lib/cancellation";
import { chunkAuthority } from "./chunks";
import { getChunks } from "./functions";
import { parseSessionChunks } from "./wire";

type CacheEntry = Readonly<{
  events: readonly CompactSessionEvent[];
  lastSequence: number;
}>;

/**
 * Decrypted compact history, cached for the life of the tab and nowhere else.
 * The cache is keyed by session and account key version so a key rotation or a
 * sign-out with a different account never serves stale plaintext, and it is
 * cleared whenever the account key is dropped.
 */
const cache = new Map<string, CacheEntry>();

export function clearCompactHistoryCache(): void {
  cache.clear();
}

function cacheKey(sessionPublicId: string, userPublicId: string, keyVersion: number): string {
  return `${userPublicId}:${keyVersion}:${sessionPublicId}`;
}

export type CompactHistory = Readonly<{
  error: string | null;
  events: readonly CompactSessionEvent[];
  loading: boolean;
}>;

/**
 * Walks `sessions:getChunks` on the compact stream from the cached cursor,
 * decrypts each page, and folds it into the tab-local cache. The walk is
 * imperative rather than a subscription: history is append only and bounded by
 * the head sequence, so one pass per mount plus the live tail is enough.
 */
export function useCompactHistory(sessionPublicId: string | null): CompactHistory {
  const custody = useCustody();
  const convex = useConvex();
  const [events, setEvents] = useState<readonly CompactSessionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unlocked = custody.state === "unlocked" ? custody : null;
  const key = unlocked?.key ?? null;
  const userPublicId = unlocked?.identity.userPublicId ?? null;
  const keyVersion = unlocked?.identity.keyVersion ?? null;
  const report = custody.reportAuthorityFailure;

  useEffect(() => {
    if (sessionPublicId === null || key === null || userPublicId === null || keyVersion === null) {
      setEvents([]);
      return;
    }
    const id = cacheKey(sessionPublicId, userPublicId, keyVersion);
    const run = createCancellation();
    setError(null);
    setLoading(true);
    void (async () => {
      try {
        let entry = cache.get(id) ?? { events: [], lastSequence: 0 };
        setEvents(entry.events);
        for (;;) {
          const page = parseSessionChunks(await convex.query(getChunks, {
            afterSequence: entry.lastSequence,
            limit: pageSize,
            sessionPublicId,
            stream: "compact",
          }));
          if (page.length === 0) break;
          const decoded: CompactSessionEvent[] = [];
          for (const chunk of page) {
            const batch = await decryptCompactEvents(
              chunk.envelope,
              key,
              chunkAuthority({ chunk, sessionPublicId, userPublicId }),
            );
            decoded.push(...batch);
          }
          const last = page.at(-1);
          if (last === undefined) break;
          entry = {
            events: [...entry.events, ...decoded],
            lastSequence: last.lastSequence,
          };
          cache.set(id, entry);
          if (!run.live()) return;
          setEvents(entry.events);
          if (page.length < pageSize) break;
        }
      } catch (failure: unknown) {
        report(failure);
        if (run.live()) setError(failure instanceof Error ? failure.message : "History is unavailable.");
      } finally {
        if (run.live()) setLoading(false);
      }
    })();
    return () => { run.cancel(); };
  }, [convex, key, keyVersion, report, sessionPublicId, userPublicId]);

  return { error, events, loading };
}
