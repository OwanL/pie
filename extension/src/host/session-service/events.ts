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
import { onMessageDelta, onMessageThinking, onMessageStarted, onMessageFinished, onMessageAborted, onPreflightFailed } from './handlers/streaming.js';
import { onToolStarted, onToolFinished, onToolProgress } from './handlers/tools.js';
import { onSessionListChanged, onCustomMessage, onExtensionUIRequest, onError, onContextUsageChanged } from './handlers/session.js';
import { applySessionOpenedPayload, handleBusyChangedPayload, attach as attachHandlers, detach as detachHandlers } from './handlers/attach.js';
import { auditLog } from '../util/audit.js';

interface SessionServiceEventsOptions {
  context: vscode.ExtensionContext;
  scheduleRender: ScheduleRender;
  onSessionCompleted?: OnSessionCompleted;
  runObserver: RunObserver;
  state: SessionServiceState;
  dispatchArch: (event: Event) => void;
  getArchState: () => ArchState;
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

  constructor(options: SessionServiceEventsOptions) {
    this.context = options.context;
    this.scheduleRender = options.scheduleRender;
    this.onSessionCompleted = options.onSessionCompleted;
    this.runObserver = options.runObserver;
    this.dispatchArch = options.dispatchArch;
    this.state = options.state;
    this.getArchState = options.getArchState;
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
      onSessionOpened: (payload) => this.applySessionOpened(payload),
      onSessionListChanged: (payload) => onSessionListChanged(payload, deps),
      onMessageStarted: (payload) => onMessageStarted(payload, deps),
      onMessageDelta: (payload) => onMessageDelta(payload, deps),
      onMessageThinking: (payload) => onMessageThinking(payload, deps),
      onToolStarted: (payload) => onToolStarted(payload, deps),
      onToolFinished: (payload) => onToolFinished(payload, deps),
      onToolProgress: (payload) => onToolProgress(payload, deps),
      onMessageFinished: (payload) => onMessageFinished(payload, deps),
      onCustomMessage: (payload) => onCustomMessage(payload, deps),
      onMessageAborted: (payload) => onMessageAborted(payload, deps),
      onPreflightFailed: (payload) => onPreflightFailed(payload, deps),
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
