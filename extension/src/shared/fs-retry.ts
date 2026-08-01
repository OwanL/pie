/**
 * Bounded retry for transient Windows filesystem sharing violations
 * (`EACCES` / `EBUSY` / `EPERM`). These surface when an antivirus scanner,
 * search indexer, or concurrent writer briefly holds a file open; a short
 * bounded retry lets the operation succeed without masking permanent
 * failures (`ENOENT`, `EISDIR`, `ENOTDIR`, ...).
 *
 * Mirrors the delay/code policy of {@link import('./atomic-write').renameWithTransientRetry}
 * but wraps an arbitrary async operation (read/append/write/stat) rather than
 * just `rename`. The retry set is intentionally narrow: `ENOENT` and any other
 * code-less or non-sharing error is rethrown immediately, never retried.
 */

/** Errno codes treated as transient sharing violations worth retrying. */
export const TRANSIENT_FS_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

/**
 * Small bounded fixed-delay schedule (ms). Worst case ~435ms of waiting across
 * 5 retries before the final error is surfaced. Matches the rename retry budget
 * so the whole fs layer shares one backoff envelope.
 */
export const DEFAULT_FS_RETRY_DELAYS_MS = [10, 25, 50, 100, 250] as const;

/** Injectable delay function used between retry attempts. */
export type FsRetryDelay = (milliseconds: number) => Promise<void>;

/** Default delay backed by a real `setTimeout`. */
export const defaultFsRetryDelay: FsRetryDelay = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * True when `error` is a transient fs sharing violation (`EACCES` / `EBUSY` /
 * `EPERM`) that a bounded retry can plausibly clear. `ENOENT` and code-less
 * errors return `false`.
 */
export function isTransientFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined | null)?.code;
  return typeof code === 'string' && TRANSIENT_FS_CODES.has(code);
}

export interface WithTransientFsRetryOptions {
  /** Per-attempt delays in ms; the attempt count is `retryDelaysMs.length + 1`. */
  retryDelaysMs?: readonly number[];
  /** Delay between attempts. Defaults to {@link defaultFsRetryDelay}. */
  delay?: FsRetryDelay;
}

/**
 * Run `operation`, retrying only on transient sharing violations
 * (`EACCES` / `EBUSY` / `EPERM`) using a small bounded delay schedule.
 *
 * `ENOENT` and any other (permanent or code-less) error is rethrown on the
 * first attempt without retry, so callers' existing `ENOENT` handling (e.g.
 * optional reads returning `null`) is preserved exactly.
 */
export async function withTransientFsRetry<T>(
  operation: () => Promise<T>,
  options: WithTransientFsRetryOptions = {},
): Promise<T> {
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_FS_RETRY_DELAYS_MS;
  const delay = options.delay ?? defaultFsRetryDelay;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryDelay = retryDelaysMs[attempt];
      if (!isTransientFsError(error) || retryDelay === undefined) {
        throw error;
      }
      await delay(retryDelay);
    }
  }
}
