import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nativeInputHash } from "./native-process-build-inputs.ts";
import { NATIVE_QUALIFICATION_HARNESS_FILES, NATIVE_TRANSPORT_CASES } from "./native-process-qualification-model.ts";

const root = realpathSync(join(import.meta.dir, ".."));
const workflowText = readFileSync(join(root, ".github/workflows/native-process-target.yml"), "utf8");
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw Error("Expected workflow object");
  return value as Record<string, unknown>;
}
const workflow = record(Bun.YAML.parse(workflowText));
const job = record(record(workflow.jobs).qualify);
if (!Array.isArray(job.steps)) throw Error("Expected workflow steps");
const steps = job.steps.map(record);
function step(id: string): Record<string, unknown> {
  const found = steps.find(value => value.id === id || value.name === id);
  if (found === undefined) throw Error("Missing workflow step");
  return found;
}
function script(id: string): string {
  const value = step(id).run;
  if (typeof value !== "string") throw Error("Missing step script");
  return value;
}
const mappings = [
  { target: "darwin-arm64", os: "macos-15", runnerOs: "macOS", arch: "ARM64", rust: "aarch64-apple-darwin" },
  { target: "darwin-x64", os: "macos-15-intel", runnerOs: "macOS", arch: "X64", rust: "x86_64-apple-darwin" },
  { target: "linux-x64", os: "ubuntu-24.04", runnerOs: "Linux", arch: "X64", rust: "x86_64-unknown-linux-musl" },
  { target: "linux-arm64", os: "ubuntu-24.04-arm", runnerOs: "Linux", arch: "ARM64", rust: "aarch64-unknown-linux-musl" },
] as const;

test("target qualification has only exact reusable inputs, read permission and bounded hosted runners", () => {
  expect(Object.keys(workflow.on as object)).toEqual(["workflow_call"]);
  const call = record(record(workflow.on).workflow_call), inputs = record(call.inputs);
  expect(Object.keys(call).sort()).toEqual(["inputs", "outputs"]);
  expect(Object.keys(inputs)).toEqual(["source-sha", "os", "target"]);
  for (const input of Object.values(inputs)) {
    const value = record(input);
    expect(Object.keys(value).sort()).toEqual(["description", "required", "type"]);
    expect(value.required).toBe(true); expect(value.type).toBe("string");
  }
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(Object.keys(record(workflow.jobs))).toEqual(["qualify"]);
  expect(job["runs-on"]).toBe("${{ inputs.os == 'macos-15' && 'macos-15' || inputs.os == 'macos-15-intel' && 'macos-15-intel' || inputs.os == 'ubuntu-24.04-arm' && 'ubuntu-24.04-arm' || 'ubuntu-24.04' }}");
  expect(job["timeout-minutes"]).toBe(45);
  expect(job.defaults).toEqual({ run: { shell: "bash" } });
  for (const key of ["env", "if", "permissions", "environment", "continue-on-error", "services", "container", "strategy"]) {
    expect(job[key]).toBeUndefined();
  }
  expect(workflowText).not.toMatch(/secrets\.|secrets:|id-token:|contents: write|packages: write|workflow_dispatch|pull_request_target/u);
  expect(steps[0]?.id).toBe("admission");
  for (const value of steps) {
    expect(value.if).toBeUndefined(); expect(value["continue-on-error"]).toBeUndefined();
    if (typeof value.run === "string") expect(value.run).not.toContain("${{");
  }
});

test("target preparation pins checkout/actions/tools and completes online fetch before the unchanged offline qualifier", () => {
  expect(steps.filter(value => value.uses !== undefined).map(value => [value.uses, value.with])).toEqual([
    ["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", {
      ref: "${{ inputs.source-sha }}", "fetch-depth": 1, "fetch-tags": false, "persist-credentials": false,
    }],
    ["oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6", { "bun-version": "1.3.14" }],
    ["actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02", {
      name: "native-process-target-${{ inputs.target }}-${{ inputs.source-sha }}-${{ github.run_attempt }}",
      path: "${{ steps.paths.outputs.bundle }}", "if-no-files-found": "error", "compression-level": 0,
      "retention-days": 7, "include-hidden-files": false, overwrite: false,
    }],
  ]);
  const names = steps.map(value => value.name);
  expect(names.indexOf("Install the frozen JavaScript dependency graph")).toBeLessThan(names.indexOf("Fetch locked native dependencies before offline qualification"));
  expect(names.indexOf("Prepare the pinned Rust toolchain and target")).toBeLessThan(names.indexOf("Fetch locked native dependencies before offline qualification"));
  expect(names.indexOf("Fetch locked native dependencies before offline qualification")).toBeLessThan(names.indexOf("Qualify exact release bytes offline on this host"));
  expect(script("Verify source and native host")).toContain("git rev-parse --verify 'HEAD^{commit}'");
  expect(script("Verify source and native host")).toContain('`${process.platform}-${process.arch}` !== process.env.OOMPA_TARGET');
  expect(script("paths")).toContain('mktemp -d "$RUNNER_TEMP/native-process-target.XXXXXX"');
  expect(script("paths")).toContain("umask 077");
  expect(script("paths")).toContain('"$work/cargo" "$work/rustup" "$work/temporary" "$work/bun-cache"');
  expect(script("Install the frozen JavaScript dependency graph")).toContain("bun install --frozen-lockfile --ignore-scripts");
  expect(script("Prepare the pinned Rust toolchain and target")).toContain("rustup toolchain install 1.97.1 --profile minimal --component clippy --component rustfmt");
  expect(script("Prepare the pinned Rust toolchain and target")).toContain('--target "$OOMPA_RUST_TARGET"');
  expect(script("Fetch locked native dependencies before offline qualification")).toContain('cargo fetch --locked --target "$OOMPA_RUST_TARGET" --manifest-path native/process-kernel/Cargo.toml');
  expect(record(step("Fetch locked native dependencies before offline qualification").env).CARGO_NET_OFFLINE).toBe("false");
  expect(record(step("Qualify exact release bytes offline on this host").env).CARGO_NET_OFFLINE).toBe("true");
  expect(script("Qualify exact release bytes offline on this host")).toContain('bun --no-env-file --no-install scripts/native-process-qualify.ts "$OOMPA_TARGET_BUNDLE"');
  expect(script("Qualify exact release bytes offline on this host")).toContain('> "$OOMPA_TARGET_WORK/qualification.log" 2>&1');
  expect(workflowText).not.toMatch(/cargo (?:build|test|clippy)|native-process-installed|gh release|npm publish|cargo publish|rm -r|actions\/cache/u);
  const qualifier = readFileSync(join(root, "scripts/native-process-qualify.ts"), "utf8");
  expect(qualifier).toContain('["--release", "--target", rustTarget, "--locked", "--offline", "--manifest-path", join(kernel, "Cargo.toml")]');
  for (const required of ['"unit"', '"native"', '"transport"', '"clippy"', '"licenses"', '"qualification.json"']) expect(qualifier).toContain(required);
});

test("reusable qualification supplements every existing required source and browser gate", () => {
  // Compare to the existing authority independently: the new one-target job
  // does not replace complete source shards, their ordered remainder or browser acceptance.
  const ci = record(Bun.YAML.parse(readFileSync(join(root, ".github/workflows/ci.yml"), "utf8")));
  const jobs = record(ci.jobs), check = record(jobs.check), strategy = record(check.strategy);
  expect(record(strategy.matrix)).toEqual({ os: ["macos-15", "ubuntu-24.04"],
    gate: ["source-1", "source-2", "source-3", "source-4", "source-5", "source-6", "remainder"] });
  expect(record(jobs.required).needs).toEqual(["check", "browser"]);
  const browser = record(jobs.browser);
  expect(browser["runs-on"]).toBe("ubuntu-24.04");
  expect(JSON.stringify(browser.steps)).toContain("bun run check:browser");
  expect(JSON.stringify(check.steps)).toContain("bun run check:ci-remainder");
  expect(job.needs).toBeUndefined();
});

test("each exact target/runner pair is admitted and every cross-pair or malformed input is refused before checkout", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "native-process-target-guard-"))), output = join(directory, "output");
  try {
    for (const target of mappings) for (const runner of mappings) {
      writeFileSync(output, "");
      const result = spawnSync("/bin/bash", ["-c", script("admission")], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096,
        env: { PATH: "/usr/bin:/bin", GITHUB_OUTPUT: output, OOMPA_SOURCE_SHA: "a".repeat(40), OOMPA_TARGET: target.target,
          OOMPA_RUNNER_LABEL: runner.os, OOMPA_RUNNER_OS: runner.runnerOs, OOMPA_RUNNER_ARCH: runner.arch } });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      expect(result.status).toBe(target === runner ? 0 : 1);
      expect(readFileSync(output, "utf8")).toBe(target === runner ? `rust-target=${target.rust}\n` : "");
    }
    for (const source of ["main", "a".repeat(39), "A".repeat(40), "a".repeat(40) + "\n", "$(touch sentinel)"]) {
      writeFileSync(output, "");
      const result = spawnSync("/bin/bash", ["-c", script("admission")], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096,
        env: { PATH: "/usr/bin:/bin", GITHUB_OUTPUT: output, OOMPA_SOURCE_SHA: source, OOMPA_TARGET: "darwin-arm64",
          OOMPA_RUNNER_LABEL: "macos-15", OOMPA_RUNNER_OS: "macOS", OOMPA_RUNNER_ARCH: "ARM64" } });
      expect(result.error).toBeUndefined(); expect(result.status, JSON.stringify(source)).toBe(1); expect(readFileSync(output, "utf8")).toBe("");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("completed-bundle and uploaded-artifact outputs remain distinct and bounded", () => {
  const outputs = record(record(record(workflow.on).workflow_call).outputs);
  expect(Object.keys(outputs)).toEqual(["artifact-id", "artifact-digest", "qualification-sha256"]);
  for (const name of Object.keys(outputs)) expect(record(outputs[name]).value).toBe(`\${{ jobs.qualify.outputs.${name} }}`);
  expect(job.outputs).toEqual({ "artifact-id": "${{ steps.outputs.outputs.artifact-id }}",
    "artifact-digest": "${{ steps.outputs.outputs.artifact-digest }}", "qualification-sha256": "${{ steps.bundle.outputs.qualification-sha256 }}" });
  expect(script("outputs")).toContain('[[ "$OOMPA_ARTIFACT_ID" =~ ^[1-9][0-9]*$ && "$OOMPA_ARTIFACT_ID" != *[!0-9]* && ${#OOMPA_ARTIFACT_ID} -le 20 ]]');
  expect(script("outputs")).toContain('[[ ${#OOMPA_ARTIFACT_DIGEST} -eq 64 && "$OOMPA_ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]');
  expect(script("bundle")).toContain('nativeBuildInput(join(bundle, "qualification.json"), 256 * 1024)');
  expect(script("bundle")).toContain("parseNativeQualification(JSON.parse");
  expect(script("bundle")).toContain("receipt.source.commitSha !== process.env.OOMPA_SOURCE_SHA");
  expect(script("bundle")).toContain("receipt.target !== process.env.OOMPA_TARGET");
  expect(script("bundle")).toContain("NATIVE_QUALIFICATION_HARNESS_FILES");
  expect(script("bundle")).toContain("nativeInputHash(licenses) !== receipt.licensesSha256");
  expect(script("bundle")).not.toMatch(/spawn|qualifyNativeProcess|fetch\(|writeFile|rmSync/u);
  for (const value of steps.filter(value => typeof value.run === "string")) {
    const result = spawnSync("/bin/bash", ["-n"], { input: value.run as string, encoding: "utf8", timeout: 5_000, maxBuffer: 4096 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
  }
});

test("artifact output framing refuses malformed, oversized or newline-bearing identities", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "native-process-target-output-"))), output = join(directory, "output");
  try {
    for (const id of ["123", "", "0", "01", "123\n", "123\nextra=unsafe", "1".repeat(21)]) {
      for (const digest of ["a".repeat(64), "a".repeat(64) + "\n", "A".repeat(64), "a".repeat(63)]) {
        writeFileSync(output, "");
        const result = spawnSync("/bin/bash", ["-c", script("outputs")], { encoding: "utf8", timeout: 5_000, maxBuffer: 4096,
          env: { PATH: "/usr/bin:/bin", GITHUB_OUTPUT: output, OOMPA_ARTIFACT_ID: id, OOMPA_ARTIFACT_DIGEST: digest } });
        const valid = id === "123" && digest === "a".repeat(64);
        expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status, JSON.stringify({ id, digest })).toBe(valid ? 0 : 1);
        expect(readFileSync(output, "utf8")).toBe(valid ? `artifact-id=${id}\nartifact-digest=${digest}\n` : "");
      }
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test.each(["valid", "source", "target", "incomplete", "helper", "harness", "licenses"] as const)(
  "the actual inline completion reader admits only a bound complete bundle: %s", scenario => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "native-process-target-bundle-")));
    try {
      const image = Buffer.alloc(64, 42), identity = { bytes: image.length, sha256: nativeInputHash(image) };
      const qualification = { formatVersion: 1, phase: "prepack-native", profile: "native-process-v1-posix-custody", profileVersion: 1,
        source: { commitSha: "a".repeat(40), treeSha256: "b".repeat(64), bunLockSha256: "c".repeat(64), cargoLockSha256: "d".repeat(64),
          toolchainSha256: "e".repeat(64), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" },
        target: "darwin-arm64", rustTarget: "aarch64-apple-darwin", artifact: identity,
        licensesSha256: nativeInputHash(Buffer.from("synthetic notice index")),
        harnesses: { unit: identity, native: identity, fixture: identity },
        compiler: { rustcVerboseVersion: "rustc 1.97.1 (synthetic)", cargoVersion: "cargo 1.97.1 (synthetic)",
          bunVersion: "1.3.14", deploymentTarget: "11.0", environmentPolicy: "native-process-build-env-v1",
          linker: { sha256: "0".repeat(64), version: "synthetic linker" }, sdk: { kind: "macos", version: "fixture", buildVersion: "fixture" },
          host: { architecture: "arm64", osRelease: "fixture" } },
        checks: { clippy: "passed", unit: { passed: 6, failed: 0, ignored: 0 }, native: { passed: 20, failed: 0, ignored: 0 },
          transport: [...NATIVE_TRANSPORT_CASES] } };
      if (scenario === "source") qualification.source.commitSha = "f".repeat(40);
      if (scenario === "target") qualification.target = "darwin-x64";
      if (scenario === "incomplete") qualification.checks.native.passed = 19;
      const bytes = JSON.stringify(qualification) + "\n";
      writeFileSync(join(directory, "qualification.json"), bytes);
      for (const name of ["oompa-process-kernel", ...Object.values(NATIVE_QUALIFICATION_HARNESS_FILES)]) writeFileSync(join(directory, name), image);
      // A synthetic index suffices here: the qualifier and package assembler
      // own its schema; this handoff reader binds the exact completed bytes.
      mkdirSync(join(directory, "licenses")); writeFileSync(join(directory, "licenses/manifest.json"), "synthetic notice index");
      if (scenario === "helper") writeFileSync(join(directory, "oompa-process-kernel"), Buffer.alloc(64));
      if (scenario === "harness") writeFileSync(join(directory, "native-tests"), Buffer.alloc(64));
      if (scenario === "licenses") writeFileSync(join(directory, "licenses/manifest.json"), "changed");
      const source = script("bundle").match(/<<'BUN'\n([\s\S]*)\nBUN\n?$/u)?.[1];
      if (source === undefined) throw Error("Missing fixed inline Bun reader");
      const output = join(directory, "output"); writeFileSync(output, "");
      const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", "-"], { cwd: root, input: source,
        encoding: "utf8", timeout: 10_000, maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", NODE_ENV: "production",
          OOMPA_SOURCE_SHA: "a".repeat(40), OOMPA_TARGET: "darwin-arm64", OOMPA_TARGET_BUNDLE: directory, GITHUB_OUTPUT: output } });
      expect(result.error).toBeUndefined(); expect(result.signal).toBeNull();
      expect(result.status).toBe(scenario === "valid" ? 0 : 1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(scenario === "valid" ? "" : "::error::NATIVE_PROCESS_TARGET_BUNDLE_INVALID\n");
      expect(readFileSync(output, "utf8")).toBe(scenario === "valid" ? `qualification-sha256=${nativeInputHash(Buffer.from(bytes))}\n` : "");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  },
);
