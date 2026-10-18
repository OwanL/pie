import { readToolResultPruningSettings, writeToolResultPruningSettings, toolResultPruningSettingsFileExists } from './tool-result-pruning-settings';
import { DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, type ToolResultPruningSettings } from '../../lib/protocol/index.js';
import { createSettingsPersistence, type SettingsStorage } from './settings-persistence';

export type ToolResultPruningSettingsStorage = SettingsStorage<ToolResultPruningSettings>;

const persistence = createSettingsPersistence<ToolResultPruningSettings>({
  scope: 'tool-result-pruning-settings',
  label: 'tool-result pruning settings',
  fileExists: toolResultPruningSettingsFileExists,
  read: readToolResultPruningSettings,
  write: writeToolResultPruningSettings,
  // Host storage may contain pre-upgrade entries with missing rules or tools.
  normalizeStored: (value) => ({
    ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
    ...value,
    rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules, ...(value.rules ?? {}) },
    tools: value.tools ?? null,
  }),
});

export const loadPersistedToolResultPruningSettings = persistence.load;
export const saveToolResultPruningSettings = persistence.save;
