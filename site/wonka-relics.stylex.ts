import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({
  strip: {
    color: "var(--foreground)",
    display: { default: "block", "@media (forced-colors: active)": "none" },
    flexShrink: 0,
    height: "2.625rem",
    maxWidth: "100%",
    overflow: "visible",
    pointerEvents: "none",
    width: "11.25rem",
  },
  engraving: { opacity: 0.32 },
  metal: { opacity: 0.52 },
  diffraction: { opacity: 0.42 },
  registration: { opacity: 0.18 },
  champagne: { stopColor: "color-mix(in oklab, var(--foreground) 38%, #c8b998)" },
  lavender: { stopColor: "color-mix(in oklab, var(--foreground) 32%, #b9a8c4)" },
  teal: { stopColor: "color-mix(in oklab, var(--foreground) 36%, #99bdb5)" },
});

export function wonkaRelicClasses(...slots: readonly (keyof typeof styles)[]): string {
  return stylex.props(...slots.map((slot) => styles[slot])).className ?? "";
}
