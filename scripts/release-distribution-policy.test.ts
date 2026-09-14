import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";

import {
  assertReviewedReleaseCommitOnStableBranch,
  assertReleaseAssetBytes,
  classifyNpmRegistryRelease,
  npmRegistryReleaseMetadata,
  parseGitHubRelease,
  parseGitHubBranchCommitSha,
  parseNpmRelease,
} from "./release-distribution-policy";

const version = "1.2.3";
const tarball = Buffer.from("exact Oompa tarball");
const tarballDigest = createHash("sha256").update(tarball).digest("hex");
const checksum = Buffer.from(`${tarballDigest}  hraness-oompa-1.2.3.tgz\n`);
const digest = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const asset = (name: string, bytes: Uint8Array, id: number) => ({
  browser_download_url: `https://github.com/hraness/oompa/releases/download/v1.2.3/${name}`,
  digest: `sha256:${digest(bytes)}`,
  id,
  name,
  size: bytes.byteLength,
  state: "uploaded",
});

describe("Oompa public distribution policy", () => {
  test("binds reviewed ancestry to one stable captured main commit", () => {
    const reviewedSha = "a".repeat(40);
    const nextSha = "b".repeat(40);
    const head = (sha: string) => ({
      object: {
        sha,
        type: "commit",
        url: `https://api.github.com/repos/hraness/oompa/git/commits/${sha}`,
      },
      ref: "refs/heads/main",
      url: "https://api.github.com/repos/hraness/oompa/git/refs/heads/main",
    });
    const comparison = (headSha: string, aheadBy: number, status: string) => ({
      ahead_by: aheadBy,
      base_commit: { sha: reviewedSha },
      behind_by: 0,
      commits: [],
      merge_base_commit: { sha: reviewedSha },
      status,
      total_commits: aheadBy,
      url: `https://api.github.com/repos/hraness/oompa/compare/${reviewedSha}...${headSha}`,
    });

    expect(parseGitHubBranchCommitSha(head(reviewedSha), "main")).toBe(reviewedSha);
    expect(() => assertReviewedReleaseCommitOnStableBranch(
      comparison(reviewedSha, 0, "identical"),
      head(reviewedSha),
      { branch: "main", headSha: reviewedSha, reviewedSha },
    )).not.toThrow();
    expect(() => assertReviewedReleaseCommitOnStableBranch(
      comparison(nextSha, 1, "ahead"),
      head(nextSha),
      { branch: "main", headSha: nextSha, reviewedSha },
    )).not.toThrow();
    expect(() => assertReviewedReleaseCommitOnStableBranch(
      comparison(reviewedSha, 0, "identical"),
      head(nextSha),
      { branch: "main", headSha: reviewedSha, reviewedSha },
    )).toThrow("moved during release authority verification");
  });

  test("rejects malformed, divergent, and internally inconsistent GitHub comparisons", () => {
    const reviewedSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const branchHead = {
      object: { sha: headSha, type: "commit" },
      ref: "refs/heads/main",
    };
    const exact = {
      ahead_by: 1,
      base_commit: { sha: reviewedSha },
      behind_by: 0,
      merge_base_commit: { sha: reviewedSha },
      status: "ahead",
      url: `https://api.github.com/repos/hraness/oompa/compare/${reviewedSha}...${headSha}`,
    };
    const assert = (value: unknown) => assertReviewedReleaseCommitOnStableBranch(
      value,
      branchHead,
      { branch: "main", headSha, reviewedSha },
    );

    for (const invalid of [
      { ...exact, ahead_by: -1 },
      { ...exact, ahead_by: 0 },
      { ...exact, behind_by: 1 },
      { ...exact, status: "diverged" },
      { ...exact, url: `https://api.github.com/repos/hraness/oompa/compare/${reviewedSha}...main` },
      { ...exact, base_commit: { sha: headSha } },
      { ...exact, merge_base_commit: { sha: headSha } },
    ]) expect(() => assert(invalid)).toThrow("not an ancestor");

    expect(() => assertReviewedReleaseCommitOnStableBranch(
      { ...exact, ahead_by: 0, status: "identical" },
      { ...branchHead, ref: "refs/heads/trunk" },
      { branch: "main", headSha, reviewedSha },
    )).toThrow("GitHub branch main is invalid");
  });

  test("requires npm trusted-publisher provenance", () => {
    const payload = {
      _npmUser: {
        email: "npm-oidc-no-reply@github.com",
        name: "GitHub Actions",
        trustedPublisher: { id: "github", oidcConfigId: "oidc:12345678-1234-1234-1234-123456789abc" },
      },
      dist: {
        attestations: {
          provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          url: "https://registry.npmjs.org/-/npm/v1/attestations/@hraness%2foompa@1.2.3",
        },
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        shasum: "b".repeat(40),
        tarball: "https://registry.npmjs.org/@hraness/oompa/-/oompa-1.2.3.tgz",
      },
      license: "MIT",
      name: "@hraness/oompa",
      version,
    };
    expect(parseNpmRelease(payload, version).tarball).toEndWith("/oompa-1.2.3.tgz");
    delete (payload._npmUser as { trustedPublisher?: unknown }).trustedPublisher;
    expect(() => parseNpmRelease(payload, version)).toThrow("trusted publisher");
  });

  test("classifies exact npm metadata and endpoint-specific package documents", async () => {
    const exact = { license: "MIT", name: "@hraness/oompa", version };
    const other = { license: "MIT", name: "@hraness/oompa", version: "1.2.2" };
    const packument = {
      _id: "@hraness/oompa",
      name: "@hraness/oompa",
      versions: { "1.2.2": other },
    };
    expect(classifyNpmRegistryRelease(exact, version)).toEqual(exact);
    expect(classifyNpmRegistryRelease(packument, version)).toBeNull();
    expect(classifyNpmRegistryRelease({
      ...packument,
      versions: { ...packument.versions, [version]: exact },
    }, version)).toEqual(exact);
    expect(() => classifyNpmRegistryRelease({
      ...packument,
      "dist-tags": { latest: "1.2.2" },
      versions: { ...packument.versions, [version]: exact },
    }, version, "latest")).toThrow("does not make the requested version latest");
    expect(classifyNpmRegistryRelease({
      ...packument,
      "dist-tags": { latest: version },
      versions: { ...packument.versions, [version]: exact },
    }, version, "latest")).toEqual(exact);
    expect(() => classifyNpmRegistryRelease({ ...packument, _id: ["@attacker", "oompa"].join("/") }, version))
      .toThrow("neither exact version metadata nor the exact package document");
    expect(() => classifyNpmRegistryRelease({
      ...packument,
      versions: { [version]: other },
    }, version)).toThrow("inexact version entry");
    const inherited = Object.create({ [version]: exact }) as Record<string, unknown>;
    expect(classifyNpmRegistryRelease({ ...packument, versions: inherited }, version)).toBeNull();

    const response = new Response(JSON.stringify(packument), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
    expect(await npmRegistryReleaseMetadata(response, version, "version")).toBeNull();
    const missing = new Response(JSON.stringify(`version not found: ${version}`), {
      headers: { "content-type": "application/json" },
      status: 404,
    });
    expect(await npmRegistryReleaseMetadata(missing, version, "version")).toBeNull();
    await expect(npmRegistryReleaseMetadata(new Response("not JSON", {
      headers: { "content-type": "text/plain" },
      status: 404,
    }), version, "version")).rejects.toThrow("did not return JSON");
  });

  test("requires exactly the immutable tarball and checksum bytes", () => {
    const coordinate = parseGitHubRelease({
      assets: [
        asset("hraness-oompa-1.2.3.tgz", tarball, 1),
        asset("SHA256SUMS", checksum, 2),
      ],
      draft: false,
      immutable: true,
      prerelease: false,
      tag_name: "v1.2.3",
    }, version);
    expect(() => assertReleaseAssetBytes(coordinate, tarball, checksum, digest)).not.toThrow();
    expect(() => assertReleaseAssetBytes(coordinate, Buffer.from("changed"), checksum, digest))
      .toThrow("immutable metadata");
  });
});
