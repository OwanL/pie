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
    noticeSessionPath,
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

  // Extract primitive settings values while retaining the reference-stabilized
  // model catalog as a dependency. Keying only on its length made a same-size
  // catalog replacement leave model capabilities/reasoning choices stale.
  const activeModelId = activeSession?.modelId;
  const activeProvider = activeSession?.provider;
  const activeThinkingLevel = activeSession?.thinkingLevel;
  const settingsDefaultModel = modelSettings?.defaultModel;
  const settingsDefaultProvider = modelSettings?.defaultProvider;
  const settingsDefaultThinkingLevel = modelSettings?.defaultThinkingLevel;

  const {
    selectedModel: pendingAssistantModelId,
    selectedLevel: pendingAssistantThinkingLevel,
  } = useMemo(() => resolveComposerModelState({
    activeModelId,
    activeProvider,
    activeThinkingLevel,
    modelSettings,
    availableModels,
  }), [activeModelId, activeProvider, activeThinkingLevel, settingsDefaultModel, settingsDefaultProvider, settingsDefaultThinkingLevel, availableModels]);

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
  // Stable notice context value: `dismiss` is fixed for the AppBody lifetime
  // so consumers only re-render when `notice` actually changes, mirroring the
  // memoized `askUserContextValue` above.
  const dismiss = useCallback(() => postMessage({ type: 'dismissNotice' }), []);
  const noticeValue = useMemo(() => ({ notice, sessionPath: noticeSessionPath ?? null, dismiss }), [notice, noticeSessionPath, dismiss]);

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
  };
}
