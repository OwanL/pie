/**
 * Phase 2 type spine — `Effect` discriminated union.
 *
 * Effects are produced by the reducer and consumed exclusively by the
 * `EffectRunner`. They describe a side-effecting intent (an RPC call, a
 * persistence write, a log line); the reducer never performs them directly.
 * The runner translates each effect into the appropriate queue path:
 *
 * - Session-scoped `*Rpc` effects route through
 *   `enqueueSessionOperation(sessionPath, do_rpc)` so they remain FIFO within
 *   one session without blocking lifecycle work for other tabs.
 * - Lifecycle effects (`OpenSession`, `CreateSession`) use `enqueueLifecycle`
 *   directly because the target session may not yet exist.
 * - `PersistTabs` and `Log` execute synchronously without queueing.
 *
 * Each effect's `corrId` is propagated back into the matching `*Result` event
 * so the reducer can reconcile optimistic state (Phase 4).
 */

import type { ComposerInput, ModelSettings, ChatPrefs, HostToWebviewMessage, PruningMode, ThinkingLevel, UserContentPart, RendererCommandContext } from '../../shared/protocol';
import type { LiveSubagentDetailAddress, DetailCursor, DetailPageRef } from '../../shared/protocol/subagent-detail';
import type { BackendReadyQueueEntry, DeferredSetModelEntry, PendingSendQueueEntry } from './arch-state';

export interface EffectBase {
  corrId: string;
}

export interface SendRpcEffect extends EffectBase {
  kind: 'SendRpc';
  operationId?: string;
  operationAttempt?: number;
  backendGeneration?: number;
  sessionPath: string;
  text: string;
  /** Composer inputs (file refs, images) sent alongside the text. */
  inputs: ComposerInput[];
  /** Pre-generated local ID for optimistic message reconciliation. */
  localId: string;
  /** Composed text (text + input annotations) for the optimistic transcript entry.
   *  Carried through to the EffectRunner so a late `PreflightSuperseded` retraction
   *  can re-insert the exact optimistic user message that `handleSend` inserted. */
  composedText: string;
  /** User content parts for rich rendering of the optimistic message. */
  userParts?: UserContentPart[];
  /** Brief H compatibility payload. Registered operations keep restoration
   * intent in reducer state and describe it on their cleanup effect. */
  priorPruningMode?: PruningMode;
}

export interface GenerateSessionTitleEffect extends EffectBase {
  kind: 'GenerateSessionTitle';
  sessionPath: string;
  prompt: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  timeoutSec: number;
}

export interface EditRpcEffect extends EffectBase {
  kind: 'EditRpc';
  operationId?: string;
  operationAttempt?: number;
  backendGeneration?: number;
  sessionPath: string;
  messageId: string;
  text: string;
  /** Composer inputs (file refs, images) sent alongside the edited message. */
  inputs: ComposerInput[];
  /** Pre-generated local ID for optimistic message reconciliation. */
  localId: string;
  /** Composed text for the optimistic replacement message. Carried through to the
   *  EffectRunner so a late `PreflightSuperseded` retraction can re-insert the exact
   *  optimistic user message that `handleEdit` inserted. */
  composedText?: string;
  /** User content parts for rich rendering of the optimistic replacement message. */
  userParts?: UserContentPart[];
}

export interface QueuedMessageRpcPayload {
  localId: string;
  text: string;
  inputs: ComposerInput[];
}

export interface ReplaceQueueRpcEffect extends EffectBase {
  kind: 'ReplaceQueueRpc';
  sessionPath: string;
  messageId: string;
  text: string;
  inputs: ComposerInput[];
  composedText: string;
  userParts?: UserContentPart[];
  messages: QueuedMessageRpcPayload[];
  fallbackMessages: QueuedMessageRpcPayload[];
}

export interface ContinueRpcEffect extends EffectBase {
  kind: 'ContinueRpc';
  sessionPath: string;
  operationId?: string;
  operationAttempt?: number;
  backendGeneration?: number;
}

export interface InterruptRpcEffect extends EffectBase {
  kind: 'InterruptRpc';
  operationId?: string;
  operationAttempt?: number;
  backendGeneration?: number;
  sessionPath: string;
  /** Reducer-selected pre-ack sends whose execution controller may be aborted. */
  abortSendCorrIds?: string[];
  /** Reducer-selected queued edits that must not cross their destructive boundary. */
  cancelQueuedOperationIds?: string[];
  /** Reducer evidence that unresolved session mutation work requires the
   * backend priority lane instead of ordinary FIFO admission. */
  usePriorityLane?: boolean;
}

export interface RequestLiveTurnCheckpointEffect extends EffectBase {
  kind: 'RequestLiveTurnCheckpoint';
  sessionPath: string;
  turnId: string;
  attemptId: string;
}

export interface CompactRpcEffect extends EffectBase {
  kind: 'CompactRpc';
  sessionPath: string;
  operationId?: string;
  operationAttempt?: number;
  backendGeneration?: number;
}

export interface ClearQueueRpcEffect extends EffectBase {
  kind: 'ClearQueueRpc';
  sessionPath: string;
}

export interface TruncateRpcEffect extends EffectBase {
  kind: 'TruncateRpc';
  sessionPath: string;
  messageId: string;
}

export interface OpenSessionEffect extends EffectBase {
  kind: 'OpenSession';
  sessionPath: string;
  selectionToken: string;
  operationId?: string;
  operationAttempt?: number;
  backendGeneration?: number;
}

/** Opaque timer requested by the reducer after an open acknowledgement becomes
 * ambiguous. The timer carries no lifecycle authority; its due event is fenced
 * against the current reducer-owned operation attempt. */
export interface ScheduleOpenSessionReconciliationEffect extends EffectBase {
  kind: 'ScheduleOpenSessionReconciliation';
  operationId: string;
  sessionPath: string;
  operationAttempt: number;
  backendGeneration: number;
  delayMs: number;
}

/** Apply reducer-decided selection recovery after bounded repeat-safe open
 * reconciliation is exhausted. */
export interface RecoverOpenSessionEffect extends EffectBase {
  kind: 'RecoverOpenSession';
  selectionToken: string;
  operationAttempt: number;
  notice: string;
}

export interface CreateSessionEffect extends EffectBase {
  kind: 'CreateSession';
  /** The pending session path the reducer optimistically opened. */
  sessionPath: string;
  /** Workspace cwd for the backend session.create RPC. */
  cwd: string;
  /** Selection token (minted before the Command dispatched) for the backend
   *  session.create RPC. */
  selectionToken: string;
  /** Stable host-generated identity reused across create retries. */
  operationId?: string;
  /** Attempt fence for stale timeout/error settlement. */
  operationAttempt?: number;
  /** Backend generation whose process-scoped ledger owns the operation. */
  backendGeneration?: number;
}

export interface NotifySessionViewedEffect extends EffectBase {
  kind: 'NotifySessionViewed';
  sessionPath: string;
  previousSessionPath: string | null;
}

export interface PersistTabsEffect extends EffectBase {
  kind: 'PersistTabs';
  /** Present when persistence is one acknowledgement in a lifecycle barrier. */
  operationId?: string;
  backendGeneration?: number;
  /** Omitted for the ordinary/initial tab-persistence acknowledgement. */
  acknowledgementKey?: 'privacy-marker-removal';
  openTabPaths: string[];
  activeSessionPath: string | null;
  pinnedTabPaths: string[];
  pinnedTabGroups: string[][];
  /** Persist only the session-scoped privacy markers; never session content. */
  privateSessionPaths?: string[];
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEffect extends EffectBase {
  kind: 'Log';
  level: LogLevel;
  message: string;
  data?: unknown;
}

export interface SetModelRpcEffect extends EffectBase {
  kind: 'SetModelRpc';
  sessionPath: string;
  modelSettings: ModelSettings;
}

/** Ask the user to confirm switching to a model that would drop pending pasted
 *  image inputs. The reducer emits this instead of mutating state; the runner
 *  shows a modal VS Code dialog and dispatches `ModelSwitchConfirmResult`.
 *  Carries the question text + the confirm button label so the reducer owns the
 *  copy and the runner stays a thin executor. */
export interface ShowModelSwitchConfirmEffect extends EffectBase {
  kind: 'ShowModelSwitchConfirm';
  sessionPath: string;
  modelSettings: ModelSettings;
  message: string;
  confirmChoice: string;
  /** Trusted initiating renderer (browser server plan §9): a browser source
   *  confirms inline in ITS renderer; the VS Code modal is never shown to a
   *  browser source. Never client-supplied. */
  source?: RendererCommandContext;
}

export interface SetPrefsRpcEffect extends EffectBase {
  kind: 'SetPrefsRpc';
  prefs: Partial<ChatPrefs>;
}

/** Persist a per-server `disabled` override via the backend's
 *  `mcp.setServerEnabled` RPC. The response carries the fresh list and the
 *  pending-apply flag (override applies on next session reload / restart). */
export interface McpSetServerRpcEffect extends EffectBase {
  kind: 'McpSetServerRpc';
  name: string;
  enabled: boolean;
}

/** Read the effective global MCP list, then hydrate one session's persisted
 *  per-server overrides (`mcpSessionOverrides`) on its session FIFO. */
export interface McpListRpcEffect extends EffectBase {
  kind: 'McpListRpc';
  sessionPath?: string;
}

/** Write a session's full per-server override set via the backend's
 *  `mcp.setSessionServerEnabled` RPC. `recycle` asks the backend to retire
 *  that session's worker so the adapter applies the overrides at the next
 *  session start (idle-cycle retries send the same set with `recycle: true`).
 *  The response reports whether the recycle happened. */
export interface McpSetSessionServerRpcEffect extends EffectBase {
  kind: 'McpSetSessionServerRpc';
  sessionPath: string;
  overrides: Record<string, boolean>;
  recycle: boolean;
}

/** Apply privacy bookkeeping outside the pure reducer. The mode itself lives
 *  only in ArchState; the effect discards any already-open analytics state and
 *  scrubs analytics records when privacy is enabled. */
export interface SetPrivacyModeEffect extends EffectBase {
  kind: 'SetPrivacyMode';
  sessionPath: string;
  enabled: boolean;
}

/** Push the complete disabled-entry set for a session's system prompts to the
 *  backend (`systemPromptToggles.set`). The backend persists it, rewrites the
 *  SDK base prompt, and re-emits `session.opened` — the re-emit (not this RPC's
 *  result) is what updates the host's `systemPromptsBySession`, so this effect
 *  is fire-and-forget (no *Result event). */
export interface SetSystemPromptTogglesRpcEffect extends EffectBase {
  kind: 'SetSystemPromptTogglesRpc';
  sessionPath: string;
  disabledEntries: string[];
}

// ─── Phase 5 detail subscription effects ─────────────────────────────────────
// The EffectRunner mints the `subscriptionId` and routes each effect to the
// owning session service. All three are fire-and-forget: stream content
// reaches the webview as detail imperatives, never as *Result events, so the
// reducer stores no pages or stream state.

export interface DetailSubscribeRpcEffect extends EffectBase {
  kind: 'DetailSubscribeRpc';
  viewGeneration: number;
  detailKey: string;
  detailAttempt: number;
  address: LiveSubagentDetailAddress;
  cursor?: DetailCursor;
  rendererId?: string;
  rendererGeneration?: number;
}

export interface DetailUnsubscribeRpcEffect extends EffectBase {
  kind: 'DetailUnsubscribeRpc';
  viewGeneration: number;
  detailKey: string;
  detailAttempt: number;
  reason: 'collapse' | 'unmount' | 'session-change';
  rendererId?: string;
  rendererGeneration?: number;
}

export interface DetailFetchPagesRpcEffect extends EffectBase {
  kind: 'DetailFetchPagesRpc';
  viewGeneration: number;
  detailKey: string;
  detailAttempt: number;
  ref: DetailPageRef;
  rendererId?: string;
  rendererGeneration?: number;
}

/** Hydrate a session's model state from the backend (fire-and-forget; the
 *  service's dispatched SetModel/AvailableModelsChanged events apply the
 *  results, so this effect emits no *Result event). */
export interface HydrateModelEffect extends EffectBase {
  kind: 'HydrateModel';
  sessionPath: string;
  /** Captured by the pure reducer before the asynchronous requests start. */
  hydrationRevision?: number;
  modelWriteFence?: number;
}

// ─── Real side effects ────────────────────────────────────────────────────────

/** The precise shape of an imperative message posted to the webview.
 *
 *  Tightened from the original `{ type: string; ... }` so a missing `text`
 *  (the Phase 5.2 `sendRejected` bug) is a compile error rather than a runtime
 *  defect. Only one `PostImperative` emission exists today (`sendRejected`);
 *  if future emissions need additional imperative message types, extend this
 *  union with the corresponding `Extract<HostToWebviewMessage, { type: '...' }>`
 *  arm so the field shapes stay compiler-checked. */
export type PostImperativeMessage = Extract<HostToWebviewMessage, { type: 'sendRejected' }>;

/** Post an imperative message to the webview. */
export interface PostImperativeEffect extends EffectBase {
  kind: 'PostImperative';
  imperativeMessage: PostImperativeMessage;
}

// ─── FileOperation namespace ────────────────────────────────────────────────────

export interface FileDiffEffect extends EffectBase {
  kind: 'FileDiff';
  sessionPath: string;
  filePath: string;
  status: 'modified' | 'created' | 'deleted';
}

export interface FileRevertEffect extends EffectBase {
  kind: 'FileRevert';
  sessionPath: string;
  filePath: string;
  /** Trusted initiating renderer (browser server plan §9). */
  source?: RendererCommandContext;
}

export interface ExtensionUiResponseRpcEffect extends EffectBase {
  kind: 'ExtensionUiResponseRpc';
  sessionPath: string;
  response: import('../../shared/protocol').ExtensionUIResponsePayload;
}

export interface LoadOlderTranscriptEffect extends EffectBase {
  kind: 'LoadOlderTranscript';
  sessionPath: string;
}

export interface LoadNewerTranscriptEffect extends EffectBase {
  kind: 'LoadNewerTranscript';
  sessionPath: string;
}

export interface JumpToLatestTranscriptEffect extends EffectBase {
  kind: 'JumpToLatestTranscript';
  sessionPath: string;
}

export interface StartNewTaskEffect extends EffectBase {
  kind: 'StartNewTask';
  sessionPath: string;
}

export interface ContinueTaskEffect extends EffectBase {
  kind: 'ContinueTask';
  sessionPath: string;
}

export interface OpenFileInEditorEffect extends EffectBase {
  kind: 'OpenFileInEditor';
  sessionPath: string;
  filePath: string;
}

export interface OpenFileEffect extends EffectBase {
  kind: 'OpenFile';
  path: string;
}

export interface SetPruningSettingsEffect extends EffectBase {
  kind: 'SetPruningSettings';
  settings: Partial<import('../../shared/protocol').PruningSettings>;
}

export interface SetToolResultPruningSettingsEffect extends EffectBase {
  kind: 'SetToolResultPruningSettings';
  settings: Partial<import('../../shared/protocol').ToolResultPruningSettings>;
}

export interface SetSessionTitlesSettingsEffect extends EffectBase {
  kind: 'SetSessionTitlesSettings';
  settings: Partial<import('../../shared/protocol').SessionTitlesSettings>;
}

export interface CloseSessionEffect extends EffectBase {
  kind: 'CloseSession';
  sessionPath: string;
  operationId?: string;
  backendGeneration?: number;
  /** Private sessions must be forgotten instead of retained for reopening. */
  privacyMode?: boolean;
  /** The next tab to activate after closing, computed by the reducer via
   *  `getNextVisibleTabPathOnClose` (pure). null if no tabs remain. The runner
   *  uses this to decide whether to recursively `openSession(nextPath)` —
   *  only when nextPath is NOT already summarized/pending (the edge case where
   *  a tab is open but its session hasn't been loaded yet). */
  nextPath: string | null;
  /** Whether closing this tab changed the visual selection. */
  selectionChanged?: boolean;
}

export interface RestartBackendEffect extends EffectBase {
  kind: 'RestartBackend';
  operationId: string;
  backendGeneration: number;
}

export interface DuplicateSessionEffect extends EffectBase {
  kind: 'DuplicateSession';
  /** The pending session path the reducer optimistically opened (the copy). */
  sessionPath: string;
  /** The source session path for the backend `session.duplicate` RPC. */
  sourceSessionPath: string;
  /** Selection token (minted before the Command dispatched) for the backend
   *  `session.duplicate` RPC. */
  selectionToken: string;
  /** Stable host-generated identity reused across duplicate retries. */
  operationId?: string;
  /** Attempt fence for stale timeout/error settlement. */
  operationAttempt?: number;
  /** Backend generation whose process-scoped ledger owns the operation. */
  backendGeneration?: number;
}

export type Effect =
  | SendRpcEffect
  | ContinueRpcEffect
  | GenerateSessionTitleEffect
  | EditRpcEffect
  | ReplaceQueueRpcEffect
  | InterruptRpcEffect
  | RequestLiveTurnCheckpointEffect
  | CompactRpcEffect
  | ClearQueueRpcEffect
  | TruncateRpcEffect
  | OpenSessionEffect
  | ScheduleOpenSessionReconciliationEffect
  | RecoverOpenSessionEffect
  | CreateSessionEffect
  | NotifySessionViewedEffect
  | PersistTabsEffect
  | LogEffect
  | SetModelRpcEffect
  | SetPrefsRpcEffect
  | McpListRpcEffect
  | McpSetServerRpcEffect
  | McpSetSessionServerRpcEffect
  | SetPrivacyModeEffect
  | SetSystemPromptTogglesRpcEffect
  | DetailSubscribeRpcEffect
  | DetailUnsubscribeRpcEffect
  | DetailFetchPagesRpcEffect
  | ShowModelSwitchConfirmEffect
  | HydrateModelEffect
  | PostImperativeEffect
  | FileDiffEffect
  | FileRevertEffect






  | ExtensionUiResponseRpcEffect
  | LoadOlderTranscriptEffect
  | LoadNewerTranscriptEffect
  | JumpToLatestTranscriptEffect
  | StartNewTaskEffect
  | ContinueTaskEffect
  | OpenFileInEditorEffect
  | OpenFileEffect
  | SetPruningSettingsEffect
  | SetToolResultPruningSettingsEffect
  | SetSessionTitlesSettingsEffect
  | CloseSessionEffect
  | RestartBackendEffect
  | DuplicateSessionEffect
  | DrainPendingSendQueueEffect
  | DrainBackendReadyQueueEffect
  | DrainDeferredSetModelQueueEffect
  | StartBackendReadyWatchdogEffect
  | CancelBackendReadyWatchdogEffect
  | MarkPrepassSucceededEffect
  | ClearSendTimerEffect
  | ScheduleOperationReconciliationEffect
  | ReleaseOperationResourcesEffect
  | ClearLastCompactionEffect;

/**
 * Drain queued sends when a pending session path resolves to a real path.
 * The runner re-dispatches each entry as a `Send` Command with the resolved
 * session path. This effect carries the queue entries (the reducer has already
 * cleared them from `ArchState.pending.sendQueueBySession`); the runner never
 * reads ArchState.
 */
export interface DrainPendingSendQueueEffect extends EffectBase {
  kind: 'DrainPendingSendQueue';
  resolvedSessionPath: string;
  entries: PendingSendQueueEntry[];
}

/**
 * Drain all queued sends when the backend becomes ready. The runner
 * re-dispatches each entry as a `Send` Command with its own `sessionPath`.
 * The runner also clears the backend-ready watchdog timer (the drain implies
 * the backend is ready, so the timeout is no longer needed).
 */
export interface DrainBackendReadyQueueEffect extends EffectBase {
  kind: 'DrainBackendReadyQueue';
  entries: BackendReadyQueueEntry[];
}

/** Replay model/reasoning choices after a pending path resolves or the backend
 * becomes ready. Entries have already been removed from ArchState; the runner
 * re-dispatches ordinary SetModel commands against durable paths. */
export interface DrainDeferredSetModelQueueEffect extends EffectBase {
  kind: 'DrainDeferredSetModelQueue';
  entries: DeferredSetModelEntry[];
}

/** Expire a session's transient "Compacted" chip after a bounded TTL. The
 *  runner schedules a timer and dispatches `LastCompactionCleared` on fire. */
export interface ClearLastCompactionEffect extends EffectBase {
  kind: 'ClearLastCompaction';
  corrId: string;
  sessionPath: string;
  /** TTL in milliseconds before the chip disappears. */
  ttlMs: number;
}

/**
 * Start the 30s backend-ready watchdog timer. The runner no-ops if the timer
 * is already running. On fire, the runner dispatches `BackendReadyWatchdogFired`
 * → the reducer drops the queued messages + removes optimistic entries + sets
 * a notice.
 */
export interface StartBackendReadyWatchdogEffect extends EffectBase {
  kind: 'StartBackendReadyWatchdog';
  timeoutMs: number;
}

/**
 * Cancel the backend-ready watchdog timer (the queue was drained or emptied).
 */
export interface CancelBackendReadyWatchdogEffect extends EffectBase {
  kind: 'CancelBackendReadyWatchdog';
}

/**
 * Transition an in-flight send/edit from the pruning-prepass timeout window to
 * the model-start timeout window. Emitted when the backend's explicit
 * preflight-succeeded signal arrives, before the first assistant MessageStarted
 * commit point.
 */
export interface MarkPrepassSucceededEffect extends EffectBase {
  kind: 'MarkPrepassSucceeded';
  /** Registered operations carry immutable timer-event correlation so the
   * runner stores only the opaque TimerHandle. Absent for legacy callers. */
  operationId?: string;
  operationAttempt?: number;
  sessionPath?: string;
  backendGeneration?: number;
}

/**
 * Clear the post-ack send-timer for an in-flight send/edit. Emitted by the
 * reducer at the **commit point** (first `MessageStarted` for the `requestId`,
 * where `handleMessageStarted` also drops `pending.promoted[corrId]`) so the
 * `EffectRunner` cancels the send-timer that owns the pre-ack-to-first-delta
 * phase. Both the pre-ack `RequestTracker` timeout and this send-timer are
 * short-circuited by the same commit-point event, so they can never both fire
 * for one send. See `docs/STATE_CONTRACT.md` § Optimistic Reconciliation
 * "Timer ownership" (Brief B).
 */
export interface ClearSendTimerEffect extends EffectBase {
  kind: 'ClearSendTimer';
  /** Reducer-described user preference restoration; never retained in a
   * registered runner resource map. */
  restorePruningMode?: PruningMode;
}

/** Reducer-described bounded read-only ledger observation. The attempt and
 * delay are semantic policy; the runner owns only the scheduled timer and RPC. */
export interface ScheduleOperationReconciliationEffect extends EffectBase {
  kind: 'ScheduleOperationReconciliation';
  operationId: string;
  operationKind: 'message.send' | 'message.edit' | 'message.interrupt' | 'message.continue' | 'message.compact';
  sessionPath: string;
  backendGeneration: number;
  operationAttempt: number;
  reconciliationAttempt: number;
  delayMs: number;
}

/** Release opaque execution resources only after the reducer has decided the
 * operation no longer requires acknowledgement reconciliation or a barrier. */
export interface ReleaseOperationResourcesEffect extends EffectBase {
  kind: 'ReleaseOperationResources';
  operationId: string;
  operationAttempt: number;
  restorePruningMode?: PruningMode;
}

