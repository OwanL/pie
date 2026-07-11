/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { getComposerRunControls } from '../session-tabs/run-state';

export interface ComposerActionsProps {
  busy: boolean;
  /** Brief E: an interrupt was just clicked and the host hasn't yet cleared
   *  `busy`. While true the Stop affordance renders as a disabled "Stopping…"
   *  button so the click reflects within one frame (the host clears `busy`
   *  only after the abort round-trip completes). */
  interrupting?: boolean;
  hasUserMessages: boolean;
  /** Steering (FollowUp): true when the transcript has pending 'queued' user
   *  messages (sent while a turn was running). Shows a "Clear queued"
   *  affordance to cancel them without stopping the current turn. */
  hasQueuedMessages: boolean;
  completionAction: ReturnType<typeof getComposerRunControls>['action'];
  onMarkComplete?: () => void;
  /** When set, the mark-done button is disabled and its tooltip is replaced
   *  with this reason (e.g. a pending deferred trigger blocks marking done). */
  deferredBlockReason?: string | null;
  onInterrupt: () => void;
  /** Steering (FollowUp): cancel all queued messages for this session. */
  onClearQueue: () => void;
  sendCurrentText: () => void;
  canSend: boolean;
  onOpenFilePicker: () => void;
}

export function ComposerActions({
  busy,
  interrupting,
  hasUserMessages,
  hasQueuedMessages,
  completionAction,
  onMarkComplete,
  deferredBlockReason,
  onInterrupt,
  onClearQueue,
  sendCurrentText,
  canSend,
  onOpenFilePicker,
}: ComposerActionsProps) {
  return (
    <div class="composer-actions flex flex-wrap items-center gap-2">
      <div class="composer-actions-left flex flex-wrap items-center gap-2">
        <button
          class="action-btn icon-only"
          type="button"
          title="Attach file or folder path"
          onClick={onOpenFilePicker}
          aria-label="Attach file or folder path"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        {completionAction && (
          <button
            class={`composer-run-action ${completionAction.tone}`}
            type="button"
            title={deferredBlockReason ?? completionAction.title}
            aria-label={completionAction.ariaLabel}
            aria-disabled={deferredBlockReason ? 'true' : undefined}
            disabled={busy || !hasUserMessages || !onMarkComplete || !!deferredBlockReason}
            onClick={() => onMarkComplete?.()}
          >
            {completionAction.text}
          </button>
        )}
      </div>
      <div class="composer-actions-right ml-auto flex flex-wrap items-center gap-2">
        {hasQueuedMessages && (
          <button
            class="action-btn"
            type="button"
            title="Clear queued messages (does not stop the current turn)"
            onClick={onClearQueue}
            aria-label="Clear queued messages"
          >
            Clear queued
          </button>
        )}
        {busy && (
          interrupting ? (
            <button
              class="action-btn danger"
              type="button"
              title="Stopping…"
              disabled
              aria-label="Stopping response"
              aria-busy="true"
            >
              Stopping…
            </button>
          ) : (
            <button
              class="action-btn danger"
              type="button"
              title="Interrupt"
              onClick={onInterrupt}
              aria-label="Interrupt response"
            >
              Stop
            </button>
          )
        )}
        <button
          class="action-btn primary"
          type="button"
          title={interrupting ? 'Wait for the current stop to finish' : busy ? 'Queue (Enter) — runs after the current turn' : 'Send (Enter)'}
          onClick={sendCurrentText}
          disabled={!canSend || interrupting}
          aria-label={interrupting ? 'Waiting for stop' : busy ? 'Queue message' : 'Send message'}
        >
          {interrupting ? 'Waiting…' : busy ? 'Queue' : 'Send'}
        </button>
      </div>
    </div>
  );
}
