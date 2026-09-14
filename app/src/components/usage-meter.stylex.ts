import * as stylex from "@stylexjs/stylex";

const hoverCapable = "@media (hover: hover)";

export const usageMeterStyles = stylex.create({
  meter: {
    flexShrink: 0,
    height: "0.625rem",
    width: "7rem",
  },
  percent: {
    color: "var(--color-ink)",
    fontVariantNumeric: "tabular-nums",
    fontWeight: 600,
    whiteSpace: "normal",
  },
  provider: {
    color: "var(--color-ink)",
    fontWeight: 600,
  },
  root: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderColor: "var(--color-line)",
    borderRadius: "0.375rem",
    borderStyle: "solid",
    borderWidth: "1px",
    columnGap: "0.5rem",
    color: "var(--color-ink)",
    cursor: "pointer",
    display: "flex",
    flexWrap: "wrap",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    minHeight: "2rem",
    paddingBottom: "0.25rem",
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    paddingTop: "0.25rem",
    rowGap: "0.125rem",
    textAlign: "start",
    width: "100%",
    ":hover": {
      borderColor: { default: null, [hoverCapable]: "var(--color-control)" },
    },
  },
});
