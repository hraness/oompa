import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const uuid = z.string().uuid();
const path = z.string().min(2).max(4096).refine((value) => isAbsolute(value) && resolve(value) === value
  && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127));
const sha = z.string().regex(/^[0-9a-f]{40}$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const privateDirectoryIdentity = z.strictObject({ device: z.number().int().nonnegative().safe(),
  inode: z.number().int().positive().safe(), owner: z.number().int().nonnegative().safe() });
export const daemonQualificationStageSchema = z.enum(["A", "B", "C"]);
export type DaemonQualificationStage = z.infer<typeof daemonQualificationStageSchema>;

/** This is a private parent-to-child description, never a public CLI selector. */
export const daemonQualificationDescriptorSchema = z.strictObject({
  version: z.literal(1), purpose: z.literal("authenticated_personal_daemon_restart"),
  runId: uuid, ownerEpoch: uuid, stage: daemonQualificationStageSchema,
  repositoryRoot: path, sourceCommit: sha, sourceTree: sha,
  executablePath: path, executableSha256: digest, ownerHome: path,
  runRoot: z.string().regex(/^\/private\/tmp\/oompa-md-[A-Za-z0-9]{6}$/u),
  directories: z.strictObject({ root: privateDirectoryIdentity, profile: privateDirectoryIdentity,
    temporary: privateDirectoryIdentity, project: privateDirectoryIdentity, state: privateDirectoryIdentity }),
  providerThreadId: uuid, normalNonceA: uuid, normalNonceB: uuid, acknowledgmentLossNonce: uuid,
}).refine((value) => new Set([value.normalNonceA, value.normalNonceB, value.acknowledgmentLossNonce]).size === 3);
export type DaemonQualificationDescriptor = Readonly<z.infer<typeof daemonQualificationDescriptorSchema>>;
export function daemonQualificationPaths(root: string) {
  if (!/^\/private\/tmp\/oompa-md-[A-Za-z0-9]{6}$/u.test(root)) throw new Error("DARWIN_DAEMON_SCOPE_REFUSED");
  return Object.freeze({ root, profile: join(root, "profile"), temporary: join(root, "temporary"),
    project: join(root, "project"), state: join(root, "state") });
}
export function daemonQualificationPrompt(nonce: string): string {
  uuid.parse(nonce);
  return `Oompa's authorized isolated daemon restart test. Reply with exactly OOMPA_DAEMON_${nonce}. Do not invoke any tool or modify any file.`;
}
export function daemonQualificationIdempotencyKey(descriptor: DaemonQualificationDescriptor): string {
  return descriptor.acknowledgmentLossNonce;
}
const processIdentity = z.strictObject({ pid: z.number().int().positive().max(2147483647), pidDomain: z.literal("darwin"),
  procStart: z.string().min(1).max(128).refine((value) => value.trim() === value && !/[\r\n\0]/u.test(value)) });
export const daemonQualificationProcessSummarySchema = z.strictObject({
  version: z.literal(1), runId: uuid, stage: daemonQualificationStageSchema,
  daemonGeneration: z.number().int().positive().safe().nullable(), userWriteAttempts: z.number().int().min(0).max(3),
  acceptedUserWrites: z.number().int().min(0).max(2), acknowledgmentWithheld: z.boolean(),
  runtimeRequestAttempts: z.number().int().min(0).max(33), providerLaunchAttempts: z.number().int().min(0).max(2),
  observationViolation: z.boolean(),
  providerIdentity: processIdentity.nullable(), providerRootCollected: z.boolean(),
  providerStdoutEof: z.boolean(), providerStderrEof: z.boolean(),
  runtimeObserversJoined: z.boolean(), identityInspectorsJoined: z.boolean(),
  operationFailure: z.boolean(), collection: z.enum(["joined", "uncertain"]),
}).refine((value) => value.acceptedUserWrites <= value.userWriteAttempts
  && (!value.acknowledgmentWithheld || (value.stage === "B" && value.acceptedUserWrites === 2 && value.operationFailure))
  && (value.collection !== "joined" || (value.providerRootCollected && value.providerStdoutEof && value.providerStderrEof
    && value.runtimeObserversJoined && value.identityInspectorsJoined)));

export type DaemonQualificationProcessSummary = Readonly<z.infer<typeof daemonQualificationProcessSummarySchema>>;
export const daemonQualificationChildResultSchema = z.strictObject({
  version: z.literal(1), purpose: z.literal("authenticated_personal_daemon_restart"),
  runId: uuid, stage: daemonQualificationStageSchema,
  outcome: z.enum(["stopped", "refused"]), process: daemonQualificationProcessSummarySchema,
}).refine((value) => value.runId === value.process.runId && value.stage === value.process.stage
  && (value.outcome !== "stopped" || (value.process.collection === "joined" && !value.process.observationViolation)));
