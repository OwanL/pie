import * as vscode from 'vscode';

import { BackendClient } from '../backend/client';
import type { RunObserver } from '../stats-service';
import type {
  BusyChangedPayload,
  EventEnvelope,
  SessionOpenedPayload,
} from '../../shared/protocol';
import { dispatchSessionBackendEvent } from '../core/event-dispatch';
import type { OnSessionCompleted, ScheduleRender } from './types';
import type { Event } from '../core/events';
import type { ArchState } from '../core/arch-state';
import type { CoordinatorToHostDetailMessage } from '../../shared/protocol/subagent-detail';
import { SessionServiceState } from './state';
import type { DeferredTriggerRegistry } from '../deferred-triggers/registry';
import { onMessageDelta, onMessageThinking, onMessageToolCallDelta, onMessageStarted, onMessageFinished, onMessageAborted, onPreflightFailed, onQueuedDelivered, onRetryStarted, onRetryEnded, onRetryMeasured, onRetryStuck, onCompaction, onCompactionStarted, onAuxiliaryLlmUsage, reconcileServingModelConfig } from './handlers/streaming.js';
import { onToolStarted, onToolFinished, onToolProgress } from './handlers/tools.js';
import { onSessionListChanged, onCustomMessage, onExtensionUIRequest, onError, onOperationalError, onContextUsageChanged } from './handlers/session.js';
import { applySessionOpenedPayload, handleBusyChangedPayload, attach as attachHandlers, detach as detachHandlers } from './handlers/attach.js';
import { auditLog } from '../util/audit.js';
import { isLivePipelineTraceEnabled, recordLivePipelineTrace } from '../util/live-pipeline-trace-runtime.js';

interface SessionServiceEventsOptions {
  context: vscode.ExtensionContext;
  scheduleRender: ScheduleRender;
  onSessionCompleted?: OnSessionCompleted;
  runObserver: RunObserver;
  state: SessionServiceState;
  dispatchArch: (event: Event) => void;
  getArchState: () => ArchState;
  triggers: DeferredTriggerRegistry;
  /** Routes one of the six coordinator→host detail stream variants
   *  to the host's detail subscription service. */
  onDetailStream?: (message: CoordinatorToHostDetailMessage) => void;
}

export class SessionServiceEvents {
  private readonly context: vscode.ExtensionContext;
  private readonly scheduleRender: ScheduleRender;
  private readonly onSessionCompleted?: OnSessionCompleted;
  private readonly runObserver: RunObserver;
  private readonly state: SessionServiceState;
  private eventDisposable?: vscode.Disposable;
  private exitDisposable?: vscode.Disposable;
  private readonly dispatchArch: (event: Event) => void;
  private readonly getArchState: () => ArchState;
  private readonly triggers: DeferredTriggerRegistry;
  private readonly onDetailStream?: (message: CoordinatorToHostDetailMessage) => void;

  constructor(options: SessionServiceEventsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.onSessionCompleted = options.onSessionCompleted;
    this.runObserver = options.runObserver;
    this.dispatchArch = options.dispatchArch;
    this.state = options.state;
    this.getArchState = options.getArchState;
    this.triggers = options.triggers;
    this.onDetailStream = options.onDetailStream;
  }

  attach(backend: BackendClient): void {
    const [eventDisposable, exitDisposable] = attachHandlers(
      backend,
      {
        context: this.context,
        scheduleRender: this.scheduleRender,
        runObserver: this.runObserver,
        state: this.state,
        getArchState: this.getArchState,
        dispatchArch: this.dispatchArch,
        onSessionCompleted: this.onSessionCompleted,
      },
      {
        handleBackendEvent: (event: EventEnvelope) => this.handleBackendEvent(event),
      },
    );
    this.eventDisposable = eventDisposable;
    this.exitDisposable = exitDisposable;
  }

  detach(): void {
    const disposables: vscode.Disposable[] = [];
    if (this.eventDisposable) disposables.push(this.eventDisposable);
    if (this.exitDisposable) disposables.push(this.exitDisposable);
    detachHandlers(disposables);
    this.eventDisposable = undefined;
    this.exitDisposable = undefined;
  }

  applySessionOpened(payload: SessionOpenedPayload): void {
    applySessionOpenedPayload(
      payload,
      {
        getArchState: this.getArchState,
        dispatchArch: this.dispatchArch,
        runObserver: this.runObserver,
        scheduleRender: this.scheduleRender,
        context: this.context,
        state: this.state,
      },
    );
  }

  handleBackendEvent(event: EventEnvelope): void {
    const deps = this.getHandlerDeps();
    dispatchSessionBackendEvent(event, {
      onTurnSemantic: (envelope) => {
        const before = this.getArchState().livePipeline.turnsBySession[envelope.sessionPath];
        if (before && before.turnId === envelope.turnId && before.attemptId === envelope.attemptId
          && envelope.seq > before.seq + 1 && isLivePipelineTraceEnabled()) {
          recordLivePipelineTrace({
            process: 'host', stage: 'host.sequence.gap', kind: 'failure',
            identifiers: { session: envelope.sessionPath, request: envelope.requestId, turn: envelope.turnId, attempt: envelope.attemptId },
            eventKind: envelope.kind === 'tool.progress' ? 'tool_progress' : 'control',
            eventSeq: envelope.seq, reasonCode: 'sequence_gap',
          });
        }
        this.dispatchArch({ kind: 'TurnSemanticEventReceived', envelope });
        if (envelope.kind === 'turn.started') {
          const acceptedTurn = this.getArchState().livePipeline.turnsBySession[envelope.sessionPath];
          if (acceptedTurn?.turnId === envelope.turnId && acceptedTurn.attemptId === envelope.attemptId) {
            this.state.bindRequestSessionPath(envelope.requestId, envelope.sessionPath);
            // Mirror the legacy message.started behavior only after the reducer
            // accepted this owner. A conflicting or tombstoned start must not
            // overwrite the composer's model badge or analytics identity.
            reconcileServingModelConfig(
              envelope.sessionPath,
              envelope.modelId,
              envelope.thinkingLevel,
              envelope.provider,
              deps,
            );
            this.runObserver.onAssistantTurnStarted(envelope.sessionPath, envelope.canonicalMessageId);
            this.state.touchSessionTranscript(envelope.sessionPath);
          }
        } else if (envelope.kind === 'tool.started') {
          onToolStarted({
            requestId: envelope.requestId,
            sessionPath: envelope.sessionPath,
            messageId: this.getArchState().livePipeline.turnsBySession[envelope.sessionPath]?.canonicalMessageId ?? '',
            toolCallId: envelope.toolCallId,
            name: envelope.name,
            input: envelope.input,
            startedAt: envelope.startedAt,
            parallelGroupId: envelope.parallelGroupId,
          }, deps, { skipTranscriptMutation: true });
        } else if (envelope.kind === 'turn.terminal') {
          onMessageFinished({
            requestId: envelope.requestId,
            sessionPath: envelope.sessionPath,
            message: { ...envelope.durableMessage },
          }, deps, { skipTranscriptMutation: true });
          if (envelope.terminalKind === 'interrupted') {
            onMessageAborted({
              requestId: envelope.requestId,
              sessionPath: envelope.sessionPath,
              messageId: envelope.durableMessage.id,
              userInitiated: envelope.userInitiated,
              reason: envelope.reason,
            }, deps, { skipTranscriptMutation: true, skipObserver: true });
          }
        }
        this.scheduleRender();
      },
      onLiveLifecycle: (watermark) => {
        this.dispatchArch({ kind: 'LiveLifecycleWatermarkReceived', watermark });
        this.scheduleRender();
      },
      onSessionOpened: (payload) => this.applySessionOpened(payload),
      onSessionListChanged: (payload) => onSessionListChanged(payload, deps),
      onMessageStarted: (payload) => onMessageStarted(payload, deps),
      onMessageDelta: (payload) => onMessageDelta(payload, deps),
      onMessageThinking: (payload) => onMessageThinking(payload, deps),
      onMessageToolCallDelta: (payload) => onMessageToolCallDelta(payload, deps),
      onToolStarted: (payload) => onToolStarted(payload, deps),
      onToolFinished: (payload) => onToolFinished(
        payload,
        deps,
        { skipTranscriptMutation: payload.canonicalLive === true },
      ),
      onToolProgress: (payload) => onToolProgress(payload, deps),
      onMessageFinished: (payload) => onMessageFinished(payload, deps),
      onCustomMessage: (payload) => onCustomMessage(payload, deps),
      onMessageAborted: (payload) => onMessageAborted(payload, deps),
      onPreflightFailed: (payload) => onPreflightFailed(payload, deps),
      onQueuedDelivered: (payload) => onQueuedDelivered(payload, deps),
      onRetryStarted: (payload) => onRetryStarted(payload, deps),
      onRetryEnded: (payload) => onRetryEnded(payload, deps),
      onRetryMeasured: (payload) => onRetryMeasured(payload, deps),
      onCompaction: (payload) => onCompaction(payload, deps),
      onCompactionStarted: (payload) => onCompactionStarted(payload, deps),
      onAuxiliaryLlmUsage: (payload) => onAuxiliaryLlmUsage(payload, deps),
      onOperationalError: (payload) => onOperationalError(payload, deps),
      onRetryStuck: (payload) => onRetryStuck(payload, deps),
      onAgentSettled: (payload) => {
        const sessionPath = this.requireEventSessionPath('agent.settled', payload.sessionPath);
        if (!sessionPath) return;
        this.dispatchArch({
          kind: 'AgentSettled',
          ...payload,
          sessionPath,
          currentBackendGeneration: this.state.getBackendGeneration(),
        });
        this.scheduleRender();
      },
      onBusyChanged: (payload) => this.onBusyChanged(payload),
      onContextUsageChanged: (payload) => onContextUsageChanged(payload, deps),
      onExtensionUIRequest: (payload) => onExtensionUIRequest(payload, deps),
      onError: (payload) => onError(payload, deps),
      onDetailStream: (message) => this.onDetailStream?.(message),
    });
    // Some backend failure/terminal paths reconcile the host running marker
    // without emitting a separate busy=false event. Re-check after every
    // backend event; the pump itself remains guarded by authoritative state.
    this.state.resumePreloads();
  }

  private onBusyChanged(payload: BusyChangedPayload): void {
    const sessionPath = this.requireEventSessionPath('busy.changed', payload.sessionPath);
    if (!sessionPath) {
      return;
    }

    handleBusyChangedPayload(
      payload,
      sessionPath,
      {
        getArchState: this.getArchState,
        dispatchArch: this.dispatchArch,
        runObserver: this.runObserver,
        scheduleRender: this.scheduleRender,
        context: this.context,
        onSessionCompleted: this.onSessionCompleted,
        state: this.state,
        triggers: this.triggers,
      },
    );
  }

  private requireEventSessionPath(eventName: string, sessionPath: string | undefined): string | null {
    if (sessionPath) {
      return sessionPath;
    }

    auditLog('session-service', 'protocol.defect', {
      eventName,
      reason: 'missing sessionPath',
    });
    this.dispatchArch({
      kind: 'Error',
      sessionPath: '',
      error: `Protocol defect: ${eventName} arrived without a sessionPath.`,
    });
    this.scheduleRender();
    return null;
  }

  private getHandlerDeps() {
    return {
      context: this.context,
      getArchState: this.getArchState,
      dispatchArch: this.dispatchArch,
      runObserver: this.runObserver,
      state: this.state,
      scheduleRender: this.scheduleRender,
      onSessionCompleted: this.onSessionCompleted,
      requireEventSessionPath: (eventName: string, sessionPath: string | undefined) => this.requireEventSessionPath(eventName, sessionPath),
    };
  }
}
