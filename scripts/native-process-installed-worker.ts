import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as nativeProcess from "@hraness/native-process";
import { resolveInstalledNativeArtifact, nativeArtifactExecutable, nativeArtifactIdentity } from "@hraness/native-process/artifact-resolver";
import { NativeProcessTransport } from "@hraness/native-process/transport";
import { observeNativeHost, observeNativeScopes } from "@hraness/native-process/observer";
import { nativePreparedOfReady } from "@hraness/native-process/identity";
import { nativeScopeIsAbsent } from "@hraness/native-process/observation-protocol";
import { verifyNativeTransport } from "../native/process-kernel/verify-transport.ts";

/** Copied unchanged into the fresh installation only after archive admission.
 * All process mechanisms here resolve through that installation's package. */
async function main(): Promise<void> {
  const [mode, manifestSha256, fixture] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
  assert(mode === "admit" || mode === "transport");
  assert(typeof manifestSha256 === "string" && typeof fixture === "string");
  assert.match(manifestSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Bun.version, "1.3.14");
  const root = realpathSync(join(import.meta.dir, ".."));
  assert.equal(fixture, join(root, "harnesses/process-kernel-fixture"));
  const packageRoot = join(root, "node_modules/@hraness/native-process");
  assert.equal(nativeProcess.NativeProcessTransport, NativeProcessTransport);
  assert.equal(realpathSync(fileURLToPath(import.meta.resolve("@hraness/native-process"))), join(packageRoot, "src/index.ts"));
  for (const name of ["artifact-resolver", "identity", "transport", "observer", "observation-protocol"]) {
    const resolved = fileURLToPath(import.meta.resolve("@hraness/native-process/" + name));
    assert.equal(realpathSync(resolved), join(packageRoot, "src", name + ".ts"));
  }
  assert.equal(realpathSync(packageRoot), packageRoot);
  const token = resolveInstalledNativeArtifact({ imageRoot: join(root, "images"), manifestSha256 });
  const identity = nativeArtifactIdentity(token);
  assert.equal(identity.manifestSha256, manifestSha256);
  const helper = () => nativeArtifactExecutable(token);
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const fixtureSha256 = hash(fixture);
  let cases: readonly string[] = [];
  if (mode === "transport") {
    const result = await verifyNativeTransport({ helperExecutable: helper, fixtureExecutable: fixture,
      cwd: join(root, "temporary"), port: {
        create: options => new NativeProcessTransport(options), host: observeNativeHost, scopes: observeNativeScopes,
        preparedOfReady: nativePreparedOfReady, scopeIsAbsent: nativeScopeIsAbsent,
      } });
    assert.equal(result.helperSha256, identity.artifact.sha256);
    assert.equal(result.fixtureSha256, fixtureSha256);
    assert.equal(result.status, "passed");
    cases = result.cases;
  }
  const executable = helper(), metadata = lstatSync(executable, { bigint: true });
  assert.equal(dirname(executable), join(root, "images"));
  assert.equal(metadata.mode & 0o7777n, 0o500n);
  assert.equal(hash(fixture), fixtureSha256);
  const manifest: unknown = JSON.parse(readFileSync(join(packageRoot, "native-artifacts/manifest.json"), "utf8"));
  assert(manifest !== null && typeof manifest === "object" && "client" in manifest);
  process.stdout.write(JSON.stringify({ version: 1, mode, manifestSha256,
    target: identity.artifact.target, image: { device: String(metadata.dev), inode: String(metadata.ino),
      uid: String(metadata.uid), gid: String(metadata.gid), mode: 0o500, bytes: Number(metadata.size), sha256: hash(executable) },
    client: manifest.client, cases, fixtureSha256 }));
}

if (import.meta.main) await main();
