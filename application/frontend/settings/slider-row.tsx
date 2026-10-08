/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren } from 'preact';
import type { JSX } from 'preact';
import { SettingsHelp } from './settings-help';

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
  /** Native hover tooltip for controls whose visible hint needs a compact summary. */
  tooltip?: string;
}

/** A compact full-width range control with label/help, native range input, and
 *  formatted value as three direct children. The compact inline
 *  `.toolbar-settings-slider` rows (e.g. the sound volume row) are intentionally
 *  not covered by this primitive. */
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
  tooltip,
}: SliderRowProps) {
  const handleInput = (event: JSX.TargetedEvent<HTMLInputElement>) => {
    onChange(Number((event.target as HTMLInputElement).value));
  };
  return (
    <div class="toolbar-settings-ui-control toolbar-settings-slider-row">
      <div class="toolbar-settings-ui-control-head">
        <span>
          <span class="toolbar-settings-ui-control-label">{label}</span>
          {hint && <SettingsHelp label={label}>{hint}</SettingsHelp>}
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
        aria-valuetext={formatValue ? formatValue(value) : undefined}
        title={tooltip}
      />
      <span class="toolbar-settings-ui-control-value">
        {formatValue ? formatValue(value) : value}
      </span>
    </div>
  );
}