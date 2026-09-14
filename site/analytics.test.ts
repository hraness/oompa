import { describe, expect, test } from "bun:test";

import { classifyAnalyticsRoute } from "@hraness/posthog";
import {
  createPostHogBrowserConfig,
  isPostHogBrowserEligible,
} from "@hraness/posthog/client";

import { oompaPostHogSite } from "./analytics-site.ts";

const publicProjectToken = "phc_public_test_token";

describe("oompa.app analytics boundary", () => {
  test("classifies only canonical Oompa routes without queries or fragments", () => {
    expect(classifyAnalyticsRoute(oompaPostHogSite, "https://oompa.app/"))
      .toMatchObject({
        analytics_schema_version: 1,
        canonical_domain: "oompa.app",
        canonical_path: "/",
        content_group: "product",
        page_kind: "product_home",
        site_id: "oompa",
      });
    expect(classifyAnalyticsRoute(
      oompaPostHogSite,
      "https://oompa.app/privacy/?token=private#account",
    )).toMatchObject({
      canonical_path: "/privacy",
      content_group: "legal",
      page_kind: "privacy",
    });
    expect(classifyAnalyticsRoute(oompaPostHogSite, "https://oompa.app/private/path"))
      .toMatchObject({
        canonical_path: "/not-found",
        page_kind: "other",
      });
    expect(classifyAnalyticsRoute(oompaPostHogSite, "https://www.oompa.app/"))
      .toBeNull();
    expect(classifyAnalyticsRoute(oompaPostHogSite, "https://attacker.example/"))
      .toBeNull();
    expect(classifyAnalyticsRoute(oompaPostHogSite, "https://oompa.dev/"))
      .toBeNull();
  });

  test("is eligible only for an exact production oompa.app page and public token", () => {
    const evidence = {
      hostname: "oompa.app",
      href: "https://oompa.app/",
      production: true,
      referrer: "",
    } as const;

    expect(isPostHogBrowserEligible({
      apiKey: publicProjectToken,
      evidence,
      site: oompaPostHogSite,
    })).toBe(true);
    expect(isPostHogBrowserEligible({
      apiKey: publicProjectToken,
      evidence: { ...evidence, hostname: "oompa.dev", href: "https://oompa.dev/" },
      site: oompaPostHogSite,
    })).toBe(false);
    expect(isPostHogBrowserEligible({
      apiKey: publicProjectToken,
      evidence: { ...evidence, hostname: "oompa-preview.vercel.app" },
      site: oompaPostHogSite,
    })).toBe(false);
    expect(isPostHogBrowserEligible({
      apiKey: publicProjectToken,
      evidence: { ...evidence, production: false },
      site: oompaPostHogSite,
    })).toBe(false);
    expect(isPostHogBrowserEligible({
      apiKey: "not-a-project-token",
      evidence,
      site: oompaPostHogSite,
    })).toBe(false);
  });

  test("admits six exact documentation routes without exposing preview selectors or unknown child paths", () => {
    const pages = [
      ["/docs", "docs_index"], ["/docs/start", "guide"], ["/docs/web", "guide"],
      ["/docs/sessions", "guide"], ["/docs/reference", "reference"], ["/docs/status", "status"],
    ] as const;
    expect(oompaPostHogSite.routes.map(({ path }) => path)).toEqual(["/", "/privacy", ...pages.map(([path]) => path)]);
    for (const [path, kind] of pages) {
      expect(classifyAnalyticsRoute(oompaPostHogSite, `https://oompa.app${path}/?token=private#local-account`)).toMatchObject({
        canonical_path: path, page_kind: kind, content_group: "documentation",
      });
    }
    for (const path of ["/docs/private", "/docs/start/private", "/examples/app/", "/examples/app/index.html?view=settings", "/preview/"]) {
      expect(classifyAnalyticsRoute(oompaPostHogSite, `https://oompa.app${path}`)).toMatchObject({ canonical_path: "/not-found", page_kind: "other" });
    }
  });

  test("uses anonymous cookieless memory state with invasive capture disabled", () => {
    const config = createPostHogBrowserConfig(oompaPostHogSite, {
      href: "https://oompa.app/",
      referrer: "https://www.google.com/search?q=private",
    });

    expect(config).toMatchObject({
      advanced_disable_feature_flags: true,
      autocapture: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_pageleave: true,
      capture_pageview: "history_change",
      capture_performance: {
        network_timing: false,
        web_vitals: true,
        web_vitals_allowed_metrics: ["LCP", "CLS", "FCP", "INP"],
        web_vitals_attribution: false,
      },
      cookieless_mode: "always",
      disable_conversations: true,
      disable_session_recording: true,
      disable_surveys: true,
      disable_surveys_automatic_display: true,
      mask_all_element_attributes: true,
      mask_all_text: true,
      person_profiles: "never",
      persistence: "memory",
      respect_dnt: true,
    });
  });
});
