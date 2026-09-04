import { randomUUID } from 'node:crypto';

import type {
  AgentSettledPayload,
  CompactionOutcome,
  CompactionPayload,
  CompactionReason,
  CompactionStartedPayload,
  CompactionSummaryDetails,
  MessageAbortedPayload,
  PreflightFailedPayload,
  RetryEndedPayload,
  RetryMeasuredPayload,
  RetryStartedPayload,
} from '../shared/protocol';
import { COMPACTION_METRICS_CUSTOM_TYPE } from '../shared/protocol';
import { createOperationalIncident } from '../shared/incidents.js';
import { LIVE_PIPELINE_PROTOCOL_VERSION } from '../shared/live-pipeline-protocol';
import type { SdkSessionEvent } from './sdk';
import { BackendLiveTurnAccumulator } from './live-turn-accumulator';
import type { ActiveRequest, SessionContext } from './server-types';
import { buildSessionCapabilities, hasBillableSessionActivity } from './session-activity';
import type { SessionEntryLike } from './transcript';
import {
  clearSemanticLease,
  clearSettledProviderIncident,
  emitLatestPruningResult,
  emitSemanticCandidate,
  logBackendDiagnostic,
  nonEmptyTrimmed,
  readTokenCount,
  renewSemanticLease,
  resolveProviderSemanticInactivityMs,
  resolveUnexpectedInterruptReason,
  type BackendSessionEventHandler,
  type BackendSessionEventHandlerDeps,
} from './session-event-shared';

/** Environment key for the willRetry watchdog grace (added on top of the
 *  SDK's reported backoff `delayMs`). */
const WILLRETRY_WATCHDOG_GRACE_ENV = 'PIE_WILLRETRY_WATCHDOG_GRACE_MS';
/** Default grace added on top of the SDK's backoff delayMs before the
 *  watchdog declares a retry stuck. Generous so a legitimately slow provider
 *  doesn't trip it, but bounded so a backoff that never completes is surfaced. */
const DEFAULT_WILLRETRY_WATCHDOG_GRACE_MS = 60 * 1000;
function resolveWillRetryWatchdogGraceMs(): number {
  const raw = process.env[WILLRETRY_WATCHDOG_GRACE_ENV];
  if (raw === undefined || raw === '') return DEFAULT_WILLRETRY_WATCHDOG_GRACE_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_WILLRETRY_WATCHDOG_GRACE_MS;
}

/** Arm / re-arm the willRetry watchdog. If the watchdog elapses without the
 *  retry completing (auto_retry_end OR agent_end willRetry:false), emit an
 *  operational-error + retry.stuck notice so the user can recover instead of
 *  the session sitting in willRetry forever. Returns a clear function to call
 *  when the retry completes / the turn ends. */
function armWillRetryWatchdog(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  delayMs: number,
): () => void {
  // Clear any existing watchdog so re-arming (e.g. on auto_retry_start) replaces it.
  if (context.willRetryWatchdogTimer) {
    clearTimeout(context.willRetryWatchdogTimer);
    context.willRetryWatchdogTimer = undefined;
  }
  const grace = resolveWillRetryWatchdogGraceMs();
  const windowMs = Math.max(delayMs, 0) + grace;
  context.willRetryWatchdogTimer = setTimeout(() => {
    context.willRetryWatchdogTimer = undefined;
    const active = context.activeRequest;
    const requestId = active?.id;
    deps.emit('operational-error', createOperationalIncident({
      incidentId: `retry-stuck:${requestId ?? context.sessionPath}:${delayMs}:${grace}`,
      dedupeKey: `retry-stuck:${context.sessionPath}:${requestId ?? 'session'}`,
      code: 'RETRY_STUCK',
      message: `A retry has not completed within ${windowMs}ms (delayMs=${delayMs} + ${grace}ms grace). The provider may be down mid-backoff or an extension hook blocked the retry. Reload the window if the session stays wedged.`,
      detail: `Retry watchdog window elapsed: ${windowMs}ms (delayMs=${delayMs}, graceMs=${grace}).`,
      sessionPath: context.sessionPath,
      ...(active?.operationId ? { operationId: active.operationId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(active?.liveTurnAccumulator ? { turnId: active.liveTurnAccumulator.turnId } : {}),
      ...(active?.currentMessageId ?? active?.lastAssistantMessageId
        ? { messageId: active.currentMessageId ?? active.lastAssistantMessageId }
        : {}),
      severity: 'error',
      certainty: 'ambiguous',
      phase: 'retry',
      recovery: { showLogs: true },
    }));
    deps.emit('retry.stuck', {
      sessionPath: context.sessionPath,
      delayMs,
      graceMs: grace,
      requestId: context.activeRequest?.id,
    });
    deps.recoverStuckSession?.(
      context,
      `The provider retry made no progress for ${windowMs}ms and was stopped automatically.`,
    );
  }, windowMs);
  return () => {
    if (context.willRetryWatchdogTimer) {
      clearTimeout(context.willRetryWatchdogTimer);
      context.willRetryWatchdogTimer = undefined;
    }
  };
}
function readPostCompactionEstimatedTokens(result: unknown): number | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const value = (result as { estimatedTokensAfter?: unknown }).estimatedTokensAfter;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}
/** Minimal slice of the SDK SessionManager's sidecar append surface. The runtime
 *  manager is a fenced `MutableSdkSessionManager` (see `session-manager-fence.ts`)
 *  that proxies `appendCustomEntry`; this local type captures only what
 *  {@link appendCompactionMetricsSidecar} needs without widening
 *  `SdkSessionManager`'s public contract in `sdk.ts`. */
interface SessionManagerSidecarAppender {
  appendCustomEntry(customType: string, data?: unknown): string;
}

/** Find the id of the most recent compaction entry in the session branch. The
 *  SDK appends the compaction entry before emitting `compaction_end`, so this
 *  scan always sees it on a successful compaction. Returns `undefined` when no
 *  compaction entry exists (failed/aborted attempt, or an unexpected SDK shape). */
function latestCompactionEntry(context: SessionContext): SessionEntryLike | undefined {
  const branch = (context.session.sessionManager?.getBranch?.() ?? []) as SessionEntryLike[];
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === 'compaction') return entry;
  }
  return undefined;
}

function readPieCompactionDetails(entry: SessionEntryLike): Record<string, unknown> | undefined {
  if (!entry.details || typeof entry.details !== 'object' || Array.isArray(entry.details)) return undefined;
  const pie = (entry.details as Record<string, unknown>).pieCompaction;
  return pie && typeof pie === 'object' && !Array.isArray(pie)
    ? pie as Record<string, unknown>
    : undefined;
}

/** Append a non-context `pie.compaction-metrics` sidecar entry after a
 *  successful compaction so the metrics survive transcript reload. The sidecar
 *  is a `custom` entry (via `appendCustomEntry`) — it never participates in LLM
 *  context and never renders as its own transcript row; `mapTranscript` scans
 *  it and attaches typed {@link CompactionSummaryDetails} to the matching
 *  compaction-summary ChatMessage. No-ops when the SDK exposes no
 *  `appendCustomEntry` (older SDK), the compaction entry can't be linked, or no
 *  usable token metric is available. */
function appendCompactionMetricsSidecar(context: SessionContext, event: SdkSessionEvent): void {
  const result = event.result;
  if (!result || typeof result !== 'object') return;
  const compactionEntry = latestCompactionEntry(context);
  const compactionEntryId = compactionEntry?.id;
  if (!compactionEntryId || !compactionEntry) return;

  const resultRecord = result as { tokensBefore?: unknown; estimatedTokensAfter?: unknown };
  const tokensBefore = readTokenCount(resultRecord.tokensBefore);
  const estimatedTokensAfter = readPostCompactionEstimatedTokens(result);
  // Need at least one token metric for the sidecar to be useful.
  if (tokensBefore === undefined && estimatedTokensAfter === undefined) return;

  const manager = context.session.sessionManager as
    (typeof context.session.sessionManager) & Partial<SessionManagerSidecarAppender>;
  if (typeof manager.appendCustomEntry !== 'function') return;

  const startedAt = context.compactionStartedAt;
  const durationMs = typeof startedAt === 'number'
    ? Math.max(0, Date.now() - startedAt)
    : undefined;

  const sidecar: CompactionSummaryDetails & { compactionEntryId: string } = {
    compactionEntryId,
    reason: typeof event.reason === 'string' ? event.reason : '',
  };
  if (tokensBefore !== undefined) sidecar.tokensBefore = tokensBefore;
  if (estimatedTokensAfter !== undefined) sidecar.estimatedTokensAfter = estimatedTokensAfter;
  if (durationMs !== undefined) sidecar.durationMs = durationMs;

  const customDetails = readPieCompactionDetails(compactionEntry);
  const modelId = typeof customDetails?.modelId === 'string'
    ? customDetails.modelId
    : context.session.model?.id;
  const provider = typeof customDetails?.provider === 'string'
    ? customDetails.provider
    : context.session.model?.provider;
  const thinkingLevel = typeof customDetails?.thinkingLevel === 'string'
    ? customDetails.thinkingLevel
    : context.session.thinkingLevel;
  if (typeof modelId === 'string' && modelId.length > 0) sidecar.modelId = modelId;
  if (typeof provider === 'string' && provider.length > 0) sidecar.provider = provider;
  if (typeof thinkingLevel === 'string' && thinkingLevel.length > 0) sidecar.thinkingLevel = thinkingLevel;

  try {
    manager.appendCustomEntry(COMPACTION_METRICS_CUSTOM_TYPE, sidecar);
  } catch (error) {
    logBackendDiagnostic('warn', 'compaction.metricsSidecarAppendFailed', {
      sessionPath: context.sessionPath,
      compactionEntryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
function finishRetryTiming(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  endedAt: number,
): void {
  const active = context.activeRequest;
  const timing = active?.retryTiming;
  if (!active || !timing) return;
  deps.emit('retry.measured', {
    sessionPath: context.sessionPath,
    requestId: active.id,
    retryId: timing.retryId,
    ...(timing.providerAttemptStartedAt === undefined
      ? {}
      : { measuredDelayMs: Math.max(0, timing.providerAttemptStartedAt - timing.startedAt) }),
    durationMs: Math.max(0, endedAt - timing.startedAt),
  } satisfies RetryMeasuredPayload);
  active.retryTiming = undefined;
}
/** Restore request correlation after successful provider-overflow recovery.
 * Pi emits agent_end(willRetry=false) before it identifies the overflow. Keep
 * or restore the same public request owner before agent.continue() starts so
 * continuation events retain their correlation. */
function rearmPostAgentCompactionRequest(
  context: SessionContext,
  active: ActiveRequest | undefined,
  occurredAt: number,
): boolean {
  if (!active || active.aborted || (context.activeRequest && context.activeRequest !== active)) return false;

  active.liveTurnAccumulator = new BackendLiveTurnAccumulator({
    protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
    sessionPath: context.sessionPath,
    requestId: active.id,
    ...(active.operationId ? { operationId: active.operationId } : {}),
    turnId: randomUUID(),
    attemptId: randomUUID(),
    canonicalMessageId: `${active.id}:${active.messageIndex + 1}`,
    modelId: active.modelId,
    provider: active.provider,
    thinkingLevel: active.thinkingLevel,
    startedAt: occurredAt,
  });
  active.pendingQueuedBoundaryTerminal = undefined;
  active.pendingErrorTerminal = undefined;
  active.mayNeedOverflowRecovery = false;
  active.pendingDurableToolTerminals?.clear();
  active.toolStartTimes?.clear();
  active.toolStartMetadata?.clear();
  active.toolParallelGroupByCallId?.clear();
  active.providerQueueByTurn?.clear();
  active.providerNetworkPendingAttemptId = undefined;
  active.providerNetworkPending = false;
  active.retryTiming = undefined;
  active.currentMessageId = undefined;
  active.currentMessageStartedAt = undefined;
  active.providerFirstDeltaAt = undefined;
  active.turnStartedAt = undefined;
  active.turnBoundaryAt = occurredAt;
  active.aborted = false;
  context.activeRequest = active;
  if (context.overflowRecoveryCandidate === active) context.overflowRecoveryCandidate = undefined;
  return true;
}

function handleLifecycleSessionEvent(
  deps: BackendSessionEventHandlerDeps,
  context: SessionContext,
  event: SdkSessionEvent,
): void {
  switch (event.type) {
    case 'agent_start': {
      // A later ordinary request supersedes any finalized error that did not
      // lead to overflow compaction. Successful overflow recovery clears the
      // candidate while re-arming it before this event arrives.
      if (context.activeRequest && context.overflowRecoveryCandidate !== context.activeRequest) {
        context.overflowRecoveryCandidate = undefined;
      }
      // before_agent_start extensions persist their injected custom message
      // before agent_start. Read it from the authoritative branch so pruning
      // summaries do not depend on the SDK also producing message_end/custom.
      emitLatestPruningResult(deps, context);
      deps.emitBusyChanged(context, hasBillableSessionActivity(context));
      deps.emitContextUsageChanged(context);
      return;
    }

    case 'turn_start': {
      // Some SDK versions append the before_agent_start custom entry just after
      // agent_start. Re-check at turn_start; stable-id dedupe makes this cheap.
      emitLatestPruningResult(deps, context);
      // `turn_start` fires at the start of every turn, before request building
      // (`convertToLlm`, auth resolution) and the provider HTTP dispatch. It is
      // the cleanest observable boundary between serial inter-turn work on our
      // side and the provider request: overhead = turnBoundaryAt → turnStartedAt,
      // provider = turnStartedAt → first reply token.
      if (!context.activeRequest) {
        return;
      }
      context.activeRequest.turnStartedAt = Date.now();
      context.activeRequest.semanticStarted = true;
      context.activeRequest.providerTurnSequence = (context.activeRequest.providerTurnSequence ?? 0) + 1;
      // message_start is too late to own provider hangs before the first
      // assistant event (for example, no response headers after a tool result).
      // Start the semantic lease at the SDK's provider-turn boundary and renew
      // it again at message_start/semantic deltas.
      const providerLeaseMs = resolveProviderSemanticInactivityMs(context.activeRequest.provider);
      renewSemanticLease(deps, context, providerLeaseMs, 'provider');
      const accumulator = context.activeRequest.liveTurnAccumulator;
      const liveSeq = accumulator?.currentSeq ?? 0;
      if (liveSeq === 0) {
        // The first semantic provider-turn boundary is commit evidence even if
        // the following event is delayed or dropped before reaching the host.
        context.sendOperationLedger?.markCommitted(context.activeRequest.operationId);
        emitSemanticCandidate(deps, context, { kind: 'turn.started' }, context.activeRequest.turnStartedAt);
        emitSemanticCandidate(deps, context, {
          kind: 'turn.phase', phase: 'preparing', inactivityBudgetMs: providerLeaseMs,
        }, context.activeRequest.turnStartedAt);
      } else if (!accumulator?.lifecycleWatermark()) {
        emitSemanticCandidate(deps, context, {
          kind: 'turn.phase', phase: 'waiting_provider', inactivityBudgetMs: providerLeaseMs,
        }, context.activeRequest.turnStartedAt);
      }
      return;
    }

    case 'agent_end': {
      // The SDK re-emits `agent_end` mid-retry with `willRetry: true` (after a
      // transient error, before the backoff sleep + retry turn). Finalizing
      // here would clear `activeRequest` — breaking the retry turn's streaming,
      // since `message_start` / `message_end` are gated on it — and flicker
      // `busy` false (then true again on the retry's `agent_start`). Skip
      // finalization on a will-retry `agent_end`; the final `agent_end`
      // (`willRetry: false`) performs the normal idle cleanup below.
      if (event.willRetry) {
        // A retry backoff that never completes must surface within the
        // reported delay plus grace. If the SDK's backoff/retry never completes
        // (provider dies mid-backoff, or an
        // extension hook blocks the retry), `activeRequest` would stay set
        // forever with no observable failure. The watchdog emits
        // `operational-error` + `retry.stuck` after the backoff delay + grace so
        // the user can recover instead of reloading the window. Re-armed with
        // the real delayMs on `auto_retry_start`; cleared on `auto_retry_end` /
        // the final `agent_end willRetry:false`.
        // delayMs is unknown here (the SDK doesn't carry it on agent_end); use
        // 0 until auto_retry_start refines it (the grace alone bounds it).
        context.willRetryWatchdogClear = armWillRetryWatchdog(deps, context, 0);
        if (context.activeRequest) context.activeRequest.pendingErrorTerminal = undefined;
        return;
      }
      // agent_end closes one low-level attempt only. Pi may still perform
      // post-run compaction, retry, queued continuation, or tool/bash work;
      // retain request/busy ownership until the pinned agent_settled boundary.
      clearSemanticLease(context);
      deps.emitContextUsageChanged(context);
      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      context.overflowRecoveryCandidate = context.activeRequest?.mayNeedOverflowRecovery
        ? context.activeRequest
        : undefined;
      return;
    }

    case 'agent_settled': {
      clearSemanticLease(context);
      const settledRequest = context.activeRequest;
      const requestId = context.activeRequest?.id;
      const operationId = context.activeRequest?.operationId;
      const operationAttempt = context.activeRequest?.operationAttempt;
      const turnId = context.activeRequest?.liveTurnAccumulator?.turnId;
      const attemptId = context.activeRequest?.liveTurnAccumulator?.attemptId;
      const messageId = context.activeRequest?.lastAssistantMessageId;
      const modelId = context.activeRequest?.modelId;
      const userInitiated = context.activeRequest?.aborted === true;
      const interruptedWithoutMessage = !!requestId && !messageId;
      const pendingExtensionCommand = context.pendingExtensionCommand;
      const extensionCommandWithoutAgent = (
        context.activeRequest?.extensionCommand === true && interruptedWithoutMessage
      ) || (
        pendingExtensionCommand !== undefined
        && pendingExtensionCommand.session === context.session
        && pendingExtensionCommand.sessionPath === context.sessionPath
        && pendingExtensionCommand.sessionOwnershipEpoch === (context.sessionOwnershipEpoch ?? 0)
        && (requestId === undefined || requestId === pendingExtensionCommand.requestId)
        && !messageId
      );
      const extensionCommandRequestId = pendingExtensionCommand?.requestId ?? requestId;
      const liveAccumulator = context.activeRequest?.liveTurnAccumulator;
      const pendingErrorTerminal = context.activeRequest?.pendingErrorTerminal;
      if (liveAccumulator && pendingErrorTerminal) {
        emitSemanticCandidate(deps, context, {
          kind: 'turn.terminal',
          terminalKind: 'error',
          ...pendingErrorTerminal,
        });
        context.activeRequest!.pendingErrorTerminal = undefined;
      }
      const watermark = liveAccumulator?.lifecycleWatermark();
      if (watermark) deps.emit('live.lifecycle', watermark);
      if (liveAccumulator) {
        context.terminalLiveTurn = { accumulator: liveAccumulator, expiresAt: Date.now() + 10_000 };
      }

      if (extensionCommandWithoutAgent && extensionCommandRequestId) {
        context.sendOperationLedger?.markFailed(operationId, 'MESSAGE_SEND_PRECOMMIT_FAILED', 'Extension command ended without starting an agent turn.');
        deps.emit('preflight.failed', {
          requestId: extensionCommandRequestId,
          ...(operationId ? { operationId } : {}),
          ...(operationAttempt !== undefined ? { operationAttempt } : {}),
          sessionPath: pendingExtensionCommand?.sessionPath ?? context.sessionPath,
          error: 'Extension command ended without starting an agent turn.',
        } satisfies PreflightFailedPayload);
      }
      if (pendingExtensionCommand?.requestId === extensionCommandRequestId) {
        context.pendingExtensionCommand = undefined;
      }
      deps.emitContextUsageChanged(context);

      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      if (context.activeRequest?.quotaSettlementTimer) {
        clearTimeout(context.activeRequest.quotaSettlementTimer);
        context.activeRequest.quotaSettlementTimer = undefined;
      }

      context.overflowRecoveryCandidate = undefined;
      // Clear activeRequest only at full SDK settlement. agent_end above is not
      // sufficient evidence because Pi can continue automatically afterwards.
      context.activeRequest = undefined;

      if (requestId && interruptedWithoutMessage && !settledRequest?.terminalWithoutMessageEmitted) {
        if (settledRequest) settledRequest.terminalWithoutMessageEmitted = true;
        if (!userInitiated) {
          logBackendDiagnostic('info', 'request.interruptedWithoutMessage', {
            requestId,
            sessionPath: context.sessionPath,
            modelId,
            reason: resolveUnexpectedInterruptReason(undefined),
          });
        }
        context.sendOperationLedger?.markFailed(
          operationId,
          'MESSAGE_OPERATION_ABORTED_BEFORE_COMMIT',
          userInitiated
            ? 'The message operation was cancelled before it started.'
            : resolveUnexpectedInterruptReason(undefined),
          userInitiated ? 'cancelled' : 'failed',
        );
        deps.emit('message.aborted', {
          requestId,
          ...(operationId ? { operationId } : {}),
          ...(operationAttempt !== undefined ? { operationAttempt } : {}),
          sessionPath: context.sessionPath,
          ...(operationId ? { outcome: userInitiated ? 'cancelled' as const : 'failed' as const } : {}),
          userInitiated,
          reason: userInitiated ? undefined : resolveUnexpectedInterruptReason(undefined),
        } satisfies MessageAbortedPayload);
      }

      const capabilities = buildSessionCapabilities(context);
      deps.emit('agent.settled', {
        sessionPath: context.sessionPath,
        capabilities,
        ...(operationId ? { operationId } : {}),
        ...(requestId ? { requestId } : {}),
        ...(turnId ? { turnId } : {}),
        ...(attemptId ? { attemptId } : {}),
        ...(operationAttempt !== undefined ? { operationAttempt } : {}),
        ...(deps.backendGeneration !== undefined ? { backendGeneration: deps.backendGeneration } : {}),
        ...(deps.workerGeneration !== undefined ? { workerGeneration: deps.workerGeneration } : {}),
      } satisfies AgentSettledPayload);
      deps.emitBusyChanged(context, capabilities.billableActivity, capabilities);
      void deps.emitSessionOpened(context.sessionPath);
      void deps.emitSessionListChanged();
      return;
    }

    case 'compaction_start': {
      // Auto/manual compaction is a billable LLM call. Automatic compaction can
      // run after `agent_end`, while manual compaction has no active request;
      // the shared activity classifier keeps both paths interruptible until the
      // SDK reaches its terminal activity boundary.
      //
      // Capture the start time so `compaction_end` can compute `durationMs`
      // for the `pie.compaction-metrics` sidecar. Cleared on `compaction_end`
      // (whether successful or not).
      context.compactionStartedAt = Date.now();
      const manualOperation = event.reason === 'manual' ? context.manualCompactionRequest : undefined;
      // Manual compact first awaits agent abort and only then creates the SDK
      // compaction controller. Stop can win that gap; replay its cancellation
      // intent now that abortCompaction has an authoritative controller to hit,
      // before provider auth/hooks can advance to the billable request.
      if (event.reason === 'manual' && context.manualCompactionRequest?.cancelled) {
        context.session.abortCompaction?.();
      }
      const compactionCapabilities = buildSessionCapabilities(context, { compacting: true });
      deps.emitBusyChanged(context, true, compactionCapabilities);
      // Host-facing signal so the UI can show a live "Compacting…" indicator
      // (compaction emits no message_start/message_end, so busy alone reads as
      // a generic run).
      deps.emit('compaction.started', {
        sessionPath: context.sessionPath,
        ...(manualOperation?.operationId ? { operationId: manualOperation.operationId } : {}),
        ...(manualOperation?.operationAttempt !== undefined
          ? { operationAttempt: manualOperation.operationAttempt } : {}),
      } satisfies CompactionStartedPayload);
      return;
    }
    case 'compaction_end': {
      // The SDK's result/aborted fields are the terminal authority: a result is
      // success, an aborted event is cancellation, and a result-less event is
      // failure. Keep this mapping explicit instead of inferring success from
      // compaction_end itself, since the SDK emits the same boundary for all
      // three outcomes.
      const outcome: CompactionOutcome = event.aborted === true
        ? 'aborted'
        : event.result !== undefined && event.result !== null
          ? 'succeeded'
          : 'failed';
      const reason: CompactionReason | undefined = event.reason === 'manual'
        || event.reason === 'threshold'
        || event.reason === 'overflow'
        ? event.reason
        : undefined;
      const succeeded = outcome === 'succeeded';
      const manualOperation = event.reason === 'manual' ? context.manualCompactionRequest : undefined;
      if (manualOperation?.operationId) {
        if (succeeded) {
          context.sendOperationLedger?.markCommitted(manualOperation.operationId);
        } else {
          context.sendOperationLedger?.markFailed(
            manualOperation.operationId,
            outcome === 'aborted' ? 'MESSAGE_COMPACT_ABORTED' : 'MESSAGE_COMPACT_FAILED',
            event.errorMessage ?? `Manual history compaction ${outcome}.`,
            outcome === 'aborted' ? 'aborted' : 'failed',
          );
        }
      }

      // Native provider-overflow recovery reports agent_end(willRetry=false)
      // before compaction, then resumes with agent.continue() after a successful
      // compaction. Restore the finalized request before publishing the
      // refreshed snapshot or receiving continuation events.
      if (event.reason === 'overflow' && event.willRetry) {
        rearmPostAgentCompactionRequest(
          context,
          context.activeRequest ?? context.overflowRecoveryCandidate,
          Date.now(),
        );
        context.overflowRecoveryCandidate = undefined;
      } else {
        context.overflowRecoveryCandidate = undefined;
      }
      // SDK emits compaction_end before clearing its compaction controller.
      // Ignore only that ending window; retained request/queue/retry/bash
      // activity keeps the session busy until agent_settled. The manual marker
      // ends at the same authoritative event so it cannot keep capabilities
      // artificially busy until the request-handler promise resumes.
      if (event.reason === 'manual') context.manualCompactionRequest = undefined;
      const postCompactionCapabilities = buildSessionCapabilities(context, { compacting: false });
      deps.emitBusyChanged(
        context,
        postCompactionCapabilities.billableActivity,
        postCompactionCapabilities,
      );
      // A successful compaction has now appended the CompactionEntry. Refresh
      // both the context indicator and transcript so manual and automatic
      // compaction visibly surface the generated summary instead of only
      // appearing after reopen. Failed/aborted attempts append nothing.
      if (succeeded) {
        // Append the durable `pie.compaction-metrics` sidecar BEFORE
        // `emitSessionOpened` so the refreshed transcript scan picks it up and
        // attaches typed `CompactionSummaryDetails` to the compaction-summary
        // row. No-op when the SDK exposes no `appendCustomEntry` or the
        // compaction entry / token metrics can't be linked.
        appendCompactionMetricsSidecar(context, event);
        // The new prompt has not produced assistant usage yet, but the SDK
        // supplies its post-compaction token estimate. Publish that immediately
        // instead of clearing the indicator until the next user message.
        deps.emitContextUsageChanged(context, readPostCompactionEstimatedTokens(event.result));
        void deps.emitSessionOpened(context.sessionPath);
        void deps.emitSessionListChanged();
      }
      // Clear the captured start time whether the compaction succeeded or not,
      // so a later `compaction_start` (re-arm) does not inherit a stale mark.
      context.compactionStartedAt = undefined;
      // Emit a host-facing signal so run-analytics can count this billable
      // compaction LLM call against the run, and so the UI can clear its
      // "Compacting…" indicator and surface a "Compacted" chip. Token metrics
      // come from the SDK result when the compaction produced one.
      deps.emit('compaction.ended', {
        sessionPath: context.sessionPath,
        ...(manualOperation?.operationId ? { operationId: manualOperation.operationId } : {}),
        ...(manualOperation?.operationAttempt !== undefined
          ? { operationAttempt: manualOperation.operationAttempt } : {}),
        ...(reason !== undefined ? { reason } : {}),
        outcome,
        occurredAt: Date.now(),
        ...(succeeded ? {
          tokensBefore: readTokenCount((event.result as { tokensBefore?: unknown }).tokensBefore),
          estimatedTokensAfter: readPostCompactionEstimatedTokens(event.result),
        } : {}),
      } satisfies CompactionPayload);
      return;
    }
    case 'auto_retry_start': {
      clearSemanticLease(context);
      const startedAt = Date.now();
      finishRetryTiming(deps, context, startedAt);
      const incidentMessage = context.activeRequest?.latestProviderIncident?.userMessage;
      const surfacedErrorMessage = incidentMessage
        ?? nonEmptyTrimmed(event.errorMessage)
        ?? '';
      if (context.activeRequest) {
        const errorMessage = nonEmptyTrimmed(surfacedErrorMessage);
        context.activeRequest.lastRetryErrorMessage = errorMessage
          ?? context.activeRequest.lastRetryErrorMessage;
        context.activeRequest.lastProviderErrorForDiagnostics = errorMessage
          ?? context.activeRequest.lastProviderErrorForDiagnostics;
      }
      // Re-arm with the SDK's reported backoff delayMs so the watchdog window
      // matches the real retry cadence (not the conservative 0 from
      // agent_end willRetry). The grace is added on top.
      if (context.willRetryWatchdogClear !== undefined) {
        context.willRetryWatchdogClear = armWillRetryWatchdog(deps, context, event.delayMs ?? 0);
      }
      emitSemanticCandidate(deps, context, {
        kind: 'turn.phase',
        phase: 'retry_wait',
        inactivityBudgetMs: (event.delayMs ?? 0) + resolveWillRetryWatchdogGraceMs(),
      });
      const requestId = context.activeRequest?.id;
      const attempt = event.attempt ?? 0;
      const retryId = requestId ? `${requestId}:${attempt}` : undefined;
      if (context.activeRequest && retryId) {
        context.activeRequest.retryTiming = {
          retryId,
          attempt,
          startedAt,
          scheduledDelayMs: Math.max(0, event.delayMs ?? 0),
        };
      }
      deps.emit('retry.started', {
        sessionPath: context.sessionPath,
        attempt,
        maxAttempts: event.maxAttempts ?? 0,
        delayMs: event.delayMs ?? 0,
        errorMessage: surfacedErrorMessage,
        ...(requestId && retryId ? { requestId, retryId, startedAt } : {}),
      } satisfies RetryStartedPayload);
      return;
    }

    case 'auto_retry_end': {
      finishRetryTiming(deps, context, Date.now());
      if (context.activeRequest) {
        if (event.success === true) {
          context.activeRequest.lastRetryErrorMessage = undefined;
          context.activeRequest.pendingErrorTerminal = undefined;
          clearSettledProviderIncident(context);
        } else {
          const finalError = nonEmptyTrimmed(event.finalError);
          context.activeRequest.lastRetryErrorMessage = finalError
            ?? context.activeRequest.lastRetryErrorMessage;
          context.activeRequest.lastProviderErrorForDiagnostics = finalError
            ?? context.activeRequest.lastProviderErrorForDiagnostics;
        }
      }
      // Clear the watchdog on retry completion (success or final failure).
      // The subsequent agent_end willRetry:false will re-clear (idempotent).
      if (context.willRetryWatchdogClear) {
        context.willRetryWatchdogClear();
        context.willRetryWatchdogClear = undefined;
      }
      emitSemanticCandidate(deps, context, {
        kind: 'turn.phase', phase: event.success === true ? 'waiting_provider' : 'aborting', inactivityBudgetMs: 120_000,
      });
      deps.emit('retry.ended', {
        sessionPath: context.sessionPath,
        success: event.success === true,
        attempt: event.attempt ?? 0,
        finalError: event.finalError,
      } satisfies RetryEndedPayload);
      return;
    }

    case 'turn_end':
      return;

    default:
      return;
  }
}

export const LIFECYCLE_SDK_EVENT_HANDLERS = {
  agent_start: handleLifecycleSessionEvent,
  turn_start: handleLifecycleSessionEvent,
  agent_end: handleLifecycleSessionEvent,
  agent_settled: handleLifecycleSessionEvent,
  compaction_start: handleLifecycleSessionEvent,
  compaction_end: handleLifecycleSessionEvent,
  auto_retry_start: handleLifecycleSessionEvent,
  auto_retry_end: handleLifecycleSessionEvent,
  turn_end: handleLifecycleSessionEvent,
} as const satisfies Record<string, BackendSessionEventHandler>;
