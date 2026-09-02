/** @jsxRuntime automatic */
/** @jsxImportSource preact */
/// <reference types="vite/client" />

import { options, render } from 'preact';

import './styles/index.css';

import type { WebviewToHostMessage } from '../../shared/protocol';
import { App } from './app';
import {
  isBenignResizeObserverError,
  isSuspenseThenable,
  sanitizedRenderDiagnostic,
  sanitizedRenderFailure,
  sanitizedRenderLog,
  type SanitizedRenderDiagnostic,
} from './render-error';
import { setWebviewLogSink } from './utils/log';
import {
  BrowserClientTransport,
  VsCodeClientTransport,
  getAssetVersion,
  getViewGeneration,
  withHandshakeMetadata,
  withViewGeneration,
  type ClientTransport,
} from '../transport/client-transport';
import { pendingCommandStore } from '../transport/pending-command-store';

// Re-exported for the handshake contract tests (the VS Code transport owns
// the HTML-stamped metadata now; panel.tsx remains the module under test).
export { getAssetVersion, getViewGeneration, withHandshakeMetadata, withViewGeneration };

// ─── Transport bootstrap (browser server plan §4.3) ─────────────────────────
// Browser mode is selected by server-injected bootstrap metadata, not by a
// separate bundle. The HTTP HTML stamps only stable page data: asset version,
// transport kind, and the WebSocket route. VS Code HTML continues to stamp its
// existing generation metadata.

function readTransportMeta(): { kind: 'browser'; wsRoute: string } | { kind: 'vscode' } {
  const transport = document.querySelector('meta[name="pie-transport"]')?.getAttribute('content');
  if (transport === 'browser') {
    const wsRoute = document.querySelector('meta[name="pie-ws-route"]')?.getAttribute('content') ?? '/ws';
    return { kind: 'browser', wsRoute };
  }
  return { kind: 'vscode' };
}

function createTransport(): ClientTransport {
  const meta = readTransportMeta();
  if (meta.kind === 'browser') {
    const transport = new BrowserClientTransport({
      wsRoute: meta.wsRoute,
      onHandshake: () => {
        // Reconnect reconciliation (§5.2): every unknown/pending command is
        // answered by a bounded read-only `commandStatusRequest` against the
        // host decision ledger — never replayed.
        for (const entry of pendingCommandStore.unknownEntries()) {
          transport.postMessage({ type: 'commandStatusRequest', clientCommandId: entry.clientCommandId });
        }
      },
    });
    // Browser lifecycle messages are sent before timers are throttled where
    // possible; a hidden renderer never triggers reload escalation.
    const sendVisibility = (): void => transport.sendLifecycle('rendererVisibilityChanged', !document.hidden);
    const sendFocus = (): void => transport.sendLifecycle('rendererFocusChanged', document.hasFocus());
    document.addEventListener('visibilitychange', sendVisibility);
    window.addEventListener('focus', sendFocus);
    window.addEventListener('blur', sendFocus);
    transport.connect();
    return transport;
  }
  return new VsCodeClientTransport();
}

const transport = createTransport();

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

const AMBIENT_ERROR_LOG_WINDOW_MS = 10_000;
const MAX_AMBIENT_ERROR_FINGERPRINTS = 32;
const ambientErrorLastLoggedAt = new Map<string, number>();
const fatalErrorsAwaitingWindowEvent = new WeakSet<object>();

function isWeakSetKey(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function shouldLogAmbientError(
  classification: 'uncaught_error' | 'unhandled_rejection',
  diagnostic: SanitizedRenderDiagnostic,
): boolean {
  const now = Date.now();
  const fingerprint = `${classification}:${diagnostic.errorName ?? ''}:${diagnostic.errorMessage}`;
  const lastLoggedAt = ambientErrorLastLoggedAt.get(fingerprint);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < AMBIENT_ERROR_LOG_WINDOW_MS) return false;
  if (!ambientErrorLastLoggedAt.has(fingerprint)
    && ambientErrorLastLoggedAt.size >= MAX_AMBIENT_ERROR_FINGERPRINTS) {
    const oldestFingerprint = ambientErrorLastLoggedAt.keys().next().value;
    if (typeof oldestFingerprint === 'string') ambientErrorLastLoggedAt.delete(oldestFingerprint);
  }
  ambientErrorLastLoggedAt.delete(fingerprint);
  ambientErrorLastLoggedAt.set(fingerprint, now);
  return true;
}

function reportRenderFailure(
  classification: 'component_error',
  scope: 'panel',
  error: unknown,
): void {
  const diagnostic = sanitizedRenderDiagnostic(error);
  if (isWeakSetKey(error)) fatalErrorsAwaitingWindowEvent.add(error);
  console.error(`[pie:webview:${scope}] fatal render failure`, classification, diagnostic);
  postMessage(sanitizedRenderLog(classification, scope, diagnostic, { fatal: true }));
  postMessage({ type: 'renderFailure', payload: sanitizedRenderFailure(classification) });
}

function reportAmbientError(
  classification: 'uncaught_error' | 'unhandled_rejection',
  scope: 'panel' | 'webview',
  diagnostic: SanitizedRenderDiagnostic,
  benign = false,
): void {
  if (!shouldLogAmbientError(classification, diagnostic)) return;
  const level = benign ? 'warn' : 'error';
  console[level](`[pie:webview:${scope}] non-fatal browser error`, classification, diagnostic);
  postMessage(sanitizedRenderLog(classification, scope, diagnostic, {
    fatal: false,
    benign,
    level,
  }));
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

  reportRenderFailure('component_error', 'panel', error);
  showRenderErrorOverlay(error);
  if (prevCatchError) prevCatchError(error, vnode, oldVNode);
};

window.addEventListener('error', (event) => {
  if (isWeakSetKey(event.error) && fatalErrorsAwaitingWindowEvent.delete(event.error)) return;
  const benign = isBenignResizeObserverError(event.message);
  reportAmbientError('uncaught_error', 'panel', sanitizedRenderDiagnostic(event.error, {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
  }), benign);
});

window.addEventListener('unhandledrejection', (event) => {
  reportAmbientError(
    'unhandled_rejection',
    'webview',
    sanitizedRenderDiagnostic(event.reason),
  );
});

// ─── Mount ───────────────────────────────────────────────────────────────────

const postMessage = (msg: WebviewToHostMessage): void => {
  transport.postMessage(msg);
};

const adapter = { postMessage, transport };

// H4: forward webview logs to the host (pie OutputChannel / pie.log) so they
// are durable + visible without opening devtools. `postMessage` is owned here
// (the sole transport), so the sink is injected rather than re-acquired.
setWebviewLogSink(postMessage);

const container = document.getElementById('app');
if (container) {
  render(<App adapter={adapter} />, container);
}
