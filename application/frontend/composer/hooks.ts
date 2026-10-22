/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type {
  ComposerInputDraft,
  WebviewToHostMessage,
} from '../../lib/protocol/index.js';
import { dictationActive, type DictationView } from '../../lib/protocol/dictation.js';
import { useUndo } from './use-undo';
import { shouldHandleGlobalComposerPaste } from './affordances';
import {
  canAcceptComposerTransfer,
  extractComposerInputs,
  formatComposerTransferError,
  hasClipboardFilePayload,
  shouldHandleComposerDrop,
} from './file-drop';

export { useComposerIndicators } from './use-composer-indicators';
export { useTokenRateIndicator } from '../analytics/use-token-rate';
export type { TokenRateIndicatorState } from '../analytics/use-token-rate';
export { computeTurnLatencyStats, formatAvgTurnLatency, formatTurnLatencyTooltipLines } from '../analytics/turn-latency';
export type { TurnLatencyStats } from '../analytics/turn-latency';

const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;
/** Idle window that groups a typing burst into a single undo checkpoint,
 * mirroring how word processors undo by word/action rather than per keystroke. */
const CHECKPOINT_DEBOUNCE_MS = 500;
const DICTATION_START_ACK_TIMEOUT_MS = 15_000;

/** Coordination snapshot for one native historyUndo/historyRedo gesture
 * between the beforeinput and input handlers. */
interface PendingNativeUndoRedo {
  kind: 'undo' | 'redo';
  /** Composer text before the native gesture (the repair snapshot). */
  preGestureText: string;
  /** The custom history already processed the gesture (keydown echo or a
   * cancelable beforeinput); the matched input must not repeat it. */
  applied: boolean;
  /** The text the applied gesture produced (the repair target for the
   * matched input). Unused while `applied` is false. */
  targetText: string;
}

function mobileVisibleHeight(): number | undefined {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function'
    || !window.matchMedia('(pointer: coarse)').matches) return undefined;
  const viewport = window.visualViewport;
  return viewport?.scale === 1 ? viewport.height : window.innerHeight;
}

export function resizeComposerTextarea(textarea: HTMLTextAreaElement, visibleHeight = mobileVisibleHeight()): void {
  const maxHeight = typeof visibleHeight === 'number' && Number.isFinite(visibleHeight) && visibleHeight > 0
    ? Math.min(COMPOSER_TEXTAREA_MAX_HEIGHT, Math.max(48, Math.floor(visibleHeight / 4)))
    : COMPOSER_TEXTAREA_MAX_HEIGHT;
  // Measure without native scrollbar chrome shrinking the text's available width.
  textarea.style.overflowY = 'hidden';
  textarea.style.height = 'auto';
  const contentHeight = textarea.scrollHeight;
  textarea.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  // Short textareas can otherwise expose native arrow buttons for rounding overflow.
  textarea.style.overflowY = contentHeight > maxHeight ? 'auto' : 'hidden';
}

export function useComposerInput({
  busy,
  sendBlocked = false,
  allowEmptySend = false,
  onSend,
  onRetrySend,
  pendingComposerInputsLength,
  initialRows,
  sessionPath,
  resolvedPendingPath,
  draftText,
  postMessage,
  draftRestore,
  focusTrigger,
  onAddInput,
  supportsImageInputs,
  dictation,
  commandsAvailable,
}: {
  busy: boolean;
  dictation?: DictationView;
  commandsAvailable?: boolean;
  /** Prevent both button and keyboard submission while a Stop is settling. */
  sendBlocked?: boolean;
  /** Allow a blank submit to resume an interrupted turn without a user message. */
  allowEmptySend?: boolean;
  onSend: (text: string) => boolean | void;
  /** Retry re-send. Mirrors `onSend` but the host disables pruning
   *  atomically before re-sending when `disablePruning` is set ("retry without
   *  pruning"). Invoked by `sendAsRetry` (registered into `sendRetryDraftRef`
   *  in AppBody so the NoticeBanner's Retry button can re-send the live draft). */
  onRetrySend: (text: string, disablePruning?: boolean) => boolean | void;
  pendingComposerInputsLength: number;
  /** Empty-composer row count; changing it re-fits any existing inline height. */
  initialRows: number;
  sessionPath: string | null;
  resolvedPendingPath?: string;
  draftText: string;
  postMessage: (msg: WebviewToHostMessage) => void;
  draftRestore?: { text: string; nonce: number } | null;
  focusTrigger?: string;
  onAddInput: (input: ComposerInputDraft, sessionPath?: string) => void;
  supportsImageInputs: boolean;
}) {
  // Async reads belong to the selection/admission lifetime that started them.
  // Track transitions during render so A→B→A cannot resurrect an old read.
  const [pendingTransferReads, setPendingTransferReads] = useState(0);
  const transferOwnerRef = useRef({ sessionPath, commandsAvailable, generation: 0, mounted: true, pending: 0, tail: Promise.resolve() });
  const owner = transferOwnerRef.current;
  if (owner.sessionPath !== sessionPath || owner.commandsAvailable !== commandsAvailable) {
    const sameSessionResolution = owner.sessionPath !== null
      && owner.sessionPath === resolvedPendingPath && sessionPath !== null
      && owner.commandsAvailable === commandsAvailable;
    if (!sameSessionResolution) {
      owner.generation++;
      owner.pending = 0;
      owner.tail = Promise.resolve();
    }
    owner.sessionPath = sessionPath;
    owner.commandsAvailable = commandsAvailable;
  }
  const transferStateRef = useRef({ supportsImageInputs, onAddInput });
  transferStateRef.current = { supportsImageInputs, onAddInput };
  useEffect(() => () => {
    transferOwnerRef.current.mounted = false;
    transferOwnerRef.current.generation++;
  }, []);
  const [text, setTextState] = useState('');
  const editGenerationRef = useRef(0);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [dictationStartError, setDictationStartError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftPostTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Previous active session path, used to distinguish a pending→resolved path
  // resolution (same session, path string changed) from a genuine session
  // switch. See the [sessionPath] seed effect below.
  const prevSessionPathRef = useRef<string | null>(null);
  // Last host draft observed for this exact session. A same-session snapshot
  // may carry a rollback restore after the transient `sendRejected` imperative
  // was lost to renderer reconnect. Compare against this baseline so that
  // authoritative recovery can repopulate an unchanged local composer without
  // clobbering newer, not-yet-debounced typing.
  const hostDraftBaselineRef = useRef({ sessionPath, draftText });
  // Word-processor-style undo/redo history for the composer text. It lives in a
  // dedicated past/present/future store so it survives the
  // programmatic clear on send — letting Ctrl+Z step back to a prompt that was
  // deleted or already sent. The live `text` state still drives the controlled
  // textarea; history.present only advances on debounced checkpoints so undo
  // groups typing bursts instead of stepping per character.
  const [history, { set: setHistory, reset: resetHistory, undo, redo, canUndo, canRedo }] =
    useUndo<string>('');
  const checkpointTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keydown echo latch: set when the KEYDOWN route applies (or consumes via
  // flush-discard) an undo/redo gesture. Non-compliant engines deliver a native
  // beforeinput historyUndo/historyRedo echo right after the keydown task; the
  // same-direction echo is swallowed instead of applying a second time. The
  // latch is consumed by the echo itself or resets at the event-task boundary
  // (setTimeout(0)); only keyboard gestures arm it, so back-to-back native
  // (beforeinput) gestures — e.g. two mobile-IME undos in successive tasks —
  // all apply regardless of how close they are.
  const undoRedoEchoLatchRef = useRef<'undo' | 'redo' | null>(null);
  const undoRedoEchoLatchResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Pending native history gesture: the handoff between a native
  // historyUndo/historyRedo beforeinput and its matched trusted input event.
  // The native mutation cannot always be canceled (noncancelable beforeinput,
  // or an engine that also delivers the input after a prevented beforeinput);
  // the snapshot lets the input handler repair the DOM and apply the custom
  // history exactly once instead of repeating the application. Markers are
  // consumed by the matched input, overwritten by the next gesture, or expire
  // at the next task boundary (for applied markers) — never wallclock-deduped.
  const pendingNativeUndoRedoRef = useRef<PendingNativeUndoRedo | null>(null);
  const pendingNativeUndoRedoResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearPendingNativeUndoRedo = useCallback(() => {
    if (pendingNativeUndoRedoResetRef.current) {
      clearTimeout(pendingNativeUndoRedoResetRef.current);
      pendingNativeUndoRedoResetRef.current = null;
    }
    pendingNativeUndoRedoRef.current = null;
  }, []);
  const setPendingNativeUndoRedo = useCallback((snapshot: PendingNativeUndoRedo) => {
    pendingNativeUndoRedoRef.current = snapshot;
    if (!snapshot.applied) return;
    // Conforming engines deliver no input after a cancelable (prevented)
    // beforeinput; expire the applied marker at the next event-task boundary
    // (setTimeout(0), the echo-latch boundary) so a later GENUINE input-only
    // gesture is never mistaken for the stray echo of the applied one.
    // Deferred markers stay armed: their matched input is spec-guaranteed.
    if (pendingNativeUndoRedoResetRef.current) clearTimeout(pendingNativeUndoRedoResetRef.current);
    pendingNativeUndoRedoResetRef.current = setTimeout(() => {
      pendingNativeUndoRedoResetRef.current = null;
      if (pendingNativeUndoRedoRef.current?.applied) pendingNativeUndoRedoRef.current = null;
    }, 0);
  }, []);
  const armUndoRedoEchoLatch = useCallback((kind: 'undo' | 'redo') => {
    undoRedoEchoLatchRef.current = kind;
    // A native pair cannot legitimately span a fresh keydown gesture; drop any
    // leaked snapshot so it cannot swallow a later genuine gesture.
    clearPendingNativeUndoRedo();
    if (undoRedoEchoLatchResetRef.current) clearTimeout(undoRedoEchoLatchResetRef.current);
    // setTimeout(0), not queueMicrotask: the echo, when present, is delivered
    // in a separate event task right after the keydown task, and the latch
    // must stay armed across that task boundary. A 0 ms timer is the earliest
    // boundary past it — no longer than the input task itself.
    undoRedoEchoLatchResetRef.current = setTimeout(() => {
      undoRedoEchoLatchResetRef.current = null;
      undoRedoEchoLatchRef.current = null;
    }, 0);
  }, [clearPendingNativeUndoRedo]);
  const pendingStartRef = useRef<{ recordingId: string; baselineText: string; editGeneration: number } | null>(null);
  const cancelledStartDraftRef = useRef<{ sessionPath: string; editGeneration: number } | null>(null);
  const pendingStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dictationUndoRef = useRef<string | null>(null);
  const cancelledDictationRef = useRef<string | null>(null);
  const setText = useCallback((value: string) => {
    editGenerationRef.current++;
    setTextState(value);
  }, []);
  const clearPendingStart = useCallback(() => {
    pendingStartRef.current = null;
    if (pendingStartTimerRef.current) {
      clearTimeout(pendingStartTimerRef.current);
      pendingStartTimerRef.current = null;
    }
  }, []);
  const activeDictation = dictation?.sessionPath === sessionPath && dictationActive(dictation);
  const cancelRecording = useCallback((recordingId: string, ownerPath: string) => {
    if (cancelledDictationRef.current === recordingId) return;
    cancelledDictationRef.current = recordingId;
    postMessage({ type: 'dictationCancel', sessionPath: ownerPath, recordingId });
  }, [postMessage]);
  const cancelDictation = useCallback(() => {
    if (activeDictation && dictation?.recordingId && sessionPath) {
      cancelRecording(dictation.recordingId, sessionPath);
    }
  }, [activeDictation, dictation, sessionPath, cancelRecording]);

  const clearCheckpointTimer = useCallback(() => {
    if (checkpointTimerRef.current) {
      clearTimeout(checkpointTimerRef.current);
      checkpointTimerRef.current = null;
    }
  }, []);

  const scheduleCheckpoint = useCallback((value: string) => {
    clearCheckpointTimer();
    checkpointTimerRef.current = setTimeout(() => {
      checkpointTimerRef.current = null;
      setHistory(value, true);
    }, CHECKPOINT_DEBOUNCE_MS);
  }, [clearCheckpointTimer, setHistory]);

  // Commit a pending (not yet debounced) checkpoint immediately, using the live
  // textarea value, so an undo/redo started mid-burst accounts for the burst:
  // without this flush the burst's edits exist only in the timer and the first
  // Ctrl+Z of rapid typing (including the very first burst after a session
  // seed) would step over the live text and lose it from the history entirely.
  // Returns true when a checkpoint was recorded (the burst became the present).
  const flushPendingCheckpoint = useCallback((): boolean => {
    if (checkpointTimerRef.current === null) return false;
    clearCheckpointTimer();
    const textarea = textareaRef.current;
    const live = textarea ? textarea.value : text;
    if (live === history.present) return false;
    setHistory(live, true);
    return true;
  }, [clearCheckpointTimer, setHistory, text, history.present]);

  // Drop any pending checkpoint timer and native pair snapshot if the composer
  // unmounts (e.g. the panel is disposed) so neither can fire on a stale instance.
  useEffect(() => () => {
    clearCheckpointTimer();
    clearPendingNativeUndoRedo();
  }, [clearCheckpointTimer, clearPendingNativeUndoRedo]);

  // Re-fit the textarea height after any text change (typing, undo/redo, draft
  // seed/restore). Running in a post-commit effect means dom.value already
  // reflects the new text, so scrollHeight is correct — without ever writing
  // textarea.value directly during undo/redo (which would fight the controlled
  // input in real browsers: Preact skips DOM updates when the prop already
  // equals dom.value, so a pre-commit write can desync the field).
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      resizeComposerTextarea(textarea);
    }
  }, [text, initialRows]);

  // A mobile keyboard can reduce the visible height without changing the draft.
  // Refit the existing textarea, leaving its value and undo history untouched.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const viewport = window.visualViewport;
    const refit = () => {
      if (viewport && viewport.scale !== 1) return;
      if (textareaRef.current) resizeComposerTextarea(textareaRef.current);
    };
    window.addEventListener('resize', refit);
    viewport?.addEventListener('resize', refit);
    return () => {
      window.removeEventListener('resize', refit);
      viewport?.removeEventListener('resize', refit);
    };
  }, []);

  // Latch that suppresses a second submit between the moment we post a send
  // and when the host round-trip flips `busy` to true (or clears pending
  // inputs). `busy` is the durable latch but lags a round-trip; this ref closes
  // the window where `pendingComposerInputs.length > 0` would otherwise let
  // Enter re-fire sendCurrentText with empty text.
  const submitting = useRef(false);

  useEffect(() => {
    // Keyboard tab navigation owns focus until the user leaves the tablist.
    if (focusTrigger !== undefined && !document.activeElement?.closest('[role="tablist"]')) {
      textareaRef.current?.focus();
    }
  }, [focusTrigger]);

  // Seed the composer text from the host-persisted draft when the component
  // mounts or the active session changes. Host-backed draftText is the source
  // of truth across reloads and session switches.
  //
  // Exception: when the active path is a pending tab resolving to its real
  // backend path, this is the SAME logical session — not a user-driven switch.
  // The live `text` (including any keystrokes not yet debounced to the host)
  // is the most up-to-date source of truth, so preserve it (and its undo
  // history) instead of re-seeding from the host draft. Re-seeding here would
  // clobber in-progress typing when the session finishes loading, because the
  // draft for the just-resolved path lags the last keystrokes by up to the
  // 300 ms post debounce (and was keyed under the pending path until the host
  // migrates it on PendingPathReplaced).
  useEffect(() => {
    const prevSessionPath = prevSessionPathRef.current;
    const pendingStart = pendingStartRef.current;
    const resolvedSessionPath = sessionPath;
    const dictationResolution = resolvedSessionPath !== null && prevSessionPath === null && pendingStart !== null
      && dictation?.recordingId === pendingStart.recordingId && dictation.sessionPath === resolvedSessionPath;
    if (prevSessionPath !== sessionPath && !dictationResolution) clearPendingStart();
    dictationUndoRef.current = null;
    prevSessionPathRef.current = sessionPath;
    hostDraftBaselineRef.current = { sessionPath, draftText };

    const isPendingResolution = (
      prevSessionPath !== null &&
      prevSessionPath === resolvedPendingPath &&
      sessionPath !== null &&
      sessionPath !== prevSessionPath
    );

    if (dictationResolution && resolvedSessionPath !== null) {
      const locallyEdited = text !== pendingStart.baselineText
        || editGenerationRef.current !== pendingStart.editGeneration;
      const recordingId = pendingStart.recordingId;
      clearPendingStart();
      setDictationStartError(null);
      if (locallyEdited) {
        // Start may have been sent before the host resolved its new session path.
        // Preserve newer local edits and make the edit undoable as one action.
        if (text !== pendingStart.baselineText) setHistory(text, true);
        cancelRecording(recordingId, resolvedSessionPath);
        postMessage({ type: 'setComposerDraft', sessionPath: resolvedSessionPath, text });
        cancelledStartDraftRef.current = { sessionPath: resolvedSessionPath, editGeneration: editGenerationRef.current };
        dictationUndoRef.current = null;
        return;
      }
      clearCheckpointTimer();
      setHistory(draftText, true);
      dictationUndoRef.current = recordingId;
      setTextState(draftText);
      return;
    }
    if (isPendingResolution) {
      // Pending → resolved: same session, only the path string changed.
      // Preserve the live composer state (text + undo history).
      return;
    }

    // Attachment feedback belongs to the logical session, not the mounted
    // composer. Pending-path resolution above preserves that ownership.
    if (prevSessionPath !== sessionPath) setAttachmentError(null);

    // A genuine tab switch can happen inside the 300 ms draft debounce. Its
    // cleanup cancels the pending timer before it posts, so explicitly commit
    // the outgoing session's live value at the ownership boundary. Without
    // this flush the original draft is lost when the seed below commits.
    if (prevSessionPath !== null && sessionPath !== prevSessionPath) {
      postMessage({ type: 'setComposerDraft', sessionPath: prevSessionPath, text });
    }

    clearCheckpointTimer();
    // Start a fresh undo history per session — undo never crosses sessions.
    // A native beforeinput/input pair cannot span a session switch, so any
    // pending snapshot here is a leaked one; drop it with the history.
    clearPendingNativeUndoRedo();
    resetHistory(draftText);
    setTextState(draftText);
    submitting.current = false;
    const textarea = textareaRef.current;
    if (textarea) {
      // Seed the DOM value directly so resizeComposerTextarea reads the new
      // content synchronously (the setText re-render has not committed yet).
      // Mirrors the draftRestore effect below; otherwise switching to a
      // session with a multi-line draft shows a 1-row textarea with scroll.
      textarea.value = draftText;
      resizeComposerTextarea(textarea);
    }
  }, [sessionPath, clearPendingStart]);

  useEffect(() => {
    const pendingStart = pendingStartRef.current;
    if (pendingStart !== null && dictation?.recordingId === pendingStart.recordingId
      && dictation.sessionPath === sessionPath) {
      clearPendingStart();
      setDictationStartError(null);
      if (editGenerationRef.current !== pendingStart.editGeneration && sessionPath !== null) {
        cancelRecording(pendingStart.recordingId, sessionPath);
        postMessage({ type: 'setComposerDraft', sessionPath, text });
        cancelledStartDraftRef.current = { sessionPath, editGeneration: editGenerationRef.current };
      }
    }
  }, [dictation, sessionPath, clearPendingStart, cancelRecording, postMessage, text]);

  useEffect(() => {
    if (commandsAvailable === false) clearPendingStart();
  }, [commandsAvailable, clearPendingStart]);

  useEffect(() => () => clearPendingStart(), [clearPendingStart]);

  // The session-path seed above handles mounts/navigation, but reconnect does
  // not necessarily remount the app or change the active path. Adopt a newer
  // host draft on the same session only while the local editor still equals
  // the prior host baseline. That is the pre-ack send-rollback shape: the
  // locally-cleared composer is restored by the next authoritative snapshot
  // even when `sendRejected` could not be delivered.
  useEffect(() => {
    const previous = hostDraftBaselineRef.current;
    hostDraftBaselineRef.current = { sessionPath, draftText };
    const cancelledStartDraft = cancelledStartDraftRef.current;
    if (cancelledStartDraft && cancelledStartDraft.sessionPath !== sessionPath) {
      cancelledStartDraftRef.current = null;
    } else if (cancelledStartDraft && cancelledStartDraft.editGeneration === editGenerationRef.current) {
      return;
    }
    if (previous.sessionPath !== sessionPath || previous.draftText === draftText) return;
    if (text !== previous.draftText) return;

    clearCheckpointTimer();
    const recordingId = dictation?.sessionPath === sessionPath ? dictation.recordingId : null;
    setHistory(draftText, !recordingId || dictationUndoRef.current !== recordingId);
    dictationUndoRef.current = recordingId;
    setTextState(draftText);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.value = draftText;
      resizeComposerTextarea(textarea);
    }
  }, [draftText, dictation?.recordingId]);

  // Debounce-post draft text back to the host so it survives reloads and
  // session switches. A 300 ms window coalesces rapid keystrokes.
  useEffect(() => {
    if (sessionPath === null) return;
    if (text === draftText) return;

    if (draftPostTimeoutRef.current) {
      clearTimeout(draftPostTimeoutRef.current);
    }
    draftPostTimeoutRef.current = setTimeout(() => {
      draftPostTimeoutRef.current = null;
      postMessage({ type: 'setComposerDraft', sessionPath, text });
    }, 300);

    return () => {
      if (draftPostTimeoutRef.current) {
        clearTimeout(draftPostTimeoutRef.current);
        draftPostTimeoutRef.current = null;
      }
    };
  }, [text, sessionPath, draftText, postMessage]);

  useEffect(() => {
    if (!draftRestore) {
      return;
    }

    clearCheckpointTimer();
    // Checkpoint the restore so a single Ctrl+Z steps back to the prior state
    // (e.g. the post-send empty composer) rather than a duplicate of the text.
    setHistory(draftRestore.text, true);
    setTextState(draftRestore.text);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.value = draftRestore.text;
      resizeComposerTextarea(textarea);
      textarea.focus();
    }
  }, [draftRestore?.nonce]);

  // Clear the submit latch once the host acknowledges the send: either by
  // flipping `busy` to true (the durable latch takes over) or by clearing the
  // pending attachments that were keeping canSend true.
  useEffect(() => {
    if (busy) {
      submitting.current = false;
    }
  }, [busy]);

  useEffect(() => {
    if (pendingComposerInputsLength === 0) {
      submitting.current = false;
    }
  }, [pendingComposerInputsLength]);

  const resetComposer = useCallback(() => {
    setTextState('');
    setAttachmentError(null);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }, []);

  const sendCurrentText = useCallback(() => {
    const trimmed = text.trim();
    if (submitting.current || sendBlocked || activeDictation || pendingStartRef.current || transferOwnerRef.current.pending > 0) return;
    if (trimmed.length === 0 && pendingComposerInputsLength === 0 && !allowEmptySend) return;
    submitting.current = true;
    if (onSend(trimmed) === false) {
      submitting.current = false;
      return;
    }
    // Steering: when sending while already busy (a queued steering
    // injection), `busy` is already true so the [busy] effect that normally
    // clears the submit latch won't fire — clear it now so the user can queue
    // another message. The text is cleared by `resetComposer` below, so the
    // trimmed-length guard + disabled Send button prevent an accidental
    // immediate re-send from the same closure.
    if (busy) {
      submitting.current = false;
    }
    // Make the send undoable: sync present to the sent text (no history entry),
    // then checkpoint the clear so Ctrl+Z restores what was just sent.
    clearCheckpointTimer();
    setHistory(trimmed);
    setHistory('', true);
    resetComposer();
  }, [allowEmptySend, busy, sendBlocked, activeDictation, onSend, pendingComposerInputsLength, resetComposer, setHistory, clearCheckpointTimer, text]);

  // Re-send the current draft as a `retrySend` (optionally disabling
  // pruning first). Mirrors `sendCurrentText` (trim + submit-latch + clear +
  // undo checkpoint) but routes through `onRetrySend` so the host can disable
  // pruning atomically before the re-send. Registered into `sendRetryDraftRef`
  // (AppBody) so the NoticeBanner's Retry / Retry-without-pruning buttons re-send
  // the LIVE draft (honoring an edit between rejection and retry — `draftRestore`
  // would be stale once the user types).
  //
  // Returns whether the re-send actually dispatched. Guards (submit latch,
  // send block, dictation, pending start, empty composer, busy) and a
  // rejected `onRetrySend` return `false`; only `true` lets the caller
  // (`useNoticeAction`) dismiss the error notice — a no-op retry must not
  // clear the banner reporting the error that motivated it.
  const sendAsRetry = useCallback((disablePruning?: boolean): boolean => {
    const trimmed = text.trim();
    if (submitting.current || sendBlocked || activeDictation || pendingStartRef.current || transferOwnerRef.current.pending > 0) return false;
    if ((trimmed.length === 0 && pendingComposerInputsLength === 0) || busy) return false;
    submitting.current = true;
    if (onRetrySend(trimmed, disablePruning) === false) {
      submitting.current = false;
      return false;
    }
    clearCheckpointTimer();
    setHistory(trimmed);
    setHistory('', true);
    resetComposer();
    return true;
  }, [busy, sendBlocked, activeDictation, onRetrySend, pendingComposerInputsLength, resetComposer, setHistory, clearCheckpointTimer, text]);

  // Returns the text the gesture produced, or null when nothing was applied
  // (boundary reached, or a redo consumed by the flush-discard). The value lets
  // the native gesture routes record the exact repair target for the matched
  // or stray input event that follows the native mutation.
  const undoComposer = useCallback((): string | null => {
    cancelDictation();
    // Record the live burst first (see flushPendingCheckpoint) so its edits are
    // recoverable, then step to the pre-burst checkpoint. A flushed burst becomes
    // the new present; without a burst the previous checkpoint is the target.
    const burstRecorded = flushPendingCheckpoint();
    if (!burstRecorded && !canUndo) return null;
    const target = burstRecorded
      ? history.present
      : history.past[history.past.length - 1] ?? '';
    undo();
    setText(target);
    return target;
    // Height is re-fit by the [text] effect above — we intentionally do NOT
    // write textarea.value directly here. Setting it before Preact commits the
    // controlled value can desync the input in real browsers.
  }, [canUndo, flushPendingCheckpoint, history.present, history.past, undo, setText, cancelDictation]);

  const redoComposer = useCallback((): string | null => {
    cancelDictation();
    // Flush any pending burst first: every pending checkpoint comes from typing
    // after the last undo/redo, and recording it clears the redo stack
    // (word-processor behavior — new edits discard redo), so nothing further
    // may be redone on top of the live value.
    if (flushPendingCheckpoint()) return null;
    if (!canRedo) return null;
    const target = history.future[0] ?? '';
    redo();
    setText(target);
    return target;
    // See undoComposer: height is handled by the [text] effect, not a direct
    // textarea.value write.
  }, [canRedo, flushPendingCheckpoint, history.future, redo, setText, cancelDictation]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) {
        return;
      }

      // Word-processor undo/redo. We always preventDefault so the browser's
      // native textarea undo (which a controlled input fights, and which cannot
      // survive the programmatic clear on send) never partially applies.
      const mod = e.ctrlKey || e.metaKey;
      if (mod) {
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) {
          e.preventDefault();
          // Arm the echo latch even when the composer call below is a no-op
          // (including the flush-discard path): the engine's echoes must be
          // swallowed whatever the keyboard gesture actually consumed.
          armUndoRedoEchoLatch('undo');
          undoComposer();
          return;
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          armUndoRedoEchoLatch('redo');
          redoComposer();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentText();
      }
    },
    [undoComposer, redoComposer, sendCurrentText, armUndoRedoEchoLatch],
  );

  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    const inputType = (e as InputEvent).inputType;
    if (inputType === 'historyUndo' || inputType === 'historyRedo') {
      const kind = inputType === 'historyUndo' ? 'undo' : 'redo';
      // Coordinate with the beforeinput handler via the pending native gesture
      // snapshot: this input repairs the native DOM mutation and applies the
      // custom history exactly once, never repeating an application the
      // beforeinput (or keydown) route already made.
      const pendingNative = pendingNativeUndoRedoRef.current;
      if (pendingNative?.kind === kind) {
        pendingNativeUndoRedoRef.current = null;
        if (pendingNative.applied) {
          // Already applied by the keydown or cancelable-beforeinput route.
          // The matched or stray input only restores the applied target text.
          target.value = pendingNative.targetText;
          return;
        }
        // Matched input of a deferred noncancelable beforeinput: the native
        // mutation landed, so restore the pre-gesture value first (the flush
        // below must observe it), then apply the custom history once.
        target.value = pendingNative.preGestureText;
        if (kind === 'undo') undoComposer();
        else redoComposer();
        return;
      }
      if (undoRedoEchoLatchRef.current === kind) {
        // Input-only echo of the just-applied keyboard gesture (an engine
        // whose echo carries no beforeinput): swallow it exactly like the
        // beforeinput echo path.
        undoRedoEchoLatchRef.current = null;
        if (undoRedoEchoLatchResetRef.current) {
          clearTimeout(undoRedoEchoLatchResetRef.current);
          undoRedoEchoLatchResetRef.current = null;
        }
        target.value = text;
        return;
      }
      // Chromium execCommand (and some native editing routes) emits input
      // without a beforeinput for an UNSEEN gesture. Its native stack is stale
      // after our controlled writes. Restore the pre-event value before
      // flushing a live burst, then use our history rather than checkpointing
      // native corruption.
      target.value = text;
      if (kind === 'undo') undoComposer();
      else redoComposer();
      return;
    }
    cancelDictation();
    if (pendingStartRef.current) editGenerationRef.current++;
    setTextState(target.value);
    resizeComposerTextarea(target);
    scheduleCheckpoint(target.value);
  }, [scheduleCheckpoint, cancelDictation, text, undoComposer, redoComposer]);

  const applyComposerTransfer = useCallback(async (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => {
    const owner = transferOwnerRef.current;
    const ownerPath = owner.sessionPath;
    const generation = owner.generation;
    if (!ownerPath || !owner.mounted || owner.commandsAvailable === false) return;
    owner.pending++;
    setPendingTransferReads(owner.pending);
    const predecessor = owner.tail;
    let release!: () => void;
    owner.tail = new Promise<void>((resolve) => { release = resolve; });
    // Start reads immediately, but commit separate gestures in admission order.
    const extraction = extractComposerInputs(dataTransfer, source).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
    await predecessor;
    const outcome = await extraction;
    if (!owner.mounted || owner.generation !== generation) return;
    if (!('result' in outcome)) {
      setAttachmentError('Could not read the selected attachment. Try again.');
      return;
    }
    const { inputs, unsupportedInputs, rejectedFiles } = outcome.result;
    const { supportsImageInputs, onAddInput } = transferStateRef.current;
    const acceptedInputs = supportsImageInputs
      ? inputs
      : inputs.filter((input) => input.kind !== 'imageBlob');
    const blockedImageCount = supportsImageInputs
      ? 0
      : inputs.filter((input) => input.kind === 'imageBlob').length;

    for (const input of acceptedInputs) {
      onAddInput(input, owner.sessionPath ?? undefined);
    }
    for (const unsupportedInput of unsupportedInputs) {
      onAddInput(unsupportedInput, owner.sessionPath ?? undefined);
    }

    const unsupportedFileMessage = formatComposerTransferError(rejectedFiles);
    const blockedImageMessage = blockedImageCount > 0
      ? 'The selected model does not support image inputs. Switch to an image-capable model to paste or drop images.'
      : null;
    setAttachmentError([blockedImageMessage, unsupportedFileMessage].filter(Boolean).join(' ') || null);
    } finally {
      release();
      if (owner.mounted && owner.generation === generation) {
        owner.pending--;
        setPendingTransferReads(owner.pending);
      }
    }
  }, []);

  const handlePaste = useCallback((event: ClipboardEvent) => {
    const dataTransfer = event.clipboardData;
    if (!hasClipboardFilePayload(dataTransfer)) {
      return;
    }

    event.preventDefault();
    void applyComposerTransfer(dataTransfer, 'paste');
  }, [applyComposerTransfer]);

  // Block the browser's native textarea undo/redo (undo/redo is driven by our
  // history: native undo fights the controlled value after our programmatic
  // changes and cannot survive the programmatic clear on send), but route the
  // native gesture through the SAME undo/redo: engines that bypass the keydown
  // route (e.g. mobile keyboards) deliver historyUndo/historyRedo only here.
  // When the keyboard route just applied (or consumed) the same gesture, the
  // engine's echo is swallowed without applying it a second time. Native-only
  // gestures (no keydown) never arm the echo latch, so genuine back-to-back
  // native gestures all apply.
  //
  // Cancelability decides WHO applies: a cancelable beforeinput stops the
  // native mutation and applies the custom history immediately; a noncancelable
  // one cannot stop the native mutation and its matched input event follows —
  // so it only records a pending snapshot and the input handler repairs the
  // DOM and applies the gesture exactly once (see handleInput).
  const handleBeforeInput = useCallback((event: Event) => {
    const inputType = (event as InputEvent).inputType;
    if (inputType !== 'historyUndo' && inputType !== 'historyRedo') return;
    event.preventDefault();
    const kind = inputType === 'historyUndo' ? 'undo' : 'redo';
    if (undoRedoEchoLatchRef.current === kind) {
      // The echo of the just-applied keyboard gesture; consume the latch so a
      // genuinely later native gesture (even in the very next task) applies.
      undoRedoEchoLatchRef.current = null;
      if (undoRedoEchoLatchResetRef.current) {
        clearTimeout(undoRedoEchoLatchResetRef.current);
        undoRedoEchoLatchResetRef.current = null;
      }
      // Some engines deliver a matched input event as part of the echo pair:
      // the snapshot makes handleInput repair the DOM without re-applying.
      // `text` is the value the keydown route applied and committed before
      // this echo task.
      setPendingNativeUndoRedo({ kind, preGestureText: text, applied: true, targetText: text });
      return;
    }
    if (!event.cancelable) {
      // Noncancelable beforeinput: the native mutation is already on its way
      // and the matched input event follows immediately. Defer — the input
      // handler repairs the DOM from this pre-gesture snapshot and applies the
      // custom history exactly once; applying here AND there would repeat the
      // traversal.
      setPendingNativeUndoRedo({ kind, preGestureText: text, applied: false, targetText: '' });
      return;
    }
    // Cancelable beforeinput: the native mutation is blocked, so the custom
    // history applies here. A stray matched input (if any engine delivers one
    // after the prevented event) must only repair, not repeat, this gesture.
    const targetText = kind === 'undo' ? undoComposer() : redoComposer();
    setPendingNativeUndoRedo({ kind, preGestureText: text, applied: true, targetText: targetText ?? text });
  }, [undoComposer, redoComposer, setPendingNativeUndoRedo, text]);

  const toggleDictation = useCallback(() => {
    if (activeDictation) {
      if (dictation?.available && dictation.phase !== 'finalizing' && dictation.recordingId && sessionPath) {
        postMessage({ type: 'dictationStop', sessionPath, recordingId: dictation.recordingId });
      }
      return;
    }
    if (pendingStartRef.current || sendBlocked || commandsAvailable === false) return;
    if (!dictation?.available) return;
    if (draftPostTimeoutRef.current) {
      clearTimeout(draftPostTimeoutRef.current);
      draftPostTimeoutRef.current = null;
    }
    clearCheckpointTimer();
    setHistory(text);
    hostDraftBaselineRef.current = { sessionPath, draftText };
    if (sessionPath) postMessage({ type: 'setComposerDraft', sessionPath, text });
    const recordingId = crypto.randomUUID();
    pendingStartRef.current = { recordingId, baselineText: text, editGeneration: editGenerationRef.current };
    setDictationStartError(null);
    pendingStartTimerRef.current = setTimeout(() => {
      pendingStartTimerRef.current = null;
      if (pendingStartRef.current?.recordingId !== recordingId) return;
      pendingStartRef.current = null;
      setDictationStartError('Dictation did not start. Try again.');
    }, DICTATION_START_ACK_TIMEOUT_MS);
    dictationUndoRef.current = null;
    const textarea = textareaRef.current;
    postMessage({ type: 'dictationStart', sessionPath, recordingId, draftText: text,
      selectionStart: textarea?.selectionStart ?? text.length,
      selectionEnd: textarea?.selectionEnd ?? text.length });
  }, [commandsAvailable, sendBlocked, activeDictation, dictation, sessionPath, postMessage, text, clearCheckpointTimer, setHistory]);

  return {
    transferPending: pendingTransferReads > 0 && transferOwnerRef.current.pending > 0,
    toggleDictation,
    text,
    setText,
    textareaRef,
    attachmentError,
    dictationStartError,
    sendCurrentText,
    sendAsRetry,
    handleKeyDown,
    handleInput,
    handlePaste,
    handleBeforeInput,
    applyComposerTransfer,
    submitting,
  };
}

export function useComposerDragDrop({
  applyComposerTransfer,
}: {
  applyComposerTransfer: (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => Promise<void>;
}) {
  const [isDragActive, setIsDragActive] = useState(false);
  const composerShellRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((event: DragEvent) => {
    if (!canAcceptComposerTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
    setIsDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && composerShellRef.current?.contains(nextTarget)) {
      return;
    }
    setIsDragActive(false);
  }, []);

  const handleDrop = useCallback((event: DragEvent) => {
    setIsDragActive(false);
    if (!shouldHandleComposerDrop(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    void applyComposerTransfer(event.dataTransfer, 'drop');
  }, [applyComposerTransfer]);

  return {
    isDragActive,
    composerShellRef,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  };
}

export function useComposerPaste({
  applyComposerTransfer,
  textareaRef,
}: {
  applyComposerTransfer: (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => Promise<void>;
  textareaRef: { current: HTMLTextAreaElement | null };
}) {
  useEffect(() => {
    const handleDocumentPaste = (event: ClipboardEvent) => {
      if (!shouldHandleGlobalComposerPaste(event.target)) {
        return;
      }

      const dataTransfer = event.clipboardData;
      if (!hasClipboardFilePayload(dataTransfer)) {
        return;
      }

      event.preventDefault();
      textareaRef.current?.focus();
      void applyComposerTransfer(dataTransfer, 'paste');
    };

    document.addEventListener('paste', handleDocumentPaste);
    return () => document.removeEventListener('paste', handleDocumentPaste);
  }, [applyComposerTransfer]);
}

export function useComposerHeightSync(composerAreaRef: { current: HTMLDivElement | null }) {
  useEffect(() => {
    const el = composerAreaRef.current;
    if (!el) return;

    const update = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      try {
        document.documentElement.style.setProperty('--composer-height', `${height}px`);
      } catch {
        // ignore
      }
    };

    update();

    // Use ResizeObserver to respond to textarea growth and other layout changes.
    const ro = new (window as any).ResizeObserver(() => update());
    ro.observe(el);
    window.addEventListener('resize', update, { passive: true });

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, []);
}
