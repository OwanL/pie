import { toErrorMessage } from '../../../lib/structured-logging/error-message';
import { appendPieLog } from '../../../lib/structured-logging/pie-logger';

export interface SettingsStorage<T> {
  get(): T | undefined;
  update(value: T): PromiseLike<void> | void;
}

interface SettingsPersistence<T> {
  scope: string;
  label: string;
  fileExists(): boolean;
  read(): Promise<T>;
  write(updates: Partial<T>): Promise<T>;
  normalizeStored(value: T): T;
}

/** Canonical settings plus a host-storage mirror. SET state belongs to the reducer. */
export function createSettingsPersistence<T extends object>(options: SettingsPersistence<T>) {
  return {
    async load(storage: SettingsStorage<T>, dispatch: (settings: T) => void): Promise<void> {
      if (process.env.PI_CODING_AGENT_DIR && options.fileExists()) {
        try {
          const settings = await options.read();
          dispatch(settings);
          await storage.update(settings);
          return;
        } catch (error) {
          appendPieLog('warn', options.scope, 'failed to load settings.json; falling back to stored state', {
            error: toErrorMessage(error),
          });
        }
      }
      const stored = storage.get();
      if (stored) dispatch(options.normalizeStored(stored));
    },
    async save(
      storage: SettingsStorage<T>,
      getCurrent: () => T,
      updates: Partial<T>,
      onError?: (message: string) => void,
    ): Promise<void> {
      let result: T;
      try {
        result = await options.write(updates);
      } catch (error) {
        result = { ...getCurrent(), ...updates };
        appendPieLog('warn', options.scope, `failed to update ${options.label}`, {
          error: toErrorMessage(error),
        });
        onError?.(`Failed to update ${options.label}: ${toErrorMessage(error)}`);
      }
      await storage.update(result);
    },
  };
}
