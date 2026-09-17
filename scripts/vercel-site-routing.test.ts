import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { getTransformedRoutes } from "@vercel/routing-utils";
import fc from "fast-check";
import { z } from "zod";

// The provider compiler must run before assertions. Matching the input header
// pattern alone misses earlier terminal routes and strict empty-segment rules.
const headerSchema = z.object({
  source: z.string().max(2048),
  headers: z.array(z.object({ key: z.string().max(100), value: z.string().max(8192) }).strict()).max(20),
}).strict();
const configurationSchema = z.object({
  $schema: z.string().url(),
  buildCommand: z.literal("bun run build:site"),
  cleanUrls: z.literal(true),
  framework: z.null(),
  outputDirectory: z.literal("dist/site"),
  trailingSlash: z.boolean().optional(),
  headers: z.array(headerSchema).length(3),
  redirects: z.array(z.object({
    source: z.string().max(2048),
    destination: z.string().max(2048),
    permanent: z.literal(true),
  }).strict()).max(10).optional(),
}).strict();
type Configuration = z.infer<typeof configurationSchema>;
const configuration = configurationSchema.parse(JSON.parse(await readFile(
  new URL("../vercel.json", import.meta.url), "utf8",
)) as unknown);

function compiledRoutes(value: Configuration) {
  const { trailingSlash, redirects, ...required } = value;
  const compiled = getTransformedRoutes({
    ...required,
    ...(trailingSlash === undefined ? {} : { trailingSlash }),
    ...(redirects === undefined ? {} : { redirects }),
  });
  expect(compiled.error).toBeNull();
  if (compiled.error !== null || compiled.routes === null) throw new Error("Invalid routing configuration");
  return compiled.routes;
}

function observe(routes: ReturnType<typeof compiledRoutes>, pathname: string) {
  const headers: Record<string, string> = {};
  for (const route of routes) {
    if ("handle" in route || typeof route.src !== "string") throw new Error("Unsupported compiled route");
    for (const key of Object.keys(route)) {
      if (!["src", "headers", "status", "continue"].includes(key)) throw new Error(`Unsupported compiled field: ${key}`);
    }
    const match = new RegExp(route.src).exec(pathname);
    if (match === null) continue;
    for (const [key, value] of Object.entries(route.headers ?? {})) {
      if (typeof value !== "string") throw new Error("Unsupported compiled header");
      headers[key] = value;
    }
    if (route.continue !== true) {
      return { headers, terminal: route.src, status: route.status ?? null,
        location: headers.Location?.replace(/\$(\d+)/gu,
          (_whole: string, index: string) => match[Number(index)] ?? "") ?? null };
    }
  }
  return { headers, terminal: null, status: null, location: null };
}

function follow(routes: ReturnType<typeof compiledRoutes>, initial: string) {
  const paths = [initial];
  for (let hop = 0; hop <= 3; hop += 1) {
    const result = observe(routes, paths.at(-1)!);
    if (result.location === null) return { ...result, paths };
    expect(result.status).toBe(308);
    expect(result.location.startsWith("/")).toBe(true);
    expect(result.location.startsWith("//")).toBe(false);
    expect(paths).not.toContain(result.location);
    paths.push(result.location);
  }
  throw new Error("Canonical redirect bound exceeded");
}

const expectedHeaders = (value: Configuration, index: number): Record<string, string> =>
  Object.fromEntries(value.headers[index]!.headers.map(({ key, value: headerValue }) => [key, headerValue]));
function proveHeaders(value: Configuration, pathname: string, policyIndex: number) {
  const result = follow(compiledRoutes(value), pathname);
  expect(result.terminal).toBeNull();
  expect(result.headers).toEqual(expectedHeaders(value, policyIndex));
  return result;
}

const pages = ["/", "/docs/", "/docs/start/", "/docs/web/", "/docs/sessions/", "/docs/reference/", "/docs/status/", "/privacy/", "/preview/"] as const;
const externalRedirects = new Map([
  ["/pr", "https://hraness.com/pr"],
  ["/pr/", "https://hraness.com/pr"],
] as const);
const wellKnown = ["/.well-known/security.txt", "/.well-known/hra.json"] as const;

describe("compiled Vercel site routing", () => {
  test("well-known data files reach the complete declared headers without redirects", () => {
    for (const path of wellKnown) expect(proveHeaders(configuration, path, 2).paths).toEqual([path]);
  });

  test("the canonical example document and descendants receive the isolated example policy", () => {
    for (const path of ["/examples/app/", "/examples/app/index.html", "/examples/app/assets/main.js", "/examples/app/assets/style.css"]) {
      proveHeaders(configuration, path, 1);
    }
  });

  test("the pr board permanently redirects its document routes to hraness.com while data keeps serving", () => {
    const routes = compiledRoutes(configuration);
    for (const [path, destination] of externalRedirects) {
      const result = observe(routes, path);
      expect(result.status).toBe(308);
      expect(result.location).toBe(destination);
    }
    const indexHop = observe(routes, "/pr/index.html");
    expect(indexHop.status).toBe(308);
    expect(indexHop.location).toBe("/pr");
    const finalHop = observe(routes, indexHop.location!);
    expect(finalHop.status).toBe(308);
    expect(finalHop.location).toBe("https://hraness.com/pr");
    for (const path of ["/pr/data/snapshot.json", "/pr/data/history.json"]) {
      expect(proveHeaders(configuration, path, 2).paths).toEqual([path]);
    }
  });

  test("every canonical page keeps its exact policy without a redirect", () => {
    for (const path of pages) expect(proveHeaders(configuration, path, path === "/preview/" ? 0 : 2).paths).toEqual([path]);
  });

  test("legacy HTML and slashless page URLs converge to the same canonical path within three redirects", () => {
    for (const path of [...pages, "/examples/app/"]) {
      const index = path === "/preview/" ? 0 : path === "/examples/app/" ? 1 : 2;
      for (const input of [`${path}index.html`, ...(path === "/" ? [] : [path.slice(0, -1)])]) {
        expect(proveHeaders(configuration, input, index).paths.at(-1)).toBe(path);
      }
    }
  });

  test("ordinary asset slash normalization keeps headers without touching well-known data paths", () => {
    const routes = compiledRoutes(configuration);
    for (const path of ["/robots.txt", "/site.js", "/graphs/foundation/assets/style.css"]) {
      expect(proveHeaders(configuration, `${path}/`, 2).paths).toEqual([`${path}/`, path]);
    }
    for (const path of wellKnown) expect(observe(routes, `${path}/`).location).toBeNull();
  });

  test("slash normalization excludes the exact well-known namespace, not neighboring names", () => {
    for (const path of ["/.well-known", "/.well-known/", "/.well-known/acme-challenge/token", "/.well-known/keys/jwks.json/"]) {
      expect(proveHeaders(configuration, path, 2).paths).toEqual([path]);
    }
    for (const path of ["/.well-known-extra/token", "/.well-knownness/token"]) {
      expect(proveHeaders(configuration, path, 2).paths).toEqual([path, `${path}/`]);
    }
  });

  test("adding an exact header rule cannot bypass the old automatic terminal well-known route", () => {
    const oldAutomatic = { ...configuration, trailingSlash: true };
    const compiled = compiledRoutes({ ...oldAutomatic,
      headers: [{ source: wellKnown[0], headers: configuration.headers[2]!.headers }, ...configuration.headers],
    });
    const result = observe(compiled, wellKnown[0]);
    expect(result.terminal).not.toBeNull();
    expect(result.headers).toEqual({});
  });

  test("the old star parameter misses the canonical empty trailing segment", () => {
    const oldPattern = structuredClone(configuration);
    oldPattern.headers[1]!.source = "/examples/app/:path*";
    const routes = compiledRoutes(oldPattern);
    expect(observe(routes, "/examples/app/").headers).toEqual({});
    expect(observe(routes, "/examples/app/assets/main.js").headers).toEqual(expectedHeaders(configuration, 1));
  });

  test("nested example routes and prefix lookalikes cannot exchange policies", () => {
    const segment = fc.stringMatching(/^[a-z][a-z0-9-]{0,14}$/u);
    const routes = compiledRoutes(configuration);
    fc.assert(fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (parts) => {
      const suffix = `${parts.join("/")}.js`;
      expect(observe(routes, `/examples/app/${suffix}`).headers).toEqual(expectedHeaders(configuration, 1));
      for (const prefix of ["/examples/application/", "/examples/app-extra/", "/preview-extra/"]) {
        expect(observe(routes, `${prefix}${suffix}`).headers).toEqual(expectedHeaders(configuration, 2));
      }
    }), { numRuns: 100, seed: 170 });
  });
});
