import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';

import { atomicWriteText } from './atomic-write';

const writeTailsByPath = new Map<string, Promise<void>>();
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 25;

export interface FileUpdateLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

const EXISTING_LOCK_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export type FileUpdateLockContention = 'confirmed' | 'unconfirmed' | 'none';

/**
 * `open(..., 'wx')` normally reports EEXIST for an existing lock, but Windows
 * and some shared filesystems can report a permission/sharing error instead.
 * A qualifying error with an absent path is unconfirmed because a prior lock
 * may have disappeared between open and stat. The acquire loop gives that
 * race one retry without turning persistent permission errors into timeouts.
 *
 * Exported so the platform-error classification can be covered without
 * relying on an intermittent operating-system error.
 */
export async function classifyFileUpdateLockContention(
  error: unknown,
  lockPath: string,
): Promise<FileUpdateLockContention> {
  if (isErrno(error, 'EEXIST')) return 'confirmed';
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (!code || !EXISTING_LOCK_CONTENTION_CODES.has(code)) return 'none';
  try {
    await fs.stat(lockPath);
    return 'confirmed';
  } catch (statError) {
    return isErrno(statError, 'ENOENT') ? 'unconfirmed' : 'none';
  }
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<void> {
  try {
    const stat = await fs.stat(lockPath);
    if (Date.now() - stat.mtimeMs <= staleMs) return;
    await fs.unlink(lockPath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}

/**
 * Run an action while holding an advisory lock shared by the extension host
 * and backend processes. The lock covers the complete read-modify-write cycle.
 */
export async function withFileUpdateLock<T>(
  filePath: string,
  action: () => Promise<T>,
  options: FileUpdateLockOptions = {},
): Promise<T> {
  const lockPath = `${filePath}.pie-lock`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const startedAt = Date.now();
  const token = `${process.pid}:${randomUUID()}`;
  let handle: fs.FileHandle | undefined;
  let retriedUnconfirmedContention = false;

  while (!handle) {
    try {
      handle = await fs.open(lockPath, 'wx');
      await handle.writeFile(`${token}\n`, 'utf8');
      retriedUnconfirmedContention = false;
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
        handle = undefined;
        await fs.unlink(lockPath).catch(() => undefined);
      }
      const contention = await classifyFileUpdateLockContention(error, lockPath);
      if (contention === 'none') throw error;
      if (contention === 'unconfirmed') {
        if (retriedUnconfirmedContention) throw error;
        retriedUnconfirmedContention = true;
        await sleep(retryMs);
        continue;
      }
      retriedUnconfirmedContention = false;
      await removeStaleLock(lockPath, staleMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for settings update lock ${lockPath} after ${timeoutMs}ms.`);
      }
      await sleep(retryMs);
    }
  }

  try {
    return await action();
  } finally {
    await handle.close().catch(() => undefined);
    // Do not remove a successor's lock if this lock was externally deemed
    // stale and replaced while the action was still finishing.
    try {
      const owner = await fs.readFile(lockPath, 'utf8');
      if (owner.trim() === token) await fs.unlink(lockPath);
    } catch {
      // The action has already completed. A failed release is recovered by the
      // stale-lock path; throwing here could make callers retry an update that
      // was successfully committed.
    }
  }
}

function parseJsonObject(raw: string, filePath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update malformed JSON file ${filePath}: ${detail}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Cannot update ${filePath}: expected a JSON object at the root.`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Serialize updates within one process, coordinate them across host/backend
 * processes, and atomically publish the resulting settings JSON.
 *
 * Only ENOENT is treated as an empty file. Parse, permission, and transient
 * read failures surface instead of replacing the user's settings.
 */
export async function updateSettingsJsonObject(
  filePath: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prior = writeTailsByPath.get(filePath) ?? Promise.resolve();
  const operation = prior.then(() => withFileUpdateLock(filePath, async () => {
    let current: Record<string, unknown>;
    try {
      current = parseJsonObject(await fs.readFile(filePath, 'utf8'), filePath);
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      current = {};
    }

    const next = update(current);
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`Refusing to write ${filePath}: update did not return a JSON object.`);
    }
    await atomicWriteText(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }));
  const tail = operation.then(() => undefined, () => undefined);
  writeTailsByPath.set(filePath, tail);

  try {
    return await operation;
  } finally {
    if (writeTailsByPath.get(filePath) === tail) writeTailsByPath.delete(filePath);
  }
}
