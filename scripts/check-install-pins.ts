// The transactional installer pins three digests: the packaged CLI entry
// point, the normalizer module, and (for the public one-line command) the
// tagged preflight runtime. Between releases the working tree may change the
// first two, so this script keeps them consistent and, at release time,
// proves that the public command names the runtime bytes being tagged.
//
//   bun ./scripts/check-install-pins.ts             working-tree check
//   bun ./scripts/check-install-pins.ts --update    re-pin CLI and normalizer digests
//   bun ./scripts/check-install-pins.ts --prepare-release v0.8.1
//                                                    re-pin the public runtime digest
//   bun ./scripts/check-install-pins.ts --release-tag v0.8.1
//                                                    working-tree check plus the public-command proof

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { OOMPA_INSTALL_ARCHIVE_URL, OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256, OOMPA_INSTALL_PREFLIGHT_SOURCE_URL } from "../src/install-preflight";
import { OOMPA_INSTALL_CLI_SHA256 } from "../src/install-normalizer";
import {
  OOMPA_INSTALL_CLI_SHA256 as OOMPA_RUNTIME_INSTALL_CLI_SHA256,
  OOMPA_INSTALL_NORMALIZER_SHA256,
} from "../src/install-preflight-runtime";

const cliPath = "src/cli.ts";
const normalizerPath = "src/install-normalizer.ts";
const runtimePath = "src/install-preflight-runtime.ts";
const maximumSourceBytes = 8 * 1024 * 1024;
const tagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

async function sha256File(repositoryRoot: string, path: string): Promise<string> {
  const bytes = await readFile(join(repositoryRoot, path));
  if (bytes.byteLength > maximumSourceBytes) throw new Error(`Refusing to hash oversized source: ${path}`);
  return createHash("sha256").update(bytes).digest("hex");
}

export type InstallPinReport = Readonly<{
  cli: { expected: string; runtimeExpected: string; actual: string };
  normalizer: { expected: string; actual: string };
  runtime: { publicCommand: string; actual: string };
}>;

export type CommittedInstallPinSources = Readonly<{
  cli: string;
  manifest: string;
  normalizer: string;
  preflight: string;
  runtime: string;
}>;

type ReleasePinUrls = Readonly<{
  archive: string;
  runtimeSource: string;
}>;

export async function readInstallPins(repositoryRoot: string): Promise<InstallPinReport> {
  return {
    cli: {
      expected: OOMPA_INSTALL_CLI_SHA256,
      runtimeExpected: OOMPA_RUNTIME_INSTALL_CLI_SHA256,
      actual: await sha256File(repositoryRoot, cliPath),
    },
    normalizer: { expected: OOMPA_INSTALL_NORMALIZER_SHA256, actual: await sha256File(repositoryRoot, normalizerPath) },
    runtime: { publicCommand: OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256, actual: await sha256File(repositoryRoot, runtimePath) },
  };
}

// Working-tree drift: the CLI and normalizer digests embedded in the installer
// must describe the bytes in this tree, or a locally packed archive would be
// refused by the local preflight.
export function workingTreePinDrift(report: InstallPinReport): string[] {
  const drift: string[] = [];
  if (report.cli.expected !== report.cli.actual) drift.push(`${cliPath} digest ${report.cli.actual} is not the pinned ${report.cli.expected}`);
  if (report.cli.runtimeExpected !== report.cli.actual) {
    drift.push(`${cliPath} digest ${report.cli.actual} is not the runtime pin ${report.cli.runtimeExpected}`);
  }
  if (report.normalizer.expected !== report.normalizer.actual) drift.push(`${normalizerPath} digest ${report.normalizer.actual} is not the pinned ${report.normalizer.expected}`);
  return drift;
}

// Release proof: the public one-line command downloads the runtime at the
// tag being released and checks it against the pinned digest, so at the tag
// the working tree's runtime bytes must be exactly those bytes and every URL
// must name that tag.
export function releasePinDrift(
  report: InstallPinReport,
  releaseTag: string,
  packageVersion: string,
  urls: ReleasePinUrls = {
    archive: OOMPA_INSTALL_ARCHIVE_URL,
    runtimeSource: OOMPA_INSTALL_PREFLIGHT_SOURCE_URL,
  },
): string[] {
  const drift = workingTreePinDrift(report);
  const tag = z.string().regex(tagPattern).parse(releaseTag);
  if (tag !== `v${packageVersion}`) drift.push(`release tag ${tag} does not match package.json version ${packageVersion}`);
  if (!digestPattern.test(report.runtime.publicCommand)) drift.push("public command digest is not a SHA-256 hex digest");
  if (report.runtime.publicCommand !== report.runtime.actual) {
    drift.push(`${runtimePath} digest ${report.runtime.actual} is not the public command digest ${report.runtime.publicCommand}`);
  }
  const expectedRuntimeUrl = `https://raw.githubusercontent.com/hraness/oompa/${tag}/src/install-preflight-runtime.ts`;
  if (urls.runtimeSource !== expectedRuntimeUrl) drift.push(`public command runtime URL is not ${expectedRuntimeUrl}`);
  const expectedArchiveUrl = `https://github.com/hraness/oompa/releases/download/${tag}/hraness-oompa-${packageVersion}.tgz`;
  if (urls.archive !== expectedArchiveUrl) drift.push(`public command archive URL is not ${expectedArchiveUrl}`);
  return drift;
}

function requireExportedString(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const matches = [...source.matchAll(new RegExp(
    `export\\s+const\\s+${escaped}\\s*=\\s*(["'])([^"'\\r\\n]*)\\1\\s*;`,
    "gu",
  ))];
  const value = matches[0]?.[2];
  if (matches.length !== 1 || value === undefined) {
    throw new Error(`Committed installer source must export one literal ${name}.`);
  }
  return value;
}

function sha256Source(source: string, path: string): string {
  const bytes = Buffer.from(source, "utf8");
  if (bytes.byteLength > maximumSourceBytes) {
    throw new Error(`Refusing to hash oversized committed source: ${path}`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/** Prove the immutable commit blobs rather than a concurrently mutable checkout. */
export function assertCommittedInstallPinsForRelease(
  sources: CommittedInstallPinSources,
  releaseTag: string,
): void {
  const manifest = z.object({ version: z.string().min(1).max(64) }).passthrough().parse(
    JSON.parse(sources.manifest) as unknown,
  );
  const report: InstallPinReport = {
    cli: {
      actual: sha256Source(sources.cli, cliPath),
      expected: requireExportedString(sources.normalizer, "OOMPA_INSTALL_CLI_SHA256"),
      runtimeExpected: requireExportedString(sources.runtime, "OOMPA_INSTALL_CLI_SHA256"),
    },
    normalizer: {
      actual: sha256Source(sources.normalizer, normalizerPath),
      expected: requireExportedString(sources.runtime, "OOMPA_INSTALL_NORMALIZER_SHA256"),
    },
    runtime: {
      actual: sha256Source(sources.runtime, runtimePath),
      publicCommand: requireExportedString(
        sources.preflight,
        "OOMPA_INSTALL_PREFLIGHT_SOURCE_SHA256",
      ),
    },
  };
  const drift = releasePinDrift(report, releaseTag, manifest.version, {
    archive: requireExportedString(sources.runtime, "OOMPA_INSTALL_ARCHIVE_URL"),
    runtimeSource: requireExportedString(
      sources.preflight,
      "OOMPA_INSTALL_PREFLIGHT_SOURCE_URL",
    ),
  });
  if (drift.length > 0) {
    throw new Error(`Committed installer pins are not release-consistent: ${drift.join("; ")}`);
  }
}

export async function assertInstallPinsForRelease(repositoryRoot: string, releaseTag: string): Promise<void> {
  const manifest = z.object({ version: z.string().min(1).max(64) }).passthrough().parse(JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown);
  const drift = releasePinDrift(await readInstallPins(repositoryRoot), releaseTag, manifest.version);
  if (drift.length > 0) throw new Error(`Installer pins are not release-consistent: ${drift.join("; ")}`);
}

async function replaceDigest(repositoryRoot: string, path: string, previous: string, next: string): Promise<number> {
  const text = await readFile(join(repositoryRoot, path), "utf8");
  const count = text.split(previous).length - 1;
  if (count > 0) await writeFile(join(repositoryRoot, path), text.split(previous).join(next));
  return count;
}

// Re-pin order matters: the normalizer embeds the CLI digest, so its own digest
// changes after the CLI digest is rewritten; the runtime embeds both.
type InstallPinUpdateDependencies = Readonly<{
  hashFile?: (repositoryRoot: string, path: string) => Promise<string>;
  readPins?: (repositoryRoot: string) => Promise<InstallPinReport>;
}>;

export async function updateInstallPins(
  repositoryRoot: string,
  dependencies: InstallPinUpdateDependencies = {},
): Promise<string[]> {
  const notes: string[] = [];
  const before = await (dependencies.readPins ?? readInstallPins)(repositoryRoot);
  if (before.cli.expected !== before.cli.actual) {
    const count = await replaceDigest(
      repositoryRoot,
      normalizerPath,
      before.cli.expected,
      before.cli.actual,
    );
    notes.push(`${normalizerPath}: replaced ${String(count)} CLI digest site(s)`);
  }
  if (before.cli.runtimeExpected !== before.cli.actual) {
    const count = await replaceDigest(
      repositoryRoot,
      runtimePath,
      before.cli.runtimeExpected,
      before.cli.actual,
    );
    notes.push(`${runtimePath}: replaced ${String(count)} CLI digest site(s)`);
  }
  const normalizerActual = await (dependencies.hashFile ?? sha256File)(
    repositoryRoot,
    normalizerPath,
  );
  if (before.normalizer.expected !== normalizerActual) {
    const count = await replaceDigest(repositoryRoot, runtimePath, before.normalizer.expected, normalizerActual);
    notes.push(`${runtimePath}: replaced ${String(count)} normalizer digest site(s)`);
  }
  if (notes.length === 0) notes.push("installer pins already match the working tree");
  return notes;
}

/**
 * Move only the public command's runtime digest after the ordinary inner pins
 * and release URLs already name the exact package tag. Keeping this separate
 * preserves the last immutable release command during normal development.
 */
export async function updateInstallPinsForRelease(
  repositoryRoot: string,
  releaseTag: string,
  dependencies: Pick<InstallPinUpdateDependencies, "readPins"> = {},
): Promise<string[]> {
  const manifest = z.object({ version: z.string().min(1).max(64) }).passthrough().parse(
    JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown,
  );
  const report = await (dependencies.readPins ?? readInstallPins)(repositoryRoot);
  const readinessDrift = releasePinDrift({
    ...report,
    runtime: {
      actual: report.runtime.actual,
      publicCommand: report.runtime.actual,
    },
  }, releaseTag, manifest.version);
  if (readinessDrift.length > 0) {
    throw new Error(
      `Installer pins are not ready for release preparation: ${readinessDrift.join("; ")}`,
    );
  }
  if (report.runtime.publicCommand === report.runtime.actual) {
    return ["public command runtime digest already matches the release tree"];
  }
  if (!digestPattern.test(report.runtime.publicCommand)) {
    throw new Error("Public command runtime pin is not one canonical SHA-256 digest.");
  }
  const path = join(repositoryRoot, "src/install-preflight.ts");
  const source = await readFile(path, "utf8");
  const count = source.split(report.runtime.publicCommand).length - 1;
  if (count !== 1) {
    throw new Error(
      `Release preparation expected one public runtime digest site, found ${String(count)}.`,
    );
  }
  await writeFile(
    path,
    source.replace(report.runtime.publicCommand, report.runtime.actual),
  );
  return [`src/install-preflight.ts: replaced 1 public runtime digest site for ${releaseTag}`];
}

if (import.meta.main) {
  const repositoryRoot = process.cwd();
  const arguments_ = process.argv.slice(2);
  const update = arguments_.length === 1 && arguments_[0] === "--update";
  const prepareRelease = arguments_.length === 2 && arguments_[0] === "--prepare-release";
  const checkRelease = arguments_.length === 2 && arguments_[0] === "--release-tag";
  const checkWorkingTree = arguments_.length === 0;
  if (!update && !prepareRelease && !checkRelease && !checkWorkingTree) {
    throw new Error(
      "Usage: check-install-pins.ts [--update | --prepare-release <tag> | --release-tag <tag>]",
    );
  }
  if (update) {
    for (const note of await updateInstallPins(repositoryRoot)) process.stdout.write(`${note}\n`);
    process.stdout.write("Re-run without --update after the module cache refreshes, and commit the pinned files together.\n");
  } else if (prepareRelease) {
    const releaseTag = arguments_[1] ?? "";
    for (const note of await updateInstallPinsForRelease(repositoryRoot, releaseTag)) {
      process.stdout.write(`${note}\n`);
    }
    process.stdout.write(
      `Re-run with --release-tag ${releaseTag} after the module cache refreshes.\n`,
    );
  } else {
    const report = await readInstallPins(repositoryRoot);
    const drift = !checkRelease
      ? workingTreePinDrift(report)
      : releasePinDrift(report, arguments_[1] ?? "", z.object({ version: z.string() }).passthrough().parse(JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as unknown).version);
    if (drift.length > 0) {
      process.stderr.write("Installer pins drifted. Run `bun run install-pins:update` for working-tree drift; release drift needs the release-preparation change.\n");
      for (const line of drift) process.stderr.write(`  ${line}\n`);
      process.exit(1);
    }
    process.stdout.write(checkRelease ? "Installer pins are release-consistent.\n" : "Installer pins match the working tree.\n");
  }
}
