/** @deprecated Import session-scoped settings from `session-settings-store`. */
export {
  LEGACY_SESSION_SETTINGS_DIR_ENV,
  SESSION_SETTINGS_DIR_ENV,
  SESSION_SETTINGS_FILE,
  isSystemPromptTogglePersistenceAvailable,
  readSystemPromptToggles,
  readSystemPromptTogglesForSession,
  writeSystemPromptTogglesForSession,
} from './session-settings-store.js';
