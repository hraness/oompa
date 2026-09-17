/*
 * `oompa credits …` and the credits-required handoff.
 *
 * Oompa meters hosted autorespond replies through the shared Hraness credits
 * service. The CLI commands, local device state, and the one payment envelope
 * come from the reviewed credits foundation bundle; this module binds them to
 * Oompa's product profile and to the CLI's output sinks. The device token the
 * service issues stays in the credits state file; it is read for the daemon's
 * hosted requests and never rendered.
 */

import type {
  CreditsAudience,
  CreditsCommandIo,
  CreditsOutput,
} from "@hraness/credits-foundation/node";
import type { CreditsRequiredEnvelope } from "@hraness/credits-foundation";

import {
  buildCreditsRequiredEnvelope,
  emitCreditsRequired,
  readStoredDeviceToken,
  runCreditsCommand,
} from "./credits-runtime.js";
import { HOSTED_AUTORESPOND_RESUME_ARGV, creditsProfile } from "./domain/credits-profile";
import type { HostedCreditsRequired } from "./domain/hosted-autorespond";

export { creditsProfile };

type Output = Readonly<{ stdout: (text: string) => unknown; stderr: (text: string) => unknown }>;

/** Adapt a CLI text sink to the foundation's stream-shaped output. */
function creditsOutput(write: (text: string) => unknown): CreditsOutput {
  return {
    write(text, callback) {
      try {
        write(text);
        callback?.(null);
      } catch (error: unknown) {
        callback?.(error instanceof Error ? error : new Error("Output failed."));
      }
      return true;
    },
  };
}

/** `oompa credits …`: the shared credits protocol with Oompa's product profile. Returns the exit code. */
export async function runProductCreditsCommand(
  args: readonly string[],
  output: Output,
  io: CreditsCommandIo = {},
): Promise<number> {
  const result = await runCreditsCommand(creditsProfile(io.env ?? process.env), args, {
    stdout: creditsOutput(output.stdout),
    stderr: creditsOutput(output.stderr),
    ...io,
  });
  return result.exitCode;
}

/** The stored credits device token the daemon forwards with hosted requests, or null when this device has none. */
export async function readProductCreditsToken(
  options: Pick<CreditsCommandIo, "env" | "stateDirectory"> = {},
): Promise<string | null> {
  const stored = await readStoredDeviceToken(creditsProfile(options.env ?? process.env), options);
  return stored.ok ? stored.value : null;
}

/**
 * Build the `hraness-credits-required-v1` envelope from the hosted backend's
 * 402 payload. Null when the payload carries no payment link, in which case
 * the caller prints its ordinary guidance instead.
 */
export function hostedCreditsRequiredEnvelope(payload: HostedCreditsRequired): CreditsRequiredEnvelope | null {
  if (payload.required === undefined || payload.balance === undefined || payload.topup === undefined) return null;
  const profile = creditsProfile();
  try {
    return buildCreditsRequiredEnvelope({
      product: { id: profile.id, name: profile.name },
      command: profile.command,
      operation: payload.operation,
      requiredMicroUsd: payload.required.microUsd,
      balanceMicroUsd: payload.balance.microUsd,
      topup: {
        url: payload.topup.url,
        expiresAt: payload.topup.expiresAt,
        packs: payload.topup.packs.map((pack) => ({
          id: pack.id, usd: pack.usd, credits: pack.credits, bonusCredits: pack.bonusCredits,
        })),
        suggestedPackId: payload.topup.suggestedPackId,
      },
      resume: { argv: HOSTED_AUTORESPOND_RESUME_ARGV, automatic: true },
    });
  } catch {
    return null;
  }
}

/**
 * Print the handoff for a paused hosted responder: exactly one JSON line for
 * agents, a few plain lines for people. Returns false when the payload had no
 * payment link. Output failures never change the exit code.
 */
export async function emitHostedCreditsRequired(
  payload: HostedCreditsRequired,
  options: Readonly<{ audience: CreditsAudience; stderr: (text: string) => unknown }>,
): Promise<boolean> {
  const envelope = hostedCreditsRequiredEnvelope(payload);
  if (envelope === null) return false;
  return await emitCreditsRequired(envelope, { stderr: creditsOutput(options.stderr) }, options.audience);
}
