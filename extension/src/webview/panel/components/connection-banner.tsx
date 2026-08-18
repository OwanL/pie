/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ClientConnectionState } from '../../transport/client-transport';

/**
 * Compact connection banner (browser server plan §8.1): shown ONLY while the
 * browser transport is not connected. It never replaces or mutates
 * authoritative session state; the VS Code transport is always `connected`
 * while mounted, so this banner never renders there.
 */
export function ConnectionBanner({ state }: { state: ClientConnectionState }) {
  const label = state === 'connecting' ? 'Connecting…' : 'Reconnecting…';
  return (
    <div
      data-connection-banner
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 1000,
        padding: '4px 12px',
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--vscode-editorWarning-foreground, #cca700)',
        background: 'var(--vscode-editorWidget-background, #252526)',
        borderBottom: '1px solid var(--vscode-editorWidget-border, #454545)',
        textAlign: 'center',
      }}
    >
      {label} — commands are not sent until the connection is restored.
    </div>
  );
}
