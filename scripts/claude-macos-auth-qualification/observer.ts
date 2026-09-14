import { posix } from "node:path";
import { z } from "zod";
import { readClaudeAccountMetadataIdentity } from "../../src/claude/account.ts";
import { capturePrivateClaudeMetadataIdentity, captureQualificationJoinedStatus, containsAsciiControl, projectPrivateClaudeIdentity } from "./identity.ts";
import type { PrivateIdentityObservation, QualificationJoinedStatus } from "./identity.ts";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
const requestSchema = z.strictObject({ key: z.instanceof(Uint8Array).refine((value) => value.byteLength === 32),
  runId: uuid, attemptId: uuid, probeId: uuid, profile: z.enum(["A", "B"]),
  configDir: z.string().min(2).max(4_096).refine((value) => value.startsWith("/") && posix.normalize(value) === value && !containsAsciiControl(value)),
  deadlineMs: z.number().int().min(3_000).max(5_000), signal: z.instanceof(AbortSignal) });
export type PrivateIdentityProbeRequest = z.infer<typeof requestSchema>;
export type QualificationJoinedStatusPort = (request: Readonly<Omit<PrivateIdentityProbeRequest, "key">>) => Promise<QualificationJoinedStatus>;
export type QualificationMetadataIdentityReader = (input: Readonly<{ configDir: string; configHome: "isolated" }>) => Promise<unknown>;
export type PrivateIdentityObserverPorts = Readonly<{
  probeJoinedStatus: QualificationJoinedStatusPort;
  readMetadataIdentity?: QualificationMetadataIdentityReader;
}>;
export class QualificationObserverError extends Error {
  constructor(readonly code: "invalid_input" | "aborted" | "metadata_unavailable" | "status_unavailable" | "deadline_mismatch") {
    super(`CLAUDE_MACOS_QUALIFICATION_${code}`);
    this.name = "QualificationObserverError";
  }
}
const fail = (code: QualificationObserverError["code"]): never => { throw new QualificationObserverError(code); };
const checkAbort = (signal: AbortSignal): void => { if (signal.aborted) fail("aborted"); };

/**
 * Two genuine scalar reads around one joined status. There is no native default
 * status port, CLI, owner acquisition or credential effect in this composition.
 * Tests inject both ports. The default scalar reader has bounded/no-follow IO;
 * its existing ignored close errors do not establish descriptor-close proof.
 */
export async function observePrivateClaudeIdentity(input: PrivateIdentityProbeRequest, ports: PrivateIdentityObserverPorts): Promise<PrivateIdentityObservation> {
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success || typeof ports.probeJoinedStatus !== "function") return fail("invalid_input");
  const request = parsed.data;
  const key = Uint8Array.from(request.key);
  let status: QualificationJoinedStatus | undefined;
  try {
    const readIdentity = ports.readMetadataIdentity ?? readClaudeAccountMetadataIdentity;
    const read = async () => {
      checkAbort(request.signal);
      let value: unknown;
      try { value = await readIdentity({ configDir: request.configDir, configHome: "isolated" }); }
      catch { return fail(request.signal.aborted ? "aborted" : "metadata_unavailable"); }
      checkAbort(request.signal);
      // Snapshot before the next await, including for mutable synthetic port data.
      return capturePrivateClaudeMetadataIdentity(value);
    };
    const before = await read();
    checkAbort(request.signal);
    let observed: QualificationJoinedStatus;
    try {
      observed = await ports.probeJoinedStatus({ runId: request.runId, attemptId: request.attemptId, probeId: request.probeId,
        profile: request.profile, configDir: request.configDir, deadlineMs: request.deadlineMs, signal: request.signal });
    } catch { return fail(request.signal.aborted ? "aborted" : "status_unavailable"); }
    checkAbort(request.signal);
    // A future native mapping must require admitted + cleanup=joined, and retain
    // detachment evidence separately. These fields alone cannot admit a process.
    status = captureQualificationJoinedStatus(observed);
    if (status.deadlineMs !== request.deadlineMs) return fail("deadline_mismatch");
    const after = await read();
    checkAbort(request.signal);
    return projectPrivateClaudeIdentity({ key, runId: request.runId, attemptId: request.attemptId, probeId: request.probeId,
      profile: request.profile, configDir: request.configDir, before, after, status });
  } finally {
    key.fill(0);
    status?.stdout.fill(0);
  }
}
