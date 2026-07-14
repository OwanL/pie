/** @jsxRuntime automatic */
/** @jsxImportSource preact */
/// <reference types="vite/client" />

import { options, render } from 'preact';

import './styles/index.css';

import type { WebviewToHostMessage } from '../../shared/protocol';
import { App } from './app';
import { isSuspenseThenable, sanitizedRenderFailure, sanitizedRenderLog } from './render-error';
import { setWebviewLogSink } from './utils/log';

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

/** Read the host-stamped generation; malformed/missing markup never guesses. */
export function getViewGeneration(): number | undefined {
  const raw = document.querySelector('meta[name="pie-view-generation"]')?.getAttribute('content');
  const value = raw === null || raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function withHandshakeMetadata(
  msg: Extract<WebviewToHostMessage, { type: 'ready' | 'refreshState' | 'requestSnapshot' }>,
): WebviewToHostMessage {
  const viewGeneration = getViewGeneration();
  return {
    ...msg,
    assetVersion: getAssetVersion(),
    ...(viewGeneration === undefined ? {} : { viewGeneration }),
  };
}

export function withViewGeneration(msg: WebviewToHostMessage): WebviewToHostMessage {
  const viewGeneration = getViewGeneration();
  return viewGeneration === undefined ? msg : { ...msg, viewGeneration };
}

function postMessage(msg: WebviewToHostMessage): void {
  if (msg.type === 'ready' || msg.type === 'refreshState' || msg.type === 'requestSnapshot') {
    vscodeApi.postMessage(withHandshakeMetadata(msg));
    return;
  }

  vscodeApi.postMessage(withViewGeneration(msg));
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

function reportRenderFailure(
  classification: 'component_error' | 'uncaught_error' | 'unhandled_rejection',
  scope: 'panel' | 'webview',
): void {
  // Host logs are deliberately classification-only. The original error stays
  // local to the overlay below, where it is useful to the person debugging.
  console.error(`[pie:webview:${scope}] render failure`, classification);
  postMessage(sanitizedRenderLog(classification, scope));
  postMessage({ type: 'renderFailure', payload: sanitizedRenderFailure(classification) });
}

const prevCatchError = (options as any).__e;
(options as any).__e = (error: any, vnode: any, oldVNode: any) => {
  // Lazy components suspend by throwing a Promise through this hook. Let
  // preact/compat's Suspense handler consume it; reporting it as a crash both
  // hides the fallback and produces the unhelpful "[object Promise]" overlay.
  if (isSuspenseThenable(error)) {
    if (prevCatchError) return prevCatchError(error, vnode, oldVNode);
    throw error;
  }

  reportRenderFailure('component_error', 'panel');
  showRenderErrorOverlay(error);
  if (prevCatchError) prevCatchError(error, vnode, oldVNode);
};

window.addEventListener('error', () => {
  reportRenderFailure('uncaught_error', 'panel');
});

window.addEventListener('unhandledrejection', () => {
  reportRenderFailure('unhandled_rejection', 'webview');
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
