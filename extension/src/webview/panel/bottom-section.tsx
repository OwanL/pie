/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import type {
  ViewState,
  ChatMessage,
  WebviewToHostMessage,
  ProviderGateStats,
} from '../../shared/protocol';
import { ExtensionUIPrompt } from './extension-ui-prompt';
import { Composer } from './ui';
import type { AppHandlers } from './use-app-handlers';

export interface BottomSectionProps {
  hasActiveTabs: boolean;
  needsSessionRecovery: boolean;
  pendingExtensionUIRequest: ViewState['pendingExtensionUIRequest'];
  activeSessionPath: string | null;
  postMessage: (msg: WebviewToHostMessage) => void;
  busy: ViewState['busy'];
  capabilities?: ViewState['sessionCapabilitiesBySession'][string];
  retryStatus: ViewState['retryStatus'];
  /** Optimistic in-flight interrupt flag (webview-local). Drives the
   *  "Stopping…" affordance so the click reflects within one frame. */
  interrupting: boolean;
  /** False while the browser renderer has no completed host handshake. */
  commandsAvailable?: boolean;
  activeSession: ViewState['activeSession'];
  privacyMode?: boolean;
  modelSettings: ViewState['modelSettings'];
  availableModels: ViewState['availableModels'];
  availableModelsStatus: ViewState['availableModelsStatus'];
  availableExtensions: ViewState['availableExtensions'];
  contextUsage: ViewState['contextUsage'];
  initialContextEstimate: ViewState['initialContextEstimate'];
  prefs: ViewState['prefs'];
  mcpServers: ViewState['mcpServers'];
  mcpServersStatus?: ViewState['mcpServersStatus'];
  mcpPendingApply: ViewState['mcpPendingApply'];
  mcpSessionServers: ViewState['mcpSessionServers'];
  mcpSessionPendingApply: ViewState['mcpSessionPendingApply'];
  pruningSettings: ViewState['pruningSettings'];
  pruningCatalog: ViewState['pruningCatalog'];
  pruningResult: ViewState['pruningResult'];
  toolResultPruningSettings: ViewState['toolResultPruningSettings'];
  sessionTitlesSettings: ViewState['sessionTitlesSettings'];
  providerGateStats: ProviderGateStats;
  systemPrompts: ViewState['systemPrompts'];
  transcript: ChatMessage[];
  transcriptWindow: ViewState['transcriptWindow'];
  sessionUsage: ViewState['sessionUsage'];
  draftRestore: { text: string; nonce: number } | null;
  draftText: string;
  /** AppBody registers the composer's `sendAsRetry` here so the
   *  NoticeBanner's Retry button (AppBody-level) can re-send the live draft. */
  sendRetryDraftRef?: { current: ((disablePruning?: boolean) => void) | null };
  pendingComposerInputs: ViewState['pendingComposerInputs'];
  activeRunSummary: ViewState['activeRunSummary'];
  tokenRateBySession: ViewState['tokenRateBySession'];
  workingTimeBySession: ViewState['workingTimeBySession'];
  /** True while the active session runs a history-compaction LLM call. */
  compacting: boolean;
  /** Most recent completed compaction for the active session (transient chip). */
  lastCompaction: ViewState['lastCompactionBySession'][string];
  handlers: Pick<AppHandlers, 'handleSend' | 'handleRetrySend' | 'handleInterrupt' | 'handleAddComposerInput' | 'handleRemoveComposerInput' | 'handleModelChange' | 'handleSetPrefs' | 'handleMcpListRequested' | 'handleMcpSetServerEnabled' | 'handleMcpSetServerEnabledForSession' | 'handleSetPrivacyMode' | 'handleSetSystemPromptToggles' | 'handleSetPruningSettings' | 'handleSetToolResultPruningSettings' | 'handleSetSessionTitlesSettings'>;
}

export const BottomSection = memo(function BottomSection({
  hasActiveTabs,
  needsSessionRecovery,
  pendingExtensionUIRequest,
  activeSessionPath,
  postMessage,
  busy,
  capabilities,
  retryStatus,
  interrupting,
  commandsAvailable = true,
  activeSession,
  privacyMode = false,
  modelSettings,
  availableModels,
  availableModelsStatus,
  availableExtensions,
  contextUsage,
  initialContextEstimate,
  prefs,
  mcpServers,
  mcpServersStatus,
  mcpPendingApply,
  mcpSessionServers,
  mcpSessionPendingApply,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  toolResultPruningSettings,
  sessionTitlesSettings,
  providerGateStats,
  systemPrompts,
  transcript,
  transcriptWindow,
  sessionUsage,
  draftRestore,
  draftText,
  sendRetryDraftRef,
  pendingComposerInputs,
  activeRunSummary,
  tokenRateBySession,
  workingTimeBySession,
  compacting,
  lastCompaction,
  handlers,
}: BottomSectionProps) {
  if (!hasActiveTabs || needsSessionRecovery) return null;

  return (
    <>
      {pendingExtensionUIRequest && activeSessionPath && (
        <ExtensionUIPrompt
          sessionPath={activeSessionPath}
          request={pendingExtensionUIRequest}
          postMessage={postMessage}
          sourceLabel={pendingExtensionUIRequest.subagentCallId ? 'Subagent' : undefined}
        />
      )}
      <Composer
        sessionPath={activeSessionPath}
        draftText={draftText}
        postMessage={postMessage}
        busy={busy}
        capabilities={capabilities}
        retryStatus={retryStatus}
        interrupting={interrupting}
        commandsAvailable={commandsAvailable}
        activeModelId={activeSession?.modelId}
        activeProvider={activeSession?.provider}
        activeThinkingLevel={activeSession?.thinkingLevel}
        privacyMode={privacyMode}
        modelSettings={modelSettings}
        availableModels={availableModels}
        availableModelsStatus={availableModelsStatus}
        availableExtensions={availableExtensions}
        contextUsage={contextUsage}
        initialContextEstimate={initialContextEstimate}
        prefs={prefs}
        pruningSettings={pruningSettings}
        pruningCatalog={pruningCatalog}
        pruningResult={pruningResult}
        toolResultPruningSettings={toolResultPruningSettings}
        sessionTitlesSettings={sessionTitlesSettings}
        providerGateStats={providerGateStats}
        systemPrompts={systemPrompts}
        transcript={transcript}
        transcriptWindow={transcriptWindow}
        sessionUsage={sessionUsage}
        draftRestore={draftRestore}
        sendRetryDraftRef={sendRetryDraftRef}
        pendingComposerInputs={pendingComposerInputs}
        activeRunSummary={activeRunSummary}
        tokenRateBySession={tokenRateBySession}
        workingTimeBySession={workingTimeBySession}
        compacting={compacting}
        lastCompaction={lastCompaction}
        focusTrigger={activeSession?.path}
        onSend={handlers.handleSend}
        onRetrySend={handlers.handleRetrySend}
        onInterrupt={handlers.handleInterrupt}
        onAddInput={handlers.handleAddComposerInput}
        onRemoveInput={handlers.handleRemoveComposerInput}
        onModelChange={handlers.handleModelChange}
        onSetPrefs={handlers.handleSetPrefs}
        mcpServers={mcpServers}
        mcpServersStatus={mcpServersStatus}
        mcpPendingApply={mcpPendingApply}
        mcpSessionServers={mcpSessionServers}
        mcpSessionPendingApply={mcpSessionPendingApply}
        onMcpListRequested={handlers.handleMcpListRequested}
        onMcpSetServerEnabled={handlers.handleMcpSetServerEnabled}
        onMcpSetServerEnabledForSession={handlers.handleMcpSetServerEnabledForSession}
        onSetPrivacyMode={handlers.handleSetPrivacyMode}
        onSetSystemPromptToggles={handlers.handleSetSystemPromptToggles}
        onSetPruningSettings={handlers.handleSetPruningSettings}
        onSetToolResultPruningSettings={handlers.handleSetToolResultPruningSettings}
        onSetSessionTitlesSettings={handlers.handleSetSessionTitlesSettings}
      />
    </>
  );
});
