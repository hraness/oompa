import type { ClipboardEvent, KeyboardEvent, ReactNode } from "react";

import { composerRows, isComposerSubmitKey } from "../model/composer";
import { Textarea } from "./ui/textarea";

export type ComposerTextareaProps = Readonly<{
  "aria-label": string;
  disabled: boolean;
  onChange: (value: string) => void;
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Called on a plain `Enter`; the form's own submit handles the button. */
  onSubmit: () => void;
  placeholder: string;
  value: string;
}>;

/**
 * A multi-line prompt box that grows with its text. `Enter` submits and
 * `Shift+Enter` breaks the line, in the grid's start box and in every card.
 */
export function ComposerTextarea({
  disabled,
  onChange,
  onPaste,
  onSubmit,
  placeholder,
  value,
  ...rest
}: ComposerTextareaProps): ReactNode {
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!isComposerSubmitKey({
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      isComposing: event.nativeEvent.isComposing,
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    })) return;
    event.preventDefault();
    onSubmit();
  };
  return (
    <Textarea
      aria-label={rest["aria-label"]}
      disabled={disabled}
      onChange={(event) => { onChange(event.target.value); }}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      placeholder={placeholder}
      rows={composerRows(value)}
      value={value}
    />
  );
}
