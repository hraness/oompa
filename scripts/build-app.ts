import assert from "node:assert/strict";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { COPYFILE_EXCL, O_NOFOLLOW, O_RDONLY } from "node:constants";
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import {
  copyFile, lstat, mkdir, mkdtemp, open, opendir, realpath, rename, writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getDesignPaletteTheme } from "@hraness/design-kit";

import { dlopen } from "bun:ffi";

import { assertSafeDarwinInstallAcl } from "../src/install-normalizer";
import { stageOompaAppearance, type OompaAppearanceAsset } from "./build-appearance.ts";
import {
  APP_SOURCE_MARKER_PATH,
  createAppSourceMarker,
  parseAppSourceMarker,
  type AppSourceMarker,
} from "./app-source-marker.ts";

export type AppArtifact = Readonly<{ bytes: number; path: string; sha256: string }>;
export type AppGraph = Readonly<{
  appearance: string;
  artifacts: readonly AppArtifact[];
  entry: string;
  foundation: string;
}>;
export type AppBuildProfile = "development" | "production";
export type AppSourceEnvironmentSnapshot = Readonly<{
  OOMPA_RELEASE_COMMIT: string | null;
  VERCEL: string | null;
  VERCEL_GIT_COMMIT_SHA: string | null;
}>;
export type AppSourceMarkerEvidence = Readonly<{
  environment: AppSourceEnvironmentSnapshot;
  marker: AppSourceMarker;
  markerArtifact: AppArtifact;
  packageArtifact: AppArtifact;
}>;
export type StagedAppBuild = Readonly<{
  authored: Buffer;
  completeBytes: Buffer;
  completeDirectory: string;
  completeInventory: readonly AppArtifact[];
  pendingMarkerPath: string;
  projected: readonly AppArtifact[];
  publishDirectory: string;
  sourceMarker: AppSourceMarkerEvidence;
}>;

const MAX_FILES = 4096;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const COMPLETE = "stylex-complete.json";
const STYLEX_UNION_POLICY_SHA256 = "1ceced1f1bf6359413ca6425ede61e1fdae272b897f4455c2347e2431d75caa1";
const PUBLICATION_JOURNAL = "pending-publication.json";
const ENTRY_TAG = '<script type="module" src="/src/main.tsx"></script>';
const HTML_TAG = '<html lang="en" data-hraness-theme="paper" data-palette="paper" data-theme="light">';
// This one authored image is already held by the shell under img-src data:.
// Its exact SVG bytes are reviewed independently of the website runtime.
const APP_FAVICON_SHA256 = "8b3323b41b8c95bfa39af9af23152105b87b205959834ff096aa7c5b6f83b98d";
export const APP_CSS_PLACEHOLDER = "__HRANESS_STYLEX_CSS__";

export type AppPublicationFailureBoundary =
  | "journal"
  | "marker"
  | "previous"
  | "public";

type AppPublicationEvidence = Readonly<{
  artifacts: readonly AppArtifact[];
  markerSha256: string;
  sourceMarker: AppSourceMarkerEvidence;
}>;

type AppPublicationTransaction = Readonly<{
  kind: "hra-app-publication-transaction";
  next: AppPublicationEvidence;
  previous: AppPublicationEvidence | null;
  run: string;
  schemaVersion: 2;
}>;

export function appSha256(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), "Expected an object");
  assert.ok(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), "Unexpected record fields");
}

function hash(value: unknown): string {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), "Invalid SHA-256");
  return value;
}

function safePath(value: unknown): string {
  assert.ok(typeof value === "string" && value.length <= 240, "Invalid output path");
  assert.ok(/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/u.test(value), "Unsafe output path");
  assert.ok(value.split("/").length <= 8 && value.split("/").every((part) => part !== "." && part !== ".."));
  return value;
}

function artifactWithPath(value: unknown, pathParser: (path: unknown) => string): AppArtifact {
  const item = record(value);
  keys(item, ["bytes", "path", "sha256"]);
  assert.ok(typeof item.bytes === "number" && Number.isSafeInteger(item.bytes) && item.bytes > 0 && item.bytes <= MAX_FILE_BYTES);
  return { bytes: item.bytes, path: pathParser(item.path), sha256: hash(item.sha256) };
}

function artifact(value: unknown): AppArtifact {
  return artifactWithPath(value, safePath);
}

function publicationArtifact(value: unknown): AppArtifact {
  return artifactWithPath(value, (path) => path === APP_SOURCE_MARKER_PATH ? path : safePath(path));
}

function artifactInventory(
  value: unknown,
  parser: (item: unknown) => AppArtifact,
): readonly AppArtifact[] {
  assert.ok(Array.isArray(value) && value.length > 0 && value.length <= MAX_FILES);
  const parsed = value.map(parser);
  const paths = parsed.map((item) => item.path);
  assert.deepEqual(paths, [...paths].sort(), "Output inventory must be sorted");
  assert.equal(new Set(paths).size, paths.length, "Duplicate output path");
  assert.ok(parsed.reduce((total, item) => total + item.bytes, 0) <= MAX_TOTAL_BYTES);
  return parsed;
}

function artifacts(value: unknown): readonly AppArtifact[] {
  return artifactInventory(value, artifact);
}

function publicationArtifacts(value: unknown): readonly AppArtifact[] {
  return artifactInventory(value, publicationArtifact);
}

function compilerPublicPath(path: string): boolean {
  return path === "index.html" || path === "stylex.css"
    || /^graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css)$/u.test(path);
}

function publicationPath(path: string): boolean {
  return compilerPublicPath(path) || path === APP_SOURCE_MARKER_PATH;
}

/** Copy values, not mutable bundler records, and bind the entry to its facade. */
export function snapshotAppGraph(value: unknown, absoluteEntry: string, appearance: Pick<OompaAppearanceAsset, "source">): AppGraph {
  const result = record(value);
  assert.ok(Array.isArray(result.output) && result.output.length > 0 && result.output.length < MAX_FILES);
  const entries: string[] = [];
  const foundations: string[] = [];
  const bootstraps: string[] = [];
  const output = result.output.map((raw): AppArtifact => {
    const item = record(raw);
    const path = safePath(item.fileName);
    assert.ok(compilerPublicPath(`graphs/client/${path}`), "Unexpected client output kind or directory");
    let bytes: string | Uint8Array;
    if (item.type === "chunk") {
      assert.ok(path.endsWith(".js") && typeof item.code === "string");
      assert.ok(item.map === null || item.map === undefined, "App output maps must stay disabled");
      assert.ok(typeof item.isEntry === "boolean");
      if (item.isEntry) {
        assert.equal(item.facadeModuleId, absoluteEntry, "Unregistered app entry");
        entries.push(path);
      }
      bytes = item.code;
    } else {
      assert.equal(item.type, "asset");
      assert.ok(typeof item.source === "string" || item.source instanceof Uint8Array);
      bytes = item.source;
      if (path.endsWith(".css")) foundations.push(path);
      else {
        assert.ok(/^assets\/appearance-[A-Za-z0-9_-]+\.js$/u.test(path), "Unregistered app static asset");
        assert.deepEqual(Buffer.from(bytes), Buffer.from(appearance.source), "Appearance asset differs from its bound compiler output");
        bootstraps.push(path);
      }
    }
    return { bytes: Buffer.byteLength(bytes), path, sha256: appSha256(bytes) };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  assert.equal(entries.length, 1, "The app must have exactly one module entry");
  assert.equal(foundations.length, 1, "The app must have one complete foundation stylesheet");
  assert.equal(bootstraps.length, 1, "The app must have one bound classic appearance bootstrap");
  const checked = artifacts(output);
  const entry = entries[0];
  const foundation = foundations[0];
  const bootstrap = bootstraps[0];
  assert.ok(entry !== undefined && foundation !== undefined && bootstrap !== undefined);
  return { appearance: bootstrap, artifacts: checked, entry, foundation };
}

/** Preserve every authored shell byte except its exact module tag/head join. */
export function prepareAppShell(
  source: string,
  graph: AppGraph,
  mount: "/" | "./" = "/",
): string {
  assert.equal(source.split(ENTRY_TAG).length - 1, 1, "Authored app entry changed");
  assert.equal(source.split(HTML_TAG).length - 1, 1, "Authored app theme boundary changed");
  assert.equal((source.match(/<script\b/giu) ?? []).length, 1);
  assert.equal(source.split("</head>").length - 1, 1);
  assert.ok(!/<!--|<\?|<!\[CDATA\[|<(?:template|noscript|svg|math)\b/iu.test(source), "The app shell must retain its active native HTML boundary");
  const icons = [...source.matchAll(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml;base64,([A-Za-z0-9+/=]{1,512})">/gu)];
  assert.equal(icons.length, 1, "The app must have exactly one canonical favicon");
  const icon = icons[0];
  assert.ok(icon !== undefined && icon[1] !== undefined);
  const iconBytes = Buffer.from(icon[1], "base64");
  assert.equal(iconBytes.toString("base64"), icon[1], "Favicon encoding must be canonical");
  assert.equal(appSha256(iconBytes), APP_FAVICON_SHA256, "Unreviewed app favicon bytes");
  assert.equal(source.split("<head>").length - 1, 1);
  const head = source.indexOf("<head>");
  assert.equal(source.slice(0, head).trimEnd(), `<!doctype html>\n${HTML_TAG}`, "Unexpected authored shell head boundary");
  assert.ok(source.slice(head + "<head>".length).trimStart().startsWith(icon[0]), "Favicon must start the active app head");
  assert.ok(!/<(?:style|link|base)\b|\bstyle\s*=/iu.test(source.replace(icon[0], "")), "Unexpected authored shell stylesheet or inline style");
  assert.ok(!source.includes(APP_CSS_PLACEHOLDER));
  assert.ok(compilerPublicPath(`graphs/client/${graph.entry}`) && graph.entry.endsWith(".js"));
  assert.ok(compilerPublicPath(`graphs/client/${graph.foundation}`) && graph.foundation.endsWith(".css"));
  assert.ok(/^assets\/appearance-[A-Za-z0-9_-]+\.js$/u.test(graph.appearance));
  const paletteClass = getDesignPaletteTheme("paper", "light").className;
  assert.ok(/^[A-Za-z0-9_-]+(?: [A-Za-z0-9_-]+)*$/u.test(paletteClass), "Unsafe default palette class");
  return source.replace(HTML_TAG, HTML_TAG.replace(">", ` class="${paletteClass}">`))
    .replace(ENTRY_TAG, `<script type="module" src="${mount}graphs/client/${graph.entry}"></script>`)
    .replace("</head>", `<link rel="stylesheet" href="${mount}graphs/client/${graph.foundation}">\n    <link rel="stylesheet" href="${APP_CSS_PLACEHOLDER}">\n    <script src="${mount}graphs/client/${graph.appearance}"></script>\n  </head>`);
}

/** Only public artifact records survive this boundary, never graph inputs. */
export function parseAppComplete(value: unknown): readonly AppArtifact[] {
  const complete = record(value);
  keys(complete, ["artifacts", "compilerSha256", "finalCss", "generationId", "graphs", "kind", "packages", "planSha256", "schemaVersion", "state", "unionPolicySha256"]);
  assert.equal(complete.kind, "hraness-stylex-complete-generation");
  assert.equal(complete.schemaVersion, 2);
  assert.equal(complete.unionPolicySha256, STYLEX_UNION_POLICY_SHA256);
  assert.equal(complete.state, "complete");
  assert.equal(complete.generationId, "oompa-app");
  hash(complete.compilerSha256);
  hash(complete.planSha256);
  assert.ok(Array.isArray(complete.graphs) && complete.graphs.length === 1);
  const graph = record(complete.graphs[0]);
  keys(graph, ["id", "receiptSha256"]);
  assert.equal(graph.id, "client");
  hash(graph.receiptSha256);
  assert.ok(Array.isArray(complete.packages) && complete.packages.length === 2);
  for (const [index, name] of ["@hraness/design-kit", "@hraness/ui"].entries()) {
    const dependency = record(complete.packages[index]);
    keys(dependency, ["manifestSha256", "name", "version"]);
    assert.equal(dependency.name, name);
    assert.ok(typeof dependency.version === "string" && /^\d+\.\d+\.\d+$/u.test(dependency.version));
    hash(dependency.manifestSha256);
  }
  const css = artifact(complete.finalCss);
  assert.equal(css.path, "stylex.css");
  const output = artifacts([...artifacts(complete.artifacts), css].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.ok(output.every(({ path }) => compilerPublicPath(path)), "Non-public output in app generation");
  assert.equal(output.filter(({ path }) => path === "index.html").length, 1);
  assert.equal(output.filter(({ path }) => path.endsWith(".css")).length, 2);
  assert.equal(output.filter(({ path }) => /^graphs\/client\/assets\/appearance-[A-Za-z0-9_-]+\.js$/u.test(path)).length, 1);
  assert.ok(output.some(({ path }) => path.endsWith(".js")));
  return output;
}

function environmentValue(value: unknown, name: string): string | null {
  assert.ok(value === null || typeof value === "string", `Invalid app source environment value: ${name}`);
  if (typeof value === "string") {
    assert.ok(value.length <= 256 && value.split("").every((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    }), `Unsafe app source environment value: ${name}`);
  }
  return value;
}

export function snapshotAppSourceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): AppSourceEnvironmentSnapshot {
  return parseAppSourceEnvironment({
    OOMPA_RELEASE_COMMIT: environment.OOMPA_RELEASE_COMMIT ?? null,
    VERCEL: environment.VERCEL ?? null,
    VERCEL_GIT_COMMIT_SHA: environment.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}

function parseAppSourceEnvironment(value: unknown): AppSourceEnvironmentSnapshot {
  const environment = record(value);
  keys(environment, ["OOMPA_RELEASE_COMMIT", "VERCEL", "VERCEL_GIT_COMMIT_SHA"]);
  return Object.freeze({
    OOMPA_RELEASE_COMMIT: environmentValue(environment.OOMPA_RELEASE_COMMIT, "OOMPA_RELEASE_COMMIT"),
    VERCEL: environmentValue(environment.VERCEL, "VERCEL"),
    VERCEL_GIT_COMMIT_SHA: environmentValue(environment.VERCEL_GIT_COMMIT_SHA, "VERCEL_GIT_COMMIT_SHA"),
  });
}

function markerEnvironment(
  environment: AppSourceEnvironmentSnapshot,
): Readonly<Record<string, string | undefined>> {
  return {
    ...(environment.OOMPA_RELEASE_COMMIT === null ? {} : { OOMPA_RELEASE_COMMIT: environment.OOMPA_RELEASE_COMMIT }),
    ...(environment.VERCEL === null ? {} : { VERCEL: environment.VERCEL }),
    ...(environment.VERCEL_GIT_COMMIT_SHA === null ? {} : { VERCEL_GIT_COMMIT_SHA: environment.VERCEL_GIT_COMMIT_SHA }),
  };
}

function packageManifest(packageBytes: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(packageBytes);
  assert.equal(Buffer.from(text).byteLength, packageBytes.byteLength, "The root package manifest must be canonical UTF-8 bytes");
  const manifest = record(JSON.parse(text) as unknown);
  assert.equal(manifest.name, "@hraness/oompa", "The app source marker requires the Oompa root package");
  return manifest;
}

function appSourceMarkerBytes(marker: AppSourceMarker): Buffer {
  return Buffer.from(`${JSON.stringify(marker, null, 2)}\n`);
}

/** Bind the exact public marker to ordinary root-package bytes and a closed environment snapshot. */
export function createAppSourceMarkerEvidence(
  packageBytes: Uint8Array,
  environmentValue: Readonly<Record<string, string | undefined>> | AppSourceEnvironmentSnapshot,
): AppSourceMarkerEvidence {
  assert.ok(packageBytes.byteLength > 0 && packageBytes.byteLength <= MAX_FILE_BYTES, "The root package manifest exceeds its size bound");
  const manifest = packageManifest(packageBytes);
  const environment = parseAppSourceEnvironment({
    OOMPA_RELEASE_COMMIT: environmentValue.OOMPA_RELEASE_COMMIT ?? null,
    VERCEL: environmentValue.VERCEL ?? null,
    VERCEL_GIT_COMMIT_SHA: environmentValue.VERCEL_GIT_COMMIT_SHA ?? null,
  });
  const markerBytes = Buffer.from(createAppSourceMarker(manifest, markerEnvironment(environment)));
  const marker = parseAppSourceMarker(JSON.parse(markerBytes.toString("utf8")) as unknown);
  assert.deepEqual(markerBytes, appSourceMarkerBytes(marker), "The app source marker serialization changed");
  return Object.freeze({
    environment,
    marker,
    markerArtifact: {
      bytes: markerBytes.byteLength,
      path: APP_SOURCE_MARKER_PATH,
      sha256: appSha256(markerBytes),
    },
    packageArtifact: {
      bytes: packageBytes.byteLength,
      path: "package.json",
      sha256: appSha256(packageBytes),
    },
  });
}

export function parseAppSourceMarkerEvidence(value: unknown): AppSourceMarkerEvidence {
  const sourceMarker = record(value);
  keys(sourceMarker, ["environment", "marker", "markerArtifact", "packageArtifact"]);
  const environment = parseAppSourceEnvironment(sourceMarker.environment);
  const marker = parseAppSourceMarker(sourceMarker.marker);
  const markerArtifact = publicationArtifact(sourceMarker.markerArtifact);
  const packageArtifact = artifact(sourceMarker.packageArtifact);
  assert.equal(markerArtifact.path, APP_SOURCE_MARKER_PATH);
  assert.equal(packageArtifact.path, "package.json");
  const expectedMarker = Buffer.from(createAppSourceMarker({ version: marker.version }, markerEnvironment(environment)));
  assert.deepEqual(parseAppSourceMarker(JSON.parse(expectedMarker.toString("utf8")) as unknown), marker);
  assert.deepEqual(
    { bytes: expectedMarker.byteLength, sha256: appSha256(expectedMarker) },
    { bytes: markerArtifact.bytes, sha256: markerArtifact.sha256 },
    "App source marker artifact disagrees with its typed evidence",
  );
  return Object.freeze({ environment, marker, markerArtifact, packageArtifact });
}

type ParsedAppPublication = Readonly<{
  artifacts: readonly AppArtifact[];
  sourceMarker: AppSourceMarkerEvidence;
}>;

function parseAppPublicationRecord(value: unknown): ParsedAppPublication {
  const publication = record(value);
  keys(publication, ["artifacts", "completeSha256", "kind", "schemaVersion", "shellSha256", "sourceMarker"]);
  assert.equal(publication.kind, "hra-app-publication");
  assert.equal(publication.schemaVersion, 2);
  hash(publication.completeSha256);
  hash(publication.shellSha256);
  const output = publicationArtifacts(publication.artifacts);
  assert.ok(output.every(({ path }) => publicationPath(path)));
  assert.equal(output.filter(({ path }) => path === "index.html").length, 1);
  assert.equal(output.filter(({ path }) => path === "stylex.css").length, 1);
  assert.equal(output.filter(({ path }) => path.endsWith(".css")).length, 2);
  assert.ok(output.some(({ path }) => path.endsWith(".js")));
  const sourceMarker = parseAppSourceMarkerEvidence(publication.sourceMarker);
  assert.deepEqual(
    output.filter(({ path }) => path === APP_SOURCE_MARKER_PATH),
    [sourceMarker.markerArtifact],
    "The app publication must contain exactly its typed source marker",
  );
  return { artifacts: output, sourceMarker };
}

export function appPublicationRecord(
  output: readonly AppArtifact[],
  shellSha256: string,
  completeSha256: string,
  sourceMarkerValue: AppSourceMarkerEvidence,
): string {
  const sourceMarker = parseAppSourceMarkerEvidence(sourceMarkerValue);
  const parsed = publicationArtifacts(output);
  assert.ok(parsed.every(({ path }) => publicationPath(path)));
  assert.deepEqual(parsed.filter(({ path }) => path === APP_SOURCE_MARKER_PATH), [sourceMarker.markerArtifact]);
  return `${JSON.stringify({
    artifacts: parsed,
    completeSha256: hash(completeSha256),
    kind: "hra-app-publication",
    schemaVersion: 2,
    shellSha256: hash(shellSha256),
    sourceMarker,
  })}\n`;
}

export function parseAppPublication(value: unknown): readonly AppArtifact[] {
  return parseAppPublicationRecord(value).artifacts;
}

function ordinary(stat: Stats, directory: boolean): void {
  assert.ok(directory ? stat.isDirectory() : stat.isFile(), "Build boundary must be ordinary");
  assert.ok(!stat.isSymbolicLink() && (stat.mode & 0o7022) === 0, "Unsafe build boundary mode");
  assert.equal(stat.uid, process.getuid?.(), "Build boundary must belong to the current user");
  if (!directory) {
    assert.equal(stat.nlink, 1, "Hardlinked build files are unsupported");
    assert.equal(stat.mode & 0o111, 0, "Executable build files are unsupported");
  }
}

async function directory(path: string): Promise<void> {
  ordinary(await lstat(path), true);
  assert.equal(await realpath(path), path, "Symlinked build ancestry is unsupported");
}

async function makeDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  await directory(path);
}

async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw error;
  }
}

async function readOrdinary(path: string): Promise<Buffer> {
  const before = await lstat(path);
  ordinary(before, false);
  assert.ok(before.size > 0 && before.size <= MAX_FILE_BYTES, "Build file exceeds its size bound");
  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    ordinary(opened, false);
    assert.deepEqual([opened.dev, opened.ino, opened.size, opened.mtimeMs, opened.ctimeMs], [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs]);
    const bytes = await handle.readFile();
    const after = await lstat(path);
    ordinary(after, false);
    assert.deepEqual([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs], [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs], "Build file changed while reading");
    assert.equal(bytes.byteLength, before.size);
    return bytes;
  } finally { await handle.close(); }
}

async function readPrivateOrdinary(path: string): Promise<Buffer> {
  const bytes = await readOrdinary(path);
  const metadata = await lstat(path);
  ordinary(metadata, false);
  assert.equal(metadata.mode & 0o777, 0o600, "Private publication evidence must stay mode 0600");
  return bytes;
}

/** Read one publication artifact through an identity-bound ordinary file descriptor. */
export async function readAppOrdinary(path: string): Promise<Buffer> {
  return readOrdinary(path);
}

/** Bounded ordinary-file census, shared by publication and real-output tests. */
export async function readAppInventory(root: string, allowComplete = false): Promise<readonly AppArtifact[]> {
  const output: AppArtifact[] = [];
  let directories = 0;
  let totalBytes = 0;
  async function walk(path: string, prefix: string, depth: number): Promise<void> {
    assert.ok(++directories <= 128 && depth <= 8, "Build directory census exceeded bounds");
    await directory(path);
    const entries = await opendir(path);
    for await (const entry of entries) {
      const candidate = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const logical = candidate === ".well-known" || candidate === APP_SOURCE_MARKER_PATH
        ? candidate
        : safePath(candidate);
      const child = join(path, entry.name);
      const info = await lstat(child);
      if (info.isDirectory()) {
        const allowedDirectories = allowComplete
          ? ["graphs", "graphs/client", "graphs/client/assets"]
          : [".well-known", "graphs", "graphs/client", "graphs/client/assets"];
        assert.ok(allowedDirectories.includes(logical), "Unknown build output directory; preserve it for review");
        await walk(child, logical, depth + 1);
      }
      else {
        assert.ok(output.length < MAX_FILES, "Build inventory exceeded file bound");
        assert.ok(
          allowComplete
            ? compilerPublicPath(logical) || logical === COMPLETE
            : publicationPath(logical),
          "Unknown build output; preserve it for review",
        );
        const bytes = await readOrdinary(child);
        totalBytes += bytes.byteLength;
        assert.ok(totalBytes <= MAX_TOTAL_BYTES, "Build inventory exceeded byte bound");
        output.push({ bytes: bytes.byteLength, path: logical, sha256: appSha256(bytes) });
      }
    }
  }
  await walk(root, "", 0);
  return output.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

async function assertPublishedSourceMarker(
  publicDirectory: string,
  evidenceValue: AppSourceMarkerEvidence,
): Promise<AppSourceMarkerEvidence> {
  const evidence = parseAppSourceMarkerEvidence(evidenceValue);
  const markerBytes = await readOrdinary(join(publicDirectory, APP_SOURCE_MARKER_PATH));
  assert.deepEqual(
    { bytes: markerBytes.byteLength, path: APP_SOURCE_MARKER_PATH, sha256: appSha256(markerBytes) },
    evidence.markerArtifact,
    "The public app source marker changed",
  );
  assert.deepEqual(
    parseAppSourceMarker(JSON.parse(markerBytes.toString("utf8")) as unknown),
    evidence.marker,
    "The public app source marker contract changed",
  );
  return evidence;
}

/** Re-read the root package and closed source environment at a compiler/publication join. */
export async function revalidateAppSourceMarkerInputs(
  rootDirectory: string,
  evidenceValue: AppSourceMarkerEvidence,
  environmentValue: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const root = resolve(rootDirectory);
  await directory(root);
  const packageBytes = await readOrdinary(join(root, "package.json"));
  const current = createAppSourceMarkerEvidence(packageBytes, environmentValue);
  const expected = parseAppSourceMarkerEvidence(evidenceValue);
  assert.deepEqual(current, expected, "The app source-marker inputs changed before publication");
}

/** Re-read the root inputs and exact public marker before publication. */
export async function revalidateAppSourceMarker(
  rootDirectory: string,
  publicDirectory: string,
  evidenceValue: AppSourceMarkerEvidence,
  environmentValue: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const expected = parseAppSourceMarkerEvidence(evidenceValue);
  await revalidateAppSourceMarkerInputs(rootDirectory, expected, environmentValue);
  await assertPublishedSourceMarker(publicDirectory, expected);
}

type FlockLibrary = Readonly<{
  close: () => void;
  symbols: Readonly<{ flock: (descriptor: number, operation: number) => number }>;
}>;

export type AppPublicationLock = Readonly<{
  assertHeld: () => void;
  release: () => void;
}>;

export const APP_PROCESS_CUSTODY_FILE = "process-custody.json";

/** A durable fence remains authoritative after its kernel-lock owner exits. */
export class AppProcessCustodyError extends Error {}

export type AppProcessCustody = Readonly<{
  assertHeld: () => void;
  clearAfterCollection: () => void;
}>;

type AppProcessCustodyOwner = Readonly<{
  controlDirectory: string;
  lock: AppPublicationLock;
}>;

function assertNoAppProcessCustody(controlDirectory: string): void {
  try { lstatSync(join(controlDirectory, APP_PROCESS_CUSTODY_FILE)); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new AppProcessCustodyError("App process custody cannot be inspected; preserve it for recovery", { cause: error });
  }
  throw new AppProcessCustodyError("App process custody is retained; collection must be proved before another publication");
}

/** Persist both publication fences before a development child can exist. */
export function beginAppProcessCustody(
  owners: readonly [AppProcessCustodyOwner, AppProcessCustodyOwner],
  run: string,
): AppProcessCustody {
  assert.ok(/^build-[A-Za-z0-9_-]{1,128}$/u.test(run), "Invalid app process custody run");
  assert.equal(owners[1].controlDirectory, join(owners[0].controlDirectory, "dev"), "App process custody must fence the build and its dev owner");
  const source = Buffer.from(`${JSON.stringify({
    kind: "oompa-app-process-custody", run, schemaVersion: 1, token: randomBytes(32).toString("hex"),
  })}\n`);
  assert.ok(source.byteLength <= 512);
  const entries: {
    descriptor: number;
    directoryDescriptor: number;
    directoryIdentity: Stats;
    identity: Stats;
    owner: AppProcessCustodyOwner;
    path: string;
  }[] = [];
  let descriptorsClosed = false;
  const closeDescriptors = (): void => {
    if (descriptorsClosed) return;
    descriptorsClosed = true;
    for (const entry of entries) { closeSync(entry.descriptor); closeSync(entry.directoryDescriptor); }
  };
  const assertDirectory = (descriptor: number, path: string, before: Stats): void => {
    const opened = fstatSync(descriptor);
    const named = lstatSync(path);
    assert.equal(realpathSync(path), path, "App custody directory ancestry changed");
    for (const metadata of [opened, named]) {
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
      assert.deepEqual(
        [metadata.dev, metadata.ino, metadata.uid, metadata.mode],
        [before.dev, before.ino, before.uid, before.mode],
        "App custody directory identity changed",
      );
    }
  };
  const assertEntry = (entry: typeof entries[number]): void => {
    entry.owner.lock.assertHeld();
    assertDirectory(entry.directoryDescriptor, entry.owner.controlDirectory, entry.directoryIdentity);
    const opened = fstatSync(entry.descriptor);
    const named = lstatSync(entry.path);
    for (const metadata of [opened, named]) {
      assert.ok(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1);
      assert.equal(metadata.uid, process.getuid?.());
      assert.equal(metadata.mode & 0o777, 0o600);
      assert.ok(sameIdentity(metadata, entry.identity)
        && metadata.mtimeMs === entry.identity.mtimeMs && metadata.ctimeMs === entry.identity.ctimeMs,
      "App process custody identity changed");
    }
    const actual = Buffer.alloc(source.byteLength);
    assert.equal(readSync(entry.descriptor, actual, 0, actual.byteLength, 0), actual.byteLength);
    assert.deepEqual(actual, source, "App process custody token or record changed");
    assertSafeDarwinInstallAcl(entry.descriptor, opened.uid, entry.path);
  };
  try {
    for (const owner of owners) owner.lock.assertHeld();
    for (const owner of owners) {
      owner.lock.assertHeld();
      assert.equal(realpathSync(owner.controlDirectory), owner.controlDirectory);
      const path = join(owner.controlDirectory, APP_PROCESS_CUSTODY_FILE);
      const directoryDescriptor = openSync(owner.controlDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
      let descriptor = -1;
      try {
        const directoryIdentity = fstatSync(directoryDescriptor);
        assert.ok(directoryIdentity.isDirectory());
        assert.equal(directoryIdentity.uid, process.getuid?.());
        assert.equal(directoryIdentity.mode & 0o022, 0);
        assertSafeDarwinInstallAcl(directoryDescriptor, directoryIdentity.uid, owner.controlDirectory);
        assertDirectory(directoryDescriptor, owner.controlDirectory, directoryIdentity);
        descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
        writeFileSync(descriptor, source);
        fsyncSync(descriptor);
        fsyncSync(directoryDescriptor);
        const identity = fstatSync(descriptor);
        entries.push({ descriptor, directoryDescriptor, directoryIdentity, identity, owner, path });
      } catch (error) {
        if (descriptor >= 0) closeSync(descriptor);
        closeSync(directoryDescriptor);
        throw error;
      }
    }
    for (const entry of entries) assertEntry(entry);
  } catch (error) {
    closeDescriptors();
    // Even an incomplete pre-spawn record is retained. Admission never guesses
    // whether a dead owner reached spawn after persisting its intent.
    throw new AppProcessCustodyError("App process custody preparation failed; preserve its records for recovery", { cause: error });
  }
  let cleared = false;
  const assertHeld = (): void => {
    try {
      assert.equal(cleared, false, "App process custody was already cleared");
      for (const entry of entries) assertEntry(entry);
    } catch (error) {
      closeDescriptors();
      throw new AppProcessCustodyError("App process custody revalidation failed; preserve its records for recovery", { cause: error });
    }
  };
  return {
    assertHeld,
    clearAfterCollection: () => {
      assertHeld();
      try {
        for (const entry of entries) {
          assertEntry(entry);
          unlinkSync(entry.path);
          fsyncSync(entry.directoryDescriptor);
        }
        cleared = true;
        closeDescriptors();
      } catch (error) {
        closeDescriptors();
        throw new AppProcessCustodyError("Collected app process custody could not be cleared; preserve remaining records for recovery", { cause: error });
      }
    },
  };
}

const flockExclusive = 2;
const flockNonblocking = 4;
const flockUnlock = 8;

function openFlockLibrary(): FlockLibrary {
  const linuxCandidates = process.arch === "x64"
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
    : process.arch === "arm64"
      ? [
          "/lib/aarch64-linux-gnu/libc.so.6",
          "/usr/lib/aarch64-linux-gnu/libc.so.6",
          "/lib64/libc.so.6",
          "/usr/lib64/libc.so.6",
          "/lib/libc.musl-aarch64.so.1",
          "/usr/lib/libc.musl-aarch64.so.1",
          "/lib/ld-musl-aarch64.so.1",
          "/usr/lib/ld-musl-aarch64.so.1",
        ]
      : [];
  const candidates = process.platform === "darwin"
    ? ["/usr/lib/libSystem.B.dylib"]
    : linuxCandidates;
  for (const candidate of candidates) {
    try {
      return dlopen(candidate, {
        flock: { args: ["i32", "i32"], returns: "i32" },
      });
    } catch {
      // Try the next platform-specific libc name.
    }
  }
  throw new Error("The app publication lock primitive is unavailable");
}

let appFlockLibrary: FlockLibrary | undefined;
function flock(descriptor: number, operation: number): number {
  appFlockLibrary ??= openFlockLibrary();
  return appFlockLibrary.symbols.flock(descriptor, operation);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size;
}

function assertLockIdentity(descriptor: number, path: string): void {
  const held = fstatSync(descriptor);
  const named = lstatSync(path);
  const uid = process.getuid?.();
  assert.ok(uid !== undefined, "App publication requires a current-user identity");
  assert.ok(held.isFile() && named.isFile() && !named.isSymbolicLink(), "App publication lock must be ordinary");
  assert.equal(held.uid, uid, "App publication lock must belong to the current user");
  assert.equal(held.nlink, 1, "App publication lock must not be hardlinked");
  assert.equal(held.mode & 0o777, 0o600, "App publication lock must be private");
  assert.equal(held.size, 0, "App publication lock must stay empty");
  assert.ok(sameIdentity(held, named), "App publication lock path changed");
  assertSafeDarwinInstallAcl(descriptor, uid, path);
}

/** Kernel locks serialize live owners; retained custody blocks owner-death recovery. */
export function acquireAppPublicationLock(controlDirectory: string): AppPublicationLock {
  const lockPath = join(controlDirectory, "publication.lock");
  let descriptor = -1;
  let directoryDescriptor = -1;
  let locked = false;
  try {
    directoryDescriptor = openSync(controlDirectory, constants.O_RDONLY | constants.O_NOFOLLOW);
    const uid = process.getuid?.();
    assert.ok(uid !== undefined, "App publication requires a current-user identity");
    assertSafeDarwinInstallAcl(directoryDescriptor, uid, controlDirectory);
    descriptor = openSync(
      lockPath,
      constants.O_CREAT | constants.O_NOFOLLOW | constants.O_RDWR,
      0o600,
    );
    assertLockIdentity(descriptor, lockPath);
    fsyncSync(descriptor);
    fsyncSync(directoryDescriptor);
    assert.equal(
      flock(descriptor, flockExclusive | flockNonblocking),
      0,
      "Another app publication owns the execution lock",
    );
    locked = true;
    assertLockIdentity(descriptor, lockPath);
    assertNoAppProcessCustody(controlDirectory);
    let released = false;
    return {
      assertHeld: () => {
        assert.equal(released, false, "App publication lock was already released");
        assertLockIdentity(descriptor, lockPath);
      },
      release: () => {
        if (released) return;
        released = true;
        let failure: unknown;
        try { assertLockIdentity(descriptor, lockPath); } catch (error) { failure = error; }
        if (flock(descriptor, flockUnlock) !== 0) failure ??= new Error("Could not release app publication lock");
        closeSync(descriptor);
        descriptor = -1;
        locked = false;
        if (failure !== undefined) throw failure instanceof Error
          ? failure : new Error("App publication lock identity check failed", { cause: failure });
      },
    };
  } catch (error) {
    if (locked && descriptor >= 0) flock(descriptor, flockUnlock);
    if (descriptor >= 0) closeSync(descriptor);
    throw error;
  } finally {
    if (directoryDescriptor >= 0) closeSync(directoryDescriptor);
  }
}

function publicationEvidence(value: unknown): AppPublicationEvidence {
  const item = record(value);
  keys(item, ["artifacts", "markerSha256", "sourceMarker"]);
  const markerSha256 = hash(item.markerSha256);
  const publication = parseAppPublicationRecord({
    artifacts: item.artifacts,
    completeSha256: "a".repeat(64),
    kind: "hra-app-publication",
    schemaVersion: 2,
    shellSha256: "b".repeat(64),
    sourceMarker: item.sourceMarker,
  });
  return { artifacts: publication.artifacts, markerSha256, sourceMarker: publication.sourceMarker };
}

function parsePublicationTransaction(value: unknown): AppPublicationTransaction {
  const item = record(value);
  keys(item, ["kind", "next", "previous", "run", "schemaVersion"]);
  assert.equal(item.kind, "hra-app-publication-transaction");
  assert.equal(item.schemaVersion, 2);
  assert.ok(typeof item.run === "string" && /^build-[A-Za-z0-9_-]+$/u.test(item.run), "Unsafe publication run name");
  const previous = item.previous === null ? null : publicationEvidence(item.previous);
  return {
    kind: "hra-app-publication-transaction",
    next: publicationEvidence(item.next),
    previous,
    run: item.run,
    schemaVersion: 2,
  };
}

function publicationTransactionRecord(transaction: AppPublicationTransaction): string {
  return `${JSON.stringify(transaction)}\n`;
}

async function syncOrdinary(path: string, directoryEntry: boolean): Promise<Stats> {
  const before = await lstat(path);
  ordinary(before, directoryEntry);
  if (directoryEntry) assert.equal(await realpath(path), path, "Symlinked publication ancestry is unsupported");
  const handle = await open(path, O_RDONLY | O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    ordinary(opened, directoryEntry);
    assert.ok(sameIdentity(before, opened), "Publication entry changed before sync");
    await handle.sync();
    const after = await lstat(path);
    ordinary(after, directoryEntry);
    assert.ok(sameIdentity(opened, after), "Publication entry changed during sync");
    return after;
  } finally {
    await handle.close();
  }
}

async function syncInventory(root: string, inventory: readonly AppArtifact[]): Promise<void> {
  const directories = new Set<string>([root]);
  for (const item of inventory) {
    const path = join(root, ...item.path.split("/"));
    const bytes = await readOrdinary(path);
    assert.deepEqual(
      { bytes: bytes.byteLength, sha256: appSha256(bytes) },
      { bytes: item.bytes, sha256: item.sha256 },
      `Publication artifact changed before sync: ${item.path}`,
    );
    await syncOrdinary(path, false);
    let parent = dirname(path);
    while (parent.startsWith(`${root}/`)) {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  for (const path of [...directories].sort((left, right) => right.length - left.length)) {
    await syncOrdinary(path, true);
  }
}

async function readExpectedMarker(path: string, expected: AppPublicationEvidence): Promise<Buffer> {
  const bytes = await readPrivateOrdinary(path);
  assert.equal(appSha256(bytes), expected.markerSha256, "Publication marker digest changed");
  const publication = parseAppPublicationRecord(JSON.parse(bytes.toString("utf8")) as unknown);
  assert.deepEqual(publication.artifacts, expected.artifacts, "Publication marker inventory changed");
  assert.deepEqual(publication.sourceMarker, expected.sourceMarker, "Publication source-marker evidence changed");
  return bytes;
}

async function requireInventory(path: string, expected: readonly AppArtifact[]): Promise<void> {
  assert.deepEqual(await readAppInventory(path), expected, `Publication inventory changed: ${path}`);
}

async function renameSealed(source: string, destination: string, directoryEntry: boolean): Promise<void> {
  const sourceIdentity = await syncOrdinary(source, directoryEntry);
  await rename(source, destination);
  const destinationIdentity = await lstat(destination);
  ordinary(destinationIdentity, directoryEntry);
  assert.ok(sameIdentity(sourceIdentity, destinationIdentity), "Publication rename changed entry identity");
}

function injectPublicationFailure(
  requested: AppPublicationFailureBoundary | undefined,
  boundary: AppPublicationFailureBoundary,
): void {
  if (requested === boundary) throw new Error(`Injected app publication failure after ${boundary}`);
}

async function settleAppPublication(
  appDirectory: string,
  controlDirectory: string,
  lock: AppPublicationLock,
  transaction: AppPublicationTransaction,
  journalBytes: Buffer,
  failAfter?: AppPublicationFailureBoundary,
): Promise<void> {
  const run = join(controlDirectory, transaction.run);
  const dist = join(appDirectory, "dist");
  const marker = join(controlDirectory, "current.json");
  const journal = join(controlDirectory, PUBLICATION_JOURNAL);
  const publish = join(run, "public");
  const pendingMarker = join(run, "publication.json");
  const previousDist = join(run, "previous-dist");
  const previousMarker = join(run, "previous-publication.json");
  const settledJournal = join(run, "transaction.json");
  lock.assertHeld();
  await directory(appDirectory);
  await directory(controlDirectory);
  await directory(run);
  assert.deepEqual(await readPrivateOrdinary(journal), journalBytes, "Publication transaction changed");
  assert.equal(await absent(settledJournal), true, "Publication transaction was already settled under its run");

  if (transaction.previous === null) {
    assert.equal(await absent(previousDist), true, "Fresh publication unexpectedly has prior output");
    assert.equal(await absent(previousMarker), true, "Fresh publication unexpectedly has prior marker evidence");
  } else {
    await readExpectedMarker(previousMarker, transaction.previous);
  }

  if (!await absent(publish)) {
    await requireInventory(publish, transaction.next.artifacts);
    await readExpectedMarker(pendingMarker, transaction.next);
    if (transaction.previous === null) {
      assert.equal(await absent(dist), true, "Fresh publication collided with existing output");
      assert.equal(await absent(marker), true, "Fresh publication collided with existing marker");
    } else if (!await absent(dist)) {
      assert.equal(await absent(previousDist), true, "Prior output exists at both recovery paths");
      await requireInventory(dist, transaction.previous.artifacts);
      await readExpectedMarker(marker, transaction.previous);
      lock.assertHeld();
      await renameSealed(dist, previousDist, true);
      await syncOrdinary(appDirectory, true);
      await syncOrdinary(run, true);
      injectPublicationFailure(failAfter, "previous");
    } else {
      await requireInventory(previousDist, transaction.previous.artifacts);
      await readExpectedMarker(marker, transaction.previous);
    }
    const publishIdentity = await syncOrdinary(publish, true);
    await requireInventory(publish, transaction.next.artifacts);
    lock.assertHeld();
    await rename(publish, dist);
    const distIdentity = await lstat(dist);
    ordinary(distIdentity, true);
    assert.ok(sameIdentity(publishIdentity, distIdentity), "Published directory identity changed during rename");
    await requireInventory(dist, transaction.next.artifacts);
    await syncOrdinary(appDirectory, true);
    await syncOrdinary(run, true);
    injectPublicationFailure(failAfter, "public");
  } else {
    await requireInventory(dist, transaction.next.artifacts);
    if (transaction.previous === null) assert.equal(await absent(previousDist), true);
    else await requireInventory(previousDist, transaction.previous.artifacts);
  }

  if (!await absent(pendingMarker)) {
    const pendingBytes = await readExpectedMarker(pendingMarker, transaction.next);
    if (transaction.previous === null) assert.equal(await absent(marker), true, "Fresh publication acquired an unexpected marker");
    else await readExpectedMarker(marker, transaction.previous);
    const markerIdentity = await syncOrdinary(pendingMarker, false);
    assert.deepEqual(await readPrivateOrdinary(pendingMarker), pendingBytes);
    lock.assertHeld();
    await rename(pendingMarker, marker);
    const currentIdentity = await lstat(marker);
    ordinary(currentIdentity, false);
    assert.ok(sameIdentity(markerIdentity, currentIdentity), "Publication marker identity changed during rename");
    await readExpectedMarker(marker, transaction.next);
    await syncOrdinary(controlDirectory, true);
    await syncOrdinary(run, true);
    injectPublicationFailure(failAfter, "marker");
  } else {
    await readExpectedMarker(marker, transaction.next);
  }

  await requireInventory(dist, transaction.next.artifacts);
  await readExpectedMarker(marker, transaction.next);
  assert.equal(await absent(publish), true);
  assert.equal(await absent(pendingMarker), true);
  if (transaction.previous !== null) await requireInventory(previousDist, transaction.previous.artifacts);
  const journalIdentity = await syncOrdinary(journal, false);
  assert.deepEqual(await readPrivateOrdinary(journal), journalBytes);
  lock.assertHeld();
  await rename(journal, settledJournal);
  const settledIdentity = await lstat(settledJournal);
  ordinary(settledIdentity, false);
  assert.ok(sameIdentity(journalIdentity, settledIdentity), "Settled transaction identity changed during rename");
  await syncOrdinary(controlDirectory, true);
  await syncOrdinary(run, true);
  await requireInventory(dist, transaction.next.artifacts);
  await readExpectedMarker(marker, transaction.next);
}

/** Resume only an exact, immutable transaction left between publication renames. */
export async function reconcileAppPublication(
  appDirectory: string,
  controlDirectory: string,
  lock: AppPublicationLock,
): Promise<void> {
  lock.assertHeld();
  const journal = join(controlDirectory, PUBLICATION_JOURNAL);
  if (await absent(journal)) return;
  const bytes = await readPrivateOrdinary(journal);
  const transaction = parsePublicationTransaction(JSON.parse(bytes.toString("utf8")) as unknown);
  await settleAppPublication(appDirectory, controlDirectory, lock, transaction, bytes);
}

export async function commitAppPublication(options: Readonly<{
  appDirectory: string;
  controlDirectory: string;
  failAfter?: AppPublicationFailureBoundary;
  lock: AppPublicationLock;
  pendingMarkerPath: string;
  previousMarker?: Buffer;
  projected: readonly AppArtifact[];
  publishDirectory: string;
  rootDirectory: string;
  sourceMarker: AppSourceMarkerEvidence;
}>): Promise<void> {
  const run = dirname(options.publishDirectory);
  options.lock.assertHeld();
  assert.equal(resolve(options.rootDirectory, "app"), options.appDirectory, "Publication app directory escaped its repository root");
  assert.equal(dirname(run), options.controlDirectory, "Publication run escaped its control directory");
  assert.equal(basename(options.publishDirectory), "public", "Publication source must be the run public directory");
  assert.equal(options.pendingMarkerPath, join(run, "publication.json"), "Publication marker escaped its run");
  const runName = basename(run);
  assert.ok(/^build-[A-Za-z0-9_-]+$/u.test(runName), "Unsafe publication run name");
  const journal = join(options.controlDirectory, PUBLICATION_JOURNAL);
  const stagedJournal = join(run, "transaction.json");
  assert.equal(await absent(journal), true, "A prior publication transaction requires recovery");
  assert.equal(await absent(stagedJournal), true, "Publication run already has transaction evidence");
  const nextMarker = await readPrivateOrdinary(options.pendingMarkerPath);
  const nextPublication = parseAppPublicationRecord(JSON.parse(nextMarker.toString("utf8")) as unknown);
  const next: AppPublicationEvidence = {
    artifacts: nextPublication.artifacts,
    markerSha256: appSha256(nextMarker),
    sourceMarker: nextPublication.sourceMarker,
  };
  assert.deepEqual(next.artifacts, options.projected, "Pending publication marker differs from projected output");
  assert.deepEqual(next.sourceMarker, parseAppSourceMarkerEvidence(options.sourceMarker), "Pending publication source-marker evidence changed");
  await requireInventory(options.publishDirectory, options.projected);
  await syncInventory(options.publishDirectory, options.projected);
  await syncOrdinary(options.pendingMarkerPath, false);
  let previous: AppPublicationEvidence | null = null;
  if (options.previousMarker === undefined) {
    assert.equal(await absent(join(options.appDirectory, "dist")), true, "Fresh publication collided with existing output");
    assert.equal(await absent(join(options.controlDirectory, "current.json")), true, "Fresh publication collided with existing marker");
  } else {
    const previousPublication = parseAppPublicationRecord(JSON.parse(options.previousMarker.toString("utf8")) as unknown);
    previous = {
      artifacts: previousPublication.artifacts,
      markerSha256: appSha256(options.previousMarker),
      sourceMarker: previousPublication.sourceMarker,
    };
    assert.deepEqual(
      await readPrivateOrdinary(join(options.controlDirectory, "current.json")),
      options.previousMarker,
      "Current publication marker changed before transaction",
    );
    await requireInventory(join(options.appDirectory, "dist"), previous.artifacts);
    await writeFile(join(run, "previous-publication.json"), options.previousMarker, { flag: "wx", mode: 0o600 });
    await syncOrdinary(join(run, "previous-publication.json"), false);
  }
  const transaction: AppPublicationTransaction = {
    kind: "hra-app-publication-transaction",
    next,
    previous,
    run: runName,
    schemaVersion: 2,
  };
  const journalBytes = Buffer.from(publicationTransactionRecord(transaction));
  await writeFile(stagedJournal, journalBytes, { flag: "wx", mode: 0o600 });
  await syncOrdinary(stagedJournal, false);
  await syncOrdinary(run, true);
  await revalidateAppSourceMarker(
    options.rootDirectory,
    options.publishDirectory,
    next.sourceMarker,
    process.env,
  );
  options.lock.assertHeld();
  await renameSealed(stagedJournal, journal, false);
  await syncOrdinary(run, true);
  await syncOrdinary(options.controlDirectory, true);
  injectPublicationFailure(options.failAfter, "journal");
  await settleAppPublication(
    options.appDirectory,
    options.controlDirectory,
    options.lock,
    transaction,
    journalBytes,
    options.failAfter,
  );
}

export function assertAppRunDirectory(root: string, run: string): void {
  const prefix = `${root}/tmp/build-app/`;
  assert.ok(run.startsWith(prefix), "App build staging escaped the owned build-app control directory");
  const relativeRun = run.slice(prefix.length);
  assert.ok(
    /^(?:build-[A-Za-z0-9_-]+|dev\/runs\/build-[A-Za-z0-9_-]+)$/u.test(relativeRun),
    "App build staging escaped the owned build-app control directory",
  );
}

/**
 * Produce one complete, sealed app graph without choosing where it becomes
 * current. Production and the compiled development server deliberately share
 * this function; publication policy remains outside the compiler transaction.
 */
export async function stageAppBuild(options: Readonly<{
  profile: AppBuildProfile;
  rootDirectory: string;
  runDirectory: string;
}>): Promise<StagedAppBuild> {
  assert.equal(Bun.version, "1.3.14", "Build the app with the pinned Bun runtime");
  const root = resolve(options.rootDirectory);
  const run = resolve(options.runDirectory);
  const app = join(root, "app");
  assertAppRunDirectory(root, run);
  await directory(root);
  await directory(app);
  await directory(run);
  const packageBytes = await readOrdinary(join(root, "package.json"));
  const sourceEnvironment = snapshotAppSourceEnvironment(process.env);
  const sourceMarker = createAppSourceMarkerEvidence(packageBytes, sourceEnvironment);
  const authored = await readOrdinary(join(app, "index.html"));
  process.env.NODE_ENV = options.profile;
  const {
    createStylexGeneration, finalizeStylexGeneration,
    prepareStylexProducedTemplate, sealStylexProducedTemplate, STYLEX_TEMPLATE_CSS_PLACEHOLDER,
    STYLEX_COMPLETE_RECORD_SCHEMA_VERSION, stylexUnionPolicySha256,
  } = await import("@hraness/ui/stylex-build");
  const { build } = await import("vite");
  const { appDevelopmentConfig, appProductionConfig } = await import("../app/vite.config.ts");
  assert.equal(STYLEX_TEMPLATE_CSS_PLACEHOLDER, APP_CSS_PLACEHOLDER);
  assert.equal(STYLEX_COMPLETE_RECORD_SCHEMA_VERSION, 2);
  assert.equal(stylexUnionPolicySha256, STYLEX_UNION_POLICY_SHA256);
  const mount = options.profile === "development" ? "./" : "/";
  const appearance = await stageOompaAppearance(root, run);
  const outputDirectory = join(run, "complete");
  const generation = await createStylexGeneration({
    expectedGraphs: [{ adapter: "vite", entrypoints: ["app/src/main.tsx"], id: "client", kind: "client" }],
    finalCssPath: "stylex.css",
    generationId: "oompa-app",
    outputDirectory,
    packageManifests: [import.meta.resolve("@hraness/ui/stylex-manifest.json"), import.meta.resolve("@hraness/design-kit/stylex-manifest.json")],
    rootDirectory: root,
    templates: [{ cssHref: `${mount}stylex.css`, graphId: "client", outputPath: "index.html", sourcePath: "app/index.html", stylesheetGraphId: "client" }],
  });
  const configuration = options.profile === "development"
    ? appDevelopmentConfig(root, generation, appearance)
    : appProductionConfig(root, generation, appearance);
  const graph = snapshotAppGraph(await build(configuration), join(app, "src", "main.tsx"), appearance);
  const prepared = await prepareStylexProducedTemplate(generation, "index.html");
  const preparedShell = prepareAppShell(authored.toString("utf8"), graph, mount);
  await writeFile(prepared.sourcePath, preparedShell, { flag: "wx", mode: 0o600 });
  await sealStylexProducedTemplate(generation, "index.html");
  assert.deepEqual(await readOrdinary(join(app, "index.html")), authored, "Authored shell changed during build");
  const completed = await finalizeStylexGeneration({ generation, outputDirectory, rootDirectory: root });
  await appearance.verifyInputs();
  assert.equal(completed, join(outputDirectory, "oompa-app"));
  const completeBytes = await readOrdinary(join(completed, COMPLETE));
  const compilerProjected = parseAppComplete(JSON.parse(completeBytes.toString("utf8")) as unknown);
  assert.deepEqual(
    compilerProjected.filter(({ path }) => path.startsWith("graphs/")),
    graph.artifacts.map((item) => ({ ...item, path: `graphs/client/${item.path}` })),
  );
  const completeInventory = await readAppInventory(completed, true);
  assert.deepEqual(completeInventory.filter(({ path }) => path !== COMPLETE), compilerProjected);
  assert.equal(
    (await readOrdinary(join(completed, "index.html"))).toString("utf8"),
    preparedShell.replace(APP_CSS_PLACEHOLDER, `${mount}stylex.css`),
  );
  const publish = join(run, "public");
  await makeDirectory(publish);
  for (const item of compilerProjected) {
    const parts = item.path.split("/");
    let parent = publish;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      await makeDirectory(parent);
    }
    await copyFile(join(completed, item.path), join(publish, item.path), COPYFILE_EXCL);
  }
  await revalidateAppSourceMarkerInputs(root, sourceMarker);
  const markerDirectory = join(publish, ".well-known");
  await makeDirectory(markerDirectory);
  await writeFile(
    join(publish, APP_SOURCE_MARKER_PATH),
    appSourceMarkerBytes(sourceMarker.marker),
    { flag: "wx", mode: 0o600 },
  );
  const projected = publicationArtifacts(
    [...compilerProjected, sourceMarker.markerArtifact]
      .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
  );
  assert.deepEqual(await readAppInventory(publish), projected);
  await revalidateAppSourceMarker(root, publish, sourceMarker);
  const pendingMarkerPath = join(run, "publication.json");
  await writeFile(
    pendingMarkerPath,
    appPublicationRecord(projected, appSha256(authored), appSha256(completeBytes), sourceMarker),
    { flag: "wx", mode: 0o600 },
  );
  // The returned values are a join boundary. Re-read every source and output
  // before a production or development publisher is allowed to name it.
  await directory(app);
  await directory(run);
  assert.deepEqual(await readOrdinary(join(app, "index.html")), authored);
  assert.deepEqual(await readAppInventory(completed, true), completeInventory);
  assert.deepEqual(await readAppInventory(publish), projected);
  return {
    authored,
    completeBytes,
    completeDirectory: completed,
    completeInventory,
    pendingMarkerPath,
    projected,
    publishDirectory: publish,
    sourceMarker,
  };
}

async function buildApp(): Promise<void> {
  assert.equal(Bun.version, "1.3.14", "Build the app with the pinned Bun runtime");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const app = join(root, "app");
  const dist = join(app, "dist");
  await directory(root);
  await directory(app);
  await makeDirectory(join(root, "tmp"));
  const control = join(root, "tmp", "build-app");
  await makeDirectory(control);
  const lock = acquireAppPublicationLock(control);
  try {
    lock.assertHeld();
    await reconcileAppPublication(app, control, lock);
    const marker = join(control, "current.json");
    const previousMarker = await absent(marker) ? undefined : await readPrivateOrdinary(marker);
    const previous = previousMarker === undefined ? undefined : parseAppPublication(JSON.parse(previousMarker.toString("utf8")) as unknown);
    if (await absent(dist)) assert.equal(previous, undefined, "Prior app output is missing; preserve publication evidence");
    else {
      assert.ok(previous !== undefined, "Existing app/dist lacks verified build-app provenance; do not move it");
      assert.deepEqual(await readAppInventory(dist), previous, "Previous app output drifted; preserve it");
    }
    const run = await mkdtemp(join(control, "build-"));
    await directory(run);
    const staged = await stageAppBuild({
      profile: "production",
      rootDirectory: root,
      runDirectory: run,
    });
    // Revalidate all inputs to the rename join. Never erase or overwrite an
    // unknown directory, stale marker, or previously published byte.
    await directory(control);
    await directory(run);
    assert.deepEqual(await readOrdinary(join(app, "index.html")), staged.authored);
    assert.deepEqual(await readAppInventory(staged.completeDirectory, true), staged.completeInventory);
    assert.deepEqual(await readAppInventory(staged.publishDirectory), staged.projected);
    lock.assertHeld();
    await commitAppPublication({
      appDirectory: app,
      controlDirectory: control,
      lock,
      pendingMarkerPath: staged.pendingMarkerPath,
      ...(previousMarker === undefined ? {} : { previousMarker }),
      projected: staged.projected,
      publishDirectory: staged.publishDirectory,
      rootDirectory: root,
      sourceMarker: staged.sourceMarker,
    });
    lock.assertHeld();
    console.log("Built app/dist with a sealed client graph and one finalized StyleX recipe stylesheet. Prior output and private receipts remain under tmp/build-app/.");
  } finally {
    lock.release();
  }
}

if (import.meta.main) await buildApp();
