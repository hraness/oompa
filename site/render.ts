// This entry is executed only from the finalized compiler's captured SSR
// output during the static build. It is never copied to the public website.
export { renderDocsPages, renderPreviewHtml, renderPrivacyHtml, renderSiteHtml } from "./template.ts";
