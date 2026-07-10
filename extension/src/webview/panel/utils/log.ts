/** Minimal webview-side logger. The webview cannot import host utilities, so it
 *  keeps its own consistent `[pie:webview:scope]` prefix.
 *
 *  H4: in addition to the devtools console, logs are forwarded to the host via
 *  a `log` webview→host message (when a sink is registered). The host routes
 *  them through `appendPieLog` → the pie OutputChannel / pie.log so they are
 *  durable and visible without opening devtools. The sink is injected by
 *  `panel.tsx` (which owns the single `acquireVsCodeApi()` `postMessage`) to
 *  avoid a circular import and a second `acquireVsCodeApi` call (VS Code throws
 *  if it is called more than once). */
import type { WebviewToHostMessage } from '../../../shared/protocol';

export type WebviewLogLevel = 'warn' | 'error';

/** The host-bound postMessage sink (set by panel.tsx at mount). Null until the
 *  webview boots / after dispose; logs still go to the devtools console then. */
let logSink: ((msg: WebviewToHostMessage) => void) | null = null;

/** Register the host-bound postMessage sink so `webviewLog` can forward logs
 *  to the host (H4). Called once by `panel.tsx` (the sole `acquireVsCodeApi`
 *  owner). Passing `null` detaches (e.g. on dispose). */
export function setWebviewLogSink(sink: ((msg: WebviewToHostMessage) => void) | null): void {
  logSink = sink;
}

export function webviewLog(
  level: WebviewLogLevel,
  scope: string,
  message: string,
  data?: unknown,
): void {
  const prefix = `[pie:webview:${scope}] ${message}`;
  if (level === 'error') {
    console.error(prefix, data ?? '');
  } else {
    console.warn(prefix, data ?? '');
  }
  // Forward to the host so the log is durable (pie.log) + visible in the pie
  // OutputChannel without opening devtools. Best-effort: a sink failure (e.g.
  // the host not yet attached) must not throw in the logging path.
  if (logSink) {
    try {
      logSink({ type: 'log', level, scope, message, data });
    } catch {
      // Swallow — logging must never throw.
    }
  }
}
