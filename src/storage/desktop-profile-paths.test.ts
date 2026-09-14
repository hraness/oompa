import { describe, expect, test } from "bun:test";

import { deriveDesktopProfilePaths } from "./desktop-profile-paths.ts";

describe("desktop profile paths", () => {
  test("derives separate full profile boundaries", () => {
    expect(deriveDesktopProfilePaths("/tmp/hra-control-plane", "personal-2")).toEqual({
      profileRoot: "/tmp/hra-control-plane/profiles/personal-2",
      codexHome: "/tmp/hra-control-plane/profiles/personal-2/codex-home",
      desktopUserData: "/tmp/hra-control-plane/profiles/personal-2/desktop-user-data",
    });
  });

  test.each(["../escape", "a/b", "UPPER", "", ".", "-bad", "bad-"])(
    "rejects unsafe profile component %s",
    (profileId) => {
      expect(() => deriveDesktopProfilePaths("/tmp/hra-control-plane", profileId)).toThrow(
        "INVALID_PROFILE",
      );
    },
  );

  test("rejects a relative or unnormalized state root", () => {
    expect(() => deriveDesktopProfilePaths("relative/root", "personal")).toThrow("INVALID_PROFILE");
    expect(() => deriveDesktopProfilePaths("/tmp/../tmp/x", "personal")).toThrow("INVALID_PROFILE");
  });
});
