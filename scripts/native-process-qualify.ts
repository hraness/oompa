import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, realpathSync, rmSync, writeFileSync, type BigIntStats } from "node:fs";
import { homedir, release } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertNativeExecutableHeader, NATIVE_ARTIFACT_TARGETS, NATIVE_QUALIFICATION_PROFILE,
  NATIVE_QUALIFICATION_VERSION, nativeArtifactTarget, type NativeArtifactTarget } from "../packages/native-process/src/artifact-model.ts";
import { requireBoundedProcessCleanup, runBoundedProcess } from "./bounded-process.ts";
import { assertNativeCargoConfigurationAbsent, nativeBuildInput, nativeInputHash,
  nativeProcessSourceInventory } from "./native-process-build-inputs.ts";
import { NATIVE_QUALIFICATION_HARNESS_FILES, NATIVE_TRANSPORT_CASES,
  parseNativeQualification, type NativeQualification } from "./native-process-qualification-model.ts";
import { collectNativeProcessLicenses } from "./native-process-licenses.ts";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kernel = join(repository, "native/process-kernel");
const maxExecutable = 32 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
type Suite = Readonly<{ passed: number; failed: 0; ignored: 0 }>;
type Harnesses = Readonly<{ unit: string; native: string; fixture: string }>;
type Snapshot = Readonly<{ path: string; metadata: BigIntStats; bytes: number; sha256: string }>;

function refuse(reason: string): never { throw Error(`NATIVE_PROCESS_QUALIFY_${reason}`); }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse("TOOL_OUTPUT_INVALID");
  return value as Record<string, unknown>;
}
function exactText(bytes: Uint8Array, maximum: number): string {
  if (bytes.byteLength > maximum) refuse("TOOL_OUTPUT_BOUND");
  return utf8.decode(bytes);
}
function same(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid
    && left.mode === right.mode && left.size === right.size && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function exactPath(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0") || Buffer.byteLength(path) > 4096) refuse("PATH_INVALID");
  return path;
}

/** Only exact, unfiltered libtest summaries and named successful cases count. */
export function parseNativeSuite(bytes: Uint8Array, expected: 6 | 20): Suite {
  const text = exactText(bytes, 1024 * 1024);
  const lines = text.trim().split(/\r?\n/u).filter(line => line !== "");
  if (lines.shift() !== `running ${expected} tests`) refuse("SUITE_INCOMPLETE");
  const summary = lines.pop();
  const match = summary?.match(/^test result: ok\. ([0-9]+) passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in [0-9]+(?:\.[0-9]+)?s$/u);
  if (match?.[1] !== String(expected) || lines.length !== expected) refuse("SUITE_INCOMPLETE");
  const names = new Set<string>();
  for (const line of lines) {
    const name = /^test ([a-zA-Z0-9_:]+) \.\.\. ok$/u.exec(line)?.[1];
    if (name === undefined || names.has(name)) refuse("SUITE_INCOMPLETE");
    names.add(name);
  }
  return Object.freeze({ passed: expected, failed: 0, ignored: 0 });
}

/** Cargo's JSON is only a locator. Files are read into private images before use. */
export function parseNativeHarnesses(bytes: Uint8Array, crate: string, targetDirectory: string): Harnesses {
  const lines = exactText(bytes, 8 * 1024 * 1024).trim().split(/\r?\n/u);
  if (lines.length > 4096) refuse("TOOL_OUTPUT_BOUND");
  const selected: Partial<Record<keyof Harnesses, string>> = {};
  let finished = false;
  for (const line of lines) {
    const value = record(JSON.parse(line) as unknown);
    if (finished) refuse("TOOL_OUTPUT_INVALID");
    if (value.reason === "build-finished") {
      if (value.success !== true) refuse("BUILD_FAILED");
      finished = true;
      continue;
    }
    if (value.reason !== "compiler-artifact") continue;
    if (value.manifest_path !== join(crate, "Cargo.toml")) continue;
    const target = record(value.target), profile = record(value.profile);
    let key: keyof Harnesses | undefined;
    if (target.name === "oompa-process-kernel" && profile.test === true
      && target.src_path === join(crate, "src/main.rs") && JSON.stringify(target.kind) === '["bin"]') key = "unit";
    if (target.name === "native" && profile.test === true
      && target.src_path === join(crate, "tests/native.rs") && JSON.stringify(target.kind) === '["test"]') key = "native";
    if (target.name === "process-kernel-fixture" && profile.test === false
      && target.src_path === join(crate, "tests/fixture.rs") && JSON.stringify(target.kind) === '["bin"]') key = "fixture";
    if (key === undefined) continue;
    if (typeof value.executable !== "string" || selected[key] !== undefined) refuse("HARNESS_INVALID");
    const path = exactPath(value.executable), child = relative(targetDirectory, path);
    if (child === "" || child.startsWith("../") || isAbsolute(child)) refuse("HARNESS_INVALID");
    selected[key] = path;
  }
  if (!finished || selected.unit === undefined || selected.native === undefined || selected.fixture === undefined
    || new Set(Object.values(selected)).size !== 3) refuse("HARNESS_INCOMPLETE");
  return Object.freeze({ unit: selected.unit, native: selected.native, fixture: selected.fixture });
}

export function nativeQualificationEnvironment(input: Readonly<{
  home: string; cargoHome: string; rustupHome?: string; temporary: string; targetDirectory: string;
  toolDirectory: string; rustc: string; target: NativeArtifactTarget; linker: string; sdkRoot?: string;
}>): Readonly<Record<string, string>> {
  for (const value of [input.home, input.cargoHome, input.temporary,
    input.targetDirectory, input.toolDirectory, input.rustc, input.linker]) exactPath(value);
  if (input.rustupHome !== undefined) exactPath(input.rustupHome);
  if (input.target.startsWith("darwin-")) {
    if (input.sdkRoot === undefined) refuse("SDK_REQUIRED");
    exactPath(input.sdkRoot);
  } else if (input.sdkRoot !== undefined) refuse("SDK_UNEXPECTED");
  if (input.linker.includes("\u001f")) refuse("LINKER_INVALID");
  return Object.freeze({ HOME: input.home, CARGO_HOME: input.cargoHome,
    ...(input.rustupHome === undefined ? {} : { RUSTUP_HOME: input.rustupHome }),
    TMPDIR: input.temporary, TMP: input.temporary, TEMP: input.temporary,
    PATH: `${input.toolDirectory}:/usr/bin:/bin:/usr/sbin:/sbin`, RUSTC: input.rustc,
    RUSTUP_TOOLCHAIN: "1.97.1", CARGO_TARGET_DIR: input.targetDirectory, CARGO_NET_OFFLINE: "true",
    // Cargo's encoded form preserves one linker value even with path spaces.
    CARGO_ENCODED_RUSTFLAGS: `-C\u001flinker=${input.linker}`,
    CARGO_TERM_COLOR: "never", LC_ALL: "C", LANG: "C",
    ...(input.sdkRoot === undefined ? {} : { MACOSX_DEPLOYMENT_TARGET: "11.0", SDKROOT: input.sdkRoot }),
  });
}

export function parseNativeCompiler(rustc: Uint8Array, cargo: Uint8Array, target: NativeArtifactTarget): Readonly<{
  rustcVerboseVersion: string; cargoVersion: string;
}> {
  const rustcVerboseVersion = exactText(rustc, 4096).trim();
  const cargoVersion = exactText(cargo, 256).trim();
  const host = /^host: ([a-zA-Z0-9_-]+)$/mu.exec(rustcVerboseVersion)?.[1];
  const architecture = target.endsWith("arm64") ? "aarch64" : "x86_64";
  if (!/^rustc 1\.97\.1 \([^\r\n]+\)\n/u.test(rustcVerboseVersion)
    || !/^release: 1\.97\.1$/mu.test(rustcVerboseVersion)
    || !/^cargo 1\.97\.1 \([^\r\n]+\)$/u.test(cargoVersion)
    || host === undefined || !host.startsWith(architecture + "-")
    || (target.startsWith("darwin-") ? !host.endsWith("-apple-darwin") : !host.includes("-linux-"))) refuse("TOOLCHAIN_MISMATCH");
  return Object.freeze({ rustcVerboseVersion, cargoVersion });
}

export function parseNativeLinkerVersion(bytes: Uint8Array): string {
  // clang's remaining lines include its installation path. The exact executable
  // digest plus its version banner identifies it without publishing that path.
  const banner = exactText(bytes, 4096).split(/\r?\n/u)[0];
  if (banner === undefined || banner.length < 1 || banner.length > 512 || !/^[\x20-\x7e]+$/u.test(banner)
    || /[/\\]/u.test(banner)) refuse("LINKER_INVALID");
  return banner;
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privateDirectory(path: string): BigIntStats {
  if (realpathSync(path) !== exactPath(path)) refuse("DIRECTORY_INVALID");
  const metadata = lstatSync(path, { bigint: true });
  if (!metadata.isDirectory() || process.getuid === undefined || metadata.uid !== BigInt(process.getuid())
    || (metadata.mode & 0o7777n) !== 0o700n) refuse("DIRECTORY_INVALID");
  return metadata;
}
function safeOutputAncestors(path: string): void {
  for (let current = path;; current = dirname(current)) {
    const metadata = lstatSync(current, { bigint: true });
    if (process.getuid === undefined || !metadata.isDirectory() || realpathSync(current) !== current
      || (metadata.uid !== 0n && metadata.uid !== BigInt(process.getuid()))
      || ((metadata.mode & 0o022n) !== 0n && !(metadata.uid === 0n && (metadata.mode & 0o1000n) !== 0n))) refuse("OUTPUT_PATH_INVALID");
    if (dirname(current) === current) return;
  }
}
function writeOwned(path: string, bytes: Uint8Array, mode: 0o400 | 0o500): Snapshot {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const metadata = lstatSync(path, { bigint: true });
  if ((metadata.mode & 0o7777n) !== BigInt(mode) || metadata.nlink !== 1n) refuse("SNAPSHOT_INVALID");
  return Object.freeze({ path, metadata, bytes: bytes.byteLength, sha256: nativeInputHash(bytes) });
}
function assertSnapshot(snapshot: Snapshot): void {
  if (!same(snapshot.metadata, lstatSync(snapshot.path, { bigint: true }))
    || nativeInputHash(nativeBuildInput(snapshot.path, Math.max(1, snapshot.bytes))) !== snapshot.sha256) refuse("SNAPSHOT_CHANGED");
}
function productionHeader(snapshot: Snapshot, target: NativeArtifactTarget): void {
  assertNativeExecutableHeader(nativeBuildInput(snapshot.path, maxExecutable), {
    target, rustTarget: NATIVE_ARTIFACT_TARGETS[target], scope: "posix-process-group", bytes: snapshot.bytes,
    sha256: snapshot.sha256, qualificationProfile: NATIVE_QUALIFICATION_PROFILE,
    qualificationVersion: NATIVE_QUALIFICATION_VERSION, qualificationSha256: "0".repeat(64),
  });
}

/** A fresh directory is the only caller-selected input. No build, fixture,
 * executable, target or environment override is exposed by this command. */
export async function qualifyNativeProcess(outputDirectory: string): Promise<NativeQualification> {
  const output = exactPath(resolve(outputDirectory));
  const parent = realpathSync(dirname(output));
  if (dirname(output) !== parent || output === repository || output.startsWith(repository + "/")) refuse("OUTPUT_PATH_INVALID");
  safeOutputAncestors(parent);
  if (Bun.version !== "1.3.14") refuse("BUN_VERSION");
  const target = nativeArtifactTarget(process.platform, process.arch);
  if (target === null || process.getuid === undefined) refuse("TARGET_UNSUPPORTED");
  mkdirSync(output, { mode: 0o700 }); // Existing names are never reused or removed.
  const outputIdentity = privateDirectory(output);
  const work = realpathSync(mkdtempSync(join(parent, ".native-process-qualify-")));
  const workIdentity = privateDirectory(work);
  const targetDirectory = join(work, "target"), temporary = join(work, "temporary"), images = join(work, "images");
  for (const path of [targetDirectory, temporary, images]) mkdirSync(path, { mode: 0o700 });
  const home = realpathSync(homedir());
  const cargoHome = realpathSync(resolve(process.env.CARGO_HOME ?? join(home, ".cargo")));
  const selectedCargo = Bun.which("cargo"), selectedRustc = Bun.which("rustc"), selectedGit = Bun.which("git");
  if (selectedCargo === null || selectedRustc === null || selectedGit === null) refuse("TOOLS_UNAVAILABLE");
  const git = realpathSync(selectedGit);
  let cargo = realpathSync(selectedCargo), rustc = realpathSync(selectedRustc);
  const proxy = basename(cargo) === "rustup" || basename(rustc) === "rustup";
  const rustupHome = proxy ? realpathSync(resolve(process.env.RUSTUP_HOME ?? join(home, ".rustup"))) : undefined;
  let sequence = 0;
  const snapshots: Snapshot[] = [];
  const assertImages = (): void => {
    const current = privateDirectory(work);
    if (current.dev !== workIdentity.dev || current.ino !== workIdentity.ino) refuse("DIRECTORY_CHANGED");
    for (const snapshot of snapshots) assertSnapshot(snapshot);
  };
  const run = async (executable: string, args: readonly string[], environment: Readonly<Record<string, string>>,
    phase: string, timeoutMs = 30_000, maximum = 1024 * 1024) => {
    assertImages();
    const result = requireBoundedProcessCleanup(await runBoundedProcess({
      executable: exactPath(executable), arguments: args, environment, cwd: kernel,
      containment: "local", phase: `native-qualify-${phase}`, timeoutMs,
      terminationGraceMs: 250, killSettlementMs: 3000, outputMaximumBytes: maximum,
    }, { recoveryDirectory: join(work, `recovery-${++sequence}`) }));
    assertImages();
    if (result.exitCode !== 0) refuse(`CHILD_FAILED_${phase.toUpperCase().replaceAll("-", "_")}`);
    return result;
  };
  // Never delete images after any failure: a failed native harness may have
  // created its own groups, beyond the local tool child's cleanup scope.
  const discovery = Object.freeze({ HOME: home, CARGO_HOME: cargoHome,
    ...(rustupHome === undefined ? {} : { RUSTUP_HOME: rustupHome }),
    RUSTUP_TOOLCHAIN: "1.97.1", PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: temporary, LC_ALL: "C", LANG: "C" });
  assertNativeCargoConfigurationAbsent(kernel, cargoHome);
  const before = nativeProcessSourceInventory(repository);
  const commit = exactText((await run(git, ["-C", repository, "rev-parse", "HEAD"], discovery, "source-commit")).stdout, 128).trim();
  if (!/^[a-f0-9]{40}$/u.test(commit)) refuse("COMMIT_INVALID");
  if (proxy) {
    // Resolve a selected rustup proxy without downloading a toolchain. Direct
    // pinned installations (including Homebrew) need no rustup installation.
    if (cargo !== rustc || rustupHome === undefined) refuse("TOOLCHAIN_MISMATCH");
    const rustup = cargo;
    const tool = async (name: "cargo" | "rustc"): Promise<string> => {
      const result = await run(rustup, ["which", "--toolchain", "1.97.1", name], discovery, `locate-${name}`);
      const path = exactPath(exactText(result.stdout, 4096).trim());
      if (realpathSync(path) !== path || !path.startsWith(join(rustupHome, "toolchains") + "/")
        || !path.endsWith(`/bin/${name}`) || !lstatSync(path).isFile()) refuse("TOOL_PATH_INVALID");
      return path;
    };
    cargo = await tool("cargo"); rustc = await tool("rustc");
  }
  if (dirname(cargo) !== dirname(rustc)) refuse("TOOLCHAIN_MISMATCH");
  const bunExecutable = realpathSync(process.execPath);
  const toolInputs = [cargo, rustc, bunExecutable].map(path => ({ path, metadata: lstatSync(path, { bigint: true }),
    sha256: nativeInputHash(nativeBuildInput(path, 512 * 1024 * 1024)) }));
  const assertTools = (): void => {
    for (const input of toolInputs) {
      if (!same(input.metadata, lstatSync(input.path, { bigint: true }))
        || nativeInputHash(nativeBuildInput(input.path, 512 * 1024 * 1024)) !== input.sha256) refuse("TOOLCHAIN_CHANGED");
    }
  };
  const rustTarget = NATIVE_ARTIFACT_TARGETS[target];
  let linker: string, sdkRoot: string | undefined;
  let sdk: NativeQualification["compiler"]["sdk"];
  if (target.startsWith("darwin-")) {
    const xcrun = async (argument: string): Promise<string> => exactText((await run("/usr/bin/xcrun",
      ["--sdk", "macosx", argument], discovery, "sdk-observe")).stdout, 4096).trim();
    linker = realpathSync(exactText((await run("/usr/bin/xcrun", ["--sdk", "macosx", "--find", "clang"],
      discovery, "linker-select")).stdout, 4096).trim());
    sdkRoot = realpathSync(await xcrun("--show-sdk-path"));
    sdk = { kind: "macos", version: await xcrun("--show-sdk-version"), buildVersion: await xcrun("--show-sdk-build-version") };
    // This hardware feature remains true under Rosetta. Cross/emulated runners
    // may build artifacts, but cannot qualify their architecture here.
    const hardware = exactText((await run("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], discovery, "host-architecture")).stdout, 16).trim();
    if (hardware !== (target === "darwin-arm64" ? "1" : "0")) refuse("HOST_ARCHITECTURE");
  } else {
    const selected = Bun.which("cc", { PATH: "/usr/bin:/bin" });
    if (selected === null) refuse("LINKER_UNAVAILABLE");
    linker = realpathSync(selected);
    sdk = { kind: "static-musl", target: rustTarget };
    const machine = exactText((await run("/usr/bin/uname", ["-m"], discovery, "host-architecture")).stdout, 128).trim();
    if (machine !== (target === "linux-arm64" ? "aarch64" : "x86_64")) refuse("HOST_ARCHITECTURE");
  }
  const linkerHash = (): string => nativeInputHash(nativeBuildInput(linker, 512 * 1024 * 1024));
  const linkerSha256 = linkerHash();
  const linkerVersion = parseNativeLinkerVersion((await run(linker, ["--version"], discovery, "linker-version", 30_000, 4096)).stdout);
  const environment = nativeQualificationEnvironment({ home, cargoHome, ...(rustupHome === undefined ? {} : { rustupHome }), temporary, targetDirectory,
    toolDirectory: dirname(cargo), rustc, target, linker, ...(sdkRoot === undefined ? {} : { sdkRoot }) });
  const compiler = parseNativeCompiler((await run(rustc, ["-Vv"], environment, "rustc-version")).stdout,
    (await run(cargo, ["--version"], environment, "cargo-version")).stdout, target);
  const sysroot = realpathSync(exactText((await run(rustc, ["--print", "sysroot"], environment, "sysroot")).stdout, 4096).trim());
  if (!lstatSync(sysroot).isDirectory()) refuse("SYSROOT_INVALID");
  const options = ["--release", "--target", rustTarget, "--locked", "--offline", "--manifest-path", join(kernel, "Cargo.toml")];
  await run(cargo, ["build", ...options, "--bin", "oompa-process-kernel"], environment, "build", 180_000, 8 * 1024 * 1024);
  const helper = writeOwned(join(images, "oompa-process-kernel"),
    nativeBuildInput(join(targetDirectory, rustTarget, "release/oompa-process-kernel"), maxExecutable), 0o500);
  productionHeader(helper, target); snapshots.push(helper); syncDirectory(images);
  const compiled = await run(cargo, ["test", ...options, "--features", "native-fixtures", "--bin", "oompa-process-kernel",
    "--test", "native", "--no-run", "--message-format=json"], environment, "build-tests", 180_000, 8 * 1024 * 1024);
  const harnesses = parseNativeHarnesses(compiled.stdout, kernel, join(targetDirectory, rustTarget));
  const fixture = writeOwned(join(images, "process-kernel-fixture"), nativeBuildInput(harnesses.fixture, maxExecutable), 0o500);
  const unit = writeOwned(join(images, "unit-harness"), nativeBuildInput(harnesses.unit, maxExecutable), 0o500);
  const native = writeOwned(join(images, "native-harness"), nativeBuildInput(harnesses.native, maxExecutable), 0o500);
  snapshots.push(fixture, unit, native); syncDirectory(images);
  assertNativeCargoConfigurationAbsent(kernel, cargoHome);
  if (JSON.stringify(nativeProcessSourceInventory(repository)) !== JSON.stringify(before)) refuse("SOURCE_CHANGED");
  const testEnvironment = Object.freeze({ PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: temporary, LC_ALL: "C", LANG: "C",
    NATIVE_PROCESS_QUALIFICATION_HELPER: helper.path, NATIVE_PROCESS_QUALIFICATION_FIXTURE: fixture.path });
  const unitResult = parseNativeSuite((await run(unit.path, ["--test-threads=1", "--color=never"], testEnvironment, "unit", 60_000)).stdout, 6);
  const nativeResult = parseNativeSuite((await run(native.path, ["--test-threads=1", "--color=never"], testEnvironment, "native", 120_000)).stdout, 20);
  await run(cargo, ["clippy", ...options, "--features", "native-fixtures", "--all-targets", "--", "-D", "warnings"],
    environment, "clippy", 180_000, 8 * 1024 * 1024);
  const config = writeOwned(join(work, "bunfig.toml"), Buffer.from("# Private qualification config.\n"), 0o400);
  const importer = (path: string): string => JSON.stringify(pathToFileURL(join(repository, path)).href);
  const worker = writeOwned(join(work, "transport.ts"), Buffer.from([
    `import { verifyNativeTransport } from ${importer("native/process-kernel/verify-transport.ts")};`,
    `import { NativeProcessTransport } from ${importer("packages/native-process/src/transport.ts")};`,
    `import { observeNativeHost, observeNativeScopes } from ${importer("packages/native-process/src/observer.ts")};`,
    `import { nativePreparedOfReady } from ${importer("packages/native-process/src/identity.ts")};`,
    `import { nativeScopeIsAbsent } from ${importer("packages/native-process/src/observation-protocol.ts")};`,
    'if (Bun.version !== "1.3.14") throw Error("NATIVE_PROCESS_QUALIFY_BUN_VERSION");',
    `const result = await verifyNativeTransport({ helperExecutable: () => ${JSON.stringify(helper.path)},`,
    `fixtureExecutable: ${JSON.stringify(fixture.path)}, cwd: ${JSON.stringify(temporary)},`,
    "port: { create: options => new NativeProcessTransport(options), host: observeNativeHost, scopes: observeNativeScopes,",
    "preparedOfReady: nativePreparedOfReady, scopeIsAbsent: nativeScopeIsAbsent } });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n")), 0o400);
  snapshots.push(config, worker); syncDirectory(work);
  const transport = record(JSON.parse(exactText((await run(bunExecutable,
    ["--no-env-file", "--no-install", "--no-macros", "--no-addons", `--config=${config.path}`, worker.path],
    testEnvironment, "transport", 90_000, 64 * 1024)).stdout, 64 * 1024)) as unknown);
  if (Object.keys(transport).sort().join(",") !== "cases,fixtureSha256,helperSha256,platform,status"
    || transport.status !== "passed" || transport.platform !== process.platform
    || transport.helperSha256 !== helper.sha256 || transport.fixtureSha256 !== fixture.sha256
    || JSON.stringify(transport.cases) !== JSON.stringify(NATIVE_TRANSPORT_CASES)) refuse("TRANSPORT_INCOMPLETE");
  const metadata = JSON.parse(exactText((await run(cargo, ["metadata", "--format-version=1", "--locked", "--offline",
    "--filter-platform", rustTarget, "--manifest-path", join(kernel, "Cargo.toml")],
    environment, "license-metadata", 60_000, 8 * 1024 * 1024)).stdout, 8 * 1024 * 1024)) as unknown;
  const licenses = collectNativeProcessLicenses(metadata, { kernelDirectory: kernel, toolchainRoot: sysroot,
    target, outputDirectory: join(output, "licenses") });
  for (const file of [{ path: "manifest.json", bytes: 256 * 1024, sha256: licenses.manifestSha256 },
    ...licenses.manifest.crates.flatMap(crate => crate.files)]) {
    const path = join(output, "licenses", file.path), contents = nativeBuildInput(path, file.bytes);
    if (nativeInputHash(contents) !== file.sha256) refuse("LICENSE_CHANGED");
    snapshots.push({ path, metadata: lstatSync(path, { bigint: true }), bytes: contents.length, sha256: file.sha256 });
  }
  assertImages(); assertTools(); assertNativeCargoConfigurationAbsent(kernel, cargoHome);
  if (JSON.stringify(nativeProcessSourceInventory(repository)) !== JSON.stringify(before)) refuse("SOURCE_CHANGED");
  const currentCommit = exactText((await run(git, ["-C", repository, "rev-parse", "HEAD"], discovery, "source-final")).stdout, 128).trim();
  if (currentCommit !== commit || JSON.stringify(nativeProcessSourceInventory(repository)) !== JSON.stringify(before)) refuse("SOURCE_CHANGED");
  if (linkerHash() !== linkerSha256) refuse("LINKER_CHANGED");
  const inputHash = (path: string): string => {
    const item = before.find(entry => entry.path === path);
    if (item === undefined) refuse("SOURCE_INCOMPLETE");
    return item.sha256;
  };
  if (licenses.cargoLockSha256 !== inputHash("native/process-kernel/Cargo.lock")) refuse("LICENSE_SOURCE_CHANGED");
  const qualification = parseNativeQualification({ formatVersion: 1, phase: "prepack-native",
    profile: NATIVE_QUALIFICATION_PROFILE, profileVersion: NATIVE_QUALIFICATION_VERSION,
    source: { commitSha: commit, treeSha256: nativeInputHash(Buffer.from(JSON.stringify(before))),
      bunLockSha256: inputHash("bun.lock"), cargoLockSha256: inputHash("native/process-kernel/Cargo.lock"),
      toolchainSha256: inputHash("native/process-kernel/rust-toolchain.toml"), rustVersion: "1.97.1", bunVersion: "1.3.14", profile: "release" },
    target, rustTarget, licensesSha256: licenses.manifestSha256, artifact: { bytes: helper.bytes, sha256: helper.sha256 },
    harnesses: { unit: { bytes: unit.bytes, sha256: unit.sha256 }, native: { bytes: native.bytes, sha256: native.sha256 },
      fixture: { bytes: fixture.bytes, sha256: fixture.sha256 } },
    compiler: { ...compiler, bunVersion: "1.3.14", deploymentTarget: target.startsWith("darwin-") ? "11.0" : "static-musl",
      environmentPolicy: "native-process-build-env-v1", linker: { sha256: linkerSha256, version: linkerVersion }, sdk,
      host: { architecture: target.endsWith("arm64") ? "arm64" : "x64", osRelease: release() } },
    checks: { clippy: "passed", unit: unitResult, native: nativeResult, transport: NATIVE_TRANSPORT_CASES },
  });
  const currentOutput = privateDirectory(output);
  if (currentOutput.dev !== outputIdentity.dev || currentOutput.ino !== outputIdentity.ino) refuse("DIRECTORY_CHANGED");
  assertImages();
  snapshots.push(writeOwned(join(output, "oompa-process-kernel"), nativeBuildInput(helper.path, maxExecutable), 0o500));
  // Preserve the exact executed images for the independent installed-archive
  // gate. The package assembler never places these testing inputs in a tarball.
  const harnessImages = { unit, native, fixture };
  for (const name of ["unit", "native", "fixture"] as const) {
    const original = harnessImages[name];
    snapshots.push(writeOwned(join(output, NATIVE_QUALIFICATION_HARNESS_FILES[name]),
      nativeBuildInput(original.path, maxExecutable), 0o500));
  }
  // This completion record is written last; an artifact without it is incomplete.
  writeOwned(join(output, "qualification.json"), Buffer.from(JSON.stringify(qualification) + "\n"), 0o400);
  syncDirectory(output);
  assertImages();
  rmSync(work, { recursive: true });
  syncDirectory(parent);
  return qualification;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] === undefined || args[0].startsWith("-")) refuse("ARGUMENTS");
  await qualifyNativeProcess(args[0]);
  console.log("Native process prepack qualification passed.");
}
