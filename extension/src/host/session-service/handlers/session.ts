import * as vscode from 'vscode';
import type { RunObserver } from '../../stats-service';
import type { ArchState } from '../../core/arch-state';
import type { SessionServiceState } from '../state';
import type { Event } from '../../core/events';
import type { OnSessionCompleted } from '../types';
import type {
  ContextUsageChangedPayload,
  CustomMessagePayload,
  ErrorPayload,
  ExtensionUIRequestPayload,
  OperationalErrorPayload,
  SessionListChangedPayload,
} from '../../../shared/protocol';
import { requestWindowAttention } from '../../sidebar/completion-notification';
import { auditLog } from '../../util/audit.js';
import { formatOperationalErrorDetail } from '../../../shared/operational-error-detail';
import { createOperationalIncident, type OperationalIncident } from '../../../shared/incidents.js';

interface HandlerDeps {
  context: vscode.ExtensionContext;
  getArchState: () => ArchState;
  dispatchArch: (event: Event) => void;
  runObserver: RunObserver;
  state: SessionServiceState;
  scheduleRender: () => void;
  onSessionCompleted?: OnSessionCompleted;
  requireEventSessionPath: (eventName: string, sessionPath: string | undefined) => string | null;
}

let reviewAutoCloseCorrIdCounter = 0;

export function onSessionListChanged(payload: SessionListChangedPayload, deps: HandlerDeps): void {
  deps.dispatchArch({
    kind: 'SessionListChanged',
    sessionSummaries: payload.sessions,
    sessionCatalogProgress: payload.sessionCatalogProgress,
  });

  // Review persistence is not a lifecycle command. Drain only explicit V2
  // closeReviewed/closeSelf outbox actions through the normal CQRS close path.
  // The state observer terminalizes each action only after its correlated
  // cleanup (when applicable) and PersistTabs results both report success.
  const archState = deps.getArchState();
  const closeResult = deps.state.consumeReviewAutoCloseClosures(
    payload.sessions,
    archState.sessions.openTabPaths,
    archState.sessions.runningSessionPaths,
  );
  for (const attempt of closeResult.attempts) {
    const corrId = `review-close-action:${++reviewAutoCloseCorrIdCounter}`;
    deps.state.beginReviewClosureAttempt(corrId, attempt);
    deps.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'CloseSession',
        corrId,
        sessionPath: attempt.sessionPath,
        ensureClosed: true,
        reviewClosure: true,
      },
    });
  }

  deps.scheduleRender();
}

export function onCustomMessage(payload: CustomMessagePayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('message.custom', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'CustomMessage',
    sessionPath,
    ...(payload.operationId ? { operationId: payload.operationId } : {}),
    message: payload.message,
  });
  if (payload.message.customType === 'pruning-result') {
    deps.runObserver.onSkillPruningUsage(
      sessionPath,
      payload.message.id,
      payload.message.createdAt,
      payload.message.customDetails,
    );
  }
  deps.scheduleRender();
  deps.state.touchSessionTranscript(sessionPath);
}

export function onExtensionUIRequest(payload: ExtensionUIRequestPayload, deps: HandlerDeps): void {
  if (payload.method === 'notify') {
    const severity = payload.notifyType ?? 'info';
    const prefix = severity === 'error' ? 'Error' : severity === 'warning' ? 'Warning' : 'Info';
    const incident = createOperationalIncident({
      incidentId: `extension-notify:${payload.id}`,
      dedupeKey: `extension-notify:${payload.id}`,
      sessionPath: payload.sessionPath,
      requestId: payload.id,
      severity,
      certainty: 'definitive',
      phase: 'extension',
      code: severity === 'error' ? 'EXTENSION_NOTIFICATION_ERROR' : 'EXTENSION_NOTIFICATION',
      message: `${prefix}: ${payload.message}`,
      recovery: { showLogs: severity === 'error' },
    });
    if (!deps.state.claimOperationalIncident(
      incident.incidentId,
      incident.requestId,
      undefined,
      incident.dedupeKey,
    )) return;
    if (severity === 'error') deps.runObserver.onBackendError(payload.sessionPath, incident.code);
    deps.dispatchArch({ kind: 'IncidentReported', incident });
    deps.scheduleRender();
    return;
  }
  deps.dispatchArch({ kind: 'ExtensionUIRequest', sessionPath: payload.sessionPath || '', request: payload });

  // Flash the VS Code window to draw the user's attention to the question.
  requestWindowAttention(
    vscode.env.appName,
    vscode.workspace.name ?? vscode.workspace.workspaceFolders?.[0]?.name,
  );

  deps.scheduleRender();
}

export function onError(payload: ErrorPayload, deps: HandlerDeps): void {
  // Legacy `error` events are normalized immediately. Session ownership comes
  // only from the event or exact request binding, never the active tab.
  const sessionPath = payload.sessionPath ?? deps.state.resolveRequestSessionPath(payload.requestId);
  if (!sessionPath) {
    auditLog('session-service', 'protocol.defect', {
      eventName: 'error',
      reason: 'missing session/request binding',
      code: payload.code ?? null,
      requestId: payload.requestId ?? null,
    });
    return;
  }
  const severity = payload.severity ?? 'error';
  const incident: OperationalIncident = createOperationalIncident({
    incidentId: payload.incidentId,
    dedupeKey: payload.dedupeKey ?? (payload.requestId ? `request:${payload.requestId}` : undefined),
    sessionPath,
    operationId: payload.operationId,
    requestId: payload.requestId,
    turnId: payload.turnId,
    messageId: payload.messageId,
    severity,
    certainty: payload.certainty ?? 'definitive',
    phase: payload.phase ?? 'settlement',
    code: payload.code,
    message: payload.message,
    detail: payload.detail,
    recovery: payload.recovery ?? (severity === 'error' ? { showLogs: true } : { showLogs: false }),
  });
  const firstReport = deps.state.claimOperationalIncident(
    incident.incidentId,
    incident.requestId,
    undefined,
    incident.dedupeKey,
  );
  if (firstReport) {
    if (incident.severity === 'error') deps.runObserver.onBackendError(sessionPath, incident.code);
    deps.dispatchArch({ kind: 'IncidentReported', incident });
  }
  if (incident.severity === 'error' && (incident.messageId || incident.turnId)) {
    deps.dispatchArch({
      kind: 'AssistantMessageErrorStamped',
      sessionPath,
      errorMessage: incident.detail ?? incident.message,
      operationId: incident.operationId,
      requestId: incident.requestId,
      turnId: incident.turnId,
      messageId: incident.messageId,
    });
  }
  if (firstReport || (incident.severity === 'error' && (incident.messageId || incident.turnId))) {
    deps.scheduleRender();
  }
}

/** Operational (non-fatal) backend condition from a watchdog — either the
 *  interrupt-abort watchdog (`session.abort()` did not settle) or the
 *  willRetry watchdog (a retry's backoff did not complete). The watchdogs
 *  already performed their side effects (force-clear `activeRequest` +
 *  `busy=false`); this handler only surfaces the notice so the user is not
 *  left looking at a silently-wedged session.
 *
 *  Routed through the existing `Error` event so the reducer's `handleError`
 *  surfaces a non-blocking `operational-error` notice (recovery action:
 *  show-logs). It does NOT stamp `AssistantMessageErrorStamped` — the turn
 *  may still be running (retry-stuck case: `activeRequest` is still set), so
 *  marking the assistant message errored would be wrong. No rollback, no
 *  abort: purely a notice. STATE_CONTRACT § Notice Surfacing: `handleError`
 *  keeps the short message readable and retains the code, request correlation,
 *  and backend diagnostic as credential-redacted `noticeRaw`. */
export function onOperationalError(payload: OperationalErrorPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('operational-error', payload.sessionPath);
  if (!sessionPath) {
    return;
  }
  if (!deps.state.claimOperationalIncident(
    payload.incidentId,
    payload.requestId,
    undefined,
    payload.dedupeKey,
  )) return;
  const detail = formatOperationalErrorDetail(payload);
  const incident = { ...payload, detail };
  if (incident.severity === 'error') deps.runObserver.onBackendError(sessionPath, incident.code);
  deps.dispatchArch({ kind: 'IncidentReported', incident });
  deps.scheduleRender();
}

export function onContextUsageChanged(payload: ContextUsageChangedPayload, deps: HandlerDeps): void {
  const sessionPath = deps.requireEventSessionPath('contextUsage.changed', payload.sessionPath);
  if (!sessionPath) {
    return;
  }

  deps.dispatchArch({
    kind: 'ContextUsageChanged',
    sessionPath,
    contextUsage: payload.contextUsage ?? null,
  });
  if (payload.contextUsage) {
    deps.runObserver.onContextUsageChanged(
      sessionPath,
      payload.contextUsage.tokens,
      payload.contextUsage.contextWindow,
    );
  }
  deps.scheduleRender();
}
