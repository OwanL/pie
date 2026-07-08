/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ToolResultPruningSettings } from '../../../shared/protocol';
import type { OnSetToolResultPruningSettings } from './settings-menu-types';

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
  return (
    <div class="toolbar-settings-ext-settings">
      <button
        class={`toolbar-settings-item${settings.enabled ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.enabled}
        onClick={() => onSetToolResultPruningSettings({ enabled: !settings.enabled })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.enabled ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Enabled</span>
      </button>
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
      <button
        class={`toolbar-settings-item${settings.rules.ansi ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.rules.ansi}
        onClick={() => onSetToolResultPruningSettings({ rules: { ...settings.rules, ansi: !settings.rules.ansi } })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.rules.ansi ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">ANSI strip</span>
      </button>
      <button
        class={`toolbar-settings-item${settings.rules.whitespace ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.rules.whitespace}
        onClick={() => onSetToolResultPruningSettings({ rules: { ...settings.rules, whitespace: !settings.rules.whitespace } })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.rules.whitespace ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Trim whitespace</span>
      </button>
      <button
        class={`toolbar-settings-item${settings.rules.blankRun ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.rules.blankRun}
        onClick={() => onSetToolResultPruningSettings({ rules: { ...settings.rules, blankRun: !settings.rules.blankRun } })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.rules.blankRun ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Collapse blank runs</span>
      </button>
      <button
        class={`toolbar-settings-item${settings.rules.jsonMinify ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.rules.jsonMinify}
        onClick={() => onSetToolResultPruningSettings({ rules: { ...settings.rules, jsonMinify: !settings.rules.jsonMinify } })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.rules.jsonMinify ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Minify JSON</span>
      </button>
      <div class="toolbar-settings-item" style="padding:2px 8px;opacity:0.6;font-size:11px;cursor:default" aria-hidden="true">
        Lossy (Default profile only — recallable via raw stash)
      </div>
      <button
        class={`toolbar-settings-item${settings.rules.lsLong ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.rules.lsLong}
        disabled={settings.profile !== 'default'}
        onClick={() => onSetToolResultPruningSettings({ rules: { ...settings.rules, lsLong: !settings.rules.lsLong } })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.rules.lsLong ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">ls -l → names</span>
      </button>
      <button
        class={`toolbar-settings-item${settings.rules.gitLog ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.rules.gitLog}
        disabled={settings.profile !== 'default'}
        onClick={() => onSetToolResultPruningSettings({ rules: { ...settings.rules, gitLog: !settings.rules.gitLog } })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.rules.gitLog ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">git log → oneline</span>
      </button>
      <button
        class={`toolbar-settings-item${settings.rules.grepGroup ? ' checked' : ''}`}
        type="button"
        role="checkbox"
        aria-checked={settings.rules.grepGroup}
        disabled={settings.profile !== 'default'}
        onClick={() => onSetToolResultPruningSettings({ rules: { ...settings.rules, grepGroup: !settings.rules.grepGroup } })}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.rules.grepGroup ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">grep/rg → group by path</span>
      </button>
    </div>
  );
}
