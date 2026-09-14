import { makeFunctionReference } from "convex/server";
import type { PaginationOptions, PaginationResult } from "convex/server";

import type { CloudAction, CloudMutation, CloudQuery } from "../oompa/cloud";
import type { WireEncryptedEnvelope } from "./wire";

/*
 * Every Convex function this app can reach, named once. The `satisfies`
 * clauses bind each literal to the shared `src/cloud/client.ts` allowlists, so
 * a name that is not an admitted cloud query, mutation, or action fails to
 * compile here instead of failing at runtime in a browser.
 *
 * The generated Convex API is not committed, so these are declared references
 * rather than generated ones, exactly as `src/cloud/client.ts` does.
 */

const accountCurrentName = "account:current" satisfies CloudQuery;
const listHeadsPageName = "sessions:listHeadsPage" satisfies CloudQuery;
const getHeadName = "sessions:getHead" satisfies CloudQuery;
const getChunksName = "sessions:getChunks" satisfies CloudQuery;
const getLatestChunksName = "sessions:getLatestChunks" satisfies CloudQuery;
const currentRegistrationName = "devices:currentRegistration" satisfies CloudQuery;
const listDevicesName = "devices:list" satisfies CloudQuery;
const listRegistriesName = "devices:listRegistries" satisfies CloudQuery;
const presenceCurrentName = "presence:current" satisfies CloudQuery;
const listKeyEnvelopesName = "devices:listKeyEnvelopes" satisfies CloudQuery;
const commandGetName = "commands:get" satisfies CloudQuery;
const commandListForSessionName = "commands:listForSession" satisfies CloudQuery;
const commandListUnacknowledgedName = "commands:listUnacknowledgedForRequester" satisfies CloudQuery;
const deviceCommandGetName = "deviceCommands:get" satisfies CloudQuery;
const deviceCommandListUnacknowledgedName =
  "deviceCommands:listUnacknowledgedForRequester" satisfies CloudQuery;
const usageListAccountsName = "usage:listAccounts" satisfies CloudQuery;
const usageListSnapshotsName = "usage:listSnapshots" satisfies CloudQuery;

const registerName = "devices:register" satisfies CloudMutation;
const beginBindName = "devices:beginBind" satisfies CloudMutation;
const enqueueName = "commands:enqueue" satisfies CloudMutation;
const acknowledgeCommandReceiptName = "commands:acknowledgeReceipt" satisfies CloudMutation;
const enqueueDeviceCommandName = "deviceCommands:enqueue" satisfies CloudMutation;
const acknowledgeDeviceCommandReceiptName =
  "deviceCommands:acknowledgeReceipt" satisfies CloudMutation;
const consumeDeviceCommandResultName = "deviceCommands:consumeResult" satisfies CloudMutation;
const presenceConnectName = "presence:connect" satisfies CloudMutation;
const presenceHeartbeatName = "presence:heartbeat" satisfies CloudMutation;
const presenceDisconnectName = "presence:disconnect" satisfies CloudMutation;

const finishBindName = "devices:finishBind" satisfies CloudAction;

export type WirePresenceArgs = Readonly<{
  connectionId: string;
  credentialGeneration: number;
  fingerprint: string;
  sequence: number;
}>;

export type WireRegisterArgs = Readonly<{
  deviceClass: "browser";
  encryptedLabel: WireEncryptedEnvelope;
  idempotencyKey: string;
  keyVersion: number;
  publicId: string;
  requestDigest: string;
  signingPublicKey: string;
  wrappingPublicKey: string;
}>;

export type WireEnqueueArgs = Readonly<{
  deadline: number;
  expectedRequestingDevicePublicId: string;
  expectedTargetDevicePublicId: string;
  idempotencyKey: string;
  kind: string;
  payload: WireEncryptedEnvelope;
  publicId: string;
  requestCommitmentVersion: 2;
  requestDigest: string;
  sessionPublicId: string;
}>;

export type WireDeviceEnqueueArgs = Readonly<{
  deadline: number;
  expectedRequestingDevicePublicId: string;
  expectedTargetDevicePublicId: string;
  idempotencyKey: string;
  kind: string;
  payload: WireEncryptedEnvelope;
  publicId: string;
  requestCommitmentVersion: 2;
  requestDigest: string;
}>;

export type WireCommandReceiptProofArgs = Readonly<{
  commandPublicId: string;
  idempotencyKey: string;
  requestDigest: string;
}>;

export const accountCurrent =
  makeFunctionReference<"query", Record<string, never>, unknown>(accountCurrentName);

export const listHeadsPage = makeFunctionReference<
  "query",
  { paginationOpts: PaginationOptions },
  PaginationResult<unknown>
>(listHeadsPageName);

export const getHead =
  makeFunctionReference<"query", { publicId: string }, unknown>(getHeadName);

export const getChunks = makeFunctionReference<
  "query",
  { afterSequence: number; limit: number; sessionPublicId: string; stream: "compact" | "detail" },
  unknown
>(getChunksName);

export const getLatestChunks = makeFunctionReference<
  "query",
  { limit: number; sessionPublicId: string; stream: "compact" | "detail" },
  unknown
>(getLatestChunksName);

export const currentRegistration =
  makeFunctionReference<"query", Record<string, never>, unknown>(currentRegistrationName);

export const listDevices =
  makeFunctionReference<"query", Record<string, never>, unknown>(listDevicesName);

export const listRegistries =
  makeFunctionReference<"query", Record<string, never>, unknown>(listRegistriesName);

export const presenceCurrent =
  makeFunctionReference<"query", Record<string, never>, unknown>(presenceCurrentName);

export const listKeyEnvelopes =
  makeFunctionReference<"query", Record<string, never>, unknown>(listKeyEnvelopesName);

export const commandGet =
  makeFunctionReference<"query", { commandPublicId: string }, unknown>(commandGetName);

export const commandListForSession = makeFunctionReference<
  "query",
  { limit: number; sessionPublicId: string },
  unknown
>(commandListForSessionName);

export const commandListUnacknowledged = makeFunctionReference<
  "query",
  { limit: number },
  unknown
>(commandListUnacknowledgedName);

export const deviceCommandGet =
  makeFunctionReference<"query", { commandPublicId: string }, unknown>(deviceCommandGetName);

export const deviceCommandListUnacknowledged = makeFunctionReference<
  "query",
  { limit: number },
  unknown
>(deviceCommandListUnacknowledgedName);

export const usageListAccounts =
  makeFunctionReference<"query", { limit: number }, unknown>(usageListAccountsName);

export const usageListSnapshots = makeFunctionReference<
  "query",
  { accountPublicId: string; limit: number },
  unknown
>(usageListSnapshotsName);

export const registerDevice =
  makeFunctionReference<"mutation", WireRegisterArgs, unknown>(registerName);

export const beginBind = makeFunctionReference<
  "mutation",
  { challengeId: string; devicePublicId: string; nonce: string },
  unknown
>(beginBindName);

export const enqueueCommand =
  makeFunctionReference<"mutation", WireEnqueueArgs, unknown>(enqueueName);

export const acknowledgeCommandReceipt = makeFunctionReference<
  "mutation",
  WireCommandReceiptProofArgs,
  unknown
>(acknowledgeCommandReceiptName);

export const enqueueDeviceCommand =
  makeFunctionReference<"mutation", WireDeviceEnqueueArgs, unknown>(enqueueDeviceCommandName);

export const acknowledgeDeviceCommandReceipt = makeFunctionReference<
  "mutation",
  WireCommandReceiptProofArgs,
  unknown
>(acknowledgeDeviceCommandReceiptName);

/** Exchanges a single-use device command result exactly once. */
export const consumeDeviceCommandResult = makeFunctionReference<
  "mutation",
  { commandPublicId: string },
  unknown
>(consumeDeviceCommandResultName);

export const presenceConnect =
  makeFunctionReference<"mutation", WirePresenceArgs, unknown>(presenceConnectName);

export const presenceHeartbeat =
  makeFunctionReference<"mutation", WirePresenceArgs, unknown>(presenceHeartbeatName);

export const presenceDisconnect =
  makeFunctionReference<"mutation", WirePresenceArgs, unknown>(presenceDisconnectName);

export const finishBind = makeFunctionReference<
  "action",
  { challengeId: string; signature: string },
  unknown
>(finishBindName);
