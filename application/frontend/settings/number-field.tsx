/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useId, useState } from 'preact/hooks';
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
  /** Short visible unit, also associated with the input for assistive tools. */
  unit?: string;
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
  unit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(String(value));
  const unitId = `settings-number-unit-${useId()}`;

  useEffect(() => setDraft(String(value)), [value, disabled]);

  const handleChange = (event: JSX.TargetedEvent<HTMLInputElement>) => {
    if (disabled) return;
    const raw = event.currentTarget.value;
    setDraft(raw);
    if (raw === '') return;
    const next = Number(raw);
    if (!Number.isFinite(next)) return;
    onChange(clamp(next, min, max));
  };

  return (
    <label class="toolbar-settings-item toolbar-settings-mode-row">
      <span class="toolbar-settings-item-label">{label}</span>
      <span class="toolbar-settings-number-control">
        <input
          class="toolbar-settings-select toolbar-settings-number-input"
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          disabled={disabled}
          aria-label={ariaLabel ?? label}
          aria-describedby={unit ? unitId : undefined}
          title={title}
          onChange={handleChange}
          onBlur={() => setDraft(String(value))}
        />
        {unit && <span id={unitId} class="toolbar-settings-number-unit">{unit}</span>}
      </span>
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
