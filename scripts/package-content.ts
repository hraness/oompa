import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { buildOompaGlobalInstallCommand } from "../src/install-preflight";

// Package documentation is authored in root README.md. This admission contract
// reads no website content and never renders or rewrites the package document.
export const packageDescription = "Bun CLI and local daemon for isolated Codex, Claude Code, and Devin profiles, durable sessions, and optional encrypted sync. Local CLI v0.8.4 passed GitHub and npm artifact admission; daemon and hosted command-writer rollout remains blocked on capacity.";

const manifestSchema = z.object({
  description: z.literal(packageDescription),
  name: z.literal("@hraness/oompa"),
  version: z.literal("0.8.4"),
});

export const packageInstallCommand = buildOompaGlobalInstallCommand(
  "https://github.com/hraness/oompa/releases/download/v0.8.4/hraness-oompa-0.8.4.tgz",
);

export const packageAdmissionNotice = "The v0.8.4 CLI artifact and its exact-byte npm mirror passed release admission. Use the reviewed immutable GitHub installer below; installation does not authorize daemon startup.";
export const packageInstallPrerequisite = "Install and verify the admitted v0.8.4 CLI artifact. This does not start the daemon:";
export const packageDaemonNotice = "Current daemon and hosted command-writer rollout remains blocked on capacity. Do not initialize, start, or autostart the v0.8.4 daemon or any older daemon until the hosted operator records protected two-pass zero-debt capacity evidence and its exact .activated readback receipt. Artifact availability and the live sync service do not clear this gate. After activation, complete the update runbook's daemon and target marker-2 proofs before globally enabling hosted writers.";

const readmeSchema = z.string().min(1).max(64 * 1024)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 64 * 1024);

export function assertPackageContent(manifest: unknown, readme: unknown): void {
  manifestSchema.parse(manifest);
  const text = readmeSchema.parse(readme);
  const required = [
    "# Oompa\n\n`@hraness/oompa` supplies the `oompa` command and local daemon.",
    "Local CLI v0.8.4 passed immutable GitHub and exact-byte npm release admission.",
    "https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v084-artifacts",
    "https://github.com/hraness/oompa/releases/tag/v0.8.4",
    "https://github.com/hraness/oompa/actions/runs/35136703343",
    "Codex execution supports macOS and Linux; Claude Code execution supports Linux.",
    "Bun 1.3.14",
    "## Get started\n",
    packageAdmissionNotice,
    packageInstallPrerequisite,
    "```sh\n" + packageInstallCommand + "\n```",
    "```sh\noompa doctor --offline\n```",
    packageDaemonNotice,
    "## CLI usage\n",
    "oompa session start personal --provider codex --json",
    "## Package contents\n",
    "The npm archive contains CLI and daemon source, this package README, the license, and third-party notices.",
    "Website assets and website-authored content are not package inputs.",
    "https://oompa.app/docs/status/#install-and-update",
    "https://github.com/hraness/oompa/blob/main/PRIVACY.md",
  ];
  if (required.some((part) => !text.includes(part))) {
    throw new Error("Package README is missing its technical identity, commands, or release prerequisites.");
  }
  for (const [before, after] of [
    [packageAdmissionNotice, packageInstallCommand],
    [packageInstallPrerequisite, packageInstallCommand],
    [packageInstallCommand, "\noompa doctor --offline\n"],
    [packageDaemonNotice, "oompa session start personal --provider codex --json"],
  ] as const) {
    if (text.indexOf(before) >= text.indexOf(after)) {
      throw new Error("Package README places a command before its prerequisite.");
    }
  }
  if (text.includes("\u2014") || !text.endsWith("\n") || [
    "Install and verify the admitted v0.8.3 CLI artifact",
    "v0.8.3 artifacts admitted",
    "v0.8.3 is the fully admitted public artifact",
    "The v0.8.4 candidate is not yet admitted",
    "The v0.8.4 npm mirror is not admitted",
    "Daemon rollout is available",
    "Hosted command writers are enabled",
    "The v0.7.1 candidate is not yet admitted",
    "\nhra init --yes\n",
    "img.shields.io",
    "[Open Oompa]",
    "## Use the interface that fits the work",
  ].some((part) => text.includes(part))) {
    throw new Error("Package README contains a conflicting release claim or website presentation.");
  }
}

export async function assertPackageContentAt(repositoryRoot: string): Promise<void> {
  const [manifest, readme] = await Promise.all([
    readFile(join(repositoryRoot, "package.json"), "utf8"),
    readFile(join(repositoryRoot, "README.md"), "utf8"),
  ]);
  assertPackageContent(JSON.parse(manifest) as unknown, readme);
}
