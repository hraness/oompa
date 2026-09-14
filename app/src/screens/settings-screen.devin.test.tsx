import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";

import type { MachineView } from "../model/settings-view";

await mock.module("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: () => Promise.resolve() }),
}));

await mock.module("../custody/custody-context", () => ({
  useCustody: () => ({ lock: () => undefined }),
}));

await mock.module("../components/usage-breakdown", () => ({ UsageBreakdown: () => null }));
await mock.module("../data/archived-sessions", () => ({
  useArchivedSessions: () => [
    {
      executionDevicePublicId: "device_studio01", machineLabel: "Studio",
      publicId: "sess_retired", retiredProvider: "devin",
      title: "Retired conversation", updatedAt: 1_760_000_000_000,
    },
    {
      executionDevicePublicId: "device_studio01", machineLabel: "Studio",
      publicId: "sess_supported", title: "Supported conversation", updatedAt: 1_760_000_000_000,
    },
  ],
}));

await mock.module("../data/commands", () => ({
  useCommandState: () => null,
  useSubmitCommand: () => () => Promise.reject(new Error("unexpected settings command")),
}));

await mock.module("../data/device-commands", () => {
  class DeviceCommandConsumePrecommitError extends Error {}
  class DeviceCommandConsumedResultUnreadableError extends Error {}
  class DeviceCommandResponseInvalidError extends Error {}
  return {
    deviceCommandCommittedRowUnavailableMessage: "The committed row is unavailable.",
    DeviceCommandConsumedResultUnreadableError,
    DeviceCommandConsumePrecommitError,
    DeviceCommandResponseInvalidError,
    useConsumeDeviceCommandResult: () => () => Promise.reject(new Error("unexpected consume")),
    useDeviceCommandTracker: () => ({
      observation: { protocolWarning: null, record: null, status: "idle" },
      setHandle: () => undefined,
    }),
    useReadDeviceCommandResult: () => () => Promise.reject(new Error("unexpected read")),
    useSubmitDeviceCommand: () => () => Promise.reject(new Error("unexpected device command")),
  };
});

await mock.module("../data/devices", () => ({
  useDevices: () => ({ devices: [], loading: false }),
  useServerClock: () => ({ now: 1_760_000_000_000, ready: true }),
}));

await mock.module("../data/registry", () => ({
  useDeviceRegistries: () => ({
    error: null,
    loading: false,
    memorySummaryReady: true,
    now: 1_760_000_000_000,
    machines: [{
      accountLinkingAllowed: true,
      accounts: [{
        label: "build",
        provider: "devin",
        publicId: "acct_devin000001",
        status: "signed_out",
      }],
      attentionEmailEnabled: null,
      daemonVersion: "0.4.1",
      defaultApprovalMode: "auto:all",
      defaultPreset: "astra",
      defaultProjectPublicId: null,
      deviceCommandsAllowed: true,
      devicePublicId: "device_studio01",
      deviceStatus: "active",
      heartbeatAt: 1_760_000_000_000,
      label: "Studio",
      memorySummary: null,
      memorySummaryFreshness: "unsupported",
      online: true,
      notificationHours: null,
      notificationHoursStatus: "unsupported",
      notificationPolicyFreshness: "unsupported",
      notificationPolicyRevision: null,
      projects: [],
      profileBinding: { profile: null, status: "unsupported" },
      proseAutorespondConfigured: false,
      revision: 1,
      scheduledTasks: [],
      sessionAdoption: {
        claude: { adopted: 0, enabled: false, fenced: 0, pending: 0 },
        codex: { adopted: 0, enabled: false, fenced: 0, pending: 0 },
      },
      showThinkingDefault: false,
      updatedAt: 1_760_000_000_000,
    } satisfies MachineView],
  }),
}));

await mock.module("../data/session-heads", () => ({
  useSessionHeads: () => ({
    heads: [],
    isLoading: false,
    loadMore: () => undefined,
    status: "Exhausted",
  }),
}));

const { SettingsScreen } = await import("./settings-screen");

describe("Devin account settings", () => {
  test("keeps retired archived sessions read-only while supported sessions can unarchive", () => {
    const markup = renderToStaticMarkup(<SettingsScreen onBack={() => undefined} />);
    const { document } = parseHTML(markup);
    const unarchiveButtons = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent === "Unarchive");
    expect(unarchiveButtons).toHaveLength(2);
    expect(unarchiveButtons[0]?.hasAttribute("disabled")).toBe(true);
    expect(unarchiveButtons[1]?.hasAttribute("disabled")).toBe(false);
    expect(markup).toContain("Retired conversation");
  });

  test("shows historical Devin accounts as retired without any login path", () => {
    const markup = renderToStaticMarkup(<SettingsScreen onBack={() => undefined} />);

    expect(markup).toContain("Devin support is retired");
    expect(markup).toContain("read-only");
    expect(markup).not.toContain("oompa account login acct_devin000001");
    expect(markup).not.toContain("--manual-token-flow");
    expect(markup).not.toContain("Link here");
    expect(markup).not.toContain("Check status");
    expect(markup).toContain("Codex personal sessions");
    expect(markup).toContain("Claude Code personal sessions");
    expect(markup).not.toContain("Devin personal sessions");
    expect(markup).not.toContain("session adoption enable &lt;account&gt; --provider devin");
  });
});
