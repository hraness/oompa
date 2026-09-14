import { z } from "zod";

// PID/group 1 are outside this owned child scope; -1 has broadcast semantics.
const pid = z.number().int().min(2).max(0x7fff_ffff);
const decimal = /^(?:0|[1-9][0-9]{0,19})$/u;
const u64 = z.string().regex(decimal)
  .refine(value => decimal.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);

/** Observation identity only: these values never authorize a saved-PID signal. */
export const nativeProcessIdentitySchema = z.object({
  pid,
  birth: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("darwin-start-time"), seconds: u64,
      micros: z.number().int().min(0).max(999_999) }).strict(),
    z.object({ kind: z.literal("linux-start-ticks"), ticks: u64 }).strict(),
  ]),
}).strict();
export const nativeBootIdentitySchema = z.discriminatedUnion("platform", [
  z.object({ platform: z.literal("darwin"), id: uuid }).strict(),
  z.object({ platform: z.literal("linux"), id: uuid,
    pidNamespace: z.object({ device: u64, inode: u64 }).strict() }).strict(),
]);
/** Stable application-specific host identity and the current OS boot/scope. */
export const nativeHostContextSchema = z.object({
  host: z.object({ platform: z.enum(["darwin", "linux"]),
    digest: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(),
  boot: nativeBootIdentitySchema,
}).strict().refine(value => value.host.platform === value.boot.platform);
const preparedShape = {
  version: z.literal(1), nonce: z.string().regex(/^[0-9a-f]{32}$/u),
  scope: z.literal("posix-process-group"), groupId: pid, boot: nativeBootIdentitySchema,
  supervisor: nativeProcessIdentitySchema, anchor: nativeProcessIdentitySchema,
};
export const nativePreparedSchema = z.object(preparedShape).strict().refine(value =>
  value.groupId === value.anchor.pid && value.supervisor.pid !== value.anchor.pid
  && value.supervisor.birth.kind === (value.boot.platform === "darwin" ? "darwin-start-time" : "linux-start-ticks")
  && value.anchor.birth.kind === value.supervisor.birth.kind);
export const nativeReadySchema = z.object({ ...preparedShape, pid, root: nativeProcessIdentitySchema }).strict()
  .refine(value => nativePreparedSchema.safeParse({ version: value.version, nonce: value.nonce,
    scope: value.scope, groupId: value.groupId, boot: value.boot,
    supervisor: value.supervisor, anchor: value.anchor }).success
    && value.pid === value.root.pid && value.root.pid !== value.anchor.pid
    && value.root.pid !== value.supervisor.pid && value.root.birth.kind === value.supervisor.birth.kind);

export type NativeProcessIdentity = z.infer<typeof nativeProcessIdentitySchema>;
export type NativeBootIdentity = z.infer<typeof nativeBootIdentitySchema>;
export type NativeHostContext = z.infer<typeof nativeHostContextSchema>;
export type NativePrepared = z.infer<typeof nativePreparedSchema>;
export type NativeReady = z.infer<typeof nativeReadySchema>;

export const nativePreparedOfReady = (ready: NativeReady): NativePrepared =>
  nativePreparedSchema.parse({ version: ready.version, nonce: ready.nonce, scope: ready.scope,
    groupId: ready.groupId, boot: ready.boot, supervisor: ready.supervisor, anchor: ready.anchor });
