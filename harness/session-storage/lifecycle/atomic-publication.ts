const RETRY_DELAYS_MS = [10, 25, 50, 100, 250, 500, 1000, 2000, 4000] as const;

/** Retry only an unpublished atomic rename, not preparation or an entire
 * transaction. The callback must keep its final ownership check, rename, and
 * commit bookkeeping in one synchronous turn. Backoff yields so readers and
 * unrelated backend requests can finish. The existing retry budget is finite. */
export async function retryAtomicPublication<T>(commit: () => T): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return commit();
    } catch (error) {
      const failure = error && typeof error === 'object' ? error as NodeJS.ErrnoException : undefined;
      const delay = RETRY_DELAYS_MS[attempt];
      if (failure?.syscall !== 'rename'
        || !['EPERM', 'EACCES', 'EBUSY'].includes(failure.code ?? '')
        || delay === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
}
