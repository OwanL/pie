/**
 * Renderer-local local-file-open flow (protocol v14): `prepareLocalFileOpen`
 * → targeted `localFileOpenResult`.
 *
 * State here is deliberately renderer-local and never enters ViewState: a
 * click either (a) pre-opens a blank popup tab inside the click's user
 * activation — browser surfaces only — then navigates it when the host
 * reports the verified URL, or (b) for desktop (`vscode`) surfaces waits for
 * the host adapter, which opens the verified URL externally itself. Popup
 * blockers, timeouts, unavailable origins, and host failures surface as
 * transient renderer-local feedback through `registerLocalFileOpenReporter`.
 */

import type { HostToWebviewMessage, WebviewToHostMessage } from '../../lib/protocol/index.js';

export type LocalFileOpenResultMessage = Extract<HostToWebviewMessage, { type: 'localFileOpenResult' }>;
export type RendererTransportSurface = 'vscode' | 'browser';
export type LocalFileOpenFeedback =
  | { kind: 'error'; message: string }
  | { kind: 'info'; message: string };

export interface LocalFileOpenTarget {
  path: string;
  reference?: string;
  workingDirectory?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

interface PendingEntry {
  popup: Window | null;
  timeoutId: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingEntry>();

type FeedbackReporter = (feedback: LocalFileOpenFeedback) => void;
let feedbackReporter: FeedbackReporter | null = null;

/** Register the transient feedback surface; unregistered feedback is a silent
 *  no-op (never a global notice or host state). */
export function registerLocalFileOpenReporter(reporter: FeedbackReporter | null): () => void {
  feedbackReporter = reporter;
  return () => { if (feedbackReporter === reporter) feedbackReporter = null; };
}

function reportFeedback(feedback: LocalFileOpenFeedback): void {
  feedbackReporter?.(feedback);
}

/** Same server-injected bootstrap meta the transport selection reads: real
 *  browser renderers open popups themselves; the VS Code sidebar never does. */
export function readRendererTransportSurface(): RendererTransportSurface {
  return document.querySelector('meta[name="pie-transport"]')?.getAttribute('content') === 'browser'
    ? 'browser'
    : 'vscode';
}

/** Whether a file is browser-openable HTML (`.html`/`.htm`, case-insensitive). */
export function isLocalHtmlFilePath(path: string): boolean {
  const leaf = path.replace(/[\\/]+$/u, '').split(/[\\/]/).at(-1)?.toLowerCase() ?? '';
  return leaf.endsWith('.html') || leaf.endsWith('.htm');
}

/**
 * Begin one open: browser surfaces consume the click's user activation by
 * pre-opening the popup, so the later host round trip cannot be popup-blocked.
 * A blocked popup fails before any host request. Returns false when nothing
 * was sent (popup blocked or transport rejected).
 */
export function beginLocalFileOpen(
  postMessage: (message: WebviewToHostMessage) => boolean,
  target: LocalFileOpenTarget,
  surface: RendererTransportSurface = readRendererTransportSurface(),
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): boolean {
  const requestId = `local-file-open:${Date.now()}:${Math.random()}`;
  let popup: Window | null = null;
  if (surface === 'browser') {
    popup = window.open('', '_blank');
    if (!popup) {
      reportFeedback({
        kind: 'error',
        message: 'This browser blocked the popup, so the file could not be opened.',
      });
      return false;
    }
  }
  const timeoutId = setTimeout(() => {
    const entry = pending.get(requestId);
    if (!entry) return;
    settlePending(entry);
    pending.delete(requestId);
    reportFeedback({ kind: 'error', message: 'Opening the file timed out. Please retry.' });
  }, timeoutMs);
  const entry: PendingEntry = { popup, timeoutId };
  pending.set(requestId, entry);
  const sent = postMessage({
    type: 'prepareLocalFileOpen',
    requestId,
    path: target.path,
    ...(target.reference !== undefined ? { reference: target.reference } : {}),
    ...(target.workingDirectory !== undefined ? { workingDirectory: target.workingDirectory } : {}),
  });
  // A rejected send can never produce a result; the placeholder must not linger.
  if (!sent && pending.get(requestId) === entry) {
    settlePending(entry);
    pending.delete(requestId);
  }
  return sent;
}

/** Apply one targeted result; returns false for unknown results (owner was
 *  already cleared, e.g. after a disconnect) so the caller can drop them. */
export function receiveLocalFileOpenResult(message: LocalFileOpenResultMessage): boolean {
  const entry = pending.get(message.requestId);
  if (!entry) return false;
  pending.delete(message.requestId);
  clearTimeout(entry.timeoutId);

  if (message.status === 'ready' && typeof message.url === 'string' && message.url.length > 0) {
    if (message.openIn === 'popup') {
      if (entry.popup && !entry.popup.closed) entry.popup.location.href = message.url;
      else {
        reportFeedback({
          kind: 'error',
          message: 'The prepared tab was closed before it could open the file. Please retry.',
        });
      }
    }
    // `openIn:'external'`: a desktop host adapter already opened the verified
    // URL in the OS default browser; a browser popup navigates itself.
    else reportFeedback({ kind: 'info', message: 'Opened the file in your default browser.' });
    return true;
  }
  // Unavailable: never let a blank orphan popup remain.
  settlePending(entry);
  reportFeedback({
    kind: 'error',
    message: message.error ?? 'The file could not be opened.',
  });
  return true;
}

/** Renderer disconnect/host change: no result will ever arrive; close blank
 *  placeholders without feedback noise. */
export function clearLocalFileOpenRequests(): void {
  const entries = [...pending.values()];
  pending.clear();
  for (const entry of entries) settlePending(entry);
}

function settlePending(entry: PendingEntry): void {
  clearTimeout(entry.timeoutId);
  try {
    entry.popup?.close();
  } catch {
    // A popup reference may be dead; closing it is best-effort.
  }
}