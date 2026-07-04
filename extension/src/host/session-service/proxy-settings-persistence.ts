import { readProxySettings, writeProxySettings, proxySettingsFileExists } from './proxy-settings';
import { mergeProxySettings, type ProxySettings, type ProxySettingsUpdate } from '../../shared/protocol';
import { toErrorMessage } from '../util/error-message';
import { appendPieLog } from '../util/pie-log';

/**
 * Minimal storage surface for persisting proxy settings.
 *
 * Implemented by VS Code's `ExtensionContext.globalState` in production and by
 * a simple in-memory store in tests.
 */
export interface ProxySettingsStorage {
  /** Return any previously persisted settings, or undefined if none exist. */
  get(): ProxySettings | undefined;
  /** Persist the given settings. */
  update(value: ProxySettings): PromiseLike<void> | void;
}

/**
 * Load persisted proxy settings and notify the host.
 *
 * When `PI_CODING_AGENT_DIR` is available the canonical `settings.json` is
 * used and the result is mirrored to the supplied storage. If that read fails
 * (or the env var is not set), the last value stored in `storage` is restored.
 */
export async function loadPersistedProxySettings(
  storage: ProxySettingsStorage,
  dispatch: (settings: ProxySettings) => void,
): Promise<void> {
  if (process.env.PI_CODING_AGENT_DIR && proxySettingsFileExists()) {
    try {
      const settings = await readProxySettings();
      dispatch(settings);
      await storage.update(settings);
      return;
    } catch (error) {
      appendPieLog('warn', 'proxy-settings', 'failed to load settings.json; falling back to stored state', {
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
 * Apply a partial update to proxy settings and persist the result.
 *
 * When `PI_CODING_AGENT_DIR` is available the update is written to the
 * canonical `settings.json`. If that write fails, the caller is notified via
 * `onError` (the reducer already applied the update optimistically, so the
 * in-memory state is not reverted — mirroring the pruning SET path).
 *
 * `dispatch` is optional: the SET path (service.setProxySettings) passes
 * undefined because the reducer already owns the value via optimistic apply.
 */
export async function saveProxySettings(
  storage: ProxySettingsStorage,
  dispatch: ((settings: ProxySettings) => void) | undefined,
  getCurrent: () => ProxySettings,
  updates: ProxySettingsUpdate,
  onError?: (message: string) => void,
): Promise<ProxySettings> {
  let result: ProxySettings;
  try {
    result = await writeProxySettings(updates);
  } catch (error) {
    result = mergeProxySettingsShallow(getCurrent(), updates);
    const message = `Failed to update proxy settings: ${toErrorMessage(error)}`;
    appendPieLog('warn', 'proxy-settings', 'failed to update proxy settings', {
      error: toErrorMessage(error),
    });
    onError?.(message);
  }

  if (dispatch) {
    dispatch(result);
  }
  await storage.update(result);
  return result;
}

/** Reuse the protocol deep-merge for the in-memory fallback on write failure. */
function mergeProxySettingsShallow(current: ProxySettings, updates: ProxySettingsUpdate): ProxySettings {
  return mergeProxySettings(current, updates);
}