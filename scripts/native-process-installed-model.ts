import { gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { z } from "zod";
import { NATIVE_ARTIFACT_TARGETS } from "../packages/native-process/src/artifact-model.ts";

import { nativeInputHash } from "./native-process-build-inputs.ts";
import { NATIVE_TRANSPORT_CASES, nativeQualificationSchema } from "./native-process-qualification-model.ts";
import { nativeProcessDependency } from "./native-process-dependency.ts";

export const NATIVE_INSTALLED_DEPENDENCIES = Object.freeze({
  "@hraness/native-process": "file:./native.tgz", zod: "file:./zod.tgz",
});
export function nativeInstalledPackageJson(): Readonly<Record<string, unknown>> {
  return { name: "native-process-installed-acceptance", version: "0.0.0", private: true, type: "module",
    dependencies: NATIVE_INSTALLED_DEPENDENCIES, overrides: { zod: "file:./zod.tgz" }, trustedDependencies: [] };
}
export const nativeInstalledBunArguments = (root: string): readonly string[] => [
  "--no-env-file", `--config=${join(root, "bunfig.toml")}`, "install", "--production",
  "--ignore-scripts", "--backend=copyfile", "--linker=hoisted", `--cache-dir=${join(root, "cache")}`,
  "--no-progress", "--no-summary",
];
function refuse(): never { throw Error("NATIVE_PROCESS_INSTALLED_INPUT_INVALID"); }
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse();
  return value as Record<string, unknown>;
}

/** The first pass resolves only two already admitted local tarballs. Before
 * installing, inspect its generated lock and freeze those exact local sources. */
export function assertNativeInstalledLock(value: unknown): void {
  const lock = object(value), workspaces = object(lock.workspaces), workspace = object(workspaces[""]);
  const keys = new Set(["lockfileVersion", "configVersion", "workspaces", "overrides", "packages"]);
  if (Object.keys(lock).some(key => !keys.has(key))
    || Object.keys(workspace).some(key => !["name", "version", "dependencies"].includes(key))
    || (Object.hasOwn(workspace, "version") && workspace.version !== "0.0.0")) refuse();
  if (lock.lockfileVersion !== 1 || lock.configVersion !== 1 || Object.keys(workspaces).join() !== ""
    || workspace.name !== "native-process-installed-acceptance"
    || !isDeepStrictEqual(workspace.dependencies, NATIVE_INSTALLED_DEPENDENCIES)
    || !isDeepStrictEqual(lock.overrides, { zod: "file:./zod.tgz" })) refuse();
  const packages = object(lock.packages);
  if (!isDeepStrictEqual(Object.keys(packages).sort(), ["@hraness/native-process", "zod"])) refuse();
  for (const [name, file] of [["@hraness/native-process", "native.tgz"], ["zod", "zod.tgz"]] as const) {
    const entry = packages[name];
    if (!Array.isArray(entry) || entry.length < 1 || entry.length > 4
      || ![`${name}@file:./${file}`, `${name}@file:${file}`, `${name}@./${file}`, `${name}@${file}`].includes(entry[0] as string)) refuse();
    const metadata = entry.filter((part): part is Record<string, unknown> => part !== null && typeof part === "object" && !Array.isArray(part));
    if (metadata.length !== 1 || !isDeepStrictEqual(metadata[0], name === "zod" ? {} : { dependencies: { zod: "4.4.3" } })) refuse();
    for (const part of entry.slice(1)) {
      if (part === metadata[0] || part === "") continue;
      // A local archive may have an integrity field, never a registry locator.
      if (typeof part !== "string" || !/^sha(?:256|512)-[A-Za-z0-9+/]+={0,2}$/u.test(part)) refuse();
    }
  }
}

export type NativeDependencyFile = Readonly<{ path: string; mode: number; bytes: Buffer }>;
/** Called only after the complete tarball matches the root lock's exact SRI.
 * This bounded inventory additionally proves zod has no install-time graph. */
export function inspectNativeInstalledDependency(bytes: Uint8Array): readonly NativeDependencyFile[] {
  if (bytes.byteLength < 1 || bytes.byteLength > 16 * 1024 * 1024) refuse();
  const tar = gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 });
  if (tar.length < 1536 || tar.length % 512 !== 0) refuse();
  const files: NativeDependencyFile[] = [], names = new Set<string>();
  const text = (header: Buffer, start: number, length: number): string => {
    const field = header.subarray(start, start + length), zero = field.indexOf(0);
    if (zero >= 0 && field.subarray(zero).some(byte => byte !== 0)) refuse();
    return new TextDecoder("utf-8", { fatal: true }).decode(zero < 0 ? field : field.subarray(0, zero));
  };
  const octal = (header: Buffer, start: number, length: number): number => {
    const field = header.subarray(start, start + length).toString("ascii");
    if (!/^[0-7]+(?:\0| )*$/u.test(field)) refuse();
    return Number.parseInt(field, 8);
  };
  let offset = 0, ended = false;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) {
      if (offset + 1024 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) refuse();
      ended = true; break;
    }
    if (files.length >= 4096 || header.subarray(257, 263).toString("ascii") !== "ustar\0"
      || header.subarray(263, 265).toString("ascii") !== "00"
      || ![0, 48].includes(header[156] ?? refuse()) || header.subarray(157, 257).some(byte => byte !== 0)) refuse();
    let sum = 0;
    for (let index = 0; index < 512; index += 1) sum += index >= 148 && index < 156 ? 32 : (header[index] ?? refuse());
    if (sum !== octal(header, 148, 8)) refuse();
    const prefix = text(header, 345, 155), name = text(header, 0, 100);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (!/^package\/[A-Za-z0-9._/-]+$/u.test(path) || path.length > 255
      || path.split("/").some(part => part === "" || part === "." || part === "..")) refuse();
    const folded = path.toLowerCase();
    for (const previous of names) if (previous === folded || previous.startsWith(folded + "/") || folded.startsWith(previous + "/")) refuse();
    names.add(folded);
    const size = octal(header, 124, 12), mode = octal(header, 100, 8), begin = offset + 512;
    const next = begin + Math.ceil(size / 512) * 512;
    if (size > 1024 * 1024 || ![0o644, 0o755].includes(mode) || next > tar.length
      || tar.subarray(begin + size, next).some(byte => byte !== 0)) refuse();
    files.push({ path: path.slice(8), mode, bytes: Buffer.from(tar.subarray(begin, begin + size)) });
    offset = next;
  }
  if (!ended) refuse();
  const manifest = files.find(file => file.path === "package.json");
  if (manifest === undefined) refuse();
  const parsed = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes)) as unknown);
  if (parsed.name !== "zod" || parsed.version !== "4.4.3") refuse();
  for (const name of ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies", "bin", "workspaces"]) {
    if (Object.hasOwn(parsed, name) && !isDeepStrictEqual(parsed[name], {})) refuse();
  }
  return files.sort((left, right) => left.path < right.path ? -1 : 1);
}

export function assertNativeInstalledDriver(source: Uint8Array, kind: "worker" | "verifier"): void {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  if (source.byteLength > 128 * 1024 || /\b(?:eval|require)\s*\(|\bimport\s*\(/u.test(text)) refuse();
  const imports = new Bun.Transpiler({ loader: "ts" }).scan(text).imports;
  const builtin = new Set(["node:assert/strict", "node:crypto", "node:fs", "node:path", "node:url"]);
  for (const item of imports) {
    if (item.kind !== "import-statement" || (!builtin.has(item.path)
      && !(kind === "worker" && (/^@hraness\/native-process(?:\/(?:artifact-resolver|identity|transport|observer|observation-protocol))?$/u.test(item.path)
        || item.path === "../native/process-kernel/verify-transport.ts")))) refuse();
  }
  if (imports.length === 0) refuse();
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u), decimal = z.string().regex(/^(?:0|[1-9][0-9]*)$/u).max(20);
export const nativeInstalledImageSchema = z.object({ device: decimal, inode: decimal, uid: decimal, gid: decimal,
  mode: z.literal(0o500), bytes: z.number().int().min(64).max(32 * 1024 * 1024), sha256: digest }).strict();
export const nativeInstalledWorkerResultSchema = z.object({
  version: z.literal(1), mode: z.enum(["admit", "transport"]), manifestSha256: digest,
  target: z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]),
  image: nativeInstalledImageSchema,
  client: z.array(z.object({ path: z.string().min(1).max(256), bytes: z.number().int().positive().max(1024 * 1024), sha256: digest }).strict()).length(11),
  cases: z.array(z.string().max(64)).max(5),
  fixtureSha256: digest,
}).strict().superRefine((value, context) => {
  if (!isDeepStrictEqual(value.cases, value.mode === "admit" ? [] : NATIVE_TRANSPORT_CASES)) {
    context.addIssue({ code: "custom", message: "Incomplete installed transport cases." });
  }
});
export type NativeInstalledWorkerResult = z.infer<typeof nativeInstalledWorkerResultSchema>;
export const nativeInstalledInventoryDigest = (files: readonly Readonly<{ path: string; bytes: number; sha256: string }>[]): string =>
  nativeInputHash(Buffer.from(JSON.stringify(files)));

/** Outer evidence can bind the final archive without embedding its own digest
 * in that archive. The release owner supplies authenticated run authority. */
export const nativeInstalledReceiptSchema = z.object({
  formatVersion: z.literal(1), phase: z.literal("installed-native"),
  profile: nativeQualificationSchema.shape.profile, profileVersion: nativeQualificationSchema.shape.profileVersion,
  source: nativeQualificationSchema.shape.source, target: nativeQualificationSchema.shape.target,
  rustTarget: nativeQualificationSchema.shape.rustTarget, artifact: nativeQualificationSchema.shape.artifact,
  harnesses: nativeQualificationSchema.shape.harnesses,
  archiveSha256: digest, manifestSha256: digest, prepackSha256: digest,
  verifierSha256: digest, workerSha256: digest,
  dependency: z.object({ name: z.literal("zod"), version: z.literal("4.4.3"),
    integrity: z.literal(nativeProcessDependency.integrity), archiveSha256: digest, inventorySha256: digest }).strict(),
  bun: z.object({ version: z.literal("1.3.14"), sha256: digest }).strict(),
  installation: z.object({ localLockSha256: digest, clientInventorySha256: digest,
    image: nativeInstalledImageSchema }).strict(),
  checks: z.object({ unit: z.object({ passed: z.literal(6), failed: z.literal(0), ignored: z.literal(0) }).strict(),
    native: z.object({ passed: z.literal(20), failed: z.literal(0), ignored: z.literal(0) }).strict(),
    transport: z.array(z.string()).length(5) }).strict(),
}).strict().superRefine((value, context) => {
  if (!isDeepStrictEqual(value.checks.transport, NATIVE_TRANSPORT_CASES)
    || value.rustTarget !== NATIVE_ARTIFACT_TARGETS[value.target]
    || value.artifact.sha256 !== value.installation.image.sha256 || value.artifact.bytes !== value.installation.image.bytes) {
    context.addIssue({ code: "custom", message: "Incomplete installed native evidence." });
  }
});
export type NativeInstalledReceipt = z.infer<typeof nativeInstalledReceiptSchema>;
