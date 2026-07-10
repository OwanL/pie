import type { HostToWebviewMessage, ViewState } from '../../shared/protocol';
import { WEBVIEW_PROTOCOL_VERSION } from '../../shared/protocol';

/**
 * Sync state held by `SidebarViewProvider`. `hostInstanceId` and
 * `globalRevision` are process-wide — `globalRevision` advances on each
 * state envelope (full snapshot) so the webview can detect host counter
 * resets in conjunction with `hostInstanceId`.
 */
export type SidebarSyncState = {
  hostInstanceId: string;
  globalRevision: number;
  globalDirty: boolean;
};

export function createSidebarSyncState(hostInstanceId: string): SidebarSyncState {
  return {
    hostInstanceId,
    globalRevision: 0,
    globalDirty: false,
  };
}

export function canPostSnapshotToWebview(hasView: boolean, webviewReady: boolean): boolean {
  return hasView && webviewReady;
}

/**
 * Build a global state-snapshot envelope. On a successful post the snapshot is
 * authoritative: the global dirty flag clears (the webview rebuilds its state
 * from the snapshot).
 */
export function buildStateEnvelope(
  syncState: SidebarSyncState,
  viewState: ViewState,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  if (!canPost) {
    return {
      nextSyncState: { ...syncState, globalDirty: true },
    };
  }

  const revision = syncState.globalRevision + 1;
  return {
    nextSyncState: {
      ...syncState,
      globalRevision: revision,
      globalDirty: false,
    },
    message: {
      type: 'state',
      protocolVersion: WEBVIEW_PROTOCOL_VERSION,
      hostInstanceId: syncState.hostInstanceId,
      revision,
      state: viewState,
    },
  };
}

/**
 * Emit a recovery snapshot when the global state is dirty.
 */
export function flushDirtySnapshot(
  syncState: SidebarSyncState,
  viewState: ViewState,
  canPost: boolean,
): { nextSyncState: SidebarSyncState; message?: HostToWebviewMessage } {
  if (!syncState.globalDirty) {
    return { nextSyncState: syncState };
  }

  return buildStateEnvelope(syncState, viewState, canPost);
}

/**
 * A host->webview post can fail even after we've decided the view is ready
 * enough to attempt delivery. Treat that as dropped state and force snapshot
 * recovery on the next explicit resync or visibility transition.
 */
export function reconcilePostedMessageDelivery(
  syncState: SidebarSyncState,
  message: HostToWebviewMessage,
  delivered: boolean,
): SidebarSyncState {
  if (delivered) {
    return syncState;
  }

  if (message.type === 'state' || message.type === 'sendRejected') {
    return { ...syncState, globalDirty: true };
  }

  return syncState;
}
