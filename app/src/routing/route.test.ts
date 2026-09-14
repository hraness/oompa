import { describe, expect, test } from "bun:test";

import { parseRoute, routeHash, sameRoute } from "./route";

const sessionId = "0199aaaabbbbccccddddeeeeffff0000";

describe("parseRoute", () => {
  test("reads the routes", () => {
    expect(parseRoute("#/")).toEqual({ kind: "grid" });
    expect(parseRoute("#/settings")).toEqual({ kind: "settings", section: null });
    expect(parseRoute("#/settings/usage")).toEqual({ kind: "settings", section: "usage" });
  });

  test("accepts a fragment with or without its hash and with stray slashes", () => {
    expect(parseRoute("")).toEqual({ kind: "grid" });
    expect(parseRoute("#")).toEqual({ kind: "grid" });
    expect(parseRoute("/settings")).toEqual({ kind: "settings", section: null });
    expect(parseRoute("#//settings//")).toEqual({ kind: "settings", section: null });
  });

  test("falls back to the grid rather than rendering nothing", () => {
    for (const hash of [
      "#/unknown",
      "#/session",
      "#/session//",
      "#/settings/extra",
      "#/settings/usage/extra",
      "#/session/a/b",
    ]) {
      expect(parseRoute(hash)).toEqual({ kind: "grid" });
    }
  });

  test("an old conversation link lands on the grid, where the card now lives", () => {
    expect(parseRoute(`#/session/${sessionId}`)).toEqual({ kind: "grid" });
    for (const id of ["../../etc", "not a session", "a".repeat(300), "<script>"]) {
      expect(parseRoute(`#/session/${id}`)).toEqual({ kind: "grid" });
    }
  });
});

describe("routeHash", () => {
  test("round trips every route", () => {
    for (const route of [
      { kind: "grid" } as const,
      { kind: "settings", section: null } as const,
      { kind: "settings", section: "usage" } as const,
    ]) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
  });

  test("compares routes by their fragment", () => {
    expect(sameRoute({ kind: "settings", section: null }, { kind: "settings", section: null })).toBe(true);
    expect(sameRoute({ kind: "settings", section: "usage" }, { kind: "settings", section: null })).toBe(false);
    expect(sameRoute({ kind: "settings", section: null }, { kind: "grid" })).toBe(false);
  });
});
