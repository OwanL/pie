/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo, useCallback } from 'preact/hooks';
import type {
  ViewState,
  WebviewToHostMessage,
  ChatMessageToolCallPart,
  ChatMessage,
} from '../../shared/protocol';
import { resolvePanelSurface, resolveLoadingStatus } from './panel-state';
import { isTranscriptHydrating } from './transcript/state';
import { resolveComposerModelState } from './composer/model-state';
import { isPendingTabPath } from '../../shared/tab-behavior';

export function useAppBodyDerivedState(
  viewState: ViewState,
  postMessage: (msg: WebviewToHostMessage) => void,
) {
  const {
    sessions,
    openTabPaths,
    backendReady,
    notice,
    activeSession,
    modelSettings,
    availableModels,
    pendingExtensionUIRequestsBySession,
    pendingExtensionUIRequest,
    transcript,
    systemPrompts,
    transcriptLoaded,
    deferredTriggers,
  } = viewState;

  const panelSurface = resolvePanelSurface({ backendReady, notice, openTabPaths });
  const hasActiveTabs = panelSurface === 'session';
  const showSessionChrome = panelSurface !== 'loading';
  const activeSessionPath = activeSession?.path ?? null;
  const recoverySessionPath = openTabPaths.find((p) => !isPendingTabPath(p)) ?? sessions[0]?.path ?? null;
  const needsSessionRecovery = hasActiveTabs && activeSession === null && recoverySessionPath !== null;
  const transcriptHydrating = isTranscriptHydrating({ transcript, systemPrompts, transcriptLoaded });
  const loadingStatus = resolveLoadingStatus({
    backendReady,
    hasOpenTabs: hasActiveTabs,
    transcriptHydrating,
    needsSessionRecovery,
  });

  // Extract primitive values for memo deps to avoid re-computing on every host update
  // when objects like availableModels[] and modelSettings{} get new references.
  const activeModelId = activeSession?.modelId;
  const activeThinkingLevel = activeSession?.thinkingLevel;
  const settingsDefaultModel = modelSettings?.defaultModel;
  const settingsDefaultThinkingLevel = modelSettings?.defaultThinkingLevel;
  const modelCount = availableModels.length;

  const {
    selectedModel: pendingAssistantModelId,
    selectedLevel: pendingAssistantThinkingLevel,
  } = useMemo(() => resolveComposerModelState({
    activeModelId,
    activeThinkingLevel,
    modelSettings,
    availableModels,
  }), [activeModelId, activeThinkingLevel, settingsDefaultModel, settingsDefaultThinkingLevel, modelCount]);

  // Only suppress the bottom-bar prompt when the request that would be shown
  // there is itself a `select` that is rendered inline in the transcript. With
  // toolCallId linking, only ask_user requests owned by a running tool call are
  // handled inline; legacy or non-tool select prompts stay in the bottom bar.
  //
  // Memoized: the host posts a fresh `transcript` array reference on every
  // snapshot (~7/sec while streaming), so an un-memoized `transcript.some()`
  // would walk the whole transcript on every render even when nothing relevant
  // changed. The deps are the three values this actually depends on.
  const isAskUserHandledInline = useMemo(
    () =>
      !!activeSessionPath &&
      pendingExtensionUIRequest?.method === 'select' &&
      !!pendingExtensionUIRequest?.toolCallId &&
      transcript.some((msg) =>
        msg.parts?.some((p): p is ChatMessageToolCallPart =>
          p.kind === 'toolCall' && p.toolCall.name === 'ask_user' && p.toolCall.status === 'running'
        ),
      ),
    [activeSessionPath, pendingExtensionUIRequest, transcript],
  );

  const askUserContextValue = useMemo(() => ({
    sessionPath: activeSessionPath,
    postMessage,
    pendingRequests: activeSessionPath
      ? (pendingExtensionUIRequestsBySession[activeSessionPath] ?? {})
      : {},
  }), [activeSessionPath, postMessage, pendingExtensionUIRequestsBySession]);

  // Stable signature of the active deferred-trigger set so the derived
  // `deferredSessionPaths` array + `activeSessionHasDeferredTriggers` boolean
  // keep stable references across snapshots whose `deferredTriggers` content is
  // unchanged (the host re-serialises the array on every post, which would
  // otherwise defeat the SessionTabs / SessionTab memo barriers). Keyed on a
  // compact id+session string so a note/registeredAt change (e.g. a re-arm)
  // doesn't churn the set unless membership changes.
  const deferredSig = useMemo(
    () => deferredTriggers.map((t) => `${t.sessionPath}:${t.id}`).sort().join('|'),
    [deferredTriggers],
  );
  const deferredSessionPaths = useMemo(
    () => Array.from(new Set(deferredTriggers.map((t) => t.sessionPath))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredSig],
  );
  const activeSessionHasDeferredTriggers = useMemo(
    () => deferredTriggers.some((t) => t.sessionPath === activeSessionPath),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredSig, activeSessionPath],
  );

  // Stable notice context value: `dismiss` is fixed for the AppBody lifetime
  // so consumers only re-render when `notice` actually changes, mirroring the
  // memoized `askUserContextValue` above.
  const dismiss = useCallback(() => postMessage({ type: 'dismissNotice' }), []);
  const noticeValue = useMemo(() => ({ notice, dismiss }), [notice, dismiss]);

  return {
    panelSurface,
    hasActiveTabs,
    showSessionChrome,
    activeSessionPath,
    recoverySessionPath,
    needsSessionRecovery,
    pendingAssistantModelId,
    pendingAssistantThinkingLevel,
    isAskUserHandledInline,
    askUserContextValue,
    noticeValue,
    transcriptHydrating,
    loadingStatus,
    deferredTriggers,
    deferredSessionPaths,
    activeSessionHasDeferredTriggers,
  };
}
