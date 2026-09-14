import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { createNativeProcessArchive } from "./native-process-archive.ts";
import { nativeBuildInput, nativeInputHash } from "./native-process-build-inputs.ts";
import { admitNativeProcessDependency } from "./native-process-dependency.ts";
import { assertNativeInstalledLock, inspectNativeInstalledDependency, nativeInstalledBunArguments,
  nativeInstalledPackageJson } from "./native-process-installed-model.ts";
import { inspectNativeInstalledTree } from "./native-process-installed.ts";

/** Scheduled installer-only fixture. The synthetic package contains no native
 * executable, and no installed package module or lifecycle script is executed. */
async function main(): Promise<void> {
  const [dependencyPath, output, extra] = process.argv.slice(2);
  if (dependencyPath === undefined || output === undefined || extra !== undefined || Bun.version !== "1.3.14"
    || output !== resolve(output) || realpathSync(dirname(output)) !== dirname(output)) throw Error("INSTALL_FIXTURE_INPUT");
  const dependency = nativeBuildInput(dependencyPath, 16 * 1024 * 1024);
  admitNativeProcessDependency(Bun.JSONC.parse(readFileSync(join(import.meta.dir, "../bun.lock"), "utf8")), dependency);
  const dependencyFiles = inspectNativeInstalledDependency(dependency);
  const client = [
    { path: "package/package.json", mode: 0o644 as const, bytes: Buffer.from(JSON.stringify({ name: "@hraness/native-process",
      version: "0.1.0", type: "module", exports: "./index.ts", dependencies: { zod: "4.4.3" } })) },
    { path: "package/index.ts", mode: 0o644 as const, bytes: Buffer.from('throw Error("SYNTHETIC_PACKAGE_MUST_NOT_EXECUTE");\n') },
  ];
  mkdirSync(output, { mode: 0o700 });
  const identity = lstatSync(output, { bigint: true });
  if (identity.uid !== BigInt(process.getuid?.() ?? -1) || (identity.mode & 0o7777n) !== 0o700n) throw Error("INSTALL_FIXTURE_OWNER");
  for (const name of ["home", "temporary", "cache"]) mkdirSync(join(output, name), { mode: 0o700 });
  for (const [name, bytes] of [["native.tgz", createNativeProcessArchive(client)], ["zod.tgz", dependency],
    ["package.json", Buffer.from(JSON.stringify(nativeInstalledPackageJson()))], ["bunfig.toml", Buffer.from("[install]\nexact = true\n")]] as const) {
    writeFileSync(join(output, name), bytes, { flag: "wx", mode: 0o400 }); chmodSync(join(output, name), 0o400);
  }
  const fixed = ["native.tgz", "zod.tgz", "package.json", "bunfig.toml"].map(name => ({ path: join(output, name),
    sha256: nativeInputHash(nativeBuildInput(join(output, name), 16 * 1024 * 1024)) }));
  const { requireBoundedProcessCleanup, runBoundedProcess } = await import("./bounded-process.ts");
  for (const phase of ["resolve", "install"] as const) {
    const result = requireBoundedProcessCleanup(await runBoundedProcess({ executable: realpathSync(process.execPath),
      arguments: [...nativeInstalledBunArguments(output), phase === "resolve" ? "--lockfile-only" : "--frozen-lockfile"],
      cwd: output, environment: { HOME: join(output, "home"), TMPDIR: join(output, "temporary"),
        PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" }, containment: "local", phase: "native-install-fixture-" + phase,
      timeoutMs: 30_000, terminationGraceMs: 250, killSettlementMs: 3000, outputMaximumBytes: 64 * 1024,
    }, { recoveryDirectory: join(output, "recovery-" + phase) }));
    if (result.exitCode !== 0) throw Error("INSTALL_FIXTURE_CHILD_FAILED");
    for (const file of fixed) if (file.sha256 !== nativeInputHash(nativeBuildInput(file.path, 16 * 1024 * 1024))) throw Error("INSTALL_FIXTURE_CHANGED");
    assertNativeInstalledLock(Bun.JSONC.parse(readFileSync(join(output, "bun.lock"), "utf8")));
  }
  const installed = inspectNativeInstalledTree(join(output, "node_modules"), [
    ...client.map(file => ({ path: "@hraness/native-process/" + file.path.slice(8), bytes: file.bytes, mode: file.mode })),
    ...dependencyFiles.map(file => ({ path: "zod/" + file.path, bytes: file.bytes, mode: file.mode })),
  ]);
  if (!isDeepStrictEqual(identity, lstatSync(output, { bigint: true }))) {
    const current = lstatSync(output, { bigint: true });
    if (current.ino !== identity.ino || current.dev !== identity.dev || current.mode !== identity.mode || current.uid !== identity.uid) throw Error("INSTALL_FIXTURE_CHANGED");
  }
  console.log(JSON.stringify({ status: "passed", synthetic: true, installedFiles: installed.length,
    nativeExecution: false, lifecycleScripts: false, lockSha256: nativeInputHash(nativeBuildInput(join(output, "bun.lock"), 64 * 1024)) }));
}
if (import.meta.main) await main();
