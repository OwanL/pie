/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext } from 'preact';
import { useContext } from 'preact/hooks';

/** Context providing the current global notice (error text) + a dismiss callback
 * to deeply nested components. The dismiss callback dispatches `dismissNotice`
 * to the host so the notice is cleared in ArchState (MVI: the webview doesn't
 * own the notice — it projects from host state + sends an Intent to clear it). */
export interface NoticeContextValue {
  notice: string | null;
  /** Session owning the notice, or null for a global notice. */
  sessionPath?: string | null;
  dismiss: (() => void) | null;
}

export const NoticeContext = createContext<NoticeContextValue>({ notice: null, sessionPath: null, dismiss: null });

export function useNoticeContext(): NoticeContextValue {
  return useContext(NoticeContext);
}

export function useNotice(): string | null {
  return useNoticeContext().notice;
}

/** Returns the host-bound dismiss callback for the global notice, or null if
 * no notice is active. Use this instead of local `dismissed` state when the
 * error detail originates from the notice (not a per-message errorDetail). */
export function useDismissNotice(): (() => void) | null {
  return useNoticeContext().dismiss;
}
