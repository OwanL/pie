/**
 * Single host-side effect executor façade.
 *
 * The runner routes every reducer-described effect without inspecting
 * `ArchState`. Session-operation RPCs delegate to one controller that owns
 * only non-serializable execution and correlation resources; lifecycle phase,
 * commit evidence, recovery, and outcomes remain reducer-owned. Other effects
 * retain their established lifecycle, session, persistence, or direct lanes.
 * Result dispatch stays asynchronous so reducer effect chains cannot block
 * re-entrantly.
 */

import type {
  Effect,
  ReplaceQueueRpcEffect,
  RequestLiveTurnCheckpointEffect,
  ClearQueueRpcEffect,
  TruncateRpcEffect,
  ExtensionUiResponseRpcEffect,
  ShowModelSwitchConfirmEffect,
  SetModelRpcEffect,
  SetPrefsRpcEffect,
  McpListRpcEffect,
  McpSetServerRpcEffect,
  McpSetSessionServerRpcEffect,
  SetSystemPromptTogglesRpcEffect,
  DetailSubscribeRpcEffect,
  DetailUnsubscribeRpcEffect,
  DetailFetchPagesRpcEffect,
  FileRevertEffect,
  HydrateModelEffect,
  LogEffect,
  PostImperativeEffect,
  OpenFileEffect,
  DrainPendingSendQueueEffect,
  DrainBackendReadyQueueEffect,
  DrainDeferredSetModelQueueEffect,
  StartBackendReadyWatchdogEffect,
  CancelBackendReadyWatchdogEffect,
  ClearLastCompactionEffect,
  PersistTabsEffect,
  PostImperativeMessage,
} from './effects';
import { toErrorMessage } from '../util/error-message';
import type { EffectResultEvent, CommandEvent } from './events';
import type { FileDiffService } from './file-diff-service';
import type { ChatPrefs, ComposerInput, McpServerInfo, ProviderGateStats, PruningSettings, SessionTitlesSettings, ToolResultPruningSettings, ThinkingLevel } from '../../shared/protocol';
import type { LiveSubagentDetailAddress, DetailCursor, DetailPageRef } from '../../shared/protocol/subagent-detail';
import { RequestTimeoutError } from '../../shared/request-tracker';
import type { LiveLifecycleWatermark, LiveTurnCheckpoint } from '../../shared/live-pipeline-protocol';
import { isLivePipelineTraceEnabled, recordLivePipelineTrace } from '../util/live-pipeline-trace-runtime.js';
import {
  SessionOperationEffectController,
  type CommitAwareRequestOptions,
} from './session-operation-effect-controller';

export {
  decideModelStartTimerAction,
  type CommitAwareRequestOptions,
  type CorrelatedBackendResponse,
} from './session-operation-effect-controller';

export interface BackendLike {
  /** Issue a JSON-RPC request. `options.timeoutMs` overrides the method
   * default; `options.signal` lets reducer-described interruption cancel a
   * request that has not crossed its acknowledgement boundary. */
  request<T = unknown>(method: string, params?: unknown, options?: CommitAwareRequestOptions<T>): Promise<T>;
}

/**
 * The two queues that exist today on `SessionServiceState`. We inject them as
 * functions rather than the full state object so tests can pass spies and
 * future refactors can move queue ownership without touching the runner.
 */
export interface QueueRouter {
  enqueueLifecycle<T>(task: () => Promise<T>): Promise<T>;
  enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T>;
}

/**
 * Persistence sink for `PersistTabs`. Matches the relevant slice of the
 * existing `globalState`-backed tab persistence helper.
 */
export interface TabPersistenceSink {
  persistTabs(openTabPaths: string[], activeSessionPath: string | null, pinnedTabPaths: string[], pinnedTabGroups: string[][], privateSessionPaths?: string[]): Promise<void>;
}

/** Logger sink for `Log`. Matches the audit-log surface used elsewhere. */
export interface LogSink {
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
}

/** Callback for posting imperative messages to the webview. */
export interface PostImperativeSink {
  postImperative(message: PostImperativeMessage): void;
}

/** Sink for modal user-confirmation dialogs (VS Code `showWarningMessage`).
 *  `showWarningModal` resolves to the chosen button label, or `undefined` if
 *  the user dismisses the dialog. Returns `PromiseLike` (VS Code's
 *  `showWarningMessage` yields a `Thenable`, which is a `PromiseLike`); `await`
 *  accepts it and both real Promises and Thenables satisfy the type. */
export interface ModalSink {
  showWarningModal(message: string, confirmChoice: string): PromiseLike<string | undefined>;
}

export interface SessionServiceLike {
  hydrateModelState(sessionPath: string, metadata?: {
    hydrationRevision?: number;
    modelWriteFence?: number;
  }): Promise<void>;
  setPrefs(prefs: Partial<ChatPrefs>): Promise<void>;
  /** Re-read the effective MCP server config from the backend. */
  mcpList(sessionPath?: string): Promise<{ servers: McpServerInfo[]; sessionOverrides?: Record<string, boolean> }>;
  /** Persist a per-server `disabled` override; resolves with the fresh list
   *  and whether the override actually changed. */
  mcpSetServerEnabled(name: string, enabled: boolean): Promise<{ servers: McpServerInfo[]; changed: boolean }>;
  /** Write a session's full per-server override set and optionally recycle
   *  that session's worker. resolves with whether the recycle happened. */
  mcpSetSessionServerEnabled(sessionPath: string, overrides: Record<string, boolean>, recycle: boolean): Promise<{ recycled: boolean; overrides: Record<string, boolean> }>;
  /** Push the complete disabled-entry set for a session's system prompts to the
   *  backend (`systemPromptToggles.set`). Fire-and-forget: the backend re-emits
   *  `session.opened` to update host state, so no *Result event is expected. */
  setSystemPromptToggles(sessionPath: string, disabledEntries: readonly string[]): Promise<void>;
  /** Subscribe a renderer-owned detail key. The runner mints the
   *  `subscriptionId`; the service records the exact owner and routes the
   *  coordinator's stream imperatives for it. Fire-and-forget: failures
   *  surface as `detail.error` imperatives, not *Result events. */
  subscribeDetail(options: {
    subscriptionId: string;
    viewGeneration: number;
    detailKey: string;
    detailAttempt: number;
    address: LiveSubagentDetailAddress;
    cursor?: DetailCursor;
    rendererId?: string;
    rendererGeneration?: number;
  }): void;
  /** Discard the owner for a detail key, tombstone its subscription,
   *  and notify the backend best-effort. */
  unsubscribeDetail(options: {
    viewGeneration: number;
    detailKey: string;
    detailAttempt: number;
    reason: 'collapse' | 'unmount' | 'session-change';
    rendererId?: string;
    rendererGeneration?: number;
  }): void;
  /** Refetch a page of the active baseline for a subscribed key. */
  fetchDetailPages(options: {
    viewGeneration: number;
    detailKey: string;
    detailAttempt: number;
    ref: DetailPageRef;
    rendererId?: string;
    rendererGeneration?: number;
  }): void;
  bumpSessionDataEpoch(sessionPath: string): void;
  /** Current-generation runtime readiness. Cold sends receive only the service
   * initialization acknowledgement budget; hot sends retain the short guard. */
  isSessionRuntimeReady?(sessionPath: string): boolean;
  /** Notify the run-analytics observer that a session's model config changed
   *  (disk-persisting side effect, not ArchState). Effect-side concern. */
  onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: ThinkingLevel, provider?: string): void;
  suppressNextCompletionNotificationFor(sessionPath: string): void;
  loadOlderTranscript(sessionPath: string): Promise<void>;
  loadNewerTranscript(sessionPath: string): Promise<void>;
  jumpToLatestTranscript(sessionPath: string): Promise<void>;
  closeSession(
    sessionPath: string,
    nextPath: string | null,
    privacyMode?: boolean,
    selectionChanged?: boolean,
    operationId?: string,
    backendGeneration?: number,
  ): Promise<void>;
  /** Restart transport/runtime and report the exact old-process death boundary. */
  restart?(onOldGenerationDeathConfirmed?: () => void): Promise<void>;
  setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
  setToolResultPruningSettings(updates: Partial<ToolResultPruningSettings>): Promise<void>;
  setSessionTitlesSettings(updates: Partial<SessionTitlesSettings>): Promise<void>;
  /** Recover from a failed/timed-out selection: finish the request and
   *  dispatch the reducer transitions that undo the optimistic tab setup
   *  (CloseTab / SelectSession-fallback / SessionScopeCleared / NoticeShown). */
  handleSelectionFailure(
    selectionToken: string,
    notice: string,
    expectedAttempt?: number,
    reason?: 'definitive-rejection' | 'backend-generation-ended',
  ): void;
  /** Retain a timed-out create/duplicate operation instead of rolling back. */
  handleCreateOperationDelayed?(selectionToken: string, operationId: string, notice: string, expectedAttempt?: number): void;
  /** Refresh lifecycle metadata fences at actual RPC start (after queue wait). */
  captureSelectionRequestStart?(selectionToken: string, operationAttempt?: number): void;
  /** Current backend process generation for queued lifecycle ownership fences. */
  getBackendGeneration?(): number;
  /** Reconcile an authoritative durable acknowledgement when session.opened is
   * delayed or publication failed after creation committed. */
  handleCreateOperationAcknowledged?(selectionToken: string, operationId: string, sessionPath: string): void;
  /** Decide whether a `session.open` for `sessionPath` can skip the
   *  transcript round-trip: returns `'skip'` when the host already has the
   *  session's transcript window loaded and the session is not actively
   *  streaming, otherwise `'tail'` (full authoritative snapshot). */
  getOpenTranscriptMode(sessionPath: string): import('../../shared/protocol').TranscriptMode;
}

export interface StatsServiceLike {
  prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage?: string): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  startNewTask(sessionPath: string): void;
  continueTask(sessionPath: string): void;
  /** Remove any in-memory and persisted analytics for a private session. */
  setSessionPrivacy?(sessionPath: string, enabled: boolean): Promise<void> | void;
}

/** Opaque handle returned by {@link TimerSink.schedule}. Stored & passed back to cancel. */
export type TimerHandle = unknown;

/**
 * Injectable timer sink. Defaults to real `setTimeout`/`clearTimeout`; tests
 * pass a fake to drive timers deterministically (no wall-clock waits, no flakes
 * from real-timer races under load).
 */
export interface TimerSink {
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

const defaultTimerSink: TimerSink = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface EffectRunnerDeps {
  backend: BackendLike;
  queues: QueueRouter;
  tabs: TabPersistenceSink;
  log: LogSink;
  postImperative: PostImperativeSink;
  modal: ModalSink;
  /** M2 source-aware inline confirmations (browser server plan §9): the
   *  initiating BROWSER renderer confirms inline; the VS Code modal is never
   *  shown to a browser source. Optional so the sidebar-only host and tests
   *  without a browser server remain unchanged. */
  inlineConfirm?: (request: {
    rendererId: string;
    kind: 'model-switch' | 'destructive-revert';
    sessionPath?: string;
    message: string;
    confirmChoice: string;
  }) => Promise<boolean>;
  fileDiffService: FileDiffService;
  service: SessionServiceLike;
  statsService: StatsServiceLike;
  /** Called with each `*Result` event the runner produces. */
  dispatch: (event: EffectResultEvent) => void;
  /**
   * Re-dispatch a Command into the reducer. Used by `DrainPendingSendQueue` to
   * re-dispatch queued `Send` Commands with a resolved session path. The runner
   * cannot emit Effects that loop back synchronously, but it CAN feed Commands
   * back via this callback (dispatched asynchronously inside a void async IIFE
   * so they land after the current synchronous dispatch cycle).
   */
  dispatchCommand: (event: CommandEvent) => void;
  /**
   * Dispatch a non-result, non-command Event (e.g. `BackendReadyWatchdogFired`)
   * back into the reducer. The runner uses this for watchdog timeout events.
   */
  dispatchEvent: (event: import('./events').Event) => void;
  /**
   * Override the send-timer budget (default 120s). The send-timer owns the
   * post-ack, pre-commit phase (early-ack → first `MessageStarted`); on fire
   * it dispatches `PreflightFailed` so the reducer reverts via
   * `pending.promoted[corrId]`. Used by tests to avoid waiting the full
   * timeout. Ignored when `getSendTimerTimeoutMs` is provided.
   */
  sendTimerTimeoutMs?: number;
  /**
   * Dynamic send-timer budget, read fresh at each send-dispatch (so a user
   * changing `prepassTimeoutSec` at runtime takes effect immediately). When
   * provided, takes precedence over the static `sendTimerTimeoutMs`. The
   * production wiring (`extension-host`) derives this from the current
   * `settings.pruningSettings.prepassTimeoutSec` + first-token headroom so a
   * long-but-legitimate prepass never trips a spurious `PreflightFailed`
   * (which would roll back the user message — `promoted` is still present —
   * and orphan a late `MessageStarted` reply). Falls back to the 120s default
   * when `prepassTimeoutSec` is null/invalid (SDK-owned default, presumed well
   * under 120s).
   */
  getSendTimerTimeoutMs?: (sessionPath: string) => number;
  /** Live provider-gate state used to distinguish legitimate queue/pause wait. */
  getProviderGateMetrics?: () => ProviderGateStats;
  /** Resolve the provider serving the session's current request. */
  resolveSessionProvider?: (sessionPath: string) => string | undefined;
  /** True only while this exact session's live turn is queued/waiting_provider. */
  isSessionProviderPending?: (sessionPath: string) => boolean;
  /**
   * Timer sink used for the backend-ready watchdog + send-timer.
   * Defaults to real `setTimeout`/`clearTimeout`. Tests inject a fake to
   * advance timers synchronously without wall-clock waits.
   */
  timer?: TimerSink;
}

/** A per-kind effect handler. `effect` is `any` so a handler accepting a
 *  narrower `Effect` variant is assignable without contravariance friction;
 *  the {@link EffectRunner.handlers} `Record<Effect['kind'], EffectHandler>`
 *  key type — not the value type — provides compile-time exhaustiveness. */
type EffectHandler = (effect: any) => void;

export class EffectRunner {
  /** The backend-ready watchdog timer. Started by `StartBackendReadyWatchdog`,
   * cleared by `CancelBackendReadyWatchdog` / `DrainBackendReadyQueue` / fire. */
  private backendReadyWatchdog: TimerHandle | null = null;

  /** Session operations delegate their non-serializable execution resources
   * to the operation-owned controller; this façade retains no operation state. */
  private readonly sessionOperations: SessionOperationEffectController;

  /** Per-session timers that expire the transient "Compacted" chip
   *  (`ClearLastCompaction` effect → `LastCompactionCleared` on fire). */
  private lastCompactionTimers: Map<string, TimerHandle> = new Map();

  /** Opaque timers for reducer-owned session.open reconciliation attempts. */
  private openReconciliationTimers: Map<string, TimerHandle> = new Map();
  /** At most one queued/in-flight checkpoint RPC per semantic attempt. Newer
   *  events are already retained by the reducer and the backend checkpoint is
   *  authoritative at execution time, so duplicate RPCs only create storms. */
  private readonly liveCheckpointAttempts = new Set<string>();

  /** Preference writes are partial patches but persistence/backend payloads
   * are complete merged snapshots. Serialize them on their own queue so rapid
   * provider toggles cannot complete out of order and restore stale settings.
   * This queue is deliberately independent of session lifecycle work. */
  private prefsQueue: Promise<void> = Promise.resolve();

  /** Global MCP config mutations and list reads need FIFO ordering with each
   * other, but must not sit behind unrelated preference or session-runtime
   * work. Session-scoped writes use the ordinary per-session operation queue:
   * recycling a worker can take seconds and must never head-of-line block the
   * global discovery read that makes the MCP menu usable. */
  private mcpQueue: Promise<void> = Promise.resolve();

  /** Tab snapshots are complete replacements, so they must reach VS Code
   * globalState in reducer order. Concurrent Memento updates can otherwise
   * finish in reverse order and durably resurrect a tab that a later close
   * removed. This queue is independent of session/lifecycle work, preserving
   * snappy host-local tab updates while serializing only the persistence I/O. */
  private tabPersistenceQueue: Promise<void> = Promise.resolve();
  /** Model/reasoning and preference writes that must settle before a manual
   * backend restart. The UI is fenced first, so draining this set is bounded
   * to work the user already initiated. */
  private readonly configurationOperations = new Set<Promise<void>>();

  /** Injectable timer sink (real timers in production, fake in tests). */
  private readonly timer: TimerSink;

  private static readonly SEND_TIMER_TIMEOUT_MS = 120_000;

  /** Dispatch table: one handler per `Effect['kind']`. The `Record` key type
   *  forces every kind to have an entry (compile-time exhaustiveness). Built
   *  once in the constructor. */
  private readonly handlers: Record<Effect['kind'], EffectHandler>;

  constructor(private readonly deps: EffectRunnerDeps) {
    this.timer = deps.timer ?? defaultTimerSink;
    this.sessionOperations = new SessionOperationEffectController({
      backend: deps.backend,
      queues: deps.queues,
      log: deps.log,
      service: deps.service,
      statsService: deps.statsService,
      dispatch: deps.dispatch,
      dispatchEvent: deps.dispatchEvent,
      timer: this.timer,
      sendTimerTimeoutMs: deps.sendTimerTimeoutMs ?? EffectRunner.SEND_TIMER_TIMEOUT_MS,
      getSendTimerTimeoutMs: deps.getSendTimerTimeoutMs,
      getProviderGateMetrics: deps.getProviderGateMetrics,
      resolveSessionProvider: deps.resolveSessionProvider,
      isSessionProviderPending: deps.isSessionProviderPending,
    });
    this.handlers = {
      // Session operations delegate as one domain. Generic truncate, queue,
      // and extension-UI RPCs retain the direct session-FIFO path below.
      SendRpc: (e) => this.sessionOperations.runSendRpc(e),
      GenerateSessionTitle: (e) => this.handleGenerateSessionTitle(e),
      EditRpc: (e) => this.sessionOperations.runEditRpc(e),
      ReplaceQueueRpc: (e) => this.runReplaceQueueRpc(e),
      ContinueRpc: (e) => this.sessionOperations.runContinueRpc(e),
      InterruptRpc: (e) => this.sessionOperations.runInterruptRpc(e),
      RequestLiveTurnCheckpoint: (e) => this.handleRequestLiveTurnCheckpoint(e),
      CompactRpc: (e) => this.sessionOperations.runCompactRpc(e),
      ClearQueueRpc: (e) => this.runRpc(e),
      TruncateRpc: (e) => this.runRpc(e),
      ExtensionUiResponseRpc: (e) => this.runRpc(e),
      // ── Lifecycle kinds: `enqueueLifecycle`-only. ──
      OpenSession: (e) => this.runLifecycle(e),
      ScheduleOpenSessionReconciliation: (e) => this.handleScheduleOpenSessionReconciliation(e),
      RecoverOpenSession: (e) => this.handleRecoverOpenSession(e),
      CreateSession: (e) => this.runLifecycle(e),
      DuplicateSession: (e) => this.runLifecycle(e),
      // Runtime-free visual transition notification; direct and unqueued so it
      // cannot wait behind runtime lifecycle work.
      NotifySessionViewed: (e) => this.handleNotifySessionViewed(e),
      // ── Special kinds (non-template control flow → named handlers). ──
      ShowModelSwitchConfirm: (e) => this.handleShowModelSwitchConfirm(e),
      SetModelRpc: (e) => this.handleSetModelRpc(e),
      SetPrefsRpc: (e) => this.handleSetPrefsRpc(e),
      McpListRpc: (e) => this.handleMcpListRpc(e),
      McpSetServerRpc: (e) => this.handleMcpSetServerRpc(e),
      McpSetSessionServerRpc: (e) => this.handleMcpSetSessionServerRpc(e),
      SetPrivacyMode: (e) => this.handleSetPrivacyMode(e),
      SetSystemPromptTogglesRpc: (e) => this.handleSetSystemPromptTogglesRpc(e),
      DetailSubscribeRpc: (e) => this.handleDetailSubscribeRpc(e),
      DetailUnsubscribeRpc: (e) => this.handleDetailUnsubscribeRpc(e),
      DetailFetchPagesRpc: (e) => this.handleDetailFetchPagesRpc(e),
      Log: (e) => this.handleLog(e),
      PostImperative: (e) => this.handlePostImperative(e),
      OpenFile: (e) => this.handleOpenFile(e),
      DrainPendingSendQueue: (e) => this.handleDrainPendingSendQueue(e),
      DrainBackendReadyQueue: (e) => this.handleDrainBackendReadyQueue(e),
      DrainDeferredSetModelQueue: (e) => this.handleDrainDeferredSetModelQueue(e),
      StartBackendReadyWatchdog: (e) => this.handleStartBackendReadyWatchdog(e),
      CancelBackendReadyWatchdog: (e) => this.handleCancelBackendReadyWatchdog(e),
      MarkPrepassSucceeded: (e) => this.sessionOperations.markPrepassSucceeded(e),
      ScheduleOperationReconciliation: (e) => this.sessionOperations.scheduleOperationReconciliation(e),
      ReleaseOperationResources: (e) => this.sessionOperations.releaseOperationResources(e),
      // A reducer-confirmed commit releases the matching execution timer; it
      // does not infer or change operation lifecycle state in the effect layer.
      ClearSendTimer: (e) => this.sessionOperations.clearSendTimer(
        e.corrId,
        e.restorePruningMode,
      ),
      // ── Transient "Compacted" chip TTL: expire the host-owned entry after a
      //    bounded delay so the chip does not linger. ──
      ClearLastCompaction: (e) => this.handleClearLastCompaction(e),
      HydrateModel: (e) => this.handleHydrateModel(e),
      // ── Template rows (pure 1:1 effect → *Result). ──
      FileDiff: this.templateRow({ resultKind: 'FileDiffResult', withSessionPath: true, call: (e, d) => d.fileDiffService.openFileDiff(e.sessionPath, e.filePath) }),
      // FileRevert is a named handler: a browser source must confirm inline in
      // ITS renderer before the destructive revert runs (§9).
      FileRevert: (e) => this.handleFileRevert(e),
      LoadOlderTranscript: this.templateRow({ resultKind: 'LoadOlderTranscriptResult', withSessionPath: true, call: (e, d) => d.service.loadOlderTranscript(e.sessionPath) }),
      LoadNewerTranscript: this.templateRow({ resultKind: 'LoadNewerTranscriptResult', withSessionPath: true, call: (e, d) => d.service.loadNewerTranscript(e.sessionPath) }),
      JumpToLatestTranscript: this.templateRow({ resultKind: 'JumpToLatestTranscriptResult', withSessionPath: true, call: (e, d) => d.service.jumpToLatestTranscript(e.sessionPath) }),
      StartNewTask: this.templateRow({ resultKind: 'StartNewTaskResult', withSessionPath: false, call: (e, d) => { d.statsService.startNewTask(e.sessionPath); } }),
      ContinueTask: this.templateRow({ resultKind: 'ContinueTaskResult', withSessionPath: false, call: (e, d) => { d.statsService.continueTask(e.sessionPath); } }),
      OpenFileInEditor: this.templateRow({ resultKind: 'OpenFileInEditorResult', withSessionPath: false, call: (e, d) => d.fileDiffService.openFileInEditor(e.sessionPath, e.filePath) }),
      SetPruningSettings: this.templateRow({ resultKind: 'SetPruningSettingsResult', withSessionPath: false, call: (e, d) => d.service.setPruningSettings(e.settings) }),
      SetToolResultPruningSettings: this.templateRow({ resultKind: 'SetToolResultPruningSettingsResult', withSessionPath: false, call: (e, d) => d.service.setToolResultPruningSettings(e.settings) }),
      SetSessionTitlesSettings: this.templateRow({ resultKind: 'SetSessionTitlesSettingsResult', withSessionPath: false, call: (e, d) => d.service.setSessionTitlesSettings(e.settings) }),
      CloseSession: (e) => this.handleCloseSession(e),
      RestartBackend: (e) => this.handleRestartBackend(e),
      PersistTabs: (e) => this.handlePersistTabs(e),
    };
  }

  /**
   * Execute a single effect. Returns a promise that resolves when the effect
   * has been queued (not when it has completed) — the actual result is
   * delivered asynchronously via `deps.dispatch`. Callers do not await
   * completion; this preserves the no-re-entrant-blocking invariant.
   */
  run(effect: Effect): void {
    this.logEffectDispatch(effect);
    this.handlers[effect.kind](effect);
  }

  /**
   * Emit a lightweight breadcrumb for every effect that enters the runner.
   * This is intentionally centralized so runtime-audit mode can answer
   * "what did the reducer ask the side-effect layer to do" without adding
   * bespoke logs to every individual handler.
   */
  private logEffectDispatch(effect: Effect): void {
    const payload: Record<string, unknown> = { kind: effect.kind };
    if ('corrId' in effect) payload.corrId = effect.corrId;
    if ('sessionPath' in effect) payload.sessionPath = effect.sessionPath;

    switch (effect.kind) {
      case 'DrainPendingSendQueue':
        payload.entries = effect.entries.length;
        payload.resolvedSessionPath = effect.resolvedSessionPath;
        break;
      case 'DrainBackendReadyQueue':
        payload.entries = effect.entries.length;
        break;
      case 'StartBackendReadyWatchdog':
        payload.timeoutMs = effect.timeoutMs;
        break;
      case 'PersistTabs':
        payload.openTabs = effect.openTabPaths.length;
        payload.pinnedTabs = effect.pinnedTabPaths.length;
        payload.pinnedGroups = effect.pinnedTabGroups.length;
        payload.hasActiveSession = !!effect.activeSessionPath;
        break;
      case 'SetPrefsRpc':
        payload.prefKeys = Object.keys(effect.prefs);
        break;
      case 'McpListRpc':
        break;
      case 'McpSetServerRpc':
        payload.mcpServer = effect.name;
        payload.mcpEnabled = effect.enabled;
        break;
      case 'McpSetSessionServerRpc':
        payload.mcpSessionPath = effect.sessionPath;
        break;
      case 'SetPruningSettings':
      case 'SetToolResultPruningSettings':
      case 'SetSessionTitlesSettings':
        payload.settingKeys = Object.keys(effect.settings);
        break;
    }

    this.deps.log.log('debug', 'effect.dispatch', payload);
  }

  private handleGenerateSessionTitle(effect: Extract<Effect, { kind: 'GenerateSessionTitle' }>): void {
    // Cosmetic title work is intentionally outside the per-session mutation
    // queue. It must never delay interrupt, follow-up, or transcript work.
    void (async () => {
      try {
        const response = await this.deps.backend.request<{
          generated: boolean;
          name?: string;
          reason?: string;
        }>('session.title.generate', {
          sessionPath: effect.sessionPath,
          prompt: effect.prompt,
          provider: effect.provider,
          model: effect.model,
          thinkingLevel: effect.thinkingLevel,
          timeoutSec: effect.timeoutSec,
        }, { timeoutMs: effect.timeoutSec * 1_000 + 5_000 });
        this.deps.dispatch({
          kind: 'SessionTitleResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: true,
          generated: response.generated,
          name: response.name,
          reason: response.reason,
        });
      } catch (error) {
        this.deps.dispatch({
          kind: 'SessionTitleResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: false,
          error: toErrorMessage(error),
        });
      }
    })();
  }

  private handleRequestLiveTurnCheckpoint(effect: RequestLiveTurnCheckpointEffect): void {
    const attemptKey = `${effect.sessionPath}\u0000${effect.turnId}\u0000${effect.attemptId}`;
    if (this.liveCheckpointAttempts.has(attemptKey)) return;
    this.liveCheckpointAttempts.add(attemptKey);
    if (isLivePipelineTraceEnabled()) recordLivePipelineTrace({
      process: 'host', stage: 'host.checkpoint.requested', kind: 'start',
      identifiers: { session: effect.sessionPath, turn: effect.turnId, attempt: effect.attemptId },
      eventKind: 'checkpoint',
    });
    // This is a read-only snapshot of backend-owned in-memory state. Run it
    // outside lifecycle/session mutation queues: repair is needed precisely
    // while a long request or extension-UI interaction may own that queue.
    // The backend event loop captures the accumulator synchronously, so queue
    // serialization adds head-of-line blocking without improving consistency.
    void (async () => {
      const dispatchResult = (result: Extract<EffectResultEvent, { kind: 'LiveTurnCheckpointResult' }>): void => {
        // Reducer dispatch is synchronous and a failed result can immediately
        // request the next bounded retry. Release this attempt before dispatch
        // so the retry is not mistaken for a duplicate of the completed call.
        this.liveCheckpointAttempts.delete(attemptKey);
        this.deps.dispatch(result);
      };
      try {
          const response = await this.deps.backend.request<{
            status: 'active' | 'terminal_grace' | 'inactive' | 'backend_restarted' | 'oversize';
            checkpoint: LiveTurnCheckpoint | null;
            watermark: LiveLifecycleWatermark | null;
          }>('liveTurn.checkpoint', {
            sessionPath: effect.sessionPath,
            turnId: effect.turnId,
            attemptId: effect.attemptId,
          }, { timeoutMs: 5_000 });
          if (isLivePipelineTraceEnabled()) recordLivePipelineTrace({
            process: 'host',
            stage: response.checkpoint ? 'host.checkpoint.received' : 'host.checkpoint.failed',
            kind: response.checkpoint ? 'success' : 'failure',
            identifiers: { session: effect.sessionPath, turn: effect.turnId, attempt: effect.attemptId },
            eventKind: 'checkpoint',
            eventSeq: response.checkpoint?.checkpointSeq,
            reasonCode: response.checkpoint
              ? undefined
              : response.status === 'backend_restarted'
                ? 'backend_exit'
                : response.status === 'oversize' ? 'checkpoint_oversize' : 'owner_missing',
          });
          dispatchResult({
            kind: 'LiveTurnCheckpointResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            turnId: effect.turnId,
            attemptId: effect.attemptId,
            ok: true,
            occurredAt: Date.now(),
            ...response,
          });
      } catch (error) {
          if (isLivePipelineTraceEnabled()) recordLivePipelineTrace({
            process: 'host', stage: 'host.checkpoint.failed', kind: 'failure',
            identifiers: { session: effect.sessionPath, turn: effect.turnId, attempt: effect.attemptId },
            eventKind: 'checkpoint', reasonCode: 'checkpoint_timeout',
          });
          dispatchResult({
            kind: 'LiveTurnCheckpointResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            turnId: effect.turnId,
            attemptId: effect.attemptId,
            ok: false,
            occurredAt: Date.now(),
            error: toErrorMessage(error),
          });
      } finally {
        this.liveCheckpointAttempts.delete(attemptKey);
      }
    })();
  }

  // ─── Template rows ────────────────────────────────────────────────────────

  /** Build the standard async-IIFE + try/catch + `dispatch({kind, corrId,
   *  [sessionPath?], ok, error?})` handler for a pure 1:1 effect→result row.
   *
   *  `call` returns a `Promise` for await-rows and `void` for sync rows
   *  (StartNewTask / ContinueTask call sync stats methods).
   *  The helper awaits only when a `Promise` is returned, preserving the
   *  original await-vs-sync distinction exactly — sync rows must NOT gain an
   *  extra microtask (the dispatch would slip one tick later). */
  private templateRow(opts: {
    resultKind: EffectResultEvent['kind'];
    withSessionPath: boolean;
    call: (effect: any, deps: EffectRunnerDeps) => Promise<unknown> | void;
  }): EffectHandler {
    return (effect) => {
      void (async () => {
        try {
          const r = opts.call(effect, this.deps);
          if (r) await r;
          this.deps.dispatch(
            (opts.withSessionPath
              ? { kind: opts.resultKind, corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true }
              : { kind: opts.resultKind, corrId: effect.corrId, ok: true }) as EffectResultEvent,
          );
        } catch (err) {
          this.deps.dispatch(
            (opts.withSessionPath
              ? { kind: opts.resultKind, corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) }
              : { kind: opts.resultKind, corrId: effect.corrId, ok: false, error: toErrorMessage(err) }) as EffectResultEvent,
          );
        }
      })();
    };
  }

  // ─── Special-kind handlers (non-template control flow) ────────────────────

  /** Persist complete tab snapshots strictly in reducer dispatch order.
   * Failure of one snapshot is reported against its own correlation ID but
   * does not poison the queue: the next, newer snapshot still gets a chance
   * to become durable. */
  private handlePersistTabs(effect: PersistTabsEffect): void {
    const operation = this.tabPersistenceQueue.then(() =>
      this.deps.tabs.persistTabs(
        effect.openTabPaths,
        effect.activeSessionPath,
        effect.pinnedTabPaths,
        effect.pinnedTabGroups,
        effect.privateSessionPaths,
      ),
    );

    this.tabPersistenceQueue = operation.then(
      () => undefined,
      () => undefined,
    );

    void operation.then(
      () => this.deps.dispatch({
        kind: 'PersistTabsResult', corrId: effect.corrId,
        ...(effect.operationId ? { operationId: effect.operationId, backendGeneration: effect.backendGeneration } : {}),
        ...(effect.acknowledgementKey ? { acknowledgementKey: effect.acknowledgementKey } : {}),
        ok: true,
      }),
      (err) => this.deps.dispatch({
        kind: 'PersistTabsResult',
        corrId: effect.corrId,
        ...(effect.operationId ? { operationId: effect.operationId, backendGeneration: effect.backendGeneration } : {}),
        ...(effect.acknowledgementKey ? { acknowledgementKey: effect.acknowledgementKey } : {}),
        ok: false,
        error: toErrorMessage(err),
      }),
    );
  }

  private handleCloseSession(effect: Extract<Effect, { kind: 'CloseSession' }>): void {
    void Promise.resolve().then(async () => {
      try {
        await this.deps.service.closeSession(
          effect.sessionPath,
          effect.nextPath,
          effect.privacyMode === true,
          effect.selectionChanged === true,
          effect.operationId,
          effect.backendGeneration,
        );
        this.deps.dispatch({
          kind: 'CloseSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath,
          ...(effect.operationId ? { operationId: effect.operationId, backendGeneration: effect.backendGeneration } : {}),
          ok: true,
        });
      } catch (error) {
        const errorMessage = toErrorMessage(error);
        this.deps.dispatch({
          kind: 'CloseSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath,
          ...(effect.operationId ? { operationId: effect.operationId, backendGeneration: effect.backendGeneration } : {}),
          ok: false, error: errorMessage,
        });
        if (effect.privacyMode && effect.operationId) {
          // Cleanup failure blocks marker removal. Settle that distinct barrier
          // acknowledgement as failed rather than leaving the close pending.
          this.deps.dispatch({
            kind: 'PersistTabsResult',
            corrId: effect.corrId,
            operationId: effect.operationId,
            backendGeneration: effect.backendGeneration,
            acknowledgementKey: 'privacy-marker-removal',
            ok: false,
            error: `Privacy marker removal was not attempted: ${errorMessage}`,
          });
        }
      }
    });
  }

  private handleRestartBackend(effect: Extract<Effect, { kind: 'RestartBackend' }>): void {
    void (async () => {
      try {
        await this.drainConfigurationOperations();
        this.deps.dispatchEvent({
          kind: 'BackendRestartDrainCompleted',
          operationId: effect.operationId,
          backendGeneration: effect.backendGeneration,
        });
        if (!this.deps.service.restart) throw new Error('Backend restart is unavailable.');
        await this.deps.service.restart(() => {
          this.deps.dispatchEvent({
            kind: 'BackendRestartOldGenerationDied',
            operationId: effect.operationId,
            backendGeneration: effect.backendGeneration,
          });
        });
        this.deps.dispatch({
          kind: 'BackendRestartResult', corrId: effect.corrId,
          operationId: effect.operationId,
          backendGeneration: effect.backendGeneration,
          replacementBackendGeneration: this.deps.service.getBackendGeneration?.(),
          ok: true,
        });
      } catch (error) {
        this.deps.dispatch({
          kind: 'BackendRestartResult', corrId: effect.corrId,
          operationId: effect.operationId,
          backendGeneration: effect.backendGeneration,
          replacementBackendGeneration: this.deps.service.getBackendGeneration?.(),
          ok: false,
          error: toErrorMessage(error),
        });
      }
    })();
  }

  /** `ShowModelSwitchConfirm` — modal confirmation. NOT queued on the
   *  lifecycle queue (a modal must not block session create/open). Dispatches
   *  `ModelSwitchConfirmResult{corrId, confirmed}` (no `ok`/`error`/
   *  `sessionPath`); on modal throw, logs + dispatches `{confirmed:false}`
   *  (no error field). For a BROWSER source (M2 source-aware seam, §9), the
   *  confirmation renders inline in the INITIATING renderer; the VS Code
   *  modal is never invoked for a browser source, and disconnect cancels. */
  private handleShowModelSwitchConfirm(effect: ShowModelSwitchConfirmEffect): void {
    // Intentionally NOT queued on the lifecycle queue: a modal is a user
    // interaction, and holding the lifecycle queue (shared with create/open)
    // behind an open modal would block session creation while the user stares
    // at a dialog. VS Code serializes modal
    // dialogs itself, corrIds are independent, and the backend write
    // (SetModelRpc) still goes through the lifecycle queue — so ordering is
    // preserved where it matters. This is an improvement, not a regression.
    void (async () => {
      try {
        if (effect.source?.kind === 'browser' && this.deps.inlineConfirm) {
          const confirmed = await this.deps.inlineConfirm({
            rendererId: effect.source.rendererId,
            kind: 'model-switch',
            sessionPath: effect.sessionPath,
            message: effect.message,
            confirmChoice: effect.confirmChoice,
          });
          this.deps.dispatch({ kind: 'ModelSwitchConfirmResult', corrId: effect.corrId, confirmed });
          return;
        }
        const choice = await this.deps.modal.showWarningModal(effect.message, effect.confirmChoice);
        this.deps.dispatch({ kind: 'ModelSwitchConfirmResult', corrId: effect.corrId, confirmed: choice === effect.confirmChoice });
      } catch (err) {
        // If the modal itself throws, treat as not confirmed and log; the
        // reducer drops the stashed intent on a non-confirm.
        this.deps.log.log('error', `ShowModelSwitchConfirm failed: ${toErrorMessage(err)}`);
        this.deps.dispatch({ kind: 'ModelSwitchConfirmResult', corrId: effect.corrId, confirmed: false });
      }
    })();
  }

  /** `FileRevert` — destructive `revertFile`. VS Code sources revert directly
   *  (the sidebar UI owns its local confirmation). A BROWSER source (M2
   *  source-aware seam, §9) first confirms inline in the INITIATING renderer;
   *  the host proceeds only on explicit confirm, and disconnect cancels. A
   *  cancelled confirm dispatches `FileRevertResult{ok:false}` (the reducer
   *  treats it as a no-op) and never touches the file. */
  private handleFileRevert(effect: FileRevertEffect): void {
    void (async () => {
      try {
        if (effect.source?.kind === 'browser' && this.deps.inlineConfirm) {
          const confirmed = await this.deps.inlineConfirm({
            rendererId: effect.source.rendererId,
            kind: 'destructive-revert',
            sessionPath: effect.sessionPath,
            message: `Revert ${effect.filePath}? This permanently discards the changes shown in the diff.`,
            confirmChoice: 'Revert File',
          });
          if (!confirmed) {
            this.deps.dispatch({ kind: 'FileRevertResult', corrId: effect.corrId, sessionPath: effect.sessionPath, filePath: effect.filePath, ok: false, error: 'cancelled' });
            return;
          }
        }
        await this.deps.fileDiffService.revertFile(effect.sessionPath, effect.filePath);
        this.deps.dispatch({ kind: 'FileRevertResult', corrId: effect.corrId, sessionPath: effect.sessionPath, filePath: effect.filePath, ok: true });
      } catch (err) {
        this.deps.log.log('error', `FileRevert failed: ${toErrorMessage(err)}`);
        this.deps.dispatch({
          kind: 'FileRevertResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          filePath: effect.filePath,
          ok: false,
          error: toErrorMessage(err),
        });
      }
    })();
  }

  /** `SetModelRpc` — 3 sequential dep calls (settings.set → bumpSessionDataEpoch
   *  → onModelConfigChanged). Serialized on the target session queue.
   *  Result `SetModelResult` with `sessionPath`+`ok`+`error?`. */
  private handleSetModelRpc(effect: SetModelRpcEffect): void {
    // The reducer owns every ArchState transition (global default, per-session
    // model badge, context-usage clear, pending-image clear, rollback). The
    // runner only performs the backend write + the two Effect-side concerns
    // that are not ArchState: the host-local data epoch (transcript paging
    // staleness) and the disk-persisting run-analytics observer. Serialized
    // through the target session queue. A model change must stay ordered with
    // sends for that session, but must not block create/open for another tab.
    const { backend, queues, dispatch, service } = this.deps;
    const operation = queues.enqueueSessionOperation(effect.sessionPath, async () => {
      try {
        const setParams: Record<string, unknown> = {
          sessionPath: effect.sessionPath,
          defaultModel: effect.modelSettings.defaultModel,
          defaultThinkingLevel: effect.modelSettings.defaultThinkingLevel,
        };
        // Preserve the picker entry's provider so duplicate model ids are
        // resolved against the model the user actually selected. Omitting this
        // makes the backend reuse the current provider, perform a fallback
        // id-only switch, then reject the successful switch as a provider
        // mismatch (so it appears to work only on the second attempt).
        if (effect.modelSettings.defaultProvider) {
          setParams.defaultProvider = effect.modelSettings.defaultProvider;
        }
        await backend.request('settings.set', setParams);
        service.bumpSessionDataEpoch(effect.sessionPath);
        service.onModelConfigChanged(
          effect.sessionPath,
          effect.modelSettings.defaultModel,
          effect.modelSettings.defaultThinkingLevel,
          effect.modelSettings.defaultProvider,
        );
        dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        // A create acknowledgement can resolve its pending path before the
        // trailing session.opened publication arrives. Deferred SetModel then
        // advances the model-write fence, so that older snapshot may correctly
        // lose the race. Always request a fresh post-write catalog to replace
        // any borrowed provisional list (including pricing metadata).
        this.deps.dispatchCommand({
          kind: 'Command',
          cmd: {
            kind: 'HydrateModel',
            corrId: `hydrate:model:${effect.corrId}`,
            sessionPath: effect.sessionPath,
          },
        });
      } catch (err) {
        this.deps.log.log('warn', 'SetModelRpc failed', {
          sessionPath: effect.sessionPath,
          error: toErrorMessage(err),
        });
        dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
      }
    });
    this.trackConfigurationOperation(operation);
  }

  /** `SetPrefsRpc` — IIFE (not queued), `service.setPrefs(prefs)`. Result
   *  `SetPrefsResult` (NO `sessionPath`). */
  private handleSetPrefsRpc(effect: SetPrefsRpcEffect): void {
    const operation = this.prefsQueue.catch(() => undefined).then(async () => {
      try {
        await this.deps.service.setPrefs(effect.prefs);
        this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: true });
      } catch (err) {
        this.deps.log.log('warn', 'SetPrefsRpc failed', { error: toErrorMessage(err) });
        this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
      }
    });
    this.prefsQueue = operation.then(() => undefined, () => undefined);
    this.trackConfigurationOperation(this.prefsQueue);
  }

  /** `McpListRpc` — refresh the effective global MCP server list immediately,
   *  then hydrate the active session's override set on that session's queue.
   *  The split is deliberate: an idle session toggle may spend seconds
   *  recycling its worker, but opening either MCP surface must still discover
   *  and render the global server rows. Serializing only the hydration behind
   *  session writes prevents an older artifact read from overwriting a newer
   *  optimistic/session-write result.
   *
   *  A config list read does not reload the adapter, so the response carries
   *  no `pendingApply` — the reducer preserves the current flag. A global-list
   *  failure dispatches `ok: false` so the UI can offer Refresh while keeping
   *  cached rows visible. Session hydration failure is logged independently;
   *  it must not turn an already-successful global list into an error. */
  private handleMcpListRpc(effect: McpListRpcEffect): void {
    const operation = this.mcpQueue.catch(() => undefined).then(async () => {
      try {
        const result = await this.deps.service.mcpList();
        this.deps.dispatchEvent({
          kind: 'McpServersUpdated',
          corrId: effect.corrId,
          ok: true,
          servers: result.servers,
        });
      } catch (err) {
        this.deps.log.log('warn', 'McpListRpc failed', { error: toErrorMessage(err) });
        this.deps.dispatchEvent({
          kind: 'McpServersUpdated',
          corrId: effect.corrId,
          ok: false,
          error: toErrorMessage(err),
        });
      }
    });
    this.mcpQueue = operation.then(() => undefined, () => undefined);
    this.trackConfigurationOperation(this.mcpQueue);

    if (effect.sessionPath === undefined) return;
    const hydration = this.deps.queues.enqueueSessionOperation(effect.sessionPath, async () => {
      try {
        const result = await this.deps.service.mcpList(effect.sessionPath);
        this.deps.dispatchEvent({
          kind: 'McpServersUpdated',
          corrId: effect.corrId,
          ok: true,
          sessionPath: effect.sessionPath,
          sessionOverrides: result.sessionOverrides ?? {},
        });
      } catch (err) {
        this.deps.log.log('warn', 'McpListRpc session hydration failed', {
          sessionPath: effect.sessionPath,
          error: toErrorMessage(err),
        });
      }
    });
    this.trackConfigurationOperation(hydration);
  }

  /** `McpSetServerRpc` — persist a per-server `disabled` override. The
   *  response carries the fresh list; a toggle that actually wrote an
   *  override sets the pending-apply flag (the adapter re-reads config on
   *  the next session reload / restart). A no-op toggle preserves the
   *  current flag. */
  private handleMcpSetServerRpc(effect: McpSetServerRpcEffect): void {
    const operation = this.mcpQueue.catch(() => undefined).then(async () => {
      try {
        const result = await this.deps.service.mcpSetServerEnabled(effect.name, effect.enabled);
        this.deps.dispatchEvent({
          kind: 'McpServersUpdated',
          corrId: effect.corrId,
          ok: true,
          servers: result.servers,
          ...(result.changed === true ? { pendingApply: true } : {}),
        });
      } catch (err) {
        this.deps.log.log('warn', 'McpSetServerRpc failed', { error: toErrorMessage(err) });
        this.deps.dispatchEvent({
          kind: 'McpServersUpdated',
          corrId: effect.corrId,
          ok: false,
          error: toErrorMessage(err),
        });
      }
    });
    this.mcpQueue = operation.then(() => undefined, () => undefined);
    this.trackConfigurationOperation(this.mcpQueue);
  }

  /** `McpSetSessionServerRpc` — write a session's per-server override set and
   *  (best effort) recycle that session's worker so the adapter applies the
   *  overrides at the next session start. Session writes use the ordinary
   *  per-session FIFO, preserving rapid-toggle order and ensuring a later
   *  hydration reads the committed artifact. They intentionally do not use
   *  the global MCP queue because worker retirement is a slow runtime action.
   *  `recycled: false` keeps the host's pending hint until the next idle
   *  recycle (retried on `BusyChanged`). */
  private handleMcpSetSessionServerRpc(effect: McpSetSessionServerRpcEffect): void {
    const operation = this.deps.queues.enqueueSessionOperation(effect.sessionPath, async () => {
      try {
        const result = await this.deps.service.mcpSetSessionServerEnabled(effect.sessionPath, effect.overrides, effect.recycle);
        this.deps.dispatchEvent({
          kind: 'McpSessionServersUpdated',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: true,
          overrides: result.overrides,
          recycled: result.recycled,
        });
      } catch (err) {
        this.deps.log.log('warn', 'McpSetSessionServerRpc failed', { error: toErrorMessage(err) });
        this.deps.dispatchEvent({
          kind: 'McpSessionServersUpdated',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: false,
          error: toErrorMessage(err),
        });
      }
    });
    this.trackConfigurationOperation(operation);
  }

  private trackConfigurationOperation(operation: Promise<unknown>): void {
    const settled = operation.then(() => undefined, () => undefined);
    this.configurationOperations.add(settled);
    void settled.finally(() => this.configurationOperations.delete(settled));
  }

  /** Called after backendReady=false has been projected and before transport
   * shutdown. Loop because one settled preference write may release the next
   * already-queued write in the same microtask turn. */
  async drainConfigurationOperations(): Promise<void> {
    while (this.configurationOperations.size > 0) {
      await Promise.all([...this.configurationOperations]);
    }
  }

  /** Privacy is host-local. The reducer has already updated the mode before
   * this effect runs; the stats service removes any pre-existing in-memory and
   * persisted analytics for the session when enabling it. A failed cleanup
   * rolls the optimistic mode back so the UI never promises privacy while old
   * analytics remain durable. */
  private handleSetPrivacyMode(effect: Extract<Effect, { kind: 'SetPrivacyMode' }>): void {
    const handleFailure = (error: unknown): void => {
      const message = toErrorMessage(error);
      this.deps.log.log('warn', 'privacy analytics cleanup failed', {
        sessionPath: effect.sessionPath,
        error: message,
      });
      if (!effect.enabled) return;
      this.deps.dispatchCommand({
        kind: 'Command',
        cmd: {
          kind: 'SetPrivacyMode',
          corrId: `privacy-cleanup-failed:${effect.corrId}`,
          sessionPath: effect.sessionPath,
          enabled: false,
        },
      });
      this.deps.dispatchEvent({
        kind: 'NoticeShown',
        notice: `Privacy mode could not be enabled because existing analytics could not be removed: ${message}`,
      });
    };
    try {
      const operation = this.deps.statsService.setSessionPrivacy?.(effect.sessionPath, effect.enabled);
      if (operation && typeof (operation as Promise<void>).then === 'function') {
        void (operation as Promise<void>).catch(handleFailure);
      }
    } catch (error) {
      handleFailure(error);
    }
  }

  /** `SetSystemPromptTogglesRpc` — serialized through the target session
   *  queue. The picker emits a complete disabled set after every click; FIFO
   *  ordering ensures an older partial set cannot finish after the final set,
   *  and a subsequent SendRpc cannot overtake the prompt update. The backend
   *  re-emits `session.opened`, so no `*Result` event is needed. */
  private handleSetSystemPromptTogglesRpc(effect: SetSystemPromptTogglesRpcEffect): void {
    void this.deps.queues.enqueueSessionOperation(effect.sessionPath, async () => {
      try {
        await this.deps.service.setSystemPromptToggles(effect.sessionPath, effect.disabledEntries);
      } catch (err) {
        this.deps.log.log('warn', 'setSystemPromptToggles failed', { scope: 'system-prompt-toggles', error: toErrorMessage(err), sessionPath: effect.sessionPath });
        // The user just clicked a toggle. Persisting it can fail (EACCES /
        // ENOSPC in the toggle store's writeFileSync); without a notice the
        // optimistic UI keeps the new value while the setting silently
        // reverts on the next backend read.
        this.deps.dispatchEvent({
          kind: 'NoticeShown',
          notice: 'Failed to save the system-prompt setting. See the pie log for details.',
          sessionPath: effect.sessionPath,
        });
      }
    });
  }

  // ─── Detail subscription effects ───────────────────────────────────
  // Fire-and-forget: the session service owns the subscription lifecycle and
  // stream content crosses as imperatives, never as *Result events. The
  // runner mints the subscription ID here so the service never guesses one.

  private handleDetailSubscribeRpc(effect: DetailSubscribeRpcEffect): void {
    this.deps.service.subscribeDetail({
      subscriptionId: crypto.randomUUID(),
      viewGeneration: effect.viewGeneration,
      detailKey: effect.detailKey,
      detailAttempt: effect.detailAttempt,
      address: effect.address,
      ...(effect.cursor !== undefined ? { cursor: effect.cursor } : {}),
      ...(effect.rendererId !== undefined && effect.rendererGeneration !== undefined
        ? { rendererId: effect.rendererId, rendererGeneration: effect.rendererGeneration }
        : {}),
    });
  }

  private handleDetailUnsubscribeRpc(effect: DetailUnsubscribeRpcEffect): void {
    this.deps.service.unsubscribeDetail({
      viewGeneration: effect.viewGeneration,
      detailKey: effect.detailKey,
      detailAttempt: effect.detailAttempt,
      reason: effect.reason,
      ...(effect.rendererId !== undefined && effect.rendererGeneration !== undefined
        ? { rendererId: effect.rendererId, rendererGeneration: effect.rendererGeneration }
        : {}),
    });
  }

  private handleDetailFetchPagesRpc(effect: DetailFetchPagesRpcEffect): void {
    this.deps.service.fetchDetailPages({
      viewGeneration: effect.viewGeneration,
      detailKey: effect.detailKey,
      detailAttempt: effect.detailAttempt,
      ref: effect.ref,
      ...(effect.rendererId !== undefined && effect.rendererGeneration !== undefined
        ? { rendererId: effect.rendererId, rendererGeneration: effect.rendererGeneration }
        : {}),
    });
  }

  private handleNotifySessionViewed(
    effect: Extract<Effect, { kind: 'NotifySessionViewed' }>,
  ): void {
    void this.deps.backend.request('session.viewed', {
      sessionPath: effect.sessionPath,
      previousSessionPath: effect.previousSessionPath,
    }, { timeoutMs: 5_000 }).catch((error) => {
      // Running-tab close has already committed its visual successor. Never
      // roll that selection back or block persistence on this notification.
      this.deps.log.log('warn', 'session.viewed notification failed', {
        sessionPath: effect.sessionPath,
        previousSessionPath: effect.previousSessionPath,
        error: toErrorMessage(error),
      });
    });
  }

  /** `Log` — synchronous `log.log(level, message, data)`. No try/catch, no
   *  result: exceptions propagate to the `run()` caller. */
  private handleLog(effect: LogEffect): void {
    this.deps.log.log(effect.level, effect.message, effect.data);
  }

  /** `PostImperative` — synchronous `postImperative.postImperative(...)`. No
   *  try/catch, no result. */
  private handlePostImperative(effect: PostImperativeEffect): void {
    this.deps.postImperative.postImperative(effect.imperativeMessage);
  }

  /** `OpenFile` — dynamic `import('vscode')` → `vscode.open` command. NOT a
   *  `deps.*` method (kept inline to avoid adding a sink that would break the
   *  7 untyped test mocks). IIFE. Result `OpenFileResult` (NO `sessionPath`). */
  private handleOpenFile(effect: OpenFileEffect): void {
    void (async () => {
      try {
        const vscode = await import('vscode');
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(effect.path));
        this.deps.dispatch({ kind: 'OpenFileResult', corrId: effect.corrId, ok: true });
      } catch (err) {
        this.deps.dispatch({ kind: 'OpenFileResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
      }
    })();
  }

  /** `DrainPendingSendQueue` — IIFE; loop dispatches `Command(Send)` per entry
   *  via `dispatchCommand`. No `*Result`; catch: `log.log('error',…)` swallow
   *  (no dispatch). The IIFE deferral is load-bearing (clear-then-reinsert
   *  ordering). */
  private handleDrainPendingSendQueue(effect: DrainPendingSendQueueEffect): void {
    // Re-dispatch each queued entry as a `Send` Command with the resolved
    // session path. The entries were read from ArchState by the reducer's
    // `handlePendingPathReplaced` and carried in this effect; the runner
    // never reads ArchState. The void async IIFE ensures the Commands land
    // AFTER the synchronous SessionScopeCleared + SessionOpened + SelectSession
    // events that follow PendingPathReplaced — preserving the clear-then-
    // reinsert ordering of the old drainPendingSendQueue callback.
    const { resolvedSessionPath, entries } = effect;
    void (async () => {
      try {
        for (const entry of entries) {
          this.deps.dispatchCommand({
            kind: 'Command',
            cmd: {
              kind: 'Send',
              corrId: entry.corrId,
              operationId: entry.operationId,
              operationAttempt: entry.operationAttempt,
              operationSource: entry.operationSource,
              backendGeneration: entry.backendGeneration,
              sessionPath: resolvedSessionPath,
              text: entry.text,
              inputs: entry.inputs,
              composedText: entry.composedText,
              localId: entry.localId,
              userParts: entry.userParts,
              previousSummary: entry.previousSummary,
              timestamp: entry.timestamp,
              priorPruningMode: entry.priorPruningMode,
            },
          });
        }
      } catch (err) {
        this.deps.log.log('error', `DrainPendingSendQueue failed: ${toErrorMessage(err)}`);
      }
    })();
  }

  /** `DrainBackendReadyQueue` — synchronous `clearBackendReadyWatchdog()`
   *  BEFORE the IIFE (the drain implies backend-ready, so the watchdog is
   *  no longer needed), then loop `dispatchCommand(Send, entry.sessionPath)`.
   *  No result; catch: log swallow. */
  private handleDrainBackendReadyQueue(effect: DrainBackendReadyQueueEffect): void {
    // Clear the watchdog timer — the backend is ready, so the timeout is
    // no longer needed.
    this.clearBackendReadyWatchdog();
    // Re-dispatch each queued entry as a Send Command. The void async IIFE
    // ensures the Commands land after the current synchronous dispatch cycle
    // (the BackendReadyChanged event may be followed by other synchronous
    // events). Each entry carries its own sessionPath.
    const { entries } = effect;
    void (async () => {
      try {
        for (const entry of entries) {
          this.deps.dispatchCommand({
            kind: 'Command',
            cmd: {
              kind: 'Send',
              corrId: entry.corrId,
              operationId: entry.operationId,
              operationAttempt: entry.operationAttempt,
              operationSource: entry.operationSource,
              backendGeneration: entry.backendGeneration,
              sessionPath: entry.sessionPath,
              text: entry.text,
              inputs: entry.inputs,
              composedText: entry.composedText,
              localId: entry.localId,
              userParts: entry.userParts,
              previousSummary: entry.previousSummary,
              timestamp: entry.timestamp,
              priorPruningMode: entry.priorPruningMode,
            },
          });
        }
      } catch (err) {
        this.deps.log.log('error', `DrainBackendReadyQueue failed: ${toErrorMessage(err)}`);
      }
    })();
  }

  /** Replay deferred picker choices through the ordinary SetModel command so
   * all capability checks, optimistic rollback, settings persistence, and
   * model-write fences stay centralized in the reducer. */
  private handleDrainDeferredSetModelQueue(effect: DrainDeferredSetModelQueueEffect): void {
    void (async () => {
      try {
        // PendingPathReplaced is published immediately before SessionOpened.
        // Yield once so the authoritative opened snapshot is reduced before
        // SetModel advances the model-write fence; otherwise that catalog would
        // be rejected as stale and the borrowed provisional list would linger.
        await Promise.resolve();
        for (const entry of effect.entries) {
          this.deps.dispatchCommand({
            kind: 'Command',
            cmd: {
              kind: 'SetModel',
              corrId: entry.corrId,
              sessionPath: entry.sessionPath,
              modelSettings: entry.modelSettings,
              deferredReplay: true,
              ...(entry.clearImages ? { clearImagesConfirmed: true } : {}),
            },
          });
        }
      } catch (err) {
        this.deps.log.log('error', `DrainDeferredSetModelQueue failed: ${toErrorMessage(err)}`);
      }
    })();
  }

  /** `StartBackendReadyWatchdog` — `timer.schedule(cb, timeoutMs)`; cb nulls
   *  `this.backendReadyWatchdog` then dispatches `BackendReadyWatchdogFired`.
   *  No try/catch; synchronous scheduling. Mutates instance state. */
  private handleStartBackendReadyWatchdog(effect: StartBackendReadyWatchdogEffect): void {
    // Start the watchdog timer if not already running. On fire, dispatch
    // BackendReadyWatchdogFired → the reducer drops the queued messages +
    // removes optimistic entries + sets a notice.
    if (!this.backendReadyWatchdog) {
      this.backendReadyWatchdog = this.timer.schedule(() => {
        this.backendReadyWatchdog = null;
        this.deps.dispatchEvent({ kind: 'BackendReadyWatchdogFired' });
      }, effect.timeoutMs);
    }
  }

  /** `CancelBackendReadyWatchdog` — `clearBackendReadyWatchdog()`. No try/catch,
   *  no result, synchronous. */
  private handleCancelBackendReadyWatchdog(_effect: CancelBackendReadyWatchdogEffect): void {
    this.clearBackendReadyWatchdog();
  }

  /** `ClearLastCompaction` — schedule a bounded TTL timer per session; on fire,
   *  dispatch `LastCompactionCleared` so the transient "Compacted" chip
   *  disappears. A newer compaction for the same session replaces the pending
   *  timer (the reducer emits a fresh effect each time). */
  private handleClearLastCompaction(effect: ClearLastCompactionEffect): void {
    const existing = this.lastCompactionTimers.get(effect.sessionPath);
    if (existing !== undefined) {
      this.timer.cancel(existing);
    }
    this.lastCompactionTimers.set(effect.sessionPath, this.timer.schedule(() => {
      this.lastCompactionTimers.delete(effect.sessionPath);
      this.deps.dispatchEvent({ kind: 'LastCompactionCleared', sessionPath: effect.sessionPath });
    }, effect.ttlMs));
  }

  /** `HydrateModel` — IIFE; `service.hydrateModelState(sessionPath)`. No
   *  result; catch: `log.log('error',…)` swallow. */
  private handleHydrateModel(effect: HydrateModelEffect): void {
    // Fire-and-forget, like PostImperative: the service's dispatched
    // ModelSettingsHydrated/AvailableModelsChanged events apply the results, so no
    // *Result event is produced here.
    void (async () => {
      try {
        await this.deps.service.hydrateModelState(effect.sessionPath, {
          hydrationRevision: effect.hydrationRevision,
          modelWriteFence: effect.modelWriteFence,
        });
      } catch (err) {
        this.deps.log.log('error', `hydrateModelState failed: ${toErrorMessage(err)}`);
      }
    })();
  }

  /** Clear the backend-ready watchdog timer (no-op if not running). */
  private clearBackendReadyWatchdog(): void {
    if (this.backendReadyWatchdog) {
      this.timer.cancel(this.backendReadyWatchdog);
      this.backendReadyWatchdog = null;
    }
  }

  /** Compatibility hook preserved on the single effect-executor façade. */
  abortInFlightSend(sessionPath: string): boolean {
    return this.sessionOperations.abortInFlightSend(sessionPath);
  }

  /** Dispose of every opaque execution resource owned below this façade. */
  dispose(): void {
    this.clearBackendReadyWatchdog();
    this.sessionOperations.dispose();
    for (const timer of this.lastCompactionTimers.values()) this.timer.cancel(timer);
    this.lastCompactionTimers.clear();
    for (const timer of this.openReconciliationTimers.values()) this.timer.cancel(timer);
    this.openReconciliationTimers.clear();
  }

  /** Generic session RPCs remain FIFO-ordered without occupying the global
   * lifecycle queue. Stateful operation execution delegates to
   * `sessionOperations` before reaching this path. */
  private runRpc(effect: RpcEffect): void {
    const { queues } = this.deps;
    void queues.enqueueSessionOperation(effect.sessionPath, async () => {
      await this.executeGenericRpc(effect);
    });
  }

  private async executeGenericRpc(effect: RpcEffect): Promise<void> {
    const { backend, dispatch } = this.deps;
    try {
      await backend.request(rpcMethodFor(effect), rpcParamsFor(effect));
      dispatch(rpcResultFor(effect, { ok: true }));
    } catch (err) {
      const error = toErrorMessage(err);
      // A response timeout can race a backend acknowledgement: the backend
      // consumes the dialog response, the host restores it, then the retry
      // receives UI_REQUEST_NOT_PENDING. That state is terminal rather than
      // retryable—the dialog no longer has an owner—so reconcile it as
      // success instead of restoring a permanently stale prompt.
      if (
        effect.kind === 'ExtensionUiResponseRpc'
        && error === 'The extension UI request is no longer pending.'
      ) {
        dispatch(rpcResultFor(effect, { ok: true }));
      } else {
        dispatch(rpcResultFor(effect, { ok: false, error }));
      }
    }
  }

  private runReplaceQueueRpc(effect: ReplaceQueueRpcEffect): void {
    const { queues, backend, dispatch } = this.deps;
    void queues.enqueueSessionOperation(effect.sessionPath, async () => {
      try {
        const response = await backend.request<{ updated: boolean; queueCleared?: boolean; error?: string }>('message.replaceQueue', {
          sessionPath: effect.sessionPath,
          messages: effect.messages,
          fallbackMessages: effect.fallbackMessages,
        });
        dispatch({
          kind: 'ReplaceQueueResult', corrId: effect.corrId, sessionPath: effect.sessionPath,
          messageId: effect.messageId, ok: response.updated, text: effect.text, inputs: effect.inputs,
          composedText: effect.composedText, userParts: effect.userParts,
          ...(response.queueCleared ? { error: `QUEUE_REPLACE_FAILED: ${response.error ?? 'queue cleared'}` } : {}),
        });
      } catch (err) {
        dispatch({
          kind: 'ReplaceQueueResult', corrId: effect.corrId, sessionPath: effect.sessionPath,
          messageId: effect.messageId, ok: false, text: effect.text, inputs: effect.inputs,
          composedText: effect.composedText, userParts: effect.userParts, error: toErrorMessage(err),
        });
      }
    });
  }

  /**
   * Create/open session lifecycle. Delegates to the session service, which
   * performs the full tab lifecycle setup: registering a selection-request
   * token (so the backend's `session.opened` event activates and opens the
   * tab), inserting a placeholder summary, dispatching `TabOpened`/
   * `SelectSession`, persisting tabs, and enqueueing the backend RPC with the
   * registered token. Calling the backend directly here would skip that setup
   * and the new/opened session would never activate.
   *
   * The service methods dispatch arch events synchronously, so we defer them to
   * a microtask (matching `CloseSession`/`DuplicateSession`) to avoid
   * re-entrant dispatch while the outer effects loop is still running.
   */
  private handleScheduleOpenSessionReconciliation(
    effect: Extract<Effect, { kind: 'ScheduleOpenSessionReconciliation' }>,
  ): void {
    const key = `${effect.operationId}:${effect.operationAttempt}`;
    if (this.openReconciliationTimers.has(key)) return;
    const handle = this.timer.schedule(() => {
      this.openReconciliationTimers.delete(key);
      this.deps.dispatchEvent({
        kind: 'OpenSessionReconciliationDue',
        operationId: effect.operationId,
        sessionPath: effect.sessionPath,
        operationAttempt: effect.operationAttempt,
        backendGeneration: effect.backendGeneration,
      });
    }, effect.delayMs);
    this.openReconciliationTimers.set(key, handle);
  }

  private handleRecoverOpenSession(effect: Extract<Effect, { kind: 'RecoverOpenSession' }>): void {
    queueMicrotask(() => {
      this.deps.service.handleSelectionFailure(
        effect.selectionToken,
        effect.notice,
        effect.operationAttempt,
      );
    });
  }

  private runLifecycle(effect: Extract<Effect, { kind: 'OpenSession' | 'CreateSession' | 'DuplicateSession' }>): void {
    const { service, backend, queues, dispatch } = this.deps;
    if (effect.kind === 'OpenSession') {
      // OpenSession: the reducer already did the optimistic tab setup; the
      // runner owns the backend session.open RPC, serialized on the lifecycle
      // queue (shared with create/close). The selection token was minted in
      // service.openSession() BEFORE the reducer activated the opened tab, so
      // handleSelectionFailure can restore the previous active path on
      // failure. On failure handleSelectionFailure dispatches the reducer
      // transitions that undo the optimistic setup (CloseTab / SelectSession-
      // fallback / SessionScopeCleared / NoticeShown) — so the reducer's
      // OpenSessionResult handler stays a no-op, matching CreateSession.
      void queues.enqueueLifecycle(async () => {
        try {
          // Skip-transcript optimization: when the host already has this
          // session's transcript loaded AND it isn't actively streaming,
          // request a metadata-only `session.opened` (no multi-MB tail window).
          // First load and any running session get the full authoritative
          // snapshot.
          if (effect.backendGeneration !== undefined
            && service.getBackendGeneration
            && service.getBackendGeneration() !== effect.backendGeneration) {
            throw new Error('backend generation changed before open started');
          }
          const transcript = service.getOpenTranscriptMode(effect.sessionPath);
          service.captureSelectionRequestStart?.(effect.selectionToken, effect.operationAttempt);
          const resultFields = effect.operationId ? {
            operationId: effect.operationId,
            operationAttempt: effect.operationAttempt,
            backendGeneration: effect.backendGeneration,
          } : {};
          await backend.request('session.open', {
            sessionPath: effect.sessionPath,
            selectionToken: effect.selectionToken,
            transcript,
            ...(effect.operationId ? {
              operationId: effect.operationId,
              operationAttempt: effect.operationAttempt,
            } : {}),
          }, effect.operationId ? {
            onCorrelatedResponse: (response) => dispatch({
              kind: 'OpenSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath,
              ...resultFields,
              ok: response.ok,
              ...(!response.ok ? { error: toErrorMessage(response.error) } : {}),
            }),
          } : undefined);
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ...resultFields,
            ok: true,
          });
        } catch (err) {
          const ambiguous = err instanceof RequestTimeoutError;
          if (!ambiguous) {
            service.handleSelectionFailure(effect.selectionToken, `Failed to open session: ${toErrorMessage(err)}`);
          }
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ...(effect.operationId ? {
              operationId: effect.operationId,
              operationAttempt: effect.operationAttempt,
              backendGeneration: effect.backendGeneration,
            } : {}),
            ok: false,
            ...(ambiguous ? { ambiguous: true } : {}),
            error: toErrorMessage(err),
          });
        }
      });
      return;
    }
    if (effect.kind === 'DuplicateSession') {
      // DuplicateSession: the reducer already did the optimistic tab setup
      // (placeholder copy tab inserted adjacent to the source); the runner
      // owns the backend session.duplicate RPC, serialized on the lifecycle
      // queue (shared with create/open). The selection token was minted in
      // service.duplicateSession() BEFORE the reducer activated the copy tab,
      // so handleSelectionFailure can restore the previous active path on
      // failure. On failure handleSelectionFailure dispatches the reducer
      // transitions that undo the optimistic setup (CloseTab /
      // SelectSession-fallback / SessionScopeCleared / NoticeShown) — so the
      // reducer's DuplicateSessionResult handler stays a no-op, mirroring
      // CreateSession.
      void queues.enqueueLifecycle(async () => {
        try {
          if (effect.backendGeneration !== undefined
            && service.getBackendGeneration
            && service.getBackendGeneration() !== effect.backendGeneration) {
            service.handleSelectionFailure(
              effect.selectionToken,
              'PI backend generation ended while the session was being duplicated.',
              effect.operationAttempt,
              'backend-generation-ended',
            );
            dispatch({
              kind: 'DuplicateSessionResult',
              corrId: effect.corrId,
              sessionPath: effect.sessionPath,
              ...(effect.operationId ? { operationId: effect.operationId } : {}),
              ok: false,
              error: 'backend generation changed before duplicate started',
            });
            return;
          }
          service.captureSelectionRequestStart?.(effect.selectionToken, effect.operationAttempt);
          const response = await backend.request<{ sessionPath?: string }>('session.duplicate', {
            sessionPath: effect.sourceSessionPath,
            selectionToken: effect.selectionToken,
            ...(effect.operationId ? { operationId: effect.operationId } : {}),
            ...(effect.operationAttempt !== undefined ? { operationAttempt: effect.operationAttempt } : {}),
          });
          const resolvedPath = response.sessionPath ?? effect.sessionPath;
          if (effect.operationId && response.sessionPath) {
            service.handleCreateOperationAcknowledged?.(effect.selectionToken, effect.operationId, response.sessionPath);
          }
          dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, sessionPath: resolvedPath, ...(effect.operationId ? { operationId: effect.operationId } : {}), ok: true });
        } catch (err) {
          const message = toErrorMessage(err);
          if (effect.operationId && isLocalRequestTimeout(err) && service.handleCreateOperationDelayed) {
            service.handleCreateOperationDelayed(effect.selectionToken, effect.operationId, `Timed out waiting to duplicate session. The session is still being created; retry or wait for completion.`, effect.operationAttempt);
          } else {
            service.handleSelectionFailure(effect.selectionToken, `Failed to duplicate session: ${message}`, effect.operationAttempt);
          }
          dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ...(effect.operationId ? { operationId: effect.operationId } : {}), ok: false, error: message });
        }
      });
      return;
    }
    // CreateSession: the reducer already did the optimistic tab setup; the
    // runner owns the backend session.create RPC, serialized on the lifecycle
    // queue (shared with open/close). The selection token was minted in
    // service.createNewSession() BEFORE the reducer activated the pending tab,
    // so handleSelectionFailure can restore the previous active path on
    // failure. On failure handleSelectionFailure dispatches the reducer
    // transitions that undo the optimistic setup (CloseTab / SelectSession-
    // fallback / SessionScopeCleared / NoticeShown) — so the reducer's
    // CreateSessionResult handler stays a no-op, matching the pre-migration
    // recovery path.
    void queues.enqueueLifecycle(async () => {
      try {
        if (effect.backendGeneration !== undefined
          && service.getBackendGeneration
          && service.getBackendGeneration() !== effect.backendGeneration) {
          service.handleSelectionFailure(
            effect.selectionToken,
            'PI backend generation ended while the session was being created.',
            effect.operationAttempt,
            'backend-generation-ended',
          );
          dispatch({
            kind: 'CreateSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ...(effect.operationId ? { operationId: effect.operationId } : {}),
            ok: false,
            error: 'backend generation changed before create started',
          });
          return;
        }
        service.captureSelectionRequestStart?.(effect.selectionToken, effect.operationAttempt);
        const response = await backend.request<{ sessionPath?: string }>('session.create', {
          cwd: effect.cwd,
          selectionToken: effect.selectionToken,
          ...(effect.operationId ? { operationId: effect.operationId } : {}),
          ...(effect.operationAttempt !== undefined ? { operationAttempt: effect.operationAttempt } : {}),
        });
        if (effect.operationId && response.sessionPath) {
          service.handleCreateOperationAcknowledged?.(effect.selectionToken, effect.operationId, response.sessionPath);
        }
        dispatch({
          kind: 'CreateSessionResult',
          corrId: effect.corrId,
          sessionPath: response.sessionPath ?? effect.sessionPath,
          ...(effect.operationId ? { operationId: effect.operationId } : {}),
          ok: true,
        });
      } catch (err) {
        const message = toErrorMessage(err);
        if (effect.operationId && isLocalRequestTimeout(err) && service.handleCreateOperationDelayed) {
          service.handleCreateOperationDelayed(effect.selectionToken, effect.operationId, `Timed out waiting to create session. The session is still being created; retry or wait for completion.`, effect.operationAttempt);
        } else {
          service.handleSelectionFailure(effect.selectionToken, `Failed to create session: ${message}`, effect.operationAttempt);
        }
        dispatch({
          kind: 'CreateSessionResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ...(effect.operationId ? { operationId: effect.operationId } : {}),
          ok: false,
          error: message,
        });
      }
    });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Only the transport deadline is ambiguous loss of acknowledgement. Backend
 * operational failures may contain similar words and must remain definitive. */
function isLocalRequestTimeout(error: unknown): boolean {
  return error instanceof RequestTimeoutError
    || (typeof error === 'object' && error !== null
      && (error as { name?: unknown }).name === 'RequestTimeoutError'
      && (error as { code?: unknown }).code === 'PIE_RPC_TIMEOUT');
}

/** RPC kinds handled directly by the generic session FIFO path. */
type RpcEffect = ClearQueueRpcEffect | TruncateRpcEffect | ExtensionUiResponseRpcEffect;

function rpcMethodFor(effect: RpcEffect): string {
  switch (effect.kind) {
    case 'ClearQueueRpc':
      return 'message.clearQueue';
    case 'TruncateRpc':
      return 'session.truncateAfter';
    case 'ExtensionUiResponseRpc':
      return 'extension_ui.response';
  }
}

function rpcParamsFor(effect: RpcEffect): unknown {
  switch (effect.kind) {
    case 'ClearQueueRpc':
      return { sessionPath: effect.sessionPath };
    case 'TruncateRpc':
      return { sessionPath: effect.sessionPath, entryId: effect.messageId };
    case 'ExtensionUiResponseRpc':
      return { sessionPath: effect.sessionPath, response: effect.response };
  }
}

function rpcResultFor(
  effect: RpcEffect,
  outcome: { ok: true } | { ok: false; error: string },
): EffectResultEvent {
  const base = {
    corrId: effect.corrId,
    sessionPath: effect.sessionPath,
    ...outcome,
  };
  switch (effect.kind) {
    case 'ClearQueueRpc':
      return { kind: 'ClearQueueResult', ...base };
    case 'TruncateRpc':
      return { kind: 'TruncateResult', ...base };
    case 'ExtensionUiResponseRpc':
      return { kind: 'ExtensionUiResponseResult', ...base };
  }
}
