import type {
  CompactRpcEffect,
  ContinueRpcEffect,
  EditRpcEffect,
  InterruptRpcEffect,
  SendRpcEffect,
} from './effects';
import type { EffectResultEvent, Event } from './events';
import type {
  ComposerInput,
  ProviderGateStats,
  PruningMode,
  PruningSettings,
} from '../../shared/protocol';
import { BACKEND_READY_TIMEOUT_MS } from '../../shared/backend-ready-timeout';
import { RequestTimeoutError, type RequestOptions } from '../../shared/request-tracker';
import { toErrorMessage } from '../util/error-message';

export type CorrelatedBackendResponse<TResult> =
  | { ok: true; result: TResult }
  | { ok: false; error: Error };

/** A destructive request can retain its exact response correlation after the
 * application-level waiter reaches its deadline. */
export interface CommitAwareRequestOptions<TResult> extends RequestOptions {
  onCorrelatedResponse?: (response: CorrelatedBackendResponse<TResult>) => void;
}

type TimerHandle = unknown;

interface SessionOperationTimerSink {
  schedule(fn: () => void, ms: number): TimerHandle;
  cancel(handle: TimerHandle): void;
}

interface SessionOperationEffectControllerDeps {
  backend: {
    request<T = unknown>(method: string, params?: unknown, options?: CommitAwareRequestOptions<T>): Promise<T>;
  };
  queues: {
    enqueueSessionOperation<T>(sessionPath: string, task: () => Promise<T>): Promise<T>;
  };
  log: {
    log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: unknown): void;
  };
  service: {
    bumpSessionDataEpoch(sessionPath: string): void;
    getBackendGeneration?(): number;
    isSessionRuntimeReady?(sessionPath: string): boolean;
    setPruningSettings(updates: Partial<PruningSettings>): Promise<void>;
    suppressNextCompletionNotificationFor(sessionPath: string): void;
  };
  statsService: {
    prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage?: string): void;
    onTruncatedAfter(sessionPath: string, messageId: string): void;
    onMessageEdited(sessionPath: string, messageId: string): void;
  };
  dispatch(event: EffectResultEvent): void;
  dispatchEvent(event: Event): void;
  timer: SessionOperationTimerSink;
  sendTimerTimeoutMs: number;
  getSendTimerTimeoutMs?: (sessionPath: string) => number;
  getProviderGateMetrics?: () => ProviderGateStats;
  resolveSessionProvider?: (sessionPath: string) => string | undefined;
  isSessionProviderPending?: (sessionPath: string) => boolean;
}

/** Decide whether a model-start observation timer should defer while the exact
 * request is still admitted or queued by its provider. Missing correlation
 * fails open so an unobservable request cannot wait forever. */
export function decideModelStartTimerAction(opts: {
  elapsed: number;
  ceiling: number;
  provider?: string;
  metrics?: ProviderGateStats;
  requestProviderPending?: boolean;
}): { action: 'defer' | 'fire' } {
  const { elapsed, ceiling, provider, metrics, requestProviderPending } = opts;
  const providerMetric = provider && metrics?.enabled
    ? metrics.providers.find((metric) => metric.provider === provider)
    : undefined;
  const providerInProgress = !!providerMetric
    && (providerMetric.paused
      || (requestProviderPending === true
        && (providerMetric.activeRequests > 0 || providerMetric.queuedRequests > 0)));
  return providerInProgress && elapsed < ceiling ? { action: 'defer' } : { action: 'fire' };
}

interface ExecutionCancellationTicket {
  cancel(): void;
  isCancelled(): boolean;
}

function createExecutionCancellationTicket(): ExecutionCancellationTicket {
  let cancelled = false;
  return {
    cancel: () => { cancelled = true; },
    isCancelled: () => cancelled,
  };
}

interface RegisteredSendResource {
  abort: AbortController;
  ticket: object;
  timer: TimerHandle | null;
}

/** Legacy direct-runner calls have no reducer operation identity. Their stored
 * data is limited to execution handles, callbacks, and transport correlation. */
interface LegacySendResource extends RegisteredSendResource {
  corrId: string;
  sessionPath: string;
  localId: string;
  requestId?: string;
  restorePruning(): void;
  logSuperseded(): void;
  dispatchSuperseded(): void;
}

type ReconciliationEffect = Extract<
  import('./effects').Effect,
  { kind: 'ScheduleOperationReconciliation' }
>;

/**
 * Owns non-serializable execution resources for session operations. It emits
 * observations only; operation phase, commit evidence, reconciliation policy,
 * recovery, and terminal outcomes remain reducer-owned.
 */
export class SessionOperationEffectController {
  private readonly registeredSends = new Map<string, RegisteredSendResource>();
  private readonly legacyInFlightSends = new Map<string, LegacySendResource>();
  private readonly legacyTimedOutSends = new Map<string, LegacySendResource>();
  private readonly legacyInFlightSendBySession = new Map<string, string>();
  private readonly operationReconciliationTimers = new Map<string, TimerHandle>();
  private readonly queuedEditOperations = new Map<string, ExecutionCancellationTicket>();
  private readonly messageOperationTickets = new Map<string, object>();
  private readonly messageOperationBarriers = new Map<string, () => void>();

  /** Provider admission can legitimately span several per-phase deadlines,
   * but the complete model-start observation remains bounded. */
  private static readonly MODEL_START_HARD_CEILING_MS = 20 * 60 * 1000;
  private static readonly MODEL_START_TIMER_MS = 120_000;

  constructor(private readonly deps: SessionOperationEffectControllerDeps) {}

  runSendRpc(effect: SendRpcEffect): void {
    const { queues, backend, dispatch, service, statsService } = this.deps;
    void queues.enqueueSessionOperation(effect.sessionPath, async () => {
      const send = this.startSend(effect);
      const operationAttempt = effect.operationAttempt ?? 1;
      const isCurrentExecution = (): boolean => effect.operationId
        ? this.registeredSends.get(effect.corrId)?.ticket === send.ticket
        : this.legacyInFlightSends.get(effect.corrId) === send.legacy
          || this.legacyTimedOutSends.get(effect.corrId) === send.legacy;
      try {
        service.bumpSessionDataEpoch(effect.sessionPath);
        if (operationAttempt === 1) {
          statsService.prepareForSend(effect.sessionPath, effect.inputs, effect.text);
        }
        const coldPromotion = service.isSessionRuntimeReady?.(effect.sessionPath) === false;
        const settleAcknowledgement = (settlement: CorrelatedBackendResponse<{
          requestId?: string;
          queued?: boolean;
          operationId?: string;
          operationAttempt?: number;
        }>): void => {
          if (!isCurrentExecution()) return;
          if (settlement.ok) {
            if (send.legacy) send.legacy.requestId = settlement.result.requestId;
            dispatch({
              kind: 'SendResult', corrId: effect.corrId, operationId: effect.operationId,
              operationAttempt, backendGeneration: effect.backendGeneration,
              sessionPath: effect.sessionPath, ok: true,
              requestId: settlement.result.requestId,
              queued: settlement.result.queued === true ? true : undefined,
            });
          } else {
            dispatch({
              kind: 'SendResult', corrId: effect.corrId, operationId: effect.operationId,
              operationAttempt, backendGeneration: effect.backendGeneration,
              sessionPath: effect.sessionPath, ok: false,
              error: toErrorMessage(settlement.error),
            });
          }
        };
        const response = await backend.request<{
          requestId?: string;
          queued?: boolean;
          operationId?: string;
          operationAttempt?: number;
        }>('message.send', {
          sessionPath: effect.sessionPath,
          operationId: effect.operationId,
          operationAttempt,
          text: effect.text,
          inputs: effect.inputs,
          localId: effect.localId,
        }, {
          signal: send.abort.signal,
          onCorrelatedResponse: settleAcknowledgement,
          ...(coldPromotion ? { timeoutMs: BACKEND_READY_TIMEOUT_MS } : {}),
        });
        if (send.legacy) send.legacy.requestId = response.requestId;
        dispatch({
          kind: 'SendResult', corrId: effect.corrId, operationId: effect.operationId,
          operationAttempt, backendGeneration: effect.backendGeneration,
          sessionPath: effect.sessionPath, ok: true, requestId: response.requestId,
          queued: response.queued === true ? true : undefined,
        });
      } catch (error) {
        if (isLocalRequestTimeout(error)) {
          this.deps.log.log('warn', 'message.send acknowledgement delayed', {
            corrId: effect.corrId,
            operationId: effect.operationId,
            sessionPath: effect.sessionPath,
            error: toErrorMessage(error),
          });
          if (effect.operationId && effect.backendGeneration !== undefined) {
            this.deps.dispatchEvent({
              kind: 'SendOperationDelayed', operationId: effect.operationId,
              operationAttempt, sessionPath: effect.sessionPath,
              backendGeneration: effect.backendGeneration,
              error: toErrorMessage(error),
            });
          }
          return;
        }
        this.clearSend(effect.corrId);
        dispatch({
          kind: 'SendResult', corrId: effect.corrId, operationId: effect.operationId,
          operationAttempt, backendGeneration: effect.backendGeneration,
          sessionPath: effect.sessionPath, ok: false, error: toErrorMessage(error),
        });
      }
    });
  }

  runEditRpc(effect: EditRpcEffect): void {
    const operationId = effect.operationId ?? effect.corrId;
    const ticket = createExecutionCancellationTicket();
    this.queuedEditOperations.set(operationId, ticket);
    void this.deps.queues.enqueueSessionOperation(effect.sessionPath, async () => {
      if (this.queuedEditOperations.get(operationId) === ticket) {
        this.queuedEditOperations.delete(operationId);
      }
      if (ticket.isCancelled()) {
        this.deps.dispatchEvent({
          kind: 'MessageOperationStatus', operationId, operationKind: 'message.edit',
          sessionPath: effect.sessionPath,
          backendGeneration: effect.backendGeneration ?? this.deps.service.getBackendGeneration?.() ?? 0,
          operationAttempt: effect.operationAttempt ?? 1,
          state: 'cancelled', committed: false,
          error: 'The edit was interrupted before its backend transition started.',
          occurredAt: Date.now(),
        });
        return;
      }
      await this.executeCompoundMessageOperation(effect);
    });
  }

  runInterruptRpc(effect: InterruptRpcEffect): void {
    this.deps.service.suppressNextCompletionNotificationFor(effect.sessionPath);
    if (effect.abortSendCorrIds) {
      for (const corrId of effect.abortSendCorrIds) {
        const controller = this.registeredSends.get(corrId)?.abort;
        if (controller && !controller.signal.aborted) controller.abort();
      }
    } else if (!effect.operationId) {
      this.abortInFlightSend(effect.sessionPath);
    }
    for (const operationId of effect.cancelQueuedOperationIds ?? []) {
      this.queuedEditOperations.get(operationId)?.cancel();
    }
    const execute = async (): Promise<void> => await this.executeCompoundMessageOperation(effect);
    const operationPrefix = `${effect.operationId ?? effect.corrId}:`;
    const retriesInFlightInterrupt = [...this.messageOperationBarriers.keys()]
      .some((key) => key.startsWith(operationPrefix));
    if (effect.usePriorityLane || retriesInFlightInterrupt) {
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => { release = resolve; });
      void this.deps.queues.enqueueSessionOperation(effect.sessionPath, async () => await barrier);
      void execute().finally(release);
      return;
    }
    void this.deps.queues.enqueueSessionOperation(effect.sessionPath, execute);
  }

  runContinueRpc(effect: ContinueRpcEffect): void {
    this.runMessageOperationRpc(effect);
  }

  runCompactRpc(effect: CompactRpcEffect): void {
    this.runMessageOperationRpc(effect);
  }

  markPrepassSucceeded(effect: Extract<import('./effects').Effect, { kind: 'MarkPrepassSucceeded' }>): void {
    const budgetMs = SessionOperationEffectController.MODEL_START_TIMER_MS;
    const phaseStartedAt = Date.now();
    if (effect.operationId && effect.sessionPath && effect.backendGeneration !== undefined) {
      if (!this.registeredSends.has(effect.corrId)) return;
      this.scheduleRegisteredSendTimer({
        corrId: effect.corrId,
        operationId: effect.operationId,
        sessionPath: effect.sessionPath,
        operationAttempt: effect.operationAttempt,
        backendGeneration: effect.backendGeneration,
      }, 'model-start', phaseStartedAt, budgetMs);
      return;
    }
    const send = this.legacyInFlightSends.get(effect.corrId);
    if (!send) return;
    if (send.timer) this.deps.timer.cancel(send.timer);
    send.logSuperseded = () => this.deps.log.log('debug', 'send-timer.superseded', {
      corrId: send.corrId,
      requestId: send.requestId,
      sessionPath: send.sessionPath,
      budgetMs,
    });
    send.timer = this.deps.timer.schedule(
      () => this.onLegacySendTimerFire(send, 'model-start', phaseStartedAt, budgetMs),
      budgetMs,
    );
  }

  clearSendTimer(corrId: string, restorePruningMode?: PruningMode): void {
    this.clearSend(corrId);
    this.restorePruningMode(corrId, restorePruningMode);
  }

  scheduleOperationReconciliation(effect: ReconciliationEffect): void {
    const key = `${effect.operationId}:${effect.operationAttempt}:${effect.reconciliationAttempt}`;
    if (this.operationReconciliationTimers.has(key)) return;
    const handle = this.deps.timer.schedule(() => {
      this.operationReconciliationTimers.delete(key);
      void this.queryOperationStatus(effect);
    }, effect.delayMs);
    this.operationReconciliationTimers.set(key, handle);
  }

  releaseOperationResources(
    effect: Extract<import('./effects').Effect, { kind: 'ReleaseOperationResources' }>,
  ): void {
    const prefix = `${effect.operationId}:${effect.operationAttempt}:`;
    for (const [key, handle] of this.operationReconciliationTimers) {
      if (!key.startsWith(prefix)) continue;
      this.deps.timer.cancel(handle);
      this.operationReconciliationTimers.delete(key);
    }
    const operationKey = `${effect.operationId}:${effect.operationAttempt}`;
    this.messageOperationTickets.delete(operationKey);
    const release = this.messageOperationBarriers.get(operationKey);
    this.messageOperationBarriers.delete(operationKey);
    release?.();
    this.clearRegisteredSend(effect.corrId);
    this.restorePruningMode(effect.corrId, effect.restorePruningMode);
  }

  /** Compatibility hook for direct calls without a reducer operation ID. */
  abortInFlightSend(sessionPath: string): boolean {
    const corrId = this.legacyInFlightSendBySession.get(sessionPath);
    if (!corrId) return false;
    const send = this.legacyInFlightSends.get(corrId);
    if (!send) return false;
    if (!send.abort.signal.aborted) send.abort.abort();
    return true;
  }

  dispose(): void {
    for (const send of this.registeredSends.values()) {
      if (send.timer) this.deps.timer.cancel(send.timer);
      send.abort.abort();
    }
    this.registeredSends.clear();
    for (const send of this.legacyInFlightSends.values()) {
      if (send.timer) this.deps.timer.cancel(send.timer);
    }
    this.legacyInFlightSends.clear();
    this.legacyTimedOutSends.clear();
    this.legacyInFlightSendBySession.clear();
    for (const timer of this.operationReconciliationTimers.values()) this.deps.timer.cancel(timer);
    this.operationReconciliationTimers.clear();
    this.queuedEditOperations.clear();
    for (const release of this.messageOperationBarriers.values()) release();
    this.messageOperationBarriers.clear();
    this.messageOperationTickets.clear();
  }

  private startSend(effect: SendRpcEffect): {
    abort: AbortController;
    ticket: object;
    legacy?: LegacySendResource;
  } {
    const budgetMs = this.deps.getSendTimerTimeoutMs?.(effect.sessionPath)
      ?? this.deps.sendTimerTimeoutMs;
    const abort = new AbortController();
    const ticket = {};
    if (effect.operationId && effect.backendGeneration !== undefined) {
      this.clearRegisteredSend(effect.corrId);
      const resource: RegisteredSendResource = { abort, ticket, timer: null };
      this.registeredSends.set(effect.corrId, resource);
      this.scheduleRegisteredSendTimer(effect, 'prepass', 0, budgetMs);
      return { abort, ticket };
    }

    const restorePruning = (): void => this.restorePruningMode(
      effect.corrId,
      effect.priorPruningMode,
    );
    const legacy: LegacySendResource = {
      corrId: effect.corrId,
      sessionPath: effect.sessionPath,
      localId: effect.localId,
      abort,
      ticket,
      timer: null,
      restorePruning,
      logSuperseded: () => this.deps.log.log('debug', 'send-timer.superseded', {
        corrId: effect.corrId,
        requestId: legacy.requestId,
        sessionPath: effect.sessionPath,
        budgetMs,
      }),
      dispatchSuperseded: () => {
        this.deps.dispatchEvent({
          kind: 'PreflightSuperseded', corrId: effect.corrId,
          requestId: legacy.requestId ?? '', sessionPath: effect.sessionPath,
          localId: effect.localId, composedText: effect.composedText,
          userParts: effect.userParts,
          timestamp: Date.now(),
        });
      },
    };
    legacy.timer = this.deps.timer.schedule(
      () => this.onLegacySendTimerFire(legacy, 'prepass', 0, budgetMs),
      budgetMs,
    );
    this.legacyInFlightSends.set(effect.corrId, legacy);
    this.legacyInFlightSendBySession.set(effect.sessionPath, effect.corrId);
    return { abort, ticket, legacy };
  }

  private scheduleRegisteredSendTimer(
    effect: Pick<SendRpcEffect, 'corrId' | 'operationId' | 'operationAttempt' | 'backendGeneration' | 'sessionPath'>,
    phase: 'prepass' | 'model-start',
    phaseStartedAt: number,
    budgetMs: number,
  ): void {
    if (!effect.operationId || effect.backendGeneration === undefined) return;
    const resource = this.registeredSends.get(effect.corrId);
    if (!resource) return;
    if (resource.timer) this.deps.timer.cancel(resource.timer);
    const handle = this.deps.timer.schedule(() => {
      if (this.registeredSends.get(effect.corrId)?.timer !== handle) return;
      resource.timer = null;
      if (phase === 'model-start' && this.shouldReArmModelStartTimer(effect.sessionPath, phaseStartedAt)) {
        const remaining = Math.max(1, SessionOperationEffectController.MODEL_START_HARD_CEILING_MS
          - (Date.now() - phaseStartedAt));
        this.scheduleRegisteredSendTimer(effect, phase, phaseStartedAt, Math.min(budgetMs, remaining));
        return;
      }
      this.deps.dispatchEvent({
        kind: 'SendOperationDelayed', operationId: effect.operationId!,
        operationAttempt: effect.operationAttempt ?? 1,
        sessionPath: effect.sessionPath,
        backendGeneration: effect.backendGeneration!,
      });
    }, budgetMs);
    resource.timer = handle;
  }

  private onLegacySendTimerFire(
    send: LegacySendResource,
    phase: 'prepass' | 'model-start',
    phaseStartedAt: number,
    budgetMs: number,
  ): void {
    if (this.legacyInFlightSends.get(send.corrId) !== send) return;
    if (phase === 'model-start' && this.shouldReArmModelStartTimer(send.sessionPath, phaseStartedAt)) {
      const remaining = Math.max(1, SessionOperationEffectController.MODEL_START_HARD_CEILING_MS
        - (Date.now() - phaseStartedAt));
      send.timer = this.deps.timer.schedule(
        () => this.onLegacySendTimerFire(send, phase, phaseStartedAt, budgetMs),
        Math.min(budgetMs, remaining),
      );
      return;
    }
    this.legacyInFlightSends.delete(send.corrId);
    if (this.legacyInFlightSendBySession.get(send.sessionPath) === send.corrId) {
      this.legacyInFlightSendBySession.delete(send.sessionPath);
    }
    send.timer = null;
    send.restorePruning();
    if (send.requestId) {
      this.legacyTimedOutSends.set(send.corrId, send);
      this.deps.dispatchEvent({
        kind: 'PreflightFailed', corrId: send.corrId, sessionPath: send.sessionPath,
        requestId: send.requestId,
        error: phase === 'model-start'
          ? `Timed out waiting for the model to start streaming (${budgetMs / 1000}s)`
          : `Timed out waiting for the turn to start streaming (${budgetMs / 1000}s)`,
      });
      return;
    }
    this.deps.log.log(
      'warn',
      `send-timer fired before early-ack for corrId=${send.corrId} session=${send.sessionPath} (pre-ack RequestTracker timer should have fired first)`,
    );
  }

  private shouldReArmModelStartTimer(sessionPath: string, phaseStartedAt: number): boolean {
    return decideModelStartTimerAction({
      elapsed: Date.now() - phaseStartedAt,
      ceiling: SessionOperationEffectController.MODEL_START_HARD_CEILING_MS,
      provider: this.deps.resolveSessionProvider?.(sessionPath),
      metrics: this.deps.getProviderGateMetrics?.(),
      requestProviderPending: this.deps.isSessionProviderPending?.(sessionPath),
    }).action === 'defer';
  }

  private clearRegisteredSend(corrId: string): void {
    const send = this.registeredSends.get(corrId);
    if (!send) return;
    if (send.timer) this.deps.timer.cancel(send.timer);
    this.registeredSends.delete(corrId);
  }

  private clearSend(corrId: string): void {
    if (this.registeredSends.has(corrId)) {
      this.clearRegisteredSend(corrId);
      return;
    }
    const timedOut = this.legacyTimedOutSends.get(corrId);
    if (timedOut) {
      this.legacyTimedOutSends.delete(corrId);
      timedOut.logSuperseded();
      timedOut.dispatchSuperseded();
      return;
    }
    const send = this.legacyInFlightSends.get(corrId);
    if (!send) return;
    if (send.timer) this.deps.timer.cancel(send.timer);
    this.legacyInFlightSends.delete(corrId);
    if (this.legacyInFlightSendBySession.get(send.sessionPath) === send.corrId) {
      this.legacyInFlightSendBySession.delete(send.sessionPath);
    }
    send.restorePruning();
  }

  private restorePruningMode(corrId: string, mode: PruningMode | undefined): void {
    if (!mode) return;
    void this.deps.service.setPruningSettings({ mode }).catch((error) => {
      this.deps.log.log(
        'warn',
        `failed to restore pruning mode to '${mode}' after retry (corrId=${corrId}): ${toErrorMessage(error)}`,
      );
    });
  }

  private async executeCompoundMessageOperation(effect: EditRpcEffect | InterruptRpcEffect): Promise<void> {
    const { backend, dispatch, service, statsService } = this.deps;
    const operationKind = effect.kind === 'EditRpc' ? 'message.edit' as const : 'message.interrupt' as const;
    const operationId = effect.operationId ?? effect.corrId;
    const backendGeneration = effect.backendGeneration ?? service.getBackendGeneration?.() ?? 0;
    const operationAttempt = effect.operationAttempt ?? 1;
    const operationKey = `${operationId}:${operationAttempt}`;
    const operationPrefix = `${operationId}:`;
    for (const key of [...this.messageOperationTickets.keys()]) {
      if (key.startsWith(operationPrefix)) this.messageOperationTickets.delete(key);
    }
    for (const [key, release] of [...this.messageOperationBarriers.entries()]) {
      if (!key.startsWith(operationPrefix)) continue;
      this.messageOperationBarriers.delete(key);
      release();
    }
    let settlementBarrier: Promise<void> | undefined;
    if (operationKind === 'message.interrupt') {
      settlementBarrier = new Promise<void>((resolve) => {
        this.messageOperationBarriers.set(operationKey, resolve);
      });
    }
    const executionTicket = {};
    this.messageOperationTickets.set(operationKey, executionTicket);
    if (effect.kind === 'EditRpc') {
      service.bumpSessionDataEpoch(effect.sessionPath);
      if (operationAttempt === 1) {
        statsService.onTruncatedAfter(effect.sessionPath, effect.messageId);
        statsService.onMessageEdited(effect.sessionPath, effect.messageId);
        statsService.prepareForSend(effect.sessionPath, effect.inputs, effect.composedText ?? effect.text);
      }
    }

    type Response = {
      operationId?: string;
      operationAttempt?: number;
      requestId?: string;
      committed?: boolean;
      interrupted?: boolean;
      settled?: boolean;
      alreadyStopped?: boolean;
      forcedRecovery?: boolean;
      teardownTimedOut?: boolean;
      recoveryPending?: boolean;
    };
    const dispatchAcknowledgement = (response: Response): void => {
      if (this.messageOperationTickets.get(operationKey) !== executionTicket) return;
      if (effect.kind === 'EditRpc') {
        dispatch({
          kind: 'EditResult', corrId: effect.corrId, operationId, operationAttempt,
          backendGeneration, sessionPath: effect.sessionPath, ok: true,
          committed: response.committed,
          ...(response.requestId ? { requestId: response.requestId } : {}),
        });
      } else {
        dispatch({
          kind: 'InterruptResult', corrId: effect.corrId, operationId, operationAttempt,
          backendGeneration, sessionPath: effect.sessionPath, ok: true,
          committed: response.committed, interrupted: response.interrupted,
          settled: response.settled, alreadyStopped: response.alreadyStopped,
          forcedRecovery: response.forcedRecovery,
          teardownTimedOut: response.teardownTimedOut,
          recoveryPending: response.recoveryPending,
          occurredAt: Date.now(),
        });
      }
    };

    try {
      const params = effect.kind === 'EditRpc'
        ? {
            sessionPath: effect.sessionPath, entryId: effect.messageId, text: effect.text,
            inputs: effect.inputs, localId: effect.localId, operationId, operationAttempt,
          }
        : { sessionPath: effect.sessionPath, operationId, operationAttempt };
      const response = await backend.request<Response>(operationKind, params, {
        onCorrelatedResponse: (settlement) => {
          if (this.messageOperationTickets.get(operationKey) !== executionTicket) return;
          if (settlement.ok) dispatchAcknowledgement(settlement.result);
        },
      });
      dispatchAcknowledgement(response);
    } catch (error) {
      this.deps.dispatchEvent({
        kind: 'MessageOperationDelayed', operationId, operationKind,
        sessionPath: effect.sessionPath, backendGeneration,
        error: isLocalRequestTimeout(error) ? toErrorMessage(error) : toCodedErrorMessage(error),
      });
    }
    if (settlementBarrier) await settlementBarrier;
  }

  private runMessageOperationRpc(effect: ContinueRpcEffect | CompactRpcEffect): void {
    const { queues, backend, dispatch, service } = this.deps;
    void queues.enqueueSessionOperation(effect.sessionPath, async () => {
      const operationKind = effect.kind === 'ContinueRpc' ? 'message.continue' as const : 'message.compact' as const;
      const operationId = effect.operationId ?? effect.corrId;
      const backendGeneration = effect.backendGeneration ?? service.getBackendGeneration?.() ?? 0;
      const operationAttempt = effect.operationAttempt ?? 1;
      const operationKey = `${operationId}:${operationAttempt}`;
      const executionTicket = {};
      this.messageOperationTickets.set(operationKey, executionTicket);
      const dispatchResult = (outcome: { ok: true; requestId?: string } | { ok: false; error: string }): void => {
        dispatch({
          kind: effect.kind === 'ContinueRpc' ? 'ContinueResult' : 'CompactResult',
          corrId: effect.corrId, operationId, operationAttempt, backendGeneration,
          sessionPath: effect.sessionPath, ...outcome,
        });
      };
      try {
        if (operationKind === 'message.continue') service.bumpSessionDataEpoch(effect.sessionPath);
        const coldPromotion = service.isSessionRuntimeReady?.(effect.sessionPath) === false;
        const settleAcknowledgement = (settlement: CorrelatedBackendResponse<{ requestId?: string }>): void => {
          if (this.messageOperationTickets.get(operationKey) !== executionTicket) return;
          if (settlement.ok) {
            dispatchResult({
              ok: true,
              ...(settlement.result.requestId ? { requestId: settlement.result.requestId } : {}),
            });
          }
        };
        const response = await backend.request<{ requestId?: string }>(operationKind, {
          sessionPath: effect.sessionPath,
          operationId,
          operationAttempt,
          ...(operationKind === 'message.compact' ? { reason: 'manual' } : {}),
        }, {
          onCorrelatedResponse: settleAcknowledgement,
          ...(coldPromotion ? { timeoutMs: BACKEND_READY_TIMEOUT_MS } : {}),
        });
        dispatchResult({ ok: true, ...(response.requestId ? { requestId: response.requestId } : {}) });
      } catch (error) {
        if (isLocalRequestTimeout(error)) {
          this.deps.log.log('warn', `${operationKind} acknowledgement delayed`, {
            corrId: effect.corrId, operationId, sessionPath: effect.sessionPath,
            error: toErrorMessage(error),
          });
          this.deps.dispatchEvent({
            kind: 'MessageOperationDelayed', operationId, operationKind,
            sessionPath: effect.sessionPath, backendGeneration,
            error: toErrorMessage(error),
          });
          return;
        }
        dispatchResult({ ok: false, error: toCodedErrorMessage(error) });
      }
    });
  }

  private async queryOperationStatus(effect: ReconciliationEffect): Promise<void> {
    try {
      const status = await this.deps.backend.request<{
        state: 'pending' | 'accepted' | 'failed';
        requestId?: string;
        queued?: boolean;
        committed?: boolean;
        outcome?: 'failed' | 'cancelled' | 'superseded' | 'aborted';
        code?: string;
        message?: string;
        interrupted?: boolean;
        settled?: boolean;
        alreadyStopped?: boolean;
        forcedRecovery?: boolean;
        teardownTimedOut?: boolean;
        recoveryPending?: boolean;
      }>('operation.status', {
        sessionPath: effect.sessionPath,
        operationId: effect.operationId,
        backendGeneration: effect.backendGeneration,
      });
      const state = status.state === 'failed' && status.outcome ? status.outcome : status.state;
      const common = {
        operationId: effect.operationId,
        sessionPath: effect.sessionPath,
        backendGeneration: effect.backendGeneration,
        operationAttempt: effect.operationAttempt,
        reconciliationAttempt: effect.reconciliationAttempt,
        state,
        committed: status.committed,
        requestId: status.requestId,
        error: status.code && status.message ? `${status.code}: ${status.message}` : status.message ?? status.code,
      } as const;
      if (effect.operationKind === 'message.send') {
        this.deps.dispatchEvent({ kind: 'SendOperationStatus', ...common, queued: status.queued });
        if (status.state === 'accepted') {
          this.deps.dispatch({
            kind: 'SendResult', corrId: effect.corrId, operationId: effect.operationId,
            operationAttempt: effect.operationAttempt,
            backendGeneration: effect.backendGeneration,
            sessionPath: effect.sessionPath, reconciled: true, ok: true,
            requestId: status.requestId,
            queued: status.queued === true ? true : undefined,
          });
        }
      } else {
        this.deps.dispatchEvent({
          kind: 'MessageOperationStatus', operationKind: effect.operationKind, ...common,
          interrupted: status.interrupted, settled: status.settled,
          alreadyStopped: status.alreadyStopped,
          forcedRecovery: status.forcedRecovery,
          teardownTimedOut: status.teardownTimedOut,
          recoveryPending: status.recoveryPending,
          occurredAt: Date.now(),
        });
      }
    } catch (error) {
      const detail = toErrorMessage(error);
      const code = error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code ?? '') : '';
      const state = code === 'SESSION_GENERATION_ENDED' || code === 'SESSION_NOT_FOUND'
        || detail.includes('SESSION_GENERATION_ENDED') || detail.includes('SESSION_NOT_FOUND')
        ? 'generation-ended' as const
        : 'reconciliation-unavailable' as const;
      const common = {
        operationId: effect.operationId, sessionPath: effect.sessionPath,
        backendGeneration: effect.backendGeneration,
        operationAttempt: effect.operationAttempt,
        reconciliationAttempt: effect.reconciliationAttempt,
        state, error: detail,
      } as const;
      if (effect.operationKind === 'message.send') {
        this.deps.dispatchEvent({ kind: 'SendOperationStatus', ...common });
      } else {
        this.deps.dispatchEvent({
          kind: 'MessageOperationStatus', operationKind: effect.operationKind,
          ...common, occurredAt: Date.now(),
        });
      }
    }
  }
}

/** Only a transport deadline represents acknowledgement ambiguity. */
function isLocalRequestTimeout(error: unknown): boolean {
  return error instanceof RequestTimeoutError
    || (typeof error === 'object' && error !== null
      && (error as { name?: unknown }).name === 'RequestTimeoutError'
      && (error as { code?: unknown }).code === 'PIE_RPC_TIMEOUT');
}

function toCodedErrorMessage(error: unknown): string {
  const message = toErrorMessage(error);
  const code = error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
  return code && !message.includes(code) ? `${code}: ${message}` : message;
}
