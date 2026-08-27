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
    // Notify is fire-and-forget; use the notice banner instead of blocking the prompt slot.
    const prefix = payload.notifyType === 'error' ? 'Error' : payload.notifyType === 'warning' ? 'Warning' : 'Info';
    deps.dispatchArch({ kind: 'Error', sessionPath: payload.sessionPath || '', error: `${prefix}: ${payload.message}` });
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
  // STATE_CONTRACT: errors must be addressed by the requestId binding alone.
  // We must NOT fall back to the active session, because the failing operation
  // may belong to a backgrounded tab; stamping the error on whatever is active
  // pollutes the wrong transcript and confuses the user.
  const sessionPath = deps.state.resolveRequestSessionPath(payload.requestId);
  if (!deps.state.claimOperationalIncident(undefined, payload.requestId)) {
    return;
  }
  deps.runObserver.onBackendError(sessionPath ?? undefined, payload.code);
  deps.dispatchArch({ kind: 'Error', sessionPath: sessionPath ?? '', error: payload.message });
  if (sessionPath) {
    deps.dispatchArch({ kind: 'AssistantMessageErrorStamped', sessionPath, errorMessage: payload.message });
  } else {
    auditLog('session-service', 'protocol.defect', {
      eventName: 'error',
      reason: 'missing or unresolved requestId',
      code: payload.code ?? null,
    });
  }
  deps.scheduleRender();
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
  if (!deps.state.claimOperationalIncident(payload.incidentId, payload.requestId)) {
    return;
  }
  const detail = formatOperationalErrorDetail(payload);
  deps.runObserver.onBackendError(sessionPath, payload.code);
  deps.dispatchArch({ kind: 'Error', sessionPath, error: payload.message, detail });
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
