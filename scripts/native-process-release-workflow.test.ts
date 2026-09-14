import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { nativeProcessDependency } from "./native-process-dependency.ts";
import { NATIVE_TRANSPORT_CASES } from "./native-process-qualification-model.ts";
import { nativeProcessReleaseRun } from "./native-process-release-policy.ts";
import { nativeWorkflowArtifactEnvironment } from "./native-process-workflow-artifacts.ts";
import { priorNativeAttemptProvesNoReleaseCreation } from "./native-process-release-retry.ts";

const root = realpathSync(join(import.meta.dir, ".."));
const workflowText = readFileSync(join(root, ".github/workflows/native-process-release.yml"), "utf8");
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("Expected workflow object");
  return value as Record<string, unknown>;
}
const workflow = record(Bun.YAML.parse(workflowText)), jobs = record(workflow.jobs);
const installedWorkflow = record(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/native-process-installed-target.yml"), "utf8")));
const installedJob = record(record(installedWorkflow.jobs).installed);
if (!Array.isArray(installedJob.steps)) throw Error("Expected installed workflow steps");
const installedSteps = installedJob.steps.map(record);
function installedStep(id: string): Record<string, unknown> {
  const found = installedSteps.find(value => value.id === id || value.name === id);
  if (found === undefined) throw Error("Missing installed workflow step");
  return found;
}
function installedScript(id: string): string {
  const value = installedStep(id).run;
  if (typeof value !== "string") throw Error("Missing installed script");
  return value;
}
function inline(source: string): string {
  const body = source.match(/<<'BUN'\n([\s\S]*)\nBUN\n?$/u)?.[1];
  if (body === undefined) throw Error("Missing fixed inline Bun code");
  return body;
}
function steps(name: string): Record<string, unknown>[] {
  const value = record(jobs[name]).steps;
  if (!Array.isArray(value)) throw Error("Expected workflow steps");
  return value.map(record);
}
function step(job: string, name: string): Record<string, unknown> {
  const found = steps(job).find(value => value.id === name || value.name === name);
  if (found === undefined) throw Error("Missing workflow step");
  return found;
}
function script(job: string, name: string): string {
  const value = step(job, name).run;
  if (typeof value !== "string") throw Error("Missing workflow script");
  return value;
}
const targets = [
  { id: "darwin_arm64", target: "darwin-arm64", os: "macos-15", rust: "aarch64-apple-darwin" },
  { id: "darwin_x64", target: "darwin-x64", os: "macos-15-intel", rust: "x86_64-apple-darwin" },
  { id: "linux_arm64", target: "linux-arm64", os: "ubuntu-24.04-arm", rust: "aarch64-unknown-linux-musl" },
  { id: "linux_x64", target: "linux-x64", os: "ubuntu-24.04", rust: "x86_64-unknown-linux-musl" },
] as const;
const sourceSha = "a".repeat(40);

test("native release source authority is distinct from the unchanged CLI release trigger", () => {
  expect(workflow.on).toEqual({ push: { tags: ["native-process-v*"] } });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.concurrency).toEqual({ group: "native-process-release", "cancel-in-progress": false });
  const cli = record(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8")));
  expect(cli.on).toEqual({ push: { tags: ["v*"] } });
  const source = record(jobs.source);
  expect(source["runs-on"]).toBe("ubuntu-24.04"); expect(source["timeout-minutes"]).toBe(10);
  expect(source.permissions).toEqual({ actions: "read", contents: "read" });
  expect(source.outputs).toEqual({ sha: "${{ steps.identity.outputs.sha }}", "tag-object": "${{ steps.identity.outputs.tag-object }}" });
  expect(steps("source")[0]?.name).toBe("Require the public repository and owner tag push");
  const checkout = steps("source").find(value => typeof value.uses === "string" && value.uses.startsWith("actions/checkout@"));
  expect(checkout?.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  expect(checkout?.with).toEqual({ ref: "refs/tags/native-process-v0.1.0", "fetch-depth": 1,
    "fetch-tags": false, "persist-credentials": false });
  expect(script("source", "Require the public repository and owner tag push")).toContain('"$WORKFLOW_SHA" != "$SOURCE_SHA"');
});

test("source admission preserves exact governed history, tag identity, ancestry and complete CI", () => {
  const history = script("source", "Fetch only governed package release history");
  expect(history).toContain("git fetch --force --no-tags --unshallow origin");
  expect(history).toContain("'+refs/heads/main:refs/remotes/origin/main'");
  expect(history).toContain("'+refs/tags/native-process-v0.1.0:refs/tags/native-process-v0.1.0'");
  expect(history).toContain("refs/remotes/origin/main|refs/tags/native-process-v0.1.0)");
  expect(history).toContain("NATIVE_RELEASE_REF_INVALID");
  expect(history).toContain('"$(git for-each-ref --format=\'%(refname)\' | wc -l | tr -d \' \')" != "2"');
  expect(history).not.toMatch(/--all|--tags|refs\/heads\/\*|refs\/tags\/\*/u);
  const identity = script("source", "identity");
  expect(record(step("source", "identity").env).EVENT_TAG_OBJECT).toBe("${{ github.event.after }}");
  expect(identity).toContain("NATIVE_RELEASE_EVENT_TAG_CHANGED");
  for (const required of ["git cat-file -t refs/tags/native-process-v0.1.0", "refs/tags/native-process-v0.1.0^{commit}",
    "refs/tags/native-process-v0.1.0^{tag}", 'git merge-base --is-ancestor "$SOURCE_SHA" refs/remotes/origin/main', "@hraness/native-process", "0.1.0"]) {
    expect(identity).toContain(required);
  }
  const ci = step("source", "Require complete successful CI on the tagged main commit");
  expect(ci.run).toBe("bun scripts/check-commit-ci-run.ts");
  expect(ci.env).toEqual({ DEFAULT_BRANCH: "main", GITHUB_TOKEN: "${{ github.token }}", VERIFIED_SHA: "${{ steps.identity.outputs.sha }}" });
  expect(record(jobs.assemble).needs).toEqual(["source", ...targets.map(value => value.id)]);
  // This new graph supplements the old Required union, never substitutes a
  // native-only result for source shards or compiled browser acceptance.
  const oldCi = record(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8"))), oldJobs = record(oldCi.jobs);
  expect(record(record(record(oldJobs.check).strategy).matrix)).toEqual({ os: ["macos-15", "ubuntu-24.04"],
    gate: ["source-1", "source-2", "source-3", "source-4", "source-5", "source-6", "remainder"] });
  expect(record(oldJobs.required).needs).toEqual(["check", "browser"]);
});

test("exactly four real target qualifications precede one assembly without cross-building", () => {
  const qualified = Object.entries(jobs).filter(([, value]) => record(value).uses === "./.github/workflows/native-process-target.yml");
  expect(qualified.map(([id]) => id).sort()).toEqual(targets.map(value => value.id).sort());
  for (const target of targets) {
    const job = record(jobs[target.id]);
    expect(job).toEqual({ needs: "source", uses: "./.github/workflows/native-process-target.yml", with: {
      "source-sha": "${{ needs.source.outputs.sha }}", os: target.os, target: target.target,
    } });
  }
  const assembly = record(jobs.assemble);
  expect(assembly["runs-on"]).toBe("ubuntu-24.04"); expect(assembly["timeout-minutes"]).toBe(15);
  expect(assembly.strategy).toBeUndefined(); expect(assembly.if).toBeUndefined();
  const build = script("assemble", "assembly");
  expect(build.match(/await buildQualifiedNativeProcessPackage\(/gu)).toHaveLength(1);
  expect(build).toContain('join(process.env.RUNNER_TEMP, "native-process-archive")');
  expect(build).toContain("nativeInputHash(bytes) !== process.env[variable]");
  expect(build).toContain("parseNativeQualification(JSON.parse(bytes)).target !== target");
  expect(build).toContain("archive-sha256=${result.archiveSha256}");
  expect(build).toContain("manifest-sha256=${result.manifestSha256}");
  for (const value of steps("assemble")) {
    if (typeof value.run === "string") expect(value.run).not.toMatch(/cargo\s|native-process-qualify\.ts|rustup\s/u);
  }
});

test("the actual source event guard refuses foreign authority and nonexact source values", () => {
  const baseline = { GITHUB_REPOSITORY: "hraness/oompa", REPOSITORY_ID: "1343008607", OWNER_ID: "307125679",
    REPOSITORY_PRIVATE: "false", REPOSITORY_VISIBILITY: "public", EVENT_NAME: "push", EVENT_REF: "refs/tags/native-process-v0.1.0",
    ACTOR_ID: "894119", SENDER_ID: "894119", SENDER_TYPE: "User", SOURCE_SHA: sourceSha, WORKFLOW_SHA: sourceSha };
  const cases: Record<string, string>[] = [{}, { GITHUB_REPOSITORY: "foreign/oompa" }, { REPOSITORY_ID: "1" }, { OWNER_ID: "1" },
    { REPOSITORY_PRIVATE: "true" }, { REPOSITORY_VISIBILITY: "private" }, { EVENT_NAME: "workflow_dispatch" },
    { EVENT_REF: "refs/tags/v0.1.0" }, { ACTOR_ID: "1" }, { SENDER_ID: "1" }, { SENDER_TYPE: "Bot" },
    { SOURCE_SHA: "main", WORKFLOW_SHA: "main" }, { SOURCE_SHA: "A".repeat(40), WORKFLOW_SHA: "A".repeat(40) },
    { SOURCE_SHA: sourceSha + "\n", WORKFLOW_SHA: sourceSha + "\n" }, { WORKFLOW_SHA: "b".repeat(40) }];
  for (const mutation of cases) {
    const result = spawnSync("/bin/bash", ["-c", script("source", "Require the public repository and owner tag push")], {
      env: { PATH: "/usr/bin:/bin", ...baseline, ...mutation }, encoding: "utf8", timeout: 5000, maxBuffer: 4096,
    });
    const valid = Object.keys(mutation).length === 0;
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    expect(result.status, JSON.stringify(mutation)).toBe(valid ? 0 : 1);
    if (valid) expect(result.stdout).toBe(""); else expect(result.stdout).toMatch(/^::error::NATIVE_RELEASE_[A-Z_]+\n$/u);
  }
});

function qualification(target: typeof targets[number]) {
  const image = { bytes: 64, sha256: "1".repeat(64) }, mac = target.target.startsWith("darwin-");
  return { formatVersion: 1, phase: "prepack-native", profile: "native-process-v1-posix-custody", profileVersion: 1,
    source: { commitSha: sourceSha, treeSha256: "b".repeat(64), bunLockSha256: "c".repeat(64), cargoLockSha256: "d".repeat(64),
      toolchainSha256: "e".repeat(64), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" },
    target: target.target, rustTarget: target.rust, artifact: image, licensesSha256: "2".repeat(64),
    harnesses: { unit: image, native: image, fixture: image }, compiler: {
      rustcVerboseVersion: "rustc 1.97.1 (synthetic)", cargoVersion: "cargo 1.97.1 (synthetic)", bunVersion: "1.3.14",
      deploymentTarget: mac ? "11.0" : "static-musl", environmentPolicy: "native-process-build-env-v1",
      linker: { sha256: "3".repeat(64), version: "synthetic linker" },
      sdk: mac ? { kind: "macos", version: "fixture", buildVersion: "fixture" } : { kind: "static-musl", target: target.rust },
      host: { architecture: target.target.endsWith("arm64") ? "arm64" : "x64", osRelease: "fixture" },
    }, checks: { clippy: "passed", unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 },
      transport: [...NATIVE_TRANSPORT_CASES] } };
}

test.each(["valid", "missing-pin", "wrong-pin", "changed-bytes", "wrong-target", "incomplete"] as const)(
  "the actual inline bundle admission calls its assembler only after all four records match: %s", scenario => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "native-process-release-inline-")));
    try {
      const output = join(fixture, "output"), calls = join(fixture, "assembler-calls");
      writeFileSync(output, "");
      const environment: Record<string, string> = { PATH: "/usr/bin:/bin", NODE_ENV: "production", RUNNER_TEMP: fixture,
        GITHUB_OUTPUT: output, SOURCE_SHA: sourceSha };
      for (const [index, target] of targets.entries()) {
        const directory = join(fixture, "native-process-bundles", target.target); mkdirSync(directory, { recursive: true });
        const value = qualification(scenario === "wrong-target" && index === 3 ? targets[0] : target);
        if (scenario === "incomplete" && index === 3) value.checks.native.passed = 19;
        const bytes = JSON.stringify(value) + "\n";
        writeFileSync(join(directory, "qualification.json"), bytes + (scenario === "changed-bytes" && index === 3 ? " " : ""));
        environment[target.id.toUpperCase()] = nativeInputHash(Buffer.from(bytes));
      }
      if (scenario === "missing-pin") delete environment.LINUX_X64;
      if (scenario === "wrong-pin") environment.LINUX_X64 = "0".repeat(64);
      // Preload replaces only the assembler. The unmodified inline admission
      // still reads and parses real synthetic receipts. These receipts cannot
      // match the checkout source inventory if the mock ever fails to install.
      const preload = join(fixture, "preload.ts");
      writeFileSync(preload, `import { mock } from "bun:test";
import { appendFileSync } from "node:fs";
mock.module(${JSON.stringify(join(root, "scripts/native-process-package.ts"))}, () => ({
  buildQualifiedNativeProcessPackage: async (output, directories) => {
    appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ output, directories }) + "\\n");
    return { archivePath: output + "/synthetic.tgz", archiveSha256: "4".repeat(64), manifestSha256: "5".repeat(64) };
  },
}));\n`);
      const source = script("assemble", "assembly").match(/<<'BUN'\n([\s\S]*)\nBUN\n?$/u)?.[1];
      if (source === undefined) throw Error("Missing fixed inline assembly code");
      const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", "--preload", preload, "-"], {
        cwd: root, env: environment, input: source, encoding: "utf8", timeout: 10000, maxBuffer: 16384,
      });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(scenario === "valid" ? 0 : 1);
      if (scenario === "valid") {
        expect(JSON.parse(readFileSync(calls, "utf8")) as unknown).toEqual({ output: join(fixture, "native-process-archive"),
          directories: targets.map(target => join(fixture, "native-process-bundles", target.target)) });
        expect(readFileSync(output, "utf8")).toBe(`archive-sha256=${"4".repeat(64)}\nmanifest-sha256=${"5".repeat(64)}\n`);
      } else { expect(existsSync(calls)).toBe(false); expect(readFileSync(output, "utf8")).toBe(""); }
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  },
);

test("four explicit installed jobs preserve individual receipt identities and all canonical pins", () => {
  expect(jobs.installed).toBeUndefined();
  const installed = Object.entries(jobs).filter(([, value]) => record(value).uses === "./.github/workflows/native-process-installed-target.yml");
  expect(installed).toHaveLength(4);
  for (const target of targets) {
    const selected = installed.find(([, value]) => record(record(value).with).target === target.target);
    expect(selected).toBeDefined();
    if (selected === undefined) throw Error("Missing installed target");
    const job = record(selected[1]);
    expect(job.permissions).toEqual({ actions: "read", contents: "read" });
    expect(job.with).toEqual({ "source-sha": "${{ needs.source.outputs.sha }}", os: target.os, target: target.target,
      "archive-id": "${{ needs.assemble.outputs.artifact-id }}", "archive-digest": "${{ needs.assemble.outputs.artifact-digest }}",
      "archive-sha256": "${{ needs.assemble.outputs.archive-sha256 }}", "manifest-sha256": "${{ needs.assemble.outputs.manifest-sha256 }}",
      "bundle-id": `\${{ needs.${target.id}.outputs.artifact-id }}`, "bundle-digest": `\${{ needs.${target.id}.outputs.artifact-digest }}` });
    expect(Array.isArray(job.needs) ? [...job.needs].sort() : job.needs).toEqual(["source", target.id, "assemble"].sort());
    expect(job.if).toBeUndefined(); expect(job.strategy).toBeUndefined();
  }
});

test("installed reusable admission scopes the token and runs one exact native gate without rebuilding", () => {
  const call = record(record(installedWorkflow.on).workflow_call);
  expect(Object.keys(record(call.inputs))).toEqual(["source-sha", "os", "target", "archive-id", "archive-digest",
    "archive-sha256", "manifest-sha256", "bundle-id", "bundle-digest"]);
  for (const value of Object.values(record(call.inputs))) expect(value).toEqual({ required: true, type: "string" });
  expect(installedWorkflow.permissions).toEqual({ actions: "read", contents: "read" });
  expect(installedJob["runs-on"]).toBe("${{ inputs.os == 'macos-15' && 'macos-15' || inputs.os == 'macos-15-intel' && 'macos-15-intel' || inputs.os == 'ubuntu-24.04-arm' && 'ubuntu-24.04-arm' || 'ubuntu-24.04' }}");
  expect(installedJob["timeout-minutes"]).toBe(30); expect(installedJob.defaults).toEqual({ run: { shell: "bash" } });
  expect(installedSteps[0]?.id).toBe("admission");
  expect(installedSteps.filter(value => record(value.env ?? {}).GITHUB_TOKEN !== undefined).map(value => value.id)).toEqual(["server"]);
  expect(record(installedStep("server").env).GITHUB_TOKEN).toBe("${{ github.token }}");
  const downloads = installedSteps.filter(value => typeof value.uses === "string" && value.uses.startsWith("actions/download-artifact@"));
  expect(downloads.map(value => value.with)).toEqual([
    { "artifact-ids": "${{ inputs.archive-id }}", "merge-multiple": true, path: "${{ steps.paths.outputs.archive }}" },
    { "artifact-ids": "${{ inputs.bundle-id }}", "merge-multiple": true, path: "${{ steps.paths.outputs.bundle }}" },
  ]);
  for (const download of downloads) expect(installedSteps.indexOf(installedStep("server"))).toBeLessThan(installedSteps.indexOf(download));
  expect(installedScript("server")).toContain('redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000)');
  expect(installedScript("server")).toContain('readBoundedJsonResponse(response, "native artifact identity", 128 * 1024)');
  expect(installedScript("Repeat qualification against the exact installed archive")).toContain('scripts/native-process-installed.ts');
  expect(installedScript("Repeat qualification against the exact installed archive")).toContain('"$ARCHIVE/hraness-native-process-0.1.0.tgz" "$ARCHIVE_SHA256" "$MANIFEST_SHA256"');
  expect(installedScript("Repeat qualification against the exact installed archive")).toContain('"$BUNDLE" "$WORK/dependency/zod-4.4.3.tgz" "$INSTALLED"');
  expect(installedScript("Repeat qualification against the exact installed archive")).toContain('> "$WORK/installed.log" 2>&1');
  expect(installedStep("upload").with).toEqual({
    name: "native-process-installed-${{ inputs.target }}-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "${{ steps.paths.outputs.installed }}/installed-qualification.json", "if-no-files-found": "error",
    "retention-days": 7, "compression-level": 0, "include-hidden-files": false, overwrite: false,
  });
  expect(installedJob.outputs).toEqual({ "artifact-id": "${{ steps.outputs.outputs.artifact-id }}",
    "artifact-digest": "${{ steps.outputs.outputs.artifact-digest }}", "receipt-sha256": "${{ steps.receipt.outputs.receipt-sha256 }}" });
  for (const value of installedSteps) {
    expect(value.if).toBeUndefined(); expect(value["continue-on-error"]).toBeUndefined();
    if (typeof value.run === "string") {
      expect(value.run).not.toMatch(/cargo\s|rustup\s|native-process-qualify\.ts|rm -r|npm publish|gh release|\$\{\{/u);
      const result = spawnSync("/bin/bash", ["-n"], { input: value.run, timeout: 5000, encoding: "utf8", maxBuffer: 4096 });
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    }
  }
});

test("installed precheckout guard refuses missing IDs, foreign runners, malformed hashes and duplicate artifacts", () => {
  const baseline = { SOURCE_SHA: sourceSha, TARGET: "darwin-arm64", RUNNER_LABEL: "macos-15", HOST_OS: "macOS", HOST_ARCH: "ARM64",
    ARCHIVE_ID: "101", BUNDLE_ID: "102", RUN_ID: "103", ARCHIVE_DIGEST: "1".repeat(64), BUNDLE_DIGEST: "2".repeat(64),
    ARCHIVE_SHA256: "3".repeat(64), MANIFEST_SHA256: "4".repeat(64) };
  const mutations: Record<string, string>[] = [{}, { ARCHIVE_ID: "" }, { ARCHIVE_ID: "01" }, { ARCHIVE_ID: "101\n" },
    { BUNDLE_ID: "101" }, { RUN_ID: "0" }, { RUNNER_LABEL: "self-hosted" }, { HOST_ARCH: "X64" },
    { SOURCE_SHA: sourceSha + "\n" }, { ARCHIVE_DIGEST: "1".repeat(64) + "\n" }, { BUNDLE_DIGEST: "2".repeat(63) },
    { ARCHIVE_SHA256: "" }, { MANIFEST_SHA256: "A".repeat(64) }];
  for (const mutation of mutations) {
    const result = spawnSync("/bin/bash", ["-c", installedScript("admission")], { env: { PATH: "/usr/bin:/bin", ...baseline, ...mutation },
      encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
    expect(result.status, JSON.stringify(mutation)).toBe(Object.keys(mutation).length === 0 ? 0 : 1);
  }
});

test("download admission and artifact outputs refuse malformed identities before any ambiguous handoff", () => {
  const guard = step("assemble", "Require four exact workflow artifact identities before download");
  for (const download of steps("assemble").filter(value => typeof value.uses === "string" && value.uses.startsWith("actions/download-artifact@"))) {
    expect(steps("assemble").indexOf(guard)).toBeLessThan(steps("assemble").indexOf(download));
  }
  expect(record(record(jobs.assemble).outputs)["artifact-id"]).toBe("${{ steps.archive_identity.outputs.artifact-id }}");
  expect(record(record(jobs.assemble).outputs)["artifact-digest"]).toBe("${{ steps.archive_identity.outputs.artifact-digest }}");
  const fourInputs = Object.fromEntries(targets.flatMap((target, index) => [
    [target.id.toUpperCase() + "_ID", String(101 + index)], [target.id.toUpperCase() + "_DIGEST", "1".repeat(64)],
  ]));
  const specifications = [
    { body: script("assemble", "Require four exact workflow artifact identities before download"), environment: fourInputs,
      id: "LINUX_X64_ID", digest: "LINUX_X64_DIGEST", output: "" },
    { body: script("assemble", "archive_identity"), environment: { ARTIFACT_ID: "101", ARTIFACT_DIGEST: "1".repeat(64) },
      id: "ARTIFACT_ID", digest: "ARTIFACT_DIGEST", output: `artifact-id=101\nartifact-digest=${"1".repeat(64)}\n` },
    { body: installedScript("outputs"), environment: { ARTIFACT_ID: "101", ARTIFACT_DIGEST: "1".repeat(64) },
      id: "ARTIFACT_ID", digest: "ARTIFACT_DIGEST", output: `artifact-id=101\nartifact-digest=${"1".repeat(64)}\n` },
    { body: script("attest", "identity"), environment: { ARTIFACT_ID: "101", ARTIFACT_DIGEST: "1".repeat(64) },
      id: "ARTIFACT_ID", digest: "ARTIFACT_DIGEST", output: `artifact-id=101\nartifact-digest=${"1".repeat(64)}\n` },
  ];
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "native-process-release-artifact-guards-"))), output = join(fixture, "output");
  try {
    for (const specification of specifications) {
      const mutations: Record<string, string>[] = [{}, ...["", "01", "101\n", "foreign", "1".repeat(21)].map(value => ({ [specification.id]: value })),
        ...["", "1".repeat(64) + "\n", "A".repeat(64)].map(value => ({ [specification.digest]: value }))];
      for (const mutation of mutations) {
        writeFileSync(output, "");
        const result = spawnSync("/bin/bash", ["-c", specification.body], { env: { PATH: "/usr/bin:/bin", GITHUB_OUTPUT: output,
          ...specification.environment, ...mutation }, encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
        expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
        const valid = Object.keys(mutation).length === 0;
        expect(result.status, JSON.stringify(mutation)).toBe(valid ? 0 : 1);
        expect(readFileSync(output, "utf8")).toBe(valid ? specification.output : "");
      }
    }
  } finally { rmSync(fixture, { recursive: true, force: true }); }
});

test.each(["valid", "id", "digest", "expired", "run", "source", "repository", "missing-workflow", "http", "oversized"] as const)(
  "read-only server identity readback refuses mismatched artifact evidence: %s", scenario => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "native-process-server-fixture-")));
    try {
      const preload = join(fixture, "preload.ts"), calls = join(fixture, "calls");
      writeFileSync(preload, `import { appendFileSync } from "node:fs";
const scenario = ${JSON.stringify(scenario)};
const fakeFetch = async (url, options) => {
  if (!/^https:\\/\\/api.github.com\\/repos\\/hraness\\/oompa\\/actions\\/artifacts\\/(?:101|102)$/.test(url)
    || options.redirect !== "error" || options.headers.Authorization !== "Bearer synthetic-fixture-token") throw Error("fixture request invalid");
  appendFileSync(${JSON.stringify(calls)}, url + "\\n");
  const id = url.endsWith("/101") ? 101 : 102;
  const value = { id, expired: false, digest: "sha256:" + (id === 101 ? "1" : "2").repeat(64),
    workflow_run: { id: 103, repository_id: 1343008607, head_repository_id: 1343008607, head_sha: "a".repeat(40) } };
  if (scenario === "id") value.id = 104;
  if (scenario === "digest") value.digest = "sha256:" + "0".repeat(64);
  if (scenario === "expired") value.expired = true;
  if (scenario === "run") value.workflow_run.id = 104;
  if (scenario === "source") value.workflow_run.head_sha = "b".repeat(40);
  if (scenario === "repository") value.workflow_run.head_repository_id = 1;
  if (scenario === "missing-workflow") delete value.workflow_run;
  return new Response(scenario === "oversized" ? "x".repeat(128 * 1024 + 1) : JSON.stringify(value), { status: scenario === "http" ? 404 : 200 });
};
globalThis.__nativeArtifactFetchFixture = fakeFetch;
globalThis.fetch = fakeFetch;
`);
      // Fail closed before the actual inline body if preload was not applied;
      // this fixture can never fall through to a real network request.
      const source = 'if (typeof globalThis.__nativeArtifactFetchFixture !== "function" || globalThis.fetch !== globalThis.__nativeArtifactFetchFixture) throw Error("missing fixture transport");\n'
        + inline(installedScript("server"));
      const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", "--preload", preload, "-"], { cwd: root, input: source,
        env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", GITHUB_TOKEN: "synthetic-fixture-token", SOURCE_SHA: sourceSha,
          RUN_ID: "103", ARCHIVE_ID: "101", ARCHIVE_DIGEST: "1".repeat(64), BUNDLE_ID: "102", BUNDLE_DIGEST: "2".repeat(64) },
        encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status, result.stderr).toBe(scenario === "valid" ? 0 : 1);
      expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(scenario === "valid" ? 2 : 1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(scenario === "valid" ? "" : "::error::NATIVE_INSTALLED_SERVER_ARTIFACT_INVALID\n");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  },
);

test("attestation joins every installed target before the separately privileged publisher", () => {
  const attest = record(jobs.attest), publish = record(jobs.publish);
  expect(workflow.name).toBe("Native process release");
  expect(attest.needs).toEqual(["source", "assemble", ...targets.map(target => `installed_${target.id}`)]);
  expect(publish.needs).toEqual(["source", "assemble", "attest"]);
  expect(attest.permissions).toEqual({ actions: "read", contents: "read", "id-token": "write", attestations: "write" });
  expect(publish.permissions).toEqual({ actions: "read", contents: "write" });
  expect(publish.name).toBe("Publish immutable native package");
  for (const [name, job, timeout] of [["attest", attest, 15], ["publish", publish, 20]] as const) {
    expect(job["runs-on"]).toBe("ubuntu-24.04"); expect(job["timeout-minutes"]).toBe(timeout);
    expect(job.if).toBeUndefined(); expect(job.strategy).toBeUndefined(); expect(job["continue-on-error"]).toBeUndefined();
    expect(record(job.env).GITHUB_TOKEN).toBeUndefined();
    const checkout = steps(name).find(value => typeof value.uses === "string" && value.uses.startsWith("actions/checkout@"));
    expect(checkout?.uses).toBe("actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
    expect(checkout?.with).toEqual({ ref: "${{ needs.source.outputs.sha }}", "fetch-depth": 1, "fetch-tags": false, "persist-credentials": false });
    expect(script(name, "Install frozen independent dependency files")).toBe("bun install --frozen-lockfile --ignore-scripts --backend=copyfile");
    for (const current of steps(name)) {
      expect(current.if).toBeUndefined(); expect(current["continue-on-error"]).toBeUndefined();
      if (typeof current.uses === "string") expect(current.uses).toMatch(/^[A-Za-z0-9_/-]+@[a-f0-9]{40}$/u);
      if (typeof current.run === "string") {
        expect(current.run).not.toMatch(/cargo\s|rustup\s|npm publish|gh release|git push|\$\{\{/u);
        const result = spawnSync("/bin/bash", ["-n"], { input: current.run, timeout: 5000, encoding: "utf8", maxBuffer: 4096 });
        expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      }
    }
  }
  const node = steps("publish").find(value => typeof value.uses === "string" && value.uses.startsWith("actions/setup-node@"));
  expect(node?.uses).toBe("actions/setup-node@820762786026740c76f36085b0efc47a31fe5020");
  expect(node?.with).toEqual({ "node-version": "24.20.0" });
  const publisher = step("publish", "Publish and verify immutable native package");
  expect(script("publish", "Publish and verify immutable native package")).toContain("bun --no-env-file --no-install scripts/native-process-publish.ts");
  expect(publisher.env).toEqual({ GITHUB_TOKEN: "${{ github.token }}", WORK: "${{ steps.paths.outputs.work }}" });
  const ci = step("publish", "Require complete successful source CI before publication");
  expect(ci.run).toBe("bun scripts/check-commit-ci-run.ts");
  expect(ci.env).toEqual({ DEFAULT_BRANCH: "main", GITHUB_TOKEN: "${{ github.token }}", VERIFIED_SHA: "${{ needs.source.outputs.sha }}" });
  expect(steps("publish").indexOf(ci)).toBeLessThan(steps("publish").indexOf(publisher));
});

test("every attest and publish download is preceded by complete numeric artifact admission", () => {
  for (const [job, guardName, expectedInputs] of [
    ["attest", "Admit exact archive and four installed artifact identities", ["assemble", ...targets.map(target => `installed_${target.id}`)]],
    ["publish", "Admit exact archive and producing provenance artifacts", ["assemble", "attest"]],
  ] as const) {
    const guard = step(job, guardName), environment = record(guard.env);
    expect(guard.run).toBe("bun --no-env-file --no-install scripts/native-process-workflow-artifacts.ts");
    expect(environment.GITHUB_TOKEN).toBe("${{ github.token }}");
    expect(environment.NATIVE_PROCESS_SOURCE_SHA).toBe("${{ needs.source.outputs.sha }}");
    const values: unknown = JSON.parse(String(environment.NATIVE_PROCESS_ARTIFACTS));
    expect(values).toEqual(expectedInputs.map(input => ({ id: `\${{ needs.${input}.outputs.artifact-id }}`,
      digest: `\${{ needs.${input}.outputs.artifact-digest }}` })));
    const downloads = steps(job).filter(value => typeof value.uses === "string" && value.uses.startsWith("actions/download-artifact@"));
    expect(downloads).toHaveLength(expectedInputs.length);
    for (const [index, download] of downloads.entries()) {
      expect(download.uses).toBe("actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093");
      const inputs = record(download.with);
      expect(Object.keys(inputs).sort()).toEqual(["artifact-ids", "merge-multiple", "path"]);
      expect(inputs["artifact-ids"]).toBe(`\${{ needs.${expectedInputs[index]}.outputs.artifact-id }}`);
      expect(inputs["merge-multiple"]).toBe(true);
      expect(String(inputs.path)).toMatch(/^\$\{\{ steps\.paths\.outputs\.work \}\}\/(?:archive|provenance|receipts\/(?:darwin|linux)-(?:arm64|x64))$/u);
      expect(steps(job).indexOf(guard)).toBeLessThan(steps(job).indexOf(download));
    }
    // Exercise the real environment parser with a malformed final item. It
    // must reject the complete list before its caller can make any request.
    const artifacts = expectedInputs.map((_, index) => ({ id: String(101 + index), digest: "1".repeat(64) }));
    const fixtureEnv = { GITHUB_TOKEN: "synthetic-fixture-token", GITHUB_RUN_ID: "103", NATIVE_PROCESS_SOURCE_SHA: sourceSha,
      NATIVE_PROCESS_ARTIFACTS: JSON.stringify(artifacts) };
    expect(nativeWorkflowArtifactEnvironment(fixtureEnv).artifacts).toHaveLength(expectedInputs.length);
    for (const replacement of ["", "01", "101\n", "1/other"]) {
      const changed = structuredClone(artifacts); changed[changed.length - 1]!.id = replacement;
      expect(() => nativeWorkflowArtifactEnvironment({ ...fixtureEnv, NATIVE_PROCESS_ARTIFACTS: JSON.stringify(changed) }))
        .toThrow("NATIVE_PROCESS_WORKFLOW_ARTIFACT_INVALID");
    }
  }
});

test("the signature binds archive/checksum to the complete predicate and preserves every intermediate hash", () => {
  const attest = record(jobs.attest), environment = record(attest.env);
  for (const target of targets) expect(environment[`NATIVE_PROCESS_INSTALLED_${target.id.toUpperCase()}_SHA256`])
    .toBe(`\${{ needs.installed_${target.id}.outputs.receipt-sha256 }}`);
  expect(environment.NATIVE_PROCESS_ARCHIVE_SHA256).toBe("${{ needs.assemble.outputs.archive-sha256 }}");
  expect(environment.NATIVE_PROCESS_MANIFEST_SHA256).toBe("${{ needs.assemble.outputs.manifest-sha256 }}");
  expect(environment.NATIVE_PROCESS_TAG_OBJECT_SHA).toBe("${{ needs.source.outputs.tag-object }}");
  const evidence = step("attest", "evidence"), signing = step("attest", "provenance"), combine = step("attest", "combine");
  expect(signing.uses).toBe("actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6");
  expect(signing.with).toEqual({
    "subject-path": "${{ steps.paths.outputs.work }}/archive/hraness-native-process-0.1.0.tgz\n${{ steps.paths.outputs.work }}/archive/SHA256SUMS\n",
    "predicate-type": "https://github.com/hraness/oompa/native-process/qualification/v1",
    "predicate-path": "${{ steps.paths.outputs.work }}/evidence/predicate.json", "create-storage-record": false, "push-to-registry": false,
  });
  expect(steps("attest").indexOf(evidence)).toBeLessThan(steps("attest").indexOf(signing));
  expect(steps("attest").indexOf(signing)).toBeLessThan(steps("attest").indexOf(combine));
  expect(script("attest", "evidence")).toContain('runNativeReleaseEvidence(["prepare"');
  expect(script("attest", "evidence")).toContain('join(work, "receipts"), join(work, "tag-object"), join(work, "evidence")');
  expect(script("attest", "evidence")).toContain('predicate-sha256=${result.predicateSha256}');
  expect(script("attest", "evidence")).toContain('coordinate-sha256=${result.coordinateSha256}');
  expect(combine.env).toEqual({ WORK: "${{ steps.paths.outputs.work }}", BUNDLE: "${{ steps.provenance.outputs.bundle-path }}",
    NATIVE_PROCESS_PREDICATE_SHA256: "${{ steps.evidence.outputs.predicate-sha256 }}",
    NATIVE_PROCESS_COORDINATE_SHA256: "${{ steps.evidence.outputs.coordinate-sha256 }}" });
  expect(script("attest", "combine")).toContain('runNativeReleaseEvidence(["combine"');
  expect(script("attest", "combine")).toContain('provenance-sha256=${result.provenanceSha256}');
  const authority = step("attest", "Require current workload authority before signing");
  expect(record(authority.env).GITHUB_TOKEN).toBe("${{ github.token }}");
  expect(script("attest", "Require current workload authority before signing")).toContain("nativeProcessReleaseAuthority(await fetchNativeProcessReleaseAuthority(");
  expect(steps("attest").indexOf(authority)).toBeLessThan(steps("attest").indexOf(signing));
  expect(record(attest.outputs)).toEqual({ "artifact-id": "${{ steps.identity.outputs.artifact-id }}",
    "artifact-digest": "${{ steps.identity.outputs.artifact-digest }}", "provenance-sha256": "${{ steps.combine.outputs.provenance-sha256 }}" });
  expect(record(step("attest", "upload").with)).toEqual({ name: "native-process-provenance-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "${{ steps.paths.outputs.work }}/signed/native-process-provenance.json", "if-no-files-found": "error", "retention-days": 7, overwrite: false });
});

function contextFor(job: "attest" | "publish", attempt: number) {
  const values: Readonly<Record<string, string | number>> = { repository: "hraness/oompa", repository_id: "1343008607",
    repository_owner_id: "307125679", actor_id: "894119", "event.sender.id": "894119", "event.sender.type": "User", event_name: "push",
    ref: "refs/tags/native-process-v0.1.0", ref_name: "native-process-v0.1.0", ref_type: "tag",
    workflow_ref: "hraness/oompa/.github/workflows/native-process-release.yml@refs/tags/native-process-v0.1.0",
    run_id: "103", run_attempt: attempt, sha: sourceSha, workflow_sha: sourceSha };
  const text = record(record(jobs[job]).env).NATIVE_PROCESS_RELEASE_CONTEXT;
  if (typeof text !== "string") throw Error("Missing release context");
  return nativeProcessReleaseRun(JSON.parse(text.replace(/\$\{\{ github\.([^} ]+) \}\}/gu, (_, key: string) => {
    const value = values[key]; if (value === undefined) throw Error("Unrecognized release context field"); return String(value);
  })) as unknown);
}
test("publication reruns retain original provenance and admit the current execution attempt separately", () => {
  const producing = contextFor("attest", 1), execution = contextFor("publish", 2);
  expect(execution).toEqual({ ...producing, attempt: 2 });
  expect(steps("publish").some(value => typeof value.uses === "string" && value.uses.startsWith("actions/attest@"))).toBe(false);
  for (const current of steps("publish")) if (typeof current.run === "string")
    expect(current.run).not.toMatch(/runNativeReleaseEvidence|predicate\.json|coordinate\.json|JSON\.stringify/u);
  const bytes = step("publish", "Bind downloaded bytes to their original admitted job outputs");
  expect(bytes.env).toEqual({ WORK: "${{ steps.paths.outputs.work }}", ARCHIVE_SHA256: "${{ needs.assemble.outputs.archive-sha256 }}",
    MANIFEST_SHA256: "${{ needs.assemble.outputs.manifest-sha256 }}", PROVENANCE_SHA256: "${{ needs.attest.outputs.provenance-sha256 }}" });
  const publisher = step("publish", "Publish and verify immutable native package");
  expect(steps("publish").indexOf(bytes)).toBeLessThan(steps("publish").indexOf(publisher));
  const historicalJob = { id: 99, run_id: 103, run_url: "https://api.github.com/repos/hraness/oompa/actions/runs/103",
    run_attempt: 1, workflow_name: workflow.name, head_sha: sourceSha, name: record(jobs.publish).name,
    status: "completed", conclusion: "failure", steps: [{ name: publisher.name, status: "completed", conclusion: "skipped" }] };
  expect(priorNativeAttemptProvesNoReleaseCreation({ total_count: 1, jobs: [historicalJob] }, { run: execution, attempt: 1 })).toBe(true);
  historicalJob.steps[0]!.conclusion = "failure";
  expect(priorNativeAttemptProvesNoReleaseCreation({ total_count: 1, jobs: [historicalJob] }, { run: execution, attempt: 1 })).toBe(false);
  expect(record(step("publish", "Retain the completed publication receipt").with)).toEqual({
    name: "native-process-publication-${{ github.run_id }}-${{ github.run_attempt }}", path: "${{ steps.paths.outputs.work }}/publication-receipt.json",
    "if-no-files-found": "error", "retention-days": 30, overwrite: false });
});

function syntheticInstalled(target: typeof targets[number]) {
  const prepack = qualification(target), digest = "6".repeat(64);
  return { formatVersion: 1, phase: "installed-native", profile: prepack.profile, profileVersion: 1,
    source: prepack.source, target: target.target, rustTarget: target.rust, artifact: prepack.artifact, harnesses: prepack.harnesses,
    archiveSha256: "3".repeat(64), manifestSha256: "4".repeat(64), prepackSha256: digest, verifierSha256: digest, workerSha256: digest,
    dependency: { name: "zod", version: "4.4.3", integrity: nativeProcessDependency.integrity, archiveSha256: digest, inventorySha256: digest },
    bun: { version: "1.3.14", sha256: digest }, installation: { localLockSha256: digest, clientInventorySha256: digest,
      image: { device: "1", inode: "2", uid: "3", gid: "4", mode: 0o500, bytes: 64, sha256: prepack.artifact.sha256 } },
    checks: { unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 }, transport: [...NATIVE_TRANSPORT_CASES] } };
}
test.each(["valid", "changed-archive", "changed-provenance", "missing-provenance-pin", "wrong-manifest-pin", "wrong-coordinate-archive"] as const)(
  "actual publication input gate binds original bytes before publisher execution: %s", scenario => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "native-process-publication-input-")));
    try {
      const archive = Buffer.from("synthetic inert archive, never installed"), archiveSha256 = nativeInputHash(archive), manifestSha256 = "4".repeat(64);
      const coordinate = { source: qualification(targets[0]).source, tagObjectSha: "7".repeat(40), archive: { bytes: archive.length, sha256: archiveSha256 },
        manifestSha256, run: contextFor("attest", 1) };
      if (scenario === "wrong-coordinate-archive") coordinate.archive.sha256 = "9".repeat(64);
      const provenance = Buffer.from(JSON.stringify({ formatVersion: 1, qualification: {
        formatVersion: 1, package: "@hraness/native-process", version: "0.1.0", tag: "native-process-v0.1.0", coordinate,
        targets: targets.map(target => target.target), evidence: targets.map(target => ({ target: target.target, prepackSha256: "6".repeat(64),
          installedSha256: "6".repeat(64), installed: syntheticInstalled(target) })),
      }, bundle: {} }) + "\n");
      mkdirSync(join(fixture, "archive")); mkdirSync(join(fixture, "provenance"));
      writeFileSync(join(fixture, "archive/hraness-native-process-0.1.0.tgz"), scenario === "changed-archive" ? Buffer.concat([archive, Buffer.from(" ")]) : archive);
      writeFileSync(join(fixture, "provenance/native-process-provenance.json"), scenario === "changed-provenance" ? Buffer.concat([provenance, Buffer.from(" ")]) : provenance);
      // The real inline gate performs only bounded file reads and structural
      // parsing. No native payload, signature or publisher is executed here.
      const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", "-"], {
        cwd: root, input: inline(script("publish", "Bind downloaded bytes to their original admitted job outputs")),
        env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", WORK: fixture, ARCHIVE_SHA256: archiveSha256,
          MANIFEST_SHA256: scenario === "wrong-manifest-pin" ? "9".repeat(64) : manifestSha256,
          PROVENANCE_SHA256: scenario === "missing-provenance-pin" ? "" : nativeInputHash(provenance) },
        encoding: "utf8", timeout: 10000, maxBuffer: 4096,
      });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.stdout).toBe("");
      expect(result.status, result.stderr).toBe(scenario === "valid" ? 0 : 1);
      if (scenario !== "valid") expect(result.stderr).toContain("NATIVE_RELEASE_DOWNLOAD_CHANGED");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  },
);

test.each(["valid", "source", "target", "archive", "manifest", "incomplete"] as const)(
  "completed installed receipt output binds the exact admitted coordinates: %s", scenario => {
    const fixture = realpathSync(mkdtempSync(join(tmpdir(), "native-process-installed-receipt-")));
    try {
      const prepack = qualification(targets[0]), digest = "6".repeat(64);
      const receipt = { formatVersion: 1, phase: "installed-native", profile: prepack.profile, profileVersion: 1,
        source: prepack.source, target: "darwin-arm64", rustTarget: "aarch64-apple-darwin", artifact: prepack.artifact, harnesses: prepack.harnesses,
        archiveSha256: "3".repeat(64), manifestSha256: "4".repeat(64), prepackSha256: digest, verifierSha256: digest, workerSha256: digest,
        dependency: { name: "zod", version: "4.4.3", integrity: nativeProcessDependency.integrity, archiveSha256: digest, inventorySha256: digest },
        bun: { version: "1.3.14", sha256: digest }, installation: { localLockSha256: digest, clientInventorySha256: digest,
          image: { device: "1", inode: "2", uid: "3", gid: "4", mode: 0o500, bytes: 64, sha256: prepack.artifact.sha256 } },
        checks: { unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 }, transport: [...NATIVE_TRANSPORT_CASES] } };
      if (scenario === "source") receipt.source.commitSha = "b".repeat(40);
      if (scenario === "target") { receipt.target = "darwin-x64"; receipt.rustTarget = "x86_64-apple-darwin"; }
      if (scenario === "archive") receipt.archiveSha256 = digest;
      if (scenario === "manifest") receipt.manifestSha256 = digest;
      if (scenario === "incomplete") receipt.checks.native.passed = 19;
      const bytes = JSON.stringify(receipt) + "\n", output = join(fixture, "output");
      writeFileSync(join(fixture, "installed-qualification.json"), bytes); writeFileSync(output, "");
      const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", "-"], { cwd: root, input: inline(installedScript("receipt")),
        env: { PATH: "/usr/bin:/bin", NODE_ENV: "production", INSTALLED: fixture, GITHUB_OUTPUT: output, SOURCE_SHA: sourceSha,
          TARGET: "darwin-arm64", ARCHIVE_SHA256: "3".repeat(64), MANIFEST_SHA256: "4".repeat(64) },
        encoding: "utf8", timeout: 10000, maxBuffer: 4096 });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status, result.stderr).toBe(scenario === "valid" ? 0 : 1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(scenario === "valid" ? "" : "::error::NATIVE_INSTALLED_RECEIPT_INVALID\n");
      expect(readFileSync(output, "utf8")).toBe(scenario === "valid" ? `receipt-sha256=${nativeInputHash(Buffer.from(bytes))}\n` : "");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  },
);
