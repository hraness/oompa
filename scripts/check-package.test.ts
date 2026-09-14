import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { DaemonAuthorityReceipt } from "../src/daemon/daemon-lock";
import type { DaemonIdentity } from "../src/daemon/daemon-startup";
import {
  assertCompleteGitHistoryPublic,
  assertGitHistoryPatchPublicText,
  buildGitHistoryEnvironment,
  gitHistoryCommandArguments,
  normalizeGitHistoryPatchForPublicScan,
  stripGitHunkSectionHeadingsForScopeScan,
  normalizeReviewedSyntheticHistoryPatch,
  normalizeReviewedSyntheticPackagePatch,
  packageDependencyCacheDiscoveryEnvironment,
  parsePackageDependencyCache,
  parseGitHistoryCommitList,
  projectGitHistorySpawnResult,
  requireGitHistoryOutput,
  runPackageCommand,
  selectReviewedGitHistoryPatchEvidence,
  selectReviewedGitHistoryPackageEvidence,
  waitForOwnedInstalledDaemonReady,
  withPackageDependencyCacheCustody,
} from "./check-package";
import { assertPublicSensitiveText, assertPublicText } from "./public-text-policy";
import {
  assertPseudoTerminalSuccess,
  createPseudoTerminalGroupCleanup,
  observePseudoTerminalCleanup,
  PTY_BEGIN_MARKER,
  pseudoTerminalScriptArguments,
  readPseudoTerminalAuthorityLine,
  runInPseudoTerminal,
  settlePseudoTerminalCleanup,
} from "./pty-acceptance";

describe("reviewed historical synthetic package fixtures", () => {
  const fixtures = [
    { fixture: "other_ui", token: ["@other", "ui"].join("/") },
    { fixture: "foreign_package", token: ["@foreign", "package"].join("/") },
    { fixture: "slopcamera_suffix", token: ["@hraness/slopcamera", "unreviewed"].join("-") },
  ] as const;
  const digest = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
  const expected = [
    { commit: "e19458e45523c1ace0e87c7928eb15516db94ccd", fixtures: ["other_ui"],
      patchSha256: "5f2599b248dc16d94bc27d980604417398c15ee2e7a981b780954d039f55309f" },
    { commit: "e2fd2d699a9d003e072dc44a613cd823c24f155d", fixtures: ["foreign_package"],
      patchSha256: "fa6583ec433c00d10d967214631fb4e04847515bb273cca51548388cb7c6ba7b" },
    { commit: "52579a5debfe1ee6c31dca0f31733a798c74c6aa", fixtures: ["other_ui", "foreign_package"],
      patchSha256: "a93c5c423beacf7ec5068310ae648b994de67506b07d46e523739b8903458beb" },
    { commit: "166451a0354d5ecb6ca375feb1128a95ff7ff966", fixtures: ["other_ui"],
      patchSha256: "5d7b62c01ac47c3c74389d21b288c4526728c74d68d23c18719b00df09537ef4" },
    { commit: "21176e6ca34e58574376f54a9098856a90d6cd56", fixtures: ["other_ui"],
      patchSha256: "6fc0a85da146a9a0ffc2b3f3407481e6e966e907e99db03e41a7dabb6d3bb749" },
    { commit: "47c8e1cf98eb61441b1fc6832eb6ae035d75278a", fixtures: ["slopcamera_suffix"],
      patchSha256: "e5ac6ac289bf4e93818d13ababd2eb965ef4b1e054fe7b85f0631b145692baf2" },
    { commit: "e6d707ed88d1cc93ed4ba5b30a940e7ed3a55e20", fixtures: ["slopcamera_suffix"],
      patchSha256: "2c3a452f10ae857876538ec8cf76c27fdddf458f92e344465ff042aa6f3a09a2" },
  ] as const;

  test("binds the exact public-patch inventory without requiring branch ancestors in a squash clone", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    const inventory = source.slice(source.indexOf("const reviewedSyntheticPackageHistoryEvidence:"),
      source.indexOf("const reviewedSyntheticPackageTokens:"));
    expect([...inventory.matchAll(/^ {2}"?([0-9a-f]{40})"?: Object\.freeze\(/gmu)].map((match) => match[1]))
      .toEqual(expected.map(({ commit }) => commit));
    for (const row of expected) {
      const evidence = selectReviewedGitHistoryPackageEvidence(row.commit, "public_patch");
      expect(evidence).toEqual({ fixtures: row.fixtures, patchSha256: row.patchSha256 });
      expect(Object.isFrozen(evidence)).toBe(true);
      expect(Object.isFrozen(evidence?.fixtures)).toBe(true);
      expect(selectReviewedGitHistoryPackageEvidence(row.commit, "sensitive_patch")).toBeUndefined();
      expect(selectReviewedGitHistoryPackageEvidence(row.commit.toUpperCase(), "public_patch")).toBeUndefined();
      expect(selectReviewedGitHistoryPackageEvidence(row.commit.slice(0, 39), "public_patch")).toBeUndefined();
      expect(selectReviewedGitHistoryPackageEvidence(row.commit,
        "public_patch " as unknown as Parameters<typeof selectReviewedGitHistoryPackageEvidence>[1])).toBeUndefined();
      expect(() => normalizeGitHistoryPatchForPublicScan(row.commit, "public_patch", "changed patch\n"))
        .toThrow("synthetic-package evidence changed");
      for (const { token } of fixtures) {
        const patch = `+ name: "${token}"\n`;
        expect(normalizeGitHistoryPatchForPublicScan(row.commit, "sensitive_patch", patch)).toBe(patch);
      }
    }
    for (const commit of ["a".repeat(40), "constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(selectReviewedGitHistoryPackageEvidence(commit, "public_patch")).toBeUndefined();
      const patch = `+ name: "${fixtures[0].token}"\n`;
      expect(normalizeGitHistoryPatchForPublicScan(commit, "public_patch", patch)).toBe(patch);
      expect(() => assertPublicText(patch, "unreviewed historical package fixture")).toThrow("PRIVATE_SCOPE");
    }
  });

  test("replaces only once-only complete quoted fixtures and preserves every other byte", () => {
    for (const { fixture, token } of fixtures) {
      const patch = `before\n+ name: "${token}", retained: true\nafter\n`;
      expect(normalizeReviewedSyntheticPackagePatch(patch, digest(patch), [fixture]))
        .toBe("before\n+ name: \"[reviewed-synthetic-package]\", retained: true\nafter\n");
      expect(() => normalizeReviewedSyntheticPackagePatch(`${patch}changed\n`, digest(patch), [fixture]))
        .toThrow("synthetic-package evidence changed");
      for (const invalid of [
        "missing fixture\n", `${token}\n`, `"${token}-unreviewed"\n`, `"${token}/extra"\n`,
        `"${token}"\n"${token}"\n`, `${patch}${token}\n`,
      ]) {
        expect(() => normalizeReviewedSyntheticPackagePatch(invalid, digest(invalid), [fixture]))
          .toThrow("synthetic-package evidence changed");
      }
    }
    const pairedFixtures = fixtures.slice(0, 2);
    const patch = pairedFixtures.map(({ token }) => `- "${token}"\n`).join("");
    expect(normalizeReviewedSyntheticPackagePatch(patch, digest(patch), pairedFixtures.map(({ fixture }) => fixture)))
      .toBe('- "[reviewed-synthetic-package]"\n- "[reviewed-synthetic-package]"\n');
    for (const selection of [[], ["other_ui", "other_ui"], ["other_ui", "foreign_package", "other_ui"]] as const) {
      expect(() => normalizeReviewedSyntheticPackagePatch(patch, digest(patch), selection))
        .toThrow("fixture selection is invalid");
    }
    expect(() => normalizeReviewedSyntheticPackagePatch(patch, digest(patch),
      ["unknown"] as unknown as Parameters<typeof normalizeReviewedSyntheticPackagePatch>[2]))
      .toThrow("fixture is unknown");
  });

  test("normalizing package fixtures cannot launder other private text or sensitive history", () => {
    const secret = ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const privatePath = ["", "Users", "fixture", "private", "source.ts"].join("/");
    const unreviewed = ["@unreviewed", "package"].join("/");
    for (const [tail, code] of [[secret, "SECRET_SHAPE"], [privatePath, "ABSOLUTE_USER_PATH"], [unreviewed, "PRIVATE_SCOPE"]] as const) {
      const patch = `+ "${fixtures[0].token}"\n${tail}\n`;
      const normalized = normalizeReviewedSyntheticPackagePatch(patch, digest(patch), ["other_ui"]);
      expect(normalized).toBe(`+ "[reviewed-synthetic-package]"\n${tail}\n`);
      expect(() => assertPublicText(normalized, "remaining unreviewed history text")).toThrow(code);
      for (const row of expected) {
        expect(normalizeGitHistoryPatchForPublicScan(row.commit, "sensitive_patch", patch)).toBe(patch);
      }
    }
    const patch = `"${fixtures[0].token}"\n"${fixtures[1].token}"\n`;
    const normalized = normalizeReviewedSyntheticPackagePatch(patch, digest(patch), ["other_ui"]);
    expect(() => assertPublicText(normalized, "unselected fixture remains public text")).toThrow("PRIVATE_SCOPE");
    const sensitivePatch = `"${fixtures[0].token}"\n${secret}\n`;
    expect(() => assertPublicSensitiveText(normalizeGitHistoryPatchForPublicScan(expected[0].commit,
      "sensitive_patch", sensitivePatch), "unchanged sensitive history")).toThrow("SECRET_SHAPE");
  });

  test("fixture normalization preserves bounded arbitrary surrounding public text", () => {
    fc.assert(fc.property(fc.constantFrom(...fixtures),
      fc.stringMatching(/^[a-z0-9 ]{0,32}$/u), fc.stringMatching(/^[a-z0-9 ]{0,32}$/u),
      ({ fixture, token }, before, after) => {
        const patch = `${before}"${token}"${after}\n`;
        const normalized = normalizeReviewedSyntheticPackagePatch(patch, digest(patch), [fixture]);
        expect(normalized).toBe(`${before}"[reviewed-synthetic-package]"${after}\n`);
        expect(() => assertPublicText(normalized, "reviewed synthetic package vector")).not.toThrow();
        expect(() => normalizeReviewedSyntheticPackagePatch(`${patch}"${token}"`, digest(patch), [fixture]))
          .toThrow("synthetic-package evidence changed");
      }), { numRuns: 40 });
  });
});

const identity = (pid: number): DaemonIdentity => ({
  bootId: `boot_${"a".repeat(32)}`,
  generation: 1,
  nonce: "10000000-0000-4000-8000-000000000001",
  pid,
  protocol: "hra-control-plane-local-v2",
});

const receipt = (pid: number): DaemonAuthorityReceipt => ({
  acquiredAt: 0,
  bootId: `boot_${"a".repeat(32)}`,
  generation: 1,
  nonce: "10000000-0000-4000-8000-000000000001",
  pid,
  protocol: "hra-control-plane-local-v2",
  state: "ready",
  updatedAt: 0,
  version: 2,
});

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

const hostilePtyProcessTreeSource = (overflow: boolean): string => {
  const leafSource = `
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => undefined);
setInterval(() => undefined, 1000);
`;
  const childSource = `
const { spawn } = require("node:child_process");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => undefined);
const leaf = spawn(process.execPath, ["-e", ${JSON.stringify(leafSource)}], { stdio: "ignore" });
if (leaf.pid === undefined) process.exit(80);
process.stdout.write(String(leaf.pid) + "\\n");
setInterval(() => undefined, 1000);
`;
  return `
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => undefined);
const child = spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}], { stdio: ["ignore", "pipe", "ignore"] });
if (child.pid === undefined) process.exit(81);
child.stdout.once("data", (chunk) => {
  const leafPid = Number(chunk.toString("utf8").trim());
  if (!Number.isSafeInteger(leafPid) || leafPid <= 1) process.exit(82);
  writeFileSync(process.env.OOMPA_HOSTILE_PID_FILE, JSON.stringify([process.pid, child.pid, leafPid]));
  process.stdout.write("hostile-ready\\n");
  ${overflow ? "process.stdout.write(Buffer.alloc(2 * 1024 * 1024, 0x78));" : ""}
});
setInterval(() => undefined, 1000);
`;
};

const historyFixtureChildTimeoutMs = 5_000;
const historyFixtureOutputMaximumBytes = 32 * 1024 * 1024;
const historyFixtureEnvironment = (root: string) => ({
  ...buildGitHistoryEnvironment(root, resolve(tmpdir())),
  GIT_MERGE_AUTOEDIT: "no",
});
const historyFixtureCommandOptions = (
  root: string,
  timeout = historyFixtureChildTimeoutMs,
  phase: "package-history-fixture-git" | "package-history-fixture-render" = "package-history-fixture-git",
) => ({
  cwd: root,
  env: historyFixtureEnvironment(root),
  outputMaximumBytes: historyFixtureOutputMaximumBytes,
  phase,
  timeoutMs: timeout,
});
const createHistoryRenderingBudget = (now: () => number = () => performance.now()) => {
  const deadline = now() + 20_000;
  return (): number => {
    const remaining = Math.floor(deadline - now());
    if (remaining < 1) throw new Error("Git history rendering fixture exhausted its time budget.");
    return Math.min(historyFixtureChildTimeoutMs, remaining);
  };
};
const runHistoryFixtureGit = async (
  root: string,
  arguments_: readonly string[],
  timeout = historyFixtureChildTimeoutMs,
) => await runPackageCommand(
  "/usr/bin/git",
  [
    "-c",
    "commit.gpgSign=false",
    "-c",
    "core.hooksPath=/dev/null",
    ...arguments_,
  ],
  historyFixtureCommandOptions(root, timeout),
);

const requireHistoryFixtureGitOutput = (
  result: Awaited<ReturnType<typeof runHistoryFixtureGit>>,
): string => {
  if (result.exitCode !== 0) {
    throw new Error("Git history fixture command failed or exceeded its bound.");
  }
  return result.stdout.trim();
};
const requireHistoryFixtureGit = async (
  root: string,
  ...arguments_: readonly string[]
): Promise<string> => requireHistoryFixtureGitOutput(
  await runHistoryFixtureGit(root, arguments_),
);

const initializeHistoryFixture = async (
  root: string,
  body = "base\n",
  git = (...arguments_: readonly string[]) => requireHistoryFixtureGit(root, ...arguments_),
): Promise<string> => {
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "Oompa History Fixture");
  await git("config", "user.email", "history-fixture@example.invalid");
  await writeFile(join(root, "document.txt"), body, "utf8");
  await git("add", "document.txt");
  await git("commit", "-m", "base");
  return await git("rev-parse", "HEAD");
};

const runBoundedCanonicalHistoryPatch = async (
  root: string,
  commit: string,
  kind: "public_patch" | "sensitive_patch",
  timeout = historyFixtureChildTimeoutMs,
) => await runPackageCommand(
  "/usr/bin/git",
  ["--no-pager", ...gitHistoryCommandArguments({ commit, kind })],
  historyFixtureCommandOptions(root, timeout, "package-history-fixture-render"),
);

describe("Git history generated hunk metadata", () => {
  const partialPackage = ["@hraness", "direc"].join("/");
  const privatePackage = ["@unreviewed", "package"].join("/");
  const heading = `@@ -12,4 +12,4 @@ Public package ${partialPackage}`;

  test("classifies authored text without treating a truncated generated heading as a package", () => {
    const patch = `${heading}\n unchanged\n-previous\n+current\n`;
    expect(() => assertPublicText(patch, "raw generated heading")).toThrow("PRIVATE_SCOPE");
    expect(() => assertGitHistoryPatchPublicText(patch, "canonical history patch")).not.toThrow();
    for (const range of ["@@ -0,0 +1 @@", "@@ -1 +0,0 @@", "@@ -12 +12,2 @@"]) {
      expect(() => assertGitHistoryPatchPublicText(`${range} ${partialPackage}\n+public\n`, "hunk range"))
        .not.toThrow();
    }
  });

  test("retains added, removed, context and malformed-header package refusals", () => {
    for (const prefix of ["+", "-", " ", "++", "--"]) {
      for (const body of [privatePackage, `@@ -1 +1 @@ ${privatePackage}`]) {
        expect(() => assertGitHistoryPatchPublicText(`${heading}\n${prefix}${body}\n`, "authored history"))
          .toThrow("PRIVATE_SCOPE");
      }
    }
    for (const malformed of [
      "@@@ -1 +1 @@@", "@@ -01 +1 @@", "@@ -1 +01 @@", "@@ -x +1 @@",
      "@@ -1,-1 +1 @@", "@@ -1 +1 @@missing-space", "@@ -1 +1 @", "@@ -1 +1 @@\t",
    ]) {
      expect(() => assertGitHistoryPatchPublicText(`${malformed} ${privatePackage}\n`, "malformed heading"))
        .toThrow("PRIVATE_SCOPE");
    }
    expect(() => assertGitHistoryPatchPublicText(`diff --git a/${privatePackage} b/public\n`, "path metadata"))
      .toThrow("PRIVATE_SCOPE");
  });

  test("does not interpret embedded Unicode or carriage-return separators as Git line boundaries", () => {
    for (const separator of ["\r", "\u2028", "\u2029"]) {
      for (const prefix of ["+", "-", " ", ""]) {
        expect(() => assertGitHistoryPatchPublicText(
          `${prefix}public${separator}@@ -1 +1 @@ ${privatePackage}\n`, "embedded separator",
        )).toThrow("PRIVATE_SCOPE");
      }
      expect(() => assertGitHistoryPatchPublicText(
        `@@ -1 +1 @@ harmless${separator}${privatePackage}\n`, "noncanonical heading",
      )).toThrow("PRIVATE_SCOPE");
    }
  });

  test("retains sensitive checks even in generated heading metadata", () => {
    const secret = ["github", "pat", "abcdefghijklmnopqrstuvwxyz123456"].join("_");
    const privatePath = ["", "Users", "fixture", "private", "source.ts"].join("/");
    for (const [value, code] of [[secret, "SECRET_SHAPE"], [privatePath, "ABSOLUTE_USER_PATH"]] as const) {
      for (const prefix of ["@@ -1 +1 @@ ", "+", "-", " "]) {
        expect(() => assertGitHistoryPatchPublicText(`${prefix}${value}\n`, "sensitive history"))
          .toThrow(code);
      }
    }
  });

  test("preserves authored package detection for arbitrary bounded context", () => {
    fc.assert(fc.property(fc.stringMatching(/^[a-z0-9 ]{0,40}$/u), fc.constantFrom("+", "-", " "),
      (context, prefix) => {
        const patch = `@@ -1,2 +1,2 @@ ${context}${partialPackage}\n${prefix}${context}${privatePackage}\n`;
        expect(() => assertGitHistoryPatchPublicText(patch, "authored package vector")).toThrow("PRIVATE_SCOPE");
      }), { seed: 20260909, numRuns: 40 });
  });

  test("admits real Git-truncated public headings while still scanning every historical commit", async () => {
    const remaining = createHistoryRenderingBudget();
    const root = resolve(await mkdtemp(join(tmpdir(), "oompa-history-hunk-heading-")));
    const git = async (...arguments_: readonly string[]) => requireHistoryFixtureGitOutput(
      await runHistoryFixtureGit(root, arguments_, remaining()),
    );
    const title = "The isolated product demos on oompa.app incorporate MIT-licensed `@hraness/direct` v0.7.0.";
    const before = `${title}\n\n\n\n\n before\n before\n before\n old\n`;
    try {
      await initializeHistoryFixture(root, before, git);
      await writeFile(join(root, "document.txt"), before.replace(" old\n", " current\n"), "utf8");
      await git("commit", "-am", "public heading update");
      const commit = await git("rev-parse", "HEAD");
      const patch = requireGitHistoryOutput("Truncated hunk heading", await runBoundedCanonicalHistoryPatch(
        root, commit, "public_patch", remaining(),
      ));
      expect(patch.split("\n").filter((line) => line.startsWith("@@ ")))
        .toEqual([`@@ -6,4 +6,4 @@ ${title.slice(0, 80)}`]);
      expect(title.slice(0, 80)).toContain(partialPackage);
      expect(() => assertPublicText(patch, "raw Git heading")).toThrow("PRIVATE_SCOPE");
      expect(() => assertGitHistoryPatchPublicText(patch, "canonical Git heading")).not.toThrow();
      await expect(assertCompleteGitHistoryPublic(root)).resolves.toBeUndefined();
      const privateBody = `Private heading ${privatePackage}\n\n\n\n\n before\n before\n before\n old\n`;
      await writeFile(join(root, "private.txt"), privateBody, "utf8");
      await git("add", "private.txt");
      await git("commit", "-m", "negative history fixture");
      await writeFile(join(root, "private.txt"), privateBody.replace(" old\n", " current\n"), "utf8");
      await git("commit", "-am", "unchanged private heading");
      const privateHeadingPatch = requireGitHistoryOutput("Unchanged private heading", await runBoundedCanonicalHistoryPatch(
        root, await git("rev-parse", "HEAD"), "public_patch", remaining(),
      ));
      expect(privateHeadingPatch.split("\n").filter((line) => line.includes(privatePackage)))
        .toEqual([`@@ -6,4 +6,4 @@ Private heading ${privatePackage}`]);
      expect(() => assertGitHistoryPatchPublicText(privateHeadingPatch, "generated private heading")).not.toThrow();
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("PRIVATE_SCOPE");
      await writeFile(join(root, "private.txt"), "public successor\n", "utf8");
      await git("commit", "-am", "public successor");
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("PRIVATE_SCOPE");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});

describe("Git hunk section scope projection", () => {
  const truncated = ["@hraness", "direc"].join("/");

  test("omits only generated section labels while preserving hunk coordinates and authored lines", () => {
    const header = "@@ -12,4 +12,6 @@";
    const source = `${header} public text ${truncated}\n old\n-removed\n+added\n`;
    expect(stripGitHunkSectionHeadingsForScopeScan(source))
      .toBe(`${header}\n old\n-removed\n+added\n`);
    expect(() => assertPublicText(source, "unprojected section label")).toThrow("PRIVATE_SCOPE");
    expect(() => assertPublicText(stripGitHunkSectionHeadingsForScopeScan(source), "scope projection"))
      .not.toThrow();
    for (const coordinates of ["@@ -0,0 +1 @@", "@@ -1 +0,0 @@", "@@ -1 +1 @@"]) {
      expect(stripGitHunkSectionHeadingsForScopeScan(`${coordinates} ${truncated}\n`))
        .toBe(`${coordinates}\n`);
    }
  });

  test("never removes authored header-shaped text or malformed metadata", () => {
    for (const prefix of ["+", "-", " ", "\\"]) {
      const source = `${prefix}@@ -1 +1 @@ ${truncated}\n`;
      expect(stripGitHunkSectionHeadingsForScopeScan(source)).toBe(source);
      expect(() => assertPublicText(stripGitHunkSectionHeadingsForScopeScan(source), "authored text"))
        .toThrow("PRIVATE_SCOPE");
    }
    for (const header of [
      "@@ -01 +1 @@", "@@ -1, +1 @@", "@@ -1 +1 @@@", "@@@ -1 -1 +1 @@@",
      "@@ -1 +1 @@\t", "@@ -1 +1 @@ \r",
    ]) {
      const source = `${header}${truncated}\n`;
      expect(stripGitHunkSectionHeadingsForScopeScan(source)).toBe(source);
      expect(() => assertPublicText(source, "unrecognized metadata")).toThrow("PRIVATE_SCOPE");
    }
    const lines = ["+", "-", " "].map((prefix) => `${prefix}${truncated}`).join("\n");
    const source = `@@ -1,2 +1,2 @@ ${truncated}\n${lines}\n`;
    expect(stripGitHunkSectionHeadingsForScopeScan(source)).toBe(`@@ -1,2 +1,2 @@\n${lines}\n`);
    expect(() => assertPublicText(stripGitHunkSectionHeadingsForScopeScan(source), "remaining source"))
      .toThrow("PRIVATE_SCOPE");
    for (const separator of ["\r", "\u2028", "\u2029"]) {
      for (const prefix of ["+", "-", " "]) {
        const authored = `${prefix}before${separator}@@ -1 +1 @@ ${truncated}\n`;
        expect(stripGitHunkSectionHeadingsForScopeScan(authored)).toBe(authored);
        expect(() => assertPublicText(stripGitHunkSectionHeadingsForScopeScan(authored), "physical source line"))
          .toThrow("PRIVATE_SCOPE");
      }
    }
  });

  test("keeps sensitive bytes in the unprojected complete-patch scan", () => {
    const commit = "a".repeat(40);
    for (const value of [
      ["", "Users", "fixture", "private", ""].join("/"),
      ["sk", "proj", "A".repeat(24)].join("-"),
    ]) {
      const patch = `@@ -1 +1 @@ ${value}\n-safe\n+safe\n`;
      expect(normalizeGitHistoryPatchForPublicScan(commit, "sensitive_patch", patch)).toBe(patch);
      expect(() => assertPublicSensitiveText(
        normalizeGitHistoryPatchForPublicScan(commit, "sensitive_patch", patch), "complete sensitive patch",
      )).toThrow();
    }
  });

  test("projects only the production scope surface after immutable evidence normalization", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    const scan = source.slice(source.indexOf("export const assertCompleteGitHistoryPublic ="),
      source.indexOf("const assertSessionObservationHelp ="));
    expect(scan).toContain('assertPublicSensitiveText(\n      normalizeGitHistoryPatchForPublicScan(commit, "sensitive_patch", completePatch),');
    expect(scan.match(/assertGitHistoryPatchPublicText/gu)).toHaveLength(1);
    expect(scan).toContain('assertGitHistoryPatchPublicText(\n      normalizeGitHistoryPatchForPublicScan(commit, "public_patch", authoredPatch),');
    const wrapper = source.slice(source.indexOf("export const assertGitHistoryPatchPublicText ="),
      source.indexOf("export const assertCompleteGitHistoryPublic ="));
    expect(wrapper.match(/stripGitHunkSectionHeadingsForScopeScan/gu)).toHaveLength(1);
    expect(wrapper).toContain('assertPublicSensitiveText(patch, label);\n  assertPublicText(stripGitHunkSectionHeadingsForScopeScan(patch), label);');
  });

  test("scans complete real Git history when a public package is truncated in a generated heading", async () => {
    const root = resolve(await mkdtemp(join(tmpdir(), "oompa-history-section-")));
    const heading = "The isolated product demos on oompa.app incorporate MIT-licensed `@hraness/direct`.";
    const before = `${heading}\n${"\n".repeat(8)}before\n`;
    try {
      await initializeHistoryFixture(root, before);
      await writeFile(join(root, "document.txt"), before.replace("before\n", "after\n"), "utf8");
      await requireHistoryFixtureGit(root, "add", "document.txt");
      await requireHistoryFixtureGit(root, "commit", "-m", "change below public heading");
      const commit = await requireHistoryFixtureGit(root, "rev-parse", "HEAD");
      const rendered = await runBoundedCanonicalHistoryPatch(root, commit, "public_patch");
      expect(rendered.exitCode).toBe(0);
      expect(rendered.stderr).toBe("");
      expect(rendered.stdout).toContain(truncated);
      expect(() => assertPublicText(rendered.stdout, "raw generated patch")).toThrow("PRIVATE_SCOPE");
      expect(stripGitHunkSectionHeadingsForScopeScan(rendered.stdout)).not.toContain(truncated);
      await expect(assertCompleteGitHistoryPublic(root)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("installed package daemon ownership", () => {
  test("times out delayed receipt publication without losing the exact owned pid", async () => {
    const pid = 42_424;
    let now = 0;
    let statusCalls = 0;
    const error = await waitForOwnedInstalledDaemonReady({
      daemon: { exitObservation: () => null, pid },
      deadlineMs: 100,
      now: () => now,
      pollMs: 20,
      queryStatus: async () => {
        statusCalls += 1;
        return identity(pid);
      },
      readReceipt: async () => now >= 120 ? receipt(pid) : null,
      sleep: async (milliseconds) => { now += milliseconds; },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain(`pid ${String(pid)}`);
    expect(String(error)).toContain("did not become ready before the deadline");
    expect(statusCalls).toBe(0);
  });

  test("refuses a live receipt published by a process the harness does not own", async () => {
    const ownedPid = 42_425;
    await expect(waitForOwnedInstalledDaemonReady({
      daemon: { exitObservation: () => null, pid: ownedPid },
      queryStatus: async () => identity(ownedPid + 1),
      readReceipt: async () => receipt(ownedPid + 1),
    })).rejects.toThrow(`unexpected pid ${String(ownedPid + 1)} instead of owned pid ${String(ownedPid)}`);
  });
});

describe("installed package generic command ownership", () => {
  test("admits only one canonical absolute Bun dependency cache path", () => {
    const cache = resolve(join(tmpdir(), "oompa-bun-cache"));
    expect(parsePackageDependencyCache(cache)).toBe(cache);
    expect(parsePackageDependencyCache(`${cache}\n`)).toBe(cache);
    for (const value of [
      "relative/cache\n",
      `${cache}\n${cache}\n`,
      `${cache}\n\n`,
      `${cache}\r\n`,
      `${cache}\0\n`,
      `${cache}/../cache\n`,
      `${"/".repeat(4_097)}\n`,
    ]) expect(() => parsePackageDependencyCache(value)).toThrow("non-canonical dependency cache path");
  });

  test("shares only the validated dependency cache across private consumer roots", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source.indexOf("await resolvePackageDependencyCache(repositoryRoot)")).toBeLessThan(
      source.indexOf('mkdtemp(join(tmpdir(), "hra-package-")'),
    );
    expect(source).toContain("BUN_INSTALL_CACHE_DIR: dependencyCacheRoot");
    expect(source).not.toContain("BUN_INSTALL_CACHE_DIR: globalInstallRoot");
    expect(source).toContain("delete discoveryEnvironment.BUN_INSTALL_CACHE_DIR;");
    expect(source.match(/await withPackageDependencyCacheCustody\(dependencyCacheRoot/gu)).toHaveLength(2);
    for (const isolated of [
      "BUN_INSTALL: globalInstallRoot",
      'BUN_INSTALL_BIN: join(globalInstallRoot, "bin")',
      'BUN_INSTALL_GLOBAL_DIR: join(globalInstallRoot, "install", "global")',
      "HOME: consumerHome",
      "TMPDIR: consumerTemporaryDirectory",
    ]) expect(source).toContain(isolated);
  });

  test("ignores a direct ambient cache override while retaining the configured Bun installation root", () => {
    const environment = packageDependencyCacheDiscoveryEnvironment({
      BUN_INSTALL: "/canonical-bun-root",
      BUN_INSTALL_CACHE_DIR: "/untrusted-direct-cache-override",
      OOMPA_UNRELATED_FIXTURE: "preserved",
    });
    expect(environment).toEqual({
      BUN_INSTALL: "/canonical-bun-root",
      OOMPA_UNRELATED_FIXTURE: "preserved",
    });
  });

  test("holds the dependency cache descriptor and rejects path replacement", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-custody-")));
    const cache = join(root, "cache");
    const displaced = join(root, "displaced");
    const replacement = join(root, "replacement");
    try {
      await mkdir(cache, { mode: 0o700 });
      await mkdir(replacement, { mode: 0o700 });
      await expect(withPackageDependencyCacheCustody(cache, async () => {
        await rename(cache, displaced);
        await rename(replacement, cache);
      })).rejects.toThrow("identity changed while in use");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fails closed when a cache consumer rejects with undefined", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-undefined-error-")));
    const cache = join(root, "cache");
    try {
      await mkdir(cache, { mode: 0o700 });
      await expect(withPackageDependencyCacheCustody(cache, async () => await Promise.reject(undefined))).rejects.toThrow(
        "Bun dependency cache operation failed with a non-error value.",
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("holds the dependency cache parent chain and rejects parent replacement", async () => {
    const temporaryParent = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-parent-custody-")));
    const root = join(temporaryParent, "root");
    const cache = join(root, "cache");
    const displaced = join(temporaryParent, "displaced");
    const replacement = join(temporaryParent, "replacement");
    try {
      await mkdir(cache, { mode: 0o700, recursive: true });
      await mkdir(join(replacement, "cache"), { mode: 0o700, recursive: true });
      await expect(withPackageDependencyCacheCustody(cache, async () => {
        await rename(root, displaced);
        await rename(replacement, root);
      })).rejects.toThrow("path identity changed while in use");
    } finally {
      await rm(temporaryParent, { force: true, recursive: true });
    }
  });

  test("rejects a group-writable dependency cache parent", async () => {
    const temporaryParent = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-parent-mode-")));
    const parent = join(temporaryParent, "parent");
    const cache = join(parent, "cache");
    try {
      await mkdir(cache, { mode: 0o700, recursive: true });
      await chmod(parent, 0o770);
      await expect(withPackageDependencyCacheCustody(cache, async () => undefined)).rejects.toThrow(
        "path custody is invalid",
      );
    } finally {
      await rm(temporaryParent, { force: true, recursive: true });
    }
  });

  test("rejects a dangerous Darwin ACL on the dependency cache", async () => {
    if (process.platform !== "darwin") return;
    const root = await realpath(await mkdtemp(join(tmpdir(), "hra-package-cache-acl-")));
    const cache = join(root, "cache");
    const runChmod = (...arguments_: string[]): void => {
      // Keep this short fixture mutation fully synchronous. A retained async
      // Bun subprocess can stall later synchronous native identity discovery.
      const child = Bun.spawnSync(["/bin/chmod", ...arguments_], {
        killSignal: "SIGKILL",
        maxBuffer: 4_096,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "ignore",
        timeout: historyFixtureChildTimeoutMs,
      });
      if (child.exitCode !== 0 || !child.success
        || child.exitedDueToTimeout === true || child.exitedDueToMaxBuffer === true
        || child.stderr.byteLength !== 0) throw new Error("ACL fixture chmod failed or exceeded its bound.");
    };
    try {
      await mkdir(cache, { mode: 0o700 });
      runChmod("+a", "everyone allow delete", cache);
      await expect(withPackageDependencyCacheCustody(cache, async () => undefined)).rejects.toThrow(
        "dangerous non-owner Darwin ALLOW ACL",
      );
    } finally {
      try {
        runChmod("-N", cache);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  test("scans complete Git history one bounded commit patch at a time", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source).toContain('["--no-replace-objects", "rev-list", "--max-count=100001", "--all"]');
    expect(source).toContain('["--no-replace-objects", "rev-parse", "--is-shallow-repository"]');
    expect(source).toContain('"--diff-merges=first-parent"');
    expect(source).toContain('"--text"');
    for (const renderingArgument of [
      "core.attributesFile=/dev/null",
      "core.quotePath=true",
      "diff.mnemonicPrefix=false",
      "diff.noprefix=false",
      "diff.orderFile=/dev/null",
      "diff.relative=false",
      "diff.suppressBlankEmpty=false",
      "--full-index",
      "--no-color",
      "--no-renames",
      "--unified=3",
      "--inter-hunk-context=0",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--output-indicator-new=+",
      "--output-indicator-old=-",
      "--output-indicator-context= ",
      "--submodule=short",
    ]) expect(source).toContain(JSON.stringify(renderingArgument));
    expect(source).toContain("Bun.spawnSync");
    expect(source).toContain('killSignal: "SIGKILL"');
    expect(source).toContain("gitHistoryScanOutputMaximumBytes");
    expect(source).toContain("gitHistoryScanTimeoutMs");
    expect(source).not.toContain('["log", "--all", "--format=", "--patch"');
    expect(source).not.toMatch(/await run\(\s*"\/usr\/bin\/git"/u);

    const first = "a".repeat(40);
    const second = "b".repeat(40);
    expect(parseGitHistoryCommitList(`${first}\n${second}\n`)).toEqual([first, second]);
    for (const invalid of [
      "",
      `${first}\n${first}\n`,
      `${first.toUpperCase()}\n`,
      `${"c".repeat(39)}\n`,
      `${first}\n\n${second}\n`,
    ]) {
      expect(() => parseGitHistoryCommitList(invalid)).toThrow("Git history enumeration");
    }
    const overBound = `${Array.from(
      { length: 100_001 },
      (_, index) => index.toString(16).padStart(40, "0"),
    ).join("\n")}\n`;
    expect(() => parseGitHistoryCommitList(overBound)).toThrow("over its commit bound");
  });

  test("selects only the exact immutable historical commit and patch-kind evidence", async () => {
    // These are approval identities, not required objects in a squash-merged clone.
    const expected = [
      {
        commit: "313ed3e3e1ddbe5b6464fc098926717f177418a8",
        fixtures: ["sanitized_message"],
        public_patch: "38922e6d214028499463e193e62b7fde97835cad271693f76e4876af080e5a27",
        sensitive_patch: "38922e6d214028499463e193e62b7fde97835cad271693f76e4876af080e5a27",
      },
      {
        commit: "5039f0bfe37706f97bd93e68f8db2dff4aa16013",
        fixtures: ["memory_summary"],
        public_patch: "b3dbdd5504acb92dc2bb0f7e1ebf6e56e7911498bd96fc8f8b7080af924fe42b",
        sensitive_patch: "b3dbdd5504acb92dc2bb0f7e1ebf6e56e7911498bd96fc8f8b7080af924fe42b",
      },
      {
        commit: "72fcb44fb81a79c93ade6da3a127dbb3ae1dd6f9",
        fixtures: ["memory_summary"],
        public_patch: "cb571ed9e6f3c71cf062169d36fd1d403c7da42cf409fbc1e2bf64256e222911",
        sensitive_patch: "ddc5655f80d0a9308dbcf319d2247c429f6a411a14aca2fa68c3efb2113c6d50",
      },
      {
        commit: "b48fdb71ca201d951b9b1343a909b5f18277bc36",
        fixtures: ["sanitized_message", "memory_summary"],
        public_patch: "1b6df43d22fb500c41291b5ab8c57c06f475aa80515dd57735b6f57fa70eed46",
        sensitive_patch: "59089938773a6ea6574c7df54b7a3da73272a827920845e4805a3e4735b2f812",
      },
      {
        commit: "f39747b917b064ff593c58dea2a05e4481319b26",
        fixtures: ["sanitized_message"],
        public_patch: "1aa2ed40e2d437c2871a6975f177f9bb5bd078c68856fa66f63511a47144fc4a",
        sensitive_patch: "1aa2ed40e2d437c2871a6975f177f9bb5bd078c68856fa66f63511a47144fc4a",
      },
    ] as const;
    // Freeze the closed inventory without exporting a second authorization surface.
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    const inventory = source.slice(
      source.indexOf("const reviewedSyntheticHistoryPatchEvidence:"),
      source.indexOf("const reviewedSyntheticHistoryPaths:"),
    );
    const commits = [...inventory.matchAll(/^ {2}"?([0-9a-f]{40})"?: Object\.freeze\(/gmu)]
      .map((match) => match[1]);
    expect(commits).toEqual(expected.map(({ commit }) => commit));
    for (const row of expected) {
      for (const kind of ["public_patch", "sensitive_patch"] as const) {
        const evidence = selectReviewedGitHistoryPatchEvidence(row.commit, kind);
        expect(evidence).toEqual({ fixtures: row.fixtures, patchSha256: row[kind] });
        expect(Object.isFrozen(evidence)).toBe(true);
        expect(Object.isFrozen(evidence?.fixtures)).toBe(true);
        expect(selectReviewedGitHistoryPatchEvidence(row.commit.toUpperCase(), kind)).toBeUndefined();
        expect(selectReviewedGitHistoryPatchEvidence(row.commit.slice(0, 39), kind)).toBeUndefined();
      }
    }
    for (const kind of ["public_patch", "sensitive_patch"] as const) {
      for (const commit of ["a".repeat(40), "constructor", "toString", "__proto__", "hasOwnProperty"]) {
        expect(selectReviewedGitHistoryPatchEvidence(commit, kind)).toBeUndefined();
        expect(normalizeGitHistoryPatchForPublicScan(commit, kind, "unapproved bytes\n"))
          .toBe("unapproved bytes\n");
      }
    }
  });

  test.each([
    {
      fixture: "sanitized_message",
      originalCommit: "f39747b917b064ff593c58dea2a05e4481319b26",
      repairCommit: "313ed3e3e1ddbe5b6464fc098926717f177418a8",
      syntheticPath: ["", "Users", "private", "project", ""].join("/"),
      vectorDigest: "93250d5845126563001eb524474e352996ac4fe346e9044d9cea9d421d586c2b",
      repairDigest: "38922e6d214028499463e193e62b7fde97835cad271693f76e4876af080e5a27",
      repairPatch: [
        "diff --git a/src/storage/state-store.test.ts b/src/storage/state-store.test.ts",
        "index 72d588695a33374ba243675d45e78c2f0a0cfcca..fb7d27f544010c7b53d7cc9349f36d772b967efa 100644",
        "--- a/src/storage/state-store.test.ts",
        "+++ b/src/storage/state-store.test.ts",
        '@@ -11722,9 +11722,10 @@ describe("StateStore", () => {',
        "     };",
        " ",
        '     const sendSession = bind("thread-atomic-send", "idle");',
        '-    const sendMessage = `' + ["", "Users", "private", "project", ""].join("/") + '${"x".repeat(',
        "-      SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS,",
        "-    )}`;",
        "+    const sendMessage = [",
        '+      "", "Users", "private", "project",',
        '+      "x".repeat(SESSION_EVENT_USER_MESSAGE_MAX_CHARACTERS),',
        '+    ].join("/");',
        "     const sendKey = peerIdempotencyKey(70_001);",
        "     const sendAttempt = store.prepareMutation({",
        '       kind: "session.send",',
        "",
      ].join("\n"),
    },
    {
      fixture: "memory_summary",
      originalCommit: "72fcb44fb81a79c93ade6da3a127dbb3ae1dd6f9",
      repairCommit: "5039f0bfe37706f97bd93e68f8db2dff4aa16013",
      syntheticPath: ["", "Users", "operator", "private"].join("/"),
      vectorDigest: "7df43702ce75d907ce2a664495d8f131ead925827f5d4e19ac724f6f6b2bdffa",
      repairDigest: "b3dbdd5504acb92dc2bb0f7e1ebf6e56e7911498bd96fc8f8b7080af924fe42b",
      repairPatch: [
        "diff --git a/src/cloud/payloads.test.ts b/src/cloud/payloads.test.ts",
        "index bd02938c369d8559be32146ddd1ac5ceaf8575d5..dfcd2c0f9934e61462df8df433a8f939a161da1b 100644",
        "--- a/src/cloud/payloads.test.ts",
        "+++ b/src/cloud/payloads.test.ts",
        '@@ -742,7 +742,7 @@ describe("memory summary payloads", () => {',
        "     })).toBeNull();",
        "     expect(parseMemorySummaryPayload({",
        "       ...summary,",
        '-      spaces: [{ ...space, projectLabel: "' + ["", "Users", "operator", "private"].join("/") + '" }],',
        '+      spaces: [{ ...space, projectLabel: ["", "Users", "operator", "private"].join("/") }],',
        "     })).toBeNull();",
        "     expect(parseMemorySummaryPayload({",
        "       ...summary,",
        "",
      ].join("\n"),
    },
  ] as const)("normalizes only exact historical $fixture evidence", ({
    fixture,
    originalCommit,
    repairCommit,
    syntheticPath,
    vectorDigest,
    repairDigest,
    repairPatch,
  }) => {
    // Capture the two small canonical repair patches, not checkout-owned Git objects:
    // squash merges deliberately omit the original branch's history. The larger
    // original/merge records retain negative binding coverage below.
    expect(createHash("sha256").update(repairPatch, "utf8").digest("hex")).toBe(repairDigest);
    expect(repairPatch.split(syntheticPath)).toHaveLength(2);
    for (const kind of ["sensitive_patch", "public_patch"] as const) {
      const normalized = normalizeGitHistoryPatchForPublicScan(repairCommit, kind, repairPatch);
      expect(normalized).toBe(repairPatch.replace(syntheticPath, "[reviewed-synthetic-absolute-path]"));
      const assertReviewedPatch = kind === "public_patch" ? assertPublicText : assertPublicSensitiveText;
      expect(() => assertReviewedPatch(normalized, "reviewed history fixture")).not.toThrow();
      expect(() => normalizeGitHistoryPatchForPublicScan(repairCommit, kind, `${repairPatch}mutation\n`))
        .toThrow("synthetic-path evidence changed");
      expect(() => normalizeGitHistoryPatchForPublicScan(originalCommit, kind, repairPatch))
        .toThrow("synthetic-path evidence changed");
      const otherRepairCommit = fixture === "memory_summary"
        ? "313ed3e3e1ddbe5b6464fc098926717f177418a8"
        : "5039f0bfe37706f97bd93e68f8db2dff4aa16013";
      expect(() => normalizeGitHistoryPatchForPublicScan(otherRepairCommit, kind, repairPatch))
        .toThrow("synthetic-path evidence changed");
    }

    const vector = `before ${syntheticPath} after\n`;
    expect(normalizeReviewedSyntheticHistoryPatch(vector, vectorDigest, [fixture]))
      .toBe("before [reviewed-synthetic-absolute-path] after\n");
    expect(() => normalizeReviewedSyntheticHistoryPatch(`${vector}mutation\n`, vectorDigest, [fixture]))
      .toThrow("synthetic-path evidence changed");
    const unreviewedCommit = "a".repeat(40);
    const unreviewedPatch = `before ${syntheticPath} after`;
    expect(normalizeGitHistoryPatchForPublicScan(
      unreviewedCommit,
      "sensitive_patch",
      unreviewedPatch,
    )).toBe(unreviewedPatch);
    expect(() => assertPublicSensitiveText(unreviewedPatch, "unreviewed history fixture"))
      .toThrow("ABSOLUTE_USER_PATH");

    const duplicatePatch = `${syntheticPath}\n${syntheticPath}\n`;
    const duplicateDigest = createHash("sha256").update(duplicatePatch, "utf8").digest("hex");
    expect(() => normalizeReviewedSyntheticHistoryPatch(duplicatePatch, duplicateDigest, [fixture]))
      .toThrow("synthetic-path evidence changed");
    for (const missingPatch of [
      "safe history patch\n",
      [["", "Users", "private", "other", ""].join("/"), "changed path\n"].join(""),
    ]) {
      const missingDigest = createHash("sha256").update(missingPatch, "utf8").digest("hex");
      expect(() => normalizeReviewedSyntheticHistoryPatch(missingPatch, missingDigest, [fixture]))
        .toThrow("synthetic-path evidence changed");
    }
    expect(() => assertPublicSensitiveText(syntheticPath, "current tree fixture"))
      .toThrow("ABSOLUTE_USER_PATH");

    const secret = ["sk", "proj", "Z".repeat(24)].join("-");
    const retainedSensitivePatch = `${syntheticPath}\n${secret}\n`;
    const retainedDigest = createHash("sha256")
      .update(retainedSensitivePatch, "utf8")
      .digest("hex");
    const normalizedSensitivePatch = normalizeReviewedSyntheticHistoryPatch(
      retainedSensitivePatch,
      retainedDigest,
      [fixture],
    );
    const otherFixture = fixture === "memory_summary" ? "sanitized_message" : "memory_summary";
    expect(() => normalizeReviewedSyntheticHistoryPatch(
      retainedSensitivePatch,
      retainedDigest,
      [otherFixture],
    )).toThrow("synthetic-path evidence changed");
    expect(() => assertPublicSensitiveText(normalizedSensitivePatch, "retained history fixture"))
      .toThrow("SECRET_SHAPE");

    const privateScope = ["@", "unreviewed-scope", "/", "package"].join("");
    const retainedPublicPatch = `${syntheticPath}\n${privateScope}\n`;
    const retainedPublicDigest = createHash("sha256")
      .update(retainedPublicPatch, "utf8")
      .digest("hex");
    const normalizedPublicPatch = normalizeReviewedSyntheticHistoryPatch(
      retainedPublicPatch,
      retainedPublicDigest,
      [fixture],
    );
    expect(() => assertPublicText(normalizedPublicPatch, "retained public history fixture"))
      .toThrow("PRIVATE_SCOPE");
  });

  test("normalizes both exact synthetic fixtures without admitting a different historical merge patch", () => {
    const commit = "b48fdb71ca201d951b9b1343a909b5f18277bc36";
    const messagePath = ["", "Users", "private", "project", ""].join("/");
    const summaryPath = ["", "Users", "operator", "private"].join("/");
    const patch = `${messagePath}\n${summaryPath}\n`;
    const digest = "a2a117567e265c6da0ed9a39bf369d3e6528d4a040424fd652027ee1e0e94bd4";
    expect(normalizeReviewedSyntheticHistoryPatch(patch, digest, ["sanitized_message", "memory_summary"]))
      .toBe("[reviewed-synthetic-absolute-path]\n[reviewed-synthetic-absolute-path]\n");
    expect(() => normalizeReviewedSyntheticHistoryPatch(`${patch}changed\n`, digest, [
      "sanitized_message", "memory_summary",
    ])).toThrow("synthetic-path evidence changed");
    for (const kind of ["sensitive_patch", "public_patch"] as const) {
      expect(() => normalizeGitHistoryPatchForPublicScan(commit, kind, patch))
        .toThrow("synthetic-path evidence changed");
    }

    expect(() => normalizeReviewedSyntheticHistoryPatch(
      patch,
      digest,
      ["unknown"] as unknown as Parameters<typeof normalizeReviewedSyntheticHistoryPatch>[2],
    )).toThrow("fixture is unknown");
    expect(() => normalizeReviewedSyntheticHistoryPatch(patch, digest, []))
      .toThrow("fixture selection is invalid");
    expect(() => normalizeReviewedSyntheticHistoryPatch(patch, digest, ["memory_summary", "memory_summary"]))
      .toThrow("fixture selection is invalid");
    expect(() => normalizeReviewedSyntheticHistoryPatch(patch, digest, [
      "sanitized_message", "memory_summary", "sanitized_message",
    ])).toThrow("fixture selection is invalid");
    const extraOccurrence = `${patch}${summaryPath}\n`;
    const extraDigest = createHash("sha256").update(extraOccurrence, "utf8").digest("hex");
    expect(() => normalizeReviewedSyntheticHistoryPatch(extraOccurrence, extraDigest, [
      "sanitized_message", "memory_summary",
    ])).toThrow("synthetic-path evidence changed");
  });

  test.each([
    {
      fixture: "sanitized_message",
      patchDigests: {
        original: {
          public_patch: "28d7ad4616d89eb6d6daeac1b833c7acb32c1a47d81a32f10fcb7798686d6b00",
          sensitive_patch: "28d7ad4616d89eb6d6daeac1b833c7acb32c1a47d81a32f10fcb7798686d6b00",
        },
        repair: {
          public_patch: "0e673517458fa8b50a6ec21674116ebef4acd17dd71009b0bc89562e851f434b",
          sensitive_patch: "0e673517458fa8b50a6ec21674116ebef4acd17dd71009b0bc89562e851f434b",
        },
      },
      syntheticPath: ["", "Users", "private", "project", ""].join("/"),
    },
    {
      fixture: "memory_summary",
      patchDigests: {
        original: {
          public_patch: "57838c9f69e9b4b755597235daa2a56a2d248e5bacfab495012b1eb801fb747c",
          sensitive_patch: "7b068a95c057cb9a10732df95755efb2daefd7575f303430447cc46671cc35cc",
        },
        repair: {
          public_patch: "8a0bda01dd830cd1f9b5708ef072bc67e297f409a1e0039874cb1cfd72cd0f78",
          sensitive_patch: "c4e4bb17bc5741276460e7867f57b6772c83415f2645dbba146a3d4a06b31cf7",
        },
      },
      syntheticPath: ["", "Users", "operator", "private"].join("/"),
    },
  ] as const)("renders self-contained original and repaired $fixture evidence", async ({
    fixture,
    patchDigests,
    syntheticPath,
  }) => {
    const remaining = createHistoryRenderingBudget();
    const root = resolve(await mkdtemp(join(tmpdir(), "oompa-history-synthetic-")));
    const git = async (...arguments_: readonly string[]) => requireHistoryFixtureGitOutput(
      await runHistoryFixtureGit(root, arguments_, remaining()),
    );
    try {
      await initializeHistoryFixture(root, "base\n", git);
      const document = join(root, "document.txt");
      await writeFile(document, `synthetic fixture ${syntheticPath}\n`, "utf8");
      if (fixture === "memory_summary") await writeFile(join(root, "bun.lock"), "original lock marker\n", "utf8");
      await git("add", "--all");
      await git("commit", "-m", "original synthetic fixture");
      const originalCommit = await git("rev-parse", "HEAD");
      await writeFile(document, "repaired synthetic fixture\n", "utf8");
      if (fixture === "memory_summary") await writeFile(join(root, "bun.lock"), "repaired lock marker\n", "utf8");
      await git("commit", "-am", "repaired synthetic fixture");
      const repairCommit = await git("rev-parse", "HEAD");
      const rendered = [];
      for (const [phase, commit] of [["original", originalCommit], ["repair", repairCommit]] as const) {
        for (const kind of ["public_patch", "sensitive_patch"] as const) {
          const result = await runBoundedCanonicalHistoryPatch(root, commit, kind, remaining());
          const patch = requireGitHistoryOutput("Synthetic history rendering", result);
          rendered.push({ commit, digest: createHash("sha256").update(patch, "utf8").digest("hex"), kind, patch, phase });
        }
      }
      // Pins bind canonical Git bytes independently of the normalizer's own hash check.
      expect(rendered.map(({ digest, kind, phase }) => ({ digest, kind, phase })))
        .toEqual(rendered.map(({ kind, phase }) => ({ digest: patchDigests[phase][kind], kind, phase })));
      for (const { commit, kind, patch, phase } of rendered) {
        const digest = patchDigests[phase][kind];
        expect(patch.split(syntheticPath)).toHaveLength(2);
        const normalized = normalizeReviewedSyntheticHistoryPatch(patch, digest, [fixture]);
        expect(normalized).toBe(patch.replace(syntheticPath, "[reviewed-synthetic-absolute-path]"));
        const assertReviewedPatch = kind === "public_patch" ? assertPublicText : assertPublicSensitiveText;
        expect(() => assertReviewedPatch(normalized, "synthetic history fixture")).not.toThrow();
        expect(() => normalizeReviewedSyntheticHistoryPatch(`${patch}mutation\n`, digest, [fixture]))
          .toThrow("synthetic-path evidence changed");
        const otherPhase = phase === "original" ? "repair" : "original";
        expect(() => normalizeReviewedSyntheticHistoryPatch(patch, patchDigests[otherPhase][kind], [fixture]))
          .toThrow("synthetic-path evidence changed");
        if (fixture === "memory_summary") {
          const otherKind = kind === "public_patch" ? "sensitive_patch" : "public_patch";
          expect(() => normalizeReviewedSyntheticHistoryPatch(patch, patchDigests[phase][otherKind], [fixture]))
            .toThrow("synthetic-path evidence changed");
        }
        // Scratch evidence never acquires authority in the real historical scan.
        expect(selectReviewedGitHistoryPatchEvidence(commit, kind)).toBeUndefined();
        expect(normalizeGitHistoryPatchForPublicScan(commit, kind, patch)).toBe(patch);
        expect(() => assertReviewedPatch(patch, "unreviewed scratch history"))
          .toThrow("ABSOLUTE_USER_PATH");
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }

  }, 30_000);

  test("renders both synthetic fixtures in a self-contained first-parent merge patch", async () => {
    const remaining = createHistoryRenderingBudget();
    const root = resolve(await mkdtemp(join(tmpdir(), "oompa-history-synthetic-merge-")));
    const git = async (...arguments_: readonly string[]) => requireHistoryFixtureGitOutput(
      await runHistoryFixtureGit(root, arguments_, remaining()),
    );
    const messagePath = ["", "Users", "private", "project", ""].join("/");
    const summaryPath = ["", "Users", "operator", "private"].join("/");
    const patchDigests = {
      public_patch: "e2c35a07337e0d199ef8d8159a0bafb55e3dfc1cafd3d2b926ed18700b301822",
      sensitive_patch: "46127d9492578f992291367db7d4a591b2a50654cb1d4e2ab5f6a4862215ee36",
    };
    try {
      await initializeHistoryFixture(root, "base\n", git);
      const document = join(root, "document.txt");
      await git("checkout", "-b", "feature");
      await writeFile(document, "feature\n", "utf8");
      await git("commit", "-am", "feature");
      await git("checkout", "main");
      await writeFile(document, "main\n", "utf8");
      await git("commit", "-am", "main");
      expect((await runHistoryFixtureGit(root, ["merge", "--no-ff", "--no-edit", "feature"], remaining())).exitCode)
        .not.toBe(0);
      await writeFile(document, `resolved\n${messagePath}\n${summaryPath}\n`, "utf8");
      await writeFile(join(root, "bun.lock"), "merge-only lock marker\n", "utf8");
      await git("add", "--all");
      await git("commit", "-m", "synthetic resolution");
      const commit = await git("rev-parse", "HEAD");
      expect((await git("rev-list", "--parents", "-n", "1", commit)).split(" ")).toHaveLength(3);
      const rendered = [];
      for (const kind of ["public_patch", "sensitive_patch"] as const) {
        const result = await runBoundedCanonicalHistoryPatch(root, commit, kind, remaining());
        const patch = requireGitHistoryOutput("Synthetic merge rendering", result);
        rendered.push({ digest: createHash("sha256").update(patch, "utf8").digest("hex"), kind, patch });
      }
      expect(rendered.map(({ digest, kind }) => ({ digest, kind })))
        .toEqual(rendered.map(({ kind }) => ({ digest: patchDigests[kind], kind })));
      for (const { kind, patch } of rendered) {
        expect(patch).toContain("-main\n+resolved\n");
        expect(patch).not.toContain("-feature\n");
        expect(patch.split(messagePath)).toHaveLength(2);
        expect(patch.split(summaryPath)).toHaveLength(2);
        const normalized = normalizeReviewedSyntheticHistoryPatch(
          patch, patchDigests[kind], ["sanitized_message", "memory_summary"],
        );
        expect(normalized).toBe(patch
          .replace(messagePath, "[reviewed-synthetic-absolute-path]")
          .replace(summaryPath, "[reviewed-synthetic-absolute-path]"));
        const assertReviewedPatch = kind === "public_patch" ? assertPublicText : assertPublicSensitiveText;
        expect(() => assertReviewedPatch(normalized, "synthetic merge fixture")).not.toThrow();
        expect(() => normalizeReviewedSyntheticHistoryPatch(
          `${patch}changed\n`, patchDigests[kind], ["sanitized_message", "memory_summary"],
        )).toThrow("synthetic-path evidence changed");
        const otherKind = kind === "public_patch" ? "sensitive_patch" : "public_patch";
        expect(() => normalizeReviewedSyntheticHistoryPatch(
          patch, patchDigests[otherKind], ["sanitized_message", "memory_summary"],
        )).toThrow("synthetic-path evidence changed");
        expect(selectReviewedGitHistoryPatchEvidence(commit, kind)).toBeUndefined();
        expect(normalizeGitHistoryPatchForPublicScan(commit, kind, patch)).toBe(patch);
        expect(() => assertReviewedPatch(patch, "unreviewed merge fixture"))
          .toThrow("ABSOLUTE_USER_PATH");
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }

  }, 30_000);

  test("bounds history fixture children independently of ambient configuration and the outer deadline", () => {
    const root = resolve(tmpdir());
    expect(historyFixtureCommandOptions(root)).toEqual({
      cwd: root,
      env: { ...buildGitHistoryEnvironment(root, root), GIT_MERGE_AUTOEDIT: "no" },
      outputMaximumBytes: 32 * 1024 * 1024,
      phase: "package-history-fixture-git",
      timeoutMs: 5_000,
    });
    expect(historyFixtureCommandOptions(root, 1_000, "package-history-fixture-render"))
      .toMatchObject({ phase: "package-history-fixture-render", timeoutMs: 1_000 });
    let now = 0;
    const remaining = createHistoryRenderingBudget(() => now);
    expect(remaining()).toBe(5_000);
    now = 19_000;
    expect(remaining()).toBe(1_000);
    now = 19_999;
    expect(remaining()).toBe(1);
    now = 20_000;
    expect(remaining).toThrow("exhausted its time budget");
  });

  test("makes reviewed patch rendering independent of hostile repository configuration", async () => {
    const remaining = createHistoryRenderingBudget();
    // Fixed phase labels identify a stall even if the outer test timeout fires.
    // Never print fixture paths, command arguments, configuration, or Git output.
    const phase = (value: "setup" | "render_baseline" | "config" | "render_hostile" | "cleanup") => {
      console.error(`[oompa-history-rendering-fixture] ${value}`);
    };
    phase("setup");
    const root = resolve(await mkdtemp(join(tmpdir(), "oompa-history-rendering-")));
    const git = async (...arguments_: readonly string[]) => requireHistoryFixtureGitOutput(
      await runHistoryFixtureGit(root, arguments_, remaining()),
    );
    try {
      await initializeHistoryFixture(root, "first\n\nsecond\nthird\n", git);
      const contextPath = join(root, "context.txt");
      await writeFile(
        contextPath,
        "alpha\nnear-alpha\n\nblank-context\nkeep-five\nkeep-six\nkeep-seven\nkeep-eight\nnear-omega\nomega\n",
        "utf8",
      );
      await git("add", "context.txt");
      await git("commit", "-m", "context base");
      const source = join(root, "document.txt");
      const destination = join(root, "\u03c0-document.txt");
      await rename(source, destination);
      await writeFile(destination, "first changed\n\nsecond\nthird changed\n", "utf8");
      await writeFile(
        contextPath,
        "alpha changed\nnear-alpha\n\nblank-context\nkeep-five\nkeep-six\nkeep-seven\nkeep-eight\nnear-omega\nomega changed\n",
        "utf8",
      );
      await git("add", "--all");
      await git("commit", "-m", "rendering target");
      const commit = await git("rev-parse", "HEAD");
      phase("render_baseline");
      const baseline = await runBoundedCanonicalHistoryPatch(
        root,
        commit,
        "sensitive_patch",
        remaining(),
      );
      expect(baseline.exitCode).toBe(0);
      expect(baseline.stderr).toBe("");

      phase("config");
      for (const [key, value] of [
        ["color.ui", "always"],
        ["core.abbrev", "5"],
        ["core.attributesFile", "/unavailable/hostile-attributes"],
        ["core.quotePath", "false"],
        ["diff.algorithm", "histogram"],
        ["diff.context", "0"],
        ["diff.indentHeuristic", "true"],
        ["diff.interHunkContext", "99"],
        ["diff.mnemonicPrefix", "true"],
        ["diff.noprefix", "true"],
        ["diff.orderFile", "/unavailable/hostile-order"],
        ["diff.renames", "true"],
        ["diff.relative", "true"],
        ["diff.submodule", "log"],
        ["diff.suppressBlankEmpty", "true"],
      ] as const) await git("config", key, value);

      phase("render_hostile");
      const hostile = await runBoundedCanonicalHistoryPatch(
        root,
        commit,
        "sensitive_patch",
        remaining(),
      );
      expect(hostile.exitCode).toBe(0);
      expect(hostile.stderr).toBe("");
      expect(hostile.stdout).toEqual(baseline.stdout);
    } finally {
      phase("cleanup");
      await rm(root, { force: true, recursive: true }).catch(() => {
        throw new Error("Git history rendering fixture cleanup failed.");
      });
    }
  }, 30_000);

  test("keeps failed history command payloads out of diagnostics", () => {
    const sentinel = ["sk", "proj", "A".repeat(24)].join("-");
    const error = (() => {
      try {
        requireGitHistoryOutput("Git history fixture", {
          exitCode: 1,
          stderr: sentinel,
          stdout: sentinel,
        });
      } catch (caught: unknown) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toBe("Error: Git history fixture failed or emitted diagnostics with exit 1.");
    expect(String(error)).not.toContain(sentinel);
  });

  test("keeps synchronous history reads ambient-free, bounded, and nondisclosing", () => {
    const environment = buildGitHistoryEnvironment("/private/oompa-source", "/private/oompa-temp");
    expect(environment).toEqual({
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_PAGER: "cat",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/private/oompa-source",
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
      TMPDIR: "/private/oompa-temp",
      XDG_CONFIG_HOME: "/dev/null",
    });
    expect(() => buildGitHistoryEnvironment("relative", "/private/oompa-temp"))
      .toThrow("absolute and normalized");

    const safe = projectGitHistorySpawnResult({
      exitCode: 0,
      exitedDueToMaxBuffer: false,
      exitedDueToTimeout: false,
      stderr: Buffer.alloc(0),
      stdout: Buffer.from("safe\n"),
    });
    expect(safe).toEqual({ exitCode: 0, stderr: "", stdout: "safe\n" });

    const sentinel = Buffer.from([0x73, 0x6b, 0x2d, 0x73, 0x65, 0x63, 0x72, 0x65, 0x74]);
    for (const result of [
      projectGitHistorySpawnResult({
        exitCode: 1,
        exitedDueToMaxBuffer: false,
        exitedDueToTimeout: false,
        stderr: sentinel,
        stdout: sentinel,
      }),
      projectGitHistorySpawnResult({
        exitCode: 0,
        exitedDueToMaxBuffer: false,
        exitedDueToTimeout: true,
        stderr: Buffer.alloc(0),
        stdout: sentinel,
      }),
      projectGitHistorySpawnResult({
        exitCode: 0,
        exitedDueToMaxBuffer: true,
        exitedDueToTimeout: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(32 * 1024 * 1024 + 1),
      }),
      projectGitHistorySpawnResult({
        exitCode: 0,
        exitedDueToMaxBuffer: false,
        exitedDueToTimeout: false,
        stderr: Buffer.alloc(0),
        stdout: Buffer.alloc(12 * 1024 * 1024, 0xff),
      }),
    ]) {
      expect(result).toEqual({ exitCode: 1, stderr: "", stdout: "" });
      expect(`${result.stderr}${result.stdout}`).not.toContain("secret");
    }
  });

  test("scans resolution-only merge content against the first parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "oompa-history-merge-"));
    try {
      await initializeHistoryFixture(root);
      const document = join(root, "document.txt");
      await requireHistoryFixtureGit(root, "checkout", "-b", "feature");
      await writeFile(document, "feature\n", "utf8");
      await requireHistoryFixtureGit(root, "commit", "-am", "feature");
      await requireHistoryFixtureGit(root, "checkout", "main");
      await writeFile(document, "main\n", "utf8");
      await requireHistoryFixtureGit(root, "commit", "-am", "main");
      expect((await runHistoryFixtureGit(
        root,
        ["merge", "--no-ff", "--no-edit", "feature"],
      )).exitCode).not.toBe(0);
      const sentinel = ["sk", "proj", "B".repeat(24)].join("-");
      await writeFile(document, `resolved\n${sentinel}\n`, "utf8");
      await requireHistoryFixtureGit(root, "add", "document.txt");
      await requireHistoryFixtureGit(root, "commit", "-m", "resolution");

      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  test("scans roots, deleted content, side refs, and unreplaced objects", async () => {
    const sentinel = ["sk", "proj", "C".repeat(24)].join("-");
    for (const scenario of ["deleted-root", "side-ref", "replacement"] as const) {
      const root = await mkdtemp(join(tmpdir(), `oompa-history-${scenario}-`));
      try {
        const rootCommit = await initializeHistoryFixture(
          root,
          scenario === "deleted-root" ? `${sentinel}\n` : "safe\n",
        );
        const document = join(root, "document.txt");
        if (scenario === "deleted-root") {
          await writeFile(document, "safe\n", "utf8");
          await requireHistoryFixtureGit(root, "commit", "-am", "delete historical sentinel");
        } else if (scenario === "side-ref") {
          await requireHistoryFixtureGit(root, "checkout", "-b", "side");
          await writeFile(document, `${sentinel}\n`, "utf8");
          await requireHistoryFixtureGit(root, "commit", "-am", "side sentinel");
          await requireHistoryFixtureGit(root, "checkout", "main");
        } else {
          await writeFile(document, `${sentinel}\n`, "utf8");
          await requireHistoryFixtureGit(root, "commit", "-am", "replace-hidden sentinel");
          const secretCommit = await requireHistoryFixtureGit(root, "rev-parse", "HEAD");
          await requireHistoryFixtureGit(root, "replace", secretCommit, rootCommit);
        }
        await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  }, 30_000);

  test("forces binary-classified historical blobs through text policy", async () => {
    const root = await mkdtemp(join(tmpdir(), "oompa-history-binary-text-"));
    try {
      await initializeHistoryFixture(root);
      const sentinel = Buffer.from([
        0x73,
        0x6b,
        0x2d,
        0x70,
        0x72,
        0x6f,
        0x6a,
        0x2d,
        ...Buffer.alloc(24, 0x45),
      ]);
      await writeFile(
        join(root, "document.txt"),
        Buffer.concat([Buffer.from([0x00]), sentinel, Buffer.from("\n")]),
      );
      await requireHistoryFixtureGit(root, "commit", "-am", "binary-classified sentinel");
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  test("keeps lockfile scope exemption narrow and refuses shallow history", async () => {
    const root = await mkdtemp(join(tmpdir(), "oompa-history-lock-policy-"));
    try {
      const head = await initializeHistoryFixture(root);
      const lockfile = join(root, "bun.lock");
      await writeFile(lockfile, `${["@", "private", "-", "scope", "/", "package"].join("")}\n`, "utf8");
      await requireHistoryFixtureGit(root, "add", "bun.lock");
      await requireHistoryFixtureGit(root, "commit", "-m", "lock scope");
      await expect(assertCompleteGitHistoryPublic(root)).resolves.toBeUndefined();

      const sentinel = ["sk", "proj", "D".repeat(24)].join("-");
      await writeFile(lockfile, `${sentinel}\n`, "utf8");
      await requireHistoryFixtureGit(root, "commit", "-am", "lock secret");
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("SECRET_SHAPE");

      await writeFile(join(root, ".git", "shallow"), `${head}\n`, "utf8");
      await expect(assertCompleteGitHistoryPublic(root)).rejects.toThrow("non-shallow repository");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);

  test("routes every effectful and consumer command through the detached-group runner", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source).toContain("const run = runPackageCommand;");
    for (const command of [
      'await run("npm", ["pack", "--ignore-scripts", "--pack-destination"',
      '["-xzpf", archive, "-C", inspectionDirectory]',
      '["add", "--backend=copyfile", "--ignore-scripts", archive]',
      '["-e", "await import(\'@hraness/oompa\')"]',
      'run(executable, ["--help"]',
      'run(executable, ["--version"]',
      'run(executable, ["doctor", "--offline", "--json"]',
      '[join(repositoryRoot, "src", "install-preflight.ts"), archive]',
      'phase: "package-transactional-global-install"',
    ]) expect(source).toContain(command);
  });

  test("verifies the installed command directly without touching Bun global metadata", async () => {
    const source = await readFile(join(import.meta.dir, "check-package.ts"), "utf8");
    expect(source).toContain("activeGlobalCommand.isSymbolicLink()");
    expect(source).toContain("activeGlobalCommand.nlink !== 1");
    expect(source).toContain("activeGlobalCommand.uid !== uid");
    expect(source).not.toContain('["pm", "bin", "--global"]');
  });

  for (const scenario of [
    { name: "deadline", overflow: false, timeoutMs: 2_000 },
    { name: "combined output overflow", overflow: true, timeoutMs: 10_000 },
  ] as const) {
    test(`kills every hostile descendant and returns bounded output after ${scenario.name}`, async () => {
      if (process.platform !== "darwin" && process.platform !== "linux") return;
      const root = await mkdtemp(join(tmpdir(), "hra-package-runner-hostile-"));
      const pidFile = join(root, "owned-pids.json");
      let ownedPids: number[] = [];
      try {
        const startedAt = Date.now();
        const result = await runPackageCommand(
          process.execPath,
          ["-e", hostilePtyProcessTreeSource(scenario.overflow)],
          {
            cwd: root,
            env: { ...process.env, OOMPA_HOSTILE_PID_FILE: pidFile },
            outputMaximumBytes: 64,
            timeoutMs: scenario.timeoutMs,
          },
        );
        expect(Date.now() - startedAt).toBeLessThan(scenario.overflow ? 2_000 : 4_000);
        expect(result.exitCode).toBe(scenario.overflow ? 1 : 124);
        expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64);
        ownedPids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
        expect(ownedPids).toHaveLength(3);
        expect(new Set(ownedPids).size).toBe(3);
        for (const pid of ownedPids) {
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          expect(processIsAlive(pid)).toBe(false);
        }
        ownedPids = [];
      } finally {
        for (const pid of ownedPids) {
          if (Number.isSafeInteger(pid) && pid > 1 && processIsAlive(pid)) {
            try { process.kill(pid, "SIGKILL"); } catch { /* The exact fixture process may just have exited. */ }
          }
        }
        await rm(root, { force: true, recursive: true });
      }
    }, 15_000);
  }
});

describe("installed package pseudo-terminal acceptance", () => {
  test.each(["signal", "probe"] as const)("resolves a transient %s EPERM only after disappearance proof", async (deniedOperation) => {
    const denied = Object.assign(new Error("group exit transition"), { code: "EPERM" });
    const events: string[] = [];
    let now = 0;
    const cleanup = createPseudoTerminalGroupCleanup({
      groupIds: () => [23456, 23457],
      signal: (groupId, signal) => {
        events.push(`${String(groupId)}:${signal}`);
        if (groupId === 23456 && deniedOperation === "signal") throw denied;
        return true;
      },
      exists: (groupId) => {
        events.push(`${String(groupId)}:probe`);
        if (groupId === 23457 || now > 0) return false;
        if (deniedOperation === "probe") throw denied;
        return true;
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    cleanup.signalOwnedGroups("SIGTERM");
    expect(events).toEqual(["23456:SIGTERM", "23457:SIGTERM"]);
    expect(() => cleanup.assertGroupsGone()).toThrow();
    expect(await cleanup.waitForGroupsGone(400)).toBe(true);
    expect(now).toBe(20);
    expect(() => cleanup.assertGroupsGone()).not.toThrow();
    expect(events).toEqual([
      "23456:SIGTERM", "23457:SIGTERM", "23456:probe", "23457:probe", "23456:probe",
    ]);
    // A reused number must never be probed or signalled after its absence was proved.
    const collectedEvents = [...events];
    cleanup.signalOwnedGroups("SIGKILL");
    expect(await cleanup.waitForGroupsGone(800)).toBe(true);
    expect(events).toEqual(collectedEvents);
  });

  test("persistent EPERM exhausts the existing bounded phases and still collects the other group", async () => {
    const denied = Object.assign(new Error("group permission remains denied"), { code: "EPERM" });
    const signals: string[] = [];
    let now = 0;
    const cleanup = createPseudoTerminalGroupCleanup({
      groupIds: () => [23456, 23457],
      signal: (groupId, signal) => {
        signals.push(`${String(groupId)}:${signal}`);
        if (groupId === 23456) throw denied;
        return true;
      },
      exists: (groupId) => {
        if (groupId === 23456) throw denied;
        return false;
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    cleanup.signalOwnedGroups("SIGTERM");
    expect(await cleanup.waitForGroupsGone(400)).toBe(false);
    expect(now).toBe(420);
    cleanup.signalOwnedGroups("SIGKILL");
    expect(await cleanup.waitForGroupsGone(800)).toBe(false);
    expect(now).toBe(1_240);
    expect(signals).toEqual(["23456:SIGTERM", "23457:SIGTERM", "23456:SIGKILL"]);
    const result = await observePseudoTerminalCleanup(Promise.resolve().then(() => cleanup.assertGroupsGone()));
    expect(result).toEqual({ status: "rejected", reason: denied });
  });

  test("a successful presence probe cannot resolve a previous signal denial", async () => {
    const denied = Object.assign(new Error("signal denied"), { code: "EPERM" });
    let now = 0;
    let present = true;
    const cleanup = createPseudoTerminalGroupCleanup({
      groupIds: () => [23456],
      signal: () => { throw denied; },
      exists: () => present,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    cleanup.signalOwnedGroups("SIGTERM");
    expect(await cleanup.waitForGroupsGone(20)).toBe(false);
    expect(await observePseudoTerminalCleanup(Promise.resolve().then(() => cleanup.assertGroupsGone())))
      .toEqual({ status: "rejected", reason: denied });
    present = false;
    expect(await cleanup.waitForGroupsGone(20)).toBe(true);
    expect(() => cleanup.assertGroupsGone()).not.toThrow();
  });

  test.each(["signal", "probe"] as const)("retains an unexpected %s failure after attempting every owned group", async (failedOperation) => {
    const failed = Object.assign(new Error("unexpected group operation failure"), { code: "EIO" });
    const signals: string[] = [];
    let now = 0;
    let killed = false;
    const cleanup = createPseudoTerminalGroupCleanup({
      groupIds: () => [23456, 23457],
      signal: (groupId, signal) => {
        signals.push(`${String(groupId)}:${signal}`);
        if (groupId === 23456 && failedOperation === "signal") throw failed;
        if (groupId === 23457 && signal === "SIGKILL") killed = true;
        return true;
      },
      exists: (groupId) => {
        if (groupId === 23456) {
          if (failedOperation === "probe" && now === 0) throw failed;
          return false;
        }
        return !killed;
      },
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds; },
    });
    cleanup.signalOwnedGroups("SIGTERM");
    expect(await cleanup.waitForGroupsGone(400)).toBe(false);
    cleanup.signalOwnedGroups("SIGKILL");
    expect(await cleanup.waitForGroupsGone(800)).toBe(true);
    expect(signals).toEqual(["23456:SIGTERM", "23457:SIGTERM", "23457:SIGKILL"]);
    expect(await observePseudoTerminalCleanup(Promise.resolve().then(() => cleanup.assertGroupsGone())))
      .toEqual({ status: "rejected", reason: failed });
  });

  test("retires a group after signal ESRCH without probing or signalling its number again", async () => {
    const signals: number[] = [];
    const cleanup = createPseudoTerminalGroupCleanup({
      groupIds: () => [23456, 23457],
      signal: (groupId) => { signals.push(groupId); return false; },
      exists: () => { throw new Error("An absent group's numeric identity has been reused."); },
      now: () => 0,
      sleep: async () => { throw new Error("No groups remain to await."); },
    });
    cleanup.signalOwnedGroups("SIGTERM");
    expect(await cleanup.waitForGroupsGone(400)).toBe(true);
    cleanup.signalOwnedGroups("SIGKILL");
    expect(() => cleanup.assertGroupsGone()).not.toThrow();
    expect(signals).toEqual([23456, 23457]);
  });

  test("waits for the complete authority line across every stdout split", () => {
    const marker = "__OOMPA_PTY_AUTHORITY_fixture__";
    for (const ending of ["\n", "\r\n"] as const) {
      const line = `\n${marker}\t23456${ending}`;
      for (let split = 0; split < line.length; split += 1) {
        const first = line.slice(0, split);
        expect(readPseudoTerminalAuthorityLine(first, marker)).toBeUndefined();
        expect(readPseudoTerminalAuthorityLine(first + line.slice(split), marker)).toBe(23456);
      }
      expect(readPseudoTerminalAuthorityLine(`unrelated text\n${line}${PTY_BEGIN_MARKER}\n`, marker)).toBe(23456);
    }
    for (const value of ["23456suffix", "23456\t", "23456 ", "023456", "+23456", "-23456", "0", "1", "", "23456\r\r", "9007199254740992", String(process.pid)]) {
      expect(readPseudoTerminalAuthorityLine(`\n${marker}\t${value}\n`, marker)).toBeUndefined();
    }
    expect(readPseudoTerminalAuthorityLine(`prefix${marker}\t23456\n`, marker)).toBeUndefined();
    expect(readPseudoTerminalAuthorityLine(`\n${marker}-other\t23456\n`, marker)).toBeUndefined();
  });

  test("observes early cleanup rejection while retaining it for final settlement", async () => {
    const cleanup = Promise.withResolvers<undefined>();
    const observation = observePseudoTerminalCleanup(cleanup.promise);
    const denied = Object.assign(new Error("process-group observation refused"), { code: "EPERM" });
    cleanup.reject(denied);
    await Promise.resolve();
    const result = await observation;
    expect(result.status).toBe("rejected");
    if (result.status !== "rejected") throw new Error("Expected retained cleanup failure.");
    expect(result.reason).toBe(denied);
    expect(await observePseudoTerminalCleanup(Promise.reject(undefined)))
      .toEqual({ status: "rejected", reason: undefined });
    expect(await observePseudoTerminalCleanup(Promise.resolve()))
      .toEqual({ status: "fulfilled", value: undefined });
  });

  test("joins bounded termination after a refused post-driver probe before finalization", async () => {
    const denied = Object.assign(new Error("group probe denied"), { code: "EPERM" });
    const rawTermination = Promise.withResolvers<undefined>();
    const requested = Promise.withResolvers<undefined>();
    let termination: Promise<PromiseSettledResult<void>> | undefined;
    const events: string[] = [];
    const result = settlePseudoTerminalCleanup({
      termination: () => termination,
      observeExit: () => { events.push("probe"); return Promise.reject(denied); },
      requestTermination: () => {
        events.push("terminate-owned-groups");
        termination = observePseudoTerminalCleanup(rawTermination.promise);
        requested.resolve(undefined);
      },
      markLingering: () => { throw new Error("Permission denial is not an absence observation."); },
      finalize: () => { events.push("finalize-timers-and-stdio"); },
    });
    await requested.promise;
    expect(events).toEqual(["probe", "terminate-owned-groups"]);
    rawTermination.resolve(undefined);
    expect(await result).toBe(denied);
    expect(events).toEqual(["probe", "terminate-owned-groups", "finalize-timers-and-stdio"]);
  });

  test("retains an early termination rejection until deferred driver settlement and finalizes once", async () => {
    const failed = Object.assign(new Error("early cleanup failure"), { code: "EPERM" });
    const rawTermination = Promise.withResolvers<undefined>();
    const termination = observePseudoTerminalCleanup(rawTermination.promise);
    const driver = Promise.withResolvers<undefined>();
    let finalized = 0;
    const result = driver.promise.then(async () => await settlePseudoTerminalCleanup({
      termination: () => termination,
      observeExit: () => Promise.reject(new Error("Termination already owns exit observation.")),
      requestTermination: () => { throw new Error("Termination must not be requested twice."); },
      markLingering: () => { throw new Error("A cleanup rejection is not lingering proof."); },
      finalize: () => { finalized += 1; },
    }));
    rawTermination.reject(failed);
    await Promise.resolve();
    expect(finalized).toBe(0);
    driver.resolve(undefined);
    expect(await result).toBe(failed);
    expect(finalized).toBe(1);
  });

  test("uses each supported operating system's real script interface without interpolating macOS arguments", () => {
    expect(pseudoTerminalScriptArguments("darwin", "/tmp/wrapper path", [
      "/tmp/oompa path",
      "--help",
    ])).toEqual([
      "-q",
      "-e",
      "/dev/null",
      "/bin/sh",
      "/tmp/wrapper path",
      "/tmp/oompa path",
      "--help",
    ]);
    expect(pseudoTerminalScriptArguments("linux", "/tmp/wrapper path", [
      "/tmp/oompa path",
      "apostrophe'value",
    ])).toEqual([
      "-q",
      "-e",
      "-c",
      "'/bin/sh' '/tmp/wrapper path' '/tmp/oompa path' 'apostrophe'\\''value'",
      "/dev/null",
    ]);
    expect(() => pseudoTerminalScriptArguments("win32", "wrapper", ["oompa"]))
      .toThrow("unsupported on win32");
  });

  test("drives the actual shell terminal through account and session selection and exact slash payloads", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;
    const root = await mkdtemp(join(tmpdir(), "oompa-pty-test-"));
    const home = join(root, "home");
    const temporaryDirectory = join(root, "tmp");
    await mkdir(home, { mode: 0o700 });
    await mkdir(temporaryDirectory, { mode: 0o700 });
    try {
      const result = await runInPseudoTerminal({
        command: [process.execPath, resolve(import.meta.dir, "pty-shell-acceptance-fixture.ts")],
        cwd: root,
        environment: {
          ...process.env,
          CODEX_ELECTRON_USER_DATA_PATH: undefined,
          CODEX_HOME: undefined,
          HOME: home,
          HRA_CONVEX_URL: "",
          TMPDIR: temporaryDirectory,
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local", "share"),
          XDG_STATE_HOME: join(home, ".local", "state"),
        },
        steps: [
          { expect: PTY_BEGIN_MARKER },
          { expect: "Oompa shell. /help lists commands; /exit leaves the daemon running." },
          { expect: "oompa> ", write: "/account fixture\n" },
          { expect: `Selected account acct_${"1".repeat(32)}.` },
          { expect: "oompa[", write: "/session fixture\n" },
          { expect: `Selected session sess_${"2".repeat(32)}.` },
          { expect: "Live updates unavailable:" },
          { expect: "oompa[", write: "//slash-one\n" },
          { expect: "oompa[", write: "/send /slash-two\n" },
          { expect: "oompa[", write: "/watch\n" },
          { expect: "WATCH_STARTED", write: "\u0003" },
          { expect: "oompa[", write: "//after-watch\n" },
          { expect: "oompa[", write: "/exit\n" },
          { expect: "Deterministic PTY shell preserved // and /send payloads across watch cancellation." },
        ],
        temporaryDirectory,
        timeoutMs: 15_000,
      });
      assertPseudoTerminalSuccess(result);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 20_000);

  for (const scenario of [
    { expected: "exceeded its deadline", name: "deadline", overflow: false, timeoutMs: 500 },
    { expected: "exceeded its output bound", name: "output overflow", overflow: true, timeoutMs: 10_000 },
  ] as const) {
    test(`kills the exact hostile PTY process tree after ${scenario.name} and returns within a hard bound`, async () => {
      if (process.platform !== "darwin" && process.platform !== "linux") return;
      const root = await mkdtemp(join(tmpdir(), "oompa-pty-hostile-"));
      const temporaryDirectory = join(root, "tmp");
      const pidFile = join(root, "owned-pids.json");
      await mkdir(temporaryDirectory, { mode: 0o700 });
      let ownedPids: number[] = [];
      try {
        const startedAt = Date.now();
        const error = await runInPseudoTerminal({
          command: [process.execPath, "-e", hostilePtyProcessTreeSource(scenario.overflow)],
          cwd: root,
          environment: {
            ...process.env,
            OOMPA_HOSTILE_PID_FILE: pidFile,
          },
          steps: [
            { expect: PTY_BEGIN_MARKER },
            { expect: "hostile-ready" },
          ],
          temporaryDirectory,
          timeoutMs: scenario.timeoutMs,
        }).catch((caught: unknown) => caught);
        const elapsedMs = Date.now() - startedAt;
        // Capture exact fixture-owned fallback cleanup before an unexpected
        // result assertion can fail (for example, an unknown group probe).
        ownedPids = JSON.parse(await readFile(pidFile, "utf8")) as number[];
        expect(ownedPids).toHaveLength(3);
        expect(new Set(ownedPids).size).toBe(3);
        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain(scenario.expected);
        expect(elapsedMs).toBeLessThan(scenario.overflow ? 4_000 : 3_000);
        for (const pid of ownedPids) {
          expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
          expect(processIsAlive(pid)).toBe(false);
        }
        ownedPids = [];
      } finally {
        for (const pid of ownedPids) {
          if (Number.isSafeInteger(pid) && pid > 1 && processIsAlive(pid)) {
            try { process.kill(pid, "SIGKILL"); } catch { /* The exact fixture process may just have exited. */ }
          }
        }
        await rm(root, { force: true, recursive: true });
      }
    }, 15_000);
  }
});
