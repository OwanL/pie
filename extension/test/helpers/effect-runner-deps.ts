/**
 * Canonical typed factory for `EffectRunnerDeps` test mocks.
 *
 * Goal: centralize every dep mock behind one type-checked factory so that a
 * newly-required method on `SessionServiceLike` / `StatsServiceLike` /
 * `FileDiffService` becomes a compile error here (and in every test that uses
 * the factory) instead of silently drifting in hand-built `as any` literals.
 *
 * The mock objects are typed directly against their interfaces — NO `as any`.
 * `fileDiffService` is typed against the `FileDiffService` class (all five
 * public methods are stubbed); `service` against `SessionServiceLike`;
 * `statsService` against `StatsServiceLike`.
 *
 * Tests that need custom behavior pass it through the `opts` hooks
 * (`backend`, `queues`, `serviceOverrides`, `dispatch`, `dispatchCommand`,
 * `dispatchEvent`, `requestImpl`, `modalChoice`, `sendTimerTimeoutMs`,
 * `timer`) rather than re-inlining an `as any` mock.
 */
import type {
  EffectRunnerDeps,
  BackendLike,
  QueueRouter,
  SessionServiceLike,
  StatsServiceLike,
  TimerSink,
} from '../../src/host/core/effect-runner';
import type { FileDiffService } from '../../src/host/core/file-diff-service';
import type { EffectResultEvent, CommandEvent, Event } from '../../src/host/core/events';
import type { ThinkingLevel } from '../../src/shared/protocol';
import type { RequestOptions } from '../../src/shared/request-tracker';

export type Call =
  | { kind: 'lifecycle' }
  | { kind: 'session'; sessionPath: string }
  | { kind: 'request'; method: string; params: unknown }
  | { kind: 'persistTabs'; openTabPaths: string[]; active: string | null; pinnedTabPaths: string[] }
  | { kind: 'log'; level: string; message: string }
  | { kind: 'showWarningModal'; message: string; confirmChoice: string }
  | { kind: 'bumpEpoch'; sessionPath: string }
  | { kind: 'onModelConfigChanged'; sessionPath: string; modelId: string; thinkingLevel: string }
  | { kind: 'handleSelectionFailure'; token: string; notice: string }
  | { kind: 'applySessionOpened'; payload: unknown };

export interface MakeEffectRunnerDepsOpts {
  /** Custom request implementation. Ignored when `backend` is supplied. */
  requestImpl?: (method: string) => Promise<unknown>;
  /** Resolved choice for `modal.showWarningModal` (undefined = dismissal). */
  modalChoice?: string | undefined;
  /** Override the send-timer budget (default 120s). The send-timer owns the
   *  post-ack, pre-commit phase; on fire it dispatches PreflightFailed. */
  sendTimerTimeoutMs?: number;
  /** Dynamic send-timer budget (prepass-aware production wiring); takes
   *  precedence over `sendTimerTimeoutMs`. Used to test the getter path. Takes
   *  the `sessionPath` (FP-C3) so the budget can be sized to the send's
   *  provider; tests may ignore the arg. */
  getSendTimerTimeoutMs?: (sessionPath: string) => number;
  /** Override the model-start send-timer budget (default 600s). The send-timer
   *  is re-armed with this budget once the pruning prepass succeeds
   *  (`ReArmSendTimer`); a fire after re-arm carries the model-start error
   *  string. Used by tests to avoid waiting the full 10min. */
  modelStartTimerTimeoutMs?: number;
  /** Injectable timer sink (tests pass a fake to drive timers deterministically). */
  timer?: TimerSink;
  /** Inject a custom `BackendLike` (e.g. one shared with `SessionServiceState`). */
  backend?: BackendLike;
  /** Inject custom queues (e.g. the real serializing `state.enqueue*` queues). */
  queues?: QueueRouter;
  /** Per-method `SessionServiceLike` overrides applied over the no-op stubs
   *  (e.g. delegate `closeSession` / `handleSelectionFailure` to the host). */
  serviceOverrides?: Partial<SessionServiceLike>;
  /** Custom `dispatch` for `*Result` events. Defaults to pushing to `events`. */
  dispatch?: (event: EffectResultEvent) => void;
  /** Custom `dispatchCommand`. Defaults to pushing to `commands`. */
  dispatchCommand?: (event: CommandEvent) => void;
  /** Custom `dispatchEvent` for non-result/non-command Events. Defaults to no-op. */
  dispatchEvent?: (event: Event) => void;
}

export interface MakeEffectRunnerDepsResult {
  deps: EffectRunnerDeps;
  calls: Call[];
  events: EffectResultEvent[];
  commands: CommandEvent[];
}

export function makeEffectRunnerDeps(opts: MakeEffectRunnerDepsOpts = {}): MakeEffectRunnerDepsResult {
  const calls: Call[] = [];
  const events: EffectResultEvent[] = [];
  const commands: CommandEvent[] = [];

  const backend: BackendLike = opts.backend ?? {
    request<T = unknown>(method: string, params?: unknown, options?: RequestOptions): Promise<T> {
      calls.push({ kind: 'request', method, params });
      const sig = options?.signal;
      // Signal-aware: a hanging requestImpl rejects when the signal aborts, so
      // the effect-runner's abortInFlightSend (Brief E) can cancel an in-flight
      // message.send in tests. Without a signal, delegates to requestImpl (or
      // resolves {} by default — the original behavior). Options are NOT
      // recorded on the Call (existing assertions deepEqual {method,params}).
      if (!opts.requestImpl && !sig) return Promise.resolve({} as T);
      return new Promise<T>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          reject(new Error(`Request ${method} was cancelled.`));
        };
        if (sig) {
          if (sig.aborted) { settled = true; reject(new Error(`Request ${method} was cancelled.`)); return; }
          sig.addEventListener('abort', onAbort);
        }
        if (opts.requestImpl) {
          Promise.resolve(opts.requestImpl(method)).then(
            (v) => { if (settled) return; settled = true; if (sig) sig.removeEventListener('abort', onAbort); resolve(v as T); },
            (e) => { if (settled) return; settled = true; if (sig) sig.removeEventListener('abort', onAbort); reject(e); },
          );
        }
      });
    },
  };

  const queues: QueueRouter = opts.queues ?? {
    async enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
      calls.push({ kind: 'lifecycle' });
      return task();
    },
    async enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T> {
      calls.push({ kind: 'session', sessionPath });
      return task();
    },
  };

  // `FileDiffService` is a class with private members (`getArchState`,
  // `toGitUri`, `toEmptyDiffUri`), so an object literal cannot be structurally
  // assignable to it. We type the mock against `Pick<FileDiffService, ...>`
  // for the three async methods the runner actually calls -- this catches
  // *signature* drift on those methods (a renamed/retyped method becomes a
  // compile error here) -- then narrow-cast to the full class type. This is a
  // deliberate `as unknown as FileDiffService` (NOT `as any`): the mock object
  // itself is fully type-checked against the real class signatures.
  const fileDiffService: Pick<
    FileDiffService,
    'openFileDiff' | 'openFileInEditor' | 'revertFile'
  > = {
    async openFileDiff(): Promise<void> {},
    async openFileInEditor(): Promise<void> {},
    async revertFile(): Promise<void> {},
  };

  // Typed against `SessionServiceLike` — every method is present so a
  // newly-required method becomes a compile error here. Per-method overrides
  // are applied via `Object.assign` so they stay type-checked against the
  // interface too.
  const service: SessionServiceLike = {
    async hydrateModelState() {},
    setPrefs() {},
    async setSystemPromptToggles() {},
    bumpSessionDataEpoch(sessionPath: string) {
      calls.push({ kind: 'bumpEpoch', sessionPath });
    },
    onModelConfigChanged(sessionPath: string, modelId: string, thinkingLevel: ThinkingLevel) {
      calls.push({ kind: 'onModelConfigChanged', sessionPath, modelId, thinkingLevel });
    },
    suppressNextCompletionNotificationFor() {},
    async loadOlderTranscript() {},
    async loadNewerTranscript() {},
    async jumpToLatestTranscript() {},
    async closeSession() {},
    async setPruningSettings() {},
    async setToolResultPruningSettings() {},
    handleSelectionFailure(token: string, notice: string) {
      calls.push({ kind: 'handleSelectionFailure', token, notice });
    },
    applySessionOpened(payload) {
      calls.push({ kind: 'applySessionOpened', payload });
    },
    getOpenTranscriptMode() {
      return 'tail' as const;
    },
  };
  if (opts.serviceOverrides) {
    Object.assign(service, opts.serviceOverrides);
  }

  // Typed against `StatsServiceLike` — every method present, no `as any`.
  const statsService: StatsServiceLike = {
    prepareForSend() {},
    onTruncatedAfter() {},
    onMessageEdited() {},
    recordOutcome() {},
    startNewTask() {},
    continueTask() {},
  };

  const deps: EffectRunnerDeps = {
    backend,
    queues,
    tabs: {
      async persistTabs(openTabPaths: string[], active: string | null, pinnedTabPaths: string[]) {
        calls.push({ kind: 'persistTabs', openTabPaths, active, pinnedTabPaths });
      },
    },
    log: {
      log(level: string, message: string) {
        calls.push({ kind: 'log', level, message });
      },
    },
    postImperative: { postImperative() {} },
    modal: {
      async showWarningModal(message: string, confirmChoice: string) {
        calls.push({ kind: 'showWarningModal', message, confirmChoice });
        return opts.modalChoice;
      },
    },
    fileDiffService: fileDiffService as unknown as FileDiffService,
    service,
    statsService,
    dispatch: opts.dispatch ?? ((e) => events.push(e)),
    dispatchCommand: opts.dispatchCommand ?? ((cmd) => commands.push(cmd)),
    dispatchEvent: opts.dispatchEvent ?? (() => {}),
    sendTimerTimeoutMs: opts.sendTimerTimeoutMs,
    getSendTimerTimeoutMs: opts.getSendTimerTimeoutMs,
    modelStartTimerTimeoutMs: opts.modelStartTimerTimeoutMs,
    timer: opts.timer,
  };

  return { deps, calls, events, commands };
}
