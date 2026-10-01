import fs from 'node:fs/promises';
import * as path from 'node:path';

// Windows scanners, editors, and shell readers can hold a destination handle
// beyond the sub-second window used by ordinary filesystem retries. Keep the
// replacement atomic, but allow nearly eight seconds for a transient reader to
// release the file before surfacing the failure to the caller.
const DEFAULT_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000] as const;
const TRANSIENT_RENAME_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

export interface RenameRetryOptions {
  retryDelaysMs?: readonly number[];
  rename?: (source: string, target: string) => Promise<void>;
  delay?: (milliseconds: number) => Promise<void>;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Retry short-lived Windows sharing violations while replacing a file. */
export async function renameWithTransientRetry(
  source: string,
  target: string,
  options: RenameRetryOptions = {},
): Promise<void> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
  const rename = options.rename ?? fs.rename;
  const delay = options.delay ?? sleep;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retryDelay = retryDelaysMs[attempt];
      if (!code || !TRANSIENT_RENAME_CODES.has(code) || retryDelay === undefined) throw error;
      await delay(retryDelay);
    }
  }
}

function tempPathFor(filePath: string): string {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.${suffix}.tmp`);
}

/** Atomically replace text, preserving an existing target's permission bits. */
export async function atomicWriteText(filePath: string, data: string): Promise<void> {
  let mode: number | undefined;
  try {
    mode = (await fs.stat(filePath)).mode & 0o7777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const tmpPath = tempPathFor(filePath);
  try {
    await fs.writeFile(tmpPath, data, { encoding: 'utf8', mode });
    // Creation applies umask; restore the exact existing mode before replacement.
    // Missing targets keep writeFile's default permissions policy.
    if (mode !== undefined) await fs.chmod(tmpPath, mode);
    await renameWithTransientRetry(tmpPath, filePath);
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
