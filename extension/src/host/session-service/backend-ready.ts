import type { Event } from '../core/events';

export interface PublishBackendReadyOptions {
  dispatchArch: (event: Event) => void;
  scheduleRender: () => void;
  openSession: (sessionPath: string) => void;
  preloadSessions: (sessionPaths: readonly string[]) => void;
  isRestoredSessionOpen: (sessionPath: string) => boolean;
  restoredStartupPath: string | null;
  preloadPaths: readonly string[];
}

export function publishBackendReady(options: PublishBackendReadyOptions): Error | null {
  options.dispatchArch({ kind: 'BackendReadyChanged', ready: true });
  options.scheduleRender();

  if (!options.restoredStartupPath) {
    return null;
  }

  try {
    // Initial backend reconciliation can synchronously close an explicitly
    // targeted restored tab before startup reaches this point. Re-check the
    // authoritative host tabs so readiness cannot revive that target; apply
    // the same guard to background restores.
    if (options.isRestoredSessionOpen(options.restoredStartupPath)) {
      options.openSession(options.restoredStartupPath);
    }
    const preloadPaths = options.preloadPaths.filter(options.isRestoredSessionOpen);
    if (preloadPaths.length > 0) options.preloadSessions(preloadPaths);
    return null;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    options.dispatchArch({ kind: 'NoticeShown', notice: `Failed to restore session: ${failure.message}` });
    options.scheduleRender();
    return failure;
  }
}
