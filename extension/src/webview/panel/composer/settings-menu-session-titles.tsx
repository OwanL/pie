/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ModelInfo, SessionTitlesSettings } from '../../../shared/protocol';
import { formatModelSpec, parseModelSpec } from './model-list';
import { ModelPicker } from '../components/model-picker';
import type { OnSetSessionTitlesSettings } from './settings-menu-types';
import type { ModelPickerEntry } from './model-list';

interface SessionTitlesSettingsProps {
  settings: SessionTitlesSettings;
  modelEntries: ModelPickerEntry[];
  availableModels: ModelInfo[];
  onSetSessionTitlesSettings: OnSetSessionTitlesSettings;
}

/**
 * Settings panel for optional LLM session titles (Chat tab). Mirrors
 * {@link SkillPrunerSettings}'s structure: a `toolbar-settings-ext-settings`
 * container with an enable checkbox row and a provider-qualified model picker
 * row filtered like the skill-pruner prepass picker (provider toggles apply,
 * subagent eligibility warnings do not). No dedicated CSS — reuses the shared
 * settings-menu classes.
 */
export function SessionTitlesSection({ settings, modelEntries, onSetSessionTitlesSettings }: SessionTitlesSettingsProps) {
  const selectedModelSpec = settings.provider && settings.model
    ? formatModelSpec({ provider: settings.provider, id: settings.model })
    : settings.model;
  const modelLabel =
    modelEntries.find((entry) =>
      entry.model.id === settings.model
      && (!settings.provider || entry.model.provider === settings.provider))?.label
    || settings.model
    || 'Select model…';

  return (
    <div class="toolbar-settings-ext-settings">
      <button
        class={`toolbar-settings-item${settings.enabled ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.enabled}
        title="Generate a short LLM title for each new session in its default model context."
        onClick={() => onSetSessionTitlesSettings({ enabled: !settings.enabled })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.enabled ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Generate session titles</span>
      </button>
      {settings.enabled && (
        <>
          <div class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">Title model</span>
            <ModelPicker
              compact
              dropdownDirection="down"
              value={selectedModelSpec}
              label={modelLabel}
              ariaLabel="Session title model"
              title="Select session title model"
              entries={modelEntries}
              onChange={(spec) => {
                // Persist the shared picker identity in the config's separate fields.
                const { id, provider } = parseModelSpec(spec);
                onSetSessionTitlesSettings({ model: id, provider: provider ?? settings.provider });
              }}
            />
          </div>
          <label class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">Title thinking</span>
            <select
              aria-label="Session title thinking level"
              value={settings.thinkingLevel}
              onChange={(event) => onSetSessionTitlesSettings({ thinkingLevel: event.currentTarget.value as SessionTitlesSettings['thinkingLevel'] })}
            >
              {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => <option value={level}>{level}</option>)}
            </select>
          </label>
          <label class="toolbar-settings-item toolbar-settings-mode-row">
            <span class="toolbar-settings-item-label">Title timeout</span>
            <input
              aria-label="Session title timeout"
              type="number"
              min={1}
              max={60}
              step={1}
              value={settings.timeoutSec}
              title="Seconds (1–60)"
              style="width:54px"
              onChange={(event) => {
                const timeoutSec = Number(event.currentTarget.value);
                if (Number.isInteger(timeoutSec) && timeoutSec >= 1 && timeoutSec <= 60) {
                  onSetSessionTitlesSettings({ timeoutSec });
                }
              }}
            />
          </label>
        </>
      )}
      <div class="toolbar-settings-item" style="padding:2px 8px;opacity:0.6;font-size:11px;cursor:default" aria-hidden="true">
        Disabled mode keeps the prompt-snippet name; no title model is called.
      </div>
    </div>
  );
}