import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

import { allowlistedEnvironment } from "../../src/claude/process";
import { detachedProcessError } from "./detachment";

type NodeIdentity = Readonly<{ device: number; inode: number; owner: number; mode: number }>;
type ExecutableIdentity = NodeIdentity & Readonly<{ size: number; mtimeMs: number; ctimeMs: number; sha256: string }>;
const nodeIdentity = (value: Stats): NodeIdentity => ({ device: value.dev, inode: value.ino, owner: value.uid, mode: value.mode });
const sameNode = (a: NodeIdentity, b: NodeIdentity): boolean => a.device === b.device && a.inode === b.inode && a.owner === b.owner && a.mode === b.mode;
const canonical = (path: string): void => {
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096 || path.includes("\0") || realpathSync(path) !== path) throw detachedProcessError("binding_refused");
};

function directory(path: string): NodeIdentity {
  canonical(path);
  const value = lstatSync(path);
  if (!value.isDirectory() || value.uid !== process.getuid?.() || (value.mode & 0o7777) !== 0o700) throw detachedProcessError("binding_refused");
  return Object.freeze(nodeIdentity(value));
}

function executableIdentity(path: string, expectedSha256: string): ExecutableIdentity {
  canonical(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const value = fstatSync(fd);
    if (!value.isFile() || value.nlink !== 1 || value.size < 1 || value.size > 512 * 1024 * 1024
      || (value.mode & 0o111) === 0 || (value.mode & 0o022) !== 0) throw detachedProcessError("binding_refused");
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(65_536);
    let position = 0;
    while (position < value.size) {
      const count = readSync(fd, bytes, 0, Math.min(bytes.length, value.size - position), position);
      if (count < 1) throw detachedProcessError("binding_refused");
      hash.update(bytes.subarray(0, count)); position += count;
    }
    bytes.fill(0);
    const after = fstatSync(fd);
    if (!sameNode(nodeIdentity(value), nodeIdentity(after)) || value.size !== after.size || value.mtimeMs !== after.mtimeMs
      || value.ctimeMs !== after.ctimeMs || !sameNode(nodeIdentity(after), nodeIdentity(lstatSync(path)))) throw detachedProcessError("binding_refused");
    const sha256 = hash.digest("hex");
    if (sha256 !== expectedSha256) throw detachedProcessError("binding_refused");
    return Object.freeze({ ...nodeIdentity(value), size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs, sha256 });
  } finally { closeSync(fd); }
}

export type ClaudeQualificationBindingInput = Readonly<{
  executablePath: string;
  executableSha256: string;
  configDir: string;
  temporaryDirectory: string;
  environment: Readonly<Record<string, string | undefined>>;
}>;

/** Captures and rechecks files and environment only. This grants no spawn or live authority. */
export function bindDarwinQualificationEnvironment(input: ClaudeQualificationBindingInput): Readonly<{
  executablePath: string;
  configDir: string;
  environment: Readonly<Record<string, string>>;
  assertCurrent(): void;
}> {
  input = Object.freeze({ ...input, environment: Object.freeze({ ...input.environment }) });
  if (process.platform !== "darwin" || Bun.version !== "1.3.14") throw detachedProcessError("platform_refused");
  if (!/^[0-9a-f]{64}$/u.test(input.executableSha256)) throw detachedProcessError("binding_refused");
  const executable = executableIdentity(input.executablePath, input.executableSha256);
  const config = directory(input.configDir);
  const temporary = directory(input.temporaryDirectory);
  const temporaryRoot = realpathSync(tmpdir());
  if (sameNode(config, temporary) || !input.configDir.startsWith(`${temporaryRoot}/`)
    || !input.temporaryDirectory.startsWith(`${temporaryRoot}/`) || input.configDir.startsWith(`${input.temporaryDirectory}/`)
    || input.temporaryDirectory.startsWith(`${input.configDir}/`)) throw detachedProcessError("binding_refused");
  const environment: Readonly<Record<string, string>> = Object.freeze({ ...allowlistedEnvironment(input.environment), CLAUDE_CONFIG_DIR: input.configDir, TMPDIR: input.temporaryDirectory, NO_COLOR: "1" });
  if (environment.HOME !== homedir() || Object.values(environment).some((value) => value.includes("\0") || value.length > 4096)) throw detachedProcessError("binding_refused");
  return Object.freeze({ executablePath: input.executablePath, configDir: input.configDir, environment,
    assertCurrent() {
      if (!sameNode(config, directory(input.configDir)) || !sameNode(temporary, directory(input.temporaryDirectory))
        || JSON.stringify(executable) !== JSON.stringify(executableIdentity(input.executablePath, input.executableSha256))) throw detachedProcessError("binding_changed");
    },
  });
}
