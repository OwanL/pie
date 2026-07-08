/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type { ComposerInput } from '../../../shared/protocol';
import { ComposerAttachments } from '../composer/attachments';
import { describeComposerInputSummary } from '../composer/inputs';
import { useComposerDragDrop } from '../composer/hooks';
import {
  extractComposerInputs,
  formatComposerTransferError,
  hasClipboardFilePayload,
} from '../file-drop';
import { cx } from '../utils/cx';

interface InlineEditorProps {
  initialText: string;
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

export function InlineEditor({ initialText, initialInputs, capturedHeight, onConfirm, onCancel }: InlineEditorProps) {
  const [text, setText] = useState(initialText);
  const [inputs, setInputs] = useState<ComposerInput[]>(initialInputs);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
      if (text.trim() || inputs.length > 0) onConfirm(text.trim(), inputs);
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }, [text, inputs, onConfirm, onCancel]);

  // Mirrors the composer's `applyComposerTransfer` but appends to LOCAL state
  // (no host RPC). Accepts the same input kinds the composer accepts
  // (imageBlob + filesystemPathRef); arbitrary blob files are rejected and
  // surfaced via `attachmentError`.
  const applyTransfer = useCallback(async (dataTransfer: DataTransfer | null, source: 'drop' | 'paste') => {
    const { inputs: drafts, rejectedFiles } = await extractComposerInputs(dataTransfer, source);
    const materialized: ComposerInput[] = drafts.map((draft) => ({
      ...draft,
      id: crypto.randomUUID(),
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

  // min-height locks the container to prevent scroll shift
  const containerStyle = capturedHeight != null
    ? `min-height:${capturedHeight}px;position:relative`
    : 'position:relative';

  return (
    <div class="inline-editor-wrapper">
      <div
        class={cx('inline-editor', isDragActive && 'border-accent/40 bg-accent/5 shadow-md')}
        style={containerStyle}
        ref={composerShellRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <ComposerAttachments
          pendingComposerInputs={inputs}
          attachmentSummary={describeComposerInputSummary(inputs)}
          showAttachmentSummary={inputs.length > 1}
          onRemoveInput={removeInput}
        />
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
        {attachmentError && (
          <div class="composer-hint composer-hint-error" role="status">{attachmentError}</div>
        )}
        <div class="inline-editor-actions">
          <button class="action-btn secondary" type="button" onClick={onCancel}>Cancel</button>
          <button
            class="action-btn primary"
            type="button"
            disabled={!text.trim() && inputs.length === 0}
            onClick={() => { if (text.trim() || inputs.length > 0) onConfirm(text.trim(), inputs); }}
          >Save</button>
        </div>
      </div>
    </div>
  );
}
