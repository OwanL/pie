/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { type ChatPrefs, type ModelInfo, type PruningSettings, type PruningMode } from '../../lib/protocol/index.js';
import { toggleChatPref } from '../shell/chat-prefs';
import { orderModelsForPicker } from '../composer/model-list';
import { ModelAssignmentRow } from './model-assignment-row';
import { PRUNING_MODE_OPTIONS } from './settings-menu-helpers';
import { Stepper } from './number-field';
import { AlwaysKeepPicker } from './always-keep-picker';
import { SettingCheckbox } from './setting-checkbox';
import { SettingsHelp } from './settings-help';
import type { OnSetPrefs, OnSetPruningSettings } from './settings-menu-types';

export const SKILL_PRUNER_BEHAVIOR_SETTING_LABELS = [
  'Show pruning summary',
  'Mode',
  'Main agents',
  'Subagents',
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
  compactLabels?: boolean;
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  onSetPruningSettings: OnSetPruningSettings;
}

/** Context-tab behavior controls for the skill-pruning prepass. */
export function SkillPrunerSettings({ prefs, pruningSettings, skillCatalog, toolCatalog, onSetPrefs, onSetPruningSettings }: SkillPrunerSettingsProps) {
  return (
    <div class="toolbar-settings-ext-settings">
      <SettingCheckbox
        label="Show pruning summary"
        checked={prefs.showPruningMessages}
        onChange={() => onSetPrefs(toggleChatPref(prefs, 'showPruningMessages'))}
      />
      <div class="toolbar-settings-content-group" role="group" aria-label="Scope & limits">
        <h3 class="toolbar-settings-content-group-title">Scope &amp; limits<SettingsHelp label="Scope & limits">
          Choose which agent turns can use the pruning prepass, its overall mode, and maximum numbers of skills and tools to retain.
        </SettingsHelp></h3>
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
          label="Main agents"
          checked={pruningSettings.mainAgentEnabled ?? true}
          onChange={() => onSetPruningSettings({ mainAgentEnabled: !(pruningSettings.mainAgentEnabled ?? true) })}
        />
        <SettingCheckbox
          label="Subagents"
          checked={pruningSettings.subagentEnabled ?? true}
          onChange={() => onSetPruningSettings({ subagentEnabled: !(pruningSettings.subagentEnabled ?? true) })}
        />
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
      </div>
      <div class="toolbar-settings-content-group" role="group" aria-label="Always keep">
        <h3 class="toolbar-settings-content-group-title">Always keep<SettingsHelp label="Always keep">
          Selected skills and tools are excluded from pruning and always remain available.
        </SettingsHelp></h3>
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
    </div>
  );
}

/** Models-tab model and thinking assignment for skill pruning. */
export function SkillPrunerModelAssignment({ compactLabels = false, pruningSettings, modelEntries, availableModels, onSetPruningSettings }: SkillPrunerModelAssignmentProps) {
  const selectedModel = availableModels.find((model) =>
    model.id === pruningSettings.model
    && (!pruningSettings.provider || model.provider === pruningSettings.provider));

  return (
    <div class="toolbar-settings-ext-settings">
      <ModelAssignmentRow
        compactLabels={compactLabels}
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
