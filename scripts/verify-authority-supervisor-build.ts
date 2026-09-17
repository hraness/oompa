import { readFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import {
  assertAuthoritySupervisorArtifactPublicFile,
  authoritySupervisorArtifactManifest,
} from "./authority-supervisor-artifact";

export type AuthoritySupervisorBuildVerificationErrorCode =
  | "authority_supervisor_build_artifact_mismatch"
  | "authority_supervisor_build_compiler_failed"
  | "authority_supervisor_build_compiler_version_invalid"
  | "authority_supervisor_build_nondeterministic"
  | "authority_supervisor_build_usage_invalid";

export class AuthoritySupervisorBuildVerificationError extends Error {
  constructor(readonly code: AuthoritySupervisorBuildVerificationErrorCode) {
    super(`Authority supervisor build verification failed (${code}).`);
    this.name = "AuthoritySupervisorBuildVerificationError";
  }
}

const verificationError = (code: AuthoritySupervisorBuildVerificationErrorCode): never => {
  throw new AuthoritySupervisorBuildVerificationError(code);
};

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.byteLength === right.byteLength && Buffer.compare(left, right) === 0;

const emitCapture = (target: string, bytes: Uint8Array): void => {
  const encoded = Buffer.from(bytes).toString("base64");
  const chunkSize = 4_096;
  const chunks = Math.ceil(encoded.length / chunkSize);
  for (let index = 0; index < chunks; index += 1) {
    process.stderr.write(`AUTHORITY_SUPERVISOR_CAPTURE ${target} ${String(index + 1)}/${String(chunks)} ${encoded.slice(index * chunkSize, (index + 1) * chunkSize)}\n`);
  }
};

const compilerOutput = async (
  arguments_: readonly string[],
  workingDirectory: string,
): Promise<string> => {
  try {
    const child = Bun.spawn([...arguments_], {
      cwd: workingDirectory,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) return verificationError("authority_supervisor_build_compiler_failed");
    return stdout;
  } catch {
    return verificationError("authority_supervisor_build_compiler_failed");
  }
};

// The source argument stays repository-relative on purpose: rustc embeds the
// spelled input path into panic metadata, so an absolute path would make the
// artifact bytes depend on the checkout directory.
export const authoritySupervisorBuildCommand = (
  rustcExecutable: string,
  target: "x86_64-linux-musl" | "aarch64-linux-musl",
  sourcePath: string,
  outputPath: string,
): readonly string[] => [
  rustcExecutable,
  "--edition",
  "2021",
  "-O",
  "-C",
  "overflow-checks=on",
  "-C",
  "debug-assertions=on",
  "-C",
  "strip=symbols",
  "-C",
  "panic=abort",
  "-C",
  "linker=rust-lld",
  "--target",
  target === "x86_64-linux-musl" ? "x86_64-unknown-linux-musl" : "aarch64-unknown-linux-musl",
  sourcePath,
  "-o",
  outputPath,
];

export const parseAuthoritySupervisorBuildVerifierArguments = (
  arguments_: readonly string[],
): Readonly<{ rustcExecutable: string }> => {
  if (
    arguments_.length !== 2
    || arguments_[0] !== "--rustc"
    || arguments_[1] === undefined
    || !isAbsolute(arguments_[1])
  ) return verificationError("authority_supervisor_build_usage_invalid");
  return { rustcExecutable: arguments_[1] };
};

const rustcVersion = (output: string): string | undefined => {
  const match = /^rustc (\d+\.\d+\.\d+)(?:\s|$)/u.exec(output.trim());
  return match?.[1];
};

export async function verifyAuthoritySupervisorBuild(
  rustcExecutable: string,
  repositoryRoot = resolve(import.meta.dir, ".."),
): Promise<void> {
  if (!isAbsolute(rustcExecutable)) {
    return verificationError("authority_supervisor_build_usage_invalid");
  }
  let compilerPath: string;
  try {
    compilerPath = await realpath(rustcExecutable);
  } catch {
    return verificationError("authority_supervisor_build_usage_invalid");
  }
  const root = await realpath(repositoryRoot).catch(() =>
    verificationError("authority_supervisor_build_usage_invalid"));
  const version = await compilerOutput([compilerPath, "--version"], root);
  if (rustcVersion(version) !== authoritySupervisorArtifactManifest.compiler.version) {
    return verificationError("authority_supervisor_build_compiler_version_invalid");
  }

  const artifacts = Object.values(authoritySupervisorArtifactManifest.artifacts);
  for (const artifact of artifacts) {
    await assertAuthoritySupervisorArtifactPublicFile(root, artifact.relativePath);
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "hra-authority-supervisor-build-"));
  let artifactMismatch = false;
  try {
    const sourcePath = authoritySupervisorArtifactManifest.source.relativePath;
    for (const artifact of artifacts) {
      const firstOutput = join(temporaryDirectory, `${artifact.target}.first`);
      const secondOutput = join(temporaryDirectory, `${artifact.target}.second`);
      const command = (outputPath: string): readonly string[] => authoritySupervisorBuildCommand(
        compilerPath,
        artifact.target,
        sourcePath,
        outputPath,
      );
      await compilerOutput(command(firstOutput), root);
      await compilerOutput(command(secondOutput), root);
      const [first, second, tracked] = await Promise.all([
        readFile(firstOutput),
        readFile(secondOutput),
        readFile(join(root, artifact.relativePath)),
      ]).catch(() => verificationError("authority_supervisor_build_compiler_failed"));
      if (!sameBytes(first, second)) {
        return verificationError("authority_supervisor_build_nondeterministic");
      }
      if (!sameBytes(first, tracked)) {
        if (process.env.OOMPA_AUTHORITY_SUPERVISOR_CAPTURE !== "1") {
          return verificationError("authority_supervisor_build_artifact_mismatch");
        }
        emitCapture(artifact.target, first);
        artifactMismatch = true;
      }
    }
    if (artifactMismatch) {
      return verificationError("authority_supervisor_build_artifact_mismatch");
    }
  } finally {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}

if (import.meta.main) {
  let exitCode = 0;
  try {
    const arguments_ = parseAuthoritySupervisorBuildVerifierArguments(process.argv.slice(2));
    await verifyAuthoritySupervisorBuild(arguments_.rustcExecutable);
  } catch (error: unknown) {
    exitCode = 1;
    process.stderr.write(`${error instanceof Error ? error.message : "Authority supervisor build verification failed."}\n`);
  }
  process.exitCode = exitCode;
}
