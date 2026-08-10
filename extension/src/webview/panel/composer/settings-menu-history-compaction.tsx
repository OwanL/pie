/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import {
  DEFAULT_HISTORY_COMPACTION_SETTINGS,
  DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS,
  resolveHistoryCompactionEffectiveSettings,
  resolveHistoryCompactionSettings,
  resolveHistoryCompactionThresholdTokens,
  type ChatPrefs,
  type HistoryCompactionModelProfile,
  type HistoryCompactionSettings,
  type HistoryCompactionSummaryThinkingLevel,
  type HistoryCompactionThresholdMode,
  type ModelInfo,
} from '../../../shared/protocol';
import { THINKING_LEVEL_OPTIONS } from '../../../shared/thinking-level.js';
import { ModelPicker } from '../components/model-picker';
import { formatModelSpec, getModelThinkingLevels, orderModelsForPicker, parseModelSpec, type ModelPickerEntry } from './model-list';
import type { OnSetPrefs } from './settings-menu-types';

interface Props {
  settings: HistoryCompactionSettings;
  contextWindow?: number;
  availableModels: ModelInfo[];
  modelEntries?: ModelPickerEntry[];
  activeModel?: { provider?: string; id: string };
  onSetPrefs: OnSetPrefs;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}m`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

function resolveActiveModelKey(
  activeModel: { provider?: string; id: string } | undefined,
  availableModels: ModelInfo[],
): string | null {
  if (!activeModel) return null;
  if (activeModel.provider) return formatModelSpec({ provider: activeModel.provider, id: activeModel.id });
  const matches = availableModels.filter((m) => m.id === activeModel.id);
  if (matches.length === 1) return formatModelSpec(matches[0]);
  return null;
}

export function convertMode(
  settings: HistoryCompactionSettings,
  mode: HistoryCompactionThresholdMode,
  contextWindow?: number,
): HistoryCompactionSettings {
  if (mode === settings.thresholdMode) return settings;
  if (contextWindow && contextWindow > 0) {
    if (mode === 'tokens') {
      return resolveHistoryCompactionSettings({
        ...settings,
        thresholdMode: mode,
        softThreshold: resolveHistoryCompactionThresholdTokens(settings, contextWindow, 'soft'),
        hardThreshold: resolveHistoryCompactionThresholdTokens(settings, contextWindow, 'hard'),
      });
    }
    return resolveHistoryCompactionSettings({
      ...settings,
      thresholdMode: mode,
      softThreshold: Math.max(1, Math.round(settings.softThreshold / contextWindow * 100)),
      hardThreshold: Math.min(99, Math.round(settings.hardThreshold / contextWindow * 100)),
    });
  }
  return resolveHistoryCompactionSettings({
    ...settings,
    thresholdMode: mode,
    softThreshold: mode === 'tokens'
      ? DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS.soft
      : DEFAULT_HISTORY_COMPACTION_SETTINGS.softThreshold,
    hardThreshold: mode === 'tokens'
      ? DEFAULT_HISTORY_COMPACTION_TOKEN_THRESHOLDS.hard
      : DEFAULT_HISTORY_COMPACTION_SETTINGS.hardThreshold,
  });
}

function clampedProfile(
  current: HistoryCompactionModelProfile,
  field: keyof HistoryCompactionModelProfile,
  raw: number,
): HistoryCompactionModelProfile {
  const step = 1_000;
  const minThreshold = 1_000;
  const maxThreshold = 10_000_000;
  if (field === 'keepRecentTokens') {
    const keep = Math.max(0, Math.min(raw, current.softThreshold - step));
    return { ...current, keepRecentTokens: keep };
  }
  if (field === 'softThreshold') {
    let soft = Math.max(minThreshold, Math.min(raw, maxThreshold));
    soft = Math.max(current.keepRecentTokens + step, soft);
    let hard = current.hardThreshold;
    if (hard <= soft) {
      hard = Math.min(maxThreshold, soft + step);
    }
    return { ...current, softThreshold: soft, hardThreshold: hard };
  }
  // hardThreshold
  let hard = Math.max(minThreshold, Math.min(raw, maxThreshold));
  hard = Math.max(current.softThreshold + step, hard);
  return { ...current, hardThreshold: hard };
}

export function HistoryCompactionSection({
  settings,
  contextWindow,
  availableModels,
  modelEntries: modelEntriesProp,
  activeModel,
  onSetPrefs,
}: Props) {
  const step = settings.thresholdMode === 'tokens' ? 1_000 : 1;
  const minimum = settings.thresholdMode === 'tokens' ? 1_000 : 1;
  const maximum = settings.thresholdMode === 'tokens' ? 10_000_000 : 99;
  const suffix = settings.thresholdMode === 'percentage' ? '%' : ' tokens';

  const activeKey = resolveActiveModelKey(activeModel, availableModels);
  const activeProfile = activeKey ? settings.modelProfiles[activeKey] : undefined;
  const effective = activeKey
    ? resolveHistoryCompactionEffectiveSettings(settings, activeKey)
    : settings;
  const resolvedSoft = contextWindow
    ? resolveHistoryCompactionThresholdTokens(
        { ...settings, softThreshold: effective.softThreshold, hardThreshold: effective.hardThreshold, keepRecentTokens: effective.keepRecentTokens },
        contextWindow,
        'soft',
      )
    : undefined;
  const resolvedHard = contextWindow
    ? resolveHistoryCompactionThresholdTokens(
        { ...settings, softThreshold: effective.softThreshold, hardThreshold: effective.hardThreshold, keepRecentTokens: effective.keepRecentTokens },
        contextWindow,
        'hard',
      )
    : undefined;

  const entries = modelEntriesProp ?? orderModelsForPicker(availableModels);
  const summaryModelValue = settings.summaryModel
    ? formatModelSpec(settings.summaryModel)
    : '';
  const summaryModelEntry = settings.summaryModel
    ? entries.find((entry) =>
        entry.model.provider === settings.summaryModel?.provider
        && entry.model.id === settings.summaryModel?.id)
    : undefined;
  const summaryModelLabel = summaryModelEntry?.label
    ?? (settings.summaryModel ? summaryModelValue : 'Active model');
  const activeModelInfo = activeModel
    ? availableModels.find((model) => model.id === activeModel.id
      && (!activeModel.provider || model.provider === activeModel.provider))
    : undefined;
  const effectiveSummaryModel = summaryModelEntry?.model ?? activeModelInfo;
  const summaryThinkingOptions: Array<{ value: HistoryCompactionSummaryThinkingLevel; label: string }> = [
    { value: 'inherit', label: 'Inherit' },
    ...THINKING_LEVEL_OPTIONS.filter((option) =>
      getModelThinkingLevels(effectiveSummaryModel).includes(option.value)),
  ];

  const update = (next: HistoryCompactionSettings) => {
    onSetPrefs({ historyCompaction: resolveHistoryCompactionSettings(next) } satisfies Partial<ChatPrefs>);
  };

  const updateThreshold = (which: 'softThreshold' | 'hardThreshold', raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    if (which === 'softThreshold') {
      const retentionFloor = settings.thresholdMode === 'tokens'
        ? settings.keepRecentTokens + step
        : minimum;
      update({ ...settings, softThreshold: Math.max(minimum, retentionFloor, Math.min(value, settings.hardThreshold - step)) });
    } else {
      update({ ...settings, hardThreshold: Math.min(maximum, Math.max(value, settings.softThreshold + step)) });
    }
  };

  const updateKeepRecentTokens = (raw: string) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const maximumRetention = settings.thresholdMode === 'tokens'
      ? Math.max(0, settings.softThreshold - step)
      : 10_000_000;
    update({ ...settings, keepRecentTokens: Math.max(0, Math.min(value, maximumRetention)) });
  };

  const updateSummaryInstructions = (raw: string) => {
    update({ ...settings, summaryInstructions: raw.slice(0, 4_000) });
  };

  const updateSummaryThinkingLevel = (value: HistoryCompactionSummaryThinkingLevel) => {
    update({ ...settings, summaryThinkingLevel: value });
  };

  const updateSummaryModel = (value: string) => {
    const selected = value
      ? (() => {
          const { provider, id } = parseModelSpec(value);
          return provider ? availableModels.find((model) => model.provider === provider && model.id === id) : undefined;
        })()
      : activeModelInfo;
    if (value && !selected) return;
    let summaryThinkingLevel = settings.summaryThinkingLevel;
    if (summaryThinkingLevel !== 'inherit' && selected) {
      const supported = getModelThinkingLevels(selected);
      if (!supported.includes(summaryThinkingLevel)) summaryThinkingLevel = supported[0] ?? 'off';
    }
    update({
      ...settings,
      summaryModel: value && selected ? { provider: selected.provider, id: selected.id } : null,
      summaryThinkingLevel,
    });
  };

  const toggleActiveProfile = () => {
    if (!activeKey) return;
    if (activeProfile) {
      const { [activeKey]: _omit, ...rest } = settings.modelProfiles;
      update({ ...settings, modelProfiles: rest });
    } else {
      update({
        ...settings,
        modelProfiles: {
          ...settings.modelProfiles,
          [activeKey]: {
            softThreshold: settings.softThreshold,
            hardThreshold: settings.hardThreshold,
            keepRecentTokens: settings.keepRecentTokens,
          },
        },
      });
    }
  };

  const updateProfile = (field: keyof HistoryCompactionModelProfile, raw: string) => {
    if (!activeKey) return;
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    const base = activeProfile ?? {
      softThreshold: settings.softThreshold,
      hardThreshold: settings.hardThreshold,
      keepRecentTokens: settings.keepRecentTokens,
    };
    const next = clampedProfile(base, field, value);
    update({
      ...settings,
      modelProfiles: { ...settings.modelProfiles, [activeKey]: next },
    });
  };

  return (
    <div class="toolbar-settings-section" data-settings-section="history-compaction">
      <div class="toolbar-settings-section-label">History compaction</div>
      <div class="toolbar-settings-list">
        <button
          class={`toolbar-settings-item${settings.enabled ? ' checked' : ''}`}
          type="button"
          role="checkbox"
          aria-checked={settings.enabled}
          onClick={() => update({ ...settings, enabled: !settings.enabled })}
        >
          <span class="toolbar-settings-item-check" aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={settings.enabled ? '' : 'opacity:0'}>
              <polyline points="2.5,6.5 5,9 10.5,3.5" />
            </svg>
          </span>
          <span class="toolbar-settings-item-label">Proactive automatic compaction</span>
        </button>

        <div class="toolbar-settings-item toolbar-settings-mode-row">
          <span class="toolbar-settings-item-label">Threshold type</span>
          <select
            class="toolbar-settings-select"
            value={settings.thresholdMode}
            disabled={!settings.enabled}
            aria-label="History compaction threshold type"
            onChange={(event) => update(convertMode(settings, (event.target as HTMLSelectElement).value as HistoryCompactionThresholdMode, contextWindow))}
          >
            <option value="percentage">Percent of context</option>
            <option value="tokens">Token limits</option>
          </select>
        </div>

        <label class="toolbar-settings-item toolbar-settings-mode-row">
          <span class="toolbar-settings-item-label">Soft trigger</span>
          <input
            class="toolbar-settings-select toolbar-settings-number-input"
            type="number"
            min={settings.thresholdMode === 'tokens' ? Math.max(minimum, settings.keepRecentTokens + step) : minimum}
            max={settings.hardThreshold - step}
            step={step}
            value={settings.softThreshold}
            disabled={!settings.enabled}
            aria-label={`Soft compaction trigger${suffix}`}
            onChange={(event) => updateThreshold('softThreshold', (event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="toolbar-settings-item-hint">
          Compact after the current run settles{resolvedSoft !== undefined ? ` (about ${formatTokens(resolvedSoft)} tokens for this model)` : ''}.
        </div>

        <label class="toolbar-settings-item toolbar-settings-mode-row">
          <span class="toolbar-settings-item-label">Hard trigger</span>
          <input
            class="toolbar-settings-select toolbar-settings-number-input"
            type="number"
            min={settings.softThreshold + step}
            max={maximum}
            step={step}
            value={settings.hardThreshold}
            disabled={!settings.enabled}
            aria-label={`Hard compaction trigger${suffix}`}
            onChange={(event) => updateThreshold('hardThreshold', (event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="toolbar-settings-item-hint">
          Compact between complete agent steps before another model request{resolvedHard !== undefined ? ` (about ${formatTokens(resolvedHard)} tokens for this model)` : ''}. Never interrupts reasoning or a running tool.
        </div>

        <label class="toolbar-settings-item toolbar-settings-mode-row">
          <span class="toolbar-settings-item-label">Recent retention</span>
          <input
            class="toolbar-settings-select toolbar-settings-number-input"
            type="number"
            min={0}
            max={settings.thresholdMode === 'tokens' ? Math.max(0, settings.softThreshold - step) : 10_000_000}
            step={step}
            value={settings.keepRecentTokens}
            disabled={!settings.enabled}
            aria-label="Recent token retention"
            onChange={(event) => updateKeepRecentTokens((event.target as HTMLInputElement).value)}
          />
        </label>
        <div class="toolbar-settings-item-hint">
          Tokens to preserve when compacting. Profiles can override this in token mode.
        </div>

        <div class="toolbar-settings-item toolbar-settings-mode-row" style="align-items: flex-start;">
          <span class="toolbar-settings-item-label" style="padding-top: 6px;">Summary instructions</span>
          <textarea
            class="toolbar-settings-select"
            style="width: 100%; min-height: 60px; resize: vertical; text-align: left; font-variant-numeric: inherit;"
            rows={3}
            maxLength={4_000}
            value={settings.summaryInstructions}
            disabled={!settings.enabled}
            aria-label="Summary instructions"
            onInput={(event) => updateSummaryInstructions((event.target as HTMLTextAreaElement).value)}
          />
        </div>

        <div class="toolbar-settings-item toolbar-settings-mode-row">
          <span class="toolbar-settings-item-label">Thinking</span>
          <select
            class="toolbar-settings-select"
            value={settings.summaryThinkingLevel}
            disabled={!settings.enabled}
            aria-label="Summary thinking level"
            onChange={(event) => updateSummaryThinkingLevel((event.target as HTMLSelectElement).value as HistoryCompactionSummaryThinkingLevel)}
          >
            {summaryThinkingOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

        <div class="toolbar-settings-item toolbar-settings-mode-row">
          <span class="toolbar-settings-item-label">Summary model</span>
          <div class="toolbar-settings-inline-actions">
            <ModelPicker
              compact
              dropdownDirection="down"
              value={summaryModelValue}
              label={summaryModelLabel}
              ariaLabel="Summary model"
              title="Select summary model"
              entries={entries}
              disabled={!settings.enabled}
              onChange={updateSummaryModel}
            />
            {settings.summaryModel && (
              <button
                type="button"
                class="toolbar-settings-stepper-btn"
                disabled={!settings.enabled}
                aria-label="Use active model for summaries"
                title="Use active model"
                onClick={() => updateSummaryModel('')}
              >×</button>
            )}
          </div>
        </div>

        {settings.thresholdMode === 'tokens' && activeKey && (
          <>
            <button
              class={`toolbar-settings-item${activeProfile ? ' checked' : ''}`}
              type="button"
              role="checkbox"
              aria-checked={!!activeProfile}
              disabled={!settings.enabled}
              onClick={toggleActiveProfile}
            >
              <span class="toolbar-settings-item-check" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={activeProfile ? '' : 'opacity:0'}>
                  <polyline points="2.5,6.5 5,9 10.5,3.5" />
                </svg>
              </span>
              <span class="toolbar-settings-item-label">Custom thresholds for active model</span>
            </button>

            {activeProfile && (
              <>
                <label class="toolbar-settings-item toolbar-settings-mode-row">
                  <span class="toolbar-settings-item-label">Soft threshold</span>
                  <input
                    class="toolbar-settings-select toolbar-settings-number-input"
                    type="number"
                    min={1_000}
                    max={activeProfile.hardThreshold - 1_000}
                    step={1_000}
                    value={activeProfile.softThreshold}
                    disabled={!settings.enabled}
                    aria-label="Active model soft threshold"
                    onChange={(event) => updateProfile('softThreshold', (event.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="toolbar-settings-item toolbar-settings-mode-row">
                  <span class="toolbar-settings-item-label">Hard threshold</span>
                  <input
                    class="toolbar-settings-select toolbar-settings-number-input"
                    type="number"
                    min={activeProfile.softThreshold + 1_000}
                    max={10_000_000}
                    step={1_000}
                    value={activeProfile.hardThreshold}
                    disabled={!settings.enabled}
                    aria-label="Active model hard threshold"
                    onChange={(event) => updateProfile('hardThreshold', (event.target as HTMLInputElement).value)}
                  />
                </label>
                <label class="toolbar-settings-item toolbar-settings-mode-row">
                  <span class="toolbar-settings-item-label">Recent retention</span>
                  <input
                    class="toolbar-settings-select toolbar-settings-number-input"
                    type="number"
                    min={0}
                    max={activeProfile.softThreshold - 1_000}
                    step={1_000}
                    value={activeProfile.keepRecentTokens}
                    disabled={!settings.enabled}
                    aria-label="Active model recent retention"
                    onChange={(event) => updateProfile('keepRecentTokens', (event.target as HTMLInputElement).value)}
                  />
                </label>
              </>
            )}
          </>
        )}

        <div class="toolbar-settings-item-hint">
          Provider-overflow recovery remains enabled as an emergency fallback.
        </div>
      </div>
    </div>
  );
}

export { clampedProfile };
