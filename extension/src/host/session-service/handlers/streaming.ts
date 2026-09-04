import type { RunObserver } from '../../stats-service';
import type { ArchState } from '../../core/arch-state';
import { recordStreamEvent } from '../../util/stream-telemetry';
import type { SessionServiceState } from '../state';
import type { Event } from '../../core/events';
import type {
  AuxiliaryLlmUsagePayload,
  CompactionPayload,
  CompactionStartedPayload,
  MessageAbortedPayload,
  MessageDeltaPayload,
  MessageFinishedPayload,
  MessageStartedPayload,
  MessageThinkingPayload,
  MessageToolCallDeltaPayload,
  PreflightFailedPayload,
  QueuedDeliveredPayload,
  RetryEndedPayload,
  RetryMeasuredPayload,
  RetryStartedPayload,
  RetryStuckPayload,
  SessionSummary,
  ThinkingLevel,
} from '../../../shared/protocol';
import type { TurnThroughputStatus } from '../../run-analytics';
import { stripReqIds } from '../../../shared/error-mapping.js';

/**
 * Map a finished assistant message's status onto the throughput-sample
 * status. `streaming` should not occur at `message_end` and is treated as a
 * normal completion.
 */
function toTurnThroughputStatus(status: string | undefined): TurnThroughputStatus {
  if (status === 'error') {
    return 'error';
  }
  if (status === 'interrupted') {
    return 'interrupted';
  }
  return 'completed';
}

const DEFAULT_UNEXPECTED_INTERRUPT_REASON =
  'The session stopped unexpectedly before the assistant finished responding.';

interface HandlerDeps {
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  runObserver: RunObserver;
  state: SessionServiceState;
  scheduleRender: () => void;
  requireEventSessionPath: (eventName: string, sessionPath: string | undefined) => string | null;
}

export function onMessageDelta(payload: MessageDeltaPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.delta', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'MessageDelta',
    sessionPath,
    messageId: payload.messageId,
    delta: payload.delta,
  });
  recordStreamEvent('delta');
}

export function onMessageThinking(payload: MessageThinkingPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.thinking', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'MessageThinking',
    sessionPath,
    messageId: payload.messageId,
    thinking: payload.thinking,
  });
  recordStreamEvent('thinking');
}

export function onMessageToolCallDelta(payload: MessageToolCallDeltaPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.toolCallDelta', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // Tool-call argument deltas are intentionally not mirrored into ArchState.
  // The completed ToolCall event carries the authoritative payload.
  recordStreamEvent('delta');
}

/** Reconcile one turn's exact serving identity into run analytics and the
 *  session summary. The backend-reported provider/model is the billing
 *  identity for this exact turn — update the run before it starts so per-turn
 *  usage cannot inherit a stale selection (notably same-id Codex vs Copilot
 *  models) — and the composer's per-session badge must not keep falling back
 *  to the stale global default. Shared by the legacy `message.started` path
 *  and the live semantic `turn.started` path so both behave identically. */
export function reconcileServingModelConfig(
  sessionPath: string,
  modelId: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  provider: string | undefined,
  deps: Pick<HandlerDeps, 'runObserver' | 'getArchState' | 'dispatchArch'>,
): void {
  deps.runObserver.onModelConfigChanged(sessionPath, modelId, thinkingLevel, provider);
  if (!modelId) return;
  const archState = deps.getArchState();
  const session = archState.sessions.sessions.find((s: SessionSummary) => s.path === sessionPath);
  if (session && (session.modelId !== modelId || session.provider !== provider || session.thinkingLevel !== thinkingLevel)) {
    deps.dispatchArch({
      kind: 'SessionMetadataChanged',
      sessionPath,
      modelId,
      provider,
      thinkingLevel,
    });
  }
}

export function onMessageStarted(payload: MessageStartedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.started', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'MessageStarted',
    sessionPath,
    messageId: payload.messageId,
    requestId: payload.requestId,
    ...(payload.operationId ? {
      operationId: payload.operationId,
      operationAttempt: payload.operationAttempt,
    } : {}),
    modelId: payload.modelId,
    provider: payload.provider,
    thinkingLevel: payload.thinkingLevel,
    timestamp: Date.now(),
  });

  deps.state.bindRequestSessionPath(payload.requestId, sessionPath);
  reconcileServingModelConfig(sessionPath, payload.modelId, payload.thinkingLevel, payload.provider, deps);
  deps.runObserver.onAssistantTurnStarted(sessionPath, payload.messageId);

  deps.state.touchSessionTranscript(sessionPath);
}

interface TerminalHandlerOptions {
  /** Canonical live semantic path already committed transcript state. */
  skipTranscriptMutation?: boolean;
  /** A paired terminal handler already recorded the observer boundary. */
  skipObserver?: boolean;
}

export function onMessageFinished(
  payload: MessageFinishedPayload,
  deps: HandlerDeps,
  options: TerminalHandlerOptions = {},
): void {
  const sessionPath = deps.requireEventSessionPath('message.finished', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  // The backend terminal owns its own row detail. Never borrow the current
  // global notice: it may belong to a different operation or a newer turn.
  const message = payload.message;

  if (!options.skipTranscriptMutation) {
    deps.dispatchArch({
      kind: 'MessageFinished',
      sessionPath,
      requestId: payload.requestId,
      ...(payload.operationId ? {
        operationId: payload.operationId,
        operationAttempt: payload.operationAttempt,
      } : {}),
      message,
    });
  }
  if (!options.skipObserver) deps.runObserver.onAssistantTurnEnded(
    sessionPath,
    message.id,
    message.durationMs ?? 0,
    message.usage,
    toTurnThroughputStatus(message.status),
    message.turnLatencyMs !== undefined || message.overheadMs !== undefined
      || message.providerLatencyMs !== undefined || message.providerQueueMs !== undefined
      ? {
          turnLatencyMs: message.turnLatencyMs,
          overheadMs: message.overheadMs,
          providerLatencyMs: message.providerLatencyMs,
          providerQueueMs: message.providerQueueMs,
          providerQueueAttemptCount: message.providerQueueAttemptCount,
        }
      : undefined,
    {
      modelId: message.modelId,
      provider: message.provider,
      occurredAt: message.createdAt,
      operationId: payload.operationId,
    },
  );
  deps.state.unbindRequestSessionPath(payload.requestId);

  // MessageFinished replaces the streaming entry with its authoritative form.
  // The next snapshot diff naturally produces the content replacement.
  deps.state.touchSessionTranscript(sessionPath);
}

export function onMessageAborted(
  payload: MessageAbortedPayload,
  deps: HandlerDeps,
  options: TerminalHandlerOptions = {},
): void {
  const sessionPath = deps.requireEventSessionPath('message.aborted', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  const userInitiated = payload.userInitiated === true;
  const expectedPreStartSettlement = payload.outcome === 'cancelled' || payload.outcome === 'superseded';
  const reason = userInitiated || expectedPreStartSettlement
    ? undefined
    : stripReqIds(payload.reason?.trim() || DEFAULT_UNEXPECTED_INTERRUPT_REASON);

  if (!options.skipTranscriptMutation) {
    deps.dispatchArch({
      kind: 'MessageAborted',
      sessionPath,
      requestId: payload.requestId,
      ...(payload.operationId ? {
        operationId: payload.operationId,
        operationAttempt: payload.operationAttempt,
      } : {}),
      messageId: payload.messageId,
      ...(payload.localId ? { localId: payload.localId } : {}),
      ...(payload.outcome ? { outcome: payload.outcome } : {}),
      userInitiated,
      reason,
    });
  }

  if (reason && !payload.incidentId) {
    // A pre-row failure that names its typed incident is reported there;
    // other unexpected interruptions still own this discoverable notice, even
    // when an unrelated error notice is already showing.
    // Previously this was suppressed whenever `noticeRaw`/`noticeKind` was
    // non-null, which could hide the interrupt alert behind an unrelated
    // error notice. The per-message `errorDetail` is already stamped inline
    // by the reducer, but the global notice banner is the discoverable
    // signal at the top of the panel, so it must reflect the interruption
    // too. De-dupe only against the *same* reason (avoid an identical
    // re-show), and otherwise append to the existing notice so the user sees
    // both the prior context and the new interruption.
    const settings = deps.getArchState().settings;
    const existing = settings.notice;
    const existingOwner = settings.noticeSessionPath;
    if (existing === reason && (existingOwner === null || existingOwner === sessionPath)) {
      // Already showing this exact reason — no-op.
    } else if (
      existing
      && (existingOwner === null || existingOwner === sessionPath)
      && !existing.includes(reason)
      && !reason.includes(existing)
    ) {
      deps.dispatchArch({
        kind: 'NoticeShown',
        notice: `${existing} — ${reason}`,
        sessionPath: existingOwner,
        noticeKind: 'operational-error',
        noticeRaw: `${existing} — ${reason}`,
      });
    } else {
      deps.dispatchArch({
        kind: 'NoticeShown',
        notice: reason,
        noticeKind: 'operational-error',
        noticeRaw: reason,
        sessionPath,
      });
    }
  }

  if (payload.messageId && !options.skipObserver) {
    deps.runObserver.onAssistantTurnEnded(
      sessionPath,
      payload.messageId,
      0,
      undefined,
      'interrupted',
      undefined,
    );
  }

  deps.runObserver.onInterrupted(sessionPath);
  deps.state.touchSessionTranscript(sessionPath);
}

/**
 * Post-ack, pre-commit prepass failure: `message.send` already early-acked
 * (prompt queued) but the pruning prepass then failed. Forward as a
 * `PreflightFailed` reducer event so the reducer reverts via
 * `pending.promoted[corrId]` (resolved by `requestId`). The backend mints
 * `requestId` but never sees the host `corrId`, so no `corrId` is dispatched
 * here; the reducer resolves it. (Brief B's send-timer dispatches the same
 * event WITH `corrId`.) See `docs/STATE_CONTRACT.md` § Optimistic
 * Reconciliation "Two failure windows for send".
 */
export function onPreflightFailed(payload: PreflightFailedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('preflight.failed', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'PreflightFailed',
    sessionPath,
    requestId: payload.requestId,
    ...(payload.operationId ? { operationId: payload.operationId } : {}),
    error: payload.error,
  });
}

export function onQueuedDelivered(payload: QueuedDeliveredPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.queuedDelivered', payload.sessionPath);
  if (!sessionPath) {
    return;
  }
  deps.dispatchArch({
    kind: 'QueuedDelivered',
    sessionPath,
    text: payload.text,
    ...(payload.operationId ? { operationId: payload.operationId } : {}),
    localId: payload.localId,
  });
}

export function onRetryStarted(payload: RetryStartedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('retry.started', payload.sessionPath);
  if (!sessionPath) {
    return;
  }
  const hasTiming = payload.retryId && payload.startedAt !== undefined;
  deps.runObserver.onAutoRetry(sessionPath, hasTiming ? {
    sourceId: payload.retryId!,
    occurredAt: new Date(payload.startedAt!).toISOString(),
    attempt: payload.attempt,
    scheduledDelayMs: payload.delayMs,
  } : undefined);
  deps.dispatchArch({
    kind: 'RetryStarted',
    sessionPath,
    attempt: payload.attempt,
    maxAttempts: payload.maxAttempts,
    delayMs: payload.delayMs,
    errorMessage: payload.errorMessage,
  });
}

export function onRetryMeasured(payload: RetryMeasuredPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('retry.measured', payload.sessionPath);
  if (!sessionPath) return;
  deps.runObserver.onAutoRetryMeasured(
    sessionPath,
    payload.retryId,
    payload.measuredDelayMs,
    payload.durationMs,
  );
}

export function onRetryEnded(payload: RetryEndedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('retry.ended', payload.sessionPath);
  if (!sessionPath) {
    return;
  }
  deps.dispatchArch({
    kind: 'RetryEnded',
    sessionPath,
    success: payload.success,
    attempt: payload.attempt,
    finalError: payload.finalError,
  });
}

/** Count a history-compaction (`/compact`) LLM call against the relevant run.
 *  Compaction emits no `message_start`/`message_end`, so this backend event is
 *  the only signal that can drive the run-analytics counter. It also clears the
 *  host's "Compacting…" indicator and records chip metrics only for success. */
export function onCompaction(payload: CompactionPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('compaction.ended', payload.sessionPath);
  if (!sessionPath) {
    return;
  }
  deps.runObserver.onCompaction(sessionPath);
  deps.dispatchArch({
    kind: 'CompactionEnded',
    sessionPath,
    ...(payload.operationId ? {
      operationId: payload.operationId,
      operationAttempt: payload.operationAttempt,
    } : {}),
    ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    outcome: payload.outcome,
    occurredAt: payload.occurredAt ?? Date.now(),
    ...(payload.tokensBefore !== undefined ? { tokensBefore: payload.tokensBefore } : {}),
    ...(payload.estimatedTokensAfter !== undefined ? { estimatedTokensAfter: payload.estimatedTokensAfter } : {}),
  });
}

/** Surface a live "Compacting…" indicator when a history-compaction LLM call
 *  starts (the backend re-arms busy at the same time, but busy alone reads as a
 *  generic run). */
export function onCompactionStarted(payload: CompactionStartedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('compaction.started', payload.sessionPath);
  if (!sessionPath) {
    return;
  }
  deps.dispatchArch({
    kind: 'CompactionStarted',
    sessionPath,
    ...(payload.operationId ? {
      operationId: payload.operationId,
      operationAttempt: payload.operationAttempt,
    } : {}),
  });
}

export function onAuxiliaryLlmUsage(payload: AuxiliaryLlmUsagePayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('auxiliary-llm.usage', payload.sessionPath);
  if (!sessionPath) return;
  const { sessionPath: _sessionPath, ...sample } = payload;
  deps.runObserver.onAuxiliaryLlmUsage(sessionPath, sample);
}

/** Retry-stuck is already surfaced by the companion operational-error event. */
export function onRetryStuck(payload: RetryStuckPayload, deps: HandlerDeps): void {
  deps.requireEventSessionPath('retry.stuck', payload.sessionPath);
}
