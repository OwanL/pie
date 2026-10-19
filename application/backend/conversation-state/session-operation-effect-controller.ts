import type {
  CompactRpcEffect,
  ContinueRpcEffect,
  EditRpcEffect,
  InterruptRpcEffect,
  SendRpcEffect,
} from './effects/effects';
import type { EffectResultEvent, Event } from './events';
import type {
  ComposerInput,
  PruningMode,
  PruningSettings,
} from '../../lib/protocol/index.js';
import { BACKEND_READY_TIMEOUT_MS } from '../agent-connection/backend-ready-timeout';
import { RequestTimeoutError, type RequestOptions } from '../agent-connection/request-tracker';
import { toErrorMessage } from '../../../lib/structured-logging/error-message';

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
    prepareForSend(sessionPath: string, inputs: ComposerInput[], initialUserMessage?: string, operationId?: string | null): void;
    onTruncatedAfter(sessionPath: string, messageId: string): void;
    onMessageEdited(sessionPath: string, messageId: string): void;
  };
  dispatch(event: EffectResultEvent): void;
  dispatchEvent(event: Event): void;
  timer: SessionOperationTimerSink;
  sendTimerTimeoutMs: number;
  getSendTimerTimeoutMs?: (sessionPath: string) => number;
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

type ReconciliationEffect = Extract<
  import('./effects/effects').Effect,
  { kind: 'ScheduleOperationReconciliation' }
>;

/**
 * Owns non-serializable execution resources for session operations. It emits
 * observations only; operation phase, commit evidence, reconciliation policy,
 * recovery, and terminal outcomes remain reducer-owned.
 */
export class SessionOperationEffectController {
  private readonly registeredSends = new Map<string, RegisteredSendResource>();
  private readonly operationReconciliationTimers = new Map<string, TimerHandle>();
  private readonly queuedEditOperations = new Map<string, ExecutionCancellationTicket>();
  private readonly messageOperationTickets = new Map<string, object>();
  private readonly messageOperationBarriers = new Map<string, () => void>();

  constructor(private readonly deps: SessionOperationEffectControllerDeps) {}

  runSendRpc(effect: SendRpcEffect): void {
    const { queues, backend, dispatch, service, statsService } = this.deps;
    void queues.enqueueSessionOperation(effect.sessionPath, async () => {
      const send = this.startSend(effect);
      const operationAttempt = effect.operationAttempt ?? 1;
      const isCurrentExecution = (): boolean =>
        this.registeredSends.get(effect.corrId)?.ticket === send.ticket;
      try {
        service.bumpSessionDataEpoch(effect.sessionPath);
        if (operationAttempt === 1) {
          statsService.prepareForSend(effect.sessionPath, effect.inputs, effect.text, effect.operationId);
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
          refreshPruning: effect.refreshPruning === true,
          inputs: effect.inputs,
          localId: effect.localId,
        }, {
          signal: send.abort.signal,
          onCorrelatedResponse: settleAcknowledgement,
          ...(coldPromotion ? { timeoutMs: BACKEND_READY_TIMEOUT_MS } : {}),
        });
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

  /** The backend's explicit preflight-succeeded signal disarms the send-timer.
   * There is no host-side model-start watchdog: after preflight success the
   * accepted send is owned by the authoritative backend lifecycle (semantic
   * start/terminal boundaries, definitive preflight failure, generation death)
   * plus an explicit Stop, and may remain pre-commit indefinitely without
   * timer side effects. */
  markPrepassSucceeded(effect: Extract<import('./effects/effects').Effect, { kind: 'MarkPrepassSucceeded' }>): void {
    const resource = this.registeredSends.get(effect.corrId);
    if (resource) {
      if (resource.timer) this.deps.timer.cancel(resource.timer);
      resource.timer = null;
      return;
    }
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
    effect: Extract<import('./effects/effects').Effect, { kind: 'ReleaseOperationResources' }>,
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

  dispose(): void {
    for (const send of this.registeredSends.values()) {
      if (send.timer) this.deps.timer.cancel(send.timer);
      send.abort.abort();
    }
    this.registeredSends.clear();
    for (const timer of this.operationReconciliationTimers.values()) this.deps.timer.cancel(timer);
    this.operationReconciliationTimers.clear();
    this.queuedEditOperations.clear();
    for (const release of this.messageOperationBarriers.values()) release();
    this.messageOperationBarriers.clear();
    this.messageOperationTickets.clear();
  }

  private startSend(effect: SendRpcEffect): RegisteredSendResource {
    const budgetMs = this.deps.getSendTimerTimeoutMs?.(effect.sessionPath)
      ?? this.deps.sendTimerTimeoutMs;
    this.clearRegisteredSend(effect.corrId);
    const resource: RegisteredSendResource = {
      abort: new AbortController(), ticket: {}, timer: null,
    };
    this.registeredSends.set(effect.corrId, resource);
    // Bounds acknowledgement/prepass observation only. Expiry is ambiguity,
    // never rollback; preflight success disarms it until lifecycle settlement.
    const handle = this.deps.timer.schedule(() => {
      if (this.registeredSends.get(effect.corrId)?.timer !== handle) return;
      resource.timer = null;
      this.deps.dispatchEvent({
        kind: 'SendOperationDelayed', operationId: effect.operationId,
        operationAttempt: effect.operationAttempt ?? 1,
        sessionPath: effect.sessionPath,
        backendGeneration: effect.backendGeneration,
      });
    }, budgetMs);
    resource.timer = handle;
    return resource;
  }

  private clearRegisteredSend(corrId: string): void {
    const send = this.registeredSends.get(corrId);
    if (!send) return;
    if (send.timer) this.deps.timer.cancel(send.timer);
    this.registeredSends.delete(corrId);
  }

  private clearSend(corrId: string): void {
    this.clearRegisteredSend(corrId);
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
        statsService.prepareForSend(
          effect.sessionPath,
          effect.inputs,
          effect.composedText ?? effect.text,
          effect.operationId,
        );
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
        && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code : undefined;
      // A missing hot owner can be transient while promotion is still live.
      // Only a structured owning-generation death code authorizes rollback;
      // diagnostic message text is not lifecycle evidence.
      const state = code === 'SESSION_GENERATION_ENDED'
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
