import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import manifest from "../package.json";
import {
  assertPackageContent,
  assertPackageContentAt,
  packageAdmissionNotice,
  packageDaemonNotice,
  packageDescription,
  packageInstallCommand,
  packageInstallPrerequisite,
} from "./package-content";

const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

describe("independently authored package content", () => {
  test("admits the actual technical package README and manifest without rewriting either", async () => {
    expect(() => assertPackageContent(manifest, readme)).not.toThrow();
    await assertPackageContentAt(join(import.meta.dir, ".."));
    expect(await readFile(new URL("../README.md", import.meta.url), "utf8")).toBe(readme);
    expect(manifest.description).toBe(packageDescription);
    expect(readme.split("\n")[0]).toBe("# Oompa");
    expect(readme).toContain("The local CLI does not need an Oompa cloud identity.");
    expect(readme).toContain("optional encrypted sync");
    expect(readme).toContain("Codex execution supports macOS and Linux; Claude Code execution supports Linux.");
  });

  test("retains release admission, startup, privacy, and command-order contracts", () => {
    expect(readme).toContain("Local CLI v0.8.3 passed immutable GitHub and exact-byte npm release admission.");
    expect(readme).toContain("https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v083-artifacts");
    expect(readme).toContain("https://github.com/hraness/oompa/releases/tag/v0.8.3");
    expect(readme).toContain("https://github.com/hraness/oompa/actions/runs/35066335703");
    expect(readme).toContain(packageAdmissionNotice);
    expect(readme.indexOf(packageAdmissionNotice)).toBeLessThan(readme.indexOf(packageInstallCommand));
    expect(readme.indexOf("Local CLI v0.8.3 passed immutable GitHub and exact-byte npm release admission.")).toBeLessThan(readme.indexOf(packageInstallCommand));
    expect(readme.indexOf(packageInstallPrerequisite)).toBeLessThan(readme.indexOf(packageInstallCommand));
    expect(readme.indexOf(packageInstallCommand)).toBeLessThan(readme.indexOf("\noompa doctor --offline\n"));
    expect(readme).toContain(packageDaemonNotice);
    expect(readme.indexOf(packageDaemonNotice)).toBeLessThan(readme.indexOf("oompa session start personal --provider codex --json"));
    expect(readme).toContain("[Availability](https://oompa.app/docs/status/)");
    expect(readme).toContain("[ordered update runbook](https://oompa.app/docs/status/#install-and-update)");
    expect(readme).toContain("https://github.com/hraness/oompa/blob/main/PRIVACY.md");
    expect(readme).toContain("Oompa is maintained by [Hraness](https://hraness.com/) and published under the MIT license.");
    expect(readme.match(/Oompa is maintained by/gu)).toHaveLength(1);
    expect(readme).not.toContain("short for harness");
    expect(readme).not.toContain("invite-only beta");
    expect(readme).not.toContain("\u2014");
    expect(manifest.description).not.toContain("\u2014");
    for (const excluded of [
      "v0.7.1 candidate", "v0.8.3 artifacts admitted", "## Command reference\n",
      "### Update runbook\n", "## First account\n", "## Privacy\n", "\nhra init --yes\n",
      "/reading/deepseek-harness/", "/reading/hax/", "/reading/headlong-microharness/", "/reading/oracle-and-firm/",
    ]) expect(readme).not.toContain(excluded);
  });

  test("rejects omitted, reordered, or falsely admitted command prerequisites", () => {
    for (const prerequisite of [packageAdmissionNotice, packageInstallPrerequisite, packageDaemonNotice]) {
      expect(() => assertPackageContent(manifest, readme.replace(prerequisite, "")))
        .toThrow("missing its technical identity");
      expect(() => assertPackageContent(manifest, readme.replace(prerequisite, "") + prerequisite + "\n"))
        .toThrow("before its prerequisite");
    }
    for (const claim of [
      "The v0.8.1 npm mirror is admitted.",
      "Install and verify the admitted v0.8.1 CLI artifact",
      "v0.8.1 artifacts admitted", "v0.8.1 is the fully admitted public artifact",
      "The v0.8.3 candidate is not yet admitted", "The v0.8.3 npm mirror is not admitted",
      "Daemon rollout is available", "Hosted command writers are enabled",
      "The v0.7.1 candidate is not yet admitted",
    ]) expect(() => assertPackageContent(manifest, readme + claim + "\n")).toThrow("conflicting release claim");
  });

  test("requires the current exact GitHub and npm admission evidence", () => {
    for (const required of [
      "https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v083-artifacts",
      "https://github.com/hraness/oompa/releases/tag/v0.8.3",
      "https://github.com/hraness/oompa/actions/runs/35066335703",
      "Local CLI v0.8.3 passed immutable GitHub and exact-byte npm release admission.",
    ]) {
      expect(() => assertPackageContent(manifest, readme.replaceAll(required, "")))
        .toThrow("missing its technical identity");
    }
  });

  test("never transfers the exact package content contract to another version or identity", () => {
    for (const version of ["0.7.0", "0.7.1", "0.7.2", "0.8.0", "0.8.1", "v0.8.3", "0.8.3-beta.1", ""]) {
      expect(() => assertPackageContent({ ...manifest, version }, readme)).toThrow();
    }
    for (const name of ["oompa", ["@", "other", "/oompa"].join(""), ""]) {
      expect(() => assertPackageContent({ ...manifest, name }, readme)).toThrow();
    }
    for (const value of [null, [], true, 1, {}, "manifest"]) {
      expect(() => assertPackageContent(value, readme)).toThrow();
      expect(() => assertPackageContent(manifest, value)).toThrow();
    }
    expect(() => assertPackageContent(manifest, readme + "a".repeat(64 * 1024))).toThrow();
    expect(() => assertPackageContent(manifest, readme + "界".repeat(24 * 1024))).toThrow();
  });

  test("rejects every sampled description drift and exact installer-byte mutation", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 64 }), (suffix) => {
      expect(() => assertPackageContent({ ...manifest, description: packageDescription + suffix }, readme)).toThrow();
    }), { seed: 20_260_910, numRuns: 32 });
    fc.assert(fc.property(fc.integer({ min: 0, max: packageInstallCommand.length - 1 }), (index) => {
      const modified = packageInstallCommand.slice(0, index) + "\u0000" + packageInstallCommand.slice(index + 1);
      expect(() => assertPackageContent(manifest, readme.replace(packageInstallCommand, modified)))
        .toThrow("missing its technical identity");
    }), { seed: 20_260_911, numRuns: 32 });
  });

  test("checks a package-only tree with no website inputs and preserves rejected bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hra-package-content-"));
    try {
      await writeFile(join(root, "package.json"), JSON.stringify(manifest));
      await writeFile(join(root, "README.md"), readme);
      await assertPackageContentAt(root);
      const rejected = readme.replace(packageAdmissionNotice, "");
      await writeFile(join(root, "README.md"), rejected);
      await expect(assertPackageContentAt(root)).rejects.toThrow("missing its technical identity");
      expect(await readFile(join(root, "README.md"), "utf8")).toBe(rejected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps package admission and both producers independent of site rendering", async () => {
    const source = await readFile(new URL("./package-content.ts", import.meta.url), "utf8");
    const imports = new Bun.Transpiler({ loader: "ts" }).scan(source).imports.map(({ path }) => path);
    expect(imports).toEqual(["node:fs/promises", "node:path", "zod", "../src/install-preflight"]);
    const local = await readFile(new URL("./check-package.ts", import.meta.url), "utf8");
    const release = await readFile(new URL("./check-release-package.ts", import.meta.url), "utf8");
    expect(local).toContain("await assertPackageContentAt(repositoryRoot)");
    expect(local).toContain('await assertPackageContentAt(join(inspectionDirectory, "package"))');
    expect(local).not.toContain('"build:site"');
    expect(release).toContain("await assertPackageContentAt(repositoryRoot)");
  });
});
