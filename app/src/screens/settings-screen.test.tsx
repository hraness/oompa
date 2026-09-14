import { describe, expect, test } from "bun:test";
import { createStylexTransformCollector } from "@hraness/ui/stylex-build";
import * as stylex from "@stylexjs/stylex";
import { parseHTML } from "linkedom";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";

import { decodeHistoricalProfileKey } from "../oompa/cloud";
import type { AccountRowView, MachineView, ProfileBindingView } from "../model/settings-view";
import { AccountBrowserLoginControls, DefaultProfileObservation, MemorySupervision } from "./settings-screen";
import { settingsScreenStyles } from "./settings-screen.stylex";

function account(
  accountLinkingAllowed: boolean,
  deviceCommandsAllowed: boolean,
): AccountRowView {
  return {
    accountLinkingAllowed,
    deviceCommandsAllowed,
    label: "work",
    machineLabel: "studio",
    provider: "codex",
    publicId: "acct_one",
    status: "signed_out",
    targetDevicePublicId: "device_daemon01",
  };
}

describe("browser account login controls", () => {
  test("renders Link and Check only when both machine gates are enabled", () => {
    for (const deviceCommandsAllowed of [false, true]) {
      for (const accountLinkingAllowed of [false, true]) {
        const markup = renderToStaticMarkup(
          <AccountBrowserLoginControls
            account={account(accountLinkingAllowed, deviceCommandsAllowed)}
            busy={false}
            onStart={() => undefined}
            onStatus={() => undefined}
          />,
        );
        if (accountLinkingAllowed && deviceCommandsAllowed) {
          expect(markup).toContain("Link here");
          expect(markup).toContain("Check status");
        } else {
          expect(markup).toBe("");
        }
      }
    }
  });

  test("keeps both admitted actions disabled while their mutation is outstanding", () => {
    const markup = renderToStaticMarkup(
      <AccountBrowserLoginControls
        account={account(true, true)}
        busy
        onStart={() => undefined}
        onStatus={() => undefined}
      />,
    );
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
  });

  test("never renders browser login actions for provider-owned CLI login", () => {
    for (const provider of ["claude", "devin"] as const) {
      const markup = renderToStaticMarkup(
        <AccountBrowserLoginControls
          account={{ ...account(true, true), provider }}
          busy={false}
          onStart={() => undefined}
          onStatus={() => undefined}
        />,
      );
      expect(markup).toBe("");
      expect(markup).not.toContain("Link here");
      expect(markup).not.toContain("Check status");
    }
  });
});

describe("read-only default profile observation", () => {
  for (const [key, expected] of [
    ["codex:gpt-5.6-luna:max", "gpt-5.6-luna / max"],
    ["codex:gpt-5.6-sol:max", "gpt-5.6-sol / max"],
    ["codex:gpt-5.6-sol:ultra", "gpt-5.6-sol / ultra"],
    ["codex:gpt-6-astra:max", "gpt-6-astra / max"],
    ["codex:gpt-6-astra:ultra", "gpt-6-astra / ultra"],
  ] as const) {
    test(`renders ${expected} as reported configuration with no action`, () => {
      const profile = decodeHistoricalProfileKey(key);
      if (profile?.provider !== "codex") throw new Error("invalid Codex profile fixture");
      const markup = renderToStaticMarkup(<DefaultProfileObservation observation={{ profile, status: "current" }} />);
      const { document } = parseHTML(markup);
      expect(markup).toContain("Last reported Codex default");
      expect(markup).toContain(expected);
      expect(markup).toContain("Reported configuration only, not session state or runtime capability.");
      expect(document.querySelector("button, input, select, a, [role=radio], [role=switch]")).toBeNull();
      expect(document.querySelector("[class]")).not.toBeNull();
      expect(document.querySelector("[style], style")).toBeNull();
      if (profile.model === "gpt-6-astra") expect(markup).not.toContain("gpt-5.6-sol");
    });
  }

  for (const status of ["inactive", "stale", "unreadable", "unsupported"] as const) {
    test(`renders ${status} explicitly without retaining a previous exact label`, () => {
      // Even a malformed view retaining an old profile cannot bypass the status.
      const observation = {
        profile: decodeHistoricalProfileKey("codex:gpt-5.6-sol:ultra"),
        status,
      } as unknown as ProfileBindingView;
      const markup = renderToStaticMarkup(<DefaultProfileObservation observation={observation} />);
      const { document } = parseHTML(markup);
      expect(markup).toContain("Last reported Codex default");
      expect(markup).toContain(status);
      expect(markup).toContain("Unavailable:");
      expect(markup).not.toMatch(/gpt-|claude-|\bultra\b|\bmax\b/u);
      expect(document.querySelector("button, input, select, a, [role=radio], [role=switch]")).toBeNull();
      expect(document.querySelector("[style], style")).toBeNull();
    });
  }
});

describe("read-only memory supervision", () => {
  const now = 1_760_000_000_000;
  const digest = (scalar: string) => scalar.repeat(64);
  const summary = (head: string) => ({
    coverage: { peerActions: "complete" as const, peerPolicies: "complete" as const, spaces: "complete" as const },
    observedAt: now,
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
      canonicalSpaceId: `hra:project:space-${"d".repeat(32)}`,
      enrollment: "attached" as const,
      head: { digest: digest(head), operationSha256: digest(head), sequence: 2 },
      lastExchangeAt: now,
      projectLabel: "Oompa",
      recentRecords: [{ key: "release-policy", kind: "memory_page" as const, updatedAt: now }],
      recordCount: 1,
      remoteHead: { digest: digest(head), operationSha256: digest(head), sequence: 2 },
      syncStatus: "settled" as const,
    }],
    version: 1 as const,
  });
  const machine = (id: string, label: string, head: string): MachineView => ({
    accountLinkingAllowed: false,
    accounts: [],
    attentionEmailEnabled: null,
    daemonVersion: "0.6.0",
    defaultApprovalMode: "auto:all",
    defaultPreset: "ultra",
    defaultProjectPublicId: null,
    deviceCommandsAllowed: true,
    devicePublicId: id,
    deviceStatus: "active",
    heartbeatAt: now,
    label,
    memorySummary: summary(head),
    memorySummaryFreshness: "current",
    notificationHours: null,
    notificationHoursStatus: "unsupported",
    notificationPolicyFreshness: "unsupported",
    notificationPolicyRevision: null,
    online: true,
    projects: [],
    profileBinding: { profile: null, status: "unsupported" },
    proseAutorespondConfigured: false,
    revision: 1,
    scheduledTasks: [],
    sessionAdoption: null,
    showThinkingDefault: false,
    updatedAt: now,
  });

  test("renders disagreement and explicit actor/target roles without mutation controls", () => {
    const markup = renderToStaticMarkup(
      <MemorySupervision
        machines={[
          machine("device_studio01", "Studio", "e"),
          machine("device_laptop01", "Laptop", "f"),
        ]}
        now={now}
        ready={true}
      />,
    );
    expect(markup).toContain("Memory and peer activity");
    expect(markup).toContain("heads disagree");
    expect(markup).toContain("Exact head 2:eeeeeeeeeeee");
    expect(markup).toContain("Exact head 2:ffffffffffff");
    expect(markup).toContain("Actor Planner (aaaaaaaaaaaa) → target Planner (bbbbbbbbbbbb)");
    expect(markup).toContain("Messages and reasons are not uploaded.");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("private reason");
  });

  test("publishes recent memory records through compiled local list and key recipes", async () => {
    const markup = renderToStaticMarkup(
      <MemorySupervision machines={[machine("device_studio01", "Studio", "e")]} now={now} ready={true} />,
    );
    const { document } = parseHTML(markup);
    const lists = document.querySelectorAll('ul[aria-label="Recent memory records on Studio"]');
    expect(lists).toHaveLength(1);
    const list = lists[0]!;
    expect(list.className).toBe(stylex.props(settingsScreenStyles.memoryRecords).className!);
    const keys = list.querySelectorAll("li > span");
    expect(keys).toHaveLength(1);
    expect(keys[0]!.textContent).toBe("release-policy");
    expect(keys[0]!.className).toBe(stylex.props(settingsScreenStyles.memoryRecordKey).className!);
    expect(list.textContent).toContain("memory page");
    expect(markup).not.toContain("style=");
    expect(markup).not.toContain("<style");
    for (const utility of ["flex", "flex-col", "gap-1", "text-xs", "text-ink-muted", "font-mono"]) {
      expect(document.querySelectorAll("." + utility)).toHaveLength(0);
    }
    const recipePath = fileURLToPath(new URL("./settings-screen.stylex.ts", import.meta.url));
    const collector = createStylexTransformCollector(fileURLToPath(new URL("../../..", import.meta.url)));
    const { rules } = await collector.transform(await Bun.file(recipePath).text(), recipePath);
    const cssFor = (element: Element) => rules
      .filter(([name]) => element.classList.contains(name))
      .map(([, rule]) => rule.ltr)
      .join("\n");
    const listCss = cssFor(list);
    for (const declaration of [
      "color:var(--color-ink-muted)", "display:flex", "flex-direction:column",
      "font-size:.75rem", "gap:.25rem", "line-height:1rem", "list-style-type:none",
      "margin-block:0", "margin-inline:0", "padding-block:0", "padding-inline:0",
    ]) expect(listCss).toContain(declaration);
    expect(cssFor(keys[0]!)).toContain("font-family:var(--font-mono)");
  });

  test("renders no memory-derived state before the hosted clock is ready", () => {
    const markup = renderToStaticMarkup(
      <MemorySupervision
        machines={[machine("device_studio01", "Studio", "e")]}
        now={Number.MIN_SAFE_INTEGER}
        ready={false}
      />,
    );
    expect(markup).toBe("");
  });

  test("labels a single current observation as insufficient evidence", () => {
    const markup = renderToStaticMarkup(
      <MemorySupervision
        machines={[machine("device_studio01", "Studio", "e")]}
        now={now}
        ready={true}
      />,
    );
    expect(markup).toContain("insufficient evidence");
    expect(markup).not.toContain("one current head");
  });

  test("surfaces capped coverage without turning an omitted space into non-enrollment", () => {
    const studio = machine("device_studio01", "Studio", "e");
    const laptop = machine("device_laptop01", "Laptop", "e");
    const boundedLaptop: MachineView = {
      ...laptop,
      memorySummary: {
        ...summary("e"),
        coverage: {
          peerActions: "bounded",
          peerPolicies: "complete",
          spaces: "bounded",
        },
        spaces: [],
      },
    };
    const markup = renderToStaticMarkup(
      <MemorySupervision machines={[studio, boundedLaptop]} now={now} ready={true} />,
    );
    expect(markup).toContain("Summary coverage on Laptop");
    expect(markup).toContain("spaces, peer actions");
    expect(markup).toContain("absence does not prove non-enrollment");
    expect(markup).not.toContain("Laptop did not report enrollment");
  });
});
