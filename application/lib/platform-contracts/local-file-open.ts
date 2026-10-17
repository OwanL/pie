/**
 * Local file open uses one host-owned report listener, separate from Pie's
 * HTTP/WS origin. Each open mints an expiring capability for a canonical
 * folder so sibling scripts and relative assets load. Browser URLs use the
 * validated socket Host (normalized to `127.0.0.1` for a local `[::1]`) and
 * browser listener LAN policy; VS Code uses loopback. Surface policy:
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
  /** Host-only socket policy, never accepted from renderer JSON. */
  browserNetwork?: { hostname: string; allowLan: boolean };
};