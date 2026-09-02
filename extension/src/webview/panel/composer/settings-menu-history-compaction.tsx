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
  type HistoryCompactionThresholdMode,
  type ModelInfo,
  type ThinkingLevel,
} from '../../../shared/protocol';
import { ModelAssignmentRow } from '../components/model-assignment-row';
import { NumberField } from '../components/number-field';
import { SettingCheckbox } from '../components/setting-checkbox';
import { formatModelSpec, type ModelPickerEntry } from './model-list';
import type { OnSetPrefs } from './settings-menu-types';

export const HISTORY_COMPACTION_BEHAVIOR_SETTING_LABELS = [
  'Proactive automatic compaction',
  'Threshold type',
  'Soft trigger',
  'Hard trigger',
  'Recent retention',
  'Summary instructions',
  'Custom thresholds for active model',
  'Soft threshold',
  'Hard threshold',
] as const;

export const HISTORY_COMPACTION_MODEL_SETTING_LABELS = [
  'Summary model',
  'Thinking',
] as const;

interface Props {
  settings: HistoryCompactionSettings;
  contextWindow?: number;
  availableModels: ModelInfo[];
  activeModel?: { provider?: string; id: string };
  onSetPrefs: OnSetPrefs;
}

interface HistoryCompactionModelAssignmentProps {
  settings: HistoryCompactionSettings;
  availableModels: ModelInfo[];
  modelEntries: ModelPickerEntry[];
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
        <SettingCheckbox
          label="Proactive automatic compaction"
          checked={settings.enabled}
          onChange={() => update({ ...settings, enabled: !settings.enabled })}
        />

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

        <NumberField
          label="Soft trigger"
          min={settings.thresholdMode === 'tokens' ? Math.max(minimum, settings.keepRecentTokens + step) : minimum}
          max={settings.hardThreshold - step}
          step={step}
          value={settings.softThreshold}
          disabled={!settings.enabled}
          ariaLabel={`Soft compaction trigger${suffix}`}
          onChange={(value) => updateThreshold('softThreshold', String(value))}
        />
        <div class="toolbar-settings-item-hint">
          Compact after the current run settles{resolvedSoft !== undefined ? ` (about ${formatTokens(resolvedSoft)} tokens for this model)` : ''}.
        </div>

        <NumberField
          label="Hard trigger"
          min={settings.softThreshold + step}
          max={maximum}
          step={step}
          value={settings.hardThreshold}
          disabled={!settings.enabled}
          ariaLabel={`Hard compaction trigger${suffix}`}
          onChange={(value) => updateThreshold('hardThreshold', String(value))}
        />
        <div class="toolbar-settings-item-hint">
          Compact between complete agent steps before another model request{resolvedHard !== undefined ? ` (about ${formatTokens(resolvedHard)} tokens for this model)` : ''}. Never interrupts reasoning or a running tool.
        </div>

        <NumberField
          label="Recent retention"
          min={0}
          max={settings.thresholdMode === 'tokens' ? Math.max(0, settings.softThreshold - step) : 10_000_000}
          step={step}
          value={settings.keepRecentTokens}
          disabled={!settings.enabled}
          ariaLabel="Recent token retention"
          onChange={(value) => updateKeepRecentTokens(String(value))}
        />
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

        {settings.thresholdMode === 'tokens' && activeKey && (
          <>
            <SettingCheckbox
              label="Custom thresholds for active model"
              checked={!!activeProfile}
              disabled={!settings.enabled}
              onChange={toggleActiveProfile}
            />

            {activeProfile && (
              <>
                <NumberField
                  label="Soft threshold"
                  min={1_000}
                  max={activeProfile.hardThreshold - 1_000}
                  step={1_000}
                  value={activeProfile.softThreshold}
                  disabled={!settings.enabled}
                  ariaLabel="Active model soft threshold"
                  onChange={(value) => updateProfile('softThreshold', String(value))}
                />
                <NumberField
                  label="Hard threshold"
                  min={activeProfile.softThreshold + 1_000}
                  max={10_000_000}
                  step={1_000}
                  value={activeProfile.hardThreshold}
                  disabled={!settings.enabled}
                  ariaLabel="Active model hard threshold"
                  onChange={(value) => updateProfile('hardThreshold', String(value))}
                />
                <NumberField
                  label="Recent retention"
                  min={0}
                  max={activeProfile.softThreshold - 1_000}
                  step={1_000}
                  value={activeProfile.keepRecentTokens}
                  disabled={!settings.enabled}
                  ariaLabel="Active model recent retention"
                  onChange={(value) => updateProfile('keepRecentTokens', String(value))}
                />
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

/** Models-tab assignment for history-compaction summaries. */
export function HistoryCompactionModelAssignment({
  settings,
  availableModels,
  modelEntries,
  activeModel,
  onSetPrefs,
}: HistoryCompactionModelAssignmentProps) {
  const activeModelInfo = activeModel
    ? availableModels.find((model) => model.id === activeModel.id
      && (!activeModel.provider || model.provider === activeModel.provider))
    : undefined;
  const update = (next: HistoryCompactionSettings) => {
    onSetPrefs({ historyCompaction: resolveHistoryCompactionSettings(next) } satisfies Partial<ChatPrefs>);
  };
  const updateSummaryModel = (
    value: { provider: string; model: string } | null,
    normalizedThinking?: 'inherit' | ThinkingLevel | '',
  ) => {
    update({
      ...settings,
      summaryModel: value ? { provider: value.provider, id: value.model } : null,
      ...(normalizedThinking !== undefined && normalizedThinking !== ''
        ? { summaryThinkingLevel: normalizedThinking }
        : {}),
    });
  };

  return (
    <div class="toolbar-settings-ext-settings">
      <ModelAssignmentRow
        label="Summary model"
        entries={modelEntries}
        current={settings.summaryModel
          ? { provider: settings.summaryModel.provider, model: settings.summaryModel.id }
          : null}
        emptyLabel="Active model"
        fallbackModel={activeModelInfo}
        clearable
        disabled={!settings.enabled}
        clearLabel="Use active model for summaries"
        clearTitle="Use active model"
        thinking={{
          value: settings.summaryThinkingLevel,
          includeInherit: true,
          ariaLabel: 'Summary thinking level',
          onChange: (value) => {
            update({ ...settings, summaryThinkingLevel: value === '' ? 'inherit' : value });
          },
        }}
        onChange={updateSummaryModel}
        dropdownDirection="down"
      />
      {!settings.enabled && (
        <div class="toolbar-settings-item-hint">Enable history compaction in Context to change this assignment.</div>
      )}
    </div>
  );
}

export { clampedProfile };
