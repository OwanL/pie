/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { memo } from 'preact/compat';
import { useCallback, useMemo, useRef } from 'preact/hooks';

import type {
  ActiveRunSummary,
  ChatMessage,
  ChatPrefs,
  ComposerInput,
  ComposerInputDraft,
  ContextWindowUsage,
  ExtensionInfo,
  LastCompactionSummary,
  ModelInfo,
  ModelSettings,
  PruningCatalog,
  PruningResult,
  PruningSettings,
  ProviderGateStats,
  RetryStatus,
  SessionUsageSnapshot,
  SystemPromptEntry,
  ThinkingLevel,
  ToolResultPruningSettings,
  TranscriptWindow,
  WebviewToHostMessage,
} from '../../shared/protocol';
import type { TokenRateIndicatorState } from '../../shared/token-rate';
import { describeComposerInputSummary } from './composer/inputs';
import { ComposerAttachments } from './composer/attachments';
import { ComposerToolbar } from './composer/toolbar';
import { getComposerRunControls } from './session-tabs/run-state';
import { cx } from './utils/cx';
import { ComposerActions } from './composer/actions';
import {
  useComposerIndicators,
  useComposerInput,
  useComposerDragDrop,
  useComposerPaste,
  useComposerHeightSync,
} from './composer/hooks';
export { SessionTabs } from './session-tabs';
export { AggregateStatsStrip } from './aggregate-stats-strip';

interface ComposerProps {
  busy: boolean;
  /** Brief E: optimistic one-frame "stopping…" mirror of an in-flight
   *  interrupt (the host clears `busy` only after the abort round-trip). */
  interrupting?: boolean;
  /** Live auto-retry status for the active session, or null when no retry is
   *  in flight. Surfaced as a "Retrying N of M…" chip with a Cancel button
   *  (Cancel reuses `onInterrupt` — `session.abort()` aborts the retry sleep
   *  via `abortRetry()`, emitting `auto_retry_end` "Retry cancelled"). */
  retryStatus: RetryStatus | null;
  sessionPath: string | null;
  draftText: string;
  draftRestore?: { text: string; nonce: number } | null;
  activeModelId?: string;
  activeProvider?: string;
  activeThinkingLevel?: ThinkingLevel;
  privacyMode?: boolean;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  availableModelsStatus?: 'provisional' | 'loading' | 'authoritative';
  availableExtensions: ExtensionInfo[];
  contextUsage: ContextWindowUsage | null;
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  toolResultPruningSettings: ToolResultPruningSettings;
  providerGateStats: ProviderGateStats;
  systemPrompts: SystemPromptEntry[];
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  sessionUsage?: SessionUsageSnapshot | null;
  pendingComposerInputs: ComposerInput[];
  activeRunSummary?: ActiveRunSummary | null;
  tokenRateBySession: Record<string, TokenRateIndicatorState>;
  /** True while the active session runs a history-compaction LLM call. */
  compacting: boolean;
  /** Most recent completed compaction for the active session (transient chip). */
  lastCompaction: LastCompactionSummary | null;
  focusTrigger?: string;
  postMessage: (msg: WebviewToHostMessage) => void;
  onSend: (text: string) => void;
  /** Brief H: re-send the draft as a `retrySend` (the host disables pruning
   *  atomically first when `disablePruning` is set — "retry without pruning").
   *  Invoked by the NoticeBanner's Retry button via `sendRetryDraftRef`. */
  onRetrySend: (text: string, disablePruning?: boolean) => void;
  onInterrupt: () => void;
  onAddInput: (input: ComposerInputDraft) => void;
  onRemoveInput: (inputId: string) => void;
  onModelChange: (model: string, provider: string | undefined, thinkingLevel: ThinkingLevel) => void;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetPrivacyMode?: (enabled: boolean) => void;
  /** Apply the complete disabled-entry set for the active session's system
   *  prompts. The backend re-emits `session.opened` to update the displayed
   *  entries + toggle state. */
  onSetSystemPromptToggles: (disabledEntries: string[]) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  onSetToolResultPruningSettings: (settings: Partial<ToolResultPruningSettings>) => void;
  /** Brief H: AppBody registers the composer's `sendAsRetry` here so the
   *  NoticeBanner's Retry button (rendered at the AppBody level, outside the
   *  composer) can re-send the LIVE composer draft. A ref (not state) — no
   *  re-render, just a stable callback bridge from the app-level notice to the
   *  composer-level draft (which the NoticeBanner cannot otherwise reach). */
  sendRetryDraftRef?: { current: ((disablePruning?: boolean) => void) | null };
}

function ComposerView({
  busy,
  interrupting,
  retryStatus,
  sessionPath,
  draftText,
  draftRestore,
  activeModelId,
  activeProvider,
  activeThinkingLevel,
  privacyMode = false,
  modelSettings,
  availableModels,
  availableModelsStatus = 'authoritative',
  availableExtensions,
  contextUsage,
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  toolResultPruningSettings,
  providerGateStats,
  systemPrompts,
  transcript,
  transcriptWindow,
  sessionUsage,
  pendingComposerInputs,
  activeRunSummary,
  tokenRateBySession,
  compacting,
  lastCompaction,
  focusTrigger,
  postMessage,
  onSend,
  onRetrySend,
  onInterrupt,
  onAddInput,
  onRemoveInput,
  onModelChange,
  onSetPrefs,
  onSetPrivacyMode,
  onSetSystemPromptToggles,
  onSetPruningSettings,
  onSetToolResultPruningSettings,
  sendRetryDraftRef,
}: ComposerProps) {
  const composerAreaRef = useRef<HTMLDivElement>(null);

  const {
    selectedModel,
    selectedProvider,
    selectedLevel,
    supportsReasoning,
    supportsImageInputs,
    contextBreakdown,
    contextIndicator,
    sessionCostIndicator,
    tokenRateIndicator,
  } = useComposerIndicators({
    activeModelId,
    activeProvider,
    activeThinkingLevel,
    modelSettings,
    availableModels,
    contextUsage,
    systemPrompts,
    transcript,
    transcriptWindow,
    sessionUsage,
    pruningResult,
    busy,
    sessionPath,
    tokenRateBySession,
  });

  const {
    text,
    textareaRef,
    attachmentError,
    sendCurrentText,
    sendAsRetry,
    handleKeyDown,
    handleInput,
    handlePaste,
    handleBeforeInput,
    applyComposerTransfer,
    submitting,
  } = useComposerInput({
    busy,
    sendBlocked: interrupting,
    onSend,
    onRetrySend,
    pendingComposerInputsLength: pendingComposerInputs.length,
    initialRows: prefs.composerInitialRows,
    sessionPath,
    draftText,
    postMessage,
    draftRestore,
    focusTrigger,
    onAddInput,
    supportsImageInputs,
  });

  const {
    isDragActive,
    composerShellRef,
    handleDragOver,
    handleDragLeave,
    handleDrop,
  } = useComposerDragDrop({ applyComposerTransfer });

  // Brief H: keep `sendRetryDraftRef` pointing at the LATEST `sendAsRetry`
  //  (which closes over the live draft `text`). Writing the ref during render
  //  (rather than in a `useEffect`) guarantees the AppBody-level NoticeBanner's
  //  Retry click always re-sends the up-to-date draft — an effect would lag one
  //  render behind a keystroke under some test harnesses, sending stale text.
  //  This is the standard "latest-callback" ref escape hatch (the `useEvent`
  //  pattern): a ref write is an idempotent side effect that cannot trigger a
  //  re-render, so it is safe during render. The closure no-ops (empty-text
  //  guard) once the composer unmounts, so a stale entry is harmless.
  if (sendRetryDraftRef) sendRetryDraftRef.current = sendAsRetry;

  useComposerPaste({ applyComposerTransfer, textareaRef });
  useComposerHeightSync(composerAreaRef);

  // Memoize the indicator prop objects passed to `ComposerToolbar` so they keep
  // a stable reference across renders. The indicator values themselves
  // (`contextIndicator`) is already memoized inside
  // `useComposerIndicators`, and `availableModels` is now reference-stabilised
  // upstream (`use-host-sync`), so `memo(ComposerView)` actually holds and
  // these `useMemo`s only recompute when the underlying indicator changes —
  // without them, fresh inline object literals would be allocated every render.
  const contextIndicatorProp = useMemo(
    () => contextIndicator
      ? {
          label: contextIndicator.label,
          ariaLabel: contextIndicator.ariaLabel,
          severity: contextIndicator.severity ?? null,
        }
      : null,
    [contextIndicator],
  );
  const runControls = getComposerRunControls(activeRunSummary ?? null);
  // Steering (FollowUp): any optimistic 'queued' user messages (sent while a
  // turn was running) show a "Clear queued" affordance in the composer actions.
  const hasQueuedMessages = useMemo(
    () => transcript.some((m) => m.role === 'user' && m.status === 'queued'),
    [transcript],
  );
  const onClearQueue = useCallback(() => {
    if (sessionPath) {
      postMessage({ type: 'clearQueue', sessionPath });
    }
  }, [sessionPath, postMessage]);
  const onCompact = useCallback(() => {
    if (sessionPath && !busy) {
      postMessage({ type: 'compact', sessionPath });
    }
  }, [sessionPath, busy, postMessage]);

  const canSend = (text.trim().length > 0 || pendingComposerInputs.length > 0) && !submitting.current;
  const attachmentSummary = useMemo(
    () => describeComposerInputSummary(pendingComposerInputs),
    [pendingComposerInputs],
  );
  const showAttachmentSummary = pendingComposerInputs.length > 1;
  const composerPlaceholder = 'Ask anything…';

  return (
    <div class="composer-area flex shrink-0 flex-col gap-1.5 border-t border-border/50 bg-surface px-3 py-2 pb-2.5" ref={composerAreaRef}>
      <div
        ref={composerShellRef}
        class={cx(
          'composer-shell flex w-full flex-col gap-1.5 rounded-xl border border-transparent bg-input px-2 py-1.5 pb-2 shadow-sm transition-[background,border-color,box-shadow] duration-150',
          'focus-within:border-border-subtle/80 focus-within:shadow-md',
          'forced-colors:border forced-colors:border-[ButtonText] forced-colors:focus-within:outline-1 forced-colors:focus-within:outline-[Highlight]',
          isDragActive && 'border-accent/40 bg-accent/5 shadow-md',
        )}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {retryStatus && (
          <div class="composer-retry-row flex items-center gap-2" role="status" aria-live="polite">
            <span class="composer-retry-label flex items-center gap-1.5">
              <span class="composer-retry-spinner" aria-hidden="true" />
              Retrying {retryStatus.attempt} of {retryStatus.maxAttempts}
            </span>
            {retryStatus.errorMessage && (
              <span class="composer-retry-error" title={retryStatus.errorMessage}>
                {retryStatus.errorMessage}
              </span>
            )}
            <button
              class="action-btn"
              type="button"
              onClick={onInterrupt}
              disabled={interrupting}
              title={interrupting ? 'Cancelling…' : 'Cancel the retry and stop the request'}
              aria-label="Cancel retry"
            >
              {interrupting ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
        )}
        <ComposerAttachments
          pendingComposerInputs={pendingComposerInputs}
          attachmentSummary={attachmentSummary}
          showAttachmentSummary={showAttachmentSummary}
          onRemoveInput={onRemoveInput}
        />
        <textarea
          ref={textareaRef}
          class="composer-input-textarea max-h-[200px] w-full resize-none border-0 bg-transparent p-0 leading-normal text-foreground outline-none placeholder:text-muted"
          rows={prefs.composerInitialRows}
          placeholder={composerPlaceholder}
          value={text}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onBeforeInput={handleBeforeInput}
          onPaste={handlePaste}
          aria-label="Message composer"
        />
        <div class="composer-bottom-bar">
          <ComposerToolbar
            sessionPath={sessionPath}
            busy={busy}
            prefs={prefs}
            pruningSettings={pruningSettings}
            pruningCatalog={pruningCatalog}
            pruningResult={pruningResult}
            toolResultPruningSettings={toolResultPruningSettings}
            providerGateStats={providerGateStats}
            onSetPrefs={onSetPrefs}
            privacyMode={privacyMode}
            onSetPrivacyMode={onSetPrivacyMode}
            onSetSystemPromptToggles={onSetSystemPromptToggles}
            systemPrompts={systemPrompts}
            onSetPruningSettings={onSetPruningSettings}
            onSetToolResultPruningSettings={onSetToolResultPruningSettings}
            availableExtensions={availableExtensions}
            availableModels={availableModels}
            availableModelsStatus={availableModelsStatus}
            selectedModel={selectedModel}
            selectedProvider={selectedProvider}
            selectedLevel={selectedLevel}
            supportsReasoning={supportsReasoning}
            contextIndicator={contextIndicatorProp}
            contextBreakdown={contextBreakdown}
            sessionCostIndicator={sessionCostIndicator}
            tokenRateIndicator={tokenRateIndicator}
            runStatus={runControls.status}
            compacting={compacting}
            lastCompaction={lastCompaction}
            onModelChange={onModelChange}
            onCompact={onCompact}
          />
          <ComposerActions
            busy={busy}
            interrupting={interrupting}
            hasQueuedMessages={hasQueuedMessages}
            onInterrupt={onInterrupt}
            onClearQueue={onClearQueue}
            sendCurrentText={sendCurrentText}
            canSend={canSend}
          />
        </div>
      </div>

      {attachmentError && (
        <div class="composer-hint composer-hint-error" role="status">{attachmentError}</div>
      )}
    </div>
  );
}

export const Composer = memo(ComposerView);
