import { describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { findSection, publicContent, type PublicContent } from "./content.ts";
import { findDocsPage, type DocsPath } from "./docs-content.ts";
import { renderMarketingHeader, renderMarketingPage } from "./marketing.tsx";
import { productHeroClassName } from "./marketing.stylex.ts";
import { sitePresentationClasses } from "./presentation.stylex.ts";
import { productPreviewDisclosure, productScenes } from "./product-scenes.ts";
import { renderDocsHtml } from "./template.ts";

function guideDocument(path: DocsPath) {
  const page = findDocsPage(path);
  if (page === undefined) throw new Error(`Missing guide: ${path}`);
  return parseHTML(renderDocsHtml(page)).document;
}

function classNames(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Expected nonempty rendered class names.");
  return value.split(" ");
}

describe("public server marketing composition", () => {
  test("keeps product, task guides, availability and the app discoverable in the native header", () => {
    for (const currentPath of ["/", "/privacy/", "/docs/", "/docs/web/"] as const) {
      const { document } = parseHTML(renderMarketingHeader(publicContent, currentPath));
      const header = document.querySelector("header");
      expect(header?.getAttribute("data-hraness-marketing")).toBe("header");
      expect(header?.querySelector(".hraness-marketing-header__brand")?.textContent).toBe(`🟠 ${publicContent.productName}`);
      expect(header?.querySelector(".hraness-marketing-header__brand")?.getAttribute("href")).toBe("/");
      const links = [...document.querySelectorAll('nav[aria-label="Site"] > a')];
      expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
        ["/#product-preview", "Product"], ["/docs/", "Docs"], ["/docs/status/", "Status"],
        [publicContent.links.github, "GitHub"],
      ]);
      expect(links.filter((link) => link.getAttribute("aria-current") === "page").map((link) => link.textContent))
        .toEqual(currentPath === "/" ? ["Product"] : currentPath.startsWith("/docs/") ? ["Docs"] : []);
      expect(header?.querySelector(".hraness-marketing-header__actions > a")?.getAttribute("href")).toBe(publicContent.links.app);
      expect(header?.querySelector(".hraness-marketing-header__actions > a")?.textContent).toBe("Open Oompa");
      expect(document.querySelector("[style], style, script")).toBeNull();
    }
  });

  test("leads with the real interface and keeps procedural reference out of the marketing composition", () => {
    const html = renderMarketingPage(publicContent);
    const { document } = parseHTML(html);
    const page = document.querySelector('[data-hraness-marketing="page"]');
    expect(page).not.toBeNull();
    expect([...page!.children].map((child) => child.getAttribute("data-hraness-marketing")))
      .toEqual(["hero", "pillars", "section", "trust", "questions", "maker", "cta"]);
    expect(document.querySelector("#reference, #command-reference, [data-hraness-marketing=install]")).toBeNull();
    expect(html).not.toContain(publicContent.installCommand);
    expect(html).not.toContain(publicContent.initCommand);
    expect(document.querySelector("[style], style, script")).toBeNull();
    expect(document.querySelector("h1")?.id).toBe("oompa-title");
    expect(document.querySelector("h1")?.textContent).toBe(publicContent.hero.heading);
    expect(document.querySelectorAll("h1")).toHaveLength(1);
    const heroClasses = classNames(document.querySelector('[data-hraness-marketing="hero"]')?.className);
    for (const name of classNames(productHeroClassName())) expect(heroClasses).toContain(name);
    expect(document.querySelector(".hraness-marketing-hero__example")).toBeNull();
    expect(document.querySelector(".hraness-marketing-facts")).toBeNull();
    expect(document.querySelector(".hraness-marketing-pillars")?.children).toHaveLength(3);
    expect([...document.querySelectorAll(".hraness-marketing-pillars__summary")].map((node) => node.textContent))
      .toEqual(publicContent.hero.pillars.map((pillar) => pillar.summary));
  });

  test("keeps activation warnings beside examples and exact setup commands in their owning guide", () => {
    const { document } = parseHTML(renderMarketingPage(publicContent));
    const notice = document.querySelector('.hraness-marketing-hero__copy a[href="/docs/status/"]')?.parentElement;
    expect(notice?.textContent).toContain("New machine setup is temporarily paused.");
    expect(notice?.textContent).toContain("This release candidate is not yet admitted");
    const admitted = parseHTML(renderMarketingPage({ ...publicContent, releaseVersion: "0.8.3" })).document;
    expect(admitted.querySelector(".hraness-marketing-hero__copy")?.textContent).toContain("The v0.8.3 CLI artifact is admitted for installation");
    expect(document.querySelector(".hraness-marketing-cta__summary")?.textContent).toContain("unavailable install command");
    expect(notice?.textContent).toContain("current daemon and hosted command-writer rollout remains blocked on capacity");
    expect(notice?.querySelector("a")?.textContent).toBe("Check current availability");
    expect(notice?.querySelector("strong")?.textContent).toBe("New machine setup is temporarily paused.");
    const flow = document.querySelector("#how-it-works");
    expect(flow?.querySelector('a[href="/docs/start/"]')?.parentElement?.textContent)
      .toBe("These commands run only on an initialized, authorized machine after the capacity rollout prerequisites are satisfied. Complete setup first.");
    const flowText = flow?.textContent ?? "";
    expect(flowText.indexOf("initialized, authorized machine")).toBeLessThan(flowText.indexOf(publicContent.hero.steps[0]!.command));
    const setup = guideDocument("/docs/start/");
    const commandBlocks = [...setup.querySelectorAll("main pre")];
    const installNotice = setup.querySelector('aside[aria-label="Candidate artifact not yet admitted"]');
    expect(installNotice?.textContent).toContain(publicContent.installNotice);
    expect(installNotice?.querySelector("a")?.getAttribute("href")).toBe(publicContent.links.admittedInstall);
    expect(installNotice?.nextElementSibling).toBe(commandBlocks[0]);
    expect(commandBlocks[0]?.textContent).toBe(publicContent.installCommand);
    const admissionNotice = setup.querySelector('aside[aria-label="Candidate artifact not yet admitted"]');
    expect(admissionNotice).not.toBeNull();
    expect(admissionNotice?.textContent).toContain("This release candidate is not yet admitted");
    expect(admissionNotice?.textContent).toContain("Neither artifact admission nor installation authorizes daemon startup.");
    expect(admissionNotice?.querySelector('a[href="https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v083-artifacts"]')?.getAttribute("href")).toBe("https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v083-artifacts");
    expect(admissionNotice?.nextElementSibling).toBe(commandBlocks[0]);
    for (const command of [publicContent.installCommand, publicContent.doctorCommand, publicContent.initCommand]) {
      expect(commandBlocks.some((block) => block.textContent.split("\n").includes(command))).toBe(true);
    }
    for (const block of commandBlocks) expect(block.getAttribute("tabindex")).toBe("0");
    const setupNotice = setup.querySelector('aside[aria-label="Before you start a daemon"]');
    expect(setupNotice).not.toBeNull();
    expect(setupNotice?.textContent).toContain("Initialization, daemon startup, and hosted command writers remain blocked on capacity.");
    expect(setupNotice?.querySelector("a")?.getAttribute("href")).toBe("/docs/status/#install-and-update");
    const setupText = setup.querySelector("main")?.textContent ?? "";
    expect(setupText.indexOf(setupNotice!.textContent)).toBeLessThan(setupText.indexOf(publicContent.initCommand));
    expect(guideDocument("/docs/status/").querySelector('aside[aria-label="Current runtime hold"]')?.textContent)
      .toContain(publicContent.daemonRolloutNotice);
    const firstSession = findSection(publicContent, "first-session").blocks.find((block) => block.kind === "commands");
    if (firstSession?.kind !== "commands") throw new Error("Missing public first-session commands.");
    const firstSessionGuide = guideDocument("/docs/start/");
    expect([...firstSessionGuide.querySelectorAll("#first-session pre")].map((node) => node.textContent))
      .toContain(firstSession.commands.join("\n"));
    expect([...document.querySelectorAll(".hraness-marketing-flow__code")].map((node) => node.textContent))
      .toEqual(publicContent.hero.steps.map((step) => step.command));
  });

  test("keeps every published marketing collection, action and summary attached to its native role", () => {
    const { document } = parseHTML(renderMarketingPage(publicContent));
    const textAt = (selector: string) => document.querySelector(selector)?.textContent;
    const textsAt = (selector: string) => [...document.querySelectorAll(selector)].map((node) => node.textContent);
    expect(document.querySelectorAll(".hraness-marketing-hero__eyebrow")).toHaveLength(0);
    for (const [role, text] of [
      ["name", publicContent.productName], ["heading", publicContent.hero.heading],
      ["summary", publicContent.hero.summary], ["boundary", publicContent.hero.boundary],
    ]) expect(textAt(`.hraness-marketing-hero__${role}`)).toBe(text);
    expect(textsAt(".hraness-marketing-pillars__label")).toEqual(publicContent.hero.pillars.map((pillar) => pillar.label));
    expect(textAt("#how-it-works-heading")).toBe(publicContent.hero.proofLabel);
    expect(textsAt(".hraness-marketing-flow__label")).toEqual(publicContent.hero.steps.map((step) => step.label));
    expect(textsAt(".hraness-marketing-flow__detail")).toEqual(publicContent.hero.steps.map((step) => step.detail));
    expect(textsAt(".hraness-marketing-trust-item__label")).toEqual(publicContent.trust.map((item) => item.label));
    expect(textsAt(".hraness-marketing-trust-item__detail")).toEqual(publicContent.trust.map((item) => item.detail));
    expect(textAt(".hraness-marketing-trust__summary"))
      .toBe("The browser gives you a view of the work. Execution stays with the provider tools on the machine you chose.");
    expect(textsAt("#questions details > summary")).toEqual(publicContent.questions.map((question) => question.question));
    expect(textsAt(".hraness-marketing-question__answer")).toEqual(publicContent.questions.map((question) =>
      question.answer.map((part) => part.kind === "link" ? part.label : part.value).join("")));
    expect(textAt("#maker-heading")).toBe(publicContent.maker.heading);
    expect([...document.querySelectorAll(".hraness-marketing-maker__links a")].map((node) => [node.getAttribute("href"), node.textContent]))
      .toEqual(publicContent.maker.links.map((link) => [link.href, link.label]));
    const actionsAt = (selector: string) => [...document.querySelectorAll(selector)]
      .map((node) => [node.getAttribute("href"), node.textContent, node.getAttribute("data-emphasis")]);
    expect(actionsAt(".hraness-marketing-hero__actions > a")).toEqual([
      [publicContent.hero.primaryAction.href, publicContent.hero.primaryAction.label, "primary"],
      [publicContent.hero.secondaryAction.href, publicContent.hero.secondaryAction.label, "secondary"],
    ]);
    expect(actionsAt(".hraness-marketing-cta__actions > a")).toEqual([
      ["/docs/start/", "Set up your first machine", "primary"],
      [publicContent.links.app, "Open Oompa", "secondary"],
    ]);
    expect(textAt(".hraness-marketing-cta__summary")).toBe("The setup guide starts with the admitted predecessor and this candidate's unavailable install command. Wait for exact artifact admission and the capacity rollout prerequisites before starting a new machine.");
    expect(textAt(".hraness-marketing-cta__footnote")).toBe(publicContent.hero.boundary);
  });

  test("styles FAQ and Maker link-list anchors without restyling the Maker bio or adding focus overrides", () => {
    const sample: PublicContent = {
      ...publicContent,
      maker: {
        ...publicContent.maker,
        bio: [{ kind: "text", value: "Built by " }, { kind: "link", label: "Maker", href: "https://example.test/maker" }, { kind: "code", value: "safe <text>" }],
        links: [{ label: "Site", href: "https://example.test/site" }],
      },
      questions: [{ question: "A native question?", answer: [{ kind: "link", label: "Answer", href: "https://example.test/answer" }] }],
    };
    const { document } = parseHTML(renderMarketingPage(sample));
    expect(document.querySelector(".hraness-marketing-maker__body > p > a")?.hasAttribute("class")).toBe(false);
    expect(document.querySelector(".hraness-marketing-maker__body > p > code")?.textContent).toBe("safe <text>");
    expect(document.querySelector(".hraness-marketing-maker__links a")?.getAttribute("class")).toBe(sitePresentationClasses("proseLink"));
    expect(document.querySelector(".hraness-marketing-question__answer a")?.getAttribute("class")).toBe(sitePresentationClasses("proseLink"));
    expect(document.querySelectorAll("#questions details > summary")).toHaveLength(1);
    expect(document.querySelector("#questions details > summary")?.textContent).toBe("A native question?");
    expect(document.querySelector("#questions details")?.hasAttribute("open")).toBe(false);
    expect(document.querySelector("[style], style, script")).toBeNull();
  });

  test("escapes ordinary product text without depending on the long-form reference", () => {
    const heading = '<script data-untrusted="true">not markup</script>';
    const { document } = parseHTML(renderMarketingPage({ ...publicContent, hero: { ...publicContent.hero, heading } }));
    expect(document.querySelector("h1")?.textContent).toBe(heading);
    expect(document.querySelector("script")).toBeNull();
    expect(renderMarketingPage({ ...publicContent, sections: [] })).toBe(renderMarketingPage(publicContent));
  });

  test("gives the real-interface preview native controls, an accessible explanation and a written-guide fallback", () => {
    const { document } = parseHTML(renderMarketingPage(publicContent));
    const preview = document.querySelector("figure#product-preview[data-product-preview]");
    expect(preview).not.toBeNull();
    expect(document.querySelectorAll(".hraness-marketing-hero__frame")).toHaveLength(1);
    expect(preview?.querySelector("figcaption")?.textContent).toContain(productPreviewDisclosure);
    expect(preview?.querySelector("[data-preview-description]")?.textContent).toBe(productScenes.overview.description);
    expect(preview?.querySelector("[data-preview-guide]")?.getAttribute("href")).toBe(productScenes.overview.guide);
    expect(preview?.querySelectorAll("button[data-preview-view]")).toHaveLength(4);
    expect(preview?.querySelectorAll("button[data-preview-view][disabled]")).toHaveLength(4);
    expect(preview?.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(preview?.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(preview?.querySelector("iframe")?.getAttribute("aria-hidden")).toBe("true");
    expect(preview?.querySelector("iframe")?.getAttribute("tabindex")).toBe("-1");
    expect(preview?.querySelector("figcaption")?.textContent).toContain("Screen controls need JavaScript. The written guides cover each workflow.");
    expect(document.querySelector("[style], style, script")).toBeNull();
  });
});
