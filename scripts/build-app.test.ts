import { link, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, test } from "bun:test";
import { getDesignPaletteTheme } from "@hraness/design-kit";
import fc from "fast-check";

import { appDevelopmentConfig, appProductionConfig } from "../app/vite.config.ts";
import {
  acquireAppPublicationLock, APP_CSS_PLACEHOLDER, APP_PROCESS_CUSTODY_FILE, AppProcessCustodyError,
  appPublicationRecord, appSha256, assertAppRunDirectory, beginAppProcessCustody,
  commitAppPublication, createAppSourceMarkerEvidence, parseAppComplete, parseAppPublication, prepareAppShell,
  readAppInventory, reconcileAppPublication, revalidateAppSourceMarker, revalidateAppSourceMarkerInputs,
  snapshotAppGraph, snapshotAppSourceEnvironment,
  type AppArtifact, type AppPublicationFailureBoundary, type AppPublicationLock,
  type AppSourceMarkerEvidence,
} from "./build-app.ts";
import { APP_SOURCE_MARKER_PATH } from "./app-source-marker.ts";

const temporaryRoots: string[] = [];

afterAll(async () => {
  await Promise.all(temporaryRoots.splice(0).map(async (root) => {
    await rm(root, { force: true, recursive: true });
  }));
});

const entry = "/fixture/app/src/main.tsx";
const faviconBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Oompa">\n  <circle cx="32" cy="32" r="27" fill="#f58220" stroke="#ad430d" stroke-width="2"/>\n</svg>\n');
const faviconTag = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${faviconBytes.toString("base64")}">`;
const shell = `<!doctype html>\n<html lang="en" data-hraness-theme="paper" data-palette="paper" data-theme="light"><head>${faviconTag}<meta name="viewport" content="width=device-width, viewport-fit=cover"><meta name="color-scheme" content="dark light"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow"><title>Oompa</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n`;
const chunk = (name: string, code: string, isEntry = false) => ({
  code, facadeModuleId: isEntry ? entry : null, fileName: `assets/${name}.js`, isEntry, map: null, type: "chunk",
});
const appearance = { sourcePath: "/fixture/tmp/build-app/build-test/appearance.js", source: "(()=>{window.themeReady=true;})();", verifyInputs: () => Promise.resolve() };
const bundle = () => ({ output: [
  chunk("main-abc", 'import("./lazy-def.js");', true),
  chunk("lazy-def", "export const loaded=true;"),
  { fileName: "assets/style-ghi.css", source: ":root{color-scheme:dark}", type: "asset" },
  { fileName: "assets/appearance-jkl.js", source: appearance.source, type: "asset" },
] });
const hashed = (path: string, content: string) => ({ bytes: Buffer.byteLength(content), path, sha256: appSha256(content) });
const packageBytes = Buffer.from('{"name":"@hraness/oompa","version":"0.6.1"}\n');
const sourceMarker = (environment: Readonly<Record<string, string | undefined>> = process.env): AppSourceMarkerEvidence =>
  createAppSourceMarkerEvidence(packageBytes, environment);
const markerBytes = (evidence: AppSourceMarkerEvidence): string => `${JSON.stringify(evidence.marker, null, 2)}\n`;
const publicationOutput = (
  output: readonly AppArtifact[],
  evidence: AppSourceMarkerEvidence,
): readonly AppArtifact[] => [...output, evidence.markerArtifact]
  .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const complete = () => {
  const graph = snapshotAppGraph(bundle(), entry, appearance);
  return {
    artifacts: [
      ...graph.artifacts.map((item) => ({ ...item, path: `graphs/client/${item.path}` })),
      hashed("index.html", prepareAppShell(shell, graph).replace(APP_CSS_PLACEHOLDER, "/stylex.css")),
    ],
    compilerSha256: "a".repeat(64), finalCss: hashed("stylex.css", "@layer components.hraness-stylex.priority1{.x{color:red}}"),
    generationId: "oompa-app", graphs: [{ id: "client", receiptSha256: "b".repeat(64) }],
    kind: "hraness-stylex-complete-generation", packages: [{ manifestSha256: "e".repeat(64), name: "@hraness/design-kit", version: "0.6.0" }, { manifestSha256: "c".repeat(64), name: "@hraness/ui", version: "0.5.6" }],
    planSha256: "d".repeat(64), schemaVersion: 2, state: "complete",
    unionPolicySha256: "1ceced1f1bf6359413ca6425ede61e1fdae272b897f4455c2347e2431d75caa1",
  };
};

describe("app compiler-owned Vite configuration", () => {
  for (const [profile, configure] of [
    ["production", appProductionConfig],
    ["development", appDevelopmentConfig],
  ] as const) {
    test(`leaves ${profile} Vite root and graph output ownership to the public adapter`, () => {
      const config = configure("/fixture", { directory: "/fixture/generation", planSha256: "a".repeat(64) }, appearance);
      expect(config.root).toBeUndefined();
      expect(config.publicDir).toBeUndefined();
      for (const key of ["assetsInlineLimit", "outDir", "assetsDir", "copyPublicDir", "cssCodeSplit", "emptyOutDir", "lib", "write", "sourcemap"] as const) {
        expect(config.build?.[key]).toBeUndefined();
      }
      expect(config.build?.rollupOptions).toBeUndefined();
      expect(config.build?.target).toBe("es2022");
      expect(config.mode).toBe(profile);
      expect(config.define?.["process.env.NODE_ENV"]).toBe(JSON.stringify(profile));
      expect(config.configFile).toBe(false);
      expect(config.envFile).toBe(false);
      expect(config.build?.minify).toBe(profile === "development" ? false : undefined);
    });
  }
});

describe("app graph output values", () => {
  test("accepts only production or development runs below the exact control directory", () => {
    expect(() => assertAppRunDirectory("/fixture", "/fixture/tmp/build-app/build-abc_123")).not.toThrow();
    expect(() => assertAppRunDirectory("/fixture", "/fixture/tmp/build-app/dev/runs/build-abc_123")).not.toThrow();
    for (const run of [
      "/fixture/build-abc", "/other/tmp/build-app/build-abc", "/fixture-copy/tmp/build-app/build-abc",
      "/fixture/tmp/build-app", "/fixture/tmp/build-app-other/build-abc", "/fixture/tmp/build-app/build-",
      "/fixture/tmp/build-app/build-abc/extra", "/fixture/tmp/build-app/dev/build-abc",
      "/fixture/tmp/build-app/../build-abc", "/fixture/tmp/build-app/dev/runs/../build-abc",
      "/fixture/tmp/build-app/dev\\runs\\build-abc",
    ]) expect(() => assertAppRunDirectory("/fixture", run)).toThrow();
  });

  test("binds the real entry facade, complete foundation, and lazy output bytes", () => {
    const input = bundle();
    const graph = snapshotAppGraph(input, entry, appearance);
    expect(graph.entry).toBe("assets/main-abc.js");
    expect(graph.foundation).toBe("assets/style-ghi.css");
    expect(graph.appearance).toBe("assets/appearance-jkl.js");
    expect(graph.artifacts.map(({ path }) => path)).toEqual(["assets/appearance-jkl.js", "assets/lazy-def.js", "assets/main-abc.js", "assets/style-ghi.css"]);
    const prior = JSON.stringify(graph);
    input.output[0] = chunk("changed", "changed", true);
    expect(JSON.stringify(graph)).toBe(prior);
  });

  test("rejects missing/extra entries, facade forgery, missing/split CSS and maps", () => {
    for (const input of [
      { output: bundle().output.slice(1) },
      { output: [...bundle().output, chunk("extra", "export{}", true)] },
      { output: [{ ...chunk("main", "export{}", true), facadeModuleId: "/other/main.tsx" }, bundle().output[2]] },
      { output: bundle().output.slice(0, 2) },
      { output: [...bundle().output, { fileName: "assets/extra.css", type: "asset", source: "a{}" }] },
      { output: [{ ...chunk("main", "export{}", true), map: {} }, bundle().output[2]] },
    ]) expect(() => snapshotAppGraph(input, entry, appearance)).toThrow();
  });

  test("rejects maps, receipts, source assets, path traversal and duplicate files", () => {
    for (const fileName of ["assets/app.js.map", "assets/source.ts", "assets/source.svg", "stylex-complete.json", "../app.js", "/assets/app.js", "assets/%2e%2e.js", "assets\\app.js", "assets/a.js?x", "assets/a.js#x"]) {
      expect(() => snapshotAppGraph({ output: [...bundle().output, { fileName, type: "asset", source: "x" }] }, entry, appearance)).toThrow();
    }
    expect(() => snapshotAppGraph({ output: [...bundle().output, chunk("lazy-def", "different")] }, entry, appearance)).toThrow();
  });

  test("requires exactly one classic bootstrap with the original compiler bytes", () => {
    const base = bundle().output.filter((item) => item.fileName !== "assets/appearance-jkl.js");
    const bootstrap = { fileName: "assets/appearance-jkl.js", source: appearance.source, type: "asset" };
    for (const output of [
      base,
      [...base, { ...bootstrap, source: `${appearance.source}changed` }],
      [...base, { ...bootstrap, fileName: "assets/other-bootstrap.js" }],
      [...base, bootstrap, { ...bootstrap, fileName: "assets/appearance-other.js" }],
      [...base, chunk("appearance-jkl", appearance.source)],
    ]) expect(() => snapshotAppGraph({ output }, entry, appearance)).toThrow();
    expect(snapshotAppGraph({ output: [...base, { ...bootstrap, source: Buffer.from(appearance.source) }] }, entry, appearance).appearance)
      .toBe(bootstrap.fileName);
  });
});

describe("registered authored shell", () => {
  test("admits only the exact Oompa favicon bytes already held by the shell", async () => {
    const bytes = await readFile(new URL("../site/favicon.svg", import.meta.url));
    const tag = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${bytes.toString("base64")}">`;
    expect(bytes).toEqual(faviconBytes);
    expect(tag).toBe(faviconTag);
    const authored = await readFile(new URL("../app/index.html", import.meta.url), "utf8");
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    for (const mount of ["/", "./"] as const) {
      expect(prepareAppShell(authored, graph, mount)).toContain(tag);
    }
  });

  test("refuses missing, duplicate, alternate, inert, or active-payload favicons", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    const active = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>').toString("base64");
    for (const changed of [
      shell.replace(faviconTag, ""),
      shell.replace(faviconTag, faviconTag + faviconTag),
      shell.replace(faviconTag, `${faviconTag}<link rel="icon" href="/favicon.svg">`),
      shell.replace(faviconTag, '<link rel="icon" href="https://example.test/favicon.svg">'),
      shell.replace(faviconTag, faviconTag.replace('rel="icon"', 'rel="shortcut icon"')),
      shell.replace(faviconTag, faviconTag.replace('type="image/svg+xml"', 'type="image/png"')),
      shell.replace(faviconTag, faviconTag.replace('href="data:', 'href="/favicon.svg" href="data:')),
      shell.replace(faviconTag, faviconTag.replace(">", ' onload="alert(1)">')),
      shell.replace(faviconTag, faviconTag.replace("base64,", "base64,\n")),
      shell.replace(faviconTag, faviconTag.replace(faviconBytes.toString("base64"), active)),
      shell.replace(faviconTag, faviconTag.replace(faviconBytes.toString("base64"), faviconBytes.toString("base64") + "=")),
      shell.replace(faviconTag, `<!--${faviconTag}-->`),
      shell.replace(faviconTag, `<title>${faviconTag}</title>`),
      shell.replace(faviconTag, `<meta content='${faviconTag}'>`),
      shell.replace(faviconTag, "").replace("</body>", `${faviconTag}</body>`),
      shell.replace("<head>", "<textarea><head>"),
    ]) expect(() => prepareAppShell(changed, graph)).toThrow();
  });

  test("rejects every sampled changed favicon byte under the unchanged finite asset contract", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    fc.assert(fc.property(
      fc.integer({ min: 0, max: faviconBytes.length - 1 }),
      fc.integer({ min: 1, max: 255 }),
      (offset, delta) => {
        const changed = Buffer.from(faviconBytes);
        changed[offset] = (changed[offset] ?? 0) ^ delta;
        const altered = shell.replace(faviconBytes.toString("base64"), changed.toString("base64"));
        expect(() => prepareAppShell(altered, graph)).toThrow("Unreviewed app favicon bytes");
      },
    ), { seed: 20_260_913, numRuns: 64 });
  });

  test("retains metadata and every other authored byte with foundation before recipes", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    const rendered = prepareAppShell(shell, graph);
    const foundation = '<link rel="stylesheet" href="/graphs/client/assets/style-ghi.css">';
    const recipes = `<link rel="stylesheet" href="${APP_CSS_PLACEHOLDER}">`;
    const bootstrap = '<script src="/graphs/client/assets/appearance-jkl.js"></script>';
    const paletteClass = getDesignPaletteTheme("paper", "light").className;
    expect(rendered.indexOf(foundation)).toBeLessThan(rendered.indexOf(recipes));
    expect(rendered.indexOf(recipes)).toBeLessThan(rendered.indexOf(bootstrap));
    expect(rendered.indexOf(bootstrap)).toBeLessThan(rendered.indexOf("</head>"));
    expect(rendered).not.toMatch(/<(?:script)[^>]*(?:async|defer)|<style\b|\bstyle=/u);
    expect(rendered.replace(`${foundation}\n    ${recipes}\n    ${bootstrap}\n  `, "")
      .replace(` class="${paletteClass}"`, "")
      .replace("/graphs/client/assets/main-abc.js", "/src/main.tsx")).toBe(shell);
  });

  test("fails closed on ambiguous entry, metadata joins, or injected styles", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    for (const changed of [
      shell.replace("/src/main.tsx", "/src/other.tsx"),
      shell.replace("</body>", '<script src="/another.js"></script></body>'),
      shell.replace("</head>", "</head></head>"),
      shell.replace("<head>", '<head><link rel="stylesheet" href="/other.css">'),
      shell.replace("<head>", '<head><style>a{color:red}</style>'),
      shell.replace("<head>", '<head><base href="/elsewhere/">'),
      shell.replace('<div id="root">', '<div style="color:red" id="root">'),
      shell.replace("Oompa", APP_CSS_PLACEHOLDER),
      shell.replace('data-palette="paper"', 'data-palette="gruvbox"'),
      shell.replace('data-theme="light"', 'data-theme="dark"'),
      shell.replace('<html lang="en"', '<html class="other" lang="en"'),
      shell.replace('<script type="module" src="/src/main.tsx"></script>', '<!--<script type="module" src="/src/main.tsx"></script>-->'),
    ]) expect(() => prepareAppShell(changed, graph)).toThrow();
  });

  test("seals relative links for an immutable development revision", () => {
    const graph = snapshotAppGraph(bundle(), entry, appearance);
    const rendered = prepareAppShell(shell, graph, "./")
      .replace(APP_CSS_PLACEHOLDER, "./stylex.css");
    expect(rendered).toContain('src="./graphs/client/assets/main-abc.js"');
    expect(rendered).toContain('href="./graphs/client/assets/style-ghi.css"');
    expect(rendered).toContain('href="./stylex.css"');
    expect(rendered).toContain('src="./graphs/client/assets/appearance-jkl.js"');
    expect(rendered).not.toMatch(/(?:src|href)="\/(?:graphs|stylex\.css)/u);
  });
});

describe("closed public projection and prior publication provenance", () => {
  test("keeps compiler output closed while binding one typed marker into publication", () => {
    const input = complete();
    const compilerOutput = parseAppComplete(input);
    expect(compilerOutput.map(({ path }) => path)).toEqual(["graphs/client/assets/appearance-jkl.js", "graphs/client/assets/lazy-def.js", "graphs/client/assets/main-abc.js", "graphs/client/assets/style-ghi.css", "index.html", "stylex.css"]);
    expect(compilerOutput.some(({ path }) => path === APP_SOURCE_MARKER_PATH)).toBe(false);
    const evidence = sourceMarker({ VERCEL: "1", VERCEL_GIT_COMMIT_SHA: "e".repeat(40) });
    const output = publicationOutput(compilerOutput, evidence);
    const source = appPublicationRecord(output, appSha256(shell), appSha256(JSON.stringify(input)), evidence);
    expect(parseAppPublication(JSON.parse(source) as unknown)).toEqual(output);
    expect(source).not.toContain(entry);
    expect(source).not.toContain("inputs");
    expect(source).not.toContain("rootDirectory");
    expect(source).toContain('"path":".well-known/oompa-app.json"');
  });

  test("rejects foreign generations, graph/package metadata, artifact drift and leak paths", () => {
    for (const patch of [
      { schemaVersion: 1 }, { schemaVersion: 3 }, { unionPolicySha256: "e".repeat(64) },
      { unionPolicySha256: undefined }, { state: "building" }, { generationId: "other" }, { rootDirectory: "/private/root" },
      { graphs: [] }, { graphs: [{ id: "ssr", receiptSha256: "b".repeat(64) }] },
      { packages: [{ name: ["@other", "ui"].join("/"), version: "0.5.3", manifestSha256: "c".repeat(64) }] },
      { packages: complete().packages.slice(1) },
      { packages: [...complete().packages].reverse() },
      { packages: [complete().packages[0], complete().packages[0]] },
      { packages: [...complete().packages, complete().packages[0]] },
      { finalCss: hashed("other.css", "x") },
      { artifacts: [...complete().artifacts, hashed("source.ts", "x")] },
      { artifacts: [...complete().artifacts, hashed("stylex-complete.json", "x")] },
      { artifacts: [...complete().artifacts, hashed(APP_SOURCE_MARKER_PATH, "{}\n")] },
      { artifacts: [...complete().artifacts, hashed("graphs/client/assets/app.js.map", "x")] },
      { artifacts: [...complete().artifacts].reverse() },
      { artifacts: [complete().artifacts[0], ...complete().artifacts] },
      { artifacts: complete().artifacts.filter(({ path }) => !path.includes("/appearance-")) },
    ]) expect(() => parseAppComplete({ ...complete(), ...patch })).toThrow();
    for (const bad of [NaN, -1, 0, 1.5, 65 * 1024 * 1024]) {
      expect(() => parseAppComplete({ ...complete(), finalCss: { ...complete().finalCss, bytes: bad } })).toThrow();
    }
    const unbound = Object.fromEntries(Object.entries(complete()).filter(([key]) => key !== "unionPolicySha256"));
    expect(() => parseAppComplete(unbound)).toThrow();
  });

  test("source environment excludes every ASCII control without excluding other code units", () => {
    const controls = [...Array.from({ length: 32 }, (_, code) => code), 127];
    for (const code of controls) {
      expect(() => snapshotAppSourceEnvironment({ VERCEL: `left${String.fromCharCode(code)}right` }))
        .toThrow(/Unsafe app source environment value/u);
    }
    for (const code of [32, 126, 128, 0x2028, 0xd800, 0xdc00, 0xffff]) {
      const value = `left${String.fromCharCode(code)}right`;
      expect(snapshotAppSourceEnvironment({ VERCEL: value }).VERCEL).toBe(value);
    }
    expect(snapshotAppSourceEnvironment({ VERCEL: "x".repeat(256) }).VERCEL).toHaveLength(256);
    expect(() => snapshotAppSourceEnvironment({ VERCEL: "x".repeat(257) }))
      .toThrow(/Unsafe app source environment value/u);
  });

  test("prior output requires the exact private publication schema and safe paths", () => {
    const evidence = sourceMarker();
    const output = publicationOutput(parseAppComplete(complete()), evidence);
    const source: unknown = JSON.parse(appPublicationRecord(output, appSha256(shell), "f".repeat(64), evidence));
    expect(() => parseAppPublication(complete())).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), sourceRoot: entry })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), artifacts: [hashed("../user.txt", "personal")] })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), completeSha256: "not-a-digest" })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), schemaVersion: 1 })).toThrow();
    expect(() => parseAppPublication({ ...(source as Record<string, unknown>), sourceMarker: undefined })).toThrow();
    expect(() => parseAppPublication({
      ...(source as Record<string, unknown>),
      artifacts: output.filter(({ path }) => path !== APP_SOURCE_MARKER_PATH),
    })).toThrow();
    expect(() => createAppSourceMarkerEvidence(
      Buffer.from('{"name":"oompa","version":"0.6.1"}\n'),
      {},
    )).toThrow(/Oompa root package/u);
    for (const OOMPA_RELEASE_COMMIT of ["x".repeat(257), "safe\u0000hidden"]) {
      expect(() => createAppSourceMarkerEvidence(packageBytes, {
        OOMPA_RELEASE_COMMIT,
        VERCEL: "1",
        VERCEL_GIT_COMMIT_SHA: "e".repeat(40),
      })).toThrow(/Unsafe app source environment value/u);
    }
    const changedEvidence = structuredClone(evidence) as unknown as {
      environment: { OOMPA_RELEASE_COMMIT: string | null };
    };
    changedEvidence.environment.OOMPA_RELEASE_COMMIT = "a".repeat(40);
    expect(() => parseAppPublication({
      ...(source as Record<string, unknown>),
      sourceMarker: changedEvidence,
    })).toThrow();
  });
});

type PublicationFixtureBase = Readonly<{
  app: string;
  control: string;
  next: readonly AppArtifact[];
  pendingMarker: string;
  publish: string;
  root: string;
  run: string;
  sourceMarker: AppSourceMarkerEvidence;
}>;
type PriorPublicationFixture = PublicationFixtureBase & Readonly<{
  old: readonly AppArtifact[];
  previousMarker: Buffer<ArrayBuffer>;
}>;
type FreshPublicationFixture = PublicationFixtureBase & Readonly<{
  old?: never;
  previousMarker?: never;
}>;
type PublicationFixture = PriorPublicationFixture | FreshPublicationFixture;

async function writePublicTree(
  root: string,
  label: string,
  evidence: AppSourceMarkerEvidence,
): Promise<readonly AppArtifact[]> {
  await mkdir(join(root, "graphs", "client", "assets"), { mode: 0o700, recursive: true });
  await mkdir(join(root, ".well-known"), { mode: 0o700 });
  const files = new Map([
    [APP_SOURCE_MARKER_PATH, markerBytes(evidence)],
    ["graphs/client/assets/foundation.css", `@layer base{html{--fixture:${label}}}\n`],
    ["graphs/client/assets/main.js", `globalThis.__fixture=${JSON.stringify(label)};\n`],
    ["index.html", `<!doctype html><link rel="stylesheet" href="/stylex.css"><script type="module" src="/graphs/client/assets/main.js"></script>${label}\n`],
    ["stylex.css", `@layer components.hraness-ui.priority1{.x{color:${label}}}\n`],
  ]);
  for (const [path, contents] of files) {
    await writeFile(join(root, ...path.split("/")), contents, { flag: "wx", mode: 0o600 });
  }
  return readAppInventory(root);
}

function publicationFixture(previous: true): Promise<PriorPublicationFixture>;
function publicationFixture(previous: false): Promise<FreshPublicationFixture>;
async function publicationFixture(previous: boolean): Promise<PublicationFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-build-publication-")));
  temporaryRoots.push(root);
  const app = join(root, "app");
  const control = join(root, "control");
  const run = join(control, "build-fixture");
  const publish = join(run, "public");
  const pendingMarker = join(run, "publication.json");
  await writeFile(join(root, "package.json"), packageBytes, { flag: "wx", mode: 0o600 });
  const marker = sourceMarker();
  await mkdir(app, { mode: 0o700 });
  await mkdir(publish, { mode: 0o700, recursive: true });
  const next = await writePublicTree(publish, "blue", marker);
  await writeFile(
    pendingMarker,
    appPublicationRecord(next, "1".repeat(64), "2".repeat(64), marker),
    { flag: "wx", mode: 0o600 },
  );
  if (!previous) return { app, control, next, pendingMarker, publish, root, run, sourceMarker: marker };
  const dist = join(app, "dist");
  await mkdir(dist, { mode: 0o700 });
  const old = await writePublicTree(dist, "red", marker);
  const previousMarker = Buffer.from(appPublicationRecord(old, "3".repeat(64), "4".repeat(64), marker));
  await writeFile(join(control, "current.json"), previousMarker, { flag: "wx", mode: 0o600 });
  return { app, control, next, old, pendingMarker, previousMarker, publish, root, run, sourceMarker: marker };
}

async function expectSettled(fixture: PublicationFixture): Promise<void> {
  expect(await readAppInventory(join(fixture.app, "dist"))).toEqual(fixture.next);
  const marker = JSON.parse(await readFile(join(fixture.control, "current.json"), "utf8")) as unknown;
  expect(parseAppPublication(marker)).toEqual(fixture.next);
  await expect(lstat(join(fixture.control, "pending-publication.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(join(fixture.run, "transaction.json"))).isFile()).toBe(true);
  if (fixture.old !== undefined) {
    expect(await readAppInventory(join(fixture.run, "previous-dist"))).toEqual(fixture.old);
    expect(await readFile(join(fixture.run, "previous-publication.json"))).toEqual(fixture.previousMarker);
  }
}

async function withPublicationLock<Value>(
  control: string,
  operation: (lock: AppPublicationLock) => Promise<Value>,
): Promise<Value> {
  const lock = acquireAppPublicationLock(control);
  try { return await operation(lock); } finally { lock.release(); }
}

describe("durable app publication", () => {
  test("a collected custody token clears both exact private records before readmission", async () => {
    const fixture = await publicationFixture(false);
    const dev = join(fixture.control, "dev");
    await mkdir(dev, { mode: 0o700 });
    const buildLock = acquireAppPublicationLock(fixture.control);
    const devLock = acquireAppPublicationLock(dev);
    try {
      const custody = beginAppProcessCustody([
        { controlDirectory: fixture.control, lock: buildLock },
        { controlDirectory: dev, lock: devLock },
      ], "build-fixture");
      const bytes = await readFile(join(fixture.control, APP_PROCESS_CUSTODY_FILE));
      expect(bytes.byteLength).toBeLessThanOrEqual(512);
      expect(JSON.parse(bytes.toString())).toEqual({
        kind: "oompa-app-process-custody", run: "build-fixture", schemaVersion: 1, token: expect.stringMatching(/^[a-f0-9]{64}$/u),
      });
      expect(await readFile(join(dev, APP_PROCESS_CUSTODY_FILE))).toEqual(bytes);
      for (const directory of [fixture.control, dev]) {
        expect((await lstat(join(directory, APP_PROCESS_CUSTODY_FILE))).mode & 0o777).toBe(0o600);
      }
      custody.assertHeld();
      custody.clearAfterCollection();
      for (const directory of [fixture.control, dev]) {
        await expect(lstat(join(directory, APP_PROCESS_CUSTODY_FILE))).rejects.toMatchObject({ code: "ENOENT" });
      }
      expect(() => custody.clearAfterCollection()).toThrow(AppProcessCustodyError);
    } finally { devLock.release(); buildLock.release(); }
    for (const directory of [fixture.control, dev]) acquireAppPublicationLock(directory).release();
  });

  for (const mutation of ["bytes", "identity"] as const) {
    test(`preserves both custody records when ${mutation} change`, async () => {
      const fixture = await publicationFixture(false);
      const dev = join(fixture.control, "dev");
      await mkdir(dev, { mode: 0o700 });
      const buildLock = acquireAppPublicationLock(fixture.control);
      const devLock = acquireAppPublicationLock(dev);
      try {
        const custody = beginAppProcessCustody([
          { controlDirectory: fixture.control, lock: buildLock },
          { controlDirectory: dev, lock: devLock },
        ], "build-fixture");
        const buildPath = join(fixture.control, APP_PROCESS_CUSTODY_FILE);
        const devPath = join(dev, APP_PROCESS_CUSTODY_FILE);
        const original = await readFile(buildPath);
        if (mutation === "identity") {
          await rename(devPath, join(dev, "retained-original.json"));
          await writeFile(devPath, original, { flag: "wx", mode: 0o600 });
        } else {
          const changed = original.toString().replace(/"token":"[a-f0-9]{64}"/u, `"token":"${"0".repeat(64)}"`);
          await writeFile(devPath, changed);
        }
        expect(() => custody.clearAfterCollection()).toThrow(AppProcessCustodyError);
        expect(await readFile(buildPath)).toEqual(original);
        expect((await lstat(devPath)).isFile()).toBe(true);
      } finally { devLock.release(); buildLock.release(); }
      for (const directory of [fixture.control, dev]) {
        expect(() => acquireAppPublicationLock(directory)).toThrow(AppProcessCustodyError);
      }
    });
  }

  test("retains partial pre-spawn custody and refuses malformed existing fences", async () => {
    const fixture = await publicationFixture(false);
    const dev = join(fixture.control, "dev");
    await mkdir(dev, { mode: 0o700 });
    const buildLock = acquireAppPublicationLock(fixture.control);
    const devLock = acquireAppPublicationLock(dev);
    const foreign = "preserve this unknown record\n";
    await writeFile(join(dev, APP_PROCESS_CUSTODY_FILE), foreign, { mode: 0o600 });
    try {
      expect(() => beginAppProcessCustody([
        { controlDirectory: fixture.control, lock: buildLock },
        { controlDirectory: dev, lock: devLock },
      ], "build-fixture")).toThrow(AppProcessCustodyError);
      expect((await readFile(join(fixture.control, APP_PROCESS_CUSTODY_FILE))).byteLength).toBeLessThanOrEqual(512);
      expect(await readFile(join(dev, APP_PROCESS_CUSTODY_FILE), "utf8")).toBe(foreign);
    } finally { devLock.release(); buildLock.release(); }
    for (const directory of [fixture.control, dev]) {
      expect(() => acquireAppPublicationLock(directory)).toThrow(AppProcessCustodyError);
    }
  });

  test("fences initial source-marker inputs across the compiler interval before marker emission", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "oompa-build-source-inputs-")));
    temporaryRoots.push(root);
    await writeFile(join(root, "package.json"), packageBytes, { flag: "wx", mode: 0o600 });
    const evidence = sourceMarker();
    await expect(revalidateAppSourceMarkerInputs(root, evidence)).resolves.toBeUndefined();
    await writeFile(join(root, "package.json"), '{"name":"@hraness/oompa","version":"0.6.1"} \n');
    await expect(revalidateAppSourceMarkerInputs(root, evidence)).rejects.toThrow(/source-marker inputs changed/u);
    await writeFile(join(root, "package.json"), packageBytes);
    const changedCommit = evidence.marker.source.commit === "a".repeat(40)
      ? "b".repeat(40)
      : "a".repeat(40);
    await expect(revalidateAppSourceMarkerInputs(
      root,
      evidence,
      { OOMPA_RELEASE_COMMIT: changedCommit },
    )).rejects.toThrow(/source-marker inputs changed/u);
    await expect(lstat(join(root, APP_SOURCE_MARKER_PATH))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("revalidates exact package, environment, and marker bytes before publication intent", async () => {
    const fixture = await publicationFixture(false);
    await expect(revalidateAppSourceMarker(
      fixture.root,
      fixture.publish,
      fixture.sourceMarker,
      process.env,
    )).resolves.toBeUndefined();
    const changedCommit = fixture.sourceMarker.marker.source.commit === "a".repeat(40)
      ? "b".repeat(40)
      : "a".repeat(40);
    await expect(revalidateAppSourceMarker(
      fixture.root,
      fixture.publish,
      fixture.sourceMarker,
      { OOMPA_RELEASE_COMMIT: changedCommit },
    )).rejects.toThrow(/source-marker inputs changed/u);
    await writeFile(join(fixture.root, "package.json"), '{ "name":"@hraness/oompa", "version":"0.6.1" }\n');
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    })).rejects.toThrow(/source-marker inputs changed/u);
    await expect(lstat(join(fixture.control, "pending-publication.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readAppInventory(fixture.publish)).toEqual(fixture.next);
  });

  test("keeps one kernel-released lock inode and serializes live publishers", async () => {
    const fixture = await publicationFixture(false);
    const first = acquireAppPublicationLock(fixture.control);
    expect(() => acquireAppPublicationLock(fixture.control)).toThrow(/execution lock/u);
    first.release();
    const identity = await lstat(join(fixture.control, "publication.lock"));
    expect({ mode: identity.mode & 0o777, size: identity.size }).toEqual({ mode: 0o600, size: 0 });
    const second = acquireAppPublicationLock(fixture.control);
    second.assertHeld();
    second.release();
    const after = await lstat(join(fixture.control, "publication.lock"));
    expect([after.dev, after.ino]).toEqual([identity.dev, identity.ino]);
  });

  test("reacquires the persistent lock after its holder process dies", async () => {
    const fixture = await publicationFixture(false);
    const ready = join(fixture.root, "holder-ready");
    const moduleUrl = new URL("./build-app.ts", import.meta.url).href;
    const holder = Bun.spawn([
      process.execPath,
      "-e",
      `const {writeFile}=await import("node:fs/promises");const m=await import(${JSON.stringify(moduleUrl)});m.acquireAppPublicationLock(${JSON.stringify(fixture.control)});await writeFile(${JSON.stringify(ready)},"ready",{flag:"wx",mode:384});await new Promise(()=>{});`,
    ], { stderr: "inherit", stdout: "inherit" });
    let exited = false;
    try {
      for (let attempt = 0; attempt < 100 && await lstat(ready).then(() => false, () => true); attempt += 1) {
        await Bun.sleep(10);
      }
      expect(await readFile(ready, "utf8")).toBe("ready");
      expect(() => acquireAppPublicationLock(fixture.control)).toThrow(/execution lock/u);
      holder.kill("SIGKILL");
      await holder.exited;
      exited = true;
      const recovered = acquireAppPublicationLock(fixture.control);
      recovered.assertHeld();
      recovered.release();
      expect((await lstat(join(fixture.control, "publication.lock"))).isFile()).toBe(true);
    } finally {
      if (!exited) {
        holder.kill("SIGKILL");
        await holder.exited;
      }
    }
  });

  test("publishes a first exact output and retains its settled transaction", async () => {
    const fixture = await publicationFixture(false);
    await withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    });
    await expectSettled(fixture);
  });

  test("recovers every exact prior-output rename boundary by rolling forward", async () => {
    const boundaries: readonly AppPublicationFailureBoundary[] = ["journal", "previous", "public", "marker"];
    for (const failAfter of boundaries) {
      const fixture = await publicationFixture(true);
      await expect(withPublicationLock(fixture.control, async (lock) => {
        await commitAppPublication({
          appDirectory: fixture.app,
          controlDirectory: fixture.control,
          failAfter,
          lock,
          pendingMarkerPath: fixture.pendingMarker,
          previousMarker: fixture.previousMarker,
          projected: fixture.next,
          publishDirectory: fixture.publish,
          rootDirectory: fixture.root,
          sourceMarker: fixture.sourceMarker,
        });
      })).rejects.toThrow(`Injected app publication failure after ${failAfter}`);
      expect((await lstat(join(fixture.control, "pending-publication.json"))).isFile()).toBe(true);
      await withPublicationLock(fixture.control, async (lock) => {
        await reconcileAppPublication(fixture.app, fixture.control, lock);
      });
      await expectSettled(fixture);
    }
  });

  test("recovers every exact first-publication rename boundary", async () => {
    const boundaries: readonly AppPublicationFailureBoundary[] = ["journal", "public", "marker"];
    for (const failAfter of boundaries) {
      const fixture = await publicationFixture(false);
      await expect(withPublicationLock(fixture.control, async (lock) => {
        await commitAppPublication({
          appDirectory: fixture.app,
          controlDirectory: fixture.control,
          failAfter,
          lock,
          pendingMarkerPath: fixture.pendingMarker,
          projected: fixture.next,
          publishDirectory: fixture.publish,
          rootDirectory: fixture.root,
          sourceMarker: fixture.sourceMarker,
        });
      })).rejects.toThrow(`Injected app publication failure after ${failAfter}`);
      await withPublicationLock(fixture.control, async (lock) => {
        await reconcileAppPublication(fixture.app, fixture.control, lock);
      });
      await expectSettled(fixture);
    }
  });

  test("preserves an interrupted transaction when any staged byte changes", async () => {
    const fixture = await publicationFixture(true);
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        failAfter: "previous",
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        previousMarker: fixture.previousMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    })).rejects.toThrow("after previous");
    await writeFile(fixture.pendingMarker, "{}\n", { mode: 0o600 });
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await reconcileAppPublication(fixture.app, fixture.control, lock);
    })).rejects.toThrow(/digest changed/u);
    expect(await readAppInventory(join(fixture.run, "previous-dist"))).toEqual(fixture.old);
    expect(await readAppInventory(fixture.publish)).toEqual(fixture.next);
    expect(await readFile(join(fixture.control, "current.json"))).toEqual(fixture.previousMarker);
    expect((await lstat(join(fixture.control, "pending-publication.json"))).isFile()).toBe(true);
  });

  test("refuses a hardlinked pending marker before publishing an intent", async () => {
    const fixture = await publicationFixture(false);
    await link(fixture.pendingMarker, join(fixture.run, "marker-alias.json"));
    await expect(withPublicationLock(fixture.control, async (lock) => {
      await commitAppPublication({
        appDirectory: fixture.app,
        controlDirectory: fixture.control,
        lock,
        pendingMarkerPath: fixture.pendingMarker,
        projected: fixture.next,
        publishDirectory: fixture.publish,
        rootDirectory: fixture.root,
        sourceMarker: fixture.sourceMarker,
      });
    })).rejects.toThrow(/Hardlinked/u);
    await expect(lstat(join(fixture.control, "pending-publication.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(fixture.app, "dist"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
