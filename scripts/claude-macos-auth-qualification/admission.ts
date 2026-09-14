import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { z } from "zod";

import { CLAUDE_PIN, PINNED_CLAUDE_ARTIFACT_DIGESTS } from "../../src/claude/pin";
import { bindDarwinQualificationEnvironment, type ClaudeQualificationBindingInput } from "../claude-macos-auth-process/binding";
import { captureHostedOperatorSource } from "../verify-app-source-launcher";
import type { QualificationCustodySource } from "./custody";
import { containsAsciiControl } from "./identity";
import type { ClaudeMacosPreflightAuthority, ClaudeMacosPreflightScope } from "./preflight";

/**
 * Public release coordinates for the independently verified exact artifact.
 * https://code.claude.com/docs/en/setup#binary-integrity-and-code-signing
 * https://downloads.claude.ai/claude-code-releases/2.1.260/manifest.json
 * Matching current bytes joins that reviewed signature evidence. It does not
 * perform a new signature, notarization, revocation or provider-runtime check.
 */
const reviewedArtifact = Object.freeze({
  basis: "reviewed_exact_artifact" as const,
  version: "2.1.260" as const,
  platform: "darwin-arm64" as const,
  executableSha256: "3c269f66801028823e24a63ced9fdd3988cb86cf85fccd9f03f87e463b9d3e3c",
  manifestSha256: "6f90d6c01bf2ea872c3f6d72b676121eef23d851e981fa4e4adf8eea58f379ca",
  signingKeyFingerprint: "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE",
});
type Failure = "invalid_input" | "platform_refused" | "source_refused" | "executable_refused" | "scope_refused" | "binding_refused" | "aborted";
export class ClaudeMacosAdmissionError extends Error {
  constructor(readonly code: Failure) { super(`CLAUDE_MACOS_ADMISSION_${code}`); this.name = "ClaudeMacosAdmissionError"; }
}
const refuse = (code: Failure): never => { throw new ClaudeMacosAdmissionError(code); };
const path = z.string().refine((value) => value.length >= 2 && value.length <= 4096
  && isAbsolute(value) && resolve(value) === value && !containsAsciiControl(value));
const sha = z.string().refine((value) => value.length === 40 && /^[0-9a-f]{40}$/u.test(value));
const digest = z.string().refine((value) => value.length === 64 && /^[0-9a-f]{64}$/u.test(value));
const uuid = z.string().refine((value) => value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value));
const inputSchema = z.strictObject({ repositoryRoot: path, sourceCommit: sha, executablePath: path });
const fixtureInputSchema = inputSchema.extend({ fixtureExecutableSha256: digest });
const scopeSchema = z.strictObject({ runId: uuid, attemptId: uuid, profile: z.enum(["A", "B"]), probeId: uuid,
  operation: z.enum(["version", "login_help", "logout_help"]), sourceSha: sha, sourceTree: sha,
  executablePath: path, executableSha256: digest, executableDevice: z.number().int().nonnegative().safe(), executableInode: z.number().int().positive().safe(),
  configDir: path, temporaryDirectory: path,
  environment: z.record(z.string().min(1).max(128), z.string().refine((value) => value.length <= 4096 && !value.includes("\0")).optional())
    .refine((value) => Object.keys(value).length <= 256),
  signal: z.instanceof(AbortSignal), deadlineMs: z.literal(5000),
});
type Executable = Readonly<{ device: number; inode: number; owner: number; mode: number; size: number; mtimeMs: number; ctimeMs: number; sha256: string }>;
const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode
  && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** No execution: exact bounded file bytes, descriptor/name identity and metadata. */
function readExecutable(pathname: string, expectedSha256: string): Executable {
  let descriptor = -1;
  const buffer = Buffer.alloc(65_536);
  try {
    if (realpathSync(pathname) !== pathname) return refuse("executable_refused");
    const named = lstatSync(pathname);
    if (!named.isFile() || named.nlink !== 1 || !Number.isSafeInteger(named.size) || named.size < 1 || named.size > 512 * 1024 * 1024
      || !Number.isSafeInteger(named.dev) || named.dev < 0 || !Number.isSafeInteger(named.ino) || named.ino < 1
      || (named.mode & 0o111) === 0 || (named.mode & 0o022) !== 0) return refuse("executable_refused");
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(descriptor);
    if (!sameFile(named, opened)) return refuse("executable_refused");
    const hash = createHash("sha256"); let position = 0;
    while (position < opened.size) {
      const count = readSync(descriptor, buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (count < 1) return refuse("executable_refused");
      hash.update(buffer.subarray(0, count)); position += count;
    }
    const after = fstatSync(descriptor);
    if (!sameFile(opened, after) || !sameFile(after, lstatSync(pathname)) || realpathSync(pathname) !== pathname) return refuse("executable_refused");
    const sha256 = hash.digest("hex");
    if (sha256 !== expectedSha256) return refuse("executable_refused");
    return Object.freeze({ device: after.dev, inode: after.ino, owner: after.uid, mode: after.mode, size: after.size,
      mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, sha256 });
  } catch { return refuse("executable_refused"); }
  finally {
    buffer.fill(0);
    if (descriptor >= 0) { try { closeSync(descriptor); } catch { refuse("executable_refused"); } }
  }
}

type EnvironmentBinder = (input: ClaudeQualificationBindingInput) => Readonly<{ assertCurrent(): void }>;
const fixturePortsSchema = z.strictObject({ bindEnvironment: z.custom<EnvironmentBinder>((value) => typeof value === "function") });
const reviewedPinSchema = z.strictObject({ version: z.literal(reviewedArtifact.version), executableSha256: z.literal(reviewedArtifact.executableSha256) });
type Core = Readonly<{ source: QualificationCustodySource; assertCurrent(): void; preflightAuthority: ClaudeMacosPreflightAuthority }>;
function capture(input: z.infer<typeof inputSchema>, executableSha256: string, bindEnvironment: EnvironmentBinder): Core {
  let captured: ReturnType<typeof captureHostedOperatorSource>;
  try { captured = captureHostedOperatorSource({ repositoryRoot: input.repositoryRoot, sourceCommit: input.sourceCommit }); }
  catch { return refuse("source_refused"); }
  const executable = readExecutable(input.executablePath, executableSha256);
  const source = Object.freeze({ sourceSha: captured.sourceCommit, sourceTree: captured.sourceTree,
    executable: Object.freeze({ path: input.executablePath, device: executable.device, inode: executable.inode }) });
  const assertCurrent = (): void => {
    if (JSON.stringify(readExecutable(input.executablePath, executableSha256)) !== JSON.stringify(executable)) refuse("executable_refused");
    try { captured.assertCapturedContentCurrent(); } catch { refuse("source_refused"); }
  };
  const snapshot = (value: unknown): ClaudeMacosPreflightScope => {
    const parsed = scopeSchema.safeParse(value);
    if (!parsed.success) return refuse("scope_refused");
    const scope = parsed.data;
    if (scope.sourceSha !== source.sourceSha || scope.sourceTree !== source.sourceTree || scope.executablePath !== source.executable.path
      || scope.executableDevice !== source.executable.device || scope.executableInode !== source.executable.inode
      || scope.executableSha256 !== executableSha256 || scope.configDir === scope.temporaryDirectory) return refuse("scope_refused");
    if (scope.signal.aborted) return refuse("aborted");
    return Object.freeze({ ...scope, environment: Object.freeze({ ...scope.environment }) });
  };
  const sameScope = (a: ClaudeMacosPreflightScope, b: ClaudeMacosPreflightScope): boolean => {
    const { signal: signalA, environment: environmentA, ...scalarA } = a;
    const { signal: signalB, environment: environmentB, ...scalarB } = b;
    return signalA === signalB && JSON.stringify(scalarA) === JSON.stringify(scalarB)
      && Object.keys(environmentA).length === Object.keys(environmentB).length
      && Object.keys(environmentA).every((key) => Object.hasOwn(environmentB, key) && environmentA[key] === environmentB[key]);
  };
  const preflightAuthority: ClaudeMacosPreflightAuthority = Object.freeze({ async revalidate(value) {
    const scope = snapshot(value);
    assertCurrent();
    let binding: ReturnType<EnvironmentBinder>;
    try { binding = bindEnvironment({ executablePath: scope.executablePath, executableSha256,
      configDir: scope.configDir, temporaryDirectory: scope.temporaryDirectory, environment: scope.environment }); }
    catch { return refuse("binding_refused"); }
    // The owner ticket is separate. This fence neither consumes that ticket nor
    // claims provider execution, account isolation, or custody of a receipt.
    return Object.freeze({ assertCurrent(actual: ClaudeMacosPreflightScope) {
      if (!sameScope(scope, snapshot(actual))) refuse("scope_refused");
      try { binding.assertCurrent(); } catch { refuse("binding_refused"); }
      assertCurrent();
      if (scope.signal.aborted) refuse("aborted");
    } });
  } });
  assertCurrent();
  return Object.freeze({ source, assertCurrent, preflightAuthority });
}

/** Closed native admission. It never executes Claude or accepts injected readers, digests or authority flags. */
export function captureNativeClaudeMacosAdmission(input: unknown): Core & Readonly<{ artifactProvenance: typeof reviewedArtifact }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return refuse("invalid_input");
  if (process.platform !== "darwin" || process.arch !== "arm64" || Bun.version !== "1.3.14") return refuse("platform_refused");
  const currentPin: unknown = { version: CLAUDE_PIN, executableSha256: PINNED_CLAUDE_ARTIFACT_DIGESTS.nativeExecutable };
  if (!reviewedPinSchema.safeParse(currentPin).success) return refuse("executable_refused");
  return Object.freeze({ ...capture(parsed.data, reviewedArtifact.executableSha256, bindDarwinQualificationEnvironment), artifactProvenance: reviewedArtifact });
}

/** Synthetic composition only. Fixture digests/ports never enter the native factory or acquire its method names/provenance. */
export function captureCredentialFreeClaudeMacosAdmission(input: unknown, ports: Readonly<{ bindEnvironment: EnvironmentBinder }>): Readonly<{
  provenance: "credential_free_fixture"; fixtureSource: QualificationCustodySource; assertFixtureCurrent(): void;
  revalidateFixture: ClaudeMacosPreflightAuthority["revalidate"];
}> {
  const parsed = fixtureInputSchema.safeParse(input);
  const parsedPorts = fixturePortsSchema.safeParse(ports);
  if (!parsed.success || !parsedPorts.success) return refuse("invalid_input");
  const core = capture(parsed.data, parsed.data.fixtureExecutableSha256, parsedPorts.data.bindEnvironment);
  return Object.freeze({ provenance: "credential_free_fixture", fixtureSource: core.source,
    assertFixtureCurrent: core.assertCurrent, revalidateFixture: core.preflightAuthority.revalidate });
}
