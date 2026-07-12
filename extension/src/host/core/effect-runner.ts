/**
 * Phase 2 type spine — `EffectRunner` skeleton.
 *
 * The runner is the **only** place that performs side effects in the new
 * architecture. It owns no state. It consumes `Effect`s and produces
 * `Event`s (specifically `*Result` variants) via a `dispatch` callback.
 *
 * Routing rules (binding for all later phases — see plan §Phase 2):
 *  - `*Rpc` effects use the **double-wrap**
 *    `enqueueLifecycle(() => enqueueSessionOperation(sessionPath, do_rpc))` so
 *    they serialize correctly with legacy `send`/`edit` paths during the
 *    multi-phase migration.
 *  - Existing-session lifecycle effects use `enqueueLifecycle` only (the
 *    inner per-session queue may not be addressable yet). `CreateSession`
 *    dispatches directly because it has no ordering dependency on unrelated
 *    session work; selection tokens reconcile late responses.
 *  - `PersistTabs` and `Log` execute directly without queueing.
 *  - `PostImperative` sends an imperative message to the webview via the
 *    `postImperative` callback.
 *
 * The runner never inspects state. All routing decisions are derived from the
 * effect's discriminator. Result dispatch is async via `Promise` → microtask,
 * which precludes re-entrant blocking even if a reducer chains effects.
 *
 * Dispatch is a `Record<Effect['kind'], EffectHandler>` table — the key type
 * gives compile-time exhaustiveness for free (every kind MUST have an entry or
 * the object literal won't type-check). The 12 pure 1:1 `*Result` kinds are
 * built by {@link EffectRunner.templateRow}; the 19 kinds with non-template
 * control flow are named handler methods (or delegate to `runRpc` /
 * `runLifecycle`).
 */

import type {
  Effect,
  SendRpcEffect,
  EditRpcEffect,
  InterruptRpcEffect,
  ClearQueueRpcEffect,
  TruncateRpcEffect,
  ExtensionUiResponseRpcEffect,
  ShowModelSwitchConfirmEffect,
  SetModelRpcEffect,
  SetPrefsRpcEffect,
  SetSystemPromptTogglesRpcEffect,
  HydrateModelEffect,
  LogEffect,
  PostImperativeEffect,
  OpenFileEffect,
  DrainPendingSendQueueEffect,
  DrainBackendReadyQueueEffect,
  StartBackendReadyWatchdogEffect,
  CancelBackendReadyWatchdogEffect,
  StartQueuedDwellWatchdogEffect,
  CancelQueuedDwellWatchdogEffect,
  PostImperativeMessage,
} from './effects';
import { toErrorMessage } from '../util/error-message';
import type { EffectResultEvent, CommandEvent } from './events';
import type { FileDiffService } from './file-diff-service';
import type { ChatPrefs, ComposerInput, PruningMode, PruningSettings, ToolResultPruningSettings, RunOutcome, SessionOpenedPayload, ThinkingLevel, UserContentPart } from '../../shared/protocol';
import type { RequestOptions } from '../../shared/request-tracker';

/** Minimal backend surface the runner needs. Matches `BackendClient.request`. */
export interface BackendLike {
  /** Issue a JSON-RPC request. `options.timeoutMs` overrides the method
   *  default; `options.signal` aborts an in-flight request (Brief E cancels
   *  an in-flight `message.send` on interrupt). */
  request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T>;
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
  persistTabs(openTabPaths: string[], activeSessionPath: string | null, pinnedTabPaths: string[]): Promise<void>;
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
  hydrateModelState(sessionPath: string): Promise<void>;
  setPrefs(prefs: Partial<ChatPrefs>): void;
  /** Push the complete disabled-entry set for a session's system prompts to the
   *  backend (`systemPromptToggles.set`). Fire-and-forget: the backend re-emits
   *  `session.opened` to update host state, so no *Result event is expected. */
  setSystemPromptToggles(sessionPath: string, disabledEntries: readonly string[]): Promise<void>;
  bumpSessionDataEpoch(sessionPath: string): void;
  /** Notify the run-analytics observer that a session's model config changed
   *  (disk-persisting side effect, not ArchState). Effect-side concern. */
  onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: ThinkingLevel): void;
  suppressNextCompletionNotificationFor(sessionPath: string): void;
  loadOlderTranscript(sessionPath: string): Promise<void>;
  loadNewerTranscript(sessionPath: string): Promise<void>;
  jumpToLatestTranscript(sessionPath: string): Promise<void>;
  closeSession(sessionPath: string, nextPath: string | null): Promise<void>;
  setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
  setToolResultPruningSettings(updates: Partial<ToolResultPruningSettings>): Promise<void>;
  /** Recover from a failed/timed-out selection: finish the request and
   *  dispatch the reducer transitions that undo the optimistic tab setup
   *  (CloseTab / SelectSession-fallback / SessionScopeCleared / NoticeShown). */
  handleSelectionFailure(selectionToken: string, notice: string): void;
  /** Reconcile the authoritative payload returned by create/open/duplicate.
   * Backend events carry the same payload, but RPC responses have a priority
   * transport lane so lifecycle completion cannot be starved by stream data. */
  applySessionOpened(payload: SessionOpenedPayload): void;
  /** Decide whether a `session.open` for `sessionPath` can skip the
   *  transcript round-trip: returns `'skip'` when the host already has the
   *  session's transcript window loaded and the session is not actively
   *  streaming, otherwise `'tail'` (full authoritative snapshot). */
  getOpenTranscriptMode(sessionPath: string): import('../../shared/protocol').TranscriptMode;
}

export interface StatsServiceLike {
  prepareForSend(sessionPath: string, inputs: ComposerInput[]): void;
  onTruncatedAfter(sessionPath: string, messageId: string): void;
  onMessageEdited(sessionPath: string, messageId: string): void;
  recordOutcome(sessionPath: string, outcome: RunOutcome): void;
  startNewTask(sessionPath: string): void;
  continueTask(sessionPath: string): void;
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
  /**
   * Override the model-start send-timer budget (default 600s / 10min). The
   *  send-timer is RE-ARMED with this budget once the pruning prepass succeeds
   *  (see `ReArmSendTimer`): the remaining wait is model-start (concurrency /
   *  rate-limit / first-token), which can legitimately be long, so it gets a
   *  far more generous budget than the prepass window. A fire after re-arm
   *  carries the model-start error string so the notice blames model-start,
   *  not pruning. Sized to bound a genuinely-stuck turn without tripping a
   *  false positive on an intended concurrency wait. Used by tests to avoid
   *  waiting the full 10min.
   */
  modelStartTimerTimeoutMs?: number;
  /**
   * Read the live provider-gate concurrency metrics (cached host-side in
   * `AggregateStats.providerGate`, polled from the backend's `ProviderGate`).
   * Used by the model-start send-timer re-arm path to detect when the
   * in-flight request's provider is legitimately QUEUED (`queuedRequests>0`)
   * or PAUSED (circuit breaker), so the timer re-arms instead of firing a
   * false-positive `PreflightFailed`. Optional + FAIL-OPEN: when absent (or
   * when it returns undefined), the gate is skipped and the timer fires as
   * today. The shape is the minimal slice the runner reasons over.
   */
  getProviderGateMetrics?: () => { providers: Array<{ provider: string; queuedRequests: number; paused: boolean }> } | undefined;
  /**
   * Resolve the provider name an in-flight send's request would route to, so
   * the model-start re-arm path can match it against `getProviderGateMetrics`.
   * Resolves the session's current model id (else the global default) → the
   * matching model entry's `provider`. Optional + FAIL-OPEN: when absent (or
   * when it returns undefined), the provider can't be matched and the timer
   * fires as today.
   */
  resolveSessionProvider?: (sessionPath: string) => string | undefined;
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

/** Per-send in-flight context for the post-ack send-timer (Brief B). The
 *  send-timer owns the pre-ack-to-first-delta phase; on fire it dispatches
 *  `PreflightFailed` (post-ack, `requestId` known). The `abort` controller is
 *  passed to `backend.request` so Brief E can cancel an in-flight
 *  `message.send` on interrupt. Keyed by `corrId` in `EffectRunner`. */
interface InFlightSend {
  corrId: string;
  sessionPath: string;
  /** Which optimistic op this is — surfaces in the fire error + rollback kind. */
  kind: 'send' | 'edit';
  /** The local transcript ID for the optimistic user message. Kept so a late
   *  `PreflightSuperseded` retraction can re-insert the exact message. */
  localId: string;
  /** The composed text for the optimistic user message (re-inserted on supersede). */
  composedText: string;
  /** User content parts for the optimistic user message (send only). */
  userParts?: UserContentPart[];
  /** The send-timer handle (cleared at the commit point / pre-ack failure / fire). */
  timer: TimerHandle | null;
  /** The budget this send's timer was armed with (prepass-aware when
   *  `getSendTimerTimeoutMs` is wired); surfaces in the fire error message. */
  budgetMs: number;
  /** Which budget the timer is currently armed with: `prepass` (the tight
   *  `prepassTimeoutSec` + headroom budget armed at send-dispatch) or
   *  `modelStart` (the generous model-start budget set by `ReArmSendTimer`
   *  once pruning succeeds). Determines the fire error string so the notice
   *  blames the right cause (pruning vs model-start). */
  phase: 'prepass' | 'modelStart';
  /** Absolute epoch-ms the model-start phase was FIRST armed (set once in
   *  `reArmInFlightSend` when the prepass succeeds). Used by the metric-gated
   *  re-arm path in `onSendTimerFire` to enforce a HARD CEILING on the total
   *  model-start wall-clock wait, so a genuinely-stuck turn (a queue that
   *  never drains) still fires. Absent during the prepass phase (only the
   *  modelStart phase tracks the ceiling). */
  modelStartFirstArmedAt?: number;
  /** Caller-owned cancel controller passed to `backend.request` as the signal. */
  abort: AbortController;
  /** Backend-assigned request id, stamped after early-ack so the fire callback
   *  can dispatch `PreflightFailed` with it. */
  requestId?: string;
  /** Guards against double-settle (fire after clear, etc.). */
  disposed: boolean;
  /** Set to true when the post-ack send-timer fires and `PreflightFailed` is
   *  dispatched. A later `ClearSendTimer` (late commit) detects this and emits
   *  a `PreflightSuperseded` retraction so the UI undoes the false-positive
   *  rollback. */
  fired: boolean;
  /** Brief H: prior pruning mode captured before a "retry without pruning" send
   *  disabled pruning. Restored when this in-flight send resolves (commit /
   *  fire / pre-ack failure) so pruning returns to the user's prior mode for the
   *  next turn. Absent on a normal send (no restore). */
  priorPruningMode?: PruningMode;
  /** FP-C4: true once the EffectRunner has dispatched `WaitingForSlotShown` for
   *  this send, so a re-arm doesn't re-dispatch on every cycle (the modelStart
   *  timer re-arms ~every 10min while the provider stays saturated). Cleared
   *  on commit (`clearInFlightSend` → `WaitingForSlotCleared`) and on fire
   *  (`onSendTimerFire` fire branch). NOT cleared on `dispose()` — dispose is
   *  extension-shutdown teardown (the ArchState is torn down with the host),
   *  so no stuck notice is observable; `clearInFlightSend` owns the live clears. */
  waitingForSlotShown?: boolean;
}

export class EffectRunner {
  /** The backend-ready watchdog timer. Started by `StartBackendReadyWatchdog`,
   * cleared by `CancelBackendReadyWatchdog` / `DrainBackendReadyQueue` / fire. */
  private backendReadyWatchdog: TimerHandle | null = null;

  /** Per-message queued dwell watchdogs, keyed by optimistic localId. */
  private queuedDwellWatchdogs = new Map<string, TimerHandle>();

  /** Per-corrId in-flight send/edit context: the post-ack send-timer + the
   *  abort controller (Brief E cancels an in-flight `message.send` on
   *  interrupt). Keyed by corrId, with a `sessionPath → corrId` index for
   *  cancel-by-session. */
  private inFlightSends: Map<string, InFlightSend> = new Map();

  /** Secondary index: which corrId owns the in-flight send for a session
   *  (one at a time under FIFO serialization). Used by `abortInFlightSend`. */
  private inFlightSendBySession: Map<string, string> = new Map();

  /** Injectable timer sink (real timers in production, fake in tests). */
  private readonly timer: TimerSink;

  /** The send-timer budget. Sized for worst-case prepass + first-token
   *  latency (post-Brief-A early-ack). On fire, dispatches `PreflightFailed`
   *  so the reducer reverts via `pending.promoted[corrId]`. */
  private static readonly SEND_TIMER_TIMEOUT_MS = 120_000;

  /** The model-start budget the send-timer is RE-ARMED with once the pruning
   *  prepass succeeds (`ReArmSendTimer`). The remaining wait is model-start
   *  (concurrency/rate-limit/first-token), which can legitimately be long, so
   *  this is far more generous than the prepass budget. Sized to bound a
   *  genuinely-stuck turn (a silent hang after pruning) without tripping a
   *  false positive on an intended concurrency wait. A fire after re-arm
   *  carries the model-start error string so the notice blames model-start,
   *  not pruning. */
  private static readonly MODEL_START_TIMER_TIMEOUT_MS = 600_000;

  /** Hard ceiling on total model-start wall-clock wait across metric-gated
   *  re-arms. When the provider-gate re-arm path keeps extending the timer
   *  because the in-flight request's provider is legitimately queued/paused,
   *  this guarantees a genuinely-stuck turn (a queue that never drains, a
   *  deadlocked slot) still fires after a bounded time. ~2× the single
   *  model-start budget (20 min): long enough to outlast a normal provider-
   *  saturation drain, short enough to bound a hang. */
  private static readonly MODEL_START_HARD_CEILING_MS = EffectRunner.MODEL_START_TIMER_TIMEOUT_MS * 2;

  private readonly sendTimerTimeoutMs: number;

  private readonly modelStartTimerTimeoutMs: number;

  /** Dispatch table: one handler per `Effect['kind']`. The `Record` key type
   *  forces every kind to have an entry (compile-time exhaustiveness). Built
   *  once in the constructor. */
  private readonly handlers: Record<Effect['kind'], EffectHandler>;

  constructor(private readonly deps: EffectRunnerDeps) {
    this.sendTimerTimeoutMs = deps.sendTimerTimeoutMs ?? EffectRunner.SEND_TIMER_TIMEOUT_MS;
    this.modelStartTimerTimeoutMs = deps.modelStartTimerTimeoutMs ?? EffectRunner.MODEL_START_TIMER_TIMEOUT_MS;
    this.timer = deps.timer ?? defaultTimerSink;
    this.handlers = {
      // ── RPC kinds: route through the double-wrap. `runRpc` short-circuits
      //    Send→runSendRpc / Edit→runEditRpc; Interrupt sets the host-local
      //    completion-suppression flag synchronously before enqueue; Truncate /
      //    ExtensionUiResponse take the generic rpcMethodFor/rpcParamsFor/
      //    rpcResultFor path. ──
      SendRpc: (e) => this.runRpc(e),
      EditRpc: (e) => this.runRpc(e),
      InterruptRpc: (e) => this.runRpc(e),
      ClearQueueRpc: (e) => this.runRpc(e),
      TruncateRpc: (e) => this.runRpc(e),
      ExtensionUiResponseRpc: (e) => this.runRpc(e),
      // ── Lifecycle kinds (existing sessions queue; fresh create is direct). ──
      OpenSession: (e) => this.runLifecycle(e),
      CreateSession: (e) => this.runLifecycle(e),
      DuplicateSession: (e) => this.runLifecycle(e),
      // ── Special kinds (non-template control flow → named handlers). ──
      ShowModelSwitchConfirm: (e) => this.handleShowModelSwitchConfirm(e),
      SetModelRpc: (e) => this.handleSetModelRpc(e),
      SetPrefsRpc: (e) => this.handleSetPrefsRpc(e),
      SetSystemPromptTogglesRpc: (e) => this.handleSetSystemPromptTogglesRpc(e),
      Log: (e) => this.handleLog(e),
      PostImperative: (e) => this.handlePostImperative(e),
      OpenFile: (e) => this.handleOpenFile(e),
      DrainPendingSendQueue: (e) => this.handleDrainPendingSendQueue(e),
      DrainBackendReadyQueue: (e) => this.handleDrainBackendReadyQueue(e),
      StartBackendReadyWatchdog: (e) => this.handleStartBackendReadyWatchdog(e),
      CancelBackendReadyWatchdog: (e) => this.handleCancelBackendReadyWatchdog(e),
      StartQueuedDwellWatchdog: (e) => this.handleStartQueuedDwellWatchdog(e),
      CancelQueuedDwellWatchdog: (e) => this.handleCancelQueuedDwellWatchdog(e),
      // ── Send-timer (Brief B): clear the post-ack send-timer at the commit
      //    point (the reducer emits this in `handleMessageStarted` where it
      //    drops `pending.promoted`). ──
      ClearSendTimer: (e) => this.clearInFlightSend(e.corrId),
      ReArmSendTimer: (e) => this.reArmInFlightSend(e.corrId),
      HydrateModel: (e) => this.handleHydrateModel(e),
      // ── Template rows (pure 1:1 effect → *Result). ──
      FileDiff: this.templateRow({ resultKind: 'FileDiffResult', withSessionPath: true, call: (e, d) => d.fileDiffService.openFileDiff(e.sessionPath, e.filePath) }),
      FileRevert: this.templateRow({ resultKind: 'FileRevertResult', withSessionPath: true, call: (e, d) => d.fileDiffService.revertFile(e.sessionPath, e.filePath) }),
      LoadOlderTranscript: this.templateRow({ resultKind: 'LoadOlderTranscriptResult', withSessionPath: true, call: (e, d) => d.service.loadOlderTranscript(e.sessionPath) }),
      LoadNewerTranscript: this.templateRow({ resultKind: 'LoadNewerTranscriptResult', withSessionPath: true, call: (e, d) => d.service.loadNewerTranscript(e.sessionPath) }),
      JumpToLatestTranscript: this.templateRow({ resultKind: 'JumpToLatestTranscriptResult', withSessionPath: true, call: (e, d) => d.service.jumpToLatestTranscript(e.sessionPath) }),
      RecordOutcome: this.templateRow({ resultKind: 'RecordOutcomeResult', withSessionPath: false, call: (e, d) => { d.statsService.recordOutcome(e.sessionPath, e.outcome); } }),
      StartNewTask: this.templateRow({ resultKind: 'StartNewTaskResult', withSessionPath: false, call: (e, d) => { d.statsService.startNewTask(e.sessionPath); } }),
      ContinueTask: this.templateRow({ resultKind: 'ContinueTaskResult', withSessionPath: false, call: (e, d) => { d.statsService.continueTask(e.sessionPath); } }),
      OpenFileInEditor: this.templateRow({ resultKind: 'OpenFileInEditorResult', withSessionPath: false, call: (e, d) => d.fileDiffService.openFileInEditor(e.sessionPath, e.filePath) }),
      SetPruningSettings: this.templateRow({ resultKind: 'SetPruningSettingsResult', withSessionPath: false, call: (e, d) => d.service.setPruningSettings(e.settings) }),
      SetToolResultPruningSettings: this.templateRow({ resultKind: 'SetToolResultPruningSettingsResult', withSessionPath: false, call: (e, d) => d.service.setToolResultPruningSettings(e.settings) }),
      CloseSession: this.templateRow({ resultKind: 'CloseSessionResult', withSessionPath: true, call: (e, d) => d.service.closeSession(e.sessionPath, e.nextPath) }),
      PersistTabs: this.templateRow({ resultKind: 'PersistTabsResult', withSessionPath: false, call: (e, d) => d.tabs.persistTabs(e.openTabPaths, e.activeSessionPath, e.pinnedTabPaths) }),
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
        payload.hasActiveSession = !!effect.activeSessionPath;
        break;
      case 'SetPrefsRpc':
        payload.prefKeys = Object.keys(effect.prefs);
        break;
      case 'SetPruningSettings':
      case 'SetToolResultPruningSettings':
        payload.settingKeys = Object.keys(effect.settings);
        break;
    }

    this.deps.log.log('info', 'effect.dispatch', payload);
  }

  // ─── Template rows ────────────────────────────────────────────────────────

  /** Build the standard async-IIFE + try/catch + `dispatch({kind, corrId,
   *  [sessionPath?], ok, error?})` handler for a pure 1:1 effect→result row.
   *
   *  `call` returns a `Promise` for await-rows and `void` for sync rows
   *  (RecordOutcome / StartNewTask / ContinueTask call sync stats methods).
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

  /** `ShowModelSwitchConfirm` — modal confirmation. NOT queued on the
   *  lifecycle queue (a modal must not block session create/open). Dispatches
   *  `ModelSwitchConfirmResult{corrId, confirmed}` (no `ok`/`error`/
   *  `sessionPath`); on modal throw, logs + dispatches `{confirmed:false}`
   *  (no error field). */
  private handleShowModelSwitchConfirm(effect: ShowModelSwitchConfirmEffect): void {
    // Intentionally NOT queued on the lifecycle queue: a modal is a user
    // interaction, and holding the lifecycle queue (shared with create/open)
    // behind an open modal would block session creation while the user stares
    // at a dialog. The old service path awaited the modal *inside*
    // enqueueLifecycle, which did exactly that. VS Code serializes modal
    // dialogs itself, corrIds are independent, and the backend write
    // (SetModelRpc) still goes through the lifecycle queue — so ordering is
    // preserved where it matters. This is an improvement, not a regression.
    void (async () => {
      try {
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

  /** `SetModelRpc` — 3 sequential dep calls (settings.set → bumpSessionDataEpoch
   *  → onModelConfigChanged). `enqueueLifecycle`-only (NOT via `runRpc`).
   *  Result `SetModelResult` with `sessionPath`+`ok`+`error?`. */
  private handleSetModelRpc(effect: SetModelRpcEffect): void {
    // The reducer owns every ArchState transition (global default, per-session
    // model badge, context-usage clear, pending-image clear, rollback). The
    // runner only performs the backend write + the two Effect-side concerns
    // that are not ArchState: the host-local data epoch (transcript paging
    // staleness) and the disk-persisting run-analytics observer. Serialized
    // through the lifecycle queue to match the pre-migration service path.
    const { backend, queues, dispatch, service } = this.deps;
    void queues.enqueueLifecycle(async () => {
      try {
        const setParams: Record<string, unknown> = {
          sessionPath: effect.sessionPath,
          defaultModel: effect.modelSettings.defaultModel,
          defaultThinkingLevel: effect.modelSettings.defaultThinkingLevel,
        };
        // Only forward defaultProvider when set — avoids sending a stray
        // undefined key and keeps the wire payload minimal.
        if (effect.modelSettings.defaultProvider) {
          setParams.defaultProvider = effect.modelSettings.defaultProvider;
        }
        await backend.request('settings.set', setParams);
        service.bumpSessionDataEpoch(effect.sessionPath);
        service.onModelConfigChanged(effect.sessionPath, effect.modelSettings.defaultModel, effect.modelSettings.defaultThinkingLevel);
        dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
      } catch (err) {
        dispatch({ kind: 'SetModelResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
      }
    });
  }

  /** `SetPrefsRpc` — IIFE (not queued), `service.setPrefs(prefs)`. Result
   *  `SetPrefsResult` (NO `sessionPath`). */
  private handleSetPrefsRpc(effect: SetPrefsRpcEffect): void {
    void (async () => {
      try {
        await this.deps.service.setPrefs(effect.prefs);
        this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: true });
      } catch (err) {
        this.deps.dispatch({ kind: 'SetPrefsResult', corrId: effect.corrId, ok: false, error: toErrorMessage(err) });
      }
    })();
  }

  /** `SetSystemPromptTogglesRpc` — IIFE (not queued),
   *  `service.setSystemPromptToggles(...)`. Fire-and-forget: the backend
   *  re-emits `session.opened` (routed through `SessionOpened`) to update
   *  `systemPromptsBySession` with fresh `disabled` flags, so no `*Result`
   *  event is dispatched. Errors are logged via the audit log only — the
   *  webview's toggle state stays as-is until a successful re-emit. */
  private handleSetSystemPromptTogglesRpc(effect: SetSystemPromptTogglesRpcEffect): void {
    void (async () => {
      try {
        await this.deps.service.setSystemPromptToggles(effect.sessionPath, effect.disabledEntries);
      } catch (err) {
        this.deps.log.log('warn', 'setSystemPromptToggles failed', { scope: 'system-prompt-toggles', error: toErrorMessage(err), sessionPath: effect.sessionPath });
      }
    })();
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

  private handleStartQueuedDwellWatchdog(effect: StartQueuedDwellWatchdogEffect): void {
    const existing = this.queuedDwellWatchdogs.get(effect.localId);
    if (existing) this.timer.cancel(existing);
    const timer = this.timer.schedule(() => {
      this.queuedDwellWatchdogs.delete(effect.localId);
      this.deps.dispatchEvent({
        kind: 'QueuedDwellWatchdogFired',
        sessionPath: effect.sessionPath,
        localId: effect.localId,
      });
    }, effect.timeoutMs);
    this.queuedDwellWatchdogs.set(effect.localId, timer);
  }

  private handleCancelQueuedDwellWatchdog(effect: CancelQueuedDwellWatchdogEffect): void {
    const timer = this.queuedDwellWatchdogs.get(effect.localId);
    if (!timer) return;
    this.timer.cancel(timer);
    this.queuedDwellWatchdogs.delete(effect.localId);
  }

  /** `HydrateModel` — IIFE; `service.hydrateModelState(sessionPath)`. No
   *  result; catch: `log.log('error',…)` swallow. */
  private handleHydrateModel(effect: HydrateModelEffect): void {
    // Fire-and-forget, like PostImperative: the service's dispatched
    // ModelSettingsHydrated/AvailableModelsChanged events apply the results, so no
    // *Result event is produced here.
    void (async () => {
      try {
        await this.deps.service.hydrateModelState(effect.sessionPath);
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

  /** Start the send-timer + abort controller for an in-flight send/edit.
   *  The send-timer owns the post-ack, pre-commit phase (early-ack → first
   *  `MessageStarted`); on fire it dispatches `PreflightFailed` (post-ack,
   *  `requestId` known). The pre-ack phase is owned by the `RequestTracker`
   *  timeout (10s for `message.send`), whose rejection clears this timer via
   *  the catch block — so the send-timer never fires pre-ack in practice. */
  private startInFlightSend(
    corrId: string,
    sessionPath: string,
    kind: 'send' | 'edit',
    localId: string,
    composedText: string,
    userParts: UserContentPart[] | undefined,
    priorPruningMode?: PruningMode,
  ): InFlightSend {
    const abort = new AbortController();
    // Prepass-aware budget (read fresh each send so a runtime prepassTimeoutSec
    // change takes effect); falls back to the static override/default.
    const budgetMs = this.deps.getSendTimerTimeoutMs?.(sessionPath) ?? this.sendTimerTimeoutMs;
    const send: InFlightSend = {
      corrId,
      sessionPath,
      kind,
      localId,
      composedText,
      userParts,
      timer: null,
      budgetMs,
      phase: 'prepass',
      abort,
      disposed: false,
      fired: false,
      priorPruningMode,
    };
    send.timer = this.timer.schedule(() => this.onSendTimerFire(send), budgetMs);
    this.inFlightSends.set(corrId, send);
    // One in-flight send per session under FIFO serialization. A second send
    // for the same session (post-ack on the first, pre-ack on the second) is
    // possible; the "delete if mine" guard in clear/fire prevents the second
    // from clobbering the first's index entry.
    this.inFlightSendBySession.set(sessionPath, corrId);
    return send;
  }

  /** Decide whether the model-start send-timer should RE-ARM (the in-flight
   *  request's provider is legitimately queued/paused) instead of firing a
   *  false-positive `PreflightFailed`. Returns false (→ fire, FAIL-OPEN) when
   *  either dep is absent, the provider can't be resolved, the metrics carry
   *  no matching provider, the provider has a free slot (not queued and not
   *  paused — a genuinely-stuck turn, not a queue wait), or the hard ceiling
   *  has elapsed. Pure read of `deps` + `send.modelStartFirstArmedAt`; no state
   *  mutation (the caller schedules the re-arm). */
  private shouldReArmModelStartTimer(send: InFlightSend): boolean {
    const metrics = this.deps.getProviderGateMetrics?.();
    // FAIL-OPEN: no metrics accessor / no metrics → fire as today.
    if (!metrics) return false;
    const provider = this.deps.resolveSessionProvider?.(send.sessionPath);
    // FAIL-OPEN: can't resolve the in-flight request's provider → fire.
    if (!provider) return false;
    const entry = metrics.providers.find((p) => p.provider === provider);
    // FAIL-OPEN: no matching provider in the metrics → fire.
    if (!entry) return false;
    // The provider has a free slot and isn't paused — the wait is NOT a queue
    // wait, so the turn is genuinely stuck → fire (don't mask a real hang).
    if (!(entry.queuedRequests > 0 || entry.paused === true)) return false;
    // Hard ceiling: a queue that never drains (deadlock) must still fire.
    const firstArmed = send.modelStartFirstArmedAt ?? Date.now();
    if (Date.now() - firstArmed >= EffectRunner.MODEL_START_HARD_CEILING_MS) return false;
    return true;
  }

  /** Send-timer fire: the post-ack, pre-commit phase elapsed with no commit
   *  point. Dispatch `PreflightFailed` (the reducer rolls back via
   *  `pending.promoted[corrId]`, explicit-corrId short-circuiting its scan).
   *  If `requestId` is unknown (early-ack never happened), the pre-ack
   *  `RequestTracker` timeout should have rejected first and cleared this
   *  timer via the catch — log so the degenerate case is debuggable. The fire
   *  error string depends on `send.phase`: `prepass` (pruning still running →
   *  genuine pruning timeout) vs `modelStart` (pruning succeeded → the delay
   *  is model-start/concurrency, not pruning). The error mapper distinguishes
   *  the two strings so the notice blames the right cause.
   *
   *  Metric-gated re-arm (modelStart phase only): the model-start timer's
   *  clock started at issue time, BEFORE the request acquired its
   *  ProviderGate concurrency slot. When the in-flight request's provider is
   *  legitimately QUEUED (`queuedRequests>0`) or PAUSED (circuit breaker
   *  armed), firing now would be a FALSE-POSITIVE PreflightFailed that rolls
   *  back the user's message even though the turn would succeed once a slot
   *  frees up. Re-arm instead, up to a hard ceiling, so a genuine queue drain
   *  succeeds and only a truly-stuck turn fires. FAIL-OPEN: any missing
   *  dep/metric/provider, a non-queued/non-paused provider, or an elapsed
   *  ceiling falls through to fire (existing behavior). */
  private onSendTimerFire(send: InFlightSend): void {
    if (send.disposed) return;
    if (send.phase === 'modelStart' && this.shouldReArmModelStartTimer(send)) {
      const firstArmed = send.modelStartFirstArmedAt ?? Date.now();
      const elapsed = Date.now() - firstArmed;
      const remaining = EffectRunner.MODEL_START_HARD_CEILING_MS - elapsed;
      // FP-C4: after ~one model-start budget of queued waiting (the re-arm
      // itself only fires after the budget elapsed with the provider still
      // saturated), surface a non-blocking "still waiting for a slot" notice
      // so the user doesn't think pie hung. Dispatched once (guarded by
      // `waitingForSlotShown`); cleared on commit / fire / dispose.
      if (!send.waitingForSlotShown) {
        send.waitingForSlotShown = true;
        this.deps.dispatchEvent({
          kind: 'WaitingForSlotShown',
          sessionPath: send.sessionPath,
          message: 'Still waiting for a free model slot — the provider is busy. Your turn will start as soon as a slot opens up.',
        });
      }
      // Re-arm for the lesser of a full model-start window or the remaining
      // ceiling (clamped to ≥1s so a near-ceiling re-arm still wakes to fire
      // rather than scheduling a non-positive timeout).
      const nextBudget = Math.min(
        this.modelStartTimerTimeoutMs,
        Math.max(1000, remaining + 1),
      );
      send.timer = this.timer.schedule(() => this.onSendTimerFire(send), nextBudget);
      this.deps.log.log('debug', 'send-timer.rearmed', {
        corrId: send.corrId,
        sessionPath: send.sessionPath,
        elapsedMs: elapsed,
        ceilingMs: EffectRunner.MODEL_START_HARD_CEILING_MS,
        nextBudgetMs: nextBudget,
      });
      return;
    }
    send.disposed = true;
    send.fired = true;
    // FP-C4: clear the "still waiting for a slot" notice — the user now sees
    //  an error (PreflightFailed) or a pre-ack-fire warn. Idempotent at the
    //  reducer (no-op if absent).
    this.clearWaitingForSlotNotice(send);
    // Do NOT delete the entry from the in-flight maps yet. A late commit
    // (MessageStarted → ClearSendTimer) needs to detect `fired === true` so it
    // can dispatch a `PreflightSuperseded` retraction that undoes the false-
    // positive rollback. The entry is removed when the commit-point clear
    // arrives, or on `dispose()`.
    send.timer = null;
    // Brief H: restore pruning (a "retry without pruning" send's prepass timed
    //  out — the turn is rolling back, so pruning returns to the user's prior
    //  mode for the next turn).
    this.restorePruningMode(send);
    if (send.requestId) {
      const error = send.phase === 'modelStart'
        ? `Timed out waiting for the model to start streaming (${send.budgetMs / 1000}s)`
        : `Timed out waiting for the turn to start streaming (${send.budgetMs / 1000}s)`;
      this.deps.dispatchEvent({
        kind: 'PreflightFailed',
        corrId: send.corrId,
        sessionPath: send.sessionPath,
        requestId: send.requestId,
        error,
      });
      return;
    }
    this.deps.log.log(
      'warn',
      `send-timer fired before early-ack for corrId=${send.corrId} session=${send.sessionPath} (pre-ack RequestTracker timer should have fired first)`,
    );
  }

  /** Re-arm the post-ack send-timer with the (generous) model-start budget.
   *  Called when the pruning prepass SUCCEEDS (`ReArmSendTimer` effect, emitted
   *  by the reducer on the `pruning-result` `CustomMessage`). The send-timer was
   *  armed at send-dispatch with the tight prepass budget; once pruning is done
   *  the remaining wait is model-start (concurrency/rate-limit/first-token),
   *  which can legitimately be long, so the budget switches to
   *  `modelStartTimerTimeoutMs`. Cancels the in-flight prepass timer and starts
   *  a fresh one (the model-start window gets its own budget from this moment).
   *  No-op if the send already committed/cleared/fired (entry gone or disposed)
   *  — a late `ReArmSendTimer` after a fire/commit is harmless. */
  private reArmInFlightSend(corrId: string): void {
    const send = this.inFlightSends.get(corrId);
    if (!send || send.disposed) return;
    if (send.timer) this.timer.cancel(send.timer);
    send.budgetMs = this.modelStartTimerTimeoutMs;
    send.phase = 'modelStart';
    // Record the FIRST arming into the modelStart phase — the absolute start of
    // the model-start wait. Used by the hard-ceiling backstop in
    // `onSendTimerFire` so metric-gated re-arms cannot extend a genuinely-
    // stuck turn indefinitely. Set once (idempotent under repeat re-arm).
    if (send.modelStartFirstArmedAt === undefined) {
      send.modelStartFirstArmedAt = Date.now();
    }
    send.timer = this.timer.schedule(() => this.onSendTimerFire(send), send.budgetMs);
  }

  /** Clear the send-timer + abort context for a corrId. Called on pre-ack
   *  failure (RPC rejected — no commit will come), at the commit point
   *  (`ClearSendTimer` effect — first `MessageStarted`), and on dispose. */
  private clearInFlightSend(corrId: string): void {
    const send = this.inFlightSends.get(corrId);
    if (!send) return;
    const hadFired = send.fired;
    send.disposed = true;
    // FP-C4: clear the "still waiting for a slot" notice (commit / pre-ack
    //  failure / dispose). Idempotent at the reducer (no-op if absent).
    this.clearWaitingForSlotNotice(send);
    if (send.timer) this.timer.cancel(send.timer);
    this.inFlightSends.delete(corrId);
    if (this.inFlightSendBySession.get(send.sessionPath) === send.corrId) {
      this.inFlightSendBySession.delete(send.sessionPath);
    }

    if (hadFired && send.requestId) {
      // Late commit after a POST-ACK send-timer fire: the turn started streaming
      // after the false-positive `PreflightFailed` rollback. Emit a retraction
      // so the reducer restores the optimistic user message, clears the notice,
      // and restores the running-session state. The snapshot fields come from
      // the in-flight send context (mirroring what `runSendRpc` knew at
      // dispatch). Guard on `send.requestId`: a degenerate PRE-ACK fire (the
      // timer fired before the early-ack — `onSendTimerFire` logged it but
      // dispatched no `PreflightFailed` because there was no requestId) has
      // nothing to retract, so it falls through to the normal pruning restore
      // instead of emitting a stray `PreflightSuperseded`.
      this.deps.log.log('debug', 'send-timer.superseded', {
        corrId: send.corrId,
        requestId: send.requestId,
        sessionPath: send.sessionPath,
        budgetMs: send.budgetMs,
      });
      this.deps.dispatchEvent({
        kind: 'PreflightSuperseded',
        corrId: send.corrId,
        requestId: send.requestId ?? '',
        sessionPath: send.sessionPath,
        localId: send.localId,
        composedText: send.composedText,
        userParts: send.userParts,
        timestamp: Date.now(),
      });
      // Pruning mode was already restored when the timer fired; do not
      // restore it again here.
      return;
    }

    // Brief H: restore pruning. Reached on pre-ack failure (no commit will
    //  come) and at the commit point (ClearSendTimer — first MessageStarted).
    //  A second call (e.g. clear after fire) no-ops: the send was already
    //  deleted, so `if (!send) return` short-circuits above.
    this.restorePruningMode(send);
  }

  /** Brief H: restore pruning to the mode captured before a "retry without
   *  pruning" send disabled it. Fire-and-forget (the next turn's prepass reads
   *  the setting fresh); a failure here only means the user must re-enable
   *  pruning manually — logged so it is debuggable. No-op for a normal send
   *  (`priorPruningMode` absent). */
  private restorePruningMode(send: InFlightSend): void {
    const mode = send.priorPruningMode;
    if (!mode) return;
    void this.deps.service.setPruningSettings({ mode }).catch((err) => {
      this.deps.log.log('warn', `failed to restore pruning mode to '${mode}' after retry (corrId=${send.corrId}): ${toErrorMessage(err)}`);
    });
  }

  /** FP-C4: dispatch `WaitingForSlotCleared` for a send that had shown the
   *  "still waiting for a slot" notice, so the non-blocking info chip clears on
   *  commit / fire / dispose. No-op (and never dispatched) when the notice was
   *  never shown. The reducer's `handleWaitingForSlotCleared` is idempotent. */
  private clearWaitingForSlotNotice(send: InFlightSend): void {
    if (!send.waitingForSlotShown) return;
    send.waitingForSlotShown = false;
    this.deps.dispatchEvent({
      kind: 'WaitingForSlotCleared',
      sessionPath: send.sessionPath,
    });
  }

  /** Abort the in-flight `message.send` for a session (Brief E: interrupt
   *  cancels a slow prepass-gated send). Aborts the `AbortController` passed
   *  to `backend.request`: pre-ack, the `RequestTracker` rejects → the catch
   *  dispatches `SendResult{ok:false}`/`EditResult{ok:false}` (pre-ack
   *  rollback) and clears the send-timer. Returns true if an in-flight send
   *  was aborted. Post-ack (RPC already resolved), the abort is a no-op on
   *  the RPC; Brief E handles the post-ack interrupt via `message.interrupt`. */
  abortInFlightSend(sessionPath: string): boolean {
    const corrId = this.inFlightSendBySession.get(sessionPath);
    if (!corrId) return false;
    const send = this.inFlightSends.get(corrId);
    if (!send) return false;
    if (!send.abort.signal.aborted) send.abort.abort();
    return true;
  }

  /** Dispose of the runner's resources (called on shutdown). */
  dispose(): void {
    this.clearBackendReadyWatchdog();
    for (const timer of this.queuedDwellWatchdogs.values()) this.timer.cancel(timer);
    this.queuedDwellWatchdogs.clear();
    for (const send of this.inFlightSends.values()) {
      send.disposed = true;
      if (send.timer) this.timer.cancel(send.timer);
    }
    this.inFlightSends.clear();
    this.inFlightSendBySession.clear();
  }

  /**
   * Route `*Rpc` effects through the double-wrap. The outer `enqueueLifecycle`
   * exists to preserve serialization with legacy `send`/`edit` callers that
   * still use the same lifecycle queue directly.
   */
  private runRpc(effect: SendRpcEffect | EditRpcEffect | InterruptRpcEffect | TruncateRpcEffect | ExtensionUiResponseRpcEffect): void {
    if (effect.kind === 'EditRpc') {
      this.runEditRpc(effect);
      return;
    }
    if (effect.kind === 'SendRpc') {
      this.runSendRpc(effect);
      return;
    }
    // InterruptRpc: set the host-local completion-suppression flag for this
    // session synchronously (same tick as the click), so the busy-completed
    // handler suppresses the "run finished" notification the interrupt causes.
    // The runner is the side-effect executor — this host-local flag stays out
    // of the reducer (no read-vs-clear ordering hazard).
    //
    // Brief E — BEST-EFFORT pre-ack cancel of an in-flight message.send/edit.
    // `abortInFlightSend` aborts the AbortController passed to `backend.request`
    // synchronously and OUTSIDE the session queue, so it can unblock a send whose
    // session-op is still awaiting the (slow-prepass) RPC: pre-ack, the RPC
    // rejects → SendResult/EditResult{ok:false} (rollback via pending.ops) and
    // the send-timer is cleared. Post-ack (RPC already resolved) the abort is a
    // no-op on the RPC; the `message.interrupt` enqueued below handles the
    // streaming phase. Calling both is safe in every phase and makes interrupt
    // responsive whether the send is pre- or post-ack (STATE_CONTRACT §
    // Optimistic Reconciliation "Timer ownership").
    if (effect.kind === 'InterruptRpc') {
      this.deps.service.suppressNextCompletionNotificationFor(effect.sessionPath);
      this.abortInFlightSend(effect.sessionPath);
    }
    const { queues, backend, dispatch } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        try {
          await backend.request(rpcMethodFor(effect), rpcParamsFor(effect));
          dispatch(rpcResultFor(effect, { ok: true }));
        } catch (err) {
          dispatch(rpcResultFor(effect, { ok: false, error: toErrorMessage(err) }));
        }
      });
    });
  }

  /**
   * SendRpc needs to capture the `requestId` from the backend response
   * so the host can bind events to sessions.
   */
  private runSendRpc(effect: Extract<Effect, { kind: 'SendRpc' }>): void {
    const { queues, backend, dispatch, service, statsService } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        // Start the send-timer at RPC dispatch (queue time) + arm the abort
        // controller (Brief E cancels an in-flight message.send on interrupt).
        const send = this.startInFlightSend(effect.corrId, effect.sessionPath, 'send', effect.localId, effect.composedText, effect.userParts, effect.priorPruningMode);
        try {
          service.bumpSessionDataEpoch(effect.sessionPath);
          statsService.prepareForSend(effect.sessionPath, effect.inputs);
          const response = await backend.request<{ requestId?: string; queued?: boolean }>('message.send', {
            sessionPath: effect.sessionPath,
            text: effect.text,
            inputs: effect.inputs,
            localId: effect.localId,
          }, { signal: send.abort.signal });
          // Early-ack succeeded: stamp requestId so the send-timer's fire
          // callback can dispatch PreflightFailed (post-ack) if the turn
          // never commits. The send-timer stays armed — cleared at the commit
          // point (first MessageStarted → ClearSendTimer) or on fire.
          send.requestId = response.requestId;
          if (response.queued) {
            // Steering (FollowUp) ack: the backend queued the message because a
            // turn was already running. No turn is started by this ack, so
            // there is no commit point (first MessageStarted for a requestId)
            // to clear the send-timer — clear it now so it cannot fire
            // `PreflightFailed` for a message that is legitimately waiting in
            // the follow-up queue. The reducer's `SendResult` ok-path branches
            // on `queued` to keep the optimistic message as 'queued'.
            this.clearInFlightSend(effect.corrId);
          }
          dispatch({
            kind: 'SendResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: true,
            requestId: response.requestId,
            queued: response.queued === true ? true : undefined,
          });
        } catch (err) {
          // Pre-ack failure (RequestTracker timeout/rejection, or abort): no
          // commit will come — clear the send-timer and dispatch the pre-ack
          // failure (rollback via pending.ops[corrId]).
          this.clearInFlightSend(effect.corrId);
          dispatch({
            kind: 'SendResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: false,
            error: toErrorMessage(err),
          });
        }
      });
    });
  }

  /**
   * EditRpc is a composite operation: truncate-then-send in a single session
   * operation. If truncate fails, the send is skipped and the whole operation
   * fails atomically (matching the legacy behavior).
   */
  private runEditRpc(effect: Extract<Effect, { kind: 'EditRpc' }>): void {
    const { queues, backend, dispatch, service, statsService } = this.deps;
    void queues.enqueueLifecycle(async () => {
      await queues.enqueueSessionOperation(effect.sessionPath, async () => {
        // edit follows the same phase-scoped shape as send (STATE_CONTRACT §
        // Optimistic Reconciliation "Timer ownership"): one send-timer owns the
        // post-ack, pre-commit phase; the abort controller covers the whole
        // truncate-then-send operation (Brief E cancels it on interrupt).
        const send = this.startInFlightSend(effect.corrId, effect.sessionPath, 'edit', effect.localId, effect.composedText ?? effect.text, effect.userParts);
        try {
          service.bumpSessionDataEpoch(effect.sessionPath);
          statsService.onTruncatedAfter(effect.sessionPath, effect.messageId);
          statsService.onMessageEdited(effect.sessionPath, effect.messageId);
          statsService.prepareForSend(effect.sessionPath, []);
          // Editing is restart semantics, not a mutation racing a live turn.
          // message.interrupt is idempotent and now acknowledges only after the
          // abort settles, so this forms a strict stop → truncate → send barrier.
          await backend.request('message.interrupt', {
            sessionPath: effect.sessionPath,
          }, { signal: send.abort.signal });
          await backend.request('session.truncateAfter', {
            sessionPath: effect.sessionPath,
            entryId: effect.messageId,
          }, { signal: send.abort.signal });
          // Capture the backend-assigned requestId so a post-ack prepass
          // failure (`PreflightFailed`) and the commit-point `MessageStarted`
          // can resolve the edit's corrId via `pending.promoted` (mirrors
          // runSendRpc). See STATE_CONTRACT § Optimistic Reconciliation.
          const response = await backend.request<{ requestId?: string }>('message.send', {
            sessionPath: effect.sessionPath,
            text: effect.text,
            inputs: effect.inputs,
            localId: effect.localId,
          }, { signal: send.abort.signal });
          send.requestId = response.requestId;
          dispatch({ kind: 'EditResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true, requestId: response.requestId });
        } catch (err) {
          this.clearInFlightSend(effect.corrId);
          dispatch({ kind: 'EditResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
        }
      });
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
          const transcript = service.getOpenTranscriptMode(effect.sessionPath);
          const payload = await backend.request<SessionOpenedPayload>('session.open', {
            sessionPath: effect.sessionPath,
            selectionToken: effect.selectionToken,
            transcript,
          });
          service.applySessionOpened(payload);
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: true,
          });
        } catch (err) {
          service.handleSelectionFailure(effect.selectionToken, `Failed to open session: ${toErrorMessage(err)}`);
          dispatch({
            kind: 'OpenSessionResult',
            corrId: effect.corrId,
            sessionPath: effect.sessionPath,
            ok: false,
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
          const payload = await backend.request<SessionOpenedPayload>('session.duplicate', {
            sessionPath: effect.sourceSessionPath,
            selectionToken: effect.selectionToken,
          });
          service.applySessionOpened(payload);
          dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: true });
        } catch (err) {
          service.handleSelectionFailure(effect.selectionToken, `Failed to duplicate session: ${toErrorMessage(err)}`);
          dispatch({ kind: 'DuplicateSessionResult', corrId: effect.corrId, sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(err) });
        }
      });
      return;
    }
    // A fresh session has no ordering dependency on work for existing sessions.
    // The global lifecycle queue made + wait behind unrelated opens, sends, and
    // model changes (several seconds in observed traces). Dispatch directly;
    // the pre-minted selection token prevents a late response stealing focus.
    void (async () => {
      try {
        const payload = await backend.request<SessionOpenedPayload>('session.create', {
          cwd: effect.cwd,
          selectionToken: effect.selectionToken,
        });
        service.applySessionOpened(payload);
        dispatch({
          kind: 'CreateSessionResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: true,
        });
      } catch (err) {
        service.handleSelectionFailure(effect.selectionToken, `Failed to create session: ${toErrorMessage(err)}`);
        dispatch({
          kind: 'CreateSessionResult',
          corrId: effect.corrId,
          sessionPath: effect.sessionPath,
          ok: false,
          error: toErrorMessage(err),
        });
      }
    })();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/** RPC kinds that reach the generic double-wrap path in {@link runRpc} after
 *  Send/Edit have been short-circuited to their dedicated handlers. Kept
 *  exhaustive over this 3-kind set so the helper switches below stay
 *  exhaustive with no `never`-unreachable arms. */
type RpcEffect = InterruptRpcEffect | ClearQueueRpcEffect | TruncateRpcEffect | ExtensionUiResponseRpcEffect;

function rpcMethodFor(effect: RpcEffect): string {
  switch (effect.kind) {
    case 'InterruptRpc':
      return 'message.interrupt';
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
    case 'InterruptRpc':
      return { sessionPath: effect.sessionPath };
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
    case 'InterruptRpc':
      return { kind: 'InterruptResult', ...base };
    case 'ClearQueueRpc':
      return { kind: 'ClearQueueResult', ...base };
    case 'TruncateRpc':
      return { kind: 'TruncateResult', ...base };
    case 'ExtensionUiResponseRpc':
      return { kind: 'ExtensionUiResponseResult', ...base };
  }
}
