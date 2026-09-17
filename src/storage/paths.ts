import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { chmod, lstat, mkdir, realpath } from "node:fs/promises";

import type { ProfileId } from "../domain/values";

export type StatePaths = {
  root: string;
  database: string;
  factsMemoryControl: string;
  factsMemorySessions: string;
  projectMemory: string;
  profiles: string;
  runtime: string;
  socket: string;
  capability: string;
  daemonLock: string;
  switchLock: string;
};

/**
 * The provider homes owned by the current OS user rather than by an Oompa
 * profile. Merely resolving these paths grants no read or write authority;
 * the session-adoption policy and the provider-specific custody check do that.
 */
export type PersonalProviderPaths = Readonly<{
  codexHome: string;
  claudeConfigDir: string;
}>;

export function personalProviderPaths(
  homeDirectory: string = homedir(),
): PersonalProviderPaths {
  const home = resolve(homeDirectory);
  return {
    claudeConfigDir: join(home, ".claude"),
    codexHome: join(home, ".codex"),
  };
}

export function resolveStatePaths(input: { homeDirectory?: string; platform?: NodeJS.Platform; rootDirectory?: string } = {}): StatePaths {
  const home = resolve(input.homeDirectory ?? homedir());
  const platform = input.platform ?? process.platform;
  const configuredRoot = input.rootDirectory;
  if (configuredRoot !== undefined && !isAbsolute(configuredRoot)) {
    throw new Error("Injected state root must be an absolute path.");
  }
  const root = configuredRoot === undefined
    ? platform === "darwin"
      ? join(home, "Library", "Application Support", "HRA Control Plane v1")
      : join(home, ".local", "state", "hra-control-plane-v1")
    : resolve(configuredRoot);
  const runtime = join(root, "runtime");
  return {
    root,
    database: join(root, "control-plane.sqlite"),
    factsMemoryControl: join(root, "facts-memory-control.sqlite"),
    factsMemorySessions: join(root, "facts-memory-sessions"),
    projectMemory: join(root, "project-memory"),
    profiles: join(root, "profiles"),
    runtime,
    socket: join(runtime, "daemon.sock"),
    capability: join(runtime, "daemon.capability"),
    daemonLock: join(runtime, "daemon.lock"),
    switchLock: join(runtime, "desktop-switch.lock"),
  };
}

export async function ensurePrivateDirectory(path: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error("Private directory path must be absolute.");
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const [metadata, canonical] = await Promise.all([lstat(path), realpath(path)]);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.nlink < 1) {
    throw new Error(`Private path is not a regular directory: ${path}`);
  }
  const owner = process.getuid?.();
  if (owner !== undefined && metadata.uid !== owner) {
    throw new Error(`Private directory is not owned by the current user: ${path}`);
  }
  if (canonical !== resolve(path)) {
    throw new Error(`Private directory must not traverse a symbolic link: ${path}`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
    const after = await lstat(path);
    if ((after.mode & 0o077) !== 0) {
      throw new Error(`Private directory is not user-only: ${path}`);
    }
  }
  return canonical;
}

export async function initializeStatePaths(paths: StatePaths): Promise<void> {
  await ensurePrivateDirectory(paths.root);
  await ensurePrivateDirectory(paths.factsMemorySessions);
  await ensurePrivateDirectory(paths.projectMemory);
  await ensurePrivateDirectory(paths.profiles);
  await ensurePrivateDirectory(paths.runtime);
}

export function profilePaths(paths: StatePaths, profileId: ProfileId): {
  root: string;
  codexHome: string;
  claudeConfigDir: string;
  devinHome: string;
  devinConfigDir: string;
  devinDataDir: string;
  devinCacheDir: string;
  devinStateDir: string;
  desktopUserData: string;
} {
  const root = join(paths.profiles, profileId);
  return {
    root,
    codexHome: join(root, "codex-home"),
    // The isolated `CLAUDE_CONFIG_DIR` is the entire Claude Code
    // authentication boundary for this account. Oompa never reads inside it.
    claudeConfigDir: join(root, "claude-config"),
    // Devin owns every credential and provider-private file below this
    // isolated HOME/XDG boundary. HRA only supplies the paths to the CLI.
    devinHome: join(root, "devin-home"),
    devinConfigDir: join(root, "devin-config"),
    devinDataDir: join(root, "devin-data"),
    devinCacheDir: join(root, "devin-cache"),
    devinStateDir: join(root, "devin-state"),
    desktopUserData: join(root, "desktop-user-data"),
  };
}

export async function initializeProfilePaths(paths: StatePaths, profileId: ProfileId): Promise<ReturnType<typeof profilePaths>> {
  const owned = profilePaths(paths, profileId);
  await ensurePrivateDirectory(owned.root);
  await ensurePrivateDirectory(owned.codexHome);
  await ensurePrivateDirectory(owned.claudeConfigDir);
  await ensurePrivateDirectory(owned.devinHome);
  await ensurePrivateDirectory(owned.devinConfigDir);
  await ensurePrivateDirectory(owned.devinDataDir);
  await ensurePrivateDirectory(owned.devinCacheDir);
  await ensurePrivateDirectory(owned.devinStateDir);
  await ensurePrivateDirectory(owned.desktopUserData);
  return owned;
}
