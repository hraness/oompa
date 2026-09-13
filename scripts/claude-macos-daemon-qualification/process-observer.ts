import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

import { IndeterminateClaudeEffectError } from "../../src/claude/errors";
import { claudeInterruptLine, claudeUserLine } from "../../src/claude/protocol";
import type { ClaudeProcessIdentity } from "../../src/claude/process";
import type { LiveAcceptancePersonalClaudeProofPort } from "../../src/daemon/live-acceptance-personal-claude";
import { captureNativeClaudeMacosAdmission } from "../claude-macos-auth-qualification/admission";
import { bindDarwinQualificationEnvironment } from "../claude-macos-auth-process/binding";
import { AtomicPrivateJsonReceipt } from "../live-acceptance-private-custody";
import {
  daemonQualificationDescriptorSchema, daemonQualificationPaths, daemonQualificationProcessSummarySchema,
  daemonQualificationPrompt, type DaemonQualificationProcessSummary,
} from "./contract";

function refused(): never { throw new Error("DARWIN_DAEMON_PROCESS_OBSERVATION_REFUSED"); }

/** Pure attempted-operation ledger; it cannot grant runtime or launch authority. */
export class DaemonQualificationAttemptLedger {
  readonly #stage: "A" | "B" | "C";
  #runtimeRequests = 0;
  #launchAttempts = 0;
  #violation = false;
  constructor(stage: unknown) { this.#stage = z.enum(["A", "B", "C"]).parse(stage); }
  runtimeRequested(): void {
    this.#runtimeRequests += 1;
    if (this.#stage === "C" || this.#runtimeRequests > 32 || this.#violation) this.refuse();
  }
  launchAttempted(): void {
    this.#launchAttempts += 1;
    if (this.#stage === "C" || this.#launchAttempts > 1 || this.#violation) this.refuse();
  }
  refuse(): never { this.#violation = true; return refused(); }
  snapshot() { return Object.freeze({ runtimeRequestAttempts: this.#runtimeRequests,
    providerLaunchAttempts: this.#launchAttempts, observationViolation: this.#violation }); }
}

/** Closed native observer composition. It never creates a substitute process. */
export async function createPersonalClaudeDaemonProof(input: unknown): Promise<Readonly<{
  port: LiveAcceptancePersonalClaudeProofPort;
  snapshot(): DaemonQualificationProcessSummary;
}>> {
  const descriptor = daemonQualificationDescriptorSchema.parse(input);
  if (descriptor.ownerHome !== homedir()) refused();
  const paths = daemonQualificationPaths(descriptor.runRoot);
  const admission = captureNativeClaudeMacosAdmission({ repositoryRoot: descriptor.repositoryRoot,
    sourceCommit: descriptor.sourceCommit, executablePath: descriptor.executablePath });
  if (admission.source.sourceTree !== descriptor.sourceTree
    || admission.artifactProvenance.executableSha256 !== descriptor.executableSha256) refused();
  const binding = bindDarwinQualificationEnvironment({ executablePath: descriptor.executablePath,
    executableSha256: descriptor.executableSha256, configDir: paths.profile, temporaryDirectory: paths.temporary,
    environment: { HOME: descriptor.ownerHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C", LC_ALL: "C", TMPDIR: "/private/tmp" } });
  const assertScope = () => {
    admission.assertCurrent(); binding.assertCurrent();
    for (const name of ["root", "profile", "temporary", "project", "state"] as const) {
      const current = lstatSync(paths[name]); const expected = descriptor.directories[name];
      if (!current.isDirectory() || current.uid !== expected.owner || current.dev !== expected.device
        || current.ino !== expected.inode || (current.mode & 0o7777) !== 0o700 || realpathSync(paths[name]) !== paths[name]) refused();
    }
  };
  assertScope();
  const attempts = new DaemonQualificationAttemptLedger(descriptor.stage);
  let generation: number | null = null;
  let closed = false;
  let runtimePending = false;
  let runtimeUncertain = false;
  let launchPending = false;
  let identity: ClaudeProcessIdentity | null = null;
  let identityUncertain = false;
  let rootCollected = false;
  let stdoutEof = false;
  let stderrEof = false;
  let userWriteAttempts = 0;
  let acceptedUserWrites = 0;
  let acknowledgmentWithheld = false;
  let operationFailure = false;
  let framePending: string | null = null;
  let finalized = false;
  const assertOpen = () => { assertScope(); if (closed || generation === null) refused(); };
  const snapshot = (): DaemonQualificationProcessSummary => {
    const noProvider = !launchPending;
    return Object.freeze(daemonQualificationProcessSummarySchema.parse({ version: 1, runId: descriptor.runId,
      stage: descriptor.stage, ...attempts.snapshot(), daemonGeneration: generation, userWriteAttempts, acceptedUserWrites, acknowledgmentWithheld,
      providerIdentity: identity, providerRootCollected: noProvider || rootCollected,
      providerStdoutEof: noProvider || stdoutEof, providerStderrEof: noProvider || stderrEof,
      runtimeObserversJoined: !runtimePending && !runtimeUncertain, identityInspectorsJoined: !identityUncertain,
      operationFailure, collection: (!runtimePending && !runtimeUncertain && !identityUncertain
        && (noProvider || (identity !== null && rootCollected && stdoutEof && stderrEof))) ? "joined" : "uncertain" }));
  };
  const receipt = await AtomicPrivateJsonReceipt.create(snapshot(), {
    path: () => join(paths.root, `daemon-${descriptor.stage}-process.json`), maximumBytes: 4096,
    parse: (value) => { const parsed = daemonQualificationProcessSummarySchema.parse(value);
      if (parsed.runId !== descriptor.runId || parsed.stage !== descriptor.stage) refused(); return parsed; },
    invalid: () => new Error("DARWIN_DAEMON_PROCESS_RECEIPT_REFUSED"),
    assertRuntime: async () => { assertScope(); },
    createdIdentityMatches: () => !finalized,
  });
  const port: LiveAcceptancePersonalClaudeProofPort = Object.freeze({
    executablePath: descriptor.executablePath, environment: binding.environment,
    beginDaemonGeneration(value) {
      assertScope(); if (closed || generation !== null || !Number.isSafeInteger(value) || value < 1) refused();
      generation = value;
    },
    assertRuntimeRequest(value) {
      attempts.runtimeRequested();
      assertOpen();
      if (runtimePending || runtimeUncertain || value.configHome !== "isolated" || value.configDir !== paths.profile
        || value.executablePath !== undefined || value.environment !== undefined || value.signal?.aborted === true) refused();
      runtimePending = true;
    },
    runtimeAdmitted(value) {
      if (!runtimePending) refused(); runtimePending = false;
      if (value.executablePath !== descriptor.executablePath || value.version !== "2.1.260") refused();
      assertOpen();
    },
    runtimeFailed() { runtimePending = false; runtimeUncertain = true; operationFailure = true; },
    prepareLaunch(value) {
      attempts.launchAttempted();
      assertOpen();
      if (launchPending || runtimePending || runtimeUncertain || descriptor.stage === "C" || value.launch !== "resume"
        || value.configHome !== "isolated" || value.configDir !== paths.profile || value.projectRoot !== paths.project
        || value.runtime.executablePath !== descriptor.executablePath || value.runtime.version !== "2.1.260"
        || value.argv[0] !== descriptor.executablePath || value.argv.at(-1) !== descriptor.providerThreadId) refused();
      // This is set before the product's synchronous spawn. If spawn or its
      // identity inspector throws, no later empty-set census can imply join.
      launchPending = true; identityUncertain = true;
      return Object.freeze({
        identity(value: ClaudeProcessIdentity) {
          if (identity !== null || value.pidDomain !== "darwin") refused();
          identity = Object.freeze({ ...value }); identityUncertain = false;
        },
        identityFailed() { identityUncertain = true; },
        rootExited() { rootCollected = true; },
        streamEnded(channel: "stdout" | "stderr") { if (channel === "stdout") stdoutEof = true; else stderrEof = true; },
        assertWrite(bytes: Uint8Array) {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (bytes.byteLength < 1 || bytes.byteLength > 65536 || !text.endsWith("\n") || text.slice(0, -1).includes("\n")) refused();
          const value: unknown = JSON.parse(text);
          const user = typeof value === "object" && value !== null && "type" in value && value.type === "user";
          if (user) {
            userWriteAttempts += 1;
            if (userWriteAttempts > 3) refused();
            assertOpen();
            const expectedNonce = descriptor.stage === "A" && userWriteAttempts === 1 ? descriptor.normalNonceA
              : descriptor.stage === "B" && userWriteAttempts === 1 ? descriptor.normalNonceB
              : descriptor.stage === "B" && userWriteAttempts === 2 ? descriptor.acknowledgmentLossNonce : null;
            if (expectedNonce === null || acknowledgmentWithheld || framePending !== null
              || text !== claudeUserLine(daemonQualificationPrompt(expectedNonce))) {
              operationFailure = true; refused();
            }
            framePending = text;
          } else {
            // The only control frame this fixed no-tool ceremony permits is
            // the product's ordinary exact interrupt while closing its child.
            const request = z.strictObject({ type: z.literal("control_request"), request_id: z.string().uuid(),
              request: z.strictObject({ subtype: z.literal("interrupt") }) }).parse(value);
            assertScope(); if (text !== claudeInterruptLine(request.request_id)) refused();
          }
        },
        writeAccepted(bytes: Uint8Array) {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (framePending === null) return;
          if (text !== framePending) { operationFailure = true; refused(); }
          framePending = null; acceptedUserWrites += 1;
          if (descriptor.stage === "B" && acceptedUserWrites === 2) {
            acknowledgmentWithheld = true; operationFailure = true;
            // This runs only after the original child's write promise fulfilled.
            // Remote receipt or completion remains deliberately unestablished.
            throw new IndeterminateClaudeEffectError("write");
          }
        },
      });
    },
    observeWrites() { assertScope(); return Object.freeze({ userWriteAttempts, acceptedUserWrites, acknowledgmentWithheld }); },
    closeAdmission() { closed = true; },
    async closeDaemonGeneration(value) {
      closed = true;
      if (finalized || value !== generation) refused();
      assertScope(); const summary = snapshot();
      await receipt.update(() => summary); finalized = true;
      receipt.assertVerifiedIdentity();
      if (summary.collection !== "joined") refused();
    },
  });
  return Object.freeze({ port, snapshot });
}
