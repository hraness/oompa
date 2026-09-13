import { z } from "zod";
import type { DaemonIdentity } from "../../src/daemon/daemon-startup";
import type { LocalCommand } from "../../src/domain/contracts";
import { daemonQualificationDescriptorSchema, daemonQualificationIdempotencyKey, daemonQualificationPrompt } from "./contract";

export const COMMAND_STEPS = ["adoption_A", "list_A", "normal_A", "normal_B", "lost_B", "retry_C"] as const;
export type DaemonQualificationCommandStep = typeof COMMAND_STEPS[number];
export const commandIntentSchema = z.strictObject({ step: z.enum(COMMAND_STEPS), stage: z.enum(["A", "B", "C"]),
  daemonGeneration: z.number().int().positive(), daemonNonce: z.string().uuid(), commandTag: z.string().regex(/^[0-9a-f]{64}$/u) });
export type DaemonQualificationCommandIntent = z.infer<typeof commandIntentSchema>;
const id = z.string().min(1).max(512);

/** Closed fixed-flow command snapshot. No transport or native authority. */
export function snapshotDaemonQualificationCommand(step: DaemonQualificationCommandStep, descriptorInput: unknown,
  identity: Pick<DaemonIdentity, "generation" | "nonce">, command: LocalCommand): Readonly<{ command: LocalCommand;
    binding: Omit<DaemonQualificationCommandIntent, "commandTag"> }> {
  const descriptor = daemonQualificationDescriptorSchema.parse(descriptorInput);
  const stage = step === "normal_B" || step === "lost_B" ? "B" : step === "retry_C" ? "C" : "A";
  if (!COMMAND_STEPS.includes(step) || descriptor.stage !== stage) throw new Error("DARWIN_DAEMON_COMMAND_INTENT_REFUSED");
  const nonce = step === "normal_A" ? descriptor.normalNonceA : step === "normal_B" ? descriptor.normalNonceB : daemonQualificationIdempotencyKey(descriptor);
  const schema = step === "adoption_A"
    ? z.strictObject({ kind: z.literal("session.adoption.set"), provider: z.literal("claude"), enabled: z.literal(true), account: id })
    : step === "list_A"
      ? z.strictObject({ kind: z.literal("session.list"), account: id, archived: z.literal(false), limit: z.literal(2) })
      : z.strictObject({ kind: z.literal("session.send"), session: id, message: z.literal(daemonQualificationPrompt(nonce)), idempotencyKey: z.literal(nonce) });
  const captured = schema.parse(command);
  const binding = commandIntentSchema.omit({ commandTag: true }).parse({ step, stage,
    daemonGeneration: identity.generation, daemonNonce: identity.nonce });
  return Object.freeze({ command: Object.freeze(captured), binding: Object.freeze(binding) });
}
