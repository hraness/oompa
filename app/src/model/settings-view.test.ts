import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { parseDeviceRegistryPayload, type DeviceRegistryPayload, type ProfileBindingPayload } from "../oompa/cloud";
import {
  accountBrowserLoginAllowed,
  accountRows,
  allScheduledTasks,
  archivedSessionRows,
  attentionEmailPresentation,
  commandTargetForMachine,
  hostedMemorySpaces,
  hostedPeerActions,
  hostedPeerPolicies,
  isMachineOnline,
  machineLabelsByDevice,
  personalSessionAdoptionCommand,
  registryHeartbeatToleranceMs,
  scheduledTaskKindLabel,
  shortSessionId,
  sortMachines,
  toMachineView,
  type SessionHeadSummary,
  type MachineViewInput,
} from "./settings-view";

const now = 1_760_000_000_000;
const minute = 60_000;

/**
 * The fixture goes through the daemon's own parser first, so a registry shape
 * this screen believes in but the projection would refuse never reaches the
 * derivations under test.
 */
function registry(overrides: Partial<DeviceRegistryPayload> = {}): DeviceRegistryPayload {
  const candidate = {
    accounts: [
      { label: "work", provider: "codex", publicId: "acct_one", status: "signed_in" },
      { label: "personal", provider: "claude", publicId: "acct_two", status: "signed_out" },
      { label: "build", provider: "devin", publicId: "acct_three", status: "login_pending" },
    ],
    daemonVersion: "0.3.0",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    heartbeatAt: now - minute,
    machineLabel: "studio",
    projects: [{ label: "oompa", publicId: "proj_one" }],
    proseAutorespondConfigured: true,
    scheduledTasks: [
      {
        cadence: "every day at 09:00",
        id: "task_one",
        kind: "hra_conversation",
        label: "morning sweep",
        nextRunAt: now + 3 * minute,
        sessionPublicId: "sess_one",
      },
      {
        cadence: "weekly",
        id: "task_two",
        kind: "hra_conversation",
        label: "weekly review",
        nextRunAt: null,
        sessionPublicId: null,
      },
    ],
    showThinkingDefault: false,
    version: 1,
    ...overrides,
  };
  const parsed = parseDeviceRegistryPayload(candidate);
  if (parsed === null) throw new Error("The registry fixture is not a valid projection.");
  return parsed;
}

describe("isMachineOnline", () => {
  test("is online while the hosted presence row holds the device", () => {
    expect(isMachineOnline({
      device: { online: true, status: "active" },
      heartbeatAt: now - 10 * registryHeartbeatToleranceMs,
      now,
    })).toBe(true);
  });

  test("falls back to a recent registry heartbeat when presence lags", () => {
    expect(isMachineOnline({
      device: { online: false, status: "active" },
      heartbeatAt: now - registryHeartbeatToleranceMs + 1,
      now,
    })).toBe(true);
  });

  test("is offline once the heartbeat passes the tolerance", () => {
    expect(isMachineOnline({
      device: { online: false, status: "active" },
      heartbeatAt: now - registryHeartbeatToleranceMs - 1,
      now,
    })).toBe(false);
  });

  test("is offline for a missing, pending, or revoked device row", () => {
    for (const device of [
      null,
      { online: true, status: "pending" } as const,
      { online: true, status: "revoked" } as const,
    ]) {
      expect(isMachineOnline({ device, heartbeatAt: now, now })).toBe(false);
    }
  });

  test("is offline when no heartbeat was ever published", () => {
    expect(isMachineOnline({
      device: { online: false, status: "active" },
      heartbeatAt: 0,
      now,
    })).toBe(false);
  });

  test("does not use a future heartbeat as evidence that a machine is online", () => {
    for (const heartbeatAt of [now + 1, now + 10 * registryHeartbeatToleranceMs, Number.MAX_SAFE_INTEGER]) {
      expect(isMachineOnline({ device: { online: false, status: "active" }, heartbeatAt, now })).toBe(false);
    }
  });

  test("includes both boundaries of the recent heartbeat interval", () => {
    for (const age of [0, registryHeartbeatToleranceMs]) {
      expect(isMachineOnline({ device: { online: false, status: "active" }, heartbeatAt: now - age, now })).toBe(true);
    }
  });

  test("requires finite clock inputs only when relying on the heartbeat fallback", () => {
    for (const heartbeatAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, now + 1]) {
      expect(isMachineOnline({ device: { online: false, status: "active" }, heartbeatAt, now })).toBe(false);
      expect(isMachineOnline({ device: { online: true, status: "active" }, heartbeatAt, now })).toBe(true);
    }
    for (const invalidNow of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isMachineOnline({ device: { online: false, status: "active" }, heartbeatAt: now, now: invalidNow })).toBe(false);
      expect(isMachineOnline({ device: { online: true, status: "active" }, heartbeatAt: now, now: invalidNow })).toBe(true);
    }
  });

  test("bounds fallback freshness in both time directions without changing presence or device status", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1_000_000, max: 2_000_000_000_000 }),
      fc.integer({ min: -2 * registryHeartbeatToleranceMs, max: 2 * registryHeartbeatToleranceMs }),
      (clock, offset) => {
        const heartbeatAt = clock + offset;
        const expected = heartbeatAt >= clock - registryHeartbeatToleranceMs && heartbeatAt <= clock;
        expect(isMachineOnline({ device: { online: false, status: "active" }, heartbeatAt, now: clock })).toBe(expected);
        expect(isMachineOnline({ device: { online: true, status: "active" }, heartbeatAt, now: clock })).toBe(true);
        for (const status of ["pending", "revoked"] as const) {
          expect(isMachineOnline({ device: { online: true, status }, heartbeatAt, now: clock })).toBe(false);
        }
        expect(isMachineOnline({ device: null, heartbeatAt, now: clock })).toBe(false);
      },
    ), { seed: 68103, numRuns: 200 });
  });
});

describe("toMachineView", () => {
  test("preserves a future registry heartbeat without presenting it as live presence", () => {
    const heartbeatAt = now + minute;
    const view = toMachineView({
      device: { online: false, status: "active" },
      devicePublicId: "dev_one",
      now,
      payload: registry({ heartbeatAt }),
      revision: 7,
      updatedAt: now,
    });
    expect(view.heartbeatAt).toBe(heartbeatAt);
    expect(view.online).toBe(false);
  });

  test("decodes a registry into the row the machine card renders", () => {
    const notificationHours = {
      endMinute: 1_320,
      revision: 4,
      startMinute: 600,
      timeZone: "America/Puerto_Rico",
      version: 1,
    } as const;
    const view = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "dev_one",
      now,
      notificationHours,
      attentionEmailEnabled: false,
      notificationPolicyFreshness: "current",
      notificationPolicyRevision: 4,
      payload: registry(),
      revision: 7,
      updatedAt: now - minute,
    });
    expect(view.label).toBe("studio");
    expect(view.daemonVersion).toBe("0.3.0");
    expect(view.defaultApprovalMode).toBe("auto:all");
    expect(view.defaultPreset).toBe("ultra");
    expect(view.showThinkingDefault).toBe(false);
    expect(view.proseAutorespondConfigured).toBe(true);
    expect(view.sessionAdoption).toBeNull();
    expect(view.devicePublicId).toBe("dev_one");
    expect(view.deviceStatus).toBe("active");
    expect(view.notificationHours).toEqual(notificationHours);
    expect(view.notificationHoursStatus).toBe("available");
    expect(view.attentionEmailEnabled).toBe(false);
    expect(view.notificationPolicyFreshness).toBe("current");
    expect(view.notificationPolicyRevision).toBe(4);
    expect(view.revision).toBe(7);
    expect(view.online).toBe(true);
    expect(view.accounts.map((account) => [account.label, account.provider, account.status])).toEqual([
      ["work", "codex", "signed_in"],
      ["personal", "claude", "signed_out"],
      ["build", "devin", "login_pending"],
    ]);
    expect(view.projects.map((project) => project.label)).toEqual(["oompa"]);
  });

  test("renders personal-home consent as a local command in both directions", () => {
    expect(personalSessionAdoptionCommand("codex", false))
      .toBe("oompa session adoption enable <account> --provider codex");
    expect(personalSessionAdoptionCommand("claude", true))
      .toBe("oompa session adoption disable --provider claude");
  });

  test("carries exact provider aggregates and never guesses an older daemon's opt-in", () => {
    const view = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "dev_one",
      now,
      payload: registry({
        sessionAdoption: {
          claude: { adopted: 1, enabled: false, fenced: 2, pending: 3 },
          codex: { adopted: 4, enabled: true, fenced: 5, pending: 6 },
        },
      }),
      revision: 7,
      updatedAt: now - minute,
    });
    expect(view.sessionAdoption).toEqual({
      claude: { adopted: 1, enabled: false, fenced: 2, pending: 3 },
      codex: { adopted: 4, enabled: true, fenced: 5, pending: 6 },
    });
  });

  test("defaults an older registry to no displayable email consent", () => {
    const view = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "dev_one",
      now,
      payload: registry(),
      revision: 1,
      updatedAt: now,
    });
    expect(view.attentionEmailEnabled).toBeNull();
    expect(view.notificationPolicyFreshness).toBe("unsupported");
    expect(view.notificationPolicyRevision).toBeNull();
    expect(view.memorySummary).toBeNull();
    expect(view.memorySummaryFreshness).toBe("unsupported");
  });

  test("labels every scheduled task by provider and carries its machine", () => {
    const view = toMachineView({
      device: null,
      devicePublicId: "dev_one",
      now,
      payload: registry(),
      revision: 1,
      updatedAt: now,
    });
    expect(view.scheduledTasks.map((task) => [task.label, task.kindLabel])).toEqual([
      ["morning sweep", "Oompa"],
      ["weekly review", "Oompa"],
    ]);
    for (const task of view.scheduledTasks) expect(task.machineLabel).toBe("studio");
  });

  test("names the public Oompa conversation task kind", () => {
    expect(scheduledTaskKindLabel("hra_conversation")).toBe("Oompa");
  });
});

describe("last reported Codex default", () => {
  const observation: ProfileBindingPayload = {
    observedAt: now,
    preset: "ultra",
    profileKey: "codex:gpt-5.6-sol:ultra",
    registryEnvelopeDigest: "a".repeat(64),
    registryRevision: 7,
    version: 1,
  };
  const input = (overrides: Partial<MachineViewInput> = {}): MachineViewInput => ({
    device: { deviceClass: "daemon", keyVersion: 1, online: true, status: "active" },
    devicePublicId: "dev_one",
    keyVersion: 1,
    now,
    payload: registry({ heartbeatAt: now }),
    profileBinding: observation,
    profileBindingReady: true,
    profileBindingStatus: "available",
    revision: 7,
    updatedAt: now,
    ...overrides,
  });

  test("decodes both exact historical models without consulting the reader's active binding", () => {
    for (const profile of [
      { effort: "ultra", key: "codex:gpt-5.6-sol:ultra", model: "gpt-5.6-sol", provider: "codex" },
      { effort: "ultra", key: "codex:gpt-6-astra:ultra", model: "gpt-6-astra", provider: "codex" },
    ] as const) {
      const machine = toMachineView(input({ profileBinding: { ...observation, profileKey: profile.key } }));
      expect(machine.profileBinding).toEqual({
        profile,
        status: "current",
      });
      expect(machine.defaultPreset).toBe("ultra");
    }
  });

  test("requires an active daemon and the current matching device key", () => {
    for (const device of [
      null,
      { deviceClass: "browser", keyVersion: 1, online: true, status: "active" },
      { deviceClass: "daemon", keyVersion: 1, online: true, status: "pending" },
      { deviceClass: "daemon", keyVersion: 1, online: true, status: "revoked" },
      { deviceClass: "daemon", keyVersion: 2, online: true, status: "active" },
    ] as const) {
      expect(toMachineView(input({ device })).profileBinding).toEqual({ profile: null, status: "inactive" });
    }
    for (const device of [
      { online: true, status: "active" },
      { deviceClass: "daemon", online: true, status: "active" },
      { keyVersion: 1, online: true, status: "active" },
    ] as const) {
      expect(toMachineView(input({ device })).profileBinding).toEqual({ profile: null, status: "unsupported" });
    }
    const missingRegistryKey = { ...input() };
    delete missingRegistryKey.keyVersion;
    expect(toMachineView(missingRegistryKey).profileBinding).toEqual({ profile: null, status: "unsupported" });
  });

  test("does not infer availability from online presence or absent hosted time", () => {
    for (const profileBindingReady of [false, undefined]) {
      const candidate = { ...input() };
      if (profileBindingReady === undefined) delete candidate.profileBindingReady;
      else candidate.profileBindingReady = profileBindingReady;
      expect(toMachineView(candidate).profileBinding).toEqual({ profile: null, status: "unsupported" });
    }
    for (const badNow of [NaN, Infinity, -Infinity, 0, -1]) {
      expect(toMachineView(input({ now: badNow })).profileBinding).toEqual({ profile: null, status: "unsupported" });
    }
    for (const offset of [-registryHeartbeatToleranceMs - 1, registryHeartbeatToleranceMs + 1]) {
      const machine = toMachineView(input({ now: now + offset }));
      expect(machine.online).toBe(true);
      expect(machine.profileBinding).toEqual({ profile: null, status: "stale" });
    }
    for (const offset of [-registryHeartbeatToleranceMs, registryHeartbeatToleranceMs]) {
      expect(toMachineView(input({ now: now + offset })).profileBinding.status).toBe("current");
    }
  });

  test("missing and unreadable observations expose no exact model", () => {
    expect(toMachineView(input({ profileBindingStatus: "unreadable" })).profileBinding)
      .toEqual({ profile: null, status: "unreadable" });
    for (const override of [
      { profileBindingStatus: "unsupported" as const },
      { profileBinding: null },
    ]) {
      expect(toMachineView(input(override)).profileBinding).toEqual({ profile: null, status: "unsupported" });
    }
  });

  test("refuses bad timestamps and incoherent profile, alias, or revision pairs", () => {
    for (const profileBinding of [
      { ...observation, observedAt: 0 },
      { ...observation, observedAt: -1 },
      { ...observation, observedAt: Infinity },
      { ...observation, observedAt: NaN },
      { ...observation, observedAt: now + 1 },
      { ...observation, registryRevision: 6 },
      { ...observation, preset: "high", profileKey: "codex:gpt-5.6-sol:max" },
      { ...observation, profileKey: "codex:gpt-6-astra:max" },
      { ...observation, profileKey: "devin:gpt-6-astra:provider-default" },
    ] as const) {
      expect(toMachineView(input({ profileBinding })).profileBinding).toEqual({ profile: null, status: "unreadable" });
    }
    expect(toMachineView(input({ payload: registry({ defaultPreset: "astra", heartbeatAt: now }) })).profileBinding)
      .toEqual({ profile: null, status: "unreadable" });
  });
});

describe("hosted memory supervision", () => {
  const digest = (scalar: string) => scalar.repeat(64);
  const canonicalSpaceId = `hra:project:space-${"d".repeat(32)}`;
  const summary = (headScalar: string, observedAt = now) => ({
    coverage: { peerActions: "complete" as const, peerPolicies: "complete" as const, spaces: "complete" as const },
    observedAt,
    peerActions: [{
      actor: { label: "Planner", ref: digest("a") },
      createdAt: now - 2_000,
      delivery: "steer" as const,
      state: "applied" as const,
      target: { label: "Planner", ref: digest("b") },
      updatedAt: now - 1_000,
    }],
    peerPolicies: [{
      mode: "coordinate" as const,
      projectLabel: "Oompa",
      session: { label: "Planner", ref: digest("a") },
      updatedAt: now - 3_000,
    }],
    spaces: [{
      bindingDigest: digest("c"),
      canonicalSpaceId,
      enrollment: "attached" as const,
      head: { digest: digest(headScalar), operationSha256: digest(headScalar), sequence: 4 },
      lastExchangeAt: now - 500,
      projectLabel: "Oompa",
      recentRecords: [{ key: "release-policy", kind: "memory_page" as const, updatedAt: now - 4_000 }],
      recordCount: 3,
      remoteHead: { digest: digest(headScalar), operationSha256: digest(headScalar), sequence: 4 },
      syncStatus: "settled" as const,
    }],
    version: 1 as const,
  });
  const machine = (devicePublicId: string, label: string, headScalar: string, observedAt = now) =>
    toMachineView({
      device: { online: true, status: "active" },
      devicePublicId,
      memorySummary: summary(headScalar, observedAt),
      memorySummaryReady: true,
      memorySummaryStatus: "available",
      now,
      payload: registry({ machineLabel: label }),
      revision: 1,
      updatedAt: now,
    });

  test("does not fold a summary before the hosted clock is ready", () => {
    const view = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "device_clock_pending",
      memorySummary: summary("e"),
      memorySummaryReady: false,
      memorySummaryStatus: "available",
      now: Number.MIN_SAFE_INTEGER,
      payload: registry({ machineLabel: "Clock pending" }),
      revision: 1,
      updatedAt: now,
    });
    expect(view.memorySummary).toBeNull();
    expect(view.memorySummaryFreshness).toBe("unsupported");
    expect(hostedMemorySpaces([view])).toEqual([]);
    expect(hostedPeerPolicies([view])).toEqual([]);
    expect(hostedPeerActions([view])).toEqual([]);

    const omittedGate = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "device_clock_gate_omitted",
      memorySummary: summary("e"),
      memorySummaryStatus: "available",
      now,
      payload: registry({ machineLabel: "Omitted clock gate" }),
      revision: 1,
      updatedAt: now,
    });
    expect(omittedGate.memorySummary).toBeNull();
    expect(omittedGate.memorySummaryFreshness).toBe("unsupported");
  });

  test("retains exact per-device heads and reports agreement without choosing a winner", () => {
    const agreed = hostedMemorySpaces([
      machine("device_one", "Studio", "e"),
      machine("device_two", "Laptop", "e"),
    ]);
    expect(agreed).toHaveLength(1);
    expect(agreed[0]?.agreement).toBe("agreed");
    expect(agreed[0]?.observations.map((observation) => observation.space?.head.digest))
      .toEqual([digest("e"), digest("e")]);

    const disagreed = hostedMemorySpaces([
      machine("device_one", "Studio", "e"),
      machine("device_two", "Laptop", "f"),
    ]);
    expect(disagreed[0]?.agreement).toBe("disagreed");
    expect(disagreed[0]?.observations.map((observation) => observation.space?.head.digest))
      .toEqual([digest("e"), digest("f")]);
  });

  test("reports conflicting bindings despite identical heads without choosing a winner", () => {
    const original = machine("device_one", "Studio", "e");
    const conflictingSummary = summary("e");
    const conflicting = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "device_two",
      memorySummary: {
        ...conflictingSummary,
        spaces: conflictingSummary.spaces.map((space) => ({
          ...space,
          bindingDigest: digest("f"),
        })),
      },
      memorySummaryReady: true,
      memorySummaryStatus: "available",
      now,
      payload: registry({ machineLabel: "Laptop" }),
      revision: 1,
      updatedAt: now,
    });

    for (const machines of [[original, conflicting], [conflicting, original]]) {
      const grouped = hostedMemorySpaces(machines);
      expect(grouped).toHaveLength(1);
      expect(grouped[0]?.agreement).toBe("disagreed");
      expect(grouped[0]?.observations.map((observation) => observation.space?.head))
        .toEqual([conflictingSummary.spaces[0]?.head, conflictingSummary.spaces[0]?.head]);
      expect(new Set(grouped[0]?.observations.map((observation) => observation.space?.bindingDigest)))
        .toEqual(new Set([digest("c"), digest("f")]));
    }
  });

  test("excludes stale evidence from agreement and shows a current device's enrollment gap", () => {
    const stale = machine(
      "device_one",
      "Studio",
      "e",
      now - registryHeartbeatToleranceMs - 1,
    );
    const withoutSpace = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "device_two",
      memorySummary: { ...summary("e"), spaces: [] },
      memorySummaryReady: true,
      memorySummaryStatus: "available",
      now,
      payload: registry({ machineLabel: "Laptop" }),
      revision: 1,
      updatedAt: now,
    });
    const grouped = hostedMemorySpaces([stale, withoutSpace]);
    expect(stale.memorySummaryFreshness).toBe("stale");
    expect(grouped[0]?.agreement).toBe("insufficient");
    expect(grouped[0]?.observations.map((observation) => observation.freshness))
      .toEqual(["stale", "missing"]);
  });

  test("distinguishes a bounded space list from a complete enrollment gap", () => {
    const bounded = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "device_two",
      memorySummary: {
        ...summary("e"),
        coverage: { ...summary("e").coverage, spaces: "bounded" },
        spaces: [],
      },
      memorySummaryReady: true,
      memorySummaryStatus: "available",
      now,
      payload: registry({ machineLabel: "Laptop" }),
      revision: 1,
      updatedAt: now,
    });
    const grouped = hostedMemorySpaces([
      machine("device_one", "Studio", "e"),
      bounded,
    ]);
    expect(grouped[0]?.agreement).toBe("insufficient");
    expect(grouped[0]?.observations.map((observation) => observation.freshness))
      .toEqual(["current", "bounded"]);
  });

  test("does not treat a head with an unavailable record count as convergence evidence", () => {
    const unavailableSpace = summary("e").spaces[0];
    if (unavailableSpace === undefined) throw new Error("Expected a memory summary space fixture.");
    const unavailable = toMachineView({
      device: { online: true, status: "active" },
      devicePublicId: "device_two",
      memorySummary: {
        ...summary("e"),
        spaces: [{ ...unavailableSpace, recordCount: null }],
      },
      memorySummaryReady: true,
      memorySummaryStatus: "available",
      now,
      payload: registry({ machineLabel: "Laptop" }),
      revision: 1,
      updatedAt: now,
    });
    const grouped = hostedMemorySpaces([
      machine("device_one", "Studio", "e"),
      unavailable,
    ]);
    expect(grouped[0]?.agreement).toBe("insufficient");
    expect(grouped[0]?.observations[1]?.space?.recordCount).toBeNull();
  });

  test("discards summaries from missing, pending, and revoked device authorities", () => {
    for (const device of [
      null,
      { online: true, status: "pending" } as const,
      { online: true, status: "revoked" } as const,
    ]) {
      const inactive = toMachineView({
        device,
        devicePublicId: "device_inactive",
        memorySummary: summary("e"),
        memorySummaryReady: true,
        memorySummaryStatus: "available",
        now,
        payload: registry({ machineLabel: "Retired" }),
        revision: 1,
        updatedAt: now,
      });
      expect(inactive.memorySummaryFreshness).toBe("inactive");
      expect(inactive.memorySummary).toBeNull();
      expect(hostedMemorySpaces([inactive])).toEqual([]);
      expect(hostedPeerPolicies([inactive])).toEqual([]);
      expect(hostedPeerActions([inactive])).toEqual([]);
    }
  });

  test("keeps actor and target roles distinct even when their labels are equal", () => {
    const machines = [machine("device_one", "Studio", "e")];
    const actions = hostedPeerActions(machines);
    expect(actions[0]).toMatchObject({
      actor: { label: "Planner", ref: digest("a") },
      target: { label: "Planner", ref: digest("b") },
    });
    expect(actions[0]?.actor.ref).not.toBe(actions[0]?.target.ref);
    expect(hostedPeerPolicies(machines)[0]).toMatchObject({
      machineLabel: "Studio",
      mode: "coordinate",
      session: { ref: digest("a") },
    });
  });
});

describe("attentionEmailPresentation", () => {
  test("reports current enabled and disabled revisions without creating a command", () => {
    expect(attentionEmailPresentation({
      attentionEmailEnabled: true,
      notificationPolicyFreshness: "current",
      notificationPolicyRevision: 9,
    })).toEqual({
      description: "Last published local email opt-in at notification policy revision 9.",
      label: "enabled",
      tone: "accent",
    });
    expect(attentionEmailPresentation({
      attentionEmailEnabled: false,
      notificationPolicyFreshness: "current",
      notificationPolicyRevision: 10,
    }).label).toBe("disabled");
  });

  test("never presents stale, unreadable, or legacy evidence as enabled", () => {
    for (const [freshness, label] of [
      ["stale", "refresh needed"],
      ["unreadable", "unavailable"],
      ["unsupported", "unavailable"],
    ] as const) {
      expect(attentionEmailPresentation({
        attentionEmailEnabled: null,
        notificationPolicyFreshness: freshness,
        notificationPolicyRevision: freshness === "unsupported" ? null : 4,
      }).label).toBe(label);
    }
  });
});

function machine(
  devicePublicId: string,
  machineLabel: string,
  online: boolean,
  overrides: Partial<DeviceRegistryPayload> = {},
) {
  return toMachineView({
    device: { online, status: "active" },
    devicePublicId,
    now,
    payload: registry({ machineLabel, ...overrides }),
    revision: 1,
    updatedAt: now,
  });
}

describe("machine and task ordering", () => {
  test("puts online machines first and then sorts by label", () => {
    const machines = sortMachines([
      machine("dev_c", "workshop", false),
      machine("dev_a", "studio", false),
      machine("dev_b", "laptop", true),
    ]);
    expect(machines.map((entry) => entry.label)).toEqual(["laptop", "studio", "workshop"]);
  });

  test("maps every device id to its machine label", () => {
    const labels = machineLabelsByDevice([machine("dev_a", "studio", true)]);
    expect(labels.get("dev_a")).toBe("studio");
    expect(labels.get("dev_missing")).toBeUndefined();
  });

  test("flattens every machine's tasks with the soonest run first and no run last", () => {
    const tasks = allScheduledTasks([
      machine("dev_a", "studio", true),
      machine("dev_b", "laptop", true, {
        scheduledTasks: [{
          cadence: "hourly",
          id: "task_three",
          kind: "hra_conversation",
          label: "hourly sweep",
          nextRunAt: now + minute,
          sessionPublicId: null,
        }],
      }),
    ]);
    expect(tasks.map((task) => task.label)).toEqual([
      "hourly sweep",
      "morning sweep",
      "weekly review",
    ]);
  });

  test("lists every account with the machine it belongs to", () => {
    const rows = accountRows([machine("dev_a", "studio", true)]);
    expect(rows.map((row) => [row.label, row.machineLabel, row.status])).toEqual([
      ["work", "studio", "signed_in"],
      ["personal", "studio", "signed_out"],
      ["build", "studio", "login_pending"],
    ]);
  });

  test("carries both local login gates and admits Codex only when both are on", () => {
    for (const deviceCommandsAllowed of [false, true]) {
      for (const accountLinkingAllowed of [false, true]) {
        const rows = accountRows([machine("dev_a", "studio", true, {
          accountLinkingAllowed,
          deviceCommandsAllowed,
        })]);
        expect(rows[0]).toMatchObject({ accountLinkingAllowed, deviceCommandsAllowed });
        expect(accountBrowserLoginAllowed(rows[0]!)).toBe(
          accountLinkingAllowed && deviceCommandsAllowed,
        );
        expect(accountBrowserLoginAllowed(rows[1]!)).toBe(false);
        expect(accountBrowserLoginAllowed(rows[2]!)).toBe(false);
      }
    }
  });
});

describe("commandTargetForMachine", () => {
  const heads: readonly SessionHeadSummary[] = [
    { executionDevicePublicId: "dev_a", publicId: "sess_old", state: "idle", updatedAt: now - 10 },
    { executionDevicePublicId: "dev_a", publicId: "sess_new", state: "active", updatedAt: now },
    { executionDevicePublicId: "dev_b", publicId: "sess_other", state: "active", updatedAt: now },
  ];

  test("picks the machine's most recent live session", () => {
    expect(commandTargetForMachine(heads, "dev_a")).toEqual({
      executionDevicePublicId: "dev_a",
      sessionPublicId: "sess_new",
    });
  });

  test("never picks a terminal or orphaned session", () => {
    expect(commandTargetForMachine([
      { executionDevicePublicId: "dev_a", publicId: "s1", state: "terminal", updatedAt: now },
      { executionDevicePublicId: "dev_a", publicId: "s2", state: "orphaned", updatedAt: now },
    ], "dev_a")).toBeNull();
  });

  test("has no target for a machine with no session at all", () => {
    expect(commandTargetForMachine(heads, "dev_missing")).toBeNull();
  });
});

describe("archivedSessionRows", () => {
  const labels = new Map([["dev_a", "studio"]]);

  test("keeps only sessions whose decrypted metadata says archived", () => {
    const rows = archivedSessionRows([
      {
        executionDevicePublicId: "dev_a",
        metadata: { archived: true, name: "old work" },
        publicId: "sess_one",
        updatedAt: now - minute,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: { archived: false, name: "live work" },
        publicId: "sess_two",
        updatedAt: now,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: { name: "no flag" },
        publicId: "sess_three",
        updatedAt: now,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: null,
        publicId: "sess_four",
        updatedAt: now,
      },
    ], labels);
    expect(rows.map((row) => row.publicId)).toEqual(["sess_one"]);
    expect(rows[0]?.machineLabel).toBe("studio");
    expect(rows[0]?.title).toBe("old work");
  });

  test("falls back to a short id when the session has no name, newest first", () => {
    const rows = archivedSessionRows([
      {
        executionDevicePublicId: "dev_unknown",
        metadata: { archived: true, name: null },
        publicId: "sess_aaaaaaaaaaaaaaaa",
        updatedAt: now - minute,
      },
      {
        executionDevicePublicId: "dev_a",
        metadata: { archived: true, name: "newer" },
        publicId: "sess_two",
        updatedAt: now,
      },
    ], labels);
    expect(rows.map((row) => row.title)).toEqual(["newer", shortSessionId("sess_aaaaaaaaaaaaaaaa")]);
    expect(rows[1]?.machineLabel).toBeNull();
  });
});
