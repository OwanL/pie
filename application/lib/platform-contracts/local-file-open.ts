/**
 * One-shot local file open for browsers: the host prepares an ephemeral,
 * loopback-only HTTP origin that serves one requested file plus its
 * canonical parent directory (so sibling scripts and relative assets load),
 * verifies the origin is reachable, and then hands the verified URL back.
 *
 * This is deliberately NOT Pie's shared browser-server listener: each
 * prepared file gets its own distinct host listener and therefore its own
 * distinct origin, isolated from the webview origin. Surface policy:
 * a desktop host may open the URL in the OS default browser
 * (`openIn:'external'`); browser renderers open the URL as their own popup
 * (`openIn:'popup'`) and the host must never shell out on their behalf.
 */

/** How the verified URL is opened after preparation. */
export type LocalFileOpenSurface = 'external' | 'popup';

export interface LocalFileOpenRequest {
  /** Exact path resolved by the renderer for the originating session. */
  path: string;
  /** Original markdown reference, retained to distinguish bare names. */
  reference?: string;
  /** Session working directory captured when the renderer handled the click. */
  workingDirectory?: string;
}

/** Full adapter request: resolution inputs plus the requested open surface. */
export type LocalFileOpenCommand = LocalFileOpenRequest & {
  openIn: LocalFileOpenSurface;
};