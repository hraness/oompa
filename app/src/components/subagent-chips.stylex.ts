import * as stylex from "@stylexjs/stylex";

const hoverCapable = "@media (hover: hover)";

export const subagentChipStyles = stylex.create({
  chip: {
    alignItems: "center",
    backgroundColor: "transparent",
    borderRadius: "9999px",
    borderStyle: "solid",
    borderWidth: "1px",
    display: "inline-flex",
    fontSize: "0.75rem",
    fontWeight: 500,
    lineHeight: "1rem",
    maxWidth: "100%",
    minHeight: "1.5rem",
    paddingBottom: 0,
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
    paddingTop: 0,
  },
  closed: {
    borderColor: "var(--color-line)",
    color: "var(--color-ink-muted)",
  },
  closedInteractive: {
    ":hover": {
      color: { default: null, [hoverCapable]: "var(--color-ink)" },
    },
  },
  detail: {
    color: "var(--color-ink-muted)",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    overflowWrap: "normal",
  },
  group: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.25rem",
  },
  open: {
    borderColor: "var(--color-accent)",
    color: "var(--color-accent)",
  },
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "0.25rem",
    paddingBottom: "0.375rem",
    paddingLeft: "0.5rem",
    paddingRight: "0.5rem",
  },
  truncate: {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
});
