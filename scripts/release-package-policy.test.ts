import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  OOMPA_RELEASE_OH_VERSION,
  assertReleasePackageReady,
  inspectReleasePackage,
  releaseArchiveName,
} from "./release-package-policy";

const readyManifest = {
  bin: { oompa: "./src/cli.ts" },
  dependencies: { "@hraness/oh": "0.10.8", zod: "4.4.3" },
  license: "MIT",
  name: "@hraness/oompa",
  publishConfig: { access: "public", registry: "https://registry.npmjs.org" },
  version: "1.2.3",
};

describe("Oompa public release package policy", () => {
  test("accepts one public MIT scoped package with the exact public Oh release", () => {
    expect(OOMPA_RELEASE_OH_VERSION).toBe("0.10.8");
    expect(assertReleasePackageReady(readyManifest)).toEqual({
      blockers: [],
      name: "@hraness/oompa",
      version: "1.2.3",
    });
    expect(releaseArchiveName("1.2.3")).toBe("hraness-oompa-1.2.3.tgz");
  });

  test("fails closed on GitHub, URL, workspace, range, moving, and wrong exact Oh dependencies", () => {
    for (const version of [
      "github:hraness/oh#v0.4.1",
      "https://example.com/oh.tgz",
      "workspace:*",
      "^0.4.1",
      "latest",
      "0.4.0",
      "0.4.2",
    ]) {
      const manifest = structuredClone(readyManifest);
      manifest.dependencies["@hraness/oh"] = version;
      expect(() => assertReleasePackageReady(manifest)).toThrow("runtime dependency policy");
    }
  });

  test("requires the Oh dependency to be present", () => {
    const manifest = structuredClone(readyManifest) as {
      dependencies: Record<string, string>;
    };
    delete manifest.dependencies["@hraness/oh"];
    expect(inspectReleasePackage(manifest).blockers).toEqual(["@hraness/oh=<missing>"]);
  });

  test("records the current public Oh dependency as release-ready", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(import.meta.dir, "..", "package.json"), "utf8"),
    ) as unknown;
    expect(inspectReleasePackage(manifest)).toEqual({
      blockers: [],
      name: "@hraness/oompa",
      version: "0.8.5",
    });
    expect(assertReleasePackageReady(manifest).blockers).toEqual([]);
  });
});
