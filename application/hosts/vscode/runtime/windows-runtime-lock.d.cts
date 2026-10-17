/** Existing, permanent fixed-local-NTFS directory only. No root creation or reclamation.
 * Unexpected owned-server errors are raised as uncaught exceptions; callers must
 * not suppress those and continue protected work. Release also rejects on loss.
 * timeoutMs bounds contention, excluding volume qualification (separate 15s cap).
 */
export function acquireWindowsRuntimeLock(
  root: string,
  options?: { timeoutMs?: number; retryMs?: number },
): Promise<() => Promise<void>>;
