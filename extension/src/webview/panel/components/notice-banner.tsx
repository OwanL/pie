/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useState } from 'preact/hooks';

import {
  noticeActionsFor,
  noticeActionLabel,
  type NoticeAction,
  type NoticeKind,
} from '../../../shared/error-mapping';

const TRUNCATE_LENGTH = 120;

export interface NoticeBannerProps {
  notice: string;
  /** Failure category (Brief H). When set, the banner renders recovery action
   *  buttons (Retry / Retry without pruning / Show logs / Open settings /
   *  Restart backend) alongside the message. `null`/`undefined` for plain
   *  info/warning notices — no action buttons. */
  kind?: NoticeKind | null;
  /** Raw, unredacted full error string behind the short `notice` summary, or
   *  null. When present, the banner renders a "Show raw error" toggle that
   *  reveals this verbatim (including internal req-NN ids) for debugging.
   *  Absent for plain info/warning notices. */
  rawDetail?: string | null;
  /** Invoked when the user clicks a recovery action. The parent decides whether
   *  to dismiss the notice afterwards (e.g. Retry dismisses; Show logs does not).
   *  Optional: when absent (or `kind` is null), no action buttons render — the
   *  notice shows its plain-language message (which already names the next
   *  action in prose) + a dismiss. Full action-button wiring is a Brief H
   *  follow-up. */
  onAction?: (action: NoticeAction) => void;
  onDismiss: () => void;
}

export function NoticeBanner({ notice, kind, rawDetail, onAction, onDismiss }: NoticeBannerProps) {
  const isError = notice.toLowerCase().includes('error') || notice.toLowerCase().includes('fail');
  const isLong = notice.length > TRUNCATE_LENGTH;
  const [expanded, setExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const actions = kind ? noticeActionsFor(kind) : [];
  const hasRaw = !!rawDetail && rawDetail !== notice;

  // A new notice replaces the old one in place; reset the exit + expand state
  // so it isn't auto-dismissed and the entrance animation replays.
  useEffect(() => {
    setDismissing(false);
    setRawExpanded(false);
  }, [notice]);

  return (
    <div
      class={`notice${isError ? ' error' : ''}${dismissing ? ' dismissing' : ''}`}
      onAnimationEnd={(e) => {
        if (e.animationName === 'notice-exit') onDismiss();
      }}
    >
      <div class="notice-content">
        <span class={`notice-text${isLong && !expanded ? ' notice-text-truncated' : ''}`}>
          {isLong && !expanded ? notice.slice(0, TRUNCATE_LENGTH) + '…' : notice}
        </span>
        {hasRaw && rawExpanded && (
          <pre class="notice-raw-detail" title="Raw backend error detail">{rawDetail}</pre>
        )}
      </div>
      <div class="notice-actions">
        {actions.map((action) => (
          <button
            key={action}
            class="notice-btn notice-action"
            onClick={() => onAction?.(action)}
            title={noticeActionLabel(action)}
          >
            {noticeActionLabel(action)}
          </button>
        ))}
        {isLong && (
          <button
            class="notice-btn"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Show less' : 'Show more'}
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        {hasRaw && (
          <button
            class="notice-btn"
            onClick={() => setRawExpanded(v => !v)}
            title={rawExpanded ? 'Hide raw error' : 'Show raw error'}
          >
            {rawExpanded ? 'Hide raw' : 'Show raw'}
          </button>
        )}
        <button class="notice-btn notice-dismiss" onClick={() => setDismissing(true)} title="Dismiss" aria-label="Dismiss notice">✕</button>
      </div>
    </div>
  );
}
