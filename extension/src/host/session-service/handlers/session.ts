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
  SessionSummary,
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

  // Record agent-review analytics for fresh done transitions BEFORE closing the
  // tab. `closures` already encodes the fresh-done-transition + open-tab +
  // non-running filters (computeReviewAutoCloseClosures), so this is the
  // minimal place to join a review to its run. Recording before the
  // CloseSession dispatch avoids depending on microtask ordering: the runId
  // resolves from currentRun ?? lastRun, which is definitely present now.
  const summaryByPath = new Map<string, SessionSummary>(
    payload.sessions.map((summary) => [summary.path, summary]),
  );
  for (const sessionPath of closures) {
    const summary = summaryByPath.get(sessionPath);
    if (!summary || summary.done !== true) {
      continue;
    }
    deps.runObserver.recordAgentReview(sessionPath, {
      done: true,
      rating: summary.rating ?? 0,
      completion: summary.completion ?? 'partial',
      reason: summary.reviewReason ?? '',
      evaluatedAt: summary.evaluatedAt ?? new Date().toISOString(),
      reviewerBuckets: summary.reviewerBuckets ?? [],
      reviewerCount: summary.reviewerCount ?? 0,
    });
  }

  // Auto-close tabs for sessions the agent just reviewed as `done: true` —
  // the same `CloseSession` command a user-initiated tab close dispatches
  // (handles pinned tabs too: `evictSession` drops them from
  // `pinnedTabPaths`). Only fresh done transitions close; the first list
  // seeds the known-done set so pre-existing done tabs aren't mass-closed.
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
 * Hook-only extensions (or tool overrides like warm-bash that shadow a core
 * tool id) are listed by name since they don't expose a detectable tool id but
 * still participate in every session; see HOOK_ONLY_EXTENSION_IDS below.
 */
const KNOWN_EXTENSIONS: ExtensionInfo[] = [
  { id: 'subagent', label: 'Subagent', description: 'Delegate tasks to specialized sub-agents' },
  { id: 'safeguard', label: 'Safeguard', description: 'Block dangerous shell commands and file writes' },
  { id: 'cwd-skills', label: 'CWD Skills', description: 'Auto-discover skills from the working directory' },
  { id: 'skill-pruner', label: 'Skill Pruner', description: 'Score and prune skill descriptions by relevance' },
  { id: 'tool-result-pruner', label: 'Tool-result Pruner', description: 'Prune tool output bytes before they enter the model context' },
  { id: 'ask-user', label: 'Ask User', description: 'Ask the user a clarifying question with preset answers' },
  { id: 'deferred-triggers', label: 'Deferred Triggers', description: 'Defer a task and auto-resume the session when a trigger fires' },
  { id: 'session-reviewer', label: 'Session Reviewer', description: 'List, read, and review the currently-open session transcripts' },
  { id: 'session-changes', label: 'Session Changes', description: 'Inspect the files a session changed (manifest + diffs)' },
  { id: 'warm-bash', label: 'Warm Bash', description: 'Speed up the bash tool with a pre-warmed shell pool' },
];

const TOOL_TO_EXTENSION: Record<string, string> = {
  subagent: 'subagent',
  ask_user: 'ask-user',
  defer_trigger: 'deferred-triggers',
  session_review: 'session-reviewer',
  session_changes: 'session-changes',
};

// Hook-only extensions (or tool overrides like warm-bash that shadow a core
// tool id) can't be detected from the selected-tool list, so they're treated as
// active whenever the extension is loaded. The backend doesn't expose hook
// registration, so we include them by convention.
const HOOK_ONLY_EXTENSION_IDS = new Set([
  'safeguard',
  'cwd-skills',
  'skill-pruner',
  'tool-result-pruner',
  'warm-bash',
]);

/** Derive available extensions from selected tool IDs + known hook-only extensions. */
export function deriveAvailableExtensions(selectedToolIds: string[]): ExtensionInfo[] {
  const activeExtensionIds = new Set<string>(HOOK_ONLY_EXTENSION_IDS);
  for (const toolId of selectedToolIds) {
    const extId = TOOL_TO_EXTENSION[toolId];
    if (extId) {
      activeExtensionIds.add(extId);
    }
  }

  return KNOWN_EXTENSIONS.filter((ext) => activeExtensionIds.has(ext.id));
}
