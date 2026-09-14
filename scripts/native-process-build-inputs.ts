import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, type BigIntStats } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const nativeInputHash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (left: BigIntStats, right: BigIntStats): boolean => left.dev === right.dev && left.ino === right.ino
  && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.size === right.size
  && left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

export function nativeBuildInput(path: string, maximum = 1024 * 1024): Buffer {
  if (realpathSync(path) !== resolve(path)) throw Error("NATIVE_PROCESS_INPUT_PATH_INVALID");
  const named = lstatSync(path, { bigint: true });
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = fstatSync(fd, { bigint: true });
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size < 0n || metadata.size > BigInt(maximum)
      || !same(named, metadata)) throw Error("NATIVE_PROCESS_INPUT_INVALID");
    const bytes = Buffer.alloc(Number(metadata.size));
    let offset = 0;
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (read < 1) throw Error("NATIVE_PROCESS_INPUT_CHANGED");
      offset += read;
    }
    if (readSync(fd, new Uint8Array(1), 0, 1, offset) !== 0 || !same(metadata, fstatSync(fd, { bigint: true }))
      || !same(metadata, lstatSync(path, { bigint: true }))) throw Error("NATIVE_PROCESS_INPUT_CHANGED");
    return bytes;
  } finally { closeSync(fd); }
}

/** No ambient Cargo configuration is admitted. This includes both filenames in
 * Cargo home and every working-directory ancestor, including dangling links. */
export function assertNativeCargoConfigurationAbsent(cwd: string, cargoHome: string): void {
  const directories = new Set([resolve(cargoHome)]);
  let directory = realpathSync(cwd);
  for (;;) {
    directories.add(join(directory, ".cargo"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const root of directories) for (const name of ["config", "config.toml"]) {
    try { lstatSync(join(root, name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw Error("NATIVE_PROCESS_CARGO_CONFIG_UNREADABLE");
    }
    throw Error("NATIVE_PROCESS_AMBIENT_CARGO_CONFIG");
  }
}

export type NativeSourceInput = Readonly<{ path: string; bytes: number; sha256: string }>;
export function nativeProcessSourceInventory(root: string): readonly NativeSourceInput[] {
  // Bind the child-custody runner, repository identity and owner tag-policy
  // import closures. Reusing CLI policy never leaves its source unbound.
  const paths: string[] = ["package.json", "bun.lock", ".bun-version", "LICENSE",
    "scripts/bounded-process.ts", "scripts/authority-supervisor-artifact.ts", "src/install-normalizer.ts",
    "scripts/release-repository-identity.ts", "scripts/bounded-json-response.ts",
    "scripts/release-distribution-policy.ts", "scripts/release-package-policy.ts",
    "scripts/release-tag-policy.ts", "scripts/check-commit-ci-run.ts"];
  const walk = (directory: string, depth = 0): void => {
    if (depth > 16 || paths.length > 256) throw Error("NATIVE_PROCESS_SOURCE_BOUND");
    const metadata = lstatSync(join(root, directory));
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error("NATIVE_PROCESS_SOURCE_INVALID");
    for (const name of readdirSync(join(root, directory)).sort()) {
      if (name === "target" || name === "node_modules" || name === "native-artifacts") continue;
      const path = join(directory, name);
      const entry = lstatSync(join(root, path));
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && !entry.isSymbolicLink()) paths.push(path);
      else throw Error("NATIVE_PROCESS_SOURCE_INVALID");
    }
  };
  walk("native/process-kernel");
  walk("packages/native-process");
  for (const name of readdirSync(join(root, "scripts"))) {
    if (/^native-process-.*\.(?:ts|mjs)$/u.test(name)) paths.push(join("scripts", name));
  }
  if (paths.length > 256) throw Error("NATIVE_PROCESS_SOURCE_BOUND");
  return Object.freeze(paths.sort().map(path => {
    const bytes = nativeBuildInput(join(root, path), path === "bun.lock" ? 4 * 1024 * 1024 : 1024 * 1024);
    return Object.freeze({ path: relative(root, join(root, path)).replaceAll("\\", "/"), bytes: bytes.length, sha256: nativeInputHash(bytes) });
  }));
}
