/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { DEFAULT_PRUNING_SETTINGS, type ChatPrefs, type ModelInfo, type PruningSettings, type PruningMode } from '../../../shared/protocol';
import { toggleChatPref } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';
import { ModelAssignmentRow } from '../components/model-assignment-row';
import { PRUNING_MODE_OPTIONS } from './settings-menu-helpers';
import { Stepper } from '../components/number-field';
import { AlwaysKeepPicker } from '../components/always-keep-picker';
import { SettingCheckbox } from '../components/setting-checkbox';
import type { OnSetPrefs, OnSetPruningSettings } from './settings-menu-types';

export const SKILL_PRUNER_BEHAVIOR_SETTING_LABELS = [
  'Show pruning summary',
  'Mode',
  'Skip small prepasses',
  'Skip below tokens',
  'Skill limit',
  'Tool limit',
  'Omitted skills (never pruned)',
  'Omitted tools (never pruned)',
] as const;

export const SKILL_PRUNER_MODEL_SETTING_LABELS = [
  'Prepass model',
  'Thinking',
] as const;

interface SkillPrunerSettingsProps {
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPrefs: OnSetPrefs;
  onSetPruningSettings: OnSetPruningSettings;
}

interface SkillPrunerModelAssignmentProps {
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  onSetPruningSettings: OnSetPruningSettings;
}

/** Context-tab behavior controls for the skill-pruning prepass. */
export function SkillPrunerSettings({ prefs, pruningSettings, skillCatalog, toolCatalog, onSetPrefs, onSetPruningSettings }: SkillPrunerSettingsProps) {
  const autoSkipBelowTokens = pruningSettings.autoSkipBelowTokens === undefined
    ? DEFAULT_PRUNING_SETTINGS.autoSkipBelowTokens!
    : pruningSettings.autoSkipBelowTokens;

  return (
    <div class="toolbar-settings-ext-settings">
      <SettingCheckbox
        label="Show pruning summary"
        checked={prefs.showPruningMessages}
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'showPruningMessages'))}
      />
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
      <SettingCheckbox
        label="Skip small prepasses"
        checked={autoSkipBelowTokens !== null}
        title="Skip the pruning prepass when its estimated input is below the configured token threshold. Skipped turns keep the full catalog and do not produce a pruning summary."
        onChange={() => onSetPruningSettings({
          autoSkipBelowTokens: autoSkipBelowTokens === null ? 1200 : null,
        })}
      />
      {autoSkipBelowTokens !== null && (
        <Stepper
          label="Skip below tokens"
          value={autoSkipBelowTokens}
          min={100}
          step={100}
          decreaseLabel="Decrease auto-skip token threshold"
          increaseLabel="Increase auto-skip token threshold"
          onChange={(value) => onSetPruningSettings({ autoSkipBelowTokens: value })}
        />
      )}
      <Stepper
        label="Skill limit"
        value={pruningSettings.skillCeiling}
        min={1}
        onChange={(value) => onSetPruningSettings({ skillCeiling: value })}
      />
      <Stepper
        label="Tool limit"
        value={pruningSettings.toolCeiling}
        min={1}
        onChange={(value) => onSetPruningSettings({ toolCeiling: value })}
      />
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

/** Models-tab model and thinking assignment for skill pruning. */
export function SkillPrunerModelAssignment({ pruningSettings, modelEntries, availableModels, onSetPruningSettings }: SkillPrunerModelAssignmentProps) {
  const selectedModel = availableModels.find((model) =>
    model.id === pruningSettings.model
    && (!pruningSettings.provider || model.provider === pruningSettings.provider));

  return (
    <div class="toolbar-settings-ext-settings">
      <ModelAssignmentRow
        label="Prepass model"
        entries={modelEntries}
        current={{ provider: pruningSettings.provider, model: pruningSettings.model }}
        emptyLabel="Select model…"
        modelAriaLabel="Pruning prepass model"
        modelTitle="Select prepass model"
        fallbackModel={selectedModel}
        thinking={{
          value: pruningSettings.thinkingLevel,
          ariaLabel: 'Pruning thinking level',
          onChange: (value) => {
            if (value !== '' && value !== 'inherit') onSetPruningSettings({ thinkingLevel: value });
          },
        }}
        onChange={(next, normalizedThinking) => {
          if (!next) return;
          onSetPruningSettings({
            model: next.model,
            provider: next.provider,
            ...(normalizedThinking !== undefined && normalizedThinking !== '' && normalizedThinking !== 'inherit'
              ? { thinkingLevel: normalizedThinking }
              : {}),
          });
        }}
        dropdownDirection="down"
      />
    </div>
  );
}
