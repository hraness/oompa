import { describe, expect, test } from "bun:test";

import { composerMaximumRows, composerRows, isComposerSubmitKey } from "./composer";

const key = (overrides: Partial<Parameters<typeof isComposerSubmitKey>[0]>) => ({
  altKey: false,
  ctrlKey: false,
  isComposing: false,
  key: "Enter",
  metaKey: false,
  shiftKey: false,
  ...overrides,
});

describe("composerRows", () => {
  test("one row for an empty or short value", () => {
    expect(composerRows("")).toBe(1);
    expect(composerRows("ship it")).toBe(1);
  });
  test("one row per hard line break", () => {
    expect(composerRows("a\nb\nc")).toBe(3);
  });
  test("estimates wrapped rows from the column width", () => {
    expect(composerRows("x".repeat(130), 60)).toBe(3);
  });
  test("is bounded", () => {
    expect(composerRows("\n".repeat(40))).toBe(composerMaximumRows);
  });
});

describe("isComposerSubmitKey", () => {
  test("plain Enter sends", () => {
    expect(isComposerSubmitKey(key({}))).toBe(true);
  });
  test("Shift+Enter, other modifiers, composition and other keys do not", () => {
    expect(isComposerSubmitKey(key({ shiftKey: true }))).toBe(false);
    expect(isComposerSubmitKey(key({ metaKey: true }))).toBe(false);
    expect(isComposerSubmitKey(key({ ctrlKey: true }))).toBe(false);
    expect(isComposerSubmitKey(key({ altKey: true }))).toBe(false);
    expect(isComposerSubmitKey(key({ isComposing: true }))).toBe(false);
    expect(isComposerSubmitKey(key({ key: "a" }))).toBe(false);
  });
});
