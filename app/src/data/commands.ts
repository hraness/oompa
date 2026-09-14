import { useConvex, useQuery } from "convex/react";
import { useCallback } from "react";

import { useCustody } from "../custody/custody-context";
import {
  commandPayloadAuthority,
  enqueueRequest,
  enqueueRequestDigest,
} from "../custody/registration";
import { commandLifetimeMs } from "../env";
import { createCloudUuidV7, encryptRemoteCommand, type RemoteCommandPayload } from "../oompa/cloud";
import {
  acknowledgeObservedCommandReceipt,
  parseSessionCommandEnqueueReceipt,
} from "./command-receipts";
import { acknowledgeCommandReceipt, commandGet, enqueueCommand } from "./functions";
import { parseCommandRecord, type CommandRecord } from "./wire";

export type SubmitCommandInput = Readonly<{
  /** The head's `executionDevicePublicId`: the custodian this command binds to. */
  executionDevicePublicId: string;
  payload: RemoteCommandPayload;
  sessionPublicId: string;
}>;

export type SubmitCommand = (input: SubmitCommandInput) => Promise<string>;

/**
 * Encrypts a remote command under the account key and enqueues it.
 *
 * The submission binds the expected custodian device, so a session that moved
 * to another machine between render and submit fails closed instead of running
 * somewhere the browser did not intend. The deadline is five minutes: a command
 * the daemon never picked up expires rather than replaying later.
 */
export function useSubmitCommand(): SubmitCommand {
  const custody = useCustody();
  const convex = useConvex();
  const unlocked = custody.state === "unlocked" ? custody : null;
  const report = custody.reportAuthorityFailure;

  return useCallback(async (input: SubmitCommandInput) => {
    if (unlocked === null) throw new Error("The account key is not open in this tab.");
    const now = Date.now();
    const commandPublicId = createCloudUuidV7(now);
    const idempotencyKey = createCloudUuidV7(now);
    const payload = await encryptRemoteCommand(input.payload, unlocked.key, commandPayloadAuthority({
      commandPublicId,
      keyVersion: unlocked.identity.keyVersion,
      userPublicId: unlocked.identity.userPublicId,
    }));
    const request = enqueueRequest({
      deadline: now + commandLifetimeMs,
      expectedTargetDevicePublicId: input.executionDevicePublicId,
      kind: input.payload.kind,
      payload,
      publicId: commandPublicId,
      sessionPublicId: input.sessionPublicId,
    });
    const requestDigest = await enqueueRequestDigest(
      unlocked.key,
      request,
      unlocked.identity.devicePublicId,
    );
    const wireRequest = {
      ...request,
      expectedRequestingDevicePublicId: unlocked.identity.devicePublicId,
      idempotencyKey,
      requestCommitmentVersion: 2 as const,
      requestDigest,
    };
    let response: unknown;
    try {
      response = await convex.mutation(enqueueCommand, wireRequest);
    } catch (failure: unknown) {
      report(failure);
      throw failure;
    }
    const proof = parseSessionCommandEnqueueReceipt(response, wireRequest);
    // A resolved Convex mutation is committed even when a rolling-deployment
    // mismatch makes its success body incompatible. Do not bind the original
    // request proof to response authority we could not validate, but do return
    // the generated identity: existing
    // session-command callers otherwise present a retry that could create a
    // second effect. The mounted requester-only recovery query supplies the
    // authoritative proof and completes acknowledgement without an enqueue.
    if (proof !== null) {
      try {
        await acknowledgeObservedCommandReceipt(
          proof,
          async (args) => await convex.mutation(acknowledgeCommandReceipt, args),
        );
      } catch (failure: unknown) {
        // The enqueue is already committed. Returning its identity prevents a
        // user retry from creating a second provider effect; the mounted
        // requester-only recovery query will retry this exact acknowledgement.
        report(failure);
      }
    }
    return commandPublicId;
  }, [convex, report, unlocked]);
}

export function useCommandState(commandPublicId: string | null): CommandRecord | null {
  const value = useQuery(
    commandGet,
    commandPublicId === null ? "skip" : { commandPublicId },
  );
  if (value === undefined || value === null) return null;
  return parseCommandRecord(value);
}
