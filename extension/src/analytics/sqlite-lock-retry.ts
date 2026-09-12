/**
 * Narrow retry policy for the independent analytics writers. SQLite's native
 * busy timeout is 5 seconds; the outer retry budget is shared by every
 * transaction and acknowledgement read in one captureBatch. Consequently a
 * batch can spend at most that budget deciding to retry, plus one native wait
 * already in flight when the budget expires.
 */
export const SQLITE_NATIVE_BUSY_TIMEOUT_MS = 5_000;
export const SQLITE_CAPTURE_LOCK_RETRY_BUDGET_MS = 8_000;
export const SQLITE_CAPTURE_LOCK_RETRY_MAX_DELAY_MS = 200;

export interface SqliteLockRetryBudget {
  readonly deadlineMs: number;
  lastLockError?: unknown;
}

export function createSqliteLockRetryBudget(nowMs = performance.now()): SqliteLockRetryBudget {
  return { deadlineMs: nowMs + SQLITE_CAPTURE_LOCK_RETRY_BUDGET_MS };
}

/** `node:sqlite` exposes BUSY/LOCKED through either SQLite errcodes or a
 * generic ERR_SQLITE_ERROR plus text. Retry only transient ownership races;
 * schema, corruption, path, and configuration failures stay fatal. */
export function isSqliteLockContention(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : '';
  // Native numeric codes are authoritative, including extended SQLite codes.
  // Never retry a constraint/corruption error because its text mentions a lock.
  if (typeof candidate.errcode === 'number' && Number.isSafeInteger(candidate.errcode) && candidate.errcode >= 0) {
    const primaryCode = candidate.errcode % 256;
    return primaryCode === 5 || primaryCode === 6;
  }
  if (code === 'EBUSY' || code === 'SQLITE_BUSY'
    || code === 'SQLITE_LOCKED'
    || code.startsWith('SQLITE_BUSY_')
    || code.startsWith('SQLITE_LOCKED_')) return true;
  if (code && code !== 'ERR_SQLITE_ERROR') return false;
  const detail = `${typeof candidate.errstr === 'string' ? candidate.errstr : ''} ${typeof candidate.message === 'string' ? candidate.message : ''}`.toLowerCase();
  return /\bdatabase(?: table)?\b[^\n]*\b(?:busy|locked)\b/u.test(detail);
}

/**
 * Retry one synchronous recorder operation against a shared batch budget.
 * Every retry yields to the event loop. After observed contention, no further
 * operation starts after the deadline; the last lock error is rethrown unchanged so
 * the supervisor can retain the immutable request for recovery.
 */
export async function retrySqliteLock<T>(
  operation: () => T,
  budget: SqliteLockRetryBudget,
): Promise<T> {
  if (budget.lastLockError !== undefined && performance.now() >= budget.deadlineMs) {
    throw budget.lastLockError;
  }
  let delayMs = 10;
  while (true) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteLockContention(error)) throw error;
      budget.lastLockError = error;
      const remainingMs = budget.deadlineMs - performance.now();
      if (remainingMs <= 0) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
      if (performance.now() >= budget.deadlineMs) throw error;
      delayMs = Math.min(SQLITE_CAPTURE_LOCK_RETRY_MAX_DELAY_MS, delayMs * 2);
    }
  }
}
