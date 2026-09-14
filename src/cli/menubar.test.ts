import { describe, expect, test } from "bun:test";

import { installedMenubarBinary, launchAgentContents, menubarLaunchAgentPath } from "./menubar";

describe("menu-bar install contract", () => {
  test("uses stable user paths", () => {
    const env = { HOME: "/Users/example" };
    expect(installedMenubarBinary(env)).toBe("/Users/example/Library/Application Support/Oompa/bin/oompa-menubar");
    expect(menubarLaunchAgentPath(env)).toBe("/Users/example/Library/LaunchAgents/com.hraness.oompa.menubar.plist");
  });

  test("launch agent runs one prebuilt binary at login without KeepAlive", () => {
    const plist = launchAgentContents("/Users/example/Library/Application Support/Oompa/bin/oompa-menubar");
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<true/>");
    expect(plist).toContain("oompa-menubar");
    expect(plist).not.toContain("KeepAlive");
    expect(plist).not.toContain("cargo");
  });
});
