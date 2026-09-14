import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import { appSourceProofChildEnvironment, appSourceProofGitCommand } from "../verify-app-source-launcher";
import { captureCredentialFreeClaudeMacosAdmission, captureNativeClaudeMacosAdmission } from "./admission";
import type { ClaudeMacosPreflightScope } from "./preflight";

const content = "credential-free admission fixture; never execute\n";
const fixtureSha256 = createHash("sha256").update(content).digest("hex");
const id = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type FixturePorts = Parameters<typeof captureCredentialFreeClaudeMacosAdmission>[1];
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "oompa-admission-fixture-"));
  const repositoryRoot = join(root, "repository"); const executablePath = join(root, "synthetic-executable");
  const git = (args: readonly string[]): string => {
    const argv = appSourceProofGitCommand(args);
    const child = spawnSync(argv[0] ?? "/usr/bin/git", argv.slice(1), { cwd: repositoryRoot, env: appSourceProofChildEnvironment(),
      encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    if (child.status !== 0 || child.signal !== null || child.error !== undefined) throw new Error("synthetic_git_failed");
    return child.stdout.trim();
  };
  try {
    mkdirSync(repositoryRoot, { mode: 0o700 });
    git(["init", "--quiet"]); git(["config", "user.email", "fixture@example.invalid"]); git(["config", "user.name", "Admission Fixture"]);
    git(["remote", "add", "origin", "https://github.com/hraness/oompa.git"]);
    writeFileSync(join(repositoryRoot, "payload.txt"), "source fixture\n");
    git(["add", "--all"]); git(["commit", "--quiet", "--message", "fixture"]);
    writeFileSync(executablePath, content, { mode: 0o700 });
    const input = { repositoryRoot, executablePath, sourceCommit: git(["rev-parse", "HEAD^{commit}"]), fixtureExecutableSha256: fixtureSha256 };
    let bindings = 0; let assertions = 0; let bindingChanged = false;
    const ports: FixturePorts = { bindEnvironment() { bindings += 1;
      return { assertCurrent() { assertions += 1; if (bindingChanged) throw new Error("synthetic_binding_changed"); } };
    } };
    const capture = () => captureCredentialFreeClaudeMacosAdmission(input, ports);
    const scope = (): ClaudeMacosPreflightScope => {
      const node = lstatSync(executablePath);
      return { runId: id(1), attemptId: id(2), probeId: id(3), profile: "A", operation: "version", sourceSha: input.sourceCommit,
        sourceTree: git(["rev-parse", "HEAD^{tree}"]), executablePath, executableSha256: fixtureSha256, executableDevice: node.dev, executableInode: node.ino,
        configDir: join(root, "profile-A"), temporaryDirectory: join(root, "temporary-A"), environment: { HOME: "/synthetic/home", PATH: "/usr/bin:/bin" },
        signal: new AbortController().signal, deadlineMs: 5000 };
    };
    return { root, input, ports, capture, scope, git, counts: () => ({ bindings, assertions }), changeBinding: () => { bindingChanged = true; },
      cleanup: () => { rmSync(root, { recursive: true, force: true }); } };
  } catch (error: unknown) { rmSync(root, { recursive: true, force: true }); throw error; }
}

test("fixture admission derives exact source and executable identity without native provenance or execution", async () => {
  const value = fixture();
  try {
    const admission = value.capture(); const scope = value.scope();
    expect(Object.keys(admission).sort()).toEqual(["assertFixtureCurrent", "fixtureSource", "provenance", "revalidateFixture"]);
    expect(admission.provenance).toBe("credential_free_fixture");
    expect(Object.isFrozen(admission)).toBeTrue(); expect(Object.isFrozen(admission.fixtureSource.executable)).toBeTrue();
    expect(admission.fixtureSource).toEqual({ sourceSha: scope.sourceSha, sourceTree: scope.sourceTree,
      executable: { path: scope.executablePath, device: scope.executableDevice, inode: scope.executableInode } });
    const current = await admission.revalidateFixture(scope); current.assertCurrent(scope);
    expect(value.counts()).toEqual({ bindings: 1, assertions: 1 });
    expect(admission).not.toHaveProperty("artifactProvenance"); expect(admission).not.toHaveProperty("preflightAuthority");
  } finally { value.cleanup(); }
});

test("native entry refuses fixture digests, reader overrides and authority booleans before any native work", () => {
  fc.assert(fc.property(fc.constantFrom("fixtureExecutableSha256", "signatureChecked", "sourceChecked", "readExecutable", "bindEnvironment"), (extra) => {
    const input = { repositoryRoot: "/synthetic/repository", executablePath: "/synthetic/executable", sourceCommit: "a".repeat(40), [extra]: true };
    expect(() => captureNativeClaudeMacosAdmission(input)).toThrow("CLAUDE_MACOS_ADMISSION_invalid_input");
  }));
  for (const input of [null, [], {}, { repositoryRoot: "/synthetic/../repository", executablePath: "/synthetic/executable", sourceCommit: "a".repeat(40) },
    { repositoryRoot: "/synthetic/repository", executablePath: "/" + "x".repeat(4096), sourceCommit: "a".repeat(40) }]) {
    expect(() => captureNativeClaudeMacosAdmission(input)).toThrow("CLAUDE_MACOS_ADMISSION_invalid_input");
  }
});

test("preflight snapshots the full scope and environment across the awaited authority handoff", async () => {
  const value = fixture();
  try {
    const admission = value.capture(); const scope = value.scope();
    const environment = { ...scope.environment }; const request = { ...scope, environment };
    const current = await admission.revalidateFixture(request);
    environment.PATH = "/synthetic/changed";
    expect(() => current.assertCurrent(request)).toThrow("scope_refused");
    expect(() => current.assertCurrent(scope)).not.toThrow();
    const changes: readonly Partial<ClaudeMacosPreflightScope>[] = [
      { runId: id(9) }, { attemptId: id(9) }, { probeId: id(9) }, { profile: "B" }, { operation: "logout_help" },
      { sourceSha: "a".repeat(40) }, { sourceTree: "b".repeat(40) }, { executablePath: "/synthetic/other" },
      { executableSha256: "0".repeat(64) }, { executableDevice: scope.executableDevice + 1 }, { executableInode: scope.executableInode + 1 },
      { configDir: "/synthetic/config" }, { temporaryDirectory: "/synthetic/tmp" }, { deadlineMs: 3000 }, { signal: new AbortController().signal },
    ];
    for (const change of changes) expect(() => current.assertCurrent({ ...scope, ...change })).toThrow("scope_refused");
    expect(() => current.assertCurrent({ ...scope, arbitrary: true } as ClaudeMacosPreflightScope)).toThrow("scope_refused");
    expect(value.counts().assertions).toBe(1);
  } finally { value.cleanup(); }
});

test("each authority preparation admits its own A or B scope without invalidating a sibling source fence", async () => {
  const value = fixture();
  try {
    const admission = value.capture(); const first = value.scope();
    const second = { ...first, profile: "B" as const, probeId: id(4), configDir: join(value.root, "profile-B"), temporaryDirectory: join(value.root, "temporary-B") };
    const a = await admission.revalidateFixture(first); const b = await admission.revalidateFixture(second);
    a.assertCurrent(first); b.assertCurrent(second);
    expect(value.counts()).toEqual({ bindings: 2, assertions: 2 });
    value.changeBinding(); expect(() => a.assertCurrent(first)).toThrow("binding_refused");
  } finally { value.cleanup(); }
});

test("abort and mismatched checked identity refuse before an environment binder runs", async () => {
  const value = fixture();
  try {
    const admission = value.capture(); const scope = value.scope(); const controller = new AbortController(); controller.abort();
    for (const change of [{ executableSha256: "0".repeat(64) }, { executableInode: scope.executableInode + 1 }, { sourceTree: "0".repeat(40) },
      { temporaryDirectory: scope.configDir }, { signal: controller.signal }]) await expect(admission.revalidateFixture({ ...scope, ...change })).rejects.toThrow();
    expect(value.counts().bindings).toBe(0);
    const live = new AbortController(); const request = { ...scope, signal: live.signal }; const current = await admission.revalidateFixture(request);
    live.abort(); expect(() => current.assertCurrent(request)).toThrow("aborted"); expect(value.counts().assertions).toBe(0);
  } finally { value.cleanup(); }
});

test("tracked source drift, executable content changes and equal-byte inode substitution invalidate captured authority", async () => {
  for (const change of ["source", "content", "inode", "mode"] as const) {
    const value = fixture();
    try {
      const admission = value.capture(); const scope = value.scope(); const current = await admission.revalidateFixture(scope);
      if (change === "source") writeFileSync(join(value.input.repositoryRoot, "payload.txt"), "source changed\n");
      if (change === "content") writeFileSync(value.input.executablePath, "different executable bytes\n");
      if (change === "inode") {
        renameSync(value.input.executablePath, join(value.root, "old-executable")); writeFileSync(value.input.executablePath, content, { mode: 0o700 });
      }
      if (change === "mode") chmodSync(value.input.executablePath, 0o755);
      expect(() => admission.assertFixtureCurrent()).toThrow(change === "source" ? "source_refused" : "executable_refused");
      expect(() => current.assertCurrent(scope)).toThrow(change === "source" ? "source_refused" : "executable_refused");
    } finally { value.cleanup(); }
  }
});

test("source revalidation retains the explicit captured-content scope and refuses a replaced source root", () => {
  const value = fixture();
  try {
    const admission = value.capture();
    value.git(["remote", "set-url", "origin", "https://example.invalid/later-source.git"]);
    writeFileSync(join(value.input.repositoryRoot, "later-untracked.txt"), "untracked\n");
    expect(() => admission.assertFixtureCurrent()).not.toThrow();
    expect(() => value.capture()).toThrow("source_refused");
    renameSync(value.input.repositoryRoot, join(value.root, "old-repository")); mkdirSync(value.input.repositoryRoot, { mode: 0o700 });
    writeFileSync(join(value.input.repositoryRoot, "payload.txt"), "source fixture\n");
    expect(() => admission.assertFixtureCurrent()).toThrow("source_refused");
  } finally { value.cleanup(); }
});

test("executable input refuses symlinks, writable or missing execution bits, and oversized sparse fixtures", () => {
  for (const change of ["symlink", "writable", "not-executable", "oversized"] as const) {
    const value = fixture();
    try {
      if (change === "symlink") { renameSync(value.input.executablePath, join(value.root, "target")); symlinkSync(join(value.root, "target"), value.input.executablePath); }
      if (change === "writable") chmodSync(value.input.executablePath, 0o722);
      if (change === "not-executable") chmodSync(value.input.executablePath, 0o600);
      if (change === "oversized") truncateSync(value.input.executablePath, 512 * 1024 * 1024 + 1);
      expect(() => value.capture()).toThrow("executable_refused");
    } finally { value.cleanup(); }
  }
});

test("post-hash same-byte named executable replacement cannot become the admitted baseline", () => {
  const value = fixture(); const inode = lstatSync(value.input.executablePath).ino; const original = fs.fstatSync; let reads = 0;
  function observedStat(descriptor: number, options?: fs.StatOptions & { bigint?: false | undefined }): fs.Stats;
  function observedStat(descriptor: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
  function observedStat(descriptor: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
  function observedStat(descriptor: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
    const metadata = original(descriptor, options);
    if (metadata.ino === inode && ++reads === 2) {
      renameSync(value.input.executablePath, join(value.root, "retained-executable")); writeFileSync(value.input.executablePath, content, { mode: 0o700 });
    }
    return metadata;
  }
  const inspect = spyOn(fs, "fstatSync").mockImplementation(observedStat);
  try { expect(() => value.capture()).toThrow("executable_refused"); expect(reads).toBe(2); }
  finally { inspect.mockRestore(); value.cleanup(); }
});
