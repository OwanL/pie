/** @jsxRuntime automatic */
/** @jsxImportSource preact */

export interface ComposerActionsProps {
  busy: boolean;
  /** Brief E: an interrupt was just clicked and the host hasn't yet cleared
   *  `busy`. While true the Stop affordance renders as a disabled "Stopping…"
   *  button so the click reflects within one frame (the host clears `busy`
   *  only after the abort round-trip completes). */
  interrupting?: boolean;
  /** False while the browser renderer has no completed host handshake. */
  commandsAvailable?: boolean;
  /** Steering (FollowUp): true when the transcript has pending 'queued' user
   *  messages (sent while a turn was running). Shows a "Clear queued"
   *  affordance to cancel them without stopping the current turn. */
  hasQueuedMessages: boolean;
  onInterrupt: () => void;
  /** Steering (FollowUp): cancel all queued messages for this session. */
  onClearQueue: () => void;
  sendCurrentText: () => void;
  canSend: boolean;
  /** Empty submit will resume an interrupted assistant turn. */
  continueMode?: boolean;
}

function ClearQueueIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.5 4h6.5M2.5 8h5M2.5 12h4" />
      <path d="m10 9.5 3.5 3.5M13.5 9.5 10 13" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
    </svg>
  );
}

function SubmitIcon({ queued }: { queued: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {queued && <path d="M2.5 3.5h4M4.5 1.5v4" />}
      <path d={queued ? 'M3 10h9' : 'M2.5 8h10'} />
      <path d={queued ? 'm9 7 3 3-3 3' : 'm9.5 5 3 3-3 3'} />
    </svg>
  );
}

export function ComposerActions({
  busy,
  interrupting,
  commandsAvailable = true,
  hasQueuedMessages,
  onInterrupt,
  onClearQueue,
  sendCurrentText,
  canSend,
  continueMode = false,
}: ComposerActionsProps) {
  const submitTitle = interrupting
    ? 'Wait for the current stop to finish'
    : busy
      ? 'Queue message (Enter) — runs after the current turn'
      : continueMode
        ? 'Continue interrupted response (Enter)'
        : 'Send message (Enter)';
  const submitLabel = interrupting
    ? 'Waiting for stop'
    : busy
      ? 'Queue message'
      : continueMode
        ? 'Continue interrupted response'
        : 'Send message';

  return (
    <div class="composer-actions">
      {hasQueuedMessages && (
        <button
          class="action-btn composer-action-icon composer-action-clear"
          type="button"
          title="Clear queued messages (does not stop the current turn)"
          onClick={onClearQueue}
          disabled={!commandsAvailable}
          aria-label="Clear queued messages"
          data-action="clear-queue"
        >
          <ClearQueueIcon />
        </button>
      )}
      {busy && (
        <button
          class={`action-btn danger composer-action-icon composer-action-stop${interrupting ? ' is-stopping' : ''}`}
          type="button"
          title={interrupting ? 'Stopping response…' : 'Interrupt response'}
          onClick={interrupting || !commandsAvailable ? undefined : onInterrupt}
          disabled={interrupting || !commandsAvailable}
          aria-label={interrupting ? 'Stopping response' : 'Interrupt response'}
          aria-busy={interrupting || undefined}
          data-action="stop"
        >
          <StopIcon />
        </button>
      )}
      <button
        class={`action-btn primary composer-action-icon composer-action-submit${busy ? ' is-queue' : ''}${interrupting ? ' is-waiting' : ''}`}
        type="button"
        title={submitTitle}
        onClick={sendCurrentText}
        disabled={!canSend || interrupting || !commandsAvailable}
        aria-label={submitLabel}
        data-action={busy ? 'queue' : continueMode ? 'continue' : 'send'}
      >
        <SubmitIcon queued={busy} />
      </button>
    </div>
  );
}
