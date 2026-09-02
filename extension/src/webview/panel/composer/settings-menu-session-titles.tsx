/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ModelInfo, SessionTitlesSettings } from '../../../shared/protocol';
import { ModelAssignmentRow } from '../components/model-assignment-row';
import { NumberField } from '../components/number-field';
import { SettingCheckbox } from '../components/setting-checkbox';
import type { OnSetSessionTitlesSettings } from './settings-menu-types';
import type { ModelPickerEntry } from './model-list';

export const SESSION_TITLES_BEHAVIOR_SETTING_LABELS = [
  'Generate session titles',
  'Title timeout',
] as const;

export const SESSION_TITLES_MODEL_SETTING_LABELS = [
  'Title model',
  'Title thinking',
] as const;

interface SessionTitlesBehaviorProps {
  settings: SessionTitlesSettings;
  onSetSessionTitlesSettings: OnSetSessionTitlesSettings;
}

interface SessionTitlesModelAssignmentProps extends SessionTitlesBehaviorProps {
  modelEntries: ModelPickerEntry[];
  availableModels: ModelInfo[];
}

/** Chat-tab controls for whether titles are generated and their timeout. */
export function SessionTitlesSection({ settings, onSetSessionTitlesSettings }: SessionTitlesBehaviorProps) {
  return (
    <div class="toolbar-settings-ext-settings">
      <SettingCheckbox
        label="Generate session titles"
        checked={settings.enabled}
        title="Generate a short LLM title for each new session in its default model context."
        onChange={() => onSetSessionTitlesSettings({ enabled: !settings.enabled })}
      />
      <NumberField
        label="Title timeout"
        value={settings.timeoutSec}
        min={1}
        max={60}
        step={1}
        disabled={!settings.enabled}
        ariaLabel="Session title timeout"
        title="Seconds (1–60)"
        onChange={(timeoutSec) => {
          if (Number.isInteger(timeoutSec)) onSetSessionTitlesSettings({ timeoutSec });
        }}
      />
      <div class="toolbar-settings-item toolbar-settings-note" aria-hidden="true">
        Disabled mode keeps the prompt-snippet name; no title model is called.
      </div>
    </div>
  );
}

/** Models-tab assignment used by the optional session-title generator. */
export function SessionTitlesModelAssignment({ settings, modelEntries, availableModels, onSetSessionTitlesSettings }: SessionTitlesModelAssignmentProps) {
  const selectedModel = availableModels.find((model) =>
    model.id === settings.model
    && (!settings.provider || model.provider === settings.provider),
  );

  return (
    <div class="toolbar-settings-ext-settings">
      <ModelAssignmentRow
        label="Title model"
        entries={modelEntries}
        current={{ provider: settings.provider, model: settings.model }}
        emptyLabel="Select model…"
        modelAriaLabel="Session title model"
        modelTitle="Select session title model"
        fallbackModel={selectedModel}
        disabled={!settings.enabled}
        thinking={{
          value: settings.thinkingLevel,
          label: 'Title thinking',
          ariaLabel: 'Session title thinking level',
          onChange: (value) => {
            if (value !== '' && value !== 'inherit') {
              onSetSessionTitlesSettings({ thinkingLevel: value });
            }
          },
        }}
        onChange={(next, normalizedThinking) => {
          if (!next) return;
          onSetSessionTitlesSettings({
            model: next.model,
            provider: next.provider,
            ...(normalizedThinking !== undefined && normalizedThinking !== '' && normalizedThinking !== 'inherit'
              ? { thinkingLevel: normalizedThinking }
              : {}),
          });
        }}
        dropdownDirection="down"
      />
      {!settings.enabled && (
        <div class="toolbar-settings-item-hint">Enable session titles in Chat to change this assignment.</div>
      )}
    </div>
  );
}
