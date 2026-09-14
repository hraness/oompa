import { describe, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  appSourceProofChildEnvironment,
  appSourceProofLauncherErrorCodes,
  appSourceProofRuntimeInjectionEnvironmentNames,
  assertHardenedAppSourceProofStageZero,
  assertHostedOperatorSource,
  captureHostedOperatorSource,
  commandCapacityChildEnvironment,
  createAppSourceProofScratchDirectory,
  executeAppSourceProofLauncher,
  parseAppSourceProofLauncherArguments,
  type AppSourceProofLauncherDependencies,
} from "./verify-app-source-launcher";

const sourceCommit = "6".repeat(40);
const deploymentId = "dpl_AppSourceProof123456789012345";
const evidencePath = "/protected/release/app-source-proof.json";
const credentialPath = "/protected/credentials/vercel-auth.json";
const releaseVersion = "0.6.1";
const trackedDocument = "{}\n";
const hardenedRuntimeArguments = ["--no-env-file", "--config=/dev/null"] as const;
const trustedScratchRoot = realpathSync("/tmp");
const trackedObjectId = createHash("sha1")
  .update(`blob ${String(Buffer.byteLength(trackedDocument))}\0`)
  .update(trackedDocument)
  .digest("hex");

const proveArguments = [
  "prove",
  "--deployment-id",
  deploymentId,
  "--evidence-path",
  evidencePath,
  "--release-version",
  releaseVersion,
  "--source-commit",
  sourceCommit,
  "--vercel-auth-path",
  credentialPath,
] as const;
const commandCapacityArguments = [
  "command-capacity",
  "status",
  "--source-commit",
  sourceCommit,
  "--deploy-evidence",
  "/protected/deploy.json",
  "--prod",
] as const;
const quotaUpgradeArguments = [
  "quota-upgrade",
  "status",
  "--source-commit",
  sourceCommit,
  "--deploy-evidence",
  "/protected/deploy.json",
  "--prod",
] as const;

type CommandResult = Readonly<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
}>;

const result = (stdout = "", exitCode = 0): CommandResult => ({
  exitCode,
  signal: null,
  stderr: "",
  stdout,
});

const output = (): { readonly lines: string[]; readonly writer: { write(value: string): void } } => {
  const lines: string[] = [];
  return { lines, writer: { write: (value) => { lines.push(value); } } };
};

const launcherFixture = (overrides: Readonly<{
  childExitCode?: number;
  childSignal?: NodeJS.Signals;
  cleanupLeavesRegistered?: boolean;
  hiddenIndex?: boolean;
  installFails?: boolean;
  buildFails?: boolean;
  buildSignal?: NodeJS.Signals;
  buildThrows?: boolean;
  sourceChangesDuringBuild?: boolean;
  mainAdvancesAfterFirstRead?: boolean;
  maskedOrigin?: boolean;
  remoteMain?: string;
  sshOrigin?: boolean;
  sourceChangesDuringInstall?: boolean;
  worktreeAddFails?: boolean;
  wrongOrigin?: boolean;
}> = {}): Readonly<{
  cleanup: () => void;
  dependencies: AppSourceProofLauncherDependencies;
  events: string[];
  root: string;
}> => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "oompa-app-launch-root-"));
  const scratch = mkdtempSync(join(trustedScratchRoot, "hra-app-source-verifier-"));
  writeFileSync(join(root, "package.json"), trackedDocument);
  const events: string[] = [];
  let mainReadCount = 0;
  let worktreeRegistered = false;
  const runCommand: NonNullable<AppSourceProofLauncherDependencies["runCommand"]> = (
    command,
    options,
  ) => {
    const key = command.join("\0");
    events.push(`command:${options.cwd}:${key}:${String(options.credentialDescriptor ?? "none")}`);
    if (key.includes("\0rev-parse\0--show-toplevel")) return result(options.cwd);
    if (key.includes("\0rev-parse\0--verify\0HEAD^{commit}")) return result(`${sourceCommit}\n`);
    if (key.includes("\0rev-parse\0--show-object-format")) return result("sha1\n");
    if (key.includes("\0config\0--null\0--list")) {
      return result(overrides.maskedOrigin === true
        ? "core.repositoryformatversion\n0\0remote.origin.url\nhttps://attacker.invalid/hra.git\0url.https://github.com/hraness/oompa.git.insteadof\nhttps://attacker.invalid/hra.git\0"
        : `core.repositoryformatversion\n0\0remote.origin.url\n${overrides.wrongOrigin === true
          ? "https://github.com/attacker/hra.git"
          : overrides.sshOrigin === true
            ? "git@github.com:hraness/oompa.git"
            : "https://github.com/hraness/oompa.git"}\0`);
    }
    if (key.includes("\0status\0--porcelain=v1\0--untracked-files=all")) return result();
    if (key.includes("\0ls-files\0-v\0-z")) {
      return result(overrides.hiddenIndex === true ? "S package.json\0" : "H package.json\0");
    }
    if (key.includes("\0ls-tree\0-r\0-z\0--full-tree")) {
      return result(`100644 blob ${trackedObjectId}\tpackage.json\0`);
    }
    if (key.includes("\0ls-files\0--stage\0-z")) {
      return result(`100644 ${trackedObjectId} 0\tpackage.json\0`);
    }
    if (key.includes("\0remote\0get-url\0--all\0origin")) {
      return result(overrides.wrongOrigin === true
        ? "https://github.com/attacker/hra.git\n"
        : overrides.sshOrigin === true
          ? "git@github.com:hraness/oompa.git\n"
          : "https://github.com/hraness/oompa.git\n");
    }
    if (key.includes("\0remote\0get-url\0--push\0--all\0origin")) {
      return result(overrides.sshOrigin === true
        ? "git@github.com:hraness/oompa.git\n"
        : "https://github.com/hraness/oompa.git\n");
    }
    if (key.includes("\0ls-remote\0--heads\0https://github.com/hraness/oompa.git\0refs/heads/main")) {
      mainReadCount += 1;
      const current = overrides.mainAdvancesAfterFirstRead === true && mainReadCount > 2
        ? "7".repeat(40)
        : overrides.remoteMain ?? sourceCommit;
      return result(`${current}\trefs/heads/main\n`);
    }
    if (key.includes("\0worktree\0add\0--detach")) {
      if (overrides.worktreeAddFails === true) return result("", 1);
      worktreeRegistered = true;
      mkdirSync(join(scratch, "source"), { recursive: true });
      writeFileSync(join(scratch, "source", "package.json"), trackedDocument);
      return result();
    }
    if (key.includes("\0worktree\0list\0--porcelain")) {
      return result(worktreeRegistered ? `worktree ${join(scratch, "source")}\n\n` : "");
    }
    if (key.includes("\0worktree\0remove\0--force")) {
      if (overrides.cleanupLeavesRegistered !== true) worktreeRegistered = false;
      return result();
    }
    if (key.includes("\0install\0--frozen-lockfile\0--ignore-scripts\0--backend=copyfile")) {
      if (overrides.sourceChangesDuringInstall === true) {
        writeFileSync(join(root, "package.json"), `${trackedDocument} `);
      }
      return result("", overrides.installFails === true ? 1 : 0);
    }
    if (key.endsWith("/scripts/build-app.ts")) {
      events.push(`build-environment:${JSON.stringify(options.environment ?? {})}`);
      if (overrides.sourceChangesDuringBuild === true) writeFileSync(join(root, "package.json"), `${trackedDocument} `);
      if (overrides.buildThrows === true) throw new Error("fixture_build_exception");
      return { ...result("", overrides.buildFails === true ? 1 : 0), signal: overrides.buildSignal ?? null };
    }
    if (key.includes("/scripts/verify-app-source.ts\0")) {
      return result(
        overrides.childExitCode === 1
          ? ""
          : '{"kind":"hra-app-source-proof","schemaVersion":4}\n',
        overrides.childExitCode ?? 0,
      );
    }
    if (key.includes("/scripts/manage-command-lifecycle-capacity.ts\0")) {
      events.push(`capacity-environment:${JSON.stringify(options.environment ?? {})}`);
      return result('{"state":"ready"}\n');
    }
    if (key.includes("/scripts/manage-quota-upgrade.ts\0")) {
      events.push(`quota-environment:${JSON.stringify(options.environment ?? {})}`);
      return { ...result('{"state":"ready"}\n', overrides.childExitCode ?? 0), signal: overrides.childSignal ?? null };
    }
    throw new Error(`Unexpected command: ${key}`);
  };
  return {
    cleanup: () => {
      rmSync(root, { force: true, recursive: true });
      rmSync(scratch, { force: true, recursive: true });
    },
    dependencies: {
      closeCredential: () => { events.push("credential:closed"); },
      createScratchDirectory: () => {
        events.push("scratch:created");
        return scratch;
      },
      cwd: root,
      openCredential: (path) => {
        events.push(`credential:opened:${path}`);
        return 9;
      },
      removeScratchDirectory: (path) => {
        events.push(`scratch:removed:${path}`);
        rmSync(path, { force: true, recursive: true });
      },
      runCommand,
      runtimePath: "/trusted/bun",
      runtimeArguments: hardenedRuntimeArguments,
      runtimeEnvironment: {},
      runtimeVersion: "1.3.14",
      validateCredential: () => { events.push("credential:validated"); },
    },
    events,
    root,
  };
};

const runFixtureGit = (root: string, arguments_: readonly string[]): string => {
  const invocation = spawnSync("/usr/bin/git", arguments_, {
    cwd: root,
    encoding: "utf8",
    env: appSourceProofChildEnvironment(),
    maxBuffer: 2 * 1024 * 1024,
  });
  if (invocation.status !== 0 || invocation.signal !== null) {
    throw new Error(`Fixture Git command failed: ${arguments_.join(" ")}\n${invocation.stderr}`);
  }
  return invocation.stdout;
};

const realRepositoryLauncherFixture = (
  files: Readonly<Record<string, string>>,
): Readonly<{
  arguments: readonly string[];
  cleanup: () => void;
  dependencies: AppSourceProofLauncherDependencies;
  events: string[];
  git: (arguments_: readonly string[]) => string;
  root: string;
}> => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "oompa-app-launch-real-root-"));
  const scratch = mkdtempSync(join(trustedScratchRoot, "hra-app-source-verifier-"));
  const events: string[] = [];
  const git = (arguments_: readonly string[]): string => runFixtureGit(root, arguments_);
  git(["init", "--quiet"]);
  git(["config", "user.email", "fixture@hra.invalid"]);
  git(["config", "user.name", "Oompa Fixture"]);
  git(["remote", "add", "origin", "https://github.com/hraness/oompa.git"]);
  for (const [path, document] of Object.entries(files)) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, document);
  }
  git(["add", "--all"]);
  git(["commit", "--quiet", "--message", "fixture"]);
  const commit = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  const arguments_ = [
    "prove",
    "--deployment-id",
    deploymentId,
    "--evidence-path",
    evidencePath,
    "--release-version",
    releaseVersion,
    "--source-commit",
    commit,
    "--vercel-auth-path",
    credentialPath,
  ] as const;
  const runCommand: NonNullable<AppSourceProofLauncherDependencies["runCommand"]> = (
    command,
    options,
  ) => {
    const key = command.join("\0");
    events.push(`command:${options.cwd}:${key}:${String(options.credentialDescriptor ?? "none")}`);
    if (key.includes("\0ls-remote\0--heads\0https://github.com/hraness/oompa.git\0refs/heads/main")) {
      return result(`${commit}\trefs/heads/main\n`);
    }
    if (command[0] === "/trusted/bun") {
      if (command[3] === "install" || command[3]?.endsWith("/scripts/build-app.ts") === true) return result();
      if (command[3]?.endsWith("/scripts/verify-app-source.ts") === true) {
        return result('{"kind":"hra-app-source-proof","schemaVersion":4}\n');
      }
    }
    const executable = command[0];
    if (executable === undefined) return result("", 1);
    const invocation = spawnSync(executable, command.slice(1), {
      cwd: options.cwd,
      encoding: "utf8",
      env: appSourceProofChildEnvironment(),
      maxBuffer: options.maximumOutputBytes ?? 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return {
      exitCode: invocation.status ?? 1,
      signal: invocation.signal,
      stderr: invocation.stderr,
      stdout: invocation.stdout,
    };
  };
  return {
    arguments: arguments_,
    cleanup: () => {
      rmSync(scratch, { force: true, recursive: true });
      try {
        git(["worktree", "prune"]);
      } catch {
        // The root may already have been removed after a completed cleanup.
      }
      rmSync(root, { force: true, recursive: true });
    },
    dependencies: {
      closeCredential: () => { events.push("credential:closed"); },
      createScratchDirectory: () => {
        events.push("scratch:created");
        return scratch;
      },
      cwd: root,
      openCredential: (path) => {
        events.push(`credential:opened:${path}`);
        return 9;
      },
      removeScratchDirectory: (path) => {
        events.push(`scratch:removed:${path}`);
        rmSync(path, { force: true, recursive: true });
      },
      runCommand,
      runtimePath: "/trusted/bun",
      runtimeArguments: hardenedRuntimeArguments,
      runtimeEnvironment: {},
      runtimeVersion: "1.3.14",
      validateCredential: () => { events.push("credential:validated"); },
    },
    events,
    git,
    root,
  };
};

describe("Oompa browser app source proof launcher", () => {
  test("parses exact stable proof and retained-verification inputs", () => {
    expect(parseAppSourceProofLauncherArguments(proveArguments)).toEqual({
      deploymentId,
      evidencePath,
      mode: "prove",
      releaseVersion,
      sourceCommit,
      vercelAuthPath: credentialPath,
    });
    expect(parseAppSourceProofLauncherArguments([
      "verify-retained",
      "--evidence-path",
      evidencePath,
      "--release-version",
      "1.0.0",
      "--source-commit",
      sourceCommit,
    ])).toEqual({
      evidencePath,
      mode: "verify-retained",
      releaseVersion: "1.0.0",
      sourceCommit,
    });
    expect(parseAppSourceProofLauncherArguments(commandCapacityArguments)).toEqual({
      mode: "command-capacity",
      operatorArguments: commandCapacityArguments.slice(1),
      sourceCommit,
    });
    expect(parseAppSourceProofLauncherArguments(quotaUpgradeArguments)).toEqual({
      mode: "quota-upgrade",
      operatorArguments: quotaUpgradeArguments.slice(1),
      sourceCommit,
    });
    for (const invalid of [
      proveArguments.slice(0, -2),
      [...proveArguments, "--unknown", "value"],
      [...proveArguments.slice(0, 7), "1.0.0-beta.1", ...proveArguments.slice(8)],
      [...proveArguments.slice(0, 7), `${"1".repeat(65)}.0.0`, ...proveArguments.slice(8)],
    ]) expect(() => parseAppSourceProofLauncherArguments(invalid)).toThrow("usage_invalid");
  });

  test("keeps hosted operator selection closed and requires one exact source commit", () => {
    for (const mode of ["command-capacity", "quota-upgrade"]) {
      for (const rest of [
        [],
        ["--source-commit"],
        ["--source-commit", "main"],
        ["--source-commit", sourceCommit, "--source-commit", sourceCommit],
      ]) expect(() => parseAppSourceProofLauncherArguments([mode, ...rest])).toThrow("usage_invalid");
      const parsed = parseAppSourceProofLauncherArguments([mode, "status", "--source-commit", sourceCommit]);
      expect(Object.isFrozen(parsed)).toBe(true);
      if (parsed.mode === "command-capacity" || parsed.mode === "quota-upgrade") {
        expect(Object.isFrozen(parsed.operatorArguments)).toBe(true);
      }
    }
    for (const mode of ["operator", "script", "./manage-quota-upgrade.ts", "/untrusted/operator.ts"]) {
      expect(() => parseAppSourceProofLauncherArguments([mode, "--source-commit", sourceCommit]))
        .toThrow("usage_invalid");
    }
  });

  test("passes only a fixed non-provider environment with no hook or proxy input", () => {
    const environment = appSourceProofChildEnvironment();
    expect(Object.keys(environment).sort()).toEqual([
      "GCM_INTERACTIVE",
      "GIT_ATTR_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_NO_REPLACE_OBJECTS",
      "GIT_OPTIONAL_LOCKS",
      "GIT_TERMINAL_PROMPT",
      "LANG",
      "LC_ALL",
      "PATH",
      "SSH_ASKPASS_REQUIRE",
      "TMPDIR",
      "TZ",
    ]);
    expect(environment.GIT_ATTR_NOSYSTEM).toBe("1");
    expect(environment.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(environment.GIT_NO_REPLACE_OBJECTS).toBe("1");
    expect(environment.LANG).toBe("C");
    expect(environment.PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
    expect(environment.TMPDIR).toBe("/tmp");
    for (const name of [
      "BUN_OPTIONS",
      "GH_TOKEN",
      "GIT_ASKPASS",
      "HTTPS_PROXY",
      "NODE_OPTIONS",
      "NPM_TOKEN",
      "SSL_CERT_FILE",
      "VERCEL_TOKEN",
    ]) {
      expect(environment[name]).toBeUndefined();
    }
  });

  test("launches command-capacity only from the sealed exact-commit tree", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(commandCapacityArguments, {
        ...fixture.dependencies,
        runtimeEnvironment: {
          HOME: fixture.root,
          NODE_OPTIONS: undefined,
        },
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(stdout.lines).toEqual(['{"state":"ready"}\n']);
      const child = fixture.events.find((event) =>
        event.includes("/scripts/manage-command-lifecycle-capacity.ts"));
      expect(child).toContain("/hra-app-source-verifier-");
      expect(child).not.toContain(`${fixture.root}/scripts/manage-command-lifecycle-capacity.ts`);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0ls-remote\0"))).toBe(false);
      expect(fixture.events).toContain(`capacity-environment:${JSON.stringify(
        commandCapacityChildEnvironment({ HOME: fixture.root }),
      )}`);
    } finally {
      fixture.cleanup();
    }
  });

  test("headroom diagnosis retains the fixed command-capacity source launcher", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    const args = commandCapacityArguments.map((argument) => argument === "status" ? "diagnose-headroom" : argument);
    try {
      expect(executeAppSourceProofLauncher(args, {
        ...fixture.dependencies,
        runtimeEnvironment: { HOME: fixture.root },
        stderr: stderr.writer, stdout: stdout.writer,
      })).toBe(0);
      const child = fixture.events.find((event) => event.includes("/scripts/manage-command-lifecycle-capacity.ts"));
      expect(child).toContain("diagnose-headroom");
      expect(child).toContain("/hra-app-source-verifier-");
      expect(child).not.toContain(`${fixture.root}/scripts/manage-command-lifecycle-capacity.ts`);
      expect(fixture.events.some((event) => event.includes("--frozen-lockfile"))).toBe(true);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(stderr.lines).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test.each(["status", "diagnose"])("launches quota %s only after frozen installation and every source recheck", (action) => {
    const fixture = launcherFixture({ remoteMain: "7".repeat(40) });
    const stdout = output();
    const stderr = output();
    const runtimeEnvironment = {
      HOME: fixture.root,
      XDG_CONFIG_HOME: join(fixture.root, "config"),
      CONVEX_DEPLOY_KEY: "fixture-secret",
      CONVEX_DEPLOYMENT: "untrusted-target",
      HTTPS_PROXY: "https://untrusted.invalid",
      VERCEL_TOKEN: "fixture-secret",
    };
    try {
      expect(executeAppSourceProofLauncher(quotaUpgradeArguments.map((value) => value === "status" ? action : value), {
        ...fixture.dependencies, runtimeEnvironment, stderr: stderr.writer, stdout: stdout.writer,
      })).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(stdout.lines).toEqual(['{"state":"ready"}\n']);
      const commands = fixture.events.filter((event) => event.startsWith("command:"));
      const install = commands.findIndex((event) => event.includes("\0install\0--frozen-lockfile\0--ignore-scripts\0--backend=copyfile"));
      const child = commands.findIndex((event) => event.includes("/scripts/manage-quota-upgrade.ts\0"));
      const sourceChecks = commands.map((event, index) => event.includes("\0ls-tree\0-r\0-z\0--full-tree") ? index : -1)
        .filter((index) => index >= 0);
      expect(sourceChecks).toHaveLength(4);
      expect(sourceChecks.filter((index) => index < install)).toHaveLength(2);
      expect(sourceChecks.filter((index) => index > install && index < child)).toHaveLength(2);
      expect(commands[child]).toContain("/hra-app-source-verifier-");
      expect(commands[child]).toContain(`/source/scripts/manage-quota-upgrade.ts\0${action}\0--source-commit\0`);
      expect(commands[child]).not.toContain(`${fixture.root}/scripts/manage-quota-upgrade.ts`);
      expect(commands[child]?.endsWith(":none")).toBe(true);
      expect(commands.filter((event) => event.includes(":/trusted/bun\0")).every((event) =>
        event.includes(":/trusted/bun\0--no-env-file\0--config=/dev/null\0"))).toBe(true);
      expect(commands.some((event) => event.includes("\0ls-remote\0"))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      const childEnvironment = commandCapacityChildEnvironment(runtimeEnvironment);
      expect(childEnvironment.HOME).toBe(fixture.root);
      expect(childEnvironment.XDG_CONFIG_HOME).toBe(runtimeEnvironment.XDG_CONFIG_HOME);
      for (const name of ["CONVEX_DEPLOY_KEY", "CONVEX_DEPLOYMENT", "HTTPS_PROXY", "VERCEL_TOKEN"]) {
        expect(childEnvironment[name]).toBeUndefined();
      }
      expect(fixture.events).toContain(`quota-environment:${JSON.stringify(childEnvironment)}`);
      expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0--force"))).toBe(true);
    } finally { fixture.cleanup(); }
  });

  test("quota-upgrade preserves refusal before effects and immutable-source rechecks", () => {
    for (const options of [{ hiddenIndex: true }, { maskedOrigin: true }, { installFails: true }, { sourceChangesDuringInstall: true }]) {
      const fixture = launcherFixture(options);
      const stdout = output();
      const stderr = output();
      try {
        expect(executeAppSourceProofLauncher(quotaUpgradeArguments, {
          ...fixture.dependencies, stderr: stderr.writer, stdout: stdout.writer,
        })).toBe(1);
        expect(stdout.lines).toEqual([]);
        expect(stderr.lines.join("")).toContain(options.installFails === true
          ? '"code":"verifier_install_failed"' : '"code":"verifier_source_invalid"');
        expect(fixture.events.some((event) => event.includes("/scripts/manage-quota-upgrade.ts\0"))).toBe(false);
        expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      } finally { fixture.cleanup(); }
    }
  });

  test("quota-upgrade passes closed operator exit codes and refuses abnormal execution", () => {
    for (const childExitCode of [0, 1, 75, 2]) {
      const fixture = launcherFixture({ childExitCode });
      const stdout = output();
      const stderr = output();
      try {
        expect(executeAppSourceProofLauncher(quotaUpgradeArguments, {
          ...fixture.dependencies, stderr: stderr.writer, stdout: stdout.writer,
        })).toBe(childExitCode === 2 ? 1 : childExitCode);
        expect(stdout.lines).toEqual(childExitCode === 2 ? [] : ['{"state":"ready"}\n']);
        expect(stderr.lines.join("")).toBe(childExitCode === 2
          ? '{"code":"verifier_execution_failed","schemaVersion":1,"status":"refused"}\n' : "");
      } finally { fixture.cleanup(); }
    }
    const fixture = launcherFixture({ childSignal: "SIGTERM" });
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(quotaUpgradeArguments, {
        ...fixture.dependencies, stderr: stderr.writer, stdout: output().writer,
      })).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"verifier_execution_failed"');
    } finally { fixture.cleanup(); }
  });

  test("requires a neutral stage-zero Bun invocation before launcher code runs", () => {
    expect(() => assertHardenedAppSourceProofStageZero(hardenedRuntimeArguments, {}))
      .not.toThrow();
    for (const runtimeArguments of [
      [],
      ["--config=/dev/null"],
      ["--no-env-file"],
      ["--no-env-file", "--config=./bunfig.toml"],
      ["--no-env-file", "--config=/dev/null", "--preload=./ambient.ts"],
      ["--no-env-file", "--config=/dev/null", "--env-file=.env"],
    ]) {
      expect(() => assertHardenedAppSourceProofStageZero(runtimeArguments, {}))
        .toThrow("runtime_environment_unsafe");
    }
    for (const name of appSourceProofRuntimeInjectionEnvironmentNames) {
      expect(() => assertHardenedAppSourceProofStageZero(
        hardenedRuntimeArguments,
        { [name]: "/untrusted/injection" },
      )).toThrow("runtime_environment_unsafe");
    }
    const runbook = readFileSync(join(import.meta.dir, "..", "docs", "hosted-sync.md"), "utf8");
    expect(runbook.match(/command bun --no-env-file --config=\/dev\/null/gu)).toHaveLength(4);
    expect(runbook).toContain(String.raw`run_quota_upgrade() (
  unset BUN_OPTIONS NODE_OPTIONS LD_AUDIT LD_LIBRARY_PATH LD_ORIGIN_PATH LD_PRELOAD \
    DYLD_FALLBACK_FRAMEWORK_PATH DYLD_FALLBACK_LIBRARY_PATH DYLD_FRAMEWORK_PATH \
    DYLD_IMAGE_SUFFIX DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH DYLD_ROOT_PATH \
    DYLD_VERSIONED_FRAMEWORK_PATH DYLD_VERSIONED_LIBRARY_PATH &&
  command bun --no-env-file --config=/dev/null \
    ./scripts/verify-app-source-launcher.ts quota-upgrade "$@"
)`);
    expect(runbook).not.toContain("\nbun ./scripts/verify-app-source-launcher.ts");
    expect(runbook).not.toContain("bun run hosted:command-capacity");
    expect(runbook).not.toContain("bun run hosted:quota-upgrade");
    const packageDocument = readFileSync(join(import.meta.dir, "..", "package.json"), "utf8");
    expect(packageDocument).not.toContain("hosted:command-capacity");
    expect(packageDocument).not.toContain("hosted:quota-upgrade");

    const root = mkdtempSync(join(realpathSync(tmpdir()), "oompa-app-source-stage-zero-"));
    const preload = join(root, "ambient-preload.ts");
    const sentinel = join(root, "ambient-preload-ran");
    try {
      writeFileSync(
        preload,
        `await Bun.write(${JSON.stringify(sentinel)}, "ambient preload executed\\n");\n`,
        { mode: 0o600 },
      );
      writeFileSync(join(root, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
      writeFileSync(join(root, ".env"), "NODE_OPTIONS=--require=/untrusted/from-dotenv.js\n");
      const invocation = spawnSync("/bin/sh", [
        "-c",
        `unset ${appSourceProofRuntimeInjectionEnvironmentNames.join(" ")} && command bun --no-env-file --config=/dev/null ${JSON.stringify(join(import.meta.dir, "verify-app-source-launcher.ts"))} verify-retained`,
      ], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          BUN_OPTIONS: `--preload=${preload}`,
        },
      });
      expect(invocation.status).toBe(1);
      expect(invocation.stdout).toBe("");
      expect(invocation.stderr).toContain('"code":"usage_invalid"');
      expect(() => readFileSync(sentinel)).toThrow();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("refuses a scratch directory selected through an unsafe ambient temporary parent", () => {
    const fixture = launcherFixture();
    const unsafeParent = mkdtempSync(join(trustedScratchRoot, "oompa-app-unsafe-tmpdir-"));
    chmodSync(unsafeParent, 0o777);
    const unsafeScratch = mkdtempSync(join(unsafeParent, "hra-app-source-verifier-"));
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        createScratchDirectory: () => unsafeScratch,
        runtimeEnvironment: { TMPDIR: unsafeParent },
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_install_failed"');
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0worktree\0add\0"))).toBe(false);
    } finally {
      fixture.cleanup();
      rmSync(unsafeParent, { force: true, recursive: true });
    }
  });

  test("the default scratch creator ignores ambient TMPDIR", () => {
    const unsafeParent = mkdtempSync(join(trustedScratchRoot, "oompa-app-ambient-tmpdir-"));
    chmodSync(unsafeParent, 0o777);
    const previous = process.env.TMPDIR;
    let created: string | undefined;
    try {
      process.env.TMPDIR = unsafeParent;
      created = createAppSourceProofScratchDirectory();
      expect(dirname(created)).toBe(trustedScratchRoot);
      expect(dirname(created)).not.toBe(unsafeParent);
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
      if (created !== undefined) rmSync(created, { force: true, recursive: true });
      rmSync(unsafeParent, { force: true, recursive: true });
    }
  });

  test("imports only runtime builtins before creating the sealed verifier tree", () => {
    const source = readFileSync(join(import.meta.dir, "verify-app-source-launcher.ts"), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/gu)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier?.startsWith("node:") === true)).toBe(true);
  });

  test("accepts a real clean repository whose tracked bytes equal the exact commit blobs", () => {
    const fixture = realRepositoryLauncherFixture({ "package.json": trackedDocument });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(fixture.arguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(stdout.lines.join("")).toContain('"schemaVersion":4');
      expect(fixture.events.some((event) => event.startsWith("credential:opened:"))).toBe(true);
      expect(fixture.events.some((event) => event.includes("\0ls-tree\0-r\0-z\0--full-tree")))
        .toBe(true);
      expect(fixture.events.some((event) => event.includes("\0ls-files\0--stage\0-z")))
        .toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("hosted operator recheck uses the real exact-source boundary before and after source changes", () => {
    const fixture = realRepositoryLauncherFixture({
      ".gitattributes": "payload.txt text eol=crlf\n",
      "payload.txt": "canonical\n",
    });
    try {
      const commit = fixture.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
      const expected = { repositoryRoot: fixture.root, sourceCommit: commit };
      expect(() => assertHostedOperatorSource(expected)).not.toThrow();
      expect(fixture.events).toEqual([]);
      rmSync(join(fixture.root, "payload.txt"));
      fixture.git(["checkout", "--", "payload.txt"]);
      expect(fixture.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
      expect(readFileSync(join(fixture.root, "payload.txt"), "utf8")).toBe("canonical\r\n");
      expect(() => assertHostedOperatorSource(expected)).toThrow("verifier_source_invalid");
      expect(fixture.events).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  test("hosted operator recheck refuses invalid identity, origin and hidden index without an execution seam", () => {
    const fixture = realRepositoryLauncherFixture({ "package.json": trackedDocument });
    try {
      const commit = fixture.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
      const expected = { repositoryRoot: fixture.root, sourceCommit: commit };
      for (const invalid of [
        { ...expected, repositoryRoot: "relative" },
        { ...expected, repositoryRoot: `${fixture.root}/..` },
        { ...expected, sourceCommit: "main" },
        { ...expected, sourceCommit },
      ]) expect(() => assertHostedOperatorSource(invalid)).toThrow("verifier_source_invalid");
      fixture.git(["update-index", "--assume-unchanged", "package.json"]);
      expect(() => assertHostedOperatorSource(expected)).toThrow("verifier_source_invalid");
      fixture.git(["update-index", "--no-assume-unchanged", "package.json"]);
      fixture.git(["remote", "set-url", "origin", "https://untrusted.invalid/oompa.git"]);
      expect(() => assertHostedOperatorSource(expected)).toThrow("verifier_source_invalid");
      expect(fixture.events).toEqual([]);
    } finally { fixture.cleanup(); }
  });

  test("captured source retains exact private content without claiming later Git state", () => {
    const fixture = realRepositoryLauncherFixture({ "payload.txt": "canonical\n" });
    try {
      const commit = fixture.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
      const source = captureHostedOperatorSource({ repositoryRoot: fixture.root, sourceCommit: commit });
      expect(Object.keys(source).sort()).toEqual(["assertCapturedContentCurrent", "sourceCommit", "sourceTree"]);
      expect(Object.isFrozen(source)).toBe(true);
      expect(source.sourceCommit).toBe(commit);
      expect(source.sourceTree).toBe(fixture.git(["rev-parse", "--verify", "HEAD^{tree}"]).trim());
      fixture.git(["remote", "set-url", "origin", "https://untrusted.invalid/oompa.git"]);
      fixture.git(["update-index", "--assume-unchanged", "payload.txt"]);
      writeFileSync(join(fixture.root, "untracked.txt"), "later unrelated file\n");
      expect(() => source.assertCapturedContentCurrent()).not.toThrow();
      expect(() => captureHostedOperatorSource({ repositoryRoot: fixture.root, sourceCommit: commit })).toThrow("verifier_source_invalid");
      writeFileSync(join(fixture.root, "payload.txt"), "changed!!\n");
      expect(() => source.assertCapturedContentCurrent()).toThrow("verifier_source_invalid");
    } finally { fixture.cleanup(); }
  });

  test("captured source refuses root replacement and executable-mode drift", () => {
    const fixture = realRepositoryLauncherFixture({ "payload.txt": "canonical\n" });
    const moved = `${fixture.root}-retained`;
    try {
      const source = captureHostedOperatorSource({ repositoryRoot: fixture.root,
        sourceCommit: fixture.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim() });
      chmodSync(join(fixture.root, "payload.txt"), 0o755);
      expect(() => source.assertCapturedContentCurrent()).toThrow("verifier_source_invalid");
      chmodSync(join(fixture.root, "payload.txt"), 0o644);
      renameSync(fixture.root, moved);
      mkdirSync(fixture.root, { mode: 0o700 });
      writeFileSync(join(fixture.root, "payload.txt"), "canonical\n");
      expect(() => source.assertCapturedContentCurrent()).toThrow("verifier_source_invalid");
    } finally { fixture.cleanup(); rmSync(moved, { recursive: true, force: true }); }
  });

  test("captured source checks the named file after descriptor hashing", () => {
    const fixture = realRepositoryLauncherFixture({ "payload.txt": "canonical\n" });
    try {
      const source = captureHostedOperatorSource({ repositoryRoot: fixture.root,
        sourceCommit: fixture.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim() });
      const original = fs.fstatSync;
      let reads = 0;
      function observedStat(descriptor: number, options?: fs.StatOptions & { bigint?: false | undefined }): fs.Stats;
      function observedStat(descriptor: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
      function observedStat(descriptor: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
      function observedStat(descriptor: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
        const value = original(descriptor, options);
        if (++reads === 2) {
          renameSync(join(fixture.root, "payload.txt"), join(fixture.root, "retained.txt"));
          writeFileSync(join(fixture.root, "payload.txt"), "canonical\n", { mode: 0o644 });
        }
        return value;
      }
      const observe = spyOn(fs, "fstatSync").mockImplementation(observedStat);
      try { expect(() => source.assertCapturedContentCurrent()).toThrow("verifier_source_invalid"); }
      finally { observe.mockRestore(); }
      expect(reads).toBe(2);
    } finally { fixture.cleanup(); }
  });

  test("capture rejects oversized tracked content before reading its bytes", () => {
    const fixture = realRepositoryLauncherFixture({ "oversized.txt": "x".repeat(8 * 1024 * 1024 + 1) });
    try {
      const expected = { repositoryRoot: fixture.root,
        sourceCommit: fixture.git(["rev-parse", "--verify", "HEAD^{commit}"]).trim() };
      expect(() => captureHostedOperatorSource(expected)).toThrow("verifier_source_invalid");
    } finally { fixture.cleanup(); }
  });

  test("rejects a real Git-clean smudge-filter checkout before scratch or credential access", () => {
    const fixture = realRepositoryLauncherFixture({
      ".gitattributes": "payload.txt filter=oompa-proof\n",
      "payload.txt": "canonical\n",
    });
    const stdout = output();
    const stderr = output();
    try {
      fixture.git(["config", "filter.oompa-proof.clean", "/usr/bin/sed s/transformed/canonical/g"]);
      fixture.git(["config", "filter.oompa-proof.required", "true"]);
      fixture.git(["config", "filter.oompa-proof.smudge", "/usr/bin/sed s/canonical/transformed/g"]);
      rmSync(join(fixture.root, "payload.txt"));
      fixture.git(["checkout", "--", "payload.txt"]);
      expect(readFileSync(join(fixture.root, "payload.txt"), "utf8")).toBe("transformed\n");
      expect(fixture.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

      expect(executeAppSourceProofLauncher(fixture.arguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
      expect(fixture.events.some((event) => event.startsWith("scratch:"))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("raw-hash rejects a Git-clean attribute-transformed checkout", () => {
    const fixture = realRepositoryLauncherFixture({
      ".gitattributes": "payload.txt text eol=crlf\n",
      "payload.txt": "canonical\n",
    });
    const stdout = output();
    const stderr = output();
    try {
      rmSync(join(fixture.root, "payload.txt"));
      fixture.git(["checkout", "--", "payload.txt"]);
      expect(readFileSync(join(fixture.root, "payload.txt"), "utf8")).toBe("canonical\r\n");
      expect(fixture.git(["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");

      expect(executeAppSourceProofLauncher(fixture.arguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
      expect(fixture.events.some((event) => event.startsWith("scratch:"))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("opens credentials only after source sealing and a second current-main proof", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      const code = executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      });
      expect(code).toBe(0);
      expect(stderr.lines).toEqual([]);
      expect(stdout.lines.join("")).toContain('"schemaVersion":4');
      const opened = fixture.events.findIndex((event) => event.startsWith("credential:opened:"));
      const installed = fixture.events.findIndex((event) => event.includes("\0install\0--frozen-lockfile"));
      const mainReads = fixture.events
        .map((event, index) => event.includes("\0ls-remote\0--heads\0https://github.com/hraness/oompa.git") ? index : -1)
        .filter((index) => index >= 0);
      const child = fixture.events.findIndex((event) => event.includes("/scripts/verify-app-source.ts\0"));
      expect(installed).toBeGreaterThan(-1);
      expect(mainReads).toHaveLength(6);
      expect(mainReads.every((index) => fixture.events[index]?.startsWith("command:/:")))
        .toBe(true);
      expect(fixture.events
        .filter((event) => event.startsWith("command:") && event.includes("/usr/bin/git\0"))
        .every((event) => event.includes("\0core.hooksPath=/dev/null\0")))
        .toBe(true);
      const runtimeCommands = fixture.events.filter((event) =>
        event.includes(":/trusted/bun\0")
      );
      expect(runtimeCommands).toHaveLength(3);
      expect(runtimeCommands.every((event) => event.includes(
        ":/trusted/bun\0--no-env-file\0--config=/dev/null\0",
      ))).toBe(true);
      expect(opened).toBeGreaterThan(mainReads.at(-1) ?? Number.MAX_SAFE_INTEGER);
      expect(child).toBeGreaterThan(opened);
      expect(fixture.events.indexOf("credential:validated")).toBeGreaterThan(opened);
      expect(child).toBeGreaterThan(fixture.events.indexOf("credential:validated"));
      expect(fixture.events).toContain("credential:closed");
      expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0--force"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses hidden-index or stale-main source before scratch or credential access", () => {
    for (const options of [
      { hiddenIndex: true },
      { remoteMain: "7".repeat(40) },
      { maskedOrigin: true },
      { sshOrigin: true },
      { wrongOrigin: true },
    ]) {
      const fixture = launcherFixture(options);
      const stdout = output();
      const stderr = output();
      try {
        expect(executeAppSourceProofLauncher(proveArguments, {
          ...fixture.dependencies,
          stderr: stderr.writer,
          stdout: stdout.writer,
        })).toBe(1);
        expect(stdout.lines).toEqual([]);
        expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
        expect(fixture.events.some((event) => event.startsWith("scratch:"))).toBe(false);
        expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    }
  });

  test("rechecks protected main after installation and before opening credentials", () => {
    const fixture = launcherFixture({ mainAdvancesAfterFirstRead: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"verifier_source_invalid"');
      expect(fixture.events).toContain("scratch:created");
      expect(fixture.events.some((event) => event.includes("\0install\0--frozen-lockfile"))).toBe(true);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0--force"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("joins the fixed credential-free production build before opening auth and refuses build/source failure", () => {
    for (const options of [{}, { buildFails: true }, { sourceChangesDuringBuild: true }, { buildSignal: "SIGTERM" as const }, { buildThrows: true }]) {
      const fixture = launcherFixture(options);
      const stdout = output();
      const stderr = output();
      try {
        const code = executeAppSourceProofLauncher(proveArguments, { ...fixture.dependencies, stdout: stdout.writer, stderr: stderr.writer });
        const built = fixture.events.findIndex((event) => event.endsWith("/scripts/build-app.ts:none"));
        expect(built).toBeGreaterThan(-1);
        const environment = fixture.events.find((event) => event.startsWith("build-environment:"));
        expect(environment).toBe(`build-environment:${JSON.stringify({ ...appSourceProofChildEnvironment(), OOMPA_RELEASE_COMMIT: sourceCommit })}`);
        if (Object.keys(options).length === 0) {
          expect(code).toBe(0);
          expect(fixture.events.findIndex((event) => event.startsWith("credential:opened:"))).toBeGreaterThan(built);
        } else {
          expect(code).toBe(1);
          expect(fixture.events.some((event) => event.startsWith("credential:opened:"))).toBe(false);
          expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0"))).toBe(false);
          expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(false);
          const failure: unknown = JSON.parse(stderr.lines.join(""));
          expect(failure).toMatchObject({ retainedBuild: { directory: expect.stringContaining("hra-app-source-verifier-"), locatorOnly: true } });
          expect(Buffer.byteLength(stderr.lines.join(""))).toBeLessThan(1024);
        }
      } finally { fixture.cleanup(); }
    }
  });

  test("removes a registered scratch worktree after install refusal without opening credentials", () => {
    const fixture = launcherFixture({ installFails: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_install_failed"');
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0worktree\0remove\0--force")))
        .toBe(true);
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("cleans an unregistered partial add without opening credentials", () => {
    const fixture = launcherFixture({ worktreeAddFails: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"verifier_install_failed"');
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("closes a refused credential and cleans before returning", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
        validateCredential: () => { throw new Error("invalid credential identity"); },
      })).toBe(1);
      expect(stderr.lines.join("")).toContain('"code":"provider_credentials_refused"');
      expect(fixture.events).toContain("credential:closed");
      expect(fixture.events.some((event) => event.includes("/scripts/verify-app-source.ts\0")))
        .toBe(false);
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test("refuses cleanup that leaves the exact worktree registered", () => {
    const fixture = launcherFixture({ cleanupLeavesRegistered: true });
    const stdout = output();
    const stderr = output();
    try {
      expect(executeAppSourceProofLauncher(proveArguments, {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      })).toBe(1);
      expect(stdout.lines).toEqual([]);
      expect(stderr.lines.join("")).toContain('"code":"verifier_cleanup_failed"');
      expect(fixture.events.some((event) => event.startsWith("scratch:removed:"))).toBe(false);
      expect(fixture.events).toContain("credential:closed");
    } finally {
      fixture.cleanup();
    }
  });

  test("verifies retained evidence without ever opening a credential", () => {
    const fixture = launcherFixture();
    const stdout = output();
    const stderr = output();
    try {
      const code = executeAppSourceProofLauncher([
        "verify-retained",
        "--evidence-path",
        evidencePath,
        "--release-version",
        releaseVersion,
        "--source-commit",
        sourceCommit,
      ], {
        ...fixture.dependencies,
        stderr: stderr.writer,
        stdout: stdout.writer,
      });
      expect(code).toBe(0);
      expect(fixture.events.some((event) => event.startsWith("credential:"))).toBe(false);
      expect(fixture.events.some((event) => event.includes("\0--verify-retained\0"))).toBe(true);
      expect(fixture.events.some((event) => event.includes("/scripts/build-app.ts"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test("keeps launcher refusal codes closed", () => {
    expect(new Set(appSourceProofLauncherErrorCodes).size)
      .toBe(appSourceProofLauncherErrorCodes.length);
  });
});
