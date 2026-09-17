import {
  POSTHOG_SCHEMA_VERSION,
  type PostHogSiteDefinition,
} from "@hraness/posthog";

export const oompaPostHogSite = {
  id: "oompa",
  canonicalDomain: "oompa.app",
  allowedHosts: ["oompa.app"],
  schemaVersion: POSTHOG_SCHEMA_VERSION,
  routes: [
    {
      match: "exact",
      path: "/",
      pageKind: "product_home",
      contentGroup: "product",
    },
    {
      match: "exact",
      path: "/privacy",
      pageKind: "privacy",
      contentGroup: "legal",
    },
    { match: "exact", path: "/docs", pageKind: "docs_index", contentGroup: "documentation" },
    { match: "exact", path: "/docs/start", pageKind: "guide", contentGroup: "documentation" },
    { match: "exact", path: "/docs/web", pageKind: "guide", contentGroup: "documentation" },
    { match: "exact", path: "/docs/sessions", pageKind: "guide", contentGroup: "documentation" },
    { match: "exact", path: "/docs/reference", pageKind: "reference", contentGroup: "documentation" },
    { match: "exact", path: "/docs/status", pageKind: "status", contentGroup: "documentation" },
  ],
  customEvents: [],
  delegatedEvents: [],
  stripQueryAttribution: true,
  unknownCanonicalPath: "/not-found",
} as const satisfies PostHogSiteDefinition;
