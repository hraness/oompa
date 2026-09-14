import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { z } from "zod";

import { canonicalCloudDeploymentUrl } from "../src/cloud/identity-custody";
import type { OompaInstallation } from "../src/installation";
import {
  ensurePrivateDirectory,
  personalProviderPaths,
  resolveStatePaths,
} from "../src/storage/paths";
import {
  FileSecretBackend,
  GenerationalSecretCustody,
} from "../src/storage/secret-custody";
import { privatePathsOverlap } from "./live-acceptance-private-custody";

const normalizedAbsolutePathSchema = z.string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);

export const liveAcceptanceCandidateSchema = z.object({
  cloudTargetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  packageVersion: z.string()
    .min(5)
    .max(128)
    .regex(/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/u),
}).strict();

export type LiveAcceptanceCandidate = z.infer<typeof liveAcceptanceCandidateSchema>;

export const acceptanceInstallationDescriptorSchema = z.object({
  candidate: liveAcceptanceCandidateSchema.optional(),
  cloudDeploymentUrl: z.string().min(1).max(2_048).refine((value) => {
    try {
      return canonicalCloudDeploymentUrl(value) === value;
    } catch {
      return false;
    }
  }).optional(),
  device: z.enum(["a", "b"]),
  documentsDirectory: normalizedAbsolutePathSchema,
  expectedHomeDirectory: normalizedAbsolutePathSchema,
  rootDirectory: normalizedAbsolutePathSchema,
  runId: z.string().uuid(),
  type: z.literal("hra-live-acceptance-device"),
  version: z.literal(1),
}).strict();

export type AcceptanceInstallationDescriptor = z.infer<
  typeof acceptanceInstallationDescriptorSchema
>;

const acceptanceCodexConfig = [
  'cli_auth_credentials_store = "file"',
  'mcp_oauth_credentials_store = "file"',
  "",
].join("\n");

const maximumAcceptanceCodexConfigBytes = 4_096;
const acceptanceCodexInheritedEnvironmentKeys = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
] as const;

async function acceptanceCodexEnvironment(
  codexHome: string,
  expectedHomeDirectory: string,
): Promise<Readonly<Record<string, string>>> {
  const environment: Record<string, string> = {
    HOME: expectedHomeDirectory,
    TMPDIR: await ensurePrivateDirectory(join(codexHome, "tmp")),
  };
  for (const key of acceptanceCodexInheritedEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

function assertAcceptanceCodexConfig(configPath: string): void {
  const currentUid = process.getuid?.();
  if (currentUid === undefined) {
    throw new Error("Live acceptance requires an operating system user ID.");
  }

  const descriptor = openSync(configPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (
      !before.isFile()
      || before.nlink !== 1
      || before.uid !== currentUid
      || (before.mode & 0o777) !== 0o600
      || before.size > maximumAcceptanceCodexConfigBytes
    ) {
      throw new Error("Acceptance CODEX_HOME has an unsafe credential-store configuration.");
    }

    const contents = Buffer.alloc(maximumAcceptanceCodexConfigBytes + 1);
    let length = 0;
    while (length < contents.length) {
      const bytesRead = readSync(
        descriptor,
        contents,
        length,
        contents.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }

    const after = fstatSync(descriptor);
    if (
      !after.isFile()
      || after.nlink !== 1
      || after.uid !== currentUid
      || (after.mode & 0o777) !== 0o600
      || after.size > maximumAcceptanceCodexConfigBytes
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || length !== after.size
      || contents.subarray(0, length).toString("utf8") !== acceptanceCodexConfig
    ) {
      throw new Error("Acceptance CODEX_HOME has an unexpected credential-store configuration.");
    }
  } finally {
    closeSync(descriptor);
  }
}

async function prepareAcceptanceCodexHome(codexHome: string): Promise<void> {
  const canonicalHome = await ensurePrivateDirectory(codexHome);
  if (canonicalHome !== resolve(codexHome)) {
    throw new Error("Acceptance CODEX_HOME is not canonical.");
  }
  const configPath = join(canonicalHome, "config.toml");
  try {
    const descriptor = openSync(
      configPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(descriptor, acceptanceCodexConfig, "utf8");
      fchmodSync(descriptor, 0o600);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const directoryDescriptor = openSync(
      canonicalHome,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertAcceptanceCodexConfig(configPath);
  await ensurePrivateDirectory(join(canonicalHome, "tmp"));
}

function assertDirectChild(parent: string, child: string, label: string): void {
  const relation = relative(parent, child);
  if (
    relation === ""
    || relation.startsWith("..")
    || isAbsolute(relation)
    || relation.includes("/")
    || relation.includes("\\")
  ) throw new Error(`${label} must be one direct child of the acceptance run root.`);
}

export function createAcceptanceInstallation(
  descriptorInput: AcceptanceInstallationDescriptor,
): OompaInstallation {
  const descriptor = acceptanceInstallationDescriptorSchema.parse(descriptorInput);
  const runRoot = resolve(descriptor.rootDirectory, "..");
  assertDirectChild(runRoot, descriptor.rootDirectory, "Acceptance state root");
  assertDirectChild(runRoot, descriptor.documentsDirectory, "Acceptance project root");
  if (descriptor.rootDirectory === descriptor.documentsDirectory) {
    throw new Error("Acceptance state and project roots must be distinct.");
  }
  if (
    !basename(runRoot).startsWith(`hra-live-acceptance-${descriptor.runId}-`)
    || !basename(descriptor.rootDirectory).startsWith(`device-${descriptor.device}-`)
    || !basename(descriptor.documentsDirectory).startsWith(`project-${descriptor.device}-`)
  ) throw new Error("Acceptance installation paths do not match their run identity.");
  const productionRoot = resolveStatePaths().root;
  if (
    privatePathsOverlap(runRoot, productionRoot)
    || privatePathsOverlap(runRoot, descriptor.expectedHomeDirectory)
  ) throw new Error("Acceptance state must not overlap production Oompa state or the invoking home.");

  const cloudDeploymentUrl = descriptor.cloudDeploymentUrl === undefined
    ? undefined
    : canonicalCloudDeploymentUrl(descriptor.cloudDeploymentUrl);
  const paths = resolveStatePaths({ rootDirectory: descriptor.rootDirectory });
  const expectedHomeDirectory = descriptor.expectedHomeDirectory;
  return {
    cloudEnvironment: cloudDeploymentUrl === undefined
      ? { HRA_CONVEX_URL: "" }
      : { HRA_CONVEX_URL: cloudDeploymentUrl },
    codexEnvironment: async (codexHome) => await acceptanceCodexEnvironment(
      codexHome,
      expectedHomeDirectory,
    ),
    credentialStorePreflight: {
      cliAuth: "file",
      cwd: descriptor.documentsDirectory,
      mcpOauth: "file",
    },
    createSecretCustody: () => new GenerationalSecretCustody(
      paths,
      new FileSecretBackend(join(paths.root, "secret-values")),
    ),
    documentsDirectory: descriptor.documentsDirectory,
    expectedHomeDirectory,
    kind: "live_acceptance",
    paths,
    personalProviderHomes: personalProviderPaths(join(paths.root, "personal-home")),
    prepareCodexHome: prepareAcceptanceCodexHome,
  };
}
