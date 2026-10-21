/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useId, useRef, useState } from 'preact/hooks';

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

/** A shared labeled numeric input. Typed drafts commit once — normalized
 *  clamped — on blur or Enter; native spinner/arrow stepping still commits
 *  immediately through the change events the user agent fires for it. The
 *  displayed value converges to the consumer's applied value, including when
 *  it rejects or re-normalizes a commit. */
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
  // Active commit burst: the change event a browser fires when focus (or an
  // Enter keypress) commits typed input, plus the companion blur/keydown.
  // Preact's onChange is the native change event here, so typing alone never
  // emits, while user-agent stepping (arrow keys, spinner, wheel) reports each
  // step with its own immediate input+change pair. Cleared by any input event
  // so a retyped draft re-commits even after a consumer rejection.
  const committed = useRef<{ raw: string; base: number } | null>(null);

  useEffect(() => setDraft(String(value)), [value, disabled]);

  // Projects the authoritative applied value into the control. The direct
  // value write keeps the native display truthful even when a same-string
  // state update would bail out of re-rendering (Preact restores the rendered
  // value only when it differs from the live DOM one).
  const projectApplied = (input: HTMLInputElement): void => {
    const applied = String(value);
    input.value = applied;
    setDraft(applied);
  };

  const commit = (input: HTMLInputElement): void => {
    if (disabled) return;
    const raw = input.value;
    if (raw === String(value)) return;
    if (raw === '' || !Number.isFinite(Number(raw))) {
      projectApplied(input);
      return;
    }
    const normalized = clamp(Number(raw), min, max);
    const burst = committed.current;
    if (normalized !== value && !(burst && burst.raw === raw && burst.base === value)) {
      onChange(normalized);
    }
    committed.current = { raw, base: value };
    setDraft(String(normalized));
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
          onInput={() => {
            committed.current = null;
          }}
          onChange={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            // Enter commits the typed draft like blur does; Escape is
            // deliberately inert.
            if (event.key === 'Enter') {
              commit(event.currentTarget);
              projectApplied(event.currentTarget);
            }
          }}
          onBlur={(event) => {
            commit(event.currentTarget);
            projectApplied(event.currentTarget);
          }}
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
