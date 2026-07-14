/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext } from 'preact';
import type { ExtensionUIRequestPayload, WebviewToHostMessage } from '../../../shared/protocol';

/**
 * Context for resolving ask_user prompts inline in the transcript.
 *
 * Provides a registry of all pending extension UI requests for the active
 * session, keyed by request ID. Components subscribe by matching
 * `subagentCallId` to find the request that belongs to their context
 * (main agent or a specific subagent tool call).
 */
export interface AskUserContextValue {
  /** The active session path (for addressing responses). */
  sessionPath: string | null;
  /** Posts a message to the extension host. */
  postMessage: (msg: WebviewToHostMessage) => void;
  /** All pending requests for the active session, keyed by request ID. */
  pendingRequests: Record<string, ExtensionUIRequestPayload>;
  /** Register/unregister an inline prompt that is actually mounted in the DOM.
   *  The fixed composer-adjacent fallback only hides while its exact request
   *  has a live inline surface. */
  registerInlineRequest: (requestId: string) => void;
  unregisterInlineRequest: (requestId: string) => void;
}

export const AskUserContext = createContext<AskUserContextValue>({
  sessionPath: null,
  postMessage: () => {},
  pendingRequests: {},
  registerInlineRequest: () => {},
  unregisterInlineRequest: () => {},
});

function isInteractiveRequest(request: ExtensionUIRequestPayload): boolean {
  return request.method === 'select' || request.method === 'confirm' || request.method === 'input';
}

/**
 * Select the request that needs the fixed composer-adjacent fallback.
 * Requests without an inline owner retain priority. When every request has an
 * inline owner, choose the oldest request whose exact inline prompt is not
 * mounted; this keeps concurrent collapsed/virtualized questions actionable
 * even if an earlier sibling is already visible inline.
 */
export function selectFixedPromptRequest(
  pendingRequests: Record<string, ExtensionUIRequestPayload>,
  inlinePromptRequestCounts: Record<string, number>,
): ExtensionUIRequestPayload | null {
  const requests = Object.values(pendingRequests).filter(isInteractiveRequest);
  return requests.find((request) => !request.subagentCallId && !request.toolCallId)
    ?? requests.find((request) => (inlinePromptRequestCounts[request.id] ?? 0) <= 0)
    ?? null;
}

/**
 * Find the pending ask_user request that matches a given caller id.
 *
 * - When `callerId` is undefined (legacy main agent), returns the first
 *   request (`select`, `confirm`, or `input`) that also has no `subagentCallId`
 *   or `toolCallId`.
 * - When `callerId` is provided, returns the request whose `toolCallId` or
 *   `subagentCallId` matches it. This lets a running `ask_user` tool card
 *   bind to its own prompt even when several are running in parallel.
 */
export function findMatchingRequest(
  pendingRequests: Record<string, ExtensionUIRequestPayload>,
  callerId?: string,
): ExtensionUIRequestPayload | null {
  for (const request of Object.values(pendingRequests)) {
    if (!isInteractiveRequest(request)) continue;
    if (callerId === undefined) {
      if (request.toolCallId === undefined && request.subagentCallId === undefined) return request;
    } else {
      if (request.toolCallId === callerId || request.subagentCallId === callerId) return request;
    }
  }
  return null;
}