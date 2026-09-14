import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { InvalidCommandResponseError, renderFailure, renderProtectedInteractionDetail, renderRootStatus, renderSuccess, safeDiagnostic, terminalSafe, type Output } from "./render";
import type { ProtectedInteractionDetailDocument, PublicInteraction } from "../domain/interactions";
import type { SessionEventPage } from "../domain/session-events";
import { effectiveClaudeRuntimeProfileSchema, projectPublicReviewedRuntimeProfile } from "../domain/runtime-profile";
import { WORK_STREAM_FAILURE_MAX_BYTES } from "../domain/work";
import { projectPublicProviderIdentifier } from "../public-provider-identifier";

const publicProviderId = (value: string) =>
  projectPublicProviderIdentifier(value, Buffer.alloc(32, 0x52));
const cursorWireSignature = "A".repeat(43);
const cursorWire = (label: string): string =>
  `hra1.${Buffer.from(`fixture:${label}`).toString("base64url")}.${cursorWireSignature}`;

const capture = (): { output: Output; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    output: {
      writeStdout: (value) => { stdout.push(value); },
      writeStderr: (value) => { stderr.push(value); },
    },
  };
};

test("autorespond status distinguishes uncertain effects and an upgrade hold", () => {
  const result = capture();
  renderSuccess({ kind: "autorespond.status" }, {
    version: 1,
    mode: "auto:all",
    source: "default",
    counts: { accepted: 2, refused: 3, unknown: 1 },
    budgets: { consecutive: 3, lastHour: 3, lastDay: 3 },
    budgetHistoryAvailableAt: Date.parse("2026-09-08T00:00:00.000Z"),
  }, false, result.output);
  expect(result.stdout.join("")).toContain("2 accepted, 3 escalated, 1 unknown");
  expect(result.stdout.join("")).toContain("paused until 2026-09-08T00:00:00.000Z");
  expect(result.stdout.join("")).toContain("previous budget history is incomplete");
});

const primarySessionId = `sess_${"1".repeat(32)}`;

describe("after-hours approval consent output", () => {
  test("renders exact consent and revision for every command in stable JSON", () => {
    for (const kind of ["autorespond-after-hours.status", "autorespond-after-hours.enable", "autorespond-after-hours.disable"] as const) {
      const command = kind === "autorespond-after-hours.status" ? { kind } : { kind, expectedRevision: 4 };
      const data = { policy: { kind: "autorespond_after_hours", version: 1, revision: 5, enabled: kind === "autorespond-after-hours.enable" } };
      const result = capture();
      renderSuccess(command, data, true, result.output);
      expect(JSON.parse(result.stdout.join("")) as unknown).toEqual({ command: kind, data, ok: true, version: 1 });
      const reordered = capture();
      renderSuccess(command, { policy: { enabled: data.policy.enabled, revision: 5, version: 1, kind: "autorespond_after_hours" } }, true, reordered.output);
      expect(reordered.stdout).toEqual(result.stdout);
      expect(result.stderr).toEqual([]);
    }
  });

  test("keeps human output conditional, local, and explicit about unchanged safety", () => {
    for (const enabled of [true, false]) {
      const result = capture();
      renderSuccess({ kind: "autorespond-after-hours.status" }, {
        policy: { kind: "autorespond_after_hours", version: 1, revision: 4, enabled },
      }, false, result.output);
      expect(result.stdout.join("")).toBe([
        "After-hours automatic approval budgets",
        `Local consent: ${enabled ? "enabled" : "disabled"}`,
        "Revision: 4",
        "Separate consent from notification email and notification hours.",
        "When enabled: eligible protocol approvals outside notification hours may use 6 consecutive, 20 per hour, and 80 per day with proven history.",
        "Otherwise: 3 consecutive, 10 per hour, and 40 per day. Prose always keeps 3/10/40.",
        "No approval categories are widened; session approval modes still apply.",
        "Policy changes never reset counters or refund reservations.",
        "",
      ].join("\n"));
      expect(result.stderr).toEqual([]);
    }
  });

  test("rejects malformed and mismatched results before writing either output mode", () => {
    for (const kind of ["autorespond-after-hours.enable", "autorespond-after-hours.disable"] as const) {
      const command = { kind, expectedRevision: 4 };
      const policy = { kind: "autorespond_after_hours", version: 1, revision: 5, enabled: kind === "autorespond-after-hours.enable" };
      for (const data of [
        { policy: { ...policy, enabled: !policy.enabled } },
        { policy: { ...policy, revision: 4 } },
        { policy: { ...policy, revision: 6 } },
        { policy: { ...policy, revision: Number.MAX_SAFE_INTEGER + 1 } },
        { policy: { ...policy, kind: "notification_email" } },
        { policy: { ...policy, version: 2 } },
        { policy: { ...policy, extra: true } },
        { policy, hostedAuthority: { state: "not_observed" } },
        { policy: null }, {},
      ]) for (const json of [true, false]) {
        const output = capture();
        expect(() => renderSuccess(command, data, json, output.output)).toThrow(InvalidCommandResponseError);
        expect(output.stdout).toEqual([]);
        expect(output.stderr).toEqual([]);
      }
    }
  });
});

const primaryProfileId = `acct_${"0".repeat(32)}`;
const primaryProjectId = `proj_${"2".repeat(32)}`;
const primaryTurnId = publicProviderId("turn-1");
const command = { kind: "session.show", session: primarySessionId, detail: false } as const;
const data = {
  session: {
    activeTurnId: "raw-active-turn",
    createdAt: 1_000,
    fastEnabled: false,
    id: primarySessionId,
    note: "private local note",
    preset: "high",
    profileId: primaryProfileId,
    projectId: primaryProjectId,
    provider: "codex",
    providerThreadId: "thread-1",
    providerUpdatedAt: 1_500,
    revision: 2,
    state: "idle",
    title: "Local title",
    updatedAt: 2_000,
  },
  effectiveRuntimeProfile: {
    profileId: primaryProfileId,
    processGeneration: 3,
    observedAt: 2_000,
    preset: "high",
    model: "gpt-6-astra",
    reasoningEffort: "max",
    serviceTier: null,
    fast: false,
    approvalPolicy: "on-request",
    reviewMode: "auto_review",
    permissionProfile: ":workspace",
    computerUse: true,
    pluginCapability: true,
    enabledApps: [{ id: "app.files", name: "Files", pluginDisplayNames: ["Files plugin"] }],
  },
  projection: {
    providerThreadId: "thread-1",
    title: "Fix bounded history",
    status: "idle",
    projectRoot: "/workspace/project",
    messages: [
      { role: "user", text: "please fix it", turnId: primaryTurnId },
      { role: "assistant", text: "fixed\nverified", turnId: primaryTurnId, omission: { originalUtf8Bytes: 18, returnedUtf8Bytes: 14, omittedUtf8Bytes: 4 } },
    ],
    turnSummaries: [
      { id: primaryTurnId, status: "completed", runtimeMs: 1_234, files: ["src/index.ts"], actions: ["git status", "bun test"], omittedFiles: 0, omittedActions: 0 },
    ],
    omission: { hasMoreOlderTurns: true, returnedTurns: 1, turnLimit: 24, omittedMessages: 2, truncatedMessages: 1, unreadItemTurnIds: [], incompleteTurnIds: [] },
  },
};

describe("CLI rendering", () => {
  test("escapes line separators while preserving intentional join controls", () => {
    const source =
      `a${String.fromCodePoint(0x2028)}b${String.fromCodePoint(0x2029)}c`;
    const joiners = `x${String.fromCodePoint(0x200c)}y${String.fromCodePoint(0x200d)}z`;

    expect(terminalSafe(source)).toBe("a\\u{2028}b\\u{2029}c");
    expect(terminalSafe(joiners)).toBe(joiners);
  });

  test("renders notification hours without implying approval or autonomy behavior", () => {
    const notificationData = {
      policy: {
        version: 1 as const,
        revision: 2,
        startMinute: 10 * 60,
        endMinute: 22 * 60,
        timeZone: "UTC",
      },
      observedAt: Date.parse("2026-09-04T12:30:00.000Z"),
      withinHours: true,
    };
    const human = capture();
    renderSuccess(
      { kind: "notification-hours.status" },
      notificationData,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toBe([
      "Notification hours",
      "Range: 10:00-22:00",
      "Time zone: UTC",
      "Current: yes",
      "Revision: 2",
      "Observed: 2026-09-04T12:30:00.000Z",
      "",
    ].join("\n"));
    expect(human.stdout.join("")).not.toMatch(/approval|autonomy|automatic/iu);

    const json = capture();
    renderSuccess(
      { kind: "notification-hours.status" },
      notificationData,
      true,
      json.output,
    );
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "notification-hours.status",
      data: notificationData,
      ok: true,
      version: 1,
    });
  });

  test("rejects malformed or command-mismatched notification-hours results", () => {
    const command = {
      kind: "notification-hours.set",
      expectedRevision: 2,
      version: 1,
      startMinute: 22 * 60,
      endMinute: 6 * 60,
      timeZone: "UTC",
    } as const;
    const result = {
      policy: {
        version: 1 as const,
        revision: 3,
        startMinute: command.startMinute,
        endMinute: command.endMinute,
        timeZone: command.timeZone,
      },
      observedAt: Date.parse("2026-09-04T23:00:00.000Z"),
      withinHours: true,
    };
    expect(() => renderSuccess(command, {
      ...result,
      authority: "invented",
    }, true, capture().output)).toThrow(InvalidCommandResponseError);
    expect(() => renderSuccess(command, {
      ...result,
      policy: { ...result.policy, revision: 4 },
    }, true, capture().output)).toThrow(InvalidCommandResponseError);
    expect(() => renderSuccess(command, {
      ...result,
      withinHours: false,
    }, true, capture().output)).toThrow(InvalidCommandResponseError);
    expect(() => renderSuccess(command, {
      ...result,
      observedAt: Number.MAX_SAFE_INTEGER,
    }, true, capture().output)).toThrow(InvalidCommandResponseError);
  });

  test("renders local notification-email authority without claiming hosted revocation", () => {
    const data = {
      hostedAuthority: { state: "not_observed" as const },
      policy: { enabled: false, revision: 4, version: 1 as const },
    };
    const human = capture();
    renderSuccess({ kind: "notification-email.status" }, data, false, human.output);
    expect(human.stdout.join("")).toBe([
      "Attention email notifications",
      "Local setting: disabled",
      "Revision: 4",
      "Hosted authority: not observed",
      "No hosted acknowledgement is claimed.",
      "",
    ].join("\n"));

    const json = capture();
    renderSuccess({ kind: "notification-email.status" }, data, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "notification-email.status",
      data,
      ok: true,
      version: 1,
    });
  });

  test("renders observed, acknowledged, and bounded-pending hosted authority truthfully", () => {
    const currentAuthority = {
      deviceAuthority: {
        consentLeaseUntil: 180_000,
        globalNotificationGeneration: 3,
        localNotificationPolicyRevision: 4,
      },
      globalNotificationGeneration: 3,
      globalState: "enabled" as const,
      observedAt: 60_000,
      state: "observed" as const,
    };
    const cases = [
      {
        authority: currentAuthority,
        enabled: true,
        expected: ["Hosted authority: enabled", "Device consent current: yes"],
      },
      {
        authority: {
          acknowledgedAt: 60_000,
          consentLeaseUntil: 60_000,
          state: "acknowledged" as const,
        },
        enabled: false,
        expected: [
          "Hosted invalidation: acknowledged",
          "does not claim recall of any delivery already started",
        ],
      },
      {
        authority: {
          expiresNoLaterThan: 180_000,
          state: "revocation_pending" as const,
        },
        enabled: false,
        expected: [
          "Hosted invalidation: pending",
          "expires no later than",
          "does not claim recall of any delivery already started",
        ],
      },
    ];
    for (const entry of cases) {
      const output = capture();
      renderSuccess({ kind: "notification-email.status" }, {
        hostedAuthority: entry.authority,
        policy: { enabled: entry.enabled, revision: 4, version: 1 },
      }, false, output.output);
      for (const expected of entry.expected) {
        expect(output.stdout.join("")).toContain(expected);
      }
    }

    for (const authority of [
      { ...currentAuthority, globalState: "disabled" as const },
      { ...currentAuthority, globalState: "safety_latched" as const },
      {
        ...currentAuthority,
        deviceAuthority: { ...currentAuthority.deviceAuthority, consentLeaseUntil: 60_000 },
      },
      {
        ...currentAuthority,
        deviceAuthority: {
          ...currentAuthority.deviceAuthority,
          localNotificationPolicyRevision: 3,
        },
      },
      {
        ...currentAuthority,
        deviceAuthority: {
          ...currentAuthority.deviceAuthority,
          globalNotificationGeneration: 2,
        },
      },
    ]) {
      const output = capture();
      renderSuccess({ kind: "notification-email.status" }, {
        hostedAuthority: authority,
        policy: { enabled: true, revision: 4, version: 1 },
      }, false, output.output);
      expect(output.stdout.join("")).toContain("Device consent current: no");
      expect(output.stdout.join("")).toContain("Device consent generation:");
    }

    const locallyDisabled = capture();
    renderSuccess({ kind: "notification-email.status" }, {
      hostedAuthority: currentAuthority,
      policy: { enabled: false, revision: 4, version: 1 },
    }, false, locallyDisabled.output);
    expect(locallyDisabled.stdout.join("")).toContain("Device consent current: no");

    expect(() => renderSuccess({ kind: "notification-email.status" }, {
      hostedAuthority: {
        ...currentAuthority,
        deviceAuthority: {
          ...currentAuthority.deviceAuthority,
          consentLeaseUntil: currentAuthority.observedAt + 2 * 60 * 1_000 + 1,
        },
      },
      policy: { enabled: true, revision: 4, version: 1 },
    }, false, capture().output)).toThrow(InvalidCommandResponseError);
  });

  test("rejects malformed and command-mismatched notification-email results", () => {
    const command = {
      expectedRevision: 4,
      kind: "notification-email.enable",
    } as const;
    const result = {
      hostedAuthority: { state: "not_observed" as const },
      policy: { enabled: true, revision: 5, version: 1 as const },
    };
    for (const data of [
      { ...result, policy: { ...result.policy, enabled: false } },
      { ...result, policy: { ...result.policy, revision: 6 } },
      { ...result, hostedAuthority: { state: "acknowledged" } },
      { ...result, extra: true },
    ]) expect(() => renderSuccess(command, data, true, capture().output))
      .toThrow(InvalidCommandResponseError);

    const acknowledged = {
      acknowledgedAt: 60_000,
      consentLeaseUntil: 60_000,
      state: "acknowledged" as const,
    };
    expect(() => renderSuccess(command, {
      hostedAuthority: acknowledged,
      policy: result.policy,
    }, true, capture().output)).toThrow(InvalidCommandResponseError);
    expect(() => renderSuccess({
      expectedRevision: 4,
      kind: "notification-email.disable",
    }, {
      hostedAuthority: {
        deviceAuthority: null,
        globalNotificationGeneration: 3,
        globalState: "enabled",
        observedAt: 60_000,
        state: "observed",
      },
      policy: { enabled: false, revision: 5, version: 1 },
    }, true, capture().output)).toThrow(InvalidCommandResponseError);
    expect(() => renderSuccess({
      expectedRevision: 4,
      kind: "notification-email.disable",
    }, {
      hostedAuthority: acknowledged,
      policy: { enabled: false, revision: 5, version: 1 },
    }, true, capture().output)).not.toThrow();
  });

  test("renders a Claude session's reviewed runtime profile, not the Codex one", () => {
    const claudeSession = {
      createdAt: 1_000,
      fastEnabled: false,
      id: `sess_${"c".repeat(32)}`,
      note: "private Claude note",
      preset: "fable-max",
      profileId: primaryProfileId,
      projectId: primaryProjectId,
      provider: "claude",
      providerThreadId: "thread-claude",
      revision: 2,
      state: "idle",
      title: "Claude work",
      updatedAt: 2_000,
    } as const;
    const shown = capture();
    renderSuccess(
      { detail: true, kind: "session.show", session: "claude-session" },
      {
        effectiveRuntimeProfile: {
          claudeVersion: "2.1.260",
          configHome: "isolated",
          inputFormat: "stream-json",
          model: "claude-fable-5-1",
          observedAt: 2_000,
          outputFormat: "stream-json",
          permissionMode: "default",
          preset: "fable-max",
          processGeneration: 3,
          profileId: "acct_00000000000000000000000000000000",
          reasoningEffort: "max",
        },
        projection: {
          messages: [{ role: "user", text: "hello", turnId: "turn-1" }],
          projectRoot: "/workspace/project",
          providerThreadId: "thread-claude",
          status: "idle",
          title: "Claude work",
          turnSummaries: [],
        },
        session: claudeSession,
      },
      false,
      shown.output,
    );
    const rendered = shown.stdout.join("");
    expect(rendered).toContain("provider: Claude Code 2.1.260");
    expect(rendered).toContain("preset: fable-max");
    expect(rendered).toContain("model: claude-fable-5-1");
    expect(rendered).toContain("permission mode: default");
    expect(rendered).not.toContain("config home");
    expect(rendered).not.toContain("isolatedConfigDir");
    expect(rendered).toContain("stream: stream-json in, stream-json out");
    // No Codex-only row is invented for a provider that has none of them.
    expect(rendered).not.toContain("service tier");
    expect(rendered).not.toContain("Fast:");
    expect(rendered).not.toContain("plugin capability");
    expect(rendered).not.toContain("enabled apps");

    const json = capture();
    renderSuccess(
      { detail: false, kind: "session.show", session: "claude-session" },
      {
        effectiveRuntimeProfile: {
          claudeVersion: "2.1.260",
          configHome: "personal",
          inputFormat: "stream-json",
          model: "claude-fable-5-1",
          observedAt: 2_000,
          outputFormat: "stream-json",
          permissionMode: "default",
          preset: "fable-max",
          processGeneration: 3,
          profileId: "acct_00000000000000000000000000000000",
          reasoningEffort: "max",
        },
        projection: {
          providerThreadId: "thread-claude",
          status: "idle",
          title: "Claude work",
        },
        session: claudeSession,
      },
      true,
      json.output,
    );
    const document = JSON.parse(json.stdout.join("")) as {
      data: { effectiveRuntimeProfile: Record<string, unknown> };
    };
    expect(document.data.effectiveRuntimeProfile).not.toHaveProperty("configHome");
    expect(document.data.effectiveRuntimeProfile).not.toHaveProperty("isolatedConfigDir");
  });

  test.each(["session.start", "session.send", "session.show"] as const)(
    "renders already-public Claude runtime evidence from the service: %s", (kind) => {
      const profile = projectPublicReviewedRuntimeProfile(effectiveClaudeRuntimeProfileSchema.parse({
        claudeVersion: "2.1.260", configHome: "isolated", inputFormat: "stream-json",
        model: "claude-fable-5-1", observedAt: 2_000, outputFormat: "stream-json",
        permissionMode: "default", preset: "fable-max", processGeneration: 3,
        profileId: primaryProfileId, reasoningEffort: "max",
      }));
      const idempotencyKey = "00000000-0000-4000-8000-000000000811";
      const sessionCommand = kind === "session.show"
        ? { kind, session: primarySessionId, detail: false } as const
        : kind === "session.send"
          ? { kind, session: primarySessionId, message: "hello", idempotencyKey } as const
          : { kind, account: primaryProfileId, provider: "claude", preset: "fable-max",
              project: primaryProjectId, fast: false, idempotencyKey } as const;
      const response = {
        session: { ...data.session, provider: "claude", preset: "fable-max" },
        effectiveRuntimeProfile: profile,
        ...(kind === "session.show" ? {} : { idempotencyKey }),
        ...(kind === "session.send" ? { turnId: "private-claude-turn" } : {}),
      };
      for (const json of [false, true]) {
        const target = capture();
        renderSuccess(sessionCommand, response, json, target.output);
        expect(target.stderr).toEqual([]);
        const rendered = target.stdout.join("");
        expect(rendered.length).toBeGreaterThan(0);
        expect(rendered).not.toContain("configHome");
        expect(rendered).not.toContain("isolatedConfigDir");
        expect(rendered).not.toContain("private-claude-turn");
        if (json) expect(JSON.parse(rendered)).toMatchObject({
          ok: true, data: { effectiveRuntimeProfile: profile },
        });
        for (const invalid of [
          { ...profile, unexpectedPrivateField: "do-not-render" },
          { ...profile, model: "unreviewed-model" },
        ]) {
          const rejected = capture();
          expect(() => renderSuccess(sessionCommand, {
            ...response, effectiveRuntimeProfile: invalid,
          }, json, rejected.output)).toThrow(InvalidCommandResponseError);
          expect(rejected.stdout).toEqual([]);
        }
      }
    },
  );

  test("renders bounded local root status with closed recovery commands", () => {
    const status = {
      version: 1 as const,
      scope: "local_only" as const,
      localObservation: {
        source: "sqlite" as const,
        coverage: "complete" as const,
        freshness: "fresh" as const,
        observedAt: 1_000,
        tables: [
          "profiles",
          "sessions",
          "provider_interactions",
          "queue_entries",
          "usage_snapshots",
          "usage_poll_failures",
        ] as const,
      },
      providerObservation: {
        source: "codex_app_server" as const,
        coverage: "not_attempted" as const,
        freshness: "unknown" as const,
        observedAt: null,
      },
      cloudObservation: {
        source: "convex" as const,
        coverage: "not_attempted" as const,
        freshness: "unknown" as const,
        observedAt: null,
        devices: { registered: null, online: null },
      },
      counts: {
        accounts: { signedOut: 1, loginPending: 0, signedIn: 1, recoveryRequired: 0 },
        sessions: { starting: 0, active: 1, idle: 2, terminal: 3, recoveryRequired: 1 },
        interactions: {
          pending: 1,
          responsePrepared: 0,
          responseWritten: 0,
          resolved: 2,
          declined: 0,
          canceled: 0,
          expired: 0,
          resolutionUnknown: 0,
        },
        queue: { pending: 1, dispatching: 0, applied: 2, failed: 0, ambiguous: 0, cancelled: 0 },
        usage: { observed: 1, failed: 0, missing: 1 },
      },
      attention: {
        total: 1,
        truncated: false,
        records: [{
          kind: "session_recovery_required" as const,
          accountId: "acct_00000000000000000000000000000000",
          sessionId: "sess_00000000000000000000000000000000",
          sessionRevision: 7,
          observedAt: 1_000,
          intent: {
            kind: "inspect_session" as const,
            sessionId: "sess_00000000000000000000000000000000",
          },
        }],
      },
    };
    const human = capture();
    renderRootStatus(status, false, human.output);
    expect(human.stdout.join("")).toContain("Coverage: local complete; provider not_attempted; cloud not_attempted");
    expect(human.stdout.join("")).toContain(
      "Devices: registered unknown, online unknown (cloud not_attempted)",
    );
    expect(human.stdout.join("")).toContain(
      "oompa session status sess_00000000000000000000000000000000",
    );

    const json = capture();
    renderRootStatus(status, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      ok: true,
      version: 1,
      command: "status",
      data: { scope: "local_only", attention: { total: 1 } },
    });
  });

  test("renders account add and show as state-first summaries with bounded next actions", () => {
    const accountId = `acct_${"1".repeat(32)}`;
    const account = {
      id: accountId,
      label: "Personal",
      processGeneration: 0,
      providerEmail: null,
      providerPlan: null,
      state: "signed_out",
      updatedAt: 1_000,
    };
    const added = capture();
    renderSuccess(
      { kind: "account.add", label: "Personal" },
      { account, next: `oompa account login ${accountId}` },
      false,
      added.output,
    );
    expect(added.stdout.join("")).toBe([
      "Account: signed out",
      "Label: Personal",
      `ID: ${accountId}`,
      "Provider generation: 0",
      "Updated: 1970-01-01T00:00:01.000Z",
      `Next: oompa account login ${accountId}`,
      "",
    ].join("\n"));

    const shown = capture();
    renderSuccess(
      { kind: "account.show", account: "Personal" },
      {
        account: {
          ...account,
          processGeneration: 2,
          providerEmail: "person@example.com",
          providerPlan: "Plus",
          state: "login_pending",
          updatedAt: 2_000,
        },
        login: {
          loginId: "PRIVATE-LOGIN-AUTHORITY",
          next: `oompa account login-cancel ${accountId}`,
          status: "pending",
        },
        providerProjection: { signedIn: false },
        unexpectedPath: "/private/provider/profile",
      },
      false,
      shown.output,
    );
    expect(shown.stdout.join("")).toBe([
      "Account: login pending",
      "Label: Personal",
      `ID: ${accountId}`,
      "Email: person@example.com",
      "Plan: Plus",
      "Provider generation: 2",
      "Updated: 1970-01-01T00:00:02.000Z",
      "Provider: signed out",
      "Login: pending",
      `Next: oompa account login-cancel ${accountId}`,
      "",
    ].join("\n"));
    expect(shown.stdout.join("")).not.toContain("PRIVATE-LOGIN-AUTHORITY");
    expect(shown.stdout.join("")).not.toContain("/private/provider/profile");
  });

  test("renders Claude account status without sibling Codex identity fields", () => {
    const accountId = `acct_${"1".repeat(32)}`;
    const data = {
      account: { id: accountId, label: "Private" },
      authentication: { provider: "claude", signedIn: false },
      nextCommand: `oompa account login ${accountId} --provider claude`,
      providerGeneration: 4,
    } as const;
    const human = capture();
    renderSuccess(
      { kind: "account.show", account: accountId, provider: "claude" },
      data,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toBe([
      "Claude Code: signed out",
      "Label: Private",
      `ID: ${accountId}`,
      "Provider generation: 4",
      `Next: oompa account login ${accountId} --provider claude`,
      "",
    ].join("\n"));
    const json = capture();
    renderSuccess(
      { kind: "account.show", account: accountId, provider: "claude" },
      data,
      true,
      json.output,
    );
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "account.show",
      data,
      ok: true,
      version: 1,
    });
    expect(json.stdout.join("")).not.toMatch(/providerEmail|providerPlan|updatedAt|state/u);
  });

  test("renders retired Devin history without suggesting login or fabricating usage", () => {
    const accountId = `acct_${"9".repeat(32)}`;
    const data = {
      account: { id: accountId, label: "Retired history" },
      provider: "devin",
      status: "retired",
      providerGeneration: 2,
      credentialAction: "none",
      diagnostic: "Devin support has been removed. Existing credentials are unchanged.",
    } as const;
    const human = capture();
    renderSuccess(
      { kind: "account.show", account: accountId, provider: "devin" },
      data,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toBe([
      "Devin: retired (local history and login cleanup only)",
      "Label: Retired history",
      `ID: ${accountId}`,
      "Provider generation: 2",
      data.diagnostic,
      "",
    ].join("\n"));
    expect(human.stdout.join("")).not.toMatch(/signed in|signed out|Account allowance|oompa account login /u);
    const json = capture();
    renderSuccess({ kind: "account.show", account: accountId, provider: "devin" }, data, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "account.show", data, ok: true, version: 1,
    });

    const recovery = capture();
    const abandonCommand = `oompa account login-cancel ${accountId} --provider devin --attempt-id attempt_${"a".repeat(32)} --provider-generation 2 --idempotency-key 00000000-0000-4000-8000-000000000102 --acknowledge-child-exited`;
    renderSuccess(
      { kind: "account.show", account: accountId, provider: "devin" },
      { ...data, recovery: {
        required: true,
        diagnostic: "Confirm the original child exited; cleanup does not stop it.",
        statusCommand: `oompa account show ${accountId} --provider devin`,
        abandonCommand,
      } },
      false,
      recovery.output,
    );
    expect(recovery.stdout.join("")).toContain("Recovery: required");
    expect(recovery.stdout.join("")).toContain(`Only after confirming the original Devin child exited: ${abandonCommand}`);
    expect(recovery.stdout.join("")).not.toMatch(/signed in|signed out|Account allowance|oompa account login /u);
  });

  test("renders Claude recovery and acknowledged local abandon truthfully", () => {
    const accountId = `acct_${"2".repeat(32)}`;
    const attemptId = `attempt_${"3".repeat(32)}`;
    const key = "00000000-0000-4000-8000-000000000317";
    const abandonCommand = `oompa account login-cancel ${accountId} --provider claude --attempt-id ${attemptId} --provider-generation 4 --idempotency-key ${key} --acknowledge-child-exited`;
    const status = capture();
    renderSuccess(
      { kind: "account.show", account: accountId, provider: "claude" },
      {
        account: { id: accountId, label: "Recovery" },
        authentication: { provider: "claude", signedIn: null },
        providerGeneration: 5,
        recovery: {
          required: true,
          diagnostic: "Credential presence does not prove child exit.",
          statusCommand: `oompa account show ${accountId} --provider claude`,
          abandonCommand,
        },
      },
      false,
      status.output,
    );
    expect(status.stdout.join("")).toContain("Claude Code: status unknown");
    expect(status.stdout.join("")).toContain(
      `Only after confirming the original Claude Code child exited: ${abandonCommand}`,
    );

    const abandoned = capture();
    renderSuccess({
      kind: "account.claude-login.abandon",
      account: accountId,
      attemptId,
      idempotencyKey: key,
      providerGeneration: 4,
      acknowledgeChildExited: true,
    }, {
      account: { id: accountId, label: "Recovery" },
      login: { status: "abandoned", localOnly: true, credentialAction: "none" },
    }, false, abandoned.output);
    expect(abandoned.stdout.join("")).toContain(
      "Oompa did not stop Claude or change or delete Claude credentials",
    );
  });

  test("renders auth status as a state-first device handoff without changing JSON", () => {
    const pendingDeviceId = `device_${"A".repeat(24)}`;
    const localDeviceId = `device_${"B".repeat(24)}`;
    const data = {
      automaticRegistrationPending: false,
      authEpoch: 3,
      configured: true,
      device: {
        keyVersion: 2,
        publicId: pendingDeviceId,
        revision: 4,
        status: "pending",
      },
      email: "reader@example.com",
      lastSync: null,
      pairingRequired: false,
      signedIn: true,
    };
    const human = capture();
    renderSuccess({ kind: "auth.status" }, data, false, human.output);
    expect(human.stdout.join("")).toBe([
      "Cloud account: signed in",
      "Email: reader@example.com",
      `Device: pending (${pendingDeviceId})`,
      "Last sync: never",
      `Next: on an active device, run oompa device approve ${pendingDeviceId}`,
      "",
    ].join("\n"));

    const json = capture();
    renderSuccess({ kind: "auth.status" }, data, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "auth.status",
      data,
      ok: true,
      version: 1,
    });

    const signedOut = capture();
    renderSuccess({ kind: "auth.status" }, {
      configured: true,
      device: { publicId: localDeviceId },
      lastSync: null,
      signedIn: false,
    }, false, signedOut.output);
    expect(signedOut.stdout.join("")).toBe([
      "Cloud account: signed out",
      `Device: known locally (${localDeviceId})`,
      "Last sync: never",
      "Next: oompa auth login --input-stdin",
      "",
    ].join("\n"));
  });

  test("renders devices as control-safe bounded blocks and preserves the exact JSON DTO", () => {
    const currentDeviceId = `device_${"D".repeat(24)}`;
    const pendingDeviceId = `device_${"P".repeat(24)}`;
    const revokedDeviceId = `device_${"R".repeat(24)}`;
    const unsafeLabel = "Desk\u001b[31m\nLine";
    const data = {
      currentDevicePublicId: currentDeviceId,
      devices: [
        {
          activatedAt: 1_700_000_000_000,
          current: true,
          deviceClass: "daemon",
          fingerprint: "0f1e-2d3c-4b5a-6978-8796-a5b4-c3d2-e1f0",
          keyVersion: 1,
          label: unsafeLabel,
          labelSource: "encrypted",
          lastSeenAt: 1_700_000_000_000,
          online: true,
          publicId: currentDeviceId,
          revision: 3,
          status: "active",
        },
        {
          current: false,
          deviceClass: "browser",
          fingerprint: "1111-2222-3333-4444-5555-6666-7777-8888",
          keyVersion: 1,
          label: "Pending device PPPPPPPP",
          labelSource: "fallback",
          lastSeenAt: null,
          online: false,
          publicId: pendingDeviceId,
          revision: 1,
          status: "pending",
        },
        {
          activatedAt: 1_699_999_000_000,
          current: false,
          deviceClass: "daemon",
          fingerprint: "9999-aaaa-bbbb-cccc-dddd-eeee-ffff-0000",
          keyVersion: 1,
          label: "Revoked device RRRRRRRR",
          labelSource: "fallback",
          lastSeenAt: 1_700_000_000_000,
          online: false,
          publicId: revokedDeviceId,
          revision: 4,
          status: "revoked",
        },
      ],
    } as const;
    const human = capture();
    renderSuccess({ kind: "device.list" }, data, false, human.output);
    const rendered = human.stdout.join("");
    expect(rendered).toContain("Devices: 3");
    expect(rendered).toContain("Device 1 (current)");
    expect(rendered).toContain("  Label:");
    expect(rendered).toContain("  Status:");
    expect(rendered).toContain("  Presence:");
    expect(rendered).toContain("  ID:");
    expect(rendered).toContain("  Class: daemon");
    expect(rendered).toContain("  Class: browser");
    expect(rendered).toContain("  Fingerprint: 1111-2222-3333-4444-5555-6666-7777-8888");
    expect(rendered).toContain("Desk\\u{001b}[31m\\u{000a}Line");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).not.toContain(unsafeLabel);
    expect(rendered).toContain("online");
    expect(rendered).toContain("not seen");
    expect(rendered).toContain("last seen 2023-11-14T22:13:20.000Z");
    expect(rendered).toContain(currentDeviceId);
    expect(rendered).toContain(pendingDeviceId);
    expect(rendered).toContain(revokedDeviceId);
    expect(rendered).toContain("[fallback]");
    expect(rendered).toContain("the encrypted label was not authentic under this account key");

    const json = capture();
    renderSuccess({ kind: "device.list" }, data, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "device.list",
      data,
      ok: true,
      version: 1,
    });
  });

  test("rejects malformed device-list authority and never projects ciphertext", () => {
    const currentDeviceId = `device_${"D".repeat(24)}`;
    const validDevice = {
      current: true,
      keyVersion: 1,
      label: "Oompa device DDDDDDDD",
      labelSource: "encrypted",
      lastSeenAt: null,
      online: false,
      publicId: currentDeviceId,
      revision: 1,
      status: "active",
    } as const;
    const invalidValues: unknown[] = [
      { currentDevicePublicId: currentDeviceId, devices: [{ ...validDevice, current: false }] },
      { currentDevicePublicId: currentDeviceId, devices: [validDevice, validDevice] },
      { currentDevicePublicId: currentDeviceId, devices: [{ ...validDevice, labelSource: "server" }] },
      { currentDevicePublicId: currentDeviceId, devices: [{ ...validDevice, label: "/private/device" }] },
      { currentDevicePublicId: currentDeviceId, devices: [{ ...validDevice, label: "   " }] },
      { currentDevicePublicId: currentDeviceId, devices: [{ ...validDevice, label: " padded" }] },
      { currentDevicePublicId: currentDeviceId, devices: [{ ...validDevice, status: "revoked", online: true }] },
      {
        currentDevicePublicId: currentDeviceId,
        devices: [{
          ...validDevice,
          encryptedLabel: { ciphertext: "PRIVATE-CIPHERTEXT" },
        }],
      },
    ];
    for (const data of invalidValues) {
      const human = capture();
      expect(() => renderSuccess({ kind: "device.list" }, data, false, human.output))
        .toThrow(InvalidCommandResponseError);
      expect(human.stdout.join("")).toBe("");
    }

    const json = capture();
    expect(() => renderSuccess({ kind: "device.list" }, invalidValues.at(-1), true, json.output))
      .toThrow(InvalidCommandResponseError);
    expect(json.stdout.join("")).toBe("");
    expect(json.stdout.join("")).not.toContain("PRIVATE-CIPHERTEXT");
  });

  test("renders device-label Unicode without invisible-only or bidi terminal ambiguity", () => {
    const publicId = `device_${"U".repeat(24)}`;
    const renderLabel = (label: string): string => {
      const target = capture();
      renderSuccess({ kind: "device.list" }, {
        currentDevicePublicId: publicId,
        devices: [{
          current: true,
          deviceClass: "daemon",
          fingerprint: "0f1e-2d3c-4b5a-6978-8796-a5b4-c3d2-e1f0",
          keyVersion: 1,
          label,
          labelSource: "encrypted",
          lastSeenAt: null,
          online: false,
          publicId,
          revision: 1,
          status: "active",
        }],
      }, false, target.output);
      return target.stdout.join("");
    };

    const zwjOnly = renderLabel("\u200d");
    expect(zwjOnly).toContain("Label: \\u{200d}");
    expect(zwjOnly).not.toContain("\u200d");

    const combiningOnly = renderLabel("\u0301");
    expect(combiningOnly).toContain("Label: \\u{0301}");
    expect(combiningOnly).not.toContain("\u0301");

    expect(renderLabel("Cafe\u0301")).toContain("Label: Cafe\u0301");
    expect(renderLabel("東京")).toContain("Label: 東京");
    const family = "👩‍👩‍👧‍👦";
    expect(renderLabel(family)).toContain(`Label: ${family}`);
    expect(renderLabel(family)).not.toContain("\\u{200d}");

    const bidi = renderLabel("abc\u202edef");
    expect(bidi).toContain("Label: abc\\u{202e}def");
    expect(bidi).not.toContain("\u202e");
  });

  test("bounds the human device view while leaving complete JSON available", () => {
    const devices = Array.from({ length: 101 }, (_, index) => {
      const publicId = `device_${String(index).padStart(8, "0")}`;
      return {
        current: index === 0,
        deviceClass: "daemon" as const,
        fingerprint: "0f1e-2d3c-4b5a-6978-8796-a5b4-c3d2-e1f0",
        keyVersion: 1,
        label: "\u200d".repeat(160),
        labelSource: "fallback" as const,
        lastSeenAt: null,
        online: false,
        publicId,
        revision: 1,
        status: "active" as const,
      };
    });
    const data = { currentDevicePublicId: devices[0]?.publicId, devices };
    const human = capture();
    renderSuccess({ kind: "device.list" }, data, false, human.output);
    expect(human.stdout.join("")).toContain(
      "1 additional devices omitted from this bounded view; use --json for the complete list.",
    );
    expect(human.stdout.join("")).not.toContain("device_00000100");
    expect(human.stdout.join("")).not.toContain("\u200d");
    expect(new TextEncoder().encode(human.stdout.join("")).byteLength).toBeLessThan(160_000);

    const json = capture();
    renderSuccess({ kind: "device.list" }, data, true, json.output);
    expect((JSON.parse(json.stdout.join("")) as { data: { devices: unknown[] } }).data.devices)
      .toHaveLength(101);
  });

  test("renders authoritative pairing and acknowledged account-key loss without implying regeneration", () => {
    const deviceId = `device_${"K".repeat(24)}`;
    const pairing = capture();
    renderSuccess({ kind: "auth.status" }, {
      accountKey: {
        ifNoHolder: "unrecoverable",
        recovery: "existing_key_holder_required",
        status: "pairing_required",
      },
      automaticRegistrationPending: false,
      configured: true,
      device: { publicId: deviceId, status: "active" },
      pairingRequired: false,
      signedIn: true,
    }, false, pairing.output);
    expect(pairing.stdout.join("")).toBe([
      "Cloud account: signed in",
      `Device: active (${deviceId})`,
      "Account key: pairing required",
      "Recovery: an existing account-key holder must pair this device.",
      "Local Codex data: unaffected.",
      "No existing key holder: oompa device key-loss --acknowledge-no-key-holders",
      "Next: oompa device pair",
      "",
    ].join("\n"));

    const data = {
      acknowledgedNoKeyHolders: true,
      accountKey: {
        evidence: "operator_confirmed_no_key_holders",
        status: "unrecoverable",
      },
      localOnly: true,
      replay: false,
    } as const;
    const acknowledged = capture();
    renderSuccess({
      acknowledgeNoKeyHolders: true,
      kind: "device.key-loss",
    }, data, false, acknowledged.output);
    expect(acknowledged.stdout.join("")).toBe([
      "Account-key loss acknowledgement: recorded locally.",
      "Account key: unrecoverable (operator confirmed no key holders)",
      "Local Codex data: unaffected.",
      "Existing encrypted cloud content: cannot be decrypted.",
      "Recovery: search again for an existing account-key holder, then pair the real key.",
      "Fallback: erase and reinitialize the Oompa cloud account only after that renewed holder search is exhausted. The lost account key cannot be regenerated.",
      "No account key, device key, or ciphertext was minted, replaced, or deleted.",
      "Next: oompa device pair",
      "",
    ].join("\n"));

    const json = capture();
    renderSuccess({
      acknowledgeNoKeyHolders: true,
      kind: "device.key-loss",
    }, data, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "device.key-loss",
      data,
      ok: true,
      version: 1,
    });
  });

  test("renders sync status with last-sync and projection health while redacting diagnostics", () => {
    const secret = "token=SYNC-STATUS-SECRET";
    const activeDeviceId = `device_${"C".repeat(24)}`;
    const data = {
      automaticRegistrationPending: false,
      configured: true,
      device: {
        keyVersion: 1,
        publicId: activeDeviceId,
        revision: 2,
        status: "active",
      },
      lastSync: {
        accountCount: 2,
        at: 3_000,
        sessionCount: 7,
        usageSnapshotCount: 2,
      },
      pairingRequired: false,
      projectionCache: {
        affectedSessions: ["sess_11111111111111111111111111111111"],
        affectedSessionsTruncated: false,
        code: "STREAM_RECOVERY_REQUIRED",
        diagnostic: `Recovery failed at /private/cache ${secret}`,
        sessions: 1,
        state: "degraded",
      },
      projectionRecovery: {
        recoveries: [
          { idempotencyKey: "private-key-1", phase: "prepared", sessionPublicId: "private-session-1" },
          { cacheActivated: true, idempotencyKey: "private-key-2", phase: "applied", sessionPublicId: "private-session-2" },
        ],
        recoveriesTruncated: true,
        totalRecoveries: 150,
      },
      signedIn: true,
    };
    const target = capture();
    renderSuccess({ kind: "sync.status" }, data, false, target.output);
    expect(target.stdout.join("")).toBe([
      "Cloud sync: degraded (projection cache)",
      `Device: active (${activeDeviceId})`,
      "Last sync: 1970-01-01T00:00:03.000Z (2 accounts, 7 sessions, 2 usage snapshots)",
      "Projection cache: degraded (STREAM_RECOVERY_REQUIRED)",
      "Projection sessions needing recovery: 1",
      "  Recover: sess_11111111111111111111111111111111",
      "Projection detail: Recovery failed at [local-path] [redacted]",
      "Projection recoveries: 2 of 150 shown (prepared 1, applied 1)",
      "Next: oompa doctor",
      "",
    ].join("\n"));
    expect(target.stdout.join("")).not.toContain("SYNC-STATUS-SECRET");
    expect(target.stdout.join("")).not.toContain("/private/cache");
    expect(target.stdout.join("")).not.toContain("private-key");
    expect(target.stdout.join("")).not.toContain("private-session");
  });

  test("keeps projection failures and unsettled recoveries out of the ready sync state", () => {
    const base = {
      automaticRegistrationPending: false,
      configured: true,
      device: {
        publicId: `device_${"B".repeat(24)}`,
        status: "active",
      },
      lastSync: null,
      pairingRequired: false,
      signedIn: true,
    };
    const cases = [
      {
        data: {
          ...base,
          projectionCache: {
            code: "CACHE_CORRUPT_OR_UNREADABLE",
            state: "unavailable",
          },
        },
        state: "Cloud sync: unavailable (projection cache)",
        next: "Next: oompa doctor",
      },
      {
        data: {
          ...base,
          projectionCache: { state: "ready" },
          projectionRecovery: {
            recoveries: [{
              phase: "effect_started",
              cacheActivated: false,
              idempotencyKey: "018bcfe5-6800-7000-8000-000000000702",
              sessionPublicId: `sess_${"2".repeat(32)}`,
            }],
            recoveriesTruncated: false,
            totalRecoveries: 1,
          },
        },
        state: "Cloud sync: recovery required (projection)",
        next: `Next: oompa sync projection recover sess_${"2".repeat(32)} --acknowledge-gap --idempotency-key 018bcfe5-6800-7000-8000-000000000702`,
      },
      {
        data: {
          ...base,
          projectionCache: {
            affectedSessions: [`sess_${"2".repeat(32)}`],
            code: "STREAM_RECOVERY_REQUIRED",
            sessions: 1,
            state: "degraded",
          },
          projectionRecovery: {
            recoveries: [{
              phase: "effect_started",
              cacheActivated: false,
              idempotencyKey: "018bcfe5-6800-7000-8000-000000000702",
              sessionPublicId: `sess_${"2".repeat(32)}`,
            }],
            recoveriesTruncated: false,
            totalRecoveries: 1,
          },
        },
        state: "Cloud sync: degraded (projection cache)",
        next: `Next: oompa sync projection recover sess_${"2".repeat(32)} --acknowledge-gap --idempotency-key 018bcfe5-6800-7000-8000-000000000702`,
      },
    ];
    for (const entry of cases) {
      const target = capture();
      renderSuccess({ kind: "sync.status" }, entry.data, false, target.output);
      expect(target.stdout.join("")).toContain(`${entry.state}\n`);
      expect(target.stdout.join("")).toContain(`${entry.next}\n`);
      expect(target.stdout.join("")).not.toContain("Cloud sync: ready");
    }
  });

  test("cloud recovery guidance covers both deployment aliases without selecting a different target", () => {
    for (const [reenable, guidance] of [
      [{ kind: "use_hosted_default" }, "unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon"],
      [{ kind: "restore_bound_deployment", deploymentUrl: "https://bound.convex.cloud" },
        "set OOMPA_CONVEX_URL to https://bound.convex.cloud, unset HRA_CONVEX_URL, and restart the daemon"],
    ] as const) {
      for (const kind of ["sync.status", "doctor"] as const) {
        const cloud = { configured: false, reenable, signedIn: false, unavailability: "disabled" };
        const target = capture();
        if (kind === "sync.status") renderSuccess({ kind }, cloud, false, target.output);
        else renderSuccess({ kind, offline: false }, { cloud, healthy: true, problems: [] }, false, target.output);
        expect(target.stdout.join("")).toContain(`Next: ${guidance}\n`);
        expect(target.stderr).toEqual([]);
      }
    }
  });

  test("treats intentionally disabled cloud as optional without a circular doctor action", () => {
    const target = capture();
    renderSuccess({ kind: "sync.status" }, {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon.",
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    }, false, target.output);
    expect(target.stdout.join("")).toContain("Cloud sync: unavailable\n");
    expect(target.stdout.join("")).toContain("Next: unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon\n");

    const ordinarySelfManaged = capture();
    renderSuccess({ kind: "sync.status" }, {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon.",
      reenable: {
        deploymentUrl: "https://self-managed.convex.cloud",
        kind: "restore_bound_deployment",
      },
      signedIn: false,
      unavailability: "disabled",
    }, false, ordinarySelfManaged.output);
    expect(ordinarySelfManaged.stdout.join("")).toContain(
      "Next: set OOMPA_CONVEX_URL to https://self-managed.convex.cloud, unset HRA_CONVEX_URL, and restart the daemon\n",
    );

    const recovery = capture();
    renderSuccess({ kind: "sync.status" }, {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon.",
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000702",
          phase: "effect_started",
          sessionPublicId: `sess_${"2".repeat(32)}`,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
      reenable: { kind: "use_hosted_default" },
      signedIn: false,
      unavailability: "disabled",
    }, false, recovery.output);
    expect(recovery.stdout.join("")).toContain("Cloud sync: unavailable (projection recovery pending)\n");
    expect(recovery.stdout.join("")).toContain("Recovery prerequisite: unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon.\n");
    expect(recovery.stdout.join("")).toContain(
      `Next after restart: oompa sync projection recover sess_${"2".repeat(32)} --acknowledge-gap --idempotency-key 018bcfe5-6800-7000-8000-000000000702\n`,
    );
    expect(recovery.stdout.join("")).not.toContain("Next: oompa sync projection recover");

    const selfManaged = capture();
    renderSuccess({ kind: "sync.status" }, {
      configured: false,
      diagnostic: "Cloud sync is disabled for this daemon.",
      projectionRecovery: {
        recoveries: [{
          cacheActivated: false,
          idempotencyKey: "018bcfe5-6800-7000-8000-000000000702",
          phase: "effect_started",
          sessionPublicId: `sess_${"2".repeat(32)}`,
        }],
        recoveriesTruncated: false,
        totalRecoveries: 1,
      },
      reenable: {
        deploymentUrl: "https://self-managed.convex.cloud",
        kind: "restore_bound_deployment",
      },
      signedIn: false,
      unavailability: "disabled",
    }, false, selfManaged.output);
    expect(selfManaged.stdout.join("")).toContain(
      "Recovery prerequisite: set OOMPA_CONVEX_URL to https://self-managed.convex.cloud, unset HRA_CONVEX_URL, and restart the daemon.\n",
    );
  });

  test("renders doctor results as concise human checks", () => {
    const healthy = capture();
    renderSuccess({ kind: "doctor", offline: false }, { healthy: true, problems: [] }, false, healthy.output);
    expect(healthy.stdout.join("")).toBe("Oompa checks passed.\n");

    const disabledSelfManaged = capture();
    renderSuccess({ kind: "doctor", offline: false }, {
      cloud: {
        configured: false,
        reenable: {
          deploymentUrl: "https://self-managed.convex.cloud",
          kind: "restore_bound_deployment",
        },
        unavailability: "disabled",
      },
      healthy: true,
      problems: [],
    }, false, disabledSelfManaged.output);
    expect(disabledSelfManaged.stdout.join("")).toBe(
      "Oompa checks passed.\nCloud sync: disabled (optional)\nNext: set OOMPA_CONVEX_URL to https://self-managed.convex.cloud, unset HRA_CONVEX_URL, and restart the daemon\n",
    );

    const unhealthy = capture();
    renderSuccess({ kind: "doctor", offline: false }, {
      healthy: false,
      problems: ["Repair the local projection cache."],
    }, false, unhealthy.output);
    expect(unhealthy.stdout.join("")).toBe("Oompa checks found 1 problem:\n- Repair the local projection cache.\n");

    const unhealthyDisabled = capture();
    renderSuccess({ kind: "doctor", offline: false }, {
      cloud: {
        configured: false,
        reenable: { kind: "use_hosted_default" },
        unavailability: "disabled",
      },
      healthy: false,
      problems: ["Repair the local projection cache."],
    }, false, unhealthyDisabled.output);
    expect(unhealthyDisabled.stdout.join("")).toBe([
      "Oompa checks found 1 problem:",
      "- Repair the local projection cache.",
      "",
      "Cloud sync: disabled (optional)",
      "Next: unset OOMPA_CONVEX_URL and HRA_CONVEX_URL and restart the daemon",
      "",
    ].join("\n"));

    const malformed = capture();
    renderSuccess({ kind: "doctor", offline: false }, {
      healthy: true,
      problems: [1],
    }, false, malformed.output);
    expect(malformed.stdout.join("")).toBe("Oompa checks returned an invalid local result.\n");
  });

  test("never interpolates a noncanonical or hostile device ID into an approval command", () => {
    const attack = "device_AAAAAAAAAAAAAAAAAAAAAAAA; touch /tmp/Oompa-DEVICE-INJECTION";
    const target = capture();
    renderSuccess({ kind: "auth.status" }, {
      configured: true,
      device: { publicId: attack, status: "pending" },
      lastSync: null,
      signedIn: true,
    }, false, target.output);
    expect(target.stdout.join("")).toContain("Next: oompa device list");
    expect(target.stdout.join("")).not.toContain("oompa device approve");
    expect(target.stdout.join("")).not.toContain("touch /tmp/Oompa-DEVICE-INJECTION");
  });

  test("renders a bound signed-out failure next command without changing JSON details", () => {
    const accountId = `acct_${"2".repeat(32)}`;
    const error = {
      code: "INTERACTION_REQUIRED",
      details: {
        accountSelector: accountId,
        accountState: "signed_out",
        nextCommand: `oompa account login ${accountId}`,
      },
      message: `Sign in with \`oompa account login ${accountId}\` before using this account's Codex runtime.`,
    };
    const human = capture();
    expect(renderFailure(error, false, human.output)).toBe(6);
    expect(human.stderr.join("")).toBe([
      `oompa: Sign in with \`oompa account login ${accountId}\` before using this account's Codex runtime.`,
      `Next: oompa account login ${accountId}`,
      "",
    ].join("\n"));
    expect(human.stderr.join("")).not.toContain("accountState");

    const json = capture();
    expect(renderFailure(error, true, json.output)).toBe(6);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      error: {
        code: error.code,
        details: error.details,
        message: error.message,
      },
      ok: false,
      version: 1,
    });

    const malformed = capture();
    renderFailure({
      ...error,
      details: { ...error.details, nextCommand: `oompa account login ${accountId} --unexpected` },
    }, false, malformed.output);
    expect(malformed.stderr.join("")).not.toContain("\nNext:");
    expect(malformed.stderr.join("")).toContain('"accountState": "signed_out"');

    const claude = capture();
    const claudeDetails = {
      accountSelector: accountId,
      accountState: "signed_out",
      nextCommand: `oompa account login ${accountId} --provider claude`,
      provider: "claude",
    } as const;
    renderFailure({ ...error, details: claudeDetails }, false, claude.output);
    expect(claude.stderr.join("")).toContain(
      `Next: oompa account login ${accountId} --provider claude`,
    );

    const widenedClaude = capture();
    renderFailure({
      ...error,
      details: { ...claudeDetails, unexpected: true },
    }, false, widenedClaude.output);
    expect(widenedClaude.stderr.join("")).not.toContain("\nNext:");
  });

  test("renders only the exact bounded project repair action while preserving JSON details", () => {
    const error = {
      code: "UNAVAILABLE",
      details: {
        nextCommand: "oompa doctor",
        repair: "repair_or_select_project",
      },
      message: "The selected project directory is unavailable.",
    };
    const human = capture();
    expect(renderFailure(error, false, human.output)).toBe(5);
    expect(human.stderr.join("")).toBe([
      "oompa: The selected project directory is unavailable.",
      "Next: oompa doctor",
      "",
    ].join("\n"));

    const json = capture();
    expect(renderFailure(error, true, json.output)).toBe(5);
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      error: { details: error.details },
    });

    const injected = capture();
    renderFailure({
      ...error,
      details: { ...error.details, extra: "provider-secret" },
    }, false, injected.output);
    expect(injected.stderr.join("")).not.toContain("\nNext:");
  });

  test("renders daemon stop outcomes and only exact recovery commands", () => {
    const stopped = capture();
    renderSuccess(
      { kind: "daemon.stop" },
      { released: true, running: false },
      false,
      stopped.output,
    );
    expect(stopped.stdout.join("")).toBe("Oompa daemon stopped.\n");

    const absent = capture();
    renderSuccess(
      { kind: "daemon.stop" },
      { released: false, running: false },
      false,
      absent.output,
    );
    expect(absent.stdout.join("")).toBe("Oompa daemon is already stopped.\n");

    for (const nextCommand of [
      "oompa daemon status --json",
      "oompa doctor --offline",
      "oompa init --yes",
    ] as const) {
      const recovery = capture();
      renderFailure({
        code: "RECOVERY_REQUIRED",
        details: { nextCommand },
        message: "The exact daemon shutdown result requires inspection.",
      }, false, recovery.output);
      expect(recovery.stderr.join("")).toBe([
        "oompa: The exact daemon shutdown result requires inspection.",
        `Next: ${nextCommand}`,
        "",
      ].join("\n"));
    }

    const injected = capture();
    renderFailure({
      code: "RECOVERY_REQUIRED",
      details: {
        nextCommand: "oompa daemon status --json; touch /tmp/unsafe",
      },
      message: "The exact daemon shutdown result requires inspection.",
    }, false, injected.output);
    expect(injected.stderr.join("")).not.toContain("\nNext:");
    expect(injected.stderr.join("")).not.toContain("touch /tmp/unsafe\nNext:");
  });

  test.each([
    ["preflight_receipt", "not_attempted"],
    ["preflight_inspection", "not_attempted"],
    ["stop_request", "attempted"],
    ["release_confirmation", "attempted"],
    ["release_confirmation", "acknowledged"],
  ] as const)("preserves closed daemon stop diagnostic guidance for %s / %s", (authorityPhase, stopRequestState) => {
    const error = {
      code: "RECOVERY_REQUIRED",
      details: { nextCommand: "oompa doctor --offline", authorityPhase, stopRequestState },
      message: "Daemon authority verification requires inspection.",
    };
    const human = capture();
    expect(renderFailure(error, false, human.output)).toBe(7);
    expect(human.stdout).toEqual([]);
    expect(human.stderr.join("")).toBe([
      "oompa: Daemon authority verification requires inspection.",
      "Next: oompa doctor --offline",
      "",
    ].join("\n"));

    const json = capture();
    expect(renderFailure(error, true, json.output)).toBe(7);
    expect(json.stderr).toEqual([]);
    expect(JSON.parse(json.stdout.join("")) as unknown).toEqual({ ok: false, version: 1, error });
  });

  test("refuses widened or invalid daemon stop diagnostic handoffs", () => {
    const valid = {
      nextCommand: "oompa doctor --offline",
      authorityPhase: "release_confirmation",
      stopRequestState: "acknowledged",
    };
    const inheritedPhase: unknown = Object.assign(Object.create({
      authorityPhase: "release_confirmation",
    }) as object, {
      nextCommand: "oompa doctor --offline",
      stopRequestState: "acknowledged",
      unexpected: true,
    });
    for (const details of [
      { ...valid, unexpected: true },
      { ...valid, authorityPhase: "unknown" },
      { ...valid, authorityPhase: null },
      { ...valid, stopRequestState: "released" },
      { ...valid, stopRequestState: true },
      { ...valid, authorityPhase: "preflight_receipt", stopRequestState: "attempted" },
      { ...valid, authorityPhase: "preflight_receipt", stopRequestState: "acknowledged" },
      { ...valid, authorityPhase: "preflight_inspection", stopRequestState: "attempted" },
      { ...valid, authorityPhase: "preflight_inspection", stopRequestState: "acknowledged" },
      { ...valid, authorityPhase: "stop_request", stopRequestState: "not_attempted" },
      { ...valid, authorityPhase: "stop_request", stopRequestState: "acknowledged" },
      { ...valid, authorityPhase: "release_confirmation", stopRequestState: "not_attempted" },
      { authorityPhase: valid.authorityPhase, stopRequestState: valid.stopRequestState },
      { nextCommand: valid.nextCommand, stopRequestState: valid.stopRequestState },
      { nextCommand: valid.nextCommand, authorityPhase: valid.authorityPhase },
      { ...valid, nextCommand: "oompa daemon status --json" },
      { ...valid, nextCommand: "oompa doctor --offline; touch /tmp/unsafe" },
      inheritedPhase,
    ]) {
      const human = capture();
      expect(renderFailure({
        code: "RECOVERY_REQUIRED",
        details,
        message: "Daemon authority verification requires inspection.",
      }, false, human.output)).toBe(7);
      expect(human.stdout).toEqual([]);
      expect(human.stderr.join("")).not.toContain("\nNext:");
    }
  });

  test("renders only the closed key-loss precondition handoffs", () => {
    for (const [code, nextCommand] of [
      ["INTERACTION_REQUIRED", "oompa auth login --input-stdin"],
      ["INTERACTION_REQUIRED", "oompa device pair"],
      ["RECOVERY_REQUIRED", "oompa auth status"],
    ] as const) {
      const target = capture();
      renderFailure({
        code,
        details: { nextCommand },
        message: "Account-key loss acknowledgement requires another local step.",
      }, false, target.output);
      expect(target.stderr.join("")).toBe([
        "oompa: Account-key loss acknowledgement requires another local step.",
        `Next: ${nextCommand}`,
        "",
      ].join("\n"));
    }

    const injected = capture();
    renderFailure({
      code: "RECOVERY_REQUIRED",
      details: { nextCommand: "oompa auth status; touch /tmp/unsafe" },
      message: "Account-key loss acknowledgement requires another local step.",
    }, false, injected.output);
    expect(injected.stderr.join("")).not.toContain("\nNext:");
  });

  test("renders pending-login cancellation as a fresh-start handoff", () => {
    const canceled = capture();
    renderSuccess({ kind: "account.login-cancel", account: "personal" }, {
      status: "canceled",
      providerStatus: "not_found",
    }, false, canceled.output);
    expect(canceled.stdout.join("")).toBe("Canceled the pending login (not_found). You can start a fresh login now.\n");
    const settled = capture();
    renderSuccess({ kind: "account.login-cancel", account: "personal" }, {
      status: "already_settled",
    }, false, settled.output);
    expect(settled.stdout.join("")).toBe("No login is pending for this account.\n");
  });

  test("generic account-login rendering strips provider handoff secrets in every mode", () => {
    const command = {
      account: "personal",
      deviceCode: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000101",
      kind: "account.login" as const,
    };
    const secret = "RENDER-LOGIN-SECRET";
    const attacked = {
      account: {
        id: `acct_${"1".repeat(32)}`,
        label: "Personal",
        processGeneration: 1,
        state: "login_pending",
        updatedAt: 1,
      },
      idempotencyKey: command.idempotencyKey,
      login: {
        loginId: secret,
        next: secret,
        status: "pending",
        userCode: secret,
        verificationUrl: `https://example.test/?secret=${secret}`,
        unexpected: secret,
      },
      unexpected: secret,
    };
    for (const json of [false, true]) {
      const target = capture();
      renderSuccess(command, attacked, json, target.output);
      const rendered = `${target.stdout.join("")}${target.stderr.join("")}`;
      expect(rendered).not.toContain(secret);
      if (json) {
        expect(JSON.parse(rendered)).toMatchObject({
          data: { login: { status: "pending" } },
        });
      }
    }
  });

  test("renders a same-key signed-out login settlement as terminal", () => {
    const target = capture();
    renderSuccess({
      account: `acct_${"1".repeat(32)}`,
      deviceCode: true,
      idempotencyKey: "00000000-0000-4000-8000-000000000101",
      kind: "account.login",
    }, {
      account: {
        id: `acct_${"1".repeat(32)}`,
        label: "Personal",
        processGeneration: 1,
        state: "signed_out",
        updatedAt: 2,
      },
      idempotencyKey: "00000000-0000-4000-8000-000000000101",
      login: { status: "settled" },
    }, false, target.output);
    expect(target.stdout.join("")).toContain("settled");
    expect(target.stdout.join("")).toContain("signed out");
  });

  test("renders session show as an ergonomic transcript and bounded turn summaries", () => {
    const target = capture();
    renderSuccess(command, data, false, target.output);
    expect(target.stdout.join("")).toBe([
      "Fix bounded history",
      "State: idle",
      "Project: /workspace/project",
      "",
      "Runtime",
      "  account: acct_00000000000000000000000000000000 generation 3",
      "  preset: high",
      "  model: gpt-6-astra",
      "  reasoning effort: max",
      "  service tier: default",
      "  Fast: disabled",
      "  review: auto_review",
      "  permission profile: :workspace",
      "  computer use: enabled",
      "  plugin capability: enabled",
      "  enabled apps: Files (Files plugin)",
      "  observed at: 2000",
      "History: showing 1 recent turns; older turns omitted",
      "History: 2 messages omitted",
      "",
      "Messages",
      `You  ${primaryTurnId}`,
      "  please fix it",
      "",
      `Codex  ${primaryTurnId}`,
      "  fixed",
      "  verified",
      "  … [4 UTF-8 bytes omitted]",
      "",
      "Turns",
      `${primaryTurnId}  completed  1.2s`,
      "  files: src/index.ts",
      "  actions: git status, bun test",
      "",
    ].join("\n"));
    expect(target.stderr).toEqual([]);
    expect(target.stdout.join("")).not.toContain("providerThreadId");
  });

  test("keeps JSON output versioned and structurally exact", () => {
    const target = capture();
    renderSuccess(command, data, true, target.output);
    expect(JSON.parse(target.stdout.join(""))).toEqual({
      ok: true,
      version: 1,
      command: "session.show",
      data: {
        effectiveRuntimeProfile: data.effectiveRuntimeProfile,
        projection: {
          messages: data.projection.messages,
          omission: data.projection.omission,
          projectRoot: data.projection.projectRoot,
          status: data.projection.status,
          title: data.projection.title,
          turnSummaries: data.projection.turnSummaries,
        },
        session: {
          createdAt: 1_000,
          fastEnabled: false,
          id: primarySessionId,
          preset: "high",
          profileId: primaryProfileId,
          projectId: primaryProjectId,
          provider: "codex",
          revision: 2,
          state: "idle",
          title: "Local title",
          updatedAt: 2_000,
        },
      },
    });
    expect(target.stderr).toEqual([]);
  });

  test("strips private session and provider identifiers from show, start, and send", () => {
    const privateSentinel = "PRIVATE-SESSION-PROVENANCE-SENTINEL";
    const sessionId = `sess_${"7".repeat(32)}`;
    const publicTurnId = publicProviderId("already-public-turn");
    const session = {
      activeTurnId: privateSentinel,
      archivedAt: 900,
      createdAt: 100,
      fastEnabled: false,
      id: sessionId,
      note: privateSentinel,
      preset: "high",
      profileId: `acct_${"8".repeat(32)}`,
      provider: "codex",
      providerThreadId: privateSentinel,
      providerUpdatedAt: 800,
      revision: 3,
      state: "idle",
      title: "Public session",
      updatedAt: 200,
    } as const;
    const idempotencyKey = "00000000-0000-4000-8000-000000000731";
    const cases = [
      {
        command: { detail: false, kind: "session.show", session: sessionId } as const,
        response: {
          effectiveRuntimeProfile: null,
          privateBinding: privateSentinel,
          projection: {
            activeTurnId: privateSentinel,
            messages: [
              { clientId: privateSentinel, role: "user", text: "hello", turnId: privateSentinel },
              { role: "assistant", text: "hi", turnId: publicTurnId },
            ],
            omission: {
              hasMoreOlderTurns: false,
              incompleteTurnIds: [privateSentinel, publicTurnId],
              omittedMessages: 0,
              returnedTurns: 2,
              truncatedMessages: 0,
              turnLimit: 24,
              unreadItemTurnIds: [privateSentinel, publicTurnId],
            },
            providerThreadId: privateSentinel,
            providerUpdatedAt: 800,
            status: "idle",
            title: "Public session",
            turnSummaries: [{
              actions: [],
              files: [],
              id: privateSentinel,
              itemId: privateSentinel,
              omittedActions: 0,
              omittedFiles: 0,
              status: "completed",
            }],
            turns: [{ itemId: privateSentinel, turnId: privateSentinel }],
          },
          session,
        },
      },
      {
        command: {
          account: session.profileId,
          fast: false,
          idempotencyKey,
          kind: "session.start",
          preset: "high",
          provider: "codex",
        } as const,
        response: {
          effectiveRuntimeProfile: null,
          idempotencyKey,
          privateBinding: privateSentinel,
          session,
        },
      },
      {
        command: {
          idempotencyKey,
          kind: "session.send",
          message: "hello",
          session: sessionId,
        } as const,
        response: {
          effectiveRuntimeProfile: null,
          idempotencyKey,
          privateBinding: privateSentinel,
          session,
          turnId: privateSentinel,
        },
      },
    ];

    for (const testCase of cases) {
      for (const json of [false, true]) {
        const target = capture();
        renderSuccess(testCase.command, testCase.response, json, target.output);
        const rendered = target.stdout.join("");
        expect(rendered).not.toContain(privateSentinel);
        if (testCase.command.kind === "session.show") expect(rendered).toContain(publicTurnId);
      }
    }
  });

  test("gives native and adopted show, start, and send results identical public key sets", () => {
    const sessionId = `sess_${"9".repeat(32)}`;
    const profileId = `acct_${"a".repeat(32)}`;
    const idempotencyKey = "00000000-0000-4000-8000-000000000732";
    const publicTurnId = publicProviderId("shared-public-turn");
    const session = {
      createdAt: 100,
      fastEnabled: false,
      id: sessionId,
      preset: "high",
      profileId,
      provider: "codex",
      revision: 3,
      state: "idle",
      title: "Same public session",
      updatedAt: 200,
    } as const;
    const commands = [
      { detail: false, kind: "session.show", session: sessionId } as const,
      {
        account: profileId,
        fast: false,
        idempotencyKey,
        kind: "session.start",
        preset: "high",
        provider: "codex",
      } as const,
      { idempotencyKey, kind: "session.send", message: "hello", session: sessionId } as const,
    ];
    const publicData = (
      command: (typeof commands)[number],
      origin: "native" | "adopted",
    ): Record<string, unknown> => {
      const rawProviderId = `${origin}-private-provider-thread`;
      const rawSession = {
        ...session,
        activeTurnId: `${origin}-private-active-turn`,
        note: `${origin}-private-note`,
        providerThreadId: rawProviderId,
        providerUpdatedAt: 300,
      };
      const response = command.kind === "session.show"
        ? {
            effectiveRuntimeProfile: null,
            origin,
            projection: {
              activeTurnId: `${origin}-private-active-turn`,
              messages: [{ role: "assistant", text: "same", turnId: publicTurnId }],
              providerThreadId: rawProviderId,
              status: "idle",
              title: "Same public session",
              turns: [{ itemId: `${origin}-private-item`, turnId: `${origin}-private-turn` }],
            },
            session: rawSession,
          }
        : command.kind === "session.start"
          ? {
              effectiveRuntimeProfile: null,
              idempotencyKey,
              origin,
              session: rawSession,
            }
          : {
              effectiveRuntimeProfile: null,
              idempotencyKey,
              origin,
              session: rawSession,
              turnId: `${origin}-private-turn`,
            };
      const target = capture();
      renderSuccess(command, response, true, target.output);
      return (JSON.parse(target.stdout.join("")) as { data: Record<string, unknown> }).data;
    };

    for (const sessionCommand of commands) {
      const native = publicData(sessionCommand, "native");
      const adopted = publicData(sessionCommand, "adopted");
      expect(adopted).toEqual(native);
      expect(Object.keys(adopted.session as Record<string, unknown>).sort()).toEqual([
        "createdAt",
        "fastEnabled",
        "id",
        "preset",
        "profileId",
        "provider",
        "revision",
        "state",
        "title",
        "updatedAt",
      ]);
    }
  });

  test("renders bounded peer policy reports and binds CAS results to the command", () => {
    const sessionId = `sess_${"7".repeat(32)}`;
    const current = {
      version: 1 as const,
      sessionId,
      mode: "coordinate" as const,
      revision: 1,
      updatedAt: 1_000,
    };
    const human = capture();
    renderSuccess(
      { kind: "session.peer-policy.get", session: sessionId },
      current,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toBe([
      "Peer policy: coordinate",
      `Session: ${sessionId}`,
      "Revision: 1",
      "Updated: 1970-01-01T00:00:01.000Z",
      "",
    ].join("\n"));

    const command = {
      expectedRevision: 1,
      kind: "session.peer-policy.set",
      mode: "inspect",
      session: sessionId,
    } as const;
    const changed = { ...current, mode: "inspect" as const, revision: 2, updatedAt: 2_000 };
    const json = capture();
    renderSuccess(command, changed, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "session.peer-policy.set",
      data: changed,
      ok: true,
      version: 1,
    });

    for (const attacked of [
      { ...changed, sessionId: `sess_${"8".repeat(32)}` },
      { ...changed, mode: "off" },
      { ...changed, revision: 3 },
      { ...changed, providerThreadId: "private-thread" },
    ]) {
      const target = capture();
      expect(() => renderSuccess(command, attacked, true, target.output))
        .toThrow(InvalidCommandResponseError);
      expect(target.stdout).toEqual([]);
    }
  });

  test("renders strict conversation-bound session task records without list prompt leakage", () => {
    const sessionId = `sess_${"1".repeat(32)}`;
    const taskId = `stask_${"2".repeat(32)}`;
    const summary = {
      scope: "conversation" as const,
      id: taskId,
      sessionId,
      name: "Release review",
      status: "active" as const,
      schedule: { kind: "interval_minutes" as const, minutes: 60 },
      revision: 3,
      nextDueAt: 3_600_000,
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const listing = capture();
    renderSuccess(
      { kind: "session.task.list", session: sessionId },
      { scope: "conversation", sessionId, tasks: [summary] },
      false,
      listing.output,
    );
    const listOutput = listing.stdout.join("");
    expect(listOutput).toContain(`Conversation tasks for ${sessionId}`);
    expect(listOutput).toContain("Release review");
    expect(listOutput).toContain("60m");
    expect(listOutput).toContain(taskId);
    expect(listOutput).not.toContain("inspect the private release queue");

    const record = { ...summary, prompt: "inspect the private release queue" };
    const shown = capture();
    renderSuccess(
      { kind: "session.task.show", session: sessionId, task: taskId },
      record,
      false,
      shown.output,
    );
    expect(shown.stdout.join("")).toBe([
      "Release review",
      "Scope: conversation",
      `Session: ${sessionId}`,
      `ID: ${taskId}`,
      "Status: active",
      "Every: 60 minutes",
      "Revision: 3",
      "Next due: 1970-01-01T01:00:00.000Z",
      "Created: 1970-01-01T00:00:01.000Z",
      "Updated: 1970-01-01T00:00:02.000Z",
      "",
      "Prompt",
      "  inspect the private release queue",
      "",
    ].join("\n"));

    const json = capture();
    renderSuccess(
      { kind: "session.task.show", session: sessionId, task: taskId },
      record,
      true,
      json.output,
    );
    expect(JSON.parse(json.stdout.join(""))).toEqual({
      command: "session.task.show",
      data: record,
      ok: true,
      version: 1,
    });
  });

  test("binds session task mutation responses to their exact command authority", () => {
    const sessionId = `sess_${"3".repeat(32)}`;
    const taskId = `stask_${"4".repeat(32)}`;
    const key = "00000000-0000-4000-8000-000000000203";
    const record = {
      scope: "conversation" as const,
      id: taskId,
      sessionId,
      name: "Queue review",
      status: "paused" as const,
      schedule: { kind: "interval_minutes" as const, minutes: 30 },
      revision: 1,
      nextDueAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
      prompt: "review the queue",
    };
    const created = capture();
    renderSuccess({
      everyMinutes: 30,
      idempotencyKey: key,
      kind: "session.task.create",
      name: "Queue review",
      paused: true,
      prompt: "review the queue",
      session: sessionId,
    }, record, false, created.output);
    expect(created.stdout.join("")).toContain("Scope: conversation");
    expect(created.stdout.join("")).toContain("Next due: paused");

    const deleted = capture();
    renderSuccess({
      expectedRevision: 1,
      idempotencyKey: key,
      kind: "session.task.delete",
      session: sessionId,
      task: taskId,
    }, {
      scope: "conversation",
      sessionId,
      taskId,
      deleted: true,
      revision: 2,
      deletedAt: 2_000,
    }, false, deleted.output);
    expect(deleted.stdout.join("")).toBe(
      `Deleted conversation task ${taskId} from ${sessionId} at 1970-01-01T00:00:02.000Z (revision 2).\n`,
    );

    expect(() => renderSuccess({
      everyMinutes: 30,
      idempotencyKey: key,
      kind: "session.task.create",
      name: "Queue review",
      paused: true,
      prompt: "review the queue",
      session: sessionId,
    }, { ...record, revision: 2 }, true, capture().output))
      .toThrow(InvalidCommandResponseError);
    expect(() => renderSuccess({
      expectedRevision: 1,
      idempotencyKey: key,
      kind: "session.task.delete",
      session: sessionId,
      task: taskId,
    }, {
      scope: "conversation",
      sessionId,
      taskId,
      deleted: true,
      revision: 1,
      deletedAt: 2_000,
    }, true, capture().output)).toThrow(InvalidCommandResponseError);

    for (const attacked of [
      { ...record, sessionId: `sess_${"5".repeat(32)}` },
      { ...record, id: `stask_${"6".repeat(32)}` },
      { ...record, providerThreadId: "private-thread" },
    ]) {
      const target = capture();
      expect(() => renderSuccess(
        { kind: "session.task.show", session: sessionId, task: taskId },
        attacked,
        true,
        target.output,
      )).toThrow(InvalidCommandResponseError);
      expect(target.stdout).toEqual([]);
    }
  });

  test("escapes OSC, BEL, and bidi controls in both human and JSON output", () => {
    const attack = "\u001b]0;owned\u0007\u202etxt";
    const attacked = {
      ...data,
      projection: {
        ...data.projection,
        title: attack,
        messages: [{ role: "assistant", text: `${attack}\nvisible`, turnId: attack }],
        turnSummaries: [{ id: attack, status: "completed", runtimeMs: 1, files: [attack], actions: ["git status"], omittedFiles: 0, omittedActions: 0 }],
      },
    };
    const human = capture();
    renderSuccess(command, attacked, false, human.output);
    const humanText = human.stdout.join("");
    expect(humanText).not.toContain("\u001b");
    expect(humanText).not.toContain("\u0007");
    expect(humanText).not.toContain("\u202e");
    expect(humanText).toContain("\\u{001b}");
    expect(humanText).toContain("\\u{0007}");
    expect(humanText).toContain("\\u{202e}");

    const json = capture();
    renderSuccess(command, attacked, true, json.output);
    const jsonText = json.stdout.join("");
    expect(jsonText).not.toContain("\u001b");
    expect(jsonText).not.toContain("\u0007");
    expect(jsonText).not.toContain("\u202e");
    expect(jsonText).toContain("\\u202e");
    expect(JSON.parse(jsonText)).toMatchObject({
      command: command.kind,
      data: {
        projection: {
          messages: [{ role: "assistant", text: `${attack}\nvisible` }],
          title: attack,
          turnSummaries: [{ files: [attack], status: "completed" }],
        },
        session: { id: primarySessionId },
      },
      ok: true,
      version: 1,
    });
  });

  test("renders plugin discovery as read-only and withholds path-bearing load diagnostics", () => {
    const sentinel = "/workspace/private/marketplace.json";
    const list = capture();
    renderSuccess(
      { account: "work", kind: "plugin.list", refresh: false },
      {
        catalog: {
          featuredPluginIds: ["files@official"],
          lifecycle: {
            discovery: "available",
            enablement: "no_separate_pinned_method",
            install: "blocked_compound_upstream_effect",
            oauth: "separate_foreground_only",
          },
          marketplaceLoadErrorCount: 2,
          marketplaceLoadErrors: [{ message: `failed at ${sentinel}` }],
          marketplaces: [{
            displayName: "Official",
            name: "official",
            path: sentinel,
            plugins: [{
              authPolicy: "ON_USE",
              displayName: "Files",
              enabled: false,
              id: "files@official",
              installed: false,
              name: "files",
            }],
          }],
        },
      },
      false,
      list.output,
    );
    const listText = list.stdout.join("");
    expect(listText).toContain("Files");
    expect(listText).toContain("Marketplace load errors: 2");
    expect(listText).toContain("details withheld");
    expect(listText).toContain("Lifecycle: discovery only.");
    expect(listText).toContain("Oompa blocks that compound effect.");
    expect(listText).not.toContain(sentinel);
    expect(listText).not.toContain("failed at");
    expect(listText).not.toContain("oompa plugin install");

    const attack = "\u001b]0;owned\u0007\u202etxt";
    const show = capture();
    renderSuccess(
      { account: "work", kind: "plugin.show", plugin: "files@official", refresh: false },
      {
        lifecycle: {
          discovery: "available",
          enablement: "no_separate_pinned_method",
          install: "blocked_compound_upstream_effect",
          oauth: "separate_foreground_only",
        },
        marketplace: { displayName: "Official", name: "official", path: sentinel },
        plugin: {
          authPolicy: "ON_USE",
          availability: "AVAILABLE",
          capabilities: ["search"],
          disabledReason: null,
          displayName: `Files${attack}`,
          enabled: false,
          id: "files@official",
          installPolicy: "AVAILABLE",
          installed: false,
          localPath: sentinel,
          name: "files",
          shortDescription: `Search connected files${attack}`,
        },
      },
      false,
      show.output,
    );
    const showText = show.stdout.join("");
    expect(showText).toContain("Files\\u{001b}]0;owned\\u{0007}\\u{202e}txt");
    expect(showText).toContain("Lifecycle: discovery only.");
    expect(showText).not.toContain("\u001b");
    expect(showText).not.toContain("\u0007");
    expect(showText).not.toContain("\u202e");
    expect(showText).not.toContain(sentinel);
  });

  test("renders session status and coalesced safe event progress", () => {
    const status = capture();
    renderSuccess(
      { kind: "session.status", session: "release" },
      {
        version: 2,
        session: {
          id: "sess_00000000000000000000000000000000",
          accountId: "acct_00000000000000000000000000000000",
          projectId: null,
          title: "Release",
          execution: "active",
          activeTurnId: publicProviderId("turn-1"),
          revision: 4,
          createdAt: 500,
          updatedAt: 1_000,
        },
        advisory: {
          execution: "active",
          attention: "human_action_required",
          queueDepth: 1,
        },
        localObservation: {
          source: "sqlite",
          coverage: "complete",
          freshness: "fresh",
          observedAt: 1_000,
        },
        providerObservation: {
          source: "codex_app_server",
          basis: "provider_read",
          coverage: "complete",
          freshness: "fresh",
          observedAt: 1_000,
          connectionId: "90000000-0000-4000-8000-000000000099",
          mode: "resubscribed",
          profileGeneration: 2,
          state: "live",
        },
        eventStream: {
          cursor: cursorWire("head"),
          floorSequence: 2,
          observedThroughSequence: 9,
          retentionFloorCursor: cursorWire("floor"),
          streamEpoch: "90000000-0000-4000-8000-000000000001",
        },
        interactions: {
          pendingCount: 1,
          responseInFlightCount: 0,
          pending: [{
          id: "a0000000-0000-4000-8000-000000000009",
          kind: "command_approval",
          revision: 2,
          blocking: true,
          summary: "Run release verification",
          requestedAt: 1_000,
          deadlineAt: 61_000,
          }],
          truncated: false,
        },
        queue: { depth: 1, dispatchingCount: 0, ambiguousCount: 0, failedCount: 0 },
      },
      false,
      status.output,
    );
    const statusText = status.stdout.join("");
    expect(statusText).toContain("Execution: active");
    expect(statusText).toContain("Attention: human_action_required");
    expect(statusText).toContain("Provider: live (resubscribed, connection 90000000-0000-4000-8000-000000000099, basis provider_read, coverage complete, freshness fresh, generation 2");
    expect(statusText).toContain("Queue: 1 pending, 0 dispatching, 0 ambiguous, 0 failed");
    expect(statusText).toContain("Run release verification");

    const sessionId = "sess_00000000000000000000000000000000" as const;
    const accountId = "acct_00000000000000000000000000000000" as const;
    const streamEpoch = "90000000-0000-4000-8000-000000000001";
    const base = {
      version: 1 as const,
      sessionId,
      streamEpoch,
      recordedAt: 1_000,
      accountId,
      providerGeneration: 1,
      providerConnectionId: null,
    };
    const page: SessionEventPage = {
      version: 1,
      sessionId,
      requestedCursor: cursorWire("old"),
      retentionFloorCursor: cursorWire("floor"),
      observedThroughCursor: cursorWire("next"),
      nextCursor: cursorWire("next"),
      gap: { reason: "retention_count", requestedSequence: 1, retainedFromSequence: 2 },
      events: [
        { ...base, sequence: 2, body: { type: "assistant_delta", turnId: publicProviderId("turn-1"), itemId: publicProviderId("item-1"), text: "done " } },
        { ...base, sequence: 3, body: { type: "assistant_delta", turnId: publicProviderId("turn-1"), itemId: publicProviderId("item-1"), text: "and verified" } },
        { ...base, sequence: 4, body: { type: "item_started", turnId: publicProviderId("turn-1"), itemId: publicProviderId("mcp-1"), itemKind: "mcpToolCall", server: "github", tool: "create_issue" } },
        { ...base, sequence: 5, body: { type: "item_completed", turnId: publicProviderId("turn-1"), itemId: publicProviderId("mcp-1"), itemKind: "mcpToolCall", server: "github", tool: "create_issue", status: "completed" } },
        { ...base, sequence: 6, body: { type: "tool_progress", turnId: publicProviderId("turn-1"), itemId: publicProviderId("tool-1"), toolKind: "command", status: "started", outputBytesObserved: 0 } },
        { ...base, sequence: 7, body: { type: "tool_progress", turnId: publicProviderId("turn-1"), itemId: publicProviderId("tool-1"), toolKind: "command", status: "completed", outputBytesObserved: 120 } },
        { ...base, sequence: 8, body: { type: "token_usage", turnId: publicProviderId("turn-1"), inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningOutputTokens: null, totalTokens: 53_000, modelContextWindow: 200_000, providerCost: { amount: 0.01, currency: "USD" } } },
      ],
    };
    const events = capture();
    renderSuccess(
      { kind: "session.events", session: "release", cursor: cursorWire("old"), limit: 200, waitMs: 0 },
      page,
      false,
      events.output,
    );
    expect(events.stdout.join("")).toContain("Event gap: retention_count");
    expect(events.stdout.join("")).toContain("Codex\n  done and verified");
    expect(events.stdout.join("").match(/Codex/gu)).toHaveLength(1);
    expect(events.stdout.join("")).toContain(`Item started: mcpToolCall github/create_issue ${publicProviderId("mcp-1")}`);
    expect(events.stdout.join("")).toContain(`Item completed: mcpToolCall github/create_issue ${publicProviderId("mcp-1")} (completed)`);
    expect(events.stdout.join("")).toContain("Tool: command, completed, 120 bytes observed");
    expect(events.stdout.join("")).not.toContain("Tool: command, started");
    expect(events.stdout.join("")).toContain("Tokens: 53000 total of 200000; provider cost 0.01 USD");
  });

  test("renders public interaction lists and details without private callback authority", () => {
    const record: PublicInteraction = {
      version: 1,
      id: "a0000000-0000-4000-8000-000000000001",
      sessionId: "sess_00000000000000000000000000000000",
      kind: "user_input",
      state: "pending",
      revision: 2,
      blocking: true,
      display: {
        kind: "user_input",
        summary: "Choose a release channel",
        blocking: true,
        questions: [{
          id: "release-channel",
          header: "Channel",
          question: "Where should this go?",
          options: [{ label: "Beta", description: "Share with beta testers." }],
          allowsOther: true,
          secret: true,
        }],
      },
      responseRecorded: false,
      context: {
        turnId: publicProviderId("turn-visible"),
        itemId: publicProviderId("item-visible"),
      },
      requestedAt: 1_000,
      deadlineAt: Date.now() + 60_000,
      updatedAt: 1_001,
      terminalAt: null,
    };
    const list = capture();
    renderSuccess(
      { kind: "interaction.list", pending: true, limit: 100 },
      { sessionId: null, interactions: [record], nextCursor: null },
      false,
      list.output,
    );
    const listText = list.stdout.join("");
    expect(listText).toContain("Choose a release channel");
    expect(listText).toContain(record.id);
    expect(listText).not.toContain("private-request");
    expect(listText).not.toContain("requestDigest");

    const show = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      { interaction: record },
      false,
      show.output,
    );
    const showText = show.stdout.join("");
    expect(showText).toContain("Channel (protected input)");
    expect(showText).toContain("ID: release-channel");
    expect(showText).toContain("Where should this go?");
    expect(showText).toContain("Deadline:");
    expect(showText).toContain("Remaining:");
    expect(showText).toContain(
      'Protected answer document: {"answers":{"release-channel":{"answers":["<answer>"]}}}',
    );
    expect(showText).not.toContain("thread-private");

    const json = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      { interaction: record },
      true,
      json.output,
    );
    const payload = JSON.parse(json.stdout.join("")) as { data: { interaction: Record<string, unknown> } };
    expect(payload.data.interaction).not.toHaveProperty("authority");
    expect(payload.data.interaction).not.toHaveProperty("responseDigest");
    expect(payload.data.interaction).toMatchObject({
      id: record.id,
      revision: 2,
      state: "pending",
    });

    const permission: PublicInteraction = {
      ...record,
      id: "a0000000-0000-4000-8000-000000000002",
      kind: "permission_approval",
      display: {
        allowsSessionScope: true,
        kind: "permission_approval",
        reason: "Needed for the requested task",
        requested: [{ name: "network" }, { name: "fileSystem" }],
        summary: "Allow requested permissions",
      },
    };
    const permissionShow = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: permission.id },
      { interaction: permission },
      false,
      permissionShow.output,
    );
    expect(permissionShow.stdout.join("")).toContain(
      'Protected grant document: {"permissions":["network","fileSystem"]}',
    );
  });

  test("renders non-pending interactions without stale mutation guidance", () => {
    const base = {
      version: 1 as const,
      sessionId: "sess_00000000000000000000000000000000" as const,
      state: "response_prepared" as const,
      revision: 2,
      blocking: true,
      responseRecorded: true,
      context: { turnId: null, itemId: null },
      requestedAt: 1_000,
      deadlineAt: 2_000,
      updatedAt: 1_100,
      terminalAt: null,
    };
    const records: PublicInteraction[] = [
      {
        ...base,
        id: "a0000000-0000-4000-8000-000000000011",
        kind: "command_approval",
        state: "response_written",
        display: {
          kind: "command_approval",
          summary: "Run a command",
          reason: null,
          commandClass: "test",
          workingDirectory: null,
          availableDecisions: ["once", "decline", "cancel"],
        },
      },
      {
        ...base,
        id: "a0000000-0000-4000-8000-000000000012",
        kind: "file_change_approval",
        display: {
          kind: "file_change_approval",
          summary: "Apply files",
          reason: null,
          grantRoot: null,
          availableDecisions: ["decline", "cancel"],
        },
      },
      {
        ...base,
        id: "a0000000-0000-4000-8000-000000000013",
        kind: "permission_approval",
        display: {
          kind: "permission_approval",
          summary: "Grant access",
          reason: null,
          requested: [{ name: "network" }],
          allowsSessionScope: true,
        },
      },
      {
        ...base,
        id: "a0000000-0000-4000-8000-000000000014",
        kind: "user_input",
        display: {
          kind: "user_input",
          summary: "Answer a question",
          blocking: true,
          questions: [{
            id: "answer",
            header: "Answer",
            question: "What is the answer?",
            options: null,
            allowsOther: true,
            secret: true,
          }],
        },
      },
      {
        ...base,
        id: "a0000000-0000-4000-8000-000000000015",
        kind: "mcp_elicitation",
        display: {
          kind: "mcp_elicitation",
          summary: "Complete a form",
          serverName: "example",
          mode: "form",
          url: null,
          mayContainSecrets: true,
          fields: [{
            name: "value",
            type: "string",
            required: true,
            minLength: 1,
            maxLength: 10,
            format: null,
          }],
        },
      },
    ];
    const actionGuidance = [
      "Available decisions:",
      "Safe decisions:",
      "Protected authority:",
      "Protected grant document:",
      "Protected answer document:",
      "Submit one protected JSON document",
      "Decline this interaction",
    ];
    for (const record of records) {
      const rendered = capture();
      renderSuccess(
        { kind: "interaction.show", interaction: record.id },
        { interaction: record },
        false,
        rendered.output,
      );
      const text = rendered.stdout.join("");
      expect(text).toContain("Do not resubmit it.");
      for (const guidance of actionGuidance) expect(text).not.toContain(guidance);
    }
  });

  test("renders private approval authority only through the explicit protected renderer", () => {
    const privateCommand = "git reset --hard RENDER-PRIVATE-AUTHORITY";
    const document: ProtectedInteractionDetailDocument = {
      type: "hra_protected_interaction_detail",
      version: 1,
      binding: {
        interactionId: "40000000-0000-4000-8000-000000000001",
        revision: 2,
        kind: "command_approval",
        sessionId: null,
        profileId: `acct_${"1".repeat(32)}`,
        processGeneration: 7,
        connectionId: "40000000-0000-4000-8000-000000000002",
      },
      authority: {
        kind: "command_approval",
        command: privateCommand,
        reason: "Apply the exact command",
        availableDecisions: ["accept", "decline", "cancel"],
        workingDirectory: "/private/workspace",
        environmentId: null,
        commandActions: [{ type: "unknown", command: privateCommand }],
        networkApprovalContext: null,
        additionalPermissions: null,
        proposedExecpolicyAmendment: null,
        proposedNetworkPolicyAmendments: null,
      },
    };
    const protectedRendered = renderProtectedInteractionDetail(document);
    expect(protectedRendered).toContain(privateCommand);
    expect(protectedRendered).toContain("/private/workspace");

    for (const json of [false, true]) {
      const rendered = capture();
      renderSuccess({
        kind: "interaction.inspect",
        interaction: document.binding.interactionId,
        expectedRevision: document.binding.revision,
      }, document, json, rendered.output);
      const generic = `${rendered.stdout.join("")}${rendered.stderr.join("")}`;
      expect(generic).not.toContain(privateCommand);
      expect(generic).not.toContain("/private/workspace");
    }
  });

  test("renders interaction continuations with the resolved immutable session ID and preserves cursors in JSON", () => {
    const sessionId = "sess_00000000000000000000000000000000";
    const cursor = cursorWire("interaction-list");
    const data = { sessionId, interactions: [], nextCursor: cursor };
    const human = capture();
    renderSuccess(
      { kind: "session.interactions", session: "mutable-label", pending: true, limit: 37 },
      data,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toContain(
      `Continue: oompa session interactions ${sessionId} --pending --limit 37 --cursor ${cursor}\n`,
    );
    expect(human.stdout.join("")).not.toContain("mutable-label");

    const foreignInteraction: PublicInteraction = {
      version: 1,
      id: "a0000000-0000-4000-8000-000000000099",
      sessionId: "sess_11111111111111111111111111111111",
      kind: "command_approval",
      state: "pending",
      revision: 1,
      blocking: true,
      display: {
        kind: "command_approval",
        summary: "Foreign interaction",
        reason: null,
        commandClass: "test",
        workingDirectory: null,
        availableDecisions: ["once", "decline", "cancel"],
      },
      responseRecorded: false,
      context: { turnId: null, itemId: null },
      requestedAt: 1,
      deadlineAt: 2,
      updatedAt: 1,
      terminalAt: null,
    };
    const foreign = capture();
    expect(() => renderSuccess(
      { kind: "session.interactions", session: "mutable-label", pending: true, limit: 37 },
      { sessionId, interactions: [foreignInteraction], nextCursor: null },
      false,
      foreign.output,
    )).toThrow(InvalidCommandResponseError);
    expect(foreign.stdout.join("")).toBe("");

    const status = capture();
    const statusData = {
      version: 2,
      session: {
        id: sessionId,
        accountId: "acct_00000000000000000000000000000000",
        projectId: null,
        title: "Release",
        execution: "idle",
        activeTurnId: null,
        revision: 4,
        createdAt: 1,
        updatedAt: 2,
      },
      advisory: { execution: "idle", attention: "human_action_required", queueDepth: 0 },
      localObservation: {
        source: "sqlite",
        coverage: "complete",
        freshness: "fresh",
        observedAt: 2,
      },
      providerObservation: {
        source: "codex_app_server",
        basis: "local_state",
        state: "not_applicable",
        coverage: "not_attempted",
        freshness: "unknown",
        observedAt: 2,
        profileGeneration: 1,
        reason: "unbound",
      },
      eventStream: {
        cursor: cursorWire("head"),
        floorSequence: 1,
        observedThroughSequence: 1,
        retentionFloorCursor: cursorWire("floor"),
        streamEpoch: "90000000-0000-4000-8000-000000000001",
      },
      interactions: {
        pendingCount: 1,
        responseInFlightCount: 0,
        pending: [],
        truncated: true,
      },
      queue: { depth: 0, dispatchingCount: 0, ambiguousCount: 0, failedCount: 0 },
    };
    renderSuccess(
      { kind: "session.status", session: "mutable-label" },
      statusData,
      false,
      status.output,
    );
    expect(status.stdout.join("")).toContain(
      `More pending interactions: oompa session interactions ${sessionId} --pending --limit 100\n`,
    );
    expect(status.stdout.join("")).toContain(
      "Provider: not_applicable (unbound, basis local_state, coverage not_attempted, freshness unknown",
    );
    expect(status.stdout.join("")).not.toContain("mutable-label");
    const statusJson = capture();
    renderSuccess(
      { kind: "session.status", session: "mutable-label" },
      statusData,
      true,
      statusJson.output,
    );
    expect(JSON.parse(statusJson.stdout.join(""))).toMatchObject({
      data: { interactions: { pendingCount: 1, truncated: true } },
    });
    for (const json of [false, true]) {
      const impossibleCut = capture();
      expect(() => renderSuccess(
        { kind: "session.status", session: "mutable-label" },
        {
          ...statusData,
          eventStream: {
            ...statusData.eventStream,
            floorSequence: 3,
            observedThroughSequence: 1,
          },
        },
        json,
        impossibleCut.output,
      )).toThrow(InvalidCommandResponseError);
      expect(impossibleCut.stdout).toEqual([]);
    }

    const global = capture();
    renderSuccess(
      { kind: "interaction.list", pending: false, limit: 100 },
      { sessionId: null, interactions: [], nextCursor: cursor },
      false,
      global.output,
    );
    expect(global.stdout.join("")).toContain(
      `Continue: oompa interaction list --limit 100 --cursor ${cursor}\n`,
    );

    const json = capture();
    renderSuccess(
      { kind: "interaction.list", session: "mutable-label", pending: true, limit: 37 },
      data,
      true,
      json.output,
    );
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      data: { interactions: [], nextCursor: cursor, sessionId },
    });
  });

  test("renders session-list continuations with the resolved account ID and preserves cursors in JSON", () => {
    const accountId = "acct_00000000000000000000000000000000";
    const cursor = cursorWire("session-list");
    const listing = {
      accountId,
      listing: {
        accountSelector: accountId,
        accountState: "signed_out",
        provider: "codex",
        scope: "local_only",
        freshness: "stale",
        localCompleteness: "partial",
        providerAccess: "not_attempted",
        providerCompleteness: "unknown",
        nextCommand: `oompa account login ${accountId}`,
      },
      sessions: [{
        id: "sess_00000000000000000000000000000000",
        profileId: accountId,
        title: "Older imported thread",
        state: "idle",
        provider: "codex",
        preset: "high",
        fastEnabled: false,
        revision: 4,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_001,
      }, {
        id: "sess_11111111111111111111111111111111",
        profileId: accountId,
        title: "Live Claude thread",
        state: "idle",
        provider: "claude",
        preset: "fable-max",
        fastEnabled: false,
        revision: 2,
        createdAt: 1_700_000_000_002,
        updatedAt: 1_700_000_000_003,
      }],
      nextCursor: cursor,
    };
    const human = capture();
    renderSuccess(
      { kind: "session.list", account: "mutable-label", archived: false, limit: 37, cursor: "earlier" },
      listing,
      false,
      human.output,
    );
    expect(human.stdout.join("")).toContain(`Codex scope: local-only cache for ${accountId}`);
    expect(human.stdout.join("")).toContain("Codex freshness: stale; Codex provider not contacted");
    expect(human.stdout.join("")).toContain(
      "Codex completeness: partial local cache; more pages available; Codex provider completeness unknown",
    );
    expect(human.stdout.join("")).toContain(`Sign in to refresh Codex: oompa account login ${accountId}`);
    expect(human.stdout.join("")).toContain("Older imported thread");
    expect(human.stdout.join("")).toContain("Live Claude thread");
    expect(human.stdout.join("")).not.toContain("Claude freshness");
    expect(human.stdout.join("")).not.toContain("Claude provider not contacted");
    expect(human.stdout.join("")).not.toContain("Sign in to refresh Claude");
    expect(human.stdout.join("")).toContain(
      `Continue: oompa session list --account ${accountId} --limit 37 --cursor ${cursor}\n`,
    );
    expect(human.stdout.join("")).not.toContain("mutable-label");

    const json = capture();
    renderSuccess(
      { kind: "session.list", account: "mutable-label", archived: false, limit: 37 },
      listing,
      true,
      json.output,
    );
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      data: {
        accountId,
        listing: listing.listing,
        nextCursor: cursor,
        sessions: listing.sessions,
      },
    });

    const privateSentinel = "PRIVATE-PROVIDER-THREAD-SENTINEL";
    const stripped = capture();
    renderSuccess(
      { kind: "session.list", account: accountId, archived: false, limit: 37 },
      {
        ...listing,
        sessions: listing.sessions.map((session) => ({
          ...session,
          providerThreadId: privateSentinel,
          activeTurnId: privateSentinel,
          note: privateSentinel,
          unknownField: privateSentinel,
        })),
        unknownRoot: privateSentinel,
      },
      true,
      stripped.output,
    );
    expect(stripped.stdout.join("")).not.toContain(privateSentinel);
    const strippedEnvelope = z.object({
      data: z.object({ sessions: z.array(z.unknown()) }).passthrough(),
    }).passthrough().parse(JSON.parse(stripped.stdout.join("")) as unknown);
    expect(strippedEnvelope.data.sessions[0]).toEqual(
      listing.sessions[0],
    );

    const foreignAccountId = "acct_11111111111111111111111111111111";
    for (const response of [
      { ...listing, accountId: foreignAccountId },
      {
        ...listing,
        sessions: listing.sessions.map((session) => ({
          ...session,
          profileId: foreignAccountId,
        })),
      },
    ]) {
      const mismatched = capture();
      expect(() => renderSuccess(
        { kind: "session.list", account: accountId, archived: false, limit: 37 },
        response,
        true,
        mismatched.output,
      )).toThrow(InvalidCommandResponseError);
      expect(mismatched.stdout).toEqual([]);
    }

    const malformed = capture();
    expect(() => renderSuccess(
      { kind: "session.list", account: "mutable-label", archived: false, limit: 37 },
      { ...listing, nextCursor: "provider-cursor-must-not-render" },
      false,
      malformed.output,
    )).toThrow(InvalidCommandResponseError);
    expect(malformed.stdout.join("")).toBe("");
    expect(malformed.stdout.join("")).not.toContain("provider-cursor-must-not-render");

    const unsafeMetadata = capture();
    expect(() => renderSuccess(
      { kind: "session.list", account: "mutable-label", archived: false, limit: 37 },
      {
        ...listing,
        listing: {
          ...listing.listing,
          nextCommand: `oompa account login ${accountId}; touch /tmp/unsafe`,
        },
      },
      false,
      unsafeMetadata.output,
    )).toThrow(InvalidCommandResponseError);
    expect(unsafeMetadata.stdout.join("")).not.toContain("touch /tmp/unsafe");

    for (const invalidListing of [
      { ...listing.listing, provider: "claude" },
      Object.fromEntries(Object.entries(listing.listing).filter(([key]) => key !== "provider")),
    ]) {
      const invalidProvider = capture();
      expect(() => renderSuccess(
        { kind: "session.list", account: accountId, archived: false, limit: 37 },
        { ...listing, listing: invalidListing },
        false,
        invalidProvider.output,
      )).toThrow(InvalidCommandResponseError);
      expect(invalidProvider.stdout).toEqual([]);
    }
  });

  test("renders brokered MCP form input as protected", () => {
    const record: PublicInteraction = {
      version: 1,
      id: "b0000000-0000-4000-8000-000000000001",
      sessionId: null,
      kind: "mcp_elicitation",
      state: "pending",
      revision: 1,
      blocking: true,
      display: {
        kind: "mcp_elicitation",
        summary: "Authorize the server",
        serverName: "example",
        mode: "form",
        url: null,
        mayContainSecrets: true,
        fields: [
          {
            name: "email",
            type: "string",
            required: true,
            minLength: 3,
            maxLength: 320,
            format: "email",
          },
          {
            name: "channel",
            type: "single_select",
            required: false,
            choices: ["stable", "fast"],
          },
        ],
      },
      responseRecorded: false,
      context: { turnId: null, itemId: null },
      requestedAt: 1,
      deadlineAt: Date.now() + 60_000,
      updatedAt: 1,
      terminalAt: null,
    };
    const target = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      record,
      false,
      target.output,
    );
    expect(target.stdout.join("")).toContain("Input: protected");
    expect(target.stdout.join("")).toContain("email: string, required, 3..320 characters, format email");
    expect(target.stdout.join("")).toContain("channel: single select, optional, choices stable, fast");
    expect(target.stdout.join("")).toContain('{"content":{...}}');
    expect(target.stdout.join("")).not.toContain("SENTINEL");
    const json = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      record,
      true,
      json.output,
    );
    expect(json.stdout.join("")).not.toContain("SENTINEL");
    const payload = JSON.parse(json.stdout.join("")) as {
      data: { interaction: { display: { fields?: unknown; url: unknown; mayContainSecrets: unknown } } };
    };
    expect(payload).toMatchObject({
      data: {
        interaction: {
          display: {
            url: null,
            mayContainSecrets: true,
          },
        },
      },
    });
    if (record.display.kind !== "mcp_elicitation") throw new Error("Expected MCP display.");
    expect(payload.data.interaction.display.fields).toEqual(record.display.fields);

    const unsupported = capture();
    renderSuccess(
      { kind: "interaction.show", interaction: record.id },
      {
        ...record,
        display: { ...record.display, fields: undefined },
      },
      false,
      unsupported.output,
    );
    expect(unsupported.stdout.join("")).toContain(
      "This MCP request cannot be resolved safely through Oompa.",
    );
    expect(unsupported.stdout.join("")).not.toContain(
      "Submit one protected JSON document",
    );
  });

  test("serializes undefined output as JSON null instead of throwing", () => {
    const target = capture();
    renderSuccess({ kind: "project.use", project: "Documents" }, undefined, false, target.output);
    expect(target.stdout).toEqual(["null\n"]);
  });

  test("bounds and redacts error diagnostics in human and JSON output", () => {
    const secret = "token=do-not-print";
    const attack = `provider failed at /private/runtime ${secret}\u001b]52;c;attack\u0007`;
    for (const json of [false, true]) {
      const target = capture();
      renderFailure({
        code: "UNAVAILABLE",
        message: attack,
        details: { diagnostic: attack },
      }, json, target.output);
      const rendered = [...target.stdout, ...target.stderr].join("");
      expect(rendered).not.toContain("do-not-print");
      expect(rendered).not.toContain("/private/runtime");
      expect(rendered).not.toContain("\u001b");
      expect(rendered).not.toContain("\u0007");
      expect(rendered).toContain("[redacted]");
    }
    expect(safeDiagnostic("provider failed at /private/runtime")).toContain("[local-path]");

    const internal = capture();
    renderFailure({ code: "INTERNAL", message: attack, details: { secret: attack } }, true, internal.output);
    const payload = JSON.parse(internal.stdout.join("")) as { error: Record<string, unknown> };
    expect(payload.error).toEqual({
      code: "INTERNAL",
      message: "Oompa could not complete the request safely.",
    });

    const oversized = capture();
    renderFailure({
      code: "UNAVAILABLE",
      message: "Provider unavailable.",
      details: Object.fromEntries(Array.from({ length: 64 }, (_, index) => [
        `detail-${String(index)}`,
        "\u0080".repeat(1_024),
      ])),
    }, true, oversized.output);
    expect(oversized.stdout).toHaveLength(1);
    expect(Buffer.byteLength(oversized.stdout[0] ?? "", "utf8"))
      .toBeLessThanOrEqual(WORK_STREAM_FAILURE_MAX_BYTES);
    expect(JSON.parse(oversized.stdout[0] ?? "")).toEqual({
      ok: false,
      version: 1,
      error: { code: "UNAVAILABLE", message: "Provider unavailable." },
    });
  });

  test("redacts complete credential grammars before diagnostic bounding", () => {
    const amazonKey = "AKIA".concat("ABCDEFGHIJKLMNOP");
    const secrets = [
      ["Authorization: Basic dTpw", "dTpw"],
      ["Basic dTpw", "dTpw"],
      ["HTTP_AUTHORIZATION=Basic dTpw", "dTpw"],
      ["client_secret=topsecret123", "topsecret123"],
      ["AWS_SECRET_ACCESS_KEY=AWSOPAQUESECRET123", "AWSOPAQUESECRET123"],
      ["OPENAI_API_KEY=opaque123", "opaque123"],
      ["MY_PASSWORD=myPasswordSecret123", "myPasswordSecret123"],
      ["clientSecret=camelClientSecret123", "camelClientSecret123"],
      ["apiKey=camelApiKey123", "camelApiKey123"],
      ["accessToken=camelAccessToken123", "camelAccessToken123"],
      ["refreshToken=camelRefreshToken123", "camelRefreshToken123"],
      ["secretAccessKey=camelSecretAccessKey123", "camelSecretAccessKey123"],
      ["api key=spaced123", "spaced123"],
      ["provider sk-proj-ABCDEFGH123456 failed", "sk-proj-ABCDEFGH123456"],
      ["github_pat_ABCDEFGH123456", "github_pat_ABCDEFGH123456"],
      ["xoxb-12345678-secret", "xoxb-12345678-secret"],
      [amazonKey, amazonKey],
    ] as const;
    for (const [source, secret] of secrets) {
      const rendered = safeDiagnostic(source);
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain(secret);
    }
    for (const source of [
      "access_token=Bearer SUPERSECRET123",
      "password=`secret tail`",
      'password="secret tail',
      "password=alpha,beta;gamma",
    ]) {
      expect(safeDiagnostic(source)).toBe("[redacted]");
    }
    for (const source of [
      "pass\u001bword=hunter2",
      "github_\u001bpat_ABCDEFGH123456",
      "sk-\u200bproj-ABCDEFGH123456",
      "Bearer\u001b]0;owned\u0007 abc123",
      "pass\ufe0fword=VARIATIONSECRET123",
      "pass\u034fword=CGJSECRET456",
    ]) {
      expect(safeDiagnostic(source)).toBe("[redacted]");
    }
    for (const source of [
      "password\u00a0=\u00a0hunter2",
      "password\u2009=\u2009hunter2",
      "password\u202f=\u202fhunter2",
    ]) {
      expect(safeDiagnostic(source)).toBe("[redacted]");
    }
    for (const source of [
      '{"client_secret":"jsonClientSecret123","access_token":"jsonAccessToken456"}',
      "{'apiKey':'singleQuotedSecret123'}",
      "{`refreshToken`:`backtickSecret456`}",
    ]) {
      const rendered = safeDiagnostic(source);
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain("Secret123");
      expect(rendered).not.toContain("Token456");
      expect(rendered).not.toContain("Secret456");
    }
    for (const source of [
      '{\n  "client_secret":\n  "prettyJsonSecret123"\n}',
      "password=\n multilineSecret456",
    ]) {
      const rendered = safeDiagnostic(source);
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain("prettyJsonSecret123");
      expect(rendered).not.toContain("multilineSecret456");
    }
    const cutoffJwt = `prefix ${"x".repeat(2_025)} eyJ${"A".repeat(80)}`;
    const renderedJwt = safeDiagnostic(cutoffJwt);
    expect(renderedJwt).toContain("[redacted]");
    expect(renderedJwt).not.toContain(`eyJ${"A".repeat(8)}`);
  });

  test("redacts values associated with sensitive structured diagnostic keys", () => {
    for (const json of [false, true]) {
      const target = capture();
      renderFailure({
        code: "UNAVAILABLE",
        message: "provider failed",
        details: {
          client_secret: "hunter2",
          nested: {
            apiKey: "opaque123",
            entries: [{ Authorization: "Basic dTpw" }],
          },
          "pass\u001bword": "controlBypass456",
          "config.apiKey": "flattenedApiSecret789",
          "auth/token": "flattenedTokenSecret123",
          "credentials:client_secret": "flattenedClientSecret456",
          $password: "sigilPasswordSecret123",
          "config\\apiKey": "backslashApiSecret456",
          "credentials password": "spacedPasswordSecret789",
        },
      }, json, target.output);
      const rendered = [...target.stdout, ...target.stderr].join("");
      expect(rendered).toContain("[redacted]");
      expect(rendered).not.toContain("hunter2");
      expect(rendered).not.toContain("opaque123");
      expect(rendered).not.toContain("dTpw");
      expect(rendered).not.toContain("controlBypass456");
      expect(rendered).not.toContain("flattenedApiSecret789");
      expect(rendered).not.toContain("flattenedTokenSecret123");
      expect(rendered).not.toContain("flattenedClientSecret456");
      expect(rendered).not.toContain("sigilPasswordSecret123");
      expect(rendered).not.toContain("backslashApiSecret456");
      expect(rendered).not.toContain("spacedPasswordSecret789");
    }
  });

  test("renders source-ordered account usage-history pages and safe continuations", () => {
    const command = {
      kind: "account.usage-history" as const,
      account: "work",
      limit: 2,
    };
    const data = {
      account: {
        id: `acct_${"1".repeat(32)}`,
        label: "Work",
      },
      range: {
        fromObservedAt: 1_700_000_000_000,
        throughObservedAt: 1_700_000_300_000,
      },
      entries: [
        {
          state: "observed",
          sourceRevision: 7,
          observedAt: 1_700_000_060_000,
          receivedAt: 1_700_000_061_000,
          lifetimeTokens: 12_345,
          gapBefore: false,
        },
        {
          state: "failed",
          sourceRevision: 8,
          observedAt: 1_700_000_120_000,
          reasonCode: "account_usage_read_failed",
        },
      ],
      nextCursor: "hrau1.abc.def",
    };
    const human = capture();
    renderSuccess(command, data, false, human.output);
    const rendered = human.stdout.join("");
    expect(rendered).toContain("Usage history for Work");
    expect(rendered).toContain("12,345");
    expect(rendered).toContain("account_usage_read_failed");
    expect(rendered).toContain("Continue: oompa account usage-history acct_");
    expect(rendered).toContain("--cursor hrau1.abc.def");

    const json = capture();
    renderSuccess(command, data, true, json.output);
    expect(JSON.parse(json.stdout.join(""))).toMatchObject({
      ok: true,
      command: "account.usage-history",
      data: {
        entries: [
          { sourceRevision: 7, state: "observed" },
          { sourceRevision: 8, state: "failed" },
        ],
        nextCursor: "hrau1.abc.def",
      },
    });

    const attacked = capture();
    expect(() => renderSuccess(command, {
      ...data,
      providerPayload: { access_token: "PRIVATE-USAGE-SENTINEL" },
    }, true, attacked.output)).toThrow(InvalidCommandResponseError);
    expect(attacked.stdout.join("")).not.toContain("PRIVATE-USAGE-SENTINEL");
    expect(attacked.stdout.join("")).toBe("");
  });

  test("renders historical usage health and velocity without dumping provider payloads", () => {
    const target = capture();
    renderSuccess(
      { account: "work", kind: "account.usage", refresh: false },
      {
        refresh: {
          accountLimit: 32,
          concurrency: 4,
          outcomes: [
            { accountId: "acct_00000000000000000000000000000000", state: "refreshed" },
            {
              accountId: "acct_11111111111111111111111111111111",
              accountState: "signed_out",
              reason: "not_signed_in",
              state: "skipped",
            },
          ],
        },
        usage: [{
          account: { id: "acct_00000000000000000000000000000000", label: "Work" },
          automaticReset: {
            threshold: { remainingPercent: 1, usedPercent: 99 },
            policy: { state: "active" },
            observation: {
              state: "available",
              creditsAvailable: 1,
              remainingPercent: 72.5,
              usedPercent: 27.5,
              weeklyWindowResetsAt: 1_700_500_000_000,
            },
            lastAttempt: {
              state: "settled",
              outcome: "reset",
              weeklyWindowResetsAt: 1_700_500_000_000,
            },
            refresh: { state: "not_eligible", reason: "below_threshold" },
          },
          poll: { observedAt: 1_700_000_000_000, sourceRevision: 4, state: "observed" },
          snapshot: {
            observedAt: 1_700_000_000_000,
            payload: {
              privateProviderField: "must-not-render",
              rateLimits: { primary: { usedPercent: 27.5 } },
              usage: { summary: { lifetimeTokens: 12_345 } },
            },
          },
          velocity: {
            "1m": { available: true, tokensPerMinute: 42.25 },
            "5m": { available: false, reason: "insufficient_history" },
            "15m": { available: false, reason: "stale_gap" },
          },
        }],
      },
      false,
      target.output,
    );
    const rendered = target.stdout.join("");
    expect(rendered).toContain("Work\n");
    expect(rendered).toContain("lifetime tokens: 12,345");
    expect(rendered).toContain("automatic reset policy: 99% used (1% remaining)");
    expect(rendered).toContain("automatic reset reconciliation: active");
    expect(rendered).toContain("weekly Codex limit: 27.5% used; 72.5% remaining");
    expect(rendered).toContain("reset credits available: 1");
    expect(rendered).toContain("most recent automatic reset attempt: settled (reset)");
    expect(rendered).toContain("automatic reset refresh: not eligible (below_threshold)");
    expect(rendered).toContain("1m 42.3 tokens/min");
    expect(rendered).toContain("Refresh outcomes");
    expect(rendered).toContain("acct_00000000000000000000000000000000: refreshed");
    expect(rendered).toContain("acct_11111111111111111111111111111111: skipped (signed_out)");
    expect(rendered).toContain("5m unavailable (insufficient_history)");
    expect(rendered).not.toContain("must-not-render");
  });

  test("explains disabled automatic reset management while retaining machine-readable status", () => {
    const command = { account: "work", kind: "account.usage" as const, refresh: true };
    const automaticReset = {
      threshold: { remainingPercent: 1, usedPercent: 99 },
      policy: { state: "active" },
      observation: { state: "unavailable", reason: "weekly_window_unavailable" },
      lastAttempt: null,
      refresh: { state: "suppressed", reason: "automatic_policy_disabled" },
    };
    const data = { usage: [{ account: { id: "acct_" + "0".repeat(32), label: "Work" }, automaticReset }] };
    const human = capture();
    renderSuccess(command, data, false, human.output);
    expect(human.stdout.join("")).toContain("automatic reset refresh: suppressed (automatic management is off)");
    const json = capture();
    renderSuccess(command, data, true, json.output);
    expect(JSON.parse(json.stdout.join("")) as unknown).toMatchObject({ data: { usage: [{ automaticReset }] } });
    for (const refresh of [
      { state: "suppressed", reason: "automatic_policy_disabled", idempotencyKey: "private-key" },
      { state: "suppressed", reason: "automatic_policy_disabled", automaticPolicyRevision: 1 },
      { state: "suppressed", reason: "automatic_policy_disabled_future" },
    ]) {
      for (const asJson of [false, true]) {
        const refused = capture();
        expect(() => renderSuccess(command, {
          usage: [{ ...data.usage[0], automaticReset: { ...automaticReset, refresh } }],
        }, asJson, refused.output)).toThrow(InvalidCommandResponseError);
        expect(refused.stdout).toEqual([]);
      }
    }
  });

  test("rejects malformed or private automatic-reset fields before human or JSON output", () => {
    const command = {
      account: "work",
      kind: "account.usage" as const,
      refresh: false,
    };
    const base = {
      threshold: { remainingPercent: 1, usedPercent: 99 },
      policy: { state: "active" },
      observation: {
        state: "unavailable",
        reason: "weekly_window_unavailable",
      },
      lastAttempt: null,
    };
    for (const automaticReset of [
      { ...base, idempotencyKey: "00000000-0000-4000-8000-000000000001" },
      {
        ...base,
        policy: {
          state: "window_suppressed",
          weeklyWindowResetsAt: 2_000_000_000_000,
          accountFingerprint: "a".repeat(64),
        },
      },
      {
        ...base,
        lastAttempt: {
          state: "settled",
          outcome: "reset",
          weeklyWindowResetsAt: 2_000_000_000_000,
          accountFingerprint: "a".repeat(64),
        },
      },
      {
        ...base,
        lastAttempt: {
          state: "closed",
          outcome: "reset",
          weeklyWindowResetsAt: 2_000_000_000_000,
        },
      },
    ]) {
      for (const json of [false, true]) {
        const target = capture();
        expect(() => renderSuccess(
          command,
          { usage: [{ automaticReset }] },
          json,
          target.output,
        )).toThrow(InvalidCommandResponseError);
        expect(target.stdout).toEqual([]);
      }
    }
  });

  test("fails closed instead of dumping malformed interaction or event payloads", () => {
    const sentinel = "SECRET_SENTINEL";
    const interaction = capture();
    expect(() => renderSuccess(
      { kind: "interaction.show", interaction: "c0000000-0000-4000-8000-000000000001" },
      { interaction: { rawProviderRequest: sentinel } },
      false,
      interaction.output,
    )).toThrow(InvalidCommandResponseError);
    expect(interaction.stdout).toEqual([]);
    expect(interaction.stdout.join("")).not.toContain(sentinel);

    const interactionJson = capture();
    expect(() => renderSuccess(
      { kind: "interaction.show", interaction: "c0000000-0000-4000-8000-000000000001" },
      { interaction: { rawProviderRequest: sentinel } },
      true,
      interactionJson.output,
    )).toThrow(InvalidCommandResponseError);
    expect(interactionJson.stdout).toEqual([]);
    expect(interactionJson.stdout.join("")).not.toContain(sentinel);

    const events = capture();
    expect(() => renderSuccess(
      { kind: "session.events", session: "release", limit: 200, waitMs: 0 },
      { rawProviderEvent: sentinel },
      false,
      events.output,
    )).toThrow(InvalidCommandResponseError);
    expect(events.stdout).toEqual([]);
    expect(events.stdout.join("")).not.toContain(sentinel);
  });

  test("renders owner memory status, query rows, and replay authority without raw store locators", () => {
    const digest = "a".repeat(64);
    const operation = "b".repeat(64);
    const status = capture();
    renderSuccess(
      { kind: "memory.status", session: "release" },
      {
        version: 1,
        ok: true,
        sessionId: `sess_${"1".repeat(32)}`,
        projectId: `proj_${"2".repeat(32)}`,
        canonical: {
          initialized: true,
          physicalState: "initialized",
          identityContract: 2,
          authorityDigest: "c".repeat(64),
          bindingDigest: "d".repeat(64),
          expectedHead: { digest, operationSha256: operation, sequence: 4 },
          syncState: "error",
          frozen: true,
          diagnosticCode: "MEMORY_CANONICAL_DIVERGED",
          revision: 5,
          lastExchangeAt: null,
          lastExchangeHead: null,
        },
        working: {
          state: "active",
          ownerMatchesSession: true,
          bindingDigest: "e".repeat(64),
          epoch: 2,
          head: { digest: "f".repeat(64), operationSha256: operation, sequence: 3 },
        },
        unsettledSubmission: null,
      },
      false,
      status.output,
    );
    const statusText = status.stdout.join("");
    expect(statusText).toContain("Canonical: error (frozen)");
    expect(statusText).toContain("Canonical physical state: initialized");
    expect(statusText).toContain("Canonical identity contract: 2");
    expect(statusText).toContain("Canonical expected head: sequence 4");
    expect(statusText).toContain("Working: active, epoch 2");
    expect(statusText).toContain("Unsettled submission: none");
    expect(statusText).not.toContain("/project-memory/");

    const query = capture();
    renderSuccess(
      {
        kind: "memory.query",
        session: "release",
        value: { key: "architecture.boundary", mode: "get" },
      },
      {
        version: 1,
        ok: true,
        mode: "get",
        queryId: `memq_${"3".repeat(32)}`,
        rows: [{
          row: 0,
          lane: "working",
          key: "architecture.boundary",
          title: "Authority boundary",
          summary: "Use the coordinator.",
          recordSha256: "4".repeat(64),
          provenance: { verification: "local-ledger-verified" },
          bodyChunk: "first line\nsecond line\u001b[31m",
          chunkIndex: 0,
          chunkCount: 1,
        }],
        continuation: null,
        scope: "working",
        canonical: { included: false, frozen: true },
        canonicalHead: null,
        workingHead: { digest: "f".repeat(64), operationSha256: operation, sequence: 3 },
      },
      false,
      query.output,
    );
    const queryText = query.stdout.join("");
    expect(queryText).toContain("Body chunk 1 of 1:");
    expect(queryText).toContain("Scope: working only");
    expect(queryText).toContain("Canonical: excluded (frozen)");
    expect(queryText).toContain("  first line\n  second line\\u{001b}[31m");
    expect(queryText).not.toContain("\u001b[31m");

    const mutation = capture();
    const mutationCommand = {
      kind: "memory.remember" as const,
      session: "release",
      idempotencyKey: "00000000-0000-4000-8000-000000000701",
      value: {
        key: "architecture.boundary",
        title: "Authority boundary",
        summary: "Use the coordinator.",
        body: "No direct store access.",
      },
    };
    renderSuccess(mutationCommand, {
      version: 1,
      ok: true,
      replay: true,
      idempotencyRetainedUntil: "2026-10-01T00:00:00.000Z",
      submission: { id: `memsub_${"5".repeat(32)}`, kind: "remember", state: "applied" },
      page: { key: "architecture.boundary", recordSha256: "6".repeat(64) },
      workingHead: { digest, operationSha256: operation, sequence: 4 },
      receiptSha256: "7".repeat(64),
    }, false, mutation.output);
    expect(mutation.stdout.join("")).toContain("Remember: applied (replay)");
    expect(mutation.stdout.join("")).toContain(mutationCommand.idempotencyKey);
  });

  test("renders explicit hosted memory ownership without exposing cryptographic material", () => {
    const command = {
      idempotencyKey: "00000000-0000-4000-8000-000000000704",
      kind: "memory.hosted.create" as const,
      project: "jungle",
    };
    const target = capture();
    renderSuccess(command, {
      attachment: { generation: 1 },
      canonicalSpaceId: `pmem_${"B".repeat(32)}`,
      hostedSpaceId: `memory_${"A".repeat(32)}`,
      projectId: `proj_${"1".repeat(32)}`,
      replay: false,
    }, false, target.output);
    const rendered = target.stdout.join("");
    expect(rendered).toContain(`Hosted memory created: memory_${"A".repeat(32)}`);
    expect(rendered).toContain("Attachment generation: 1");
    expect(rendered).not.toContain("wrappedSpaceKey");
    expect(rendered).not.toContain("ciphertext");
  });
});
