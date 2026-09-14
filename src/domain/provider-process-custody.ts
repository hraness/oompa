import { z } from "zod";

import { snapshotForeignJson } from "./guards";
import { nativeHostContextSchema, nativePreparedSchema, nativeReadySchema } from "./native-process-identity";
import { providerAccountAuthoritySchema } from "./provider-accounts";
import { unixMillisecondsSchema } from "./values";

export const providerProcessNonceSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const providerProcessDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const decimal = /^(?:0|[1-9][0-9]{0,19})$/u;
const u64 = z.string().regex(decimal).refine(value => decimal.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn);
export const providerProcessFileIdentitySchema = z.object({ device: u64, inode: u64 }).strict();
export const providerProcessLocalFilesSchema = z.object({
  authority: providerProcessFileIdentitySchema, state: providerProcessFileIdentitySchema,
}).strict();
export const providerProcessLaunchContextSchema = z.object({
  ...nativeHostContextSchema.shape, localFiles: providerProcessLocalFilesSchema,
}).strict().refine(value => value.host.platform === value.boot.platform);
export type ProviderProcessFileIdentity = z.infer<typeof providerProcessFileIdentitySchema>;
export type ProviderProcessLaunchContext = z.infer<typeof providerProcessLaunchContextSchema>;
export type ProviderProcessLocalFiles = z.infer<typeof providerProcessLocalFilesSchema>;

export const providerProcessDaemonSchema = z.object({
  daemonGeneration: z.number().int().positive().safe(),
  bootId: z.string().regex(/^boot_[0-9a-f]{32}$/u),
}).strict();
export const providerProcessPriorDaemonSchema = z.object({
  generation: z.number().int().nonnegative().safe(), bootId: z.string().max(128).nullable(),
  stoppedAt: unixMillisecondsSchema.nullable(),
}).strict();
export const providerProcessRecoveryActorSchema = z.object({
  kind: z.literal("startup-recovery"), authorityNonce: z.string().uuid(),
  previousDaemon: providerProcessPriorDaemonSchema,
}).strict();
export type ProviderProcessPriorDaemon = z.infer<typeof providerProcessPriorDaemonSchema>;
export type ProviderProcessRecoveryActor = z.infer<typeof providerProcessRecoveryActorSchema>;
export type ProviderProcessRecoverySnapshot = Readonly<{
  previousDaemon: ProviderProcessPriorDaemon; state: ProviderProcessFileIdentity;
}>;
/** Minimal held-lock port; a capability remains bound to this exact object. */
export interface ProviderProcessRecoveryStore {
  readonly paths: Readonly<{ daemonLock: string }>;
  providerProcessRecoverySnapshot(): ProviderProcessRecoverySnapshot;
  assertProviderProcessRecoverySnapshot(expected: ProviderProcessRecoverySnapshot): void;
}

declare const recoveryAuthorityBrand: unique symbol;
export type DaemonRecoveryAuthority = Readonly<{
  [recoveryAuthorityBrand]: true;
  assertCurrent(): Promise<void>;
}>;
type RecoveryAuthorityBinding = Readonly<{
  store: ProviderProcessRecoveryStore; actor: ProviderProcessRecoveryActor; localFiles: ProviderProcessLocalFiles;
  assertHeld: () => void;
}>;
const recoveryAuthorities = new WeakMap<DaemonRecoveryAuthority, RecoveryAuthorityBinding>();

/** Trusted held-lock composition seam. DaemonLock is the sole production issuer;
 * no RPC, JSON input or historical record can supply its private held closure. */
export function issueDaemonRecoveryAuthority(input: RecoveryAuthorityBinding & {
  assertCurrent: () => Promise<void>;
}): DaemonRecoveryAuthority {
  const { store, assertHeld, assertCurrent } = input;
  const actor = providerProcessRecoveryActorSchema.parse(input.actor);
  const localFiles = providerProcessLocalFilesSchema.parse(input.localFiles);
  const authority = Object.freeze({ assertCurrent: async () => {
    await assertCurrent();
    assertHeld();
  } }) as DaemonRecoveryAuthority;
  assertHeld();
  recoveryAuthorities.set(authority, { store, actor, localFiles, assertHeld });
  return authority;
}

/** Membership and exact store identity are checked before any protected effect. */
export function readDaemonRecoveryAuthority(authority: DaemonRecoveryAuthority,
  store: ProviderProcessRecoveryStore): Readonly<{
  actor: ProviderProcessRecoveryActor; localFiles: ProviderProcessLocalFiles;
}> {
  const binding = recoveryAuthorities.get(authority);
  if (binding === undefined || binding.store !== store) throw new Error("Wrong daemon recovery authority.");
  binding.assertHeld();
  return { actor: structuredClone(binding.actor), localFiles: structuredClone(binding.localFiles) };
}
export const providerProcessReservationSchema = z.object({
  nonce: providerProcessNonceSchema,
  providerAuthority: providerAccountAuthoritySchema.refine(value => value.provider !== "devin"),
  profileGeneration: z.number().int().nonnegative().safe(),
  runtimeScope: z.enum(["managed", "personal"]),
  daemon: providerProcessDaemonSchema,
  artifactDigest: providerProcessDigestSchema,
  runtimeDigest: providerProcessDigestSchema,
  launchContext: providerProcessLaunchContextSchema,
}).strict();
export type ProviderProcessReservation = z.infer<typeof providerProcessReservationSchema>;
export type ProviderProcessDaemon = z.infer<typeof providerProcessDaemonSchema>;

const evidenceShape = {
  nonce: providerProcessNonceSchema, bindingDigest: providerProcessDigestSchema,
  expectedRevision: z.number().int().min(1).max(5), observedAt: unixMillisecondsSchema,
};
const committedShape = { committedPrepared: nativePreparedSchema.nullable(), committedReady: nativeReadySchema.nullable() };
const recoveryShape = {
  ...evidenceShape, actor: providerProcessRecoveryActorSchema,
  observedContext: providerProcessLaunchContextSchema,
};
/** The live handle's exact observation is distinct from successfully committed snapshots. */
export const providerProcessNativeSettlementSchema = z.object({
  kind: z.enum(["joined", "not-started"]),
  binding: z.object({ version: z.literal(1), nonce: providerProcessNonceSchema,
    scope: z.literal("posix-process-group") }).strict(),
  prepared: nativePreparedSchema.nullable(), ready: nativeReadySchema.nullable(),
}).strict();
/** Retained evidence describes closure or a logical fence; parsing grants no proof capability. */
export const providerProcessReleaseEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({ ...evidenceShape, ...committedShape, kind: z.literal("native-settled"),
    actor: z.object({ kind: z.literal("live-daemon"), daemon: providerProcessDaemonSchema }).strict(),
    observed: providerProcessNativeSettlementSchema }).strict(),
  z.object({ ...recoveryShape, kind: z.literal("activation-never-admitted") }).strict(),
  z.object({ ...recoveryShape, ...committedShape, kind: z.literal("scope-absent") }).strict(),
  z.object({ ...recoveryShape, ...committedShape, kind: z.literal("boot-ended") }).strict(),
]);
export type ProviderProcessReleaseEvidence = z.infer<typeof providerProcessReleaseEvidenceSchema>;
type LiveEvidence = Extract<ProviderProcessReleaseEvidence, { kind: "native-settled" }>;
type RecoveryEvidence = Extract<ProviderProcessReleaseEvidence, { kind: "scope-absent" | "boot-ended" }>;
type ProofIssuer<T> = Readonly<{ issue: (observation: T) => ProviderProcessReleaseProof }>;

declare const releaseProofBrand: unique symbol;
export type ProviderProcessReleaseProof = Readonly<{ [releaseProofBrand]: true }>;
const releaseProofs = new WeakMap<ProviderProcessReleaseProof, ProviderProcessReleaseEvidence>();

/**
 * Trusted composition capability, retained only by the live native handle or
 * admitted observation owner. Never expose it to RPC or mint from historical
 * JSON. Logical no-activation evidence is issued by held-lock storage recovery.
 */
export function createProviderProcessReleaseProofIssuer(owner: "live-process"): ProofIssuer<LiveEvidence>;
export function createProviderProcessReleaseProofIssuer(owner: "recovery"): ProofIssuer<RecoveryEvidence>;
export function createProviderProcessReleaseProofIssuer(owner: "live-process" | "recovery"): ProofIssuer<LiveEvidence | RecoveryEvidence> {
  const role = z.enum(["live-process", "recovery"]).parse(owner);
  return Object.freeze({ issue(observation: LiveEvidence | RecoveryEvidence): ProviderProcessReleaseProof {
    const snapshot = snapshotForeignJson(observation);
    if (!snapshot.ok) throw new Error("PROVIDER_PROCESS_CUSTODY_UNPROVED");
    const evidence = providerProcessReleaseEvidenceSchema.parse(snapshot.value);
    if (evidence.kind === "activation-never-admitted"
      || (role === "live-process") !== (evidence.kind === "native-settled")) throw new Error("PROVIDER_PROCESS_CUSTODY_UNPROVED");
    const proof = Object.freeze({}) as ProviderProcessReleaseProof;
    releaseProofs.set(proof, evidence);
    return proof;
  } });
}
export function readProviderProcessReleaseProof(proof: ProviderProcessReleaseProof): ProviderProcessReleaseEvidence {
  const evidence = releaseProofs.get(proof);
  if (evidence === undefined) throw new Error("PROVIDER_PROCESS_CUSTODY_UNPROVED");
  return providerProcessReleaseEvidenceSchema.parse(evidence);
}

/** Released means the provider-writer barrier is released; evidence names its exact proof. */
export type ProviderProcessInvocation = Readonly<ProviderProcessReservation & {
  bindingDigest: string;
  state: "reserved" | "prepared" | "running" | "releasing" | "released";
  revision: number;
  prepared: z.infer<typeof nativePreparedSchema> | null;
  ready: z.infer<typeof nativeReadySchema> | null;
  releaseEvidence: ProviderProcessReleaseEvidence | null;
  createdAt: number;
  updatedAt: number;
  releasedAt: number | null;
}>;
export type ProviderProcessTransition = Readonly<{
  nonce: string; expectedRevision: number; daemon: ProviderProcessDaemon;
}>;
export type ProviderProcessRecoveryTransition = Readonly<{ nonce: string; expectedRevision: number }>;
