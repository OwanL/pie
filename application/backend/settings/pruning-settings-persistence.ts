import { readPruningSettings, writePruningSettings, pruningSettingsFileExists } from './pruning-settings';
import { type PruningSettings } from '../../lib/protocol/index.js';
import { createSettingsPersistence, type SettingsStorage } from './settings-persistence';

export type PruningSettingsStorage = SettingsStorage<PruningSettings>;

const persistence = createSettingsPersistence<PruningSettings>({
  scope: 'pruning-settings',
  label: 'pruning settings',
  fileExists: pruningSettingsFileExists,
  read: readPruningSettings,
  write: writePruningSettings,
  normalizeStored: (value) => value,
});

export const loadPersistedPruningSettings = persistence.load;
export const savePruningSettings = persistence.save;
