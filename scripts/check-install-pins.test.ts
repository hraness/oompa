import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCommittedInstallPinsForRelease,
  readInstallPins,
  releasePinDrift,
  updateInstallPins,
  updateInstallPinsForRelease,
  workingTreePinDrift,
} from "./check-install-pins";

const repositoryRoot = new URL("..", import.meta.url).pathname;

describe("installer pins", () => {
  test("the working tree's CLI and normalizer digests match the embedded pins", async () => {
    expect(workingTreePinDrift(await readInstallPins(repositoryRoot))).toEqual([]);
  });

  test("release consistency requires the tagged runtime bytes and matching URLs", async () => {
    const report = await readInstallPins(repositoryRoot);
    const consistent = { ...report, runtime: { publicCommand: report.runtime.actual, actual: report.runtime.actual } };
    const drift = releasePinDrift(consistent, "v0.8.3", "0.8.3");
    expect(drift).toEqual([]);
    expect(releasePinDrift(report, "v0.8.3", "0.8.3").some((line) => line.includes("public command digest") || line.includes("is not the public command digest") || line.length === 0)).toBe(report.runtime.publicCommand !== report.runtime.actual);
    expect(releasePinDrift(consistent, "v0.1.8", "0.8.3")).toContain("release tag v0.1.8 does not match package.json version 0.8.3");
    for (const priorTag of ["v0.7.0", "v0.7.1", "v0.8.0"]) {
      expect(releasePinDrift(consistent, priorTag, "0.8.3"))
        .toContain(`release tag ${priorTag} does not match package.json version 0.8.3`);
    }
    expect(() => releasePinDrift(consistent, "0.8.3", "0.8.3")).toThrow();
  });

  test("working-tree drift names the file and both digests", () => {
    const report = {
      cli: {
        expected: "a".repeat(64),
        runtimeExpected: "b".repeat(64),
        actual: "c".repeat(64),
      },
      normalizer: { expected: "c".repeat(64), actual: "c".repeat(64) },
      runtime: { publicCommand: "d".repeat(64), actual: "e".repeat(64) },
    };
    expect(workingTreePinDrift(report)).toEqual([
      `src/cli.ts digest ${"c".repeat(64)} is not the pinned ${"a".repeat(64)}`,
      `src/cli.ts digest ${"c".repeat(64)} is not the runtime pin ${"b".repeat(64)}`,
    ]);
  });

  test("release proof validates immutable commit sources and both embedded CLI pins", () => {
    const digest = (source: string) => createHash("sha256").update(source).digest("hex");
    const cli = "export const cli = true;\n";
    const cliDigest = digest(cli);
    const normalizer = `export const OOMPA_INSTALL_CLI_SHA256 = "${cliDigest}";\n`;
    const normalizerDigest = digest(normalizer);
    const runtime = [
      `export const OOMPA_INSTALL_CLI_SHA256 = "${cliDigest}";`,
      `export const OOMPA_INSTALL_NORMALIZER_SHA256 = "${normalizerDigest}";`,
      "export const OOMPA_INSTALL_ARCHIVE_URL = \"https://github.com/hraness/oompa/releases/download/v0.6.1/hraness-oompa-0.6.1.tgz\";",
      "",
    ].join("\n");
    const runtimeDigest = digest(runtime);
    const sources = {
      cli,
      manifest: JSON.stringify({ name: "@hraness/oompa", version: "0.6.1" }),
      normalizer,
      preflight: [
        "export const OOMPA_INSTALL_PREFLIGHT_SOURCE_URL = \"https://raw.githubusercontent.com/hraness/oompa/v0.6.1/src/install-preflight-runtime.ts\";",
        `export const OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256 = "${runtimeDigest}";`,
        "",
      ].join("\n"),
      runtime,
    };
    expect(() => assertCommittedInstallPinsForRelease(sources, "v0.6.1")).not.toThrow();
    expect(() => assertCommittedInstallPinsForRelease({
      ...sources,
      runtime: sources.runtime.replace(cliDigest, "f".repeat(64)),
    }, "v0.6.1")).toThrow("runtime pin");
  });

  test("release preparation alone moves the public runtime digest after inner pins converge", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "oompa-release-pins-"));
    await mkdir(join(fixture, "src"));
    for (const path of [
      "package.json",
      "src/cli.ts",
      "src/install-normalizer.ts",
      "src/install-preflight-runtime.ts",
      "src/install-preflight.ts",
    ]) {
      await copyFile(join(repositoryRoot, path), join(fixture, path));
    }
    const preflightPath = join(fixture, "src/install-preflight.ts");
    const ordinaryBefore = await readFile(preflightPath, "utf8");
    const current = await readInstallPins(repositoryRoot);
    const replacementDigest = current.runtime.publicCommand === "f".repeat(64)
      ? "e".repeat(64)
      : "f".repeat(64);
    const report = {
      cli: {
        actual: "a".repeat(64),
        expected: "a".repeat(64),
        runtimeExpected: "a".repeat(64),
      },
      normalizer: { actual: "b".repeat(64), expected: "b".repeat(64) },
      runtime: {
        actual: replacementDigest,
        publicCommand: current.runtime.publicCommand,
      },
    };

    await updateInstallPins(fixture, {
      hashFile: async () => report.normalizer.actual,
      readPins: async () => report,
    });
    expect(await readFile(preflightPath, "utf8")).toBe(ordinaryBefore);

    expect(report.runtime.actual).not.toBe(report.runtime.publicCommand);
    expect(await updateInstallPinsForRelease(fixture, "v0.8.3", {
      readPins: async () => report,
    }))
      .toEqual(["src/install-preflight.ts: replaced 1 public runtime digest site for v0.8.3"]);
    const prepared = await readFile(preflightPath, "utf8");
    expect(prepared).toContain(report.runtime.actual);
    expect(prepared).not.toContain(report.runtime.publicCommand);
  });
});
