/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

function clamp(value: number, min?: number, max?: number): number {
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

export interface NumberFieldProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  ariaLabel?: string;
  title?: string;
}

/** A shared labeled numeric input that clamps finite user input. */
export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  ariaLabel,
  title,
}: NumberFieldProps) {
  const handleChange = (event: JSX.TargetedEvent<HTMLInputElement>) => {
    const raw = event.currentTarget.value;
    if (raw === '') return;
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    onChange(clamp(next, min, max));
  };

  return (
    <label class="toolbar-settings-item toolbar-settings-mode-row">
      <span class="toolbar-settings-item-label">{label}</span>
      <input
        class="toolbar-settings-select toolbar-settings-number-input"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={ariaLabel ?? label}
        title={title}
        onChange={handleChange}
      />
    </label>
  );
}

export interface StepperProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  decreaseLabel?: string;
  increaseLabel?: string;
}

/** A compact numeric stepper for settings rows. */
export function Stepper({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
  decreaseLabel = `Decrease ${label.toLowerCase()}`,
  increaseLabel = `Increase ${label.toLowerCase()}`,
}: StepperProps) {
  const decrease = () => onChange(clamp(value - step, min, max));
  const increase = () => onChange(clamp(value + step, min, max));
  const atMin = min !== undefined && value <= min;
  const atMax = max !== undefined && value >= max;

  return (
    <div class="toolbar-settings-item toolbar-settings-stepper-row">
      <span class="toolbar-settings-item-label">{label}</span>
      <div class="toolbar-settings-stepper">
        <button
          type="button"
          class="toolbar-settings-stepper-btn"
          aria-label={decreaseLabel}
          disabled={disabled || atMin}
          onClick={decrease}
        >−</button>
        <span class="toolbar-settings-stepper-value">{value}</span>
        <button
          type="button"
          class="toolbar-settings-stepper-btn"
          aria-label={increaseLabel}
          disabled={disabled || atMax}
          onClick={increase}
        >+</button>
      </div>
    </div>
  );
}
