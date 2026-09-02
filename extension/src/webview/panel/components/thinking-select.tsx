/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';
import type { ModelInfo, ThinkingLevel } from '../../../shared/protocol';
import { THINKING_LEVEL_LABELS, THINKING_LEVEL_OPTIONS } from '../../../shared/thinking-level.js';
import { getModelThinkingLevels } from '../composer/model-list';

export type ThinkingSelectValue = ThinkingLevel | 'inherit' | '';

export interface ThinkingSelectProps {
  value: ThinkingSelectValue;
  onChange: (value: ThinkingSelectValue) => void;
  model: ModelInfo | null;
  includeInherit?: boolean;
  disabled?: boolean;
  /** Visible row label. Omit it when the select is embedded in a chip. */
  label?: string;
  /** Accessible label for an unlabeled select, or an override for a visible label. */
  ariaLabel?: string;
}

/**
 * Shared native thinking-level select. The catalog's explicit capabilities are
 * the source of truth, while the current value is retained as a stale option
 * when a model no longer supports it (or has disappeared from the catalog).
 */
export function ThinkingSelect({
  value,
  onChange,
  model,
  includeInherit = false,
  disabled = false,
  label,
  ariaLabel,
}: ThinkingSelectProps) {
  const supportedLevels = getModelThinkingLevels(model ?? undefined);
  const options: Array<{ value: ThinkingSelectValue; label: string }> = [];

  if (includeInherit) {
    // Empty is the UI representation of inheritance. Accepting `inherit` as
    // an input value keeps this primitive convenient for protocol-backed rows.
    options.push({ value: '', label: 'Inherit' });
  }

  options.push(
    ...THINKING_LEVEL_OPTIONS.filter((option) => supportedLevels.includes(option.value)),
  );

  const selectValue = value === 'inherit' && includeInherit ? '' : value;
  const hasCurrentOption = options.some((option) => option.value === selectValue);
  if (!hasCurrentOption && value !== '') {
    options.push({
      value,
      label: value === 'inherit' ? 'Inherit' : THINKING_LEVEL_LABELS[value],
    });
  }

  const select = (
    <select
      class="toolbar-settings-select"
      value={selectValue}
      disabled={disabled}
      aria-label={ariaLabel ?? label ?? 'Thinking'}
      onChange={(event: JSX.TargetedEvent<HTMLSelectElement>) => onChange(event.currentTarget.value as ThinkingSelectValue)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );

  if (!label) return select;

  return (
    <label class="toolbar-settings-item toolbar-settings-mode-row">
      <span class="toolbar-settings-item-label">{label}</span>
      {select}
    </label>
  );
}
