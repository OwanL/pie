/** Minimal webview-side logger. The webview cannot import host utilities, so it
 *  keeps its own consistent `[pie:webview:scope]` prefix. */
export type WebviewLogLevel = 'warn' | 'error';

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
}
