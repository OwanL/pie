import * as crypto from 'node:crypto';

import { PROVIDER_TOGGLES_ENV, type CustomMessagePayload, type ErrorPayload, type MessageAbortedPayload, type PreflightFailedPayload, type RequestEnvelope } from '../shared/protocol';
import { createOperationalIncident } from '../shared/incidents.js';
import { enrichConnectionError, toErrorMessage } from '../shared/error-message';
import { LIVE_PIPELINE_LIMITS, LIVE_PIPELINE_PROTOCOL_VERSION } from '../shared/live-pipeline-protocol';
import {
  validateMessageSend,
  validateMessageOperation,
  validateMessageInterrupt,
  validateMessageReplaceQueue,
  validateOperationStatus,
  validateSessionPath,
} from './rpc';
import { ProviderGate } from './provider-gate';
import {
  canonicalCompactIntentFingerprint,
  canonicalContinueIntentFingerprint,
  canonicalSendIntentFingerprint,
  SendOperationLedger,
} from './send-operation-ledger';
import {
  canonicalInterruptIntentFingerprint,
  InterruptOperationLedger,
  type InterruptOperationResult,
} from './interrupt-operation-ledger';
import { resolveActiveModel } from './session-metadata';
import { buildPromptText, lowerImageInputs, normalizeThinkingLevel } from './message-inputs';
import { buildSessionCapabilities, hasBillableSessionActivity } from './session-activity';
import type { ActiveRequest, SessionContext } from './server-types';
import { BackendLiveTurnAccumulator } from './live-turn-accumulator';
import { BackendError } from './server-io';
import {
  type BackendRequestHandlerDeps,
  type RequestHandler,
  assertCurrentSessionMutationOwner,
  decidePromptSafetyTimerAction,
  formatInterruptWatchdogDuration,
  markRequestValidated,
  requireSessionTransition,
} from './request-handler-shared';

/**
 * Safety-net timeout for the pre-commit phase of `message.send`. The handler
 * acknowledges when the SDK queues the prompt, so a prompt that neither
 * reaches its first `message_start` nor rejects must be bounded here. Firing
 * aborts the session and emits `preflight.failed`, allowing the host to revert
 * its promoted optimistic send.
 *
 * The first correlated `message_start` clears this timer in
 * `session-event-handler.ts`. Clearing only when `session.prompt()` settled
 * would turn this into a whole-run ceiling and abort healthy multi-turn work.
 * Exact-request bounded provider-network activity or a provider-wide circuit
 * pause can defer one window, but cumulative wall time remains capped.
 */
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

/** Cumulative ceiling across exact-request provider-network deferrals. */
const PROMPT_TIMEOUT_HARD_CEILING_MS = 2 * PROMPT_TIMEOUT_MS;

const INTERRUPT_ABORT_WATCHDOG_ENV = 'PIE_INTERRUPT_ABORT_WATCHDOG_MS';
/**
 * Bounds an interrupt whose SDK abort promise never settles. On expiry the
 * current runtime is retired before replacement, preserving the invariant
 * that stale ownership cannot block a later send or model switch forever.
 */
const DEFAULT_INTERRUPT_ABORT_WATCHDOG_MS = 30 * 1000;
const DEFAULT_SESSION_TRANSITION_POLL_MS = 10;

function resolveInterruptAbortWatchdogMs(): number {
  const raw = process.env[INTERRUPT_ABORT_WATCHDOG_ENV];
  if (raw === undefined || raw === '') return DEFAULT_INTERRUPT_ABORT_WATCHDOG_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_INTERRUPT_ABORT_WATCHDOG_MS;
}

function clearActiveRequest(
  context: SessionContext,
  requestId: string,
  expected?: ActiveRequest,
): void {
  const active = context.activeRequest;
  if (!active || active.id !== requestId || (expected && active !== expected)) return;
  // Defensive: clear the pre-commit safety-net timer if it is still armed
  // (e.g. interrupt / preflight failure paths). The primary clear is the
  // commit-point clear in `session-event-handler.ts`.
  if (active.promptSafetyTimer) {
    clearTimeout(active.promptSafetyTimer);
    active.promptSafetyTimer = undefined;
  }
  if (active.semanticLeaseTimer) {
    clearTimeout(active.semanticLeaseTimer);
    active.semanticLeaseTimer = undefined;
  }
  if (active.quotaSettlementTimer) {
    clearTimeout(active.quotaSettlementTimer);
    active.quotaSettlementTimer = undefined;
  }
  active.pendingDurableToolTerminals?.clear();
  if (context.pendingExtensionCommand?.requestId === requestId) {
    context.pendingExtensionCommand = undefined;
  }
  context.activeRequest = undefined;
}

function reportPromptFailure(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  requestId: string,
  error: Error,
  expected?: ActiveRequest,
): void {
  const active = expected ?? context.activeRequest;
  // Enrich connection-level errors (bare "Connection error.") with the real
  // transport cause; clean 429/5xx with a body pass through unchanged so
  // the upstream reason (e.g. account_suspended) shows.
  const message = enrichConnectionError(error);
  deps.emit('error', {
    ...createOperationalIncident({
      code: 'MESSAGE_SEND_FAILED',
      message,
      detail: toErrorMessage(error),
      sessionPath: context.sessionPath,
      requestId,
      ...(active?.operationId ? { operationId: active.operationId } : {}),
      ...(active?.liveTurnAccumulator ? { turnId: active.liveTurnAccumulator.turnId } : {}),
      ...(active?.currentMessageId ?? active?.lastAssistantMessageId
        ? { messageId: active.currentMessageId ?? active.lastAssistantMessageId }
        : {}),
      severity: 'error',
      certainty: 'definitive',
      phase: 'provider',
      dedupeKey: active?.latestProviderIncidentDedupeKey ?? `request:${requestId}`,
      recovery: { showLogs: true },
    }),
  } satisfies ErrorPayload);
  clearActiveRequest(context, requestId, expected);
  deps.emitBusyChanged(context, hasBillableSessionActivity(context));
}

/**
 * Post-ack, pre-commit prepass failure: `message.send` has already early-acked
 * (the prompt was queued) but the pruning prepass then failed. Surface it via
 * the dedicated `preflight.failed` backend event so the host dispatches
 * `PreflightFailed` and reverts via `pending.promoted[corrId]` (resolved by
 * `requestId`). Clearing `activeRequest` matches the pre-early-ack failure
 * path: the turn is not proceeding to streaming, so a subsequent send must not
 * be blocked by `REQUEST_IN_PROGRESS`. The host clears its optimistic running
 * state in the `PreflightFailed` reducer handler. See `docs/STATE_CONTRACT.md`
 * § Optimistic Reconciliation "Two failure windows for send".
 */
function emitPreflightFailed(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  requestId: string,
  message: string,
  expected?: ActiveRequest,
  sessionPath = context.sessionPath,
): void {
  const operationId = expected?.operationId ?? context.activeRequest?.operationId;
  const operationAttempt = expected?.operationAttempt ?? context.activeRequest?.operationAttempt;
  context.sendOperationLedger?.markFailed(operationId, 'MESSAGE_SEND_PRECOMMIT_FAILED', message);
  deps.emit('preflight.failed', {
    requestId,
    ...(operationId ? { operationId } : {}),
    ...(operationAttempt !== undefined ? { operationAttempt } : {}),
    sessionPath,
    error: message,
  } satisfies PreflightFailedPayload);
  clearActiveRequest(context, requestId, expected);
  deps.emitBusyChanged(context, hasBillableSessionActivity(context));
}

class PromptCancelledBeforeStartError extends Error {
  constructor() {
    super('Prompt cancelled before the agent run started.');
    this.name = 'PromptCancelledBeforeStartError';
  }
}

/** Provider preferences are an execution boundary, not only a picker filter.
 * Existing sessions can retain a model after its provider is disabled, so the
 * backend must reject both ordinary sends and queued steering attempts rather
 * than silently spending against a provider the user turned off. Malformed or
 * absent preference state fails open so startup cannot strand every session. */
function isProviderExplicitlyDisabled(provider: string | undefined): boolean {
  if (!provider) return false;
  const serialized = process.env[PROVIDER_TOGGLES_ENV];
  if (!serialized) return false;
  try {
    const parsed: unknown = JSON.parse(serialized);
    return typeof parsed === 'object'
      && parsed !== null
      && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>)[provider] === false;
  } catch {
    return false;
  }
}

async function handleMessageSend(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageSend(request.params);
  markRequestValidated(deps);
  // An existing-hot lookup can resolve just before truncate/recovery reserves
  // the path. Rejoin that synchronously visible owner before claiming active
  // work; after this check activeRequest is installed without another await,
  // so a later truncate observes STREAMING_BUSY instead of replacing us.
  const context = await requireSessionTransition(deps, params.sessionPath);
  assertCurrentSessionMutationOwner(deps, params.sessionPath, context);
  if (params.operationId) {
    const operationId = params.operationId;
    const operationAttempt = params.operationAttempt;
    const ledger = context.sendOperationLedger ??= new SendOperationLedger();
    const advanceAttemptOwnership = (): void => {
      if (operationAttempt === undefined) return;
      const active = context.activeRequest;
      if (active?.operationId === operationId
        && operationAttempt > (active.operationAttempt ?? 0)) {
        active.operationAttempt = operationAttempt;
      }
      const queuedIndex = context.queuedOperationIds?.lastIndexOf(operationId) ?? -1;
      if (queuedIndex >= 0) {
        const attempts = context.queuedOperationAttempts ??= [];
        attempts[queuedIndex] = Math.max(attempts[queuedIndex] ?? 0, operationAttempt);
      }
    };
    const resultPromise = ledger.run(
      operationId,
      canonicalSendIntentFingerprint(params),
      async () => ({
        ...await executeMessageSend(deps, context, params),
        operationId,
      }),
    );
    // A replay can race the SDK's terminal event. Advance the existing owner
    // synchronously after the ledger validates immutable intent, then repeat
    // after first-attempt execution has had a chance to install its owner.
    advanceAttemptOwnership();
    const result = await resultPromise;
    advanceAttemptOwnership();
    return {
      ...result,
      ...(operationAttempt !== undefined ? { operationAttempt } : {}),
    };
  }
  return await executeMessageSend(deps, context, params);
}

async function executeMessageSend(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  params: ReturnType<typeof validateMessageSend>,
): Promise<{ operationId?: string; operationAttempt?: number; requestId?: string; queued?: boolean }> {
  if (isProviderExplicitlyDisabled(context.session.model?.provider)) {
    throw new BackendError(
      'PROVIDER_DISABLED',
      'PROVIDER_DISABLED: The selected model provider is disabled in Pie settings. Select a model from an enabled provider before sending.',
    );
  }
  const billableActivity = hasBillableSessionActivity(context);
  const conversationActivity = context.activeRequest !== undefined || context.session.isStreaming;
  if (billableActivity && !conversationActivity) {
    throw new BackendError('REQUEST_IN_PROGRESS', 'Cannot send while session maintenance or shell activity is running.');
  }

  // Steering: if a turn is already running, inject this message into the
  // current turn via the SDK's `steer()` (delivered after in-flight tool calls
  // finish, before the next LLM call). During the preflight window an
  // `activeRequest` exists but PI is not streaming yet; steering then would be
  // drained before the *first* LLM call, collapsing two user prompts into one
  // assistant turn. Queue those early arrivals with `followUp()` so the first
  // request receives its own answer before the follow-up starts. No
  // `activeRequest` is created here (this call starts no turn) and no
  // pre-commit safety-net timer is armed (steering has no pruning prepass). We
  // `await` the call so a queuing failure (e.g. the text is an extension
  // command, or a skill/template expansion error) rejects the RPC — the host
  // then reverts its optimistic 'queued' message via the pre-ack
  // `SendResult{ok:false}` path, exactly like a normal send pre-ack failure.
  // The SDK emits `message_start` (role 'user') when the loop injects the
  // queued message; the backend forwards that as `message.queuedDelivered` so
  // the host promotes the message from 'queued' to 'completed'.
  if (conversationActivity) {
    if ((context.queuedLocalIds?.length ?? 0) >= LIVE_PIPELINE_LIMITS.queuedMessageCorrelations) {
      throw new BackendError('QUEUE_CAPACITY_EXCEEDED', 'Too many queued follow-up messages. Wait for delivery or clear the queue before sending more.');
    }
    const queuedImages = lowerImageInputs(params.inputs);
    const queuedImagePayload = queuedImages.length > 0 ? queuedImages : undefined;
    const queuedPromptText = buildPromptText(params.text, params.inputs);
    // Register before entering the SDK: steer/followUp may synchronously emit
    // the delivery message_start before its promise settles.
    const deliveryLocalId = params.localId ?? '';
    const queuedLocalIds = context.queuedLocalIds ??= [];
    const queuedOperationIds = context.queuedOperationIds ??= [];
    const queuedOperationAttempts = context.queuedOperationAttempts ??= [];
    queuedLocalIds.push(deliveryLocalId);
    queuedOperationIds.push(params.operationId ?? '');
    queuedOperationAttempts.push(params.operationAttempt);
    try {
      if (context.activeRequest && !context.session.isStreaming) {
        await context.session.followUp(queuedPromptText, queuedImagePayload);
      } else if (context.session.steer) {
        await context.session.steer(queuedPromptText, queuedImagePayload);
      } else {
        await context.session.followUp(queuedPromptText, queuedImagePayload);
      }
    } catch (error) {
      // Remove only our still-pending slot. If synchronous delivery already
      // consumed it, there is no stale correlation to remove.
      const index = queuedLocalIds.indexOf(deliveryLocalId);
      if (index >= 0) {
        queuedLocalIds.splice(index, 1);
        queuedOperationIds.splice(index, 1);
        queuedOperationAttempts.splice(index, 1);
      }
      throw error;
    }
    return {
      ...(params.operationId ? { operationId: params.operationId } : {}),
      ...(params.operationAttempt !== undefined ? { operationAttempt: params.operationAttempt } : {}),
      queued: true,
    };
  }

  const requestId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const attemptId = crypto.randomUUID();
  const canonicalMessageId = `${requestId}:1`;
  const modelId = context.session.model?.id;
  const provider = context.session.model?.provider;
  const thinkingLevel = normalizeThinkingLevel(context.session.thinkingLevel);
  context.activeRequest = {
    id: requestId,
    ...(params.operationId ? { operationId: params.operationId } : {}),
    ...(params.operationAttempt !== undefined ? { operationAttempt: params.operationAttempt } : {}),
    messageIndex: 0,
    liveTurnAccumulator: new BackendLiveTurnAccumulator({
      protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
      sessionPath: context.sessionPath,
      requestId,
      ...(params.operationId ? { operationId: params.operationId } : {}),
      turnId,
      attemptId,
      canonicalMessageId,
      modelId,
      provider,
      thinkingLevel,
      startedAt: Date.now(),
    }),
    modelId,
    provider,
    thinkingLevel,
    extensionCommand: params.text.startsWith('/'),
    // The first turn has no preceding tool call, so its latency window opens at
    // prompt-send. Subsequent turns overwrite this on `tool_execution_end`.
    turnBoundaryAt: Date.now(),
    aborted: false,
  };

  const images = lowerImageInputs(params.inputs);
  const imagePayload = images.length > 0 ? images : undefined;
  const promptText = buildPromptText(params.text, params.inputs);
  const isExtensionCommand = params.text.startsWith('/');
  // `WorkerRuntimeHost.bindSession` reuses the context object when an extension
  // command replaces the SDK session. Capture every part of the ownership
  // identity before invoking the SDK: a late preflight/final callback must not
  // publish into the replacement (or clear its request).
  const ownedRequest = context.activeRequest!;
  const ownedSession = context.session;
  const ownedSessionPath = context.sessionPath;
  const ownedSessionOwnershipEpoch = context.sessionOwnershipEpoch ?? 0;
  const ownsRequest = (): boolean => (
    !context.retired
    && context.activeRequest === ownedRequest
    && context.session === ownedSession
    && context.sessionPath === ownedSessionPath
    && (context.sessionOwnershipEpoch ?? 0) === ownedSessionOwnershipEpoch
  );
  if (isExtensionCommand) {
    context.pendingExtensionCommand = {
      requestId,
      session: ownedSession,
      sessionPath: ownedSessionPath,
      sessionOwnershipEpoch: ownedSessionOwnershipEpoch,
    };
  }

  // Early ack: resolve {requestId} as soon as the prompt is QUEUED (before the
  // pruning prepass), so a slow prepass can no longer time out `message.send`.
  // The prepass runs concurrently inside `session.prompt()`; its outcome is
  // surfaced post-ack via the `preflightResult` callback:
  //  - success → the turn proceeds to streaming (commit point = first
  //    `MessageStarted` for the requestId, handled host-side).
  //  - failure → emit `preflight.failed` so the host dispatches `PreflightFailed`
  //    and reverts via `pending.promoted` (STATE_CONTRACT § Optimistic
  //    Reconciliation "Two failure windows for send").
  // `preflightFailed` makes the failure emission one-shot so `preflightResult`,
  // the `PROMPT_TIMEOUT_MS` safety net, and a concurrent `session.prompt()`
  // rejection cannot both emit.
  let preflightFailed = false;

  // Backend safety net (see PROMPT_TIMEOUT_MS): bound the fire-and-forget
  // prompt promise so a hung SDK call cannot pin `activeRequest` forever. It
  // is cleared at the commit point (first `message_start`) — see
  // `session-event-handler.ts` — and defensively on settle via `.finally`
  // below, so it never fires for a healthy turn. The `activeRequest` identity
  // check guards the edge case where this request was already superseded (turn
  // completed or a new send started) but the old promise has not yet settled —
  // it must not abort an unrelated turn. The handle is stashed on
  // `activeRequest.promptSafetyTimer` so `session-event-handler.ts` can clear
  // it at the commit point; clearing only on `.finally` would make this a
  // whole-run ceiling that aborts healthy multi-turn runs mid-stream.
  //
  // EXACT-REQUEST DEFERRAL: worker transport observations mark only this
  // active request while it is queued or waiting for bounded provider I/O.
  // Coordinator metrics additionally expose a provider-wide circuit pause.
  // Either can defer below the hard ceiling; unrelated provider activity
  // cannot. `firstArmedAt` anchors the cumulative ceiling.
  const firstArmedAt = Date.now();
  // Resolve optional provider-wide circuit metrics. Isolated workers normally
  // rely on their exact local transport correlation; standalone/legacy paths
  // can still supply the in-process ProviderGate metrics.
  const getProviderGateMetrics = deps.getProviderGateMetrics
    ?? (() => ProviderGate.getInstance()?.getMetrics());
  const resolveSessionProvider = deps.resolveSessionProvider
    ?? ((ctx) => resolveActiveModel(ctx).provider);
  const onPromptSafetyTimerFire = () => {
    if (!ownsRequest()) return;
    if (preflightFailed) return;

    const elapsed = Date.now() - firstArmedAt;
    const provider = resolveSessionProvider(context);
    const metrics = getProviderGateMetrics();
    const decision = decidePromptSafetyTimerAction({
      elapsed,
      ceiling: PROMPT_TIMEOUT_HARD_CEILING_MS,
      promptTimeoutMs: PROMPT_TIMEOUT_MS,
      provider,
      metrics,
      requestProviderPending: ownedRequest.providerNetworkPending === true,
    });

    if (decision.action === 'defer') {
      // DEFER: re-arm for another window. `preflightFailed` is intentionally
      // NOT set here — the one-shot guard is set ONLY in the FIRE branch
      // below, so a deferred re-arm can still be superseded by a real
      // preflight failure from `preflightResult(false)` / `.catch`. The re-
      // armed handle replaces `promptSafetyTimer` so the commit-point clear in
      // `session-event-handler.ts` (and `clearActiveRequest`) clears the LIVE
      // handle, not the already-fired original.
      const remaining = Math.max(1, PROMPT_TIMEOUT_HARD_CEILING_MS - elapsed);
      ownedRequest.promptSafetyTimer = setTimeout(onPromptSafetyTimerFire, Math.min(PROMPT_TIMEOUT_MS, remaining));
      return;
    }

    // FIRE: genuinely stuck, ceiling exceeded, or fail-open. The
    // `preflightFailed` one-shot is set ONLY here.
    preflightFailed = true;
    void context.session.abort().catch(() => {
      // Best-effort abort; the failure is surfaced via `preflight.failed` below.
    });
    emitPreflightFailed(deps, context, requestId, decision.reason, ownedRequest, ownedSessionPath);
  };
  const promptTimer = setTimeout(onPromptSafetyTimerFire, PROMPT_TIMEOUT_MS);
  context.activeRequest.promptSafetyTimer = promptTimer;

  try {
    context.session
      .prompt(promptText, {
        source: 'rpc',
        images: imagePayload,
        preflightResult: (success) => {
          // `session.abort()` can settle while before_agent_start extensions
          // (notably the pruning prepass) are still running. The pinned SDK
          // invokes this callback synchronously immediately before entering
          // `_runAgentPrompt`; returning normally would therefore resurrect a
          // request that Stop already terminalized and start a billable model
          // call. Throwing here rejects `session.prompt()` before that boundary.
          // The private sentinel is swallowed by the promise handler below so
          // this user-requested cancellation cannot surface as a prompt error.
          if (success && ownedRequest.aborted) {
            throw new PromptCancelledBeforeStartError();
          }
          if (!ownsRequest()) return;
          if (preflightFailed) return;
          if (success) {
            // Explicit phase boundary for the host watchdog. This internal
            // custom event is not inserted into the visible transcript; the
            // durable pruning-result entry independently supplies the UI summary.
            deps.emit('message.custom', {
              requestId,
              ...(ownedRequest.operationId ? { operationId: ownedRequest.operationId } : {}),
              sessionPath: ownedSessionPath,
              message: {
                id: `${requestId}:preflight-succeeded`,
                role: 'system',
                createdAt: new Date().toISOString(),
                markdown: '',
                status: 'completed',
                customType: 'preflight-succeeded',
              },
            } satisfies CustomMessagePayload);
            // Prepass succeeded: the turn is proceeding to streaming.
            // `emitBusyChanged(true)` is idempotent (the host set running
            // optimistically at Send time; `agent_start` will also fire it) —
            // kept for parity with the pre-early-ack path.
            deps.emitBusyChanged(context, hasBillableSessionActivity(context));
          } else {
            preflightFailed = true;
            emitPreflightFailed(
              deps,
              context,
              requestId,
              'Prompt rejected before PI accepted the request.',
              ownedRequest,
              ownedSessionPath,
            );
          }
        },
      })
      .catch((error: Error) => {
        if (error instanceof PromptCancelledBeforeStartError) return;
        // `session.prompt()` rejected. With early ack the RPC has already
        // resolved, so this is a post-ack failure. If streaming already started
        // (commit point reached) it is an in-turn error → legacy `error` emit
        // (no rollback, matching the post-commit contract). Otherwise it is a
        // pre-commit failure → emit `preflight.failed` so the host reverts via
        // `pending.promoted`. `preflightFailed` guards a double emit when
        // `preflightResult(false)` already settled.
        if (!ownsRequest() || preflightFailed) return;
        if (ownedRequest.messageIndex > 0 || ownedRequest.lastAssistantMessageId || ownedRequest.currentMessageId) {
          reportPromptFailure(deps, context, requestId, error, ownedRequest);
          return;
        }
        preflightFailed = true;
        emitPreflightFailed(
          deps,
          context,
          requestId,
          enrichConnectionError(error) || 'Prompt failed before streaming started.',
          ownedRequest,
          ownedSessionPath,
        );
      })
      .finally(() => {
        // Defensive clear: the commit-point clear in `session-event-handler.ts`
        // is the primary clear (so a healthy long run is never aborted); this
        // covers the settle-without-commit case (reject) and any race where the
        // commit-point clear was skipped.
        clearTimeout(promptTimer);
        if (ownsRequest()) {
          if (ownedRequest.promptSafetyTimer) clearTimeout(ownedRequest.promptSafetyTimer);
          ownedRequest.promptSafetyTimer = undefined;
        }
        // Extension commands are allowed to complete without an agent run.
        // They still received the early message.send ack, so close the exact
        // request here rather than leaving the host/backend busy forever. A
        // real agent turn has crossed message_start (messageIndex/lastAssistantMessageId)
        // and is left to the normal SDK event lifecycle.
        if (isExtensionCommand && ownsRequest()
          && ownedRequest.messageIndex === 0
          && !ownedRequest.lastAssistantMessageId
          && !ownedRequest.currentMessageId) {
          preflightFailed = true;
          emitPreflightFailed(
            deps,
            context,
            requestId,
            'Extension command completed without starting an agent turn.',
            ownedRequest,
            ownedSessionPath,
          );
        }
      });
  } catch (syncError) {
    // `session.prompt` threw synchronously before returning a promise — treat
    // as a pre-ack failure: clear activeRequest and let the RPC reject so the
    // host dispatches `SendResult{ok:false}` and reverts via `pending.ops`.
    clearTimeout(promptTimer);
    if (ownsRequest() && ownedRequest.promptSafetyTimer === promptTimer) {
      ownedRequest.promptSafetyTimer = undefined;
    }
    clearActiveRequest(context, requestId, ownedRequest);
    throw syncError;
  }

  return {
    ...(params.operationId ? { operationId: params.operationId } : {}),
    ...(params.operationAttempt !== undefined ? { operationAttempt: params.operationAttempt } : {}),
    requestId,
  };
}

async function handleOperationStatus(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateOperationStatus(request.params);
  markRequestValidated(deps);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context || context.retired) {
    throw new BackendError('SESSION_GENERATION_ENDED', 'The session mutation generation is no longer available.');
  }
  if (params.backendGeneration !== undefined && deps.backendGeneration !== undefined
    && params.backendGeneration !== deps.backendGeneration) {
    throw new BackendError('SESSION_GENERATION_ENDED', 'The session mutation generation is no longer available.');
  }
  const status = context.interruptOperationLedger?.status(params.operationId)
    ?? context.sendOperationLedger?.status(params.operationId);
  return status ?? { operationId: params.operationId, state: 'pending' };
}

async function handleMessageContinue(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageOperation('message.continue', request.params);
  markRequestValidated(deps);
  const context = await requireSessionTransition(deps, params.sessionPath);
  assertCurrentSessionMutationOwner(deps, params.sessionPath, context);
  if (params.operationId) {
    const ledger = context.sendOperationLedger ??= new SendOperationLedger();
    return await ledger.run(
      params.operationId,
      canonicalContinueIntentFingerprint(params),
      async () => ({
        ...executeMessageContinue(deps, context, params),
        operationId: params.operationId!,
      }),
    );
  }
  return executeMessageContinue(deps, context, params);
}

function executeMessageContinue(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  params: ReturnType<typeof validateMessageOperation>,
): { operationId?: string; requestId: string } {
  if (hasBillableSessionActivity(context)) {
    throw new BackendError('REQUEST_IN_PROGRESS', 'Cannot continue while this session has billable activity.');
  }
  if (isProviderExplicitlyDisabled(context.session.model?.provider)) {
    throw new BackendError(
      'PROVIDER_DISABLED',
      'PROVIDER_DISABLED: The selected model provider is disabled in Pie settings. Select a model from an enabled provider before continuing.',
    );
  }
  if (typeof context.session.continueAfterInterruption !== 'function') {
    throw new BackendError('SDK_INCOMPATIBLE', 'The active PI runtime does not support interrupted-turn continuation.');
  }
  if (!buildSessionCapabilities(context).canContinue) {
    throw new BackendError(
      'CONTINUATION_NOT_AVAILABLE',
      'The session does not end at an interrupted continuation point.',
    );
  }

  const requestId = crypto.randomUUID();
  const operationId = params.operationId;
  const operationAttempt = params.operationAttempt;
  const ownedRequest: ActiveRequest = {
    id: requestId,
    ...(operationId ? { operationId, operationAttempt } : {}),
    messageIndex: 0,
    liveTurnAccumulator: new BackendLiveTurnAccumulator({
      protocolVersion: LIVE_PIPELINE_PROTOCOL_VERSION,
      sessionPath: context.sessionPath,
      requestId,
      ...(operationId ? { operationId } : {}),
      turnId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      canonicalMessageId: `${requestId}:1`,
      modelId: context.session.model?.id,
      provider: context.session.model?.provider,
      thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
      startedAt: Date.now(),
    }),
    modelId: context.session.model?.id,
    provider: context.session.model?.provider,
    thinkingLevel: normalizeThinkingLevel(context.session.thinkingLevel),
    extensionCommand: false,
    turnBoundaryAt: Date.now(),
    aborted: false,
  };
  context.activeRequest = ownedRequest;
  const ownedSession = context.session;
  const ownedSessionPath = context.sessionPath;
  const ownedSessionOwnershipEpoch = context.sessionOwnershipEpoch ?? 0;
  const ownsRequest = (): boolean => (
    !context.retired
    && context.activeRequest === ownedRequest
    && context.session === ownedSession
    && context.sessionPath === ownedSessionPath
    && (context.sessionOwnershipEpoch ?? 0) === ownedSessionOwnershipEpoch
  );

  const hasMatchingAssistantTurn = (): boolean => ownedRequest.messageIndex > 0
    || !!ownedRequest.currentMessageId
    || !!ownedRequest.lastAssistantMessageId;
  const emitTerminalWithoutAssistant = (
    outcome?: MessageAbortedPayload['outcome'],
    reason?: string,
  ): void => {
    if (ownedRequest.terminalWithoutMessageEmitted) return;
    ownedRequest.terminalWithoutMessageEmitted = true;
    if (outcome) {
      context.sendOperationLedger?.markFailed(
        operationId,
        outcome === 'cancelled' ? 'MESSAGE_CONTINUE_CANCELLED'
          : outcome === 'superseded' ? 'MESSAGE_CONTINUE_SUPERSEDED' : 'MESSAGE_CONTINUE_FAILED',
        reason ?? `Continuation ${outcome} before it started.`,
        outcome,
      );
    }
    const failureIncidentId = outcome === 'failed'
      ? `continuation-prestart:${operationId ?? requestId}`
      : undefined;
    if (failureIncidentId) {
      deps.emit('operational-error', createOperationalIncident({
        incidentId: failureIncidentId,
        dedupeKey: operationId ? `operation:${operationId}` : `request:${requestId}`,
        sessionPath: ownedSessionPath,
        ...(operationId ? { operationId } : {}),
        requestId,
        turnId: ownedRequest.liveTurnAccumulator!.turnId,
        severity: 'error',
        certainty: 'definitive',
        phase: 'preflight',
        code: 'MESSAGE_CONTINUE_FAILED',
        message: 'Could not continue the interrupted response.',
        detail: reason ?? 'Continuation failed before the assistant row was created.',
        recovery: { showLogs: true },
      }));
    }
    deps.emit('message.aborted', {
      requestId,
      ...(operationId ? { operationId, operationAttempt } : {}),
      sessionPath: ownedSessionPath,
      ...(outcome ? { outcome } : {}),
      ...(failureIncidentId ? { incidentId: failureIncidentId } : {}),
      ...(outcome === 'cancelled' ? { userInitiated: true } : {}),
      ...(reason ? { reason } : {}),
    } satisfies MessageAbortedPayload);
  };
  const settleContinuationFailure = (error: Error): void => {
    if (!ownsRequest()) {
      emitTerminalWithoutAssistant(ownedRequest.aborted ? 'cancelled' : 'superseded');
      return;
    }
    if (hasMatchingAssistantTurn()) {
      reportPromptFailure(deps, context, requestId, error, ownedRequest);
      return;
    }
    // A zero-prompt continuation can reject before Pi emits message_start.
    // Settle without a messageId so an older interrupted assistant is never
    // relabelled as this attempt's failure.
    emitTerminalWithoutAssistant('failed', enrichConnectionError(error));
    clearActiveRequest(context, requestId, ownedRequest);
    deps.emitBusyChanged(context, hasBillableSessionActivity(context));
  };

  // Acknowledgement precedes SDK start. An interrupt or ownership replacement
  // in this gap receives one typed terminal observation and cannot enter Pi.
  setImmediate(() => {
    if (!ownsRequest() || ownedRequest.aborted) {
      emitTerminalWithoutAssistant(ownedRequest.aborted ? 'cancelled' : 'superseded');
      return;
    }
    try {
      void context.session.continueAfterInterruption!()
        .catch((error: Error) => settleContinuationFailure(error));
    } catch (error) {
      settleContinuationFailure(error instanceof Error ? error : new Error(toErrorMessage(error)));
    }
  });

  return { ...(operationId ? { operationId } : {}), requestId };
}

async function handleMessageCompact(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageOperation('message.compact', request.params);
  markRequestValidated(deps);
  const context = await requireSessionTransition(deps, params.sessionPath);
  assertCurrentSessionMutationOwner(deps, params.sessionPath, context);
  if (params.operationId) {
    const ledger = context.sendOperationLedger ??= new SendOperationLedger();
    return await ledger.run(
      params.operationId,
      canonicalCompactIntentFingerprint({ sessionPath: params.sessionPath, reason: 'manual' }),
      async () => ({
        ...await executeMessageCompact(context, request.id, params.operationId, params.operationAttempt),
        operationId: params.operationId!,
      }),
    );
  }
  return await executeMessageCompact(context, request.id);
}

async function executeMessageCompact(
  context: SessionContext,
  requestId: string,
  operationId?: string,
  operationAttempt?: number,
): Promise<{ compacted: true; requestId?: string; operationId?: string }> {
  if (hasBillableSessionActivity(context)) {
    throw new BackendError('REQUEST_IN_PROGRESS', 'Cannot compact while this session is running.');
  }
  const compactionRequest = {
    requestId,
    ...(operationId ? { operationId, operationAttempt } : {}),
    cancelled: false,
  };
  context.manualCompactionRequest = compactionRequest;
  try {
    await context.session.compact();
    return operationId ? { compacted: true, requestId, operationId } : { compacted: true };
  } finally {
    if (context.manualCompactionRequest === compactionRequest) {
      context.manualCompactionRequest = undefined;
    }
  }
}

async function handleMessageInterrupt(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageInterrupt(request.params);
  markRequestValidated(deps);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) {
    throw new BackendError('SESSION_NOT_FOUND', `Cannot interrupt an unopened session: ${params.sessionPath}`);
  }
  if (params.operationId) {
    const ledger = context.interruptOperationLedger ??= new InterruptOperationLedger();
    const result = await ledger.run(
      params.operationId,
      canonicalInterruptIntentFingerprint(params.sessionPath),
      async () => await executeMessageInterrupt(deps, request, params, context),
    );
    return { ...result, operationId: params.operationId, operationAttempt: params.operationAttempt };
  }
  return await executeMessageInterrupt(deps, request, params, context);
}

async function executeMessageInterrupt(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
  params: ReturnType<typeof validateMessageInterrupt>,
  context: SessionContext,
): Promise<InterruptOperationResult> {
  if (context.retired || context.recoveryPromise) {
    return { interrupted: false, alreadyStopped: true, recoveryPending: true };
  }
  if (!hasBillableSessionActivity(context)) {
    // Stop is idempotent. The host can be a few events ahead/behind the SDK at
    // turn boundaries; treating that race as an error wedges the optimistic
    // "Stopping…" state and makes rapid stop→send unnecessarily fragile.
    context.session.clearQueue();
    emitQueuedSendCancellations(deps, context, 'The queued message was cancelled by Stop before delivery.');
    context.queuedLocalIds = [];
    context.queuedOperationIds = [];
    context.queuedOperationAttempts = [];
    return { interrupted: false, alreadyStopped: true };
  }
  if (context.manualCompactionRequest) {
    context.manualCompactionRequest.cancelled = true;
  }
  if (context.activeRequest) {
    context.activeRequest.aborted = true;
    const accumulator = context.activeRequest.liveTurnAccumulator;
    if (accumulator) {
      deps.emit('live.semantic', accumulator.observe({
        kind: 'turn.phase', phase: 'aborting', inactivityBudgetMs: resolveInterruptAbortWatchdogMs(),
      }, Date.now()));
    }
  }
  const abortRequest = context.activeRequest;
  const abortRequestId = abortRequest?.id;
  context.uiBridge?.cancelAll();
  // Clear any queued follow-up messages so a Stop cancels pending queued
  // messages too. The SDK `abort()` preserves the followUp queue; without this
  // a queued message would be drained by the next `prompt()` and run as part
  // of an unrelated future send. The host also removes 'queued' transcript
  // messages on `InterruptResult{ok:true}` to stay in sync.
  context.session.clearQueue();
  emitQueuedSendCancellations(deps, context, 'The queued message was cancelled by Stop before delivery.');
  // the SDK queue is gone; drop the localId correlation queue so
  // we don't try to match stale ids if the backend emits a late user-role
  // message_start before the host finishes reconciling the interrupt.
  context.queuedLocalIds = [];
  context.queuedOperationIds = [];
  context.queuedOperationAttempts = [];
  // Hard-stop every billable window the SDK exposes BEFORE the un-awaited
  // `session.abort()` runs. `abort()` alone does NOT stop the post-agent_end
  // compaction / branch-summary / retry / bash LLM calls, so spend would keep
  // accumulating until abort() settles (and if it never settles, forever).
  // Each is a no-op when its window isn't running; optional-chained so an
  // older SDK that doesn't expose them is unaffected.
  context.session.abortCompaction?.();
  context.session.abortBranchSummary?.();
  context.session.abortBash?.();
  context.session.abortRetry?.();
  // The RPC acknowledgement is a completion barrier, not merely an "abort was
  // requested" acknowledgement. The host serializes stop→send/edit operations
  // behind this request; returning before abort settles allowed the next send
  // to enter the dying turn as a queued follow-up and then disappear.
  const reconcileOwnedIdleRequest = () => {
    // turn_end normally clears this. Defensively reconcile providers that
    // settle abort without emitting turn_end, but only after every other
    // billable window is already closed.
    if (context.activeRequest?.id !== abortRequestId
      || hasBillableSessionActivity({ ...context, activeRequest: undefined })) return;
    const preCommit = abortRequest?.messageIndex === 0
      && !abortRequest.lastAssistantMessageId
      && !abortRequest.currentMessageId
      && abortRequest.semanticStarted !== true;
    if (preCommit && abortRequest?.operationId) {
      context.sendOperationLedger?.markFailed(
        abortRequest.operationId,
        'MESSAGE_OPERATION_CANCELLED',
        'The message operation was cancelled by Stop before it started.',
        'cancelled',
      );
      abortRequest.terminalWithoutMessageEmitted = true;
      deps.emit('message.aborted', {
        requestId: abortRequest.id,
        operationId: abortRequest.operationId,
        ...(abortRequest.operationAttempt !== undefined ? { operationAttempt: abortRequest.operationAttempt } : {}),
        sessionPath: params.sessionPath,
        outcome: 'cancelled',
        userInitiated: true,
        reason: 'The send was cancelled by Stop before it started.',
      } satisfies MessageAbortedPayload);
    } else if (abortRequest?.semanticStarted === true) {
      deps.emit('message.aborted', {
        requestId: abortRequest.id,
        ...(abortRequest.operationId ? { operationId: abortRequest.operationId } : {}),
        ...(abortRequest.operationAttempt !== undefined ? { operationAttempt: abortRequest.operationAttempt } : {}),
        sessionPath: params.sessionPath,
        messageId: abortRequest.lastAssistantMessageId
          ?? abortRequest.currentMessageId
          ?? abortRequest.liveTurnAccumulator?.checkpoint().turn.canonicalMessageId
          ?? `${abortRequest.id}:1`,
        userInitiated: true,
      } satisfies MessageAbortedPayload);
    }
    context.activeRequest = undefined;
    deps.emitBusyChanged(context, hasBillableSessionActivity(context));
  };

  const watchdogMs = resolveInterruptAbortWatchdogMs();
  const deadlineAt = Date.now() + watchdogMs;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    watchdogTimer = setTimeout(() => resolve('timeout'), watchdogMs);
  });
  const abort = context.session.abort().then(
    () => 'settled' as const,
    (error: unknown) => ({ error: toErrorMessage(error) } as const),
  );
  let outcome = await Promise.race([abort, timeout]);
  if (outcome === 'settled') {
    reconcileOwnedIdleRequest();
    // abort() resolution is not settlement. Recheck the complete classifier
    // through the remainder of the same cooperative grace so retry, compaction,
    // bash, queued work, or a still-streaming provider cannot escape Stop.
    while (hasBillableSessionActivity(context)) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        outcome = 'timeout';
        break;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(DEFAULT_SESSION_TRANSITION_POLL_MS, remaining));
        timer.unref?.();
      });
      reconcileOwnedIdleRequest();
    }
  }
  if (watchdogTimer) clearTimeout(watchdogTimer);

  // Another watchdog may have retired this runtime while abort() was pending.
  // Recovery ownership is single-writer: never replace the replacement that
  // semantic recovery has already started for this context.
  if (context.retired || context.recoveryPromise) {
    return { interrupted: false, alreadyStopped: true, recoveryPending: true };
  }

  if (outcome === 'timeout') {
    const watchdogLabel = formatInterruptWatchdogDuration(watchdogMs);
    const message = `Stop did not settle within ${watchdogLabel}, so Pie ended the turn locally and is refreshing the session runtime.`;
    const active = context.activeRequest;
    context.retired = true;
    context.sessionManagerFence?.invalidate();
    context.uiBridge?.dispose();
    if (active?.semanticLeaseTimer) clearTimeout(active.semanticLeaseTimer);
    active?.pendingDurableToolTerminals?.clear();
    if (active?.liveTurnAccumulator) {
      context.terminalLiveTurn = { accumulator: active.liveTurnAccumulator, expiresAt: Date.now() + 10_000 };
    }
    context.activeRequest = undefined;
    deps.emit('operational-error', createOperationalIncident({
      incidentId: `interrupt-stuck:${abortRequestId ?? request.id}`,
      dedupeKey: `interrupt-stuck:${params.sessionPath}:${abortRequestId ?? request.id}`,
      code: 'INTERRUPT_ABORT_STUCK',
      message,
      detail: `session.abort() did not settle within ${watchdogLabel}. The stalled session runtime was retired before replacement.`,
      sessionPath: params.sessionPath,
      ...(abortRequestId ? { requestId: abortRequestId } : {}),
      ...(active?.operationId ? { operationId: active.operationId } : {}),
      ...(active?.liveTurnAccumulator ? { turnId: active.liveTurnAccumulator.turnId } : {}),
      ...(active?.currentMessageId ?? active?.lastAssistantMessageId
        ? { messageId: active.currentMessageId ?? active.lastAssistantMessageId }
        : {}),
      severity: 'error',
      certainty: 'definitive',
      phase: 'recovery',
      recovery: { restart: true },
    }));
    if (abortRequestId) {
      const semanticMessageId = active?.semanticStarted === true
        ? active.liveTurnAccumulator?.checkpoint().turn.canonicalMessageId
        : undefined;
      const messageId = active?.lastAssistantMessageId ?? semanticMessageId;
      if (!messageId && active) active.terminalWithoutMessageEmitted = true;
      deps.emit('message.aborted', {
        requestId: abortRequestId,
        ...(active?.operationId ? { operationId: active.operationId } : {}),
        ...(active?.operationAttempt !== undefined ? { operationAttempt: active.operationAttempt } : {}),
        sessionPath: params.sessionPath,
        messageId,
        ...(!messageId ? { outcome: 'cancelled' as const } : {}),
        userInitiated: true,
      } satisfies MessageAbortedPayload);
    }
    deps.emitBusyChanged(context, hasBillableSessionActivity(context));
    const createReplacement = async () => {
      const replacement = await deps.createSessionContext(
        deps.sdk.SessionManager.open(params.sessionPath),
        'resume',
      );
      await Promise.allSettled([
        (deps.buildTransitionSessionOpenedPayload?.(replacement.sessionPath)
          ?? deps.buildSessionOpenedPayload(replacement.sessionPath))
          .then((payload) => deps.emit('session.opened', payload)),
        deps.emitSessionListChanged(),
      ]);
      return replacement;
    };
    context.recoveryPromise = deps.transitionSessionContext
      ? deps.transitionSessionContext(params.sessionPath, createReplacement)
      : createReplacement();
    void context.recoveryPromise.catch((error) => {
      deps.emit('operational-error', createOperationalIncident({
        incidentId: `interrupt-recovery:${abortRequestId ?? request.id}`,
        dedupeKey: `interrupt-recovery:${params.sessionPath}:${abortRequestId ?? request.id}`,
        code: 'SESSION_RUNTIME_RECOVERY_FAILED',
        message: `Could not replace the stalled session runtime: ${toErrorMessage(error)}`,
        detail: `The replacement runtime failed after the interrupt-abort watchdog retired the previous runtime: ${toErrorMessage(error)}`,
        sessionPath: params.sessionPath,
        ...(abortRequestId ? { requestId: abortRequestId } : {}),
        ...(active?.operationId ? { operationId: active.operationId } : {}),
        ...(active?.liveTurnAccumulator ? { turnId: active.liveTurnAccumulator.turnId } : {}),
        ...(active?.currentMessageId ?? active?.lastAssistantMessageId
          ? { messageId: active.currentMessageId ?? active.lastAssistantMessageId }
          : {}),
        severity: 'error',
        certainty: 'definitive',
        phase: 'recovery',
        recovery: { restart: true },
      }));
    });
    return { interrupted: true, settled: false, teardownTimedOut: true };
  }

  if (typeof outcome === 'object') {
    throw new BackendError('MESSAGE_INTERRUPT_FAILED', outcome.error);
  }

  reconcileOwnedIdleRequest();
  return { interrupted: true, settled: true };
}

async function handleMessageReplaceQueue(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateMessageReplaceQueue(request.params);
  markRequestValidated(deps);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) {
    throw new BackendError('SESSION_NOT_FOUND', `Cannot edit the queue for an unopened session: ${params.sessionPath}`);
  }
  if (!context.activeRequest && !context.session.isStreaming) {
    throw new BackendError('QUEUE_NOT_RUNNING', 'The queued message is already being delivered and can no longer be edited.');
  }

  // Delivery removes its localId synchronously at the SDK user-message
  // boundary, before the host necessarily receives queuedDelivered. Refuse a
  // replacement based on a stale host snapshot: otherwise the already-started
  // original stays in flight while this handler re-enqueues its edited copy,
  // producing both messages and two answers.
  const authoritativeLocalIds = context.queuedLocalIds ?? [];
  const expectedLocalIds = params.fallbackMessages.map((message) => message.localId);
  if (authoritativeLocalIds.length !== expectedLocalIds.length
    || authoritativeLocalIds.some((localId, index) => localId !== expectedLocalIds[index])) {
    throw new BackendError(
      'QUEUE_CHANGED',
      'QUEUE_CHANGED: A queued message has already started and the edit was not applied.',
    );
  }

  const enqueueAll = async (messages: typeof params.messages): Promise<void> => {
    // Register every correlation first, then invoke every SDK enqueue without
    // yielding. Current SDK steer/followUp implementations mutate their queues
    // synchronously before returning a resolved promise, so clear + complete
    // replacement occurs in one JavaScript turn and cannot expose a transient
    // empty/partial queue to the agent loop.
    context.queuedLocalIds = messages.map((message) => message.localId);
    const enqueues: Promise<void>[] = [];
    for (const message of messages) {
      const promptText = buildPromptText(message.text, message.inputs);
      const images = lowerImageInputs(message.inputs);
      const imagePayload = images.length > 0 ? images : undefined;
      enqueues.push(context.session.steer
        ? context.session.steer(promptText, imagePayload)
        : context.session.followUp(promptText, imagePayload));
    }
    await Promise.all(enqueues);
  };

  context.session.clearQueue();
  try {
    await enqueueAll(params.messages);
  } catch (replaceError) {
    // Queue replacement is all-or-nothing from the host's perspective. Restore
    // the original ordered queue before returning the edit failure.
    context.session.clearQueue();
    try {
      await enqueueAll(params.fallbackMessages);
    } catch (restoreError) {
      context.session.clearQueue();
      context.queuedLocalIds = [];
      context.queuedOperationIds = [];
      context.queuedOperationAttempts = [];
      return {
        updated: false,
        queueCleared: true,
        error: `Could not update or restore the queued messages: ${toErrorMessage(replaceError)}; restore failed: ${toErrorMessage(restoreError)}`,
      };
    }
    throw replaceError;
  }
  return { updated: true, count: params.messages.length };
}

function emitQueuedSendCancellations(
  deps: BackendRequestHandlerDeps,
  context: SessionContext,
  reason: string,
): void {
  for (const [index, operationId] of (context.queuedOperationIds ?? []).entries()) {
    if (!operationId) continue;
    context.sendOperationLedger?.markFailed(operationId, 'MESSAGE_SEND_QUEUE_CLEARED', reason, 'cancelled');
    deps.emit('message.aborted', {
      requestId: `queued:${operationId}`,
      operationId,
      ...(context.queuedOperationAttempts?.[index] !== undefined
        ? { operationAttempt: context.queuedOperationAttempts[index] } : {}),
      sessionPath: context.sessionPath,
      ...(context.queuedLocalIds?.[index] ? { localId: context.queuedLocalIds[index] } : {}),
      outcome: 'cancelled',
      userInitiated: true,
      reason,
    } satisfies MessageAbortedPayload);
  }
}

async function handleMessageClearQueue(
  deps: BackendRequestHandlerDeps,
  request: RequestEnvelope,
): Promise<unknown> {
  const params = validateSessionPath('message.clearQueue', request.params);
  markRequestValidated(deps);
  const context = deps.getSessionContext(params.sessionPath);
  if (!context) {
    throw new BackendError('SESSION_NOT_FOUND', `Cannot clear queue for an unopened session: ${params.sessionPath}`);
  }
  // Clear all queued steering + follow-up messages. The host removes its
  // optimistic 'queued' transcript messages on the result; this is the
  // authoritative backend clear so the SDK will not drain them later.
  const cleared = context.session.clearQueue();
  // Emit one operation terminal independently of the correlated clear
  // acknowledgement, which may be delayed or dropped after the queue changed.
  emitQueuedSendCancellations(deps, context, 'The queued message was cleared before delivery.');
  // drop the localId correlation queue so a late user-role
  // message_start cannot carry a stale localId back to the host.
  context.queuedLocalIds = [];
  context.queuedOperationIds = [];
  context.queuedOperationAttempts = [];
  return { cleared };
}

/** Host → coordinator publication of the complete open/pinned/running tab
 * registry. Production retains it in a monotonic worker-sync domain; the
 * worker-local compatibility environment is refreshed before acknowledgement. */

export const MESSAGE_REQUEST_HANDLERS: Readonly<Record<string, RequestHandler>> = {
  'message.send': handleMessageSend,
  'operation.status': handleOperationStatus,
  'message.continue': handleMessageContinue,
  'message.compact': handleMessageCompact,
  'message.interrupt': handleMessageInterrupt,
  'message.clearQueue': handleMessageClearQueue,
  'message.replaceQueue': handleMessageReplaceQueue,
};
