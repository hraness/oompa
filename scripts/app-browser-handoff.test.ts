import { expect, test } from "bun:test";
import * as fc from "fast-check";
import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertBrowserNode, browserDigest, browserExecutable, browserFile, browserInventory, browserLogicalPath, browserSources,
  parseBrowserPrepared, parseBrowserRequest, publishBrowserJson, publishBrowserTerminalJson,
  readBrowserFile, verifyBrowserInventory, verifyBrowserRequest,
  type BrowserPrepared, type BrowserRequest,
} from "./app-browser-handoff.ts";

const row = { path: "file.ts", bytes: 4, sha256: "a".repeat(64), identity: [1, 2, 33152, 1, 4, 10, 10] };
const executable = { path: "/fixture/runtime", sha256: "b".repeat(64) };
const request = (): BrowserRequest => ({ schemaVersion: 1, kind: "hra-browser-preparation-request", root: "/fixture/repository", run: "/fixture/repository/tmp/app-browser-ABC123",
  node: executable, bun: executable, chromium: executable, sources: [row], app: [row], site: [row] });
const segment = fc.array(fc.constantFrom(...Array.from("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-[]")), { maxLength: 12 })
  .map((characters) => `s${characters.join("")}`);
const logicalPath = fc.array(segment, { minLength: 1, maxLength: 5 }).map((parts) => parts.join("/"));
const artifactRows = fc.uniqueArray(fc.record({ path: logicalPath, bytes: fc.integer({ min: 0, max: 4096 }) }), { selector: (value) => value.path, minLength: 1, maxLength: 12 })
  .map((values) => values.map(({ path, bytes }) => ({ ...row, path, bytes, identity: [1, 2, 33152, 1, bytes, 10, 10] }))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

test("browser source capture binds every product fixture input without weakening existing app inputs", async () => {
  const root = await realpath(resolve(import.meta.dirname, ".."));
  const captured = await browserSources(root);
  const product = captured.filter(({ path }) => path.startsWith("app/fixtures/product/"));
  const expected = (await browserInventory(join(root, "app/fixtures/product")))
    .map((row) => ({ ...row, path: `app/fixtures/product/${row.path}` }));
  expect(product).toEqual(expected);
  for (const path of [
    "app/fixtures/product/config.ts", "app/fixtures/product/main.tsx", "app/fixtures/product/io.ts",
    "app/fixtures/product/definition.ts", "app/fixtures/product/fixtures.ts", "app/fixtures/product/index.html",
    "app/fixtures/browser/config.ts", "app/src/screens/settings-screen.tsx", "scripts/app-browser.ts", "bun.lock",
    "site/product-scenes.ts", "scripts/build-appearance.ts", "app/src/appearance.ts", "app/src/appearance-entry.ts",
    "scripts/site-css-resources.ts", "scripts/marketing-preset.ts", "site/vendor/marketing-preset/provenance.json",
    "site/vendor/lantern-material/provenance.json", "site/vendor/lantern-material/lantern-material.css",
    "site/vendor/lantern-material/check.mjs", "site/vendor/lantern-material/check.d.mts", "site/vendor/lantern-material/LICENSE",
  ]) expect(captured.find((row) => row.path === path)).toEqual(await browserFile(root, path));
  expect(new Set(captured.map(({ path }) => path)).size).toBe(captured.length);
});

test.each(["site/product-scenes.ts", "scripts/build-appearance.ts", "app/src/appearance.ts", "app/src/appearance-entry.ts", "scripts/site-css-resources.ts", "scripts/marketing-preset.ts", "site/vendor/marketing-preset/provenance.json", "site/vendor/marketing-preset/marketing-assets/grain.svg", "site/vendor/lantern-material/provenance.json", "site/vendor/lantern-material/lantern-material.css", "site/vendor/lantern-material/check.mjs"])("shared preview or appearance source %s mutation invalidates the original browser request", async (sharedPath) => {
  const repository = await realpath(resolve(import.meta.dirname, ".."));
  const sourcePaths = new Set([...(await browserSources(repository)).map(({ path }) => path), sharedPath]);
  const root = await realpath(await mkdtemp(join(tmpdir(), "browser-shared-source-test-")));
  try {
    for (const path of [...sourcePaths, "app/dist/index.html", "dist/site/index.html", "runtime"]) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "fixture\n", { mode: path === "runtime" ? 0o700 : 0o600 });
    }
    const executable = await browserExecutable(join(root, "runtime"));
    const captured = await browserSources(root);
    const original: BrowserRequest = { ...request(), root, run: join(root, "tmp", "app-browser-Test"),
      node: executable, bun: executable, chromium: executable, sources: captured,
      app: await browserInventory(join(root, "app/dist")), site: await browserInventory(join(root, "dist/site")) };
    await mkdir(original.run, { recursive: true });
    await verifyBrowserRequest(original);
    await writeFile(join(root, sharedPath), "mutated\n");
    const after = await browserSources(root);
    expect(after.filter(({ path }) => path !== sharedPath)).toEqual(captured.filter(({ path }) => path !== sharedPath));
    await expect(verifyBrowserRequest(original)).rejects.toThrow("Browser source or lock inputs changed");
  } finally { await rm(root, { recursive: true }); }
});

test("logical path law preserves every admitted spelling and refuses traversal extensions", () => {
  fc.assert(fc.property(logicalPath, (path) => {
    expect(browserLogicalPath(path)).toBe(path);
    for (const invalid of [`../${path}`, `${path}/..`, `/${path}`, `${path}//leaf`, `${path}/./leaf`]) {
      expect(() => browserLogicalPath(invalid)).toThrow();
    }
  }), { seed: 20260908, numRuns: 100 });
});

test("request parser roundtrip and rejection laws retain exact finite artifact identity", () => {
  fc.assert(fc.property(artifactRows, (sources) => {
    const value = { ...request(), sources, app: sources, site: sources };
    expect(parseBrowserRequest(JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
    expect(parseBrowserRequest(parseBrowserRequest(value))).toEqual(value);
    expect(() => parseBrowserRequest({ ...value, extra: true })).toThrow();
    expect(() => parseBrowserRequest({ ...value, sources: [...sources, ...sources] })).toThrow();
    expect(() => parseBrowserRequest({ ...value, sources: sources.map((item) => ({ ...item, path: `../${item.path}` })) })).toThrow();
  }), { seed: 20260908, numRuns: 100 });
});

test("prepared parser roundtrip laws preserve fixture receipts and reject changed runtime or output identity", () => {
  fc.assert(fc.property(artifactRows, (fixture) => {
    const value: BrowserPrepared = { schemaVersion: 1, kind: "hra-browser-prepared", requestSha256: "c".repeat(64),
      buildRuntime: { name: "bun", version: "1.3.14", executable }, driver: { ...row, path: "driver.mjs" }, fixture };
    expect(parseBrowserPrepared(JSON.parse(JSON.stringify(value)) as unknown)).toEqual(value);
    expect(parseBrowserPrepared(parseBrowserPrepared(value))).toEqual(value);
    expect(() => parseBrowserPrepared({ ...value, extra: true })).toThrow();
    expect(() => parseBrowserPrepared({ ...value, buildRuntime: { ...value.buildRuntime, name: "node" } })).toThrow();
    expect(() => parseBrowserPrepared({ ...value, driver: { ...value.driver, path: "other.mjs" } })).toThrow();
  }), { seed: 20260908, numRuns: 100 });
});

test("browser runtime admits genuine pinned Node and rejects Bun compatibility or version drift", () => {
  expect(() => assertBrowserNode({ node: "24.18.1" })).not.toThrow();
  for (const versions of [{ node: "24.18.1", bun: "1.3.14" }, { node: "24.18.0" }, { node: "26.0.0" }]) {
    expect(() => assertBrowserNode(versions)).toThrow();
  }
});

test("browser handoff is closed, bounded, run-bound, sorted, and rejects traversal before reads", () => {
  expect(parseBrowserRequest(request())).toEqual(request());
  for (const path of ["../outside", "/absolute", "C:\\outside", "a//b", "a/./b", "a/../b", "a%2fb", "file?x", ""]) {
    expect(() => browserLogicalPath(path)).toThrow();
  }
  for (const change of [
    { ...request(), extra: true }, { ...request(), run: "/fixture/repository/tmp/other" },
    { ...request(), run: "/fixture/other/tmp/app-browser-ABC123" }, { ...request(), schemaVersion: 2 },
    { ...request(), sources: [row, row] }, { ...request(), sources: [] },
    { ...request(), sources: [{ ...row, bytes: 64 * 1024 * 1024 + 1 }] },
    { ...request(), sources: [{ ...row, identity: [1, 2, Number.NaN, 4, 5, 6, 7] }] },
    { ...request(), sources: [{ ...row, path: "z" }, { ...row, path: "a" }] },
  ]) expect(() => parseBrowserRequest(change)).toThrow();
  const prepared: BrowserPrepared = { schemaVersion: 1, kind: "hra-browser-prepared", requestSha256: "c".repeat(64),
    buildRuntime: { name: "bun", version: "1.3.14", executable }, driver: { ...row, path: "driver.mjs" }, fixture: [row] };
  expect(parseBrowserPrepared(prepared)).toEqual(prepared);
  expect(() => parseBrowserPrepared({ ...prepared, driver: { ...row, path: "../driver.mjs" } })).toThrow();
  expect(() => parseBrowserPrepared({ ...prepared, buildRuntime: { ...prepared.buildRuntime, version: "1.3.13" } })).toThrow();
  expect(() => parseBrowserPrepared({ ...prepared, requestSha256: "unknown" })).toThrow();
});

test("ordinary reads refuse symlinks and oversize files; exact snapshots detect new, missing and replaced bytes", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "browser-handoff-test-")));
  try {
    const source = join(directory, "source"); await mkdir(source);
    await writeFile(join(source, "a.txt"), "first", { mode: 0o600 });
    const captured = await browserInventory(source);
    await verifyBrowserInventory(source, captured);
    expect(await readBrowserFile(join(source, "a.txt"), 5)).toEqual(Buffer.from("first"));
    await expect(readBrowserFile(join(source, "a.txt"), 4)).rejects.toThrow();
    await symlink(join(source, "a.txt"), join(directory, "alias"));
    await expect(readBrowserFile(join(directory, "alias"))).rejects.toThrow();
    await symlink(source, join(directory, "parent-alias"));
    await expect(readBrowserFile(join(directory, "parent-alias", "a.txt"))).rejects.toThrow();
    await writeFile(join(source, "extra.txt"), "extra");
    await expect(verifyBrowserInventory(source, captured)).rejects.toThrow();
    await rm(join(source, "extra.txt"));
    await writeFile(join(source, "a.txt"), "other");
    await expect(verifyBrowserInventory(source, captured)).rejects.toThrow();
    await rm(join(source, "a.txt"));
    await expect(verifyBrowserInventory(source, captured)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true }); }
});

test("write-once handoff publication exposes only complete bytes and preserves existing final evidence", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "browser-record-test-")));
  try {
    const path = join(directory, "record.json"), value = { state: "ready", text: "x".repeat(20000) };
    const observed: unknown[] = []; const state = { finished: false };
    const poll = (async () => {
      do {
        try { observed.push(JSON.parse((await readBrowserFile(path)).toString("utf8")) as unknown); }
        catch (error) {
          if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
        }
        await new Promise((done) => setTimeout(done, 1));
      } while (!state.finished);
    })();
    try { await publishBrowserJson(path, value); } finally { state.finished = true; }
    await poll;
    observed.push(JSON.parse((await readBrowserFile(path)).toString("utf8")) as unknown);
    expect(observed.length).toBeGreaterThan(0);
    for (const item of observed) expect(item).toEqual(value);
    const before = await browserFile(directory, "record.json");
    await expect(publishBrowserJson(path, { state: "replacement" })).rejects.toThrow();
    expect(await browserFile(directory, "record.json")).toEqual(before);
    expect(() => publishBrowserTerminalJson(path, { state: "replacement" })).toThrow();
    expect(await browserFile(directory, "record.json")).toEqual(before);
    const terminal = join(directory, "terminal.json"); publishBrowserTerminalJson(terminal, { state: "failed" });
    expect(JSON.parse((await readFile(terminal)).toString("utf8"))).toEqual({ state: "failed" });
  } finally { await rm(directory, { recursive: true }); }
});

test("stable hardlink identity is recorded and later alias mutation invalidates the handoff", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "browser-link-test-")));
  try {
    await writeFile(join(directory, "a"), "source"); await link(join(directory, "a"), join(directory, "b"));
    const row = await browserFile(directory, "a"); expect(row.sha256).toBe(browserDigest("source"));
    expect(row.identity[3]).toBe(2);
    const alias = await browserFile(directory, "b");
    expect(alias).toEqual({ ...row, path: "b" });
    expect(await readBrowserFile(join(directory, "a"))).toEqual(Buffer.from("source"));
    expect(await readBrowserFile(join(directory, "b"))).toEqual(Buffer.from("source"));
    const captured = await browserInventory(directory);
    await writeFile(join(directory, "b"), "change");
    expect(await browserFile(directory, "a")).not.toEqual(row);
    await expect(verifyBrowserInventory(directory, captured)).rejects.toThrow();
  } finally { await rm(directory, { recursive: true }); }
});
