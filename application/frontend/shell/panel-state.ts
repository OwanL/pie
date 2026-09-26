import type { ViewState } from '../../lib/protocol/index.js';

export type PanelSurface = 'loading' | 'empty' | 'session';

type PanelSurfaceState = Pick<ViewState, 'backendReady' | 'notice' | 'openTabPaths'>;
type PanelBootState = Pick<ViewState, 'backendReady' | 'notice'>;

export function isPanelBooting(state: PanelBootState): boolean {
  const hasNotice = typeof state.notice === 'string' && state.notice.trim().length > 0;
  return !state.backendReady && !hasNotice;
}

export function resolvePanelSurface(state: PanelSurfaceState): PanelSurface {
  // If there are open tabs, always show the session surface — even during boot.
  // This lets users type immediately; their messages will be queued until the
  // backend is ready.
  if (state.openTabPaths.length > 0) {
    return 'session';
  }

  if (isPanelBooting(state)) {
    return 'loading';
  }

  return 'empty';
}

export interface LoadingStatusState {
  backendReady: boolean;
  hasOpenTabs: boolean;
  transcriptHydrating: boolean;
  needsSessionRecovery: boolean;
}

/**
 * Resolves the short, subtle status line shown beneath a loading wheel.
 * Reflects the most specific current phase so the surface reads as progressing
 * ("Starting pi" → "Restoring sessions" → "Loading conversation") rather than
 * frozen on a single static label.
 */
export function resolveLoadingStatus(state: LoadingStatusState): string {
  if (state.needsSessionRecovery) {
    return 'Restoring session';
  }
  if (!state.backendReady) {
    return state.hasOpenTabs ? 'Restoring sessions' : 'Starting pie';
  }
  if (state.transcriptHydrating) {
    return 'Loading conversation';
  }
  return 'Loading';
}
