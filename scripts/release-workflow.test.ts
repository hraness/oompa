import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOompaGlobalInstallCommand,
  OOMPA_INSTALL_ARCHIVE_URL,
} from "../src/install-preflight";
import { publicContent } from "../site/content";
import { docsPathForSection, renderDocsMarkdown } from "../site/docs-content";
import { githubPublisherEnvironment } from "./github-publisher-environment";
import {
  draftReleaseBody,
  githubReleaseRun,
  parseReleaseBody,
} from "./github-release-identity";

const reviewedActions = {
  checkout: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  downloadArtifact: "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  rustCache: "Swatinem/rust-cache@6323deb102c322ba6fcbdcafc7e3dddab59af2b6",
  rustToolchain: "dtolnay/rust-toolchain@6bed0761d98439e5a578e2877258200ad565ba87",
  setupBun: "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6",
  setupNode: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  uploadArtifact: "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
} as const;

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

const sourceTestCommand = "bun test ./src --isolate --max-concurrency=1";
const aggregateCheckCommand = "bun run check:support-runtime && bun run check:cost-surfaces && bun run check:install-pins && bun run check:effect-architecture && bun run check:security-primitives && bun run lint && bun run typecheck && bun run test && bun run build:site -- --check && bun run build:app && bun run build && bun run check:package";
const aggregateTestCommand = "bun test ./scripts --isolate --max-concurrency=1 && bun run test:local-efficiency-plugin && bun run test:cloud-efficiency-plugin && bun test ./src --isolate --max-concurrency=1 && bun test ./convex --isolate --max-concurrency=1 && bun run test:site && bun run test:app";

function expandPackageScript(
  scripts: Readonly<Record<string, unknown>>,
  name: string,
  ancestors: readonly string[] = [],
): string[] {
  if (ancestors.includes(name)) throw new Error(`Cyclic package script: ${name}`);
  const command = scripts[name];
  if (!Object.hasOwn(scripts, name) || typeof command !== "string" || command.trim() === "") {
    throw new Error(`Missing package script: ${name}`);
  }
  return command.split(" && ").flatMap((leaf) => {
    const reference = /^bun run ([A-Za-z0-9:_-]+)$/u.exec(leaf)?.[1];
    return reference === undefined
      ? [leaf]
      : expandPackageScript(scripts, reference, [...ancestors, name]);
  });
}

function requireCiGateCoverage(scripts: Readonly<Record<string, unknown>>): void {
  const aggregate = expandPackageScript(scripts, "check");
  const source = expandPackageScript(scripts, "test:source");
  const remainder = expandPackageScript(scripts, "check:ci-remainder");
  if (source.length !== 1 || source[0] !== sourceTestCommand) {
    throw new Error("CI source gate must contain only the unchanged source command");
  }
  if (aggregate.filter((leaf) => leaf === sourceTestCommand).length !== 1
    || remainder.includes(sourceTestCommand)) {
    throw new Error("CI source command must run exactly once");
  }
  if (JSON.stringify([...aggregate].sort()) !== JSON.stringify([...source, ...remainder].sort())) {
    throw new Error("CI phases must cover every aggregate command with the same multiplicity");
  }
  if (JSON.stringify(remainder)
    !== JSON.stringify(aggregate.filter((leaf) => leaf !== sourceTestCommand))) {
    throw new Error("CI remainder must preserve aggregate command ordering");
  }
}

const sourceShardArguments = [
  "--shard=1/6", "--shard=2/6", "--shard=3/6", "--shard=4/6", "--shard=5/6", "--shard=6/6",
] as const;
// Eight fixture files across six shards: some shards receive two files and
// the rest one, so the contract proves whole-file partitioning rather than
// one file per shard.
const shardFixtureNames = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"] as const;

async function withShardFixture(run: (directory: string) => void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oompa-ci-shard-contract-"));
  try {
    await mkdir(join(directory, "fixtures"));
    for (const name of shardFixtureNames) {
      await writeFile(join(directory, "fixtures", `${name}.test.ts`), [
        'import { expect, test } from "bun:test";',
        `test("${name} first", () => { console.log("CI_SHARD_CASE:${name}:first"); expect(true).toBe(true); });`,
        `test("${name} sentinel", () => { console.log("CI_SHARD_CASE:${name}:sentinel"); expect(process.env.CI_SHARD_FAIL).not.toBe("1"); });`,
      ].join("\n"));
    }
    run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runShardFixture(
  directory: string,
  shard: typeof sourceShardArguments[number] | undefined,
  fail: boolean,
): { exitCode: number | null; cases: string[]; stderr: string } {
  const result = spawnSync(process.execPath, [
    "--no-env-file", "--config=/dev/null", "test", "./fixtures",
    "--isolate", "--max-concurrency=1", ...(shard === undefined ? [] : [shard]),
  ], {
    cwd: directory,
    env: { HOME: directory, TMPDIR: directory, NO_COLOR: "1", CI_SHARD_FAIL: fail ? "1" : "0" },
    encoding: "utf8",
    timeout: 1_000,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1_024,
  });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return {
    exitCode: result.status,
    cases: result.stdout.trim().split("\n").filter((line) => line.startsWith("CI_SHARD_CASE:")),
    stderr: result.stderr,
  };
}

describe("release workflow", () => {
  test("pinned native Bun shards cover every fixture case exactly once without splitting files", async () => {
    expect(Bun.version).toBe("1.3.14");
    await withShardFixture((directory) => {
      const full = runShardFixture(directory, undefined, false);
      expect(full.exitCode).toBe(0);
      const expected = shardFixtureNames.flatMap((name) => [
        `CI_SHARD_CASE:${name}:first`, `CI_SHARD_CASE:${name}:sentinel`,
      ]).sort();
      expect([...full.cases].sort()).toEqual(expected);
      const shardCases = sourceShardArguments.map((shard) => {
        const result = runShardFixture(directory, shard, false);
        expect(result.exitCode).toBe(0);
        expect([2, 4]).toContain(result.cases.length);
        for (const name of shardFixtureNames) {
          const cases = result.cases.filter((entry) => entry.startsWith(`CI_SHARD_CASE:${name}:`));
          expect(cases.length === 0 || cases.length === 2).toBeTrue();
        }
        return result.cases;
      });
      expect(shardCases.flat().sort()).toEqual(expected);
      expect(new Set(shardCases.flat()).size).toBe(expected.length);
      expect(shardCases.filter((cases) => cases.length === 4)).toHaveLength(2);
      expect(shardCases.filter((cases) => cases.length === 2)).toHaveLength(4);
    });
  });

  test.each([...sourceShardArguments])("pinned native Bun %s propagates fixture failures", async (shard) => {
    await withShardFixture((directory) => {
      const result = runShardFixture(directory, shard, true);
      expect(result.exitCode).toBe(1);
      expect([2, 4]).toContain(result.cases.length);
      const files = result.cases.length / 2;
      expect(result.stderr).toContain(`${files} pass`);
      expect(result.stderr).toContain(`${files} fail`);
    });
  });

  test("expands only exact package-script references and rejects missing or cyclic references", () => {
    expect(expandPackageScript({
      check: "bun run nested && bun run build:site -- --check",
      nested: "bun run leaf",
      leaf: "bun ./scripts/check-install-pins.ts",
    }, "check")).toEqual([
      "bun ./scripts/check-install-pins.ts",
      "bun run build:site -- --check",
    ]);
    for (const scripts of [
      { check: "bun run missing" },
      { check: "bun run empty", empty: "" },
      { check: "bun run invalid", invalid: false },
    ]) expect(() => expandPackageScript(scripts, "check")).toThrow("Missing package script");
    expect(() => expandPackageScript({ check: "bun run check" }, "check"))
      .toThrow("Cyclic package script");
    expect(() => expandPackageScript({ check: "bun run nested", nested: "bun run check" }, "check"))
      .toThrow("Cyclic package script");
  });

  test("rejects omitted, duplicated, reordered, optional, or misplaced CI gate commands", () => {
    const scripts = {
      check: "bun run first && bun run test:source && bun run last",
      first: "bun ./scripts/check-install-pins.ts",
      last: "bun run build:site -- --check",
      "test:source": sourceTestCommand,
      "check:ci-remainder": "bun run first && bun run last",
    };
    expect(() => requireCiGateCoverage(scripts)).not.toThrow();
    for (const remainder of [
      "bun run first",
      "bun run first && bun run last && bun run last",
      "bun run first && bun run last || true",
      "bun run first && bun run last; true",
      "bun run last && bun run first",
      "bun run first && bun run test:source && bun run last",
      "bun run check",
    ]) {
      expect(() => requireCiGateCoverage({ ...scripts, "check:ci-remainder": remainder })).toThrow();
    }
    for (const source of [
      `${sourceTestCommand} && bun run first`,
      "bun test ./src --isolate --max-concurrency=2",
      `${sourceTestCommand} || true`,
    ]) expect(() => requireCiGateCoverage({ ...scripts, "test:source": source })).toThrow();
  });

  test("keeps every privileged release helper under owner review", async () => {
    const codeowners = await readFile(
      join(import.meta.dir, "..", ".github", "CODEOWNERS"),
      "utf8",
    );
    for (const path of [
      "/scripts/github-publisher-environment.ts",
      "/scripts/github-release-identity.ts",
      "/scripts/github-release-retry-policy.ts",
      "/scripts/bounded-json-response.ts",
      "/scripts/check-commit-ci-run.ts",
      "/scripts/check-npm-trusted-publisher-oidc.ts",
      "/scripts/check-npm-release-environment.ts",
      "/scripts/npm-publisher-boundary.ts",
      "/scripts/publish-github-release.ts",
      "/scripts/publish-npm-release.ts",
      "/scripts/release-repository-identity.ts",
      "/scripts/verify-npm-provenance-crypto.mjs",
      "/scripts/verify-npm-provenance.ts",
    ]) expect(codeowners).toContain(`${path} @0thernet`);
  });

  test("bounds every npm metadata read and aligns GitHub artifact output with package policy", async () => {
    const [preflight, npmPublisher, npmBoundary, githubPublisher, distributionPolicy] = await Promise.all([
      readFile(join(import.meta.dir, "check-npm-artifact-state.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-npm-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "npm-publisher-boundary.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-github-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "release-distribution-policy.ts"), "utf8"),
    ]);
    expect(distributionPolicy).toContain("readBoundedJsonResponse(response, label, 128 * 1_024)");
    expect(preflight).toContain("const metadata: Record<string, unknown> | null = await npmRegistryReleaseMetadata(");
    expect(npmPublisher).toContain('metadata(versionUrl, "version")');
    expect(npmPublisher).toContain('metadata(latestUrl, "latest")');
    expect(npmPublisher).toContain("lookupCompleteRelease()");
    expect(npmPublisher).not.toContain("OOMPA_APPROVE_NPM_PUBLICATION");
    expect(npmBoundary).toContain("maximumPublisherOutputBytes");
    expect(npmBoundary).toContain("Successfully retrieved and set token");
    expect(npmBoundary).toContain("GITHUB_REPOSITORY_OWNER_ID");
    expect(npmBoundary).not.toContain("console.log(output)");
    expect(npmBoundary).not.toContain("console.error(output)");
    expect(preflight).not.toContain("response.json()");
    expect(npmPublisher).not.toContain("response.json()");
    expect(githubPublisher).toContain("const maximumArtifactBytes = 64 * 1024 * 1024");
    expect(githubPublisher).toContain("maxBuffer: maximumStdoutBytes + 1");
    expect(githubPublisher.match(/false, maximumArtifactBytes\)\.stdout/gu)?.length).toBe(2);
    expect(githubPublisher).not.toContain("maxBuffer: 32 * 1_024 * 1_024");
  });

  test("revalidates exact live public repository identity at each publication boundary", async () => {
    const [identity, npmPublisher, githubPublisher] = await Promise.all([
      readFile(join(import.meta.dir, "release-repository-identity.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-npm-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "publish-github-release.ts"), "utf8"),
    ]);
    for (const required of [
      'default_branch: z.literal("main")',
      'full_name: z.literal(publicRepository)',
      "id: z.literal(repositoryId)",
      "owner: z.object({ id: z.literal(repositoryOwnerId) })",
      "private: z.literal(false)",
      'visibility: z.literal("public")',
    ]) expect(identity).toContain(required);
    expect(identity).toContain("readBoundedJsonResponse(");
    expect(npmPublisher).toContain("await fetchLiveReleaseRepository(process.env.GITHUB_TOKEN);");
    expect(npmPublisher.indexOf("await fetchLiveReleaseRepository(process.env.GITHUB_TOKEN);"))
      .toBeLessThan(npmPublisher.indexOf("const publication = await runNpmPublisher({"));
    expect(githubPublisher.match(/verifyLivePublicRepository\(\);/gu)?.length).toBe(3);
    expect(githubPublisher).toContain("verifyLivePublicRepository();\n    run([\n      \"gh\", \"api\", \"--method\", \"POST\"");
    expect(githubPublisher).toContain("verifyLivePublicRepository();\n  const published = readJson([\n    \"gh\", \"api\", \"--method\", \"PATCH\"");
  });

  test("matches current Fulcio V2 bytes while retaining every signer claim", async () => {
    const [policy, signer, releaseRecord] = await Promise.all([
      readFile(join(import.meta.dir, "verify-npm-provenance.ts"), "utf8"),
      readFile(join(import.meta.dir, "verify-npm-provenance-crypto.mjs"), "utf8"),
      readFile(join(import.meta.dir, "..", "docs", "beta-release.md"), "utf8"),
    ]);
    for (const source of [policy, signer]) {
      expect(source).toContain("canonicalAsciiDerUtf8String");
      expect(source).toContain("String.fromCharCode(0x0c, value.length)");
      expect(source).toContain('"1.3.6.1.4.1.57264.1.2": "push"');
      expect(source).toContain('"1.3.6.1.4.1.57264.1.11": der("github-hosted")');
      expect(source).toContain('"1.3.6.1.4.1.57264.1.23": der("npm-release")');
      for (const claim of [
        '"1.3.6.1.4.1.57264.1.6": ref',
        '"1.3.6.1.4.1.57264.1.14": der(ref)',
        '"1.3.6.1.4.1.57264.1.18": der(identity)',
        '"1.3.6.1.4.1.57264.1.19": der(sha)',
      ]) expect(source).toContain(claim);
      expect(source).toContain(
        "`repo:${GITHUB_REPOSITORY_OWNER}@${GITHUB_REPOSITORY_OWNER_ID}/${GITHUB_REPOSITORY_NAME}@${GITHUB_REPOSITORY_ID}:environment:npm-release`",
      );
      expect(source).not.toContain("`repo:hraness/hra:ref:${ref}`");
    }
    expect(releaseRecord).toContain("Current V2 claims from `.11` onward");
    expect(releaseRecord).toContain("Environment claim OID\n`.23` must be exactly `npm-release`");
    expect(releaseRecord).toContain("Repository-subject OID `.24` remains mandatory");
    expect(releaseRecord).toContain("repository path `hraness/oompa`, numeric owner ID `307125679`");
    expect(releaseRecord).toContain("numeric repository ID\n`1343008607`, and environment `npm-release`");
    expect(releaseRecord).toContain("tag ref `refs/tags/v0.7.0`");
    expect(releaseRecord).toContain("certificate URI and OIDs `.6`, `.14`, and `.18`");
  });

  test("gives GitHub publisher commands only their explicit non-OIDC environment", () => {
    const environment = githubPublisherEnvironment({
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.invalid/secret",
      GH_TOKEN: "github-secret",
      HOME: "/home/release",
      LANG: "C.UTF-8",
      PATH: "/usr/bin:/bin",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      UNRELATED_SECRET: "private",
    });

    expect(environment).toEqual({
      GH_PROMPT_DISABLED: "1",
      GH_TOKEN: "github-secret",
      HOME: "/home/release",
      LANG: "C.UTF-8",
      NO_COLOR: "1",
      PATH: "/usr/bin:/bin",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    });
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBeUndefined();
    expect(environment.ACTIONS_ID_TOKEN_REQUEST_URL).toBeUndefined();
    expect(environment.UNRELATED_SECRET).toBeUndefined();
    expect(() => githubPublisherEnvironment({ GH_TOKEN: "github-secret" })).toThrow();
  });

  test("isolates complete release history to reviewed main and the immutable tag", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    )), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");

    for (const jobName of ["verify", "exact_artifact", "publish", "npm_preflight", "npm_mirror"] as const) {
      const job = asRecord(jobs[jobName], `${jobName} job`);
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} steps must be an array`);
      const steps = job.steps.map((step, index) => asRecord(step, `${jobName} step ${index}`));
      const checkoutIndex = steps.findIndex((step) => step.uses === reviewedActions.checkout);
      const fetchIndex = steps.findIndex((step) => step.name === "Fetch only governed release history");
      expect(checkoutIndex).toBeGreaterThanOrEqual(0);
      expect(fetchIndex).toBe(checkoutIndex + 1);
      expect(asRecord(steps[checkoutIndex]?.with, `${jobName} checkout inputs`)).toMatchObject({
        "fetch-depth": 1,
        "fetch-tags": false,
        "persist-credentials": false,
      });
      const fetch = String(steps[fetchIndex]?.run);
      expect(fetch).toContain("git fetch --force --no-tags --unshallow origin");
      expect(fetch).toContain("+refs/heads/$DEFAULT_BRANCH:refs/remotes/origin/$DEFAULT_BRANCH");
      expect(fetch).toContain("+refs/tags/$VERIFIED_TAG:refs/tags/$VERIFIED_TAG");
      expect(fetch).toContain("git rev-parse --is-shallow-repository");
      expect(fetch).toContain("git for-each-ref --format='%(refname)'");
      expect(fetch).toContain("Unexpected ref entered governed release history");
      expect(fetch).not.toContain("--all");
    }
  });

  test("requires the immutable owner as the original release-tag pusher", async () => {
    const source = await readFile(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    const workflow = asRecord(Bun.YAML.parse(source), "release workflow");
    const jobs = asRecord(workflow.jobs, "release jobs");
    const verify = asRecord(jobs.verify, "release verify job");
    if (!Array.isArray(verify.steps)) throw new TypeError("release verify steps must be an array");
    const first = asRecord(verify.steps[0], "first release step");
    expect(first.name).toBe("Require one stable tag push");
    expect(asRecord(first.env, "release request environment")).toMatchObject({
      ACTOR_ID: "${{ github.actor_id }}",
      REPOSITORY_PRIVATE: "${{ github.event.repository.private }}",
      REPOSITORY_VISIBILITY: "${{ github.event.repository.visibility }}",
      SENDER_ID: "${{ github.event.sender.id }}",
      SENDER_TYPE: "${{ github.event.sender.type }}",
    });
    expect(String(first.run)).toContain('"$ACTOR_ID" != "894119"');
    expect(String(first.run)).toContain('"$SENDER_ID" != "894119"');
    expect(String(first.run)).toContain('"$SENDER_TYPE" != "User"');
    expect(String(first.run)).toContain('"$REPOSITORY_PRIVATE" != "false"');
    expect(String(first.run)).toContain('"$REPOSITORY_VISIBILITY" != "public"');
  });

  test("keeps release authority-supervisor prerequisites byte-aligned with CI", async () => {
    const root = join(import.meta.dir, "..");
    const [ciSource, releaseSource] = await Promise.all([
      readFile(join(root, ".github", "workflows", "ci.yml"), "utf8"),
      readFile(join(root, ".github", "workflows", "release.yml"), "utf8"),
    ]);
    const ciJobs = asRecord(asRecord(Bun.YAML.parse(ciSource), "CI workflow").jobs, "CI jobs");
    const releaseJobs = asRecord(
      asRecord(Bun.YAML.parse(releaseSource), "release workflow").jobs,
      "release jobs",
    );
    const ciCheck = asRecord(ciJobs.check, "CI check job");
    const releaseVerify = asRecord(releaseJobs.verify, "release verify job");
    const releaseExactArtifact = asRecord(releaseJobs.exact_artifact, "release exact-artifact job");
    if (
      !Array.isArray(ciCheck.steps)
      || !Array.isArray(releaseVerify.steps)
      || !Array.isArray(releaseExactArtifact.steps)
    ) {
      throw new TypeError("CI, release verify, and exact-artifact steps must be arrays");
    }
    const ciSteps = ciCheck.steps.map((step, index) => asRecord(step, `CI step ${index}`));
    const releaseSteps = releaseVerify.steps
      .map((step, index) => asRecord(step, `release verify step ${index}`));
    const exactArtifactSteps = releaseExactArtifact.steps
      .map((step, index) => asRecord(step, `release exact-artifact step ${index}`));
    const authoritySteps = [
      "Install pinned Rust 1.97.1 for authority supervisor (Linux)",
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "Enable isolated user namespaces for native custody checks",
      "Restore Ubuntu user-namespace restriction",
    ] as const;
    const custodyTestName = "Run Linux authority-supervisor custody test";

    const exactlyOneStep = (
      steps: readonly Record<string, unknown>[],
      name: string,
      label: string,
    ): Record<string, unknown> => {
      const matches = steps.filter((step) => step.name === name);
      expect(matches, `${label} must contain exactly one ${name} step`).toHaveLength(1);
      const [match] = matches;
      if (match === undefined) throw new TypeError(`${label} is missing ${name}`);
      return match;
    };

    for (const name of authoritySteps) {
      const ciStep = exactlyOneStep(ciSteps, name, "CI check");
      const releaseStep = exactlyOneStep(releaseSteps, name, "release verify");
      expect(ciStep.if).toBe(
        name === "Restore Ubuntu user-namespace restriction"
          ? "${{ always() && runner.os == 'Linux' }}"
          : "runner.os == 'Linux'",
      );
      expect(releaseStep.if).toBe(ciStep.if);
      expect(releaseStep.run).toBe(ciStep.run);
    }

    const rustInstall = String(exactlyOneStep(
      ciSteps,
      "Install pinned Rust 1.97.1 for authority supervisor (Linux)",
      "CI check",
    ).run);
    expect(rustInstall).toContain("rustup toolchain install 1.97.1 --profile minimal");
    expect(rustInstall).toContain("--target x86_64-unknown-linux-musl");
    expect(rustInstall).toContain("--target aarch64-unknown-linux-musl");
    expect(rustInstall).toContain(
      'test "$(rustup run 1.97.1 rustc --version)" = "rustc 1.97.1 (8bab26f4f 2026-07-14)"',
    );
    expect(String(exactlyOneStep(
      ciSteps,
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "CI check",
    ).run)).toBe(
      'bun ./scripts/verify-authority-supervisor-build.ts --rustc "$(rustup which --toolchain 1.97.1 rustc)"',
    );
    const enableNamespaces = String(exactlyOneStep(
      ciSteps,
      "Enable isolated user namespaces for native custody checks",
      "CI check",
    ).run);
    expect(enableNamespaces).toContain(
      'test "$(/usr/sbin/sysctl --values kernel.unprivileged_userns_clone)" = "1"',
    );
    expect(enableNamespaces).toContain(
      "sudo /usr/sbin/sysctl --write kernel.apparmor_restrict_unprivileged_userns=0",
    );
    expect(enableNamespaces).toContain(
      'test "$(/usr/sbin/sysctl --values kernel.apparmor_restrict_unprivileged_userns)" = "0"',
    );
    expect(enableNamespaces).toContain(
      "/usr/bin/unshare --user --map-root-user --fork /usr/bin/true",
    );
    // CI runs the custody test once, inside the remainder gate's scripts suite;
    // only the release verifier keeps a separate focused step.
    expect(ciSteps.filter((step) => step.name === custodyTestName)).toHaveLength(0);
    const releaseCustodyTest = exactlyOneStep(releaseSteps, custodyTestName, "release verify");
    expect(releaseCustodyTest.if).toBe("runner.os == 'Linux'");
    expect(String(releaseCustodyTest.run)).toBe(
      "bun test scripts/authority-supervisor-runtime.test.ts --isolate --max-concurrency=1",
    );
    const restoreNamespaces = String(exactlyOneStep(
      ciSteps,
      "Restore Ubuntu user-namespace restriction",
      "CI check",
    ).run);
    expect(restoreNamespaces).toContain(
      "sudo /usr/sbin/sysctl --write kernel.apparmor_restrict_unprivileged_userns=1",
    );
    expect(restoreNamespaces).toContain(
      'test "$(/usr/sbin/sysctl --values kernel.apparmor_restrict_unprivileged_userns)" = "1"',
    );

    const verifyOrder = [
      "Install exact locked dependencies without lifecycle scripts",
      "Require the exact commit's successful CI run",
      "Install pinned Rust 1.97.1 for authority supervisor (Linux)",
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "Enable isolated user namespaces for native custody checks",
      custodyTestName,
      "Restore Ubuntu user-namespace restriction",
      "Create one exact npm tarball and checksum",
    ] as const;
    const verifyIndexes = verifyOrder.map((name) => {
      exactlyOneStep(releaseSteps, name, "release verify");
      return releaseSteps.findIndex((step) => step.name === name);
    });
    expect(verifyIndexes).toEqual([...verifyIndexes].sort((left, right) => left - right));
    const custodyTestIndex = verifyIndexes[5];
    const restoreIndex = verifyIndexes[6];
    expect(restoreIndex).toBe((custodyTestIndex ?? -2) + 1);
    expect(releaseSteps.filter((step) => step.name === "Run complete repository gate")).toHaveLength(0);
    expect(releaseSource).not.toContain("bun run check");

    for (const name of [
      "Enable isolated user namespaces for native custody checks",
      "Restore Ubuntu user-namespace restriction",
    ] as const) {
      const ciStep = exactlyOneStep(ciSteps, name, "CI check");
      const releaseStep = exactlyOneStep(exactArtifactSteps, name, "release exact-artifact");
      expect(releaseStep.if).toBe(ciStep.if);
      expect(releaseStep.run).toBe(ciStep.run);
    }
    const packageCheckName = "Verify checksum and complete installed-package behavior";
    exactlyOneStep(exactArtifactSteps, packageCheckName, "release exact-artifact");
    const packageCheckIndex = exactArtifactSteps.findIndex((step) => step.name === packageCheckName);
    expect(exactArtifactSteps[packageCheckIndex - 1]?.name)
      .toBe("Enable isolated user namespaces for native custody checks");
    expect(exactArtifactSteps[packageCheckIndex + 1]?.name)
      .toBe("Restore Ubuntu user-namespace restriction");
  });

  test("binds residual draft identity to the exact same run and artifact authority", () => {
    const source = {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/v0.7.1",
      GITHUB_REF_NAME: "v0.7.1",
      GITHUB_REF_TYPE: "tag",
      GITHUB_REPOSITORY: "hraness/oompa",
      GITHUB_REPOSITORY_ID: "1343008607",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "123",
      GITHUB_WORKFLOW_REF: "hraness/oompa/.github/workflows/release.yml@refs/tags/v0.7.1",
    };
    const run = githubReleaseRun("v0.7.1", source);
    const input = {
      artifacts: [{ name: "hra.tgz", sha256: "c".repeat(64), size: 7 }],
      commitSha: "a".repeat(40),
      run,
      tag: "v0.7.1",
      tagObjectSha: "b".repeat(40),
    } as const;
    const body = draftReleaseBody(input);
    expect(parseReleaseBody(body, input, "draft").createdAttempt).toBe(2);
    expect(() => parseReleaseBody(body, { ...input, commitSha: "d".repeat(40) }, "draft")).toThrow();
    expect(() => parseReleaseBody(body, { ...input, tagObjectSha: "e".repeat(40) }, "draft")).toThrow();
    expect(() => parseReleaseBody(body, { ...input, artifacts: [{ ...input.artifacts[0], size: 8 }] }, "draft")).toThrow();
    expect(() => parseReleaseBody(body, {
      ...input,
      run: { ...run, attempt: 3, id: "124" },
    }, "draft")).toThrow();
    const futureAttemptBody = draftReleaseBody({
      ...input,
      run: { ...run, attempt: 3 },
    });
    expect(() => parseReleaseBody(futureAttemptBody, input, "draft"))
      .toThrow("workflow-attempt ordering");
    expect(() => githubReleaseRun("v0.7.1", { ...source, GITHUB_RUN_ATTEMPT: "3", GITHUB_RUN_ID: "124" }))
      .not.toThrow();
  });

  test("binds the admitted installer and exact release record without claiming runtime rollout", async () => {
    const [releaseNotes, readme, thirdPartyNotices, changelog, security] = await Promise.all([
      readFile(join(import.meta.dir, "..", "docs", "beta-release-notes.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "README.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "THIRD_PARTY_NOTICES.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8"),
      readFile(join(import.meta.dir, "..", "SECURITY.md"), "utf8"),
    ]);
    const installCommand = buildOompaGlobalInstallCommand(OOMPA_INSTALL_ARCHIVE_URL);
    const availability = renderDocsMarkdown("/docs/status/");
    const gettingStarted = renderDocsMarkdown("/docs/start/");

    expect(releaseNotes).toContain(installCommand);
    expect(releaseNotes).toContain("## Admitted v0.6.2 predecessor");
    expect(releaseNotes).not.toContain("## Unreleased v0.6.2 candidate");
    expect(releaseNotes).toContain("`v0.6.2` admission does not admit `v0.7.0`");
    expect(changelog).toContain("## v0.6.2\n");
    expect(changelog).not.toContain("## v0.6.2 candidate (unreleased)");
    expect(releaseNotes).toContain("## Admitted v0.6.3 predecessor");
    expect(releaseNotes).not.toContain("## Unreleased v0.6.3 candidate");
    expect(releaseNotes).toContain("`v0.6.3` admission does not admit `v0.7.0`");
    expect(changelog).toContain("## v0.6.3\n");
    expect(changelog).not.toContain("## v0.6.3 candidate (unreleased)");
    expect(changelog).toContain("docs/beta-release.md#immutable-v063-successful-release-record");
    expect(readme).toContain(installCommand);
    expect(readme).toContain("Local CLI v0.8.5 is a release candidate, not an admitted artifact");
    expect(readme).toContain("Only after immutable GitHub release admission, install and verify the v0.8.5 candidate CLI artifact. This does not start the daemon:");
    expect(readme).toContain("The v0.8.5 candidate is not yet admitted");
    expect(readme).not.toContain("The v0.8.4 candidate is not yet admitted");
    expect(readme).toContain("https://github.com/hraness/oompa/actions/runs/35136703343");
    expect(releaseNotes).toContain("## Admitted v0.7.0 predecessor");
    expect(releaseNotes).toContain("## Admitted v0.7.1 predecessor");
    for (const surface of [readme, releaseNotes, availability, gettingStarted]) {
      expect(surface).toContain("This release candidate is not yet admitted");
      expect(surface).toContain(surface === releaseNotes ? "#admitted-v084-artifacts" : "https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v084-artifacts");
      expect(surface).toContain("v0.8.5");
      expect(surface).toContain("v0.8.4");
      expect(surface).toContain("npm mirror");
      const noticePosition = surface.indexOf("This release candidate is not yet admitted");
      const installPosition = surface.indexOf(installCommand);
      expect(noticePosition).toBeGreaterThanOrEqual(0);
      expect(installPosition).toBeGreaterThanOrEqual(0);
      expect(noticePosition).toBeLessThan(installPosition);
    }
    for (const guide of [availability, gettingStarted]) {
      expect(guide).not.toContain("The v0.8.3 candidate is not yet admitted");
      expect(guide).toContain("Neither artifact admission nor installation authorizes daemon startup.");
      expect(guide).not.toContain("You can install and check v0.8.3 now");
    }
    expect(readme).not.toContain("The v0.7.1 candidate is not yet admitted");
    expect(readme).toContain("[Availability](https://oompa.app/docs/status/)");
    expect(readme).toContain("[ordered update runbook](https://oompa.app/docs/status/#install-and-update)");
    expect(readme).not.toContain("Local CLI v0.7.0 is a release candidate");
    const homepageAvailability = publicContent.questions.find(({ question }) => question === "Can I start using it now?");
    expect(homepageAvailability).toBeDefined();
    expect(homepageAvailability?.answer).toContainEqual({ kind: "link", label: "Check the setup status", href: "/docs/status/" });
    expect(homepageAvailability?.answer).toContainEqual({ kind: "link", label: "verified installation notes", href: "https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v084-artifacts" });
    const homepageAvailabilityText = homepageAvailability?.answer.filter((part) => part.kind === "text").map((part) => part.value).join("");
    expect(homepageAvailabilityText).toContain("The admitted v0.8.4 CLI has its own");
    expect(homepageAvailabilityText).not.toContain("The v0.8.3 candidate is not yet admitted.");
    expect(homepageAvailabilityText).toContain("Starting or upgrading a daemon and enabling hosted commands are paused until the capacity checks pass.");
    expect(homepageAvailabilityText).toContain("before initialization or daemon startup.");
    // The concise entry points link to the canonical availability guide. The
    // release-bound recovery restrictions must survive that relocation intact.
    expect(docsPathForSection("install-and-update")).toBe("/docs/status/#install-and-update");
    expect(availability).toContain(installCommand);
    expect(availability).toContain("The v0.8.4 CLI passed immutable GitHub and exact-byte npm artifact admission.");
    expect(availability).not.toContain("Its optional npm mirror is not admitted.");
    expect(availability).not.toContain("The v0.8.0 candidate is not yet admitted");
    expect(availability).not.toContain("The v0.8.3 candidate is not yet admitted");
    expect(availability).not.toContain("v0.8.3 is released");
    expect(availability).toContain("their availability does not authorize starting the current daemon or sending new hosted commands");
    for (const document of [readme, availability]) {
      expect(document).toContain("Current daemon and hosted command-writer rollout remains blocked on capacity.");
      expect(document).toContain("Do not initialize, start, or autostart the v0.8.5 daemon or any older daemon");
      expect(document).toContain("protected two-pass zero-debt capacity evidence and its exact .activated readback receipt");
      expect(document).toContain("Artifact availability and the live sync service do not clear this gate.");
      expect(document).toContain("daemon and target marker-2 proofs before globally enabling hosted writers");
    }
    expect(availability).toContain("next invocation of that exact release's installer");
    expect(availability).toContain("`$BUN_INSTALL/install/oompa/install-intent.json`");
    expect(availability).toContain("the exact immutable install command from the originating release's trusted README or release notes");
    expect(availability).toContain("If that installer refuses the intent, stop installation and use bounded read-only diagnosis");
    expect(availability).toContain("while preserving the intent and its directories");
    expect(availability).toContain("An uncertain tag blocks execution, not diagnosis");
    expect(availability).toContain("It is not authorization to retry, rerun, or mutate that release's GitHub Actions workflow");
    expect(releaseNotes).toContain("A durable installer intent is release-bound");
    expect(releaseNotes).toContain("An installer from another release fails closed without deleting it");
    expect(releaseNotes).toContain("If that installer refuses the intent, stop installation and use bounded read-only diagnosis");
    expect(releaseNotes).toContain("while preserving the intent and its directories");
    expect(releaseNotes).toContain("An uncertain tag blocks execution, not diagnosis");
    expect(releaseNotes).toContain("This is local installer recovery, not authorization to retry or mutate");
    expect(releaseNotes).not.toContain("src/install-preflight.ts | bun -");
    expect(releaseNotes).not.toContain("bun add --global");
    expect(releaseNotes).not.toContain(
      'bun "$BUN_INSTALL_GLOBAL_DIR/node_modules/hra/src/install-normalizer.ts"',
    );
    expect(releaseNotes).toContain("Optional hosted encrypted sync has been live since 2026-09-03 and is now an open beta.");
    expect(releaseNotes).not.toContain("Cloud enrollment is invitation-only");
    expect(releaseNotes).not.toContain("artifact-identity SPDX");
    expect(releaseNotes).not.toContain("runtime SPDX inventory");
    expect(releaseNotes).toContain("# Oompa v0.8.5 local CLI candidate\n");
    expect(thirdPartyNotices).toContain("exact tarball plus `SHA256SUMS`");
    expect(thirdPartyNotices).toContain("The admitted `v0.7.1` predecessor records its own build graph");
    expect(thirdPartyNotices).toContain("This candidate is not yet admitted");
    expect(thirdPartyNotices).toContain("The `v0.8.5` candidate records its build graph");
    expect(thirdPartyNotices).toContain("The admitted `v0.8.4` release records its own build graph");
    expect(thirdPartyNotices).not.toContain("The admitted `v0.8.5` release records its build graph");
    expect(thirdPartyNotices).toContain("bound the immutable source tag");
    expect(thirdPartyNotices).toContain("`@hraness/site-footer` v0.14.0");
    expect(thirdPartyNotices).toContain("`@hraness/design-kit` v0.9.0");
    expect(thirdPartyNotices).toContain("`@hraness/ui` v0.5.6");
    expect(thirdPartyNotices).toContain("`@hraness/direct` v0.7.0");
    expect(thirdPartyNotices).toContain("not a runtime dependency of the Oompa CLI or the authenticated app");
    expect(thirdPartyNotices).toContain("shared semantic themes and appearance controls");
    expect(thirdPartyNotices).not.toContain("`@hraness/design-kit` v0.3.0");
    expect(thirdPartyNotices).not.toContain("SPDX");
    expect(changelog).toContain("## v0.7.0\n");
    expect(changelog).not.toContain("## v0.8.3 candidate (unreleased)\n");
    expect(changelog).toContain("## v0.8.0 candidate (unreleased)\n");
    expect(changelog).toContain("## v0.8.3\n");
    expect(changelog).not.toContain("## v0.8.4 candidate (unreleased)\n");
    expect(changelog).toContain("## v0.8.4\n");
    expect(changelog).toContain("## v0.8.5 candidate (unreleased)\n");
    expect(changelog).not.toContain("## v0.8.5\n");
    expect(changelog).toContain("## v0.7.1\n");
    expect(changelog).toContain("Forward repair for the incomplete `v0.6.0` admission");
    expect(security).toContain("| `v0.8.4` | Fully admitted beta. Supported and receives security fixes. Daemon and hosted command-writer rollout remains capacity-gated. |");
    expect(security).toContain("| `v0.7.0` | Superseded by `v0.7.1`. Unsupported. Do not bypass the update runbook to migrate. |");
    expect(security).toContain("| `v0.6.3` | Superseded by `v0.7.0`. Unsupported. Do not bypass the update runbook to migrate. |");
    expect(security).toContain("| `v0.6.2` | Superseded by `v0.6.3`. Unsupported. Do not bypass the update runbook to migrate. |");
    expect(security).toContain("Only the latest fully admitted beta receives security fixes");
    expect(security).toContain("| `v0.7.1` | Superseded by `v0.8.3`. Unsupported.");
    expect(security).not.toContain("| `v0.8.4` candidate |");
    expect(security).toContain("| `v0.8.5` candidate | Not admitted or supported as a public release.");
    expect(security).toContain("| `v0.8.3` | Superseded by `v0.8.4`. Unsupported.");
    expect(security).toContain("| `v0.6.0` | Immutable partial publication. The workflow did not complete final admission; unsupported. |");
    expect(security).toContain("| `v0.5.0` | Superseded by `v0.6.1`. Unsupported. Do not bypass the update runbook to migrate. |");
    expect(releaseNotes).toContain("Current daemon startup and command-writer rollout remain blocked by `authority_reduction_hard_quota`");
    expect(releaseNotes).toContain("protected two-pass zero-debt capacity evidence and its exact `.activated` readback receipt");
    const installSection = releaseNotes.split("## Install\n")[1]?.split("\n## Included")[0];
    expect(installSection).toBeDefined();
    const installCommandBlocks = [...(installSection ?? "").matchAll(/```(?:sh|shell)\n([\s\S]*?)```/gu)];
    expect(installCommandBlocks).toHaveLength(1);
    const directOompaCommands = installCommandBlocks.flatMap((match) =>
      (match[1] ?? "").split("\n").map((line) => line.trim()).filter((line) => /\boompa\s/u.test(line)),
    );
    expect(directOompaCommands).toEqual(["oompa --version", "oompa doctor --offline"]);
    expect(releaseNotes.indexOf("Current daemon startup and command-writer rollout remain blocked"))
      .toBeLessThan(releaseNotes.indexOf("```sh"));
  });

  test("separates machine-gated artifact release from optional live qualification", async () => {
    const root = join(import.meta.dir, "..");
    const [releaseRecord, hostedQualification, claudeQualification, plan] = await Promise.all([
      readFile(join(root, "docs", "beta-release.md"), "utf8"),
      readFile(join(root, "docs", "live-acceptance.md"), "utf8"),
      readFile(join(root, "docs", "claude-live-acceptance.md"), "utf8"),
      readFile(join(root, "kb", "plans", "oh-memory-civilization.md"), "utf8"),
    ]);
    const tagProcedure = releaseRecord.split("The replacement release path")[1]
      ?.split("The release workflow does not rerun")[0];
    expect(tagProcedure).toBeDefined();
    expect(tagProcedure).toContain("Policy decision (2026-09-08)");
    expect(tagProcedure).toContain("authenticated Claude and two-device hosted-memory qualification");
    expect(tagProcedure).toContain("not prerequisites for tagging or publishing `v0.7.0`");
    expect(tagProcedure).toContain("supersedes the earlier pre-tag live-proof requirement");
    expect(tagProcedure).toContain("Neither live proof is claimed complete");
    expect(tagProcedure).toContain("../kb/plans/oh-memory-civilization.md#phase-10-validate-and-deliver-hosted-support");
    expect(tagProcedure).toContain("The tag helper and artifact workflow do not establish authenticated acceptance evidence");
    expect(tagProcedure).toContain("immutable owner User ID `894119`");
    expect(tagProcedure).toContain("clean exact current remote `main`");
    expect(tagProcedure).toContain("the exact commit's `Required` CI job succeeded");
    expect(tagProcedure).toContain("never asks for a second conversational approval");
    expect(tagProcedure).toContain("capacity activation and intended-target gates pass");
    expect(tagProcedure).not.toContain("do not run `release:tag` or publish until both");
    expect(releaseRecord).not.toContain("Publication is safe independently because");

    for (const qualification of [hostedQualification, claudeQualification]) {
      expect(qualification).toContain("not a prerequisite for tagging or publishing Oompa artifacts");
      expect(qualification).toContain("beta-release.md");
      expect(qualification).toContain("Use an authorized Linux host");
    }
    expect(hostedQualification).toContain("version-two memory evidence");
    expect(hostedQualification).toContain("Oompa never falls back to local custody");
    expect(claudeQualification).toContain("deterministic tests do not substitute for an authenticated live run");
    expect(claudeQualification).toContain("Write passing evidence only after cleanup succeeds");
    expect(claudeQualification).not.toContain("A release still needs the fresh exact-tree aggregate and this authorized Linux proof");

    const checkpoint = plan.split("## Current delivery checkpoint\n")[1]
      ?.split("### Historical pre-admission source checkpoints")[0];
    const phase6 = plan.split("## Phase 6: Add Claude provider parity\n")[1]
      ?.split("## Phase 7: Validate and deliver the local release\n")[0];
    const phase10 = plan.split("## Phase 10: Validate and deliver hosted support\n")[1]
      ?.split("## Implementation log")[0];
    expect(checkpoint).toBeDefined();
    expect(checkpoint).toContain("2026-09-08 release-policy supersession");
    expect(checkpoint).toContain("historical pre-tag live-proof requirements no longer govern artifact release");
    expect(checkpoint).toContain("blocks hosted deployment and activation, not artifact publication");
    expect(phase6).toBeDefined();
    expect(phase6).toContain("The fresh exact-tree aggregate remains required");
    expect(phase6).toContain("Authenticated combined proof is required only to claim live qualification, not for phase 7 source admission or artifact release");
    expect(phase6).not.toContain("exact-tree aggregate and authenticated combined proof remain required");
    expect(phase10).toBeDefined();
    expect(phase10).toContain("**Artifact acceptance:**");
    expect(phase10).toContain("**Hosted rollout acceptance:**");
    expect(phase10).toContain("before claiming hosted delivery or completing this phase");
    expect(phase10).toContain("Missing deployment authority keeps hosted work pending but does not block artifact publication");
    expect(phase10).toContain("**Optional runtime qualification:**");
    expect(phase10).toContain("Artifact shipping may complete while live qualification remains incomplete");
    expect(phase10).toContain("without activating a daemon or hosted writer before its separate capacity and target gates pass");
    expect(phase10).not.toContain("Do not tag or publish the integrated v0.7 release before");
  });

  test("requires verified evidence before publishing v0.6.3 admission copy", async () => {
    const releaseRecord = await readFile(join(import.meta.dir, "..", "docs", "beta-release.md"), "utf8");
    expect(releaseRecord.includes("UNVERIFIED_LOCAL_DRAFT")).toBe(false);
    expect(releaseRecord.split("## Immutable v0.6.3 successful release record\n")).toHaveLength(2);
    const currentRecord = releaseRecord.split("## Immutable v0.6.3 successful release record\n")[1]
      ?.split("\n## ")[0];
    expect(currentRecord).toBeDefined();
    expect(currentRecord).toContain("completed successfully");
    expect(currentRecord).toContain("SHA-256");
    expect(currentRecord).toContain("provenance");
    expect(currentRecord).toContain("This is artifact admission only");
    for (const evidence of [
      "633308ebe11adffecfaff1a4bea1c199f762df2d",
      "b1f7743626bc93c135efdd441e235ac85ddd4c42",
      "8f0399c41fd384fc987e4e5ea2e280e5e4aab569",
      "34164885896",
      "34165802848",
      "attempt 2",
      "HTTP 404",
      "Admit exact public npm and GitHub state",
      "384339082",
      "549449969",
      "ae75cef126d32587fd9d3a1a755f8c126b2200107f55c5a412ccb15799363446",
      "549450038",
      "02f13245ceee5e8d0a85279fb08733de4d6ff4201baafec7e9ef58c8bb936766",
    ]) expect(currentRecord).toContain(evidence);
  });

  test("binds v0.7.0 admission copy to the completed recovery and immutable public bytes", async () => {
    const root = join(import.meta.dir, "..");
    const [releaseRecord, releaseNotes, changelog] = await Promise.all([
      readFile(join(root, "docs", "beta-release.md"), "utf8"),
      readFile(join(root, "docs", "beta-release-notes.md"), "utf8"),
      readFile(join(root, "CHANGELOG.md"), "utf8"),
    ]);
    const heading = "## Immutable v0.7.0 successful release record\n";
    expect(releaseRecord.split(heading)).toHaveLength(2);
    const admitted = releaseRecord.split(heading)[1]?.split("\n## ")[0];
    expect(admitted).toBeDefined();
    for (const evidence of [
      "4241ed401d82aa4c04e9c85e18f56cc084fc808f",
      "b856c66113c9a8752dbb431fc578287c23279cfe",
      "5ad0c78e2798d9b490429854ec098bfec33fa27c",
      "34278486095",
      "completed successfully on attempt 2",
      "2026-09-08T21:26:37Z",
      "2026-09-08T21:28:05.902Z",
      "Attempt 1 created immutable GitHub Release",
      "failed when the bounded metadata-visibility readback did not complete",
      "preserved the tag, release and public bytes",
      "102242943990", "102243352864", "102243352898", "102244020086",
      "385063983", "551312890", "1,359,243-byte",
      "6a067b5efb48bb9253f132300b09e59ae45a6e90c8f97532b5deabdc802a1061",
      "551312956", "88-byte",
      "4316ed59ee09c7278a8cbea0be4dcaad282332a8d148cf3e29a77d5fa2abe83f",
      "10077341831", "1,359,995 bytes",
      "16b0be793d9be44da67dbdf7f86a8d2e90c12649004d2f69e5c60a9e4a556d8a",
      "2026-09-15T21:23:46Z",
      "sha512-T3eAkeEJrhVN/3/uYUi5IQ3eYqFbg+ln9VCEF008nJcJqRgiuzm6Oma+uTC1RIcUKWubr4WBFvDcF3iccNdLcw==",
      "814a2911aa248a08145f0b7dfed3b256c9035e29",
      "npm `latest` names `@hraness/hra@0.7.0`",
      "cryptographic provenance",
      "This is artifact admission only",
      "separate hosted capacity and target gates",
    ]) expect(admitted).toContain(evidence);
    expect(releaseRecord).not.toContain("UNVERIFIED_LOCAL_DRAFT");
    expect(releaseNotes).toContain("beta-release.md#immutable-v070-successful-release-record");
    expect(changelog).toContain("docs/beta-release.md#immutable-v070-successful-release-record");
    expect(changelog).not.toContain("## v0.7.0 (unreleased)");
  });

  test("binds v0.7.1 admission copy and recovery instructions to their own exact evidence", async () => {
    const root = join(import.meta.dir, "..");
    const [releaseRecord, releaseNotes, changelog, routing] = await Promise.all([
      readFile(join(root, "docs", "beta-release.md"), "utf8"),
      readFile(join(root, "docs", "beta-release-notes.md"), "utf8"),
      readFile(join(root, "CHANGELOG.md"), "utf8"),
      readFile(join(root, "kb", "plans", "model-routing-autonomy.md"), "utf8"),
    ]);
    const heading = "## Immutable v0.7.1 successful release record\n";
    expect(releaseRecord.split(heading)).toHaveLength(2);
    const admitted = releaseRecord.split(heading)[1]?.split("\n## ")[0];
    for (const evidence of [
      "61e22234cebd562a8cbcc1e62aa19e7640aeabaa",
      "5ab43f11cc597c2f73f7f2c8f276b22f15bfb8b5",
      "72a26dec74c999db5a5c20d69997474933129e2a",
      "34365455021", "34367591503", "completed successfully on attempt 2",
      "2026-09-09T15:31:26Z", "2026-09-09T15:24:22.283Z", "2026-09-09T15:38:01.271Z",
      "102520216739", "102520740240", "102520740373", "102521422910",
      "failed before provenance admission", "metadata remained absent",
      "102529716172", "102530249997", "102530250055", "102530908657",
      "No republication occurred", "preserved the tag, release and public bytes",
      "385620163", "552998115", "1,331,554-byte",
      "2c1a58d9f3a16c542f303668485731d2fd8f49721f5cb7ea7fd2a9d0ccdcf680",
      "552998162", "88-byte", "1b2669e8a1a54f7d590c237ee89c30592f5957a6b1780e9c309c45c46e918b70",
      "10111688372", "1,332,298 bytes", "2026-09-16T15:28:53Z",
      "6feca9bd9eb9b1ad4f915cd764f4235ccd78cca713ee4a9e89bc5395ebd27add",
      "sha512-ccnQnh1NtumzY3KcjiVbWXxl/tANTLM4P7B7YuvXNO2Wz/24TnRznJMFSToIk7s19iH0pqUzgRevHsmBsKBOmg==",
      "b4a1f2d7438b65fdc2a368766f5a746cc3453eb8",
      "npm `latest` names `@hraness/hra@0.7.1`",
      "cryptographic publication-attempt-1 provenance", "This is artifact admission only",
      "separate hosted capacity and target gates", "immutable source bytes",
    ]) expect(admitted).toContain(evidence);
    expect(releaseNotes).toContain("beta-release.md#immutable-v071-successful-release-record");
    expect(changelog).toContain("docs/beta-release.md#immutable-v071-successful-release-record");
    expect(changelog).not.toContain("## v0.7.1 (unreleased)");
    expect(releaseRecord).toContain("`v0.7.0`, and `v0.7.1` are complete publications");
    expect(releaseRecord).toContain("`v0.8.4` is the current admitted canonical GitHub artifact and exact-byte npm release; `v0.7.1` remains an admitted npm predecessor.");
    expect(releaseRecord).not.toContain("`v0.7.0` is the current admitted artifact.");
    expect(routing).toContain("The v0.7.1 artifact is fully admitted");
    expect(routing).toContain("Operational rollout remains pending");
    expect(releaseNotes).toContain("../README.md#get-started");
    expect(releaseNotes).toContain("https://oompa.app/docs/status/#install-and-update");
    expect(releaseNotes).not.toContain("../README.md#update-runbook");
    const recovery = releaseRecord.split("## Recover delayed public visibility\n")[1]?.split("\n## ")[0];
    for (const boundary of [
      "uncertain publication result, not permission to publish again",
      "Reconcile public state read-only before a retry",
      "Missing, mismatched or ambiguous evidence remains a hold",
      "existing strict branch/comparison helpers and final-ref readback",
      "gh run rerun <run-id> --repo hraness/oompa",
      "not a new run or a failed-job-only rerun",
      "A rerun is not inherently read-only", "resulting step evidence proves it",
      "Require all release jobs and final public admission to pass",
      "Never update, delete, retag, replace or republish immutable artifacts",
      "Release admission does not clear operational rollout gates",
    ]) expect(recovery).toContain(boundary);
  });

  test("closes bounded foundation and persistence delivery without claiming fleet or model admission", async () => {
    const root = join(import.meta.dir, "..", "kb", "plans");
    const [delivery, persistence, routing] = await Promise.all([
      readFile(join(root, "delivery-autonomy.md"), "utf8"),
      readFile(join(root, "canonical-profile-persistence.md"), "utf8"),
      readFile(join(root, "model-routing-autonomy.md"), "utf8"),
    ]);
    expect(delivery).toContain("| Machine-confidence foundation | Complete |");
    expect(delivery).toContain("| Bounded foundation propagation | Complete |");
    expect(delivery).toContain("| Wider fleet rollout | Continuing |");
    expect(delivery).toContain("No all-fleet current-state claim is made");
    expect(delivery).toContain("https://github.com/hraness/oh/pull/45");
    expect(delivery).toContain("https://github.com/hraness/personal-monorepo-template/pull/12");
    expect(persistence).toContain("The schema50 session/Work persistence slice and its public-site delivery are\ncomplete");
    expect(persistence).toContain("slice is included in admitted v0.7.0");
    expect(persistence).toContain("### Historical preparation and foundation evidence");
    const phase4 = routing.split("## Phase 4: Canonical profile identity and candidate admission\n")[1]
      ?.split("## Phase 5:")[0];
    expect(phase4).toBeDefined();
    expect(phase4).toContain("**Status:** In progress");
    expect(phase4).toContain("Generalized candidate-profile admission is **not started**");
    expect(phase4).toContain("Exact new-model capability evidence remains required before admission");
    expect(phase4).toContain("Schema50 is delivered in governed main");
    expect(phase4).not.toContain("schema50 draft");
    expect(routing).toContain("Privacy navigation and layout passed at width 390.");
    expect(routing).not.toContain("actual install/runbook clicks and privacy navigation\n  passed at widths");
  });

  test("keeps the retired fallback-bound path unreachable and exposes only the exact artifact workflow", async () => {
    const root = join(import.meta.dir, "..");
    const packageJson = asRecord(
      JSON.parse(await readFile(join(root, "package.json"), "utf8")),
      "package manifest",
    );
    const scripts = asRecord(packageJson.scripts, "package scripts");
    const releaseWorkflow = join(root, ".github", "workflows", "release.yml");
    const [domainRecord, releaseRecord] = await Promise.all([
      readFile(join(root, "docs", "domain-cutover.md"), "utf8"),
      readFile(join(root, "docs", "beta-release.md"), "utf8"),
    ]);

    expect(await Bun.file(releaseWorkflow).exists()).toBeTrue();
    expect(scripts["hosted:domain-cutover"]).toBeUndefined();
    expect(scripts["release:candidate"]).toBeUndefined();
    expect(scripts["release:publish"]).toBeUndefined();
    expect(scripts["release:canonical-alias"]).toBeUndefined();
    expect(domainRecord).toContain("Oompa v0 status: retired on 2026-08-27.");
    expect(domainRecord).toContain("current-project-only");
    expect(domainRecord).toContain("Oompa v0 is never a fallback");
    expect(domainRecord).toContain("--confirm-exact");
    expect(domainRecord).toContain("canonical-alias-release");
    expect(domainRecord).toContain("unresolved_prior_intent");
    expect(domainRecord).toContain("reasserts only the plan's exact source");
    expect(domainRecord).toContain("unresolved_current_intent");
    expect(releaseRecord.split("\n")[2]).toContain("Status: `v0.8.5` is an unreleased Devin provider and upgrade-repair candidate");
    expect(releaseRecord.split("\n")[2]).toContain("`v0.8.4` passed immutable GitHub and exact-byte npm release admission");
    expect(releaseRecord.split("\n")[2]).toContain("`v0.8.1` canonical GitHub predecessor");
    expect(releaseRecord.split("\n")[2]).toContain("its unadmitted npm mirror retain their historical records");
    expect(releaseRecord).toContain("Artifact admission does not clear the blocked hosted command-writer rollout or authorize daemon upgrades");
    expect(releaseRecord).toContain("At retirement, `hraness/oompa` had no `v0.1.0` tag");
    expect(releaseRecord).toContain("## Immutable v0.1.0 failure record");
    expect(releaseRecord).toContain("Release workflow run `33363290345`, attempt 1");
    expect(releaseRecord).toContain("job `99398751969`");
    expect(releaseRecord).toContain("before registry-only package policy, tarball or checksum creation");
    expect(releaseRecord).toContain("The unexpanded exact-artifact matrix and the publish job were skipped");
    expect(releaseRecord).toContain("The publication variable was deleted after the failure");
    expect(releaseRecord).toContain("## Immutable v0.1.1 failure record");
    expect(releaseRecord).toContain("Release workflow run `33368241909`, attempt 1");
    expect(releaseRecord).toContain("artifact `9749194160`");
    expect(releaseRecord).toContain("`artifacts/SHA256SUMS`");
    expect(releaseRecord).toContain("rejected that extensionless workflow file as `UNREVIEWED_FILE_TYPE`");
    expect(releaseRecord).toContain("moved generated and downloaded release bytes under `RUNNER_TEMP`");
    expect(releaseRecord).toContain("immutable public registry release `@hraness/oh@0.4.1`");
    expect(releaseRecord).toContain("## Immutable v0.1.2 partial failure record");
    expect(releaseRecord).toContain("Release workflow run `33373504473`, attempts 1 and 2");
    expect(releaseRecord).toContain("immutable GitHub Release `379612601`");
    expect(releaseRecord).toContain("Registry readback proves `@hraness/hra@0.1.2` is absent");
    expect(releaseRecord).toContain("pins Node 24.20.0 with npm 11.19.0");
    expect(releaseRecord).toContain("proves the exact OIDC exchange before creating another GitHub Release");
    expect(releaseRecord).toContain("forwards numeric repository-owner identity");
    expect(releaseRecord).toContain("## Immutable v0.1.3 failure record");
    expect(releaseRecord).toContain("tag object `61ebcaf33616bc29675053465725bc294f06f9d2`");
    expect(releaseRecord).toContain("reviewed `main` commit `eef84596ec3891bcd29691d087449641dfda7e62`");
    expect(releaseRecord).toContain("Release workflow run `33411496909`, attempt 1");
    expect(releaseRecord).toContain("Actions artifact `9765501271`");
    expect(releaseRecord).toContain("`sha256:df1f40d36e19b92b92c8d6b256e49c7caa54ed5850bf353dec2c38995b3d449b`");
    expect(releaseRecord).toContain("651,739-byte tarball with SHA-256 `cd7847d3e7c7369f05ad35bb80372e7a648875fc2201b1490591f9028db549ed`");
    expect(releaseRecord).toContain("88-byte checksum file with SHA-256 `371394f881aa1f0ed692ccf287c277571f2e0e78892f84a1652b5d3fea540f6c`");
    expect(releaseRecord).toContain("Publish job `99553962517` stopped at `Prove npm trusted-publisher exchange without publication`");
    expect(releaseRecord).toContain("later GitHub Release, npm publication, and public-admission steps were skipped");
    expect(releaseRecord).toContain("no `v0.1.3` GitHub Release or draft and no npm `0.1.3` exist");
    expect(releaseRecord).toContain("`latest` and `bootstrap` still name `0.1.0-bootstrap.0`");
    expect(releaseRecord).toContain("The publication variable was deleted");
    expect(releaseRecord).toContain("legacy distributed-task path and the bounded current hosted-runner `/idtoken/` path");
    expect(releaseRecord).toContain("permits only one `api-version=2.0` query parameter");
    expect(releaseRecord).toContain("## Immutable v0.1.4 failure record");
    expect(releaseRecord).toContain("tag object `5c7e6add3062096c9545b10eaafddfd43f0b903e`");
    expect(releaseRecord).toContain("reviewed `main` commit `586f954945f614c00efd12f13a0d43c6f5bb809c`");
    expect(releaseRecord).toContain("Release workflow run `33417025171`, attempts 1 and 2");
    expect(releaseRecord).toContain("Actions artifact `9767593195`, named `hra-release-1`, is 652,281 bytes");
    expect(releaseRecord).toContain("`sha256:6816535110350f9bb3d43424caf05f04cc930481a64d9dd4917e0b8e4e7fa4b4`");
    expect(releaseRecord).toContain("expires at `2026-09-07T17:04:20Z`");
    expect(releaseRecord).toContain("651,736-byte tarball with SHA-256 `d9c80317a85139347ec482d7b811aef57045af8175c72cc21e259d0e23249784`");
    expect(releaseRecord).toContain("88-byte `SHA256SUMS` file with SHA-256 `2c67963d34862b06edb818c72644db08585d618d72c17baf3d531a9520dd1a1c`");
    expect(releaseRecord).toContain("Publish jobs `99572060480` and `99574351110`");
    expect(releaseRecord).toContain("with `trusted_exchange_not_proven`");
    expect(releaseRecord).toContain("both `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` to `/dev/null`");
    expect(releaseRecord).toContain("before initialization");
    expect(releaseRecord).toContain("no `v0.1.4` GitHub Release and no npm `0.1.4` exist");
    expect(releaseRecord).toContain("distinct private mode-`0600` user and global npm configuration files");
    expect(releaseRecord).toContain("fresh mode-`0700` directory");
    expect(releaseRecord).toContain("`publisher_configuration_failed`");
    expect(releaseRecord).toContain("`publisher_configuration_cleanup_failed`");
    expect(releaseRecord).toContain("`Successfully retrieved and set token`");
    expect(releaseRecord).toContain("## Immutable v0.1.5 successful release record");
    expect(releaseRecord).toContain("tag object `2503c4cccd52f4de9e8fb966f8050a08d26a3d06`");
    expect(releaseRecord).toContain("reviewed `main` commit `8e9b253bcebe07fc08289f033aaaeda6c574774d`");
    expect(releaseRecord).toContain("Release workflow run `33427625936`, attempts 1 and 2");
    expect(releaseRecord).toContain("Attempt 1 publish job `99607830579`");
    expect(releaseRecord).toContain("bounded post-publication verification request ended with `TimeoutError`");
    expect(releaseRecord).toContain("Attempt 2 publish job `99611394355`");
    expect(releaseRecord).toContain("skipped the first-publication OIDC dry run");
    expect(releaseRecord).toContain("Retained Actions artifact `9771995410`, named `hra-release-2`, is 652,272 bytes");
    expect(releaseRecord).toContain("`sha256:5e52442c02ee3fb8abee520df41a19e48ef9047f24eb6f160ece1686b2331efb`");
    expect(releaseRecord).toContain("expires at `2026-09-07T19:14:29Z`");
    expect(releaseRecord).toContain("GitHub asset `538406590` is the 651,736-byte `hraness-hra-0.1.5.tgz`");
    expect(releaseRecord).toContain("`48f579f8bee54dbf87ccd5f54ff5d4bf89abd9ba9025280344ad0fe9bfdc57c6`");
    expect(releaseRecord).toContain("asset `538406604` is the 88-byte `SHA256SUMS` file");
    expect(releaseRecord).toContain("`a947561b784a41473d5728dfcc96cc6e9d50ba7b542d0010faf3997a041a7091`");
    expect(releaseRecord).toContain("`sha512-Kv5JY5hbijho5MW79s7bygLb120pQ6RM8EV7aHycETK/hImL0/UQQuC9f72Vtgt4NSF39Glh1EVBFQXdddeGTw==`");
    expect(releaseRecord).toContain("`f598c36c331f87676382dfffd19907a8e9107b8f`");
    expect(releaseRecord).toContain("isolated public installation returned `hra-install-safe`");
    expect(releaseRecord).toContain("The publication variable remains absent");
    expect(releaseRecord).toContain("## Immutable v0.1.6 successful release record");
    expect(releaseRecord).toContain("tag object `f125f3dc3d77d41d905327faa1cf825e8f3b0b92`");
    expect(releaseRecord).toContain("reviewed `main` commit `b787e4d767d9bc95a70952e1002c150f5f33661c`");
    expect(releaseRecord).toContain("tree `f46d779d7c56cf011757471790b4c5cd72cf5747`");
    expect(releaseRecord).toContain("merged through PR 65");
    expect(releaseRecord).toContain("Exact-main CI run `33562319207` passed");
    expect(releaseRecord).toContain("Release workflow run `33562952832`, attempts 1 through 3");
    expect(releaseRecord).toContain("Attempt 1 verifier job `100039504965`");
    expect(releaseRecord).toContain("macOS job `100042411399`");
    expect(releaseRecord).toContain("Ubuntu job `100042411450`");
    expect(releaseRecord).toContain("publish job `100042677957`");
    expect(releaseRecord).toContain("HTTP 404 from npm's Sigstore attestations endpoint");
    expect(releaseRecord).toContain("Attempt 2 used verifier job `100043256132`");
    expect(releaseRecord).toContain("macOS job `100043256791`");
    expect(releaseRecord).toContain("Ubuntu job `100043256627`");
    expect(releaseRecord).toContain("publish job `100043256070`");
    expect(releaseRecord).toContain("stopped with `version_conflict`");
    expect(releaseRecord).toContain("Attempt 3 verifier job `100043668390`");
    expect(releaseRecord).toContain("macOS job `100045311262`");
    expect(releaseRecord).toContain("Ubuntu job `100045311412`");
    expect(releaseRecord).toContain("publish job `100045528708`");
    expect(releaseRecord).toContain("skipped the first-publication OIDC dry run");
    expect(releaseRecord).toContain("completed final public admission");
    expect(releaseRecord).toContain("Actions artifact `9822648569`, named `hra-release-3`, is 658,170 bytes");
    expect(releaseRecord).toContain("`sha256:4a4b8f796b3facba97b2ef1a92be916d21637060df48451044ac6b736cb464b3`");
    expect(releaseRecord).toContain("expires at `2026-09-08T22:08:27Z`");
    expect(releaseRecord).toContain("GitHub Release `380848789`");
    expect(releaseRecord).toContain("node `RE_kwDOUAyvX84Ws0qV`");
    expect(releaseRecord).toContain("asset `540202136`, the 657,619-byte `hraness-hra-0.1.6.tgz`");
    expect(releaseRecord).toContain("`c26a9352a8cefd032794a94c0c05c11319897890a78fa4c6e0eb6f2506635aca`");
    expect(releaseRecord).toContain("asset `540202181`, the 88-byte `SHA256SUMS` file");
    expect(releaseRecord).toContain("`de24d6c71005c7528562fff09200e529adfa119d4c1f469f46562931ceaf96c9`");
    expect(releaseRecord).toContain("npm `latest` names `@hraness/hra@0.1.6`");
    expect(releaseRecord).toContain("`sha512-Olb/QneV4Qy4oRabwINocuhakrJLOsm0omCHcFK5bkFqnzCNn5vYd0LplXTEtPxNe+yWqiSBHi+98v+6bLtbZQ==`");
    expect(releaseRecord).toContain("`a36bc66b0c727741c0306e695da8a13ce2104704`");
    expect(releaseRecord).toContain("provenance is present and independent download comparison is byte-identical");
    expect(releaseRecord).toContain("`v0.1.6` is the supported public CLI beta");
    expect(releaseRecord).toContain("Ordinary pull-request and `main` CI uses the same governed-history principle");
    expect(releaseRecord).toContain("unshallows only that exact commit into `refs/remotes/ci/verified`");
    expect(releaseRecord).toContain("The package gate still scans `rev-list --all`");
    expect(releaseRecord).toContain("coordinate completed its non-executable bootstrap");
    expect(releaseRecord).toContain("npm trusted publishing has exactly one binding");
    expect(releaseRecord).toContain("Stable `@hraness/hra@0.7.1` remains an admitted npm predecessor");
    expect(releaseRecord).toContain("current canonical GitHub artifact and admitted exact-byte npm mirror are `@hraness/oompa@0.8.4`");
    expect(releaseRecord).toContain("The canonical README and website use a two-phase local-release surface");
    expect(releaseRecord).toContain("The `v0.8.3` canonical GitHub artifact and exact-byte npm mirror are admitted.");
    expect(releaseRecord).toContain("The release-bound README and package metadata retain their original pre-admission wording");
    expect(releaseRecord).toContain("Current installation notes name the immutable release, archive, and tagged transactional installer");
    expect(releaseRecord).toContain("this factual documentation update does not replace those immutable bytes");
    expect(releaseRecord).toContain("[admitted v0.8.4 installation notes](beta-release-notes.md#admitted-v084-artifacts)");
    expect(releaseRecord).toContain("https://github.com/hraness/hra/tree/v0.7.1#get-started");
    expect(releaseRecord).toContain("https://github.com/hraness/hra/blob/v0.6.1/docs/beta-release-notes.md#install");
    expect(releaseRecord).toContain("Hosted sync went live separately on 2026-09-03");
    expect(releaseRecord).toContain("Preserve old local state-protocol receipts, mutation intents, and evidence files");
    expect(releaseRecord).toContain("The singleton `$BUN_INSTALL/install/oompa/install-intent.json` is different");
    expect(releaseRecord).toContain("settle it only with the exact immutable installer from its originating release");
    expect(releaseRecord).toContain("never treat that local recovery as authorization to retry or mutate the historical release workflow");
    expect(releaseRecord).toContain("## Immutable v0.5.0 successful release record");
    expect(releaseRecord).toContain("tag object `b91b0d30168cc684b762483ea2f652d2a576fe3a`");
    expect(releaseRecord).toContain("Release workflow run `33903621032` completed on attempt 3");
    expect(releaseRecord).toContain("GitHub Release `382922988`");
    expect(releaseRecord).toContain("npm `latest` names `@hraness/hra@0.5.0`");
    expect(releaseRecord).toContain("## Immutable v0.6.0 partial publication record");
    expect(releaseRecord).toContain("tag object `c03c66a27398b2baf6f8dfc9bd04bcee5cc65459`");
    expect(releaseRecord).toContain("commit `576ccd76a6742cd62759ab6176a6a41844846daa`, merged through PR 122");
    expect(releaseRecord).toContain("Exact-main CI run `34056770875` passed");
    expect(releaseRecord).toContain("Release workflow run `34057589482` failed on attempts 1 and 2");
    expect(releaseRecord).toContain("final public admission was skipped on both attempts");
    expect(releaseRecord).toContain("Attempt 1 verifier job `101552204026`, Ubuntu job `101552368631`, and macOS job `101552368651` succeeded");
    expect(releaseRecord).toContain("Publish job `101552609010` proved the npm trusted-publisher exchange");
    expect(releaseRecord).toContain("Attempt 2 verifier job `101555723682`, Ubuntu job `101555918855`, and macOS job `101555918878` succeeded");
    expect(releaseRecord).toContain("Publish job `101556083200` found the exact npm bytes");
    expect(releaseRecord).toContain("OID `.24` to end in `:ref:refs/tags/v0.6.0`");
    expect(releaseRecord).toContain("DER UTF8String `npm-release` in OID `.23`");
    expect(releaseRecord).toContain("`repo:hraness@307125679/hra@1343008607:environment:npm-release` in OID `.24`");
    expect(releaseRecord).toContain("Actions artifact `9996840156`, named `hra-release-2`, is 1,101,922 bytes");
    expect(releaseRecord).toContain("`sha256:874cde519d9297dbbb41d004cfc716d7ca5f7b589f18cd80297bc7e0d52aff4f`");
    expect(releaseRecord).toContain("created at `2026-09-06T20:45:15Z`");
    expect(releaseRecord).toContain("expires at `2026-09-13T20:45:13Z`");
    expect(releaseRecord).toContain("GitHub Release `383705969`, node `RE_kwDOUAyvX84W3uNx`");
    expect(releaseRecord).toContain("published at `2026-09-06T20:22:19Z`");
    expect(releaseRecord).toContain("asset `547641759`, the 1,101,240-byte `hraness-hra-0.6.0.tgz`");
    expect(releaseRecord).toContain("`f9f1bfecddd867e4ca781a2a045dc9573bd91eb9810fef75b2d28e8af0c37813`");
    expect(releaseRecord).toContain("asset `547641805`, the 88-byte `SHA256SUMS`");
    expect(releaseRecord).toContain("`659a510969f0e36f1f5f0e7fef739d4ee743ebb625c2052a2aba770ce30ef6fc`");
    expect(releaseRecord).toContain("npm `latest` names `@hraness/hra@0.6.0`");
    expect(releaseRecord).toContain("`bootstrap` remains `0.1.0-bootstrap.0`");
    expect(releaseRecord).toContain("`sha512-u49sO2O8i2KUFVxUFdeDoPwkQetOLBV31ULsuz5jxQN5nh/BgT55+CnRvAyneoBUsyZ+dZ/u0PsoJeKnRH0vhA==`");
    expect(releaseRecord).toContain("`16c4057d1a055d3f4bcecc4a070dc2b226060523`");
    expect(releaseRecord).toContain("`v0.5.0` remained the last fully admitted public CLI until the separate `v0.6.1` forward repair completed exact admission");
    expect(releaseRecord).toContain("## Immutable v0.6.2 successful release record");
    expect(releaseRecord).toContain("Release run 34156958618");
    expect(releaseRecord).toContain("b5bc2a9125885c6ace33a70137202e99e1d6774f5d8945fac9bb96b6353c930c");
    expect(releaseRecord).toContain("## Immutable v0.6.1 successful release record");
    expect(releaseRecord).toContain("tag object `3d229acc034e4a2d3cb392a9e7fd6afe52be37a7`");
    expect(releaseRecord).toContain("commit `a75e7487594ce5b68345ccd3536974a10f7a93ee`");
    expect(releaseRecord).toContain("Release workflow run `34140171965`");
    expect(releaseRecord).toContain("completed successfully on attempt 2 at `2026-09-07T16:02:13Z`");
    expect(releaseRecord).toContain("Actions artifact `10025888497`");
    expect(releaseRecord).toContain("GitHub Release `384196103`");
    expect(releaseRecord).toContain("`13669691caf3ae63bd6d88a7fab14a71e353ea1793f782d44e3cfcffe450b235`");
    expect(releaseRecord).toContain("npm `latest` names `@hraness/hra@0.6.1`");
    expect(releaseRecord).toContain("This is artifact admission only");
    expect(releaseRecord).toContain("hard-quota-blocked with no activation receipt");
    expect(releaseRecord).toContain("strict successful `Required` checks, resolved review conversations");
    expect(releaseRecord).toContain("These main-branch rulesets have no administrator bypass");
    expect(releaseRecord).toContain("GitHub does not currently require approving reviews, CODEOWNERS approval, or stale-approval dismissal");
    expect(releaseRecord).toContain("Record an independent agent review of the exact release commit and tree");
    expect(releaseRecord).toContain("repeat it after any tree change; successful CI alone is not review evidence");
    expect(releaseRecord).toContain("immutable owner User ID `894119`");
    expect(releaseRecord).toContain("`Release tag creation` ruleset `22307191` restricts creation only");
    expect(releaseRecord).toContain("provider readback of both rulesets is a release prerequisite");
    expect(releaseRecord).toContain("sole always-bypass to immutable owner User ID `894119`");
    expect(releaseRecord).toContain("Never put creation, update, and deletion in one bypassed ruleset");
    expect(releaseRecord).toContain("outer digest is a transport assertion, not independent release authority");
    expect(releaseRecord).toContain("`@hraness/hra@0.1.0-bootstrap.0`");
    expect(releaseRecord).toContain("npm also assigns `latest` to the first published version");
    expect(releaseRecord).toContain("resolves through both `bootstrap` and `latest`");
    expect(releaseRecord).toContain("Exact `0.1.6` publication moved `latest`");
    expect(releaseRecord).not.toContain("becomes authoritative only when");
    expect(releaseRecord).not.toContain("publication will move `latest`");
    expect(releaseRecord).toContain("every earlier attempt's bounded GitHub Jobs API record");
    expect(releaseRecord).toContain("again immediately before the POST");
    expect(releaseRecord).toContain("successful admission independently proved `dist-tags.latest` naming `0.7.0`");
    expect(releaseRecord).toContain("the owner-authorized exact annotated tag is the publication authorization");
    expect(releaseRecord).toContain("exact event `push`");
    expect(releaseRecord).not.toContain("must remove it before the next release");
    expect(releaseRecord).toContain("binding `41124856-baa6-46ad-b242-6e3278c73ce8`");
    expect(releaseRecord).toContain("binding `28b1ff93-c1b0-42a7-bef6-41bffb992eb2`");
    expect(releaseRecord).toContain("environment `npm-release`");
    expect(releaseRecord).toContain("permissions `publish, stage publish`");
    expect(releaseRecord).toContain("npm CLI 11.19.0");
    expect(releaseRecord).toContain("numeric owner ID `307125679`");
    expect(releaseRecord).toContain("owner ID `307125679`");
    const workflow = await readFile(releaseWorkflow, "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain('npm pack --ignore-scripts --pack-destination "$release_artifacts" .');
    expect(workflow).toContain("release-artifact-checksum.ts");
    expect(workflow).toContain("check-release-package.ts");
    expect(workflow).toContain("check-npm-artifact-state.ts");
    expect(workflow).toContain("check-npm-trusted-publisher-oidc.ts");
    expect(workflow).toContain("publish-npm-release.ts");
    expect(workflow).toContain("publish-github-release.ts");
    expect(workflow).toContain("check-public-release.ts");
    expect(workflow).toContain("os: [ubuntu-24.04, macos-15]");
    expect(workflow).toContain("npm_preflight_run_attempt");
    expect(workflow).toContain("OOMPA_NPM_PREFLIGHT_RUN_ATTEMPT");
    expect(workflow).not.toContain("OOMPA_APPROVE_NPM_PUBLICATION");
    expect(workflow).not.toContain("release-candidate.ts");
    expect(workflow).not.toContain("publish-beta-release.ts");
    for (const retired of [
      "publish-beta-release.ts",
      "publish-beta-release.test.ts",
      "release-candidate.ts",
      "release-candidate.test.ts",
    ]) expect(await Bun.file(join(import.meta.dir, retired)).exists()).toBeFalse();
    expect(workflow).not.toContain("oompa-weld.vercel.app");
    expect(workflow).not.toContain("hra.vercel.app");
    expect(workflow).not.toContain("convex");
  });

  test("requires all six source shards and both remainder lanes on both operating systems with complete governed history", async () => {
    const workflow = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const document = asRecord(Bun.YAML.parse(workflow), "CI workflow");
    const jobs = asRecord(document.jobs, "CI workflow jobs");
    const check = asRecord(jobs.check, "CI check job");
    const menubar = asRecord(jobs.menubar, "CI menubar job");
    const required = asRecord(jobs.required, "CI required job");
    expect(Object.keys(jobs).sort()).toEqual(["browser", "check", "menubar", "required"]);
    expect(check.name).toBe("Check (${{ matrix.os }}, ${{ matrix.gate }})");
    expect(check["runs-on"]).toBe("${{ matrix.os }}");
    expect(check["timeout-minutes"]).toBe("${{ startsWith(matrix.gate, 'remainder') && (matrix.os == 'macos-15' && 25 || 20) || 75 }}");
    expect(check.if).toBeUndefined();
    expect(check["continue-on-error"]).toBeUndefined();
    expect(check.strategy).toEqual({
      "fail-fast": false,
      matrix: {
        os: ["macos-15", "ubuntu-24.04"],
        gate: ["source-1", "source-2", "source-3", "source-4", "source-5", "source-6", "remainder-checks", "remainder-suites"],
      },
    });
    const steps = check.steps;

    if (!Array.isArray(steps)) {
      throw new TypeError("CI check job steps must be an array");
    }

    const parsedSteps = steps.map((step, index) => asRecord(step, `CI step ${index}`));
    const linuxStepNames = new Set([
      "Install pinned Rust 1.97.1 for authority supervisor (Linux)",
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "Enable isolated user namespaces for native custody checks",
      "Restore Ubuntu user-namespace restriction",
    ]);
    for (const step of parsedSteps) {
      expect(step["continue-on-error"]).toBeUndefined();
      if (!linuxStepNames.has(String(step.name))) expect(step.if).toBeUndefined();
    }
    expect(parsedSteps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string"))
      .toEqual([reviewedActions.checkout, reviewedActions.setupBun]);
    expect(parsedSteps.map((step) => step.name)).toEqual([
      "Check out source",
      "Fetch only governed CI history",
      "Install Bun",
      "Install dependencies",
      "Install pinned Rust 1.97.1 for authority supervisor (Linux)",
      "Rebuild and verify authority-supervisor artifacts (Linux)",
      "Enable isolated user namespaces for native custody checks",
      "Run the repository gate",
      "Restore Ubuntu user-namespace restriction",
    ]);
    const checkout = parsedSteps.find((step) => step.name === "Check out source");
    const fetch = parsedSteps.find((step) => step.name === "Fetch only governed CI history");
    const install = parsedSteps.find((step) => step.name === "Install dependencies");
    const gate = parsedSteps.find((step) => step.name === "Run the repository gate");

    const checkoutIndex = parsedSteps.indexOf(asRecord(checkout, "CI checkout step"));
    const fetchIndex = parsedSteps.indexOf(asRecord(fetch, "CI governed-history step"));
    const installIndex = parsedSteps.indexOf(asRecord(install, "CI install step"));
    expect(fetchIndex).toBe(checkoutIndex + 1);
    expect(installIndex).toBeGreaterThan(fetchIndex);
    expect(asRecord(checkout, "CI checkout step").with).toEqual({
      "fetch-depth": 1,
      "fetch-tags": false,
      "persist-credentials": false,
      ref: "${{ github.sha }}",
    });
    expect(asRecord(asRecord(fetch, "CI governed-history step").env, "CI governed-history environment").VERIFIED_SHA)
      .toBe("${{ github.sha }}");
    const governedHistory = String(asRecord(fetch, "CI governed-history step").run);
    expect(governedHistory).toContain('[[ ! "$VERIFIED_SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(governedHistory).toContain("git fetch --force --no-tags --unshallow origin");
    expect(governedHistory).toContain('+$VERIFIED_SHA:refs/remotes/ci/verified');
    expect(governedHistory).toContain("git rev-parse --is-shallow-repository");
    expect(governedHistory).toContain("git rev-parse --verify 'HEAD^{commit}'");
    expect(governedHistory).toContain("git rev-parse --verify 'refs/remotes/ci/verified^{commit}'");
    expect(governedHistory).toContain("git for-each-ref --format='%(refname)'");
    expect(governedHistory).toContain("Unexpected ref entered governed CI history");
    expect(governedHistory).toContain("wc -l | tr -d ' '");
    expect(governedHistory).not.toContain("refs/heads/*");
    expect(governedHistory).not.toContain("github.head_ref");
    expect(governedHistory).not.toContain("pull_request.head.sha");
    expect(asRecord(install, "CI install step").run).toBe("bun install --frozen-lockfile --ignore-scripts");
    const gateStep = asRecord(gate, "CI gate step");
    expect(gateStep.if).toBeUndefined();
    expect(String(gateStep.run).trim().replace(/\s+/gu, " ")).toBe(
      'set -euo pipefail case "$CI_GATE" in source-1) bun run test:source --shard=1/6 ;; source-2) bun run test:source --shard=2/6 ;; source-3) bun run test:source --shard=3/6 ;; source-4) bun run test:source --shard=4/6 ;; source-5) bun run test:source --shard=5/6 ;; source-6) bun run test:source --shard=6/6 ;; remainder-checks) bun run check:ci-remainder-checks ;; remainder-suites) bun run check:ci-remainder-suites ;; *) echo "::error::Unexpected CI gate" exit 1 ;; esac',
    );
    expect(asRecord(asRecord(gate, "CI gate step").env, "CI gate environment")).toEqual({
      NODE_OPTIONS: "--max-old-space-size=4096",
      CI_GATE: "${{ matrix.gate }}",
    });
    // The gate already verifies generated public documents and runs the
    // Linux custody test through `bun test ./scripts`; CI does not repeat them.
    const packageScripts = asRecord(asRecord(
      JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8")),
      "package manifest",
    ).scripts, "package scripts");
    expect(packageScripts.check).toBe(aggregateCheckCommand);
    expect(packageScripts.test).toBe(aggregateTestCommand);
    expect(packageScripts["test:source"]).toBe(sourceTestCommand);
    requireCiGateCoverage(packageScripts);
    expect(workflow).not.toContain("build:site -- --check");
    expect(workflow).not.toContain("authority-supervisor-runtime.test.ts");

    expect(menubar.name).toBe("Menu-bar companion");
    expect(menubar["runs-on"]).toBe("macos-15");
    expect(menubar.if).toBeUndefined();
    expect(menubar["continue-on-error"]).toBeUndefined();
    if (!Array.isArray(menubar.steps)) {
      throw new TypeError("CI menubar job steps must be an array");
    }
    const menubarSteps = menubar.steps.map((step, index) => asRecord(step, `CI menubar step ${index}`));
    for (const step of menubarSteps) {
      expect(step.if).toBeUndefined();
      expect(step["continue-on-error"]).toBeUndefined();
    }
    expect(menubarSteps
      .map((step) => step.uses)
      .filter((value): value is string => typeof value === "string"))
      .toEqual([
        reviewedActions.checkout,
        reviewedActions.rustToolchain,
        reviewedActions.rustCache,
      ]);
    expect(menubarSteps.map((step) => step.name)).toEqual([
      "Check out exact source",
      "Install Rust",
      "Restore Rust dependencies",
      "Build and test the menu-bar companion",
    ]);
    const menubarBuild = asRecord(menubarSteps[3], "CI menubar build step");
    expect(String(menubarBuild.run).trim().replace(/\s+/gu, " ")).toBe(
      "set -euo pipefail cargo build --release --locked --manifest-path desktop/Cargo.toml cargo test --locked --manifest-path desktop/Cargo.toml",
    );

    expect(required.name).toBe("Required");
    expect(required.needs).toEqual(["check", "browser", "menubar"]);
    expect(required.if).toBe("${{ always() }}");
    expect(required["continue-on-error"]).toBeUndefined();
    if (!Array.isArray(required.steps)) {
      throw new TypeError("CI required job steps must be an array");
    }
    const requiredStep = asRecord(required.steps[0], "CI required step");
    expect(required.steps).toHaveLength(1);
    expect(requiredStep.if).toBeUndefined();
    expect(requiredStep["continue-on-error"]).toBeUndefined();
    expect(requiredStep.name).toBe("Require every matrix check");
    expect(asRecord(requiredStep.env, "CI required environment")).toEqual({
      CHECK_RESULT: "${{ needs.check.result }}",
      BROWSER_RESULT: "${{ needs.browser.result }}",
      MENUBAR_RESULT: "${{ needs.menubar.result }}",
    });
    expect(requiredStep.run).toBe('test "$CHECK_RESULT" = "success" && test "$BROWSER_RESULT" = "success" && test "$MENUBAR_RESULT" = "success"');
  });

  test("keeps scoped Ubuntu Chromium setup mandatory before the unchanged compiled browser gate", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "ci.yml"), "utf8",
    )), "CI workflow");
    const browser = asRecord(asRecord(workflow.jobs, "CI jobs").browser, "CI browser job");
    expect(browser["runs-on"]).toBe("ubuntu-24.04");
    expect(browser["timeout-minutes"]).toBe(20);
    expect(browser.if).toBeUndefined();
    expect(browser["continue-on-error"]).toBeUndefined();
    if (!Array.isArray(browser.steps)) throw new TypeError("CI browser steps must be an array");
    const steps = browser.steps.map((step, index) => asRecord(step, `CI browser step ${index}`));
    expect(steps.map((step) => step.name)).toEqual([
      "Check out exact source", "Install Bun", "Install frozen dependencies", "Install the browser driver runtime",
      "Install package-pinned Chromium", "Verify compiled browser surfaces", "Retain browser acceptance receipts",
    ]);
    for (const step of steps) {
      expect(step["continue-on-error"]).toBeUndefined();
      expect(step.if).toBe(step.name === "Retain browser acceptance receipts" ? "${{ always() }}" : undefined);
    }
    const runtime = asRecord(steps.find((step) => step.name === "Install the browser driver runtime"), "browser runtime step");
    expect(runtime.uses).toBe(reviewedActions.setupNode);
    expect(runtime.with).toEqual({ "node-version": "24.18.1", "package-manager-cache": false });
    const install = asRecord(steps.find((step) => step.name === "Install package-pinned Chromium"), "browser install step");
    expect(install.run).toBe("node ./scripts/install-ci-chromium-deps.ts");
    expect(install.env).toBeUndefined();
    const verify = asRecord(steps.find((step) => step.name === "Verify compiled browser surfaces"), "browser gate step");
    expect(String(verify.run).trim()).toBe([
      "set -euo pipefail",
      'BUN_EXECUTABLE_PATH="$(command -v bun)"',
      'CHROMIUM_EXECUTABLE_PATH="$(node --input-type=module -e \'import { chromium } from "playwright-core"; console.log(chromium.executablePath())\')"',
      "export BUN_EXECUTABLE_PATH CHROMIUM_EXECUTABLE_PATH",
      'test -x "$BUN_EXECUTABLE_PATH"',
      'test -x "$CHROMIUM_EXECUTABLE_PATH"',
      "bun run check:browser",
    ].join("\n"));
    expect(verify.env).toBeUndefined();
  });

  test("admits only a tagged commit whose CI run concluded success before packaging", async () => {
    const source = await readFile(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    const workflow = asRecord(Bun.YAML.parse(source), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const verify = asRecord(jobs.verify, "release verify job");
    expect(asRecord(verify.permissions, "release verify permissions")).toEqual({
      actions: "read",
      contents: "read",
    });
    expect(verify.env).toBeUndefined();
    if (!Array.isArray(verify.steps)) throw new TypeError("release verify steps must be an array");
    const steps = verify.steps.map((step, index) => asRecord(step, `verify step ${index}`));
    const identityIndex = steps.findIndex((step) => step.id === "identity");
    const readbackIndex = steps.findIndex((step) => step.name === "Require the exact commit's successful CI run");
    const packageIndex = steps.findIndex((step) => step.name === "Create one exact npm tarball and checksum");
    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(readbackIndex).toBeGreaterThan(identityIndex);
    expect(packageIndex).toBeGreaterThan(readbackIndex);
    const readback = steps[readbackIndex];
    expect(readback?.if).toBeUndefined();
    expect(readback?.run).toBe("bun run ./scripts/check-commit-ci-run.ts");
    expect(asRecord(readback?.env, "CI readback environment")).toEqual({
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      GITHUB_TOKEN: "${{ github.token }}",
      VERIFIED_SHA: "${{ steps.identity.outputs.sha }}",
    });
    for (const step of steps) {
      if (step === readback) continue;
      const environment = step.env === undefined ? {} : asRecord(step.env, `${String(step.name)} environment`);
      expect(environment.GH_TOKEN, String(step.name)).toBeUndefined();
      expect(environment.GITHUB_TOKEN, String(step.name)).toBeUndefined();
    }

    const readbackSource = await readFile(join(import.meta.dir, "check-commit-ci-run.ts"), "utf8");
    expect(readbackSource).toContain('export const ciWorkflowPath = ".github/workflows/ci.yml"');
    expect(readbackSource).toContain('export const ciRequiredJobName = "Required"');
    expect(readbackSource).toContain("/actions/workflows/ci.yml/runs?");
    expect(readbackSource).toContain('run.status !== "completed"');
    expect(readbackSource).toContain('run.conclusion !== "success"');
    expect(readbackSource).toContain('job.conclusion !== "success"');
    expect(readbackSource).toContain("readBoundedJsonResponse(response, label, MAXIMUM_JSON_BYTES)");
    expect(readbackSource).not.toContain("gh api");
    expect(readbackSource).not.toContain("response.json()");
  });

  test("pins the privileged release TCB and scopes GitHub tokens to exact steps", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    )), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    expect(asRecord(jobs.publish, "canonical job").needs).toEqual(["verify", "exact_artifact"]);
    expect(asRecord(jobs.npm_preflight, "npm admission job").needs).toEqual(["verify", "publish"]);
    expect(asRecord(jobs.npm_mirror, "npm mirror job").needs).toEqual(["verify", "publish", "npm_preflight"]);
    expect(Object.keys(jobs).sort()).toEqual(["exact_artifact", "npm_mirror", "npm_preflight", "publish", "verify"]);
    for (const jobName of ["publish", "npm_preflight", "npm_mirror"] as const) {
      const publish = asRecord(jobs[jobName], `${jobName} job`);
      expect(publish.environment).toBe(jobName === "npm_mirror" ? "npm-release" : undefined);
      expect(asRecord(publish.permissions, "release job permissions")).toEqual({
        actions: "read",
        contents: jobName === "publish" ? "write" : "read",
        ...(jobName === "npm_mirror" ? { "id-token": "write" } : {}),
      });
      const jobEnvironment = asRecord(publish.env, "release publish environment");
      expect(jobEnvironment.GH_TOKEN).toBeUndefined();
      expect(jobEnvironment.GITHUB_TOKEN).toBeUndefined();

      if (!Array.isArray(publish.steps)) {
        throw new TypeError("release publish job steps must be an array");
      }
      const steps = publish.steps.map((step, index) => asRecord(step, `release publish step ${index}`));
      expect(steps
        .map((step) => step.uses)
        .filter((value): value is string => typeof value === "string"))
        .toEqual([
          reviewedActions.checkout,
          reviewedActions.setupBun,
          reviewedActions.setupNode,
          reviewedActions.downloadArtifact,
        ]);

      for (const step of steps.filter((candidate) => candidate.uses === reviewedActions.setupNode)) {
        expect(asRecord(step.with, "release setup-node inputs")).toEqual({
          "node-version": "24.20.0",
          "package-manager-cache": false,
        });
      }

      const tokenEnvironments = Object.fromEntries(steps.map((step) => {
        const environment = step.env === undefined
          ? {}
          : asRecord(step.env, `${String(step.name)} environment`);
        return [String(step.name), Object.fromEntries(Object.entries({
          GH_TOKEN: environment.GH_TOKEN,
          GITHUB_TOKEN: environment.GITHUB_TOKEN,
        }).filter((entry) => entry[1] !== undefined))];
      }));
      expect(tokenEnvironments).toEqual({
        "Check out verified source with complete history": {},
        "Fetch only governed release history": {},
        "Install Bun": {},
        "Install Node and npm trusted-publishing client": {},
        "Install exact locked dependencies without lifecycle scripts": {},
        [jobName === "npm_mirror" ? "Require registry readiness and trusted publishing support" : "Require registry-only runtime dependencies"]: {},
        "Require exact artifact identity": {},
        "Download validated release bytes": {},
        "Revalidate remote authority and checksum": { GH_TOKEN: "${{ github.token }}" },
        ...(jobName === "publish" ? {
          "Create immutable GitHub Release from the same bytes": { GH_TOKEN: "${{ github.token }}" },
        } : jobName === "npm_preflight" ? {
          "Require tag-only npm environment before OIDC capability": { GH_TOKEN: "${{ github.token }}" },
          "Record exact npm registry preflight": {},
        } : {
          "Prove npm trusted-publisher exchange without publication": {},
          "Publish exact tarball through npm trusted publishing": { GITHUB_TOKEN: "${{ github.token }}" },
          "Admit exact public npm and GitHub state": { GITHUB_TOKEN: "${{ github.token }}" },
        }),
      });
    }
  });

  test("binds every artifact consumer to the verify attempt's numeric artifact identity", async () => {
    const workflow = asRecord(Bun.YAML.parse(await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    )), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const verify = asRecord(jobs.verify, "release verify job");
    const verifyOutputs = asRecord(verify.outputs, "release verify outputs");
    expect(verifyOutputs.artifact_id).toBe("${{ steps.release_artifact.outputs.artifact-id }}");
    expect(verifyOutputs.artifact_digest)
      .toBe("${{ steps.release_artifact.outputs.artifact-digest }}");
    if (!Array.isArray(verify.steps)) throw new TypeError("release verify steps must be an array");
    const verifySteps = verify.steps.map((step, index) => asRecord(step, `verify step ${index}`));
    const upload = verifySteps.find((step) => step.name === "Preserve exact release bytes");
    expect(upload?.id).toBe("release_artifact");
    expect(upload?.uses).toBe(reviewedActions.uploadArtifact);
    const uploadInputs = asRecord(upload?.with, "release artifact upload inputs");
    expect(uploadInputs.name).toBe("oompa-release-${{ github.run_attempt }}");
    expect(uploadInputs.path).toBe("${{ runner.temp }}/oompa-release-artifacts/");

    for (const jobName of ["exact_artifact", "publish", "npm_preflight", "npm_mirror"] as const) {
      const job = asRecord(jobs[jobName], `${jobName} job`);
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} steps must be an array`);
      const steps = job.steps.map((step, index) => asRecord(step, `${jobName} step ${index}`));
      const requireIdentityIndex = steps.findIndex((step) => step.name === "Require exact artifact identity");
      const downloadIndex = steps.findIndex((step) => step.uses === reviewedActions.downloadArtifact);
      expect(requireIdentityIndex).toBeGreaterThanOrEqual(0);
      expect(downloadIndex).toBeGreaterThan(requireIdentityIndex);
      const identity = steps[requireIdentityIndex];
      const environment = asRecord(identity?.env, `${jobName} artifact identity environment`);
      expect(environment).toEqual({
        VERIFIED_ARTIFACT_DIGEST: "${{ needs.verify.outputs.artifact_digest }}",
        VERIFIED_ARTIFACT_ID: "${{ needs.verify.outputs.artifact_id }}",
      });
      expect(identity?.run).toContain('[[ "$VERIFIED_ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]');
      expect(identity?.run).toContain('[[ "$VERIFIED_ARTIFACT_DIGEST" =~ ^[0-9a-f]{64}$ ]]');
      const download = steps[downloadIndex];
      const inputs = asRecord(download?.with, `${jobName} artifact download inputs`);
      expect(inputs).toEqual({
        "artifact-ids": "${{ needs.verify.outputs.artifact_id }}",
        "merge-multiple": true,
        path: "${{ runner.temp }}/oompa-release-artifacts",
      });
      expect(inputs.name).toBeUndefined();
    }
  });

  test("keeps generated and downloaded release artifacts outside the checked-out public tree", async () => {
    const workflowSource = await readFile(
      join(import.meta.dir, "..", ".github", "workflows", "release.yml"),
      "utf8",
    );
    const workflow = asRecord(Bun.YAML.parse(workflowSource), "release workflow");
    const jobs = asRecord(workflow.jobs, "release workflow jobs");
    const stepsFor = (jobName: string): readonly Record<string, unknown>[] => {
      const job = asRecord(jobs[jobName], `${jobName} job`);
      if (!Array.isArray(job.steps)) throw new TypeError(`${jobName} steps must be an array`);
      return job.steps.map((step, index) => asRecord(step, `${jobName} step ${index}`));
    };
    const stepFor = (jobName: string, stepName: string): Record<string, unknown> => {
      const matching = stepsFor(jobName).filter((step) => step.name === stepName);
      expect(matching).toHaveLength(1);
      return matching[0]!;
    };
    const runFor = (jobName: string, stepName: string): string => {
      const run = stepFor(jobName, stepName).run;
      if (typeof run !== "string") throw new TypeError(`${jobName} ${stepName} must have a run command`);
      return run;
    };
    const exactShellRoot = "$RUNNER_TEMP/oompa-release-artifacts";
    const exactActionRoot = "${{ runner.temp }}/oompa-release-artifacts";
    const assertOutsideCheckout = (command: string): void => {
      expect(command).not.toContain("$GITHUB_WORKSPACE");
      expect(command).not.toContain("${{ github.workspace }}");
      expect(command).not.toMatch(/(?:^|[\s"'=])artifacts(?:\/|[\s"']|$)/mu);
      expect(command).toContain(exactShellRoot);
    };

    const producer = runFor("verify", "Create one exact npm tarball and checksum");
    assertOutsideCheckout(producer);
    expect(producer).toContain(`release_artifacts="${exactShellRoot}"`);
    expect(producer).toContain('mkdir "$release_artifacts"');
    expect(producer).not.toContain('mkdir -p "$release_artifacts"');
    expect(producer).toContain('npm pack --ignore-scripts --pack-destination "$release_artifacts" .');
    expect(producer).toContain('"$release_artifacts/SHA256SUMS"');

    const preflight = runFor("npm_preflight", "Record exact npm registry preflight");
    assertOutsideCheckout(preflight);
    expect(preflight).toContain(`find "${exactShellRoot}"`);
    expect(asRecord(
      stepFor("verify", "Preserve exact release bytes").with,
      "release artifact upload inputs",
    ).path).toBe(`${exactActionRoot}/`);

    const exactCheck = runFor("exact_artifact", "Verify checksum and complete installed-package behavior");
    assertOutsideCheckout(exactCheck);
    expect(exactCheck).toContain(`find "${exactShellRoot}"`);
    expect(exactCheck).toContain(`"${exactShellRoot}/SHA256SUMS"`);
    expect(exactCheck).toContain('bun run ./scripts/check-package.ts "$artifact"');

    for (const [jobName, stepName] of [
      ["publish", "Revalidate remote authority and checksum"],
      ["publish", "Create immutable GitHub Release from the same bytes"],
      ["npm_preflight", "Revalidate remote authority and checksum"],
      ["npm_mirror", "Revalidate remote authority and checksum"],
      ["npm_mirror", "Publish exact tarball through npm trusted publishing"],
    ] as const) {
      const command = runFor(jobName, stepName);
      assertOutsideCheckout(command);
      expect(command).toContain(`find "${exactShellRoot}"`);
    }
    expect(runFor("publish", "Revalidate remote authority and checksum"))
      .toContain(`"${exactShellRoot}/SHA256SUMS"`);
    expect(runFor("publish", "Create immutable GitHub Release from the same bytes"))
      .toContain(`"${exactShellRoot}/SHA256SUMS"`);

    for (const [jobName, stepName] of [
      ["exact_artifact", "Download exact release bytes"],
      ["publish", "Download validated release bytes"],
      ["npm_preflight", "Download validated release bytes"],
      ["npm_mirror", "Download validated release bytes"],
    ] as const) {
      expect(asRecord(stepFor(jobName, stepName).with, `${jobName} artifact download inputs`).path)
        .toBe(exactActionRoot);
    }

    expect(workflowSource).not.toContain("$GITHUB_WORKSPACE/artifacts");
    expect(workflowSource).not.toContain("path: artifacts");
  });

  test("completes only one exact residual GitHub draft without substituting bytes", async () => {
    const [publisher, admission] = await Promise.all([
      readFile(join(import.meta.dir, "publish-github-release.ts"), "utf8"),
      readFile(join(import.meta.dir, "check-public-release.ts"), "utf8"),
    ]);
    expect(publisher.match(/verifyRemoteAnnotatedTag\(\);/gu)?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(publisher).toContain("parseGitHubIncludedJsonResponse(result.stdout)");
    expect(publisher).toContain('"-F", "draft=true"');
    expect(publisher).toContain("exactDraft");
    expect(publisher).toContain("matchingDraftIds");
    expect(publisher).toContain("verifyDraftAssets");
    expect(publisher).toContain("parseReleaseInventoryPage(projection, releaseTag)");
    expect(publisher).toContain("ten-page recovery bound");
    expect(publisher).toContain("Multiple residual drafts exist");
    expect(publisher).toContain("waitForCreatedDraftInventory(created.id)");
    expect(publisher).toContain("waitForPublishedDraftInventory(publishedReleaseId)");
    expect(publisher).toContain("waitForLaterAttemptProviderState()");
    expect(publisher).toContain("priorAttemptProvesNoDraftCreation(jobs");
    expect(publisher).toContain("process.env.GITHUB_SHA !== releaseIdentity.commitSha");
    expect(publisher.match(/currentAttemptCanCreateDraft\(\)/gu)?.length ?? 0)
      .toBeGreaterThanOrEqual(3);
    expect(publisher).toContain("GitHub Release provider state changed before draft creation");
    const providerSnapshotIndex = publisher.indexOf("let initialDraftIds = matchingDraftIds()");
    const priorMutationIndex = publisher.indexOf("const priorMayHaveCreated = releaseRun.attempt > 1");
    const laterConvergenceIndex = publisher.indexOf("if (priorMayHaveCreated)", priorMutationIndex);
    const directDraftIndex = publisher.indexOf('else if (lookup.state === "draft")', laterConvergenceIndex);
    expect(providerSnapshotIndex).toBeGreaterThan(-1);
    expect(priorMutationIndex).toBeGreaterThan(providerSnapshotIndex);
    expect(laterConvergenceIndex).toBeGreaterThan(priorMutationIndex);
    expect(directDraftIndex).toBeGreaterThan(laterConvergenceIndex);
    expect(publisher.slice(laterConvergenceIndex, directDraftIndex))
      .toContain("await waitForLaterAttemptProviderState()");
    const convergenceStart = publisher.indexOf("async function waitForLaterAttemptProviderState");
    const convergenceEnd = publisher.indexOf("function completeDraftAssets", convergenceStart);
    const convergence = publisher.slice(convergenceStart, convergenceEnd);
    expect(convergence).toContain("for (;;)");
    expect(convergence.indexOf("readReleaseTagLookup()"))
      .toBeLessThan(convergence.indexOf("matchingDraftIds()"));
    expect(convergence).toContain("classifyCreatedDraftInventory(draftIds, draft.id)");
    expect(convergence).toContain("classifyPublishedDraftInventory(draftIds, id)");
    const createStart = publisher.indexOf("async function createDraft");
    const createEnd = publisher.indexOf("async function verifyPublishedRelease", createStart);
    const create = publisher.slice(createStart, createEnd);
    expect(create.indexOf("currentAttemptCanCreateDraft()"))
      .toBeLessThan(create.indexOf("readReleaseTagLookup()"));
    expect(create.indexOf("readReleaseTagLookup()"))
      .toBeLessThan(create.indexOf('"gh", "api", "--method", "POST"'));
    expect(publisher).toContain("assertNoResidualDraft();");
    expect(publisher).toContain("remains after immutable publication");
    expect(publisher).toContain("contains ambiguous assets");
    expect(publisher).toContain("has different immutable metadata");
    expect(publisher).toContain("has different bytes");
    expect(publisher).toContain('"--header", "Content-Type: application/octet-stream"');
    expect(publisher).toContain('"--input", source');
    expect(publisher).toContain("https://uploads.github.com/repos/${publicRepository}/releases/${String(draft.id)}/assets?name=${encodeURIComponent(name)}");
    expect(publisher).toContain("readExactDraftById(draft.id)");
    expect(publisher).not.toContain('"gh", "release", "upload"');
    expect(publisher).toContain('"-F", "draft=false", "-F", "prerelease=false", "-f", "make_latest=true"');
    expect(publisher).toContain("parseGitHubRelease(published, inspection.version)");
    expect(publisher).toContain("const publishedBody = publishedReleaseBody(releaseIdentity, draft.createdAttempt)");
    expect(publisher).toContain("published.body !== publishedBody");
    expect(publisher).toContain("releaseId(release(), `Tag-resolved GitHub Release ${tag}`) !== expectedId");
    expect(publisher).toContain("releaseId(latest, \"Latest GitHub Release\") !== publishedReleaseId");
    expect(publisher.indexOf("assertNoResidualDraft();"))
      .toBeGreaterThan(publisher.indexOf("await verifyPublishedRelease(publishedReleaseId);"));
    expect(publisher).toContain("env: githubPublisherEnvironment(process.env)");
    expect(publisher).not.toContain("...process.env");
    expect(publisher).not.toContain("--target");
    expect(publisher).not.toContain("target_commitish");
    expect(publisher).not.toContain("--generate-notes");
    expect(publisher).toContain("const verifiedTagObject = process.env.VERIFIED_TAG_OBJECT");
    expect(publisher).toContain("tagObject.sha !== verifiedTagObject");
    expect(publisher).toContain("/git/tags/${verifiedTagObject}");
    expect(publisher).toContain("/compare/${releaseCommitSha}...${headSha}");
    expect(publisher).toContain("assertReviewedReleaseCommitOnStableBranch(comparison, finalHead");
    expect(publisher).not.toContain("comparison.head_commit");
    const branchRead = "/git/ref/heads/${releaseDefaultBranch}";
    const firstBranchReadIndex = publisher.indexOf(branchRead);
    const compareIndex = publisher.indexOf("/compare/${releaseCommitSha}...${headSha}");
    const finalBranchReadIndex = publisher.lastIndexOf(branchRead);
    expect(publisher.match(/\/git\/ref\/heads\/\$\{releaseDefaultBranch\}/gu)?.length).toBe(2);
    expect(firstBranchReadIndex).toBeGreaterThanOrEqual(0);
    expect(compareIndex).toBeGreaterThan(firstBranchReadIndex);
    expect(finalBranchReadIndex).toBeGreaterThan(compareIndex);
    expect(admission).toContain('environment("VERIFIED_TAG_OBJECT", /^[0-9a-f]{40}$/u)');
    expect(admission).toContain("tagRef.object.sha !== verifiedTagObject");
    expect(admission).toContain("`${api}/git/tags/${verifiedTagObject}`");
  });

  test("publishes and proves GitHub identity before consuming the npm version", async () => {
    const workflow = await readFile(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8");
    const oidcPreflightIndex = workflow.indexOf("Prove npm trusted-publisher exchange without publication");
    const githubIndex = workflow.indexOf("Create immutable GitHub Release from the same bytes");
    const npmIndex = workflow.indexOf("Publish exact tarball through npm trusted publishing");
    const admissionIndex = workflow.indexOf("Admit exact public npm and GitHub state");
    expect(oidcPreflightIndex).toBeGreaterThan(0);
    expect(oidcPreflightIndex).toBeGreaterThan(githubIndex);
    expect(npmIndex).toBeGreaterThan(oidcPreflightIndex);
    expect(admissionIndex).toBeGreaterThan(npmIndex);
    expect(workflow).toContain("if: needs.npm_preflight.outputs.npm_preflight_state == 'absent'");
    expect(workflow).toContain("check-npm-trusted-publisher-oidc.ts");
  });
});
