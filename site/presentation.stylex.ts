import * as stylex from "@stylexjs/stylex";

const narrow = "@media (max-width: 48rem)";
const mono = 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace';

/** Product-owned presentation only. The document palette/reset/font foundation
 * and design-kit's marketing recipes remain independently owned boundaries. */
export const sitePresentationStyles = stylex.create({
  marketingPage: { "padding-block-end": "clamp(2rem, 6vw, 4rem)" },
  topicIcon: {
    blockSize: "5.5rem", display: "block", inlineSize: "5.5rem", marginBlockEnd: "1.125rem",
  },
  shellTranscript: {
    "margin-block-start": 0, "margin-block-end": 0, marginInlineStart: 0, marginInlineEnd: 0,
    borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
  },
  installNote: {
    marginTop: "0.25rem", marginRight: 0, marginBottom: 0, marginLeft: 0,
    color: "var(--muted)", fontSize: "0.95rem", lineHeight: 1.5,
  },
  resourceFrame: {
    marginInlineStart: "auto", marginInlineEnd: "auto", maxWidth: "72rem",
    paddingInlineStart: "clamp(1.25rem, 4vw, 3rem)", paddingInlineEnd: "clamp(1.25rem, 4vw, 3rem)",
  },
  askAi: {
    "--ui-border": "var(--rule)", "--ui-foreground": "var(--foreground)", "--ui-muted": "var(--surface)",
    "--ui-muted-foreground": "var(--muted)", "--ui-primary": "var(--primary)", "--ui-ring": "var(--focus)",
    "padding-block-start": "1.25rem", "padding-block-end": "1.25rem",
    borderTopColor: "var(--rule)", borderTopStyle: "solid", borderTopWidth: "1px",
  },
  reference: {
    "inline-size": "min(100%, 72rem)", marginInlineStart: "auto", marginInlineEnd: "auto",
    paddingInlineStart: "clamp(1.25rem, 4vw, 3rem)", paddingInlineEnd: "clamp(1.25rem, 4vw, 3rem)",
    "padding-block-start": "clamp(3rem, 7vw, 5rem)",
    "border-block-start-color": "var(--rule)", "border-block-start-style": "solid", "border-block-start-width": "1px",
    "scroll-margin-block-start": "4rem",
  },
  referenceIntro: { display: "grid", gap: "0.75rem", "max-inline-size": "62ch" },
  referenceHeading: {
    marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
    fontSize: "clamp(1.75rem, 3vw, 2.5rem)", fontWeight: 500, letterSpacing: "-0.012em", lineHeight: 1.15,
    textWrap: "balance",
  },
  referenceH2: {
    fontSize: "1.5rem", fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1.2,
    "margin-block-start": 0, "margin-block-end": "1.25rem",
  },
  proseH3: { fontSize: "1rem", fontWeight: 600, "margin-block-start": "2rem", "margin-block-end": "0.5rem" },
  referenceText: { fontSize: "1rem" },
  proseMeasure: { maxWidth: "72ch" },
  proseLink: { color: "var(--link)", textDecorationThickness: "1px", textUnderlineOffset: "0.16em" },
  focusable: {
    outlineColor: { default: null, ":focus-visible": "var(--focus)" },
    outlineStyle: { default: null, ":focus-visible": "solid" },
    outlineWidth: { default: null, ":focus-visible": "2px" },
    outlineOffset: { default: null, ":focus-visible": "0.2rem" },
    borderTopLeftRadius: { default: null, ":focus-visible": "0.2rem" },
    borderTopRightRadius: { default: null, ":focus-visible": "0.2rem" },
    borderBottomLeftRadius: { default: null, ":focus-visible": "0.2rem" },
    borderBottomRightRadius: { default: null, ":focus-visible": "0.2rem" },
  },
  inlineCode: {
    backgroundColor: "color-mix(in srgb, var(--foreground) 7%, transparent)", backgroundImage: "none",
    borderTopLeftRadius: "0.3rem", borderTopRightRadius: "0.3rem", borderBottomLeftRadius: "0.3rem", borderBottomRightRadius: "0.3rem",
    fontFamily: mono, fontSize: "0.88em", overflowWrap: "anywhere",
    paddingTop: "0.08em", paddingRight: "0.36em", paddingBottom: "0.08em", paddingLeft: "0.36em",
  },
  codeBlock: {
    "--foreground": "var(--code-foreground)", "--danger": "var(--code-danger)", "--info": "var(--code-info)",
    "--muted": "var(--code-muted)", "--success": "var(--code-success)", "--warning": "var(--code-warning)",
    backgroundColor: "var(--code-background)", backgroundImage: "none", color: "var(--code-foreground)",
    borderTopLeftRadius: "0.625rem", borderTopRightRadius: "0.625rem", borderBottomLeftRadius: "0.625rem", borderBottomRightRadius: "0.625rem",
    fontFamily: mono, fontSize: "0.85rem", lineHeight: 1.6,
    "margin-block-start": "0.75rem", "margin-block-end": "0.75rem", overflowX: "auto",
    paddingTop: "1rem", paddingRight: "1.15rem", paddingBottom: "1rem", paddingLeft: "1.15rem", whiteSpace: "pre",
  },
  codeContent: { fontFamily: mono, backgroundColor: "transparent", backgroundImage: "none", paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0 },
  // The authored class selector outranked pre's logical block margin. Keep
  // that physical override later/higher without converting the logical base.
  installCommand: { fontSize: "0.8rem", marginTop: { default: null, ":is(pre)": 0 } },
  notice: {
    borderInlineStartColor: "var(--link)", borderInlineStartStyle: "solid", borderInlineStartWidth: "3px",
    "margin-block-start": "1.5rem", "margin-block-end": "1.5rem",
    paddingTop: "0.75rem", paddingRight: "1rem", paddingBottom: "0.75rem", paddingLeft: "1rem", color: "var(--muted)",
  },
  noticeStrong: { color: "var(--foreground)" },
  sectionNav: {
    "border-block-start-color": "var(--rule)", "border-block-start-style": "solid", "border-block-start-width": "1px",
    "border-block-end-color": "var(--rule)", "border-block-end-style": "solid", "border-block-end-width": "1px",
    display: "flex", flexWrap: "wrap", rowGap: "0.55rem", columnGap: "1.25rem",
    "margin-block-start": "2.5rem", "margin-block-end": 0, "padding-block-start": "1rem", "padding-block-end": "1rem",
    fontFamily: "var(--font-sans)", fontSize: "0.92rem",
  },
  sectionNavLink: {
    color: { default: "var(--muted)", ":hover": "var(--foreground)" },
    textDecorationLine: { default: "none", ":hover": "underline" },
    textDecorationColor: "currentColor", textDecorationStyle: "solid", textDecorationThickness: "auto",
  },
  documentationSection: {
    borderTopColor: "var(--rule)", borderTopStyle: "solid", borderTopWidth: { default: "1px", ":first-of-type": 0 },
    display: { default: "grid", [narrow]: "block" }, rowGap: 0, columnGap: "clamp(2rem, 5vw, 6rem)",
    gridTemplateColumns: "minmax(12rem, 0.65fr) minmax(0, 1.35fr)",
    "padding-block-start": "clamp(2.5rem, 6vw, 5rem)", "padding-block-end": "clamp(2.5rem, 6vw, 5rem)", "scroll-margin-block-start": "4rem",
  },
  documentationHeading: { gridColumn: "1", marginBottom: { default: null, [narrow]: "1.5rem" } },
  documentationBody: { gridColumn: "2" },
  // Apply only to reference direct h3. Privacy's later logical h3 rule wins
  // in the original stylesheet, so privacy uses proseH3 without this slot.
  documentationH3: { marginTop: { default: null, ":is(h3)": "1.2rem" } },
  spacedListItem: { marginTop: "0.85rem" },
  heroNotes: { maxWidth: "72ch" },
  heroNotesParagraph: { "margin-block-start": "0.75rem", "margin-block-end": 0 },
  commandList: { fontSize: "0.82rem", maxHeight: "34rem" },
  narrowPage: {
    "inline-size": "min(100%, 68rem)", marginInlineStart: "auto", marginInlineEnd: "auto",
    paddingTop: "clamp(2rem, 6vw, 4rem)", paddingRight: "clamp(1.25rem, 4vw, 3rem)",
    paddingBottom: "clamp(2rem, 6vw, 4rem)", paddingLeft: "clamp(1.25rem, 4vw, 3rem)",
  },
  privacySection: { borderTopWidth: 0, "padding-block-start": 0 },
  privacyH2: { fontSize: "clamp(1.75rem, 3vw, 2.5rem)", fontWeight: 500, letterSpacing: "-0.012em", lineHeight: 1.15, "margin-block-start": 0, "margin-block-end": "1.25rem" },
  resources: {
    borderTopColor: "var(--rule)", borderTopStyle: "solid", borderTopWidth: "1px",
    display: "flex", flexWrap: "wrap", rowGap: "1rem", columnGap: "3rem", justifyContent: "space-between",
    "padding-block-start": "2rem", "padding-block-end": "4rem", color: "var(--muted)", fontSize: "0.92rem",
  },
  resourcesParagraph: { marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 },
  resourcesNav: { fontFamily: "var(--font-sans)", display: "flex", flexWrap: "wrap", rowGap: "0.75rem", columnGap: "1.25rem" },
  skipLink: {
    backgroundColor: "var(--foreground)", backgroundImage: "none", color: "var(--background)",
    left: "1rem", top: "1rem", paddingTop: "0.7rem", paddingRight: "1rem", paddingBottom: "0.7rem", paddingLeft: "1rem",
    position: "fixed", transform: { default: "translateY(-180%)", ":focus": "translateY(0)" }, zIndex: 50,
  },
  previewPage: {
    backgroundColor: "transparent",
    backgroundImage: "radial-gradient(circle at 16% 12%, color-mix(in srgb, var(--link), transparent 80%), transparent 32rem), linear-gradient(145deg, var(--background), color-mix(in srgb, var(--surface), var(--background) 45%))",
    minHeight: "100svh",
  },
  previewShell: { alignItems: "center", display: "flex", minHeight: "100svh", paddingTop: "clamp(1.25rem, 6vw, 4rem)", paddingRight: "clamp(1.25rem, 6vw, 4rem)", paddingBottom: "clamp(1.25rem, 6vw, 4rem)", paddingLeft: "clamp(1.25rem, 6vw, 4rem)" },
  previewCard: {
    backgroundColor: { default: "color-mix(in srgb, var(--surface), transparent 20%)", "::before": "var(--link)" }, backgroundImage: "none",
    borderTopColor: "var(--rule)", borderRightColor: "var(--rule)", borderBottomColor: "var(--rule)", borderLeftColor: "var(--rule)",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopLeftRadius: "clamp(0.75rem, 2vw, 1.4rem)", borderTopRightRadius: "clamp(0.75rem, 2vw, 1.4rem)",
    borderBottomLeftRadius: "clamp(0.75rem, 2vw, 1.4rem)", borderBottomRightRadius: "clamp(0.75rem, 2vw, 1.4rem)",
    boxShadow: "0 1.5rem 5rem color-mix(in srgb, var(--foreground), transparent 88%)",
    overflowX: "hidden", overflowY: "hidden",
    paddingTop: "clamp(1.5rem, 5vw, 4rem)", paddingRight: "clamp(1.5rem, 5vw, 4rem)", paddingBottom: "clamp(1.5rem, 5vw, 4rem)", paddingLeft: "clamp(1.5rem, 5vw, 4rem)",
    position: { default: "relative", "::before": "absolute" }, width: { default: "min(100%, 58rem)", "::before": "0.32rem" },
    content: { default: null, "::before": '""' }, top: { default: null, "::before": 0 },
    right: { default: null, "::before": "auto" }, bottom: { default: null, "::before": 0 }, left: { default: null, "::before": 0 },
  },
  previewEyebrow: {
    color: "var(--muted)", fontSize: "clamp(0.8rem, 1.6vw, 0.95rem)", fontWeight: 500,
    "margin-block-start": 0, "margin-block-end": "clamp(1.5rem, 4vw, 3rem)",
  },
  previewHeading: { fontSize: "clamp(4.5rem, 17vw, 10rem)", fontWeight: 500, letterSpacing: "-0.04em", lineHeight: 0.95, marginTop: 0, marginRight: 0, marginBottom: "clamp(1.25rem, 3vw, 2rem)", marginLeft: 0 },
  previewSummary: { fontFamily: "var(--font-sans)", fontSize: "clamp(1.1rem, 2.7vw, 1.65rem)", lineHeight: 1.35, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0, maxWidth: "42rem" },
  previewCapabilities: {
    "border-block-start-color": "var(--rule)", "border-block-start-style": "solid", "border-block-start-width": "1px",
    "border-block-end-color": "var(--rule)", "border-block-end-style": "solid", "border-block-end-width": "1px",
    display: "grid", gridTemplateColumns: { default: "repeat(3, minmax(0, 1fr))", [narrow]: "1fr" },
    listStyleType: "none", listStyleImage: "none", listStylePosition: "outside",
    "margin-block-start": "clamp(1.75rem, 5vw, 3.5rem)", "margin-block-end": "1.5rem", maxWidth: "none",
    paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0,
  },
  previewCapability: {
    display: "grid", gap: "0.25rem", marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0,
    paddingTop: "1rem", paddingRight: 0, paddingBottom: "1rem", paddingLeft: 0,
  },
  previewCapabilityFollowing: {
    borderTopColor: { default: null, [narrow]: "var(--rule)" },
    borderTopStyle: { default: null, [narrow]: "solid" }, borderTopWidth: { default: null, [narrow]: "1px" },
  },
  previewCapabilityStrong: { fontSize: "0.9rem", fontWeight: 600 },
  previewCapabilityDetail: { color: "var(--muted)", fontSize: "clamp(0.78rem, 1.7vw, 0.95rem)" },
  previewStatus: { color: "var(--muted)", fontSize: "clamp(0.8rem, 1.6vw, 0.95rem)", fontWeight: 500, marginTop: 0, marginRight: 0, marginBottom: 0, marginLeft: 0 },
});

export type SitePresentationSlot = keyof typeof sitePresentationStyles;

/** Append these compiled atoms to the existing semantic hook class. Compose
 * low-specificity base slots before their explicit local overrides. */
export function sitePresentationClasses(...slots: readonly SitePresentationSlot[]): string {
  return stylex.props(...slots.map((slot) => sitePresentationStyles[slot])).className ?? "";
}
