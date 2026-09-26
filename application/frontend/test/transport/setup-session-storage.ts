/**
 * Test-only fake `window.sessionStorage` for the pending-command store.
 * Imported BEFORE the store module so the singleton constructor sees it.
 */

const storage = new Map<string, string>();
export const storageWrites: string[] = [];

(globalThis as Record<string, unknown>).window = {
  sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storage.set(key, value);
      storageWrites.push(value);
    },
    removeItem: (key: string) => {
      storage.delete(key);
    },
  },
};
