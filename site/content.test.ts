import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";

import {
  HRANESS_HOME_URL,
  hranessSocialLinks,
} from "@hraness/site-footer";

import {
  buildOompaGlobalInstallCommand,
  OOMPA_INSTALL_PREFLIGHT_SOURCE_URL,
} from "../src/install-preflight";
import { helpGroupNames, usageForGroup } from "../src/cli/parser";
import packageJson from "../package.json";
import {
  admittedReleaseVersion,
  hostedSignupCopy,
  isAdmittedRelease,
  publicContent,
  publicPins,
  publicReleaseState,
  renderLlmsText,
  renderMarkdownBlocks,
  renderPrivacyMarkdown,
  renderSitemapXml,
  siteDocumentPaths,
} from "./content.ts";
import { docsPages, docsPathForSection, docsPaths, findDocsPage, renderDocsMarkdown, type DocsPath } from "./docs-content.ts";
import {
  oompaMailingListConfig,
  renderOompaAnalyticsScript,
  renderOompaSiteFooter,
  renderDocsHtml,
  renderPreviewHtml,
  renderPrivacyHtml,
  renderSiteHtml,
} from "./template.ts";

const htmlText = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

// Test-only document text, not a sanitizer or computed-visibility check. Keep
// adjacent documents in order and never reinterpret decoded text as markup.
const htmlVisibleText = (value: string): string => [...parseHTML(value).document.childNodes]
  .filter((node) => node.nodeType === node.ELEMENT_NODE || node.nodeType === node.TEXT_NODE)
  .map((node) => node.textContent ?? "")
  .join("");

function oneElement(html: string, selector: string) {
  const elements = parseHTML(html).document.querySelectorAll(selector);
  expect(elements).toHaveLength(1);
  const element = elements[0];
  if (element === undefined) throw new Error(`Missing semantic element: ${selector}`);
  return element;
}

function expectCompiledClasses(element: Element): void {
  expect([...element.classList].some((name) => /^x[a-z0-9]+$/u.test(name))).toBe(true);
  expect(element.hasAttribute("style")).toBe(false);
}

function elementPosition(html: string, selector: string): number {
  const { document } = parseHTML(html);
  const matches = document.querySelectorAll(selector);
  expect(matches).toHaveLength(1);
  const element = matches[0];
  if (element === undefined) throw new Error(`Missing ordered element: ${selector}`);
  const index = [...document.querySelectorAll("*")].indexOf(element);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

const renderDocumentationHtml = (...paths: readonly DocsPath[]): string => paths.map((path) => {
  const page = findDocsPage(path);
  if (page === undefined) throw new Error(`Missing documentation page: ${path}`);
  return renderDocsHtml(page);
}).join("\n");

const renderDocumentationMarkdown = (...paths: readonly DocsPath[]): string =>
  paths.map(renderDocsMarkdown).join("\n");

describe("public content contract", () => {
  test("projects parsed text once without treating escaped markup as elements", () => {
    const first = '<!doctype html><html><head><title>first</title></head><body>'
      + '<p title="attribute > tail">&lt;script&gt;literal&lt;/script&gt; &amp;lt;kept&amp;gt; &quot;&#39;&#x27;</p>'
      + '<!-- hidden comment --><p>last</p></body></html>';
    const second = '<!doctype html><html><body><p>second</p></body></html>';
    const { document } = parseHTML(first);
    expect(document.querySelectorAll("script")).toHaveLength(0);
    expect(htmlVisibleText(first)).toBe('first<script>literal</script> &lt;kept&gt; "\'\'last');
    expect(htmlVisibleText(`${first}\n${second}`)).toBe('first<script>literal</script> &lt;kept&gt; "\'\'last\nsecond');
    expect(htmlVisibleText('before<!-- comment --><span>middle</span>after')).toBe("beforemiddleafter");
  });

  test("binds admitted installation to exact release evidence while preserving the runtime hold", () => {
    expect(publicContent.releaseVersion).toBe("0.8.5");
    expect(admittedReleaseVersion).toBe("0.8.4");
    expect(publicReleaseState).toBe("live");
    expect(publicContent.endpoints.betaTag).toBe("live");
    const llms = renderLlmsText();
    expect(llms).toContain(publicContent.statusLine);
    expect(llms).toContain("Local CLI v0.8.5 is a release candidate, not an admitted artifact; v0.8.4 remains the admitted canonical GitHub artifact.");
    expect(publicContent.links.admittedInstall).toBe("https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v084-artifacts");
    const visibleSite = htmlVisibleText(renderSiteHtml());
    expect(visibleSite).toContain("The admitted v0.8.4 CLI has its own");
    expect(visibleSite).toContain("Starting or upgrading a daemon and enabling hosted commands are paused until the capacity checks pass.");
    for (const surface of [llms, renderDocumentationMarkdown("/docs/status/"), htmlVisibleText(renderDocumentationHtml("/docs/status/"))]) {
      expect(surface).not.toContain("The v0.8.4 candidate is not yet admitted");
      expect(surface).not.toContain("npm mirror is not admitted");
      expect(surface).toContain(publicContent.daemonRolloutNotice);
    }
    const admission = renderMarkdownBlocks(publicContent.introduction, 2);
    expect(admission).toContain("https://github.com/hraness/oompa/actions/runs/35136703343");
    expect(admission).toContain("https://github.com/hraness/oompa/releases/tag/v0.8.4");
    expect(admission).toContain("attempt 1");
    expect(admission).toContain("passed immutable GitHub and exact-byte npm release admission");
    expect(admission).toContain("artifact admission does not authorize current-daemon startup or hosted command writers");
  });

  test("never transfers current admission to another version", () => {
    expect(isAdmittedRelease("0.8.4")).toBe(true);
    expect(renderLlmsText()).toContain("Only after immutable GitHub release admission, install the v0.8.5 local CLI artifact");
    for (const version of ["0.7.0", "0.7.1", "0.7.2", "0.8.1", "0.8.3", "0.8.5", "v0.8.4", "0.8.4-beta.1", ""]) {
      expect(isAdmittedRelease(version)).toBe(false);
    }
    for (const version of ["0.7.2", "0.8.1", "0.8.5"]) {
      const content = { ...publicContent, releaseVersion: version };
      const llms = renderLlmsText(content);
      expect(llms).toContain("This release candidate is not yet admitted.");
      expect(llms).toContain("https://github.com/hraness/oompa/blob/main/docs/beta-release-notes.md#admitted-v084-artifacts");
      expect(llms.indexOf("This release candidate is not yet admitted."))
        .toBeLessThan(llms.indexOf(content.installCommand));
      expect(llms).not.toContain(`Install the admitted v${version} local CLI artifact`);
      expect(llms).toContain("Only after immutable GitHub release admission");
      expect(llms).toContain(content.daemonRolloutNotice);
    }
  });

  test("keeps after-hours consent, legacy reset, and prose limits explicit", () => {
    const readme = renderDocumentationMarkdown("/docs/reference/");
    expect(readme).toContain("After-hours protocol budgets were admitted in v0.6.3.");
    expect(readme).toContain("The v0.7.0 release retains this policy without enabling it.");
    expect(readme).toContain("They use a separate local opt-in, disabled on new and upgraded installations.");
    expect(readme).toContain("After the applicable artifact admission and daemon rollout gates are satisfied");
    expect(readme).toContain("oompa autorespond-after-hours enable --revision <revision>");
    expect(readme).toContain("oompa autorespond-after-hours disable --revision <revision>");
    expect(readme).toContain("Prose always stays at three, ten, and forty.");
    expect(readme).toContain("Both paths spend the same counters.");
    expect(readme).toContain("Policy changes and schedule boundaries never reset or refund them");
    expect(readme).toContain("requires a newly finalized human message for every pre-44 session");
    expect(readme).toContain("an unreadable schedule selects the baseline, while invalid consent or accounting refuses admission");
    expect(readme).not.toContain("Notification hours do not change these eligibility rules or budgets.");
    expect(readme).not.toContain("Protocol and prose share the same limits.");
  });

  test("keeps durable automatic-approval limits and upgrade holds on both public surfaces", () => {
    const readme = renderDocumentationMarkdown("/docs/reference/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/reference/"));
    for (const surface of [readme, html]) {
      expect(surface).toContain("reserves its budget before provider dispatch");
      expect(surface).toContain("pauses automatic approvals for 24 hours");
      expect(surface).toContain("requires a new human message to reopen its consecutive budget");
      expect(surface).toContain("oompa autorespond status --session <session>");
      expect(surface).not.toMatch(/oompa autorespond status`? (?:shows the counters|reports the hold)/u);
      expect(surface).toContain("A newer question or changed authority cancels the stale reply");
    }
  });
  test("publishes the exact Oompa release identity", () => {
    expect(publicContent).toMatchObject({
      doctorCommand: "oompa doctor --offline",
      initCommand: "oompa init --yes",
      installCommand: buildOompaGlobalInstallCommand(
        "https://github.com/hraness/oompa/releases/download/v0.8.5/hraness-oompa-0.8.5.tgz",
      ),
      links: {
        github: "https://github.com/hraness/oompa",
      },
      productName: "Oompa",
      siteUrl: "https://oompa.app",
    });
  });

  test("keeps website positioning and install claims independent of the technical package description", () => {
    const markdown = renderLlmsText();
    expect(markdown.split("\n")[0]).toBe("# Oompa");
    expect(markdown).toContain(publicContent.thesis);
    expect(markdown).toContain(publicContent.statusLine);
    expect(publicContent.statusLine).toContain("Local CLI v0.8.5 is a release candidate, not an admitted artifact");
    expect(publicContent.statusLine).toContain("hosted sync is live as an open beta");
    expect(markdown).toContain(publicContent.installNotice);
    expect(markdown).toContain(publicContent.links.admittedInstall);
    expect(markdown.indexOf(publicContent.installNotice)).toBeLessThan(markdown.indexOf(publicContent.installCommand));
    expect(publicContent.thesis).toContain("browser");
    expect(publicContent.thesis).toContain("terminal");
    expect(publicContent.thesis).toContain("execution on your own machines");
    expect(renderSiteHtml()).toContain(`href="${publicContent.links.app}"`);
    expect(markdown).toContain(`Documentation: ${publicContent.links.documentation}`);
    expect(htmlVisibleText(renderSiteHtml())).toContain(publicContent.hero.summary);
    expect(markdown.indexOf(publicContent.thesis)).toBeLessThan(markdown.indexOf(publicContent.installCommand));
    expect(markdown.indexOf(publicContent.installCommand)).toBeLessThan(markdown.indexOf(publicContent.doctorCommand));
    expect(markdown).toContain(publicContent.daemonRolloutNotice);
    expect(markdown).toContain("/docs/status/");
    expect(htmlVisibleText(renderSiteHtml())).toContain(publicContent.hero.steps[0]!.command);
    expect(packageJson.description).not.toBe(publicContent.description);
    expect(markdown).not.toContain(packageJson.description);
    expect(renderSiteHtml()).not.toContain(packageJson.description);
  });

  test("publishes trust-signal badges pinned to the package manifest", () => {
    expect(publicContent.badges.map((badge) => badge.alt)).toEqual([
      "npm version",
      "provenance: sigstore",
      "CI",
      "license: MIT",
      `Bun ${packageJson.engines.bun}`,
      `runtime: Codex ${packageJson.dependencies["@openai/codex"]}`,
      `runtime: Claude Code ${publicPins.claude}`,
      `runtime: Devin CLI ${publicPins.devin}`,
    ]);
    expect(publicPins).toEqual({
      bun: packageJson.engines.bun,
      claude: "2.1.260",
      codex: packageJson.dependencies["@openai/codex"],
      devin: "3000.10.27",
    });
    for (const badge of publicContent.badges) {
      expect(badge.image).toMatch(/^https:\/\/img\.shields\.io\//u);
      expect(badge.href).toMatch(/^https:\/\//u);
    }
    expect(publicContent.badges[2]?.image).toContain("/hraness/oompa/ci.yml?branch=main");
    expect(publicContent.badges[4]?.image).toBe("https://img.shields.io/badge/Bun-1.3.14-14151a");
    expect(publicContent.badges[5]?.image).toBe("https://img.shields.io/badge/runtime-Codex%200.153.2-0b5fa5");
    expect(publicContent.badges[6]?.image).toBe("https://img.shields.io/badge/runtime-Claude%20Code%202.1.260-6f42c1");
    expect(publicContent.badges[7]?.image).toBe("https://img.shields.io/badge/runtime-Devin%20CLI%203000.10.27-5936b4");
    expect(renderSiteHtml()).not.toContain("img.shields.io");
  });

  test("states one neutral website positioning in JSON-LD, social card, and llms.txt", () => {
    const html = renderSiteHtml();
    const jsonLd = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(jsonLd).toBeDefined();
    const structured = JSON.parse(jsonLd ?? "{}") as Record<string, unknown>;

    expect(publicContent.tagline).toBe("Workspace for Codex and Claude Code");
    expect(publicContent.providerRoadmap).toBe("Codex and Claude Code, side by side.");
    expect(publicContent.description).toContain("workspace for Codex and Claude Code");
    expect(publicContent.description).toContain("browser or terminal");
    expect(structured).toMatchObject({
      "@type": "SoftwareApplication",
      applicationSubCategory: publicContent.tagline,
      author: { "@type": "Organization", name: "Hraness", url: "https://hraness.com/" },
      description: publicContent.description,
      maintainer: { "@type": "Organization", name: "Hraness", url: "https://hraness.com/" },
    });
    expect(structured).not.toHaveProperty("softwareVersion");
    expect(publicContent.description).toContain("v0.8.4 passed GitHub and npm artifact admission");
    expect(publicContent.description).toContain("daemon and hosted command-writer rollout remains blocked on capacity");
    expect(html).toContain('href="/docs/status/"');
    expect(html).toContain(`<title>${publicContent.productName} | ${publicContent.tagline}</title>`);
    expect(parseHTML(html).document.querySelectorAll("p.hraness-marketing-hero__eyebrow")).toHaveLength(0);
    const previewEyebrow = oneElement(renderPreviewHtml(), "p.preview-eyebrow");
    expect(previewEyebrow.textContent).toBe(publicContent.tagline);
    expectCompiledClasses(previewEyebrow);
    expect(publicContent.socialCard).toEqual({
      alt: "Oompa command-line card showing offline diagnostics and read-only status · v0.8.5 candidate · daemon rollout blocked on capacity · oompa.app",
      height: 630,
      path: "/social-card.png",
      width: 1200,
    });
    for (const document of [html, renderPrivacyHtml(), renderPreviewHtml(), renderDocumentationHtml("/docs/")]) {
      expect(document).toContain('<meta property="og:image" content="https://oompa.app/social-card.png">');
      expect(document).toContain('<meta property="og:image:type" content="image/png">');
      expect(document).toContain('<meta property="og:image:width" content="1200">');
      expect(document).toContain('<meta property="og:image:height" content="630">');
      expect(document).toContain(`<meta property="og:image:alt" content="${publicContent.socialCard.alt}">`);
      const ogTitle = /<meta property="og:title" content="([^"]+)">/u.exec(document)?.[1];
      const ogDescription = /<meta property="og:description" content="([^"]+)">/u.exec(document)?.[1];
      expect(ogTitle).toBeDefined();
      expect(ogDescription).toBeDefined();
      expect(document).toContain('<meta name="twitter:card" content="summary_large_image">');
      expect(document).toContain(`<meta name="twitter:title" content="${ogTitle ?? ""}">`);
      expect(document).toContain(`<meta name="twitter:description" content="${ogDescription ?? ""}">`);
      expect(document).toContain('<meta name="twitter:image" content="https://oompa.app/social-card.png">');
      expect(document).not.toContain("social-card.svg");
    }
    const llms = renderLlmsText();
    expect(llms.split("\n")[2]).toBe(`> ${publicContent.description}`);
    expect(llms).toContain(publicContent.thesis);
    expect(llms).toContain(publicContent.statusLine);
    expect(llms.indexOf(publicContent.thesis)).toBeLessThan(llms.indexOf(publicContent.installCommand));
  });

  test("publishes the stable memory, peer, and exact provider surfaces", () => {
    const markdown = renderDocumentationMarkdown("/docs/reference/", "/docs/sessions/");
    const html = renderDocumentationHtml("/docs/reference/", "/docs/sessions/");
    const visibleHtml = htmlVisibleText(html);
    const claims = [
      "Stable working and shared project memory",
      "reads that lane together with durable project memory",
      "shares one attested page only through conflict-checked adoption",
      "oompa memory status|list|get|search|explain|remember|share",
      "Claude Code uses its live provider-neutral projection while the exact controller is present",
      "only after prior-process exit or an already-completed exact process release is proven",
      "Provider-native rename remains Codex-only",
      "Protected full-turn inspection remains Codex-only",
      "For Claude, Oompa admits only the pinned Fable profile and reviewed host-tool boundary",
      "Bound Codex and Claude Code models use closed Oompa tools",
      "Attributed peer coordination",
      "list, inspect, and message only bounded same-project peers",
      "Retired sessions cannot participate",
      "Peer coordination is separate from Work",
      "Changing either policy revokes stale inspection and mutation authority",
      "starts a new turn only for an idle target",
      "records bounded untrusted input for later delivery",
      "addresses one exact active turn and is supported by Codex and Claude Code",
      "Peer input cannot resolve approvals",
      "causal cycles, and a ninth hop",
      "120 new peer actions per actor and per project in a rolling hour",
      "25,000-action project cap fails closed",
      "oompa session start <account> [--project <project>] [--provider <codex|claude|devin>] [--preset <low|high|ultra|fable-max|astra>] [--fast] [--idempotency-key <uuid> [--preset-contract <1|2>]]",
      "oompa session peer-policy get <session> [--json]",
      "oompa session peer-policy set <session> <off|inspect|coordinate> --revision <n> [--json]",
      "oompa session preset <session> <low|high|ultra|fable-max|astra>",
      "oompa session switch <session> --provider <codex|claude> [--preset <low|high|ultra|fable-max>] [--account <account>]",
      "oompa session export <session> [--format <trajectory|json>] [--out <path>]",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(visibleHtml).toContain(claim);
    }
    for (const surface of [markdown, html, renderLlmsText()]) {
      expect(surface).not.toContain("Codex is supported today; Claude is next.");
      expect(surface).not.toContain("Codex today, Claude next.");
      expect(surface).not.toContain("Claude authentication happens outside Oompa");
      expect(surface).not.toContain("Oompa does not expose Claude login");
    }
  });

  test("identifies the product maintainer without repeating a brand explanation", () => {
    expect(publicContent.maintainer).toEqual({ name: "Hraness", url: "https://hraness.com/" });
    const resources = oneElement(renderSiteHtml(), "aside.project-resources");
    expect(resources.textContent).toContain("MIT licensed");
    expect(resources.querySelector('a[href="https://hraness.com/"]')).toBeNull();
    expect(resources.querySelector(`a[href="${publicContent.links.documentation}"]`)).not.toBeNull();
  });

  test("publishes no em dash on any generated public surface", () => {
    for (const [label, surface] of [
      ["PRIVACY", renderPrivacyMarkdown()],
      ["llms.txt", renderLlmsText()],
      ["site", renderSiteHtml()],
      ["privacy page", renderPrivacyHtml()],
      ["preview", renderPreviewHtml()],
      ...docsPages.map((page) => [page.path, renderDocsHtml(page)] as const),
      ...docsPages.map((page) => [`${page.path}index.md`, renderDocsMarkdown(page.path)] as const),
    ] as const) {
      expect(surface, label).not.toContain("\u2014");
    }
  });

  test("leads with a real UI example and sends setup and detailed reference to their guides", () => {
    const html = renderSiteHtml();
    const document = parseHTML(html).document;
    expect(oneElement(html, "h1").textContent).toBe(publicContent.hero.heading);
    expectCompiledClasses(oneElement(html, ".hraness-marketing-hero"));
    expect(oneElement(html, ".hraness-marketing-hero__summary").textContent).toBe(publicContent.hero.summary);
    const example = oneElement(html, "#product-preview");
    expect(example.tagName).toBe("FIGURE");
    expect(example.hasAttribute("data-product-preview")).toBe(true);
    expect(example.querySelector('iframe[src="/examples/app/index.html?view=overview"]')).not.toBeNull();
    expect(elementPosition(html, "#product-preview")).toBeLessThan(elementPosition(html, "#how-it-works"));
    expect(document.querySelector(`a[href="${publicContent.links.app}"]`)).not.toBeNull();
    expect(document.querySelector('a[href="/docs/start/"]')).not.toBeNull();
    expect(document.querySelector('a[href="/docs/status/"]')).not.toBeNull();
    expect(htmlVisibleText(html)).toContain("New machine setup is temporarily paused");
    expect(html).not.toContain("preflight requires GitHub repository ID");
    expect(html).not.toContain("ol.procedure-list");
    expect(document.querySelector("pre.install-command")).toBeNull();
    expect(document.querySelector("pre.init-command")).toBeNull();
    const setup = oneElement(renderDocumentationHtml("/docs/start/"), "#install");
    expect(setup.querySelector("pre")?.textContent).toBe(publicContent.installCommand);
    const flows = [...document.querySelectorAll("code.hraness-marketing-flow__code")];
    expect(flows.map((node) => node.textContent)).toEqual(publicContent.hero.steps.map((step) => step.command));
  });

  test("highlights reference commands while keeping the homepage example code classified", () => {
    const html = renderDocumentationHtml("/docs/reference/");
    const document = parseHTML(html).document;
    const commands = [...document.querySelectorAll("pre.command-list")];
    for (const version of ["v0.8.4"]) {
      const versionCodes = [...document.querySelectorAll("code.oompa-inline-code")].filter((code) => code.textContent === version);
      expect(versionCodes.length).toBeGreaterThan(0);
      for (const code of versionCodes) expectCompiledClasses(code);
    }
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command.getAttribute("tabindex")).toBe("0");
      expectCompiledClasses(command);
      const code = command.querySelectorAll(":scope > code.syntax-code.language-shell");
      expect(code).toHaveLength(1);
      expectCompiledClasses(code[0]!);
    }
    expect(document.querySelectorAll(".syntax-token.syntax-token--command").length).toBeGreaterThan(0);
    const home = parseHTML(renderSiteHtml()).document;
    const flowCodes = [...home.querySelectorAll("code.hraness-marketing-flow__code")];
    expect(flowCodes.map((code) => code.textContent)).toEqual(publicContent.hero.steps.map((step) => step.command));
    for (const code of flowCodes) {
      expectCompiledClasses(code);
      expect(code.children).toHaveLength(0);
    }
    expect(document.querySelectorAll("code:not([class])")).toHaveLength(0);
  });

  test("states admitted artifacts without opening daemon startup in the owning status guide", () => {
    expect(publicReleaseState).toBe("live");
    expect(publicContent.releaseVersion).toBe("0.8.5");
    expect(publicContent.endpoints).toEqual({
      betaTag: "live", githubRepository: "live", hostedSync: "live", website: "live",
    });
    const markdown = renderDocsMarkdown("/docs/status/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/status/"));
    for (const surface of [markdown, html]) {
      expect(surface).toContain("v0.8.4");
      expect(surface).toContain("passed immutable GitHub and exact-byte npm artifact admission");
      expect(surface).not.toContain("The v0.8.4 candidate is not yet admitted");
      expect(surface).not.toContain("The v0.8.0 candidate is not yet admitted");
      expect(surface).not.toContain("v0.8.4 is released");
      expect(surface).toContain("daemon and hosted command-writer rollout remains blocked on capacity");
      expect(surface).toContain("Artifact availability and the live sync service do not clear this gate");
      expect(surface).not.toContain("v0.7.0 candidate");
      expect(surface).not.toContain("v0.7.0 is a release candidate");
      expect(surface).toContain("This release candidate is not yet admitted");
      expect(surface).toContain(publicContent.installNotice);
      expect(surface).toContain("v0.8.4 artifacts admitted");
      expect(surface).not.toContain("v0.8.4 is the fully admitted public artifact");
      expect(surface).not.toContain("beta-not-yet-live");

      expect(surface).not.toContain("Beta not yet live");
    }
    for (const surface of [renderLlmsText(), markdown, renderDocsMarkdown("/docs/start/")]) {
      expect(surface).toContain(publicContent.links.admittedInstall);
      const noticePosition = surface.indexOf(publicContent.installNotice);
      const commandPosition = surface.indexOf(publicContent.installCommand);
      expect(noticePosition).toBeGreaterThanOrEqual(0);
      expect(commandPosition).toBeGreaterThanOrEqual(0);
      expect(noticePosition).toBeLessThan(commandPosition);
    }
    for (const surface of [renderLlmsText()]) {
      expect(surface).toContain("v0.8.4 remains the admitted canonical GitHub artifact");
      expect(surface).toContain(publicContent.daemonRolloutNotice);
      expect(surface).toContain("/docs/status/");
    }
    expect(markdown).toContain("https://github.com/hraness/oompa/releases/tag/v0.8.4");
    expect(markdown).toContain("https://github.com/hraness/oompa/actions/runs/35136703343");
    expect(markdown).toContain("Local v0.8.4 artifacts admitted; hosted sync live as an open beta");
    const reference = renderDocsMarkdown("/docs/reference/");
    expect(reference).toContain("Local release boundary");
    expect(reference).toContain("admitted local CLI release and are retained in the");
    expect(reference).toContain("v0.8.4");
    expect(reference).toContain("v0.8.5");
    expect(reference).toContain("candidate. The predecessor's immutable GitHub artifact and exact-byte npm mirror passed admission; the candidate requires its own admission.");
    expect(renderLlmsText()).toContain("Only after immutable GitHub release admission, install the v0.8.5 local CLI artifact");
    for (const path of ["/docs/start/", "/docs/status/"] as const) {
      const guideHtml = renderDocumentationHtml(path);
      expect(guideHtml).toContain(publicContent.links.admittedInstall);
      const notice = 'aside[aria-label="Candidate artifact not yet admitted"]';
      expect(oneElement(guideHtml, notice).textContent).toContain(publicContent.installNotice);
      const guide = parseHTML(guideHtml).document;
      const firstCommand = guide.querySelector("pre.command-list");
      expect(firstCommand).not.toBeNull();
      expect(elementPosition(guideHtml, notice)).toBeLessThan([...guide.querySelectorAll("*")].indexOf(firstCommand!));
    }
    const notices = [...parseHTML(renderSiteHtml()).document.querySelectorAll("p")]
      .filter((paragraph) => paragraph.textContent.startsWith("New machine setup is temporarily paused"));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.querySelector("a")?.getAttribute("href")).toBe("/docs/status/");
  });

  test("keeps startup prerequisites adjacent to setup without turning the homepage into a runbook", () => {
    const prerequisite = publicContent.daemonRolloutNotice;
    expect(prerequisite).toContain("Do not initialize, start, or autostart");
    expect(prerequisite).toContain("the v0.8.5 daemon or any older daemon");
    expect(prerequisite).toContain("protected two-pass zero-debt capacity evidence and its exact .activated readback receipt");
    expect(prerequisite).toContain("target marker-2 proofs before globally enabling hosted writers");
    const setupHtml = renderDocumentationHtml("/docs/start/");
    const setup = htmlVisibleText(setupHtml);
    expect(setup.indexOf("Initialization, daemon startup, and hosted command writers remain blocked on capacity"))
      .toBeLessThan(setup.indexOf(publicContent.initCommand));
    expect(setup.indexOf(publicContent.doctorCommand)).toBeLessThan(setup.indexOf(publicContent.initCommand));
    expect(oneElement(setupHtml, "#connect-an-account aside.notice").textContent).toContain("before the steps below");
    const llms = renderLlmsText();
    expect(llms.indexOf(prerequisite)).toBeLessThan(llms.indexOf(publicContent.initCommand));
    const home = htmlVisibleText(renderSiteHtml());
    expect(home.indexOf("New machine setup is temporarily paused")).toBeLessThan(home.indexOf(publicContent.hero.steps[0]!.command));
    expect(home).toContain("Complete setup first");
    expect(home).not.toContain(publicContent.initCommand);
  });

  test.each([
    ["first-account", "First account", "oompa account add personal"],
    ["first-session", "First session", "oompa session start personal --provider codex"],
    ["cloud-sign-in-and-device-pairing", "Cloud sign-in and device pairing", "oompa auth login --input-stdin"],
    ["terminal-and-agent-interfaces", "Terminal and agent interfaces", "oompa"],
    ["presets-and-permissions", "Presets and permissions", "oompa init --yes"],
  ])("guards the directly linked %s first-run section before its startup instructions", (id, heading, command) => {
    const section = publicContent.sections.find((entry) => entry.id === id);
    expect(section?.blocks[0]).toEqual({
      kind: "notice",
      label: "Conditional walkthrough",
      content: [{ kind: "text", value: publicContent.daemonRolloutNotice }],
    });
    const path = docsPathForSection(id).split("#")[0]!;
    const page = findDocsPage(path);
    expect(page).toBeDefined();
    const markdownSection = renderDocsMarkdown(path).split(`## ${heading}\n\n`)[1]!.split("\n## ")[0]!;
    const htmlSection = oneElement(renderDocsHtml(page!), `details#${id}`).textContent;
    for (const surface of [markdownSection, htmlSection]) {
      expect(surface).toContain(publicContent.daemonRolloutNotice);
      expect(surface).toContain(command);
      expect(surface.indexOf(publicContent.daemonRolloutNotice)).toBeLessThan(surface.indexOf(command));
    }
  });

  test("states one hosted sign-up claim everywhere and switches it in one place", () => {
    expect(publicContent.hostedSignup).toBe("open");
    for (const surface of [
      renderSiteHtml(),
      renderPrivacyMarkdown(),
    ]) {
      expect(surface).not.toContain("invite-only beta");
    }
    expect(renderPrivacyMarkdown()).toContain(
      "Anyone can create an identity with an email address and a one-time code",
    );
    expect(renderPrivacyMarkdown()).toContain(
      "The hosted sync service is live as an open beta",
    );
    // The invite-only wording is one constant away, and nothing else changes.
    expect(hostedSignupCopy(publicContent.hostedSignup)).toEqual({
      admissionClaim: "Anyone can create an identity with an email address and a one-time code; an invitation is optional.",
      betaLabel: "open beta",
    });
    expect(hostedSignupCopy("invite_only")).toEqual({
      admissionClaim: "The first identity and device were admitted on the production deployment on 2026-09-03; new identities need an invitation from an existing member.",
      betaLabel: "invite-only beta",
    });
  });

  test("publishes protected cloud auth and the exact device-pairing path", () => {
    const markdown = renderDocumentationMarkdown("/docs/web/");
    const html = renderDocumentationHtml("/docs/web/");
    const visibleHtml = htmlVisibleText(html);
    const documents = [
      '{"email":"you@example.com"}',
      '{"email":"you@example.com","invite":"<identity-invite>"}',
      '{"email":"you@example.com","code":"12345678"}',
    ];

    for (const command of [
      "oompa auth login --input-stdin",
      "oompa auth login --input-fd <fd>",
      "oompa auth delete --acknowledge-erasure",
      "oompa device pair",
    ]) {
      expect(markdown).toContain(command);
      expect(visibleHtml).toContain(command);
    }
    for (const document of documents) {
      expect(markdown).toContain(document);
      expect(visibleHtml).toContain(document);
    }
    for (const surface of [markdown, visibleHtml]) {
      expect(surface).not.toContain("auth login --email");
      expect(surface).not.toContain("auth login --code");
    }
    expect(markdown).toContain(
      "oompa device approve <pending-device-id-or-prefix> --fingerprint <value>"
      + " [--idempotency-key <current-uuidv7>]",
    );
    expect(visibleHtml).toContain("oompa device approve <pending-device-id-or-prefix>");
    for (const claim of [
      "oompa device key-loss --acknowledge-no-key-holders",
      "the account key as a closed status",
      "recovery requires an existing account-key holder",
      "no remaining holder makes the encrypted content unrecoverable",
      "authenticated, registered, active installation",
      "current Oompa cloud identity's isolated local custody",
      "current auth token generation, identity, auth epoch, registered device, and pairing observation agree exactly",
      "no network, provider, or cloud mutation",
      "does not mint, replace, or delete a key or ciphertext",
      "fail with a bounded next command",
      "Pairing the real account key later supersedes the observation",
      "Local provider profiles, sessions, credentials, and execution are unaffected",
      "existing encrypted cloud content cannot be decrypted",
      "Search again for an existing holder",
      "the real key restores ready status and supersedes the acknowledgement",
      "Only after that renewed holder search is exhausted",
      "erasing and reinitializing the Oompa cloud account",
      "does not regenerate the lost account key",
      "not the default response to a key-loss acknowledgement",
    ]) {
      expect(markdown).toContain(claim);
      expect(visibleHtml).toContain(claim);
    }
    for (const surface of [markdown, visibleHtml]) {
      expect(surface).toContain("An unset");
      expect(surface).toContain("hosted deployment");
      expect(surface).toContain("explicit empty value");
      expect(surface).toContain("self-managed Convex deployment");
      expect(surface).toContain("permanently binds that local state root");
      expect(surface).toContain("report its exact restart prerequisite");
      expect(surface).toContain("restore the bound URL for a self-managed deployment");
      expect(surface).not.toContain("require an explicit deployment URL");
      expect(surface).toContain("automatically registers the current installation");
      expect(surface).toContain("registered as pending");
      expect(surface).toContain("no synchronized data, execution, or key authority");
      expect(surface).toContain("an uncontested, unrevoked copy can impersonate that device");
      expect(surface).not.toContain("device pair` to create a pending device request");
      expect(surface).not.toContain("device pair</code> to create a pending device request");
    }
    for (const surface of [markdown, visibleHtml]) {
      expect(surface).toContain("capability-only progress");
      expect(surface).toContain("does not delete local provider profiles");
      expect(surface).not.toContain("account deletion remains a launch gate and must be implemented");
    }
  });

  test("publishes exact lost-login recovery without retaining provider credentials", () => {
    const markdown = renderDocumentationMarkdown("/docs/start/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/start/"));
    for (const surface of [markdown, html]) {
      expect(surface).toContain("the daemon restarts before completion");
      expect(surface).toContain("oompa account show personal");
      expect(surface).toContain("oompa account login-cancel");
      expect(surface).toContain("exact current-generation provider login");
      expect(surface).toContain("Verification URLs and user codes never enter local durable Oompa state, logs, or ordinary command output");
      expect(surface).toContain("account-key-encrypted, one-read hosted result");
      expect(surface).toContain("always selects device-code mode");
      expect(surface).toContain("--handoff-file /absolute/private/login.json --json");
      expect(surface).toContain("A same-key replay never claims or rewrites a handoff");
      expect(surface).toContain("after completion or cancellation it reports the terminal account state");
      expect(surface).toContain("oompa account login personal --provider claude");
      expect(surface).toContain("CLAUDE_CONFIG_DIR");
      expect(surface).toContain("Claude exposes no Oompa device-code, handoff-file, or web-linking protocol");
      expect(surface).toContain("retains the one-child fence even if Claude reports signed in");
      expect(surface).toContain("After confirming that original child has exited");
      expect(surface).toContain("recovery does not stop Claude or read, change, or delete a credential");
      expect(surface).not.toContain("Oompa does not implement Claude Code sign-in");
    }
  });

  test("publishes the exact Devin runtime, login, and usage boundaries", () => {
    const markdown = renderDocumentationMarkdown("/docs/start/", "/docs/sessions/", "/docs/status/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/start/", "/docs/sessions/", "/docs/status/"));
    const claims = [
      "oompa account login personal --provider devin",
      "--manual-token-flow",
      "devin auth login",
      "devin auth status",
      "devin acp --model gpt-6-astra",
      "Devin effects also run on both platforms",
      "Devin ACP session usage reports current context occupancy and capacity",
      "cumulative provider cost only when Devin supplies it",
      "never applies a Codex reset credit to Devin",
      "never sends concurrent prompts to one Devin session",
    ];
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
  });

  test("preserves the adopted provider-usage boundary in its owning guides' Markdown and HTML", () => {
    for (const surface of [renderDocumentationMarkdown("/docs/start/", "/docs/sessions/", "/docs/status/"), htmlVisibleText(renderDocumentationHtml("/docs/start/", "/docs/sessions/", "/docs/status/"))]) {
      expect(surface).toContain("Automatic account movement is not exposed yet.");
      expect(surface).toContain("Explicit sessions and work tasks stay pinned to the account you selected.");
      expect(surface).toContain("Claude and Devin accounts never rotate automatically, and Oompa never replays a failed or ambiguous turn under another account.");
      expect(surface).toContain("The separately adopted provider-usage contract permits bounded managed Codex movement only under fresh local authority; explicit sessions, work tasks, Claude accounts, and cross-machine execution remain outside that boundary.");
      expect(surface).not.toContain("rotates accounts to evade a provider limit");
    }
  });

  test("publishes an explicit read-only plugin boundary", () => {
    const claims = [
      "oompa plugin list <account> [--project <project>] [--refresh]",
      "oompa plugin show <account> <plugin> [--project <project>] [--refresh]",
      "Plugin commands are read-only discovery.",
      "Pinned Codex 0.153.2 has no safely separated install, enablement, and OAuth lifecycle surface",
      "Oompa therefore does not expose plugin install, enable, disable, OAuth, or permission effects.",
      "The pinned tool-suggestion form that can invoke that compound plugin or connector lifecycle is also rejected before admission.",
      "Other standard MCP forms are brokered only when their pinned schema fits Oompa's closed primitive-field contract.",
      "Opaque openai/form, unsupported schema constructs, and URL elicitation fail before durable admission",
    ];
    const markdown = renderDocumentationMarkdown("/docs/reference/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/reference/"));
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
  });

  test("publishes informed protected approval inspection", () => {
    const claims = [
      "oompa interaction inspect <interaction-id> --revision <n> [--handoff-file <absolute-path>]",
      "intentionally returns only a durable safe summary",
      "complete authority still held by the live provider callback",
      "ordinary stdout receives only safe binding and cleanup metadata",
      "neither the directory nor file may have an extended ACL",
      "Detail larger than 64 KiB also requires this file path.",
      "durably admits a bounded file-change prompt so it remains observable and may be declined",
      "refuses every acceptance",
      "does not provide the exact affected paths or change detail needed for informed approval",
    ];
    const markdown = renderDocumentationMarkdown("/docs/reference/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/reference/"));
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
  });

  test("publishes the persistent shell input and live-redaction boundaries", () => {
    const claims = [
      "An overflow or interrupted line flushes the current native terminal queue, retains input custody while discarding through EOF, and exits without executing the tail.",
      "Protected terminal documents require a visible stderr TTY plus unpredictable begin and return phrases while raw no-echo mode is active.",
      "then closes shell input instead of returning ambiguous bytes to an ordinary prompt.",
      "Display loss, termination, and job-control signals restore or fence raw mode before propagation.",
      "updates from an old session generation are discarded before a new selection is announced.",
      "Slow-terminal backpressure drops additional updates behind one explicit omission notice",
      "Human watch renders assistant and provider-visible reasoning-summary text only after observing that item's start boundary",
      "A mid-item join omits ambiguous delta suffixes until the next item starts.",
      "discard undecided tails with an explicit notice",
    ];
    const markdown = renderDocumentationMarkdown("/docs/reference/");
    const html = renderDocumentationHtml("/docs/reference/");
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim.replaceAll("'", "&#39;"));
    }
  });

  test("publishes the protected standard MCP form contract", () => {
    const markdown = renderDocumentationMarkdown("/docs/reference/");
    const html = renderDocumentationHtml("/docs/reference/");
    for (const claim of [
      "interaction show returns the exact public field contract without defaults or answers",
      '{"content":{...}}',
      "Decline and cancel accept no content.",
      "validation failures identify the contract failure without echoing a submitted value",
    ]) {
      expect(markdown).toContain(claim);
      expect(html).toContain(
        claim
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&#39;"),
      );
    }
  });

  test("states the origin-machine execution boundary and exact remote command set", () => {
    const markdown = renderDocumentationMarkdown("/docs/web/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/web/"));
    const claims = [
      "The machine that created a provider session remains its only executor in v1.",
      "send, queue, steer, stop, preset, provider-switch, and Codex Fast commands",
      "Project directories are local-only and are neither synced nor remotely changed.",
      "oompa remote send <cloud-session> <message>",
      "oompa remote command <uuidv7>",
      "oompa remote provider <cloud-session> <codex|claude> [--preset <low|high|ultra|fable-max>]",
      "--idempotency-key <current-uuidv7>",
      "includes interaction events with a public interaction ID, kind, state, revision, blocking status, bounded safe summary, and a nested version 2 remote policy",
      "Another device may decline a pending command, permission, or file-change request with",
      "every MCP answer stays on the execution machine",
      "Transcript upload is bound to a durable local stream ledger",
      "Oompa never resets, aliases, overwrites, or destructively reseeds encrypted history.",
      "oompa sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]",
      "performs no daemon call and returns",
      "JSON mode never prompts.",
      "preserves all older encrypted cloud history and changes no provider or app state.",
      "baselines only completed turns currently visible in the bounded local projection.",
      "Any possibly unsynced interval remains visible to remote readers as a recovery gap.",
      "Success reports the phase, local session, old and new epochs, boundary head, persistent gap, and an exact same-key replay command.",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
  });

  test("publishes append-only projection recovery on every relevant public surface", () => {
    const markdown = renderDocsMarkdown("/docs/web/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/web/"));
    const privacy = renderPrivacyMarkdown();
    const command = "oompa sync projection recover <local-session> --acknowledge-gap [--idempotency-key <uuidv7>] [--json]";

    expect(markdown).toContain(command);
    expect(html).toContain(command);
    for (const surface of [markdown, html]) {
      expect(surface).toContain("Projection recovery is an explicit append-only operation.");
      expect(surface).toContain("preserves all older encrypted cloud history");
      expect(surface).toContain("recovery gap");
    }
    expect(privacy).toContain("Compact-projection recovery is append-only.");
    expect(privacy).toContain("preserves every older encrypted cloud chunk");
    expect(privacy).toContain("recovery gap");
    expect(publicContent.endpoints.hostedSync).toBe("live");
  });

  test("retains every legacy anchor as a link to its complete canonical reference", () => {
    const home = renderSiteHtml();
    for (const section of publicContent.sections) {
      const path = docsPathForSection(section.id);
      const moved = oneElement(home, `a[data-moved-section="${section.id}"]`);
      expect(moved.getAttribute("href")).toBe(path);
      expect(moved.textContent).toContain(section.heading);
      if (section.id === "privacy") {
        expect(renderPrivacyMarkdown()).toContain("# Privacy");
        expect(renderPrivacyHtml()).toContain('id="privacy"');
      } else {
        const owner = findDocsPage(path.split("#")[0]!);
        expect(owner).toBeDefined();
        expect(renderDocsMarkdown(owner!.path)).toContain(`## ${section.heading}\n`);
        const detail = oneElement(renderDocsHtml(owner!), `details#${section.id}`);
        expect(detail.querySelector(":scope > summary")?.textContent).toBe(section.heading);
        expect(detail.textContent.length).toBeGreaterThan(section.heading.length);
      }
    }
    expect(parseHTML(home).document.querySelectorAll("section.documentation-section")).toHaveLength(0);
  });

  test.each([
    ["/docs/", "project", "/docs/status/"],
    ["/docs/sessions/", "first-account", "/docs/start/"],
    ["/docs/sessions/", "first-session", "/docs/start/"],
  ] as const)("preserves the moved public fragment %s#%s", (oldPath, id, newPath) => {
    const source = renderDocumentationHtml(oldPath);
    const link = oneElement(source, `a[data-moved-section="${id}"]`);
    expect(link.getAttribute("href")).toBe(`${newPath}#${id}`);
    expect(link.closest(`#${id}`)).not.toBeNull();
    expect(oneElement(renderDocumentationHtml(newPath), `details#${id}`)).toBeDefined();
    expect(oldPath).not.toBe(newPath);
  });

  test("keeps the full privacy boundary on its canonical HTML and Markdown surfaces", () => {
    const sentinelClaims = [
      "Codex account labels and observed provider email and plan metadata when cloud sync is enabled.",
      "Claude Code account identity and usage are not projected.",
      "validates one bounded Claude Code authentication-status response transiently",
      "never retains, returns, projects, or uploads the identity or usage fields",
      "Codex and Claude Code personal-session adoption status: whether discovery is enabled and bounded pending, adopted, and fenced counts.",
      "Candidate identities and records are never included.",
      "Devin has no personal-home adoption surface.",
      "Devin account identity and allowance are not projected.",
      "provider-supplied session context and cost facts in the neutral session stream",
      "For an explicitly requested Codex web login, the provider HTTPS verification URL and separate one-time user code.",
      "encrypts both to the account key before upload",
      "deletes the hosted handoff on that read or after five minutes",
      "OAuth access or refresh tokens; authorization codes; PKCE verifiers; provider cookies; or the private device code.",
      "Raw Codex app-server, Claude Code stream, or Devin ACP requests or responses.",
      "Personal-home adoption candidate identities or records, personal-runtime bindings, process identities, schedule-source metadata, provider-home provenance, provider-account authority hashes, or the automation id, firing time, and instructions from an exact Codex Desktop heartbeat envelope. Such an envelope is replaced with generic protected text before session content is projected.",
      "Raw reasoning, hidden chain of thought, or approval secrets.",
      "Observation-only interaction IDs, kinds, states, revisions, blocking status, and bounded safe summaries.",
      "Provider-internal login and request IDs, permission values, MCP field contracts, protected answers, or response digests.",
      "does not programmatically write decrypted provider or session text to the clipboard",
      "browser extensions, accessibility APIs, screenshots, and explicit user selection can observe rendered text",
      "Email access alone does not recover that key.",
      "an uncontested, unrevoked copy can impersonate that device",
      "Oompa uses Convex to authenticate the Oompa identity",
      "Oompa uses Resend to deliver verification email.",
      "one-time verification code and message content",
      "anonymous, cookieless PostHog analytics",
      "Collection runs only on the canonical production host",
      "honors Do Not Track",
      "disables person profiles, autocapture, heatmaps, feature flags, surveys, conversations, and session recording",
      "Oompa sends no form values, account identity, provider or session data, URL query, or fragment.",
      "Vercel serves oompa.app",
      "GitHub hosts the source repository, releases, and release downloads",
    ];
    const surfaces = [
      renderPrivacyMarkdown(),
      renderPrivacyHtml(),
    ];

    for (const claim of sentinelClaims) {
      for (const surface of surfaces) {
        expect(surface).toContain(claim.replaceAll("'", "&#39;"));
      }
    }
    expect(renderSiteHtml()).toContain('href="/privacy/"');
  });

  test("publishes exact beta prerequisites and package lifecycle limits", () => {
    const markdown = renderDocumentationMarkdown("/docs/status/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/status/"));
    const surfaces = [markdown, html];
    expect(publicContent.installCommand).toContain(OOMPA_INSTALL_PREFLIGHT_SOURCE_URL);
    expect(publicContent.installCommand).toContain("unset BUN_OPTIONS NODE_OPTIONS");
    expect(publicContent.installCommand).toContain(
      "| command bun --no-env-file --config=/dev/null -e '",
    );
    expect(publicContent.installCommand).toContain(
      "-- https://github.com/hraness/oompa/releases/download/v0.8.5/hraness-oompa-0.8.5.tgz",
    );
    expect(publicContent.installCommand).toContain("hra-install-safe");
    expect(publicContent.installCommand).not.toContain("bun add --global");
    expect(publicContent.installCommand).not.toContain("install-normalizer.ts");
    expect(markdown).toContain(publicContent.installCommand);
    expect(html).toContain(publicContent.installCommand);
    for (const surface of surfaces) {
      expect(surface).toContain("Oompa requires Bun 1.3.14");
      expect(surface).toContain("curl with HTTPS and TLS 1.2 support");
      expect(surface).toContain("support macOS and Linux");
      expect(surface).toContain("Codex effects run on both platforms");
      expect(surface).toContain("Devin effects also run on both platforms");
      expect(surface).toContain("Devin CLI reports exactly 3000.10.27");
      expect(surface).toContain("Claude Code effects run on Linux only");
      expect(surface).toContain("refuses new Claude Code effects on macOS pending authenticated isolated-Keychain and detached-read acceptance");
      expect(surface).toContain(OOMPA_INSTALL_PREFLIGHT_SOURCE_URL);
      expect(surface).toContain("hra-install-safe");
      expect(surface).toContain("fresh random private staging root");
      expect(surface).toContain("GitHub repository ID 1343008607");
      expect(surface).toContain("published immutable v0.8.5 release");
      expect(surface).toContain("removes ambient Bun, Node, and native-library injection variables");
      expect(surface).toContain("disables Bun dotenv loading");
      expect(surface).toContain("/dev/null as the only Bun configuration");
      expect(surface).toContain("immutable release metadata");
      expect(surface).toContain("verified in-memory snapshot");
      expect(surface).toContain("bounded package-file manifest");
      expect(surface).toContain("every extracted Oompa package path and SHA-256");
      expect(surface).toContain("separate full-digest version namespaces");
      expect(surface).toContain("lifecycle scripts disabled");
      expect(surface).toContain("complete staged tree");
      expect(surface).toContain("configured package registry trust boundary");
      expect(surface).toContain("does not claim to contain that dependency closure");
      expect(surface).toContain("detached staging worker and its Bun package-install child repeat the runtime neutralization");
      expect(surface).toContain("configured registry, proxy, and certificate trust inputs");
      expect(surface).toContain("prior verified command remains active throughout staging");
      expect(surface).toContain("atomically replaces only the $BUN_INSTALL/bin/oompa symlink");
      expect(surface).toContain("next invocation of that exact release's installer recovers or removes only the proven private stage");
      expect(surface).toContain("another release's installer refuses the durable intent");
      expect(surface).toContain("invoking shell, PATH-selected pinned Bun binary");
      expect(surface).toContain("Existing trustedDependencies remain unchanged");
      expect(surface).toContain("oompa daemon stop");
      expect(surface).toContain("oompa daemon status --json");
      expect(surface).toContain("oompa daemon start");
      expect(surface).toContain("Only after immutable GitHub release admission for v0.8.5, install its exact release and verify the installed version and offline health");
      expect(surface).not.toContain("bun remove --global oompa");
      expect(surface).not.toContain("uninstall the package");
    }
  });

  test("publishes the ordered update runbook with recovery and mixed-version boundaries", () => {
    const markdown = renderDocumentationMarkdown("/docs/status/");
    const rawHtml = renderDocumentationHtml("/docs/status/");
    const html = htmlVisibleText(rawHtml);
    const install = publicContent.sections.find((section) => section.id === "install-and-update");
    const procedure = install?.blocks.find(
      (block) => block.kind === "ordered-list",
    );

    expect(procedure?.kind).toBe("ordered-list");
    if (procedure?.kind !== "ordered-list") throw new Error("Missing update procedure.");
    expect(procedure.items).toHaveLength(10);
    const procedureList = oneElement(rawHtml, "#install-and-update ol.procedure-list");
    expectCompiledClasses(procedureList);
    expect(procedureList.querySelectorAll(":scope > li")).toHaveLength(10);
    expect(procedureList.querySelector(":scope > li:first-child > p")?.textContent).toStartWith("Settle any durable installer intent");

    const claims = [
      "Update runbook",
      "Resolve every uncertain local mutation that depends on old alias or prepared authority before starting the current daemon",
      "preserve remote-command evidence for the fail-closed reconciliation below",
      "expected preflight digest, and expected version together with one exact reviewed immutable tag",
      "Never install a moving branch on a release machine",
      "never run an older daemon against this state root after the current daemon has started",
      "Settle any durable installer intent left by an interrupted installation",
      "$BUN_INSTALL/install/oompa/install-intent.json",
      "Do not edit or delete that file or its staging or version directories",
      "the exact immutable install command from the originating release's trusted README or release notes",
      "If that installer refuses the intent, stop installation and use bounded read-only diagnosis while preserving the intent and its directories",
      "after exact recovery succeeds, restart this runbook with the current release",
      "Establish the originating tag independently",
      "never execute a URL or command copied only from the intent",
      "An uncertain tag blocks execution, not diagnosis",
      "Ask the owner only when the evidence cannot resolve a required decision or authority is missing",
      "This recovers only local installer state",
      "It is not authorization to retry, rerun, or mutate that release's GitHub Actions workflow",
      "replay the exact idempotency key using the originating release's own syntax and source evidence",
      "Resolve an affected Work mutation by replaying its exact request document",
      "Continue only when exact replay under the originating release",
      "Otherwise the update remains blocked",
      "do not invent an unsupported option",
      "This command has no idempotency key",
      "Block the update on any remaining prepared or indeterminate local mutation",
      "Oompa exposes no general command to cancel a prepared session start or provider switch",
      "Do not generate a fresh key or edit SQLite as a workaround",
      "durable local outbox",
      "current tab's returned command handle and public ID",
      "The app does not expose its internal idempotency key",
      "Never edit or delete the local command journal, local outbox, tab state, or hosted row to force progress",
      "Require the stop command itself to exit zero",
      "Status alone does not prove authority release",
      "data.running: false",
      "report only the exact pending state-schema migration",
      "protected two-pass zero-debt capacity evidence together with the exact .activated receipt",
      "The capacity evidence alone is not readiness",
      "This is the no-downgrade boundary",
      "Require the post-start doctor command to succeed before sync",
      "data.online: true",
      "data.errorCount: 0",
      "data.commandRequestVersion: 2",
      "There is no per-target writer switch",
      "Finish all intended target proofs before deploying marker-emitting writer clients globally",
      "Old clients and targets whose markers are both absent remain compatible",
      "Sync status reports projection recovery, not the command outbox",
      "The current daemon never executes a legacy request commitment",
      "An already-hosted terminal row takes precedence",
      "LEGACY_REQUEST_COMMITMENT_BEFORE_EFFECT",
      "if the hosted row remains nonterminal and either side records",
      "close it result-less as",
      "LOCAL_EFFECT_RECOVERY_REQUIRED",
      "Never automatically retry an ambiguous command",
      "Each daemon privately publishes its command-request version before processing commands",
      "A fresh request is inserted only when its marker exactly matches the target's last stored registry marker",
      "the hosted runtime's capacity activation tuple exactly matches its compiled release attestation",
      "A marker or activation mismatch is rejected before the command, quota charge, or security event is written",
      "a candidate redeploy invalidates the hosted activation",
      "the executor checks stop a mismatched binary before prepare or provider effect",
      "Exact same-key replay remains available across a later target or runtime change",
      "A registry-publication failure skips both command queues for that cycle",
      "current target and hosted activation markers before a new prepare or effect start",
      "until capacity activation and target-marker proof exist",
      "No all-daemons pause or account-wide legacy drain is required",
    ];
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }

    for (const surface of [markdown, html]) {
      expect(surface).not.toContain("If that installer refuses the intent, stop for manual review");
    }

    expect(markdown).toContain([
      "6. Stop the daemon and prove that it released authority:",
      "",
      "   ```text",
      "   oompa daemon stop --json",
      "   oompa daemon status --json",
      "   ```",
      "",
      "   Require the stop command itself to exit zero; its recovery path is the authority-release proof. Treat a status response containing `data.running: false` only as a secondary no-listener confirmation. Status alone does not prove authority release. Stop on any stop or recovery error.",
    ].join("\n"));
    expect(markdown).toContain([
      "9. Start the current daemon. This is the no-downgrade boundary: after this command begins, never launch an older daemon against the same state root. Prove post-migration health before syncing, then inspect every retained CLI session-command ID:",
      "",
      "   ```text",
      "   oompa daemon start",
      "   oompa doctor --offline",
      "   oompa sync now --json",
      "   oompa sync status",
      "   oompa remote command <uuidv7>",
      "   ```",
    ].join("\n"));
    expect(markdown.indexOf("1. Settle any durable installer intent")).toBeLessThan(
      markdown.indexOf("10. Classify legacy remote commitments"),
    );
    expect(markdown).toContain("A fresh or local-prepared legacy request over hosted `pending` or `prepared` row closes as `failed` with `LEGACY_REQUEST_COMMITMENT_BEFORE_EFFECT`.");
    expect(markdown).toContain("A legacy local terminal outcome over any hosted nonterminal row is unauthenticated evidence");
    const runbookMarkdown = markdown.slice(
      markdown.indexOf("### Update runbook"),
      markdown.indexOf("### Optional full local-data removal"),
    );
    expect(runbookMarkdown.match(/^\d+\. /gmu)).toHaveLength(10);
    const runbookStart = rawHtml.indexOf(">Update runbook</h3>");
    expect(runbookStart).toBeGreaterThan(0);
    const runbookHtml = rawHtml.slice(
      runbookStart,
      rawHtml.indexOf("Optional full local-data removal"),
    );
    expect(parseHTML(runbookHtml).document.querySelectorAll("li")).toHaveLength(10);
    expect(htmlVisibleText(runbookHtml)).toMatch(/Stop the daemon[\s\S]+?oompa daemon stop --json[\s\S]+?Status alone does not prove authority release/u);
    expect(markdown).not.toContain("Before replacing the installed binary");
  });

  test("preserves versioned Work and historical alias-replay guidance on both shared surfaces", () => {
    const markdown = renderDocumentationMarkdown("/docs/reference/", "/docs/status/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/reference/", "/docs/status/"));
    const claims: readonly (readonly [visible: string, markdown?: string])[] = [
      ["The versioned source contract defines a narrow local coordination kernel"],
      ["one strict version 1 or version 2 request"],
      ["also carries the caller-authored top-level presetContract", "also carries the caller-authored top-level `presetContract`"],
      ["version 2 forbids that field on stable operations"],
      ["The request version and any authored preset contract are part of changed-intent detection"],
      ["Each Work also freezes the meaning of its High and Ultra routes when it is created"],
      ["A fresh affected version 1 request is refused"],
      ["An existing contract 1 Work whose coordinator and participating session authorities remain supported keeps Sol for already-declared tasks"],
      ["A Work associated with a retired Devin session remains readable but is fenced from mutation and execution"],
      ["Current tooling does not append a new High or Ultra task to a contract 1 Work"],
      ["Reusing that key with another version or contract is a conflict"],
      [
        "A source-sensitive Codex session start or provider-switch replay includes both --idempotency-key and its immutable --preset-contract",
        "A source-sensitive Codex `session start` or provider-switch replay includes both `--idempotency-key` and its immutable `--preset-contract`",
      ],
      ["The preset-contract option is a source-binding field that requires an explicit idempotency key and is rejected for stable requests"],
      ["With a key that has no stored row, only this build's active source contract may authorize the one fresh effect"],
      ["An older session-start release did not print the source contract"],
      ["--preset high --preset-contract 1", "`--preset high --preset-contract 1`"],
      ["Neither selector can resume a contractless prepared row"],
      ["Contract 1 cannot authorize a fresh effect under the current Astra binding"],
      ["contract 2 can authorize the exact Astra request when the key has no stored row"],
      ["If the originating meaning cannot be proved, use the retained old release rather than guessing"],
      ["A contractless prepared row has no supported cancellation or retirement command"],
      ["Do not use a fresh key or session abandon as a workaround", "Do not use a fresh key or `session abandon` as a workaround"],
      ["session preset has no idempotency-key replay", "`session preset` has no idempotency-key replay"],
    ];

    for (const [visibleClaim, markdownClaim = visibleClaim] of claims) {
      expect(markdown).toContain(markdownClaim);
      expect(html).toContain(visibleClaim);
    }
  });

  test("publishes first-session walkthroughs for humans and agents", () => {
    const markdown = renderDocumentationMarkdown("/docs/start/", "/docs/sessions/", "/docs/reference/");
    const rawHtml = renderDocumentationHtml("/docs/start/", "/docs/sessions/", "/docs/reference/");
    const html = htmlVisibleText(rawHtml);
    const claims = [
      "Human terminal",
      "oompa session start personal --provider codex",
      "/account personal",
      "/session <session-id>",
      "Agent caller",
      "data.session.id",
      "data.eventStream.cursor",
      "oompa session start personal --provider codex --json",
      "oompa session status <session-id> --json",
      "oompa session watch <session-id> --cursor <status-cursor> --jsonl",
      "--follow",
      "equivalent compatibility spelling",
      "oompa session interactions <session-id> --pending --json",
      "Claude Code and provider switching",
      "oompa session start personal --provider claude --preset fable-max --json",
      "oompa session switch <session-id> --provider claude --preset fable-max",
      "oompa session export <session-id> --format json",
      "seeds a fresh provider-native runtime from the latest retained tail",
      "does not move a provider-native thread",
      "accepted direct, queued, Work and scheduled automation, autorespond, and provider-switch handoff messages with actor provenance",
      "Attachments are represented only by byte-free manifests",
      "Retention is capped at 50,000 events, 64 MiB, and seven days",
      "Keep following while a separate one-shot invocation handles the approval, question, permission grant, or supported MCP form.",
      "Scheduled work in the same conversation",
      "oompa session task create <session-id> --name daily-review --every-minutes 1440",
      "oompa session task list <session-id>",
      "oompa session task show <session-id> <task-id>",
      "oompa session task edit <session-id> <task-id> --revision <revision> --pause",
      "oompa session task edit <session-id> <task-id> --revision <revision> --resume",
      "oompa session task delete <session-id> <task-id> --revision <revision>",
      "A task cannot independently retarget its account, provider, project, model, or execution environment",
      "later explicit changes to the session apply to future runs",
      "Missed intervals coalesce into one queued turn",
      "Oompa never creates a replacement provider conversation or writes a provider's private automation registry",
    ];

    expect(markdown).toContain("## First session");
    expect(rawHtml).toContain('id="first-session"');
    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
    expect(publicContent.hero.steps[0]).toMatchObject({
      command: "oompa session start personal --provider codex --json",
    });
    expect(publicContent.hero.steps[2]).toMatchObject({
      command: "oompa session switch <session-id> --provider claude --preset fable-max",
      detail: "Continue on your signed-in Claude Code profile. Oompa carries over the conversation it has retained and flags any missing history.",
    });
    expect(markdown).toContain("New Oompa-created Codex sessions that use `high` or `ultra`");
    expect(html).toContain("New Oompa-created Codex sessions that use high or ultra");
    expect(markdown).toContain("The `low` and `fable-max` bindings are unchanged");
    expect(markdown).not.toContain("every explicit preset selection use the Sol mapping");
    expect(markdown).toContain("sessions already bound to contract 1 keep their exact Sol model and effort");
    expect(html).toContain("sessions already bound to contract 1 keep their exact Sol model and effort");
    expect(markdown).not.toContain("session start personal --provider codex --preset high");
  });

  test("publishes bounded status and cursor-safe observation contracts", () => {
    const markdown = renderDocumentationMarkdown("/docs/reference/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/reference/"));
    const claims = [
      "Bounded local status",
      "oompa status [--json]",
      "bounded, effect-free read of local SQLite state",
      "does not start, stop, or contact the daemon",
      "at most 50 ID-and-revision action records",
      "complete JSON result, including its versioned command envelope, is at most 256 KiB",
      "Provider and cloud coverage are explicitly",
      "not_attempted",
      "registered and online device counts are unknown rather than zero",
      "Session observation",
      "returns status version 2",
      "one typed provider-observation result, attempting the bound provider's reviewed observation path only when the current local state makes one applicable",
      "Execution, attention, provider, and queue remain separate axes",
      "Pending and response-in-flight counts are exact",
      "at most 10 bounded safe summaries",
      "excludes the session note and private provider thread binding",
      "becomes a secret-keyed opaque public alias before status, event, or interaction output",
      "renders a bounded human stream by default",
      "Watch is a presentation alias over the existing session event stream",
      "drains each output page before advancing its internal cursor",
      "Resolution guidance appears only from a complete current interaction record and only for a supported decision",
      "event-only interaction notice points to the exact show command without proposing a mutation",
      "JSONL delivery is at least once across a pipe or process failure",
      "(sessionId, streamEpoch, sequence)",
      "persist each checkpoint only after durably applying all preceding lines",
      "remains an equivalent compatibility spelling",
      "is unavailable until every wait predicate has a transactional wake revision",
      "Use status followed by watch from its cursor, or bounded repeated status polling",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }

    const documentedCommands = publicContent.sections.flatMap((section) =>
      section.blocks.flatMap((block) => block.kind === "commands" ? block.commands : []),
    );
    expect(documentedCommands).toContain("oompa status [--json]");
    expect(documentedCommands).toContain("oompa session watch <session> [--cursor <cursor>] [--jsonl]");
    expect(documentedCommands.some((command) => command.startsWith("oompa session wait"))).toBe(false);
    expect(documentedCommands.some((command) => /<\d+-\d+>/u.test(command))).toBe(false);
  });

  test("publishes autorespond and provider-profile privacy boundaries", () => {
    const markdown = renderDocumentationMarkdown("/docs/reference/", "/docs/sessions/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/reference/", "/docs/sessions/"));
    const claims = [
      "Only an actual human-authored message resets the consecutive counter",
      "peer messages, Work and scheduled automation, autorespond, and provider-switch handoff messages do not",
      "Configuring a gateway key explicitly enables the separate prose-approval path",
      "openai/gpt-5-nano",
      "one request with a 10-second deadline and no retry",
      "The model cannot create arbitrary text that Oompa will send",
      "a byte-exact substring already present in the assistant message",
      "Claude Code public profiles include the pinned CLI, model, reasoning effort, default permission mode, and stream formats",
      "omits that custody identity and legacy isolation marker",
      "managed and adopted personal-home sessions therefore share one non-identifying public shape",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
    expect(markdown).not.toContain("Claude Code profiles include the pinned CLI, model, reasoning effort, default permission mode, isolated-config proof");
    expect(html).not.toContain("Claude Code profiles include the pinned CLI, model, reasoning effort, default permission mode, isolated-config proof");
  });

  test("keeps the public command reference in parity with CLI group help", () => {
    const commandReference = publicContent.sections.find((section) => section.id === "command-reference");
    expect(commandReference).toBeDefined();
    const documentedCommands = new Set(commandReference?.blocks.flatMap((block) =>
      block.kind === "commands" ? block.commands : []
    ) ?? []);

    for (const group of helpGroupNames) {
      const usageSection = usageForGroup(group).split("\n\n")
        .find((section) => section.startsWith("Usage:\n"));
      expect(usageSection).toBeDefined();
      for (const line of usageSection?.split("\n").slice(1) ?? []) {
        const command = line.trim();
        if (command.startsWith("oompa ")) expect(documentedCommands).toContain(command);
      }
    }
  });

  test("documents safe optional full local-data removal without a recursive command", () => {
    const markdown = renderDocumentationMarkdown("/docs/status/");
    const html = htmlVisibleText(renderDocumentationHtml("/docs/status/"));
    const claims = [
      "Optional full local-data removal",
      "oompa auth delete --acknowledge-erasure",
      "oompa account logout <profile>",
      "data.running",
      "$HOME/Library/Application Support/HRA Control Plane v1",
      "$HOME/.local/state/hra-control-plane-v1",
      "explicitly accepts permanent loss",
      "Claude Code configuration directories",
      "provider-managed system credential storage",
      "sign out through Claude Code before deletion",
      "move only the exact platform directory to Trash",
      "Do not move or remove the state directory's parent.",
      "obtain explicit destructive approval",
      "An install, update, or daemon-stop request does not authorize local-data removal.",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(claim);
    }
    expect(markdown).not.toContain("rm -r");
    expect(html).not.toContain("rm -r");
  });

  test("publishes the exact exit-code and JSONL terminal-error contract", () => {
    const markdown = renderDocumentationMarkdown("/docs/reference/");
    const html = renderDocumentationHtml("/docs/reference/");
    const statuses = [
      ["0", "success. A normally stopped event follower, including a user SIGINT, may also return 0."],
      ["1", "CONFLICT, AMBIGUOUS, INTERNAL, any other closed failure code, or an unhealthy doctor result."],
      ["2", "INVALID_INPUT."],
      ["4", "NOT_FOUND."],
      ["5", "UNAVAILABLE."],
      ["6", "INTERACTION_REQUIRED."],
      ["7", "RECOVERY_REQUIRED."],
    ] as const;
    const claims = [
      "Exit status and JSONL",
      "stdout contains only JSONL gap, event, and checkpoint frames",
      "exactly one newline-terminated version-1 failure envelope to stderr",
      '{"ok":false,"version":1,"error":{"code":"<code>","message":"<safe-message>"}}',
      "must not merge the terminal error into the JSONL stream",
      "must check the process exit status",
      "may exit 0 without a terminal failure envelope",
    ];

    for (const claim of claims) {
      expect(markdown).toContain(claim);
      expect(html).toContain(htmlText(claim));
    }
    for (const [status, meaning] of statuses) {
      expect(markdown).toContain(`- \`${status}\`: ${meaning}`);
      const codes = [...parseHTML(html).document.querySelectorAll("li > code.oompa-inline-code")]
        .filter((code) => code.textContent === status && code.parentElement?.textContent === `${status}: ${meaning}`);
      expect(codes).toHaveLength(1);
      expectCompiledClasses(codes[0]!);
    }
  });

  test("publishes the local interaction deadline boundary", () => {
    const surfaces = [renderDocumentationMarkdown("/docs/reference/"), htmlVisibleText(renderDocumentationHtml("/docs/reference/"))];
    for (const surface of surfaces) {
      expect(surface).toContain("anchored when the provider delivered it");
      expect(surface).toContain("caps the pending interval at 30 minutes");
      expect(surface).toContain("never invents an answer or grant");
      expect(surface).toContain("nested remote policy version 2 carries the same absolute deadline");
    }
  });

  test("contains JSON-LD, owned appearance bootstrap, and one owned analytics module on public pages", () => {
    const html = renderSiteHtml();
    const privacy = renderPrivacyHtml();
    expect(html).toContain('<link rel="canonical" href="https://oompa.app/">');
    expect(html).toContain('<meta property="og:type" content="website">');
    expect(html).toContain('<link rel="stylesheet" href="/styles.css">');
    expect(html).toContain('<script type="application/ld+json">');
    expect(html.match(/<script\b/gu)).toHaveLength(4);
    expect(html.match(/<script[^>]+src=/gu)).toHaveLength(3);
    expect(html).toContain('<script src="/site.js" type="module"></script>');
    expect(html).toContain('<script src="/appearance.js"></script>');
    expect(html).toContain(renderOompaAnalyticsScript());
    expect(privacy).toContain(renderOompaAnalyticsScript());
    expect(renderPreviewHtml()).not.toContain(renderOompaAnalyticsScript());
    expect(html).not.toContain("onclick=");
    for (const page of docsPages) {
      const document = parseHTML(renderDocsHtml(page)).document;
      expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(`https://oompa.app${page.path}`);
      expect([...document.querySelectorAll("script[src]")].map((script) => script.getAttribute("src"))).toEqual(["/appearance.js", "/analytics.js", "/site.js"]);
      expect(document.documentElement.getAttribute("data-palette")).toBe("paper");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(document.querySelectorAll("details[data-oompa-appearance]")).toHaveLength(1);
      expect(document.querySelectorAll('script[type="application/ld+json"]')).toHaveLength(1);
    }
  });

  test("renders the canonical Hraness network footer on every HTML page", () => {
    const expectedHrefs = [
      HRANESS_HOME_URL,
      "https://account.hraness.com/support?product=hra&amp;source=web#support",
      "https://hraness.com/privacy",
      ...hranessSocialLinks.map(({ href }) => href),
    ];

    const pages = [
      renderSiteHtml(),
      renderPrivacyHtml(),
      ...docsPages.map((page) => renderDocsHtml(page)),
    ];
    for (const document of pages) {
      expect(document.match(/<footer\b/gu)).toHaveLength(2);
      const footer = /<footer\b[^>]*\bdata-slot="hraness-site-footer"[^>]*>[\s\S]*?<\/footer>/u.exec(document)?.[0];
      expect(footer).toContain('data-slot="hraness-site-footer"');
      expect(footer?.match(/data-slot="hraness-mark"/gu)).toHaveLength(1);
      expect(footer?.match(/data-slot="social-icon"/gu)).toHaveLength(4);
      expect(footer).not.toContain("hraness-site-footer__wordmark");
      expect(footer).toContain('data-mailing-list="signup"');
      expect(footer).toContain('href="https://substack.com/@hraness"');
      expect(
        [...(footer?.matchAll(/<a\b[^>]*\shref="([^"]+)"/gu) ?? [])]
          .map((match) => match[1]),
      ).toEqual(expectedHrefs);
      expect(footer?.match(/data-slot="hraness-support-link"/gu)).toHaveLength(1);
      expect(footer?.match(/data-slot="hraness-support-icon"/gu)).toHaveLength(1);
      expect(footer).toContain("by Hraness");
      expect(document.match(/by Hraness/gu)).toHaveLength(1);
      expect(document).not.toContain("Built by");
      expect(document).not.toContain("Ben Guo");
      expect(document).not.toContain("hraness-marketing-maker");
      expect(elementPosition(document, 'footer[data-hraness-marketing="footer"]')).toBeLessThan(
        elementPosition(document, 'footer[data-slot="hraness-site-footer"]'),
      );
    }
    for (const document of pages) {
      expect(elementPosition(document, "aside.project-resources")).toBeLessThan(
        elementPosition(document, 'footer[data-hraness-marketing="footer"]'),
      );
    }
  });

  test("renders the shared in-flow Oompa content footer ahead of the network footer", () => {
    for (const document of [renderSiteHtml(), renderPrivacyHtml(), ...docsPages.map((page) => renderDocsHtml(page))]) {
      const contentFooter = parseHTML(document).document.querySelector('footer[data-hraness-marketing="footer"]');
      expect(contentFooter?.getAttribute("aria-label")).toBe(publicContent.productName);
      const brand = contentFooter?.querySelector(".hraness-marketing-footer__brand");
      expect(brand?.getAttribute("href")).toBe("/");
      expect(brand?.getAttribute("aria-label")).toBe(`${publicContent.productName} home`);
      expect(brand?.textContent).toBe(publicContent.productName);
      const mark = brand?.querySelector('svg[aria-hidden="true"] > circle');
      expect(mark?.getAttribute("fill")).toBe("#f58220");
      expect(mark?.getAttribute("stroke")).toBe("#ad430d");
      const links = [...(contentFooter?.querySelectorAll('.hraness-marketing-footer__nav > a') ?? [])];
      expect(links.map((link) => [link.getAttribute("href"), link.textContent])).toEqual([
        ["/#product-preview", "Product"], ["/docs/", "Docs"], ["/docs/status/", "Status"],
        [publicContent.links.github, "GitHub"],
      ]);
      expect(contentFooter?.querySelector("[style], style, script")).toBeNull();
    }
  });

  test("renders only the Oompa mailing audience without a client challenge", () => {
    expect(oompaMailingListConfig()).toEqual({
      audience: "hra",
      kind: "signup",
    });

    const footer = renderOompaSiteFooter();
    expect(footer).toContain('data-mailing-list="signup"');
    expect(footer).toContain('name="audience" type="hidden" value="hra"');
    expect(footer).toContain('name="website" tabindex="-1"');
    expect(footer).toContain(
      'action="https://account.hraness.com/api/mailing/subscribe"',
    );
    expect(footer).not.toContain("challenges.cloudflare.com");
    expect(footer).not.toContain("turnstile");
    expect(footer).toContain('href="https://substack.com/@hraness"');
  });

  test("renders an inert noindex preview canonicalized to the full product page", () => {
    const preview = renderPreviewHtml();
    expectCompiledClasses(oneElement(preview, "body.preview-page"));
    expect(preview).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(preview).toContain('<link rel="canonical" href="https://oompa.app/">');
    const title = oneElement(preview, "h1#preview-title");
    expect(title.textContent).toBe(publicContent.productName);
    expectCompiledClasses(title);
    expect(preview.match(/<h1\b/gu)).toHaveLength(1);
    expect(preview).not.toContain("<script");
    expect(preview).not.toMatch(/analytics|auth(?:entication|orization)?|cookie|user data/iu);
    expect(preview).not.toMatch(/<(?:a|button|form|input|select|textarea)\b/iu);
    expect(preview).not.toContain("<footer");
    expect(renderSitemapXml()).not.toContain("/preview");
  });

  test("provides keyboard and landmark structure without inline presentation", () => {
    for (const html of [renderSiteHtml(), ...docsPages.map((page) => renderDocsHtml(page))]) {
      expect(html.match(/<h1\b/g)).toHaveLength(1);
      const skipLink = oneElement(html, 'a.skip-link[href="#content"]');
      expect(skipLink.textContent).toBe("Skip to content");
      expectCompiledClasses(skipLink);
      expect(oneElement(html, "main#content")).toBeDefined();
      expect(html).not.toContain("<style>");
      expect(html).not.toContain(" style=");
    }
    for (const page of docsPages) {
      const html = renderDocsHtml(page);
      expect(oneElement(html, 'nav[aria-label="Guides"]')).toBeDefined();
      expect(oneElement(html, 'nav[aria-label="On this page"]')).toBeDefined();
      expect(oneElement(html, 'nav[aria-label="Guides"] a[aria-current="page"]').getAttribute("href")).toBe(page.path);
    }
  });

  test("keeps retired adjacent-reading routes out of product discovery", () => {
    const retiredRoutes = [
      "/reading/deepseek-harness/",
      "/reading/hax/",
      "/reading/headlong-microharness/",
      "/reading/oracle-and-firm/",
    ] as const;
    const publicDocuments = [
      renderSiteHtml(),
      renderLlmsText(),
      renderSitemapXml(),
    ];

    expect(siteDocumentPaths).toEqual(["/", ...docsPaths, "/privacy/"]);
    for (const route of retiredRoutes) {
      for (const document of publicDocuments) {
        expect(document).not.toContain(route);
      }
    }
  });

  test("keeps linked roadmap and backup guidance consistent with artifact and stop authority", async () => {
    const roadmap = await readFile(new URL("../docs/roadmap.md", import.meta.url), "utf8");
    expect(roadmap).not.toContain("current unreleased source");
    expect(roadmap.match(/Included in the admitted v0\.7\.0 artifact; runtime rollout remains gated\./gu)).toHaveLength(2);
    const memory = await readFile(new URL("../docs/facts-memory.md", import.meta.url), "utf8");
    const backup = memory.split("### Backup, restore, and rollback\n")[1]?.split("\n## ")[0];
    expect(backup).toBeDefined();
    expect(backup).toContain("Run `oompa daemon stop --json` and require that command itself to exit zero before taking or restoring a snapshot");
    expect(backup).toContain("`oompa daemon status --json` reporting `data.running: false` is only a secondary no-listener check");
    expect(backup).toContain("Stop on any stop or recovery error");
    expect(backup).toContain("complete private state root at one filesystem checkpoint");
  });
});
