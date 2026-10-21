/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { ComposerInput } from '../../lib/protocol/index.js';
import { ComposerAttachments } from '../composer/attachments';
import { describeComposerInputSummary } from '../composer/inputs';
import { useComposerDragDrop } from '../composer/hooks';
import {
  extractComposerInputs,
  formatComposerTransferError,
  hasClipboardFilePayload,
} from '../composer/file-drop';
import { cx } from '../lib/components/cx';
import { createUuidV4 } from '../../../lib/uuid';

interface InlineEditorProps {
  initialText: string;
  /** Queued edits update an undelivered message rather than replacing later turns. */
  queued: boolean;
  /** Existing image inputs seeded from the message being edited. The inline
   *  editor owns its OWN local `inputs` state (NOT the host-owned pending
   *  composer inputs) — additions/removals here don't touch the host until the
   *  edit is confirmed. */
  initialInputs: ComposerInput[];
  /** Captured height of the message body before entering edit mode. */
  capturedHeight: number | null;
  onConfirm: (text: string, inputs: ComposerInput[]) => void;
  onCancel: () => void;
}

export function InlineEditor({ initialText, initialInputs, capturedHeight, queued, onConfirm, onCancel }: InlineEditorProps) {
  const [text, setText] = useState(initialText);
  const [inputs, setInputs] = useState<ComposerInput[]>(initialInputs);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Enter and Save are two independent paths into `onConfirm`, and the host
  // mints a fresh `localId` per submission — so a double-fire issues two edits
  // that both truncate and send. The editor unmounts on the host's next
  // snapshot, not synchronously, so guard locally.
  const submittedRef = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const editor = wrapperRef.current;
    const shell = editor?.closest<HTMLElement>('.message-item-shell');
    return () => {
      if (submittedRef.current || !editor?.contains(document.activeElement)) return;
      // Wait until removal completes: session changes remove the shell too.
      queueMicrotask(() => {
        if (!shell?.isConnected) return;
        const active = document.activeElement;
        if (active !== document.body && active !== null && !editor.contains(active)) return;
        shell.focus({ preventScroll: true });
      });
    };
  }, []);

  const submit = useCallback((nextText: string, nextInputs: ComposerInput[]) => {
    if (submittedRef.current) return;
    if (!nextText.trim() && nextInputs.length === 0) return;
    submittedRef.current = true;
    onConfirm(nextText.trim(), nextInputs);
  }, [onConfirm]);

  const autoSize = useCallback((el: HTMLTextAreaElement) => {
    // Fallback for browsers without field-sizing: content
    if (!CSS.supports('field-sizing', 'content')) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }
  }, []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
    autoSize(el);
  }, [autoSize]);

  const handleInput = useCallback((e: Event) => {
    const el = e.target as HTMLTextAreaElement;
    setText(el.value);
    autoSize(el);
  }, [autoSize]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit(text, inputs);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }, [text, inputs, submit, onCancel]);

  // Mirrors the composer's `applyComposerTransfer` but appends to LOCAL state
  // (no host RPC). Accepts the same input kinds the composer accepts
  // (imageBlob + filesystemPathRef); arbitrary blob files are rejected and
  // surfaced via `attachmentError`.
  const applyTransfer = useCallback(async (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => {
    const { inputs: drafts, rejectedFiles } = await extractComposerInputs(dataTransfer, source);
    const materialized: ComposerInput[] = drafts.map((draft) => ({
      ...draft,
      id: createUuidV4(),
    }) as ComposerInput);
    setInputs((prev) => [...prev, ...materialized]);
    setAttachmentError(formatComposerTransferError(rejectedFiles));
  }, []);

  const handlePaste = useCallback((event: ClipboardEvent) => {
    const dataTransfer = event.clipboardData;
    if (!hasClipboardFilePayload(dataTransfer)) {
      return;
    }
    event.preventDefault();
    void applyTransfer(dataTransfer, 'paste');
  }, [applyTransfer]);

  const { isDragActive, composerShellRef, handleDragOver, handleDragLeave, handleDrop } = useComposerDragDrop({
    applyComposerTransfer: applyTransfer,
  });

  const removeInput = useCallback((id: string) => {
    setInputs((prev) => prev.filter((i) => i.id !== id));
  }, []);

  // Keep the transcript footprint stable while the compact, bordered editor
  // replaces a potentially much taller message body.
  const wrapperStyle = capturedHeight != null
    ? `min-height:${capturedHeight}px`
    : undefined;

  return (
    <div ref={wrapperRef} class="inline-editor-wrapper" style={wrapperStyle}>
      <div
        class={cx('inline-editor', isDragActive && 'border-accent/40 bg-accent/5 shadow-md')}
        ref={composerShellRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ComposerAttachments
          pendingComposerInputs={inputs}
          attachmentSummary={describeComposerInputSummary(inputs)}
          onRemoveInput={removeInput}
        />
        {/* Transfer rejections render ABOVE the textarea, in normal flow, so a
            two-line message grows the editor downward instead of colliding with
            the overlay strip pinned to the textarea's reserved bottom band. */}
        {attachmentError && (
          <div class="composer-hint composer-hint-error" role="status">{attachmentError}</div>
        )}
        <textarea
          ref={textareaRef}
          class="inline-editor-textarea"
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          aria-label="Edit message"
          placeholder="Edit message…"
        />
        <div class="inline-editor-footer">
          {/* In-flow footer region below the scrolling textarea (same shell,
              never an overlay): actions remain anchored at the bottom-right. */}
          <div class="inline-editor-actions">
            <button class="action-btn secondary" type="button" onClick={onCancel}>Cancel</button>
            <button
              class="action-btn primary"
              type="button"
              disabled={!text.trim() && inputs.length === 0}
              onClick={() => submit(text, inputs)}
            >{queued ? 'Save' : 'Send'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
