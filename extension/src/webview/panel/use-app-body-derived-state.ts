/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo, useCallback } from 'preact/hooks';
import type {
  ViewState,
  WebviewToHostMessage,
} from '../../shared/protocol';
import { resolvePanelSurface, resolveLoadingStatus } from './panel-state';
import { isTranscriptHydrating } from './transcript/state';
import { resolveComposerModelState } from './composer/model-state';
import { isPendingTabPath } from '../../shared/tab-behavior';

export function useAppBodyDerivedState(
  viewState: ViewState,
  postMessage: (msg: WebviewToHostMessage) => void,
  registerInlineRequest: (requestId: string) => void,
  unregisterInlineRequest: (requestId: string) => void,
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

  const askUserContextValue = useMemo(() => ({
    sessionPath: activeSessionPath,
    postMessage,
    pendingRequests: activeSessionPath
      ? (pendingExtensionUIRequestsBySession[activeSessionPath] ?? {})
      : {},
    registerInlineRequest,
    unregisterInlineRequest,
  }), [
    activeSessionPath,
    postMessage,
    pendingExtensionUIRequestsBySession,
    registerInlineRequest,
    unregisterInlineRequest,
  ]);

  // Stable signatures of the active deferred-trigger set so the derived
  // session-path arrays and active-session boolean keep stable references
  // across snapshots whose `deferredTriggers` content is unchanged (the host
  // re-serialises the array on every post, which would otherwise defeat the
  // SessionTabs / SessionTab memo barriers).
  const deferredSig = useMemo(
    () => deferredTriggers.map((t) => `${t.sessionPath}:${t.id}`).sort().join('|'),
    [deferredTriggers],
  );
  const deferredTimerSig = useMemo(
    () => deferredTriggers
      .filter((t) => t.triggers.some((trigger) => trigger.kind === 'timer'))
      .map((t) => `${t.sessionPath}:${t.id}`)
      .sort()
      .join('|'),
    [deferredTriggers],
  );
  const deferredSessionPaths = useMemo(
    () => Array.from(new Set(deferredTriggers.map((t) => t.sessionPath))),
    [deferredSig],
  );
  const deferredTimerSessionPaths = useMemo(
    () => Array.from(new Set(
      deferredTriggers
        .filter((t) => t.triggers.some((trigger) => trigger.kind === 'timer'))
        .map((t) => t.sessionPath),
    )),
    [deferredTimerSig],
  );
  const activeSessionHasDeferredTriggers = useMemo(
    () => deferredTriggers.some((t) => t.sessionPath === activeSessionPath),
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
    askUserContextValue,
    noticeValue,
    transcriptHydrating,
    loadingStatus,
    deferredTriggers,
    deferredSessionPaths,
    deferredTimerSessionPaths,
    activeSessionHasDeferredTriggers,
  };
}
