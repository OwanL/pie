import { readSessionTitlesSettings, writeSessionTitlesSettings, sessionTitlesSettingsFileExists } from './session-titles-settings';
import { DEFAULT_SESSION_TITLES_SETTINGS, type SessionTitlesSettings } from '../../shared/protocol';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';

/**
 * Minimal storage surface for persisting session-title settings.
 *
 * Implemented by VS Code's `ExtensionContext.globalState` in production and by
 * a simple in-memory store in tests.
 */
export interface SessionTitlesSettingsStorage {
  /** Return any previously persisted settings, or undefined if none exist. */
  get(): SessionTitlesSettings | undefined;
  /** Persist the given settings. */
  update(value: SessionTitlesSettings): PromiseLike<void> | void;
}

/**
 * Load persisted session-title settings and notify the host.
 *
 * When `PI_CODING_AGENT_DIR` is available the canonical `settings.json` is
 * used and the result is mirrored to the supplied storage. If that read fails
 * (or the env var is not set), the last value stored in `storage` is restored.
 */
export async function loadPersistedSessionTitlesSettings(
  storage: SessionTitlesSettingsStorage,
  dispatch: (settings: SessionTitlesSettings) => void,
): Promise<void> {
  if (process.env.PI_CODING_AGENT_DIR && sessionTitlesSettingsFileExists()) {
    try {
      const settings = await readSessionTitlesSettings();
      dispatch(settings);
      await storage.update(settings);
      return;
    } catch (error) {
      appendPieLog('warn', 'session-titles-settings', 'failed to load settings.json; falling back to stored state', {
        error: toErrorMessage(error),
      });
    }
  }

  const stored = storage.get();
  if (stored) {
    // Normalize a stale pre-upgrade entry so required fields default in
    // rather than arriving as `undefined`.
    dispatch({
      ...DEFAULT_SESSION_TITLES_SETTINGS,
      ...stored,
    });
  }
}

/**
 * Apply a partial update to session-title settings, persist the result,
 * and notify the host.
 *
 * When `PI_CODING_AGENT_DIR` is available the update is written to the
 * canonical `settings.json`. If that write fails, the update is still applied
 * to the in-memory state and mirrored to `storage` so the UI does not reset on
 * the next restart.
 */
export async function saveSessionTitlesSettings(
  storage: SessionTitlesSettingsStorage,
  dispatch: ((settings: SessionTitlesSettings) => void) | undefined,
  getCurrent: () => SessionTitlesSettings,
  updates: Partial<SessionTitlesSettings>,
  onError?: (message: string) => void,
): Promise<void> {
  let result: SessionTitlesSettings;
  try {
    result = await writeSessionTitlesSettings(updates);
  } catch (error) {
    result = { ...getCurrent(), ...updates };
    const message = `Failed to update session-title settings: ${toErrorMessage(error)}`;
    appendPieLog('warn', 'session-titles-settings', 'failed to update session-title settings', {
      error: toErrorMessage(error),
    });
    onError?.(message);
  }

  // `dispatch` is optional: the SET path (service.setSessionTitlesSettings)
  // passes undefined because the reducer already owns the value via optimistic
  // apply (avoids a lost-update flicker under rapid sequential changes). The
  // LOAD path (loadPersistedSessionTitlesSettings) keeps its own dispatch.
  if (dispatch) {
    dispatch(result);
  }
  await storage.update(result);
}