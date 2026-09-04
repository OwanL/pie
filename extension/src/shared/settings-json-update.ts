import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import * as path from 'node:path';

import { atomicWriteText } from './atomic-write';

const writeTailsByPath = new Map<string, Promise<void>>();
/** Ownership is scoped to the current async transaction, not the whole process:
 * another StatsService task in the same host must still contend rather than
 * accidentally entering a sibling transaction's lock. */
const heldLockContext = new AsyncLocalStorage<ReadonlyMap<string, string>>();
/** Node executes only one JavaScript stack at a time. A synchronous ledger
 * mutation that arrives while this process owns an async storage transaction
 * must join that process-owned lock rather than block the event loop needed to
 * release it; cross-process contenders remain excluded by the lock file. */
const processHeldLocks = new Map<string, string>();
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
    const [stat, owner] = await Promise.all([fs.stat(lockPath), fs.readFile(lockPath, 'utf8')]);
    if (Date.now() - stat.mtimeMs <= staleMs) return;
    const ownerPid = parseLockOwnerPid(owner);
    if (ownerPid !== undefined) {
      try {
        process.kill(ownerPid, 0);
        return; // Age never permits stealing a lock from a proven-live owner.
      } catch (error) {
        if (!isErrno(error, 'ESRCH')) return;
      }
    }
    if (await fs.readFile(lockPath, 'utf8') === owner) await fs.unlink(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && !EXISTING_LOCK_CONTENTION_CODES.has(code ?? '')) throw error;
  }
}

function parseLockOwnerPid(owner: string): number | undefined {
  const match = /^(\d+):/.exec(owner.trim());
  if (!match) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/** Recover immediately when a backend was terminated while holding the lock.
 * Age-only recovery leaves every replacement backend unusable for the entire
 * stale window (30s by default), which is longer than the acquisition timeout.
 * Unknown/legacy owners remain age-gated; only a positively dead PID is
 * eligible for immediate removal. */
async function removeAbandonedProcessLock(lockPath: string): Promise<void> {
  let observedOwner: string;
  try {
    observedOwner = await fs.readFile(lockPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || EXISTING_LOCK_CONTENTION_CODES.has(code ?? '')) return;
    throw error;
  }
  const ownerPid = parseLockOwnerPid(observedOwner);
  if (ownerPid === undefined) return;
  try {
    process.kill(ownerPid, 0);
    return;
  } catch (error) {
    // EPERM means the process may still exist but cannot be inspected. Only
    // ESRCH proves the recorded owner has gone away.
    if (!isErrno(error, 'ESRCH')) return;
  }

  // Re-read immediately before unlinking so a contender that already
  // replaced the dead owner's file is never mistaken for that owner.
  try {
    const currentOwner = await fs.readFile(lockPath, 'utf8');
    if (currentOwner === observedOwner) await fs.unlink(lockPath);
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
      await removeAbandonedProcessLock(lockPath);
      await removeStaleLock(lockPath, staleMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for settings update lock ${lockPath} after ${timeoutMs}ms.`);
      }
      await sleep(retryMs);
    }
  }

  processHeldLocks.set(lockPath, token);
  try {
    const inherited = heldLockContext.getStore();
    const owned = new Map(inherited);
    owned.set(lockPath, token);
    return await heldLockContext.run(owned, action);
  } finally {
    processHeldLocks.delete(lockPath);
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

/** Synchronous companion used by the finalized invocation/activity ledgers.
 * It shares the exact lock file and owner format with withFileUpdateLock(). */
export function withFileUpdateLockSync<T>(
  filePath: string,
  action: () => T,
  options: FileUpdateLockOptions = {},
): T {
  const lockPath = `${filePath}.pie-lock`;
  if (heldLockContext.getStore()?.has(lockPath) || processHeldLocks.has(lockPath)) return action();
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const startedAt = Date.now();
  const token = `${process.pid}:${randomUUID()}`;
  let fd: number | undefined;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  fsSync.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (fd === undefined) {
    try {
      fd = fsSync.openSync(lockPath, 'wx');
      fsSync.writeFileSync(fd, `${token}\n`, 'utf8');
    } catch (error) {
      if (fd !== undefined) {
        try { fsSync.closeSync(fd); } catch { /* best effort */ }
        fd = undefined;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw error;
      recoverSynchronousLock(lockPath, staleMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for file update lock ${lockPath} after ${timeoutMs}ms.`);
      }
      Atomics.wait(sleeper, 0, 0, retryMs);
    }
  }

  processHeldLocks.set(lockPath, token);
  try {
    const inherited = heldLockContext.getStore();
    const owned = new Map(inherited);
    owned.set(lockPath, token);
    return heldLockContext.run(owned, action);
  } finally {
    processHeldLocks.delete(lockPath);
    try { fsSync.closeSync(fd); } catch { /* best effort */ }
    try {
      if (fsSync.readFileSync(lockPath, 'utf8').trim() === token) fsSync.unlinkSync(lockPath);
    } catch { /* stale-owner recovery handles a failed release */ }
  }
}

function recoverSynchronousLock(lockPath: string, staleMs: number): void {
  let owner: string;
  let stat: fsSync.Stats;
  try {
    owner = fsSync.readFileSync(lockPath, 'utf8');
    stat = fsSync.statSync(lockPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || EXISTING_LOCK_CONTENTION_CODES.has(code ?? '')) return;
    throw error;
  }
  const ownerPid = parseLockOwnerPid(owner);
  let dead = false;
  if (ownerPid !== undefined) {
    try {
      process.kill(ownerPid, 0);
      return; // A long transaction owned by a live process is never stale.
    } catch (error) {
      dead = isErrno(error, 'ESRCH');
      if (!dead) return;
    }
  }
  if (!dead && Date.now() - stat.mtimeMs <= staleMs) return;
  try {
    if (fsSync.readFileSync(lockPath, 'utf8') === owner) fsSync.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
