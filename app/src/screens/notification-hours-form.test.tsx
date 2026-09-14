import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { MachineView } from "../model/settings-view";

const incompatiblePublicId = "018bcfe5-6800-7000-8000-000000000099";
const queryArgs: unknown[] = [];
const reportedFailures: unknown[] = [];
let queryResult: unknown = undefined;
let mutationCalls = 0;
let submittedPublicId: string | null = null;
let mutationReached: Promise<void> = Promise.resolve();
let resolveMutationReached: (() => void) | undefined;

const convexClient = {
  mutation: async (_reference: unknown, args: unknown): Promise<unknown> => {
    mutationCalls += 1;
    submittedPublicId = typeof args === "object"
      && args !== null
      && typeof (args as { publicId?: unknown }).publicId === "string"
      ? (args as { publicId: string }).publicId
      : null;
    resolveMutationReached?.();
    return { publicId: incompatiblePublicId };
  },
};

await mock.module("convex/react", () => ({
  useConvex: () => convexClient,
  useQueries: () => ({}),
  usePaginatedQuery: () => ({
    loadMore: () => undefined,
    results: [],
    status: "Exhausted",
  }),
  useQuery: (_reference: unknown, args: unknown) => {
    queryArgs.push(args);
    return args === "skip" ? undefined : queryResult;
  },
}));

await mock.module("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => undefined }),
}));

await mock.module("../custody/custody-context", () => ({
  useCustody: () => ({
    identity: {
      authEpoch: 1,
      credentialGeneration: 1,
      devicePublicId: "device_browser1",
      keyVersion: 1,
      userPublicId: "user_0000000000000001",
    },
    key: new Uint8Array(32),
    reportAuthorityFailure: (failure: unknown) => { reportedFailures.push(failure); },
    state: "unlocked",
  }),
}));

const { NotificationHoursForm } = await import("./settings-screen");

const installedGlobals = [
  "document",
  "Document",
  "DocumentFragment",
  "Element",
  "Event",
  "HTMLElement",
  "Node",
  "navigator",
  "window",
] as const;
const globalRecord = globalThis as unknown as Record<string, unknown>;
const originalDescriptors = new Map(
  installedGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]),
);
let mountedRoot: Root | null = null;

const machine: MachineView = {
  accountLinkingAllowed: false,
  accounts: [],
  attentionEmailEnabled: false,
  daemonVersion: "0.6.1",
  defaultApprovalMode: "auto:all",
  defaultPreset: "ultra",
  defaultProjectPublicId: null,
  deviceCommandsAllowed: true,
  devicePublicId: "device_daemon01",
  deviceStatus: "active",
  heartbeatAt: 1_760_000_000_000,
  label: "Studio",
  memorySummary: null,
  memorySummaryFreshness: "unsupported",
  notificationHours: {
    endMinute: 1_020,
    revision: 4,
    startMinute: 540,
    timeZone: "America/Puerto_Rico",
    version: 1,
  },
  notificationHoursStatus: "available",
  notificationPolicyFreshness: "current",
  notificationPolicyRevision: 4,
  online: true,
  projects: [],
  profileBinding: { profile: null, status: "unsupported" },
  proseAutorespondConfigured: false,
  revision: 8,
  scheduledTasks: [],
  sessionAdoption: null,
  showThinkingDefault: false,
  updatedAt: 1_760_000_000_000,
};

beforeEach(() => {
  const parsed = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
  const { document, window } = parsed;
  const windowRecord = window as unknown as Record<string, unknown>;
  for (const name of installedGlobals) {
    globalRecord[name] = name === "window"
      ? window
      : name === "document"
        ? document
        : windowRecord[name];
  }
  globalRecord.IS_REACT_ACT_ENVIRONMENT = true;
  mutationCalls = 0;
  submittedPublicId = null;
  queryArgs.length = 0;
  queryResult = undefined;
  reportedFailures.length = 0;
  mutationReached = new Promise<void>((resolve) => { resolveMutationReached = resolve; });
});

afterEach(() => {
  if (mountedRoot !== null) {
    act(() => { mountedRoot?.unmount(); });
    mountedRoot = null;
  }
  resolveMutationReached = undefined;
  for (const name of installedGlobals) {
    const descriptor = originalDescriptors.get(name);
    if (descriptor === undefined) Reflect.deleteProperty(globalRecord, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
  Reflect.deleteProperty(globalRecord, "IS_REACT_ACT_ENVIRONMENT");
});

async function renderMounted(node: ReactNode): Promise<HTMLElement> {
  const container = document.getElementById("root");
  if (!(container instanceof HTMLElement)) throw new Error("missing test root");
  mountedRoot ??= createRoot(container);
  await act(async () => {
    mountedRoot?.render(node);
    await Promise.resolve();
  });
  return container;
}

function saveButton(container: HTMLElement): Element {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent === "Save");
  if (button === undefined) throw new Error("missing notification-hours Save button");
  return button;
}

describe("notification-hours committed receipt tracking", () => {
  test("tracks a malformed success until the hosted row reconciles or fails closed", async () => {
    const container = await renderMounted(<NotificationHoursForm machine={machine} />);
    const form = container.querySelector("form");
    if (form === null) throw new Error("missing notification-hours form");

    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await mutationReached;
      await new Promise((resolve) => { setTimeout(resolve, 0); });
    });

    expect(mutationCalls).toBe(1);
    expect(submittedPublicId).not.toBeNull();
    expect(queryArgs).toContainEqual({ commandPublicId: submittedPublicId });
    expect(container.textContent).toContain("incompatible receipt");
    expect(saveButton(container).hasAttribute("disabled")).toBe(true);

    if (submittedPublicId === null) throw new Error("enqueue did not expose its public id");
    const hostedRecord = {
      createdAt: 1_760_000_000_000,
      deadline: 1_760_000_300_000,
      kind: "set_notification_hours",
      publicId: submittedPublicId,
      state: "pending",
      updatedAt: 1_760_000_000_001,
    };
    queryResult = hostedRecord;
    await renderMounted(<NotificationHoursForm machine={machine} />);

    expect(container.textContent).not.toContain("incompatible receipt");
    expect(saveButton(container).hasAttribute("disabled")).toBe(true);
    expect(mutationCalls).toBe(1);

    queryResult = { ...hostedRecord, publicId: incompatiblePublicId };
    await renderMounted(<NotificationHoursForm machine={machine} />);

    expect(container.textContent).toContain(
      "The cloud accepted this command, but its committed row is unavailable. No retry was sent.",
    );
    expect(mutationCalls).toBe(1);
    expect(reportedFailures).toHaveLength(1);
  });
});
