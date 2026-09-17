import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

export async function assertProductionPackageOnly(
  root: string,
  surface: "archive" | "installed" = "archive",
): Promise<void> {
  let cliEntryPoints = 0;
  let installNormalizers = 0;
  let installPreflights = 0;
  let installPreflightRuntimes = 0;
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const packagePath = relative(root, child).replaceAll("\\", "/");
      const productionPath = packagePath.startsWith("package/")
        ? packagePath.slice("package/".length)
        : packagePath;
      if (productionPath === "src/cli.ts") {
        cliEntryPoints += 1;
        const metadata = await lstat(child);
        if (
          !entry.isFile()
          || !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || (metadata.mode & 0o777) !== 0o755
        ) {
          throw new Error("The install artifact CLI entry point must be one single-link mode-0755 regular file.");
        }
      }
      if (productionPath === "src/install-normalizer.ts") {
        installNormalizers += 1;
        const metadata = await lstat(child);
        const mode = metadata.mode & 0o777;
        if (
          !entry.isFile()
          || !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || (surface === "archive" ? mode !== 0o644 : mode !== 0o600 && mode !== 0o644)
        ) {
          throw new Error(
            surface === "archive"
              ? "The package archive normalizer must be one single-link mode-0644 regular file."
              : "The installed package normalizer must be one single-link mode-0600 or mode-0644 regular file.",
          );
        }
      }
      if (productionPath === "src/install-preflight.ts") {
        installPreflights += 1;
        const metadata = await lstat(child);
        const mode = metadata.mode & 0o777;
        if (
          !entry.isFile()
          || !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || (surface === "archive" ? mode !== 0o644 : mode !== 0o600 && mode !== 0o644)
        ) {
          throw new Error(
            surface === "archive"
              ? "The package archive preflight must be one single-link mode-0644 regular file."
              : "The installed package preflight must be one single-link mode-0600 or mode-0644 regular file.",
          );
        }
      }
      if (productionPath === "src/install-preflight-runtime.ts") {
        installPreflightRuntimes += 1;
        const metadata = await lstat(child);
        const mode = metadata.mode & 0o777;
        if (
          !entry.isFile()
          || !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || (surface === "archive" ? mode !== 0o644 : mode !== 0o600 && mode !== 0o644)
        ) {
          throw new Error(
            surface === "archive"
              ? "The package archive preflight runtime must be one single-link mode-0644 regular file."
              : "The installed package preflight runtime must be one single-link mode-0600 or mode-0644 regular file.",
          );
        }
      }
      if (
        /(?:^|\/)scripts(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)convex(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)kb(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)site(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)\.github(?:\/|$)/u.test(packagePath)
        || /(?:^|\/)docs\/live-acceptance(?:\/|\.|$)/u.test(packagePath)
        || /(?:^|\/)live-acceptance[^/]*\.ts$/u.test(packagePath)
        || /(?:^|\/)src\/cloud\/device-commands\.ts$/u.test(packagePath)
        || /(?:^|\/)src\/cloud\/inviteAuthority\.ts$/u.test(packagePath)
        || /(?:^|\/)src\/domain\/model-routing\.ts$/u.test(packagePath)
        || /(?:^|\/)src\/domain\/model-task-shape\.ts$/u.test(packagePath)
        || /(?:^|\/)src\/storage\/legacy-secret-migration\.ts$/u.test(packagePath)
      ) {
        throw new Error("The install artifact contains repository-only source.");
      }
      if (entry.isDirectory()) await visit(child);
      else if (
        entry.isFile()
        && (
          entry.name === "AGENTS.md"
          || entry.name.endsWith(".test.ts")
          || entry.name.endsWith(".fixture.json")
          || entry.name === "testAssertions.ts"
        )
      ) {
        throw new Error("The install artifact contains development-only source.");
      }
    }
  };
  await visit(root);
  if (cliEntryPoints !== 1) {
    throw new Error("The install artifact must contain exactly one CLI entry point.");
  }
  if (installNormalizers !== 1) {
    throw new Error("The install artifact must contain exactly one reviewed non-bin install normalizer.");
  }
  if (installPreflights !== 1) {
    throw new Error("The install artifact must contain exactly one reviewed pre-add install preflight.");
  }
  if (installPreflightRuntimes !== 1) {
    throw new Error("The install artifact must contain exactly one reviewed self-contained install preflight runtime.");
  }
}

export async function assertReviewedReleaseInventory(packageRoot: string): Promise<void> {
  const expected = Object.freeze({
    count: 225,
    jsonBytes: 11_195,
    sha256: "eb0b72a85ff34f5436f03fa77744b39348cf7528858d33bdb73e52a694a7c454",
  });
  const inventory: Array<readonly [string, "directory" | "file", number, number]> = [];
  const visit = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name);
      const metadata = await lstat(child);
      if (
        metadata.isSymbolicLink()
        || (metadata.isFile() && metadata.nlink !== 1)
        || (!metadata.isDirectory() && !metadata.isFile())
      ) {
        throw new Error("The package inventory contains a non-canonical filesystem object.");
      }
      inventory.push([
        relative(packageRoot, child).replaceAll("\\", "/"),
        metadata.isDirectory() ? "directory" : "file",
        metadata.mode & 0o777,
        metadata.isFile() ? metadata.size : 0,
      ]);
      if (metadata.isDirectory()) await visit(child);
    }
  };
  await visit(packageRoot);
  const canonical = `${JSON.stringify(inventory)}\n`;
  if (
    inventory.length !== expected.count
    || Buffer.byteLength(canonical) !== expected.jsonBytes
    || createHash("sha256").update(canonical).digest("hex") !== expected.sha256
  ) throw new Error("The package archive path, type, mode, count, or size inventory is not the reviewed release inventory.");
}
