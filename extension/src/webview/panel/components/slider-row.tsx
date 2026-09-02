/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import type { JSX } from 'preact';

export interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** Formats the displayed value in the control head (defaults to the number). */
  formatValue?: (value: number) => string;
  hint?: ComponentChildren;
  disabled?: boolean;
  /** Accessible name when the visible label needs qualification. */
  ariaLabel?: string;
}

/** A full-width labeled range control (`toolbar-settings-ui-control` head with
 *  label + formatted value, then a `.toolbar-settings-ui-slider` range input,
 *  then an optional hint). The compact inline `.toolbar-settings-slider` rows
 *  (e.g. the sound volume row) are intentionally not covered by this primitive. */
export function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
  hint,
  disabled = false,
  ariaLabel,
}: SliderRowProps) {
  const handleInput = (event: JSX.TargetedEvent<HTMLInputElement>) => {
    onChange(Number((event.target as HTMLInputElement).value));
  };
  return (
    <div class="toolbar-settings-ui-control">
      <div class="toolbar-settings-ui-control-head">
        <span class="toolbar-settings-ui-control-label">{label}</span>
        <span class="toolbar-settings-ui-control-value">
          {formatValue ? formatValue(value) : value}
        </span>
      </div>
      <input
        type="range"
        class="toolbar-settings-slider toolbar-settings-ui-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onInput={handleInput}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
      />
      {hint && <div class="toolbar-settings-item-hint">{hint}</div>}
    </div>
  );
}