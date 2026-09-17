import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";
import { dlopen } from "bun:ffi";

import {
  assertAuthoritySupervisorArtifactPublicFile,
  authoritySupervisorArtifactManifest,
  openAuthoritySupervisorArtifactForTesting,
  resolveAuthoritySupervisorArtifactForTesting,
} from "./authority-supervisor-artifact";

import type { AuthoritySupervisorArtifactManifest } from "./authority-supervisor-artifact";

const digest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

const testOwner = (): number => {
  if (typeof process.getuid !== "function") throw new Error("The artifact resolver test needs a POSIX owner.");
  return process.getuid();
};

const elf = (machine: number): Buffer => {
  const value = Buffer.alloc(64);
  value.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  value[18] = machine & 0xff;
  value[19] = machine >> 8 & 0xff;
  return value;
};

const sourceRelativePath = "scripts/authority-supervisor.rs";
const x64RelativePath = "scripts/authority-supervisor-bin/authority-supervisor-linux-x64-musl";
const arm64RelativePath = "scripts/authority-supervisor-bin/authority-supervisor-linux-arm64-musl";

const fixtureManifest = (
  source: Buffer,
  x64: Buffer,
  arm64: Buffer,
): AuthoritySupervisorArtifactManifest => ({
  artifacts: {
    arm64: {
      byteLength: arm64.byteLength,
      elfMachine: 183,
      maximumByteLength: 1024,
      mode: 0o755,
      relativePath: arm64RelativePath,
      sha256: digest(arm64),
      target: "aarch64-linux-musl",
    },
    x64: {
      byteLength: x64.byteLength,
      elfMachine: 62,
      maximumByteLength: 1024,
      mode: 0o755,
      relativePath: x64RelativePath,
      sha256: digest(x64),
      target: "x86_64-linux-musl",
    },
  },
  compiler: { name: "rustc", version: "1.97.1" },
  schemaVersion: 1,
  source: {
    byteLength: source.byteLength,
    maximumByteLength: 1024,
    mode: 0o644,
    relativePath: sourceRelativePath,
    sha256: digest(source),
  },
});

const makeFixture = async (): Promise<Readonly<{
  arm64Path: string;
  manifest: AuthoritySupervisorArtifactManifest;
  root: string;
  sourcePath: string;
  x64Path: string;
}>> => {
  const root = await mkdtemp(join(tmpdir(), "oompa-authority-artifact-"));
  const source = Buffer.from("//! fixture authority supervisor\n", "utf8");
  const x64 = elf(62);
  const arm64 = elf(183);
  const sourcePath = join(root, sourceRelativePath);
  const x64Path = join(root, x64RelativePath);
  const arm64Path = join(root, arm64RelativePath);
  await mkdir(join(root, "scripts", "authority-supervisor-bin"), { recursive: true, mode: 0o700 });
  await writeFile(sourcePath, source, { mode: 0o644 });
  await writeFile(x64Path, x64, { mode: 0o755 });
  await writeFile(arm64Path, arm64, { mode: 0o755 });
  await chmod(sourcePath, 0o644);
  await chmod(x64Path, 0o755);
  await chmod(arm64Path, 0o755);
  return {
    arm64Path,
    manifest: fixtureManifest(source, x64, arm64),
    root,
    sourcePath,
    x64Path,
  };
};

const resolveFixture = async (
  fixture: Awaited<ReturnType<typeof makeFixture>>,
  options: Readonly<{
    architecture?: string;
    manifest?: AuthoritySupervisorArtifactManifest;
    owner?: number;
    platform?: string;
  }> = {},
) => resolveAuthoritySupervisorArtifactForTesting({
  ...(options.architecture === undefined ? {} : { architecture: options.architecture }),
  manifest: options.manifest ?? fixture.manifest,
  owner: options.owner ?? testOwner(),
  ...(options.platform === undefined ? {} : { platform: options.platform }),
  repositoryRoot: fixture.root,
});

const opensSealedExecutionArtifacts = (): boolean =>
  process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64");

type LinuxFcntlLibrary = Readonly<{
  close: () => void;
  symbols: Readonly<{
    fcntl: (descriptor: number, command: number, argument: number) => number;
  }>;
}>;

const fGetSeals = 1034;
const requiredMemfdSeals = 0x0001 | 0x0002 | 0x0004 | 0x0008;

const fcntlLibraryCandidates = (): readonly string[] => process.arch === "x64"
  ? [
    "/lib/x86_64-linux-gnu/libc.so.6",
    "/usr/lib/x86_64-linux-gnu/libc.so.6",
    "/lib64/libc.so.6",
    "/usr/lib64/libc.so.6",
    "/lib/libc.musl-x86_64.so.1",
    "/usr/lib/libc.musl-x86_64.so.1",
    "/lib/ld-musl-x86_64.so.1",
    "/usr/lib/ld-musl-x86_64.so.1",
  ]
  : [
    "/lib/aarch64-linux-gnu/libc.so.6",
    "/usr/lib/aarch64-linux-gnu/libc.so.6",
    "/lib64/libc.so.6",
    "/usr/lib64/libc.so.6",
    "/lib/libc.musl-aarch64.so.1",
    "/usr/lib/libc.musl-aarch64.so.1",
    "/lib/ld-musl-aarch64.so.1",
    "/usr/lib/ld-musl-aarch64.so.1",
  ];

const memfdSeals = (descriptor: number): number => {
  for (const candidate of fcntlLibraryCandidates()) {
    try {
      const library: LinuxFcntlLibrary = dlopen(candidate, {
        fcntl: { args: ["i32", "i32", "i32"], returns: "i32" },
      } as const);
      try {
        return library.symbols.fcntl(descriptor, fGetSeals, 0);
      } finally {
        library.close();
      }
    } catch {
      // Match the bounded absolute libc lookup used by the production opener.
    }
  }
  throw new Error("memfd_test_fcntl_unavailable");
};

const assertWriteIsSealed = async (executionPath: string): Promise<void> => {
  let writable: Awaited<ReturnType<typeof open>> | undefined;
  try {
    writable = await open(executionPath, constants.O_WRONLY);
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: "EPERM" });
    return;
  }
  try {
    await expect(writable.write(Buffer.from([0]), 0, 1, 0)).rejects.toMatchObject({
      code: "EPERM",
    });
  } finally {
    await writable.close();
  }
};

const descriptorCountForPath = async (path: string): Promise<number> => {
  const canonicalPath = await realpath(path);
  const entries = await readdir("/proc/self/fd");
  const targets = await Promise.all(entries.map(async (entry) =>
    readlink(join("/proc/self/fd", entry)).catch(() => undefined)));
  return targets.filter((target) => target === canonicalPath).length;
};

describe("authority supervisor artifact resolver", () => {
  test("returns only the exact checked-in Linux artifact identity", async () => {
    const fixture = await makeFixture();
    try {
      const canonicalRoot = await realpath(fixture.root);
      await expect(resolveFixture(fixture)).resolves.toEqual({
        architecture: "x64",
        byteLength: 64,
        path: join(canonicalRoot, x64RelativePath),
        sha256: fixture.manifest.artifacts.x64.sha256,
        target: "x86_64-linux-musl",
      });
      await expect(resolveFixture(fixture, { architecture: "arm64" })).resolves.toEqual({
        architecture: "arm64",
        byteLength: 64,
        path: join(canonicalRoot, arm64RelativePath),
        sha256: fixture.manifest.artifacts.arm64.sha256,
        target: "aarch64-linux-musl",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects unsupported host selection before opening a target", async () => {
    const fixture = await makeFixture();
    try {
      await expect(resolveFixture(fixture, { platform: "darwin" })).rejects.toMatchObject({
        code: "authority_supervisor_platform_unsupported",
      });
      await expect(resolveFixture(fixture, { architecture: "ia32" })).rejects.toMatchObject({
        code: "authority_supervisor_architecture_unsupported",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("fails closed for source, metadata, link, owner, and path substitutions", async () => {
    const fixture = await makeFixture();
    try {
      await writeFile(fixture.sourcePath, Buffer.alloc(fixture.manifest.source.byteLength, 0x78));
      await expect(resolveFixture(fixture)).rejects.toMatchObject({
        code: "authority_supervisor_source_hash_mismatch",
      });
      await writeFile(fixture.sourcePath, "//! fixture authority supervisor\n", { mode: 0o644 });
      await chmod(fixture.sourcePath, 0o644);

      await chmod(fixture.x64Path, 0o700);
      await expect(resolveFixture(fixture)).rejects.toMatchObject({
        code: "authority_supervisor_binary_invalid",
      });
      await chmod(fixture.x64Path, 0o755);

      await link(fixture.x64Path, `${fixture.x64Path}.hard-link`);
      await expect(resolveFixture(fixture)).rejects.toMatchObject({
        code: "authority_supervisor_binary_invalid",
      });
      await unlink(`${fixture.x64Path}.hard-link`);

      await expect(resolveFixture(fixture, { owner: testOwner() + 1 })).rejects.toMatchObject({
        code: "authority_supervisor_source_invalid",
      });

      const byteCapTooSmall: AuthoritySupervisorArtifactManifest = {
        ...fixture.manifest,
        artifacts: {
          ...fixture.manifest.artifacts,
          x64: {
            ...fixture.manifest.artifacts.x64,
            maximumByteLength: fixture.manifest.artifacts.x64.byteLength - 1,
          },
        },
      };
      await expect(resolveFixture(fixture, { manifest: byteCapTooSmall })).rejects.toMatchObject({
        code: "authority_supervisor_manifest_invalid",
      });

      const wrongPath: AuthoritySupervisorArtifactManifest = {
        ...fixture.manifest,
        source: { ...fixture.manifest.source, relativePath: "scripts/other.rs" },
      };
      await expect(resolveFixture(fixture, { manifest: wrongPath })).rejects.toMatchObject({
        code: "authority_supervisor_manifest_invalid",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("rejects a hash-matching non-ELF binary and leaf symlinks", async () => {
    const fixture = await makeFixture();
    try {
      const nonElf = Buffer.alloc(64, 0x42);
      await writeFile(fixture.x64Path, nonElf, { mode: 0o755 });
      await chmod(fixture.x64Path, 0o755);
      const nonElfManifest: AuthoritySupervisorArtifactManifest = {
        ...fixture.manifest,
        artifacts: {
          ...fixture.manifest.artifacts,
          x64: {
            ...fixture.manifest.artifacts.x64,
            sha256: digest(nonElf),
          },
        },
      };
      await expect(resolveFixture(fixture, { manifest: nonElfManifest })).rejects.toMatchObject({
        code: "authority_supervisor_binary_elf_invalid",
      });

      await unlink(fixture.x64Path);
      await symlink(fixture.arm64Path, fixture.x64Path);
      await expect(resolveFixture(fixture)).rejects.toMatchObject({
        code: "authority_supervisor_binary_invalid",
      });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("materializes a sealed memfd that is independent of the checked-in pathname", async () => {
    if (!opensSealedExecutionArtifacts()) return;
    const fixture = await makeFixture();
    const architecture = process.arch as "x64" | "arm64";
    const binaryPath = architecture === "x64" ? fixture.x64Path : fixture.arm64Path;
    const expectedArtifact = fixture.manifest.artifacts[architecture];
    let opened: Awaited<ReturnType<typeof openAuthoritySupervisorArtifactForTesting>> | undefined;
    try {
      const checkedInDescriptorCount = await descriptorCountForPath(binaryPath);
      opened = await openAuthoritySupervisorArtifactForTesting({
        architecture,
        manifest: fixture.manifest,
        owner: testOwner(),
        platform: "linux",
        repositoryRoot: fixture.root,
      });
      expect(await descriptorCountForPath(binaryPath)).toBe(checkedInDescriptorCount);
      expect(opened.artifact).toEqual({
        architecture,
        byteLength: expectedArtifact.byteLength,
        sha256: expectedArtifact.sha256,
        target: expectedArtifact.target,
      });
      expect(opened.executionPath).toMatch(/^\/proc\/\d+\/fd\/\d+$/u);
      await expect(readlink(opened.executionPath)).resolves.toContain("memfd:hra-authority-supervisor");
      await expect(readFile(opened.executionPath).then(digest)).resolves.toBe(expectedArtifact.sha256);
      const inspection = await open(opened.executionPath, constants.O_RDONLY);
      try {
        expect(memfdSeals(inspection.fd)).toBe(requiredMemfdSeals);
      } finally {
        await inspection.close();
      }

      await writeFile(binaryPath, Buffer.alloc(expectedArtifact.byteLength, 0x42), { mode: 0o755 });
      await chmod(binaryPath, 0o755);
      await expect(readFile(opened.executionPath).then(digest)).resolves.toBe(expectedArtifact.sha256);
      await assertWriteIsSealed(opened.executionPath);
      await expect(readFile(opened.executionPath).then(digest)).resolves.toBe(expectedArtifact.sha256);
    } finally {
      await opened?.close();
      await opened?.close();
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  test("checks the checked-in source and both tracked helper binaries", async () => {
    const repositoryRoot = resolve(import.meta.dir, "..");
    const owner = testOwner();
    expect(Object.isFrozen(authoritySupervisorArtifactManifest)).toBeTrue();
    expect(Object.isFrozen(authoritySupervisorArtifactManifest.artifacts)).toBeTrue();
    expect(Object.isFrozen(authoritySupervisorArtifactManifest.artifacts.x64)).toBeTrue();
    expect(Object.isFrozen(authoritySupervisorArtifactManifest.artifacts.arm64)).toBeTrue();
    expect(Object.isFrozen(authoritySupervisorArtifactManifest.source)).toBeTrue();
    await expect(resolveAuthoritySupervisorArtifactForTesting({
      architecture: "x64",
      owner,
      platform: "linux",
      repositoryRoot,
    })).resolves.toMatchObject({
      byteLength: authoritySupervisorArtifactManifest.artifacts.x64.byteLength,
      sha256: authoritySupervisorArtifactManifest.artifacts.x64.sha256,
    });
    await expect(assertAuthoritySupervisorArtifactPublicFile(
      repositoryRoot,
      authoritySupervisorArtifactManifest.artifacts.arm64.relativePath,
    )).resolves.toBeUndefined();
  });
});
