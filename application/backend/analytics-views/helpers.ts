import type { ActiveRunSummary } from '../../lib/protocol/index.js';
import {
  type PersistedSessionRunState,
  type RunSnapshot,
  type TaskBoundaryIntent,
} from '../../../analytics/legacy/run-analytics/types.js';
export { appendUnique, summarizeInputs, workspaceHash } from '../../../analytics/legacy/stats-service/helpers.js';

export function defaultNow(): Date {
  return new Date();
}

export function defaultCreateId(): string {
  return crypto.randomUUID();
}

export function toActiveRunSummary(
  run: RunSnapshot | null,
  nextSendStartsNewTask = false,
): ActiveRunSummary | null {
  if (!run) {
    return null;
  }

  return nextSendStartsNewTask
    ? {
        runId: run.runId,
        status: run.status,
        nextSendStartsNewTask: true,
      }
    : {
        runId: run.runId,
        status: run.status,
      };
}

interface PersistableSessionState {
  currentRun: RunSnapshot | null;
  lastRun: RunSnapshot | null;
  nextTaskIntent: TaskBoundaryIntent;
  queuedUnsupportedInputCount: number;
  busyStartedAt: string | null;
}

export function toPersistedSessionState(state: PersistableSessionState): PersistedSessionRunState {
  return {
    currentRun: state.currentRun,
    lastRun: state.lastRun,
    nextTaskIntent: state.nextTaskIntent,
    queuedUnsupportedInputCount: state.queuedUnsupportedInputCount,
    busyStartedAt: state.busyStartedAt,
  };
}

export function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const lhs = left ?? [];
  const rhs = right ?? [];
  if (lhs.length !== rhs.length) {
    return false;
  }

  return lhs.every((value, index) => value === rhs[index]);
}
