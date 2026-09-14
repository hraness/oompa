import { designPaletteLabels, designPalettes } from "@hraness/design-kit";
import type { Ref } from "react";
import * as stylex from "@stylexjs/stylex";
import { appearanceMenuStyles as styles } from "./appearance-menu.stylex";

/** One product-owned menu for the static site and mounted app headers. */
export function NativeAppearanceMenu({ managed = false, ref }: Readonly<{ managed?: boolean; ref?: Ref<HTMLDetailsElement> }>) {
  return (
    <details {...stylex.props(styles.menu)} data-oompa-appearance data-oompa-managed={managed ? "" : undefined} data-ready="false" ref={ref}>
      <summary {...stylex.props(styles.trigger, styles.focus)} aria-disabled={managed || undefined} aria-label="Appearance: Paper, System" tabIndex={managed ? -1 : undefined} title="Appearance">
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20.5 13.2A8.5 8.5 0 0 1 10.8 3.5 8.5 8.5 0 1 0 20.5 13.2Z" />
        </svg>
      </summary>
      <div {...stylex.props(styles.panel)}>
        <label {...stylex.props(styles.label)}>
          Theme
          <select {...stylex.props(styles.select, styles.focus)} data-oompa-palette defaultValue="paper" disabled={managed}>
            {designPalettes.map((palette) => <option value={palette} key={palette}>{designPaletteLabels[palette]}</option>)}
          </select>
        </label>
        <label {...stylex.props(styles.label)}>
          Appearance
          <select {...stylex.props(styles.select, styles.focus)} data-oompa-mode defaultValue="system" disabled={managed}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </select>
        </label>
      </div>
    </details>
  );
}
