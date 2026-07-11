/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type {
  ComposerInputDraft,
  WebviewToHostMessage,
} from '../../../shared/protocol';
import { isPendingTabPath } from '../../../shared/tab-behavior';
import useUndo from 'use-undo';
import { shouldHandleGlobalComposerPaste } from './affordances';
import {
  canAcceptComposerTransfer,
  extractComposerInputs,
  formatComposerTransferError,
  hasClipboardFilePayload,
} from '../file-drop';

export { useComposerIndicators } from './use-composer-indicators';
export { useTokenRateIndicator, tickTokenRate, createTokenRateAccumulator } from './use-token-rate';
export type { TokenRateIndicatorState } from './use-token-rate';
export { computeTurnLatencyStats, formatAvgTurnLatency, formatTurnLatencyTooltipLines } from './turn-latency';
export type { TurnLatencyStats } from './turn-latency';

const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;
/** Idle window that groups a typing burst into a single undo checkpoint,
 * mirroring how word processors undo by word/action rather than per keystroke. */
const CHECKPOINT_DEBOUNCE_MS = 500;

export function resizeComposerTextarea(textarea: HTMLTextAreaElement): void {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
}

export function useComposerInput({
  busy,
  sendBlocked = false,
  onSend,
  onRetrySend,
  pendingComposerInputsLength,
  sessionPath,
  draftText,
  postMessage,
  draftRestore,
  focusTrigger,
  onAddInput,
  supportsImageInputs,
}: {
  busy: boolean;
  /** Prevent both button and keyboard submission while a Stop is settling. */
  sendBlocked?: boolean;
  onSend: (text: string) => void;
  /** Brief H: retry re-send. Mirrors `onSend` but the host disables pruning
   *  atomically before re-sending when `disablePruning` is set ("retry without
   *  pruning"). Invoked by `sendAsRetry` (registered into `sendRetryDraftRef`
   *  in AppBody so the NoticeBanner's Retry button can re-send the live draft). */
  onRetrySend: (text: string, disablePruning?: boolean) => void;
  pendingComposerInputsLength: number;
  sessionPath: string | null;
  draftText: string;
  postMessage: (msg: WebviewToHostMessage) => void;
  draftRestore?: { text: string; nonce: number } | null;
  focusTrigger?: string;
  onAddInput: (input: ComposerInputDraft) => void;
  supportsImageInputs: boolean;
}) {
  const [text, setText] = useState('');
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftPostTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Previous active session path, used to distinguish a pending→resolved path
  // resolution (same session, path string changed) from a genuine session
  // switch. See the [sessionPath] seed effect below.
  const prevSessionPathRef = useRef<string | null>(null);
  // Word-processor-style undo/redo history for the composer text. It lives in a
  // dedicated past/present/future store (use-undo) so it survives the
  // programmatic clear on send — letting Ctrl+Z step back to a prompt that was
  // deleted or already sent. The live `text` state still drives the controlled
  // textarea; history.present only advances on debounced checkpoints so undo
  // groups typing bursts instead of stepping per character.
  const [history, { set: setHistory, reset: resetHistory, undo, redo, canUndo, canRedo }] =
    useUndo<string>('', { useCheckpoints: true });
  const checkpointTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Drop any pending checkpoint timer if the composer unmounts (e.g. the panel is
  // disposed) so it can't fire setHistory on a stale instance.
  useEffect(() => () => {
    clearCheckpointTimer();
  }, [clearCheckpointTimer]);

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
  }, [text]);

  // Latch that suppresses a second submit between the moment we post a send
  // and when the host round-trip flips `busy` to true (or clears pending
  // inputs). `busy` is the durable latch but lags a round-trip; this ref closes
  // the window where `pendingComposerInputs.length > 0` would otherwise let
  // Enter re-fire sendCurrentText with empty text.
  const submitting = useRef(false);

  useEffect(() => {
    if (focusTrigger !== undefined) {
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
    prevSessionPathRef.current = sessionPath;

    if (
      prevSessionPath !== null &&
      isPendingTabPath(prevSessionPath) &&
      sessionPath !== null &&
      !isPendingTabPath(sessionPath)
    ) {
      // Pending → resolved: same session, only the path string changed.
      // Preserve the live composer state (text + undo history).
      return;
    }

    clearCheckpointTimer();
    // Start a fresh undo history per session — undo never crosses sessions.
    resetHistory(draftText);
    setText(draftText);
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
  }, [sessionPath]);

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
    setText(draftRestore.text);
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
    setText('');
    setAttachmentError(null);
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
    }
  }, []);

  const sendCurrentText = useCallback(() => {
    const trimmed = text.trim();
    if (submitting.current || sendBlocked) return;
    if (trimmed.length === 0 && pendingComposerInputsLength === 0) return;
    submitting.current = true;
    onSend(trimmed);
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
  }, [busy, sendBlocked, onSend, pendingComposerInputsLength, resetComposer, setHistory, clearCheckpointTimer, text]);

  // Brief H: re-send the current draft as a `retrySend` (optionally disabling
  // pruning first). Mirrors `sendCurrentText` (trim + submit-latch + clear +
  // undo checkpoint) but routes through `onRetrySend` so the host can disable
  // pruning atomically before the re-send. Registered into `sendRetryDraftRef`
  // (AppBody) so the NoticeBanner's Retry / Retry-without-pruning buttons re-send
  // the LIVE draft (honoring an edit between rejection and retry — `draftRestore`
  // would be stale once the user types).
  const sendAsRetry = useCallback((disablePruning?: boolean) => {
    const trimmed = text.trim();
    if (submitting.current) return;
    if ((trimmed.length === 0 && pendingComposerInputsLength === 0) || busy) return;
    submitting.current = true;
    onRetrySend(trimmed, disablePruning);
    clearCheckpointTimer();
    setHistory(trimmed);
    setHistory('', true);
    resetComposer();
  }, [busy, onRetrySend, pendingComposerInputsLength, resetComposer, setHistory, clearCheckpointTimer, text]);

  const undoComposer = useCallback(() => {
    if (!canUndo) return;
    clearCheckpointTimer();
    const target = history.past[history.past.length - 1] ?? '';
    undo();
    setText(target);
    // Height is re-fit by the [text] effect above — we intentionally do NOT
    // write textarea.value directly here. Setting it before Preact commits the
    // controlled value can desync the input in real browsers.
  }, [canUndo, clearCheckpointTimer, history.past, undo]);

  const redoComposer = useCallback(() => {
    if (!canRedo) return;
    clearCheckpointTimer();
    const target = history.future[0] ?? '';
    redo();
    setText(target);
    // See undoComposer: height is handled by the [text] effect, not a direct
    // textarea.value write.
  }, [canRedo, clearCheckpointTimer, history.future, redo]);

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
          undoComposer();
          return;
        }
        if ((key === 'z' && e.shiftKey) || key === 'y') {
          e.preventDefault();
          redoComposer();
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendCurrentText();
      }
    },
    [undoComposer, redoComposer, sendCurrentText],
  );

  const handleInput = useCallback((e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    setText(target.value);
    resizeComposerTextarea(target);
    scheduleCheckpoint(target.value);
  }, [scheduleCheckpoint]);

  const applyComposerTransfer = useCallback(async (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => {
    const { inputs, unsupportedInputs, rejectedFiles } = await extractComposerInputs(dataTransfer, source);
    const acceptedInputs = supportsImageInputs
      ? inputs
      : inputs.filter((input) => input.kind !== 'imageBlob');
    const blockedImageCount = supportsImageInputs
      ? 0
      : inputs.filter((input) => input.kind === 'imageBlob').length;

    for (const input of acceptedInputs) {
      onAddInput(input);
    }
    for (const unsupportedInput of unsupportedInputs) {
      onAddInput(unsupportedInput);
    }

    const unsupportedFileMessage = formatComposerTransferError(rejectedFiles);
    const blockedImageMessage = blockedImageCount > 0
      ? 'The selected model does not support image inputs. Switch to an image-capable model to paste or drop images.'
      : null;
    setAttachmentError([blockedImageMessage, unsupportedFileMessage].filter(Boolean).join(' ') || null);
  }, [onAddInput, supportsImageInputs]);

  const handlePaste = useCallback((event: ClipboardEvent) => {
    const dataTransfer = event.clipboardData;
    if (!hasClipboardFilePayload(dataTransfer)) {
      return;
    }

    event.preventDefault();
    void applyComposerTransfer(dataTransfer, 'paste');
  }, [applyComposerTransfer]);

  // Block the browser's native textarea undo/redo at the input level so it can
  // never partially apply on top of our history (undo/redo is driven from
  // handleKeyDown). Native undo would otherwise fight the controlled value
  // after our programmatic changes and produce garbled/doubled text.
  const handleBeforeInput = useCallback((event: Event) => {
    const inputType = (event as InputEvent).inputType;
    if (inputType === 'historyUndo' || inputType === 'historyRedo') {
      event.preventDefault();
    }
  }, []);

  return {
    text,
    setText,
    textareaRef,
    attachmentError,
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
    if (!canAcceptComposerTransfer(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    setIsDragActive(false);
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
