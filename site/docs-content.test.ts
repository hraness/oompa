import { describe, expect, test } from "bun:test";

import { parseCli } from "../src/cli/parser.ts";
import { findSection, publicContent, type ContentBlock, type InlineContent } from "./content.ts";
import {
  docsPages,
  docsPathForSection,
  docsPaths,
  docsReferenceSections,
  findDocsPage,
  renderDocsMarkdown,
  type DocsPage,
  type DocsPath,
} from "./docs-content.ts";

function pageAt(path: DocsPath): DocsPage {
  const page = findDocsPage(path);
  if (page === undefined) throw new Error(`Missing guide: ${path}`);
  return page;
}

const inlineText = (parts: readonly InlineContent[]): string =>
  parts.map((part) => part.kind === "link" ? part.label : part.value).join("");

function blockText(block: ContentBlock): string {
  switch (block.kind) {
    case "commands": return block.commands.join("\n");
    case "list": return block.items.map(inlineText).join("\n");
    case "ordered-list": return block.items.map((item) =>
      [inlineText(item.content), ...(item.commands ?? []), inlineText(item.afterCommands ?? [])].join("\n"),
    ).join("\n");
    case "subheading": return block.text;
    case "notice": return `${block.label}: ${inlineText(block.content)}`;
    case "paragraph": return inlineText(block.content);
  }
}

const pageText = (page: DocsPage): string =>
  [page.title, page.description, ...page.sections.flatMap((section) =>
    [section.heading, ...section.blocks.map(blockText)],
  )].join("\n");

function blockLinks(block: ContentBlock): readonly string[] {
  const links = (parts: readonly InlineContent[]): readonly string[] =>
    parts.flatMap((part) => part.kind === "link" ? [part.href] : []);
  switch (block.kind) {
    case "commands":
    case "subheading": return [];
    case "list": return block.items.flatMap(links);
    case "ordered-list": return block.items.flatMap((item) =>
      [...links(item.content), ...links(item.afterCommands ?? [])],
    );
    case "notice":
    case "paragraph": return links(block.content);
  }
}

describe("task-oriented documentation content", () => {
  test("admits one maintained page for each distinct reader task", () => {
    expect(docsPaths).toEqual([
      "/docs/", "/docs/start/", "/docs/web/", "/docs/sessions/", "/docs/reference/", "/docs/status/",
    ]);
    expect(new Set(docsPages.map((page) => page.title)).size).toBe(docsPages.length);
    expect(new Set(docsPages.map((page) => page.admission.readerJob)).size).toBe(docsPages.length);
    expect(new Set(docsPages.map((page) => page.admission.contribution)).size).toBe(docsPages.length);
    for (const page of docsPages) {
      expect(page.sections.length).toBeGreaterThan(0);
      expect(new Set(page.sections.map((section) => section.id)).size).toBe(page.sections.length);
      expect(page.keywords.length).toBeGreaterThan(0);
      expect(page.admission.owner).toBe("Hraness");
      expect(page.admission.decision).toBe("keep");
      expect(page.admission.checkedOn).toBe(page.reviewDate);
      expect(page.admission.evidence.length).toBeGreaterThan(1);
      expect(page.admission.overlapDecision.length).toBeGreaterThan(0);
      expect(page.admission.scores.every((score) => score > 0 && score <= 2)).toBe(true);
      expect(page.admission.scores.reduce((sum, score) => sum + score, 0)).toBeGreaterThanOrEqual(9);
      const reviewWindow = Date.parse(page.admission.reassessOn) - Date.parse(page.admission.checkedOn);
      expect(reviewWindow).toBeGreaterThan(0);
      expect(reviewWindow).toBeLessThanOrEqual(60 * 24 * 60 * 60 * 1_000);
      expect(pageText(page)).not.toContain("\u2014");
    }
    expect(findDocsPage("/docs/unknown/")).toBeUndefined();
  });

  test("retains one exact owner for every legacy reference section and privacy", () => {
    const referenced = docsPages.flatMap((page) => page.referenceSectionIds);
    expect(new Set(referenced).size).toBe(referenced.length);
    expect([...referenced, "privacy"].sort()).toEqual(publicContent.sections.map((section) => section.id).sort());
    for (const page of docsPages) {
      expect(docsReferenceSections(page)).toEqual(page.referenceSectionIds.map((id) =>
        findSection(publicContent, id),
      ));
      for (const id of page.referenceSectionIds) expect(docsPathForSection(id)).toBe(`${page.path}#${id}`);
    }
    expect(docsPathForSection("privacy")).toBe("/privacy/");
    expect(() => docsPathForSection("missing-section")).toThrow("No documentation page owns section");
    expect(pageAt("/docs/").referenceSectionIds).toEqual([]);
    expect(pageAt("/docs/start/").referenceSectionIds).toEqual(["first-account", "first-session"]);
    expect(docsPathForSection("project")).toBe("/docs/status/#project");
    expect(pageAt("/docs/reference/").referenceSectionIds).toContain("command-reference");
    expect(pageAt("/docs/status/").referenceSectionIds).toContain("install-and-update");
  });

  test("resolves every guide link and fragment to an owned page or HTTPS source", () => {
    for (const page of docsPages) {
      const links = [
        ...page.related.map((item) => item.path),
        ...page.sections.flatMap((section) => section.blocks.flatMap(blockLinks)),
      ];
      for (const href of links) {
        if (href === "/privacy/") continue;
        if (href.startsWith("https://")) {
          expect(new URL(href).username).toBe("");
          expect(new URL(href).password).toBe("");
          continue;
        }
        const [path, fragment] = href.split("#");
        const target = findDocsPage(path ?? "");
        expect(target).toBeDefined();
        if (fragment !== undefined) {
          expect([
            ...target!.sections.map((section) => section.id),
            ...target!.referenceSectionIds,
          ]).toContain(fragment);
        }
      }
    }
  });

  test("states artifact admission before its install command and preserves the blocked-startup prerequisite", () => {
    const page = pageAt("/docs/start/");
    const blocks = page.sections.flatMap((section) => section.blocks);
    expect(blocks[0]).toMatchObject({ kind: "notice", label: "Candidate artifact not yet admitted" });
    expect(blockText(blocks[0]!)).toContain(publicContent.installNotice);
    expect(blockLinks(blocks[0]!)).toContain(publicContent.links.admittedInstall);
    expect(blockText(blocks[0]!)).toContain("This release candidate is not yet admitted");
    expect(blockText(blocks[0]!)).toContain("for v0.8.4");
    expect(blockText(blocks[0]!)).toContain("Neither artifact admission nor installation authorizes daemon startup.");
    expect(blockLinks(blocks[0]!)).toContain("https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v084-artifacts");
    expect(blocks[1]).toEqual({ kind: "commands", commands: [publicContent.installCommand] });
    const text = pageText(page);
    expect(text.indexOf("Candidate artifact not yet admitted")).toBeLessThan(text.indexOf(publicContent.installCommand));
    expect(text.indexOf(publicContent.installCommand)).toBeLessThan(text.indexOf(publicContent.doctorCommand));
    expect(text.indexOf(publicContent.installNotice)).toBeLessThan(text.indexOf(publicContent.installCommand));
    expect(text).not.toContain("You can install and check v0.8.4 now");
    expect(text.indexOf(publicContent.doctorCommand)).toBeLessThan(text.indexOf(publicContent.initCommand));
    const noticeIndex = blocks.findIndex((block) => block.kind === "notice"
      && blockText(block).includes("Initialization, daemon startup, and hosted command writers remain blocked on capacity"));
    const initIndex = blocks.findIndex((block) => block.kind === "commands" && block.commands.includes(publicContent.initCommand));
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(initIndex);
    expect(text).toContain("It does not start the daemon");
    expect(text).toContain("Managed Claude login and execution are not available on macOS");
    const start = page.sections.find((section) => section.id === "open-a-conversation");
    expect(start?.blocks.map(blockText).join("\n")).toContain("oompa session start personal --provider claude --preset fable-max");
    expect(parseCli(["session", "start", "personal", "--provider", "claude", "--preset", "fable-max"])).toMatchObject({ kind: "command", command: { kind: "session.start", provider: "claude", preset: "fable-max" } });
    const status = pageText(pageAt("/docs/status/"));
    expect(status).toContain(publicContent.daemonRolloutNotice);
    expect(status).toContain("v0.8.5 is a candidate. v0.8.4 remains admitted.");
    expect(status).toContain(publicContent.installNotice);
    expect(status).toContain("The v0.8.4 CLI passed immutable GitHub and exact-byte npm artifact admission.");
    expect(status).not.toContain("npm mirror is not admitted");
    expect(status).not.toContain("v0.8.4 is released");
  });

  test("puts machine sign-in formats before browser enrollment", () => {
    const pairing = pageAt("/docs/web/").sections.find((section) => section.id === "pair-your-browser");
    if (pairing === undefined) throw new Error("Missing browser pairing instructions.");
    const signInIndex = pairing.blocks.findIndex((block) =>
      blockLinks(block).includes("/docs/web/#cloud-sign-in-and-device-pairing"),
    );
    const browserIndex = pairing.blocks.findIndex((block) => blockLinks(block).some((href) => href === "https://app.oompa.app/"));
    expect(signInIndex).toBeGreaterThan(-1);
    expect(browserIndex).toBeGreaterThan(signInIndex);
    const instructions = blockText(pairing.blocks[signInIndex]!);
    expect(instructions).toContain("one protected JSON document");
    expect(instructions).toContain("Complete machine sign-in before enrolling the browser");
  });

  test("teaches actual browser actions without granting browser device or provider authority", () => {
    const text = pageText(pageAt("/docs/web/"));
    expect(text).toContain("app.oompa.app");
    const hold = text.indexOf("Initialization, daemon startup, and hosted command writers remain blocked on capacity");
    expect(hold).toBeGreaterThan(-1);
    expect(hold).toBeLessThan(text.indexOf("oompa auth login --input-stdin"));
    expect(hold).toBeLessThan(text.indexOf("oompa device approve"));
    expect(text).toContain("A browser cannot be the first device on an account or approve another device");
    expect(text).toContain("oompa device approve <pending-device-id-or-prefix> --fingerprint <value>");
    expect(text).toContain("Email access alone cannot recover encrypted history");
    expect(text).toContain("write a prompt in the start box and choose a machine");
    expect(text).toContain("Follow-up prompts belong in the conversation card");
    expect(text).toContain("Earlier completed responses start collapsed");
    expect(text).toContain("Shift+Enter adds a line");
    expect(text).toContain("opens your synchronized sessions automatically");
    for (const retired of ["Open a card", "approved and unlocked", "With a session selected", "offers model presets"]) {
      expect(text).not.toContain(retired);
    }
    expect(text).toContain("multiple-choice question can be answered here");
    expect(text).toContain("accepting them, granting permission, typing a free-text or Other answer, and completing MCP forms stay on the execution machine");
    expect(text).toContain("Scheduled tasks are read-only here");
    expect(text).toContain("oompa remote allow account-linking");
    expect(text).toContain("Claude sign-in stays in a foreground terminal on Linux");
    expect(text).not.toContain("approvals and autonomy do not read this schedule");
  });

  test("keeps Codex quota, provider switching, and uncertain recovery boundaries explicit", () => {
    const text = pageText(pageAt("/docs/sessions/"));
    expect(text).toContain("Claude exposes sign-in status, not account quotas or usage history");
    expect(text).toContain("does not pool subscription limits or automatically move a failed turn");
    expect(text).toContain("native thread, hidden state, and cached context do not transfer");
    expect(text).toContain("only after outstanding memory submissions settle");
    expect(text).toContain("purges the old working lane and starts a fresh empty epoch");
    expect(text).toContain("does not carry working-memory contents across accounts");
    expect(text).toContain("remains recoverable before the session is rebound");
    expect(text).not.toContain("cannot switch to another account profile");
    expect(text).toContain("An ambiguous result needs inspection, not a new send");
    expect(text).toContain("ends Oompa's local session with provider state still unknown");
    expect(text).toContain("data.eventStream.cursor");
    expect(text).toContain("--cursor <status-cursor> --jsonl");
  });

  test("uses parsed help entry points and documents supported structured output", () => {
    const page = pageAt("/docs/reference/");
    const first = page.sections[0]!.blocks[0];
    expect(first).toEqual({ kind: "commands", commands: ["oompa --help", "oompa session --help", "oompa help session send"] });
    expect(parseCli(["--help"])).toMatchObject({ kind: "help" });
    expect(parseCli(["session", "--help"])).toMatchObject({ kind: "help", group: "session" });
    expect(parseCli(["help", "session", "send"])).toMatchObject({ kind: "help", group: "session", leaf: "send" });
    const text = pageText(page);
    expect(text).toContain("Supported one-shot commands use --json");
    expect(text).toContain("Read stdout as data and stderr as diagnostics");
    expect(text).toContain("protected interaction documents never belong in command-line arguments");
    expect(text).not.toContain("Every command");
  });

  test("publishes the full owned reference in Markdown without restoring a homepage dump", () => {
    for (const page of docsPages) {
      const markdown = renderDocsMarkdown(page.path);
      expect(markdown).toStartWith(`# ${page.title}\n\n${page.description}\n`);
      for (const section of [...page.sections, ...docsReferenceSections(page)]) {
        expect(markdown).toContain(`## ${section.heading}\n`);
        for (const block of section.blocks) {
          if (block.kind === "commands") {
            for (const command of block.commands) expect(markdown).toContain(command);
          }
        }
      }
      expect(markdown).toEndWith("\n");
    }
    expect(renderDocsMarkdown("/docs/reference/")).toContain("## Command reference\n");
    expect(renderDocsMarkdown("/docs/status/")).toContain(publicContent.daemonRolloutNotice);
    expect(renderDocsMarkdown("/docs/")).not.toContain("## Command reference\n");
    expect(() => renderDocsMarkdown("/docs/unknown/")).toThrow("Unknown documentation page");
  });
});
