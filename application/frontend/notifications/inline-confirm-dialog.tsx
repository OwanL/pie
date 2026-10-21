/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef } from 'preact/hooks';

import type { HostToWebviewMessage } from '../../lib/protocol/index.js';

export type InlineConfirmState = Extract<HostToWebviewMessage, { type: 'inlineConfirm' }>;

/**
 * Source-aware inline confirmation: the host
 * delivers model-switch / destructive-revert confirmations to the INITIATING
 * browser renderer as a typed imperative; this dialog renders it and replies
 * `inlineConfirmResponse`. The host proceeds only on explicit confirm;
 * disconnect cancels the pending confirmation.
 *
 * Modal a11y: the Cancel button takes initial focus (safety default), Tab is
 * trapped inside the dialog, Escape answers Cancel, and focus returns to the
 * previously focused element when the dialog unmounts.
 */
export function InlineConfirmDialog({
  confirm,
  onRespond,
}: {
  confirm: InlineConfirmState;
  onRespond: (confirmed: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Initial focus lands on Cancel (the safe choice). The previously focused
  // element is restored when the dialog unmounts so keyboard users are not
  // stranded after the confirmation resolves.
  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    cancelButtonRef.current?.focus();
    return () => {
      restoreFocusRef.current?.focus();
    };
  }, []);

  const messageId = `inline-confirm-message-${confirm.confirmId}`;

  // Escape answers Cancel; Tab is trapped within the dialog's controls.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const handler = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onRespond(false);
        return;
      }
      if (e.key === 'Tab') {
        const focusable = Array.from(
          node.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !node.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !node.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    node.addEventListener('keydown', handler);
    return () => node.removeEventListener('keydown', handler);
  }, [onRespond]);

  return (
    <div
      data-inline-confirm
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={messageId}
        style={{
          maxWidth: 420,
          width: 'calc(100% - 32px)',
          padding: 16,
          borderRadius: 6,
          background: 'var(--vscode-editorWidget-background, #252526)',
          border: '1px solid var(--vscode-editorWidget-border, #454545)',
          color: 'var(--vscode-foreground, #cccccc)',
          fontSize: 13,
          lineHeight: 1.5,
        }}
      >
        <div
          id={messageId}
          style={{ marginBottom: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
        >
          {confirm.message}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            ref={cancelButtonRef}
            data-inline-confirm-cancel
            onClick={() => onRespond(false)}
            style={buttonStyle(false)}
          >
            Cancel
          </button>
          <button
            type="button"
            data-inline-confirm-ok
            onClick={() => onRespond(true)}
            style={buttonStyle(true)}
          >
            {confirm.confirmChoice}
          </button>
        </div>
      </div>
    </div>
  );
}

function buttonStyle(primary: boolean): Record<string, string | number> {
  return {
    padding: '4px 14px',
    borderRadius: 4,
    border: '1px solid var(--vscode-button-border, transparent)',
    background: primary
      ? 'var(--vscode-button-background, #0e639c)'
      : 'var(--vscode-button-secondaryBackground, #3a3d41)',
    color: primary
      ? 'var(--vscode-button-foreground, #ffffff)'
      : 'var(--vscode-button-secondaryForeground, #ffffff)',
    cursor: 'pointer',
    fontSize: 13,
  };
}