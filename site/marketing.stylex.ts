import * as stylex from "@stylexjs/stylex";

const marketingStyles = stylex.create({
  productHero: {
    position: "relative",
    isolation: "isolate",
    overflowX: "clip",
    overflowY: "clip",
    paddingBlock: { default: null, ":is(header)": "var(--hraness-marketing-hero-space, 3.5rem 4rem)" },
    gap: { default: null, ":is(header)": "clamp(1.5rem, 3vw, 2.5rem)" },
  },
  // A wrapping mobile header has no fixed height. Keep fragment destinations
  // visible without changing the public component's sticky desktop default.
  mobileHeaderFlow: { position: { default: null, "@media (max-width: 48rem)": "static" } },
});

/** Compact the product-owned outer spacing without replacing shared recipes. */
export function productHeroClassName(): string {
  return stylex.props(marketingStyles.productHero).className ?? "";
}

export function mobileHeaderFlowClassName(): string {
  return stylex.props(marketingStyles.mobileHeaderFlow).className ?? "";
}
