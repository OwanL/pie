/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { HostToWebviewMessage } from '../../../shared/protocol';

export type InlineConfirmState = Extract<HostToWebviewMessage, { type: 'inlineConfirm' }>;

/**
 * Source-aware inline confirmation (browser server plan §2.2/§9): the host
 * delivers model-switch / destructive-revert confirmations to the INITIATING
 * browser renderer as a typed imperative; this dialog renders it and replies
 * `inlineConfirmResponse`. The host proceeds only on explicit confirm;
 * disconnect cancels the pending confirmation.
 */
export function InlineConfirmDialog({
  confirm,
  onRespond,
}: {
  confirm: InlineConfirmState;
  onRespond: (confirmed: boolean) => void;
}) {
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
        role="dialog"
        aria-modal="true"
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
        <div style={{ marginBottom: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {confirm.message}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
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
