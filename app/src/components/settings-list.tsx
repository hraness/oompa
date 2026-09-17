import * as stylex from "@stylexjs/stylex";
import type { ReactNode } from "react";
import { useId } from "react";

import { Card } from "./ui/card";
import { settingsListStyles } from "./settings-list.stylex";

/**
 * The list and row primitives the settings screen is built from.
 *
 * They are here rather than in `components/ui` because they are Oompa layout, not
 * a general interface primitive: a titled section, a labelled row with a
 * control on the right, and a segmented three-way choice. Every visual is a
 * StyleX recipe in the one same-origin stylesheet, and the one icon is inline
 * SVG rather than an image, because `img-src` names no remote origin.
 */

export function SettingsSection({
  children,
  description,
  title,
}: Readonly<{ children: ReactNode; description?: string; title: string }>) {
  return (
    <section {...stylex.props(settingsListStyles.section)}>
      <div {...stylex.props(settingsListStyles.sectionHeader)}>
        <h2 {...stylex.props(settingsListStyles.title)}>{title}</h2>
        {description === undefined
          ? null
          : <p {...stylex.props(settingsListStyles.description)}>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function SettingsCard({
  children,
  className,
}: Readonly<{ children: ReactNode; className?: string }>) {
  return <Card className={className} xstyle={settingsListStyles.card}>{children}</Card>;
}

/**
 * One labelled row. `control` sits at the end on a wide screen and wraps under
 * the label on a phone, so a 44 px target never has to share a narrow line.
 */
export function SettingsRow({
  children,
  control,
  description,
  title,
}: Readonly<{
  children?: ReactNode;
  control?: ReactNode;
  description?: ReactNode;
  title: ReactNode;
}>) {
  return (
    <div {...stylex.props(settingsListStyles.row)}>
      <div {...stylex.props(settingsListStyles.rowBody)}>
        <div {...stylex.props(settingsListStyles.rowLabel)}>
          <span {...stylex.props(settingsListStyles.rowTitle)}>{title}</span>
          {description === undefined
            ? null
            : <span {...stylex.props(settingsListStyles.description)}>{description}</span>}
        </div>
        {control === undefined ? null : <div {...stylex.props(settingsListStyles.control)}>{control}</div>}
      </div>
      {children}
    </div>
  );
}

export function EmptyRow({ children }: Readonly<{ children: ReactNode }>) {
  return <p {...stylex.props(settingsListStyles.empty)}>{children}</p>;
}

/**
 * A command line the reader is meant to run on a machine. It is text in a
 * `code` element, never a link or a clipboard-writing control. The reader can
 * select it manually without this component creating an additional copy.
 */
export function CommandHint({ children }: Readonly<{ children: string }>) {
  return (
    <code {...stylex.props(settingsListStyles.code)}>
      {children}
    </code>
  );
}

export type ChoiceOption<Value extends string> = Readonly<{ label: string; value: Value }>;

/**
 * A segmented choice rendered as a radio group: one tab stop for the group and
 * arrow keys inside it are what `role="radiogroup"` buys, and it costs no
 * dependency. Selection is reported through `onSelect`; the control stays
 * controlled by the caller so an unapplied command never moves it.
 */
export function ChoiceGroup<Value extends string>({
  disabled = false,
  label,
  onSelect,
  options,
  value,
}: Readonly<{
  disabled?: boolean;
  label: string;
  onSelect: (value: Value) => void;
  options: readonly ChoiceOption<Value>[];
  value: Value;
}>) {
  const groupId = useId();
  return (
    <div
      aria-label={label}
      {...stylex.props(settingsListStyles.choiceGroup)}
      id={groupId}
      role="radiogroup"
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            aria-checked={selected}
            {...stylex.props(
              settingsListStyles.choice,
              selected ? settingsListStyles.choiceSelected : settingsListStyles.choiceIdle,
            )}
            disabled={disabled}
            key={option.value}
            onClick={() => { onSelect(option.value); }}
            role="radio"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function BackIcon() {
  return (
    <svg
      aria-hidden="true"
      {...stylex.props(settingsListStyles.icon)}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="M15 19 8 12l7-7" />
    </svg>
  );
}
