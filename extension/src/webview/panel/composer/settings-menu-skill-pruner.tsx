/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { DEFAULT_PRUNING_SETTINGS, type ChatPrefs, type ModelInfo, type PruningSettings, type PruningMode, type ThinkingLevel } from '../../../shared/protocol';
import { toggleChatPref } from '../chat-prefs';
import { formatModelSpec, getModelThinkingLevels, orderModelsForPicker, parseModelSpec } from './model-list';
import { ModelPicker } from '../components/model-picker';
import { PRUNING_MODE_OPTIONS, THINKING_LEVEL_OPTIONS } from './settings-menu-helpers';
import { AlwaysKeepPicker } from '../components/always-keep-picker';
import type { OnSetPrefs, OnSetPruningSettings } from './settings-menu-types';

interface SkillPrunerSettingsProps {
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPrefs: OnSetPrefs;
  onSetPruningSettings: OnSetPruningSettings;
}

export function SkillPrunerSettings({ prefs, pruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPrefs, onSetPruningSettings }: SkillPrunerSettingsProps) {
  const selectedModelSpec = pruningSettings.provider && pruningSettings.model
    ? formatModelSpec({ provider: pruningSettings.provider, id: pruningSettings.model })
    : pruningSettings.model;
  const modelLabel =
    modelEntries.find((entry) =>
      entry.model.id === pruningSettings.model
      && (!pruningSettings.provider || entry.model.provider === pruningSettings.provider))?.label
    || pruningSettings.model
    || 'Select model…';
  const autoSkipBelowTokens = pruningSettings.autoSkipBelowTokens === undefined
    ? DEFAULT_PRUNING_SETTINGS.autoSkipBelowTokens!
    : pruningSettings.autoSkipBelowTokens;
  const selectedModel = availableModels.find((model) =>
    model.id === pruningSettings.model
    && (!pruningSettings.provider || model.provider === pruningSettings.provider));
  const supportedThinkingLevels = getModelThinkingLevels(selectedModel);
  const thinkingOptions = THINKING_LEVEL_OPTIONS.filter((option) =>
    supportedThinkingLevels.includes(option.value));

  return (
    <div class="toolbar-settings-ext-settings">
      <button
        class={`toolbar-settings-item${prefs.showPruningMessages ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={prefs.showPruningMessages}
        onClick={() => onSetPrefs(toggleChatPref(prefs, 'showPruningMessages'))}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={prefs.showPruningMessages ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Show pruning summary</span>
      </button>
      <div class="toolbar-settings-item toolbar-settings-mode-row">
        <span class="toolbar-settings-item-label">Mode</span>
        <select
          class="toolbar-settings-select"
          value={pruningSettings.mode}
          onChange={(e) => onSetPruningSettings({ mode: (e.target as HTMLSelectElement).value as PruningMode })}
          aria-label="Pruning mode"
        >
          {PRUNING_MODE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <button
        class={`toolbar-settings-item${autoSkipBelowTokens !== null ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={autoSkipBelowTokens !== null}
        title="Skip the pruning prepass when its estimated input is below the configured token threshold. Skipped turns keep the full catalog and do not produce a pruning summary."
        onClick={() => onSetPruningSettings({
          autoSkipBelowTokens: autoSkipBelowTokens === null ? 1200 : null,
        })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={autoSkipBelowTokens !== null ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Skip small prepasses</span>
      </button>
      {autoSkipBelowTokens !== null && (
        <div class="toolbar-settings-item toolbar-settings-stepper-row">
          <span class="toolbar-settings-item-label">Skip below tokens</span>
          <div class="toolbar-settings-stepper">
            <button
              type="button"
              class="toolbar-settings-stepper-btn"
              aria-label="Decrease auto-skip token threshold"
              disabled={autoSkipBelowTokens <= 100}
              onClick={() => onSetPruningSettings({
                autoSkipBelowTokens: Math.max(100, autoSkipBelowTokens - 100),
              })}
            >−</button>
            <span class="toolbar-settings-stepper-value">{autoSkipBelowTokens}</span>
            <button
              type="button"
              class="toolbar-settings-stepper-btn"
              aria-label="Increase auto-skip token threshold"
              onClick={() => onSetPruningSettings({
                autoSkipBelowTokens: autoSkipBelowTokens + 100,
              })}
            >+</button>
          </div>
        </div>
      )}
      <div class="toolbar-settings-item toolbar-settings-mode-row">
        <span class="toolbar-settings-item-label">Prepass model</span>
        <ModelPicker
          compact
          dropdownDirection="down"
          value={selectedModelSpec}
          label={modelLabel}
          ariaLabel="Pruning prepass model"
          title="Select prepass model"
          entries={modelEntries}
          onChange={(spec) => {
            // Persist the shared picker identity in the config's separate fields.
            const { id, provider } = parseModelSpec(spec);
            const selected = availableModels.find((m) => m.id === id && (!provider || m.provider === provider));
            if (selected) {
              const supported = getModelThinkingLevels(selected);
              const thinkingLevel = supported.includes(pruningSettings.thinkingLevel)
                ? pruningSettings.thinkingLevel
                : (supported[0] ?? 'off');
              onSetPruningSettings({ model: selected.id, provider: selected.provider, thinkingLevel });
            }
          }}
        />
      </div>
      <div class="toolbar-settings-item toolbar-settings-mode-row">
        <span class="toolbar-settings-item-label">Thinking</span>
        <select
          class="toolbar-settings-select"
          value={pruningSettings.thinkingLevel}
          onChange={(e) => onSetPruningSettings({ thinkingLevel: (e.target as HTMLSelectElement).value as ThinkingLevel })}
          aria-label="Pruning thinking level"
        >
          {thinkingOptions.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
      <div class="toolbar-settings-item toolbar-settings-stepper-row">
        <span class="toolbar-settings-item-label">Skill limit</span>
        <div class="toolbar-settings-stepper">
          <button
            type="button"
            class="toolbar-settings-stepper-btn"
            aria-label="Decrease skill limit"
            disabled={pruningSettings.skillCeiling <= 1}
            onClick={() => onSetPruningSettings({ skillCeiling: Math.max(1, pruningSettings.skillCeiling - 1) })}
          >−</button>
          <span class="toolbar-settings-stepper-value">{pruningSettings.skillCeiling}</span>
          <button
            type="button"
            class="toolbar-settings-stepper-btn"
            aria-label="Increase skill limit"
            onClick={() => onSetPruningSettings({ skillCeiling: pruningSettings.skillCeiling + 1 })}
          >+</button>
        </div>
      </div>
      <div class="toolbar-settings-item toolbar-settings-stepper-row">
        <span class="toolbar-settings-item-label">Tool limit</span>
        <div class="toolbar-settings-stepper">
          <button
            type="button"
            class="toolbar-settings-stepper-btn"
            aria-label="Decrease tool limit"
            disabled={pruningSettings.toolCeiling <= 1}
            onClick={() => onSetPruningSettings({ toolCeiling: Math.max(1, pruningSettings.toolCeiling - 1) })}
          >−</button>
          <span class="toolbar-settings-stepper-value">{pruningSettings.toolCeiling}</span>
          <button
            type="button"
            class="toolbar-settings-stepper-btn"
            aria-label="Increase tool limit"
            onClick={() => onSetPruningSettings({ toolCeiling: pruningSettings.toolCeiling + 1 })}
          >+</button>
        </div>
      </div>
      <AlwaysKeepPicker
        label="Omitted skills (never pruned)"
        selected={pruningSettings.skillAlwaysKeep}
        catalog={skillCatalog}
        category="skill"
        onChange={(next) => onSetPruningSettings({ skillAlwaysKeep: next })}
      />
      <AlwaysKeepPicker
        label="Omitted tools (never pruned)"
        selected={pruningSettings.toolAlwaysKeep}
        catalog={toolCatalog}
        category="tool"
        onChange={(next) => onSetPruningSettings({ toolAlwaysKeep: next })}
      />
    </div>
  );
}
