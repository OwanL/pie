/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';

export interface SettingCheckboxProps {
  label: ComponentChildren;
  checked: boolean;
  onChange: () => void;
  title?: string | undefined;
  disabled?: boolean;
  /** Extra accessible name when the visible label is not descriptive. */
  ariaLabel?: string;
  hint?: ComponentChildren;
  /** Content rendered after the toggle (e.g. a chevron expander). Rendered as
   *  a sibling of the toggle button so callers place this inside a row. */
  trailing?: ComponentChildren;
}

/** The generic settings checkbox row: a `toolbar-settings-item` toggle button
 *  (check SVG + label) plus optional hint and trailing content. Decoupled from
 *  ChatPrefs/BooleanPrefKey — callers bind checked/onChange to any state. */
export function SettingCheckbox({
  label,
  checked,
  onChange,
  title,
  disabled = false,
  ariaLabel,
  hint,
  trailing,
}: SettingCheckboxProps) {
  return (
    <>
      <button
        class={`toolbar-settings-item${checked ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={ariaLabel}
        title={title}
        disabled={disabled}
        onClick={onChange}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">{label}</span>
      </button>
      {hint && <div class="toolbar-settings-item-hint">{hint}</div>}
      {trailing}
    </>
  );
}