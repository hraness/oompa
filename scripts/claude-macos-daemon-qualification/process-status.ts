import { z } from "zod";

const statusSchema = z.strictObject({
  userWriteAttempts: z.number().int().min(0).max(3),
  acceptedUserWrites: z.number().int().min(0).max(2),
  acknowledgmentWithheld: z.boolean(),
}).refine((value) => value.acceptedUserWrites <= value.userWriteAttempts);

/** Qualification policy stays outside the installed daemon and its process adapter. */
export function personalClaudeAcceptanceStatus(value: unknown): Readonly<z.infer<typeof statusSchema>> {
  const parsed = statusSchema.safeParse(value);
  if (!parsed.success) throw new Error("Personal Claude acceptance status was refused.");
  return Object.freeze(parsed.data);
}
