import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { MachineView } from "../model/settings-view";

await mock.module("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: () => Promise.resolve() }),
}));

await mock.module("../custody/custody-context", () => ({
  useCustody: () => ({ lock: () => undefined }),
}));

await mock.module("../components/usage-breakdown", () => ({ UsageBreakdown: () => null }));
await mock.module("../data/archived-sessions", () => ({
  useArchivedSessions: () => [],
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
  test("shows the local isolated-login command and never offers browser linking", () => {
    const markup = renderToStaticMarkup(<SettingsScreen onBack={() => undefined} />);

    expect(markup).toContain("oompa account login acct_devin000001 --provider devin");
    expect(markup).toContain("Devin owns this foreground sign-in");
    expect(markup).toContain("--manual-token-flow");
    expect(markup).not.toContain("Link here");
    expect(markup).not.toContain("Check status");
    expect(markup).toContain("Codex personal sessions");
    expect(markup).toContain("Claude Code personal sessions");
    expect(markup).not.toContain("Devin personal sessions");
    expect(markup).not.toContain("session adoption enable &lt;account&gt; --provider devin");
  });
});
