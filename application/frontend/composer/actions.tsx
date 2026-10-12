/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { dictationActive, type DictationView } from '../../lib/protocol/dictation.js';

export interface ComposerActionsProps {
  dictation?: DictationView;
  onToggleDictation?: () => void;
  /** Capability-projected billable activity for the selected session. */
  busy: boolean;
  /** Capability-projected eligibility for the Stop command. */
  canInterrupt?: boolean;
  /** An interrupt was just clicked and the host hasn't yet cleared
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
  /** Empty submit will continue agent work without adding a user message. */
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
  dictation,
  onToggleDictation,
  busy,
  canInterrupt = busy,
  interrupting,
  commandsAvailable = true,
  hasQueuedMessages,
  onInterrupt,
  onClearQueue,
  sendCurrentText,
  canSend,
  continueMode = false,
}: ComposerActionsProps) {
  const dictating = dictationActive(dictation);
  const recording = commandsAvailable && dictation?.available && dictation.phase === 'recording';
  const micBusy = dictation?.available && (dictation.phase === 'preparing' || dictation.phase === 'finalizing');
  const rawLevel = dictation?.audioLevel ?? 0;
  const level = Number.isFinite(rawLevel) ? Math.min(1, Math.sqrt(Math.max(0, rawLevel)) * 2) : 0;
  const micLabel = dictation?.phase === 'preparing' ? 'Preparing — stop dictation' : dictation?.phase === 'finalizing' ? 'Finalizing dictation' : dictating ? 'Stop dictation' : 'Start dictation';
  const submitTitle = interrupting
    ? 'Wait for the current stop to finish'
    : busy
      ? 'Queue message (Enter) — runs after the current turn'
      : continueMode
        ? 'Continue agent work (Enter)'
        : 'Send message (Enter)';
  const submitLabel = interrupting
    ? 'Waiting for stop'
    : busy
      ? 'Queue message'
      : continueMode
        ? 'Continue agent work'
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
      {busy && canInterrupt && (
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
        class={`action-btn composer-action-icon composer-action-mic${recording ? ' is-active' : ''}${micBusy ? ' is-busy' : ''}`}
        style={recording ? { '--mic-halo': `${2 + level * 3}px`, '--mic-halo-opacity': `${20 + level * 25}%` } : undefined}
        type="button"
        aria-label={micLabel}
        aria-pressed={!!recording}
        aria-busy={micBusy || undefined}
        title={recording ? 'Stop dictation — stops after 10 seconds of silence. Editing cancels dictation.' : micLabel}
        disabled={!dictation?.available || dictation.phase === 'finalizing' || (!commandsAvailable && !dictating)}
        onClick={onToggleDictation}
        data-action="dictation"
      >
        {micBusy ? <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 2h8M4 14h8M5 2v3l6 6v3M11 2v3l-6 6v3" /></svg> : <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
          <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" />
          <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2M5.5 14.5h5" />
        </svg>}
      </button>
      <button
        class={`action-btn primary composer-action-icon composer-action-submit${busy ? ' is-queue' : ''}${interrupting ? ' is-waiting' : ''}`}
        type="button"
        title={submitTitle}
        onClick={sendCurrentText}
        disabled={!canSend || interrupting || !commandsAvailable || dictating}
        aria-label={submitLabel}
        data-action={busy ? 'queue' : continueMode ? 'continue' : 'send'}
      >
        <SubmitIcon queued={busy} />
      </button>
    </div>
  );
}
