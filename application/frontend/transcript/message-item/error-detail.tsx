/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { ChatMessage } from '../../../lib/protocol/index.js';
import { useNotice, useDismissNotice } from '../../lib/hooks/notice-context';

const ERROR_TRUNCATE = 150;

export function ErrorDetailWithFallback({ message }: { message: ChatMessage }) {
  const notice = useNotice();
  const dismissNotice = useDismissNotice();
  const detail = message.errorDetail || notice;
  if (!detail) return null;
  // If the error originates from the global notice (not a per-message
  // errorDetail), dismissing it should dispatch `dismissNotice` to the host
  // so the notice is cleared in ArchState — not just hidden locally (MVI:
  // the webview doesn't own the notice). Per-message errorDetail has no
  // host-side dismiss mechanism, so it falls back to local `dismissed` state.
  const onDismiss = !message.errorDetail ? (dismissNotice ?? undefined) : undefined;
  return <ErrorDetail detail={detail} onDismiss={onDismiss} />;
}

export function ErrorDetail({ detail, onDismiss }: { detail: string; onDismiss?: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const isLong = detail.length > ERROR_TRUNCATE;

  if (dismissed) return null;

  return (
    <div class="message-error-detail">
      <span class="message-error-detail-text">
        {isLong && !expanded ? detail.slice(0, ERROR_TRUNCATE) + '…' : detail}
      </span>
      <span class="message-error-detail-actions">
        {isLong && (
          <button class="message-error-detail-btn" onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        <button
          class="message-error-detail-btn"
          onClick={() => { void navigator.clipboard?.writeText(detail); }}
          title="Copy error detail"
          aria-label="Copy error detail"
        >
          Copy
        </button>
        <button class="message-error-detail-btn" onClick={() => { if (onDismiss) onDismiss(); else setDismissed(true); }} title="Dismiss" aria-label="Dismiss error detail">✕</button>
      </span>
    </div>
  );
}
