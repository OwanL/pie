import type { ChatMessage, SessionSummary, ViewState } from '../../shared/protocol';

/**
 * Bound the renderer-only projection without changing authoritative ArchState.
 * The webview uses session summaries only for open tabs, recovery, and names
 * attached to deferred triggers; shipping the complete durable catalog on
 * every token snapshot made large installations pay hundreds of kilobytes of
 * JSON/structured-clone work for unrelated history.
 */
export function compactRendererViewState(viewState: ViewState): ViewState {
  const sessions = rendererSessionCatalog(viewState);
  const transcript = viewState.transcript.map(compactRendererMessage);
  const transcriptChanged = transcript.some((message, index) => message !== viewState.transcript[index]);
  if (sessions === viewState.sessions && !transcriptChanged) return viewState;
  return { ...viewState, sessions, transcript: transcriptChanged ? transcript : viewState.transcript };
}

export function rendererSessionCatalog(viewState: Pick<
  ViewState,
  'sessions' | 'openTabPaths' | 'activeSession' | 'deferredTriggers'
>): SessionSummary[] {
  const requiredPaths = new Set(viewState.openTabPaths);
  if (viewState.activeSession?.path) requiredPaths.add(viewState.activeSession.path);
  for (const trigger of viewState.deferredTriggers) requiredPaths.add(trigger.sessionPath);

  // Preserve the historical recovery fallback when no tabs are open: the UI
  // may reopen the first durable session if host tab persistence is damaged.
  if (requiredPaths.size === 0 && viewState.sessions[0]) {
    requiredPaths.add(viewState.sessions[0].path);
  }
  if (requiredPaths.size >= viewState.sessions.length) return viewState.sessions;
  return viewState.sessions.filter((session) => requiredPaths.has(session.path));
}

function compactRendererMessage(message: ChatMessage): ChatMessage {
  const flatTools = message.toolCalls;
  if (!flatTools?.length || !message.parts?.length) return message;
  const orderedTools = message.parts
    .filter((part): part is Extract<(typeof message.parts)[number], { kind: 'toolCall' }> => part.kind === 'toolCall')
    .map((part) => part.toolCall);
  // `upsertAssistantToolCall` deliberately installs the same canonical object
  // into both collections. Reference equality is a cheap, fail-open proof that
  // the flat compatibility mirror contains no information absent from parts.
  if (orderedTools.length !== flatTools.length
    || orderedTools.some((tool, index) => tool !== flatTools[index])) return message;
  const { toolCalls: _redundantToolCalls, ...compacted } = message;
  return compacted;
}
