/** Reserved prefix for host-local pending session tabs (never a durable path). */
export const PENDING_SESSION_PREFIX = '__pending__:';

/** Whether a session address is a pending-tab sentinel, including SDK-normalized paths. */
export function isPendingTabPath(sessionPath: string): boolean {
  return /(?:^|[\\/])__pending__:/u.test(sessionPath);
}
