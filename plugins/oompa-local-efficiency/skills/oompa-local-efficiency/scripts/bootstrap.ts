#!/usr/bin/env bun

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ensureExactSymlink,
  legacyMarkerPair,
  type ManagedMarkerPair,
  normalizeTrailingNewline,
  readText,
  replaceManagedBlock,
  resolvedBunBin,
  resolvedCodexHome,
  sha256,
  symlinkMatches,
  writeAtomic,
} from "./shared";
import { resolveSlopcameraHostResourceModule, resolveSlopcameraRuntimeRoot } from "./host-run";
import { slopcameraArtifacts, slopcameraCommit, slopcameraRuntimeDescription } from "./runtime-pin";

type Mode = "apply" | "check";

export type ClaudeAutoModeCapability = Readonly<{
  available: boolean;
  reason: "available" | "cli_missing" | "cli_too_old" | "config_unavailable";
  version: string | null;
}>;

export type BootstrapOptions = {
  readonly bunBin: string;
  readonly claudeHome?: string;
  readonly codexHome: string;
  readonly installDependency: boolean;
  readonly mode: Mode;
  readonly runtimeRoot: string;
};

const startMarker = "<!-- oompa-local-efficiency:start -->";
const endMarker = "<!-- oompa-local-efficiency:end -->";
const legacyMarkers = legacyMarkerPair(startMarker, endMarker);
const rulesStartMarker = "# oompa-local-efficiency:rules:start";
const rulesEndMarker = "# oompa-local-efficiency:rules:end";
const legacyRulesMarkers = legacyMarkerPair(rulesStartMarker, rulesEndMarker);
const codexConfigStartMarker = "# oompa-local-efficiency:config:start";
const codexConfigEndMarker = "# oompa-local-efficiency:config:end";
const legacyCodexConfigMarkers = legacyMarkerPair(codexConfigStartMarker, codexConfigEndMarker);
const claudeSettings = Object.freeze({
  defaultMode: "auto",
});
const minimumClaudeAutoModeVersion = Object.freeze([2, 1, 83] as const);
const pluginName = "oompa-local-efficiency";
// The previous plugin identity. Its installed command links, managed blocks,
// rule file, and profile files are migrated in place by the bootstrap.
const legacyPluginName = "hra-local-efficiency";
const pluginNames: readonly string[] = Object.freeze([pluginName, legacyPluginName]);
const profileNames = Object.freeze(["oompa-worker.config.toml", "oompa-routine.config.toml"]);

function legacyName(name: string): string {
  return name.replace(/^oompa-/u, "hra-");
}

const commandScripts = Object.freeze([
  "host-run.ts",
  "host-queue.ts",
  "validation-run.ts",
  "workspace-audit.ts",
  "session-audit.ts",
  "throughput-report.ts",
  "ci-ref-audit.ts",
  "repo-adoption.ts",
  "doctor.ts",
]);

function regularFileModeOrDefault(
  path: string,
  description = "global guidance",
  defaultMode = 0o644,
): number {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) {
      throw new Error(`refusing to replace non-regular ${description}: ${path}`);
    }
    if (metadata.nlink !== 1) {
      throw new Error(`refusing to replace hard-linked ${description}: ${path}`);
    }
    return metadata.mode & 0o777;
  } catch (error: unknown) {
    if (
      typeof error === "object"
      && error !== null
      && "code" in error
      && error.code === "ENOENT"
    ) return defaultMode;
    throw error;
  }
}

export function resolvedClaudeHome(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  userHome = homedir(),
): string {
  const configured = environment.CLAUDE_CONFIG_DIR;
  if (configured !== undefined && configured !== "") {
    if (!isAbsolute(configured)) throw new Error("CLAUDE_CONFIG_DIR must be absolute");
    return resolve(configured);
  }
  return join(userHome, ".claude");
}

export function parseBootstrapArguments(arguments_: readonly string[]): BootstrapOptions {
  let bunBin = resolvedBunBin();
  let claudeHome = resolvedClaudeHome();
  let codexHome = resolvedCodexHome();
  let installDependency = true;
  let mode: Mode | undefined;
  const runtimeRoot = resolveSlopcameraRuntimeRoot();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--apply" || argument === "--check") {
      if (mode !== undefined) throw new Error("choose exactly one of --apply or --check");
      mode = argument.slice(2) as Mode;
      continue;
    }
    if (argument === "--skip-dependency-install") {
      installDependency = false;
      continue;
    }
    if (
      argument === "--codex-home"
      || argument === "--claude-home"
      || argument === "--bun-bin"
    ) {
      const value = arguments_[index + 1];
      if (value === undefined || !value.startsWith("/")) {
        throw new Error(`${argument} requires an absolute path`);
      }
      if (argument === "--codex-home") codexHome = resolve(value);
      else if (argument === "--claude-home") claudeHome = resolve(value);
      else bunBin = resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`unknown bootstrap argument: ${argument}`);
  }
  if (mode === undefined) throw new Error("choose --apply or --check");
  return { bunBin, claudeHome, codexHome, installDependency, mode, runtimeRoot };
}

function skillRoot(): string {
  return resolve(import.meta.dir, "..");
}

function asset(name: string): string {
  return readFileSync(join(skillRoot(), "assets", name), "utf8");
}

function versionAtLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < actual.length; index += 1) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export function claudeAutoModeCapability(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): ClaudeAutoModeCapability {
  try {
    const versionProbe = Bun.spawnSync({
      cmd: ["claude", "--version"],
      env: environment,
      maxBuffer: 1024 * 1024,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 10_000,
    });
    if (versionProbe.exitCode !== 0) {
      return Object.freeze({ available: false, reason: "cli_missing", version: null });
    }
    const versionText = versionProbe.stdout.toString().trim();
    const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/u.exec(versionText);
    if (match === null) {
      return Object.freeze({ available: false, reason: "cli_too_old", version: null });
    }
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    const coordinates = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
    if (!versionAtLeast(coordinates, minimumClaudeAutoModeVersion)) {
      return Object.freeze({ available: false, reason: "cli_too_old", version });
    }
    for (const action of ["config", "defaults"] as const) {
      const probe = Bun.spawnSync({
        cmd: ["claude", "auto-mode", action],
        env: environment,
        maxBuffer: 1024 * 1024,
        stderr: "pipe",
        stdout: "pipe",
        timeout: 10_000,
      });
      const output = probe.stdout;
      if (probe.exitCode !== 0 || output.byteLength < 2 || output.byteLength > 1024 * 1024) {
        return Object.freeze({ available: false, reason: "config_unavailable", version });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(output.toString());
      } catch {
        return Object.freeze({ available: false, reason: "config_unavailable", version });
      }
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return Object.freeze({ available: false, reason: "config_unavailable", version });
      }
      const lists = parsed as Record<string, unknown>;
      const requiresNonemptyLists = action === "defaults";
      if (!["allow", "environment", "hard_deny", "soft_deny"].every((key) => {
        const list = lists[key];
        return Array.isArray(list)
          && (!requiresNonemptyLists || list.length > 0)
          && list.every((entry) => typeof entry === "string" && entry.length > 0);
      })) return Object.freeze({ available: false, reason: "config_unavailable", version });
    }
    return Object.freeze({ available: true, reason: "available", version });
  } catch {
    return Object.freeze({ available: false, reason: "cli_missing", version: null });
  }
}

const commandNames = Object.freeze([
  Object.freeze(["oompa-host-run", "host-run.ts"] as const),
  Object.freeze(["oompa-host-queue", "host-queue.ts"] as const),
  Object.freeze(["oompa-validate", "validation-run.ts"] as const),
  Object.freeze(["oompa-workspace-audit", "workspace-audit.ts"] as const),
  Object.freeze(["oompa-session-audit", "session-audit.ts"] as const),
  Object.freeze(["oompa-throughput-report", "throughput-report.ts"] as const),
  Object.freeze(["oompa-ci-ref-audit", "ci-ref-audit.ts"] as const),
  Object.freeze(["oompa-repo-adoption", "repo-adoption.ts"] as const),
  Object.freeze(["oompa-local-efficiency", "doctor.ts"] as const),
]);

function commandLinks(
  bunBin: string,
  rename: (name: string) => string,
): readonly [string, string][] {
  return commandNames.map(([name, script]) => [
    join(bunBin, rename(name)),
    join(skillRoot(), "scripts", script),
  ] as const);
}

export function commandTargets(bunBin: string): readonly [string, string][] {
  return commandLinks(bunBin, (name) => name);
}

// Compatibility links under the former command names. Repository guidance that
// has not been re-adopted still names them.
export function legacyCommandTargets(bunBin: string): readonly [string, string][] {
  return commandLinks(bunBin, legacyName);
}

function missingPath(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "ENOENT";
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: unknown) {
    if (missingPath(error)) return false;
    throw error;
  }
}

// A machine that never installed a legacy command name is not asked to add
// one; a machine that has any legacy name must keep every legacy link current.
export function legacyCommandsPresent(bunBin: string): boolean {
  return legacyCommandTargets(bunBin).some(([link]) => pathExists(link));
}

type LegacyFileMigration = Readonly<{
  mode: number;
  path: string;
}>;

// A legacy file is migrated only while its current-named replacement is
// absent. A regular single-link legacy file is read and then removed by
// --apply; a legacy symlink is left in place because it is dotfiles-managed
// user state; any other legacy entry is refused.
function legacyFileMigration(
  currentPath: string,
  legacyPath: string,
  description: string,
): LegacyFileMigration | null {
  if (pathExists(currentPath)) return null;
  let metadata;
  try {
    metadata = lstatSync(legacyPath);
  } catch (error: unknown) {
    if (missingPath(error)) return null;
    throw error;
  }
  if (metadata.isSymbolicLink()) return null;
  if (!metadata.isFile()) {
    throw new Error(`refusing to migrate non-regular legacy ${description}: ${legacyPath}`);
  }
  if (metadata.nlink !== 1) {
    throw new Error(`refusing to migrate hard-linked legacy ${description}: ${legacyPath}`);
  }
  return { mode: metadata.mode & 0o777, path: legacyPath };
}

function removeMigratedLegacyFile(migration: LegacyFileMigration): void {
  const metadata = lstatSync(migration.path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`legacy file changed during migration: ${migration.path}`);
  }
  unlinkSync(migration.path);
}

function verifiedRegularText(path: string, maximumBytes: number): string | null {
  try {
    const before = lstatSync(path);
    if (
      !before.isFile()
      || before.isSymbolicLink()
      || before.nlink !== 1
      || before.size < 1
      || before.size > maximumBytes
    ) return null;
    const value = readFileSync(path, "utf8");
    const after = lstatSync(path);
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || after.nlink !== 1
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || Buffer.byteLength(value) !== after.size
    ) return null;
    return value;
  } catch {
    return null;
  }
}

// A prior install is owned when every identity segment agrees on one plugin
// name, which may be the current name or the legacy name it replaced.
function pluginIdentityMatches(pluginRoot: string, skillRoot_: string, name: string): boolean {
  const manifestText = verifiedRegularText(
    join(pluginRoot, ".codex-plugin", "plugin.json"),
    16 * 1024,
  );
  const skillText = verifiedRegularText(join(skillRoot_, "SKILL.md"), 64 * 1024);
  if (manifestText === null || skillText === null) return false;
  try {
    const manifest: unknown = JSON.parse(manifestText);
    if (
      typeof manifest !== "object"
      || manifest === null
      || !("name" in manifest)
      || manifest.name !== name
      || !("skills" in manifest)
      || manifest.skills !== "./skills/"
    ) return false;
  } catch {
    return false;
  }
  const lines = skillText.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") return false;
  const end = lines.indexOf("---", 1);
  if (end < 2) return false;
  return lines.slice(1, end).filter((line) => line.startsWith("name:")).length === 1
    && lines.slice(1, end).includes(`name: ${name}`);
}

function isReservedDanglingCacheTarget(
  existingTarget: string,
  codexHome: string,
  expectedScript: string,
): boolean {
  if (!isAbsolute(existingTarget) || !commandScripts.includes(expectedScript)) return false;
  const cacheRoot = resolve(codexHome, "plugins", "cache");
  const relativeTarget = relative(cacheRoot, resolve(existingTarget));
  if (
    relativeTarget === ""
    || isAbsolute(relativeTarget)
    || relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
  ) return false;
  const safeMarketplace = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const safeVersion = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
  const segments = relativeTarget.split(sep);
  return segments.length === 7
    && safeMarketplace.test(segments[0] ?? "")
    && pluginNames.includes(segments[1] ?? "")
    && safeVersion.test(segments[2] ?? "")
    && segments[3] === "skills"
    && segments[4] === segments[1]
    && segments[5] === "scripts"
    && segments[6] === expectedScript;
}

export function isManagedPriorCommandTarget(
  existingTarget: string,
  codexHome: string,
  expectedScript: string,
): boolean {
  if (!commandScripts.includes(expectedScript)) return false;
  try {
    const metadata = lstatSync(existingTarget);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) return false;
    const target = realpathSync(existingTarget);
    if (basename(target) !== expectedScript || basename(dirname(target)) !== "scripts") return false;
    const skillRoot_ = dirname(dirname(target));
    const name = basename(skillRoot_);
    if (!pluginNames.includes(name) || basename(dirname(skillRoot_)) !== "skills") return false;
    const pluginRoot = dirname(dirname(skillRoot_));
    if (!pluginIdentityMatches(pluginRoot, skillRoot_, name)) return false;

    const sourceCheckout = basename(pluginRoot) === name
      && basename(dirname(pluginRoot)) === "plugins";
    let pluginCache = false;
    try {
      const cacheRoot = realpathSync(resolve(codexHome, "plugins", "cache"));
      const relativePlugin = relative(cacheRoot, pluginRoot);
      const segments = relativePlugin.split(sep);
      pluginCache = relativePlugin !== ""
        && !isAbsolute(relativePlugin)
        && relativePlugin !== ".."
        && !relativePlugin.startsWith(`..${sep}`)
        && segments.length === 3
        && segments[0] !== ""
        && segments[1] === name
        && segments[2] !== "";
    } catch { /* A source checkout need not have a plugin cache. */ }
    return sourceCheckout || pluginCache;
  } catch (error: unknown) {
    return missingPath(error)
      && isReservedDanglingCacheTarget(existingTarget, codexHome, expectedScript);
  }
}

export function ensureManagedCommandSymlink(
  target: string,
  link: string,
  codexHome: string,
): "created" | "current" | "updated" {
  preflightManagedCommandSymlink(target, link, codexHome);
  return ensureExactSymlink(target, link);
}

function preflightManagedCommandSymlink(
  target: string,
  link: string,
  codexHome: string,
): void {
  try {
    const metadata = lstatSync(link);
    if (!metadata.isSymbolicLink()) {
      throw new Error(`refusing to replace unmanaged non-symlink: ${link}`);
    }
    const existingTarget = resolve(dirname(link), readlinkSync(link));
    if (
      existingTarget !== resolve(target)
      && !isManagedPriorCommandTarget(existingTarget, codexHome, basename(target))
    ) {
      throw new Error(`refusing to replace unmanaged command symlink: ${link}`);
    }
  } catch (error: unknown) {
    if (!missingPath(error)) throw error;
  }
}

function dependencyAvailable(
  runtimeRoot: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): boolean {
  try {
    const configured = environment.OOMPA_SLOPCAMERA_HOST_RESOURCES_MODULE;
    const modulePath = configured === undefined || configured === ""
      ? join(runtimeRoot, "host-resources.js")
      : resolveSlopcameraHostResourceModule(environment);
    if (configured === undefined || configured === "") {
      for (const artifact of slopcameraArtifacts) {
        const path = join(runtimeRoot, artifact.name);
        const metadata = lstatSync(path);
        if (
          !metadata.isFile()
          || metadata.isSymbolicLink()
          || metadata.nlink !== 1
          || metadata.size !== artifact.bytes
          || sha256(readFileSync(path)) !== artifact.sha256
        ) return false;
      }
    }
    const moduleUrl = pathToFileURL(modulePath).href;
    const probe = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        `const value = await import(${JSON.stringify(moduleUrl)}); if (typeof value.createHostResourceCoordinator !== "function") process.exit(1);`,
      ],
      stderr: "pipe",
      stdout: "pipe",
    });
    return probe.exitCode === 0;
  } catch {
    return false;
  }
}

async function downloadSlopcameraArtifact(
  artifact: (typeof slopcameraArtifacts)[number],
  fetcher: typeof fetch = fetch,
): Promise<Uint8Array> {
  const url = `https://raw.githubusercontent.com/hraness/slopcamera/${slopcameraCommit}/${artifact.source}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(url, { redirect: "error", signal: controller.signal });
    if (!response.ok || response.url !== url || response.body === null) {
      throw new Error(`failed to download pinned ${artifact.name}`);
    }
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    let total = 0;
    let next = await reader.read();
    while (!next.done) {
      total += next.value.byteLength;
      if (total > artifact.bytes) {
        await reader.cancel();
        throw new Error(`pinned ${artifact.name} exceeded its exact byte bound`);
      }
      chunks.push(next.value);
      next = await reader.read();
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    if (bytes.byteLength !== artifact.bytes || sha256(bytes) !== artifact.sha256) {
      throw new Error(`pinned ${artifact.name} failed byte verification`);
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

export async function installSlopcameraRuntime(
  runtimeRoot: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const downloaded = await Promise.all(
    slopcameraArtifacts.map(async (artifact) => [artifact, await downloadSlopcameraArtifact(artifact, fetcher)] as const),
  );
  mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const rootMetadata = lstatSync(runtimeRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("refusing a non-directory private runtime root");
  }
  for (const [artifact, bytes] of downloaded) {
    writeAtomic(join(runtimeRoot, artifact.name), Buffer.from(bytes).toString("utf8"), 0o600);
  }
}

function expectedGlobalAgents(codexHome: string): string {
  return replaceManagedBlock(
    readText(join(codexHome, "AGENTS.md")),
    asset("global-agents-block.md"),
    startMarker,
    endMarker,
    legacyMarkers,
  );
}

function markerOccurrences(value: string, marker: string): number {
  return value.split(marker).length - 1;
}

function managedMarkerLine(
  value: string,
  marker: string,
  description: string,
): { readonly after: number; readonly start: number } {
  const markerIndex = value.indexOf(marker);
  const start = value.lastIndexOf("\n", markerIndex - 1) + 1;
  const newline = value.indexOf("\n", markerIndex + marker.length);
  const lineEnd = newline < 0 ? value.length : newline;
  if (value.slice(start, lineEnd).replace(/\r$/u, "").trim() !== marker) {
    throw new Error(`${description} managed marker must occupy its own line`);
  }
  return { after: newline < 0 ? value.length : newline + 1, start };
}

function assertTomlCommentMarker(value: string, marker: string, description: string): void {
  const markerIndex = value.indexOf(marker);
  const lineStart = value.lastIndexOf("\n", markerIndex - 1) + 1;
  const newline = value.indexOf("\n", markerIndex + marker.length);
  const lineEnd = newline < 0 ? value.length : newline;
  const probeKey = "__hra_local_efficiency_marker_probe__";
  const original = Bun.TOML.parse(value) as Record<string, unknown>;
  if (Object.hasOwn(original, probeKey)) {
    throw new Error(`${description} contains the reserved marker probe key`);
  }
  const probe = `${value.slice(0, lineStart)}${probeKey} = true${value.slice(lineEnd)}`;
  try {
    const parsed = Bun.TOML.parse(probe) as Record<string, unknown>;
    if (parsed[probeKey] === true) return;
  } catch {
    // Fall through to the same bounded refusal for a non-comment marker.
  }
  throw new Error(`${description} managed marker must be a TOML comment token`);
}

function removeManagedBlock(
  value: string,
  start: string,
  end: string,
  description: string,
): string {
  const starts = markerOccurrences(value, start);
  const ends = markerOccurrences(value, end);
  if (starts === 0 && ends === 0) return value;
  if (starts !== 1 || ends !== 1) {
    throw new Error(`${description} managed block markers are incomplete or duplicated`);
  }
  const startLine = managedMarkerLine(value, start, description);
  const endLine = managedMarkerLine(value, end, description);
  assertTomlCommentMarker(value, start, description);
  assertTomlCommentMarker(value, end, description);
  if (endLine.start < startLine.start) {
    throw new Error(`${description} managed block markers are reversed`);
  }
  return `${value.slice(0, startLine.start)}${value.slice(endLine.after)}`;
}

function parseTomlDocument(value: string, description: string): Record<string, unknown> {
  try {
    const parsed: unknown = Bun.TOML.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("document root is not a table");
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    throw new Error(
      `${description} is not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function codexConfigBlock(): string {
  return `${codexConfigStartMarker}\n`
    + 'approval_policy = "on-request"\n'
    + 'approvals_reviewer = "auto_review"\n'
    + 'default_permissions = ":workspace"\n'
    + `${codexConfigEndMarker}\n`;
}

// The legacy marker pair is an alias for the current pair while exactly one of
// them is present; a document carrying both is refused.
function codexConfigMarkers(value: string): ManagedMarkerPair {
  const currentCount = markerOccurrences(value, codexConfigStartMarker)
    + markerOccurrences(value, codexConfigEndMarker);
  const legacyCount = markerOccurrences(value, legacyCodexConfigMarkers.start)
    + markerOccurrences(value, legacyCodexConfigMarkers.end);
  if (currentCount > 0 && legacyCount > 0) {
    throw new Error("Codex config managed block markers mix legacy and current");
  }
  return legacyCount > 0
    ? legacyCodexConfigMarkers
    : { end: codexConfigEndMarker, start: codexConfigStartMarker };
}

function expectedCodexConfig(codexHome: string): string {
  const configPath = join(codexHome, "config.toml");
  const current = readText(configPath) ?? "";
  parseTomlDocument(current, "Codex config");
  const markers = codexConfigMarkers(current);
  let unmanaged = removeManagedBlock(
    current,
    markers.start,
    markers.end,
    "Codex config",
  );
  const unmanagedRoot = parseTomlDocument(unmanaged, "Codex config outside the managed block");
  for (const key of ["approval_policy", "approvals_reviewer", "default_permissions"]) {
    if (!Object.hasOwn(unmanagedRoot, key)) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const assignment = new RegExp(
      `^[\\t ]*(?:${escaped}|"${escaped}"|'${escaped}')[\\t ]*=.*(?:\\r?\\n|$)`,
      "gmu",
    );
    const matches = [...unmanaged.matchAll(assignment)];
    if (matches.length !== 1 || matches[0]?.index === undefined) {
      throw new Error(`cannot safely replace top-level Codex setting: ${key}`);
    }
    const match = matches[0];
    unmanaged = `${unmanaged.slice(0, match.index)}${unmanaged.slice(match.index + match[0].length)}`;
  }
  parseTomlDocument(unmanaged, "Codex config after removing managed settings");
  const bom = unmanaged.startsWith("\uFEFF") ? "\uFEFF" : "";
  const remainder = bom === "" ? unmanaged : unmanaged.slice(1);
  const expected = `${bom}${codexConfigBlock()}${remainder}`;
  const parsed = parseTomlDocument(expected, "managed Codex config");
  if (
    parsed.approval_policy !== "on-request"
    || parsed.approvals_reviewer !== "auto_review"
    || parsed.default_permissions !== ":workspace"
  ) throw new Error("managed Codex settings did not converge");
  return expected;
}

type JsonMemberSpan = {
  readonly key: string;
  readonly keyStart: number;
  readonly valueEnd: number;
  readonly valueStart: number;
};

type JsonObjectSpan = {
  readonly close: number;
  readonly members: readonly JsonMemberSpan[];
  readonly open: number;
};

function skipJsonWhitespace(value: string, start: number): number {
  let index = start;
  while (index < value.length && /[\t\n\r ]/u.test(value[index] ?? "")) index += 1;
  return index;
}

function scanJsonString(value: string, start: number): number {
  if (value[start] !== '"') throw new Error("expected a JSON string");
  let index = start + 1;
  while (index < value.length) {
    const character = value[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    index += 1;
  }
  throw new Error("unterminated JSON string");
}

function scanJsonValue(value: string, start: number): number {
  const first = value[start];
  if (first === '"') return scanJsonString(value, start);
  if (first === "{" || first === "[") {
    const stack = [first];
    let index = start + 1;
    while (index < value.length && stack.length > 0) {
      const character = value[index];
      if (character === '"') {
        index = scanJsonString(value, index);
        continue;
      }
      if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") stack.pop();
      index += 1;
    }
    if (stack.length > 0) throw new Error("unterminated JSON collection");
    return index;
  }
  let index = start;
  while (index < value.length && !/[\t\n\r ,}\]]/u.test(value[index] ?? "")) index += 1;
  return index;
}

function describeJsonObject(value: string, open: number): JsonObjectSpan {
  if (value[open] !== "{") throw new Error("managed JSON path must be an object");
  const members: JsonMemberSpan[] = [];
  const keys = new Set<string>();
  let index = skipJsonWhitespace(value, open + 1);
  while (value[index] !== "}") {
    const keyStart = index;
    const keyEnd = scanJsonString(value, keyStart);
    const key = JSON.parse(value.slice(keyStart, keyEnd)) as string;
    if (keys.has(key)) throw new Error(`JSON object contains duplicate key: ${key}`);
    keys.add(key);
    index = skipJsonWhitespace(value, keyEnd);
    if (value[index] !== ":") throw new Error("expected a JSON object colon");
    const valueStart = skipJsonWhitespace(value, index + 1);
    const valueEnd = scanJsonValue(value, valueStart);
    members.push({ key, keyStart, valueEnd, valueStart });
    index = skipJsonWhitespace(value, valueEnd);
    if (value[index] === "}") break;
    if (value[index] !== ",") throw new Error("expected a JSON object comma");
    index = skipJsonWhitespace(value, index + 1);
  }
  if (value[index] !== "}") throw new Error("unterminated JSON object");
  return { close: index, members, open };
}

function rootJsonObject(value: string, description: string): JsonObjectSpan {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("document root is not an object");
    }
    const open = skipJsonWhitespace(value, 0);
    return describeJsonObject(value, open);
  } catch (error: unknown) {
    throw new Error(
      `${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function nestedJsonObject(value: string, path: readonly string[], description: string): JsonObjectSpan {
  let object = rootJsonObject(value, description);
  for (const key of path) {
    const member = object.members.find((candidate) => candidate.key === key);
    if (member === undefined || value[member.valueStart] !== "{") {
      throw new Error(`${description} ${key} must be an object`);
    }
    object = describeJsonObject(value, member.valueStart);
  }
  return object;
}

function memberIndent(value: string, member: JsonMemberSpan): string {
  const lineStart = value.lastIndexOf("\n", member.keyStart - 1) + 1;
  const prefix = value.slice(lineStart, member.keyStart);
  return /^[\t ]*$/u.test(prefix) ? prefix : "  ";
}

function upsertJsonProperty(
  value: string,
  path: readonly string[],
  key: string,
  serialized: string,
  description: string,
): string {
  const object = nestedJsonObject(value, path, description);
  const existing = object.members.find((member) => member.key === key);
  if (existing !== undefined) {
    return `${value.slice(0, existing.valueStart)}${serialized}${value.slice(existing.valueEnd)}`;
  }
  if (object.members.length === 0) {
    const interior = value.slice(object.open + 1, object.close);
    if (interior.includes("\n")) {
      const closeLineStart = value.lastIndexOf("\n", object.close - 1) + 1;
      const closeIndent = value.slice(closeLineStart, object.close);
      const newline = value.includes("\r\n") ? "\r\n" : "\n";
      const inserted = `${newline}${closeIndent}  ${JSON.stringify(key)}: ${serialized}${newline}${closeIndent}`;
      return `${value.slice(0, object.open + 1)}${inserted}${value.slice(object.close)}`;
    }
    return `${value.slice(0, object.close)}${JSON.stringify(key)}: ${serialized}${value.slice(object.close)}`;
  }
  const last = object.members.at(-1) as JsonMemberSpan;
  const suffix = value.slice(last.valueEnd, object.close);
  const newline = value.includes("\r\n") ? "\r\n" : "\n";
  const separator = suffix.includes("\n")
    ? `,${newline}${memberIndent(value, object.members[0] as JsonMemberSpan)}`
    : ", ";
  const inserted = `${separator}${JSON.stringify(key)}: ${serialized}`;
  return `${value.slice(0, last.valueEnd)}${inserted}${value.slice(last.valueEnd)}`;
}

function isBroadClaudePermissionAllow(rule: string): boolean {
  // Claude permission rules name a whole tool when they contain only the tool
  // identifier. Keep this syntax-based so newly added built-ins and MCP tools
  // cannot silently bypass Auto mode's classifier.
  if (/^[A-Za-z][A-Za-z0-9_.:-]*$/u.test(rule)) return true;
  if (/^[A-Za-z][A-Za-z0-9_.:-]*\(\s*(?:\*|\*\*|\/\*\*)\s*\)$/u.test(rule)) {
    return true;
  }
  const shell = /^(?:Bash|PowerShell)\((.*)\)$/u.exec(rule);
  return shell !== null && (shell[1] ?? "").includes("*");
}

function retainedClaudePermissionAllows(value: string): readonly string[] {
  const parsed = JSON.parse(value) as { permissions?: { allow?: unknown } };
  const allow = parsed.permissions?.allow;
  if (allow === undefined) return [];
  if (!Array.isArray(allow) || !allow.every((rule) => typeof rule === "string")) {
    throw new Error("Claude permissions.allow must be an array of strings");
  }
  return allow.filter((rule) => !isBroadClaudePermissionAllow(rule));
}

function claudeAutoModeList(
  value: string,
  key: "allow" | "environment" | "soft_deny",
): readonly string[] {
  const parsed = JSON.parse(value) as {
    autoMode?: { allow?: unknown; environment?: unknown; soft_deny?: unknown };
  };
  const current = parsed.autoMode?.[key];
  if (current !== undefined && (
    !Array.isArray(current)
    || !current.every((rule) => typeof rule === "string")
  )) throw new Error(`Claude autoMode.${key} must be an array of strings`);
  return ["$defaults", ...(current ?? []).filter((rule) => rule !== "$defaults")];
}

function expectedClaudeSettings(claudeHome: string): string {
  const settingsPath = join(claudeHome, "settings.json");
  let expected = readText(settingsPath) ?? "{}\n";
  const initial = rootJsonObject(expected, "Claude settings");
  const retainedAllows = retainedClaudePermissionAllows(expected);
  const autoModeAllows = claudeAutoModeList(expected, "allow");
  const autoModeEnvironment = claudeAutoModeList(expected, "environment");
  const autoModeSoftDenies = claudeAutoModeList(expected, "soft_deny");
  if (!initial.members.some((member) => member.key === "permissions")) {
    expected = upsertJsonProperty(
      expected,
      [],
      "permissions",
      JSON.stringify({ allow: retainedAllows, defaultMode: claudeSettings.defaultMode }),
      "Claude settings",
    );
  } else {
    expected = upsertJsonProperty(
      expected,
      ["permissions"],
      "defaultMode",
      JSON.stringify(claudeSettings.defaultMode),
      "Claude settings",
    );
    expected = upsertJsonProperty(
      expected,
      ["permissions"],
      "allow",
      JSON.stringify(retainedAllows),
      "Claude settings",
    );
  }
  const afterPermissions = rootJsonObject(expected, "Claude settings");
  if (!afterPermissions.members.some((member) => member.key === "autoMode")) {
    expected = upsertJsonProperty(
      expected,
      [],
      "autoMode",
      JSON.stringify({
        allow: autoModeAllows,
        environment: autoModeEnvironment,
        soft_deny: autoModeSoftDenies,
      }),
      "Claude settings",
    );
  } else {
    expected = upsertJsonProperty(
      expected,
      ["autoMode"],
      "environment",
      JSON.stringify(autoModeEnvironment),
      "Claude settings",
    );
    expected = upsertJsonProperty(
      expected,
      ["autoMode"],
      "allow",
      JSON.stringify(autoModeAllows),
      "Claude settings",
    );
    expected = upsertJsonProperty(
      expected,
      ["autoMode"],
      "soft_deny",
      JSON.stringify(autoModeSoftDenies),
      "Claude settings",
    );
  }
  const parsed = JSON.parse(expected) as {
    autoMode?: { allow?: unknown; environment?: unknown; soft_deny?: unknown };
    permissions?: { allow?: unknown; defaultMode?: unknown };
  };
  if (
    parsed.permissions?.defaultMode !== claudeSettings.defaultMode
    || JSON.stringify(parsed.permissions.allow) !== JSON.stringify(retainedAllows)
    || JSON.stringify(parsed.autoMode?.allow) !== JSON.stringify(autoModeAllows)
    || JSON.stringify(parsed.autoMode?.environment)
      !== JSON.stringify(autoModeEnvironment)
    || JSON.stringify(parsed.autoMode?.soft_deny) !== JSON.stringify(autoModeSoftDenies)
  ) throw new Error("managed Claude settings did not converge");
  return expected;
}

function expectedGlobalClaude(claudeHome: string): string {
  return replaceManagedBlock(
    readText(join(claudeHome, "CLAUDE.md")),
    asset("global-claude-block.md"),
    startMarker,
    endMarker,
    legacyMarkers,
  );
}

export function codexRulesPath(codexHome: string): string {
  return join(codexHome, "rules", `${pluginName}.rules`);
}

export function legacyCodexRulesPath(codexHome: string): string {
  return join(codexHome, "rules", `${legacyPluginName}.rules`);
}

function hostRunPromptRule(hostRun: string, commandName: string): string {
  const hostRunJson = JSON.stringify(hostRun);
  const shellWord = `'${hostRun.replaceAll("'", `'"'"'`)}'`;
  const sample = JSON.stringify(
    `${shellWord} --mode=heavy --label=repo-check -- bun run check`,
  );
  const basenameSample = JSON.stringify(
    `${commandName} --mode=heavy --label=repo-check -- bun run check`,
  );
  const lookalikeSample = JSON.stringify(
    `'${`${hostRun}ner`.replaceAll("'", `'"'"'`)}' --mode=heavy --label=repo-check -- bun run check`,
  );
  return "prefix_rule(\n"
    + `    pattern = [${hostRunJson}],\n`
    + "    decision = \"prompt\",\n"
    + "    justification = \"Oompa host scheduling needs reviewed access to machine-wide state; inspect the complete wrapped command before approval.\",\n"
    + `    match = [${sample}],\n`
    + `    not_match = [${basenameSample}, ${lookalikeSample}],\n`
    + ")\n";
}

export function managedCodexRule(bunBin: string): string {
  const hostRun = join(resolve(bunBin), "oompa-host-run");
  const legacyHostRun = join(resolve(bunBin), legacyName("oompa-host-run"));
  return `${rulesStartMarker}\n`
    + "# Keep this prompt-only: oompa-host-run can wrap arbitrary child commands.\n"
    + hostRunPromptRule(hostRun, "oompa-host-run")
    + "# The legacy hra-host-run compatibility link runs the same wrapper.\n"
    + hostRunPromptRule(legacyHostRun, "hra-host-run")
    + `${rulesEndMarker}\n`;
}

// While the current rule file is absent, a regular legacy rule file supplies
// the unmanaged content that the current file inherits.
function codexRulesMigration(codexHome: string): LegacyFileMigration | null {
  return legacyFileMigration(
    codexRulesPath(codexHome),
    legacyCodexRulesPath(codexHome),
    "Codex rule file",
  );
}

function expectedCodexRules(codexHome: string, bunBin: string): string {
  const migration = codexRulesMigration(codexHome);
  return replaceManagedBlock(
    readText(migration === null ? codexRulesPath(codexHome) : migration.path),
    managedCodexRule(bunBin),
    rulesStartMarker,
    rulesEndMarker,
    legacyRulesMarkers,
  );
}

function profilePath(codexHome: string, profile: string): string {
  return join(codexHome, profile);
}

function profileMigration(codexHome: string, profile: string): LegacyFileMigration | null {
  return legacyFileMigration(
    profilePath(codexHome, profile),
    profilePath(codexHome, legacyName(profile)),
    "Codex profile",
  );
}

export function checkInstallation(
  options: BootstrapOptions,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): string[] {
  const failures: string[] = [];
  const claudeHome = options.claudeHome ?? resolvedClaudeHome(environment);
  const claudeCapability = claudeAutoModeCapability(environment);
  const agentsPath = join(options.codexHome, "AGENTS.md");
  try {
    regularFileModeOrDefault(agentsPath);
    if (readText(agentsPath) !== expectedGlobalAgents(options.codexHome)) {
      failures.push(`global guidance differs: ${agentsPath}`);
    }
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const configPath = join(options.codexHome, "config.toml");
  try {
    regularFileModeOrDefault(configPath, "Codex config", 0o600);
    if (readText(configPath) !== expectedCodexConfig(options.codexHome)) {
      failures.push(`Codex config differs: ${configPath}`);
    }
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  const rulesPath = codexRulesPath(options.codexHome);
  try {
    regularFileModeOrDefault(rulesPath, "Codex rule file", 0o600);
    if (readText(rulesPath) !== expectedCodexRules(options.codexHome, options.bunBin)) {
      failures.push(`Codex host-access rule differs: ${rulesPath}`);
    }
    const migration = codexRulesMigration(options.codexHome);
    if (migration !== null) failures.push(`legacy Codex rule file present: ${migration.path}`);
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (claudeCapability.available) {
    const claudeSettingsPath = join(claudeHome, "settings.json");
    try {
      regularFileModeOrDefault(claudeSettingsPath, "Claude settings", 0o600);
      if (readText(claudeSettingsPath) !== expectedClaudeSettings(claudeHome)) {
        failures.push(`Claude settings differ: ${claudeSettingsPath}`);
      }
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  const claudeGuidancePath = join(claudeHome, "CLAUDE.md");
  try {
    regularFileModeOrDefault(claudeGuidancePath, "Claude guidance");
    if (readText(claudeGuidancePath) !== expectedGlobalClaude(claudeHome)) {
      failures.push(`Claude guidance differs: ${claudeGuidancePath}`);
    }
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  for (const profile of profileNames) {
    const path = profilePath(options.codexHome, profile);
    try {
      if (readText(path) !== normalizeTrailingNewline(asset(profile))) {
        failures.push(`profile differs: ${path}`);
      }
      const migration = profileMigration(options.codexHome, profile);
      if (migration !== null) failures.push(`legacy profile present: ${migration.path}`);
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [link, target] of commandTargets(options.bunBin)) {
    if (!symlinkMatches(target, link)) failures.push(`command link differs: ${link}`);
  }
  try {
    if (legacyCommandsPresent(options.bunBin)) {
      for (const [link, target] of legacyCommandTargets(options.bunBin)) {
        if (!symlinkMatches(target, link)) failures.push(`legacy command link differs: ${link}`);
      }
    }
  } catch (error: unknown) {
    failures.push(error instanceof Error ? error.message : String(error));
  }
  if (!dependencyAvailable(options.runtimeRoot, environment)) {
    failures.push(`missing private dependency: ${slopcameraRuntimeDescription}`);
  }
  return failures;
}

async function applyInstallation(options: BootstrapOptions): Promise<void> {
  const claudeHome = options.claudeHome ?? resolvedClaudeHome();
  const claudeCapability = claudeAutoModeCapability();
  const agentsPath = join(options.codexHome, "AGENTS.md");
  const agentsMode = regularFileModeOrDefault(agentsPath);
  const configPath = join(options.codexHome, "config.toml");
  const configMode = regularFileModeOrDefault(configPath, "Codex config", 0o600);
  const rulesPath = codexRulesPath(options.codexHome);
  const rulesMigration = codexRulesMigration(options.codexHome);
  const rulesMode = rulesMigration === null
    ? regularFileModeOrDefault(rulesPath, "Codex rule file", 0o600)
    : rulesMigration.mode;
  const claudeSettingsPath = join(claudeHome, "settings.json");
  const claudeSettingsMode = claudeCapability.available
    ? regularFileModeOrDefault(claudeSettingsPath, "Claude settings", 0o600)
    : null;
  const claudeGuidancePath = join(claudeHome, "CLAUDE.md");
  const claudeGuidanceMode = regularFileModeOrDefault(
    claudeGuidancePath,
    "Claude guidance",
  );
  const agentsValue = expectedGlobalAgents(options.codexHome);
  const configValue = expectedCodexConfig(options.codexHome);
  const rulesValue = expectedCodexRules(options.codexHome, options.bunBin);
  const claudeSettingsValue = claudeCapability.available
    ? expectedClaudeSettings(claudeHome)
    : null;
  const claudeGuidanceValue = expectedGlobalClaude(claudeHome);
  const profilePlans = profileNames.map((profile) => {
    const path = profilePath(options.codexHome, profile);
    const value = normalizeTrailingNewline(asset(profile));
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      if (readText(path) !== value) {
        throw new Error(`refusing to replace differing profile symlink: ${path}`);
      }
      return { legacy: null, mode: 0, path, symlink: true, value } as const;
    }
    const legacy = profileMigration(options.codexHome, profile);
    return {
      legacy,
      mode: legacy === null ? regularFileModeOrDefault(path, "Codex profile") : legacy.mode,
      path,
      symlink: false,
      value,
    } as const;
  });
  const commandPlans = [
    ...commandTargets(options.bunBin),
    ...legacyCommandTargets(options.bunBin),
  ];
  for (const [link, target] of commandPlans) {
    if (!existsSync(target)) throw new Error(`plugin script is missing: ${target}`);
    preflightManagedCommandSymlink(target, link, options.codexHome);
  }
  if (!dependencyAvailable(options.runtimeRoot) && !options.installDependency) {
    throw new Error(`missing ${slopcameraRuntimeDescription}; dependency installation was disabled`);
  }

  mkdirSync(options.codexHome, { recursive: true, mode: 0o700 });
  mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
  mkdirSync(options.bunBin, { recursive: true, mode: 0o700 });
  writeAtomic(agentsPath, agentsValue, agentsMode);
  writeAtomic(configPath, configValue, configMode);
  writeAtomic(rulesPath, rulesValue, rulesMode);
  if (rulesMigration !== null) removeMigratedLegacyFile(rulesMigration);
  if (claudeSettingsValue !== null && claudeSettingsMode !== null) {
    writeAtomic(claudeSettingsPath, claudeSettingsValue, claudeSettingsMode);
  }
  writeAtomic(claudeGuidancePath, claudeGuidanceValue, claudeGuidanceMode);
  for (const profile of profilePlans) {
    if (profile.symlink) continue;
    writeAtomic(profile.path, profile.value, profile.mode);
    if (profile.legacy !== null) removeMigratedLegacyFile(profile.legacy);
  }
  for (const [link, target] of commandPlans) {
    chmodSync(target, 0o755);
    const result = ensureManagedCommandSymlink(target, link, options.codexHome);
    console.log(`${result.toUpperCase()}\t${link}\t${target}`);
  }
  if (!dependencyAvailable(options.runtimeRoot)) {
    await installSlopcameraRuntime(options.runtimeRoot);
  }
  const failures = checkInstallation(options);
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

if (import.meta.main) {
  try {
    const options = parseBootstrapArguments(process.argv.slice(2));
    if (options.mode === "apply") await applyInstallation(options);
    const failures = checkInstallation(options);
    if (failures.length > 0) {
      for (const failure of failures) console.error(`FAIL\t${failure}`);
      process.exitCode = 1;
    } else {
      const agents = join(options.codexHome, "AGENTS.md");
      const metadata = lstatSync(agents);
      const claudeCapability = claudeAutoModeCapability();
      if (!claudeCapability.available) {
        console.log(
          `SKIP\tClaude Auto mode unavailable (${claudeCapability.reason}); ordinary permission mode unchanged`,
        );
      }
      console.log(
        `PASS\tOompa local efficiency baseline\t${agents}\t${join(options.claudeHome ?? resolvedClaudeHome(), "CLAUDE.md")}\tmode=${metadata.mode & 0o777}`,
      );
    }
  } catch (error) {
    console.error(`[oompa-local-efficiency] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
