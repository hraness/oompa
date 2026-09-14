/**
 * Composer rules shared by the grid's start box and every card's follow-up
 * box. Pure functions, so `bun test ./app` covers them without a document.
 */

export const composerMinimumRows = 1;
export const composerMaximumRows = 8;

/**
 * How many rows a text area shows for its current value. The app's CSP refuses
 * inline styles, so the box cannot be sized from a measured scroll height;
 * counting lines is exact for hard breaks and a fair estimate for wrapped ones.
 */
export function composerRows(value: string, columns = 60): number {
  let rows = 0;
  for (const line of value.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / Math.max(20, columns)));
  }
  return Math.min(composerMaximumRows, Math.max(composerMinimumRows, rows));
}

export type ComposerKey = Readonly<{
  altKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}>;

/**
 * `Enter` sends; `Shift+Enter` breaks a line. A modifier other than Shift is
 * left to the browser, and an IME composition never sends mid-character.
 */
export function isComposerSubmitKey(event: ComposerKey): boolean {
  return event.key === "Enter"
    && !event.shiftKey
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
    && !event.isComposing;
}
