import { z } from "zod";

import { reviewedRuntimeProfileV1Schema } from "../domain/runtime-profile";
import { queueEffectEvidence49Schema } from "./effect-evidence-codecs";
import { mutationEvidenceCanonical49Schema } from "./historical-effect-evidence-codecs";

// joined_v1 composes canonical49's explicit timestamp/actor/preset/host fields
// with the retained V1 provider-runtime dialects. Historical format names do
// not alias this writer. Any later shape change requires another format ID.
const [send, steer, stop, rename, start, switched, login, claudeLogin, devinLogin,
  logout, loginCancel] = mutationEvidenceCanonical49Schema.options;

// `session.compact` exists only in this writer. Its recovery proof is the
// session event stream itself, so the evidence pins the exact stream epoch
// and the sequence observed before dispatch instead of a provider timestamp.
const compact = z.object({
  kind: z.literal("session.compact"),
  providerThreadId: z.string().min(1).max(200),
  baseline: z.object({
    providerUpdatedAt: z.number().nonnegative().nullable(),
    status: z.enum(["active", "idle", "terminal"]),
    activeTurnId: z.string().min(1).max(200).nullable(),
  }).strict(),
  streamEpoch: z.string().uuid(),
  streamSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export const joinedMutationEffectEvidenceSchema = z.discriminatedUnion("kind", [
  send.extend({ runtimeProfile: reviewedRuntimeProfileV1Schema.optional() }),
  steer,
  stop,
  compact,
  rename,
  start.extend({ runtimeProfile: reviewedRuntimeProfileV1Schema.optional() }),
  switched.extend({ runtimeProfile: reviewedRuntimeProfileV1Schema }),
  login,
  claudeLogin,
  devinLogin,
  logout,
  loginCancel,
]);
export const joinedQueueEffectEvidenceSchema = queueEffectEvidence49Schema;
export type JoinedMutationEffectEvidence = z.infer<typeof joinedMutationEffectEvidenceSchema>;
export type JoinedQueueEffectEvidence = z.infer<typeof joinedQueueEffectEvidenceSchema>;
