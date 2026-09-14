import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import appConfiguration from "../app/vercel.json";
import { createAppSourceMarker } from "./app-source-marker";
import { canonicalDigest } from "./release-evidence";
import { appLocalArtifactProofSchema, appPublicArtifactProofSchema, appSourceArtifactInventorySchema,
  observePublicAppArtifacts, type AppSourceArtifact } from "./app-source-artifacts";

const sourceCommit = "6".repeat(40);
const releaseVersion = "0.6.1";
const nonce = "123e4567-e89b-42d3-a456-426614174000";
const markerPath = ".well-known/oompa-app.json";
const bodies = new Map<string, string>([
  [markerPath, createAppSourceMarker({ version: releaseVersion }, { OOMPA_RELEASE_COMMIT: sourceCommit })],
  ["graphs/client/assets/appearance-test.js", "export const appearance = true;\n"],
  ["graphs/client/assets/foundation.css", "body { margin: 0 }\n"],
  ["graphs/client/assets/main-test.js", "console.log('app');\n"],
  ["index.html", "<!doctype html><html><body>App</body></html>\n"],
  ["stylex.css", ".app { color: black }\n"],
]);
const artifacts = [...bodies].map(([path, body]) => ({ path, bytes: Buffer.byteLength(body),
  sha256: createHash("sha256").update(body).digest("hex") }));
const local = appLocalArtifactProofSchema.parse({
  kind: "oompa-local-production-app-artifacts", sourceCommit, releaseVersion, runtimeVersion: "1.3.14",
  packageSha256: "a".repeat(64), lockSha256: "b".repeat(64), publicationSha256: "c".repeat(64), artifacts,
});
const marker: AppSourceArtifact | undefined = artifacts[0];
if (marker === undefined) throw new Error("fixture_marker_missing");
const headers = Object.fromEntries(appConfiguration.headers.flatMap((entry) => entry.source === "/(.*)"
  ? entry.headers.map(({ key, value }) => [key, value]) : []));
const observe = (change?: (response: Response, path: string) => Response) => {
  const requests: string[] = [];
  const proof = observePublicAppArtifacts({ local, marker, nonce, fetcher: async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.href);
    expect(url.origin).toBe("https://app.oompa.app");
    expect(url.search).toBe(`?proof=${nonce}`);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const body = bodies.get(path);
    if (body === undefined) throw new Error("fixture_path_invalid");
    const response = new Response(body, { headers: { ...headers, "cache-control": "no-store",
      "content-type": path.endsWith(".html") ? "text/html" : path.endsWith(".css") ? "text/css" : "text/javascript" } });
    Object.defineProperty(response, "url", { value: url.href, configurable: true });
    return change?.(response, path) ?? response;
  } });
  return { proof, requests };
};

describe("complete app publication proof", () => {
  test("observes all unique publication bytes and the extra canonical entry without credentials", async () => {
    const run = observe();
    const proof = await run.proof;
    expect(run.requests).toHaveLength(artifacts.length);
    expect(run.requests.at(-1)).toBe(`https://app.oompa.app/?proof=${nonce}`);
    expect(proof.artifactManifestDigest).toBe(canonicalDigest(artifacts));
    expect(proof.observedPublicBytes).toBe(proof.artifactBytes + Buffer.byteLength(bodies.get("index.html") ?? ""));
    expect(proof.unlistedRemoteFilesObserved).toBe(false);
  });

  test("refuses changed, truncated, extra, redirected, wrong-type and missing-header responses", async () => {
    const mutations: ((response: Response) => Response)[] = [
      (response) => { response.headers.delete("x-frame-options"); return response; },
      (response) => { response.headers.set("content-type", "text/plain"); return response; },
      (response) => { Object.defineProperty(response, "url", { value: "https://attacker.invalid/" }); return response; },
      (response) => { Object.defineProperty(response, "redirected", { value: true }); return response; },
      ...["", "changed", "extra".repeat(100)].map((body) => (response: Response) => {
        const changed = new Response(body, { headers: response.headers });
        Object.defineProperty(changed, "url", { value: response.url });
        return changed;
      }),
    ];
    for (const mutation of mutations) await expect(observe(mutation).proof).rejects.toThrow("app_source_artifacts_invalid");
    await expect(observe((response, path) => {
      if (path === "index.html") response.headers.set("cache-control", "public");
      return response;
    }).proof).rejects.toThrow("app_source_artifacts_invalid");
  });

  test("rejects malformed inventories and includes the duplicated canonical entry in its byte budget", () => {
    for (const changed of [artifacts.slice(1), [...artifacts, marker], [...artifacts].reverse(),
      artifacts.map((item, i) => i === 1 ? { ...item, path: "../secret.js" } : item),
      artifacts.map((item, i) => i === 1 ? { ...item, bytes: 8 * 1024 * 1024 + 1 } : item),
      artifacts.map((item) => ({ ...item, bytes: item.path === markerPath ? item.bytes : 6 * 1024 * 1024 })),
    ]) expect(appSourceArtifactInventorySchema.safeParse(changed).success).toBe(false);
    for (const changes of [{ sourceCommit: "7".repeat(40) }, { releaseVersion: "0.6.2" }, { runtimeVersion: "1.3.13" },
      { artifacts: artifacts.map((item, i) => i === 0 ? { ...item, sha256: "f".repeat(64) } : item) }]) {
      expect(appLocalArtifactProofSchema.safeParse({ ...local, ...changes }).success).toBe(false);
    }
  });

  test("cannot reclassify incomplete observations or alter retained manifest counters", async () => {
    const proof = await observe().proof;
    for (const change of [{ artifactCount: 7 }, { artifactBytes: proof.artifactBytes + 1 },
      { observedPublicBytes: proof.artifactBytes }, { canonicalEntryMatches: false },
      { completeLocalManifestMatches: false }, { unlistedRemoteFilesObserved: true },
      { securityHeadersDigest: "0".repeat(64) }, { artifactManifestDigest: "0".repeat(64) }]) {
      expect(appPublicArtifactProofSchema.safeParse({ ...proof, ...change }).success).toBe(false);
    }
    let calls = 0;
    await expect(observePublicAppArtifacts({ local, marker: { ...marker, bytes: marker.bytes + 1 }, nonce,
      fetcher: async () => { calls += 1; throw new Error("unexpected"); } })).rejects.toThrow("app_source_artifacts_invalid");
    expect(calls).toBe(0);
  });
});
