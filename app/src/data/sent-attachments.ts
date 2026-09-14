/**
 * The bytes this tab still holds from its own send.
 *
 * A projected `user_message` carries a manifest, never bytes: the compact
 * stream is a bounded projection and an image in it would blow the chunk budget
 * and put reader-supplied bytes into sync. So the transcript can only ever show
 * a real thumbnail for an attachment this tab sent itself, in this tab, before a
 * reload. Everything else renders as a chip.
 *
 * Nothing here persists. The map lives for the life of the tab, holds at most
 * `maximumHeldAttachments` blob URLs, and evicts the oldest, so a long session
 * cannot grow it without bound. There is no `localStorage`, no `IndexedDB`, and
 * no upload: `URL.createObjectURL` mints a same-tab handle to bytes the page
 * already has, which is exactly what `img-src blob:` allows and nothing more.
 */
export const maximumHeldAttachments = 24;

const held = new Map<string, string>();

/** Keeps the bytes of one just-sent attachment, addressed by its digest. */
export function holdSentAttachment(input: Readonly<{
  bytes: Uint8Array;
  digest: string;
  mediaType: string;
}>): void {
  if (held.has(input.digest) || typeof URL.createObjectURL !== "function") return;
  while (held.size >= maximumHeldAttachments) {
    const oldest = held.keys().next();
    if (oldest.done === true) break;
    const url = held.get(oldest.value);
    if (url !== undefined) URL.revokeObjectURL(url);
    held.delete(oldest.value);
  }
  const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mediaType });
  held.set(input.digest, URL.createObjectURL(blob));
}

/** The blob URL for bytes this tab holds, or null. */
export function heldAttachmentUrl(digest: string): string | null {
  return held.get(digest) ?? null;
}

/** Drops everything, revoking each handle. Used when the account key is dropped. */
export function releaseHeldAttachments(): void {
  for (const url of held.values()) URL.revokeObjectURL(url);
  held.clear();
}
