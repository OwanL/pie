import { readPruningSettings, writePruningSettings, pruningSettingsFileExists } from './pruning-settings';
import type { PruningSettings } from '../../shared/protocol';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';

/**
 * Minimal storage surface for persisting pruning settings.
 *
 * Implemented by VS Code's `ExtensionContext.globalState` in production and by
 * a simple in-memory store in tests.
 */
export interface PruningSettingsStorage {
  /** Return any previously persisted settings, or undefined if none exist. */
  get(): PruningSettings | undefined;
  /** Persist the given settings. */
  update(value: PruningSettings): PromiseLike<void> | void;
}

/**
 * Load persisted pruning settings and notify the host.
 *
 * When `PI_CODING_AGENT_DIR` is available the canonical `settings.json` is
 * used and the result is mirrored to the supplied storage. If that read fails
 * (or the env var is not set), the last value stored in `storage` is restored.
 */
export async function loadPersistedPruningSettings(
  storage: PruningSettingsStorage,
  dispatch: (settings: PruningSettings) => void,
): Promise<void> {
  if (process.env.PI_CODING_AGENT_DIR && pruningSettingsFileExists()) {
    try {
      const settings = await readPruningSettings();
      dispatch(settings);
      await storage.update(settings);
      return;
    } catch (error) {
      appendPieLog('warn', 'pruning-settings', 'failed to load settings.json; falling back to stored state', {
        error: toErrorMessage(error),
      });
    }
  }

  const stored = storage.get();
  if (stored) {
    dispatch(stored);
  }
}

/**
 * Apply a partial update to pruning settings, persist the result, and notify
 * the host.
 *
 * When `PI_CODING_AGENT_DIR` is available the update is written to the
 * canonical `settings.json`. If that write fails, the update is still applied
 * to the in-memory state and mirrored to `storage` so the UI does not reset on
 * the next restart.
 */
export async function savePruningSettings(
  storage: PruningSettingsStorage,
  dispatch: ((settings: PruningSettings) => void) | undefined,
  getCurrent: () => PruningSettings,
  updates: Partial<PruningSettings>,
  onError?: (message: string) => void,
): Promise<void> {
  let result: PruningSettings;
  try {
    result = await writePruningSettings(updates);
  } catch (error) {
    result = { ...getCurrent(), ...updates };
    const message = `Failed to update pruning settings: ${toErrorMessage(error)}`;
    appendPieLog('warn', 'pruning-settings', 'failed to update pruning settings', {
      error: toErrorMessage(error),
    });
    onError?.(message);
  }

  // `dispatch` is optional: the SET path (service.setPruningSettings) passes
  // undefined because the reducer already owns the value via optimistic apply
  // (avoids a lost-update flicker under rapid sequential changes). The LOAD
  // path (loadPersistedPruningSettings) keeps its own dispatch.
  if (dispatch) {
    dispatch(result);
  }
  await storage.update(result);
}
