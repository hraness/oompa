import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { NATIVE_ARTIFACT_TARGETS, NATIVE_QUALIFICATION_PROFILE, NATIVE_QUALIFICATION_VERSION,
  type NativeArtifact, type NativeArtifactManifest } from "../packages/native-process/src/artifact-model.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const sourceSchema = z.object({
  commitSha: z.string().regex(/^[a-f0-9]{40}$/u), treeSha256: digest, bunLockSha256: digest,
  cargoLockSha256: digest, toolchainSha256: digest, rustVersion: z.literal("1.97.1"),
  bunVersion: z.literal("1.3.14"), profile: z.literal("release"),
}).strict();
export const NATIVE_TRANSPORT_CASES = Object.freeze([
  "echo", "pressure", "block-input", "echo-prepare-refused", "observe-live-foreign-and-joined",
] as const);
/** Internal CI handoff only. These executable images are never package members
 * or product runtime inputs; their hashes let the installed gate repeat the
 * original native suites without compiling replacement testing code. */
export const NATIVE_QUALIFICATION_HARNESS_FILES = Object.freeze({
  unit: "unit-tests", native: "native-tests", fixture: "process-kernel-fixture",
} as const);
const executableSchema = z.object({ bytes: z.number().int().min(64).max(32 * 1024 * 1024), sha256: digest }).strict();
const suiteSchema = z.object({ passed: z.number().int().positive(), failed: z.literal(0), ignored: z.literal(0) }).strict();
export const nativeQualificationSchema = z.object({
  formatVersion: z.literal(1), phase: z.literal("prepack-native"),
  profile: z.literal(NATIVE_QUALIFICATION_PROFILE), profileVersion: z.literal(NATIVE_QUALIFICATION_VERSION),
  source: sourceSchema,
  target: z.enum(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]),
  rustTarget: z.string().max(64),
  licensesSha256: digest,
  artifact: executableSchema,
  harnesses: z.object({ unit: executableSchema, native: executableSchema, fixture: executableSchema }).strict(),
  compiler: z.object({
    rustcVerboseVersion: z.string().min(1).max(4096), cargoVersion: z.string().min(1).max(256),
    bunVersion: z.literal("1.3.14"),
    deploymentTarget: z.enum(["11.0", "static-musl"]),
    environmentPolicy: z.literal("native-process-build-env-v1"),
    linker: z.object({ sha256: digest, version: z.string().min(1).max(4096) }).strict(),
    sdk: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("macos"), version: z.string().min(1).max(64), buildVersion: z.string().min(1).max(64) }).strict(),
      z.object({ kind: z.literal("static-musl"), target: z.string().min(1).max(64) }).strict(),
    ]),
    host: z.object({ architecture: z.enum(["arm64", "x64"]), osRelease: z.string().min(1).max(128) }).strict(),
  }).strict(),
  checks: z.object({
    clippy: z.literal("passed"), unit: suiteSchema, native: suiteSchema,
    transport: z.array(z.string().max(64)).length(NATIVE_TRANSPORT_CASES.length),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.rustTarget !== NATIVE_ARTIFACT_TARGETS[value.target]
    || !value.compiler.rustcVerboseVersion.startsWith("rustc 1.97.1 ")
    || !value.compiler.cargoVersion.startsWith("cargo 1.97.1 ")
    || value.compiler.deploymentTarget !== (value.target.startsWith("darwin-") ? "11.0" : "static-musl")
    || value.compiler.host.architecture !== (value.target.endsWith("arm64") ? "arm64" : "x64")
    || (value.target.startsWith("darwin-") ? value.compiler.sdk.kind !== "macos"
      : value.compiler.sdk.kind !== "static-musl" || value.compiler.sdk.target !== value.rustTarget)
    || value.checks.unit.passed !== 6 || value.checks.native.passed !== 20
    || value.checks.transport.some((name, index) => name !== NATIVE_TRANSPORT_CASES[index])) {
    context.addIssue({ code: "custom", message: "Incomplete exact native qualification profile." });
  }
});
export type NativeQualification = z.infer<typeof nativeQualificationSchema>;

/** This record binds prepack native tests to exact bytes. The independent
 * release gate must additionally install the one final archive and repeat the
 * profile on each admitted target. That outer evidence cannot hash itself into
 * the archive it qualifies. A JSON record alone grants no release authority. */
export function parseNativeQualification(value: unknown, source?: NativeArtifactManifest["source"]): NativeQualification {
  const parsed = nativeQualificationSchema.parse(value);
  if (source !== undefined && !isDeepStrictEqual(parsed.source, source)) {
    throw Error("NATIVE_PROCESS_QUALIFICATION_SOURCE_MISMATCH");
  }
  return parsed;
}

export function qualifiedNativeArtifact(value: NativeQualification, qualificationSha256: string): NativeArtifact {
  digest.parse(qualificationSha256);
  return { target: value.target, rustTarget: NATIVE_ARTIFACT_TARGETS[value.target], scope: "posix-process-group",
    ...value.artifact, qualificationProfile: NATIVE_QUALIFICATION_PROFILE,
    qualificationVersion: NATIVE_QUALIFICATION_VERSION, qualificationSha256 };
}
