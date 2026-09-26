import type { NoticeAction, NoticeKind } from '../../lib/protocol/webview.js';

/** Recovery buttons to render for each protocol notice kind. `edit-failed`
 * carries none; its message names the next step in prose. */
export function noticeActionsFor(kind: NoticeKind): NoticeAction[] {
  switch (kind) {
    case 'send-timeout':
      return ['retry', 'open-settings'];
    case 'prepass-timeout':
      return ['retry', 'retry-without-pruning', 'open-settings'];
    case 'model-start-timeout':
      // Pruning already succeeded, so retry and log inspection are the remedies.
      return ['retry', 'show-logs'];
    case 'prepass-failed':
      return ['retry', 'retry-without-pruning'];
    case 'dropped-line':
      return ['retry', 'show-logs'];
    case 'backend-exit':
      return ['restart-backend', 'show-logs'];
    case 'provider-disabled':
      return ['open-settings'];
    case 'operational-error':
      return ['show-logs'];
    case 'send-failed':
      return ['retry'];
    case 'edit-failed':
      return [];
  }
}

/** Human-readable label for a recovery action button. */
export function noticeActionLabel(action: NoticeAction): string {
  switch (action) {
    case 'retry':
      return 'Retry';
    case 'retry-without-pruning':
      return 'Retry without pruning';
    case 'show-logs':
      return 'Show logs';
    case 'open-settings':
      return 'Open settings';
    case 'restart-backend':
      return 'Restart backend';
  }
}
