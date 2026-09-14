import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { nativeBuildInput, nativeInputHash } from "./native-process-build-inputs.ts";

export const nativeProcessDependency = Object.freeze({
  name: "zod", version: "4.4.3", filename: "zod-4.4.3.tgz",
  url: "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz",
  integrity: "sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==",
});
const maximum = 16 * 1024 * 1024;
function refuse(): never { throw Error("NATIVE_PROCESS_DEPENDENCY_INVALID"); }

export function admitNativeProcessDependency(lock: unknown, bytes?: Uint8Array): void {
  if (lock === null || typeof lock !== "object" || Array.isArray(lock)) refuse();
  const packages = (lock as Record<string, unknown>).packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)
    || !isDeepStrictEqual((packages as Record<string, unknown>).zod,
      [`zod@${nativeProcessDependency.version}`, "", {}, nativeProcessDependency.integrity])) refuse();
  if (bytes !== undefined && (bytes.byteLength < 1 || bytes.byteLength > maximum
    || "sha512-" + createHash("sha512").update(bytes).digest("base64") !== nativeProcessDependency.integrity)) refuse();
}

/** Dependency acquisition is an explicit preparation step. Installation uses
 * these admitted local bytes, without lifecycle scripts or a registry lookup. */
export async function prepareNativeProcessDependency(outputDirectory: string): Promise<Readonly<{ path: string; sha256: string }>> {
  if (Bun.version !== "1.3.14") refuse();
  const lockPath = join(import.meta.dir, "../bun.lock");
  const lock = nativeBuildInput(lockPath, 4 * 1024 * 1024);
  const parsed: unknown = Bun.JSONC.parse(lock.toString("utf8"));
  admitNativeProcessDependency(parsed);
  const output = resolve(outputDirectory), parent = dirname(output);
  if (realpathSync(parent) !== parent) refuse();
  const response = await fetch(nativeProcessDependency.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || response.body === null) refuse();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) refuse();
      chunks.push(next.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  admitNativeProcessDependency(parsed, bytes);
  if (!lock.equals(nativeBuildInput(lockPath, 4 * 1024 * 1024))) refuse();
  mkdirSync(output, { mode: 0o700 });
  const identity = lstatSync(output, { bigint: true });
  if (realpathSync(output) !== output || !identity.isDirectory() || process.getuid === undefined
    || identity.uid !== BigInt(process.getuid()) || (identity.mode & 0o7777n) !== 0o700n) refuse();
  const path = join(output, nativeProcessDependency.filename);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const directory = openSync(output, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(directory, { bigint: true }), current = lstatSync(output, { bigint: true });
    if (opened.dev !== identity.dev || opened.ino !== identity.ino || opened.mode !== identity.mode
      || current.dev !== identity.dev || current.ino !== identity.ino || current.mode !== identity.mode) refuse();
    fsyncSync(directory);
  } finally { closeSync(directory); }
  return { path, sha256: nativeInputHash(bytes) };
}

if (import.meta.main) {
  const [output, extra] = process.argv.slice(2);
  if (output === undefined || extra !== undefined) throw Error("Usage: native-process-dependency.ts FRESH_OUTPUT");
  console.log(JSON.stringify(await prepareNativeProcessDependency(output)));
}
