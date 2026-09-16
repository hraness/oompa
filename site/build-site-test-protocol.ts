import { isAbsolute } from "node:path";
import { z } from "zod";

const path = z.string().min(1).max(4096).refine(isAbsolute);
export const siteTestBuildOptions = z.object({
  check: z.boolean(),
  repositoryRoot: path,
  sourceRoot: path.optional(),
  // Invalid public configuration and release identities deliberately reach
  // the real builder, whose original errors are part of the test contract.
  releaseCommit: z.string().max(128).optional(),
  environment: z.object({
    VERCEL_ENV: z.string().max(32).optional(),
    NEXT_PUBLIC_POSTHOG_KEY: z.string().max(1024).optional(),
    NEXT_PUBLIC_HRANESS_MAILING_TURNSTILE_SITEKEY: z.string().max(1024).optional(),
  }).strict().optional(),
}).strict();
export type SiteTestBuildOptions = z.infer<typeof siteTestBuildOptions>;

export const siteTestBuildTerminal = z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), mismatches: z.array(z.string().max(4096)).max(64) }).strict(),
  z.object({ status: z.literal("failure"), name: z.string().max(256), message: z.string().max(65_536), stack: z.string().max(131_072).optional() }).strict(),
]);
export const siteTestBuildTerminalPrefix = "OOMPA_SITE_TEST_RESULT_V1 ";

export function readSiteTestBuildTerminal(stdout: Buffer): z.infer<typeof siteTestBuildTerminal> {
  const lines = stdout.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  const terminals = lines.filter((line) => line.startsWith(siteTestBuildTerminalPrefix));
  if (terminals.length !== 1 || terminals[0] !== lines.at(-1)) {
    throw new Error("SITE_COMPILER_TERMINAL_INVALID");
  }
  const terminal = terminals[0];
  if (terminal === undefined) throw new Error("SITE_COMPILER_TERMINAL_INVALID");
  return siteTestBuildTerminal.parse(JSON.parse(terminal.slice(siteTestBuildTerminalPrefix.length)) as unknown);
}
