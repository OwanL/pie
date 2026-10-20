/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ModelInfo, ThinkingLevel } from '../../lib/protocol/index.js';
import { ModelPicker } from './model-picker';
import { useContext } from 'preact/hooks';
import { RemovedProvidersContext } from './removed-providers';
import type { ModelPickerEntry } from '../composer/model-list';
import { formatModelSpec, normalizeThinkingLevelForModel, parseModelSpec } from '../composer/model-list';
import { ThinkingSelect, type ThinkingSelectValue } from './thinking-select';

export interface ModelAssignment {
  provider: string;
  model: string;
}

export interface ModelAssignmentThinkingConfig {
  value: ThinkingSelectValue;
  onChange: (value: ThinkingSelectValue) => void;
  includeInherit?: boolean;
  label?: string;
  ariaLabel?: string;
}

export interface ModelAssignmentRowProps {
  label: string;
  entries: ModelPickerEntry[];
  current: ModelAssignment | null;
  onChange: (value: ModelAssignment | null, normalizedThinking?: ThinkingSelectValue) => void;
  emptyLabel: string;
  clearable?: boolean;
  disabled?: boolean;
  ariaDescribedBy?: string;
  thinking?: ModelAssignmentThinkingConfig;
  /** Model used when `current` is null (for example the active model). */
  fallbackModel?: ModelInfo | null;
  dropdownDirection?: 'up' | 'down';
  modelAriaLabel?: string;
  modelTitle?: string;
  clearLabel?: string;
  clearTitle?: string;
  compactLabels?: boolean;
}

function findEntry(entries: ModelPickerEntry[], current: ModelAssignment | null): ModelPickerEntry | undefined {
  if (!current?.model) return undefined;
  return entries.find((entry) =>
    entry.model.id === current.model
    && (!current.provider || entry.model.provider === current.provider),
  );
}

/** Shared provider-qualified model picker row and optional thinking row. */
export function ModelAssignmentRow({
  label,
  entries: catalogEntries,
  current,
  onChange,
  emptyLabel,
  clearable = false,
  disabled = false,
  thinking,
  fallbackModel = null,
  dropdownDirection = 'up',
  modelAriaLabel,
  modelTitle,
  clearLabel,
  clearTitle,
  compactLabels = false,
  ariaDescribedBy,
}: ModelAssignmentRowProps) {
  const removedProviderIds = useContext(RemovedProvidersContext);
  const removed = !!current?.provider && removedProviderIds.includes(current.provider);
  const entries = catalogEntries.filter(entry => !removedProviderIds.includes(entry.model.provider));
  const selectedEntry = findEntry(entries, current);
  const fallbackMatchesCurrent = !!fallbackModel && !!current
    && fallbackModel.id === current.model
    && (!current.provider || fallbackModel.provider === current.provider);
  const selectedModel = removed ? null : selectedEntry?.model
    ?? (fallbackModel && !removedProviderIds.includes(fallbackModel.provider) && (!current || fallbackMatchesCurrent) ? fallbackModel : null);
  const modelValue = current?.model
    ? (current.provider ? formatModelSpec({ provider: current.provider, id: current.model }) : current.model)
    : '';
  const modelLabel = removed ? `${modelValue} · Unavailable (removed provider)` : current?.model
    ? (selectedEntry?.label ?? (current.provider ? formatModelSpec({ provider: current.provider, id: current.model }) : current.model))
    : emptyLabel;

  const normalizeThinking = (model: ModelInfo | null): ThinkingSelectValue | undefined => {
    if (!thinking) return undefined;
    if (thinking.value === '' || thinking.value === 'inherit') return thinking.value;
    return normalizeThinkingLevelForModel(thinking.value as ThinkingLevel, model ?? undefined);
  };

  const handleModelChange = (spec: string) => {
    const { provider, id } = parseModelSpec(spec);
    const entry = entries.find((candidate) =>
      candidate.model.id === id && (!provider || candidate.model.provider === provider),
    );
    if (!entry) return;
    onChange(
      { provider: entry.model.provider, model: entry.model.id },
      normalizeThinking(entry.model),
    );
  };

  const handleClear = () => onChange(null, normalizeThinking(fallbackModel));
  const resolvedClearLabel = clearLabel ?? `Use ${emptyLabel.toLowerCase()}`;

  return (
    <>
      <div class="toolbar-settings-item toolbar-settings-mode-row" data-settings-label={label}>
        <span class="toolbar-settings-item-label">{compactLabels ? 'Model' : label}</span>
        <div class="toolbar-settings-inline-actions">
          <ModelPicker
            compact
            dropdownDirection={dropdownDirection}
            value={modelValue}
            label={modelLabel}
            ariaLabel={modelAriaLabel ?? label}
            title={modelTitle ?? `Select ${label.toLowerCase()}`}
            entries={entries}
            disabled={disabled}
            ariaDescribedBy={ariaDescribedBy}
            onChange={handleModelChange}
          />
          {clearable && current?.model && (
            <button
              type="button"
              class="toolbar-settings-stepper-btn"
              disabled={disabled}
              aria-describedby={ariaDescribedBy}
              aria-label={resolvedClearLabel}
              title={clearTitle ?? resolvedClearLabel}
              onClick={handleClear}
            >×</button>
          )}
        </div>
      </div>
      {thinking && (() => {
        const thinkingLabel = thinking.label ?? 'Thinking';
        return (
          <label class="toolbar-settings-item toolbar-settings-mode-row" data-settings-label={thinkingLabel}>
            <span class="toolbar-settings-item-label">{compactLabels ? 'Thinking' : thinkingLabel}</span>
            <ThinkingSelect
              value={thinking.value}
              model={selectedModel}
              includeInherit={thinking.includeInherit}
              disabled={disabled || removed}
              ariaLabel={thinking.ariaLabel ?? thinkingLabel}
              ariaDescribedBy={ariaDescribedBy}
              onChange={thinking.onChange}
            />
          </label>
        );
      })()}
    </>
  );
}
