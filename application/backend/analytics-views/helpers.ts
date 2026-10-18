import type { ActiveRunSummary } from '../../lib/protocol/index.js';
import {
  type RunSnapshot,
} from '../../../analytics/legacy/run-analytics/types.js';
export { appendUnique, summarizeInputs } from '../../../analytics/legacy/stats-service/helpers.js';

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

export function areStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const lhs = left ?? [];
  const rhs = right ?? [];
  if (lhs.length !== rhs.length) {
    return false;
  }

  return lhs.every((value, index) => value === rhs[index]);
}
