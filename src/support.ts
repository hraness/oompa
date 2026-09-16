import { maybeShowSupportInvitation, runSupportCommand } from "./support-runtime.js";
import type { SupportCommandOptions } from "@hraness/support-foundation/node";

export const supportProfile = {
  "id": "hra",
  "name": "Oompa",
  "valueProposition": "Support ongoing development of local tools for coordinating your agents.",
  "updates": true
} as const;

type Output = Readonly<{ stdout: (text: string) => unknown; stderr: (text: string) => unknown }>;

/** Capture this invocation without overriding independent provider-agent workflows. */
export function standaloneSupportEnvironment(): Readonly<Record<string, string | undefined>> {
  return { ...process.env };
}

export async function runProductSupportCommand(args: readonly string[], output: Output, options: SupportCommandOptions = {}): Promise<number> {
  const result = await runSupportCommand(supportProfile, args, { command: ["oompa"], ...options });
  if (result.stdout !== "") output.stdout(result.stdout);
  if (result.stderr !== "") output.stderr(result.stderr);
  return result.exitCode;
}

export async function showProductSupportInvitation(options: SupportCommandOptions = {}): Promise<void> {
  try {
    await maybeShowSupportInvitation(supportProfile, { usefulResult: true, command: ["oompa"], ...options });
  } catch {
    // Optional support must never change the completed task's outcome.
  }
}
