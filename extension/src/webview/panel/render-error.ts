/**
 * Preact Suspense signals a pending lazy component through the global error
 * hook as a thrown thenable. It is control flow, not a render failure.
 */
export function isSuspenseThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' && value !== null)
    || typeof value === 'function'
  ) && typeof (value as { then?: unknown }).then === 'function';
}
