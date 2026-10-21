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
 *  immediately through the change events the user agent fires for it. An
 *  accepted commit keeps its normalized optimistic display while the host
 *  echo is pending, so delayed prefs never snap the field back to the old
 *  value, and arrows step from the optimistic value users just committed.
 *  Once the echo (or a later authoritative projection) arrives, the display
 *  converges to the consumer's applied value, including when it rejects or
 *  re-normalizes a commit. Fractional input cannot survive an integer-step
 *  field: it is refused locally, without waiting for a delayed echo to
 *  reject it. */
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
  const committed = useRef<{ raw: string; normalized: string; base: number } | null>(null);
  // Commits emitted locally whose echo has not converged into `value` yet,
  // in emission order (the protocol carries no acknowledgements, so echoes
  // are matched by value only). An echo of an older commit must never
  // overwrite the display a newer local edit established.
  const pending = useRef<number[]>([]);
  // True between an input event and its commit: while the user is typing, an
  // in-flight echo is not projected over their newer local edit.
  const editing = useRef(false);

  useEffect(() => {
    const applied = String(value);
    if (disabled) {
      editing.current = false;
      pending.current = [];
      committed.current = null;
      setDraft(applied);
      return;
    }
    const queue = pending.current;
    if (queue.length > 0) {
      if (queue[queue.length - 1] === value) {
        queue.length = 0;
      } else if (queue[0] === value) {
        queue.shift();
      } else {
        // Not an echo of any local commit: external or re-normalized
        // authoritative value; project it and drop superseded echoes.
        queue.length = 0;
      }
      if (queue.length > 0) return;
    }
    if (editing.current) return;
    setDraft(applied);
  }, [value, disabled]);

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
    editing.current = false;
    const raw = input.value;
    // Retyping the applied value stays silent, but only when no earlier
    // commit is still pending: with a stale-applied echo in flight, retyping
    // the old value is an explicit revert that must also reach the consumer.
    if (pending.current.length === 0 && raw === String(value)) return;
    if (raw === '' || !Number.isFinite(Number(raw))) {
      projectApplied(input);
      return;
    }
    const normalized = clamp(Number(raw), min, max);
    if (Number.isInteger(step) && !Number.isInteger(normalized)) {
      projectApplied(input);
      return;
    }
    const burst = committed.current;
    if ((normalized !== value || pending.current.length > 0)
        && !(burst && (burst.raw === raw || burst.normalized === raw) && burst.base === value)) {
      pending.current.push(normalized);
      onChange(normalized);
    }
    committed.current = { raw, normalized: String(normalized), base: value };
    // Keep the normalized commit on display; the echo (or a consumer
    // re-normalization) converges it later without a stale snap.
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
          onInput={(event) => {
            committed.current = null;
            editing.current = true;
            // Track typed text in state so re-renders triggered by an
            // in-flight echo never restore over newer keystrokes.
            setDraft(event.currentTarget.value);
          }}
          onChange={(event) => commit(event.currentTarget)}
          onKeyDown={(event) => {
            // Enter commits the typed draft like blur does (keeping the
            // normalized commit on display while the echo is pending);
            // Escape is deliberately inert.
            if (event.key === 'Enter') {
              commit(event.currentTarget);
            }
          }}
          onBlur={(event) => {
            commit(event.currentTarget);
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
