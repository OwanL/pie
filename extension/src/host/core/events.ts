/**
 * `Event` discriminated union — the sole input to the pure reducer.
 *
 * Events include:
 *  - User intents wrapped as `{kind:'Command', cmd}` (posted by the webview
 *    message bridge and other host entry points).
 *  - Results of effects executed by `EffectRunner` (each side-effecting effect
 *    has a matching `*Result` event carrying the same `corrId`).
 *  - Backend events forwarded by the backend event parser.
 *
 * The reducer switch in `core/reducer.ts` is total over this union: a missing
 * handler is a compile-time error (see the `never` default), not a silent
 * no-op. See `docs/STATE_CONTRACT.md` for the invariants.
 */

import type { Command } from './commands';
import type { NoticeKind } from '../../shared/error-mapping';
import type { LiveLifecycleWatermark, LiveTurnCheckpoint, TurnSemanticEnvelope } from '../../shared/live-pipeline-protocol';
import type {
  ChatMessage,
  ToolCall,
  ContextWindowUsage,
  SessionSummary,
  ExtensionUIRequestPayload,
  SessionOpenedPayload,
  PruningSettings,
  ToolResultPruningSettings,
  FileChangeEntry,
  ActiveRunSummary,
  ExtensionInfo,
  ModelInfo,
  ComposerInput,
  TranscriptWindow,
  ModelSettings,
  UserContentPart,
} from '../../shared/protocol';

/** Wraps a `Command` so it can flow through the same event channel. */
export interface CommandEvent {
  kind: 'Command';
  cmd: Command;
}

// ─── Effect result events ────────────────────────────────────────────────────

export interface SendResultEvent {
  kind: 'SendResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  /** Backend-assigned request ID, used to bind events to sessions. Absent for
   *  a queued (follow-up) send — the backend acks `{ queued: true }` with no
   *  `requestId` because no turn is started by the enqueue; the message runs
   *  later as a fresh turn under the in-progress request's id. */
  requestId?: string;
  /** True when the send was queued as a follow-up (sent while a turn was
   *  already running). The host keeps the optimistic message as 'queued'
   *  and awaits `QueuedDelivered` to promote it to 'completed'. */
  queued?: boolean;
  error?: string;
}

export interface EditResultEvent {
  kind: 'EditResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  /** Backend-assigned request ID (early-ack). Stamped on success so a
   *  post-ack `PreflightFailed` and the commit-point `MessageStarted` can
   *  resolve the edit's corrId via `pending.promoted` — mirroring `SendResult`.
   *  See STATE_CONTRACT § Optimistic Reconciliation "Two failure windows". */
  requestId?: string;
  error?: string;
}

export interface ReplaceQueueResultEvent {
  kind: 'ReplaceQueueResult';
  corrId: string;
  sessionPath: string;
  messageId: string;
  ok: boolean;
  text: string;
  inputs: ComposerInput[];
  composedText: string;
  userParts?: UserContentPart[];
  error?: string;
}

export interface InterruptResultEvent {
  kind: 'InterruptResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface TruncateResultEvent {
  kind: 'TruncateResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface CompactResultEvent {
  kind: 'CompactResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface ClearQueueResultEvent {
  kind: 'ClearQueueResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface OpenSessionResultEvent {
  kind: 'OpenSessionResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface CreateSessionResultEvent {
  kind: 'CreateSessionResult';
  corrId: string;
  ok: boolean;
  /** The session path the backend allocated, if ok. */
  sessionPath?: string;
  error?: string;
}

export interface PersistTabsResultEvent {
  kind: 'PersistTabsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface ExtensionUiResponseResultEvent {
  kind: 'ExtensionUiResponseResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface SetModelResultEvent {
  kind: 'SetModelResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

/** Result of a `ShowModelSwitchConfirm` effect: the user's choice in the modal
 *  dialog. `confirmed: false` covers both an explicit non-confirm click and a
 *  dismissal (undefined choice). The reducer branches on this to either apply
 *  the optimistic model switch + emit `SetModelRpc`, or abort unchanged. */
export interface ModelSwitchConfirmResultEvent {
  kind: 'ModelSwitchConfirmResult';
  corrId: string;
  confirmed: boolean;
}

export interface SetPrefsResultEvent {
  kind: 'SetPrefsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface FileDiffResultEvent {
  kind: 'FileDiffResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface FileRevertResultEvent {
  kind: 'FileRevertResult';
  corrId: string;
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface LoadOlderTranscriptResultEvent {
  kind: 'LoadOlderTranscriptResult';
  corrId: string;
  /** Session path so the reducer can look up the in-flight paging flag. */
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface LoadNewerTranscriptResultEvent {
  kind: 'LoadNewerTranscriptResult';
  corrId: string;
  /** Session path so the reducer can look up the in-flight paging flag. */
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface JumpToLatestTranscriptResultEvent {
  kind: 'JumpToLatestTranscriptResult';
  corrId: string;
  /** Session path so the reducer can look up the in-flight paging flag. */
  sessionPath: string;
  ok: boolean;
  error?: string;
}

export interface RecordOutcomeResultEvent {
  kind: 'RecordOutcomeResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface StartNewTaskResultEvent {
  kind: 'StartNewTaskResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface ContinueTaskResultEvent {
  kind: 'ContinueTaskResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface OpenFileInEditorResultEvent {
  kind: 'OpenFileInEditorResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface OpenFileResultEvent {
  kind: 'OpenFileResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface SetPruningSettingsResultEvent {
  kind: 'SetPruningSettingsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface SetToolResultPruningSettingsResultEvent {
  kind: 'SetToolResultPruningSettingsResult';
  corrId: string;
  ok: boolean;
  error?: string;
}

export interface CloseSessionResultEvent {
  kind: 'CloseSessionResult';
  corrId: string;
  ok: boolean;
  /** The closed session path, if ok. */
  sessionPath?: string;
  error?: string;
}

export interface DuplicateSessionResultEvent {
  kind: 'DuplicateSessionResult';
  corrId: string;
  ok: boolean;
  /** The pending session path of the copy, if ok. */
  sessionPath?: string;
  error?: string;
}

export interface LiveTurnCheckpointResultEvent {
  kind: 'LiveTurnCheckpointResult';
  corrId: string;
  sessionPath: string;
  turnId: string;
  attemptId: string;
  ok: boolean;
  occurredAt: number;
  status?: 'active' | 'terminal_grace' | 'inactive' | 'backend_restarted' | 'oversize';
  checkpoint?: LiveTurnCheckpoint | null;
  watermark?: LiveLifecycleWatermark | null;
  error?: string;
}

export type EffectResultEvent =
  | LiveTurnCheckpointResultEvent
  | SendResultEvent
  | EditResultEvent
  | ReplaceQueueResultEvent
  | InterruptResultEvent
  | TruncateResultEvent
  | CompactResultEvent
  | ClearQueueResultEvent
  | OpenSessionResultEvent
  | CreateSessionResultEvent
  | PersistTabsResultEvent
  | ExtensionUiResponseResultEvent
  | SetModelResultEvent
  | ModelSwitchConfirmResultEvent
  | SetPrefsResultEvent
  | FileDiffResultEvent
  | FileRevertResultEvent
  | LoadOlderTranscriptResultEvent
  | LoadNewerTranscriptResultEvent
  | JumpToLatestTranscriptResultEvent
  | RecordOutcomeResultEvent
  | StartNewTaskResultEvent
  | ContinueTaskResultEvent
  | OpenFileInEditorResultEvent
  | OpenFileResultEvent
  | SetPruningSettingsResultEvent
  | SetToolResultPruningSettingsResultEvent
  | CloseSessionResultEvent
  | DuplicateSessionResultEvent;

// ─── Backend streaming events ─────────────────────────────────────────────────
// These wrap PI backend events so they flow through the reducer.

export interface MessageStartedEvent {
  kind: 'MessageStarted';
  sessionPath: string;
  messageId: string;
  requestId?: string;
  modelId?: string;
  thinkingLevel?: ChatMessage['thinkingLevel'];
  timestamp: number;
}

export interface MessageDeltaEvent {
  kind: 'MessageDelta';
  sessionPath: string;
  messageId: string;
  delta: string;
}

export interface MessageThinkingEvent {
  kind: 'MessageThinking';
  sessionPath: string;
  messageId: string;
  thinking: string;
}

export interface MessageAbortedEvent {
  kind: 'MessageAborted';
  sessionPath: string;
  messageId?: string;
  userInitiated?: boolean;
  reason?: string;
}

export interface ToolCallEvent {
  kind: 'ToolCall';
  sessionPath: string;
  messageId: string;
  toolCall: ToolCall;
}

export interface MessageFinishedEvent {
  kind: 'MessageFinished';
  sessionPath: string;
  message: ChatMessage;
}

/** Emitted when a session starts or stops streaming. */
export interface BusyChangedEvent {
  kind: 'BusyChanged';
  sessionPath: string;
  running: boolean;
}

/** Emitted when a session finishes streaming (complement to BusyChanged). */
export interface BusyCompletedEvent {
  kind: 'BusyCompleted';
  sessionPath: string;
}

/** Emitted when context window usage changes for a session. */
export interface ContextUsageChangedEvent {
  kind: 'ContextUsageChanged';
  sessionPath: string;
  contextUsage: ContextWindowUsage | null;
}

/** Emitted when the backend's session list changes. */
export interface SessionListChangedEvent {
  kind: 'SessionListChanged';
  sessionSummaries: SessionSummary[];
}

/** Emitted when the backend sends a custom message (e.g., pruning result). */
export interface CustomMessageEvent {
  kind: 'CustomMessage';
  sessionPath: string;
  message: ChatMessage;
}

/** Emitted when the backend requests an extension UI interaction. */
export interface ExtensionUIRequestEvent {
  kind: 'ExtensionUIRequest';
  sessionPath: string;
  request: ExtensionUIRequestPayload;
}

/** Emitted when the host wants to show (or clear) a user-facing notice. */
export interface NoticeShownEvent {
  kind: 'NoticeShown';
  notice: string | null;
  noticeKind?: NoticeKind | null;
  noticeRaw?: string | null;
}

/** Emitted when the backend reports an error. */
export interface ErrorEvent {
  kind: 'Error';
  sessionPath: string;
  error: string;
}

/** Emitted when a session is opened and its data is loaded. */
export interface SessionOpenedEvent {
  kind: 'SessionOpened';
  sessionPath: string;
  payload: SessionOpenedPayload;
}

/** Emitted by the host when a session tab is closed. */
export interface SessionClosedEvent {
  kind: 'SessionClosed';
  sessionPath: string;
}

/** Emitted when the host derives an optimistic session name from the first message text. */
export interface SessionNameDerivedEvent {
  kind: 'SessionNameDerived';
  sessionPath: string;
  name: string;
}

/** Emitted when an optimistic local user message is inserted into the transcript. */
export interface OptimisticMessageInsertedEvent {
  kind: 'OptimisticMessageInserted';
  sessionPath: string;
  localId: string;
  text: string;
  timestamp: number;
}

/** Emitted when an optimistic local user message is removed from the transcript. */
export interface OptimisticMessageRemovedEvent {
  kind: 'OptimisticMessageRemoved';
  sessionPath: string;
  localId: string;
}

/** Emitted when a file change entry is removed (e.g. on revert). */
export interface FileChangeRemovedEvent {
  kind: 'FileChangeRemoved';
  sessionPath: string;
  filePath: string;
}

/** Emitted when the backend ready state changes. */
export interface BackendReadyChangedEvent {
  kind: 'BackendReadyChanged';
  ready: boolean;
}

/**
 * Emitted by the runner's backend-ready watchdog timer when it fires (the
 * backend did not become ready within the timeout). The reducer drops all
 * queued backend-ready sends, removes their optimistic messages, and sets a
 * user-visible notice.
 */
export interface BackendReadyWatchdogFiredEvent {
  kind: 'BackendReadyWatchdogFired';
}

/** Emitted when pruning settings change. */
export interface PruningSettingsChangedEvent {
  kind: 'PruningSettingsChanged';
  pruningSettings: PruningSettings;
}

/** Emitted when tool-result pruning settings change. */
export interface ToolResultPruningSettingsChangedEvent {
  kind: 'ToolResultPruningSettingsChanged';
  toolResultPruningSettings: ToolResultPruningSettings;
}

/** Emitted when the workspace cwd changes. */
export interface WorkspaceCwdChangedEvent {
  kind: 'WorkspaceCwdChanged';
  workspaceCwd: string;
}

/** Emitted when a transcript page is loaded (older/newer/latest). */
export interface TranscriptPageLoadedEvent {
  kind: 'TranscriptPageLoaded';
  sessionPath: string;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
}

/** Emitted when file changes are updated for a session. */
export interface FileChangesUpdatedEvent {
  kind: 'FileChangesUpdated';
  sessionPath: string;
  fileChanges: FileChangeEntry[];
}

/** Emitted when the active run summary for a session changes. */
export interface ActiveRunSummaryChangedEvent {
  kind: 'ActiveRunSummaryChanged';
  sessionPath: string;
  summary: ActiveRunSummary | null;
}

/** Emitted when session metadata (modelId/thinkingLevel) changes. */
export interface SessionMetadataChangedEvent {
  kind: 'SessionMetadataChanged';
  sessionPath: string;
  modelId?: string;
  thinkingLevel?: ChatMessage['thinkingLevel'];
}

/** Emitted by `hydrateModelState` to sync the global `modelSettings` (the
 *  persisted default model + thinking level) read-only from the backend into
 *  ArchState. Unlike `SetModel`, this does NOT switch the focused session's
 *  live model, touch the per-session model badge, or persist anything — it
 *  only corrects ArchState's global default when `settings.get` reports a
 *  value ArchState doesn't have yet (e.g. startup before `SessionOpened`, or
 *  an external default change). The per-session badge stays as the session
 *  summary's `modelId`, which is the source of truth for which model a given
 *  session is actually running. */
export interface ModelSettingsHydratedEvent {
  kind: 'ModelSettingsHydrated';
  modelSettings: ModelSettings;
}

/** Emitted when available models for a session change. */
export interface AvailableModelsChangedEvent {
  kind: 'AvailableModelsChanged';
  sessionPath: string;
  models: ModelInfo[];
}

/** Emitted when pending extension UI requests for a session are cleared. */
export interface PendingExtensionUIRequestsClearedEvent {
  kind: 'PendingExtensionUIRequestsCleared';
  sessionPath: string;
}

/** Emitted when available extensions change. */
export interface AvailableExtensionsChangedEvent {
  kind: 'AvailableExtensionsChanged';
  extensions: ExtensionInfo[];
}

/** Emitted when the last assistant message in a transcript should be marked as error. */
export interface AssistantMessageErrorStampedEvent {
  kind: 'AssistantMessageErrorStamped';
  sessionPath: string;
  errorMessage: string;
}

/** Emitted when composer inputs for a session are replaced wholesale. */
export interface ComposerInputsReplacedEvent {
  kind: 'ComposerInputsReplaced';
  sessionPath: string;
  inputs: ComposerInput[] | null;
}

/** Emitted when a pending path is replaced with a real session path. */
export interface PendingPathReplacedEvent {
  kind: 'PendingPathReplaced';
  oldPendingPath: string;
  newSessionPath: string;
}

/** Post-ack, pre-commit prepass failure for an early-acked send. The
 *  `message.send` RPC already succeeded (the prompt was queued); the pruning
 *  prepass then failed. This is the post-ack failure window distinct from a
 *  pre-ack `SendResult{ok:false}` (see `docs/STATE_CONTRACT.md` § Optimistic
 *  Reconciliation "Two failure windows for send"). The reducer reverts via
 *  `pending.promoted[corrId]`.
 *
 *  `corrId` is present when the dispatcher knows it (e.g. Brief B's send-timer,
 *  started in `runSendRpc` where the effect's `corrId` is known). It is absent
 *  when dispatched from the backend prepass-failure bridge — the backend mints
 *  `requestId` but never sees the host `corrId` — in which case the reducer
 *  resolves `corrId` by scanning `pending.promoted` for the matching
 *  `requestId`. */
export interface PreflightFailedEvent {
  kind: 'PreflightFailed';
  corrId?: string;
  sessionPath: string;
  requestId: string;
  error: string;
}

/** Late commit after a send-timer fire. The post-ack send-timer fired and
 *  dispatched `PreflightFailed`, rolling back the optimistic user message and
 *  surfacing a `prepass-timeout` notice, but the turn has now started streaming
 *  anyway. The reducer reverts the rollback: it restores the optimistic user
 *  message, clears the notice, and restores `runningSessionPaths` so the UI
 *  shows the turn continuing. This is a retraction, not a failure. */
export interface PreflightSupersededEvent {
  kind: 'PreflightSuperseded';
  corrId: string;
  requestId: string;
  sessionPath: string;
  localId: string;
  text?: string;
  inputs?: ComposerInput[];
  composedText?: string;
  userParts?: UserContentPart[];
  previousSummary?: SessionSummary | null;
  /** Injected by the effect layer (EffectRunner stamps the current wall-clock
   *  time); required so the pure reducer spine can format it with
   *  `new Date(timestamp)` without reading the clock itself (arch-boundary-guards
   *  bans clock reads in the reducer spine). */
  timestamp: number;
}

/** Emitted when a session's transcript is trimmed (eviction). */
export interface TranscriptTrimmedEvent {
  kind: 'TranscriptTrimmed';
  sessionPath: string;
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
}

/** Emitted when running session paths are set wholesale. */
export interface RunningSessionsChangedEvent {
  kind: 'RunningSessionsChanged';
  sessionPaths: string[];
}

/** Emitted when unread finished session paths are set wholesale. */
export interface UnreadFinishedSessionsChangedEvent {
  kind: 'UnreadFinishedSessionsChanged';
  sessionPaths: string[];
}

/** Emitted when session summaries are replaced (startup restore). */
export interface SessionSummariesReplacedEvent {
  kind: 'SessionSummariesReplaced';
  summaries: SessionSummary[];
}

/** Emitted when session scope is cleared. */
export interface SessionScopeClearedEvent {
  kind: 'SessionScopeCleared';
  sessionPath: string;
  removeSessionSummary: boolean;
}

/** Emitted when a tab is opened (added to openTabPaths). */
export interface TabOpenedEvent {
  kind: 'TabOpened';
  sessionPath: string;
  insertAfter?: string;
}

/** Emitted when openTabPaths is replaced wholesale (e.g. startup restore).
 *  `pinnedTabPaths` (when provided) restores the pinned set and reorders
 *  `openTabPaths` so pinned tabs form the leading prefix. */
export interface OpenTabsChangedEvent {
  kind: 'OpenTabsChanged';
  openTabPaths: string[];
  pinnedTabPaths?: string[];
}

/**
 * Emitted when one or more sessions were interrupted by something other than
 * an explicit user action (Stop button / edit-while-streaming). Today the only
 * producer is the backend `onExit` handler in `attach.ts`: when the PI backend
 * process dies while sessions are running, no per-session `message.aborted`
 * event ever fires (the backend is gone), so without this event those sessions'
 * streaming assistant messages would stay `status: 'streaming'` forever and
 * the user would see only a generic "PI backend stopped" notice with no
 * per-session alert naming which sessions were interrupted.
 *
 * The reducer marks every still-streaming assistant message in each listed
 * session `interrupted` and stamps `errorDetail` with the supplied reason, so
 * the user is alerted inline in each affected tab AND via the global notice.
 *
 * `userInitiated` is false by construction — this event is never dispatched
 * for user-initiated interrupts (those go through `MessageAborted` with
 * `userInitiated: true`, which suppresses the alert path).
 */
export interface SessionsInterruptedEvent {
  kind: 'SessionsInterrupted';
  /** Session paths that were running when the interrupt occurred. */
  sessionPaths: string[];
  /** Plain-language reason shown to the user (e.g. backend exit detail). */
  reason: string;
  /** Effect-owned timestamp used for deterministic terminal tombstone expiry. */
  occurredAt?: number;
}

/** Steering (FollowUp): the agent loop injected a queued follow-up user
 *  message into a turn. The host promotes its earliest optimistic 'queued'
 *  transcript message to 'completed' (FIFO — the SDK drains the follow-up
 *  queue one message at a time in enqueue order). `text` is observational only
 *  (the SDK may have expanded skill/template commands, so it can differ from
 *  what the user typed) and is not used for matching. */
export interface QueuedDeliveredEvent {
  kind: 'QueuedDelivered';
  sessionPath: string;
  text: string;
  localId?: string;
}

/** The SDK began an auto-retry attempt (transient provider error). The
 *  reducer records per-session retry status so the webview can surface a
 *  "Retrying N of M…" chip with a Cancel affordance. Independent of the busy
 *  flag (a retry sleeps between turns; busy stays true via the `willRetry`
 *  gate on `agent_end`). */
export interface RetryStartedEvent {
  kind: 'RetryStarted';
  sessionPath: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  errorMessage: string;
}

/** An auto-retry attempt concluded — success (the retried turn produced a
 *  non-error message), final failure (retries exhausted), or cancellation
 *  (`session.abort()` aborted the retry sleep). Clears retry status. */
export interface RetryEndedEvent {
  kind: 'RetryEnded';
  sessionPath: string;
  success: boolean;
  attempt: number;
  finalError?: string;
}

export interface TurnSemanticEventReceived {
  kind: 'TurnSemanticEventReceived';
  envelope: TurnSemanticEnvelope;
}

export interface LiveLifecycleWatermarkReceived {
  kind: 'LiveLifecycleWatermarkReceived';
  watermark: LiveLifecycleWatermark;
}

export type BackendEvent =
  | TurnSemanticEventReceived
  | LiveLifecycleWatermarkReceived
  | MessageStartedEvent
  | MessageAbortedEvent
  | MessageDeltaEvent
  | MessageThinkingEvent
  | ToolCallEvent
  | MessageFinishedEvent
  | BusyChangedEvent
  | BusyCompletedEvent
  | ContextUsageChangedEvent
  | SessionListChangedEvent
  | CustomMessageEvent
  | ExtensionUIRequestEvent
  | ErrorEvent
  | SessionOpenedEvent
  | SessionClosedEvent
  | QueuedDeliveredEvent
  | RetryStartedEvent
  | RetryEndedEvent;

/** Emitted when a session summary is upserted (used for placeholder creation). */
export interface SessionSummaryUpsertedEvent {
  kind: 'SessionSummaryUpserted';
  summary: SessionSummary;
}

export type HostEvent =
  | NoticeShownEvent
  | SessionNameDerivedEvent
  | OptimisticMessageInsertedEvent
  | OptimisticMessageRemovedEvent
  | FileChangeRemovedEvent
  | BackendReadyChangedEvent
  | BackendReadyWatchdogFiredEvent
  | PruningSettingsChangedEvent
  | ToolResultPruningSettingsChangedEvent
  | WorkspaceCwdChangedEvent
  | TranscriptPageLoadedEvent
  | FileChangesUpdatedEvent
  | ActiveRunSummaryChangedEvent
  | SessionMetadataChangedEvent
  | AvailableModelsChangedEvent
  | ModelSettingsHydratedEvent
  | PendingExtensionUIRequestsClearedEvent
  | AvailableExtensionsChangedEvent
  | AssistantMessageErrorStampedEvent
  | ComposerInputsReplacedEvent
  | PendingPathReplacedEvent
  | TranscriptTrimmedEvent
  | RunningSessionsChangedEvent
  | UnreadFinishedSessionsChangedEvent
  | SessionSummaryUpsertedEvent
  | SessionSummariesReplacedEvent
  | SessionScopeClearedEvent
  | TabOpenedEvent
  | OpenTabsChangedEvent
  | PreflightFailedEvent
  | PreflightSupersededEvent
  | SessionsInterruptedEvent;

export type Event = CommandEvent | EffectResultEvent | BackendEvent | HostEvent;
