/** Closed product-example IO adapter. No presentation or model is replaced. */
import { useCallback, useReducer } from "react";
import { canNudge, cardOrderReducer } from "../../src/model/card-order";
import type { Custody } from "../../src/custody/custody-context";
import type * as Heads from "../../src/data/session-heads";
import type * as Models from "../../src/data/session-model-hook";
import type * as Commands from "../../src/data/commands";
import type * as DeviceCommands from "../../src/data/device-commands";
import type * as Devices from "../../src/data/devices";
import type * as Archived from "../../src/data/archived-sessions";
import type * as Registries from "../../src/data/registry";
import type * as Attachments from "../../src/data/composer-attachments";
import type * as CardOrder from "../../src/data/card-order";
import type * as AutomaticEffort from "../../src/data/automatic-effort";
import type * as Auth from "@convex-dev/auth/react";
import type * as Appearance from "../../src/appearance";
import type * as Usage from "../../src/data/usage";
import { usageOverview } from "./usage";
import type { ProductPreviewHarness } from "./definition";

let active: ProductPreviewHarness | null = null;

export function installProductPreviewHarness(harness: ProductPreviewHarness): () => undefined {
  if (active !== null) throw new Error("A product example already owns its IO boundary.");
  harness.assertOpen();
  active = harness;
  return () => { if (active === harness) active = null; return undefined; };
}

export function readProductPreviewHarness(): ProductPreviewHarness {
  if (active === null) throw new Error("Product example IO is not installed.");
  active.assertOpen();
  return active;
}

const noop = () => undefined;
const refuse = (): never => readProductPreviewHarness().refuse();
const refuseAsync = async (): Promise<never> => refuse();

/** Keep the real menu disabled and inert: no preference read, write or listener. */
export const mountOompaAppearanceMenu: typeof Appearance.mountOompaAppearanceMenu = () => {
  readProductPreviewHarness();
  return noop;
};

export const useSessionHeads: typeof Heads.useSessionHeads = () => ({
  heads: readProductPreviewHarness().observations.heads, isLoading: false, loadMore: noop, status: "Exhausted",
});
export const useAutomaticEffort: typeof AutomaticEffort.useAutomaticEffort = () => {
  readProductPreviewHarness();
  return { enabled: false, notice: null, setEnabled: refuse };
};
export const useSessionHead: typeof Heads.useSessionHead = (publicId) => {
  const head = readProductPreviewHarness().observations.heads.find((entry) => entry.publicId === publicId);
  if (head === undefined) throw new Error("Unknown product-example session.");
  return head;
};
export const useSessionModel: typeof Models.useSessionModel = (head) => {
  const model = head === null ? undefined : readProductPreviewHarness().observations.models[head.publicId];
  if (model === undefined) throw new Error("Unknown product-example projection.");
  return model;
};
export const useDeviceRegistries: typeof Registries.useDeviceRegistries = () => readProductPreviewHarness().observations.registries;
export const useDevices: typeof Devices.useDevices = () => ({ devices: [], loading: false });
export const useServerClock: typeof Devices.useServerClock = () => ({ now: readProductPreviewHarness().now(), ready: true });
export const useServerNow: typeof Devices.useServerNow = () => readProductPreviewHarness().now();
export const useArchivedSessions: typeof Archived.useArchivedSessions = () => [];
export const useSubmitCommand: typeof Commands.useSubmitCommand = () => refuseAsync;
export const useCommandState: typeof Commands.useCommandState = () => null;
export const useSubmitDeviceCommand: typeof DeviceCommands.useSubmitDeviceCommand = () => refuseAsync;
export const useReadDeviceCommandResult: typeof DeviceCommands.useReadDeviceCommandResult = () => refuseAsync;
export const useConsumeDeviceCommandResult: typeof DeviceCommands.useConsumeDeviceCommandResult = () => refuseAsync;
export const useDeviceCommandTracker: typeof DeviceCommands.useDeviceCommandTracker = () => ({
  observation: { protocolWarning: null, record: null, status: "idle" }, setHandle: noop,
});
export class DeviceCommandConsumePrecommitError extends Error {}
export class DeviceCommandConsumedResultUnreadableError extends Error {}
export class DeviceCommandResponseInvalidError extends Error {}
export const deviceCommandCommittedRowUnavailableMessage = "No commands run in this product example.";

export const useAuthActions: typeof Auth.useAuthActions = () => ({ signIn: refuseAsync, signOut: refuseAsync });
export function useCustody(): Custody {
  return {
    busy: false, devicePublicId: null, enroll: refuseAsync, enrollment: "needs_registration",
    error: null, fingerprint: null, refresh: refuseAsync, reportAuthorityFailure: refuse,
    state: "unenrolled", unlock: refuseAsync,
  };
}

/** The real ordering reducer, without a browser-storage port. */
export const useCardOrder: typeof CardOrder.useCardOrder = () => {
  const [order, dispatch] = useReducer(cardOrderReducer, []);
  const move = useCallback((displayed: readonly string[], activePublicId: string, overPublicId: string) => {
    dispatch({ activePublicId, displayed, overPublicId, type: "move" });
  }, []);
  const nudge = useCallback((displayed: readonly string[], publicId: string, direction: "left" | "right") => {
    dispatch({ direction, displayed, publicId, type: "nudge" });
  }, []);
  return { arranged: order.length > 0, canMove: canNudge, move, nudge, order, reset: () => { dispatch({ type: "clear" }); } };
};

/** Never enumerate a file, read bytes, access the clipboard, or create a blob. */
export const useComposerAttachments: typeof Attachments.useComposerAttachments = () => ({
  addFiles: refuse, attachments: [], busy: false, clear: noop, dragging: false, notice: null,
  onDragLeave: noop, onDragOver: refuse, onDrop: refuse, onPaste: refuse, onPick: refuse, remove: noop, sendRefusal: null,
});
export const holdSentAttachment = refuse;
export const heldAttachmentUrl = (): null => null;
export const releaseHeldAttachments = noop;
export const navigate = refuse;
export const navigateBack = refuse;

/** Fictional daily reports: one recent and one stale Codex account. */
export const useUsageOverview: typeof Usage.useUsageOverview = () => usageOverview(readProductPreviewHarness().now());
