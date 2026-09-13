import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, readFile, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { transform } from "lightningcss";
import type { BrowserContext, CDPSession, Locator, Page, Request as BrowserRequest, Response as BrowserResponse } from "playwright-core";
import type { DirectBrowserBridge } from "@hraness/direct/web";
import { browserIoModules } from "../app/fixtures/browser/config";
import { productIoModules } from "../app/fixtures/product/config";
import { assertBrowserNode, browserDigest, browserExecutable, browserPublicArtifacts, publishBrowserJson, type BrowserExecutionAdmission } from "./app-browser-handoff.ts";
import { serveBrowserAssets } from "./app-browser-server.ts";
import { readRestoredStyleFramePair, settleExactStylesheet, StylesheetSettlementError, type StylesheetSettlementDiagnostics } from "./app-browser-settlement.ts";
import { inspectSiteCssResources } from "./site-css-resources.ts";
import { snapshotMarketingPreset } from "./marketing-preset.ts";
import { checkLanternMaterialSnapshot } from "../site/vendor/lantern-material/check.mjs";

type Artifact = Readonly<{ bytes: number; path: string; sha256: string }>;
type Surface = Readonly<{ artifacts: readonly Artifact[]; bytes: ReadonlyMap<string, Buffer>; origin: string; stop: () => Promise<void> }>;
type Evidence = Readonly<{ name: string; values: unknown }>;
export type BrowserCustodyObservation =
  | Readonly<{ kind: "preparation-owned"; run: string; identity: Readonly<{ pid: number; parent: number; group: number; started: string }> }>
  | Readonly<{ kind: "partial-servers-owned"; run: string; origins: readonly string[] }>
  | Readonly<{ kind: "browser-census-owned"; run: string; origins: readonly string[]; pids: readonly number[] }>;
export type BrowserCustodyObserver = (observation: BrowserCustodyObservation) => undefined;

/** Observation carries copied identity data, never resource handles or alternate
 * operations. Production has no observer; native custody fixtures may fail or
 * self-signal here, inside the existing owner and cleanup boundary. */
export function observeBrowserCustody(observer: BrowserCustodyObserver | undefined, observation: BrowserCustodyObservation): void {
  if (observer === undefined) return;
  const frozen = observation.kind === "preparation-owned"
    ? Object.freeze({ ...observation, identity: Object.freeze({ ...observation.identity }) })
    : observation.kind === "partial-servers-owned"
      ? Object.freeze({ ...observation, origins: Object.freeze([...observation.origins]) })
      : Object.freeze({ ...observation, origins: Object.freeze([...observation.origins]), pids: Object.freeze([...observation.pids]) });
  assert.equal(observer(frozen), undefined, "Browser custody observation must finish synchronously");
}
type BrowserFailure = Readonly<{ name: string; message: string; cause?: BrowserFailure; errors?: readonly BrowserFailure[]; settlement?: StylesheetSettlementDiagnostics; focus?: ReturnType<typeof focusStripDiagnostics> }>;
export function browserFailureDetails(value: unknown, depth = 0): BrowserFailure {
  if (!(value instanceof Error)) return { name: "UnknownFailure", message: typeof value === "string" ? value.slice(0, 1000) : typeof value };
  return {
    name: value.name.slice(0, 80), message: value.message.slice(0, 1000),
    ...(value instanceof StylesheetSettlementError ? { settlement: value.diagnostics } : {}),
    ...(value instanceof FocusStripAssertionError ? { focus: value.diagnostics } : {}),
    ...(depth < 3 && value.cause !== undefined ? { cause: browserFailureDetails(value.cause, depth + 1) } : {}),
    ...(depth < 3 && value instanceof AggregateError ? { errors: value.errors.slice(0, 8).map((error: unknown) => browserFailureDetails(error, depth + 1)) } : {}),
  };
}
type Profile = Readonly<{ name: string; width: number; height: number; coarse: boolean; reduced: boolean; forced: boolean; rtl: boolean; colorScheme?: "dark" | "light" }>;
const fixtureViews = ["signin", "enrollment", "grid", "session", "session-long", "retired", "settings", "primitives"] as const;
const productViews = ["overview", "conversation", "question", "settings"] as const;
type ProductView = typeof productViews[number];
const siteRouteLabels = ["home", "privacy", "preview", "docs", "docs-start", "docs-web", "docs-sessions", "docs-reference", "docs-status"] as const;
const profiles: readonly Profile[] = [
  { name: "desktop", width: 1280, height: 900, coarse: false, reduced: false, forced: false, rtl: false },
  { name: "light-os", width: 1280, height: 900, coarse: false, reduced: false, forced: false, rtl: false, colorScheme: "light" },
  { name: "narrow-coarse", width: 390, height: 844, coarse: true, reduced: false, forced: false, rtl: false },
  { name: "reduced-motion", width: 1280, height: 900, coarse: false, reduced: true, forced: false, rtl: false },
  { name: "forced-colors", width: 1280, height: 900, coarse: false, reduced: false, forced: true, rtl: false },
  { name: "rtl", width: 390, height: 844, coarse: true, reduced: false, forced: false, rtl: true },
];
const negativeStylesheetSubsteps = [
  "sample-before", "link-count", "capture", "disable", "settle-disabled", "sample-disabled",
  "restore", "settle-restored", "identity-restored", "sample-restored", "dispose",
] as const;
type NegativeStylesheetSubstep = typeof negativeStylesheetSubsteps[number];
type NegativeStylesheetReporter = (step: NegativeStylesheetSubstep, phase: "entered" | "settled" | "failed", error?: unknown) => void;
const browserDiagnosticSteps = new Set([
  "launch", "isolation:install", "isolation:service-worker-refusal", "page:create", "browser-census:connect", "browser-census:read", "browser-census:detach",
  "production-anonymous:navigation", "production-anonymous:assertions", "production-anonymous:negative-css",
  "asymmetric-safe-area", "isolation:assertions", "cleanup", "complete",
  ...fixtureViews.flatMap((view) => ["navigation", "assertions", "screenshot"].map((step) => `fixture:${view}:${step}`)),
  "static-site:home:product-previews", "static-site:docs:search", "static-site:docs:legacy-redirects",
  "static-site:docs-reference:appearance-menu",
  ...siteRouteLabels.flatMap((route) => [
    "navigation", "document-bytes", "direction", "heading", "settle-before-fonts", "font-load", "settle-after-fonts",
    "document-clean", "stylesheet-links", "stylesheet-inventory", "color-scheme", "background", "heading-style", "inertness",
    "negative-final-css", "negative-foundation-css", "negative-document-clean", "resource-bytes", "mobile-anchors", "material",
  ].map((step) => `static-site:${route}:${step}`)),
  ...["production-anonymous:negative-css", "fixture:primitives:negative-css", ...siteRouteLabels.flatMap((route) =>
    [`static-site:${route}:negative-final-css`, `static-site:${route}:negative-foundation-css`])]
    .flatMap((parent) => negativeStylesheetSubsteps.map((step) => `${parent}:${step}`)),
]);
type BrowserProfileDiagnostics = {
  name: string; step: string; failureStep: string | undefined; events: string[]; ownedPids: number[]; failure: BrowserFailure | undefined;
};

/** Public logs contain only finite labels, never an Error message, URL, PID or page sample. */
export function browserDiagnosticLine(profile: unknown, step: unknown, phase: unknown, error?: unknown, elapsedMs?: unknown): string {
  const safeProfile = typeof profile === "string" && profiles.some(({ name }) => name === profile) ? profile : "unknown-profile";
  const safeStep = typeof step === "string" && browserDiagnosticSteps.has(step) ? step : "unknown-step";
  const safePhase = typeof phase === "string" && ["progress", "after-failure", "entered", "settled", "failed", "cleanup-failed"].includes(phase) ? phase : "unknown-phase";
  return `Browser diagnostic ${JSON.stringify({ profile: safeProfile, step: safeStep, phase: safePhase,
    ...(elapsedMs === undefined ? {} : { elapsedMs: typeof elapsedMs === "number" && Number.isFinite(elapsedMs)
      ? Math.min(3_600_000, Math.max(0, Math.trunc(elapsedMs))) : 0 }),
    ...(safePhase === "failed" || safePhase === "cleanup-failed" ? { failure: browserFailureClass(error) } : {}),
  })}`;
}

export function browserFailureClass(value: unknown): string {
  if (!(value instanceof Error)) return "unknown";
  if (value instanceof AggregateError) return "aggregate";
  if (value.name === "AssertionError") return "assertion";
  if (value.name === "TimeoutError" || /^Browser profile [a-z-]+ exceeded 120000ms$/u.test(value.message)
    || value.message === "Browser font/frame settlement exceeded 15000ms"
    || /^(?:Closing browser census session|Closing browser process census|Browser census detach|Owned browser close|Final browser close) exceeded (?:5000|20000)ms$/u.test(value.message)) return "deadline";
  if (value.name === "AbortError" || /^Browser (?:profile [a-z-]+|acceptance) cancelled(?: during launch)?$/u.test(value.message)) return "cancelled";
  return "error";
}

/** The profile promise may settle later during cleanup. Freeze its first failed step now. */
export function recordBrowserProfileFailure(diagnostics: Pick<BrowserProfileDiagnostics, "step" | "failureStep" | "failure">, error: unknown): void {
  if (diagnostics.failureStep !== undefined) return;
  diagnostics.failureStep = diagnostics.step;
  diagnostics.failure = browserFailureDetails(error);
}

/** Observe only: racing a still-running CSSOM mutation against a new timer could
 * start restoration before that mutation settles. Keep the existing budgets. */
export async function browserNegativeStep<T>(step: NegativeStylesheetSubstep, operation: () => Promise<T>, report: NegativeStylesheetReporter): Promise<T> {
  report(step, "entered");
  try {
    const result = await operation();
    report(step, "settled");
    return result;
  } catch (error) {
    report(step, "failed", error);
    throw error instanceof Error ? error : new Error("Browser stylesheet operation failed", { cause: error });
  }
}

/** Await the exact cleanup even after failure, retaining both errors instead of
 * letting an awaited finally replace the original operation failure. */
export async function withBrowserNegativeCleanup<T>(operation: () => Promise<T>, cleanup: () => Promise<void>, stage: "restore" | "dispose"): Promise<T> {
  let result: { value: T } | { error: unknown };
  try { result = { value: await operation() }; }
  catch (error) { result = { error }; }
  try { await cleanup(); }
  catch (error) {
    if ("error" in result) throw new AggregateError([result.error, error], `Browser stylesheet operation and ${stage} failed`);
    throw error instanceof Error ? error : new Error(`Browser stylesheet ${stage} failed`, { cause: error });
  }
  if ("error" in result) throw result.error instanceof Error ? result.error : new Error("Browser stylesheet operation failed", { cause: result.error });
  return result.value;
}
const digest = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const bracketedFontPath = "fonts/geist-mono/GeistMono[wght].woff2";
const fontProvenancePaths = new Set([
  "fonts/geist-mono/PROVENANCE.md", "fonts/nebula-sans/PROVENANCE.md",
  "fonts/instrument-serif/UPSTREAM.md", "marketing-preset/LICENSE", "marketing-preset/marketing-assets/UPSTREAM.md",
]);
const legacyFontPaths = new Set([bracketedFontPath]);
const siteRoutes = [
  { path: "index.html", pathname: "/", heading: "h1", label: "home" },
  { path: "privacy/index.html", pathname: "/privacy/", heading: "#privacy-heading", label: "privacy" },
  { path: "preview/index.html", pathname: "/preview/", heading: "h1", label: "preview" },
  { path: "docs/index.html", pathname: "/docs/", heading: "h1", label: "docs" },
  { path: "docs/start/index.html", pathname: "/docs/start/", heading: "h1", label: "docs-start" },
  { path: "docs/web/index.html", pathname: "/docs/web/", heading: "h1", label: "docs-web" },
  { path: "docs/sessions/index.html", pathname: "/docs/sessions/", heading: "h1", label: "docs-sessions" },
  { path: "docs/reference/index.html", pathname: "/docs/reference/", heading: "h1", label: "docs-reference" },
  { path: "docs/status/index.html", pathname: "/docs/status/", heading: "h1", label: "docs-status" },
] as const;
const siteMarkdownPaths = new Set(siteRoutes.filter(({ pathname }) => pathname.startsWith("/docs/")).map(({ path }) => path.replace(/\.html$/u, ".md")));
const productPreviewCsp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'";
const productAssetPath = /^examples\/app\/(?:index\.html|stylex\.css|graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/u;
const siteInstalledPublicFonts = [
  ...["Light", "LightItalic", "Book", "BookItalic", "Medium", "MediumItalic", "Semibold", "SemiboldItalic", "Bold", "BoldItalic", "Black", "BlackItalic"]
    .map((cut) => `nebula-sans/NebulaSans-${cut}.woff2`),
  "geist-mono/GeistMono[wght].woff2",
];
const sitePresetFont = "instrument-serif/instrument-serif-latin-400.woff2";
const sitePublicFonts = [...siteInstalledPublicFonts, sitePresetFont];
const sitePresetTextures = ["marketing-assets/grain.svg", "marketing-assets/cells.svg"] as const;
const sitePresetAttributions = [
  ["fonts/instrument-serif/OFL.txt", "fonts/instrument-serif/OFL.txt"],
  ["fonts/instrument-serif/UPSTREAM.md", "fonts/instrument-serif/UPSTREAM.md"],
  ["marketing-preset/LICENSE", "LICENSE"],
  ["marketing-preset/marketing-assets/UPSTREAM.md", "marketing-assets/UPSTREAM.md"],
] as const;
const sitePublicSupport = [
  "analytics.js", "appearance.js", "site.js", "favicon.svg", "social-card.svg", "social-card.png", "robots.txt", "sitemap.xml", "llms.txt",
  ".well-known/security.txt", ".well-known/hra.json",
  "fonts/nebula-sans/LICENSE.txt", "fonts/nebula-sans/PROVENANCE.md",
  "fonts/geist-mono/OFL.txt", "fonts/geist-mono/PROVENANCE.md",
  ...sitePresetAttributions.map(([path]) => path),
  ...siteMarkdownPaths,
];
const diagnosticPath = (path: string) => JSON.stringify(path.slice(0, 160));

function capturedFontKey(key: string, fontPaths: ReadonlySet<string>): boolean {
  return fontPaths.has(key) && (key === bracketedFontPath
    || /^graphs\/foundation\/assets\/[A-Za-z0-9_.[\]-]+\.woff2$/u.test(key));
}

function safeInventoryKey(key: string, fontPaths: ReadonlySet<string> = legacyFontPaths): boolean {
  return key.length <= 2048 && (capturedFontKey(key, fontPaths)
    || key.split("/").every((part) => /^[A-Za-z0-9_.-]+$/u.test(part) && part !== "." && part !== ".."));
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

export function productionCsp(value: unknown, source: string): string {
  const configuration = record(value);
  assert.ok(Array.isArray(configuration.headers));
  const rows = configuration.headers.map(record).filter((row) => row.source === source);
  assert.equal(rows.length, 1, "CSP route contract changed");
  const headers = rows[0]?.headers;
  assert.ok(Array.isArray(headers));
  const values = headers.map(record).filter((header) => header.key === "Content-Security-Policy");
  assert.equal(values.length, 1);
  const csp = values[0]?.value;
  assert.ok(typeof csp === "string" && csp.length < 8192);
  assert.ok(csp.split(";").some((directive) => directive.trim() === "style-src 'self'"));
  assert.ok(!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'"));
  return csp;
}

export function siteProductionCsp(value: unknown): Readonly<{ siteCsp: string; previewCsp: string; productPreviewCsp: string }> {
  const siteCsp = productionCsp(value, "/((?!preview/?$|examples/app(?:/|$)).*)");
  const previewCsp = productionCsp(value, "/preview/");
  for (const csp of [siteCsp, previewCsp]) {
    assert.deepEqual(csp.split(";").map((part) => part.trim()).filter((part) => part.startsWith("font-src")), ["font-src 'self'"]);
  }
  assert.deepEqual(previewCsp.split(";").map((part) => part.trim()).filter((part) => part.startsWith("script-src")), ["script-src 'none'"]);
  assert.deepEqual(siteCsp.split(";").map((part) => part.trim()).filter((part) => part.startsWith("frame-src")), ["frame-src 'self' https://challenges.cloudflare.com"]);
  const productCsp = productionCsp(value, "/examples/app/:path(.*)");
  assert.equal(productCsp, `${productPreviewCsp}; frame-ancestors 'self'`, "Product example CSP drifted");
  const rows = record(value).headers;
  assert.ok(Array.isArray(rows));
  const headers = record(rows.map(record).find((row) => row.source === "/examples/app/:path(.*)")).headers;
  assert.ok(Array.isArray(headers));
  assert.deepEqual(headers.map(record).map(({ key, value }) => [key, value]).sort(), [
    ["Content-Security-Policy", productCsp], ["Access-Control-Allow-Origin", "*"],
    ["Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()"],
    ["Referrer-Policy", "no-referrer"], ["X-Content-Type-Options", "nosniff"], ["X-Robots-Tag", "noindex, nofollow"],
  ].sort(), "Product example headers must permit opaque module loads without credentials or embedding denial");
  return { siteCsp, previewCsp, productPreviewCsp: productCsp };
}

/** URL normalization cannot turn a request into an arbitrary filesystem read. */
export function assetPath(pathname: string, fontPaths: ReadonlySet<string> = legacyFontPaths): string | null {
  if (pathname.length > 2048 || pathname.split("/").length > 14) return null;
  if (pathname === "/") return "index.html";
  // Only captured font keys may use brackets. Decode no other URL escapes:
  // encoded separators, double encodings and dot segments remain closed.
  const fontKey = pathname.slice(1).replace(/%5b/giu, "[").replace(/%5d/giu, "]");
  if (pathname.startsWith("/") && capturedFontKey(fontKey, fontPaths)) return fontKey;
  if (!/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?$/u.test(pathname)) return null;
  if (pathname.split("/").some((part) => part === "." || part === "..")) return null;
  return pathname.endsWith("/") ? `${pathname.slice(1)}index.html` : pathname.slice(1);
}

async function ordinary(path: string): Promise<Buffer> {
  assert.equal(await realpath(path), resolve(path), "Browser input must have a physical path");
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.size <= 64 * 1024 * 1024, "Unsafe browser input");
  const identity = (info: typeof before) => [info.dev, info.ino, info.size, info.mode, info.nlink, info.mtimeMs, info.ctimeMs];
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser input changed before reading");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      assert.ok(Buffer.isBuffer(chunk));
      bytes += chunk.byteLength;
      assert.ok(bytes <= before.size, "Browser input grew during reading");
      chunks.push(chunk);
    }
    assert.equal(bytes, before.size, "Browser input shrank during reading");
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser input changed during reading");
    assert.deepEqual(identity(await lstat(path)), identity(before), "Browser input path changed during reading");
    assert.equal(await realpath(path), resolve(path), "Browser input lost its physical path");
    return Buffer.concat(chunks, bytes);
  } finally { await handle.close(); }
}

/** Full Linux Chromium is much larger than the macOS launcher. Stream its
 * identity separately; public assets keep their independent 64 MiB bound. */
export async function browserExecutableSha256(path: string): Promise<string> {
  const before = await lstat(path);
  assert.ok(before.isFile() && !before.isSymbolicLink() && (before.mode & 0o111) !== 0);
  assert.ok(before.size > 0 && before.size <= 1024 * 1024 * 1024, "Browser executable exceeds the 1 GiB boundary");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const identity = (info: typeof before) => [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.ctimeMs];
  try {
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser executable changed before reading");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      assert.ok(chunk instanceof Uint8Array);
      bytes += chunk.byteLength;
      assert.ok(bytes <= before.size, "Browser executable grew during reading");
      hash.update(chunk);
    }
    assert.equal(bytes, before.size);
    assert.deepEqual(identity(await handle.stat()), identity(before), "Browser executable changed during reading");
    assert.deepEqual(identity(await lstat(path)), identity(before), "Browser executable path changed during reading");
    return hash.digest("hex");
  } finally { await handle.close(); }
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function collected(pids: readonly number[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (pids.some(processExists) && Date.now() < deadline) await new Promise((done) => { setTimeout(done, 50); });
  assert.deepEqual(pids.filter(processExists), [], "Owned browser process survived close; profile preserved");
}

export async function boundedBrowserOperation<T>(operation: Promise<T>, milliseconds: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new Error(`${label} cancelled`)); };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    return await Promise.race([operation, cancelled, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error(`${label} exceeded ${milliseconds}ms`)); }, milliseconds);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function closeOwnedBrowser(context: BrowserContext, pids: number[]): Promise<void> {
  let censusFailure: unknown;
  try {
    const browser = context.browser();
    assert.ok(browser !== null, "Browser ownership disappeared before closing census");
    const session = await boundedBrowserOperation(browser.newBrowserCDPSession(), 5000, "Closing browser census session");
    try {
      const census = await boundedBrowserOperation(session.send("SystemInfo.getProcessInfo"), 5000, "Closing browser process census");
      for (const entry of census.processInfo) {
        assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0 && entry.id !== process.pid);
        if (!pids.includes(entry.id)) pids.push(entry.id);
      }
      assert.ok(pids.length > 0, "Browser census was empty");
    } finally { await boundedBrowserOperation(session.detach(), 5000, "Browser census detach"); }
  } catch (error) { censusFailure = error; }
  try {
    await boundedBrowserOperation(context.close(), 20_000, "Owned browser close");
    await collected(pids);
    assert.equal(context.pages().length, 0);
  } catch (error) {
    if (censusFailure === undefined) throw error;
    throw new AggregateError([censusFailure, error], "Browser census and collection failed; profile retained");
  }
  if (censusFailure !== undefined) throw censusFailure instanceof Error
    ? censusFailure : new Error("Browser census failed; profile retained", { cause: censusFailure });
}

export async function inventory(directory: string, fontPaths: ReadonlySet<string> = legacyFontPaths): Promise<ReadonlyMap<string, Buffer>> {
  assert.equal(await realpath(directory), resolve(directory), "Browser output must have a physical path");
  const files = new Map<string, Buffer>();
  let total = 0;
  let entryCount = 0;
  async function walk(path: string, prefix: string): Promise<void> {
    assert.ok(prefix.split("/").length <= 12 && files.size <= 4096, "Browser inventory exceeds bounds");
    const before = await lstat(path);
    assert.ok(before.isDirectory() && !before.isSymbolicLink(), `Unsafe browser directory: ${diagnosticPath(prefix)}`);
    assert.equal(await realpath(path), resolve(path), `Nonphysical browser directory: ${diagnosticPath(prefix)}`);
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const key = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      entryCount += 1;
      assert.ok(entryCount <= 4096, "Browser inventory entry count exceeds 4096");
      assert.ok(safeInventoryKey(key, fontPaths), `Unsafe public browser output name: ${diagnosticPath(key)}`);
      assert.ok(!entry.isSymbolicLink(), `Linked public browser output: ${diagnosticPath(key)}`);
      if (capturedFontKey(key, fontPaths) || fontProvenancePaths.has(key)) {
        assert.ok(entry.isFile(), `Expected an ordinary public font file: ${diagnosticPath(key)}`);
      }
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child, key);
      else {
        assert.ok(/\.(?:css|html|js|json|svg|png|ico|woff2?|txt|xml)$/u.test(entry.name)
          || fontProvenancePaths.has(key) || siteMarkdownPaths.has(key), `Unexpected public browser output type: ${diagnosticPath(key)}`);
        const bytes = await ordinary(child);
        total += bytes.byteLength;
        assert.ok(total <= 256 * 1024 * 1024 && files.size < 4096);
        files.set(key, bytes);
      }
    }
    const after = await lstat(path);
    assert.ok(after.isDirectory() && !after.isSymbolicLink(), `Browser directory changed type: ${diagnosticPath(prefix)}`);
    assert.deepEqual([after.dev, after.ino, after.mtimeMs, after.ctimeMs],
      [before.dev, before.ino, before.mtimeMs, before.ctimeMs], `Browser directory changed: ${diagnosticPath(prefix)}`);
    assert.equal(await realpath(path), resolve(path), `Browser directory lost its physical path: ${diagnosticPath(prefix)}`);
  }
  await walk(directory, "");
  assert.ok(files.has("index.html"));
  return files;
}

function artifacts(files: ReadonlyMap<string, Buffer>): readonly Artifact[] {
  return [...files].map(([path, bytes]) => ({ bytes: bytes.byteLength, path, sha256: digest(bytes) }))
    .sort((a, b) => a.path < b.path ? -1 : 1);
}

/** Read the actual sealed HTML join, not a guessed Vite asset name. */
export function siteStylesheetPaths(documents: ReadonlyMap<string, Buffer>): readonly [string, string] {
  let expected: readonly [string, string] | undefined;
  for (const { path } of siteRoutes) {
    const bytes = documents.get(path);
    assert.ok(bytes !== undefined && bytes.length > 0 && bytes.length <= 8 * 1024 * 1024, `Missing bounded site document: ${path}`);
    const { document } = parseHTML(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    assert.equal(document.querySelectorAll("style,[style],base").length, 0, "Static document changed its no-inline/base contract");
    assert.equal(document.documentElement.getAttribute("data-palette"), path === "preview/index.html" ? "catppuccin" : "paper", "Static default palette changed");
    assert.equal(document.documentElement.getAttribute("data-theme"), path === "preview/index.html" ? "dark" : "light", "Static default theme changed");
    const appearance = [...document.querySelectorAll('script[src="/appearance.js"]')];
    const menus = [...document.querySelectorAll("details[data-oompa-appearance]")];
    if (path === "preview/index.html") {
      assert.equal(document.querySelectorAll("script,details[data-oompa-appearance]").length, 0, "Inert preview acquired appearance controls");
    } else {
      assert.equal(appearance.length, 1, "Static page must load one bound appearance bootstrap");
      const bootstrap = appearance[0];
      assert.ok(bootstrap !== undefined);
      assert.equal(bootstrap.parentElement, document.head);
      assert.deepEqual([...bootstrap.attributes].map(({ name }) => name), ["src"], "Appearance must remain a blocking classic script");
      assert.equal(bootstrap.textContent.trim(), "");
      assert.equal(menus.length, 1, "Static page must expose exactly one appearance menu");
      const menu = menus[0];
      assert.ok(menu !== undefined && menu.closest("header") !== null, "Appearance menu lost its header position");
    }
    const links = [...document.querySelectorAll("link")].filter((link) => link.getAttribute("rel")?.toLowerCase().split(/\s+/u).includes("stylesheet"));
    assert.equal(links.length, 2, "Static document must link exactly foundation then union");
    for (const link of links) {
      assert.equal(link.parentElement, document.head);
      assert.deepEqual([...link.attributes].map(({ name }) => name).sort(), ["href", "rel"]);
      assert.equal(link.getAttribute("rel"), "stylesheet");
    }
    const foundation = links[0]?.getAttribute("href");
    assert.ok(typeof foundation === "string");
    assert.match(foundation, /^\/graphs\/foundation\/assets\/[A-Za-z0-9_.-]+\.css$/u);
    assert.equal(links[1]?.getAttribute("href"), "/stylex.css");
    const paths = [foundation.slice(1), "stylex.css"] as const;
    if (expected !== undefined) assert.deepEqual(paths, expected, "Static routes disagree about the completed stylesheet graph");
    expected = paths;
  }
  assert.ok(expected !== undefined);
  return expected;
}

/** Parse native CSS URLs and all font-face sources. A path becomes admissible
 * only because this captured foundation names it; escaping never broadens it. */
export function siteFoundationResourcePaths(path: string, bytes: Buffer): Readonly<{ fonts: readonly string[]; textures: readonly string[] }> {
  assert.match(path, /^graphs\/foundation\/assets\/[A-Za-z0-9_.-]+\.css$/u);
  assert.ok(bytes.length > 0 && bytes.length <= 16 * 1024 * 1024);
  const faces: string[] = [];
  // Inspect original AST URLs, including custom properties and literal
  // image-set strings. Dependency relocation rejects valid relative token URLs.
  const urls = inspectSiteCssResources(new TextDecoder("utf-8", { fatal: true }).decode(bytes), path);
  const parsed = transform({ filename: path, code: bytes, visitor: {
    Rule: {
      import() { throw new Error("Static foundation contains an uncollected CSS import"); },
      "font-face"(rule) {
        const sources = rule.value.properties.filter((property) => property.type === "source");
        assert.equal(sources.length, 1);
        const source = sources[0];
        assert.ok(source?.type === "source" && source.value.length === 1);
        const url = source.value[0];
        assert.ok(url?.type === "url" && url.value.format?.type === "woff2", "Static font face is not one physical WOFF2 source");
        faces.push(url.value.url.url);
      },
    },
  } });
  assert.equal(parsed.warnings.length, 0, "Static foundation CSS inspection emitted warnings");
  assert.equal(faces.length, 14, "Static foundation must declare all fourteen public font faces");
  assert.equal(new Set(faces).size, 14, "Static foundation duplicates a font URL");
  const textures = urls.filter((url) => !faces.includes(url));
  assert.equal(textures.length, 2, "Static foundation must contain exactly two non-font texture URLs");
  assert.equal(new Set(textures).size, 2, "Static foundation duplicates a texture URL");
  assert.deepEqual([...urls].sort(), [...faces, ...textures].sort(), "Static foundation repeats a font outside its face");
  const resolveAsset = (url: string, kind: "woff2" | "svg") => {
    // Vite may preserve or sanitize brackets. Both must come from captured CSS,
    // stay in this asset directory, and later match a public input's full hash.
    const decoded = url.replace(/%5b/giu, "[").replace(/%5d/giu, "]");
    assert.match(decoded, kind === "woff2" ? /^(?:\.\/)?[A-Za-z0-9_.[\]-]+\.woff2$/u : /^(?:\.\/)?[A-Za-z0-9_.-]+\.svg$/u,
      "Static resource URL escaped its captured asset directory");
    const resolved = new URL(decoded, `https://site.invalid/${path}`);
    assert.equal(resolved.origin, "https://site.invalid");
    assert.equal(resolved.search + resolved.hash, "");
    return resolved.pathname.slice(1);
  };
  return { fonts: faces.map((url) => resolveAsset(url, "woff2")).sort(), textures: textures.map((url) => resolveAsset(url, "svg")).sort() };
}
export function siteFoundationFontPaths(path: string, bytes: Buffer): readonly string[] {
  return siteFoundationResourcePaths(path, bytes).fonts;
}

/** This is a distinct compiler generation, never an exception to the parent
 * site's exact font and stylesheet graph. Its sealed relative URLs stay inside
 * the public mount; no compiler receipt, source, or additional asset may leak. */
export function snapshotProductPreview(files: ReadonlyMap<string, Buffer>) {
  const paths = [...files.keys()].sort();
  assert.ok(paths.length >= 4 && paths.length <= 4096);
  assert.ok(paths.every((path) => productAssetPath.test(path)), "Unapproved product example artifact");
  assert.ok([...files.values()].every((bytes) => bytes.length > 0 && bytes.length <= 64 * 1024 * 1024));
  assert.ok([...files.values()].reduce((total, bytes) => total + bytes.length, 0) <= 256 * 1024 * 1024);
  const shell = files.get("examples/app/index.html");
  assert.ok(shell !== undefined && shell.length > 0 && shell.length <= 64 * 1024);
  const { document } = parseHTML(new TextDecoder("utf-8", { fatal: true }).decode(shell));
  assert.equal(document.querySelectorAll("style,[style],base,iframe,form").length, 0);
  const policies = [...document.querySelectorAll("meta[http-equiv]")];
  assert.equal(policies.length, 1);
  assert.equal(policies[0]?.getAttribute("http-equiv")?.toLowerCase(), "content-security-policy");
  assert.equal(policies[0].getAttribute("content"), productPreviewCsp);
  assert.equal(policies[0].parentElement, document.head);
  const styles = [...document.querySelectorAll('link[rel="stylesheet"]')];
  assert.equal(styles.length, 2);
  assert.equal(document.querySelectorAll("link").length, 2);
  for (const link of styles) {
    assert.equal(link.parentElement, document.head);
    assert.deepEqual([...link.attributes].map(({ name }) => name).sort(), ["href", "rel"]);
  }
  const foundation = styles[0]?.getAttribute("href");
  assert.ok(typeof foundation === "string");
  assert.match(foundation, /^\.\/graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.css$/u);
  assert.equal(styles[1]?.getAttribute("href"), "./stylex.css");
  const stylesheets = [`examples/app/${foundation.slice(2)}`, "examples/app/stylex.css"] as const;
  assert.deepEqual(paths.filter((path) => path.endsWith(".css")), [...stylesheets].sort());
  const scripts = [...document.querySelectorAll("script")];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0]?.getAttribute("type"), "module");
  assert.equal(scripts[0].textContent.trim(), "");
  assert.equal(scripts[0].parentElement, document.body);
  assert.deepEqual([...scripts[0].attributes].map(({ name }) => name).sort(), ["src", "type"]);
  const script = scripts[0].getAttribute("src");
  assert.ok(typeof script === "string");
  assert.match(script, /^\.\/graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/u);
  assert.ok(files.has(`examples/app/${script.slice(2)}`));
  assert.equal(document.querySelectorAll("[srcset]").length, 0);
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) assert.ok(!/^on/iu.test(attribute.name));
    for (const attribute of ["href", "src"]) {
      const resource = element.getAttribute(attribute);
      if (resource === null) continue;
      assert.ok(element.tagName === "LINK" || element.tagName === "SCRIPT");
      assert.match(resource, /^\.\/(?:stylex\.css|graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css))$/u);
      assert.ok(files.has(`examples/app/${resource.slice(2)}`), "Product shell names an unpublished resource");
    }
  }
  for (const path of stylesheets) {
    const bytes = files.get(path);
    assert.ok(bytes !== undefined && bytes.length > 0);
    const parsed = transform({ filename: path, code: bytes, analyzeDependencies: true, visitor: {
      Rule: { import() { throw new Error("Product CSS contains an uncollected import"); } },
    } });
    assert.equal(parsed.warnings.length, 0);
    assert.deepEqual(parsed.dependencies, [], "Product CSS gained a resource outside its closed compiler graph");
  }
  return { paths, stylesheets, scripts: paths.filter((path) => path.endsWith(".js")) };
}

/** Revalidate each font against its original physical source. Older installed
 * kits supply thirteen faces; the editorial face belongs to the admitted vendor. */
export async function assertSitePublicFontsUnchanged(publicFontRoot: string, presetRoot: string, fonts: ReadonlyMap<string, Buffer>): Promise<void> {
  assert.deepEqual([...fonts.keys()].sort(), [...sitePublicFonts].sort());
  for (const [path, bytes] of fonts) {
    const root = path === sitePresetFont ? presetRoot : publicFontRoot;
    assert.deepEqual(await ordinary(join(root, "fonts", path)), bytes, "Public font input changed during browser acceptance");
  }
}

export function snapshotStaticSite(allFiles: ReadonlyMap<string, Buffer>, publicFonts: ReadonlyMap<string, Buffer>, preset: ReadonlyMap<string, Buffer>) {
  const product = snapshotProductPreview(new Map([...allFiles].filter(([path]) => path.startsWith("examples/app/"))));
  const files = new Map([...allFiles].filter(([path]) => !path.startsWith("examples/app/")));
  assert.deepEqual([...files.keys()].filter((path) => path.endsWith(".html")).sort(), siteRoutes.map(({ path }) => path).sort());
  const stylesheets = siteStylesheetPaths(files);
  assert.deepEqual([...files.keys()].filter((path) => path.endsWith(".css")).sort(), [...stylesheets].sort());
  const foundation = files.get(stylesheets[0]);
  const union = files.get(stylesheets[1]);
  assert.ok(foundation !== undefined && union !== undefined && union.length > 0);
  const { fonts, textures } = siteFoundationResourcePaths(stylesheets[0], foundation);
  assert.deepEqual([...files.keys()].sort(), [...siteRoutes.map(({ path }) => path), ...stylesheets, ...fonts, ...textures, ...sitePublicSupport].sort(), "Static publication contains a missing or unapproved public artifact");
  assert.deepEqual([...files.keys()].filter((path) => /\.woff2?$/u.test(path)).sort(), fonts, "Static font publication is incomplete or redundant");
  assert.deepEqual([...files.keys()].filter((path) => path.startsWith("graphs/")).sort(), [stylesheets[0], ...fonts, ...textures].sort(), "Private graph artifacts escaped publication");
  assert.equal(publicFonts.size, 14);
  assert.deepEqual([...publicFonts.keys()].sort(), [...sitePublicFonts].sort());
  const emitted = fonts.map((path) => {
    const bytes = files.get(path);
    assert.ok(bytes !== undefined && bytes.length > 0 && bytes.length <= 1024 * 1024);
    return digest(bytes);
  }).sort();
  assert.deepEqual(emitted, [...publicFonts.values()].map(digest).sort(), "Published fonts differ from the installed public inputs");
  const presetFont = preset.get(`fonts/${sitePresetFont}`);
  assert.ok(presetFont !== undefined && presetFont.length > 0);
  assert.deepEqual(publicFonts.get(sitePresetFont), presetFont, "Editorial font differs from the admitted snapshot");
  const sourceTextures = sitePresetTextures.map((path) => {
    const bytes = preset.get(path); assert.ok(bytes !== undefined && bytes.length > 0 && bytes.length <= 2 * 1024 * 1024); return digest(bytes);
  }).sort();
  assert.equal(new Set(sourceTextures).size, 2, "Canonical texture identities must be distinct");
  assert.deepEqual(textures.map((path) => { const bytes = files.get(path); assert.ok(bytes !== undefined && bytes.length > 0 && bytes.length <= 2 * 1024 * 1024); return digest(bytes); }).sort(),
    sourceTextures, "Published textures differ from the admitted snapshot");
  for (const [publicPath, sourcePath] of sitePresetAttributions) {
    const bytes = preset.get(sourcePath); assert.ok(bytes !== undefined && bytes.length > 0);
    assert.deepEqual(files.get(publicPath), bytes, "Published attribution differs from the admitted snapshot");
  }
  const parsedUnion = transform({ filename: "stylex.css", code: union, analyzeDependencies: true, visitor: {
    Rule: { import() { throw new Error("Final union contains an uncollected CSS import"); } },
  } });
  assert.equal(parsedUnion.warnings.length, 0, "Final union CSS inspection emitted warnings");
  assert.ok(parsedUnion.dependencies !== undefined);
  assert.equal(parsedUnion.dependencies.length, 0, "Final union contains an unexpected asset URL");
  return { routes: siteRoutes, stylesheets, fonts, textures, product };
}

export function assetContentType(key: string): string {
  if (fontProvenancePaths.has(key)) return "text/plain; charset=utf-8";
  if (siteMarkdownPaths.has(key)) return "text/markdown; charset=utf-8";
  const mime: Readonly<Record<string, string>> = {
    css: "text/css; charset=utf-8", html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8",
    json: "application/json", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon",
    woff: "font/woff", woff2: "font/woff2", txt: "text/plain", xml: "application/xml",
  };
  return mime[key.split(".").at(-1) ?? ""] ?? "application/octet-stream";
}

async function serve(files: ReadonlyMap<string, Buffer>, csp: string, previewCsp?: string, productPreviewCsp?: string): Promise<Surface> {
  const server = await serveBrowserAssets({
    files, csp, ...(previewCsp === undefined ? {} : { previewCsp }),
    ...(productPreviewCsp === undefined ? {} : { productPreviewCsp }), assetPath, contentType: assetContentType,
  });
  return { artifacts: artifacts(files), bytes: files, origin: server.origin, stop: server.stop };
}

/** A readiness message alone is not acceptance. Observe the genuine Direct
 * bridge, fixed clock, native sandbox, and violation counters in the child. */
export function assertProductPreviewObservation(value: unknown, view: ProductView): void {
  const observation = record(value);
  assert.equal(observation.origin, "null", "Product example lost its opaque origin");
  assert.equal(observation.parentAccessible, false);
  assert.equal(observation.ready, "true");
  assert.equal(observation.failed, undefined);
  assert.equal(observation.inert, true);
  assert.equal(observation.now, Date.parse("2026-09-08T12:00:00.000Z"));
  assert.deepEqual(observation.violations, []);
  assert.equal(observation.inline, 0);
  assert.equal(observation.bridgeSchema, "direct.browser-bridge/v2");
  const manifest = record(observation.manifest), active = record(manifest.active), snapshot = record(observation.snapshot);
  assert.equal(manifest.schema, "direct.session-manifest/v1");
  assert.equal(active.source, "scenario");
  assert.equal(active.scenario, `product.${view}`);
  assert.equal(active.route, "/");
  assert.ok(typeof active.activationHash === "string" && /^fnv1a-64:[a-f0-9]{16}$/u.test(active.activationHash));
  assert.equal(snapshot.schema, "direct.probe/v1");
  assert.equal(snapshot.activationHash, active.activationHash);
  assert.equal(snapshot.isQuiescent, true);
  assert.deepEqual(snapshot.activity, { active: 0, started: 0, settled: 0 });
  assert.ok(Object.values(record(snapshot.pending)).every((count) => count === 0));
  assert.deepEqual(snapshot.violations, { "example.blockedFetch": 0, "example.browserActivityError": 0, "example.refusedEffect": 0 });
  assert.deepEqual(observation.stylesheets, [true, true]);
  assert.deepEqual(observation.appearance, { palette: "catppuccin", theme: "dark", menus: 1, ready: false, controls: 2, controlsDisabled: true });
}

async function verifyProductScene(iframe: Locator, view: ProductView): Promise<unknown> {
  assert.equal(await iframe.getAttribute("sandbox"), "allow-scripts");
  assert.equal(await iframe.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(await iframe.getAttribute("tabindex"), "-1");
  assert.equal(await iframe.getAttribute("aria-hidden"), "true");
  const handle = await iframe.elementHandle();
  try {
    const frame = await handle.contentFrame();
    assert.ok(frame !== null);
    await frame.waitForURL((url) => url.pathname === "/examples/app/index.html" && url.search === `?view=${view}`);
    const ready = await frame.waitForFunction(() => {
      if (document.documentElement.dataset.previewFailed !== undefined) throw new Error("Product example reported failure");
      return document.documentElement.dataset.previewReady === "true";
    }, undefined, { polling: "raf", timeout: 15_000 });
    await ready.dispose();
    const observation = await frame.evaluate((selected) => {
      const state = window as typeof window & { __direct?: DirectBrowserBridge; __oompaBrowserViolations?: string[] };
      const bridge = state.__direct;
      if (bridge === undefined) throw new Error("Missing genuine Direct browser bridge");
      let parentAccessible = false;
      try { void window.parent.document; parentAccessible = true; } catch { /* Opaque origin must refuse parent access. */ }
      return { origin: globalThis.origin, parentAccessible, ready: document.documentElement.dataset.previewReady,
        failed: document.documentElement.dataset.previewFailed, inert: document.querySelector(`[data-product-preview="${selected}"]`)?.hasAttribute("inert"),
        now: Date.now(), violations: state.__oompaBrowserViolations, inline: document.querySelectorAll("style,[style]").length,
        bridgeSchema: bridge.schema, manifest: bridge.manifest, snapshot: bridge.snapshot(),
        stylesheets: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => link.sheet !== null && !link.disabled),
        appearance: { palette: document.documentElement.dataset.palette, theme: document.documentElement.dataset.theme,
          menus: document.querySelectorAll("details[data-oompa-appearance]").length,
          ready: document.querySelector('details[data-oompa-appearance][data-ready="true"]') !== null,
          controls: document.querySelectorAll("details[data-oompa-appearance] select").length,
          controlsDisabled: [...document.querySelectorAll<HTMLSelectElement>("details[data-oompa-appearance] select")].every((select) => select.disabled) },
      };
    }, view);
    assertProductPreviewObservation(observation, view);
    if (view === "overview") {
      assert.equal(await frame.locator("[data-session-id]").count(), 3);
      for (const title of ["Polish the checkout", "Choose the export format", "Review the migration"]) {
        assert.equal(await frame.getByText(title, { exact: true }).count(), 1);
      }
    } else {
      if (view === "settings") {
        assert.equal(await frame.locator("h1").textContent(), "Settings");
      } else {
        // A conversation scene is one grid card, whose title is a level-two heading.
        assert.equal(await frame.locator("[data-session-id]").count(), 1);
        assert.equal(await frame.getByRole("heading", { level: 2, name: view === "conversation" ? "Polish the checkout" : "Choose the export format", exact: true }).count(), 1);
        assert.equal(await frame.locator("h1").count(), 0);
      }
      if (view === "conversation") assert.equal(await frame.getByText("The compact layout is in place. I’m checking the empty cart, delivery choices, and payment error state next.", { exact: true }).count(), 1);
      if (view === "question") {
        const question = frame.locator('[aria-label="Pending interaction"]');
        assert.equal(await question.count(), 1);
        assert.ok(await question.getByText("Which format should the export use?", { exact: true }).count() > 0);
        for (const text of ["CSV", "JSON"]) assert.equal(await question.getByText(text, { exact: true }).count(), 1);
      }
      if (view === "settings") {
        assert.ok(await frame.getByText("Studio Mac", { exact: true }).count() > 0);
        assert.ok(await frame.getByText("Linux workstation", { exact: true }).count() > 0);
        assert.ok(await frame.getByText("Sets your active hours. Notification delivery and after-hours automatic-response limits each require separate local opt-in; changing this schedule enables neither.", { exact: true }).count() > 0);
      }
    }
    return observation;
  } finally { await handle.dispose(); }
}

export async function waitForClosedProductPreview(dialog: Pick<Locator, "waitFor">, iframe: Pick<Locator, "waitFor" | "count">): Promise<void> {
  await dialog.waitFor({ state: "hidden" });
  // Native dialog hiding precedes its queued close handler. Observe the handler's
  // actual child cleanup within the existing locator and profile deadlines.
  await iframe.waitFor({ state: "detached" });
  assert.equal(await iframe.count(), 0, "Closed example kept its child browsing context");
}

type CapturedBrowserBody = Promise<{ bytes: Buffer } | { error: unknown }>;

/** Keep resource ownership inside one document's inspection and body settlement. */
export async function withBrowserResourceCapture(
  page: {
    on(event: "response", listener: (response: BrowserResponse) => void): unknown;
    on(event: "request", listener: (request: BrowserRequest) => void): unknown;
    off(event: "response", listener: (response: BrowserResponse) => void): unknown;
    off(event: "request", listener: (request: BrowserRequest) => void): unknown;
  },
  captureResponse: (response: BrowserResponse) => void,
  captureRequest: (request: BrowserRequest) => void,
  inspectDocument: () => Promise<void>,
): Promise<void> {
  page.on("response", captureResponse);
  page.on("request", captureRequest);
  try { await inspectDocument(); }
  finally { page.off("response", captureResponse); page.off("request", captureRequest); }
}

/** Start native reads at response delivery and observe rejections immediately.
 * A renderer's ready signal does not mean its protocol body read has settled. */
export function captureBrowserResponseBody(response: Pick<BrowserResponse, "body">): CapturedBrowserBody {
  return response.body().then((bytes) => ({ bytes }), (error: unknown) => ({ error }));
}

/** Navigation and iframe removal may discard Chromium's response identifiers.
 * Preserve the profile deadline and finish every owned read before either. */
export async function settleBrowserResponseBodies(bodies: readonly CapturedBrowserBody[]): Promise<void> {
  for (const result of await Promise.all(bodies)) {
    if ("error" in result) throw result.error instanceof Error ? result.error : new Error("Native resource body failed", { cause: result.error });
  }
}

async function verifyProductPreviews(page: Page, settleResources: () => Promise<void>): Promise<unknown[]> {
  const figure = page.locator("figure[data-product-preview]");
  assert.equal(await figure.count(), 1);
  assert.equal(await figure.locator("[data-preview-script-notice]").isHidden(), true);
  const iframe = figure.locator("[data-preview-frame]");
  await iframe.scrollIntoViewIfNeeded();
  const observations: unknown[] = [];
  for (const view of productViews) {
    const button = figure.locator(`[data-preview-view="${view}"]`);
    await button.click();
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.equal(await figure.locator('[data-preview-view][aria-pressed="true"]').count(), 1);
    observations.push({ view, observation: await verifyProductScene(iframe, view) });
    await page.waitForFunction(() => document.querySelector("figure[data-product-preview] [data-preview-status]")?.textContent === "");
    await settleResources();
  }
  const enlarge = figure.locator("[data-preview-enlarge]");
  await enlarge.click();
  const dialog = figure.locator("[data-preview-dialog]");
  assert.equal(await dialog.evaluate((element) => element instanceof HTMLDialogElement && element.open && element.matches(":modal")), true);
  observations.push({ view: "settings", enlarged: true, observation: await verifyProductScene(dialog.locator("iframe"), "settings") });
  await page.waitForFunction(() => document.querySelector("[data-preview-dialog] [data-preview-expanded-status]")?.textContent === "");
  assert.equal(await dialog.locator("[data-preview-close]").evaluate((element) => element === document.activeElement), true);
  await settleResources();
  await page.keyboard.press("Escape");
  await waitForClosedProductPreview(dialog, dialog.locator("iframe"));
  assert.equal(await enlarge.evaluate((element) => element === document.activeElement), true);
  await cleanDocument(page);
  return observations;
}

async function verifyDocsSearch(page: Page, origin: string): Promise<void> {
  await page.goto(`${origin}/docs/`);
  const search = page.locator("#docs-search"), results = page.locator("#docs-search-results");
  await search.fill("usage");
  await results.waitFor({ state: "visible" });
  assert.equal(await results.locator('a[href="/docs/sessions/"]').count(), 1);
  await search.fill("no-matching-guide-7f63");
  assert.equal(await results.locator("a").count(), 0);
  assert.equal(await results.textContent(), "No matching guide. Try “login”, “usage”, or “recovery”.");
  await search.press("Escape");
  assert.equal(await search.inputValue(), "");
  assert.equal(await results.isHidden(), true);
  await search.fill("usage");
  await results.locator('a[href="/docs/sessions/"]').click();
  await page.waitForURL(`${origin}/docs/sessions/`);
  assert.equal(await page.locator("h1").textContent(), "Sessions and accounts");
  await cleanDocument(page);
}

async function verifyLegacyDocsRedirects(page: Page, origin: string): Promise<unknown[]> {
  const observations: unknown[] = [];
  for (const [id, destination] of [["install-and-update", "/docs/status/"], ["first-account", "/docs/start/"], ["first-session", "/docs/start/"]] as const) {
    await page.goto(`${origin}/#${id}`);
    await page.waitForURL(`${origin}${destination}#${id}`);
    const section = page.locator(`details#${id}`);
    assert.equal(await section.evaluate((element) => element instanceof HTMLDetailsElement && element.open), true);
    await section.locator("summary").waitFor({ state: "visible" });
    await cleanDocument(page);
    observations.push({ from: `/#${id}`, to: `${destination}#${id}`, opened: true });
  }
  return observations;
}

async function settle(page: Page): Promise<void> {
  await boundedBrowserOperation(page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) => { requestAnimationFrame(() => { requestAnimationFrame(() => { done(); }); }); });
  }), 15_000, "Browser font/frame settlement");
}

type ButtonPlacement = "card-content" | "sign-in-form";

/** Independent product default contract. Paper follows the operating system;
 * deliberately inert product previews keep their fixed Catppuccin dark world. */
export function assertDefaultPalette(value: unknown, forced: boolean,
  appearance: { readonly palette: "paper"; readonly mode: "light" | "dark" } | { readonly palette: "catppuccin"; readonly mode: "dark" } = { palette: "paper", mode: "dark" }): void {
  const sample = record(value);
  const expected = appearance.palette === "catppuccin"
    ? { primary: "#92bafa", foreground: "#dbe1f7", background: "rgb(30, 30, 46)" }
    : appearance.mode === "light"
      ? { primary: "#1e5ae1", foreground: "#1c1917", background: "rgb(248, 247, 244)" }
      : { primary: "#8fb0ff", foreground: "#f5f2ed", background: "rgb(18, 16, 15)" };
  assert.equal(sample.palette, appearance.palette);
  assert.equal(sample.theme, appearance.mode);
  assert.equal(sample.primary, forced ? "Highlight" : expected.primary, "Shared primary semantic color is missing");
  assert.equal(sample.foreground, forced ? "CanvasText" : expected.foreground, "Shared foreground semantic color is missing");
  if (!forced) assert.equal(sample.background, expected.background, "Default palette background differs from its semantic role");
}

async function defaultPalette(page: Page, forced: boolean, mode: "light" | "dark" = "dark", preview = false): Promise<void> {
  assertDefaultPalette(await page.evaluate(() => {
    const root = document.documentElement;
    const css = getComputedStyle(root);
    return {
      palette: root.dataset.palette, theme: root.dataset.theme,
      primary: css.getPropertyValue("--primary").trim(),
      foreground: css.getPropertyValue("--foreground").trim(),
      background: css.backgroundColor,
    };
  }), forced, preview ? { palette: "catppuccin", mode: "dark" } : { palette: "paper", mode });
}

/** Actual compiled surfaces must match independent plain-HTML material roles.
 * The references use the admitted canonical CSS, without inline declarations. */
export function assertSiteMaterialPaint(value: unknown, home: boolean, opaque: boolean): void {
  const string = (input: unknown): string => { assert.ok(typeof input === "string"); return input; };
  const array = (input: unknown): readonly unknown[] => { assert.ok(Array.isArray(input)); return input as unknown[]; };
  const sample = record(value), header = record(sample.header), expected = record(sample.references);
  assert.equal(sample.material, "lantern");
  assert.equal(sample.preset, home ? "editorial" : null);
  assert.equal(sample.walls, home ? 1 : 0);
  assert.equal(sample.fields, 0, "The replaced editorial texture field is still mounted");
  assert.equal(header.background, record(expected.chrome).background, "Compiled header lost canonical material paint");
  assert.equal(header.backdrop, opaque ? "none" : "blur(20px) saturate(1.1)");
  assert.equal(header.backdrop, record(expected.chrome).backdrop);
  const pane = record(expected.pane);
  assert.match(string(pane.background), /^rgb\(\d+, \d+, \d+\)$/u, "Reading plane must be opaque");
  for (const actual of array(sample.panes)) {
    const paint = record(actual);
    assert.equal(paint.background, pane.background, "Compiled reading plane lost its opaque fill");
    assert.equal(paint.ink, pane.ink, "Reading plane lost its matched ink");
  }
  if (home) {
    assert.ok(array(sample.panes).length >= 1);
    const wall = record(sample.wall), reference = record(expected.wall);
    assert.deepEqual(wall, reference, "Compiled hero differs from the canonical wall");
    assert.equal(string(wall.image).includes("url("), false, "Lantern wall must not request texture assets");
    if (opaque) assert.equal(wall.image, "none");
    else {
      assert.equal(string(wall.image).split("repeating-linear-gradient(").length - 1, 2);
      assert.ok(string(wall.image).includes("radial-gradient("));
    }
    assert.equal(array(sample.selected).length, 1);
    for (const [index, actual] of [...array(sample.selected), ...array(sample.disclosures)].entries()) {
      const paint = record(actual), choice = record(expected.choice);
      assert.equal(paint.background, choice.background, `${index === 0 ? "Preview selected control" : "FAQ disclosure"} lost its warm/forced plane: ${JSON.stringify(paint)}`);
      assert.equal(paint.ink, choice.ink, index === 0 ? "Preview selected control lost its matched ink" : "FAQ disclosure lost its matched ink");
    }
    assert.equal(array(sample.disclosures).length, 1, "A real native FAQ must be observed open");
  } else assert.equal(sample.wall, null);
}

export async function readSiteMaterial(page: Page): Promise<unknown> {
  // Native disclosure activation can start even the shared .01ms reduced-motion
  // transition at progress zero. Observe rendered paint, after the existing
  // bounded font/frame settlement; never change styles or relax the comparison.
  await settle(page);
  return page.evaluate(() => {
    const nodes: HTMLElement[] = [];
    const paint = (element: Element | null) => {
      if (element === null) throw new Error("Material surface is missing");
      const css = getComputedStyle(element);
      return { background: css.backgroundColor, ink: css.color, image: css.backgroundImage, backdrop: css.backdropFilter };
    };
    const reference = (role: string, selected = false) => {
      const element = document.createElement("div"); element.hidden = true; element.className = role;
      if (selected) element.setAttribute("data-selected", "");
      document.body.append(element); nodes.push(element); return paint(element);
    };
    try {
      const references = { chrome: reference("hraness-material-chrome"), pane: reference("hraness-material-pane"),
        wall: reference("hraness-material-wall"), choice: reference("hraness-material-choice", true) };
      // Exclude the private reference nodes from actual-role counts.
      const actual = (selector: string) => [...document.querySelectorAll(selector)].filter((element) => !nodes.includes(element as HTMLElement));
      const walls = actual(".hraness-material-wall");
      return { material: document.documentElement.getAttribute("data-hraness-material"), preset: document.documentElement.getAttribute("data-hraness-marketing-preset"),
        walls: walls.length, fields: actual(".hraness-marketing-field").length,
        header: paint(document.querySelector("header.hraness-material-chrome")),
        // The appearance disclosure panel is closed during static-route checks;
        // only the rendered product pane is an owned reading plane here.
        panes: actual("figure[data-product-preview]").map(paint),
        wall: walls.length === 0 ? null : paint(walls[0] ?? null),
        selected: actual('.hraness-material-choice[aria-pressed="true"]').map(paint),
        disclosures: actual(".hraness-marketing-question[open] > summary").map(paint), references };
    } finally { for (const node of nodes) node.remove(); }
  });
}

/** A temporary CDP session can clear emulated features when it detaches.
 * Restore through the owning Playwright page after detachment, including every
 * original media feature, before observing restored paint. */
export async function restoreSiteMaterialMedia(
  page: Pick<Page, "emulateMedia">, session: Pick<CDPSession, "detach">,
  profile: Readonly<{ colorScheme?: "light" | "dark"; reduced: boolean; forced: boolean }>,
): Promise<void> {
  await session.detach();
  await page.emulateMedia({ colorScheme: profile.colorScheme ?? "dark",
    reducedMotion: profile.reduced ? "reduce" : "no-preference", forcedColors: profile.forced ? "active" : "none" });
}

async function verifySiteMaterial(page: Page, pathname: string, profile: Profile): Promise<unknown> {
  if (pathname === "/preview/") {
    assert.equal(await page.locator('[data-hraness-material], .hraness-material-wall, .hraness-marketing-field').count(), 0);
    return { material: null, inertPreviewPreserved: true };
  }
  const home = pathname === "/", summary = page.locator(".hraness-marketing-question > summary").first();
  const previous = await page.evaluateHandle(() => document.activeElement);
  try {
    if (home) {
      assert.equal(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open), false);
      await summary.focus(); await page.keyboard.press("Enter");
      assert.equal(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open), true);
      assert.equal(await summary.evaluate((element) => element.matches(":focus-visible")), true);
    }
    const normal = await readSiteMaterial(page);
    assertSiteMaterialPaint(normal, home, profile.forced);
    if (home) {
      const selected = page.locator('.hraness-material-choice[aria-pressed="true"]');
      const disabled = await selected.getAttribute("disabled");
      try {
        await selected.evaluate((element) => { element.setAttribute("disabled", ""); });
        assertSiteMaterialPaint(await readSiteMaterial(page), true, profile.forced);
      } finally {
        await selected.evaluate((element, previous) => {
          if (previous === null) element.removeAttribute("disabled");
          else element.setAttribute("disabled", previous);
        }, disabled);
      }
      assert.deepEqual(await readSiteMaterial(page), normal, "Disabled control restoration changed actual paint");
    }
    if (home && profile.name === "desktop") {
      const cdp = await page.context().newCDPSession(page);
      const features = [
        { name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "no-preference" },
        { name: "forced-colors", value: "none" },
      ];
      try {
        await cdp.send("Emulation.setEmulatedMedia", { features: [...features, { name: "prefers-reduced-transparency", value: "reduce" }] });
        await settle(page);
        assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-transparency: reduce)").matches), true);
        assertSiteMaterialPaint(await readSiteMaterial(page), true, true);
      } finally {
        try {
          await cdp.send("Emulation.setEmulatedMedia", { features: [...features, { name: "prefers-reduced-transparency", value: "no-preference" }] });
          await settle(page);
        } finally { await restoreSiteMaterialMedia(page, cdp, profile); }
      }
      assert.deepEqual(await readSiteMaterial(page), normal, "Material media restoration changed actual paint");
    }
    return normal;
  } finally {
    if (home) {
      if (await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open)) { await summary.focus(); await page.keyboard.press("Enter"); }
      assert.equal(await summary.evaluate((element) => (element.parentElement as HTMLDetailsElement).open), false);
    }
    try { await previous.evaluate((element) => { if (element instanceof HTMLElement && element.isConnected) element.focus(); }); }
    finally { await previous.dispose(); }
  }
}

/** One real guide exercises the shared control; restore before any later route. */
async function verifyGuideAppearance(page: Page, systemMode: "light" | "dark"): Promise<void> {
  const menu = page.locator("details[data-oompa-appearance]");
  assert.equal(await menu.count(), 1);
  const summary = menu.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  const mode = menu.locator("select[data-oompa-mode]");
  await mode.selectOption("light");
  await page.waitForFunction(() => document.documentElement.dataset.palette === "paper" && document.documentElement.dataset.theme === "light"
    && getComputedStyle(document.documentElement).colorScheme === "light");
  assert.equal(await summary.getAttribute("aria-label"), "Appearance: Paper, Light");
  await mode.selectOption("dark");
  await page.waitForFunction(() => document.documentElement.dataset.theme === "dark"
    && getComputedStyle(document.documentElement).colorScheme === "dark");
  await defaultPalette(page, false);
  const palette = menu.locator("select[data-oompa-palette]");
  await palette.selectOption("gruvbox");
  await page.waitForFunction(() => document.documentElement.dataset.palette === "gruvbox");
  await page.reload();
  await page.waitForFunction(() => document.documentElement.dataset.palette === "gruvbox" && document.documentElement.dataset.theme === "dark");
  assert.equal(await summary.getAttribute("aria-label"), "Appearance: Gruvbox, Dark");
  await summary.focus(); await page.keyboard.press("Enter");
  await palette.selectOption("paper");
  await mode.selectOption("system");
  await page.waitForFunction((expected) => document.documentElement.dataset.palette === "paper" && document.documentElement.dataset.theme === expected, systemMode);
  await defaultPalette(page, false, systemMode);
  await mode.focus();
  await page.keyboard.press("Escape");
  assert.equal(await menu.evaluate((element) => (element as HTMLDetailsElement).open), false);
  assert.equal(await summary.evaluate((element) => document.activeElement === element), true);
}

export function assertAppColorScheme(value: unknown, profile: Pick<Profile, "forced" | "colorScheme">): void {
  const sample = record(value);
  assert.equal(typeof profile.forced, "boolean");
  assert.equal(sample.forced, profile.forced, "Forced-colors media did not match the requested profile");
  assert.equal(sample.forcedColorAdjust, "auto", "App opted out of the user's forced-color palette");
  // CSS Color Adjustment §3.1 forces the computed value to "light dark".
  // Ordinary profiles resolve the product's System default to the requested OS mode.
  assert.equal(sample.colorScheme, profile.forced ? "light dark" : profile.colorScheme ?? "dark", "App color scheme did not match the verified color-adjustment mode");
}

export function assertDefaultButtonPresentation(value: unknown, placement: ButtonPlacement): void {
  const sample = record(value);
  // CSS Display §2.7 blockifies a flex item's outer display. Only the known
  // sign-in form uses this placement; normal-flow controls remain inline-flex.
  assert.equal(sample.parentTag, placement === "sign-in-form" ? "FORM" : "DIV");
  assert.equal(sample.parentDisplay, placement === "sign-in-form" ? "flex" : "block");
  if (placement === "sign-in-form") assert.equal(sample.parentFlexDirection, "column");
  assert.equal(sample.position, "static");
  assert.equal(sample.float, "none");
  assert.equal(sample.display, placement === "sign-in-form" ? "flex" : "inline-flex");
  // The outer display alone cannot prove recipe delivery. These are distinct
  // root/default-size atoms, unchanged by flex-item blockification or colors.
  for (const [property, expected] of Object.entries({
    alignItems: "center", justifyContent: "center", gap: "8px", minHeight: "44px",
    paddingLeft: "16px", paddingRight: "16px", borderTopLeftRadius: "6px",
    fontSize: "14px", lineHeight: "20px", fontWeight: "500",
  })) assert.equal(sample[property], expected, `Default button lost its ${property} recipe`);
  assert.ok(typeof sample.height === "number" && Number.isFinite(sample.height) && sample.height >= 44);
}

async function styled(locator: Locator, placement: ButtonPlacement): Promise<void> {
  await locator.waitFor({ state: "visible" });
  assertDefaultButtonPresentation(await locator.evaluate((element) => {
    const css = getComputedStyle(element);
    const parent = element.parentElement;
    const parentCss = parent === null ? null : getComputedStyle(parent);
    return {
      parentTag: parent?.tagName ?? null, parentDisplay: parentCss?.display ?? null,
      parentFlexDirection: parentCss?.flexDirection ?? null,
      display: css.display, position: css.position, float: css.cssFloat,
      alignItems: css.alignItems, justifyContent: css.justifyContent, gap: css.gap,
      minHeight: css.minHeight, height: element.getBoundingClientRect().height,
      paddingLeft: css.paddingLeft, paddingRight: css.paddingRight,
      borderTopLeftRadius: css.borderTopLeftRadius,
      fontSize: css.fontSize, lineHeight: css.lineHeight, fontWeight: css.fontWeight,
    };
  }), placement);
}

async function cleanDocument(page: Page): Promise<void> {
  assert.equal(await page.locator("[style],style").count(), 0, "Inline presentation escaped the CSP contract");
  const issues = await page.evaluate(() => {
    const state = window as typeof window & { __oompaBrowserViolations?: string[] };
    return state.__oompaBrowserViolations ?? [];
  });
  assert.deepEqual(issues, [], "CSP or inline-style mutation occurred");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Horizontal viewport overflow");
}

/** Browser-realm closure: retain the loaded CSSOM objects, never toggle or
 * rewrite a link resource. All other document sheets must remain unchanged. */
export function loadedStylesheetControl(element: Element, sampleSelector?: string) {
  const document = element.ownerDocument;
  const view = document.defaultView;
  if (view === null || view.document !== document || !(element instanceof view.HTMLLinkElement)
    || !element.isConnected) throw new Error("Missing ordinary stylesheet link.");
  if (sampleSelector !== undefined && (sampleSelector.length === 0 || sampleSelector.length > 1024)) {
    throw new Error("Invalid stylesheet sample selector.");
  }
  const sampleTarget = sampleSelector === undefined ? null : document.querySelector(sampleSelector);
  if (sampleSelector !== undefined && sampleTarget === null) throw new Error("Missing stylesheet sample target.");
  const target = element.sheet;
  const sheets = [...document.styleSheets];
  if (target === null || target.ownerNode !== element || target.disabled
    || target.href !== element.href || new URL(element.href).origin !== view.location.origin
    || sheets.length === 0 || sheets.length > 32 || sheets.filter((sheet) => sheet === target).length !== 1
    || target.cssRules.length === 0) throw new Error("Missing unique loaded same-origin delivery sheet.");
  let characters = 0;
  const snapshots = sheets.map((sheet) => {
    const rules = sheet.cssRules;
    if (rules.length > 65_536) throw new Error("Stylesheet rule inventory exceeded its bound.");
    const entries = [...rules].map((rule) => {
      const text = rule.cssText;
      characters += text.length;
      if (characters > 64 * 1024 * 1024) throw new Error("Stylesheet text inventory exceeded its bound.");
      return { rule, text };
    });
    const owner = sheet.ownerNode;
    return {
      sheet, owner, connected: owner?.isConnected, href: sheet.href, disabled: sheet.disabled, rules, entries,
      markup: owner instanceof view.Element ? owner.outerHTML : null,
    };
  });
  const assertIdentity = (disabled: boolean) => {
    if (sampleSelector !== undefined && (sampleTarget === null || !sampleTarget.isConnected
      || sampleTarget.ownerDocument !== document || document.querySelector(sampleSelector) !== sampleTarget)) {
      throw new Error("Stylesheet sample target changed.");
    }
    const current = [...document.styleSheets];
    if (!element.isConnected || element.ownerDocument !== document || element.sheet !== target || element.href !== target.href
      || current.length !== snapshots.length) throw new Error("Delivery stylesheet identity changed.");
    for (const [index, snapshot] of snapshots.entries()) {
      const { sheet, owner, rules, entries } = snapshot;
      if (current[index] !== sheet || sheet.ownerNode !== owner || owner?.isConnected !== snapshot.connected
        || sheet.href !== snapshot.href || sheet.cssRules !== rules || rules.length !== entries.length
        || (owner instanceof view.Element ? owner.outerHTML : null) !== snapshot.markup
        || sheet.disabled !== (sheet === target ? disabled : snapshot.disabled)) {
        throw new Error("Delivery stylesheet inventory changed.");
      }
      for (const [index, entry] of entries.entries()) {
        if (rules[index] !== entry.rule || entry.rule.cssText !== entry.text) throw new Error("Delivery stylesheet rules changed.");
      }
    }
  };
  assertIdentity(false);
  return {
    sampleTarget,
    disable() {
      assertIdentity(false);
      target.disabled = true;
      assertIdentity(true);
    },
    restore() {
      // Restore the exact captured object even if an unrelated identity check
      // failed. Report the drift afterward; never mutate a replacement sheet.
      target.disabled = false;
      assertIdentity(false);
    },
    assertRestored() { assertIdentity(false); },
  };
}

type RestorationBoundary = Readonly<{ signal: AbortSignal; profileDeadline: number }>;

/** Cover the inclusive mobile breakpoint once per public route in the desktop
 * profile. Reuse the loaded document and sheets; all six profiles still run.
 * Native fragment scrolling is observed, never replaced by a CSS offset fix. */
async function verifyMobileSiteAnchors(page: Page, pathname: "/" | "/privacy/", profile: Profile, boundary: RestorationBoundary): Promise<unknown[]> {
  const samples: unknown[] = [];
  let failure: { error: unknown } | undefined;
  try {
    for (const width of [320, 390, 768, 769, 1440]) {
      assert.equal(boundary.signal.aborted, false, "Browser mobile anchor check cancelled");
      assert.ok(performance.now() < boundary.profileDeadline, "Browser mobile anchor check exceeded its profile deadline");
      await page.setViewportSize({ width, height: profile.height });
      await page.evaluate((path) => {
        history.replaceState(null, "", path);
        window.scrollTo({ left: 0, top: 0, behavior: "instant" });
      }, pathname);
      await settle(page);
      const targetId = pathname === "/" ? "how-it-works" : "privacy";
      await page.evaluate((id) => { location.hash = id; }, targetId);
      // Await the browser's native smooth-scroll destination, including the
      // existing authored scroll margin and end-of-document clamping.
      const scrollSettled = await page.waitForFunction((id) => {
        const target = document.getElementById(id);
        if (target === null) return false;
        const margin = Number.parseFloat(getComputedStyle(target).scrollMarginTop);
        const maximum = Math.max(0, document.documentElement.scrollHeight - innerHeight);
        const destination = Math.min(maximum, Math.max(0, target.getBoundingClientRect().top + scrollY - margin));
        return Number.isFinite(destination) && Math.abs(scrollY - destination) <= 1;
      }, targetId, { polling: "raf", timeout: 5000 });
      await scrollSettled.dispose();
      await settle(page);
      const sample = await page.evaluate((id) => {
        const header = document.querySelector('[data-hraness-marketing="header"]');
        const heading = document.getElementById(`${id}-heading`);
        if (header === null || heading === null) throw new Error("Missing public header or fragment heading");
        const rectangle = (element: Element) => {
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        return { width: innerWidth, height: innerHeight, mobile: matchMedia("(max-width: 48rem)").matches,
          position: getComputedStyle(header).position, header: rectangle(header), heading: rectangle(heading),
          documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, scrollX,
          fragment: location.hash };
      }, targetId);
      assert.equal(sample.width, width);
      assert.equal(sample.height, profile.height);
      assert.equal(sample.mobile, width <= 768, "Mobile header breakpoint changed");
      assert.equal(sample.position, sample.mobile ? "static" : "sticky", "Public header lost mobile flow or desktop stickiness");
      assert.equal(sample.fragment, `#${targetId}`);
      for (const rectangle of [sample.header, sample.heading]) {
        assert.ok(Object.values(rectangle).every(Number.isFinite));
        assert.ok(rectangle.width > 0 && rectangle.height > 0);
      }
      assert.ok(sample.documentWidth <= width + 1 && sample.bodyWidth <= width + 1 && Math.abs(sample.scrollX) <= 1,
        "Public fragment navigation introduced horizontal overflow");
      assert.ok(sample.heading.left >= -1 && sample.heading.right <= width + 1);
      const obscuredUntil = sample.position === "sticky" ? Math.max(0, sample.header.bottom) : 0;
      assert.ok(sample.heading.top >= obscuredUntil - 1 && sample.heading.bottom <= sample.height + 1,
        "Public fragment heading is obscured or outside the viewport");
      samples.push(sample);
    }
  } catch (error) { failure = { error }; }
  try {
    await page.setViewportSize({ width: profile.width, height: profile.height });
    await page.evaluate((path) => {
      history.replaceState(null, "", path);
      window.scrollTo({ left: 0, top: 0, behavior: "instant" });
    }, pathname);
    await settle(page);
  } catch (error) {
    if (failure !== undefined) throw new AggregateError([failure.error, error], "Browser mobile anchor check and restoration failed");
    throw error instanceof Error ? error : new Error("Browser mobile anchor restoration failed", { cause: error });
  }
  if (failure !== undefined) throw failure.error instanceof Error ? failure.error : new Error("Browser mobile anchor check failed", { cause: failure.error });
  return samples;
}

async function negativeStylesheet(page: Page, selector: string, href: string, report: NegativeStylesheetReporter, boundary: RestorationBoundary, foundation = false): Promise<void> {
  const step = <T>(name: NegativeStylesheetSubstep, operation: () => Promise<T>) => browserNegativeStep(name, operation, report);
  const sample = () => page.locator(selector).first().evaluate((element, foundation) => {
    element.getBoundingClientRect();
    const css = getComputedStyle(element);
    return {
      display: css.display, height: css.minHeight, padding: css.paddingLeft, border: css.borderTopWidth, font: css.fontSize,
      ...(foundation ? { boxSizing: css.boxSizing, fontFamily: css.fontFamily, lineHeight: css.lineHeight, backgroundToken: css.getPropertyValue("--background") } : {}),
    };
  }, foundation);
  const before = await step("sample-before", sample);
  const sheet = page.locator(`link[rel="stylesheet"][href="${href}"]`);
  await step("link-count", async () => { assert.equal(await sheet.count(), 1); });
  const loadedSheet = await step("capture", () => sheet.evaluateHandle(loadedStylesheetControl, selector));
  await withBrowserNegativeCleanup(async () => {
    await withBrowserNegativeCleanup(async () => {
      await step("disable", () => loadedSheet.evaluate((state) => state.disable()));
      await step("settle-disabled", () => settle(page));
      await step("sample-disabled", async () => {
        assert.notDeepEqual(await sample(), before, "Negative control did not detect disabled final CSS");
      });
    }, () => step("restore", () => loadedSheet.evaluate((state) => state.restore())), "restore");
    await step("settle-restored", () => settleExactStylesheet({
      expected: before, foundation, signal: boundary.signal, profileDeadline: boundary.profileDeadline,
      operations: {
        assertIdentity: () => loadedSheet.evaluate((state) => state.assertRestored()),
        readPair: (_signal, remainingMs) => loadedSheet.evaluate(readRestoredStyleFramePair, { foundation, remainingMs }),
      },
    }));
    await step("identity-restored", () => loadedSheet.evaluate((state) => state.assertRestored()));
    await step("sample-restored", async () => {
      assert.deepEqual(await sample(), before, "Final CSS did not restore exactly");
      await loadedSheet.evaluate((state) => state.assertRestored());
    });
  }, () => step("dispose", () => loadedSheet.dispose()), "dispose");
}

export function assertNativeModalFocus(value: unknown): void {
  const sample = record(value);
  assert.equal(sample.modal, true, "Dialog lost its native modal state");
  assert.equal(typeof sample.contained, "boolean");
  assert.equal(typeof sample.documentFocused, "boolean");
  // Native dialogs exclude other page controls, but not the browser's own UI.
  // https://www.w3.org/WAI/WCAG21/Techniques/html/H102
  const browserChrome = sample.documentFocused === false
    && sample.activeTag === "BODY" && sample.activeLabel === null;
  assert.ok(sample.contained === true || browserChrome,
    `Native modal allowed focus on background content: ${JSON.stringify(sample)}`);
}

/** The fixture's offset ring is visible below the primary button. Its own
 * Highlight fill is not the paint adjacent to that exposed outline strip. */
export function assertKeyboardFocusStrip(value: unknown, forced: boolean): void {
  try { checkKeyboardFocusStrip(value, forced); }
  catch (error) { throw new FocusStripAssertionError(error, value); }
}

/** Copy only bounded geometry and paint predicates, never DOM text or URLs. */
function focusStripDiagnostics(value: unknown) {
  const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000_000 ? value : null;
  const boolean = (value: unknown) => typeof value === "boolean" ? value : null;
  const tag = (value: unknown) => typeof value === "string" && /^[A-Z][A-Z0-9-]{0,31}$/u.test(value) ? value : null;
  const color = (value: unknown) => typeof value === "string" && value.length <= 100 && /^rgba?\([\d., ]+\)$/u.test(value) ? value : null;
  const overflow = (value: unknown) => typeof value === "string" && ["visible", "hidden", "clip", "scroll", "auto"].includes(value) ? value : null;
  const rectangle = (value: unknown) => Array.isArray(value) && value.length === 4 ? value.map(number) : null;
  const rows = (value: unknown, cap: number) => Array.isArray(value) ? value.slice(0, cap).map(object) : [];
  const sample = object(value);
  const geometry = object(sample.geometry);
  return {
    width: number(sample.width), offset: number(sample.offset), forced: boolean(sample.forced), focusVisible: boolean(sample.focusVisible),
    exposed: boolean(sample.exposed), target: rectangle(geometry.target), targetOpacity: number(geometry.targetOpacity),
    points: rows(geometry.points, 3).map((point) => ({ x: number(point.x), y: number(point.y), hitTag: tag(point.hitTag),
      parentHit: boolean(point.parentHit), targetHit: boolean(point.targetHit), ancestorHit: boolean(point.ancestorHit), siblingHit: boolean(point.siblingHit),
      hitBounds: rectangle(point.hitBounds), hitBackground: color(point.hitBackground), hitOpacity: number(point.hitOpacity), hitImageNone: boolean(point.hitImageNone) })),
    ancestors: rows(geometry.ancestors, 16).map((ancestor) => ({ tag: tag(ancestor.tag), bounds: rectangle(ancestor.bounds),
      opacity: number(ancestor.opacity), imageNone: boolean(ancestor.imageNone), containsStrip: boolean(ancestor.containsStrip),
      background: color(ancestor.background), overflowX: overflow(ancestor.overflowX), overflowY: overflow(ancestor.overflowY) })),
    depthExceeded: boolean(geometry.depthExceeded),
  };
}

class FocusStripAssertionError extends assert.AssertionError {
  readonly diagnostics: ReturnType<typeof focusStripDiagnostics>;
  constructor(error: unknown, sample: unknown) {
    super({ message: error instanceof Error ? error.message : "Keyboard focus strip verification failed" });
    this.diagnostics = focusStripDiagnostics(sample);
  }
}

function checkKeyboardFocusStrip(value: unknown, forced: boolean): void {
  const sample = record(value);
  assert.equal(sample.focusVisible, true, "Keyboard focus did not reach Open sheet");
  assert.equal(sample.forced, forced, "Focus verification lost its native media mode");
  assert.equal(sample.outline, "solid", "Keyboard focus ring is not visible");
  assert.ok(typeof sample.width === "number" && Number.isFinite(sample.width) && sample.width >= 2, "Keyboard focus ring is not visible");
  assert.ok(typeof sample.offset === "number" && Number.isFinite(sample.offset) && sample.offset >= 2, "Focus ring lost its separation from the button fill");
  if (!forced) return;
  assert.equal(sample.exposed, true, "The sampled bottom focus strip is clipped or covered");

  type Color = readonly [number, number, number, number];
  const color = (value: unknown): Color => {
    assert.ok(typeof value === "string" && value.length <= 100, "Missing computed focus color");
    const match = /^rgb(a?)\((\d+(?:\.\d+)?), (\d+(?:\.\d+)?), (\d+(?:\.\d+)?)(?:, (\d+(?:\.\d+)?))?\)$/u.exec(value);
    assert.ok(match !== null && (match[1] === "a") === (match[5] !== undefined), "Unsupported computed focus color");
    const channels: Color = [Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5] ?? 1)];
    assert.ok(channels.every(Number.isFinite) && channels.slice(0, 3).every((channel) => channel >= 0 && channel <= 255)
      && channels[3] >= 0 && channels[3] <= 1, "Invalid computed focus color");
    return channels;
  };
  const over = (foreground: Color, background: Color): Color => [
    foreground[0] * foreground[3] + background[0] * (1 - foreground[3]),
    foreground[1] * foreground[3] + background[1] * (1 - foreground[3]),
    foreground[2] * foreground[3] + background[2] * (1 - foreground[3]), 1,
  ];
  assert.ok(Array.isArray(sample.backgrounds) && sample.backgrounds.length > 0 && sample.backgrounds.length <= 16,
    "Focus strip has no bounded surrounding surface");
  const backgrounds = sample.backgrounds.map(color);
  let surface = backgrounds.pop();
  assert.ok(surface !== undefined && surface[3] === 1, "Focus strip has no opaque background");
  for (const background of backgrounds.reverse()) surface = over(background, surface);
  const luminance = (value: Color): number => value.slice(0, 3).reduce((sum, channel, index) => {
    const normalized = channel / 255;
    return sum + (normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4)
      * ([0.2126, 0.7152, 0.0722][index] ?? 0);
  }, 0);
  const ringLuminance = luminance(over(color(sample.color), surface));
  const surfaceLuminance = luminance(surface);
  const contrast = (Math.max(ringLuminance, surfaceLuminance) + 0.05) / (Math.min(ringLuminance, surfaceLuminance) + 0.05);
  assert.ok(contrast >= 3, `Forced-color focus strip lost contrast (${contrast.toFixed(2)}:1)`);
}

async function primitives(page: Page, profile: Profile, reportNegative: NegativeStylesheetReporter, boundary: RestorationBoundary): Promise<void> {
  const open = page.getByRole("button", { name: "Open dialog", exact: true });
  await styled(open, "card-content");
  await open.focus();
  await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Fixture dialog", exact: true });
  await modal.waitFor({ state: "visible" });
  assert.ok(await modal.evaluate((element) => element.matches(":modal") && element.contains(document.activeElement)));
  const modalBox = await modal.boundingBox();
  assert.ok(modalBox !== null && modalBox.x >= 0 && modalBox.y >= 0);
  assert.ok(Math.abs(modalBox.x + modalBox.width / 2 - profile.width / 2) <= 1, "Dialog is not horizontally centered");
  assert.ok(Math.abs(modalBox.y + modalBox.height / 2 - profile.height / 2) <= 1, "Dialog is not vertically centered");
  for (const key of ["Tab", "Shift+Tab"]) {
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press(key);
      assertNativeModalFocus(await modal.evaluate((element) => ({
        contained: element.contains(document.activeElement), documentFocused: document.hasFocus(),
        activeTag: document.activeElement?.tagName ?? null,
        activeLabel: document.activeElement?.getAttribute("aria-label") ?? null,
        modal: element.matches(":modal"),
      })));
    }
  }
  const modalInput = modal.getByRole("textbox", { name: "Modal text", exact: true });
  await modalInput.focus();
  await open.evaluate((element) => { (element as HTMLElement).focus(); });
  assert.ok(await modalInput.evaluate((element) => document.activeElement === element),
    "Native modal allowed programmatic focus on its inert background");
  await page.keyboard.press("Escape");
  await modal.waitFor({ state: "hidden" });
  assert.ok(await open.evaluate((element) => document.activeElement === element), "Native modal did not restore focus");
  const toggle = page.getByRole("switch", { name: "Fixture switch", exact: true });
  const switchPosition = () => toggle.evaluate((element) => {
    const root = element.getBoundingClientRect();
    const knob = element.firstElementChild?.getBoundingClientRect();
    if (knob === undefined) throw new Error("Switch lost its knob");
    return { x: knob.x, left: root.left, right: root.right, end: knob.right };
  });
  const off = await switchPosition();
  await toggle.focus();
  await page.keyboard.press("Space");
  assert.equal(await toggle.getAttribute("aria-checked"), "true");
  await boundedBrowserOperation(toggle.evaluate(async (element) => {
    await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
  }), 5000, "Switch transition settlement");
  const on = await switchPosition();
  assert.ok(on.x >= on.left && on.end <= on.right, "Checked switch knob escaped its track");
  assert.ok(profile.rtl ? on.x < off.x : on.x > off.x, "Switch did not move toward inline end");
  await page.keyboard.press("Enter");
  assert.equal(await toggle.getAttribute("aria-checked"), "false");
  assert.ok(await page.getByRole("switch", { name: "Disabled switch", exact: true }).isDisabled());
  assert.ok(await page.getByRole("button", { name: "Disabled button", exact: true }).isDisabled());
  await page.getByRole("switch", { name: "Disabled switch", exact: true }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  assert.equal(await page.getByRole("switch", { name: "Disabled switch", exact: true }).getAttribute("aria-checked"), "false");
  const trigger = page.getByRole("button", { name: "Fixture menu", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu");
  await menu.waitFor({ state: "visible" });
  assert.ok(await menu.evaluate((element) => document.activeElement === element));
  const menuAnchor = await menu.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const parent = element.parentElement?.getBoundingClientRect();
    if (parent === undefined) throw new Error("Menu lost its anchor");
    return { left: box.left, right: box.right, parentLeft: parent.left, parentRight: parent.right };
  });
  assert.ok(Math.abs(profile.rtl ? menuAnchor.left - menuAnchor.parentLeft : menuAnchor.right - menuAnchor.parentRight) <= 1, "Menu lost its logical end anchor");
  assert.ok(await page.getByRole("menuitem", { name: "Disabled item" }).isDisabled());
  await page.getByRole("menuitem", { name: "Disabled item" }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  assert.equal(await page.getByLabel("Menu selection").textContent(), "none");
  await page.keyboard.press("Tab");
  assert.ok(await page.getByRole("menuitem", { name: "Select item" }).evaluate((element) => document.activeElement === element));
  await page.keyboard.press("Enter");
  assert.equal(await page.getByLabel("Menu selection").textContent(), "selected");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await menu.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await open.focus();
  await page.keyboard.press("Tab");
  const focused = await page.getByRole("button", { name: "Open sheet", exact: true }).evaluate((element) => {
    const css = getComputedStyle(element);
    const box = element.getBoundingClientRect();
    const width = Number.parseFloat(css.outlineWidth);
    const offset = Number.parseFloat(css.outlineOffset);
    // Side strips can meet the fixture's adjacent buttons. Prove this exposed
    // bottom strip instead, using actual hit testing and its ancestor paint.
    const points = [0.25, 0.5, 0.75].map((fraction) => {
      const x = box.left + box.width * fraction;
      const y = box.bottom + offset + width / 2;
      const hit = document.elementFromPoint(x, y);
      const hitPaint = hit === null ? null : getComputedStyle(hit);
      const hitBounds = hit?.getBoundingClientRect();
      return { x, y, hitTag: hit?.tagName ?? null, parentHit: hit === element.parentElement,
        targetHit: hit === element, ancestorHit: hit !== element && hit?.contains(element) === true,
        siblingHit: hit !== element && hit?.parentElement === element.parentElement,
        hitBounds: hitBounds === undefined ? null : [hitBounds.left, hitBounds.top, hitBounds.right, hitBounds.bottom],
        hitBackground: hitPaint?.backgroundColor ?? null, hitOpacity: hitPaint === null ? null : Number(hitPaint.opacity),
        hitImageNone: hitPaint === null ? null : hitPaint.backgroundImage === "none" };
    });
    let exposed = css.opacity === "1"
      && points.every(({ parentHit }) => parentHit);
    const backgrounds: string[] = [];
    const ancestors = [];
    let depthExceeded = false;
    for (let ancestor = element.parentElement; ancestor !== null; ancestor = ancestor.parentElement) {
      if (backgrounds.length === 16) { exposed = false; depthExceeded = true; break; }
      const paint = getComputedStyle(ancestor);
      const bounds = ancestor.getBoundingClientRect();
      const containsStrip = points.every(({ x, y }) => x >= bounds.left && x < bounds.right && y - width / 2 >= bounds.top && y + width / 2 < bounds.bottom);
      exposed &&= paint.backgroundImage === "none" && paint.opacity === "1" && containsStrip;
      backgrounds.push(paint.backgroundColor);
      ancestors.push({ tag: ancestor.tagName, bounds: [bounds.left, bounds.top, bounds.right, bounds.bottom],
        opacity: Number(paint.opacity), imageNone: paint.backgroundImage === "none", containsStrip,
        background: paint.backgroundColor, overflowX: paint.overflowX, overflowY: paint.overflowY });
    }
    return { outline: css.outlineStyle, width, offset, color: css.outlineColor, backgrounds, exposed,
      geometry: { target: [box.left, box.top, box.right, box.bottom], targetOpacity: Number(css.opacity), points, ancestors, depthExceeded },
      focusVisible: document.activeElement === element && element.matches(":focus-visible"),
      forced: matchMedia("(forced-colors: active)").matches };
  });
  assertKeyboardFocusStrip(focused, profile.forced);
  if (profile.reduced) {
    const duration = await open.evaluate((element) => getComputedStyle(element).transitionDuration);
    assert.ok(duration.split(",").every((part) => Number.parseFloat(part) <= 0.01), "Reduced-motion button transition remains active");
  }
  await page.getByRole("button", { name: "Open sheet", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Fixture sheet", exact: true });
  await sheet.waitFor({ state: "visible" });
  const box = await sheet.boundingBox();
  assert.ok(box !== null && box.width <= profile.width + 1 && box.x >= -1);
  assert.ok(box.y >= 0 && Math.abs(box.y + box.height - profile.height) <= 1, "Bottom sheet lost its viewport anchor");
  assert.ok(Math.abs(box.x) <= 1 && Math.abs(box.x + box.width - profile.width) <= 1, "Bottom sheet lost its full-width edges");
  assert.ok(await sheet.evaluate((element) => element.matches(":modal")));
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Open right sheet", exact: true }).click();
  const rightSheet = page.getByRole("dialog", { name: "Fixture right sheet", exact: true });
  await rightSheet.waitFor({ state: "visible" });
  const right = await rightSheet.boundingBox();
  assert.ok(right !== null && right.x >= 0);
  assert.ok(Math.abs(right.width - Math.min(448, profile.width)) <= 1, "Right sheet lost its declared viewport-bounded width");
  assert.ok(Math.abs(right.y) <= 1 && Math.abs(right.height - profile.height) <= 1, "Right sheet lost its full-height edges");
  assert.ok(Math.abs(right.x + right.width - profile.width) <= 1, "Right sheet changed its physical anchor in RTL");
  await page.keyboard.press("Escape");
  await rightSheet.waitFor({ state: "hidden" });
  await negativeStylesheet(page, "button", "/stylex.css", reportNegative, boundary);
}

async function safeArea(page: Page, origin: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 19, left: 31, bottom: 23, right: 47 } });
    for (const rtl of [false, true]) {
      await page.goto(`${origin}/?view=grid`);
      await page.evaluate((direction) => { document.documentElement.dir = direction; }, rtl ? "rtl" : "ltr");
      await page.getByLabel("Start a new session").waitFor();
      await settle(page);
      const padding = await page.locator("header").evaluate((element) => {
        const css = getComputedStyle(element);
        return [css.paddingTop, css.paddingLeft, css.paddingRight];
      });
      assert.deepEqual(padding, ["31px", "31px", "47px"], "Physical safe-area edges changed with text direction");
      const bottom = await page.locator("main").evaluate((element) => getComputedStyle(element).paddingBottom);
      assert.equal(bottom, "39px");
      await cleanDocument(page);
    }
  } finally {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
    await cdp.detach();
  }
}

/** Serialized as one document initializer. Playwright 1.62.0's built-in block
 * reads navigator.serviceWorker, whose getter throws in opaque frames. Refuse
 * the native registration method without reading or replacing that getter. */
export function installBrowserServiceWorkerRefusal(): void {
  if (typeof ServiceWorkerContainer === "undefined") return;
  const descriptor = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, "register");
  if (descriptor === undefined || typeof descriptor.value !== "function") {
    throw new Error("Browser service-worker registration boundary is unavailable");
  }
  Object.defineProperty(ServiceWorkerContainer.prototype, "register", {
    configurable: false, enumerable: descriptor.enumerable === true, writable: false,
    value: async function register() {
      console.error("Browser acceptance refused service worker registration");
      throw new DOMException("Service workers are disabled during offline browser acceptance", "SecurityError");
    },
  });
}

/** One deliberate rejection, on an inert controlled page before app acceptance.
 * No worker script exists at this path; even a broken refusal cannot activate
 * one. This page has its own exact error expectation, not an app-error waiver. */
async function verifyBrowserServiceWorkerRefusal(page: Page, site: Surface): Promise<void> {
  const errors: string[] = [];
  const workerRequests: string[] = [];
  const note = (values: string[], message: string) => { if (values.length < 8) values.push(message.slice(0, 500)); };
  const sentinel = "/service-worker-negative-control.js";
  assert.equal(site.bytes.has(sentinel.slice(1)), false, "Service-worker control must not name a served script");
  page.on("pageerror", (error) => note(errors, error.message));
  page.on("console", (message) => { if (message.type() === "error") note(errors, message.text()); });
  page.on("request", (request) => { if (new URL(request.url()).pathname === sentinel) note(workerRequests, request.method()); });
  await page.goto(`${site.origin}/preview/`);
  const result = await page.evaluate(async (path) => {
    const descriptor = Object.getOwnPropertyDescriptor(ServiceWorkerContainer.prototype, "register");
    const registrationsBefore = (await navigator.serviceWorker.getRegistrations()).length;
    let rejection: { name: string; message: string } | undefined;
    try { await navigator.serviceWorker.register(path); }
    catch (error) {
      if (!(error instanceof DOMException)) throw error;
      rejection = { name: error.name, message: error.message };
    }
    return { rejection, registrationsBefore, registrationsAfter: (await navigator.serviceWorker.getRegistrations()).length,
      controlled: navigator.serviceWorker.controller !== null, configurable: descriptor?.configurable, writable: descriptor?.writable };
  }, sentinel);
  assert.deepEqual(result, {
    rejection: { name: "SecurityError", message: "Service workers are disabled during offline browser acceptance" },
    registrationsBefore: 0, registrationsAfter: 0, controlled: false, configurable: false, writable: false,
  });
  assert.deepEqual(workerRequests, [], "Service-worker refusal reached the network");
  assert.deepEqual(errors, ["Browser acceptance refused service worker registration"]);
  assert.equal(page.context().serviceWorkers().length, 0, "Service-worker control created an actual worker");
}

async function isolate(context: BrowserContext, origins: ReadonlySet<string>): Promise<Readonly<{ blocked: string[]; errors: string[] }>> {
  const blocked: string[] = [];
  const errors: string[] = [];
  const note = (list: string[], value: string) => {
    if (list.length < 128) list.push(value.slice(0, 500));
    else if (list.length === 128) list.push("Diagnostic limit exceeded");
  };
  assert.equal(context.serviceWorkers().length, 0, "Fresh browser profile has a service worker");
  context.on("serviceworker", () => note(errors, "A service worker started during offline browser acceptance"));
  await context.addInitScript(installBrowserServiceWorkerRefusal);
  context.on("page", (page) => {
    page.on("pageerror", (error) => { note(errors, error.message); });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const url = message.location().url;
      // An intentionally blocked external request has a native network error;
      // keep all CSP/runtime/same-origin errors, even if an external request preceded it.
      if (message.text() === "Failed to load resource: net::ERR_FAILED" && /^https?:\/\//u.test(url) && !origins.has(new URL(url).origin)) return;
      note(errors, message.text());
    });
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (origins.has(url.origin) && ["GET", "HEAD"].includes(route.request().method())) await route.continue();
    else { note(blocked, `${url.protocol}//${url.host}`); await route.abort("failed"); }
  });
  await context.routeWebSocket("**/*", async (socket) => { note(blocked, "websocket"); await socket.close({ code: 1000, reason: "Offline browser acceptance" }); });
  await context.addInitScript(() => {
    const state = window as typeof window & { __oompaBrowserViolations?: string[] };
    const violations: string[] = [];
    state.__oompaBrowserViolations = violations;
    const note = (value: string) => { if (violations.length < 128) violations.push(value.slice(0, 500)); };
    document.addEventListener("securitypolicyviolation", (event) => { note(`${event.violatedDirective}:${event.blockedURI}`); });
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === "attributes" && mutation.attributeName === "style") note("style-attribute-mutation");
        for (const node of mutation.addedNodes) if (node instanceof Element && (node.matches("style,[style]") || node.querySelector("style,[style]") !== null)) note("inline-style-node");
      }
    }).observe(document, { attributes: true, attributeFilter: ["style"], childList: true, subtree: true });
  });
  return { blocked, errors };
}

export async function runAppBrowser(rootDirectory: string, runDirectory: string, signal: AbortSignal,
  admission: BrowserExecutionAdmission, observer?: BrowserCustodyObserver): Promise<void> {
  assertBrowserNode(process.versions);
  const root = await realpath(rootDirectory);
  const run = await realpath(runDirectory);
  const handoff = await admission.verify(admission, root, run);
  const wasCancelled = (): boolean => signal.aborted;
  assert.ok(!wasCancelled(), "Browser acceptance cancelled before driver admission");
  const driverRuntime = { name: "node", version: process.versions.node, executable: await browserExecutable(process.execPath), bundleSha256: handoff.prepared.driver.sha256 };
  assert.deepEqual(driverRuntime.executable, handoff.request.node);
  const executable = process.env.CHROMIUM_EXECUTABLE_PATH;
  assert.ok(executable !== undefined && executable.startsWith("/"), "Set CHROMIUM_EXECUTABLE_PATH to an explicit Chromium executable");
  const executableSha256 = await browserExecutableSha256(executable);
  assert.equal(executableSha256, handoff.request.chromium.sha256);
  const packageBytes = await ordinary(join(root, "package.json"));
  const lockBytes = await ordinary(join(root, "bun.lock"));
  const playwrightPackage = record(JSON.parse(await readFile(new URL(import.meta.resolve("playwright-core/package.json")), "utf8")) as unknown);
  assert.equal(playwrightPackage.version, "1.62.0");
  const { chromium } = await import("playwright-core");
  const appFiles = await inventory(join(root, "app/dist"));
  const siteRoot = join(root, "dist/site");
  const siteDocuments = new Map(await Promise.all(siteRoutes.map(async ({ path }) => [path, await ordinary(join(siteRoot, path))] as const)));
  const [foundationPath] = siteStylesheetPaths(siteDocuments);
  const foundationBytes = await ordinary(join(siteRoot, foundationPath));
  const siteFontPaths = new Set(siteFoundationFontPaths(foundationPath, foundationBytes));
  const siteFiles = await inventory(siteRoot, siteFontPaths);
  for (const [path, bytes] of siteDocuments) assert.deepEqual(siteFiles.get(path), bytes, "Site document changed during graph admission");
  assert.deepEqual(siteFiles.get(foundationPath), foundationBytes, "Site foundation changed during graph admission");
  const publicFontRoot = await realpath(dirname(fileURLToPath(import.meta.resolve("@hraness/design-kit/fonts.css"))));
  const preset = await snapshotMarketingPreset(join(root, "site/vendor/marketing-preset"));
  await checkLanternMaterialSnapshot(join(root, "site/vendor/lantern-material"));
  const publicFonts = new Map(await Promise.all(siteInstalledPublicFonts.map(async (path) => [path, await ordinary(join(publicFontRoot, "fonts", path))] as const)));
  const presetFont = preset.files.get(`fonts/${sitePresetFont}`); assert.ok(presetFont !== undefined);
  publicFonts.set(sitePresetFont, presetFont);
  const siteGraph = snapshotStaticSite(siteFiles, publicFonts, preset.files);
  const appCsp = productionCsp(JSON.parse((await ordinary(join(root, "app/vercel.json"))).toString("utf8")) as unknown, "/(.*)");
  const siteConfiguration: unknown = JSON.parse((await ordinary(join(root, "vercel.json"))).toString("utf8"));
  const { siteCsp, previewCsp, productPreviewCsp } = siteProductionCsp(siteConfiguration);
  const evidence: Evidence[] = [];
  const profileDiagnostics: BrowserProfileDiagnostics[] = [];
  let fixtureArtifacts: readonly Artifact[] = [];
  const servers: Surface[] = [];
  const owner: { current: BrowserContext | null } = { current: null };
  const cancellation = new AbortController();
  const isCancelled = (): boolean => cancellation.signal.aborted;
  // The sole cleanup path takes a fresh census before closing. Do not race it
  // with an unawaited close from a signal callback.
  const onSignal = () => { cancellation.abort(); };
  signal.addEventListener("abort", onSignal, { once: true });
  if (signal.aborted) onSignal();
  let failure: unknown;
  try {
    const fixtureFiles = new Map([...(await inventory(join(run, "fixture/oompa-app")))].filter(([path]) => path !== "stylex-complete.json"));
    assert.deepEqual(artifacts(fixtureFiles), browserPublicArtifacts(handoff.prepared.fixture).filter(({ path }) => path !== "stylex-complete.json"));
    fixtureArtifacts = artifacts(fixtureFiles);
    assert.ok(!isCancelled(), "Browser acceptance cancelled");
    const app = await serve(appFiles, appCsp); servers.push(app);
    const fixture = await serve(fixtureFiles, appCsp); servers.push(fixture);
    observeBrowserCustody(observer, { kind: "partial-servers-owned", run, origins: servers.map(({ origin }) => origin) });
    const site = await serve(siteFiles, siteCsp, previewCsp, productPreviewCsp); servers.push(site);
    for (const profile of profiles) {
      assert.ok(!isCancelled(), "Browser acceptance cancelled");
      const profileStartedAt = performance.now();
      const userData = await mkdtemp(join(run, "profile-"));
      let closed = false;
      let profileFailure: unknown;
      let profileWork: Promise<void> | undefined;
      const pids: number[] = [];
      const diagnostics: BrowserProfileDiagnostics = { name: profile.name, step: "launch", failureStep: undefined, events: [], ownedPids: pids, failure: undefined };
      profileDiagnostics.push(diagnostics);
      const note = (message: string) => { if (diagnostics.events.length === 64) diagnostics.events.shift(); diagnostics.events.push(message.slice(0, 500)); };
      const mark = (step: string) => {
        diagnostics.step = step;
        console.log(browserDiagnosticLine(profile.name, step, diagnostics.failureStep === undefined ? "progress" : "after-failure", undefined, performance.now() - profileStartedAt));
      };
      const negativeReporter = (parent: string): NegativeStylesheetReporter => (step, phase, error) => {
        diagnostics.step = `${parent}:${step}`;
        if (phase === "failed") recordBrowserProfileFailure(diagnostics, error);
        const line = browserDiagnosticLine(profile.name, diagnostics.step, phase, error, performance.now() - profileStartedAt);
        if (phase === "failed") console.error(line);
        else console.log(line);
      };
      try {
        mark("launch");
        const context = await chromium.launchPersistentContext(userData, {
          // The bootstrap owns these signals. Playwright's default handlers
          // would close Chromium concurrently with our cleanup census.
          handleSIGINT: false, handleSIGTERM: false,
          executablePath: executable, headless: true, viewport: { width: profile.width, height: profile.height },
          hasTouch: profile.coarse, isMobile: profile.coarse, deviceScaleFactor: 1,
          reducedMotion: profile.reduced ? "reduce" : "no-preference", forcedColors: profile.forced ? "active" : "none",
          // isolate() installs and proves the getter-free registration refusal
          // before application navigation. The unsafe built-in cannot coexist.
          colorScheme: profile.colorScheme ?? "dark", locale: "en-US", timezoneId: "UTC", permissions: [],
          args: ["--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-first-run"],
          timeout: 30_000,
        });
        owner.current = context;
        assert.ok(!isCancelled(), "Browser acceptance cancelled during launch");
        // A profile-level deadline also covers raw evaluate/CDP promises that
        // are not covered by Playwright's action or navigation timeouts.
        const restorationBoundary = { signal: cancellation.signal, profileDeadline: performance.now() + 120_000 };
        profileWork = (async () => {
        context.setDefaultTimeout(15_000);
        context.setDefaultNavigationTimeout(20_000);
        mark("isolation:install");
        const serviceWorkerControl = await context.newPage();
        const isolation = await isolate(context, new Set(servers.map((server) => server.origin)));
        try {
          mark("isolation:service-worker-refusal");
          await verifyBrowserServiceWorkerRefusal(serviceWorkerControl, site);
          evidence.push({ name: `${profile.name}:service-worker-refusal`, values: { registrations: 0, requests: 0, workers: 0 } });
        } finally { await serviceWorkerControl.close(); }
        mark("page:create");
        const page = await context.newPage();
        page.on("crash", () => note("page-crashed"));
        page.on("close", () => note("page-closed"));
        page.on("requestfailed", (request) => note(`request-failed:${request.resourceType()}:${new URL(request.url()).pathname}:${request.failure()?.errorText ?? "unknown"}`));
        page.on("domcontentloaded", () => note("dom-content-loaded"));
        page.on("load", () => note("page-loaded"));
        const browser = context.browser();
        assert.ok(browser !== null);
        browser.on("disconnected", () => note("browser-disconnected"));
        const browserVersion = browser.version();
        mark("browser-census:connect");
        const browserCdp = await browser.newBrowserCDPSession();
        mark("browser-census:read");
        const census = await browserCdp.send("SystemInfo.getProcessInfo");
        for (const entry of census.processInfo) {
          assert.ok(Number.isSafeInteger(entry.id) && entry.id > 0 && entry.id !== process.pid);
          pids.push(entry.id);
        }
        assert.ok(pids.length > 0);
        mark("browser-census:detach");
        await browserCdp.detach();
        observeBrowserCustody(observer, { kind: "browser-census-owned", run, origins: servers.map(({ origin }) => origin), pids });
        mark("production-anonymous:navigation");
        await page.goto(app.origin);
        mark("production-anonymous:assertions");
        await page.getByRole("heading", { name: "Sign in to Oompa" }).waitFor();
        assert.deepEqual(await page.evaluate(() => ({
          coarse: matchMedia("(pointer: coarse)").matches,
          reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
          forced: matchMedia("(forced-colors: active)").matches,
        })), { coarse: profile.coarse, reduced: profile.reduced, forced: profile.forced });
        await styled(page.getByRole("button", { name: "Send code", exact: true }), "sign-in-form");
        assertAppColorScheme(await page.evaluate(() => {
          const css = getComputedStyle(document.documentElement);
          return {
            forced: matchMedia("(forced-colors: active)").matches,
            colorScheme: css.colorScheme, forcedColorAdjust: css.forcedColorAdjust,
          };
        }), profile);
        await defaultPalette(page, profile.forced, profile.colorScheme ?? "dark");
        await cleanDocument(page);
        mark("production-anonymous:negative-css");
        await negativeStylesheet(page, "button", "/stylex.css", negativeReporter("production-anonymous:negative-css"), restorationBoundary);
        evidence.push({ name: `${profile.name}:production-anonymous`, values: { browserVersion, finalCssSha256: digest(appFiles.get("stylex.css") ?? "") } });
        for (const view of fixtureViews) {
          assert.ok(!isCancelled(), "Browser acceptance cancelled");
          mark(`fixture:${view}:navigation`);
          await page.goto(`${fixture.origin}/?view=${view}`);
          mark(`fixture:${view}:assertions`);
          await page.evaluate((direction) => { document.documentElement.dir = direction; }, profile.rtl ? "rtl" : "ltr");
          await page.locator("#root button").first().waitFor();
          await settle(page);
          await cleanDocument(page);
          await defaultPalette(page, profile.forced, profile.colorScheme ?? "dark");
          if (view === "grid") {
            const usage = page.getByRole("button", { name: "Codex usage unknown. Open usage history.", exact: true });
            assert.ok(await usage.isVisible(), "Partial historical usage must remain unknown on the grid");
            assert.equal(await usage.locator("meter").count(), 0);
            await usage.click();
            assert.equal(new URL(page.url()).hash, "#/settings/usage");
            const cards = page.locator("[data-session-id]");
            assert.equal(await cards.count(), 3);
            const before = await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-session-id")));
            await cards.first().getByRole("button", { name: /^Reorder /u }).focus();
            await page.keyboard.press("ArrowRight");
            await settle(page);
            assert.deepEqual(await cards.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-session-id"))), [before[1], before[0], before[2]], "Keyboard card ordering did not preserve the displayed permutation");
            assert.ok(await page.getByLabel("Start a new session").isEnabled());
            assert.ok(await page.getByRole("button", { name: "Start", exact: true }).isDisabled());
            await page.getByLabel("Start a new session").fill("Run `bun test src/value.test.ts` and report the exit status.");
            assert.ok(await page.getByText(/Automatic effort: Max for this simple prompt\./u).isVisible());
            await page.getByLabel("Start a new session").fill("Fixture prompt only");
            assert.ok(await page.getByRole("button", { name: "Start", exact: true }).isEnabled());
            assert.ok(await page.getByText(/Automatic effort: Ultra\./u).isVisible());
          }
          if (view === "session" || view === "session-long" || view === "retired") {
            assert.ok(await page.getByRole("heading", { name: "Browser fixture session", exact: true }).isVisible());
            // Older responses fold to one summary line; only the newest stays open.
            assert.ok(await page.getByText(view === "session-long"
              ? "Fixture transcript: compiled presentation and native controls."
              : "compiled presentation", { exact: true }).isVisible());
            const bubble = await page.getByText("Review the browser fixture", { exact: true }).evaluate((element) => {
              const css = getComputedStyle(element);
              return { left: css.borderTopLeftRadius, right: css.borderTopRightRadius };
            });
            assert.deepEqual(bubble, profile.rtl ? { left: "2px", right: "8px" } : { left: "8px", right: "2px" }, "User bubble lost its logical start-end corner");
            const gutter = await page.locator("ul").first().evaluate((element) => {
              const css = getComputedStyle(element);
              return { left: css.paddingLeft, right: css.paddingRight };
            });
            assert.deepEqual(gutter, profile.rtl ? { left: "0px", right: "20px" } : { left: "20px", right: "0px" }, "Markdown list gutter did not follow inline start");
            for (const name of ["Attach a file", "Message this session", "Stop the turn"]) {
              assert.equal(await page.getByLabel(name, { exact: true }).isDisabled(), view === "retired");
            }
            assert.equal(await page.getByLabel("Message this session", { exact: true }).evaluate((element) => element.tagName), "TEXTAREA");
            await page.getByRole("button", { name: /^Session actions for /u }).click();
            const settingsItem = page.getByRole("menuitem", { name: "Approvals and provider", exact: true });
            await settingsItem.waitFor({ state: "visible" });
            if (view === "retired") {
              assert.ok(await settingsItem.isDisabled(), "Retired session still offers its settings sheet");
              await page.keyboard.press("Escape");
            } else {
              await settingsItem.click();
              await page.getByRole("dialog").waitFor({ state: "visible" });
              await page.keyboard.press("Escape");
              await page.getByRole("dialog").waitFor({ state: "hidden" });
            }
            if (view === "session-long") {
              const quote = await page.locator("blockquote").first().evaluate((element) => {
                const css = getComputedStyle(element);
                return { left: css.borderLeftWidth, right: css.borderRightWidth, paddingLeft: css.paddingLeft, paddingRight: css.paddingRight };
              });
              assert.deepEqual(quote, profile.rtl
                ? { left: "0px", right: "2px", paddingLeft: "0px", paddingRight: "12px" }
                : { left: "2px", right: "0px", paddingLeft: "12px", paddingRight: "0px" }, "Markdown quote gutter did not follow inline start");
              const collapsed = await page.getByRole("button", { expanded: false }).filter({ hasText: "Transcript row" }).count();
              assert.ok(collapsed > 0, "Older responses did not start collapsed");
              const scroll = await page.getByRole("log", { name: /^Conversation of /u }).evaluate((target) => {
                if (!(target instanceof HTMLElement)) return null;
                target.scrollTop = 0;
                const start = target.scrollTop;
                target.scrollTop = target.scrollHeight;
                return { start, end: target.scrollTop, viewport: target.clientHeight, content: target.scrollHeight,
                  overflow: getComputedStyle(target).overflowY, screen: innerHeight };
              });
              assert.ok(scroll !== null && scroll.start === 0 && scroll.end > 0 && scroll.content > scroll.viewport && scroll.overflow === "auto");
              assert.ok(scroll.viewport <= scroll.screen * 0.6 + 1, "Long history escaped its bounded conversation scroller");
              assert.ok(await page.getByLabel("Message this session", { exact: true }).isVisible());
            }
          }
          if (view === "settings") {
            assert.ok(await page.getByRole("heading", { name: "Settings", exact: true }).isVisible());
            const usageHistory = page.locator("#usage");
            assert.ok(await usageHistory.getByRole("heading", { name: "Usage history", exact: true }).isVisible());
            assert.ok(await usageHistory.getByText("62% left in the last daily report.", { exact: true }).isVisible());
            assert.ok(await usageHistory.getByText("The latest report is stale, expired or incomplete; usage unknown.", { exact: true }).isVisible());
            const report = usageHistory.locator("details").first();
            await report.locator("summary").click();
            assert.ok(await report.getByText(/38% used when reported · reset scheduled for/u).isVisible());
            const automaticEffort = page.getByRole("switch", { name: "Automatic effort", exact: true });
            assert.equal(await automaticEffort.getAttribute("aria-checked"), "true");
            await automaticEffort.click();
            assert.equal(await automaticEffort.getAttribute("aria-checked"), "false");
            await page.reload();
            await automaticEffort.waitFor();
            assert.equal(await automaticEffort.getAttribute("aria-checked"), "false", "Automatic effort disable did not survive reload");
            await page.goto(`${fixture.origin}/?view=grid`);
            await page.getByLabel("Start a new session").fill("Run `bun test src/value.test.ts` and report the exit status.");
            assert.ok(await page.getByText(/Automatic effort is off: Ultra\./u).isVisible());
            await page.goto(`${fixture.origin}/?view=settings`);
            await automaticEffort.waitFor();
            await automaticEffort.click();
            assert.equal(await automaticEffort.getAttribute("aria-checked"), "true");
            await page.evaluate((direction) => { document.documentElement.dir = direction; }, profile.rtl ? "rtl" : "ltr");
            await settle(page);
            assert.ok((await page.getByText("Fixture machine", { exact: true }).count()) > 0);
            assert.ok(await page.getByText("Last reported Codex default", { exact: true }).isVisible());
            assert.ok(await page.getByText(
              "gpt-6-astra / ultra. Reported configuration only, not session state or runtime capability.",
              { exact: true },
            ).isVisible());
          }
          if (view === "primitives") await primitives(page, profile, negativeReporter("fixture:primitives:negative-css"), restorationBoundary);
          await cleanDocument(page);
          if (view === "grid" || view === "session" || view === "settings" || view === "primitives") {
            mark(`fixture:${view}:screenshot`);
            await page.screenshot({ path: join(run, `${profile.name}-${view}.png`), fullPage: false });
          }
          evidence.push({ name: `${profile.name}:fixture:${view}`, values: "passed" });
        }
        if (profile.name === "desktop") {
          mark("asymmetric-safe-area");
          await safeArea(page, fixture.origin);
          evidence.push({ name: "asymmetric-safe-area:ltr+rtl", values: { top: 19, left: 31, bottom: 23, right: 47 } });
        }
        for (const route of siteGraph.routes) {
          const routeLabel = route.label;
          const responses: { response: BrowserResponse; body: CapturedBrowserBody }[] = [];
          const productRequests: BrowserRequest[] = [];
          const productResponses: { response: BrowserResponse; body: CapturedBrowserBody }[] = [];
          let responseOverflow = false;
          const capture = (response: BrowserResponse) => {
            if (response.request().frame() !== page.mainFrame()) {
              // Capture bytes while this child document still exists. Scene
              // changes and closing the enlarged modal legitimately detach it.
              if (productResponses.length < 256) productResponses.push({ response,
                body: captureBrowserResponseBody(response) });
              else responseOverflow = true;
              return;
            }
            const resourceUrl = new URL(response.url());
            if (resourceUrl.origin !== site.origin || (!["stylesheet", "font"].includes(response.request().resourceType()) && !siteGraph.textures.includes(resourceUrl.pathname.slice(1)))) return;
            if (responses.length < 64) responses.push({ response, body: captureBrowserResponseBody(response) });
            else responseOverflow = true;
          };
          const captureProduct = (request: BrowserRequest) => {
            if (request.frame() === page.mainFrame()) return;
            if (productRequests.length < 256) productRequests.push(request);
            else responseOverflow = true;
          };
          const settleResources = () => settleBrowserResponseBodies([...responses, ...productResponses].map(({ body }) => body));
          await withBrowserResourceCapture(page, capture, captureProduct, async () => {
            mark(`static-site:${routeLabel}:navigation`);
            const response = await page.goto(`${site.origin}${route.pathname}`);
            assert.ok(response !== null);
            assert.equal(response.status(), 200);
            assert.equal(response.headers()["content-security-policy"], route.pathname === "/preview/" ? previewCsp : siteCsp);
            const documentBytes = siteFiles.get(route.path);
            assert.ok(documentBytes !== undefined);
            mark(`static-site:${routeLabel}:document-bytes`);
            assert.deepEqual(await response.body(), documentBytes, "Native document differs from the completed output");
            mark(`static-site:${routeLabel}:direction`);
            await page.evaluate((direction) => { document.documentElement.dir = direction; }, profile.rtl ? "rtl" : "ltr");
            mark(`static-site:${routeLabel}:heading`);
            await page.locator(route.heading).waitFor({ state: "visible" });
            mark(`static-site:${routeLabel}:settle-before-fonts`);
            await settle(page);
            mark(`static-site:${routeLabel}:font-load`);
            const fonts = await page.evaluate(async () => {
              const faces = [...document.fonts];
              if (faces.length !== 14) throw new Error("Native font-face inventory is incomplete");
              await Promise.all(faces.map((face) => face.load()));
              return faces.map((face) => ({ family: face.family, style: face.style, weight: face.weight, status: face.status }));
            });
            assert.ok(fonts.every(({ status }) => status === "loaded"), "A public font did not load natively under font-src self");
            mark(`static-site:${routeLabel}:settle-after-fonts`);
            await settle(page);
            if (profile.name === "desktop" && (route.pathname === "/" || route.pathname === "/privacy/")) {
              mark(`static-site:${routeLabel}:mobile-anchors`);
              const anchors = await verifyMobileSiteAnchors(page, route.pathname, profile, restorationBoundary);
              evidence.push({ name: `desktop:static-site:${route.path}:mobile-anchors`, values: anchors });
            }
            mark(`static-site:${routeLabel}:document-clean`);
            await cleanDocument(page);
            mark(`static-site:${routeLabel}:stylesheet-links`);
            assert.deepEqual(await page.locator('link[rel="stylesheet"]').evaluateAll((links) => links.map((link) => link.getAttribute("href"))), siteGraph.stylesheets.map((path) => `/${path}`));
            mark(`static-site:${routeLabel}:stylesheet-inventory`);
            assert.deepEqual(await page.evaluate(() => [...document.styleSheets].map((sheet) => ({ href: sheet.href, disabled: sheet.disabled, rules: sheet.cssRules.length > 0 }))),
              siteGraph.stylesheets.map((path) => ({ href: `${site.origin}/${path}`, disabled: false, rules: true })));
            mark(`static-site:${routeLabel}:color-scheme`);
            assert.equal(await page.evaluate(() => matchMedia("(prefers-color-scheme: light)").matches), profile.colorScheme === "light");
            mark(`static-site:${routeLabel}:background`);
            await defaultPalette(page, profile.forced, profile.colorScheme ?? "dark", route.pathname === "/preview/");
            mark(`static-site:${routeLabel}:heading-style`);
            assert.ok(await page.locator(route.heading).evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize) > 24));
            mark(`static-site:${routeLabel}:inertness`);
            if (route.pathname === "/preview/") assert.equal(await page.locator("a,button,input,select,textarea,form,script,iframe").count(), 0, "Preview gained an action or script");
            const countBeforeNegative = responses.length;
            mark(`static-site:${routeLabel}:negative-final-css`);
            await negativeStylesheet(page, route.heading, `/${siteGraph.stylesheets[1]}`, negativeReporter(`static-site:${routeLabel}:negative-final-css`), restorationBoundary);
            mark(`static-site:${routeLabel}:negative-foundation-css`);
            await negativeStylesheet(page, "html", `/${siteGraph.stylesheets[0]}`, negativeReporter(`static-site:${routeLabel}:negative-foundation-css`), restorationBoundary, true);
            mark(`static-site:${routeLabel}:negative-document-clean`);
            await cleanDocument(page);
            assert.equal(responses.length, countBeforeNegative, "Stylesheet application control reloaded a resource");
            if (route.pathname === "/") {
              mark("static-site:home:product-previews");
              evidence.push({ name: `${profile.name}:product-previews`, values: await verifyProductPreviews(page, settleResources) });
            } else {
              const figure = page.locator("figure[data-product-preview]");
              const count = await figure.count();
              assert.ok(count === 0 || count === 1);
              if (count === 1) {
                // Exercise each guide's actual lazy default scene before leaving
                // its document, not just the homepage's four selectable scenes.
                const view = await figure.getAttribute("data-view");
                assert.ok(productViews.some((candidate) => candidate === view));
                const iframe = figure.locator("[data-preview-frame]");
                await iframe.scrollIntoViewIfNeeded();
                evidence.push({ name: `${profile.name}:static-site:${route.path}:product-preview`,
                  values: await verifyProductScene(iframe, view as ProductView) });
                await page.waitForFunction(() => document.querySelector("figure[data-product-preview] [data-preview-status]")?.textContent === "");
              }
            }
            mark(`static-site:${routeLabel}:material`);
            evidence.push({ name: `${profile.name}:static-site:${route.path}:material`, values: await verifySiteMaterial(page, route.pathname, profile) });
            assert.equal(responseOverflow, false, "Static resource census exceeded its bound");
            mark(`static-site:${routeLabel}:resource-bytes`);
            await settleResources();
            assert.equal(productRequests.length, productResponses.length, "Product document left an incomplete resource request");
            const delivered = await Promise.all(responses.map(async ({ response: resource, body }) => {
              const key = assetPath(new URL(resource.url()).pathname, siteFontPaths);
              assert.ok(key !== null && siteFiles.has(key));
              assert.equal(resource.status(), 200);
              assert.equal(resource.headers()["content-type"], assetContentType(key));
              assert.equal(resource.headers()["x-content-type-options"], "nosniff");
              const result = await body;
              if ("error" in result) throw result.error instanceof Error ? result.error : new Error("Native resource body failed", { cause: result.error });
              const bytes = result.bytes;
              assert.deepEqual(bytes, siteFiles.get(key), "Native resource differs from its retained output identity");
              return { path: key, bytes: bytes.length, sha256: digest(bytes) };
            }));
            // The finite artifact graph still admits both editorial SVGs, but
            // no document mounts their replaced field. Lantern has no URL assets.
            assert.deepEqual(delivered.map(({ path }) => path).sort(), [...siteGraph.stylesheets, ...siteGraph.fonts].sort(), "Native CSS/font linkage was incomplete or a replaced texture was requested");
            for (const request of productRequests) {
              const url = new URL(request.url()), key = url.pathname.slice(1);
              assert.equal(url.origin, site.origin, "A product frame requested an external resource");
              assert.equal(request.method(), "GET");
              assert.ok(siteGraph.product.paths.includes(key), "Product frame escaped its public compiler graph");
              assert.equal(request.resourceType(), key.endsWith(".html") ? "document" : key.endsWith(".js") ? "script" : "stylesheet", "Product example attempted non-resource IO");
              if (key.endsWith(".html")) assert.ok(productViews.some((view) => url.search === `?view=${view}`));
              else assert.equal(url.search, "");
            }
            const productDelivered = await Promise.all(productResponses.map(async ({ response: resource, body }) => {
              const key = new URL(resource.url()).pathname.slice(1);
              assert.ok(siteGraph.product.paths.includes(key));
              assert.equal(resource.status(), 200);
              assert.equal(resource.headers()["content-security-policy"], productPreviewCsp);
              assert.equal(resource.headers()["access-control-allow-origin"], "*");
              assert.equal(resource.headers()["access-control-allow-credentials"], undefined);
              assert.equal(resource.headers()["x-frame-options"], undefined);
              assert.equal(resource.headers()["content-type"], assetContentType(key));
              assert.equal(resource.headers()["x-content-type-options"], "nosniff");
              const result = await body;
              if ("error" in result) throw result.error instanceof Error ? result.error : new Error("Product resource body failed", { cause: result.error });
              const bytes = result.bytes;
              assert.deepEqual(bytes, siteFiles.get(key), "Product resource differs from its completed output");
              return { path: key, sha256: digest(bytes) };
            }));
            evidence.push({ name: `${profile.name}:static-site:${route.path}:product-resources`, values: { requests: productRequests.length, delivered: productDelivered } });
            evidence.push({ name: `${profile.name}:static-site:${route.path}`, values: { documentSha256: digest(documentBytes), fonts, delivered: delivered.sort((a, b) => a.path.localeCompare(b.path)) } });
          });
          if (profile.name === "desktop" && route.pathname === "/docs/reference/") {
            // Persistence reloads the guide. Finish the exact per-document resource
            // census first so the second document cannot masquerade as duplicates.
            mark("static-site:docs-reference:appearance-menu");
            await verifyGuideAppearance(page, profile.colorScheme ?? "dark");
            evidence.push({ name: "desktop:docs-reference:appearance-menu", values: "light, dark, saved palette reload, System restoration, Escape, and focus passed" });
          }
        }
        if (profile.name === "desktop") {
          mark("static-site:docs:search");
          await verifyDocsSearch(page, site.origin);
          evidence.push({ name: "desktop:docs-search", values: "matched, empty, Escape, and navigation passed" });
          mark("static-site:docs:legacy-redirects");
          evidence.push({ name: "desktop:legacy-docs-redirects", values: await verifyLegacyDocsRedirects(page, site.origin) });
        }
        mark("isolation:assertions");
        assert.deepEqual(isolation.errors, [], "Browser runtime or resource failure");
        assert.equal(context.serviceWorkers().length, 0, "An actual service worker survived browser acceptance");
        evidence.push({ name: `${profile.name}:isolation`, values: { blocked: [...new Set(isolation.blocked)].sort(), cspErrors: 0, runtimeErrors: 0, serviceWorkers: 0 } });
        })();
        await boundedBrowserOperation(profileWork, 120_000, `Browser profile ${profile.name}`, cancellation.signal);
      } catch (error) {
        profileFailure = error;
        recordBrowserProfileFailure(diagnostics, error);
        console.error(browserDiagnosticLine(profile.name, diagnostics.failureStep, "failed", error, performance.now() - profileStartedAt));
      } finally {
        if (owner.current !== null) {
          try {
            mark("cleanup");
            await closeOwnedBrowser(owner.current, pids);
            // Closing the owned browser rejects outstanding renderer work.
            // Do not remove its profile while the operation remains unsettled.
            if (profileWork !== undefined) await boundedBrowserOperation(profileWork.catch(() => undefined), 5000, "Browser profile task settlement");
            owner.current = null;
            closed = true;
            evidence.push({ name: `${profile.name}:browser-cleanup`, values: { ownedProcesses: pids.length, survivors: 0, pages: 0 } });
          } catch (error) {
            recordBrowserProfileFailure(diagnostics, error);
            console.error(browserDiagnosticLine(profile.name, "cleanup", "cleanup-failed", error, performance.now() - profileStartedAt));
            profileFailure = profileFailure === undefined ? error : new AggregateError([profileFailure, error], "Browser profile and cleanup failed");
          }
        }
        // Only this run's fresh browser profile, and only after close completed.
        // Finalized fixture outputs and receipts are deliberately retained.
        if (closed) {
          assert.equal(dirname(userData), run);
          assert.equal(await realpath(userData), userData);
          await rm(userData, { recursive: true });
        }
      }
      if (profileFailure !== undefined) throw profileFailure instanceof Error
        ? profileFailure : new Error("Browser profile failed", { cause: profileFailure });
      mark("complete");
    }
    assert.deepEqual(artifacts(await inventory(join(root, "app/dist"))), artifacts(appFiles));
    assert.deepEqual(artifacts(await inventory(siteRoot, siteFontPaths)), artifacts(siteFiles));
    await assertSitePublicFontsUnchanged(publicFontRoot, join(root, "site/vendor/marketing-preset"), publicFonts);
    assert.deepEqual(await ordinary(join(root, "package.json")), packageBytes);
    assert.deepEqual(await ordinary(join(root, "bun.lock")), lockBytes);
    assert.deepEqual(await admission.verify(admission, root, run), handoff, "Browser preparation changed during acceptance");
    assert.ok(!isCancelled(), "Browser acceptance cancelled");
  } catch (error) { failure = error; }
  finally {
    try {
      // A failed collection leaves its profile and receipt for recovery. Closing
      // the context again cannot retroactively prove the missing process census.
      if (owner.current !== null) await boundedBrowserOperation(owner.current.close(), 20_000, "Final browser close");
    } catch (error) {
      failure = failure === undefined ? error : new AggregateError([failure, error], "Browser gate and final close failed");
    } finally {
      for (const server of servers) {
        try { await boundedBrowserOperation(server.stop(), 5000, "Browser fixture server stop"); }
        catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser gate and server cleanup failed"); }
      }
      try { await admission.verify(admission, root, run); }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], "Browser gate and execution admission postflight failed"); }
      signal.removeEventListener("abort", onSignal);
      const receipt = {
        schemaVersion: 2, kind: "hra-app-browser-acceptance", state: failure === undefined && !isCancelled() ? "passed" : "failed",
        browserExecutableSha256: executableSha256, playwright: "1.62.0", buildRuntime: handoff.prepared.buildRuntime, driverRuntime,
        preparationSha256: browserDigest(JSON.stringify(handoff.prepared)),
        executionAdmission: admission.evidence,
        packageSha256: digest(packageBytes), lockSha256: digest(lockBytes),
        app: artifacts(appFiles), site: artifacts(siteFiles), fixture: fixtureArtifacts,
        appCspSha256: digest(appCsp), siteCspSha256: digest(siteCsp), previewCspSha256: digest(previewCsp), productPreviewCspSha256: digest(productPreviewCsp),
        sitePublicFonts: artifacts(publicFonts),
        siteMarketingPreset: { sourceCommit: preset.sourceCommit, inputs: artifacts(preset.files), textures: siteGraph.textures },
        fixtureIoAliases: ["@convex-dev/auth/react", ...browserIoModules], productIoAliases: ["@convex-dev/auth/react", ...productIoModules], evidence,
        profileDiagnostics, ...(failure === undefined ? {} : { failure: browserFailureDetails(failure) }),
      };
      // The bootstrap joins this result with child collection and the terminal
      // cancellation latch before publishing the CI-facing receipt.json.
      await publishBrowserJson(join(run, "driver-receipt.json"), receipt);
      console.log(`Browser driver ${receipt.state}; ${evidence.length} evidence rows; awaiting bootstrap settlement`);
    }
  }
  assert.ok(!isCancelled(), "Browser acceptance cancelled");
  if (failure !== undefined) throw failure instanceof Error
    ? failure : new Error("Browser acceptance failed", { cause: failure });
}
