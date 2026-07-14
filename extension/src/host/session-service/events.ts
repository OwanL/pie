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
import { SessionServiceState } from './state';
import type { DeferredTriggerRegistry } from '../deferred-triggers/registry';
import { onMessageDelta, onMessageThinking, onMessageToolCallDelta, onMessageStarted, onMessageFinished, onMessageAborted, onPreflightFailed, onQueuedDelivered, onRetryStarted, onRetryEnded, onRetryStuck, onCompaction } from './handlers/streaming.js';
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

  constructor(options: SessionServiceEventsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.onSessionCompleted = options.onSessionCompleted;
    this.runObserver = options.runObserver;
    this.dispatchArch = options.dispatchArch;
    this.state = options.state;
    this.getArchState = options.getArchState;
    this.triggers = options.triggers;
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
          this.state.bindRequestSessionPath(envelope.requestId, envelope.sessionPath);
          this.runObserver.onAssistantTurnStarted(envelope.sessionPath, envelope.canonicalMessageId);
          this.state.touchSessionTranscript(envelope.sessionPath);
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
      onCompaction: (payload) => onCompaction(payload, deps),
      onOperationalError: (payload) => onOperationalError(payload, deps),
      onRetryStuck: (payload) => onRetryStuck(payload, deps),
      onBusyChanged: (payload) => this.onBusyChanged(payload),
      onContextUsageChanged: (payload) => onContextUsageChanged(payload, deps),
      onExtensionUIRequest: (payload) => onExtensionUIRequest(payload, deps),
      onError: (payload) => onError(payload, deps),
    });
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
      },
    );

    // A session finishing streaming fires any `session_finished` deferred
    // triggers watching it. `busy=false` covers both normal completion AND
    // interrupts (Stop) — an interrupted session is no longer running, so it
    // counts as "finished". The registry excludes the watcher's own session
    // so a deferring turn's completion never self-wakes.
    if (!payload.busy) {
      this.triggers.onSessionFinished(sessionPath);
    }
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
