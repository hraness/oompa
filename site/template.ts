import {
  renderHranessSiteFooter,
  type HranessMailingListConfig,
} from "@hraness/site-footer";
import { highlightCode } from "@hraness/design-kit/syntax-highlighting";
import { getDesignPaletteTheme } from "@hraness/design-kit";
import { AskAiAboutThis } from "@hraness/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sitePresentationClasses, sitePresentationStyles, type SitePresentationSlot } from "./presentation.stylex.ts";
import { renderMarketingHeader, renderMarketingPage } from "./marketing.tsx";
import { docsPages, docsPathForSection, docsReferenceSections, type DocsPage } from "./docs-content.ts";
import { renderProductPreview } from "./product-preview.tsx";
import { docsClasses } from "./docs.stylex.ts";

import {
  findSection,
  publicContent,
  type ContentBlock,
  type ContentSection,
  type InlineContent,
  type PublicContent,
} from "./content.ts";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const defaultPalette = getDesignPaletteTheme("paper", "light");
const previewPalette = getDesignPaletteTheme("catppuccin", "dark");
const previewPaletteAttributes = `class="${escapeHtml(previewPalette.className)}" data-palette="catppuccin" data-theme="dark"`;
const paletteAttributes = `class="${escapeHtml(defaultPalette.className)}" data-hraness-theme="paper" data-palette="paper" data-theme="light"`;
const classes = (hook: string, ...slots: readonly SitePresentationSlot[]): string =>
  [hook, sitePresentationClasses(...slots)].filter(Boolean).join(" ");

const renderShellCode = (value: string): string => {
  const highlighted = highlightCode(value, "shell");
  return `<code class="${classes(highlighted.className, "codeContent")}">${highlighted.html}</code>`;
};

export const OOMPA_MAILING_TURNSTILE_SITEKEY_ENV =
  "NEXT_PUBLIC_HRANESS_MAILING_TURNSTILE_SITEKEY" as const;

const turnstileSitekeyPattern = /^[A-Za-z0-9_-]{20,100}$/u;
const emptySiteEnvironment: Readonly<Record<string, string | undefined>> =
  Object.freeze({});

export const oompaMailingListConfig = (
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): HranessMailingListConfig => {
  const turnstileSitekey = environment[OOMPA_MAILING_TURNSTILE_SITEKEY_ENV];
  if (turnstileSitekey === undefined || turnstileSitekey.length === 0) {
    if (environment.VERCEL_ENV === "production") {
      throw new Error(
        `${OOMPA_MAILING_TURNSTILE_SITEKEY_ENV} must be configured for Vercel Production.`,
      );
    }
    return { kind: "none" };
  }
  if (!turnstileSitekeyPattern.test(turnstileSitekey)) {
    throw new Error(
      `${OOMPA_MAILING_TURNSTILE_SITEKEY_ENV} must be a 20-100 character URL-safe public Cloudflare Turnstile sitekey.`,
    );
  }
  return {
    audience: "hra",
    kind: "signup",
    turnstileSitekey,
  };
};

export const renderOompaSiteFooter = (
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): string => renderHranessSiteFooter({
  mailingList: oompaMailingListConfig(environment),
});

export const renderAskAiAboutThis = (canonicalUrl: string): string =>
  renderToStaticMarkup(createElement(AskAiAboutThis, {
    className: "oompa-ask-ai",
    xstyle: [sitePresentationStyles.resourceFrame, sitePresentationStyles.askAi],
    url: canonicalUrl,
  }));

export const renderOompaAnalyticsScript = (): string =>
  '<script src="/analytics.js" type="module"></script>';

const renderInline = (content: readonly InlineContent[], focusable = true, styleLinks = true): string =>
  content
    .map((part) => {
      switch (part.kind) {
        case "code":
          return `<code class="${classes("oompa-inline-code", "inlineCode")}">${escapeHtml(part.value)}</code>`;
        case "link":
          return `<a${styleLinks ? ` class="${classes("", "proseLink", ...(focusable ? ["focusable"] as const : []))}"` : ""} href="${escapeHtml(part.href)}">${escapeHtml(part.label)}</a>`;
        case "text":
          return escapeHtml(part.value);
      }
    })
    .join("");

const renderCommandBlock = (commands: readonly string[], slots: readonly SitePresentationSlot[] = []): string =>
  `<pre class="${classes("command-list", "codeBlock", "commandList", "focusable", ...slots)}" tabindex="0">${renderShellCode(commands.join("\n"))}</pre>`;

type ProseSurface = "reference" | "privacy" | "heroNotes";

const renderBlock = (
  block: ContentBlock,
  sectionId: string,
  blockIndex: number,
  subheadingLevel: "h2" | "h3" = "h3",
  surface: ProseSurface = "reference",
): string => {
  const reference = surface !== "privacy";
  const direct: readonly SitePresentationSlot[] = surface === "heroNotes" ? [] : ["documentationBody"];
  const text: readonly SitePresentationSlot[] = reference ? ["referenceText"] : [];
  const paragraph: readonly SitePresentationSlot[] = ["proseMeasure", ...text, ...(surface === "heroNotes" ? ["heroNotesParagraph"] as const : [])];
  const listItem = (index: number): string => classes("", ...text, ...(index > 0 ? ["spacedListItem"] as const : []));
  switch (block.kind) {
    case "commands":
      return renderCommandBlock(block.commands, ["proseMeasure", ...direct]);
    case "list":
      return `<ul class="${classes("", "proseMeasure", ...direct)}">${block.items.map((item, index) => `<li class="${listItem(index)}">${renderInline(item)}</li>`).join("")}</ul>`;
    case "notice":
      return `<aside class="${classes("notice", "notice", "proseMeasure", ...text, ...direct)}" aria-label="${escapeHtml(block.label)}"><strong class="${classes("", "noticeStrong")}">${escapeHtml(block.label)}.</strong> ${renderInline(block.content)}</aside>`;
    case "ordered-list":
      return `<ol class="${classes("procedure-list", "proseMeasure", ...direct)}">${block.items.map((item, index) => `<li class="${listItem(index)}"><p class="${classes("", ...paragraph)}">${renderInline(item.content)}</p>${item.commands === undefined ? "" : renderCommandBlock(item.commands, ["proseMeasure"])}${item.afterCommands === undefined ? "" : `<p class="${classes("", ...paragraph)}">${renderInline(item.afterCommands)}</p>`}</li>`).join("")}</ol>`;
    case "paragraph":
      return `<p class="${classes("", ...paragraph, ...direct)}">${renderInline(block.content)}</p>`;
    case "subheading": {
      const id = `${sectionId}-${blockIndex.toString()}-${block.text.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/(^-|-$)/g, "")}`;
      const heading: readonly SitePresentationSlot[] = subheadingLevel === "h2"
        ? [reference ? "referenceH2" : "privacyH2", ...(reference ? ["proseMeasure"] as const : [])]
        : ["proseH3", ...(reference ? ["proseMeasure"] as const : []), ...(surface === "reference" ? ["documentationH3"] as const : [])];
      return `<${subheadingLevel} class="${classes("", ...heading, ...(subheadingLevel === "h2" && surface !== "heroNotes" ? ["documentationHeading"] as const : direct))}" id="${escapeHtml(id)}">${escapeHtml(block.text)}</${subheadingLevel}>`;
    }
  }
};

const renderSection = (
  section: ContentSection,
  headingLevel: "h1" | "h2" = "h2",
  afterHeading = "",
  surface: "reference" | "privacy" = "reference",
): string =>
  `<section class="${classes("documentation-section", "documentationSection", ...(surface === "privacy" ? ["privacySection"] as const : []))}" id="${escapeHtml(section.id)}" aria-labelledby="${escapeHtml(section.id)}-heading">
  <${headingLevel} class="${classes("", ...(headingLevel === "h2" ? [surface === "privacy" ? "privacyH2" : "referenceH2", ...(surface === "reference" ? ["proseMeasure"] as const : []), "documentationHeading"] as const : ["privacyH2", "documentationHeading"] as const))}" id="${escapeHtml(section.id)}-heading">${escapeHtml(section.heading)}</${headingLevel}>
  ${afterHeading}
  ${section.blocks.map((block, index) => renderBlock(
    block,
    section.id,
    index,
    headingLevel === "h1" ? "h2" : "h3",
    surface,
  )).join("\n  ")}
</section>`;

const renderHead = (
  content: PublicContent,
  options: {
    readonly canonicalPath: string;
    readonly description: string;
    readonly includeStructuredData?: boolean;
    readonly interactiveAppearance?: boolean;
    readonly image?: Readonly<{
      alt: string;
      height?: number;
      src: string;
      type?: string;
      width?: number;
    }>;
    readonly jsonLd?: Readonly<Record<string, unknown>>;
    readonly openGraphType?: "article" | "website";
    readonly robots?: string;
    readonly title: string;
    readonly themeColor?: string;
  },
): string => {
  const canonicalUrl = `${content.siteUrl}${options.canonicalPath}`;
  const image = options.image ?? {
    alt: content.socialCard.alt,
    height: content.socialCard.height,
    src: `${content.siteUrl}${content.socialCard.path}`,
    type: "image/png",
    width: content.socialCard.width,
  };
  const jsonLd = JSON.stringify(options.jsonLd ?? {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    applicationCategory: "DeveloperApplication",
    applicationSubCategory: content.tagline,
    author: {
      "@type": "Organization",
      name: content.maintainer.name,
      url: content.maintainer.url,
    },
    codeRepository: content.links.github,
    description: options.description,
    license: "https://opensource.org/license/mit",
    maintainer: {
      "@type": "Organization",
      name: content.maintainer.name,
      url: content.maintainer.url,
    },
    name: content.productName,
    operatingSystem: "macOS, Linux",
    url: canonicalUrl,
  }).replaceAll("<", "\\u003c");
  const robots = options.robots === undefined
    ? ""
    : `\n<meta name="robots" content="${escapeHtml(options.robots)}">`;
  const structuredData = options.includeStructuredData === false
    ? ""
    : `\n<script type="application/ld+json">${jsonLd}</script>`;

  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<meta name="description" content="${escapeHtml(options.description)}">${robots}
<link rel="canonical" href="${escapeHtml(canonicalUrl)}">
<meta property="og:type" content="${escapeHtml(options.openGraphType ?? "website")}">
<meta property="og:site_name" content="${escapeHtml(content.productName)}">
<meta property="og:title" content="${escapeHtml(options.title)}">
<meta property="og:description" content="${escapeHtml(options.description)}">
<meta property="og:url" content="${escapeHtml(canonicalUrl)}">
<meta property="og:image" content="${escapeHtml(image.src)}">
${image.type === undefined ? "" : `<meta property="og:image:type" content="${escapeHtml(image.type)}">\n`}${image.width === undefined ? "" : `<meta property="og:image:width" content="${image.width.toString()}">\n`}${image.height === undefined ? "" : `<meta property="og:image:height" content="${image.height.toString()}">\n`}<meta property="og:image:alt" content="${escapeHtml(image.alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${escapeHtml(image.src)}">
<meta name="twitter:image:alt" content="${escapeHtml(image.alt)}">
<meta name="theme-color" content="${escapeHtml(options.themeColor ?? defaultPalette.background)}">
${options.interactiveAppearance === false ? "" : '<script src="/appearance.js"></script>'}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">${structuredData}`;
};

const renderProjectResources = (content: PublicContent): string => `<aside aria-label="Oompa project information" class="${classes("project-resources", "resourceFrame", "resources")}">
  <p class="${classes("", "resourcesParagraph")}">${escapeHtml(content.productName)} is MIT licensed.</p>
  <nav aria-label="Project links" class="${classes("", "resourcesNav")}">
    <a class="${classes("", "proseLink", "focusable")}" href="${escapeHtml(content.links.github)}">GitHub</a>
    <a class="${classes("", "proseLink", "focusable")}" href="${escapeHtml(content.links.documentation)}">Documentation</a>
    <a class="${classes("", "proseLink", "focusable")}" href="${escapeHtml(content.links.security)}">Security</a>
    <a class="${classes("", "proseLink", "focusable")}" href="/privacy/">Privacy</a>
  </nav>
</aside>`;

export const renderSiteHtml = (
  content: PublicContent = publicContent,
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): string => {
  return `<!doctype html>
<html ${paletteAttributes} data-hraness-marketing-preset="editorial" data-hraness-material="lantern" lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/",
  description: content.description,
  title: `${content.productName} | ${content.tagline}`,
})}
</head>
<body>
<a class="${classes("skip-link", "skipLink", "focusable")}" href="#content">Skip to content</a>
${renderMarketingHeader(content, "/")}
<main id="content">
${renderMarketingPage(content)}
<details class="${docsClasses("legacyLinks")}" id="reference"><summary>Looking for the former reference?</summary><p>The same command and safety reference now lives in the documentation.</p><nav aria-label="Moved reference sections">${content.sections.map((section) => `<p id="${escapeHtml(section.id)}"><a data-moved-section="${escapeHtml(section.id)}" href="${escapeHtml(docsPathForSection(section.id))}">${escapeHtml(section.heading)} →</a></p>`).join("")}</nav></details>
</main>
${renderAskAiAboutThis(`${content.siteUrl}/`)}
${renderProjectResources(content)}
${renderOompaSiteFooter(environment)}
${renderOompaAnalyticsScript()}
<script src="/site.js" type="module"></script>
</body>
</html>
`;
};

export const renderPreviewHtml = (content: PublicContent = publicContent): string =>
  `<!doctype html>
<html ${previewPaletteAttributes} lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/",
  description: content.description,
  includeStructuredData: false,
  interactiveAppearance: false,
  themeColor: previewPalette.background,
  robots: "noindex, nofollow",
  title: `${content.productName} | ${content.tagline}`,
})}
</head>
<body class="${classes("preview-page", "previewPage")}">
<main id="content" class="${classes("preview-shell", "previewShell")}">
  <article class="${classes("preview-card", "previewCard")}" aria-labelledby="preview-title">
    <p class="${classes("preview-eyebrow", "previewEyebrow")}">${escapeHtml(content.tagline)}</p>
    <h1 class="${classes("", "previewHeading")}" id="preview-title">${escapeHtml(content.productName)}</h1>
    <p class="${classes("preview-summary", "previewSummary")}">${escapeHtml(content.description)}</p>
    <ul class="${classes("preview-capabilities", "previewCapabilities")}" aria-label="Oompa capabilities">
      ${[["Accounts", "Isolated by default"], ["Sessions", "Live and durable"], ["Sync", "Optional and encrypted"]].map(([label, detail], index) => `<li class="${classes("", "previewCapability", ...(index > 0 ? ["previewCapabilityFollowing"] as const : []))}"><strong class="${classes("", "previewCapabilityStrong")}">${label}</strong><span class="${classes("", "previewCapabilityDetail")}">${detail}</span></li>`).join("\n      ")}
    </ul>
    <p class="${classes("preview-status", "previewStatus")}">Web workspace <span aria-hidden="true">·</span> Local CLI</p>
  </article>
</main>
</body>
</html>
`;

export const renderPrivacyHtml = (
  content: PublicContent = publicContent,
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): string => {
  const privacy = findSection(content, "privacy");
  return `<!doctype html>
<html ${paletteAttributes} data-hraness-material="lantern" lang="en">
<head>
${renderHead(content, {
  canonicalPath: "/privacy/",
  description: "The local, encrypted cloud, and website data boundaries for Oompa.",
  title: `Privacy | ${content.productName}`,
})}
</head>
<body>
<a class="${classes("skip-link", "skipLink", "focusable")}" href="#content">Skip to content</a>
${renderMarketingHeader(content, "/privacy/")}
<main id="content" class="${classes("narrow-page", "narrowPage")}">
  ${renderSection(privacy, "h1", "", "privacy")}
  <p class="${classes("", "proseMeasure")}">Report a suspected boundary violation through <a class="${classes("", "proseLink", "focusable")}" href="${escapeHtml(content.links.privateSecurityReport)}">private vulnerability reporting</a>.</p>
</main>
${renderAskAiAboutThis(`${content.siteUrl}/privacy/`)}
${renderProjectResources(content)}
${renderOompaSiteFooter(environment)}
${renderOompaAnalyticsScript()}
</body>
</html>
`;
};

const docsLabel = (page: DocsPage): string => ({ "/docs/": "Overview", "/docs/start/": "Get started", "/docs/web/": "Web workspace", "/docs/sessions/": "Sessions & accounts", "/docs/reference/": "CLI reference", "/docs/status/": "Availability" })[page.path];

/** Static, navigable documents. Search and screen controls are progressive enhancements. */
export const renderDocsHtml = (
  page: DocsPage,
  environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment,
): string => {
  const content = publicContent;
  const reference = docsReferenceSections(page);
  // Published fragments remain navigable when a reference changes guide owner.
  const movedReferenceIds = page.path === "/docs/" ? ["project"]
    : page.path === "/docs/sessions/" ? ["first-account", "first-session"] : [];
  const movedReferences = movedReferenceIds.map((id) => findSection(content, id));
  const nav = docsPages.map((item) => `<a class="${docsClasses("navLink")}" data-doc-search="${escapeHtml([item.title, item.description, ...item.keywords, ...item.sections.map(({ heading }) => heading)].join(" "))}" href="${item.path}"${item.path === page.path ? ' aria-current="page"' : ""}>${escapeHtml(docsLabel(item))}</a>`).join("");
  const sections = [...page.sections, ...reference];
  return `<!doctype html>
<html ${paletteAttributes} data-hraness-material="lantern" lang="en"><head>
${renderHead(content, { canonicalPath: page.path, description: page.description, title: `${page.title} | Oompa`, jsonLd: { "@context": "https://schema.org", "@type": "TechArticle", headline: page.title, description: page.description, url: `${content.siteUrl}${page.path}`, dateModified: page.reviewDate, author: { "@type": "Organization", name: "Hraness", url: content.links.hraness }, isPartOf: { "@type": "WebSite", name: "Oompa", url: content.siteUrl } } })}
<link rel="alternate" type="text/markdown" href="${page.path}index.md" title="Markdown">
</head><body>
<a class="${classes("skip-link", "skipLink", "focusable")}" href="#content">Skip to content</a>
${renderMarketingHeader(content, page.path)}
<div class="${docsClasses("layout")}">
<aside class="${docsClasses("sidebar")}" aria-label="Documentation navigation">
  <a class="${docsClasses("sidebarHeading")}" href="/docs/">Documentation</a>
  <label class="${docsClasses("searchLabel")}" for="docs-search">Find a guide</label>
  <input class="${docsClasses("search")}" id="docs-search" type="search" placeholder="Search docs…" autocomplete="off" maxlength="120" aria-controls="docs-search-results">
  <div id="docs-search-results" class="${docsClasses("searchResults")}" hidden></div>
  <nav class="${docsClasses("nav")}" aria-label="Guides">${nav}</nav>
  <nav class="${docsClasses("pageNav")}" aria-label="On this page"><p>On this page</p>${sections.map((section) => `<a class="${docsClasses("sectionLink")}" href="#${escapeHtml(section.id)}">${escapeHtml(section.heading)}</a>`).join("")}</nav>
</aside>
<main class="${docsClasses("main")}" id="content">
  <header class="${docsClasses("header")}"><p class="${docsClasses("eyebrow")}">Oompa / ${escapeHtml(docsLabel(page))}</p><h1 class="${docsClasses("title")}">${escapeHtml(page.title)}</h1><p class="${docsClasses("lede")}">${escapeHtml(page.description)}</p><p class="${docsClasses("meta")}">Checked <time datetime="${page.reviewDate}">${page.reviewDate}</time> · <a href="${page.path}index.md">Read as Markdown ↗</a></p></header>
  ${page.previewId === undefined ? "" : renderProductPreview(page.previewId, "docs-preview")}
  ${page.sections.map((section) => `<section class="${docsClasses("section")}" id="${escapeHtml(section.id)}" aria-labelledby="${escapeHtml(section.id)}-heading"><h2 id="${escapeHtml(section.id)}-heading">${escapeHtml(section.heading)}</h2>${section.blocks.map((block, index) => renderBlock(block, section.id, index, "h3", "heroNotes")).join("\n")}</section>`).join("\n")}
  ${reference.length === 0 ? "" : `<section class="${docsClasses("reference")}" aria-label="Detailed reference"><h2>Detailed reference</h2><p>Exact commands, recovery steps, and compatibility details for this guide.</p>${reference.map((section) => `<details class="${docsClasses("details")}" id="${escapeHtml(section.id)}"><summary>${escapeHtml(section.heading)}</summary><div class="${docsClasses("detailBody")}">${section.blocks.map((block, index) => renderBlock(block, section.id, index, "h3", "heroNotes")).join("\n")}</div></details>`).join("\n")}</section>`}
  ${movedReferences.length === 0 ? "" : `<details class="${docsClasses("legacyLinks")}"><summary>Moved reference sections</summary><nav aria-label="Moved reference sections">${movedReferences.map((section) => `<p id="${escapeHtml(section.id)}"><a data-moved-section="${escapeHtml(section.id)}" href="${escapeHtml(docsPathForSection(section.id))}">${escapeHtml(section.heading)} →</a></p>`).join("")}</nav></details>`}
  <nav class="${docsClasses("related")}" aria-label="Continue reading">${page.related.map((item) => `<a class="${docsClasses("relatedLink")}" href="${escapeHtml(item.path)}">${escapeHtml(item.label)} →</a>`).join("")}</nav>
</main></div>
${renderAskAiAboutThis(`${content.siteUrl}${page.path}`)}
${renderProjectResources(content)}
${renderOompaSiteFooter(environment)}
${renderOompaAnalyticsScript()}
<script src="/site.js" type="module"></script>
</body></html>\n`;
};

export const renderDocsPages = (environment: Readonly<Record<string, string | undefined>> = emptySiteEnvironment): Readonly<Record<string, string>> => Object.fromEntries(docsPages.map((page) => [page.path, renderDocsHtml(page, environment)]));
