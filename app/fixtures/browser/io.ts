/** Test-only IO boundaries. No presentation or model module is replaced. */
import { initialSessionModel } from "../../src/model/session-model";
import type { Custody } from "../../src/custody/custody-context";
import type { SessionHead } from "../../src/data/wire";
import type { SessionHeadsPage } from "../../src/data/session-heads";
import type { SessionModelView } from "../../src/data/session-model-hook";
import type * as Heads from "../../src/data/session-heads";
import type * as Models from "../../src/data/session-model-hook";
import type { DeviceRegistries } from "../../src/data/registry";
import type * as Commands from "../../src/data/commands";
import type * as DeviceCommands from "../../src/data/device-commands";
import type * as Devices from "../../src/data/devices";
import type * as Archived from "../../src/data/archived-sessions";
import type * as Auth from "@convex-dev/auth/react";
import type * as Usage from "../../src/data/usage";
import { usageOverview } from "../product/usage";

const now = 1_780_000_000_000;
const noop = () => undefined;
const refuse = async (): Promise<never> => { throw new Error("Browser fixture has no command authority."); };
const retired = () => new URLSearchParams(location.search).get("view") === "retired";

export const browserHead: SessionHead = {
  compactHeadSequence: 2, compactStreamEpoch: 1, createdAt: now,
  detailHeadSequence: 0, detailStreamEpoch: null,
  executionDevicePublicId: "device_browser_fixture", metadata: null,
  metadataRevision: 1, projectionRevision: 1, publicId: "session_browser_fixture",
  state: "active", updatedAt: now,
};
const heads: SessionHeadsPage = { heads: [browserHead,
  { ...browserHead, publicId: "session_browser_fixture_second" },
  { ...browserHead, publicId: "session_browser_fixture_third" },
], isLoading: false, loadMore: noop, status: "Exhausted" };
export const useSessionHeads: typeof Heads.useSessionHeads = () => heads;
export const useSessionHead: typeof Heads.useSessionHead = () => browserHead;

const model = {
  ...initialSessionModel(), lastActivityAt: now, lastPrompt: "Review the browser fixture",
  state: "working" as const, title: "Browser fixture session", turnActive: true, turnId: "fixture-turn",
};
const view: SessionModelView = {
  compactEvents: [
    { kind: "user_message", sequence: 1, text: "Review the browser fixture", turnId: "fixture-turn" },
    { kind: "assistant_message", sequence: 2, text: "Fixture transcript: **compiled presentation** and `native controls`.\n\n- First result\n- Second result", turnId: "fixture-turn" },
  ],
  historyLoading: false, liveModel: model, metadata: { archived: false, name: model.title, note: null }, model,
};
export const useSessionModel: typeof Models.useSessionModel = () => retired()
  ? { ...view, metadata: { ...view.metadata, retiredProvider: "devin" } }
  : new URLSearchParams(location.search).get("view") === "session-long" ? longView : view;

const longView: SessionModelView = {
  ...view,
  compactEvents: [...view.compactEvents, ...Array.from({ length: 60 }, (_, index) => ({
    kind: "assistant_message" as const, sequence: index + 3,
    text: `Transcript row ${String(index + 1)}. A bounded long-history fixture exercises scrolling without replacing the renderer.\n\n> Quoted evidence\n\n- First result\n- Second result`,
    turnId: `fixture-history-${String(index)}`,
  }))],
};

const registries: DeviceRegistries = {
  error: null, loading: false, memorySummaryReady: true, now, machines: [{
    accountLinkingAllowed: false,
    accounts: [{ label: "Fixture account", provider: "codex", publicId: "account_browser_fixture", status: "signed_in" }],
    attentionEmailEnabled: null, daemonVersion: "0.7.0", defaultApprovalMode: "manual", defaultPreset: "ultra",
    defaultProjectPublicId: null, deviceCommandsAllowed: true, devicePublicId: browserHead.executionDevicePublicId, deviceStatus: "active",
    heartbeatAt: now, label: "Fixture machine", online: true,
    memorySummary: null, memorySummaryFreshness: "unsupported",
    notificationHours: null, notificationHoursStatus: "unsupported", notificationPolicyFreshness: "unsupported",
    notificationPolicyRevision: null, projects: [{ label: "Fixture project", publicId: "project_browser_fixture" }],
    profileBinding: {
      profile: { effort: "ultra", key: "codex:gpt-6-astra:ultra", model: "gpt-6-astra", provider: "codex" },
      status: "current",
    },
    proseAutorespondConfigured: false, revision: 1, scheduledTasks: [], sessionAdoption: null,
    showThinkingDefault: false, updatedAt: now,
  }],
};
export const useDeviceRegistries = (): DeviceRegistries => registries;
export const useDevices: typeof Devices.useDevices = () => ({ devices: [], loading: false });
export const useServerClock: typeof Devices.useServerClock = () => ({ now, ready: true });
export const useServerNow: typeof Devices.useServerNow = () => now;
export const useArchivedSessions: typeof Archived.useArchivedSessions = () => [];
export const useSubmitCommand: typeof Commands.useSubmitCommand = () => refuse;
export const useCommandState: typeof Commands.useCommandState = () => null;
export const useSubmitDeviceCommand: typeof DeviceCommands.useSubmitDeviceCommand = () => refuse;
export const useReadDeviceCommandResult: typeof DeviceCommands.useReadDeviceCommandResult = () => refuse;
export const useConsumeDeviceCommandResult: typeof DeviceCommands.useConsumeDeviceCommandResult = () => refuse;
export const useDeviceCommandTracker: typeof DeviceCommands.useDeviceCommandTracker = () => ({
  observation: { protocolWarning: null, record: null, status: "idle" }, setHandle: noop,
});
// These error types belong to the replaced transport, never to presentation.
export class DeviceCommandConsumePrecommitError extends Error {}
export class DeviceCommandConsumedResultUnreadableError extends Error {}
export class DeviceCommandResponseInvalidError extends Error {}
export const deviceCommandCommittedRowUnavailableMessage = "Fixture command is unavailable.";

export const useAuthActions: typeof Auth.useAuthActions = () => ({ signIn: refuse, signOut: refuse });
export function useCustody(): Custody {
  return {
    busy: false, devicePublicId: null, enroll: refuse, enrollment: "needs_registration",
    error: null, fingerprint: null, refresh: refuse, reportAuthorityFailure: noop,
    state: "unenrolled", unlock: refuse,
  };
}
export const useUsageOverview: typeof Usage.useUsageOverview = () => usageOverview(now);
