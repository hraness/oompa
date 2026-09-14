import * as stylex from "@stylexjs/stylex";

const small = "@media (max-width: 48rem)";

const styles = stylex.create({
  artifact: {
    position: "absolute", top: { default: "-1rem", [small]: "-0.5rem" },
    right: { default: "-3rem", [small]: "-9rem" },
    width: { default: "32rem", [small]: "27rem" },
    height: { default: "30rem", [small]: "25rem" },
    pointerEvents: "none", userSelect: "none", zIndex: -1,
    opacity: { default: 0.74, [small]: 0.20 },
    maskImage: "linear-gradient(90deg, transparent 2%, #000 49%, #000 85%, transparent)",
    display: { default: "block", "@media (forced-colors: active)": "none" },
  },
  canvas: { display: "block", width: "100%", height: "100%" },
  fallback: {
    position: "absolute", inset: 0, width: "100%", height: "100%",
    color: "var(--foreground)", opacity: { default: 0.36, ':is([data-wonka-ready="true"] > svg)': 0 },
  },
  seals: {
    position: "absolute", right: { default: "0.25rem", [small]: "0.75rem" },
    top: { default: "24rem", [small]: "21rem" },
    width: { default: "11rem", [small]: "8rem" },
    pointerEvents: "none", opacity: { default: 0.52, [small]: 0.24 }, zIndex: -1,
  },
});

export const artifactClass = (slot: keyof typeof styles): string => stylex.props(styles[slot]).className ?? "";
