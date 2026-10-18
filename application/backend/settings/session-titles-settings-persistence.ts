import { readSessionTitlesSettings, writeSessionTitlesSettings, sessionTitlesSettingsFileExists } from './session-titles-settings';
import { DEFAULT_SESSION_TITLES_SETTINGS, type SessionTitlesSettings } from '../../lib/protocol/index.js';
import { createSettingsPersistence, type SettingsStorage } from './settings-persistence';

export type SessionTitlesSettingsStorage = SettingsStorage<SessionTitlesSettings>;

const persistence = createSettingsPersistence<SessionTitlesSettings>({
  scope: 'session-titles-settings',
  label: 'session-title settings',
  fileExists: sessionTitlesSettingsFileExists,
  read: readSessionTitlesSettings,
  write: writeSessionTitlesSettings,
  normalizeStored: (value) => ({ ...DEFAULT_SESSION_TITLES_SETTINGS, ...value }),
});

export const loadPersistedSessionTitlesSettings = persistence.load;
export const saveSessionTitlesSettings = persistence.save;
