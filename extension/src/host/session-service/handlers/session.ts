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
  ExtensionInfo,
  ExtensionUIRequestPayload,
  SessionListChangedPayload,
} from '../../../shared/protocol';
import { requestWindowAttention } from '../../sidebar/completion-notification';
import { auditLog } from '../../util/audit.js';

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
  deps.dispatchArch({ kind: 'SessionListChanged', sessionSummaries: payload.sessions });

  // Auto-close tabs for sessions the agent just reviewed as `done: true` —
  // the same `CloseSession` command a user-initiated tab close dispatches
  // (handles pinned tabs too: `evictSession` drops them from
  // `pinnedTabPaths`). Only fresh done transitions close; the first list
  // seeds the known-done set so pre-existing done tabs aren't mass-closed.
  const archState = deps.getArchState();
  const closures = deps.state.consumeReviewAutoCloseClosures(
    payload.sessions,
    archState.sessions.openTabPaths,
    archState.sessions.runningSessionPaths,
  );
  for (const sessionPath of closures) {
    deps.dispatchArch({
      kind: 'Command',
      cmd: {
        kind: 'CloseSession',
        corrId: `review-auto-close:${++reviewAutoCloseCorrIdCounter}`,
        sessionPath,
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

/**
 * Known pi extensions and the tool IDs they register.
 * Hook-only extensions (safeguard) are listed by name since they
 * don't register tools but still participate in every session.
 */
const KNOWN_EXTENSIONS: ExtensionInfo[] = [
  { id: 'subagent', label: 'Subagent', description: 'Delegate tasks to specialized sub-agents' },
  { id: 'safeguard', label: 'Safeguard', description: 'Block dangerous shell commands and file writes' },
  { id: 'cwd-skills', label: 'CWD Skills', description: 'Auto-discover skills from the working directory' },
  { id: 'skill-pruner', label: 'Skill Pruner', description: 'Score and prune skill descriptions by relevance' },
];

const TOOL_TO_EXTENSION: Record<string, string> = {
  subagent: 'subagent',
};

/** Derive available extensions from selected tool IDs + known hook-only extensions. */
export function deriveAvailableExtensions(selectedToolIds: string[]): ExtensionInfo[] {
  const activeExtensionIds = new Set<string>();
  for (const toolId of selectedToolIds) {
    const extId = TOOL_TO_EXTENSION[toolId];
    if (extId) {
      activeExtensionIds.add(extId);
    }
  }
  // Always include known hook-only extensions (they're active if the extension is loaded).
  // The backend doesn't expose hook registration, so we include them by convention.
  activeExtensionIds.add('safeguard');
  activeExtensionIds.add('cwd-skills');
  activeExtensionIds.add('skill-pruner');

  return KNOWN_EXTENSIONS.filter((ext) => activeExtensionIds.has(ext.id));
}
