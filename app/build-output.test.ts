import { getDesignPaletteTheme } from "@hraness/design-kit";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  appSha256, parseAppPublication, readAppInventory, readAppOrdinary,
} from "../scripts/build-app.ts";
import { assertReviewedRuntimeStyleBoundary } from "./build-runtime-style-boundary.ts";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(appRoot);
const distributionRoot = join(appRoot, "dist");
const buildSourceCommit = "0123456789abcdef0123456789abcdef01234567";

/*
 * The shipped bundle has to survive the F1 Content Security Policy:
 *
 *   default-src 'none'; script-src 'self'; style-src 'self'; img-src data: blob:;
 *   connect-src <the three pinned Convex origins>; worker-src 'none'
 *
 * A violation is invisible at build time and fails silently in a browser, so
 * the build output itself is the fixture.
 *
 * These absolute URLs come from vendored library code and are reviewed: they
 * are documentation links and XML namespace constants in error paths, never
 * fetch targets. A new entry here means a dependency started naming a new
 * origin and needs review.
 */
const reviewedVendorOrigins = new Set([
  // The exact device-code verification link rendered for a Codex account login.
  "https://auth.openai.com",
  // XML namespace constants in React DOM.
  "http://www.w3.org",
  // Documentation links inside Convex client error messages.
  "https://docs.convex.dev",
  // An example deployment URL inside a Convex client error message.
  "https://happy-otter-123.convex.cloud",
  // The React error decoder link.
  "https://react.dev",
  // Changelog and repository links inside react-markdown and
  // hast-util-to-jsx-runtime error messages.
  "https://github.com",
]);

// Zod 4.4.3's v4/core/to-json-schema.js assigns these dialect identifiers to
// result.$schema. They are metadata, never fetch targets. Keep this exception
// narrower than an origin: a different path or query still needs review.
const reviewedVendorSchemaLiterals = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "http://json-schema.org/draft-07/schema#",
  "http://json-schema.org/draft-04/schema#",
]);

function isReviewedVendorSchemaLiteral(text: string, index: number): boolean {
  const quote = text[index - 1];
  if (quote !== '"' && quote !== "'") return false;
  return [...reviewedVendorSchemaLiterals].some((literal) =>
    text.startsWith(literal, index) && text[index + literal.length] === quote);
}

const pinnedConvexOrigins = new Set([
  "https://qualified-hummingbird-537.convex.cloud",
  "wss://qualified-hummingbird-537.convex.cloud",
  "https://qualified-hummingbird-537.convex.site",
]);

const originPattern = /(?:https?|wss?):\/\/[A-Za-z0-9._-]+/gu;

type Artifact = Readonly<{ name: string; text: string }>;

let artifacts: readonly Artifact[] = [];
let shell = "";
type OwnedBuildChild = Readonly<{
  exited: Promise<number>;
  kill: (signal?: number | NodeJS.Signals) => void;
}>;
const ownedBuildChildren = new Set<OwnedBuildChild>();

const controlledBuildEnvironment = new Set<string>([
  "OOMPA_RELEASE_COMMIT",
  "VERCEL",
  "VERCEL_GIT_COMMIT_SHA",
]);

async function readBoundedDiagnostics(
  stream: ReadableStream<Uint8Array>,
  maximumBytes = 1024 * 1024,
): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let retainedBytes = 0;
  let truncated = false;
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) {
      const remaining = Math.max(0, maximumBytes - retainedBytes);
      if (remaining < next.value.byteLength) truncated = true;
      if (remaining > 0) {
        const retained = next.value.subarray(0, remaining);
        retainedBytes += retained.byteLength;
        output += decoder.decode(retained, { stream: true });
      }
    }
  } finally {
    reader.releaseLock();
  }
  output += decoder.decode();
  return truncated ? `${output}\n[stderr truncated after ${String(maximumBytes)} bytes]\n` : output;
}

function trackOwnedBuildChild<Child extends OwnedBuildChild>(child: Child): Child {
  ownedBuildChildren.add(child);
  void child.exited.finally(() => ownedBuildChildren.delete(child));
  return child;
}

async function terminateOwnedBuild(child: OwnedBuildChild): Promise<void> {
  child.kill("SIGTERM");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    child.exited.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!stopped) child.kill("SIGKILL");
  await child.exited;
}

async function waitForOwnedBuild(child: OwnedBuildChild, deadlineMilliseconds: number): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      child.exited,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("build:app exceeded its owned test deadline")), deadlineMilliseconds);
      }),
    ]);
  } catch (error) {
    await terminateOwnedBuild(child);
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function runAppBuild(
  overrides: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<{ status: number; stderr: string }>> {
  for (const name of Object.keys(overrides)) {
    if (!controlledBuildEnvironment.has(name)) {
      throw new Error(`Unsupported controlled build environment name: ${name}`);
    }
  }
  const environment = Object.fromEntries([
    ...Object.entries(process.env).filter(([name, value]) =>
      value !== undefined && !controlledBuildEnvironment.has(name)),
    ...Object.entries(overrides).filter((entry): entry is [string, string] =>
      entry[1] !== undefined),
  ]);
  const build = trackOwnedBuildChild(Bun.spawn([process.execPath, "run", "build:app"], {
    cwd: repositoryRoot,
    env: environment,
    stderr: "pipe",
    stdout: "inherit",
  }));
  const diagnostics = readBoundedDiagnostics(build.stderr);
  try {
    const status = await waitForOwnedBuild(build, 170_000);
    return { status, stderr: await diagnostics };
  } catch (error) {
    await diagnostics;
    throw error;
  }
}

afterAll(async () => {
  const unsettled = [...ownedBuildChildren];
  await Promise.allSettled(unsettled.map(terminateOwnedBuild));
}, 10_000);

beforeAll(async () => {
  const build = await runAppBuild({
    VERCEL: "1",
    VERCEL_GIT_COMMIT_SHA: buildSourceCommit,
  });
  if (build.status !== 0) throw new Error(`build:app failed: ${build.stderr}`);
  const inventory = await readAppInventory(distributionRoot);
  const publication: unknown = JSON.parse((await readAppOrdinary(
    join(repositoryRoot, "tmp", "build-app", "current.json"),
  )).toString("utf8"));
  expect(inventory).toEqual(parseAppPublication(publication));
  artifacts = await Promise.all(inventory.map(async (item) => {
    const bytes = await readAppOrdinary(join(distributionRoot, item.path));
    expect({ bytes: bytes.byteLength, sha256: appSha256(bytes) }).toEqual({ bytes: item.bytes, sha256: item.sha256 });
    return { name: item.path, text: bytes.toString("utf8") };
  }));
  shell = (await readAppOrdinary(join(distributionRoot, "index.html"))).toString("utf8");
}, 180_000);

describe("built shell", () => {
  test("emits one module entry, a synchronous appearance bootstrap, and foundation before recipes", () => {
    expect(artifacts.some((artifact) => artifact.name === "index.html")).toBe(true);
    expect(artifacts.filter((artifact) => artifact.name.endsWith(".js")).length)
      .toBeGreaterThanOrEqual(2);
    expect(artifacts.filter((artifact) => artifact.name.endsWith(".css")).length).toBe(2);
    const stylesheets = [...shell.matchAll(/<link rel="stylesheet" href="([^"]+)">/gu)].map((match) => match[1]);
    expect(stylesheets).toHaveLength(2);
    expect(stylesheets[0]).toMatch(/^\/graphs\/client\/assets\/[^/]+\.css$/u);
    expect(stylesheets[1]).toBe("/stylex.css");
    const scripts = [...shell.matchAll(/<script type="module" src="([^"]+)"><\/script>/gu)].map((match) => match[1]);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toMatch(/^\/graphs\/client\/assets\/[^/]+\.js$/u);
    const bootstraps = [...shell.matchAll(/<script src="([^"]+)"><\/script>/gu)].map((match) => match[1]);
    expect(bootstraps).toHaveLength(1);
    expect(bootstraps[0]).toMatch(/^\/graphs\/client\/assets\/appearance-[A-Za-z0-9_-]+\.js$/u);
    expect([...shell.matchAll(/<script\b/gu)]).toHaveLength(2);
    expect(shell).not.toMatch(/<script[^>]*\b(?:async|defer)\b/u);
    expect(shell.indexOf(`<script src="${bootstraps[0]}"`)).toBeLessThan(shell.indexOf("</head>"));
    expect(shell.indexOf('href="/stylex.css"')).toBeLessThan(shell.indexOf(`<script src="${bootstraps[0]}"`));
    expect(shell).toContain(`<html lang="en" data-hraness-theme="paper" data-palette="paper" data-theme="light" class="${getDesignPaletteTheme("paper", "light").className}">`);
    for (const target of [...stylesheets, ...scripts, ...bootstraps]) {
      expect(artifacts.some(({ name }) => `/${name}` === target)).toBe(true);
    }
    expect(shell.indexOf('href="/stylex.css"')).toBeLessThan(shell.indexOf("</head>"));
    expect(shell.indexOf("</head>")).toBeLessThan(shell.indexOf('<script type="module"'));
  });

  test("preserves the complete authored shell metadata and root boundary", async () => {
    const authored = await readFile(join(appRoot, "index.html"), "utf8");
    const unlinked = shell.replace(
      `<html lang="en" data-hraness-theme="paper" data-palette="paper" data-theme="light" class="${getDesignPaletteTheme("paper", "light").className}">`,
      '<html lang="en" data-hraness-theme="paper" data-palette="paper" data-theme="light">',
    ).replace(/<link rel="stylesheet" href="\/graphs\/client\/assets\/[^/]+\.css">\n {4}<link rel="stylesheet" href="\/stylex\.css">\n {4}<script src="\/graphs\/client\/assets\/appearance-[A-Za-z0-9_-]+\.js"><\/script>\n {2}/u, "")
      .replace(/<script type="module" src="\/graphs\/client\/assets\/[^/]+\.js"><\/script>/u, '<script type="module" src="/src/main.tsx"></script>');
    expect(unlinked).toBe(authored);
  });

  test("contains only the closed public graph and separate marker, with no receipts, maps, or source paths", async () => {
    for (const artifact of artifacts) {
      expect(artifact.name === ".well-known/oompa-app.json"
        || artifact.name === "index.html" || artifact.name === "stylex.css"
        || /^graphs\/client\/assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(?:js|css)$/u.test(artifact.name)).toBe(true);
      expect(artifact.text).not.toContain(repositoryRoot);
      expect(artifact.text).not.toContain(".stylex-generation/");
    }
    expect(artifacts.filter(({ name }) => name.endsWith(".json")).map(({ name }) => name))
      .toEqual([".well-known/oompa-app.json"]);
    expect(artifacts.some(({ name }) => name.endsWith(".map"))).toBe(false);
    const foundation = artifacts.find(({ name }) => /^graphs\/client\/assets\/[^/]+\.css$/u.test(name));
    expect(foundation?.text).toMatch(/--ui-radius\s*:\s*0?\.75rem/u);
    expect(foundation?.text).toMatch(/--color-attention\s*:\s*var\(--warning\)/u);
    expect(foundation?.text).toContain("::-webkit-date-and-time-value");
    const recipes = artifacts.find(({ name }) => name === "stylex.css");
    expect(recipes?.text).toContain("components.hraness-stylex.priority");
    expect(recipes?.text).not.toContain("components.hraness-ui.priority");
    expect(recipes?.text).toMatch(/animation-duration\s*:\s*2\.4s/u);
    expect(recipes?.text).toContain("var(--color-attention)");
    expect(recipes?.text).toMatch(/prefers-reduced-motion\s*:\s*reduce/u);
    for (const artifact of artifacts) {
      expect(artifact.text).not.toMatch(/(?:\/\/[#@]|\/\*[#@])\s*source(?:Mapping)?URL\s*=/u);
    }
    const javascript = artifacts.filter(({ name }) => name.endsWith(".js"));
    for (const artifact of javascript) {
      expect(artifact.text).not.toContain("@stylexjs/stylex/lib/stylex-inject");
    }
    const reactDomRoot = dirname(fileURLToPath(import.meta.resolve("react-dom/package.json")));
    // Installed package files follow the package manager's mode/link policy,
    // not the private publication contract. Bind these dependency bytes through
    // the exact reviewed manifest, source digest, and emitted-function digest.
    assertReviewedRuntimeStyleBoundary(javascript, {
      manifest: JSON.parse(await readFile(join(reactDomRoot, "package.json"), "utf8")) as unknown,
      productionClientSha256: appSha256(await readFile(join(reactDomRoot, "cjs/react-dom-client.production.js"))),
    });
  });

  test("carries the mobile viewport with the safe-area opt in", () => {
    expect(shell).toContain("viewport-fit=cover");
    expect(shell).toContain("width=device-width");
  });

  test("has no inline script", () => {
    expect(shell).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/u);
  });

  test("has no style element, because style-src is 'self'", () => {
    for (const artifact of artifacts) {
      expect(artifact.text).not.toMatch(/<style[\s>]/u);
    }
  });

  test("emits the exact deterministic app source marker", async () => {
    const packageManifest = JSON.parse(
      await readFile(join(repositoryRoot, "package.json"), "utf8"),
    ) as { version?: unknown };
    const expected = {
      generation: 1,
      product: "Oompa App",
      repository: {
        id: 1_343_008_607,
        path: "hraness/oompa",
      },
      schemaVersion: 1,
      source: {
        commit: buildSourceCommit,
      },
      version: packageManifest.version,
    };
    const marker = artifacts.find((artifact) =>
      artifact.name === ".well-known/oompa-app.json");

    expect(packageManifest.version).toBe("0.8.3");
    expect(buildSourceCommit).toMatch(/^[0-9a-f]{40}$/u);
    expect(marker?.text).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(JSON.parse(marker?.text ?? "null")).toEqual(expected);
  });

  test("uses the root-site-compatible source fallbacks outside Vercel", async () => {
    const releaseBuild = await runAppBuild({ OOMPA_RELEASE_COMMIT: buildSourceCommit });
    expect(releaseBuild.status).toBe(0);
    const releaseMarker = JSON.parse(
      await readFile(join(distributionRoot, ".well-known/oompa-app.json"), "utf8"),
    ) as { source?: { commit?: unknown } };
    expect(releaseMarker.source?.commit).toBe(buildSourceCommit);

    const localBuild = await runAppBuild({});
    expect(localBuild.status).toBe(0);
    const localMarker = JSON.parse(
      await readFile(join(distributionRoot, ".well-known/oompa-app.json"), "utf8"),
    ) as { source?: { commit?: unknown } };
    expect(localMarker.source?.commit).toBe("local");
  }, 180_000);

  test("refuses a Vercel build without an exact lowercase source commit", async () => {
    for (const sourceCommit of [
      undefined,
      "",
      "not-a-commit",
      "A".repeat(40),
      "a".repeat(39),
      "a".repeat(41),
    ]) {
      const build = await runAppBuild({
        OOMPA_RELEASE_COMMIT: buildSourceCommit,
        VERCEL: "1",
        VERCEL_GIT_COMMIT_SHA: sourceCommit,
      });
      expect(build.status).not.toBe(0);
      expect(build.stderr).toContain(
        "A Vercel app build requires an exact source commit marker.",
      );
    }
  }, 180_000);
});

describe("bundle invariants", () => {
  /*
   * `style-src 'self'` blocks a style attribute, and a violation is invisible
   * until a browser drops the rule, so the built text is the fixture. The
   * lookbehind excludes an assignment to a `style` member on an object, which
   * is how a vendored renderer builds a React props record: that is a property
   * write inside library code, not an attribute this app emits, and the
   * component overrides in `app/src/markdown/markdown.tsx` drop the prop before
   * it can reach an element. Anything that reads as an attribute, in the shell
   * or in a bundle, still fails here.
   */
  test("no output sets a style attribute", () => {
    for (const artifact of artifacts) {
      const offenders = [...artifact.text.matchAll(/(?<![.\w$])style\s*=/gu)];
      expect({ file: artifact.name, offenders: offenders.length }).toEqual({
        file: artifact.name,
        offenders: 0,
      });
    }
  });

  test("no output references a service worker", () => {
    for (const artifact of artifacts) {
      expect(artifact.text.includes("navigator.serviceWorker")).toBe(false);
      expect(artifact.text.includes("serviceWorker")).toBe(false);
    }
  });

  test("no output calls eval", () => {
    for (const artifact of artifacts) {
      expect(artifact.text.includes("eval(")).toBe(false);
    }
  });

  test("no output embeds a data URI asset except the single byte-verified authored favicon", async () => {
    const favicon = await readFile(join(repositoryRoot, "site", "favicon.svg"));
    const tag = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${favicon.toString("base64")}">`;
    expect(shell.split(tag)).toHaveLength(2);
    expect([...shell.matchAll(/<link\b[^>]*\brel="[^"]*icon[^"]*"[^>]*>/gu)].map((match) => match[0])).toEqual([tag]);
    expect(shell.slice(shell.indexOf("<head>") + "<head>".length).trimStart().startsWith(tag)).toBe(true);
    for (const artifact of artifacts) {
      const remaining = artifact.name === "index.html" ? artifact.text.replace(tag, "") : artifact.text;
      expect(remaining).not.toMatch(/data:[a-z]+\/[a-z0-9.+-]+;base64,/iu);
    }
  });

  test("every absolute URL is a pinned Convex origin or a reviewed vendor literal", () => {
    const unexpected = new Set<string>();
    for (const artifact of artifacts) {
      for (const match of artifact.text.matchAll(originPattern)) {
        const origin = match[0];
        if (pinnedConvexOrigins.has(origin) || reviewedVendorOrigins.has(origin)) continue;
        if (isReviewedVendorSchemaLiteral(artifact.text, match.index)) continue;
        unexpected.add(`${artifact.name}: ${origin}`);
      }
    }
    expect([...unexpected]).toEqual([]);
  });

  test("schema metadata exceptions accept only the reviewed complete literals", () => {
    for (const literal of reviewedVendorSchemaLiterals) {
      for (const quote of ['"', "'"]) {
        expect(isReviewedVendorSchemaLiteral(`${quote}${literal}${quote}`, 1)).toBe(true);
        for (const suffix of ["/other", "?token=example", "#other"]) {
          expect(isReviewedVendorSchemaLiteral(`${quote}${literal}${suffix}${quote}`, 1))
            .toBe(false);
        }
      }
      expect(isReviewedVendorSchemaLiteral(literal, 0)).toBe(false);
    }
    expect(isReviewedVendorSchemaLiteral('"https://json-schema.org/unreviewed"', 1)).toBe(false);
  });

  /*
   * `img-src` no longer says `'none'`, so the second half of that guarantee is
   * that nothing in the bundle names a remote image to begin with. The origin
   * allowlist above already covers every absolute URL; this states the image
   * case directly, because a single `src="https://..."` slipping in is the one
   * way the relaxed directive could start mattering.
   */
  test("no output names a remote src, so no image request can leave the tab", () => {
    for (const artifact of artifacts) {
      expect(artifact.text).not.toMatch(/src\s*=\s*["'`]https?:\/\//u);
    }
  });

  test("names the pinned deployment", () => {
    const scripts = artifacts.filter((artifact) => artifact.name.endsWith(".js"));
    expect(scripts.some((artifact) =>
      artifact.text.includes("https://qualified-hummingbird-537.convex.cloud"))).toBe(true);
  });
});

type ProjectConfiguration = Readonly<{
  headers: { headers: { key: string; value: string }[]; source: string }[];
  ignoreCommand: string;
  outputDirectory: string;
  rewrites: { destination: string; source: string }[];
}>;

async function readProjectConfiguration(): Promise<ProjectConfiguration> {
  return JSON.parse(await readFile(join(appRoot, "vercel.json"), "utf8")) as ProjectConfiguration;
}

function headerFinder(configuration: ProjectConfiguration) {
  const all = configuration.headers.flatMap((entry) =>
    entry.headers.map((header) => [entry.source, header.key, header.value] as const));
  return (source: string, key: string) =>
    all.find(([entrySource, entryKey]) => entrySource === source && entryKey === key)?.[2];
}

describe("vercel project headers", () => {
  test("serves every emitted graph, recipe, and marker instead of rewriting it to the shell", async () => {
    const configuration = await readProjectConfiguration();
    expect(configuration.rewrites).toEqual([{
      destination: "/index.html",
      source: "/((?!(?:assets/|graphs/client/assets/|stylex\\.css$|\\.well-known/)).*)",
    }]);
    const rewrite = new RegExp(`^${configuration.rewrites[0]!.source}$`, "u");
    for (const { name } of artifacts.filter(({ name }) => name !== "index.html")) {
      expect({ name, rewritten: rewrite.test(`/${name}`) }).toEqual({ name, rewritten: false });
    }
    for (const path of ["/", "/index.html", "/session/example", "/settings", "/stylexXcss", "/stylex.css/other"]) expect(rewrite.test(path)).toBe(true);
    expect(rewrite.test("/assets/legacy.js")).toBe(false);
    expect(rewrite.test("/.well-known/oompa-app.json")).toBe(false);
  });

  test("serve the F1 policy, the referrer policy, and the clipboard denial", async () => {
    const configuration = await readProjectConfiguration();
    const find = headerFinder(configuration);

    expect(configuration.outputDirectory).toBe("dist");
    // Vercel skips a build on exit 0. This exact inequality therefore keeps
    // production builds running while ignoring preview deployments.
    expect(configuration.ignoreCommand).toBe('test "$VERCEL_ENV" != "production"');
    expect(find("/(.*)", "Content-Security-Policy")).toBe(
      "default-src 'none'; script-src 'self'; "
      + "connect-src https://qualified-hummingbird-537.convex.cloud "
      + "wss://qualified-hummingbird-537.convex.cloud "
      + "https://qualified-hummingbird-537.convex.site; "
      + "style-src 'self'; img-src data: blob:; font-src 'self'; base-uri 'none'; object-src 'none'; "
      + "form-action 'none'; worker-src 'none'; manifest-src 'none'; frame-ancestors 'none'",
    );
    expect(find("/(.*)", "Referrer-Policy")).toBe("no-referrer");
    expect(find("/(.*)", "X-Content-Type-Options")).toBe("nosniff");
    expect(find("/(.*)", "Permissions-Policy")).toContain("clipboard-read=()");
    expect(find("/", "Cache-Control")).toBe("no-store");
    expect(find("/index.html", "Cache-Control")).toBe("no-store");
    expect(find("/.well-known/oompa-app.json", "Cache-Control")).toBe("no-store");
  });

  test("the SPA fallback cannot rewrite assets or well-known files", async () => {
    const configuration = await readProjectConfiguration();
    expect(configuration.rewrites).toEqual([{
      destination: "/index.html",
      source: "/((?!(?:assets/|graphs/client/assets/|stylex\\.css$|\\.well-known/)).*)",
    }]);
    const fallback = configuration.rewrites[0];
    if (fallback === undefined) throw new Error("missing SPA fallback fixture");
    const matcher = new RegExp(`^${fallback.source}$`, "u");

    expect(matcher.test("/sessions/session_12345678")).toBe(true);
    expect(matcher.test("/assets/index-example.js")).toBe(false);
    expect(matcher.test("/graphs/client/assets/index-example.js")).toBe(false);
    expect(matcher.test("/stylex.css")).toBe(false);
    expect(matcher.test("/stylex.css/other")).toBe(true);
    expect(matcher.test("/.well-known/oompa-app.json")).toBe(false);
  });

  /*
   * Attachments need an `img` element, so `img-src` moved off `'none'`. What it
   * moved to is the narrowest thing that renders a thumbnail: two schemes and no
   * origin at all. A `data:` or `blob:` URL resolves to bytes this page already
   * holds, minted in this tab; neither can fetch anything, so no image request
   * ever leaves the browser and no third party learns that an image was viewed.
   * A host, a wildcard, or `'self'` appearing here would be a real widening and
   * fails this test.
   */
  test("img-src resolves only bytes the page already holds", async () => {
    const policy = headerFinder(await readProjectConfiguration())("/(.*)", "Content-Security-Policy")
      ?? "";
    const directive = policy
      .split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("img-src "));
    expect(directive).toBe("img-src data: blob:");
    const sources = (directive ?? "").slice("img-src ".length).split(/\s+/u);
    expect(sources).toEqual(["data:", "blob:"]);
    for (const source of sources) {
      expect(source.includes("//")).toBe(false);
      expect(source.includes("*")).toBe(false);
      expect(source.startsWith("http")).toBe(false);
    }
  });
});
