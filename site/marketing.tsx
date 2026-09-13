import {
  MarketingCallToAction,
  MarketingFlow,
  MarketingMaker,
  MarketingPage,
  MarketingPillars,
  MarketingQuestionList,
  MarketingSection,
  MarketingSiteHeader,
  MarketingTrustBoundary,
  ProductHero,
} from "@hraness/design-kit/react/server";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type InlineContent, type PublicContent } from "./content.ts";
import { ProductPreview } from "./product-preview.tsx";
import { productHeroClassName, mobileHeaderFlowClassName } from "./marketing.stylex.ts";
import { sitePresentationClasses, type SitePresentationSlot } from "./presentation.stylex.ts";
import { SiteAppearanceMenu } from "./appearance-menu.tsx";
import { WonkaArtifact } from "./wonka-artifact.tsx";

const classes = (hook: string, ...slots: readonly SitePresentationSlot[]): string =>
  [hook, sitePresentationClasses(...slots)].filter(Boolean).join(" ");

/** Content remains text and native elements; only FAQ links use prose styling. */
function inlineContent(content: readonly InlineContent[], styleLinks: boolean): ReactNode {
  return content.map((part, index) => {
    switch (part.kind) {
      case "code":
        return <code className={classes("oompa-inline-code", "inlineCode")} key={index}>{part.value}</code>;
      case "link":
        return <a className={styleLinks ? sitePresentationClasses("proseLink") : undefined} href={part.href} key={index}>{part.label}</a>;
      case "text":
        return part.value;
    }
  });
}

export function renderMarketingHeader(content: PublicContent, currentPath: string): string {
  return renderToStaticMarkup(
    <MarketingSiteHeader
      className={`${mobileHeaderFlowClassName()} hraness-material-chrome${currentPath === "/" ? " hraness-marketing-header-surface" : ""}`}
      trailing={<SiteAppearanceMenu />}
      action={{ emphasis: "primary", href: content.links.app, label: "Open Oompa" }}
      brand={content.productName}
      brandHref="/"
      links={[
        { href: "/#product-preview", label: "Product", current: currentPath === "/" },
        { href: "/docs/", label: "Docs", current: currentPath.startsWith("/docs/") },
        { href: "/docs/status/", label: "Status" },
        { href: content.links.github, label: "GitHub" },
      ]}
    />,
  );
}

/** The homepage explains the product; procedural and operator detail lives in docs. */
export function renderMarketingPage(content: PublicContent): string {
  return renderToStaticMarkup(
    <MarketingPage className={sitePresentationClasses("marketingPage")}>
      <ProductHero
        actions={[
          { ...content.hero.primaryAction, emphasis: "primary" },
          { ...content.hero.secondaryAction, emphasis: "secondary" },
        ]}
        align="start"
        boundary={content.hero.boundary}
        className={`${productHeroClassName()} hraness-material-wall`}
        frame={<ProductPreview />}
        heading={content.hero.heading}
        headingId="oompa-title"
        name={content.productName}
        notice={<><WonkaArtifact /><p className={sitePresentationClasses("installNote")}><strong>New machine setup is temporarily paused.</strong> This release candidate is not yet admitted, and current daemon and hosted command-writer rollout remains blocked on capacity. <a href="/docs/status/">Check current availability</a></p></>}
        summary={content.hero.summary}
        tone="paper"
      />
      <MarketingPillars ariaLabel={`${content.productName} in three points`} columns={3} pillars={content.hero.pillars} />
      <MarketingSection
        heading={content.hero.proofLabel}
        headingId="how-it-works-heading"
        id="how-it-works"
        label="How it works"
        layout="split"
        summary="Use the web workspace when you want to see the work. Use the CLI when you want to script it. Both address the same sessions."
      >
        <p>These commands run only on an initialized, authorized machine after the capacity rollout prerequisites are satisfied. <a href="/docs/start/">Complete setup first.</a></p>
        <MarketingFlow
          ariaLabel={`First ${content.productName} request`}
          steps={content.hero.steps.map((step) => ({ code: step.command, detail: step.detail, label: step.label }))}
        />
      </MarketingSection>
      <MarketingTrustBoundary
        heading="Your workspace. Your machines."
        headingId="local-by-design-heading"
        id="local-by-design"
        items={content.trust}
        label="Local by design"
        summary="The browser gives you a view of the work. Execution stays with the provider tools on the machine you chose."
      />
      <MarketingQuestionList
        heading="A few things to know."
        headingId="questions-heading"
        id="questions"
        label="Questions"
        questions={content.questions.map((question) => ({ question: question.question, answer: <p>{inlineContent(question.answer, true)}</p> }))}
      />
      <MarketingMaker
        heading={content.maker.heading}
        headingId="maker-heading"
        id="maker"
        label="Built by"
        linkClassName={sitePresentationClasses("proseLink")}
        links={content.maker.links}
      >
        {content.maker.bio.length === 0 ? null : <p>{inlineContent(content.maker.bio, false)}</p>}
      </MarketingMaker>
      <MarketingCallToAction
        actions={[
          { emphasis: "primary", href: "/docs/start/", label: "Set up your first machine" },
          { emphasis: "secondary", href: content.links.app, label: "Open Oompa" },
        ]}
        footnote={content.hero.boundary}
        heading="Keep the work in view."
        headingId="closing-heading"
        id="closing"
        summary="The setup guide starts with the admitted predecessor and this candidate's unavailable install command. Wait for exact artifact admission and the capacity rollout prerequisites before starting a new machine."
        tone="paper"
      />
    </MarketingPage>,
  );
}
