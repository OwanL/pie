/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolResultPruningSettings } from '../../../shared/protocol';
import { SettingCheckbox } from '../components/setting-checkbox';
import type { OnSetToolResultPruningSettings } from './settings-menu-types';

export const TOOL_RESULT_PRUNER_SETTING_LABELS = [
  'Enabled',
  'Profile',
  'Tools',
  'ANSI strip',
  'Trim whitespace',
  'Collapse blank runs',
  'Minify JSON',
  'ls -l → names',
  'git log → oneline',
  'grep/rg → group by path',
] as const;

interface ToolResultPrunerSettingsProps {
  settings: ToolResultPruningSettings;
  onSetToolResultPruningSettings: OnSetToolResultPruningSettings;
}

/**
 * Settings panel for the `tool-result-pruner` extension (lossless
 * tool_result output pruning). Mirrors {@link SkillPrunerSettings}'s
 * structure: a `toolbar-settings-ext-settings` container holding
 * `toolbar-settings-item` checkbox rows and a `toolbar-settings-mode-row`
 * select. No dedicated CSS — reuses the shared settings-menu classes.
 */
export function ToolResultPrunerSettings({ settings, onSetToolResultPruningSettings }: ToolResultPrunerSettingsProps) {
  const setRule = (rule: keyof ToolResultPruningSettings['rules'], value: boolean) =>
    onSetToolResultPruningSettings({ rules: { ...settings.rules, [rule]: value } });
  const lossyDisabled = settings.profile !== 'default';
  return (
    <div class="toolbar-settings-ext-settings">
      <SettingCheckbox
        label="Enabled"
        checked={settings.enabled}
        onChange={() => onSetToolResultPruningSettings({ enabled: !settings.enabled })}
      />
      <div class="toolbar-settings-item toolbar-settings-mode-row">
        <span class="toolbar-settings-item-label">Profile</span>
        <select
          class="toolbar-settings-select"
          value={settings.profile}
          onChange={(e) => onSetToolResultPruningSettings({ profile: (e.target as HTMLSelectElement).value as 'default' | 'security' })}
          aria-label="Tool-result pruning profile"
        >
          <option value="default">Default</option>
          <option value="security">Security</option>
        </select>
      </div>
      <div class="toolbar-settings-item toolbar-settings-mode-row">
        <span class="toolbar-settings-item-label">Tools</span>
        <input
          class="toolbar-settings-select toolbar-settings-text"
          type="text"
          value={settings.tools ? settings.tools.join(', ') : ''}
          placeholder="All tools (read always skipped)"
          onChange={(e) => {
            const text = (e.target as HTMLInputElement).value;
            const tools = text.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
            onSetToolResultPruningSettings({ tools: text.trim() === '' ? null : tools });
          }}
          aria-label="Tool-result pruning tools allowlist (comma-separated)"
        />
      </div>
      <SettingCheckbox
        label="ANSI strip"
        checked={settings.rules.ansi}
        onChange={() => setRule('ansi', !settings.rules.ansi)}
      />
      <SettingCheckbox
        label="Trim whitespace"
        checked={settings.rules.whitespace}
        onChange={() => setRule('whitespace', !settings.rules.whitespace)}
      />
      <SettingCheckbox
        label="Collapse blank runs"
        checked={settings.rules.blankRun}
        onChange={() => setRule('blankRun', !settings.rules.blankRun)}
      />
      <SettingCheckbox
        label="Minify JSON"
        checked={settings.rules.jsonMinify}
        onChange={() => setRule('jsonMinify', !settings.rules.jsonMinify)}
      />
      <div class="toolbar-settings-item toolbar-settings-note" aria-hidden="true">
        Lossy (Default profile only — recallable via raw stash)
      </div>
      <SettingCheckbox
        label="ls -l → names"
        checked={settings.rules.lsLong}
        disabled={lossyDisabled}
        onChange={() => setRule('lsLong', !settings.rules.lsLong)}
      />
      <SettingCheckbox
        label="git log → oneline"
        checked={settings.rules.gitLog}
        disabled={lossyDisabled}
        onChange={() => setRule('gitLog', !settings.rules.gitLog)}
      />
      <SettingCheckbox
        label="grep/rg → group by path"
        checked={settings.rules.grepGroup}
        disabled={lossyDisabled}
        onChange={() => setRule('grepGroup', !settings.rules.grepGroup)}
      />
    </div>
  );
}