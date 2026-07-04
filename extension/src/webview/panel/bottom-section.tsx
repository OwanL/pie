/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type {
  ViewState,
  ChatMessage,
  WebviewToHostMessage,
  ThinkingLevel,
} from '../../shared/protocol';
import { ExtensionUIPrompt } from './extension-ui-prompt';
import { Composer } from './ui';
import type { AppHandlers } from './use-app-handlers';

export interface BottomSectionProps {
  hasActiveTabs: boolean;
  needsSessionRecovery: boolean;
  pendingExtensionUIRequest: ViewState['pendingExtensionUIRequest'];
  activeSessionPath: string | null;
  isAskUserHandledInline: boolean;
  postMessage: (msg: WebviewToHostMessage) => void;
  busy: ViewState['busy'];
  /** Brief E: optimistic in-flight interrupt flag (webview-local). Drives the
   *  "Stopping…" affordance so the click reflects within one frame. */
  interrupting: boolean;
  activeSession: ViewState['activeSession'];
  modelSettings: ViewState['modelSettings'];
  availableModels: ViewState['availableModels'];
  availableExtensions: ViewState['availableExtensions'];
  contextUsage: ViewState['contextUsage'];
  prefs: ViewState['prefs'];
  pruningSettings: ViewState['pruningSettings'];
  pruningCatalog: ViewState['pruningCatalog'];
  pruningResult: ViewState['pruningResult'];
  proxySettings: ViewState['proxySettings'];
  systemPrompts: ViewState['systemPrompts'];
  transcript: ChatMessage[];
  transcriptWindow: ViewState['transcriptWindow'];
  draftRestore: { text: string; nonce: number } | null;
  draftText: string;
  /** Brief H: AppBody registers the composer's `sendAsRetry` here so the
   *  NoticeBanner's Retry button (AppBody-level) can re-send the live draft. */
  sendRetryDraftRef?: { current: ((disablePruning?: boolean) => void) | null };
  pendingComposerInputs: ViewState['pendingComposerInputs'];
  activeRunSummary: ViewState['activeRunSummary'];
  tokenRateBySession: ViewState['tokenRateBySession'];
  handlers: Pick<AppHandlers, 'handleSend' | 'handleRetrySend' | 'handleInterrupt' | 'handleOpenFilePicker' | 'handleAddComposerInput' | 'handleRemoveComposerInput' | 'handleModelChange' | 'handleSetPrefs' | 'handleSetPruningSettings' | 'handleSetProxySettings' | 'handleMarkComplete'>;
}

export const BottomSection = memo(function BottomSection({
  hasActiveTabs,
  needsSessionRecovery,
  pendingExtensionUIRequest,
  activeSessionPath,
  isAskUserHandledInline,
  postMessage,
  busy,
  interrupting,
  activeSession,
  modelSettings,
  availableModels,
  availableExtensions,
  contextUsage,
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  proxySettings,
  systemPrompts,
  transcript,
  transcriptWindow,
  draftRestore,
  draftText,
  sendRetryDraftRef,
  pendingComposerInputs,
  activeRunSummary,
  tokenRateBySession,
  handlers,
}: BottomSectionProps) {
  if (!hasActiveTabs || needsSessionRecovery) return null;

  return (
    <>
      {pendingExtensionUIRequest && activeSessionPath && !isAskUserHandledInline && (
        <ExtensionUIPrompt sessionPath={activeSessionPath} request={pendingExtensionUIRequest} postMessage={postMessage} />
      )}
      <Composer
        sessionPath={activeSessionPath}
        draftText={draftText}
        postMessage={postMessage}
        busy={busy}
        interrupting={interrupting}
        activeModelId={activeSession?.modelId}
        activeThinkingLevel={activeSession?.thinkingLevel}
        modelSettings={modelSettings}
        availableModels={availableModels}
        availableExtensions={availableExtensions}
        contextUsage={contextUsage}
        prefs={prefs}
        pruningSettings={pruningSettings}
        pruningCatalog={pruningCatalog}
        pruningResult={pruningResult}
        proxySettings={proxySettings}
        systemPrompts={systemPrompts}
        transcript={transcript}
        transcriptWindow={transcriptWindow}
        draftRestore={draftRestore}
        sendRetryDraftRef={sendRetryDraftRef}
        pendingComposerInputs={pendingComposerInputs}
        activeRunSummary={activeRunSummary}
        tokenRateBySession={tokenRateBySession}
        focusTrigger={activeSession?.path}
        onSend={handlers.handleSend}
        onRetrySend={handlers.handleRetrySend}
        onInterrupt={handlers.handleInterrupt}
        onOpenFilePicker={handlers.handleOpenFilePicker}
        onAddInput={handlers.handleAddComposerInput}
        onRemoveInput={handlers.handleRemoveComposerInput}
        onModelChange={handlers.handleModelChange}
        onSetPrefs={handlers.handleSetPrefs}
        onSetPruningSettings={handlers.handleSetPruningSettings}
        onSetProxySettings={handlers.handleSetProxySettings}
        onMarkComplete={handlers.handleMarkComplete}
      />
    </>
  );
});
