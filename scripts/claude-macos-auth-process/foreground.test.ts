import { expect, test } from "bun:test";
import fc from "fast-check";

import { allowlistedEnvironment } from "../../src/claude/process";
import { assertForegroundLoginRequest, manualBrowserEnvironment } from "./foreground";

const expected = { executablePath: "/synthetic-fixture", environment: { HOME: "/owner", CLAUDE_CONFIG_DIR: "/private-config" } };
const request = { argv: ["/synthetic-fixture", "auth", "login", "--claudeai"], environment: expected.environment, stdin: 0, stdout: 1, stderr: 2 };

test("foreground qualification admits only the exact login, environment and owner descriptors", () => {
  expect(() => assertForegroundLoginRequest(expected, request)).not.toThrow();
  for (const value of [null, [], {}, { ...request, extra: true }, { ...request, stdin: 3 }, { ...request, stdout: 2 }, { ...request, stderr: 1 },
    { ...request, argv: ["/synthetic-fixture", "auth", "login"] }, { ...request, argv: [...request.argv, "--help"] },
    { ...request, argv: ["/synthetic-fixture", "auth", "logout", "--claudeai"] }, { ...request, environment: { ...expected.environment, EXTRA: "refused" } },
    { ...request, environment: { HOME: "/another", CLAUDE_CONFIG_DIR: "/private-config" } }]) {
    expect(() => assertForegroundLoginRequest(expected, value)).toThrow("foreground_request_refused");
  }
});

test("manual-browser qualification changes only the actual child opener and never admits ambient browser commands", () => {
  const ambient = { ...expected.environment, BROWSER: "/untrusted/browser --reuse-session", CLAUDE_BG_RENDEZVOUS_SOCK: "/untrusted/browser-overrides" };
  const base = { ...allowlistedEnvironment(ambient), CLAUDE_CONFIG_DIR: expected.environment.CLAUDE_CONFIG_DIR };
  expect(Object.hasOwn(base, "BROWSER")).toBeFalse();
  expect(Object.hasOwn(base, "CLAUDE_BG_RENDEZVOUS_SOCK")).toBeFalse();
  expect(manualBrowserEnvironment(base)).toEqual({ ...base, BROWSER: "/usr/bin/true" });
  expect(Object.isFrozen(manualBrowserEnvironment(base))).toBeTrue();
  expect(() => manualBrowserEnvironment(ambient)).toThrow("foreground_request_refused");
  expect(() => assertForegroundLoginRequest(expected, { ...request, environment: { ...expected.environment, BROWSER: "/usr/bin/true" } })).toThrow();
  expect(Object.hasOwn(expected.environment, "BROWSER")).toBeFalse();
});

test("foreign argv substitutions cannot expand the foreground operation", () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 3 }), fc.string(), (index, content) => {
    fc.pre(content !== request.argv[index]);
    const argv = [...request.argv]; argv[index] = content;
    expect(() => assertForegroundLoginRequest(expected, { ...request, argv })).toThrow("foreground_request_refused");
  }), { numRuns: 100, seed: 20260911 });
});
