import * as stylex from "@stylexjs/stylex";

export const conversationPanelStyles = stylex.create({
  earlier: {
    display: "flex",
    justifyContent: "center",
    marginBottom: "0.25rem",
  },
  quiet: {
    color: "var(--color-ink-muted)",
    fontSize: "0.75rem",
    lineHeight: "1rem",
    marginBottom: 0,
    marginLeft: 0,
    marginRight: 0,
    marginTop: 0,
    overflowWrap: "normal",
  },
  scroller: {
    borderTopColor: "var(--color-line)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    maxHeight: "min(26rem, 55dvh)",
    minHeight: "6rem",
    overflowX: "hidden",
    overflowY: "auto",
    overscrollBehavior: "contain",
    paddingBottom: "0.625rem",
    paddingLeft: "0.75rem",
    paddingRight: "0.75rem",
    paddingTop: "0.625rem",
  },
});
