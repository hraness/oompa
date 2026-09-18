import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  authoritySupervisorBuildCommand,
  parseAuthoritySupervisorBuildVerifierArguments,
} from "./verify-authority-supervisor-build";

describe("authority supervisor build verifier", () => {
  test("constructs the exact pinned rustc static-musl build command", () => {
    expect(authoritySupervisorBuildCommand(
      "/opt/rust/rustc",
      "x86_64-linux-musl",
      "scripts/authority-supervisor.rs",
      "scripts/authority-supervisor.ld",
      "/temporary/x64",
    )).toEqual([
      "/opt/rust/rustc",
      "--edition",
      "2021",
      "-O",
      "-C",
      "overflow-checks=on",
      "-C",
      "debug-assertions=on",
      "-C",
      "strip=symbols",
      "-C",
      "panic=abort",
      "-C",
      "linker=rust-lld",
      "-C",
      "link-arg=-T",
      "-C",
      "link-arg=scripts/authority-supervisor.ld",
      "--target",
      "x86_64-unknown-linux-musl",
      "scripts/authority-supervisor.rs",
      "-o",
      "/temporary/x64",
    ]);
    expect(authoritySupervisorBuildCommand(
      "/opt/rust/rustc",
      "aarch64-linux-musl",
      "scripts/authority-supervisor.rs",
      "scripts/authority-supervisor.ld",
      "/temporary/arm64",
    )).toContain("aarch64-unknown-linux-musl");
  });

  test("requires one explicit absolute rustc executable", () => {
    expect(parseAuthoritySupervisorBuildVerifierArguments([
      "--rustc",
      "/opt/rust/rustc",
    ])).toEqual({ rustcExecutable: "/opt/rust/rustc" });
    for (const arguments_ of [
      [],
      ["--rustc"],
      ["--rustc", "rustc"],
      ["--compiler", "/opt/rust/rustc"],
      ["--rustc", "/opt/rust/rustc", "--extra"],
    ]) {
      expect(() => parseAuthoritySupervisorBuildVerifierArguments(arguments_)).toThrow(
        "authority_supervisor_build_usage_invalid",
      );
    }
  });

  test("installs the pinned Rust toolchain and rebuilds the checked-in artifacts in CI", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(workflow).toContain("rustup toolchain install 1.97.1");
    expect(workflow).toContain("--target x86_64-unknown-linux-musl");
    expect(workflow).toContain("--target aarch64-unknown-linux-musl");
    expect(workflow).toContain("rustup which --toolchain 1.97.1 rustc");
    expect(workflow).toMatch(/verify-authority-supervisor-build\.ts\s+--rustc/u);
    expect(workflow).not.toContain("ziglang.org");
    expect(workflow).not.toContain("setup-zig");
    // The runtime custody test runs once, inside the remainder's scripts suite.
    expect(workflow).not.toContain("authority-supervisor-runtime.test.ts");
    const packageScripts = (JSON.parse(await readFile(
      join(import.meta.dir, "..", "package.json"),
      "utf8",
    )) as { scripts: Record<string, string> }).scripts;
    expect(packageScripts.check).toContain("bun run test");
    expect(packageScripts.test).toContain("bun test ./scripts --isolate --max-concurrency=1");
    // The remainder lane is split: the scripts suite (and with it the
    // runtime custody test) runs inside check:ci-remainder-suites.
    expect(packageScripts["check:ci-remainder"])
      .toContain("bun run check:ci-remainder-checks");
    expect(packageScripts["check:ci-remainder"])
      .toContain("bun run check:ci-remainder-suites");
    expect(packageScripts["check:ci-remainder-suites"])
      .toContain("bun test ./scripts --isolate --max-concurrency=1");
    expect(packageScripts["test:source"]).toBe("bun test ./src --isolate --max-concurrency=1");
    const enable = workflow.indexOf(
      "sudo /usr/sbin/sysctl --write kernel.apparmor_restrict_unprivileged_userns=0",
    );
    const probe = workflow.indexOf(
      "/usr/bin/unshare --user --map-root-user --fork /usr/bin/true",
    );
    const sourceGates = [1, 2, 3, 4, 5, 6].map((shard) => workflow.indexOf(`bun run test:source --shard=${shard}/6`));
    const remainderGate = workflow.indexOf("bun run check:ci-remainder");
    const restore = workflow.indexOf(
      "sudo /usr/sbin/sysctl --write kernel.apparmor_restrict_unprivileged_userns=1",
    );
    expect(enable).toBeGreaterThan(-1);
    expect(enable).toBeLessThan(probe);
    for (const sourceGate of sourceGates) {
      expect(sourceGate).toBeGreaterThan(-1);
      expect(probe).toBeLessThan(sourceGate);
      expect(sourceGate).toBeLessThan(restore);
    }
    expect(remainderGate).toBeGreaterThan(-1);
    expect(probe).toBeLessThan(remainderGate);
    expect(remainderGate).toBeLessThan(restore);
  });
});
