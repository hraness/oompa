import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { createGzip, gzipSync } from "node:zlib";

import {
  assertOompaInstallManifest,
  assertSupportedBunInstallerVersion,
  OOMPA_INSTALL_BUN_VERSION,
  OOMPA_INSTALL_CLI_SHA256,
  normalizeOompaBunInstall,
  parseAuthenticatedOompaPackageArchive,
} from "./install-normalizer";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(import.meta.dir, "..");

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (path) => {
    await rm(path, { force: true, recursive: true });
  }));
});

const manifest = (scripts: Record<string, string> = {
  build: "bun ./build.ts",
}): Record<string, unknown> => ({
  bin: { oompa: "./src/cli.ts" },
  name: "@hraness/oompa",
  scripts,
  version: "0.8.5",
});

type UstarFixtureEntry = Readonly<{
  body?: Buffer | string;
  declaredSize?: number;
  path: string;
  type?: number;
}>;

const writeUstarOctal = (
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void => {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length !== length - 1) throw new Error("The ustar fixture integer exceeds its field.");
  header.write(encoded, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
};

const ustarFixtureHeader = (entry: UstarFixtureEntry): Buffer => {
  const path = Buffer.from(entry.path, "ascii");
  if (path.byteLength !== Buffer.byteLength(entry.path, "utf8") || path.byteLength > 100) {
    throw new Error("The ustar fixture path must be at most 100 ASCII bytes.");
  }
  const body = typeof entry.body === "string" ? Buffer.from(entry.body) : (entry.body ?? Buffer.alloc(0));
  const header = Buffer.alloc(512);
  path.copy(header);
  writeUstarOctal(header, 100, 8, 0o644);
  writeUstarOctal(header, 108, 8, 0);
  writeUstarOctal(header, 116, 8, 0);
  writeUstarOctal(header, 124, 12, entry.declaredSize ?? body.byteLength);
  writeUstarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = entry.type ?? 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const encodedChecksum = checksum.toString(8).padStart(6, "0");
  if (encodedChecksum.length !== 6) throw new Error("The ustar fixture checksum exceeds its field.");
  header.write(encodedChecksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
};

const gzipUstarFixture = (entries: readonly UstarFixtureEntry[]): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = typeof entry.body === "string" ? Buffer.from(entry.body) : (entry.body ?? Buffer.alloc(0));
    parts.push(ustarFixtureHeader(entry), body);
    const padding = (512 - (body.byteLength % 512)) % 512;
    if (padding > 0) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1_024));
  return gzipSync(Buffer.concat(parts), { level: 9 });
};

const gzipZeroFixture = async (byteLength: number): Promise<Buffer> => {
  const zeroChunk = Buffer.alloc(64 * 1_024);
  const zeroSlices = async function* (): AsyncGenerator<Buffer> {
    let remaining = byteLength;
    while (remaining > 0) {
      const length = Math.min(remaining, zeroChunk.byteLength);
      yield zeroChunk.subarray(0, length);
      remaining -= length;
    }
  };
  const source = Readable.from(zeroSlices(), { objectMode: false });
  const compressed: Buffer[] = [];
  for await (const chunk of source.pipe(createGzip({ chunkSize: 16 * 1_024, level: 9 }))) {
    if (!(chunk instanceof Uint8Array)) throw new Error("The gzip fixture produced a non-byte chunk.");
    compressed.push(Buffer.from(chunk));
  }
  return Buffer.concat(compressed);
};

describe("authenticated Oompa package archive parser", () => {
  test("streams an exact minimal ustar package into bounded file identities", async () => {
    const entries = [
      { body: "{}\n", path: "package/package.json" },
      { body: "#!/usr/bin/env bun\n", path: "package/src/cli.ts" },
      { body: "export {};\n", path: "package/src/install-normalizer.ts" },
    ] as const;

    const parsed = await parseAuthenticatedOompaPackageArchive(gzipUstarFixture(entries));

    expect([...parsed.directories].sort()).toEqual(["", "src"]);
    expect([...parsed.files.keys()].sort()).toEqual([
      "package.json",
      "src/cli.ts",
      "src/install-normalizer.ts",
    ]);
    for (const entry of entries) {
      const relativePath = entry.path.slice("package/".length);
      const body = Buffer.from(entry.body);
      expect(parsed.files.get(relativePath)).toEqual({
        sha256: createHash("sha256").update(body).digest("hex"),
        size: body.byteLength,
      });
    }
  });

  test("rejects an oversized declared file before demanding its absent body", async () => {
    const archive = gzipUstarFixture([{
      declaredSize: (8 * 1_024 * 1_024) + 1,
      path: "package/oversized",
    }]);
    expect(archive.byteLength).toBeLessThan(1_024);

    await expect(parseAuthenticatedOompaPackageArchive(archive)).rejects.toThrow(
      "contains an oversized package file",
    );
  });

  test("rejects excessive package-path depth before reading file contents", async () => {
    const archive = gzipUstarFixture([{
      path: `package/${Array.from({ length: 17 }, () => "d").join("/")}`,
    }]);

    await expect(parseAuthenticatedOompaPackageArchive(archive)).rejects.toThrow(
      "contains an ambiguous package path",
    );
  });

  test("rejects non-regular tar entries", async () => {
    const archive = gzipUstarFixture([{
      path: "package/link",
      type: 0x32,
    }]);

    await expect(parseAuthenticatedOompaPackageArchive(archive)).rejects.toThrow(
      "contains a non-regular package entry",
    );
  });

  test("rejects the 513th zero-byte file without allocating file bodies", async () => {
    const archive = gzipUstarFixture(Array.from({ length: 513 }, (_, index) => ({
      path: `package/f${index.toString().padStart(3, "0")}`,
    })));
    expect(archive.byteLength).toBeLessThan(8 * 1_024);

    await expect(parseAuthenticatedOompaPackageArchive(archive)).rejects.toThrow(
      "exceeds its package-file-count bound",
    );
  });

  test("rejects a tiny gzip bomb as its streamed output crosses the expanded bound", async () => {
    const archive = await gzipZeroFixture(81 * 1_024 * 1_024);
    expect(archive.byteLength).toBeLessThan(128 * 1_024);

    await expect(parseAuthenticatedOompaPackageArchive(archive)).rejects.toThrow(
      "exceeds its expanded tar-byte bound",
    );
  });

  test("settles a truncated gzip decoder after its error", async () => {
    await expect(parseAuthenticatedOompaPackageArchive(Buffer.from([0x1f, 0x8b, 0x08, 0x00]))).rejects.toThrow(
      "could not be parsed as a bounded package tarball",
    );
  });
});

type InstallFixture = Readonly<{
  binLink: string;
  cliPath: string;
  normalizerPath: string;
  packageRoot: string;
  root: string;
}>;

const installFixture = async (): Promise<InstallFixture> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-install-normalizer-")));
  temporaryDirectories.push(root);
  const packageRoot = join(root, "node_modules", "@hraness", "oompa");
  const sourceDirectory = join(packageRoot, "src");
  const binDirectory = join(root, "node_modules", ".bin");
  const cliPath = join(sourceDirectory, "cli.ts");
  const normalizerPath = join(sourceDirectory, "install-normalizer.ts");
  const binLink = join(binDirectory, "oompa");
  await mkdir(sourceDirectory, { recursive: true, mode: 0o755 });
  await mkdir(binDirectory, { mode: 0o755 });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify(manifest(), null, 2)}\n`, {
    mode: 0o644,
  });
  await writeFile(normalizerPath, "// reviewed fixture normalizer\n", { mode: 0o644 });
  await writeFile(cliPath, await readFile(join(repositoryRoot, "src", "cli.ts")), { mode: 0o755 });
  await chmod(cliPath, 0o777);
  await symlink("../@hraness/oompa/src/cli.ts", binLink);
  return { binLink, cliPath, normalizerPath, packageRoot, root };
};

const run = async (
  command: readonly [string, ...string[]],
  input: Readonly<{ cwd: string; environment?: NodeJS.ProcessEnv }> ,
): Promise<Readonly<{ exitCode: number; stderr: string; stdout: string }>> => {
  const child = Bun.spawn([...command], {
    cwd: input.cwd,
    env: input.environment ?? process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr, stdout };
};

describe("lifecycle-free Bun install normalizer", () => {
  test("binds the reviewed CLI bytes to a checked digest", async () => {
    const bytes = await readFile(join(repositoryRoot, "src", "cli.ts"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(OOMPA_INSTALL_CLI_SHA256);
  });

  test("binds normalization to the only proven Bun installer runtime", () => {
    expect(Bun.version).toBe(OOMPA_INSTALL_BUN_VERSION);
    expect(() => assertSupportedBunInstallerVersion(OOMPA_INSTALL_BUN_VERSION)).not.toThrow();
    expect(() => assertSupportedBunInstallerVersion("1.3.15")).toThrow("exact supported Bun installer version");
    expect(() => assertSupportedBunInstallerVersion(undefined)).toThrow("exact supported Bun installer version");
  });

  test("requires an exact zero-lifecycle package manifest", () => {
    expect(() => assertOompaInstallManifest(manifest())).not.toThrow();
    for (const version of ["0.7.0", "0.7.1"]) {
      expect(() => assertOompaInstallManifest({ ...manifest(), version }))
        .toThrow("package identity");
    }
    for (const name of ["preinstall", "postinstall", "prepublishOnly", "prepare", "prepack"]) {
      expect(() => assertOompaInstallManifest(manifest({
        build: "bun ./build.ts",
        [name]: "bun ./unreviewed.ts",
      }))).toThrow("zero-lifecycle contract");
    }
  });

  test("atomically publishes a fresh exact-byte mode-0755 inode and preserves the bin identity", async () => {
    const fixture = await installFixture();
    const bytes = await readFile(fixture.cliPath);
    const before = await lstat(fixture.cliPath);
    const uid = process.getuid?.();
    if (uid === undefined) throw new Error("The install normalizer test requires a current-user identity.");

    await normalizeOompaBunInstall({
      normalizerPath: fixture.normalizerPath,
      packageRoot: fixture.packageRoot,
    });

    const after = await lstat(fixture.cliPath);
    expect(after.isFile()).toBe(true);
    expect(after.isSymbolicLink()).toBe(false);
    expect(after.uid).toBe(uid);
    expect(after.nlink).toBe(1);
    expect(after.mode & 0o777).toBe(0o755);
    expect(after.ino).not.toBe(before.ino);
    expect(await readFile(fixture.cliPath)).toEqual(bytes);
    expect(await realpath(fixture.binLink)).toBe(fixture.cliPath);
  });

  test("accepts owner-only package metadata and directories without loosening ownership or link checks", async () => {
    const fixture = await installFixture();
    await chmod(fixture.packageRoot, 0o700);
    await chmod(join(fixture.packageRoot, "src"), 0o700);
    await chmod(join(fixture.packageRoot, "package.json"), 0o600);
    await chmod(fixture.normalizerPath, 0o600);

    await normalizeOompaBunInstall({
      normalizerPath: fixture.normalizerPath,
      packageRoot: fixture.packageRoot,
    });

    expect((await lstat(fixture.cliPath)).mode & 0o777).toBe(0o755);
    expect(await realpath(fixture.binLink)).toBe(fixture.cliPath);
  });

  test("refuses mismatched bytes, lifecycle metadata, bin identity, and link topology before publishing", async () => {
    const mismatched = await installFixture();
    const mismatchedBytes = await readFile(mismatched.cliPath);
    mismatchedBytes[0] = (mismatchedBytes[0] ?? 0) ^ 0xff;
    await writeFile(mismatched.cliPath, mismatchedBytes, { mode: 0o777 });
    await chmod(mismatched.cliPath, 0o777);
    const mismatchedInode = (await lstat(mismatched.cliPath)).ino;
    await expect(normalizeOompaBunInstall({
      normalizerPath: mismatched.normalizerPath,
      packageRoot: mismatched.packageRoot,
    })).rejects.toThrow("does not match the reviewed package digest");
    expect((await lstat(mismatched.cliPath)).ino).toBe(mismatchedInode);
    expect((await lstat(mismatched.cliPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(mismatched.binLink).exists()).toBeFalse();

    const lifecycle = await installFixture();
    await writeFile(
      join(lifecycle.packageRoot, "package.json"),
      `${JSON.stringify(manifest({
        build: "bun ./build.ts",
        prepublishOnly: "bun ./unreviewed.ts",
      }), null, 2)}\n`,
      { mode: 0o644 },
    );
    await expect(normalizeOompaBunInstall({
      normalizerPath: lifecycle.normalizerPath,
      packageRoot: lifecycle.packageRoot,
    })).rejects.toThrow("zero-lifecycle contract");
    expect((await lstat(lifecycle.cliPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(lifecycle.binLink).exists()).toBeFalse();

    const wrongBin = await installFixture();
    await rm(wrongBin.binLink);
    const wrongTarget = join(wrongBin.root, "wrong-cli.ts");
    await writeFile(wrongTarget, "wrong\n", { mode: 0o755 });
    await symlink(wrongTarget, wrongBin.binLink);
    await expect(normalizeOompaBunInstall({
      normalizerPath: wrongBin.normalizerPath,
      packageRoot: wrongBin.packageRoot,
    })).rejects.toThrow("does not resolve to its exact package entry point");
    expect((await lstat(wrongBin.cliPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(wrongBin.binLink).exists()).toBeFalse();

    const hardlinked = await installFixture();
    await link(hardlinked.cliPath, join(hardlinked.root, "second-link"));
    await expect(normalizeOompaBunInstall({
      normalizerPath: hardlinked.normalizerPath,
      packageRoot: hardlinked.packageRoot,
    })).rejects.toThrow("single-link 0755 or 0777 regular file");
    expect((await lstat(hardlinked.cliPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(hardlinked.binLink).exists()).toBeFalse();
  });

  test("refuses writable and symlinked mutation parents and quarantines after core custody", async () => {
    const writablePackageParent = await installFixture();
    await chmod(join(writablePackageParent.root, "node_modules"), 0o775);
    await expect(normalizeOompaBunInstall({
      normalizerPath: writablePackageParent.normalizerPath,
      packageRoot: writablePackageParent.packageRoot,
    })).rejects.toThrow("group/world-writable directory component");
    expect((await lstat(writablePackageParent.cliPath)).mode & 0o777).toBe(0o777);

    const writableBinParent = await installFixture();
    await chmod(dirname(writableBinParent.binLink), 0o777);
    await expect(normalizeOompaBunInstall({
      normalizerPath: writableBinParent.normalizerPath,
      packageRoot: writableBinParent.packageRoot,
    })).rejects.toThrow("group/world-writable directory component");
    expect((await lstat(writableBinParent.cliPath)).mode & 0o777).toBe(0o600);

    const symlinkedRoot = await installFixture();
    const packageAlias = join(symlinkedRoot.root, "hra-package-alias");
    await symlink(symlinkedRoot.packageRoot, packageAlias, "dir");
    await expect(normalizeOompaBunInstall({
      normalizerPath: join(packageAlias, "src", "install-normalizer.ts"),
      packageRoot: packageAlias,
    })).rejects.toThrow("refuses symlinked package or normalizer paths");
    expect((await lstat(symlinkedRoot.cliPath)).mode & 0o777).toBe(0o600);
    expect(await Bun.file(symlinkedRoot.binLink).exists()).toBeFalse();
  });

  for (const hook of ["afterPublishRename", "afterPublishValidation"] as const) {
    test(`disables the freshly published CLI and removes its command link when ${hook} fails`, async () => {
      const fixture = await installFixture();
      const before = await lstat(fixture.cliPath);
      await expect(normalizeOompaBunInstall({
        normalizerPath: fixture.normalizerPath,
        packageRoot: fixture.packageRoot,
        testHooks: {
          [hook]: () => { throw new Error(`fixture ${hook} failure`); },
        },
      })).rejects.toThrow(`fixture ${hook} failure`);

      const after = await lstat(fixture.cliPath);
      expect(after.ino).not.toBe(before.ino);
      expect(after.mode & 0o777).toBe(0o600);
      expect(await Bun.file(fixture.binLink).exists()).toBeFalse();
    });
  }

  test("detects held package and bin parent replacement without publishing through the replacement", async () => {
    const replacedSource = await installFixture();
    const sourceDirectory = join(replacedSource.packageRoot, "src");
    const heldSourceDirectory = join(replacedSource.packageRoot, "src-held");
    await expect(normalizeOompaBunInstall({
      normalizerPath: replacedSource.normalizerPath,
      packageRoot: replacedSource.packageRoot,
      testHooks: {
        afterQuarantine: async () => {
          await rename(sourceDirectory, heldSourceDirectory);
          await symlink(heldSourceDirectory, sourceDirectory, "dir");
        },
      },
    })).rejects.toThrow("directory component");
    expect((await lstat(join(heldSourceDirectory, "cli.ts"))).mode & 0o777).toBe(0o600);
    expect((await lstat(sourceDirectory)).isSymbolicLink()).toBe(true);

    const replacedBin = await installFixture();
    const binDirectory = dirname(replacedBin.binLink);
    const heldBinDirectory = join(replacedBin.root, "node_modules", ".bin-held");
    await expect(normalizeOompaBunInstall({
      normalizerPath: replacedBin.normalizerPath,
      packageRoot: replacedBin.packageRoot,
      testHooks: {
        beforePublishRename: async () => {
          await rename(binDirectory, heldBinDirectory);
          await mkdir(binDirectory, { mode: 0o755 });
          await symlink("../@hraness/oompa/src/cli.ts", join(binDirectory, "oompa"));
        },
      },
    })).rejects.toThrow("directory path no longer names its held custody descriptor");
    expect((await lstat(replacedBin.cliPath)).mode & 0o777).toBe(0o600);
    expect((await lstat(join(heldBinDirectory, "oompa"))).isSymbolicLink()).toBe(true);
  });

  test("normalizes fresh and repeated global installs without executing or changing existing trust", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa lifecycle-free global ")));
    temporaryDirectories.push(root);
    const packageSource = join(root, "oompa-source");
    const hostileSource = join(root, "hostile-source");
    const archiveDirectory = join(root, "archive");
    const consumerHome = join(root, "home");
    const consumerTemporary = join(root, "tmp");
    const globalInstall = join(root, "bun-global");
    const hostileSentinel = join(root, "hostile-ran");
    for (const directory of [
      join(packageSource, "src"),
      hostileSource,
      archiveDirectory,
      consumerHome,
      consumerTemporary,
      globalInstall,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }
    await writeFile(join(packageSource, "package.json"), `${JSON.stringify(manifest(), null, 2)}\n`, { mode: 0o644 });
    await writeFile(
      join(packageSource, "src", "install-normalizer.ts"),
      await readFile(join(repositoryRoot, "src", "install-normalizer.ts")),
      { mode: 0o644 },
    );
    await writeFile(
      join(packageSource, "src", "install-preflight.ts"),
      await readFile(join(repositoryRoot, "src", "install-preflight.ts")),
      { mode: 0o644 },
    );
    await writeFile(
      join(packageSource, "src", "install-preflight-runtime.ts"),
      await readFile(join(repositoryRoot, "src", "install-preflight-runtime.ts")),
      { mode: 0o644 },
    );
    await writeFile(
      join(packageSource, "src", "cli.ts"),
      await readFile(join(repositoryRoot, "src", "cli.ts")),
      { mode: 0o755 },
    );
    await chmod(join(packageSource, "src", "cli.ts"), 0o755);
    await writeFile(
      join(hostileSource, "package.json"),
      `${JSON.stringify({
        name: "existing-trusted-fixture",
        scripts: {
          postinstall: `${process.execPath} -e ${JSON.stringify(
            `require('node:fs').writeFileSync(${JSON.stringify(hostileSentinel)}, 'ran')`,
          )}`,
        },
        version: "1.0.0",
      }, null, 2)}\n`,
      { mode: 0o644 },
    );
    const environment = {
      ...process.env,
      BUN_INSTALL: globalInstall,
      BUN_INSTALL_BIN: join(globalInstall, "bin"),
      BUN_INSTALL_GLOBAL_DIR: join(globalInstall, "install", "global"),
      HOME: consumerHome,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      TMPDIR: consumerTemporary,
    };
    const hostilePack = await run(
      [process.execPath, "pm", "pack", "--ignore-scripts", "--destination", archiveDirectory],
      { cwd: hostileSource, environment },
    );
    expect(hostilePack.exitCode).toBe(0);
    const hostileArchive = join(archiveDirectory, "existing-trusted-fixture-1.0.0.tgz");
    const hostileInstall = await run(
      [process.execPath, "add", "--global", "--backend=copyfile", "--ignore-scripts", hostileArchive],
      { cwd: root, environment },
    );
    expect(hostileInstall.exitCode).toBe(0);
    const globalManifestPath = join(globalInstall, "install", "global", "package.json");
    const globalManifest = JSON.parse(await readFile(globalManifestPath, "utf8")) as Record<string, unknown>;
    globalManifest.trustedDependencies = ["existing-trusted-fixture"];
    await writeFile(globalManifestPath, `${JSON.stringify(globalManifest, null, 2)}\n`, { mode: 0o644 });

    const oompaPack = await run(
      [process.execPath, "pm", "pack", "--ignore-scripts", "--destination", archiveDirectory],
      { cwd: packageSource, environment },
    );
    expect(oompaPack.exitCode).toBe(0);
    const oompaArchive = join(archiveDirectory, "hraness-oompa-0.8.5.tgz");
    let installedCli: string | undefined;
    const installAndNormalize = async (): Promise<void> => {
      const installation = await run(
        [process.execPath, join(repositoryRoot, "src", "install-preflight.ts"), oompaArchive],
        { cwd: root, environment },
      );
      expect(installation.exitCode).toBe(0);
      expect(installation.stdout).toBe("hra-install-safe\n");
      const currentCli = await realpath(join(globalInstall, "bin", "oompa"));
      installedCli ??= currentCli;
      expect(currentCli).toBe(installedCli);
      expect(currentCli).toContain(`${join(globalInstall, "install", "oompa", "versions")}/`);
      expect((await lstat(currentCli)).mode & 0o777).toBe(0o755);
      expect(await Bun.file(join(globalInstall, "install", "global", "node_modules", "@hraness", "oompa")).exists()).toBeFalse();
      expect(await access(hostileSentinel).then(() => "present", () => "absent")).toBe("absent");
      const trustAfter = JSON.parse(await readFile(globalManifestPath, "utf8")) as Record<string, unknown>;
      expect(trustAfter.trustedDependencies).toEqual(["existing-trusted-fixture"]);
    };
    await installAndNormalize();
    await installAndNormalize();
  });

  test("makes lifecycle-disabled copyfile installation fail closed when the reviewed CLI digest is wrong", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-normalizer-refusal-")));
    temporaryDirectories.push(root);
    const packageSource = join(root, "package-source");
    const archiveDirectory = join(root, "archive");
    const consumerHome = join(root, "home");
    const consumerTemporary = join(root, "tmp");
    const globalInstall = join(root, "bun-global");
    await mkdir(join(packageSource, "src"), { recursive: true, mode: 0o755 });
    for (const directory of [archiveDirectory, consumerHome, consumerTemporary, globalInstall]) {
      await mkdir(directory, { mode: 0o700 });
    }
    await writeFile(
      join(packageSource, "package.json"),
      `${JSON.stringify(manifest(), null, 2)}\n`,
      { mode: 0o644 },
    );
    await writeFile(
      join(packageSource, "src", "install-normalizer.ts"),
      await readFile(join(repositoryRoot, "src", "install-normalizer.ts")),
      { mode: 0o644 },
    );
    await writeFile(
      join(packageSource, "src", "install-preflight.ts"),
      await readFile(join(repositoryRoot, "src", "install-preflight.ts")),
      { mode: 0o644 },
    );
    await writeFile(
      join(packageSource, "src", "install-preflight-runtime.ts"),
      await readFile(join(repositoryRoot, "src", "install-preflight-runtime.ts")),
      { mode: 0o644 },
    );
    await writeFile(join(packageSource, "src", "cli.ts"), "#!/usr/bin/env bun\nwrong\n", {
      mode: 0o755,
    });
    await chmod(join(packageSource, "src", "cli.ts"), 0o755);

    const packed = await run(
      [process.execPath, "pm", "pack", "--ignore-scripts", "--destination", archiveDirectory],
      { cwd: packageSource },
    );
    expect(packed.exitCode).toBe(0);
    const archive = join(archiveDirectory, "hraness-oompa-0.8.5.tgz");
    const environment = {
      ...process.env,
      BUN_INSTALL: globalInstall,
      BUN_INSTALL_BIN: join(globalInstall, "bin"),
      BUN_INSTALL_GLOBAL_DIR: join(globalInstall, "install", "global"),
      HOME: consumerHome,
      TMPDIR: consumerTemporary,
    };
    const installed = await run(
      [
        process.execPath,
        join(repositoryRoot, "src", "install-preflight.ts"),
        archive,
      ],
      {
        cwd: root,
        environment,
      },
    );
    expect(installed.exitCode).not.toBe(0);
    expect(installed.stderr).not.toContain(OOMPA_INSTALL_CLI_SHA256);
    expect(await Bun.file(join(globalInstall, "bin", "oompa")).exists()).toBeFalse();
    expect(await Bun.file(join(globalInstall, "install", "global", "node_modules", "@hraness", "oompa")).exists()).toBeFalse();
    const authorityEntries = await readdir(join(globalInstall, "install", "oompa"));
    expect(authorityEntries.some((entry) => entry.startsWith(".staging-"))).toBeTrue();
  });
});
