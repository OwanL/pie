import { open, stat, unlink } from 'node:fs/promises';

export interface CatalogLockOptions {
  retryDelayMs?: number;
  timeoutMs?: number;
  staleAfterMs?: number;
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

/** Serialize catalog commits across Pie backend processes sharing an agent dir. */
export async function withCatalogLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options: CatalogLockOptions = {},
): Promise<T> {
  const retryDelayMs = options.retryDelayMs ?? 50;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const startedAt = Date.now();

  while (true) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
    } catch (error) {
      // Windows can report EPERM while a previous holder's unlink is still
      // pending. Retry exclusive creation within the same budget, but never
      // interpret a permission error as evidence that a lock is stale.
      if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') {
        if (Date.now() - startedAt >= timeoutMs) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      if (!isAlreadyExists(error)) throw error;

      const ageMs = await stat(lockPath)
        .then((value) => Date.now() - value.mtimeMs)
        .catch(() => 0);
      if (ageMs > staleAfterMs) {
        await unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Copilot catalog lock: ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      continue;
    }

    try {
      await handle.writeFile(`${process.pid}\n`, 'utf8');
      return await action();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}
