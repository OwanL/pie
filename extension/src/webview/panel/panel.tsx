/** @jsxRuntime automatic */
/** @jsxImportSource preact */
/// <reference types="vite/client" />

import { options, render } from 'preact';

import './styles/index.css';

import type { WebviewToHostMessage } from '../../shared/protocol';
import { App } from './app';
import { webviewLog, setWebviewLogSink } from './utils/log';

// ─── VS Code API ─────────────────────────────────────────────────────────────

declare function acquireVsCodeApi(): {
  postMessage(msg: WebviewToHostMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

function getAssetVersion(): string | undefined {
  return document.querySelector('meta[name="pie-asset-version"]')?.getAttribute('content') ?? undefined;
}

function postMessage(msg: WebviewToHostMessage): void {
  if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
    vscodeApi.postMessage({
      ...msg,
      assetVersion: getAssetVersion(),
    });
    return;
  }

  vscodeApi.postMessage(msg);
}

// ─── Error handling ──────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showRenderErrorOverlay(error: unknown) {
  const existing = document.getElementById('pie-render-error-overlay');
  if (existing) return;

  const overlay = document.createElement('div');
  overlay.id = 'pie-render-error-overlay';
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 99999;
    background: var(--vscode-editorWidget-background, #1e1e1e);
    color: var(--vscode-errorForeground, #f48771);
    padding: 16px; overflow: auto; font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px; line-height: 1.5;
  `;
  const stack = (error as any)?.stack || String(error);
  overlay.innerHTML = `
    <h2 style="margin:0 0 8px; font-size:14px; color: var(--vscode-errorForeground, #f48771);">Render Crash</h2>
    <p style="margin:0 0 12px; color: var(--vscode-foreground, #ccc);">
      The webview crashed during render. This is usually caused by a missing field in the state contract.
      Check <code>protocol.ts</code> interfaces match the component expectations.
    </p>
    <pre style="white-space:pre-wrap; word-break:break-all; margin:0; padding:12px; background:var(--vscode-editor-background, #111); border-radius:4px;">${escapeHtml(String(stack))}</pre>
    <p style="margin:12px 0 0; font-size:11px; color: var(--vscode-descriptionForeground, #888);">
      Run <code>npm run typecheck</code> in extension/ to find type mismatches.
      Check %TEMP%/pie-boot-trace.jsonl for full trace.
    </p>
  `;
  document.body.appendChild(overlay);
}

const prevCatchError = (options as any).__e;
(options as any).__e = (error: any, vnode: any, oldVNode: any) => {
  webviewLog('error', 'panel', 'Preact render error', { error: String(error?.stack || error) });
  postMessage({ type: 'stateApplied', payload: { revision: -999, backendReady: false, transcriptLoaded: false, openTabCount: 0, transcriptCount: 0, systemPromptCount: 0, domTranscriptLoaderPresent: false, domTabsConnectingPresent: false, renderError: String(error?.stack || error) } } as any);
  showRenderErrorOverlay(error);
  if (prevCatchError) prevCatchError(error, vnode, oldVNode);
};

window.addEventListener('error', (e) => {
  webviewLog('error', 'panel', 'Uncaught error', { error: String(e.error?.stack || e.error) });
});

window.addEventListener('unhandledrejection', (e) => {
  webviewLog('error', 'webview', 'unhandledrejection', e.reason);
});

// ─── Mount ───────────────────────────────────────────────────────────────────

const adapter = { postMessage };

// H4: forward webview logs to the host (pie OutputChannel / pie.log) so they
// are durable + visible without opening devtools. `postMessage` is owned here
// (the sole `acquireVsCodeApi`), so the sink is injected rather than re-acquired.
setWebviewLogSink(postMessage);

const container = document.getElementById('app');
if (container) {
  render(<App adapter={adapter} />, container);
}
