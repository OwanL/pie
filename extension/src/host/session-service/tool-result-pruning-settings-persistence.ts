import { readToolResultPruningSettings, writeToolResultPruningSettings, toolResultPruningSettingsFileExists } from './tool-result-pruning-settings';
import { DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, type ToolResultPruningSettings } from '../../shared/protocol';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';

/**
 * Minimal storage surface for persisting tool-result pruning settings.
 *
 * Implemented by VS Code's `ExtensionContext.globalState` in production and by
 * a simple in-memory store in tests.
 */
export interface ToolResultPruningSettingsStorage {
  /** Return any previously persisted settings, or undefined if none exist. */
  get(): ToolResultPruningSettings | undefined;
  /** Persist the given settings. */
  update(value: ToolResultPruningSettings): PromiseLike<void> | void;
}

/**
 * Load persisted tool-result pruning settings and notify the host.
 *
 * When `PI_CODING_AGENT_DIR` is available the canonical `settings.json` is
 * used and the result is mirrored to the supplied storage. If that read fails
 * (or the env var is not set), the last value stored in `storage` is restored.
 */
export async function loadPersistedToolResultPruningSettings(
  storage: ToolResultPruningSettingsStorage,
  dispatch: (settings: ToolResultPruningSettings) => void,
): Promise<void> {
  if (process.env.PI_CODING_AGENT_DIR && toolResultPruningSettingsFileExists()) {
    try {
      const settings = await readToolResultPruningSettings();
      dispatch(settings);
      await storage.update(settings);
      return;
    } catch (error) {
      appendPieLog('warn', 'tool-result-pruning-settings', 'failed to load settings.json; falling back to stored state', {
        error: toErrorMessage(error),
      });
    }
  }

  const stored = storage.get();
  if (stored) {
    // Normalize a stale pre-upgrade entry so newly-required fields (e.g.
    // `tools`) default in rather than arriving as `undefined`. Defaults fill
    // any missing toggle keys so the reducer never sees a partial `rules`.
    dispatch({
      ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
      ...stored,
      rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules, ...(stored.rules ?? {}) },
      tools: stored.tools ?? null,
    });
  }
}

/**
 * Apply a partial update to tool-result pruning settings, persist the result,
 * and notify the host.
 *
 * When `PI_CODING_AGENT_DIR` is available the update is written to the
 * canonical `settings.json`. If that write fails, the update is still applied
 * to the in-memory state and mirrored to `storage` so the UI does not reset on
 * the next restart.
 */
export async function saveToolResultPruningSettings(
  storage: ToolResultPruningSettingsStorage,
  dispatch: ((settings: ToolResultPruningSettings) => void) | undefined,
  getCurrent: () => ToolResultPruningSettings,
  updates: Partial<ToolResultPruningSettings>,
  onError?: (message: string) => void,
): Promise<void> {
  let result: ToolResultPruningSettings;
  try {
    result = await writeToolResultPruningSettings(updates);
  } catch (error) {
    result = { ...getCurrent(), ...updates };
    const message = `Failed to update tool-result pruning settings: ${toErrorMessage(error)}`;
    appendPieLog('warn', 'tool-result-pruning-settings', 'failed to update tool-result pruning settings', {
      error: toErrorMessage(error),
    });
    onError?.(message);
  }

  // `dispatch` is optional: the SET path (service.setToolResultPruningSettings)
  // passes undefined because the reducer already owns the value via optimistic
  // apply (avoids a lost-update flicker under rapid sequential changes). The
  // LOAD path (loadPersistedToolResultPruningSettings) keeps its own dispatch.
  if (dispatch) {
    dispatch(result);
  }
  await storage.update(result);
}
