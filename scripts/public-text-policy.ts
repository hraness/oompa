import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import {
  assertAuthoritySupervisorArtifactPublicFile,
  isAuthoritySupervisorArtifactRelativePath,
} from "./authority-supervisor-artifact";
import { snapshotMarketingPreset } from "./marketing-preset";
import { checkLanternMaterialSnapshot } from "../site/vendor/lantern-material/check.mjs";

const allowedPublicScopes = new Set([
  "agentclientprotocol",
  "auth",
  "convex-dev",
  "eslint",
  "letta-ai",
  "openai",
  "tailwindcss",
  "types",
  "typescript-eslint",
  "vitejs",
]);
const allowedPublicScopedPackages = new Set([
  "@anthropic-ai/claude-code",
  "@anthropic-ai/claude-code-darwin-arm64",
  "@babel/core",
  // Historical public commit patches retain this exact predecessor package.
  "@hraness/atet",
  "@hraness/design-kit",
  "@hraness/direct",
  "@hraness/hra",
  "@hraness/oh",
  "@hraness/oompa",
  "@hraness/posthog",
  "@hraness/site-footer",
  "@hraness/slopcamera",
  "@hraness/ui",
  "@stylexjs/babel-plugin",
  "@stylexjs/stylex",
  "@vercel/routing-utils",
]);

const secretPatterns = [
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/u,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
  /\b(?:re|sk)_[A-Za-z0-9_-]{20,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bnpm_[A-Za-z0-9]{30,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\bAIza[0-9A-Za-z_-]{30,}\b/u,
  /\b(?:AUTH_SECRET|CONVEX_DEPLOY_KEY|HRA_AUTH_HMAC_SECRET|HRA_RESEND_API_KEY|OOMPA_AUTH_HMAC_SECRET|OOMPA_RESEND_API_KEY|OTP_HMAC_SECRET|RESEND_API_KEY)\s*[:=]\s*["']?[^\s"']{16,}/u,
] as const;

const absoluteUserPaths = [
  /\/(?:Users|home)\/[^/\s"'`]+\//u,
  /(?:^|[^A-Za-z0-9])[A-Za-z]:\\Users\\[^\\\s"'`]+\\/u,
] as const;
const scopedPackage = /@([a-z0-9][a-z0-9-]*)\/[a-z0-9][a-z0-9._-]*/gu;
const gitTagReferencePackageShape = ["@refs", "tags"].join("/");
// A public certificate subject is not an npm scope. Match the complete reviewed
// identity, including its boundaries, rather than admitting numeric scopes.
const npmEnvironmentSubject = "repo:hraness@307125679/hra@1343008607:environment:npm-release";
const subjectPackageOffset = npmEnvironmentSubject.indexOf("@");
const isSubjectDelimiter = (character: string | undefined): boolean =>
  character === undefined || /^[\t\r\n "'`()[\]{},;]$/u.test(character);

export class PublicTextPolicyError extends Error {
  constructor(
    readonly code: "ABSOLUTE_USER_PATH" | "EM_DASH" | "PRIVATE_SCOPE" | "SECRET_SHAPE" | "UNREVIEWED_FILE_TYPE",
    readonly label: string,
  ) {
    super(`Public text policy rejected ${label}: ${code}.`);
    this.name = "PublicTextPolicyError";
  }
}

export function assertPublicText(value: string, label: string): void {
  assertPublicSensitiveText(value, label);

  for (const match of value.matchAll(scopedPackage)) {
    const scope = match[1];
    const packageName = match[0];
    const matchEnd = match.index + packageName.length;
    const isGitTagReference = packageName === gitTagReferencePackageShape && value[matchEnd] === "/";
    const subjectStart = match.index - subjectPackageOffset;
    const subjectEnd = subjectStart + npmEnvironmentSubject.length;
    const isNpmEnvironmentSubject = subjectStart >= 0
      && value.slice(subjectStart, subjectEnd) === npmEnvironmentSubject
      && isSubjectDelimiter(value[subjectStart - 1])
      && (
        isSubjectDelimiter(value[subjectEnd])
        || (value[subjectEnd] === "." && isSubjectDelimiter(value[subjectEnd + 1]))
      );
    if (
      scope !== undefined
      && !allowedPublicScopes.has(scope)
      && !allowedPublicScopedPackages.has(packageName)
      && !isGitTagReference
      && !isNpmEnvironmentSubject
    ) {
      throw new PublicTextPolicyError("PRIVATE_SCOPE", label);
    }
  }
}

/**
 * Public copy follows STYLE.md and WRITING.md, which both ban the em dash.
 * The check is separate from `assertPublicText` because that function also
 * scans historical commit patches and vendored text that this rule does not
 * govern.
 */
export function assertPublicCopyText(value: string, label: string): void {
  if (value.includes("\u2014")) {
    throw new PublicTextPolicyError("EM_DASH", label);
  }
}

export function assertPublicSensitiveText(value: string, label: string): void {
  for (const pattern of absoluteUserPaths) {
    if (pattern.test(value)) {
      throw new PublicTextPolicyError("ABSOLUTE_USER_PATH", label);
    }
  }

  for (const pattern of secretPatterns) {
    if (pattern.test(value)) {
      throw new PublicTextPolicyError("SECRET_SHAPE", label);
    }
  }
}

const excludedDirectories = new Set([".git", "dist", "node_modules"]);
/**
 * Files whose prose is public copy: root Markdown, the package manifest, the
 * generated-site source, published docs, and the GitHub issue templates.
 */
const publicCopyFile = /^(?:[A-Z_]+\.md|package\.json|site\/.+|docs\/.+\.md|\.github\/ISSUE_TEMPLATE\/.+)$/u;
const textFile = /(?:^|\/)(?:CODEOWNERS|LICENSE|\.bun-version|\.editorconfig|\.gitattributes|\.gitignore)$|\.(?:c|css|h|html|json|lock|md|mjs|ps1|svg|toml|ts|tsx|txt|xml|yaml|yml|zig)$/u;
// This synthetic logical dump is a reviewed migration input, not a general
// database-file exception. It still passes every public sensitive-text check.
const releasedStateSql = "scripts/fixtures/released-state/v0.5.0/control-plane.sql";
const editorialWebp = /^site\/images\/editorial\/[a-z0-9]+(?:-[a-z0-9]+)*(?:-384|-768)?\.webp$/u;
const webpChunkTypes = new Set(["VP8 ", "VP8L", "VP8X"]);
const marketingDirectory = "site/vendor/marketing-preset";
const marketingDeclaration = `${marketingDirectory}/check.d.mts`;
const materialDirectory = "site/vendor/lantern-material";
const materialDeclaration = `${materialDirectory}/check.d.mts`;
const marketingFont = "fonts/instrument-serif/instrument-serif-latin-400.woff2";

/** One additional declaration path; all snapshot text still receives the public scan. */
async function assertMaterialPublicSource(root: string, label: string): Promise<void> {
  try {
    const directory = join(await realpath(root), materialDirectory);
    assert.equal(await realpath(directory), directory);
    const manifest = await checkLanternMaterialSnapshot(directory);
    assert.equal(manifest.source.commit, "eccb0341d8d0ba960a0f02248cf59888062afb0a");
  } catch {
    throw new PublicTextPolicyError("UNREVIEWED_FILE_TYPE", label);
  }
}

/** One reviewed licensed binary, inside the complete canonical source inventory.
 * Neither its suffix nor caller-controlled provenance authorizes other bytes. */
async function assertMarketingPublicSource(root: string, label: string): Promise<void> {
  try {
    const directory = join(await realpath(root), marketingDirectory);
    assert.equal(await realpath(directory), directory);
    const snapshot = await snapshotMarketingPreset(directory);
    assert.equal(snapshot.sourceCommit, "898d80364085a41c858350f1b492ac28b5a0384b");
    const bytes = snapshot.files.get(marketingFont);
    assert.ok(bytes !== undefined && bytes.byteLength >= 48 && bytes.byteLength <= 50_000);
    assert.equal(bytes.toString("ascii", 0, 4), "wOF2");
    assert.equal(bytes.readUInt32BE(8), bytes.byteLength);
    assert.equal(createHash("sha256").update(bytes).digest("hex"),
      "60c06664b5a95c7de6cc3e00d1f9034d78bd1e40b564016b241674449a067d4d");
  } catch {
    throw new PublicTextPolicyError("UNREVIEWED_FILE_TYPE", label);
  }
}

const assertEditorialWebp = async (path: string, label: string): Promise<void> => {
  const bytes = await readFile(path);
  const riffSize = bytes.byteLength >= 8 ? bytes.readUInt32LE(4) : -1;
  const chunkType = bytes.byteLength >= 16 ? bytes.toString("ascii", 12, 16) : "";
  if (
    bytes.byteLength < 20
    || bytes.byteLength > 2_000_000
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || riffSize !== bytes.byteLength - 8
    || bytes.toString("ascii", 8, 12) !== "WEBP"
    || !webpChunkTypes.has(chunkType)
  ) {
    throw new PublicTextPolicyError("UNREVIEWED_FILE_TYPE", label);
  }
};

async function scanPublicTree(root: string, skipCheckoutTmp: boolean): Promise<void> {
  const visit = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      const label = relative(root, child);
      if (label === ".git" && (entry.isDirectory() || entry.isFile())) {
        continue;
      } else if (skipCheckoutTmp && label === "tmp" && entry.isDirectory()) {
        continue;
      } else if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(child);
      } else if (entry.isFile() && isAuthoritySupervisorArtifactRelativePath(label)) {
        await assertAuthoritySupervisorArtifactPublicFile(root, label);
      } else if (entry.isFile() && editorialWebp.test(label)) {
        await assertEditorialWebp(child, label);
      } else if (entry.isFile() && label === `${marketingDirectory}/${marketingFont}`) {
        await assertMarketingPublicSource(root, label);
      } else if (entry.isFile() && (textFile.test(child) || label === releasedStateSql || label === marketingDeclaration || label === materialDeclaration)) {
        if (label === marketingDeclaration) await assertMarketingPublicSource(root, label);
        if (label === materialDeclaration) await assertMaterialPublicSource(root, label);
        const value = await readFile(child, "utf8");
        if (entry.name === "bun.lock") assertPublicSensitiveText(value, label);
        else assertPublicText(value, label);
        if (publicCopyFile.test(label)) assertPublicCopyText(value, label);
      } else {
        throw new PublicTextPolicyError("UNREVIEWED_FILE_TYPE", label);
      }
    }
  };
  await visit(root);
}

/** Archive scans never inherit the checkout's private build-evidence exception. */
export async function assertPublicTree(root: string): Promise<void> {
  await scanPublicTree(root, false);
}

type CheckoutTmpIdentity = Readonly<{ dev: number; ino: number; mode: number }>;

function checkoutGit(root: string, args: readonly string[], allowNotIgnored = false, input?: string): string | undefined {
  const result = spawnSync("/usr/bin/git", [
    "--no-optional-locks", "--no-replace-objects", "-c", "core.excludesFile=/dev/null", ...args,
  ], {
    cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  if (result.error !== undefined || result.signal !== null || result.stderr !== ""
    || (result.status !== 0 && !(allowNotIgnored && result.status === 1 && result.stdout === ""))) {
    throw new Error("Public checkout Git evidence could not be read within its bound.");
  }
  return result.status === 0 ? result.stdout : undefined;
}

async function checkoutTmpIdentity(root: string): Promise<CheckoutTmpIdentity | undefined> {
  if (!isAbsolute(root) || root.length > 4096 || resolve(root) !== root
    || !(await lstat(root)).isDirectory() || await realpath(root) !== root
    || checkoutGit(root, ["rev-parse", "--show-toplevel"]) !== `${root}\n`) {
    throw new Error("Public checkout must be its exact physical Git root.");
  }
  const temporaryRoot = join(root, "tmp");
  const metadata = await lstat(temporaryRoot).catch((error: unknown) => {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error instanceof Error ? error : new Error("Public checkout temporary evidence could not be inspected.", { cause: error });
  });
  if (metadata === undefined) return undefined;
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(temporaryRoot) !== temporaryRoot) {
    throw new Error("Public checkout temporary evidence must be one physical directory.");
  }
  // Only this root-level generated directory is eligible. Tracked files remain
  // public even when ignored, and an unignored source entry prevents omission.
  if (checkoutGit(root, ["ls-files", "--cached", "-z", "--", "tmp"]) !== ""
    || checkoutGit(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", "tmp"]) !== "") return undefined;
  const ignored = checkoutGit(root, ["check-ignore", "--verbose", "--no-index", "-z", "--stdin"], true, "tmp/\0");
  if (ignored === undefined) return undefined;
  const evidence = ignored.split("\0");
  if (evidence.length !== 5 || evidence[0] !== ".gitignore" || !/^[1-9][0-9]*$/u.test(evidence[1] ?? "")
    || (evidence[2] !== "tmp/" && evidence[2] !== "/tmp/") || evidence[3] !== "tmp/" || evidence[4] !== "") return undefined;
  return { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode };
}

/** Scan authored checkout content without publishing retained private build receipts. */
export async function assertPublicCheckout(root: string): Promise<void> {
  const before = await checkoutTmpIdentity(root);
  await scanPublicTree(root, before !== undefined);
  if (before !== undefined) {
    const after = await checkoutTmpIdentity(root);
    if (after === undefined || after.dev !== before.dev || after.ino !== before.ino || after.mode !== before.mode) {
      throw new Error("Public checkout temporary evidence changed during its source scan.");
    }
  }
}
