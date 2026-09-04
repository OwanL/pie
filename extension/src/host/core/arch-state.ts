/**
 * State shape for the CQRS reducer — the single source of truth for all
 * application state. The pure reducer (`core/reducer.ts`) transitions this tree
 * via `Event`s and emits `Effect`s; the projection (`core/projection.ts`)
 * derives the `ViewState` the webview renders.
 *
 * Sub-state domains:
 * - **transcript**: Messages, tool calls, editing state, window metadata
 * - **sessions**: Session list, running states, active path, analytics
 * - **settings**: Model config, prefs, pruning, backend readiness, extensions
 * - **composer**: Pending inputs, run summaries
 * - **fileChanges**: File change entries per session
 * - **pending**: Optimistic ops, message aliases, turn tracking
 *
 * State-shape rule: keyed collections MUST use `Record<string, T>`,
 * never `Map`/`Set`.
 */

import type { SessionOperation, SessionOperationSource } from './operation-types.js';
import type {
  ChatMessage,
  SystemPromptEntry,
  TranscriptWindow,
  SessionSummary,
  SessionCatalogProgress,
  ModelSettings,
  ModelInfo,
  PruningSettings,
  PruningMode,
  SessionTitlesSettings,
  ToolResultPruningSettings,
  ContextWindowUsage,
  InitialContextEstimate,
  SessionAnalyticsFactors,
  RetryStatus,
  ChatPrefs,
  ExtensionInfo,
  McpServerInfo,
  ExtensionUIRequestPayload,
  FileChangeEntry,
  ComposerInput,
  ActiveRunSummary,
  UserContentPart,
  InlineEditDraft,
  LastCompactionSummary,
  OperationalIncident,
  SessionCapabilities,
  ThinkingLevel,
} from '../../shared/protocol';
import type { NoticeKind } from '../../shared/error-mapping.js';
import type { LivePipelineState, LiveTurnPhase } from '../../shared/live-pipeline-protocol.js';
import {
  DEFAULT_CHAT_PREFS,
  DEFAULT_PRUNING_SETTINGS,
  DEFAULT_SESSION_TITLES_SETTINGS,
  DEFAULT_TOOL_RESULT_PRUNING_SETTINGS,
} from '../../shared/protocol';
import { deriveBundledExtensions } from '../../shared/bundled-extensions.js';

// ---------------------------------------------------------------------------
// Transcript sub-state
// ---------------------------------------------------------------------------

/**
 * Per-session transcript data: messages, system prompts, window metadata,
 * and editing state.
 */
export interface TranscriptState {
  /** Chat messages keyed by session path. */
  bySession: Record<string, ChatMessage[]>;
  /** System prompts keyed by session path. */
  systemPromptsBySession: Record<string, SystemPromptEntry[]>;
  /** Transcript window (scroll/pagination state) keyed by session path. */
  windowBySession: Record<string, TranscriptWindow>;
  /** Whole-branch accounting, retained independently of bounded transcript windows. */
  sessionUsageBySession?: Record<string, import('../../shared/protocol').SessionUsageSnapshot>;
  /** Per-session message ID currently being edited. */
  editingMessageIdBySession: Record<string, string | null>;
  /** Submitted content for an inline editor reopened after an edit rollback. */
  editingDraftBySession: Record<string, InlineEditDraft | null>;
  /** Latest authoritative replacement deferred because it omitted the row
   * whose inline editor still owns an uncommitted webview-local draft. */
  deferredWindowReplacementBySession: Record<string, {
    transcript: ChatMessage[];
    transcriptWindow: TranscriptWindow;
  }>;
  /**
   * Per-session corrId of the in-flight transcript paging request
   * (loadOlder/loadNewer/jumpToLatest), or absent when none is in flight.
   * Reducer-owned in-flight guard (moved from the host-side Set on
   * SessionMessageActions); keyed by corrId for request-identity, consistent
   * with send/edit PendingOp correlation. Cleared by the matching *Result
   * (or SessionScopeCleared on tab close).
   */
  pagingInFlightBySession: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Sessions sub-state
// ---------------------------------------------------------------------------

export interface SessionTitleGenerationState {
  status: 'armed' | 'pending' | 'failed';
  /** First user prompt sent to the dedicated title model. */
  prompt: string;
  /** Correlation of the send that started generation. */
  corrId?: string;
}

/**
 * Session list, tab state, running/busy state, analytics per session.
 */
export interface SessionsState {
  /** Known session summaries. */
  sessions: SessionSummary[];
  /** Completeness of the durable catalog that supplied `sessions`. */
  sessionCatalogProgress: SessionCatalogProgress;
  /** Open tab paths (preserves order; pinned tabs form the leading prefix). */
  openTabPaths: string[];
  /** Pinned tab paths (browser-style: clustered at the far left, icon-only). */
  pinnedTabPaths: string[];
  /** Pinned-session groups (Discord-style clustering). Each inner array is an
   *  unnamed group of pinned tab paths in insertion order; any member path
   *  identifies its group. Groups ⊆ `pinnedTabPaths`, a path is in at most one
   *  group, a group's members are contiguous in `pinnedTabPaths` (in group
   *  order), and groups with < 2 members are dissolved. Persisted to
   *  globalState alongside `pinnedTabPaths`. */
  pinnedTabGroups: string[][];
  /** Session paths with any backend-authoritative billable activity. */
  runningSessionPaths: string[];
  /** Backend/host-authoritative capabilities keyed by durable session path. */
  capabilitiesBySession: Record<string, SessionCapabilities>;
  /** Exact latest correlated settlement lineage retained after live/current-turn
   * records clear, so an older terminal from the same worker cannot restore
   * stale capabilities. */
  settlementGenerationBySession: Record<string, {
    backendGeneration?: number;
    workerGeneration: number;
    operationId?: string;
    requestId?: string;
    turnId?: string;
    attemptId?: string;
    operationAttempt?: number;
  }>;
  /** Session paths currently running a history-compaction (`/compact`) LLM
   *  call. Always a subset of `runningSessionPaths` (the backend re-arms busy
   *  while compacting); tracked separately so the UI can show a live
   *  "Compacting…" indicator instead of a generic busy state. */
  compactingSessionPaths: string[];
  /** Most recent completed compaction per session (absent entry = none since
   *  host start). Drives the transient "Compacted · freed N tokens" chip;
   *  entries expire via the `ClearLastCompaction` effect. */
  lastCompactionBySession: Record<string, LastCompactionSummary | null>;
  /** Sessions that finished while not the active tab. */
  unreadFinishedSessionPaths: string[];
  /** Currently viewed session path. */
  activeSessionPath: string | null;
  /** Workspace root directory. */
  workspaceCwd: string | null;
  /** Per-session analytics factors (used for pruning catalog). */
  analyticsFactorsBySession: Record<string, SessionAnalyticsFactors | null>;
  /** Session-scoped privacy mode. Only the path marker is persisted so a host
   *  restart cannot reopen a private session as ordinary; transcript/content is
   *  never persisted through this field and the marker is removed on close. */
  privacyModeBySession: Record<string, boolean>;
  /** Host-owned async title lifecycle. Only `pending` paths render a spinner. */
  titleGenerationBySession: Record<string, SessionTitleGenerationState>;
  /** Per-session live auto-retry status (absent entry = no retry in flight).
   *  Driven by the SDK's `auto_retry_start` / `auto_retry_end` events; surfaced
   *  to the webview as a "Retrying N of M…" chip with a Cancel button.
   *  Independent of `runningSessionPaths` (a retry sleeps between turns and the
   *  `willRetry` gate on `agent_end` keeps `busy` true throughout). */
  retryStatusBySession: Record<string, RetryStatus>;
  /** Running session paths whose tab was intentionally hidden by an explicit
   *  close. This covers ordinary user closes and V2 review closure actions
   *  (closeReviewed/closeSelf); the durable review outbox reason remains on
   *  the close command, while this host-owned intent controls renderer recovery.
   *  Host-owned so it survives webview reloads; pruned when a path is reopened
   *  or no longer running. */
  intentionallyHiddenRunningPaths: string[];
}

// ---------------------------------------------------------------------------
// Settings sub-state
// ---------------------------------------------------------------------------

/**
 * Configuration, preferences, backend readiness, and extension state.
 * Merges the former settings-slice and ui-slice.
 */
export interface SettingsState {
  /** Active model settings (default model, thinking level). */
  modelSettings: ModelSettings | null;
  /** Pruning configuration. */
  pruningSettings: PruningSettings;
  /** Tool-result pruning configuration (settings.json `toolResultPruning` block). */
  toolResultPruningSettings: ToolResultPruningSettings;
  /** Optional LLM session-title generation policy (settings.json `sessionTitles` block). */
  sessionTitlesSettings: SessionTitlesSettings;
  /** Available models per session. */
  availableModelsBySession: Record<string, ModelInfo[]>;
  /** Whether a per-session model catalog is provisional while a durable path is
   *  being resolved or metadata is loading. This is host-only state; the picker
   *  continues to render the retained catalog rather than flashing empty. */
  availableModelsStatusBySession: Record<string, 'provisional' | 'loading' | 'authoritative'>;
  /** Backend generation associated with the newest accepted model hydration. */
  modelBackendGeneration: number;
  /** Monotonic hydration command revision, used to fence out-of-order results. */
  modelHydrationRevision: number;
  /** Monotonic optimistic model-write fence. Hydration started before this
   *  fence cannot overwrite the user's model choice or its known capabilities. */
  modelWriteFence: number;
  /** Last accepted hydration revision per stable session path. */
  modelHydrationRevisionBySession: Record<string, number>;
  /** Context window usage per session. */
  contextUsageBySession: Record<string, ContextWindowUsage | null>;
  /** Fresh cold empty-session inventory estimates. Hot runtime/provider state
   * clears these rather than treating them as measured usage. */
  initialContextEstimateBySession: Record<string, InitialContextEstimate | null>;
  /** Whether the PI backend is connected and ready. */
  backendReady: boolean;
  /** User-facing notice message (short summary), or null. */
  notice: string | null;
  /** Failure category for the current notice (Brief H), or null when the
   *  notice is a plain info/warning string (or absent). Set alongside a
   *  plain-language `notice` at the send/edit/prepass failure sites; the
   *  projection surfaces it as `ViewState.noticeKind` so the webview can
   *  render recovery action buttons. Invariant: non-null only when `notice`
   *  is an H-category error. */
  noticeKind: NoticeKind | null;
  /** Full host-side error string behind the current `notice` summary, or null.
   *  The projection redacts credentials and internal `req-NN` correlation ids
   *  before exposing `ViewState.noticeRaw`; the host retains this detail for
   *  logs. Cleared alongside `notice`/`noticeKind` whenever a notice is
   *  dismissed or replaced by a non-error notice. */
  noticeRaw: string | null;
  /** Session that owns the current notice, or null for a truly global notice.
   * Session-owned notices are projected only while their session is active so
   * a background failure cannot offer recovery actions against another chat. */
  noticeSessionPath: string | null;
  /** Complete host-only identity and recovery authority for the latest typed
   * incident. Identity/detail are never projected to a renderer. */
  latestIncident: OperationalIncident | null;
  /** Chat display preferences. */
  prefs: ChatPrefs;
  /** Configured MCP servers with their effective disabled state, fetched from
   *  the backend (`mcp.list`) on demand and after every toggle. Empty while
   *  not yet fetched or when no servers are configured. */
  mcpServers: McpServerInfo[];
  /** Discovery state of `mcpServers`: 'loading' while a fetch is in flight
   *  (or before the first fetch), 'error' after a failed fetch (cached rows
   *  stay visible), 'ok' after a successful fetch. */
  mcpServersStatus: 'loading' | 'error' | 'ok';
  /** True after a per-server toggle wrote a `.pi/mcp.json` override that the
   *  adapter has not re-read yet (applies on the next session reload /
   *  backend restart). Preserved by list reads and no-op toggles; cleared
   *  when the backend restarts (the adapter re-reads config on the next
   *  session start). */
  mcpPendingApply: boolean;
  /** Per-session MCP server overrides (session path → server name →
   *  disabled-for-this-session). Host memory; the backend mirrors the set
   *  into the session's `--mcp-config` artifact on every write and recycles
   *  the session's worker when idle so the adapter applies it at the next
   *  session start. Never touches the global `.pi/mcp.json` layer. */
  mcpSessionOverridesBySession: Record<string, Record<string, boolean>>;
  /** Per-session pending-apply: a session-scoped toggle whose worker recycle
   *  was refused (session busy / transitioning). Retried on the next
   *  `BusyChanged(false)`; the override always applies at the next session
   *  reload regardless. */
  mcpPendingApplyBySession: Record<string, boolean>;
  /** Extensions that provide tool integrations. */
  availableExtensions: ExtensionInfo[];
  /** Per-session pending extension UI requests, keyed by request ID (ask-user inline choices). */
  pendingExtensionUIRequestsBySession: Record<string, Record<string, ExtensionUIRequestPayload>>;
}

// ---------------------------------------------------------------------------
// Composer sub-state
// ---------------------------------------------------------------------------

/**
 * Per-session composer state: pending inputs and run summaries.
 */
export interface ComposerState {
  /** Pending file/image inputs per session, awaiting send. */
  pendingComposerInputsBySession: Record<string, ComposerInput[]>;
  /** Active run summary per session (for analytics export). */
  activeRunSummaryBySession: Record<string, ActiveRunSummary | null>;
  /** Draft composer text per session, persisted across reloads and session switches. */
  draftTextBySession: Record<string, string>;
}

// ---------------------------------------------------------------------------
// File changes sub-state
// ---------------------------------------------------------------------------

/**
 * Per-session file change entries derived from tool calls.
 */
export interface FileChangesState {
  /** File change entries keyed by session path. */
  bySession: Record<string, FileChangeEntry[]>;
  /** Whether the file-changes rail drawer is expanded per session. */
  expandedBySession: Record<string, boolean>;
  /**
   * Paths of changed files the user has marked as read, keyed by session path.
   * Independent of `bySession` so re-derivation (FileChangesUpdated, which
   * wholesale-replaces `bySession`) never clobbers read state. A new
   * tool-call modification of an already-read path removes it from here
   * (email-like: new changes = something new to review) inside
   * `handleFileChangesUpdated`. Cleared alongside the other per-session maps
   * on session close (cleanup parity).
   */
  readFilePathsBySession: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Pending / optimistic sub-state
// ---------------------------------------------------------------------------

/** Tracks an in-flight optimistic send or edit for rollback on failure. */
export interface PendingOp {
  kind: 'send' | 'edit';
  /** Stable mutation identity for sends; edit migration remains separate. */
  operationId?: string;
  /** Latest transport attempt that owns this rollback snapshot. */
  operationAttempt?: number;
  sessionPath: string;
  /** The local transcript entry ID inserted optimistically. */
  localId: string;
  /** Session summary snapshot before optimistic name change (null = no change). */
  previousSummary: SessionSummary | null;
  /** The raw user text sent (for send ops only — used to restore the draft on sendRejected). */
  text?: string;
  /** Composer inputs captured at Send command time (from
   *  `pendingComposerInputsBySession[sessionPath]`), carried onto the
   *  promoted snapshot so a post-ack `PreflightFailed` can restore them.
   *  Populated for send ops by Brief A; the webview `sendRejected.inputs`
   *  restore is wired by Brief C. */
  inputs?: ComposerInput[];
  /** Backend-assigned request ID, stamped when a send is promoted
   *  (`SendResult{ok:true}`) so a post-ack `PreflightFailed` (which carries
   *  requestId but not corrId — the backend never sees the host corrId) and
   *  the commit-point `MessageStarted` can resolve corrId without a reverse
   *  map. Absent pre-ack (the host learns requestId only on `SendResult`). */
  requestId?: string;
  /** Wall-clock start time (ms epoch) captured from the `Send`/`Edit`
   *  Command's `timestamp` at command time — PURE (not a reducer wall-clock
   *  read: STATE_CONTRACT § Reducer Purity). Carried onto the promoted op (via the
   *  `SendResult{ok:true}` spread) so the projection can read it while the
   *  prepass runs. Brief F's `prepassStartedAt` ViewState field is the active
   *  session's promoted op `startedAt` (null when no promoted op exists). */
  startedAt: number;
  /** Steering (FollowUp): true when this send was issued while a turn was
   *  already running, so the backend queued it as a follow-up (`message.send`
   *  acked `{ queued: true }`). Set by `handleSend`'s busy branch. The `!ok`
   *  rollback uses this to avoid clearing `runningSessionPaths` (the session is
   *  still running the original turn, not this queued send). The ok-path uses
   *  `SendResult.queued` (authoritative backend ack) to reconcile the
   *  optimistic message status. */
  queued?: boolean;
  /** Reducer-owned restoration intent for retry-without-pruning. The runner
   * receives it only on a terminal/commit cleanup effect and never stores it. */
  priorPruningMode?: PruningMode;
  /** Transcript messages removed by an optimistic edit so rollback handlers can
   *  restore the pre-edit tail if preflight or commit fails. */
  removedTail?: ChatMessage[];
  /** Submitted inline-editor content retained exclusively for edit rollback. */
  editDraft?: InlineEditDraft;
}

/** The pruning prepass phase for a session, surfaced as the live/cancelable
 *  prepass status chip (Brief F). Driven by the existing send lifecycle
 *  signals — `pending.promoted` (running), the pruning-result `CustomMessage`
 *  (succeeded), `PreflightFailed` (failed), and the commit-point
 *  `MessageStarted` (idle) — NOT a redefined signal source.
 *
 *  `startedAt` lives on the `PendingOp` (captured from the command timestamp,
 *  pure) and is read from the promoted op by the projection; this record only
 *  disambiguates the terminal phases (`succeeded` within the promoted window,
 *  `failed` after the promoted op is dropped) and carries the post-hoc latency
 *  for the high-latency hint. An absent entry means `idle`. */
export interface PrepassPhaseState {
  phase: 'running' | 'succeeded' | 'failed';
  /** Prepass LLM latency (ms) from the pruning-result `CustomMessage`'s
   *  `PruningDetails.prepassLatencyMs`, surfaced for the post-hoc summary. */
  latencyMs: number | null;
}

/** Snapshot of the state an optimistic `SetModel` changed, for rollback when
 *  the backend `settings.set` fails. Every field the reducer flipped is
 *  captured here so revert restores exactly the pre-change state (the
 *  optimistic apply must match the disk write field-for-field; see STATE_CONTRACT
 *  § Optimistic Reconciliation).
 *
 *  `undefined` vs `null` distinguishes "key absent" (delete on revert) from
 *  "key present with a null value" (set null on revert) for the two Record
 *  fields (`contextUsageBySession`, `pendingComposerInputsBySession`). */
export interface SetModelSnapshot {
  previousModelSettings: ModelSettings | null;
  previousSummary: SessionSummary | null;
  previousContextUsage: ContextWindowUsage | null | undefined;
  previousPendingInputs: ComposerInput[] | undefined;
}

/** Tracks an in-flight `SetModel` lifecycle keyed by `corrId`.
 *
 *  Two phases share one entry:
 *  - `snapshot === null` — awaiting the user's modal confirmation (only when
 *    the switch would drop pending image inputs). No state has changed yet, so
 *    there is nothing to roll back; the entry just holds the stashed intent.
 *  - `snapshot !== null` — the optimistic apply has happened and the backend
 *    `SetModelRpc` is in flight; `SetModelResult{ok:false}` reverts via the
 *    snapshot, `{ok:true}` drops the entry. */
export interface SetModelPending {
  sessionPath: string;
  modelSettings: ModelSettings;
  snapshot: SetModelSnapshot | null;
}

/** Latest model/reasoning choice made while its durable target is not yet
 * writable (a pending create/duplicate path, or a temporarily unavailable
 * backend). The host updates the visible session badge immediately, then
 * restores this baseline and replays the choice through the normal optimistic
 * SetModel lifecycle once the target becomes writable. */
export interface DeferredSetModelEntry {
  corrId: string;
  sessionPath: string;
  modelSettings: ModelSettings;
  clearImages: boolean;
  /** Monotonic click order across sessions, used to replay global settings
   * writes deterministically after backend recovery. */
  sequence: number;
  previousModelId?: string;
  previousProvider?: string;
  previousThinkingLevel?: ThinkingLevel;
}

/** Tracks the first message of the active streaming turn per session. */
export interface CurrentTurn {
  requestId: string;
  firstMessageId: string;
  /** Cached array index of the streaming (active-turn) message, set on
   *  MessageStarted so per-delta handlers can look it up in O(1) instead of
   *  an O(n) find through the Immer draft. Validated by an id check on use,
   *  so a stale value (cull, cleared turn, etc.) safely falls back to find. */
  firstMessageIndex?: number;
}

/**
 * A send queued while the target session was still a pending tab (backend
 * `session.create` in flight). The reducer queues the `Send` Command's payload
 * here instead of emitting `SendRpc`; when `PendingPathReplaced` resolves the
 * pending path, the reducer emits a `DrainPendingSendQueue` effect carrying
 * these entries, and the runner re-dispatches them as `Send` Commands with the
 * resolved session path.
 *
 * `previousSummary` is intentionally `null` — the optimistic session-name
 * derivation already happened via `SessionNameDerived` at enqueue time, and by
 * drain time the session has a real summary from `session.opened`. A non-null
 * `previousSummary` here would revert the name to the placeholder on a
 * `SendResult{ok:false}`, clobbering the real name.
 */
export interface PendingSendQueueEntry {
  corrId: string;
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  backendGeneration?: number;
  text: string;
  inputs: ComposerInput[];
  composedText: string;
  localId: string;
  userParts?: UserContentPart[];
  previousSummary: SessionSummary | null;
  timestamp: number;
  /** Brief H: prior pruning mode to restore after a "retry without pruning" send
   *  resolves. Threads through the queue so a retry queued while a pending tab
   *  resolves (or the backend is not ready) still restores pruning when the
   *  re-dispatched send commits/fails. */
  priorPruningMode?: PruningMode;
}

/**
 * A send queued while the backend was not yet ready. The reducer queues the
 * `Send` Command's payload here instead of emitting `SendRpc`; when
 * `BackendReadyChanged{ready:true}` fires, the reducer emits a
 * `DrainBackendReadyQueue` effect carrying all entries across all sessions,
 * and the runner re-dispatches them as `Send` Commands. A 30s watchdog effect
 * is started when the first send is queued; if the backend doesn't become
 * ready in time, the runner dispatches `BackendReadyWatchdogFired` and the
 * reducer drops the queued messages + removes the optimistic entries + sets a
 * notice.
 *
 * Unlike `PendingSendQueueEntry`, this type carries `sessionPath` because the
 * backend-ready queue spans multiple sessions (the drain re-dispatches each
 * entry to its own session).
 */
export interface BackendReadyQueueEntry {
  sessionPath: string;
  corrId: string;
  operationId?: string;
  operationAttempt?: number;
  operationSource?: SessionOperationSource;
  backendGeneration?: number;
  text: string;
  inputs: ComposerInput[];
  composedText: string;
  localId: string;
  userParts?: UserContentPart[];
  previousSummary: SessionSummary | null;
  timestamp: number;
  /** Brief H: prior pruning mode to restore after a "retry without pruning"
   *  send resolves — threaded through the backend-ready queue for the same
   *  reason as `PendingSendQueueEntry.priorPruningMode`. */
  priorPruningMode?: PruningMode;
}

/**
 * Optimistic operations, message aliases, and turn tracking.
 * This sub-state is only touched by the reducer — never by the webview.
 */
export interface PendingState {
  /** Optimistic pending operations keyed by `corrId` (pre-ack). */
  ops: Record<string, PendingOp>;
  /** Promoted (early-acked) sends awaiting their commit point, keyed by
   *  `corrId`. On `SendResult{ok:true}` the rollback snapshot MOVES here from
   *  `ops` (it is NOT deleted) so a post-ack prepass failure
   *  (`PreflightFailed`) can still roll back. Dropped at the commit point
   *  (first `MessageStarted` for the requestId) — a later failure then becomes
   *  an in-turn error, never a rollback. See `docs/STATE_CONTRACT.md` §
   *  Optimistic Reconciliation "Two failure windows for send". */
  promoted: Record<string, PendingOp>;
  /** In-flight `SetModel` lifecycles keyed by `corrId` (modal-confirm + RPC). */
  setModelByCorrId: Record<string, SetModelPending>;
  /** Latest deferred model/reasoning choice per temporarily unwritable session. */
  deferredSetModelBySession: Record<string, DeferredSetModelEntry>;
  /** Monotonic sequence assigned to deferred model picker choices. */
  deferredSetModelSequence: number;
  /** corrId currently replaying; later choices wait so global rollback remains ordered. */
  deferredSetModelInFlightCorrId: string | null;
  /** Durable session whose deferred choice is currently replaying. */
  deferredSetModelInFlightSessionPath: string | null;
  /** Optimistically answered extension UI requests, restored if RPC fails. */
  extensionUiResponseByCorrId: Record<string, {
    sessionPath: string;
    request: ExtensionUIRequestPayload;
    priorPhase?: LiveTurnPhase;
  }>;
  /** Maps aliased message IDs to { canonicalId, sessionPath } (for multi-turn continuations). */
  messageIdAlias: Record<string, { canonicalId: string; sessionPath: string }>;
  /** Tracks the first message of the current streaming turn per session. */
  currentTurnBySession: Record<string, CurrentTurn>;
  /** Maps backend request IDs to optimistic local message IDs for ID finalization. */
  requestIdToLocalId: Record<string, { sessionPath: string; localId: string }>;
  /** Sends queued while the target session was a pending tab, keyed by pending path. */
  sendQueueBySession: Record<string, PendingSendQueueEntry[]>;
  /** Sends queued while the backend was not yet ready, keyed by session path. */
  backendReadyQueueBySession: Record<string, BackendReadyQueueEntry[]>;
  /** Per-session pruning prepass phase for the live status chip (Brief F).
   *  Absent entry = `idle`. See {@link PrepassPhaseState}. */
  prepassBySession: Record<string, PrepassPhaseState>;
}

// ---------------------------------------------------------------------------
// Top-level ArchState (target shape — expanded during cutover)
// ---------------------------------------------------------------------------

/**
 * All application state in a single tree. Each sub-state is a cohesive
 * domain with its own set of reducer handlers.
 *
 * The projection function `selectViewState(ArchState) → ViewState`
 * derives what the webview sees from this tree.
 *
 * State-shape rule (binding): keyed collections MUST use `Record<string, T>`,
 * never `Map`/`Set` — see `docs/STATE_CONTRACT.md`.
 */
export interface ArchState {
  transcript: TranscriptState;
  sessions: SessionsState;
  settings: SettingsState;
  composer: ComposerState;
  fileChanges: FileChangesState;
  pending: PendingState;
  /** Common reducer-owned semantic operation registry, keyed by stable ID. */
  operations: Record<string, SessionOperation>;
  /** Canonical host authority for active turn/tool work. */
  livePipeline: LivePipelineState;
}

/** Returns a fresh `ArchState` with all sub-states at their defaults. */
export function createInitialArchState(): ArchState {
  return {
    transcript: {
      bySession: {},
      systemPromptsBySession: {},
      windowBySession: {},
      sessionUsageBySession: {},
      editingMessageIdBySession: {},
      editingDraftBySession: {},
      deferredWindowReplacementBySession: {},
      pagingInFlightBySession: {},
    },
    sessions: {
      sessions: [],
      sessionCatalogProgress: { complete: true, processed: 0, total: 0 },
      openTabPaths: [],
      pinnedTabPaths: [],
      pinnedTabGroups: [],
      runningSessionPaths: [],
      capabilitiesBySession: {},
      settlementGenerationBySession: {},
      compactingSessionPaths: [],
      lastCompactionBySession: {},
      unreadFinishedSessionPaths: [],
      activeSessionPath: null,
      workspaceCwd: null,
      analyticsFactorsBySession: {},
      privacyModeBySession: {},
      titleGenerationBySession: {},
      retryStatusBySession: {},
      intentionallyHiddenRunningPaths: [],
    },
    settings: {
      modelSettings: null,
      pruningSettings: { ...DEFAULT_PRUNING_SETTINGS },
      toolResultPruningSettings: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS, rules: { ...DEFAULT_TOOL_RESULT_PRUNING_SETTINGS.rules } },
      sessionTitlesSettings: { ...DEFAULT_SESSION_TITLES_SETTINGS },
      availableModelsBySession: {},
      availableModelsStatusBySession: {},
      modelBackendGeneration: 0,
      modelHydrationRevision: 0,
      modelWriteFence: 0,
      modelHydrationRevisionBySession: {},
      contextUsageBySession: {},
      initialContextEstimateBySession: {},
      backendReady: false,
      notice: null,
      noticeKind: null,
      noticeRaw: null,
      noticeSessionPath: null,
      latestIncident: null,
      prefs: { ...DEFAULT_CHAT_PREFS },
      mcpServers: [],
      mcpServersStatus: 'loading',
      mcpPendingApply: false,
      mcpSessionOverridesBySession: {},
      mcpPendingApplyBySession: {},
      availableExtensions: deriveBundledExtensions(),
      pendingExtensionUIRequestsBySession: {},
    },
    composer: {
      pendingComposerInputsBySession: {},
      activeRunSummaryBySession: {},
      draftTextBySession: {},
    },
    fileChanges: {
      bySession: {},
      expandedBySession: {},
      readFilePathsBySession: {},
    },
    operations: {},
    livePipeline: {
      turnsBySession: {},
      toolsByExecutionId: {},
      pendingOwnerEvents: {},
      terminalAttempts: {},
      revisionBySession: {},
    },
    pending: {
      ops: {},
      promoted: {},
      setModelByCorrId: {},
      deferredSetModelBySession: {},
      deferredSetModelSequence: 0,
      deferredSetModelInFlightCorrId: null,
      deferredSetModelInFlightSessionPath: null,
      extensionUiResponseByCorrId: {},
      messageIdAlias: {},
      currentTurnBySession: {},
      requestIdToLocalId: {},
      sendQueueBySession: {},
      backendReadyQueueBySession: {},
      prepassBySession: {},
    },
  };
}
