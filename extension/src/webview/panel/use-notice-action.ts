/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback } from 'preact/hooks';
import type { WebviewToHostMessage } from '../../shared/protocol';
import type { NoticeAction } from '../../shared/error-mapping';

export function useNoticeAction(
  postMessage: (msg: WebviewToHostMessage) => void,
  sendRetryDraftRef: { current: ((disablePruning?: boolean) => void) | null },
) {
  // Map a NoticeBanner recovery action to the matching
  //  WebviewToHostMessage. Retry / Retry-without-pruning re-send the live
  //  composer draft (via `sendRetryDraftRef`) as a `retrySend` — the host
  //  disables pruning atomically before the re-send for the latter. Retry +
  //  Restart dismiss the notice (the action addresses the error); Show logs /
  //  Open settings do not (the error still stands — the user just opened a
  //  surface to inspect it).
  return useCallback((action: NoticeAction) => {
    switch (action) {
      case 'retry':
        sendRetryDraftRef.current?.();
        postMessage({ type: 'dismissNotice' });
        break;
      case 'retry-without-pruning':
        sendRetryDraftRef.current?.(true);
        postMessage({ type: 'dismissNotice' });
        break;
      case 'restart-backend':
        postMessage({ type: 'restartBackend' });
        postMessage({ type: 'dismissNotice' });
        break;
      case 'show-logs':
        postMessage({ type: 'showLogs' });
        break;
      case 'open-settings':
        postMessage({ type: 'openSettings' });
        break;
    }
  }, [postMessage]);
}
