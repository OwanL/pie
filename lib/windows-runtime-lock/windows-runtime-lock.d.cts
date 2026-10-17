/** Existing, permanent fixed-local-NTFS directory only. No root creation or reclamation.
 * Volume qualification is process-cached per device assuming stable mounted volumes;
 * directory realpath/device/inode identity is checked freshly for every acquisition.
 * Listener errors do not close the listener or cancel work. Await release to report
 * the first listener error (or unexpected close); callers must always await release.
 * timeoutMs bounds contention, excluding volume qualification (separate 15s cap).
 */
export function acquireWindowsRuntimeLock(
  root: string,
  options?: { timeoutMs?: number; retryMs?: number },
): Promise<() => Promise<void>>;
