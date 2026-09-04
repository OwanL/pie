/**
 * Top-level reducer: `(state, event) → {state, effects}`.
 *
 * The reducer is **pure**: no I/O, no globals, no mutation of input.
 * Effects are queued descriptively; the `EffectRunner` executes them and
 * dispatches result events back.
 *
 * Transcript mutations use Immer's `produce` so that mutation-style helpers
 * (appendAssistantTextPart, upsertAssistantToolCall, etc.) can operate on
 * the draft directly. Simple field updates continue using spread-operator
 * patterns.
 *
 * **State-shape rule (binding):** keyed collections in `ArchState` MUST use
 * `Record<string, T>` — never `Map`/`Set`. RTK + Immer reject mutating those
 * built-ins without an explicit `enableMapSet()` opt-in; treat that opt-in as
 * a deliberate decision, not a default.
 */

import { createInitialArchState } from './arch-state.js';
import type { ArchState } from './arch-state.js';
import type { Event } from './events.js';

// Re-export for downstream consumers that import from './reducer'
export type { ArchState, PendingOp, CurrentTurn } from './arch-state.js';
export { createInitialArchState } from './arch-state.js';

/** Reducer result using the real Effect type from effects.ts. */
export type ReducerResult = import('./reducer/helpers.js').ReducerResult;

/** Pre-created initial state for convenience. */
const initialArchState: ArchState = createInitialArchState();
export { initialArchState };

// Handler modules
import { handleCommand } from './reducer/command-handlers.js';
import { handleEffectResult, handleModelSwitchConfirmResult, handlePreflightFailed, handlePreflightSuperseded, handleClearQueueResult, handleReplaceQueueResult, handleMcpServersUpdated, handleMcpSessionServersUpdated } from './reducer/result-handlers.js';
import { handleStreamingEvent, handleQueuedDelivered, handleAssistantMessageErrorStamped } from './reducer/streaming-handlers.js';
import {
  handleSessionClosed,
  handleSessionListChanged,
  handleSessionOpened,
  handleSessionNameDerived,
  handleAgentSettled,
  handleBusyChanged,
  handleBusyCompleted,
  handleCompactionStarted,
  handleCompactionEnded,
  handleLastCompactionCleared,
  handleContextUsageChanged,
  handleSessionMetadataChanged,
  handleRunningSessionsChanged,
  handleRetryStarted,
  handleRetryEnded,
  handleUnreadFinishedSessionsChanged,
  handleSessionSummaryUpserted,
  handleSessionSummariesReplaced,
  handleSessionScopeCleared,
  handlePendingPathReplaced,
  handleSendOperationDelayed,
  handleSendOperationStatus,
  handleMessageOperationDelayed,
  handleMessageOperationStatus,
  handleCreateOperationDelayed,
  handleCreateOperationSucceeded,
  handleCreateOperationFailed,
  handleTabOpened,
  handleOpenTabsChanged,
  handleSessionsInterrupted,
} from './reducer/session-handlers.js';
import {
  handleBackendReadyChanged,
  handleBackendReadyWatchdogFired,
  handlePruningSettingsChanged,
  handleSessionTitlesSettingsChanged,
  handleToolResultPruningSettingsChanged,
  handleWorkspaceCwdChanged,
  handleTranscriptPageLoaded,
  handleTranscriptTrimmed,
  handleAvailableExtensionsChanged,
} from './reducer/host-handlers.js';
import {
  handleOptimisticMessageInserted,
  handleOptimisticMessageRemoved,
} from './reducer/optimistic-handlers.js';
import {
  handleCustomMessage,
  handleExtensionUIRequest,
  handleError,
  handleIncidentReported,
  handleNoticeShown,
  handlePendingExtensionUIRequestsCleared,
} from './reducer/ui-handlers.js';
import {
  handleTruncateResult,
  handleCreateSessionResult,
  handleDuplicateSessionResult,
  handleOpenSessionResult,
  handleOpenSessionReconciliationDue,
  handleCloseSessionResult,
  handlePersistTabsResult,
  handleBackendRestartDrainCompleted,
  handleBackendRestartOldGenerationDied,
  handleBackendRestartResult,
} from './reducer/misc-handlers.js';
import { handleAvailableModelsChanged, handleModelSettingsHydrated } from './reducer/set-model-handlers.js';
import { handleFileChangesUpdated } from './reducer/file-handlers.js';
import {
  handleTurnSemanticEvent,
  handleLiveLifecycleWatermark,
  handleLiveTurnCheckpointResult,
} from './reducer/live-pipeline-handlers.js';
import {
  handleActiveRunSummaryChanged,
  handleComposerInputsReplaced,
} from './reducer/composer-handlers.js';

/**
 * Reducer: routes events to per-kind handlers.
 */
export function reducer(state: ArchState, event: Event): ReducerResult {
  switch (event.kind) {
    case 'Command': {
      return handleCommand(state, event.cmd);
    }

    // ─── Effect result events ─────────────────────────────────────────

    case 'ContinueResult':
    case 'InterruptResult':
    case 'CompactResult':
    case 'SendResult':
    case 'EditResult':
    case 'FileDiffResult':
    case 'FileRevertResult':
    case 'SetModelResult':
    case 'SetPrefsResult':
    case 'LoadOlderTranscriptResult':
    case 'LoadNewerTranscriptResult':
    case 'JumpToLatestTranscriptResult':
    case 'StartNewTaskResult':
    case 'ContinueTaskResult':
    case 'OpenFileInEditorResult':
    case 'OpenFileResult':
    case 'SetPruningSettingsResult':
    case 'SetToolResultPruningSettingsResult':
    case 'SetSessionTitlesSettingsResult':
    case 'SessionTitleResult':
    case 'ExtensionUiResponseResult': {
      return handleEffectResult(state, event);
    }

    case 'ClearQueueResult': {
      return handleClearQueueResult(state, event);
    }

    case 'ReplaceQueueResult': {
      return handleReplaceQueueResult(state, event);
    }

    case 'LiveTurnCheckpointResult': {
      return handleLiveTurnCheckpointResult(state, event);
    }

    // ─── Backend streaming events ─────────────────────────────────────────

    case 'TurnSemanticEventReceived': {
      return handleTurnSemanticEvent(state, event);
    }

    case 'LiveLifecycleWatermarkReceived': {
      return handleLiveLifecycleWatermark(state, event);
    }

    case 'MessageStarted':
    case 'MessageAborted':
    case 'MessageDelta':
    case 'MessageThinking':
    case 'ToolCall':
    case 'MessageFinished': {
      return handleStreamingEvent(state, event);
    }

    case 'QueuedDelivered': {
      return handleQueuedDelivered(state, event);
    }

    // ─── Session lifecycle events ─────────────────────────────────────────

    case 'SessionClosed': {
      return handleSessionClosed(state, event);
    }

    case 'SessionNameDerived': {
      return handleSessionNameDerived(state, event);
    }

    case 'SessionOpened': {
      // Kept inline for now (matches handleSessionOpened in session-handlers)
      return handleSessionOpened(state, event);
    }

    case 'AgentSettled': {
      return handleAgentSettled(state, event);
    }

    case 'BusyChanged': {
      return handleBusyChanged(state, event);
    }

    case 'BusyCompleted': {
      return handleBusyCompleted(state, event);
    }

    case 'CompactionStarted': {
      return handleCompactionStarted(state, event);
    }

    case 'CompactionEnded': {
      return handleCompactionEnded(state, event);
    }

    case 'LastCompactionCleared': {
      return handleLastCompactionCleared(state, event);
    }

    case 'ContextUsageChanged': {
      return handleContextUsageChanged(state, event);
    }

    case 'SessionListChanged': {
      return handleSessionListChanged(state, event);
    }

    // ─── Host events ───────────────────────────────────────────────────────

    case 'BackendReadyChanged': {
      return handleBackendReadyChanged(state, event);
    }
    case 'BackendReadyWatchdogFired': {
      return handleBackendReadyWatchdogFired(state, event);
    }

    case 'PruningSettingsChanged': {
      return handlePruningSettingsChanged(state, event);
    }

    case 'SessionTitlesSettingsChanged': {
      return handleSessionTitlesSettingsChanged(state, event);
    }

    case 'ToolResultPruningSettingsChanged': {
      return handleToolResultPruningSettingsChanged(state, event);
    }

    case 'WorkspaceCwdChanged': {
      return handleWorkspaceCwdChanged(state, event);
    }

    case 'TranscriptPageLoaded': {
      return handleTranscriptPageLoaded(state, event);
    }

    case 'FileChangesUpdated': {
      return handleFileChangesUpdated(state, event);
    }

    case 'ActiveRunSummaryChanged': {
      return handleActiveRunSummaryChanged(state, event);
    }

    case 'SessionMetadataChanged': {
      return handleSessionMetadataChanged(state, event);
    }

    case 'AvailableModelsChanged': {
      return handleAvailableModelsChanged(state, event);
    }

    case 'ModelSettingsHydrated': {
      return handleModelSettingsHydrated(state, event);
    }

    case 'PendingExtensionUIRequestsCleared': {
      return handlePendingExtensionUIRequestsCleared(state, event);
    }

    case 'AvailableExtensionsChanged': {
      return handleAvailableExtensionsChanged(state, event);
    }

    case 'AssistantMessageErrorStamped': {
      return handleAssistantMessageErrorStamped(state, event);
    }

    case 'ComposerInputsReplaced': {
      return handleComposerInputsReplaced(state, event);
    }

    case 'PendingPathReplaced': {
      return handlePendingPathReplaced(state, event);
    }

    case 'SendOperationDelayed': {
      return handleSendOperationDelayed(state, event);
    }
    case 'SendOperationStatus': {
      return handleSendOperationStatus(state, event);
    }
    case 'MessageOperationDelayed': {
      return handleMessageOperationDelayed(state, event);
    }
    case 'MessageOperationStatus': {
      return handleMessageOperationStatus(state, event);
    }
    case 'CreateOperationDelayed': {
      return handleCreateOperationDelayed(state, event);
    }
    case 'CreateOperationSucceeded': {
      return handleCreateOperationSucceeded(state, event);
    }
    case 'CreateOperationFailed': {
      return handleCreateOperationFailed(state, event);
    }

    case 'TranscriptTrimmed': {
      return handleTranscriptTrimmed(state, event);
    }

    case 'RunningSessionsChanged': {
      return handleRunningSessionsChanged(state, event);
    }

    case 'RetryStarted': {
      return handleRetryStarted(state, event);
    }

    case 'RetryEnded': {
      return handleRetryEnded(state, event);
    }

    case 'SessionsInterrupted': {
      return handleSessionsInterrupted(state, event);
    }

    case 'UnreadFinishedSessionsChanged': {
      return handleUnreadFinishedSessionsChanged(state, event);
    }

    case 'SessionSummaryUpserted': {
      return handleSessionSummaryUpserted(state, event);
    }

    case 'SessionSummariesReplaced': {
      return handleSessionSummariesReplaced(state, event);
    }

    case 'SessionScopeCleared': {
      return handleSessionScopeCleared(state, event);
    }

    case 'TabOpened': {
      return handleTabOpened(state, event);
    }

    case 'OpenTabsChanged': {
      return handleOpenTabsChanged(state, event);
    }

    case 'PreflightFailed': {
      return handlePreflightFailed(state, event);
    }

    case 'PreflightSuperseded': {
      return handlePreflightSuperseded(state, event);
    }

    // ─── UI events ─────────────────────────────────────────────────────────

    case 'CustomMessage': {
      return handleCustomMessage(state, event);
    }

    case 'ExtensionUIRequest': {
      return handleExtensionUIRequest(state, event);
    }

    case 'IncidentReported': {
      return handleIncidentReported(state, event);
    }

    case 'Error': {
      return handleError(state, event);
    }

    case 'NoticeShown': {
      return handleNoticeShown(state, event);
    }

    case 'McpServersUpdated': {
      return handleMcpServersUpdated(state, event);
    }

    case 'McpSessionServersUpdated': {
      return handleMcpSessionServersUpdated(state, event);
    }

    // ─── Optimistic UI events ──────────────────────────────────────────────

    case 'OptimisticMessageInserted': {
      return handleOptimisticMessageInserted(state, event);
    }

    case 'OptimisticMessageRemoved': {
      return handleOptimisticMessageRemoved(state, event);
    }

    // ─── Result stubs ──────────────────────────────────────────────────────

    case 'TruncateResult': {
      return handleTruncateResult(state, event);
    }

    case 'CreateSessionResult': {
      return handleCreateSessionResult(state, event);
    }

    case 'DuplicateSessionResult': {
      return handleDuplicateSessionResult(state, event);
    }

    case 'CloseSessionResult': {
      return handleCloseSessionResult(state, event);
    }

    case 'OpenSessionResult': {
      return handleOpenSessionResult(state, event);
    }

    case 'OpenSessionReconciliationDue': {
      return handleOpenSessionReconciliationDue(state, event);
    }

    case 'PersistTabsResult': {
      return handlePersistTabsResult(state, event);
    }

    case 'BackendRestartDrainCompleted': {
      return handleBackendRestartDrainCompleted(state, event);
    }

    case 'BackendRestartOldGenerationDied': {
      return handleBackendRestartOldGenerationDied(state, event);
    }

    case 'BackendRestartResult': {
      return handleBackendRestartResult(state, event);
    }

    case 'ModelSwitchConfirmResult': {
      return handleModelSwitchConfirmResult(state, event);
    }

    default: {
      // Exhaustiveness: the switch is total over `Event`. If this branch is
      // reached, an Event kind is unhandled above — the `never` assignment
      // turns that into a compile-time error so adding a new Event variant
      // without a handler fails the build. At runtime we fail loud
      // (error-level log) rather than silently dropping the event, but we do
      // not throw so one malformed event cannot take down a streaming session.
      const _exhaustive: never = event;
      void _exhaustive;
      return {
        state,
        effects: [
          {
            kind: 'Log',
            corrId: '',
            level: 'error',
            message: `reducer: unhandled event kind (type system bypassed?): ${(event as { kind?: string }).kind}`,
          },
        ],
      };
    }
  }
}
